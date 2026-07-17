/**
 * scripts/setup-turso-schema.js
 * ------------------------------------------------------------------
 * Run this ONCE against your real Turso database to create the
 * tables and size-cap triggers (db/schema.sql). Not run automatically
 * on every server start -- schema setup is a deliberate one-time
 * action, not something that should silently re-run on every cold
 * start of a serverless function.
 *
 * WHY THIS SCRIPT EXISTS AND WASN'T JUST RUN DIRECTLY: the schema
 * and trigger logic in db/schema.sql were thoroughly tested against
 * the real Turso/Limbo engine -- but locally, via the native
 * @tursodatabase/database package against a local file, since the
 * environment this was built in has no outbound network access to
 * turso.io (blocked by egress allowlist) and no working MCP
 * connector to your account either. This script is what actually
 * applies that proven schema to your REAL cloud database -- you (or
 * a future session with working network/connector access) need to
 * run it.
 *
 * Usage:
 *   TURSO_DATABASE_URL="libsql://your-db.turso.io" \
 *   TURSO_AUTH_TOKEN="your-token" \
 *   node scripts/setup-turso-schema.js
 *
 * Or, if you've already set these in a .env file locally:
 *   npm run setup-db
 *
 * Safe to re-run: every statement uses IF NOT EXISTS-equivalent
 * safety (CREATE TABLE/TRIGGER will simply error if it already
 * exists, in which case this script reports it and continues on to
 * the next statement rather than aborting -- see the try/catch
 * around each block below).
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { connect } = require('@tursodatabase/serverless');

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error(
    'Missing TURSO_DATABASE_URL and/or TURSO_AUTH_TOKEN environment variables.\n' +
      'Set them and re-run, e.g.:\n' +
      '  TURSO_DATABASE_URL="libsql://your-db.turso.io" TURSO_AUTH_TOKEN="..." node scripts/setup-turso-schema.js'
  );
  process.exit(1);
}

async function main() {
  const client = connect({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

  const schemaPath = path.join(__dirname, '..', 'backend', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Blank-line-aware split -- NOT naive semicolon splitting. Each
  // CREATE TRIGGER ... BEGIN ... END block has its own internal
  // semicolons (after RAISE(...) and after END), and naive splitting
  // on every semicolon fragments those into invalid statements. This
  // exact bug was caught during local testing of this same schema
  // file -- see db/store.js's header comment for the fuller story.
  // Top-level statements in schema.sql are always separated by a
  // blank line; semicolons inside a trigger body never are.
  const blocks = schema
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((block) => block.length > 0);

  console.log(`Applying ${blocks.length} schema statements to ${TURSO_DATABASE_URL}...\n`);

  let succeeded = 0;
  let skipped = 0;

  for (const block of blocks) {
    const label = block.split('\n')[0].slice(0, 60);
    try {
      await client.exec(block);
      console.log(`  OK    ${label}`);
      succeeded++;
    } catch (err) {
      if (/already exists/i.test(err.message)) {
        console.log(`  SKIP  ${label} (already exists)`);
        skipped++;
      } else {
        console.error(`  FAIL  ${label}\n        ${err.message}`);
        throw err;
      }
    }
  }

  console.log(`\nDone. ${succeeded} applied, ${skipped} already existed.`);

  // Sanity check: confirm both tables and all 8 triggers actually exist.
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aisapp_%'"
  );
  const triggers = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'aisapp_%'"
  );
  console.log(`\nVerification: ${tables.rows.length} aisapp_ tables, ${triggers.rows.length} aisapp_ triggers.`);
  if (tables.rows.length < 2 || triggers.rows.length < 8) {
    console.warn(
      '\nWARNING: expected 2 tables and 8 triggers. Something may not have applied correctly -- check the output above.'
    );
    process.exit(1);
  }
  console.log('Schema setup looks complete.');
}

main().catch((err) => {
  console.error('\nSchema setup failed:', err.message);
  process.exit(1);
});
