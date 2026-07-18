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

  const CURRENT_KEY = 'aisapp:currentProjectId';
  const CURRENT_KEY_OLD = 'aihub:currentProjectId'; // pre-rename key, see below

  function getCurrentProjectId() {
    return migrateKey(CURRENT_KEY_OLD, CURRENT_KEY);
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

  const DEVICE_SECRET_KEY = 'aisapp:deviceSecret';
  const DEVICE_SECRET_KEY_OLD = 'aihub:deviceSecret'; // pre-rename key, see below

  // One-time migration for the "aihub" -> "aisapp" naming rename: a
  // browser that already has a value under the OLD key gets it copied
  // to the NEW key (and the old one cleared) on first read after this
  // ships, rather than silently losing it. This matters most for
  // deviceSecret specifically -- losing it re-triggers the exact
  // "missing or invalid device secret" wall this app just got a
  // person unblocked from via a manual database reset; a bare rename
  // with no migration would immediately undo that recovery for
  // anyone who'd already saved a secret under the old key.
  function migrateKey(oldKey, newKey) {
    const current = localStorage.getItem(newKey);
    if (current !== null) return current;
    const legacy = localStorage.getItem(oldKey);
    if (legacy !== null) {
      localStorage.setItem(newKey, legacy);
      localStorage.removeItem(oldKey);
    }
    return legacy;
  }

  function getDeviceSecret() {
    return migrateKey(DEVICE_SECRET_KEY_OLD, DEVICE_SECRET_KEY);
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

  function showStatus(container, message, kind = 'info') {
    const existing = container.querySelector('.aisapp-status');
    if (existing) existing.remove();
    const el = h('div', { class: `aisapp-status aisapp-status--${kind}` }, message);
    container.prepend(el);
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
      const overlay = h('div', { class: 'aisapp-modal-overlay' });

      const copyBtn = h(
        'button',
        {
          class: 'aisapp-btn aisapp-btn--primary aisapp-icon-row',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(secret);
              copyBtn.innerHTML = '';
              copyBtn.appendChild(window.AisappIcons.el('check', { size: 15 }));
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
          class: 'aisapp-btn',
          onclick: () => {
            overlay.remove();
            resolve();
          },
        },
        "I've saved it"
      );

      const titleId = `aisapp-device-secret-title-${Math.random().toString(36).slice(2, 9)}`;
      const modal = h(
        'div',
        { class: 'aisapp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        [
          h('h2', { id: titleId }, 'Device secret created'),
          h(
            'p',
            { class: 'aisapp-modal-warning' },
            'This device needed a write secret and one was just created. Copy it now — it will not be shown again. Losing it means you\u2019ll need to reset it from wherever this app\u2019s server logs are visible.'
          ),
          h('code', { class: 'aisapp-token-display', tabindex: '0' }, secret),
          h('div', { class: 'aisapp-modal-actions' }, [copyBtn, doneBtn]),
        ]
      );

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Same reasoning as showTokenModal: no Escape, no tap-outside.
      trapFocus(modal);
      modal.querySelector('.aisapp-token-display').focus();
    });
  }

  function showTokenModal({ token, projectName, isRegeneration, onClose }) {
    const overlay = h('div', { class: 'aisapp-modal-overlay' });

    const copyBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary aisapp-icon-row',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(token);
            copyBtn.innerHTML = '';
            copyBtn.appendChild(window.AisappIcons.el('check', { size: 15 }));
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
        class: 'aisapp-btn',
        onclick: () => {
          overlay.remove();
          if (onClose) onClose();
        },
      },
      "I've copied it"
    );

    const titleId = `aisapp-token-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aisapp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('h2', { id: titleId }, isRegeneration ? 'New AI token generated' : `"${projectName}" created`),
        h(
          'p',
          { class: 'aisapp-modal-warning' },
          isRegeneration
            ? 'The previous token is now invalid. This new one is shown only once.'
            : 'This token is shown only once. Copy it now — there is no way to view it again, only regenerate a new one.'
        ),
        h('code', { class: 'aisapp-token-display', tabindex: '0' }, token),
        h('div', { class: 'aisapp-modal-actions' }, [copyBtn, doneBtn]),
      ]
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Trap focus loosely: Escape does NOT close this modal. The user
    // must explicitly confirm they've copied it -- an accidental
    // Escape/tap-outside dismissing a token they haven't saved would
    // be a real loss, so we deliberately don't wire that up.
    trapFocus(modal);
    modal.querySelector('.aisapp-token-display').focus();
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
    if (document.querySelector('.aisapp-modal-overlay')) return;

    const overlay = h('div', { class: 'aisapp-modal-overlay' });
    let releaseFocusTrap = () => {};

    function close() {
      document.removeEventListener('keydown', onKeydown);
      releaseFocusTrap();
      overlay.remove();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    const cancelBtn = h('button', { class: 'aisapp-btn', onclick: close }, 'Cancel');

    const confirmBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--danger',
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

    const titleId = `aisapp-confirm-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aisapp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('h2', { id: titleId }, title),
        h('p', {}, body),
        h('div', { class: 'aisapp-modal-actions' }, [cancelBtn, confirmBtn]),
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
  // Create-project form element builder
  //
  // Separated from the modal shell so the same form logic is
  // reusable -- previously the form was mounted inline on the page,
  // now it lives inside a modal opened via the FAB (#15). The caller
  // supplies onCreated(project) and showErr(msg, kind, err) so error
  // display works whether the form is inside a modal or anywhere else.
  // -------------------------------------------------------------

  function buildCreateFormEl(onCreated, showErr) {
    const nameInput = h('input', {
      type: 'text',
      placeholder: 'Project name',
      class: 'aisapp-input',
      required: 'required',
      maxlength: '80',
    });
    const descInput = h('textarea', {
      placeholder: 'What is this project? (optional)',
      class: 'aisapp-input aisapp-textarea',
      rows: '2',
      maxlength: '280',
    });
    const submitBtn = h('button', { class: 'aisapp-btn aisapp-btn--primary', type: 'submit' }, 'Create project');
    let isSubmitting = false;

    const form = h('form', { class: 'aisapp-create-form' }, [nameInput, descInput, submitBtn]);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isSubmitting) return; // guards a rapid double-tap beating the disabled state
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
        onCreated(project);
      } catch (err) {
        showErr(err.message, 'error', err);
      } finally {
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create project';
      }
    });

    return form;
  }

  // -------------------------------------------------------------
  // Project list / switcher
  // -------------------------------------------------------------

  function renderProjectCard(project, { isCurrent, onSelect, onRegenerate, onDelete }) {
    const selectBtn = h(
      'button',
      {
        class: `aisapp-project-card ${isCurrent ? 'aisapp-project-card--current' : ''}`,
        onclick: () => onSelect(project.id),
      },
      [
        h('div', { class: 'aisapp-project-card-name' }, project.name),
        project.description
          ? h('div', { class: 'aisapp-project-card-desc' }, project.description)
          : null,
        h('div', { class: 'aisapp-project-card-meta' }, `Created ${timeAgo(project.createdAt)}`),
        isCurrent ? h('span', { class: 'aisapp-badge' }, 'Current') : null,
      ]
    );

    const regenBtn = h(
      'button',
      {
        class: 'aisapp-icon-btn',
        title: 'Regenerate AI token',
        'aria-label': `Regenerate token for ${project.name}`,
        onclick: (e) => {
          e.stopPropagation();
          onRegenerate(project);
        },
      },
      window.AisappIcons.el('refresh', { size: 16 })
    );

    const deleteBtn = h(
      'button',
      {
        class: 'aisapp-icon-btn aisapp-icon-btn--danger',
        title: 'Delete project',
        'aria-label': `Delete ${project.name}`,
        onclick: (e) => {
          e.stopPropagation();
          onDelete(project);
        },
      },
      window.AisappIcons.el('trash', { size: 16 })
    );

    return h('div', { class: 'aisapp-project-row' }, [selectBtn, regenBtn, deleteBtn]);
  }

  // Renders a pre-fetched list of projects into listEl. Distinct from
  // the fetch step so search filtering can re-render from allProjects
  // without another network round-trip.
  function renderProjectCards(listEl, projects, currentId, callbacks) {
    clear(listEl);

    if (projects.length === 0) {
      listEl.appendChild(
        h('p', { class: 'aisapp-empty-state' }, 'No projects match your search.')
      );
      return;
    }

    projects.forEach((project, i) => {
      const card = renderProjectCard(project, {
        isCurrent: project.id === currentId,
        ...callbacks,
      });
      // Stagger entrance: each card comes in 40ms after the previous.
      card.classList.add('aisapp-list-item-enter');
      card.style.animationDelay = `${i * 40}ms`;
      listEl.appendChild(card);
    });
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
    document.dispatchEvent(new CustomEvent('aisapp:installavailable'));
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

    const hint = h('div', { class: 'aisapp-install-hint' });

    function renderChromiumButton() {
      clear(hint);
      hint.appendChild(
        h(
          'button',
          {
            class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row',
            onclick: async () => {
              if (!deferredInstallPrompt) return;
              deferredInstallPrompt.prompt();
              await deferredInstallPrompt.userChoice;
              deferredInstallPrompt = null;
              hint.remove();
            },
          },
          [window.AisappIcons.el('device-download', { size: 16 }), 'Install this app']
        )
      );
    }

    if (deferredInstallPrompt) {
      renderChromiumButton();
    } else {
      document.addEventListener('aisapp:installavailable', renderChromiumButton, { once: true });
      if (isIOS) {
        clear(hint);
        hint.appendChild(
          h(
            'p',
            { class: 'aisapp-install-hint-text' },
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

      // All fetched projects -- kept module-level within this closure
      // so the search filter can re-render from it without refetching.
      let allProjects = [];
      let searchTerm = '';

      const installHint = renderInstallHint(mountEl);
      if (installHint) mountEl.appendChild(installHint);

      // -- Home hero (#14) --------------------------------------
      // Visual hierarchy: eyebrow label → title → subtle descriptor.
      // Uses existing --aisapp-* tokens entirely; no new colours.
      const hero = h('div', { class: 'aisapp-home-hero' }, [
        h('span', { class: 'aisapp-eyebrow' }, 'AI Collaborative Hub'),
        h('h1', { class: 'aisapp-home-title' }, 'Your projects'),
        h(
          'p',
          { class: 'aisapp-home-subtitle' },
          'Pick a project to open its workspace, or create one below.'
        ),
      ]);
      mountEl.appendChild(hero);

      // -- Search bar (#11) ------------------------------------
      // Filters the already-fetched allProjects list client-side so
      // typing doesn't trigger network requests. Clears alongside the
      // rest of mountEl whenever init() is called again (e.g. project
      // selected → back → re-mount), which is the right behavior.
      const searchInput = h('input', {
        type: 'search',
        placeholder: 'Search projects…',
        class: 'aisapp-search-input',
        'aria-label': 'Search projects',
      });
      searchInput.addEventListener('input', () => {
        searchTerm = searchInput.value.trim().toLowerCase();
        applyFilter();
      });
      mountEl.appendChild(searchInput);

      const listEl = h('div', { class: 'aisapp-project-list' });
      mountEl.appendChild(listEl);

      // -- FAB (#15) -------------------------------------------
      // Blue circular button fixed at bottom-right, above the tab
      // bar. Appended to mountEl rather than document.body so the
      // router naturally cleans it up when this page unmounts (the
      // router replaces mountEl's content on navigation). position:
      // fixed CSS still positions relative to viewport, not mountEl,
      // because mountEl has no transform/filter ancestor.
      const fab = h('button', {
        class: 'aisapp-fab',
        'aria-label': 'Create new project',
        title: 'Create new project',
      });
      fab.appendChild(window.AisappIcons.el('plus', { size: 24 }));
      fab.addEventListener('click', () => openCreateModal());
      mountEl.appendChild(fab);

      // Shared callbacks passed to renderProjectCards -- defined here
      // so selectProject / refresh closures resolve correctly.
      function selectProject(id) {
        setCurrentProjectId(id);
        document.dispatchEvent(new CustomEvent('projectselected', { detail: { projectId: id } }));
        // Re-render so the "Current" badge reflects the new selection
        // immediately, without waiting for an unrelated action.
        renderProjectCards(listEl, applySearchFilter(), getCurrentProjectId(), callbacks);
      }

      const callbacks = {
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
      };

      function applySearchFilter() {
        if (!searchTerm) return allProjects;
        return allProjects.filter(
          (p) =>
            p.name.toLowerCase().includes(searchTerm) ||
            (p.description || '').toLowerCase().includes(searchTerm)
        );
      }

      function applyFilter() {
        const filtered = applySearchFilter();
        if (allProjects.length === 0) {
          // Don't show "no match" while list is still loading or genuinely empty
          return;
        }
        if (filtered.length === 0 && searchTerm) {
          clear(listEl);
          listEl.appendChild(
            h('p', { class: 'aisapp-empty-state' }, `No projects match "${searchInput.value.trim()}".`)
          );
        } else {
          renderProjectCards(listEl, filtered, getCurrentProjectId(), callbacks);
        }
      }

      // -- Create-project modal (#15) --------------------------
      // Opens a modal sheet with the create form. The inline form
      // that used to live directly on the page is gone; all creation
      // now goes through this path, opened via the FAB above.
      function openCreateModal() {
        // Guard: don't stack modals (same guard as confirmDestructive).
        if (document.querySelector('.aisapp-modal-overlay')) return;

        const overlay = h('div', { class: 'aisapp-modal-overlay' });
        let releaseFocusTrap = () => {};

        function close() {
          document.removeEventListener('keydown', onEsc);
          releaseFocusTrap();
          overlay.remove();
        }

        function onEsc(e) {
          if (e.key === 'Escape') close();
        }

        // Status area inside the modal -- errors surface here rather
        // than on the main page behind the overlay.
        const statusArea = h('div', {});

        const form = buildCreateFormEl(
          (project) => {
            // Success: close create modal first, then show the one-time
            // token -- the two modals can't coexist safely (focus trap,
            // z-index, scroll-lock) so we sequence them.
            close();
            // onClose navigates into the project once the human confirms
            // they've saved the token -- sequenced after dismissal so the
            // workspace doesn't load behind a still-open token modal.
            showTokenModal({
              token: project.token,
              projectName: project.name,
              isRegeneration: false,
              onClose: () => selectProject(project.id),
            });
            refresh();
          },
          (msg, kind, err) => {
            // #16 (ToS gate) can reject creation with a 403 the backend
            // already phrases as human-readable ("Accept the Terms...on
            // the Settings page..."), but as plain status text it's a
            // dead end -- the person still has to find Settings
            // themselves via the tab bar. Since this modal owns its own
            // error surface, add a direct link for this one known case
            // rather than leaving it as read-only text. Keyed off the
            // response body flag (not the message string) so it doesn't
            // silently break if the wording changes.
            showStatus(statusArea, msg, kind);
            if (err && err.body && err.body.requiresTosAcceptance) {
              const statusEl = statusArea.querySelector('.aisapp-status');
              if (statusEl) {
                statusEl.appendChild(
                  h(
                    'a',
                    {
                      href: '#/settings',
                      class: 'aisapp-status-link',
                      onclick: close,
                    },
                    'Go to Settings'
                  )
                );
              }
            }
          }
        );

        const closeBtn = h('button', {
          class: 'aisapp-modal-close',
          'aria-label': 'Close',
        });
        closeBtn.appendChild(window.AisappIcons.el('x-circle', { size: 20 }));
        closeBtn.addEventListener('click', close);

        const titleId = `aisapp-create-title-${Math.random().toString(36).slice(2, 9)}`;
        const modal = h(
          'div',
          {
            class: 'aisapp-modal aisapp-create-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
          },
          [
            h('div', { class: 'aisapp-modal-header' }, [
              h('h2', { id: titleId }, 'New project'),
              closeBtn,
            ]),
            statusArea,
            form,
          ]
        );

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close();
        });
        document.addEventListener('keydown', onEsc);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        releaseFocusTrap = trapFocus(modal);
        const firstInput = modal.querySelector('input');
        if (firstInput) firstInput.focus();
      }

      // -- Keyboard shortcut: 'n' to open create modal ---------
      // Self-cleaning: checks mountEl.isConnected on every keydown
      // so it silently removes itself when the router unmounts this
      // page, rather than requiring a destroy() lifecycle hook.
      function onGlobalKeydown(e) {
        if (!mountEl.isConnected) {
          document.removeEventListener('keydown', onGlobalKeydown);
          return;
        }
        // Don't hijack keystrokes when the user is typing in an input.
        if (
          e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable
        ) return;
        if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          openCreateModal();
        }
      }
      document.addEventListener('keydown', onGlobalKeydown);

      // -- Data loading ----------------------------------------

      async function refresh() {
        clear(listEl);
        listEl.appendChild(h('p', { class: 'aisapp-loading-state' }, 'Loading projects…'));

        try {
          allProjects = await listProjects();
        } catch (err) {
          clear(listEl);
          const retryBtn = h(
            'button',
            {
              class: 'aisapp-btn aisapp-btn--subtle',
              onclick: () => refresh(),
            },
            'Try again'
          );
          listEl.appendChild(
            h('div', { class: 'aisapp-error-state' }, [
              h('p', {}, `Couldn't load projects: ${err.message}`),
              retryBtn,
            ])
          );
          return;
        }

        if (allProjects.length === 0) {
          clear(listEl);
          listEl.appendChild(
            h('p', { class: 'aisapp-empty-state' }, 'No projects yet. Tap \u002B to create one.')
          );
          return;
        }

        applyFilter();
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
