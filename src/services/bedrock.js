'use strict';

const {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const config = require('../config');

// Singleton client — reused across warm invocations
const client = new BedrockRuntimeClient({ region: config.region });

/**
 * Convert our internal DB message format → Bedrock Converse API messages array.
 * Filters to user/assistant only, preserves order.
 *
 * @param {Array} dbMessages  - from getActiveHistoryForBranch()
 * @returns {Array}           - Bedrock-format messages
 */
function buildBedrockMessages(dbMessages) {
  return dbMessages.map(m => ({
    role: m.role,                         // 'user' | 'assistant'
    content: [{ text: m.content }],
  }));
}

/**
 * Stream a response from Bedrock using the Converse streaming API.
 * Yields chunks as they arrive.
 *
 * @param {Array}    historyMessages  - prior active messages from DB
 * @param {string}   userPrompt       - the new user message text
 * @param {object}   [options]
 * @param {string}   [options.modelId]
 * @param {number}   [options.maxTokens]
 * @param {string}   [options.systemPrompt]
 *
 * @yields {{ type: 'delta'|'done'|'error', text?: string, inputTokens?: number, outputTokens?: number }}
 */
async function* streamBedrockResponse(historyMessages, userPrompt, options = {}) {
  const modelId     = options.modelId     || config.bedrock.modelId;
  const maxTokens   = options.maxTokens   || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt || config.bedrock.systemPrompt;

  // Build full messages array: history + new user turn
  const messages = [
    ...buildBedrockMessages(historyMessages),
    { role: 'user', content: [{ text: userPrompt }] },
  ];

  const command = new ConverseStreamCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages,
    inferenceConfig: {
      maxTokens,
      temperature: 0.7,
      topP: 0.9,
    },
  });

  let inputTokens  = 0;
  let outputTokens = 0;

  try {
    const response = await client.send(command);

    for await (const event of response.stream) {

      // Text delta — the main streaming token
      if (event.contentBlockDelta?.delta?.text) {
        yield { type: 'delta', text: event.contentBlockDelta.delta.text };
      }

      // Token usage metadata (arrives in messageStart or metadata events)
      if (event.metadata?.usage) {
        inputTokens  = event.metadata.usage.inputTokens  || 0;
        outputTokens = event.metadata.usage.outputTokens || 0;
      }

      // messageStart sometimes carries usage too
      if (event.messageStart?.usage) {
        inputTokens = event.messageStart.usage.inputTokens || 0;
      }

      // Stream complete
      if (event.messageStop) {
        yield {
          type: 'done',
          stopReason: event.messageStop.stopReason,
          inputTokens,
          outputTokens,
        };
      }
    }
  } catch (err) {
    yield { type: 'error', error: err.message };
    throw err;
  }
}

module.exports = { streamBedrockResponse };