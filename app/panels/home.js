/* Home panel — the default lobby view.
   Does NOT slide in. Instead it writes content into the persistent wings
   (Left = identity, Right = game slider) and leaves the stage in idle carousel mode. */

import { Panel, fmtAddress } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { getRecentTokens } from '../services/session.js';
import { on, E } from '../events.js';
import { setIdle } from '../stage.js';
import { buildDnaFeedRail } from '../ui/dna-feed-rail.js';

export default class HomePanel extends Panel {
    static id        = 'home';
    static variant   = 'codex'; // non-obtrusive variant; but we render into wings instead
    static width     = 0;
    static title     = 'Lobby';
    static stageMode = 'idle';

    constructor(params) {
        super(params);
        this._unsubs = [];
        this._steamLink     = null;     // null = unknown, { linked, persona_name, … } once fetched
        this._steamLibrary  = null;     // null while loading; [] when fetched but empty
        this._appMetaCache  = new Map(); // appid → { name, header_image }
        this._liveStats     = null;
        this._statsTimer    = null;
        // Game slider state (right wing, replaces the old quick-action grid).
        // Signed-out → featured games. Signed-in → games linked to the
        // currently-centered DexHero from the stage carousel.
        this._currentHero    = null;
        this._sliderRequest  = 0;   // serial to ignore stale fetches
        this._sliderObservers = []; // IntersectionObservers to disconnect on refresh
        this._lastSliderKey  = null;// hero id last rendered, skip duplicate refreshes
        this._sliderGamesByKey = new Map(); // key → games[], paint instantly on wing rewrite
        this._steamMetaCache = new Map(); // appid → meta, shared across re-renders
    }

    /* Home is special: we don't want a side-panel chrome. We write wings + keep stage.
       So we override mount() to skip the base behavior. */
    async mount(host) {
        this.host = host;
        setIdle();

        // Watchdog: if the lobby stage ever flips to context mode while
        // the home panel is mounted (which would hide arrows, chat,
        // bubble, and annotations all at once), pull it back to idle.
        // Defends against stale setContext calls from closing-panel race
        // conditions — a context-stuck stage is the visible symptom of
        // "the lobby loses everything but the model + name".
        const stageEl = document.getElementById('lobby-stage');
        if (stageEl) {
            this._stageModeWatcher = new MutationObserver(() => {
                if (stageEl.getAttribute('data-stage-mode') === 'context') {
                    console.warn('[home] stage went into context mode while lobby is mounted; restoring idle');
                    setIdle();
                }
            });
            this._stageModeWatcher.observe(stageEl, {
                attributes: true,
                attributeFilter: ['data-stage-mode'],
            });
        }
        this._paintWings();
        // Wallet swap repaints the wing (recents list depends on it),
        // which clobbers the slider's DOM. Clear the dedupe key + kick
        // off a slider refresh so the cards repaint without a flicker.
        this._unsubs.push(on(E.WALLET_CHANGED, () => {
            this._lastSliderKey = null;
            this._paintWings();
            this._refreshGameSlider();
        }));
        // Stage carousel drives the slider's game list. Each time the
        // centered hero changes, refetch that hero's linked games. The
        // stage always emits STAGE_SUBJECT once items load, so there's
        // no need to eagerly refresh from mount() — doing so would
        // double-paint (once with no hero, once with the centered hero)
        // and flash the slider during cold start.
        this._unsubs.push(on(E.STAGE_SUBJECT, (hero) => {
            this._currentHero = hero;
            this._refreshGameSlider();
        }));
        // Safety fallback: if the stage never emits STAGE_SUBJECT (e.g.
        // the platform has zero featured heroes), force one refresh so
        // the slider still paints from cached/mock data. The dedupe in
        // `_refreshGameSlider` skips this call if STAGE_SUBJECT already
        // fired first.
        setTimeout(() => {
            if (!this._lastSliderKey) this._refreshGameSlider();
        }, 600);
    }

    close() {
        for (const u of this._unsubs) try { u(); } catch {}
        this._unsubs = [];
        if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
        if (this._stageModeWatcher) { try { this._stageModeWatcher.disconnect(); } catch {} this._stageModeWatcher = null; }
        for (const o of this._sliderObservers) { try { o.disconnect(); } catch {} }
        this._sliderObservers = [];
        this._clearWings();
        // Call external close listeners
        for (const cb of this._onCloseExternal) try { cb(); } catch {}
    }

    async _loadDynamic() {
        // Always fetch live stats; library only when wallet is connected.
        try {
            const statsRes = await fetch('/api/stats/live').then((r) => r.json()).catch(() => null);
            this._liveStats = statsRes;
        } catch {}

        const s = wallet.getStatus();
        if (s.connected) {
            try {
                const [meRes, libRes] = await Promise.all([
                    fetch(`/api/steam/me?wallet=${encodeURIComponent(s.address)}`).then((r) => r.json()).catch(() => ({ linked: false })),
                    fetch(`/api/cloud/your-library?wallet=${encodeURIComponent(s.address)}`).then((r) => r.json()).catch(() => ({ games: [] })),
                ]);
                this._steamLink = meRes;
                this._steamLibrary = libRes.games || [];
                // Lazy-hydrate the top 8 visible cards with Steam metadata.
                this._hydrateAppMeta(this._steamLibrary.slice(0, 8));
            } catch {
                this._steamLink = { linked: false };
                this._steamLibrary = [];
            }
        }
        this._paintWings();
    }

    async _hydrateAppMeta(items) {
        await Promise.all(items.map(async (it) => {
            if (this._appMetaCache.has(it.appid)) return;
            try {
                const meta = await fetch(`/api/steam/app-meta?appid=${it.appid}`).then((r) => r.json());
                if (meta && meta.name) this._appMetaCache.set(it.appid, meta);
            } catch {}
        }));
        this._paintWings();
    }

    async _refreshLiveStats() {
        try {
            const r = await fetch('/api/stats/live').then((r) => r.json()).catch(() => null);
            if (r) {
                this._liveStats = r;
                // Light update — repaint just the right wing without full reflow.
                const right = document.getElementById('lobby-wing-right');
                if (right) right.innerHTML = this._rightHTML(wallet.getStatus());
                if (right) this._wireRightWing(right);
            }
        } catch {}
    }

    _paintWings() {
        const left  = document.getElementById('lobby-wing-left');
        const right = document.getElementById('lobby-wing-right');
        if (!left || !right) return;

        const s = wallet.getStatus();
        left.innerHTML = this._leftHTML(s);
        right.innerHTML = this._rightHTML(s);

        // Wire [data-go] CTAs across both wings (left "Create DexHero" button + any future right CTAs).
        [left, right].forEach((wing) => wing.querySelectorAll('[data-go]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                location.hash = el.getAttribute('data-go');
            });
        }));

        this._wireRightWing(right);

        // Left wing: copy address click
        const addrEl = left.querySelector('[data-copy-addr]');
        if (addrEl) {
            addrEl.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(addrEl.getAttribute('data-copy-addr'));
                    addrEl.textContent = 'COPIED';
                    setTimeout(() => this._paintWings(), 1200);
                } catch {}
            });
        }
    }

    _wireRightWing(right) {
        // Mount the DNA social feed rail into the new "feed" pane. The pane
        // is hidden by default; the right-arrow toggle in stage.js activates
        // it when the wing opens (previously activated Activity). Disposed
        // on next paint so we don't leak listeners.
        const feedMount = right.querySelector('[data-wing-feed]');
        if (feedMount && !feedMount.firstChild) {
            try {
                const rail = buildDnaFeedRail({ limit: 40 });
                feedMount.appendChild(rail);
                this._wingFeedRailDispose = () => { try { rail._dispose?.(); } catch {} };
            } catch (err) {
                console.warn('[home] DNA feed rail mount failed', err);
            }
        }

        // Tab strip — single delegated handler. Active class toggles, the
        // matching [data-tab-panel] becomes visible, the sliding indicator
        // animates to the active tab's bounding box.
        const tabsEl  = right.querySelector('[data-slider-tabs]');
        const updateIndicator = () => {
            if (!tabsEl) return;
            const active = tabsEl.querySelector('.home-game-slider__tab.is-active');
            const indicator = tabsEl.querySelector('[data-slider-tab-indicator]');
            if (!active || !indicator) return;
            const tabsBox  = tabsEl.getBoundingClientRect();
            const activeBox = active.getBoundingClientRect();
            indicator.style.setProperty('--tab-indicator-left',  `${activeBox.left - tabsBox.left}px`);
            indicator.style.setProperty('--tab-indicator-width', `${activeBox.width}px`);
        };
        // The right-wing tab strip is hidden via CSS — the bubble
        // titles strip in index.html is the source of truth for
        // body[data-active-pane] now (managed by stage-chat.js).
        // Click + sync handlers from the old tab strip are removed
        // to avoid stomping on that state on every paint.

        // Game card click → navigate to /#/game/<id> (the game detail page,
        // which shows the user's compatible DexHero roster + community roster).
        right.querySelectorAll('[data-game-id]').forEach((card) => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                location.hash = `#/game/${encodeURIComponent(card.getAttribute('data-game-id'))}`;
            });
        });
        // Steam-library card click → /#/game/<appid>
        right.querySelectorAll('[data-appid]').forEach((card) => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                if (card.getAttribute('aria-disabled') === 'true') return;
                location.hash = `#/game/${card.getAttribute('data-appid')}`;
            });
        });
        // "Sign in through Steam" CTA — POST to /api/steam/auth/begin?wallet=…
        right.querySelector('[data-steam-link]')?.addEventListener('click', (e) => {
            e.preventDefault();
            const s = wallet.getStatus();
            if (!s.connected) {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                return;
            }
            window.location.href = `/api/steam/auth/begin?wallet=${encodeURIComponent(s.address)}`;
        });
    }

    _clearWings() {
        const left  = document.getElementById('lobby-wing-left');
        const right = document.getElementById('lobby-wing-right');
        if (left) left.innerHTML = '';
        if (right) right.innerHTML = '';
    }

    _leftHTML(s) {
        // Title stays constant regardless of wallet state — this is the brand
        // line, not a status readout. Connection status belongs to the wallet
        // chip in the top nav (and the status dot in the bottom bar), not here.
        // The slot picker container is part of the wing flow so it inherits
        // the wing's align-items: flex-end on desktop (right-aligned with
        // the Create button) AND the centered stack on mobile (existing
        // media queries set the wing to align-items: center). Stage.js
        // paints into it via document.getElementById on every _paintCurrent.
        return `
            <div class="hud-display" style="font-size:clamp(28px, 3.4vw, 44px);">THE<br>PLAYABLE<br>INTERNET</div>
            <div class="hud-mono" style="max-width:320px;color:var(--ink-2);line-height:1.7;letter-spacing:0.06em;text-transform:none;font-size:13px;">
                Your playable AI companion, Designed by you, Engineered by experiencing life with you.
            </div>
            <button class="hud-btn hud-btn--primary hud-btn--lg" data-go="#/create">Create DexHero</button>
            <div class="lobby-stage__slots" id="lobby-stage-slots" role="tablist" aria-label="Character slots"></div>
        `;
    }

    _rightHTML(s) {
        const recents = s.connected ? getRecentTokens(s.address) : [];

        // ── Library block ────────────────────────────────────────────
        let libraryBlock;
        if (!s.connected) {
            libraryBlock = `
                <div class="hud-label" style="margin-bottom:8px;">Your library</div>
                <div class="hud-muted" style="font-size:11px;letter-spacing:0.12em;line-height:1.7;margin-bottom:14px;">
                    Connect a wallet to see your Steam games on Project WarpStream.
                </div>`;
        } else if (this._steamLink === null) {
            libraryBlock = `
                <div class="hud-label" style="margin-bottom:8px;">Your library</div>
                <div class="hud-muted" style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;">Loading…</div>`;
        } else if (!this._steamLink.linked) {
            libraryBlock = `
                <div class="hud-label" style="margin-bottom:8px;">Your library</div>
                <div class="hud-muted" style="font-size:12px;line-height:1.7;margin-bottom:12px;">
                    Sign in through Steam to see your games. We'll match you with a server that has each game installed.
                </div>
                <button class="hud-btn hud-btn--primary hud-btn--block" data-steam-link style="display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;font-size:13px;">
                    <span style="font-size:16px;">↗</span> Sign in through Steam
                </button>`;
        } else if (!this._steamLibrary || this._steamLibrary.length === 0) {
            libraryBlock = `
                <div class="hud-label" style="margin-bottom:8px;">Your library</div>
                <div class="hud-muted" style="font-size:11px;line-height:1.6;">
                    ${this._steamLink.persona_name ? escape(this._steamLink.persona_name) + ' · ' : ''}your library is empty or your Steam profile is set to private. <a href="https://steamcommunity.com/my/edit/settings" target="_blank" style="color:#8ab6ff;">Make it public →</a>
                </div>`;
        } else {
            libraryBlock = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span class="hud-label">Your library${this._steamLink.persona_name ? ` · ${escape(this._steamLink.persona_name)}` : ''}</span>
                    <span class="hud-label" style="font-size:9px;color:var(--ink-3);">${this._steamLibrary.length} games</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;max-height:50vh;overflow-y:auto;">
                    ${this._steamLibrary.slice(0, 12).map((it) => {
                        const meta = this._appMetaCache.get(it.appid);
                        const name = meta?.name || `App ${it.appid}`;
                        const icon = meta?.header_image
                            ? `<img src="${escape(meta.header_image)}" alt="" style="width:64px;height:30px;border-radius:3px;object-fit:cover;flex-shrink:0;background:var(--surf-2);">`
                            : `<div style="width:64px;height:30px;border-radius:3px;background:var(--surf-2);flex-shrink:0;"></div>`;
                        const playable = it.hostsAvailable > 0;
                        const playLabel = playable
                            ? `<span style="color:var(--acc-cyan,#22d3ee);font-size:11px;letter-spacing:0.14em;flex-shrink:0;">▶ PLAY</span>`
                            : `<span style="color:var(--ink-3);font-size:10px;letter-spacing:0.1em;flex-shrink:0;">No servers</span>`;
                        return `
                            <a class="hud-btn hud-btn--ghost" data-appid="${it.appid}"
                               aria-disabled="${playable ? 'false' : 'true'}"
                               href="${playable ? `#/game/${it.appid}` : 'javascript:void(0)'}"
                               style="display:flex;align-items:center;gap:10px;padding:6px 10px;text-decoration:none;justify-content:flex-start;${playable ? '' : 'opacity:0.45;cursor:not-allowed;'}">
                                ${icon}
                                <span style="flex:1;min-width:0;color:var(--ink-1);font-size:12px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escape(name)}</span>
                                ${playLabel}
                            </a>`;
                    }).join('')}
                </div>
                ${this._steamLibrary.length > 12 ? `<a class="hud-btn hud-btn--ghost hud-btn--sm" href="#/library" style="display:block;width:100%;text-align:center;margin-bottom:14px;">Show all ${this._steamLibrary.length} →</a>` : ''}`;
        }

        // ── Live counters ────────────────────────────────────────────
        const stats = this._liveStats;
        const statsBlock = stats ? `
            <div class="hud-label" style="font-size:10px;letter-spacing:0.14em;line-height:1.7;color:var(--ink-3);margin-bottom:18px;">
                <span style="color:var(--acc-ok,#22c55e);">●</span> ${fmtCount(stats.playersOnline)} playing now
                &nbsp;·&nbsp; ${fmtCount(stats.serversLive)} servers live
                &nbsp;·&nbsp; ${fmtCount(stats.sessions24h)} sessions / 24h
            </div>` : '';

        const recentsBlock = recents.length ? `
            <div class="hud-label" style="margin-top:18px;margin-bottom:8px;">Recent</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
                ${recents.slice(0, 3).map((t) => `
                    <button class="hud-btn hud-btn--ghost" data-go="#/token/${t.address}" style="justify-content:space-between;width:100%;padding:8px 12px;font-size:12px;">
                        <span style="color:var(--ink-1);">${escape(t.name || t.symbol || 'Token')}</span>
                        <span style="color:var(--ink-3);">→</span>
                    </button>`).join('')}
            </div>` : '';

        // Tab strip — currently one live tab ("Games") and several
        // "coming soon" placeholders. The sliding underline indicator
        // is positioned by JS via `--tab-indicator-left/width` custom
        // properties on the wrapper. Add new tabs by extending this
        // array + handling them in _setActiveTab.
        // Tabs are all model/session-related, IDE style. Chat Logs shows
        // the live conversation with the centered DexHero; History lists
        // every past session (one per DexHero you've chatted with) so
        // you can jump back in. Add new tabs by extending this array
        // and dropping a matching [data-tab-panel] panel below.
        const TABS = [
            { id: 'chatlog', label: 'Chat Log', live: true },
            { id: 'todo',    label: 'To-Do',   live: true },
            { id: 'topics',  label: 'Topics',  live: true },
        ];
        const tabsHTML = TABS.map((t) => `
            <button type="button"
                    class="home-game-slider__tab${t.id === 'chatlog' ? ' is-active' : ''}${t.live ? '' : ' is-disabled'}"
                    data-tab="${t.id}"
                    ${t.live ? '' : 'aria-disabled="true" title="Coming soon"'}>
                <span>${escape(t.label)}</span>
            </button>
        `).join('');

        return `
            <div class="home-game-slider" data-game-slider>
                <div class="home-game-slider__head">
                    <div class="home-game-slider__tabs" data-slider-tabs role="tablist">
                        ${tabsHTML}
                        <span class="home-game-slider__tab-indicator" data-slider-tab-indicator></span>
                    </div>
                </div>
                <!-- Legacy chatlog panel (stage-chat-log.js) removed —
                     the Activity panel below is the single chat surface
                     now. Keeping data-tab-panel="chatlog" out of the
                     DOM entirely so there's no stale tab target. -->

                <!-- DNA social feed — vertical card feed of community
                     upgrades, mounted via buildDnaFeedRail in _wireRightWing.
                     Used to live inside the /main DNA chart page; moved here
                     so the right-arrow + chat-bar surfaces share one place
                     to expose it. The .dna__feed-rail element is appended
                     INTO this .dna__feed wrapper at runtime — no inner
                     wrapper to avoid double-nesting the rail class. -->
                <div class="home-game-slider__panel home-game-slider__panel--chatlog" data-tab-panel="feed" hidden>
                    <div class="dna__feed" data-wing-feed></div>
                </div>

                <div class="home-game-slider__panel home-game-slider__panel--chatlog" data-tab-panel="topics" hidden>
                    <div class="chat-log" data-topics>
                        <div class="chat-log__head">
                            <span class="chat-log__head-title">Topics</span>
                            <span class="chat-log__head-sub" data-topics-count>0 open</span>
                        </div>
                        <button type="button" class="todo__hint" data-topics-trigger>
                            <span class="todo__hint-cmd">/addtopic</span>
                            <span class="todo__hint-arg">topic name</span>
                            <span class="todo__hint-plus" aria-hidden="true">+</span>
                        </button>
                        <div class="topics__list" data-topics-list></div>
                        <div class="chat-log__empty" data-topics-empty>
                            <div class="chat-log__empty-title">No topics yet.</div>
                            <div class="chat-log__empty-sub">Add a topic with <span class="todo__empty-cmd">/addtopic &lt;name&gt;</span>, then tag a <span class="todo__empty-cmd">/todo</span> with <span class="todo__empty-cmd">#name</span> to group it.</div>
                        </div>
                    </div>
                </div>
                <!-- Activity (chat log) pane moved out of the right
                     wing — it now lives in the floating chat overlay
                     (#lobby-chat-overlay in index.html) so the chat
                     log + chat input read as one movable surface.
                     The right wing now hosts only Feed / To-Do /
                     Topics. initRightWingActivity still wires the
                     data-activity-* elements wherever they end up. -->
                <div class="home-game-slider__panel home-game-slider__panel--chatlog" data-tab-panel="todo" hidden>
                    <div class="chat-log" data-todo>
                        <div class="chat-log__head">
                            <span class="chat-log__head-title">To-Do</span>
                            <span class="chat-log__head-sub" data-todo-count>0 open</span>
                        </div>
                        <!-- Click-to-prefill bar — focuses the main lobby chat
                             input below the model and seeds it with "/todo "
                             so the user learns the slash command. All actual
                             typing happens in the main bar. -->
                        <button type="button" class="todo__hint" data-todo-trigger>
                            <span class="todo__hint-cmd">/todo</span>
                            <span class="todo__hint-arg">your task here</span>
                            <span class="todo__hint-plus" aria-hidden="true">+</span>
                        </button>
                        <div class="todo__list" data-todo-list></div>
                        <div class="chat-log__empty" data-todo-empty>
                            <div class="chat-log__empty-title">No tasks yet.</div>
                            <div class="chat-log__empty-sub">Type <span class="todo__empty-cmd">/todo &lt;task&gt;</span> in the chat below — your list survives reloads.</div>
                        </div>
                    </div>
                </div>
            </div>
            ${recentsBlock}
        `;
    }

    /** Vertical-snap game-profile slider that replaces the old Quick
     *  Actions block. Signed out: top featured games. Signed in with a
     *  hero centered on the stage: that hero's linked games. Tapping a
     *  card opens the game detail page. Wraps invisibly at the end so
     *  the scroll feels endless. */
    async _refreshGameSlider() {
        const scroll  = document.querySelector('[data-slider-scroll]');
        const sepEl   = document.querySelector('[data-slider-sep]');
        const heroEl  = document.querySelector('[data-slider-hero]');
        const priceEl = document.querySelector('[data-slider-price]');
        if (!scroll) return;

        const hero = this._currentHero;
        const heroIsReal = hero && hero.id && hero.network !== 'create';

        // Skip duplicate renders — STAGE_SUBJECT can fire multiple times
        // with the same hero (initial mount, wallet swap, etc.). Without
        // this guard each repaint flashes the slider.
        const key = heroIsReal ? `hero:${hero.id}` : 'featured';
        if (key === this._lastSliderKey && scroll.children.length > 0
            && !scroll.querySelector('.home-game-slider__placeholder')) {
            return;
        }

        // Title is permanently "Included Games"; only the hero suffix
        // streams in once we know the centered hero. No "Featured
        // Games" path — the header text never changes.
        if (heroIsReal) {
            const heroName = (hero.name || 'DexHero').toUpperCase();
            if (heroEl) heroEl.textContent = heroName;
            if (sepEl)  sepEl.hidden = false;
            // Hero price (in USDC) sits to the right of the name. Hidden
            // when missing or zero so the title stays clean for heroes
            // without a configured price.
            const price = Number(hero.price || 0);
            if (priceEl) {
                if (price > 0) {
                    priceEl.textContent = `$${fmtPrice(price)}`;
                    priceEl.hidden = false;
                } else {
                    priceEl.textContent = '';
                    priceEl.hidden = true;
                }
            }
        } else {
            if (heroEl)  heroEl.textContent = '';
            if (sepEl)   sepEl.hidden = true;
            if (priceEl) { priceEl.textContent = ''; priceEl.hidden = true; }
        }

        // If we've already fetched this key in the session (e.g. wing
        // was rewritten by WALLET_CHANGED), paint cached games instantly
        // and skip the network round-trip. No "Loading…" flash.
        const cachedGames = this._sliderGamesByKey.get(key);
        if (cachedGames) {
            scroll.innerHTML = cachedGames.map((g) => this._renderGameCard(g)).join('');
            this._wireGameCards(scroll);
            this._lastSliderKey = key;
            return;
        }

        // Stale-fetch guard. Re-centering a hero on the stage between
        // requests would otherwise let the older one paint last.
        const reqId = ++this._sliderRequest;
        // Only show the placeholder on a true first paint — otherwise we
        // keep the previous cards visible while the new fetch lands.
        const firstPaint = !scroll.children.length
            || !!scroll.querySelector('.home-game-slider__placeholder');
        if (firstPaint) {
            scroll.innerHTML = `<div class="home-game-slider__placeholder">Loading games…</div>`;
        }

        let games = [];
        try {
            const url = heroIsReal
                ? `/api/game/tokens/linked?tokenId=${encodeURIComponent(hero.id)}`
                : '/api/cloud/featured-games';
            const r = await fetch(url);
            const j = await r.json();
            games = j.games || [];
        } catch (err) {
            console.warn('[home-slider] games fetch failed:', err.message);
            if (reqId !== this._sliderRequest) return;
            scroll.innerHTML = `<div class="home-game-slider__placeholder">Couldn't load games</div>`;
            return;
        }
        if (reqId !== this._sliderRequest) return;

        // TEMP (dev-only): seed mock games on localhost so the slider has
        // something to render against until the DB has active games.
        // Remove this block when real games are seeded.
        if (!games.length && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
            games = MOCK_GAMES;
        }

        if (!games.length) {
            scroll.innerHTML = `<div class="home-game-slider__placeholder">${
                heroIsReal
                    ? "This DexHero isn't connected to any games yet"
                    : "No featured games yet"
            }</div>`;
            this._lastSliderKey = key;
            return;
        }

        scroll.innerHTML = games.map((g) => this._renderGameCard(g)).join('');
        this._wireGameCards(scroll);
        // Wraparound clone was causing a visible flash mid-scroll.
        // The "next card peeks below" affordance is enough to signal
        // scrollability; loop back to top can be revisited later.
        this._sliderGamesByKey.set(key, games);
        this._lastSliderKey = key;
    }

    _renderGameCard(g) {
        const status = (g.status || 'active').toLowerCase();
        const led = status === 'active' ? 'ok' : status === 'blocked' ? 'warn' : 'standby';
        const statusLabel = status === 'active' ? 'LIVE' : status === 'blocked' ? 'BLOCKED' : 'PENDING';
        // Eyebrow now shows live player count instead of static tier —
        // e.g. "32K · LIVE". Falls back to "—" when no player data.
        const playerCount = Number(g.players || 0);
        const playerLabel = playerCount > 0 ? fmtCount(playerCount).toUpperCase() : '—';
        const img = g.icon_url
            ? `<img class="home-game-slider__hero-img" src="${escape(g.icon_url)}" alt="" loading="lazy">`
            : `<div class="home-game-slider__hero-img home-game-slider__hero-img--ph">${escape((g.title || '?').charAt(0).toUpperCase())}</div>`;
        return `
            <article class="home-game-slider__card" data-game-id="${escape(g.id)}">
                <div class="home-game-slider__hero">
                    ${img}
                    <video class="home-game-slider__hero-video" data-card-video
                           muted loop playsinline preload="none"></video>
                    <div class="home-game-slider__hero-scrim"></div>
                    <div class="home-game-slider__hero-overlay">
                        <h3 class="home-game-slider__name">${escape(g.title || 'Untitled game')}</h3>
                        <div class="home-game-slider__byline" data-card-byline></div>
                    </div>
                    <span class="hpd-eyebrow home-game-slider__live">
                        <span class="hpd-eyebrow__led hpd-eyebrow__led--${led}"></span>
                        ${escape(playerLabel)} · ${escape(statusLabel)}
                    </span>
                </div>
                <div class="home-game-slider__body">
                    <div class="home-game-slider__shots" data-card-shots></div>
                </div>
            </article>`;
    }

    /** For Steam-appid games (numeric id), pull screenshots, description,
     *  and developer credits from `/api/steam/app-meta` and inject them
     *  into the card. Results are cached per appid for the session. */
    _hydrateSteamCard(card, appid) {
        const cached = this._steamMetaCache.get(appid);
        const apply = (meta) => {
            if (!meta) return;
            const bylineEl = card.querySelector('[data-card-byline]');
            const shotsEl  = card.querySelector('[data-card-shots]');
            const videoEl  = card.querySelector('[data-card-video]');

            if (bylineEl && meta.developers?.length) {
                bylineEl.textContent = `by ${meta.developers.slice(0, 2).map(escape).join(', ')}`;
            }
            if (shotsEl && meta.screenshots?.length) {
                shotsEl.innerHTML = meta.screenshots.slice(0, 6).map((s) =>
                    `<div class="home-game-slider__shot"><img src="${escape(s.thumb)}" alt="" loading="lazy"></div>`
                ).join('');
            }
            // Steam returns at most one trailer in meta.movies (we slice
            // server-side). Prefer webm (smaller + faster) on Chromium
            // and Firefox; mp4 is the only path on Safari. Both 480p so
            // the hover-preview stays bandwidth-light.
            const movie = meta.movies?.[0];
            if (videoEl && movie && (movie.webm || movie.mp4)) {
                const src = movie.webm || movie.mp4;
                videoEl.dataset.src = src;
                if (movie.thumb) videoEl.poster = movie.thumb;
                videoEl.setAttribute('data-has-video', '1');
            }
            // Deliberately DO NOT swap the cover img. The initial cover
            // URL (set by the card's first render) already paints; the
            // Akamai header_image returned by Steam is functionally the
            // same asset on a different CDN. Swapping causes a visible
            // re-load flash with no real benefit.
        };
        if (cached) { apply(cached); return; }
        fetch(`/api/steam/app-meta?appid=${encodeURIComponent(appid)}`)
            .then((r) => r.json())
            .then((meta) => {
                if (!meta || meta.error) return;
                this._steamMetaCache.set(appid, meta);
                apply(meta);
            })
            .catch(() => {});
    }

    _wireGameCards(scroll) {
        scroll.querySelectorAll('[data-game-id]').forEach((card) => {
            const id = card.getAttribute('data-game-id');
            // Steam appids (numeric ids) get hydrated with screenshots
            // + developer credits from the Steam meta API.
            if (/^\d+$/.test(id)) this._hydrateSteamCard(card, id);

            // Hover: lazy-load + play trailer (if one was hydrated),
            // reveal screenshot strip below. mouseleave pauses + rewinds
            // so the next hover starts from t=0 and we don't burn CPU
            // playing offscreen cards. preload="none" + src-on-demand
            // keeps initial card render fast and bandwidth low.
            const videoEl = card.querySelector('[data-card-video]');
            if (videoEl) {
                card.addEventListener('pointerenter', () => {
                    if (!videoEl.getAttribute('data-has-video')) return;
                    if (!videoEl.src && videoEl.dataset.src) videoEl.src = videoEl.dataset.src;
                    videoEl.play().catch(() => {});
                });
                card.addEventListener('pointerleave', () => {
                    try { videoEl.pause(); videoEl.currentTime = 0; } catch {}
                });
            }

            // Translate vertical wheel into horizontal scroll on the
            // screenshots strip. Native wheel-over-horizontal-overflow
            // only scrolls horizontally if the user is holding shift on
            // most platforms — without this hook, scrolling the wheel
            // inside the strip would just scroll the page. Combined
            // with CSS `overscroll-behavior: contain` on the strip,
            // wheels stay local to the strip until it bottoms out.
            const shotsEl = card.querySelector('[data-card-shots]');
            if (shotsEl) {
                shotsEl.addEventListener('wheel', (e) => {
                    if (e.deltaY === 0) return;
                    e.preventDefault();
                    shotsEl.scrollLeft += e.deltaY;
                }, { passive: false });
            }

            card.addEventListener('click', (e) => {
                // Screenshot thumbs intercept their own clicks (no-op).
                if (e.target.closest('.home-game-slider__shot')) return;
                location.hash = `#/game/${encodeURIComponent(id)}`;
            });
        });
    }

    /** Endless wraparound. When the last real card scrolls fully into
     *  view, append a clone of the first card; when the clone scrolls
     *  fully into view, jump-scroll back to the top (within one frame,
     *  under mandatory snap, the jump is invisible). */
    _initSnapWrap(scroll) {
        // Disconnect any observers from a previous refresh.
        for (const o of this._sliderObservers) { try { o.disconnect(); } catch {} }
        this._sliderObservers = [];

        const cards = scroll.querySelectorAll('.home-game-slider__card:not(.home-game-slider__card--cloned)');
        if (cards.length < 2) return;

        const last = cards[cards.length - 1];
        let clone = null;

        const cloneObserver = new IntersectionObserver((entries) => {
            for (const ent of entries) {
                if (ent.isIntersecting) {
                    cloneObserver.disconnect();
                    scroll.scrollTop = 0;
                    if (clone) { clone.remove(); clone = null; }
                }
            }
        }, { root: scroll, threshold: 0.95 });

        const lastObserver = new IntersectionObserver((entries) => {
            for (const ent of entries) {
                if (ent.isIntersecting && !clone) {
                    clone = cards[0].cloneNode(true);
                    clone.classList.add('home-game-slider__card--cloned');
                    clone.addEventListener('click', () => {
                        location.hash = `#/game/${encodeURIComponent(clone.getAttribute('data-game-id'))}`;
                    });
                    scroll.appendChild(clone);
                    cloneObserver.observe(clone);
                }
            }
        }, { root: scroll, threshold: 0.95 });

        lastObserver.observe(last);
        this._sliderObservers.push(lastObserver, cloneObserver);
    }
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}

function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

function fmtPrice(n) {
    n = Number(n) || 0;
    if (n >= 1)    return n.toFixed(2);
    if (n >= 0.01) return n.toFixed(2);
    if (n > 0)     return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return '0';
}

// TEMP (dev-only): mock games used to preview the right-wing slider
// when the local DB has no active `registered_games`. IDs are real
// Steam appids — `_renderGameCard` then hydrates each card via
// `/api/steam/app-meta` so the preview pulls real Steam screenshots,
// description, and developer credits. Clicking a card opens the live
// Steam game-detail page at `/#/game/<appid>`.
const MOCK_GAMES = [
    { id: '730',     title: 'Counter-Strike 2', icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg',     tier: 'gold',   players: 1240000, dexheros: 42, price_label: 'Free' },
    { id: '570',     title: 'Dota 2',           icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/header.jpg',     tier: 'gold',   players: 620000,  dexheros: 28, price_label: 'Free' },
    { id: '252950',  title: 'Rocket League',    icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/header.jpg',  tier: 'silver', players: 92000,   dexheros: 17, price_label: 'Free' },
    { id: '1172470', title: 'Apex Legends',     icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/header.jpg', tier: 'silver', players: 184000,  dexheros: 23, price_label: 'Free' },
    { id: '440',     title: 'Team Fortress 2',  icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg',     tier: 'bronze', players: 58000,   dexheros: 9,  price_label: 'Free' },
    { id: '620',     title: 'Portal 2',         icon_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg',     tier: 'steam',  players: 12400,   dexheros: 6,  price_label: '$9.99' },
];
