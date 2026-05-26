/**
 * DexHero Blockchain Providers
 * RPC provider setup, caching, failover logic, proxy wrapper.
 */

const _DexHeroProviders = {

    /**
     * Get a read-only provider for the current network.
     * Uses JSON-RPC (not wallet provider) to avoid rate-limiting on historical queries.
     * Caches per network to avoid redundant eth_chainId calls.
     */
    getReadProvider() {
        const networkKey = this.network || 'sepolia';
        if (this._providerCache && this._providerCache[networkKey]) {
            return this._providerCache[networkKey];
        }

        const network = NETWORKS[networkKey] || NETWORKS.sepolia;
        let rpcUrl = network.rpcUrl;

        if (rpcUrl.startsWith('/')) {
            const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            const baseUrl = isLocal ? 'http://localhost:8000' : window.location.origin;
            rpcUrl = baseUrl + rpcUrl;
        }

        // Pass the known network to JsonRpcProvider so ethers skips the eth_chainId auto-detect call
        const chainId = parseInt(network.chainId, 16);
        const ethNetwork = chainId ? { chainId, name: networkKey } : undefined;
        const jsonProvider = ethNetwork
            ? new window.ethers.providers.JsonRpcProvider(rpcUrl, ethNetwork)
            : new window.ethers.providers.JsonRpcProvider(rpcUrl);

        // Proxy wraps with window.ethereum fallback for getLogs failures
        const proxied = new Proxy(jsonProvider, {
            get(target, prop) {
                if (typeof target[prop] === 'function') {
                    return async (...args) => {
                        try {
                            return await target[prop](...args);
                        } catch (err) {
                            if (window.ethereum) {
                                console.warn(`[ReadProvider] JSON-RPC failed for ${prop}. Falling back to window.ethereum`, err);
                                const fallbackProvider = new window.ethers.providers.Web3Provider(window.ethereum);
                                if (typeof fallbackProvider[prop] === 'function') {
                                    return await fallbackProvider[prop](...args);
                                }
                            }
                            throw err;
                        }
                    };
                }
                return target[prop];
            }
        });

        if (!this._providerCache) this._providerCache = {};
        this._providerCache[networkKey] = proxied;
        return proxied;
    },

    /**
     * Invalidate cached providers (call when switching networks).
     */
    _clearProviderCache() {
        this._providerCache = {};
    },

    /**
     * Query filter with error protection and fallback.
     * Chunks queries when RPC returns range errors (e.g. Alchemy free tier).
     */
    async queryFilterSafe(contract, filter, startBlock, endBlock) {
        const useProvider = contract.provider || this.getReadProvider();
        let toBlock = endBlock;
        if (toBlock === 'latest' || !toBlock) {
            try { toBlock = await useProvider.getBlockNumber(); } catch (e) { toBlock = 'latest'; }
        }

        try {
            return await contract.queryFilter(filter, startBlock, toBlock);
        } catch (e) {
            const msg = (e.message || "").toLowerCase();
            const isRangeError = msg.includes("10 block") || msg.includes("limit") || msg.includes("range") || msg.includes("32600") || msg.includes("unexpected error") || msg.includes("reverted");
            if (isRangeError) {
                let currentEnd = (typeof toBlock === 'number') ? toBlock : await useProvider.getBlockNumber();
                let currentStart = Math.max(startBlock, currentEnd - SEARCH_BUFFER_BLOCKS);

                console.warn(`[SafeQuery] RPC query failed (${startBlock}-${toBlock}). Chunking from ${currentStart} to ${currentEnd} in ${ALCHEMY_CHUNK_SIZE}-block intervals...`, e.message);

                let allLogs = [];
                for (let end = currentEnd; end > currentStart; end -= ALCHEMY_CHUNK_SIZE) {
                    const start = Math.max(currentStart, end - ALCHEMY_CHUNK_SIZE + 1);
                    console.log(`[SafeQuery] Fetching chunk: ${start} to ${end}`);
                    try {
                        const res = await contract.queryFilter(filter, start, end);
                        allLogs = [...allLogs, ...res];
                    } catch (err) {
                        console.error(`[SafeQuery] Chunk failed (${start}-${end}):`, err.message);
                    }
                }

                // Sort by block number
                allLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
                // Deduplicate
                const unique = [];
                const seen = new Set();
                for (const log of allLogs) {
                    const key = `${log.transactionHash}-${log.logIndex}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        unique.push(log);
                    }
                }
                return unique;
            }
            throw e;
        }
    },

    /**
     * Get the active EVM provider (MetaMask, Phantom EVM, or any injected wallet).
     */
    _getEvmProvider() {
        if (window._metaMaskProvider) return window._metaMaskProvider;
        if (window.ethereum && window.ethereum.providers) {
            const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isPhantom);
            if (mm) return mm;
            if (window.ethereum.providers[0]) return window.ethereum.providers[0];
        }
        return window.ethereum;
    }
};
