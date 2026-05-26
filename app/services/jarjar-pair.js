/* JarJar pair flow — client wrapper for the lobby-side endpoints.
 *
 * Lobby calls `beginPair()` to mint a one-time `pair_token` the user
 * pastes into JarJar's desktop CLI (or scans via QR). When the
 * desktop side completes /pair/complete, status flips to active.
 *
 * No polling helpers here — the modal calls `getInstalls()` on a
 * timer to detect the pair completing. */

import * as wallet from './wallet.js';

/** Sign `DexHero Brain <ts>` for any of the install endpoints. The
 *  server's auth gate is the same surface the brain + voice + schedule
 *  editors use; one signed message gets us through every install op. */
async function signedAuth() {
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) throw new Error('wallet_not_connected');
    const ts = Date.now();
    const signedMsg = `DexHero Brain ${ts}`;
    const signature = await wallet.signMessage(signedMsg);
    return { wallet: status.address, signature, signedMsg };
}

export async function beginPair({ label } = {}) {
    const auth = await signedAuth();
    const r = await fetch('/api/jarjar/pair/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...auth, label }),
    });
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `pair_begin_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();   // { install_id, pair_token, expires_at, pair_message_prefix }
}

export async function getInstalls() {
    const auth = await signedAuth();
    const qs = new URLSearchParams(auth).toString();
    const r = await fetch(`/api/jarjar/installs?${qs}`);
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `installs_list_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();   // { installs: [...] }
}

export async function revokeInstall(install_id) {
    const auth = await signedAuth();
    const r = await fetch('/api/jarjar/installs/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ install_id, ...auth }),
    });
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `revoke_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();
}
