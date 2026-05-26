import * as wallet from '../services/wallet.js';

/* equipment-slot.js — shared WoW-style "loadout" popover for the lined-title
 * callouts on the centered DexHero.
 *
 * One slot, one inventory, click-or-drag to swap. Used by:
 *   brain-picker      → slot = active LLM model
 *   voice-editor      → slot = active voice preset (or Custom)
 *   body-picker       → slot = centered 3D body
 *   movement-picker   → slot = active movement style
 *
 * Singleton — only one slot is mounted at a time. Reopening replaces.
 *
 * Visual reference: panel.css overlay variant + the token-detail panel.
 * Aesthetic: dark glass + cyan ring, monospace small-caps labels, 360ms
 * cubic-bezier entry, 180ms cross-fade on swap (matches STAGE_SUBJECT
 * fade for body swaps).
 *
 * Drag-and-drop: native HTML5 DnD via a shared MIME `application/x-
 * dexhero-slot-item`. The equipped frame is the drop target. The Body
 * slot additionally accepts `application/x-dexhero-hero` (emitted by the
 * 4-slot ribbon in stage.js) via an opt-in `externalDropMatcher`.
 */

const DRAG_MIME = 'application/x-dexhero-slot-item';

let _current = null;   // { root, state, onKey, onOutside }

/**
 * Open a slot popover. Returns { close, refresh(nextState) }.
 *
 * opts:
 *   partId               'brain' | 'voice' | 'body' | 'movement'
 *   title                'Brain' | 'Voice' | ...    — heading text
 *   anchorEl             the lined-title button   — for positioning
 *   ownerBadge           { kind: 'you' | 'platform' | 'readonly', label }
 *   equipped             { id, name, subtitle?, glyph?, image?, badges? } | null
 *   inventory            [{ id, name, subtitle?, glyph?, image?, locked?, lockedReason?, lockedCta? }]
 *   filterChips          [{ id, label, active? }] | null
 *   onFilter(filterId)
 *   onSwap(itemId, source)    source ∈ 'click' | 'drag' | 'ribbon'
 *   onPrimary(buttonEl)
 *   onSecondary()
 *   emptyState           { title, hint?, ctaLabel?, ctaEvent? } | null
 *   footer               { hint?, primaryLabel?, primaryDisabled?, secondaryLabel? } | null
 *   acceptsRibbonDrop    boolean — Body only
 *   externalDropMatcher  (dataTransfer) → itemId | null
 *   customBody           HTML string | null      — replaces inventory (used by Voice's Custom mode)
 */
export function openEquipmentSlot(opts) {
    closeCurrent();

    const state = {
        partId: opts.partId,
        title: opts.title,
        anchorEl: opts.anchorEl || null,
        ownerBadge: opts.ownerBadge || null,
        equipped: opts.equipped || null,
        loadout: Array.isArray(opts.loadout) ? opts.loadout.slice() : null,
        activeId: opts.activeId || null,
        inventory: Array.isArray(opts.inventory) ? opts.inventory.slice() : [],
        layout: opts.layout || 'tiles',  // 'tiles' (default grid) | 'rows' (full-width bars)
        filterChips: opts.filterChips || null,
        emptyState: opts.emptyState || null,
        footer: opts.footer || null,
        customBody: opts.customBody || null,
        acceptsRibbonDrop: !!opts.acceptsRibbonDrop,
        externalDropMatcher: opts.externalDropMatcher || null,
        onSwap: opts.onSwap || null,                  // legacy single-equip
        onPrimary: opts.onPrimary || null,
        onSecondary: opts.onSecondary || null,
        onFilter: opts.onFilter || null,
        onListYourOwn: opts.onListYourOwn || null,
        onLike: opts.onLike || null,
        onLoadoutAdd: opts.onLoadoutAdd || null,      // drop from inventory → loadout
        onLoadoutRemove: opts.onLoadoutRemove || null,// drag tile out of loadout
        onActivate: opts.onActivate || null,          // click a loadout tile
    };

    const root = document.createElement('div');
    root.className = 'eq-slot';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', `${state.title} slot`);
    root.setAttribute('data-state', 'opening');
    root.dataset.partId = state.partId;

    document.body.appendChild(root);

    paint(root, state);   // paint() also positions — see below

    const onKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); closeCurrent(); }
    };
    const onOutside = (ev) => {
        if (!root.isConnected) return;
        if (root.contains(ev.target)) return;
        if (state.anchorEl && state.anchorEl.contains(ev.target)) return;
        closeCurrent();
    };
    document.addEventListener('keydown', onKey, true);
    // Defer outside-click binding so the open-click doesn't immediately close us.
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

    _current = { root, state, onKey, onOutside };

    // Promote to "open" on next frame so the CSS transition fires.
    requestAnimationFrame(() => {
        if (_current?.root === root) root.setAttribute('data-state', 'open');
    });

    return {
        close: closeCurrent,
        get root() { return root; },
        refresh(nextState) {
            if (!_current || _current.root !== root) return;
            Object.assign(_current.state, nextState || {});
            paint(root, _current.state);
            // Visual swap cross-fade — set "swapping" then back to "open".
            root.setAttribute('data-state', 'swapping');
            setTimeout(() => {
                if (_current?.root === root) root.setAttribute('data-state', 'open');
            }, 180);
        },
    };
}

function closeCurrent() {
    if (!_current) return;
    const { root, onKey, onOutside } = _current;
    _current = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    root.setAttribute('data-state', 'closing');
    setTimeout(() => { try { root.remove(); } catch {} }, 220);
}

/* ── Paint ─────────────────────────────────────────────────────── */

// Truffle's pre-connect explainer for each slot — replaces the head +
// loadout area entirely when the user hasn't connected a wallet yet,
// turning the top of the popup into a speech bubble so first-time
// visitors understand what each slot does.
const TRUFFLE_EXPLAINERS = {
    brain:    "Pick the AI that thinks for me. Anthropic, OpenAI, Google — whatever makes me smartest.",
    voice:    "Choose how I sound when I talk.",
    body:     "Swap my 3D body for any DexHero you want me to wear.",
    movement: "Equip how I move, dance, and gesture.",
};

function isPreConnect() {
    return !wallet.getStatus()?.connected;
}

function truffleBubbleHTML(state) {
    const text = TRUFFLE_EXPLAINERS[state.partId];
    if (!text) return '';
    return `
        <div class="eq-slot__truffle" data-truffle>
            <p class="eq-slot__truffle-text" data-truffle-text="${escAttr(text)}"></p>
        </div>`;
}

// Walk the text in character by character so Truffle's line reads
// like it's being spoken out, just like the lobby chat bubble.
function startTruffleTypewriter(root) {
    const el = root.querySelector('[data-truffle-text]');
    if (!el) return;
    const full = el.getAttribute('data-truffle-text') || '';
    el.textContent = '';
    let i = 0;
    const tick = () => {
        if (!el.isConnected) return;
        el.textContent = full.slice(0, ++i);
        if (i < full.length) setTimeout(tick, 22);
    };
    setTimeout(tick, 60);
}

function paint(root, state) {
    const preConnect = isPreConnect();
    root.classList.toggle('eq-slot--preconnect', preConnect);
    // Pre-connect: Truffle's speech bubble replaces the head +
    // loadout area entirely (CSS hides those when .eq-slot--preconnect)
    // and the bubble takes the top of the popup with its own
    // shadow/border for the 3D overlaid feel.
    root.innerHTML =
        (preConnect ? truffleBubbleHTML(state) : '')
        + headHTML(state)
        + equippedHTML(state)
        + (state.customBody != null ? customBodyHTML(state) : inventoryHTML(state))
        + (state.footer ? footHTML(state) : '');

    bindHandlers(root, state);
    if (isPreConnect()) startTruffleTypewriter(root);
    // Re-position after every paint so refresh() (e.g., Voice's switch into
    // custom-textarea mode, which changes the popover height) stays fully
    // inside the viewport.
    position(root, state.anchorEl);
}

function headHTML(state) {
    const badge = state.ownerBadge
        ? `<span class="eq-slot__owner-badge eq-slot__owner-badge--${escAttr(state.ownerBadge.kind || 'platform')}">${escHtml(state.ownerBadge.label || '')}</span>`
        : '';
    return `
        <div class="eq-slot__head">
            <div class="eq-slot__head-lead">
                <span class="eq-slot__title">${escHtml(state.title)} Slot</span>
                ${badge}
            </div>
            <button type="button" class="eq-slot__close" aria-label="Close">×</button>
        </div>`;
}

function equippedHTML(state) {
    // The top is a multi-tile loadout strip. The caller passes either:
    //   - `loadout`: an array of items (new, multi-item model)
    //   - `equipped`: a single item (back-compat → wrapped to [equipped])
    // The first item is the active one by default; an explicit
    // `activeId` overrides that. Items in the loadout are draggable —
    // drag a tile OUT of the strip to remove it from the loadout.
    const loadout = Array.isArray(state.loadout) && state.loadout.length
        ? state.loadout
        : (state.equipped ? [state.equipped] : []);
    const activeId = state.activeId
        || (state.equipped && state.equipped.id)
        || (loadout[0] && loadout[0].id)
        || null;

    if (!loadout.length) {
        return `
            <div class="eq-slot__loadout eq-slot__loadout--empty" data-drop-zone>
                <div class="eq-slot__loadout-hint">Drag items from below to add to your loadout</div>
            </div>`;
    }

    // Rows layout shows only the active item as a single wide bar —
    // there's only one brain selected at a time, so no need for the
    // multi-tile strip.
    if (state.layout === 'rows') {
        const active = loadout.find((it) => it.id === activeId) || loadout[0];
        return `
            <div class="eq-slot__loadout eq-slot__loadout--single" data-drop-zone>
                <div class="eq-slot__loadout-bar">
                    <span class="eq-slot__row-visual">${visualHTML(active, 'loadout')}</span>
                    <span class="eq-slot__row-text">
                        <span class="eq-slot__row-name">${escHtml(active.name || 'Untitled')}</span>
                        ${active.subtitle ? `<span class="eq-slot__row-sub">${escHtml(active.subtitle)}</span>` : ''}
                    </span>
                    <span class="eq-slot__row-status eq-slot__row-status--active">Active</span>
                </div>
            </div>`;
    }

    const tiles = loadout.map((it) => loadoutTileHTML(it, it.id === activeId)).join('');
    // One trailing empty slot tile invites the next drop visually.
    const trailing = `<span class="eq-slot__loadout-tile eq-slot__loadout-tile--empty" aria-hidden="true">+</span>`;
    return `
        <div class="eq-slot__loadout" data-drop-zone>
            <div class="eq-slot__loadout-strip">${tiles}${trailing}</div>
        </div>`;
}

function loadoutTileHTML(item, isActive) {
    return `
        <button type="button"
                class="eq-slot__loadout-tile${isActive ? ' is-active' : ''}"
                data-loadout-id="${escAttr(item.id)}"
                draggable="true"
                title="${escAttr(item.name || '')}${item.subtitle ? ` — ${escAttr(item.subtitle)}` : ''}">
            <span class="eq-slot__loadout-tile-visual">${visualHTML(item, 'loadout')}</span>
            ${isActive ? '<span class="eq-slot__loadout-tile-active"></span>' : ''}
        </button>`;
}

function inventoryHTML(state) {
    const filtersHTML = Array.isArray(state.filterChips) && state.filterChips.length ? `
        <div class="eq-slot__filters">
            ${state.filterChips.map((c) =>
                `<button type="button" class="eq-slot__filter${c.active ? ' is-active' : ''}" data-filter="${escAttr(c.id)}">${escHtml(c.label)}</button>`
            ).join('')}
        </div>` : '';

    if (!state.inventory.length) {
        if (state.emptyState) {
            return `
                <div class="eq-slot__inventory-head">
                    <span class="eq-slot__inventory-title">Inventory</span>
                </div>
                <div class="eq-slot__empty">
                    <div class="eq-slot__empty-title">${escHtml(state.emptyState.title || '')}</div>
                    ${state.emptyState.hint ? `<div class="eq-slot__empty-hint">${escHtml(state.emptyState.hint)}</div>` : ''}
                    ${state.emptyState.ctaLabel ? `<button type="button" class="eq-slot__empty-cta" data-empty-cta>${escHtml(state.emptyState.ctaLabel)}</button>` : ''}
                </div>`;
        }
        return '';
    }

    // Rows layout — full-width bars. Used by Brain where item names +
    // subtitles matter more than the icon (model labels are content,
    // not just icons). Tiles is the default for everything else.
    if (state.layout === 'rows') {
        const rows = state.inventory.map((it) => itemRowHTML(it, state.equipped?.id === it.id)).join('');
        return `
            <div class="eq-slot__inventory-head">
                <span class="eq-slot__inventory-title">Inventory</span>
                ${filtersHTML}
            </div>
            <div class="eq-slot__inventory eq-slot__inventory--rows" data-inventory>${rows}</div>`;
    }

    const items = state.inventory.map((it) => itemHTML(it, state.equipped?.id === it.id)).join('');
    // Pad with empty placeholder tiles so the grid completes a full
    // row (the "inventory slot" feel). Assumes a 4-column grid; CSS's
    // auto-fill takes care of narrower popovers. Always render at
    // least one trailing empty so a freshly-fetched inventory of
    // N items reads as "a partly-filled bag" rather than a flat list.
    const COLS = 4;
    const fillCount = Math.max(1, (COLS - (state.inventory.length % COLS)) % COLS || COLS);
    const fillers = Array.from({ length: fillCount }, () =>
        '<span class="eq-slot__item eq-slot__item--empty" aria-hidden="true"></span>'
    ).join('');
    return `
        <div class="eq-slot__inventory-head">
            <span class="eq-slot__inventory-title">Inventory</span>
            ${filtersHTML}
        </div>
        <div class="eq-slot__inventory" data-inventory>${items}${fillers}</div>`;
}

function itemRowHTML(item, isCurrent) {
    const locked = !!item.locked;
    const draggable = locked ? '' : 'draggable="true"';
    let statusHTML = '';
    if (isCurrent) {
        statusHTML = '<span class="eq-slot__row-status eq-slot__row-status--active">Active</span>';
    } else if (locked && item.lockedReason) {
        statusHTML = `<span class="eq-slot__row-status eq-slot__row-status--locked">${escHtml(item.lockedReason)}</span>`;
    } else if (Number(item.price_usdc) > 0) {
        const n = Number(item.price_usdc);
        const fmt = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
        statusHTML = `<span class="eq-slot__row-status eq-slot__row-status--buy">$${fmt}</span>`;
    }
    return `
        <button type="button"
                class="eq-slot__row${isCurrent ? ' is-current' : ''}${locked ? ' is-locked' : ''}"
                data-item-id="${escAttr(item.id)}"
                aria-pressed="${isCurrent ? 'true' : 'false'}"
                ${locked ? 'aria-disabled="true"' : ''}
                ${draggable}>
            <span class="eq-slot__row-visual">${visualHTML(item, 'row')}</span>
            <span class="eq-slot__row-text">
                <span class="eq-slot__row-name">${escHtml(item.name || 'Untitled')}</span>
                ${item.subtitle ? `<span class="eq-slot__row-sub">${escHtml(item.subtitle)}</span>` : ''}
            </span>
            ${statusHTML}
        </button>`;
}

function customBodyHTML(state) {
    return `<div class="eq-slot__custom" data-custom>${state.customBody}</div>`;
}

function itemHTML(item, isCurrent) {
    const locked = !!item.locked;
    const draggable = locked ? '' : 'draggable="true"';
    // Tile design — icon dominates the square. Status renders as
    // corner badges:
    //   - top-right: heart + count (when item carries like_count)
    //   - bottom: status ribbon (Active / Add key / $N)
    // Name is hover-only (native title attr) to keep tiles dense.
    let statusHTML = '';
    if (isCurrent) {
        statusHTML = '<span class="eq-slot__item-status eq-slot__item-status--active">Active</span>';
    } else if (locked && item.lockedReason) {
        statusHTML = `<span class="eq-slot__item-status eq-slot__item-status--locked">${escHtml(item.lockedReason)}</span>`;
    } else if (Number(item.price_usdc) > 0) {
        const n = Number(item.price_usdc);
        const fmt = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
        statusHTML = `<span class="eq-slot__item-status eq-slot__item-status--buy">$${fmt}</span>`;
    }
    return `
        <button type="button"
                class="eq-slot__item${isCurrent ? ' is-current' : ''}${locked ? ' is-locked' : ''}"
                data-item-id="${escAttr(item.id)}"
                aria-pressed="${isCurrent ? 'true' : 'false'}"
                ${locked ? 'aria-disabled="true"' : ''}
                ${draggable}
                title="${escAttr(item.name || '')}${item.subtitle ? ` — ${escAttr(item.subtitle)}` : ''}">
            <span class="eq-slot__item-visual">${visualHTML(item, 'item')}</span>
            ${statusHTML}
        </button>`;
}

function visualHTML(it, where) {
    if (it.image) return `<img src="${escAttr(it.image)}" alt="" loading="lazy">`;
    if (it.glyph) return it.glyph;   // raw SVG/HTML — caller controls escaping
    const letter = String(it.name || '?').charAt(0).toUpperCase();
    return `<span class="eq-slot__visual-letter">${escHtml(letter)}</span>`;
}

function footHTML(state) {
    const f = state.footer;
    const hintText = f.hint ? `<span class="eq-slot__foot-hint">${escHtml(f.hint)}</span>` : '<span></span>';
    const primary = f.primaryLabel
        ? `<button type="button" class="eq-slot__btn eq-slot__btn--primary" data-primary${f.primaryDisabled ? ' disabled' : ''}>${escHtml(f.primaryLabel)}</button>`
        : '';
    // Footer is empty when there's no hint and no primary action — skip
    // rendering so the popover collapses cleanly without an empty strip.
    if (!f.hint && !primary) return '';
    return `
        <div class="eq-slot__foot">
            ${hintText}
            <div class="eq-slot__foot-actions">${primary}</div>
        </div>`;
}

/* ── Handlers ──────────────────────────────────────────────────── */

function bindHandlers(root, state) {
    root.querySelectorAll('.eq-slot__close').forEach((btn) => btn.addEventListener('click', closeCurrent));

    root.querySelector('[data-secondary]')?.addEventListener('click', () => {
        // Return `true` from onSecondary to KEEP the slot open (e.g., Voice
        // uses "Back" when in custom-textarea mode to return to the
        // inventory grid). Default (undefined / false) closes.
        let keepOpen = false;
        try { keepOpen = state.onSecondary?.() === true; } catch (err) { console.warn('[eq-slot] onSecondary', err); }
        if (!keepOpen) closeCurrent();
    });

    root.querySelector('[data-primary]')?.addEventListener('click', (ev) => {
        try { state.onPrimary?.(ev.currentTarget); } catch (err) { console.warn('[eq-slot] onPrimary', err); }
    });

    root.querySelector('[data-empty-cta]')?.addEventListener('click', () => {
        if (state.emptyState?.ctaEvent) {
            document.dispatchEvent(new CustomEvent(state.emptyState.ctaEvent, { bubbles: true }));
        }
        closeCurrent();
    });

    root.querySelector('[data-list-your-own]')?.addEventListener('click', () => {
        try { state.onListYourOwn?.(); } catch (err) { console.warn('[eq-slot] onListYourOwn', err); }
        closeCurrent();
    });

    // Heart buttons inside item cards — toggle the like without
    // bubbling to the row-level swap handler below.
    root.querySelectorAll('.eq-slot__like').forEach((heart) => {
        heart.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const card = heart.closest('.eq-slot__item, .eq-slot__row');
            const id = card?.getAttribute('data-item-id');
            if (!id || !state.onLike) return;
            const nextLiked = !heart.classList.contains('is-liked');
            // Optimistic flip — the picker calls refresh() with the
            // authoritative count once the server roundtrip lands.
            heart.classList.toggle('is-liked', nextLiked);
            const countEl = heart.querySelector('.eq-slot__like-count');
            const cur = Number(countEl?.textContent || 0);
            if (countEl) countEl.textContent = String(Math.max(0, cur + (nextLiked ? 1 : -1)));
            try { state.onLike(id, nextLiked); }
            catch (err) { console.warn('[eq-slot] onLike', err); }
        });
        // Block dragstart on the heart so a dragged like doesn't try
        // to equip something — only the surrounding card is draggable.
        heart.addEventListener('mousedown', (ev) => ev.stopPropagation());
    });

    // Inventory items: click → swap; drag → set MIME for drop target.
    // Selector covers both tile-grid (.eq-slot__item) and rows layout
    // (.eq-slot__row) so brain's bars share the same swap/drag wiring.
    root.querySelectorAll('.eq-slot__item, .eq-slot__row').forEach((btn) => {
        const id = btn.getAttribute('data-item-id');
        if (btn.classList.contains('is-locked')) {
            // Locked items: click forwards their lockedCta event (if any).
            const item = state.inventory.find((i) => String(i.id) === String(id));
            if (item?.lockedCta) {
                btn.addEventListener('click', () => {
                    document.dispatchEvent(new CustomEvent(item.lockedCta, { bubbles: true }));
                    closeCurrent();
                });
            }
            return;
        }
        btn.addEventListener('click', () => triggerSwap(root, state, id, 'click'));
        btn.addEventListener('dragstart', (ev) => {
            try {
                ev.dataTransfer.setData(DRAG_MIME, JSON.stringify({ partId: state.partId, itemId: id }));
                ev.dataTransfer.effectAllowed = 'move';
            } catch {}
            btn.classList.add('is-dragging');
        });
        btn.addEventListener('dragend', () => btn.classList.remove('is-dragging'));
    });

    // Filter chips.
    root.querySelectorAll('[data-filter]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const id = chip.getAttribute('data-filter');
            try { state.onFilter?.(id); } catch (err) { console.warn('[eq-slot] onFilter', err); }
        });
    });

    // Loadout strip — click a tile = activate; drag a tile out =
    // remove from loadout. The strip itself is also the drop zone for
    // adds (handled separately below).
    root.querySelectorAll('.eq-slot__loadout-tile').forEach((tile) => {
        if (tile.classList.contains('eq-slot__loadout-tile--empty')) return;
        const id = tile.getAttribute('data-loadout-id');
        tile.addEventListener('click', () => {
            if (state.onActivate) {
                try { state.onActivate(id); } catch (err) { console.warn('[eq-slot] onActivate', err); }
            } else if (state.onSwap) {
                // Back-compat with single-equip pickers — clicking the
                // single equipped tile is a no-op there, but if a picker
                // hasn't migrated to onActivate yet, route through swap
                // so the active state is at least kept consistent.
                triggerSwap(root, state, id, 'loadout');
            }
        });
        tile.addEventListener('dragstart', (ev) => {
            try {
                // Use a different MIME so a tile dragged OUT of the
                // loadout doesn't accidentally hit the same drop zone
                // and immediately re-add itself.
                ev.dataTransfer.setData('application/x-dexhero-loadout-tile',
                    JSON.stringify({ partId: state.partId, itemId: id }));
                ev.dataTransfer.effectAllowed = 'move';
            } catch {}
            tile.classList.add('is-dragging');
        });
        tile.addEventListener('dragend', (ev) => {
            tile.classList.remove('is-dragging');
            // Drop outside the popover → remove from loadout.
            const popover = root.getBoundingClientRect();
            const x = ev.clientX, y = ev.clientY;
            const outside = x < popover.left || x > popover.right
                         || y < popover.top  || y > popover.bottom;
            if (outside && state.onLoadoutRemove) {
                try { state.onLoadoutRemove(id); } catch (err) { console.warn('[eq-slot] onLoadoutRemove', err); }
            }
        });
    });

    // Drop zone = the loadout strip. Accepts inventory-tile drags
    // (DRAG_MIME) and, for body picker, ribbon-MIME drops too. Adds to
    // the loadout via onLoadoutAdd; falls back to onSwap for pickers
    // that haven't migrated to the multi-item model yet.
    const dropZone = root.querySelector('[data-drop-zone]');
    if (dropZone) {
        dropZone.addEventListener('dragover', (ev) => {
            const types = ev.dataTransfer?.types;
            if (!types) return;
            const has = (mime) => types.contains ? types.contains(mime) : Array.from(types).includes(mime);
            const accept = has(DRAG_MIME)
                || (state.acceptsRibbonDrop && state.externalDropMatcher
                    && state.externalDropMatcher(ev.dataTransfer) != null);
            if (!accept) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
            dropZone.classList.add('is-drag-over');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-drag-over'));
        dropZone.addEventListener('drop', (ev) => {
            dropZone.classList.remove('is-drag-over');
            let itemId = null;
            let source = 'drag';
            const slotData = ev.dataTransfer.getData(DRAG_MIME);
            if (slotData) {
                try {
                    const parsed = JSON.parse(slotData);
                    if (parsed.partId === state.partId) itemId = parsed.itemId;
                } catch {}
            }
            if (!itemId && state.acceptsRibbonDrop && state.externalDropMatcher) {
                itemId = state.externalDropMatcher(ev.dataTransfer);
                source = 'ribbon';
            }
            if (!itemId) return;
            ev.preventDefault();
            if (state.onLoadoutAdd) {
                try { state.onLoadoutAdd(itemId, source); } catch (err) { console.warn('[eq-slot] onLoadoutAdd', err); }
            } else if (state.onSwap) {
                triggerSwap(root, state, itemId, source);
            }
        });
    }
}

function triggerSwap(root, state, itemId, source) {
    if (!state.onSwap) return;
    // Optimistic visual fade — caller's refresh() will repaint with the new equipped state.
    root.setAttribute('data-state', 'swapping');
    setTimeout(() => {
        if (_current?.root === root) root.setAttribute('data-state', 'open');
    }, 180);
    try { state.onSwap(itemId, source); } catch (err) { console.warn('[eq-slot] onSwap', err); }
}

/* ── Positioning ───────────────────────────────────────────────── */

/** Measure the rendered popover, then clamp it fully inside the viewport.
 *
 *   1. Read actual width/height from layout (offsetWidth/Height — accurate
 *      immediately after paint, transforms don't affect them).
 *   2. Prefer below-anchor placement (10px gap).
 *   3. If below would overflow the viewport bottom AND there's room above,
 *      flip to above-anchor (with the `eq-slot--above` class so the entry
 *      transform origin matches).
 *   4. Final clamp on both axes so the popover is always fully visible
 *      with a 12px viewport margin — even if neither below nor above
 *      fits well, the popover is at least entirely on-screen with its
 *      own internal scroll inside `.eq-slot__inventory`.
 */
function position(root, anchorEl) {
    const margin = 12;
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    // Always start by clearing any prior above-pin so re-positions are stateless.
    root.classList.remove('eq-slot--above');

    // Force a layout read of the actual dimensions.
    const pw = root.offsetWidth || 380;
    const ph = root.offsetHeight || 480;

    let left;
    let top;

    if (!anchorEl) {
        left = window.scrollX + Math.max(margin, (viewportW - pw) / 2);
        top  = window.scrollY + 100;
    } else {
        const rect = anchorEl.getBoundingClientRect();
        // Horizontal: center under the anchor.
        let leftV = rect.left + rect.width / 2 - pw / 2;
        // Vertical: prefer below the anchor with a 10px gap.
        let topV  = rect.bottom + 10;

        // Below would overflow → try above.
        const spaceBelow = viewportH - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        if (topV + ph > viewportH - margin && spaceAbove >= ph + 10) {
            topV = rect.top - 10 - ph;
            root.classList.add('eq-slot--above');
        }
        // Neither below nor above has full clearance — pin to whichever
        // side has more room. The popover's own max-height + internal
        // scroll keep its content reachable.
        if (topV + ph > viewportH - margin && topV < margin) {
            topV = spaceBelow >= spaceAbove ? rect.bottom + 10 : margin;
        }

        // Clamp horizontally.
        if (leftV + pw > viewportW - margin) leftV = viewportW - pw - margin;
        if (leftV < margin) leftV = margin;
        // Clamp vertically.
        if (topV < margin) topV = margin;
        if (topV + ph > viewportH - margin) topV = Math.max(margin, viewportH - ph - margin);

        // Convert viewport coords → document coords for `position: absolute`.
        left = leftV + window.scrollX;
        top  = topV + window.scrollY;
    }

    root.style.left = `${left}px`;
    root.style.top  = `${top}px`;
}

/* ── Escape helpers ────────────────────────────────────────────── */

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function escAttr(s) {
    return escHtml(s);
}

/** Close any open equipment slot. Exported so other UI (e.g., the LLM
 *  connect modal) can dismiss a leftover popover when opening a sibling
 *  surface. */
export function closeEquipmentSlot() { closeCurrent(); }
