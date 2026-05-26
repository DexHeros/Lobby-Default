/* Play Pass service.
   Single source of truth for verifying ownership of the Platform Play Pass
   and for purchasing one. The pass contract today lives on Sepolia (testnet)
   and will be redeployed on Base mainnet for the v1 launch. Reads MUST
   target the chain the pass actually lives on regardless of which chain
   the user's wallet is currently connected to — going through
   wallet.getProvider() would fail with CALL_EXCEPTION on the wrong chain
   and incorrectly report "no pass" for users who actually own one.

   P2.8/B6 (2026-05-07): Address resolution is now driven by deployments.json
   keyed by chainId, with a hardcoded fallback table for the case where
   deployments.json hasn't loaded yet (or the contract entry is missing).
   The fallback table doubles as documentation of where the pass currently
   lives on each network.

   TODO: js/generate-model.js (lines 347-470) and pages/node-onboarding.html
   (lines 687-791) still carry duplicate inline copies of this logic. Migrate
   them to call this service in a follow-up cleanup. */

import * as wallet from './wallet.js';
import { loadDeployments, getDeployment } from '/js/blockchain/deployments-loader.js';

// The chain the Play Pass currently lives on. This is the *contract* chain,
// not the user's wallet chain — verifyPass() always reads this chain even
// when the user is connected elsewhere. Override at runtime via
// `window.PLAY_PASS_CHAIN_ID` (set by blockchain-integration.js once the
// mainnet pass is redeployed; flip the default when SERVER_CHAIN_ID does).
const DEFAULT_PLAY_PASS_CHAIN_ID = 11155111; // Sepolia

const SEPOLIA_HEX = '0xaa36a7';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
// Multi-RPC fallback list. publicnode rate-limits aggressively from
// browsers and intermittently 429s, which silently turned verifyPass()
// into "no pass" for users who actually owned one. We try each in order
// and short-circuit on the first endpoint that answers.
const SEPOLIA_RPCS = [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://eth-sepolia.public.blastapi.io',
    'https://endpoints.omniatech.io/v1/eth/sepolia/public',
    'https://rpc.sepolia.org',
];
// Per-chain RPC fallback table for read-only verifyPass. Add new chains
// here when the pass is redeployed; deployments.json drives the address,
// this table drives the RPC.
const CHAIN_RPCS = {
    11155111: SEPOLIA_RPCS,
    // Base mainnet (8453) — populate when the pass is redeployed there.
    // 8453: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
// Per-chain wallet-switch metadata (only used by purchasePass to nudge
// the user onto the right chain before signing the USDC transfer).
const CHAIN_SWITCH_META = {
    11155111: {
        chainIdHex: SEPOLIA_HEX,
        chainName: 'Sepolia',
        rpcUrls: [SEPOLIA_RPC],
        nativeCurrency: { name: 'SepoliaETH', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://sepolia.etherscan.io'],
    },
    8453: {
        chainIdHex: '0x2105',
        chainName: 'Base',
        rpcUrls: ['https://mainnet.base.org'],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://basescan.org'],
    },
};
export const PASS_PRICE_USDC = '100';

// Hardcoded fallback addresses, keyed by chainId. Used when
// deployments.json hasn't loaded yet OR doesn't have an entry for the
// pass on that chain. Mirrors the constants at
// js/blockchain-integration.js line 222-224. When the pass is deployed
// on a new chain, update both deployments.json and this table.
const FALLBACK_ADDRESSES = {
    11155111: {
        passContract: '0x0f30d05b8c284dfd975113ee60ebe360eb380fc4',
        usdcContract: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        // Pass contract's treasury() (queried once: 0x5cb6…90a8) so the
        // client doesn't have to round-trip the chain to learn where to
        // send the USDC.
        treasury: '0x5cb65422ed872b9c37c5e2e35d27c929d6ca90a8',
    },
    // 8453: { … } — populate at mainnet cutover.
};

const PLAY_PASS_ABI_MIN = [
    'function hasActivePlayPass(address wallet) view returns (bool)',
];
const USDC_ABI_MIN = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
];

/** Resolve the Play Pass chainId at runtime. Lets us flip
 *  testnet → mainnet via a single window override without changing this
 *  file. */
function _passChainId() {
    const override = Number(window.PLAY_PASS_CHAIN_ID);
    return Number.isFinite(override) && override > 0
        ? override
        : DEFAULT_PLAY_PASS_CHAIN_ID;
}

/** Look up the Play Pass contract address on the given chain. Drives:
 *  1. deployments.json `addresses.PlatformPlayPass` (preferred)
 *  2. legacy window.CONTRACT_ADDRESSES.<network>.platformPlayPass
 *  3. FALLBACK_ADDRESSES table above
 *  Returns null if no entry exists on that chain. */
export async function getPassContract(chainId = _passChainId()) {
    try {
        await loadDeployments();
        const dep = getDeployment(chainId);
        const fromDep = dep?.addresses?.PlatformPlayPass;
        if (fromDep) return fromDep;
    } catch (_) { /* fall through */ }
    const legacyKey = chainId === 11155111 ? 'sepolia' : null;
    if (legacyKey && window.CONTRACT_ADDRESSES?.[legacyKey]?.platformPlayPass) {
        return window.CONTRACT_ADDRESSES[legacyKey].platformPlayPass;
    }
    return FALLBACK_ADDRESSES[chainId]?.passContract || null;
}

/** Look up the USDC contract address on the given chain. */
export async function getUsdcContract(chainId = _passChainId()) {
    try {
        await loadDeployments();
        const dep = getDeployment(chainId);
        const fromDep = dep?.addresses?.USDC;
        if (fromDep) return fromDep;
    } catch (_) { /* fall through */ }
    const legacyKey = chainId === 11155111 ? 'sepolia' : null;
    if (legacyKey && window.CONTRACT_ADDRESSES?.[legacyKey]?.usdc) {
        return window.CONTRACT_ADDRESSES[legacyKey].usdc;
    }
    return FALLBACK_ADDRESSES[chainId]?.usdcContract || null;
}

/** Look up the Treasury address that receives the $100 USDC. */
export async function getTreasuryAddress(chainId = _passChainId()) {
    try {
        await loadDeployments();
        const dep = getDeployment(chainId);
        const fromDep = dep?.addresses?.Treasury;
        if (fromDep) return fromDep;
    } catch (_) { /* fall through */ }
    return FALLBACK_ADDRESSES[chainId]?.treasury || null;
}

/** Look up the RPC fallback list for a chain. */
function _rpcsFor(chainId) {
    return CHAIN_RPCS[chainId] || [];
}

/** Wait briefly for window.ethers to load. Panels can mount before the CDN
    script finishes parsing on a slow / cached connection. */
async function _ethersReady(timeoutMs = 5000) {
    if (window.ethers) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (window.ethers) return true;
        await new Promise((r) => setTimeout(r, 80));
    }
    return false;
}

/** Read-only check against the Play Pass contract on its home chain.
    Always uses a fixed JSON-RPC for that chain so the answer is correct
    even when the user's wallet is currently on a different chain. Tries
    multiple public RPCs — if the first endpoint rate-limits or errors,
    falls through to the next so a transient infrastructure hiccup never
    reads as "no pass". */
export async function verifyPass(address) {
    if (!address) return false;
    const ok = await _ethersReady();
    if (!ok) {
        console.warn('[play-pass] verifyPass: ethers not loaded');
        return false;
    }
    const chainId = _passChainId();
    const passAddr = await getPassContract(chainId);
    if (!passAddr) {
        console.warn(`[play-pass] no Play Pass contract on chain ${chainId}`);
        return false;
    }
    const rpcs = _rpcsFor(chainId);
    if (!rpcs.length) {
        console.warn(`[play-pass] no RPC fallback list for chain ${chainId}`);
        return false;
    }
    let lastErr = null;
    for (const rpc of rpcs) {
        try {
            const provider = new window.ethers.providers.JsonRpcProvider(rpc);
            const c = new window.ethers.Contract(passAddr, PLAY_PASS_ABI_MIN, provider);
            const has = await c.hasActivePlayPass(address);
            console.log(`[play-pass] verify ${address} on ${passAddr} via ${rpc} → ${has}`);
            return !!has;
        } catch (err) {
            lastErr = err;
            console.warn(`[play-pass] rpc ${rpc} failed: ${err?.message || err}`);
        }
    }
    console.warn(`[play-pass] all chain ${chainId} RPCs failed; last:`, lastErr?.message || lastErr);
    return false;
}

/** Switch the wallet to the Play Pass home chain (adds it if unknown).
    The pass contract + USDC permit only resolve on that chain, so the
    tx prompt never appears when the wallet is on the wrong chain. */
async function ensurePassChain(eip1193, chainId) {
    const meta = CHAIN_SWITCH_META[chainId];
    if (!meta) {
        throw new Error(`Play Pass not configured for chain ${chainId}`);
    }
    const id = await eip1193.request({ method: 'eth_chainId' });
    if (String(id).toLowerCase() === meta.chainIdHex.toLowerCase()) return;
    try {
        await eip1193.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: meta.chainIdHex }],
        });
    } catch (swErr) {
        if (swErr && swErr.code === 4902) {
            await eip1193.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: meta.chainIdHex,
                    chainName: meta.chainName,
                    rpcUrls: meta.rpcUrls,
                    nativeCurrency: meta.nativeCurrency,
                    blockExplorerUrls: meta.blockExplorerUrls,
                }],
            });
        } else {
            throw swErr;
        }
    }
}

/** Purchase a Play Pass — single wallet popup.
 *
 *  Flow: user signs ONE on-chain USDC transfer of $100 to the pass
 *  contract's treasury, then we POST the tx hash to
 *  /api/play-pass/relay-mint and the server (using its Deploy Wallet,
 *  authorized by the Master Wallet) calls mintPlayPassByRelay(<sender>)
 *  on the user's behalf. The user pays the USDC; the server pays the
 *  pass-mint gas. From the user's POV: one popup, one tx, done.
 *
 *  `onStatus(text)` is called between phases for UI updates.
 *  Resolves to { ok: true, transferTxHash, mintTxHash? } or throws. */
export async function purchasePass({ onStatus = () => {} } = {}) {
    if (!window.ethers) throw new Error('Wallet library not loaded');
    if (!wallet.isConnected()) throw new Error('Connect a wallet first');
    const ethersProvider = wallet.getProvider();
    if (!ethersProvider?.provider) throw new Error('No wallet provider');
    const eip1193 = ethersProvider.provider;

    const chainId = _passChainId();
    const [usdcAddr, treasuryAddr] = await Promise.all([
        getUsdcContract(chainId),
        getTreasuryAddress(chainId),
    ]);
    if (!usdcAddr) throw new Error('Play Pass USDC contract not configured');
    if (!treasuryAddr) throw new Error('Play Pass treasury not configured');

    const meta = CHAIN_SWITCH_META[chainId];
    onStatus(`Switching wallet to ${meta?.chainName || `chain ${chainId}`}…`);
    await ensurePassChain(eip1193, chainId);

    const provider = new window.ethers.providers.Web3Provider(eip1193, 'any');
    const signer = provider.getSigner();
    const signerAddr = await signer.getAddress();
    const usdc = new window.ethers.Contract(usdcAddr, USDC_ABI_MIN, signer);
    const amount = window.ethers.utils.parseUnits(PASS_PRICE_USDC, 6);

    // Read-only pre-flight: gas + USDC balance. No tx, no signature.
    try {
        const [ethBal, usdcBal] = await Promise.all([
            provider.getBalance(signerAddr),
            usdc.balanceOf(signerAddr),
        ]);
        console.log(
            `[play-pass] balances — ETH: ${window.ethers.utils.formatEther(ethBal)} · USDC: ${window.ethers.utils.formatUnits(usdcBal, 6)}`,
        );
        if (ethBal.lt(window.ethers.utils.parseUnits('0.001', 18))) throw new Error('Low Gas Error');
        if (usdcBal.lt(amount)) throw new Error(`Need ${PASS_PRICE_USDC} USDC.`);
    } catch (preErr) {
        if (/Gas|USDC/i.test(preErr?.message || '')) throw preErr;
        console.warn('[play-pass] pre-flight check failed:', preErr?.message || preErr);
    }

    // Single on-chain tx — plain USDC.transfer($100, treasury). One
    // wallet popup. Wallet shows it as "Send 100 USDC to <treasury>",
    // exactly the mental model users already have for transfers.
    onStatus('Confirm the $100 transfer in your wallet…');
    const tx = await usdc.transfer(treasuryAddr, amount);
    console.log('[play-pass] transfer tx:', tx.hash);

    onStatus('Transfer sent — waiting for confirmation…');
    await tx.wait();

    // Hand the tx hash to the server. It verifies the Transfer event
    // matches (sender + treasury + amount), then mints the pass to the
    // sender via mintPlayPass() — server pays that gas.
    onStatus('Activating your Play Pass…');
    const r = await fetch('/api/play-pass/relay-mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: tx.hash, wallet: signerAddr }),
        credentials: 'include',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || 'Mint relay failed');

    return { ok: true, transferTxHash: tx.hash, mintTxHash: data.mintTxHash || null };
}

/** Map raw provider errors to short user-readable strings. */
export function describePurchaseError(err) {
    const raw = err?.reason || err?.data?.message || err?.error?.message || err?.message || String(err || '');
    if (/User (denied|rejected)|action_rejected|reject/i.test(raw)) return 'Signature cancelled';
    if (/pass already active/i.test(raw)) return 'Pass already active';
    if (/insufficient funds/i.test(raw)) return 'Insufficient funds for gas';
    if (/balance|allowance/i.test(raw)) return `USDC balance too low (need ${PASS_PRICE_USDC} USDC)`;
    return raw || 'Purchase failed';
}
