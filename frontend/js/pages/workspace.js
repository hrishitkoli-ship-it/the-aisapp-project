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
    };
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
          'button',
          {
            class: 'aisapp-tree-row aisapp-tree-row--dir',
            style: `padding-left:${depth * 16 + 10}px`,
            onclick: () => toggleDir(node.path),
          },
          [
            h('span', { class: 'aisapp-tree-caret' }, isOpen ? '▾' : '▸'),
            window.AisappIcons.el('folder', { className: 'aisapp-tree-icon', size: 15 }),
            h('span', { class: 'aisapp-tree-name' }, node.name),
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
            class: `aisapp-tree-row aisapp-tree-row--file${isSelected ? ' is-selected' : ''}`,
            style: `padding-left:${depth * 16 + 10}px`,
            onclick: () => openFile(node.path),
          },
          [
            window.AisappIcons.el('file', { className: 'aisapp-tree-icon', size: 15 }),
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
      // The read endpoint doesn't return a version number directly --
      // conflict tracking is keyed off the version returned by the
      // *previous write* to this path. A file that's never been
      // written through this app yet has no tracked version; we pass
      // no expectedVersion on the first save in that case, which the
      // backend treats as "no conflict check requested." Once we've
      // saved once, we track the version it hands back from then on.
      state.expectedVersion = null;
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

  async function createNewFile() {
    const path = window.prompt('New file path (e.g. scripts/new_item.js):');
    if (!path || !path.trim()) return;
    const cleanPath = path.trim().replace(/^\/+/, '');
    try {
      await api(state.projectId, `/files/content/${cleanPath}`, {
        method: 'PUT',
        body: JSON.stringify({ content: '' }),
      });
      await loadTree();
      openFile(cleanPath);
    } catch (err) {
      showStatus(state.mountEl, `Couldn't create file: ${err.message}`, 'error');
    }
  }

  // -------------------------------------------------------------
  // Top-level render
  // -------------------------------------------------------------

  function renderShell() {
    const { mountEl } = state;
    clear(mountEl);

    const toolbar = h('div', { class: 'aisapp-ws-toolbar' }, [
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: createNewFile },
        [window.AisappIcons.el('plus', { size: 16 }), 'New file']
      ),
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: loadTree },
        [window.AisappIcons.el('refresh', { size: 16 }), 'Refresh']
      ),
    ]);
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

  function renderTreePanel() {
    const panel = h('div', { class: 'aisapp-panel aisapp-ws-tree-panel' });
    if (state.loadingTree) {
      panel.appendChild(renderTreeSkeleton());
    } else if (state.tree.length === 0) {
      panel.appendChild(
        h('p', { class: 'aisapp-empty-state' }, 'No files yet. Create one above, or have an AI session push one.')
      );
    } else {
      panel.appendChild(renderTreeNodes(state.tree, 0));
    }
    return panel;
  }

  function renderEditor() {
    const wrap = h('div', { class: 'aisapp-ws-editor' });

    const header = h('div', { class: 'aisapp-ws-editor-header' }, [
      h(
        'button',
        { class: 'aisapp-btn aisapp-btn--subtle aisapp-icon-row', onclick: closeFile },
        [window.AisappIcons.el('chevron-left', { size: 16 }), 'Files']
      ),
      h('span', { class: 'aisapp-ws-editor-path aisapp-mono' }, state.selectedPath),
    ]);
    wrap.appendChild(header);

    if (state.loadingFile) {
      wrap.appendChild(renderEditorSkeleton());
      return wrap;
    }

    const lineCount = Math.max(state.editorContent.split('\n').length, 1);
    const gutter = h('div', { class: 'aisapp-ws-gutter aisapp-mono' });
    for (let i = 1; i <= lineCount; i++) {
      gutter.appendChild(h('div', {}, String(i)));
    }

    const textarea = h('textarea', {
      class: 'aisapp-ws-textarea aisapp-mono',
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
        saveBtn.disabled = !hasUnsavedChanges();
      },
    });
    textarea.value = state.editorContent;

    // Keep the gutter's vertical scroll locked to the textarea's.
    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop;
    });

    const editorBody = h('div', { class: 'aisapp-ws-editor-body' }, [gutter, textarea]);
    wrap.appendChild(editorBody);

    const saveBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary',
        onclick: async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          try {
            await saveFile({ force: false });
          } finally {
            saveBtn.textContent = 'Save';
            saveBtn.disabled = !hasUnsavedChanges();
          }
        },
      },
      'Save'
    );
    saveBtn.disabled = !hasUnsavedChanges();

    const actions = h('div', { class: 'aisapp-ws-editor-actions' }, [
      saveBtn,
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
    ]);
    wrap.appendChild(actions);

    return wrap;
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  window.AisappWorkspace = {
    mount(mountEl, projectId) {
      state = freshState(projectId, mountEl);
      renderShell();
      loadTree();
    },
  };
})();
