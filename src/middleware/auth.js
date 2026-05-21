'use strict';

/**
 * Cognito JWT verification.
 *
 * Verifies the Bearer token on every request against the configured Cognito
 * User Pool before any AI call or DB write happens. A verified token's payload
 * (containing the user's sub and username) is returned to the caller.
 *
 * The verifier is a lazy singleton: building it fetches and caches the pool's
 * public signing keys, so reusing it across warm invocations avoids a network
 * round-trip per request. This module does NOT parse the request body — that
 * is utils/request.js.
 */

const { CognitoJwtVerifier } = require('aws-jwt-verify');
const config = require('../config');

// ─── Verifier singleton ───────────────────────────────────────────────────────
let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse:   'access',
      clientId:   config.cognito.clientId,
    });
  }
  return verifier;
}

async function verifyAuth(headers) {
  const authHeader = headers?.authorization || headers?.Authorization;
  if (!authHeader) {
    throw Object.assign(
      new Error('Missing Authorization header'),
      { statusCode: 401 }
    );
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  try {
    const payload = await getVerifier().verify(token);
    return payload;
  } catch (err) {
    throw Object.assign(
      new Error(`Unauthorized: ${err.message}`),
      { statusCode: 401 }
    );
  }
}

module.exports = { verifyAuth };
