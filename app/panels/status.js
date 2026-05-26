// app/panels/status.js — public service status page.
//
// Reads /api/health (web service liveness + worker_heartbeat freshness +
// supabase reachability + monad indexer cursor) and renders the result.
// Polls every 30s while the panel is open.
//
// Pairs with the standalone status.dexhero.com (StatusPage.io / equivalent)
// hosted by ops; this in-app version surfaces the same data without a
// third-party dependency, useful when the StatusPage itself is down.

import { Panel } from '../ui/panel.js';

function _fmtAge(sec) {
    if (sec == null) return '—';
    if (sec < 60)   return `${Math.round(sec)}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h ago`;
    return `${(sec / 86400).toFixed(1)}d ago`;
}

function _dot(state) {
    const cls = { ok: 'live', degraded: 'idle', down: 'idle', unknown: 'idle' }[state] || 'idle';
    const color = { ok: 'var(--acc-ok,#22c55e)', degraded: 'var(--acc-warn,#f59e0b)', down: 'var(--acc-err,#ef4444)' }[state] || 'var(--ink-3)';
    return `<span class="hud-dot hud-dot--${cls}" style="background:${color};"></span>`;
}

function _row(label, state, detail) {
    return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--rule);">
            ${_dot(state)}
            <div style="flex:1;min-width:0;">
                <div class="hud-display" style="font-size:13px;">${label}</div>
                <div class="hud-label" style="font-size:11px;">${detail}</div>
            </div>
            <div class="hud-label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.2em;">${state}</div>
        </div>`;
}

export default class StatusPanel extends Panel {
    static id        = 'status';
    static variant   = 'right';
    static width     = 560;
    static title     = 'Service Status';
    static titleBreadcrumb = ['STATUS'];
    static stageMode = 'dim';

    constructor(params) {
        super(params);
        this.health = null;
        this.error  = null;
        this._poll  = null;
    }

    render() {
        if (this.error) {
            return `<section class="panel-section">
                <div class="hud-display" style="font-size:14px;color:var(--acc-err,#ef4444);">Status feed unavailable</div>
                <div class="hud-label" style="margin-top:8px;font-size:11px;line-height:1.6;">${this._esc(this.error)}</div>
                <div class="hud-label" style="margin-top:8px;font-size:11px;line-height:1.6;">If this persists, check <a href="https://status.dexhero.com" style="color:var(--ink-1);text-decoration:underline;">status.dexhero.com</a> (the third-party status page).</div>
            </section>`;
        }
        if (!this.health) {
            return `<div class="panel-state"><div class="hud-spin"></div><div>Loading service status…</div></div>`;
        }
        const h = this.health;

        const overall = h.ok === true ? 'ok'
                      : h.ok === false ? 'down'
                      : 'unknown';
        const overallLabel = overall === 'ok' ? 'All systems operational'
                          : overall === 'down' ? 'Some systems degraded'
                          : 'Status unknown';

        // Per-component states
        const supabaseState = h.supabase?.ok === false ? 'down' : (h.supabase?.ok === true ? 'ok' : 'unknown');
        const supabaseDetail = h.supabase?.ok === false ? (h.supabase.error || 'unreachable')
                             : h.supabase?.ok === true ? `latency ${h.supabase.latencyMs ?? '—'}ms`
                             : 'probe pending';

        const monadState = h.monad?.dark === true ? 'down'
                         : h.monad?.dark === false ? 'ok'
                         : (h.monad?.configured ? 'unknown' : 'unknown');
        const monadDetail = h.monad?.configured === false ? 'not configured'
                          : h.monad?.dark ? `cursor stalled (last tick ${_fmtAge(h.monad.lastTickAgoSec)})`
                          : `cursor advancing — last tick ${_fmtAge(h.monad?.lastTickAgoSec)}`;

        const workerRows = (h.workers?.workers || []).map((w) =>
            _row(`Worker · ${w.name}`,
                w.stale ? 'down' : 'ok',
                w.stale ? `last heartbeat ${_fmtAge(w.ageSec)} (stale > ${Math.round(2 * (h.workers?.poll_interval_ms || 300_000) / 1000)}s)`
                        : `last heartbeat ${_fmtAge(w.ageSec)} · ${w.status || 'idle'}`)).join('');

        // Server's /api/health response field stays `hot_wallet` for back-
        // compat — it reports on the Deploy Wallet (the operational hot
        // key signing every DexHero deploy + relay-mint).
        const deployWalletState = h.hot_wallet?.ok === true ? 'ok' : 'down';
        const deployWalletDetail = h.hot_wallet?.ok === true
            ? `${h.hot_wallet.balance_eth ?? '—'} ETH (≥ ${h.hot_wallet.threshold_eth ?? '—'})`
            : (h.hot_wallet?.reason || 'below threshold');

        return `
            <section class="panel-section">
                <div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:2px solid var(--rule);">
                    ${_dot(overall)}
                    <div style="flex:1;">
                        <div class="hud-display" style="font-size:18px;">${overallLabel}</div>
                        <div class="hud-label" style="font-size:11px;">git ${this._esc((h.git || '').slice(0, 7) || '—')} · uptime ${_fmtAge(h.uptime ? Date.now() / 1000 - h.uptime : null)} · ${(new Date()).toLocaleTimeString()}</div>
                    </div>
                </div>
                ${_row('Web service',           h.uptime ? 'ok' : 'unknown', `Render web · v${h.version || '—'}`)}
                ${_row('Database (Supabase)',  supabaseState, supabaseDetail)}
                ${_row('Monad indexer',        monadState, monadDetail)}
                ${workerRows}
                ${_row('Deploy Wallet',        deployWalletState, deployWalletDetail)}
                ${_row('Sentry',               h.sentry?.enabled ? 'ok' : 'unknown', h.sentry?.enabled ? 'reporting enabled' : 'reporting disabled')}
            </section>
            <section class="panel-section" style="text-align:center;">
                <div class="hud-label" style="font-size:11px;">Refreshes every 30 seconds. For incident history + scheduled maintenance, see <a href="https://status.dexhero.com" style="color:var(--ink-1);text-decoration:underline;">status.dexhero.com</a>.</div>
                <button class="hud-btn hud-btn--sm" data-status-refresh style="margin-top:10px;">Refresh now</button>
            </section>
        `;
    }

    async onMount() {
        await this._reload();
        this._poll = setInterval(() => { this._reload().catch(() => {}); }, 30_000);
        this._wire();
    }

    onUnmount() {
        if (this._poll) clearInterval(this._poll);
        this._poll = null;
    }

    _wire() {
        this.root?.querySelector('[data-status-refresh]')?.addEventListener('click',
            () => { this._reload().catch(() => {}); }, { signal: this.signal });
    }

    async _reload() {
        try {
            const r = await fetch('/api/health');
            // /api/health returns 503 when degraded; we still parse the body.
            this.health = await r.json();
            this.error  = null;
        } catch (e) {
            this.error  = e.message;
            this.health = null;
        }
        this.rerender();
        this._wire();
    }

    _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
}
