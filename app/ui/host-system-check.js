// app/ui/host-system-check.js
//
// Live in-browser capability detector for prospective host operators.
// Renders ONE line on success ("Compatible · Tier 2 · ~0.18 DEX/hr"),
// expands to the full breakdown only when there's something the operator
// needs to know (blockers or warnings).
//
// Pure-DOM component. Returns an HTMLElement the caller drops into the
// host hero. Fires 'host-check-complete' on the host element when all
// async checks have settled, with detail = { passed, blockers, warnings,
// tier, dexPerHr }.

const PROBE_ENDPOINT = '/api/host/probe';
const PROBE_BYTES = 1_048_576;            // 1 MiB
const MIN_UPLOAD_MBPS = 15;

const GPU_TIERS = [
    [/\bRTX\s*50\d{2}\b/i, 3, 'RTX 50-series',     0.32],
    [/\bRTX\s*40\d{2}\b/i, 2, 'RTX 40-series',     0.18],
    [/\bRTX\s*30\d{2}\b/i, 1, 'RTX 30-series',     0.10],
    [/\bRTX\s*20\d{2}\b/i, 0, 'RTX 20-series — below tier', 0.00],
    [/\bGTX\b/i,           0, 'GTX — no GPU-PV support', 0.00],
    [/\bRadeon|RX\s*\d{4}\b/i, 0, 'AMD GPU-PV unstable', 0.00],
    [/\bIris|UHD\s*Graphics\b/i, 0, 'integrated GPU — below tier', 0.00],
];

function detectGPU() {
    let renderer = 'unknown';
    let vendor = 'unknown';
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg) {
                renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
                vendor   = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   || '');
            }
        }
    } catch { /* webgl unavailable */ }
    let tierMatch = null;
    for (const [re, tier, label, dexPerHr] of GPU_TIERS) {
        if (re.test(renderer)) { tierMatch = { tier, label, dexPerHr }; break; }
    }
    return { vendor, renderer, tierMatch };
}

function detectOS() {
    const ua = navigator.userAgent || '';
    const isWindows = /Windows NT/i.test(ua);
    let edition = 'unknown';
    const uad = navigator.userAgentData;
    if (uad?.platform) edition = uad.platform;
    let major = '';
    const m = ua.match(/Windows NT ([\d.]+)/);
    if (m && m[1] === '10.0') major = '10/11';
    return { isWindows, edition, major, ua };
}

function detectWebCapabilities() {
    return {
        webgl2: !!document.createElement('canvas').getContext('webgl2'),
        webcodecs: typeof window.VideoDecoder !== 'undefined',
        webrtcInsertableStreams:
            typeof RTCRtpReceiver !== 'undefined' &&
            typeof RTCRtpReceiver.prototype.createEncodedStreams === 'function',
    };
}

async function probeBandwidth(timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = performance.now();
    try {
        const res = await fetch(`${PROBE_ENDPOINT}?bytes=${PROBE_BYTES}&t=${Date.now()}`, {
            signal: ctrl.signal,
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`probe HTTP ${res.status}`);
        const reader = res.body.getReader();
        let received = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            received += value.byteLength;
        }
        const elapsedMs = performance.now() - start;
        const mbps = (received * 8) / (elapsedMs / 1000) / 1_000_000;
        return { ok: true, mbps: Math.round(mbps), bytes: received, ms: Math.round(elapsedMs) };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    } finally {
        clearTimeout(t);
    }
}

function dot(state) {
    return `<span class="hud-dot host-check-dot host-check-dot--${state}"></span>`;
}

function row(state, label, detail) {
    return `
        <div class="host-check-row" data-state="${state}">
            ${dot(state)}
            <div class="host-check-row-label">${label}</div>
            <div class="host-check-row-detail">${detail}</div>
        </div>`;
}

/**
 * Build the system-check element. The host element exposes a Promise
 * via `el.ready` that resolves once all async checks have settled.
 * Visual state collapses to one line on success.
 *
 * @returns {HTMLElement}
 */
export function buildHostSystemCheck() {
    const el = document.createElement('section');
    el.className = 'panel-section host-check';
    el.innerHTML = `<div class="host-check-line" data-summary>${dot('pending')}<span>Checking system…</span></div>`;

    el.ready = (async () => {
        const result = { passed: false, blockers: [], warnings: [], tier: null, dexPerHr: null };
        const rows = []; // populated for the verbose render below

        const os = detectOS();
        if (os.isWindows) {
            rows.push(row('ok', 'Operating system', `Windows ${os.major || ''}`.trim()));
        } else {
            rows.push(row('err', 'Operating system', `${os.edition || 'non-Windows'} — Windows required`));
            result.blockers.push('os');
        }

        const gpu = detectGPU();
        if (gpu.tierMatch && gpu.tierMatch.tier > 0) {
            rows.push(row('ok', 'GPU', `${gpu.renderer || gpu.vendor} — Tier ${gpu.tierMatch.tier} (${gpu.tierMatch.label})`));
            result.tier = gpu.tierMatch.tier;
            result.dexPerHr = gpu.tierMatch.dexPerHr;
        } else if (gpu.tierMatch) {
            rows.push(row('err', 'GPU', `${gpu.renderer || gpu.vendor} — ${gpu.tierMatch.label}`));
            result.blockers.push('gpu');
        } else if (gpu.renderer && gpu.renderer !== 'unknown') {
            rows.push(row('warn', 'GPU', `${gpu.renderer} — tier unknown; installer will benchmark`));
            result.warnings.push('gpu-unknown');
        } else {
            rows.push(row('warn', 'GPU', 'WebGL renderer hidden; installer will benchmark'));
            result.warnings.push('gpu-hidden');
        }

        rows.push(row('neutral', 'Hardware virtualization (SLAT)', 'verified by installer'));
        rows.push(row('neutral', 'Hyper-V', 'enabled automatically'));

        const web = detectWebCapabilities();
        if (web.webgl2 && web.webcodecs) {
            rows.push(row('ok', 'Browser', 'WebGL2 + WebCodecs'));
        } else {
            rows.push(row('warn', 'Browser', 'WebCodecs missing — Chrome 105+ recommended'));
            result.warnings.push('browser');
        }

        const bw = await probeBandwidth();
        if (bw.ok) {
            if (bw.mbps >= MIN_UPLOAD_MBPS) {
                rows.push(row('ok', 'Network', `${bw.mbps} Mbps (need ≥${MIN_UPLOAD_MBPS})`));
            } else {
                rows.push(row('warn', 'Network', `${bw.mbps} Mbps — borderline for streaming`));
                result.warnings.push('bandwidth');
            }
        } else {
            rows.push(row('warn', 'Network', `probe failed (${bw.error})`));
            result.warnings.push('probe');
        }

        result.passed = result.blockers.length === 0;
        const summaryEl = el.querySelector('[data-summary]');
        const showVerbose = !result.passed || result.warnings.length > 0;

        if (!showVerbose && result.tier && result.dexPerHr) {
            // One-line success state — what the operator sees ~95% of the time on a real rig.
            summaryEl.innerHTML = `${dot('ok')}<span>Compatible · Tier ${result.tier} · ~${result.dexPerHr.toFixed(2)} DEX/hr</span>`;
        } else if (result.blockers.length) {
            summaryEl.innerHTML = `${dot('err')}<span>Hosting blocked — ${result.blockers.length} issue${result.blockers.length > 1 ? 's' : ''}</span>`;
            const breakdown = document.createElement('div');
            breakdown.className = 'host-check-rows';
            breakdown.innerHTML = rows.join('');
            el.appendChild(breakdown);
        } else {
            // warnings-only (passed but worth surfacing)
            summaryEl.innerHTML = `${dot('warn')}<span>Compatible with warnings · Tier ${result.tier ?? '?'}${result.dexPerHr ? ` · ~${result.dexPerHr.toFixed(2)} DEX/hr` : ''}</span>`;
            const breakdown = document.createElement('div');
            breakdown.className = 'host-check-rows';
            breakdown.innerHTML = rows.join('');
            el.appendChild(breakdown);
        }

        el.dispatchEvent(new CustomEvent('host-check-complete', { detail: result, bubbles: true }));
        return result;
    })();

    return el;
}
