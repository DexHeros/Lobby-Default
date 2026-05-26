/* dexhero-body.js — high-level body intent → motion bridge.
 *
 * This module is the "policy" layer: it listens to chat events (the
 * brain's intent surface) and turns them into gesture invocations on
 * the JarJar body driver (`./dexhero-body-driver.js`), which actually
 * rotates Truffle's 90 named bones.
 *
 * No pre-baked animation clips are involved. The whole point of
 * the JarJar approach is: Tripo gives us a rigged GLB, JarJar uses
 * the rig like a puppeteer. Wave / nod / shake / point / shrug are
 * all driven by bone rotations in `dexhero-body-driver.js`, not by
 * separate Tripo-baked clips.
 *
 * Two states:
 *   blank (default) — model-viewer plays the GLB's baked Idle clip
 *                     and the body is otherwise still. Pre-LLM state.
 *   awake          — JarJar driver active: idle_sway runs continuously,
 *                     chat events fire reactive gestures. Set by
 *                     `body-action: wake_up` once the first LLM reply
 *                     lands.
 *
 * The model-viewer's baked Idle clip keeps playing in BOTH states —
 * that's the "always breathing" baseline. The driver's gestures ADD
 * on top via bone-rotation deltas.
 */

import * as driver from './dexhero-body-driver.js';

let _modelViewer = null;
let _availableAnimations = new Set();
let _currentLoop = 'idle';
let _awake = false;
let _userMessageGestureCounter = 0;

function setAnimationName(name) {
    if (!_modelViewer || !_availableAnimations.has(name)) return false;
    _modelViewer.setAttribute('animation-name', name);
    return true;
}

/** Pick a varied gesture per assistant reply so Truffle doesn't look
 *  mechanical. The first reply after waking up always waves (greeting
 *  feels natural). Subsequent replies cycle nod / point / shrug /
 *  shake_head plus the always-on talk_bob underneath. */
function gestureForAssistantReply() {
    if (_userMessageGestureCounter === 0) return 'wave';
    const pool = ['nod', 'nod', 'point', 'shrug', 'shake_head'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── External API (kept for back-compat with older callers) ──

export function playAnimation(clip /*, opts */) {
    // Legacy callers asked for an animation clip name. With the JarJar
    // puppeteer approach we map known clip names to driver gestures
    // instead of expecting Tripo to have baked them.
    const map = {
        wave:        'wave',
        nod:         'nod',
        shake_head:  'shake_head',
        point:       'point',
        cheer:       'wave',     // cheer ≈ raised hand, reuse wave
        think_pose:  'listen_tilt',
        look_around: 'listen_tilt',
        talk_loop:   'talk_bob',
    };
    const target = map[clip];
    if (target) driver.play(target);
}

export function setIdle(loop) {
    _currentLoop = loop || 'idle';
    setAnimationName(_currentLoop);
}

export function talkStart() { driver.play('talk_bob'); }
export function talkStop()  { /* talk_bob is a loop; idle_sway resumes */ }
export function lookAt(deg) {
    if (_modelViewer) _modelViewer.cameraOrbit = `${deg}deg 75deg auto`;
}

export function setAwake(yes) {
    _awake = !!yes;
    if (_modelViewer) _modelViewer.dataset.awake = _awake ? 'true' : 'false';
    driver.setAwake(_awake);
    if (!_awake) _userMessageGestureCounter = 0;
}

// ── Wire-up ─────────────────────────────────────────────────────

function attachToBody(detail) {
    _modelViewer = detail.element || null;
    _availableAnimations = new Set(detail.availableAnimations || []);
    _userMessageGestureCounter = 0;
    if (_modelViewer) {
        _modelViewer.setAttribute('animation-crossfade-duration', '0.25');
        _modelViewer.dataset.awake = _awake ? 'true' : 'false';
    }
    // The GLB's baked clip is the breathing baseline. Truffle has
    // exactly one — 'Idle'. Plays continuously underneath the
    // driver's bone-rotation gestures.
    _currentLoop = _availableAnimations.has('idle')
        ? 'idle'
        : _availableAnimations.has('Idle') ? 'Idle' : null;
    if (_currentLoop) setAnimationName(_currentLoop);

    // Bind the bone driver. Bones may not be reachable until model-
    // viewer's internal scene mounts, so the driver retries internally.
    driver.bindBody(_modelViewer);
    if (_awake) driver.setAwake(true);
}

if (typeof document !== 'undefined') {
    document.addEventListener('dexhero:body-ready', (ev) => attachToBody(ev.detail || {}));
    document.addEventListener('dexhero:body-action', (ev) => {
        const { action, ...args } = ev.detail || {};
        switch (action) {
            case 'play_animation': playAnimation(args.clip, args); break;
            case 'set_idle':       setIdle(args.loop); break;
            case 'talk_start':     talkStart(); break;
            case 'talk_stop':      talkStop();  break;
            case 'look_at':        lookAt(args.deg); break;
            case 'wake_up':        setAwake(true);  break;
            case 'sleep':          setAwake(false); break;
            case 'gesture':        if (args.name) driver.play(args.name); break;
        }
    });

    // Reactive gestures driven by chat events. Only fire while awake.
    document.addEventListener('dexhero:chat-message', (ev) => {
        if (!_awake) return;
        const role = ev.detail?.role;
        if (role === 'user') {
            driver.play('listen_tilt');
            _userMessageGestureCounter++;
        } else if (role === 'assistant') {
            const gesture = gestureForAssistantReply();
            driver.play(gesture);
            // Talk bob runs over the gesture for a couple of seconds so
            // the body keeps moving while the reply is read.
            driver.play('talk_bob');
        }
    });
    document.addEventListener('dexhero:chat-thinking', (ev) => {
        if (!_awake) return;
        if (ev.detail?.thinking) driver.play('listen_tilt');
    });
}
