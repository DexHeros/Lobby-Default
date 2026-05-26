/* dexhero-outfit.js — body outfit overlay renderer.
 *
 * Phase 7 + 7.5 of the Agent Store roadmap. Listens for
 * `dexhero:outfit-equip` events fired by the body slot picker and
 * paints (or removes) the right overlay surface for the equipped
 * module.
 *
 * Two render paths chosen at equip time by the module's spec:
 *
 *   spec.asset_url is set  → Phase 7.5 path. Load the GLB via a
 *     hidden <model-viewer> (reuses model-viewer's GLB parser so we
 *     don't pull three.js in standalone). Once `model.gltf.scene` is
 *     ready, hand it off to the body driver's `attachOverlay` which
 *     reparents it to the cached `attach_bones[0]` bone. The host
 *     model-viewer's renderer picks up the new child on the next
 *     frame because Object3D.add() reparents within the existing
 *     three.js scene graph.
 *
 *   spec.glyph is set      → Phase 7 fallback. Paint the glyph as a
 *     DOM element positioned absolutely over the centered hero and
 *     tracking the body driver's --dh-head-sway-* CSS vars.
 *
 *   Neither set            → no-op (silent).
 *
 * Equip-on-equip cleanly tears the prior overlay down so swaps don't
 * stack. A body swap (different DexHero) clears the overlay too —
 * the bone reference is invalidated when the body driver rebinds.
 */

import { attachOverlay, detachOverlay } from './dexhero-body-driver.js';

const OVERLAY_CLASS = 'lobby-stage__outfit-overlay';
const HIDDEN_HOST_ID = 'lobby-outfit-loader-host';
let _wired = false;
let _currentModule = null;
let _attachHandle = null;       // body-driver attach handle
let _loaderMv = null;           // hidden model-viewer used for GLB load
let _attachRetryCount = 0;      // body driver may bind a few frames late

function findHostEl() {
    return document.getElementById('lobby-stage-subject') || null;
}

function findHiddenHost() {
    let host = document.getElementById(HIDDEN_HOST_ID);
    if (!host) {
        host = document.createElement('div');
        host.id = HIDDEN_HOST_ID;
        // Off-screen but rendered — model-viewer needs to be in the
        // DOM tree to load. Zero size + visibility:hidden keeps it
        // out of the user's way without breaking its load lifecycle.
        host.style.cssText =
            'position:fixed;left:-9999px;top:-9999px;width:0;height:0;' +
            'opacity:0;pointer-events:none;visibility:hidden;';
        document.body.appendChild(host);
    }
    return host;
}

function clearGlyphOverlay() {
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
}

function paintGlyphOverlay(module) {
    const host = findHostEl();
    if (!host) return;
    clearGlyphOverlay();
    const spec = module?.spec || {};
    const glyph = spec.glyph || '✨';
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.dataset.moduleId = module.id;
    overlay.textContent = glyph;
    host.appendChild(overlay);
}

function teardownLoader() {
    if (_loaderMv && _loaderMv.parentNode) {
        try { _loaderMv.remove(); } catch {}
    }
    _loaderMv = null;
}

function teardownAttach() {
    if (_attachHandle) {
        try { detachOverlay(_attachHandle); } catch {}
        _attachHandle = null;
    }
    teardownLoader();
}

function teardownAll() {
    clearGlyphOverlay();
    teardownAttach();
}

/** Try to reparent the loader's scene to the host body's bone. The
 *  body driver may still be binding bones (it retries up to ~20×
 *  150ms after a body swap), so we re-attempt for a couple of seconds
 *  before giving up. */
function tryAttachLoaderScene(module) {
    if (!_loaderMv) return;
    const scene = _loaderMv?.model?.gltf?.scene;
    if (!scene) {
        // model-viewer hasn't finished loading yet — wait for 'load'.
        return;
    }
    const spec = module?.spec || {};
    const boneName = Array.isArray(spec.attach_bones) ? spec.attach_bones[0] : null;
    const handle = attachOverlay(scene, {
        boneName,
        position: spec.position,
        scale: spec.scale,
        rotationDeg: spec.rotationDeg,
    });
    if (handle) {
        _attachHandle = handle;
        _attachRetryCount = 0;
        // Loader iframe no longer needed — scene has been stolen.
        teardownLoader();
        return;
    }
    // Body driver not bound yet → retry on the next animation frame
    // up to ~30 attempts (≈2s). Bigger numbers wouldn't help; if we
    // haven't bound by then, the user has likely already picked a
    // different outfit.
    if (++_attachRetryCount < 30) {
        requestAnimationFrame(() => tryAttachLoaderScene(module));
    } else {
        console.warn('[dexhero-outfit] could not attach overlay — bone not bound');
    }
}

function mountAssetOverlay(module) {
    const hidden = findHiddenHost();
    teardownAttach();   // clear any prior asset overlay
    const mv = document.createElement('model-viewer');
    mv.setAttribute('src', module.spec.asset_url);
    mv.setAttribute('alt', `${module.name} overlay`);
    mv.setAttribute('disable-pan', '');
    mv.setAttribute('disable-zoom', '');
    mv.setAttribute('disable-tap', '');
    mv.setAttribute('interaction-prompt', 'none');
    mv.dataset.moduleId = module.id;
    _loaderMv = mv;
    _attachRetryCount = 0;
    hidden.appendChild(mv);

    // model-viewer fires 'load' once gltf.scene is populated. We
    // hand off to the body driver from there. Some model-viewer
    // versions fire 'model-visibility' instead; listen to both.
    const onReady = () => tryAttachLoaderScene(module);
    mv.addEventListener('load', onReady, { once: true });
    mv.addEventListener('model-visibility', onReady, { once: true });
    // Safety net for very fast caches — fire a delayed check too.
    setTimeout(onReady, 600);
}

function applyEvent(detail) {
    const module = detail?.module || null;
    _currentModule = module;
    if (!module) {
        teardownAll();
        return;
    }
    const spec = module.spec || {};
    if (spec.asset_url) {
        // Real GLB overlay via bone parenting (Phase 7.5).
        clearGlyphOverlay();
        mountAssetOverlay(module);
    } else {
        // Glyph DOM overlay (Phase 7 fallback).
        teardownAttach();
        paintGlyphOverlay(module);
    }
}

/** Init at app boot — idempotent. Wires the equip event listener and
 *  a MutationObserver on the stage subject element so an equipped
 *  outfit re-paints when the centered hero swaps (the body driver
 *  rebinds, so the prior attach handle is stale — we redo it with
 *  the new bones). */
export function initOutfitRenderer() {
    if (_wired) return;
    _wired = true;

    document.addEventListener('dexhero:outfit-equip', (ev) => {
        try { applyEvent(ev?.detail); }
        catch (err) { console.warn('[dexhero-outfit] apply error', err); }
    });

    const host = findHostEl();
    if (host) {
        const obs = new MutationObserver(() => {
            if (!_currentModule) return;
            // Glyph overlay lives inside the stage subject and is
            // blown away on swap — re-paint. Asset overlay lives on
            // the bone graph and is invalidated when the body driver
            // rebinds — re-mount the asset loader to grab a fresh
            // scene and reattach to the new bone.
            const spec = _currentModule.spec || {};
            if (spec.asset_url) {
                // Body swap invalidated the bone — re-attach to new one.
                if (_attachHandle) { try { detachOverlay(_attachHandle); } catch {} _attachHandle = null; }
                mountAssetOverlay(_currentModule);
            } else if (!host.querySelector(`.${OVERLAY_CLASS}`)) {
                paintGlyphOverlay(_currentModule);
            }
        });
        obs.observe(host, { childList: true });
    }
}

/** Imperative: clear any equipped outfit. Used by body-picker when the
 *  user picks a DexHero NFT (which replaces the centered body and
 *  implicitly invalidates any outfit). */
export function clearOutfit() {
    _currentModule = null;
    teardownAll();
}
