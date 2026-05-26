/* brain-picker.js — Brain slot (lined-title popover).
 *
 * Top: a multi-item loadout strip — drag brain modules from the
 * inventory below to add (no limit), click a strip tile to activate
 * it, drag a tile out of the popover to remove it. The active tile
 * drives the current LLM (setActiveProvider + setAccountModel) so
 * the next chat message uses it.
 *
 * Inventory: /api/modules?category=brain (community-ranked, filter
 * chips: All / Top / New / Free). Items locked when the underlying
 * LLM provider key isn't connected → tile shows "Add key" pill,
 * click opens the LLM connect modal.
 *
 * Sync to server (owner only) writes the currently-active brain
 * module's provider+model to dexhero_brain_config in one signature.
 */

import { on, E } from '../events.js';
import * as wallet from '../services/wallet.js';
import { getBrainConfig, saveBrainConfig } from '../services/dexhero-brain.js';
import {
    getActiveAccount as getActiveLlmAccount,
    getAllAccounts as getAllLlmAccounts,
    setActiveProvider,
    setAccountModel,
} from '../services/llm-connect.js';
import { getProvider as getProviderDef } from '../services/llm-providers.js';
import { listModules, likeModule, unlikeModule } from '../services/dexhero-modules.js';
import { openEquipmentSlot } from './equipment-slot.js';
import { providerGlyph } from './icons-llm.js';
import { mountConnectPanel } from './llm-connect.js';

const TIER_LABEL = { fast: 'Fast', balanced: 'Balanced', deepest: 'Deepest', local: 'Local' };

const LOADOUT_STORAGE_PREFIX = 'dexhero:loadout:brain:';

const FILTER_CHIPS_BASE = [
    { id: 'all',  label: 'All' },
    { id: 'top',  label: 'Top' },
    { id: 'new',  label: 'New' },
    { id: 'free', label: 'Free' },
];

let _wired = false;
let _currentSubject = null;
let _slotHandle = null;
let _modules = [];
let _activeFilter = 'top';
let _loadoutIds = [];

/* ── Helpers ────────────────────────────────────────────────────── */

function tokenKey(subject) { return subject?.id || subject?.address || null; }
function readLoadout(subject) {
    const k = tokenKey(subject);
    if (!k) return [];
    try { return JSON.parse(localStorage.getItem(LOADOUT_STORAGE_PREFIX + k) || '[]') || []; }
    catch { return []; }
}
function persistLoadout(subject, ids) {
    const k = tokenKey(subject);
    if (!k) return;
    try { localStorage.setItem(LOADOUT_STORAGE_PREFIX + k, JSON.stringify(ids)); } catch {}
}

function moduleToItem(m, connectedSet) {
    const spec = m.spec || {};
    const provId = String(spec.llm_provider || '').toLowerCase();
    const def = getProviderDef(provId);
    const modelTier = (def?.models || []).find((mm) => mm.id === spec.llm_model)?.tier;
    return {
        id: m.id,
        name: m.name,
        subtitle: `${def?.name || provId} · ${TIER_LABEL[modelTier] || modelTier || ''}`,
        glyph: providerGlyph(provId, { size: 20 }),
        price_usdc: Number(m.price_usdc || 0),
        like_count: m.like_count || 0,
        liked_by_me: !!m.liked_by_me,
        _provider: provId,
        _model: spec.llm_model,
    };
}
function buildInventory(connectedAccounts, activeId = null) {
    const set = new Set(connectedAccounts.map((a) => a.provider));
    // All bars look + behave the same — no locked gold "Add key"
    // pill, no separate modal on click. Active model floats to top.
    const items = _modules.map((m) => moduleToItem(m, set));
    if (activeId) {
        const i = items.findIndex((it) => it.id === activeId);
        if (i > 0) {
            const [active] = items.splice(i, 1);
            items.unshift(active);
        }
    }
    return items;
}
function loadoutItemsFor(ids, connectedAccounts) {
    const set = new Set(connectedAccounts.map((a) => a.provider));
    return ids
        .map((id) => _modules.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => moduleToItem(m, set));
}
function buildFilterChips() {
    return FILTER_CHIPS_BASE.map((c) => ({ ...c, active: c.id === _activeFilter }));
}
function activeIdFromAccount(llm) {
    if (!llm?.connected) return null;
    return `platform:brain:${llm.provider}:${llm.model}`;
}

// Build the single top-bar item directly from the active LLM, so it
// renders even before the brain-module catalog has loaded.
function activeBarItem(llm) {
    if (!llm?.connected || !llm.provider || !llm.model) return null;
    const def = getProviderDef(llm.provider);
    const modelDef = (def?.models || []).find((m) => m.id === llm.model);
    const tier = modelDef?.tier;
    return {
        id: `platform:brain:${llm.provider}:${llm.model}`,
        name: modelDef?.label || llm.model,
        subtitle: `${def?.name || llm.provider} · ${TIER_LABEL[tier] || tier || ''}`,
        glyph: providerGlyph(llm.provider, { size: 20 }),
    };
}

/* ── Catalog fetch ──────────────────────────────────────────────── */

async function fetchCatalog(meWallet) {
    const sort = _activeFilter === 'all' ? '' : _activeFilter;
    const res = await listModules({ category: 'brain', wallet: meWallet, sort, top: 60 });
    return Array.isArray(res?.modules) ? res.modules : [];
}

/** Cheap diff so background refetches only repaint when something
 *  observable changed. Avoids the flash users see when the popover
 *  paints twice in quick succession with identical data. */
function catalogChanged(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (!x || !y) return true;
        if (x.id !== y.id) return true;
        if ((x.like_count || 0) !== (y.like_count || 0)) return true;
        if (!!x.liked_by_me !== !!y.liked_by_me) return true;
    }
    return false;
}

/* ── Loadout ops ────────────────────────────────────────────────── */

function activateById(id, me) {
    const it = _modules.find((m) => m.id === id);
    if (!it) return;
    const provider = it.spec?.llm_provider;
    const model    = it.spec?.llm_model;
    if (!provider || !model) return;
    // Activate unconditionally — no popup, no wallet sig. If the
    // provider has no user key, the runtime falls back to the
    // platform Anthropic backend (same path Truffle uses).
    try {
        setActiveProvider(me, provider);
        setAccountModel(me, provider, model);
        document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
    } catch (err) {
        console.warn('[brain-picker] activate failed', err);
        return;
    }
    refreshStrip(me);
}
function addToLoadout(id, subject, me) {
    if (!id) return;
    if (!_loadoutIds.includes(id)) {
        _loadoutIds.push(id);
        persistLoadout(subject, _loadoutIds);
    }
    activateById(id, me);
}
function removeFromLoadout(id, subject, me) {
    const next = _loadoutIds.filter((x) => x !== id);
    if (next.length === _loadoutIds.length) return;
    _loadoutIds = next;
    persistLoadout(subject, _loadoutIds);
    refreshStrip(me);
}
function refreshStrip(me) {
    if (!_slotHandle) return;
    const llm = getActiveLlmAccount(me);
    const activeId = activeIdFromAccount(llm);
    const topBar = activeBarItem(llm);
    _slotHandle.refresh({
        loadout: topBar ? [topBar] : [],
        activeId,
    });
    // Re-mount the inline connect panel — paint() rebuilds innerHTML,
    // so the [data-llm-host] div is empty again after refresh.
    const host = _slotHandle.root?.querySelector('[data-llm-host]');
    if (host) mountConnectPanel(host, { hideConnected: true });
}

/* ── Open ──────────────────────────────────────────────────────── */

async function openSlot(anchorEl) {
    const tokenId = _currentSubject?.id || _currentSubject?.address;
    if (!tokenId) return;

    const isDefault = !!_currentSubject?._isDefault;
    const status = wallet.getStatus();
    const me = status?.address ? status.address.toLowerCase() : '';

    const subject = _currentSubject;
    _loadoutIds = readLoadout(subject);

    const llm = getActiveLlmAccount(me);
    const connectedAccounts = getAllLlmAccounts(me);
    const activeId = activeIdFromAccount(llm);
    // Backfill loadout with the currently-active id so the strip
    // always reflects "what's running" plus any pinned alternates.
    if (activeId && !_loadoutIds.includes(activeId)) {
        _loadoutIds = [activeId, ..._loadoutIds];
    }

    // Open immediately. STAGE_SUBJECT warms the cache so by the time
    // the user clicks, _modules is already hot. If it's not (first
    // click on a cold load), the background refresh below populates
    // the inventory within a frame or two — better than blocking the
    // click for a network roundtrip.
    const topBar = activeBarItem(llm);
    _slotHandle = openEquipmentSlot({
        partId: 'brain',
        title: 'Brain',
        anchorEl,
        layout: 'rows',
        ownerBadge: isDefault ? { kind: 'platform', label: 'Platform default' } : null,
        loadout: topBar ? [topBar] : [],
        activeId,
        // Inline connect+manage panel — same provider cards from the
        // llm-connect modal, embedded here so the user paste keys
        // without a second popup. The host div is hydrated by
        // mountConnectPanel after the popover paints.
        customBody: '<div class="brain-picker__llm-host" data-llm-host></div>',
        footer: null,
    });
    // Hydrate the connect panel inside the popover.
    const host = _slotHandle.root?.querySelector('[data-llm-host]');
    if (host) mountConnectPanel(host, { hideConnected: true });

    // Quiet background refresh — only repaint if module set or like
    // counts changed, so subsequent opens don't flash for no reason.
    try {
        const fresh = await fetchCatalog(me);
        if (catalogChanged(_modules, fresh)) {
            _modules = fresh;
            refreshStrip(me);
        }
    } catch (err) {
        console.warn('[brain-picker] catalog refresh failed', err?.message);
    }

    if (isDefault) return;

    let cfg = null;
    let isOwner = false;
    try {
        cfg = await getBrainConfig(tokenId);
        const ownerWallet = (cfg?.owner_wallet || '').toLowerCase();
        isOwner = !!(me && ownerWallet && me === ownerWallet);
    } catch { /* table may not exist yet for unminted subjects */ }
    if (!_slotHandle) return;
    if (isOwner) {
        _slotHandle.refresh({
            ownerBadge: { kind: 'you', label: 'You own this' },
            footer: {
                hint: 'Drag to add · Click to activate · Sync persists',
                secondaryLabel: 'Close',
                primaryLabel: 'Sync to server',
                primaryDisabled: !getActiveLlmAccount(me).connected,
            },
            onPrimary: (btn) => syncToServer(btn, tokenId, cfg, me),
        });
    } else if (cfg?.owner_wallet) {
        _slotHandle.refresh({
            ownerBadge: { kind: 'readonly', label: 'Read-only' },
        });
    }
}

async function doLike(id, nextLiked, me) {
    try {
        const res = nextLiked ? await likeModule(id) : await unlikeModule(id);
        const mod = _modules.find((m) => m.id === id);
        if (mod) { mod.like_count = res.like_count || 0; mod.liked_by_me = nextLiked; }
    } catch (err) {
        console.warn('[brain-picker] like failed', err?.message);
        refreshStrip(me);
    }
}

async function syncToServer(btn, tokenId, cfg, me) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing…';
    try {
        const active = getActiveLlmAccount(me);
        if (!active.connected) throw new Error('not_connected');
        const def = getProviderDef(active.provider);
        const model = def?.models?.find((m) => m.id === active.model);
        const tier = model?.tier;
        await saveBrainConfig(tokenId, {
            model: active.model,
            provider: active.provider,
            tier: tier === 'deepest' ? 'cloud_deep' : (tier === 'local' ? 'local' : 'cloud_fast'),
            privacy: tier === 'local' ? 'on_device' : 'cloud',
            max_tokens: 1024,
        }, cfg?.behavior || {});
        btn.textContent = 'Synced ✓';
        setTimeout(() => _slotHandle?.close(), 700);
    } catch (err) {
        const code = err?.body?.error || err?.message || 'failed';
        const msg = ({
            not_owner: 'Not the owner',
            signature_expired: 'Try again',
            signature_invalid: 'Sig rejected',
            wallet_not_connected: 'Connect wallet',
            not_connected: 'Connect a brain',
        })[code] || 'Sync failed';
        btn.textContent = msg;
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = orig;
        }, 2200);
    }
}

/* ── Boot ──────────────────────────────────────────────────────── */

export function initBrainPicker() {
    if (_wired) return;
    _wired = true;

    on(E.STAGE_SUBJECT, (subject) => {
        _currentSubject = subject || null;
        // Warm the catalog cache so the first slot click is instant.
        const me = wallet.getStatus()?.address?.toLowerCase() || null;
        fetchCatalog(me).then((fresh) => {
            if (catalogChanged(_modules, fresh)) {
                _modules = fresh;
                if (_slotHandle) refreshStrip(me);
            }
        }).catch(() => {});
    });

    document.addEventListener('dexhero:llm-account-changed', () => {
        if (!_slotHandle) return;
        const me = wallet.getStatus()?.address?.toLowerCase() || '';
        refreshStrip(me);
    });

    document.addEventListener('dexhero:workshop-part', (ev) => {
        const part = ev.detail?.part;
        if (part !== 'brain') return;
        openSlot(ev.detail?.anchorEl);
    });
}
