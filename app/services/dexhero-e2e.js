/* DexHero end-to-end encryption + IndexedDB cache for per-topic chat.
 *
 *   Hybrid zero-knowledge: server stores ciphertext + iv + tag + AAD,
 *   we never give it the key. The key is derived from a one-time wallet
 *   signature ("DexHero E2E Key v1: <wallet>") and lives only in
 *   sessionStorage (cleared on tab close). Same wallet on any device
 *   re-derives the same key by re-signing.
 *
 *   All crypto runs in a Web Worker (app/workers/dexhero-e2e-worker.js)
 *   so decrypting a long history doesn't jank UI paint.
 *
 *   IndexedDB cache:
 *     db: dexhero-e2e-cache
 *     store messages: keyPath=message_id, indexes
 *                      'topic_msgs'  on [wallet_address, token_id, topic_id, created_at]
 *                      'token_union' on [wallet_address, token_id, created_at]
 *     store topics:   keyPath=topic_id, plaintext metadata
 *     store meta:     keyPath=k, last-sync per (wallet,token)
 */

import * as wallet from './wallet.js';

const SESSION_KEY_PREFIX = 'dexhero-e2e-key:';   // sessionStorage
const SIG_CANON          = (addr) => `DexHero E2E Key v1\nWallet: ${String(addr || '').toLowerCase()}`;
const KEY_VERSION        = 1;

const DB_NAME    = 'dexhero-e2e-cache';
const DB_VERSION = 1;

let _worker = null;
let _workerNextId = 1;
const _workerPending = new Map();   // id → { resolve, reject }
let _dbPromise = null;
let _keyMismatchHandlers = new Set();

// ─── Worker plumbing ──────────────────────────────────────────────────

function getWorker() {
    if (_worker) return _worker;
    // Resolve relative to this module so it works whether the app is
    // served from /, /app/, or behind a proxy.
    const url = new URL('../workers/dexhero-e2e-worker.js', import.meta.url);
    _worker = new Worker(url);
    _worker.addEventListener('message', (ev) => {
        const msg = ev.data || {};
        const pending = _workerPending.get(msg.id);
        if (!pending) return;
        _workerPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else {
            const err = new Error(msg.error || 'worker_error');
            err.code = msg.code || 'worker_error';
            pending.reject(err);
        }
    });
    _worker.addEventListener('error', (ev) => {
        console.error('[dexhero-e2e] worker error:', ev.message || ev);
    });
    return _worker;
}

function workerCall(payload, transferables) {
    const id = _workerNextId++;
    return new Promise((resolve, reject) => {
        _workerPending.set(id, { resolve, reject });
        getWorker().postMessage({ id, ...payload }, transferables || []);
    });
}

// ─── Key derivation ───────────────────────────────────────────────────

function sessionKeyFor(walletAddr) {
    return SESSION_KEY_PREFIX + String(walletAddr || '').toLowerCase();
}

function bytesToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}
function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function sha256Bytes(input) {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const buf = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(buf);
}

async function deriveKey(walletAddr) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr) throw Object.assign(new Error('wallet_not_connected'), { code: 'wallet_not_connected' });
    const status = wallet.getStatus?.();
    if (!status?.connected || status.address?.toLowerCase() !== addr) {
        throw Object.assign(new Error('wallet_not_connected'), { code: 'wallet_not_connected' });
    }
    let signature;
    try {
        signature = await wallet.signMessage(SIG_CANON(addr));
    } catch (err) {
        const e = new Error('signature_rejected');
        e.code = 'signature_rejected';
        e.cause = err;
        throw e;
    }
    if (typeof signature !== 'string' || signature.length < 10) {
        throw Object.assign(new Error('signature_invalid'), { code: 'signature_invalid' });
    }
    const keyBytes = await sha256Bytes(signature);
    const fpBytes  = await sha256Bytes(keyBytes);
    const fingerprint = Array.from(fpBytes.subarray(0, 6))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
        sessionStorage.setItem(sessionKeyFor(addr), JSON.stringify({
            v: KEY_VERSION,
            key: bytesToBase64(keyBytes),
            fingerprint,
        }));
    } catch {}
    // Hand the bytes to the worker (cloned, then erase our copy).
    await workerCall({ op: 'init_key', wallet: addr, keyBytes });
    return { fingerprint };
}

function loadStoredKey(walletAddr) {
    try {
        const raw = sessionStorage.getItem(sessionKeyFor(walletAddr));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (obj?.v !== KEY_VERSION || typeof obj.key !== 'string') return null;
        return { keyBytes: base64ToBytes(obj.key), fingerprint: obj.fingerprint || '' };
    } catch { return null; }
}

/** Ensure an E2E key is loaded into the worker for this wallet. If
 *  sessionStorage holds one, push it to the worker. Otherwise prompt
 *  the user for ONE signature to derive a fresh key. Idempotent —
 *  safe to call before every encrypt/decrypt. */
export async function ensureKey(walletAddr) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr) throw Object.assign(new Error('wallet_not_connected'), { code: 'wallet_not_connected' });
    const stored = loadStoredKey(addr);
    if (stored) {
        await workerCall({ op: 'init_key', wallet: addr, keyBytes: stored.keyBytes });
        return { fingerprint: stored.fingerprint };
    }
    return await deriveKey(addr);
}

export function getStoredFingerprint(walletAddr) {
    const stored = loadStoredKey(walletAddr);
    return stored?.fingerprint || '';
}

export function forgetKey(walletAddr) {
    const addr = String(walletAddr || '').toLowerCase();
    try { sessionStorage.removeItem(sessionKeyFor(addr)); } catch {}
    workerCall({ op: 'forget_key', wallet: addr }).catch(() => {});
}

export function onKeyMismatch(handler) {
    _keyMismatchHandlers.add(handler);
    return () => _keyMismatchHandlers.delete(handler);
}
function emitKeyMismatch(detail) {
    for (const h of _keyMismatchHandlers) { try { h(detail); } catch {} }
}

// ─── AAD ──────────────────────────────────────────────────────────────

function aadString(walletAddr, tokenId, topicId, role) {
    return `v=1|wallet=${String(walletAddr).toLowerCase()}|token=${tokenId}|topic=${topicId}|role=${role}`;
}

// ─── Public encrypt / decrypt API ─────────────────────────────────────

function uuidv4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const r = crypto.getRandomValues(new Uint8Array(16));
    r[6] = (r[6] & 0x0f) | 0x40;
    r[8] = (r[8] & 0x3f) | 0x80;
    const h = [...r].map((b) => b.toString(16).padStart(2, '0'));
    return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
}

/** Encrypt one plaintext message body. Returns the row-shape ready to
 *  POST to /api/dexhero/:tokenId/topics/:topicId/messages. Caller still
 *  supplies role, client_id (or we generate one), and the plaintext. */
export async function encryptMessage(walletAddr, tokenId, topicId, role, plaintext, opts = {}) {
    const addr = String(walletAddr || '').toLowerCase();
    const fp = await ensureKey(addr);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = aadString(addr, tokenId, topicId, role);
    const env = JSON.stringify({ v: 1, content: String(plaintext), ts: Date.now() });
    const out = await workerCall({ op: 'encrypt', wallet: addr, plaintext: env, aad, iv });
    return {
        client_id:      opts.clientId || uuidv4(),
        role,
        schema_version: 1,
        key_fingerprint: fp.fingerprint,
        ciphertext_b64: out.ciphertext_b64,
        iv_b64:         out.iv_b64,
        tag_b64:        out.tag_b64,
        aad_b64:        out.aad_b64,
    };
}

/** Decrypt one server row. Returns { content, ts, role } on success or
 *  null if the row can't be decrypted (raises a key-mismatch event). */
export async function decryptMessage(walletAddr, encRow) {
    const addr = String(walletAddr || '').toLowerCase();
    try {
        await ensureKey(addr);
        const aad = aadString(addr, encRow.token_id, encRow.topic_id, encRow.role);
        const out = await workerCall({
            op: 'decrypt',
            wallet: addr,
            ciphertextB64: encRow.ciphertext_b64,
            ivB64:         encRow.iv_b64,
            tagB64:        encRow.tag_b64,
            aadStr:        aad,
        });
        let env;
        try { env = JSON.parse(out.plaintext); }
        catch { return null; }
        return {
            content: typeof env.content === 'string' ? env.content : '',
            ts:      Number.isFinite(env.ts) ? env.ts : Date.parse(encRow.created_at) || Date.now(),
            role:    encRow.role,
        };
    } catch (err) {
        if (err.code === 'auth_fail') {
            emitKeyMismatch({ wallet: addr, message_id: encRow.message_id });
        }
        return null;
    }
}

// ─── IndexedDB cache ──────────────────────────────────────────────────

function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('messages')) {
                const s = db.createObjectStore('messages', { keyPath: 'message_id' });
                s.createIndex('topic_msgs',  ['wallet_address', 'token_id', 'topic_id', 'created_at']);
                s.createIndex('token_union', ['wallet_address', 'token_id', 'created_at']);
            }
            if (!db.objectStoreNames.contains('topics')) {
                db.createObjectStore('topics', { keyPath: 'topic_id' });
            }
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta', { keyPath: 'k' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _dbPromise;
}

async function tx(storeNames, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const stores = Array.isArray(storeNames)
            ? Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]))
            : t.objectStore(storeNames);
        Promise.resolve(fn(stores)).then((r) => {
            t.oncomplete = () => resolve(r);
            t.onerror    = () => reject(t.error);
        }).catch(reject);
    });
}

function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

export async function cachePutMessages(walletAddr, tokenId, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const addr = String(walletAddr || '').toLowerCase();
    await tx('messages', 'readwrite', async (store) => {
        for (const r of rows) {
            await reqAsPromise(store.put({
                message_id:    r.message_id,
                wallet_address: addr,
                token_id:      tokenId || r.token_id,
                topic_id:      r.topic_id,
                client_id:     r.client_id,
                role:          r.role,
                schema_version: r.schema_version,
                key_fingerprint: r.key_fingerprint,
                ciphertext_b64: r.ciphertext_b64,
                iv_b64:        r.iv_b64,
                tag_b64:       r.tag_b64,
                aad_b64:       r.aad_b64,
                created_at:    r.created_at,
            }));
        }
    });
}

export async function cachePutTopics(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    await tx('topics', 'readwrite', async (store) => {
        for (const r of rows) await reqAsPromise(store.put(r));
    });
}

async function readEncTopicMessages(walletAddr, tokenId, topicId) {
    const addr = String(walletAddr || '').toLowerCase();
    return await tx('messages', 'readonly', async (store) => {
        const idx = store.index('topic_msgs');
        const range = IDBKeyRange.bound(
            [addr, tokenId, topicId, ''],
            [addr, tokenId, topicId, '￿'],
        );
        const out = [];
        return await new Promise((resolve, reject) => {
            const req = idx.openCursor(range);
            req.onsuccess = () => {
                const cur = req.result;
                if (cur) { out.push(cur.value); cur.continue(); }
                else resolve(out);
            };
            req.onerror = () => reject(req.error);
        });
    });
}

async function readEncUnion(walletAddr, tokenId) {
    const addr = String(walletAddr || '').toLowerCase();
    return await tx('messages', 'readonly', async (store) => {
        const idx = store.index('token_union');
        const range = IDBKeyRange.bound(
            [addr, tokenId, ''],
            [addr, tokenId, '￿'],
        );
        return await new Promise((resolve, reject) => {
            const out = [];
            const req = idx.openCursor(range);
            req.onsuccess = () => {
                const cur = req.result;
                if (cur) { out.push(cur.value); cur.continue(); }
                else resolve(out);
            };
            req.onerror = () => reject(req.error);
        });
    });
}

/** Decrypted messages for one topic, ASC by created_at. */
export async function getCachedTopicMessages(walletAddr, tokenId, topicId) {
    const rows = await readEncTopicMessages(walletAddr, tokenId, topicId);
    rows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const out = [];
    for (const r of rows) {
        const d = await decryptMessage(walletAddr, r);
        if (d) out.push({ ...d, message_id: r.message_id, created_at: r.created_at, topic_id: r.topic_id });
    }
    return out;
}

/** Decrypted union of ALL topics for this DexHero, ASC. Used for LLM ctx. */
export async function getCachedUnionMessages(walletAddr, tokenId) {
    const rows = await readEncUnion(walletAddr, tokenId);
    rows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const out = [];
    for (const r of rows) {
        const d = await decryptMessage(walletAddr, r);
        if (d) out.push({ ...d, message_id: r.message_id, created_at: r.created_at, topic_id: r.topic_id });
    }
    return out;
}

/** Decrypt only the latest message for each topic, for sidebar previews.
 *  Returns Map<topicId, {content, ts, role}>. */
export async function getLatestPerTopic(walletAddr, tokenId) {
    const rows = await readEncUnion(walletAddr, tokenId);
    const latest = new Map();
    for (const r of rows) {
        const cur = latest.get(r.topic_id);
        if (!cur || (cur.created_at || '') < (r.created_at || '')) latest.set(r.topic_id, r);
    }
    const out = new Map();
    for (const [topicId, r] of latest) {
        const d = await decryptMessage(walletAddr, r);
        if (d) out.set(topicId, d);
    }
    return out;
}

async function getMeta(k) {
    return await tx('meta', 'readonly', async (store) => {
        const v = await reqAsPromise(store.get(k));
        return v?.v;
    });
}
async function setMeta(k, v) {
    await tx('meta', 'readwrite', async (store) => {
        await reqAsPromise(store.put({ k, v }));
    });
}

/** Pull any new rows from the server (incremental since last sync) and
 *  upsert into the cache. Does NOT decrypt — callers re-read via the
 *  getCached* APIs and decrypt on demand. */
export async function syncFromServer(walletAddr, tokenId) {
    const addr = String(walletAddr || '').toLowerCase();
    if (!addr || !tokenId) return;
    const lastKey = `sync:${addr}:${tokenId}`;
    const since = await getMeta(lastKey);
    const url = since
        ? `/api/dexhero/${encodeURIComponent(tokenId)}/messages?since=${encodeURIComponent(since)}&limit=1000`
        : `/api/dexhero/${encodeURIComponent(tokenId)}/messages?limit=1000`;
    const vault = await import('./llm-vault.js');
    const session = vault.getStoredSession?.(addr);
    if (!session) return;
    const r = await fetch(url, {
        headers: { authorization: `Bearer ${session.token}` },
    });
    if (!r.ok) return;
    const { messages } = await r.json().catch(() => ({ messages: [] }));
    if (Array.isArray(messages) && messages.length) {
        await cachePutMessages(addr, tokenId, messages);
        const lastTs = messages[messages.length - 1].created_at;
        if (lastTs) await setMeta(lastKey, lastTs);
    }
}
