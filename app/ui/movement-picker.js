/* movement-picker.js — Movement slot (lined-title popover).
 *
 * Inventory: /api/modules?category=movement (community-ranked, filter
 * chips: All / Top / New / Free). The top strip is a multi-item
 * "loadout" — drag from the inventory grid to add (no limit), click
 * a strip tile to activate it, drag a tile out to remove it from the
 * strip. The currently-active tile drives the actual body-driver
 * overrides.
 */

import { on, E } from '../events.js';
import { openEquipmentSlot } from './equipment-slot.js';
import { setMovementOverrides } from '../services/dexhero-body-driver.js';
import { listModules, likeModule, unlikeModule } from '../services/dexhero-modules.js';

const MOVEMENT_GLYPH = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M 4 16 A 8 8 0 0 1 20 16"/>
        <path d="M 20 8 A 8 8 0 0 0 4 8"/>
        <polyline points="20,12 20,8 16,8"/>
        <polyline points="4,12 4,16 8,16"/>
    </svg>`;

const ACTIVE_STORAGE_PREFIX = 'dexhero:movement-preset:';
const LOADOUT_STORAGE_PREFIX = 'dexhero:loadout:movement:';

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
let _activeId = null;
let _loadoutIds = [];

/* ── Helpers ────────────────────────────────────────────────────── */

function shortWallet(addr) {
    const s = String(addr || '');
    if (s.length <= 12) return s;
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
function tokenKey(subject) {
    const id = subject?.id || subject?.address;
    return id ? String(id) : null;
}
function readActive(subject) {
    const id = tokenKey(subject);
    if (!id) return null;
    try { return localStorage.getItem(ACTIVE_STORAGE_PREFIX + id); } catch { return null; }
}
function persistActive(subject, id) {
    const k = tokenKey(subject);
    if (!k || !id) return;
    try { localStorage.setItem(ACTIVE_STORAGE_PREFIX + k, id); } catch {}
}
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

function moduleToItem(m) {
    return {
        id: m.id,
        name: m.name,
        subtitle: m.creator_wallet === 'platform' ? 'Platform' : `by ${shortWallet(m.creator_wallet)}`,
        glyph: MOVEMENT_GLYPH,
        price_usdc: Number(m.price_usdc || 0),
        like_count: m.like_count || 0,
        liked_by_me: !!m.liked_by_me,
        _spec: m.spec,
    };
}
function loadoutItemsFor(ids) {
    return ids
        .map((id) => _modules.find((m) => m.id === id))
        .filter(Boolean)
        .map(moduleToItem);
}
function buildInventory() { return _modules.map(moduleToItem); }
function buildFilterChips() { return FILTER_CHIPS_BASE.map((c) => ({ ...c, active: c.id === _activeFilter })); }

function applyOverrides(module) {
    const overrides = module?.spec?.gesture_overrides || {};
    setMovementOverrides(overrides);
    document.dispatchEvent(new CustomEvent('dexhero:movement-changed', {
        bubbles: true,
        detail: { presetId: module.id, params: overrides },
    }));
}

/* ── Catalog fetch ──────────────────────────────────────────────── */

async function fetchCatalog(meWallet) {
    const sort = _activeFilter === 'all' ? '' : _activeFilter;
    const res = await listModules({ category: 'movement', wallet: meWallet, sort, top: 60 });
    return Array.isArray(res?.modules) ? res.modules : [];
}

/* ── Loadout ops ────────────────────────────────────────────────── */

function activateById(id, subject) {
    const mod = _modules.find((m) => m.id === id);
    if (!mod) return;
    applyOverrides(mod);
    _activeId = id;
    persistActive(subject, id);
    refreshStrip();
}
function addToLoadout(id, subject) {
    if (!id) return;
    if (!_loadoutIds.includes(id)) {
        _loadoutIds.push(id);
        persistLoadout(subject, _loadoutIds);
    }
    activateById(id, subject);
}
function removeFromLoadout(id, subject) {
    const next = _loadoutIds.filter((x) => x !== id);
    if (next.length === _loadoutIds.length) return;
    _loadoutIds = next;
    persistLoadout(subject, _loadoutIds);
    // If we removed the active one, activate whatever is left (or none).
    if (_activeId === id) {
        _activeId = _loadoutIds[0] || null;
        if (_activeId) activateById(_activeId, subject);
    }
    refreshStrip();
}
function refreshStrip() {
    if (!_slotHandle) return;
    _slotHandle.refresh({
        loadout: loadoutItemsFor(_loadoutIds),
        activeId: _activeId,
    });
}

/* ── Open ───────────────────────────────────────────────────────── */

async function openSlot(anchorEl) {
    const subject = _currentSubject;

    // Seed loadout from localStorage; backfill the active id if it's
    // not already in the strip (so a first-time open shows the user's
    // current preset rather than a blank strip).
    _loadoutIds = readLoadout(subject);
    const persistedActive = readActive(subject);
    if (persistedActive && !_loadoutIds.includes(persistedActive)) {
        _loadoutIds = [persistedActive, ..._loadoutIds];
    }
    _activeId = persistedActive || _loadoutIds[0] || null;

    // Open immediately. STAGE_SUBJECT warms the cache; first cold-load
    // click shows briefly with empty inventory, populated by the
    // background refresh below.
    _slotHandle = openEquipmentSlot({
        partId: 'movement',
        title: 'Movement',
        anchorEl,
        loadout: loadoutItemsFor(_loadoutIds),
        activeId: _activeId,
        inventory: buildInventory(),
        filterChips: buildFilterChips(),
        footer: {
            hint: 'Drag to add · Click to activate · Drag out to remove',
            secondaryLabel: 'Close',
        },
        onListYourOwn: () => { location.hash = '#/publish/movement'; },
        onFilter: async (filterId) => {
            _activeFilter = filterId;
            _slotHandle?.refresh({ filterChips: buildFilterChips() });
            try {
                const me = (await import('../services/wallet.js')).getStatus?.()?.address?.toLowerCase() || null;
                _modules = await fetchCatalog(me);
                _slotHandle?.refresh({ inventory: buildInventory(), loadout: loadoutItemsFor(_loadoutIds) });
            } catch (err) {
                console.warn('[movement-picker] filter fetch failed', err?.message);
            }
        },
        onSwap: (id) => addToLoadout(id, subject),               // click in inventory grid
        onLoadoutAdd: (id) => addToLoadout(id, subject),         // drop into strip
        onActivate: (id) => activateById(id, subject),           // click in strip
        onLoadoutRemove: (id) => removeFromLoadout(id, subject), // drag tile out
        onLike: (id, nextLiked) => doLike(id, nextLiked),
    });

    // Quiet background refresh — only repaint if data changed, so
    // subsequent opens never flash for no reason.
    try {
        const me = (await import('../services/wallet.js')).getStatus?.()?.address?.toLowerCase() || null;
        const fresh = await fetchCatalog(me);
        if (catalogChanged(_modules, fresh)) {
            _modules = fresh;
            _slotHandle?.refresh({
                inventory: buildInventory(),
                loadout: loadoutItemsFor(_loadoutIds),
            });
        }
    } catch (err) {
        console.warn('[movement-picker] catalog refresh failed', err?.message);
    }
}

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

async function doLike(id, nextLiked) {
    try {
        const res = nextLiked ? await likeModule(id) : await unlikeModule(id);
        const mod = _modules.find((m) => m.id === id);
        if (mod) { mod.like_count = res.like_count || 0; mod.liked_by_me = nextLiked; }
    } catch (err) {
        console.warn('[movement-picker] like failed', err?.message);
        _slotHandle?.refresh({ inventory: buildInventory() });
    }
}

/* ── Boot ──────────────────────────────────────────────────────── */

export function initMovementPicker() {
    if (_wired) return;
    _wired = true;

    on(E.STAGE_SUBJECT, (subject) => {
        _currentSubject = subject || null;
        const id = readActive(subject);
        const mod = _modules.find((m) => m.id === id);
        if (mod) applyOverrides(mod);
        // Warm catalog cache so first slot click is instant.
        (async () => {
            try {
                const me = (await import('../services/wallet.js')).getStatus?.()?.address?.toLowerCase() || null;
                const fresh = await fetchCatalog(me);
                if (catalogChanged(_modules, fresh)) {
                    _modules = fresh;
                    if (_slotHandle) {
                        _slotHandle.refresh({
                            inventory: buildInventory(),
                            loadout: loadoutItemsFor(_loadoutIds),
                        });
                    }
                }
            } catch {}
        })();
    });

    document.addEventListener('dexhero:workshop-part', (ev) => {
        const part = ev.detail?.part;
        if (part !== 'movement') return;
        openSlot(ev.detail?.anchorEl);
    });
}
