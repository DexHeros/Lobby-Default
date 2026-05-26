/* V3Labs stage-subject — renders the center subject inside .lobby-stage__subject.
   Handles swap animation and picks the right renderer.
   Priority: 3D model-viewer → sprite turntable → image → first-letter fallback.

   Two boot-flash fixes baked in here:
     1. Dedup by subject id — rebuildRibbon re-pins Truffle at index 0 and
        retriggers _paintCurrent, which used to re-render the same subject
        and cause a fade-out/fade-in flash. Now we early-return when the
        slot is already showing this exact subject.
     2. Fade-in is gated on the actual asset's load event (GLB decoded,
        IMG loaded), not just on the DOM node being appended. Avoids the
        ~1-3s window where the slot was visible but empty while
        model-viewer was still downloading the GLB. */

let _activeTurntable = null;

function subjectKey(subject) {
    if (!subject) return '';
    return String(subject.id || subject.address || subject.model || subject.image || '');
}

export function renderSubject(slot, subject) {
    if (!slot) return;

    // Dedupe — already showing this exact subject? skip the swap entirely.
    const incomingKey = subjectKey(subject);
    if (incomingKey && slot.dataset.subjectKey === incomingKey && slot.children.length > 0) {
        return;
    }

    // Kick off swap transition: fade out, swap DOM, gated fade-in.
    slot.setAttribute('data-swapping', 'true');

    setTimeout(() => {
        // Tear down any previous sprite turntable instance
        if (_activeTurntable && typeof _activeTurntable.destroy === 'function') {
            try { _activeTurntable.destroy(); } catch {}
            _activeTurntable = null;
        }
        slot.innerHTML = '';
        slot.dataset.subjectKey = incomingKey;
        buildRenderer(slot, subject);
    }, 180);
}

/** Remove data-swapping so the slot fades back in. Each renderer calls
 *  this only when its asset is actually ready to display (GLB decoded,
 *  IMG loaded, sprite preloaded). Idempotent — multiple calls are safe.
 *  A 4-second safety net catches assets that never fire `load`. */
function fadeIn(slot) {
    requestAnimationFrame(() => {
        try { slot.removeAttribute('data-swapping'); } catch {}
    });
}

function buildRenderer(slot, subject) {
    if (!subject) { slot.appendChild(letter('?')); fadeIn(slot); return; }

    // 1) 3D model (model-viewer)
    if (subject.model) {
        const mv = document.createElement('model-viewer');
        mv.setAttribute('src', subject.model);
        mv.setAttribute('alt', subject.name || 'DexHero');
        mv.setAttribute('camera-controls', '');
        mv.setAttribute('exposure', '0.95');
        mv.setAttribute('shadow-intensity', '0.2');
        mv.setAttribute('interaction-prompt', 'none');
        mv.setAttribute('disable-tap', '');
        // Camera radius bumped to 190% so the model fills less of the
        // larger .lobby-stage__subject container.
        mv.setAttribute('camera-orbit', '0deg 90deg 190%');
        // Tripo bakes a walk-in-place cycle into every rigged GLB.
        mv.setAttribute('autoplay', '');
        mv.setAttribute('animation-name', 'walk_in_place');
        slot.appendChild(mv);
        stripProgressBar(mv);
        // Hold the fade-in until the GLB has actually rendered. Without
        // this gate the slot un-fades immediately after we append the
        // element, exposing the empty model-viewer canvas for the 1-3s
        // it takes the 16 MB GLB to download + decode.
        let revealed = false;
        const reveal = () => {
            if (revealed) return;
            revealed = true;
            try {
                document.dispatchEvent(new CustomEvent('dexhero:body-ready', {
                    bubbles: true,
                    detail: {
                        tokenId: subject.id || subject.address || null,
                        element: mv,
                        availableAnimations: Array.from(mv.availableAnimations || []),
                    },
                }));
            } catch {}
            fadeIn(slot);
        };
        if (mv.loaded) reveal();
        else mv.addEventListener('load', reveal, { once: true });
        // Safety net: never leave the slot invisible if the GLB stalls.
        setTimeout(reveal, 4000);
        return;
    }

    // 2) Sprite turntable
    if (subject.sprite && subject.spriteFrames > 0 && typeof window.SpriteTurntable === 'function') {
        const wrap = document.createElement('div');
        wrap.className = 'featured-hero-sprite';
        wrap.style.cssText = 'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
        slot.appendChild(wrap);
        try {
            const baseUrl = subject.sprite.endsWith('/') ? subject.sprite : subject.sprite + '/';
            _activeTurntable = new window.SpriteTurntable(slot, baseUrl, subject.spriteFrames);
            fadeIn(slot);
            return;
        } catch (err) {
            console.warn('[stage-subject] SpriteTurntable failed:', err.message);
            slot.innerHTML = '';
        }
    }

    // 3) Static image — wait for it to decode before fading in
    const img = subject.image || subject.thumbnail_url;
    if (img) {
        const el = document.createElement('img');
        el.src = img;
        el.alt = subject.name || 'DexHero';
        el.loading = 'eager';
        el.decoding = 'async';
        let revealed = false;
        const reveal = () => { if (!revealed) { revealed = true; fadeIn(slot); } };
        if (el.complete && el.naturalWidth > 0) reveal();
        else {
            el.addEventListener('load',  reveal, { once: true });
            el.addEventListener('error', reveal, { once: true });
        }
        slot.appendChild(el);
        setTimeout(reveal, 2000);   // safety net
        return;
    }

    // 4) First-letter fallback — instant.
    slot.appendChild(letter((subject.name || 'D').charAt(0)));
    fadeIn(slot);
}

function letter(ch) {
    const d = document.createElement('div');
    d.className = 'lobby-stage__subject-letter';
    d.textContent = String(ch || 'D').toUpperCase();
    return d;
}

/* Delete the <model-viewer> built-in progress bar node from its shadow DOM.
   The element is added asynchronously once the custom element upgrades, so we
   poll briefly and then stop as soon as it's gone (or give up after ~2s). */
function stripProgressBar(mv) {
    let tries = 0;
    const kill = () => {
        tries++;
        const root = mv.shadowRoot;
        if (root) {
            const bar = root.querySelector('#default-progress-bar, [part~="default-progress-bar"]');
            if (bar) { bar.remove(); return; }
        }
        if (tries < 40) setTimeout(kill, 50);
    };
    kill();
}
