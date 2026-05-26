// app/ui/icons.js
//
// Phase-5 polish — single source of truth for the SVG icons used across
// the host onboarding + console + admin panels. Each icon is a 16×16
// 1.5px-stroke vector that inherits text colour via `currentColor`,
// so it can be coloured with CSS (`.icon { color: var(--acc-cyan); }`)
// or sized via `font-size`.
//
// Usage:
//   import { icon, iconHTML } from './icons.js';
//   panel.appendChild(icon('check'));
//   const html = iconHTML('play');  // string for .innerHTML

const NS = 'http://www.w3.org/2000/svg';

// Icon library. Each entry is the inner SVG markup (no <svg> wrapper).
// Stroke-based for consistent thickness; fills only on solid badges.
const PATHS = {
    'check':       '<polyline points="3,8 7,12 13,4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    'check-fill':  '<circle cx="8" cy="8" r="7" fill="currentColor"/><polyline points="4.5,8 7,10.5 11.5,5.5" fill="none" stroke="#0a0a0e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    'cross':       '<line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    'circle':      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    'circle-fill': '<circle cx="8" cy="8" r="5" fill="currentColor"/>',
    'play':        '<polygon points="4,3 13,8 4,13" fill="currentColor"/>',
    'pause':       '<rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/>',
    'download':    '<path d="M8 2v8m0 0l-3-3m3 3l3-3M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    'gamepad':     '<rect x="2" y="5" width="12" height="7" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="8.5" r="0.8" fill="currentColor"/><line x1="5" y1="7.5" x2="5" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="4" y1="8.5" x2="6" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    'gpu':         '<rect x="2" y="4" width="12" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="7" x2="14" y2="7" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="9.5" r="1" fill="currentColor"/>',
    'shield':      '<path d="M8 2L3 4v4c0 3 2.2 5.5 5 6 2.8-0.5 5-3 5-6V4L8 2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    'bolt':        '<polygon points="9,2 4,9 7,9 6,14 12,7 9,7" fill="currentColor"/>',
    'wallet':      '<rect x="2" y="4" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 7h12" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="10" r="0.9" fill="currentColor"/>',
    'spinner':     '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="20 12" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1.2s" repeatCount="indefinite"/></circle>',
    'chevron-right': '<polyline points="6,3 11,8 6,13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    'celebrate':   '<polygon points="2,14 6,4 14,12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="9" cy="3" r="1" fill="currentColor"/><circle cx="13" cy="6" r="0.8" fill="currentColor"/><circle cx="11" cy="2" r="0.6" fill="currentColor"/>',
};

/**
 * Return SVG markup as a string. Use for innerHTML / template literals.
 * @param {string} name — key from PATHS
 * @param {object} [opts]
 * @param {number} [opts.size]    — viewBox + display size (default 16)
 * @param {string} [opts.cls]     — extra CSS class
 * @returns {string}
 */
export function iconHTML(name, opts = {}) {
    const inner = PATHS[name];
    if (!inner) return '';
    const size = opts.size || 16;
    const cls = `icon icon-${name}` + (opts.cls ? ' ' + opts.cls : '');
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;
}

/**
 * Return a real SVG element. Use when you need to set listeners or
 * attributes after creation.
 * @returns {SVGElement | null}
 */
export function icon(name, opts = {}) {
    const inner = PATHS[name];
    if (!inner) return null;
    const size = opts.size || 16;
    const wrap = document.createElementNS(NS, 'svg');
    wrap.setAttribute('width',   String(size));
    wrap.setAttribute('height',  String(size));
    wrap.setAttribute('viewBox', '0 0 16 16');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.classList.add('icon', `icon-${name}`);
    if (opts.cls) wrap.classList.add(...opts.cls.split(/\s+/));
    wrap.innerHTML = inner;
    return wrap;
}

export const iconNames = Object.freeze(Object.keys(PATHS));
