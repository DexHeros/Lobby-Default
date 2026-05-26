/* wallet-pre-init.js — runs as the FIRST script on every page, BEFORE any
 * other script reads sessionStorage. Synchronously decides if THIS page load
 * is a hard refresh (F5 / Ctrl+R / address-bar reload) and, if so, clears
 * wallet state + revokes permissions on every detected provider.
 *
 * Detection (URL-marker, not performance.navigation type):
 *   - sessionStorage.dexhero_page_marker holds { url, t } from the previous
 *     page load in this tab.
 *   - On this load, if the marker's URL equals location.pathname AND was
 *     written within MAX_AGE_MS, this is a refresh (same tab loading the
 *     same URL it was already on).
 *   - Otherwise, this is navigation (different URL), or a fresh tab (no
 *     marker), and we leave the wallet session alone.
 *
 * Why URL-marker, not performance.getEntriesByType('navigation')[0].type:
 *   That API returns 'navigate' for F5 in some browser/wallet combos
 *   (notably with the Phantom extension), defeating refresh detection.
 *   The URL-marker approach is independent of that bug — it works the
 *   same regardless of which navigation type the browser reports.
 *
 * sessionStorage already gives us same-tab navigation persistence for free.
 * We never want to clear it on link-clicks or back/forward; only on refresh.
 */
(function () {
    // Defense: never run refresh detection in an iframe context. Same-origin
    // iframes share sessionStorage with the top window, so an iframe writing
    // its URL into the shared marker would (a) pollute top's refresh check
    // and (b) read its own previous marker on a second visit and mis-detect
    // a refresh, wiping the user's connection mid-session.
    if (window.top !== window) return;

    var MARKER_KEY = 'dexhero_page_marker';
    var MAX_AGE_MS = 60 * 60 * 1000;  // 1 hour

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

    // Returns true if the current load is the redirect-back from the
    // Steam OpenID flow. The /api/steam/auth/callback handler stamps
    // `steam_link=ok&steam_token=<t>` into the hash on its way back to
    // the SPA — this is a same-domain *navigation*, NOT a user-initiated
    // refresh, and we MUST preserve the wallet session through it.
    // Without this guard, the URL-marker heuristic mis-classifies the
    // OpenID return as a refresh and wipes the wallet, forcing the user
    // to reconnect every time they sign into Steam.
    function isSteamCallbackReturn() {
        try {
            var hash = location.hash || '';
            var search = location.search || '';
            return hash.indexOf('steam_link=ok') !== -1
                || hash.indexOf('steam_token=') !== -1
                || search.indexOf('steam_link=ok') !== -1
                || search.indexOf('steam_token=') !== -1;
        } catch (_) { return false; }
    }

    if (isSteamCallbackReturn()) {
        if (typeof console !== 'undefined' && console.log) {
            console.log('[dexhero-wallet] pre-init: Steam OpenID callback return — preserving wallet session');
        }
        // Bump the marker so a follow-up Ctrl+R on this same page still
        // classifies as a refresh (we don't want to give the user a free
        // refresh-without-wipe just because they recently linked Steam).
        try {
            sessionStorage.setItem(MARKER_KEY, JSON.stringify({ url: location.pathname, t: Date.now() }));
        } catch (_) {}
        return;
    }

    if (!detectRefresh()) {
        if (typeof console !== 'undefined' && console.log) {
            console.log('[dexhero-wallet] pre-init: navigation/fresh-load — preserving session');
        }
        return;
    }

    // ── Hard refresh path ─────────────────────────────────────────────────

    // 1. Wipe wallet sessionStorage synchronously BEFORE any other reader runs.
    try {
        sessionStorage.removeItem('walletConnected');
        sessionStorage.removeItem('walletAddress');
        sessionStorage.removeItem('walletChain');
        sessionStorage.removeItem('walletType');
        sessionStorage.removeItem('dexhero_wallet_base');
    } catch (_) {}
    try { localStorage.removeItem('dexhero_wallet_base'); } catch (_) {}

    // 1b. Same policy applies to the Steam session token. The user expects
    //     "hard refresh = signed out of everything" — so we drop the local
    //     sessionStorage token AND fire-and-forget a sign-out to the server
    //     so the dx_steam_session cookie + steam_sessions row both go away.
    //     navigator.sendBeacon is non-blocking and survives the page tear-
    //     down that's happening right now; fetch() is the desktop fallback.
    try { sessionStorage.removeItem('dx_steam_session'); } catch (_) {}
    try {
        if (navigator && typeof navigator.sendBeacon === 'function') {
            navigator.sendBeacon('/api/steam/sign-out', '');
        } else {
            fetch('/api/steam/sign-out', {
                method: 'POST',
                credentials: 'include',
                keepalive: true,
            }).catch(function () {});
        }
    } catch (_) {}

    // 2. Flags the wallet service reads — primary (sessionStorage, durable
    //    across module imports) and secondary (window flag, in-context).
    try { sessionStorage.setItem('dexhero_force_fresh', '1'); } catch (_) {}
    try { window.__dexheroForceFresh = true; } catch (_) {}

    // 3. Disconnect every provider we can find. Two methods, both fire-and-forget.
    function disconnectProvider(p) {
        if (!p || typeof p.request !== 'function') return;
        // EIP-2255 — works for MetaMask, Coinbase, Rabby, Brave, OKX
        try {
            var rp = p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
            if (rp && typeof rp.catch === 'function') rp.catch(function () {});
        } catch (_) {}
        // Phantom-specific — Phantom doesn't honor EIP-2255 reliably; its own
        // disconnect() is the only call that severs the dapp grant.
        if (typeof p.disconnect === 'function') {
            try {
                var dp = p.disconnect();
                if (dp && typeof dp.catch === 'function') dp.catch(function () {});
            } catch (_) {}
        }
    }

    function disconnectAllProviders() {
        try {
            if (window.ethereum) {
                disconnectProvider(window.ethereum);
                if (Array.isArray(window.ethereum.providers)) {
                    window.ethereum.providers.forEach(disconnectProvider);
                }
            }
            if (window.phantom && window.phantom.ethereum) disconnectProvider(window.phantom.ethereum);
        } catch (_) {}
    }
    disconnectAllProviders();
    try { setTimeout(disconnectAllProviders, 0); } catch (_) {}
    try { setTimeout(disconnectAllProviders, 200); } catch (_) {}

    try {
        window.addEventListener('eip6963:announceProvider', function (e) {
            var detail = e && e.detail;
            if (detail && detail.provider) disconnectProvider(detail.provider);
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (_) {}

    if (typeof console !== 'undefined' && console.log) {
        console.log('[dexhero-wallet] pre-init: refresh detected (URL marker) — wallet + Steam sessionStorage cleared, EIP-2255 + Phantom-disconnect fired on all providers, Steam sign-out beacon sent');
    }
})();
