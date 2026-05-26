/* V3Labs stage controller — single-subject lobby display.
 *
 *   Idle mode    → ONE DexHero rendered at a time inside .lobby-stage__solo.
 *                  Prev/next arrows + ←/→ keys step a pointer through the
 *                  in-memory _items list; renderSubject() handles the
 *                  fade-out/fade-in swap between models. A dots-row under
 *                  the nameplate communicates position.
 *   Context mode → single subject (token detail, game-detail card preview).
 *   Dim mode     → whatever is currently shown, dimmed/desaturated.
 *
 * The previous horizontal-ribbon carousel (multiple model-viewers, scroll
 * snap, momentum/drag, scale envelope, infinite loop) is gone — only the
 * focal model is mounted at any time, which halves GPU + memory pressure
 * and gives the centered hero a sharp full-quality render with no
 * neighbors competing for attention.
 */

import { getTopHeroes, getMyHeroes } from './services/trending.js';
import { renderSubject } from './ui/stage-subject.js';
import { initStageChat } from './ui/stage-chat.js';
import { initStageChatLog } from './ui/stage-chat-log.js';
import { initRightWingTodo } from './ui/right-wing-todo.js';
// Body controller — import for the side-effect of registering its
// document-level event listeners (dexhero:body-ready, dexhero:body-action).
// No init function: it self-wires when the module is evaluated.
import * as body from './services/dexhero-body.js';
import { initRightWingTopics } from './ui/right-wing-topics.js';
import { initRightWingActivity } from './ui/right-wing-activity.js';
import { initRightWingResize }   from './ui/right-wing-resize.js';
import { initChatOverlayResize } from './ui/chat-overlay-resize.js';
import { initWingMobileSwipe }   from './ui/wing-mobile-swipe.js';
import { initMobileBottomBar }  from './ui/mobile-bottom-bar.js';
import { initWingTabsMount }     from './ui/wing-tabs-mount.js';
import { initStageAnnotations } from './ui/stage-annotations.js';
import { initBrainPicker } from './ui/brain-picker.js';
import { initBodyPicker } from './ui/body-picker.js';
import { initOutfitRenderer } from './services/dexhero-outfit.js';
import { initMovementPicker } from './ui/movement-picker.js';
import { initWorkshopStubs } from './ui/workshop-stubs.js';
import { initVoiceEditor } from './ui/voice-editor.js';
import { initScheduleEditor } from './ui/schedule-editor.js';
import { initInstallJarjar } from './ui/install-jarjar.js';
import { initLlmConnect } from './ui/llm-connect.js';
import { emit, E } from './events.js';

let _dom = null;
let _mode = 'idle';
let _items = [];
let _currentIdx = 0;
let _currentSubject = null;

// Right-wing collapse state. Open by default on desktop so the bubble
// dock, title strip, and panels are visible without the user having to
// poke around. On mobile (≤640px) we ALWAYS start collapsed — the wing
// goes full-screen when opened and shouldn't ambush the user on first
// paint. Desktop returning users keep whatever they explicitly toggled
// (localStorage); mobile ignores stored state so the peek-tab is always
// the first thing they see.
const _isMobileVP = () => typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(max-width: 640px)').matches;
let _rightCollapsed = _isMobileVP() ? true : false;
try {
    const stored = localStorage.getItem('dexhero:rightCollapsed');
    if (stored !== null && !_isMobileVP()) _rightCollapsed = stored === 'true';
} catch {}

/* Lets the home panel (or anyone else) read the centered hero
   without waiting for the next STAGE_SUBJECT emit. Used by the
   lobby's game slider to render its title correctly on the very
   first synchronous paint. */
export function getCurrentSubject() { return _currentSubject; }

/* Snapshot the current stage items list. Used by the Body slot's
   equipment-slot inventory so it shows every available hero (Truffle +
   user-owned + public top) without a fresh API call — the list is
   already kept in sync via rebuildRibbon(). */
export function getStageItems() { return _items.slice(); }

/* Center a specific hero by id. The Body slot calls this when the user
   clicks (or drops) an inventory item. Returns true on swap, false if
   the id isn't in the current stage items list. */
export function setCurrentHeroById(id, fallbackItem = null) {
    if (!id) return false;
    let idx = _items.findIndex((it) => String(it?.id) === String(id));
    // Body picker now sources from the full DexHero catalog, not just
    // the narrow ribbon. If the target isn't in _items, splice the
    // fallback item in so the swap still works.
    if (idx < 0) {
        if (!fallbackItem) return false;
        _items = [..._items, fallbackItem];
        idx = _items.length - 1;
    }
    if (idx === _currentIdx) return true;
    _currentIdx = idx;
    _paintCurrent();
    return true;
}

/* ─────────────────────────────────────────────────────────────── */

export function initStage(dom) {
    _dom = dom;

    // Right arrow toggles the right wing (the game cards / actions
    // panel). Lobby no longer cycles between DexHeros via arrows —
    // character switching is the 4-slot picker (see _paintSlots).
    // Left arrow + keyboard ←/→ + wheel-to-step are all removed.
    if (_dom.nextBtn) {
        _dom.nextBtn.addEventListener('click', _toggleRightWing);
    } else {
        console.warn('[stage] right-arrow button (#lobby-stage-next) not found — cannot wire toggle');
    }

    // Workshop layer: chat input + speech bubble for the centered DexHero.
    // Self-contained — wires once against the DOM anchors in index.html and
    // subscribes to STAGE_SUBJECT internally.
    initStageChat();
    // Legacy chat-log panel (stage-chat-log.js) is no longer mounted —
    // its data-tab-panel="chatlog" target was removed from home.js. The
    // Activity panel in the right wing is the single chat surface now.
    // initStageChatLog();   // deprecated — kept import for reference
    // Right-wing To-Do tab — per-wallet task list, localStorage-backed.
    initRightWingTodo();
    // Right-wing Topics tab — per-wallet topic labels, same UX as todos.
    initRightWingTopics();
    // Right-wing "Activity" tab — the "while you were away" feed for
    // the currently-centered DexHero. Polls /api/dexhero/:tokenId/activity
    // on a 60s cadence while the doc is visible.
    initRightWingActivity();
    // Drag-to-resize handle on the LEFT edge of the right wing.
    initRightWingResize();
    // Mobile-only swipe gestures for the wing: edge-swipe-from-right
    // opens it full-bleed; swipe-right inside the wing closes it.
    // Self-no-ops on desktop (viewport >640px).
    initWingMobileSwipe();
    // Mobile-only bottom navigation bar (Home/Post/Stream/Search).
    // Hidden on desktop via CSS — mount unconditionally so screen
    // resize from desktop → mobile reveals it without re-init.
    initMobileBottomBar();
    // 8-handle resize + header drag for the floating chat overlay
    // (#lobby-chat-overlay). Mirrors right-wing-resize but writes to
    // its own --chat-overlay-* CSS vars + localStorage namespace so
    // the two surfaces don't fight over geometry.
    initChatOverlayResize();
    // Move the Activity / To-Do / Topics tab strip into the right wing
    // so it reads as the wing's header — not a floating row above the
    // bubble dock. Same click handler in stage-chat.js still drives it.
    initWingTabsMount();

    // ── Body reactive wires ──
    // The DexHero physically reacts to chat events. talk_loop fires
    // while the bubble shows thinking dots, nod fires once on each
    // user message, and the default idle loop is set by the body
    // controller when the model loads (canonical `idle` if present,
    // else legacy `walk_in_place`). All of these silently no-op on
    // existing one-clip GLBs and become reactive on future multi-clip
    // heroes (Phase E of the JarJar integration master plan).
    document.addEventListener('dexhero:chat-thinking', (ev) => {
        if (ev.detail?.thinking) body.talkStart();
        else                     body.talkStop();
    });
    document.addEventListener('dexhero:chat-message', (ev) => {
        if (ev.detail?.role === 'user') {
            body.playAnimation('nod', { once: true, duration_ms: 900 });
        }
    });
    // Workshop layer: SVG annotation overlay (BRAIN/VOICE/VISION/MEMORY/
    // SKILLS/BODY labels) that fades in on hover of the subject. Clicking
    // a label fires `dexhero:workshop-part` on the subject; the brain
    // picker (Step 4) + coming-soon placeholders (Step 5) subscribe.
    initStageAnnotations();
    // Workshop chapter: BRAIN — owner-gated LLM picker popover. Subscribes
    // to `dexhero:workshop-part` events; opens when part === 'brain'.
    initBrainPicker();
    // Workshop chapter: BODY — WoW-style equipment slot for the centered
    // 3D body. Inventory = stage._items (Truffle + owned + public top);
    // swap on click or drop from the 4-slot ribbon. Listens for legacy
    // id 'memory' (pre-Phase-5) and the new id 'body' (post-Phase-5).
    initBodyPicker();
    // Phase 7: BODY-as-outfit overlay renderer. Listens for
    // `dexhero:outfit-equip` events fired by the body picker and paints
    // a tracking-glyph overlay on top of the centered hero. Idempotent
    // self-wire — safe to call before the DOM has the subject element.
    initOutfitRenderer();
    // Workshop chapter: MOVEMENT — gesture amplitude / frequency presets
    // that re-shape the body driver's idle sway, talk bob, nod, wave, etc.
    // Listens for legacy id 'body' (pre-Phase-5) and the new id
    // 'movement' (post-Phase-5).
    initMovementPicker();
    // Phase C: VOICE — owner-gated system_prompt editor (6 presets +
    // free-text textarea) wired to PUT /api/dexhero/:id/brain.
    initVoiceEditor();
    // Phase C: SCHEDULE — owner-gated JarJar proactive-loop dials wired
    // to GET/PUT /api/dexhero/:id/proactive-settings.
    initScheduleEditor();
    // Phase D: INSTALL — JarJar desktop runtime pair flow. Mints a
    // one-time pair token, shows the desktop CLI command, polls for
    // pair-complete, then surfaces a paired-installs list with revoke
    // buttons. Backed by /api/jarjar/pair/* + /api/jarjar/installs/*.
    initInstallJarjar();
    // Workshop stubs: remaining unwired chapters (MEMORY, BODY) get a
    // "coming soon" teaser so the workshop framing is visible day one.
    initWorkshopStubs();
    // "Bring your own brain" modal — opened by the speech bubble CTA and
    // by the brain picker's Connect link. Stores the user's LLM API key
    // in localStorage; broadcasts dexhero:llm-account-changed on save.
    initLlmConnect();

    // Apply persisted right-wing-collapse state on first paint.
    _applyRightWingState();
    // 4-slot character picker (replaces carousel stepping).
    _wireSlots();

    setIdle();
}

/* ── Right-wing toggle + slot picker ─────────────────────────── */

function _toggleRightWing() {
    const wasCollapsed = _rightCollapsed;
    _rightCollapsed = !_rightCollapsed;
    try { localStorage.setItem('dexhero:rightCollapsed', String(_rightCollapsed)); } catch {}
    _applyRightWingState();
    // When opening, default to the DNA social feed pane. Used to default
    // to whatever was last shown (typically Activity / chat log); now the
    // chat-bar expand button (#lobby-stage-chat-expand) is the canonical
    // way to surface the chat log, so the arrow's job is the feed.
    if (wasCollapsed && !_rightCollapsed) {
        const feedTitle = document.getElementById('lobby-stage-bubble-titles')
            ?.querySelector('[data-bubble-tab="feed"]');
        feedTitle?.click();
    }
}

function _applyRightWingState() {
    // Toggle the visual state on the wing element itself + flag the
    // grid container so its grid-template-columns can collapse to 0
    // on the right column. Pure data-attribute switching beats :has()
    // for reliability across older Chromium / Edge builds.
    if (_dom.rightWing) {
        _dom.rightWing.classList.toggle('lobby-wing--collapsed', _rightCollapsed);
    }
    if (_dom.stageWrap) {
        _dom.stageWrap.setAttribute('data-right-collapsed', _rightCollapsed ? 'true' : 'false');
    }
    if (_dom.nextBtn) {
        _dom.nextBtn.setAttribute('data-wing-collapsed', _rightCollapsed ? 'true' : 'false');
    }
}

function _wireSlots() {
    // Delegated click handler on document — the slots container lives
    // inside the left wing, which home.js re-renders on every wallet/
    // auth state change (replaces innerHTML). A handler attached to
    // _dom.slots at init time would die on the first re-render. Document-
    // level delegation survives every wing repaint with zero re-bind.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#lobby-stage-slots [data-slot-idx]');
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-slot-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= _items.length) return;
        if (_mode !== 'idle') return;
        if (idx === _currentIdx) return;
        _currentIdx = idx;
        _paintCurrent();
    });

    // Delegated dragstart for ribbon → Body-slot drag-and-drop. The Body
    // equipment-slot listens for MIME `application/x-dexhero-hero` on its
    // equipped drop zone (see app/ui/body-picker.js + equipment-slot.js).
    // Same MIME contract can later be emitted by right-wing topics/todos
    // without consumer changes.
    document.addEventListener('dragstart', (e) => {
        const btn = e.target.closest('#lobby-stage-slots [data-item-id]');
        if (!btn || !e.dataTransfer) return;
        const tokenId = btn.getAttribute('data-item-id');
        if (!tokenId) return;
        try {
            e.dataTransfer.setData('application/x-dexhero-hero', JSON.stringify({ tokenId }));
            e.dataTransfer.effectAllowed = 'move';
        } catch {}
        btn.classList.add('is-dragging');
    });
    document.addEventListener('dragend', (e) => {
        const btn = e.target.closest('#lobby-stage-slots [data-item-id]');
        if (btn) btn.classList.remove('is-dragging');
    });

    // Watch the left wing for innerHTML replacement (home.js does this on
    // wallet/auth change). Whenever the wing's children change, the slot
    // container has been recreated empty — repaint it so the picker stays
    // populated without home.js needing to know about us.
    if (_dom.leftWing && typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver(() => {
            // Coalesce bursts of mutations into a single rAF-deferred repaint.
            if (_slotsPaintScheduled) return;
            _slotsPaintScheduled = true;
            requestAnimationFrame(() => {
                _slotsPaintScheduled = false;
                _paintSlots();
            });
        });
        mo.observe(_dom.leftWing, { childList: true, subtree: false });
    }
}
let _slotsPaintScheduled = false;

function _paintSlots() {
    // Re-lookup the host each paint — home.js replaces the left wing's
    // innerHTML, so any cached reference goes stale.
    const host = document.getElementById('lobby-stage-slots');
    if (!host) return;
    const slots = 4;
    const html = [];
    for (let i = 0; i < slots; i++) {
        const item = _items[i];
        const active = (i === _currentIdx) ? ' is-active' : '';
        if (!item) {
            html.push(`<button class="lobby-slot lobby-slot--empty${active}" type="button" disabled aria-label="Empty slot ${i + 1}"></button>`);
            continue;
        }
        const img = item.image || item.sprite || '';
        const letter = String(item.name || '?').charAt(0).toUpperCase();
        const visual = img
            ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
            : `<span class="lobby-slot__letter">${escapeHtml(letter)}</span>`;
        html.push(`<button class="lobby-slot${active}" type="button" data-slot-idx="${i}" data-item-id="${escapeHtml(item.id || '')}" draggable="true" aria-label="${escapeHtml(item.name || 'DexHero')}">${visual}</button>`);
    }
    host.innerHTML = html.join('');
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ── Modes ───────────────────────────────────────────────────── */

export async function setIdle() {
    _mode = 'idle';
    _dom.stage.setAttribute('data-stage-mode', 'idle');
    if (typeof console !== 'undefined') console.log('[stage] mode →', 'idle');
    hideCaption();

    if (!_items.length) {
        // First-paint: render Truffle Man immediately so the lobby is
        // never empty during the network round-trip to the public top
        // list. rebuildRibbon (below) overwrites with real heroes if
        // any come back, or keeps Truffle as the universal default.
        _items = [TRUFFLE_DEFAULT_SUBJECT];
        _currentIdx = 0;
        _paintCurrent();
        await rebuildRibbon({ source: 'public' });
        return;
    }
    // Returning from context — repaint whichever subject we were on.
    _paintCurrent();
}

export function setContext(subject, caption = '') {
    _mode = 'context';
    _dom.stage.setAttribute('data-stage-mode', 'context');
    if (typeof console !== 'undefined') console.log('[stage] mode →', 'context', subject?.name || '(no name)');
    _currentSubject = subject;
    renderSubject(_dom.subject, subject);
    setCaption(caption || (subject?.name ? subject.name : ''));
    emit(E.STAGE_SUBJECT, subject);
}

/* ── Items list rebuild ──────────────────────────────────────── */

/* Platform-default DexHero — Truffle Man. Shown whenever the lobby has
   nothing else to display: brand-new visitor with no wallet, signed-in
   user who hasn't minted yet, or the very first paint before the
   public top-list query resolves. Real ownership still flows through
   the existing create / mint paths — this card is purely a non-
   transferable preview body so the lobby is never empty.

   The model is the JarJar-validated humanoid (90 joints, rigged spine
   + 2 arms + 2 legs + fingers, 60-channel Idle animation). The body
   loader auto-builds a URDF for it (Phase K.1) and rapier3d simulates
   it (Phase K.2), so any future runtime work targets a known-good
   rig from the moment the page loads. */
export const TRUFFLE_DEFAULT_SUBJECT = {
    id: 'truffle-default',
    name: 'Truffle Man',
    symbol: 'TRUFFLE',
    address: null,
    network: null,
    image: null,
    model: '/models/truffle_man.glb',
    sprite: null,
    spriteFrames: 0,
    players: 0,
    games: 0,
    holders: 0,
    marketCap: 0,
    change24h: 0,
    /* `_isDefault: true` lets downstream UI (nameplate, action buttons,
       click handler) distinguish the platform default from a real
       owned token. The top-nav "Create" tab is the user's path to
       making their own; we deliberately don't wire the centered
       subject as a create CTA — overloading the model with a routing
       click hijacks the existing camera-controls + body-ready event
       chain. */
    _isDefault: true,
};

/**
 * Auth-aware items rebuild. Called by the shell whenever the wallet
 * connects/disconnects or Steam links/unlinks — swaps the displayed list
 * between the public top heroes and the user's own DexHeros without a
 * page reload. Keeps the same external signature as the legacy ribbon
 * function so app/shell.js doesn't need changes.
 *
 *   source:        'public' | 'personal'
 *   wallets:       array of wallet addresses (personal). Multiple
 *                  wallets are unioned to support "merge accounts" via
 *                  the Steam-link feature.
 *   walletAddress: legacy single-wallet alias for `wallets`.
 */
export async function rebuildRibbon({ source = 'public', wallets = null, walletAddress = null } = {}) {
    let items = [];
    try {
        if (source === 'personal') {
            const ws = wallets || (walletAddress ? [walletAddress] : []);
            if (ws.length) items = await getMyHeroes(ws, 12);
        } else {
            items = await getTopHeroes(12);
        }
    } catch (err) {
        console.warn('[stage] rebuild failed:', err.message);
    }
    items = items || [];
    // Platform default — pinned at slot 0. Source of truth is the
    // tokens row flagged `is_default=true` (see
    // db/mark-default-dexhero.sql). Promoted to `isDefault` by
    // app/services/trending.js shape(). If a flagged row is present
    // anywhere in the fetched list we move it to slot 0; if not, we
    // inject the hardcoded TRUFFLE_DEFAULT_SUBJECT as the pre-launch
    // fallback so the lobby is never empty.
    const flaggedIdx = items.findIndex(i => i && i.isDefault === true);
    if (flaggedIdx > 0) {
        const [flagged] = items.splice(flaggedIdx, 1);
        items.unshift(flagged);
    } else if (flaggedIdx === -1) {
        items = [TRUFFLE_DEFAULT_SUBJECT, ...items];
    }
    _items = items;
    _currentIdx = 0;
    if (_mode === 'idle' && _items.length) _paintCurrent();
}

/* ── Paint ───────────────────────────────────────────────────── */

function _paintCurrent() {
    const subject = _items[_currentIdx];
    if (!subject) return;
    _currentSubject = subject;
    renderSubject(_dom.subject, subject);
    _paintNameplate(subject);
    _paintDots(_currentIdx, _items.length);
    _paintSubjectClick(subject);
    _paintSlots();
    emit(E.STAGE_SUBJECT, subject);
}

/** Wire the subject's container as a click target. Default: NO click —
 *  the lobby model is no longer a navigation surface; users open the
 *  detail page via the wing/market panels instead. The only exception
 *  is the personal-empty-state CTA card (PERSONAL_EMPTY_PLACEHOLDER)
 *  which carries an explicit `_ctaHref` to route into the create flow. */
function _paintSubjectClick(subject) {
    const slot = _dom.subject;
    if (!slot) return;
    // Cleanup previous listener
    if (slot._clickHandler) {
        slot.removeEventListener('click', slot._clickHandler);
        slot._clickHandler = null;
    }
    const href = subject?._ctaHref || null;
    if (!href) {
        slot.style.cursor = 'default';
        return;
    }
    slot.style.cursor = 'pointer';
    slot._clickHandler = () => { location.hash = href; };
    slot.addEventListener('click', slot._clickHandler);
}

function _paintNameplate(subject) {
    const np = _dom.nameplate;
    if (!np) return;
    const players = Number(subject.players || subject.holders || 0);
    const games   = Number(subject.games   || 0);
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    const statBits = [];
    if (players > 0) {
        statBits.push(`
            <span class="lobby-carousel__stat" title="Players who own this DexHero">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                </svg>
                <span>${fmt(players)}</span>
            </span>`);
    }
    if (games > 0) {
        statBits.push(`
            <span class="lobby-carousel__stat" title="Games this DexHero rides in">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="6" y1="11" x2="10" y2="11"/>
                    <line x1="8" y1="9" x2="8" y2="13"/>
                    <line x1="15" y1="12" x2="15.01" y2="12"/>
                    <line x1="18" y1="10" x2="18.01" y2="10"/>
                    <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z"/>
                </svg>
                <span>${fmt(games)}</span>
            </span>`);
    }
    np.querySelector('[data-name]').textContent = subject.name || 'Untitled';
    const statsEl = np.querySelector('[data-stats]');
    statsEl.innerHTML = statBits.join('');
    statsEl.style.display = statBits.length ? '' : 'none';
}

function _paintDots(idx, total) {
    const host = _dom.dots;
    if (!host) return;
    if (host.children.length !== total) {
        host.innerHTML = '';
        for (let i = 0; i < total; i++) {
            const dot = document.createElement('i');
            dot.className = 'lobby-stage__dot';
            host.appendChild(dot);
        }
    }
    for (let i = 0; i < host.children.length; i++) {
        host.children[i].classList.toggle('lobby-stage__dot--active', i === idx);
    }
}

/* ── Caption helpers (context mode) ──────────────────────────── */

function setCaption(html) {
    if (!_dom.caption) return;
    _dom.caption.innerHTML = typeof html === 'string'
        ? (html.includes('<') ? html : `<strong>${_escape(html)}</strong>`)
        : '';
}
function hideCaption() {
    if (_dom.caption) _dom.caption.innerHTML = '';
}
function _escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
