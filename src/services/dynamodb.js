'use strict';

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
  ACTIVE:   'active',
  STOPPED:  'stopped',
  EDITED:   'edited',
  DELETED:  'deleted',
};

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * Get or create a session. Returns the session record.
 * A session owns a default "trunk" branch created on first use.
 */
async function getOrCreateSession(sessionId, userId) {
  const existing = await ddb.send(new GetCommand({
    TableName: TABLES.sessionsTable,
    Key: { sessionId },
  }));

  if (existing.Item) return existing.Item;

  // New session — create session + trunk branch atomically
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
    parentMsgId: null,         // message after which the fork happened
    selectedMsgIds: [],        // grows as messages are added
    label: 'main',
    createdAt: now,
  };

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
  if (!res.Item) throw new Error(`Branch not found: ${branchId}`);
  return res.Item;
}

/**
 * Fork: create a new branch from a custom selectedMsgIds list.
 * The old branch is preserved intact.
 */
async function forkBranch({ sessionId, parentBranchId, parentMsgId, selectedMsgIds, label }) {
  const branchId = `branch_${uuidv4()}`;
  const now = new Date().toISOString();

  const branch = {
    branchId,
    sessionId,
    parentBranchId,
    parentMsgId,
    selectedMsgIds: selectedMsgIds || [],
    label: label || `fork-${Date.now()}`,
    createdAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.branchesTable, Item: branch }));
  return branch;
}

/**
 * Append a msgId to a branch's selectedMsgIds list.
 */
async function appendMsgToBranch(branchId, msgId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.branchesTable,
    Key: { branchId },
    UpdateExpression: 'SET selectedMsgIds = list_append(if_not_exists(selectedMsgIds, :empty), :ids)',
    ExpressionAttributeValues: {
      ':empty': [],
      ':ids': [msgId],
    },
  }));
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Save a user message. Returns the saved item.
 */
async function saveUserMessage({ sessionId, branchId, content, userId }) {
  const msgId = `msg_${uuidv4()}`;
  const now = new Date().toISOString();

  const item = {
    msgId,
    sessionId,
    branchId,
    role: 'user',
    content,
    state: MessageState.ACTIVE,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  // Save message + append to branch selectedMsgIds atomically
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLES.messagesTable, Item: item } },
      {
        Update: {
          TableName: TABLES.branchesTable,
          Key: { branchId },
          UpdateExpression:
            'SET selectedMsgIds = list_append(if_not_exists(selectedMsgIds, :empty), :ids)',
          ExpressionAttributeValues: { ':empty': [], ':ids': [msgId] },
        },
      },
    ],
  }));

  return item;
}

/**
 * Save the assistant's streamed response once streaming is complete.
 * Checks the parent user message state — if it was stopped, marks this stopped too.
 */
async function saveAssistantMessage({
  sessionId,
  branchId,
  content,
  parentMsgId,
  inputTokens,
  outputTokens,
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
    role: 'assistant',
    content,
    state,
    parentMsgId,
    inputTokens:  inputTokens  || 0,
    outputTokens: outputTokens || 0,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLES.messagesTable, Item: item } },
      {
        Update: {
          TableName: TABLES.branchesTable,
          Key: { branchId },
          UpdateExpression:
            'SET selectedMsgIds = list_append(if_not_exists(selectedMsgIds, :empty), :ids)',
          ExpressionAttributeValues: { ':empty': [], ':ids': [msgId] },
        },
      },
    ],
  }));

  return item;
}

/**
 * Update the state of any message (stop, edit, delete, restore).
 */
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

/**
 * Fetch the active messages for a branch in order, ready to feed to Bedrock.
 * Respects the branch's selectedMsgIds ordering and filters to active only.
 */
async function getActiveHistoryForBranch(branchId, maxMessages, maxTokenBudget) {
  const branch = await getBranch(branchId);
  const { selectedMsgIds = [] } = branch;

  if (selectedMsgIds.length === 0) return [];

  // Batch-get all selected messages in chunks of 100
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

  // Apply hard message cap
  const capped = ordered.slice(-maxMessages);

  // Apply approximate token budget from the tail
  let tokenCount = 0;
  const budgeted = [];
  for (let i = capped.length - 1; i >= 0; i--) {
    const approxTokens = Math.ceil(capped[i].content.length / 4);
    if (tokenCount + approxTokens > maxTokenBudget) break;
    tokenCount += approxTokens;
    budgeted.unshift(capped[i]);
  }

  return budgeted;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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