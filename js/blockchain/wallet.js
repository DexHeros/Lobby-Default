/**
 * DexHero Blockchain Wallet
 * Wallet connection, disconnection, address management, network switching.
 */

const _DexHeroWallet = {

    /**
     * Connect to MetaMask wallet.
     */
    async connectWallet() {
        if (typeof window.ethers === 'undefined') {
            const msg = 'Ethers.js library not loaded. Please check your internet connection or refresh the page.';
            console.error(msg);
            alert(msg);
            throw new Error(msg);
        }

        if (typeof window.ethereum === 'undefined') {
            throw new Error('No EVM wallet found. Please install MetaMask or Phantom.');
        }

        try {
            const accounts = await window.ethereum.request({
                method: 'eth_requestAccounts'
            });

            this.provider = new window.ethers.providers.Web3Provider(window.ethereum);
            this.signer = this.provider.getSigner();
            this.userAddress = accounts[0];

            const network = await this.provider.getNetwork();
            this.updateNetworkState(network.chainId);

            window.ethereum.on('accountsChanged', (accounts) => {
                this.userAddress = accounts[0];
                window.dispatchEvent(new CustomEvent('walletChanged', {
                    detail: { address: this.userAddress }
                }));
            });

            window.ethereum.on('chainChanged', () => {
                window.location.reload();
            });

            return this.userAddress;
        } catch (error) {
            console.error('Wallet connection failed:', error);
            throw error;
        }
    },

    /**
     * Switch to a specific network.
     */
    async switchNetwork(networkName) {
        const evmProvider = window.ethereum;
        if (!evmProvider) throw new Error("No crypto wallet found");

        const networkConfig = NETWORKS[networkName];
        if (!networkConfig) throw new Error(`Network ${networkName} not configured`);

        try {
            const currentChainId = await evmProvider.request({ method: 'eth_chainId' });

            const normalizeId = (id) => {
                if (typeof id === 'string' && id.startsWith('0x')) return parseInt(id, 16);
                return parseInt(id);
            };

            const targetId = normalizeId(networkConfig.chainId);
            const currentId = normalizeId(currentChainId);

            console.log(`Checking network: Current (${currentId}) vs Target (${targetId})`);

            if (currentId === targetId) {
                console.log("Already on correct network");
                this.network = networkName;
                this._clearProviderCache();
                return;
            }

            await evmProvider.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: networkConfig.chainId }],
            });
            this.network = networkName;
            this._clearProviderCache();
        } catch (switchError) {
            if (switchError.code === 4902) {
                await this.addNetwork(networkName);
            } else {
                throw switchError;
            }
        }
    },

    /**
     * Add network to MetaMask.
     */
    async addNetwork(networkName) {
        const evmProvider = window.ethereum;
        const network = NETWORKS[networkName];
        await evmProvider.request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId: network.chainId,
                chainName: network.chainName,
                rpcUrls: [network.rpcUrl],
                blockExplorerUrls: [network.explorerUrl],
                nativeCurrency: network.nativeCurrency
            }]
        });
        this.network = networkName;
    },

    /**
     * Update network state from chain ID.
     * Defaults to the preferred chain (Base mainnet per cost strategy) on
     * unknown chains, not to Sepolia.
     */
    updateNetworkState(chainId) {
        const preferred = (typeof PREFERRED_CHAIN_ID !== 'undefined') ? PREFERRED_CHAIN_ID : 8453;
        this.network = CHAIN_ID_TO_NETWORK[chainId] || CHAIN_ID_TO_NETWORK[preferred] || 'base';
        this._clearProviderCache();
    },

    /**
     * Get contract instances for the current network.
     */
    getContracts() {
        const addresses = CONTRACT_ADDRESSES[this.network];
        return {
            manager: new window.ethers.Contract(addresses.manager, DEXHERO_MANAGER_ABI, this.signer),
            nft: new window.ethers.Contract(addresses.nft, DEXHERO_NFT_ABI, this.signer),
            usdc: new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer)
        };
    }
};
