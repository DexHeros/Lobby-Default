/* right-wing-resize — 8-handle resize + header drag-to-move.
 *
 * Wing is left-anchored (CSS uses top + left + width + height) so it
 * can be moved anywhere on the viewport. All four geometry values
 * live as CSS variables on :root and are persisted to localStorage.
 *
 * Handles:
 *   ┌─ NW ─── N ─── NE ─┐
 *   │                   │
 *   W       (drag        E
 *   │       header        │
 *   │       to move)      │
 *   └─ SW ─── S ─── SE ─┘
 *
 * - W / E edges → width (W also adjusts left so right edge stays put)
 * - N / S edges → height (N also adjusts top so bottom edge stays put)
 * - Corners → both axes combined
 * - Click+drag on .chat-log__head → move the entire wing (left+top)
 */

const KEY_W = 'v3labs:wing-right-width';
const KEY_H = 'v3labs:wing-right-height';
const KEY_T = 'v3labs:wing-right-top';
const KEY_L = 'v3labs:wing-right-left';

const MIN_W = 280;
const MAX_W = 1100;
const MIN_H = 240;
const HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

let _wired = false;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function applyVar(name, px) {
    document.documentElement.style.setProperty(name, `${px}px`);
}
function readPersist(key, min, max) {
    try {
        const v = parseInt(localStorage.getItem(key) || '', 10);
        if (Number.isFinite(v) && v >= min && (max == null || v <= max)) return v;
    } catch {}
    return null;
}
function restorePersisted() {
    const VW = window.innerWidth;
    const VH = window.innerHeight;
    const w = readPersist(KEY_W, MIN_W, MAX_W);
    const h = readPersist(KEY_H, MIN_H, VH - 32);
    const t = readPersist(KEY_T, 0, Math.round(VH * 0.7));
    const l = readPersist(KEY_L, -100, VW - 100);
    if (w != null) applyVar('--wing-right-width',  w);
    if (h != null) applyVar('--wing-right-height', h);
    if (t != null) applyVar('--wing-right-top',    t);
    if (l != null) applyVar('--wing-right-left',   l);
}

function ensureHandles(wing) {
    const created = {};
    for (const dir of HANDLES) {
        let h = wing.querySelector(`:scope > .wing-resize-handle--${dir}`);
        if (!h) {
            h = document.createElement('div');
            h.className = `wing-resize-handle wing-resize-handle--${dir}`;
            h.setAttribute('aria-label', `Resize ${dir}`);
            wing.appendChild(h);
        }
        created[dir] = h;
    }
    return created;
}

function startResize({ dir, e, wing }) {
    const getPt = (ev) => (ev.touches && ev.touches[0] ? ev.touches[0] : ev);
    const sp = getPt(e);
    const startX = sp.clientX;
    const startY = sp.clientY;
    const r = wing.getBoundingClientRect();
    const startW = r.width;
    const startH = r.height;
    const startTop = r.top;
    const startLeft = r.left;
    const maxH = Math.round(window.innerHeight - 32);
    const maxTop = Math.round(window.innerHeight - MIN_H);
    const maxLeft = Math.round(window.innerWidth - MIN_W);

    const onMove = (ev) => {
        const pt = getPt(ev);
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;

        // W edge: drag left side — left shifts with cursor, right stays.
        if (dir.includes('w')) {
            const newLeft = clamp(startLeft + dx, -100, startLeft + startW - MIN_W);
            const consumedDx = newLeft - startLeft;
            const newW = clamp(startW - consumedDx, MIN_W, MAX_W);
            applyVar('--wing-right-left',  newLeft);
            applyVar('--wing-right-width', newW);
        }
        // E edge: drag right side — width grows; left stays.
        if (dir.includes('e')) {
            const newW = clamp(startW + dx, MIN_W, MAX_W);
            applyVar('--wing-right-width', newW);
        }
        // N edge: drag top — top shifts with cursor, bottom stays.
        if (dir.includes('n')) {
            const newTop = clamp(startTop + dy, 0, startTop + startH - MIN_H);
            const consumedDy = newTop - startTop;
            const newH = clamp(startH - consumedDy, MIN_H, maxH);
            applyVar('--wing-right-top',    newTop);
            applyVar('--wing-right-height', newH);
        }
        // S edge: drag bottom — height grows; top stays.
        if (dir.includes('s')) {
            applyVar('--wing-right-height', clamp(startH + dy, MIN_H, maxH));
        }
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        wing.classList.remove('is-resizing');
        document.body.classList.remove('is-wing-resizing');
        persistGeometry(wing);
    };
    wing.classList.add('is-resizing');
    document.body.classList.add('is-wing-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
}

function startMove({ e, wing }) {
    const getPt = (ev) => (ev.touches && ev.touches[0] ? ev.touches[0] : ev);
    const sp = getPt(e);
    const startX = sp.clientX;
    const startY = sp.clientY;
    const r = wing.getBoundingClientRect();
    const startTop = r.top;
    const startLeft = r.left;

    const onMove = (ev) => {
        const pt = getPt(ev);
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;
        // Keep at least 60px of the wing on-screen so it can't get lost.
        const VW = window.innerWidth;
        const VH = window.innerHeight;
        const newLeft = clamp(startLeft + dx, -(r.width - 60), VW - 60);
        const newTop  = clamp(startTop  + dy, 0,                VH - 60);
        applyVar('--wing-right-left', newLeft);
        applyVar('--wing-right-top',  newTop);
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        wing.classList.remove('is-moving');
        document.body.classList.remove('is-wing-resizing');
        persistGeometry(wing);
    };
    wing.classList.add('is-moving');
    document.body.classList.add('is-wing-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
}

function persistGeometry(wing) {
    try {
        const r = wing.getBoundingClientRect();
        localStorage.setItem(KEY_W, String(Math.round(r.width)));
        localStorage.setItem(KEY_H, String(Math.round(r.height)));
        localStorage.setItem(KEY_T, String(Math.round(r.top)));
        localStorage.setItem(KEY_L, String(Math.round(r.left)));
    } catch {}
}

function attachResize(handles, wing) {
    for (const [dir, h] of Object.entries(handles)) {
        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            startResize({ dir, e, wing });
        };
        h.addEventListener('mousedown', onDown);
        h.addEventListener('touchstart', onDown, { passive: false });
    }
}

/** Attach the drag-to-move handler to every draggable container inside
 *  the wing. Clicking + holding ANYWHERE on the panel — header, borders,
 *  empty state — starts a move, EXCEPT:
 *    - on a scrollable / selectable list (so text-select + scroll still work)
 *    - on a resize handle (those have their own stopPropagation)
 *    - on an interactive element (button, link, input)
 *  Re-runs after home.js re-renders. */
function attachContainerDrag(wing) {
    // Bind to BOTH chat-log panels AND the .dna__feed-rail (Git Feed)
    // — every container that can be the visible panel inside the wing
    // should respond to drag-to-move from its background.
    const containers = wing.querySelectorAll('.chat-log, .dna__feed-rail');
    for (const container of containers) {
        if (container.dataset.wingDrag === '1') continue;
        container.dataset.wingDrag = '1';
        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            const t = e.target;
            if (!(t instanceof Element)) return;
            // Scrollable / selectable / interactive content — let it
            // own its own gestures.
            if (t.closest('.activity__list'))                      return; // chat messages
            if (t.closest('.topics__list'))                        return; // topics rows
            if (t.closest('.todo__list'))                          return; // todo checkboxes
            if (t.closest('.dna__feed-rail__list'))                return; // feed cards
            if (t.closest('.dna__feed-repo__readme'))              return; // expanded README
            if (t.closest('.dna__feed-card'))                      return; // card click → detail
            if (t.closest('.wing-resize-handle'))                  return; // resize handles win
            if (t.closest('button, a, input, textarea, select'))   return; // any interactive UI
            e.preventDefault();
            startMove({ e, wing });
        };
        container.addEventListener('mousedown', onDown);
        container.addEventListener('touchstart', onDown, { passive: false });
    }
}

function resetAll() {
    for (const k of [KEY_W, KEY_H, KEY_T, KEY_L]) {
        try { localStorage.removeItem(k); } catch {}
    }
    for (const v of [
        '--wing-right-width',
        '--wing-right-height',
        '--wing-right-top',
        '--wing-right-left',
    ]) {
        document.documentElement.style.removeProperty(v);
    }
}

export function initRightWingResize() {
    if (_wired) return;
    _wired = true;

    const attach = () => {
        const wing = document.getElementById('lobby-wing-right');
        if (!wing) return false;
        restorePersisted();
        const handles = ensureHandles(wing);
        attachResize(handles, wing);
        for (const h of Object.values(handles)) {
            h.addEventListener('dblclick', (ev) => { ev.stopPropagation(); resetAll(); });
        }
        attachContainerDrag(wing);
        return true;
    };

    if (!attach()) setTimeout(attach, 0);

    // Survive home.js re-renders. Re-attach handles + the header drag
    // any time the wing's children get wiped + re-rendered.
    const obs = new MutationObserver(() => {
        const wing = document.getElementById('lobby-wing-right');
        if (!wing) return;
        const missing = HANDLES.some((d) => !wing.querySelector(`:scope > .wing-resize-handle--${d}`));
        if (missing) {
            const handles = ensureHandles(wing);
            attachResize(handles, wing);
            for (const h of Object.values(handles)) {
                h.addEventListener('dblclick', (ev) => { ev.stopPropagation(); resetAll(); });
            }
            restorePersisted();
        }
        // Header may have re-rendered even if handles are intact
        attachContainerDrag(wing);
    });
    obs.observe(document.body, { childList: true, subtree: true });
}
