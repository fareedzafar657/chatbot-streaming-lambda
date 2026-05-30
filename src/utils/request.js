'use strict';

/**
 * Request parsing and validation.
 * Does NOT handle auth — that lives in middleware/auth.js.
 * CORS is handled by Lambda Function URL configuration.
 */

// Providers that accept a bring-your-own-key request.
const BYOK_PROVIDERS = ['anthropic', 'gemini'];

function parseRequest(event) {
  let rawBody = event.body;

  if (!rawBody) {
    throw Object.assign(new Error('Request body is empty'), { statusCode: 400 });
  }

  // Lambda Function URLs can base64-encode the body   --- Needs to verify if this if block is even needed
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

  // DynamoDB item limit is 400 KB; keep well under it for the message row.
  // 32 000 chars ≈ 8 000 tokens — a generous cap that still prevents abuse.
  const PROMPT_MAX_CHARS = 32_000;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw Object.assign(new Error('prompt is required and must be a non-empty string'), { statusCode: 400 });
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw Object.assign(new Error(`prompt exceeds maximum length of ${PROMPT_MAX_CHARS} characters`), { statusCode: 400 });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    throw Object.assign(new Error('sessionId is required'), { statusCode: 400 });
  }

  const normalized = {
    prompt:       prompt.trim(),
    sessionId:    sessionId.trim(),
    branchId:     branchId?.trim()     || null,
    apiKey:       typeof apiKey       === 'string' ? (apiKey.trim()       || null) : null,
    provider:     typeof provider     === 'string' ? (provider.trim()     || null) : null,
    model:        typeof model        === 'string' ? (model.trim()        || null) : null,
    systemPrompt: typeof systemPrompt === 'string' ? (systemPrompt.trim() || null) : null,
  };

  if (normalized.apiKey && !BYOK_PROVIDERS.includes(normalized.provider)) {
    throw Object.assign(
      new Error('provider must be "anthropic" or "gemini" when apiKey is set'),
      { statusCode: 400 },
    );
  }

  return normalized;
}

module.exports = { parseRequest };
