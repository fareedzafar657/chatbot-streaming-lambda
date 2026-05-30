'use strict';

/**
 * Data access layer — sessions, branches, and messages in DynamoDB.
 *
 * Every read and write done by THIS service goes through this file. Each message
 * row carries a branchId; history is loaded by querying the branchId-createdAt-index
 * GSI, ordered ascending by createdAt. Forking (which duplicates message rows into
 * a new branch) is done by the separate chatbot-fast-api-lambda REST API.
 *
 * getActiveHistoryForBranch trims history to fit a model's context: it keeps the
 * most recent messages within a message count and an approximate token budget.
 *
 * The DynamoDB client is a module-level singleton reused across warm invocations.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const { randomUUID: uuidv4 } = require('crypto');
const config = require('../config');

// ─── Client (singleton, reused across warm invocations) ─────────────────────
const raw = new DynamoDBClient({ region: config.region });
const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLES = config.dynamo;

// ─── Message states ──────────────────────────────────────────────────────────
const MessageState = {
  ACTIVE:    'active',
  STOPPED:   'stopped',
  EDITED:    'edited',
  DELETED:   'deleted',
  COMPACTED: 'compacted',
};

// ─── Sessions ────────────────────────────────────────────────────────────────

async function getOrCreateSession(sessionId, userId) {
  const existing = await ddb.send(new GetCommand({
    TableName: TABLES.sessionsTable,
    Key: { sessionId },
  }));

  if (existing.Item) {
    if (existing.Item.userId !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return existing.Item;
  }

  const trunkBranchId = `branch_${uuidv4()}`;
  const now = new Date().toISOString();

  const session = {
    sessionId,
    userId,
    trunkBranchId,
    activeBranchId: trunkBranchId,
    createdAt: now,
    updatedAt: now,
  };

  const trunkBranch = {
    branchId: trunkBranchId,
    sessionId,
    parentBranchId: null,
    parentMsgId:    null,
    label:          'main',
    createdAt:      now,
  };

  // Create session + trunk branch atomically
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLES.sessionsTable, Item: session } },
      { Put: { TableName: TABLES.branchesTable, Item: trunkBranch } },
    ],
  }));

  return session;
}

// ─── Messages ────────────────────────────────────────────────────────────────

async function saveUserMessage({ sessionId, branchId, content, userId }) {
  const msgId = `msg_${uuidv4()}`;
  const now = new Date().toISOString();

  const item = {
    msgId,
    sessionId,
    branchId,
    role:      'user',
    content,
    state:     MessageState.ACTIVE,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.messagesTable, Item: item }));
  return item;
}

// saveAssistantMessage inherits stopped state from the parent user message if it was stopped mid-flight.
async function saveAssistantMessage({
  sessionId,
  branchId,
  content,
  parentMsgId,
  inputTokens,
  outputTokens,
  modelId,
  userId,
}) {
  const msgId = `msg_${uuidv4()}`;
  const now = new Date().toISOString();

  // Check if the parent question was stopped mid-flight
  let state = MessageState.ACTIVE;
  if (parentMsgId) {
    const parentRes = await ddb.send(new GetCommand({
      TableName: TABLES.messagesTable,
      Key: { msgId: parentMsgId },
    }));
    if (parentRes.Item?.state === MessageState.STOPPED) {
      state = MessageState.STOPPED;
    }
  }

  const item = {
    msgId,
    sessionId,
    branchId,
    role:         'assistant',
    content,
    state,
    parentMsgId,
    userId,
    modelId,
    inputTokens:  inputTokens  || 0,
    outputTokens: outputTokens || 0,
    createdAt:    now,
    updatedAt:    now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.messagesTable, Item: item }));
  return item;
}

async function getActiveHistoryForBranch(branchId, maxMessages, maxTokenBudget) {
  // Query messages ordered by createdAt ascending via branchId-createdAt-index GSI
  const result = await ddb.send(new QueryCommand({
    TableName:                 TABLES.messagesTable,
    IndexName:                 'branchId-createdAt-index',
    KeyConditionExpression:    'branchId = :bid',
    FilterExpression:          '#st = :active',
    ExpressionAttributeNames:  { '#st': 'state' },
    ExpressionAttributeValues: { ':bid': branchId, ':active': MessageState.ACTIVE },
    ScanIndexForward:          true,
  }));

  const all = result.Items ?? [];
  const capped = all.slice(-maxMessages);

  const CHARS_PER_TOKEN_ESTIMATE = 4; // 1 token ≈ 4 chars (varies ±20% by model/language) — used only for history truncation, not billing

  let tokenCount = 0;
  const budgeted = [];
  for (let i = capped.length - 1; i >= 0; i--) {
    const approxTokens = Math.ceil(capped[i].content.length / CHARS_PER_TOKEN_ESTIMATE);
    if (tokenCount + approxTokens > maxTokenBudget) break;
    tokenCount += approxTokens;
    budgeted.unshift(capped[i]);
  }

  return budgeted;
}

module.exports = {
  MessageState,
  getOrCreateSession,
  getBranch,
  saveUserMessage,
  saveAssistantMessage,
  getActiveHistoryForBranch,
};
