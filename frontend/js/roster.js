/**
 * roster.js
 * ------------------------------------------------------------------
 * Page 2: AI Session Roster.
 *
 * STRICTLY READ-ONLY. There is no human-facing write route for
 * sessions (see backend/routes/sessions.js -- humanRouter only ever
 * mounts GET), and this file deliberately does not add any write UI
 * to compensate. Approving/managing AI sessions from the app is not
 * a feature; the human's only lever here is watching what the AIs
 * report about themselves.
 *
 * Data shown per session (per INSTRUCTIONS.md):
 *   - function       core role/purpose
 *   - currentTask    what it's doing right now
 *   - taskQueue      requests queued to it from other sessions
 * plus status (active/idle/etc) and lastSeenAt, which the backend
 * already tracks and which are genuinely useful for "is this session
 * still alive" at a glance on a five-session board.
 *
 * Polls GET /api/projects/:projectId/sessions on the same rhythm as
 * the shared activity component, per INSTRUCTIONS.md ("poll or manual
 * refresh"). Manual refresh button included for anyone who'd rather
 * not wait out the interval.
 *
 * Public API mirrors projects.js: a single object with an
 * `init(mountEl, projectId)` method, plus a `destroy()` on the
 * returned controller so a future router (Session 1) can tear down
 * polling on navigation away instead of leaking timers.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const POLL_MS = 15000;

  // -------------------------------------------------------------
  // Small DOM helpers -- see activity.js header comment for why
  // this is duplicated rather than imported.
  // -------------------------------------------------------------

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined) {
        el.setAttribute(k, v);
      }
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function timeAgo(isoString) {
    if (!isoString) return null;
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // A session that hasn't reported in a while is probably not
  // actually "active" anymore, whatever its last self-reported status
  // said -- AI processes get killed/interrupted without a chance to
  // PATCH themselves to idle. This is a display-only heuristic (we
  // never write this back), so it's fine to be a little opinionated
  // about the threshold.
  const STALE_MS = 10 * 60 * 1000; // 10 minutes

  function isStale(session) {
    if (!session.lastSeenAt) return false;
    return Date.now() - new Date(session.lastSeenAt).getTime() > STALE_MS;
  }

  function statusDotClass(session) {
    if (isStale(session)) return 'aisapp-status-dot--stale';
    if (session.status === 'active') return 'aisapp-status-dot--active';
    return 'aisapp-status-dot--idle';
  }

  function statusLabel(session) {
    if (isStale(session)) return 'Stale';
    if (session.status) return session.status.charAt(0).toUpperCase() + session.status.slice(1);
    return 'Unknown';
  }

  // -------------------------------------------------------------
  // Task queue -- rendered as a small nested list on the session
  // card. Pending vs. done get visually distinguished so a human can
  // tell "is this AI backed up" at a glance without reading every
  // request's status text.
  // -------------------------------------------------------------

  function renderTaskQueue(taskQueue, sessionId, { onDismissRequest } = {}) {
    if (!taskQueue || taskQueue.length === 0) return null;

    const pending = taskQueue.filter((r) => r.status === 'pending');
    const rest = taskQueue.filter((r) => r.status !== 'pending');
    // Pending first (most actionable), then everything else newest-ish
    // last-in-first-out as they arrived from the backend.
    const ordered = [...pending, ...rest];

    return h('div', { class: 'aisapp-roster-queue' }, [
      h('div', { class: 'aisapp-roster-queue-label' }, [
        `Task queue`,
        pending.length > 0
          ? h('span', { class: 'aisapp-badge aisapp-badge--count' }, String(pending.length))
          : null,
      ]),
      h(
        'ul',
        { class: 'aisapp-roster-queue-list' },
        ordered.map((r) =>
          h(
            'li',
            {
              class: `aisapp-roster-queue-item ${
                r.status === 'pending' ? 'aisapp-roster-queue-item--pending' : 'aisapp-roster-queue-item--done'
              }`,
            },
            [
              h('span', { class: 'aisapp-roster-queue-from' }, r.fromLabel || r.fromSessionId || '?'),
              h('span', { class: 'aisapp-roster-queue-msg' }, r.message),
              r.priority && r.priority !== 'normal'
                ? h('span', { class: `aisapp-badge aisapp-badge--priority-${r.priority}` }, r.priority)
                : null,
              // Dismiss a stuck request (IDEAS.md, "Task queue: let a
              // human clear/dismiss a stuck request", Session 2). Only
              // on pending items -- a done/dismissed entry has nothing
              // left to clear. onDismissRequest is undefined when no
              // callback was supplied (defensive default matches this
              // function's own existing style below).
              r.status === 'pending' && onDismissRequest
                ? h('button', {
                    class: 'aisapp-btn aisapp-btn--subtle aisapp-roster-queue-dismiss-btn',
                    title: 'Dismiss this stuck request',
                    onclick: () => onDismissRequest(sessionId, r.id),
                  }, 'Dismiss')
                : null,
            ]
          )
        )
      ),
    ]);
  }

  // -------------------------------------------------------------
  // Session card
  // -------------------------------------------------------------

  function renderSessionCard(session, { onDismiss, onDismissRequest } = {}) {
    const stale = isStale(session);
    return h('div', { class: `aisapp-roster-card${stale ? ' aisapp-roster-card--stale' : ''}` }, [
      h('div', { class: 'aisapp-roster-card-top' }, [
        h('span', { class: `aisapp-status-dot ${statusDotClass(session)}`, 'aria-hidden': 'true' }),
        h('div', { class: 'aisapp-roster-card-title' }, [
          h('span', { class: 'aisapp-roster-card-label' }, session.label || session.id),
          h('span', { class: 'aisapp-roster-card-status' }, statusLabel(session)),
        ]),
        stale && onDismiss
          ? h('button', {
              class: 'aisapp-btn aisapp-btn--subtle aisapp-roster-dismiss-btn',
              title: 'Remove this stale session from the roster',
              onclick: () => onDismiss(session.id),
            }, 'Dismiss')
          : null,
      ]),
      session.function
        ? h('div', { class: 'aisapp-roster-card-row' }, [
            h('span', { class: 'aisapp-roster-card-field' }, 'Function'),
            h('span', {}, session.function),
          ])
        : null,
      h('div', { class: 'aisapp-roster-card-row' }, [
        h('span', { class: 'aisapp-roster-card-field' }, 'Current task'),
        h('span', { class: 'aisapp-roster-card-task' }, session.currentTask || 'Idle'),
      ]),
      renderTaskQueue(session.taskQueue, session.id, { onDismissRequest }),
      h('div', { class: 'aisapp-roster-card-meta' }, [
        session.lastSeenAt
          ? h('span', { 'data-ts': session.lastSeenAt, 'data-ts-prefix': 'Last seen' },
              `Last seen ${timeAgo(session.lastSeenAt)}`)
          : null,
        session.registeredAt
          ? h('span', { 'data-ts': session.registeredAt, 'data-ts-prefix': '\u00B7 registered' },
              ` \u00B7 registered ${timeAgo(session.registeredAt)}`)
          : null,
      ]),
    ]);
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  const SessionRoster = {
    /**
     * Mounts the read-only Session Roster into mountEl for the given
     * project. Returns a controller with `.refresh()` and `.destroy()`
     * (stops polling -- call this when navigating away).
     */
    init(mountEl, projectId) {
      clear(mountEl);

      mountEl.appendChild(h('h1', { class: 'aisapp-page-title' }, 'AI Session Roster'));
      mountEl.appendChild(
        h(
          'p',
          { class: 'aisapp-page-subtitle' },
          'Read-only \u2014 this reflects what each AI session reports about itself. There\u2019s nothing to approve or edit here.'
        )
      );

      const headerRow = h('div', { class: 'aisapp-roster-header' }, [
        h('span', { class: 'aisapp-roster-count', id: 'aisapp-roster-count' }, ''),
        h(
          'button',
          { class: 'aisapp-btn aisapp-btn--subtle', onclick: () => refresh() },
          'Refresh'
        ),
      ]);
      mountEl.appendChild(headerRow);

      const listEl = h('div', { class: 'aisapp-roster-list' });
      mountEl.appendChild(listEl);

      let destroyed = false;
      let timerId = null;
      let inFlight = false;

      async function refresh() {
        if (destroyed || inFlight) return;
        inFlight = true;
        const countEl = headerRow.querySelector('#aisapp-roster-count');
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
          if (!res.ok) throw new Error(`Request failed (${res.status})`);
          const sessions = await res.json();
          if (destroyed) return;

          clear(listEl);

          if (!sessions || sessions.length === 0) {
            if (countEl) countEl.textContent = '';
            listEl.appendChild(
              h(
                'p',
                { class: 'aisapp-empty-state' },
                'No AI sessions have registered yet. They\u2019ll show up here as soon as one calls POST /api/ai/:projectId/sessions.'
              )
            );
            return;
          }

          // Active/fresh sessions first, stale ones pushed to the
          // bottom -- the human's eye should land on what's actually
          // happening right now, not on a session that died an hour ago.
          const sorted = [...sessions].sort((a, b) => {
            const aStale = isStale(a) ? 1 : 0;
            const bStale = isStale(b) ? 1 : 0;
            if (aStale !== bStale) return aStale - bStale;
            return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
          });

          const staleCount = sorted.filter(isStale).length;
          if (countEl) {
            countEl.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}${staleCount > 0 ? ` \u00B7 ${staleCount} stale` : ''}`;
          }

          // "Clear stale" batch-dismiss button -- shown in the header
          // only when stale sessions exist; wired to the current sorted
          // list so it always reflects what's on screen.
          let dismissAllBtn = headerRow.querySelector('.aisapp-dismiss-all-btn');
          if (staleCount > 0) {
            if (!dismissAllBtn) {
              dismissAllBtn = h('button', {
                class: 'aisapp-btn aisapp-btn--subtle aisapp-dismiss-all-btn',
                onclick: async () => {
                  await Promise.all(
                    sorted.filter(isStale).map((s) =>
                      fetch(
                        `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(s.id)}`,
                        { method: 'DELETE' }
                      )
                    )
                  );
                  refresh();
                },
              }, `Clear stale (${staleCount})`);
              headerRow.appendChild(dismissAllBtn);
            } else {
              dismissAllBtn.textContent = `Clear stale (${staleCount})`;
            }
          } else if (dismissAllBtn) {
            headerRow.removeChild(dismissAllBtn);
          }

          for (const session of sorted) {
            listEl.appendChild(renderSessionCard(session, {
              onDismiss: async (sessionId) => {
                try {
                  await fetch(
                    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
                    { method: 'DELETE' }
                  );
                  await refresh();
                } catch {
                  // silent -- will recover on next poll
                }
              },
              onDismissRequest: async (sessionId, requestId) => {
                try {
                  await fetch(
                    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/dismiss`,
                    { method: 'POST' }
                  );
                  await refresh();
                } catch {
                  // silent -- will recover on next poll, matches onDismiss above
                }
              },
            }));
          }
        } catch (err) {
          if (destroyed) return;
          if (!listEl.firstChild) {
            clear(listEl);
            listEl.appendChild(
              h('div', { class: 'aisapp-error-state' }, [
                h('p', {}, `Couldn't load sessions: ${err.message}`),
                h(
                  'button',
                  { class: 'aisapp-btn aisapp-btn--subtle', onclick: () => refresh() },
                  'Try again'
                ),
              ])
            );
          }
        } finally {
          inFlight = false;
        }
      }

      function scheduleNext() {
        if (destroyed) return;
        timerId = setTimeout(async () => {
          await refresh();
          scheduleNext();
        }, POLL_MS);
      }

      function onVisibilityChange() {
        if (document.hidden) {
          if (timerId) {
            clearTimeout(timerId);
            timerId = null;
          }
        } else if (!destroyed && !timerId) {
          refresh();
          scheduleNext();
        }
      }
      document.addEventListener('visibilitychange', onVisibilityChange);

      // Tick every 30 s so "X min ago" text stays current without
      // re-fetching. data-ts and data-ts-prefix are on the span elements
      // rendered by renderSessionCard.
      const tsTicker = setInterval(() => {
        if (destroyed) { clearInterval(tsTicker); return; }
        listEl.querySelectorAll('[data-ts]').forEach((el) => {
          const ts = el.getAttribute('data-ts');
          const prefix = el.getAttribute('data-ts-prefix');
          el.textContent = prefix ? `${prefix} ${timeAgo(ts)}` : timeAgo(ts);
        });
      }, 30000);

      function destroy() {
        destroyed = true;
        if (timerId) clearTimeout(timerId);
        clearInterval(tsTicker);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }

      refresh().then(scheduleNext);

      return { refresh, destroy };
    },
  };

  window.SessionRoster = SessionRoster;
})();
