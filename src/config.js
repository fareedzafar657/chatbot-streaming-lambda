'use strict';

/**
 * Centralised configuration — the single source of truth for every tunable.
 *
 * Reads process.env exactly once, at module load, and coerces each value to
 * the right type. The required secrets (the Cognito IDs) are checked at the
 * bottom so the Lambda fails fast on a bad cold start instead of erroring
 * halfway through a request.
 *
 * Model IDs that are not env-driven (the Bedrock default, the BYOK provider
 * defaults, the demo-model allowlist) live here too — so there is exactly one
 * place to change a model, never a string buried inside a service file.
 */

const config = {
  region: process.env.AWS_REGION || 'us-east-1',

  // ─── Bedrock (default provider) ──────────────────────────────────────────
  bedrock: {
    modelId:      'us.amazon.nova-pro-v1:0',
    maxTokens:    Number.parseInt(process.env.BEDROCK_MAX_TOKENS || '4096', 10),
    temperature:  Number.parseFloat(process.env.BEDROCK_TEMPERATURE || '0.7'),
    topP:         Number.parseFloat(process.env.BEDROCK_TOP_P || '0.9'),
    systemPrompt: process.env.SYSTEM_PROMPT ||
      'You are a helpful, concise assistant. Respond clearly and directly.',
  },

  // ─── BYOK provider defaults ──────────────────────────────────────────────
  // The model used when a BYOK request does not name a model of its own.
  anthropic: {
    defaultModel: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    defaultModel: 'gemini-2.5-flash',
  },

  // ─── Cognito ─────────────────────────────────────────────────────────────
  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId:   process.env.COGNITO_CLIENT_ID,
  },

  // ─── DynamoDB tables ─────────────────────────────────────────────────────
  dynamo: {
    messagesTable: process.env.DYNAMO_MESSAGES_TABLE || 'chatbot_messages',
    branchesTable: process.env.DYNAMO_BRANCHES_TABLE || 'chatbot_branches',
    sessionsTable: process.env.DYNAMO_SESSIONS_TABLE  || 'chatbot_sessions',
  },

  // ─── History trimming ────────────────────────────────────────────────────
  history: {
    maxMessages:    Number.parseInt(process.env.HISTORY_MAX_MESSAGES || '50', 10),
    // Approx token budget for history (1 token ≈ 4 chars)
    maxTokenBudget: Number.parseInt(process.env.HISTORY_MAX_TOKEN_BUDGET || '60000', 10),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },

  // ─── Demo models ─────────────────────────────────────────────────────────
  // Demo-approved users may pick a Bedrock model from `bedrockModels` on the
  // non-BYOK path. `allowedEmails` empty = feature disabled for everyone.
  // `bedrockModels` must stay in sync with DEMO_BEDROCK_MODELS in
  // chatbot-app/shared/ai-config.ts — see docs/CODE-REVIEW.md.
  demoModels: {
    allowedEmails: process.env.DEMO_MODELS_ALLOWED_EMAILS
      ? process.env.DEMO_MODELS_ALLOWED_EMAILS.split(',').map((e) => e.trim()).filter(Boolean)
      : [],
    bedrockModels: ['anthropic.claude-sonnet-4-6'],
  },
};

if (!config.cognito.userPoolId) throw new Error('COGNITO_USER_POOL_ID env var is required');
if (!config.cognito.clientId)   throw new Error('COGNITO_CLIENT_ID env var is required');

module.exports = config;
