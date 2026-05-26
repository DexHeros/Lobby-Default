/* app/services/steam-session.js
 *
 * Per-tab Steam session storage. The wallet-free Steam OpenID flow
 * round-trips the session token via the URL hash (which the browser
 * never sends to the server, so it's not in any access log). On app
 * boot we extract the token, store it in sessionStorage, and strip it
 * from the address bar via history.replaceState.
 *
 * sessionStorage is per-TAB — closing the tab clears it, even if the
 * browser process keeps running. That gives us "tab close = sign out"
 * which a HttpOnly cookie can't (cookies are browser-wide).
 *
 * Use steamFetch(url, opts) from any panel that needs Steam auth — it
 * adds the X-Steam-Session header automatically when a token is set.
 */

const STORAGE_KEY = 'dx_steam_session';
const HEADER_NAME = 'X-Steam-Session';

/**
 * Run on app boot. Looks for `steam_token=…` in the SPA's hash query
 * (set by /api/steam/auth/callback). If present, stash in sessionStorage
 * and strip from the URL so it's no longer visible / in browser history.
 */
export function initSteamSession() {
    try {
        const hash = location.hash || '';
        // Hash format: #/route/path?steam_link=ok&steam_token=<t>
        const qIdx = hash.indexOf('?');
        if (qIdx < 0) return;
        const params = new URLSearchParams(hash.slice(qIdx + 1));
        const token  = params.get('steam_token');
        if (!token) return;

        sessionStorage.setItem(STORAGE_KEY, token);

        // Strip steam_token (and steam_link) from the hash so they don't
        // sit in the URL bar or browser history. Keep any other params
        // the panel might care about.
        params.delete('steam_token');
        params.delete('steam_link');
        const remaining = params.toString();
        const newHash = remaining
            ? `${hash.slice(0, qIdx)}?${remaining}`
            : hash.slice(0, qIdx);
        history.replaceState(null, '', `${location.pathname}${location.search}${newHash}`);
    } catch (err) {
        console.warn('[steam-session] init:', err.message);
    }
}

/** Read the current Steam session token from sessionStorage, or null. */
export function getSteamToken() {
    try { return sessionStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
}

/** Clear the local Steam session (also tells the server). */
export async function clearSteamSession() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    try {
        await fetch('/api/steam/sign-out', {
            method: 'POST',
            headers: { ...steamHeader() },
            credentials: 'include',
        });
    } catch {}
}

/** Header object — empty {} if not signed in. */
export function steamHeader() {
    const t = getSteamToken();
    return t ? { [HEADER_NAME]: t } : {};
}

/**
 * Wrapper around fetch that automatically attaches the Steam session
 * header when one is present. Drop-in replacement for fetch() in any
 * panel that hits a Steam-aware endpoint.
 */
export function steamFetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}), ...steamHeader() };
    return fetch(url, {
        ...opts,
        headers,
        credentials: opts.credentials || 'include',
    });
}
