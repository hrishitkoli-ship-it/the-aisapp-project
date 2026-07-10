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
 *   #/project/:id/roster            -> Session 2 (placeholder for now)
 *   #/project/:id/instructions      -> Session 2 (placeholder for now)
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
    { key: 'workspace', label: 'Workspace', icon: '📁' },
    { key: 'roster', label: 'Roster', icon: '👥' },
    { key: 'instructions', label: 'Instructions', icon: '📋' },
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
    btn.className = 'aihub-theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle dark and light theme');
    const updateIcon = () => {
      btn.textContent = window.AihubTheme.current() === 'light' ? '☀' : '☾';
    };
    updateIcon();
    btn.addEventListener('click', () => {
      window.AihubTheme.toggle();
      updateIcon();
    });
    return btn;
  }

  async function renderHeaderForList() {
    appHeader.classList.remove('is-hidden');
    appHeader.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'aihub-header-title';
    title.textContent = 'AI Collaborative Hub';
    appHeader.appendChild(title);
    appHeader.appendChild(renderThemeToggleButton());
  }

  async function renderHeaderForProject(projectId) {
    appHeader.classList.remove('is-hidden');
    appHeader.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'aihub-header-back';
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back to projects');
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => navigateTo('#/'));
    appHeader.appendChild(backBtn);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'aihub-header-title';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'aihub-header-eyebrow';
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
      btn.className = `aihub-tab${tab.key === activePage ? ' is-active' : ''}`;
      btn.type = 'button';
      btn.setAttribute('aria-current', tab.key === activePage ? 'page' : 'false');
      const icon = document.createElement('span');
      icon.className = 'aihub-tab-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = tab.icon;
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
  // Placeholder for pages not yet built (Session 2's lane) --
  // matches Session 3's own placeholder tone: honest, not a crash,
  // not pretending the feature exists.
  // -------------------------------------------------------------

  function renderNotYetBuilt(pageLabel) {
    appMount.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'aihub-panel';
    panel.style.textAlign = 'center';
    panel.style.color = 'var(--aihub-text-dim)';
    panel.innerHTML = `<p style="margin:0 0 4px;font-weight:600;color:var(--aihub-text)">${pageLabel}</p><p style="margin:0;font-size:0.85rem">Not built yet in this lane -- this is Session 2's scope per INSTRUCTIONS.md.</p>`;
    appMount.appendChild(panel);
  }

  // -------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------

  function render() {
    const route = parseHash();
    appMain.scrollTop = 0; // reset scroll position on every navigation

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
      if (window.AihubWorkspace) {
        window.AihubWorkspace.mount(appMount, route.projectId);
      } else {
        renderNotYetBuilt('Workspace');
      }
    } else if (route.page === 'roster') {
      renderNotYetBuilt('AI Session Roster');
    } else if (route.page === 'instructions') {
      renderNotYetBuilt('Instructions & Functionalities');
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
