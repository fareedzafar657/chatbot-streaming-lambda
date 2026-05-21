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
│   Wraps the AWS response stream in a Transport, then hands off.        │
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
It wraps that object in a `Transport` (see section 5) and immediately delegates — it
contains no business logic of its own.

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
| 1 | `src/index.js` | The AWS Lambda entry point. Wires the streaming response into a `Transport`, then calls the shared lifecycle. Adapter only — no logic. |
| 2 | `src/run-chat-request.js` | The request lifecycle: verify auth → parse body → run the chat turn. Shared by the Lambda and the local dev server. |
| 3 | `src/middleware/auth.js` | Verifies the Cognito JWT. Returns the user's identity, or throws a 401. |
| 4 | `src/utils/request.js` | Parses and validates the request body. Defines the request shape every other file relies on. |
| 5 | `src/handlers/chat.js` | The chat turn orchestrator — the heart. Resolves the model, saves messages, streams the reply. |
| 6 | `src/services/bedrock.js` | Streams from AWS Bedrock — the **default** AI provider. |
| 7 | `src/services/anthropic.js` | Streams from Anthropic, when the user brings their own key (BYOK). |
| 8 | `src/services/gemini.js` | Streams from Google Gemini, when the user brings their own key (BYOK). |
| 9 | `src/services/dynamodb.js` | The data layer. Sessions, branches, messages — every DB read and write. |
| 10 | `src/utils/transport.js` | The wire-protocol abstraction. Today: `FunctionUrlTransport`. |
| 11 | `src/config.js` | Every tunable in one place. Read once at startup; fails fast on missing secrets. |
| — | `scripts/local-server.js` | A plain HTTP server that runs the exact same lifecycle on your laptop. |

Every one of these files starts with a doc block that says what it does and what it
deliberately does *not* do — so the file itself is the most up-to-date description.

---

## 4. The data model — branching conversations

The interesting part of the database is that conversations **branch**. Three tables:

| Table | One row is… | Points at |
|---|---|---|
| `chatbot_sessions` | one conversation | its currently-active branch |
| `chatbot_branches` | one path through the conversation | an **ordered list** of message IDs |
| `chatbot_messages` | one user or assistant message | — |

A **branch** is just an ordered list of message IDs (`selectedMsgIds`). "Forking" a
conversation — to retry an answer or explore a different direction — creates a new
branch with its own list, leaving the original untouched. This streaming service only
ever *reads* branches and *appends* to the active one; creating and editing branches is
the job of the separate `chatbot-fast-api-lambda` REST API.

Two details worth knowing:

- **Atomic writes.** Saving a message and appending its ID to a branch must both
  happen or neither — so they go in a single DynamoDB `TransactWrite`.
- **History trimming.** A long conversation will not fit in a model's context window.
  `getActiveHistoryForBranch` keeps only the most recent messages, within both a
  message-count cap and an *approximate* token budget (it estimates ~4 characters per
  token — fine for trimming, not used for billing).

The full schema and the AWS CLI commands to create the tables are in
[`infra/dynamodb-schema.md`](./infra/dynamodb-schema.md).

---

## 5. Key design decisions

**Why a `Transport` abstraction?**
`chat.js` and the services never touch the response stream directly — they only call
`transport.send()` and `transport.end()`. All knowledge of *how bytes reach the client*
lives in `utils/transport.js`. Today there is one transport (`FunctionUrlTransport`).
Adding another wire protocol later means writing one more class and teaching the
factory about it — no changes to handlers, services, or the database layer.

**Why three AI providers behind one handler?**
Bedrock is the **default** and uses the Lambda's own AWS permissions. A user can
instead "bring their own key" (BYOK) for Anthropic or Gemini by sending an `apiKey` +
`provider`. Each provider lives in its own service file but exposes the *same* async
generator shape, so `chat.js` routes to one of three functions and otherwise treats
them identically.

**Why can't the client pick any model?**
On the default Bedrock path the model is fixed by `config.js` — a client cannot make
the service spend money on an expensive model. The two exceptions are explicit: a BYOK
caller may choose their own model (their key, their cost), and a small allowlist of
"demo" users may pick from `config.demoModels`. All of this lives in one place —
`resolveModel()` at the top of `chat.js`.

**Why does `config.js` throw on startup?**
If a required secret (a Cognito ID) is missing, the function fails *immediately* on
cold start with a clear message — instead of limping along and failing confusingly
halfway through a real user's request. Fail fast, fail loud.

**Why one shared lifecycle file?**
The Lambda (`index.js`) and the local dev server (`local-server.js`) must behave
identically. If the "auth → parse → stream" sequence were copied into both, they would
drift apart. `run-chat-request.js` is the single copy; both entry points call it.

---

## 6. Running it — Lambda vs. your laptop

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
with `node scripts/local-server.js` (see the [README](./README.md) for setup).

---

## 7. What this service deliberately does NOT do

Knowing the boundaries is as important as knowing the contents:

- **It does not manage branches or edit messages.** Forking, editing, deleting — that
  is the `chatbot-fast-api-lambda` REST API. This service only appends to the active
  branch.
- **It does not render anything.** The UI is the `chatbot-app` Next.js frontend.
- **It does not handle CORS in code.** The Lambda Function URL configuration does that
  in production; the local server sets CORS headers itself.
- **It does not provision infrastructure.** Tables, the Lambda, and Cognito are created
  manually today — see [`docs/CODE-REVIEW.md`](./docs/CODE-REVIEW.md) for the gap.

---

## 8. Further reading

A full, annotated list of the AWS blog post, official docs, and SDK references behind
every design choice here — plus pointers for *what is possible next* (WebSockets,
auto-expiring sessions) — is in **[`docs/CODE-REVIEW.md` → Sources & further
reading](./docs/CODE-REVIEW.md#sources--further-reading)**.

Start with the AWS blog *Serverless strategies for streaming LLM responses* — it is the
pattern this entire service is built on.
