/* Public game detail panel — route #/game/:id
   Shows the game header + a "Play with your DexHero" picker (the user's
   DexHeros that are compatible with this game; clicking one launches the
   stream via /#/play?game=<id>&hero=<id>) + the public roster of any
   DexHero connected to this game.
   No API keys, no owner-only surfaces: this view is what any visitor sees
   when clicking a game card. Owners manage API keys via /#/developer. */

import { Panel, escapeHTML, sanitizeURL, fmtNum } from '../ui/panel.js';
import * as sb from '../services/supabase.js';
import * as wallet from '../services/wallet.js';
import { steamFetch } from '../services/steam-session.js';
import { on, E } from '../events.js';
import { setContext, setIdle } from '../stage.js';

(function loadStyles() {
    // game-detail.css owns the page-specific bits (hero, screenshots,
    // Steam profile card). host-play-hud.css provides the shared HUD
    // primitives (frames, eyebrows, stat tiles, server-row grid, CTAs).
    const sheets = [
        { key: 'game-detail',   href: '/styles/panels/game-detail.css' },
        { key: 'host-play-hud', href: '/styles/panels/host-play-hud.css' },
    ];
    for (const s of sheets) {
        if (document.querySelector(`link[data-panel-css="${s.key}"]`)) continue;
        const l = document.createElement('link');
        l.rel  = 'stylesheet';
        l.href = s.href;
        l.setAttribute('data-panel-css', s.key);
        document.head.appendChild(l);
    }
})();

// Inline Steam logo — reused as the fallback placeholder anywhere the
// profile picker needs an image but the source didn't supply one (Steam
// avatar missing, DexHero with no image_url, etc.). Same SVG used by the
// header chip in index.html so the visual language stays consistent.
const STEAM_LOGO_SVG = `<svg class="td-steam-fallback" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.6 2 2.2 6 2 11.1l5.4 2.3c.5-.3 1-.5 1.6-.5h.1l2.4-3.5v-.1a3.6 3.6 0 1 1 3.6 3.6h-.1L11.6 15v.1a2.9 2.9 0 0 1-5.7.6L2 14.1A10 10 0 1 0 12 2zm-4.1 14.8l-1.3-.5a2.3 2.3 0 0 0 2.6 1.3 2.3 2.3 0 0 0 1.4-3l-1.3-.6c.7.3 1 1 .8 1.7-.2.7-1 1.3-1.7 1.3a1.4 1.4 0 0 1-.5 0zm6.2-3.2a2.4 2.4 0 0 1-2.4-2.4 2.4 2.4 0 0 1 2.4-2.4 2.4 2.4 0 0 1 2.4 2.4 2.4 2.4 0 0 1-2.4 2.4zm0-.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>`;

// Steam returns this URL hash for accounts that haven't uploaded a custom
// avatar. Rendering it shows a generic "?" silhouette — treat it as "no
// avatar" so the caller falls through to the Steam-logo SVG fallback.
const STEAM_DEFAULT_AVATAR_HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const realAvatar = (u) => (u && !String(u).includes(STEAM_DEFAULT_AVATAR_HASH)) ? u : '';

const SORT_OPTIONS = [
    { id: 'price-desc',    label: 'Price ↓' },
    { id: 'price-asc',     label: 'Price ↑' },
    { id: 'players-desc',  label: 'Players ↓' },
    { id: 'players-asc',   label: 'Players ↑' },
];

export default class GameDetailPanel extends Panel {
    static id        = 'game-detail';
    static variant   = 'right';
    static width     = 560;
    static title     = 'Game';
    static titleBreadcrumb = ['GAMES'];
    static stageMode = 'context';
    // Back-arrow target — most game-detail visits originate from the
    // Games tab in the market panel. Routing there gives the user the
    // catalog they were browsing rather than dumping them at the lobby.
    static parentHash = '#/market/games';

    constructor(params) {
        super(params);
        this.gameId = params.id;
        // If the param is purely numeric, treat it as a Steam appid (the
        // Steam-library-first flow routes #/game/<appid>). Otherwise it's a
        // registered_games.id (UUID) for first-party titles.
        this.isSteam = /^\d+$/.test(String(this.gameId || ''));
        this.steamAppid = this.isSteam ? Number(this.gameId) : null;
        this.game = null;
        this.heroes = [];          // community roster (only meaningful for first-party)
        this.myHeroes = null;      // null = not loaded yet, [] = loaded but empty
        this.steamMe = null;       // null = not checked yet; { linked, mode } once fetched (Steam path only)
        this.sort = 'price-desc';
        // Crossover state — set when a Steam appid is ALSO present in the
        // registered_games table (registered_games.steam_app_id = this.steamAppid).
        // When non-null, the DexHero picker filters to heroes linked to
        // this game (game_token_links) so the Steam page surfaces both the
        // Steam persona/loadout AND only the game-compatible DexHeros.
        this.registeredGame = null;
        // Two-step launch UX: pick a profile (this) then a server (region row).
        // null = nothing picked yet; the section stays expanded.
        // { kind, id, label, image } = picked; section auto-collapses and the
        // server rows append &<kind>=<id> to their /play hrefs.
        this._chosenProfile = null;
    }

    render() {
        if (!this.game) {
            return `<div class="panel-state"><div class="hud-spin"></div><div>Loading game</div></div>`;
        }
        const g = this.game;
        const sortButtons = SORT_OPTIONS.map((o) =>
            `<button class="panel-tab" data-sort="${o.id}" aria-selected="${this.sort === o.id}" style="padding:8px 14px;">${o.label}</button>`
        ).join('');

        // ── Hero header — game art with bracket frame + LED + oversized title
        const hero = g.icon_url
            ? `<img class="td-hero__img" src="${sanitizeURL(g.icon_url)}" alt="">`
            : `<div class="td-hero__img td-hero__img--placeholder">${escapeHTML((g.title || '?').charAt(0))}</div>`;
        const statusLed   = g.status === 'active' ? 'ok' : g.status === 'blocked' ? 'warn' : 'standby';
        const statusLabel = g.status === 'active' ? 'Live' : g.status === 'blocked' ? 'Blocked' : 'Pending';

        // ── Developer / publisher byline
        const byline = [];
        if (g.developers?.length) byline.push(`by ${g.developers.slice(0, 2).map(escapeHTML).join(', ')}`);
        if (g.publishers?.length && g.publishers[0] !== g.developers?.[0]) byline.push(`published by ${escapeHTML(g.publishers[0])}`);
        const bylineHtml = byline.length ? `<div class="td-byline">${byline.join(' · ')}</div>` : '';

        // ── Screenshots strip (Steam only) — merged with About toggle
        // header. When the game has a description, the divider tag is
        // a clickable "About ▾" that reveals the synopsis above the
        // image strip. Without a description, the tag just reads
        // "Screenshots" and is non-interactive.
        const screenshots = (g.screenshots || []).slice(0, 8);
        const hasAbout = !!g.short_description;
        const screenshotsHtml = screenshots.length ? `
            <section class="panel-section td-about-section" data-about-section style="padding:0;background:transparent;border:0;">
                ${hasAbout
                    ? `<button class="hpd-divider td-about__toggle" type="button" data-about-toggle aria-expanded="false">
                        <span class="hpd-divider__line"></span>
                        <span class="hpd-divider__tag">About <span class="td-about__chev">▾</span></span>
                        <span class="hpd-divider__line"></span>
                    </button>
                    <p class="td-about" data-about-body>${escapeHTML(g.short_description)}</p>`
                    : `<div class="hpd-divider"><span class="hpd-divider__line"></span><span class="hpd-divider__tag">Screenshots</span><span class="hpd-divider__line"></span></div>`}
                <div class="td-shots">
                    ${screenshots.map((s) => `
                        <a class="td-shots__tile" href="${sanitizeURL(s.full || s.thumb)}" target="_blank" rel="noopener" aria-label="Screenshot">
                            <img src="${sanitizeURL(s.thumb)}" alt="" loading="lazy">
                        </a>
                    `).join('')}
                </div>
            </section>` : '';

        // About + Screenshots are merged into one section below — see
        // `screenshotsHtml` for the click-to-expand About header.

        // ── Inline region availability (full list, sorted by ping, populated post-mount).
        // Followed by a "Become a host" CTA so players who don't see a
        // populated region near them have a clear path to fill that gap.
        const regionsHtml = `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-divider"><span class="hpd-divider__line"></span><span class="hpd-divider__tag">Servers</span><span class="hpd-divider__line"></span></div>
                <div class="hpd-server-list td-regions" data-region-mini>
                    <div class="hpd-server-row hpd-server-row--placeholder"><span class="hpd-server-row__name">Probing regions…</span></div>
                </div>
                <a class="hpd-cta hpd-cta--secondary" href="#/host" style="margin-top:14px;">
                    <span>▶ Become a host</span>
                    <span class="hpd-cta__chev">→</span>
                </a>
            </section>`;

        // ── DexHero picker (Steam: profile + characters + inventory; first-party: roster)
        // Click-to-expand divider just like About — defaults to expanded so the
        // picker is visible on first paint; collapses automatically the moment a
        // profile is selected and the tag updates to "Pick a profile · <name> ▾".
        const dexHeroSection = `
            <section class="panel-section td-profile-section td-profile-section--expanded" data-profile-section style="padding:0;background:transparent;border:0;">
                <button class="hpd-divider td-profile__toggle" type="button" data-profile-toggle aria-expanded="true">
                    <span class="hpd-divider__line"></span>
                    <span class="hpd-divider__tag">
                        <span data-profile-label>Pick a profile</span>
                        <span class="td-about__chev">▾</span>
                    </span>
                    <span class="hpd-divider__line"></span>
                </button>
                <div data-my-heroes></div>
            </section>`;

        // ── Community roster (first-party only; Steam titles hide it)
        const rosterSection = this.isSteam ? '' : `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-divider">
                    <span class="hpd-divider__line"></span>
                    <span class="hpd-divider__tag">Community roster · <span data-hero-count>${this.heroes.length}</span></span>
                    <span class="hpd-divider__line"></span>
                </div>
                <div class="panel-tabs" style="margin-bottom:12px;overflow-x:auto;">${sortButtons}</div>
                <div class="panel-grid" data-roster style="--grid-min: 140px;"></div>
            </section>`;

        return `
            <section class="td-hero">
                <div class="td-hero__frame">
                    ${hero}
                    <div class="td-hero__scrim"></div>
                    <div class="td-hero__corners">
                        <span class="hpd-stream__bracket hpd-stream__bracket--tl"></span>
                        <span class="hpd-stream__bracket hpd-stream__bracket--tr"></span>
                        <span class="hpd-stream__bracket hpd-stream__bracket--bl"></span>
                        <span class="hpd-stream__bracket hpd-stream__bracket--br"></span>
                    </div>
                    <div class="td-hero__overlay">
                        <span class="hpd-eyebrow">
                            <span class="hpd-eyebrow__led hpd-eyebrow__led--${statusLed}"></span>
                            ${(g.tier || 'Game').toUpperCase()} · ${statusLabel.toUpperCase()}
                        </span>
                        <h1 class="td-hero__title">${escapeHTML(g.title || '—')}</h1>
                        ${bylineHtml}
                    </div>
                </div>
            </section>

            ${screenshotsHtml}
            ${dexHeroSection}
            ${regionsHtml}
            ${rosterSection}
        `;
    }

    async onMount() {
        try {
            await this._load();
            this.rerender();
            this._wireSort();
            this._wireAboutToggle();
            this._wireProfilePicker();
            if (this.game) {
                setContext({
                    id: this.game.id,
                    name: this.game.title,
                    image: this.game.icon_url,
                }, this.game.title);
                // Run in parallel — community roster + user's compatible heroes
                // + inline server-region preview (top 3 nearest, ping-measured).
                await Promise.all([
                    this._loadHeroes(),
                    this._loadMyHeroes(),
                    this._loadRegionPreview(),
                ]);
            }
            // When the user connects (or switches) their wallet on this page,
            // re-fetch the "Choose your DexHero" section so the unconnected
            // ▶ Play CTA becomes the actual roster.
            const off = on(E.WALLET_CHANGED, () => this._loadMyHeroes().catch(() => {}));
            this._abort.signal.addEventListener('abort', off, { once: true });
        } catch (err) {
            this.body.innerHTML = `<div class="panel-state"><div class="panel-state__title">Error</div><div class="panel-state__body">${escapeHTML(err.message)}</div></div>`;
        }
    }

    /**
     * Inline server availability widget on the game-detail page.
     * Mirrors the bigger /play server browser but caps to 3 rows: the
     * 3 lowest-ping regions that actually have at least one host. Empty
     * regions are dropped from the preview (the full /play page still
     * lists all 8). For Steam titles we pass the appid to
     * /api/cloud/regions so host counts reflect "hosts that own THIS
     * game" only. Real per-region pings via image-load timing against
     * AWS regional S3 endpoints (same as /play).
     */
    async _loadRegionPreview() {
        const host = this.root.querySelector('[data-region-mini]');
        if (!host) return;

        const PROBES = {
            'us-east':        'https://s3.us-east-1.amazonaws.com/',
            'us-central':     'https://s3.us-east-2.amazonaws.com/',
            'us-west':        'https://s3.us-west-2.amazonaws.com/',
            'eu-west':        'https://s3.eu-west-1.amazonaws.com/',
            'eu-central':     'https://s3.eu-central-1.amazonaws.com/',
            'apac-southeast': 'https://s3.ap-southeast-1.amazonaws.com/',
            'apac-northeast': 'https://s3.ap-northeast-1.amazonaws.com/',
            'oceania':        'https://s3.ap-southeast-2.amazonaws.com/',
        };
        const probe = (url) => new Promise((resolve) => {
            const img = new Image();
            const t = performance.now();
            let done = false;
            const finish = (ms) => { if (done) return; done = true; img.onload = img.onerror = null; resolve(ms); };
            img.onload = img.onerror = () => finish(performance.now() - t);
            setTimeout(() => finish(null), 3000);
            img.src = url + '?_=' + Date.now().toString(36);
        });
        const measure = async (url) => {
            await probe(url);
            const samples = [];
            for (let i = 0; i < 2; i++) {
                const v = await probe(url);
                if (v != null) samples.push(v);
            }
            return samples.length ? Math.round(Math.min(...samples)) : null;
        };
        const band = (p) => p == null ? 'off' : p < 50 ? 'ok' : p < 120 ? 'cyan' : p < 200 ? 'warn' : 'bad';

        const appidQs = this.isSteam ? `?appid=${encodeURIComponent(this.steamAppid)}` : '';
        let data;
        try {
            data = await fetch(`/api/cloud/regions${appidQs}`).then((r) => r.json());
        } catch { data = { regions: [], totals: { hostsOnline: 0 } }; }

        const regions = (data.regions || []).map((r) => ({ ...r, ping: null }));
        // Measure all regions in parallel — capped to 3 in the rendered
        // output, but we measure every region so the "top 3 by ping"
        // ranking is meaningful (not "first 3 by arbitrary order").
        await Promise.allSettled(regions.map(async (r) => {
            r.ping = await measure(PROBES[r.code]);
        }));
        // Sort: measured-and-fastest first, "not yet measured" (null)
        // last. Empty regions stay in the list but render disabled with a
        // "0 hosts" status pill — the user sees the full network at a
        // glance even when only some regions have capacity for this game.
        const sorted = [...regions].sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));
        const firstWithHosts = sorted.find((r) => r.hostsOnline > 0);

        if (!sorted.length) {
            host.innerHTML = `
                <div class="hpd-server-row hpd-server-row--placeholder">
                    <span class="hpd-server-row__name">No regions reporting yet.</span>
                </div>`;
            return;
        }
        const linkHref = (regionCode) =>
            `#/play?region=${encodeURIComponent(regionCode)}${this.isSteam ? `&steamAppid=${this.steamAppid}` : `&game=${encodeURIComponent(this.gameId)}`}`;

        host.innerHTML = sorted.map((r) => {
            const hasHosts = r.hostsOnline > 0;
            const isBest   = r === firstWithHosts;
            const b        = band(r.ping);
            const pingLabel = r.ping != null ? `${r.ping}ms` : '—';
            const cls = ['hpd-server-row'];
            if (isBest)    cls.push('hpd-server-row--best');
            if (!hasHosts) cls.push('hpd-server-row--disabled');
            const status    = hasHosts ? 'Ready'   : '0 hosts';
            const statusLed = hasHosts ? 'ok'      : 'off';
            const tag = hasHosts ? 'a' : 'span';
            const attrs = hasHosts ? `href="${linkHref(r.code)}"` : '';
            return `
                <${tag} class="${cls.join(' ')}" data-region="${r.code}" ${attrs}>
                    <span class="hpd-server-row__region">
                        <span class="hpd-server-row__name">${escapeHTML(r.name)}</span>
                        <span class="hpd-server-row__hint">${escapeHTML(r.hint || '')}</span>
                    </span>
                    <span class="hpd-server-row__capacity">
                        <span class="hpd-server-row__count">${r.hostsOnline}<span class="hpd-server-row__count-unit">hosts</span></span>
                        <span class="hpd-server-row__count">${r.sessionsLive}<span class="hpd-server-row__count-unit">live</span></span>
                    </span>
                    <span class="hpd-server-row__ping hpd-server-row__ping--${b}">
                        <span class="hpd-server-row__ping-bars" data-band="${b}"><i></i><i></i><i></i><i></i></span>
                        <span class="hpd-server-row__ping-val">${pingLabel}</span>
                    </span>
                    <span class="hpd-server-row__status">
                        <span class="hpd-eyebrow__led hpd-eyebrow__led--${statusLed}"></span>${status}
                    </span>
                </${tag}>`;
        }).join('');
        // If a profile was already picked before this paint (rare — the
        // picker mounts before the region probe completes, but possible if
        // the user pre-selects fast), bake it into every fresh row href.
        if (this._chosenProfile) this._restampServerRowHrefs();
    }

    onUnmount() { setIdle(); }

    async _load() {
        if (this.isSteam) {
            // Steam title — fetch metadata from the public Storefront API
            // via our /api/steam/app-meta proxy. No registered_games row.
            try {
                const meta = await fetch(`/api/steam/app-meta?appid=${this.steamAppid}`).then((r) => r.json());
                if (!meta || !meta.name) throw new Error('Game not found on Steam');
                this.game = {
                    id:        String(this.steamAppid),
                    slug:      `steam-${this.steamAppid}`,
                    title:     meta.name,
                    icon_url:  meta.header_image,
                    tier:      'steam',
                    status:    'active',
                    short_description: meta.short_description,
                    developers:        meta.developers   || [],
                    publishers:        meta.publishers   || [],
                    genres:            meta.genres       || [],
                    release_date:      meta.release_date || '',
                    release_coming:    !!meta.release_coming,
                    is_free:           !!meta.is_free,
                    price:             meta.price        || null,
                    screenshots:       meta.screenshots  || [],
                    movies:            meta.movies       || [],
                };
            } catch (err) {
                throw new Error('Could not load Steam game: ' + (err.message || err));
            }
            // Crossover lookup — is this Steam appid also a registered
            // DexHero game? If so, store the registered row's id so the
            // DexHero picker filters to heroes compatible with this game
            // (via game_token_links). Best-effort; lookup failure is
            // non-fatal and the page still works as a pure Steam title.
            try {
                const client = await sb.ready();
                const { data: reg } = await client
                    .from('registered_games')
                    .select('id, slug, title, tier, status')
                    .eq('steam_app_id', this.steamAppid)
                    .neq('status', 'deactivated')
                    .maybeSingle();
                if (reg?.id) this.registeredGame = reg;
            } catch (e) {
                console.warn('[game-detail] crossover lookup:', e.message);
            }
            return;
        }

        const client = await sb.ready();
        const { data, error } = await client
            .from('registered_games')
            .select('id, slug, title, icon_url, tier, status, goes_live_at')
            .eq('id', this.gameId)
            .neq('status', 'deactivated')
            .maybeSingle();
        if (error) throw new Error(error.message || 'Failed to load game');
        if (!data) throw new Error('Game not found');
        this.game = data;
    }

    async _loadHeroes() {
        const host = this.root.querySelector('[data-roster]');
        const count = this.root.querySelector('[data-hero-count]');
        if (!host) return;
        // Steam titles don't have curated rosters (game_token_links is for
        // first-party games). Hide the section entirely.
        if (this.isSteam) {
            const section = host.closest('.panel-section');
            if (section) section.style.display = 'none';
            return;
        }
        try {
            const client = await sb.ready();
            const { data: links } = await client
                .from('game_token_links')
                .select('token_id, manager_address')
                .eq('game_id', this.gameId);

            if (!links?.length) {
                host.innerHTML = `<div class="hud-muted" style="grid-column: 1 / -1;text-align:center;padding:24px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;">No DexHeros connected yet.</div>`;
                return;
            }

            const tokenIds = links.map((l) => l.token_id).filter(Boolean);
            const { data: tokens } = await client
                .from('tokens')
                .select('id, name, symbol, image_url, sprite_url, sprite_frame_count, manager_address, players_count, purchase_price_usdc, rental_price_usdc')
                .in('id', tokenIds);

            const byId = new Map();
            (tokens || []).forEach((t) => byId.set(t.id, t));
            this.heroes = links
                .map((l) => byId.get(l.token_id))
                .filter(Boolean)
                .map((t) => ({
                    ...t,
                    price: Number(t.purchase_price_usdc || t.rental_price_usdc || 0),
                    players: Number(t.players_count || 0),
                }));

            if (count) count.textContent = String(this.heroes.length);
            this._paintRoster();
        } catch (err) {
            host.innerHTML = `<div class="hud-muted" style="grid-column: 1 / -1;">Failed to load roster.</div>`;
        }
    }

    /**
     * Loads either:
     *   - Steam title: a single big ▶ Play button (no DexHero NFT pick;
     *     entitlement is the player's Steam library, verified via OpenID)
     *   - First-party (registered) title: the user's compatible DexHeros
     *     filtered by game_token_links — clicking one routes to
     *     /#/play?game=<id>&hero=<id>
     */
    async _loadMyHeroes() {
        const host = this.root.querySelector('[data-my-heroes]');
        if (!host) return;

        const s = wallet.getStatus();

        // ── Steam titles: wallet-free flow ─────────────────────────
        if (this.isSteam) {
            // Check Steam sign-in status (sessionStorage token OR wallet-bound link).
            try {
                const qs = s.connected ? `?wallet=${encodeURIComponent(s.address)}` : '';
                const me = await steamFetch(`/api/steam/me${qs}`).then((r) => r.json()).catch(() => ({ linked: false }));
                this.steamMe = me;
            } catch {
                this.steamMe = { linked: false };
            }
            if (this.steamMe?.linked) {
                return this._renderSteamLoadout(host);
            }
            // Crossover case: this Steam appid is ALSO a DexHero-registered
            // game and the user doesn't have a wallet connected. Prefer
            // the Connect Wallet CTA — for registered games the wallet is
            // the primary identity (Steam is supplemental for credentials).
            if (this.registeredGame && !s.connected) {
                host.innerHTML = `
                    <div class="td-steam-signin-wrap">
                        <button class="td-steam-signin td-steam-signin--wallet" data-connect-wallet type="button">
                            <span class="td-steam-signin__icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <rect x="2" y="6" width="20" height="13" rx="2"/>
                                    <path d="M22 10h-4a2 2 0 0 0 0 4h4"/>
                                    <path d="M2 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </span>
                            <span class="td-steam-signin__label">
                                <span class="td-steam-signin__top">Connect your</span>
                                <span class="td-steam-signin__brand">WALLET</span>
                            </span>
                            <span class="td-steam-signin__chev" aria-hidden="true">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </span>
                        </button>
                    </div>`;
                host.querySelector('[data-connect-wallet]')?.addEventListener('click', () => {
                    if (typeof window.openConnectModal === 'function') window.openConnectModal();
                    else wallet.connect().catch(() => {});
                }, { signal: this.signal });
                return;
            }
            host.innerHTML = `
                <div class="td-steam-signin-wrap">
                    <button class="td-steam-signin" data-steam-signin type="button">
                        <span class="td-steam-signin__icon">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M12 1.5C5.93 1.5 0.99 6.18 0.55 12.1l6.43 2.66c.54-.37 1.2-.59 1.9-.59l.18.01 2.86-4.15v-.06c0-2.5 2.03-4.53 4.53-4.53s4.53 2.03 4.53 4.53-2.03 4.53-4.53 4.53l-.1-.01-4.08 2.91c0 .05.01.1.01.15 0 1.86-1.51 3.37-3.37 3.37-1.64 0-3-1.17-3.31-2.72L1.6 16.27C2.85 20.5 7.07 22.5 12 22.5c5.8 0 10.5-4.7 10.5-10.5S17.8 1.5 12 1.5zM7.4 17.77c1.42.59 3.08-.08 3.67-1.5s-.08-3.08-1.5-3.67c-.6-.25-1.24-.27-1.8-.1l1.6.66c1.04.43 1.54 1.63 1.11 2.67-.43 1.04-1.63 1.54-2.67 1.11-.78-.32-1.46-.97-.41-.83zM19.45 9.97c0-1.67-1.36-3.02-3.02-3.02-1.67 0-3.02 1.36-3.02 3.02 0 1.67 1.36 3.02 3.02 3.02 1.67.01 3.02-1.35 3.02-3.02zm-5.27-.01c0-1.25 1.02-2.27 2.27-2.27s2.27 1.02 2.27 2.27c0 1.25-1.01 2.27-2.27 2.27-1.25 0-2.27-1.02-2.27-2.27z"/>
                            </svg>
                        </span>
                        <span class="td-steam-signin__label">
                            <span class="td-steam-signin__top">Sign in through</span>
                            <span class="td-steam-signin__brand">STEAM</span>
                        </span>
                        <span class="td-steam-signin__chev" aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                    </button>
                </div>`;
            host.querySelector('[data-steam-signin]')?.addEventListener('click', () => {
                // Round-trip the current game-detail hash so OpenID returns
                // here, not the lobby. The user continues exactly where
                // they left off.
                const ret = encodeURIComponent(location.hash || `#/game/${this.steamAppid}`);
                window.location.href = `/api/steam/auth/begin?return=${ret}`;
            }, { signal: this.signal });
            return;
        }

        // ── First-party titles: wallet-required DexHero pick ───────
        // DexHero-registered games sign players in via wallet, not Steam.
        // The button mirrors the Steam sign-in design (same two-tier
        // label structure + chevron + restrained navy palette) so the
        // sign-in affordance reads consistently across game types.
        if (!s.connected) {
            host.innerHTML = `
                <div class="td-steam-signin-wrap">
                    <button class="td-steam-signin td-steam-signin--wallet" data-connect-wallet type="button">
                        <span class="td-steam-signin__icon">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <rect x="2" y="6" width="20" height="13" rx="2"/>
                                <path d="M22 10h-4a2 2 0 0 0 0 4h4"/>
                                <path d="M2 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </span>
                        <span class="td-steam-signin__label">
                            <span class="td-steam-signin__top">Connect your</span>
                            <span class="td-steam-signin__brand">WALLET</span>
                        </span>
                        <span class="td-steam-signin__chev" aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                    </button>
                </div>`;
            host.querySelector('[data-connect-wallet]')?.addEventListener('click', () => {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            }, { signal: this.signal });
            return;
        }

        host.innerHTML = `<div class="panel-state" style="padding:14px 0;"><div class="hud-spin"></div><div class="hud-label" style="margin-top:6px;">Loading your DexHeros…</div></div>`;
        try {
            // Steam titles: any DexHero the wallet owns is a valid "ride"
            // (no game_token_links curation). First-party titles: filter
            // by /api/game/player/dexheros which checks game_token_links.
            const url = this.isSteam
                ? `/api/dexheros?wallet=${encodeURIComponent(s.address)}`
                : `/api/game/player/dexheros?wallet=${encodeURIComponent(s.address)}&gameId=${encodeURIComponent(this.gameId)}`;
            const r = await fetch(url, { headers: { 'X-Internal-Game-Request': '1' } });
            const j = await r.json().catch(() => ({}));
            this.myHeroes = j.dexheros || j.tokens || [];
        } catch (err) {
            this.myHeroes = [];
            console.warn('[game-detail] my-heroes load:', err.message);
        }

        if (!this.myHeroes.length) {
            host.innerHTML = `
                <div class="panel-state" style="padding:14px 0;">
                    <div class="panel-state__body">${this.isSteam
                        ? 'You don\'t own a DexHero yet. You need one to play on Project WarpStream.'
                        : 'You don\'t own a DexHero compatible with this game.'}</div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                        <a class="hud-btn hud-btn--primary hud-btn--sm" href="#/market/dexheros">Browse DexHeros</a>
                    </div>
                </div>`;
            return;
        }

        // Render the user's compatible DexHeros as a horizontal strip —
        // original tile design, just scrolls left/right instead of
        // wrapping into a grid.
        const playQuery = this.isSteam
            ? (heroId) => `#/play?steamAppid=${this.steamAppid}&hero=${encodeURIComponent(heroId)}`
            : (heroId) => `#/play?game=${encodeURIComponent(this.gameId)}&hero=${encodeURIComponent(heroId)}`;
        const tilesHtml = this.myHeroes.map((d) => `
            <a class="td-steam-tile"
               href="${playQuery(d.id)}"
               data-profile-kind="hero"
               data-profile-id="${escapeHTML(String(d.id))}"
               data-profile-label="${escapeHTML(d.name || d.id)}"
               data-profile-image="${d.image_url ? sanitizeURL(d.image_url) : ''}">
                <div class="td-steam-tile__img">
                    ${d.image_url ? `<img src="${sanitizeURL(d.image_url)}" alt="">` : `<span class="td-steam-tile__initial">${STEAM_LOGO_SVG}</span>`}
                </div>
                <div class="td-steam-tile__name">${escapeHTML(d.name || d.id)}</div>
                <div class="td-steam-tile__sub">${escapeHTML(d.access_type || 'access')}</div>
            </a>
        `).join('');
        host.innerHTML = this._renderTileStrip(tilesHtml);
        this._wireTileStrips();
    }

    /**
     * Steam path — render the "pick profile/character to play as" picker.
     * Pulls everything Steam exposes for the (account, appid) pair from
     * `/api/steam/game/:appid/loadout`:
     *   - Steam profile card (persona + avatar + playtime + achievements)
     *   - DexHero roster (if the wallet owns any — Steam titles aren't
     *     gated by game_token_links, so any owned DexHero is rideable)
     *   - Game-specific characters (Dota 2 heroes / TF2 classes) when
     *     Steam's per-game API exposes them
     *   - Inventory preview (Steam Inventory Service — works for the
     *     games that opt in: CS2, Rust, PUBG, Dota 2, TF2…)
     *
     * Each character/inventory tile launches with `&character=<id>` so the
     * host knows which loadout to spawn the session into. Profile-only
     * play (no specific character) is the top "Play as <persona>" CTA.
     */
    async _renderSteamLoadout(host) {
        host.innerHTML = `<div class="panel-state" style="padding:14px 0;"><div class="hud-spin"></div><div class="hud-label" style="margin-top:6px;">Loading your Steam loadout…</div></div>`;

        const s = wallet.getStatus();
        // Pass the wallet param so the endpoint can resolve wallet-bound
        // Steam auth (steam_links lookup) the same way /api/steam/me does
        // — otherwise users signed in via wallet-link (no browser session
        // token) get linked:false and fall through to the sign-in CTA.
        const qs = s.connected ? `?wallet=${encodeURIComponent(s.address)}` : '';
        let data;
        try {
            data = await steamFetch(`/api/steam/game/${this.steamAppid}/loadout${qs}`).then((r) => r.json());
        } catch (err) {
            console.warn('[game-detail] loadout fetch failed:', err.message);
            data = { linked: false };
        }
        if (!data?.linked) {
            // Loadout endpoint couldn't resolve the user to a steamId64 even
            // though /api/steam/me said they're linked. Surface a minimal
            // Play CTA (the session can still launch — host receives steamId
            // from its own session lookup) rather than bouncing to sign-in
            // (which would create a confusing loop for the user).
            const persona = this.steamMe?.persona_name || 'Steam user';
            host.innerHTML = `
                <div class="td-steam-profile">
                    <div class="td-steam-profile__id">
                        ${realAvatar(this.steamMe?.avatar_url) ? `<img class="td-steam-profile__avatar" src="${sanitizeURL(this.steamMe.avatar_url)}" alt="">` : `<div class="td-steam-profile__avatar td-steam-profile__avatar--placeholder">${STEAM_LOGO_SVG}</div>`}
                        <div class="td-steam-profile__meta">
                            <div class="td-steam-profile__name">${escapeHTML(persona)}</div>
                            <div class="td-steam-profile__stats"><span>Signed in</span></div>
                        </div>
                    </div>
                </div>`;
            return;
        }

        const persona = data.profile?.persona_name || 'Steam user';
        const avatar  = data.profile?.avatar_url;
        const totalHrs = Math.round(((data.playtime?.total_minutes || 0) / 60) * 10) / 10;
        const recentMin = data.playtime?.recent_2w_minutes || 0;
        const recentLabel = recentMin > 0
            ? `${(recentMin / 60).toFixed(1)}h last 2 weeks`
            : 'No recent playtime';
        const achPct = data.achievements?.percent ?? null;
        const achLabel = data.achievements
            ? `${data.achievements.earned}/${data.achievements.total} achievements · ${achPct}%`
            : 'No achievement schema';

        const playUrl = (extra = '') =>
            `#/play?steamAppid=${this.steamAppid}${extra}`;

        // ── Header: Steam profile card (display-only)
        // The persona was previously selectable via an explicit "Play as"
        // button. With scroll-driven auto-selection, the centered tile in
        // the strip below IS the active profile — so this card is now
        // pure context (avatar + persona name + playtime + achievement
        // progress), no click affordance. A user who has no DexHero /
        // character / inventory tiles still launches as their Steam
        // persona by default because the server-row /play hrefs simply
        // omit the &kind=id query when no profile is selected.
        const profileCard = `
            <div class="td-steam-profile">
                <div class="td-steam-profile__id">
                    ${realAvatar(avatar) ? `<img class="td-steam-profile__avatar" src="${sanitizeURL(avatar)}" alt="">` : `<div class="td-steam-profile__avatar td-steam-profile__avatar--placeholder">${STEAM_LOGO_SVG}</div>`}
                    <div class="td-steam-profile__meta">
                        <div class="td-steam-profile__name">${escapeHTML(persona)}</div>
                        <div class="td-steam-profile__stats">
                            ${totalHrs > 0 ? `<span>${totalHrs}h total</span>` : ''}
                            ${recentMin > 0 ? `<span>· ${recentLabel}</span>` : ''}
                        </div>
                        ${achPct != null ? `
                            <div class="td-steam-profile__ach">
                                <div class="td-steam-profile__ach-bar"><div class="td-steam-profile__ach-fill" style="width:${achPct}%;"></div></div>
                                <div class="td-steam-profile__ach-label">${escapeHTML(achLabel)}</div>
                            </div>` : ''}
                    </div>
                </div>
            </div>`;

        // ── DexHero strip (only if wallet connected)
        // Crossover: when this Steam game is ALSO registered in DexHero
        // (registered_games.steam_app_id = this.steamAppid), pull the
        // game-filtered list so the picker only surfaces heroes
        // compatible with THIS specific game (via game_token_links).
        // Otherwise — pure Steam title — list every DexHero in the
        // wallet, since any of them are a valid ride for Steam streams.
        let dexheroBlock = '';
        if (s.connected) {
            try {
                const dexUrl = this.registeredGame
                    ? `/api/game/player/dexheros?wallet=${encodeURIComponent(s.address)}&gameId=${encodeURIComponent(this.registeredGame.id)}`
                    : `/api/dexheros?wallet=${encodeURIComponent(s.address)}`;
                const r = await fetch(dexUrl, {
                    headers: { 'X-Internal-Game-Request': '1' },
                });
                const j = await r.json().catch(() => ({}));
                const dex = j.dexheros || j.tokens || [];
                if (dex.length) {
                    const sectionTitle = this.registeredGame
                        ? 'DexHeros linked to this game'
                        : 'Your DexHeros';
                    dexheroBlock = `
                        <div class="td-steam-section">
                            <div class="td-steam-section__title">${escapeHTML(sectionTitle)}</div>
                            ${this._renderTileStrip(dex.map((d) => `
                                <a class="td-steam-tile"
                                   href="${playUrl(`&hero=${encodeURIComponent(d.id)}`)}"
                                   data-profile-kind="hero"
                                   data-profile-id="${escapeHTML(String(d.id))}"
                                   data-profile-label="${escapeHTML(d.name || d.id)}"
                                   data-profile-image="${d.image_url ? sanitizeURL(d.image_url) : ''}">
                                    <div class="td-steam-tile__img">
                                        ${d.image_url ? `<img src="${sanitizeURL(d.image_url)}" alt="">` : `<span class="td-steam-tile__initial">${STEAM_LOGO_SVG}</span>`}
                                    </div>
                                    <div class="td-steam-tile__name">${escapeHTML(d.name || d.id)}</div>
                                    <div class="td-steam-tile__sub">DexHero</div>
                                </a>
                            `).join(''))}
                        </div>`;
                }
            } catch (err) { console.warn('[game-detail] dexheros:', err.message); }
        }

        // ── Characters strip (Dota 2 heroes / TF2 classes / …)
        let charactersBlock = '';
        if (data.characters?.length) {
            charactersBlock = `
                <div class="td-steam-section">
                    <div class="td-steam-section__title">Your characters</div>
                    ${this._renderTileStrip(data.characters.map((c) => `
                        <a class="td-steam-tile"
                           href="${playUrl(`&character=${encodeURIComponent(c.id)}`)}"
                           data-profile-kind="character"
                           data-profile-id="${escapeHTML(String(c.id))}"
                           data-profile-label="${escapeHTML(c.name)}"
                           data-profile-image="${c.image ? sanitizeURL(c.image) : ''}">
                            <div class="td-steam-tile__img">
                                ${c.image ? `<img src="${sanitizeURL(c.image)}" alt="" loading="lazy">` : `<span class="td-steam-tile__initial">${STEAM_LOGO_SVG}</span>`}
                            </div>
                            <div class="td-steam-tile__name">${escapeHTML(c.name)}</div>
                            <div class="td-steam-tile__sub">${escapeHTML(c.stat_label || '')}</div>
                        </a>
                    `).join(''))}
                </div>`;
        }

        // ── Inventory strip
        let inventoryBlock = '';
        if (data.inventory?.length) {
            inventoryBlock = `
                <div class="td-steam-section">
                    <div class="td-steam-section__title">Loadout · Inventory</div>
                    ${this._renderTileStrip(data.inventory.map((it) => `
                        <a class="td-steam-tile td-steam-tile--inv"
                           href="${playUrl(`&item=${encodeURIComponent(it.assetid)}`)}"
                           title="${escapeHTML(it.name || '')}"
                           data-profile-kind="item"
                           data-profile-id="${escapeHTML(String(it.assetid))}"
                           data-profile-label="${escapeHTML(it.name || '')}"
                           data-profile-image="${it.image ? sanitizeURL(it.image) : ''}">
                            <div class="td-steam-tile__img">
                                ${it.image ? `<img src="${sanitizeURL(it.image)}" alt="" loading="lazy">` : ''}
                            </div>
                            <div class="td-steam-tile__name">${escapeHTML(it.name || '')}</div>
                            ${it.rarity ? `<div class="td-steam-tile__sub td-steam-tile__sub--rarity">${escapeHTML(it.rarity)}</div>` : ''}
                        </a>
                    `).join(''))}
                </div>`;
        }

        host.innerHTML = profileCard + dexheroBlock + charactersBlock + inventoryBlock;
        this._wireTileStrips();
    }

    /**
     * Wrap a string of tile HTML in a vertical "slot machine" strip.
     * One profile fully visible at a time; the rows above and below
     * peek through fade masks at the top + bottom edges so the user
     * sees "there's more, scroll up/down". Snap-Y locks each scroll
     * step to a row. Up/down chevron buttons sit on the right edge as
     * an explicit affordance alongside native wheel/touch scroll.
     */
    _renderTileStrip(tilesHtml) {
        return `
            <div class="td-steam-strip-wrap" data-strip-wrap>
                <div class="td-steam-strip td-steam-strip--slot" data-strip>${tilesHtml}</div>
                <div class="td-steam-strip__nav">
                    <button class="td-steam-strip__arrow td-steam-strip__arrow--prev" type="button" tabindex="-1" aria-label="Previous profile" hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                    </button>
                    <button class="td-steam-strip__arrow td-steam-strip__arrow--next" type="button" tabindex="-1" aria-label="Next profile">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
            </div>`;
    }

    /**
     * Wire every vertical slot-machine strip on the page. Each click on
     * the up/down chevron snaps the scroll by exactly one row. Arrows
     * auto-hide whenever the strip is at the corresponding edge so they
     * only show when there's actually somewhere to go.
     */
    _wireTileStrips() {
        this.root.querySelectorAll('[data-strip-wrap]').forEach((wrap) => {
            const strip = wrap.querySelector('[data-strip]');
            const prev  = wrap.querySelector('.td-steam-strip__arrow--prev');
            const next  = wrap.querySelector('.td-steam-strip__arrow--next');
            if (!strip) return;
            const rowHeight = () => (strip.firstElementChild?.offsetHeight || 92);
            const step = (dir) => strip.scrollBy({ top: dir * rowHeight(), behavior: 'smooth' });
            const findCentered = () => {
                const center = strip.scrollTop + strip.clientHeight / 2;
                let closest = null, closestDist = Infinity;
                for (const tile of strip.children) {
                    if (!tile.hasAttribute('data-profile-kind')) continue;
                    const tc = tile.offsetTop + tile.offsetHeight / 2;
                    const d = Math.abs(tc - center);
                    if (d < closestDist) { closestDist = d; closest = tile; }
                }
                return closest;
            };
            const update = () => {
                const atStart = strip.scrollTop <= 2;
                const atEnd   = strip.scrollTop + strip.clientHeight >= strip.scrollHeight - 2;
                if (prev) prev.hidden = atStart;
                if (next) next.hidden = atEnd;
                // Auto-select the currently-centered tile in this strip.
                // The user never has to click to confirm — whichever row
                // is fully visible IS the active selection.
                const tile = findCentered();
                if (tile) this._setChosenProfile(tile);
            };
            prev?.addEventListener('click', () => step(-1), { signal: this.signal });
            next?.addEventListener('click', () => step(+1), { signal: this.signal });
            strip.addEventListener('scroll', update, { passive: true, signal: this.signal });
            requestAnimationFrame(update);
        });
    }

    _wireSort() {
        this.root.querySelectorAll('[data-sort]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.sort = btn.getAttribute('data-sort');
                this.root.querySelectorAll('[data-sort]').forEach((b) => {
                    b.setAttribute('aria-selected', b.getAttribute('data-sort') === this.sort);
                });
                this._paintRoster();
            }, { signal: this.signal });
        });
    }

    /** About-section expand/collapse. Default state is collapsed (2-line
     *  preview); clicking the divider toggles the full description. */
    _wireAboutToggle() {
        const toggle  = this.root.querySelector('[data-about-toggle]');
        const section = this.root.querySelector('[data-about-section]');
        if (!toggle || !section) return;
        toggle.addEventListener('click', () => {
            const expanded = section.classList.toggle('td-about-section--expanded');
            toggle.setAttribute('aria-expanded', String(expanded));
        }, { signal: this.signal });
    }

    /**
     * Profile picker — scroll-driven auto-selection.
     *
     * Whichever row is fully visible (centered) in a strip is automatically
     * the active selection — no click required to confirm. Scrolling
     * vertically inside any strip changes the selection in real time.
     *
     * - Divider toggle: clicking "Pick a profile ▾" still expands/collapses
     *   the section manually. Starts expanded so the picker is visible.
     * - Click on a tile: scrolls that tile to the strip's center. The strip's
     *   scroll handler then updates the selection from there.
     * - The persona "Play as ..." button (which lives outside any strip)
     *   selects directly on click.
     *
     * Server rows always carry the current selection in their /play hrefs;
     * `_setChosenProfile` re-stamps them every time the selection changes.
     */
    _wireProfilePicker() {
        const section = this.root.querySelector('[data-profile-section]');
        const toggle  = this.root.querySelector('[data-profile-toggle]');
        if (!section || !toggle) return;

        toggle.addEventListener('click', () => {
            const expanded = section.classList.toggle('td-profile-section--expanded');
            toggle.setAttribute('aria-expanded', String(expanded));
        }, { signal: this.signal });

        section.addEventListener('click', (e) => {
            const tile = e.target.closest?.('[data-profile-kind]');
            if (!tile || !section.contains(tile)) return;
            e.preventDefault();
            // If the tile lives inside a scroll strip, just bring it to
            // center — the strip's scroll listener will auto-select via
            // _setChosenProfile. If it lives outside a strip (the persona
            // "Play as ..." button), select it directly.
            const strip = tile.closest('[data-strip]');
            if (strip) tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
            else       this._setChosenProfile(tile);
        }, { signal: this.signal });
    }

    /** Central selection setter. Captures the tile's data-profile-* attrs
     *  into `this._chosenProfile`, marks the tile visually selected (clears
     *  any prior), updates the divider label, and re-stamps server-row
     *  hrefs so clicking a region launches with the chosen profile pinned.
     *  Called both by scroll-snap auto-selection and by direct persona
     *  clicks; no-ops when the tile is already the active selection. */
    _setChosenProfile(tile) {
        const kind  = tile.getAttribute('data-profile-kind');
        const id    = tile.getAttribute('data-profile-id') || '';
        const label = tile.getAttribute('data-profile-label') || '';
        // Skip no-op selections (avoids redundant DOM churn during scroll).
        if (this._chosenProfile && this._chosenProfile.kind === kind && this._chosenProfile.id === id) return;
        this._chosenProfile = {
            kind, id, label,
            image: tile.getAttribute('data-profile-image') || '',
        };
        const section = this.root.querySelector('[data-profile-section]');
        if (section) {
            section.querySelectorAll('.td-profile-tile--selected').forEach((el) => el.classList.remove('td-profile-tile--selected'));
            tile.classList.add('td-profile-tile--selected');
            const labelEl = section.querySelector('[data-profile-label]');
            if (labelEl) labelEl.textContent = `Playing as · ${label}`;
        }
        this._restampServerRowHrefs();
    }

    /** Re-build every server-row anchor's href to include the chosen
     *  profile (when set) so clicking a region launches with that profile
     *  pinned. Called after a profile is picked, and right after the region
     *  preview paints fresh rows. */
    _restampServerRowHrefs() {
        const rows = this.root.querySelectorAll('[data-region-mini] a[data-region]');
        const profileQs = this._chosenProfile
            ? `&${encodeURIComponent(this._chosenProfile.kind === 'persona' ? 'persona' : this._chosenProfile.kind)}=${encodeURIComponent(this._chosenProfile.id)}`
            : '';
        rows.forEach((row) => {
            const code = row.getAttribute('data-region');
            const gameQs = this.isSteam ? `&steamAppid=${this.steamAppid}` : `&game=${encodeURIComponent(this.gameId)}`;
            row.setAttribute('href', `#/play?region=${encodeURIComponent(code)}${gameQs}${profileQs}`);
        });
    }

    _paintRoster() {
        const host = this.root.querySelector('[data-roster]');
        if (!host || !this.heroes.length) return;

        const cmp = {
            'price-desc':   (a, b) => b.price - a.price,
            'price-asc':    (a, b) => a.price - b.price,
            'players-desc': (a, b) => b.players - a.players,
            'players-asc':  (a, b) => a.players - b.players,
        }[this.sort] || ((a, b) => b.price - a.price);

        const sorted = [...this.heroes].sort(cmp);
        host.innerHTML = sorted.map((t) => {
            const addr = t.manager_address || t.id;
            const img  = t.image_url;
            const priceText = t.price > 0 ? '$' + fmtNum(t.price, { compact: false, decimals: 2 }) : '—';
            return `
                <a class="hero-card" href="#/token/${encodeURIComponent(addr)}" style="background:transparent;border:1px solid var(--rule);border-radius:3px;overflow:hidden;text-decoration:none;color:var(--ink-0);display:flex;flex-direction:column;transition:border-color var(--dur-sm), box-shadow var(--dur-sm);">
                    <div style="aspect-ratio:1;background:var(--surf-1);display:flex;align-items:center;justify-content:center;">
                        ${img ? `<img src="${sanitizeURL(img)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-size:28px;font-weight:700;color:var(--ink-2);">${escapeHTML((t.name || '?').charAt(0))}</span>`}
                    </div>
                    <div style="padding:8px 10px;border-top:1px solid var(--rule);display:flex;flex-direction:column;gap:4px;">
                        <div style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(t.name || '')}</div>
                        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
                            <span style="font-family:var(--font-mono);font-size:11px;color:var(--acc-cyan);font-variant-numeric:tabular-nums;">${priceText}</span>
                            <span style="font-family:var(--font-mono);font-size:10px;color:var(--ink-3);letter-spacing:0.1em;text-transform:uppercase;">${fmtNum(t.players)} ${t.players === 1 ? 'player' : 'players'}</span>
                        </div>
                    </div>
                </a>
            `;
        }).join('');
    }
}
