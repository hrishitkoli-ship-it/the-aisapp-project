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

// ---------------------------------------------------------------------
// Composite tokens: auth token + content-encryption key bundled into
// one string an AI agent copies as its single credential, so setup
// stays "paste one token" even though it now carries two purposes.
//
// Format: aihub_<authTokenRandomPart>.<encryptionKeyB64url>
//
// The `.` delimiter is safe because base64url's alphabet (A-Za-z0-9-_)
// never contains a period -- unlike JWTs, there's no need for a
// header/signature segment here since the server already verifies
// the auth part via hashToken/verifyToken (unchanged, above) and has
// no legitimate use for the encryption key at all, so it's never
// parsed server-side except to be stripped off before verification.
//
// generateEncryptionKey() produces RAW random key bytes (not derived
// from a password -- that's a separate concern for device-migration,
// which needs a password-derived key so two devices can independently
// re-derive the same key). This key is generated once at project
// creation, shown once in the composite token, and never stored by
// the server in any form -- not even hashed, since the server has no
// need to verify it, only the client-side encrypt/decrypt step does.
// ---------------------------------------------------------------------

function generateEncryptionKey() {
  // 32 bytes = 256-bit key, matching AES-256-GCM's key size exactly.
  return crypto.randomBytes(32).toString('base64url');
}

function composeToken(authToken, encryptionKeyB64url) {
  return `${authToken}.${encryptionKeyB64url}`;
}

/**
 * Splits a composite token into its auth and encryption-key parts.
 * Robust to receiving a BARE auth token with no encryption key
 * appended (no '.' present) -- returns encryptionKey: null in that
 * case rather than throwing, so this stays backward-compatible with
 * any token issued before this composite scheme existed.
 */
function parseCompositeToken(compositeToken) {
  if (!compositeToken) return { authToken: null, encryptionKey: null };
  const dotIndex = compositeToken.indexOf('.');
  if (dotIndex === -1) {
    return { authToken: compositeToken, encryptionKey: null };
  }
  return {
    authToken: compositeToken.slice(0, dotIndex),
    encryptionKey: compositeToken.slice(dotIndex + 1),
  };
}

module.exports = {
  generateToken,
  hashToken,
  verifyToken,
  TOKEN_PREFIX,
  generateEncryptionKey,
  composeToken,
  parseCompositeToken,
};
