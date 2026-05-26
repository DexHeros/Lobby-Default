/* Floating preview toolbar — shown across the top of the viewport whenever
 * a patch preview is active. Provides quick Save / Discard buttons so the
 * user can commit OR roll back without scrolling back to the chat.
 *
 * Mounted lazily by stage-chat when a proposal preview starts. Removed
 * after Save or Discard. */

import { applyPreview, clearPreview } from '../services/patch-applier-mock.js';
import { saveAuthored } from '../services/upgrades-mock.js';
import { toast } from './toast.js';

const TOOLBAR_ID = 'dexhero-upgrade-toolbar';

export function showToolbar(patch, { onSave, onDiscard } = {}) {
    hideToolbar();   // single instance
    const el = document.createElement('div');
    el.id = TOOLBAR_ID;
    el.className = 'upgrade-toolbar';
    el.innerHTML = `
        <span class="upgrade-toolbar__dot" aria-hidden="true"></span>
        <span class="upgrade-toolbar__label">
            <span class="upgrade-toolbar__prefix">Previewing</span>
            <strong>${escape(patch.title || 'Untitled patch')}</strong>
        </span>
        <button type="button" class="upgrade-toolbar__btn upgrade-toolbar__btn--save" data-action="save" title="Commit to your branch + push to community feed">Commit</button>
        <button type="button" class="upgrade-toolbar__btn upgrade-toolbar__btn--discard" data-action="discard">Discard</button>
    `;
    document.body.appendChild(el);

    el.querySelector('[data-action="save"]').addEventListener('click', () => {
        const saved = saveAuthored(patch);
        clearPreview();
        // The commit dispatch already fires inside upgrades-mock; nothing else needed.
        toast(`Committed "${saved.title}" → pushed to community feed`, { kind: 'ok', ttl: 4400 });
        hideToolbar();
        if (typeof onSave === 'function') onSave(saved);
    }, { once: true });

    el.querySelector('[data-action="discard"]').addEventListener('click', () => {
        clearPreview();
        toast('Discarded preview', { kind: 'info', ttl: 2400 });
        hideToolbar();
        if (typeof onDiscard === 'function') onDiscard();
    }, { once: true });

    // Make the patch live for preview
    applyPreview(patch);

    requestAnimationFrame(() => el.classList.add('is-visible'));
}

export function hideToolbar() {
    const el = document.getElementById(TOOLBAR_ID);
    if (!el) return;
    el.classList.remove('is-visible');
    setTimeout(() => { try { el.remove(); } catch {} }, 220);
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
