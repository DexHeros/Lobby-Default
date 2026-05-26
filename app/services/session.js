/* V3Labs session cache — client-side user cache.
   Stores per-wallet derived state (primary hero, tier, recent tokens, referral code).
   Persisted to localStorage as a single JSON blob keyed by wallet address. */

const KEY = 'dexhero_session_v1';
const TTL = 5 * 60 * 1000; // 5 minutes per field

function loadAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch { return {}; }
}

function saveAll(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
}

function bucket(wallet) {
    const all = loadAll();
    if (!all[wallet]) all[wallet] = { _ts: {} };
    return { all, slot: all[wallet] };
}

export function getField(wallet, field) {
    if (!wallet) return null;
    const { slot } = bucket(wallet);
    const ts = slot._ts?.[field] || 0;
    if (Date.now() - ts > TTL) return null;
    return slot[field] ?? null;
}

export function setField(wallet, field, value) {
    if (!wallet) return;
    const { all, slot } = bucket(wallet);
    slot[field] = value;
    slot._ts[field] = Date.now();
    all[wallet] = slot;
    saveAll(all);
}

export function clearField(wallet, field) {
    if (!wallet) return;
    const { all, slot } = bucket(wallet);
    delete slot[field];
    if (slot._ts) delete slot._ts[field];
    saveAll(all);
}

export function clearWallet(wallet) {
    if (!wallet) return;
    const all = loadAll();
    delete all[wallet];
    saveAll(all);
}

/* Recent tokens — MRU, capped at N */
export function pushRecentToken(wallet, token) {
    if (!wallet || !token?.address) return;
    const existing = getField(wallet, 'recentTokens') || [];
    const next = [token, ...existing.filter((t) => t.address !== token.address)].slice(0, 8);
    setField(wallet, 'recentTokens', next);
}

export function getRecentTokens(wallet) {
    return (wallet && getField(wallet, 'recentTokens')) || [];
}
