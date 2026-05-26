// app/ui/confetti.js — tiny one-shot confetti animation (no canvas, no deps).
//
// Spawns a fixed-position container with N colored squares, each animated via
// a CSS keyframe that flings them outward + downward with a spin. Auto-removes
// after the animation completes. Total weight: ~50 lines + ~30 lines of CSS
// injected on first call.
//
// Used by app/panels/host.js's post-install dashboard ("🎉 You're online!").

const COLORS = ['#22d3ee', '#f59e0b', '#ef4444', '#22c55e', '#8b5cf6', '#ec4899', '#3b82f6'];
const PIECE_COUNT = 80;
const DURATION_MS = 2500;

let _stylesInjected = false;

function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const css = `
        .dx-confetti-host {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 9999;
            overflow: hidden;
        }
        .dx-confetti-piece {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 10px;
            height: 14px;
            border-radius: 1px;
            opacity: 0;
            transform: translate(-50%, -50%);
            animation: dx-confetti-fall ${DURATION_MS}ms cubic-bezier(0.2, 0.6, 0.4, 1) forwards;
        }
        @keyframes dx-confetti-fall {
            0%   { opacity: 0; transform: translate(-50%, -50%) rotate(0deg) scale(0.6); }
            10%  { opacity: 1; }
            100% {
                opacity: 0;
                transform:
                    translate(calc(-50% + var(--dx-tx, 0px)), calc(-50% + var(--dx-ty, 0px)))
                    rotate(var(--dx-rot, 720deg))
                    scale(1);
            }
        }`;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
}

/**
 * Fires a one-shot confetti burst from the center of the viewport.
 * Safe to call repeatedly; each call spawns + tears down its own container.
 */
export function fire() {
    try {
        if (typeof document === 'undefined') return;
        injectStyles();
        const host = document.createElement('div');
        host.className = 'dx-confetti-host';
        document.body.appendChild(host);

        for (let i = 0; i < PIECE_COUNT; i++) {
            const piece = document.createElement('div');
            piece.className = 'dx-confetti-piece';
            const angle = Math.random() * Math.PI * 2;
            const distance = 200 + Math.random() * 300;       // px outward from center
            const tx = Math.cos(angle) * distance;
            const ty = Math.sin(angle) * distance + 200;       // slight downward bias
            const rot = (Math.random() * 720 - 360) | 0;
            const color = COLORS[i % COLORS.length];
            const delay = Math.random() * 250;
            piece.style.background = color;
            piece.style.setProperty('--dx-tx',  tx + 'px');
            piece.style.setProperty('--dx-ty',  ty + 'px');
            piece.style.setProperty('--dx-rot', rot + 'deg');
            piece.style.animationDelay = delay + 'ms';
            piece.style.width  = (8 + Math.random() * 6) + 'px';
            piece.style.height = (10 + Math.random() * 8) + 'px';
            host.appendChild(piece);
        }

        setTimeout(() => {
            try { host.remove(); } catch {}
        }, DURATION_MS + 500);
    } catch {
        // Best-effort — don't crash the host dashboard if confetti fails.
    }
}

export default { fire };
