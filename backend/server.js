/**
 * server.js
 * ------------------------------------------------------------------
 * Local/Termux dev entry point -- unchanged workflow from before
 * this migration (`npm start` / `npm run dev` / `node backend/server.js`
 * all still work exactly as before). All actual app configuration
 * now lives in app.js (see that file's header for why); this file
 * just adds the app.listen() call that only makes sense for a real,
 * persistent local process -- NOT for Vercel, which uses
 * api/index.js instead and never calls .listen() at all.
 * ------------------------------------------------------------------
 */

const app = require('./app');

const PORT = process.env.PORT || 7077;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  AI Collaborative Hub is running
  --------------------------------
  Local:   http://localhost:${PORT}
  `);
});
