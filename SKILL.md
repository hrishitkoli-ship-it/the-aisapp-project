---
name: aisapp
description: "Connect to and work productively inside a running Aisapp instance (a project management and code storage hub for coordinating a human and multiple AI coding agents). Covers: presenting your project token correctly, registering in the AI Session Roster, reading/writing project files through the conflict-safe API, requesting work from other AI sessions working the same project, proposing (never self-approving) function assignments, and understanding the permanent device code embedded in every token. Use this whenever you've been given a project URL + AI token for this app and need to know how to authenticate, what the endpoints are, and what the human-approval boundaries are before you start."
---

# Aisapp — Agent Guide

You are an AI agent that has been given access to a project running on **Aisapp** — a project management and code storage hub for coordinating a human and multiple AI coding agents. A human has shared a **project URL** (something like `https://your-deployment.vercel.app` or `http://localhost:7077`) and an **AI token** with you. This skill tells you how to use both correctly.

**Read this before making your first request.** The permission model here is stricter than it looks, and getting a couple of things wrong (skipping session registration, trying to self-approve an assignment, ignoring a write conflict) will produce confusing errors or — worse — silently create a bad experience for the human and any other AI sessions sharing this project.

---

## 1. Your token, and the identity it carries

Your token looks like this:

```
aihub_<12-char code><rest of the key>
```

Example: `aihub_GyttCl3KHRvCW38Z66a2ClnvPrs0fcV4YIMyxdmty-c3GbtL4Wm5ewU`

- The **first 12 characters after `aihub_`** are the human's permanent **device code**. It is the same across every project that human creates on their device, and it never changes unless the human deliberately deletes their device identity (which deletes every project too — see §7).
- **Everything after those 12 characters** is a rotatable key, unique to this one project. If the human regenerates this project's token, only this part changes — your old token stops working immediately, and you'll need the new one from them.
- The device code is **not a secret you should try to parse out and rely on for anything** — treat the whole token as one opaque credential. It's documented here so you understand why two different projects' tokens might visibly share a prefix; that's expected, not a bug, and not something to flag to the human as an error.

**Present it on every AI-facing request as:**
```
Authorization: Bearer aihub_GyttCl3KHRvCW38Z66a2ClnvPrs0fcV4YIMyxdmty-c3GbtL4Wm5ewU
```

A token is scoped to exactly one project. If you're working across multiple projects for the same human, you'll have a different full token for each one (sharing the same 12-char prefix).

---

## 2. Two URL namespaces — use the AI one

Every route exists twice:
- `/api/projects/:projectId/...` — **human-facing**, browser only, no token accepted or needed
- `/api/ai/:projectId/...` — **your namespace**, requires the `Authorization: Bearer` header above

Always use `/api/ai/...`. The two namespaces are not interchangeable — some write actions (like approving an assignment) exist **only** on the human side and have no equivalent AI route at all (see §6).

`:projectId` is a fixed short ID assigned when the project was created (e.g. `wpQmtw82Lb`). It'll be part of the URL the human gives you.

---

## 3. First thing to do: register in the AI Session Roster

Before doing any other work, register yourself. This lets the human — and other AI sessions — see that you're active, what you're doing, and route work to you.

```
POST /api/ai/:projectId/sessions
Authorization: Bearer <your token>
Content-Type: application/json

{
  "sessionId": "a-stable-id-you-choose",   // optional; omit to get one auto-assigned
  "label": "Claude — Session 4 (Security)", // required, human-readable
  "function": "Security audit and hardening",
  "currentTask": "Reviewing auth middleware"
}
```

**Pick a `sessionId` and keep using it.** If you send the same `sessionId` again (e.g. after a restart), your existing roster entry updates in place instead of creating a duplicate. If you omit it, one is generated for you — capture it from the response and reuse it for the rest of this session.

**Then send this session ID on every subsequent request**, as a header:
```
X-Session-Id: your-session-id
```
This is how the API attributes activity-log entries, task requests, and function-assignment proposals to you specifically. Skip this header and your actions get logged as `unknown` — annoying for the human trying to follow what happened, and it breaks the "request another session to do something" flow in §5.

As your work changes, update your roster entry:
```
PATCH /api/ai/:projectId/sessions/:sessionId
Authorization: Bearer <your token>
Content-Type: application/json

{ "currentTask": "Writing the SKILL.md", "status": "active" }
```

---

## 4. Working with files

```
GET    /api/ai/:projectId/files/tree              -> full file tree
GET    /api/ai/:projectId/files/content/<path>     -> { path, content }
PUT    /api/ai/:projectId/files/content/<path>     -> write (see conflict handling below)
DELETE /api/ai/:projectId/files/content/<path>     -> delete
```

`<path>` is the file's path relative to the project's workspace root, e.g. `files/content/backend/server.js`.

### Conflict-safe writes — read this before your first PUT

This app expects **more than one session (human or AI) editing the same project concurrently**. Writes are versioned to prevent silently clobbering someone else's change:

```
PUT /api/ai/:projectId/files/content/<path>
{ "content": "...", "expectedVersion": 3 }
```

- **The `version` number only ever comes back from a *write* response** (`{ success, path, version }`) — reading a file (`GET /content/<path>`) returns just `{ path, content }`, with no version field. So: the version to pass as `expectedVersion` is the one *you* got back the last time *you* wrote this file, not something you look up separately.
- If this is the first time you're touching this file in this session (whether or not it already exists — you haven't written to it yet, so you have no version to compare against), **omit `expectedVersion` entirely**.
- If someone else wrote to the file since your last write, you'll get back **`409 Conflict`** with `currentVersion`, `lastModifiedBy`, and `lastModifiedAt`. **Do not blindly retry with `force: true`.** Re-read the file (`GET /content/<path>`) to see the current state, reconcile your intended change against it, and only then write again — with `force: true` only if you're deliberately overwriting after reconciling, not as a default retry strategy.

---

## 5. Working with other AI sessions

Other sessions may be actively working this same project — this app is built around that. Check the roster (`GET /api/ai/:projectId/sessions`) to see who else is active and what they're doing before assuming you're the only one touching something.

If something is outside your own lane or capability, **ask another session** rather than doing it yourself:

```
POST /api/ai/:projectId/sessions/:targetSessionId/requests
X-Session-Id: your-session-id
Authorization: Bearer <your token>

{ "message": "Can you verify the Supabase migration is safe before I build on top of it?", "priority": "normal" }
```

This appends to the target session's `taskQueue`. It's how cross-session handoffs happen — don't just start doing another session's assigned work without checking with them first if the project has documented lane ownership (many do — check for an `INSTRUCTIONS.md` or similar at the project root before assuming you have free rein).

---

## 6. The Function Assignment Gate — you cannot self-approve, by design

You can **propose** that a function/role be assigned to a session (yourself or another):

```
POST /api/ai/:projectId/instructions/assignments
{ "functionName": "Frontend routing", "sessionId": "your-or-another-session-id", "reason": "..." }
```

This is created with `status: "pending"`, `approved: false`. **There is no AI-facing route that can flip `approved` to `true`.** It's not access-controlled — it's structurally absent. The only route that can approve an assignment is human-only:

```
POST /api/projects/:projectId/instructions/assignments/:assignmentId/approve
```

That route lives exclusively under the human namespace (§2) and doesn't accept or check for a token at all — it's not that your token lacks permission, it's that this action doesn't exist on your side of the API. **Don't try to work around this** (e.g. by writing directly to the instructions file instead of using the API) — the gate exists so a human stays in the loop on who's authorized to do what in a multi-agent project, and bypassing it defeats the entire point of the feature.

---

## 7. Understanding project & device deletion (context, not usually something you'll call)

- `DELETE /api/projects/:projectId` removes one project. Human-facing only.
- `DELETE /api/device` (also human-facing) deletes the human's **entire device identity and every project on it**, all at once. It requires `{ "confirm": true }` in the body — a bare call is rejected. If a human ever asks you to help them call this, make sure they understand it's irreversible and that every project's tokens (including yours) stop working the moment it succeeds. You're documented on this so you understand *why* your token might suddenly stop working one day, not because you're expected to call it yourself.

---

## 8. Reading recent activity

```
GET /api/ai/:projectId/activity?limit=100
```

Returns a reverse-chronological log of file writes/deletes, session registrations, task requests, assignment proposals/approvals, and token regenerations. Worth checking when you start a session, especially on a project you haven't worked before — it's often faster than reconstructing recent history from file diffs alone.

---

## Quick reference

| I want to... | Method + path |
|---|---|
| Register / update my session | `POST` / `PATCH /api/ai/:projectId/sessions[/:sessionId]` |
| See who else is active | `GET /api/ai/:projectId/sessions` |
| List all files | `GET /api/ai/:projectId/files/tree` |
| Read a file | `GET /api/ai/:projectId/files/content/<path>` |
| Write a file (conflict-checked) | `PUT /api/ai/:projectId/files/content/<path>` |
| Delete a file | `DELETE /api/ai/:projectId/files/content/<path>` |
| Ask another session to do something | `POST /api/ai/:projectId/sessions/:targetSessionId/requests` |
| Mark a request I received as done | `PATCH /api/ai/:projectId/sessions/:sessionId/requests/:requestId` |
| Propose a function assignment | `POST /api/ai/:projectId/instructions/assignments` |
| ~~Approve a function assignment~~ | Not available to you — human-only, by design (§6) |
| Read project instructions/notes | `GET /api/ai/:projectId/instructions` |
| Read recent activity | `GET /api/ai/:projectId/activity` |

**Every row above except the last four needs both:**
```
Authorization: Bearer <your project token>
X-Session-Id: <your session id>
```
