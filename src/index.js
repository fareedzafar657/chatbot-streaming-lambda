'use strict';

const { verifyAuth }       = require('./middleware/auth');
const { handleChatStream } = require('./handlers/chat');
const { createTransport }  = require('./utils/transport');
const { parseRequest }     = require('./utils/request');

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
 *   {"type":"done","msgId":"...","state":"active","inputTokens":42,"outputTokens":17}
 *
 * Error lines:
 *   {"type":"error","message":"Unauthorized: ..."}
 *
 * Note: CORS is handled by Function URL configuration, not in code.
 */
exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const metadata = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
  const transport = createTransport('functionUrl', { responseStream });

  // ── Auth ─────────────────────────────────────────────────────────────────
  let userId;
  let userEmail = null;
  try {
    const payload = await verifyAuth(event.headers);
    userId = payload.sub;
    userEmail = payload.username ?? null;
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
    await handleChatStream(transport, { ...parsed, userId, userEmail });
  } catch (err) {
    console.error('[handler] Unhandled error:', err);
    transport.send({ type: 'error', message: 'Internal server error' });
  } finally {
    transport.end();
  }
});
