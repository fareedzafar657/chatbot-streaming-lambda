src/index.js          Entry point. Receives the HTTP request, runs auth,
                      parses the body, creates the stream transport, calls
                      the chat handler. Nothing else.

src/config.js         All environment variables in one place. Every other
                      file imports from here — no scattered process.env calls.

src/middleware/
  auth.js             Verifies the Cognito JWT from the Authorization header.
                      Returns the decoded payload (sub = user ID) on success,
                      throws on failure.

src/handlers/
  chat.js             The core brain. Orchestrates the full turn:
                      resolve session → save user message → load history →
                      stream Bedrock → save assistant reply. No HTTP/WS knowledge.

src/services/
  bedrock.js          Calls Bedrock ConverseStream API. Yields token chunks,
                      then a done event with token counts. Nothing else.

  dynamodb.js         All database logic — sessions, branches, messages.
                      Handles the branch tree, state transitions (stop/edit),
                      and history loading with token budget enforcement.

src/utils/
  transport.js        Abstracts HOW tokens are sent to the client. Currently
                      wraps Lambda responseStream. WebSocket version is stubbed.
                      chat.js calls transport.send() and never knows the difference.

  request.js          Parses and validates the request body. Also builds the
                      CORS + content-type headers for the streaming response.

infra/
  dynamodb-schema.md  Table designs, GSI definitions, and copy-paste AWS CLI
                      commands to create all three tables.

  lambda-iam-policy.json  The exact IAM permissions the Lambda role needs.


---------------------------------------------------------------------------------------------------------------------------------


Temporarily bypass auth
Open src/middleware/auth.js and replace the entire file content with this:
javascript'use strict';

async function verifyAuth(headers) {
  // TEMP: hardcoded user for testing — replace with real Cognito verification later
  return { sub: 'test-user-001' };
}

module.exports = { verifyAuth };