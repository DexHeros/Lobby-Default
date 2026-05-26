/* Host a Server panel — the simplified WarpStream onboarding flow.
   Two states: pre-install (one big Download button) and post-install
   (gamified dashboard with earnings ticker + live status + pause).
   The post-install dashboard is auto-shown when the installer redirects
   here as /#/host?installed=1.
   Day-to-day server management (relay status, games selection, pending
   match requests) lives at #/profile?tab=servers. */

import { Panel, escapeHTML, fmtAddress } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { getSteamToken } from '../services/steam-session.js';
import { on, E } from '../events.js';
import { verifyPass } from '../services/play-pass.js';
import { buildHostSystemCheck } from '../ui/host-system-check.js';
import { buildLiveTicker } from '../ui/host-live-ticker.js';
import { buildDownloadManager } from '../ui/host-download-manager.js';
import { buildHostStepList } from '../ui/host-step.js';
import { buildSessionCard } from '../ui/session-card.js';
import { buildSparkline } from '../ui/sparkline.js';
import { iconHTML } from '../ui/icons.js';

// Phase-1 + Phase-4 host stylesheets + shared HUD-frame library —
// loaded once, idempotent.
(() => {
    if (typeof document === 'undefined') return;
    for (const href of ['/styles/host-hero.css', '/styles/host-tabs.css', '/styles/panels/host-play-hud.css']) {
        if (document.querySelector(`link[data-host-style][href="${href}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.hostStyle = '1';
        document.head.appendChild(link);
    }
})();

// Phase-4 — rarity thresholds (mirrored from MonadComputeRegistry).
const RARITY_THRESHOLDS = [
    { id: 'common',    label: 'Common',    minutes: 18000 },
    { id: 'uncommon',  label: 'Uncommon',  minutes: 27000 },
    { id: 'rare',      label: 'Rare',      minutes: 36000 },
    { id: 'legendary', label: 'Legendary', minutes: 54000 },
];

function _ringSvg(percent) {
    const p = Math.max(0, Math.min(100, percent));
    const r = 20;
    const c = 2 * Math.PI * r;
    const dash = (p / 100) * c;
    return `
        <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3"></circle>
            <circle cx="24" cy="24" r="${r}" fill="none"
                    stroke="var(--acc-cyan, #06b6d4)" stroke-width="3"
                    stroke-linecap="round"
                    stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"
                    transform="rotate(-90 24 24)"
                    style="filter: drop-shadow(0 0 4px rgba(6,182,212,0.6));"></circle>
        </svg>`;
}

export default class HostPanel extends Panel {
    static id        = 'host';
    static variant   = 'right';
    static width     = 560;
    static title     = 'Host a Server';
    static titleBreadcrumb = ['SERVERS', 'HOST'];
    static stageMode = 'dim';
    static parentHash = '#/';

    constructor(params) {
        super(params);
        this.passActive = null;
        this.seatStatus = null;
        this.flags = null;
        this.waitlistSubmitted = false;
        this.approvalStatus = null;
        // /#/host?installed=1 — installer just finished. Render the gamified
        // dashboard with confetti + earnings ticker, auto-trigger wallet
        // connect, auto-register on first heartbeat.
        this._installedFlag = params.installed === '1' || params.installed === true;
        this._earningsDex = 0;
        this._sessionStartedAt = Date.now();
        this._confettiShown = false;

        // /#/host?ref=0xABC — auto-persist the inviter wallet for first-session
        // crediting (server-side wiring deferred until there's actual signal
        // anyone's using referrals; the URL contract is forward-compatible).
        if (typeof params.ref === 'string' && /^0x[a-fA-F0-9]{40}$/.test(params.ref)) {
            try { localStorage.setItem('dexhero.host.ref', params.ref.toLowerCase()); } catch { /* noop */ }
        }
    }

    render() {
        const s = wallet.getStatus();
        const steamSignedIn = !!getSteamToken();

        // Platform check runs BEFORE any other gate. The installer is
        // Windows-only (Hyper-V + GPU-PV has no Linux/macOS equivalent),
        // so a non-Windows visitor can't host regardless of auth state.
        // Show them a short scannable warning + minimum compute specs and
        // exit — no point making them sign in or fill out a form for an
        // installer they can't run on this machine. Skip when already
        // installed (an installed host is by definition on Windows).
        const isWin = /Windows/i.test(navigator.userAgent || '');
        if (!isWin && !this._installedFlag) {
            return this._renderWindowsRequired();
        }

        // Post-install dashboard — gamified, earnings-first. Wallet + Play
        // Pass become required here (the dashboard auto-prompts wallet
        // connect if needed at line ~673; the Setup tab surfaces Pass as a
        // remaining step until activated).
        if (this._installedFlag) {
            return this._renderPostInstallDashboard(s);
        }

        // Pre-install gate: either Steam sign-in OR wallet connect unlocks
        // the install path. Both methods get the same hero + system check
        // + download flow. Wallet + Play Pass are required to actually
        // earn — that's surfaced post-install in the Setup checklist, not
        // here.
        const isAuthed = s.connected || steamSignedIn;
        if (!isAuthed) {
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame hpd-frame--lit">
                        <div class="hpd-frame__corners"></div>
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led hpd-eyebrow__led--standby"></span>
                            Auth required
                        </span>
                        <h1 class="hpd-display">Sign in <em>to host</em></h1>
                        <p class="hpd-subline">Either path gets you to the installer. Wallet + Play Pass are required to earn.</p>

                        <div style="display:flex;flex-direction:column;gap:10px;">
                            <button class="hpd-cta" data-steam-signin type="button">
                                <span>↗ Sign in through Steam</span>
                                <span class="hpd-cta__chev">→</span>
                            </button>
                            <button class="hpd-cta hpd-cta--secondary" data-connect type="button">
                                <span>Connect Wallet</span>
                                <span class="hpd-cta__chev">→</span>
                            </button>
                        </div>
                    </div>
                </section>`;
        }

        // Approval banner only renders when there's something to say
        // (post-registration). Pre-install, we keep the panel clean.
        return `
            ${this._renderApprovalBanner()}
            ${this._renderSeats()}
            ${this._renderInstallSection(s)}`;
    }

    /**
     * Non-Windows visitor — short scannable warning + minimum compute
     * specs. No form, no waitlist, no sign-in prompt. The visitor sees
     * exactly what they need to qualify (and can come back from a
     * different machine if they do).
     */
    _renderWindowsRequired() {
        return `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-frame">
                    <div class="hpd-frame__corners"></div>
                    <div class="hpd-divider" style="margin-top:0;">
                        <span class="hpd-divider__line"></span>
                        <span class="hpd-divider__tag" style="padding:8px 16px;font-size:11.5px;letter-spacing:0.30em;color:var(--ink-0,#fff);border-color:rgba(102,192,244,0.55);background:rgba(6,182,212,0.10);box-shadow:0 0 14px rgba(6,182,212,0.18);">Minimum Hardware</span>
                        <span class="hpd-divider__line"></span>
                    </div>

                    <ul class="host-reqs">
                        <li><span class="host-reqs__k">OS</span><span class="host-reqs__v">Windows 11 22H2+</span></li>
                        <li><span class="host-reqs__k">GPU</span><span class="host-reqs__v">NVIDIA · 8 GB VRAM</span></li>
                        <li><span class="host-reqs__k">CPU</span><span class="host-reqs__v">8+ threads · SLAT</span></li>
                        <li><span class="host-reqs__k">Disk</span><span class="host-reqs__v">100 GB NVMe</span></li>
                        <li><span class="host-reqs__k">RAM</span><span class="host-reqs__v">16 GB</span></li>
                        <li><span class="host-reqs__k">Uplink</span><span class="host-reqs__v">25 Mbps up</span></li>
                    </ul>
                </div>
            </section>`;
    }

    /**
     * Pre-install panel: minimal copy + one big Download button.
     * Compatibility checks are runtime (the stub installer hardware-checks
     * SLAT + GPU and aborts with a friendly modal if the machine is
     * incompatible). We don't make the user read a requirements list.
     */
    _renderInstallSection(s) {
        if (this.flags && this.flags.hostDownloadsLive === false) {
            return this._renderWaitlist(s);
        }
        if (!this.flags) {
            return `<section class="panel-section"><div class="hud-spin"></div><div class="hud-label" style="margin-top:8px;">Loading…</div></section>`;
        }
        // Windows check happens in render() before any auth gate — by the
        // time we reach this method we know the visitor is on Windows.
        // Windows visitor — Phase-1 Steam-tier hero. The actual hero
        // band, system-check rows, and download manager are all DOM
        // components built imperatively in onMount() (after the panel
        // is in the document); we render placeholders here that
        // _wireHostHero() then populates.
        return `
            <section class="host-hero" data-host-hero>
                <span class="hpd-eyebrow" style="margin-bottom:14px;">
                    <span class="hpd-eyebrow__led hpd-eyebrow__led--ok"></span>
                    Host onboarding · Live
                </span>
                <div class="host-hero-display">Host <em>Server</em></div>
                <div class="host-hero-sub">Host games. Earn minutes.</div>
                <div data-host-hero-ticker></div>
            </section>

            <div data-host-system-check></div>
            <div data-host-download></div>

            <section class="panel-section host-smartscreen-note" style="padding:0;background:transparent;border:0;">
                <div class="hpd-frame" style="padding:14px 16px;">
                    <div class="hpd-frame__corners"></div>
                    <div style="font-family:var(--font-mono,monospace);font-size:11px;line-height:1.6;color:var(--ink-2,rgba(255,255,255,0.62));">
                        Self-signed by <a href="https://sepolia.basescan.org/address/0x11A6B77fb2993C9eB6D7b282d8AA5e2559DB20Ee" target="_blank" rel="noopener noreferrer" style="color:var(--acc-cyan,#06b6d4);">V3Labs</a> &mdash; SmartScreen will warn on first launch; click <strong style="color:var(--acc-cyan,#06b6d4);">More info → Run anyway</strong>.
                        <div style="margin-top:6px;color:var(--ink-3,rgba(255,255,255,0.42));">
                            Or: <code style="color:var(--ink-1);">winget install DexHero.Host</code> (pending Microsoft review).
                        </div>
                    </div>
                </div>
            </section>

            <section class="panel-section">
                <div class="host-features">
                    <div class="host-feature">
                        <div class="host-feature-icon">${iconHTML('bolt', { size: 24 })}</div>
                        <div class="host-feature-title">Earn while you sleep</div>
                        <div class="host-feature-body">Your GPU runs games for paying players in the background — minutes accrue on-chain to your wallet.</div>
                    </div>
                    <div class="host-feature">
                        <div class="host-feature-icon">${iconHTML('shield', { size: 24 })}</div>
                        <div class="host-feature-title">Hyper-V isolation</div>
                        <div class="host-feature-body">Every player session runs in a sealed VM with GPU-PV partitioning. Players never touch your real OS.</div>
                    </div>
                    <div class="host-feature">
                        <div class="host-feature-icon">${iconHTML('gamepad', { size: 24 })}</div>
                        <div class="host-feature-title">Use your library</div>
                        <div class="host-feature-body">We scan your installed Steam titles. Players match to games you already own. No re-download.</div>
                    </div>
                </div>
            </section>

            <nav class="hpd-link-row">
                <a href="#/host/install?advanced=1">⚙ Advanced install</a>
                <span class="hpd-link-row__sep">·</span>
                <a href="#/host/queue-status">Queue status</a>
            </nav>`;
    }

    /**
     * Mount the imperative DOM pieces of the hero: live ticker, system
     * check, download manager. Called from _wire() once the panel is in
     * the document so we have real elements to attach to.
     */
    _wireHostHero() {
        const root = this.root;
        if (!root) return;
        const tickerSlot = root.querySelector('[data-host-hero-ticker]');
        const checkSlot  = root.querySelector('[data-host-system-check]');
        const dlSlot     = root.querySelector('[data-host-download]');
        if (!tickerSlot || !checkSlot || !dlSlot) return; // not on the pre-install branch

        // The tier estimator closure is updated when the system check
        // settles; the ticker reads it on every refresh.
        let tierDexPerHr = null;

        // --- live ticker ---
        if (!tickerSlot._mounted) {
            const ticker = buildLiveTicker({ dexPerHrEstimator: () => tierDexPerHr });
            tickerSlot.appendChild(ticker);
            ticker.start();
            tickerSlot._mounted = ticker;
            this._abort.signal.addEventListener('abort', () => ticker.stop?.(), { once: true });
        }

        // --- system check ---
        if (!checkSlot._mounted) {
            const check = buildHostSystemCheck();
            checkSlot.appendChild(check);
            checkSlot._mounted = check;

            // --- download manager — created in lockstep so we can gate it ---
            const dl = buildDownloadManager({
                disabled: true,
                disabledReason: 'Running system check…',
            });
            dlSlot.appendChild(dl);
            dlSlot._mounted = dl;

            check.addEventListener('host-check-complete', (ev) => {
                const r = ev.detail || {};
                tierDexPerHr = r.dexPerHr ?? null;
                if (r.passed) {
                    dl.setDisabled(false);
                } else {
                    const reasons = (r.blockers || []).join(', ');
                    dl.setDisabled(true, `Blocked: ${reasons || 'system check failed'}`);
                }
            });

            // Kick off the network probe (system check is mostly sync; the
            // bandwidth probe is async). We don't await — the event handler
            // above wires the dependent state.
            check.ready?.catch((e) => console.error('[host-check]', e));
        }
    }

    _renderWaitlist(s) {
        if (this.waitlistSubmitted) {
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame hpd-frame--lit">
                        <div class="hpd-frame__corners"></div>
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led hpd-eyebrow__led--ok"></span>
                            Waitlist · Confirmed
                        </span>
                        <h1 class="hpd-display hpd-display--md">You're <em>on the list</em></h1>
                        <p class="hpd-subline">We'll email you the moment installers go live.</p>
                    </div>
                </section>`;
        }
        const inputStyle = 'background:rgba(0,0,0,0.4);border:1px solid var(--rule);padding:12px 14px;color:var(--ink-0);font-family:var(--font-mono);font-size:12px;letter-spacing:0.06em;border-radius:2px;width:100%;box-sizing:border-box;';
        return `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-frame hpd-frame--lit">
                    <div class="hpd-frame__corners"></div>
                    <span class="hpd-eyebrow">
                        <span class="hpd-eyebrow__led hpd-eyebrow__led--standby"></span>
                        Hosting · Opening soon
                    </span>
                    <h1 class="hpd-display">Host games. <em>Earn minutes.</em></h1>
                    <p class="hpd-subline">Drop your email — first invite batch ships next.</p>

                    <div style="display:flex;flex-direction:column;gap:10px;">
                        <input type="email" data-wl-email placeholder="email@example.com" style="${inputStyle}">
                        <select data-wl-region style="${inputStyle}">
                            <option value="">Region (optional)</option>
                            <option value="us-east">US East</option>
                            <option value="us-central">US Central</option>
                            <option value="us-west">US West</option>
                            <option value="eu-west">EU West</option>
                            <option value="eu-central">EU Central</option>
                            <option value="apac-southeast">APAC Southeast</option>
                            <option value="apac-northeast">APAC Northeast</option>
                            <option value="oceania">Oceania</option>
                        </select>
                        <input type="text" data-wl-gpu placeholder="GPU model (e.g. RTX 4070)" style="${inputStyle}">
                        <button class="hpd-cta" data-wl-submit type="button">
                            <span>▶ Join host waitlist</span>
                            <span class="hpd-cta__chev">→</span>
                        </button>
                    </div>
                </div>
            </section>`;
    }

    /**
     * Phase-4 post-install dashboard — three-tab console (Setup / Live /
     * Earnings) replacing the prior "earnings ticker + 4 KPIs" view.
     * Each tab body is rendered imperatively in _wireHostTabs() so the
     * Setup steps + Live session card + Earnings sparkline can update
     * in place without the panel rerendering.
     */
    _renderPostInstallDashboard(s) {
        // Dashboard renders even without a wallet — host can review the
        // setup checklist + tabs freely. Wallet + Play Pass are only
        // enforced when they hit the "Go Online" / "Resume hosting"
        // button, which routes through `_gateHostAction()` to connect
        // the wallet + redirect to /#/buy-pass if the Pass is missing.
        const initialTab = this._activeTab || 'setup';
        const isOnline = this.seatStatus?.is_online === true;
        const goLabel = isOnline ? '⏸ Pause hosting' : '▶ Go Online';
        return `
            ${this._renderApprovalBanner()}
            <section class="panel-section">
                <button class="hud-btn hud-btn--primary hud-btn--block hud-btn--lg" data-toggle-online>${goLabel}</button>
            </section>
            <nav class="host-tabs" role="tablist" aria-label="Host console">
                <button role="tab" data-tab="setup"    aria-selected="${initialTab === 'setup'}">SETUP</button>
                <button role="tab" data-tab="live"     aria-selected="${initialTab === 'live'}">LIVE</button>
                <button role="tab" data-tab="earnings" aria-selected="${initialTab === 'earnings'}">EARNINGS</button>
            </nav>
            <div class="host-tab-panels" data-tab-panels>
                <section role="tabpanel" data-tab-panel="setup"    ${initialTab !== 'setup'    ? 'hidden' : ''} data-tab-setup></section>
                <section role="tabpanel" data-tab-panel="live"     ${initialTab !== 'live'     ? 'hidden' : ''} data-tab-live></section>
                <section role="tabpanel" data-tab-panel="earnings" ${initialTab !== 'earnings' ? 'hidden' : ''} data-tab-earnings></section>
            </div>`;
    }

    /**
     * Wire the imperative DOM bits of the three tabs. Called from _wire()
     * after the panel is in the document. Each tab tracks its own
     * "_mounted" flag so subsequent _wire() calls (rerender / wallet
     * change) don't double-mount.
     */
    _wireHostTabs() {
        if (!this._installedFlag) return;
        const root = this.root;
        if (!root) return;

        const tabs = root.querySelectorAll('[data-tab]');
        if (!tabs || tabs.length === 0) return;

        // Tab switching.
        for (const btn of tabs) {
            if (btn._wired) continue;
            btn._wired = true;
            btn.addEventListener('click', () => {
                const id = btn.dataset.tab;
                this._activeTab = id;
                for (const t of tabs) t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
                for (const panel of root.querySelectorAll('[data-tab-panel]')) {
                    panel.hidden = panel.dataset.tabPanel !== id;
                }
            }, { signal: this.signal });
        }

        // Setup tab.
        const setupSlot = root.querySelector('[data-tab-setup]');
        if (setupSlot && !setupSlot._mounted) {
            const list = buildHostStepList([
                { id: 'hardware',  idx: 1, label: 'Hardware',         detail: 'detecting…',           state: 'pending' },
                { id: 'network',   idx: 2, label: 'Network + relay',  detail: 'probing…',             state: 'pending' },
                // Player VM image — auto-fetched by session-manager (Tier 1).
                // Shows progress while downloading; ~3-5 GB on first install,
                // ~5-15 min on broadband. Idempotent across re-runs.
                { id: 'vmImage',   idx: 3, label: 'Player VM image',  detail: 'preparing…',           state: 'pending' },
                { id: 'wallet',    idx: 4, label: 'Wallet connected', detail: fmtAddress(wallet.getStatus().address), state: 'ok' },
                { id: 'steam',     idx: 5, label: 'Steam library',    detail: 'scanning…',            state: 'pending' },
                { id: 'pass',      idx: 6, label: 'Play Pass',        detail: 'checking…',            state: 'pending' },
                { id: 'firstSeen', idx: 7, label: 'First heartbeat',  detail: 'awaiting agent',       state: 'pending' },
            ]);
            setupSlot.appendChild(list.el);
            // Slot for a Self-Test failure summary banner. Mounted lazily
            // when self_test_results lands in the seatStatus poll. Sits
            // above the step list so failures grab attention immediately.
            const failBanner = document.createElement('div');
            failBanner.setAttribute('data-self-test-banner', '');
            failBanner.style.cssText = 'display:none;margin-bottom:10px;padding:10px 12px;border:1px solid #f87171;background:rgba(248,113,113,0.08);border-radius:6px;font-size:12px;color:var(--ink-1);';
            setupSlot.insertBefore(failBanner, list.el);
            setupSlot._mounted = list;
            setupSlot._selfTestBanner = failBanner;
        }

        // Live tab.
        const liveSlot = root.querySelector('[data-tab-live]');
        if (liveSlot && !liveSlot._mounted) {
            liveSlot.innerHTML = `
                <div class="live-empty">
                    <div class="live-empty-title">Waiting for matchmaker</div>
                    <div class="live-empty-sub">Your machine is registered. The first player session will appear here.</div>
                </div>`;
            liveSlot._mounted = true;
            liveSlot._sessionCard = null;
        }

        // Earnings tab.
        const earnSlot = root.querySelector('[data-tab-earnings]');
        if (earnSlot && !earnSlot._mounted) {
            earnSlot.innerHTML = `
                <div class="earnings-summary">
                    <div class="earnings-stat">
                        <div class="earnings-stat-label">Earned this session</div>
                        <div class="earnings-stat-value" data-earn-session>0.0000</div>
                    </div>
                    <div class="earnings-stat">
                        <div class="earnings-stat-label">Earned all-time</div>
                        <div class="earnings-stat-value" data-earn-total>0.0000</div>
                    </div>
                </div>
                <div class="earnings-chart">
                    <div class="earnings-chart-title">Last 30 days · DEX earned</div>
                    <div data-earn-spark></div>
                </div>
                <div class="threshold-meters" data-thresholds></div>
            `;
            const sparkSlot = earnSlot.querySelector('[data-earn-spark]');
            const sparkPoints = Array.from({ length: 14 }, (_, i) => Math.max(0, Math.sin(i / 2) + 0.5 + i * 0.05));
            const spark = buildSparkline({ width: 360, height: 80, points: sparkPoints, tooltip: 'Replaced with real data once attestations land cross-chain.' });
            sparkSlot.appendChild(spark);
            this._renderThresholds(earnSlot.querySelector('[data-thresholds]'), 0);
            earnSlot._mounted = { spark };
        }
    }

    _renderThresholds(host, currentMinutes) {
        if (!host) return;
        host.innerHTML = '';
        for (const t of RARITY_THRESHOLDS) {
            const pct = Math.min(100, (currentMinutes / t.minutes) * 100);
            const reached = currentMinutes >= t.minutes;
            const active  = !reached && (currentMinutes > 0);
            const cell = document.createElement('div');
            cell.className = 'threshold-meter' + (reached ? ' threshold-meter--reached' : (active ? ' threshold-meter--active' : ''));
            cell.innerHTML = `
                <div class="threshold-ring">
                    ${_ringSvg(pct)}
                    <div class="threshold-ring-percent">${pct < 99 ? pct.toFixed(0) + '%' : '✓'}</div>
                </div>
                <div class="threshold-name">${t.label}</div>
                <div class="threshold-target">${t.minutes.toLocaleString()} min</div>`;
            host.appendChild(cell);
        }
    }

    /**
     * Phase-4 — translate existing panel state (seatStatus, passActive,
     * approvalStatus) into Setup-tab + Live-tab + Earnings-tab updates.
     * Idempotent. Called from _wire() after every poll cycle.
     */
    _refreshHostTabsFromState() {
        if (!this._installedFlag) return;
        const root = this.root;
        if (!root) return;
        const s = wallet.getStatus();
        const st = this.seatStatus || {};

        // ── Setup tab ────────────────────────────────────────────────
        const setupSlot = root.querySelector('[data-tab-setup]');
        const list = setupSlot?._mounted;
        if (list?.update) {
            const passState = this.passActive == null
                ? { state: 'pending', detail: 'checking…' }
                : this.passActive
                    ? { state: 'ok', detail: 'active — earnings flowing' }
                    : { state: 'err', detail: 'required to earn', action: 'Get Play Pass', actionHref: '#/buy-pass?return=/host?installed=1' };
            const approvalState = (this.approvalStatus?.status === 'approved')
                ? { state: 'ok', detail: 'host approved + matchmaker reachable' }
                : (this.approvalStatus?.status === 'pending')
                    ? { state: 'pending', detail: 'awaiting operator review' }
                    : (this.approvalStatus?.status === 'rejected')
                        ? { state: 'err', detail: this.approvalStatus.notes || 'see rejection email' }
                        : { state: 'pending', detail: 'awaiting first heartbeat' };
            // Without a connected wallet, the agent poll (/api/node/status?wallet=…)
            // doesn't fire — so every agent-reported step would otherwise sit at
            // its initial "detecting…" state forever. Show them as "awaiting
            // wallet" instead so the user understands what's actually missing.
            const walletState = s.connected
                ? { state: 'ok', detail: fmtAddress(s.address) }
                : { state: 'err', detail: 'required to earn' };
            const stalled = !s.connected ? { state: 'pending', detail: 'awaiting wallet' } : null;

            // Player VM image step. session-manager image.rs writes
            // image-progress.json on the host; node-agent.js piggybacks
            // it on the seats heartbeat; server caches it; we read it
            // here from `st.vm_image_progress` (see /api/node/status).
            const vmImage = (() => {
                if (stalled) return stalled;
                const p = st.vm_image_progress;
                if (!p) return { state: 'pending', detail: 'preparing…' };
                const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
                const mb = (n) => `${(Number(n || 0) / 1e9).toFixed(1)} GB`;
                switch (p.state) {
                    case 'ready':
                        return { state: 'ok', detail: p.version ? `ready (v${p.version})` : 'ready' };
                    case 'downloading': {
                        const eta = _etaFromProgress(p);
                        const detail = p.bytes_total
                            ? `${pct}% · ${mb(p.bytes_downloaded)} / ${mb(p.bytes_total)}${eta ? ` · ${eta} remaining` : ''}`
                            : `${pct}% · ${mb(p.bytes_downloaded)} so far`;
                        return { state: 'pending', detail };
                    }
                    case 'verifying':     return { state: 'pending', detail: 'verifying download integrity…' };
                    case 'decompressing': return { state: 'pending', detail: 'decompressing image…' };
                    case 'installing':    return { state: 'pending', detail: 'installing image…' };
                    case 'checking':      return { state: 'pending', detail: 'checking for updates…' };
                    case 'failed':
                        return { state: 'err', detail: p.error ? p.error.slice(0, 80) : 'image fetch failed' };
                    default:
                        return { state: 'pending', detail: 'preparing…' };
                }
            })();

            list.update({
                hardware:  stalled || { state: 'ok', detail: st.gpu_tier ? `Tier ${st.gpu_tier}` : 'detected by agent' },
                network:   stalled || { state: st.relay_test_passed_at ? 'ok' : 'pending', detail: st.relay_test_passed_at ? `relay reachable @ ${st.public_ip || ''}` : 'awaiting relay probe' },
                vmImage:   vmImage,
                wallet:    walletState,
                steam:     stalled || { state: (st.steam_appids_installed?.length || 0) > 0 ? 'ok' : 'pending', detail: (st.steam_appids_installed?.length || 0) > 0 ? `${st.steam_appids_installed.length} games scanned` : 'scanning library…' },
                pass:      stalled || passState,
                firstSeen: stalled || approvalState,
            });

            // Self-Test failure banner. Self-Test.ps1 always runs
            // post-install; if any check failed, surface the specific
            // suggestions inline so the operator can fix without
            // hunting through install-log.txt.
            const banner = setupSlot?._selfTestBanner;
            if (banner) {
                const r = st.self_test_results;
                const failures = (r?.results || []).filter(x => x.status !== 'pass');
                if (failures.length > 0) {
                    banner.innerHTML = `
                        <div style="font-weight:600;margin-bottom:6px;color:#f87171;">Self-Test found ${failures.length} issue${failures.length === 1 ? '' : 's'} during install</div>
                        ${failures.map(f => `
                            <div style="margin-top:4px;">
                                <span style="color:#fca5a5;">✗ ${escapeHTML(f.name)}</span>
                                ${f.suggestion ? `<div style="margin-left:12px;color:var(--ink-2);font-size:11px;line-height:1.5;">→ ${escapeHTML(f.suggestion)}</div>` : ''}
                            </div>
                        `).join('')}`;
                    banner.style.display = 'block';
                } else {
                    banner.style.display = 'none';
                }
            }
        }

        // ── Live tab ────────────────────────────────────────────────
        const liveSlot = root.querySelector('[data-tab-live]');
        if (liveSlot && liveSlot._mounted) {
            const inFlight = (st.seats_in_use || 0) > 0 && (st.current_session || st.live_sessions);
            // The current_session shape isn't yet wired into /api/node/status;
            // until it is, just keep the empty state and rely on the live ticker.
            // When it lands, swap the empty-state for buildSessionCard(...).
            if (!inFlight && liveSlot._sessionCard) {
                liveSlot._sessionCard.destroy?.();
                liveSlot._sessionCard = null;
            }
            if (!inFlight) {
                // Tier 2.2: render the pre-flight smoke result above the
                // empty state so the operator sees specific pass/fail
                // signals within seconds of going online instead of
                // waiting hours for an organic match to confirm setup.
                liveSlot.innerHTML = `
                    ${_renderSmokeResult(st.smoke_result)}
                    <div class="live-empty">
                        <div class="live-empty-title">Waiting for matchmaker</div>
                        <div class="live-empty-sub">Your machine is registered. The first player session will appear here.</div>
                    </div>`;
                // Wire the smoke re-run button.
                const retryBtn = liveSlot.querySelector('[data-smoke-retry]');
                if (retryBtn && !retryBtn._wired) {
                    retryBtn._wired = true;
                    retryBtn.addEventListener('click', async () => {
                        retryBtn.disabled = true;
                        const labelEl = retryBtn.querySelector('[data-label]');
                        if (labelEl) labelEl.textContent = 'Re-testing…';
                        try {
                            const sw = wallet.getStatus();
                            if (!sw.connected) throw new Error('Connect a wallet first');
                            const minute = Math.floor(Date.now() / 60000) * 60000;
                            const msg = `DexHero smoke: ${sw.address.toLowerCase()} ${minute}`;
                            const sig = await wallet.signMessage(msg);
                            const r = await fetch('/api/node/first-match-smoke', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ wallet: sw.address, signature: sig }),
                            });
                            const data = await r.json();
                            // Stash directly so the next poll picks it up (idempotent —
                            // server also stashed it).
                            this.seatStatus = { ...this.seatStatus, smoke_result: data };
                            this._refreshHostTabsFromState();
                        } catch (e) {
                            if (labelEl) labelEl.textContent = 'Re-test (error)';
                            console.warn('[smoke] retry failed:', e?.message || e);
                        } finally {
                            retryBtn.disabled = false;
                        }
                    });
                }
            }
        }

        // ── Earnings tab ────────────────────────────────────────────
        const earnSlot = root.querySelector('[data-tab-earnings]');
        if (earnSlot && earnSlot._mounted) {
            const sessionEl = earnSlot.querySelector('[data-earn-session]');
            const totalEl   = earnSlot.querySelector('[data-earn-total]');
            if (sessionEl) sessionEl.textContent = (this._earningsDex || 0).toFixed(4);
            if (totalEl)   totalEl.textContent   = ((st.total_dex_earned || 0) || (this._earningsDex || 0)).toFixed(4);
            // Threshold meters update from on-chain attested minutes.
            const minutes = Number(st.compute_minutes_24h || st.total_minutes || 0);
            this._renderThresholds(earnSlot.querySelector('[data-thresholds]'), minutes);
        }
    }

    /** Pulled out so the rest of the post-install dashboard logic can
     *  call it as the seat-status / wallet info / pass-state arrives. */
    _legacyPostInstallDashboard_DEPRECATED(s) {
        if (!s.connected) return ''; // unreachable path kept for clarity
        const st = this.seatStatus || {};
        const used = Number(st.seats_in_use)  || 0;
        const cap  = Number(st.available_seats) || 0;
        const warm = Number(st.vm_pool_warm_count) || 0;
        const onlineDot = st.is_online !== false ? '🟢' : '⏸️';
        const onlineLabel = st.is_online !== false ? 'ONLINE' : 'PAUSED';
        const dexFmt = this._earningsDex.toFixed(4);
        const sessionMinutes = Math.max(1, Math.round((Date.now() - this._sessionStartedAt) / 60000));
        const dexPerHr = ((this._earningsDex / sessionMinutes) * 60).toFixed(4);
        return `
            ${this._renderApprovalBanner()}

            <section class="panel-section" style="text-align:center;padding:24px 16px;">
                <div class="hud-display" style="font-size:24px;margin-bottom:6px;">🎉 You're online</div>
                <div class="hud-label" style="font-size:12px;color:var(--ink-3);">Your first player will arrive when matchmaking finds you.</div>
            </section>

            <section class="panel-section">
                <div class="hud-label" style="margin-bottom:6px;">Your earnings (this session)</div>
                <div class="hud-display" style="font-size:36px;font-variant-numeric:tabular-nums;color:var(--acc-cyan,#22d3ee);" data-earnings-display>${dexFmt} <span style="font-size:14px;color:var(--ink-2);">DEX</span></div>
                <div class="hud-label" style="margin-top:6px;font-size:11px;">▲ Earning ${dexPerHr} DEX/hr</div>
            </section>

            <section class="panel-section">
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;">
                    <div>
                        <div class="hud-label">Status</div>
                        <div class="hud-display" style="font-size:14px;">${onlineDot} ${onlineLabel}</div>
                    </div>
                    <div>
                        <div class="hud-label">Players</div>
                        <div class="hud-display" style="font-size:14px;">${used} / ${cap || '—'}</div>
                    </div>
                    <div>
                        <div class="hud-label">Warm VMs</div>
                        <div class="hud-display" style="font-size:14px;">${warm}</div>
                    </div>
                    <div>
                        <div class="hud-label">Wallet</div>
                        <div class="hud-display" style="font-size:13px;">${fmtAddress(s.address)}</div>
                    </div>
                </div>
            </section>

            <section class="panel-section">
                <button class="hud-btn hud-btn--block" data-toggle-online title="${st.is_online !== false ? 'Stops accepting new players. Active sessions finish naturally.' : 'Starts accepting new players from the matchmaker.'}">
                    ${st.is_online !== false ? '⏸ Pause hosting' : '▶ Resume hosting'}
                </button>
                <a class="hud-btn hud-btn--block" href="#/profile?tab=servers" style="margin-top:8px;">Open full dashboard →</a>
                <button class="hud-btn hud-btn--ghost hud-btn--sm" data-show-advanced style="margin-top:8px;width:100%;color:var(--ink-3);font-size:11px;">⚙ Advanced settings</button>
            </section>

            ${this.passActive === false ? `
            <section class="panel-section" style="border-left:2px solid var(--acc-warn,#f59e0b);padding-left:12px;">
                <div class="hud-display" style="font-size:13px;margin-bottom:4px;">Play Pass needed to earn</div>
                <div class="hud-label" style="font-size:11px;line-height:1.5;margin-bottom:10px;">You can host without a Pass during beta, but earnings start accruing only after the one-time $100 USDC Play Pass is active.</div>
                <a class="hud-btn hud-btn--primary hud-btn--sm" href="#/buy-pass?return=/host?installed=1">Get Play Pass</a>
            </section>` : ''}`;
    }

    _renderApprovalBanner() {
        const a = this.approvalStatus;
        if (!a || !a.exists) return '';
        if (a.status === 'approved') {
            return `
                <div class="panel-section" style="border-left:2px solid var(--acc-ok,#22c55e);padding-left:12px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <span class="hud-dot hud-dot--live"></span>
                        <div style="flex:1;">
                            <div class="hud-display" style="font-size:14px;">Host approved</div>
                            <div class="hud-label">You're cleared to receive matchmaker assignments.</div>
                        </div>
                    </div>
                </div>`;
        }
        if (a.status === 'pending') {
            return `
                <div class="panel-section" style="border-left:2px solid var(--acc-warn,#f59e0b);padding-left:12px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <span class="hud-dot hud-dot--idle"></span>
                        <div style="flex:1;">
                            <div class="hud-display" style="font-size:14px;">⏳ Awaiting review</div>
                            <div class="hud-label">An operator is reviewing your registration. Usually under 24 hours.</div>
                        </div>
                    </div>
                </div>`;
        }
        if (a.status === 'rejected') {
            const note = a.notes
                ? `<div class="hud-label" style="margin-top:8px;font-size:11px;">Reason: ${this._esc(a.notes)}</div>`
                : `<div class="hud-label" style="margin-top:8px;font-size:11px;">Reason not provided. Email <a href="mailto:hosts@dexhero.com" style="color:var(--ink-1);text-decoration:underline;">hosts@dexhero.com</a> with your wallet address for details.</div>`;
            return `
                <div class="panel-section" style="border-left:2px solid var(--acc-err,#ef4444);padding-left:12px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <span class="hud-dot" style="background:var(--acc-err,#ef4444);"></span>
                        <div style="flex:1;">
                            <div class="hud-display" style="font-size:14px;">Host rejected</div>
                            <div class="hud-label">Your host registration was not approved. Email <a href="mailto:hosts@dexhero.com" style="color:var(--ink-1);text-decoration:underline;">hosts@dexhero.com</a> to appeal.</div>
                            ${note}
                        </div>
                    </div>
                </div>`;
        }
        return '';
    }

    _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    _renderSeats() {
        // Multi-seat panel only shows in non-installed flow if registered.
        // In installed flow, the seat info is part of the dashboard above.
        if (this._installedFlag) return '';
        const st = this.seatStatus;
        if (!st || st.available_seats == null) return '';
        const used = Number(st.seats_in_use)  || 0;
        const cap  = Number(st.available_seats) || 0;
        const warm = Number(st.vm_pool_warm_count) || 0;
        const dot = used < cap ? 'hud-dot--live' : 'hud-dot--idle';
        return `
            <section class="panel-section">
                <div class="hud-display" style="font-size:13px;margin-bottom:8px;">Multi-Seat Pool</div>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-family:var(--font-mono);font-size:11px;">
                    <div><div class="hud-label">Streaming</div><div class="hud-display"><span class="hud-dot ${dot}"></span> ${used} / ${cap}</div></div>
                    <div><div class="hud-label">Warm VMs</div><div class="hud-display">${warm}</div></div>
                    <div><div class="hud-label">Capacity</div><div class="hud-display">${cap > 0 ? Math.round((used / cap) * 100) : 0}%</div></div>
                </div>
                <button class="hud-btn hud-btn--sm" data-end-all-sessions title="Ends all active player sessions on your machine. Use this if you're taking the host offline. Players will be reassigned to other regional hosts." style="margin-top:12px;">End All Sessions</button>
            </section>`;
    }

    async _loadFlags() {
        try {
            const r = await fetch('/api/waitlist/feature-flags');
            if (r.ok) {
                this.flags = await r.json();
                this.rerender();
                this._wire();
            }
        } catch { /* default to waitlist UX */ }
    }

    async onMount() {
        // Fire confetti once on the post-install dashboard.
        if (this._installedFlag && !this._confettiShown) {
            this._confettiShown = true;
            // Lazy import — confetti.js ships in a future commit.
            try {
                const mod = await import('../ui/confetti.js').catch(() => null);
                if (mod?.fire) mod.fire();
            } catch {}
        }

        this._loadFlags();
        const unsub = on(E.WALLET_CHANGED, async () => {
            this.passActive = null;
            this.rerender();
            this._wire();
            const s = wallet.getStatus();
            if (s.connected) {
                this.passActive = await verifyPass(s.address);
                this.rerender();
                this._wire();
            }
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });

        this._wire();

        const s = wallet.getStatus();

        // Wallet + Play Pass are no longer required on dashboard load —
        // the host can review setup freely. Both are gated only at the
        // "Go Online" action via _gateHostAction(). Skip the on-chain
        // calls when no wallet so we don't error noisily.
        if (!s.connected) return;

        this.passActive = await verifyPass(s.address);
        this.rerender();
        this._wire();

        // Poll for seat status every 5 seconds.
        const poll = async () => {
            try {
                const r = await fetch(`/api/node/status?wallet=${encodeURIComponent(s.address)}`);
                if (r.ok) {
                    const data = await r.json();
                    this.seatStatus = data;
                    if (data.host_approved === true)  this.approvalStatus = { exists: true, status: 'approved', notes: data.approval_notes || null };
                    else if (data.host_approved === false) this.approvalStatus = { exists: true, status: 'rejected', notes: data.approval_notes || null };
                    else if (data.exists)             this.approvalStatus = { exists: true, status: 'pending',  notes: null };
                    // Earnings ticker — best-effort estimate from session
                    // history. The real DEX accrual is reported by the
                    // tokenomics layer; here we just animate a plausible
                    // count-up so the dashboard feels alive.
                    if (this._installedFlag && data.session_minutes_24h) {
                        // Rough estimate: 0.001 DEX per minute streamed.
                        this._earningsDex = Number(data.session_minutes_24h) * 0.001;
                    }
                    this.rerender();
                    this._wire();
                }
            } catch { /* transient */ }
        };
        poll();
        const handle = setInterval(poll, 5000);
        this._abort.signal.addEventListener('abort', () => clearInterval(handle), { once: true });
    }

    _wire() {
        const root = this.root;
        if (!root) return;

        // Phase-1 host-hero — mount imperative DOM components if the
        // pre-install branch is currently rendered. Idempotent (each
        // slot tracks its own _mounted flag).
        try { this._wireHostHero(); } catch (e) { console.error('[host-hero wire]', e); }
        // Phase-4 post-install console — same pattern, mounts the three
        // tab bodies once the post-install branch is rendered.
        try { this._wireHostTabs(); } catch (e) { console.error('[host-tabs wire]', e); }
        // Refresh tab-state from the latest known seatStatus / passActive.
        try { this._refreshHostTabsFromState(); } catch (e) { console.error('[host-tabs refresh]', e); }

        root.querySelector('[data-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });

        root.querySelector('[data-steam-signin]')?.addEventListener('click', () => {
            const ret = encodeURIComponent('#/host');
            window.location.href = `/api/steam/auth/begin?return=${ret}`;
        }, { signal: this.signal });

        root.querySelector('[data-wl-submit]')?.addEventListener('click', async () => {
            const email  = root.querySelector('[data-wl-email]')?.value.trim();
            const region = root.querySelector('[data-wl-region]')?.value || null;
            const gpu    = root.querySelector('[data-wl-gpu]')?.value.trim() || null;
            if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { alert('Please enter a valid email.'); return; }
            const w = wallet.getStatus();
            try {
                const r = await fetch('/api/waitlist/host', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email, region, gpu, wallet: w?.connected ? w.address : null }),
                });
                if (r.ok) {
                    this.waitlistSubmitted = true;
                    this.rerender();
                    this._wire();
                } else {
                    const e = await r.json().catch(() => ({}));
                    alert(`Waitlist signup failed: ${e.error || r.status}`);
                }
            } catch (e) { alert(`Waitlist signup error: ${e.message || e}`); }
        }, { signal: this.signal });

        root.querySelector('[data-end-all-sessions]')?.addEventListener('click', async () => {
            if (!confirm('End all active sessions on this server? Players will be reassigned to other regional servers.')) return;
            const s = wallet.getStatus();
            try {
                const minute = Math.floor(Date.now() / 60000) * 60000;
                const msg = `DexHero end-all-sessions: ${s.address.toLowerCase()} ${minute}`;
                const signature = await wallet.signMessage(msg);
                await fetch('/api/node/end-all-sessions', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ wallet: s.address, signature }),
                });
                this.seatStatus = null;
                this.rerender();
                this._wire();
            } catch (e) { alert(`Failed: ${e.message || e}`); }
        }, { signal: this.signal });

        // Toggle online/paused — gates wallet + Play Pass before signing
        // the on-chain message. Connect prompt + buy-pass route loop both
        // return the user back to /#/host?installed=1 so they pick up where
        // they left off (per the user-stated host onboarding flow).
        root.querySelector('[data-toggle-online]')?.addEventListener('click', async () => {
            const ok = await this._gateHostAction();
            if (!ok) return;
            const s = wallet.getStatus();
            const goingOffline = (this.seatStatus?.is_online !== false);
            try {
                const minute = Math.floor(Date.now() / 60000) * 60000;
                const msg = `DexHero set-online: ${s.address.toLowerCase()} ${goingOffline ? 'offline' : 'online'} ${minute}`;
                const signature = await wallet.signMessage(msg);
                await fetch('/api/node/set-online', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ wallet: s.address, signature, online: !goingOffline }),
                });
                if (this.seatStatus) this.seatStatus.is_online = !goingOffline;
                this.rerender();
                this._wire();
            } catch (e) { alert(`Failed: ${e.message || e}`); }
        }, { signal: this.signal });

        root.querySelector('[data-show-advanced]')?.addEventListener('click', () => {
            location.hash = '#/profile?tab=servers';
        }, { signal: this.signal });
    }

    /**
     * Wallet + Play Pass + VM image gate for the "Go Online" action.
     * Returns true when all three are satisfied. Returns false (and
     * triggers the appropriate remediation flow) when one is missing:
     *   - no wallet: opens the connect modal. User retries the click.
     *   - wallet but no pass: routes to /#/buy-pass?return=/host?installed=1.
     *   - wallet + pass but VM image not ready: shows a transient
     *     status message; the watcher in session-manager auto-promotes
     *     the host to online once the download completes, so the user
     *     doesn't have to click again.
     */
    async _gateHostAction() {
        const s = wallet.getStatus();
        if (!s.connected) {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
            return false;
        }
        if (this.passActive == null) {
            this.passActive = await verifyPass(s.address).catch(() => false);
        }
        if (!this.passActive) {
            location.hash = '#/buy-pass?return=/host?installed=1';
            return false;
        }
        // Tier 2.1: VM image must be in place before the host can serve
        // sessions. session-manager refuses clone_from_golden until
        // image_ready() is true; gating here gives a specific UX
        // message instead of a session-time "pool exhausted" error.
        const imgState = this.seatStatus?.vm_image_progress?.state;
        if (imgState && imgState !== 'ready') {
            // Render a transient toast/inline message. Reuse the existing
            // banner slot in the Setup tab so we don't add a new modal.
            const setupSlot = this.root?.querySelector('[data-tab-setup]');
            const banner = setupSlot?._selfTestBanner;
            if (banner) {
                const p = this.seatStatus.vm_image_progress;
                const pct = Math.round(p.percent || 0);
                banner.style.borderColor   = '#fbbf24';
                banner.style.background    = 'rgba(251,191,36,0.08)';
                banner.innerHTML = `
                    <div style="font-weight:600;color:#fbbf24;">Player VM image still ${p.state || 'preparing'} (${pct}%)</div>
                    <div style="margin-top:4px;color:var(--ink-2);font-size:11px;">Hosting will start automatically the moment the image is ready — no need to click again.</div>`;
                banner.style.display = 'block';
            }
            return false;
        }
        return true;
    }
}

/** Render the pre-flight smoke result as a small card above the
 *  Live-tab empty state. Shows green when every check passed, red
 *  with per-check detail otherwise, or a neutral "checking…" if the
 *  smoke hasn't run yet. Includes a manual "Re-test" button so an
 *  operator who fixed an issue can re-validate without flipping
 *  online + offline. */
function _renderSmokeResult(result) {
    if (!result) {
        return `
            <div class="smoke-card smoke-card--pending" style="padding:12px 14px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.06);border-radius:8px;margin-bottom:12px;">
                <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#60a5fa;">PRE-FLIGHT</div>
                <div style="font-size:13px;color:var(--ink-2);margin-top:4px;">Running pre-flight checks…</div>
            </div>`;
    }
    const passed = result.passed === true;
    const passedCount = (result.checks || []).filter(c => c.status === 'pass').length;
    const totalCount  = (result.checks || []).length;
    const failed = (result.checks || []).filter(c => c.status !== 'pass');
    const headerColor = passed ? '#4ade80' : '#f87171';
    const headerText  = passed
        ? `PRE-FLIGHT PASSED — ${passedCount}/${totalCount} CHECKS`
        : `PRE-FLIGHT FAILED — ${failed.length} ISSUE${failed.length === 1 ? '' : 'S'} FOUND`;
    const failuresHtml = passed ? '' : `
        <div style="margin-top:8px;">
            ${failed.map(f => `
                <div style="margin-top:4px;font-size:12px;">
                    <span style="color:#fca5a5;">✗ ${escapeHTML(f.name.replace(/_/g, ' '))}</span>
                    ${f.detail ? `<div style="margin-left:14px;color:var(--ink-2);font-size:11px;line-height:1.5;">${escapeHTML(f.detail)}</div>` : ''}
                </div>
            `).join('')}
        </div>`;
    // Tier 2.2b: lifecycle smoke runs after pre-flight passes (when
    // SYNTHETIC_PLAYER_WALLET is configured server-side). Renders a
    // second sub-card showing the synthetic-player session in flight.
    const lifecycleHtml = result.lifecycle ? (() => {
        const lc = result.lifecycle;
        const sid = (lc.sessionId || '').slice(0, 12);
        return `
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(96,165,250,0.2);">
                <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#60a5fa;">LIFECYCLE SMOKE — RUNNING</div>
                <div style="margin-top:4px;font-size:12px;color:var(--ink-2);">Synthetic player paired with your machine for ~90s. Validates session-assignment + VM spin + connect-info + clean teardown.</div>
                <div style="margin-top:4px;font-size:10.5px;color:var(--ink-3);font-family:var(--font-mono, monospace);">session ${escapeHTML(sid)}…</div>
            </div>`;
    })() : '';
    // Tier 4.4a: streaming probe. Synthetic-player worker runs TCP+WS
    // upgrade against the host's public bridge port after the host
    // publishes connect-info. Catches NAT / firewall / streamer-not-running
    // failures BEFORE a real player gets matched.
    const probeHtml = result.streaming_probe ? _renderStreamingProbe(result.streaming_probe) : '';
    return `
        <div class="smoke-card" style="padding:12px 14px;border:1px solid ${passed ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'};background:${passed ? 'rgba(74,222,128,0.06)' : 'rgba(248,113,113,0.06)'};border-radius:8px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:${headerColor};">${headerText}</div>
                <button data-smoke-retry type="button" style="background:transparent;border:1px solid var(--surf-3, #333);color:var(--ink-2);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">
                    <span data-label>${passed ? 'Re-test' : 'Retry'}</span>
                </button>
            </div>
            ${failuresHtml}
            ${lifecycleHtml}
            ${probeHtml}
            <div style="margin-top:8px;font-size:10.5px;color:var(--ink-3);font-family:var(--font-mono, monospace);">
                ran ${result.ran_at ? _relativeTime(result.ran_at) : 'just now'}
            </div>
        </div>`;
}

/** Render the Tier 4.4a streaming-probe sub-card. Three states:
 *    1. connect-info never arrived → red, "host couldn't publish in time"
 *    2. tcp/ws probe failed → red, specific layer + reason
 *    3. all green → "streaming pipeline reachable from public internet"
 *  Each layer has a green check / red X plus the recorded duration.
 */
function _renderStreamingProbe(probe) {
    const ok = probe.passed === true;
    const headerColor = ok ? '#4ade80' : '#f87171';
    const headerText  = ok ? 'STREAMING PROBE — REACHABLE' : 'STREAMING PROBE — FAILURE';
    const rowGreen  = (label, detail) => `<div style="margin-top:4px;font-size:11.5px;"><span style="color:#4ade80;">✓ ${escapeHTML(label)}</span><span style="color:var(--ink-3);margin-left:8px;">${escapeHTML(detail)}</span></div>`;
    const rowRed    = (label, detail) => `<div style="margin-top:4px;font-size:11.5px;"><span style="color:#fca5a5;">✗ ${escapeHTML(label)}</span><span style="color:var(--ink-3);margin-left:8px;">${escapeHTML(detail)}</span></div>`;
    const rows = [];
    if (!probe.connect_info_received) {
        rows.push(rowRed('connect-info publish', 'host did not publish connect-info within 35s — VM may not be spinning up'));
    } else {
        rows.push(rowGreen('connect-info publish', `${probe.host || '?'}:${probe.port || '?'}`));
        if (probe.tcp) {
            if (probe.tcp.ok) rows.push(rowGreen('TCP connect',   `${probe.tcp.durationMs}ms`));
            else              rows.push(rowRed  ('TCP connect',   `${probe.tcp.error || 'failed'} — your firewall/router may be blocking inbound. Open port ${probe.port || 47991} or set up port-forward.`));
        }
        if (probe.ws) {
            if (probe.ws.ok)  rows.push(rowGreen('WebSocket upgrade', `HTTP ${probe.ws.status}, ${probe.ws.durationMs}ms`));
            else              rows.push(rowRed  ('WebSocket upgrade', `${probe.ws.error || 'failed'}${probe.ws.status ? ` (HTTP ${probe.ws.status})` : ''} — streamer.exe may not be running, or pair token rejected. Check install-log.txt.`));
        }
        // Tier 4.4b — real WebRTC offer/answer + RTP packet count.
        // Validates the UDP path that TCP-only probes can't see.
        if (probe.webrtc) {
            const w = probe.webrtc;
            if (!w.attempted) {
                rows.push(rowRed('WebRTC peer connection', `not attempted: ${w.error || 'werift unavailable on worker'}`));
            } else if (w.connection_state === 'connected' || w.ice_state === 'connected') {
                if (w.packets_received > 0) {
                    rows.push(rowGreen('WebRTC peer connection', `connected (${w.ice_state || 'ice ok'}); ${w.packets_received} RTP packets / ${(w.bytes_received / 1024).toFixed(0)} KB over ${(w.duration_ms / 1000).toFixed(1)}s`));
                } else {
                    rows.push(rowRed('WebRTC peer connection', `connected but received 0 RTP packets — encoder may not be running. Check Sunshine encoder config + GPU driver.`));
                }
            } else {
                const reason = w.error
                    || (w.connection_state ? `connection_state=${w.connection_state}` : '')
                    || (w.ice_state ? `ice_state=${w.ice_state}` : 'no state reached')
                    || 'unknown';
                rows.push(rowRed('WebRTC peer connection', `${reason} — UDP path likely blocked by NAT/firewall. Open UDP 47998-48000 inbound, or set ICE_SERVERS env on Render to a TURN relay.`));
            }
        }
        // Tier 4.4d — real-browser smoke (Headless Chromium + WebCodecs).
        // Lands in probe.real_browser_probe when the v3labs-streaming-smoke-runner
        // service is enabled. Validates real H.264 decode + frame timing,
        // which neither TCP nor werift can see. Latency p99 lines up against
        // the platform's 40ms motion-to-photon stretch goal.
        if (probe.real_browser_probe) {
            const rb = probe.real_browser_probe;
            if (!rb.attempted || rb.error) {
                const reason = rb.error || 'not attempted';
                rows.push(rowRed('Real-browser decode', reason));
            } else if (rb.frames_decoded > 0) {
                const m2p = rb.m2p_ms_p99 ? ` · m2p p99 ${rb.m2p_ms_p99}ms` : '';
                const decode = rb.decode_ms_p99 ? ` · decode p99 ${rb.decode_ms_p99}ms` : '';
                const loss = rb.packets_received > 0
                    ? ` · loss ${(100 * rb.packets_lost / Math.max(1, rb.packets_received)).toFixed(2)}%`
                    : '';
                const rtt = rb.rtt_ms ? ` · rtt ${rb.rtt_ms}ms` : '';
                rows.push(rowGreen('Real-browser decode',
                    `${rb.frames_decoded} frames @ ${rb.fps_observed} fps${decode}${m2p}${rtt}${loss}`));
                // Stretch-goal warning when m2p exceeds the 40ms target.
                if (rb.m2p_ms_p99 && rb.m2p_ms_p99 > 40) {
                    rows.push(`<div style="margin-top:2px;font-size:11px;color:#fbbf24;margin-left:14px;">⚠ motion-to-photon p99 above 40ms target. Check encoder latency settings + uplink bandwidth.</div>`);
                }
            } else {
                rows.push(rowRed('Real-browser decode',
                    `connected but 0 frames decoded — encoder may not be sending H.264 baseline (avc1.42E01E). Check Sunshine encoder profile.`));
            }
        }
    }
    return `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(96,165,250,0.2);">
            <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${headerColor};">${headerText}</div>
            ${rows.join('')}
        </div>`;
}

/** "12s ago" / "2m ago" / "1h ago" — small humanizer for timestamps. */
function _relativeTime(iso) {
    const elapsed = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
    if (elapsed < 60)    return `${Math.round(elapsed)}s ago`;
    if (elapsed < 3600)  return `${Math.round(elapsed / 60)}m ago`;
    return `${(elapsed / 3600).toFixed(1)}h ago`;
}

/** Estimate how much time remains for a download, given a progress
 *  snapshot { bytes_downloaded, bytes_total, started_at, updated_at }.
 *  Falls back to '' when the snapshot doesn't have enough history to
 *  produce a meaningful number. */
function _etaFromProgress(p) {
    if (!p?.bytes_total || !p.bytes_downloaded || !p.started_at || !p.updated_at) return '';
    const elapsed = (new Date(p.updated_at).getTime() - new Date(p.started_at).getTime()) / 1000;
    if (!Number.isFinite(elapsed) || elapsed < 5) return '';
    const remaining = Math.max(0, p.bytes_total - p.bytes_downloaded);
    if (remaining === 0) return '';
    const rate = p.bytes_downloaded / elapsed; // bytes/sec
    if (!Number.isFinite(rate) || rate < 1) return '';
    const eta = remaining / rate;
    if (eta < 60)  return `${Math.round(eta)} sec`;
    if (eta < 3600) return `${Math.round(eta / 60)} min`;
    return `${(eta / 3600).toFixed(1)} hr`;
}
