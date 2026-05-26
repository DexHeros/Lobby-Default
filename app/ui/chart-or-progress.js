// app/ui/chart-or-progress.js
//
// UX-Chart-1: a single component that renders the right "price view" for a
// DexHero, depending on its phase:
//
//   1. Existing-token-path DexHero (creator linked to an already-traded token):
//      → embed GeckoTerminal for the bound token's existing pool.
//
//   2. New-launch DexHero, PRE-tipping (no Uniswap V3 pool yet):
//      → render a MintProgress block: "X / Y NFTs minted, $Z USDC raised,
//        trading unlocks at tipping". No chart — there's no DEX pool to
//        chart against.
//
//   3. New-launch DexHero, POST-tipping (pool created at tipping):
//      → embed GeckoTerminal for the freshly-created Uniswap V3 pool.
//
// All consumers (token-detail.js, market.js, play.js, game-dashboard.js)
// MUST route price visualization through this component. The audit
// (UX-Chart-1) flagged ad-hoc Router-spot-price renderings as misleading
// — once tipping has happened, GeckoTerminal is the only legitimate
// price source.
//
// Inputs (all optional; the component decides phase from what's set):
//   {
//     // existing-token path:
//     existingPool: { network: 'eth' | 'base' | 'monad' | …, address: '0x…' }
//
//     // new-launch path (mutually exclusive with existingPool):
//     launchpad: {
//       totalRaisedUSDC:   <BigInt | string | number>,
//       tippingPointUSDC:  <BigInt | string | number>,
//       mintPriceUSDC:     <BigInt | string | number>,
//       nftsMinted:        <number>,
//       v3Pool:            { network, address } | null   // null pre-tipping
//     }
//   }
//
// Output: an HTMLElement the caller can drop into the DOM. Idempotent —
// callers can call render() many times with updated state and the same
// element is mutated in place.

const GECKO_BASE = 'https://www.geckoterminal.com';

const NETWORK_SLUGS = {
    eth: 'eth',
    ethereum: 'eth',
    'base': 'base',
    base: 'base',
    'base-sepolia': 'base',
    sepolia: 'eth',
    monad: 'monad-testnet',
    'monad-testnet': 'monad-testnet',
    bsc: 'bsc',
    polygon: 'polygon_pos',
};

function geckoEmbedUrl({ network, address }) {
    const slug = NETWORK_SLUGS[network] || network;
    return `${GECKO_BASE}/${slug}/pools/${address}?embed=1&info=0&swaps=0`;
}

function fmtUsdc(raw) {
    // raw is USDC in 6-decimal units (BigInt or string-of-int or plain int).
    let v;
    try {
        v = typeof raw === 'bigint' ? raw : BigInt(String(raw ?? 0));
    } catch { v = 0n; }
    const whole = v / 1_000_000n;
    return `$${whole.toLocaleString('en-US')}`;
}

function calcPercent(raised, target) {
    try {
        const r = typeof raised === 'bigint' ? raised : BigInt(String(raised ?? 0));
        const t = typeof target === 'bigint' ? target : BigInt(String(target ?? 0));
        if (t === 0n) return 0;
        const bps = Number((r * 10000n) / t);
        return Math.min(100, Math.max(0, bps / 100));
    } catch { return 0; }
}

function div(cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    return el;
}

function renderGeckoEmbed(host, pool) {
    host.innerHTML = '';
    host.classList.add('chart-gecko');
    const iframe = document.createElement('iframe');
    iframe.title = 'GeckoTerminal pool chart';
    iframe.src = geckoEmbedUrl(pool);
    iframe.loading = 'lazy';
    iframe.allow = '';
    iframe.referrerPolicy = 'no-referrer';
    iframe.style.cssText = 'width:100%;height:clamp(280px, 60vh, 480px);border:0;background:transparent;display:block;';
    host.appendChild(iframe);
}

function renderMintProgress(host, lp) {
    host.innerHTML = '';
    host.classList.add('chart-progress');

    const required = (() => {
        try {
            const tip = BigInt(String(lp.tippingPointUSDC ?? 0));
            const mp  = BigInt(String(lp.mintPriceUSDC ?? 0));
            return mp > 0n ? Number(tip / mp) : 0;
        } catch { return 0; }
    })();
    const minted = Number(lp.nftsMinted ?? 0);
    const pct = calcPercent(lp.totalRaisedUSDC, lp.tippingPointUSDC);

    const heading = document.createElement('div');
    heading.className = 'chart-progress-heading';
    heading.textContent = 'Funding the launch';
    heading.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:8px;';

    const sub = document.createElement('div');
    sub.className = 'chart-progress-sub';
    sub.textContent = 'Trading unlocks once enough DexHero NFTs are minted to seed Uniswap V3 liquidity.';
    sub.style.cssText = 'font-size:12px;opacity:0.8;margin-bottom:16px;';

    const bar = div('chart-progress-bar');
    bar.style.cssText = 'position:relative;height:14px;background:rgba(255,255,255,0.08);border-radius:7px;overflow:hidden;margin-bottom:10px;';
    const fill = div('chart-progress-fill');
    fill.style.cssText = `position:absolute;inset:0 auto 0 0;width:${pct.toFixed(2)}%;background:linear-gradient(90deg,#7c3aed,#22d3ee);border-radius:7px;`;
    bar.appendChild(fill);

    const stats = div('chart-progress-stats');
    stats.style.cssText = 'display:flex;justify-content:space-between;font-size:12px;';
    stats.innerHTML = `
        <span><strong>${minted.toLocaleString('en-US')}</strong> / ${required.toLocaleString('en-US')} NFTs minted</span>
        <span>${fmtUsdc(lp.totalRaisedUSDC)} / ${fmtUsdc(lp.tippingPointUSDC)} raised (${pct.toFixed(1)}%)</span>
    `;

    host.appendChild(heading);
    host.appendChild(sub);
    host.appendChild(bar);
    host.appendChild(stats);
}

/**
 * Pick a phase from the input state; one of:
 *   - 'existing'     : existingPool is set
 *   - 'post-tipping' : launchpad.v3Pool is set
 *   - 'pre-tipping'  : launchpad with no v3Pool
 *   - 'idle'         : neither — caller hasn't loaded data yet
 */
export function resolvePhase(state) {
    if (state?.existingPool?.address) return 'existing';
    if (state?.launchpad?.v3Pool?.address) return 'post-tipping';
    if (state?.launchpad) return 'pre-tipping';
    return 'idle';
}

/**
 * Create or update a chart-or-progress block.
 *
 * @param {HTMLElement} host  Existing DOM element to render into.
 * @param {object}      state See top-of-file shape.
 */
export function renderChartOrProgress(host, state = {}) {
    const phase = resolvePhase(state);
    host.dataset.phase = phase;
    host.classList.remove('chart-gecko', 'chart-progress');
    if (phase === 'existing') {
        renderGeckoEmbed(host, state.existingPool);
    } else if (phase === 'post-tipping') {
        renderGeckoEmbed(host, state.launchpad.v3Pool);
    } else if (phase === 'pre-tipping') {
        renderMintProgress(host, state.launchpad);
    } else {
        host.innerHTML = '<div style="font-size:12px;opacity:0.6;">Loading price view…</div>';
    }
    return host;
}

/**
 * Convenience constructor — creates a fresh element pre-rendered.
 */
export function chartOrProgress(state = {}) {
    const host = div('chart-or-progress');
    renderChartOrProgress(host, state);
    return host;
}
