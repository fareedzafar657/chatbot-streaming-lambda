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
 * send: (payload) => void — caller owns the stream lifetime (open before call,
 * closed in a finally after). Every failure is reported to the client as a
 * {type:'error'} line — this function never throws.
 */

const { verifyAuth, extractEmail } = require('./middleware/auth');
const { handleChatStream }         = require('./handlers/chat');
const { parseRequest }             = require('./utils/request');

async function runChatRequest(send, event) {

  // ── 1. Authenticate ────────────────────────────────────────────────────────
  let userId;
  let userEmail;
  try {
    const payload = await verifyAuth(event.headers); // verify access token
    userId    = payload.sub;
    userEmail = await extractEmail(event.headers);  // verify id token
  } catch {
    send({ type: 'error', message: 'Unauthorized' });
    return;
  }

  // ── 2. Parse + validate the request body ───────────────────────────────────
  let parsed;
  try {
    parsed = parseRequest(event);
  } catch (err) {
    send({ type: 'error', message: err.message });
    return;
  }

  // ── 3. Stream the chat turn ────────────────────────────────────────────────
  try {
    await handleChatStream(send, { ...parsed, userId, userEmail });
  } catch (err) {
    console.error('[runChatRequest] Unhandled error:', err);
    send({ type: 'error', message: 'Internal server error' });
  }
}

module.exports = { runChatRequest };
