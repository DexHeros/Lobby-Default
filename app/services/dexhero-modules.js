/* dexhero-modules.js — client wrapper for the Agent Store catalog +
 * equip endpoints (Phase 6 of the slot+marketplace roadmap).
 *
 * The slot pickers call equip(tokenId, slot, moduleId) when the user
 * swaps an item; the server persists the choice in
 * dexhero_equipped_modules and the next /api/jarjar/recipes/:tokenId
 * fetch picks up the change.
 *
 * For the platform-default Truffle Man subject (id 'truffle-default'),
 * equip is a no-op — equipped state is held in localStorage only since
 * there is no on-chain token to attribute the choice to. Same goes for
 * a disconnected wallet.
 *
 * The signed-message pattern matches the existing
 * `DexHero Brain <ts>` flow used by the brain + voice + schedule
 * editors — one signature gets us through every workshop write.
 */

import * as wallet from './wallet.js';

const PLATFORM_DEFAULT_TOKEN = 'truffle-default';

/** True when the picker should write server-side. False = localStorage
 *  only. */
function canPersistServerSide(tokenId) {
    if (!tokenId) return false;
    if (tokenId === PLATFORM_DEFAULT_TOKEN) return false;
    const status = wallet.getStatus?.();
    return !!(status?.connected && status?.address);
}

async function signedAuth() {
    const status = wallet.getStatus?.();
    if (!status?.connected || !status.address) throw new Error('wallet_not_connected');
    const ts = Date.now();
    const signedMsg = `DexHero Brain ${ts}`;
    const signature = await wallet.signMessage(signedMsg);
    return { wallet: status.address, signature, signedMsg };
}

/** Equip a module on one of the DexHero's slots. Returns
 *  `{ ok: true, module, granted? }` on success.
 *
 *  Silent no-op (returns `{ skipped: true }`) when persisting server-
 *  side isn't applicable — keeps the local swap path snappy and the
 *  caller doesn't need to branch on subject type. */
export async function equip(tokenId, slot, moduleId) {
    if (!canPersistServerSide(tokenId)) return { skipped: true };
    if (!slot || !moduleId) throw new Error('missing_slot_or_module');
    const auth = await signedAuth();
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/equip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot, module_id: moduleId, ...auth }),
    });
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `equip_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();
}

/** Fetch the currently equipped modules for a DexHero. Public read —
 *  no auth required. Returns
 *  `{ equipped: { body?, movement?, voice?, brain? } }`. */
export async function getEquipped(tokenId) {
    if (!tokenId) return { equipped: {} };
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/equipped`);
    if (!r.ok) return { equipped: {} };
    try { return await r.json(); } catch { return { equipped: {} }; }
}

/** Catalog browse. Filter chips + the slot picker discovery path.
 *  Optional `sort` aligns with the filter chips: top / new / free / all. */
export async function listModules({ category, top, wallet: walletAddr, sort } = {}) {
    const u = new URL('/api/modules', window.location.origin);
    if (category) u.searchParams.set('category', category);
    if (top != null) u.searchParams.set('top', String(top));
    if (walletAddr) u.searchParams.set('wallet', walletAddr);
    if (sort) u.searchParams.set('sort', sort);
    const r = await fetch(u.toString());
    if (!r.ok) return { modules: [] };
    try { return await r.json(); } catch { return { modules: [] }; }
}

/** Community ranking — like / unlike a module. Same wallet sig
 *  pattern as every other workshop write. Returns the fresh like
 *  count so the heart UI updates without a second round-trip. */
export async function likeModule(moduleId)   { return _likeReq(moduleId, 'POST'); }
export async function unlikeModule(moduleId) { return _likeReq(moduleId, 'DELETE'); }

async function _likeReq(moduleId, method) {
    const auth = await signedAuth();
    const r = await fetch(`/api/modules/${encodeURIComponent(moduleId)}/like`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(auth),
    });
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `like_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();   // { ok, like_count }
}

/** Creator publish — Phase 2 of the Agent Store roadmap.
 *
 *  One signature, one POST. Submits a new module under the connected
 *  wallet's creator identity. In non-production the row auto-approves
 *  to `live` server-side so the user can equip it immediately; in
 *  production it lands as `pending_review` for admin approval.
 *
 *  Caller passes the always-visible fields plus the category-specific
 *  `spec` (BrainSpec / VoiceSpec / MovementSpec / BodySpec — see
 *  JarJar/packages/jarjar-agent-modules/src/types.ts).
 *
 *  Throws with `.body.error` on validation / signature / DB failures
 *  so the panel can surface the specific code inline. */
export async function publishModule({ name, description, category, price_usdc, spec, image_url, asset_url, royalty_bps } = {}) {
    const status = wallet.getStatus?.();
    if (!status?.connected || !status.address) throw new Error('wallet_not_connected');
    const ts = Date.now();
    const signedMsg = `DexHero Brain ${ts}`;
    const signature = await wallet.signMessage(signedMsg);
    const r = await fetch('/api/modules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            wallet: status.address,
            signature,
            signedMsg,
            name,
            description,
            category,
            price_usdc,
            spec,
            image_url,
            asset_url,
            royalty_bps,
        }),
    });
    if (!r.ok) {
        let body = null; try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `publish_${r.status}`);
        err.status = r.status; err.body = body; throw err;
    }
    return await r.json();
}

/** Wallet's owned modules — for the slot picker's inventory merge. */
export async function listOwnedModules({ wallet: walletAddr, category } = {}) {
    if (!walletAddr) return { modules: [] };
    const u = new URL('/api/modules/owned', window.location.origin);
    u.searchParams.set('wallet', walletAddr);
    if (category) u.searchParams.set('category', category);
    const r = await fetch(u.toString());
    if (!r.ok) return { modules: [] };
    try { return await r.json(); } catch { return { modules: [] }; }
}
