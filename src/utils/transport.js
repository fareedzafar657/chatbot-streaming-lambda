'use strict';

/**
 * Transport abstraction layer.
 *
 * The streaming Lambda uses this instead of writing to responseStream directly.
 * To migrate to WebSocket, swap in the WebSocketTransport below and update
 * the handler to pass the connectionId — zero Bedrock/DB logic changes needed.
 *
 * Wire format: newline-delimited JSON (NDJSON), compatible with the
 * EventSource / fetch ReadableStream approach on the frontend.
 *
 * Each line is:
 *   {"type":"delta","text":"..."}          — token chunk
 *   {"type":"metadata","msgId":"...","sessionId":"...","branchId":"..."} — IDs up front
 *   {"type":"done","inputTokens":N,"outputTokens":N}  — stream end
 *   {"type":"error","message":"..."}       — error
 */

// ─── Function URL transport ──────────────────────────────────────────────────

class FunctionUrlTransport {
  constructor(responseStream) {
    this._stream = responseStream;
  }

  /** Send a JSON line to the client. */
  send(payload) {
    this._stream.write(JSON.stringify(payload) + '\n');
  }

  /** Close the response stream. */
  end() {
    this._stream.end();
  }
}

// ─── WebSocket transport (for future migration) ──────────────────────────────
//
// class WebSocketTransport {
//   constructor(apiGwClient, connectionId) {
//     this._client = apiGwClient;
//     this._connectionId = connectionId;
//   }
//
//   async send(payload) {
//     await this._client.postToConnection({
//       ConnectionId: this._connectionId,
//       Data: JSON.stringify(payload),
//     });
//   }
//
//   end() { /* WebSocket disconnect handled separately */ }
// }

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the right transport based on current mode.
 * Currently only 'functionUrl' is active.
 */
function createTransport(mode, { responseStream } = {}) {
  if (mode === 'functionUrl') {
    return new FunctionUrlTransport(responseStream);
  }
  // Future: if (mode === 'websocket') return new WebSocketTransport(...)
  throw new Error(`Unknown transport mode: ${mode}`);
}

module.exports = { createTransport, FunctionUrlTransport };