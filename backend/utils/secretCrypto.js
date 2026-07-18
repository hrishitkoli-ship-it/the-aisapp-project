/**
 * secretCrypto.js
 * ------------------------------------------------------------------
 * Encrypts/decrypts secrets the SERVER itself must be able to read
 * back later -- currently just the GitHub PAT for #13's repo push
 * feature. This is deliberately a SEPARATE module from
 * contentCrypto.js, not a reuse of it, because the two have opposite
 * threat models:
 *
 *   contentCrypto.js -- key lives ONLY on the client/agent (split out
 *   of the composite AI token). The server stores ciphertext it can
 *   never decrypt. True zero-knowledge for file content.
 *
 *   secretCrypto.js (this file) -- key lives on the SERVER (an env
 *   var), because the server needs to decrypt the PAT itself to
 *   actually call the GitHub API on the human's behalf when they hit
 *   "push". This is standard encryption-at-rest, not zero-knowledge --
 *   anyone with server + env-var access could decrypt it, same as any
 *   other secrets-at-rest scheme (Vercel env vars, a password
 *   manager's vault, etc.). Don't confuse the two files' key sources.
 *
 * KEY SOURCE: process.env.AISAPP_SECRET_KEY, any string. Passed
 * through scrypt to derive a 32-byte AES key -- this means the human
 * can set literally any passphrase as the env var (no base64/hex
 * formatting required), unlike contentCrypto's key which must already
 * be a valid base64url 256-bit value.
 * ------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
// HKDF, not scrypt: scrypt is a password-hardening KDF, built to resist
// brute-forcing a LOW-entropy human password. AISAPP_SECRET_KEY is meant
// to be a HIGH-entropy random value (.env.example asks for `openssl rand
// -base64 32`), so the actual threat model here is "derive a well-formed
// 256-bit AES key from an already-strong secret" -- that's exactly what
// HKDF is designed for. Using scrypt wasn't broken, just the wrong tool
// signaling the wrong threat model; caught on review before shipping.
// Salt and info don't need to be secret for HKDF (unlike the IKM itself);
// INFO domain-separates this specific use in case another feature ever
// derives a different key from the same env var.
const HKDF_SALT = Buffer.from('aisapp-secretCrypto-v1-salt');
const HKDF_INFO = Buffer.from('github-pat-encryption');

class MissingSecretKeyError extends Error {
  constructor() {
    super(
      'AISAPP_SECRET_KEY is not set. This env var is required for the GitHub integration ' +
        '(#13) -- it encrypts the GitHub token at rest. Set it to any random string ' +
        '(e.g. `openssl rand -base64 32`) in your .env / Vercel project settings.'
    );
    this.name = 'MissingSecretKeyError';
    this.statusCode = 503; // app.js's central error handler reads err.statusCode, not err.status
  }
}

function deriveKey() {
  const secret = process.env.AISAPP_SECRET_KEY;
  if (!secret) throw new MissingSecretKeyError();
  const derived = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(derived);
}

function encryptSecret(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptSecret(envelopeBase64) {
  const key = deriveKey();
  const envelope = Buffer.from(envelopeBase64, 'base64');
  if (envelope.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Envelope too short -- not a value this module produced.');
  }
  const iv = envelope.subarray(0, IV_LENGTH);
  const authTag = envelope.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = envelope.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, MissingSecretKeyError };
