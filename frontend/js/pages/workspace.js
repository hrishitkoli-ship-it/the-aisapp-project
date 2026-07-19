/**
 * workspace.js
 * ------------------------------------------------------------------
 * Session 1 lane: Page 1 (Workspace). File tree browser + editor,
 * talking to the HUMAN-facing files API (no token needed -- the
 * browser is a human client, not an AI agent; tokens are exclusively
 * for external AI processes per the two-identity model in the
 * backend README).
 *
 * Same vanilla-DOM style as Session 3's projects.js: an h() builder,
 * a tiny fetch wrapper, no framework, no build step.
 *
 * Conflict handling (INSTRUCTIONS.md, Session 1 scope): on a 409, this
 * fetches the current server content and renders a real line-level
 * diff -- not just a version-number message -- then lets the user
 * choose to keep their edit (force write) or take the server's
 * version. It never force-writes automatically.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  // -------------------------------------------------------------
  // Fetch wrapper -- same error shape as Session 3's projects.js
  // -------------------------------------------------------------

  async function api(projectId, path, options = {}) {
    const res = await fetch(`/api/projects/${projectId}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body (rare) -- treat as empty
    }
    if (!res.ok && res.status !== 409) {
      const message = (body && body.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return { ok: res.ok, status: res.status, body };
  }

  // -------------------------------------------------------------
  // Small DOM helpers -- mirrors projects.js's h() for consistency
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

  function showStatus(mountEl, message, kind = 'info') {
    const existing = mountEl.querySelector('.aisapp-status');
    if (existing) existing.remove();
    const el = h('div', { class: `aisapp-status aisapp-status--${kind}` }, message);
    mountEl.prepend(el);
    if (kind !== 'error') setTimeout(() => el.remove(), 4000);
  }

  // -------------------------------------------------------------
  // Line-level diff (LCS-based) for the conflict dialog. Capped at
  // 2000 lines per side -- large enough for any real script file in
  // this project's actual use case (Minecraft addon scripts, config,
  // etc.), small enough that the O(n*m) DP table can't hang a mobile
  // browser tab on something unexpectedly huge.
  // -------------------------------------------------------------

  const DIFF_LINE_CAP = 2000;

  function diffLines(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) {
      return null; // caller falls back to a simple size-only notice
    }

    const m = oldLines.length;
    const n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] =
          oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const result = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        result.push({ type: 'same', line: oldLines[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        result.push({ type: 'removed', line: oldLines[i] });
        i++;
      } else {
        result.push({ type: 'added', line: newLines[j] });
        j++;
      }
    }
    while (i < m) {
      result.push({ type: 'removed', line: oldLines[i] });
      i++;
    }
    while (j < n) {
      result.push({ type: 'added', line: newLines[j] });
      j++;
    }
    return result;
  }

  function renderDiff(oldText, newText) {
    const rows = diffLines(oldText, newText);
    const container = h('div', { class: 'aisapp-diff' });

    if (rows === null) {
      container.appendChild(
        h(
          'p',
          { class: 'aisapp-diff-toolong' },
          `Both versions are large (over ${DIFF_LINE_CAP} lines) -- showing sizes instead of a full diff: yours is ${
            oldText.split('\n').length
          } lines, the server's is ${newText.split('\n').length} lines.`
        )
      );
      return container;
    }

    // Skip rendering long unchanged runs in full -- keep a little
    // context around each change instead of dumping the whole file.
    const CONTEXT = 2;
    let lastShown = -1;
    rows.forEach((row, idx) => {
      const isChange = row.type !== 'same';
      const nearChange = rows
        .slice(Math.max(0, idx - CONTEXT), idx + CONTEXT + 1)
        .some((r) => r.type !== 'same');
      if (!isChange && !nearChange) {
        if (lastShown !== -2) {
          container.appendChild(h('div', { class: 'aisapp-diff-line aisapp-diff-line--collapsed' }, '⋯'));
          lastShown = -2;
        }
        return;
      }
      lastShown = idx;
      const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
      container.appendChild(
        h('div', { class: `aisapp-diff-line aisapp-diff-line--${row.type}` }, `${prefix} ${row.line}`)
      );
    });

    return container;
  }

  // -------------------------------------------------------------
  // Module state -- reset fresh on every mount() call
  // -------------------------------------------------------------

  function freshState(projectId, mountEl) {
    return {
      projectId,
      mountEl,
      tree: [],
      expandedDirs: new Set(),
      selectedPath: null,
      editorContent: '',
      originalContent: '',
      expectedVersion: null,
      loadingTree: false,
      loadingFile: false,
      editMode: false, // false = Prism-highlighted read view, true = textarea (#10)
      wrapEnabled: false,
      autoSaveTimer: null,
      github: null, // null = not yet checked; {connected:false} or {connected:true,...} once loaded (#13)
      searchQuery: '',
      searchResults: null,
      searchLoading: false,
      creatingFile: false,
    };
  }

  /** Flat list of every file path in the current tree (no directories).
   *  Used by rename (to bulk-rename a directory's contents), the
   *  create/rename collision checks, and recent-files filtering (to
   *  drop entries for files that no longer exist). */
  function collectFilePaths(nodes) {
    let paths = [];
    for (const node of nodes || []) {
      if (node.type === 'file') paths.push(node.path);
      else if (node.children) paths = paths.concat(collectFilePaths(node.children));
    }
    return paths;
  }

  let state = null;

  // -------------------------------------------------------------
  // Tree loading + rendering
  // -------------------------------------------------------------

  async function loadTree() {
    state.loadingTree = true;
    renderShell();
    try {
      const { body } = await api(state.projectId, '/files/tree');
      state.tree = body.tree || [];
    } catch (err) {
      showStatus(state.mountEl, `Couldn't load files: ${err.message}`, 'error');
      state.tree = [];
    } finally {
      state.loadingTree = false;
      renderShell();
    }
  }

  // -------------------------------------------------------------
  // PERFORMANCE (item 4 of the human's fix/feature prompt -- "UI is
  // laggy overall... memoize list items"). This app has no React tree
  // to profile or memoize -- there's nothing here shaped like a
  // component re-render to optimize in that sense. The real, vanilla-
  // JS-shaped equivalent bug, confirmed by reading renderShell()
  // directly rather than assumed: it does clear(mountEl) + a full
  // rebuild of the toolbar AND either the tree panel or the editor,
  // on every single call -- and toggleDir() (expand/collapse ONE
  // folder) was calling the full renderShell() for that. For a
  // project with a large file tree, every folder click was tearing
  // down and rebuilding the entire toolbar + full tree DOM subtree,
  // not just the one folder that actually changed -- a real,
  // measurable cause of "feels laggy" that scales with project size,
  // not a vague performance worry.
  //
  // Fix is deliberately narrow, not a rewrite of the rendering model:
  // toggleDir() gets its own targeted re-render that swaps ONLY the
  // tree panel's DOM node, leaving the toolbar (and the editor, when
  // that's what's showing) completely untouched. Safe to scope this
  // narrowly because toggleDir() can only ever run while the tree
  // panel is the visible view in the first place (there's no way to
  // click an expand arrow that isn't on-screen), so the "what if
  // selectedPath is set" case renderShell() has to handle for other
  // callers genuinely doesn't apply here.
  //
  // Re-verified this diagnosis was still accurate against the CURRENT
  // file before writing this fix, not assumed carried-over from an
  // earlier read: workspace.js changed substantially (net -220 lines)
  // in a same-day repo-wide rebrand pass, but toggleDir()'s body is
  // byte-for-byte identical to what it was before that pass, and
  // renderShell()'s structure is unchanged apart from aihub- -> aisapp-
  // class renames. This fix uses the correct current class names
  // throughout, not stale ones from before the rebrand.
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // Recent files (quick-jump)
  // -------------------------------------------------------------
  // Per-project, localStorage-backed (same mechanism projects.js/
  // settings.js already use for the device secret) -- purely a
  // navigation convenience, so a localStorage failure (quota, private
  // browsing) degrades to "no recent list" rather than breaking file
  // open, which is why every call here is wrapped and swallows errors.

  const RECENT_FILES_MAX = 6;

  function recentFilesKey(projectId) {
    return `aisapp_recent_files_${projectId}`;
  }

  function getRecentFiles(projectId) {
    try {
      const raw = localStorage.getItem(recentFilesKey(projectId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function addRecentFile(projectId, path) {
    try {
      const current = getRecentFiles(projectId).filter((p) => p !== path);
      current.unshift(path);
      localStorage.setItem(recentFilesKey(projectId), JSON.stringify(current.slice(0, RECENT_FILES_MAX)));
    } catch {
      // Non-essential -- fail silently.
    }
  }

  function renderRecentFiles() {
    const known = new Set(collectFilePaths(state.tree));
    const recent = getRecentFiles(state.projectId).filter((p) => known.has(p) && p !== state.selectedPath);
    if (recent.length === 0) return null;

    const section = h('div', { class: 'aisapp-ws-recent' });
    section.appendChild(h('div', { class: 'aisapp-ws-recent-label' }, 'Recent'));
    for (const path of recent) {
      const name = path.split('/').pop();
      section.appendChild(
        h(
          'button',
          {
            class: 'aisapp-tree-row-clickable aisapp-tree-row--file aisapp-tree-row--recent',
            onclick: () => openFile(path),
            title: path,
          },
          [
            window.AisappIcons.fileIconEl(name, { className: 'aisapp-tree-icon', size: 15 }),
            h('span', { class: 'aisapp-tree-name' }, name),
          ]
        )
      );
    }
    return section;
  }

  // -------------------------------------------------------------
  // File tree
  // -------------------------------------------------------------

  function rerenderTreePanelOnly() {
    const existing = state.mountEl.querySelector('.aisapp-ws-tree-panel');
    if (!existing) {
      // Defensive fallback -- if the tree panel genuinely isn't in the
      // DOM for some reason (shouldn't happen given the constraint
      // above, but "shouldn't happen" isn't "provably can't happen"),
      // fall back to the full render rather than silently doing
      // nothing and leaving stale UI on screen.
      renderShell();
      return;
    }
    existing.replaceWith(renderTreePanel());
  }

  function toggleDir(path) {
    if (state.expandedDirs.has(path)) state.expandedDirs.delete(path);
    else state.expandedDirs.add(path);
    rerenderTreePanelOnly();
  }

  function renderTreeNodes(nodes, depth) {
    const container = h('div', { class: 'aisapp-tree-level' });
    for (const node of nodes) {
      if (node.type === 'directory') {
        const isOpen = state.expandedDirs.has(node.path);
        const row = h(
          'div',
          { class: 'aisapp-tree-row aisapp-tree-row--dir', style: `padding-left:${depth * 16 + 10}px` },
          [
            h(
              'button',
              { class: 'aisapp-tree-row-clickable aisapp-tree-row-main', onclick: () => toggleDir(node.path) },
              [
                h('span', { class: 'aisapp-tree-caret' }, isOpen ? '▾' : '▸'),
                window.AisappIcons.el('folder', { className: 'aisapp-tree-icon', size: 15 }),
                h('span', { class: 'aisapp-tree-name' }, node.name),
              ]
            ),
            h(
              'button',
              {
                class: 'aisapp-tree-row-rename',
                title: 'Rename folder',
                'aria-label': `Rename folder ${node.name}`,
                onclick: (e) => {
                  e.stopPropagation();
                  openRenameModal(node.path, 'directory');
                },
              },
              [window.AisappIcons.el('edit', { size: 13 })]
            ),
          ]
        );
        container.appendChild(row);
        if (isOpen) {
          container.appendChild(renderTreeNodes(node.children || [], depth + 1));
        }
      } else {
        const isSelected = state.selectedPath === node.path;
        const row = h(
          'button',
          {
            class: `aisapp-tree-row aisapp-tree-row-clickable aisapp-tree-row--file${isSelected ? ' is-selected' : ''}`,
            style: `padding-left:${depth * 16 + 10}px`,
            onclick: () => openFile(node.path),
          },
          [
            window.AisappIcons.fileIconEl(node.name, { className: 'aisapp-tree-icon', size: 15 }),
            h('span', { class: 'aisapp-tree-name' }, node.name),
          ]
        );
        container.appendChild(row);
      }
    }
    return container;
  }

  // -------------------------------------------------------------
  // File open / edit / save
  // -------------------------------------------------------------

  function hasUnsavedChanges() {
    return state.selectedPath !== null && state.editorContent !== state.originalContent;
  }

  function confirmDiscardIfNeeded() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm('You have unsaved changes to this file. Discard them?');
  }

  async function openFile(path) {
    if (state.selectedPath && !confirmDiscardIfNeeded()) return;

    state.loadingFile = true;
    state.selectedPath = path;
    renderShell();

    try {
      const { body } = await api(state.projectId, `/files/content/${path}`);
      state.editorContent = body.content;
      state.originalContent = body.content;
      state.editMode = false; // start in highlighted view mode
      // The read endpoint doesn't return a version number directly --
      // conflict tracking is keyed off the version returned by the
      // *previous write* to this path. A file that's never been
      // written through this app yet has no tracked version; we pass
      // no expectedVersion on the first save in that case, which the
      // backend treats as "no conflict check requested." Once we've
      // saved once, we track the version it hands back from then on.
      state.expectedVersion = null;
      addRecentFile(state.projectId, path);
    } catch (err) {
      showStatus(state.mountEl, `Couldn't open ${path}: ${err.message}`, 'error');
      state.selectedPath = null;
    } finally {
      state.loadingFile = false;
      renderShell();
    }
  }

  function closeFile() {
    if (!confirmDiscardIfNeeded()) return;
    state.selectedPath = null;
    state.editorContent = '';
    state.originalContent = '';
    state.expectedVersion = null;
    renderShell();
  }

  async function saveFile({ force = false } = {}) {
    const path = state.selectedPath;
    const content = state.editorContent;

    const { ok, status, body } = await api(state.projectId, `/files/content/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        content,
        expectedVersion: force ? undefined : state.expectedVersion ?? undefined,
        force,
      }),
    });

    if (ok) {
      state.originalContent = content;
      state.expectedVersion = body.version;
      showStatus(state.mountEl, `Saved (v${body.version}).`, 'info');
      renderShell();
      return;
    }

    if (status === 409) {
      await showConflictDialog(path, content, body);
      return;
    }

    showStatus(state.mountEl, `Couldn't save: ${(body && body.error) || 'unknown error'}`, 'error');
  }

  async function showConflictDialog(path, localContent, conflictBody) {
    let serverContent = null;
    try {
      const { body } = await api(state.projectId, `/files/content/${path}`);
      serverContent = body.content;
    } catch {
      serverContent = null;
    }

    const overlay = h('div', { class: 'aisapp-modal-overlay' });

    const whoWhen = conflictBody.lastModifiedBy
      ? `${conflictBody.lastModifiedBy}, ${new Date(conflictBody.lastModifiedAt).toLocaleString()}`
      : 'someone else, just now';

    const body = h('div', { class: 'aisapp-modal aisapp-modal--wide' }, [
      h('h2', {}, 'This file changed since you opened it'),
      h(
        'p',
        {},
        `Last written by ${whoWhen}. Review what's different before deciding what to keep.`
      ),
      serverContent !== null
        ? renderDiff(serverContent, localContent)
        : h('p', { class: 'aisapp-modal-warning' }, "Couldn't load the server's current version to compare."),
    ]);

    const keepMineBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary',
        onclick: async () => {
          overlay.remove();
          await saveFile({ force: true });
        },
      },
      'Keep mine (overwrite)'
    );

    const useTheirsBtn = h(
      'button',
      {
        class: 'aisapp-btn',
        onclick: () => {
          if (serverContent === null) return;
          state.editorContent = serverContent;
          state.originalContent = serverContent;
          state.expectedVersion = conflictBody.currentVersion;
          overlay.remove();
          renderShell();
          showStatus(state.mountEl, "Loaded the server's version. Your prior edit was discarded.", 'info');
        },
      },
      "Use theirs"
    );
    if (serverContent === null) useTheirsBtn.disabled = true;

    const cancelBtn = h('button', { class: 'aisapp-btn aisapp-btn--subtle', onclick: () => overlay.remove() }, 'Cancel');

    body.appendChild(h('div', { class: 'aisapp-modal-actions' }, [cancelBtn, useTheirsBtn, keepMineBtn]));
    overlay.appendChild(body);
    document.body.appendChild(overlay);
  }

  // ----------------------------------------------------------------
  // Zip download (#12) -- downloads every file in this project as a
  // .zip. Uses JSZip (loaded from CDN in index.html) so there's no
  // server-side zip stream to build and no build step needed.
  //
  // Design choices:
  // - Fetches all file content in parallel (Promise.all over the tree
  //   flat list) rather than serially -- fast for projects with many
  //   files, and matches #3's parallel-fetch pattern.
  // - Shows a brief "Preparing zip…" status, then revokes the object
  //   URL immediately after the click triggers (browser has already
  //   started the download at that point; revoking immediately is safe
  //   and avoids leaking a large in-memory Blob URL indefinitely).
  // - If JSZip isn't loaded (e.g. CDN blocked), falls back to a clear
  //   error rather than a silent failure.
  // ----------------------------------------------------------------

  async function downloadAllFilesAsZip() {
    if (typeof JSZip === 'undefined') {
      showStatus(state.mountEl, 'JSZip library not loaded — check your network connection and try refreshing.', 'error');
      return;
    }
    if (!state.tree || state.tree.length === 0) {
      showStatus(state.mountEl, 'No files to download — add some files to this project first.', 'info');
      return;
    }

    showStatus(state.mountEl, 'Preparing zip…', 'info');

    // Flatten the tree recursively into a list of file paths
    function flattenTree(nodes) {
      const paths = [];
      for (const node of nodes || []) {
        if (node.type === 'file') {
          paths.push(node.path);
        } else if (node.type === 'directory' && node.children) {
          paths.push(...flattenTree(node.children));
        }
      }
      return paths;
    }

    const filePaths = flattenTree(state.tree);
    if (filePaths.length === 0) {
      showStatus(state.mountEl, 'No files to download.', 'info');
      return;
    }

    try {
      // Fetch all file contents in parallel
      const results = await Promise.all(
        filePaths.map(async (filePath) => {
          const { body } = await api(state.projectId, `/files/content/${filePath}`);
          return { filePath, content: body.content || '' };
        })
      );

      const zip = new JSZip();
      for (const { filePath, content } of results) {
        zip.file(filePath, content);
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${state.projectId.slice(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke immediately -- browser has already initiated the download
      URL.revokeObjectURL(url);

      showStatus(state.mountEl, `Downloaded ${results.length} file${results.length === 1 ? '' : 's'} as zip.`, 'info');
    } catch (err) {
      showStatus(state.mountEl, `Couldn't create zip: ${err.message}`, 'error');
    }
  }

  // ----------------------------------------------------------------
  // GitHub integration (#13) -- connect a repo, push files. PAT-only,
  // see backend/routes/githubIntegration.js's header for why (no
  // OAuth app registration available from this environment) and for
  // the known limitation around per-agent content encryption.
  // ----------------------------------------------------------------

  async function loadGithubStatus() {
    try {
      const { body } = await api(state.projectId, '/github');
      state.github = body;
    } catch {
      state.github = { connected: false };
    }
    // Only re-render the toolbar area, not the whole shell -- avoids
    // the #4-class bug (full renderShell() tearing down the tree/editor
    // mid-interaction) for what's just a toolbar label update.
    rerenderToolbarOnly();
  }

  function rerenderToolbarOnly() {
    if (!state.mountEl) return;
    const oldToolbar = state.mountEl.querySelector('.aisapp-ws-toolbar');
    if (!oldToolbar) return; // shell not rendered yet, nothing to patch
    const newToolbar = renderToolbar();
    oldToolbar.replaceWith(newToolbar);
  }

  function openGithubModal() {
    if (document.querySelector('.aisapp-modal-overlay')) return; // one modal at a time, matches projects.js's own guard

    const overlay = h('div', { class: 'aisapp-modal-overlay' });

    function close() {
      document.removeEventListener('keydown', onEsc);
      overlay.remove();
    }
    function onEsc(e) {
      if (e.key === 'Escape') close();
    }

    const ownerInput = h('input', { class: 'aisapp-input', placeholder: 'Owner (e.g. hrishitkoli-ship-it)', autocomplete: 'off', required: 'required' });
    const repoInput = h('input', { class: 'aisapp-input', placeholder: 'Repo (e.g. the-aisapp-project)', autocomplete: 'off', required: 'required' });
    const branchInput = h('input', { class: 'aisapp-input', placeholder: 'Branch (default: main)', autocomplete: 'off' });
    const tokenInput = h('input', { class: 'aisapp-input', placeholder: 'Fine-grained PAT (repo contents: read & write)', type: 'password', autocomplete: 'off', required: 'required' });
    const errorEl = h('p', { class: 'aisapp-modal-warning', style: 'display:none' });
    const submitBtn = h('button', { class: 'aisapp-btn aisapp-btn--primary', type: 'submit' }, 'Connect');

    const form = h('form', { class: 'aisapp-create-form' }, [
      h('p', {}, "This project's files can be pushed to this repo as one commit, any time you choose. The token is encrypted before storage and never shown again after this."),
      ownerInput,
      repoInput,
      branchInput,
      tokenInput,
      errorEl,
      submitBtn,
    ]);

    let isSubmitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isSubmitting) return;
      errorEl.style.display = 'none';
      const owner = ownerInput.value.trim();
      const repo = repoInput.value.trim();
      const branch = branchInput.value.trim();
      const token = tokenInput.value.trim();
      if (!owner || !repo || !token) {
        errorEl.textContent = 'Owner, repo, and token are required.';
        errorEl.style.display = '';
        return;
      }
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connecting…';
      try {
        const { body } = await api(state.projectId, '/github/connect', {
          method: 'POST',
          body: JSON.stringify({ owner, repo, branch: branch || undefined, token }),
        });
        state.github = body;
        close();
        rerenderToolbarOnly();
        showStatus(state.mountEl, `Connected to ${body.owner}/${body.repo}.`, 'info');
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = '';
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Connect';
      }
    });

    const closeBtn = h('button', { class: 'aisapp-modal-close', 'aria-label': 'Close' });
    closeBtn.appendChild(window.AisappIcons.el('x-circle', { size: 20 }));
    closeBtn.addEventListener('click', close);

    const titleId = `aisapp-github-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aisapp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('div', { class: 'aisapp-modal-header' }, [
          h('h2', { id: titleId }, 'Connect a GitHub repo'),
          closeBtn,
        ]),
        form,
      ]
    );

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onEsc);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    ownerInput.focus();
  }

  async function pushToGithub() {
    if (!state.github || !state.github.connected) return;
    const { owner, repo, branch } = state.github;
    if (!window.confirm(`Push all files to ${owner}/${repo}${branch ? '@' + branch : ''}? This creates one new commit.`)) {
      return;
    }
    showStatus(state.mountEl, 'Pushing…', 'info');
    try {
      const { body } = await api(state.projectId, '/github/push', { method: 'POST' });
      showStatus(state.mountEl, `Pushed ${body.filesPushed} file${body.filesPushed === 1 ? '' : 's'} (${body.commitSha.slice(0, 7)}).`, 'info');
      await loadGithubStatus();
    } catch (err) {
      showStatus(state.mountEl, `Couldn't push: ${err.message}`, 'error');
    }
  }

  async function disconnectGithub() {
    if (!window.confirm('Disconnect this GitHub repo? You can reconnect later, but the token will need to be entered again.')) {
      return;
    }
    try {
      await api(state.projectId, '/github', { method: 'DELETE' });
      state.github = { connected: false };
      rerenderToolbarOnly();
      showStatus(state.mountEl, 'Disconnected.', 'info');
    } catch (err) {
      showStatus(state.mountEl, `Couldn't disconnect: ${err.message}`, 'error');
    }
  }

  function githubToolbarButton() {
    if (!state.github || !state.github.connected) {
      return h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: openGithubModal },
        [window.AisappIcons.el('git-branch', { size: 16 }), 'Connect GitHub']
      );
    }
    // Connected: primary action is Push; a small subtle button next to
    // it disconnects. Two buttons rather than a dropdown -- this app
    // has no menu/dropdown component yet, and inventing one for a
    // two-option choice would be over-building for what this needs.
    return h('span', { class: 'aisapp-icon-row', style: 'display:inline-flex;gap:6px' }, [
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: pushToGithub, title: `${state.github.owner}/${state.github.repo}` },
        [window.AisappIcons.el('git-branch', { size: 16 }), 'Push to GitHub']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle', onclick: disconnectGithub, title: 'Disconnect', 'aria-label': 'Disconnect GitHub' },
        [window.AisappIcons.el('trash', { size: 14 })]
      ),
    ]);
  }

  function downloadCurrentFile() {
    if (!state.selectedPath) return;
    const blob = new Blob([state.editorContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.selectedPath.split('/').pop() || 'file.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteCurrentFile() {
    if (!state.selectedPath) return;
    if (!window.confirm(`Delete "${state.selectedPath}"? This cannot be undone.`)) return;
    try {
      await api(state.projectId, `/files/content/${state.selectedPath}`, { method: 'DELETE' });
      showStatus(state.mountEl, 'File deleted.', 'info');
      state.selectedPath = null;
      state.editorContent = '';
      state.originalContent = '';
      await loadTree();
    } catch (err) {
      showStatus(state.mountEl, `Couldn't delete: ${err.message}`, 'error');
      renderShell();
    }
  }

  function startCreatingFile() {
    state.creatingFile = true;
    rerenderTreePanelOnly();
  }

  function cancelCreatingFile() {
    state.creatingFile = false;
    rerenderTreePanelOnly();
  }

  async function submitCreateFile(rawPath) {
    const cleanPath = rawPath.trim().replace(/^\/+/, '');
    if (!cleanPath) return;
    if (collectFilePaths(state.tree).includes(cleanPath)) {
      showStatus(state.mountEl, `"${cleanPath}" already exists.`, 'error');
      return;
    }
    try {
      await api(state.projectId, `/files/content/${cleanPath}`, {
        method: 'PUT',
        body: JSON.stringify({ content: '' }),
      });
      state.creatingFile = false;
      await loadTree();
      openFile(cleanPath);
    } catch (err) {
      showStatus(state.mountEl, `Couldn't create file: ${err.message}`, 'error');
    }
  }

  /** The inline row shown in the tree panel when "New file" is tapped.
   *  Deliberately not a modal -- a whole overlay/header/paragraph/
   *  submit-button apparatus was a lot of weight for "type a path,
   *  press Enter", especially on a small screen. Same visual language
   *  as the search input right above it in the panel. */
  function renderCreateFileRow() {
    const input = h('input', {
      class: 'aisapp-search-input aisapp-ws-create-input',
      type: 'text',
      placeholder: 'path/to/file.js',
      autocomplete: 'off',
    });
    const cancelBtn = h(
      'button',
      { class: 'aisapp-tree-row-rename', type: 'button', title: 'Cancel', 'aria-label': 'Cancel new file' },
      [window.AisappIcons.el('x-circle', { size: 15 })]
    );
    cancelBtn.addEventListener('click', cancelCreatingFile);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelCreatingFile();
      }
    });

    const form = h('form', { class: 'aisapp-ws-create-row' }, [input, cancelBtn]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitCreateFile(input.value);
    });

    // Focus after the element is actually in the DOM.
    setTimeout(() => input.focus(), 0);
    return form;
  }

  /** Rename = read old content, write it to the new path, delete the
   *  old path. Reuses the three existing content endpoints rather than
   *  needing a dedicated rename route on the backend. */
  async function renameSingleFile(oldPath, newPath) {
    const { body } = await api(state.projectId, `/files/content/${oldPath}`);
    await api(state.projectId, `/files/content/${newPath}`, {
      method: 'PUT',
      body: JSON.stringify({ content: body.content }),
    });
    await api(state.projectId, `/files/content/${oldPath}`, { method: 'DELETE' });
  }

  /** "Renaming a folder" has no direct backend equivalent -- folders
   *  aren't stored rows, just a shared path prefix derived from the
   *  files inside them (see fileOps.js's buildFileTree). So this
   *  renames every file currently under the old prefix to live under
   *  the new one instead, one renameSingleFile call at a time. Uses
   *  the already-loaded state.tree for the file list rather than
   *  re-fetching, to act on exactly what's on screen. */
  async function renameDirectory(oldPrefix, newPrefix) {
    const files = collectFilePaths(state.tree).filter(
      (p) => p === oldPrefix || p.startsWith(oldPrefix + '/')
    );
    for (const oldFilePath of files) {
      const newFilePath = newPrefix + oldFilePath.slice(oldPrefix.length);
      await renameSingleFile(oldFilePath, newFilePath);
    }
  }

  function openRenameModal(oldPath, type) {
    if (document.querySelector('.aisapp-modal-overlay')) return;

    const overlay = h('div', { class: 'aisapp-modal-overlay' });
    function close() {
      document.removeEventListener('keydown', onEsc);
      overlay.remove();
    }
    function onEsc(e) {
      if (e.key === 'Escape') close();
    }

    const pathInput = h('input', { class: 'aisapp-input', autocomplete: 'off', required: 'required' });
    pathInput.value = oldPath;
    const errorEl = h('p', { class: 'aisapp-modal-warning', style: 'display:none' });
    const submitBtn = h('button', { class: 'aisapp-btn aisapp-btn--primary', type: 'submit' }, 'Rename');

    const form = h('form', { class: 'aisapp-create-form' }, [
      h(
        'p',
        {},
        type === 'directory'
          ? 'Renames every file inside this folder to the new path.'
          : 'Enter the new path for this file.'
      ),
      pathInput,
      errorEl,
      submitBtn,
    ]);

    let isSubmitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isSubmitting) return;
      errorEl.style.display = 'none';
      const newPath = pathInput.value.trim().replace(/^\/+/, '');
      if (!newPath) {
        errorEl.textContent = 'A path is required.';
        errorEl.style.display = '';
        return;
      }
      if (newPath === oldPath) {
        close();
        return;
      }
      if (
        type === 'file' &&
        collectFilePaths(state.tree).includes(newPath) &&
        !window.confirm(`"${newPath}" already exists. Overwrite it?`)
      ) {
        return;
      }
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Renaming\u2026';
      try {
        if (type === 'directory') {
          await renameDirectory(oldPath, newPath);
        } else {
          await renameSingleFile(oldPath, newPath);
        }
        close();
        if (state.selectedPath === oldPath) {
          state.selectedPath = newPath;
        } else if (state.selectedPath && state.selectedPath.startsWith(oldPath + '/')) {
          state.selectedPath = newPath + state.selectedPath.slice(oldPath.length);
        }
        await loadTree();
        showStatus(state.mountEl, 'Renamed.', 'info');
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = '';
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Rename';
      }
    });

    const closeBtn = h('button', { class: 'aisapp-modal-close', 'aria-label': 'Close' });
    closeBtn.appendChild(window.AisappIcons.el('x-circle', { size: 20 }));
    closeBtn.addEventListener('click', close);

    const titleId = `aisapp-rename-title-${Math.random().toString(36).slice(2, 9)}`;
    const modal = h(
      'div',
      { class: 'aisapp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      [
        h('div', { class: 'aisapp-modal-header' }, [
          h('h2', { id: titleId }, type === 'directory' ? 'Rename folder' : 'Rename file'),
          closeBtn,
        ]),
        form,
      ]
    );

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onEsc);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    pathInput.focus();
    // Select just the filename portion (not the folder path) for
    // convenience -- matches how most file managers pre-select on rename.
    const lastSlash = oldPath.lastIndexOf('/');
    const nameStart = lastSlash === -1 ? 0 : lastSlash + 1;
    const lastDot = oldPath.lastIndexOf('.');
    const nameEnd = type === 'file' && lastDot > nameStart ? lastDot : oldPath.length;
    pathInput.setSelectionRange(nameStart, nameEnd);
  }

  // -------------------------------------------------------------
  // Top-level render
  // -------------------------------------------------------------

  function renderToolbar() {
    return h('div', { class: 'aisapp-ws-toolbar' }, [
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: startCreatingFile },
        [window.AisappIcons.el('plus', { size: 16 }), 'New file']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: loadTree },
        [window.AisappIcons.el('refresh', { size: 16 }), 'Refresh']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: downloadAllFilesAsZip },
        [window.AisappIcons.el('download', { size: 16 }), 'Download .zip']
      ),
      githubToolbarButton(),
    ]);
  }

  function renderShell() {
    const { mountEl } = state;
    clear(mountEl);

    const toolbar = renderToolbar();
    mountEl.appendChild(toolbar);

    if (state.selectedPath) {
      mountEl.appendChild(renderEditor());
    } else {
      mountEl.appendChild(renderTreePanel());
    }
  }

  // -------------------------------------------------------------
  // Skeleton loading states (item 5 of the human's fix/feature prompt
  // -- replace "Loading..." text with shimmer rows matching final
  // layout). Pure CSS animation (see workspace.css's
  // .aisapp-skeleton-* rules), no dependency, per the prompt's own
  // "lightweight... no heavy dependency needed" instruction.
  //
  // Row COUNT and WIDTHS are deliberately varied (5 rows, a handful of
  // different bar widths cycled through) rather than 5 identical bars
  // -- identical-width rows read as an obviously fake placeholder
  // grid; varied widths read as "approximating real file names of
  // different lengths," which is closer to what's about to actually
  // render and avoids an obvious flash when real content swaps in.
  // -------------------------------------------------------------

  function renderTreeSkeleton() {
    const container = h('div', { class: 'aisapp-tree-level' });
    const widths = ['70%', '45%', '85%', '55%', '60%'];
    for (let i = 0; i < widths.length; i++) {
      container.appendChild(
        h('div', { class: 'aisapp-skeleton-row' }, [
          h('div', { class: 'aisapp-skeleton-icon' }),
          h('div', { class: 'aisapp-skeleton-bar', style: `width:${widths[i]}` }),
        ])
      );
    }
    return container;
  }

  function renderEditorSkeleton() {
    const wrap = h('div', {});
    const widths = ['92%', '78%', '85%', '40%', '95%', '60%', '88%', '30%'];
    for (const w of widths) {
      wrap.appendChild(h('div', { class: 'aisapp-skeleton-editor-line', style: `width:${w}` }));
    }
    return wrap;
  }

  // -------------------------------------------------------------
  // Full-text file search (#10 backend endpoint, this is the UI)
  // -------------------------------------------------------------

  let searchDebounceTimer = null;

  function renderSearchBar() {
    const input = h('input', {
      class: 'aisapp-search-input aisapp-ws-search-input',
      type: 'search',
      placeholder: 'Search file contents\u2026',
      autocomplete: 'off',
      oninput: (e) => {
        state.searchQuery = e.target.value;
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(runSearch, 300);
      },
    });
    input.value = state.searchQuery;
    return h('div', { class: 'aisapp-ws-search-bar' }, [input]);
  }

  async function runSearch() {
    const q = state.searchQuery.trim();
    if (q.length < 2) {
      state.searchResults = null;
      state.searchLoading = false;
      rerenderTreePanelOnly();
      return;
    }
    state.searchLoading = true;
    rerenderTreePanelOnly();
    try {
      const { body } = await api(state.projectId, `/files/search?q=${encodeURIComponent(q)}`);
      state.searchResults = body.results;
    } catch (err) {
      state.searchResults = [];
      showStatus(state.mountEl, `Search failed: ${err.message}`, 'error');
    }
    state.searchLoading = false;
    rerenderTreePanelOnly();
  }

  function renderSearchResults() {
    if (state.searchLoading) {
      return h('p', { class: 'aisapp-empty-state' }, 'Searching\u2026');
    }
    if (!state.searchResults || state.searchResults.length === 0) {
      return h('p', { class: 'aisapp-empty-state' }, 'No files match.');
    }
    const container = h('div', { class: 'aisapp-tree-level' });
    for (const result of state.searchResults) {
      const name = result.path.split('/').pop();
      const body = [h('span', { class: 'aisapp-tree-name' }, result.path)];
      if (result.snippet) {
        body.push(h('span', { class: 'aisapp-ws-search-snippet' }, result.snippet));
      }
      container.appendChild(
        h(
          'button',
          {
            class: 'aisapp-tree-row-clickable aisapp-ws-search-result',
            onclick: () => {
              state.searchQuery = '';
              state.searchResults = null;
              openFile(result.path);
            },
          },
          [
            window.AisappIcons.fileIconEl(name, { className: 'aisapp-tree-icon', size: 15 }),
            h('div', { class: 'aisapp-ws-search-result-body' }, body),
          ]
        )
      );
    }
    return container;
  }

  function renderTreePanel() {
    const panel = h('div', { class: 'aisapp-panel aisapp-ws-tree-panel' });
    panel.appendChild(renderSearchBar());

    if (state.creatingFile) {
      panel.appendChild(renderCreateFileRow());
    }

    if (state.searchQuery.trim().length >= 2) {
      panel.appendChild(renderSearchResults());
      return panel;
    }

    if (state.loadingTree) {
      panel.appendChild(renderTreeSkeleton());
    } else if (state.tree.length === 0) {
      panel.appendChild(
        h('p', { class: 'aisapp-empty-state' }, 'No files yet. Create one above, or have an AI session push one.')
      );
    } else {
      const recent = renderRecentFiles();
      if (recent) panel.appendChild(recent);
      panel.appendChild(renderTreeNodes(state.tree, 0));
    }
    return panel;
  }

  function renderEditor() {
    const wrap = h('div', { class: 'aisapp-ws-editor' });

    // Dirty badge: shown when editorContent differs from savedContent.
    // Initially hidden (file was just loaded); oninput toggles it.
    const dirtyBadge = h('span', {
      class: 'aisapp-ws-dirty-badge',
      title: 'Unsaved changes',
      style: 'display:none',
    });

    const header = h('div', { class: 'aisapp-ws-editor-header' }, [
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: closeFile },
        [window.AisappIcons.el('chevron-left', { size: 16 }), 'Files']
      ),
      h('span', { class: 'aisapp-ws-editor-path aisapp-mono' }, state.selectedPath),
      dirtyBadge,
    ]);
    wrap.appendChild(header);

    if (state.loadingFile) {
      wrap.appendChild(renderEditorSkeleton());
      return wrap;
    }

    // ---- Prism syntax highlighting (#10) -------------------------
    // Strategy: show a Prism-highlighted <pre><code> block as the
    // default view. When the user clicks it (or the Edit button), swap
    // in the textarea. Prism is loaded via CDN in index.html (autoloader
    // plugin, so it fetches language grammars on demand). Falls back
    // gracefully to the plain textarea if Prism isn't available or the
    // extension isn't recognized.
    const ext = (state.selectedPath || '').split('.').pop().toLowerCase();
    const PRISM_LANG = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', jsonc: 'json',
      md: 'markdown', mdx: 'markdown',
      css: 'css', scss: 'scss',
      html: 'html', htm: 'html', xml: 'xml',
      py: 'python',
      sh: 'bash', bash: 'bash', zsh: 'bash',
      sql: 'sql',
      yaml: 'yaml', yml: 'yaml',
    };
    const prismLang = PRISM_LANG[ext];
    const hasPrism = typeof window.Prism !== 'undefined';

    const lineCount = Math.max(state.editorContent.split('\n').length, 1);
    const gutter = h('div', { class: 'aisapp-ws-gutter aisapp-mono' });
    for (let i = 1; i <= lineCount; i++) {
      gutter.appendChild(h('div', {}, String(i)));
    }

    let editorBody;
    let textarea = null; // set below only when the editable branch runs; read again further down (status bar) only if present

    if (state.editMode || !hasPrism || !prismLang) {
      // ---- Editable textarea branch ----
      textarea = h('textarea', {
        class: `aisapp-ws-textarea aisapp-mono${state.wrapEnabled ? ' is-wrap' : ''}`,
        spellcheck: 'false',
        autocapitalize: 'off',
        autocorrect: 'off',
        oninput: (e) => {
          state.editorContent = e.target.value;
          const newLineCount = Math.max(state.editorContent.split('\n').length, 1);
          if (newLineCount !== gutter.children.length) {
            clear(gutter);
            for (let i = 1; i <= newLineCount; i++) gutter.appendChild(h('div', {}, String(i)));
          }
          const dirty = hasUnsavedChanges();
          saveBtn.disabled = !dirty;
          dirtyBadge.style.display = dirty ? 'inline-block' : 'none';
          // Auto-save: commit to the server 3 s after typing stops.
          clearTimeout(state.autoSaveTimer);
          if (dirty) {
            state.autoSaveTimer = setTimeout(() => {
              if (hasUnsavedChanges()) saveFile({ force: false });
            }, 3000);
          }
        },
      });
      textarea.value = state.editorContent;

      // Keep the gutter's vertical scroll locked to the textarea's.
      textarea.addEventListener('scroll', () => {
        gutter.scrollTop = textarea.scrollTop;
      });

      // Tab → 2 spaces. Dispatches 'input' so oninput handles gutter /
      // saveBtn / dirtyBadge / auto-save without duplicating logic here.
      textarea.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const { selectionStart: s, selectionEnd: end } = e.target;
        e.target.value = e.target.value.slice(0, s) + '  ' + e.target.value.slice(end);
        e.target.selectionStart = e.target.selectionEnd = s + 2;
        e.target.dispatchEvent(new Event('input'));
      });

      // Word wrap toggle -- created after textarea so the click handler
      // can reference textarea directly without forward-ref machinery.
      // Edit-mode-only: a highlighted read view has no textarea to wrap.
      const wrapToggle = h(
        'button',
        {
          class: `aisapp-btn aisapp-btn--subtle${state.wrapEnabled ? ' is-active' : ''}`,
          title: 'Toggle word wrap (long lines)',
          onclick: () => {
            state.wrapEnabled = !state.wrapEnabled;
            textarea.classList.toggle('is-wrap', state.wrapEnabled);
            wrapToggle.classList.toggle('is-active', state.wrapEnabled);
            wrapToggle.textContent = state.wrapEnabled ? 'No wrap' : 'Wrap';
          },
        },
        state.wrapEnabled ? 'No wrap' : 'Wrap'
      );
      header.appendChild(wrapToggle);

      editorBody = h('div', { class: 'aisapp-ws-editor-body' }, [gutter, textarea]);
    } else {
      // ---- Prism highlighted read view branch (#10) ----
      const code = document.createElement('code');
      code.className = `language-${prismLang}`;
      code.textContent = state.editorContent;
      window.Prism.highlightElement(code);

      const pre = document.createElement('pre');
      pre.className = `aisapp-ws-highlighted language-${prismLang}`;
      pre.appendChild(code);
      pre.title = 'Click to edit';
      pre.addEventListener('click', () => {
        state.editMode = true;
        renderShell();
      });
      pre.addEventListener('scroll', () => { gutter.scrollTop = pre.scrollTop; });
      editorBody = h('div', { class: 'aisapp-ws-editor-body' }, [gutter, pre]);
    }
    wrap.appendChild(editorBody);

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

    // Ln / Col indicator -- only meaningful with an actual input control
    // (cursor position), so it only exists when the textarea branch
    // above ran. The Prism read view has no cursor to report.
    let statusBar = null;
    if (textarea) {
      statusBar = h('span', { class: 'aisapp-ws-status-bar' }, 'Ln 1, Col 1');
      const updateStatusBar = () => {
        const before = textarea.value.slice(0, textarea.selectionStart);
        const lines = before.split('\n');
        statusBar.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
      };
      textarea.addEventListener('click', updateStatusBar);
      textarea.addEventListener('keyup', updateStatusBar);
    }

    // Copy file path button -- independent of edit/view mode, always useful.
    const copyPathBtn = h('button', {
      class: 'aisapp-btn aisapp-icon-btn',
      title: 'Copy file path',
      onclick: () => {
        navigator.clipboard.writeText(state.selectedPath).then(() => {
          copyPathBtn.setAttribute('title', 'Copied!');
          setTimeout(() => copyPathBtn.setAttribute('title', 'Copy file path'), 1500);
        });
      },
    }, window.AisappIcons.el('clipboard', { size: 14 }));
    header.appendChild(copyPathBtn);

    const saveBtnLabel = h('span', {}, 'Save');
    const saveBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary',
        title: `Save file (${isMac ? '⌘S' : 'Ctrl+S'})`,
        onclick: async () => {
          saveBtn.disabled = true;
          saveBtnLabel.textContent = 'Saving\u2026';
          clearTimeout(state.autoSaveTimer);
          try {
            await saveFile({ force: false });
          } finally {
            saveBtnLabel.textContent = 'Save';
            saveBtn.disabled = !hasUnsavedChanges();
          }
        },
      },
      [saveBtnLabel, '\u00A0', h('kbd', { class: 'aisapp-kbd-hint' }, isMac ? '⌘S' : '⌃S')]
    );
    saveBtn.disabled = !hasUnsavedChanges();

    // Edit/View toggle -- only when a highlighted view actually exists
    // for this extension; otherwise there's nothing to toggle to/from.
    const canToggleView = hasPrism && !!prismLang;
    const editToggleBtn = canToggleView
      ? h(
          'button',
          {
            class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row',
            onclick: () => {
              state.editMode = !state.editMode;
              renderShell();
            },
          },
          [
            window.AisappIcons.el(state.editMode ? 'file' : 'edit', { size: 15 }),
            state.editMode ? 'View' : 'Edit',
          ]
        )
      : null;

    const actions = h('div', { class: 'aisapp-ws-editor-actions' }, [
      saveBtn,
      editToggleBtn,
      h(
        'button',
        {
          class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row',
          onclick: () => openRenameModal(state.selectedPath, 'file'),
        },
        [window.AisappIcons.el('edit', { size: 15 }), 'Rename']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-icon-row', onclick: downloadCurrentFile },
        [window.AisappIcons.el('download', { size: 16 }), 'Download']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--danger aisapp-icon-row', onclick: deleteCurrentFile },
        [window.AisappIcons.el('trash', { size: 16 }), 'Delete']
      ),
      statusBar,
    ].filter(Boolean));
    wrap.appendChild(actions);

    return wrap;
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  // Ctrl/Cmd+S: save the open file from anywhere in the workspace.
  // Self-cleaning: removes the listener once mountEl leaves the DOM,
  // so no router lifecycle hook is needed.
  function onGlobalSave(e) {
    if (!state || !state.mountEl || !state.mountEl.isConnected) {
      document.removeEventListener('keydown', onGlobalSave);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.selectedPath && !state.loadingFile) {
      e.preventDefault();
      saveFile({ force: false });
      return;
    }
    // Escape: go back to the file tree when the file is clean.
    // If there are unsaved changes we leave Escape alone -- the user
    // must save or explicitly discard before navigating away.
    if (e.key === 'Escape' && state.selectedPath && !hasUnsavedChanges() && !state.loadingFile) {
      closeFile();
    }
  }

  window.AisappWorkspace = {
    mount(mountEl, projectId) {
      state = freshState(projectId, mountEl);
      document.addEventListener('keydown', onGlobalSave);
      renderShell();
      loadTree();
      loadGithubStatus();
    },
  };
})();
