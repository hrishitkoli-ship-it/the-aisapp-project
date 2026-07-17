/**
 * routes/migration.js
 * ------------------------------------------------------------------
 * Encrypted device-to-device relay for moving a secret (typically a
 * project token) from one browser to another via a shareable link --
 * safer than pasting a raw token into a messaging app.
 *
 * The server NEVER sees plaintext or the decryption key. It only
 * ever stores/serves ciphertext (see db/schema.sql's
 * aisapp_migration_blobs comment and store.js's createMigrationBlob/
 * consumeMigrationBlob for the full design). The decryption key
 * lives solely in the migration LINK's URL fragment (the part after
 * '#'), which browsers never include in any HTTP request -- only the
 * blob ID (never the key) travels in this route's URL path.
 *
 * Human-facing only, no AI-token auth -- this exists for a human
 * moving their own secrets between their own devices, not for AI
 * agents. Deliberately excluded from routes/files.js's ProjectSizeLimit/
 * AccountSizeLimit error handling: migration blobs have their own,
 * separate size ceiling (MigrationBlobTooLargeError, 50KB) since
 * they're not project content and shouldn't share that budget.
 * ------------------------------------------------------------------
 */

const express = require('express');
const store = require('../db/store');
const { humanSensitiveLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(humanSensitiveLimiter);

// POST /api/migration  { ciphertext: "..." }
// Creates a new short-lived, single-use blob. Returns { id, expiresAt }.
// The caller (client-side migration.js) is responsible for building
// the actual shareable link: #/migrate/<id>/<key> -- this route never
// sees or handles the key at all.
router.post('/', async (req, res, next) => {
  try {
    const { ciphertext } = req.body || {};
    if (!ciphertext || typeof ciphertext !== 'string') {
      return res.status(400).json({ error: '"ciphertext" (string) is required.' });
    }

    const { id, expiresAt } = await store.createMigrationBlob(ciphertext);
    res.status(201).json({ id, expiresAt });
  } catch (err) {
    if (err instanceof store.MigrationBlobTooLargeError) {
      return res.status(413).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/migration/:id
// Fetches and immediately deletes the blob (single-use). Returns 404
// for "never existed," already expired, OR already consumed --
// deliberately indistinguishable from the response alone (see
// store.js's consumeMigrationBlob header on why: telling a caller
// WHICH of those three happened leaks more than a human redeeming
// their own link ever needs to know).
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ciphertext = await store.consumeMigrationBlob(id);
    if (ciphertext === null) {
      return res.status(404).json({
        error: 'This migration link is invalid, expired, or has already been used.',
      });
    }
    res.json({ ciphertext });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
