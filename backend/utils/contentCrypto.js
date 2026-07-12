/**
 * contentCrypto.js
 * ------------------------------------------------------------------
 * Encrypts/decrypts file content client-side, so the server (Turso)
 * never sees plaintext file content -- only ciphertext it stores and
 * returns opaquely, exactly as it always did with plaintext before
 * this existed (fileOps.js/store.js needed ZERO changes for this;
 * `content` was always just an opaque string to them).
 *
 * MEANT TO BE COPIED, NOT IMPORTED CROSS-REPO. An AI agent calling
 * this app's API is typically a separate process in its own working
 * directory (a Termux session, a different repo entirely) -- not
 * something that has this backend's node_modules available. Copy
 * this single file into wherever your agent's own code lives and
 * require() it locally. Zero external dependencies (Node's built-in
 * `crypto` only), so copying it is genuinely all that's needed.
 *
 * KEY SOURCE: the encryption key is the part of your composite AI
 * token after the first '.' -- see tokens.js's composeToken /
 * parseCompositeToken on the server side for how it got there. e.g.
 * given a token like "aihub_AbC123....XyZ789", everything after the
 * first "." is your base64url-encoded 256-bit key. Parse it out like:
 *
 *   const fullToken = "aihub_AbC123....XyZ789"; // from your env/config
 *   const dotIndex = fullToken.indexOf('.');
 *   const authToken = fullToken.slice(0, dotIndex);       // for Authorization: Bearer
 *   const encryptionKeyB64url = fullToken.slice(dotIndex + 1); // for this module
 *
 * USAGE:
 *   const { encryptContent, decryptContent } = require('./contentCrypto');
 *
 *   // Before PUT /api/ai/:projectId/files/content/foo.js
 *   const ciphertext = encryptContent(plaintextCode, encryptionKeyB64url);
 *   await fetch(url, { method: 'PUT', body: JSON.stringify({ content: ciphertext }) });
 *
 *   // After GET .../files/content/foo.js
 *   const { content: ciphertext } = await response.json();
 *   const plaintextCode = decryptContent(ciphertext, encryptionKeyB64url);
 *
 * If you don't have an encryption key (a bare token with no '.'),
 * skip encryption entirely and send/receive content as plain text --
 * that's a valid, backward-compatible configuration, not an error.
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // bytes, GCM's recommended nonce size
const AUTH_TAG_LENGTH = 16; // bytes, GCM's standard tag size

/**
 * Encrypts a UTF-8 string. Returns a single base64 string containing
 * IV + authTag + ciphertext concatenated -- a self-contained envelope,
 * nothing else needs to be stored or transmitted alongside it.
 */
function encryptContent(plaintext, encryptionKeyB64url) {
  const key = Buffer.from(encryptionKeyB64url, 'base64url');
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be 32 bytes (256 bits) once decoded, got ${key.length}. ` +
        'Check you copied the full key from after the "." in your composite token.'
    );
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypts an envelope produced by encryptContent(). Throws if the
 * auth tag doesn't verify -- this means the ciphertext was corrupted
 * OR tampered with (GCM is authenticated encryption, not just
 * confidentiality), so treat a thrown error here as "don't trust this
 * content," not as a bug to silently work around.
 */
function decryptContent(envelopeBase64, encryptionKeyB64url) {
  const key = Buffer.from(encryptionKeyB64url, 'base64url');
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be 32 bytes (256 bits) once decoded, got ${key.length}. ` +
        'Check you copied the full key from after the "." in your composite token.'
    );
  }

  const envelope = Buffer.from(envelopeBase64, 'base64');
  if (envelope.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Envelope too short to contain a valid IV + auth tag -- not a value this module produced.');
  }

  const iv = envelope.subarray(0, IV_LENGTH);
  const authTag = envelope.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = envelope.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(), // throws here if the auth tag doesn't match
  ]);

  return plaintext.toString('utf8');
}

module.exports = { encryptContent, decryptContent };
