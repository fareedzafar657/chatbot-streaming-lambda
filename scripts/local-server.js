'use strict';

/**
 * Local HTTP server that wraps the Lambda handler logic for frontend dev.
 *
 * Mimics a Lambda Function URL: POST / → NDJSON stream.
 * Does NOT use awslambda globals — calls handleChatStream directly.
 *
 * Usage:
 *   AUTH_BYPASS=true node scripts/local-server.js
 *   AUTH_BYPASS=true PORT=3001 node scripts/local-server.js
 */

const http                             = require('http');
const { verifyAuth }                   = require('../src/middleware/auth');
const { handleChatStream }             = require('../src/handlers/chat');
const { FunctionUrlTransport }         = require('../src/utils/transport');
const { parseRequest, streamingHeaders } = require('../src/utils/request');
const config                           = require('../src/config');

const PORT = process.env.PORT || 4000;

// ─── CORS headers ─────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Buffer body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  // Build a minimal Lambda-style event so parseRequest works unchanged
  const event = {
    body: rawBody,
    isBase64Encoded: false,
    headers: req.headers,
  };

  // Stream response headers
  res.writeHead(200, {
    ...CORS_HEADERS,
    ...streamingHeaders(),
  });

  const transport = new FunctionUrlTransport(res);

  // ── Auth ──────────────────────────────────────────────────────────────────
  let userId;
  try {
    const payload = await verifyAuth(event.headers);
    userId = payload.sub;
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    transport.end();
    return;
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseRequest(event);
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    transport.end();
    return;
  }

  // ── Stream ────────────────────────────────────────────────────────────────
  try {
    await handleChatStream(transport, { ...parsed, userId });
  } catch (err) {
    console.error('[local-server] Unhandled error:', err);
    transport.send({ type: 'error', message: 'Internal server error' });
  } finally {
    transport.end();
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error('[local-server] Fatal:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`Local Lambda server running at http://localhost:${PORT}`);
  console.log(`AUTH_BYPASS=${process.env.AUTH_BYPASS ?? 'false'}`);
  if (!process.env.AUTH_BYPASS || process.env.AUTH_BYPASS !== 'true') {
    console.warn('Tip: set AUTH_BYPASS=true to skip Cognito JWT verification');
  }
});
