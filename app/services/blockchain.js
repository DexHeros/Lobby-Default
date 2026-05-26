/* V3Labs blockchain service — passes through to window.DexHeroBlockchain
   (populated by /components/modals.js or by the wallet service on connect).
   Also surfaces ethers + ABIs from /js/blockchain-integration.js (already on window). */

export function getSigner()    { return window.DexHeroBlockchain?.signer    || null; }
export function getProvider()  { return window.DexHeroBlockchain?.provider  || null; }
export function getAddress()   { return window.DexHeroBlockchain?.userAddress || null; }
export function hasWallet()    { return !!(window.DexHeroBlockchain?.signer); }
export function getEthers()    { return window.ethers || null; }

export function requireWallet() {
    if (!hasWallet()) throw new Error('Wallet not connected');
    return window.DexHeroBlockchain;
}

/** Signed message helper — matches the legacy message format used across /api/* endpoints. */
export async function signActionMessage(action) {
    const { signer, userAddress } = requireWallet();
    const ts   = Date.now();
    const msg  = `DexHero ${action} — ${ts}`;
    const sig  = await signer.signMessage(msg);
    return { walletAddress: userAddress, signature: sig, message: msg };
}
