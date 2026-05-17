# Local Development

Running the Lambda locally for frontend development — no Docker, no SAM, full NDJSON streaming.

## How it works

`scripts/local-server.js` is a plain Node.js HTTP server that calls the same handler logic as the Lambda (`handleChatStream`) but skips the `awslambda` runtime globals. It exposes an identical interface to the Lambda Function URL:

```
POST http://localhost:4000
Content-Type: application/json
Authorization: Bearer <token>   ← omit when AUTH_BYPASS=true

{"prompt":"...", "sessionId":"...", "branchId":"..."}
```

Response: NDJSON stream (same wire format as production).

## Prerequisites

- Node.js 22+
- AWS credentials configured (`aws configure`) with access to Bedrock and DynamoDB
- DynamoDB tables already created (see `infra/dynamodb-schema.md`)

## Project structure

| Path | Responsibility |
|---|---|
| `src/handlers/chat.js` | Core request handler — provider selection, history, streaming |
| `src/services/bedrock.js` | AWS Bedrock streaming (default provider) |
| `src/services/anthropic.js` | Anthropic API streaming (BYOK) |
| `src/services/gemini.js` | Google Gemini streaming (BYOK) |
| `src/services/dynamodb.js` | Session/message persistence + usage stats |
| `src/utils/request.js` | Request parsing and validation |
| `src/utils/transport.js` | NDJSON write abstraction (Lambda URL + local server) |
| `src/config.js` | Environment-variable config |
| `scripts/local-server.js` | Local HTTP dev server (wraps handler, no SAM/Docker needed) |
| `infra/` | CloudFormation templates and DynamoDB schema |

## Start the server

```powershell
$env:AUTH_BYPASS="true"; node scripts/local-server.js
```

Custom port:

```powershell
$env:AUTH_BYPASS="true"; $env:PORT="4001"; node scripts/local-server.js
```

Expected output:

```
Local Lambda server running at http://localhost:4000
AUTH_BYPASS=true
```

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `AUTH_BYPASS` | `false` | Set `true` to skip Cognito JWT — required for local dev |
| `PORT` | `4000` | HTTP port |
| `AWS_REGION` | `us-east-1` | Must match where your DynamoDB tables live |
| `BEDROCK_MODEL_ID` | `amazon.nova-micro-v1:0` | Override to use a different model |
| `CORS_ORIGIN` | `*` | Lock down to your frontend origin if needed |

All other variables from the main README (`DYNAMO_*`, `SYSTEM_PROMPT`, etc.) work here too.

## Point your frontend at it

Replace the Lambda Function URL with `http://localhost:4000` in your frontend config. No other changes — the request shape and NDJSON stream format are identical to production.

If your frontend runs on a different port (e.g. `localhost:5173`), CORS is open by default (`*`), so cross-origin requests will work without any extra config.

## Using your own API key (Anthropic / Gemini)

Skip Bedrock entirely by passing `apiKey`, `provider`, and optionally `model` in the request body:

```json
{
  "prompt": "Hello",
  "sessionId": "test-session-1",
  "apiKey": "sk-ant-...",
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001"
}
```

Supported providers: `anthropic`, `gemini`. Omit all three to use Bedrock.

## Quick smoke test

```powershell
$body = '{"prompt":"Say hi","sessionId":"test-1"}'
Invoke-WebRequest -Uri http://localhost:4000 -Method POST `
  -ContentType "application/json" -Body $body |
  Select-Object -ExpandProperty Content
```

Each line of the response is a JSON object. You should see `metadata` → `userMessage` → `delta` chunks → `done`.

## WebSocket migration

The transport layer is already abstracted — switching to WebSocket touches only `src/utils/transport.js`, `src/index.js`, and the infra template. All business logic, AI providers, and DB code are untouched.

→ See **[docs/WEBSOCKET.md](docs/WEBSOCKET.md)** for the full step-by-step guide.

