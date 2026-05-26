/* Token-detail panel — native Sovereign Lobby inspect + trade view.
   Renders identity + live price, a candlestick chart (lightweight-charts),
   timeframe selector, buy/sell widget, and a compact metadata strip — all
   at a sensible 640px panel width. No iframe.

   Underlying data + trade paths still go through the existing globals:
     - window.DexHeroBlockchain.getTradeHistory  → OHLCV feed
     - window.DexHeroBlockchain.buyWithUSDC      → V2 buy
     - window.DexHeroBlockchain.buyToken         → V1 fallback buy
     - window.DexHeroBlockchain.sellToken        → sell
     - window.DexHeroBlockchain.signer           → signature path
     - Supabase models / tokens tables           → token metadata
*/

import { Panel, escapeHTML, fmtNum, fmtAddress, sanitizeURL } from '../ui/panel.js';
// UX-Chart-1: GeckoTerminal-only chart wiring + pre-tipping MintProgress block.
// Currently this panel ALREADY renders the GeckoTerminal iframe on isMigrated
// tokens (post-tipping). The remaining gap is the pre-tipping new-launch path,
// which renders a native lightweight-charts candlestick from /api/trades. Per
// the audit (UX-Chart-1), pre-tipping new-launch DexHeros should show a
// MintProgress block instead — there is no DEX pool to chart against, so
// any chart is misleading.
//
// Data plumbing required to flip this on is a separate (non-audit) UX PR:
// the panel needs `tippingPointUSDC`, `mintPriceUSDC`, `totalRaisedUSDC`,
// `nftsMinted` on the token row. Once those land, replace the
// `<div class="td-chart" data-chart-host>` block (line ~167) with:
//
//     import { renderChartOrProgress } from '../ui/chart-or-progress.js';
//     ...
//     // post-tipping or existing-token: gecko embed
//     // pre-tipping new-launch: mint-progress block
//     renderChartOrProgress(host, this._chartState());
//
// where _chartState() returns the appropriate shape from app/ui/chart-or-progress.js.
import * as sb from '../services/supabase.js';
import * as wallet from '../services/wallet.js';
import { setContext, setIdle } from '../stage.js';
import { pushRecentToken } from '../services/session.js';
import { toast } from '../ui/toast.js';
import { on, E } from '../events.js';
import { renderChartOrProgress } from '../ui/chart-or-progress.js';

// Ensure the scoped stylesheet is loaded once on first import.
(function loadStyles() {
    if (document.querySelector('link[data-panel-css="token-detail"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/styles/panels/token-detail.css';
    l.setAttribute('data-panel-css', 'token-detail');
    document.head.appendChild(l);
})();

const TF = [
    { label: '5s',  res: 5      },
    { label: '1m',  res: 60     },
    { label: '5m',  res: 300    },
    { label: '15m', res: 900    },
    { label: '1h',  res: 3600   },
    { label: '4h',  res: 14400  },
    { label: '1D',  res: 86400  },
];

// Chain-slug maps for external chart providers. Matches the legacy
// token-detail.html conventions so pool URLs resolve identically.
const GECKO_CHAIN_MAP = {
    'solana': 'solana',
    'ethereum': 'eth',
    'sepolia': 'eth',
    'base': 'base',
    'base-sepolia': 'base',
    'bnb': 'bsc',
    'bsc': 'bsc',
    'monad': 'monad-testnet',
};
const DEXSCREENER_CHAIN_MAP = {
    'solana': 'solana',
    'ethereum': 'ethereum',
    'sepolia': 'ethereum',
    'base': 'base',
    'base-sepolia': 'base',
    'bnb': 'bsc',
    'bsc': 'bsc',
    'monad': 'monad',
};

export default class TokenDetailPanel extends Panel {
    static id        = 'token-detail';
    static variant   = 'right';
    static width     = 640;
    static title     = 'Inspect';
    static titleBreadcrumb = ['MARKET', 'INSPECT'];
    static stageMode = 'context';
    static parentHash = '#/market';

    constructor(params) {
        super(params);
        this.ident     = params.address;
        this.token     = null;
        this.loadState = 'loading';  // 'loading' | 'ready' | 'not-found' | 'error'
        this.errorMsg  = null;
        this.direction = 'buy';
        this.resolution = 60;        // default 1m
        this.chart      = null;
        this.candleSeries = null;
        this.chartData    = [];
        this._lastCandle  = null;    // most recent OHLC for instant append
        this._realtimeChannel = null;
        this._backstopTimer = null;
        this._resizeObs   = null;
        this.isMigrated   = false;   // tipped → routed to external DEX, show Gecko iframe
        this.linkedGames  = null;    // games this DexHero is approved to play in
        this.myGames      = null;    // games the connected wallet owns (for linking)
        this.linkPickerOpen = false; // toggle for the inline "pick a game" UI
        this.linking      = false;   // single-flight guard for the sign+link request
        this.tab          = ['inspect', 'games'].includes(params.tab) ? params.tab : 'inspect';

        // ── V3 state ────────────────────────────────────────────
        // Populated by _loadV3State() after _resolve. Stays null for V2 DexHeros
        // so the legacy code paths render unchanged.
        this.v3            = null;   // { tipping, genesis, buyout }
        this.v3Phase       = null;   // 'pre' | 'post' | 'buyout'
        this.mintQty       = 1;
        this.depositKind   = 'token'; // 'token' | 'usdc' — Buyout Vault deposit asset
        this.depositAmount = '';
        this.myDeposits    = null;   // { tokens, usdc } for connected wallet
        this.daoProposals  = [];     // post-buyout proposal cache
        this.daoState      = null;   // { treasuryTokens, treasuryUsdc, votingWeight, ... }
        this.metaFormOpen  = false;  // Genesis "Update Metadata" inline form
        this.proposeOpen   = false;  // DAO "Create Proposal" inline form
        this.mpFormOpen    = false;  // Genesis "Change mint price" inline form
        this.mpDraftUsd    = '';     // typed value in the new-price input
        this.mySbtBalance  = 0;      // current wallet's SBT count for this DexHero
        this.amGenesis     = false;  // current wallet owns the Genesis NFT
        this.mintInFlight  = false;  // re-entrancy guard for the header Mint button
    }

    render() {
        if (this.loadState === 'loading') {
            return `<div class="panel-state"><div class="hud-spin"></div><div>Loading token</div></div>`;
        }
        if (this.loadState === 'not-found') {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Not Found</div>
                    <div class="panel-state__body">This DexHero doesn't exist or hasn't been indexed yet.<br><br><span style="font-family:var(--font-mono);font-size:11px;color:var(--ink-3);word-break:break-all;">${escapeHTML(this.ident || '')}</span></div>
                    <a class="hud-btn hud-btn--primary" href="#/market">Browse Market</a>
                </div>`;
        }
        if (this.loadState === 'error') {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Error</div>
                    <div class="panel-state__body">${escapeHTML(this.errorMsg || 'Unknown error')}</div>
                    <button class="hud-btn" data-retry>Retry</button>
                </div>`;
        }
        return this._renderReady();
    }

    _renderReady() {
        const t = this.token;
        const price = _priceOf(t);
        const mintPrice = _mintPriceOf(t);
        const addr = t.manager_address || t.contract_address || '';
        const sym = (t.symbol || 'TOKEN').toUpperCase();
        const unit = this.direction === 'buy' ? 'USDC' : sym;

        return `
            <!-- Identity + price -->
            <div class="td-head">
                <div class="td-head__id">
                    <span class="td-head__name">${escapeHTML(t.name || '—')}</span>
                    <span class="td-head__sub">${escapeHTML(sym)}<span class="sep">·</span>${escapeHTML(t.chain || t.network || 'ethereum').toUpperCase()}</span>
                </div>
                <div class="td-head__price ${t.is_v3 ? 'td-head__price--v3' : ''}">
                    ${t.is_v3 ? this._renderV3HeadActions(mintPrice) : `
                        <span class="td-head__price-tag">Mint</span>
                        <span class="td-head__price-main">${mintPrice != null ? '$' + _fmtPrice(mintPrice) : '—'}</span>
                        <span class="td-head__price-now"><span class="td-head__price-now-tag">Now</span><span data-live-price>${price != null ? '$' + _fmtPrice(price) : '—'}</span></span>
                    `}
                </div>
            </div>

            <!-- Inspect / Games tabs live in the PANEL HEADER (replacing the
                 default "MARKET ▸ INSPECT" breadcrumb) for more model viewer
                 height. See _paintHeaderTabs() — it injects/refreshes the
                 tab buttons into .panel__title on every render. -->

            <div class="td-panes" data-panes>

            <div class="td-pane" id="td-pane-inspect" role="tabpanel" data-pane="inspect" ${this.tab === 'inspect' ? '' : 'hidden'}>

            <!-- DexHero model preview (above the chart so the character is the
                 first thing the user sees on this page, especially on mobile
                 where the panel covers the lobby stage). -->
            ${this._renderModelHtml(t)}

            <!-- Timeframes (V2 native only — V3 uses graduation bar pre-tipping
                 and GeckoTerminal post-tipping, neither needs timeframe control) -->
            ${!t.is_v3 ? `
                <div class="td-timeframes" role="tablist" aria-label="Chart timeframe">
                    ${TF.map((f) => `<button class="td-tf" data-res="${f.res}" aria-pressed="${f.res === this.resolution}">${f.label}</button>`).join('')}
                </div>
            ` : ''}

            <!-- Chart / graduation slot:
                 - V3 pre-tipping → custom graduation bar (count-only, no USD)
                 - V3 post-tipping → GeckoTerminal via chart-or-progress.js
                 - existing-token   → GeckoTerminal via chart-or-progress.js
                 - V2 native        → candle chart (Gecko if migrated) -->
            ${t.is_v3
                ? (this.v3Phase === 'pre'
                    ? this._renderGraduationBar()
                    : `<div class="td-chart" data-chart-host></div>`)
                : (t.launch_type === 'existing'
                    ? `<div class="td-chart" data-chart-host></div>`
                    : (this.isMigrated ? this._renderGeckoChart() : `
                <div class="td-chart" data-chart-host>
                    <div class="td-chart__spinner" data-chart-spinner><div class="hud-spin"></div><div>Loading market data</div></div>
                    <div class="td-chart__ohlcv" data-chart-ohlcv>
                        <span>O<b class="o">—</b></span>
                        <span class="h">H<b>—</b></span>
                        <span class="l">L<b>—</b></span>
                        <span>C<b class="c">—</b></span>
                    </div>
                </div>`))}

            <!-- Trade widget — V2 only. V3 uses the inline header Mint button
                 and the DAO TakeOver section below; no V2 trade flow for V3. -->
            ${!t.is_v3 ? `
                <div class="td-trade">
                    <div class="td-trade__toggle">
                        <button class="td-trade__dir" data-dir="buy"  aria-pressed="${this.direction === 'buy'}">Buy</button>
                        <button class="td-trade__dir" data-dir="sell" aria-pressed="${this.direction === 'sell'}">Sell</button>
                    </div>
                    <div class="td-trade__input">
                        <input type="number" min="0" step="any" placeholder="0.00" data-amount inputmode="decimal">
                        <span class="unit">${escapeHTML(unit)}</span>
                    </div>
                    <div class="td-trade__quotes">
                        <span class="label" data-quote-label>You receive</span>
                        <span class="val accent" data-quote-val>≈ 0.00 ${escapeHTML(this.direction === 'buy' ? sym : 'USDC')}</span>
                    </div>
                    <div class="td-trade__quick">
                        ${this._quickAmountBtns()}
                    </div>
                    <button class="td-trade__submit ${this.direction}" data-submit>
                        ${wallet.isConnected() ? (this.direction === 'buy' ? 'Buy' : 'Sell') : 'Connect Wallet'}
                    </button>
                </div>
            ` : ''}

            <!-- Character stats strip — focused on usage & access, not
                 on-chain supply/contract metadata. Supply + Contract were
                 removed as web3 noise; what's left reads as a character
                 profile: how many players, which games, rental pricing,
                 popularity, creator credit. -->
            <div class="td-meta">
                ${t.market_cap ? _metaCell('Popularity', '$' + fmtNum(t.market_cap)) : ''}
                ${t.players_count != null ? _metaCell('Players', fmtNum(t.players_count)) : ''}
                ${t.games_count != null ? _metaCell('Games', fmtNum(t.games_count)) : ''}
                ${t.rental_price ? _metaCell('Rental', '$' + fmtNum(t.rental_price, { compact: false, decimals: 2 })) : ''}
                ${t.creator_wallet && t.creator_wallet !== 'Unknown' ? _metaCell('Creator', fmtAddress(t.creator_wallet)) : ''}
            </div>

            ${t.is_v3 ? `
                ${this._renderMintPriceBlock()}
                ${this._renderOwnerControlsBlock()}
                ${this.v3Phase !== 'pre' ? this._renderBuyoutVaultBlock() : ''}
                ${this.v3Phase === 'buyout' ? this._renderDAOBlock() : ''}
            ` : ''}

            </div><!-- /td-pane inspect -->

            <div class="td-pane" id="td-pane-games" role="tabpanel" data-pane="games" ${this.tab === 'games' ? '' : 'hidden'}>
                <div class="td-games-list" data-games-list>
                    <div class="panel-state"><div class="hud-spin"></div><div>Loading games</div></div>
                </div>
            </div>

            </div><!-- /td-panes -->
        `;
    }

    // Header right-side actions for V3:
    //   - Genesis NFT holder        → "Genesis" badge + price (they own the DexHero)
    //   - SBT holder (non-Genesis)  → "Soulbound" badge + price (they have access)
    //   - Anyone else               → "Mint" button + price (call to mint an SBT)
    // Order in the row stays the same: left action, right price stack.
    _renderV3HeadActions(mintPrice) {
        const priceLabel = mintPrice != null ? '$' + _fmtPrice(mintPrice) : '—';
        const priceStack = `
            <span class="td-head__price-stack">
                <span class="td-head__price-tag">Mint</span>
                <span class="td-head__price-main">${priceLabel}</span>
            </span>
        `;
        if (this.amGenesis) {
            // Genesis holder owns the DexHero — they don't need to be shown
            // a mint price; the only relevant header signal is ownership.
            return `
                <div class="td-head__badge td-head__badge--genesis" title="You own the Genesis NFT — owner controls available below">Genesis</div>
            `;
        }
        if (this.mySbtBalance > 0) {
            return `
                <div class="td-head__badge td-head__badge--sbt" title="You hold ${this.mySbtBalance} Access SBT${this.mySbtBalance === 1 ? '' : 's'} for this DexHero">Soulbound</div>
                ${priceStack}
            `;
        }
        const connected = wallet.isConnected();
        const inFlight  = !!this.mintInFlight;
        const disabled  = inFlight || !connected;
        const label     = inFlight ? 'Minting…' : 'Mint';
        const tip       = inFlight
            ? 'Mint in progress — confirm in wallet'
            : (connected ? 'Mint 1 Access SBT' : 'Connect wallet to mint');
        return `
            <button class="td-head__mint-btn" data-mint-submit ${disabled ? 'disabled' : ''} title="${tip}">${label}</button>
            ${priceStack}
        `;
    }

    _renderModelHtml(t) {
        if (t.model_url) {
            return `
                <div class="td-model">
                    <model-viewer
                        src="${sanitizeURL(t.model_url)}"
                        alt="${escapeHTML(t.name || 'DexHero')}"
                        auto-rotate
                        rotation-per-second="20deg"
                        camera-controls
                        interaction-prompt="none"
                        disable-tap
                        camera-orbit="0deg 90deg 110%"
                        exposure="0.95"
                        shadow-intensity="0.2"
                        autoplay
                        animation-name="walk_in_place"
                    ></model-viewer>
                    <button class="td-model-toggle" type="button" data-model-toggle data-state="playing" aria-label="Pause animation">
                        <svg class="td-model-toggle__pause" width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
                            <rect x="0" y="0" width="3" height="12" rx="0.6"/>
                            <rect x="7" y="0" width="3" height="12" rx="0.6"/>
                        </svg>
                        <svg class="td-model-toggle__play" width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
                            <path d="M1 0.6 L9 6 L1 11.4 Z"/>
                        </svg>
                    </button>
                </div>`;
        }
        const img = t.image_url || t.thumbnail_url;
        if (img) {
            return `
                <div class="td-model td-model--image">
                    <img src="${sanitizeURL(img)}" alt="${escapeHTML(t.name || '')}" loading="eager" decoding="async">
                </div>`;
        }
        return '';
    }

    /** Fetch the games this DexHero is approved to play in, then paint
        them into the Games tab. The endpoint is public — no wallet required
        for browsing the list. When a wallet is connected we also fetch the
        wallet's owned games so a developer can one-click link this DexHero
        to one of their games from this view. */
    async _loadLinkedGames() {
        const tokenId = this.token?.token_id || this.token?.id;
        if (!tokenId) { this.linkedGames = []; this._paintGamesList(); return; }
        try {
            const r = await fetch(`/api/game/tokens/linked?tokenId=${encodeURIComponent(tokenId)}`, { signal: this.signal });
            const j = await r.json().catch(() => null);
            this.linkedGames = (j && Array.isArray(j.games)) ? j.games : [];
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('[token-detail] linked games load failed:', err.message);
            this.linkedGames = [];
        }
        if (wallet.isConnected()) await this._loadMyGames();
        this._paintGamesList();
    }

    async _loadMyGames() {
        const addr = wallet.getStatus().address;
        if (!addr) { this.myGames = []; return; }
        try {
            const r = await fetch(`/api/game/my-games?wallet=${encodeURIComponent(addr)}`, { signal: this.signal });
            const j = await r.json().catch(() => null);
            this.myGames = (j && Array.isArray(j.games)) ? j.games : [];
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('[token-detail] my-games load failed:', err.message);
            this.myGames = [];
        }
    }

    _paintGamesList() {
        const host = this.root?.querySelector('[data-games-list]');
        if (!host) return;
        const games = this.linkedGames || [];
        const linkedIds = new Set(games.map((g) => g.id));
        const myGames = this.myGames || [];
        const linkable = myGames.filter((g) => !linkedIds.has(g.id));

        // Reflect the count on the tab pill so the user knows there are games
        // before they click into the tab.
        const pill = this.root?.querySelector('[data-tab="games"]');
        if (pill) pill.textContent = games.length ? `Games · ${games.length}` : 'Games';

        const ctaHtml = this._renderLinkCtaHtml(myGames, linkable);

        let listHtml;
        if (!games.length) {
            listHtml = `
                <div class="panel-state">
                    <div class="panel-state__title">No games yet</div>
                    <div class="panel-state__body">This DexHero hasn't been approved by any games yet.</div>
                </div>`;
        } else {
            listHtml = games.map((g) => {
                const tier = (g.tier || 'bronze').toLowerCase();
                const initial = (g.title || '?').charAt(0).toUpperCase();
                const icon = g.icon_url
                    ? `<img src="${sanitizeURL(g.icon_url)}" alt="" loading="lazy" decoding="async">`
                    : `<span class="td-game-row__initial">${escapeHTML(initial)}</span>`;
                const meta = [g.category, tier && tier.toUpperCase()].filter(Boolean).join(' · ');
                return `
                    <a class="td-game-row" href="#/play?game=${encodeURIComponent(g.id)}" data-tier="${escapeHTML(tier)}">
                        <span class="td-game-row__icon">${icon}</span>
                        <span class="td-game-row__body">
                            <span class="td-game-row__title">${escapeHTML(g.title || 'Untitled')}</span>
                            <span class="td-game-row__meta">${escapeHTML(meta || '')}</span>
                        </span>
                        <span class="td-game-row__cta">PLAY →</span>
                    </a>`;
            }).join('');
        }

        host.innerHTML = ctaHtml + listHtml;
        this._wireGamesListActions(host);
    }

    /** The "+ Connect this DexHero to your game" CTA that sits above the list.
        Three forms:
          - Wallet not connected → invite to connect.
          - Connected, no owned games → invite to register a game.
          - Connected, has linkable games → toggle button OR inline picker. */
    _renderLinkCtaHtml(myGames, linkable) {
        if (!wallet.isConnected()) {
            return `
                <button class="td-link-cta" data-link-connect>
                    <span class="td-link-cta__lead">
                        <span class="td-link-cta__title">Are you a game dev?</span>
                        <span class="td-link-cta__sub">Connect your wallet to add this DexHero to your game</span>
                    </span>
                    <span class="td-link-cta__action">CONNECT →</span>
                </button>`;
        }
        if (!myGames.length) {
            return `
                <a class="td-link-cta" href="#/register-game">
                    <span class="td-link-cta__lead">
                        <span class="td-link-cta__title">Have a game?</span>
                        <span class="td-link-cta__sub">Register your game to start linking DexHeros</span>
                    </span>
                    <span class="td-link-cta__action">REGISTER →</span>
                </a>`;
        }
        if (!linkable.length) {
            return `
                <div class="td-link-cta td-link-cta--done">
                    <span class="td-link-cta__lead">
                        <span class="td-link-cta__title">Already linked</span>
                        <span class="td-link-cta__sub">${myGames.length === 1 ? 'Your game is' : 'All of your games are'} approved for this DexHero</span>
                    </span>
                </div>`;
        }
        if (this.linkPickerOpen) {
            return `
                <div class="td-link-picker">
                    <div class="td-link-picker__head">
                        <span class="td-link-picker__title">Pick one of your games</span>
                        <button class="td-link-picker__close" type="button" data-link-toggle aria-label="Close">×</button>
                    </div>
                    <div class="td-link-picker__list">
                        ${linkable.map((g) => {
                            const initial = (g.title || '?').charAt(0).toUpperCase();
                            const icon = g.icon_url
                                ? `<img src="${sanitizeURL(g.icon_url)}" alt="" loading="lazy" decoding="async">`
                                : `<span class="td-game-row__initial">${escapeHTML(initial)}</span>`;
                            return `
                                <button class="td-link-picker__row" type="button" data-link-game="${escapeHTML(g.id)}" ${this.linking ? 'disabled' : ''}>
                                    <span class="td-game-row__icon">${icon}</span>
                                    <span class="td-link-picker__name">${escapeHTML(g.title || 'Untitled')}</span>
                                    <span class="td-link-picker__cta">${this.linking ? 'Signing…' : 'LINK'}</span>
                                </button>`;
                        }).join('')}
                    </div>
                </div>`;
        }
        return `
            <button class="td-link-cta" type="button" data-link-toggle>
                <span class="td-link-cta__lead">
                    <span class="td-link-cta__title">Add this DexHero to your game</span>
                    <span class="td-link-cta__sub">${linkable.length} of your game${linkable.length === 1 ? '' : 's'} can be linked</span>
                </span>
                <span class="td-link-cta__action">+ LINK</span>
            </button>`;
    }

    _wireGamesListActions(host) {
        host.querySelector('[data-link-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });

        host.querySelectorAll('[data-link-toggle]').forEach((el) => {
            el.addEventListener('click', () => {
                this.linkPickerOpen = !this.linkPickerOpen;
                this._paintGamesList();
            }, { signal: this.signal });
        });

        host.querySelectorAll('[data-link-game]').forEach((btn) => {
            btn.addEventListener('click', () => this._linkGame(btn.getAttribute('data-link-game')), { signal: this.signal });
        });
    }

    /** Sign + POST /api/game/tokens/link, then refresh both lists. */
    async _linkGame(gameId) {
        if (this.linking) return;
        const tokenId = this.token?.token_id || this.token?.id;
        if (!tokenId) { toast('Token ID missing — cannot link', { kind: 'err' }); return; }
        if (!wallet.isConnected()) { toast('Connect your wallet first', { kind: 'err' }); return; }

        this.linking = true;
        this._paintGamesList();
        try {
            const message = `DexHero Game Link — ${Date.now()}`;
            const signature = await wallet.signMessage(message);
            const walletAddress = wallet.getStatus().address;
            const r = await fetch('/api/game/tokens/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletAddress, signature, message, tokenId, gameId }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j?.success) throw new Error(j?.error || 'Link failed');
            toast('DexHero linked to game', { kind: 'ok' });
            this.linkPickerOpen = false;
            await this._loadLinkedGames();
        } catch (err) {
            const msg = (err && (err.message || err.toString())) || 'Link failed';
            toast(/User (denied|rejected)|reject/i.test(msg) ? 'Signature cancelled' : msg, { kind: 'err' });
        } finally {
            this.linking = false;
            this._paintGamesList();
        }
    }

    _switchTab(next) {
        if (this.tab === next) return;
        if (next !== 'inspect' && next !== 'games') return;
        this.tab = next;
        const root = this.root;
        if (!root) return;
        root.querySelectorAll('[data-tab]').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-tab') === next));
        });
        root.querySelectorAll('[data-pane]').forEach((p) => {
            p.hidden = p.getAttribute('data-pane') !== next;
        });
        // Returning to the inspect pane after the chart was sized while hidden
        // can leave it cramped; nudge a resize so it refills the new visible
        // dimensions.
        if (next === 'inspect' && this.chart) {
            const host = root.querySelector('[data-chart-host]');
            if (host) try { this.chart.applyOptions({ width: host.clientWidth, height: host.clientHeight }); } catch {}
        }
    }

    // Render the Inspect/Games tab pair into the PANEL HEADER's .panel__title
    // (replacing the default "MARKET ▸ INSPECT" breadcrumb). Idempotent — safe
    // to call on every render; only rewrites innerHTML when tab state changed.
    // Tabs share the rest of `_wireTabs`' click + swipe behavior because they
    // still live inside `this.root` and use the same `[data-tab]` selector.
    _paintHeaderTabs() {
        const titleEl = this.root?.querySelector('.panel__title');
        if (!titleEl) return;
        const t = this.tab;
        const html = `
            <button class="panel__tab" data-tab="inspect" type="button" aria-pressed="${t === 'inspect'}">Inspect</button>
            <button class="panel__tab" data-tab="games"   type="button" aria-pressed="${t === 'games'}">Games</button>
            <button class="panel__tab panel__tab--locked" type="button" aria-disabled="true" disabled title="Per-DexHero items + in-game inventory — coming soon">
                Items<span class="panel__tab-soon">Soon</span>
            </button>
        `;
        if (titleEl.innerHTML.trim() !== html.trim()) titleEl.innerHTML = html;
        titleEl.classList.add('panel__title--tabs');
    }

    _wireTabs() {
        const root = this.root;
        if (!root) return;
        this._paintHeaderTabs();
        root.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => this._switchTab(btn.getAttribute('data-tab')), { signal: this.signal });
        });

        // Mobile horizontal swipe between panes — swipe left advances to the
        // tab on the right, swipe right returns. Vertical motion threshold
        // prevents accidental tab switches during normal scroll.
        const wrap = root.querySelector('[data-panes]');
        if (!wrap) return;
        let sx = 0, sy = 0, sT = 0, active = false;
        wrap.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            sT = Date.now();
            active = true;
        }, { passive: true, signal: this.signal });
        wrap.addEventListener('touchend', (e) => {
            if (!active) return;
            active = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx;
            const dy = t.clientY - sy;
            const dt = Date.now() - sT;
            if (Math.abs(dx) > 60 && Math.abs(dy) < 40 && dt < 600) {
                if (dx < 0 && this.tab === 'inspect') this._switchTab('games');
                else if (dx > 0 && this.tab === 'games') this._switchTab('inspect');
            }
        }, { signal: this.signal });
    }

    _quickAmountBtns() {
        if (this.direction === 'buy') {
            return ['10', '50', '100', '500'].map((a) => `<button data-quick="${a}">$${a}</button>`).join('');
        }
        return ['25', '50', '75', 'MAX'].map((pct) => `<button data-quick-pct="${pct}">${pct}${pct === 'MAX' ? '' : '%'}</button>`).join('');
    }

    /* ── V3 render sections ───────────────────────────────── */
    //
    // All four blocks are injected after the .td-meta strip inside the inspect
    // pane. They only render for V3 DexHeros (t.is_v3 === true) — V2 tokens
    // never see them. Each is fully self-contained so subclasses or future
    // refactors can be lifted into separate components without restructuring.

    // Pre-tipping XP / level-up bar — game-style visual. 10 levels split
    // the path to graduation; each level = 10% of total raised. Each filled
    // segment "earns" the DexHero its next character level. At Level 10 the
    // DexHero graduates (= tipping fires + LP seeds + token starts trading).
    //
    // Why levels not dollars/mints: keeps the UI motivating regardless of
    // mint-price changes, and frames "graduation" as a quest the player
    // is helping the DexHero complete.
    _renderGraduationBar() {
        const tip = this.v3?.tipping;
        if (!tip) {
            return `<div class="td-graduation td-graduation--loading"><div class="hud-spin"></div></div>`;
        }
        let raised, threshold, mintPrice;
        try {
            raised    = BigInt(tip.raised || '0');
            threshold = BigInt(tip.threshold || '0');
            mintPrice = BigInt(tip.mintPriceUSDC || '0');
        } catch { raised = threshold = mintPrice = 0n; }

        const TOTAL_LEVELS = 10;
        const ppm = threshold > 0n ? Number((raised * 1_000_000n) / threshold) : 0;
        const clamped = Math.max(0, Math.min(1_000_000, ppm));
        const fullLevels   = Math.floor(clamped / 100_000);
        const partialPpm   = clamped - fullLevels * 100_000;
        const currentLevel = Math.min(TOTAL_LEVELS, fullLevels + 1);
        const partialPct   = (partialPpm / 100_000) * 100;
        const graduated    = fullLevels >= TOTAL_LEVELS;

        // Player math — drives the level-10 tooltip. Each Access SBT mint
        // counts as one player. raised = 0.9 × mintPrice × players (10%
        // pre-tip skim to Treasury), so players = raised / (0.9 × mintPrice).
        // Total players needed to graduate scales inversely with the SBT
        // price the creator set: $1 SBT → ~11,112 players; $100 → ~112.
        const mintPriceUsd = Number(mintPrice) / 1e6;
        const totalPlayers = mintPriceUsd > 0
            ? Math.ceil((Number(threshold) / 1e6) / (mintPriceUsd * 0.9))
            : 0;
        const playersPerLevel = Math.max(1, Math.round(totalPlayers / TOTAL_LEVELS));
        const currentPlayers = mintPriceUsd > 0
            ? Math.floor((Number(raised) / 1e6) / (mintPriceUsd * 0.9))
            : 0;
        const playersRemaining = Math.max(0, totalPlayers - currentPlayers);
        const sym = escapeHTML((this.token?.symbol || 'HERO').toUpperCase());

        const tooltipBody = graduated
            ? `All ${totalPlayers.toLocaleString()} players reached — ${sym} is live on Uniswap V3 and openly tradable.`
            : `<b>${totalPlayers.toLocaleString()} players</b> tokenize this DexHero (≈ <b>${playersPerLevel.toLocaleString()}</b> per level). Each Access SBT mint counts as one player.<br><span class="td-level__tooltip-progress">${currentPlayers.toLocaleString()} so far · ${playersRemaining.toLocaleString()} to go</span>`;

        // Minimalist visual: 10 glowing chunks + a single big level number.
        // No titles, no subtitles, no per-segment digits — the segment count
        // IS the level. Players read the bar at a glance.
        const segments = Array.from({ length: TOTAL_LEVELS }, (_, i) => {
            const idx = i + 1;
            // Segment 10 is the graduation level — a ★ marker + a hover/tap
            // tooltip explain that this is the tokenization milestone.
            const isFinal = idx === TOTAL_LEVELS;
            const finalCls  = isFinal ? ' td-level__seg--final' : '';
            const finalMark = isFinal ? `
                <span class="td-level__seg-star">★</span>
                <div class="td-level__tooltip" role="tooltip">
                    <div class="td-level__tooltip-title">Level 10 — Tokenization</div>
                    <div class="td-level__tooltip-body">${tooltipBody}</div>
                </div>
                <button class="td-level__seg-trigger" type="button" aria-label="What happens at Level 10" tabindex="0"></button>
            ` : '';
            if (idx <= fullLevels) return `<div class="td-level__seg td-level__seg--full${finalCls}">${finalMark}</div>`;
            if (idx === currentLevel && partialPct > 0) {
                return `<div class="td-level__seg td-level__seg--active${finalCls}">
                    <div class="td-level__seg-fill" style="width:${Math.max(3, partialPct).toFixed(2)}%"></div>
                    ${finalMark}
                </div>`;
            }
            return `<div class="td-level__seg${finalCls}">${finalMark}</div>`;
        }).join('');

        const levelLabel = graduated ? '★' : fullLevels;

        return `
            <section class="td-graduation${graduated ? ' td-graduation--max' : ''}">
                <div class="td-level__chip"><span class="td-level__chip-num">${levelLabel}</span></div>
                <div class="td-level__track">${segments}</div>
            </section>
        `;
    }

    // PUBLIC pending mint-price banner. Visible to everyone (so buyers know
    // the price is about to shift), no controls — actions live in the Owner
    // Controls block below. Hidden when no proposal exists or after buyout
    // (DAO governs price via governance proposal).
    _renderMintPriceBlock() {
        const tip = this.v3?.tipping;
        if (!tip || this.v3Phase === 'buyout') return '';
        const pendingUsdc = tip.pendingMintPriceUSDC;
        const pendingEta  = tip.pendingMintPriceETA;
        if (!pendingUsdc || pendingUsdc === '0') return '';
        const currentUsd = _fmtUnits(tip.mintPriceUSDC || '0', 6);
        const newUsd     = _fmtUnits(pendingUsdc, 6);
        const nowSec     = Math.floor(Date.now() / 1000);
        const remain     = Math.max(0, pendingEta - nowSec);
        const countdown  = remain === 0 ? 'ready to commit' : _fmtDuration(remain);
        return `
            <section class="td-mp td-mp--pending">
                <div class="td-mp__head">
                    <span class="td-mp__title">Mint price change</span>
                    <span class="td-mp__sub">$${currentUsd} → $${newUsd} · ${countdown}</span>
                </div>
            </section>
        `;
    }

    // GENESIS-ONLY owner controls. Consolidates everything the Genesis NFT
    // holder can do to the DexHero pre-buyout: metadata updates and the
    // 48h-delayed mint-price flow (propose / commit / cancel).
    //
    // Hidden when:
    //   - Viewer is not the Genesis holder
    //   - Buyout has executed (DAO has taken over governance)
    _renderOwnerControlsBlock() {
        const tip = this.v3?.tipping;
        if (!tip || !this.amGenesis || this.v3Phase === 'buyout') return '';

        const currentUsd  = _fmtUnits(tip.mintPriceUSDC || '0', 6);
        const pendingUsdc = tip.pendingMintPriceUSDC;
        const pendingEta  = tip.pendingMintPriceETA;
        const hasPending  = pendingUsdc && pendingUsdc !== '0';
        const nowSec      = Math.floor(Date.now() / 1000);
        const ready       = hasPending && nowSec >= (pendingEta || 0);
        const pendingUsd  = hasPending ? _fmtUnits(pendingUsdc, 6) : null;

        return `
            <section class="td-owner">
                <header class="td-owner__head">
                    <span class="td-owner__title">Owner Controls</span>
                    <span class="td-owner__badge">Genesis</span>
                </header>

                <div class="td-owner__row">
                    <div class="td-owner__row-info">
                        <span class="td-owner__row-label">Mint price</span>
                        <span class="td-owner__row-value">
                            $${currentUsd} USDC
                            ${hasPending ? `<span class="td-owner__row-pending">→ $${pendingUsd} in ${ready ? 'now' : _fmtDuration(pendingEta - nowSec)}</span>` : ''}
                        </span>
                    </div>
                    <div class="td-owner__row-actions">
                        ${hasPending ? `
                            ${ready ? `<button class="hud-btn hud-btn--primary hud-btn--sm" data-mp-commit>Commit</button>` : ''}
                            <button class="hud-btn hud-btn--ghost hud-btn--sm" data-mp-cancel>Cancel</button>
                        ` : (this.mpFormOpen ? '' : `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-mp-open>Change</button>`)}
                    </div>
                </div>
                ${!hasPending && this.mpFormOpen ? `
                    <div class="td-owner__form">
                        <input type="number" min="1" max="100" step="0.01" placeholder="New price (1–100)" value="${escapeHTML(this.mpDraftUsd)}" data-mp-input inputmode="decimal">
                        <button class="hud-btn hud-btn--primary hud-btn--sm" data-mp-propose>Propose</button>
                        <button class="hud-btn hud-btn--ghost hud-btn--sm" data-mp-close>Close</button>
                        <p class="td-owner__form-hint">48-hour delay — buyers see the pending change immediately.</p>
                    </div>
                ` : ''}

                <div class="td-owner__row">
                    <div class="td-owner__row-info">
                        <span class="td-owner__row-label">Metadata</span>
                        <span class="td-owner__row-value">Update name / image / description on-chain</span>
                    </div>
                    <div class="td-owner__row-actions">
                        ${this.metaFormOpen
                            ? `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-meta-toggle>Close</button>`
                            : `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-meta-toggle>Update</button>`}
                    </div>
                </div>
                ${this.metaFormOpen ? `
                    <div class="td-owner__form">
                        <input type="text" class="td-owner__input" placeholder="ipfs://Qm… or https://… JSON URL" data-meta-input>
                        <button class="hud-btn hud-btn--primary hud-btn--sm" data-meta-submit>Save</button>
                        <p class="td-owner__form-hint">Points <code>Manager.metadataURI</code> at OpenSea-compatible JSON.</p>
                    </div>
                ` : ''}

            </section>
        `;
    }

    _renderGenesisBlock() {
        const gen = this.v3?.genesis;
        if (!gen) return '';
        const myAddr = (wallet.getStatus()?.address || '').toLowerCase();
        const owner = (gen.currentOwner || '').toLowerCase();
        const isOwner = !!myAddr && myAddr === owner;
        const originalCreator = (gen.originalCreator || '').toLowerCase();
        const isOriginal = !!myAddr && myAddr === originalCreator;
        const lockedUsd = _fmtUsdCompact(gen.lockedInitialBuyUSDC);
        const redeemable = gen.redeemableTokens && gen.redeemableTokens !== '0'
            ? _fmtUnits(gen.redeemableTokens, 18)
            : '0';
        const canRedeem = isOwner && gen.tippingRecorded && gen.redeemableTokens && gen.redeemableTokens !== '0' && !gen.redeemed;
        return `
            <section class="td-genesis">
                <header class="td-genesis__head">
                    <span class="td-genesis__title">Genesis NFT #${escapeHTML(String(gen.tokenId || '?'))}</span>
                    <span class="td-genesis__badge">1 of 1</span>
                </header>
                <div class="td-genesis__grid">
                    <div class="td-genesis__cell">
                        <span class="td-genesis__label">Current owner</span>
                        <span class="td-genesis__val">${isOwner ? 'You' : escapeHTML(fmtAddress(gen.currentOwner || ''))}</span>
                    </div>
                    <div class="td-genesis__cell">
                        <span class="td-genesis__label">Original creator</span>
                        <span class="td-genesis__val">${isOriginal ? 'You' : escapeHTML(fmtAddress(gen.originalCreator || ''))}</span>
                    </div>
                    <div class="td-genesis__cell">
                        <span class="td-genesis__label">Locked initial buy</span>
                        <span class="td-genesis__val">${lockedUsd}</span>
                    </div>
                    <div class="td-genesis__cell">
                        <span class="td-genesis__label">Redeemable</span>
                        <span class="td-genesis__val">${gen.tippingRecorded ? `${Number(redeemable).toLocaleString('en', { maximumFractionDigits: 4 })} ${escapeHTML(this.token.symbol || 'HERO')}` : 'After tipping'}</span>
                    </div>
                    <div class="td-genesis__cell td-genesis__cell--full">
                        <span class="td-genesis__label">Status</span>
                        <span class="td-genesis__val">
                            ${gen.redeemed ? '<span class="td-status td-status--err">Redeemed (burned)</span>' :
                              (gen.tippingRecorded ? '<span class="td-status td-status--ok">Tipped — claimable</span>' :
                              '<span class="td-status">Pre-tipping</span>')}
                        </span>
                    </div>
                </div>
                <div class="td-genesis__actions">
                    ${canRedeem
                        ? `<button class="hud-btn hud-btn--primary td-genesis__cta" data-genesis-redeem>Redeem ${Number(redeemable).toLocaleString('en', { maximumFractionDigits: 2 })} ${escapeHTML(this.token.symbol || 'HERO')}</button>`
                        : ''}
                    ${isOwner
                        ? `<button class="hud-btn hud-btn--ghost" data-meta-toggle>${this.metaFormOpen ? 'Close metadata form' : 'Update Genesis metadata'}</button>`
                        : ''}
                </div>
                ${isOwner && this.metaFormOpen ? `
                    <div class="td-genesis__meta-form">
                        <p class="td-genesis__form-hint">
                            Update the Genesis NFT's metadata. Use a freeform description, a JSON URL, or <code>ipfs://&lt;cid&gt;</code> pointing to OpenSea-compatible JSON. Update is on-chain via <code>Manager.updateMetadataURI</code>.
                        </p>
                        <input type="text" class="td-genesis__meta-input" placeholder="ipfs://Qm... or https://..." data-meta-input>
                        <div class="td-genesis__meta-actions">
                            <button class="hud-btn hud-btn--primary" data-meta-submit>Update metadata</button>
                        </div>
                    </div>` : ''}
            </section>
        `;
    }

    _renderBuyoutVaultBlock() {
        const buy = this.v3?.buyout;
        if (!buy?.vault) return '';
        const sym = (this.token.symbol || 'HERO').toUpperCase();
        const tokDep = _fmtUnits(buy.tokenDeposits || '0', 18);
        const tokThr = _fmtUnits(buy.tokenThreshold || '0', 18);
        const usdDep = _fmtUsdCompact(buy.usdcDeposits || '0');
        const usdThr = _fmtUsdCompact(buy.usdcThreshold || '0');
        const tokBps = Math.min(10000, Number(buy.tokenProgressBps || 0));
        const usdBps = Math.min(10000, Number(buy.usdcProgressBps || 0));
        const connected = wallet.isConnected();
        const isExecuted = buy.executed || buy.buyoutExecutedFromManager;
        const canExecute = !isExecuted && tokBps >= 10000 && usdBps >= 10000;
        const myTok = this.myDeposits?.tokens || '0';
        const myUsd = this.myDeposits?.usdc || '0';
        const hasTok = myTok !== '0';
        const hasUsd = myUsd !== '0';
        const depKind = this.depositKind || 'token';
        const depAmt = this.depositAmount || '';
        return `
            <section class="td-buyout">
                <header class="td-buyout__head">
                    <span class="td-buyout__title">DAO TakeOver</span>
                    <span class="td-buyout__sub">Deposit ${escapeHTML(sym)} or USDC to trigger the community buyout. ${buy.depositorCount || 0} depositor${(buy.depositorCount || 0) === 1 ? '' : 's'} so far.</span>
                </header>
                <div class="td-buyout__bars">
                    <div class="td-buyout__bar-row">
                        <div class="td-buyout__bar-label">
                            <span>Tokens</span>
                            <span class="td-buyout__bar-stat">${Number(tokDep).toLocaleString('en', { maximumFractionDigits: 0 })} / ${Number(tokThr).toLocaleString('en', { maximumFractionDigits: 0 })} ${escapeHTML(sym)} (${(tokBps / 100).toFixed(1)}%)</span>
                        </div>
                        <div class="td-buyout__bar"><div class="td-buyout__bar-fill" style="width:${(tokBps / 100).toFixed(2)}%"></div></div>
                    </div>
                    <div class="td-buyout__bar-row">
                        <div class="td-buyout__bar-label">
                            <span>USDC</span>
                            <span class="td-buyout__bar-stat">${usdDep} / ${usdThr} (${(usdBps / 100).toFixed(1)}%)</span>
                        </div>
                        <div class="td-buyout__bar"><div class="td-buyout__bar-fill" style="width:${(usdBps / 100).toFixed(2)}%"></div></div>
                    </div>
                </div>
                ${isExecuted ? `
                    <div class="td-buyout__executed">
                        <span class="td-status td-status--ok">Buyout executed</span> — Genesis NFT seized to DAO at
                        <code>${escapeHTML(fmtAddress(buy.daoCloneDeployed))}</code>.
                        DAO governance section appears below.
                    </div>
                ` : `
                    <div class="td-buyout__form">
                        <div class="td-buyout__kind-toggle" role="tablist" aria-label="Deposit asset">
                            <button class="td-buyout__kind" data-vault-kind="token" aria-pressed="${depKind === 'token'}">${escapeHTML(sym)}</button>
                            <button class="td-buyout__kind" data-vault-kind="usdc" aria-pressed="${depKind === 'usdc'}">USDC</button>
                        </div>
                        <div class="td-buyout__input">
                            <input type="number" min="0" step="any" placeholder="0.00" value="${depAmt}" data-vault-amount inputmode="decimal">
                            <span class="unit">${depKind === 'token' ? escapeHTML(sym) : 'USDC'}</span>
                        </div>
                        <div class="td-buyout__actions">
                            <button class="hud-btn hud-btn--primary" data-vault-deposit ${connected ? '' : 'disabled'}>
                                ${connected ? 'Deposit' : 'Connect wallet'}
                            </button>
                            <button class="hud-btn hud-btn--ghost" data-vault-execute ${canExecute && connected ? '' : 'disabled'}>
                                Execute Buyout
                            </button>
                        </div>
                        <p class="td-buyout__hint">
                            5% fee on deposit + withdraw routes to games (split by 24h players).
                            Vault tokens move to the DAO Treasury at execution; vault USDC pays the Genesis holder directly.
                        </p>
                    </div>
                `}
                ${(hasTok || hasUsd) ? `
                    <div class="td-buyout__mine">
                        <span class="td-buyout__mine-title">Your deposits</span>
                        <div class="td-buyout__mine-row">
                            <span>${Number(_fmtUnits(myTok, 18)).toLocaleString('en', { maximumFractionDigits: 4 })} ${escapeHTML(sym)}</span>
                            ${hasTok && !isExecuted ? `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-vault-withdraw="token">Withdraw</button>` : ''}
                        </div>
                        <div class="td-buyout__mine-row">
                            <span>${_fmtUsdCompact(myUsd)}</span>
                            ${hasUsd && !isExecuted ? `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-vault-withdraw="usdc">Withdraw</button>` : ''}
                        </div>
                    </div>
                ` : ''}
            </section>
        `;
    }

    _renderDAOBlock() {
        const tip = this.v3?.tipping;
        if (!tip?.daoContract || tip.daoContract === '0x0000000000000000000000000000000000000000') return '';
        const myAddr = (wallet.getStatus()?.address || '').toLowerCase();
        const weight = this.daoState?.votingWeight || '0';
        const weightLabel = weight === '0' ? '0 (hold tokens or Governance Position NFTs to gain weight)' : _fmtUnits(weight, 6);
        const props = this.daoProposals || [];
        return `
            <section class="td-dao">
                <header class="td-dao__head">
                    <span class="td-dao__title">DAO Governance</span>
                    <span class="td-dao__sub">Community DAO took over this DexHero. Treasury holds 25% of supply.</span>
                </header>
                <div class="td-dao__weight ${weight !== '0' ? 'td-dao__weight--active' : ''}">
                    <span class="td-dao__weight-label">Your voting weight</span>
                    <span class="td-dao__weight-val">${weightLabel}</span>
                </div>
                <div class="td-dao__create-wrap">
                    <button class="hud-btn hud-btn--ghost" data-dao-propose-toggle>${this.proposeOpen ? 'Close propose form' : 'Create proposal'}</button>
                    ${this.proposeOpen ? this._renderProposeForm() : ''}
                </div>
                <div class="td-dao__props">
                    ${props.length === 0
                        ? `<div class="td-dao__empty">No proposals yet. Submit one above to start.</div>`
                        : props.map(p => this._renderProposalCard(p)).join('')}
                </div>
                <p class="td-dao__addr">DAO contract: <code>${escapeHTML(tip.daoContract)}</code></p>
            </section>
        `;
    }

    _renderProposeForm() {
        const connected = wallet.isConnected();
        return `
            <div class="td-dao__create">
                <label class="td-dao__field">
                    <span>Proposal kind</span>
                    <select data-propose-kind>
                        ${PROPOSAL_KINDS.map((k, i) => `<option value="${i}">${escapeHTML(k)}</option>`).join('')}
                    </select>
                </label>
                <label class="td-dao__field">
                    <span>Payload</span>
                    <input type="text" placeholder="address / uri / amount / 'addr,amount'" data-propose-payload>
                    <small class="td-dao__field-hint">
                        APPROVE/REJECT/REMOVE_GAME: game wallet address ·
                        UPDATE_METADATA: URI string ·
                        SET_MINT_PRICE / BURN_TREASURY_TOKENS: amount (USDC 6 or token 18 decimals) ·
                        TRANSFER_TREASURY_TOKENS: <code>recipient,amount</code> ·
                        TRANSFER_TREASURY_USDC: <code>usdcAddr,recipient,amount</code> ·
                        REFILL_LP: any (stub) ·
                        RE_CENTRALIZE: new owner address
                    </small>
                </label>
                <button class="hud-btn hud-btn--primary" data-propose-submit ${connected ? '' : 'disabled'}>
                    ${connected ? 'Submit proposal' : 'Connect wallet'}
                </button>
            </div>
        `;
    }

    _renderProposalCard(p) {
        const kind = PROPOSAL_KINDS[p.kind] || `KIND_${p.kind}`;
        const state = _proposalState(p);
        const stateCls = (state === 'Executed' || state === 'Succeeded' || state === 'Ready' || state === 'Queued') ? 'ok'
            : (state === 'Defeated' || state === 'Cancelled') ? 'err' : 'neutral';
        const yesN = Number(_fmtUnits(p.yesVotes, 6));
        const noN  = Number(_fmtUnits(p.noVotes, 6));
        const total = yesN + noN;
        const yesPct = total > 0 ? (yesN / total) * 100 : 0;
        const connected = wallet.isConnected();
        const myAddr = (wallet.getStatus()?.address || '').toLowerCase();
        const isProposer = myAddr && myAddr === (p.proposer || '').toLowerCase();

        // Action button — context-sensitive
        let actions = '';
        if (state === 'Active' && connected) {
            actions = `
                <button class="hud-btn hud-btn--primary hud-btn--sm" data-dao-vote-for="${p.id}">Vote For</button>
                <button class="hud-btn hud-btn--ghost hud-btn--sm" data-dao-vote-against="${p.id}">Vote Against</button>
            `;
        } else if (state === 'Succeeded' && connected) {
            actions = `<button class="hud-btn hud-btn--primary hud-btn--sm" data-dao-queue="${p.id}">Queue</button>`;
        } else if (state === 'Ready' && connected) {
            actions = `<button class="hud-btn hud-btn--primary hud-btn--sm" data-dao-execute="${p.id}">Execute</button>`;
        }
        if ((state === 'Active' || state === 'Defeated' || state === 'Succeeded') && isProposer) {
            actions += `<button class="hud-btn hud-btn--ghost hud-btn--sm" data-dao-cancel="${p.id}">Cancel</button>`;
        }

        return `
            <div class="td-dao__prop">
                <div class="td-dao__prop-head">
                    <span class="td-dao__prop-kind">${escapeHTML(kind)}</span>
                    <span class="td-status td-status--${stateCls}">${escapeHTML(state)}</span>
                </div>
                <div class="td-dao__prop-meta">
                    <span>#${p.id}</span>
                    <span>by ${escapeHTML(fmtAddress(p.proposer || ''))}</span>
                </div>
                <div class="td-dao__prop-votes">
                    <div class="td-dao__prop-bar"><div class="td-dao__prop-bar-fill" style="width:${yesPct.toFixed(1)}%"></div></div>
                    <div class="td-dao__prop-bar-stats">
                        <span class="ok">For ${Number(yesN).toLocaleString('en', { maximumFractionDigits: 2 })}</span>
                        <span class="err">Against ${Number(noN).toLocaleString('en', { maximumFractionDigits: 2 })}</span>
                    </div>
                </div>
                ${actions ? `<div class="td-dao__prop-actions">${actions}</div>` : ''}
            </div>
        `;
    }

    /* ── Lifecycle ─────────────────────────────────────────── */

    async onMount() {
        // Silent re-attach: if a legacy iframe (create flow, etc.) connected
        // the wallet via window.ethereum but never synced our wallet service's
        // STATE, ask the provider for accounts and rehydrate. No popup; if no
        // accounts authorized, this is a no-op and the panel renders as
        // wallet-disconnected (Mint button shows "Connect wallet to mint").
        try { if (typeof wallet.silentReattach === 'function') await wallet.silentReattach(); } catch {}
        await this._resolve();
        if (this.token) {
            // V3 state — server endpoints surface tipping / Genesis / buyout
            // state per dexheroId. _loadV3State() is a no-op for V2 tokens.
            await this._loadV3State();
            setContext({
                id: this.token.id,
                name: this.token.name,
                symbol: this.token.symbol,
                address: this.token.manager_address || this.token.contract_address || null,
                network: this.token.chain || this.token.network || 'ethereum',
                image: this.token.image_url || this.token.thumbnail_url || null,
                model: this.token.model_url || null,
                sprite: this.token.sprite_url || null,
                spriteFrames: this.token.sprite_frame_count || 0,
            });
            const s = wallet.getStatus();
            if (s.connected) pushRecentToken(s.address, {
                address: this.token.manager_address || this.token.contract_address || this.token.id,
                name: this.token.name, symbol: this.token.symbol,
            });

            // Fast-path migration check — only the metadata flags, no RPC.
            // The on-chain check runs in the background (non-blocking) and
            // swaps the chart to Gecko later if the token has graduated.
            this.isMigrated = _migratedFromMeta(this.token);
        }
        this.rerender();
        this._wire();
        this._wireTabs();
        if (this.loadState === 'ready') this._loadLinkedGames();
        // V3 tokens always paint via chart-or-progress (MintProgress pre-tipping,
        // Gecko post-tipping). The legacy chart path below is V2-only.
        this._paintChart();

        // Refresh the developer-link CTA when the wallet connects/changes —
        // we need the wallet's owned games to show the right call to action.
        const unsub = on(E.WALLET_CHANGED, async () => {
            if (this.loadState !== 'ready') return;
            this.myGames = null;
            if (wallet.isConnected()) await this._loadMyGames();
            this._paintGamesList();
            // Re-fetch V3 wallet-scoped reads (my deposits, voting weight)
            if (this.token?.is_v3) {
                await this._loadV3State();
                this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
            }
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });
        // V2 / non-V3 paths only — V3 DexHeros use chart-or-progress, not the
        // native candle chart + Supabase trade feed.
        if (this.loadState === 'ready' && !this.token?.is_v3 && !this.isMigrated) {
            this._initChart();
            this._loadChartData();
            this._subscribeRealtime();    // live trade pushes from Supabase
            this._startBackstop();         // 60s full-refresh safety net
            // Background: poll the on-chain state (non-blocking) to see if
            // this token has tipped since the metadata was last written. If
            // so, flip the UI to Gecko seamlessly.
            this._detectMigrationAsync();
        } else if (this.loadState === 'ready' && !this.token?.is_v3 && this.isMigrated) {
            this._wireGeckoFallback();
        }
    }

    /* ── V3 state loading ─────────────────────────────────────── */
    //
    // Parallel-fetch the server endpoints I built in Commit 2: tipping
    // progress, Genesis NFT state, buyout vault state. Plus per-wallet
    // direct-chain reads for vault deposits + DAO voting weight + proposals
    // (post-buyout only). All reads are best-effort; failures degrade to
    // hidden sections, not panel-wide errors.
    async _loadV3State() {
        if (!this.token?.v3_dexhero_id) return;
        const id = this.token.v3_dexhero_id;
        try {
            const [tip, gen, buy] = await Promise.all([
                fetch(`/api/dexhero/tipping-progress/${id}`).then(r => r.ok ? r.json() : null).catch(() => null),
                fetch(`/api/dexhero/genesis-status/${id}`).then(r => r.ok ? r.json() : null).catch(() => null),
                fetch(`/api/dexhero/buyout-status/${id}`).then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            this.v3 = { tipping: tip, genesis: gen, buyout: buy };
            this.v3Phase = tip?.buyoutExecuted ? 'buyout' : (tip?.tipped ? 'post' : 'pre');

            // Per-wallet ownership flags. amGenesis governs the Owner Controls
            // panel; mySbtBalance > 0 swaps the header "Mint" CTA for a
            // "Soulbound" badge so existing holders see at-a-glance that they
            // already have access.
            const w = wallet.getStatus();
            this.mySbtBalance = 0;
            this.amGenesis    = false;
            if (w?.address) {
                this.amGenesis = (gen?.currentOwner || '').toLowerCase() === w.address.toLowerCase();
                if (tip?.sbt && tip.sbt !== '0x0000000000000000000000000000000000000000' && _hasEthers()) {
                    try {
                        const provider = wallet.getProvider() || _readProvider();
                        if (provider) {
                            const sbt = new window.ethers.Contract(tip.sbt, [
                                'function balanceOf(address) view returns (uint256)',
                            ], provider);
                            const bal = await sbt.balanceOf(w.address);
                            this.mySbtBalance = Number(bal.toString());
                        }
                    } catch (err) { console.warn('[token-detail] sbt balanceOf failed:', err.message); }
                }
            }

            // Per-wallet direct-chain reads — vault deposits, voting weight
            if (this.v3Phase !== 'pre' && buy?.vault && w?.address && _hasEthers()) {
                try {
                    const provider = wallet.getProvider() || _readProvider();
                    if (provider) {
                        const v = new window.ethers.Contract(buy.vault, [
                            'function tokenContributions(address) view returns (uint256)',
                            'function usdcContributions(address) view returns (uint256)',
                        ], provider);
                        const [tk, us] = await Promise.all([
                            v.tokenContributions(w.address),
                            v.usdcContributions(w.address),
                        ]);
                        this.myDeposits = { tokens: tk.toString(), usdc: us.toString() };
                    }
                } catch (err) { console.warn('[token-detail] vault contributions read failed:', err.message); }
            }

            // DAO state + proposals — post-buyout only
            if (this.v3Phase === 'buyout' && tip?.daoContract && tip.daoContract !== '0x0000000000000000000000000000000000000000') {
                await this._loadDAOProposals(tip.daoContract);
            }
        } catch (err) {
            console.warn('[token-detail] V3 state load failed:', err.message);
        }
    }

    async _loadDAOProposals(daoAddr) {
        if (!_hasEthers()) return;
        try {
            const provider = wallet.getProvider() || _readProvider();
            if (!provider) return;
            const dao = new window.ethers.Contract(daoAddr, [
                'function proposalCount() view returns (uint256)',
                'function proposals(uint256) view returns (uint8 kind, address proposer, uint256 snapshotBlock, uint256 voteStart, uint256 voteEnd, uint256 queuedAt, bool executed, bool cancelled, uint256 yesVotes, uint256 noVotes, bytes payload)',
                'function getVotingWeight(address voter, uint256 snapshotBlock) view returns (uint256)',
                'function dexheroId() view returns (uint256)',
            ], provider);
            const count = Number(await dao.proposalCount());
            const props = [];
            for (let i = 1; i <= count; i++) {
                try {
                    const p = await dao.proposals(i);
                    props.push({
                        id: i,
                        kind: Number(p.kind),
                        proposer: p.proposer,
                        snapshotBlock: p.snapshotBlock.toString(),
                        voteStart: Number(p.voteStart),
                        voteEnd: Number(p.voteEnd),
                        queuedAt: Number(p.queuedAt),
                        executed: p.executed,
                        cancelled: p.cancelled,
                        yesVotes: p.yesVotes.toString(),
                        noVotes: p.noVotes.toString(),
                        payload: p.payload,
                    });
                } catch { /* skip unreadable */ }
            }
            this.daoProposals = props;

            // Voting weight for connected wallet at the current block — gives
            // the user an immediate readout of their governance power.
            const w = wallet.getStatus();
            if (w?.address) {
                try {
                    const blk = await provider.getBlockNumber();
                    const weight = await dao.getVotingWeight(w.address, blk - 1);
                    this.daoState = { votingWeight: weight.toString(), daoAddr };
                } catch { this.daoState = { votingWeight: '0', daoAddr }; }
            } else {
                this.daoState = { votingWeight: '0', daoAddr };
            }
        } catch (err) {
            console.warn('[token-detail] DAO proposals load failed:', err.message);
        }
    }

    onUnmount() {
        setIdle();
        this._stopBackstop();
        this._unsubscribeRealtime();
        this._disposeChart();
    }

    onParamsChange(params) {
        if (params.address && params.address !== this.ident) {
            this.ident = params.address;
            this.token = null;
            this.linkedGames = null;
            // Clear V3 state on token swap — otherwise stale data leaks between DexHeros
            this.v3 = null;
            this.v3Phase = null;
            this.myDeposits = null;
            this.daoProposals = [];
            this.daoState = null;
            this.loadState = 'loading';
            this._disposeChart();
            this.rerender();
            this.onMount();
        }
    }

    /* ── V3 chart wiring ─────────────────────────────────────── */
    //
    // _chartState builds the input expected by chart-or-progress.js:
    //   - existing-token launch path → existingPool (GeckoTerminal)
    //   - V3 post-tipping            → launchpad.v3Pool   (GeckoTerminal)
    //   - V3 pre-tipping             → launchpad without v3Pool (MintProgress)
    //   - idle / not-yet-loaded      → null → loading state in module
    _chartState() {
        const t = this.token;
        if (!t) return null;
        // Existing-token path (V2 + V3 both — wrapping an existing ERC20)
        if (t.launch_type === 'existing') {
            const addr = t.metadata?.existingTokenAddress || t.contract_address;
            if (addr) return { existingPool: { network: _chainForChart(t), address: addr } };
        }
        if (!t.is_v3) return null;  // V2 native — caller falls through to legacy chart
        const tip = this.v3?.tipping;
        if (!tip) return { /* idle */ };
        if (tip.tipped && tip.lpPool && tip.lpPool !== '0x0000000000000000000000000000000000000000') {
            return {
                launchpad: {
                    totalRaisedUSDC: tip.raised,
                    tippingPointUSDC: tip.threshold,
                    mintPriceUSDC: tip.mintPriceUSDC,
                    nftsMinted: 0,
                    v3Pool: { network: _chainForChart(t), address: tip.lpPool },
                },
            };
        }
        // Pre-tipping — render MintProgress
        return {
            launchpad: {
                totalRaisedUSDC: tip.raised,
                tippingPointUSDC: tip.threshold,
                mintPriceUSDC: tip.mintPriceUSDC,
                nftsMinted: 0,
                v3Pool: null,
            },
        };
    }

    _paintChart() {
        if (!this.token) return;
        // Only V3 + existing-token paths use chart-or-progress here. V2 native
        // candle chart is wired by _initChart() elsewhere and stays untouched.
        const useNew = this.token.is_v3 || this.token.launch_type === 'existing';
        if (!useNew) return;
        const host = this.root?.querySelector('[data-chart-host]');
        if (!host) return;
        const state = this._chartState();
        if (!state) return;
        renderChartOrProgress(host, state);
    }

    /* ── Wiring ────────────────────────────────────────────── */

    _wire() {
        const root = this.root;
        if (!root) return;

        root.querySelector('[data-retry]')?.addEventListener('click', async () => {
            this.loadState = 'loading';
            this.rerender();
            await this.onMount();
        }, { signal: this.signal });

        // Model play / pause — toggles both the embedded walk animation
        // and the auto-rotate spin so a single tap fully stops or resumes
        // motion.
        root.querySelector('[data-model-toggle]')?.addEventListener('click', (e) => {
            const btn = e.currentTarget;
            const mv = root.querySelector('.td-model model-viewer');
            if (!mv) return;
            const playing = btn.getAttribute('data-state') === 'playing';
            if (playing) {
                try { mv.pause(); } catch {}
                mv.removeAttribute('auto-rotate');
                btn.setAttribute('data-state', 'paused');
                btn.setAttribute('aria-label', 'Play animation');
            } else {
                mv.setAttribute('auto-rotate', '');
                try { mv.play(); } catch {}
                btn.setAttribute('data-state', 'playing');
                btn.setAttribute('aria-label', 'Pause animation');
            }
        }, { signal: this.signal });

        // Timeframes
        root.querySelectorAll('.td-tf').forEach((btn) => {
            btn.addEventListener('click', () => {
                const res = parseInt(btn.getAttribute('data-res'), 10);
                if (res === this.resolution) return;
                this.resolution = res;
                root.querySelectorAll('.td-tf').forEach((b) => b.setAttribute('aria-pressed', String(parseInt(b.getAttribute('data-res'), 10) === res)));
                this._loadChartData();
            }, { signal: this.signal });
        });

        // Buy/Sell dir
        root.querySelectorAll('.td-trade__dir').forEach((btn) => {
            btn.addEventListener('click', () => {
                const dir = btn.getAttribute('data-dir');
                if (dir === this.direction) return;
                this.direction = dir;
                this.rerender();  // re-render trade widget to flip unit + quick amounts
                this._wire();
                this._wireTabs();
                this._paintGamesList();
                this._reattachChartContainer();
            }, { signal: this.signal });
        });

        // Amount → live quote
        const input = root.querySelector('[data-amount]');
        input?.addEventListener('input', () => this._updateQuote(), { signal: this.signal });

        // Quick amounts
        root.querySelectorAll('[data-quick]').forEach((b) => {
            b.addEventListener('click', () => {
                if (!input) return;
                input.value = b.getAttribute('data-quick');
                this._updateQuote();
            }, { signal: this.signal });
        });
        root.querySelectorAll('[data-quick-pct]').forEach((b) => {
            b.addEventListener('click', async () => {
                const pct = b.getAttribute('data-quick-pct');
                const bal = await this._tokenBalance();
                if (!input) return;
                input.value = pct === 'MAX' ? String(bal) : String((bal * parseInt(pct, 10) / 100).toFixed(4));
                this._updateQuote();
            }, { signal: this.signal });
        });

        // Submit
        root.querySelector('[data-submit]')?.addEventListener('click', () => this._submit(), { signal: this.signal });

        // ── V3 wiring (mint / Genesis / Buyout / DAO) ──────────────
        // All buttons are bound here on every rerender; signal cleans up on unmount.

        // SBT mint
        root.querySelector('[data-mint-qty]')?.addEventListener('input', (e) => {
            const v = parseInt(e.target.value || '1', 10);
            this.mintQty = Math.max(1, Math.min(100, isFinite(v) ? v : 1));
            // Update only the button label so we don't blow away the focus
            const btn = root.querySelector('[data-mint-submit]');
            if (btn && this.v3?.tipping) {
                const mintUsd = Number(_fmtUnits(this.v3.tipping.mintPriceUSDC || '0', 6));
                const total = (mintUsd * this.mintQty).toLocaleString('en', { maximumFractionDigits: 2 });
                btn.textContent = wallet.isConnected() ? `Mint ${this.mintQty} for ${total} USDC` : 'Connect wallet to mint';
            }
        }, { signal: this.signal });
        root.querySelector('[data-mint-submit]')?.addEventListener('click', () => this._mintSBT(), { signal: this.signal });

        // Genesis — redeem + metadata update form
        root.querySelector('[data-genesis-redeem]')?.addEventListener('click', () => this._redeemGenesis(), { signal: this.signal });
        root.querySelector('[data-meta-toggle]')?.addEventListener('click', () => {
            this.metaFormOpen = !this.metaFormOpen;
            this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
        }, { signal: this.signal });
        root.querySelector('[data-meta-submit]')?.addEventListener('click', () => {
            const inp = root.querySelector('[data-meta-input]');
            const uri = (inp?.value || '').trim();
            if (!uri) return toast('Enter a URI or description', { kind: 'err' });
            this._updateMetadata(uri);
        }, { signal: this.signal });

        // Mint-price timelock (Genesis holder)
        root.querySelector('[data-mp-open]')?.addEventListener('click', () => {
            this.mpFormOpen = true;
            this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
        }, { signal: this.signal });
        root.querySelector('[data-mp-close]')?.addEventListener('click', () => {
            this.mpFormOpen = false;
            this.mpDraftUsd = '';
            this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
        }, { signal: this.signal });
        root.querySelector('[data-mp-input]')?.addEventListener('input', (e) => {
            this.mpDraftUsd = e.target.value;
        }, { signal: this.signal });
        root.querySelector('[data-mp-propose]')?.addEventListener('click', () => this._proposeMintPrice(), { signal: this.signal });
        root.querySelector('[data-mp-commit]')?.addEventListener('click',  () => this._commitMintPrice(),  { signal: this.signal });
        root.querySelector('[data-mp-cancel]')?.addEventListener('click',  () => this._cancelMintPriceProposal(), { signal: this.signal });

        // Owner Controls — Enable SBT artwork (Genesis-holder)
        // Buyout vault
        root.querySelectorAll('[data-vault-kind]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.depositKind = btn.getAttribute('data-vault-kind');
                this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
            }, { signal: this.signal });
        });
        root.querySelector('[data-vault-amount]')?.addEventListener('input', (e) => {
            this.depositAmount = e.target.value;
        }, { signal: this.signal });
        root.querySelector('[data-vault-deposit]')?.addEventListener('click', () => this._vaultDeposit(), { signal: this.signal });
        root.querySelector('[data-vault-execute]')?.addEventListener('click', () => this._vaultExecute(), { signal: this.signal });
        root.querySelectorAll('[data-vault-withdraw]').forEach(btn => {
            btn.addEventListener('click', () => this._vaultWithdraw(btn.getAttribute('data-vault-withdraw')), { signal: this.signal });
        });

        // DAO — propose form toggle + submit + vote/queue/execute/cancel
        root.querySelector('[data-dao-propose-toggle]')?.addEventListener('click', () => {
            this.proposeOpen = !this.proposeOpen;
            this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
        }, { signal: this.signal });
        root.querySelector('[data-propose-submit]')?.addEventListener('click', () => {
            const kind = parseInt(root.querySelector('[data-propose-kind]')?.value || '0', 10);
            const payload = (root.querySelector('[data-propose-payload]')?.value || '').trim();
            this._daoPropose(kind, payload);
        }, { signal: this.signal });
        root.querySelectorAll('[data-dao-vote-for]').forEach(btn => {
            btn.addEventListener('click', () => this._daoVote(parseInt(btn.getAttribute('data-dao-vote-for'), 10), true), { signal: this.signal });
        });
        root.querySelectorAll('[data-dao-vote-against]').forEach(btn => {
            btn.addEventListener('click', () => this._daoVote(parseInt(btn.getAttribute('data-dao-vote-against'), 10), false), { signal: this.signal });
        });
        root.querySelectorAll('[data-dao-queue]').forEach(btn => {
            btn.addEventListener('click', () => this._daoQueue(parseInt(btn.getAttribute('data-dao-queue'), 10)), { signal: this.signal });
        });
        root.querySelectorAll('[data-dao-execute]').forEach(btn => {
            btn.addEventListener('click', () => this._daoExecute(parseInt(btn.getAttribute('data-dao-execute'), 10)), { signal: this.signal });
        });
        root.querySelectorAll('[data-dao-cancel]').forEach(btn => {
            btn.addEventListener('click', () => this._daoCancel(parseInt(btn.getAttribute('data-dao-cancel'), 10)), { signal: this.signal });
        });
    }

    /* ── V3 action handlers ────────────────────────────────── */

    // Reload the V3 state and rerender. After an on-chain action, the read
    // endpoint can briefly return pre-tx state because the public RPC node
    // we hit hasn't indexed the new block yet. Retry a few times with short
    // backoff until the data actually moves (or we run out of attempts).
    async _v3RefreshAndRerender({ expectChange = false } = {}) {
        const prevRaised = this.v3?.tipping?.raised;
        await this._loadV3State();
        this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
        if (!expectChange) return;
        for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const before = this.v3?.tipping?.raised;
            await this._loadV3State();
            if (this.v3?.tipping?.raised !== before || this.v3?.tipping?.raised !== prevRaised) {
                this.rerender(); this._wire(); this._wireTabs(); this._paintChart();
                if (this.v3?.tipping?.raised !== prevRaised) return; // confirmed moved
            }
        }
    }

    async _ensureSignerOrConnect() {
        if (!wallet.isConnected()) {
            try { await wallet.connect(); }
            catch (err) { toast('Wallet connect required', { kind: 'err' }); throw err; }
        }
        // Verify the connected wallet is on the chain V3 contracts live on.
        // Without this, allowance/balanceOf calls hit the right ADDRESS on
        // the wrong network and revert with cryptic CALL_EXCEPTION data="0x".
        await this._ensureCorrectChain();
        return wallet.getSigner();
    }

    // Loads /api/config once and caches { chainId, usdc }. Then ensures the
    // connected wallet is on chainId; if not, requests a switch via the
    // injected provider (wallet_switchEthereumChain), falling back to
    // wallet_addEthereumChain if the chain isn't yet known to the wallet.
    async _ensureCorrectChain() {
        if (!this._chainConfig) {
            try {
                const cfg = await fetch('/api/config').then(r => r.ok ? r.json() : null);
                this._chainConfig = {
                    chainId: Number(cfg?.chainId || 11155111),
                    usdc: cfg?.usdc || '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
                };
            } catch { this._chainConfig = { chainId: 11155111, usdc: USDC_SEPOLIA }; }
        }
        const want = this._chainConfig.chainId;
        const have = wallet.getStatus()?.chainId;
        if (have === want) return;
        const wantHex = '0x' + want.toString(16);
        const raw = window.ethereum;
        if (!raw?.request) throw new Error('Wallet does not support chain switching');
        try {
            await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wantHex }] });
        } catch (err) {
            // 4902 = chain not added; add it then re-issue switch
            if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message || '')) {
                const chainParams = _chainAddParams(want);
                if (!chainParams) throw new Error(`Switch to chainId ${want} (Sepolia) in your wallet`);
                try {
                    await raw.request({ method: 'wallet_addEthereumChain', params: [chainParams] });
                } catch (addErr) {
                    toast(`Add ${chainParams.chainName} to your wallet and retry`, { kind: 'err' });
                    throw addErr;
                }
            } else if (err?.code === 4001) {
                toast('Switch rejected — V3 lives on Sepolia', { kind: 'err' });
                throw err;
            } else {
                throw err;
            }
        }
        // Give the wallet a beat to propagate the new chainId into our STATE.
        await new Promise(r => setTimeout(r, 250));
    }

    async _ensureUsdcAllowance(spender, amount) {
        const signer = wallet.getSigner();
        const usdcAddr = this._chainConfig?.usdc || USDC_SEPOLIA;
        const usdc = new window.ethers.Contract(usdcAddr, [
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
            'function balanceOf(address) view returns (uint256)',
        ], signer);
        const owner = wallet.getStatus().address;
        // Pre-flight: confirm a contract exists at usdcAddr on the current
        // chain. If allowance() reverts here, surface a clear message
        // instead of the cryptic CALL_EXCEPTION + data="0x" ethers throws.
        let cur;
        try { cur = await usdc.allowance(owner, spender); }
        catch (err) {
            throw new Error('USDC contract not reachable — make sure your wallet is on Sepolia');
        }
        if (window.ethers.BigNumber.from(cur).lt(window.ethers.BigNumber.from(amount))) {
            const bal = await usdc.balanceOf(owner);
            if (window.ethers.BigNumber.from(bal).lt(window.ethers.BigNumber.from(amount))) {
                const need = Number(window.ethers.utils.formatUnits(amount, 6)).toFixed(2);
                const have = Number(window.ethers.utils.formatUnits(bal, 6)).toFixed(2);
                throw new Error(`Need ${need} USDC, wallet has ${have}`);
            }
            toast('Approving USDC…', { kind: 'info' });
            await (await usdc.approve(spender, window.ethers.constants.MaxUint256)).wait();
        }
    }

    async _ensureTokenAllowance(token, spender, amount) {
        const signer = wallet.getSigner();
        const erc20 = new window.ethers.Contract(token, [
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
        ], signer);
        const owner = wallet.getStatus().address;
        const cur = await erc20.allowance(owner, spender);
        if (window.ethers.BigNumber.from(cur).lt(window.ethers.BigNumber.from(amount))) {
            toast('Approving token…', { kind: 'info' });
            await (await erc20.approve(spender, window.ethers.constants.MaxUint256)).wait();
        }
    }

    async _mintSBT() {
        // Re-entrancy guard: ignore repeat clicks while a mint is in flight
        // (covers the user spam-pressing the Mint button before the first
        // tx confirms — without this, every click after the wallet popup
        // would send another mint as soon as MetaMask sees the next signature).
        if (this.mintInFlight) {
            toast('Mint already in progress…', { kind: 'info' });
            return;
        }
        // Defensive: refuse to mint when the wallet already holds an Access SBT.
        // The contract itself allows owning many SBTs, but the UI promise is
        // "1 SBT = access" — minting more is wasted USDC. The header already
        // swaps Mint → Soulbound at mySbtBalance > 0, so reaching this branch
        // means the user found a click target before _loadV3State finished.
        if (this.mySbtBalance > 0) {
            toast('Wallet already owns an Access SBT for this DexHero', { kind: 'info' });
            return;
        }
        this.mintInFlight = true;
        this._updateMintButtonInFlightState();
        try {
            const signer = await this._ensureSignerOrConnect();
            if (!_hasEthers()) return;
            const mgrAddr = this.token.v3_manager_address;
            const tip = this.v3?.tipping;
            if (!mgrAddr || !tip) return toast('Mint not available', { kind: 'err' });
            const mintPrice = window.ethers.BigNumber.from(tip.mintPriceUSDC);
            const total = mintPrice.mul(this.mintQty || 1);
            await this._ensureUsdcAllowance(mgrAddr, total);
            const mgr = new window.ethers.Contract(mgrAddr, ['function mintSBT(uint256)'], signer);
            toast(`Minting ${this.mintQty} SBT…`, { kind: 'info' });
            const tx = await mgr.mintSBT(this.mintQty);
            await tx.wait();
            toast(`Minted ${this.mintQty} SBT`, { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) {
            toast(err.reason || err.message || 'Mint failed', { kind: 'err' });
        } finally {
            this.mintInFlight = false;
            this._updateMintButtonInFlightState();
        }
    }

    // Toggles the in-flight visual state on the header Mint button without
    // doing a full rerender (avoids dropping focus / interrupting other UI).
    _updateMintButtonInFlightState() {
        const btn = this.root?.querySelector('[data-mint-submit]');
        if (!btn) return;
        if (this.mintInFlight) {
            btn.setAttribute('disabled', '');
            btn.setAttribute('data-prev-label', btn.textContent || 'Mint');
            btn.textContent = 'Minting…';
        } else {
            btn.removeAttribute('disabled');
            const prev = btn.getAttribute('data-prev-label') || 'Mint';
            btn.textContent = prev;
            btn.removeAttribute('data-prev-label');
        }
    }

    async _redeemGenesis() {
        try {
            const signer = await this._ensureSignerOrConnect();
            const gen = this.v3?.genesis;
            if (!gen) return;
            const genesisAddr = (await fetch('/api/config').then(r => r.json()))?.v3?.genesisNFT;
            if (!genesisAddr) return toast('Genesis NFT contract not configured', { kind: 'err' });
            const c = new window.ethers.Contract(genesisAddr, ['function redeem(uint256)'], signer);
            toast('Redeeming Genesis…', { kind: 'info' });
            const tx = await c.redeem(gen.tokenId);
            await tx.wait();
            toast('Genesis redeemed', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Redeem failed', { kind: 'err' }); }
    }

    async _updateMetadata(uri) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const mgrAddr = this.token.v3_manager_address;
            const mgr = new window.ethers.Contract(mgrAddr, ['function updateMetadataURI(string)'], signer);
            toast('Updating metadata…', { kind: 'info' });
            const tx = await mgr.updateMetadataURI(uri);
            await tx.wait();
            toast('Metadata updated', { kind: 'ok' });
            this.metaFormOpen = false;
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Update failed', { kind: 'err' }); }
    }

    // ─── Mint-price timelock (Genesis holder, 48h delay) ───

    async _proposeMintPrice() {
        try {
            const usd = parseFloat(this.mpDraftUsd || '0');
            if (!isFinite(usd) || usd < 1 || usd > 100) {
                return toast('Price must be 1–100 USDC', { kind: 'err' });
            }
            const signer = await this._ensureSignerOrConnect();
            const mgrAddr = this.token.v3_manager_address;
            const mgr = new window.ethers.Contract(mgrAddr, ['function proposeMintPrice(uint256)'], signer);
            const newPrice = window.ethers.utils.parseUnits(usd.toFixed(2), 6);
            toast(`Proposing $${usd.toFixed(2)} mint price (48h delay)…`, { kind: 'info' });
            const tx = await mgr.proposeMintPrice(newPrice);
            await tx.wait();
            toast('Mint-price change proposed — buyers see the pending change immediately', { kind: 'ok' });
            this.mpFormOpen = false;
            this.mpDraftUsd = '';
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Propose failed', { kind: 'err' }); }
    }

    async _commitMintPrice() {
        try {
            const signer = await this._ensureSignerOrConnect();
            const mgrAddr = this.token.v3_manager_address;
            const mgr = new window.ethers.Contract(mgrAddr, ['function commitMintPrice()'], signer);
            toast('Committing new mint price…', { kind: 'info' });
            const tx = await mgr.commitMintPrice();
            await tx.wait();
            toast('Mint price updated', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Commit failed', { kind: 'err' }); }
    }

    async _cancelMintPriceProposal() {
        try {
            const signer = await this._ensureSignerOrConnect();
            const mgrAddr = this.token.v3_manager_address;
            const mgr = new window.ethers.Contract(mgrAddr, ['function cancelMintPriceProposal()'], signer);
            toast('Cancelling proposal…', { kind: 'info' });
            const tx = await mgr.cancelMintPriceProposal();
            await tx.wait();
            toast('Proposal cancelled', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Cancel failed', { kind: 'err' }); }
    }

    async _vaultDeposit() {
        try {
            const signer = await this._ensureSignerOrConnect();
            const buy = this.v3?.buyout;
            if (!buy?.vault) return;
            const amt = (this.depositAmount || '').trim();
            if (!amt || Number(amt) <= 0) return toast('Enter a positive amount', { kind: 'err' });
            const isToken = this.depositKind === 'token';
            const tokenAddr = this.v3?.tipping?.tokenContract;
            if (isToken && !tokenAddr) return toast('Token not yet deployed', { kind: 'err' });
            const dec = isToken ? 18 : 6;
            const amountRaw = window.ethers.utils.parseUnits(amt, dec);
            if (isToken) {
                await this._ensureTokenAllowance(tokenAddr, buy.vault, amountRaw);
            } else {
                await this._ensureUsdcAllowance(buy.vault, amountRaw);
            }
            const vault = new window.ethers.Contract(buy.vault, [
                'function depositTokens(uint256)',
                'function depositUsdc(uint256)',
            ], signer);
            toast(`Depositing ${amt} ${isToken ? (this.token.symbol || 'HERO') : 'USDC'}…`, { kind: 'info' });
            const tx = await (isToken ? vault.depositTokens(amountRaw) : vault.depositUsdc(amountRaw));
            await tx.wait();
            toast('Deposit confirmed', { kind: 'ok' });
            this.depositAmount = '';
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Deposit failed', { kind: 'err' }); }
    }

    async _vaultWithdraw(kind) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const buy = this.v3?.buyout;
            if (!buy?.vault) return;
            const my = this.myDeposits;
            if (!my) return;
            const raw = kind === 'token' ? my.tokens : my.usdc;
            if (raw === '0') return toast('Nothing to withdraw', { kind: 'err' });
            const vault = new window.ethers.Contract(buy.vault, [
                'function withdrawTokens(uint256)',
                'function withdrawUsdc(uint256)',
            ], signer);
            toast(`Withdrawing your ${kind === 'token' ? (this.token.symbol || 'HERO') : 'USDC'}…`, { kind: 'info' });
            const tx = await (kind === 'token' ? vault.withdrawTokens(raw) : vault.withdrawUsdc(raw));
            await tx.wait();
            toast('Withdrawn', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Withdraw failed', { kind: 'err' }); }
    }

    async _vaultExecute() {
        try {
            const signer = await this._ensureSignerOrConnect();
            const buy = this.v3?.buyout;
            if (!buy?.vault) return;
            const vault = new window.ethers.Contract(buy.vault, ['function executeBuyout()'], signer);
            toast('Executing buyout…', { kind: 'info' });
            const tx = await vault.executeBuyout();
            await tx.wait();
            toast('Buyout executed', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Execute failed', { kind: 'err' }); }
    }

    async _daoPropose(kind, payloadStr) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const daoAddr = this.v3?.tipping?.daoContract;
            if (!daoAddr) return;
            const ethers = window.ethers;
            const ABI = ethers.utils.defaultAbiCoder;
            let encoded;
            // Encode payload per ProposalKind enum
            switch (kind) {
                case 0: case 1: case 2: // APPROVE / REJECT / REMOVE_GAME — address
                case 9:                  // RE_CENTRALIZE — address
                    if (!ethers.utils.isAddress(payloadStr)) return toast('Payload must be an address', { kind: 'err' });
                    encoded = ABI.encode(['address'], [payloadStr]);
                    break;
                case 3: // UPDATE_METADATA — string
                    encoded = ABI.encode(['string'], [payloadStr]);
                    break;
                case 4: // SET_MINT_PRICE — uint256 (USDC, 6 decimals)
                    encoded = ABI.encode(['uint256'], [ethers.utils.parseUnits(payloadStr || '0', 6)]);
                    break;
                case 5: // BURN_TREASURY_TOKENS — uint256 (18 decimals)
                    encoded = ABI.encode(['uint256'], [ethers.utils.parseUnits(payloadStr || '0', 18)]);
                    break;
                case 6: { // TRANSFER_TREASURY_TOKENS — (address,uint256)
                    const [addr, amt] = payloadStr.split(',').map(s => s.trim());
                    if (!ethers.utils.isAddress(addr)) return toast('Recipient must be address', { kind: 'err' });
                    encoded = ABI.encode(['address', 'uint256'], [addr, ethers.utils.parseUnits(amt || '0', 18)]);
                    break;
                }
                case 7: { // TRANSFER_TREASURY_USDC — (address usdc, address to, uint256)
                    const [usdcAddr, to, amt] = payloadStr.split(',').map(s => s.trim());
                    if (!ethers.utils.isAddress(usdcAddr) || !ethers.utils.isAddress(to)) return toast('Need usdcAddr,to,amount', { kind: 'err' });
                    encoded = ABI.encode(['address', 'address', 'uint256'], [usdcAddr, to, ethers.utils.parseUnits(amt || '0', 6)]);
                    break;
                }
                case 8: // REFILL_LP — stub, empty bytes
                    encoded = '0x';
                    break;
                default: return toast('Unknown proposal kind', { kind: 'err' });
            }
            const dao = new window.ethers.Contract(daoAddr, ['function propose(uint8,bytes) returns (uint256)'], signer);
            toast('Submitting proposal…', { kind: 'info' });
            const tx = await dao.propose(kind, encoded);
            await tx.wait();
            toast('Proposal submitted', { kind: 'ok' });
            this.proposeOpen = false;
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Proposal failed', { kind: 'err' }); }
    }

    async _daoVote(proposalId, support) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const daoAddr = this.v3?.tipping?.daoContract;
            const dao = new window.ethers.Contract(daoAddr, ['function castVote(uint256,bool)'], signer);
            toast(`Voting ${support ? 'FOR' : 'AGAINST'}…`, { kind: 'info' });
            const tx = await dao.castVote(proposalId, support);
            await tx.wait();
            toast('Vote cast', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Vote failed', { kind: 'err' }); }
    }

    async _daoQueue(proposalId) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const daoAddr = this.v3?.tipping?.daoContract;
            const dao = new window.ethers.Contract(daoAddr, ['function queue(uint256)'], signer);
            toast('Queueing…', { kind: 'info' });
            const tx = await dao.queue(proposalId);
            await tx.wait();
            toast('Queued', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Queue failed', { kind: 'err' }); }
    }

    async _daoExecute(proposalId) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const daoAddr = this.v3?.tipping?.daoContract;
            const dao = new window.ethers.Contract(daoAddr, ['function execute(uint256)'], signer);
            toast('Executing…', { kind: 'info' });
            const tx = await dao.execute(proposalId);
            await tx.wait();
            toast('Executed', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Execute failed', { kind: 'err' }); }
    }

    async _daoCancel(proposalId) {
        try {
            const signer = await this._ensureSignerOrConnect();
            const daoAddr = this.v3?.tipping?.daoContract;
            const dao = new window.ethers.Contract(daoAddr, ['function cancel(uint256)'], signer);
            toast('Cancelling…', { kind: 'info' });
            const tx = await dao.cancel(proposalId);
            await tx.wait();
            toast('Cancelled', { kind: 'ok' });
            await this._v3RefreshAndRerender({ expectChange: true });
        } catch (err) { toast(err.reason || err.message || 'Cancel failed', { kind: 'err' }); }
    }

    async _updateQuote() {
        const root = this.root;
        const input = root?.querySelector('[data-amount]');
        const out = root?.querySelector('[data-quote-val]');
        if (!input || !out) return;
        const amt = parseFloat(input.value || 0);
        const price = _priceOf(this.token) || 0;
        const sym = (this.token?.symbol || 'TOKEN').toUpperCase();
        if (!amt || !price) {
            out.textContent = this.direction === 'buy' ? `≈ 0.00 ${sym}` : '≈ 0.00 USDC';
            return;
        }
        if (this.direction === 'buy') {
            const tokens = amt / price;
            out.textContent = `≈ ${_fmtNumShort(tokens)} ${sym}`;
        } else {
            const usdc = amt * price;
            out.textContent = `≈ $${_fmtNumShort(usdc)} USDC`;
        }
    }

    async _tokenBalance() {
        try {
            const bi = window.DexHeroBlockchain;
            if (!bi?.getTokenBalance) return 0;
            const addr = this.token.manager_address || this.token.contract_address;
            const userAddr = bi.userAddress || wallet.getStatus().address;
            if (!addr || !userAddr) return 0;
            return parseFloat(await bi.getTokenBalance(addr, userAddr)) || 0;
        } catch { return 0; }
    }

    async _submit() {
        const root = this.root;
        const btn = root?.querySelector('[data-submit]');
        const input = root?.querySelector('[data-amount]');
        const amount = parseFloat(input?.value || 0);

        if (!wallet.isConnected()) {
            try { await wallet.connect(); this.rerender(); this._wire(); this._wireTabs(); this._paintGamesList(); return; }
            catch (err) { toast(err.message || 'Connect failed', { kind: 'err' }); return; }
        }
        if (!amount || amount <= 0) { toast('Enter an amount', { kind: 'err' }); return; }

        const bi = window.DexHeroBlockchain;
        if (!bi) { toast('Blockchain module not loaded', { kind: 'err' }); return; }

        const addr = this.token.manager_address || this.token.contract_address;
        const router = this.token.router_address || this.token.metadata?.router_address || null;

        if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

        try {
            if (this.direction === 'buy') {
                // V2 first, fallback V1
                try {
                    const r = await bi.buyWithUSDC(amount, addr, router);
                    if (r?.success) {
                        const tokensOut = r.tokensReceived || (amount / (_priceOf(this.token) || 1));
                        toast(`Bought ${_fmtNumShort(tokensOut)} ${this.token.symbol}`, { kind: 'ok', ttl: 5000 });
                        // Paint the candle instantly — don't wait for indexer / realtime
                        this._appendChartTrade({
                            price_usdc: r.actualPrice || (amount / tokensOut),
                            amount_usdc: amount,
                            timestamp: new Date().toISOString(),
                            type: 'buy',
                        });
                        return;
                    }
                } catch (e) {
                    if (e?.code === 4001 || /rejected|insufficient/i.test(e?.message || '')) throw e;
                    console.warn('[trade] V2 buy failed, falling back to V1:', e.message);
                }
                const basePrice = parseFloat(this.token.metadata?.base_price || this.token.base_price || 10);
                const qty = Math.floor(amount / basePrice);
                if (qty < 1) { toast(`Min purchase is 1 token (~$${basePrice})`, { kind: 'err', ttl: 5000 }); return; }
                const r = await bi.buyToken(qty, addr);
                if (r?.success) toast(`Bought ${qty} ${this.token.symbol}`, { kind: 'ok', ttl: 5000 });
            } else {
                const r = await bi.sellToken(amount, addr, router);
                if (r?.success) {
                    const usdcOut = r.usdcReceived || (amount * (_priceOf(this.token) || 0));
                    toast(`Sold ${amount} ${this.token.symbol} → $${_fmtNumShort(usdcOut)} USDC`, { kind: 'ok', ttl: 5000 });
                    this._appendChartTrade({
                        price_usdc: r.actualPrice || (usdcOut / amount),
                        amount_usdc: usdcOut,
                        timestamp: new Date().toISOString(),
                        type: 'sell',
                    });
                }
            }
            if (input) input.value = '';
            this._updateQuote();
        } catch (err) {
            console.error('[trade] failed:', err);
            toast(err.message || 'Trade failed', { kind: 'err', ttl: 6000 });
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = this.direction === 'buy' ? 'Buy' : 'Sell'; }
        }
    }

    /* ── Chart ────────────────────────────────────────────── */

    _initChart() {
        const host = this.root?.querySelector('[data-chart-host]');
        if (!host || !window.LightweightCharts) return;
        if (this.chart) return;
        const chart = window.LightweightCharts.createChart(host, {
            width: host.clientWidth,
            height: host.clientHeight,
            layout: {
                background: { type: 'solid', color: 'transparent' },
                textColor: 'rgba(255,255,255,0.55)',
                fontSize: 11,
                fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.035)' },
                horzLines: { color: 'rgba(255,255,255,0.035)' },
            },
            crosshair: {
                mode: window.LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: 'rgba(6,182,212,0.4)', labelBackgroundColor: '#0a0a0e', width: 1 },
                horzLine: { color: 'rgba(6,182,212,0.4)', labelBackgroundColor: '#0a0a0e', width: 1 },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 6,
                barSpacing: 10,
                borderColor: 'rgba(255,255,255,0.06)',
            },
            rightPriceScale: {
                scaleMargins: { top: 0.1, bottom: 0.1 },
                borderColor: 'rgba(255,255,255,0.06)',
            },
        });
        const candle = chart.addCandlestickSeries({
            upColor:        '#22c55e',
            downColor:      '#ef4444',
            borderUpColor:  '#22c55e',
            borderDownColor:'#ef4444',
            wickUpColor:    '#22c55e',
            wickDownColor:  '#ef4444',
            borderVisible: false,
            priceFormat: { type: 'price', precision: 6, minMove: 0.000001 },
        });
        // Crosshair → live OHLC readout
        const ohlcv = this.root?.querySelector('[data-chart-ohlcv]');
        chart.subscribeCrosshairMove((param) => {
            if (!param || !param.time || !ohlcv) { if (ohlcv) ohlcv.classList.remove('visible'); return; }
            const c = param.seriesData.get(candle);
            if (!c) return;
            ohlcv.classList.add('visible');
            ohlcv.querySelector('.o').textContent = _fmtPrice(c.open);
            ohlcv.querySelector('.h').textContent = _fmtPrice(c.high);
            ohlcv.querySelector('.l').textContent = _fmtPrice(c.low);
            ohlcv.querySelector('.c').textContent = _fmtPrice(c.close);
        });

        // Resize with panel
        if (window.ResizeObserver) {
            this._resizeObs = new ResizeObserver(() => {
                if (!this.chart) return;
                this.chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
            });
            this._resizeObs.observe(host);
        }

        this.chart = chart;
        this.candleSeries = candle;
    }

    /** The buy/sell rerender wipes the host DOM; re-attach chart to the fresh node. */
    _reattachChartContainer() {
        this._disposeChart();
        this._initChart();
        this._renderChartData();
    }

    async _loadChartData() {
        const host = this.root?.querySelector('[data-chart-host]');
        const spin = this.root?.querySelector('[data-chart-spinner]');
        const bi = window.DexHeroBlockchain;
        if (!bi?.getTradeHistory) {
            if (spin) spin.innerHTML = `<div>Live chart unavailable</div>`;
            return;
        }
        if (spin) spin.style.display = 'flex';
        try {
            const addr = this.token.manager_address || this.token.contract_address;
            const data = await bi.getTradeHistory(addr, this.resolution, this.token.created_at || null, this.token.router_address || null);
            this.chartData = Array.isArray(data) ? data : [];
            this._renderChartData();
        } catch (err) {
            console.warn('[token-detail chart] load failed:', err);
            if (spin) spin.innerHTML = `<div>Chart load failed</div>`;
        }
    }

    _renderChartData() {
        const host = this.root?.querySelector('[data-chart-host]');
        const spin = this.root?.querySelector('[data-chart-spinner]');
        if (!host || !this.candleSeries) return;

        // No trades recorded yet — synthesize a genesis candle from whatever
        // price source is available on the token row.  This guarantees a
        // fresh DexHero always shows at least one candle at its mint price,
        // even if the server-side genesis write never reached Supabase.
        if (!this.chartData.length) {
            const basePrice = _priceOf(this.token);
            if (basePrice) {
                const createdAt = this.token.created_at ? Math.floor(new Date(this.token.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
                const bucket = Math.floor(createdAt / this.resolution) * this.resolution;
                this.chartData = [{
                    time: bucket,
                    open: basePrice,
                    high: basePrice,
                    low: basePrice,
                    close: basePrice,
                }];
            } else {
                if (spin) { spin.innerHTML = `<div>No trades yet</div>`; spin.style.display = 'flex'; }
                return;
            }
        }
        if (spin) spin.style.display = 'none';

        const clean = this.chartData
            .filter((d) => d && d.time && Number.isFinite(d.open))
            .sort((a, b) => a.time - b.time);
        this.candleSeries.setData(clean);

        // Update candle series precision for this token's price range so the
        // y-axis labels and crosshair values show meaningful decimals.
        const last = clean[clean.length - 1];
        if (last && this.candleSeries.applyOptions) {
            const prec = _pricePrecision(last.close);
            this.candleSeries.applyOptions({
                priceFormat: {
                    type: 'price',
                    precision: prec,
                    minMove: Math.pow(10, -prec),
                },
            });
        }

        // Cache latest candle + rewrite header live price
        this._lastCandle = last || null;
        this._updateLivePrice();

        this.chart.timeScale().fitContent();
    }

    /** Paint a single trade onto the chart immediately — zero round-trip
        latency. Called on our own successful buy/sell, and by the Supabase
        realtime subscription for trades from any other user. */
    _appendChartTrade(trade) {
        if (!this.candleSeries) return;
        const price = parseFloat(trade.price_usdc || trade.price || 0);
        if (!price) return;

        const tradeTs = Math.floor(new Date(trade.timestamp || Date.now()).getTime() / 1000);
        const bucket  = Math.floor(tradeTs / this.resolution) * this.resolution;
        const isBuy   = (trade.type || trade.side || 'buy') === 'buy';

        const last = this._lastCandle;
        let next;
        if (last && last.time === bucket) {
            next = {
                time:  bucket,
                open:  last.open,
                high:  Math.max(last.high, price),
                low:   Math.min(last.low,  price),
                close: price,
            };
        } else {
            const openPrice = last ? last.close : price;
            const spread = price * 0.005; // ensure single-trade candle has a visible body
            next = {
                time:  bucket,
                open:  isBuy ? openPrice     : price + spread,
                high:  isBuy ? price + spread: Math.max(openPrice, price + spread),
                low:   isBuy ? Math.min(openPrice, price - spread) : price - spread,
                close: price,
            };
        }

        this.candleSeries.update(next);
        this._lastCandle = next;

        // Rewrite header with scaled precision
        this._updateLivePrice();
    }

    /** Rewrite the header's "Now" price using real chart data — the freshest
        candle wins, then any in-flight last-candle, then the DB fallback. */
    _updateLivePrice() {
        const pEl = this.root?.querySelector('[data-live-price]');
        if (!pEl) return;

        let current = null;
        if (this.chartData && this.chartData.length) {
            current = this.chartData[this.chartData.length - 1];
        }
        if (this._lastCandle && (!current || this._lastCandle.time >= (current.time || 0))) {
            current = this._lastCandle;
        }
        const price = current?.close ?? _priceOf(this.token);
        pEl.textContent = price != null ? '$' + _fmtPrice(price) : '—';
    }

    /** Subscribe to Supabase realtime INSERTs on the `trades` table filtered
        by this token's manager address. Every trade (ours or someone else's)
        triggers an instant chart append — no polling. */
    _subscribeRealtime() {
        this._unsubscribeRealtime();
        const client = window.DexHeroSupabase?.get?.();
        if (!client?.channel) return;
        const mgrAddr = this.token.manager_address || this.token.contract_address;
        if (!mgrAddr) return;

        this._realtimeChannel = client
            .channel('td-trades:' + mgrAddr)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'trades',
                filter: 'manager_address=eq.' + mgrAddr.toLowerCase(),
            }, (payload) => {
                if (payload?.new) this._appendChartTrade(payload.new);
            })
            .subscribe();
    }

    _unsubscribeRealtime() {
        const client = window.DexHeroSupabase?.get?.();
        if (this._realtimeChannel && client?.removeChannel) {
            try { client.removeChannel(this._realtimeChannel); } catch {}
        }
        this._realtimeChannel = null;
    }

    /** Rare-event safety net — a missed realtime push or a stale candle would
        drift forever without this. 60s is infrequent enough to be invisible
        but enough to self-heal. */
    _startBackstop() {
        this._stopBackstop();
        this._backstopTimer = setInterval(() => this._loadChartData(), 60000);
    }
    _stopBackstop() { if (this._backstopTimer) { clearInterval(this._backstopTimer); this._backstopTimer = null; } }

    _disposeChart() {
        try { this._resizeObs?.disconnect(); } catch {}
        this._resizeObs = null;
        try { this.chart?.remove(); } catch {}
        this.chart = null;
        this.candleSeries = null;
    }

    /* ── Migration detection (tipping-point → external DEX) ──
       Runs in the background — the panel renders the native chart first,
       then flips to Gecko if this probe confirms the token has tipped. */

    async _detectMigrationAsync() {
        const t = this.token;
        if (!t) return;
        const bi  = window.DexHeroBlockchain;
        const mgr = t.manager_address || t.contract_address;
        if (!bi?.getHeroDetails || !bi?.isEvmAddress || !mgr || !bi.isEvmAddress(mgr)) return;

        try {
            // Race the RPC against a 5s timeout so a slow node never blocks
            // the UI (we've already rendered the native chart optimistically).
            const d = await Promise.race([
                bi.getHeroDetails(mgr),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);
            if (!d?.poolCreated) return;

            // Token has graduated. Persist + re-render with Gecko iframe.
            this.isMigrated = true;
            if (t.id) {
                fetch('/api/tokens/upsert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: t.id, tipping_point_reached: true }),
                }).catch(() => {});
            }
            // Tear down native-chart resources + render Gecko iframe in their place
            this._stopBackstop();
            this._unsubscribeRealtime();
            this._disposeChart();
            this.rerender();
            this._wire();
            this._wireTabs();
            this._paintGamesList();
            this._wireGeckoFallback();
        } catch (err) {
            // Network / timeout / unsupported chain — silently stay on native chart
        }
    }

    /* ── GeckoTerminal iframe (post-migration / existing tokens) ── */

    _renderGeckoChart() {
        const t = this.token;
        const isExisting = t.launch_type === 'existing' || t.metadata?.launchType === 'existing';
        // For existing-token DexHeros, the address the user scanned (the
        // underlying token's mint / ERC-20 contract) lives in metadata.
        // manager_address is a platform record on Base Sepolia and isn't
        // indexed by GeckoTerminal or DexScreener, so it's a useless lookup.
        const tokenAddr = (isExisting
            ? (t.metadata?.existingTokenAddress || t.metadata?.existingToken)
            : null)
            || t.manager_address
            || t.contract_address
            || '';
        // For existing-token DexHeros, the row's chain/metadata.blockchain
        // fields describe the MANAGER contract's chain (Base Sepolia),
        // not the underlying token's native chain. GeckoTerminal indexes
        // the underlying token, so derive its chain from the scanned
        // address format itself: `0x…` → EVM, otherwise → Solana base58.
        // For new-token DexHeros, the manager contract IS the token, so
        // the row's chain field is correct.
        const chainRaw = isExisting
            ? (/^0x[a-fA-F0-9]{40}$/.test(tokenAddr) ? 'ethereum' : 'solana')
            : (t.metadata?.blockchain || t.chain || 'ethereum');
        const geckoChain    = GECKO_CHAIN_MAP[chainRaw]       || 'eth';
        const screenerChain = DEXSCREENER_CHAIN_MAP[chainRaw] || 'ethereum';

        // Prefer GeckoTerminal's /tokens/{addr} endpoint when we only have
        // a token address — it auto-renders the deepest-liquidity pool, so
        // we don't need to pre-resolve a pair address before painting the
        // iframe. If _wireGeckoFallback later resolves a specific pool, it
        // swaps the iframe to /pools/{poolAddr} for a stable view.
        // Param names match GeckoTerminal's documented embed widget:
        // swaps=0 hides the transactions panel (giving the chart full
        // height instead of a 50/50 split), info=0 hides the token info
        // pane, light_chart=0 forces dark mode, resolution=1d default.
        const geckoQuery = 'embed=1&info=0&swaps=0&light_chart=0&resolution=1d';
        const geckoUrl = this._bestPoolAddr
            ? `https://www.geckoterminal.com/${encodeURIComponent(geckoChain)}/pools/${encodeURIComponent(this._bestPoolAddr)}?${geckoQuery}`
            : `https://www.geckoterminal.com/${encodeURIComponent(geckoChain)}/tokens/${encodeURIComponent(tokenAddr)}?${geckoQuery}`;
        // DexScreener's embed only accepts pair addresses, so the toggle
        // button stays disabled until we have one.
        const screenerUrl = this._bestPoolAddr
            ? `https://dexscreener.com/${encodeURIComponent(screenerChain)}/${encodeURIComponent(this._bestPoolAddr)}?embed=1&theme=dark&info=0`
            : '';
        const screenerPage = `https://dexscreener.com/${encodeURIComponent(screenerChain)}/${encodeURIComponent(this._bestPoolAddr || tokenAddr)}`;

        return `
            <div class="td-chart td-chart--external" data-gecko-host>
                <div class="td-chart__spinner" data-gecko-spin><div class="hud-spin"></div><div>Loading DEX pool</div></div>
                <iframe
                    class="td-gecko-frame"
                    data-gecko-frame
                    src="${geckoUrl}"
                    data-screener-url="${screenerUrl}"
                    title="${escapeHTML((t.name || 'Pool') + ' — GeckoTerminal')}"
                    allow="clipboard-write"
                    sandbox="allow-same-origin allow-scripts allow-popups"
                    allowfullscreen
                    style="width:100%;height:100%;border:0;display:block;"
                ></iframe>
            </div>
            <div class="td-gecko-footer" style="display:flex;gap:10px;align-items:center;font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-3);margin:-6px 0 14px;">
                <span>LIVE POOL</span>
                <button class="hud-btn hud-btn--sm" data-gecko-switch>DexScreener</button>
                <a class="hud-btn hud-btn--sm hud-btn--ghost" href="${screenerPage}" target="_blank" rel="noopener">Open full</a>
            </div>
        `;
    }

    async _wireGeckoFallback() {
        // The iframe's already painting via GeckoTerminal's /tokens/{addr}
        // endpoint (which auto-picks the deepest pool). This pass uses
        // DexScreener's API to (a) enable the "DexScreener" toggle by
        // resolving a pair address it accepts, and (b) pipe the live USD
        // price into the header. Failure here is non-fatal — the chart
        // already works.
        const isExisting = this.token.launch_type === 'existing'
                        || this.token.metadata?.launchType === 'existing';
        const addr = (isExisting
            ? (this.token.metadata?.existingTokenAddress || this.token.metadata?.existingToken)
            : null)
            || this.token.manager_address
            || this.token.contract_address;
        if (!addr) return;

        const frame = this.root?.querySelector('[data-gecko-frame]');
        const spin  = this.root?.querySelector('[data-gecko-spin]');
        if (frame) {
            frame.addEventListener('load', () => {
                if (spin) spin.style.display = 'none';
            }, { signal: this.signal });
        }

        // Swap button → DexScreener (only enabled once we've resolved a pair).
        this.root?.querySelector('[data-gecko-switch]')?.addEventListener('click', () => {
            const f = this.root.querySelector('[data-gecko-frame]');
            const ds = f?.getAttribute('data-screener-url');
            if (f && ds) { if (spin) spin.style.display = 'flex'; f.src = ds; }
        }, { signal: this.signal });

        try {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`, { signal: this.signal });
            if (!res.ok) return;
            const data = await res.json();
            const pairs = (data?.pairs || []).filter((p) => p && p.pairAddress);
            if (!pairs.length) return;
            // Highest-liquidity pair
            pairs.sort((a, b) => (parseFloat(b.liquidity?.usd || 0)) - (parseFloat(a.liquidity?.usd || 0)));
            const best = pairs[0];
            this._bestPoolAddr = best.pairAddress;
            // We do NOT swap the iframe src here. GeckoTerminal's /tokens/
            // endpoint already 307-redirects to /pools/{deepestPoolAddr},
            // so the chart is correct. Swapping post-load was racing with
            // the iframe's load lifecycle and leaving the chart blank.
            // What this block IS still useful for: enabling the
            // DexScreener toggle button (needs a pair address) and piping
            // the live USD price into the header.
            const isExisting = this.token.launch_type === 'existing'
                            || this.token.metadata?.launchType === 'existing';
            const chainRaw = best.chainId
                || (isExisting
                    ? (/^0x[a-fA-F0-9]{40}$/.test(addr) ? 'ethereum' : 'solana')
                    : (this.token.metadata?.blockchain || this.token.chain || 'ethereum'));
            const screenerChain = DEXSCREENER_CHAIN_MAP[chainRaw] || 'ethereum';
            const newScreener = `https://dexscreener.com/${encodeURIComponent(screenerChain)}/${encodeURIComponent(best.pairAddress)}?embed=1&theme=dark&info=0`;
            if (frame) frame.setAttribute('data-screener-url', newScreener);
            // Opportunistically pipe live stats from the pair into the header.
            if (best.priceUsd) {
                const pEl = this.root?.querySelector('[data-live-price]');
                if (pEl) pEl.textContent = '$' + _fmtPrice(parseFloat(best.priceUsd));
            }
        } catch (err) {
            if (err.name !== 'AbortError') console.warn('[gecko] best-pair fetch failed:', err.message);
        }
    }

    /* ── Resolve (address or UUID → token row) ─────────────── */

    async _resolve() {
        const ident = this.ident;
        if (!ident) { this.loadState = 'not-found'; return; }
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ident);

        try {
            const client = await sb.ready();

            if (isUUID) {
                let r = await client.from('models').select('*').eq('id', ident).maybeSingle();
                if (r?.data) { this.token = _mapModel(r.data); await this._joinSprite(client); this.loadState = 'ready'; return; }
                r = await client.from('tokens').select('*').eq('id', ident).maybeSingle();
                if (r?.data) { this.token = _normalizeMetadata(r.data); this.loadState = 'ready'; return; }
                this.loadState = 'not-found'; return;
            }

            const lower = ident.toLowerCase();
            let r = await client.from('models').select('*').or(`evm_contract_address.eq.${ident},evm_contract_address.eq.${lower}`).limit(1).maybeSingle();
            if (r?.data) { this.token = _mapModel(r.data); await this._joinSprite(client); this.loadState = 'ready'; return; }
            r = await client.from('tokens').select('*').or(`manager_address.eq.${ident},manager_address.eq.${lower}`).limit(1).maybeSingle();
            if (r?.data) { this.token = _normalizeMetadata(r.data); this.loadState = 'ready'; return; }
            r = await client.from('tokens').select('*').or(`contract_address.eq.${ident},contract_address.eq.${lower}`).limit(1).maybeSingle();
            if (r?.data) { this.token = _normalizeMetadata(r.data); this.loadState = 'ready'; return; }

            this.loadState = 'not-found';
        } catch (err) {
            console.warn('[token-detail] resolve failed:', err);
            this.loadState = 'error';
            this.errorMsg = err.message || String(err);
        }
    }

    async _joinSprite(client) {
        if (!this.token?.token_id) return;
        try {
            const r = await client.from('tokens').select('sprite_url, sprite_frame_count, sprite_status, model_url, price_usdc, purchase_price_usdc').eq('id', this.token.token_id).maybeSingle();
            if (r?.data) Object.assign(this.token, r.data);
        } catch {}
    }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function _mapModel(m) {
    return {
        id: m.id,
        name: m.name,
        symbol: m.symbol || (m.description ? m.description.substring(0, 4).toUpperCase() : 'HERO'),
        description: m.description,
        image_url: m.thumbnail_url,
        thumbnail_url: m.thumbnail_url,
        model_url: m.model_url,
        chain: (m.blockchain === 'solana') ? 'solana' : 'sepolia',
        contract_address: m.evm_contract_address,
        manager_address: null,
        creator_wallet: 'Unknown',
        created_at: m.created_at,
        rental_price: m.rental_price_usd || 0.1,
        games_count: m.games_count || 0,
        players_count: m.players_count || 0,
        token_id: m.token_id || null,
    };
}

function _priceOf(t) {
    if (!t) return null;
    const v = t.price_usdc ?? t.purchase_price_usdc ?? t.rental_price_usdc ?? t.base_price ?? t.rental_price ?? null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** The DexHero's mint / launch price — what someone originally paid to mint
    or fully purchase this token. Distinct from _priceOf which prefers the
    live market price after trading begins. */
function _mintPriceOf(t) {
    if (!t) return null;
    const v = t.purchase_price_usdc ?? t.metadata?.base_price ?? t.base_price ?? null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Scale the displayed decimal precision to the price magnitude so a $0.000012
    token shows meaningful digits while a $1,234 token isn't a wall of zeros. */
function _pricePrecision(p) {
    const n = Math.abs(p) || 0;
    if (n < 1e-6)  return 12;
    if (n < 1e-4)  return 10;
    if (n < 1e-2)  return 8;
    if (n < 1)     return 6;
    if (n < 100)   return 4;
    return 2;
}

function _fmtPrice(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const prec = _pricePrecision(n);
    // Keep precision as the upper bound so micro-cap tokens still show
    // meaningful digits, but drop trailing zeros so $100.00 reads as $100
    // and $0.000100 reads as $0.0001 instead of a wall of zeros.
    return n.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: prec });
}

function _fmtNumShort(n) {
    if (n == null || !Number.isFinite(n)) return '0';
    if (Math.abs(n) >= 1000) return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
    return Number(n).toLocaleString('en', { maximumFractionDigits: 4 });
}

function _metaCell(label, val) {
    return `
        <div class="td-meta__item">
            <span class="td-meta__label">${escapeHTML(label)}</span>
            <span class="td-meta__val">${escapeHTML(val)}</span>
        </div>`;
}

function _migratedFromMeta(t) {
    if (!t) return false;
    if (t.launch_type === 'existing' || t.metadata?.launchType === 'existing') return true;
    if (t.tipping_point_reached === true || t.metadata?.tippingPointReached === true) return true;
    return false;
}

// Legacy rows wrote `metadata` via JSON.stringify, so PostgREST returns it as
// a JSON-string leaf instead of a parsed object. Without this, every
// `t.metadata?.existingTokenAddress` read silently yields undefined and the
// chart falls back to manager_address (wrong chain → blank Gecko iframe).
function _normalizeMetadata(row) {
    if (row && typeof row.metadata === 'string') {
        try { row.metadata = JSON.parse(row.metadata); } catch { row.metadata = {}; }
    }
    // V3 marker — present when this row was created via FactoryV3 and indexed
    // by the deploy handler. Used everywhere to gate the V3 UI sections.
    if (row) row.is_v3 = !!row.v3_dexhero_id;
    return row;
}

/* ── V3 helpers ─────────────────────────────────────────────────────── */

// True when ethers.js is loaded on the page (it's injected globally by
// js/blockchain-integration.js — the V2 code path already depends on it).
function _hasEthers() {
    return !!(typeof window !== 'undefined' && window.ethers);
}

// Read-only provider for on-chain view calls when no wallet is connected.
// Falls back to the wallet provider when available so we don't burn a
// separate RPC quota.
function _readProvider() {
    if (typeof window === 'undefined' || !window.ethers) return null;
    if (window.__readProvider__) return window.__readProvider__;
    try {
        const url = window.__SEPOLIA_RPC__ || 'https://ethereum-sepolia-rpc.publicnode.com';
        window.__readProvider__ = new window.ethers.providers.JsonRpcProvider(url, { name: 'sepolia', chainId: 11155111 });
        return window.__readProvider__;
    } catch { return null; }
}

// Map a token's chain field to the slug chart-or-progress expects. Mirrors
// GECKO_CHAIN_MAP near the top of this file but exposed as a helper for the
// _chartState() builder.
function _chainForChart(t) {
    const ch = (t.chain || t.network || 'ethereum').toLowerCase();
    return ch === 'sepolia' ? 'sepolia' : (GECKO_CHAIN_MAP[ch] || ch);
}

// Format a uint256 string with `decimals` decimal places, trimming trailing
// zeros for display ("12.500000" → "12.5", "1000000" / 1e6 → "1"). Safe for
// arbitrary-size strings because we don't convert through Number().
function _fmtUnits(raw, decimals = 6) {
    try {
        const s = String(raw ?? '0');
        if (s === '0') return '0';
        if (s.length <= decimals) {
            const pad = '0'.repeat(decimals - s.length);
            const frac = (pad + s).replace(/0+$/, '');
            return frac ? `0.${frac}` : '0';
        }
        const whole = s.slice(0, s.length - decimals);
        const frac = s.slice(s.length - decimals).replace(/0+$/, '');
        return frac ? `${whole}.${frac}` : whole;
    } catch { return '0'; }
}

// Compact USD amount: $1,234 or $1.23M. Used in attribute strips so the
// numbers don't take over the layout.
function _fmtUsdCompact(rawUsdc6) {
    const n = Number(_fmtUnits(rawUsdc6, 6));
    if (!Number.isFinite(n)) return '$0';
    if (Math.abs(n) >= 1000) return '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
    return '$' + n.toLocaleString('en', { maximumFractionDigits: 2 });
}

// EIP-3085 wallet_addEthereumChain payload by chainId. Only chains we
// actually deploy V3 to are listed; expand if the chain map grows.
function _chainAddParams(chainId) {
    const M = {
        11155111: {
            chainId: '0xaa36a7',
            chainName: 'Sepolia',
            nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
        },
        84532: {
            chainId: '0x14a34',
            chainName: 'Base Sepolia',
            nativeCurrency: { name: 'Base Sepolia ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://base-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: ['https://sepolia.basescan.org'],
        },
        8453: {
            chainId: '0x2105',
            chainName: 'Base',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
        },
    };
    return M[chainId] || null;
}

// Compact "Xh Ym" / "Xd Yh" remaining-time string for the mint-price timelock.
function _fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// DAO ProposalKind enum mirror (must match DexHeroDAO.sol).
const PROPOSAL_KINDS = [
    'APPROVE_GAME_LINK',
    'REJECT_GAME_LINK',
    'REMOVE_GAME',
    'UPDATE_METADATA',
    'SET_MINT_PRICE',
    'BURN_TREASURY_TOKENS',
    'TRANSFER_TREASURY_TOKENS',
    'TRANSFER_TREASURY_USDC',
    'REFILL_LP',
    'RE_CENTRALIZE',
];

function _proposalState(p, nowSec = Math.floor(Date.now() / 1000)) {
    if (p.cancelled) return 'Cancelled';
    if (p.executed)  return 'Executed';
    if (p.queuedAt > 0) {
        const timelock = p.kind === 9 /* RE_CENTRALIZE */ ? 7 * 86400 : 48 * 3600;
        return nowSec >= (p.queuedAt + timelock) ? 'Ready' : 'Queued';
    }
    if (nowSec < p.voteEnd) return 'Active';
    const total = BigInt(p.yesVotes) + BigInt(p.noVotes);
    if (total === 0n) return 'Defeated';
    return BigInt(p.yesVotes) > BigInt(p.noVotes) ? 'Succeeded' : 'Defeated';
}

const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
