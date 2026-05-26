/* Capability consent dialog — shown before adopting a patch that requests
 * scripted behaviors. In Stage A there's no actual sandbox; the dialog
 * just makes the consent surface real so users can validate the UX. */

import { CAPABILITIES } from '../services/upgrades-mock.js';

const DIALOG_ID = 'dexhero-cap-consent';

/* Returns a Promise that resolves true (allowed) or false (cancelled). */
export function requestCapabilityConsent(patch) {
    return new Promise((resolve) => {
        const caps = collectRequestedCapabilities(patch);
        if (!caps.length) { resolve(true); return; }    // no behaviors → no dialog needed
        const dlg = buildDialog(patch, caps, resolve);
        document.body.appendChild(dlg);
        requestAnimationFrame(() => dlg.classList.add('is-visible'));
    });
}

function collectRequestedCapabilities(patch) {
    const set = new Set();
    for (const b of patch.behaviors || []) {
        for (const c of b.capabilities_requested || []) set.add(c);
    }
    return [...set];
}

function buildDialog(patch, caps, resolve) {
    const dlg = document.createElement('div');
    dlg.id = DIALOG_ID;
    dlg.className = 'cap-consent';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', `Capabilities requested by ${patch.title}`);

    dlg.innerHTML = `
        <div class="cap-consent__veil" data-action="cancel"></div>
        <div class="cap-consent__card">
            <header class="cap-consent__head">
                <div class="cap-consent__icon">⚐</div>
                <div>
                    <div class="cap-consent__author">${escape(patch.author_username || 'unknown')}</div>
                    <div class="cap-consent__title">${escape(patch.title || 'Untitled')}</div>
                </div>
            </header>
            <p class="cap-consent__intro">
                This patch wants to use the following abilities on your dexhero lobby:
            </p>
            <ul class="cap-consent__caps">
                ${caps.map((c) => {
                    const meta = CAPABILITIES[c] || { label: c, blurb: 'Unknown capability.' };
                    return `<li>
                        <span class="cap-consent__cap-label">${escape(meta.label)}</span>
                        <span class="cap-consent__cap-blurb">${escape(meta.blurb)}</span>
                    </li>`;
                }).join('')}
            </ul>
            <p class="cap-consent__note">
                You can revoke this consent any time from <strong>Profile → My Upgrades</strong>. Behaviors run in a sandbox; the Platform Manifest is always protected.
            </p>
            <footer class="cap-consent__actions">
                <button type="button" class="cap-consent__btn cap-consent__btn--cancel" data-action="cancel">Cancel</button>
                <button type="button" class="cap-consent__btn cap-consent__btn--allow" data-action="allow">Allow & Adopt</button>
            </footer>
        </div>
    `;

    const done = (allowed) => {
        dlg.classList.remove('is-visible');
        setTimeout(() => { try { dlg.remove(); } catch {} }, 220);
        resolve(allowed);
    };
    dlg.querySelector('[data-action="cancel"]').addEventListener('click', () => done(false));
    dlg.querySelector('.cap-consent__veil').addEventListener('click', () => done(false));
    dlg.querySelector('[data-action="allow"]').addEventListener('click', () => done(true));
    // Escape key dismisses
    dlg.tabIndex = -1;
    dlg.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') done(false); });
    setTimeout(() => dlg.focus(), 30);

    return dlg;
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
