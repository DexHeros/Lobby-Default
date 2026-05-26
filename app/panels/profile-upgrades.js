/* Profile · Your Branch — git-style commit log for the user's personal
 * branch of the everything-avatar lobby. Every authoring, adoption,
 * toggle, and revert is a commit row. The user can revert any commit
 * (creates a new revert commit), check out an earlier commit (moves
 * HEAD back without destroying anything), and see stale commits that
 * were rewound by a previous checkout.
 *
 * Mounted via #/profile/upgrades. */

import { Panel } from '../ui/panel.js';
import {
    getCommits, getHead, getActiveChain, getStaleCommits,
    revertCommit, checkoutCommit, togglePatch, isEnabled,
    getActivePatches,
} from '../services/upgrades-mock.js';
import { toast } from '../ui/toast.js';

const OP_ICON = {
    genesis: '◌',
    author:  '✎',
    adopt:   '↓',
    revert:  '↺',
    toggle:  '◐',
};

const OP_LABEL = {
    genesis: 'baseline',
    author:  'author',
    adopt:   'adopt',
    revert:  'revert',
    toggle:  'toggle',
};

export default class ProfileUpgradesPanel extends Panel {
    static id        = 'profile-upgrades';
    static variant   = 'codex';
    static width     = 780;
    static title     = 'Your Branch';
    static titleBreadcrumb = ['PROFILE', 'YOUR BRANCH'];
    static stageMode = 'dim';

    render() {
        const commits = getCommits();
        const head = getHead();
        const active = new Set(getActiveChain().map((c) => c.id));
        const stale = getStaleCommits();
        const activeCommits = commits.filter((c) => active.has(c.id)).slice().reverse(); // newest first
        const livePatches = getActivePatches();

        return `
            <div class="profile-upgrades">
                <header class="profile-upgrades__head">
                    <div>
                        <div class="hud-display" style="font-size:22px;letter-spacing:0.14em;">YOUR BRANCH</div>
                        <div class="hud-body hud-dim" style="margin-top:6px;">
                            Every change is a commit. Nothing is overwritten — revert any commit, check out any earlier point, and your branch picks up from there.
                        </div>
                    </div>
                    <div class="branch-summary">
                        <span class="branch-summary__chip"><span>HEAD</span><strong>${esc(shortId(head))}</strong></span>
                        <span class="branch-summary__chip"><span>commits</span><strong>${active.size}</strong></span>
                        <span class="branch-summary__chip"><span>live patches</span><strong>${livePatches.length}</strong></span>
                    </div>
                </header>

                <section class="profile-upgrades__section">
                    <h3 class="upgrade-detail__section-title">Commit log · your branch</h3>
                    <ol class="commit-log">
                        ${activeCommits.map((c) => this.renderCommit(c, { stale: false, isHead: c.id === head })).join('')}
                    </ol>
                </section>

                ${stale.length ? `
                    <section class="profile-upgrades__section">
                        <h3 class="upgrade-detail__section-title">Stale commits · rewound by a previous checkout</h3>
                        <div class="hud-body hud-dim" style="margin-bottom:8px;">
                            These commits still exist in your branch's history. Check out any of them to restore that state — nothing is lost.
                        </div>
                        <ol class="commit-log commit-log--stale">
                            ${stale.slice().reverse().map((c) => this.renderCommit(c, { stale: true, isHead: false })).join('')}
                        </ol>
                    </section>
                ` : ''}

                ${livePatches.length ? `
                    <section class="profile-upgrades__section">
                        <h3 class="upgrade-detail__section-title">Live patches at HEAD</h3>
                        <ul class="profile-upgrades__list">
                            ${livePatches.map((p) => this.renderLivePatch(p)).join('')}
                        </ul>
                    </section>
                ` : ''}

                ${activeCommits.length <= 1 ? `
                    <div class="profile-upgrades__empty">
                        <div class="hud-display" style="font-size:18px;letter-spacing:0.14em;">CLEAN BRANCH</div>
                        <div class="hud-body hud-dim" style="margin-top:8px;">
                            Your branch is at the platform baseline. Type <strong>/upgrade make popups darker</strong> (or any change you want) in the chat to author your first commit.<br>
                            Or browse <a href="#/community-upgrades">community upgrades</a> to adopt one.
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderCommit(c, { stale = false, isHead = false } = {}) {
        const icon = OP_ICON[c.op] || '●';
        const opLabel = OP_LABEL[c.op] || c.op;
        const patchTitle = c.patch_snapshot?.title || (c.patch_id ? c.patch_id : '');
        const patchAuthor = c.patch_snapshot?.author_username || '';
        const canRevert = !stale && !isHead && c.op !== 'genesis';
        const canCheckout = c.id !== getHead();
        const canViewPatch = !!(c.patch_snapshot?.id);

        return `
            <li class="commit-row${isHead ? ' is-head' : ''}${stale ? ' is-stale' : ''}" data-commit-id="${esc(c.id)}">
                <div class="commit-row__rail">
                    <span class="commit-row__node">${icon}</span>
                </div>
                <div class="commit-row__body">
                    <div class="commit-row__head">
                        <span class="commit-row__op">${esc(opLabel)}</span>
                        <span class="commit-row__hash">${esc(shortId(c.id))}</span>
                        <span class="commit-row__time">${esc(fmtTime(c.ts))}</span>
                        ${isHead ? '<span class="commit-row__head-badge">HEAD</span>' : ''}
                        ${stale ? '<span class="commit-row__stale-badge">stale</span>' : ''}
                    </div>
                    <div class="commit-row__msg">${esc(c.message || '')}</div>
                    ${patchTitle ? `
                        <div class="commit-row__patch">
                            <span>↳</span>
                            <a href="#/upgrade/${esc(c.patch_snapshot?.id || c.patch_id)}">${esc(patchTitle)}</a>
                            ${patchAuthor ? `<span class="hud-dim"> by ${esc(patchAuthor)}</span>` : ''}
                        </div>
                    ` : ''}
                    <div class="commit-row__actions">
                        ${canCheckout ? `<button type="button" class="commit-row__btn" data-action="checkout" data-commit-id="${esc(c.id)}" title="Move HEAD here — nothing is destroyed">Check out</button>` : ''}
                        ${canRevert ? `<button type="button" class="commit-row__btn commit-row__btn--ghost" data-action="revert" data-commit-id="${esc(c.id)}" title="Create a new revert commit that undoes this">Revert</button>` : ''}
                        ${canViewPatch ? `<button type="button" class="commit-row__btn commit-row__btn--ghost" data-action="view-patch" data-patch-id="${esc(c.patch_snapshot?.id || c.patch_id)}">View patch</button>` : ''}
                    </div>
                </div>
            </li>
        `;
    }

    renderLivePatch(p) {
        const enabled = isEnabled(p.id);
        return `
            <li class="profile-upgrades__row${enabled ? '' : ' is-disabled'}" data-id="${esc(p.id)}">
                <div class="profile-upgrades__thumb-video" data-row-demo data-patch-id="${esc(p.id)}"></div>
                <div class="profile-upgrades__meta">
                    <a class="profile-upgrades__title" href="#/upgrade/${esc(p.id)}">${esc(p.title)}</a>
                    <div class="profile-upgrades__sub hud-body hud-dim">
                        ${p.author_username && p.author_username !== 'you' ? `by ${esc(p.author_username)}` : 'authored by you'}
                    </div>
                </div>
                <label class="profile-upgrades__toggle" title="${enabled ? 'Disable (creates a toggle commit)' : 'Enable (creates a toggle commit)'}">
                    <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggle" data-id="${esc(p.id)}">
                    <span class="profile-upgrades__toggle-track"></span>
                </label>
            </li>
        `;
    }

    async onMount() {
        this.mountRowDemos();
        this.root.addEventListener('change', (ev) => {
            const cb = ev.target.closest('[data-action="toggle"]');
            if (!cb) return;
            const id = cb.getAttribute('data-id');
            togglePatch(id);
            toast(cb.checked ? 'Toggle commit · patch enabled' : 'Toggle commit · patch disabled', { kind: 'info', ttl: 2200 });
            this.refresh();
        }, { signal: this.signal });

        this.root.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const a = btn.getAttribute('data-action');
            const commitId = btn.getAttribute('data-commit-id');
            const patchId = btn.getAttribute('data-patch-id');
            if (a === 'revert' && commitId) {
                revertCommit(commitId);
                toast('Revert commit pushed', { kind: 'info', ttl: 2400 });
                this.refresh();
                return;
            }
            if (a === 'checkout' && commitId) {
                checkoutCommit(commitId);
                toast(`HEAD moved to ${shortId(commitId)} · branch state restored`, { kind: 'ok', ttl: 3000 });
                this.refresh();
                return;
            }
            if (a === 'view-patch' && patchId) {
                location.hash = `#/upgrade/${encodeURIComponent(patchId)}`;
            }
        }, { signal: this.signal });
    }

    mountRowDemos() {
        const hosts = this.root.querySelectorAll('[data-row-demo]');
        if (!hosts.length) return;
        import('../ui/upgrade-demo-video.js').then(({ buildDemoVideo }) => {
            import('../services/upgrades-mock.js').then(({ getPatchById }) => {
                hosts.forEach((host) => {
                    const id = host.getAttribute('data-patch-id');
                    const p = id && getPatchById(id);
                    if (!p) return;
                    const el = buildDemoVideo(p, { size: 'compact', mode: 'cycle', modesAllowed: ['cycle', 'split'] });
                    if (el) host.appendChild(el);
                });
            });
        });
    }

    refresh() {
        const body = this.root.querySelector('.panel__body');
        if (body) body.innerHTML = this.render();
        // Re-bind because we replaced the DOM tree
        this.mountRowDemos();
    }
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
function shortId(id) {
    if (!id) return '';
    if (id === 'commit_genesis') return 'genesis';
    return String(id).split('_').slice(-1)[0].slice(0, 7);
}
function fmtTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        const now = Date.now();
        const diff = Math.floor((now - d.getTime()) / 1000);
        if (diff < 0) return 'just now';
        if (diff < 60)         return `${diff}s ago`;
        if (diff < 3600)       return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400)      return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 86400 * 7)  return `${Math.floor(diff / 86400)}d ago`;
        return d.toLocaleDateString();
    } catch { return ''; }
}
