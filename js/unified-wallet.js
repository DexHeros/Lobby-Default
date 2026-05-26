/**
 * UnifiedWalletConnector — passive shell.
 *
 * Historically this class did its own connect, accountsChanged listening, and
 * sessionStorage rehydration. That logic now lives in /app/services/wallet.js
 * (the single authoritative wallet service for the entire site).
 *
 * This file remains because legacy code in /pages/*.html and other JS modules
 * reads `window.UnifiedWallet.evmAddress`, `window.UnifiedWallet.connectedAddress`,
 * etc. directly. The wallet service writes those fields on every state change
 * via writeLegacyState(). So this object is now a write-only data holder.
 *
 * Anyone wanting to CONNECT or DISCONNECT should call:
 *   import { connect, disconnect } from '/app/services/wallet.js';
 * or, from non-module contexts, the global window.openConnectModal() and
 * disconnectWallet() functions in components/modals.js (which forward here).
 */

class UnifiedWalletConnector {
    constructor() {
        this.evmWallet = null;
        this.activeChain = 'evm';
        this.evmNetwork = 'sepolia';
        this.evmAddress = null;
        this.connectedAddress = null;
    }

    /**
     * Format an address for display: 0xab12…cd34
     */
    formatAddress(address) {
        if (!address) return '';
        return address.substring(0, 6) + '…' + address.substring(address.length - 4);
    }

    isConnected() {
        return this.connectedAddress !== null;
    }

    getStatus() {
        return {
            connected: this.isConnected(),
            chain:     this.activeChain,
            address:   this.connectedAddress,
            formattedAddress: this.formatAddress(this.connectedAddress),
        };
    }

    // saveToStorage is kept as a no-op for compat — the wallet service writes
    // sessionStorage directly via writeLegacyState() now.
    saveToStorage() {
        // no-op (handled by /app/services/wallet.js)
    }

    /**
     * Forward to the authoritative service. Used by old code paths that called
     * window.UnifiedWallet.connect() directly.
     */
    async connect() {
        const svc = await import('/app/services/wallet.js');
        return svc.connect();
    }

    async disconnect() {
        const svc = await import('/app/services/wallet.js');
        return svc.disconnect();
    }

    getActiveWallet() {
        return {
            chain:   this.activeChain,
            address: this.connectedAddress,
            wallet:  this.evmWallet,
        };
    }
}

window.UnifiedWallet = new UnifiedWalletConnector();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = UnifiedWalletConnector;
}
