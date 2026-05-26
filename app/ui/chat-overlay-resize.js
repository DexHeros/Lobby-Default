/* chat-overlay-resize — 8-handle resize + header drag-to-move for the
 * floating chat overlay (#lobby-chat-overlay). Mirrors the wiring used
 * by right-wing-resize.js but targets the chat overlay element and
 * writes to its own --chat-overlay-* CSS vars + v3labs:chat-overlay-*
 * localStorage keys so the two surfaces don't fight over geometry.
 *
 * Handles:
 *   ┌─ NW ─── N ─── NE ─┐
 *   │                   │
 *   W   (drag header)   E
 *   │                   │
 *   └─ SW ─── S ─── SE ─┘
 */

const KEY_W = 'v3labs:chat-overlay-width';
const KEY_H = 'v3labs:chat-overlay-height';
const KEY_T = 'v3labs:chat-overlay-top';
const KEY_L = 'v3labs:chat-overlay-left';

const MIN_W = 320;
const MAX_W = 900;
const MIN_H = 280;
const HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

const OVERLAY_ID = 'lobby-chat-overlay';

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
    const t = readPersist(KEY_T, 0, Math.round(VH * 0.85));
    const l = readPersist(KEY_L, -100, VW - 100);
    if (w != null) applyVar('--chat-overlay-width',  w);
    if (h != null) applyVar('--chat-overlay-height', h);
    if (t != null) applyVar('--chat-overlay-top',    t);
    if (l != null) applyVar('--chat-overlay-left',   l);
}

function ensureHandles(overlay) {
    const created = {};
    for (const dir of HANDLES) {
        let h = overlay.querySelector(`:scope > .chat-overlay-resize-handle--${dir}`);
        if (!h) {
            h = document.createElement('div');
            h.className = `chat-overlay-resize-handle chat-overlay-resize-handle--${dir}`;
            h.setAttribute('aria-label', `Resize ${dir}`);
            overlay.appendChild(h);
        }
        created[dir] = h;
    }
    return created;
}

function startResize({ dir, e, overlay }) {
    const getPt = (ev) => (ev.touches && ev.touches[0] ? ev.touches[0] : ev);
    const sp = getPt(e);
    const startX = sp.clientX;
    const startY = sp.clientY;
    const r = overlay.getBoundingClientRect();
    const startW = r.width;
    const startH = r.height;
    const startTop = r.top;
    const startLeft = r.left;
    const maxH = Math.round(window.innerHeight - 32);

    const onMove = (ev) => {
        const pt = getPt(ev);
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;
        if (dir.includes('w')) {
            const newLeft = clamp(startLeft + dx, -100, startLeft + startW - MIN_W);
            const consumedDx = newLeft - startLeft;
            const newW = clamp(startW - consumedDx, MIN_W, MAX_W);
            applyVar('--chat-overlay-left',  newLeft);
            applyVar('--chat-overlay-width', newW);
        }
        if (dir.includes('e')) {
            applyVar('--chat-overlay-width', clamp(startW + dx, MIN_W, MAX_W));
        }
        if (dir.includes('n')) {
            const newTop = clamp(startTop + dy, 0, startTop + startH - MIN_H);
            const consumedDy = newTop - startTop;
            const newH = clamp(startH - consumedDy, MIN_H, maxH);
            applyVar('--chat-overlay-top',    newTop);
            applyVar('--chat-overlay-height', newH);
        }
        if (dir.includes('s')) {
            applyVar('--chat-overlay-height', clamp(startH + dy, MIN_H, maxH));
        }
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        overlay.classList.remove('is-resizing');
        document.body.classList.remove('is-chat-overlay-resizing');
        persistGeometry(overlay);
    };
    overlay.classList.add('is-resizing');
    document.body.classList.add('is-chat-overlay-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
}

function startMove({ e, overlay }) {
    const getPt = (ev) => (ev.touches && ev.touches[0] ? ev.touches[0] : ev);
    const sp = getPt(e);
    const startX = sp.clientX;
    const startY = sp.clientY;
    const r = overlay.getBoundingClientRect();
    const startTop = r.top;
    const startLeft = r.left;

    const onMove = (ev) => {
        const pt = getPt(ev);
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;
        const VW = window.innerWidth;
        const VH = window.innerHeight;
        const newLeft = clamp(startLeft + dx, -(r.width - 60), VW - 60);
        const newTop  = clamp(startTop  + dy, 0,                VH - 60);
        applyVar('--chat-overlay-left', newLeft);
        applyVar('--chat-overlay-top',  newTop);
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        overlay.classList.remove('is-moving');
        document.body.classList.remove('is-chat-overlay-resizing');
        persistGeometry(overlay);
    };
    overlay.classList.add('is-moving');
    document.body.classList.add('is-chat-overlay-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
}

function persistGeometry(overlay) {
    try {
        const r = overlay.getBoundingClientRect();
        localStorage.setItem(KEY_W, String(Math.round(r.width)));
        localStorage.setItem(KEY_H, String(Math.round(r.height)));
        localStorage.setItem(KEY_T, String(Math.round(r.top)));
        localStorage.setItem(KEY_L, String(Math.round(r.left)));
    } catch {}
}

function attachResize(handles, overlay) {
    for (const [dir, h] of Object.entries(handles)) {
        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            startResize({ dir, e, overlay });
        };
        h.addEventListener('mousedown', onDown);
        h.addEventListener('touchstart', onDown, { passive: false });
    }
}

/* Drag-to-move: attach to the [data-overlay-drag] header. Interactive
 * children (close button, etc.) get their clicks via stopPropagation /
 * standard event handling — the drag handler bails on those targets. */
function attachHeaderDrag(overlay) {
    const head = overlay.querySelector('[data-overlay-drag]');
    if (!head || head.dataset.overlayDragWired === '1') return;
    head.dataset.overlayDragWired = '1';
    const onDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('button, a, input, textarea, select')) return;
        if (t.closest('.chat-overlay-resize-handle')) return;
        e.preventDefault();
        startMove({ e, overlay });
    };
    head.addEventListener('mousedown', onDown);
    head.addEventListener('touchstart', onDown, { passive: false });
}

export function initChatOverlayResize() {
    if (_wired) return;
    _wired = true;

    const attach = () => {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return false;
        restorePersisted();
        const handles = ensureHandles(overlay);
        attachResize(handles, overlay);
        attachHeaderDrag(overlay);
        return true;
    };

    if (!attach()) setTimeout(attach, 0);
}
