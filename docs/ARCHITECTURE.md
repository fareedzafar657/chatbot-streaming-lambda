# Architecture — `chatbot-streaming-lambda`

This service has **one job**: take a chat message, ask an AI model, and stream the
answer back word-by-word. It runs as a single AWS Lambda function and saves every
message to DynamoDB so conversations have history.

Read this file top to bottom and you will understand the whole service. Each section
builds on the last — it is meant to be read like a story. No prior knowledge of this
codebase is assumed.

---

## 1. The 30-second version

A user types a message in the chat app. The app sends it here. This service then:

1. **checks** the user is who they say they are (a Cognito login token),
2. **saves** the user's message to the database,
3. **loads** the earlier messages in that conversation,
4. **asks** an AI model and **streams** the reply back token by token,
5. **saves** the AI's finished reply.

The reply travels back as **NDJSON** — one JSON object per line — so the browser can
show each word the moment it arrives, instead of waiting for the whole answer. That
"answer appears as it's typed" effect is the entire reason this service exists.

---

## 2. The journey of one request

Everything below is one request flowing through the system, top to bottom:

```
   Browser  (the chatbot-app frontend)
      │
      │  POST /   body: { prompt, sessionId, branchId?, apiKey?, provider?, model? }
      │           header: Authorization: Bearer <Cognito access token>
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ src/index.js              THE LAMBDA ADAPTER                          │
│   Wraps the AWS response stream in a send() helper, then hands off.   │
│   (The local dev server, scripts/local-server.js, is the same idea    │
│    for an ordinary HTTP server — see section 6.)                       │
├──────────────────────────────────────────────────────────────────────┤
│ src/run-chat-request.js   THE REQUEST LIFECYCLE                        │
│   1. verify auth ........ middleware/auth.js   (is this a real user?)  │
│   2. parse + validate ... utils/request.js     (is the body sane?)     │
│   3. run the chat turn .. handlers/chat.js                             │
├──────────────────────────────────────────────────────────────────────┤
│ src/handlers/chat.js      THE CHAT TURN ORCHESTRATOR                   │
│                                                                        │
│   getOrCreateSession ─┐                                                │
│   saveUserMessage     ├──►  services/dynamodb.js   (the database)      │
│   getActiveHistory ───┘                                                │
│                                                                        │
│   stream the reply ──────►  services/bedrock.js    (default provider)  │
│                             services/anthropic.js  (BYOK)              │
│                             services/gemini.js     (BYOK)              │
│                                                                        │
│   saveAssistantMessage ──►  services/dynamodb.js                       │
└──────────────────────────────────────────────────────────────────────┘
      │
      │  NDJSON stream, one line at a time:
      │     {"type":"metadata",    ...}   ← session/branch/model IDs
      │     {"type":"userMessage", ...}   ← the saved user message ID
      │     {"type":"delta","text":"Hel"} ← a chunk of the answer
      │     {"type":"delta","text":"lo"}  ← ...and another, and another
      │     {"type":"done",        ...}   ← final message ID + token counts
      ▼
   Browser renders each token the instant it arrives.
```

### Walking through it in words

**The browser** sends a single `POST /` with the user's prompt and a Cognito access
token. `sessionId` identifies the conversation; everything else is optional.

**`index.js`** is only an *adapter*. AWS hands it a special streaming response object.
It creates an inline `send` helper that writes one NDJSON line at a time, then
immediately delegates — it contains no business logic of its own.

**`run-chat-request.js`** is the lifecycle every request follows, no matter how it
arrived. It does three things in order and stops at the first failure:

- **verify auth** — `middleware/auth.js` checks the Bearer token against the Cognito
  User Pool. A bad or missing token ends the request with an `error` line.
- **parse the body** — `utils/request.js` validates the JSON: a prompt is required, it
  has a length cap, and if the caller sent their own `apiKey` they must also say which
  `provider` it belongs to.
- **run the chat turn** — hand the validated request to `handlers/chat.js`.

**`handlers/chat.js`** is the heart of the service. For one turn it:

1. resolves the **session** and **branch** (and refuses a branch that belongs to
   someone else),
2. decides **which model** runs (see section 5 — clients cannot freely pick the model),
3. sends a `metadata` line so the browser knows the IDs straight away,
4. **saves the user message** and sends a `userMessage` line,
5. **loads recent history** for the branch, trimmed to fit the model's context,
6. **streams the model's reply**, forwarding every chunk as a `delta` line,
7. **saves the assistant message** and sends the closing `done` line with token counts.

**The services** are thin adapters around the outside world. `bedrock`, `anthropic`,
and `gemini` each speak to one AI API but expose the *same* shape — an async generator
yielding `{type:'delta'|'done'|'error'}` — so `chat.js` treats them identically.
`dynamodb.js` is the only file that reads or writes the database.

---

## 3. Meet the files (in reading order)

The fastest way to learn the codebase is to open these files in this order — it is the
same order a request travels through them.

| # | File | Its job in one breath |
|---|---|---|
| 1 | `src/index.js` | The AWS Lambda entry point. Creates an inline `send` helper from the streaming response, then calls the shared lifecycle. Adapter only — no logic. |
| 2 | `src/run-chat-request.js` | The request lifecycle: verify auth → parse body → run the chat turn. Shared by the Lambda and the local dev server. |
| 3 | `src/middleware/auth.js` | Verifies the Cognito access token (`verifyAuth`) and extracts the user's email from the ID token (`extractEmail`, used for demo-model gating). |
| 4 | `src/utils/request.js` | Parses and validates the request body. Defines the request shape every other file relies on. |
| 5 | `src/handlers/chat.js` | The chat turn orchestrator — the heart. Resolves the model, saves messages, streams the reply. |
| 6 | `src/services/bedrock.js` | Streams from AWS Bedrock — the **default** AI provider. |
| 7 | `src/services/anthropic.js` | Streams from Anthropic, when the user brings their own key (BYOK). |
| 8 | `src/services/gemini.js` | Streams from Google Gemini, when the user brings their own key (BYOK). |
| 9 | `src/services/dynamodb.js` | The data layer. Sessions, branches, messages — every DB read and write. History is loaded via the `branchId-createdAt-index` GSI. |
| 10 | `src/config.js` | Every tunable in one place. Read once at startup; fails fast on missing secrets. |
| — | `scripts/local-server.js` | A plain HTTP server that runs the exact same lifecycle on your laptop. |

Every one of these files starts with a doc block that says what it does and what it
deliberately does *not* do — so the file itself is the most up-to-date description.

---

## 4. The data model — branching conversations

The interesting part of the database is that conversations **branch**. Three tables:

| Table | One row is… | Owns / points at |
|---|---|---|
| `chatbot_sessions` | one conversation | its currently-active branch |
| `chatbot_branches` | one branch within a session | metadata only — no message list |
| `chatbot_messages` | one user or assistant message | the **one** branch it belongs to (`branchId`) |

The key fact: **every message row belongs to exactly one branch via its `branchId`
field.** Forking does **not** share messages by reference — it *duplicates* them. When
the REST API creates a fork, it reads the selected parent messages and writes brand-new
rows (new `msgId`s) tagged with the new `branchId`. Ordering is by `createdAt`,
enforced by the `branchId-createdAt-index` GSI — there is no separate list of IDs on
the branch row.

This streaming service only ever *appends* to the active branch — one `PutItem` per
message. Creating branches, editing messages, and cherry-picking are the job of the
separate `chatbot-fast-api-lambda` REST API.

Two details worth knowing:

- **Simple writes.** Each message is saved with a plain `PutItem` — no transaction
  needed, because the message itself carries its `branchId` and `createdAt`.
- **History trimming.** A long conversation will not fit in a model's context window.
  `getActiveHistoryForBranch` queries the GSI (ordered ascending by `createdAt`), then
  keeps only the most recent messages within both a message-count cap and an
  *approximate* token budget (it estimates ~4 characters per token — fine for trimming,
  not used for billing).

The full schema and the AWS CLI commands to create the tables are in
[`infra/dynamodb-schema.md`](../infra/dynamodb-schema.md).

---

## 5. Running it — Lambda vs. your laptop

The service runs in two places, and they share all the real logic:

| | Production | Local development |
|---|---|---|
| Entry point | `src/index.js` | `scripts/local-server.js` |
| Triggered by | AWS Lambda Function URL | Node's built-in `http` server |
| Streaming | `awslambda.streamifyResponse` | a plain HTTP response |
| Shared core | `run-chat-request.js` → `chat.js` → services | *(identical)* |

The local server builds a Lambda-style event from the raw HTTP request and calls the
*same* `runChatRequest`. So the request shape and the NDJSON stream you see on
`http://localhost:4000` are exactly what the deployed Function URL produces. Start it
with `node scripts/local-server.js` (see the [README](../README.md) for setup).

---

## 6. What this service deliberately does NOT do

Knowing the boundaries is as important as knowing the contents:

- **It does not manage branches or edit messages.** Forking, editing, deleting — that
  is the `chatbot-fast-api-lambda` REST API. This service only appends to the active
  branch.
- **It does not render anything.** The UI is the `chatbot-app` Next.js frontend.
- **It does not handle CORS in code.** The Lambda Function URL configuration does that
  in production; the local server sets CORS headers itself.

---

## 8. Sources & further reading

Every link below was checked while writing this review. Read them to understand *why*
the service is built the way it is — and what it could become next.

### Understanding the current design

- **[Serverless strategies for streaming LLM responses](https://aws.amazon.com/blogs/compute/serverless-strategies-for-streaming-llm-responses/)** — the AWS blog post this entire service is modelled on. Start here: it compares Lambda Function URL streaming, API Gateway, and AppSync for streaming LLM output, and explains the trade-offs.
- **[Response streaming for Lambda functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)** — why streaming exists: faster time-to-first-byte and a 200 MB response cap (vs. 6 MB buffered). The behaviour behind `index.js`.
- **[Writing response streaming-enabled functions](https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html)** — the `awslambda.streamifyResponse()` and `HttpResponseStream` APIs used in `src/index.js`.
- **[Creating and managing Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)** — the HTTPS endpoint and CORS configuration this service is invoked through.
- **[Amazon Bedrock — ConverseStream API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)** — the streaming call in `services/bedrock.js`. Note: it requires the `bedrock:InvokeModelWithResponseStream` permission — directly relevant to finding **H1**.
- **[Amazon Bedrock — Converse API guide](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)** — one message format that works across all Bedrock models; explains the `messages` / `system` / `inferenceConfig` shape.
- **[aws-jwt-verify](https://github.com/awslabs/aws-jwt-verify)** — the official AWS library used in `middleware/auth.js`. Explains the `CognitoJwtVerifier`, JWK caching, and why the verifier is a singleton.
- **[Amazon Cognito — Understanding the access token](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)** — what the Bearer token contains (`sub`, `username`) and its default 1-hour lifetime.
- **[Amazon Cognito — Verifying a JWT](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)** — the verification steps `aws-jwt-verify` performs for you.
- **[Anthropic — Streaming messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming)** — the streaming event model behind `services/anthropic.js`.
- **[Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)** — see `helpers.md` for `messages.stream()` and `finalMessage()`, the exact calls in `services/anthropic.js`.
- **[Google Gen AI JS SDK (`@google/genai`)](https://github.com/googleapis/js-genai)** — the SDK behind `services/gemini.js`; `generateContentStream` and the `usageMetadata` quirk are documented here.
- **[Gemini API — Generating content](https://ai.google.dev/api/generate-content)** — the `contents` / `role: "model"` format and streaming responses.
- **[DynamoDB — Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)** — used by `getActiveHistoryForBranch` to fetch all active messages for a branch, ordered ascending by `createdAt` via the `branchId-createdAt-index` GSI.
- **[DynamoDB — Global Secondary Indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)** — explains how the `branchId-createdAt-index` GSI enables efficient, ordered history queries without scanning the full messages table.
- **[NDJSON specification](https://github.com/ndjson/ndjson-spec)** — the "one JSON object per line" wire format. Confirms the `application/x-ndjson` media type used by the transport.

### Exploring what's possible next

- **[API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)** — the natural next step if you want the server to *push* to the client (true bidirectional chat). Explains the `$connect` / `$disconnect` / `$default` routes a future WebSocket transport would need.
- **[WebSocket APIs — overview](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html)** — how routing and integrations work, useful for sizing that future migration.
- **[DynamoDB — Time to Live (TTL)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)** — a cheap way to auto-expire old sessions, branches, and messages so the tables do not grow forever. Not used today.