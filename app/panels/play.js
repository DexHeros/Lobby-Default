/* Play panel — the player's streaming engine.
   Two-click entry: any game card → game detail page (which shows a "Choose
   your DexHero" roster) → DexHero pick navigates here as
   #/play?game=<id>&hero=<dexheroId>. The pre-set game + hero skip the
   browse + select-dexhero views and go straight to matchmaking. Direct
   navigation to /#/play (no params) still works as a fallback browse view. */

import { Panel, escapeHTML, fmtAddress } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import * as sb from '../services/supabase.js';
import { steamFetch, steamHeader } from '../services/steam-session.js';
import { on, E } from '../events.js';
import { startSession as startSessionAttestor } from '../services/session-attestor.js';
import { loadDeployments, getDeployment } from '/js/blockchain/deployments-loader.js';

(function loadStyles() {
    if (document.querySelector('link[data-panel-css="host-play-hud"]')) return;
    const l = document.createElement('link');
    l.rel  = 'stylesheet';
    l.href = '/styles/panels/host-play-hud.css';
    l.setAttribute('data-panel-css', 'host-play-hud');
    document.head.appendChild(l);
})();

export default class PlayPanel extends Panel {
    static id        = 'play';
    static variant   = 'right';
    static width     = 640;
    static title     = 'Project WarpStream';
    static titleBreadcrumb = ['PROJECT WARPSTREAM'];
    static stageMode = 'dim';
    // Back-arrow target. When the player landed on /play with a specific
    // game context (`?steamAppid=N` from a Steam game-detail page or
    // `?game=<id>` from a first-party detail page), back returns there
    // so they can keep browsing other games. Direct nav to /play with no
    // context falls back to the lobby.
    static parentHash = (params) => {
        if (params?.steamAppid) return `#/game/${params.steamAppid}`;
        if (params?.game)       return `#/game/${params.game}`;
        return '#/';
    };

    constructor(params) {
        super(params);
        this.view = 'browse';   // 'browse' | 'select-dexhero' | 'matching' | 'ready' | 'streaming'
        this.catalog = [];
        this.selectedGame = null;
        this.dexheros = [];
        this.selectedDexhero = null;
        this.sessionId = null;
        this.connectInfo = null;
        this.session = null;
        this._pollTimer = null;
        this._player = null;
        this._sessionChannel = null;
        this._steamCreds = null;
        // P1.3 — ephemeral session attestor. Populated after the one-shot
        // delegation popup is signed; passed into DexHeroPlayer so its 60s
        // tick can sign + POST attestations without further wallet popups.
        this._attestor = null;
        this._pendingGameId = params.game || null;
        // Steam-titled session — params.steamAppid is the Steam app id
        // (numeric). Mutually exclusive with params.game; the matchmaker
        // backend branches on which one's set.
        this._pendingSteamAppid = params.steamAppid ? Number(params.steamAppid) : null;
        // Pre-picked DexHero ID — when navigating from a game detail page's
        // "Choose your DexHero" roster, the chosen DexHero is passed via
        // ?hero=<id>. _enterSelectDexhero auto-advances to matchmaking
        // without showing the picker UI.
        this._pendingHeroId = params.hero || null;
        // Pre-picked Steam character/loadout — used for Steam titles that
        // expose a per-game character picker (Dota 2 heroes, TF2 classes,
        // CS2 agents, etc.). Forwarded to the host so it can spawn the
        // session into the chosen character/loadout. Always paired with
        // params.steamAppid; ignored on first-party flows.
        this._pendingSteamCharacter = params.character || null;
        // Pre-picked Steam inventory item (e.g. CS2 skin / Rust outfit).
        // Same forwarding pattern as character.
        this._pendingSteamItem      = params.item      || null;
        // Warm-handoff deep link: #/play?resume=<sessionId> jumps straight
        // back into a session that was just reassigned to a new host. We
        // skip browse + matching and go directly to connect-info polling.
        this._resumeSessionId = params.resume || null;
        // Server-side BROWSER_PLAY_LIVE feature flag. `null` = not yet
        // fetched (render shows a brief loading state); `true` mounts the
        // normal flow; `false` shows the "Cloud play is launching soon"
        // card. The flag exists so the operator can flip it from Render
        // env vars without redeploying — useful when the WASM build is
        // mid-rollout or has been rolled back.
        this.flags = null;
    }

    render() {
        const s = wallet.getStatus();

        // Feature-flag gate. /api/waitlist/feature-flags returns
        // browserPlayLive; while loading we show a thin spinner, when
        // explicitly false we show the "launching soon" card and stop
        // there. Active sessions (an already-streaming view) bypass the
        // gate so a session in flight doesn't get yanked when an operator
        // flips the flag mid-play.
        if (this.flags === null && this.view === 'browse') {
            return `<section class="panel-section"><div class="hud-spin"></div><div class="hud-label" style="margin-top:8px;">Loading…</div></section>`;
        }
        if (this.flags && this.flags.browserPlayLive === false && this.view !== 'streaming' && this.view !== 'ready') {
            const liveGated = this.flags.browserPlayLive === false;
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame hpd-frame--lit">
                        <div class="hpd-frame__corners"></div>
                        <div class="hpd-eyebrow-row">
                            <span class="hpd-eyebrow" data-eyebrow-status>
                                <span class="hpd-eyebrow__led ${liveGated ? 'hpd-eyebrow__led--standby' : 'hpd-eyebrow__led--ok'}"></span>
                                <span data-eyebrow-label>Project WarpStream · ${liveGated ? 'Standby' : 'Live'}</span>
                            </span>
                            <span class="hpd-ping-pill" data-ping-self-pill hidden>
                                <span class="hpd-ping-pill__label">Ping</span>
                                <span class="hpd-ping-pill__val" data-ping-self>—</span>
                                <span class="hpd-ping-pill__unit">ms</span>
                            </span>
                        </div>

                        <div class="hpd-server-list" data-region-list>
                            <div class="hpd-server-row hpd-server-row--placeholder">
                                <span class="hpd-server-row__name">Loading regions…</span>
                            </div>
                        </div>

                        ${liveGated ? `
                        <div class="hpd-divider">
                            <span class="hpd-divider__line"></span>
                            <span class="hpd-divider__tag">Standby</span>
                            <span class="hpd-divider__line"></span>
                        </div>
                        <p class="hpd-subline" style="margin-bottom:12px;">
                            Matchmaking opens region-by-region with the v1.1 WASM build. Drop into the host pool now and you'll be early.
                        </p>
                        <a class="hpd-cta hpd-cta--secondary" href="#/host">
                            <span>Become a host</span>
                            <span class="hpd-cta__chev">→</span>
                        </a>` : ''}
                    </div>
                </section>`;
        }

        // If the user disconnected mid-flow, drop back to the open browse view
        // rather than render a half-state that depends on a wallet address.
        if (!s.connected && this.view !== 'browse') {
            this.view = 'browse';
            this.selectedGame = null;
            this.dexheros = [];
            this.selectedDexhero = null;
        }

        // Browse is open to everyone — wallet only required when the user
        // actually picks a game to play. The header reflects state but never
        // gates the catalog below.
        const header = s.connected
            ? `<section class="panel-section">
                <div style="display:flex;align-items:center;gap:16px;">
                    <div style="width:48px;height:48px;border-radius:50%;background:var(--acc-gradient);flex-shrink:0;"></div>
                    <div style="flex:1;min-width:0;">
                        <div class="hud-display" style="font-size:16px;letter-spacing:0.2em;">${fmtAddress(s.address)}</div>
                        <div class="hud-label" style="margin-top:4px;">Ready to play</div>
                    </div>
                </div>
            </section>`
            : `<section class="panel-section">
                <div style="display:flex;align-items:center;gap:16px;">
                    <div style="width:48px;height:48px;border-radius:50%;background:var(--acc-gradient);flex-shrink:0;opacity:0.5;"></div>
                    <div style="flex:1;min-width:0;">
                        <div class="hud-display" style="font-size:16px;letter-spacing:0.2em;">Browsing</div>
                        <div class="hud-label" style="margin-top:4px;">Connect a wallet to play</div>
                    </div>
                    <button class="hud-btn hud-btn--primary hud-btn--sm" data-connect>Connect</button>
                </div>
            </section>`;

        if (this.view === 'browse') {
            return header + `
                <section class="panel-section">
                    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                        <input data-search class="hud-input" type="search" placeholder="Search games…" style="flex:1;padding:8px 10px;background:var(--surf-2);border:1px solid var(--surf-3);color:var(--ink-0);border-radius:3px;font-size:13px;">
                    </div>
                    <div data-catalog>
                        <div class="panel-state"><div class="hud-spin"></div><div>Loading library…</div></div>
                    </div>
                </section>`;
        }
        if (this.view === 'select-dexhero') {
            const g = this.selectedGame;
            return header + `
                <section class="panel-section">
                    <button class="hud-btn hud-btn--sm" data-back-to-browse style="margin-bottom:10px;">← Games</button>
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                        ${g.icon_url ? `<img src="${escapeHTML(g.icon_url)}" style="width:48px;height:48px;border-radius:4px;object-fit:cover;">` : ''}
                        <div>
                            <div class="hud-display" style="font-size:15px;">${escapeHTML(g.title)}</div>
                            <div class="hud-label">${g.availableHosts} host${g.availableHosts === 1 ? '' : 's'} online · ${escapeHTML(g.category || '—')}</div>
                        </div>
                    </div>
                    <div class="hud-label" style="margin:12px 0 8px;">Pick the DexHero you'll play as:</div>
                    <div data-dexheros>
                        <div class="panel-state"><div class="hud-spin"></div><div>Loading your DexHeros…</div></div>
                    </div>
                </section>`;
        }
        if (this.view === 'matching') {
            return header + `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div class="hpd-frame hpd-frame--lit">
                        <div class="hpd-frame__corners"></div>
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led"></span>
                            Matchmaking · Active
                        </span>
                        <h1 class="hpd-display hpd-display--md">Finding the best host</h1>
                        <p class="hpd-subline" data-status>Creating session…</p>
                        <div class="hpd-meter hpd-meter--lit"><div class="hpd-meter__fill" style="width:35%;"></div></div>
                        <div style="margin-top:18px;">
                            <button class="hpd-cta hpd-cta--secondary" data-cancel type="button">
                                <span>Cancel</span>
                                <span class="hpd-cta__chev">×</span>
                            </button>
                        </div>
                    </div>
                </section>`;
        }
        if (this.view === 'ready' || this.view === 'streaming') {
            const ledClass = this.view === 'streaming' ? 'hpd-eyebrow__led--ok' : '';
            const statusLabel = this.view === 'streaming' ? 'Live' : 'Connecting';
            return `
                <section class="panel-section" style="padding:0;background:transparent;border:0;">
                    <div data-video-wrap style="position:relative;width:100%;background:#000;aspect-ratio:16/9;overflow:hidden;border-radius:2px;">
                        <video data-video autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000;"></video>
                        <div class="hpd-stream" data-hud>
                            <span class="hpd-stream__bracket hpd-stream__bracket--tl"></span>
                            <span class="hpd-stream__bracket hpd-stream__bracket--tr"></span>
                            <span class="hpd-stream__bracket hpd-stream__bracket--bl"></span>
                            <span class="hpd-stream__bracket hpd-stream__bracket--br"></span>
                            <span class="hpd-stream__pill">
                                <span class="hpd-eyebrow__led ${ledClass}"></span>
                                <span data-hud-status>${statusLabel}</span>
                                <span class="hpd-stream__pill-sub" data-hud-host>· ${fmtAddress(this.session?.nodeWallet)}</span>
                            </span>
                            <span class="hpd-stream__metrics">
                                <span class="hpd-stream__metric"><strong data-hud-rtt>—</strong><span class="hpd-stream__metric-unit">ms</span></span>
                                <span class="hpd-stream__metric"><strong data-hud-fps>—</strong><span class="hpd-stream__metric-unit">fps</span></span>
                                <span class="hpd-stream__metric"><strong data-hud-bitrate>—</strong><span class="hpd-stream__metric-unit">kbps</span></span>
                                <span class="hpd-stream__metric" data-hud-drops-wrap hidden><strong data-hud-drops>0</strong><span class="hpd-stream__metric-unit">drop/s</span></span>
                            </span>
                            <button class="hpd-stream__disconnect" data-disconnect type="button">Disconnect</button>
                        </div>
                    </div>
                </section>`;
        }
        return header;
    }

    async onMount() {
        // Auto-rerender on wallet state change so connecting via the header
        // modal updates this panel without a manual reload/renavigation.
        const unsub = on(E.WALLET_CHANGED, () => {
            this.rerender();
            this.onMount();
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });

        // Load the BROWSER_PLAY_LIVE flag before doing anything else.
        // Skip the fetch if we already have it (avoids re-render loops via
        // WALLET_CHANGED) or if we're already inside a streaming view that
        // bypasses the gate.
        if (this.flags === null) await this._loadFlags();
        if (this.flags && this.flags.browserPlayLive === false &&
            this.view !== 'streaming' && this.view !== 'ready') {
            // Gate active — render() returned the server-browser placeholder.
            // Wire the region rows + ping measurement so the card is live.
            this._wireServerBrowser();
            return;
        }

        // Connect button (rendered only when not connected) — the rest of the
        // panel is reachable without it.
        this.root.querySelector('[data-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });

        if (this._resumeSessionId && this.view === 'browse') {
            await this._enterResume(this._resumeSessionId);
            return;
        }
        if (this.view === 'browse') await this._enterBrowse();
        else if (this.view === 'select-dexhero') await this._enterSelectDexhero();
        else if (this.view === 'matching') this._wireCancel();
        else if (this.view === 'ready' || this.view === 'streaming') this._wireStreaming();
    }

    async _loadFlags() {
        try {
            const r = await fetch('/api/waitlist/feature-flags');
            if (r.ok) {
                this.flags = await r.json();
                this.rerender();
            } else {
                // 4xx/5xx: assume on (don't lock the panel out for an
                // unrelated server hiccup). The launch-soon card is for
                // an explicit "false", not "unknown".
                this.flags = { browserPlayLive: true };
            }
        } catch {
            this.flags = { browserPlayLive: true };
        }
    }

    async _enterResume(sessionId) {
        // Warm-handoff: matchmaker has already reassigned this session to a
        // new host. Skip browse + matching, jump straight to connect-info
        // polling. Wallet must be connected — credentials and session
        // ownership were verified server-side at reassign time.
        const w = wallet.getStatus();
        if (!w?.connected) {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
            return;
        }
        this.sessionId = sessionId;
        this.view = 'matching';
        this.rerender();
        this._wireCancel();
        const setStatus = (msg) => { const el = this.root.querySelector('[data-status]'); if (el) el.textContent = msg; };
        setStatus('Reconnecting you to a server…');

        // Reuse the connect-info poller from the normal matching flow.
        const addr = w.address;
        this._pollTimer = setInterval(async () => {
            if (!this.sessionId) return;
            try {
                const cRes = await fetch(`/api/session/${encodeURIComponent(this.sessionId)}/connect-info?wallet=${encodeURIComponent(addr)}`).then((r) => r.json()).catch(() => null);
                if (cRes?.connectInfo && cRes.status !== 'ended' && cRes.status !== 'failed') {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                    this.session = { nodeWallet: cRes.nodeWallet, playerWallet: cRes.playerWallet };
                    this.connectInfo = cRes.connectInfo;
                    this.view = 'ready';
                    this.rerender();
                    this._wireStreaming();
                    this._launchPlayer();
                } else if (cRes?.status === 'failed' || cRes?.status === 'ended') {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                    setStatus(`Session ${cRes.status}. Returning to library.`);
                    setTimeout(() => { this.view = 'browse'; this.sessionId = null; this.rerender(); this._enterBrowse(); }, 1500);
                }
            } catch { /* ignore transient */ }
        }, 2000);
    }

    async _enterBrowse() {
        try {
            const r = await fetch('/api/games?limit=80');
            const j = await r.json();
            this.catalog = j.games || [];
        } catch (err) {
            console.warn('[play] catalog load:', err.message);
        }
        this._paintCatalog();
        const searchEl = this.root.querySelector('[data-search]');
        if (searchEl) searchEl.addEventListener('input', () => this._paintCatalog(searchEl.value), { signal: this.signal });

        // Deep-link auto-advance: if the user landed here from a game card
        // (#/play?game=<id> first-party OR #/play?steamAppid=<n> Steam),
        // skip straight to the DexHero selection. If they aren't connected
        // yet, prompt the wallet — once connected the WALLET_CHANGED
        // rerender re-enters here and resumes.
        if (this._pendingSteamAppid) {
            // Steam path — wallet-free. Validate Steam sign-in via cookie.
            // If not signed in, kick off Steam OpenID with return=<this
            // play URL> so the user lands back here after auth instead of
            // having to re-navigate.
            let steamMe = null;
            try {
                const w = wallet.getStatus();
                const qs = w.connected ? `?wallet=${encodeURIComponent(w.address)}` : '';
                steamMe = await steamFetch(`/api/steam/me${qs}`).then((r) => r.json()).catch(() => ({ linked: false }));
                if (!steamMe?.linked) {
                    const ret = encodeURIComponent(location.hash || `#/play?steamAppid=${this._pendingSteamAppid}`);
                    window.location.href = `/api/steam/auth/begin?return=${ret}`;
                    return;
                }
            } catch {
                const ret = encodeURIComponent(location.hash || `#/play?steamAppid=${this._pendingSteamAppid}`);
                window.location.href = `/api/steam/auth/begin?return=${ret}`;
                return;
            }
            try {
                const meta = await fetch(`/api/steam/app-meta?appid=${this._pendingSteamAppid}`).then((r) => r.json());
                this.selectedGame = {
                    id:              `steam-${this._pendingSteamAppid}`,
                    steam_appid:     this._pendingSteamAppid,
                    title:           meta?.name || `Steam app ${this._pendingSteamAppid}`,
                    icon_url:        meta?.header_image || null,
                    requires_steam_login: true,
                };
            } catch {
                this.selectedGame = {
                    id:              `steam-${this._pendingSteamAppid}`,
                    steam_appid:     this._pendingSteamAppid,
                    title:           `Steam app ${this._pendingSteamAppid}`,
                    requires_steam_login: true,
                };
            }
            this._pendingSteamAppid = null;
            // Wallet-free Steam play: skip the DexHero picker entirely. The
            // synthetic "steam:<id>" identifier flows through downstream
            // session-status / connect-info polls so the existing wallet-
            // keyed lookups stay simple. If the user IS wallet-connected
            // AND Steam-linked we still skip the picker for Steam titles
            // (per product directive: Steam doesn't gate on DexHero NFT).
            this.selectedDexhero = null;
            const w = wallet.getStatus();
            const synth = w.connected
                ? w.address
                : `steam:${steamMe.steam_id_64}`;
            this.view = 'matching';
            this.rerender();
            this._startMatchmaking(synth);
            return;
        }
        if (this._pendingGameId) {
            const g = this.catalog.find((x) => x.id === this._pendingGameId);
            if (g) {
                this.selectedGame = g;
                if (!wallet.isConnected()) {
                    try {
                        if (typeof window.openConnectModal === 'function') window.openConnectModal();
                        else wallet.connect().catch(() => {});
                    } catch {}
                    return;
                }
                this._pendingGameId = null;
                this.view = 'select-dexhero';
                this.rerender();
                this._enterSelectDexhero();
            }
        }
    }

    _paintCatalog(query = '') {
        const host = this.root.querySelector('[data-catalog]');
        if (!host) return;
        const q = query.trim().toLowerCase();
        const list = this.catalog.filter((g) => !q || (g.title || '').toLowerCase().includes(q) || (g.category || '').toLowerCase().includes(q));
        if (!list.length) {
            host.innerHTML = `<div class="panel-state"><div class="panel-state__body">No games match. New games go live every week — try the <a href="#/market">market</a> for the latest catalog.</div></div>`;
            return;
        }
        // Each game opens its public detail page (#/game/:id) where the
        // visitor can browse the full roster of DexHeros approved for that
        // game and then pick one to play. Anchor tags (not buttons) so the
        // hash router takes over — open in same tab, no JS click handler
        // needed.
        host.innerHTML = list.map((g) => {
            const hostsLabel = g.availableHosts > 0
                ? `<span style="color:var(--acc-ok,#22c55e);">${g.availableHosts} host${g.availableHosts === 1 ? '' : 's'} online</span>`
                : `<span style="color:var(--ink-3);">No hosts online</span>`;
            const icon = g.icon_url ? `<img src="${escapeHTML(g.icon_url)}" style="width:40px;height:40px;border-radius:3px;object-fit:cover;">` : `<div style="width:40px;height:40px;border-radius:3px;background:var(--surf-2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--ink-2);">${escapeHTML((g.title || '?').charAt(0))}</div>`;
            return `
                <a class="panel-row" href="#/game/${encodeURIComponent(g.id)}" style="--row-cols: 40px 1fr auto;text-decoration:none;color:inherit;">
                    ${icon}
                    <span style="min-width:0;">
                        <span style="color:var(--ink-0);font-weight:600;font-size:13px;display:block;">${escapeHTML(g.title)}</span>
                        <span style="font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${hostsLabel}</span>
                    </span>
                    <span class="hud-label">Roster →</span>
                </a>`;
        }).join('');
    }

    async _enterSelectDexhero() {
        const s = wallet.getStatus();
        const addr = s.address;
        this.root.querySelector('[data-back-to-browse]')?.addEventListener('click', () => {
            this.view = 'browse';
            this.selectedGame = null;
            this.dexheros = [];
            this.selectedDexhero = null;
            this.rerender();
            this._enterBrowse();
        }, { signal: this.signal });

        const list = this.root.querySelector('[data-dexheros]');
        try {
            // Steam titles: any DexHero the wallet owns is a valid "ride"
            // (no game_token_links curation). First-party titles: filter
            // by /api/game/player/dexheros which checks game_token_links.
            const url = this.selectedGame.steam_appid
                ? `/api/dexheros?wallet=${encodeURIComponent(addr)}`
                : `/api/game/player/dexheros?wallet=${encodeURIComponent(addr)}&gameId=${encodeURIComponent(this.selectedGame.id)}`;
            const r = await fetch(url, { headers: { 'X-Internal-Game-Request': '1' } });
            const j = await r.json();
            this.dexheros = j.dexheros || j.tokens || [];
        } catch (err) {
            console.warn('[play] dexheros load:', err.message);
            this.dexheros = [];
        }
        if (!this.dexheros.length) {
            list.innerHTML = `
                <div class="panel-state">
                    <div class="panel-state__body">You don't own a DexHero compatible with this game.</div>
                    <a class="hud-btn hud-btn--primary hud-btn--sm" href="#/market/dexheros" style="margin-top:12px;">Browse DexHeros</a>
                </div>`;
            return;
        }

        // Pre-picked from the game detail page's "Choose your DexHero" roster
        // (#/play?game=<id>&hero=<dexheroId>). Skip the picker UI and start
        // matchmaking immediately.
        if (this._pendingHeroId) {
            const pre = this.dexheros.find((d) => d.id === this._pendingHeroId);
            if (pre) {
                this._pendingHeroId = null;
                this.selectedDexhero = pre;
                this._startMatchmaking(addr);
                return;
            }
            // If the hero ID didn't match (stale link, hero no longer compatible),
            // fall through to render the picker.
            this._pendingHeroId = null;
        }

        list.innerHTML = this.dexheros.map((d) => `
            <button class="panel-row" data-pick-dex="${escapeHTML(d.id)}" style="--row-cols: 40px 1fr auto;text-align:left;background:transparent;border:0;cursor:pointer;width:100%;">
                ${d.image_url ? `<img src="${escapeHTML(d.image_url)}" style="width:40px;height:40px;border-radius:3px;object-fit:cover;">` : `<div style="width:40px;height:40px;border-radius:3px;background:var(--surf-2);"></div>`}
                <span style="min-width:0;">
                    <span style="color:var(--ink-0);font-weight:600;font-size:13px;display:block;">${escapeHTML(d.name || d.id)}</span>
                    <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(d.access_type || 'access')}</span>
                </span>
                <span class="hud-btn hud-btn--primary hud-btn--sm">▶ Play</span>
            </button>
        `).join('');
        list.querySelectorAll('[data-pick-dex]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-pick-dex');
                this.selectedDexhero = this.dexheros.find((d) => d.id === id) || null;
                this._startMatchmaking(addr);
            }, { signal: this.signal });
        });
    }

    async _startMatchmaking(addr) {
        this.view = 'matching';
        this.rerender();
        this._wireCancel();

        const setStatus = (msg) => { const el = this.root.querySelector('[data-status]'); if (el) el.textContent = msg; };

        setStatus('Starting your game…');
        try {
            // Steam-only sessions (no wallet, no DexHero) authenticate via
            // the dx_steam_session cookie — server resolves the steam_id.
            // Wallet-bound sessions (Steam-linked or first-party) include
            // wallet + (for first-party) dexheroId.
            const isSteam = !!this.selectedGame.steam_appid;
            const reqBody = isSteam
                ? {
                    steamAppid: this.selectedGame.steam_appid,
                    ...(addr ? { wallet: addr } : {}),
                    ...(this.selectedDexhero?.id ? { dexheroId: this.selectedDexhero.id } : {}),
                    // Pre-picked character/loadout/item come straight off the
                    // game-detail page picker (Steam loadout endpoint). Forwarded
                    // to the matchmaker → host so the session spawns into the
                    // chosen identity. Pure passthrough — server treats them as
                    // opaque strings, host validates against its game registry.
                    ...(this._pendingSteamCharacter ? { steamCharacter: this._pendingSteamCharacter } : {}),
                    ...(this._pendingSteamItem      ? { steamItem:      this._pendingSteamItem      } : {}),
                  }
                : {
                    gameId: this.selectedGame.id,
                    dexheroId: this.selectedDexhero.id,
                    wallet: addr,
                  };
            const r = await fetch('/api/matchmaker/request-session', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...steamHeader() },
                credentials: 'include',
                body: JSON.stringify(reqBody),
            });
            // Rate-limited (429) — auto-bail back to browse with a short countdown.
            if (r.status === 429) {
                const j = await r.json().catch(() => ({}));
                const retryAfterSec = Number(r.headers.get('Retry-After')) || Math.ceil((j.retryAfterMs || 1000) / 1000);
                setStatus(`Slow down a sec — returning to library in ${retryAfterSec}s…`);
                setTimeout(() => { this.view = 'browse'; this.rerender(); this._enterBrowse(); }, Math.max(2000, retryAfterSec * 1000));
                return;
            }
            const j = await r.json();
            if (!j.sessionId) throw new Error(j.error || 'Failed to create session');
            this.sessionId = j.sessionId;
            setStatus('Finding the closest server…');
        } catch (err) {
            setStatus('Couldn\'t start the game — try again in a moment.');
            console.warn('[play] request-session error:', err.message);
            return;
        }

        // P1.3 — one-shot ephemeral-key delegation. Runs ONCE per session
        // immediately after the matchmaker hands us a sessionId. The player
        // sees a single MetaMask popup; from this point on, all per-minute
        // attestations are signed by an in-memory ephemeral key (no further
        // popups for the rest of the session). Page refresh discards the key
        // and naturally invalidates the delegation.
        const delegationOk = await this._delegateSessionKey(setStatus);
        if (!delegationOk) {
            // User rejected the popup OR the server didn't accept the
            // delegation. Cancel matchmaking and bounce back to browse.
            try { await fetch(`/api/matchmaker/cancel/${encodeURIComponent(this.sessionId)}`, { method: 'POST' }); } catch {}
            this.sessionId = null;
            setTimeout(() => { this.view = 'browse'; this.rerender(); this._enterBrowse(); }, 800);
            return;
        }

        // Steam-bring-your-own-account: if this title requires the player's
        // Steam credentials (steam_app_id present + game.requires_steam_login),
        // prompt now and stash before the host begins booting the player VM.
        // Cancelling aborts matchmaking. Both host and player must own the
        // game on their own Steam accounts — no Family Sharing fallback.
        if (this.selectedGame?.steam_app_id && this.selectedGame?.requires_steam_login !== false) {
            setStatus('Sign in to Steam to continue…');
            const creds = await this._promptSteamCredentials(this.selectedGame);
            if (!creds) {
                setStatus('Cancelled.');
                try { await fetch(`/api/matchmaker/cancel/${encodeURIComponent(this.sessionId)}`, { method: 'POST' }); } catch {}
                this.sessionId = null;
                setTimeout(() => { this.view = 'browse'; this.rerender(); this._enterBrowse(); }, 800);
                return;
            }
            try {
                await this._stashSteamCredentials(this.sessionId, creds);
            } catch (err) {
                console.warn('[play] credential stash failed:', err?.message || err);
                setStatus('Could not deliver Steam credentials. Try again.');
                return;
            }
            setStatus('Finding the closest server…');
        }

        // RTT-weighted matchmaking: fetch top 5 candidates, probe in parallel, pick lowest.
        // T1-02: handle three new error responses from the matchmaker:
        //   503 NO_HOST_HAS_GAME → redirect to Family Sharing fallback panel
        //   409 RTT_MISMATCH     → drop the suspect candidate and retry once
        //   429 RATE_LIMITED     → respect Retry-After + bail to browse
        let chosenWallet = null;
        let chosenRtt = null;
        const burned = new Set();   // candidates we've already tried + got RTT_MISMATCH for
        try {
            const candRes = await fetch(`/api/matchmaker/candidates/${encodeURIComponent(this.sessionId)}`);
            if (candRes.status === 429) return this._bailRateLimited(candRes);
            if (candRes.status === 503) {
                const j = await candRes.json().catch(() => ({}));
                if (j.error === 'NO_HOST_HAS_GAME') {
                    return this._noHostAvailable();
                }
            }
            const candJson = await candRes.json();
            const candidates = (candJson.candidates || []).filter((c) => !burned.has(c.wallet));
            if (!candidates.length) {
                const matchRes = await fetch('/api/matchmaker/match', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId: this.sessionId, wallet: addr }),
                });
                if (matchRes.status === 429) return this._bailRateLimited(matchRes);
                if (matchRes.status === 503) {
                    const j = await matchRes.json().catch(() => ({}));
                    if (j.error === 'NO_HOST_HAS_GAME') {
                        return this._noHostAvailable();
                    }
                }
            } else {
                setStatus(`Checking ${candidates.length} servers…`);
                const probes = await Promise.all(candidates.map(async (c) => {
                    if (!c.publicIp || !c.relayPort) return { wallet: c.wallet, rtt: Infinity };
                    const rtt = await this._probeRtt(c.publicIp, c.relayPort);
                    return { wallet: c.wallet, rtt };
                }));
                probes.sort((a, b) => a.rtt - b.rtt);
                // Try candidates in RTT order; if /assign-node returns RTT_MISMATCH,
                // burn the suspect and try the next one. Cap at 3 attempts so a
                // hostile candidate fleet can't keep us spinning.
                let attempt = 0;
                for (const cand of probes) {
                    if (attempt++ >= 3) break;
                    if (cand.rtt === Infinity) continue;
                    setStatus(`Connected · ${Math.round(cand.rtt)}ms ping`);
                    const assignRes = await fetch('/api/matchmaker/assign-node', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ sessionId: this.sessionId, nodeWallet: cand.wallet, rttMs: Math.round(cand.rtt) }),
                    });
                    if (assignRes.status === 429) return this._bailRateLimited(assignRes);
                    if (assignRes.status === 409) {
                        const j = await assignRes.json().catch(() => ({}));
                        if (j.error === 'RTT_MISMATCH') {
                            console.warn('[play] RTT mismatch, dropping candidate:', cand.wallet, 'player', j.playerRttMs, 'server', j.serverRttMs);
                            burned.add(cand.wallet);
                            continue;
                        }
                    }
                    if (assignRes.ok) {
                        chosenWallet = cand.wallet;
                        chosenRtt   = cand.rtt;
                        break;
                    }
                }
                if (!chosenWallet) {
                    // Couldn't get a clean assign — fall through to /match.
                    const matchRes = await fetch('/api/matchmaker/match', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ sessionId: this.sessionId, wallet: addr }),
                    });
                    if (matchRes.status === 429) return this._bailRateLimited(matchRes);
                    if (matchRes.status === 503) {
                        const j = await matchRes.json().catch(() => ({}));
                        if (j.error === 'NO_HOST_HAS_GAME') {
                            return this._noHostAvailable();
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[play] RTT probe path failed, falling back:', e.message);
            await fetch('/api/matchmaker/match', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: this.sessionId, wallet: addr }),
            });
        }

        // Poll for connect-info until the host agent publishes it.
        // Client deadline: the server reaper only trips at SESSION_TTL_MS
        // (10 min). Waiting that long looks broken to a user, so we bail
        // after ~75 s if the host hasn't surfaced connect_info — long
        // enough to cover a slow VM boot, short enough that an unhealthy
        // host fails fast and the player can pick another game.
        const pollStartedAt = performance.now();
        const POLL_DEADLINE_MS = 75_000;
        this._pollTimer = setInterval(async () => {
            if (!this.sessionId) return;
            if (performance.now() - pollStartedAt > POLL_DEADLINE_MS) {
                clearInterval(this._pollTimer);
                this._pollTimer = null;
                return this._noHostAvailable();
            }
            try {
                const [sRes, cRes] = await Promise.all([
                    fetch(`/api/matchmaker/session-status/${encodeURIComponent(this.sessionId)}`).then((r) => r.json()),
                    fetch(`/api/session/${encodeURIComponent(this.sessionId)}/connect-info?wallet=${encodeURIComponent(addr)}`).then((r) => r.json()).catch(() => null),
                ]);
                if (sRes?.node) setStatus(`Connected · ${sRes.node.rtt || Math.round(chosenRtt || 0) || '—'}ms ping — waiting for the server…`);
                if (cRes?.connectInfo && cRes.status !== 'ended' && cRes.status !== 'failed') {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                    this.session = { nodeWallet: cRes.nodeWallet, playerWallet: cRes.playerWallet };
                    this.connectInfo = cRes.connectInfo;
                    this.view = 'ready';
                    this.rerender();
                    this._wireStreaming();
                    this._launchPlayer();
                }
                if (sRes?.status === 'failed' || sRes?.status === 'ended') {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                    setStatus(`Session ${sRes.status === 'failed' ? 'failed' : 'ended'}. Try another game.`);
                }
            } catch { /* ignore transient errors */ }
        }, 2000);
    }

    /** P1.3 — drive the one-shot ephemeral-key delegation popup.
     *  Returns true on success, false if the user rejected or the server
     *  refused. Side-effect: sets this._attestor on success. */
    async _delegateSessionKey(setStatus) {
        if (!this.sessionId) return false;
        // Resolve SessionVerifier address + chainId from deployments.json.
        // We pin this to Monad testnet 10143 today — Phase 2 P2.8 will make
        // the chainId configurable. The address is the only mainnet-vs-testnet
        // distinction; the digest format is identical across chains because it
        // includes block.chainid as a domain separator.
        const MONAD_TESTNET_CHAIN_ID = 10143;
        let verifierAddress = null;
        try {
            await loadDeployments();
            const dep = getDeployment(MONAD_TESTNET_CHAIN_ID);
            verifierAddress = dep?.addresses?.SessionVerifier || null;
        } catch (_) { /* fall through to error path */ }
        if (!verifierAddress) {
            console.warn('[play] SessionVerifier address missing from deployments.json — skipping ephemeral delegation');
            // Best-effort: don't block the session, but no signed attestations
            // will land on-chain. Surface this as a transient status update so
            // it doesn't degrade silently — operator running a fresh chain
            // without SessionVerifier deployed otherwise has no visible signal.
            try { setStatus?.('On-chain session signing unavailable — streaming anyway.'); } catch {}
            return true;
        }

        // Plain-language scope card first — the user must explicitly click
        // "Approve" before the wallet popup fires. This is the consent UI for
        // the otherwise-opaque hex digest the wallet shows.
        const overlay = this._showDelegationOverlay({
            gameName: this.selectedGame?.name || this.selectedGame?.title || 'this game',
            sessionId: this.sessionId,
        });
        const approved = await overlay.awaitDecision();
        if (!approved) {
            overlay.hide();
            setStatus('Session signing cancelled — returning to browse…');
            return false;
        }

        try {
            overlay.transitionToWaiting();
            setStatus('Sign in your wallet to start the session…');
            this._attestor = await startSessionAttestor(
                this.sessionId,
                verifierAddress,
                MONAD_TESTNET_CHAIN_ID,
                /* monadEid */ null,
            );
            overlay.hide();
            setStatus('Session authorized — finding the closest server…');
            return true;
        } catch (err) {
            overlay.hide();
            const msg = err?.message || String(err);
            console.warn('[play] session-key delegation failed:', msg);
            // User rejection (MetaMask code 4001) is a soft cancel; everything
            // else surfaces as a hard error in the status line.
            if (/user rejected|user denied|4001/i.test(msg)) {
                setStatus('Session signing cancelled — returning to browse…');
            } else {
                setStatus(`Couldn't authorize session: ${msg.slice(0, 80)}`);
            }
            this._attestor = null;
            return false;
        }
    }

    /** Two-state overlay:
     *  1. Scope card — plain-language description of what the player is about
     *     to sign, with Approve / Cancel buttons. The wallet popup does not
     *     fire until the user clicks Approve.
     *  2. Waiting card — shown while the wallet popup is open.
     *  Returns: { awaitDecision(), transitionToWaiting(), hide() } */
    _showDelegationOverlay({ gameName, sessionId }) {
        const shortSession = sessionId ? `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}` : '—';
        const el = document.createElement('div');
        el.setAttribute('data-attestor-overlay', '1');
        el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;font-family:inherit;';
        el.innerHTML = `
            <div data-scope-card style="background:var(--surf-1, #111);border:1px solid var(--surf-3, #333);padding:24px 28px;max-width:440px;font-size:13px;line-height:1.55;color:var(--ink-1, #ccc);">
                <div class="hud-display" style="font-size:14px;letter-spacing:0.16em;margin-bottom:14px;">SESSION KEY — REVIEW BEFORE SIGNING</div>
                <div style="margin-bottom:14px;">
                    Your wallet will create an in-browser <b>session key</b> that signs per-minute attestations during play. You sign <b>once</b>; no further wallet popups during the session.
                </div>
                <ul style="list-style:none;padding:0;margin:0 0 14px;font-family:var(--font-mono, monospace);font-size:12px;color:var(--ink-2, #aaa);">
                    <li style="padding:4px 0;border-bottom:1px solid var(--surf-3, #2a2a2a);"><span style="color:var(--ink-3, #888);">Game</span> &nbsp;&nbsp; ${escapeHTML(gameName)}</li>
                    <li style="padding:4px 0;border-bottom:1px solid var(--surf-3, #2a2a2a);"><span style="color:var(--ink-3, #888);">Session</span> &nbsp; ${escapeHTML(shortSession)}</li>
                    <li style="padding:4px 0;border-bottom:1px solid var(--surf-3, #2a2a2a);"><span style="color:var(--ink-3, #888);">Scope</span> &nbsp;&nbsp; This session only</li>
                    <li style="padding:4px 0;"><span style="color:var(--ink-3, #888);">Expires</span> &nbsp; When this session ends</li>
                </ul>
                <div style="font-size:11px;color:var(--ink-3, #888);margin-bottom:14px;">
                    The session key never leaves your browser. It cannot move funds or change wallet permissions. It can only sign attestations for this session.
                </div>
                <div style="display:flex;gap:10px;">
                    <button data-deleg-cancel type="button" style="flex:1;padding:10px;background:transparent;border:1px solid var(--surf-3, #333);color:var(--ink-2, #aaa);cursor:pointer;font-family:inherit;font-size:13px;">Cancel</button>
                    <button data-deleg-approve type="button" style="flex:1;padding:10px;background:var(--accent, #6366f1);border:1px solid var(--accent, #6366f1);color:#fff;cursor:pointer;font-family:inherit;font-size:13px;">Approve & Sign</button>
                </div>
            </div>
            <div data-waiting-card style="display:none;background:var(--surf-1, #111);border:1px solid var(--surf-3, #333);padding:24px 28px;max-width:380px;text-align:center;">
                <div class="hud-display" style="font-size:15px;letter-spacing:0.18em;margin-bottom:10px;">WAITING ON WALLET</div>
                <div class="hud-label" style="font-size:12px;line-height:1.5;color:var(--ink-1, #ccc);">Approve the signature in your wallet popup.</div>
                <div class="hud-spin" style="margin:18px auto 0;"></div>
            </div>`;
        document.body.appendChild(el);

        return {
            awaitDecision() {
                return new Promise((resolve) => {
                    el.querySelector('[data-deleg-approve]').addEventListener('click', () => resolve(true), { once: true });
                    el.querySelector('[data-deleg-cancel]').addEventListener('click', () => resolve(false), { once: true });
                });
            },
            transitionToWaiting() {
                const scope = el.querySelector('[data-scope-card]');
                const wait = el.querySelector('[data-waiting-card]');
                if (scope) scope.style.display = 'none';
                if (wait) wait.style.display = '';
            },
            hide: () => { try { el.remove(); } catch {} },
        };
    }

    async _probeRtt(ip, port) {
        // Browsers can't do raw UDP. Best signal we have is TCP RTT via fetch
        // against an always-on endpoint on the host. The WS bridge port
        // (default 47991) runs an HTTP server that 404s on non-/stream URLs —
        // a 404 returning quickly IS our RTT measurement.
        const url = `http://${ip}:47991/probe`;
        const start = performance.now();
        try {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 1500);
            await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
            return performance.now() - start;
        } catch {
            return Infinity;
        }
    }

    /**
     * Wire the Project WarpStream server-browser card:
     *   - Measure round-trip latency to our edge (avg 3 fetches to /api/health)
     *     and write into [data-ping-self]
     *   - Pull /api/cloud/regions for live host capacity
     *   - Render one row per region with a ping estimate derived from the
     *     user's timezone (US, EU, APAC). Real per-region pings would
     *     require regional edge endpoints; until those exist this gives a
     *     useful "which region is closest to me" signal.
     *   - Sort by ping asc (closest first); rows are clickable when the
     *     region has live hosts AND browserPlayLive is open; otherwise
     *     they're greyed with a "Standby" badge.
     *   - Auto-match button fires the lowest-ping non-empty region.
     */
    async _wireServerBrowser() {
        const root = this.root;
        if (!root || root._serverBrowserWired) return;
        root._serverBrowserWired = true;

        const pingEl     = root.querySelector('[data-ping-self]');
        const pingPill   = root.querySelector('[data-ping-self-pill]');
        const listEl     = root.querySelector('[data-region-list]');
        if (!listEl) return;

        // ── 1. Probe definitions ────────────────────────────────────────
        // Per-region RTT measurement uses image-load timing against AWS S3
        // regional endpoints. Image-load is permitted by the existing
        // `img-src https:` CSP rule (no server change needed) and works
        // cross-origin without CORS. S3 returns an XML doc; the browser
        // fails to decode it as an image and fires `onerror` — the
        // round-trip time is real either way. AWS POPs are reliable and
        // present in every region we care about.
        const REGION_PROBES = {
            'us-east':        'https://s3.us-east-1.amazonaws.com/',
            'us-central':     'https://s3.us-east-2.amazonaws.com/',
            'us-west':        'https://s3.us-west-2.amazonaws.com/',
            'eu-west':        'https://s3.eu-west-1.amazonaws.com/',
            'eu-central':     'https://s3.eu-central-1.amazonaws.com/',
            'apac-southeast': 'https://s3.ap-southeast-1.amazonaws.com/',
            'apac-northeast': 'https://s3.ap-northeast-1.amazonaws.com/',
            'oceania':        'https://s3.ap-southeast-2.amazonaws.com/',
        };

        // Single image probe — fires onload OR onerror when the response
        // arrives; either path yields the network RTT. Hard 3s timeout
        // protects against networks that black-hole the host.
        const _probe = (url) => new Promise((resolve) => {
            const img = new Image();
            const t = performance.now();
            let done = false;
            const finish = (ms) => { if (done) return; done = true; img.onload = img.onerror = null; resolve(ms); };
            img.onload = img.onerror = () => finish(performance.now() - t);
            setTimeout(() => finish(null), 3000);
            img.src = url + '?_=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        });
        // Warmup (1) + 2 measured samples; take the min. Warmup eats DNS +
        // TLS handshake so the measured samples are pure TCP RTT.
        const measureRTT = async (url) => {
            await _probe(url);   // warmup
            const samples = [];
            for (let i = 0; i < 2; i++) {
                const v = await _probe(url);
                if (v != null) samples.push(v);
            }
            return samples.length ? Math.round(Math.min(...samples)) : null;
        };

        // ── 2. Measure user → our edge latency (fast /api/ping) ─────────
        const selfSamples = [];
        try { await fetch('/api/ping', { cache: 'no-store' }); } catch {}  // warmup
        for (let i = 0; i < 3; i++) {
            const t = performance.now();
            try {
                await fetch('/api/ping', { cache: 'no-store' });
                selfSamples.push(performance.now() - t);
            } catch {}
        }
        const selfPing = selfSamples.length ? Math.round(Math.min(...selfSamples)) : null;
        if (pingEl && selfPing != null) {
            pingEl.textContent = String(selfPing);
            if (pingPill) pingPill.hidden = false;
        }

        // ── 3. Load region capacity + measure per-region pings ──────────
        // If the player landed on /play with `?steamAppid=N`, scope the
        // capacity board to hosts that actually have THAT game installed
        // — "12 hosts in EU West" only counts when those 12 can serve the
        // game the player wants. Without a steamAppid we show global
        // capacity (generic "what's the network look like" view).
        // Rows render immediately with placeholder pings ("—"), then each
        // region's measurement updates its cell in place. After all probes
        // resolve we re-sort so the lowest-latency region floats to the
        // top with the green "best" border.
        const appid = this._pendingSteamAppid || null;
        const appidParam = appid ? `?appid=${encodeURIComponent(appid)}` : '';
        let data;
        try {
            const r = await fetch(`/api/cloud/regions${appidParam}`);
            data = await r.json();
        } catch { data = { regions: [], totals: { hostsOnline: 0, sessionsLive: 0 } }; }
        const regions = (data.regions || []).map((r) => ({ ...r, ping: null }));

        // Surface the game we're filtering for in the eyebrow so the
        // player can see at a glance that "0 hosts in US East" means
        // "0 hosts here that own THIS game", not "the platform is empty".
        if (appid) {
            const labelEl = root.querySelector('[data-eyebrow-label]');
            if (labelEl) {
                labelEl.textContent = `Project WarpStream · Loading…`;
                fetch(`/api/steam/app-meta?appid=${encodeURIComponent(appid)}`)
                    .then((r) => r.json())
                    .then((meta) => {
                        const name = meta?.name || `App ${appid}`;
                        labelEl.textContent = `Servers · ${name}`;
                    })
                    .catch(() => { labelEl.textContent = `Servers · App ${appid}`; });
            }
        }

        const liveGated = this.flags?.browserPlayLive === false;

        const pingBand = (p) => p == null ? 'off' : p < 50 ? 'ok' : p < 120 ? 'cyan' : p < 200 ? 'warn' : 'bad';
        const rowHtml = (r, isBest) => {
            const hasHosts = r.hostsOnline > 0;
            const pingLabel = r.ping != null ? `${r.ping}ms` : '—';
            const band      = pingBand(r.ping);
            const status   = liveGated  ? 'Standby' : !hasHosts ? '0 hosts' : 'Ready';
            const statusLed = liveGated ? 'standby' : !hasHosts ? 'off'     : 'ok';
            const cls = ['hpd-server-row'];
            if (isBest) cls.push('hpd-server-row--best');
            if (!hasHosts || liveGated) cls.push('hpd-server-row--disabled');
            return `
                <button class="${cls.join(' ')}" type="button" data-region="${r.code}">
                    <span class="hpd-server-row__region">
                        <span class="hpd-server-row__name">${escapeHTML(r.name)}</span>
                        <span class="hpd-server-row__hint">${escapeHTML(r.hint || '')}</span>
                    </span>
                    <span class="hpd-server-row__capacity">
                        <span class="hpd-server-row__count">${r.hostsOnline}<span class="hpd-server-row__count-unit">hosts</span></span>
                        <span class="hpd-server-row__count">${r.sessionsLive}<span class="hpd-server-row__count-unit">live</span></span>
                    </span>
                    <span class="hpd-server-row__ping hpd-server-row__ping--${band}" data-ping-cell>
                        <span class="hpd-server-row__ping-bars" data-band="${band}"><i></i><i></i><i></i><i></i></span>
                        <span class="hpd-server-row__ping-val">${pingLabel}</span>
                    </span>
                    <span class="hpd-server-row__status">
                        <span class="hpd-eyebrow__led hpd-eyebrow__led--${statusLed}"></span>
                        ${status}
                    </span>
                </button>`;
        };
        const onPick = (region) => {
            if (liveGated) { location.hash = `#/host?region=${encodeURIComponent(region)}`; return; }
            // Preserve the game context (steamAppid) so matchmaking on the
            // next page is scoped to the same title the player was browsing.
            const gameQs = appid ? `&steamAppid=${encodeURIComponent(appid)}` : '';
            location.hash = `#/play?region=${encodeURIComponent(region)}${gameQs}`;
        };
        const paintList = () => {
            // Sort: measured-and-fastest first, then "not yet measured"
            // (null), then "no hosts" tied broken by sessionsLive desc so
            // populated regions still rank above empty ones.
            const sorted = [...regions].sort((a, b) => {
                const ap = a.ping ?? 9999, bp = b.ping ?? 9999;
                return ap - bp;
            });
            const firstWithHosts = sorted.find((r) => r.hostsOnline > 0);
            listEl.innerHTML = sorted.length
                ? sorted.map((r) => rowHtml(r, r === firstWithHosts)).join('')
                : `<div class="hpd-server-row hpd-server-row--placeholder"><span class="hpd-server-row__name">No regions reporting yet.</span></div>`;
            listEl.querySelectorAll('[data-region]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    if (btn.classList.contains('hpd-server-row--disabled')) return;
                    onPick(btn.getAttribute('data-region'));
                }, { signal: this.signal });
            });
        };
        paintList();  // Initial paint with "—" pings — the user sees the list immediately.

        // ── 4. Probe every region's edge in parallel ────────────────────
        // Image-load timing against AWS regional S3 endpoints. As each
        // measurement lands, update that row's ping cell in place. After
        // all settle, do one final paintList() to re-sort (lowest-ping
        // region floats to the top with the green "best" border).
        const probes = regions.map(async (r) => {
            const probeUrl = REGION_PROBES[r.code];
            if (!probeUrl) return;
            const ms = await measureRTT(probeUrl);
            r.ping = ms;
            // In-place cell update so the user sees progressive readings
            // without losing scroll position / focus state.
            const cell = listEl.querySelector(`[data-region="${r.code}"] [data-ping-cell]`);
            if (cell) {
                const band = pingBand(ms);
                cell.classList.remove('hpd-server-row__ping--off', 'hpd-server-row__ping--ok', 'hpd-server-row__ping--cyan', 'hpd-server-row__ping--warn', 'hpd-server-row__ping--bad');
                cell.classList.add(`hpd-server-row__ping--${band}`);
                cell.querySelector('.hpd-server-row__ping-bars')?.setAttribute('data-band', band);
                const valEl = cell.querySelector('.hpd-server-row__ping-val');
                if (valEl) valEl.textContent = ms != null ? `${ms}ms` : '—';
            }
        });
        await Promise.allSettled(probes);
        paintList();
    }

    _wireCancel() {
        this.root.querySelector('[data-cancel]')?.addEventListener('click', async () => {
            if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
            if (this.sessionId) {
                try { await fetch(`/api/matchmaker/cancel/${encodeURIComponent(this.sessionId)}`, { method: 'POST' }); } catch {}
            }
            // P1.3 — burn the ephemeral key on cancel.
            if (this._attestor) { try { this._attestor.endSession(); } catch {} this._attestor = null; }
            this.view = 'browse';
            this.sessionId = null;
            this.connectInfo = null;
            this.rerender();
            this._enterBrowse();
        }, { signal: this.signal });
    }

    _wireStreaming() {
        this.root.querySelector('[data-disconnect]')?.addEventListener('click', async () => {
            if (this._player) { try { this._player.stop(); } catch {} this._player = null; }
            if (this.sessionId) {
                try { await fetch('/api/session/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: this.sessionId }) }); } catch {}
            }
            // P1.3 — burn the ephemeral key on disconnect.
            if (this._attestor) { try { this._attestor.endSession(); } catch {} this._attestor = null; }
            this.view = 'browse';
            this.sessionId = null;
            this.connectInfo = null;
            this.session = null;
            this.rerender();
            this._enterBrowse();
        }, { signal: this.signal });
    }

    async _launchPlayer() {
        const videoEl = this.root.querySelector('[data-video]');
        const setHud = (field, val) => {
            const el = this.root.querySelector(`[data-hud-${field}]`);
            if (el) el.textContent = val;
        };
        try {
            const { DexHeroPlayer, browserCapabilityReport } =
                await import('../stream/player.js');

            // Phase 0.4 — browser detection banner. Non-Chromium
            // browsers fall through to default WebRTC jitter buffer +
            // soft-degraded paths; we tell the user up-front.
            const cap = browserCapabilityReport();
            if (!cap.recommended) {
                const banner = document.createElement('div');
                banner.className = 'hud-label';
                banner.style.cssText = 'background:rgba(251,191,36,0.15);padding:8px 12px;margin:0 0 8px;border-left:3px solid #fbbf24;font-size:11px;line-height:1.4;';
                banner.innerHTML = cap.isFirefox
                    ? `Firefox detected. Cloud play works but Insertable Streams support is partial — expect ~30ms higher latency. <strong>Chrome 105+ or Edge 105+</strong> recommended.`
                    : cap.isSafari
                    ? `Safari detected. Cloud play is best-effort — WebCodecs has known gaps; ~50ms higher latency. <strong>Chrome 105+ or Edge 105+</strong> recommended.`
                    : `Your browser is missing low-latency video features. <strong>Chrome 105+ or Edge 105+</strong> for the full experience.`;
                videoEl.parentElement?.insertBefore(banner, videoEl);
            }

            // Phase 0.6 + 0.7 — plumb the new connect-info fields
            // (latencyHints, iceServers, preferredCodecs) into the
            // RTCPeerConnection-based player. Deprecated WASM-path
            // fields (serverInfo, streamConfig, aesKeyHex) ignored.
            this._player = new DexHeroPlayer({
                videoEl,
                wsUrl: this.connectInfo.wsUrl,
                token: this.connectInfo.token,
                sessionId: this.sessionId,
                latencyHints:    this.connectInfo.latencyHints    || {},
                iceServers:      this.connectInfo.iceServers      || null,
                preferredCodecs: this.connectInfo.preferredCodecs || this.connectInfo.codec || ['h264', 'av1'],
                gameKey:         this.selectedGame?.steam_app_id || this.selectedGame?.slug || null,
                attestor:        this._attestor,
                onStats: (s) => {
                    // New HUD has unit-spans separate from the value-strong,
                    // so just write the numeric (or em-dash) value.
                    setHud('rtt',     `${s.rtt ?? '—'}`);
                    setHud('fps',     `${s.fps ?? '—'}`);
                    setHud('bitrate', `${s.bitrate ?? '—'}`);
                    // Drops indicator: only surface when nonzero so a healthy
                    // stream stays visually quiet. Sample is per-500ms; ×2 to
                    // present as drops/sec which is the user-readable unit.
                    const dropWrap = this.root.querySelector('[data-hud-drops-wrap]');
                    if (dropWrap) {
                        const dps = (s.dropped || 0) * 2;
                        if (dps > 0) { setHud('drops', String(dps)); dropWrap.hidden = false; }
                        else dropWrap.hidden = true;
                    }
                },
                onStateChange: (state) => {
                    setHud('status', state);
                    if (state === 'streaming') this.view = 'streaming';
                },
                onError: (e) => {
                    // The most common path here is the host's WS bridge dying
                    // mid-session (host process crashed, network blipped, or
                    // the host's ISP dropped UDP). Treat any onError after
                    // we've started streaming as a host-loss signal and
                    // attempt cold-reconnect failover.
                    setHud('status', `Connection lost — reconnecting…`);
                    this._handleHostLost(e?.message || String(e));
                },
                onHint: (msg) => this._showStreamHint(msg),
            });
            await this._player.start();

            // Subscribe to Realtime updates on this session row. If the
            // backend flips status to 'failed' (e.g. node missed heartbeats
            // for >15s), we kick into the same reconnect path the onError
            // handler uses — no need to wait for the WebSocket to die.
            this._subscribeSessionStatus();
        } catch (err) {
            setHud('status', `Player error: ${err.message || err}`);
            console.error('[play] player launch failed:', err);
        }
    }

    async _subscribeSessionStatus() {
        if (!this.sessionId) return;
        try {
            const client = await sb.ready();
            this._sessionChannel = client
                .channel(`session:${this.sessionId}`)
                .on('postgres_changes',
                    { event: 'UPDATE', schema: 'public', table: 'streaming_sessions', filter: `session_id=eq.${this.sessionId}` },
                    (payload) => {
                        const next = payload.new;
                        if (!next) return;
                        if (next.status === 'failed' && this._player) {
                            this._handleHostLost('backend marked session failed');
                        }
                    })
                .subscribe();
        } catch (e) {
            console.warn('[play] realtime subscribe failed (non-fatal):', e?.message || e);
        }
    }

    async _handleHostLost(reason) {
        if (this._reconnecting || !this.sessionId) return;
        this._reconnecting = true;
        const setHud = (field, val) => {
            const el = this.root.querySelector(`[data-hud-${field}]`);
            if (el) el.textContent = val;
        };
        const overlay = this._showReconnectOverlay();
        console.warn('[play] host lost:', reason);
        try {
            // Stop the dead player so its socket doesn't fight us.
            if (this._player) { try { this._player.stop?.(); } catch {} this._player = null; }

            const start = Date.now();
            // Attempt up to MAX_FAILOVERS rounds (matches backend's MAX_SESSION_FAILOVERS env). Try in-region first.
            let attempt = 0;
            // First pass: in-region only for the first 10 seconds. After that,
            // allow cross-region spill so we don't strand the player when their
            // local pool is exhausted.
            const isSteam = !!this.selectedGame?.steam_app_id;
            // Honest messaging: we do NOT preserve VM state on cold reconnect.
            // Recovery depends entirely on the game's own save system (Steam Cloud
            // for Steam titles if the player has it enabled; native cloud saves
            // or local saves on the new host otherwise). Don't promise restore.
            const sourceCopy = isSteam
                ? 'Your Steam Cloud save will reload if Steam Cloud is enabled for this game'
                : 'Progress depends on this game’s save system';
            while (this._reconnecting && attempt < 5) {
                const allowCrossRegion = (Date.now() - start) > 10_000;
                const where = allowCrossRegion ? 'searching nearby regions' : 'finding a host near you';
                overlay.update(`Reconnecting — ${where}…\n${sourceCopy}.`, attempt);
                let ok = false;
                try {
                    ok = await this._reassignOnce(allowCrossRegion);
                } catch (e) {
                    console.warn('[play] reassign throw:', e?.message || e);
                }
                if (ok) { overlay.hide(); this._reconnecting = false; return; }
                attempt++;
                // Backoff: 2s, 3s, 5s, 8s, 13s
                const delay = [2000, 3000, 5000, 8000, 13000][Math.min(attempt - 1, 4)];
                await new Promise((r) => setTimeout(r, delay));
            }
            // Out of attempts.
            overlay.hide();
            this._reconnecting = false;
            setHud('status', 'Could not reconnect — session ended.');
            this.view = 'browse';
            this.sessionId = null;
            this.connectInfo = null;
            this.session = null;
            this.rerender();
            this._enterBrowse();
        } catch (err) {
            overlay.hide();
            this._reconnecting = false;
            console.error('[play] reconnect aborted:', err);
        }
    }

    async _reassignOnce(allowCrossRegion) {
        const w = wallet.getStatus();
        if (!w?.connected) return false;
        const addr = w.address;
        const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
        const msg = `DexHero reassign: ${this.sessionId} ${addr.toLowerCase()} ${minuteBucket}`;
        const signature = await wallet.signMessage(msg);
        const r = await fetch('/api/matchmaker/reassign', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, wallet: addr, signature, allowCrossRegion }),
        });
        if (!r.ok) return false;
        const data = await r.json().catch(() => null);
        if (!data?.ok) return false;

        // Wait for the new host to publish connect-info (max ~30s).
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const ci = await fetch(`/api/session/${encodeURIComponent(this.sessionId)}/connect-info?wallet=${encodeURIComponent(addr)}`).then((res) => res.json()).catch(() => null);
            if (ci?.connectInfo && ci.status !== 'ended' && ci.status !== 'failed') {
                this.session = { nodeWallet: ci.nodeWallet, playerWallet: ci.playerWallet };
                this.connectInfo = ci.connectInfo;
                this.view = 'ready';
                this.rerender();
                this._wireStreaming();
                this._launchPlayer();
                return true;
            }
            await new Promise((r2) => setTimeout(r2, 1500));
        }
        return false;
    }

    _showReconnectOverlay() {
        let host = this.root.querySelector('[data-reconnect-overlay]');
        if (!host) {
            host = document.createElement('div');
            host.setAttribute('data-reconnect-overlay', '');
            host.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.78);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:10;backdrop-filter:blur(6px);';
            host.innerHTML = `
                <div class="hud-spin"></div>
                <div data-reconnect-msg style="font-family:var(--font-mono);font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ink-1);text-align:center;line-height:1.5;white-space:pre-line;">Reconnecting…</div>
                <div data-reconnect-attempt style="font-family:var(--font-mono);font-size:10.5px;color:var(--ink-3);"></div>
            `;
            const videoHost = this.root.querySelector('[data-video]')?.parentElement || this.root;
            videoHost.style.position ||= 'relative';
            videoHost.appendChild(host);
        }
        return {
            update(msg, attempt) {
                const m = host.querySelector('[data-reconnect-msg]');
                const a = host.querySelector('[data-reconnect-attempt]');
                if (m) m.textContent = msg;
                if (a) a.textContent = attempt > 0 ? `Attempt ${attempt + 1}` : '';
            },
            hide() {
                if (host.parentElement) host.parentElement.removeChild(host);
            },
        };
    }


    /**
     * Phase 3.1: prompt for Steam credentials when the player picks a Steam-
     * catalog game. Holds them in this.steamCreds (UI-side memory only) and
     * relays to the backend's /api/session/steam-credentials endpoint right
     * before the matchmaker request goes out. After session end the in-memory
     * copy is cleared.
     *
     * Trust signals to the player:
     *  - Visible disclosure copy below the form.
     *  - Explicit explainer that Steam Guard codes are one-shot (Steam
     *    rotates after first use).
     */
    /** T1-02 helper: bail out of matchmaking when a 429 RATE_LIMITED comes
     *  back from any matchmaker endpoint. Honors Retry-After header. */
    async _bailRateLimited(res) {
        const setStatus = (msg) => { const el = this.root.querySelector('[data-status]'); if (el) el.textContent = msg; };
        let retryAfterSec = Number(res.headers.get('Retry-After'));
        if (!Number.isFinite(retryAfterSec)) {
            try { const j = await res.json(); retryAfterSec = Math.ceil((j.retryAfterMs || 5000) / 1000); }
            catch { retryAfterSec = 5; }
        }
        setStatus(`Slow down a sec — returning to library in ${retryAfterSec}s…`);
        setTimeout(() => { this.view = 'browse'; this.rerender(); this._enterBrowse(); }, Math.max(2000, retryAfterSec * 1000));
    }

    /** Surface a non-fatal hint to the user over the video pane.
     *  Used for things like pointer-lock denials where streaming
     *  continues but the experience is degraded and the user can act
     *  on the information (e.g. press F for fullscreen). Auto-hides
     *  after ~4s; replaces any existing hint so we don't stack. */
    _showStreamHint(msg) {
        const wrap = this.root.querySelector('[data-video-wrap]');
        if (!wrap) return;
        let hint = wrap.querySelector('[data-stream-hint]');
        if (!hint) {
            hint = document.createElement('div');
            hint.setAttribute('data-stream-hint', '');
            hint.style.cssText = 'position:absolute;left:50%;bottom:56px;transform:translateX(-50%);background:rgba(0,0,0,0.78);color:#fbbf24;font:11px/1.4 var(--font-mono);padding:8px 12px;border-left:3px solid #fbbf24;letter-spacing:0.04em;max-width:80%;pointer-events:none;z-index:5;';
            wrap.appendChild(hint);
        }
        hint.textContent = msg;
        clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(() => { try { hint.remove(); } catch {} }, 4000);
    }

    /** Terminal state when no online host owns this game. Both host and
     *  player must own the same game on their own Steam accounts; there
     *  is no fallback. */
    async _noHostAvailable() {
        const setStatus = (msg) => { const el = this.root.querySelector('[data-status]'); if (el) el.textContent = msg; };
        setStatus('No servers online with this game right now. Try again later.');
        try { await fetch(`/api/matchmaker/cancel/${encodeURIComponent(this.sessionId)}`, { method: 'POST' }); } catch {}
        this.sessionId = null;
        setTimeout(() => { this.view = 'browse'; this.rerender(); this._enterBrowse(); }, 2400);
    }

    async _promptSteamCredentials(game) {
        if (!game?.steam_app_id) return null; // platform-owned game; no Steam needed
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(8px);';
        overlay.innerHTML = `
            <div style="max-width:min(420px, calc(100vw - 32px));margin:0 16px;background:var(--bg-1);border:1px solid var(--rule);border-radius:var(--r-2);padding:24px;font-family:var(--font-mono);">
                <div class="hud-display" style="font-size:16px;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">Sign in to Steam</div>
                <div class="hud-label" style="font-size:11px;line-height:1.5;margin-bottom:18px;">Your credentials are sent encrypted to the assigned server's player VM <strong>once</strong> and wiped at session end. They never touch DexHero's disk. Steam Guard codes are one-shot.</div>
                <label class="hud-label" style="font-size:10.5px;letter-spacing:0.16em;">Steam username</label>
                <input data-steam-user type="text" placeholder="your-steam-username" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;padding:10px;margin:6px 0 14px;background:rgba(0,0,0,0.4);border:1px solid var(--rule);color:var(--ink-0);font-family:var(--font-mono);">
                <label class="hud-label" style="font-size:10.5px;letter-spacing:0.16em;">Password</label>
                <input data-steam-pass type="password" placeholder="your-password" autocomplete="off" style="width:100%;padding:10px;margin:6px 0 14px;background:rgba(0,0,0,0.4);border:1px solid var(--rule);color:var(--ink-0);font-family:var(--font-mono);">
                <label class="hud-label" style="font-size:10.5px;letter-spacing:0.16em;">Steam Guard code (5 chars)</label>
                <input data-steam-2fa type="text" placeholder="ABCDE" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" style="width:100%;padding:10px;margin:6px 0 14px;background:rgba(0,0,0,0.4);border:1px solid var(--rule);color:var(--ink-0);font-family:var(--font-mono);text-transform:uppercase;">
                <div data-steam-error style="display:none;color:var(--acc-err,#ef4444);font-size:11px;margin-bottom:10px;"></div>
                <div style="display:flex;gap:10px;margin-top:6px;">
                    <button class="hud-btn" data-steam-cancel style="flex:1;">Cancel</button>
                    <button class="hud-btn hud-btn--primary" data-steam-submit style="flex:2;">Continue</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        return new Promise((resolve) => {
            overlay.querySelector('[data-steam-cancel]').addEventListener('click', () => { overlay.remove(); resolve(null); });
            overlay.querySelector('[data-steam-submit]').addEventListener('click', () => {
                const username = overlay.querySelector('[data-steam-user]').value.trim();
                const password = overlay.querySelector('[data-steam-pass]').value;
                const twoFa    = overlay.querySelector('[data-steam-2fa]').value.trim().toUpperCase();
                const errEl = overlay.querySelector('[data-steam-error]');
                if (!username || !password) {
                    if (errEl) {
                        errEl.textContent = 'Username and password are required.';
                        errEl.style.display = 'block';
                    }
                    return;
                }
                overlay.remove();
                resolve({ username, password, twoFa: twoFa || null });
            });
        });
    }

    async _stashSteamCredentials(sessionId, creds) {
        if (!creds) return;
        const w = wallet.getStatus();
        // Two paths:
        //   Wallet present → EIP-191 sign + send wallet+signature.
        //   No wallet      → server authenticates via dx_steam_session cookie.
        let body;
        if (w?.connected) {
            const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
            const msg = `DexHero stash-creds: ${sessionId} ${w.address.toLowerCase()} ${minuteBucket}`;
            const signature = await wallet.signMessage(msg);
            body = { sessionId, wallet: w.address, signature, credentials: creds };
        } else {
            body = { sessionId, credentials: creds };
        }
        await fetch('/api/session/steam-credentials', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...steamHeader() },
            credentials: 'include',
            body: JSON.stringify(body),
        });
        // Wipe local copy.
        creds.username = creds.password = creds.twoFa = '';
    }

    _short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }

    onUnmount() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._player) { try { this._player.stop(); } catch {} this._player = null; }
        if (this._sessionChannel) {
            try { this._sessionChannel.unsubscribe(); } catch {}
            this._sessionChannel = null;
        }
        // P1.3 — burn the ephemeral key when the panel itself unmounts (e.g.
        // the user closes the panel via the X without clicking Disconnect).
        if (this._attestor) { try { this._attestor.endSession(); } catch {} this._attestor = null; }
        super.onUnmount?.();
    }
}
