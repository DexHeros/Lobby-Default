/* Profile panel — wallet holdings and created DexHeros.
   Uses window.DexHeroTokens.getUserTokens for accurate creator-matched results. */

import { Panel, escapeHTML, fmtAddress, sanitizeURL, fmtNum } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { on, E } from '../events.js';
import { verifyPass } from '../services/play-pass.js';

export default class ProfilePanel extends Panel {
    static id        = 'profile';
    static variant   = 'right';
    static width     = 520;
    static title     = 'Profile';
    static titleBreadcrumb = ['AGENT'];
    static stageMode = 'keep';

    constructor(params) {
        super(params);
        const t = params.tab;
        this.tab = ['created', 'drafts', 'servers', 'games'].includes(t) ? t : 'holdings';
        this.data = { holdings: null, created: null, drafts: null, games: null, passActive: null };
        // Server dashboard state — populated lazily when the Servers tab
        // is opened, and refreshed on a 5s poll while it's active.
        this.serverData = { node: null, myGames: [], catalog: [], pending: [] };
        this._serverPoll = null;
    }

    render() {
        const s = wallet.getStatus();
        if (!s.connected) {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Connect Wallet</div>
                    <div class="panel-state__body">Connect a wallet to view your agent profile.</div>
                    <button class="hud-btn hud-btn--primary" data-connect>Connect</button>
                </div>`;
        }
        return `
            <section class="panel-section">
                <div style="display:flex;align-items:center;gap:16px;">
                    <div style="width:56px;height:56px;border-radius:50%;background:var(--acc-gradient);flex-shrink:0;"></div>
                    <div style="flex:1;min-width:0;">
                        <div class="hud-display" style="font-size:20px;letter-spacing:0.2em;">${fmtAddress(s.address)}</div>
                        <div class="hud-label" style="margin-top:4px;">EVM · Connected</div>
                    </div>
                    <button class="hud-btn hud-btn--sm" data-disconnect>Disconnect</button>
                </div>
            </section>

            <div data-pass-row>${this._renderPassRow()}</div>

            <div class="panel-tabs">
                <button class="panel-tab" data-tab="holdings" aria-selected="${this.tab === 'holdings'}">Holdings</button>
                <button class="panel-tab" data-tab="created"  aria-selected="${this.tab === 'created'}">Created</button>
                <button class="panel-tab" data-tab="drafts"   aria-selected="${this.tab === 'drafts'}">Drafts</button>
                <button class="panel-tab" data-tab="games"    aria-selected="${this.tab === 'games'}">Games</button>
                <button class="panel-tab" data-tab="servers"  aria-selected="${this.tab === 'servers'}">Servers</button>
            </div>

            <div data-list>
                <div class="panel-state"><div class="hud-spin"></div><div>Loading</div></div>
            </div>
        `;
    }

    async onMount() {
        // Auto-rerender when wallet changes (header modal connect, account swap, etc.)
        const unsub = on(E.WALLET_CHANGED, () => {
            this.rerender();
            this.onMount();
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });

        const s = wallet.getStatus();
        if (!s.connected) {
            this.root.querySelector('[data-connect]')?.addEventListener('click', () => {
                // The wallet service handles disambiguation: if a connect
                // modal is registered, it opens the picker; otherwise it
                // performs an inline EIP-6963 discovery.
                if (typeof window.openConnectModal === 'function') {
                    window.openConnectModal();
                } else {
                    wallet.connect().catch(() => {});
                }
            }, { signal: this.signal });
            return;
        }

        this.root.querySelector('[data-disconnect]')?.addEventListener('click', async () => {
            if (confirm('Disconnect wallet?')) {
                await wallet.disconnect();
                this.rerender();
                await this.onMount();
            }
        }, { signal: this.signal });

        this.root.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.tab = btn.getAttribute('data-tab');
                this.root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
                this._paintList();
            }, { signal: this.signal });
        });

        await this._load(s.address);
        this._paintPassRow();
        this._paintList();
    }

    async _load(addr) {
        try {
            const api = await dexHeroTokensReady();
            const res = await api.getUserTokens(addr);
            const tokens = (res?.success && res.tokens) ? res.tokens : [];
            this.data.created = tokens;
            // Treat "created" as the proxy for holdings until an indexer is wired.
            this.data.holdings = tokens;
        } catch (err) {
            console.warn('[profile] load failed:', err.message);
            this.data.created = [];
            this.data.holdings = [];
        }

        // Drafts = generated Tripo models + paid-but-not-yet-deployed drafts.
        // The SPA panel was missing the get-session fetch, so rows in
        // dexhero_sessions never surfaced as drafts. Fetch BOTH and merge.
        try {
            const [paidRes, sessionsRes] = await Promise.all([
                fetch(`/api/dexhero/paid-drafts?wallet=${encodeURIComponent(addr)}`).then(r => r.json()).catch(() => null),
                fetch(`/api/dexhero/get-session?wallet=${encodeURIComponent(addr)}`).then(r => r.json()).catch(() => null),
            ]);
            const paid = (paidRes?.success && Array.isArray(paidRes.drafts)) ? paidRes.drafts : [];
            // Only completed-model session rows count as drafts. In-flight,
            // failed, and pre-Tripo abandoned rows are hidden — by user
            // request: "either CREATED or DRAFT". Nothing in between.
            const sessions = (sessionsRes?.success && Array.isArray(sessionsRes.data))
                ? sessionsRes.data.filter(s => !!s.model_url)
                : [];
            this.data.drafts = [
                ...paid.map(p => ({ ...p, _kind: 'paid' })),
                ...sessions.map(s => ({ ...s, _kind: 'session' })),
            ];
        } catch (err) {
            console.warn('[profile] drafts load failed:', err.message);
            this.data.drafts = [];
        }

        // Registered games — every game this wallet owns. /api/game/my-games
        // is the same endpoint the token-detail Games tab uses to populate
        // the developer link picker.
        try {
            const r = await fetch(`/api/game/my-games?wallet=${encodeURIComponent(addr)}`);
            const j = await r.json().catch(() => null);
            this.data.games = (j && Array.isArray(j.games)) ? j.games : [];
        } catch (err) {
            console.warn('[profile] games load failed:', err.message);
            this.data.games = [];
        }

        // Pass status — read against a fixed Sepolia RPC so the answer is
        // correct even if the wallet's currently on a different chain. The
        // row paints once data is in (rerender below in onMount).
        this.data.passActive = await verifyPass(addr);
    }

    _paintPassRow() {
        const host = this.root?.querySelector('[data-pass-row]');
        if (host) host.innerHTML = this._renderPassRow();
    }

    _renderPassRow() {
        const v = this.data.passActive;
        if (v === null) {
            return `
                <section class="panel-section" style="padding:0 4px;margin-bottom:14px;">
                    <div style="display:flex;align-items:center;gap:10px;color:var(--ink-3);font-family:var(--font-mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;">
                        <div class="hud-spin" style="width:12px;height:12px;"></div>
                        <span>Checking play pass…</span>
                    </div>
                </section>`;
        }
        if (v === true) {
            return `
                <section class="panel-section" style="padding:0;margin-bottom:14px;">
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid rgba(34,197,94,0.35);border-radius:var(--r-2);background:rgba(34,197,94,0.05);">
                        <span class="hud-dot hud-dot--live"></span>
                        <span style="flex:1;color:var(--ink-0);font-family:var(--font-mono);font-size:11.5px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;">Play Pass Active</span>
                    </div>
                </section>`;
        }
        return `
            <section class="panel-section" style="padding:0;margin-bottom:14px;">
                <a href="#/buy-pass?return=/profile" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px dashed rgba(6,182,212,0.45);border-radius:var(--r-2);background:linear-gradient(135deg,rgba(6,182,212,0.08),rgba(6,182,212,0.02));text-decoration:none;color:inherit;">
                    <span class="hud-dot hud-dot--idle"></span>
                    <span style="flex:1;color:var(--ink-1);font-family:var(--font-mono);font-size:11.5px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;">No Play Pass</span>
                    <span style="color:var(--acc-cyan);font-family:var(--font-mono);font-size:11px;font-weight:600;letter-spacing:0.22em;">Get Pass →</span>
                </a>
            </section>`;
    }

    _paintList() {
        const host = this.root.querySelector('[data-list]');
        if (!host) return;

        // Servers tab is its own renderer with its own polling lifecycle.
        if (this.tab === 'servers') {
            const addr = wallet.getStatus().address;
            this._paintServersTab();
            this._loadServers(addr).then(() => this._paintServersTab());
            this._startServerPoll(addr);
            return;
        }
        // All other tabs: stop the server poll if it was running.
        this._stopServerPoll();

        let list = this.data[this.tab] || [];

        // For the drafts tab: filter out any session whose model_url is
        // already in this wallet's deployed tokens — those are CREATED, not
        // drafts. Paid drafts always stay (their state is post-payment,
        // pre-deploy, so they're orthogonal to deployed tokens).
        if (this.tab === 'drafts') {
            const deployedUrls = new Set(
                (this.data.created || [])
                    .map(t => t.model_url)
                    .filter(Boolean)
            );
            list = list.filter(d => d._kind === 'paid' || !deployedUrls.has(d.model_url));
        }

        if (!list.length) {
            const cta = (this.tab === 'created' || this.tab === 'drafts')
                ? '<a class="hud-btn hud-btn--primary" href="#/create/dexhero">Create DexHero</a>'
                : this.tab === 'games'
                    ? '<a class="hud-btn hud-btn--primary" href="#/register-game">Register a game</a>'
                    : '';
            host.innerHTML = `
                <div class="panel-state">
                    <div class="panel-state__body">No ${this.tab} yet.</div>
                    ${cta}
                </div>`;
            return;
        }
        // Registered games — owner's developer-side list.
        if (this.tab === 'games') {
            const STATUS_COLOR = {
                active:  'var(--ok)',
                pending: 'var(--ink-2)',
                blocked: 'var(--err)',
            };
            host.innerHTML = `
                <div style="margin-bottom:12px;text-align:right;">
                    <a class="hud-btn hud-btn--sm" href="#/register-game">+ Register a game</a>
                </div>
                ${list.map((g) => {
                    const status = (g.status || 'pending').toLowerCase();
                    const color  = STATUS_COLOR[status] || 'var(--ink-3)';
                    const icon   = g.icon_url
                        ? `<img src="${sanitizeURL(g.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`
                        : `<span style="font-weight:700;color:var(--ink-2);">${escapeHTML((g.title || '?').charAt(0).toUpperCase())}</span>`;
                    return `
                        <a class="panel-row" href="#/game/${encodeURIComponent(g.id)}" style="--row-cols: 40px 1fr auto;">
                            <span style="width:40px;height:40px;border-radius:3px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;">
                                ${icon}
                            </span>
                            <span style="min-width:0;">
                                <span style="color:var(--ink-0);font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${escapeHTML(g.title || 'Untitled')}</span>
                                <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(g.slug ? '/' + g.slug : '')}</span>
                            </span>
                            <span style="color:${color};font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(status)}</span>
                        </a>`;
                }).join('')}`;
            return;
        }
        if (this.tab === 'drafts') {
            host.innerHTML = list.map((d) => {
                if (d._kind === 'session') {
                    // Generated Tripo model, not yet deployed → "Use Model".
                    // Prefer the front-view static image as the thumbnail
                    // (lightweight, no WebGL). Forward both the model URL
                    // AND the front-view image URL to the create page so it
                    // can populate the model viewer + the image preview.
                    const updated = d.updated_at ? new Date(d.updated_at).toLocaleDateString() : '';
                    const params = new URLSearchParams({ modelUrl: d.model_url, launchType: 'new' });
                    if (d.front_url) params.set('imageUrl', d.front_url);
                    const href = `#/create/dexhero?${params.toString()}`;
                    const thumbHtml = d.front_url
                        ? `<img src="${sanitizeURL(d.front_url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`
                        : `<model-viewer
                                src="${sanitizeURL(d.model_url)}"
                                auto-rotate
                                rotation-per-second="20deg"
                                disable-zoom disable-pan disable-tap
                                interaction-prompt="none"
                                camera-orbit="0deg 90deg 110%"
                                autoplay
                                animation-name="walk_in_place"
                                style="width:100%;height:100%;background:transparent;--poster-color:transparent;"
                            ></model-viewer>`;
                    return `
                        <a class="panel-row" href="${href}" style="--row-cols: 40px 1fr auto;">
                            <span style="width:40px;height:40px;border-radius:3px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;">
                                ${thumbHtml}
                            </span>
                            <span style="min-width:0;">
                                <span style="color:var(--ink-0);font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">Generated DexHero</span>
                                <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">DRAFT${updated ? ' · ' + escapeHTML(updated) : ''}</span>
                            </span>
                            <span style="color:var(--ink-2);font-size:12px;letter-spacing:0.18em;text-transform:uppercase;">Use Model</span>
                        </a>`;
                }
                // Paid draft (existing render path)
                const p = d.params || {};
                const name = p.name || p.tokenName || 'Untitled';
                const symbol = p.symbol || p.tokenSymbol || '';
                const img = p.image_url || p.imageUrl || p.thumbnail_url;
                const status = (d.status || 'paid').toUpperCase();
                return `
                    <a class="panel-row" href="#/create/dexhero?draft=${encodeURIComponent(d.id)}" style="--row-cols: 40px 1fr auto;">
                        <span style="width:40px;height:40px;border-radius:3px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;">
                            ${img ? `<img src="${sanitizeURL(img)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-weight:700;color:var(--ink-2);">${escapeHTML(String(name).charAt(0))}</span>`}
                        </span>
                        <span style="min-width:0;">
                            <span style="color:var(--ink-0);font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${escapeHTML(name)}</span>
                            <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(symbol)}${symbol ? ' · ' : ''}${escapeHTML(status)}</span>
                        </span>
                        <span style="color:var(--ink-2);font-size:12px;font-variant-numeric:tabular-nums;">${d.fee_amount_usdc ? '$' + fmtNum(d.fee_amount_usdc) : '—'}</span>
                    </a>`;
            }).join('');
            return;
        }
        host.innerHTML = list.map((t) => {
            const addr = t.manager_address || t.contract_address || t.id;
            const img  = t.image_url || t.thumbnail_url;
            return `
                <a class="panel-row" href="#/token/${encodeURIComponent(addr)}" style="--row-cols: 40px 1fr auto;">
                    <span style="width:40px;height:40px;border-radius:3px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;">
                        ${img ? `<img src="${sanitizeURL(img)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-weight:700;color:var(--ink-2);">${escapeHTML((t.name || '?').charAt(0))}</span>`}
                    </span>
                    <span style="min-width:0;">
                        <span style="color:var(--ink-0);font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${escapeHTML(t.name || 'Untitled')}</span>
                        <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(t.symbol || '')}${t.chain ? ' · ' + escapeHTML(t.chain) : ''}</span>
                    </span>
                    <span style="color:var(--ink-2);font-size:12px;font-variant-numeric:tabular-nums;">${t.market_cap ? '$' + fmtNum(t.market_cap) : (t.games_count ? t.games_count + ' games' : '—')}</span>
                </a>`;
        }).join('');
    }

    /* ── Servers tab ─────────────────────────────────────────────
       Replaces what used to be on the Host page. Onboarding (pass +
       install) still lives at #/host; this tab is the day-to-day
       management view: relay status, configured games, pending matches. */

    onUnmount() {
        this._stopServerPoll();
    }

    _startServerPoll(addr) {
        this._stopServerPoll();
        if (!addr) return;
        this._serverPoll = setInterval(async () => {
            if (this.tab !== 'servers') return; // user switched tabs
            await this._loadServers(addr);
            this._paintServersTab();
        }, 5000);
    }

    _stopServerPoll() {
        if (this._serverPoll) { clearInterval(this._serverPoll); this._serverPoll = null; }
    }

    async _loadServers(addr) {
        if (!addr) return;
        try {
            const [nodeRes, catalogRes, pendingRes] = await Promise.all([
                fetch(`/api/node/games?wallet=${encodeURIComponent(addr)}`).then(r => r.json()).catch(() => null),
                fetch('/api/games?limit=100').then(r => r.json()).catch(() => null),
                fetch(`/api/node/pending-matches?wallet=${encodeURIComponent(addr)}`).then(r => r.json()).catch(() => null),
            ]);
            this.serverData.node    = nodeRes?.node || null;
            this.serverData.myGames = (nodeRes?.games || []).map((g) => g.id);
            this.serverData.catalog = catalogRes?.games || [];
            this.serverData.pending = pendingRes?.sessions || [];
        } catch (err) {
            console.warn('[profile/servers] load failed:', err.message);
        }
    }

    _paintServersTab() {
        const slot = this.root?.querySelector('[data-list]');
        if (!slot) return;
        const n = this.serverData.node;
        const relayCapable = !!(n && n.relayCapable);
        const disabledAttr = relayCapable ? '' : 'style="opacity:0.45;pointer-events:none;"';
        const myAddr = wallet.getStatus().address || '';
        const refUrl = myAddr ? `${location.origin}/#/host?ref=${myAddr}` : '';

        slot.innerHTML = `
            ${this._renderRelayBlock(n, relayCapable)}

            ${relayCapable ? '' : `
                <div class="panel-section" style="border-left:2px solid var(--acc-warn,#f59e0b);padding-left:12px;color:var(--ink-2);font-size:12px;">
                    Complete relay qualification before configuring games or accepting sessions.
                    Don't have the host app yet? <a href="#/host" style="color:var(--acc-cyan);">Install it from the Host page →</a>
                </div>`}

            ${refUrl ? `
                <section class="panel-section">
                    <div class="hud-display" style="font-size:13px;margin-bottom:8px;">Refer a host</div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <code style="flex:1;padding:8px 10px;background:var(--surf-2);border:1px solid rgba(6,182,212,0.18);border-radius:3px;font-size:11px;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(refUrl)}</code>
                        <button class="hud-btn hud-btn--sm" data-copy-ref>Copy</button>
                    </div>
                </section>` : ''}

            <section class="panel-section" data-section="games" ${disabledAttr}>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div class="hud-display" style="font-size:13px;">Games you stream</div>
                    <button class="hud-btn hud-btn--sm" data-save-games disabled>Save</button>
                </div>
                <div data-games-list></div>
            </section>

            <section class="panel-section" data-section="pending" ${disabledAttr}>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div class="hud-display" style="font-size:13px;">Incoming match requests</div>
                    <div class="hud-label" data-pending-meta>Polling…</div>
                </div>
                <div data-pending-list></div>
            </section>`;

        const copyBtn = slot.querySelector('[data-copy-ref]');
        if (copyBtn && refUrl) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(refUrl);
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
                } catch { /* noop */ }
            });
        }

        this._paintGamesGrid();
        this._paintPendingList();
        this._wireServerActions();
    }

    _renderRelayBlock(n, relayCapable) {
        if (!n) {
            return `
                <section class="panel-section" data-section="relay">
                    <div class="hud-display" style="font-size:13px;margin-bottom:8px;">Network & Relay Status</div>
                    <div class="panel-state" style="padding:12px;">
                        <div class="hud-spin" style="margin-right:8px;"></div>
                        <div>Waiting for the DexHero Host agent to register…</div>
                    </div>
                    <div class="hud-label" style="margin-top:10px;font-size:11px;">Start the agent on your host machine. It will self-probe via the backend; results appear here within a few seconds. Need the installer? <a href="#/host" style="color:var(--acc-cyan);">Get it on the Host page →</a></div>
                </section>`;
        }
        if (relayCapable) {
            return `
                <section class="panel-section" data-section="relay">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <div class="hud-display" style="font-size:13px;">Network & Relay Status</div>
                        <button class="hud-btn hud-btn--sm" data-retest>Re-run probe</button>
                    </div>
                    <div class="panel-row" style="--row-cols: 110px 1fr;">
                        <div class="hud-label">Reachable</div>
                        <div style="display:flex;align-items:center;gap:8px;"><span class="hud-dot hud-dot--live"></span><span>Qualified to host · ${escapeHTML(n.publicIp || '—')}:${n.relayPort || '—'}</span></div>
                    </div>
                    <div class="panel-row" style="--row-cols: 110px 1fr;">
                        <div class="hud-label">NAT type</div>
                        <div>${escapeHTML(n.natType || 'unknown')}</div>
                    </div>
                    <div class="panel-row" style="--row-cols: 110px 1fr;">
                        <div class="hud-label">Last probe</div>
                        <div>${n.relayTestPassedAt ? new Date(n.relayTestPassedAt).toLocaleString() : '—'}</div>
                    </div>
                </section>`;
        }
        return `
            <section class="panel-section" data-section="relay" style="border-left:2px solid var(--acc-err,#ef4444);padding-left:12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div class="hud-display" style="font-size:13px;">Network & Relay Status</div>
                    <button class="hud-btn hud-btn--sm" data-retest>Re-run probe</button>
                </div>
                <div class="panel-row" style="--row-cols: 110px 1fr;">
                    <div class="hud-label">Reachable</div>
                    <div style="display:flex;align-items:center;gap:8px;"><span class="hud-dot hud-dot--idle"></span><span>Unreachable — see remediation below</span></div>
                </div>
                <div class="hud-label" style="margin-top:10px;font-size:12px;color:var(--ink-1);">Fixes, in order of simplicity:</div>
                <ol style="margin:8px 0 0 20px;color:var(--ink-2);font-size:12px;line-height:1.7;">
                    <li>Forward UDP port 47989 in your router settings.</li>
                    <li>Enable UPnP on your router (auto-opens ports).</li>
                    <li>Enable IPv6 on your connection — no NAT means no relay problem.</li>
                    <li>If on mobile / carrier-grade NAT (CGNAT), switch ISPs or use a home fiber line.</li>
                </ol>
            </section>`;
    }

    _paintGamesGrid() {
        const host = this.root?.querySelector('[data-games-list]');
        if (!host) return;
        const catalog = this.serverData.catalog || [];
        if (!catalog.length) {
            host.innerHTML = `<div class="panel-state"><div class="panel-state__body">No games registered yet. <a href="#/register-game">Register a game</a> to populate the catalog.</div></div>`;
            return;
        }
        const set = new Set(this.serverData.myGames);
        host.innerHTML = catalog.map((g) => {
            const checked = set.has(g.id) ? 'checked' : '';
            const icon = g.icon_url
                ? `<img src="${sanitizeURL(g.icon_url)}" style="width:32px;height:32px;border-radius:3px;object-fit:cover;">`
                : `<div style="width:32px;height:32px;border-radius:3px;background:var(--surf-2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--ink-2);">${escapeHTML((g.title || '?').charAt(0))}</div>`;
            return `
                <label class="panel-row" style="--row-cols: auto 32px 1fr auto;cursor:pointer;">
                    <input type="checkbox" data-game-id="${escapeHTML(g.id)}" ${checked} style="width:16px;height:16px;">
                    ${icon}
                    <span style="min-width:0;">
                        <span style="color:var(--ink-0);font-weight:600;font-size:13px;display:block;">${escapeHTML(g.title)}</span>
                        <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(g.category || '—')}</span>
                    </span>
                    <span style="color:var(--ink-2);font-size:12px;">${g.availableHosts || 0} host${g.availableHosts === 1 ? '' : 's'}</span>
                </label>`;
        }).join('');
    }

    _paintPendingList() {
        const host = this.root?.querySelector('[data-pending-list]');
        const meta = this.root?.querySelector('[data-pending-meta]');
        if (!host) return;
        const list = this.serverData.pending || [];
        if (meta) meta.textContent = `${list.length} active · refreshing every 5s`;
        if (!list.length) {
            host.innerHTML = `<div class="panel-state"><div class="panel-state__body">No pending matches. Once you're online with at least one game selected, players can request you.</div></div>`;
            return;
        }
        const cat = new Map(this.serverData.catalog.map((g) => [g.id, g]));
        host.innerHTML = list.map((s) => {
            const game = cat.get(s.game_id);
            const hasConnect = !!s.connect_info;
            const cover = game?.cover_url || game?.icon_url || '';
            const coverImg = cover
                ? `<img src="${escapeHTML(cover)}" alt="" style="width:48px;height:48px;border-radius:4px;object-fit:cover;flex-shrink:0;background:var(--surf-2);">`
                : `<div style="width:48px;height:48px;border-radius:4px;background:var(--surf-2);flex-shrink:0;"></div>`;
            return `
                <div class="panel-row" style="--row-cols: 1fr auto;flex-direction:column;align-items:stretch;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        ${coverImg}
                        <div style="flex:1;min-width:0;">
                            <div style="color:var(--ink-0);font-weight:600;font-size:13px;">${escapeHTML(game?.title || s.game_id)}</div>
                            <div style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${fmtAddress(s.player_wallet)} · ${escapeHTML(s.status)}</div>
                        </div>
                        <div class="hud-label" style="font-variant-numeric:tabular-nums;">${s.initial_rtt_ms ? s.initial_rtt_ms + ' ms' : '—'}</div>
                    </div>
                    <div style="margin-top:8px;color:var(--ink-2);font-size:11px;">
                        ${hasConnect
                            ? `Connect-info published — ${escapeHTML(s.connect_info.host)}:${s.connect_info.port}`
                            : `Waiting for node agent to publish host + WebSocket bridge URL`}
                    </div>
                </div>`;
        }).join('');
    }

    _wireServerActions() {
        const root = this.root;
        if (!root) return;
        // Re-run probe — driven by the host agent on the user's machine; we
        // can only nudge them to restart it from the browser.
        root.querySelector('[data-retest]')?.addEventListener('click', () => {
            alert('Re-run the DexHero Host agent on your machine. It will self-probe on startup and the result will appear here within a few seconds.');
        }, { signal: this.signal });

        // Game checkbox: enable Save when the selection diverges from saved.
        root.querySelectorAll('[data-game-id]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const btn = root.querySelector('[data-save-games]');
                if (btn) btn.disabled = false;
            }, { signal: this.signal });
        });

        // Save: sign a wallet message + POST to /api/node/games.
        const btn = root.querySelector('[data-save-games]');
        const addr = wallet.getStatus().address;
        btn?.addEventListener('click', async () => {
            const checked = Array.from(root.querySelectorAll('[data-game-id]:checked')).map((el) => el.getAttribute('data-game-id'));
            btn.disabled = true;
            btn.textContent = 'Signing…';
            try {
                const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
                const message = `DexHero node games: ${addr.toLowerCase()} ${minuteBucket}`;
                const signature = await wallet.signMessage(message);
                btn.textContent = 'Saving…';
                const r = await fetch('/api/node/games', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ wallet: addr, gameIds: checked, signature }),
                });
                if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
                this.serverData.myGames = checked;
                btn.textContent = 'Saved';
                setTimeout(() => { btn.textContent = 'Save'; }, 1500);
            } catch (err) {
                btn.textContent = 'Save failed';
                alert(err.message || 'Save failed');
                btn.disabled = false;
                setTimeout(() => { btn.textContent = 'Save'; }, 2000);
            }
        }, { signal: this.signal });
    }
}

async function dexHeroTokensReady(timeoutMs = 5000) {
    if (window.DexHeroTokens) return window.DexHeroTokens;
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (window.DexHeroTokens) return resolve(window.DexHeroTokens);
            if (Date.now() > deadline) return reject(new Error('DexHeroTokens not available'));
            setTimeout(tick, 80);
        };
        tick();
    });
}
