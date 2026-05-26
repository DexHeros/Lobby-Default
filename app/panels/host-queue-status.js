// app/panels/host-queue-status.js — public host-approval queue health page.
//
// T2-05: prospective operators see SLA + current backlog before downloading
// the installer. Live backed by GET /api/host/queue-status; updates every
// 60s while the panel is open.

import { Panel } from '../ui/panel.js';

(function loadStyles() {
    if (document.querySelector('link[data-panel-css="host-play-hud"]')) return;
    const l = document.createElement('link');
    l.rel  = 'stylesheet';
    l.href = '/styles/panels/host-play-hud.css';
    l.setAttribute('data-panel-css', 'host-play-hud');
    document.head.appendChild(l);
})();

const SLA_TARGET_SEC = 24 * 60 * 60; // documented SLA in RUNBOOK.md "Host-approval SLA"

function _fmtAge(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    if (sec < 60)   return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
    return `${(sec / 86400).toFixed(1)}d`;
}

export default class HostQueueStatusPanel extends Panel {
    static id        = 'host-queue-status';
    static variant   = 'right';
    static width     = 520;
    static title     = 'Host Approval Queue';
    static titleBreadcrumb = ['HOST', 'QUEUE STATUS'];
    static stageMode = 'dim';
    static parentHash = '#/host';

    constructor(params) {
        super(params);
        this.data  = null;
        this.error = null;
        this._poll = null;
    }

    render() {
        if (this.error) {
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame hpd-frame--violet hpd-frame--lit">
                        <div class="hpd-frame__corners"></div>
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led hpd-eyebrow__led--warn"></span>
                            Queue · Offline
                        </span>
                        <h1 class="hpd-display hpd-display--md">Status unavailable</h1>
                        <p class="hpd-subline">${this._esc(this.error)}</p>
                    </div>
                </section>`;
        }
        if (!this.data) {
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame">
                        <div class="hpd-frame__corners"></div>
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led"></span>
                            Loading
                        </span>
                        <h1 class="hpd-display hpd-display--md">Polling queue…</h1>
                        <div class="hpd-meter hpd-meter--lit"><div class="hpd-meter__fill" style="width:30%;"></div></div>
                    </div>
                </section>`;
        }
        const d = this.data;
        const slaOk    = (d.median_approval_sec == null) || d.median_approval_sec <= SLA_TARGET_SEC;
        const oldestOk = (d.oldest_pending_age_sec || 0) <= SLA_TARGET_SEC;
        const allGreen = slaOk && oldestOk;
        const ledCls   = allGreen ? 'hpd-eyebrow__led--ok' : 'hpd-eyebrow__led--warn';
        const ledLbl   = allGreen ? 'Queue · Healthy' : 'Queue · SLA-breach';

        return `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-frame hpd-frame--lit">
                    <div class="hpd-frame__corners"></div>
                    <span class="hpd-eyebrow">
                        <span class="hpd-eyebrow__led ${ledCls}"></span>
                        ${ledLbl}
                    </span>
                    <h1 class="hpd-display hpd-display--md">Approval queue</h1>
                    <p class="hpd-subline">
                        Every new host gets a human review (GPU benchmark · region · library).
                        Documented SLA: <strong style="color:var(--ink-1);">under 24 hours</strong>.
                    </p>

                    <div class="hpd-stat-row" style="grid-template-columns:repeat(2,1fr);">
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Pending</div>
                            <div class="hpd-stat__value">${d.pending == null ? '—' : d.pending}</div>
                        </div>
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Approved · 24h</div>
                            <div class="hpd-stat__value hpd-stat__value--ok">${d.approved_24h == null ? '—' : d.approved_24h}</div>
                        </div>
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Median approval</div>
                            <div class="hpd-stat__value ${slaOk ? 'hpd-stat__value--ok' : 'hpd-stat__value--warn'}">${d.median_approval_sec == null ? '—' : _fmtAge(d.median_approval_sec)}</div>
                        </div>
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Oldest pending</div>
                            <div class="hpd-stat__value ${oldestOk ? 'hpd-stat__value--ok' : 'hpd-stat__value--warn'}">${_fmtAge(d.oldest_pending_age_sec || 0)}</div>
                        </div>
                    </div>

                    <p class="hpd-subline" style="margin-top:0;">
                        SLA target: <strong style="color:var(--ink-1);">${_fmtAge(d.target_sla_sec || SLA_TARGET_SEC)}</strong>.
                        Breach pages ops automatically.
                    </p>

                    <a class="hpd-cta" href="#/host">
                        <span>▶ Continue to host setup</span>
                        <span class="hpd-cta__chev">→</span>
                    </a>
                </div>
            </section>`;
    }

    async onMount() {
        await this._reload();
        // Poll every 60s — queue depth changes slowly; no need for tight cadence.
        this._poll = setInterval(() => { this._reload().catch(() => {}); }, 60_000);
    }

    onUnmount() {
        if (this._poll) clearInterval(this._poll);
        this._poll = null;
    }

    async _reload() {
        try {
            const r = await fetch('/api/host/queue-status');
            if (!r.ok) {
                this.error = `Server returned ${r.status}`;
                this.data  = null;
            } else {
                this.data  = await r.json();
                this.error = this.data?.error ? 'Queue stats are not yet available (database migration pending).' : null;
            }
        } catch (e) {
            this.error = e.message;
        }
        this.rerender();
    }

    _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
}
