/**
 * Shared security utilities for DexHero frontend.
 * Include this script before any other application scripts.
 */

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.origin);
        if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) return '';
        return parsed.href;
    } catch {
        return '';
    }
}

window.DexHeroUtils = { escapeHtml, sanitizeUrl };
