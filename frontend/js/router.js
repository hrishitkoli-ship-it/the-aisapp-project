/**
 * router.js
 * ------------------------------------------------------------------
 * Session 1 lane. Small hash-based router + the persistent app-shell
 * chrome (header, bottom tab bar). No framework, no History API
 * pushState -- hash routing means the existing server.js SPA fallback
 * doesn't even need to inspect the path beyond serving index.html,
 * and back/forward/refresh all just work with zero server-side
 * routing logic.
 *
 * Routes:
 *   #/                              -> project list (Session 3's UI)
 *   #/project/:id/workspace         -> Session 1 (this session)
 *   #/project/:id/roster            -> Session 2's SessionRoster module
 *   #/project/:id/instructions      -> Session 2's InstructionsPage module
 *
 * Page modules (roster.js, instructions.js) return a controller with
 * .destroy() to stop their polling; the router tears down whichever
 * one is mounted before navigating anywhere else. If a page module
 * isn't loaded at all (script 404, bad deploy), an honest fallback
 * message shows instead of a blank screen -- this shouldn't normally
 * trigger now that all three page modules exist.
 *
 * Integration contracts honored:
 *   - Mounts everything into <div id="app"> (Session 3's contract)
 *   - Calls ProjectManager.init(mountEl) for the "#/" route unchanged
 *   - Listens for `projectselected` (detail.projectId) fired by
 *     projects.js and navigates into that project's workspace
 *   - Keeps ProjectManager.setCurrentProjectId() in sync so Session
 *     3's "Current" badge in the project list stays correct even
 *     when navigation happens via back/forward or a shared link
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const TABS = [
    { key: 'workspace', label: 'Workspace', icon: 'folder' },
    { key: 'roster', label: 'Roster', icon: 'users' },
    { key: 'instructions', label: 'Instructions', icon: 'clipboard' },
  ];

  const appHeader = document.getElementById('app-header');
  const appMain = document.getElementById('app-main');
  const appTabbar = document.getElementById('app-tabbar');
  const appMount = document.getElementById('app'); // Session 3's contract target, nested in #app-main

  // -------------------------------------------------------------
  // Route parsing
  // -------------------------------------------------------------

  function parseHash() {
    const hash = window.location.hash.replace(/^#/, '') || '/';

    if (hash === '/settings') {
      return { name: 'settings' };
    }

    // #/migrate/:id/:key -- the key is base64url (A-Za-z0-9-_), which
    // never contains '/', so a plain split on '/' is safe and
    // unambiguous here, same reasoning as the backend composite
    // token's '.' delimiter being safe for the same alphabet.
    const migrateMatch = hash.match(/^\/migrate\/([^/]+)\/([^/]+)/);
    if (migrateMatch) {
      const [, migrationId, migrationKey] = migrateMatch;
      return { name: 'migrate', migrationId, migrationKey };
    }

    const projectMatch = hash.match(/^\/project\/([^/]+)\/([^/]+)/);
    if (projectMatch) {
      const [, projectId, page] = projectMatch;
      if (TABS.some((t) => t.key === page)) {
        return { name: 'project', projectId, page };
      }
      return { name: 'project', projectId, page: 'workspace' }; // unknown sub-page -> default tab
    }
    return { name: 'list' };
  }

  function navigateTo(hash) {
    if (window.location.hash === hash) {
      render(); // same hash won't fire hashchange -- render explicitly
    } else {
      window.location.hash = hash;
    }
  }

  // -------------------------------------------------------------
  // Header + tab bar chrome
  // -------------------------------------------------------------

  function renderThemeToggleButton() {
    const btn = document.createElement('button');
    btn.className = 'aisapp-theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle dark and light theme');
    const updateIcon = () => {
      btn.innerHTML = window.AisappIcons.svg(
        window.AisappTheme.current() === 'light' ? 'sun' : 'moon',
        { size: 17 }
      );
    };
    updateIcon();
    btn.addEventListener('click', () => {
      window.AisappTheme.toggle();
      updateIcon();
    });
    return btn;
  }

  async function renderHeaderForList() {
    appHeader.classList.remove('is-hidden');
    appHeader.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'aisapp-header-title';
    title.textContent = 'AI Collaborative Hub';
    appHeader.appendChild(title);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'aisapp-theme-toggle';
    settingsBtn.type = 'button';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.innerHTML = window.AisappIcons.svg('settings', { size: 19 });
    settingsBtn.addEventListener('click', () => navigateTo('#/settings'));
    appHeader.appendChild(settingsBtn);

    appHeader.appendChild(renderThemeToggleButton());
  }

  async function renderHeaderForSettings() {
    appHeader.classList.remove('is-hidden');
    appHeader.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'aisapp-header-back';
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back to projects');
    backBtn.innerHTML = window.AisappIcons.svg('chevron-left', { size: 20 });
    backBtn.addEventListener('click', () => navigateTo('#/'));
    appHeader.appendChild(backBtn);

    const title = document.createElement('div');
    title.className = 'aisapp-header-title';
    title.textContent = 'Settings';
    appHeader.appendChild(title);

    appHeader.appendChild(renderThemeToggleButton());
  }

  async function renderHeaderForProject(projectId) {
    appHeader.classList.remove('is-hidden');
    appHeader.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'aisapp-header-back';
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back to projects');
    backBtn.innerHTML = window.AisappIcons.svg('chevron-left', { size: 20 });
    backBtn.addEventListener('click', () => navigateTo('#/'));
    appHeader.appendChild(backBtn);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'aisapp-header-title';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'aisapp-header-eyebrow';
    eyebrow.textContent = 'Project';
    titleWrap.appendChild(eyebrow);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = 'Loading…';
    titleWrap.appendChild(nameSpan);
    appHeader.appendChild(titleWrap);

    appHeader.appendChild(renderThemeToggleButton());

    // Fetch the project name without blocking the rest of the shell
    // from rendering -- this is a "nice to have" label, not gating.
    try {
      const project = await window.ProjectManager.getProject(projectId);
      nameSpan.textContent = project.name;
    } catch {
      nameSpan.textContent = 'Unknown project';
    }
  }

  function renderTabbar(projectId, activePage) {
    appTabbar.classList.remove('is-hidden');
    appTabbar.innerHTML = '';
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = `aisapp-tab${tab.key === activePage ? ' is-active' : ''}`;
      btn.type = 'button';
      btn.setAttribute('aria-current', tab.key === activePage ? 'page' : 'false');
      const icon = document.createElement('span');
      icon.className = 'aisapp-tab-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = window.AisappIcons.svg(tab.icon, { size: 19 });
      const label = document.createElement('span');
      label.textContent = tab.label;
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', () => navigateTo(`#/project/${projectId}/${tab.key}`));
      appTabbar.appendChild(btn);
    }
  }

  function hideTabbar() {
    appTabbar.classList.add('is-hidden');
    appTabbar.innerHTML = '';
  }

  // -------------------------------------------------------------
  // Page module lifecycle -- roster.js and instructions.js both
  // return a controller with .destroy() (stops their polling timers).
  // Track whichever one is currently mounted so navigating away -- to
  // another tab, another project, or back to the list -- tears it
  // down instead of leaking a timer that keeps polling in the
  // background forever.
  // -------------------------------------------------------------

  let currentPageController = null;

  function teardownCurrentPage() {
    if (currentPageController && typeof currentPageController.destroy === 'function') {
      currentPageController.destroy();
    }
    currentPageController = null;
  }

  // -------------------------------------------------------------
  // Placeholder for pages that still genuinely aren't loaded (should
  // not normally trigger now that Session 2's modules exist -- kept
  // as a defensive fallback, e.g. if a script tag 404s on a bad
  // deploy, rather than silently showing a blank page).
  // -------------------------------------------------------------

  function renderNotYetBuilt(pageLabel) {
    appMount.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'aisapp-panel';
    panel.style.textAlign = 'center';
    panel.style.color = 'var(--aisapp-text-dim)';
    panel.innerHTML = `<p style="margin:0 0 4px;font-weight:600;color:var(--aisapp-text)">${pageLabel}</p><p style="margin:0;font-size:0.85rem">This page's script didn't load -- check the browser console.</p>`;
    appMount.appendChild(panel);
  }

  // -------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------

  function animatePageEnter() {
    appMount.classList.remove('aisapp-page-enter');
    // Force reflow so removing and re-adding the class triggers the
    // animation fresh every time, even on same-route re-renders.
    void appMount.offsetWidth;
    appMount.classList.add('aisapp-page-enter');
  }

  function render() {
    const route = parseHash();
    appMain.scrollTop = 0; // reset scroll position on every navigation
    teardownCurrentPage(); // stop whatever was polling on the previous page/project
    animatePageEnter();

    if (route.name === 'settings') {
      hideTabbar();
      renderHeaderForSettings();
      if (window.SettingsPage) {
        window.SettingsPage.init(appMount);
      } else {
        renderNotYetBuilt('Settings');
      }
      return;
    }

    if (route.name === 'migrate') {
      hideTabbar();
      renderHeaderForSettings(); // reuses the same back-to-list chrome
      renderMigrationRedeem(route.migrationId, route.migrationKey);
      return;
    }

    if (route.name === 'list') {
      hideTabbar();
      renderHeaderForList();
      window.ProjectManager.init(appMount);
      return;
    }

    // route.name === 'project'
    window.ProjectManager.setCurrentProjectId(route.projectId);
    renderHeaderForProject(route.projectId);
    renderTabbar(route.projectId, route.page);

    if (route.page === 'workspace') {
      if (window.AisappWorkspace) {
        // workspace.js manages its own state on repeated mount() calls
        // and has no polling to tear down, so it doesn't return/need a
        // destroy-style controller the way roster/instructions do.
        window.AisappWorkspace.mount(appMount, route.projectId);
      } else {
        renderNotYetBuilt('Workspace');
      }
    } else if (route.page === 'roster') {
      if (window.SessionRoster) {
        currentPageController = window.SessionRoster.init(appMount, route.projectId);
      } else {
        renderNotYetBuilt('AI Session Roster');
      }
    } else if (route.page === 'instructions') {
      if (window.InstructionsPage) {
        // init() is async (it fetches instructions data before
        // rendering) -- the controller isn't available until it
        // resolves, so guard against a stale mount if the user
        // navigates away again before it finishes.
        const projectIdAtCallTime = route.projectId;
        window.InstructionsPage.init(appMount, route.projectId).then((ctl) => {
          const currentRoute = parseHash();
          const stillOnSamePage =
            currentRoute.page === 'instructions' && currentRoute.projectId === projectIdAtCallTime;
          if (stillOnSamePage) {
            currentPageController = ctl;
          } else if (ctl && typeof ctl.destroy === 'function') {
            ctl.destroy(); // navigated away while this was still loading
          }
        });
      } else {
        renderNotYetBuilt('Instructions & Functionalities');
      }
    }
  }

  /** Renders the one-shot "you've been sent a secret" redemption view
   *  for a #/migrate/:id/:key link. Not a persistent page module like
   *  Settings -- this is a single async action with three outcomes
   *  (loading, success showing the decrypted text, or error), so it's
   *  simple enough to keep inline here rather than as a separate file. */
  async function renderMigrationRedeem(id, key) {
    appMount.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'aisapp-panel';
    panel.style.textAlign = 'center';
    panel.innerHTML = '<p style="margin:0;color:var(--aisapp-text-dim)">Decrypting\u2026</p>';
    appMount.appendChild(panel);

    if (!window.AisappMigration) {
      panel.innerHTML =
        '<p style="margin:0;color:var(--aisapp-danger)">Migration script didn\u2019t load -- check the browser console.</p>';
      return;
    }

    try {
      const plaintext = await window.AisappMigration.redeemLink(id, key);
      panel.innerHTML = '';
      const label = document.createElement('p');
      label.style.cssText = 'margin:0 0 10px;font-weight:600;color:var(--aisapp-text)';
      label.textContent = 'Received:';
      const box = document.createElement('textarea');
      box.className = 'aisapp-input aisapp-textarea';
      box.readOnly = true;
      box.rows = 4;
      box.value = plaintext;
      box.style.textAlign = 'left';
      panel.appendChild(label);
      panel.appendChild(box);
      const hint = document.createElement('p');
      hint.style.cssText = 'margin:10px 0 0;font-size:0.8rem;color:var(--aisapp-text-dim)';
      hint.textContent = 'This link has now been used and won\u2019t work again.';
      panel.appendChild(hint);
    } catch (err) {
      panel.innerHTML = `<p style="margin:0;color:var(--aisapp-danger)">${err.message}</p>`;
    }
  }

  // -------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------

  window.addEventListener('hashchange', render);

  document.addEventListener('projectselected', (e) => {
    navigateTo(`#/project/${e.detail.projectId}/workspace`);
  });

  // Note: <div id="app"> is Session 3's mount point, nested inside
  // <main id="app-main">. Router owns app-main's chrome; ProjectManager
  // and page modules own #app's contents.
  document.addEventListener('DOMContentLoaded', render);
  if (document.readyState !== 'loading') render();
})();

