/**
 * AWS Bedrock streaming adapter — the default provider.
 *
 * Used whenever a request has no BYOK apiKey. Calls Bedrock's ConverseStream
 * API and yields a uniform chunk stream — {type:'delta'|'done'|'error'} — so
 * the chat handler treats every provider identically.
 *
 * Authentication is the Lambda's IAM role (not a per-user key), so the client
 * is a module-level singleton reused across warm invocations. Token usage
 * arrives in a metadata event that fires AFTER the text, so 'done' is yielded
 * only once the whole stream has drained.
 */

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import config from '../config.js';

// Singleton client — reused across warm invocations
const client = new BedrockRuntimeClient({ region: config.region });

function buildBedrockMessages(dbMessages) {
  return dbMessages.map(m => ({
    role:    m.role,
    content: [{ text: m.content }],
  }));
}

export async function* streamBedrockResponse(historyMessages, userPrompt, options = {}) {
  const modelId      = options.modelId  || config.bedrock.modelId;
  const maxTokens    = options.maxTokens || config.bedrock.maxTokens;
  const systemPrompt = options.systemPrompt;

  const messages = [
    ...buildBedrockMessages(historyMessages),
    { role: 'user', content: [{ text: userPrompt }] },
  ];

  const command = new ConverseStreamCommand({
    modelId,
    ...(systemPrompt && { system: [{ text: systemPrompt }] }),
    messages,
    inferenceConfig: {
      maxTokens,
      temperature: config.bedrock.temperature,
      topP:        config.bedrock.topP,
    },
  });

  let inputTokens  = 0;
  let outputTokens = 0;
  let stopReason;

  try {
    const response = await client.send(command);

    for await (const event of response.stream) {

      if (event.contentBlockDelta?.delta?.text) {
        yield { type: 'delta', text: event.contentBlockDelta.delta.text };
      }

      // Both inputTokens and outputTokens arrive in metadata, which fires AFTER messageStop
      if (event.metadata?.usage) {
        inputTokens  = event.metadata.usage.inputTokens  || 0;
        outputTokens = event.metadata.usage.outputTokens || 0;
      }

      if (event.messageStop) {
        stopReason = event.messageStop.stopReason;
      }
    }

    // Yield done after the full stream so metadata tokens are captured
    yield { type: 'done', stopReason, inputTokens, outputTokens };

  } catch (err) {
    console.error('[bedrock] stream error:', err.message);
    yield { type: 'error', error: 'Model request failed' };
  }
}