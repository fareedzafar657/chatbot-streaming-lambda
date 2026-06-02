/**
 * Chat turn orchestrator — the heart of a request.
 *
 * Given a parsed request and a Transport, this runs one full chat turn:
 * resolve the session and branch, enforce branch ownership, pick the model,
 * save the user message, load trimmed history, stream the model's reply, and
 * persist the assistant message. It speaks only to the Transport interface,
 * so it has no idea which wire protocol carries the bytes.
 *
 * It does NOT authenticate or parse the body — that happens upstream in
 * run-chat-request.js. It does NOT talk to AI SDKs or DynamoDB directly —
 * that lives in services/.
 */

import { streamBedrockResponse } from '../services/bedrock.js';
import { streamAnthropicResponse } from '../services/anthropic.js';
import { streamGeminiResponse } from '../services/gemini.js';
import * as db from '../services/dynamodb.js';
import config from '../config.js';

// ─── Model resolution ──────────────────────────────────────────────────────────

/**
 * Decide which model a request runs on. Returns two values:
 *  - override: the model id passed to the provider. null means "use the
 *    provider's own default".
 *  - recorded: the concrete model id saved to DynamoDB for usage tracking —
 *    always a real id, never null.
 *
 * Security: on the plain Bedrock path (no apiKey) the client cannot choose the
 * model. The one exception is the demo allowlist — a demo-approved user may
 * pick a model from config.demoModels.bedrockModels. BYOK paths honour the
 * client's model choice since it is their key and their cost.
 */
function resolveModel({ apiKey, provider, model, userEmail }) {
  const isByok = Boolean(apiKey);

  const isDemoUser   = Boolean(userEmail) && config.demoModels.allowedEmails.includes(userEmail);
  const demoOverride = !isByok && isDemoUser && model && config.demoModels.bedrockModels.includes(model)
    ? model
    : null;

  const override = demoOverride || (isByok ? model : null);

  const recorded =
    override                 ? override :
    provider === 'anthropic' ? config.anthropic.defaultModel :
    provider === 'gemini'    ? config.gemini.defaultModel :
                               config.bedrock.modelId;

  return { override, recorded };
}

// ─── Chat turn ─────────────────────────────────────────────────────────────────

export async function handleChatStream(send, { prompt, sessionId, branchId, userId, userEmail, apiKey, provider, model, systemPrompt }) {

  // ── 1. Resolve session + branch ──────────────────────────────────────────
  const session = await db.getOrCreateSession(sessionId, userId);

  // Verify the caller-supplied branchId actually belongs to this session.
  // Without this check an authenticated user could inject any branchId and
  // have another user's conversation history fed to the model.
  if (branchId && branchId !== session.activeBranchId) {
    const branch = await db.getBranch(branchId);
    if (branch.sessionId !== sessionId) {
      send({ type: 'error', message: 'Forbidden' });
      return;
    }
  }

  const activeBranchId = session.activeBranchId;

  // ── 2. Resolve model + send metadata ─────────────────────────────────────
  const { override: modelOverride, recorded: resolvedModelId } =
    resolveModel({ apiKey, provider, model, userEmail });

  // Send metadata immediately so the client knows the IDs before tokens arrive
  send({
    type:      'metadata',
    sessionId,
    branchId:  activeBranchId,
    modelId:   resolvedModelId,
  });

  // ── 3. Save user message ─────────────────────────────────────────────────
  const userMsg = await db.saveUserMessage({
    sessionId,
    branchId: activeBranchId,
    content:  prompt,
    userId,
  });

  send({
    type:  'userMessage',
    msgId: userMsg.msgId,
  });

  // ── 4. Load active history ───────────────────────────────────────────────
  const history = await db.getActiveHistoryForBranch(
    activeBranchId,
    config.history.maxMessages,
    config.history.maxTokenBudget,
  );

  const priorHistory = history.filter(m => m.msgId !== userMsg.msgId);

  // ── 5. Stream response ───────────────────────────────────────────────────

  // All AI providers require conversation history to start with a user turn.
  // If the branch starts with a compaction summary (assistant role), inject its
  // content into the system prompt so it acts as context without breaking the API contract.
  const effectiveOptions = {
    modelId:      modelOverride || undefined,
    systemPrompt: systemPrompt  || undefined,
    maxTokens:    config.bedrock.maxTokens,
    apiKey,
  };
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
      console.log('chunkchunk',chunk)

      if (chunk.type === 'delta') {
        fullText += chunk.text;
        send({ type: 'delta', text: chunk.text });
      }

      else if (chunk.type === 'done') {
        inputTokens  = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
      }

      else if (chunk.type === 'error') {
        hadError = true;
        send({ type: 'error', message: chunk.error });
      }
    }
  } catch (err) {
    hadError = true;
    send({ type: 'error', message: 'Model streaming failed' });
    console.error('[handleChatStream] streaming error:', err);
  }

  // ── 6. Persist assistant message ─────────────────────────────────────────
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

    send({
      type:         'done',
      msgId:        assistantMsg.msgId,
      state:        assistantMsg.state,
      inputTokens,
      outputTokens,
    });
  } else if (!hadError) {
    send({ type: 'done', msgId: null, inputTokens, outputTokens });
  }
}