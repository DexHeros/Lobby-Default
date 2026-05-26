/* Market panel — two tabs: DexHeros, Games.
   The legacy "Tokens" tab was removed: DexHero detail pages already surface
   the token chart (GeckoTerminal embed) for any DexHero that has either
   tipped on V3 or used the existing-token creation path, so a standalone
   tokens listing was redundant.
   - DexHeros: 3D models from the `models` table, sprite preview + ownership price
   - Tokens: pure tradeable tokens (no linked model), listed by unit price / market cap
   - Games: every registered game, with a count of connected DexHeros
   - Steam: the player's Steam library + all Steam titles being hosted on
     Project WarpStream. Sign-in entry point for the Steam OpenID flow.
   Clicking a game opens the public game-detail panel (roster + filters, no API keys). */

import { Panel, escapeHTML, fmtNum, sanitizeURL } from '../ui/panel.js';
import * as sb from '../services/supabase.js';
import * as wallet from '../services/wallet.js';
import { steamFetch, clearSteamSession } from '../services/steam-session.js';
import { on, E } from '../events.js';

const DEFAULT_TAB = 'games';
const VALID_TABS  = ['games', 'dexheros'];

export default class MarketPanel extends Panel {
    static id        = 'market';
    static variant   = 'right';
    static width     = 680;
    static title     = 'Market';
    static titleBreadcrumb = ['MARKET'];
    static parentHash = '#/';   // back arrow returns to the lobby
    static stageMode = 'keep';

    constructor(params) {
        super(params);
        this.tab = VALID_TABS.includes(params.tab) ? params.tab : DEFAULT_TAB;
        this.dexheros = null;
        this.games    = null;
        this.search   = '';
        this._statsCache    = new Map(); // dexheroId → { playersOnline, serversLive, sessions24h }
        this._appMetaCache  = new Map(); // appid → { name, header_image }
    }

    render() {
        // Tabs live in the panel header (see _paintHeaderTabs) — replaces
        // the default "MARKET" breadcrumb with the DexHeros/Games switcher.
        // Body only renders the search field + list.
        const placeholder = this.tab === 'dexheros' ? 'Search DexHeros…'
                                                    : 'Search games…';
        return `
            <div class="hud-field" style="margin-bottom:18px;">
                <input type="search" class="hud-input" placeholder="${placeholder}" data-search value="${escapeHTML(this.search)}">
            </div>
            <div data-list>
                <div class="panel-state"><div class="hud-spin"></div><div>Loading ${this.tab}</div></div>
            </div>
        `;
    }

    async onMount() {
        this._wireHead();
        await this._load();
        this._paintList();
    }

    onParamsChange(params) {
        const nextTab = VALID_TABS.includes(params.tab) ? params.tab : DEFAULT_TAB;
        if (nextTab !== this.tab) {
            this.tab = nextTab;
            this.search = '';
            this.rerender();
            this._wireHead();
            this._load().then(() => this._paintList());
        }
    }

    // Inject the DexHeros/Games tabs into the panel header's .panel__title
    // element, replacing the default "MARKET" breadcrumb text. Idempotent:
    // only rewrites innerHTML when tab state changed so MutationObservers
    // and focus don't flap on every wire pass.
    _paintHeaderTabs() {
        const titleEl = this.root?.querySelector('.panel__title');
        if (!titleEl) return;
        const html = `
            <button class="panel__tab" data-tab="games"    type="button" aria-pressed="${this.tab === 'games'}">Games</button>
            <button class="panel__tab" data-tab="dexheros" type="button" aria-pressed="${this.tab === 'dexheros'}">DexHeros</button>
        `;
        if (titleEl.innerHTML.trim() !== html.trim()) titleEl.innerHTML = html;
        titleEl.classList.add('panel__title--tabs');
    }

    _wireHead() {
        this._paintHeaderTabs();
        this.root.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                // Navigate by hash only; onParamsChange() will detect the diff.
                const nextTab = btn.getAttribute('data-tab');
                location.hash = `#/market/${nextTab}`;
            }, { signal: this.signal });
        });
        const input = this.root.querySelector('[data-search]');
        input?.addEventListener('input', (e) => {
            this.search = e.target.value.trim().toLowerCase();
            this._paintList();
        }, { signal: this.signal });
    }

    async _load() {
        if (this.tab === 'dexheros' && !this.dexheros) await this._loadDexHeros();
        if (this.tab === 'games'    && !this.games)    await this._loadGames();
    }

    async _loadSteam() {
        const s = wallet.getStatus();
        const out = { linked: false, mode: null, persona_name: null, avatar_url: null, library: [], hosted: [] };
        try {
            // Always fetch the platform-wide hosted titles — that's the
            // discovery section even for unlinked / unconnected visitors.
            const hostedRes = await fetch('/api/cloud/hosted-titles').then((r) => r.json()).catch(() => ({ titles: [] }));
            out.hosted = hostedRes.titles || [];
        } catch {}

        // /api/steam/me + /api/cloud/your-library both work two ways:
        //   - ?wallet=0x… for wallet-bound users
        //   - X-Steam-Session header (sessionStorage) for tab-bound Steam-only sessions
        // steamFetch attaches the header automatically when a token is set.
        const qs = s.connected ? `?wallet=${encodeURIComponent(s.address)}` : '';
        try {
            const [meRes, libRes] = await Promise.all([
                steamFetch(`/api/steam/me${qs}`).then((r) => r.json()).catch(() => ({ linked: false })),
                steamFetch(`/api/cloud/your-library${qs}`).then((r) => r.json()).catch(() => ({ games: [] })),
            ]);
            out.linked       = !!meRes.linked;
            out.mode         = meRes.mode || null;
            out.persona_name = meRes.persona_name || null;
            out.avatar_url   = meRes.avatar_url || null;
            out.library      = libRes.games || [];
        } catch {}

        this.steam = out;
    }

    /* A "DexHero" is any entry that has a 3D model attached — this can live
       in the `tokens` table (model_url column) OR in the `models` table
       (each row is a first-class DexHero). Tokens-table rows without an
       asset used to feed a separate "Tokens" tab; that tab was removed
       since DexHero detail pages already surface the GeckoTerminal chart
       for tipped + existing-token DexHeros. */

    async _loadAll() {
        if (this._mergedCache) return this._mergedCache;
        const client = await sb.ready();

        const [modelsRes, tokensRes] = await Promise.all([
            client.from('models')
                .select('*')
                .not('name', 'is', 'null')
                .order('created_at', { ascending: false })
                .limit(500),
            client.from('tokens')
                .select('*')
                .not('name', 'is', 'null')
                .not('contract_address', 'is', 'null')
                .order('created_at', { ascending: false })
                .limit(500),
        ]);

        const models = modelsRes.data || [];
        const tokens = tokensRes.data || [];
        const linkedTokenIds = new Set(models.map((m) => m.token_id).filter(Boolean));
        const tokenById = new Map(tokens.map((t) => [t.id, t]));

        const dexheros = [];

        // 1) Every models row is a DexHero, enriched with the linked token's
        //    sprite / manager_address / price data if available.
        for (const m of models) {
            const linked = m.token_id ? tokenById.get(m.token_id) : null;
            dexheros.push({
                id: m.id,
                name: m.name,
                symbol: m.symbol || (linked?.symbol) || (m.description ? String(m.description).slice(0, 4).toUpperCase() : 'HERO'),
                image_url: m.thumbnail_url || m.preview_image_url || linked?.image_url || null,
                model_url: m.model_url || linked?.model_url || null,
                chain: m.blockchain || linked?.chain || 'sepolia',
                manager_address: linked?.manager_address || m.evm_contract_address || m.id,
                purchase_price_usdc: Number(linked?.purchase_price_usdc || m.purchase_price || 0),
                rental_price_usdc:   Number(linked?.rental_price_usdc   || m.rental_price_usd || m.rental_price_per_day || 0),
                created_at: m.created_at,
            });
        }

        // 2) Tokens-table rows with a 3D asset (model_url / sprite_url) that
        //    aren't already linked to a `models` row → also DexHeros. Rows
        //    without an asset are dropped from this view entirely.
        for (const t of tokens) {
            if (linkedTokenIds.has(t.id)) continue;
            if (!(t.model_url || t.sprite_url)) continue;
            dexheros.push({
                id: t.id,
                name: t.name,
                symbol: t.symbol || '',
                image_url: t.image_url,
                model_url: t.model_url,
                chain: t.chain || t.network || 'sepolia',
                manager_address: t.manager_address || t.contract_address || t.id,
                purchase_price_usdc: Number(t.purchase_price_usdc || 0),
                rental_price_usdc:   Number(t.rental_price_usdc   || 0),
                created_at: t.created_at,
            });
        }

        dexheros.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        console.log('[market] loaded — dexheros:', dexheros.length,
            ' (models:', models.length, ' tokens-table:', tokens.length, ')');

        this._mergedCache = { dexheros };
        return this._mergedCache;
    }

    async _loadDexHeros() {
        try {
            const { dexheros } = await this._loadAll();
            this.dexheros = dexheros;
        } catch (err) {
            console.warn('[market] dexheros load failed:', err.message);
            this.dexheros = [];
        }
    }

    async _loadGames() {
        try {
            const client = await sb.ready();
            const s = wallet.getStatus();

            // Pull registered_games (DexHero-native games) + Steam library
            // in parallel. Steam library is optional — only populated when
            // the user is signed into Steam via wallet link OR session token.
            const qs = s.connected ? `?wallet=${encodeURIComponent(s.address)}` : '';
            const [registeredRes, steamLib] = await Promise.all([
                client
                    .from('registered_games')
                    .select('id, slug, title, icon_url, tier, status, goes_live_at, created_at')
                    .neq('status', 'deactivated')
                    .order('created_at', { ascending: false })
                    .limit(200),
                steamFetch(`/api/cloud/your-library${qs}`).then((r) => r.ok ? r.json() : null).catch(() => null),
            ]);
            if (registeredRes.error) throw registeredRes.error;
            const registered = registeredRes.data || [];

            // Connected DexHeros per native game
            let linkCounts = {};
            try {
                const { data: links } = await client
                    .from('game_token_links')
                    .select('game_id');
                for (const l of (links || [])) {
                    linkCounts[l.game_id] = (linkCounts[l.game_id] || 0) + 1;
                }
            } catch { /* link table optional */ }

            const nativeGames = registered.map((g) => ({
                ...g,
                source: 'native',
                dexheros_count: linkCounts[g.id] || 0,
            }));

            // Steam games shape: { appid, hostsAvailable }. Names/icons are
            // lazy-hydrated post-render via /api/steam/app-meta (same path
            // the old Steam tab used). Dedupe vs native by slug ≠ appid so
            // a native row never collides; if a registered_game's slug is
            // literally `appid-<N>` we strip the duplicate.
            const steamGames = ((steamLib?.games) || []).map((g) => ({
                source: 'steam',
                appid: g.appid,
                hostsAvailable: g.hostsAvailable || 0,
                playtimeMinutes: g.playtimeMinutes || 0,
                friendsOnline:   g.friendsOnline   || 0,
                // Placeholder until app-meta fetch completes
                title: this._appMetaCache.get(g.appid)?.name || `App ${g.appid}`,
                icon_url: this._appMetaCache.get(g.appid)?.header_image || null,
                slug: `appid-${g.appid}`,
                created_at: 0,
            }));

            // Sort: native first (highest DexHero count to lowest), then
            // Steam by host availability (titles with live hosts first).
            nativeGames.sort((a, b) => (b.dexheros_count || 0) - (a.dexheros_count || 0));
            steamGames.sort((a, b) => (b.hostsAvailable || 0) - (a.hostsAvailable || 0));

            this.games = [...nativeGames, ...steamGames];
        } catch (err) {
            console.warn('[market] games load failed:', err.message);
            this.games = [];
        }
    }

    _paintList() {
        const host = this.root.querySelector('[data-list]');
        if (!host) return;

        const rows = this.tab === 'dexheros' ? this._dexheroRows()
                                             : this._gameRows();
        if (rows == null) {
            host.innerHTML = `<div class="panel-state"><div class="hud-spin"></div><div>Loading</div></div>`;
            return;
        }
        if (!rows.length) {
            host.innerHTML = `<div class="panel-state"><div class="panel-state__body">No ${this.tab} yet.</div></div>`;
            return;
        }
        host.innerHTML = rows.join('');
        // Lazy-load per-DexHero stats once the list renders. Batched call
        // so we make ONE round-trip per paint regardless of list length.
        if (this.tab === 'dexheros') this._hydrateStats(host);
        // Steam games in the games tab have data-app-meta attributes — fetch
        // names/icons in batches of 30. Repaint when complete so titles +
        // capsule artwork swap in for the placeholder "App N" text.
        if (this.tab === 'games') this._hydrateAppMeta(host);
    }

    _paintSteam(host) {
        if (!this.steam) {
            host.innerHTML = `<div class="panel-state"><div class="hud-spin"></div><div>Loading</div></div>`;
            return;
        }
        const sx = this.steam;
        const q = this.search;

        // Steam play is wallet-free. The only gate is the Steam OpenID
        // sign-in itself. If the user isn't signed in, we show a single
        // "Sign in through Steam" CTA — no wallet required.
        let signInGate = '';
        if (!sx.linked) {
            signInGate = `
                <section class="panel-section" style="text-align:center;padding:24px 16px;">
                    <div class="hud-display" style="font-size:16px;margin-bottom:14px;">Sign in with Steam</div>
                    <button class="hud-btn hud-btn--primary" data-steam-signin style="padding:14px 32px;font-size:14px;letter-spacing:0.16em;">↗ Sign in through Steam</button>
                </section>`;
        }

        // ── Your library section ────────────────────────────────────
        let libraryHtml = '';
        if (sx.linked) {
            const owned = sx.library || [];
            const filteredOwned = q
                ? owned.filter((it) => {
                    const meta = this._appMetaCache.get(it.appid);
                    return (meta?.name || '').toLowerCase().includes(q);
                })
                : owned;
            libraryHtml = `
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin:8px 0 10px;">
                    <span class="hud-label" style="font-size:11px;letter-spacing:0.18em;">Your library${sx.persona_name ? ` · ${escapeHTML(sx.persona_name)}` : ''}
                        ${sx.mode === 'session' ? `<a href="javascript:void(0)" data-steam-signout style="margin-left:8px;color:var(--ink-3);font-size:9.5px;text-decoration:underline;">Sign out</a>` : ''}
                    </span>
                    <span class="hud-label" style="font-size:9.5px;color:var(--ink-3);">${owned.length} games</span>
                </div>
                ${owned.length === 0
                    ? `<div class="hud-muted" style="font-size:11px;line-height:1.6;padding:12px 0;">Your library is empty or your Steam profile is set to private. <a href="https://steamcommunity.com/my/edit/settings" target="_blank" style="color:#8ab6ff;">Make it public →</a></div>`
                    : `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;">
                        ${filteredOwned.slice(0, 60).map((it) => this._steamCardHtml(it, { ownership: 'owned' })).join('')}
                    </div>`}`;
        }

        // ── All hosted titles section (discovery) ───────────────────
        const ownedSet = new Set((sx.library || []).map((it) => it.appid));
        const hostedAvail = (sx.hosted || []).filter((t) => !ownedSet.has(t.appid));
        const filteredHosted = q
            ? hostedAvail.filter((it) => {
                const meta = this._appMetaCache.get(it.appid);
                return (meta?.name || '').toLowerCase().includes(q);
            })
            : hostedAvail;
        let hostedHtml = '';
        if (filteredHosted.length || (!sx.linked && (sx.hosted || []).length)) {
            const titles = !sx.linked ? (sx.hosted || []) : filteredHosted;
            hostedHtml = `
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin:8px 0 10px;">
                    <span class="hud-label" style="font-size:11px;letter-spacing:0.18em;">${sx.linked ? 'Other titles being hosted' : 'Titles being hosted'}</span>
                    <span class="hud-label" style="font-size:9.5px;color:var(--ink-3);">${titles.length} ${titles.length === 1 ? 'title' : 'titles'}</span>
                </div>
                <div class="hud-muted" style="font-size:10.5px;line-height:1.5;margin-bottom:8px;">${sx.linked ? 'Steam games hosts have installed that are not in your library yet — Family Sharing fallback may be available.' : 'Steam games currently being hosted on Project WarpStream.'}</div>
                <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;">
                    ${titles.slice(0, 30).map((t) => this._steamCardHtml(t, { ownership: 'hosted' })).join('')}
                </div>`;
        }

        host.innerHTML = signInGate + libraryHtml + hostedHtml + (!libraryHtml && !hostedHtml ? `<div class="panel-state"><div class="panel-state__body">No Steam titles being hosted yet.</div></div>` : '');

        // Wire interactions — no wallet step required for Steam sign-in.
        // Round-trip the current SPA hash as `return` so the OpenID flow
        // bounces the user back to /#/market/steam (or wherever they
        // started) instead of the lobby.
        host.querySelector('[data-steam-signin]')?.addEventListener('click', () => {
            const ret = encodeURIComponent(location.hash || '#/market/steam');
            window.location.href = `/api/steam/auth/begin?return=${ret}`;
        }, { signal: this.signal });
        host.querySelector('[data-steam-signout]')?.addEventListener('click', async () => {
            await clearSteamSession();
            this.steam = null;
            this._load().then(() => this._paintList());
        }, { signal: this.signal });

        // Lazy-hydrate Steam metadata for the visible cards
        this._hydrateAppMeta(host);
    }

    _steamCardHtml(item, { ownership }) {
        const meta = this._appMetaCache.get(item.appid);
        const name = meta?.name || `App ${item.appid}`;
        // Steam header_image is a 460×215 (≈2.14:1) capsule; render it at
        // 140×65 so the artwork reads at a glance and the row has breathing
        // room. object-fit:cover keeps the aspect — never stretches.
        const icon = meta?.header_image
            ? `<img src="${escapeHTML(meta.header_image)}" alt="" style="width:140px;height:65px;border-radius:4px;object-fit:cover;flex-shrink:0;background:var(--surf-2);">`
            : `<div style="width:140px;height:65px;border-radius:4px;background:var(--surf-2);flex-shrink:0;"></div>`;
        // Right-side label communicates server availability — we don't dim
        // the whole card when there are no servers (the label is enough).
        // Owned titles always navigate to the game detail page so the user
        // can read about the game even if no host is online yet.
        const rightLabel = ownership === 'owned'
            ? (item.hostsAvailable > 0
                ? `<span style="color:var(--acc-cyan,#22d3ee);font-size:11px;letter-spacing:0.14em;flex-shrink:0;">▶ PLAY</span>`
                : `<span style="color:var(--ink-2);font-size:10px;letter-spacing:0.1em;flex-shrink:0;">No servers</span>`)
            : `<span style="color:var(--ink-2);font-size:10px;letter-spacing:0.1em;flex-shrink:0;">${fmtNum(item.hostCount || 1)} server${(item.hostCount || 1) === 1 ? '' : 's'}</span>`;
        // Subline: hours played + friends online. Replaces the previous
        // "App {appid}" label — the appid wasn't useful info for a player
        // browsing their library, while hours played + friend activity is
        // exactly the signal that drives "what do I want to play next".
        const hrs = item.playtimeMinutes != null
            ? Math.round((item.playtimeMinutes / 60) * 10) / 10
            : null;
        const playedLabel = hrs == null     ? null
                          : hrs >= 1        ? `${hrs}h played`
                          : item.playtimeMinutes > 0 ? `${item.playtimeMinutes}m played`
                          : 'Never played';
        const friends = Number(item.friendsOnline || 0);
        const friendsLabel = friends > 0
            ? `${friends} friend${friends === 1 ? '' : 's'} online`
            : null;
        const sublineBits = [playedLabel, friendsLabel].filter(Boolean);
        const subline = sublineBits.length
            ? `<span style="color:var(--ink-3);font-size:10px;letter-spacing:0.14em;text-transform:uppercase;">${sublineBits.map(escapeHTML).join(' · ')}</span>`
            : '';
        const href = `#/game/${item.appid}`;
        return `
            <a class="panel-row" data-app-meta="${item.appid}" href="${href}" style="--row-cols: 140px 1fr auto;text-decoration:none;">
                ${icon}
                <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
                    <span style="color:var(--ink-0);font-family:var(--font-display);font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(name)}</span>
                    ${subline}
                </span>
                ${rightLabel}
            </a>`;
    }

    async _hydrateAppMeta(host) {
        const slots = host.querySelectorAll('[data-app-meta]');
        const ids = Array.from(slots)
            .map((el) => Number(el.getAttribute('data-app-meta')))
            .filter((n) => Number.isInteger(n) && !this._appMetaCache.has(n));
        if (!ids.length) return;
        await Promise.all(ids.slice(0, 30).map(async (appid) => {
            try {
                const r = await fetch(`/api/steam/app-meta?appid=${appid}`).then((r) => r.json());
                if (r && r.name) this._appMetaCache.set(appid, r);
            } catch {}
        }));
        // Re-paint to show the hydrated names + headers.
        const list = this.root.querySelector('[data-list]');
        if (list && this.tab === 'games') this._paintList();
    }

    async _hydrateStats(host) {
        const ids = Array.from(host.querySelectorAll('[data-dexhero-stats]'))
            .map((el) => el.getAttribute('data-dexhero-stats'))
            .filter(Boolean);
        const missing = ids.filter((id) => !this._statsCache.has(id));
        if (!missing.length) return;
        try {
            const r = await fetch(`/api/dexhero/stats-bulk?ids=${encodeURIComponent(missing.join(','))}`);
            const j = await r.json();
            for (const s of (j.stats || [])) {
                this._statsCache.set(s.id, s);
                const slot = host.querySelector(`[data-dexhero-stats="${cssEsc(s.id)}"]`);
                if (!slot) continue;
                slot.querySelector('[data-stat="players"]').textContent  = s.playersOnline;
                slot.querySelector('[data-stat="servers"]').textContent  = s.serversLive;
                slot.querySelector('[data-stat="sessions"]').textContent = s.sessions24h;
            }
        } catch (err) {
            // Silent — cards already render with zero defaults; stats just
            // stay at 0 if the endpoint flakes.
            console.warn('[market] stats hydrate failed:', err.message);
        }
    }

    /* ── Row renderers ───────────────────────────────────────── */

    _dexheroRows() {
        if (!this.dexheros) return null;
        const q = this.search;
        const list = q
            ? this.dexheros.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.symbol || '').toLowerCase().includes(q))
            : this.dexheros;
        return list.map((t) => {
            const addr  = t.manager_address || t.contract_address || t.id;
            const img   = t.image_url;
            // Price fallback chain: explicit DB column → metadata blob (older
            // create paths persisted price into metadata.purchasePrice) →
            // platform default (10 USDC, the form default). Last resort
            // means legacy rows that pre-date price persistence still show
            // a meaningful number rather than a dash.
            let metaPrice = 0;
            if (t.metadata) {
                try {
                    const m = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata;
                    metaPrice = Number(m.purchasePrice || m.mintPrice || m.mintPriceUSDC || 0);
                } catch {}
            }
            const purchase = Number(t.purchase_price_usdc || 0) || metaPrice;
            const rental   = Number(t.rental_price_usdc || t.rental_price || 0);
            const price    = purchase > 0 ? purchase : (rental > 0 ? rental : 10);
            const priceLabel = purchase > 0 ? 'Own' : rental > 0 ? 'Rent' : 'Mint';

            // Per-DexHero stats slot — populated lazily by _hydrateStats()
            // after the list paints. Initial render shows zeros so visitors
            // see the layout immediately.
            const stats = this._statsCache.get(t.id) || { playersOnline: 0, serversLive: 0, sessions24h: 0 };
            const statsHtml = `
                <span class="dx-card-stats" data-dexhero-stats="${escapeHTML(t.id)}" style="display:flex;gap:10px;font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-3);margin-top:4px;">
                    <span><span data-stat="players" style="color:var(--ink-1);font-variant-numeric:tabular-nums;">${stats.playersOnline}</span> playing now</span>
                    <span style="color:var(--ink-4,var(--ink-3));">·</span>
                    <span><span data-stat="servers" style="color:var(--ink-1);font-variant-numeric:tabular-nums;">${stats.serversLive}</span> servers live</span>
                    <span style="color:var(--ink-4,var(--ink-3));">·</span>
                    <span><span data-stat="sessions" style="color:var(--ink-1);font-variant-numeric:tabular-nums;">${stats.sessions24h}</span> sessions / 24h</span>
                </span>`;

            return `
                <a class="panel-row" href="#/token/${encodeURIComponent(addr)}" style="--row-cols: 56px 1fr auto;">
                    <span style="width:56px;height:56px;border-radius:4px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        ${img ? `<img src="${sanitizeURL(img)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-size:18px;font-weight:700;color:var(--ink-2);">${escapeHTML((t.name || '?').charAt(0).toUpperCase())}</span>`}
                    </span>
                    <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
                        <span style="color:var(--ink-0);font-family:var(--font-display);font-weight:600;font-size:14px;letter-spacing:0.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(t.name || 'Untitled')}</span>
                        <span style="color:var(--ink-3);font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(t.symbol || '')}${t.chain ? ' · ' + escapeHTML(t.chain) : ''}</span>
                        ${statsHtml}
                    </span>
                    <span style="text-align:right;">
                        <span style="color:var(--ink-3);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;">${priceLabel}</span><br>
                        <span style="color:var(--ink-0);font-size:14px;font-variant-numeric:tabular-nums;">$${fmtNum(price, { compact: false, decimals: 2 })}</span>
                    </span>
                </a>`;
        });
    }

    _gameRows() {
        if (!this.games) return null;
        const q = this.search;
        const list = q
            ? this.games.filter((g) => {
                // For Steam entries the title is initially "App <N>", so
                // also match on cached meta name + appid.
                const cachedName = g.source === 'steam'
                    ? (this._appMetaCache.get(g.appid)?.name || '')
                    : '';
                return (g.title || '').toLowerCase().includes(q)
                    || cachedName.toLowerCase().includes(q)
                    || (g.slug || '').toLowerCase().includes(q);
            })
            : this.games;
        return list.map((g) => {
            const isSteam = g.source === 'steam';
            const meta    = isSteam ? this._appMetaCache.get(g.appid) : null;
            const title   = isSteam ? (meta?.name || `App ${g.appid}`) : (g.title || 'Untitled');
            const icon    = isSteam ? meta?.header_image : g.icon_url;
            // Subline. For Steam we keep the "STEAM · " prefix and replace
            // the appid number with hours played + friends online (the
            // appid wasn't useful info for a player browsing their library;
            // hours played + friend activity is the signal that drives
            // "what do I want to play next"). For native games we keep the
            // slug.
            let slug;
            if (isSteam) {
                const hrs = g.playtimeMinutes != null
                    ? Math.round((g.playtimeMinutes / 60) * 10) / 10
                    : null;
                const playedLabel = hrs == null     ? null
                                  : hrs >= 1        ? `${hrs}H PLAYED`
                                  : g.playtimeMinutes > 0 ? `${g.playtimeMinutes}M PLAYED`
                                  : 'NEVER PLAYED';
                const friends = Number(g.friendsOnline || 0);
                const friendsLabel = friends > 0
                    ? `${friends} FRIEND${friends === 1 ? '' : 'S'} ONLINE`
                    : null;
                const bits = [playedLabel, friendsLabel].filter(Boolean);
                slug = `STEAM · ${bits.length ? bits.join(' · ') : 'LIBRARY'}`;
            } else {
                slug = `/${g.slug || ''}`;
            }
            const href    = isSteam ? `#/game/${g.appid}` : `#/game/${encodeURIComponent(g.id)}`;
            const right   = isSteam
                ? `<span style="text-align:right;color:var(--ink-3);font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;">${g.hostsAvailable > 0 ? 'Servers' : 'Offline'}<br><span style="color:${g.hostsAvailable > 0 ? 'var(--acc-cyan,#22d3ee)' : 'var(--ink-2)'};font-size:13px;font-variant-numeric:tabular-nums;">${fmtNum(g.hostsAvailable || 0)}</span></span>`
                : `<span style="text-align:right;color:var(--ink-3);font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;">DexHeros<br><span style="color:var(--ink-1);font-size:13px;font-variant-numeric:tabular-nums;">${fmtNum(g.dexheros_count || 0)}</span></span>`;
            const metaAttr = isSteam ? ` data-app-meta="${g.appid}"` : '';
            // Steam capsule is 460×215 (~2.14:1); render at 140×65 to match
            // the original Steam-tab look. Native games keep the compact
            // 44×44 icon since their assets aren't capsules.
            const iconW = isSteam ? 140 : 44;
            const iconH = isSteam ? 65  : 44;
            return `
                <a class="panel-row"${metaAttr} href="${href}" style="--row-cols: ${iconW}px 1fr auto;">
                    <span style="width:${iconW}px;height:${iconH}px;border-radius:4px;overflow:hidden;background:var(--surf-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        ${icon
                            ? `<img src="${sanitizeURL(icon)}" alt="" style="width:100%;height:100%;object-fit:cover;">`
                            : `<span style="font-size:16px;font-weight:700;color:var(--ink-2);">${escapeHTML((title || '?').charAt(0).toUpperCase())}</span>`}
                    </span>
                    <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
                        <span style="color:var(--ink-0);font-family:var(--font-display);font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(title)}</span>
                        <span style="color:${isSteam ? '#66c0f4' : 'var(--ink-3)'};font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;">${escapeHTML(slug)}</span>
                    </span>
                    ${right}
                </a>`;
        });
    }
}

/* CSS.escape() polyfill — safe attribute selector for UUIDs that might
   contain a hyphen (already valid) or, for legacy IDs, an unusual char.
   Native CSS.escape exists in all modern browsers; this is a fallback. */
function cssEsc(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

