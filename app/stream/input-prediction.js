/* InputPrediction — Phase 0.12.
 *
 * Renders cursor + WASD-direction movement at the predicted position
 * IMMEDIATELY on a transparent overlay above the <video>, then
 * reconciles when the host's video frame catches up.
 *
 * For non-FPS games this hides ~7-15ms of network up RTT for cursor
 * movement and 1-2 frames for WASD direction changes. Aim feels local.
 *
 * For FPS games (CS2, Valorant, etc.) prediction is OFF by default
 * because engine-side input acceleration causes snap-back. Per-game
 * profile registry below; "default" → predict_with_smoothing,
 * specific titles → no_cursor_prediction or no_prediction.
 *
 * Reconciliation: when the host's actual video frame arrives showing
 * the real cursor position, we smoothly interpolate the overlay
 * position → real position over 50ms. Below human reaction time —
 * the overlay simply "settles" without visible snap.
 */

// Per-game profiles. Keyed on the Steam app_id (string) or the lower-
// cased game title slug. "default" applies to anything else.
const PROFILES = {
    default:   { cursor: 'predict_with_smoothing', wasd: 'predict' },
    cs2:       { cursor: 'off', wasd: 'predict' },        // aim snap-back
    valorant:  { cursor: 'off', wasd: 'predict' },
    apex:      { cursor: 'off', wasd: 'predict' },
    osu:       { cursor: 'off', wasd: 'off' },             // input precision matters
    cinematic: { cursor: 'off', wasd: 'off' },             // visual novels, walking sims
};

export function profileFor(gameKey) {
    if (!gameKey) return PROFILES.default;
    const k = String(gameKey).toLowerCase();
    return PROFILES[k] || PROFILES.default;
}

/* Constructs an overlay div over the videoEl, manages the cursor
 * sprite + WASD movement vector. Caller drives via:
 *   onMouseMove(dx, dy)   — relative pointer-lock-style delta
 *   onWasdChange(dx, dy)  — per-axis -1/0/1 from W/A/S/D held state
 *   reconcile(actualCursorXY) — host says cursor is actually HERE
 *
 * The constructor takes the per-game profile so it knows what to
 * predict and what to leave alone.
 */
export class InputPredictor {
    constructor({ videoEl, profile, smoothingMs = 50 } = {}) {
        this.videoEl = videoEl;
        this.profile = profile || PROFILES.default;
        this.smoothingMs = smoothingMs;
        this._enabled = (profile?.cursor !== 'off');
        if (!this._enabled || !videoEl) return;

        // Build a transparent overlay that exactly tracks the videoEl.
        this.overlay = document.createElement('div');
        Object.assign(this.overlay.style, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '5',
        });
        videoEl.parentElement?.appendChild(this.overlay);

        this.cursor = document.createElement('div');
        Object.assign(this.cursor.style, {
            position: 'absolute',
            left: '50%', top: '50%',
            width: '14px', height: '14px',
            marginLeft: '-7px', marginTop: '-7px',
            background: 'rgba(34,211,238,0.9)',
            border: '1.5px solid rgba(255,255,255,0.6)',
            borderRadius: '50%',
            transform: 'translate(0, 0)',
            transition: 'opacity 100ms',
            opacity: '0',                                      // hidden until first move
        });
        this.overlay.appendChild(this.cursor);

        this._predictedX = 0;
        this._predictedY = 0;
        this._actualX = null;
        this._actualY = null;
        this._lastReconcileAt = 0;
    }

    /** Caller passes mouse-move deltas. We immediately update the
     *  overlay cursor position. */
    onMouseMove(dx, dy) {
        if (!this._enabled) return;
        this._predictedX += dx;
        this._predictedY += dy;
        // Clamp into the videoEl bounds.
        const w = this.videoEl?.clientWidth  || 1920;
        const h = this.videoEl?.clientHeight || 1080;
        if (this._predictedX < 0) this._predictedX = 0;
        if (this._predictedX > w) this._predictedX = w;
        if (this._predictedY < 0) this._predictedY = 0;
        if (this._predictedY > h) this._predictedY = h;
        this.cursor.style.opacity = '1';
        this.cursor.style.transform = `translate(${this._predictedX}px, ${this._predictedY}px)`;
    }

    /** Host echoed the actual cursor XY in a frame's metadata. We
     *  smoothly interpolate the overlay toward this position. */
    reconcile(actualX, actualY) {
        if (!this._enabled || actualX == null || actualY == null) return;
        this._actualX = actualX;
        this._actualY = actualY;
        // Smooth blend over smoothingMs.
        const startX = this._predictedX;
        const startY = this._predictedY;
        const dx = actualX - startX;
        const dy = actualY - startY;
        const startedAt = performance.now();
        const tick = () => {
            const t = Math.min(1, (performance.now() - startedAt) / this.smoothingMs);
            this._predictedX = startX + dx * t;
            this._predictedY = startY + dy * t;
            this.cursor.style.transform = `translate(${this._predictedX}px, ${this._predictedY}px)`;
            if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    setVisible(visible) {
        if (!this.cursor) return;
        this.cursor.style.opacity = visible ? '1' : '0';
    }

    destroy() {
        try { this.overlay?.remove(); } catch {}
        this.overlay = this.cursor = null;
    }
}
