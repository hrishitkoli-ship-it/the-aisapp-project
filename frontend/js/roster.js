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
    if (isStale(session)) return 'aihub-status-dot--stale';
    if (session.status === 'active') return 'aihub-status-dot--active';
    return 'aihub-status-dot--idle';
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

  function renderTaskQueue(taskQueue) {
    if (!taskQueue || taskQueue.length === 0) return null;

    const pending = taskQueue.filter((r) => r.status === 'pending');
    const rest = taskQueue.filter((r) => r.status !== 'pending');
    // Pending first (most actionable), then everything else newest-ish
    // last-in-first-out as they arrived from the backend.
    const ordered = [...pending, ...rest];

    return h('div', { class: 'aihub-roster-queue' }, [
      h('div', { class: 'aihub-roster-queue-label' }, [
        `Task queue`,
        pending.length > 0
          ? h('span', { class: 'aihub-badge aihub-badge--count' }, String(pending.length))
          : null,
      ]),
      h(
        'ul',
        { class: 'aihub-roster-queue-list' },
        ordered.map((r) =>
          h(
            'li',
            {
              class: `aihub-roster-queue-item ${
                r.status === 'pending' ? 'aihub-roster-queue-item--pending' : 'aihub-roster-queue-item--done'
              }`,
            },
            [
              h('span', { class: 'aihub-roster-queue-from' }, r.fromLabel || r.fromSessionId || '?'),
              h('span', { class: 'aihub-roster-queue-msg' }, r.message),
              r.priority && r.priority !== 'normal'
                ? h('span', { class: `aihub-badge aihub-badge--priority-${r.priority}` }, r.priority)
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

  function renderSessionCard(session) {
    return h('div', { class: 'aihub-roster-card' }, [
      h('div', { class: 'aihub-roster-card-top' }, [
        h('span', { class: `aihub-status-dot ${statusDotClass(session)}`, 'aria-hidden': 'true' }),
        h('div', { class: 'aihub-roster-card-title' }, [
          h('span', { class: 'aihub-roster-card-label' }, session.label || session.id),
          h('span', { class: 'aihub-roster-card-status' }, statusLabel(session)),
        ]),
      ]),
      session.function
        ? h('div', { class: 'aihub-roster-card-row' }, [
            h('span', { class: 'aihub-roster-card-field' }, 'Function'),
            h('span', {}, session.function),
          ])
        : null,
      h('div', { class: 'aihub-roster-card-row' }, [
        h('span', { class: 'aihub-roster-card-field' }, 'Current task'),
        h('span', { class: 'aihub-roster-card-task' }, session.currentTask || 'Idle'),
      ]),
      renderTaskQueue(session.taskQueue),
      h('div', { class: 'aihub-roster-card-meta' }, [
        session.lastSeenAt ? `Last seen ${timeAgo(session.lastSeenAt)}` : null,
        session.registeredAt ? ` \u00B7 registered ${timeAgo(session.registeredAt)}` : null,
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

      mountEl.appendChild(h('h1', { class: 'aihub-page-title' }, 'AI Session Roster'));
      mountEl.appendChild(
        h(
          'p',
          { class: 'aihub-page-subtitle' },
          'Read-only \u2014 this reflects what each AI session reports about itself. There\u2019s nothing to approve or edit here.'
        )
      );

      const headerRow = h('div', { class: 'aihub-roster-header' }, [
        h('span', { class: 'aihub-roster-count', id: 'aihub-roster-count' }, ''),
        h(
          'button',
          { class: 'aihub-btn aihub-btn--subtle', onclick: () => refresh() },
          'Refresh'
        ),
      ]);
      mountEl.appendChild(headerRow);

      const listEl = h('div', { class: 'aihub-roster-list' });
      mountEl.appendChild(listEl);

      let destroyed = false;
      let timerId = null;
      let inFlight = false;

      async function refresh() {
        if (destroyed || inFlight) return;
        inFlight = true;
        const countEl = headerRow.querySelector('#aihub-roster-count');
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
          if (!res.ok) throw new Error(`Request failed (${res.status})`);
          const sessions = await res.json();
          if (destroyed) return;

          clear(listEl);

          if (countEl) {
            countEl.textContent =
              sessions.length === 0
                ? ''
                : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
          }

          if (!sessions || sessions.length === 0) {
            listEl.appendChild(
              h(
                'p',
                { class: 'aihub-empty-state' },
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

          for (const session of sorted) {
            listEl.appendChild(renderSessionCard(session));
          }
        } catch (err) {
          if (destroyed) return;
          if (!listEl.firstChild) {
            clear(listEl);
            listEl.appendChild(
              h('div', { class: 'aihub-error-state' }, [
                h('p', {}, `Couldn't load sessions: ${err.message}`),
                h(
                  'button',
                  { class: 'aihub-btn aihub-btn--subtle', onclick: () => refresh() },
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

      function destroy() {
        destroyed = true;
        if (timerId) clearTimeout(timerId);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }

      refresh().then(scheduleNext);

      return { refresh, destroy };
    },
  };

  window.SessionRoster = SessionRoster;
})();
