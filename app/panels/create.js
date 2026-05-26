/* Create panel — step 1 of the legacy 4-step create flow.
   Two tiles: Generate 3D model (AI) | Upload existing 3D model.
   Matches /pages/create-index.html functionality, native Sovereign Lobby styling. */

import { Panel } from '../ui/panel.js';

export default class CreatePanel extends Panel {
    static id        = 'create';
    static variant   = 'right';
    static width     = 480;
    static title     = 'Create';
    static titleBreadcrumb = ['CREATE', 'METHOD'];
    static stageMode = 'keep';

    render() {
        return `
            <div class="hud-display" style="font-size:24px;letter-spacing:0.18em;margin-bottom:10px;">CHOOSE<br>YOUR METHOD</div>
            <div class="hud-body hud-dim" style="margin-bottom:28px;font-size:13px;">How do you want to provide your DexHero's 3D avatar?</div>

            ${renderSteps(1)}

            <div style="display:flex;flex-direction:column;gap:12px;">
                <a class="tile" href="#/create/type?method=generate">
                    <span class="tile__icon">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>
                    </span>
                    <span class="tile__body">
                        <span class="tile__name">Generate 3D Model <span class="hud-badge hud-badge--pending" style="margin-left:4px;">BETA</span></span>
                        <span class="tile__desc">AI-generate a brand-new avatar from a prompt or image.</span>
                    </span>
                    <span class="tile__arrow">→</span>
                </a>
                <a class="tile" href="#/create/type?method=upload">
                    <span class="tile__icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>
                    </span>
                    <span class="tile__body">
                        <span class="tile__name">Upload 3D Model</span>
                        <span class="tile__desc">Already have a <code>.glb</code>? Use your existing model.</span>
                    </span>
                    <span class="tile__arrow">→</span>
                </a>
            </div>

            <style>${panelStyles()}</style>
        `;
    }
}

/* ── Shared helpers exported for sibling create-step panels ──────── */

export function renderSteps(activeIndex) {
    const labels = ['Method', 'Type', 'Model', 'Launch'];
    return `
        <div class="create-steps" aria-label="Create step ${activeIndex} of ${labels.length}">
            ${labels.map((l, i) => {
                const n = i + 1;
                const state = n < activeIndex ? 'done' : n === activeIndex ? 'active' : 'pending';
                return `
                    <span class="create-step" data-state="${state}">
                        <span class="create-step__dot">${n < activeIndex ? '✓' : n}</span>
                        <span class="create-step__label">${l}</span>
                    </span>
                    ${i < labels.length - 1 ? `<span class="create-step__line" data-state="${n < activeIndex ? 'done' : 'pending'}"></span>` : ''}
                `;
            }).join('')}
        </div>
    `;
}

export function panelStyles() {
    return `
        .tile {
            display: flex;
            align-items: flex-start;
            gap: 14px;
            padding: 18px 18px;
            background: transparent;
            border: 1px solid var(--rule);
            border-radius: var(--r-2);
            text-decoration: none;
            color: inherit;
            transition: border-color var(--dur-sm), box-shadow var(--dur-sm), transform var(--dur-sm), background var(--dur-sm);
        }
        .tile:hover {
            border-color: rgba(6,182,212,0.5);
            box-shadow: var(--glow-cyan-sm);
            background: rgba(6,182,212,0.04);
        }
        .tile__icon {
            flex-shrink: 0;
            width: 44px; height: 44px;
            border-radius: var(--r-1);
            background: var(--acc-soft);
            color: var(--acc-cyan);
            display: flex; align-items: center; justify-content: center;
        }
        .tile__body { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .tile__name {
            font-family: var(--font-display);
            font-weight: 600; font-size: 15px;
            color: var(--ink-0);
            display: inline-flex; align-items: center; gap: 4px;
        }
        .tile__desc {
            font-size: 13px; color: var(--ink-2); line-height: 1.5;
        }
        .tile__desc code { font-family: var(--font-mono); font-size: 12px; color: var(--acc-cyan); }
        .tile__arrow {
            align-self: center;
            color: var(--acc-cyan); font-family: var(--font-mono);
            font-size: 14px; letter-spacing: 0.2em;
            flex-shrink: 0;
        }

        /* Step breadcrumb */
        .create-steps {
            display: flex; align-items: center; gap: 6px;
            margin-bottom: 22px;
            font-family: var(--font-mono);
        }
        .create-step { display: flex; align-items: center; gap: 6px; }
        .create-step__dot {
            width: 22px; height: 22px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 10.5px; font-weight: 700;
            background: var(--surf-1); color: var(--ink-3);
            border: 1px solid var(--rule-strong);
        }
        .create-step[data-state="done"] .create-step__dot {
            background: var(--acc-soft); color: var(--acc-cyan); border-color: rgba(6,182,212,0.5);
        }
        .create-step[data-state="active"] .create-step__dot {
            background: var(--acc-cyan); color: #000; border-color: var(--acc-cyan);
            box-shadow: var(--glow-cyan-sm);
        }
        .create-step__label {
            font-size: 10.5px; letter-spacing: 0.18em;
            text-transform: uppercase; color: var(--ink-3);
        }
        .create-step[data-state="active"] .create-step__label,
        .create-step[data-state="done"]   .create-step__label { color: var(--ink-1); }
        .create-step__line {
            flex: 0 0 14px; height: 1px;
            background: var(--rule-strong);
        }
        .create-step__line[data-state="done"] { background: rgba(6,182,212,0.5); }

        @media (max-width: 520px) {
            .create-step__label { display: none; }
        }
    `;
}
