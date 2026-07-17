/**
 * theme.js
 * ------------------------------------------------------------------
 * Session 1 lane. Applies/persists the dark-light theme choice.
 *
 * Precedence: explicit user choice (localStorage) > system preference
 * (prefers-color-scheme) > dark (this app's existing default, per
 * Session 3's design). Exposes window.AisappTheme for the header
 * toggle button in router.js to call.
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'aisapp:theme';
  const STORAGE_KEY_OLD = 'aihub:theme'; // pre-rename key, see below

  function systemPrefersLight() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function getStoredTheme() {
    try {
      const current = localStorage.getItem(STORAGE_KEY); // 'light' | 'dark' | null
      if (current !== null) return current;
      // One-time migration for the "aihub" -> "aisapp" naming rename,
      // same reasoning as projects.js's currentProjectId/deviceSecret:
      // don't silently drop an existing preference just because the
      // key it's stored under changed.
      const legacy = localStorage.getItem(STORAGE_KEY_OLD);
      if (legacy !== null) {
        localStorage.setItem(STORAGE_KEY, legacy);
        localStorage.removeItem(STORAGE_KEY_OLD);
      }
      return legacy;
    } catch {
      return null; // localStorage can throw in some locked-down contexts
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Non-fatal: theme just won't persist across reloads in this context.
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function apply(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme'); // dark is the unattributed default
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'light' ? '#f6f7f9' : '#0d0d0f');
    }
    document.dispatchEvent(new CustomEvent('aisapp:themechanged', { detail: { theme } }));
  }

  function init() {
    const stored = getStoredTheme();
    const initial = stored || (systemPrefersLight() ? 'light' : 'dark');
    apply(initial);
  }

  function toggle() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    setStoredTheme(next);
    apply(next);
    return next;
  }

  init();

  window.AisappTheme = { toggle, current: currentTheme };
})();
