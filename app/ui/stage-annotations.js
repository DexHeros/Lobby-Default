/* Stage annotations — workshop entrance for the centered DexHero.
 *
 * Four labeled callouts orbit the model:
 *
 *     BRAIN          ── intelligence.providers[]
 *     VOICE          ── behavior.system_prompt (+ future TTS)
 *     MEMORY         ── memory.lesson_max_bytes
 *     BODY           ── body.rig_variant (already chosen at mint)
 *
 * Each label dispatches a `dexhero:workshop-part` CustomEvent on the
 * subject when clicked. The brain picker and the coming-soon
 * placeholders subscribe to that event.
 *
 * Visibility is driven by the subject's `data-swapping` attribute (set
 * by stage-subject.js during the 180ms swap-fade animation). When the
 * swap settles, CSS fades the overlay in.
 *
 * Both ends of every callout are draggable — drag the label OR the
 * anchor dot to reposition. The connecting line always tracks both
 * ends live. Positions persist per-user in localStorage; the PARTS
 * config below is the factory default that ships first-time visitors.
 */

const PARTS = [
    { id: 'brain',    label: 'Brain',    anchor: [39, 10], label_at: [30,  5], side: 'top'    },
    // 'movement' = rig + locomotion. Was id:'body' in v1 (renamed in v2).
    { id: 'movement', label: 'Movement', anchor: [51, 82], label_at: [84, 94], side: 'bottom' },
    // 'body' = physical mesh / 3D model swap. Was id:'memory' in v1.
    { id: 'body',     label: 'Body',     anchor: [23, 62], label_at: [15, 64], side: 'left'   },
    { id: 'voice',    label: 'Voice',    anchor: [66, 27], label_at: [80, 29], side: 'right'  },
    // 'schedule' and 'install' moved to the future per-DexHero settings
    // page — no longer surfaced as lined-title callouts on the body.
    // The schedule-editor / install-jarjar modules stay registered so
    // the settings page can still dispatch their workshop-part events.
];

const STORAGE_KEY = 'dexhero:annotations:v2';
const LEGACY_STORAGE_KEY = 'dexhero:annotations:v1';
// One-shot v1 → v2 migration map for the id rename:
//   memory → body    (label "Body" — physical mesh)
//   body   → movement (label "Movement" — rig + locomotion)
const ID_MIGRATION = { memory: 'body', body: 'movement' };
const DRAG_CLICK_THRESHOLD = 4;   // px of movement before pointerup is interpreted as a drag

let _wired = false;
let _subjectEl = null;
let _overlay = null;
let _svg = null;
const _state = {};   // part id → { anchor: [x,y], label_at: [x,y], side, label }
const _nodes = {};   // part id → { path, dot, dotHit, label }

/* ── State persistence ──────────────────────────────────────────── */

function _loadState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch {}
    // One-shot v1 → v2 migration: if the v2 key is missing but a v1
    // payload exists, map the old ids ('memory' → 'body', 'body' →
    // 'movement') and write the migrated value under the new key. v1
    // entry is removed afterwards to free localStorage quota.
    if (!Object.keys(saved).length) {
        try {
            const v1 = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}') || {};
            if (Object.keys(v1).length) {
                const migrated = {};
                for (const [oldId, val] of Object.entries(v1)) {
                    const newId = ID_MIGRATION[oldId] || oldId;
                    migrated[newId] = val;
                }
                saved = migrated;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
                localStorage.removeItem(LEGACY_STORAGE_KEY);
            }
        } catch {}
    }
    for (const p of PARTS) {
        const s = saved[p.id];
        _state[p.id] = {
            label:    p.label,
            side:     p.side,
            anchor:   Array.isArray(s?.anchor)   && s.anchor.length === 2   ? s.anchor.slice()   : p.anchor.slice(),
            label_at: Array.isArray(s?.label_at) && s.label_at.length === 2 ? s.label_at.slice() : p.label_at.slice(),
        };
    }
}

function _saveState() {
    const payload = {};
    for (const id of Object.keys(_state)) {
        payload[id] = {
            anchor:   _state[id].anchor,
            label_at: _state[id].label_at,
        };
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
}

/* ── DOM build ──────────────────────────────────────────────────── */

function ensureOverlayAttached() {
    if (!_subjectEl || !_overlay) return;
    if (_overlay.parentNode === _subjectEl) return;
    _subjectEl.appendChild(_overlay);
}

function buildOverlay() {
    if (_overlay) return _overlay;

    const wrap = document.createElement('div');
    wrap.className = 'lobby-stage__annotations';
    wrap.setAttribute('aria-hidden', 'true');

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'lobby-stage__anno-svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    _svg = svg;

    for (const p of PARTS) {
        const st = _state[p.id];

        // Line: anchor → label
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', `M ${st.anchor[0]} ${st.anchor[1]} L ${st.label_at[0]} ${st.label_at[1]}`);
        path.setAttribute('class', `lobby-stage__anno-line lobby-stage__anno-line--${p.id}`);
        svg.appendChild(path);

        // Visible anchor dot (small) + a larger transparent hit-target
        // for drag because 0.9% is too small to grab on a phone.
        const dotHit = document.createElementNS(svgNS, 'circle');
        dotHit.setAttribute('cx', st.anchor[0]);
        dotHit.setAttribute('cy', st.anchor[1]);
        dotHit.setAttribute('r', '3');
        dotHit.setAttribute('class', 'lobby-stage__anno-dot-hit');
        dotHit.dataset.part = p.id;
        dotHit.dataset.end  = 'anchor';
        svg.appendChild(dotHit);

        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', st.anchor[0]);
        dot.setAttribute('cy', st.anchor[1]);
        dot.setAttribute('r', '0.9');
        dot.setAttribute('class', 'lobby-stage__anno-dot');
        svg.appendChild(dot);

        _nodes[p.id] = { path, dot, dotHit };
    }
    wrap.appendChild(svg);

    // HTML labels — positioned by percent.
    for (const p of PARTS) {
        const st = _state[p.id];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `lobby-stage__anno-label lobby-stage__anno-label--${p.side}`;
        btn.dataset.part = p.id;
        btn.dataset.end  = 'label';
        btn.style.left = `${st.label_at[0]}%`;
        btn.style.top  = `${st.label_at[1]}%`;
        btn.innerHTML = `
            <span class="lobby-stage__anno-label-text">${p.label}</span>
            <span class="lobby-stage__anno-chev" aria-hidden="true">▾</span>
        `;
        btn.addEventListener('click', (ev) => {
            // Suppress click if a drag just ended (see _attachDrag).
            if (btn.dataset.justDragged === '1') {
                btn.dataset.justDragged = '0';
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            ev.stopPropagation();
            ev.preventDefault();
            _subjectEl?.dispatchEvent(new CustomEvent('dexhero:workshop-part', {
                bubbles: true,
                detail: { part: p.id, label: p.label, anchorEl: btn },
            }));
        });
        wrap.appendChild(btn);
        _nodes[p.id].label = btn;
    }

    _overlay = wrap;

    // Wire drag handlers AFTER all nodes exist so dot+label re-render
    // can reference siblings via _nodes.
    for (const p of PARTS) {
        _attachDrag(_nodes[p.id].label,  p.id, 'label');
        _attachDrag(_nodes[p.id].dotHit, p.id, 'anchor');
    }

    return wrap;
}

/* ── Drag plumbing ──────────────────────────────────────────────── */

function _attachDrag(handle, partId, end) {
    if (!handle) return;
    let startX = 0;
    let startY = 0;
    let moved  = false;
    let active = false;

    handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return; // left click / primary touch only
        active = true;
        moved  = false;
        startX = ev.clientX;
        startY = ev.clientY;
        try { handle.setPointerCapture(ev.pointerId); } catch {}
        handle.classList.add('is-dragging');
        // Don't preventDefault on the down — we still want focus
        // behavior for the button. Click suppression happens via the
        // `justDragged` flag after pointerup.
    });

    handle.addEventListener('pointermove', (ev) => {
        if (!active) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < DRAG_CLICK_THRESHOLD) return;
        moved = true;
        ev.preventDefault();

        // Convert client coords → percent inside the subject's box. The
        // overlay covers .lobby-stage__subject with inset: 0; both share
        // the same bounding box.
        const rect = _subjectEl.getBoundingClientRect();
        const xPct = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width)  * 100));
        const yPct = Math.max(0, Math.min(100, ((ev.clientY - rect.top)  / rect.height) * 100));

        const st = _state[partId];
        if (end === 'label') {
            st.label_at = [xPct, yPct];
        } else {
            st.anchor = [xPct, yPct];
        }
        _renderPart(partId);
    });

    const finish = () => {
        if (!active) return;
        active = false;
        handle.classList.remove('is-dragging');
        if (moved) {
            _saveState();
            // Suppress the imminent click event when ending a drag on a
            // button — the user just dragged, not clicked. The flag is
            // read in the click handler on the next event loop tick.
            if (end === 'label') {
                _nodes[partId].label.dataset.justDragged = '1';
                setTimeout(() => {
                    if (_nodes[partId]?.label) _nodes[partId].label.dataset.justDragged = '0';
                }, 80);
            }
        }
    };
    handle.addEventListener('pointerup',     finish);
    handle.addEventListener('pointercancel', finish);
}

function _renderPart(partId) {
    const st = _state[partId];
    const n  = _nodes[partId];
    if (!st || !n) return;
    n.path.setAttribute('d', `M ${st.anchor[0]} ${st.anchor[1]} L ${st.label_at[0]} ${st.label_at[1]}`);
    n.dot.setAttribute('cx', st.anchor[0]);
    n.dot.setAttribute('cy', st.anchor[1]);
    n.dotHit.setAttribute('cx', st.anchor[0]);
    n.dotHit.setAttribute('cy', st.anchor[1]);
    n.label.style.left = `${st.label_at[0]}%`;
    n.label.style.top  = `${st.label_at[1]}%`;
}

/* ── Public init ────────────────────────────────────────────────── */

export function initStageAnnotations() {
    if (_wired) return;
    _subjectEl = document.getElementById('lobby-stage-subject');
    if (!_subjectEl) return;

    _loadState();
    const overlay = buildOverlay();
    _subjectEl.appendChild(overlay);

    const mo = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.type === 'childList') ensureOverlayAttached();
            if (m.type === 'attributes' && m.attributeName === 'data-swapping') {
                if (_overlay && _subjectEl.getAttribute('data-swapping') !== 'true') {
                    _overlay.classList.add('is-ready');
                }
            }
        }
    });
    mo.observe(_subjectEl, {
        childList: true,
        attributes: true,
        attributeFilter: ['data-swapping'],
    });

    _wired = true;
}
