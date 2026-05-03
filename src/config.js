'use strict';

/**
 * Central config loaded from Lambda environment variables.
 * Set these in your Lambda console or SAM/CDK template.
 */
const config = {
  // AWS region
  region: process.env.AWS_REGION || 'us-east-1',

  // Bedrock
  bedrock: {
    modelId: process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0',
    maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '4096', 10),
    // System prompt injected for every conversation
    systemPrompt: process.env.SYSTEM_PROMPT ||
      'You are a helpful, concise assistant. Respond clearly and directly.',
  },

  // Cognito — REQUIRED in production
  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID,       // e.g. us-east-1_XXXXXXXXX
    clientId: process.env.COGNITO_CLIENT_ID,             // app client id
  },

  // DynamoDB table names
  dynamo: {
    messagesTable: process.env.DYNAMO_MESSAGES_TABLE || 'chatbot_messages',
    branchesTable: process.env.DYNAMO_BRANCHES_TABLE || 'chatbot_branches',
    sessionsTable: process.env.DYNAMO_SESSIONS_TABLE  || 'chatbot_sessions',
  },

  // History limits sent to Bedrock
  history: {
    // Max messages to pull from DB (hard cap before token check)
    maxMessages: parseInt(process.env.HISTORY_MAX_MESSAGES || '50', 10),
    // Approx token budget for history (rough: 1 token ≈ 4 chars)
    maxTokenBudget: parseInt(process.env.HISTORY_MAX_TOKEN_BUDGET || '60000', 10),
  },

  // CORS — set to your frontend domain in production
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};

// Fail fast at cold start if required vars are missing in production
if (process.env.NODE_ENV === 'production') {
  if (!config.cognito.userPoolId) throw new Error('COGNITO_USER_POOL_ID is required');
  if (!config.cognito.clientId)   throw new Error('COGNITO_CLIENT_ID is required');
}

module.exports = config;