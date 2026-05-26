/**
 * DexHero Blockchain Integration
 * Connects the UI to EVM smart contracts (Ethereum, BNB, Base, Monad)
 */

// Contract ABIs (simplified - add full ABI when deployed)
// ABI for the Launch Factory
const LAUNCH_FACTORY_V1_ABI = [
    "function createHero(address gameCollector, string tokenName, string tokenSymbol, string nftName, string nftSymbol, uint256 tippingPointUSDC) external returns (address manager, address token, address sbt)",
    "event HeroCreated(address indexed gameCollector, address indexed manager, address indexed token, address sbt, uint256 tippingPointUSDC)",
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"
];

const LAUNCH_FACTORY_V2_ABI = [
    "function createHero(address gameCollector, string tokenName, string tokenSymbol, string nftName, string nftSymbol, uint256 tippingPointUSDC, uint256 mintPriceUSDC, uint256 initialBuyUSDC, bytes32 dexheroCharacterId, uint256 traderSpreadBps, uint256 initialBuySlippageBps) external payable returns (address manager, address token, address sbt, address router)",
    "function createHeroExistingToken(address gameCollector, address existingToken, string nftName, string nftSymbol, uint256 purchasePriceUSDC, uint256 rentalPriceUSDC) external payable returns (address manager, address sbt)",
    "event HeroCreated(address indexed gameCollector, address indexed manager, address indexed token, address sbt, address router, uint256 tippingPointUSDC)",
    "event ExistingHeroCreated(address indexed gameCollector, address indexed manager, address indexed existingToken, address sbt)",
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"
];

const DEXHERO_MANAGER_ABI = [
    //  Read: state 
    "function priceForNextMint() view returns (uint256)",
    "function activePositions() view returns (uint256)",
    "function poolCreated() view returns (bool)",
    "function depositTimestamp(uint256 tokenId) view returns (uint64)",
    "function getContractState() view returns (bool, bool, bool, bool, uint256, uint256, uint256, uint256, uint256, uint256)",
    "function getRentalPrice() view returns (uint256)",
    "function getPurchasePrice() view returns (uint256)",
    "function principalOf(uint256 tokenId) view returns (uint256)",
    "function sbt() view returns (address)",
    "function token() view returns (address)",
    "function unlocked(uint256 tokenId) view returns (bool)",
    "function gameCollector() view returns (address)",
    //  Read: IL pool / coverage (both manager types) 
    "function ilCompensationPool() view returns (uint256)",
    "function coverageRatioBps() view returns (uint256)",
    "function totalFundsCollectedUSDC() view returns (uint256)",
    "function totalPrincipalOwed() view returns (uint256)",
    "function BOOTSTRAP_THRESHOLD() view returns (uint256)",
    //  Read: two-step deposit 
    "function pendingDeposit(address) view returns (uint256)",
    //  Write: two-step deposit flow 
    "function deposit() external",
    "function startPlay() external",
    "function withdrawDeposit() external",
    //  Write: renter actions 
    "function buyDexHero(uint256 quantity) external",
    "function redeem(uint256 tokenId) external",
    "function renewPass(uint256 tokenId) external",
    "function unlockNFT(uint256 tokenId) external",
    "function buyAndUnlockDexHero() external returns (uint256)",
    //  Write: creator price controls (onlyOwnerOrGame) 
    "function setPurchasePrice(uint256 price) external",
    "function setRentalPrice(uint256 price) external",
    "function setLinearPricing(uint256 baseUSDC, uint256 incrementUSDC) external",
    //  Write: IL pool funding (router → IL pool) 
    "function captureSpreadUSDC(uint256 amountUSDC) external",
    //  Events 
    "event SBTMinted(address indexed buyer, uint256 indexed tokenId, uint256 principalUSDC)",
    "event Redeemed(address indexed owner, uint256 tokenId, uint256 refund)",
    "event NFTUnlocked(uint256 indexed tokenId, uint256 cost)",
    "event Bought(address indexed buyer, uint256 count, uint256 costUSDC, uint256 totalFunds)",
    "event PoolCreated(address indexed pool, uint256 tippingPointUSDC, uint160 sqrtPriceX96)",
    "event RentalPriceSet(uint256 price)",
    "event LinearPricingSet(uint256 base, uint256 increment)",
    "event SpreadCaptured(address indexed from, uint256 amountUSDC)",
    "event ILPenaltyAdded(uint256 penaltyUSDC)",
    "event ILShortfallCovered(uint256 shortfallUSDC)"
];

const DEXHERO_NFT_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function unlocked(uint256 tokenId) view returns (bool)"
];

const USDC_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address to, uint256 amount) external returns (bool)"
];

const DEXHEROS_ROUTER_ABI = [
    "function buyTokens(uint256 amountUSDC, uint256 minTokensOut, uint256 checkTokenId) external returns (uint256)",
    "function sellTokens(uint256 amountToken, uint256 minUSDCOut, uint256 checkTokenId) external returns (uint256)",
    "function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)",
    "event Bought(address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 spreadCaptured)",
    "event Sold(address indexed seller, uint256 tokenIn, uint256 usdcOut, uint256 spreadCaptured)"
];

//  Chain & Protocol Constants 
const EVM_BLOCK_TIME_SECONDS = 12;
const BLOCK_SEARCH_BUFFER = 2000;
const UNISWAP_FEE_TIER = 3000;  // 0.3%
const DEFAULT_SLIPPAGE_BPS = 200;  // 2% (legacy reference)
const MAX_AUTO_SLIPPAGE_BPS = 700; // 7% — adaptive slippage cap

/**
 * Calculate adaptive slippage based on price impact.
 * Returns { slippageBps, impactBps, minOut, needsConfirmation }
 */
function calcAdaptiveSlippage(quotedOutput, spotOutput, maxAutoBps = MAX_AUTO_SLIPPAGE_BPS) {
    const MIN_SLIPPAGE_BPS = 50;   // 0.5% floor

    // If we can't calculate impact, use minimum slippage
    if (!spotOutput || spotOutput.isZero() || !quotedOutput || quotedOutput.isZero()) {
        const bps = MIN_SLIPPAGE_BPS;
        const minOut = quotedOutput ? quotedOutput.mul(10000 - bps).div(10000) : quotedOutput;
        return { slippageBps: bps, impactBps: 0, minOut, needsConfirmation: false };
    }

    // Calculate price impact in basis points
    // impactBps = (spotOutput - quotedOutput) / spotOutput * 10000
    let impactBps = 0;
    if (spotOutput.gt(quotedOutput)) {
        impactBps = spotOutput.sub(quotedOutput).mul(10000).div(spotOutput).toNumber();
    }

    // Auto slippage: 0.5% minimum, 2x price impact as buffer
    let slippageBps = Math.max(MIN_SLIPPAGE_BPS, impactBps * 2);
    let needsConfirmation = false;

    if (slippageBps > maxAutoBps) {
        needsConfirmation = true;
        slippageBps = maxAutoBps; // Cap at 7% unless user overrides
    }

    const minOut = quotedOutput.mul(10000 - slippageBps).div(10000);
    return { slippageBps, impactBps, minOut, needsConfirmation };
}

/**
 * Dispatch high-slippage warning event. Returns a promise that resolves to
 * the user's chosen slippage (bps) or null if cancelled.
 * If no listener is registered, auto-approves at the capped slippage.
 */
function notifyHighSlippage(impactBps, suggestedBps, maxAutoBps) {
    return new Promise((resolve) => {
        let settled = false;
        const detail = {
            impactBps,
            suggestedBps,
            maxAutoBps,
            approve: (overrideBps) => { if (!settled) { settled = true; resolve(overrideBps || suggestedBps); } },
            cancel: () => { if (!settled) { settled = true; resolve(null); } }
        };
        const event = new CustomEvent('dexhero:high-slippage', { detail });
        window.dispatchEvent(event);

        // If no listener called approve/cancel within 100ms, auto-approve at max
        setTimeout(() => { if (!settled) { settled = true; resolve(maxAutoBps); } }, 100);
    });
}

// Network configurations
const NETWORKS = {
    ethereum: {
        chainId: '0x1', // 1 - Mainnet
        chainName: 'Ethereum Mainnet',
        rpcUrl: '/api/rpc?network=ethereum',
        explorerUrl: 'https://etherscan.io',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
    },
    sepolia: {
        chainId: '0xaa36a7', // 11155111 - Sepolia Testnet
        chainName: 'Sepolia Testnet',
        rpcUrl: '/api/rpc?network=sepolia', // Proxied through server — API key stays server-side
        explorerUrl: 'https://sepolia.etherscan.io',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
    },
    bnb: {
        chainId: '0x38', // 56 - BSC Mainnet
        chainName: 'BNB Smart Chain',
        rpcUrl: 'https://bsc-dataseed1.binance.org',
        explorerUrl: 'https://bscscan.com',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }
    },
    bscTestnet: {
        chainId: '0x61', // 97 - BSC Testnet
        chainName: 'BNB Smart Chain Testnet',
        rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
        explorerUrl: 'https://testnet.bscscan.com',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }
    },
    base: {
        chainId: '0x2105', // 8453 - Base Mainnet
        chainName: 'Base',
        rpcUrl: '/api/rpc?network=base',
        explorerUrl: 'https://basescan.org',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
    },
    baseSepolia: {
        chainId: '0x14a34', // 84532 - Base Sepolia
        chainName: 'Base Sepolia',
        rpcUrl: 'https://sepolia.base.org',
        explorerUrl: 'https://sepolia.basescan.org',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
    }
};

// Contract addresses (UPDATE THESE AFTER DEPLOYMENT)
// Contract addresses (Normalized to prevent checksum errors)
const CONTRACT_ADDRESSES = {
    sepolia: {
        // Templates — deployed 2026-04-06 via deploy_v2_launchpad.js
        manager: '0x9A9C7A0f83d303FeBbD8552B49F841F42e10Cfd4',
        nft: '0x3B9cBea461597D3554D6721Ec78dF8d7B3BcDa1b',
        usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        token: '0x9BbaD164bE061B6f8531EA968A605AFd11feac2F',
        launchFactory: '0x522a2ac9aC1d74F88366edb12d7bC93641f55e8d',
        router: '0x9706234cf110146CE2f22252F7680Da8a5FfEeEb',
        positionManager: '0x1238536071e1c677a632429e3655c799b22cda52',
        weth: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
        uniswapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48', // Uniswap SwapRouter02
        uniswapQuoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Uniswap QuoterV2
        platformPlayPass: '0x0f30d05b8c284dfd975113ee60ebe360eb380fc4',
        crossChainAttestor: '0xcb466d0ea6c592c6620351467a15d86e19a269bf',
        treasury: ''
    },
    ethereum: {
        usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        uniswapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap SwapRouter02
        uniswapQuoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'  // Uniswap QuoterV2
    },
    bscTestnet: {
        usdc: '0x64544969ed7ebf5f083679233325356ebe738930',
        treasury: ''
    },
    baseSepolia: {
        usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        launchFactory: '0x67f584e1b4479B62A7809b9e4e498bcE4Fa4F648',
        treasury: ''
    }
};

//  Load treasury + other public config from server (.env) 
// The treasury address is stored in .env (TREASURY_ADDRESS) and exposed via
// /api/config. This keeps it out of committed source code.
async function loadServerConfig() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        if (cfg.treasury) {
            const t = cfg.treasury;
            // Inject into every network that has a treasury slot
            Object.keys(CONTRACT_ADDRESSES).forEach(net => {
                if ('treasury' in CONTRACT_ADDRESSES[net]) {
                    CONTRACT_ADDRESSES[net].treasury = t;
                }
            });
            console.log(` Treasury loaded from server config: ${t}`);
        } else {
            console.warn('  /api/config did not return a treasury address. Fee transfers may fail.');
        }
    } catch (e) {
        console.error(' Could not load server config. Treasury address may be empty.', e.message);
    }
}
// Run immediately — scripts load before the user can initiate any transaction
loadServerConfig();

// Pick the correct injected EVM provider based on the `walletType` recorded by
// the shared connect modal. Needed because when both MetaMask and Phantom are
// installed, `window.ethereum` can point at whichever one hijacked the global,
// which may not match what the user picked in the modal.
function pickInjectedBySessionType() {
    if (!window.ethereum) return null;
    const list = (window.ethereum.providers && window.ethereum.providers.length)
        ? window.ethereum.providers
        : [window.ethereum];
    let type = null;
    try { type = sessionStorage.getItem('walletType'); } catch {}
    if (type === 'phantom') return list.find(p => p.isPhantom) || window.ethereum;
    if (type === 'metamask') return list.find(p => p.isMetaMask && !p.isPhantom) || window.ethereum;
    return list[0] || window.ethereum;
}

class DexHeroBlockchain {

    constructor() {
        this.provider = null;
        this.signer = null;
        // Default to the preferred chain (Base mainnet = 8453 per cost strategy).
        // PREFERRED_CHAIN_ID comes from constants.js; falls back to 'base' if constants
        // loaded out of order or set to baseSepolia for staging.
        const pref = (typeof PREFERRED_CHAIN_ID !== 'undefined') ? PREFERRED_CHAIN_ID : 8453;
        this.network = (typeof CHAIN_ID_TO_NETWORK !== 'undefined' && CHAIN_ID_TO_NETWORK[pref]) || 'base';
        this.contracts = {};
        this.userAddress = null;
        this._heroCache = {}; // Cache for HeroDetails to prevent redundant scans
    }

    /**
     * Helper to validate if an address is potentially an EVM address
     * @param {string} address 
     */
    isEvmAddress(address) {
        if (!address || typeof address !== 'string') return false;
        // Simple 0x check + length
        return address.startsWith('0x') && address.length === 42;
    }

    /**
     * Connect a wallet. Forwards to the authoritative wallet service in
     * /app/services/wallet.js — DO NOT add connect logic here. The service
     * handles EIP-6963 discovery, EIP-1193 events, EIP-2255 disconnect, and
     * the legacy compat write-through that populates `this.provider`,
     * `this.signer`, and `this.userAddress` automatically on connect.
     */
    async connectWallet() {
        // Open the picker modal (works whether we're in the SPA shell, an
        // iframe, or a legacy page — modals.js openConnectModal() is global).
        const opener = (window.top && typeof window.top.openConnectModal === 'function')
            ? window.top.openConnectModal
            : (typeof window.openConnectModal === 'function' ? window.openConnectModal : null);

        if (!opener) {
            // Last-ditch fallback for very old contexts: try direct service import
            try {
                const svc = await import('/app/services/wallet.js');
                await svc.connect();
            } catch (err) {
                throw new Error('No wallet connect modal available: ' + err.message);
            }
        } else {
            // Open modal + wait for the wallet service to finish (it fires
            // 'walletChanged' on window once state is settled).
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    window.removeEventListener('walletChanged', onChange);
                    reject(new Error('Wallet connect timed out (90s)'));
                }, 90_000);
                function onChange() {
                    const addr = sessionStorage.getItem('walletAddress');
                    if (sessionStorage.getItem('walletConnected') === 'true' && addr) {
                        clearTimeout(timer);
                        window.removeEventListener('walletChanged', onChange);
                        resolve(addr);
                    }
                }
                window.addEventListener('walletChanged', onChange);
                try { opener(); }
                catch (err) { clearTimeout(timer); window.removeEventListener('walletChanged', onChange); reject(err); }
            });
        }

        // The wallet service has now populated window.DexHeroBlockchain
        // (via writeLegacyState). Pull from there so this instance picks up
        // the same provider/signer the rest of the site is using.
        if (window.DexHeroBlockchain && window.DexHeroBlockchain !== this) {
            this.provider    = window.DexHeroBlockchain.provider;
            this.signer      = window.DexHeroBlockchain.signer;
            this.userAddress = window.DexHeroBlockchain.userAddress;
        } else {
            // We ARE window.DexHeroBlockchain — the service wrote directly to
            // our fields. Just re-derive network state.
            try {
                if (this.provider) {
                    const network = await this.provider.getNetwork();
                    this.updateNetworkState(network.chainId);
                }
            } catch { /* non-fatal */ }
        }
        return this.userAddress;
    }

    /**
     * Get the active EVM provider (MetaMask, Phantom EVM, or any injected wallet)
     */
    _getEvmProvider() {
        if (window._metaMaskProvider) return window._metaMaskProvider;
        if (window.ethereum && window.ethereum.providers) {
            // Prefer MetaMask if both are installed, otherwise take the first available
            const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isPhantom);
            if (mm) return mm;
            if (window.ethereum.providers[0]) return window.ethereum.providers[0];
        }
        return window.ethereum;
    }

    /**
     * Switch to a specific network
     */
    async switchNetwork(networkName) {
        const evmProvider = window.ethereum;
        if (!evmProvider) throw new Error("No crypto wallet found");

        const networkConfig = NETWORKS[networkName];
        if (!networkConfig) throw new Error(`Network ${networkName} not configured`);

        try {
            // Check current chain ID first
            const currentChainId = await evmProvider.request({ method: 'eth_chainId' });

            // Normalize chainIDs for comparison (handle hex vs decimal, string vs number)
            const normalizeId = (id) => {
                if (typeof id === 'string' && id.startsWith('0x')) return parseInt(id, 16);
                return parseInt(id);
            };

            const targetId = normalizeId(networkConfig.chainId);
            const currentId = normalizeId(currentChainId);

            console.log(`Checking network: Current (${currentId}) vs Target (${targetId})`);

            if (currentId === targetId) {
                console.log("Already on correct network");
                this.network = networkName; // Update internal state even if no switch was needed
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
            // Network not added to MetaMask
            if (switchError.code === 4902) {
                await this.addNetwork(networkName);
            } else {
                throw switchError;
            }
        }
    }

    /**
     * Add network to MetaMask
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
    }

    /**
     * Update network state
     */
    updateNetworkState(chainId) {
        const networkMap = {
            1: 'ethereum',
            11155111: 'sepolia',
            56: 'bnb',
            97: 'bscTestnet',
            8453: 'base',
            84532: 'baseSepolia'
        };
        this.network = networkMap[chainId] || 'sepolia';
        this._clearProviderCache(); // New network → invalidate cached providers
    }

    /**
     * Get contract instances
     */
    getContracts() {
        const addresses = CONTRACT_ADDRESSES[this.network];

        return {
            manager: new window.ethers.Contract(addresses.manager, DEXHERO_MANAGER_ABI, this.signer),
            nft: new window.ethers.Contract(addresses.nft, DEXHERO_NFT_ABI, this.signer),
            usdc: new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer)
        };
    }

    /**
     * Get current rental price
     */
    async getCurrentPrice() {
        const contracts = this.getContracts();
        const priceWei = await contracts.manager.priceForNextMint();
        // Convert from 6 decimals (USDC) to human readable
        return window.ethers.utils.formatUnits(priceWei, 6);
    }

    /**
     * Get active positions (current renters)
     */
    async getActivePositions() {
        const contracts = this.getContracts();
        const count = await contracts.manager.activePositions();
        return count.toNumber();
    }

    /**
     * Get contract state
     */
    async getContractState() {
        const contracts = this.getContracts();
        const state = await contracts.manager.getContractState();

        return {
            poolCreated: state[0],
            tradingEnabled: state[1],
            transfersEnabled: state[2],
            paused: state[3],
            totalFundsCollected: window.ethers.utils.formatUnits(state[4], 6),
            nextTokenId: state[5].toNumber(),
            currentMintPrice: window.ethers.utils.formatUnits(state[6], 6),
            ilCompensationPool: window.ethers.utils.formatUnits(state[7], 6),
            protocolFeePool: window.ethers.utils.formatUnits(state[8], 6),
            tippingPoint: window.ethers.utils.formatUnits(state[9], 6)
        };
    }

    /**
     * Get a read-only provider for the current network
     */

    /**
     * Query filter with error protection and fallback
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
                let currentStart = Math.max(startBlock, currentEnd - BLOCK_SEARCH_BUFFER); // Max BLOCK_SEARCH_BUFFER blocks history

                console.warn(`[SafeQuery] RPC query failed (${startBlock}-${toBlock}). Chunking from ${currentStart} to ${currentEnd} in 9-block intervals...`, e.message);

                let allLogs = [];
                // Fetch in chunks of 9 blocks (Alchemy free tier limit is 10)
                const chunkSize = 9;
                for (let end = currentEnd; end > currentStart; end -= chunkSize) {
                    const start = Math.max(currentStart, end - chunkSize + 1);
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
    }

    /**
     * Internal helper to get a provider for read-only operations.
     */
    getReadProvider() {
        // For background read operations (like charting), ALWAYS use a public JSON-RPC provider
        // instead of the wallet's Web3Provider. Wallet providers (MetaMask, Phantom) often block
        // or aggressively rate-limit large historical eth_getLogs queries leading to empty charts.
        //
        // CACHING: Re-use provider instances per network. Creating a new JsonRpcProvider fires
        // eth_chainId on every construction — with 2s polling this creates a storm of chainId calls.
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
    }

    // Call this when switching networks so the cached provider is invalidated
    _clearProviderCache() {
        this._providerCache = {};
    }

    /**
     * Get V2 Router & Details
     * @param creationTime (optional) - ISO string or timestamp of token creation to optimize log search
     */
    async getHeroDetails(managerAddress, provider = null, creationTime = null) {
        if (!managerAddress || !this.isEvmAddress(managerAddress)) return null;

        const cacheKey = managerAddress.toLowerCase();
        if (this._heroCache[cacheKey]) {
            // Return cached version if less than 5 minutes old
            if (Date.now() - (this._heroCache[cacheKey]._timestamp || 0) < 300000) {
                return this._heroCache[cacheKey];
            }
        }

        // Deduplicate concurrent calls — if a fetch is already in-flight, return that same promise
        if (!this._heroPending) this._heroPending = {};
        if (this._heroPending[cacheKey]) return this._heroPending[cacheKey];
        this._heroPending[cacheKey] = this._doGetHeroDetails(managerAddress, provider, creationTime)
            .finally(() => { delete this._heroPending[cacheKey]; });
        return this._heroPending[cacheKey];
    }

    async _doGetHeroDetails(managerAddress, provider = null, creationTime = null) {
        const cacheKey = managerAddress.toLowerCase();

        const addresses = CONTRACT_ADDRESSES[this.network] || CONTRACT_ADDRESSES.sepolia;
        const launchFactoryAddress = addresses ? addresses.launchFactory : null;
        const useProvider = provider || this.getReadProvider();

        if (!useProvider || !launchFactoryAddress) return null;

        // Non-EVM addresses can't be managers
        if (!this.isEvmAddress(managerAddress)) {
            return null;
        }

        const factory = new window.ethers.Contract(launchFactoryAddress, LAUNCH_FACTORY_V2_ABI, useProvider);
        // if we fail to discover a router address. In that case we fall back to
        // scanning factory events so V2 heroes still get their router populated.
        let fastResult = null;

        try {
            // 0. FAST PATH: Probe the Manager contract directly for core state
            try {
                const manager = new window.ethers.Contract(managerAddress, [
                    "function dexheroToken() view returns (address)",
                    "function existingToken() view returns (address)",
                    "function sbt() view returns (address)",
                    "function v3Pool() view returns (address)",
                    "function poolCreated() view returns (bool)"
                ], useProvider);

                // Detection results
                let tokenAddr = null;
                let isExisting = false;
                let poolCreated = false;
                let sbtAddr = null;
                let poolAddr = null;
                // V2 managers don't expose a router() getter — router is discovered via factory events below
                let routerAddr = null;

                try {
                    tokenAddr = await manager.dexheroToken();
                } catch (e) {
                    // Might be an existing token manager
                    try {
                        tokenAddr = await manager.existingToken();
                        isExisting = true;
                    } catch (e2) { /* not a known manager type */ }
                }

                sbtAddr = await manager.sbt().catch(() => null);
                poolAddr = await manager.v3Pool().catch(() => null);
                poolCreated = await manager.poolCreated().catch(() => isExisting); // existing is effectively always "created"

                if (tokenAddr && tokenAddr !== window.ethers.constants.AddressZero) {
                    fastResult = {
                        isV2: true,
                        isExisting: isExisting,
                        poolCreated: poolCreated,
                        token: tokenAddr,
                        router: routerAddr,
                        sbt: sbtAddr,
                        manager: managerAddress,
                        v3Pool: poolAddr,
                        _timestamp: Date.now()
                    };

                    // If we already discovered a non-zero router address, we can
                    // safely return immediately. Otherwise, fall through to the
                    // factory event scan to try to recover the router.
                    if (routerAddr && routerAddr !== window.ethers.constants.AddressZero) {
                        fastResult._timestamp = Date.now();
                        this._heroCache[cacheKey] = fastResult;
                        return fastResult;
                    }
                }
            } catch (e) {
                // Fast path failed; fall back to factory event scan below.
            }

            // 1. Try lookup by Manager Address via Factory HeroCreated events
            let filter = factory.filters.HeroCreated(null, managerAddress);
            const currentBlock = await useProvider.getBlockNumber();
            let startSearch = Math.max(0, currentBlock - 20000); // Reduce from 500k to 20k to prevent RPC limit timeout on fallback

            if (creationTime) {
                const now = Date.now();
                const createdAt = new Date(creationTime).getTime();
                const ageSeconds = (now - createdAt) / 1000;
                const blocksAgo = Math.floor(ageSeconds / EVM_BLOCK_TIME_SECONDS);
                const estimatedBlock = currentBlock - blocksAgo;
                const windowSize = 5000;
                const searchEnd = Math.min(currentBlock, estimatedBlock + windowSize);
                startSearch = Math.max(0, estimatedBlock - windowSize);

                try {
                    const events = await this.queryFilterSafe(factory, filter, startSearch, searchEnd);
                    if (events.length > 0) {
                        const args = events[0].args;
                        const result = {
                            isV2: true,
                            router: args.router,
                            token: args.token,
                            manager: args.manager,
                            sbt: args.sbt,
                            _timestamp: Date.now()
                        };
                        this._heroCache[cacheKey] = result;
                        return result;
                    }
                } catch (smartScanErr) { console.warn('[DexHero] Non-critical error:', smartScanErr.message); }
            }

            let events = [];
            try {
                events = await this.queryFilterSafe(factory, filter, startSearch, 'latest');
            } catch (e) { console.warn('[DexHero] Non-critical error:', e.message); }

            if (events.length === 0) {
                filter = factory.filters.HeroCreated(null, null, managerAddress);
                try {
                    events = await this.queryFilterSafe(factory, filter, startSearch, 'latest');
                } catch (e) { console.warn('[DexHero] Non-critical error:', e.message); }
            }

            if (events.length > 0) {
                const log = events[0];
                const result = {
                    router: log.args.router,
                    token: log.args.token,
                    sbt: log.args.sbt,
                    manager: managerAddress,
                    isV2: true,
                    _timestamp: Date.now()
                };
                this._heroCache[cacheKey] = result;
                return result;
            }
        } catch (e) { console.warn('[DexHero] Non-critical error:', e.message); }

        // If factory scans failed but the manager probe succeeded, return the
        // best-effort V2 details (may have a null router for truly router-less
        // managers, in which case trade history will correctly fall back).
        if (fastResult) {
            this._heroCache[cacheKey] = fastResult;
            return fastResult;
        }

        const failResult = { isV2: false, _timestamp: Date.now() };
        this._heroCache[cacheKey] = failResult;
        return failResult;
    }

    /**
     * Buy DexHero Tokens (technically mints SBTs or Swap via Router)
     * @param {number} quantity - Number of units to buy
     * @param {string} contractAddress - Token Manager Contract Address
     */
    async buyToken(quantity, contractAddress) {
        console.log(`buyToken called: Qty=${quantity}, Address=${contractAddress}`);
        console.log(`Current Network: ${this.network}, Chain ID: ${await this.signer.getChainId()}`);
        if (!contractAddress) throw new Error("Contract address required");

        let targetContractAddress = contractAddress;
        const contracts = this.getContracts();
        const manager = new window.ethers.Contract(targetContractAddress, DEXHERO_MANAGER_ABI, this.signer);

        // Check for Router (V2)
        const heroDetails = await this.getHeroDetails(targetContractAddress);
        const isV2 = heroDetails && heroDetails.isV2;
        const routerAddr = isV2 ? heroDetails.router : null;

        // 0. Enforce Single Token Limit ONLY for V1
        if (!isV2 && quantity > 1) {
            throw new Error("Batch buying is currently disabled for legacy tokens. Please buy 1 token at a time.");
        }

        // STRICT MODE: No recovery or scanning. 
        try {
            console.log("Debug: Verifying Manager contract...");
            await manager.sbt();
            console.log("Debug: Verified valid Manager.");
        } catch (e) {
            console.error("Critical Error: Provided address is not a valid Manager.", e);
            throw new Error("Security Alert: Invalid Manager Contract. Transaction aborted.");
        }

        // Get price
        console.log("Calling priceForNextMint on:", targetContractAddress);
        // Note: For V2, priceForNextMint is still the reference for "1 Unit"
        const pricePerToken = await manager.priceForNextMint();
        console.log("Price per token (Wei):", pricePerToken.toString());

        // Total Cost
        const price = pricePerToken.mul(quantity);
        console.log("Total Price (Wei):", price.toString());

        // Check USDC balance
        const balance = await contracts.usdc.balanceOf(this.userAddress);
        const decimals = await contracts.usdc.decimals();
        console.log(`Debug USDC: Address=${contracts.usdc.address}, User=${this.userAddress}`);
        console.log(`Debug USDC: Balance=${balance.toString()} (${window.ethers.utils.formatUnits(balance, decimals)})`);
        console.log(`Debug USDC: Required=${price.toString()} (${window.ethers.utils.formatUnits(price, decimals)})`);

        if (balance.lt(price)) {
            throw new Error(`Insufficient USDC balance. Have ${window.ethers.utils.formatUnits(balance, decimals)}, Need ${window.ethers.utils.formatUnits(price, decimals)}`);
        }

        if (isV2) {
            // V2: Buy directly via per-token Router
            // NOTE: Universal Router at CONTRACT_ADDRESSES is non-functional on Sepolia
            // (tx succeeds with 0 logs/0 transfers). Using direct Router until redeployed.
            console.log(" V2 Mode: Buying via Direct Router:", routerAddr);
            const routerABI = [
                "function buyTokens(uint256 amountUSDC, uint256 minTokensOut, uint256 checkTokenId) external returns (uint256)",
                "function buyTokensDirect(uint256 amountUSDC, uint256 minTokensOut, uint256 checkTokenId) external returns (uint256)",
                "function DIRECT_TRANSFER_ENABLED() view returns (bool)"
            ];
            const router = new window.ethers.Contract(routerAddr, routerABI, this.signer);

            // 1. Detect whether the router supports direct transfer (no approval needed)
            let supportsDirectTransfer = false;
            try {
                const routerRead = new window.ethers.Contract(routerAddr, routerABI, this.getReadProvider());
                supportsDirectTransfer = await routerRead.DIRECT_TRANSFER_ENABLED();
            } catch (_) { /* old router — falls back to approve */ }

            if (!supportsDirectTransfer) {
                // Legacy router: approve MaxUint256 once so the spending cap only ever shows once
                const MAX = window.ethers.constants.MaxUint256;
                const allowance = await contracts.usdc.allowance(this.userAddress, routerAddr);
                if (allowance.lt(price)) {
                    console.log("[Buy] Approving Router (MaxUint256 — one-time)...");
                    const approveTx = await contracts.usdc.approve(routerAddr, MAX);
                    await approveTx.wait();
                }
            }

            // 2. Quote expected output and apply adaptive slippage
            const quoteABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
            const routerQuoter = new window.ethers.Contract(routerAddr, quoteABI, this.getReadProvider());
            let finalMinTokensOut = 0;
            try {
                const expectedOut = await routerQuoter.quoteBuyTokens(price);

                // Get spot price for impact calculation
                let spotOutput;
                try {
                    const managerForSpot = new window.ethers.Contract(targetContractAddress, [
                        "function getTokenPrice() view returns (uint256)"
                    ], this.getReadProvider());
                    const spotPrice = await managerForSpot.getTokenPrice();
                    if (spotPrice && spotPrice.gt(0)) {
                        spotOutput = price.mul(window.ethers.utils.parseEther('1')).div(spotPrice);
                    }
                } catch (e) { console.warn('[DexHero] Spot price fetch failed:', e.message); }

                const { slippageBps, impactBps, minOut, needsConfirmation } = calcAdaptiveSlippage(expectedOut, spotOutput);
                finalMinTokensOut = minOut;
                console.log(`Adaptive slippage: ${slippageBps}bps (impact=${impactBps}bps), minTokensOut=${finalMinTokensOut.toString()}`);

                if (needsConfirmation) {
                    const userBps = await notifyHighSlippage(impactBps, Math.min(impactBps * 2, 5000), MAX_AUTO_SLIPPAGE_BPS);
                    if (userBps === null) throw new Error('Transaction cancelled by user: high price impact');
                    finalMinTokensOut = expectedOut.mul(10000 - userBps).div(10000);
                }
            } catch (e) {
                if (e.message && e.message.includes('cancelled by user')) throw e;
                console.warn("Quote failed, proceeding without slippage protection:", e.message);
            }

            // 3. Buy — use direct transfer if router supports it (no spending cap dialog)
            let tx;
            if (supportsDirectTransfer) {
                console.log("[Buy] Using direct transfer (no approval)...");
                const transferTx = await contracts.usdc.transfer(routerAddr, price);
                await transferTx.wait();
                tx = await router.buyTokensDirect(price, finalMinTokensOut, 0);
            } else {
                tx = await router.buyTokens(price, finalMinTokensOut, 0);
            }
            console.log("Buy Transaction sent:", tx.hash);
            const receipt = await tx.wait();
            console.log("Buy confirmed  Gas used:", receipt.gasUsed.toString());
            return {
                success: true,
                transactionHash: receipt.transactionHash
            };


        } else {
            // V1: Buy via Manager (Mint SBT)
            console.log("V1 Mode: Buying via Manager");

            // 1. Approve Manager (exact amount)
            const allowance = await contracts.usdc.allowance(this.userAddress, targetContractAddress);
            if (allowance.lt(price)) {
                console.log("Approving Manager for exact amount...");
                const approveTx = await contracts.usdc.approve(targetContractAddress, price);
                await approveTx.wait();
                console.log("Manager Approved");
            }

            // 2. Buy
            const tx = await manager.buyDexHero(quantity);
            console.log("Buy Transaction sent:", tx.hash);
            const receipt = await tx.wait();

            // Parse event
            const event = receipt.events.find(e => e.event === 'SBTMinted');
            const tokenId = event ? event.args.tokenId.toNumber() : 0;

            return {
                success: true,
                tokenId,
                transactionHash: receipt.transactionHash,
                price: window.ethers.utils.formatUnits(price, 6)
            };
        }
    }

    /**
     * Withdraw/Redeem Deposit for a DexHero
     * @param {string} managerAddress 
     * @param {number} tokenId 
     */
    async redeemDexHero(managerAddress, tokenId) {
        if (!managerAddress || !tokenId) throw new Error("Missing tokenId or managerAddress");

        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);

            console.log(`Redeeming NFT ${tokenId} on manager ${managerAddress}...`);
            const tx = await manager.redeem(tokenId);
            const receipt = await tx.wait();

            console.log("Redeem confirmed ");
            return {
                success: true,
                transactionHash: receipt.transactionHash
            };
        } catch (e) {
            console.error("Redeem failed:", e);
            throw e;
        }
    }

    /**
     * Renew Pass for a DexHero
     * @param {string} managerAddress 
     * @param {number} tokenId 
     */
    async renewPass(managerAddress, tokenId) {
        if (!managerAddress || !tokenId) throw new Error("Missing tokenId or managerAddress");

        try {
            const readProvider = this.getReadProvider();
            const managerRead = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
            const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);

            const addresses = CONTRACT_ADDRESSES[this.network];
            const usdcWrite = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);

            const currentPrincipal = await managerRead.principalOf(tokenId);
            const currentCost = await managerRead.priceForNextMint();

            if (currentCost.gt(currentPrincipal)) {
                const difference = currentCost.sub(currentPrincipal);
                console.log(`Sending ${window.ethers.utils.formatUnits(difference, 6)} USDC for renewal...`);
                const transferTx = await usdcWrite.transfer(managerAddress, difference);
                await transferTx.wait();
            }

            console.log(`Renewing NFT ${tokenId} on manager ${managerAddress}...`);
            const tx = await managerWrite.renewPass(tokenId);
            const receipt = await tx.wait();

            console.log("Renew confirmed ");
            return {
                success: true,
                transactionHash: receipt.transactionHash
            };
        } catch (e) {
            console.error("Renew failed:", e);
            throw e;
        }
    }

    /**
     * Buy V2 Tokens specifying exact USDC amount (Swap)
     */
    async buyWithUSDC(amountUSDC, contractAddress, knownRouter = null) {
        if (!contractAddress) throw new Error("Contract address required");

        let routerAddr = knownRouter;
        if (!routerAddr) {
            const heroDetails = await this.getHeroDetails(contractAddress);
            if (!heroDetails || !heroDetails.isV2 || !heroDetails.router) {
                throw new Error("buyWithUSDC only supported for V2 tokens with Router");
            }
            routerAddr = heroDetails.router;
        }
        const routerABI = ["function buyTokens(uint256 amountUSDC, uint256 minTokensOut, uint256 checkTokenId) external returns (uint256)"];
        const router = new window.ethers.Contract(routerAddr, routerABI, this.signer);
        const usdc = new window.ethers.Contract(CONTRACT_ADDRESSES[this.network].usdc, USDC_ABI, this.signer);

        const amountWei = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);

        // Check Balance
        const balance = await usdc.balanceOf(this.userAddress);
        if (balance.lt(amountWei)) {
            throw new Error(`Insufficient USDC balance.`);
        }

        // Approve (exact amount)
        const allowance = await usdc.allowance(this.userAddress, routerAddr);
        if (allowance.lt(amountWei)) {
            console.log("Approving Router for exact amount...");
            const approveTx = await usdc.approve(routerAddr, amountWei);
            await approveTx.wait();
        }

        // Quote expected output and apply adaptive slippage
        const quoteABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
        const routerQuoter = new window.ethers.Contract(routerAddr, quoteABI, this.getReadProvider());
        let finalMinTokensOut = 0;
        try {
            const expectedOut = await routerQuoter.quoteBuyTokens(amountWei);

            // Get spot price for impact calculation
            let spotOutput;
            try {
                const managerForSpot = new window.ethers.Contract(contractAddress, [
                    "function getTokenPrice() view returns (uint256)"
                ], this.getReadProvider());
                const spotPrice = await managerForSpot.getTokenPrice();
                if (spotPrice && spotPrice.gt(0)) {
                    spotOutput = amountWei.mul(window.ethers.utils.parseEther('1')).div(spotPrice);
                }
            } catch (e) { console.warn('[DexHero] Spot price fetch failed:', e.message); }

            const { slippageBps, impactBps, minOut, needsConfirmation } = calcAdaptiveSlippage(expectedOut, spotOutput);
            finalMinTokensOut = minOut;
            console.log(`Adaptive slippage: ${slippageBps}bps (impact=${impactBps}bps), minTokensOut=${finalMinTokensOut.toString()}`);

            if (needsConfirmation) {
                const userBps = await notifyHighSlippage(impactBps, Math.min(impactBps * 2, 5000), MAX_AUTO_SLIPPAGE_BPS);
                if (userBps === null) throw new Error('Transaction cancelled by user: high price impact');
                finalMinTokensOut = expectedOut.mul(10000 - userBps).div(10000);
            }
        } catch (e) {
            if (e.message && e.message.includes('cancelled by user')) throw e;
            console.warn("Quote failed, proceeding without slippage protection:", e.message);
        }

        console.log(`Buying with ${amountUSDC} USDC via Router ${routerAddr}`);
        const tx = await router.buyTokens(amountWei, finalMinTokensOut, 0);
        console.log("Tx sent:", tx.hash);
        const receipt = await tx.wait();

        // Parse tokensOut from the Bought event
        let tokensReceived = 0;
        let actualPrice = amountUSDC;
        try {
            const routerWithEvents = new window.ethers.Contract(routerAddr, DEXHEROS_ROUTER_ABI, this.signer);
            const boughtEvent = receipt.logs
                .map(log => { try { return routerWithEvents.interface.parseLog(log); } catch { return null; } })
                .find(e => e?.name === 'Bought');
            if (boughtEvent) {
                tokensReceived = parseFloat(window.ethers.utils.formatUnits(boughtEvent.args.tokensOut, 18));
                if (tokensReceived > 0) actualPrice = amountUSDC / tokensReceived;
            }
        } catch (e) { console.warn('[DexHero]', e.message); }

        return {
            success: true,
            transactionHash: receipt.transactionHash,
            tokensReceived,
            actualPrice
        };
    }

    /**
     * Quote a Uniswap V3 swap (USDC→Token or Token→USDC) without sending a tx.
     * Returns estimated output amount as a human-readable float.
     */
    async quoteUniswapSwap(tokenAddress, amountIn, direction = 'buy') {
        const addresses = CONTRACT_ADDRESSES[this.network] || CONTRACT_ADDRESSES.sepolia;
        if (!addresses.uniswapQuoter) throw new Error('Uniswap quoter not configured for this network');

        const quoterABI = [
            'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
        ];
        const quoter = new window.ethers.Contract(addresses.uniswapQuoter, quoterABI, this.getReadProvider());

        const usdcAddr = addresses.usdc;
        const fee = UNISWAP_FEE_TIER; // 0.3% pool — most common for volatile pairs

        const tokenIn  = direction === 'buy' ? usdcAddr  : tokenAddress;
        const tokenOut = direction === 'buy' ? tokenAddress : usdcAddr;
        const inDecimals  = direction === 'buy' ? 6 : 18;
        const outDecimals = direction === 'buy' ? 18 : 6;

        const amountInWei = window.ethers.utils.parseUnits(amountIn.toString(), inDecimals);

        try {
            const [amountOut] = await quoter.callStatic.quoteExactInputSingle({
                tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0
            });
            return parseFloat(window.ethers.utils.formatUnits(amountOut, outDecimals));
        } catch (e) {
            console.warn('[Uniswap] Quote failed (pool may not exist):', e.message);
            return null;
        }
    }

    /**
     * Execute a Uniswap V3 swap for existing/graduated tokens.
     * direction='buy'  → spend amountUSDC, receive tokenAddress tokens
     * direction='sell' → spend amountToken tokenAddress tokens, receive USDC
     */
    async uniswapSwap(tokenAddress, amount, direction = 'buy') {
        const addresses = CONTRACT_ADDRESSES[this.network] || CONTRACT_ADDRESSES.sepolia;
        if (!addresses.uniswapRouter) throw new Error('Uniswap router not configured for this network');

        const routerABI = [
            'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
        ];
        const router = new window.ethers.Contract(addresses.uniswapRouter, routerABI, this.signer);
        const usdcAddr = addresses.usdc;
        const fee = UNISWAP_FEE_TIER;

        const tokenIn  = direction === 'buy' ? usdcAddr  : tokenAddress;
        const tokenOut = direction === 'buy' ? tokenAddress : usdcAddr;
        const inDecimals  = direction === 'buy' ? 6 : 18;

        const amountInWei = window.ethers.utils.parseUnits(amount.toString(), inDecimals);

        // Approve router (exact amount)
        const tokenInContract = new window.ethers.Contract(tokenIn, USDC_ABI, this.signer);
        const allowance = await tokenInContract.allowance(this.userAddress, addresses.uniswapRouter);
        if (allowance.lt(amountInWei)) {
            console.log('[Uniswap] Approving router for exact amount...');
            const approveTx = await tokenInContract.approve(addresses.uniswapRouter, amountInWei);
            await approveTx.wait();
        }

        // Quote expected output and apply adaptive slippage
        let amountOutMin = 0;
        try {
            const quoterABI = [
                'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
            ];
            const quoter = new window.ethers.Contract(addresses.uniswapQuoter, quoterABI, this.getReadProvider());
            const [expectedOut] = await quoter.callStatic.quoteExactInputSingle({
                tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0
            });

            // Get spot price via 1-unit quote for impact calculation
            let spotOutput;
            try {
                const oneUnit = window.ethers.utils.parseUnits('1', inDecimals);
                const [spotQuoteOut] = await quoter.callStatic.quoteExactInputSingle({
                    tokenIn, tokenOut, amountIn: oneUnit, fee, sqrtPriceLimitX96: 0
                });
                spotOutput = spotQuoteOut.mul(amountInWei).div(oneUnit);
            } catch (e) { console.warn('[Uniswap] Spot quote failed:', e.message); }

            const { slippageBps, impactBps, minOut, needsConfirmation } = calcAdaptiveSlippage(expectedOut, spotOutput);
            amountOutMin = minOut;
            console.log(`[Uniswap] Adaptive slippage: ${slippageBps}bps (impact=${impactBps}bps), amountOutMin=${amountOutMin.toString()}`);

            if (needsConfirmation) {
                const userBps = await notifyHighSlippage(impactBps, Math.min(impactBps * 2, 5000), MAX_AUTO_SLIPPAGE_BPS);
                if (userBps === null) throw new Error('Transaction cancelled by user: high price impact');
                amountOutMin = expectedOut.mul(10000 - userBps).div(10000);
            }
        } catch (e) {
            if (e.message && e.message.includes('cancelled by user')) throw e;
            console.warn('[Uniswap] Quote failed, proceeding without slippage protection:', e.message);
        }

        const params = {
            tokenIn, tokenOut, fee,
            recipient: this.userAddress,
            amountIn: amountInWei,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        };

        console.log(`[Uniswap] Swapping ${amount} ${direction === 'buy' ? 'USDC → token' : 'token → USDC'}`);
        const tx = await router.exactInputSingle(params);
        const receipt = await tx.wait();

        // Parse output amount from logs
        let amountOut = 0;
        try {
            const outContract = new window.ethers.Contract(tokenOut, USDC_ABI, this.getReadProvider());
            const transferTopic = window.ethers.utils.id('Transfer(address,address,uint256)');
            const userAddrPadded = window.ethers.utils.hexZeroPad(this.userAddress.toLowerCase(), 32);
            const transferLog = receipt.logs.find(l =>
                l.topics[0] === transferTopic &&
                l.topics[2]?.toLowerCase() === userAddrPadded.toLowerCase()
            );
            if (transferLog) {
                const outDecimals = direction === 'buy' ? 18 : 6;
                amountOut = parseFloat(window.ethers.utils.formatUnits(transferLog.data, outDecimals));
            }
        } catch (e) { console.warn('[DexHero]', e.message); }

        return {
            success: true,
            transactionHash: receipt.transactionHash,
            amountOut
        };
    }

    /**
     * Buy the SBT access pass from an existing-token manager.
     * This is separate from trading the underlying ERC20.
     */
    async buyAccessPass(managerAddress) {
        const readProvider = this.getReadProvider();
        const managerRead = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
        const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
        const addresses = CONTRACT_ADDRESSES[this.network] || CONTRACT_ADDRESSES.sepolia;
        const usdcWrite = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);

        const price = await managerRead.getRentalPrice();

        // Direct transfer — no approval needed
        console.log(`Sending ${window.ethers.utils.formatUnits(price, 6)} USDC to manager...`);
        const transferTx = await usdcWrite.transfer(managerAddress, price);
        await transferTx.wait();

        const tx = await managerWrite.buyDexHero(1);
        const receipt = await tx.wait();
        return { success: true, transactionHash: receipt.transactionHash };
    }

    /**
     * Sell (redeem) an SBT access pass back to the manager for a USDC refund.
     */
    async sellAccessPass(managerAddress, tokenId) {
        const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
        const tx = await manager.redeem(tokenId);
        const receipt = await tx.wait();
        return { success: true, transactionHash: receipt.transactionHash };
    }

    /**
     * Set the purchase price (unlock price) for a DexHero — callable by creator (owner/gameCollector).
     * @param {string} managerAddress
     * @param {number} priceUSDC  e.g. 10 for $10
     */
    async setPurchasePrice(managerAddress, priceUSDC) {
        if (!this.signer) throw new Error("Wallet not connected");
        const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
        const raw = window.ethers.utils.parseUnits(priceUSDC.toString(), 6);
        const tx = await manager.setPurchasePrice(raw);
        const receipt = await tx.wait();
        return { success: true, transactionHash: receipt.transactionHash };
    }

    /**
     * Set the base rental price for a DexHero — callable by creator (owner/gameCollector).
     * The live rental price is base + (increment × activePositions), so this sets the floor.
     * @param {string} managerAddress
     * @param {number} priceUSDC  e.g. 1 for $1
     */
    async setRentalPrice(managerAddress, priceUSDC) {
        if (!this.signer) throw new Error("Wallet not connected");
        const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
        const raw = window.ethers.utils.parseUnits(priceUSDC.toString(), 6);
        const tx = await manager.setRentalPrice(raw);
        const receipt = await tx.wait();
        return { success: true, transactionHash: receipt.transactionHash };
    }

    /**
     * Fetch all creator-relevant stats from the manager in one shot.
     * Returns purchase price, rental price, active positions, IL pool, coverage ratio, excess cash.
     */
    async getManagerStats(managerAddress) {
        const provider = this.getReadProvider();
        const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, provider);
        const fmt6 = (v) => parseFloat(window.ethers.utils.formatUnits(v, 6));

        const [purchaseRaw, rentalRaw, activeRaw] = await Promise.all([
            manager.getPurchasePrice().catch(() => window.ethers.BigNumber.from(0)),
            manager.getRentalPrice().catch(() => window.ethers.BigNumber.from(0)),
            manager.activePositions().catch(() => window.ethers.BigNumber.from(0)),
        ]);

        // IL pool and coverage ratio now exist on both manager types
        const [ilRaw, crRaw, principalRaw] = await Promise.all([
            manager.ilCompensationPool().catch(() => window.ethers.BigNumber.from(0)),
            manager.coverageRatioBps().catch(() => null),
            manager.totalPrincipalOwed().catch(() =>
                manager.totalFundsCollectedUSDC().catch(() => window.ethers.BigNumber.from(0))
            ),
        ]);

        const crNum = crRaw ? crRaw.toNumber() : null;
        const safetyLockActive = crNum !== null && activeRaw.toNumber() >= 10 && crNum < 500;

        return {
            purchasePrice:    fmt6(purchaseRaw),
            rentalPrice:      fmt6(rentalRaw),
            activePositions:  activeRaw.toNumber(),
            ilPool:           fmt6(ilRaw),
            totalPrincipal:   fmt6(principalRaw),
            coverageRatio:    crNum !== null ? crNum / 100 : null, // percentage (e.g. 85.2%)
            coverageRatioBps: crNum,
            safetyLockActive, // true when CR < 5% and past bootstrap
        };
    }

    /**
     * Step 1: Transfer USDC to manager, then call deposit() to record it on-chain.
     * After this, pendingDeposit(wallet) > 0 — any device can see the PLAY state.
     */
    async depositForPlay(managerAddress) {
        if (!managerAddress) throw new Error("Missing managerAddress");

        try {
            const readProvider = this.getReadProvider();
            const managerRead = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
            const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
            const addresses = CONTRACT_ADDRESSES[this.network];
            const usdcWrite = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);

            const price = await managerRead.getRentalPrice();

            // 1. Transfer USDC to manager
            console.log(`Sending ${window.ethers.utils.formatUnits(price, 6)} USDC to manager...`);
            const transferTx = await usdcWrite.transfer(managerAddress, price);
            await transferTx.wait();

            // 2. Call deposit() to record it on-chain
            console.log("Recording deposit on-chain...");
            const depositTx = await managerWrite.deposit();
            const receipt = await depositTx.wait();

            console.log("Deposit recorded ");
            return {
                success: true,
                transactionHash: receipt.transactionHash,
                price: window.ethers.utils.formatUnits(price, 6)
            };
        } catch (e) {
            console.error("Deposit failed:", e);
            throw e;
        }
    }

    /**
     * Step 2: Start the play pass (mints SBT, starts 3-day countdown).
     * Consumes the pending deposit recorded by depositForPlay.
     */
    async startPlayPass(managerAddress) {
        if (!managerAddress) throw new Error("Missing managerAddress");

        try {
            const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);

            console.log(`Starting Play Pass on manager ${managerAddress}...`);
            const tx = await managerWrite.startPlay();
            const receipt = await tx.wait();

            const event = receipt.events.find(e => e.event === 'SBTMinted');
            const tokenId = event ? event.args.tokenId.toNumber() : 0;

            console.log("Play Pass started ");
            return {
                success: true,
                tokenId,
                transactionHash: receipt.transactionHash
            };
        } catch (e) {
            console.error("Start Play Pass failed:", e);
            throw e;
        }
    }

    /**
     * Read the on-chain pending deposit for a wallet.
     */
    async getPendingDeposit(managerAddress, walletAddress) {
        const readProvider = this.getReadProvider();
        const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
        const amount = await manager.pendingDeposit(walletAddress);
        return amount;
    }

    /**
     * Withdraw a pending deposit (before starting play).
     */
    async withdrawPendingDeposit(managerAddress) {
        if (!managerAddress) throw new Error("Missing managerAddress");
        const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
        const tx = await managerWrite.withdrawDeposit();
        const receipt = await tx.wait();
        return { success: true, transactionHash: receipt.transactionHash };
    }

    /**
     * Legacy wrapper — calls both steps back-to-back.
     */
    async rentDexHero(quantity, managerAddress) {
        const deposit = await this.depositForPlay(managerAddress);
        const mint = await this.startPlayPass(managerAddress);
        return { ...deposit, ...mint };
    }

    /**
     * Get estimated token amount for a given USDC input
     * @param {number} amountUSDC 
     * @param {string} contractAddress - Manager Address
     */
    async getBuyQuote(amountUSDC, contractAddress) {
        if (!amountUSDC || amountUSDC <= 0) return 0;
        if (!contractAddress) return 0;

        try {
            // Check for Router (V2) via Hero Details
            const heroDetails = await this.getHeroDetails(contractAddress);
            let isV2 = heroDetails && heroDetails.isV2;
            const routerAddr = isV2 ? heroDetails.router : null;

            if (isV2 && routerAddr) {
                const routerABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
                const router = new window.ethers.Contract(routerAddr, routerABI, this.provider); // Use provider (read-only)

                // USDC has 6 decimals
                const amountIn = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);
                const tokensOut = await router.quoteBuyTokens(amountIn);

                // Tokens have 18 decimals
                return parseFloat(window.ethers.utils.formatUnits(tokensOut, 18));
            }

            return 0; // V1 or error
        } catch (e) {
            console.warn("Error getting buy quote:", e);
            return 0;
        }
    }

    /**
     * Sell DexHero Tokens (Redeem SBTs for USDC)
     * @param {number} quantity - Number of units to sell
     * @param {string} contractAddress - Token Manager Contract Address
     */
    async sellToken(quantity, contractAddress, knownRouter = null, knownTokenAddress = null) {
        if (!contractAddress) throw new Error("Contract address required");

        const manager = new window.ethers.Contract(contractAddress, DEXHERO_MANAGER_ABI, this.signer);

        // Use known addresses if provided (avoids slow eth_getLogs factory scan)
        let routerAddr = knownRouter;
        let tokenAddressForSell = knownTokenAddress;
        let isV2 = !!(routerAddr);

        if (!routerAddr) {
            const heroDetails = await this.getHeroDetails(contractAddress);
            isV2 = heroDetails && heroDetails.isV2;
            routerAddr = isV2 ? heroDetails.router : null;
            tokenAddressForSell = isV2 ? heroDetails.token : null;
        }

        if (isV2) {
            // V2: Sell ERC20 via Router
            console.log(" V2 Mode: Selling via Router:", routerAddr);

            // 1. Token address from known or fetched details
            const tokenAddress = tokenAddressForSell;
            console.log("Token Address from Factory:", tokenAddress);

            if (!tokenAddress) throw new Error("Could not determine token address for sale.");

            const tokenContract = new window.ethers.Contract(tokenAddress, USDC_ABI, this.signer);
            const amountIn = window.ethers.utils.parseUnits(quantity.toString(), 18); // DexHero tokens are always 18 decimals

            const routerABI = [
                "function sellTokens(uint256 amountToken, uint256 minUSDCOut, uint256 checkTokenId) external returns (uint256)",
                "function sellTokensDirect(uint256 amountToken, uint256 minUSDCOut, uint256 checkTokenId) external returns (uint256)",
                "function quoteSellTokens(uint256 amountToken) view returns (uint256)",
                "function DIRECT_TRANSFER_ENABLED() view returns (bool)",
                "event Sold(address indexed seller, uint256 tokenIn, uint256 usdcOut, uint256 spreadCaptured)"
            ];
            const router = new window.ethers.Contract(routerAddr, routerABI, this.signer);
            const routerRead = new window.ethers.Contract(routerAddr, routerABI, this.getReadProvider());

            // Detect direct-transfer support
            let sellDirect = false;
            try {
                sellDirect = await routerRead.DIRECT_TRANSFER_ENABLED();
            } catch (_) { /* old router */ }

            if (!sellDirect) {
                // Legacy router: approve MaxUint256 once — spending cap shows once, never again
                const MAX = window.ethers.constants.MaxUint256;
                const allowance = await tokenContract.allowance(this.userAddress, routerAddr);
                if (allowance.lt(amountIn)) {
                    console.log("[Sell] Approving Router (MaxUint256 — one-time)...");
                    const apTx = await tokenContract.approve(routerAddr, MAX);
                    await apTx.wait();
                }
            }

            // Pre-flight simulation
            // For direct-transfer sells, use quoteSellTokens (pure view — no approval needed).
            // For legacy sells, use callStatic.sellTokens which simulates the full transferFrom.
            let expectedUsdcDisplay = null;
            try {
                if (sellDirect) {
                    expectedUsdcDisplay = await routerRead.quoteSellTokens(amountIn);
                } else {
                    expectedUsdcDisplay = await routerRead.callStatic.sellTokens(amountIn, 0, 0, { from: this.userAddress });
                }
                console.log(`[Sell] Expected USDC out: ${window.ethers.utils.formatUnits(expectedUsdcDisplay, 6)}`);
            } catch (e) {
                if (e.message && e.message.includes('cancelled by user')) throw e;
                if (!sellDirect && e.code === 'CALL_EXCEPTION') {
                    const reason = e.reason || e.error?.reason || e.errorArgs?.[0] || 'contract reverted';
                    throw new Error(`Sell failed (simulation): ${reason}`);
                }
                console.warn("[Sell] Simulation failed (RPC issue, proceeding):", e.message);
            }
            const finalMinUSDCOut = 0;

            // Execute sell — direct transfer if supported, otherwise transferFrom
            let tx;
            if (sellDirect) {
                console.log("[Sell] Using direct transfer (no approval)...");
                const transferTx = await tokenContract.transfer(routerAddr, amountIn);
                await transferTx.wait();
                tx = await router.sellTokensDirect(amountIn, finalMinUSDCOut, 0, { gasLimit: 500000 });
            } else {
                tx = await router.sellTokens(amountIn, finalMinUSDCOut, 0, { gasLimit: 500000 });
            }
            console.log("Sell TX sent:", tx.hash);
            const receipt = await tx.wait();

            // Parse usdcOut from the Sold event; fall back to pre-tx quote
            let usdcReceived = expectedUsdcDisplay
                ? parseFloat(window.ethers.utils.formatUnits(expectedUsdcDisplay, 6))
                : 0;
            try {
                const soldEvent = receipt.logs
                    .map(log => { try { return router.interface.parseLog(log); } catch { return null; } })
                    .find(e => e?.name === 'Sold');
                if (soldEvent) {
                    usdcReceived = parseFloat(window.ethers.utils.formatUnits(soldEvent.args.usdcOut, 6));
                }
            } catch (e) { console.warn('[DexHero]', e.message); }

            return {
                success: true,
                transactionHash: receipt.transactionHash,
                usdcReceived
            };

        } else {
            // V1 Legacy: Redeem SBTs
            // 1. Get SBT Address from Manager
            let sbtAddress;
            try {
                sbtAddress = await manager.sbt();
            } catch (e) {
                console.error("Failed to get SBT address from manager:", e);
                throw new Error("Could not determine SBT contract address.");
            }

            const nft = new window.ethers.Contract(sbtAddress, DEXHERO_NFT_ABI, this.signer);

            // 2. Get User's Token IDs
            const balance = await nft.balanceOf(this.userAddress);
            if (balance.lt(quantity)) {
                throw new Error(`Insufficient Token balance. You own ${balance.toString()} units.`);
            }

            // Fetch IDs to sell (Last in, First out? Or First in First out? Doesn't matter for fungible feel)
            const tokenIds = [];
            for (let i = 0; i < quantity; i++) {
                const tokenId = await nft.tokenOfOwnerByIndex(this.userAddress, i);
                tokenIds.push(tokenId);
            }

            // 3. Redeem each (Loop)
            console.log(`Selling ${quantity} tokens:`, tokenIds.map(t => t.toString()));

            let lastReceipt = null;
            let totalRefund = window.ethers.BigNumber.from(0);

            for (const tokenId of tokenIds) {
                const tx = await manager.redeem(tokenId);
                lastReceipt = await tx.wait();

                const event = lastReceipt.events.find(e => e.event === 'Redeemed');
                if (event) {
                    totalRefund = totalRefund.add(event.args.refund);
                }
            }

            return {
                success: true,
                transactionHash: lastReceipt.transactionHash,
                refundAmount: window.ethers.utils.formatUnits(totalRefund, 6)
            };
        }
    }

    /**
     * Get user's rented DexHeros
     */
    /**
     * Get user's rented DexHeros (Detailed)
     */
    async getUserRentals() {
        const contracts = this.getContracts();

        const balance = await contracts.nft.balanceOf(this.userAddress);
        const rentals = [];

        for (let i = 0; i < balance.toNumber(); i++) {
            const tokenId = await contracts.nft.tokenOfOwnerByIndex(this.userAddress, i);
            const principal = await contracts.manager.principalOf(tokenId);
            let depositTs = 0;
            try {
                const ts = await contracts.manager.depositTimestamp(tokenId);
                depositTs = ts.toNumber();
            } catch (e) {
                console.warn("Could not fetch depositTimestamp for token:", tokenId.toString());
            }

            rentals.push({
                tokenId: tokenId.toNumber(),
                deposit: window.ethers.utils.formatUnits(principal, 6),
                depositTs: depositTs
            });
        }

        return rentals;
    }

    /**
     * Get user's token balance (Simple Count) for a specific Manager
     * @param {string} managerAddress 
     */
    async getUserTokenBalance(tokenOrManagerAddress) {
        if (!tokenOrManagerAddress) return 0;
        console.log(`[Balance Check] Starting for address: ${tokenOrManagerAddress}`);

        if (!this.userAddress) return 0;

        const readProvider = this.getReadProvider();

        // Helper: read ERC20 balance for a given address
        const readERC20Balance = async (addr) => {
            const token = new window.ethers.Contract(addr, USDC_ABI, readProvider);
            const raw = await token.balanceOf(this.userAddress);
            let decimals = 18;
            try { decimals = await token.decimals(); } catch {}
            return { balance: parseFloat(window.ethers.utils.formatUnits(raw, decimals)), isERC20: true };
        };

        // 2. Try direct ERC20 balance first.
        //    If decimals() succeeds, the address IS an ERC20 token — return the balance even if 0.
        //    (No need for factory getLogs if we confirmed it's a token contract.)
        try {
            const { balance } = await readERC20Balance(tokenOrManagerAddress);
            console.log(`[Balance Check] Direct ERC20 balance: ${balance}`);
            return balance; // return 0 if user has none — don't fall through to getHeroDetails
        } catch (e) {
            // decimals()/balanceOf() reverted — not a plain ERC20, try manager paths
        }

        // 3. Try V2 Manager: resolve token address via factory, then read ERC20 balance.
        //    Only reached if the address is a manager, not a token.
        try {
            const heroDetails = await this.getHeroDetails(tokenOrManagerAddress);
            if (heroDetails?.isV2 && heroDetails.token) {
                const { balance } = await readERC20Balance(heroDetails.token);
                console.log(`[Balance Check] V2 token balance: ${balance}`);
                return balance;
            }
        } catch (e) {
            // Not a V2 manager — continue
        }

        // 4. Try Manager → SBT NFT (V1 / SBT-based tokens)
        try {
            const manager = new window.ethers.Contract(tokenOrManagerAddress, DEXHERO_MANAGER_ABI, readProvider);
            const sbtAddress = await manager.sbt();
            if (sbtAddress && sbtAddress !== '0x0000000000000000000000000000000000000000') {
                const nft = new window.ethers.Contract(sbtAddress, DEXHERO_NFT_ABI, readProvider);
                const balance = await nft.balanceOf(this.userAddress);
                console.log(`[Balance Check] SBT NFT balance: ${balance.toNumber()}`);
                return balance.toNumber();
            }
        } catch (e) {
            console.warn("[Balance Check] All paths failed:", e.message?.substring(0, 80));
        }

        return 0;
    }

    /**
     * Index EVM trade events into Supabase so Realtime subscriptions work for EVM tokens.
     * Fetches Bought/Sold events from the chain and POSTs any new ones to /api/trades/record.
     * Should be called once on initial chart load and after each buy/sell transaction.
     * @param {string} managerAddress - EVM manager contract address
     * @param {string|null} routerAddress - Known router address (skip getHeroDetails if provided)
     * @param {string|null} creationTime - ISO creation timestamp for smart block range
     * @param {string|null} sinceTimestamp - ISO timestamp; skip trades already in Supabase
     * @returns {Promise<number>} count of newly indexed trades
     */
    async indexEVMTrades(managerAddress, routerAddress = null, creationTime = null, sinceTimestamp = null) {
        if (!managerAddress || !this.isEvmAddress(managerAddress)) return 0;
        try {
            const provider = this.getReadProvider();
            let routerAddr = routerAddress;
            if (!routerAddr) {
                const details = await this.getHeroDetails(managerAddress, provider, creationTime).catch(() => null);
                routerAddr = details?.router || null;
            }
            if (!routerAddr || routerAddr === window.ethers.constants.AddressZero) return 0;

            const router = new window.ethers.Contract(routerAddr, DEXHEROS_ROUTER_ABI, provider);
            const currentBlock = await provider.getBlockNumber();

            let startBlock = 0;
            if (sinceTimestamp) {
                const ageSec = (Date.now() - new Date(sinceTimestamp).getTime()) / 1000;
                startBlock = Math.max(0, currentBlock - Math.floor(ageSec / EVM_BLOCK_TIME_SECONDS) - 100);
            } else if (creationTime) {
                const ageSec = (Date.now() - new Date(creationTime).getTime()) / 1000;
                startBlock = Math.max(0, currentBlock - Math.floor(ageSec / EVM_BLOCK_TIME_SECONDS) - BLOCK_SEARCH_BUFFER);
            } else {
                startBlock = Math.max(0, currentBlock - 50000);
            }

            const [boughtLogs, soldLogs] = await Promise.all([
                this.queryFilterSafe(router, router.filters.Bought(), startBlock, 'latest'),
                this.queryFilterSafe(router, router.filters.Sold(), startBlock, 'latest')
            ]);

            let indexed = 0;
            const toIndex = [
                ...boughtLogs.map(l => ({ ...l, tradeType: 'buy' })),
                ...soldLogs.map(l => ({ ...l, tradeType: 'sell' }))
            ];
            toIndex.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

            for (const log of toIndex) {
                try {
                    let amountUsdc = 0, amountToken = 0, priceUsdc = 0;
                    if (log.tradeType === 'buy') {
                        amountUsdc = parseFloat(window.ethers.utils.formatUnits(log.args.usdcIn || log.args[0], 6)) || 0;
                        amountToken = parseFloat(window.ethers.utils.formatUnits(log.args.tokensOut || log.args[1], 18)) || 0;
                    } else {
                        amountToken = parseFloat(window.ethers.utils.formatUnits(log.args.tokenIn || log.args[0], 18)) || 0;
                        amountUsdc = parseFloat(window.ethers.utils.formatUnits(log.args.usdcOut || log.args[1], 6)) || 0;
                    }
                    priceUsdc = amountToken > 0 ? amountUsdc / amountToken : 0;

                    const block = await provider.getBlock(log.blockNumber).catch(() => null);
                    const timestamp = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();

                    if (sinceTimestamp && timestamp <= sinceTimestamp) continue;

                    const resp = await fetch('/api/trades/record', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            manager_address: managerAddress,
                            tx_hash: log.transactionHash,
                            log_index: log.logIndex,
                            block_number: log.blockNumber,
                            type: log.tradeType,
                            trader_address: (log.tradeType === 'buy' ? log.args.buyer : log.args.seller) || 'unknown',
                            amount_usdc: amountUsdc,
                            amount_token: amountToken,
                            price_usdc: priceUsdc,
                            timestamp,
                            is_v2: true
                        })
                    });
                    if (resp.ok) indexed++;
                } catch (e) {
                    // Duplicate constraint violation is expected — skip silently
                    if (!e.message?.includes('duplicate') && !e.message?.includes('23505')) {
                        console.warn('[indexEVMTrades] Failed to index trade:', e.message);
                    }
                }
            }
            console.log(`[indexEVMTrades] Indexed ${indexed} new trades for ${managerAddress}`);
            return indexed;
        } catch (e) {
            console.warn('[indexEVMTrades] Failed:', e.message);
            return 0;
        }
    }

    async getTradeHistory(managerAddress, resolutionSeconds = 60, creationTime = null, knownRouter = null) {
        if (!managerAddress) return [];

        // All tokens (EVM and wrapped Solana) use Supabase trade data.
        // Trades are written to Supabase at creation time and on every buy/sell.
        try {
            const params = new URLSearchParams({ manager: managerAddress });
            const res = await fetch(`/api/trades?${params.toString()}`);
            if (!res.ok) return [];
            const { trades } = await res.json();
            if (!trades || trades.length === 0) return [];

            trades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            const candles = new Map();
            let lastClose = 0;
            for (const t of trades) {
                const ts = Math.floor(new Date(t.timestamp).getTime() / 1000);
                const bucket = Math.floor(ts / resolutionSeconds) * resolutionSeconds;
                const price = parseFloat(t.price_usdc) || 0;
                const vol = parseFloat(t.amount_usdc) || 0;

                if (!candles.has(bucket)) {
                    candles.set(bucket, { time: bucket, open: lastClose || price, high: price, low: price, close: price, volume: vol });
                } else {
                    const c = candles.get(bucket);
                    c.high = Math.max(c.high, price);
                    c.low = Math.min(c.low, price);
                    c.close = price;
                    c.volume += vol;
                }
                lastClose = price;
            }

            const result = Array.from(candles.values()).sort((a, b) => a.time - b.time);
            console.log(`[TradeHistory] ${result.length} candles from Supabase for ${managerAddress}`);
            return result;
        } catch (e) {
            console.warn('[TradeHistory] Supabase fetch failed:', e.message);
            return [];
        }
    }

    /**
     * Fetch raw live transactions for a token (un-aggregated)
     * @param {string} managerAddress 
     * @param {string} creationTime 
     * @param {string} routerAddr 
     * @returns {Promise<Array>} List of raw transactions
     */
    async getLiveTransactions(managerAddress, creationTime = null, routerAddr = null) {
        try {
            if (!managerAddress || !this.isEvmAddress(managerAddress)) return [];

            let provider = this.provider;
            if (!provider) {
                const network = NETWORKS[this.network] || NETWORKS.sepolia;
                provider = new window.ethers.providers.JsonRpcProvider(network.rpcUrl);
            }

            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, provider);
            let isV2 = false;

            if (routerAddr) {
                isV2 = true;
            } else {
                const heroDetails = await this.getHeroDetails(managerAddress, provider, creationTime);
                isV2 = heroDetails ? heroDetails.isV2 : false;
                routerAddr = isV2 ? heroDetails.router : null;
            }

            let allLogs = [];

            if (isV2) {
                if (routerAddr && routerAddr !== window.ethers.constants.AddressZero) {
                    const router = new window.ethers.Contract(routerAddr, DEXHEROS_ROUTER_ABI, provider);
                    let startBlock = 0;
                    const currentBlock = await provider.getBlockNumber();

                    if (creationTime) {
                        const createdAt = new Date(creationTime).getTime();
                        const ageSec = (Date.now() - createdAt) / 1000;
                        const blocksAgo = Math.floor(ageSec / EVM_BLOCK_TIME_SECONDS) + BLOCK_SEARCH_BUFFER;
                        startBlock = Math.max(0, currentBlock - blocksAgo);
                    } else {
                        startBlock = Math.max(0, currentBlock - 100000);
                    }

                    const [boughtLogs, soldLogs] = await Promise.all([
                        this.queryFilterSafe(router, router.filters.Bought(), startBlock, 'latest'),
                        this.queryFilterSafe(router, router.filters.Sold(), startBlock, 'latest')
                    ]);

                    allLogs = [
                        ...boughtLogs.map(l => ({ ...l, type: 'buy', isV2: true, isRouter: true })),
                        ...soldLogs.map(l => ({ ...l, type: 'sell', isV2: true, isRouter: true }))
                    ];
                }
            } else {
                const mintFilter = manager.filters.SBTMinted();
                const redeemFilter = manager.filters.Redeemed();
                let startBlock = 0;
                const currentBlock = await provider.getBlockNumber();

                if (creationTime) {
                    const createdAt = new Date(creationTime).getTime();
                    const ageSec = (Date.now() - createdAt) / 1000;
                    const blocksAgo = Math.floor(ageSec / EVM_BLOCK_TIME_SECONDS) + 1000;
                    startBlock = Math.max(0, currentBlock - blocksAgo);
                } else {
                    startBlock = Math.max(0, currentBlock - 1000);
                }

                const [mintLogs, redeemLogs] = await Promise.all([
                    this.queryFilterSafe(manager, mintFilter, startBlock, 'latest'),
                    this.queryFilterSafe(manager, redeemFilter, startBlock, 'latest')
                ]);

                allLogs = [
                    ...mintLogs.map(l => ({ ...l, type: 'buy', isV2: false })),
                    ...redeemLogs.map(l => ({ ...l, type: 'sell', isV2: false }))
                ];
            }

            const now = Math.floor(Date.now() / 1000);
            // Sort Descending (Newest First)
            allLogs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

            // --- Batch getBlock by unique block number to avoid N serial RPC calls ---
            const uniqueBlockNums = [...new Set(allLogs.map(l => l.blockNumber))];
            const blockCache = {};
            await Promise.all(uniqueBlockNums.map(async (bn) => {
                try {
                    const b = await provider.getBlock(bn);
                    blockCache[bn] = b ? b.timestamp : now;
                } catch (_) {
                    blockCache[bn] = now;
                }
            }));

            const transactions = await Promise.all(allLogs.map(async (log) => {
                const time = blockCache[log.blockNumber] ?? now;

                let usdcAmt = 0;
                let tokenAmt = 0;
                let maker = '';

                if (log.isV2) {
                    if (log.isRouter) {
                        maker = log.type === 'buy' ? log.args.buyer : log.args.seller;
                        if (log.type === 'buy') {
                            usdcAmt = parseFloat(window.ethers.utils.formatUnits(log.args.usdcIn, 6));
                            tokenAmt = parseFloat(window.ethers.utils.formatUnits(log.args.tokensOut, 18));
                        } else {
                            tokenAmt = parseFloat(window.ethers.utils.formatUnits(log.args.tokenIn, 18));
                            usdcAmt = parseFloat(window.ethers.utils.formatUnits(log.args.usdcOut, 6));
                        }
                    }
                } else {
                    maker = log.type === 'buy' ? log.args.buyer : log.args.owner;
                    if (log.type === 'buy') {
                        usdcAmt = parseFloat(window.ethers.utils.formatUnits(log.args.principalUSDC || log.args.price || 0, 6));
                        tokenAmt = 1;
                    } else {
                        usdcAmt = parseFloat(window.ethers.utils.formatUnits(log.args.refund || 0, 6));
                        tokenAmt = 1;
                    }
                }

                // If maker is still zero/empty (common for V1), fall back to tx.from
                const isZeroAddr = !maker || maker === window.ethers.constants.AddressZero;
                if (isZeroAddr) {
                    try {
                        const tx = await log.getTransaction();
                        if (tx && tx.from) maker = tx.from;
                    } catch (_) { console.warn('[DexHero]', _.message); }
                }

                const price = tokenAmt > 0 ? usdcAmt / tokenAmt : 0;

                return {
                    time,
                    type: log.type,
                    usd: usdcAmt,
                    token: tokenAmt,
                    price,
                    maker,
                    hash: log.transactionHash
                };
            }));

            return transactions;
        } catch (error) {
            console.error("Error fetching live transactions:", error);
            return [];
        }
    }

    /**
     * Fetch NFT Unlocks
     * @param {string} managerAddress 
     * @param {string} creationTime 
     * @returns {Promise<Array>} List of raw unlock events
     */
    async getUnlocks(managerAddress, creationTime = null) {
        try {
            if (!managerAddress || !this.isEvmAddress(managerAddress)) return [];

            const provider = this.getReadProvider();
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, provider);

            let startBlock = 0;
            const currentBlock = await provider.getBlockNumber();

            if (creationTime) {
                const createdAt = new Date(creationTime).getTime();
                const ageSec = (Date.now() - createdAt) / 1000;
                const blocksAgo = Math.floor(ageSec / EVM_BLOCK_TIME_SECONDS) + BLOCK_SEARCH_BUFFER; // Add buffer
                startBlock = Math.max(0, currentBlock - blocksAgo);
            } else {
                startBlock = Math.max(0, currentBlock - 100000);
            }

            // NFTUnlocked(uint256 indexed tokenId, uint256 cost)
            const unlockLogs = await this.queryFilterSafe(manager, manager.filters.NFTUnlocked(), startBlock, 'latest');

            // Find owners of unlocking by querying SBT if needed or Manager SBTMinted logs to cross-reference tokenId?
            // Actually, we can just grab the transaction sender (from the tx hash) to represent the user who unlocked it.
            const now = Math.floor(Date.now() / 1000);

            // Sort Descending (Newest First)
            unlockLogs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

            const unlocks = await Promise.all(unlockLogs.map(async (log) => {
                const block = await log.getBlock();
                const tx = await log.getTransaction();

                const time = block ? block.timestamp : now;
                const costUsdc = window.ethers.utils.formatUnits(log.args.cost, 6);
                const tokenId = log.args.tokenId.toString();
                const userAddress = tx ? tx.from : "-";

                return {
                    time,
                    tokenId,
                    costUsdc: parseFloat(costUsdc),
                    user: userAddress,
                    hash: log.transactionHash
                };
            }));

            return unlocks;
        } catch (error) {
            console.error("Error fetching unlocks:", error);
            return [];
        }
    }

    /**
     * @param {Object} data - Token data { name, symbol, basePrice, priceIncrement }
     * @returns {Promise<string>} - Deployed contract address
     */
    /**
     * Deploy a new DexHero (Token + Manager + SBT) via Factory
     * @param {Object} data - Token data { name, symbol, purchasePrice, rentalPrice }
     * @param {boolean} useBondingCurve - Whether to use V2 factory
     * @param {string} ownerAddress - Optional explicit owner
     * @param {boolean} serverFulfillment - Whether to use automated server deployment (Single-transaction)
     * @returns {Promise<Object>} - Deployed addresses { address, token, transactionHash }
     */
    async deployManager(data, useBondingCurve = true, ownerAddress = null, serverFulfillment = false) {
        console.log('Deploying DexHero via Factory. ServerFulfillment:', serverFulfillment);

        // 1. Use the connected wallet provider
        const evmProvider = window._metaMaskProvider || window.ethereum;

        if (!evmProvider) {
            throw new Error('No EVM wallet found. Please connect a wallet to deploy.');
        }

        let accounts = await evmProvider.request({ method: 'eth_accounts' });
        if (!accounts || accounts.length === 0) {
            accounts = await evmProvider.request({ method: 'eth_requestAccounts' });
        }
        if (!accounts || accounts.length === 0) {
            throw new Error('No accounts found. Please connect MetaMask.');
        }
        this.userAddress = accounts[0];
        if (ownerAddress) this.userAddress = ownerAddress;

        // sessionStorage wallet state is owned by /app/services/wallet.js —
        // do NOT write here (would create a second source of truth).
        await this.switchNetwork(this.network);

        this.provider = new window.ethers.providers.Web3Provider(evmProvider);
        this.signer = this.provider.getSigner();

        if (serverFulfillment) {
            console.log(" Server Fulfillment Path: Paying fee to treasury...");
            const contracts = this.getContracts();
            const addresses = CONTRACT_ADDRESSES[this.network];
            const treasury = addresses.treasury;

            if (!treasury) throw new Error("Treasury address not found in system config. Try refreshing.");

            const platformFee = 100;
            const initialBuyUSDC = parseFloat(data.initialBuyUSDC || 0);
            const totalFee = platformFee + initialBuyUSDC;
            const feeAmount = window.ethers.utils.parseUnits(totalFee.toFixed(6), 6);

            console.log(` Sending $${totalFee} USDC to treasury (${platformFee} creation fee + ${initialBuyUSDC} initial buy): ${treasury}`);
            const tx = await contracts.usdc.transfer(treasury, feeAmount);
            console.log("⏳ Fee transaction sent:", tx.hash);
            this._lastTxHash = tx.hash;

            const receipt = await tx.wait();
            console.log(" Fee confirmed, requesting server deployment...");

            // Call server deployment API
            const response = await fetch('/api/dexhero/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    txHash: receipt.transactionHash,
                    params: {
                        launchType: 'new',
                        name: data.name,
                        symbol: data.symbol,
                        purchasePrice: data.purchasePrice,
                        rentalPrice: data.rentalPrice,
                        initialBuyUSDC: data.initialBuyUSDC || 0
                    },
                    evmCollector: this.userAddress
                })
            });

            const result = await response.json();
            if (!response.ok) throw new Error("Server deployment failed: " + (result.error || "Unknown error"));

            console.log(" Server Deployment Success:", result);
            return {
                address: result.manager,
                token: result.contract_address,
                router: result.router_address || null,
                transactionHash: result.transactionHash,
                initialBuyUSDC: initialBuyUSDC,
                initialBuyTokens: result.initialBuyTokens || 0
            };
        }

        const addresses = CONTRACT_ADDRESSES[this.network];
        let factoryAddress;
        let factoryABI;

        if (useBondingCurve) {
            factoryAddress = addresses.launchFactory;
            factoryABI = LAUNCH_FACTORY_V2_ABI;
        } else {
            factoryAddress = addresses.launchFactoryV1;
            factoryABI = LAUNCH_FACTORY_V1_ABI;
        }

        if (!factoryAddress || factoryAddress === '0x0000000000000000000000000000000000000000') {
            throw new Error(`Launch Factory not deployed for network: ${this.network}`);
        }

        const factory = new window.ethers.Contract(factoryAddress, factoryABI, this.signer);
        this.contracts.launchFactory = factoryAddress;

        const tippingPoint = window.ethers.utils.parseUnits("10000", 6);
        const purchasePriceRaw = window.ethers.utils.parseUnits((data.purchasePrice || 10).toString(), 6);
        const rentalPriceRaw = window.ethers.utils.parseUnits((data.rentalPrice || 5).toString(), 6);
        const initialBuyRaw = window.ethers.utils.parseUnits((data.initialBuyUSDC || 0).toFixed(6), 6);

        const PLATFORM_FEE_USDC = 100;
        const feeRaw = window.ethers.utils.parseUnits(PLATFORM_FEE_USDC.toString(), 6);
        const totalUSDCNeeded = feeRaw.add(initialBuyRaw);

        const contracts = this.getContracts();
        const allowance = await contracts.usdc.allowance(this.userAddress, factoryAddress);
        if (allowance.lt(totalUSDCNeeded)) {
            const approveTx = await contracts.usdc.approve(factoryAddress, totalUSDCNeeded);
            await approveTx.wait();
        }

        // Audit-fix-aware createHero call (11 params).
        //   - mintPriceUSDC replaces the old purchase/rental split (single flat price)
        //   - dexheroCharacterId is a bytes32 stable id; derive from the DB row id or
        //     a fresh UUID; here we hash the user+name+timestamp as a fallback.
        //   - traderSpreadBps capped at 1000 (10%) by the contract.
        //   - initialBuySlippageBps: 0 → factory default 500 (5%); cap 5000 (50%).
        const dexheroCharacterId = data.dexheroCharacterId
            || window.ethers.utils.keccak256(
                window.ethers.utils.toUtf8Bytes(`${this.userAddress}-${data.name}-${Date.now()}`)
            );
        const traderSpreadBps = Math.min(Math.round((parseFloat(data.taxPercentage) || 5) * 100), 1000);
        const initialBuySlippageBps = Math.min(Math.round(parseFloat(data.initialBuySlippageBps) || 0), 5000);

        const tx = await factory.createHero(
            this.userAddress,
            data.name,
            data.symbol,
            data.name + " Access",
            data.symbol + "NFT",
            tippingPoint,
            purchasePriceRaw,         // mintPriceUSDC (was purchasePrice; semantics merged)
            initialBuyRaw,
            dexheroCharacterId,
            traderSpreadBps,
            initialBuySlippageBps
        );

        console.log("Transaction sent:", tx.hash);
        this._lastTxHash = tx.hash; // Store for upload verification
        const receipt = await tx.wait();
        console.log("Transaction confirmed:", receipt.transactionHash);

        // 4. Parse HeroCreated event to get deployed addresses
        const eventInterface = new window.ethers.utils.Interface(factoryABI);
        let managerAddress = null;
        let sbtAddress = null;

        console.log("Parsing transaction logs for HeroCreated event...");
        for (const log of receipt.logs) {
            try {
                // Try parsing with standard ABI
                // Check if log address matches factory (factory emits event)
                if (log.address.toLowerCase() === factoryAddress.toLowerCase()) {
                    const parsedLog = eventInterface.parseLog(log);
                    if (parsedLog.name === 'HeroCreated') {
                        managerAddress = parsedLog.args.manager;
                        sbtAddress = parsedLog.args.sbt;
                        console.log(`Hero created! Manager: ${managerAddress}, SBT: ${sbtAddress}`);
                        break;
                    }
                }
            } catch (e) {
                // Ignore parse errors for other events
            }
        }

        if (!managerAddress) {
            console.warn("Could not parse manager address from logs. Transaction may have failed or ABI mismatch.");
            return receipt.transactionHash; // Fallback to returning tx hash
        }

        return { address: managerAddress, transactionHash: receipt.transactionHash, sbt: sbtAddress };
    }

    /**
     * Get live token statistics (Price, Supply, Market Cap)
     * @param {string} contractAddress - Manager Address
     */
    async getTokenStats(contractAddress, creationTime = null, knownRouter = null, tokenMeta = null) {
        if (!contractAddress || !this.isEvmAddress(contractAddress)) return null;

        const DEXHERO_TOKEN_ABI = [
            "function totalSupply() view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function name() view returns (string)"
        ];

        try {
            const provider = this.getReadProvider();
            if (!contractAddress || contractAddress === 'undefined') {
                console.warn("Invalid contract address for stats");
                return null;
            }

            // Early exit for existing tokens - contract_address is a regular ERC20, not a DexHero manager
            if (tokenMeta?.launchType === 'existing') {
                console.log('[getTokenStats] Existing token detected, skipping manager probe');
                try {
                    const token = new window.ethers.Contract(contractAddress, DEXHERO_TOKEN_ABI, provider);
                    const [supply, decimals] = await Promise.all([
                        token.totalSupply().catch(() => null),
                        token.decimals().catch(() => 18)
                    ]);
                    const totalSupply = supply ? parseFloat(window.ethers.utils.formatUnits(supply, decimals)) : (tokenMeta?.totalSupply || 0);
                    return {
                        price: 0,
                        supply: totalSupply,
                        marketCap: 0,
                        liquidity: 0,
                        volume: tokenMeta?.initial_volume || 0,
                        isExisting: true
                    };
                } catch (e) {
                    console.warn('[getTokenStats] Failed to read existing token stats:', e.message);
                    return { price: 0, supply: 0, marketCap: 0, liquidity: 0, volume: 0, isExisting: true };
                }
            }

            let isV2 = false;
            let routerAddr = knownRouter;
            let tokenAddr = null;

            if (routerAddr) {
                isV2 = true;
                // If known router, fetch token address via manager directly
                const manager = new window.ethers.Contract(contractAddress, ["function dexheroToken() view returns (address)"], provider);
                tokenAddr = await manager.dexheroToken().catch(() => null);
            } else {
                const heroDetails = await this.getHeroDetails(contractAddress, provider, creationTime);
                isV2 = heroDetails ? heroDetails.isV2 : false;
                routerAddr = isV2 ? heroDetails.router : null;
                tokenAddr = heroDetails ? heroDetails.token : null;
            }

            let priceUSDC = 0;
            let totalSupply = 0;
            let liquidity = 0;
            let volume = 0;

            if (isV2) {
                // V2 Stats: Query Manager and Token directly
                const V2_MANAGER_VIEW_ABI = [
                    "function priceForNextMint() view returns (uint256)",
                    "function traderPriceForNextMint() view returns (uint256)",
                    "function getTokenPrice() view returns (uint256)",
                    "function totalFundsCollectedUSDC() view returns (uint256)",
                    "function usdcToken() view returns (address)"
                ];

                try {
                    const manager = new window.ethers.Contract(contractAddress, V2_MANAGER_VIEW_ABI, provider);

                    // 1. Price (Use base getTokenPrice to exclude trader spread for pure Market Cap)
                    try {
                        const price = await manager.getTokenPrice();
                        priceUSDC = parseFloat(window.ethers.utils.formatUnits(price, 6));
                    } catch (err) {
                        try {
                            const price = await manager.traderPriceForNextMint();
                            priceUSDC = parseFloat(window.ethers.utils.formatUnits(price, 6));
                        } catch (err2) {
                            const price = await manager.priceForNextMint();
                            priceUSDC = parseFloat(window.ethers.utils.formatUnits(price, 6));
                        }
                    }

                    // 2. Liquidity (USDC inside manager + USDC inside router)
                    try {
                        const funds = await manager.totalFundsCollectedUSDC();
                        liquidity = parseFloat(window.ethers.utils.formatUnits(funds, 6));

                        // Add Router USDC balance if we know the router
                        if (routerAddr && routerAddr !== window.ethers.constants.AddressZero) {
                            const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
                            const usdcAddr = await manager.usdcToken().catch(() => null);
                            if (usdcAddr) {
                                const usdcContract = new window.ethers.Contract(usdcAddr, USDC_ABI, provider);
                                const routerBal = await usdcContract.balanceOf(routerAddr).catch(() => 0);
                                liquidity += parseFloat(window.ethers.utils.formatUnits(routerBal, 6));
                            }
                        }
                    } catch (err) {
                        console.warn("Error calculating liquidity:", err);
                        // liquidity = 0 handled above
                    }

                    // Convert to TVL standard (2x Base Token value)
                    liquidity *= 2;

                    // 3. Supply (Token total supply)
                    if (tokenAddr && tokenAddr !== window.ethers.constants.AddressZero) {
                        try {
                            const token = new window.ethers.Contract(tokenAddr, DEXHERO_TOKEN_ABI, provider);
                            const supply = await token.totalSupply();
                            totalSupply = parseFloat(window.ethers.utils.formatUnits(supply, 18));
                        } catch (err) {
                            totalSupply = 0;
                        }
                    } else {
                        totalSupply = 10000000; // Default fallback to initial mint amounts
                    }

                    // Volume is set via Supabase aggregation elsewhere, default to 0
                    volume = 0;

                } catch (e) {
                    console.warn("Failed to get V2 Stats:", e);
                }

            } else {
                // V1 Logic
                const manager = new window.ethers.Contract(contractAddress, DEXHERO_MANAGER_ABI, provider);
                const price = await manager.priceForNextMint();
                priceUSDC = parseFloat(window.ethers.utils.formatUnits(price, 6));

                try {
                    const funds = await manager.totalFundsCollectedUSDC();
                    liquidity = parseFloat(window.ethers.utils.formatUnits(funds, 6)) * 2;

                    const active = await manager.activePositions();
                    totalSupply = active.toNumber();
                } catch (e) {
                    totalSupply = 0;
                }
            }

            return {
                price: priceUSDC,
                supply: totalSupply,
                marketCap: priceUSDC * totalSupply,
                liquidity: liquidity || 0,
                volume: volume || 0
            };

        } catch (e) {
            console.error("Error fetching token stats:", e);
            return null;
        }
    }

    /**
     * Get Rent and Own prices for a Hero
     * @param {string} managerAddress 
     */
    async getHeroPricing(managerAddress) {
        if (!managerAddress || !this.isEvmAddress(managerAddress)) return null;
        try {
            const provider = this.getReadProvider();
            // Try ExistingManager functions first (getRentalPrice / getPurchasePrice)
            const existingABI = [
                "function getRentalPrice() view returns (uint256)",
                "function getPurchasePrice() view returns (uint256)"
            ];
            const existingMgr = new window.ethers.Contract(managerAddress, existingABI, provider);
            try {
                const [rentPrice, ownPrice] = await Promise.all([
                    existingMgr.getRentalPrice(),
                    existingMgr.getPurchasePrice()
                ]);
                return {
                    rent: parseFloat(window.ethers.utils.formatUnits(rentPrice, 6)),
                    own: parseFloat(window.ethers.utils.formatUnits(ownPrice, 6))
                };
            } catch (_) {
                // Not an ExistingManager — try V2 manager (mintPriceUSDC / traderTokenPrice)
            }
            const v2ABI = [
                "function mintPriceUSDC() view returns (uint256)",
                "function traderTokenPrice() view returns (uint256)"
            ];
            const v2Mgr = new window.ethers.Contract(managerAddress, v2ABI, provider);
            const [mintPrice, tokenPrice] = await Promise.all([
                v2Mgr.mintPriceUSDC(),
                v2Mgr.traderTokenPrice()
            ]);
            return {
                rent: parseFloat(window.ethers.utils.formatUnits(mintPrice, 6)),
                own: parseFloat(window.ethers.utils.formatUnits(tokenPrice, 6))
            };
        } catch (e) {
            console.warn("[getHeroPricing] Failed:", e.message);
            return null;
        }
    }

    /**
     * Unlock (Own) a DexHero NFT permanently
     * @param {number} tokenId 
     * @param {string} managerAddress 
     */
    async unlockDexHero(tokenId, managerAddress) {
        if (!managerAddress || !tokenId) throw new Error("Missing tokenId or managerAddress");

        try {
            const readProvider = this.getReadProvider();
            const managerRead = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
            const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
            const addresses = CONTRACT_ADDRESSES[this.network];
            const usdcWrite = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);

            // 1. Get unlock cost via read provider
            const purchasePrice = await managerRead.getPurchasePrice();

            // 2. Send USDC directly to manager
            if (purchasePrice.gt(0)) {
                console.log(`Sending ${window.ethers.utils.formatUnits(purchasePrice, 6)} USDC to unlock...`);
                const transferTx = await usdcWrite.transfer(managerAddress, purchasePrice);
                await transferTx.wait();
            }

            // 3. Unlock (contract verifies it received the USDC)
            console.log(`Unlocking NFT ${tokenId} on manager ${managerAddress}...`);
            const tx = await managerWrite.unlockNFT(tokenId);
            const receipt = await tx.wait();
            console.log("Unlock confirmed ");

            return {
                success: true,
                transactionHash: receipt.transactionHash
            };
        } catch (e) {
            console.error("Unlock failed:", e);
            throw e;
        }
    }

    /**
     * Instantly buy and unlock a DexHero NFT permanently (Combines Rent + Own)
     * @param {string} managerAddress
     */
    async buyAndUnlockDexHero(managerAddress) {
        if (!managerAddress) throw new Error("Missing managerAddress");

        try {
            const readProvider = this.getReadProvider();
            const managerRead = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, readProvider);
            const managerWrite = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.signer);
            const addresses = CONTRACT_ADDRESSES[this.network];
            const usdcWrite = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);

            // 1. Get total cost (rent + unlock) via read provider
            const rentCost = await managerRead.getRentalPrice();
            const unlockCost = await managerRead.getPurchasePrice();
            const totalCost = rentCost.add(unlockCost);

            // 2. Send USDC directly to manager
            console.log(`Sending ${window.ethers.utils.formatUnits(totalCost, 6)} USDC for direct purchase...`);
            const transferTx = await usdcWrite.transfer(managerAddress, totalCost);
            await transferTx.wait();

            // 3. Buy and Unlock (contract verifies it received the USDC)
            console.log(`Minting and unlocking NFT on manager ${managerAddress}...`);
            const tx = await managerWrite.buyAndUnlockDexHero();
            const receipt = await tx.wait();
            console.log("Buy and Unlock confirmed ");

            return {
                success: true,
                transactionHash: receipt.transactionHash
            };
        } catch (e) {
            console.error("Buy and Unlock failed:", e);
            throw e;
        }
    }

    /**
     * Finds the user's NFT tokenId for a specific hero.
     * Tries enumerable interface first, falls back to event scanning for legacy heroes.
     */
    async getUserNFTTokenId(managerAddress) {
        if (!this.userAddress || !managerAddress || !this.isEvmAddress(managerAddress)) return 0;
        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            const nftAddr = await manager.sbt();
            const nft = new window.ethers.Contract(nftAddr, DEXHERO_NFT_ABI, this.getReadProvider());

            // 1. Try Enumerable (Standard for Fixed Heroes)
            try {
                const balance = await nft.balanceOf(this.userAddress);
                if (balance.toString() !== '0') {
                    const tokenId = await nft.tokenOfOwnerByIndex(this.userAddress, 0);
                    return tokenId.toNumber();
                }
            } catch (e) {
                console.log("Token not enumerable, falling back to event scanner...");
            }

            // 2. Fallback: Query Events (Legacy)
            const filter = manager.filters.SBTMinted(this.userAddress);
            const events = await manager.queryFilter(filter, -100000);

            if (events && events.length > 0) {
                return events[events.length - 1].args.tokenId.toNumber();
            }

            return 0;
        } catch (e) {
            console.error("Error discovering tokenId:", e);
            return 0;
        }
    }

    /**
     * Fetches the user's actual deposited principal for an NFT.
     */
    async getUserPrincipal(tokenId, managerAddress) {
        if (!tokenId || !managerAddress) return "0";
        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            const principal = await manager.principalOf(tokenId);
            return window.ethers.utils.formatUnits(principal, 6);
        } catch (e) {
            console.error("Failed to fetch principal:", e);
            return "0";
        }
    }

    /**
     * Checks if a specific NFT is permanently unlocked.
     */
    async isHeroUnlocked(tokenId, managerAddress) {
        if (!tokenId || !managerAddress) return false;
        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            return await manager.unlocked(tokenId);
        } catch (e) {
            console.error("Failed to fetch unlock status:", e);
            return false;
        }
    }

    /**
     * Get SBT Contract Address for a manager
     */
    async getSBTAddress(managerAddress) {
        if (!managerAddress) return null;
        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            return await manager.sbt();
        } catch (e) {
            console.error("Error fetching SBT address:", e);
            return null;
        }
    }

    /**
     * Fetches the exact price the user paid to unlock an NFT by scanning events.
     */
    async getUserUnlockPrice(tokenId, managerAddress) {
        if (!tokenId || !managerAddress) return null;
        try {
            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            const filter = manager.filters.NFTUnlocked(tokenId);
            const events = await manager.queryFilter(filter, -100000);
            if (events && events.length > 0) {
                const cost = events[events.length - 1].args.cost;
                return window.ethers.utils.formatUnits(cost, 6);
            }
            return null;
        } catch (e) {
            console.error("Failed to fetch unlock price:", e);
            return null;
        }
    }

    /**
     * Check if a wallet holds at least one unlocked NFT for a specific manager
     * @param {string} managerAddress 
     * @param {string} walletAddress 
     * @returns {Promise<boolean>}
     */
    async hasUnlockedNFT(managerAddress, walletAddress) {
        try {
            if (!managerAddress || !walletAddress || !this.isEvmAddress(managerAddress)) return false;

            const manager = new window.ethers.Contract(managerAddress, DEXHERO_MANAGER_ABI, this.getReadProvider());
            const nftAddr = await manager.sbt();
            if (!nftAddr || nftAddr === window.ethers.constants.AddressZero) {
                // No SBT configured for this manager yet
                return false;
            }

            const nft = new window.ethers.Contract(nftAddr, DEXHERO_NFT_ABI, this.getReadProvider());

            let balance;
            try {
                balance = await nft.balanceOf(walletAddress);
            } catch (e) {
                console.warn(`[Blockchain] balanceOf failed for SBT contract ${nftAddr}:`, e);
                return false;
            }
            if (balance.eq(0)) return false;

            // Check if any of the owned tokens are unlocked
            // Note: unlocked(tokenId) is on the MANAGER contract, not the NFT/SBT contract
            for (let i = 0; i < balance.toNumber(); i++) {
                try {
                    const tokenId = await nft.tokenOfOwnerByIndex(walletAddress, i);
                    const isUnlocked = await manager.unlocked(tokenId); // Fix: call on manager
                    if (isUnlocked) return true;
                } catch (e) {
                    console.warn(`[Blockchain] Error checking token at index ${i}:`, e);
                }
            }

            return false;
        } catch (error) {
            console.error("[Blockchain] Error in hasUnlockedNFT:", error);
            return false;
        }
    }

    /**
     * Pay creation fee in USDC (EVM)
     */
    async payCreationFee(amountUSDC) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        const usdc = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);
        const treasury = addresses.treasury;

        try {
            const amountWei = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);
            const normalizedTreasury = window.ethers.utils.getAddress(treasury.toLowerCase());
            console.log(` Transferring ${amountUSDC} USDC to treasury: ${normalizedTreasury}`);
            const tx = await usdc.transfer(normalizedTreasury, amountWei);
            const receipt = await tx.wait();
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error(" USDC Payment failed:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Transfer 1% of an existing ERC20 to platform treasury
     */
    async transferExistingTokens(tokenAddress, amountRaw, decimals) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        const token = new window.ethers.Contract(tokenAddress, USDC_ABI, this.signer); // USDC_ABI covers basic transfer/decimals
        const treasury = addresses.treasury;

        try {
            const normalizedTreasury = window.ethers.utils.getAddress(treasury.toLowerCase());
            console.log(` Transferring ${amountRaw} tokens to treasury: ${normalizedTreasury}`);
            const tx = await token.transfer(normalizedTreasury, amountRaw);
            const receipt = await tx.wait();
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error(" Token transfer failed:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Buy tokens using USDC via the Router
     */
    async buyTokens(tokenAddress, amountUSDC) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        if (!addresses.router) return { success: false, error: "Router not configured for this network" };

        const usdc = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);
        const router = new window.ethers.Contract(addresses.router, DEXHEROS_ROUTER_ABI, this.signer);

        try {
            const amountWei = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);

            // 1. Check Allowance (exact amount)
            console.log(`Checking USDC allowance for Router...`);
            const allowance = await usdc.allowance(this.userAddress, addresses.router);
            if (allowance.lt(amountWei)) {
                console.log(`Approving router to spend ${amountUSDC} USDC (exact amount)...`);
                const approveTx = await usdc.approve(addresses.router, amountWei);
                await approveTx.wait();
                console.log("Router Approved ");
            }

            // 2. Quote expected output and apply adaptive slippage
            let finalMinTokensOut = 0;
            try {
                const expectedOut = await router.quoteBuyTokens(amountWei);

                // For the generic router path we don't have a manager reference for spot price,
                // so use a small-amount quote to derive the spot rate
                let spotOutput;
                try {
                    const oneUSDC = window.ethers.utils.parseUnits('1', 6);
                    const spotQuote = await router.quoteBuyTokens(oneUSDC);
                    spotOutput = spotQuote.mul(amountWei).div(oneUSDC);
                } catch (e) { console.warn('[DexHero] Spot quote failed:', e.message); }

                const { slippageBps, impactBps, minOut, needsConfirmation } = calcAdaptiveSlippage(expectedOut, spotOutput);
                finalMinTokensOut = minOut;
                console.log(`Adaptive slippage: ${slippageBps}bps (impact=${impactBps}bps), minTokensOut=${finalMinTokensOut.toString()}`);

                if (needsConfirmation) {
                    const userBps = await notifyHighSlippage(impactBps, Math.min(impactBps * 2, 5000), MAX_AUTO_SLIPPAGE_BPS);
                    if (userBps === null) throw new Error('Transaction cancelled by user: high price impact');
                    finalMinTokensOut = expectedOut.mul(10000 - userBps).div(10000);
                }
            } catch (e) {
                if (e.message && e.message.includes('cancelled by user')) throw e;
                console.warn("Quote failed, proceeding without slippage protection:", e.message);
            }

            // 3. Buy tokens
            console.log(`Buying tokens for $${amountUSDC}...`);
            // buyTokens(amountUSDC, minTokensOut, checkTokenId)
            const tx = await router.buyTokens(amountWei, finalMinTokensOut, 0, { gasLimit: 300000 });
            const receipt = await tx.wait();
            console.log("Tokens purchased :", receipt.transactionHash);
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error(" buyTokens failed:", error);
            return { success: false, error: error.message };
        }
    }
}


// Initialize global instance
window.DexHeroBlockchain = new DexHeroBlockchain();

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DexHeroBlockchain;
}
