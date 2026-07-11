/**
 * api/index.js
 * ------------------------------------------------------------------
 * Vercel serverless function entry point. An Express app instance is
 * already callable as (req, res) => {}, which is exactly the
 * signature Vercel's Node.js runtime expects from a file under /api
 * -- so this file is just that export, nothing else. No app.listen()
 * here (see backend/app.js and backend/server.js headers for why);
 * Vercel manages the request lifecycle itself.
 *
 * Paired with /vercel.json's rewrite rule, which sends every request
 * (not just paths Vercel could infer from this file's name alone) to
 * this single handler, so Express's own internal router sees the
 * full original path and can dispatch correctly.
 * ------------------------------------------------------------------
 */

const app = require('../backend/app');

module.exports = app;
