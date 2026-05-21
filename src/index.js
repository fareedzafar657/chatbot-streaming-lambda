'use strict';

const { createTransport } = require('./utils/transport');
const { runChatRequest }  = require('./run-chat-request');

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
 * This file is ONLY the Lambda adapter — it wires the awslambda response stream
 * into a Transport and hands off. The request lifecycle (auth → parse → stream)
 * lives in run-chat-request.js, shared with the local dev server.
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

  try {
    await runChatRequest(transport, event);
  } finally {
    transport.end();
  }
});
