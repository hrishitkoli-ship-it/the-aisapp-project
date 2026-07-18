/**
 * rateLimit.js
 * ------------------------------------------------------------------
 * Rate limiting, added as part of Session 4's security & safety work
 * once the human confirmed this app is moving toward a public Vercel
 * deployment (see INSTRUCTIONS.md's Turso/Vercel migration notes for
 * the fuller context on why the trust model is shifting).
 *
 * WHY THIS WASN'T NEEDED BEFORE: the original design (see auth.js's
 * own header comment, and INSTRUCTIONS.md's "no cloud auth, device is
 * the boundary" language) assumed the only realistic caller was the
 * human's own device or an AI agent on the same LAN. Rate limiting a
 * closed LAN tool mostly protects against a buggy local script, not a
 * hostile stranger. Once this server.js can be reached from the open
 * internet (server.js binds 0.0.0.0 by design -- see its own comment
 * for why -- which was correct as a LAN-reachability choice and is
 * now ALSO the exact mechanism by which "public" becomes possible),
 * that calculus changes: unauthenticated human-facing routes
 * (POST /api/projects, DELETE /api/device, etc.) become reachable by
 * literally anyone, and rate limiting is one of the few defenses that
 * doesn't require solving "add real authentication to human routes"
 * first (a much bigger, deliberately NOT-taken-on-here architecture
 * change -- see SECURITY.md for why that's flagged as a separate,
 * bigger decision rather than silently done as part of this).
 *
 * DESIGN: this app's real traffic shape is unusual for a rate-limiter
 * to protect well by default -- an AI agent legitimately reading many
 * files in a row, or polling the roster/activity feed, produces a
 * burst pattern that would look like abuse to a generically-tuned
 * limiter. Three separate tiers exist instead of one blanket limit:
 *
 *   1. aiSurfaceLimiter  - IP-keyed, runs BEFORE requireAIToken on
 *      every AI route. This is the one that actually stops
 *      token-brute-forcing: if it ran AFTER auth (keyed by the
 *      now-known project), an attacker spamming wrong tokens would
 *      never trip a per-project limiter, since they'd never have a
 *      valid project to be keyed by. Deliberately generous -- its job
 *      is "stop somebody hammering guesses," not "constrain normal
 *      traffic," which the next tier handles.
 *   2. aiWorkLimiter     - project-keyed (via req.project.id, which
 *      only exists AFTER requireAIToken succeeds), tighter, and scoped
 *      to what a legitimate agent actually does (file ops, roster
 *      polling). Keying by project rather than IP means two different
 *      agents on the same LAN (a realistic setup for this app) don't
 *      share one bucket and throttle each other.
 *   3. humanSensitiveLimiter - IP-keyed, applied ONLY to the human
 *      routes that create or destroy real state (project creation,
 *      project deletion, device deletion, token regeneration) rather
 *      than the whole human surface -- a human browsing their own
 *      project list or reading activity shouldn't ever be rate-limited
 *      just for using the app normally; the concern here is scripted
 *      abuse of the routes that cost the most to abuse (deletion,
 *      especially the device-delete cascade, and token regen, which
 *      invalidates a working credential).
 *
 * A fourth, very generous global limiter also exists (see server.js)
 * purely as the "make sure the app doesn't crash" backstop the human
 * asked for directly -- not abuse-detection, just a hard ceiling
 * against any runaway loop (buggy code on either side of the API)
 * from exhausting the process. It's intentionally loose enough that
 * hitting it during real use should be close to impossible, and tight
 * enough that a genuine infinite-loop bug hits it before doing real
 * damage.
 *
 * STORE: in-memory (express-rate-limit's default MemoryStore). This
 * is the same tradeoff the JSON-file store originally made -- correct
 * for a single Node process, NOT correct for multiple serverless
 * function instances running concurrently (each Vercel invocation can
 * be a cold, separate process with its own memory, so limits don't
 * actually aggregate across them the way they would on one long-running
 * server). Documented explicitly in SECURITY.md rather than presented
 * as solved -- a real fix needs a shared store (Redis, or a Turso
 * table now that Session 2 is wiring that up) keyed the same way these
 * limiters already are, which is a natural follow-up once Turso
 * migration lands, not before.
 * ------------------------------------------------------------------
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/** Shared response shape for every limiter below, so a rate-limited
 *  caller (human or AI) gets a real, parseable JSON body -- same
 *  convention as every other error response in this app -- rather
 *  than express-rate-limit's default plain-text response. */
function rateLimitResponse(req, res) {
  res.status(429).json({
    error: 'Too many requests. Please slow down and try again shortly.',
  });
}

/**
 * Tier 1: pre-auth, IP-keyed, applied to every /api/ai/:projectId/*
 * route BEFORE requireAIToken runs. Stops token brute-forcing /
 * auth-endpoint hammering, which a post-auth (project-keyed) limiter
 * structurally cannot catch, since an attacker without a valid token
 * never has a project to be keyed by.
 *
 * LIMIT CHOICE, and a real bug this fixes: this limiter and
 * aiWorkLimiter both run on the same request path, in sequence
 * (aiSurfaceLimiter mounted in app.js before each AI router;
 * aiWorkLimiter mounted inside the router right after requireAIToken
 * -- CORRECTED here from an earlier version of this comment that said
 * "server.js": that was accurate when this was written, but server.js
 * no longer mounts any routes at all, having since been rewritten into
 * a thin wrapper around app.js's shared definition, see that file's
 * own header for why) -- they are NOT alternatives, they STACK, so whichever has the lower ceiling
 * always wins for any single client. This was originally set to 100,
 * intended as "generous, just needs to stop hammering" -- but tested
 * live against a single legitimate project with a valid token (the
 * realistic common case: one agent, one project, one IP) and found it
 * silently capped ALL AI traffic at 100/min, well under aiWorkLimiter's
 * intended 300/min allowance for real bursts (reading a whole file
 * tree, polling roster/activity). The number below (1000) is
 * deliberately well above aiWorkLimiter's ceiling for exactly this
 * reason -- its job is catching a single IP hammering across MANY
 * projects/tokens (real brute-forcing), not constraining one
 * project's legitimate traffic, which aiWorkLimiter already governs
 * more precisely via its project-scoped key.
 */
const aiSurfaceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: rateLimitResponse,
});

/**
 * Tier 2: post-auth, project-keyed. Only usable on routes that run
 * AFTER requireAIToken (req.project must already be set), which is
 * every route this is actually applied to in server.js.
 */
const aiWorkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300, // higher than the human tier on purpose -- legitimate
              // agent bursts (reading a whole file tree, polling
              // roster/activity) are a real, expected pattern here,
              // not an edge case to squeeze down
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // req.project is guaranteed set here -- this limiter is only ever
    // applied after requireAIToken in the route chain (see server.js).
    // Falling back to IP if it's somehow missing rather than throwing:
    // a rate limiter erroring out and taking the request down with it
    // would be a worse outcome than just falling back to a coarser key.
    return req.project ? `project:${req.project.id}` : ipKeyGenerator(req.ip);
  },
  handler: rateLimitResponse,
});

/**
 * Tier 3: IP-keyed, applied only to specific destructive/sensitive
 * human-facing routes (see server.js for exactly which), not the
 * whole human surface. A human normally using their own project list
 * should never see a 429.
 */
const humanSensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20, // tighter -- these are the routes with the highest cost
             // per abused call (create-spam, delete, cascade-delete,
             // token invalidation), and a real human doing this
             // manually would never hit 20/minute anyway
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: rateLimitResponse,
});

/**
 * The global backstop (see server.js for where this mounts). Loose on
 * purpose -- see this file's header comment for why this exists
 * separately from the three tiers above.
 */
const globalBackstopLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: rateLimitResponse,
});

module.exports = {
  aiSurfaceLimiter,
  aiWorkLimiter,
  humanSensitiveLimiter,
  globalBackstopLimiter,
};
