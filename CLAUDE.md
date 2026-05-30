## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

---

## Project: chatbot-streaming-lambda

An AWS Lambda that streams LLM chat responses token-by-token as NDJSON over a Function
URL. Default provider is AWS Bedrock; users may bring their own key (BYOK) for Anthropic
or Gemini. Conversation history — with branching — is stored in DynamoDB.

- **Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) first** — the full
  request-lifecycle and file-by-file walkthrough.
- **Known gaps / deferred issues** are in [docs/CODE-REVIEW.md](./docs/CODE-REVIEW.md) —
  check it before "fixing" something; some items were deferred on purpose.
- The repo-wide Agent Rules in the parent `CLAUDE.md` also apply.

### Structure

```
src/
  index.js             Lambda entry point — adapter only, no business logic
  run-chat-request.js  Shared lifecycle: verify auth → parse → stream
  config.js            Single source of truth for every tunable
  handlers/chat.js     Chat turn orchestrator (the heart)
  services/
    bedrock.js         AWS Bedrock streaming — default provider
    anthropic.js       Anthropic streaming — BYOK
    gemini.js          Google Gemini streaming — BYOK
    dynamodb.js        Data layer — sessions, branches, messages
  middleware/auth.js   Cognito JWT verification
  utils/
    request.js         Request body parsing + validation
scripts/local-server.js  Local HTTP dev server — same lifecycle, no AWS
infra/                   Reference only: DynamoDB schema (no IaC, no in-repo IAM policy)
docs/                    ARCHITECTURE.md + CODE-REVIEW.md
.github/workflows/       CI: test + deploy to the Lambda
```

### Stack

Node.js 22 · AWS Lambda with Function URL response streaming · CommonJS · NDJSON wire
format. Runtime deps: AWS SDK v3 (Bedrock, DynamoDB), `@anthropic-ai/sdk`,
`@google/genai`, `aws-jwt-verify`. `dotenv` is dev-only. No build step, no bundler.

### Conventions future code MUST follow

Project-specific — match them exactly, on top of the global Agent Rules:

1. **CommonJS + `'use strict';`** — `require` / `module.exports`. No ESM in `src/`.
2. **File-level doc block on every file** — what it does, what it does NOT do (and
   where that lives instead), key runtime behaviour. Copy the format from any existing
   file.
3. **Section comments** — label each logical region with `// ─── Label ───`.
4. **Never write to the response stream directly from handlers or services.** They only
   call the `send(payload)` function passed in. Entry points (`index.js`,
   `local-server.js`) own the stream lifetime — they create `send` and call `.end()`.
5. **One uniform provider shape.** Each provider service is an async generator that
   yields `{ type: 'delta' | 'done' | 'error' }`. A new provider MUST match this shape
   so `chat.js` does not change.
6. **Services own all outside I/O.** Only `services/` calls AWS / AI SDKs; only
   `dynamodb.js` touches the database. Do not scatter SDK calls into handlers or utils.
7. **`config.js` is the only home for tunables.** No hardcoded model IDs, table names,
   limits, or magic numbers anywhere else — add them to `config.js`.
8. **Client lifetime depends on auth type.** The Bedrock and DynamoDB clients are
   module-level singletons (Lambda IAM auth — safe to reuse). BYOK clients (Anthropic,
   Gemini) are created per request and MUST NOT become singletons — each is bound to
   one user's API key.
9. **Do not duplicate the lifecycle.** Auth → parse → stream lives once in
   `run-chat-request.js`; entry points (`index.js`, `local-server.js`) stay thin.
10. **Errors: generic out, detailed in.** Send the client a short
    `{ type:'error', message }`; log full detail with `console.error` only. Never leak
    SDK/AWS errors, API keys, table names, or stack traces to the client.
11. **Simple message writes.** Each message is saved with a plain `PutItem` — the
    `branchId` and `createdAt` on the message row are the source of truth for ownership
    and order. No branch-level array to maintain.
12. **Model choice is locked on the Bedrock path** — the client cannot pick the model
    (cost control). Keep that invariant inside `resolveModel()`. Validate all request
    input at the boundary in `request.js`; treat it as untrusted.

### Running & verifying

```
npm install
node scripts/local-server.js     # local dev server → http://localhost:4000 (needs .env)

# quick module load check (loads .env so config.js fail-fast passes):
node -r dotenv/config -e "require('./src/run-chat-request.js'); console.log('ok')"
```

There is **no automated test suite and no npm scripts** yet (see CODE-REVIEW.md, M3).
After any code change: confirm modules load, confirm the local server boots, then run
`graphify update .`.

### Deployment

- **CI (preferred):** pushing to `dev` or `main` runs `.github/workflows/deploy.yml`,
  which zips `src/` + production `node_modules` and updates the `node-streaming-test`
  Lambda function.
- **Manual:** `node zip-deploy.mjs` — note it mutates local `node_modules`
  (CODE-REVIEW.md, L2); prefer CI.
- Lambda environment variables are managed in the AWS console, not by CI — see
  `.env.example` for the full list.
- Never run destructive AWS commands (deleting a table, etc.) without explicit
  confirmation.

### Boundaries — what this repo does NOT do

- **Branch / message management** (fork, edit, delete) → the `chatbot-fast-api-lambda`
  REST API. This service only appends to the active branch.
- **The chat UI** → the `chatbot-app` Next.js frontend.
- **Infrastructure provisioning** → manual today; `infra/` holds only reference material.

### Keep in sync across repos

`config.demoModels.bedrockModels` must match `DEMO_BEDROCK_MODELS` in
`chatbot-app/shared/ai-config.ts`. Change one → change the other.
