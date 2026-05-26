/* Autonomous DNA-Feed agent — CLIENT SIDE scheduler.
 *
 * The user's LLM key lives in the per-wallet vault in app/services/
 * llm-connect.js (browser-side AES-GCM with a wallet signature). The
 * server can't read it, so the cadence runs HERE — the tab being open
 * is the bound for v0.
 *
 * Each tick:
 *   1. Unlock the active LLM provider key from the local vault
 *   2. POST /api/dexhero/:id/autonomous/scan-now with the key + wallet
 *   3. Server runs the brain round-trip + persists the patch
 *   4. Server returns { ok, patch, commit } — we dispatch the same
 *      dexhero:commit-added event the manual /upgrade flow uses so the
 *      DNA Feed rail prepends a new card live
 *
 * Opt-in state + cadence + budget all stored in localStorage so they
 * survive reloads. The loop reboots itself on every page load if the
 * user has opted in.
 *
 * Plan: Item 6 in i-want-you-to-twinkly-phoenix.md */

import { getRawKey, getActiveAccount } from './llm-connect.js';
import * as vault from './llm-vault.js';
import { autonomousScanNow, autonomousStatus } from './upgrades-api.js';
import * as wallet from './wallet.js';

const SETTINGS_KEY = 'dexhero:autonomous:settings:v1';
const STATUS_KEY   = 'dexhero:autonomous:status:v1';

const DEFAULTS = {
    enabled:     false,
    cadenceMin:  10,
    budgetUsd:   1.00,
};

const MIN_CADENCE_MIN = 1;     // dev-mode floor
const MAX_CADENCE_MIN = 1440;  // 24h ceiling

let _tickTimer = null;
let _running   = false;
let _lastError = null;

/* ── Settings (persisted) ────────────────────────────────── */

export function getSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...DEFAULTS, ...parsed };
    } catch {
        return { ...DEFAULTS };
    }
}

export function setSettings(patch) {
    const next = { ...getSettings(), ...patch };
    next.cadenceMin = Math.max(MIN_CADENCE_MIN, Math.min(MAX_CADENCE_MIN, Number(next.cadenceMin) || DEFAULTS.cadenceMin));
    next.budgetUsd  = Math.max(0.10, Math.min(50, Number(next.budgetUsd) || DEFAULTS.budgetUsd));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
    document.dispatchEvent(new CustomEvent('dexhero:autonomous-settings-changed', { detail: next }));
    // Re-arm timer if running
    if (next.enabled) startLoop({ immediate: false });
    else stopLoop();
    return next;
}

/* ── Local status (last result + counters mirrored from server) ─ */

export function getLocalStatus() {
    try {
        const raw = localStorage.getItem(STATUS_KEY);
        return raw ? JSON.parse(raw) : { lastTickTs: 0, lastCode: null, lastError: null };
    } catch {
        return { lastTickTs: 0, lastCode: null, lastError: null };
    }
}

function _updateLocalStatus(patch) {
    const cur = getLocalStatus();
    const next = { ...cur, ...patch };
    try { localStorage.setItem(STATUS_KEY, JSON.stringify(next)); } catch {}
    document.dispatchEvent(new CustomEvent('dexhero:autonomous-status', { detail: next }));
}

/* ── One tick ────────────────────────────────────────────── */

function _wallet() {
    try {
        const s = wallet.getStatus?.();
        const a = s?.address;
        return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
    } catch { return null; }
}

function _activeTokenId() {
    try { return window.__dexHero?.activeTokenId?.() || 'truffle-default'; } catch { return 'truffle-default'; }
}

function _handle() {
    try {
        return localStorage.getItem('dexhero:handle') || null;
    } catch { return null; }
}

export async function tickNow({ manual = false } = {}) {
    if (_running) return { ok: false, code: 'already_running' };
    _running = true;
    try {
        const wallet = _wallet();
        if (!wallet) {
            _lastError = 'no_wallet';
            _updateLocalStatus({ lastTickTs: Date.now(), lastCode: 'no_wallet' });
            return { ok: false, code: 'no_wallet' };
        }

        // Pull the active provider key from the local vault. If the
        // user hasn't unlocked it this session, getRawKey returns null
        // — they have to sign once via the LLM-connect dialog. We
        // surface the requirement in the local status.
        const account = getActiveAccount(wallet);
        if (!account || !account.providerId) {
            _updateLocalStatus({ lastTickTs: Date.now(), lastCode: 'no_brain_connected' });
            return { ok: false, code: 'no_brain_connected' };
        }

        // CRITICAL: only use the CACHED key. Triggering a fresh
        // signature prompt here from a background tick is exactly the
        // "site froze" symptom the user reported — the wallet popup
        // blocks the page until they dismiss it. If the vault isn't
        // unlocked, just warn and exit; the user unlocks by opening
        // LLM Connect once, then ticks proceed automatically.
        let rawKey = vault.getCachedKey(wallet, account.providerId)?.key || '';
        if (!rawKey) {
            // Try the no-prompt loadKeys path in case a session token
            // exists but the cache wasn't hydrated yet.
            try { await vault.loadKeys(wallet, { requireMint: false }); } catch {}
            rawKey = vault.getCachedKey(wallet, account.providerId)?.key || '';
        }
        if (!rawKey) {
            _updateLocalStatus({ lastTickTs: Date.now(), lastCode: 'vault_locked' });
            return { ok: false, code: 'vault_locked' };
        }

        const settings = getSettings();
        const tokenId  = _activeTokenId();
        const handle   = _handle() || wallet.slice(0, 8);

        const result = await autonomousScanNow({
            tokenId, wallet, handle,
            llmKey:      rawKey,
            llmProvider: account.providerId,
            llmModel:    account.model || '',
            budgetUsd:   settings.budgetUsd,
            manual,
        });

        if (result?.ok && result.commit && result.patch) {
            // Hand off to the same event the manual /upgrade flow uses
            // so the DNA Feed rail prepends a card live (no refresh).
            document.dispatchEvent(new CustomEvent('dexhero:commit-added', {
                detail: { commit: result.commit, patch: result.patch, source: 'autonomous' },
            }));
            _updateLocalStatus({
                lastTickTs: Date.now(),
                lastCode: 'ok',
                lastPatchId: result.patch.id,
                lastTitle: result.patch.title,
            });
            // Quiet success toast — feels good to see "yep, your
            // dexhero posted again" without it being noisy.
            try {
                const m = await import('../ui/toast.js');
                m.toast(`Auto posted: ${result.patch.title}`, { kind: 'ok', ttl: 3000 });
            } catch {}
        } else {
            _updateLocalStatus({
                lastTickTs: Date.now(),
                lastCode: result?.code || 'unknown_failure',
                lastError: result?.detail || null,
            });
        }
        return result;
    } catch (err) {
        _lastError = err?.message || 'tick_error';
        _updateLocalStatus({ lastTickTs: Date.now(), lastCode: 'fetch_error', lastError: _lastError });
        return { ok: false, code: 'fetch_error', error: _lastError };
    } finally {
        _running = false;
    }
}

/* ── The loop ────────────────────────────────────────────── */

function _scheduleNext() {
    const s = getSettings();
    if (!s.enabled) return;
    const ms = Math.max(MIN_CADENCE_MIN, s.cadenceMin) * 60 * 1000;
    clearTimeout(_tickTimer);
    _tickTimer = setTimeout(async () => {
        if (!getSettings().enabled) return;
        await tickNow({ manual: false });
        _scheduleNext();
    }, ms);
}

/* Start the loop. `immediate: true` fires a tick right now (used when
 * the user toggles ON via the Profile UI — they want to see content
 * appear without waiting 10 min). */
export function startLoop({ immediate = false } = {}) {
    const s = getSettings();
    if (!s.enabled) {
        setSettings({ enabled: true });
        return;   // setSettings recurses back through here
    }
    if (immediate) {
        // Fire-and-forget — the tick handles its own status updates
        tickNow({ manual: false }).then(() => _scheduleNext());
    } else {
        _scheduleNext();
    }
}

export function stopLoop() {
    clearTimeout(_tickTimer);
    _tickTimer = null;
}

/* Boot — re-arm the loop on page load if the user had it on. Idempotent:
 * called from app/shell.js after the wallet adapter is ready. */
export function bootFromSettings() {
    const s = getSettings();
    if (s.enabled) _scheduleNext();
}

/* Server-reported counters (today's spend + count) for the Profile UI. */
export async function serverStatus() {
    const wallet = _wallet();
    if (!wallet) return null;
    return await autonomousStatus({ tokenId: _activeTokenId(), wallet });
}

/* Dev/debug — expose on window so users can poke from devtools. */
if (typeof window !== 'undefined') {
    window.__dexHeroAutonomous = {
        getSettings, setSettings, getLocalStatus, serverStatus,
        startLoop, stopLoop, tickNow, bootFromSettings,
    };
}
