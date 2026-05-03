## DynamoDB Table Schemas
## Use these definitions for CloudFormation, SAM, CDK, or Terraform.
## All tables use PAY_PER_REQUEST billing (no capacity planning needed).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE 1: chatbot_messages
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Purpose: Stores every message (user + assistant) across all sessions.

Primary Key:
  PK:  msgId (String)   — uuid, e.g. "msg_3f2a..."

Attributes:
  msgId        String    uuid
  sessionId    String    parent session
  branchId     String    which branch this belongs to
  role         String    "user" | "assistant"
  content      String    full message text
  state        String    "active" | "stopped" | "edited" | "deleted"
  userId       String    Cognito sub (user uuid)
  parentMsgId  String?   assistant messages → the user msgId they answer
  inputTokens  Number?   Bedrock input token count (assistant only)
  outputTokens Number?   Bedrock output token count (assistant only)
  createdAt    String    ISO 8601
  updatedAt    String    ISO 8601

GSI 1: sessionId-createdAt-index
  PK:   sessionId (String)
  SK:   createdAt (String)
  Use:  List all messages in a session ordered by time
        Query: KeyConditionExpression = "sessionId = :sid"

GSI 2: branchId-createdAt-index
  PK:   branchId (String)
  SK:   createdAt (String)
  Use:  List all messages in a branch ordered by time (used by FastAPI /history)
        Query: KeyConditionExpression = "branchId = :bid"

GSI 3: userId-createdAt-index
  PK:   userId (String)
  SK:   createdAt (String)
  Use:  List all sessions/messages for a user (admin / analytics)

TTL:  Not set by default. Optionally add `expiresAt` (Number, epoch seconds)
      and enable TTL on that attribute for auto-cleanup of old sessions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE 2: chatbot_branches
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Purpose: Branch tree metadata. Each branch is a curated view of messages.

Primary Key:
  PK:  branchId (String)  — uuid, e.g. "branch_7c1b..."

Attributes:
  branchId       String    uuid
  sessionId      String    parent session
  parentBranchId String?   null for trunk/main branch
  parentMsgId    String?   the message after which this fork was created
  selectedMsgIds List<String>  ordered list of msgIds fed to Bedrock
  label          String    human label, e.g. "main", "fork-1715..."
  createdAt      String    ISO 8601

GSI 1: sessionId-createdAt-index
  PK:   sessionId (String)
  SK:   createdAt (String)
  Use:  List all branches in a session (branch tree view in UI)
        Query: KeyConditionExpression = "sessionId = :sid"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE 3: chatbot_sessions
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Purpose: Top-level session record. Tracks which branch is currently active.

Primary Key:
  PK:  sessionId (String)  — client-generated uuid or slug

Attributes:
  sessionId      String    uuid
  userId         String    Cognito sub
  trunkBranchId  String    the original "main" branch (never deleted)
  activeBranchId String    current working branch (changes on fork)
  title          String?   optional session title (set by user or auto-generated)
  createdAt      String    ISO 8601
  updatedAt      String    ISO 8601

GSI 1: userId-updatedAt-index
  PK:   userId (String)
  SK:   updatedAt (String)
  Use:  List all sessions for a user, most recently active first
        Query: KeyConditionExpression  = "userId = :uid"
                ScanIndexForward       = false   (descending)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUERY PATTERNS SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Action                              Table / GSI                     Key used
  ─────────────────────────────────────────────────────────────────────────────
  Get a single message                messages (main)                 msgId
  Get all branches in session         branches / sessionId-GSI        sessionId
  Get messages in a branch (ordered)  messages / branchId-GSI         branchId
  Get user sessions (recent first)    sessions / userId-GSI           userId
  Stop a message                      messages (main) UpdateItem      msgId
  Edit a message                      messages (main) UpdateItem      msgId
  Fork a branch                       branches (main) PutItem         new branchId
  Append msg to branch                branches (main) UpdateItem      branchId

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AWS CLI — CREATE TABLES (quick setup)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Copy-paste to create all three tables in your AWS account:

# Messages table
aws dynamodb create-table \
  --table-name chatbot_messages \
  --attribute-definitions \
    AttributeName=msgId,AttributeType=S \
    AttributeName=sessionId,AttributeType=S \
    AttributeName=branchId,AttributeType=S \
    AttributeName=userId,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=msgId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    '[
      {
        "IndexName": "sessionId-createdAt-index",
        "KeySchema": [
          {"AttributeName":"sessionId","KeyType":"HASH"},
          {"AttributeName":"createdAt","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      },
      {
        "IndexName": "branchId-createdAt-index",
        "KeySchema": [
          {"AttributeName":"branchId","KeyType":"HASH"},
          {"AttributeName":"createdAt","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      },
      {
        "IndexName": "userId-createdAt-index",
        "KeySchema": [
          {"AttributeName":"userId","KeyType":"HASH"},
          {"AttributeName":"createdAt","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      }
    ]' \
  --region us-east-1

# Branches table
aws dynamodb create-table \
  --table-name chatbot_branches \
  --attribute-definitions \
    AttributeName=branchId,AttributeType=S \
    AttributeName=sessionId,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=branchId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    '[
      {
        "IndexName": "sessionId-createdAt-index",
        "KeySchema": [
          {"AttributeName":"sessionId","KeyType":"HASH"},
          {"AttributeName":"createdAt","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      }
    ]' \
  --region us-east-1

# Sessions table
aws dynamodb create-table \
  --table-name chatbot_sessions \
  --attribute-definitions \
    AttributeName=sessionId,AttributeType=S \
    AttributeName=userId,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --key-schema AttributeName=sessionId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    '[
      {
        "IndexName": "userId-updatedAt-index",
        "KeySchema": [
          {"AttributeName":"userId","KeyType":"HASH"},
          {"AttributeName":"updatedAt","KeyType":"RANGE"}
        ],
        "Projection": {"ProjectionType":"ALL"}
      }
    ]' \
  --region us-east-1