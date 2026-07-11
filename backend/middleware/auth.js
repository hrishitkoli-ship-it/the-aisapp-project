/**
 * auth.js
 * ------------------------------------------------------------------
 * Two request "identities" exist in this system:
 *
 *   1. THE HUMAN  - using the browser UI, no token required at all
 *      (there is no cloud login; the phone/device itself is the
 *      trust boundary, per the "no Google login" requirement).
 *
 *   2. AN AI AGENT - an external process calling the API with
 *      `Authorization: Bearer <project-token>`. Must present a valid
 *      token for the specific project it's trying to touch.
 *
 * This distinction is what makes the "AI Session Roster is read-only
 * for the user, read/write for AIs" rule enforceable: the roster
 * write routes require requireAIToken, while the roster read route
 * is open to anyone who can see the project (the human browsing it).
 *
 * requireAIToken also attaches `req.session` info (which AI session
 * this token maps to, if the caller identified one) so route handlers
 * can log "who did this" in the activity timeline.
 *
 * CHANGED: store.getProject() is now async (Postgres-backed -- see
 * db/store.js), so both middleware functions below are now async
 * too, and safeGetProject is awaited at both call sites. This file
 * is the single busiest chokepoint in the app (every route passes
 * through one of these two functions), so getting the await right
 * here specifically was the highest-value place to double check.
 * ------------------------------------------------------------------
 */

const store = require('../db/store');
const { verifyToken } = require('../utils/tokens');

/** Extracts a Bearer token from the Authorization header, or null. */
function extractBearer(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * SECURITY: store.getProject() can throw store.InvalidProjectIdError for
 * a malformed projectId (see db/store.js's assertValidProjectId). Both
 * middleware functions below are the one chokepoint every route in the
 * app passes through, so this is the highest-value place to catch it.
 */
async function safeGetProject(req, res, projectId) {
  try {
    return { project: await store.getProject(projectId) };
  } catch (err) {
    if (err instanceof store.InvalidProjectIdError) {
      console.warn(
        `[security] Blocked a request with an unsafe projectId ` +
        `(path: "${projectId}"): ${err.message}`
      );
      res.status(400).json({ error: 'Invalid project id.' });
      return { project: null, handled: true };
    }
    throw err;
  }
}

/**
 * Middleware: require a valid AI token scoped to :projectId.
 * On success, sets req.isAI = true and req.tokenValid = true.
 * On failure, responds 401/403 and does not call next().
 */
async function requireAIToken(req, res, next) {
  try {
    const { projectId } = req.params;
    const { project, handled } = await safeGetProject(req, res, projectId);
    if (handled) return; // response already sent by safeGetProject

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({
        error: 'Missing AI token. Provide "Authorization: Bearer <token>".',
      });
    }

    if (!verifyToken(token, project.tokenHash)) {
      return res.status(403).json({ error: 'Invalid or revoked AI token.' });
    }

    req.isAI = true;
    req.project = project;

    // Optional: the caller may self-identify as a specific session via
    // this header, so activity/roster writes can be attributed to them.
    req.callerSessionId = req.headers['x-session-id'] || null;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: just loads the project for human (browser) requests and
 * 404s if it doesn't exist. No token required -- this is the local,
 * no-cloud-login path for the person using the app on their own device.
 */
async function loadProjectForHuman(req, res, next) {
  try {
    const { projectId } = req.params;
    const { project, handled } = await safeGetProject(req, res, projectId);
    if (handled) return; // response already sent by safeGetProject

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    req.project = project;
    req.isAI = false;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAIToken, loadProjectForHuman, extractBearer };
