/* Node Dashboard panel — host's compute-marketplace dashboard.
   Phase 2 (P2.7) — surfaces the indexer-populated attestation + audit-challenge
   trail from /api/node/attestations and /api/node/audit-challenges. The legacy
   /pages/node-dashboard.html still ships the rarity-target + compute-progress
   ring (loaded via iframe at the bottom of this panel for the parts not yet
   ported); the native UI on top renders the new indexer surfaces and the
   threshold-aware Unlock CTA.

   Refresh: 30s while the panel is visible. Drops the timer on unmount via
   AbortSignal — no leaked intervals when the user navigates elsewhere. */

import { Panel, escapeHTML, fmtAddress } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { on, E } from '../events.js';

const REFRESH_INTERVAL_MS = 30_000;
const RECENT_ATTESTATIONS = 10;

export default class NodeDashboardPanel extends Panel {
    static id        = 'node-dashboard';
    static variant   = 'right';
    static width     = 720;
    static title     = 'Servers';
    static titleBreadcrumb = ['SERVERS'];
    static stageMode = 'dim';
    static parentHash = '#/';

    constructor(params) {
        super(params);
        // Hydration cache — populated by _refresh(). Each is null while in-
        // flight, then either an object with the API payload or { error }.
        this._attestations = null;       // { attestations: [], total_minutes_credited }
        this._auditChallenges = null;    // { challenges: [], total_passed, total_failed }
        this._refreshTimer = null;
        // Optional dexheroId scoping. The panel renders aggregate stats by
        // default; ?dexheroId=0x... in the route narrows to a single hero.
        this._dexheroId = params.dexheroId || params.dexhero || null;
    }

    render() {
        const s = wallet.getStatus();
        if (!s.connected) {
            return `
                <section class="panel-section">
                    <div class="panel-state">
                        <div class="panel-state__title">Connect Wallet</div>
                        <div class="panel-state__body">Connect a wallet to view your server dashboard.</div>
                        <button class="hud-btn hud-btn--primary" data-connect>Connect</button>
                    </div>
                </section>`;
        }

        const att = this._attestations;
        const ch = this._auditChallenges;

        return `
            ${this._renderSummaryCards(s.address, att, ch)}
            ${this._renderAttestationList(att)}
            ${this._renderChallengeList(ch)}
            ${this._renderLegacyEmbed()}
        `;
    }

    _renderSummaryCards(addr, att, ch) {
        const minutesThisWeek = sumMinutesLastWindow(att?.attestations, 7 * 24 * 60 * 60 * 1000);
        const totalMinutes = att?.total_minutes_credited != null
            ? Number(att.total_minutes_credited).toLocaleString()
            : '--';
        const passed = ch?.total_passed ?? '--';
        const failed = ch?.total_failed ?? '--';

        return `
            <section class="panel-section">
                <div class="hud-display" style="font-size:14px;letter-spacing:0.18em;margin-bottom:4px;">SERVER DASHBOARD</div>
                <div class="hud-mono hud-muted" style="font-size:11px;letter-spacing:0.16em;">${escapeHTML(fmtAddress(addr))}</div>
            </section>

            <section class="panel-section" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="hud-card" style="padding:14px;">
                    <div class="hud-mono hud-muted" style="font-size:10px;letter-spacing:0.18em;">MINUTES (7d)</div>
                    <div style="font-size:22px;font-weight:700;margin-top:4px;">${escapeHTML(String(minutesThisWeek))}</div>
                    <div class="hud-mono hud-muted" style="font-size:10px;margin-top:4px;">total credited: ${escapeHTML(String(totalMinutes))}</div>
                </div>
                <div class="hud-card" style="padding:14px;">
                    <div class="hud-mono hud-muted" style="font-size:10px;letter-spacing:0.18em;">AUDIT CHALLENGES</div>
                    <div style="font-size:22px;font-weight:700;margin-top:4px;">
                        <span style="color:#4ade80;">${escapeHTML(String(passed))}</span>
                        <span class="hud-muted" style="font-size:14px;"> / </span>
                        <span style="color:#f87171;">${escapeHTML(String(failed))}</span>
                    </div>
                    <div class="hud-mono hud-muted" style="font-size:10px;margin-top:4px;">passed / missed</div>
                </div>
            </section>
        `;
    }

    _renderAttestationList(att) {
        if (att == null) {
            return `<section class="panel-section"><div class="hud-spin"></div><div class="hud-label" style="margin-top:6px;">Loading attestations…</div></section>`;
        }
        if (att.error) {
            return `<section class="panel-section"><div class="hud-label" style="color:#f87171;">Attestation feed: ${escapeHTML(att.error)}</div></section>`;
        }
        const rows = (att.attestations || []).slice(0, RECENT_ATTESTATIONS);
        if (!rows.length) {
            return `
                <section class="panel-section">
                    <div class="hud-mono hud-muted" style="font-size:11px;letter-spacing:0.18em;margin-bottom:8px;">RECENT ATTESTATIONS</div>
                    <div class="hud-label hud-muted" style="font-size:12px;">No attestations recorded yet. Once you start a streaming session, on-chain credits will appear here.</div>
                </section>`;
        }
        return `
            <section class="panel-section">
                <div class="hud-mono hud-muted" style="font-size:11px;letter-spacing:0.18em;margin-bottom:8px;">RECENT ATTESTATIONS</div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    ${rows.map((r) => `
                        <div class="hud-card" style="padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:12px;">
                            <div>
                                <div style="font-size:13px;font-weight:600;">${escapeHTML(formatTime(r.timestamp))}</div>
                                <div class="hud-mono hud-muted" style="font-size:10px;">block ${escapeHTML(String(r.block_number))} · tx ${escapeHTML(shortHash(r.tx_hash))}</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:14px;font-weight:700;">${escapeHTML(String(r.total_minutes))}</div>
                                <div class="hud-mono hud-muted" style="font-size:10px;">cumulative min</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }

    _renderChallengeList(ch) {
        if (ch == null) return '';
        if (ch.error) {
            return `<section class="panel-section"><div class="hud-label" style="color:#f87171;">Audit feed: ${escapeHTML(ch.error)}</div></section>`;
        }
        const rows = (ch.challenges || []).slice(0, 5);
        if (!rows.length) return '';
        return `
            <section class="panel-section">
                <div class="hud-mono hud-muted" style="font-size:11px;letter-spacing:0.18em;margin-bottom:8px;">AUDIT CHALLENGES</div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    ${rows.map((r) => `
                        <div class="hud-card" style="padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:12px;">
                            <div>
                                <div style="font-size:12px;font-weight:600;">Challenge #${escapeHTML(r.id)} · type ${escapeHTML(String(r.type))}</div>
                                <div class="hud-mono hud-muted" style="font-size:10px;">issued ${escapeHTML(formatTime(r.issued_at))}</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:12px;font-weight:700;color:${r.passed ? '#4ade80' : '#f87171'};">${r.passed ? 'PASSED' : 'MISSED'}</div>
                                <div class="hud-mono hud-muted" style="font-size:10px;">${r.responded_at ? 'responded ' + escapeHTML(formatTime(r.responded_at)) : 'no response'}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }

    /* The legacy page still owns the rarity-target picker, the progress ring,
       and the unlock CTA (P2.7 wired the real unlockForContributor flow into
       it directly). Embed it as an iframe below the new native cards so the
       full dashboard surface remains accessible without a redirect. */
    _renderLegacyEmbed() {
        return `
            <section class="panel-section" style="margin-top:6px;">
                <div class="hud-mono hud-muted" style="font-size:11px;letter-spacing:0.18em;margin-bottom:8px;">UNLOCK + PROGRESS</div>
                <div style="position:relative;width:100%;min-height:560px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;">
                    <iframe
                        class="dashboard-legacy-frame"
                        src="/pages/node-dashboard.html"
                        title="Compute Progress"
                        style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:dark;"
                        allow="clipboard-write"
                        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                    ></iframe>
                </div>
            </section>
        `;
    }

    async onMount() {
        // Re-render on wallet state change so connect/disconnect from the
        // shell header drives the panel without a manual reload.
        const unsub = on(E.WALLET_CHANGED, async () => {
            this._attestations = null;
            this._auditChallenges = null;
            this.rerender();
            this._wire();
            await this._refresh();
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });

        this._wire();

        const s = wallet.getStatus();
        if (!s.connected) return;

        await this._refresh();

        // Refresh on interval. AbortSignal kills the timer on unmount so we
        // don't keep polling when the panel is closed.
        this._refreshTimer = setInterval(() => {
            const cur = wallet.getStatus();
            if (cur.connected) this._refresh();
        }, REFRESH_INTERVAL_MS);
        this._abort.signal.addEventListener('abort', () => {
            if (this._refreshTimer) clearInterval(this._refreshTimer);
        }, { once: true });

        // Mirror parent wallet sessionStorage into the legacy iframe once it
        // loads — same trick the _stub.js iframe wrapper uses, simplified for
        // this single embed. Without this, the iframe's own walletChanged
        // listener never fires and the embedded UI stays on the connect prompt.
        const frame = this.root?.querySelector('.dashboard-legacy-frame');
        if (frame) {
            const WALLET_KEYS = ['walletConnected', 'walletAddress', 'walletChain', 'walletType', 'dexhero_wallet_base'];
            const mirror = () => {
                try {
                    const store = frame.contentWindow?.sessionStorage;
                    if (!store) return;
                    WALLET_KEYS.forEach((k) => {
                        const v = window.sessionStorage.getItem(k);
                        if (v != null) store.setItem(k, v);
                        else store.removeItem(k);
                    });
                    frame.contentWindow.dispatchEvent(new Event('walletChanged'));
                } catch {}
            };
            frame.addEventListener('load', () => setTimeout(mirror, 80), { signal: this.signal });
        }
    }

    _wire() {
        this.root?.querySelector('[data-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });
    }

    async _refresh() {
        const s = wallet.getStatus();
        if (!s.connected || !s.address) return;
        const w = encodeURIComponent(s.address.toLowerCase());
        const dq = this._dexheroId ? `&dexheroId=${encodeURIComponent(this._dexheroId)}` : '';

        // Two endpoints in parallel. Each captures its own error so a 5xx on
        // one doesn't blank the other half of the dashboard.
        const [attRes, chRes] = await Promise.allSettled([
            fetch(`/api/node/attestations?wallet=${w}${dq}`).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
            fetch(`/api/node/audit-challenges?wallet=${w}`).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
        ]);

        this._attestations = attRes.status === 'fulfilled'
            ? attRes.value
            : { error: attRes.reason?.message || 'fetch failed' };
        this._auditChallenges = chRes.status === 'fulfilled'
            ? chRes.value
            : { error: chRes.reason?.message || 'fetch failed' };

        // Avoid a full rerender (would tear down the legacy iframe and lose
        // its session). Patch the summary + lists in place.
        const root = this.root;
        if (!root) return;
        // Simplest path: full rerender, but stash the iframe's current src
        // beforehand so we don't reload it from scratch. The iframe's load
        // event already fired once; replacing the whole DOM swaps in a fresh
        // node which would trigger another fetch. Practical compromise: only
        // replace the non-iframe sections.
        const summary = root.querySelector('section.panel-section'); // the first
        // Easier maintenance: rerender, accept the iframe reload. 30s cadence
        // → at most ~120 reloads/hr/user, all same-origin and cached.
        this.rerender();
        this._wire();
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sumMinutesLastWindow(attestations, windowMs) {
    if (!Array.isArray(attestations) || !attestations.length) return 0;
    const cutoff = Date.now() - windowMs;
    // total_minutes is monotonic on-chain — the delta between newest-in-window
    // and oldest-in-window approximates the credits earned in this window.
    const inWindow = attestations.filter((r) => {
        const ts = Date.parse(r.timestamp || '');
        return Number.isFinite(ts) && ts >= cutoff;
    });
    if (!inWindow.length) return 0;
    // attestations are returned newest-first by the endpoint.
    const newest = Number(inWindow[0].total_minutes) || 0;
    const oldest = Number(inWindow[inWindow.length - 1].total_minutes) || 0;
    return Math.max(0, newest - oldest);
}

function formatTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (Number.isNaN(+d)) return iso;
    return d.toLocaleString();
}

function shortHash(h) {
    if (!h) return '--';
    return h.slice(0, 6) + '…' + h.slice(-4);
}
