/**
 * icons.js
 * ------------------------------------------------------------------
 * Shared icon set, replacing emoji glyphs used across activity.js,
 * workspace.js, projects.js, and router.js -- a cross-cutting concern
 * spanning three sessions' files, so it lives in one place rather
 * than being patched differently in each.
 *
 * Hand-drawn stroke-based SVGs (24x24 viewBox, stroke="currentColor",
 * no fill) -- not a copy of any specific named icon library's path
 * data, custom-built for this app. currentColor means every icon
 * automatically inherits whatever text color applies (including
 * across the dark/light theme toggle) with zero icon-specific theme
 * variants needed.
 *
 * Usage: window.AisappIcons.svg('folder', { size: 16, className: 'foo' })
 * returns an SVG markup string, ready to drop into innerHTML or parse
 * into a DOM node.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  // Each entry is just the inner markup (paths/lines/etc) -- the
  // shared wrapper below supplies the common <svg> attributes so
  // every icon is guaranteed visually consistent (same stroke width,
  // same viewBox, same line style) rather than drifting per-icon.
  const PATHS = {
    folder:
      '<path d="M3 6a1 1 0 0 1 1-1h4.5l1.5 2H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"/>',
    file:
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>',
    'chevron-left': '<path d="M14.5 4.5 8 12l6.5 7.5"/>',
    download:
      '<path d="M12 3v12"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/>',
    trash:
      '<path d="M4 6h16"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/><path d="M10 10.5v6"/><path d="M14 10.5v6"/>',
    refresh:
      '<path d="M4 12a8 8 0 0 1 14-5.3L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-14 5.3L4 16"/><path d="M4 20v-4h4"/>',
    sun:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>',
    moon:
      '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    users:
      '<circle cx="9" cy="8" r="3.25"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M15.8 5.2a3.25 3.25 0 0 1 0 6.1"/><path d="M14.8 14.3A5.5 5.5 0 0 1 20.5 20"/>',
    clipboard:
      '<path d="M8 4h8a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1V5a1 1 0 0 1 1-1z"/><path d="M9 4.5V6h6V4.5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5z"/><path d="M9 12h6M9 16h6"/>',
    'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.3 2.3 4.7-5"/>',
    'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
    inbox:
      '<path d="M4 12h4l1.5 2.5h5L16 12h4"/><path d="M4 12 5.5 5A1 1 0 0 1 6.5 4h11a1 1 0 0 1 1 1L20 12v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
    edit: '<path d="M4 20h4l10.5-10.5a2 2 0 0 0-4-4L4 16z"/><path d="M13 6.5l4 4"/>',
    key:
      '<circle cx="7.5" cy="14.5" r="3.5"/><path d="M10 12l8-8"/><path d="M15.5 6.5 18 9M18.5 4l2 2"/>',
    warning:
      '<path d="M12 4 3 19h18z"/><path d="M12 10.5v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
    'device-download':
      '<rect x="5" y="2.5" width="14" height="19" rx="1.5"/><path d="M9 18.5h6"/><path d="M12 7v6.5M9.2 10.7 12 13.5l2.8-2.8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings:
      '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="7" cy="17" r="2"/>',
    'git-branch':
      '<circle cx="6" cy="5" r="2.25"/><circle cx="6" cy="19" r="2.25"/><circle cx="18" cy="8.5" r="2.25"/><path d="M6 7.25V16.75"/><path d="M6 12c0-2.5 2-3.5 5-3.5h3.7"/><path d="M12.5 6l3 2.5-3 2.5"/>',

    // ---- Per-extension file type icons (#9) ----------------------
    // Each variant is the generic file shape + a small type label/glyph
    // so the tree reads like a real IDE at a glance.
    'file-js':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="8" y="19" font-size="6" font-family="monospace" fill="currentColor" stroke="none">JS</text>',
    'file-ts':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="8" y="19" font-size="6" font-family="monospace" fill="currentColor" stroke="none">TS</text>',
    'file-json':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="6.5" y="19" font-size="5" font-family="monospace" fill="currentColor" stroke="none">{}</text>',
    'file-md':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="7.5" y="19" font-size="6" font-family="monospace" fill="currentColor" stroke="none">MD</text>',
    'file-txt':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h4" stroke-width="1.5"/>',
    'file-css':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="6" y="19" font-size="5.5" font-family="monospace" fill="currentColor" stroke="none">CSS</text>',
    'file-html':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M8.5 14l-1.5 1.5 1.5 1.5M15.5 14l1.5 1.5-1.5 1.5M11.5 13.5l1 4" stroke-width="1.3"/>',
    'file-py':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><text x="7.5" y="19" font-size="6" font-family="monospace" fill="currentColor" stroke="none">PY</text>',
    'file-sh':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M9 14l2 1.5-2 1.5" stroke-width="1.3"/><path d="M13 17h3" stroke-width="1.3"/>',
    'file-img':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><rect x="8" y="12" width="8" height="6" rx="1" stroke-width="1.3"/><circle cx="10.5" cy="14" r="1" fill="currentColor" stroke="none"/><path d="M8 18l3-3 2 2 2-2" stroke-width="1.3"/>',
    'file-zip':
      '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M11 8v2M13 10v2M11 12v2M13 14v2" stroke-width="1.5"/>',
  };

  // ---- Extension → icon name map (#9) --------------------------
  const EXT_ICONS = {
    js: 'file-js',   mjs: 'file-js',  cjs: 'file-js',
    ts: 'file-ts',   tsx: 'file-ts',
    json: 'file-json', jsonc: 'file-json',
    md: 'file-md',   mdx: 'file-md',
    txt: 'file-txt', log: 'file-txt', csv: 'file-txt',
    css: 'file-css', scss: 'file-css',
    html: 'file-html', htm: 'file-html', xml: 'file-html',
    py: 'file-py',
    sh: 'file-sh',   bash: 'file-sh', zsh: 'file-sh',
    png: 'file-img', jpg: 'file-img', jpeg: 'file-img',
    gif: 'file-img', webp: 'file-img', ico: 'file-img',
    zip: 'file-zip', gz: 'file-zip',  tar: 'file-zip',
  };

  function svg(name, opts = {}) {
    const inner = PATHS[name];
    if (!inner) {
      console.warn(`[icons] Unknown icon "${name}"`);
      return '';
    }
    const size = opts.size || 20;
    const strokeWidth = opts.strokeWidth || 1.8;
    const cls = opts.className ? ` class="${opts.className}"` : '';
    return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
  }

  /** Convenience: build an actual DOM element rather than a markup string. */
  function el(name, opts = {}) {
    const wrapper = document.createElement('span');
    wrapper.className = `aisapp-icon${opts.className ? ` ${opts.className}` : ''}`;
    wrapper.innerHTML = svg(name, opts);
    return wrapper;
  }

  /** Returns the icon name for a given filename (by extension). */
  function fileIconName(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    return EXT_ICONS[ext] || 'file';
  }

  /** Convenience: get icon element for a file path. */
  function fileIconEl(filename, opts = {}) {
    return el(fileIconName(filename), opts);
  }

  window.AisappIcons = { svg, el, names: Object.keys(PATHS), fileIconName, fileIconEl };
})();

