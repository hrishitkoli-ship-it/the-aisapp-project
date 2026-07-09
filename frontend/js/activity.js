/**
 * activity.js
 * ------------------------------------------------------------------
 * Session 2 lane: shared Activity Timeline component.
 *
 * Used by both the Session Roster page and the Instructions page
 * (and anywhere else that wants a live feed of what's happened in a
 * project). Talks to GET /api/projects/:id/activity -- human-facing,
 * no token needed, per auth.js.
 *
 * `security_alert` entries are rendered distinctly (per
 * INSTRUCTIONS.md Session 2 scope: "render security_alert entries
 * distinctly (they matter)") -- these are path-traversal attempts
 * blocked by safeResolve()/projectDir(), logged even though the
 * request itself was rejected. A human should not have to read every
 * line of a long feed to notice one.
 *
 * Public API: `ActivityTimeline.mount(el, projectId, options)`
 * returns a controller with `.refresh()` and `.destroy()`, so the
 * pages that embed this can trigger a manual refresh (e.g. right
 * after they know a write happened) and clean up polling on
 * navigation away.
 *
 * No build step, no framework -- see INSTRUCTIONS.md architecture
 * rule #1. Follows the same vanilla DOM + fetch approach as
 * projects.js (Session 3).
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const DEFAULT_POLL_MS = 15000;
  const DEFAULT_LIMIT = 50;

  // -------------------------------------------------------------
  // Small DOM helpers -- intentionally duplicated from projects.js
  // rather than imported. This file has to stand alone (it's a
  // shared component other pages pull in independently, and script
  // load order between pages isn't guaranteed), and the helper is
  // ~15 lines. Session 1: if you introduce a real module system for
  // the app shell, this is a natural thing to dedupe then.
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
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // -------------------------------------------------------------
  // Icon + label per activity type. Keeps the feed scannable --
  // a human on mobile is glancing at this, not reading prose.
  // security_alert intentionally does NOT go through this map --
  // it gets its own render path below, since it needs to stand out
  // rather than blend in with a "nice" icon.
  // -------------------------------------------------------------

  const TYPE_META = {
    session_registered: { icon: '\u{1F7E2}', label: 'Session' }, // 🟢
    task_requested: { icon: '\u{1F4E9}', label: 'Task request' }, // 📩
    assignment_proposed: { icon: '\u{1F4CB}', label: 'Proposal' }, // 📋
    assignment_approved: { icon: '\u2705', label: 'Approved' }, // ✅
    assignment_rejected: { icon: '\u274C', label: 'Rejected' }, // ❌
    file_write: { icon: '\u{1F4DD}', label: 'File write' }, // 📝
    file_delete: { icon: '\u{1F5D1}', label: 'File delete' }, // 🗑
    token_regenerated: { icon: '\u{1F511}', label: 'Token' }, // 🔑
  };

  function metaFor(type) {
    return TYPE_META[type] || { icon: '\u2022', label: type || 'Activity' };
  }

  // -------------------------------------------------------------
  // Row rendering
  // -------------------------------------------------------------

  function renderRow(entry) {
    if (entry.type === 'security_alert') {
      return h('div', { class: 'aihub-activity-row aihub-activity-row--alert' }, [
        h('span', { class: 'aihub-activity-icon', 'aria-hidden': 'true' }, '\u26A0\uFE0F'), // ⚠️
        h('div', { class: 'aihub-activity-body' }, [
          h('div', { class: 'aihub-activity-message' }, [
            h('span', { class: 'aihub-activity-alert-tag' }, 'Security alert'),
            ' ',
            entry.message || 'Blocked request.',
          ]),
          h('div', { class: 'aihub-activity-meta' }, [
            entry.actor ? h('span', {}, entry.actor) : null,
            entry.timestamp ? h('span', {}, timeAgo(entry.timestamp)) : null,
          ]),
        ]),
      ]);
    }

    const meta = metaFor(entry.type);
    return h('div', { class: 'aihub-activity-row' }, [
      h('span', { class: 'aihub-activity-icon', 'aria-hidden': 'true' }, meta.icon),
      h('div', { class: 'aihub-activity-body' }, [
        h('div', { class: 'aihub-activity-message' }, entry.message || meta.label),
        h('div', { class: 'aihub-activity-meta' }, [
          entry.actor ? h('span', {}, entry.actor) : null,
          entry.timestamp ? h('span', {}, timeAgo(entry.timestamp)) : null,
        ]),
      ]),
    ]);
  }

  // -------------------------------------------------------------
  // Public mount function
  // -------------------------------------------------------------

  /**
   * @param {HTMLElement} mountEl
   * @param {string} projectId
   * @param {{ limit?: number, pollMs?: number, title?: string }} [options]
   * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
   */
  function mount(mountEl, projectId, options = {}) {
    const limit = options.limit || DEFAULT_LIMIT;
    const pollMs = options.pollMs === 0 ? 0 : options.pollMs || DEFAULT_POLL_MS;

    const container = h('div', { class: 'aihub-activity' });
    const header = h('div', { class: 'aihub-activity-header' }, [
      h('h2', { class: 'aihub-section-title' }, options.title || 'Activity'),
      h(
        'button',
        {
          class: 'aihub-icon-btn',
          title: 'Refresh',
          'aria-label': 'Refresh activity',
          onclick: () => refresh(),
        },
        '\u21BB' // ↻
      ),
    ]);
    const listEl = h('div', { class: 'aihub-activity-list' });

    container.appendChild(header);
    container.appendChild(listEl);
    mountEl.appendChild(container);

    let destroyed = false;
    let timerId = null;
    let inFlight = false;

    async function refresh() {
      if (destroyed || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/activity?limit=${limit}`
        );
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const entries = await res.json();
        if (destroyed) return;

        clear(listEl);
        if (!entries || entries.length === 0) {
          listEl.appendChild(
            h('p', { class: 'aihub-empty-state' }, 'No activity yet.')
          );
          return;
        }
        for (const entry of entries) {
          listEl.appendChild(renderRow(entry));
        }
      } catch (err) {
        if (destroyed) return;
        // Don't blow away a previously-good feed on a transient poll
        // failure -- only show an error state if the list is still
        // empty (i.e. this was the first load).
        if (!listEl.firstChild) {
          clear(listEl);
          listEl.appendChild(
            h('div', { class: 'aihub-error-state' }, [
              h('p', {}, `Couldn't load activity: ${err.message}`),
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
      if (destroyed || !pollMs) return;
      timerId = setTimeout(async () => {
        await refresh();
        scheduleNext();
      }, pollMs);
    }

    // Pause polling while the tab/app is backgrounded -- this is a
    // mobile-first tool per INSTRUCTIONS.md, and Android WebViews /
    // backgrounded PWAs are exactly where silently-firing timers
    // waste battery for no visible benefit. Resume + refresh once
    // immediately on return so the feed doesn't look stale.
    function onVisibilityChange() {
      if (document.hidden) {
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
        }
      } else if (!destroyed && pollMs && !timerId) {
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
  }

  window.ActivityTimeline = { mount };
})();
