// app/admin/health-row.js
//
// One-row system status displayed at the top of /#/admin, every tab.
// Silent green when healthy; red dot only when something needs attention.
// Click expands the offending metric inline.
//
// Pulls from /api/health (no new server endpoint). What "all clear" means:
//   - supabase ok
//   - all workers heartbeat in last 5 min
//   - latency p95 < 80ms (when there's a recent sample)
//   - hot wallet above its solvency threshold
//
// Refreshes every 15s. Auto-stops if the parent element is removed
// (MutationObserver on document body).

const POLL_MS = 15_000;
const P95_THRESHOLD_MS = 80;

function dot(state) {
    return `<span class="health-row-dot health-row-dot--${state}"></span>`;
}

function evaluate(payload) {
    const blockers = [];
    if (!payload || payload.ok === false) {
        blockers.push('overall');
    }
    if (payload?.supabase && payload.supabase.ok === false) {
        blockers.push(`supabase (${payload.supabase.reason || 'down'})`);
    }
    if (payload?.workers && payload.workers.ok === false) {
        const stale = (payload.workers.stale || []).slice(0, 3).join(', ');
        blockers.push(`stale workers: ${stale || '—'}`);
    }
    if (payload?.hot_wallet && payload.hot_wallet.ok === false) {
        blockers.push(`hot wallet: ${payload.hot_wallet.reason || 'low'}`);
    }
    const p95 = payload?.latency?.p95Ms ?? payload?.latency?.p95 ?? null;
    if (typeof p95 === 'number' && p95 > P95_THRESHOLD_MS) {
        blockers.push(`p95 ${Math.round(p95)}ms (>${P95_THRESHOLD_MS}ms)`);
    }
    return { ok: blockers.length === 0, blockers, p95 };
}

function summary(payload, evalResult) {
    const workers = payload?.workers;
    const workerCount = workers?.totalServices ?? workers?.total ?? null;
    const workerOk = workerCount != null
        ? `${workerCount - (workers?.stale?.length || 0)}/${workerCount} bots`
        : 'bots ?';
    const p95 = evalResult.p95 != null ? `p95 ${Math.round(evalResult.p95)}ms` : '';
    return [p95, workerOk].filter(Boolean).join(' · ');
}

export function buildHealthRow() {
    const el = document.createElement('section');
    el.className = 'panel-section health-row';
    el.innerHTML = `<div class="health-row-line" data-summary>${dot('pending')}<span>Loading status…</span></div>`;
    el.style.cursor = 'pointer';
    let expanded = false;
    let lastResult = null;

    const renderState = (state, label, detail) => {
        const summaryEl = el.querySelector('[data-summary]');
        if (!summaryEl) return;
        summaryEl.innerHTML = `${dot(state)}<span>${label}</span>${detail ? `<span class="health-row-detail">${detail}</span>` : ''}`;
    };

    const renderExpanded = () => {
        const existing = el.querySelector('[data-expanded]');
        if (existing) existing.remove();
        if (!expanded || !lastResult || lastResult.ok) return;
        const div = document.createElement('div');
        div.dataset.expanded = '1';
        div.className = 'health-row-expanded';
        div.innerHTML = lastResult.blockers.map((b) => `<div>• ${b}</div>`).join('') || '<div>—</div>';
        el.appendChild(div);
    };

    el.addEventListener('click', () => {
        if (!lastResult || lastResult.ok) return;
        expanded = !expanded;
        renderExpanded();
    });

    let timer = null;
    let stopped = false;

    const tick = async () => {
        if (stopped) return;
        try {
            const res = await fetch('/api/health', { cache: 'no-store' });
            const payload = await res.json().catch(() => null);
            const result = evaluate(payload);
            lastResult = result;
            if (result.ok) {
                renderState('ok', 'All clear', summary(payload, result));
                expanded = false;
                renderExpanded();
            } else {
                renderState('err', `${result.blockers.length} issue${result.blockers.length > 1 ? 's' : ''}`, summary(payload, result));
                renderExpanded();
            }
        } catch (e) {
            lastResult = { ok: false, blockers: [`probe failed: ${e.message || e}`] };
            renderState('warn', 'Health probe failed', '');
        }
    };

    tick();
    timer = setInterval(tick, POLL_MS);

    // Auto-stop polling when the element is removed from the DOM.
    const observer = new MutationObserver(() => {
        if (!document.contains(el) && !stopped) {
            stopped = true;
            clearInterval(timer);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return el;
}
