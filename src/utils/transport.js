'use strict';

/**
 * Transport abstraction layer.
 *
 * Decouples streaming logic from the wire protocol. To migrate to WebSocket,
 * implement WebSocketTransport and update src/index.js — zero changes to
 * handlers, services, or DB code.
 */

// ─── Function URL transport ──────────────────────────────────────────────────

class FunctionUrlTransport {
  constructor(responseStream) {
    this._stream = responseStream;
  }

  send(payload) {
    this._stream.write(JSON.stringify(payload) + '\n');
  }

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

function createTransport(mode, { responseStream } = {}) {
  if (mode === 'functionUrl') {
    return new FunctionUrlTransport(responseStream);
  }
  throw new Error(`Unknown transport mode: ${mode}`);
}

module.exports = { createTransport, FunctionUrlTransport };
