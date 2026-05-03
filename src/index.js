'use strict';

const { verifyAuth }       = require('./middleware/auth');
const { handleChatStream } = require('./handlers/chat');
const { createTransport }  = require('./utils/transport');
const { parseRequest, streamingHeaders } = require('./utils/request');
const config               = require('./config');

/**
 * Lambda Function URL handler with response streaming.
 *
 * Endpoint: POST /
 * Headers:  Authorization: Bearer <Cognito access token>
 * Body:     { "prompt": "...", "sessionId": "...", "branchId": "..." }
 *
 * Response: NDJSON stream
 *   {"type":"metadata","sessionId":"...","branchId":"..."}
 *   {"type":"userMessage","msgId":"..."}
 *   {"type":"delta","text":"Hello"}
 *   {"type":"delta","text":", world"}
 *   {"type":"done","msgId":"...","state":"active","inputTokens":42,"outputTokens":17}
 *
 * Error lines:
 *   {"type":"error","message":"Unauthorized: ..."}
 */
exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Set response headers (must be set before writing to the stream)
  // awslambda.HttpResponseStream.from() lets us set status + headers
  const metadata = {
    statusCode: 200,
    headers: streamingHeaders(config.cors.origin),
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);

  const transport = createTransport('functionUrl', { responseStream });

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (event.requestContext?.http?.method === 'OPTIONS') {
    responseStream.end();
    return;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  let userId;
  try {
    const payload = await verifyAuth(event.headers);
    userId = payload.sub;           // Cognito user UUID
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    transport.end();
    return;
  }

  // ── Parse request ─────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseRequest(event);
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    transport.end();
    return;
  }

  // ── Stream chat ───────────────────────────────────────────────────────────
  try {
    await handleChatStream(transport, { ...parsed, userId });
  } catch (err) {
    console.error('[handler] Unhandled error:', err);
    transport.send({ type: 'error', message: 'Internal server error' });
  } finally {
    transport.end();
  }
});