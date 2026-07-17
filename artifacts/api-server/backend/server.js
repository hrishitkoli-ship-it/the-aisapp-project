/**
 * server.js
 * ------------------------------------------------------------------
 * Thin local-dev / Termux entry point. Calls app.listen() on the
 * SHARED app definition in app.js -- does not define its own routes,
 * middleware, or error handling.
 *
 * REWRITTEN during this session's Rule-6 re-verification pass: this
 * file previously built its OWN complete, independent Express app
 * from scratch (its own route mounts, its own CORS/JSON setup, its
 * own static-file serving, its own error handler) -- a full duplicate
 * of app.js, not a thin wrapper around it, directly contradicting
 * app.js's own header comment ("both environments share the exact
 * same route wiring with zero duplication"). Found while testing
 * Session 4's helmet/CSP hardening: the headers worked correctly when
 * app.js was loaded directly, but were completely absent when running
 * `node backend/server.js` -- because this file never required app.js
 * at all, so nothing added there could ever reach a real request going
 * through this file. Two real, independent Express apps had been
 * silently diverging (this file had device.js mounted; app.js didn't,
 * until this same pass added it; app.js's error handler referenced
 * store.js error classes that don't currently exist; this file was
 * missing helmet/CSP/rate-limiting entirely) -- exactly the kind of
 * drift Rule 6 exists to catch, just discovered from the opposite
 * direction (adding something new revealed an existing gap, rather
 * than a change breaking something that already worked).
 *
 * Before this rewrite, every difference between this file and app.js
 * was individually reconciled INTO app.js first (see that file's own
 * inline notes on each fix: the device.js mount, the 15mb body limit,
 * the service-worker no-cache header, the explicit 404 handler, the
 * corrected error handler) and verified live against app.js directly,
 * so nothing this file used to do is lost by now deferring to it.
 *
 * Run with: node backend/server.js
 * Or:       npm start
 * ------------------------------------------------------------------
 */

const os = require('os');
const app = require('./app');

const PORT = process.env.PORT || 7077;

function getLocalNetworkAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

app.listen(PORT, '0.0.0.0', () => {
  const lan = getLocalNetworkAddress();
  console.log('');
  console.log('  Aisapp is running');
  console.log('  ------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (lan) {
    console.log(`  Network: http://${lan}:${PORT}   (use this for other devices / AI agents on same network)`);
  }
  console.log('');
});
