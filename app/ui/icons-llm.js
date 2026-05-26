/* icons-llm.js — provider monogram SVG sprite.
 *
 * Nine 24×24 inline-SVG glyphs (one per LLM provider in llm-providers.js).
 * All monochrome with `currentColor` stroke so the parent CSS color drives
 * the visual. Each is an abstract trademark-safe concept — NOT the
 * provider's official logo. Recognizable enough for orientation, generic
 * enough to coexist with the rest of the V3Labs dark-cyan aesthetic.
 *
 *   anthropic   — 8-ray sun-burst petal
 *   openai      — hex bezel around a small inner core
 *   google      — single-stroke "G" arc with horizontal terminator
 *   mistral     — three vertical scaler bars on a baseline
 *   xai         — bold "X" with extended diagonals
 *   deepseek    — concentric diamond ring
 *   openrouter  — three arrows diverging from a single origin
 *   groq        — lightning bolt inside a rounded square
 *   local       — house silhouette with a > terminal-prompt inside
 */

export const PROVIDER_GLYPH_IDS = [
    'anthropic', 'openai', 'google', 'mistral', 'xai',
    'deepseek', 'openrouter', 'groq', 'local',
];

const GLYPHS = {
    anthropic: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <line x1="12" y1="3.5" x2="12" y2="8.5"/>
            <line x1="12" y1="15.5" x2="12" y2="20.5"/>
            <line x1="3.5" y1="12" x2="8.5" y2="12"/>
            <line x1="15.5" y1="12" x2="20.5" y2="12"/>
            <line x1="6" y1="6" x2="9.4" y2="9.4"/>
            <line x1="14.6" y1="14.6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="14.6" y2="9.4"/>
            <line x1="9.4" y1="14.6" x2="6" y2="18"/>
        </g>`,
    openai: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M 12 4.2 L 18.7 8.1 L 18.7 15.9 L 12 19.8 L 5.3 15.9 L 5.3 8.1 Z"/>
            <circle cx="12" cy="12" r="2.6"/>
        </g>`,
    google: `
        <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 18.7 8.4 A 7.4 7.4 0 1 0 19.4 14.2 L 12 14.2"/>
        </g>`,
    mistral: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <line x1="6" y1="16.5" x2="6" y2="11"/>
            <line x1="12" y1="16.5" x2="12" y2="6.5"/>
            <line x1="18" y1="16.5" x2="18" y2="13"/>
            <line x1="4" y1="18.5" x2="20" y2="18.5"/>
        </g>`,
    xai: `
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>
            <line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/>
        </g>`,
    deepseek: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M 12 3.4 L 20.6 12 L 12 20.6 L 3.4 12 Z"/>
            <path d="M 12 8.2 L 15.8 12 L 12 15.8 L 8.2 12 Z"/>
        </g>`,
    openrouter: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="1.9"/>
            <path d="M 14 11 L 19.5 6"/>
            <path d="M 19.5 6 L 16.5 6 M 19.5 6 L 19.5 9"/>
            <path d="M 14 13 L 19.5 18"/>
            <path d="M 19.5 18 L 16.5 18 M 19.5 18 L 19.5 15"/>
            <path d="M 10 12 L 4.5 12"/>
            <path d="M 4.5 12 L 7 9.6 M 4.5 12 L 7 14.4"/>
        </g>`,
    groq: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4.5" y="4.5" width="15" height="15" rx="2.6"/>
            <path d="M 13.2 7.5 L 9.4 12.5 L 11.8 12.5 L 10.4 16.5 L 14.6 11 L 12.2 11 L 13.2 7.5 Z"/>
        </g>`,
    local: `
        <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 4.4 11.2 L 12 4.6 L 19.6 11.2 L 19.6 19.4 L 4.4 19.4 Z"/>
            <path d="M 9 14.6 L 11 16.3 L 9 18"/>
            <line x1="12.5" y1="18" x2="15.6" y2="18"/>
        </g>`,
};

/**
 * Return an inline-SVG monogram for a given LLM provider id.
 *
 *   providerId — one of PROVIDER_GLYPH_IDS
 *   opts.size  — pixel size (default 24)
 *   opts.title — optional <title> for screen readers
 *
 * Returns an HTML string; the parent's CSS `color` drives the stroke.
 * Unknown ids return an empty span so callers don't have to null-check.
 */
export function providerGlyph(providerId, opts = {}) {
    const inner = GLYPHS[providerId];
    if (!inner) return `<span class="eq-slot__visual-letter" aria-hidden="true">?</span>`;
    const size = Number(opts.size || 24);
    const title = opts.title ? `<title>${escAttr(opts.title)}</title>` : '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="${opts.title ? 'false' : 'true'}" focusable="false">${title}${inner}</svg>`;
}

function escAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}
