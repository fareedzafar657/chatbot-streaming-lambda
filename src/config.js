'use strict';

const config = {
  region: process.env.AWS_REGION || 'us-east-1',

  bedrock: {
    modelId:      'us.amazon.nova-pro-v1:0',
    maxTokens:    parseInt(process.env.BEDROCK_MAX_TOKENS || '4096', 10),
    temperature:  Number.parseFloat(process.env.BEDROCK_TEMPERATURE || '0.7'),
    topP:         Number.parseFloat(process.env.BEDROCK_TOP_P || '0.9'),
    systemPrompt: process.env.SYSTEM_PROMPT ||
      'You are a helpful, concise assistant. Respond clearly and directly.',
  },

  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId:   process.env.COGNITO_CLIENT_ID,
  },

  dynamo: {
    messagesTable: process.env.DYNAMO_MESSAGES_TABLE || 'chatbot_messages',
    branchesTable: process.env.DYNAMO_BRANCHES_TABLE || 'chatbot_branches',
    sessionsTable: process.env.DYNAMO_SESSIONS_TABLE  || 'chatbot_sessions',
  },

  history: {
    maxMessages:    parseInt(process.env.HISTORY_MAX_MESSAGES || '50', 10),
    // Approx token budget for history (1 token ≈ 4 chars)
    maxTokenBudget: parseInt(process.env.HISTORY_MAX_TOKEN_BUDGET || '60000', 10),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};

if (!config.cognito.userPoolId) throw new Error('COGNITO_USER_POOL_ID env var is required');
if (!config.cognito.clientId)   throw new Error('COGNITO_CLIENT_ID env var is required');

module.exports = config;
