/* body-picker.js — Body slot (lined-title popover).
 *
 * Subscribes to `dexhero:workshop-part` and opens when `part === 'memory'`
 * (the legacy annotation ID for the "Body" lined title — see
 * stage-annotations.js:24-36; Phase 5 of the master plan renames the
 * ID to 'body' and updates this listener in lockstep).
 *
 * Slot UX: WoW-style equip / swap.
 *   - Equipped: the centered hero from stage.js's STAGE_SUBJECT.
 *   - Inventory: every hero in stage.js's _items list (Truffle, the
 *     user's owned, and public top — already merged by rebuildRibbon).
 *   - Swap on click OR on drop from the 4-slot ribbon (DnD MIME
 *     `application/x-dexhero-hero` set in stage.js:_wireSlots's
 *     delegated dragstart listener).
 *
 * No server round-trip — body swap is local UI state, the centered
 * hero changes via setCurrentHeroById → _paintCurrent → STAGE_SUBJECT
 * event → body driver re-binds bones for the new GLB.
 */

import { on, E } from '../events.js';
import { getCurrentSubject, setCurrentHeroById } from '../stage.js';
import { getTopHeroes } from '../services/trending.js';
import { openEquipmentSlot } from './equipment-slot.js';

const FILTER_CHIPS_BASE = [
    { id: 'all',  label: 'All' },
    { id: 'top',  label: 'Top' },
    { id: 'new',  label: 'New' },
    { id: 'free', label: 'Free' },
];

let _wired = false;
let _slotHandle = null;
let _activeFilter = 'top';
// Full catalog of all created DexHeros — body inventory shows every
// hero, not just the user's owned set. Warmed on STAGE_SUBJECT so the
// first click on the Body slot paints instantly.
let _allHeroes = [];

function buildFilterChips() {
    return FILTER_CHIPS_BASE.map((c) => ({ ...c, active: c.id === _activeFilter }));
}

function filteredHeroes() {
    const list = _allHeroes.slice();
    switch (_activeFilter) {
        case 'new':
            return list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        case 'free':
            return list.filter((h) => !Number(h.price));
        case 'top':
            return list.sort((a, b) => Number(b.players || 0) - Number(a.players || 0));
        case 'all':
        default:
            return list;
    }
}

function subtitleFor(item) {
    if (!item) return '';
    if (item._isDefault) return 'Platform default';
    if (item.symbol) return item.symbol;
    if (item.network) return String(item.network).toUpperCase();
    return '';
}

function badgesFor(item) {
    const out = [];
    if (item._isDefault) out.push('Default');
    // Future: 'Owned' badge once stage.js flags items with an owned bit.
    return out;
}

function equippedFor(subject) {
    if (!subject) return null;
    return {
        id: subject.id,
        name: subject.name || 'Untitled',
        subtitle: subtitleFor(subject),
        image: subject.image || subject.sprite || null,
        badges: ['Equipped', ...badgesFor(subject).filter((b) => b !== 'Equipped')],
    };
}

function inventoryFromItems(items, currentId) {
    return items.map((it) => ({
        id: it.id,
        name: it.name || 'Untitled',
        subtitle: subtitleFor(it),
        image: it.image || it.sprite || null,
    }));
}

function externalDropMatcher(dataTransfer) {
    try {
        const raw = dataTransfer.getData('application/x-dexhero-hero');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed?.tokenId || null;
    } catch {
        return null;
    }
}

function openSlot(anchorEl) {
    const subject = getCurrentSubject();
    const items = filteredHeroes();
    const currentId = subject?.id;

    _slotHandle = openEquipmentSlot({
        partId: 'body',
        title: 'Body',
        anchorEl,
        equipped: equippedFor(subject),
        inventory: inventoryFromItems(items, currentId),
        filterChips: buildFilterChips(),
        emptyState: items.length ? null : {
            title: 'Loading bodies…',
            hint: 'Fetching every created DexHero.',
        },
        footer: {
            hint: 'Click to equip · Or drag from the ribbon',
            secondaryLabel: 'Close',
        },
        onListYourOwn: () => { location.hash = '#/publish/body'; },
        onFilter: (filterId) => {
            _activeFilter = filterId;
            _slotHandle?.refresh({
                filterChips: buildFilterChips(),
                inventory: inventoryFromItems(filteredHeroes(), getCurrentSubject()?.id),
            });
        },
        acceptsRibbonDrop: true,
        externalDropMatcher,
        onSwap: (itemId) => {
            const hero = _allHeroes.find((h) => String(h.id) === String(itemId));
            const ok = setCurrentHeroById(itemId, hero || null);
            if (!ok) return;
            // The STAGE_SUBJECT listener below will repaint the equipped
            // card. No need to call refresh() here — the event-driven
            // path is the single source of truth.
        },
    });
}

export function initBodyPicker() {
    if (_wired) return;
    _wired = true;

    // Warm the full catalog on lobby load so the first Body click is
    // instant. Also keep the equipped card in sync with the centered
    // hero — the body slot can be left open while the user swaps via
    // the 4-slot picker.
    on(E.STAGE_SUBJECT, (subject) => {
        (async () => {
            try {
                const fresh = await getTopHeroes(500);
                if (fresh && fresh.length !== _allHeroes.length) {
                    _allHeroes = fresh;
                }
                if (_slotHandle) {
                    _slotHandle.refresh({
                        equipped: equippedFor(subject),
                        inventory: inventoryFromItems(filteredHeroes(), subject?.id),
                    });
                }
            } catch {}
        })();
    });

    document.addEventListener('dexhero:workshop-part', (ev) => {
        const part = ev.detail?.part;
        // Listen for both the legacy 'memory' ID (current PARTS array)
        // and the new 'body' ID (after Phase 5 annotation rename). Until
        // the rename ships, only 'memory' fires; afterwards only 'body'.
        if (part !== 'memory' && part !== 'body') return;
        openSlot(ev.detail?.anchorEl);
    });
}
