import { runChatRequest } from './run-chat-request.js';

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
 * and hands off. The request lifecycle (auth → parse → stream) lives in
 * run-chat-request.js, shared with the local dev server.
 *
 * Note: CORS is handled by Function URL configuration.
 */
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const metadata = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
  const send = (payload) => responseStream.write(JSON.stringify(payload) + '\n');

  try {
    await runChatRequest(send, event);
  } finally {
    responseStream.end();
  }
});