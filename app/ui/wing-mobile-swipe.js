/* Mobile-only swipe gestures for the right-wing/feed.
 *
 * Pairs with the shell.css mobile-override block that makes
 * .lobby-wing--right fill the viewport when open and slide off-right
 * when collapsed. The wing's open/closed state is owned by stage.js
 * (_toggleRightWing); we just trigger it by dispatching a click on
 * the existing toggle button so we don't need an extra public API
 * surface on stage.js.
 *
 * Two gestures:
 *   1) Edge-open: pointerdown within EDGE_GUTTER px of the right
 *      viewport edge + drag THRESHOLD px to the left → opens the wing.
 *   2) Wing-close: pointerdown anywhere on the wing while it's open
 *      + drag THRESHOLD px to the right → closes the wing.
 *
 * Desktop (>640px) is a no-op — the click-tab and drag-resize flows
 * already cover desktop. The handler attaches on initWingMobileSwipe()
 * call from app/shell.js, watches the matchMedia for breakpoint
 * crossings, and self-suspends when viewport widens past 640px. */

const MOBILE_QUERY = '(max-width: 640px)';
const EDGE_GUTTER  = 30;   // px from right viewport edge that counts as an open-swipe origin
const THRESHOLD    = 50;   // px horizontal travel to commit a gesture
const VERT_REJECT  = 1.2;  // |dy| > this * |dx| → treat as vertical scroll, abort

let _wired = false;

export function initWingMobileSwipe() {
    if (_wired) return;
    _wired = true;

    const mql = window.matchMedia ? window.matchMedia(MOBILE_QUERY) : null;
    const isMobile = () => !!mql && mql.matches;

    let startX = null;
    let startY = null;
    let mode = null;          // 'open' | 'close' | null
    let committed = false;    // true once we've decided this gesture matters

    const getWing = () => document.querySelector('.lobby-wing--right');
    const getBtn  = () => document.getElementById('lobby-stage-next');
    const isWingOpen = () => {
        const w = getWing();
        return !!w && !w.classList.contains('lobby-wing--collapsed');
    };

    const onDown = (ev) => {
        if (!isMobile()) return;
        // Ignore non-primary buttons (right-click, multi-touch second finger).
        if (ev.button != null && ev.button !== 0) return;
        // Don't hijack interactive controls — the user is trying to tap a
        // button/input/link, not swipe the wing.
        if (ev.target && ev.target.closest &&
            ev.target.closest('button, a, input, textarea, select, [data-social-action], [data-no-swipe]')) {
            return;
        }
        const x = ev.clientX;
        const y = ev.clientY;
        const vw = window.innerWidth;
        const open = isWingOpen();
        if (open) {
            // Wing is open and full-bleed — any pointer-down on the wing
            // is a candidate close-swipe. The wing covers the viewport
            // so we just check that the target is inside it.
            const w = getWing();
            if (!w || !w.contains(ev.target)) return;
            mode = 'close';
        } else {
            // Wing is closed — only edge-anchored swipes count.
            if (x < vw - EDGE_GUTTER) return;
            mode = 'open';
        }
        startX = x;
        startY = y;
        committed = false;
    };

    const onMove = (ev) => {
        if (startX == null) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!committed) {
            if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
            // Vertical scroll wins — abort so the page scrolls naturally.
            if (Math.abs(dy) > VERT_REJECT * Math.abs(dx)) { _reset(); return; }
            committed = true;
        }
        // Direction check: opening is left-swipe (dx negative), closing is
        // right-swipe (dx positive). Wrong direction → abort.
        if (mode === 'open'  && dx > 0)  { _reset(); return; }
        if (mode === 'close' && dx < 0)  { _reset(); return; }
    };

    const onUp = (ev) => {
        if (startX == null) { return; }
        const dx = ev.clientX - startX;
        if (committed && Math.abs(dx) >= THRESHOLD) {
            const open = isWingOpen();
            if (mode === 'open'  && !open) getBtn()?.click();
            if (mode === 'close' &&  open) getBtn()?.click();
        }
        _reset();
    };

    const _reset = () => {
        startX = null;
        startY = null;
        mode = null;
        committed = false;
    };

    // Listen on document so we catch swipes that start outside the wing
    // (edge-open case) and bubble naturally. passive:true keeps native
    // vertical scroll responsive — we never preventDefault.
    document.addEventListener('pointerdown',   onDown, { passive: true });
    document.addEventListener('pointermove',   onMove, { passive: true });
    document.addEventListener('pointerup',     onUp,   { passive: true });
    document.addEventListener('pointercancel', onUp,   { passive: true });

    // If the viewport widens past mobile mid-gesture, abort cleanly.
    mql?.addEventListener?.('change', () => { if (!isMobile()) _reset(); });
}
