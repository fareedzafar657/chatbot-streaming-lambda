'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config    = require('../config');

// ─── Message format ───────────────────────────────────────────────────────────

function buildAnthropicMessages(dbMessages, userPrompt) {
  const history = dbMessages.map(m => ({ role: m.role, content: m.content }));
  return [...history, { role: 'user', content: userPrompt }];
}

// ─── Streaming generator ──────────────────────────────────────────────────────

/**
 * Stream a response from Anthropic using the user's own API key.
 * Yields same chunk shapes as streamBedrockResponse() — delta/done/error.
 *
 * @param {Array}  historyMessages       - from getActiveHistoryForBranch()
 * @param {string} userPrompt
 * @param {object} options
 * @param {string} options.apiKey        - user's Anthropic key (required)
 * @param {string} [options.modelId]     - defaults to claude-haiku-4-5-20251001
 * @param {number} [options.maxTokens]   - defaults to config.bedrock.maxTokens
 * @param {string} [options.systemPrompt]- defaults to config.bedrock.systemPrompt
 */
async function* streamAnthropicResponse(historyMessages, userPrompt, options = {}) {
  const { apiKey } = options;
  const modelId      = options.modelId      || 'claude-haiku-4-5-20251001';
  const maxTokens    = options.maxTokens    || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt || config.bedrock.systemPrompt;

  const client = new Anthropic({ apiKey }); // per-call — never cached

  try {
    const stream = client.messages.stream({
      model:      modelId,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   buildAnthropicMessages(historyMessages, userPrompt),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'delta', text: event.delta.text };
      }
      if (event.type === 'message_delta' && event.usage) {
        yield {
          type:         'done',
          inputTokens:  event.usage.input_tokens  ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
        };
      }
    }
  } catch (err) {
    console.error('[anthropic] error:', err.message); // message only — key never logged
    yield { type: 'error', error: 'Anthropic request failed' };
  }
}

module.exports = { streamAnthropicResponse };
