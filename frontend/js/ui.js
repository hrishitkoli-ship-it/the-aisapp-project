/**
 * ui.js
 * ------------------------------------------------------------------
 * Session 1 lane. Shared button factory (#8 of the feature sprint --
 * "Build one shared button factory ... instead of ad hoc styles per
 * file"). Every page module already renders `.aisapp-btn` elements by
 * hand with its own local h() helper; this doesn't replace those (six
 * files, five of them other sessions' -- rewriting all of them is a
 * bigger, riskier change than #8 actually asks for). What this adds
 * is one canonical way to BUILD a button with the variant/icon/label
 * combination already used everywhere, so new call sites (this
 * session's own, and any future one) stop hand-assembling the same
 * three lines of class-string + icon-element + text node.
 *
 * The hover/press/transition feel itself lives in projects.css's
 * .aisapp-btn rules (already shared, loaded on every page) -- that
 * part of #8 applies automatically regardless of whether a given
 * button was built via this factory or a page's own h(). This module
 * is the construction convenience on top, not a new visual system.
 *
 * Usage:
 *   window.AisappUI.button('Save', { variant: 'primary' })
 *   window.AisappUI.button('Delete', { variant: 'danger', icon: 'trash' })
 *   window.AisappUI.button('Refresh', { icon: 'refresh', onClick: fn })
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const VARIANT_CLASS = {
    primary: 'aisapp-btn--primary',
    danger: 'aisapp-btn--danger',
    subtle: 'aisapp-btn--subtle',
  };

  /**
   * @param {string} label - button text (pass '' for icon-only)
   * @param {object} opts
   * @param {'primary'|'danger'|'subtle'|undefined} opts.variant
   * @param {string|undefined} opts.icon - icon name from AisappIcons
   * @param {number} opts.iconSize - defaults to 16
   * @param {function|undefined} opts.onClick
   * @param {boolean|undefined} opts.disabled
   * @param {string|undefined} opts.title - tooltip / aria-label fallback
   * @param {string|undefined} opts.ariaLabel
   * @returns {HTMLButtonElement}
   */
  function button(label, opts = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';

    const classes = ['aisapp-btn'];
    if (opts.icon && label) classes.push('aisapp-icon-row');
    if (opts.variant && VARIANT_CLASS[opts.variant]) classes.push(VARIANT_CLASS[opts.variant]);
    if (opts.className) classes.push(opts.className);
    btn.className = classes.join(' ');

    if (opts.icon && window.AisappIcons) {
      btn.appendChild(window.AisappIcons.el(opts.icon, { size: opts.iconSize || 16 }));
    }
    if (label) {
      btn.appendChild(document.createTextNode(label));
    }
    if (opts.title) btn.title = opts.title;
    if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
    if (opts.disabled) btn.disabled = true;
    if (typeof opts.onClick === 'function') {
      btn.addEventListener('click', opts.onClick);
    }
    return btn;
  }

  window.AisappUI = { button };
})();
