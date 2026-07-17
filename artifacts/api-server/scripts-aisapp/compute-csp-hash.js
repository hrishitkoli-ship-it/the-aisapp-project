/**
 * compute-csp-hash.js
 * ------------------------------------------------------------------
 * Computes the sha256-<hash> CSP value for the one inline <script>
 * block in frontend/index.html (the serviceWorker.register()
 * snippet), by extracting its EXACT byte content directly from the
 * real file -- not by retyping it, which produced a silently wrong
 * hash on the first attempt during the same session that added this
 * script, specifically because of this failure mode.
 *
 * Run this any time that inline script's content changes, and paste
 * the output into backend/app.js's helmet() contentSecurityPolicy
 * scriptSrc directive, replacing the existing sha256-... value.
 *
 * Usage: node scripts/compute-csp-hash.js
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');
const html = fs.readFileSync(indexPath, 'utf-8');

// Matches the specific inline <script>...</script> block containing the
// serviceWorker registration snippet -- deliberately narrow (matches on
// "if ('serviceWorker'" specifically) so this doesn't accidentally grab
// a different <script> tag if more inline scripts are ever added above
// or below it in index.html.
const match = html.match(/<script>\s*\n(\s*if \('serviceWorker'[\s\S]*?)<\/script>/);

if (!match) {
  console.error(
    'Could not find the expected inline serviceWorker registration ' +
    'script in frontend/index.html. If that script was removed or its ' +
    'opening changed, update the regex above to match the new content, ' +
    'or -- better -- remove the CSP hash entirely if the inline script ' +
    'no longer exists (see the comment in backend/app.js).'
  );
  process.exit(1);
}

const exactContent = match[1];
const hash = crypto.createHash('sha256').update(exactContent, 'utf-8').digest('base64');

console.log(`sha256-${hash}`);
