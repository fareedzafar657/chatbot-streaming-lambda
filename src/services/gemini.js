'use strict';

/**
 * Google Gemini streaming adapter (BYOK path).
 *
 * Turns DynamoDB message rows into Gemini's "contents" format (note: Gemini
 * uses the role "model", not "assistant") and yields a uniform chunk stream —
 * {type:'delta'|'done'|'error'} — so the chat handler treats every provider
 * identically.
 *
 * Reached only when the request carries the user's own apiKey and
 * provider:"gemini". A fresh client is created per request on purpose: a
 * client is bound to one user's key and must never be reused across users.
 */

const { GoogleGenAI } = require('@google/genai');
const config          = require('../config');

// ─── Message format ───────────────────────────────────────────────────────────

function buildGeminiContents(dbMessages, userPrompt) {
  const history = dbMessages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user', // Gemini uses "model" not "assistant"
    parts: [{ text: m.content }],
  }));
  return [...history, { role: 'user', parts: [{ text: userPrompt }] }];
}

// ─── Streaming generator ──────────────────────────────────────────────────────

async function* streamGeminiResponse(historyMessages, userPrompt, options = {}) {
  const { apiKey } = options;
  const modelId      = options.modelId      || config.gemini.defaultModel;
  const maxTokens    = options.maxTokens    || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt;

  const ai = new GoogleGenAI({ apiKey });

  try {
    const stream = await ai.models.generateContentStream({
      model:    modelId,
      contents: buildGeminiContents(historyMessages, userPrompt),
      config: {
        maxOutputTokens: maxTokens,
        ...(systemPrompt && { systemInstruction: systemPrompt }),
      },
    });

    let inputTokens = 0, outputTokens = 0, stopReason;

    for await (const chunk of stream) {
      if (chunk.text) {
        yield { type: 'delta', text: chunk.text };
      }
      // Overwrite each time — final chunk has the accurate totals
      if (chunk.usageMetadata) {
        inputTokens  = chunk.usageMetadata.promptTokenCount     ?? 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
      if (chunk.candidates?.[0]?.finishReason) {
        stopReason = chunk.candidates[0].finishReason;
      }
    }

    // usageMetadata is nil for some models (e.g. gemini-2.5-pro) — known SDK issue
    if (inputTokens === 0 && outputTokens === 0) {
      console.warn('[gemini] usageMetadata missing from stream — known issue with some models');
    }

    yield { type: 'done', inputTokens, outputTokens, stopReason };

  } catch (err) {
    console.error('[gemini] error:', err.message); // message only — key never logged
    yield { type: 'error', error: 'Gemini request failed' };
  }
}

module.exports = { streamGeminiResponse };
