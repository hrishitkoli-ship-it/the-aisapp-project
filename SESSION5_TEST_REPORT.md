# Session 5 — Test & Integration Report

**Date:** 2026-07-09  
**Scope:** Smoke tests, conflict detection, permission boundaries, README drift, path traversal

---

## Summary

Backend is solid. All critical security properties hold. Two minor issues found: one README doc gap and one note about unlogged "plain" traversal attempts (expected behavior, documented below). No code changes needed unless you want to fix the README gap.

**Result: PASS with 2 low-priority findings.**

---

## Test Results

### Route Smoke Tests (all routes, fresh project)

| Route | Method | Result |
|---|---|---|
| `POST /api/projects` | Human | ✅ 201 + token in body, tokenHash stripped |
| `GET /api/projects` | Human | ✅ 200, returns index list |
| `GET /api/projects/:id` | Human | ✅ 200, no tokenHash exposed |
| `GET /api/projects/nonexistent` | Human | ✅ 404 |
| `POST /api/projects/:id/regenerate-token` | Human | ✅ New token returned, old token immediately invalid (verified) |
| `DELETE /api/projects/:id` | Human | ✅ Removes project |
| `GET /api/projects/:id/files/tree` | Human | ✅ 200 |
| `GET /api/projects/:id/files/content/*` | Human | ✅ 200 file / 404 missing |
| `PUT /api/projects/:id/files/content/*` | Human | ✅ 200 write |
| `DELETE /api/projects/:id/files/content/*` | Human | ✅ 200 delete / 404 missing |
| `GET /api/projects/:id/sessions` | Human | ✅ Read-only, returns list |
| `POST /api/projects/:id/sessions` | Human | ✅ **404 — write route doesn't exist on humanRouter** |
| `GET /api/projects/:id/instructions` | Human | ✅ 200 |
| `PUT /api/projects/:id/instructions/notes` | Human | ✅ 200 |
| `POST /api/projects/:id/instructions/functionalities` | Human | ✅ 201 |
| `POST /api/projects/:id/instructions/assignments` | Human | ✅ 201, status=pending |
| `POST /api/projects/:id/instructions/assignments/:id/approve` | Human | ✅ 200, flips approved=true |
| `POST /api/projects/:id/instructions/assignments/:id/reject` | Human | ✅ 200 |
| `GET /api/projects/:id/activity` | Human | ✅ 200 |
| `GET /api/ai/:id/files/tree` | AI | ✅ 200 |
| `GET /api/ai/:id/files/content/*` | AI | ✅ 200 file / 404 missing |
| `PUT /api/ai/:id/files/content/*` | AI | ✅ 200 write |
| `DELETE /api/ai/:id/files/content/*` | AI | ✅ 200 delete |
| `GET /api/ai/:id/sessions` | AI | ✅ 200 |
| `POST /api/ai/:id/sessions` | AI | ✅ 201 register/upsert |
| `PATCH /api/ai/:id/sessions/:sessionId` | AI | ✅ 200 update currentTask/function/status |
| `POST /api/ai/:id/sessions/:sessionId/requests` | AI | ✅ 201, queued to target |
| `PATCH /api/ai/:id/sessions/:sessionId/requests/:requestId` | AI | ✅ 200 status update |
| `GET /api/ai/:id/instructions` | AI | ✅ 200 |
| `POST /api/ai/:id/instructions/functionalities` | AI | ✅ 201, createdBy=AI:sessionId |
| `POST /api/ai/:id/instructions/assignments` | AI | ✅ 201, status=pending always |
| `POST /api/ai/:id/instructions/assignments/:id/approve` | AI | ✅ **404 — route not on aiRouter** |
| `POST /api/ai/:id/instructions/assignments/:id/reject` | AI | ✅ **404 — route not on aiRouter** |
| `GET /api/ai/:id/activity` | AI | ✅ 200 |

### Auth / Token Tests

- **No token on AI route** → `401 "Missing AI token"` ✅
- **Bad token on AI route** → `403 "Invalid or revoked AI token"` ✅
- **Token regen** → old token immediately returns 403, new token works ✅
- **tokenHash never exposed** in any project response ✅
- **X-Session-Id attribution** → `actor: "AI:ses5"` logged correctly in activity ✅

### Conflict Detection (end-to-end)

1. Write v1 → `{version: 1}` ✅  
2. Write v2 with `expectedVersion: 1` → `{version: 2}` ✅  
3. Write with stale `expectedVersion: 1` → `409` with `currentVersion`, `lastModifiedBy`, `lastModifiedAt` ✅  
4. Write with stale version + `force: true` → `{version: 3}` ✅  

### Permission Boundaries (structural, not just UI)

- **AI token → approve endpoint** returns `404` (route doesn't exist on aiRouter) — **not 403**. This is exactly what INSTRUCTIONS.md specifies: "confirm an AI token genuinely gets `404` (route not found) hitting an approve endpoint, not just `403`." ✅
- **Human → session write** returns `404` (route doesn't exist on humanRouter) ✅

### Path Traversal

- **Plain `../../etc/passwd` in URL** → Express normalizes the path before routing, so the request hits the SPA fallback and returns `200 index.html`. This is **not a security bug** — the actual file `/etc/passwd` is never read and the SPA shell is returned. However, these attempts are NOT logged as `security_alert` because `safeResolve()` is never called — the URL never reaches the route handler. (See Finding 2 below.)
- **URL-encoded `%2e%2e%2fetc%2fpasswd`** → `400` with error message, AND correctly logged as `security_alert` in activity timeline ✅
- **URL-encoded write `%2e%2e%2fevil.txt`** → `400` blocked, logged as `security_alert` ✅

---

## Findings

### Finding 1 — README doc gap (low priority)

`README.md` documents the session register/read/request routes but omits two endpoints that exist and work:

- `PATCH /api/ai/:projectId/sessions/:sessionId` — update currentTask/function/status
- `PATCH /api/ai/:projectId/sessions/:sessionId/requests/:requestId` — mark a queued request done/dismissed

All other documented route examples were verified against live behavior — no drift. Fix: add these two to the README's "Connecting an external AI agent" section.

### Finding 2 — Plain (non-encoded) `../../` traversal not logged (low priority, expected)

If an attacker (or buggy agent) sends `GET /files/content/../../etc/passwd` with unencoded dots and slashes, Express normalizes the URL path before routing — the request never reaches the route handler, so `safeResolve()` never fires, so no `security_alert` is logged. The actual file is never accessed (the request just hits the SPA fallback).

README currently says "including percent-encoded traversal attempts" — this is accurate, but implies non-encoded ones ARE logged, which they're not.

**Is this a real problem?** No — the data is safe either way. But the security_alert logging guarantee in the README is slightly overstated for the non-encoded case. Options:
1. Add a note to the README clarifying that logging only applies to encoded attempts.
2. Add a middleware that catches raw `..` segments before Express normalizes them (low complexity, but extra code for a local-only tool).
3. Leave it. The primary value of security_alert logging is watching AI agent behavior — an AI agent calling the API will produce URL-encoded paths, not raw `../`.

Recommend option 1 (clarify docs) or option 3 (leave it).

---

## Validation Checks (misc)

- `POST /api/projects` without `name` → `400 "Project name is required"` ✅
- `PUT /files/content/*` without `content` field → `400 "content (string) is required"` ✅
- `.versions.json` does NOT appear in any file tree output ✅
- Activity log entries include `id`, `type`, `actor`, `message`, `timestamp` on all event types ✅
- Activity is capped at 1000 entries (confirmed in store.js, not load-tested) ✅
- `withLock` in store.js chains promises per-key, protecting concurrent JSON writes ✅
- Token comparison uses `crypto.timingSafeEqual` — no `===` token comparison anywhere in codebase ✅

---

## README Accuracy (cross-check)

Every `curl` example in README was verified against the live server:

| README Example | Status |
|---|---|
| `POST /api/ai/:id/sessions` with sessionId/label/function/currentTask | ✅ Accurate |
| `GET /api/ai/:id/files/content/scripts/main.js` | ✅ Accurate |
| `PUT /api/ai/:id/files/content/scripts/main.js` with content + expectedVersion | ✅ Accurate |
| `POST /api/ai/:id/sessions/:id/requests` with message | ✅ Accurate |
| `POST /api/ai/:id/instructions/assignments` with functionName/sessionId/sessionLabel | ✅ Accurate |
| 409 conflict description | ✅ Accurate |
| Token shown once behavior | ✅ Accurate |

---

## Status for Sessions 1–3 Integration

Sessions 1–3 (Frontend) have not yet fully landed. Session 3's placeholder `frontend/index.html` is in place, which resolves the `KNOWN_ISSUES.md` 500-on-SPA-fallback bug — non-API routes now return `200 + shell` as expected for SPA routing.

When Sessions 1–2 land their pages, re-verify:
- Frontend actually sends `Authorization: Bearer <token>` header on AI route calls (not hardcoded or missing)
- Conflict UI shows on real 409 (not just on mocked response)
- Service worker is not cached (server sets `no-cache` for `service-worker.js` — confirmed in server.js)
