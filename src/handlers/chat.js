'use strict';

const { streamBedrockResponse }   = require('../services/bedrock');
const { streamAnthropicResponse } = require('../services/anthropic');
const { streamGeminiResponse }    = require('../services/gemini');
const db                          = require('../services/dynamodb');
const config                      = require('../config');

async function handleChatStream(transport, { prompt, sessionId, branchId, userId, apiKey, provider, model, systemPrompt }) {

  // ── 1. Resolve session + branch ──────────────────────────────────────────
  const session = await db.getOrCreateSession(sessionId, userId);

  // Verify the caller-supplied branchId actually belongs to this session.
  // Without this check an authenticated user could inject any branchId and
  // have another user's conversation history fed to the model.
  if (branchId && branchId !== session.activeBranchId) {
    const branch = await db.getBranch(branchId);
    if (branch.sessionId !== sessionId) {
      transport.send({ type: 'error', message: 'Forbidden' });
      transport.end();
      return;
    }
  }

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

  // ── 3. Load active history ───────────────────────────────────────────────
  const history = await db.getActiveHistoryForBranch(
    activeBranchId,
    config.history.maxMessages,
    config.history.maxTokenBudget,
  );

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

  // Resolve the modelId saved to DynamoDB for usage tracking
  const resolvedModelId =
    safeModel                      ? safeModel :
    provider === 'anthropic'       ? 'claude-haiku-4-5-20251001' :
    provider === 'gemini'          ? 'gemini-2.5-flash' :
    config.bedrock.modelId;

  // All AI providers require conversation history to start with a user turn.
  // If the branch starts with a compaction summary (assistant role), inject its
  // content into the system prompt so it acts as context without breaking the API contract.
  const effectiveOptions = { ...streamOptions };
  let historyForProvider = priorHistory;
  if (priorHistory.length > 0 && priorHistory[0].role === 'assistant') {
    const ctx = `[Context from previous conversation]\n${priorHistory[0].content}`;
    effectiveOptions.systemPrompt = effectiveOptions.systemPrompt
      ? `${effectiveOptions.systemPrompt}\n\n${ctx}`
      : ctx;
    historyForProvider = priorHistory.slice(1);
  }

  const stream =
    apiKey && provider === 'anthropic' ? streamAnthropicResponse(historyForProvider, prompt, effectiveOptions) :
    apiKey && provider === 'gemini'    ? streamGeminiResponse(historyForProvider, prompt, effectiveOptions) :
    streamBedrockResponse(historyForProvider, prompt, effectiveOptions);

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
    transport.send({ type: 'done', msgId: null, inputTokens, outputTokens });
  }
}

module.exports = { handleChatStream };
