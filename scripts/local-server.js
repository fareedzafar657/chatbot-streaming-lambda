'use strict';

require('dotenv').config();

/**
 * Local HTTP server that wraps the Lambda handler for frontend dev.
 *
 * Does NOT use the awslambda globals. It builds a Lambda-style event from the
 * raw HTTP request and runs the exact same request lifecycle as production
 * (src/run-chat-request.js), so the request shape and NDJSON stream are
 * identical to the deployed Function URL.
 *
 * This file only owns HTTP concerns: method routing, CORS, and reading the
 * request body. Auth, parsing, and streaming live in run-chat-request.js.
 */

const http                    = require('http');
const { FunctionUrlTransport } = require('../src/utils/transport');
const { runChatRequest }       = require('../src/run-chat-request');
const { streamingHeaders }     = require('../src/utils/request');

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

  // Build a minimal Lambda-style event so the shared lifecycle works unchanged
  const event = {
    body:            rawBody,
    isBase64Encoded: false,
    headers:         req.headers,
  };

  res.writeHead(200, { ...CORS_HEADERS, ...streamingHeaders() });

  const transport = new FunctionUrlTransport(res);
  try {
    await runChatRequest(transport, event);
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
