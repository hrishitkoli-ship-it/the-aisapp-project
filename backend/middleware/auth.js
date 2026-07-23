/**
 * auth.js
 * ------------------------------------------------------------------
 * Two request "identities" exist in this system:
 *
 *   1. THE HUMAN  - using the browser UI. Originally: no token
 *      required at all (there is no cloud login; the phone/device
 *      itself is the trust boundary, per the "no Google login"
 *      requirement). THIS HAS PARTIALLY CHANGED, this session: see
 *      requireDeviceSecret below and SECURITY.md §3b, which flagged
 *      this exact gap as open until now. WRITE routes (create/delete
 *      a project, delete-cascade the device, regenerate a token) now
 *      require a device secret. READ routes (list/view projects,
 *      activity, instructions) remain open -- the risk was always the
 *      destructive actions, not visibility.
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
 * CORRECTION (found live, not assumed -- see KNOWN_ISSUES.md /
 * Known Failure Signature #6): the "now async, Postgres-backed" claim
 * below was never true -- store.js is still the original fs-based
 * datastore, same as routes/projects.js's comments wrongly claimed a
 * Turso schema that didn't exist either. Awaiting a synchronous
 * function is harmless in JS (resolves immediately, same value), so
 * this specific mismatch never caused a functional bug here, unlike
 * the projects.js case -- verified live with a real composite token
 * against requireAIToken and loadProjectForHuman, both work correctly.
 * Leaving `await` in place costs nothing and means this file needs no
 * further change whenever store.js's storage layer actually changes.
 *
 * UPDATE (Session 4, later same session): store.js genuinely is
 * Turso-backed now -- the "correction" above described a real, but
 * since-resolved, mismatch. Left in place as a historical record
 * rather than deleted, matching this file's own established practice
 * of documenting past mismatches rather than silently erasing them
 * once fixed (see routes/projects.js and its own regression history
 * in KNOWN_ISSUES.md for why that practice exists).
 * ------------------------------------------------------------------
 */

const store = require('../db/store');
const { verifyToken, parseCompositeToken, generateDeviceCode, generateDeviceSecret, hashToken } = require('../utils/tokens');

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

    const rawToken = extractBearer(req);
    if (!rawToken) {
      return res.status(401).json({
        error: 'Missing AI token. Provide "Authorization: Bearer <token>".',
      });
    }

    // Composite tokens carry a content-encryption key and (newer
    // tokens) a project id after '.'-delimiters -- see tokens.js.
    // The server only ever verifies the auth part against this
    // project's own tokenHash; the encryption key is client-side-only
    // and never used here. Bare tokens (no '.') and older two-segment
    // tokens (no projectId) both parse through unchanged, so this
    // stays backward-compatible with anything issued before either
    // addition existed.
    const { authToken, encryptionKey, projectId: tokenProjectId } = parseCompositeToken(rawToken);

    // Not a security check -- tokenHash below already scopes a token
    // to exactly the project it was issued for, regardless of this.
    // This exists purely for a clearer error on a plausible mistake:
    // an AI agent that extracts $PROJECT_ID from one token but
    // constructs a request using a DIFFERENT project's URL (copy-paste
    // slip, working across multiple projects at once) would otherwise
    // just get a generic "invalid token" back, with no hint that the
    // fix is "use the projectId embedded in the token you're actually
    // sending," not "get a new token." Skipped entirely for tokens
    // with no embedded projectId (older format) -- nothing to compare.
    if (tokenProjectId && tokenProjectId !== projectId) {
      return res.status(403).json({
        error:
          `This token is scoped to project "${tokenProjectId}" (per its own embedded ` +
          `project id), but you requested project "${projectId}". Use the projectId ` +
          `segment from the SAME token you're sending -- split it on "." and take ` +
          `index 2, not a different value.`,
      });
    }

    if (!verifyToken(authToken, project.tokenHash)) {
      return res.status(403).json({ error: 'Invalid or revoked AI token.' });
    }

    req.isAI = true;
    req.project = project;
    // NOT used by the server for anything -- exposed only so a route
    // handler could theoretically log "this caller has encryption
    // configured" for debugging. The server never encrypts or
    // decrypts on a caller's behalf; that stays entirely client-side.
    req.callerEncryptionKeyPresent = !!encryptionKey;

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

/**
 * SECURITY: gates human-facing WRITE routes (create/delete a project,
 * delete-cascade the device, regenerate a token) behind a per-device
 * secret, now that this app is moving toward a public deployment where
 * "the device is the boundary" can no longer mean "anyone who can
 * reach the server" (see SECURITY.md §3b, which flagged this exact
 * gap as open and undecided until now).
 *
 * Deliberately NOT applied to read routes (list/view projects,
 * activity, instructions) -- a human should be able to browse their
 * own data without re-entering a secret on every page load; the risk
 * this closes is destructive/costly actions, not visibility.
 *
 * Presented the same way AI tokens are: "X-Device-Secret: <raw secret>"
 * header, compared via the same constant-time verifyToken/hashToken
 * pair everything else in this file already uses -- not a new
 * comparison mechanism, reusing the one already proven correct.
 *
 * LAZY CREATION, not fail-closed-on-missing -- this needed real
 * thought, not just copying the AI-token pattern: server.js (local/
 * Termux) runs as one long-lived process, so a boot-time creation
 * step could work cleanly there. api/index.js (Vercel) has no
 * equivalent "boot" moment a human would ever see -- each invocation
 * is a per-request, potentially cold-started function, and Vercel's
 * own logs aren't a channel a human necessarily has open the way a
 * local terminal is. Failing closed here (a hard 503 until *something
 * else* creates the secret) would mean the Vercel path could never
 * actually succeed at all, since nothing else ever runs there first.
 * So instead: if no secret exists yet when a write is first attempted,
 * this middleware creates one on the spot (via
 * store.getOrCreateDeviceSecretHash, which also handles the case
 * where no device row exists at all yet -- see that function's own
 * comment in store.js) and returns it directly in the 401 body (not
 * just a generic "invalid secret" message) so the FIRST caller -- who,
 * on a fresh install, is virtually certainly the human themselves,
 * setting the app up for the first time -- gets it back immediately
 * and can retry with it. Every subsequent caller without the correct
 * secret gets the normal generic rejection, no secret value included.
 */
async function requireDeviceSecret(req, res, next) {
  try {
    const device = await store.getDevice();

    if (!device || !device.deviceSecretHash) {
      const { raw } = await store.getOrCreateDeviceSecretHash(
        generateDeviceCode,
        generateDeviceSecret,
        hashToken
      );
      console.log('');
      console.log('  A device secret was just created (first write request received).');
      console.log('  Save this now -- it will not be shown again:');
      console.log(`  ${raw}`);
      console.log('');
      return res.status(401).json({
        error: 'No device secret existed yet, so one was just created. Save it now -- it will not be shown again -- and retry this request with "X-Device-Secret: <secret>".',
        deviceSecret: raw,
      });
    }

    const provided = req.headers['x-device-secret'];
    if (!provided || !verifyToken(provided, device.deviceSecretHash)) {
      return res.status(401).json({
        error: 'Missing or invalid device secret. Provide "X-Device-Secret: <secret>".',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAIToken, loadProjectForHuman, extractBearer, requireDeviceSecret };
