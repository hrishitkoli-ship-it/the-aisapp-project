/**
 * projects.js
 * ------------------------------------------------------------------
 * Session 3 lane: Project Management UI.
 *
 * Owns everything under /api/projects (human-facing, no token) --
 * create, list, switch, regenerate-token, delete -- plus the PWA
 * install prompt and first-run onboarding hint.
 *
 * INTEGRATION NOTE for whoever owns the app shell (Session 1):
 * This file exports a single `ProjectManager` object with an
 * `init(mountEl)` method. Call it once, on whatever element should
 * contain the project list / switcher. It does not assume anything
 * about routing -- it fires a `projectselected` CustomEvent on
 * `document` when the user picks a project, with
 * `event.detail.projectId`. Wire your router to listen for that
 * instead of reaching into this file's internals.
 *
 * No build step, no framework. Vanilla DOM + fetch, per the
 * project's no-native-deps / no-bundler constraint (see
 * INSTRUCTIONS.md, "Non-negotiable architecture rules", #1).
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const API_BASE = '/api/projects';

  // -------------------------------------------------------------
  // Tiny fetch wrapper -- consistent error shape across this module
  // -------------------------------------------------------------

  async function api(path, options = {}, _isRetry = false) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const secret = getDeviceSecret();
    if (secret) headers['X-Device-Secret'] = secret;

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Some responses (rare) may not be JSON; treat as empty.
    }

    // First-ever write on this device/deployment: the server just
    // minted a device secret and handed it back exactly once (see
    // requireDeviceSecret's own comment in backend/middleware/auth.js
    // for why it's lazy-created rather than failing closed). Show it,
    // save it, then transparently retry the SAME request now that the
    // header will be set -- the person only sees this modal once, the
    // very first time they ever do something destructive on a given
    // device, the same way a freshly created AI token is shown once.
    // _isRetry guards against ever looping more than once.
    if (res.status === 401 && body && body.deviceSecret && !_isRetry) {
      setDeviceSecret(body.deviceSecret);
      await showDeviceSecretModal(body.deviceSecret);
      return api(path, options, true);
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

  const listProjects = () => api('/');
  const getProject = (id) => api(`/${id}`);
  const createProject = (name, description) =>
    api('/', { method: 'POST', body: JSON.stringify({ name, description }) });
  const regenerateToken = (id) =>
    api(`/${id}/regenerate-token`, { method: 'POST' });
  const deleteProject = (id) => api(`/${id}`, { method: 'DELETE' });

  // -------------------------------------------------------------
  // Local persistence: which project is "current" on this device.
  // This is UI convenience state only -- never a secret, never the
  // token. Safe to keep in localStorage.
  // -------------------------------------------------------------

  const CURRENT_KEY = 'aihub:currentProjectId';

  function getCurrentProjectId() {
    return localStorage.getItem(CURRENT_KEY);
  }

  function setCurrentProjectId(id) {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  }

  // -------------------------------------------------------------
  // Local persistence: the per-device write-secret (see
  // requireDeviceSecret in backend/middleware/auth.js). Unlike
  // currentProjectId, this genuinely IS a secret -- localStorage is
  // still the right place for it (same trust boundary as the device
  // itself, matching this app's "no cloud login" design), but unlike
  // currentProjectId this should never be logged, displayed after the
  // one-time reveal, or sent anywhere except this app's own API.
  // -------------------------------------------------------------

  const DEVICE_SECRET_KEY = 'aihub:deviceSecret';

  function getDeviceSecret() {
    return localStorage.getItem(DEVICE_SECRET_KEY);
  }

  function setDeviceSecret(secret) {
    if (secret) localStorage.setItem(DEVICE_SECRET_KEY, secret);
    else localStorage.removeItem(DEVICE_SECRET_KEY);
  }

  // -------------------------------------------------------------
  // Small DOM helpers (no framework -- see architecture rule #1)
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

  // -------------------------------------------------------------
  // Focus trap -- shared by both modal types. Keeps Tab/Shift+Tab
  // cycling within the modal instead of escaping to background
  // content, and marks the modal for screen readers. Returns a
  // cleanup function to remove the keydown listener.
  // -------------------------------------------------------------

  function trapFocus(modal) {
    function onKeydown(e) {
      if (e.key !== 'Tab') return;
      const focusable = modal.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    modal.addEventListener('keydown', onKeydown);
    return () => modal.removeEventListener('keydown', onKeydown);
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
  // Toast / inline status -- lightweight, no dependency on any
  // shell-provided notification system (Session 1 may add a nicer
  // one later; this degrades gracefully if so, see init()).
  // -------------------------------------------------------------

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
  // Token reveal modal -- shown exactly once, at creation or
  // regeneration. This is the single most important UI moment in
  // this whole lane: if the user doesn't copy it here, it's gone.
  // Mirrors GitHub's own PAT-creation UX intentionally.
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // Device secret reveal -- shown exactly once, the very first time
  // any write is attempted on a device/deployment with no secret yet
  // (see requireDeviceSecret in backend/middleware/auth.js). Same
  // safety properties as showTokenModal below: no Escape, no
  // tap-outside dismiss, focus trapped, since losing this before it's
  // saved has the same "gone for good" consequence as an AI token --
  // the server never shows it again, only the low-level curl-style
  // retry-with-a-new-one path described in that middleware's comment.
  //
  // Returns a Promise that resolves once the person confirms they've
  // saved it, so api()'s retry logic can await this before resending
  // the original request with the header now set.
  // -------------------------------------------------------------

  function showDeviceSecretModal(secret) {
    return new Promise((resolve) => {
      const overlay = h('div', { class: 'aihub-modal-overlay' });

      const copyBtn = h(
        'button',
        {
          class: 'aihub-btn aihub-btn--primary aihub-icon-row',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(secret);
              copyBtn.innerHTML = '';
              copyBtn.appendChild(window.AihubIcons.el('check', { size: 15 }));
              copyBtn.appendChild(document.createTextNode('Copied'));
              setTimeout(() => (copyBtn.textContent = 'Copy device secret'), 2000);
            } catch {
              copyBtn.textContent = 'Copy failed — select manually below';
            }
          },
        },
        'Copy device secret'
      );

      const doneBtn = h(
        'button',
        {
          class: 'aihub-btn',
          onclick: () => {
            overlay.remove();
            resolve();
          },
        },
        "I've saved it"
      );

      const titleId = `aihub-device-secret-title-${Math.random().toString(36).slice(2, 9)}`;
      const modal = h(
        'div',
        { class: 'aihub-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        [
          h('h2', { id: titleId }, 'Device secret created'),
          h(
            'p',
            { class: 'aihub-modal-warning' },
            'This device needed a write secret and one was just created. Copy it now — it will not be shown again. Losing it means you\u2019ll need to reset it from wherever this app\u2019s server logs are visible.'
          ),
          h('code', { class: 'aihub-token-display', tabindex: '0' }, secret),
          h('div', { class: 'aihub-modal-actions' }, [copyBtn, doneBtn]),
        ]
      );

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Same reasoning as showTokenModal: no Escape, no tap-outside.
      trapFocus(modal);
      modal.querySelector('.aihub-token-display').focus();
    });
  }

  function showTokenModal({ token, projectName, isRegeneration }) {
    const overlay = h('div', { class: 'aihub-modal-overlay' });

    const copyBtn = h(
      'button',
      {
        class: 'aihub-btn aihub-btn--primary aihub-icon-row',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(token);
            copyBtn.innerHTML = '';
            copyBtn.appendChild(window.AihubIcons.el('check', { size: 15 }));
            copyBtn.appendChild(document.createTextNode('Copied'));
            setTimeout(() => (copyBtn.textContent = 'Copy token'), 2000);
          } catch {
            // Clipboard API can fail (permissions, insecure context on
            // some mobile browsers) -- the token is still selectable
            // text in the <code> block below, so this isn't fatal.
            copyBtn.textContent = 'Copy failed — select manually below';
          }
        },
      },
      'Copy token'
    );

    const doneBtn = h(
      'button',
      {
        class: 'aihub-btn',
        onclick: () => overlay.remove(),
      },
      "I've copied it"
    );

    const titleId = `aihub-token-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aihub-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('h2', { id: titleId }, isRegeneration ? 'New AI token generated' : `"${projectName}" created`),
        h(
          'p',
          { class: 'aihub-modal-warning' },
          isRegeneration
            ? 'The previous token is now invalid. This new one is shown only once.'
            : 'This token is shown only once. Copy it now — there is no way to view it again, only regenerate a new one.'
        ),
        h('code', { class: 'aihub-token-display', tabindex: '0' }, token),
        h('div', { class: 'aihub-modal-actions' }, [copyBtn, doneBtn]),
      ]
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Trap focus loosely: Escape does NOT close this modal. The user
    // must explicitly confirm they've copied it -- an accidental
    // Escape/tap-outside dismissing a token they haven't saved would
    // be a real loss, so we deliberately don't wire that up.
    trapFocus(modal);
    modal.querySelector('.aihub-token-display').focus();
  }

  // -------------------------------------------------------------
  // Destructive-action confirmation -- shared by delete-project and
  // regenerate-token (regeneration is "soft destructive": it doesn't
  // delete data, but it does immediately break any AI session still
  // using the old token, so it gets the same explicit-confirm treatment).
  // -------------------------------------------------------------

  function confirmDestructive({ title, body, confirmLabel, onConfirm }) {
    // Guard against a rapid double-tap on the icon button that opens
    // this (common on touchscreens) stacking two overlays before the
    // first one visually registers. Also a safe backstop against any
    // other modal already being open.
    if (document.querySelector('.aihub-modal-overlay')) return;

    const overlay = h('div', { class: 'aihub-modal-overlay' });
    let releaseFocusTrap = () => {};

    function close() {
      document.removeEventListener('keydown', onKeydown);
      releaseFocusTrap();
      overlay.remove();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    const cancelBtn = h('button', { class: 'aihub-btn', onclick: close }, 'Cancel');

    const confirmBtn = h(
      'button',
      {
        class: 'aihub-btn aihub-btn--danger',
        onclick: async () => {
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Working…';
          try {
            await onConfirm();
            close();
          } catch (err) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = confirmLabel;
            alert(err.message || 'Something went wrong.');
          }
        },
      },
      confirmLabel
    );

    const titleId = `aihub-confirm-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aihub-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('h2', { id: titleId }, title),
        h('p', {}, body),
        h('div', { class: 'aihub-modal-actions' }, [cancelBtn, confirmBtn]),
      ]
    );

    overlay.appendChild(modal);
    // Tap outside the modal cancels, same as Escape. Safe here because
    // canceling just abandons a destructive action the user hasn't
    // confirmed yet -- unlike showTokenModal, nothing is lost. That
    // modal intentionally has neither of these affordances.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    releaseFocusTrap = trapFocus(modal);
    cancelBtn.focus();
  }

  // -------------------------------------------------------------
  // Create-project form
  // -------------------------------------------------------------

  function renderCreateForm(mountEl, onCreated) {
    const nameInput = h('input', {
      type: 'text',
      placeholder: 'Project name',
      class: 'aihub-input',
      required: 'required',
      maxlength: '80',
    });
    const descInput = h('textarea', {
      placeholder: 'What is this project? (optional)',
      class: 'aihub-input aihub-textarea',
      rows: '2',
      maxlength: '280',
    });
    const submitBtn = h('button', { class: 'aihub-btn aihub-btn--primary', type: 'submit' }, 'Create project');
    let isSubmitting = false;

    const form = h(
      'form',
      {
        class: 'aihub-create-form',
        onsubmit: async (e) => {
          e.preventDefault();
          if (isSubmitting) return; // guards a rapid double-tap beating the disabled state to the next event
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.focus();
            return;
          }
          isSubmitting = true;
          submitBtn.disabled = true;
          submitBtn.textContent = 'Creating…';
          try {
            const project = await createProject(name, descInput.value.trim());
            nameInput.value = '';
            descInput.value = '';
            showTokenModal({ token: project.token, projectName: project.name, isRegeneration: false });
            onCreated(project);
          } catch (err) {
            showStatus(mountEl, err.message, 'error');
          } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create project';
          }
        },
      },
      [nameInput, descInput, submitBtn]
    );

    return form;
  }

  // -------------------------------------------------------------
  // Project list / switcher
  // -------------------------------------------------------------

  function renderProjectCard(project, { isCurrent, onSelect, onRegenerate, onDelete }) {
    const selectBtn = h(
      'button',
      {
        class: `aihub-project-card ${isCurrent ? 'aihub-project-card--current' : ''}`,
        onclick: () => onSelect(project.id),
      },
      [
        h('div', { class: 'aihub-project-card-name' }, project.name),
        project.description
          ? h('div', { class: 'aihub-project-card-desc' }, project.description)
          : null,
        h('div', { class: 'aihub-project-card-meta' }, `Created ${timeAgo(project.createdAt)}`),
        isCurrent ? h('span', { class: 'aihub-badge' }, 'Current') : null,
      ]
    );

    const regenBtn = h(
      'button',
      {
        class: 'aihub-icon-btn',
        title: 'Regenerate AI token',
        'aria-label': `Regenerate token for ${project.name}`,
        onclick: (e) => {
          e.stopPropagation();
          onRegenerate(project);
        },
      },
      window.AihubIcons.el('refresh', { size: 16 })
    );

    const deleteBtn = h(
      'button',
      {
        class: 'aihub-icon-btn aihub-icon-btn--danger',
        title: 'Delete project',
        'aria-label': `Delete ${project.name}`,
        onclick: (e) => {
          e.stopPropagation();
          onDelete(project);
        },
      },
      window.AihubIcons.el('trash', { size: 16 })
    );

    return h('div', { class: 'aihub-project-row' }, [selectBtn, regenBtn, deleteBtn]);
  }

  async function renderProjectList(mountEl, listEl, currentId, callbacks) {
    clear(listEl);
    listEl.appendChild(h('p', { class: 'aihub-loading-state' }, 'Loading projects…'));

    let projects;
    try {
      projects = await listProjects();
    } catch (err) {
      clear(listEl);
      const retryBtn = h(
        'button',
        {
          class: 'aihub-btn aihub-btn--subtle',
          onclick: () => renderProjectList(mountEl, listEl, currentId, callbacks),
        },
        'Try again'
      );
      listEl.appendChild(
        h('div', { class: 'aihub-error-state' }, [
          h('p', {}, `Couldn't load projects: ${err.message}`),
          retryBtn,
        ])
      );
      return;
    }

    clear(listEl);

    if (projects.length === 0) {
      listEl.appendChild(
        h('p', { class: 'aihub-empty-state' }, 'No projects yet. Create one above to get started.')
      );
      return;
    }

    for (const project of projects) {
      listEl.appendChild(
        renderProjectCard(project, {
          isCurrent: project.id === currentId,
          ...callbacks,
        })
      );
    }
  }

  // -------------------------------------------------------------
  // PWA install prompt
  // ------------------------------------------------------------
  // `beforeinstallprompt` only fires on Chromium-based browsers and
  // only if the PWA criteria are met (manifest + service worker --
  // both owned by Session 1). This code degrades silently on
  // browsers that never fire the event (iOS Safari notably doesn't;
  // there we just show a static "Add to Home Screen" hint instead).
  // -------------------------------------------------------------

  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.dispatchEvent(new CustomEvent('aihub:installavailable'));
  });

  function renderInstallHint(mountEl) {
    // matchMedia is universal in real browsers but not guaranteed in
    // every embedding context (some stripped-down webviews). Its
    // absence should mean "can't tell, assume not installed" -- never
    // an uncaught crash here, since this runs during the very first
    // paint of the whole app.
    const isStandalone =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true; // iOS

    if (isStandalone) return null; // already installed, nothing to show

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

    const hint = h('div', { class: 'aihub-install-hint' });

    function renderChromiumButton() {
      clear(hint);
      hint.appendChild(
        h(
          'button',
          {
            class: 'aihub-btn aihub-btn--subtle aihub-icon-row',
            onclick: async () => {
              if (!deferredInstallPrompt) return;
              deferredInstallPrompt.prompt();
              await deferredInstallPrompt.userChoice;
              deferredInstallPrompt = null;
              hint.remove();
            },
          },
          [window.AihubIcons.el('device-download', { size: 16 }), 'Install this app']
        )
      );
    }

    if (deferredInstallPrompt) {
      renderChromiumButton();
    } else {
      document.addEventListener('aihub:installavailable', renderChromiumButton, { once: true });
      if (isIOS) {
        clear(hint);
        hint.appendChild(
          h(
            'p',
            { class: 'aihub-install-hint-text' },
            'Tip: tap the Share icon, then "Add to Home Screen" to install this app.'
          )
        );
      }
    }

    return hint;
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  const ProjectManager = {
    /**
     * Mounts the full project management UI into mountEl.
     * Fires `projectselected` on `document` (detail: { projectId })
     * when the user picks a project to work in.
     */
    async init(mountEl) {
      clear(mountEl);

      const installHint = renderInstallHint(mountEl);
      if (installHint) mountEl.appendChild(installHint);

      mountEl.appendChild(h('h1', { class: 'aihub-page-title' }, 'Your projects'));

      const createForm = renderCreateForm(mountEl, () => refresh());
      mountEl.appendChild(createForm);

      const listEl = h('div', { class: 'aihub-project-list' });
      mountEl.appendChild(listEl);

      function selectProject(id) {
        setCurrentProjectId(id);
        document.dispatchEvent(new CustomEvent('projectselected', { detail: { projectId: id } }));
        // Re-render so the "Current" badge reflects the new selection
        // immediately, rather than waiting for some unrelated action
        // (create/regenerate/delete) to trigger the next refresh().
        refresh();
      }

      function refresh() {
        // Returned so callers -- including init() below -- can await
        // the first paint instead of resolving before data has loaded.
        return renderProjectList(mountEl, listEl, getCurrentProjectId(), {
          onSelect: selectProject,
          onRegenerate: (project) => {
            confirmDestructive({
              title: `Regenerate token for "${project.name}"?`,
              body:
                'The current AI token stops working immediately. Any AI session still using it will get 403s until you give it the new one.',
              confirmLabel: 'Regenerate',
              onConfirm: async () => {
                const updated = await regenerateToken(project.id);
                showTokenModal({ token: updated.token, projectName: project.name, isRegeneration: true });
              },
            });
          },
          onDelete: (project) => {
            confirmDestructive({
              title: `Delete "${project.name}"?`,
              body:
                'This permanently removes the project, all its files, session history, and activity log. This cannot be undone.',
              confirmLabel: 'Delete permanently',
              onConfirm: async () => {
                await deleteProject(project.id);
                if (getCurrentProjectId() === project.id) setCurrentProjectId(null);
                refresh();
              },
            });
          },
        });
      }

      return refresh();
    },

    // Exposed for the app shell / router (Session 1) to query without
    // reaching into internals.
    getCurrentProjectId,
    setCurrentProjectId,
    getProject,
  };

  window.ProjectManager = ProjectManager;
})();
