# WebSocket Migration Guide

The codebase is designed so that switching from Lambda Function URL streaming to API Gateway WebSocket requires changes to **only the transport layer and entry point** — all business logic, AI providers, and database code are untouched.

---

## Why it's easy: the transport abstraction

`src/utils/transport.js` is the only file that knows how bytes reach the client. Every other layer calls `transport.send(payload)` and `transport.end()` — no knowledge of HTTP, WebSocket, or Lambda internals leaks through.

```
┌─────────────────────────────────────────────────────┐
│  src/handlers/chat.js                               │
│    transport.send({ type: 'delta', text: '...' })   │  ← same call regardless of transport
│    transport.send({ type: 'done', ... })             │
│    transport.end()                                   │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
FunctionUrlTransport        WebSocketTransport   (uncomment to activate)
writes to responseStream    calls postToConnection
```

---

## Files that change vs. files that stay

| File | Status | What happens |
|---|---|---|
| `src/utils/transport.js` | **Changes** | Uncomment `WebSocketTransport`; update factory |
| `src/index.js` | **Changes** | Replace single streaming handler with `$connect` / `$disconnect` / `$default` |
| `infra/node-streaming-test.yaml` | **Changes** | Add API Gateway WebSocket resource |
| `src/handlers/chat.js` | Unchanged | Zero edits — calls `transport.send()` only |
| `src/services/bedrock.js` | Unchanged | |
| `src/services/anthropic.js` | Unchanged | |
| `src/services/gemini.js` | Unchanged | |
| `src/services/dynamodb.js` | Unchanged | |
| `src/middleware/auth.js` | Unchanged | |
| `src/config.js` | Unchanged | |

---

## Step-by-step

### Step 1 — Uncomment `WebSocketTransport` in `src/utils/transport.js`

The skeleton is already there. Uncomment it and wire the factory:

```js
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

class WebSocketTransport {
  constructor(apiGwClient, connectionId) {
    this._client = apiGwClient;
    this._connectionId = connectionId;
  }

  async send(payload) {
    await this._client.send(new PostToConnectionCommand({
      ConnectionId: this._connectionId,
      Data: Buffer.from(JSON.stringify(payload)),
    }));
  }

  end() {
    // WebSocket disconnect is managed separately — nothing to do here
  }
}
```

Update `createTransport` to activate it:

```js
function createTransport(mode, options = {}) {
  if (mode === 'functionUrl') return new FunctionUrlTransport(options.responseStream);
  if (mode === 'websocket')   return new WebSocketTransport(options.apiGwClient, options.connectionId);
  throw new Error(`Unknown transport mode: ${mode}`);
}
```

Also export it: `module.exports = { createTransport, FunctionUrlTransport, WebSocketTransport };`

---

### Step 2 — Replace `src/index.js` with three route handlers

API Gateway WebSocket routes messages to three Lambda functions (or three exports of the same function):

```js
'use strict';

const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');
const { verifyAuth }       = require('./middleware/auth');
const { handleChatStream } = require('./handlers/chat');
const { createTransport }  = require('./utils/transport');
const { parseRequest }     = require('./utils/request');

// $connect — called when the client opens the WebSocket
// Auth happens here; Cognito token passed as a query string param
// because WebSocket upgrade requests cannot carry a custom Authorization header.
exports.connect = async (event) => {
  try {
    // Token arrives as ?token=<jwt> in the query string during the upgrade handshake
    const token = event.queryStringParameters?.token;
    await verifyAuth({ authorization: `Bearer ${token}` });
    return { statusCode: 200 };
  } catch {
    return { statusCode: 401 };
  }
};

// $disconnect — called when the client closes the connection
exports.disconnect = async () => ({ statusCode: 200 });

// $default — called for every message the client sends after connecting
exports.message = async (event) => {
  const { connectionId, domainName, stage } = event.requestContext;

  const apiGwClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  const transport = createTransport('websocket', { apiGwClient, connectionId });

  let parsed;
  try {
    parsed = parseRequest({ body: event.body, isBase64Encoded: false });
  } catch (err) {
    await transport.send({ type: 'error', message: err.message });
    return { statusCode: 400 };
  }

  // userId must come from the $connect stage or a DynamoDB connection store
  // (WebSocket messages don't carry auth headers after the initial handshake)
  const userId = event.requestContext.authorizer?.userId ?? 'unknown';

  try {
    await handleChatStream(transport, { ...parsed, userId });
  } catch (err) {
    console.error('[ws handler] Unhandled error:', err.message);
    await transport.send({ type: 'error', message: 'Internal server error' });
  }

  return { statusCode: 200 };
};
```

> **Auth note:** WebSocket clients cannot set custom headers after the initial HTTP upgrade. The standard pattern is to pass the JWT as a query parameter (`wss://your-api.execute-api.us-east-1.amazonaws.com/prod?token=<jwt>`) and validate it in `$connect`. If you need the `userId` in `$default`, store it in DynamoDB keyed by `connectionId` during `$connect` and look it up in `$default`.

---

### Step 3 — Add the API Gateway WebSocket API to `infra/node-streaming-test.yaml`

```yaml
ChatWebSocketApi:
  Type: AWS::ApiGatewayV2::Api
  Properties:
    Name: ChatWebSocket
    ProtocolType: WEBSOCKET
    RouteSelectionExpression: "$request.body.action"

ConnectRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref ChatWebSocketApi
    RouteKey: $connect
    AuthorizationType: NONE
    Target: !Sub "integrations/${ConnectIntegration}"

DisconnectRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref ChatWebSocketApi
    RouteKey: $disconnect
    AuthorizationType: NONE
    Target: !Sub "integrations/${DisconnectIntegration}"

DefaultRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref ChatWebSocketApi
    RouteKey: $default
    AuthorizationType: NONE
    Target: !Sub "integrations/${DefaultIntegration}"
```

You also need `AWS::ApiGatewayV2::Integration` resources for each route pointing at the Lambda function, and an `AWS::ApiGatewayV2::Stage` for deployment.

---

### Step 4 — Add the SDK dependency

```bash
npm install @aws-sdk/client-apigatewaymanagementapi
```

---

## Wire format: nothing changes

The same NDJSON message objects are sent over the WebSocket connection:

```json
{"type":"metadata","sessionId":"...","branchId":"..."}
{"type":"userMessage","msgId":"..."}
{"type":"delta","text":"Hello"}
{"type":"delta","text":", world"}
{"type":"done","msgId":"...","state":"active","inputTokens":42,"outputTokens":17}
```

The frontend switches from `fetch` + `ReadableStream` parsing to `new WebSocket(url)` + `socket.onmessage`, but the JSON parsing logic is identical.

---

## Frontend connection example

```js
// Current (Function URL streaming)
const res = await fetch(LAMBDA_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
for await (const line of parseNdjson(res.body)) { handle(line); }

// WebSocket equivalent
const socket = new WebSocket(`wss://your-api.execute-api.us-east-1.amazonaws.com/prod?token=${token}`);
socket.onopen  = () => socket.send(JSON.stringify(payload));
socket.onmessage = (e) => handle(JSON.parse(e.data));
```
