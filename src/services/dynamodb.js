'use strict';

/**
 * Data access layer — sessions, branches, and messages in DynamoDB.
 *
 * Every read and write of conversation state goes through this file. It owns
 * the branching-history model: a session points at an active branch, and a
 * branch is an ordered list of message IDs (selectedMsgIds). Writes that must
 * not half-apply (save a message + append it to its branch) use a single
 * TransactWrite.
 *
 * getActiveHistoryForBranch also trims history to fit a model's context: it
 * keeps the most recent messages within a message count and an approximate
 * token budget.
 *
 * The client is a module-level singleton reused across warm invocations.
 * Branch forking and message editing (forkBranch, updateMessageState) are
 * exposed here but driven by the separate chatbot-fast-api-lambda REST API.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
  BatchGetCommand,
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
    selectedMsgIds: [],
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

// ─── Branches ────────────────────────────────────────────────────────────────

async function getBranch(branchId) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLES.branchesTable,
    Key: { branchId },
  }));
  if (!res.Item) throw new Error('Branch not found');
  return res.Item;
}

// Fork: the parent branch is preserved intact — only the new branch gets the new selectedMsgIds.
async function forkBranch({ sessionId, parentBranchId, parentMsgId, selectedMsgIds, label }) {
  const branchId = `branch_${uuidv4()}`;
  const now = new Date().toISOString();

  const branch = {
    branchId,
    sessionId,
    parentBranchId,
    parentMsgId,
    selectedMsgIds: selectedMsgIds || [],
    label:          label || `fork-${Date.now()}`,
    createdAt:      now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.branchesTable, Item: branch }));
  return branch;
}

function branchAppendTransactItem(branchId, msgId) {
  return {
    Update: {
      TableName: TABLES.branchesTable,
      Key: { branchId },
      UpdateExpression: 'SET selectedMsgIds = list_append(if_not_exists(selectedMsgIds, :empty), :ids)',
      ExpressionAttributeValues: { ':empty': [], ':ids': [msgId] },
    },
  };
}

async function appendMsgToBranch(branchId, msgId) {
  const { Update } = branchAppendTransactItem(branchId, msgId);
  await ddb.send(new UpdateCommand(Update));
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

  // Save message + append to branch selectedMsgIds atomically
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLES.messagesTable, Item: item } },
      branchAppendTransactItem(branchId, msgId),
    ],
  }));

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

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLES.messagesTable, Item: item } },
      branchAppendTransactItem(branchId, msgId),
    ],
  }));

  return item;
}

async function updateMessageState(msgId, state, editedContent = undefined) {
  const updates = ['#st = :state', 'updatedAt = :now'];
  const names  = { '#st': 'state' };
  const values = { ':state': state, ':now': new Date().toISOString() };

  if (editedContent !== undefined) {
    updates.push('content = :content');
    values[':content'] = editedContent;
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLES.messagesTable,
    Key: { msgId },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function getActiveHistoryForBranch(branchId, maxMessages, maxTokenBudget) {
  const branch = await getBranch(branchId);
  const { selectedMsgIds = [] } = branch;

  if (selectedMsgIds.length === 0) return [];

  // Batch-get all selected messages in chunks of 100 (DynamoDB BatchGet limit)
  const chunks = chunkArray(selectedMsgIds, 100);
  const allItems = [];

  for (const chunk of chunks) {
    const keys = chunk.map(id => ({ msgId: id }));
    const result = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLES.messagesTable]: { Keys: keys },
      },
    }));
    allItems.push(...(result.Responses?.[TABLES.messagesTable] || []));
  }

  // Restore original order (BatchGet doesn't guarantee order)
  const byId = Object.fromEntries(allItems.map(m => [m.msgId, m]));
  const ordered = selectedMsgIds
    .map(id => byId[id])
    .filter(m => m && m.state === MessageState.ACTIVE);

  const capped = ordered.slice(-maxMessages);

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  MessageState,
  getOrCreateSession,
  getBranch,
  forkBranch,
  appendMsgToBranch,
  saveUserMessage,
  saveAssistantMessage,
  updateMessageState,
  getActiveHistoryForBranch,
};
