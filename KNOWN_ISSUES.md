# Known issue: SPA fallback 500s until frontend/index.html exists

Found while verifying Session 3 (Project Management UI) end-to-end against
a live local server.

## Symptom

Any request that doesn't match a static file or an `/api/...` route
currently returns `500 Internal server error` instead of a clean `404`.

```
$ curl http://localhost:7077/manifest.json
{"error":"Internal server error.","detail":"ENOENT: no such file or directory,
stat '.../frontend/index.html'"}
```

## Cause

`backend/server.js`'s SPA fallback:

```js
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});
```

`express.static` correctly tries the real file first, finds nothing, and
falls through to this catch-all. The catch-all unconditionally calls
`sendFile` on `frontend/index.html` — which doesn't exist yet, so
`sendFile` throws `ENOENT`, and the generic error handler turns that into
a `500`.

## Why this isn't a Session 3 fix

This is `backend/server.js`, shared/foundational territory per
INSTRUCTIONS.md, not the Project Management UI lane. It's also almost
certainly **self-resolving**: once `frontend/index.html` exists (Session 1's
deliverable), `sendFile` succeeds and this stops happening entirely — the
route doesn't need to change, the missing file just needs to land.

## Flagging in case it's still live once index.html exists

If this is still reproducible *after* `frontend/index.html` is in place —
e.g. genuinely non-existent paths like `/foo/bar/nonsense` return `200`
with the SPA shell instead of a `404` — that's expected SPA-routing
behavior and not a bug (client-side router owns those paths). But if any
matched-but-truly-broken path still 500s instead of the app shell loading,
that's worth a second look then. Re-verify with the app actually running
before touching this route.

Logged by Session 3 while testing the Project Management UI lifecycle.
