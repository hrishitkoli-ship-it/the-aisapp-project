/**
 * instructions.js
 * ------------------------------------------------------------------
 * Page 3: Instructions & Functionalities.
 *
 * Three pieces, all backed by /api/projects/:projectId/instructions
 * (human-facing, no token -- see backend/routes/instructions.js):
 *
 *   1. Notes editor           PUT  /notes
 *   2. Functionality list     POST /functionalities
 *   3. Assignment proposals   GET  /  (read), with
 *        Approve/Reject buttons that call
 *        POST /assignments/:id/approve
 *        POST /assignments/:id/reject
 *
 * The Approve/Reject buttons are the Function Assignment Gate the
 * whole rest of the system is built around: they only exist here, on
 * the human-facing page, because the backend only exposes
 * /assignments/:id/approve|reject on humanRouter. There is no
 * equivalent AI-facing route to call by design (confirmed in
 * SESSION5_TEST_REPORT.md -- AI token hitting approve gets 404, not
 * 403, because the route itself doesn't exist on aiRouter). This file
 * doesn't add any client-side permission check to compensate for
 * that; the backend boundary IS the boundary. This page just happens
 * to be the only UI that can reach it.
 *
 * Also mounts the shared Activity Timeline (activity.js) underneath,
 * per INSTRUCTIONS.md Session 2 scope ("Activity timeline component
 * (shared, used across pages)").
 *
 * Public API mirrors projects.js / roster.js: `init(mountEl,
 * projectId)`, returns a controller with `.destroy()`.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

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

  function showStatus(mountEl, message, kind = 'info') {
    const existing = mountEl.querySelector('.aihub-status');
    if (existing) existing.remove();
    const el = h('div', { class: `aihub-status aihub-status--${kind}` }, message);
    mountEl.prepend(el);
    if (kind !== 'error') {
      setTimeout(() => el.remove(), 4000);
    }
  }

  // -------------------------------------------------------------
  // Tiny fetch wrapper, matching projects.js's shape/error contract
  // so error messages read consistently across the app.
  // -------------------------------------------------------------

  async function api(projectId, path, options = {}) {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/instructions${path}`,
      {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }
    );
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Some responses may not be JSON; treat as empty.
    }
    if (!res.ok) {
      const message = (body && body.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // -------------------------------------------------------------
  // Notes editor
  // -------------------------------------------------------------

  function renderNotesEditor(mountEl, projectId, initialNotes) {
    const textarea = h('textarea', {
      class: 'aihub-input aihub-textarea aihub-notes-textarea',
      placeholder: 'Free-form notes/instructions for the AI sessions working on this project\u2026',
      rows: '5',
    });
    textarea.value = initialNotes || '';

    let saveTimer = null;
    let lastSavedValue = initialNotes || '';
    const statusEl = h('span', { class: 'aihub-notes-save-status' }, '');

    async function save() {
      const value = textarea.value;
      if (value === lastSavedValue) return;
      statusEl.textContent = 'Saving\u2026';
      try {
        await api(projectId, '/notes', {
          method: 'PUT',
          body: JSON.stringify({ notes: value }),
        });
        lastSavedValue = value;
        statusEl.textContent = 'Saved';
        setTimeout(() => {
          if (statusEl.textContent === 'Saved') statusEl.textContent = '';
        }, 2000);
      } catch (err) {
        statusEl.textContent = '';
        showStatus(mountEl, `Couldn't save notes: ${err.message}`, 'error');
      }
    }

    // Autosave, debounced -- this is a notes field a human types into
    // on a phone; requiring an explicit "Save" tap for free-text notes
    // is friction the other forms on this page (which are structured,
    // deliberate submissions) don't need. 800ms feels responsive
    // without firing a request per keystroke.
    textarea.addEventListener('input', () => {
      statusEl.textContent = '';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 800);
    });

    // Also save on blur immediately, so navigating away right after
    // typing doesn't lose the debounce window.
    textarea.addEventListener('blur', () => {
      if (saveTimer) clearTimeout(saveTimer);
      save();
    });

    return h('div', { class: 'aihub-instructions-block' }, [
      h('div', { class: 'aihub-block-header' }, [
        h('h2', { class: 'aihub-section-title' }, 'Notes'),
        statusEl,
      ]),
      textarea,
    ]);
  }

  // -------------------------------------------------------------
  // Functionality list
  // -------------------------------------------------------------

  function renderFunctionalityItem(item) {
    return h('div', { class: 'aihub-functionality-item' }, [
      h('div', { class: 'aihub-functionality-name' }, item.name),
      item.description
        ? h('div', { class: 'aihub-functionality-desc' }, item.description)
        : null,
      h('div', { class: 'aihub-functionality-meta' }, [
        item.createdBy ? h('span', {}, item.createdBy) : null,
        item.createdAt ? h('span', {}, timeAgo(item.createdAt)) : null,
      ]),
    ]);
  }

  function renderFunctionalitySection(mountEl, projectId, initialList, onChanged) {
    const listEl = h('div', { class: 'aihub-functionality-list' });

    function renderList(items) {
      clear(listEl);
      if (!items || items.length === 0) {
        listEl.appendChild(
          h('p', { class: 'aihub-empty-state' }, 'No functionalities defined yet.')
        );
        return;
      }
      // Newest first -- mirrors the activity feed's convention and
      // surfaces what was just added without scrolling.
      const sorted = [...items].sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      );
      for (const item of sorted) {
        listEl.appendChild(renderFunctionalityItem(item));
      }
    }
    renderList(initialList);

    const nameInput = h('input', {
      type: 'text',
      class: 'aihub-input',
      placeholder: 'Functionality name',
      maxlength: '120',
    });
    const descInput = h('textarea', {
      class: 'aihub-input aihub-textarea',
      placeholder: 'What should this do? (optional)',
      rows: '2',
      maxlength: '400',
    });
    const submitBtn = h(
      'button',
      { class: 'aihub-btn aihub-btn--primary', type: 'submit' },
      'Add functionality'
    );
    let isSubmitting = false;

    const form = h(
      'form',
      {
        class: 'aihub-create-form',
        onsubmit: async (e) => {
          e.preventDefault();
          if (isSubmitting) return;
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.focus();
            return;
          }
          isSubmitting = true;
          submitBtn.disabled = true;
          submitBtn.textContent = 'Adding\u2026';
          try {
            await api(projectId, '/functionalities', {
              method: 'POST',
              body: JSON.stringify({ name, description: descInput.value.trim() }),
            });
            nameInput.value = '';
            descInput.value = '';
            onChanged();
          } catch (err) {
            showStatus(mountEl, err.message, 'error');
          } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add functionality';
          }
        },
      },
      [nameInput, descInput, submitBtn]
    );

    const section = h('div', { class: 'aihub-instructions-block' }, [
      h('h2', { class: 'aihub-section-title' }, 'Functionalities'),
      form,
      listEl,
    ]);

    return { section, renderList };
  }

  // -------------------------------------------------------------
  // Assignment proposals -- the Function Assignment Gate.
  // Approve/Reject render ONLY here, and only call the human-facing
  // routes. See file header for why no AI-facing equivalent exists.
  // -------------------------------------------------------------

  function statusBadgeClass(status) {
    if (status === 'approved') return 'aihub-badge--approved';
    if (status === 'rejected') return 'aihub-badge--rejected';
    return 'aihub-badge--pending';
  }

  function renderAssignmentItem(mountEl, projectId, assignment, onChanged) {
    const approveBtn = h(
      'button',
      {
        class: 'aihub-btn aihub-btn--primary aihub-btn--sm',
        onclick: async () => {
          approveBtn.disabled = true;
          rejectBtn.disabled = true;
          approveBtn.textContent = 'Approving\u2026';
          try {
            await api(projectId, `/assignments/${encodeURIComponent(assignment.id)}/approve`, {
              method: 'POST',
            });
            onChanged();
          } catch (err) {
            showStatus(mountEl, `Couldn't approve: ${err.message}`, 'error');
            approveBtn.disabled = false;
            rejectBtn.disabled = false;
            approveBtn.textContent = 'Approve';
          }
        },
      },
      'Approve'
    );

    const rejectBtn = h(
      'button',
      {
        class: 'aihub-btn aihub-btn--sm',
        onclick: async () => {
          approveBtn.disabled = true;
          rejectBtn.disabled = true;
          rejectBtn.textContent = 'Rejecting\u2026';
          try {
            await api(projectId, `/assignments/${encodeURIComponent(assignment.id)}/reject`, {
              method: 'POST',
            });
            onChanged();
          } catch (err) {
            showStatus(mountEl, `Couldn't reject: ${err.message}`, 'error');
            approveBtn.disabled = false;
            rejectBtn.disabled = false;
            rejectBtn.textContent = 'Reject';
          }
        },
      },
      'Reject'
    );

    const isPending = assignment.status === 'pending';

    return h('div', { class: 'aihub-assignment-item' }, [
      h('div', { class: 'aihub-assignment-top' }, [
        h('div', { class: 'aihub-assignment-title' }, [
          h('span', { class: 'aihub-assignment-fn' }, assignment.functionName),
          ' \u2192 ',
          h('span', { class: 'aihub-assignment-target' }, assignment.sessionLabel || assignment.sessionId),
        ]),
        h('span', { class: `aihub-badge ${statusBadgeClass(assignment.status)}` }, assignment.status),
      ]),
      assignment.reason
        ? h('div', { class: 'aihub-assignment-reason' }, assignment.reason)
        : null,
      h('div', { class: 'aihub-assignment-meta' }, [
        assignment.proposedBy ? h('span', {}, `Proposed by ${assignment.proposedBy}`) : null,
        assignment.createdAt ? h('span', {}, timeAgo(assignment.createdAt)) : null,
      ]),
      isPending
        ? h('div', { class: 'aihub-assignment-actions' }, [approveBtn, rejectBtn])
        : null,
    ]);
  }

  function renderAssignmentSection(mountEl, projectId, initialList, onChanged) {
    const listEl = h('div', { class: 'aihub-assignment-list' });

    function renderList(items) {
      clear(listEl);
      if (!items || items.length === 0) {
        listEl.appendChild(
          h('p', { class: 'aihub-empty-state' }, 'No assignment proposals yet.')
        );
        return;
      }
      // Pending first -- these need a human decision, so they should
      // never be buried below already-decided ones. Within each
      // bucket, newest first.
      const pending = items.filter((a) => a.status === 'pending');
      const decided = items.filter((a) => a.status !== 'pending');
      const sortByNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      pending.sort(sortByNewest);
      decided.sort(sortByNewest);

      for (const assignment of [...pending, ...decided]) {
        listEl.appendChild(renderAssignmentItem(mountEl, projectId, assignment, onChanged));
      }
    }
    renderList(initialList);

    const section = h('div', { class: 'aihub-instructions-block' }, [
      h('h2', { class: 'aihub-section-title' }, 'Function assignments'),
      h(
        'p',
        { class: 'aihub-block-subtitle' },
        'Proposals from you or an AI session. Nothing is assigned until you approve it here.'
      ),
      listEl,
    ]);

    return { section, renderList };
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  const InstructionsPage = {
    /**
     * Mounts the full Instructions & Functionalities page into
     * mountEl for the given project. Returns a controller with
     * `.destroy()` (tears down the embedded activity timeline's
     * polling).
     */
    async init(mountEl, projectId) {
      clear(mountEl);

      mountEl.appendChild(h('h1', { class: 'aihub-page-title' }, 'Instructions & Functionalities'));

      let data;
      try {
        data = await api(projectId, '/');
      } catch (err) {
        mountEl.appendChild(
          h('div', { class: 'aihub-error-state' }, [
            h('p', {}, `Couldn't load instructions: ${err.message}`),
            h(
              'button',
              {
                class: 'aihub-btn aihub-btn--subtle',
                onclick: () => InstructionsPage.init(mountEl, projectId),
              },
              'Try again'
            ),
          ])
        );
        return { destroy() {} };
      }

      mountEl.appendChild(renderNotesEditor(mountEl, projectId, data.notes));

      async function refreshData() {
        try {
          const fresh = await api(projectId, '/');
          functionalityCtl.renderList(fresh.functionalities);
          assignmentCtl.renderList(fresh.assignments);
        } catch {
          // A background refresh failing after a successful mutation
          // isn't worth surfacing as an error toast -- the mutation
          // itself already succeeded (that's what triggered this
          // refresh). The next manual action will just retry.
        }
      }

      const functionalityCtl = renderFunctionalitySection(
        mountEl,
        projectId,
        data.functionalities,
        refreshData
      );
      mountEl.appendChild(functionalityCtl.section);

      const assignmentCtl = renderAssignmentSection(
        mountEl,
        projectId,
        data.assignments,
        refreshData
      );
      mountEl.appendChild(assignmentCtl.section);

      // Shared Activity Timeline, per INSTRUCTIONS.md Session 2 scope.
      const activityMount = h('div', { class: 'aihub-instructions-block' });
      mountEl.appendChild(activityMount);
      let activityCtl = { destroy() {} };
      if (window.ActivityTimeline) {
        activityCtl = window.ActivityTimeline.mount(activityMount, projectId, {
          title: 'Activity',
        });
      }

      return {
        destroy() {
          activityCtl.destroy();
        },
      };
    },
  };

  window.InstructionsPage = InstructionsPage;
})();
