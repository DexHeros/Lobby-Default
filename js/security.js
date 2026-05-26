// Client-side wrapper around the server's /api/security proxy. Mirrors the
// shape of lib/security.js so client and server use the same `decision` to
// gate the Create button and surface red flags. Single source of truth =
// /api/security, which combines GoPlus / RugCheck / Bubblemaps results.
//
// Usage:
//   const r = await window.DexHeroSecurity.evaluate({ tokenAddress, chainId });
//   if (!r.decision.ok) {
//       // r.decision.hardFlags is the list of reasons to display + block on.
//   }
//   if (r.decision.softFlags.length) { /* warnings to surface in amber */ }
//
// `chainId` is either an EVM int (1, 8453, 56, …) or the literal string
// 'solana' for SPL tokens.

window.DexHeroSecurity = (function () {

    /** Hit the server proxy. Returns the full payload — the caller renders flags. */
    async function evaluate({ tokenAddress, chainId }) {
        const params = new URLSearchParams({
            address: tokenAddress,
            chainId: String(chainId),
        });
        const res = await fetch(`/api/security?${params.toString()}`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Security scan failed (HTTP ${res.status})`);
        }
        return res.json();
    }

    /** Convenience accessor — exposes the active threshold table. */
    async function thresholds() {
        const r = await evaluate({ tokenAddress: '0x0000000000000000000000000000000000000000', chainId: 1 })
            .catch(() => null);
        return r?.thresholds || null;
    }

    return { evaluate, thresholds };
})();
