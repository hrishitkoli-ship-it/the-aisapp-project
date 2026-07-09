/**
 * server.js
 * ------------------------------------------------------------------
 * Entry point. Wires up:
 *   - JSON body parsing + CORS (so an external AI process running
 *     anywhere on the same device/network can call the API)
 *   - Human-facing routes under /api/projects/...
 *   - AI-facing (token-gated) routes under /api/ai/...
 *   - Static frontend serving (the PWA itself)
 *
 * Run with: node backend/server.js
 * Or:       npm start
 * ------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

const projectsRoutes = require('./routes/projects');
const filesRoutes = require('./routes/files');
const sessionsRoutes = require('./routes/sessions');
const instructionsRoutes = require('./routes/instructions');
const activityRoutes = require('./routes/activity');

const app = express();
const PORT = process.env.PORT || 7077;

app.use(cors()); // Local tool, single device -- open CORS is fine here.
app.use(express.json({ limit: '15mb' })); // generous limit for pasted code files

// -----------------------------------------------------------------
// Human-facing API (browser UI). No token required -- see auth.js
// header comment for why: the device itself is the trust boundary.
// -----------------------------------------------------------------
app.use('/api/projects', projectsRoutes);
app.use('/api/projects/:projectId/files', filesRoutes.humanRouter);
app.use('/api/projects/:projectId/sessions', sessionsRoutes.humanRouter);
app.use('/api/projects/:projectId/instructions', instructionsRoutes.humanRouter);
app.use('/api/projects/:projectId/activity', activityRoutes.humanRouter);

// -----------------------------------------------------------------
// AI-facing API (external agents). Every route here requires
// "Authorization: Bearer <project-token>".
// -----------------------------------------------------------------
app.use('/api/ai/:projectId/files', filesRoutes.aiRouter);
app.use('/api/ai/:projectId/sessions', sessionsRoutes.aiRouter);
app.use('/api/ai/:projectId/instructions', instructionsRoutes.aiRouter);
app.use('/api/ai/:projectId/activity', activityRoutes.aiRouter);

// -----------------------------------------------------------------
// Frontend static files (the PWA)
// -----------------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR, {
  setHeaders: (res, filePath) => {
    // Service worker must never be cached, or updates to it won't be
    // picked up by devices that already installed the PWA.
    if (filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback: any non-API GET request serves index.html so client-side
// routing (#/project/:id/workspace etc.) works on refresh.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Basic error handler so a thrown error becomes JSON, not an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.', detail: err.message });
});

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
  console.log('  AI Collaborative Hub is running');
  console.log('  --------------------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (lan) {
    console.log(`  Network: http://${lan}:${PORT}   (use this for other devices / AI agents on same network)`);
  }
  console.log('');
});
