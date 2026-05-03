# Chatbot Streaming Lambda

Node.js v22 Lambda with Function URL streaming, Amazon Bedrock (Claude 3.5 Sonnet),
Cognito JWT auth, and a DynamoDB branch-tree conversation model.

## Project structure

```
src/
  index.js                  ← Lambda entry point (thin: auth + transport + route)
  config.js                 ← All env vars in one place
  middleware/
    auth.js                 ← Cognito JWT verification
  handlers/
    chat.js                 ← Core business logic (transport-agnostic)
  services/
    bedrock.js              ← Bedrock ConverseStream wrapper
    dynamodb.js             ← All DB reads/writes (messages, branches, sessions)
  utils/
    transport.js            ← Transport abstraction (FunctionUrl / WebSocket)
    request.js              ← Request parsing + response headers
infra/
  dynamodb-schema.md        ← Table schemas, GSIs, AWS CLI commands
  lambda-iam-policy.json    ← Minimal IAM policy for the Lambda role
scripts/
  local-test.js             ← Local invocation harness (no deploy needed)
```

## Environment variables

| Variable                  | Required | Default                                          | Description                         |
|---------------------------|----------|--------------------------------------------------|-------------------------------------|
| `AWS_REGION`              | yes      | `us-east-1`                                      | AWS region                          |
| `BEDROCK_MODEL_ID`        | no       | `us.anthropic.claude-3-5-sonnet-20241022-v2:0`   | Bedrock model ID                    |
| `BEDROCK_MAX_TOKENS`      | no       | `4096`                                           | Max tokens in response              |
| `SYSTEM_PROMPT`           | no       | (see config.js)                                  | System prompt for all conversations |
| `COGNITO_USER_POOL_ID`    | yes (prod)| —                                               | e.g. `us-east-1_XXXXXXXXX`         |
| `COGNITO_CLIENT_ID`       | yes (prod)| —                                               | Cognito app client ID               |
| `DYNAMO_MESSAGES_TABLE`   | no       | `chatbot_messages`                               | DynamoDB messages table name        |
| `DYNAMO_BRANCHES_TABLE`   | no       | `chatbot_branches`                               | DynamoDB branches table name        |
| `DYNAMO_SESSIONS_TABLE`   | no       | `chatbot_sessions`                               | DynamoDB sessions table name        |
| `HISTORY_MAX_MESSAGES`    | no       | `50`                                             | Hard cap on messages sent to Bedrock|
| `HISTORY_MAX_TOKEN_BUDGET`| no       | `60000`                                          | Approx token budget for history     |
| `CORS_ORIGIN`             | no       | `*`                                              | Set to your frontend domain in prod |
| `NODE_ENV`                | no       | —                                                | Set `production` to enable strict checks |

## Deploy steps

### 1. Create DynamoDB tables
```bash
# See infra/dynamodb-schema.md for full AWS CLI commands
# Quick version:
aws dynamodb create-table --cli-input-json file://infra/messages-table.json
```

### 2. Install dependencies
```bash
npm install
```

### 3. Create the Lambda function
```bash
# Zip it
zip -r function.zip src/ node_modules/ package.json

# Create Lambda (first time)
aws lambda create-function \
  --function-name chatbot-streaming \
  --runtime nodejs22.x \
  --role arn:aws:iam::YOUR_ACCOUNT:role/chatbot-lambda-role \
  --handler src/index.handler \
  --zip-file fileb://function.zip \
  --timeout 120 \
  --memory-size 512 \
  --environment "Variables={
    NODE_ENV=production,
    COGNITO_USER_POOL_ID=us-east-1_XXXXXXXX,
    COGNITO_CLIENT_ID=XXXXXXXXXX,
    BEDROCK_MODEL_ID=us.anthropic.claude-3-5-sonnet-20241022-v2:0,
    CORS_ORIGIN=https://yourapp.com
  }"

# Update function (subsequent deploys)
aws lambda update-function-code \
  --function-name chatbot-streaming \
  --zip-file fileb://function.zip
```

### 4. Enable Function URL with streaming
```bash
aws lambda create-function-url-config \
  --function-name chatbot-streaming \
  --auth-type NONE \
  --invoke-mode RESPONSE_STREAM

# Allow public access (auth is handled in-Lambda via Cognito JWT)
aws lambda add-permission \
  --function-name chatbot-streaming \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE
```

### 5. Apply IAM policy to Lambda role
```bash
aws iam put-role-policy \
  --role-name chatbot-lambda-role \
  --policy-name chatbot-lambda-policy \
  --policy-document file://infra/lambda-iam-policy.json
```

### 6. Test locally
```bash
SKIP_AUTH=true node scripts/local-test.js "What is the capital of Pakistan?"
```

## Wire format (NDJSON stream)

Each line is a JSON object:

```
{"type":"metadata","sessionId":"...","branchId":"..."}
{"type":"userMessage","msgId":"msg_abc123"}
{"type":"delta","text":"Hello"}
{"type":"delta","text":", how can I help?"}
{"type":"done","msgId":"msg_xyz789","state":"active","inputTokens":42,"outputTokens":17}
```

Error lines (stream stays open, then closes):
```
{"type":"error","message":"Unauthorized: token expired"}
```

## Frontend consumption (fetch + ReadableStream)

```javascript
const response = await fetch(LAMBDA_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cognitoAccessToken}`,
  },
  body: JSON.stringify({ prompt, sessionId, branchId }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);

    if (event.type === 'delta')       appendToken(event.text);
    if (event.type === 'metadata')    setIds(event.sessionId, event.branchId);
    if (event.type === 'userMessage') setUserMsgId(event.msgId);
    if (event.type === 'done')        onStreamComplete(event);
    if (event.type === 'error')       showError(event.message);
  }
}
```

## Migrating to WebSocket (future)

1. Add `WebSocketTransport` class to `src/utils/transport.js` (stub already there)
2. Create a new Lambda entry point (e.g. `src/index-ws.js`) that extracts
   `connectionId` from the API Gateway event and calls:
   ```js
   const transport = createTransport('websocket', { apiGwClient, connectionId });
   await handleChatStream(transport, { ...parsed, userId });
   ```
3. `src/handlers/chat.js` and all services are **unchanged**.
4. Wire API Gateway WebSocket → the new handler for the `$stream` route.