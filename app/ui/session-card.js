// app/ui/session-card.js
//
// Phase-4 Live tab — a card that visualises a single in-flight
// streaming session: cover art on the left, session metadata on the
// right (player wallet, game, RTT, fps, bitrate, DEX earned, duration).
// Updates via .update(state) every 5s while the session is live.
//
// Cover art is fetched lazily from /api/steam/app-image?appid=<n>;
// failure falls back to a generated initial-letter tile in cyan glow.

const COVER_W = 96;
const COVER_H = 144;

function fmt(n, digits = 1) {
    n = Number(n);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits);
}

function fmtAddr(s) {
    if (!s || typeof s !== 'string') return '—';
    if (s.length <= 14) return s;
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function fmtDuration(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/**
 * @param {object} state
 * @param {string} state.gameTitle
 * @param {string} [state.coverUrl]
 * @param {number} [state.appId]            — fallback for cover lookup
 * @param {string} state.playerWallet
 * @param {number} state.startedAt          — ms-since-epoch
 * @param {number} [state.rttMs]
 * @param {number} [state.fps]
 * @param {number} [state.bitrateKbps]
 * @param {number} [state.dexEarned]
 * @returns {HTMLElement} with .update(state)
 */
export function buildSessionCard(state) {
    const card = document.createElement('section');
    card.className = 'session-card';
    card.innerHTML = `
        <div class="session-card-cover" data-cover>
            <div class="session-card-cover-fallback" data-fallback></div>
            <img alt="" data-img hidden />
        </div>
        <div class="session-card-body">
            <div class="session-card-head">
                <div class="session-card-title" data-title></div>
                <div class="session-card-time" data-time></div>
            </div>
            <div class="session-card-meta">
                <div><span class="hud-label">Player</span><span data-player></span></div>
                <div><span class="hud-label">RTT</span><span data-rtt></span></div>
                <div><span class="hud-label">FPS</span><span data-fps></span></div>
                <div><span class="hud-label">Bitrate</span><span data-bitrate></span></div>
            </div>
            <div class="session-card-earned">
                <span class="hud-label">+ DEX so far</span>
                <span class="session-card-earned-value" data-dex>0.0000</span>
            </div>
        </div>
    `;

    const img = card.querySelector('[data-img]');
    const fallback = card.querySelector('[data-fallback]');
    const titleEl = card.querySelector('[data-title]');
    const timeEl = card.querySelector('[data-time]');
    const playerEl = card.querySelector('[data-player]');
    const rttEl = card.querySelector('[data-rtt]');
    const fpsEl = card.querySelector('[data-fps]');
    const bitrateEl = card.querySelector('[data-bitrate]');
    const dexEl = card.querySelector('[data-dex]');

    let timer = null;

    function applyCover(s) {
        const url = s.coverUrl || (s.appId ? `https://steamcdn-a.akamaihd.net/steam/apps/${s.appId}/library_600x900.jpg` : null);
        if (url) {
            img.src = url;
            img.hidden = false;
            img.onerror = () => { img.hidden = true; fallback.hidden = false; };
            fallback.hidden = true;
        } else {
            img.hidden = true;
            fallback.hidden = false;
        }
        const initial = (s.gameTitle || '?').trim().charAt(0).toUpperCase();
        fallback.textContent = initial;
    }

    function applyState(s) {
        titleEl.textContent = s.gameTitle || 'Unknown title';
        playerEl.textContent = fmtAddr(s.playerWallet);
        rttEl.textContent = (s.rttMs != null) ? `${Math.round(s.rttMs)} ms` : '—';
        fpsEl.textContent = (s.fps != null) ? String(Math.round(s.fps)) : '—';
        bitrateEl.textContent = (s.bitrateKbps != null) ? `${(s.bitrateKbps / 1000).toFixed(1)} Mbps` : '—';
        dexEl.textContent = `${fmt(s.dexEarned ?? 0, 4)}`;
        applyCover(s);
        // duration tick
        if (timer) clearInterval(timer);
        const tick = () => {
            timeEl.textContent = fmtDuration(Date.now() - (s.startedAt || Date.now()));
        };
        tick();
        timer = setInterval(tick, 1000);
    }

    applyState(state);

    card.update = applyState;
    card.destroy = () => { if (timer) clearInterval(timer); };
    return card;
}
