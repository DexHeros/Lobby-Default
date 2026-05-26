/**
 * js/sprite-turntable.js
 *
 * Interactive 360° sprite turntable viewer.
 * Replaces <model-viewer> in the featured carousel when sprite frames are available.
 *
 * Usage:
 *   const turntable = new SpriteTurntable(container, baseUrl, 36);
 *   turntable.onReady(() => { ... show it ... });
 */

class SpriteTurntable {
    /**
     * @param {HTMLElement} container  - The .featured-hero-model element to render into
     * @param {string}      baseUrl    - Base URL ending with '/' (e.g. .../sprites/0xabc_ethereum/)
     * @param {number}      frameCount - Number of frames (default 36)
     */
    constructor(container, baseUrl, frameCount = 36) {
        this._container   = container;
        this._baseUrl     = baseUrl;
        this._frameCount  = frameCount;
        this._currentFrame = 0;
        this._readyCbs    = [];
        this._destroyed   = false;
        this._rafId       = null;
        this._autoPlaying = false;
        this._pointerDown = false;
        this._lastPointerX = 0;
        this._dragAccum   = 0;   // sub-pixel drag accumulator

        // ── Build DOM ─────────────────────────────────────────────────
        // Reuse the .featured-hero-sprite wrapper already present in the HTML
        // (placed there by createFeaturedCard). If not found, create one.
        this._wrapper = container.querySelector('.featured-hero-sprite');
        if (!this._wrapper) {
            this._wrapper = document.createElement('div');
            this._wrapper.className = 'featured-hero-sprite';
            container.appendChild(this._wrapper);
        }

        this._img = document.createElement('img');
        this._img.alt = '';
        this._img.draggable = false;
        this._img.className = 'sprite-frame-img';
        this._wrapper.appendChild(this._img);

        // ── Load first frame ──────────────────────────────────────────
        this._img.onload = () => {
            if (this._destroyed) return;
            this._readyCbs.forEach(cb => cb());
            this._readyCbs = [];
        };
        this._img.onerror = () => {
            console.warn('[SpriteTurntable] Failed to load frame_000');
        };
        this._img.src = this._frameUrl(0);

        // ── Background-preload remaining frames ───────────────────────
        this._preloadImages = [];
        for (let i = 1; i < frameCount; i++) {
            const img = new Image();
            img.src = this._frameUrl(i);
            this._preloadImages.push(img);
        }

        // ── Bind interaction ───────────────────────────────────────────
        this._bindEvents();
    }

    // ── Public API ────────────────────────────────────────────────────

    /** Register a callback to fire once the first frame has loaded. */
    onReady(cb) {
        if (this._img.complete && this._img.naturalWidth > 0) {
            cb();
        } else {
            this._readyCbs.push(cb);
        }
    }

    /** Jump to a specific frame index (wraps around). */
    setFrame(index) {
        if (this._destroyed) return;
        this._currentFrame = ((index % this._frameCount) + this._frameCount) % this._frameCount;
        this._img.src = this._frameUrl(this._currentFrame);
    }

    /** Tear down events and remove DOM element. */
    destroy() {
        this._destroyed = true;
        this._stopAutoPlay();
        this._unbindEvents();
        if (this._wrapper.parentNode) {
            this._wrapper.parentNode.removeChild(this._wrapper);
        }
        this._preloadImages = [];
    }

    // ── Private ────────────────────────────────────────────────────────

    _frameUrl(index) {
        const name = 'frame_' + String(index).padStart(3, '0') + '.webp';
        return this._baseUrl + name;
    }

    // Auto-play at 12 fps via requestAnimationFrame
    _startAutoPlay() {
        if (this._autoPlaying || this._destroyed) return;
        this._autoPlaying = true;
        let last = 0;
        const interval = 1000 / 12;

        const tick = (now) => {
            if (!this._autoPlaying || this._destroyed) return;
            if (now - last >= interval) {
                last = now;
                this.setFrame(this._currentFrame + 1);
            }
            this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stopAutoPlay() {
        this._autoPlaying = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _bindEvents() {
        this._onPointerDown  = this._handlePointerDown.bind(this);
        this._onPointerMove  = this._handlePointerMove.bind(this);
        this._onPointerUp    = this._handlePointerUp.bind(this);
        this._onMouseEnter   = this._handleMouseEnter.bind(this);
        this._onMouseLeave   = this._handleMouseLeave.bind(this);

        this._wrapper.addEventListener('pointerdown',  this._onPointerDown,  { passive: true });
        this._wrapper.addEventListener('pointermove',  this._onPointerMove,  { passive: true });
        this._wrapper.addEventListener('pointerup',    this._onPointerUp,    { passive: true });
        this._wrapper.addEventListener('pointercancel',this._onPointerUp,    { passive: true });
        this._wrapper.addEventListener('mouseenter',   this._onMouseEnter);
        this._wrapper.addEventListener('mouseleave',   this._onMouseLeave);
    }

    _unbindEvents() {
        this._wrapper.removeEventListener('pointerdown',   this._onPointerDown);
        this._wrapper.removeEventListener('pointermove',   this._onPointerMove);
        this._wrapper.removeEventListener('pointerup',     this._onPointerUp);
        this._wrapper.removeEventListener('pointercancel', this._onPointerUp);
        this._wrapper.removeEventListener('mouseenter',    this._onMouseEnter);
        this._wrapper.removeEventListener('mouseleave',    this._onMouseLeave);
    }

    _handlePointerDown(e) {
        this._pointerDown  = true;
        this._lastPointerX = e.clientX;
        this._dragAccum    = 0;
        this._stopAutoPlay();
        try { this._wrapper.setPointerCapture(e.pointerId); } catch (_) {}
    }

    _handlePointerMove(e) {
        if (!this._pointerDown) return;
        const dx = e.clientX - this._lastPointerX;
        this._lastPointerX = e.clientX;

        // 1 frame per 6px of drag (sub-pixel accumulation for precision)
        this._dragAccum += dx;
        const frames = Math.trunc(this._dragAccum / 6);
        if (frames !== 0) {
            this._dragAccum -= frames * 6;
            this.setFrame(this._currentFrame - frames); // left-drag = clockwise
        }
    }

    _handlePointerUp() {
        this._pointerDown = false;
    }

    _handleMouseEnter() {
        if (!this._pointerDown) this._startAutoPlay();
    }

    _handleMouseLeave() {
        this._stopAutoPlay();
    }
}

// Expose globally (loaded as a plain <script>)
window.SpriteTurntable = SpriteTurntable;
