/**
 * pages/settings.js
 * ------------------------------------------------------------------
 * Device-level Settings page: NOT project-scoped, unlike roster.js/
 * instructions.js (init(mountEl, projectId)) -- this follows
 * ProjectManager's init(mountEl) pattern instead, since a device's
 * identity, ToS acceptance, and migration links apply across every
 * project on it, not to one.
 *
 * Three sections, top to bottom:
 *   1. Device identity -- the permanent code, delete-device action
 *   2. Send/receive a secret between devices -- the encrypted-link
 *      migration flow (see migration.js for the actual crypto)
 *   3. Terms & Privacy Policy, with the accept gate -- per the
 *      project owner's explicit instruction, this sits at the
 *      BOTTOM of the page, and file creation is blocked
 *      (server-side, see routes/files.js's handleWriteFile) until
 *      this is accepted. This page's job is just to explain that
 *      clearly and provide the accept action -- the actual
 *      enforcement lives server-side, not here, so it can't be
 *      bypassed by skipping this page.
 *
 * Route: #/settings (added in router.js alongside the existing #/
 * and #/project/:id/... routes -- see that file's small, additive
 * change for this).
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  const DEVICE_API = '/api/device';

  // Read the device write-secret that projects.js stores on first use.
  // settings.js and projects.js run as separate IIFE modules with no
  // shared scope, so we read directly from localStorage here rather
  // than importing -- same trust boundary (same device, same origin),
  // and this is what projects.js itself stores and reads under this key.
  function getDeviceSecret() {
    try {
      return (
        localStorage.getItem('aisapp:deviceSecret') ||
        localStorage.getItem('aihub:deviceSecret') ||
        null
      );
    } catch {
      return null;
    }
  }

  async function api(base, path, options = {}) {
    const secret = getDeviceSecret();
    const headers = {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Device-Secret': secret } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(`${base}${path}`, { ...options, headers });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Some responses may not be JSON; treat as empty.
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

  // -------------------------------------------------------------
  // Small DOM helpers -- see roster.js/instructions.js header
  // comments for why this is duplicated per-module rather than
  // imported: no build step, no shared module system in this app.
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

  function formatDate(iso) {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  // -------------------------------------------------------------
  // Section 1: Device identity
  // -------------------------------------------------------------

  function renderDeviceSection(mountEl, device, onDeviceDeleted) {
    const section = h('div', { class: 'aisapp-instructions-block' }, [
      h('h2', { class: 'aisapp-section-title' }, 'This device'),
    ]);

    if (!device || !device.code) {
      section.appendChild(
        h(
          'p',
          { class: 'aisapp-page-subtitle' },
          'No device identity yet -- one is created automatically the first time you make a project.'
        )
      );
      return section;
    }

    const copyCodeBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--subtle aisapp-btn--sm',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(device.code);
            copyCodeBtn.textContent = 'Copied!';
            setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 2000);
          } catch {
            copyCodeBtn.textContent = 'Select above';
            setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 2000);
          }
        },
      },
      'Copy'
    );
    section.appendChild(
      h('div', { class: 'aisapp-settings-device-code' }, [
        h('span', { class: 'aisapp-settings-device-code-label' }, 'Permanent device code'),
        h('code', { class: 'aisapp-settings-device-code-value' }, device.code),
        copyCodeBtn,
      ])
    );
    if (device.createdAt) {
      section.appendChild(
        h('p', { class: 'aisapp-block-subtitle' }, `Created ${formatDate(device.createdAt)}`)
      );
    }

    // Device secret: re-viewable, not just shown once (gap found while
    // extending the connection-link feature -- that feature makes it
    // easy to open a project on a brand-new browser, but write actions
    // there (delete project, regenerate token, delete device) need
    // this secret, which until now only ever appeared in a one-time
    // modal on first write attempt. If that modal was missed, or the
    // human wants to deliberately set up a second device later, there
    // was no way back to it short of opening devtools and reading
    // localStorage directly. This doesn't create any new exposure --
    // the value's already sitting in this browser's localStorage,
    // readable by this page's own JS (and anyone with devtools access
    // to this browser) whether or not this button exists; it just adds
    // a proper UI affordance for what was already accessible. Masked
    // by default (unlike the device code above, which is a public-ish
    // identifier, not a credential) since this section can stay open
    // on-screen far longer than the one-time reveal modal ever did.
    const storedSecret = getDeviceSecret();
    if (storedSecret) {
      let revealed = false;
      const secretValueEl = h('code', { class: 'aisapp-settings-device-code-value' }, '••••••••••••••••');
      const revealBtn = h(
        'button',
        {
          class: 'aisapp-btn aisapp-btn--subtle aisapp-btn--sm',
          onclick: () => {
            revealed = !revealed;
            secretValueEl.textContent = revealed ? storedSecret : '••••••••••••••••';
            revealBtn.textContent = revealed ? 'Hide' : 'Show';
          },
        },
        'Show'
      );
      const copySecretBtn = h(
        'button',
        {
          class: 'aisapp-btn aisapp-btn--subtle aisapp-btn--sm',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(storedSecret);
              copySecretBtn.textContent = 'Copied!';
              setTimeout(() => { copySecretBtn.textContent = 'Copy'; }, 2000);
            } catch {
              copySecretBtn.textContent = 'Reveal above to select';
              setTimeout(() => { copySecretBtn.textContent = 'Copy'; }, 2000);
            }
          },
        },
        'Copy'
      );
      section.appendChild(
        h('div', { class: 'aisapp-settings-device-code' }, [
          h('span', { class: 'aisapp-settings-device-code-label' }, 'Device secret (this browser)'),
          secretValueEl,
          revealBtn,
          copySecretBtn,
        ])
      );
      section.appendChild(
        h(
          'p',
          { class: 'aisapp-block-subtitle' },
          'Needed on any device or browser where you want to delete a project, regenerate a token, or delete this device. Paste it into "Send to another device" below to move it somewhere else.'
        )
      );
    }

    const deleteBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--danger aisapp-btn--sm',
        onclick: async () => {
          const firstConfirm = confirm(
            'Delete this device\u2019s identity? This deletes every project created on it and cannot be undone.'
          );
          if (!firstConfirm) return;

          deleteBtn.disabled = true;
          deleteBtn.textContent = 'Deleting\u2026';
          try {
            const result = await api(DEVICE_API, '/', {
              method: 'DELETE',
              body: JSON.stringify({ confirm: true }),
            });
            showStatus(
              mountEl,
              `Deleted ${result.deletedProjectCount} project(s). This device will get a new identity next time you create a project.`,
              'info'
            );
            onDeviceDeleted();
          } catch (err) {
            showStatus(mountEl, `Couldn't delete device: ${err.message}`, 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete this device';
          }
        },
      },
      'Delete this device'
    );
    section.appendChild(
      h('div', { class: 'aisapp-settings-danger-zone' }, [
        h('p', { class: 'aisapp-block-subtitle' }, 'Irreversible. Deletes every project on this device.'),
        deleteBtn,
      ])
    );

    return section;
  }

  // -------------------------------------------------------------
  // Section 2: Migration -- send a secret to another device
  // -------------------------------------------------------------

  function renderMigrationSection(mountEl) {
    const textarea = h('textarea', {
      class: 'aisapp-input aisapp-textarea',
      placeholder: 'Paste a project token (or any short secret) you want to move to another device\u2026',
      rows: '3',
    });

    const linkOutput = h('div', { class: 'aisapp-settings-migration-link', style: 'display:none' });

    const generateBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary',
        onclick: async () => {
          const plaintext = textarea.value.trim();
          if (!plaintext) {
            textarea.focus();
            return;
          }
          generateBtn.disabled = true;
          generateBtn.textContent = 'Encrypting\u2026';
          try {
            const { link, expiresAt } = await window.AisappMigration.createLink(plaintext);
            clear(linkOutput);
            linkOutput.style.display = '';
            const linkInput = h('input', {
              class: 'aisapp-input',
              type: 'text',
              readonly: 'true',
              value: link,
              onclick: (e) => e.target.select(),
            });
            linkOutput.appendChild(linkInput);
            linkOutput.appendChild(
              h(
                'button',
                {
                  class: 'aisapp-btn aisapp-btn--subtle aisapp-btn--sm',
                  onclick: async () => {
                    await navigator.clipboard.writeText(link);
                    showStatus(mountEl, 'Link copied.', 'info');
                  },
                },
                'Copy'
              )
            );
            linkOutput.appendChild(
              h(
                'p',
                { class: 'aisapp-block-subtitle' },
                `Expires ${formatDate(expiresAt)}. Works once -- opening it on the other device consumes it.`
              )
            );
            textarea.value = '';
          } catch (err) {
            showStatus(mountEl, `Couldn't create link: ${err.message}`, 'error');
          } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate link';
          }
        },
      },
      'Generate link'
    );

    return h('div', { class: 'aisapp-instructions-block' }, [
      h('h2', { class: 'aisapp-section-title' }, 'Send to another device'),
      h(
        'p',
        { class: 'aisapp-block-subtitle' },
        'Encrypted before it ever leaves this device. The server only ever ' +
          'stores ciphertext it can\u2019t read -- the decryption key travels ' +
          'in the link itself, never in a request to the server.'
      ),
      textarea,
      generateBtn,
      linkOutput,
    ]);
  }

  // -------------------------------------------------------------
  // Section 3: Terms & Privacy Policy + accept gate
  // -------------------------------------------------------------

  const TOS_TEXT = `This is a personal, local-first tool. There's no company behind it, no ads, no data sale, no tracking beyond what's needed to run it.

What's stored, and where: your project content (files, session coordination, notes, activity history) lives in a database this deployment controls, not on any third party's servers beyond that. It is NOT end-to-end encrypted by default -- anyone with access to the underlying database can read it, the same way anyone with access to a personal server's disk could before. If you use the "send to another device" feature on this page, that specific payload IS encrypted before it leaves your browser, and the server only ever sees ciphertext it can't decrypt.

Your device gets a permanent, random identifier the first time you create a project. It's not tied to your name, email, or phone number -- none of those are collected. Deleting your device identity deletes every project created under it, permanently.

AI agent tokens: each project's token is shown to you exactly once, at creation or regeneration. It is never stored anywhere in a form that could be reversed back into the original -- only a one-way hash, for verification. If you lose a token, you must regenerate it; there's no "reveal" option, by design.

You're responsible for what you and any AI agents you authorize do with a project's data using its token -- treat a token like a password.

This tool is provided as-is, with no warranty of any kind. Given its scope (a personal project management tool, not a service handling payments, health data, or anything regulated), that's the extent of what needs saying here.`;

  function renderTosSection(mountEl, device, onAccepted) {
    const alreadyAccepted = !!(device && device.tosAcceptedAt);

    const section = h('div', { class: 'aisapp-instructions-block' }, [
      h('h2', { class: 'aisapp-section-title' }, 'Terms & Privacy Policy'),
    ]);

    const textBlock = h('div', { class: 'aisapp-settings-tos-text' });
    TOS_TEXT.split('\n\n').forEach((para) => {
      textBlock.appendChild(h('p', {}, para));
    });
    section.appendChild(textBlock);

    if (alreadyAccepted) {
      section.appendChild(
        h(
          'p',
          { class: 'aisapp-settings-tos-status aisapp-settings-tos-status--accepted' },
          `\u2713 Accepted ${formatDate(device.tosAcceptedAt)}`
        )
      );
      return section;
    }

    const acceptBtn = h(
      'button',
      {
        class: 'aisapp-btn aisapp-btn--primary',
        onclick: async () => {
          acceptBtn.disabled = true;
          acceptBtn.textContent = 'Accepting\u2026';
          try {
            await api(DEVICE_API, '/accept-tos', { method: 'POST' });
            showStatus(mountEl, 'Accepted. You can now create files.', 'info');
            onAccepted();
          } catch (err) {
            showStatus(mountEl, `Couldn't record acceptance: ${err.message}`, 'error');
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'I have read and accept';
          }
        },
      },
      'I have read and accept'
    );

    section.appendChild(
      h('div', { class: 'aisapp-settings-tos-status aisapp-settings-tos-status--pending' }, [
        h('p', {}, 'Required before creating your first file on this device.'),
        acceptBtn,
      ])
    );

    return section;
  }

  // -------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------

  const SettingsPage = {
    async init(mountEl) {
      clear(mountEl);
      mountEl.appendChild(h('h1', { class: 'aisapp-page-title' }, 'Settings'));

      let device;
      try {
        device = await api(DEVICE_API, '/');
      } catch (err) {
        mountEl.appendChild(
          h('div', { class: 'aisapp-error-state' }, [
            h('p', {}, `Couldn't load device info: ${err.message}`),
          ])
        );
        return { destroy() {} };
      }

      async function rerender() {
        const fresh = await api(DEVICE_API, '/');
        device = fresh;
        rebuildSections();
      }

      let deviceSectionEl, migrationSectionEl, tosSectionEl;

      function rebuildSections() {
        if (deviceSectionEl) deviceSectionEl.remove();
        if (migrationSectionEl) migrationSectionEl.remove();
        if (tosSectionEl) tosSectionEl.remove();

        deviceSectionEl = renderDeviceSection(mountEl, device, rerender);
        migrationSectionEl = renderMigrationSection(mountEl);
        tosSectionEl = renderTosSection(mountEl, device, rerender);

        mountEl.appendChild(deviceSectionEl);
        mountEl.appendChild(migrationSectionEl);
        mountEl.appendChild(tosSectionEl);
      }

      rebuildSections();

      return { destroy() {} };
    },
  };

  window.SettingsPage = SettingsPage;
})();
