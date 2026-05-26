/* dexhero-body-driver.js — browser-side JarJar body driver.
 *
 * THE WHOLE POINT: Tripo's job ends at "give us a rigged GLB." JarJar's
 * job is to PUPPETEER that rig like a real body — no pre-baked
 * animation clips needed. The renderer parses the skeleton, the brain
 * emits intent, and a procedural driver maps intent → bone rotations.
 *
 * This module is the browser-side equivalent of JarJar's desktop renderer
 * (jarjar-renderer/src/body/physics.rs + skinning.rs). It reaches into
 * model-viewer's underlying three.js scene, grabs the SkinnedMesh's
 * skeleton.bones array, caches canonical bones by name, and exposes a
 * gesture library (wave, nod, shake_head, point, shrug, idle_sway,
 * listen_tilt, talk_bob) that animates bone rotations via rAF — no
 * extra clips, no Tripo retarget, no GLB bake change.
 *
 * Bone naming convention assumed (matches Tripo's humanoid_v1 rig +
 * Truffle Man specifically, verified at audit time):
 *
 *   spine:    Sprine01_02 → Sprine02_03 → Sprine02.001_04 → Sprine03_05
 *   neck:     Neck_06
 *   head:     Head_07
 *   shoulder: Shoulder.R_08      Shoulder.L_015
 *   upper arm: Arm1.R_09         Arm1.L_016
 *   lower arm: Arm2.R_010        Arm2.L_017
 *   hand:     Hand.R_024         Hand.L_043
 *   upper leg: Leg1.R_037        Leg1.L_039
 *   lower leg: Leg2.R_038        Leg2.L_040
 *   foot:     Foot.R_057         Foot.L_060
 *
 * Future Tripo bakes change the trailing index suffix (_07, _08, …) so
 * we resolve by stable substring (lowercase) instead of exact name.
 */

const BONE_PATTERNS = {
    head:        /^head(?!_end)/i,
    neck:        /^neck(?!_end)/i,
    spineUpper:  /^sprine03/i,
    spineMid:    /^sprine02(?!\.)/i,
    spineLower:  /^sprine01/i,
    shoulderR:   /^shoulder\.r/i,
    shoulderL:   /^shoulder\.l/i,
    armR1:       /^arm1\.r/i,
    armR2:       /^arm2\.r/i,
    armL1:       /^arm1\.l/i,
    armL2:       /^arm2\.l/i,
    handR:       /^hand\.r/i,
    handL:       /^hand\.l/i,
};

// One running driver per model-viewer element. The lobby only ever
// centers one body at a time so this is effectively a singleton.
let _driver = null;

// Module-level cache of the latest movement-preset overrides so a
// preset picked BEFORE the body finishes binding still applies on bind.
// Updated by setMovementOverrides() and by the dexhero:movement-changed
// listener registered at the bottom of this file.
let _latestOverrides = {};

class BodyDriver {
    constructor(modelViewerEl) {
        this.mv = modelViewerEl;
        /** @type {Record<string, THREE.Bone | null>} */
        this.bones = {};
        /** @type {Record<string, {x:number,y:number,z:number}>} */
        this.restRotations = {};
        /** @type {Map<string, GestureRun>} */
        this.runs = new Map();   // gestureId -> run state
        this.rafId = null;
        this.lastFrameMs = performance.now();
        this.awake = false;
        this.idleSwayActive = false;
        /** Per-gesture movement-preset overrides:
         *    overrides[gestureId] = { amplitudeMul, frequencyMul, durationMul }
         *  Set via setOverrides(); applied as closure wrappers at play() time. */
        this._overrides = {};
        /** Voice-driven boost applied on top of overrides ONLY when talk_bob
         *  is running while the model is actually speaking aloud. Multiplies
         *  amplitude + frequency so the body visibly "comes alive" during
         *  TTS playback (vs the calmer cadence used while idle / thinking).
         *  Updated by setVoiceBoost(); active gesture is re-triggered to
         *  pick up the new boost mid-flight. */
        this._voiceBoost = 1;
        /** Three.js camera used by model-viewer for the live render.
         *  Cached after first discovery; cleared on dispose. Needed to
         *  project the head bone's world position into screen-space
         *  coords for the speech bubble follower. */
        this._camera = null;
        /** Reusable Vector3 instances so the per-frame anchor projection
         *  doesn't allocate. Both are three.js objects we borrow from
         *  the rigged scene the first time we project. */
        this._tmpHeadWorld = null;
        this._tmpProjected = null;
        /** Last published screen-anchor coordinates (viewport pixels).
         *  Consumers (the speaking bubble follower) read these via the
         *  `--dh-head-anchor-x/y` CSS variables on <html> or via the
         *  exported `getHeadAnchor()` helper. */
        this._lastAnchor = { x: 0, y: 0, valid: false };
    }

    /** Bump or restore the voice-driven boost applied to talk_bob. Called
     *  from the document-level voice listeners below: 1.7× during a
     *  spoken reply, 1.0× the rest of the time. Forces a re-trigger of
     *  any in-flight talk_bob so the change is visible immediately. */
    setVoiceBoost(scalar) {
        const next = Math.max(0.5, Math.min(3, Number(scalar) || 1));
        if (Math.abs(next - this._voiceBoost) < 0.01) return;
        this._voiceBoost = next;
        if (this.runs.has('talk_bob')) {
            this.runs.delete('talk_bob');
            this.play('talk_bob');
        }
    }

    /** Replace the movement-preset overrides. Future play() calls apply
     *  the new multipliers; existing runs keep their captured factor.
     *  Calling with a falsy arg resets to no overrides. */
    setOverrides(overrides) {
        this._overrides = (overrides && typeof overrides === 'object') ? overrides : {};
        // Restart any currently-looping gesture so the new multiplier
        // takes effect immediately (one-shots are short enough to wait).
        for (const [id, run] of this.runs) {
            if (run.loop) {
                this.runs.delete(id);
                this.play(id);
            }
        }
    }

    /** Resolve the model-viewer's internal three.js scene + walk it to
     *  cache bone references. Returns true when bones were found. */
    bind() {
        const scene = readModelViewerScene(this.mv);
        if (!scene) return false;
        const allBones = [];
        scene.traverse((node) => {
            if (node && (node.isBone || node.type === 'Bone')) allBones.push(node);
        });
        if (!allBones.length) return false;
        for (const [key, pattern] of Object.entries(BONE_PATTERNS)) {
            const match = allBones.find((b) => pattern.test(b.name || ''));
            this.bones[key] = match || null;
            if (match) {
                // Snapshot the rest rotation so every gesture eases back
                // to T-pose between runs (no permanent pose drift).
                this.restRotations[key] = {
                    x: match.rotation.x,
                    y: match.rotation.y,
                    z: match.rotation.z,
                };
            }
        }
        const found = Object.values(this.bones).filter(Boolean).length;
        if (found === 0) return false;
        // Start the per-frame stepper — gesture rAF lives off this one
        // loop so we don't fight model-viewer's own render scheduler.
        if (!this.rafId) {
            const tick = () => {
                this.rafId = requestAnimationFrame(tick);
                this._step();
            };
            this.rafId = requestAnimationFrame(tick);
        }
        return true;
    }

    /** Stop animating + dispose. Called on body swap. */
    dispose() {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        this.runs.clear();
        this.bones = {};
        // Reset the sub-pixel sway delta — between swaps the next body
        // re-publishes its own value within a frame or two. The anchor
        // (--dh-head-anchor-x/y) is INTENTIONALLY NOT cleared here:
        // model-viewer churns through several rebinds during boot, and
        // clearing the anchor between rebinds would leave the speaking
        // surface at its (50vw, 28vh) fallback for the gap, which is
        // visibly wrong. The next successful bind overwrites both vars
        // within milliseconds.
        try {
            document.documentElement.style.setProperty('--dh-head-sway-x', '0px');
            document.documentElement.style.setProperty('--dh-head-sway-y', '0px');
        } catch {}
        this.restRotations = {};
        this._camera = null;
        this._tmpHeadWorld = null;
        this._tmpProjected = null;
        this._lastAnchor = { x: 0, y: 0, valid: false };
    }

    setAwake(yes) {
        this.awake = !!yes;
        if (!this.awake) {
            // Cancel any active gesture and ease back to rest.
            for (const id of [...this.runs.keys()]) {
                if (id !== 'idle_sway') this.runs.delete(id);
            }
            this.idleSwayActive = false;
            this.runs.delete('idle_sway');
        } else {
            this._startIdleSway();
        }
    }

    /** Per-frame stepper. Walks every active gesture, applies the
     *  current frame's bone rotations, and removes done gestures.
     *  Gesture rotations are ADDITIVE relative to rest — multiple
     *  gestures targeting the same bone compose naturally. */
    _step() {
        const nowMs = performance.now();
        const dt = (nowMs - this.lastFrameMs) / 1000;
        this.lastFrameMs = nowMs;

        // Reset every cached bone to its rest rotation, then accumulate
        // deltas from every active gesture. Reset-then-accumulate avoids
        // drift when multiple gestures touch the same bone.
        for (const [key, rest] of Object.entries(this.restRotations)) {
            const bone = this.bones[key];
            if (!bone) continue;
            bone.rotation.x = rest.x;
            bone.rotation.y = rest.y;
            bone.rotation.z = rest.z;
        }

        for (const [id, run] of this.runs) {
            run.elapsedSec += dt;
            const t = run.duration > 0 ? Math.min(1, run.elapsedSec / run.duration) : 1;
            run.update(this.bones, t, run.elapsedSec);
            if (t >= 1 && !run.loop) this.runs.delete(id);
        }

        // Publish the head's per-frame rotational offset (delta from
        // rest) as CSS variables on <html>. The chat bubble's
        // `transform: translate(...)` in shell.css consumes these so
        // the bubble visibly tracks the head's idle sway / talk bob /
        // nod / shake without us projecting world→screen coords.
        //
        // X-rotation (pitch) → vertical pixel offset, Y-rotation (yaw)
        // → horizontal pixel offset. Multipliers picked so idle_sway
        // is barely perceptible and a nod feels meaningfully synced.
        const head = this.bones.head;
        const rest = this.restRotations.head;
        if (head && rest && typeof document !== 'undefined') {
            const swayX = ((head.rotation.y || 0) - (rest.y || 0)) * 120;
            const swayY = ((head.rotation.x || 0) - (rest.x || 0)) * 70;
            try {
                const root = document.documentElement;
                root.style.setProperty('--dh-head-sway-x', `${swayX.toFixed(2)}px`);
                root.style.setProperty('--dh-head-sway-y', `${swayY.toFixed(2)}px`);
            } catch {}
        }

        // Project the head bone's WORLD position into viewport pixel
        // coordinates so any DOM element (the speaking bubble, future
        // VFX, callouts) can anchor directly to where Truffle's head
        // is rendered — regardless of camera orbit, viewport size,
        // model swap, or layout reflows. Writes `--dh-head-anchor-x/y`
        // (absolute viewport pixels) on <html> every frame.
        this._publishHeadAnchor(head);
    }

    /** Lazily discover the three.js camera that model-viewer renders
     *  with. We can't import three.js directly — model-viewer bundles
     *  its own copy — so we traverse the runtime scene graph and grab
     *  the first object whose `.isCamera` flag is true. */
    _findCamera() {
        if (this._camera && this._camera.matrixWorldInverse) return this._camera;
        const scene = readModelViewerScene(this.mv);
        if (!scene || typeof scene.traverse !== 'function') return null;
        let found = null;
        scene.traverse((n) => { if (!found && n.isCamera) found = n; });
        if (!found) {
            // Fallback: some model-viewer builds expose the camera off
            // the mv element itself via a symbol property.
            const syms = Object.getOwnPropertySymbols(this.mv);
            for (const s of syms) {
                const desc = (s.description || '').toLowerCase();
                if (desc.includes('camera')) {
                    const v = this.mv[s];
                    if (v?.isCamera) { found = v; break; }
                    if (v?.camera?.isCamera) { found = v.camera; break; }
                }
            }
        }
        if (found) this._camera = found;
        return found;
    }

    /** Project the head bone's world position into viewport pixel
     *  coordinates and publish the result as `--dh-head-anchor-x/y`
     *  on <html> so the speaking-bubble surface can `left/top` to
     *  the live anchor. Y uses the model rect's TOP + 18% rather
     *  than the bone's vertical projection — on a rigged humanoid
     *  the head bone sits at the neck joint which projects to the
     *  middle of the visible model. The bubble's own CSS transform
     *  then lifts above this anchor. */
    _publishHeadAnchor(head) {
        if (!head || typeof document === 'undefined') return;
        const cam = this._findCamera();
        if (!cam) return;
        // Borrow three.js Vector3 via the bone's own position (same
        // class). One-time allocation, then reused every frame.
        if (!this._tmpHeadWorld) {
            this._tmpHeadWorld = head.position.clone();
            this._tmpProjected = head.position.clone();
        }
        const world = this._tmpHeadWorld;
        const proj  = this._tmpProjected;
        world.set(0, 0, 0);
        head.localToWorld(world);
        proj.copy(world);
        try { proj.project(cam); } catch { return; }
        if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) return;
        // Model-viewer's orthographic projection yields NDC z values
        // outside [-1,1] for points that are visibly on-screen, so we
        // only filter on x being off-screen, not z.
        if (proj.x < -1.2 || proj.x > 1.2) return;
        const rect = this.mv.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = rect.left + ((proj.x + 1) / 2) * rect.width;
        const y = rect.top + rect.height * 0.18;
        if (Math.abs(x - this._lastAnchor.x) < 0.5 &&
            Math.abs(y - this._lastAnchor.y) < 0.5 &&
            this._lastAnchor.valid) return;
        this._lastAnchor = { x, y, valid: true };
        try {
            const root = document.documentElement;
            root.style.setProperty('--dh-head-anchor-x', `${x.toFixed(1)}px`);
            root.style.setProperty('--dh-head-anchor-y', `${y.toFixed(1)}px`);
        } catch {}
    }

    /** Public: play a named gesture. Replaces any prior run of the same
     *  gesture id. Movement-preset overrides (see setOverrides) are
     *  applied as closure wrappers on the gesture's update function so
     *  amplitude / frequency / duration multipliers shape every gesture
     *  via the same uniform mechanism — no per-factory edits needed. */
    play(gestureId, opts = {}) {
        const factory = GESTURES[gestureId];
        if (!factory) return false;
        const run = factory(opts);
        const ov = this._overrides[gestureId];
        // Compose voice boost ONLY for talk_bob — that's the gesture that
        // visibly tracks speech. Other gestures pass through unchanged.
        const voiceMul = gestureId === 'talk_bob' ? (this._voiceBoost || 1) : 1;
        const hasOv = !!ov;
        const baseAmp = Number(ov?.amplitudeMul ?? 1);
        const baseFreq = Number(ov?.frequencyMul ?? 1);
        const composedAmp = baseAmp * voiceMul;
        const composedFreq = baseFreq * (gestureId === 'talk_bob' ? Math.min(1.35, 0.85 + voiceMul * 0.25) : 1);
        if (hasOv || voiceMul !== 1) {
            const amp  = composedAmp;
            const freq = composedFreq;
            const dur  = Number(ov?.durationMul ?? 1);
            // Duration scaling — one-shots only (loops use sec for periodicity).
            if (run.duration > 0 && dur !== 1) run.duration *= dur;
            // Wrap update if amplitude or frequency scaling is non-trivial.
            // Amplitude: snapshot bones before update → restore as scaled
            // delta from snapshot. Frequency: scale the `sec` arg.
            if (amp !== 1 || freq !== 1) {
                const origUpdate = run.update;
                run.update = function wrapped(bones, t, sec) {
                    if (amp === 1) {
                        origUpdate(bones, t, sec * freq);
                        return;
                    }
                    const snap = {};
                    for (const k in bones) {
                        const b = bones[k];
                        if (b) snap[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
                    }
                    origUpdate(bones, t, sec * freq);
                    for (const k in snap) {
                        const b = bones[k];
                        if (!b) continue;
                        b.rotation.x = snap[k].x + (b.rotation.x - snap[k].x) * amp;
                        b.rotation.y = snap[k].y + (b.rotation.y - snap[k].y) * amp;
                        b.rotation.z = snap[k].z + (b.rotation.z - snap[k].z) * amp;
                    }
                };
            }
        }
        this.runs.set(gestureId, run);
        return true;
    }

    _startIdleSway() {
        if (this.idleSwayActive) return;
        this.idleSwayActive = true;
        this.play('idle_sway');
    }
}

// ── Gesture library ──────────────────────────────────────────────
// Each entry returns a `run` object: { duration, elapsedSec, loop,
// update(bones, t, elapsedSec) }. `t` is normalized [0,1] for one-shot
// gestures; `elapsedSec` keeps growing for loop gestures so they can
// drive periodic motion.
const TAU = Math.PI * 2;
const easeInOut = (t) => t * t * (3 - 2 * t);

const GESTURES = {
    /** Continuous breath-style spine sway. Always running while awake.
     *  Keeps the body from looking frozen during idle. */
    idle_sway() {
        return {
            duration: 0, elapsedSec: 0, loop: true,
            update(bones, _t, sec) {
                const slow = Math.sin(sec * 0.6);   // 0.6 rad/s ≈ 6s period
                const fast = Math.sin(sec * 1.8);   // micro-bob
                if (bones.spineUpper) bones.spineUpper.rotation.x += slow * 0.012;
                if (bones.spineMid)   bones.spineMid.rotation.x   += slow * 0.008;
                if (bones.head)       bones.head.rotation.x       += fast * 0.005;
                if (bones.head)       bones.head.rotation.y       += slow * 0.015;
            },
        };
    },
    /** Listening tilt — gentle head + body lean toward the user.
     *  Fires when the user starts typing. */
    listen_tilt() {
        return {
            duration: 1.2, elapsedSec: 0, loop: false,
            update(bones, t) {
                const k = easeInOut(t);
                if (bones.head)       bones.head.rotation.z       += k * 0.18;
                if (bones.neck)       bones.neck.rotation.z       += k * 0.08;
                if (bones.spineUpper) bones.spineUpper.rotation.x += k * 0.05;
            },
        };
    },
    /** Talking bob — gentle continuous motion while the assistant
     *  streams a reply. Looped for the duration of "thinking". */
    talk_bob() {
        return {
            duration: 0, elapsedSec: 0, loop: true,
            update(bones, _t, sec) {
                const f = Math.sin(sec * 4.5);   // word-rate frequency
                if (bones.head)       bones.head.rotation.x       += f * 0.04;
                if (bones.neck)       bones.neck.rotation.x       += f * 0.025;
                if (bones.spineUpper) bones.spineUpper.rotation.x += Math.sin(sec * 2.2) * 0.018;
            },
        };
    },
    /** Yes-nod. Two quick pitch oscillations. */
    nod() {
        return {
            duration: 0.9, elapsedSec: 0, loop: false,
            update(bones, t) {
                const wave = Math.sin(t * TAU * 2) * (1 - t);   // damped 2-cycle
                if (bones.head)       bones.head.rotation.x       += wave * 0.35;
                if (bones.neck)       bones.neck.rotation.x       += wave * 0.18;
            },
        };
    },
    /** No-shake. Two yaw oscillations. */
    shake_head() {
        return {
            duration: 1.2, elapsedSec: 0, loop: false,
            update(bones, t) {
                const wave = Math.sin(t * TAU * 2) * (1 - t);
                if (bones.head)       bones.head.rotation.y       += wave * 0.4;
                if (bones.neck)       bones.neck.rotation.y       += wave * 0.18;
            },
        };
    },
    /** Wave (right hand). Arm comes up, hand oscillates side-to-side. */
    wave() {
        return {
            duration: 1.8, elapsedSec: 0, loop: false,
            update(bones, t) {
                const lift = easeInOut(Math.min(1, t * 2));        // 0→1 over first half
                const drop = easeInOut(Math.min(1, Math.max(0, (t - 0.7) / 0.3))); // 0→1 last 30%
                const armUp = lift * (1 - drop);
                if (bones.shoulderR) bones.shoulderR.rotation.z -= armUp * 0.45;
                if (bones.armR1)     bones.armR1.rotation.z     -= armUp * 1.6;
                if (bones.armR2)     bones.armR2.rotation.x     += armUp * 0.5;
                const handWave = Math.sin(t * TAU * 4) * armUp;
                if (bones.handR)     bones.handR.rotation.z     += handWave * 0.5;
            },
        };
    },
    /** Point (right hand). Arm extends forward + slightly raised. */
    point() {
        return {
            duration: 1.6, elapsedSec: 0, loop: false,
            update(bones, t) {
                const k = easeInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
                if (bones.shoulderR) bones.shoulderR.rotation.x -= k * 0.4;
                if (bones.armR1)     bones.armR1.rotation.x     -= k * 0.9;
                if (bones.armR2)     bones.armR2.rotation.x     += k * 0.3;
                if (bones.handR)     bones.handR.rotation.x     += k * 0.2;
            },
        };
    },
    /** Shrug. Both shoulders up briefly. */
    shrug() {
        return {
            duration: 1.0, elapsedSec: 0, loop: false,
            update(bones, t) {
                const k = easeInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
                if (bones.shoulderR) bones.shoulderR.rotation.z -= k * 0.35;
                if (bones.shoulderL) bones.shoulderL.rotation.z += k * 0.35;
                if (bones.head)      bones.head.rotation.x      -= k * 0.08;
            },
        };
    },
};

// ── model-viewer scene access ────────────────────────────────────
// model-viewer keeps the three.js scene behind a Symbol-keyed property.
// The symbol's description literally contains the word "scene"; we
// resolve it dynamically so this keeps working across model-viewer
// version bumps that rename the symbol's order.
function readModelViewerScene(mv) {
    if (!mv) return null;
    // Public: `model` exposes the parsed gltf in v3.x+.
    const m = mv.model;
    if (m?.gltf?.scene) return m.gltf.scene;
    // Internal symbol fallback. The element holds the runtime scene
    // under a symbol whose description is `scene` or `[[scene]]`.
    const syms = Object.getOwnPropertySymbols(mv);
    for (const s of syms) {
        const desc = (s.description || '').toLowerCase();
        if (desc === 'scene' || desc.includes('scene')) {
            const val = mv[s];
            if (val && typeof val.traverse === 'function') return val;
            // Sometimes the scene is one level deeper.
            if (val?.scene && typeof val.scene.traverse === 'function') return val.scene;
        }
    }
    return null;
}

// ── Public API ───────────────────────────────────────────────────

/** Bind to a freshly-loaded model-viewer element. Returns the driver
 *  or null if bone discovery failed. Calls dispose on any prior driver
 *  so swaps don't leak rAF loops. */
export function bindBody(modelViewerEl) {
    if (_driver) { _driver.dispose(); _driver = null; }
    if (!modelViewerEl) return null;
    const driver = new BodyDriver(modelViewerEl);
    // Inherit any movement-preset overrides set before this body bound.
    if (_latestOverrides) driver.setOverrides(_latestOverrides);
    // model-viewer fires 'load' after the GLB decodes; sometimes our
    // dexhero:body-ready event lands first. Retry briefly until the
    // scene is reachable.
    let attempts = 0;
    const tryBind = () => {
        if (driver.bind()) {
            _driver = driver;
            return;
        }
        if (++attempts < 20) {
            setTimeout(tryBind, 150);
        }
    };
    tryBind();
    return driver;
}

/** Public: play a named gesture if the driver is bound. No-op otherwise. */
export function play(gestureId, opts) {
    return _driver ? _driver.play(gestureId, opts) : false;
}

/** Public: toggle awake state. Awake = idle sway runs continuously and
 *  reactive gestures fire on chat events. Asleep = pure GLB Idle clip. */
export function setAwake(yes) {
    if (_driver) _driver.setAwake(yes);
}

export function isBound() { return !!_driver; }

/** Public: read the last-published screen-space anchor of the head bone
 *  (viewport pixel coordinates). Returns `null` if the driver isn't
 *  bound or the camera hasn't been discovered yet. Updated every
 *  rAF frame as part of the gesture stepper; consumers (the speaking
 *  bubble follower) should also subscribe to the `--dh-head-anchor-x/y`
 *  CSS variables for change events. */
export function getHeadAnchor() {
    if (!_driver) return null;
    const a = _driver._lastAnchor;
    return a?.valid ? { x: a.x, y: a.y } : null;
}

/** Public: replace the movement-preset overrides on the active driver.
 *  Cached so the next body bind picks them up too. */
export function setMovementOverrides(overrides) {
    _latestOverrides = (overrides && typeof overrides === 'object') ? overrides : {};
    if (_driver) _driver.setOverrides(_latestOverrides);
}

/* ── Outfit overlay attachment (Phase 7.5) ────────────────────────
 *
 * Body-category modules with a `spec.asset_url` load the GLB via a
 * hidden <model-viewer> (so we reuse model-viewer's GLB parser instead
 * of pulling three.js in standalone). Once loaded, we steal the
 * resulting `model.gltf.scene` (three.js Object3D) and parent it to
 * the host body's cached bone — the host's renderer picks it up on
 * the next frame because Object3D.add() reparents within the same
 * three.js scene graph the host model-viewer is already walking.
 *
 * One overlay per (slot, bone) — re-attaching detaches the prior. */

const BONE_KEY_ALIASES = {
    head: ['head'],
    neck: ['neck'],
    spine: ['spineUpper', 'spineMid', 'spineLower'],
    armR:  ['armR1'],
    armL:  ['armL1'],
    handR: ['handR'],
    handL: ['handL'],
};

/** Resolve a creator-supplied bone name to a body driver bone key.
 *  Accepts loose strings ('Head', 'head', 'head_bone') and maps to
 *  the BONE_PATTERNS keys this driver caches. Returns null if no
 *  match — caller falls back to the head bone. */
function resolveBoneKey(boneName) {
    if (!boneName) return null;
    const n = String(boneName).toLowerCase();
    if (n.startsWith('head'))  return 'head';
    if (n.startsWith('neck'))  return 'neck';
    if (n.startsWith('spine')) return 'spineUpper';
    if (n === 'handr' || n === 'hand.r') return 'handR';
    if (n === 'handl' || n === 'hand.l') return 'handL';
    return null;
}

/** Public: attach an overlay scene (a three.js Object3D) to one of
 *  the driver's cached bones. Returns an opaque handle the caller
 *  passes back to detachOverlay() to remove it.
 *
 *  opts:
 *    boneName    — creator-supplied attach_bone (BodySpec.attach_bones[0])
 *    position    — { x, y, z } local offset relative to the bone
 *    scale       — uniform scale or { x, y, z }
 *    rotationDeg — { x, y, z } in degrees
 *
 *  Returns null if the bone isn't bound yet (the driver may still be
 *  resolving bones after a body swap). Callers should retry on the
 *  next animation frame if they need attachment guaranteed. */
export function attachOverlay(overlayScene, opts = {}) {
    if (!_driver || !overlayScene) return null;
    const boneKey = resolveBoneKey(opts.boneName) || 'head';
    const bone = _driver.bones?.[boneKey];
    if (!bone || typeof bone.add !== 'function') return null;

    // Reparent — three.js Object3D.add() removes the scene from its
    // prior parent automatically. This is how we 'steal' the scene
    // from the hidden model-viewer's render tree without three.js.
    bone.add(overlayScene);

    // Apply transform overrides — sensible defaults for an emoji-
    // proxy hat: lift it up a bit, scale down. Creators can override
    // via spec.transform.
    const pos = opts.position || { x: 0, y: 1.4, z: 0 };
    overlayScene.position.set(
        Number(pos.x) || 0,
        Number(pos.y) || 0,
        Number(pos.z) || 0,
    );
    const scale = opts.scale;
    if (typeof scale === 'number') {
        overlayScene.scale.set(scale, scale, scale);
    } else if (scale && typeof scale === 'object') {
        overlayScene.scale.set(
            Number(scale.x) || 1,
            Number(scale.y) || 1,
            Number(scale.z) || 1,
        );
    } else {
        // Default: shrink to 0.4x — most hat / accessory GLBs ship at
        // ~1m scale, but our character heads are ~0.3m local.
        overlayScene.scale.set(0.4, 0.4, 0.4);
    }
    const rot = opts.rotationDeg;
    if (rot && typeof rot === 'object') {
        const d2r = Math.PI / 180;
        overlayScene.rotation.set(
            (Number(rot.x) || 0) * d2r,
            (Number(rot.y) || 0) * d2r,
            (Number(rot.z) || 0) * d2r,
        );
    }

    return { scene: overlayScene, boneKey };
}

/** Public: remove an attached overlay scene. Accepts the handle
 *  returned by attachOverlay() (or any Object3D, in which case it's
 *  removed from its parent if it has one). Safe to call on a stale
 *  handle after a body swap — three.js .removeFromParent() no-ops
 *  on detached nodes. */
export function detachOverlay(handle) {
    if (!handle) return;
    const scene = handle.scene || handle;
    if (scene && typeof scene.removeFromParent === 'function') {
        scene.removeFromParent();
    } else if (scene?.parent) {
        scene.parent.remove(scene);
    }
}

// Document-level wires:
//   • dexhero:movement-changed   — movement-picker equips a new preset.
//   • dexhero:voice-start        — TTS playback began. Amplify talk_bob so
//                                  the body visibly comes alive.
//   • dexhero:voice-end          — TTS finished/cancelled. Calm talk_bob back
//                                  down to the resting (non-speaking) cadence.
// Keeping these listeners here (next to the driver) keeps the wiring
// colocated with the gesture library and survives module-load order
// across the app.
if (typeof document !== 'undefined') {
    document.addEventListener('dexhero:movement-changed', (ev) => {
        const params = ev?.detail?.params;
        setMovementOverrides(params || {});
    });
    document.addEventListener('dexhero:voice-start', () => {
        if (_driver) {
            _driver.setVoiceBoost(1.7);
            // Force talk_bob on — the chat-thinking handler may have
            // already turned it off by the time TTS gets its turn.
            _driver.play('talk_bob');
        }
    });
    document.addEventListener('dexhero:voice-end', () => {
        if (_driver) _driver.setVoiceBoost(1.0);
    });
}
