/* upgrade-demo-video — the dexhero-recorded demonstration of a patch's
 * change. Three display modes the user can toggle between:
 *
 *   • cycle   — auto-cycle between BEFORE and AFTER (the default "video")
 *   • split   — side-by-side, both visible at once (easy comparison)
 *   • slider  — draggable vertical divider over a single stacked image
 *               (the classic image-comparison pattern; lets the user
 *                sweep across the change to evaluate it precisely)
 *
 * Renders an SVG-based mini-scene parameterised by patch.target_surface
 * (popover / ticker / chat-row / slot / global). The "after" pane has
 * the patch's CSS variables read off and re-bound to the SVG palette.
 *
 * Stage B will swap the SVG renderer for a real <video src=...> once
 * the brain captures actual frames via MediaRecorder.
 */

const VARIANT = {
    popover: (p) => `
        <rect x="6" y="6" width="148" height="98" rx="${p.radius}" fill="${p.bg}" stroke="${p.border}" stroke-width="1"/>
        <rect x="14" y="14" width="60" height="8" rx="2" fill="${p.title}" opacity="0.85"/>
        <rect x="14" y="28" width="132" height="14" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="14" y="46" width="132" height="14" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="14" y="64" width="132" height="14" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="14" y="82" width="80" height="14" rx="${p.itemRadius}" fill="${p.accent}"/>
    `,
    ticker: (p) => `
        <rect x="0" y="32" width="160" height="46" fill="${p.bg}"/>
        <text x="14" y="58" font-family="ui-monospace,monospace" font-size="9" fill="${p.title}" font-weight="700">twinkly_phoenix</text>
        <text x="14" y="68" font-family="ui-monospace,monospace" font-size="6" fill="${p.sub}">1.2k adopters</text>
        <text x="86" y="58" font-family="ui-monospace,monospace" font-size="9" fill="${p.title}" font-weight="700">glass_orca</text>
        <text x="86" y="68" font-family="ui-monospace,monospace" font-size="6" fill="${p.sub}">893 adopters</text>
        <text x="142" y="58" font-family="ui-monospace,monospace" font-size="9" fill="${p.accent}" font-weight="700">+12</text>
    `,
    'chat-row': (p) => `
        <rect x="0" y="0" width="160" height="110" fill="${p.bg}"/>
        <rect x="8" y="14" width="40" height="6" rx="1" fill="${p.title}" opacity="0.85"/>
        <rect x="52" y="14" width="20" height="6" rx="1" fill="${p.sub}" opacity="0.5"/>
        <rect x="8" y="26" width="136" height="6" rx="1" fill="${p.text}"/>
        <rect x="8" y="36" width="116" height="6" rx="1" fill="${p.text}"/>
        <rect x="8" y="50" width="30" height="6" rx="1" fill="${p.sub}" opacity="0.5"/>
        <rect x="8" y="62" width="100" height="14" rx="6" fill="${p.userBg}" opacity="0.85"/>
        <rect x="14" y="68" width="86" height="3" rx="1" fill="${p.userText}"/>
    `,
    slot: (p) => `
        <rect x="6" y="6" width="148" height="98" rx="${p.radius}" fill="${p.bg}" stroke="${p.border}" stroke-width="1"/>
        <rect x="16" y="16" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}" stroke="${p.accent}" stroke-width="1.4"/>
        <rect x="60" y="16" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="104" y="16" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="16" y="62" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="60" y="62" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}"/>
        <rect x="104" y="62" width="42" height="42" rx="${p.itemRadius}" fill="${p.itemBg}"/>
    `,
    global: (p) => `
        <rect x="0" y="0" width="160" height="110" fill="${p.bg}"/>
        <rect x="0" y="0" width="160" height="14" fill="${p.bg}" opacity="0.9"/>
        <rect x="0" y="14" width="160" height="22" fill="${p.tickerBg}"/>
        <text x="10" y="29" font-family="ui-monospace,monospace" font-size="8" fill="${p.accent}" font-weight="700">DEXHERO</text>
        <circle cx="80" cy="62" r="14" fill="${p.itemBg}"/>
        <rect x="60" y="84" width="40" height="6" rx="2" fill="${p.title}" opacity="0.8"/>
        <rect x="10" y="98" width="40" height="8" rx="2" fill="${p.itemBg}"/>
        <rect x="56" y="98" width="40" height="8" rx="2" fill="${p.itemBg}"/>
        <rect x="102" y="98" width="40" height="8" rx="2" fill="${p.itemBg}"/>
    `,
};

/* Crude CSS-var extractor — pulls `--name: value;` declarations + a few
 * common selector-level overrides out of the patch CSS so the SVG can
 * approximate the new look in the after-pane. Stage A preview only. */
function readPatchPalette(patch) {
    const before = {
        bg: '#0f1216', border: 'rgba(255,255,255,0.08)', title: '#e8e8ec', sub: '#8a8c8e',
        text: '#c8c8c8', accent: '#6ff5ff', itemBg: 'rgba(255,255,255,0.04)',
        itemRadius: 3, radius: 8, tickerBg: 'rgba(0,0,0,0.4)',
        userBg: 'rgba(120,220,255,0.16)', userText: '#a8d8e8',
    };
    const after = { ...before };

    const css = patch.css || '';
    const varRe = /--([\w-]+)\s*:\s*([^;}!]+)/g;
    let m;
    while ((m = varRe.exec(css))) {
        const k = m[1].trim();
        const v = m[2].trim();
        if (k === 'bg-primary' || k === 'slot-bg') after.bg = v;
        if (k === 'ink-0') after.title = v;
        if (k === 'ink-3') after.sub = v;
        if (k === 'acc-cyan') after.accent = v;
        if (k === 'rule' || k === 'slot-border') after.border = v;
        if (k === 'slot-radius') after.radius = parseFloat(v) || after.radius;
    }
    if (/border-radius:\s*0/i.test(css))            after.radius = 0;
    if (/background[^;]*#050|#020|#0a0|#080/.test(css)) after.bg = '#050608';
    if (/color:\s*#6ff5ff/i.test(css))              after.accent = '#6ff5ff';
    if (/color:\s*#ffd97a/i.test(css))              after.accent = '#ffd97a';
    if (/color:\s*#f5d896/i.test(css))              after.title = '#f5d896';
    if (/background[^;]*#0d|#0e/i.test(css))        after.bg = '#0d0e10';
    if (/--bg-primary[^;]*#050608/i.test(css))      after.bg = '#050608';

    const cfg = patch.config || {};
    if (cfg['equipment-slot.inventory.layout'] === 'rows') after.itemRadius = 0;

    after.tickerBg = after.bg;
    after.userBg = `color-mix(in srgb, ${after.accent} 30%, transparent)`;
    after.userText = after.title;

    return { before, after };
}

function buildPane(kind, palette, label) {
    const tpl = VARIANT[kind] || VARIANT.popover;
    return `
        <svg viewBox="0 0 160 110" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" class="upgrade-demo-video__svg">
            <rect x="0" y="0" width="160" height="110" fill="rgba(0,0,0,0.18)"/>
            ${tpl(palette)}
            <text x="8" y="106" font-family="ui-monospace,monospace" font-size="7" fill="rgba(255,255,255,0.7)" letter-spacing="1">${escape(label)}</text>
        </svg>
    `;
}

const MODE_ICONS = {
    cycle:  '⟲',
    split:  '⊞',
    slider: '⟷',
};
const MODE_LABEL = {
    cycle:  'Auto-cycle',
    split:  'Side-by-side',
    slider: 'Slider compare',
};

/* Build the demo-video element.
 *
 * opts:
 *   size: 'compact' | 'full'        — compact hides the caption + smaller chrome
 *   mode: 'cycle' | 'split' | 'slider'  — initial display mode (default 'cycle')
 *   modesAllowed: array of modes to expose in the toggle (default all three)
 */
export function buildDemoVideo(patch, opts = {}) {
    if (!patch) return null;
    const demo = patch.demo_video || {
        kind: 'popover', recorded_by: patch.author_username || 'DexHero',
        caption: patch.description || patch.title || '',
        duration_seconds: 6, cycle_ms: 3000,
    };
    const palette = readPatchPalette(patch);
    const compact = opts.size === 'compact';
    const modesAllowed = opts.modesAllowed || ['cycle', 'split', 'slider'];
    const initialMode = (opts.mode && modesAllowed.includes(opts.mode))
        ? opts.mode : (modesAllowed[0] || 'cycle');

    const el = document.createElement('div');
    el.className = `upgrade-demo-video${compact ? ' upgrade-demo-video--compact' : ''}`;
    el.setAttribute('data-demo-kind', demo.kind || 'popover');
    el.setAttribute('aria-label', `Recorded demonstration by ${demo.recorded_by}`);
    const duration = Math.max(2, Math.min(9, demo.duration_seconds || 6));

    el.innerHTML = `
        <header class="upgrade-demo-video__chrome">
            <span class="upgrade-demo-video__rec" aria-hidden="true">
                <span class="upgrade-demo-video__rec-dot"></span>REC
            </span>
            <span class="upgrade-demo-video__author">${escape(demo.recorded_by || 'DexHero')}</span>
            <span class="upgrade-demo-video__timer" data-timer>0:00 / 0:0${duration}</span>
            ${modesAllowed.length > 1 ? `
                <span class="upgrade-demo-video__modes" role="tablist" aria-label="Compare mode">
                    ${modesAllowed.map((m) => `
                        <button type="button" class="upgrade-demo-video__mode${m === initialMode ? ' is-active' : ''}" data-mode="${m}" title="${escape(MODE_LABEL[m])}" aria-pressed="${m === initialMode}">${MODE_ICONS[m]}</button>
                    `).join('')}
                </span>
            ` : ''}
        </header>

        <div class="upgrade-demo-video__stage" data-stage data-mode="${initialMode}">
            <div class="upgrade-demo-video__pane upgrade-demo-video__pane--before" data-pane="before">
                ${buildPane(demo.kind || 'popover', palette.before, 'BEFORE')}
            </div>
            <div class="upgrade-demo-video__pane upgrade-demo-video__pane--after" data-pane="after">
                ${buildPane(demo.kind || 'popover', palette.after, 'AFTER')}
            </div>
            <div class="upgrade-demo-video__wipe" data-wipe aria-hidden="true"></div>
            <div class="upgrade-demo-video__split-divider" data-split-divider aria-hidden="true"></div>
            <button type="button" class="upgrade-demo-video__slider-handle" data-slider-handle aria-label="Drag to compare">
                <span>⟷</span>
            </button>
        </div>

        ${compact ? '' : `<footer class="upgrade-demo-video__caption">${escape(demo.caption || '')}</footer>`}
    `;

    const stage     = el.querySelector('[data-stage]');
    const beforeEl  = el.querySelector('[data-pane="before"]');
    const afterEl   = el.querySelector('[data-pane="after"]');
    const wipe      = el.querySelector('[data-wipe]');
    const handle    = el.querySelector('[data-slider-handle]');
    const timer     = el.querySelector('[data-timer]');

    /* If this patch has a `demo_url` sentinel (the dexhero actually
     * recorded a clip during /upgrade), swap the SVG panes for <video>
     * sourced from the IndexedDB blobs. Failure is silent — the SVG
     * mock keeps working. */
    if (patch.demo_url) {
        _upgradePanesToVideo(el, patch);
    }
    /* Late-arrival path — if the proposal card mounted with the SVG
     * mock and the dexhero's MediaRecorder finished AFTER the card
     * landed, the chat module dispatches `dexhero:demo-ready`. Swap
     * in-place when it matches this card's patch. */
    const demoReadyAc = new AbortController();
    document.addEventListener('dexhero:demo-ready', (ev) => {
        if (!el.isConnected) { try { demoReadyAc.abort(); } catch {} return; }
        const d = ev.detail || {};
        if (d.patchId !== patch.id) return;
        patch.demo_url = d.demoUrl || patch.demo_url || `idb:${patch.id}`;
        _upgradePanesToVideo(el, patch);
    }, { signal: demoReadyAc.signal });

    let mode = initialMode;
    let showing = 'before';
    let cycleHandle = null;
    let timerHandle = null;
    let tick = 0;
    const cyclePeriod = Math.max(1200, Number(demo.cycle_ms) || 3000);

    /* Apply a mode — updates DOM state + starts/stops the cycle timer. */
    function applyMode(next) {
        mode = next;
        stage.setAttribute('data-mode', next);
        // Mode-toggle button visuals
        el.querySelectorAll('[data-mode]').forEach((b) => {
            const on = b.getAttribute('data-mode') === next;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        // Stop the cycle timer outside of cycle mode
        if (next !== 'cycle') {
            if (cycleHandle) { clearInterval(cycleHandle); cycleHandle = null; }
            // Make both panes visible — CSS handles the layout per mode.
            beforeEl.style.opacity = '';
            afterEl.style.opacity = '';
        }
        if (next === 'cycle') {
            startCycle();
        }
        if (next === 'slider') {
            // Initialize slider handle position to 50%.
            setSliderRatio(0.5);
        }
    }

    function startCycle() {
        if (cycleHandle) return;
        showing = 'before';
        beforeEl.style.opacity = '1';
        afterEl.style.opacity  = '0';
        cycleHandle = setInterval(() => {
            if (!el.isConnected) { stop(); return; }
            wipe.classList.add('is-active');
            setTimeout(() => {
                showing = showing === 'before' ? 'after' : 'before';
                beforeEl.style.opacity = showing === 'before' ? '1' : '0';
                afterEl.style.opacity  = showing === 'after'  ? '1' : '0';
                wipe.classList.remove('is-active');
            }, 220);
        }, cyclePeriod);
    }

    function startTimer() {
        if (timerHandle) return;
        timerHandle = setInterval(() => {
            if (!el.isConnected) { stop(); return; }
            tick = (tick + 1) % (duration + 1);
            if (timer) timer.textContent = `0:0${tick} / 0:0${duration}`;
        }, 1000);
    }

    function setSliderRatio(r) {
        const ratio = Math.max(0, Math.min(1, r));
        stage.style.setProperty('--demo-slider-ratio', String(ratio));
        if (handle) handle.style.left = `${ratio * 100}%`;
    }

    function stop() {
        if (cycleHandle) { clearInterval(cycleHandle); cycleHandle = null; }
        if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    }
    function start() {
        startTimer();
        if (mode === 'cycle') startCycle();
    }

    // Mode-toggle click handler
    el.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-mode]');
        if (!btn) return;
        const next = btn.getAttribute('data-mode');
        if (next && next !== mode) applyMode(next);
    });

    // Slider drag handler — works for mouse + touch + keyboard arrows.
    let dragging = false;
    function pointerToRatio(clientX) {
        const r = stage.getBoundingClientRect();
        return (clientX - r.left) / r.width;
    }
    if (handle) {
        handle.addEventListener('pointerdown', (ev) => {
            if (mode !== 'slider') return;
            dragging = true;
            handle.setPointerCapture(ev.pointerId);
            ev.preventDefault();
        });
        handle.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            setSliderRatio(pointerToRatio(ev.clientX));
        });
        handle.addEventListener('pointerup', (ev) => {
            dragging = false;
            try { handle.releasePointerCapture(ev.pointerId); } catch {}
        });
        // Click anywhere on the stage in slider mode to jump the handle there.
        stage.addEventListener('click', (ev) => {
            if (mode !== 'slider') return;
            if (ev.target.closest('[data-mode]')) return;
            setSliderRatio(pointerToRatio(ev.clientX));
        });
        // Keyboard arrows nudge by 5%
        handle.addEventListener('keydown', (ev) => {
            if (mode !== 'slider') return;
            const current = parseFloat(getComputedStyle(stage).getPropertyValue('--demo-slider-ratio')) || 0.5;
            if (ev.key === 'ArrowLeft')  { ev.preventDefault(); setSliderRatio(current - 0.05); }
            if (ev.key === 'ArrowRight') { ev.preventDefault(); setSliderRatio(current + 0.05); }
        });
        handle.tabIndex = 0;
    }

    // Initial state
    applyMode(initialMode);

    // Lazy-start when scrolled into view
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) start(); else stop();
            }
        }, { threshold: 0.15 });
        io.observe(el);
        el._demoVideoIO = io;
    } else {
        start();
    }
    el._demoVideoStop = stop;
    return el;
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}

/* Replace the SVG before/after panes with real <video> elements
 * sourced from the dexhero's MediaRecorder blobs (stored in IndexedDB).
 * Called when `patch.demo_url` exists OR when the chat module fires
 * `dexhero:demo-ready` for a card that mounted with the SVG fallback.
 *
 * Resolves URLs via `getBlobUrl` from upgrades-mock.js. If either blob
 * is missing the pane stays on the SVG. Existing mode toggling (cycle
 * / split / slider) keeps working over the <video> panes — they share
 * the same data-pane attributes the toggle code reads. */
async function _upgradePanesToVideo(el, patch) {
    if (!el || !patch || !patch.id) return;
    let getBlobUrl;
    try {
        ({ getBlobUrl } = await import('../services/upgrades-mock.js'));
    } catch { return; }
    if (typeof getBlobUrl !== 'function') return;

    const [beforeUrl, afterUrl] = await Promise.all([
        getBlobUrl(patch.id, 'before'),
        getBlobUrl(patch.id, 'after'),
    ]);
    if (!beforeUrl || !afterUrl) return;
    if (!el.isConnected) return;

    const beforePane = el.querySelector('[data-pane="before"]');
    const afterPane  = el.querySelector('[data-pane="after"]');
    if (!beforePane || !afterPane) return;

    const mkVideo = (src, label) => `
        <video class="upgrade-demo-video__media" data-pane-media
               src="${src}" autoplay muted playsinline loop preload="auto"
               aria-label="${escape(label)}"></video>
        <span class="upgrade-demo-video__media-label" aria-hidden="true">${escape(label)}</span>
    `;
    beforePane.innerHTML = mkVideo(beforeUrl, 'BEFORE');
    afterPane.innerHTML  = mkVideo(afterUrl,  'AFTER');
    el.setAttribute('data-demo-source', 'recorded');
}
