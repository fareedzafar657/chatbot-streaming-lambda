'use strict';

/**
 * HTTP utilities for Lambda Function URL streaming responses.
 * Handles request parsing (body decoding, JSON, validation).
 * Does NOT handle auth — that lives in middleware/auth.js.
 * CORS is handled by Lambda Function URL configuration.
 */

/**
 * Expected JSON body:
 * {
 *   "prompt":       string   (required) — the user's message
 *   "sessionId":    string   (required) — client-managed session identifier
 *   "branchId":     string   (optional) — if omitted, uses session's activeBranchId
 *   "apiKey":       string   (optional) — user's own provider API key
 *   "provider":     string   (optional) — "anthropic" | "gemini"; omit for Bedrock
 *   "model":        string   (optional) — model ID; omit for provider default
 *   "systemPrompt": string   (optional) — overrides the default system prompt
 * }
 */
function parseRequest(event) {
  let rawBody = event.body;

  if (!rawBody) {
    throw Object.assign(new Error('Request body is empty'), { statusCode: 400 });
  }

  // Lambda Function URLs can base64-encode the body
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
  }

  let body;
  try {
    body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 });
  }

  const { prompt, sessionId, branchId, apiKey, provider, model, systemPrompt } = body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw Object.assign(new Error('prompt is required and must be a non-empty string'), { statusCode: 400 });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    throw Object.assign(new Error('sessionId is required'), { statusCode: 400 });
  }

  return {
    prompt:       prompt.trim(),
    sessionId:    sessionId.trim(),
    branchId:     branchId?.trim()     || null,
    apiKey:       typeof apiKey       === 'string' ? (apiKey.trim()       || null) : null,
    provider:     typeof provider     === 'string' ? (provider.trim()     || null) : null,
    model:        typeof model        === 'string' ? (model.trim()        || null) : null,
    systemPrompt: typeof systemPrompt === 'string' ? (systemPrompt.trim() || null) : null,
  };
}

module.exports = { parseRequest };