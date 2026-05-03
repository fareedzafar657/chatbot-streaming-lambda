'use strict';

/**
 * Parse and validate the incoming Lambda Function URL event body.
 * Supports both raw string body and base64-encoded body.
 *
 * Expected JSON body:
 * {
 *   "prompt":     string   (required) — the user's message
 *   "sessionId":  string   (required) — client-managed session identifier
 *   "branchId":   string   (optional) — if omitted, uses session's activeBranchId
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

  const { prompt, sessionId, branchId } = body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw Object.assign(new Error('prompt is required and must be a non-empty string'), { statusCode: 400 });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    throw Object.assign(new Error('sessionId is required'), { statusCode: 400 });
  }

  return {
    prompt:    prompt.trim(),
    sessionId: sessionId.trim(),
    branchId:  branchId?.trim() || null,
  };
}

/**
 * Build content-type headers for streaming responses.
 * The Function URL handler reads these from httpResponseMetadata.
 */
function streamingHeaders() {
  return {
    'Content-Type': 'application/x-ndjson',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache, no-store',
  };
}

module.exports = { parseRequest, streamingHeaders };