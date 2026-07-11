/**
 * tokens.js
 * ------------------------------------------------------------------
 * Generates and verifies project-scoped AI access tokens, and this
 * device's permanent identity code.
 *
 * Format mirrors GitHub PATs for familiarity:
 *   aihub_<12-char device code>_<32 random url-safe chars>
 *
 * The device code sits in a fixed position so a human glancing at two
 * tokens can tell at a glance whether they came from the same device
 * -- e.g. spotting that a token pasted into a chat came from a phone
 * they don't recognize. It is NOT parsed back out of the token by any
 * verification code (see middleware/auth.js's verifyToken -- it only
 * ever hashes and compares, never inspects structure); the device
 * code is looked up from project.deviceCode in storage instead. This
 * is deliberate: token verification should not depend on successfully
 * parsing an untrusted string's internal format.
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
const DEVICE_CODE_LENGTH = 12; // matches "permanent 12-char code" in db/store.js

/**
 * Generates this device's permanent identity code, once, the first
 * time any project is created on it (see store.js's getOrCreateDeviceCode,
 * which calls this and persists the result so it's never regenerated).
 * base64url so it's safe to embed directly in a URL-safe token string
 * with no further encoding.
 */
function generateDeviceCode() {
  // 9 random bytes -> 12 base64url chars exactly (9 * 8 / 6 = 12),
  // so DEVICE_CODE_LENGTH stays accurate without needing to slice.
  return crypto.randomBytes(9).toString('base64url');
}

function generateToken(deviceCode) {
  // 32 bytes -> 43 base64url chars, plenty of entropy for a local tool.
  const raw = crypto.randomBytes(32).toString('base64url');
  if (!deviceCode) {
    // Callers that haven't been updated to pass a deviceCode yet (or
    // call sites outside routes/projects.js, if any get added later)
    // still get a valid, functional token -- just without the visible
    // device prefix. Never silently drop entropy or throw for a
    // missing optional argument.
    return `${TOKEN_PREFIX}${raw}`;
  }
  return `${TOKEN_PREFIX}${deviceCode}_${raw}`;
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

module.exports = {
  generateToken,
  generateDeviceCode,
  hashToken,
  verifyToken,
  TOKEN_PREFIX,
  DEVICE_CODE_LENGTH,
};
