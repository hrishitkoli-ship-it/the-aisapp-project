/**
 * routes/githubIntegration.js
 * ------------------------------------------------------------------
 * #13 -- "Connect a GitHub repo per project, push files directly
 * (OAuth or PAT)."
 *
 * PAT-only, not OAuth. OAuth needs a registered GitHub OAuth App
 * (client ID/secret, callback URL) -- an external registration step
 * outside what a dev sandbox can do on its own, and a real ongoing
 * maintenance surface (token refresh, revocation) for a solo-dev
 * local-first tool. Explicitly scoping down to PAT rather than
 * silently half-building OAuth or blocking on it -- same call this
 * file's own INSTRUCTIONS.md already makes for other items ("session's
 * call given they own the ... logic already").
 *
 * Human-facing only -- no aiRouter. Connecting a repo means handing
 * this app a credential that can write to the human's GitHub account;
 * that's a decision a human makes deliberately in the UI, not
 * something an AI session should be able to trigger by calling an
 * API route autonomously. (An AI session CAN still request a push
 * happen, same as any other request -- by asking the human via the
 * roster's request-queue, same channel as everything else that needs
 * human judgment in this app.)
 *
 * STORAGE: nested in the existing `project` JSON blob
 * (project.github = {...}) -- no schema migration needed, same
 * pattern as instructions.js's `data.notes`. The GitHub token itself
 * is encrypted at rest via secretCrypto.js (server-held key, NOT
 * contentCrypto.js's client-held-key scheme -- see that file's
 * header for why these are deliberately separate modules with
 * different threat models). stripSecret() in routes/projects.js
 * strips project.github.encryptedToken from every project response
 * that flows through the human-facing list/get/regenerate-token
 * routes; this file's own responses never include it either, built
 * as an explicit allowlist rather than relying solely on that strip.
 *
 * KNOWN LIMITATION, not fixed here: if a project's files were written
 * by an AI session using the OPTIONAL per-agent content encryption
 * (contentCrypto.js, keyed by the composite token's encryption-key
 * suffix), this server can never decrypt that content -- confirmed by
 * reading middleware/auth.js directly: the encryption key is parsed
 * out of the caller's Authorization header per-request into
 * `req.callerEncryptionKeyPresent` (a boolean) and never stored,
 * never passed to store.js, never held anywhere past that one
 * request. That's the zero-knowledge design working as intended for
 * file content -- but it means a push of such a file pushes the raw
 * ciphertext to GitHub, not readable source. No auto-detection is
 * attempted (ciphertext is indistinguishable from opaque text without
 * a marker this app doesn't add). Out of scope for this MVP; a real
 * fix would mean the human supplying that project's encryption key
 * specifically at push time, a meaningfully bigger feature than
 * "optional, ship last" calls for.
 * ------------------------------------------------------------------
 */

'use strict';

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const fileOps = require('../utils/fileOps');
const { loadProjectForHuman } = require('../middleware/auth');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');

const humanRouter = express.Router({ mergeParams: true });
humanRouter.use(loadProjectForHuman);

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'aisapp (github.com/hrishitkoli-ship-it/the-aisapp-project)'; // GitHub's API 403s any request with no User-Agent

// Conservative guards on a single push -- GitHub's Git Data API has no
// documented hard per-request file-count limit, but sequential blob
// creation (see pushFiles below) gets slow and rate-limit-risky well
// before either of these numbers, so failing fast with a clear message
// beats a timeout or a silent partial push.
const MAX_PUSH_FILES = 300;
const MAX_PUSH_TOTAL_BYTES = 20 * 1024 * 1024; // 20MB

function githubSafeSummary(project) {
  if (!project.github) return { connected: false };
  const { encryptedToken, ...safe } = project.github;
  return { connected: true, ...safe };
}

async function githubFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no/non-JSON body -- fine for e.g. a 204
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------
// GET / -- connection status, no secret
// ---------------------------------------------------------------------
humanRouter.get('/', (req, res) => {
  res.json(githubSafeSummary(req.project));
});

// ---------------------------------------------------------------------
// POST /connect -- validates the PAT actually has access to the named
// repo before storing anything (fail loud at connect time, not
// silently at the first push attempt).
// ---------------------------------------------------------------------
humanRouter.post('/connect', async (req, res, next) => {
  try {
    const { owner, repo, branch, token } = req.body || {};
    if (!owner || !repo || !token) {
      return res.status(400).json({ error: 'owner, repo, and token are all required.' });
    }
    const cleanOwner = String(owner).trim();
    const cleanRepo = String(repo).trim().replace(/\.git$/, '');
    const cleanBranch = (branch && String(branch).trim()) || 'main';

    const check = await githubFetch(`${GITHUB_API}/repos/${cleanOwner}/${cleanRepo}`, token);
    if (!check.ok) {
      const reason =
        check.status === 404
          ? "Repo not found, or this token doesn't have access to it."
          : check.status === 401
            ? 'GitHub rejected this token as invalid.'
            : (check.body && check.body.message) || `GitHub returned ${check.status}.`;
      return res.status(400).json({ error: `Couldn't verify repo access: ${reason}` });
    }
    if (check.body && check.body.permissions && check.body.permissions.push === false) {
      return res.status(400).json({ error: "This token has read access but not push access to this repo." });
    }

    const project = req.project;
    project.github = {
      owner: cleanOwner,
      repo: cleanRepo,
      branch: cleanBranch,
      encryptedToken: encryptSecret(token),
      connectedAt: new Date().toISOString(),
      lastPushAt: null,
      lastPushCommitSha: null,
    };
    await store.saveProject(req.params.projectId, project);
    await store.appendActivity(req.params.projectId, {
      id: nanoid(8),
      type: 'github_connected',
      message: `Connected GitHub repo ${cleanOwner}/${cleanRepo} (${cleanBranch})`,
      actor: 'human',
      timestamp: new Date().toISOString(),
    });

    res.status(201).json(githubSafeSummary(project));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// DELETE / -- disconnect
// ---------------------------------------------------------------------
humanRouter.delete('/', async (req, res, next) => {
  try {
    const project = req.project;
    if (!project.github) return res.json({ connected: false });
    delete project.github;
    await store.saveProject(req.params.projectId, project);
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// POST /push -- the actual push. Git Data API flow (blobs -> tree ->
// commit -> ref update) for one atomic commit, not N sequential
// Contents-API PUTs (which would be N separate commits and isn't
// atomic -- a failure partway through would leave the repo with only
// some files updated).
// ---------------------------------------------------------------------
humanRouter.post('/push', async (req, res, next) => {
  try {
    const project = req.project;
    if (!project.github) {
      return res.status(400).json({ error: 'No GitHub repo connected for this project yet.' });
    }
    const { owner, repo, branch, encryptedToken } = project.github;
    let token;
    try {
      token = decryptSecret(encryptedToken);
    } catch (err) {
      // Genuinely shouldn't happen unless AISAPP_SECRET_KEY changed
      // since connect-time -- surfaced clearly rather than as a
      // generic 500, since "reconnect the repo" is the correct and
      // only fix.
      return res.status(409).json({
        error: "Couldn't decrypt the stored GitHub token (server's secret key may have changed since this repo was connected). Reconnect the repo.",
      });
    }

    const tree = await fileOps.buildFileTree(req.params.projectId);
    const filePaths = [];
    (function flatten(nodes) {
      for (const node of nodes || []) {
        if (node.type === 'file') filePaths.push({ path: node.path, size: node.size || 0 });
        else if (node.children) flatten(node.children);
      }
    })(tree);

    if (filePaths.length === 0) {
      return res.status(400).json({ error: 'No files in this project to push.' });
    }
    if (filePaths.length > MAX_PUSH_FILES) {
      return res.status(413).json({ error: `${filePaths.length} files exceeds the ${MAX_PUSH_FILES}-file push limit.` });
    }
    const totalBytes = filePaths.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_PUSH_TOTAL_BYTES) {
      return res.status(413).json({ error: `Total size ${totalBytes} bytes exceeds the ${MAX_PUSH_TOTAL_BYTES}-byte push limit.` });
    }

    // 1. Current branch tip (may not exist yet -- brand-new empty repo)
    const refResult = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
    const branchExists = refResult.ok;
    const baseCommitSha = branchExists ? refResult.body.object.sha : null;

    let baseTreeSha = null;
    if (baseCommitSha) {
      const baseCommit = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, token);
      if (!baseCommit.ok) throw new Error(`Couldn't read base commit: ${baseCommit.status}`);
      baseTreeSha = baseCommit.body.tree.sha;
    }

    // 2. One blob per file, in parallel (#3's pattern: Promise.all for
    //    genuinely independent network calls instead of a sequential loop)
    const contents = await Promise.all(
      filePaths.map(async ({ path }) => ({
        path,
        content: await fileOps.readFileContent(req.params.projectId, path),
      }))
    );
    const blobs = await Promise.all(
      contents.map(async ({ path, content }) => {
        const blobRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, token, {
          method: 'POST',
          body: JSON.stringify({ content: Buffer.from(content ?? '', 'utf8').toString('base64'), encoding: 'base64' }),
        });
        if (!blobRes.ok) throw new Error(`Blob create failed for ${path}: ${blobRes.status}`);
        return { path, sha: blobRes.body.sha };
      })
    );

    // 3. One tree referencing every blob
    const treeRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha || undefined,
        tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
      }),
    });
    if (!treeRes.ok) throw new Error(`Tree create failed: ${treeRes.status}`);

    // 4. One commit
    const commitRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message: `aisapp: push ${blobs.length} file${blobs.length === 1 ? '' : 's'}`,
        tree: treeRes.body.sha,
        parents: baseCommitSha ? [baseCommitSha] : [],
      }),
    });
    if (!commitRes.ok) throw new Error(`Commit create failed: ${commitRes.status}`);
    const newCommitSha = commitRes.body.sha;

    // 5. Move the branch ref -- POST (create) if the branch didn't
    //    exist yet, PATCH (update) if it did.
    const refUpdateRes = branchExists
      ? await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommitSha }),
        })
      : await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, token, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommitSha }),
        });
    if (!refUpdateRes.ok) throw new Error(`Ref update failed: ${refUpdateRes.status}`);

    project.github.lastPushAt = new Date().toISOString();
    project.github.lastPushCommitSha = newCommitSha;
    await store.saveProject(req.params.projectId, project);
    await store.appendActivity(req.params.projectId, {
      id: nanoid(8),
      type: 'github_push',
      message: `Pushed ${blobs.length} file${blobs.length === 1 ? '' : 's'} to ${owner}/${repo}@${branch} (${newCommitSha.slice(0, 7)})`,
      actor: 'human',
      timestamp: new Date().toISOString(),
    });

    res.json({
      commitSha: newCommitSha,
      htmlUrl: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
      filesPushed: blobs.length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { humanRouter };
