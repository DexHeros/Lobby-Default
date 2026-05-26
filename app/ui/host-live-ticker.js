// app/ui/host-live-ticker.js
//
// Phase 1A of the Steam-tier rebuild — the "right now" stat band that
// renders on the host hero. Backed by /api/host/live-stats (server-side
// aggregator that hits Supabase + memoizes for 30s to avoid spam).
//
// Renders 4 cells in a 2x2 grid:
//   - Hosts online RIGHT NOW
//   - Sessions in flight
//   - Total minutes attested all-time
//   - Estimated DEX/hr at the visitor's tier (computed by the
//     system-check, not us; we just display whatever number is supplied)

const ENDPOINT = '/api/host/live-stats';
const REFRESH_MS = 30_000;

function fmtNum(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

function statBlock(label, value, cyan = false) {
    return `
        <div class="host-hero-stat">
            <div class="host-hero-stat-label">${label}</div>
            <div class="host-hero-stat-value${cyan ? ' is-cyan' : ''}" data-stat>${value}</div>
        </div>`;
}

/**
 * Returns the host element. Caller drops it into the hero band.
 * Auto-refreshes every REFRESH_MS until removed from the DOM.
 *
 * @param {object} opts
 * @param {function} [opts.dexPerHrEstimator] — () => number | null
 *      Called on each refresh; whatever it returns becomes the 4th stat.
 *      Wired by the host panel: the system-check sets a closure value.
 */
export function buildLiveTicker(opts = {}) {
    const el = document.createElement('div');
    el.className = 'host-hero-ticker';
    el.innerHTML = `
        ${statBlock('Hosts online',           '—', false)}
        ${statBlock('Sessions in flight',     '—', false)}
        ${statBlock('Total minutes attested', '—', false)}
        ${statBlock('Your est. DEX/hr',       '—', true)}
    `;
    const cells = el.querySelectorAll('[data-stat]');

    let timer = null;
    let aborted = false;

    async function tick() {
        if (aborted || !document.body.contains(el)) {
            stop();
            return;
        }
        try {
            const r = await fetch(ENDPOINT, { cache: 'no-store' });
            if (r.ok) {
                const data = await r.json();
                cells[0].textContent = fmtNum(data.hostsOnline);
                cells[1].textContent = fmtNum(data.sessionsInFlight);
                cells[2].textContent = fmtNum(data.totalMinutesAttested);
            }
        } catch { /* leave previous values; quiet failure */ }
        // Local-only: visitor's est DEX/hr.
        try {
            const v = opts.dexPerHrEstimator ? opts.dexPerHrEstimator() : null;
            cells[3].textContent = (v && Number.isFinite(v) && v > 0)
                ? `${v.toFixed(2)}`
                : '—';
        } catch { /* swallow */ }
    }

    function stop() {
        aborted = true;
        if (timer) { clearInterval(timer); timer = null; }
    }

    el.start = () => { tick(); timer = setInterval(tick, REFRESH_MS); };
    el.stop = stop;
    return el;
}
