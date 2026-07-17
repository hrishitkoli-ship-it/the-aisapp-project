/**
 * migration.js
 * ------------------------------------------------------------------
 * Client-side half of the device-to-device migration link feature
 * (see routes/migration.js for the server side, and Settings page's
 * "Send to another device" section for the UI).
 *
 * Uses the Web Crypto API (window.crypto.subtle) -- browser-native,
 * no dependency, unlike backend/utils/contentCrypto.js which uses
 * Node's `crypto` module for the AI-agent-facing encryption instead.
 * Same algorithm (AES-256-GCM) and envelope shape (IV + authTag +
 * ciphertext, base64), different API because one runs in a browser
 * and the other runs in whatever a copied-and-pasted AI agent script
 * runs in -- there's no code sharing possible between them, so this
 * is a deliberate, separate implementation, not a fork of a shared one.
 *
 * KEY HANDLING: a fresh random key is generated for EVERY link, never
 * reused, never derived from anything (no password exists in this
 * app's design). It lives ONLY in the link's URL fragment (after '#')
 * -- browsers never send the fragment in any HTTP request, so the
 * server genuinely never sees it, not even in a log line.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const MIGRATION_API = '/api/migration';

  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBuffer(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  const IV_LENGTH = 12;

  /** Encrypts a UTF-8 string with a freshly generated key. Returns
   *  { ciphertextBase64, keyBase64Url } -- caller is responsible for
   *  putting the key in the link fragment, never in a request body. */
  async function encryptWithFreshKey(plaintext) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    // Web Crypto's AES-GCM output already includes the auth tag
    // appended to the ciphertext -- unlike Node's crypto module,
    // there's no separate getAuthTag() call needed here.
    const envelope = new Uint8Array(iv.length + ciphertextBuf.byteLength);
    envelope.set(iv, 0);
    envelope.set(new Uint8Array(ciphertextBuf), iv.length);

    const rawKey = await crypto.subtle.exportKey('raw', key);

    return {
      ciphertextBase64: bufferToBase64(envelope.buffer),
      keyBase64Url: bufferToBase64Url(rawKey),
    };
  }

  /** Decrypts an envelope produced by encryptWithFreshKey, given the
   *  key parsed out of the link's fragment. Throws if the auth tag
   *  doesn't verify (tampered or corrupted ciphertext, or wrong key)
   *  -- same "don't trust it" semantics as contentCrypto.js's
   *  decryptContent on the AI-agent side. */
  async function decryptWithKey(ciphertextBase64, keyBase64Url) {
    const rawKey = base64UrlToBuffer(keyBase64Url);
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);

    const envelope = new Uint8Array(base64ToBuffer(ciphertextBase64));
    const iv = envelope.slice(0, IV_LENGTH);
    const ciphertext = envelope.slice(IV_LENGTH);

    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintextBuf);
  }

  async function api(path, options = {}) {
    const res = await fetch(`${MIGRATION_API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Some responses may not be JSON; treat as empty.
    }
    if (!res.ok) {
      const message = (body && body.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** Encrypts plaintext, uploads the ciphertext, and builds the full
   *  shareable link with the key in the fragment. */
  async function createLink(plaintext) {
    const { ciphertextBase64, keyBase64Url } = await encryptWithFreshKey(plaintext);
    const { id, expiresAt } = await api('/', {
      method: 'POST',
      body: JSON.stringify({ ciphertext: ciphertextBase64 }),
    });

    const link = `${window.location.origin}${window.location.pathname}#/migrate/${id}/${keyBase64Url}`;
    return { link, expiresAt };
  }

  /** Fetches and decrypts a migration blob by ID + key (as parsed out
   *  of a #/migrate/:id/:key route by router.js). The blob is
   *  consumed server-side on this GET -- calling this twice for the
   *  same id will fail the second time by design (single-use). */
  async function redeemLink(id, keyBase64Url) {
    const { ciphertext } = await api(`/${id}`);
    return decryptWithKey(ciphertext, keyBase64Url);
  }

  window.AisappMigration = { createLink, redeemLink };
})();
