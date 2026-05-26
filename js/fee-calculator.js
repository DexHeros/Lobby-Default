// ─── Creation Fee Calculator (browser) ───────────────────────────────
// Simple modal that lets a creator plug in Market Cap + Liquidity and see
// what % of supply the dynamic Creation Fee would be. Math matches
// lib/dynamic-fee.js bit-for-bit (integer truncation everywhere) so the
// preview equals what the server will sign at quote time.
//
// (Internal API is still exposed as `window.SovereignFeeCalc` for back-
// compat — token-creation.js + legacy callers reference that symbol.)

(function () {
    'use strict';

    const MIN_FEE_BPS = 1;       // 0.01 %
    const MAX_FEE_BPS = 100;     // 1.00 % cap
    const FEE_NUMERATOR = 1_000_000_000;  // 1e9 / mcUsd → bps

    // Inverse-MC curve. Mirrors lib/dynamic-fee.js bit-for-bit (integer floor).
    //   $10M → 100 bps (cap)   |   $100M → 10 bps   |   $1B → 1 bps (floor)
    function baseFeeBps(mcUsd) {
        const mc = Number(mcUsd);
        if (!Number.isFinite(mc) || mc <= 0) return 0;
        return Math.floor(FEE_NUMERATOR / mc);
    }

    function calcDynamicFeeBps(mcUsd, liquidityUsd) {
        let base = baseFeeBps(mcUsd);
        const mc = Number(mcUsd);
        const liq = Number(liquidityUsd || 0);
        if (liq > 0 && mc > 0) {
            const lrBps = Math.floor((liq / mc) * 10_000);
            if (lrBps < 500)       base = Math.floor((base * 150) / 100);
            else if (lrBps > 1500) base = Math.floor((base * 80) / 100);
        }
        if (base < MIN_FEE_BPS) base = MIN_FEE_BPS;
        if (base > MAX_FEE_BPS) base = MAX_FEE_BPS;
        return base;
    }

    // Expose for console + tests
    window.SovereignFeeCalc = { baseFeeBps, calcDynamicFeeBps };

    function fmtUsd(n) {
        const x = Number(n);
        if (!isFinite(x)) return '—';
        if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
        if (x >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
        if (x >= 1e3) return '$' + (x / 1e3).toFixed(2) + 'K';
        return '$' + x.toFixed(0);
    }

    function parseUsdInput(raw) {
        if (!raw) return 0;
        const s = String(raw).trim().toLowerCase().replace(/[$,\s]/g, '');
        const m = s.match(/^([0-9.]+)\s*([kmbt])?$/);
        if (!m) return Number(s) || 0;
        const n = parseFloat(m[1]);
        const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2] || ''] || 1;
        return Math.floor(n * mult);
    }

    function recalc() {
        const mc  = parseUsdInput(document.getElementById('fcalc-mc').value);
        const liq = parseUsdInput(document.getElementById('fcalc-liq').value);
        const errEl = document.getElementById('fcalc-error');
        errEl.textContent = '';

        if (mc <= 0) {
            document.getElementById('fcalc-result-pct').textContent = '—';
            document.getElementById('fcalc-result-amt').textContent = '';
            document.getElementById('fcalc-result-note').textContent = 'Enter a market cap to see the fee.';
            return;
        }
        if (liq > mc) {
            errEl.textContent = 'Liquidity > market cap — double-check your values.';
        }

        const bps = calcDynamicFeeBps(mc, liq);
        const pct = bps / 100;
        const supplyIn = Number(document.getElementById('fcalc-supply').value) || 0;
        document.getElementById('fcalc-result-pct').textContent = pct.toFixed(2) + '%';
        if (supplyIn > 0) {
            const feeTokens = (supplyIn * bps) / 10_000;
            document.getElementById('fcalc-result-amt').textContent =
                `= ${feeTokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} tokens of ${supplyIn.toLocaleString()} total supply`;
        } else {
            document.getElementById('fcalc-result-amt').textContent = '';
        }

        const lrPct = mc > 0 ? (liq / mc) * 100 : 0;
        let band = 'neutral (5% ≤ LR ≤ 15%)';
        let mult = 'base × 1.0';
        if (lrPct < 5)      { band = 'thin float (LR < 5%)';  mult = 'base × 1.5'; }
        else if (lrPct > 15){ band = 'deep float (LR > 15%)'; mult = 'base × 0.8'; }

        document.getElementById('fcalc-result-note').innerHTML = [
            `MC ${fmtUsd(mc)} · Liquidity ${fmtUsd(liq)} · LR ${lrPct.toFixed(2)}%`,
            `Band: ${band} — ${mult}`,
            `Capped to 0.01%–1.00%. Fee vests 1/120 monthly over 10 years.`,
        ].join('<br>');
    }

    function openCalculator() {
        const modal = document.getElementById('fee-calculator-modal');
        if (!modal) return;
        modal.style.display = 'flex';

        // Standalone manual tool — always start clean so experimentation isn't
        // influenced by any scanned token state.
        document.getElementById('fcalc-mc').value = '';
        document.getElementById('fcalc-liq').value = '';
        document.getElementById('fcalc-supply').value = '';

        recalc();
        document.getElementById('fcalc-mc').focus();
    }

    function closeCalculator() {
        const modal = document.getElementById('fee-calculator-modal');
        if (modal) modal.style.display = 'none';
    }

    window.openFeeCalculator  = openCalculator;
    window.closeFeeCalculator = closeCalculator;

    document.addEventListener('DOMContentLoaded', () => {
        const ids = ['fcalc-mc', 'fcalc-liq', 'fcalc-supply'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', recalc);
        });
        const modal = document.getElementById('fee-calculator-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeCalculator();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeCalculator();
        });
    });
})();
