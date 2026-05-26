/* Proposal card — the in-chat artifact that appears when the dexhero
 * generates a candidate UI patch in response to the user's /upgrade
 * request. Provides Preview / Save / Discard buttons inline.
 *
 * Every proposal embeds the dexhero-recorded demo video at the top of
 * the card — the user sees the change BEFORE deciding to preview or save.
 *
 * Mounted into the existing right-wing chat log AND into the stage
 * bubble dock so both surfaces show the proposal in context.
 */

import { showToolbar } from './upgrade-toolbar.js';
import { describePatchChanges } from '../services/upgrades-mock.js';
import { buildDemoVideo } from './upgrade-demo-video.js';
import { renderSocialFooter } from './dna-feed-rail.js';

/* Build the proposal card DOM node. The caller decides where to mount it. */
export function buildProposalCard(proposal, opts = {}) {
    if (!proposal || proposal.kind !== 'proposal' || !proposal.patch) return null;
    const patch = proposal.patch;
    const card = document.createElement('div');
    card.className = 'upgrade-proposal-card';
    card.setAttribute('data-patch-target', patch.target_surface || 'global');

    const behaviorBadges = (patch.behaviors || []).length
        ? `<span class="upgrade-proposal-card__badge upgrade-proposal-card__badge--behaviors" title="This patch includes scripted behaviors that run in a sandbox.">⚐ ${patch.behaviors.length} behavior${patch.behaviors.length === 1 ? '' : 's'}</span>`
        : '';

    card.innerHTML = `
        <header class="upgrade-proposal-card__head">
            <span class="upgrade-proposal-card__role">Upgrade proposal</span>
            <span class="upgrade-proposal-card__badges">${behaviorBadges}</span>
        </header>
        <div class="upgrade-proposal-card__video" data-demo-mount></div>
        <div class="upgrade-proposal-card__body">
            <div class="upgrade-proposal-card__title">${escape(patch.title || 'Untitled patch')}</div>
            <div class="upgrade-proposal-card__desc">${escape(patch.description || '')}</div>
            <div class="upgrade-proposal-card__diff">
                <strong>Changes:</strong> ${escape(describePatchChanges(patch))}
            </div>
        </div>
        ${renderSocialFooter(patch, { adoptedNow: false })}
        <footer class="upgrade-proposal-card__actions">
            <button type="button" class="upgrade-proposal-card__btn upgrade-proposal-card__btn--preview" data-action="preview">Preview</button>
            <button type="button" class="upgrade-proposal-card__btn upgrade-proposal-card__btn--save" data-action="save" title="Commit to your branch + push to community feed">Commit</button>
            <button type="button" class="upgrade-proposal-card__btn upgrade-proposal-card__btn--discard" data-action="discard">Discard</button>
        </footer>
    `;

    // Mount the dexhero's recorded demo video — the visual receipt of the
    // change. Without this, the proposal would be a JSON blob with copy.
    const videoMount = card.querySelector('[data-demo-mount]');
    if (videoMount) {
        const demo = buildDemoVideo(patch, { size: 'compact' });
        if (demo) videoMount.appendChild(demo);
    }

    const previewBtn = card.querySelector('[data-action="preview"]');
    const saveBtn    = card.querySelector('[data-action="save"]');
    const discardBtn = card.querySelector('[data-action="discard"]');

    previewBtn.addEventListener('click', () => {
        showToolbar(patch, {
            onSave: (saved) => {
                markCardDone(card, `Saved as "${saved.title}".`);
                opts.onSaved?.(saved);
            },
            onDiscard: () => {
                markCardDone(card, 'Preview discarded.');
            },
        });
    });
    saveBtn.addEventListener('click', () => {
        showToolbar(patch, {
            onSave: (saved) => { markCardDone(card, `Saved as "${saved.title}".`); opts.onSaved?.(saved); },
            onDiscard: () => markCardDone(card, 'Preview discarded.'),
        });
        // Auto-trigger save via the toolbar's save button so the user only
        // pays one click. (Acts like "Quick save" — preview applies briefly,
        // then we click the save button programmatically.)
        requestAnimationFrame(() => {
            const tb = document.getElementById('dexhero-upgrade-toolbar');
            tb?.querySelector('[data-action="save"]')?.click();
        });
    });
    discardBtn.addEventListener('click', () => {
        markCardDone(card, 'Proposal discarded.');
    });

    return card;
}

function markCardDone(card, statusText) {
    if (!card) return;
    card.classList.add('is-resolved');
    const actions = card.querySelector('.upgrade-proposal-card__actions');
    if (actions) {
        actions.innerHTML = `<span class="upgrade-proposal-card__status">${escape(statusText)}</span>`;
    }
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
