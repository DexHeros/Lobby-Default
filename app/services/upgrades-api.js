/* Upgrades API client — thin fetch wrapper over the Stage B server
 * endpoints in server.js (lib/upgrades-store.js backed).
 *
 * Same exported shape as upgrades-mock.js where possible so the UI
 * layer can swap modules without changes. Stage A's mock remains the
 * fallback when:
 *   • Feature flag `dexhero:upgrades:backend` is not set in localStorage
 *   • Server returns non-2xx (treat as offline)
 *   • Network failure
 *
 * Flip the flag from devtools to opt in to the server backend:
 *   localStorage['dexhero:upgrades:backend'] = '1'
 *
 * Once Supabase persistence is wired (Stage B.1) the flag becomes
 * default-on for wallet-connected users.
 */

import * as walletSvc from './wallet.js';

const BACKEND_FLAG = 'dexhero:upgrades:backend';

export function isBackendEnabled() {
    try { return localStorage.getItem(BACKEND_FLAG) === '1'; } catch { return false; }
}

export function enableBackend() {
    try { localStorage.setItem(BACKEND_FLAG, '1'); } catch {}
}

export function disableBackend() {
    try { localStorage.removeItem(BACKEND_FLAG); } catch {}
}

/* Resolve the wallet query param the server uses to key user data.
 * Mirrors _resolveUserPrefKey on the server. */
function _walletParam() {
    try {
        const wstate = walletSvc.getStatus?.();
        const addr = wstate?.address;
        if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) return `?wallet=${addr.toLowerCase()}`;
    } catch {}
    return '';
}

async function _get(path) {
    const r = await fetch(path, { credentials: 'include' });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.json();
}

async function _post(path, body) {
    const r = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`POST ${path} → ${r.status} ${t}`);
    }
    return r.json();
}

/* ── Reads ─────────────────────────────────────────────── */

export async function listPatches({ sort = 'top', surface = 'all', limit = 200 } = {}) {
    const qs = new URLSearchParams({ sort, surface, limit: String(limit) });
    const { patches } = await _get(`/api/upgrades?${qs.toString()}`);
    return patches || [];
}

export async function getPatch(id) {
    const { patch } = await _get(`/api/upgrades/${encodeURIComponent(id)}`);
    return patch;
}

export async function getCommits() {
    const { commits, head } = await _get(`/api/upgrades/commits${_walletParam()}`);
    return { commits: commits || [], head };
}

export async function creatorLeaderboard(limit = 12) {
    const { creators } = await _get(`/api/upgrades/creator-leaderboard?limit=${limit}`);
    return creators || [];
}

/* ── Writes ────────────────────────────────────────────── */

export async function commitAuthor(patch) {
    const { commit } = await _post(`/api/upgrades/commits${_walletParam()}`, {
        op: 'author',
        patch,
    });
    return commit;
}

export async function commitAdopt(patchId) {
    const { commit } = await _post(`/api/upgrades/commits${_walletParam()}`, {
        op: 'adopt',
        patch_id: patchId,
    });
    return commit;
}

export async function commitRevert(commitIdToRevert, { message = '' } = {}) {
    const { commit } = await _post(`/api/upgrades/commits${_walletParam()}`, {
        op: 'revert',
        reverts_commit: commitIdToRevert,
        message,
    });
    return commit;
}

export async function commitToggle(patchId) {
    const { commit } = await _post(`/api/upgrades/commits${_walletParam()}`, {
        op: 'toggle',
        patch_id: patchId,
    });
    return commit;
}

export async function checkoutCommit(commitId) {
    const { head } = await _post(`/api/upgrades/checkout${_walletParam()}`, {
        commit_id: commitId,
    });
    return head;
}

export async function promotePatch(patchId) {
    const { patch } = await _post(`/api/upgrades/${encodeURIComponent(patchId)}/promote${_walletParam()}`, {});
    return patch;
}

export async function unpromotePatch(patchId) {
    const { patch } = await _post(`/api/upgrades/${encodeURIComponent(patchId)}/unpromote${_walletParam()}`, {});
    return patch;
}

/* ── Autonomous agent (Item 6) ─────────────────────────── */

/* Trigger one autonomous-scan tick on the server. The client owns the
 * cadence + opt-in state (see app/services/autonomous-agent.js); this
 * is just a fetch wrapper around the /scan-now endpoint. */
export async function autonomousScanNow({ tokenId, wallet, handle, llmKey, llmProvider, llmModel, budgetUsd, manual = false }) {
    // 90s hard timeout — a hung brain call shouldn't pin a tick forever.
    // The brain can stall on unresponsive providers; we'd rather report
    // a timeout and try again next tick than block the user's UI.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('autonomous_timeout'), 90_000);
    try {
        const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId || 'truffle-default')}/autonomous/scan-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: ac.signal,
            body: JSON.stringify({
                wallet, handle,
                user_llm_key: llmKey,
                user_llm_provider: llmProvider,
                user_llm_model: llmModel,
                budget_usd: budgetUsd,
                manual: !!manual,
            }),
        });
        return await r.json();   // { ok, patch?, commit?, status, code? }
    } catch (err) {
        if (err?.name === 'AbortError' || /autonomous_timeout/.test(String(err))) {
            return { ok: false, code: 'timeout', detail: 'brain call exceeded 90s' };
        }
        return { ok: false, code: 'fetch_error', detail: err?.message || String(err) };
    } finally {
        clearTimeout(timer);
    }
}

export async function autonomousStatus({ tokenId, wallet }) {
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId || 'truffle-default')}/autonomous/status?wallet=${encodeURIComponent(wallet)}`, {
        credentials: 'include',
    });
    if (!r.ok) return null;
    return r.json();   // { status, defaults }
}

/* Dev helper exposed on window for browser console */
if (typeof window !== 'undefined') {
    window.DexHeroUpgradesAPI = {
        isBackendEnabled, enableBackend, disableBackend,
        listPatches, getPatch, getCommits, creatorLeaderboard,
        commitAuthor, commitAdopt, commitRevert, commitToggle,
        checkoutCommit, promotePatch, unpromotePatch,
    };
}
