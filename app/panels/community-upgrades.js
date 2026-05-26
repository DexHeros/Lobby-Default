/* Community Upgrades — the GitHub-style feed of every patch the
 * community has saved to their profile. Sortable + filterable.
 * Click a card → patch detail panel. Adopt button is one-click; if the
 * patch has behaviors, capability consent intercepts first.
 *
 * Mounted via #/community-upgrades. */

import { Panel } from '../ui/panel.js';
import {
    getCommunityFeed, isAdopted, adoptPatch, unadoptPatch, PROTECTED_SURFACES,
} from '../services/upgrades-mock.js';
import { requestCapabilityConsent } from '../ui/capability-consent.js';
import { renderSocialFooter } from '../ui/dna-feed-rail.js';
import { toast } from '../ui/toast.js';

export default class CommunityUpgradesPanel extends Panel {
    static id        = 'community-upgrades';
    static variant   = 'codex';
    static width     = 920;
    static title     = 'Community Upgrades';
    static titleBreadcrumb = ['COMMUNITY UPGRADES'];
    static stageMode = 'dim';

    constructor(params = {}) {
        super(params);
        this.sort = params.sort || 'top';
        this.surface = params.surface || 'all';
    }

    render() {
        return `
            <div class="upgrades-feed">
                <header class="upgrades-feed__head">
                    <div>
                        <div class="hud-display" style="font-size:clamp(18px, 4.5vw, 26px);letter-spacing:0.14em;">COMMUNITY<br>UPGRADES</div>
                        <div class="hud-body hud-dim" style="margin-top:6px;max-width:520px;">
                            Every change the community has made to the everything-avatar lobby. Adopt with one click.
                        </div>
                    </div>
                    <div class="upgrades-feed__filters" data-filters></div>
                </header>
                <div class="upgrades-feed__grid" data-grid></div>
                <div class="upgrades-feed__empty hud-body hud-dim" data-empty hidden>No upgrades match this filter.</div>
            </div>
        `;
    }

    async onMount() {
        this.filtersEl = this.root.querySelector('[data-filters]');
        this.gridEl    = this.root.querySelector('[data-grid]');
        this.emptyEl   = this.root.querySelector('[data-empty]');
        this.renderFilters();
        this.renderGrid();
    }

    renderFilters() {
        const sortChips = [
            { id: 'top', label: 'Most adopted' },
            { id: 'new', label: 'New' },
            { id: 'all', label: 'All' },
        ];
        const surfaceChips = [
            { id: 'all', label: 'Any surface' },
            { id: 'equipment-slot', label: 'Slot popovers' },
            { id: 'chat-log', label: 'Chat log' },
            { id: 'header-ticker', label: 'Header ticker' },
            { id: 'global', label: 'Global' },
        ];
        this.filtersEl.innerHTML = `
            <div class="upgrades-feed__chips" role="tablist" aria-label="Sort">
                ${sortChips.map((c) => `
                    <button type="button" class="upgrades-feed__chip${this.sort === c.id ? ' is-active' : ''}" data-sort="${c.id}">${esc(c.label)}</button>
                `).join('')}
            </div>
            <div class="upgrades-feed__chips" role="tablist" aria-label="Surface">
                ${surfaceChips.map((c) => `
                    <button type="button" class="upgrades-feed__chip upgrades-feed__chip--quiet${this.surface === c.id ? ' is-active' : ''}" data-surface="${c.id}">${esc(c.label)}</button>
                `).join('')}
            </div>
        `;
        this.filtersEl.addEventListener('click', (ev) => {
            const sb = ev.target.closest('[data-sort]');
            const ub = ev.target.closest('[data-surface]');
            if (sb) { this.sort = sb.getAttribute('data-sort'); this.renderFilters(); this.renderGrid(); return; }
            if (ub) { this.surface = ub.getAttribute('data-surface'); this.renderFilters(); this.renderGrid(); }
        }, { signal: this.signal });
    }

    renderGrid() {
        const patches = getCommunityFeed({ sort: this.sort, surface: this.surface });
        if (!patches.length) {
            this.gridEl.innerHTML = '';
            this.emptyEl.hidden = false;
            return;
        }
        this.emptyEl.hidden = true;
        this.gridEl.innerHTML = patches.map((p) => this.renderCard(p)).join('');
        // Mount the dexhero-recorded demos AFTER the cards land so the
        // IntersectionObserver inside buildDemoVideo can attach to live nodes.
        this.mountCardDemos(patches);
        this.gridEl.addEventListener('click', async (ev) => {
            // Social-footer actions (adopt / share / comment) — same data
            // shape as the DNA feed rail so the renderSocialFooter chrome
            // works identically on this page.
            const social = ev.target.closest('[data-social-action]');
            if (social) {
                ev.preventDefault();
                ev.stopPropagation();
                const cardEl = social.closest('[data-patch-id]');
                const patchId = cardEl?.getAttribute('data-patch-id');
                if (!patchId) return;
                const action = social.getAttribute('data-social-action');
                if (action === 'adopt')   { isAdopted(patchId) ? this.onUnadopt(patchId) : this.onAdopt(patchId); return; }
                if (action === 'share')   {
                    const url = `${location.origin}/${location.pathname.replace(/\/?$/, '/')}#/upgrade/${patchId}`.replace(/\/+#/, '/#');
                    try { await navigator.clipboard.writeText(url); toast('Link copied', { kind: 'ok', ttl: 2200 }); }
                    catch { toast('Could not copy link', { kind: 'warn', ttl: 2400 }); }
                    return;
                }
                if (action === 'comment') {
                    try { sessionStorage.setItem('v3labs:scroll-to', 'comments'); } catch {}
                    location.hash = `#/upgrade/${encodeURIComponent(patchId)}`;
                    return;
                }
                if (action === 'creator') {
                    const handle = social.getAttribute('href')?.replace('#/creator/', '');
                    if (handle) location.hash = `#/creator/${handle}`;
                    return;
                }
            }

            const cardBtn = ev.target.closest('[data-action="open"]');
            if (cardBtn) { const id = cardBtn.getAttribute('data-id'); if (id) location.hash = `#/upgrade/${encodeURIComponent(id)}`; }
        }, { signal: this.signal });
    }

    renderCard(p) {
        const adopted = isAdopted(p.id);
        const behaviorCount = (p.behaviors || []).length;
        const surfaceLabel = (PROTECTED_SURFACES.find((s) => p.target_surface && s.id.endsWith(p.target_surface))?.label) || p.target_surface || 'global';
        return `
            <article class="upgrade-card" data-action="open" data-id="${esc(p.id)}" data-patch-id="${esc(p.id)}">
                <div class="upgrade-card__preview" data-card-demo aria-hidden="true">
                    ${p.is_promoted_to_main ? `<span class="upgrade-card__promoted-badge" title="Promoted to main">★ in default</span>` : ''}
                    <span class="upgrade-card__surface" title="Target surface">${esc(surfaceLabel)}</span>
                    ${behaviorCount ? `<span class="upgrade-card__badge" title="Includes scripted behaviors">⚐ ${behaviorCount}</span>` : ''}
                </div>
                <div class="upgrade-card__body">
                    <div class="upgrade-card__title">${esc(p.title || 'Untitled')}</div>
                </div>
                ${renderSocialFooter(p, { commentCount: 0, adoptedNow: adopted })}
            </article>
        `;
    }

    mountCardDemos(patches) {
        // Inject the dexhero-recorded demo into each card's preview slot.
        // Lazy via IntersectionObserver inside buildDemoVideo so offscreen
        // cards don't run animation timers.
        import('../ui/upgrade-demo-video.js').then(({ buildDemoVideo }) => {
            const cards = this.gridEl.querySelectorAll('[data-card-demo]');
            cards.forEach((host, i) => {
                const p = patches[i];
                if (!p) return;
                const v = buildDemoVideo(p, { size: 'compact' });
                if (v) host.insertBefore(v, host.firstChild);
            });
        });
    }

    async onAdopt(id) {
        const patch = getCommunityFeed({ sort: 'all' }).find((p) => p.id === id);
        if (!patch) return;
        if ((patch.behaviors || []).length) {
            const ok = await requestCapabilityConsent(patch);
            if (!ok) { toast('Adopt cancelled', { kind: 'info', ttl: 2000 }); return; }
        }
        adoptPatch(id);
        toast(`Adopted "${patch.title}" — commit pushed to your branch`, { kind: 'ok', ttl: 3400 });
        this.renderGrid();
    }

    onUnadopt(id) {
        unadoptPatch(id);
        toast('Revert commit pushed · patch removed from your branch', { kind: 'info', ttl: 2800 });
        this.renderGrid();
    }
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    if (n >= 1000)  return `${(n / 1000).toFixed(2)}k`;
    return String(n);
}
