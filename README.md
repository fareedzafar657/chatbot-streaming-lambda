# chatbot-streaming-lambda

> An AWS Lambda streaming backend for the K-AI chat platform. Supports real-time token streaming via NDJSON, multi-provider AI (AWS Bedrock, Anthropic, Gemini), and branching conversation history backed by DynamoDB.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-22-green?logo=node.js)
![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange?logo=amazon-aws)
![DynamoDB](https://img.shields.io/badge/AWS-DynamoDB-blue?logo=amazon-dynamodb)

---

## Features

- **Real-time token streaming** — NDJSON stream over Lambda Function URL; tokens arrive at the client as they are generated
- **Multi-provider AI** — AWS Bedrock (default), Anthropic (BYOK), and Google Gemini (BYOK) in a single handler
- **Branching conversation history** — full branch tree stored in DynamoDB; each fork is an independent ordered list of message IDs
- **Cognito JWT auth** — every request is verified against your Cognito User Pool before any AI call is made
- **Transport-agnostic design** — a thin `Transport` interface decouples streaming logic from the wire protocol
- **Local dev server** — plain Node.js HTTP server that wraps the same handler logic, no SAM or Docker needed
- **History trimming** — configurable message count and token-budget caps prevent oversized Bedrock payloads
- **Usage tracking** — input and output token counts are saved per message for cost monitoring

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 (AWS Lambda) |
| Streaming | Lambda Function URL (`awslambda.streamifyResponse`) |
| Wire format | NDJSON (`application/x-ndjson`) |
| Default AI | AWS Bedrock (`amazon.nova-pro-v1`) |
| BYOK AI | Anthropic SDK, Google GenAI SDK |
| Auth | AWS Cognito via `aws-jwt-verify` |
| Database | AWS DynamoDB (`@aws-sdk/lib-dynamodb`) |
| Local dev | Plain `http` module + `dotenv` |

---

## Quick Start

### Prerequisites

- Node.js ≥ 22
- AWS credentials configured (`aws configure`) with access to Bedrock and DynamoDB
- An AWS Cognito User Pool (User Pool ID + App Client ID)
- DynamoDB tables created — see [DynamoDB Setup](#dynamodb-setup)

### 1. Clone and install

```bash
git clone https://github.com/fareedzafar657/chatbot-streaming-lambda.git
cd chatbot-streaming-lambda
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# Required
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_CLIENT_ID=<your-app-client-id>

# Optional — defaults shown
AWS_REGION=us-east-1
PORT=4000
CORS_ORIGIN=*
SYSTEM_PROMPT=You are a helpful, concise assistant.
BEDROCK_MAX_TOKENS=4096
BEDROCK_TEMPERATURE=0.7
BEDROCK_TOP_P=0.9
HISTORY_MAX_MESSAGES=50
HISTORY_MAX_TOKEN_BUDGET=60000
DYNAMO_MESSAGES_TABLE=chatbot_messages
DYNAMO_BRANCHES_TABLE=chatbot_branches
DYNAMO_SESSIONS_TABLE=chatbot_sessions
```

### 3. Start the local dev server

```bash
node scripts/local-server.js
```

Expected output:

```
Local Lambda server running at http://localhost:4000
```

Point your frontend at `http://localhost:4000` — the request shape and NDJSON stream format are identical to the deployed Lambda.

---

## API Reference

### `POST /`

**Headers**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <Cognito access token>` |

**Request body**

```json
{
  "prompt": "Explain recursion",
  "sessionId": "session-uuid",
  "branchId": "branch-uuid",
  "apiKey": "sk-ant-...",
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "systemPrompt": "You are a tutor."
}
```

| Field | Required | Description |
|---|---|---|
| `prompt` | Yes | The user's message |
| `sessionId` | Yes | Client-generated session UUID |
| `branchId` | No | Branch to append to; defaults to `session.activeBranchId` |
| `apiKey` | No | BYOK API key — routes to Anthropic or Gemini instead of Bedrock |
| `provider` | No | `"anthropic"` or `"gemini"` (required when `apiKey` is set) |
| `model` | No | Model override — only honoured on BYOK paths |
| `systemPrompt` | No | Per-request system prompt override |

**Response stream (NDJSON)**

Each line is a JSON object. Lines arrive as tokens are generated.

```jsonl
{"type":"metadata","sessionId":"...","branchId":"..."}
{"type":"userMessage","msgId":"msg_abc123"}
{"type":"delta","text":"Recursion"}
{"type":"delta","text":" is"}
{"type":"delta","text":" when..."}
{"type":"done","msgId":"msg_def456","state":"active","inputTokens":42,"outputTokens":87}
```

Error line (stream continues to close after this):

```jsonl
{"type":"error","message":"Unauthorized: token expired"}
```

---

## Project Structure

```
src/
├── index.js                  # Lambda handler entry point (streamifyResponse)
├── run-chat-request.js       # Shared request lifecycle: auth → parse → stream
├── config.js                 # Centralised env-var config with fail-fast validation
├── handlers/
│   └── chat.js               # Core chat turn orchestrator (transport-agnostic)
├── services/
│   ├── bedrock.js            # AWS Bedrock streaming (default provider)
│   ├── anthropic.js          # Anthropic API streaming (BYOK)
│   ├── gemini.js             # Google Gemini streaming (BYOK)
│   └── dynamodb.js           # Session / branch / message persistence + usage stats
├── middleware/
│   └── auth.js               # Cognito JWT verification (singleton verifier)
└── utils/
    ├── transport.js          # FunctionUrlTransport (wire-protocol abstraction)
    └── request.js            # Request parsing and validation

scripts/
└── local-server.js           # Local HTTP dev server (no SAM/Docker)

infra/
├── dynamodb-schema.md        # Table definitions + AWS CLI create commands
└── lambda-iam-policy.json    # Minimum IAM policy for the Lambda execution role

docs/
└── CODE-REVIEW.md            # Cleanup changelog + prioritised review findings

ARCHITECTURE.md               # How the service works, end to end (start here)
```

---

## DynamoDB Setup

Three tables are required. The schema and AWS CLI commands to create them are in [`infra/dynamodb-schema.md`](./infra/dynamodb-schema.md).

| Table | Purpose |
|---|---|
| `chatbot_messages` | Every user and assistant message |
| `chatbot_branches` | Branch metadata and ordered `selectedMsgIds` |
| `chatbot_sessions` | Top-level session record with active branch pointer |

All tables use `PAY_PER_REQUEST` billing — no capacity planning needed.

---

## Deployment

### Lambda Function URL (recommended)

1. Zip the project (excluding `node_modules` — use a Lambda layer or bundle with esbuild)
2. Create a Lambda function with the **Node.js 22** runtime
3. Set the handler to `src/index.handler`
4. Enable **Response Streaming** on the Function URL
5. Attach the IAM policy from [`infra/lambda-iam-policy.json`](./infra/lambda-iam-policy.json)
6. Set all environment variables from [`.env.example`](#2-configure-environment-variables)

The IAM policy grants the minimum permissions required:
- `bedrock:InvokeModelWithResponseStream` — token streaming
- `dynamodb:*` — sessions, branches, messages
- `logs:*` — CloudWatch log groups

### Environment variables in Lambda

Set these in the Lambda console under **Configuration → Environment variables**, or in your SAM/CDK template. The `config.js` will throw at cold start if `COGNITO_USER_POOL_ID` or `COGNITO_CLIENT_ID` are missing.

---

## AI Providers

### AWS Bedrock (default)

No extra config beyond IAM permissions. The model is set via `BEDROCK_MAX_TOKENS` and defaults to `amazon.nova-pro-v1`. Clients **cannot** override the model on the Bedrock path.

### Anthropic (BYOK)

Pass `apiKey` (starting `sk-ant-...`) and `provider: "anthropic"` in the request body. The key is used directly and never stored. Default model: `claude-haiku-4-5-20251001`.

### Google Gemini (BYOK)

Pass `apiKey` and `provider: "gemini"`. Default model: `gemini-2.5-flash`.

---

## Using Your Own API Key (local smoke test)

```powershell
$body = @{
  prompt    = "Say hi"
  sessionId = "test-session-1"
  apiKey    = "sk-ant-..."
  provider  = "anthropic"
} | ConvertTo-Json

Invoke-WebRequest -Uri http://localhost:4000 -Method POST `
  -ContentType "application/json" -Body $body |
  Select-Object -ExpandProperty Content
```

Each line of the output is a JSON object: `metadata` → `userMessage` → `delta` chunks → `done`.

---

## Environment Variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `COGNITO_USER_POOL_ID` | — | **Yes** | Cognito User Pool ID (`us-east-1_XXX`) |
| `COGNITO_CLIENT_ID` | — | **Yes** | Cognito App Client ID |
| `AWS_REGION` | `us-east-1` | No | AWS region for Bedrock and DynamoDB |
| `SYSTEM_PROMPT` | (built-in) | No | Default system prompt injected into every conversation |
| `BEDROCK_MAX_TOKENS` | `4096` | No | Max output tokens for Bedrock requests |
| `BEDROCK_TEMPERATURE` | `0.7` | No | Sampling temperature |
| `BEDROCK_TOP_P` | `0.9` | No | Top-p sampling |
| `HISTORY_MAX_MESSAGES` | `50` | No | Max messages fetched from DynamoDB before token check |
| `HISTORY_MAX_TOKEN_BUDGET` | `60000` | No | Approx token budget for conversation history |
| `DYNAMO_MESSAGES_TABLE` | `chatbot_messages` | No | DynamoDB messages table name |
| `DYNAMO_BRANCHES_TABLE` | `chatbot_branches` | No | DynamoDB branches table name |
| `DYNAMO_SESSIONS_TABLE` | `chatbot_sessions` | No | DynamoDB sessions table name |
| `CORS_ORIGIN` | `*` | No | CORS origin (local server only — Lambda uses Function URL CORS config) |
| `PORT` | `4000` | No | Local dev server port |

---

## Related Repos

| Repo | Purpose |
|---|---|
| [chatbot-app](https://github.com/fareedzafar657/chatbot-app) | K-AI Next.js frontend — branching chat UI |
| [chatbot-fast-api-lambda](https://github.com/fareedzafar657/chatbot-fast-api-lambda) | REST API — session, branch, and message management |

---

## Contributing

1. Fork and create a feature branch: `git checkout -b feature/my-feature`
2. Keep PRs focused — one feature or fix per PR
3. Open an issue first for significant changes

---

## License

[MIT](./LICENSE) © Fareed Z.
