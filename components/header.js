// ── Wallet pre-init for legacy /pages/*.html (runs synchronously before any
//    other code in this file reads sessionStorage). Hard-refresh ONLY clears
//    state; navigation between pages preserves the wallet connection.
//    Sister code: js/wallet-pre-init.js + app/services/wallet.js init().
//    Detection is URL-marker based (independent of performance.navigation
//    reporting, which Phantom + some Chromium versions get wrong on F5).
(function _walletPreInit() {
    // Skip in iframe contexts entirely. /pages/*.html is loaded as an iframe
    // inside the lobby shell and same-origin iframes share sessionStorage
    // with the top window. If the iframe ran refresh detection it would
    // (a) write its own URL into the shared marker, polluting top's check,
    // and (b) read its own earlier marker on a second visit and falsely
    // detect a refresh. Refresh detection lives ONLY at the top window.
    if (window.top !== window) return;

    var MARKER_KEY = 'dexhero_page_marker';
    var MAX_AGE_MS = 60 * 60 * 1000;

    function detectRefresh() {
        var prev = null;
        try {
            var raw = sessionStorage.getItem(MARKER_KEY);
            if (raw) prev = JSON.parse(raw);
        } catch (_) {}
        var currentUrl = location.pathname;
        var now = Date.now();
        var isRefresh = !!(prev && prev.url === currentUrl && (now - prev.t) < MAX_AGE_MS);
        try {
            sessionStorage.setItem(MARKER_KEY, JSON.stringify({ url: currentUrl, t: now }));
        } catch (_) {}
        return isRefresh;
    }

    if (!detectRefresh()) return;  // Navigation/fresh-load → preserve session

    // Hard refresh path
    try {
        sessionStorage.removeItem('walletConnected');
        sessionStorage.removeItem('walletAddress');
        sessionStorage.removeItem('walletChain');
        sessionStorage.removeItem('walletType');
        sessionStorage.removeItem('dexhero_wallet_base');
    } catch (_) {}
    try { localStorage.removeItem('dexhero_wallet_base'); } catch (_) {}
    try { sessionStorage.setItem('dexhero_force_fresh', '1'); } catch (_) {}
    try { window.__dexheroForceFresh = true; } catch (_) {}

    function disconnectProvider(p) {
        if (!p || typeof p.request !== 'function') return;
        try {
            var revokePromise = p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
            if (revokePromise && typeof revokePromise.catch === 'function') revokePromise.catch(function () {});
        } catch (_) {}
        if (typeof p.disconnect === 'function') {
            try {
                var dp = p.disconnect();
                if (dp && typeof dp.catch === 'function') dp.catch(function () {});
            } catch (_) {}
        }
    }
    function disconnectAll() {
        try {
            if (window.ethereum) {
                disconnectProvider(window.ethereum);
                if (Array.isArray(window.ethereum.providers)) window.ethereum.providers.forEach(disconnectProvider);
            }
            if (window.phantom && window.phantom.ethereum) disconnectProvider(window.phantom.ethereum);
        } catch (_) {}
    }
    disconnectAll();
    try { setTimeout(disconnectAll, 0); } catch (_) {}
    try { setTimeout(disconnectAll, 200); } catch (_) {}
    try {
        window.addEventListener('eip6963:announceProvider', function (e) {
            var detail = e && e.detail;
            if (detail && detail.provider) disconnectProvider(detail.provider);
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (_) {}

    if (typeof console !== 'undefined' && console.log) {
        console.log('[dexhero-wallet] pre-init (header.js): refresh detected (URL marker) — cleared session + disconnected all providers');
    }
})();

// ── Silent reconnect for legacy pages (MOBILE ONLY) ────────────────────────
// If sessionStorage has no wallet record but the user is on mobile inside a
// wallet's in-app browser AND the dapp is already authorized for this origin
// (eth_accounts returns a non-empty array silently), rehydrate the legacy
// session keys + dispatch walletChanged so listeners pick it up.
//
// Desktop intentionally skips this: the user is required to click Connect
// explicitly, no silent auto-connect from a long-lived prior authorization.
//
// Sister code: app/services/wallet.js init() does the same for the SPA path.
(function _walletSilentReconnect() {
    if (window.top !== window) return;  // iframes inherit state from parent

    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    if (!isMobile) return;

    try { if (sessionStorage.getItem('dexhero_force_fresh') === '1') return; } catch (_) {}
    try { if (sessionStorage.getItem('walletConnected') === 'true') return; } catch (_) {}

    if (!window.ethereum || typeof window.ethereum.request !== 'function') return;

    var p = null;
    try { p = window.ethereum.request({ method: 'eth_accounts' }); } catch (_) { return; }
    if (!p || typeof p.then !== 'function') return;

    p.then(function (accounts) {
        if (!Array.isArray(accounts) || !accounts.length || !accounts[0]) return;
        var addr = String(accounts[0]).toLowerCase();
        var t = window.ethereum.isPhantom ? 'phantom'
              : window.ethereum.isMetaMask ? 'metamask'
              : window.ethereum.isCoinbaseWallet ? 'coinbase'
              : 'evm';
        try {
            sessionStorage.setItem('walletConnected', 'true');
            sessionStorage.setItem('walletAddress', addr);
            sessionStorage.setItem('walletChain', 'evm');
            sessionStorage.setItem('walletType', t);
            sessionStorage.setItem('dexhero_wallet_base', JSON.stringify({ chain: 'evm', address: addr }));
        } catch (_) {}

        try { window.DexHeroBlockchain = window.DexHeroBlockchain || {}; window.DexHeroBlockchain.userAddress = addr; } catch (_) {}
        try {
            if (window.UnifiedWallet) {
                window.UnifiedWallet.evmAddress = addr;
                window.UnifiedWallet.connectedAddress = addr;
                window.UnifiedWallet.evmWallet = window.ethereum;
            }
        } catch (_) {}

        try {
            window.dispatchEvent(new CustomEvent('walletChanged', { detail: { connected: true, address: addr } }));
            window.dispatchEvent(new CustomEvent('walletAccountChanged', { detail: { address: addr } }));
        } catch (_) {}

        if (typeof console !== 'undefined' && console.log) {
            console.log('[dexhero-wallet] silent reconnect (header.js): rehydrated', addr);
        }
    }).catch(function () {});
})();

// Shared Header Component
function createHeader() {
    return `
    <!-- Ticker Marquee -->
    <div class="ticker-container">
        <div class="ticker-content" id="ticker-marquee">
            <div class="ticker-item"><span class="ticker-rank">#1</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">HERO</span><span class="ticker-change positive">+4.2%</span><span class="ticker-address">0x1a2b...3c4d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#2</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">NOVA</span><span class="ticker-change negative">-1.8%</span><span class="ticker-address">0x5e6f...7a8b</span></div>
            <div class="ticker-item"><span class="ticker-rank">#3</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">APEX</span><span class="ticker-change positive">+7.1%</span><span class="ticker-address">0x9c0d...1e2f</span></div>
            <div class="ticker-item"><span class="ticker-rank">#4</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">VOID</span><span class="ticker-change negative">-0.5%</span><span class="ticker-address">0x3a4b...5c6d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#5</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">FLUX</span><span class="ticker-change positive">+2.9%</span><span class="ticker-address">0x7e8f...9a0b</span></div>
            <div class="ticker-item"><span class="ticker-rank">#6</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">ZION</span><span class="ticker-change positive">+11.3%</span><span class="ticker-address">0x1c2d...3e4f</span></div>
            <div class="ticker-item"><span class="ticker-rank">#7</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">RIFT</span><span class="ticker-change negative">-3.4%</span><span class="ticker-address">0x5a6b...7c8d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#8</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">GAME</span><span class="ticker-change positive">+0.8%</span><span class="ticker-address">0x9e0f...1a2b</span></div>
            <div class="ticker-item"><span class="ticker-rank">#1</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">HERO</span><span class="ticker-change positive">+4.2%</span><span class="ticker-address">0x1a2b...3c4d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#2</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">NOVA</span><span class="ticker-change negative">-1.8%</span><span class="ticker-address">0x5e6f...7a8b</span></div>
            <div class="ticker-item"><span class="ticker-rank">#3</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">APEX</span><span class="ticker-change positive">+7.1%</span><span class="ticker-address">0x9c0d...1e2f</span></div>
            <div class="ticker-item"><span class="ticker-rank">#4</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">VOID</span><span class="ticker-change negative">-0.5%</span><span class="ticker-address">0x3a4b...5c6d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#5</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">FLUX</span><span class="ticker-change positive">+2.9%</span><span class="ticker-address">0x7e8f...9a0b</span></div>
            <div class="ticker-item"><span class="ticker-rank">#6</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">ZION</span><span class="ticker-change positive">+11.3%</span><span class="ticker-address">0x1c2d...3e4f</span></div>
            <div class="ticker-item"><span class="ticker-rank">#7</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">RIFT</span><span class="ticker-change negative">-3.4%</span><span class="ticker-address">0x5a6b...7c8d</span></div>
            <div class="ticker-item"><span class="ticker-rank">#8</span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E" class="ticker-icon"><span class="ticker-name">GAME</span><span class="ticker-change positive">+0.8%</span><span class="ticker-address">0x9e0f...1a2b</span></div>
        </div>
    </div>

    <!-- Header -->
    <header class="header">
        <div class="header-left">
            <a href="/" class="logo">
                <img src="/dexhero-logo.png" alt="DexHero" class="logo-icon" style="width: 32px; height: 32px; border-radius: 50%;">
                <span class="logo-text">DexHero</span>
            </a>
        </div>
        <nav class="nav-menu">
            <div class="nav-item dropdown">
                <span>Platform</span>
                <div class="dropdown-menu">
                    <div class="dropdown-section">
                        <span class="dropdown-title">DexHero Management</span>
                        <a href="/pages/create-index.html">Create</a>
                        <a href="/pages/manage.html">Manage</a>
                        <a href="/pages/add-liquidity.html">Add Liquidity</a>
                    </div>
                    <div class="dropdown-section">
                        <span class="dropdown-title">Marketing</span>
                        <a href="/pages/referrals.html">Referrals</a>
                        <a href="/pages/buy-feature.html">Register Game</a>
                    </div>

                </div>
            </div>
            <div class="nav-item dropdown">
                <span>Trade</span>
                <div class="dropdown-menu">
                    <div class="dropdown-section">
                        <span class="dropdown-title">Market</span>
                        <a href="/pages/all-tokens.html">All DexHeros</a>
                        <a href="/pages/all-games.html">All Games</a>
                    </div>
                </div>
            </div>
            <div class="nav-item dropdown">
                <span>Compute</span>
                <div class="dropdown-menu">
                    <div class="dropdown-section">
                        <span class="dropdown-title">Server Hosting</span>
                        <a href="/pages/node-dashboard.html">Server Dashboard</a>
                        <a href="/pages/node-onboarding.html">Become a Host</a>
                        <a href="/pages/threshold-estimator.html">Earnings Calculator</a>
                    </div>
                    <div class="dropdown-section">
                        <span class="dropdown-title">Project WarpStream</span>
                        <a href="/pages/cloud-gaming.html">How WarpStream Works</a>
                    </div>
                </div>
            </div>
            <div class="nav-item dropdown">
                <span>Resources</span>
                <div class="dropdown-menu">
                    <div class="dropdown-section">
                        <a href="/pages/guides.html">Guides</a>
                        <a href="/pages/api-docs.html">API Docs</a>
                    </div>
                </div>
            </div>
        </nav>
        <div class="header-right">
            <div class="social-links">
                <a href="#" class="social-link" title="Telegram">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                </a>
                <a href="#" class="social-link" title="X (Twitter)">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
                </a>
            </div>
            <a href="/pages/create-index.html" class="btn-create pulse-glow">
                Create
            </a>
            <div id="wallet-connect-wrapper">
                <button class="btn-connect" onclick="openConnectModal()">Connect</button>
            </div>
            <button class="mobile-menu-toggle" onclick="toggleMobileNav()" aria-label="Menu">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="3" y1="6" x2="21" y2="6"/>
                    <line x1="3" y1="12" x2="21" y2="12"/>
                    <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
            </button>
        </div>
    </header>

    <!-- Mobile Navigation Panel -->
    <div class="mobile-nav-overlay" id="mobile-nav-overlay" onclick="closeMobileNav()"></div>
    <div class="mobile-nav-panel" id="mobile-nav-panel">
        <div class="mobile-nav-header">
            <h3>Menu</h3>
            <button class="mobile-nav-close" onclick="closeMobileNav()"></button>
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">DexHero Management</div>
            <a href="/pages/create-index.html">Create DexHero</a>
            <a href="/pages/manage.html" onclick="closeMobileNav();">Manage</a>
            <a href="/pages/add-liquidity.html">Add Liquidity</a>
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">Marketing</div>
            <a href="/pages/referrals.html">Referrals</a>
            <a href="/pages/buy-feature.html">Register Game</a>
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">Market</div>
            <a href="/pages/all-tokens.html">All DexHeros</a>
            <a href="/pages/all-games.html">All Games</a>
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">Resources</div>
            <a href="/pages/guides.html">Guides</a>
            <a href="/pages/api-docs.html">API Docs</a>
        </div>
        <div class="mobile-nav-actions">
            <a href="/pages/create-index.html" class="btn-create pulse-glow">Create DexHero</a>
            <button class="btn-connect" onclick="closeMobileNav(); openConnectModal();">Connect Wallet</button>
        </div>
    </div>
    `;
}

// Update connect button state
async function updateConnectButton() {
    const wrapper = document.getElementById('wallet-connect-wrapper');
    if (!wrapper) return;

    const isConnected = sessionStorage.getItem('walletConnected') === 'true';
    const walletAddress = sessionStorage.getItem('walletAddress');

    if (isConnected) {
        let avatarUrl = null;
        let username = 'Profile';

        // Try to fetch avatar
        if (window.DexHeroSupabase) {
            const supabase = window.DexHeroSupabase.get();
            if (supabase && walletAddress) {
                const { data } = await supabase
                    .from('profiles')
                    .select('avatar_url, username')
                    .eq('wallet_address', walletAddress)
                    .single();

                if (data) {
                    if (data.avatar_url) avatarUrl = data.avatar_url;
                    if (data.username) username = data.username;
                }
            }
        }

        const displayAddress = walletAddress ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}` : 'Connected';
        const avatarImg = avatarUrl
            ? `<img src="${avatarUrl}" style="width: 20px; height: 20px; border-radius: 50%; margin-right: 8px;">`
            : '';

        wrapper.innerHTML = `
            <div class="nav-item dropdown" style="padding: 0; margin: 0;">
                <button class="btn-connect connected" style="display: flex; align-items: center; gap: 6px;">
                    ${avatarImg}
                    <span>${displayAddress}</span>
                </button>
                <div class="dropdown-menu" style="right: 0; left: auto; min-width: 160px; margin-top: 10px;">
                    <div class="dropdown-section">
                        <a href="/pages/profile.html">Profile</a>
                        <a href="/pages/developer-portal.html">Developer Portal</a>
                        <a href="#" onclick="disconnectWallet(); return false;" style="color: var(--danger);">Disconnect</a>
                    </div>
                </div>
            </div>
        `;
    } else {
        wrapper.innerHTML = `<button class="btn-connect" onclick="openConnectModal()">Connect</button>`;
    }
}
// Helper to load external scripts
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src*="${src}"]`)) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Update dynamic ticker data
async function updateTicker() {
    const tickerContainer = document.getElementById('ticker-marquee');
    if (!tickerContainer) return;

    // Resolve the correct path prefix from any depth in the site.
    // Counts how many directory levels deep the current page is relative to root.
    const parts = window.location.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    const depth = parts.length > 0 && parts[parts.length - 1].includes('.') ? parts.length - 1 : parts.length;
    const prefix = depth === 0 ? '' : '../'.repeat(depth);

    try {
        // Load dependencies if not already present on this page.
        if (!window.supabase) {
            await loadScript('https://unpkg.com/@supabase/supabase-js@2');
        }
        if (!window.DexHeroSupabase) {
            await loadScript(`${prefix}supabase-config.js`);
        }
        if (window.DexHeroSupabase && !window.DexHeroSupabase.get()) {
            window.DexHeroSupabase.init();
        }
        if (!window.DexHeroTokens) {
            await loadScript(`${prefix}js/token-creation.js`);
        }

        // If dependencies still aren't available, retry silently — don't touch the ticker.
        if (!window.DexHeroTokens) {
            setTimeout(updateTicker, 3000);
            return;
        }

        const result = await window.DexHeroTokens.getTopTokens(10);

        // Only replace the ticker when we have real data to show.
        if (!result.success || !result.tokens.length) return;

        const _esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const _url = typeof sanitizeUrl === 'function' ? sanitizeUrl : (u) => u || '';
        const defaultIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%2306b6d4'/%3E%3C/svg%3E";

        const createTickerItemHTML = (token, rank) => {
            const isPositive = parseFloat(token.price_change_24h) >= 0;
            const changeClass = isPositive ? 'positive' : 'negative';
            const changePrefix = isPositive ? '+' : '';
            const rawAddress = token.contract_address || '0x0000...0000';
            const displayAddress = rawAddress.length > 10 ? `${rawAddress.slice(0, 4)}...${rawAddress.slice(-4)}` : _esc(rawAddress);
            const iconUrl = _url(token.image_url) || defaultIcon;

            return `<div class="ticker-item" onclick="window.location.href='/pages/token-detail.html?id=${_esc(token.id)}'">
                    <span class="ticker-rank">#${rank}</span>
                    <img src="${iconUrl}" alt="${_esc(token.symbol)}" class="ticker-icon" onerror="this.src='${defaultIcon}'">
                    <span class="ticker-name">${_esc(token.symbol)}</span>
                    <span class="ticker-change ${changeClass}">${changePrefix}${_esc(token.price_change_24h)}%</span>
                    <span class="ticker-address">${displayAddress}</span>
                </div>`;
        };

        const tickerItems = result.tokens.map((token, index) => createTickerItemHTML(token, index + 1));
        // Duplicate for seamless scroll
        tickerContainer.innerHTML = [...tickerItems, ...tickerItems].join('');

    } catch (error) {
        // Silent fail — static ticker stays visible, live data will retry on the next interval.
        console.warn('Ticker update failed, keeping static content:', error);
    }
}

// Inject header into page
function injectHeader() {
    const headerPlaceholder = document.getElementById('header-placeholder');
    if (headerPlaceholder) {
        headerPlaceholder.innerHTML = createHeader();

        // Capture referral code if present
        const urlParams = new URLSearchParams(window.location.search);
        const ref = urlParams.get('ref');
        if (ref) {
            console.log(' Referral detected:', ref);
            sessionStorage.setItem('dexhero_referrer', ref);
        }

        // Init Supabase if needed (header might load before page script)
        if (window.DexHeroSupabase && !window.DexHeroSupabase.get()) {
            window.DexHeroSupabase.init();
        }
        updateConnectButton();
        updateTicker();

        // Refresh ticker every 60 seconds
        setInterval(updateTicker, 60000);
    }
}

//  Mobile Navigation 
function toggleMobileNav() {
    const overlay = document.getElementById('mobile-nav-overlay');
    const panel = document.getElementById('mobile-nav-panel');
    if (!overlay || !panel) return;
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
        closeMobileNav();
    } else {
        overlay.classList.add('open');
        panel.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
}

function closeMobileNav() {
    const overlay = document.getElementById('mobile-nav-overlay');
    const panel = document.getElementById('mobile-nav-panel');
    if (overlay) overlay.classList.remove('open');
    if (panel) panel.classList.remove('open');
    document.body.style.overflow = '';
}

//  Deep Space Star Field 
function initStarField() {
    const canvas = document.createElement('canvas');
    canvas.id = 'star-field';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;';
    document.body.insertBefore(canvas, document.body.firstChild);

    const ctx = canvas.getContext('2d');
    let W, H, stars = [];

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }

    function generate() {
        stars = [];
        // Layer 1: many tiny dim background stars
        for (let i = 0; i < 220; i++) {
            stars.push({
                x: Math.random() * W, y: Math.random() * H,
                r: Math.random() * 0.7 + 0.1,
                base: Math.random() * 0.4 + 0.15,
                twinkle: false
            });
        }
        // Layer 2: medium stars with slow twinkle
        for (let i = 0; i < 70; i++) {
            stars.push({
                x: Math.random() * W, y: Math.random() * H,
                r: Math.random() * 1.0 + 0.6,
                base: Math.random() * 0.35 + 0.35,
                twinkle: true,
                phase: Math.random() * Math.PI * 2,
                speed: Math.random() * 0.4 + 0.15
            });
        }
        // Layer 3: bright foreground stars
        for (let i = 0; i < 18; i++) {
            stars.push({
                x: Math.random() * W, y: Math.random() * H,
                r: Math.random() * 1.4 + 1.2,
                base: Math.random() * 0.2 + 0.7,
                twinkle: true,
                phase: Math.random() * Math.PI * 2,
                speed: Math.random() * 0.25 + 0.08
            });
        }
    }

    let t = 0;
    function draw() {
        ctx.clearRect(0, 0, W, H);
        t += 0.016;
        for (const s of stars) {
            const alpha = s.twinkle
                ? s.base * (0.55 + 0.45 * Math.sin(t * s.speed * 6.28 + s.phase))
                : s.base;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
            ctx.fill();
        }
        requestAnimationFrame(draw);
    }

    resize();
    generate();
    draw();

    window.addEventListener('resize', () => { resize(); generate(); });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    injectHeader();
    initStarField();
});
