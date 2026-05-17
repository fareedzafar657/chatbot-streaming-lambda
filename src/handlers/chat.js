'use strict';

const { streamBedrockResponse }   = require('../services/bedrock');
const { streamAnthropicResponse } = require('../services/anthropic');
const { streamGeminiResponse }    = require('../services/gemini');
const db                          = require('../services/dynamodb');
const config                      = require('../config');

/**
 * Core streaming handler — orchestrates the full chat turn:
 *   1. Resolve session + branch
 *   2. Save user message
 *   3. Load active history
 *   4. Stream Bedrock response token by token via transport
 *   5. Save assistant message (with state check against user msg)
 *
 * Transport-agnostic: accepts any object with .send(payload) and .end() methods.
 * This means migrating to WebSocket only requires a new transport object,
 * not changes to this file.
 *
 * @param {object} transport   - FunctionUrlTransport or WebSocketTransport
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} params.sessionId
 * @param {string|null} params.branchId  - null → use session's activeBranchId
 * @param {string} params.userId         - from Cognito JWT sub
 */
async function handleChatStream(transport, { prompt, sessionId, branchId, userId, apiKey, provider, model, systemPrompt }) {

  // ── 1. Resolve session + branch ──────────────────────────────────────────
  const session = await db.getOrCreateSession(sessionId, userId);
  const activeBranchId = branchId || session.activeBranchId;

  // Send metadata immediately so the client knows IDs before tokens arrive
  transport.send({
    type:      'metadata',
    sessionId,
    branchId:  activeBranchId,
  });

  // ── 2. Save user message ─────────────────────────────────────────────────
  const userMsg = await db.saveUserMessage({
    sessionId,
    branchId: activeBranchId,
    content:  prompt,
    userId,
  });

  transport.send({
    type:  'userMessage',
    msgId: userMsg.msgId,
  });

  // ── 3. Load active history (excluding the message we just saved) ─────────
  //    getActiveHistoryForBranch returns the branch's selectedMsgIds in order,
  //    filtered to state=active. The new user message is already appended to
  //    the branch, so we pass it to Bedrock as the last turn.
  const history = await db.getActiveHistoryForBranch(
    activeBranchId,
    config.history.maxMessages,
    config.history.maxTokenBudget,
  );

  // Separate the history from the current user turn (last message is the new one)
  // We pass the prior history + the prompt separately to streamBedrockResponse
  const priorHistory = history.filter(m => m.msgId !== userMsg.msgId);

  // ── 4. Select provider and stream response ───────────────────────────────

  // Security: Bedrock path (no apiKey) always uses the configured model — client cannot override.
  // BYOK paths honour the user's model choice since it's their key and their cost.
  const safeModel = (!apiKey && !provider) ? null : model;

  const streamOptions = {
    modelId:      safeModel    || undefined,
    systemPrompt: systemPrompt || undefined,
    maxTokens:    config.bedrock.maxTokens,
    apiKey,
  };

  // Resolve the modelId that will actually be used — saved to DynamoDB for usage tracking
  const resolvedModelId =
    safeModel                      ? safeModel :
    provider === 'anthropic'       ? 'claude-haiku-4-5-20251001' :
    provider === 'gemini'          ? 'gemini-2.5-flash' :
    config.bedrock.modelId;

  const stream =
    apiKey && provider === 'anthropic' ? streamAnthropicResponse(priorHistory, prompt, streamOptions) :
    apiKey && provider === 'gemini'    ? streamGeminiResponse(priorHistory, prompt, streamOptions) :
    streamBedrockResponse(priorHistory, prompt, streamOptions);

  let fullText     = '';
  let inputTokens  = 0;
  let outputTokens = 0;
  let hadError     = false;

  try {
    for await (const chunk of stream) {

      if (chunk.type === 'delta') {
        fullText += chunk.text;
        transport.send({ type: 'delta', text: chunk.text });
      }

      else if (chunk.type === 'done') {
        inputTokens  = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
      }

      else if (chunk.type === 'error') {
        hadError = true;
        transport.send({ type: 'error', message: chunk.error });
      }
    }
  } catch (err) {
    hadError = true;
    transport.send({ type: 'error', message: 'Bedrock streaming failed' });
    console.error('[handleChatStream] Bedrock error:', err);
  }

  // ── 5. Persist assistant message ─────────────────────────────────────────
  //    saveAssistantMessage checks if the parent user message was stopped.
  //    If yes, the assistant message is saved as state=stopped automatically.
  if (fullText.length > 0) {
    const assistantMsg = await db.saveAssistantMessage({
      sessionId,
      branchId: activeBranchId,
      content:  fullText,
      parentMsgId: userMsg.msgId,
      inputTokens,
      outputTokens,
      modelId: resolvedModelId,
      userId,
    });

    transport.send({
      type:         'done',
      msgId:        assistantMsg.msgId,
      state:        assistantMsg.state,
      inputTokens,
      outputTokens,
    });
  } else if (!hadError) {
    // Bedrock returned empty content (shouldn't happen, but handle gracefully)
    transport.send({ type: 'done', msgId: null, inputTokens, outputTokens });
  }
}

module.exports = { handleChatStream };