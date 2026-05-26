/* Creator profile — showcase for a single creator. Avatar, follower
 * count, total adopters across all their patches, promotion badge,
 * grid of every patch they've published.
 *
 * Mounted via #/creator/:username. */

import { Panel } from '../ui/panel.js';
import { getCreatorByUsername, isAdopted } from '../services/upgrades-mock.js';

export default class CreatorProfilePanel extends Panel {
    static id        = 'creator-profile';
    static variant   = 'codex';
    static width     = 720;
    static title     = 'Creator';
    static titleBreadcrumb = ['CREATOR'];
    static stageMode = 'dim';

    render() {
        const name = this.params.username;
        const c = getCreatorByUsername(name);
        if (!c) {
            return `<div class="panel-state">
                <div class="panel-state__title">Unknown creator</div>
                <div class="panel-state__body">No creator named ${esc(name || '')}.</div>
            </div>`;
        }
        return `
            <div class="creator-profile">
                <header class="creator-profile__head">
                    <div class="creator-profile__avatar" aria-hidden="true">${esc(c.avatar || '◇')}</div>
                    <div class="creator-profile__head-meta">
                        <div class="creator-profile__name">
                            ${esc(c.username)}
                            ${c.hasPromoted ? `<span class="creator-profile__promoted-badge" title="Has patches promoted into the default base">★ in default</span>` : ''}
                        </div>
                        <div class="creator-profile__stats hud-body hud-dim">
                            <span><strong>${fmtCount(c.followers)}</strong> followers</span>
                            <span class="creator-profile__stats-dot">·</span>
                            <span><strong>${fmtCount(c.totalAdopters)}</strong> adopters across ${c.patches.length} patch${c.patches.length === 1 ? '' : 'es'}</span>
                            <span class="creator-profile__stats-dot">·</span>
                            <span>joined ${esc(c.joined || '')}</span>
                        </div>
                    </div>
                    <button type="button" class="upgrade-card__btn upgrade-card__btn--ghost" data-action="follow">Follow</button>
                </header>

                <section class="creator-profile__patches">
                    <h3 class="upgrade-detail__section-title">Patches</h3>
                    ${c.patches.length ? `
                        <div class="creator-profile__grid">
                            ${c.patches.map((p) => `
                                <a class="upgrade-card creator-profile__card" href="#/upgrade/${esc(p.id)}">
                                    <div class="upgrade-card__preview" aria-hidden="true">
                                        <span class="upgrade-card__preview-thumb">${esc(p.preview_thumb || '◆')}</span>
                                        ${p.is_promoted_to_main ? `<span class="upgrade-card__promoted-badge">★</span>` : ''}
                                    </div>
                                    <div class="upgrade-card__body">
                                        <div class="upgrade-card__title">${esc(p.title)}</div>
                                        <div class="upgrade-card__desc">${esc(p.description)}</div>
                                    </div>
                                    <footer class="upgrade-card__footer">
                                        <span class="upgrade-card__count">${fmtCount(p.adoption_count)} adopters</span>
                                        ${isAdopted(p.id) ? `<span class="upgrade-card__btn upgrade-card__btn--adopted">Adopted ✓</span>` : ''}
                                    </footer>
                                </a>
                            `).join('')}
                        </div>
                    ` : `<div class="hud-body hud-dim">No patches yet.</div>`}
                </section>
            </div>
        `;
    }

    async onMount() {
        const followBtn = this.root.querySelector('[data-action="follow"]');
        if (followBtn) {
            followBtn.addEventListener('click', () => {
                import('../ui/toast.js').then(({ toast }) => toast('Following requires v2 — for now, your adoption signals support.', { kind: 'info', ttl: 4000 }));
            }, { signal: this.signal });
        }
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
