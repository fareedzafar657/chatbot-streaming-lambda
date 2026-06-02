/**
 * Anthropic streaming adapter (BYOK path).
 *
 * Turns DynamoDB message rows into the Anthropic SDK's message format and
 * yields a uniform chunk stream — {type:'delta'|'done'|'error'} — so the chat
 * handler treats every provider identically.
 *
 * Reached only when the request carries the user's own apiKey and
 * provider:"anthropic". A fresh client is created per request on purpose: a
 * client is bound to one user's key and must never be reused across users.
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';

// ─── Message format ───────────────────────────────────────────────────────────

function buildAnthropicMessages(dbMessages, userPrompt) {
  const history = dbMessages.map(m => ({ role: m.role, content: m.content }));
  return [...history, { role: 'user', content: userPrompt }];
}

// ─── Streaming generator ──────────────────────────────────────────────────────

export async function* streamAnthropicResponse(historyMessages, userPrompt, options = {}) {
  const { apiKey } = options;
  const modelId      = options.modelId      || config.anthropic.defaultModel;
  const maxTokens    = options.maxTokens    || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt;

  const client = new Anthropic({ apiKey });

  try {
    const stream = client.messages.stream({
      model:      modelId,
      max_tokens: maxTokens,
      ...(systemPrompt && { system: systemPrompt }),
      messages:   buildAnthropicMessages(historyMessages, userPrompt),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'delta', text: event.delta.text };
      }
    }

    // finalMessage() accumulates all events and returns accurate usage totals —
    // safer than manually tracking message_start / message_delta which can fire multiple times
    const final = await stream.finalMessage();
    yield {
      type:         'done',
      inputTokens:  final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      stopReason:   final.stop_reason,
    };
  } catch (err) {
    console.error('[anthropic] error:', err.message); // message only — key never logged
    yield { type: 'error', error: 'Anthropic request failed' };
  }
}