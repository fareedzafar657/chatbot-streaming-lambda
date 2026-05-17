'use strict';

const { CognitoJwtVerifier } = require('aws-jwt-verify');
const config = require('../config');

// ─── Verifier singleton ───────────────────────────────────────────────────────
let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: 'access',
      clientId: config.cognito.clientId,
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
