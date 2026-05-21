'use strict';

/**
 * Transport abstraction layer.
 *
 * Decouples streaming logic from the wire protocol. The chat handler and every
 * service only ever call transport.send() and transport.end() — they never
 * touch the response stream directly. A new wire protocol is added by writing
 * one more Transport class and teaching the factory below about it; no changes
 * to handlers, services, or DB code.
 *
 * Today there is exactly one transport: FunctionUrlTransport (Lambda Function
 * URL response streaming).
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

// ─── Factory ─────────────────────────────────────────────────────────────────

function createTransport(mode, { responseStream } = {}) {
  if (mode === 'functionUrl') {
    return new FunctionUrlTransport(responseStream);
  }
  throw new Error(`Unknown transport mode: ${mode}`);
}

module.exports = { createTransport, FunctionUrlTransport };
