/* User-managed LLM accounts — wallet-bound, server-side encrypted.
 *
 * Storage architecture (mirrors Steam wallet linking):
 *   • Encrypted keys live server-side in user_llm_keys, indexed by
 *     the EVM wallet address.
 *   • One wallet signature mints a 90-day session token; the token
 *     authenticates all subsequent reads/writes.
 *   • Cross-device: signing into the same wallet on any browser
 *     restores all connected providers (no manual re-paste).
 *
 * Public API is unchanged from the prior localStorage-only version so
 * callers (brain-picker, llm-connect modal, dexhero-chat) don't need
 * to know about the move. The vault module (llm-vault.js) handles the
 * server round-trips; this file is the thin shape adapter.
 *
 *   `active` provider/model selection stays purely client-side as a
 *   per-wallet UI preference — there's no value in persisting the
 *   "currently picked" model server-side since it's wallet-scoped to
 *   the device anyway and doesn't affect security. */

import { PROVIDERS, PROVIDER_IDS, getProvider } from './llm-providers.js';
import * as vault from './llm-vault.js';

function bucket(wallet) { return wallet ? wallet.toLowerCase() : 'anon'; }
function activeKey(wallet) { return `dexhero-llm:${bucket(wallet)}:active`; }

/** Defensive format check — doesn't talk to the provider, just sanity-
 *  tests the prefix + length so we don't store obvious junk. The first
 *  real chat message surfaces any actual auth failure. */
export function validateKeyFormat(providerId, key) {
    const p = getProvider(providerId);
    if (!p) return false;
    if (typeof key !== 'string') return false;
    return p.keyRegex.test(key.trim());
}

/** Mask a key so the UI can show "sk-ant-…7xQ2" without exposing the secret. */
export function mask(key) {
    if (!key) return '';
    const s = String(key);
    if (s.length <= 12) return '****';
    return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

/** Synchronous account read for hot-path UI. Cache is populated by
 *  vault.loadKeys (auto-fires on wallet connect when a session token
 *  exists). Callers listening for `dexhero:llm-account-changed`
 *  re-render after the cache hydrates. */
export function getAccount(wallet, providerId) {
    const cached = vault.getCachedKey(wallet, providerId);
    if (!cached) {
        return {
            provider: providerId,
            connected: false,
            masked: '',
            connected_at: null,
            model: null,
            encrypted: false,
        };
    }
    return {
        provider: providerId,
        connected: true,
        masked: cached.masked || mask(cached.key),
        connected_at: cached.created_at || null,
        model: cached.model || null,
        encrypted: true,
    };
}

/** Return ALL connected accounts for this wallet across providers. */
export function getAllAccounts(wallet) {
    const entry = vault.getCachedKeys(wallet);
    if (!entry) return [];
    return entry.keys.map((k) => ({
        provider: k.provider,
        connected: true,
        masked: k.masked || mask(k.key),
        connected_at: k.created_at || null,
        model: k.model || null,
        encrypted: true,
    }));
}

/** The provider id the user most recently activated (used by the chat
 *  surface to know which key to send). Returns '' when nothing connected. */
export function getActiveProvider(wallet) {
    try {
        return localStorage.getItem(activeKey(wallet)) || '';
    } catch { return ''; }
}
export function setActiveProvider(wallet, providerId) {
    if (!PROVIDER_IDS.includes(providerId)) return;
    try { localStorage.setItem(activeKey(wallet), providerId); } catch {}
}

/** Convenience — is the wallet/user able to chat at all? */
export function getActiveAccount(wallet) {
    const id = getActiveProvider(wallet);
    if (id) {
        const a = getAccount(wallet, id);
        if (a.connected) return a;
    }
    // Fall back to the first connected provider in registry order — covers
    // a refreshed bucket that lost the `active` pointer.
    const any = getAllAccounts(wallet)[0];
    if (any) {
        setActiveProvider(wallet, any.provider);
        return any;
    }
    return { provider: '', connected: false, masked: '', connected_at: null, model: null };
}

/** Read the raw key — only for use at chat-send time. Never log or echo.
 *  Async because the cache may need an initial fetch. Returns '' when
 *  nothing is stored or the user refuses the sign-in signature. */
export async function getRawKey(wallet, providerId) {
    // Hot path: cached.
    const cached = vault.getCachedKey(wallet, providerId);
    if (cached) return cached.key || '';
    // Cold path: try a server fetch with an existing token (no prompt).
    try { await vault.loadKeys(wallet, { requireMint: false }); } catch {}
    const fresh = vault.getCachedKey(wallet, providerId);
    if (fresh) return fresh.key || '';
    // Still nothing — fetch with mint allowed (will prompt for one sig).
    try { await vault.loadKeys(wallet, { requireMint: true }); } catch (err) {
        // Bubble up the user-meaningful errors; swallow the rest so the
        // chat path falls back to its "no key" branch.
        if (err?.code === 'signature_rejected') throw err;
        if (err?.code === 'wallet_not_connected') throw err;
        return '';
    }
    return vault.getCachedKey(wallet, providerId)?.key || '';
}

/** Persist a freshly-pasted key for a specific provider. Server-side
 *  AES-GCM encryption happens in the POST /api/llm-keys handler.
 *  Mints a session token (one signature) on first save per device. */
export async function setAccount(wallet, providerId, apiKey, opts = {}) {
    if (!PROVIDER_IDS.includes(providerId)) throw new Error('provider_not_supported');
    const trimmed = String(apiKey || '').trim();
    if (!validateKeyFormat(providerId, trimmed)) {
        const e = new Error('key_format_invalid');
        e.code = 'key_format_invalid';
        throw e;
    }
    const model = opts.model || getProvider(providerId).defaultModel;
    await vault.saveKey(wallet, providerId, trimmed, model);
    setActiveProvider(wallet, providerId);
    return getAccount(wallet, providerId);
}

/** Update the chosen model for an already-connected provider. */
export function setAccountModel(wallet, providerId, model) {
    vault.updateModel(wallet, providerId, model).catch(() => {});
}

/** Wipe the stored key for this user + provider. If it was active, clear
 *  the active pointer too (falls back to whatever's still connected). */
export async function removeAccount(wallet, providerId) {
    await vault.deleteKey(wallet, providerId);
    if (getActiveProvider(wallet) === providerId) {
        try { localStorage.removeItem(activeKey(wallet)); } catch {}
        const any = getAllAccounts(wallet)[0];
        if (any) setActiveProvider(wallet, any.provider);
    }
}

export const SUPPORTED_PROVIDERS = PROVIDER_IDS.slice();
export { PROVIDERS };
