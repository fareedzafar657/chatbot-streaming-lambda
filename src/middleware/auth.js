'use strict';

/**
 * Cognito JWT verification.
 *
 * verifyAuth    — verifies the Bearer access token; returns the full JWT payload.
 * extractEmail  — verifies the X-Id-Token header (ID token) and returns the
 *                 user's email. Optional: returns null if the header is absent.
 *                 Used only for demo-model gating; never blocks the request.
 *
 * Both verifiers are module-level constants — created once at cold start so
 * the JWKS public keys are cached and reused across warm invocations.
 * This module does NOT parse the request body — that is utils/request.js.
 */

const { CognitoJwtVerifier } = require('aws-jwt-verify');
const config = require('../config');

// ─── Verifiers ────────────────────────────────────────────────────────────────

const accessVerifier = CognitoJwtVerifier.create({
  userPoolId: config.cognito.userPoolId,
  tokenUse:   'access',
  clientId:   config.cognito.clientId,
});

const idVerifier = CognitoJwtVerifier.create({
  userPoolId: config.cognito.userPoolId,
  tokenUse:   'id',
  clientId:   config.cognito.clientId,
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function verifyAuth(headers) {
  const authHeader = headers?.authorization || headers?.Authorization;
  if (!authHeader) {
    throw Object.assign(
      new Error('Missing Authorization header'),
      { statusCode: 401 }
    );
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  try {
    return await accessVerifier.verify(token);
  } catch (err) {
    console.error('[verifyAuth]', err);
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
}

// ─── Email extraction (optional, for demo-model gating) ──────────────────────

async function extractEmail(headers) {
  const idToken = headers?.['x-id-token'] || headers?.['X-Id-Token'];
  if (!idToken) return null;

  try {
    const payload = await idVerifier.verify(idToken);
    return payload.email ?? null;
  } catch {
    // Malformed or expired ID token — treat as no email, don't block the request
    return null;
  }
}

module.exports = { verifyAuth, extractEmail };
