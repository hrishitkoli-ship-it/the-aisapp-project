/**
 * tokens.js
 * ------------------------------------------------------------------
 * Generates and verifies project-scoped AI access tokens.
 *
 * Format mirrors GitHub PATs for familiarity:
 *   aihub_<32 random url-safe chars>
 *
 * SECURITY NOTE: We never store the raw token anywhere. Only its
 * SHA-256 hash is persisted in project.json. The raw token is shown
 * to the user exactly once (at creation / regeneration time) via the
 * API response, same as GitHub does. If it's lost, the user must
 * regenerate -- there is no "reveal" endpoint, because a reveal
 * endpoint would defeat the purpose of hashing it in the first place.
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'aihub_';

function generateToken() {
  // 32 bytes -> 43 base64url chars, plenty of entropy for a local tool.
  const raw = crypto.randomBytes(32).toString('base64url');
  return `${TOKEN_PREFIX}${raw}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time-ish comparison to avoid trivial timing side-channels. */
function verifyToken(candidateToken, storedHash) {
  if (!candidateToken || !storedHash) return false;
  const candidateHash = hashToken(candidateToken);
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, hashToken, verifyToken, TOKEN_PREFIX };
