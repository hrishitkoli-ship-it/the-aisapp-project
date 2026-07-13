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
 * Usage: window.AihubIcons.svg('folder', { size: 16, className: 'foo' })
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
    wrapper.className = `aihub-icon${opts.className ? ` ${opts.className}` : ''}`;
    wrapper.innerHTML = svg(name, opts);
    return wrapper;
  }

  window.AihubIcons = { svg, el, names: Object.keys(PATHS) };
})();
