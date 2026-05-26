/* Upgrade detail — per-patch deep view. Full description, recorded
 * before/after demo (with slider compare default), capability breakdown,
 * mock adoption sparkline, Adopt action.
 *
 * Mounted via #/upgrade/:id. */

import { Panel } from '../ui/panel.js';
import {
    getPatchById, isAdopted, adoptPatch, unadoptPatch,
    getComments, addComment,
    describePatchChanges, CAPABILITIES,
    promotePatch, unpromotePatch,
} from '../services/upgrades-mock.js';
import { requestCapabilityConsent } from '../ui/capability-consent.js';
import { showToolbar } from '../ui/upgrade-toolbar.js';
import { toast } from '../ui/toast.js';
import * as wallet from '../services/wallet.js';

/* Master Wallet address — when the connected wallet matches, the
 * Promote-to-main admin button is enabled. Stage A check is client-side
 * only (the real allowlist gates the server endpoint in Stage E). */
const MASTER_WALLET = '0x11a6b77fb2993c9eb6d7b282d8aa5e2559db20ee';
function _isMasterWallet() {
    const addr = (wallet.getStatus()?.address || '').toLowerCase();
    if (addr === MASTER_WALLET) return true;
    // Dev override — lets you preview the admin UI without holding the
    // Master Wallet key. Set in devtools: localStorage['dexhero:admin'] = '1'.
    try { return localStorage.getItem('dexhero:admin') === '1'; } catch { return false; }
}

export default class UpgradeDetailPanel extends Panel {
    static id        = 'upgrade-detail';
    static variant   = 'codex';
    static width     = 720;
    static title     = 'Upgrade';
    static titleBreadcrumb = ['COMMUNITY UPGRADES', 'PATCH'];
    static stageMode = 'dim';

    render() {
        const id = this.params.id;
        const patch = id && getPatchById(id);
        if (!patch) {
            return `<div class="panel-state">
                <div class="panel-state__title">Not found</div>
                <div class="panel-state__body">No patch with id ${esc(id || '')}.</div>
            </div>`;
        }
        this._patch = patch;
        const caps = collectCaps(patch);
        const adopted = isAdopted(patch.id);
        // (Parent / fork chain removed — the platform uses a flat
        // commit-chain model now; community remixing happens via the
        // /upgrade flow producing a fresh patch, not via patch lineage.)
        return `
            <div class="upgrade-detail">
                <header class="upgrade-detail__head">
                    <div class="upgrade-detail__hero">
                        <span class="upgrade-detail__thumb">${esc(patch.preview_thumb || '◆')}</span>
                        ${patch.is_promoted_to_main ? `<span class="upgrade-card__promoted-badge" title="Promoted to main">★ in default</span>` : ''}
                    </div>
                    <div class="upgrade-detail__title-block">
                        <div class="hud-display" style="font-size:24px;letter-spacing:0.12em;">${esc(patch.title || 'Untitled')}</div>
                        <div class="upgrade-detail__byline">
                            by <button type="button" class="upgrade-card__author" data-action="open-author">${esc(patch.author_username || 'unknown')}</button>
                            · ${esc(describePatchChanges(patch))}
                        </div>
                    </div>
                </header>

                <section class="upgrade-detail__section">
                    <h3 class="upgrade-detail__section-title">Recorded demonstration</h3>
                    <div class="upgrade-detail__video" data-detail-demo></div>
                </section>

                <p class="upgrade-detail__desc">${esc(patch.description || '')}</p>


                <section class="upgrade-detail__section">
                    <h3 class="upgrade-detail__section-title">Capabilities requested</h3>
                    ${caps.length ? `
                        <ul class="upgrade-detail__caps">
                            ${caps.map((c) => {
                                const m = CAPABILITIES[c] || { label: c, blurb: 'Unknown capability.' };
                                return `<li>
                                    <strong>${esc(m.label)}</strong>
                                    <span class="hud-dim">— ${esc(m.blurb)}</span>
                                </li>`;
                            }).join('')}
                        </ul>
                    ` : `<div class="hud-body hud-dim">Pure visual — no scripted behaviors. Safe by construction.</div>`}
                </section>

                <section class="upgrade-detail__section">
                    <h3 class="upgrade-detail__section-title">Adoption · last 30 days</h3>
                    <div class="upgrade-detail__sparkline" aria-hidden="true">${mockSparkline(patch)}</div>
                    <div class="hud-body hud-dim">${fmtCount(patch.adoption_count)} total adopters</div>
                </section>

                ${_renderComments(patch)}

                <footer class="upgrade-detail__actions">
                    <button type="button" class="upgrade-card__btn upgrade-card__btn--ghost" data-action="preview">Preview</button>
                    ${adopted
                        ? `<button type="button" class="upgrade-card__btn upgrade-card__btn--adopted" data-action="unadopt" title="Revert the adopt commit">Adopted ✓</button>`
                        : `<button type="button" class="upgrade-card__btn" data-action="adopt" title="Commit · adopt this patch into your branch">Adopt</button>`
                    }
                    ${_isMasterWallet() ? `
                        <span class="upgrade-detail__admin-divider" aria-hidden="true">·</span>
                        ${patch.is_promoted_to_main
                            ? `<button type="button" class="upgrade-card__btn upgrade-card__btn--admin" data-action="unpromote" title="Unmerge from main (admin)">★ Unpromote</button>`
                            : `<button type="button" class="upgrade-card__btn upgrade-card__btn--admin" data-action="promote" title="Merge into main · permanent attribution to creator (admin)">★ Promote to main</button>`
                        }
                    ` : ''}
                </footer>
            </div>
        `;
    }

    async onMount() {
        if (!this._patch) return;
        // Mount the dexhero-recorded demo with all three compare modes
        // available. Default to slider so users can directly evaluate the
        // change before deciding to adopt — the most "should I take this?"
        // surface in the app.
        const demoMount = this.root.querySelector('[data-detail-demo]');
        if (demoMount) {
            import('../ui/upgrade-demo-video.js').then(({ buildDemoVideo }) => {
                const el = buildDemoVideo(this._patch, { size: 'full', mode: 'slider', modesAllowed: ['slider', 'split', 'cycle'] });
                if (el) demoMount.appendChild(el);
            });
        }
        this.root.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const a = btn.getAttribute('data-action');
            if (a === 'open-author') {
                location.hash = `#/creator/${encodeURIComponent(this._patch.author_username || '')}`;
                return;
            }
            if (a === 'preview') {
                showToolbar(this._patch);
                return;
            }
            if (a === 'adopt') {
                // Adopt is INSTANT once consent (for behaviors) is given.
                // The adopt commit lands on your branch immediately and the
                // patch goes live. No "save" half-step — that was Fork-era
                // friction we deleted.
                if ((this._patch.behaviors || []).length) {
                    const ok = await requestCapabilityConsent(this._patch);
                    if (!ok) { toast('Adopt cancelled', { kind: 'info', ttl: 2000 }); return; }
                }
                adoptPatch(this._patch.id);
                toast(`Adopted "${this._patch.title}" — commit pushed to your branch`, { kind: 'ok', ttl: 3400 });
                this.refresh();
                return;
            }
            if (a === 'unadopt') {
                unadoptPatch(this._patch.id);
                toast('Revert commit pushed · patch removed from your branch', { kind: 'info', ttl: 2800 });
                this.refresh();
                return;
            }
            if (a === 'promote') {
                if (!_isMasterWallet()) return;
                promotePatch(this._patch.id, { promoter: 'master-wallet' });
                toast(`★ "${this._patch.title}" merged into main · ${this._patch.author_username} credited`, { kind: 'ok', ttl: 4400 });
                this.refresh();
                return;
            }
            if (a === 'unpromote') {
                if (!_isMasterWallet()) return;
                unpromotePatch(this._patch.id);
                toast('Reverted promotion — patch is community-only again', { kind: 'info', ttl: 3200 });
                this.refresh();
            }
            if (a === 'comment-submit') {
                ev.preventDefault();
                ev.stopPropagation();
                const ta = this.root.querySelector('[data-comment-input]');
                const body = (ta?.value || '').trim();
                if (!body) return;
                // Identity: use the connected wallet if available, otherwise
                // anonymous local. Same pattern saveAuthored uses.
                const w = wallet.getStatus()?.address || '';
                const username = w ? (w.slice(0, 6) + '…' + w.slice(-4)) : 'you';
                addComment(this._patch.id, { body, wallet: w || 'local:me', username });
                if (ta) ta.value = '';
                this._refreshCommentsOnly();
                toast('Comment posted', { kind: 'ok', ttl: 1800 });
            }
        }, { signal: this.signal });

        // Deep-link to the comments section. The social-card chrome's
        // Comment button stashes `sessionStorage['v3labs:scroll-to']`
        // ('comments') before navigating here, because URL hash routes
        // can't embed sub-fragments (parser collides). Consume + clear
        // the sentinel.
        let scrollTarget = null;
        try {
            scrollTarget = sessionStorage.getItem('v3labs:scroll-to');
            if (scrollTarget) sessionStorage.removeItem('v3labs:scroll-to');
        } catch {}
        if (scrollTarget === 'comments') {
            requestAnimationFrame(() => {
                const sec = this.root.querySelector('#comments');
                sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                const input = this.root.querySelector('[data-comment-input]');
                input?.focus();
            });
        }

        // Live-update if some other surface posts a comment for this patch.
        const onCommentAdded = (ev) => {
            if (ev.detail?.patchId !== this._patch.id) return;
            this._refreshCommentsOnly();
        };
        document.addEventListener('dexhero:comment-added', onCommentAdded);
        this.onClose(() => { try { document.removeEventListener('dexhero:comment-added', onCommentAdded); } catch {} });
    }

    /* Refresh only the comments section — avoid blowing away the
     * sparkline / demo player / capability list since those are
     * unchanged when a comment lands. */
    _refreshCommentsOnly() {
        const old = this.root.querySelector('#comments');
        if (!old || !this._patch) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = _renderComments(this._patch);
        const fresh = wrap.firstElementChild;
        if (fresh) old.replaceWith(fresh);
    }

    refresh() {
        const body = this.root.querySelector('.panel__body');
        if (body) body.innerHTML = this.render();
    }
}

function collectCaps(patch) {
    const out = new Set();
    for (const b of patch.behaviors || []) {
        for (const c of (b.capabilities_requested || [])) out.add(c);
    }
    return [...out];
}

function mockSparkline(patch) {
    // Deterministic-looking 30-bar sparkline seeded from id length.
    const seed = (patch.id || '').length || 7;
    const bars = Array.from({ length: 30 }, (_, i) => {
        const v = 8 + ((i * seed) % 22) + Math.round(Math.sin(i / 3 + seed) * 6);
        return Math.max(3, Math.min(40, v));
    });
    return `<svg viewBox="0 0 300 50" width="100%" height="50" preserveAspectRatio="none">
        ${bars.map((h, i) => `<rect x="${i * 10 + 1}" y="${50 - h}" width="8" height="${h}" rx="1" fill="var(--acc-cyan, #6ff5ff)" opacity="0.7"/>`).join('')}
    </svg>`;
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

/* Comment thread section — rendered for the patch detail page. Reads
 * the live store via getComments. Submit is delegated through the
 * existing `[data-action]` click handler on the panel root. */
function _renderComments(patch) {
    const list = getComments(patch.id);
    const empty = list.length === 0;
    const rows = list.map((c) => {
        const handle = (c.username && c.username.trim()) || (c.wallet ? c.wallet.slice(0, 6) + '…' : 'you');
        const ago = _ago(c.ts);
        return `
            <li class="upgrade-detail__comment">
                <header class="upgrade-detail__comment-head">
                    <span class="upgrade-detail__comment-author">@${esc(handle)}</span>
                    <span class="upgrade-detail__comment-time">${esc(ago)}</span>
                </header>
                <p class="upgrade-detail__comment-body">${esc(c.body)}</p>
            </li>
        `;
    }).join('');
    return `
        <section class="upgrade-detail__section upgrade-detail__comments" id="comments">
            <h3 class="upgrade-detail__section-title">Comments · ${list.length}</h3>
            <form class="upgrade-detail__comment-form" data-comment-form>
                <textarea class="upgrade-detail__comment-input" data-comment-input
                          placeholder="What did you think of this upgrade?" rows="2" maxlength="800"></textarea>
                <button type="button" class="upgrade-card__btn upgrade-card__btn--ghost"
                        data-action="comment-submit">Post</button>
            </form>
            ${empty
                ? `<div class="hud-body hud-dim upgrade-detail__comments-empty">No comments yet — be the first.</div>`
                : `<ul class="upgrade-detail__comments-list">${rows}</ul>`
            }
        </section>
    `;
}

function _ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
