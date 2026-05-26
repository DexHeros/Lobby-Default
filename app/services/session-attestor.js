/* V3Labs browser session-attestor SDK (P1.3).
 *
 * Goal: a player opening a cloud-gaming session signs ONE delegation message
 *       in their main wallet (one MetaMask popup at session start) and from
 *       that point forward, all per-minute attestations are signed by an
 *       in-memory ephemeral keypair — no further popups for the rest of the
 *       session.
 *
 * Lifecycle:
 *   const attestor = await startSession(sessionId, verifierAddress, chainId, monadEid);
 *      → generates ephemeral keypair via ethers.Wallet.createRandom()
 *      → builds delegation digest matching SessionVerifier.delegatePlayerSessionKey:
 *           keccak256(abi.encode(uint256 chainid, address verifier,
 *                                "DexHero.SessionKeyDelegation",
 *                                bytes32 sessionId, address ephemeralKey))
 *      → calls wallet.signMessage(arrayify(digest))   ← single MetaMask popup
 *      → POSTs { sessionId, ephemeralAddress, delegationSig } to
 *           /api/session/delegate-player-key (Agent D's endpoint, P1.4).
 *      → returns an instance handle; caller hands it to the player.
 *
 *   await attestor.signAttestation(metrics, attestationCount)
 *      → builds the EIP-191-wrapped player attestation digest matching
 *           tools/speedrun-keeper.js  buildSignedPlayerAttestation:
 *           keccak256(abi.encode(uint256 chainid, address verifier,
 *                                "DexHero.PlayerAttestation",
 *                                bytes32 sessionId, uint256 attestationCount,
 *                                uint256 fps, uint256 rttMs,
 *                                uint256 inputEntropyScore,
 *                                uint256 inputEventsPerMin))
 *      → signs with the ephemeral key (no wallet popup), returns a
 *           SignedPlayerAttestation: { fps, rttMs, inputEntropyScore,
 *                                       inputEventsPerMin, signature }.
 *
 *   attestor.endSession()
 *      → zeros the in-memory ephemeral key. Refreshing the page invalidates
 *        the session naturally because the key only ever lives in JS heap.
 *
 * Browser ethers version: this codebase loads ethers v5 via the global
 * window.ethers. We mirror that here and keep the encode/digest path byte-for-
 * byte identical to the off-chain reference in tools/speedrun-keeper.js.
 */

import * as wallet from './wallet.js';

// ── Internal helpers ──────────────────────────────────────────────────────

async function _ethersReady(timeoutMs = 5000) {
    if (typeof window !== 'undefined' && window.ethers) return window.ethers;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 60));
        if (window.ethers) return window.ethers;
    }
    throw new Error('ethers.js not loaded — cannot build session-attestor digests');
}

function _normalizeSessionIdBytes32(sessionId, eth) {
    // sessionId from the matchmaker may arrive as either:
    //   - a 0x-prefixed 32-byte hex string (already canonical)
    //   - a UUID / opaque short string (server uses the matchmaker's session id)
    // The contract slot is bytes32 — for the digest to recover correctly the
    // server submitter MUST hash the same way. We standardize on:
    //   if input is a 0x...64-hex-chars string → use as-is
    //   else                                  → ethers.utils.id(string)  (= keccak256 of utf8 bytes)
    if (typeof sessionId !== 'string') throw new Error('sessionId must be a string');
    if (/^0x[0-9a-fA-F]{64}$/.test(sessionId)) return sessionId;
    return eth.utils.id(sessionId);
}

function _toUint(x, fallback = 0) {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) return fallback;
    // Solidity uint256 — clamp to a safe integer; per-minute metrics are
    // tiny (fps ≤ 240, rtt ≤ 1000ms, inputEvents ≤ 100k) so a JS Number
    // is plenty.
    return Math.floor(n);
}

// ── SessionAttestor ───────────────────────────────────────────────────────

class SessionAttestor {
    /**
     * @param {object} cfg
     * @param {string} cfg.sessionId               — raw matchmaker session id
     * @param {string} cfg.sessionIdBytes32        — canonical bytes32 used in the digest
     * @param {string} cfg.verifierAddress         — SessionVerifier contract on Monad
     * @param {number} cfg.chainId                 — Monad chainId (10143 testnet)
     * @param {number} [cfg.monadEid]              — LayerZero EID (kept for symmetry; unused in this digest)
     * @param {object} cfg.ephemeral               — ethers.Wallet.createRandom() instance
     * @param {object} cfg.eth                     — captured window.ethers reference
     */
    constructor(cfg) {
        this.sessionId = cfg.sessionId;
        this.sessionIdBytes32 = cfg.sessionIdBytes32;
        this.verifierAddress = cfg.verifierAddress;
        this.chainId = cfg.chainId;
        this.monadEid = cfg.monadEid || null;
        // The ephemeral wallet lives ONLY in JS heap. No localStorage, no
        // sessionStorage, no IndexedDB write. Page refresh = key gone.
        this._ephemeral = cfg.ephemeral;
        this._eth = cfg.eth;
        this._ended = false;
    }

    get ephemeralAddress() {
        return this._ephemeral?.address || null;
    }

    /**
     * Build + sign a per-minute player attestation. Mirrors the reference
     * implementation in tools/speedrun-keeper.js  buildSignedPlayerAttestation
     * exactly — abi.encode types + order, keccak256, signMessage(arrayify(digest)).
     *
     * @param {object} metrics
     *   { fps, rttMs, inputEntropyScore, inputEventsPerMin }
     * @param {number|string} attestationCount
     *   The count BEFORE this attestation (matches the contract's
     *   read-then-increment pattern).
     * @returns {Promise<{fps,rttMs,inputEntropyScore,inputEventsPerMin,signature}>}
     */
    async signAttestation(metrics, attestationCount) {
        if (this._ended) throw new Error('session-attestor: session already ended');
        if (!this._ephemeral) throw new Error('session-attestor: ephemeral key not initialized');
        const eth = this._eth;

        const fps = _toUint(metrics?.fps, 0);
        const rttMs = _toUint(metrics?.rttMs, 0);
        const inputEntropyScore = _toUint(metrics?.inputEntropyScore, 0);
        const inputEventsPerMin = _toUint(metrics?.inputEventsPerMin, 0);
        const count = _toUint(attestationCount, 0);

        const digest = eth.utils.keccak256(
            eth.utils.defaultAbiCoder.encode(
                ['uint256', 'address', 'string', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
                [
                    this.chainId,
                    this.verifierAddress,
                    'DexHero.PlayerAttestation',
                    this.sessionIdBytes32,
                    count,
                    fps,
                    rttMs,
                    inputEntropyScore,
                    inputEventsPerMin,
                ]
            )
        );
        // Wrapped EIP-191 — contract calls MessageHashUtils.toEthSignedMessageHash
        // on its side; signMessage applies that wrapping for us.
        const signature = await this._ephemeral.signMessage(eth.utils.arrayify(digest));
        return { fps, rttMs, inputEntropyScore, inputEventsPerMin, signature };
    }

    /**
     * Zero out the ephemeral key. After this call signAttestation throws.
     * Idempotent. Call on stop / disconnect / panel teardown.
     */
    endSession() {
        this._ended = true;
        // ethers.Wallet doesn't expose its private key in a way we can
        // overwrite in-place; dropping the reference is the strongest
        // thing the JS engine lets us do. GC will collect the underlying
        // bytes once nothing else holds the wallet handle.
        this._ephemeral = null;
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Open a play session: generate an ephemeral keypair, sign the delegation
 * digest with the player's main wallet (single MetaMask popup), POST to
 * /api/session/delegate-player-key so the server can submit the on-chain
 * SessionVerifier.delegatePlayerSessionKey transaction.
 *
 * @param {string} sessionId             — matchmaker session id
 * @param {string} sessionVerifierAddress — SessionVerifier contract on Monad
 * @param {number} chainId               — Monad chain id (10143 testnet)
 * @param {number} [monadEid]            — LayerZero endpoint id (optional)
 * @returns {Promise<SessionAttestor>}
 */
export async function startSession(sessionId, sessionVerifierAddress, chainId, monadEid) {
    if (!sessionId) throw new Error('startSession: sessionId required');
    if (!sessionVerifierAddress) throw new Error('startSession: sessionVerifierAddress required');
    if (!chainId) throw new Error('startSession: chainId required');

    const eth = await _ethersReady();
    if (!eth.utils.isAddress(sessionVerifierAddress)) {
        throw new Error(`startSession: invalid verifierAddress ${sessionVerifierAddress}`);
    }

    const sessionIdBytes32 = _normalizeSessionIdBytes32(sessionId, eth);

    // Fresh per-session keypair. Stays in JS heap only — the SessionAttestor
    // instance is the sole holder. No persistent storage anywhere.
    const ephemeral = eth.Wallet.createRandom();

    // Delegation digest — must mirror SessionVerifier.delegatePlayerSessionKey
    // and tools/speedrun-keeper.js buildDelegationSig.
    const digest = eth.utils.keccak256(
        eth.utils.defaultAbiCoder.encode(
            ['uint256', 'address', 'string', 'bytes32', 'address'],
            [chainId, sessionVerifierAddress, 'DexHero.SessionKeyDelegation', sessionIdBytes32, ephemeral.address]
        )
    );

    // Single MetaMask popup. wallet.signMessage routes through the
    // authoritative wallet service (EIP-191 personal_sign).
    const delegationSig = await wallet.signMessage(eth.utils.arrayify(digest));

    // Notify the server so it can submit delegatePlayerSessionKey on-chain
    // with its own session-manager wallet. The server endpoint is provided
    // by Agent D (P1.4); we assume the contract signature documented in the
    // plan: { sessionId, ephemeralAddress, delegationSig } → { ok, txHash }.
    let resp;
    try {
        resp = await fetch('/api/session/delegate-player-key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                sessionId,
                ephemeralAddress: ephemeral.address,
                delegationSig,
            }),
        });
    } catch (e) {
        throw new Error(`delegate-player-key POST failed: ${e.message || e}`);
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`delegate-player-key returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    return new SessionAttestor({
        sessionId,
        sessionIdBytes32,
        verifierAddress: sessionVerifierAddress,
        chainId,
        monadEid,
        ephemeral,
        eth,
    });
}

// Export the class for type/duck-typing checks (not constructed externally).
export { SessionAttestor };

// ── Shannon entropy of input event distribution (0..100) ──────────────────
// Mirrors the conceptual rule used in tools/anti-fraud-worker.js — a low score
// flags bot-like / replay traffic. We compute over a histogram of event-kind
// codes captured during the last attestation window. Pure function so the
// player can call it without instantiating an attestor.
//
//   counts: an object whose values are non-negative integers (the histogram).
//   returns: integer 0..100  (entropy normalized to log2(numCategories))
//
// Empty input or a single category collapses to 0 (max predictability).
export function shannonEntropyScore(counts) {
    if (!counts || typeof counts !== 'object') return 0;
    const values = Object.values(counts).filter((v) => Number.isFinite(v) && v > 0);
    if (values.length <= 1) return 0;
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    let h = 0;
    for (const v of values) {
        const p = v / total;
        h -= p * Math.log2(p);
    }
    const hMax = Math.log2(values.length);
    if (hMax <= 0) return 0;
    const norm = h / hMax;             // 0..1
    return Math.max(0, Math.min(100, Math.round(norm * 100)));
}
