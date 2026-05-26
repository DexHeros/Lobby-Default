/* DexHero Topics — client wrapper for the topics + messages REST API.
 *
 *   Bearer-authed (reuses llm-vault session). Triggers bootstrap of the
 *   4 default topics on first interaction with each DexHero (idempotent
 *   server-side). Holds a small in-memory cache of topics per (wallet,
 *   tokenId) plus IndexedDB-backed ciphertext (via dexhero-e2e.js).
 */

import * as wallet from './wallet.js';
import * as vault from './llm-vault.js';
import * as e2e from './dexhero-e2e.js';

const _topicsCache  = new Map();   // `${wallet}::${tokenId}` → topics[]
const _bootstrapped = new Set();   // `${wallet}::${tokenId}`
let _activeTopicCtx = null;        // { wallet, tokenId, topicId, topicKey }

/** Lobby chat input is the single universal input. When a topic popup
 *  is open, it sets the active topic so sendMessage routes there.
 *  When closed (no popup), getActiveTopic() returns null and callers
 *  fall back to the default 'brain' topic. */
export function setActiveTopic(ctx) {
    _activeTopicCtx = ctx || null;
    document.dispatchEvent(new CustomEvent('dexhero:active-topic-changed', { detail: _activeTopicCtx }));
}
export function getActiveTopic() {
    return _activeTopicCtx;
}

function cacheKey(walletAddr, tokenId) {
    return `${String(walletAddr || '').toLowerCase()}::${tokenId}`;
}

async function authedFetch(url, init = {}) {
    const status = wallet.getStatus?.();
    const addr = status?.address?.toLowerCase();
    if (!addr) {
        const e = new Error('wallet_not_connected');
        e.code = 'wallet_not_connected';
        throw e;
    }
    let session = vault.getStoredSession?.(addr);
    if (!session) {
        // Mint via the existing vault flow (one signature).
        try { session = await vault.ensureSession(addr); }
        catch (err) { throw err; }
    }
    const headers = Object.assign(
        { authorization: `Bearer ${session.token}` },
        init.headers || {},
    );
    let r = await fetch(url, { ...init, headers });
    if (r.status === 401) {
        // Token expired → wipe + retry once
        vault.clearStoredSession?.(addr);
        session = await vault.ensureSession(addr);
        const headers2 = Object.assign(
            { authorization: `Bearer ${session.token}` },
            init.headers || {},
        );
        r = await fetch(url, { ...init, headers: headers2 });
    }
    return r;
}

export function getCachedTopics(walletAddr, tokenId) {
    return _topicsCache.get(cacheKey(walletAddr, tokenId)) || null;
}

export async function listTopics(walletAddr, tokenId) {
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics`);
    if (!r.ok) {
        const e = new Error('list_failed'); e.status = r.status; throw e;
    }
    const { topics } = await r.json();
    _topicsCache.set(cacheKey(walletAddr, tokenId), topics || []);
    await e2e.cachePutTopics?.(topics || []);
    document.dispatchEvent(new CustomEvent('dexhero:topics-changed', { detail: { wallet: walletAddr, tokenId } }));
    return topics || [];
}

export async function bootstrapTopics(walletAddr, tokenId) {
    const key = cacheKey(walletAddr, tokenId);
    if (_bootstrapped.has(key)) return _topicsCache.get(key) || [];
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics/bootstrap`, { method: 'POST' });
    if (!r.ok) {
        const e = new Error('bootstrap_failed'); e.status = r.status; throw e;
    }
    const { topics } = await r.json();
    _topicsCache.set(key, topics || []);
    _bootstrapped.add(key);
    await e2e.cachePutTopics?.(topics || []);
    document.dispatchEvent(new CustomEvent('dexhero:topics-changed', { detail: { wallet: walletAddr, tokenId } }));
    return topics || [];
}

/** Idempotent: returns the existing topic with the same topic_key when
 *  present, otherwise creates a custom topic. */
export async function createTopic(walletAddr, tokenId, { name, icon } = {}) {
    if (!name || !String(name).trim()) {
        const e = new Error('name_required'); e.code = 'name_required'; throw e;
    }
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, icon: icon || null }),
    });
    if (!r.ok) {
        const e = new Error('create_failed'); e.status = r.status; throw e;
    }
    const { topic } = await r.json();
    const key = cacheKey(walletAddr, tokenId);
    const cur = _topicsCache.get(key) || [];
    _topicsCache.set(key, [...cur, topic]);
    document.dispatchEvent(new CustomEvent('dexhero:topics-changed', { detail: { wallet: walletAddr, tokenId } }));
    return topic;
}

export async function patchTopic(walletAddr, tokenId, topicId, patch) {
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics/${encodeURIComponent(topicId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch || {}),
    });
    if (!r.ok) {
        const e = new Error('patch_failed'); e.status = r.status; throw e;
    }
    const { topic } = await r.json();
    const key = cacheKey(walletAddr, tokenId);
    const cur = _topicsCache.get(key) || [];
    _topicsCache.set(key, cur.map((t) => t.topic_id === topicId ? topic : t));
    document.dispatchEvent(new CustomEvent('dexhero:topics-changed', { detail: { wallet: walletAddr, tokenId } }));
    return topic;
}

export async function deleteTopic(walletAddr, tokenId, topicId) {
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics/${encodeURIComponent(topicId)}`, {
        method: 'DELETE',
    });
    if (!r.ok) {
        const e = new Error('delete_failed'); e.status = r.status; throw e;
    }
    const key = cacheKey(walletAddr, tokenId);
    const cur = _topicsCache.get(key) || [];
    _topicsCache.set(key, cur.filter((t) => t.topic_id !== topicId));
    document.dispatchEvent(new CustomEvent('dexhero:topics-changed', { detail: { wallet: walletAddr, tokenId } }));
}

/** Append an already-encrypted EncMsg to a topic. Handles the 409
 *  idempotent return path silently. */
export async function appendEncryptedMessage(walletAddr, tokenId, topicId, encMsg) {
    const r = await authedFetch(`/api/dexhero/${encodeURIComponent(tokenId)}/topics/${encodeURIComponent(topicId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encMsg),
    });
    if (!r.ok) {
        const e = new Error('append_failed'); e.status = r.status; throw e;
    }
    const { message } = await r.json();
    if (message) await e2e.cachePutMessages?.(walletAddr, tokenId, [message]);
    return message;
}

/** Encrypt + append in one call. Returns the server row. */
export async function sendPlaintext(walletAddr, tokenId, topicId, role, plaintext, opts = {}) {
    const enc = await e2e.encryptMessage(walletAddr, tokenId, topicId, role, plaintext, opts);
    return await appendEncryptedMessage(walletAddr, tokenId, topicId, enc);
}

/** Find the default topic by its key for the current DexHero, bootstrapping if needed. */
export async function getDefaultTopic(walletAddr, tokenId, topicKey) {
    let topics = getCachedTopics(walletAddr, tokenId);
    if (!topics) {
        try { topics = await bootstrapTopics(walletAddr, tokenId); }
        catch { topics = []; }
    }
    return topics.find((t) => t.topic_key === topicKey) || null;
}
