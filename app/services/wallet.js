/* V3Labs wallet service — the ONE authoritative wallet-state owner for the
   entire site (modern panels + legacy /pages/*.html).

   Industry-standard pattern (wagmi / RainbowKit / ConnectKit playbook):
     - EIP-6963 multi-wallet discovery (replaces window.ethereum.isMetaMask checks)
     - EIP-1193 provider events (accountsChanged, chainChanged, disconnect)
     - EIP-2255 wallet_revokePermissions on disconnect (MetaMask supports;
       graceful try/catch for wallets that don't)
     - Hard-refresh detection via performance.getEntriesByType('navigation')
       — F5/Ctrl+R forces fresh reconnect; SPA nav + bfcache preserve session
     - Single source of truth: STATE object + sessionStorage write-through to
       legacy compat surfaces (window.DexHeroBlockchain, window.UnifiedWallet,
       sessionStorage walletConnected/walletAddress/walletChain/walletType,
       window 'walletChanged' event)

   This file replaces every wallet-state writer in the codebase. Legacy code
   in components/modals.js, js/unified-wallet.js, js/blockchain-integration.js
   forwards here. */

import { emit, E } from '../events.js';

// ── Authoritative state ───────────────────────────────────────────────────
const STATE = {
    status:     'disconnected',  // 'disconnected' | 'connecting' | 'connected' | 'disconnecting'
    address:    null,            // 0x… (lowercased)
    chainId:    null,            // decimal number
    walletInfo: null,            // EIP-6963 { uuid, name, icon, rdns } (or legacy fallback)
    provider:   null,            // ethers.providers.Web3Provider
    signer:     null,            // ethers signer
    rawProvider: null,           // raw EIP-1193 provider for event listeners + revoke
};

let _detachListeners = null;
let _inited = false;

// Legacy compat surfaces — written through on every state change.
const LEGACY_KEYS = {
    connected: 'walletConnected',
    address:   'walletAddress',
    chain:     'walletChain',
    type:      'walletType',
    base:      'dexhero_wallet_base',
};

const CROSS_TAB_DISCONNECT_KEY = 'dexhero_disconnect_signal';

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtAddr(a) {
    if (!a) return '';
    return a.slice(0, 6) + '…' + a.slice(-4);
}

function snapshot() {
    return {
        connected:       STATE.status === 'connected',
        status:          STATE.status,
        address:         STATE.address,
        chainId:         STATE.chainId,
        chain:           'evm',
        type:            detectWalletType(STATE.walletInfo),
        walletName:      STATE.walletInfo?.info?.name || null,
        formattedAddress: STATE.address ? fmtAddr(STATE.address) : '',
    };
}

function detectWalletType(walletInfo) {
    if (!walletInfo) return null;
    const rdns = walletInfo.info?.rdns?.toLowerCase() || '';
    if (rdns.includes('metamask')) return 'metamask';
    if (rdns.includes('phantom'))  return 'phantom';
    if (rdns.includes('coinbase')) return 'coinbase';
    if (rdns.includes('rabby'))    return 'rabby';
    if (rdns.includes('brave'))    return 'brave';
    // Fallback: inspect provider flags
    const p = walletInfo.provider;
    if (p?.isPhantom)        return 'phantom';
    if (p?.isCoinbaseWallet) return 'coinbase';
    if (p?.isRabby)          return 'rabby';
    if (p?.isBraveWallet)    return 'brave';
    if (p?.isMetaMask)       return 'metamask';
    return 'evm';
}

function readSessionState() {
    return {
        connected: sessionStorage.getItem(LEGACY_KEYS.connected) === 'true',
        address:   sessionStorage.getItem(LEGACY_KEYS.address) || null,
        type:      sessionStorage.getItem(LEGACY_KEYS.type) || null,
    };
}

function writeLegacyState() {
    sessionStorage.setItem(LEGACY_KEYS.connected, 'true');
    sessionStorage.setItem(LEGACY_KEYS.address,   STATE.address);
    sessionStorage.setItem(LEGACY_KEYS.chain,     'evm');
    sessionStorage.setItem(LEGACY_KEYS.type,      detectWalletType(STATE.walletInfo) || 'evm');
    sessionStorage.setItem(LEGACY_KEYS.base,      JSON.stringify({ chain: 'evm', address: STATE.address }));

    window.DexHeroBlockchain ??= {};
    window.DexHeroBlockchain.provider    = STATE.provider;
    window.DexHeroBlockchain.signer      = STATE.signer;
    window.DexHeroBlockchain.userAddress = STATE.address;

    if (window.UnifiedWallet) {
        window.UnifiedWallet.evmWallet        = STATE.rawProvider;
        window.UnifiedWallet.evmAddress       = STATE.address;
        window.UnifiedWallet.connectedAddress = STATE.address;
        window.UnifiedWallet.activeChain      = 'evm';
    }

    try { window.dispatchEvent(new CustomEvent('walletChanged', { detail: snapshot() })); } catch {}
}

function clearLegacyState() {
    Object.values(LEGACY_KEYS).forEach((k) => sessionStorage.removeItem(k));

    if (window.DexHeroBlockchain) {
        window.DexHeroBlockchain.provider    = null;
        window.DexHeroBlockchain.signer      = null;
        window.DexHeroBlockchain.userAddress = null;
    }
    if (window.UnifiedWallet) {
        window.UnifiedWallet.evmWallet        = null;
        window.UnifiedWallet.evmAddress       = null;
        window.UnifiedWallet.connectedAddress = null;
    }

    try { window.dispatchEvent(new CustomEvent('walletChanged', { detail: { connected: false } })); } catch {}
}

function isHardRefresh() {
    // The pre-init script (js/wallet-pre-init.js / components/header.js) is
    // the canonical detector. It uses a URL-marker approach (independent of
    // performance.navigation reporting, which Phantom + some Chromium combos
    // get wrong on F5) and writes both signals on a detected refresh:
    //   - sessionStorage.dexhero_force_fresh = '1'  (durable, primary)
    //   - window.__dexheroForceFresh = true          (in-context, secondary)
    // We consume sessionStorage here so it's a one-shot flag valid only for
    // this JS context — a subsequent SPA navigation in the same tab won't
    // mistake itself for a refresh.
    try {
        if (sessionStorage.getItem('dexhero_force_fresh') === '1') {
            sessionStorage.removeItem('dexhero_force_fresh');
            return true;
        }
    } catch {}
    if (typeof window !== 'undefined' && window.__dexheroForceFresh === true) return true;
    return false;
}

// ── EIP-6963 wallet discovery ─────────────────────────────────────────────

// Hardcoded brand-asset URLs — the same ones the pre-EIP-6963 picker used
// and that we know render reliably in every supported browser. We keep these
// as a brand fallback because (a) the wallet's own EIP-6963 announced icon
// can fail to load in some browsers/CSP combos and (b) inline data-URI SVGs
// can also fail when the browser rejects the MIME type. These HTTPS URLs
// are the simplest thing that always works.
const WALLET_LOGOS = {
    // Phantom: hardcoded inline SVG. The previous CDN URL (phantom.app/img/phantom-logo.svg)
    // 301-redirects to phantom.com/img/phantom-logo.svg which 404s, so the picker icon was
    // always broken in practice. Inline data URI is the bulletproof fix — no network, no CSP,
    // no CORS, no MIME sniffing concerns. Purple background + white ghost = clearly Phantom.
    phantom:  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28' fill='%23AB9FF2'/><path d='M64 28c-20 0-36 16-36 36v32l8-6 8 6 8-6 8 6 8-6 8 6 8-6 8 6V64c0-20-16-36-36-36zm-12 28c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8zm24 0c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8z' fill='%23fff'/></svg>",
    metamask: 'https://raw.githubusercontent.com/MetaMask/brand-resources/master/SVG/SVG_MetaMask_Icon_Color.svg',
    coinbase: 'https://avatars.githubusercontent.com/u/1885080?s=200&v=4',
    rabby:    'https://avatars.githubusercontent.com/u/79444939?s=200&v=4',
    brave:    'https://brave.com/static-assets/images/brave-logo-sans-text.svg',
    okx:      'https://avatars.githubusercontent.com/u/95116541?s=200&v=4',
    trust:    'https://trustwallet.com/assets/images/media/assets/symbol.svg',
};

function classifyLegacyProvider(p) {
    // Returns { name, rdns, logoKey } for a known provider, or null.
    if (!p) return null;
    if (p.isPhantom)         return { name: 'Phantom',         rdns: 'app.phantom',     logoKey: 'phantom'  };
    if (p.isCoinbaseWallet)  return { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', logoKey: 'coinbase' };
    if (p.isRabby)           return { name: 'Rabby',           rdns: 'io.rabby',        logoKey: 'rabby'    };
    if (p.isBraveWallet)     return { name: 'Brave Wallet',    rdns: 'com.brave.wallet', logoKey: 'brave'   };
    if (p.isOkxWallet || p.isOKExWallet) return { name: 'OKX Wallet', rdns: 'com.okx.wallet', logoKey: 'okx' };
    if (p.isTrust || p.isTrustWallet)    return { name: 'Trust Wallet', rdns: 'com.trustwallet.app', logoKey: 'trust' };
    if (p.isMetaMask)        return { name: 'MetaMask',        rdns: 'io.metamask',     logoKey: 'metamask' };
    return { name: 'Browser Wallet', rdns: 'legacy.injected', logoKey: null };
}

export function discoverWallets({ timeoutMs = 300 } = {}) {
    return new Promise((resolve) => {
        const announced = new Map();      // keyed by canonical identity
        const seenRdns = new Set();       // every rdns we've added (lowercased)
        const seenProviders = new Set();  // dedupe by provider object identity

        const addAnnounced = (detail) => {
            if (!detail?.provider) return;
            const rdns = (detail.info?.rdns || '').toLowerCase();
            // Skip if we already have this rdns (stronger dedup than provider
            // object identity, which can differ between EIP-6963 and legacy
            // probe even for the same wallet).
            if (rdns && seenRdns.has(rdns)) return;

            // The EIP-6963 spec lets wallets emit a frozen `detail` object;
            // mutating it (e.g. `detail.info = { … }`) throws TypeError under
            // ES-module strict mode and the announce silently disappears from
            // the picker. Build a fresh wrapper so we never write to the
            // wallet's own object — only read.
            //
            // For KNOWN brands (phantom/metamask/etc.), prefer our hardcoded
            // brand-asset HTTPS URL over whatever the wallet announces. The
            // pre-rewrite picker used these same URLs and they always worked;
            // EIP-6963 announced icons were observed to silently fail to load
            // in user reports. The wallet's announced icon becomes the second-
            // stage fallback in case the brand CDN is ever unreachable.
            const knownKey = Object.keys(WALLET_LOGOS).find((k) => rdns.includes(k));
            const brandUrl = knownKey ? WALLET_LOGOS[knownKey] : null;
            const announcedIcon = detail.info?.icon || '';

            const primaryIcon = brandUrl || announcedIcon || '';
            const fallbackIcon = brandUrl ? announcedIcon : '';

            const safeDetail = {
                provider: detail.provider,
                info: {
                    uuid: detail.info?.uuid,
                    name: detail.info?.name,
                    rdns: detail.info?.rdns,
                    icon: primaryIcon,
                    brandIconFallback: fallbackIcon || undefined,
                },
            };

            const key = safeDetail.info.uuid || rdns || ('eip6963:' + announced.size);
            announced.set(key, safeDetail);
            if (rdns) seenRdns.add(rdns);
            seenProviders.add(detail.provider);
        };

        const onAnnounce = (e) => addAnnounced(e.detail);
        window.addEventListener('eip6963:announceProvider', onAnnounce);
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch {}

        setTimeout(() => {
            window.removeEventListener('eip6963:announceProvider', onAnnounce);

            // Legacy detection — supplements EIP-6963. Many users have older
            // Phantom / MetaMask versions that don't announce; we still want
            // them in the picker with the right brand logo.
            const legacyProviders = [];
            if (window.ethereum) {
                if (Array.isArray(window.ethereum.providers) && window.ethereum.providers.length) {
                    legacyProviders.push(...window.ethereum.providers);
                }
                legacyProviders.push(window.ethereum);
            }
            for (const p of legacyProviders) {
                if (!p || seenProviders.has(p)) continue;
                const c = classifyLegacyProvider(p);
                if (!c) continue;
                const rdnsLc = c.rdns.toLowerCase();
                if (seenRdns.has(rdnsLc)) continue;  // already added via EIP-6963
                const detail = {
                    info: {
                        uuid: 'legacy:' + c.rdns,
                        name: c.name,
                        rdns: c.rdns,
                        icon: c.logoKey ? WALLET_LOGOS[c.logoKey] : '',
                    },
                    provider: p,
                };
                announced.set(detail.info.uuid, detail);
                seenRdns.add(rdnsLc);
                seenProviders.add(p);
            }

            resolve([...announced.values()]);
        }, timeoutMs);
    });
}

// ── Connect flow ──────────────────────────────────────────────────────────

export async function connect(walletInfo /* optional EIP-6963 detail */) {
    if (STATE.status === 'connecting') return null;       // dedupe
    if (STATE.status === 'connected')  return snapshot(); // already done

    STATE.status = 'connecting';

    let providerDetail = walletInfo;
    if (!providerDetail?.provider) {
        // No specific wallet picked — open the picker UI in the legacy modal.
        // The modal calls back into connect(detail) after user picks.
        if (typeof window.openConnectModal === 'function') {
            window.openConnectModal();
            STATE.status = 'disconnected';
            return null;
        }
        // No modal available: fall back to legacy injected
        const wallets = await discoverWallets();
        if (!wallets.length) {
            STATE.status = 'disconnected';
            throw new Error('No wallet detected. Install MetaMask, Phantom, Coinbase Wallet, or another EVM wallet.');
        }
        providerDetail = wallets[0];
    }

    const raw = providerDetail.provider;

    try {
        // Use EIP-2255 wallet_requestPermissions to FORCE the wallet's permission
        // dialog every connect, even if the dapp already has eth_accounts granted.
        // This is the only reliable way to require a fresh user confirmation —
        // eth_requestAccounts silently returns the cached grant for any wallet
        // (MetaMask, Phantom, Coinbase, etc.) that still trusts the dapp.
        // Phantom + MetaMask + Coinbase + Rabby all support EIP-2255; the catch
        // falls back to eth_requestAccounts only for older wallets that don't.
        let address = null;
        try {
            const perms = await raw.request({
                method: 'wallet_requestPermissions',
                params: [{ eth_accounts: {} }],
            });
            // Extract account from the granted-permission response
            const ethCap = Array.isArray(perms) ? perms.find((p) => p.parentCapability === 'eth_accounts') : null;
            const caveat = ethCap?.caveats?.find((c) => c.type === 'restrictReturnedAccounts');
            const granted = caveat?.value;
            if (Array.isArray(granted) && granted[0]) address = granted[0].toLowerCase();
            if (!address) {
                // Some wallets return the caveat without addresses; query directly.
                const accs = await raw.request({ method: 'eth_accounts' });
                if (Array.isArray(accs) && accs[0]) address = accs[0].toLowerCase();
            }
        } catch (err) {
            // Wallet rejected (user clicked deny) → propagate. Wallet doesn't
            // support EIP-2255 → fall back to eth_requestAccounts (may silent-
            // connect on cached grant, but it's the best we can do).
            const code = err?.code;
            if (code === 4001 || code === -32603) throw err;  // user rejected
            const accs = await raw.request({ method: 'eth_requestAccounts' });
            if (Array.isArray(accs) && accs[0]) address = accs[0].toLowerCase();
        }
        if (!address) throw new Error('No account returned from wallet');
        let chainId = null;
        try {
            const chainHex = await raw.request({ method: 'eth_chainId' });
            chainId = parseInt(chainHex, 16);
        } catch { /* non-fatal */ }

        if (!window.ethers || !window.ethers.providers) {
            throw new Error('ethers.js not loaded — cannot create provider');
        }

        const ethersProvider = new window.ethers.providers.Web3Provider(raw, 'any');
        const signer = ethersProvider.getSigner();

        STATE.status      = 'connected';
        STATE.address     = address;
        STATE.chainId     = chainId;
        STATE.walletInfo  = providerDetail;
        STATE.provider    = ethersProvider;
        STATE.signer      = signer;
        STATE.rawProvider = raw;

        attachProviderListeners(raw);
        writeLegacyState();
        rememberLastWallet(providerDetail);

        emit(E.WALLET_CONNECTED, snapshot());
        emit(E.WALLET_CHANGED,   snapshot());
        return snapshot();
    } catch (err) {
        STATE.status = 'disconnected';
        emit(E.WALLET_CHANGED, snapshot());
        throw err;
    }
}

// ── Disconnect flow ───────────────────────────────────────────────────────

export async function disconnect({ silent = false } = {}) {
    if (STATE.status === 'disconnected') return;
    STATE.status = 'disconnecting';

    // 1. Disconnect chain — call BOTH EIP-2255 revoke AND Phantom-specific
    //    provider.disconnect(). MetaMask only honors EIP-2255; Phantom only
    //    honors its own disconnect() method. Calling both gives full coverage.
    if (STATE.rawProvider) {
        try {
            await STATE.rawProvider.request({
                method: 'wallet_revokePermissions',
                params: [{ eth_accounts: {} }],
            });
        } catch { /* expected for wallets without EIP-2255 */ }
        if (typeof STATE.rawProvider.disconnect === 'function') {
            try { await STATE.rawProvider.disconnect(); } catch { /* Phantom-specific path; expected to be missing on others */ }
        }
    }

    // 2. Detach EIP-1193 listeners
    if (_detachListeners) { try { _detachListeners(); } catch {} _detachListeners = null; }

    // 3. Clear authoritative state
    STATE.status      = 'disconnected';
    STATE.address     = null;
    STATE.chainId     = null;
    STATE.walletInfo  = null;
    STATE.provider    = null;
    STATE.signer      = null;
    STATE.rawProvider = null;

    // 4. Clear legacy compat surfaces (sessionStorage, window globals, fire window event)
    clearLegacyState();

    // 5. Cross-tab signal: other tabs see the storage event and disconnect themselves.
    //    We use localStorage as the channel since sessionStorage is per-tab.
    if (!silent) {
        try {
            localStorage.setItem(CROSS_TAB_DISCONNECT_KEY, String(Date.now()));
            // Remove immediately so the slot doesn't pollute future sessions.
            setTimeout(() => { try { localStorage.removeItem(CROSS_TAB_DISCONNECT_KEY); } catch {} }, 100);
        } catch {}
    }

    emit(E.WALLET_DISCONNECTED, snapshot());
    emit(E.WALLET_CHANGED,      snapshot());
}

// ── EIP-1193 event listeners ──────────────────────────────────────────────

function attachProviderListeners(raw) {
    const onAccounts = (accs) => {
        if (!accs || !accs.length) {
            // Wallet revoked or user disconnected from wallet UI
            disconnect({ silent: true });
            return;
        }
        const addr = (accs[0] || '').toLowerCase();
        if (!addr || addr === STATE.address) return;
        STATE.address = addr;
        if (STATE.provider) STATE.signer = STATE.provider.getSigner();
        writeLegacyState();
        emit(E.WALLET_CHANGED, snapshot());
    };

    const onChain = (chainHex) => {
        try {
            STATE.chainId = parseInt(chainHex, 16);
            // Re-derive provider/signer for the new chain. NO PAGE RELOAD.
            if (window.ethers?.providers && raw) {
                STATE.provider = new window.ethers.providers.Web3Provider(raw, 'any');
                STATE.signer   = STATE.provider.getSigner();
            }
            writeLegacyState();
            emit(E.WALLET_CHANGED, snapshot());
        } catch (err) {
            console.warn('[wallet] chainChanged handler error:', err);
        }
    };

    const onProviderDisconnect = () => disconnect({ silent: true });

    raw.on?.('accountsChanged', onAccounts);
    raw.on?.('chainChanged',    onChain);
    raw.on?.('disconnect',      onProviderDisconnect);

    _detachListeners = () => {
        try {
            raw.removeListener?.('accountsChanged', onAccounts);
            raw.removeListener?.('chainChanged',    onChain);
            raw.removeListener?.('disconnect',      onProviderDisconnect);
        } catch {}
    };
}

// ── Picker preference (remember last wallet for UX, NOT for auto-connect) ──

const LAST_WALLET_KEY = 'dexhero_last_wallet_uuid';

function rememberLastWallet(walletInfo) {
    try {
        if (walletInfo?.info?.uuid) {
            localStorage.setItem(LAST_WALLET_KEY, walletInfo.info.uuid);
        }
    } catch {}
}

// Silent re-attach: when the wallet was actually connected (window.ethereum
// has accounts via eth_accounts) but our in-memory STATE doesn't reflect that
// — typically because the connection was established inside a legacy iframe
// that doesn't share our module STATE — re-hydrate without popping a wallet
// dialog. Returns true if STATE moved to 'connected'.
export async function silentReattach() {
    if (STATE.status === 'connected' && STATE.address) return true;
    const raw = (typeof window !== 'undefined') ? window.ethereum : null;
    if (!raw?.request) return false;
    try {
        const accs = await raw.request({ method: 'eth_accounts' });
        const addr = Array.isArray(accs) && accs.length ? (accs[0] || '').toLowerCase() : null;
        if (!addr) return false;
        if (!window.ethers?.providers) return false;
        const ethersProvider = new window.ethers.providers.Web3Provider(raw, 'any');
        STATE.status      = 'connected';
        STATE.address     = addr;
        STATE.chainId     = null;
        STATE.walletInfo  = STATE.walletInfo || {
            info:     { uuid: 'session:silent-reattach', name: 'Wallet', icon: '', rdns: 'session.silent-reattach' },
            provider: raw,
        };
        STATE.provider    = ethersProvider;
        STATE.signer      = ethersProvider.getSigner();
        STATE.rawProvider = raw;
        attachProviderListeners(raw);
        writeLegacyState();
        emit(E.WALLET_CONNECTED, snapshot());
        emit(E.WALLET_CHANGED,   snapshot());
        return true;
    } catch (_) {
        return false;
    }
}

export function getLastWalletUuid() {
    try { return localStorage.getItem(LAST_WALLET_KEY) || null; } catch { return null; }
}

// ── State accessors (always fresh — no caching) ────────────────────────────

export function getStatus() {
    return snapshot();
}

export function isConnected() {
    return STATE.status === 'connected';
}

export function getProvider() {
    return STATE.provider;
}

export function getSigner() {
    return STATE.signer;
}

export async function signMessage(message) {
    if (!STATE.signer) throw new Error('Wallet not connected');
    return STATE.signer.signMessage(message);
}

// Subscriptions (delegated to events bus)
export function onChange(fn) {
    return _onBusOrWindow('walletChanged', E.WALLET_CHANGED, fn);
}
export function onConnect(fn) {
    return _onBusOrWindow('walletConnected', E.WALLET_CONNECTED, fn);
}
export function onDisconnect(fn) {
    return _onBusOrWindow('walletDisconnected', E.WALLET_DISCONNECTED, fn);
}

function _onBusOrWindow(legacyEventName, busEvent, fn) {
    // Subscribe to BOTH the modern bus and the legacy window event so old
    // page code that listens to window.walletChanged also sees us.
    const winHandler = (e) => fn(e?.detail || snapshot());
    window.addEventListener(legacyEventName, winHandler);
    // Use the events.js `on` function. Inline import to avoid circular dep.
    import('../events.js').then(({ on }) => {
        const unsub = on(busEvent, fn);
        // Save unsub on the closure
        winHandler._busUnsub = unsub;
    });
    return () => {
        window.removeEventListener(legacyEventName, winHandler);
        try { winHandler._busUnsub?.(); } catch {}
    };
}

// ── init() — runs once per JS context start ───────────────────────────────

export function init() {
    if (_inited) return Promise.resolve(snapshot());
    _inited = true;

    // Cross-tab disconnect signal: when ANOTHER tab disconnects, this fires.
    window.addEventListener('storage', (e) => {
        if (e.key === CROSS_TAB_DISCONNECT_KEY && e.newValue) {
            disconnect({ silent: true });
        }
    });

    if (isHardRefresh()) {
        // User explicitly refreshed → kill any prior session. They click Connect.
        clearLegacyState();

        // Aggressive: disconnect every detected provider so the next connect
        // REQUIRES the wallet's auth dialog. Two methods, fire-and-forget:
        //   - EIP-2255 wallet_revokePermissions (MetaMask, Coinbase, Rabby)
        //   - Phantom-specific provider.disconnect() (only path Phantom honors)
        // Calling both gives full cross-wallet coverage.
        (async () => {
            try {
                const wallets = await discoverWallets({ timeoutMs: 250 });
                for (const w of wallets) {
                    try {
                        await w.provider.request({
                            method: 'wallet_revokePermissions',
                            params: [{ eth_accounts: {} }],
                        });
                    } catch { /* expected for wallets without EIP-2255 */ }
                    if (typeof w.provider.disconnect === 'function') {
                        try { await w.provider.disconnect(); }
                        catch { /* Phantom path; expected to be missing on others */ }
                    }
                }
            } catch { /* discovery itself can fail in odd browser conditions */ }
        })();

        emit(E.WALLET_DISCONNECTED, snapshot());
        emit(E.WALLET_CHANGED,      snapshot());
        return Promise.resolve(snapshot());
    }

    const isMobileUA = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');

    // Lightweight legacy-state population that does NOT depend on ethers.js.
    // Iframes (and the play-pass overlay) only need sessionStorage to be
    // populated to recognize the wallet — the ethers Web3Provider is built
    // lazily by callers that actually need to sign. If we waited for ethers
    // to be loaded before writing sessionStorage, a slow CDN load on mobile
    // would cause silent reconnect to "succeed" at the wallet level but
    // leave the iframe gate stuck on "Connect Wallet" forever.
    const writeLegacyKeysOnly = (address, walletTypeHint) => {
        try {
            const t = walletTypeHint
                || (window.ethereum?.isPhantom ? 'phantom'
                    : window.ethereum?.isMetaMask ? 'metamask'
                    : window.ethereum?.isCoinbaseWallet ? 'coinbase'
                    : 'evm');
            sessionStorage.setItem('walletConnected', 'true');
            sessionStorage.setItem('walletAddress', address.toLowerCase());
            sessionStorage.setItem('walletChain', 'evm');
            sessionStorage.setItem('walletType', t);
            sessionStorage.setItem('dexhero_wallet_base', JSON.stringify({ chain: 'evm', address: address.toLowerCase() }));
        } catch (_) {}
        try {
            window.DexHeroBlockchain ??= {};
            window.DexHeroBlockchain.userAddress = address.toLowerCase();
        } catch (_) {}
        try {
            if (window.UnifiedWallet) {
                window.UnifiedWallet.evmWallet        = window.ethereum;
                window.UnifiedWallet.evmAddress       = address.toLowerCase();
                window.UnifiedWallet.connectedAddress = address.toLowerCase();
                window.UnifiedWallet.activeChain      = 'evm';
            }
        } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('walletChanged', { detail: { connected: true, address: address.toLowerCase() } }));
            window.dispatchEvent(new CustomEvent('walletAccountChanged', { detail: { address: address.toLowerCase() } }));
        } catch (_) {}
    };

    // Rehydrate STATE from a known address using window.ethereum + ethers v5.
    // Shared by the sessionStorage-rehydrate path and the silent eth_accounts
    // reconnect path below. Returns true on success, false if anything fails.
    const rehydrateFromAddress = (address, walletTypeHint) => {
        if (!window.ethereum || !window.ethers?.providers) return false;
        try {
            const raw = window.ethereum;
            const ethersProvider = new window.ethers.providers.Web3Provider(raw, 'any');
            STATE.status      = 'connected';
            STATE.address     = address.toLowerCase();
            STATE.chainId     = null;
            STATE.walletInfo  = {
                info:     { uuid: 'session:rehydrated', name: walletTypeHint || 'Wallet', icon: '', rdns: 'session.rehydrated' },
                provider: raw,
            };
            STATE.provider    = ethersProvider;
            STATE.signer      = ethersProvider.getSigner();
            STATE.rawProvider = raw;
            attachProviderListeners(raw);
            writeLegacyState();
            emit(E.WALLET_CONNECTED, snapshot());
            emit(E.WALLET_CHANGED,   snapshot());
            return true;
        } catch (err) {
            console.warn('[wallet] rehydration failed:', err.message);
            return false;
        }
    };

    // SPA navigation OR back/forward: rehydrate from sessionStorage WITHOUT
    // calling eth_accounts (no silent wallet popup; trust the session).
    const stored = readSessionState();
    if (stored.connected && stored.address && rehydrateFromAddress(stored.address, stored.type)) {
        return Promise.resolve(snapshot());
    }

    // Silent reconnect (MOBILE ONLY): if the user is in a wallet's in-app
    // browser, eth_accounts returns the address without any popup. Desktop
    // intentionally skips this so the user is required to click Connect
    // explicitly — no auto-connect from a long-lived prior authorization.
    //
    // We write the legacy sessionStorage keys IMMEDIATELY (without waiting
    // for ethers.js) so iframe consumers see the wallet right away. The
    // ethers Web3Provider is built lazily later if a signer is actually
    // needed.
    if (isMobileUA() && window.ethereum && typeof window.ethereum.request === 'function') {
        return window.ethereum.request({ method: 'eth_accounts' })
            .then((accounts) => {
                if (Array.isArray(accounts) && accounts.length && accounts[0]) {
                    writeLegacyKeysOnly(accounts[0]);
                    // Also try the full ethers rehydrate; harmless if it fails.
                    rehydrateFromAddress(accounts[0]);
                    return snapshot();
                }
                clearLegacyState();
                emit(E.WALLET_DISCONNECTED, snapshot());
                emit(E.WALLET_CHANGED,      snapshot());
                return snapshot();
            })
            .catch(() => {
                clearLegacyState();
                emit(E.WALLET_DISCONNECTED, snapshot());
                emit(E.WALLET_CHANGED,      snapshot());
                return snapshot();
            });
    }

    clearLegacyState();
    emit(E.WALLET_DISCONNECTED, snapshot());
    emit(E.WALLET_CHANGED,      snapshot());
    return Promise.resolve(snapshot());
}
