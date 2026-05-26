/* LLM Vault — wallet-bound server-side encrypted key store.
 *
 * Storage model (mirrors how Steam is wallet-linked):
 *
 *   Server:  user_llm_keys(wallet, provider, ciphertext, iv, model)
 *            encrypted at rest with LLM_KEY_VAULT_SECRET.
 *   Server:  wallet_sessions(token_hash, wallet, expires_at) — 90-day
 *            session tokens issued by /api/wallet/session.
 *   Client:  localStorage `dexhero-vault:session:<wallet>` = { token,
 *            expires_at } — the raw token, used as `Authorization:
 *            Bearer <token>` on every subsequent request.
 *
 * UX:
 *   1. Connect wallet (standard MetaMask flow).
 *   2. First action that needs a key (open LLM modal save, send chat)
 *      → ONE wallet signature to mint a session token.
 *   3. From then on, refreshes / new tabs / new browsers (signed into
 *      the same wallet) — silent. The user's connected APIs follow
 *      their wallet across devices.
 *   4. Disconnect a provider → server row deleted, cache updated.
 *
 * No more per-tab encryption keys. The wallet IS the account.
 */

import * as wallet from './wallet.js';

const SESSION_STORE_PREFIX = 'dexhero-vault:session:';
const SESSION_MESSAGE_TEMPLATE = (walletLower, minuteBucket) =>
    `DexHero Wallet Sign-In: ${walletLower} ${minuteBucket}`;

/** In-memory cache of decrypted server data, keyed by wallet address.
 *  Each entry: { wallet, keys: [{provider, key, model, masked, ...}],
 *  loaded: bool, error?: string } */
const _cache = new Map();
const _loadInFlight = new Map();   // walletLower → Promise

/* ─── Session token persistence ─────────────────────────────────── */

function sessionStorageKey(walletAddr) {
    return SESSION_STORE_PREFIX + String(walletAddr || '').toLowerCase();
}

export function getStoredSession(walletAddr) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr) return null;
    try {
        const raw = localStorage.getItem(sessionStorageKey(addr));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.token || !parsed?.expires_at) return null;
        if (new Date(parsed.expires_at).getTime() <= Date.now()) {
            localStorage.removeItem(sessionStorageKey(addr));
            return null;
        }
        return parsed;
    } catch { return null; }
}

export function setStoredSession(walletAddr, session) {
    try {
        localStorage.setItem(sessionStorageKey(walletAddr), JSON.stringify(session));
    } catch {}
}

export function clearStoredSession(walletAddr) {
    try { localStorage.removeItem(sessionStorageKey(walletAddr)); } catch {}
}

/* ─── Wallet sign-in → session-token mint ───────────────────────── */

async function mintSession(walletAddr) {
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) {
        const e = new Error('wallet_not_connected');
        e.code = 'wallet_not_connected';
        throw e;
    }
    const addr = status.address.toLowerCase();
    if (String(walletAddr).toLowerCase() !== addr) {
        const e = new Error('wallet_mismatch');
        e.code = 'wallet_mismatch';
        throw e;
    }
    const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
    const signedMsg = SESSION_MESSAGE_TEMPLATE(addr, minuteBucket);
    let signature;
    try {
        signature = await wallet.signMessage(signedMsg);
    } catch (err) {
        const e = new Error('signature_rejected');
        e.code = 'signature_rejected';
        e.cause = err;
        throw e;
    }
    const r = await fetch('/api/wallet/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: addr, signedMsg, signature }),
    });
    if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const e = new Error(body?.error || `session_mint_failed_${r.status}`);
        e.code = body?.error || `session_mint_failed_${r.status}`;
        throw e;
    }
    const { token, expires_at } = await r.json();
    const session = { token, expires_at };
    setStoredSession(addr, session);
    return session;
}

/** Return a valid session for the wallet, minting (with one signature)
 *  when absent. Used by callers that absolutely need an authenticated
 *  request — the LLM modal Save and chat send. */
export async function ensureSession(walletAddr) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr) {
        const e = new Error('wallet_not_connected');
        e.code = 'wallet_not_connected';
        throw e;
    }
    const stored = getStoredSession(addr);
    if (stored) return stored;
    return await mintSession(addr);
}

/* ─── Authenticated fetch with one-shot retry on 401 ────────────── */

async function authedFetch(walletAddr, url, init = {}, opts = {}) {
    const addr = String(walletAddr || '').toLowerCase();
    const requireMint = opts.requireMint !== false;
    let session = getStoredSession(addr);
    if (!session) {
        if (!requireMint) return null;
        session = await mintSession(addr);
    }
    const headers = Object.assign(
        { 'authorization': `Bearer ${session.token}` },
        init.headers || {},
    );
    let r = await fetch(url, Object.assign({}, init, { headers }));
    if (r.status === 401) {
        // Token expired / revoked → wipe and retry once with fresh mint.
        clearStoredSession(addr);
        if (!requireMint) return null;
        session = await mintSession(addr);
        const headers2 = Object.assign(
            { 'authorization': `Bearer ${session.token}` },
            init.headers || {},
        );
        r = await fetch(url, Object.assign({}, init, { headers: headers2 }));
    }
    return r;
}

/* ─── Cache management ──────────────────────────────────────────── */

/** Force-fetch the user's keys from the server and populate the cache.
 *  Idempotent across concurrent callers. Will silently no-op (returning
 *  null) if no session exists and `opts.requireMint = false`. */
export async function loadKeys(walletAddr, opts = {}) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr) return null;
    if (_loadInFlight.has(addr)) return await _loadInFlight.get(addr);
    const p = (async () => {
        const r = await authedFetch(addr, '/api/llm-keys', { method: 'GET' }, opts);
        if (!r) {
            const empty = { wallet: addr, keys: [], loaded: false };
            _cache.set(addr, empty);
            return empty;
        }
        if (!r.ok) {
            const e = new Error('list_failed');
            e.code = 'list_failed';
            e.status = r.status;
            throw e;
        }
        const data = await r.json();
        const entry = { wallet: data.wallet || addr, keys: data.keys || [], loaded: true };
        _cache.set(addr, entry);
        return entry;
    })()
        .then((entry) => {
            _loadInFlight.delete(addr);
            document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
            return entry;
        })
        .catch((err) => {
            _loadInFlight.delete(addr);
            if (!_cache.has(addr)) {
                _cache.set(addr, { wallet: addr, keys: [], loaded: false, error: err.code || err.message });
            }
            throw err;
        });
    _loadInFlight.set(addr, p);
    return await p;
}

/** Synchronous cache read for hot-path UI. Returns null until loadKeys
 *  has populated. Callers listen for `dexhero:llm-account-changed`
 *  to know when to re-render. */
export function getCachedKeys(walletAddr) {
    return _cache.get(String(walletAddr || '').toLowerCase()) || null;
}

export function getCachedKey(walletAddr, providerId) {
    const entry = getCachedKeys(walletAddr);
    return entry?.keys?.find((k) => k.provider === providerId) || null;
}

/* ─── Mutations ─────────────────────────────────────────────────── */

function maskKey(key) {
    if (!key) return '';
    const s = String(key);
    if (s.length <= 12) return '****';
    return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

export async function saveKey(walletAddr, provider, key, model) {
    const addr = String(walletAddr || '').toLowerCase();
    const r = await authedFetch(addr, '/api/llm-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, key, model: model || null }),
    });
    if (!r || !r.ok) {
        const body = r ? await r.json().catch(() => ({})) : {};
        const e = new Error(body?.error || 'save_failed');
        e.code = body?.error || 'save_failed';
        throw e;
    }
    // Update cache optimistically.
    const entry = _cache.get(addr) || { wallet: addr, keys: [], loaded: true };
    const filtered = entry.keys.filter((k) => k.provider !== provider);
    filtered.push({
        provider,
        key,
        model: model || null,
        masked: maskKey(key),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });
    _cache.set(addr, { ...entry, keys: filtered, loaded: true });
    document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
}

export async function deleteKey(walletAddr, provider) {
    const addr = String(walletAddr || '').toLowerCase();
    const r = await authedFetch(addr, `/api/llm-keys/${encodeURIComponent(provider)}`, { method: 'DELETE' });
    if (r && !r.ok && r.status !== 404) {
        const e = new Error('delete_failed');
        e.code = 'delete_failed';
        throw e;
    }
    const entry = _cache.get(addr);
    if (entry) {
        _cache.set(addr, { ...entry, keys: entry.keys.filter((k) => k.provider !== provider) });
    }
    document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
}

export async function updateModel(walletAddr, provider, model) {
    const addr = String(walletAddr || '').toLowerCase();
    // Optimistic cache update before the round-trip — chat send latency wins.
    const entry = _cache.get(addr);
    if (entry) {
        const next = entry.keys.map((k) => k.provider === provider ? { ...k, model } : k);
        _cache.set(addr, { ...entry, keys: next });
        document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
    }
    try {
        await authedFetch(addr, `/api/llm-keys/${encodeURIComponent(provider)}/model`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model }),
        }, { requireMint: false });
    } catch { /* server sync best-effort; cache is the load-bearing source */ }
}

/* ─── Boot-time auto-load ───────────────────────────────────────── */

/** Auto-load keys for a wallet if a session token exists. Never prompts
 *  the wallet for a signature — that only happens on explicit user
 *  action (open LLM modal, send chat). */
function tryAutoLoad(walletAddr) {
    if (!walletAddr) return;
    const addr = String(walletAddr).toLowerCase();
    const stored = getStoredSession(addr);
    if (!stored) return;   // no session = no prompt = no fetch
    loadKeys(addr, { requireMint: false }).catch(() => {});
}

try {
    const status = wallet.getStatus();
    if (status?.connected && status.address) tryAutoLoad(status.address);
    wallet.onConnect?.((addr) => {
        const a = typeof addr === 'string' ? addr : (wallet.getStatus()?.address || '');
        if (a) tryAutoLoad(a);
    });
} catch {}

/* ─── Compatibility shims (for existing call sites) ─────────────── */

/** No-op — retained so old call sites that branched on isUnlocked
 *  keep working. With the new vault, "unlocked" means "wallet is
 *  connected" (the session-mint is lazy). */
export function isUnlocked() {
    const status = wallet.getStatus();
    return !!(status?.connected && status.address);
}
export function wasUnlockedThisSession() { return isUnlocked(); }
export function unlockedFor() {
    return wallet.getStatus()?.address?.toLowerCase() || '';
}
export function lock() { _cache.clear(); }

/** unlock() now triggers a server fetch (minting a session if needed).
 *  Returns when keys are loaded. Throws on signature refusal / no wallet. */
export async function unlock() {
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) {
        const e = new Error('wallet_not_connected');
        e.code = 'wallet_not_connected';
        throw e;
    }
    await loadKeys(status.address);
}

/** encrypt / decrypt no longer make sense client-side — the server is
 *  the cryptographer now. These exist solely so that any straggler
 *  callers don't crash; they pass the value through. New code should
 *  call saveKey / getCachedKey directly. */
export async function encrypt(plaintext) { return plaintext; }
export async function decrypt(packed)   { return packed;    }
