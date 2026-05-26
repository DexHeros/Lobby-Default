/* DexHero end-to-end encryption worker.
 *
 *   Runs off the main thread so decrypting a long history (potentially
 *   hundreds of messages) never janks UI paint. Plain (non-module)
 *   worker so it loads everywhere with no extra HTTP MIME-type config.
 *
 *   Protocol — main → worker:
 *     { id, op: 'init_key', wallet, keyBytes }            // keyBytes: Uint8Array
 *     { id, op: 'encrypt',  wallet, plaintext, aad, iv }  // iv: Uint8Array
 *     { id, op: 'decrypt',  wallet, ciphertextB64, ivB64, tagB64, aadStr }
 *
 *   Protocol — worker → main:
 *     { id, ok: true, result }
 *     { id, ok: false, code, error }
 */

'use strict';

const _keys = new Map();   // walletLower → CryptoKey

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}
function b64decode(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function initKey(wallet, keyBytes) {
    const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );
    _keys.set(String(wallet || '').toLowerCase(), key);
    return { ok: true };
}

async function doEncrypt(wallet, plaintext, aadStr, iv) {
    const key = _keys.get(String(wallet || '').toLowerCase());
    if (!key) throw Object.assign(new Error('key_missing'), { code: 'key_missing' });
    const aadBytes = enc.encode(aadStr);
    const buf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aadBytes },
        key,
        enc.encode(plaintext),
    );
    const raw = new Uint8Array(buf);
    // Web Crypto returns ciphertext|tag concatenated; split for storage.
    const tag = raw.subarray(raw.length - 16);
    const ct  = raw.subarray(0, raw.length - 16);
    return {
        ciphertext_b64: b64encode(ct),
        iv_b64:         b64encode(iv),
        tag_b64:        b64encode(tag),
        aad_b64:        b64encode(aadBytes),
    };
}

async function doDecrypt(wallet, ciphertextB64, ivB64, tagB64, aadStr) {
    const key = _keys.get(String(wallet || '').toLowerCase());
    if (!key) throw Object.assign(new Error('key_missing'), { code: 'key_missing' });
    const ct  = b64decode(ciphertextB64);
    const iv  = b64decode(ivB64);
    const tag = b64decode(tagB64);
    const aadBytes = enc.encode(aadStr);
    // Recombine ciphertext + tag for Web Crypto.
    const ctWithTag = new Uint8Array(ct.length + tag.length);
    ctWithTag.set(ct);
    ctWithTag.set(tag, ct.length);
    try {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: aadBytes },
            key,
            ctWithTag,
        );
        return { plaintext: dec.decode(plain) };
    } catch (err) {
        // GCM auth failure → wrong key OR tampered ciphertext / AAD.
        throw Object.assign(new Error('auth_fail'), { code: 'auth_fail', cause: err });
    }
}

self.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    const id  = msg.id;
    try {
        let result;
        if (msg.op === 'init_key') {
            result = await initKey(msg.wallet, msg.keyBytes);
        } else if (msg.op === 'encrypt') {
            result = await doEncrypt(msg.wallet, msg.plaintext, msg.aad, msg.iv);
        } else if (msg.op === 'decrypt') {
            result = await doDecrypt(msg.wallet, msg.ciphertextB64, msg.ivB64, msg.tagB64, msg.aadStr);
        } else if (msg.op === 'forget_key') {
            _keys.delete(String(msg.wallet || '').toLowerCase());
            result = { ok: true };
        } else {
            throw Object.assign(new Error('unknown_op'), { code: 'unknown_op' });
        }
        self.postMessage({ id, ok: true, result });
    } catch (err) {
        self.postMessage({
            id, ok: false,
            code: err.code || 'worker_error',
            error: err.message || String(err),
        });
    }
});
