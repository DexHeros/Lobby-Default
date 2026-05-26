/* V3Labs meteor / orb-upgrade system — ported from the legacy homepage.

   Flow per card:
     1. Card renders with a static thumbnail inside .featured-hero-sprite.
     2. When the card becomes the most-centered (or an initial candidate),
        upgradeCard(item) is called.
     3. A SpriteTurntable begins preloading frames in the background.
     4. Simultaneously, a free-roaming meteor element is spawned on the page,
        flying random arcs across the viewport.
     5. When turntable.onReady fires, the meteor homes into the card's center
        with easeInOutQuad, triggers the .meteor-flash impact burst, then:
          - .featured-hero-thumb → .hidden     (static image fades out)
          - .featured-hero-sprite → .loaded    (sprite frames fade in)
     6. After an 8s safety timeout, the upgrade aborts cleanly.

   Uses the global window.SpriteTurntable class loaded via /js/sprite-turntable.js. */

const _meteorState = { meteors: new Map(), raf: null };
// Single-track queue: only one orb is in flight at any time, and it's
// always for the centered card. This guarantees the orb lands on center
// (not on whichever side-card happened to fire first earlier).
const _upgradeQueue = createUpgradeQueue(1);

/** Enqueue a card for orb-upgrade. Idempotent. */
export function upgradeCard(item) {
    _upgradeQueue.enqueue(item);
}

/** Abort an in-flight orb upgrade for a card. The underlying asset
 *  load continues in the background (cheap and idempotent); we just
 *  remove the visual orb so it doesn't land on a now-offscreen card. */
export function cancelCard(item) {
    if (!item) return;
    _removeMeteor(item);
    item._upgradeQueued = false;
}

/** Reset a card so it can be upgraded again (e.g. after scrolling offscreen). */
export function resetCard(item) {
    if (!item) return;
    const thumb  = item.querySelector('.featured-hero-thumb');
    if (thumb) thumb.classList.remove('hidden');
    const sprite = item.querySelector('.featured-hero-sprite');
    if (sprite) sprite.classList.remove('loaded');
    const model = item.querySelector('.featured-hero-model');
    if (model) model.classList.remove('loaded');
    item._upgradeQueued = false;
    // Keep _heroLoaded + _heroTurntable + _heroModel so re-upgrading is
    // fast (just replays the orb without re-fetching assets).
}

/** Is this card currently queued or loaded? */
export function isUpgraded(item) {
    return !!(item && (item._upgradeQueued || item._heroLoaded));
}

/* ─────────── internals ─────────── */

function createUpgradeQueue(max) {
    let active = 0;
    const queue = [];
    function run(item) {
        active++;
        _upgradeToModel(item).finally(() => {
            active--;
            if (queue.length > 0) run(queue.shift());
        });
    }
    return {
        enqueue(item) {
            if (!item || item._upgradeQueued) return;
            item._upgradeQueued = true;
            if (active < max) run(item);
            else queue.push(item);
        },
        get active() { return active; },
    };
}

function _upgradeToModel(item) {
    return new Promise((resolve) => {
        const modelUrl  = item.dataset?.modelUrl;
        const spriteUrl = item.dataset?.spriteUrl;
        const frames    = parseInt(item.dataset?.spriteFrames || '36');

        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        // Fast re-trigger: content already loaded — just replay the orb.
        if (item._heroLoaded) {
            _spawnMeteor(item);
            setTimeout(() => {
                const m = _meteorState.meteors.get(item);
                if (m && !m.landed) {
                    m.homeStartX = m.x;
                    m.homeStartY = m.y;
                    m.homing = true;
                    const pump = setInterval(() => {
                        if (m.landed) { clearInterval(pump); done(); }
                    }, 50);
                } else {
                    _revealContent(item);
                    done();
                }
            }, 300);
            return;
        }

        // Spawn meteor IMMEDIATELY — gives the user the orb-in-flight
        // visual cue while we load the heavier 3D model in the background.
        // The thumb stays visible until the model fires its `load` event.
        _spawnMeteor(item);

        // Priority 1: load the real 3D model (highest fidelity).
        if (modelUrl) {
            _loadModel(item, modelUrl)
                .then(() => {
                    item._heroLoaded = true;
                    _startHoming(item, done);
                })
                .catch((err) => {
                    console.warn('[meteor] model load failed, falling back:', err?.message || err);
                    _fallbackSpriteOrLand(item, spriteUrl, frames, done);
                });
            // Safety: if model takes > 12s, give up cleanly (thumb stays).
            setTimeout(() => {
                if (!resolved) { _removeMeteor(item); done(); }
            }, 12000);
            return;
        }

        // No model — try sprite, but if sprite isn't available either we
        // STILL want the orb to land on the static thumb. The meteor /
        // impact effect is a visual cue independent of asset upgrades.
        _fallbackSpriteOrLand(item, spriteUrl, frames, done);

        // Safety
        setTimeout(() => {
            if (!resolved) { _removeMeteor(item); done(); }
        }, 8000);
    });
}

/** Try the sprite-turntable upgrade. If no sprite URL is available
 *  either, just land the orb on the static thumb so the flash + impact
 *  still play. The card never appears to be "stuck" with a roaming
 *  orb that never resolves. */
function _fallbackSpriteOrLand(item, spriteUrl, frames, done) {
    if (spriteUrl && typeof window.SpriteTurntable === 'function') {
        _loadSprite(item, spriteUrl, frames, done);
        return;
    }
    // No animated asset to swap to — land on the current thumb. We
    // mark the card as "loaded" so re-triggers don't refetch anything.
    item._heroLoaded = true;
    _startHoming(item, done);
}

/** Lazily mounts a <model-viewer> in the card's .featured-hero-model
 *  slot, returns a promise that resolves on the model-viewer `load`
 *  event. Already-mounted instances are reused (fast re-upgrade). */
function _loadModel(item, url) {
    return new Promise((resolve, reject) => {
        const slot = item.querySelector('.featured-hero-model');
        if (!slot) return reject(new Error('no model slot'));
        if (slot._mv) return resolve(slot._mv);  // reuse
        if (typeof customElements === 'undefined') return reject(new Error('no custom-element support'));

        const mv = document.createElement('model-viewer');
        mv.setAttribute('src', url);
        mv.setAttribute('alt', item.getAttribute('aria-label') || 'DexHero');
        mv.setAttribute('camera-controls', '');
        mv.setAttribute('exposure', '0.95');
        mv.setAttribute('shadow-intensity', '0.2');
        mv.setAttribute('interaction-prompt', 'none');
        mv.setAttribute('disable-tap', '');
        mv.setAttribute('camera-orbit', '0deg 90deg 150%');
        // Tripo's rigged GLBs include a walk-in-place clip; autoplay it
        // so the carousel feels alive. animation-name falls back to the
        // first available track if the named clip is absent.
        mv.setAttribute('autoplay', '');
        mv.setAttribute('animation-name', 'walk_in_place');
        mv.style.cssText = 'width:100%;height:100%;background:transparent;--poster-color:transparent;';

        // Resolve on 'load' OR 'model-visibility' (with visible=true) —
        // both events are reliable triggers for "GLB is ready to render".
        const onReady = () => {
            slot._mv = mv;
            item._heroModel = mv;
            resolve(mv);
        };
        mv.addEventListener('load', onReady, { once: true });
        mv.addEventListener('error', (e) => reject(e?.detail || e), { once: true });

        slot.appendChild(mv);
    });
}

/** Sprite-turntable fallback. Same flow the panel used before the
 *  3D-model upgrade — preloads N frames, calls _startHoming on ready. */
function _loadSprite(item, spriteUrl, frames, done) {
    if (!spriteUrl) { _removeMeteor(item); done(); return; }
    if (typeof window.SpriteTurntable !== 'function') {
        console.warn('[meteor] SpriteTurntable not available');
        _revealContent(item);
        done();
        return;
    }
    let turntable;
    try {
        turntable = new window.SpriteTurntable(item, spriteUrl, frames);
    } catch (err) {
        console.warn('[meteor] SpriteTurntable construct failed:', err.message);
        done();
        return;
    }
    turntable.onReady(() => {
        item._heroLoaded = true;
        item._heroTurntable = turntable;
        _startHoming(item, done);
    });
}

function _startHoming(item, done) {
    const m = _meteorState.meteors.get(item);
    if (m && !m.landed) {
        m.homeStartX = m.x;
        m.homeStartY = m.y;
        m.homing = true;
        const pump = setInterval(() => {
            if (m.landed) { clearInterval(pump); done(); }
        }, 50);
    } else {
        _revealContent(item);
        done();
    }
}

/** Hide the static thumb and reveal whichever heavy asset finished
 *  loading — 3D model takes priority over sprite turntable. The CSS
 *  fade-in is driven by the `.loaded` class on the carrier element. */
function _revealContent(item) {
    const thumb = item.querySelector('.featured-hero-thumb');
    if (thumb) thumb.classList.add('hidden');
    const model = item.querySelector('.featured-hero-model');
    if (model && model._mv) {
        model.classList.add('loaded');
        return;
    }
    const sprite = item.querySelector('.featured-hero-sprite');
    if (sprite) sprite.classList.add('loaded');
}

function _spawnMeteor(item) {
    if (_meteorState.meteors.has(item)) return;

    const el = document.createElement('div');
    el.className = 'meteor-free';
    el.innerHTML = '<div class="meteor-core"></div><div class="meteor-trail"></div>';
    document.body.appendChild(el);

    const vw = window.innerWidth, vh = window.innerHeight;

    // Enter from a random edge
    const edge = Math.floor(Math.random() * 3); // 0=top, 1=left, 2=right
    let startX, startY;
    if (edge === 0)       { startX = Math.random() * vw;       startY = -30; }
    else if (edge === 1)  { startX = -30;                      startY = Math.random() * vh * 0.7; }
    else                  { startX = vw + 30;                  startY = Math.random() * vh * 0.7; }

    const targetRegionX = vw * (0.3 + Math.random() * 0.4);
    const targetRegionY = vh * (0.4 + Math.random() * 0.3);
    const dx = targetRegionX - startX;
    const dy = targetRegionY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = 3 + Math.random() * 3;

    const state = {
        el,
        x: startX, y: startY,
        vx: (dx / dist) * speed + (Math.random() - 0.5) * 2,
        vy: (dy / dist) * speed + (Math.random() - 0.5) * 2,
        depth: 0.6 + Math.random() * 0.4,
        landed: false,
        homing: false,
        homingProgress: 0,
    };
    _meteorState.meteors.set(item, state);

    // Safety: auto-cleanup after 20s
    setTimeout(() => {
        if (_meteorState.meteors.has(item) && !state.landed) {
            state.el.style.opacity = '0';
            setTimeout(() => { state.el.remove(); _meteorState.meteors.delete(item); }, 400);
        }
    }, 20000);

    _startLoop();
}

function _removeMeteor(item) {
    const state = _meteorState.meteors.get(item);
    if (!state) return;
    state.el.remove();
    _meteorState.meteors.delete(item);
}

function _startLoop() {
    if (_meteorState.raf) return;

    function tick() {
        let anyActive = false;
        _meteorState.meteors.forEach((s, item) => {
            if (s.landed) return;
            anyActive = true;

            if (s.homing) {
                s.homingProgress = Math.min(s.homingProgress + 0.04, 1);
                const t = s.homingProgress;
                const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

                const sprite = item.querySelector('.featured-hero-sprite');
                const target = sprite || item;
                const r = target.getBoundingClientRect();
                const tx = r.left + r.width / 2;
                const ty = r.top + r.height / 2;

                s.x = s.homeStartX + (tx - s.homeStartX) * ease;
                s.y = s.homeStartY + (ty - s.homeStartY) * ease;
                s.depth = s.depth + (1 - s.depth) * ease * 0.5;

                if (s.homingProgress >= 1) {
                    s.landed = true;
                    s.el.classList.add('meteor-landing');
                    const flash = item.querySelector('.meteor-flash');
                    if (flash) {
                        flash.classList.add('impact');
                        flash.addEventListener('animationend', () => flash.classList.remove('impact'), { once: true });
                    }
                    _revealContent(item);
                    setTimeout(() => { s.el.remove(); }, 400);
                }
            } else {
                // Free roaming
                if (Math.random() < 0.04) s.vx += (Math.random() - 0.5) * 1.5;
                if (Math.random() < 0.04) s.vy += (Math.random() - 0.5) * 1.2;
                s.vx *= 0.988;
                s.vy *= 0.988;
                const maxSpeed = 5;
                s.vx = Math.max(-maxSpeed, Math.min(maxSpeed, s.vx));
                s.vy = Math.max(-maxSpeed, Math.min(maxSpeed, s.vy));
                const spd = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
                if (spd < 1.2) {
                    const angle = Math.atan2(s.vy, s.vx);
                    s.vx = Math.cos(angle) * 1.2;
                    s.vy = Math.sin(angle) * 1.2;
                }
                s.x += s.vx;
                s.y += s.vy;

                const w = window.innerWidth, h = window.innerHeight;
                if (s.x < -40) s.x = w + 20;
                if (s.x > w + 40) s.x = -20;
                if (s.y < -40) s.y = h + 20;
                if (s.y > h + 40) s.y = -20;

                s.depth += (Math.random() - 0.5) * 0.015;
                s.depth = Math.max(0.4, Math.min(1, s.depth));
            }

            const scale = 0.5 + s.depth * 0.7;
            const blur  = (1 - s.depth) * 1.5;
            const angle = Math.atan2(s.vy, s.vx) * (180 / Math.PI);
            s.el.style.transform = `translate(${s.x}px, ${s.y}px) scale(${scale})`;
            s.el.style.filter = `blur(${blur}px)`;
            s.el.style.opacity = 0.6 + s.depth * 0.4;
            const trail = s.el.querySelector('.meteor-trail');
            if (trail) trail.style.transform = `rotate(${angle + 180}deg)`;
        });

        if (anyActive) _meteorState.raf = requestAnimationFrame(tick);
        else           _meteorState.raf = null;
    }
    _meteorState.raf = requestAnimationFrame(tick);
}
