'use strict';

require('dotenv').config();

/**
 * Local HTTP server that wraps the Lambda handler for frontend dev.
 * Does NOT use awslambda globals — calls handleChatStream directly.
 */

const http                               = require('http');
const { verifyAuth }                     = require('../src/middleware/auth');
const { handleChatStream }               = require('../src/handlers/chat');
const { FunctionUrlTransport }           = require('../src/utils/transport');
const { parseRequest, streamingHeaders } = require('../src/utils/request');

const PORT = process.env.PORT || 4000;

// ─── CORS headers ─────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
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

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  // Build a minimal Lambda-style event so parseRequest works unchanged
  const event = {
    body:            rawBody,
    isBase64Encoded: false,
    headers:         req.headers,
  };

  res.writeHead(200, { ...CORS_HEADERS, ...streamingHeaders() });

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
});
