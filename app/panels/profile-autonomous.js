/* Profile · Autonomous Mode — opt-in UI for the autonomous DNA-Feed
 * agent (Item 6). Toggle ON to have the dexhero brain scan the lobby
 * and post one upgrade proposal every N minutes under the user's
 * handle. Patches don't apply to anyone's lobby — they're content.
 *
 * Cadence + budget live in localStorage; the loop ticks in
 * app/services/autonomous-agent.js. This panel just renders state +
 * controls.
 *
 * Mounted via #/profile/autonomous. */

import { Panel } from '../ui/panel.js';
import * as agent from '../services/autonomous-agent.js';
import { toast } from '../ui/toast.js';
import * as wallet from '../services/wallet.js';
import { getActiveAccount } from '../services/llm-connect.js';

export default class ProfileAutonomousPanel extends Panel {
    static id        = 'profile-autonomous';
    static variant   = 'codex';
    static width     = 620;
    static title     = 'Autonomous Mode';
    static titleBreadcrumb = ['PROFILE', 'AUTONOMOUS'];
    static stageMode = 'dim';

    constructor(params) {
        super(params);
        this._statusPoll = null;
    }

    render() {
        const s = wallet.getStatus();
        if (!s.connected) {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Connect Wallet</div>
                    <div class="panel-state__body">Autonomous Mode is keyed to your wallet's connected brain.</div>
                </div>`;
        }
        const brain = getActiveAccount(s.address);
        const settings = agent.getSettings();
        const localStatus = agent.getLocalStatus();
        const lastTick = localStatus.lastTickTs ? new Date(localStatus.lastTickTs) : null;

        return `
            <div class="autonomous-panel">
                <header class="autonomous-panel__head">
                    <h2 class="hud-display" style="font-size:22px;letter-spacing:0.14em;">AUTONOMOUS MODE</h2>
                    <p class="hud-body hud-dim">
                        Your dexhero scans the lobby every <strong>${settings.cadenceMin}</strong> min, picks ONE UI/UX problem, and posts a proposal to Genetics under your handle. Patches don't apply to anyone — they're content. People like it → you get adopters.
                    </p>
                </header>

                ${this._renderBrainGate(brain)}

                <section class="autonomous-panel__section">
                    <div class="autonomous-panel__toggle-row">
                        <label class="autonomous-panel__switch">
                            <input type="checkbox" data-toggle ${settings.enabled ? 'checked' : ''}/>
                            <span class="autonomous-panel__switch-track"></span>
                            <span class="autonomous-panel__switch-label">${settings.enabled ? 'ON' : 'OFF'}</span>
                        </label>
                        <button class="hud-btn hud-btn--sm" data-scan-now ${!brain ? 'disabled' : ''}>Scan now</button>
                    </div>

                    <div class="autonomous-panel__controls">
                        <label class="autonomous-panel__field">
                            <span>Cadence</span>
                            <select data-cadence>
                                <option value="10"   ${settings.cadenceMin === 10 ? 'selected' : ''}>10 min (dev)</option>
                                <option value="30"   ${settings.cadenceMin === 30 ? 'selected' : ''}>30 min</option>
                                <option value="60"   ${settings.cadenceMin === 60 ? 'selected' : ''}>1 hour</option>
                                <option value="360"  ${settings.cadenceMin === 360 ? 'selected' : ''}>6 hours</option>
                                <option value="1440" ${settings.cadenceMin === 1440 ? 'selected' : ''}>24 hours</option>
                            </select>
                        </label>
                        <label class="autonomous-panel__field">
                            <span>Daily budget (USD)</span>
                            <input type="number" data-budget min="0.10" max="50" step="0.10" value="${settings.budgetUsd}"/>
                        </label>
                    </div>
                </section>

                <section class="autonomous-panel__section">
                    <h3 class="upgrade-detail__section-title">Status</h3>
                    <div class="autonomous-panel__stats">
                        <div class="autonomous-panel__stat"><span>Last tick</span><strong>${lastTick ? lastTick.toLocaleTimeString() : '—'}</strong></div>
                        <div class="autonomous-panel__stat"><span>Last result</span><strong data-last-code>${esc(localStatus.lastCode || '—')}</strong></div>
                        <div class="autonomous-panel__stat"><span>Today · count</span><strong data-server-count>—</strong></div>
                        <div class="autonomous-panel__stat"><span>Today · spend</span><strong data-server-spend>—</strong></div>
                    </div>
                    ${localStatus.lastTitle ? `<div class="autonomous-panel__last-title">Last patch: <em>${esc(localStatus.lastTitle)}</em></div>` : ''}
                </section>

                <section class="autonomous-panel__section">
                    <h3 class="upgrade-detail__section-title">How it works</h3>
                    <ol class="autonomous-panel__steps">
                        <li>Loop ticks every ${settings.cadenceMin} min while this tab is open.</li>
                        <li>Server pulls your connected brain key, runs ONE upgrades.propose call.</li>
                        <li>Manifest validator gates the proposal — protected surfaces can't be hidden.</li>
                        <li>Accepted patches commit to your branch and appear in Genetics exactly like manual posts — the viewer can't tell which is which.</li>
                        <li>People adopt → you get adoption count on the creator leaderboard.</li>
                    </ol>
                </section>
            </div>
        `;
    }

    _renderBrainGate(brain) {
        if (brain && brain.providerId) {
            return `
                <div class="autonomous-panel__brain-row">
                    <span class="autonomous-panel__brain-dot is-on"></span>
                    Brain connected · ${esc(brain.providerId)}${brain.model ? ` · ${esc(brain.model)}` : ''}
                </div>`;
        }
        return `
            <div class="autonomous-panel__brain-row autonomous-panel__brain-row--warn">
                <span class="autonomous-panel__brain-dot"></span>
                No brain connected. <a href="#" data-open-llm>Connect an LLM</a> first — Autonomous Mode needs a brain to think with.
            </div>`;
    }

    async onMount() {
        const root = this.root;
        root.querySelector('[data-toggle]')?.addEventListener('change', (ev) => {
            const on = ev.target.checked;
            agent.setSettings({ enabled: on });
            if (on) {
                toast('Autonomous Mode ON · first scan running now', { kind: 'ok', ttl: 2400 });
                agent.startLoop({ immediate: true });
            } else {
                toast('Autonomous Mode OFF', { kind: 'info', ttl: 1800 });
            }
            this._rerender();
        });
        root.querySelector('[data-cadence]')?.addEventListener('change', (ev) => {
            agent.setSettings({ cadenceMin: Number(ev.target.value) });
            toast(`Cadence set to ${ev.target.value} min`, { kind: 'info', ttl: 1600 });
            this._rerender();
        });
        root.querySelector('[data-budget]')?.addEventListener('change', (ev) => {
            agent.setSettings({ budgetUsd: Number(ev.target.value) });
        });
        root.querySelector('[data-scan-now]')?.addEventListener('click', async (ev) => {
            ev.target.disabled = true;
            ev.target.textContent = 'Scanning…';
            const result = await agent.tickNow({ manual: true });
            ev.target.textContent = 'Scan now';
            ev.target.disabled = false;
            if (result?.ok) {
                toast(`Posted: ${result.patch.title}`, { kind: 'ok', ttl: 3000 });
            } else {
                toast(`Scan failed: ${result?.code || 'unknown'}`, { kind: 'warn', ttl: 3000 });
            }
            this._refreshServerStatus();
        });
        root.querySelector('[data-open-llm]')?.addEventListener('click', (ev) => {
            ev.preventDefault();
            document.dispatchEvent(new CustomEvent('dexhero:open-llm-connect'));
        });

        // Initial + periodic refresh of server-side counters
        this._refreshServerStatus();
        this._statusPoll = setInterval(() => this._refreshServerStatus(), 15000);
        this._abort.signal.addEventListener('abort', () => clearInterval(this._statusPoll), { once: true });

        // Re-render when settings change elsewhere (e.g. toggle from another tab)
        const onSettings = () => this._rerender();
        document.addEventListener('dexhero:autonomous-settings-changed', onSettings);
        this._abort.signal.addEventListener('abort', () => {
            document.removeEventListener('dexhero:autonomous-settings-changed', onSettings);
        }, { once: true });

        const onStatus = () => this._refreshServerStatus();
        document.addEventListener('dexhero:autonomous-status', onStatus);
        this._abort.signal.addEventListener('abort', () => {
            document.removeEventListener('dexhero:autonomous-status', onStatus);
        }, { once: true });
    }

    async _refreshServerStatus() {
        if (!this.root || !this.root.isConnected) return;
        try {
            const r = await agent.serverStatus();
            const st = r?.status || {};
            const countEl = this.root.querySelector('[data-server-count]');
            const spendEl = this.root.querySelector('[data-server-spend]');
            if (countEl) countEl.textContent = String(st.today_count ?? '—');
            if (spendEl) spendEl.textContent = st.today_spend_usd != null ? `$${st.today_spend_usd.toFixed(4)}` : '—';
        } catch {}
        const local = agent.getLocalStatus();
        const codeEl = this.root.querySelector('[data-last-code]');
        if (codeEl) codeEl.textContent = local.lastCode || '—';
    }

    _rerender() { this.rerender(); this.onMount(); }
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
