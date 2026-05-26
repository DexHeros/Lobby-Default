/* DexHero proactive settings — client wrapper for the GET/PUT
 * endpoints at server.js. Owner-gated PUT signs `DexHero Brain <ts>`,
 * same pattern as saveBrainConfig (the brain endpoint reuses this
 * signed-message namespace by design — one auth surface for all
 * workshop edits). */

import * as wallet from './wallet.js';

export async function getProactiveSettings(tokenId) {
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/proactive-settings`);
    if (!r.ok) {
        const err = new Error(`proactive_read_${r.status}`);
        err.status = r.status;
        throw err;
    }
    return await r.json();
}

export async function saveProactiveSettings(tokenId, settings) {
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) {
        throw new Error('wallet_not_connected');
    }
    const ts = Date.now();
    const signedMsg = `DexHero Brain ${ts}`;
    const signature = await wallet.signMessage(signedMsg);
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/proactive-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            wallet:    status.address,
            signature,
            signedMsg,
            ...settings,
        }),
    });
    if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `proactive_write_${r.status}`);
        err.status = r.status;
        err.body = body;
        throw err;
    }
    return await r.json();
}
