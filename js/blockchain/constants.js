/**
 * DexHero Blockchain Constants
 * Contract ABIs, addresses, network configs, and magic numbers.
 */

// ─── Magic Numbers ──────────────────────────────────────────────────────────
const BLOCK_TIME_SECONDS = 12;
const SEARCH_BUFFER_BLOCKS = 2000;
const UNISWAP_FEE_TIER = 3000; // 0.3% pool
const SLIPPAGE_PERCENT = 2; // 2% slippage tolerance
const SLIPPAGE_NUMERATOR = 98; // 100 - SLIPPAGE_PERCENT
const SLIPPAGE_DENOMINATOR = 100;
const HERO_CACHE_TTL_MS = 300000; // 5 minutes
const PLATFORM_FEE_USDC = 100;
const DEFAULT_TIPPING_POINT_USDC = "10000";
const ALCHEMY_CHUNK_SIZE = 9; // Alchemy free tier limit is 10 blocks
const DEFAULT_FALLBACK_BLOCKS = 100000;
const V1_FALLBACK_BLOCKS = 1000;
const SAFETY_LOCK_MIN_POSITIONS = 10;
const SAFETY_LOCK_MIN_CR_BPS = 500; // 5%
const DOJI_VOLUME_THRESHOLD = 1; // $1 — below this, doji candles get a tiny body
const DOJI_SPREAD_PERCENT = 0.005; // 0.5%
const V2_INITIAL_OPEN_PRICE = 0.001;
const V1_IMPACT_BASE_LIQUIDITY = 200;
const DEFAULT_TOTAL_SUPPLY_FALLBACK = 10000000;

// ─── Compute-to-Unlock Constants ────────────────────────────────────────────
const PLAY_PASS_PRICE_USDC = 100; // Fixed $100 USDC (non-refundable, permanent)
const COMPUTE_THRESHOLDS = {
    COMMON:    18000,  // ~4 months at 4h/day
    UNCOMMON:  27000,  // ~6 months
    RARE:      36000,  // ~9 months
    LEGENDARY: 54000   // ~13 months
};
const DISTINCT_DAY_REQUIREMENTS = {
    COMMON:    45,
    UNCOMMON:  60,
    RARE:      90,
    LEGENDARY: 120
};
const WEEKLY_COMPUTE_CAP = 2100; // max credited compute-minutes per week
const DEFAULT_NETWORK_UTILIZATION = 0.65; // 65% utilization factor
const DEFAULT_LEGITIMACY_SCORE = 0.90;    // 90% average legitimacy
const CONCURRENCY_MULTIPLIERS = { 1: 1.0, 2: 1.5, 3: 1.8 }; // diminishing returns

// ─── Contract ABIs ──────────────────────────────────────────────────────────
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
    // ── Read: state ──────────────────────────────────────────
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
    // ── Read: IL pool / coverage (both manager types) ────────
    "function ilCompensationPool() view returns (uint256)",
    "function coverageRatioBps() view returns (uint256)",
    "function totalFundsCollectedUSDC() view returns (uint256)",
    "function totalPrincipalOwed() view returns (uint256)",
    "function BOOTSTRAP_THRESHOLD() view returns (uint256)",
    // ── Read: two-step deposit ────────────────────────────────
    "function pendingDeposit(address) view returns (uint256)",
    // ── Write: two-step deposit flow ────────────────────────
    "function deposit() external",
    "function startPlay() external",
    "function withdrawDeposit() external",
    // ── Write: renter actions ─────────────────────────────────
    "function buyDexHero(uint256 quantity) external",
    "function redeem(uint256 tokenId) external",
    "function renewPass(uint256 tokenId) external",
    "function unlockNFT(uint256 tokenId) external",
    "function buyAndUnlockDexHero() external returns (uint256)",
    // ── Write: creator price controls (onlyOwnerOrGame) ──────
    "function setPurchasePrice(uint256 price) external",
    "function setRentalPrice(uint256 price) external",
    "function setLinearPricing(uint256 baseUSDC, uint256 incrementUSDC) external",
    // ── Write: IL pool funding (router -> IL pool) ─────────────
    "function captureSpreadUSDC(uint256 amountUSDC) external",
    // ── Events ────────────────────────────────────────────────
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

const DEXHERO_TOKEN_ABI = [
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)"
];

const PLATFORM_PLAY_PASS_ABI = [
    "function PURCHASE_AMOUNT() view returns (uint256)",
    "function hasActivePlayPass(address wallet) view returns (bool)",
    "function totalPassHolders() view returns (uint256)",
    "function purchase() external",
    "function purchaseWithPermit(uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
    "function mintPlayPass(address wallet) external",
    "function authorized(address) view returns (bool)",
    "function treasury() view returns (address)",
    "function usdcToken() view returns (address)",
    "event PlayPassMinted(address indexed wallet, uint256 usdcAmount)",
    "event AuthorizedSet(address indexed caller, bool allowed)"
];

const CROSS_CHAIN_ATTESTOR_ABI = [
    "function attestedMinutes(address wallet, uint256 dexheroId) view returns (uint256)",
    "function attestedDays(address wallet, uint256 dexheroId) view returns (uint256)",
    "function resetMinutes(address wallet, uint256 dexheroId) external",
    "event MinutesAttested(address indexed wallet, uint256 indexed dexheroId, uint256 minutes, uint256 days)",
    "event MinutesReset(address indexed wallet, uint256 indexed dexheroId)"
];

// ─── Network Configurations ─────────────────────────────────────────────────
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
        rpcUrl: '/api/rpc?network=sepolia',
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
    },
    monad: {
        chainId: '0x279f', // 10143 - Monad Testnet
        chainName: 'Monad Testnet',
        rpcUrl: 'https://testnet-rpc.monad.xyz',
        explorerUrl: 'https://testnet.monadexplorer.com',
        nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
        blockTimeMs: 500 // Monad ~500ms blocks
    }
};

// ─── Contract Addresses (Normalized to prevent checksum errors) ─────────────
const CONTRACT_ADDRESSES = {
    sepolia: {
        manager: '0xdada9d776b2d270f84966ae56ccc1a5f702a6081',
        nft: '0x6170cb78db27817dbbf8e01514fb04214b48c92d',
        usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        token: '0xcad5ccd63bdac76dcfc3ae5c846c468803ed3d93',
        launchFactory: '0xE59FFAb85cE0D65690D37614994857cA7361E48f',
        launchFactoryV1: '0x2c756575d4494480ed4882c60ec0ba7fbe95a992',
        router: '0xf99e15a28a836a9f0d62edb7952e82e8ad36b583',
        positionManager: '0x1238536071e1c677a632429e3655c799b22cda52',
        weth: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
        uniswapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48',
        uniswapQuoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        platformPlayPass: '0x0f30d05b8c284dfd975113ee60ebe360eb380fc4',
        crossChainAttestor: '0xcb466d0ea6c592c6620351467a15d86e19a269bf',
        treasury: ''
    },
    ethereum: {
        usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        uniswapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
        uniswapQuoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
    },
    bscTestnet: {
        usdc: '0x64544969ed7ebf5f083679233325356ebe738930',
        treasury: ''
    },
    baseSepolia: {
        usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        launchFactory: '0x67f584e1b4479B62A7809b9e4e498bcE4Fa4F648',
        // Populated after running blockchain/ethereum/scripts/deploy.js --network baseSepolia
        manager: '',
        nft: '',
        token: '',
        router: '',
        positionManager: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2', // Uniswap V3 NFPM on Base Sepolia
        crossChainAttestor: '', // Populated by deploy_cross_chain_attestor_base.js
        treasury: ''
    },
    // Base mainnet — THE value-layer chain per 2026-04-21 cost strategy.
    // Populated after running blockchain/ethereum/scripts/deploy.js --network base.
    base: {
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet USDC
        positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // Uniswap V3 NFPM
        weth: '0x4200000000000000000000000000000000000006',
        manager: '',
        nft: '',
        token: '',
        launchFactory: '',
        router: '',
        crossChainAttestor: '', // Populated by deploy_cross_chain_attestor_base.js
        treasury: ''
    },
    monad: {
        computeRegistry: '',  // MonadComputeRegistry — deploy and fill
        nodeRegistrar: '',    // NodeRegistrar (LayerZero OApp) — deploy and fill
        sessionVerifier: '',  // SessionVerifier — deploy and fill
        auditChallenger: ''   // AuditChallenger — deploy and fill
    }
};

// ─── Preferred default chain ─────────────────────────────────────────────
// The UI steers wallet connection + network switching toward this chain.
// 8453 = Base mainnet (prod). Set to 84532 for Base Sepolia staging.
const PREFERRED_CHAIN_ID = parseInt(
    (typeof window !== 'undefined' && window.PREFERRED_CHAIN_ID) ||
    '8453',
    10
);

// ─── Chain ID to Network Name Map ───────────────────────────────────────────
const CHAIN_ID_TO_NETWORK = {
    1: 'ethereum',
    11155111: 'sepolia',
    56: 'bnb',
    97: 'bscTestnet',
    8453: 'base',
    84532: 'baseSepolia',
    10143: 'monad'
};

// ─── Load treasury + other public config from server (.env) ─────────────────
async function loadServerConfig() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        if (cfg.treasury) {
            const t = cfg.treasury;
            Object.keys(CONTRACT_ADDRESSES).forEach(net => {
                if ('treasury' in CONTRACT_ADDRESSES[net]) {
                    CONTRACT_ADDRESSES[net].treasury = t;
                }
            });
            console.log(`Treasury loaded from server config: ${t}`);
        } else {
            console.warn('/api/config did not return a treasury address. Fee transfers may fail.');
        }
    } catch (e) {
        console.error('Could not load server config. Treasury address may be empty.', e.message);
    }
}
// Run immediately
loadServerConfig();
