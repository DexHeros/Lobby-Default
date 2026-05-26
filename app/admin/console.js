// app/admin/console.js — V3Labs operator console panel.
//
// Routes via #/admin (panel id "admin"). RBAC-gated server-side: every action
// is signed by the connected operator wallet and audited in
// `operator_audit_log`. The UI is a thin client over the /api/admin/* endpoints.

import { Panel, escapeHTML, fmtAddress } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { buildHealthRow } from './health-row.js';

// Idempotent stylesheet load for the health-row component.
(() => {
    if (typeof document === 'undefined') return;
    const href = '/styles/admin-health.css';
    if (document.querySelector(`link[data-admin-style][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.adminStyle = '1';
    document.head.appendChild(link);
})();

export default class AdminConsolePanel extends Panel {
    static id        = 'admin';
    static variant   = 'right';
    static width     = 720;
    static title     = 'Operator Console';
    static titleBreadcrumb = ['ADMIN', 'OPERATOR'];
    static stageMode = 'dim';

    constructor(params) {
        super(params);
        this.tab = params.tab || 'health';      // 'health' | 'sessions' | 'hosts' | 'titles' | 'partners' | 'audit' | 'operators'
        this.regional = null;
        this.activeSessions = [];
        this.activeHosts = [];
        // T2-02: filter mode for hosts tab. '' = all online, 'pending' = host_approved IS NULL.
        this.hostsFilter = params.hostsFilter || '';
        this.titles = null;          // null until first load
        this.partners = null;
        this.partnerStateFilter = ''; // '' = pending scope (default)
        this.audit = null;
        this.auditPage = 1;
        this.auditOperator = '';
        this.auditAction = '';
        // T2-01: operators tab state
        this.operators = null;
    }

    render() {
        const w = wallet.getStatus();
        if (!w.connected) {
            return `<div class="panel-state"><div class="panel-state__title">Connect operator wallet</div><button class="hud-btn hud-btn--primary" data-connect>Connect</button></div>`;
        }
        const tabs = ['health', 'fleet', 'sessions', 'hosts', 'titles', 'partners', 'audit', 'operators'];
        const tabBar = tabs.map((t) => `
            <button class="hud-btn hud-btn--sm ${t === this.tab ? 'is-active' : ''}" data-tab="${t}">${t}</button>
        `).join('');

        return `
            <div data-health-row-slot></div>
            <section class="panel-section" style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div class="hud-display" style="font-size:14px;">${fmtAddress(w.address)}</div>
                    <div class="hud-label">Operator console — actions are signed + audit-logged</div>
                </div>
                <div style="display:flex;gap:6px;">${tabBar}</div>
            </section>
            <div data-tab-body>${this._renderTabBody()}</div>
        `;
    }

    _mountHealthRow() {
        const slot = this.root?.querySelector('[data-health-row-slot]');
        if (slot && !slot._mounted) {
            slot.appendChild(buildHealthRow());
            slot._mounted = true;
        }
    }

    _renderTabBody() {
        switch (this.tab) {
            case 'health':    return this._renderHealth();
            case 'fleet':     return this._renderFleet();
            case 'sessions':  return this._renderSessions();
            case 'hosts':     return this._renderHosts();
            case 'titles':    return this._renderTitles();
            case 'partners':  return this._renderPartners();
            case 'audit':     return this._renderAudit();
            case 'operators': return this._renderOperators();
            default:          return '';
        }
    }

    /** Tier 4.3 — operator fleet console.
     *  Four sections rendered top-to-bottom:
     *    (1) summary KPIs + alert banners
     *    (2) worker health row
     *    (3) per-host table with smoke-layer chips
     *    (4) recent smokes timeline
     *  Auto-refreshes every 8 s via _loadFleet. Empty states are
     *  intentional — when the fleet has 0 hosts, the UI shows
     *  '0 hosts reporting' rather than an error or an empty card. */
    _renderFleet() {
        if (!this.fleet) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading fleet view…</div></div>`;
        if (this.fleet.authError) {
            const { status, error } = this.fleet.authError;
            const w = wallet.getStatus();
            return `
                <section class="panel-section">
                    <div style="padding:14px 16px;border:1px solid #f87171;background:rgba(248,113,113,0.08);border-radius:6px;">
                        <div style="font-size:13px;color:#fca5a5;font-weight:600;">Operator access required (HTTP ${status})</div>
                        <div style="font-size:12px;color:var(--ink-2);margin-top:6px;line-height:1.6;">
                            Server says: <code>${escapeHTML(error || 'forbidden')}</code><br/>
                            Connected wallet: <code style="font-family:var(--font-mono,monospace);">${escapeHTML(w.address || 'none')}</code><br/>
                            This wallet isn't in <code>operator_roles</code>. Either reconnect with the founding admin wallet
                            (<code>FOUNDING_ADMIN_WALLETS</code> on Render — default <code>0x11A6B77fb2993C9eB6D7b282d8AA5e2559DB20Ee</code>),
                            or have an existing operator grant your wallet a role via the <b>operators</b> tab + <code>POST /api/admin/role/grant</code>.
                        </div>
                    </div>
                </section>`;
        }
        const { summary = {}, workers = [], hosts = [], smokes = [] } = this.fleet;

        // ── Alert banners (top-of-tab) ─────────────────────────────
        const alerts = [];
        const staleWorkers = workers.filter(w => w.status === 'stale' || w.status === 'dead' || w.status === 'missing');
        if (staleWorkers.length > 0) {
            alerts.push(`<div style="padding:10px 12px;border:1px solid #f87171;background:rgba(248,113,113,0.08);border-radius:6px;margin-bottom:8px;font-size:12px;color:#fca5a5;">
                <b>${staleWorkers.length} worker${staleWorkers.length === 1 ? '' : 's'} not heartbeating:</b>
                ${staleWorkers.map(w => escapeHTML(w.name)).join(', ')}
                — check Render dashboard.
            </div>`);
        }
        if (summary.hosts_online === 0 && summary.sessions_active > 0) {
            alerts.push(`<div style="padding:10px 12px;border:1px solid #f87171;background:rgba(248,113,113,0.08);border-radius:6px;margin-bottom:8px;font-size:12px;color:#fca5a5;">
                <b>Capacity gap:</b> ${summary.sessions_active} active session${summary.sessions_active === 1 ? '' : 's'} but 0 hosts reporting online.
            </div>`);
        }
        if (typeof summary.smoke_pass_rate === 'number' && summary.smoke_pass_rate < 80 && summary.smokes_24h >= 5) {
            alerts.push(`<div style="padding:10px 12px;border:1px solid #fbbf24;background:rgba(251,191,36,0.08);border-radius:6px;margin-bottom:8px;font-size:12px;color:#fbbf24;">
                <b>Smoke pass rate ${summary.smoke_pass_rate}%</b> across ${summary.smokes_24h} smokes (24 h) — investigate fleet-wide regression.
            </div>`);
        }

        // ── (1) Summary KPI strip ──────────────────────────────────
        const kpi = (label, value, color = 'var(--ink-1)') => `
            <div style="flex:1;padding:10px 12px;border:1px solid var(--surf-3,#333);border-radius:6px;text-align:center;">
                <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-3);">${escapeHTML(label)}</div>
                <div style="font-size:22px;color:${color};font-family:var(--font-mono,monospace);margin-top:4px;">${escapeHTML(String(value))}</div>
            </div>`;
        const summaryStrip = `
            <div style="display:flex;gap:8px;margin-bottom:12px;">
                ${kpi('Hosts online',       summary.hosts_online ?? '—')}
                ${kpi('Active sessions',    summary.sessions_active ?? '—')}
                ${kpi('Pending approvals',  summary.pending_approvals ?? '—', summary.pending_approvals > 0 ? '#fbbf24' : 'var(--ink-1)')}
                ${kpi('Smokes (24 h)',      summary.smokes_24h ?? 0)}
                ${kpi('Smoke pass %',
                    typeof summary.smoke_pass_rate === 'number' ? `${summary.smoke_pass_rate}%` : '—',
                    typeof summary.smoke_pass_rate === 'number'
                        ? (summary.smoke_pass_rate >= 90 ? '#4ade80' : summary.smoke_pass_rate >= 70 ? '#fbbf24' : '#f87171')
                        : 'var(--ink-1)')}
            </div>`;

        // ── (2) Worker health row ──────────────────────────────────
        const workerColor = (s) => s === 'stale' || s === 'dead' || s === 'missing' ? '#f87171' : (s === 'alive' ? '#4ade80' : '#fbbf24');
        const workerCell = (w) => `
            <div title="${escapeHTML(w.last_error || w.status || '')}" style="flex:1;min-width:160px;padding:8px 10px;border:1px solid var(--surf-3,#333);border-radius:6px;">
                <div style="font-size:11px;color:${workerColor(w.status)};letter-spacing:0.12em;text-transform:uppercase;">● ${escapeHTML(w.status || 'unknown')}</div>
                <div style="font-size:12px;font-family:var(--font-mono,monospace);margin-top:2px;color:var(--ink-1);">${escapeHTML(w.name || '?')}</div>
                <div style="font-size:10.5px;color:var(--ink-3);margin-top:2px;">${w.age_seconds != null ? `${w.age_seconds}s ago` : 'no heartbeat'}</div>
            </div>`;
        const workersBlock = workers.length > 0
            ? `<div style="display:flex;flex-wrap:wrap;gap:6px;">${workers.map(workerCell).join('')}</div>`
            : `<div style="padding:10px;color:var(--ink-3);font-size:12px;">No workers reporting yet — first heartbeat hasn't landed. Check Render dashboard for worker startup logs.</div>`;

        // ── (3) Host table ─────────────────────────────────────────
        const layerChip = (ok, label) => `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-family:var(--font-mono,monospace);background:${ok ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.12)'};color:${ok ? '#4ade80' : '#f87171'};margin-right:3px;">${escapeHTML(label)}</span>`;
        const hostRows = hosts.map((h) => {
            const layers = [
                layerChip(h.probe.tcp_ok,            'TCP'),
                layerChip(h.probe.ws_ok,             'WS'),
                layerChip(h.probe.webrtc_connected,  'RTC'),
                ...(h.probe.rb_frames > 0 ? [layerChip(true,  `DEC ${h.probe.rb_fps}fps`)] :
                    (h.probe.rb_m2p_p99 > 0 ? [layerChip(false, 'DEC')] : [])),
            ].join('');
            const m2p = h.probe.rb_m2p_p99 > 0 ? `${h.probe.rb_m2p_p99}ms${h.probe.rb_m2p_p99 > 40 ? ' ⚠' : ''}` : '—';
            return `
                <tr>
                    <td style="font-family:var(--font-mono,monospace);">${escapeHTML(fmtAddress(h.wallet))}</td>
                    <td>${escapeHTML(h.region || '—')}</td>
                    <td>${escapeHTML(h.gpu_tier || '—')}</td>
                    <td>${h.is_online ? '<span style="color:#4ade80;">●</span>' : '<span style="color:var(--ink-3);">○</span>'}</td>
                    <td>${escapeHTML(h.seats || '—')}</td>
                    <td style="white-space:nowrap;">${layers || '<span style="color:var(--ink-3);">no probe yet</span>'}</td>
                    <td style="font-family:var(--font-mono,monospace);">${escapeHTML(m2p)}</td>
                    <td style="font-size:10.5px;color:var(--ink-3);">${h.last_seen ? new Date(h.last_seen).toLocaleTimeString() : '—'}</td>
                </tr>`;
        }).join('');
        const hostsBlock = `
            <table style="width:100%;font-size:12px;border-collapse:collapse;">
                <thead><tr style="text-align:left;color:var(--ink-3);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;">
                    <th>Host</th><th>Region</th><th>GPU</th><th>On</th><th>Seats</th><th>Probe</th><th>m2p p99</th><th>Last seen</th>
                </tr></thead>
                <tbody>${hostRows || `<tr><td colspan="8" style="text-align:center;color:var(--ink-3);padding:14px;">No hosts reporting in the last 5 min</td></tr>`}</tbody>
            </table>`;

        // ── (4) Recent smokes ──────────────────────────────────────
        const smokeRow = (s) => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--surf-3,#222);font-size:12px;">
                <span style="color:var(--ink-3);font-family:var(--font-mono,monospace);font-size:10.5px;width:80px;">${s.ran_at ? new Date(s.ran_at).toLocaleTimeString() : '—'}</span>
                <span style="font-family:var(--font-mono,monospace);width:120px;">${escapeHTML(fmtAddress(s.host_wallet))}</span>
                <span style="display:flex;gap:3px;flex:1;">
                    ${layerChip(s.pre_flight_passed,    'PRE')}
                    ${layerChip(s.tcp_ok,                'TCP')}
                    ${layerChip(s.ws_ok,                 'WS')}
                    ${layerChip(s.webrtc_ok,             'RTC')}
                    ${s.rb_attempted ? layerChip(s.rb_frames > 0, `DEC ${s.rb_fps || 0}fps`) : ''}
                </span>
                ${s.rb_m2p_p99 > 0 ? `<span style="font-family:var(--font-mono,monospace);font-size:10.5px;color:${s.rb_m2p_p99 > 40 ? '#fbbf24' : 'var(--ink-2)'};">m2p ${s.rb_m2p_p99}ms</span>` : ''}
            </div>`;
        const smokesBlock = smokes.length > 0
            ? smokes.map(smokeRow).join('')
            : `<div style="padding:10px;color:var(--ink-3);font-size:12px;">No smoke results in cache. Smokes are recorded ephemerally per server uptime; results appear here ~5 s after a host goes online.</div>`;

        return `
            ${alerts.join('')}
            <section class="panel-section">
                <div class="hud-label" style="margin-bottom:6px;">Fleet summary</div>
                ${summaryStrip}
            </section>
            <section class="panel-section">
                <div class="hud-label" style="margin-bottom:6px;">Worker health</div>
                ${workersBlock}
            </section>
            <section class="panel-section">
                <div class="hud-label" style="margin-bottom:6px;">Hosts (${hosts.length} reporting)</div>
                ${hostsBlock}
            </section>
            <section class="panel-section">
                <div class="hud-label" style="margin-bottom:6px;">Recent smokes (${smokes.length})</div>
                <div style="border:1px solid var(--surf-3,#333);border-radius:4px;">${smokesBlock}</div>
            </section>`;
    }

    _renderHealth() {
        if (!this.regional) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading regional health…</div></div>`;
        const rows = (this.regional.regions || []).map((r) => `
            <tr>
                <td>${escapeHTML(r.region)}</td>
                <td>${r.hosts}</td>
                <td>${r.freeSeats}</td>
                <td>${r.sessions}</td>
                <td>${r.crossRegionSessions}</td>
                <td>${r.crossRegionSessions > 0 && r.sessions > 0 ? Math.round((r.crossRegionSessions / r.sessions) * 100) + '%' : '—'}</td>
            </tr>`).join('');
        return `
            <section class="panel-section">
                <table style="width:100%;font-family:var(--font-mono);font-size:12px;">
                    <thead><tr style="text-align:left;color:var(--ink-3);">
                        <th>Region</th><th>Hosts</th><th>Free seats</th><th>Sessions</th><th>x-region</th><th>x-region %</th>
                    </tr></thead>
                    <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:var(--ink-3);padding:14px;">No regions</td></tr>`}</tbody>
                </table>
            </section>`;
    }

    _renderSessions() {
        const rows = this.activeSessions.map((s) => `
            <tr>
                <td>${escapeHTML(s.session_id.slice(0, 16))}…</td>
                <td>${escapeHTML(s.status)}</td>
                <td>${escapeHTML(s.host_region_code || '—')}</td>
                <td>${s.cross_region ? '✓' : ''}</td>
                <td>${escapeHTML(fmtAddress(s.node_wallet))}</td>
                <td>${escapeHTML(fmtAddress(s.player_wallet))}</td>
                <td>
                    <button class="hud-btn hud-btn--sm" data-session-end="${escapeHTML(s.session_id)}">End</button>
                    <button class="hud-btn hud-btn--sm" data-session-reassign="${escapeHTML(s.session_id)}">Reassign</button>
                </td>
            </tr>`).join('');
        return `<section class="panel-section">
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);"><th>Session</th><th>Status</th><th>Region</th><th>x-rgn</th><th>Host</th><th>Player</th><th>Actions</th></tr></thead>
                <tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:var(--ink-3);padding:14px;">No active sessions</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    _renderHosts() {
        // T2-02: filter bar — view all hosts OR just the pending-approval queue.
        const filterBar = `
            <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
                <span class="hud-label">Filter:</span>
                ${[
                    { val: '',         label: 'all online' },
                    { val: 'pending',  label: 'pending approval' },
                    { val: 'approved', label: 'approved' },
                    { val: 'rejected', label: 'rejected' },
                ].map((f) => `
                    <button class="hud-btn hud-btn--sm ${f.val === this.hostsFilter ? 'is-active' : ''}" data-hosts-filter="${escapeHTML(f.val)}">${f.label}</button>
                `).join('')}
            </div>`;

        const approvalCell = (h) => {
            const status = (h.host_approved === true)  ? '<span style="color:var(--acc-ok,#22c55e);">approved</span>'
                         : (h.host_approved === false) ? '<span style="color:var(--acc-err,#ef4444);">rejected</span>'
                         : '<span style="color:var(--acc-warn,#f59e0b);">pending</span>';
            const showApprove = (h.host_approved !== true);
            const showReject  = (h.host_approved !== false);
            return `${status} ${showApprove ? `<button class="hud-btn hud-btn--sm" data-host-approve="${escapeHTML(h.wallet_address)}">Approve</button>` : ''} ${showReject ? `<button class="hud-btn hud-btn--sm" data-host-reject="${escapeHTML(h.wallet_address)}">Reject</button>` : ''}`;
        };

        const rows = this.activeHosts.map((h) => `
            <tr>
                <td>${escapeHTML(fmtAddress(h.wallet_address))}</td>
                <td>${escapeHTML(h.region_code || '—')}</td>
                <td>${h.gpu_tier ?? '—'}</td>
                <td>${h.benchmark_score ?? '—'}${h.benchmark_flagged ? ' ⚠' : ''}</td>
                <td>${h.relay_probe_rtt_ms != null ? Math.round(h.relay_probe_rtt_ms) + 'ms' : '—'}</td>
                <td>${h.seats_in_use || 0} / ${h.available_seats || 1}</td>
                <td>${approvalCell(h)}</td>
                <td><button class="hud-btn hud-btn--sm" data-host-ban="${escapeHTML(h.wallet_address)}">Ban</button></td>
            </tr>`).join('');
        return `<section class="panel-section">
            ${filterBar}
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);">
                    <th>Host</th><th>Region</th><th>Tier</th><th>Bench</th><th>RTT</th><th>Seats</th><th>Approval</th><th>Actions</th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="8" style="text-align:center;color:var(--ink-3);padding:14px;">No hosts</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    // T2-01: Operators tab — list operator_roles, grant/revoke. Server endpoints
    // already exist (/api/admin/role/{list,grant,revoke}). UI just calls them.
    _renderOperators() {
        if (this.operators == null) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading operators…</div></div>`;
        const rows = this.operators.map((o) => `
            <tr>
                <td>${escapeHTML(fmtAddress(o.wallet_address))}</td>
                <td>${escapeHTML(o.role)}</td>
                <td>${escapeHTML(fmtAddress(o.granted_by || '—'))}</td>
                <td>${o.granted_at ? new Date(o.granted_at).toLocaleString() : '—'}</td>
                <td>${escapeHTML(o.notes || '—')}</td>
                <td><button class="hud-btn hud-btn--sm" data-role-revoke="${escapeHTML(o.wallet_address)}">Revoke</button></td>
            </tr>`).join('');
        return `<section class="panel-section">
            <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap;">
                <input data-grant-wallet placeholder="0x… wallet" style="font-family:var(--font-mono);font-size:11px;padding:4px 6px;flex:1 1 220px;">
                <select data-grant-role style="font-family:var(--font-mono);font-size:11px;padding:4px 6px;">
                    <option value="viewer">viewer</option>
                    <option value="responder">responder</option>
                    <option value="admin" selected>admin</option>
                    <option value="superadmin">superadmin</option>
                </select>
                <input data-grant-notes placeholder="optional note" style="font-family:var(--font-mono);font-size:11px;padding:4px 6px;flex:1 1 160px;">
                <button class="hud-btn hud-btn--sm hud-btn--primary" data-role-grant>Grant</button>
            </div>
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);">
                    <th>Wallet</th><th>Role</th><th>Granted by</th><th>At</th><th>Notes</th><th></th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:var(--ink-3);padding:14px;">No operators</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    _renderTitles() {
        if (!this.titles) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading title blocklist…</div></div>`;
        const rows = this.titles.map((t) => {
            const target = t.steam_app_id ? `Steam app ${t.steam_app_id}` : `Game ${String(t.game_id || '').slice(0, 12)}…`;
            const dataAttr = t.steam_app_id ? `data-steam-app="${escapeHTML(String(t.steam_app_id))}"` : `data-game-id="${escapeHTML(String(t.game_id))}"`;
            return `
                <tr>
                    <td>${escapeHTML(target)}</td>
                    <td>${escapeHTML(t.reason || '')}</td>
                    <td>${escapeHTML(fmtAddress(t.blocked_by))}</td>
                    <td>${t.blocked_at ? new Date(t.blocked_at).toLocaleString() : '—'}</td>
                    <td><button class="hud-btn hud-btn--sm" data-title-unblock ${dataAttr}>Unblock</button></td>
                </tr>`;
        }).join('');
        return `<section class="panel-section">
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);">
                    <th>Target</th><th>Reason</th><th>Blocked by</th><th>At</th><th></th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:var(--ink-3);padding:14px;">No titles blocked</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    _renderPartners() {
        if (!this.partners) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading partner applications…</div></div>`;
        const filterBar = `
            <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
                <span class="hud-label">Filter:</span>
                ${['', 'submitted', 'conformance_passed', 'curation_voting', 'approved', 'rejected'].map((s) => `
                    <button class="hud-btn hud-btn--sm ${s === this.partnerStateFilter ? 'is-active' : ''}" data-partner-filter="${escapeHTML(s)}">${s || 'pending'}</button>
                `).join('')}
            </div>`;
        const rows = this.partners.map((p) => `
            <tr>
                <td>${escapeHTML(p.title_name)}</td>
                <td>${escapeHTML(p.studio_name)}</td>
                <td>${escapeHTML(fmtAddress(p.studio_wallet))}</td>
                <td>${escapeHTML(p.title_engine || '—')}</td>
                <td>${escapeHTML(p.state)}</td>
                <td>${p.conformance_score ?? '—'}</td>
                <td>
                    <button class="hud-btn hud-btn--sm" data-partner-approve="${escapeHTML(p.id)}">Approve</button>
                    <button class="hud-btn hud-btn--sm" data-partner-reject="${escapeHTML(p.id)}">Reject</button>
                </td>
            </tr>`).join('');
        return `<section class="panel-section">
            ${filterBar}
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);">
                    <th>Title</th><th>Studio</th><th>Wallet</th><th>Engine</th><th>State</th><th>Score</th><th></th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:var(--ink-3);padding:14px;">No applications match this filter</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    _renderAudit() {
        if (!this.audit) return `<div class="panel-state"><div class="hud-spin"></div><div>Loading audit log…</div></div>`;
        const filterBar = `
            <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
                <input type="text" class="hud-input" data-audit-operator placeholder="Operator wallet (0x…)" value="${escapeHTML(this.auditOperator)}" style="font-family:var(--font-mono);font-size:11px;width:240px;">
                <input type="text" class="hud-input" data-audit-action placeholder="Action prefix (e.g. host.)" value="${escapeHTML(this.auditAction)}" style="font-family:var(--font-mono);font-size:11px;width:160px;">
                <button class="hud-btn hud-btn--sm" data-audit-search>Search</button>
                <button class="hud-btn hud-btn--sm" data-audit-prev ${this.auditPage <= 1 ? 'disabled' : ''}>Prev</button>
                <span class="hud-label">page ${this.auditPage}</span>
                <button class="hud-btn hud-btn--sm" data-audit-next>Next</button>
            </div>`;
        const rows = this.audit.map((a) => `
            <tr>
                <td>${a.occurred_at ? new Date(a.occurred_at).toLocaleString() : '—'}</td>
                <td>${escapeHTML(fmtAddress(a.operator_wallet))}</td>
                <td>${escapeHTML(a.action)}</td>
                <td>${escapeHTML(a.target_type || '—')}</td>
                <td>${escapeHTML(a.target_id ? String(a.target_id).slice(0, 18) : '—')}</td>
            </tr>`).join('');
        return `<section class="panel-section">
            ${filterBar}
            <table style="width:100%;font-family:var(--font-mono);font-size:11px;">
                <thead><tr style="text-align:left;color:var(--ink-3);">
                    <th>When</th><th>Operator</th><th>Action</th><th>Target type</th><th>Target id</th>
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:var(--ink-3);padding:14px;">No audit rows match</td></tr>`}</tbody>
            </table>
        </section>`;
    }

    async onMount() {
        this._wire();
        this._mountHealthRow();
        const w = wallet.getStatus();
        if (w.connected) await this._loadCurrent();

        // Re-render when the wallet's state changes. Without this, the
        // 'Connect operator wallet' branch sticks even after the user
        // approves the MetaMask popup — the panel mounts once at #/admin
        // and never sees the wallet event. Same pattern host.js +
        // profile.js use elsewhere. Aborts cleanly on panel teardown
        // via this.signal.
        const onWalletEvent = () => {
            // Drop any in-flight session-login promise — the new wallet
            // needs its own session. The cookie itself stays set; the
            // wallet-mismatch check inside _ensureAdminSession will force
            // a fresh login on the next read.
            this._sessionLoginPromise = null;
            // Clear the sticky-failure cache so a fresh wallet gets a fair
            // chance to log in (otherwise a wallet swap from a non-operator
            // to an operator wallet would silently keep the failed state
            // for up to 60 s).
            this._sessionLoginFailedFor = null;
            // Best-effort: clear the prior wallet's server-side session so
            // a stale cookie can't outlive the wallet that issued it.
            // Fire-and-forget — server is idempotent on missing cookies.
            fetch('/api/admin/session/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
            try { this.rerender(); this._wire(); } catch {}
            const cur = wallet.getStatus();
            if (cur.connected) this._loadCurrent().catch(() => {});
        };
        window.addEventListener('walletConnected',      onWalletEvent, { signal: this.signal });
        window.addEventListener('walletChanged',        onWalletEvent, { signal: this.signal });
        window.addEventListener('walletAccountChanged', onWalletEvent, { signal: this.signal });
    }

    _wire() {
        this._mountHealthRow();
        this.root?.querySelector('[data-connect]')?.addEventListener('click', () => {
            try { wallet.connect().catch(() => {}); } catch {}
        }, { signal: this.signal });

        this.root?.querySelectorAll('[data-tab]').forEach((b) => {
            b.addEventListener('click', () => {
                this.tab = b.getAttribute('data-tab');
                this.rerender();
                this._wire();
                this._loadCurrent().catch((e) => console.warn('[admin] load failed:', e));
            }, { signal: this.signal });
        });

        this.root?.querySelectorAll('[data-session-end]').forEach((b) => {
            b.addEventListener('click', () => this._adminPost('/api/admin/session/end', 'session.end', b.getAttribute('data-session-end'), { sessionId: b.getAttribute('data-session-end') }), { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-session-reassign]').forEach((b) => {
            b.addEventListener('click', () => this._adminPost('/api/admin/session/reassign', 'session.reassign', b.getAttribute('data-session-reassign'), { sessionId: b.getAttribute('data-session-reassign') }), { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-host-ban]').forEach((b) => {
            b.addEventListener('click', async () => {
                const reason = prompt('Reason for ban?');
                if (!reason) return;
                this._adminPost('/api/admin/host/ban', 'host.ban', b.getAttribute('data-host-ban'), { wallet: b.getAttribute('data-host-ban'), reason });
            }, { signal: this.signal });
        });
        // T2-02: hosts approval queue filter + approve/reject
        this.root?.querySelectorAll('[data-hosts-filter]').forEach((b) => {
            b.addEventListener('click', () => {
                this.hostsFilter = b.getAttribute('data-hosts-filter') || '';
                this._loadActiveHosts().catch(() => {});
            }, { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-host-approve]').forEach((b) => {
            b.addEventListener('click', async () => {
                const target = b.getAttribute('data-host-approve');
                if (!confirm(`Approve host ${target}?`)) return;
                await this._adminPost('/api/admin/host/approve', 'host.approve', target, { wallet: target });
                this._loadActiveHosts().catch(() => {});
            }, { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-host-reject]').forEach((b) => {
            b.addEventListener('click', async () => {
                const target = b.getAttribute('data-host-reject');
                const reason = prompt('Rejection reason (sent to operator)?');
                if (!reason) return;
                // Server endpoint is /api/admin/host/revoke (sets host_approved=false + notes).
                await this._adminPost('/api/admin/host/revoke', 'host.revoke', target, { wallet: target, notes: reason });
                this._loadActiveHosts().catch(() => {});
            }, { signal: this.signal });
        });

        // T2-01: operators tab grant/revoke
        this.root?.querySelector('[data-role-grant]')?.addEventListener('click', async () => {
            const w  = (this.root.querySelector('[data-grant-wallet]')?.value || '').trim();
            const role = (this.root.querySelector('[data-grant-role]')?.value || '').trim();
            const notes = (this.root.querySelector('[data-grant-notes]')?.value || '').trim();
            if (!/^0x[0-9a-fA-F]{40}$/.test(w)) { alert('Wallet must be 0x + 40 hex.'); return; }
            await this._adminPost('/api/admin/role/grant', 'role.grant', w, { wallet: w, role, notes });
            this.root.querySelector('[data-grant-wallet]').value = '';
            this.root.querySelector('[data-grant-notes]').value  = '';
            this._loadOperators().catch(() => {});
        }, { signal: this.signal });
        this.root?.querySelectorAll('[data-role-revoke]').forEach((b) => {
            b.addEventListener('click', async () => {
                const target = b.getAttribute('data-role-revoke');
                if (!confirm(`Revoke role for ${target}?`)) return;
                await this._adminPost('/api/admin/role/revoke', 'role.revoke', target, { wallet: target });
                this._loadOperators().catch(() => {});
            }, { signal: this.signal });
        });

        // Titles tab (D1)
        this.root?.querySelectorAll('[data-title-unblock]').forEach((b) => {
            b.addEventListener('click', async () => {
                const sa = b.getAttribute('data-steam-app');
                const gi = b.getAttribute('data-game-id');
                if (!confirm('Unblock this title?')) return;
                const target = sa || gi;
                await this._adminPost('/api/admin/title/unblock', 'title.unblock', target,
                    sa ? { steamAppId: Number(sa) } : { gameId: gi });
            }, { signal: this.signal });
        });

        // Partners tab (D2)
        this.root?.querySelectorAll('[data-partner-filter]').forEach((b) => {
            b.addEventListener('click', () => {
                this.partnerStateFilter = b.getAttribute('data-partner-filter') || '';
                this._loadPartners().catch(() => {});
            }, { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-partner-approve]').forEach((b) => {
            b.addEventListener('click', () => {
                const id = b.getAttribute('data-partner-approve');
                const reason = prompt('Approval reason / note?') || '';
                this._adminPost('/api/admin/partner/decide', 'partner.approved', id, { id, decision: 'approved', reason });
            }, { signal: this.signal });
        });
        this.root?.querySelectorAll('[data-partner-reject]').forEach((b) => {
            b.addEventListener('click', () => {
                const id = b.getAttribute('data-partner-reject');
                const reason = prompt('Rejection reason (visible to studio)?');
                if (!reason) return;
                this._adminPost('/api/admin/partner/decide', 'partner.rejected', id, { id, decision: 'rejected', reason });
            }, { signal: this.signal });
        });

        // Audit tab (D3)
        this.root?.querySelector('[data-audit-search]')?.addEventListener('click', () => {
            this.auditOperator = this.root.querySelector('[data-audit-operator]')?.value.trim() || '';
            this.auditAction   = this.root.querySelector('[data-audit-action]')?.value.trim()   || '';
            this.auditPage = 1;
            this._loadAudit().catch(() => {});
        }, { signal: this.signal });
        this.root?.querySelector('[data-audit-prev]')?.addEventListener('click', () => {
            if (this.auditPage <= 1) return;
            this.auditPage -= 1;
            this._loadAudit().catch(() => {});
        }, { signal: this.signal });
        this.root?.querySelector('[data-audit-next]')?.addEventListener('click', () => {
            this.auditPage += 1;
            this._loadAudit().catch(() => {});
        }, { signal: this.signal });
    }

    async _loadCurrent() {
        if (this.tab === 'health')    await this._loadRegional();
        if (this.tab === 'fleet')     await this._loadFleet();
        if (this.tab === 'sessions')  await this._loadActiveSessions();
        if (this.tab === 'hosts')     await this._loadActiveHosts();
        if (this.tab === 'titles')    await this._loadTitles();
        if (this.tab === 'partners')  await this._loadPartners();
        if (this.tab === 'audit')     await this._loadAudit();
        if (this.tab === 'operators') await this._loadOperators();
    }

    /** Tier 4.3 — load all four fleet endpoints in parallel.
     *  Each is an independent _adminFetch so a single failure doesn't
     *  blank the whole tab. Auto-refresh every 30 s while the tab is
     *  open. If the connected wallet isn't an operator, every endpoint
     *  returns 401/403 and we surface a clear message instead of empty
     *  cards. */
    async _loadFleet() {
        const fetchOne = (path) => this._adminFetch(path);
        const [summary, workers, hosts, smokes] = await Promise.all([
            fetchOne('/api/admin/fleet/summary'),
            fetchOne('/api/admin/fleet/workers'),
            fetchOne('/api/admin/fleet/hosts'),
            fetchOne('/api/admin/fleet/smokes'),
        ]);
        const authErr = [summary, workers, hosts, smokes].find(x => x?._authError);
        this.fleet = {
            summary:   summary && !summary._authError ? summary : {},
            workers:   workers?.workers || [],
            hosts:     hosts?.hosts     || [],
            smokes:    smokes?.smokes   || [],
            authError: authErr ? { status: authErr.status, error: authErr.error } : null,
        };
        this.rerender(); this._wire();

        // Idempotent auto-refresh while the fleet tab is active.
        // With the SIWE-style cookie session (1 h TTL), reads carry no
        // per-poll signature — operators see ZERO popups while a tab is
        // open. The lone prompt is the one-shot session login on first
        // admin tab mount (or after a 1 h session expires).
        if (!this._fleetRefreshHandle) {
            this._fleetRefreshHandle = setInterval(() => {
                if (this.tab === 'fleet') this._loadFleet().catch(() => {});
            }, 30_000);
            this._abort?.signal?.addEventListener('abort', () => {
                clearInterval(this._fleetRefreshHandle);
                this._fleetRefreshHandle = null;
            }, { once: true });
        }
    }

    /** SIWE-style admin session bootstrap.
     *
     *  Calls /api/admin/session/whoami first; if no valid cookie exists or
     *  the cookie's wallet doesn't match the currently-connected wallet,
     *  prompts ONE signature on `DexHero session: <wallet> <issuedAt>` and
     *  exchanges it for an HttpOnly session cookie at /api/admin/session/login.
     *
     *  After this runs, every fleet/audit/hosts read just rides the cookie —
     *  no further popups for an hour. Mutations still require a fresh
     *  per-action signature in _adminPost.
     *
     *  Concurrent callers share one promise so a fleet tab firing four
     *  parallel reads only triggers a single sign-in flow.
     */
    async _ensureAdminSession({ force = false } = {}) {
        const w = wallet.getStatus();
        if (!w.connected) return { ok: false, reason: 'not-connected' };
        if (this._sessionLoginPromise) return this._sessionLoginPromise;

        // Sticky failure — once a wallet has been rejected (403 Not an
        // operator, user dismissed the sig popup, signature mismatch, etc.)
        // never auto-retry until the wallet swaps or the user takes an
        // explicit action. The 30 s fleet auto-refresh would otherwise pop
        // a MetaMask request every minute for a non-operator, which is
        // exactly the bug we're fixing. The walletEvent handler in onMount
        // clears this cache on swap.
        const failedFor = this._sessionLoginFailedFor;
        if (failedFor && failedFor.wallet === w.address.toLowerCase() && !force) {
            return failedFor.result;
        }

        this._sessionLoginPromise = (async () => {
            try {
                if (!force) {
                    const r = await fetch('/api/admin/session/whoami', { credentials: 'same-origin' });
                    if (r.ok) {
                        const j = await r.json();
                        if (j.authenticated && j.wallet?.toLowerCase() === w.address.toLowerCase()) {
                            return { ok: true, role: j.role };
                        }
                    }
                }
                const issuedAt = Date.now();
                const msg = `DexHero session: ${w.address.toLowerCase()} ${issuedAt}`;
                const signature = await wallet.signMessage(msg);
                const r = await fetch('/api/admin/session/login', {
                    method:      'POST',
                    credentials: 'same-origin',
                    headers:     { 'content-type': 'application/json' },
                    body:        JSON.stringify({ wallet: w.address, signature, issuedAt }),
                });
                if (r.ok) {
                    const j = await r.json();
                    this._sessionLoginFailedFor = null;
                    return { ok: true, role: j.role };
                }
                let body = null; try { body = await r.json(); } catch {}
                const failResult = { ok: false, status: r.status, error: body?.error || `HTTP ${r.status}` };
                this._sessionLoginFailedFor = { wallet: w.address.toLowerCase(), at: Date.now(), result: failResult };
                return failResult;
            } catch (err) {
                // User rejected the signature popup, or an unexpected error.
                // Cache the failure too so we don't spam re-prompts on
                // auto-refresh — re-check on wallet swap or after 60 s.
                const failResult = { ok: false, error: err?.message || 'login failed' };
                this._sessionLoginFailedFor = { wallet: w.address.toLowerCase(), at: Date.now(), result: failResult };
                return failResult;
            } finally {
                this._sessionLoginPromise = null;
            }
        })();
        return this._sessionLoginPromise;
    }

    /** Cookie-authenticated read fetch. Returns parsed JSON on 200, an
     *  `{ _authError: true, ... }` shape on 401/403, or null on other
     *  errors. Auto-retries ONCE after refreshing the session if the first
     *  call comes back 401/403 — handles the "cookie expired mid-session"
     *  case without silently emptying the panel.
     */
    async _adminFetch(path) {
        const sess = await this._ensureAdminSession();
        if (!sess.ok) return { _authError: true, status: sess.status || 401, error: sess.error || 'sign in required' };
        const r1 = await fetch(path, { credentials: 'same-origin' }).catch(() => null);
        if (r1?.ok) return await r1.json().catch(() => null);
        if (r1 && (r1.status === 401 || r1.status === 403)) {
            const refreshed = await this._ensureAdminSession({ force: true });
            if (!refreshed.ok) {
                return { _authError: true, status: refreshed.status || 401, error: refreshed.error || 'sign in required' };
            }
            const r2 = await fetch(path, { credentials: 'same-origin' }).catch(() => null);
            if (r2?.ok) return await r2.json().catch(() => null);
            if (r2 && (r2.status === 401 || r2.status === 403)) {
                let body = null; try { body = await r2.json(); } catch {}
                return { _authError: true, status: r2.status, error: body?.error || `HTTP ${r2.status}` };
            }
        }
        return null;
    }

    async _loadRegional() {
        const j = await this._adminFetch('/api/admin/health/regional');
        this.regional = j && !j._authError ? j : { regions: [] };
        this.rerender(); this._wire();
    }

    async _loadActiveSessions() {
        const j = await this._adminFetch('/api/admin/sessions');
        this.activeSessions = j && !j._authError ? (j.sessions || []) : [];
        this.rerender(); this._wire();
    }

    async _loadActiveHosts() {
        // T2-02: server-side filter on host_approved status. Without ?filter=
        // server returns the legacy "all online" list (backward-compatible).
        const filterParam = this.hostsFilter ? `?filter=${encodeURIComponent(this.hostsFilter)}` : '';
        const j = await this._adminFetch(`/api/admin/hosts${filterParam}`);
        this.activeHosts = j && !j._authError ? (j.hosts || []) : [];
        this.rerender(); this._wire();
    }

    // T2-01: load operator_roles via /api/admin/role/list (existing endpoint).
    async _loadOperators() {
        const j = await this._adminFetch('/api/admin/role/list');
        this.operators = j && !j._authError ? (j.operators || []) : [];
        this.rerender(); this._wire();
    }

    async _loadTitles() {
        const j = await this._adminFetch('/api/admin/titles');
        this.titles = j && !j._authError ? (j.titles || []) : [];
        this.rerender(); this._wire();
    }

    async _loadPartners() {
        const path = '/api/admin/partners' + (this.partnerStateFilter ? `?state=${encodeURIComponent(this.partnerStateFilter)}` : '');
        const j = await this._adminFetch(path);
        this.partners = j && !j._authError ? (j.partners || []) : [];
        this.rerender(); this._wire();
    }

    async _loadAudit() {
        const params = new URLSearchParams({ page: String(this.auditPage), limit: '50' });
        if (this.auditOperator) params.set('operator', this.auditOperator);
        if (this.auditAction)   params.set('action',   this.auditAction);
        const j = await this._adminFetch(`/api/admin/audit?${params.toString()}`);
        this.audit = j && !j._authError ? (j.rows || []) : [];
        this.rerender(); this._wire();
    }

    async _adminPost(url, action, target, body) {
        const w = wallet.getStatus();
        if (!w.connected) return;
        const minute = Math.floor(Date.now() / 60000) * 60000;
        // Per-request 128-bit hex nonce. The server consumes it once via
        // an INSERT into admin_nonces — replay → 409. Crypto.randomUUID
        // gives us 128 bits of entropy with no extra dependency. We
        // strip the hyphens because the server validates nonce length
        // 16..80 chars and a hex-only payload is friendlier to logs.
        const nonce = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
        const msg = `DexHero admin: ${w.address.toLowerCase()} ${action} ${target || ''} ${minute} ${nonce}`;
        const sig = await wallet.signMessage(msg);
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adminWallet: w.address, adminSignature: sig, nonce, ...body }),
        });
        if (!r.ok) {
            const detail = await r.text().catch(() => '');
            alert(`Action failed: ${r.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
            return;
        }
        await this._loadCurrent();
    }
}
