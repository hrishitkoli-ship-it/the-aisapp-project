/**
 * tokens.js
 * ------------------------------------------------------------------
 * Generates and verifies project-scoped AI access tokens.
 *
 * Format mirrors GitHub PATs for familiarity:
 *   aihub_<12-char permanent device code><32 random url-safe key chars>
 *
 * The device code is generated once per device (see db/store.js
 * getDevice/saveDevice) and never regenerates -- it's the same across
 * every project a human creates on this device, so an AI agent or a
 * human glancing at two different projects' tokens can recognize
 * they're the same account. Only the key portion after it is
 * per-project and rotatable via the existing regenerate-token flow --
 * regenerating a project's token changes the key, never the code.
 *
 * SECURITY NOTE: We never store the raw token anywhere. Only its
 * SHA-256 hash is persisted in project.json. The raw token is shown
 * to the user exactly once (at creation / regeneration time) via the
 * API response, same as GitHub does. If it's lost, the user must
 * regenerate -- there is no "reveal" endpoint, because a reveal
 * endpoint would defeat the purpose of hashing it in the first place.
 *
 * The device code itself is NOT secret the same way the key is -- it's
 * a stable identifier, not a credential on its own (a bare code with no
 * key can't authenticate anything, since verifyToken checks the whole
 * token's hash). It's stored in the clear in project.json specifically
 * so verify-time and the UI can display/compare it without needing to
 * reverse a hash.
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'aihub_';
const DEVICE_CODE_LENGTH = 12;
const KEY_LENGTH = 32; // random bytes -> ~43 base64url chars, same entropy as before

// Alphanumeric only (no "-" or "_") since the device code is meant to be
// human-shareable (read aloud, typed on another device) -- avoids visual
// ambiguity with the token's own "_" separator and nanoid's default
// alphabet, which both use "-"/"_".
const DEVICE_CODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateDeviceCode() {
  const bytes = crypto.randomBytes(DEVICE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < DEVICE_CODE_LENGTH; i++) {
    code += DEVICE_CODE_ALPHABET[bytes[i] % DEVICE_CODE_ALPHABET.length];
  }
  return code;
}

function generateKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('base64url');
}

/** Builds a full token from a (permanent) device code + (rotatable) key. */
function buildToken(deviceCode, key) {
  return `${TOKEN_PREFIX}${deviceCode}${key}`;
}

/**
 * Splits a full token back into { deviceCode, key }, or null if it
 * doesn't match the expected shape. Used at verify-time to confirm the
 * code embedded in a presented token still matches what's on file --
 * not for trust (the hash comparison in verifyToken is what actually
 * authenticates), just so callers can display/log which device a
 * token claims to be from.
 */
function parseToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  if (rest.length <= DEVICE_CODE_LENGTH) return null;
  return {
    deviceCode: rest.slice(0, DEVICE_CODE_LENGTH),
    key: rest.slice(DEVICE_CODE_LENGTH),
  };
}

/**
 * Generates a full token for a project, using the given device code
 * (permanent, passed in -- this function never invents one) and a
 * freshly-generated key (rotatable).
 */
function generateToken(deviceCode) {
  if (typeof deviceCode !== 'string' || deviceCode.length !== DEVICE_CODE_LENGTH) {
    throw new Error(
      `generateToken requires a ${DEVICE_CODE_LENGTH}-char device code.`
    );
  }
  return buildToken(deviceCode, generateKey());
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison (hash first, then timingSafeEqual) to avoid
 *  timing side-channels on the secret itself. */
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
  generateKey,
  buildToken,
  parseToken,
  hashToken,
  verifyToken,
  TOKEN_PREFIX,
  DEVICE_CODE_LENGTH,
};
