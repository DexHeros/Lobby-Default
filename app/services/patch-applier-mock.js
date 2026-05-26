/* Patch applier mock — Stage A.
 *
 * Reads active patches from upgrades-mock and renders their CSS into a
 * single <style id="dexhero-patches"> block in <head>. Preview mode uses
 * a separate <style id="dexhero-patch-preview"> block so the canned
 * "Preview" button can cleanly add + remove a single patch without
 * touching the persistent set.
 *
 * Config overrides (microcopy + layout-variants) are applied via
 * data-attributes on <body> + a global lookup map exposed at
 * window.DexHeroMicrocopy so other components can consume them. Real
 * binding into the slot pickers comes in Stage B.
 */

import { getActivePatches, isEnabled, getMasterEnabled } from './upgrades-mock.js';

const STYLE_ID = 'dexhero-patches';
const PREVIEW_STYLE_ID = 'dexhero-patch-preview';

function ensureStyleNode(id) {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
    }
    return el;
}

function compileCss(patches) {
    return patches
        .filter((p) => p.css)
        .map((p) => `/* ${p.id} — ${p.title} */\n${p.css}`)
        .join('\n\n');
}

function compileMicrocopy(patches) {
    const out = {};
    for (const p of patches) {
        const cfg = p.config || {};
        for (const [k, v] of Object.entries(cfg)) {
            if (k.startsWith('microcopy.')) out[k.slice('microcopy.'.length)] = v;
        }
    }
    return out;
}

function applyLayoutVariants(patches) {
    const variants = {};
    for (const p of patches) {
        const cfg = p.config || {};
        for (const [k, v] of Object.entries(cfg)) {
            if (k.endsWith('.layout')) variants[k] = v;
        }
    }
    // Drive layout switches via data-attributes on body so CSS can react.
    for (const [k, v] of Object.entries(variants)) {
        document.body.setAttribute(`data-patch-${k.replace(/\./g, '-')}`, String(v));
    }
}

/* Apply ALL active patches. Called at boot and after every save/adopt/toggle.
 *
 * The master switch (getMasterEnabled, default ON) gates the entire
 * apply step. When OFF, we render the user's lobby exactly as git main
 * delivers it: clear the patch <style> block, wipe microcopy + variant
 * data-attrs. The commit chain stays untouched — flipping master back
 * on restores the lobby instantly. */
export function applyAll() {
    const master = getMasterEnabled();
    const patches = master ? getActivePatches().filter((p) => isEnabled(p.id)) : [];
    const styleEl = ensureStyleNode(STYLE_ID);
    styleEl.textContent = master ? compileCss(patches) : '';

    // Microcopy + layout variants only when master is ON.
    window.DexHeroMicrocopy = master ? compileMicrocopy(patches) : {};
    if (master) {
        applyLayoutVariants(patches);
    } else {
        // Strip any variant attrs left over from a previous render.
        for (const a of [...document.body.attributes]) {
            if (a.name.startsWith('data-patch-')) document.body.removeAttribute(a.name);
        }
    }

    document.dispatchEvent(new CustomEvent('dexhero:patches-applied', {
        bubbles: true, detail: { count: patches.length, master },
    }));
}

/* Preview a SINGLE patch without persisting. The patch's CSS is added
 * to its own <style> block; subsequent calls replace whatever was being
 * previewed. clearPreview() removes the block entirely. */
export function applyPreview(patch) {
    if (!patch) { clearPreview(); return; }
    const el = ensureStyleNode(PREVIEW_STYLE_ID);
    const microcopy = {};
    const cfg = patch.config || {};
    for (const [k, v] of Object.entries(cfg)) {
        if (k.startsWith('microcopy.')) microcopy[k.slice('microcopy.'.length)] = v;
    }
    el.textContent = `/* PREVIEW: ${patch.title || patch.id || 'unsaved patch'} */\n${patch.css || ''}`;

    // Stash the previous microcopy + variant attrs so clearPreview restores them.
    if (!window._dexheroPreviewBackup) {
        window._dexheroPreviewBackup = {
            microcopy: window.DexHeroMicrocopy || {},
            variantAttrs: [...document.body.attributes]
                .filter((a) => a.name.startsWith('data-patch-'))
                .map((a) => [a.name, a.value]),
        };
    }
    if (Object.keys(microcopy).length) {
        window.DexHeroMicrocopy = { ...(window.DexHeroMicrocopy || {}), ...microcopy };
    }
    for (const [k, v] of Object.entries(cfg)) {
        if (k.endsWith('.layout')) {
            document.body.setAttribute(`data-patch-${k.replace(/\./g, '-')}`, String(v));
        }
    }

    document.dispatchEvent(new CustomEvent('dexhero:patch-preview', {
        bubbles: true, detail: { patch },
    }));
}

export function clearPreview() {
    const el = document.getElementById(PREVIEW_STYLE_ID);
    if (el) el.remove();
    // Restore microcopy + variant attrs.
    const backup = window._dexheroPreviewBackup;
    if (backup) {
        window.DexHeroMicrocopy = backup.microcopy || {};
        for (const a of [...document.body.attributes]) {
            if (a.name.startsWith('data-patch-')) document.body.removeAttribute(a.name);
        }
        for (const [k, v] of backup.variantAttrs) document.body.setAttribute(k, v);
        delete window._dexheroPreviewBackup;
    }
    document.dispatchEvent(new CustomEvent('dexhero:patch-preview-cleared', { bubbles: true }));
}

/* Idempotent boot — call once from shell.js. */
let _booted = false;
export function initPatchApplier() {
    if (_booted) return;
    _booted = true;
    applyAll();
    // Re-apply whenever the store changes from another tab (storage event)
    // OR when the local app dispatches its own save/adopt events.
    window.addEventListener('storage', (ev) => {
        if (ev.key === 'dexhero:upgrades:store:v1') applyAll();
    });
    document.addEventListener('dexhero:upgrades-changed', applyAll);
}
