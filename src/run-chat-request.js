'use strict';

/**
 * Shared request lifecycle.
 *
 * One request always flows through the same three steps: verify the Cognito
 * token, parse and validate the body, then stream the chat turn. Both entry
 * points run exactly this sequence — the Lambda handler (index.js) and the
 * local dev server (scripts/local-server.js) — so it lives here once instead
 * of being copied into each.
 *
 * Transport-agnostic: the caller builds the Transport and owns transport.end()
 * (in a finally block). Every failure is reported to the client as an
 * {type:'error'} line — this function never throws.
 */

const { verifyAuth }       = require('./middleware/auth');
const { handleChatStream } = require('./handlers/chat');
const { parseRequest }     = require('./utils/request');

async function runChatRequest(transport, event) {

  // ── 1. Authenticate ────────────────────────────────────────────────────────
  let userId;
  let userEmail;
  try {
    const payload = await verifyAuth(event.headers);
    userId    = payload.sub;
    userEmail = payload.username ?? null;
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    return;
  }

  // ── 2. Parse + validate the request body ───────────────────────────────────
  let parsed;
  try {
    parsed = parseRequest(event);
  } catch (err) {
    transport.send({ type: 'error', message: err.message });
    return;
  }

  // ── 3. Stream the chat turn ────────────────────────────────────────────────
  try {
    await handleChatStream(transport, { ...parsed, userId, userEmail });
  } catch (err) {
    console.error('[runChatRequest] Unhandled error:', err);
    transport.send({ type: 'error', message: 'Internal server error' });
  }
}

module.exports = { runChatRequest };
