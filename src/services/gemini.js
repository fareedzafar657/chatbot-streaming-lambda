'use strict';

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

/**
 * Stream a response from Google Gemini using the user's own API key.
 * Yields same chunk shapes as streamBedrockResponse() — delta/done/error.
 *
 * usageMetadata accumulates across chunks — only the last chunk has accurate
 * final token counts, so we overwrite on each chunk and yield done after the loop.
 *
 * @param {Array}  historyMessages       - from getActiveHistoryForBranch()
 * @param {string} userPrompt
 * @param {object} options
 * @param {string} options.apiKey        - user's Gemini key (required)
 * @param {string} [options.modelId]     - defaults to gemini-2.5-flash
 * @param {number} [options.maxTokens]   - defaults to config.bedrock.maxTokens
 * @param {string} [options.systemPrompt]- defaults to config.bedrock.systemPrompt
 */
async function* streamGeminiResponse(historyMessages, userPrompt, options = {}) {
  const { apiKey } = options;
  const modelId      = options.modelId      || 'gemini-2.5-flash';
  const maxTokens    = options.maxTokens    || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt || config.bedrock.systemPrompt;

  const ai = new GoogleGenAI({ apiKey }); // per-call — never cached

  try {
    const stream = await ai.models.generateContentStream({
      model:    modelId,
      contents: buildGeminiContents(historyMessages, userPrompt),
      config: {
        maxOutputTokens:   maxTokens,
        systemInstruction: systemPrompt,
      },
    });

    let inputTokens = 0, outputTokens = 0;

    for await (const chunk of stream) {
      if (chunk.text) {
        yield { type: 'delta', text: chunk.text };
      }
      // Overwrite each time — final chunk has the accurate totals
      if (chunk.usageMetadata) {
        inputTokens  = chunk.usageMetadata.promptTokenCount     ?? 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }

    yield { type: 'done', inputTokens, outputTokens };

  } catch (err) {
    console.error('[gemini] error:', err.message); // message only — key never logged
    yield { type: 'error', error: 'Gemini request failed' };
  }
}

module.exports = { streamGeminiResponse };
