/* DexHero brain config — client-side CRUD wrapper.
 *
 * Read: anyone — surfaces the current LLM choice + the allowlist + the
 *       default, so the brain picker can render its options against the
 *       server-authoritative list rather than a hardcoded UI table.
 * Write: owner-gated — the user signs `DexHero Brain <ts>` with the wallet
 *       that owns the token. Mirrors the chat-send signature pattern in
 *       server.js so we don't invent a new auth surface.
 */

import * as wallet from './wallet.js';

/** GET /api/dexhero/:tokenId/brain — returns:
 *  {token_id, owner_wallet, intelligence:{model,…}, behavior, allowed_models[], default_model, updated_at} */
export async function getBrainConfig(tokenId) {
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/brain`);
    if (!r.ok) {
        const err = new Error(`brain_config_read_${r.status}`);
        err.status = r.status;
        throw err;
    }
    return await r.json();
}

/** PUT /api/dexhero/:tokenId/brain — owner-gated.
 *  Signs `DexHero Brain <ts>` and sends the new intelligence block. The
 *  server validates `intelligence.model` against the allowlist. Returns
 *  the stored row on success.
 *
 *  Optional `extras`:
 *    voicePresetId  — when set, the server piggybacks a voice equipped
 *                     row write (slot='voice', module_id=`platform:voice:<id>`)
 *                     in the same transaction so the Voice slot popover
 *                     and JarJar's recipe agree, no second signature.
 *
 *  Throws on signature failure, non-owner, or invalid model — the brain
 *  picker should surface the `.body.error` code to the user. */
export async function saveBrainConfig(tokenId, intelligence, behavior, extras = {}) {
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) {
        throw new Error('wallet_not_connected');
    }
    const ts = Date.now();
    const signedMsg = `DexHero Brain ${ts}`;
    const signature = await wallet.signMessage(signedMsg);
    const payload = {
        wallet:    status.address,
        signature,
        signedMsg,
        intelligence,
        behavior: behavior || {},
    };
    if (extras.voicePresetId) payload.voice_preset_id = extras.voicePresetId;
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/brain`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `brain_config_write_${r.status}`);
        err.status = r.status;
        err.body = body;
        throw err;
    }
    return await r.json();
}
