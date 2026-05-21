# Code Review — `chatbot-streaming-lambda`

A review of the whole repository against the project's `CLAUDE.md` rules. It has two
parts:

1. **Fixed in this pass** — the cleanup that was applied. Read it as a changelog.
2. **Remaining findings** — issues left for you to decide on, ranked by priority. Each
   one says *why* it was not auto-applied.

It ends with an annotated list of **sources** — the AWS blog, official docs, and SDK
references behind every part of this service, plus pointers for what is possible next.

For how the service actually works, read [`ARCHITECTURE.md`](../ARCHITECTURE.md) first.

---

## Part 1 — Fixed in this pass

### Dead WebSocket code removed

The repo described a WebSocket transport that did not exist. All of it is gone; the
real transport *abstraction* (`createTransport` + `FunctionUrlTransport`) was kept — it
is the genuine seam for adding WebSockets later.

- Deleted the commented-out `WebSocketTransport` stub from `src/utils/transport.js` and
  reworded that file's doc block to describe only what exists.
- Deleted `docs/WEBSOCKET.md` — a 228-line migration guide for unwritten code.
- `README.md` — removed the "WebSocket Migration" section, reworded the transport
  feature bullet, and corrected the project-structure listing.

### Complexity and duplication reduced

- **New `src/run-chat-request.js`.** The request lifecycle (verify auth → parse →
  stream) was copy-pasted into both `index.js` and `scripts/local-server.js`. It now
  lives in one file; both entry points are thin adapters around it.
- **Model resolution simplified.** `chat.js` had four interlocking variables and a
  hardcoded `Set` to decide which model runs. That is now one pure helper,
  `resolveModel()`, returning `{ override, recorded }`.
- **Model IDs consolidated into `config.js`.** The Anthropic and Gemini default model
  IDs were hardcoded inside the service files *and* in `chat.js`; the demo-model list
  was a `Set` in `chat.js`. All now live in `config.js` as the single source of truth.

### Bugs and correctness fixes

- **`userEmail` now reaches the handler in local dev.** `local-server.js` never
  forwarded `userEmail`, so the demo-model feature silently did nothing on a laptop.
  The shared lifecycle forwards it, so local and production behave the same.
- **Model-override gap closed (security).** Previously, sending `provider` *without* an
  `apiKey` let a client override the model on the default Bedrock path — contradicting
  the code's own comment ("Bedrock path — client cannot override"). `resolveModel()`
  now gates overrides on the BYOK `apiKey` only.
- **BYOK requests are validated.** `request.js` now rejects an `apiKey` request with a
  `400` unless `provider` is `"anthropic"` or `"gemini"`. Before, an unknown provider
  fell through to Bedrock and the user's key was silently ignored.
- **Provider-neutral error message.** A streaming failure reported `"Bedrock streaming
  failed"` even for Anthropic/Gemini errors — now `"Model streaming failed"`.
- **Dead fallback removed.** `saveAssistantMessage` had `modelId || config.bedrock.modelId`;
  `chat.js` always passes a concrete model id, so the `||` was unreachable.

### Readability ("so a junior can read it")

- Added a file-level doc block — *what it does, what it does NOT do, key runtime
  behaviour* — to the 7 files that lacked one: `config.js`, `handlers/chat.js`,
  `middleware/auth.js`, and `services/{bedrock,anthropic,gemini,dynamodb}.js`.
- `config.js` — `parseInt` → `Number.parseInt` so the file is internally consistent
  (it already used `Number.parseFloat`); added section headers.
- New top-level [`ARCHITECTURE.md`](../ARCHITECTURE.md) — a story-style walkthrough of
  the whole service.

---

## Part 2 — Remaining findings

Ranked High → Low. Nothing here was changed automatically; each entry explains why.

### High

**H1 — The IAM policy is out of sync with the code.**
*File:* `infra/lambda-iam-policy.json` · *Rules: 9, 15*

Two mismatches in one file:

- The `BedrockInvokeStreaming` statement (lines 11–14) allows only
  `anthropic.claude-3-5-sonnet-20241022-v2:0` model ARNs. But the default model in
  `config.js` is `us.amazon.nova-pro-v1:0`, and the demo allowlist adds
  `anthropic.claude-sonnet-4-6`. **With this policy attached, every default Bedrock
  request fails with AccessDenied in production.**
- The `CloudWatchLogs` resource (line 45) targets the log group
  `/aws/lambda/chatbot-streaming`, but the deployed function is `node-streaming-test`
  (see `.github/workflows/deploy.yml`). The grant points at the wrong log group.

*Recommendation:* update the Bedrock `Resource` list to the model(s) actually in use
(Nova Pro — note cross-region inference profiles need the foundation-model ARN in each
routed region), and fix the log-group name. *Deferred because* editing an IAM policy is
an infrastructure change that needs your confirmation of the exact models and regions
(Rule 15).

### Medium

**M1 — Unused exports in the data layer.**
*File:* `src/services/dynamodb.js` — `forkBranch`, `appendMsgToBranch`, `updateMessageState` · *Rule: 3*

These three functions are exported but never called anywhere in this repo — branch
forking and message editing are done by the separate `chatbot-fast-api-lambda` REST
API. *Recommendation:* decide intent. If `dynamodb.js` is meant to be a complete data
layer shared in spirit across repos, keep them and note it; otherwise delete them.
*Deferred because* "mention, don't delete" — removing part of the data layer is a
judgment call only you should make (Rule 3).

**M2 — Cross-repo hardcoded model list.**
*File:* `src/config.js` — `demoModels.bedrockModels` · *Rule: 23*

This list must be kept in sync by hand with `DEMO_BEDROCK_MODELS` in
`chatbot-app/shared/ai-config.ts`. Nothing enforces it — they can drift, and the server
would then reject a model the client offers. *Recommendation:* start a `BACKLOG.md` at
the repo root with an entry recording this cross-repo contract (Rule 23). *Deferred
because* creating a new doc was beyond the agreed scope.

**M3 — No Infrastructure-as-Code, no automated tests.**
*Rules: 4, 15*

The Lambda, Function URL, Cognito pool, and DynamoDB tables are all created by hand;
CI only checks that a few files exist. *Recommendation:* a SAM or CDK template would
make the environment reproducible and is a prerequisite for a real staging environment.
A small test suite around `parseRequest`, `resolveModel`, and the history-trimming
logic would catch regressions cheaply. *Deferred because* this is substantial new work,
outside a cleanup pass.

### Low

**L1 — BYOK providers read from the `bedrock` config namespace.**
*Files:* `src/services/anthropic.js`, `src/services/gemini.js` · *Rule: 7*

`maxTokens` and `systemPrompt` are shared by all three providers but live under
`config.bedrock`. Cosmetic. *Recommendation:* a `config.generation` group would read
better. *Left as-is* to avoid renaming the `BEDROCK_MAX_TOKENS` environment variable,
which would be a breaking deployment change.

**L2 — `zip-deploy.mjs` mutates the repo during deploy.**
*File:* `zip-deploy.mjs` · *Rule: 15*

It runs `npm install --omit=dev` in place, stripping devDependencies from the working
tree's `node_modules`. The GitHub Actions workflow does the same thing safely on a
fresh runner. *Recommendation:* prefer the CI workflow for real deploys; if the script
is kept, build the zip from a temp directory. *Deferred because* it is deploy tooling,
outside the cleanup scope.

### Notes — correct as-is (recorded so they are not "fixed" by mistake)

**N1 — Per-request SDK clients are intentional.** `anthropic.js` and `gemini.js`
create a fresh SDK client on every request. This is **correct**: a BYOK client is bound
to one user's API key and must never be reused across users. Do not convert these to
singletons. (`bedrock.js` and `dynamodb.js` *are* singletons — safe, because they
authenticate with the Lambda's own IAM role, not a per-user key.)

**N2 — The token estimate is deliberately rough.** `getActiveHistoryForBranch`
estimates ~4 characters per token to trim history to a budget. It is not used for
billing, and the imprecision is fine for fitting a context window.

---

## Sources & further reading

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
- **[DynamoDB — TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)** — the all-or-nothing write used to save a message and append it to its branch together.
- **[DynamoDB — Transactions: how it works](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)** — when to reach for a transaction and the limits (100 items, 4 MB).
- **[DynamoDB — BatchGetItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html)** — used by `getActiveHistoryForBranch`. Important: it returns items in **no guaranteed order** (which is why the code re-sorts) and caps at 100 items / 16 MB.
- **[NDJSON specification](https://github.com/ndjson/ndjson-spec)** — the "one JSON object per line" wire format. Confirms the `application/x-ndjson` media type used by the transport.

### Exploring what's possible next

- **[API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)** — the natural next step if you want the server to *push* to the client (true bidirectional chat). Explains the `$connect` / `$disconnect` / `$default` routes a future WebSocket transport would need.
- **[WebSocket APIs — overview](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html)** — how routing and integrations work, useful for sizing that future migration.
- **[DynamoDB — Time to Live (TTL)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)** — a cheap way to auto-expire old sessions, branches, and messages so the tables do not grow forever. Not used today.

> Tip: when you do start the WebSocket work, recreate a fresh migration guide from the
> current code — the old `docs/WEBSOCKET.md` was removed because it described a stub
> that drifted from reality. A guide written against code that exists stays honest.
