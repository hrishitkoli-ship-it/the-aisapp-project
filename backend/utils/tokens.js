/**
 * tokens.js
 * ------------------------------------------------------------------
 * Generates and verifies project-scoped AI access tokens, this
 * device's permanent identity code, and the content-encryption key
 * bundled into the final composite token.
 *
 * Full format: aisapp_<12-char deviceCode>_<32 random chars>.<encryptionKeyB64url>.<projectId>
 *
 * Three independent layers, deliberately not entangled:
 *
 * 1. DEVICE CODE (restored from a prior regression -- an earlier pass
 *    this session overwrote this file with a stale copy that had no
 *    device-code support, breaking project creation entirely; fixed
 *    properly this time, reconciled with the encryption-key layer
 *    below rather than just reverted). Embedded via underscore into
 *    what's otherwise just "the auth token" -- exactly per the
 *    original design: the device code is NOT parsed back out for
 *    verification. verifyToken hashes and compares the WHOLE
 *    aisapp_<deviceCode>_<random> string as one opaque unit. It's a
 *    fixed, human-recognizable prefix (so someone glancing at two
 *    tokens can tell they came from the same device), not a
 *    machine-parsed field.
 *
 * 2. ENCRYPTION KEY. Split off by a `.` delimiter -- safe because
 *    base64url's alphabet never contains a period. UNLIKE the device
 *    code, this DOES get parsed back out client-side (by whatever's
 *    using contentCrypto.js), but the split happens at the OUTERMOST
 *    layer only: parseCompositeToken treats everything before the
 *    first '.' as one opaque "authToken" string and passes it whole
 *    to verifyToken -- it never looks inside that string's structure.
 *    This is why these layers don't interfere with each other: the
 *    device code lives INSIDE the opaque authToken portion; the
 *    encryption key lives OUTSIDE it, appended after that portion is
 *    already complete.
 *
 * 3. PROJECT ID (added after a real onboarding failure: an AI agent
 *    given only a token had no way to learn which project it was for
 *    without either fetching the app's URL -- impossible, since the
 *    project id lives in a client-side-only `#/project/:id` hash
 *    fragment that's never sent to the server -- or a human manually
 *    reading it out of the URL bar and relaying it separately, which
 *    is exactly the "searching" this exists to remove). Appended as a
 *    second, final `.`-delimited segment -- safe for the same reason
 *    as the encryption key: nanoid's default alphabet (what project
 *    ids are generated with, see routes/projects.js) never contains a
 *    period either, so there's no ambiguity about where each segment
 *    starts and ends. Machine-parsed, unlike the device code -- that's
 *    the whole point here, an AI agent reads its own project id
 *    straight out of the token string it already has, zero requests
 *    needed.
 *
 * SECURITY NOTE: We never store the raw token anywhere. Only its
 * SHA-256 hash is persisted. The raw composite token is shown to the
 * user exactly once (at creation / regeneration time) via the API
 * response, same as GitHub does. If it's lost, the user must
 * regenerate -- there is no "reveal" endpoint, because a reveal
 * endpoint would defeat the purpose of hashing it in the first place.
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'aisapp_';
const DEVICE_CODE_LENGTH = 12; // matches "permanent 12-char code" in db/store.js

/**
 * Generates this device's permanent identity code, once, the first
 * time any project is created on it (see store.js's
 * getOrCreateDeviceCode, which calls this and persists the result so
 * it's never regenerated). base64url so it's safe to embed directly
 * in a URL-safe token string with no further encoding.
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
    // Callers that haven't been updated to pass a deviceCode yet
    // still get a valid, functional token -- just without the
    // visible device prefix. Never silently drop entropy or throw
    // for a missing optional argument.
    return `${TOKEN_PREFIX}${raw}`;
  }
  return `${TOKEN_PREFIX}${deviceCode}_${raw}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generates the human-facing device secret (see SECURITY.md §3b and
 * middleware/auth.js's requireDeviceSecret for the full context: this
 * gates human-facing WRITE routes now that this app is moving toward
 * a public deployment, where "the device is the boundary" can no
 * longer mean "anyone who can reach the server").
 *
 * DELIBERATELY NOT the same value as generateDeviceCode above: the
 * device code is embedded inside every AI project token
 * (aisapp_<deviceCode>_<random>) and has therefore already been shared
 * with every AI agent the human has ever handed a project token to.
 * Reusing it as the human's own write-gate secret would mean any AI
 * agent with a valid token could trivially derive the credential meant
 * to gate destructive human actions -- a real security flaw, not an
 * inelegant reuse. This is a fully independent secret: generated
 * separately, hashed and verified via the same hashToken/verifyToken
 * pair above, never embedded in or derivable from anything an AI agent
 * ever sees.
 */
function generateDeviceSecret() {
  return crypto.randomBytes(32).toString('base64url');
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
// Composite tokens: the device-code-embedded auth token above, plus a
// content-encryption key appended after it, bundled into one string
// an AI agent copies as its single credential.
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

/**
 * Composes the final token shown to the user: auth token, content-
 * encryption key, and (new) the project id itself, all '.'-delimited.
 *
 * Embedding the project id here (rather than requiring an AI agent to
 * learn it from the app's URL) fixes a real onboarding failure: the
 * URL's project id lives in the `#/project/:id` HASH fragment, which
 * is client-side-only routing -- it's never sent in the HTTP request,
 * so an AI agent fetching that URL gets back just the app shell, no
 * project data. A sandboxed AI agent also frequently can't reach the
 * deployed host at all (fixed network allowlists are common in coding
 * sandboxes) even before that problem. Neither issue affects reading
 * a project id back out of a token string the human already pasted
 * directly into the agent's context -- no fetch involved either way.
 *
 * projectId is optional and appended last specifically so this stays
 * backward-compatible: parseCompositeToken splits on '.' and reads
 * however many segments are actually present, so a token generated
 * before this existed (1 or 2 segments) still parses correctly, just
 * without a projectId.
 *
 * Safe to '.'-delimit: nanoid's default alphabet (project ids) and
 * base64url (authToken, encryptionKey) never contain a period, so
 * there's no ambiguity about where one segment ends and the next
 * begins, in either direction.
 */
function composeToken(authToken, encryptionKeyB64url, projectId) {
  if (projectId) {
    return `${authToken}.${encryptionKeyB64url}.${projectId}`;
  }
  return `${authToken}.${encryptionKeyB64url}`;
}

/**
 * Splits a composite token into its auth, encryption-key, and (new)
 * project-id parts. Robust to receiving a token from any prior era of
 * this format -- a bare auth token (no '.'), an auth+key token (one
 * '.'), or the current auth+key+projectId token (two '.'s) -- so this
 * stays backward-compatible with anything already issued rather than
 * requiring every outstanding token to be regenerated when this
 * changes. The returned `authToken` still has its device-code prefix
 * embedded (untouched) -- this function only ever splits on the
 * outermost '.'s, never looks inside the authToken portion's own
 * structure.
 */
function parseCompositeToken(compositeToken) {
  if (!compositeToken) return { authToken: null, encryptionKey: null, projectId: null };
  const parts = compositeToken.split('.');
  if (parts.length === 1) {
    return { authToken: parts[0], encryptionKey: null, projectId: null };
  }
  if (parts.length === 2) {
    return { authToken: parts[0], encryptionKey: parts[1], projectId: null };
  }
  return { authToken: parts[0], encryptionKey: parts[1], projectId: parts[2] };
}

module.exports = {
  generateToken,
  generateDeviceCode,
  generateDeviceSecret,
  hashToken,
  verifyToken,
  TOKEN_PREFIX,
  DEVICE_CODE_LENGTH,
  generateEncryptionKey,
  composeToken,
  parseCompositeToken,
};
