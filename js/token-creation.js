(function () {
    'use strict';

    // TODO: Remove this WebSocket shim once Solana Phase 2 is fully integrated.
    // Currently blocks WS connections to localhost:8001 and Solana endpoints
    // to prevent console errors from incomplete Solana integration.
    //  GLOBAL WEBSOCKET NUKE: Silence localhost:8001 and Solana noise forever
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        if (url.includes('8001') || url.includes('solana')) {
            console.log(` Blocked WebSocket connection to: ${url}`);
            return {
                on: () => {},
                off: () => {},
                close: () => {},
                send: () => {},
                terminate: () => {},
                readyState: 3, // CLOSED
                addEventListener: () => {},
                removeEventListener: () => {}
            };
        }
        return new OriginalWebSocket(url, protocols);
    };
    // Ensure static properties are preserved
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = 0;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSING = 2;
    window.WebSocket.CLOSED = 3;

    // Configuration
    let splToken = window.splToken || window.solanaSplToken || window.solana_spl_token;
    const solanaWeb3 = window.solanaWeb3;
    // BN is replaced by native BigInt for better reliability

    function getSplToken() {
        if (!splToken) splToken = window.splToken || window.solanaSplToken || window.solana_spl_token;

        // Shim for @solana/spl-token@0.1.x (Class-based API)
        if (splToken && splToken.Token && !splToken.isShimmed) {
            console.log(' Shimming splToken 0.1.x methods with modern API wrappers...');
            const Token = splToken.Token;

            // Programs and other constants
            splToken.TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID || Token.TOKEN_PROGRAM_ID;
            splToken.ASSOCIATED_TOKEN_PROGRAM_ID = splToken.ASSOCIATED_TOKEN_PROGRAM_ID || Token.ASSOCIATED_TOKEN_PROGRAM_ID;

            // Shim getAssociatedTokenAddress
            // 0.1.x order: (associatedProgramId, programId, mint, owner, allowOwnerOffCurve)
            // Modern order: (mint, owner, allowOwnerOffCurve, programId, associatedProgramId)
            const originalGATA = Token.getAssociatedTokenAddress;
            splToken.getAssociatedTokenAddress = function (mint, owner, allowOwnerOffCurve = false, programId, associatedProgramId) {
                return originalGATA(
                    associatedProgramId || splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                    programId || splToken.TOKEN_PROGRAM_ID,
                    mint,
                    owner,
                    allowOwnerOffCurve
                );
            };

            // Shim createTransferInstruction
            // 0.1.x order: (programId, source, destination, owner, multiSigners, amount)
            // Modern order: (source, destination, owner, amount, multiSigners, programId)
            const originalCTI = Token.createTransferInstruction;
            splToken.createTransferInstruction = function (source, destination, owner, amount, multiSigners = [], programId) {
                return originalCTI(
                    programId || splToken.TOKEN_PROGRAM_ID,
                    source,
                    destination,
                    owner,
                    multiSigners,
                    amount
                );
            };

            // Shim createAssociatedTokenAccountInstruction
            // 0.1.x order: (associatedProgramId, programId, mint, associatedAccount, owner, payer)
            // Modern order: (payer, associatedAccount, owner, mint, programId, associatedTokenProgramId)
            const originalCATAI = Token.createAssociatedTokenAccountInstruction;
            splToken.createAssociatedTokenAccountInstruction = function (payer, associatedAccount, owner, mint, programId, associatedProgramId) {
                return originalCATAI(
                    associatedProgramId || splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                    programId || splToken.TOKEN_PROGRAM_ID,
                    mint,
                    associatedAccount,
                    owner,
                    payer
                );
            };

            // Shim createInitializeMintInstruction
            // 0.1.x order: (programId, mint, decimals, mintAuthority, freezeAuthority)
            // 0.1.x name: createInitMintInstruction
            // Modern order: (mint, decimals, mintAuthority, freezeAuthority, programId)
            const originalCIMI = Token.createInitMintInstruction;
            splToken.createInitializeMintInstruction = function (mint, decimals, mintAuthority, freezeAuthority, programId) {
                return originalCIMI(
                    programId || splToken.TOKEN_PROGRAM_ID,
                    mint,
                    decimals,
                    mintAuthority,
                    freezeAuthority
                );
            };

            // Shim createMintToInstruction
            // 0.1.x order: (programId, mint, destination, authority, multiSigners, amount)
            // Modern order: (mint, destination, authority, amount, multiSigners, programId)
            const originalCMTI = Token.createMintToInstruction;
            splToken.createMintToInstruction = function (mint, destination, authority, amount, multiSigners = [], programId) {
                const finalAmount = (typeof amount === 'bigint') ? amount.toString() : amount;
                return originalCMTI(
                    programId || splToken.TOKEN_PROGRAM_ID,
                    mint,
                    destination,
                    authority,
                    multiSigners,
                    finalAmount
                );
            };

            // Layouts
            splToken.MintLayout = splToken.MintLayout || Token.MintLayout;
            splToken.AccountLayout = splToken.AccountLayout || Token.AccountLayout;

            splToken.isShimmed = true;
        }

        return splToken;
    }

    if (!splToken) {
        console.debug('[splToken] library not loaded — SPL token features unavailable on this page');
    }

    // Cache for getAllTokens() — shared by getTopTokens/getTrendingTokens/getLatestTokens
    let _allTokensCache = null;
    let _allTokensCacheExpiry = 0;
    const ALL_TOKENS_CACHE_TTL = 30000; // 30 seconds

    const NETWORK = 'mainnet-beta'; // Solana network (only used for existing Solana token transfers)
    let PLATFORM_TREASURY = '7Vn9D5i5vXQ9u8fB8N3vY6w5z4v3u2t1s9r9q8p7q6n5'; // Solana treasury for existing token 1% fee
    let PLATFORM_TREASURY_EVM = '0x5cB65422ed872b9c37C5e2e35d27c929D6ca90A8';
    // EVM payment receiver for the new-token path. Server sets this to the
    // Deploy Wallet (a transient pass-through). The user's USDC lands there;
    // server pulls initialBuy via factory.createHero and forwards the rest
    // to Treasury post-deploy. Operator never has to pre-fund Deploy Wallet.
    // Falls back to Treasury for older clients/missing config.
    let PLATFORM_PAYMENT_RECEIVER_EVM = PLATFORM_TREASURY_EVM;
    const LAUNCH_FACTORY_EVM = '0xE59FFAb85cE0D65690D37614994857cA7361E48f'; // Sepolia Factory V2

    // V3 config cached for downstream UI (token-detail, panels). Held module-level
    // so consumers can `await window.tokenCreation.v3Config()` to get the latest.
    let _v3Config = { enabled: false };

    // Load dynamic config — stored as a promise so payCreationFee can await it
    const _treasuryReady = fetch('/api/config')
        .then(res => res.json())
        .then(cfg => {
            if (cfg.treasury) {
                PLATFORM_TREASURY_EVM = cfg.treasury.trim();
            }
            if (cfg.solanaTreasury) {
                PLATFORM_TREASURY = cfg.solanaTreasury.trim();
            }
            // Prefer the server-published paymentReceiver (the Deploy Wallet);
            // if missing, fall back to Treasury (legacy path).
            PLATFORM_PAYMENT_RECEIVER_EVM = (cfg.paymentReceiver || cfg.treasury || PLATFORM_TREASURY_EVM).trim();
            if (cfg.v3) _v3Config = cfg.v3;
        })
        .catch(e => console.warn('Could not load treasury config:', e.message));

    // Expose V3 config read for other modules. Returns a snapshot of the
    // server-published V3 addresses, or `{enabled: false}` if V3 isn't live.
    async function v3Config() {
        await _treasuryReady;
        return _v3Config;
    }


    /**
     * Get Solana connection based on network
     */
    function getConnection() {
        const networkParam = NETWORK === 'mainnet-beta' ? 'solana' : 'solana-devnet';
        const endpoint = `${window.location.origin}/api/rpc?network=${networkParam}`;
        
        // Robust mock to satisfy EventEmitter/WebSocket expectations in libraries
        const mockWS = () => ({
            on: () => {},
            off: () => {},
            close: () => {},
            send: () => {},
            terminate: () => {},
            readyState: 3,
            addEventListener: () => {},
            removeEventListener: () => {}
        });

        return new solanaWeb3.Connection(endpoint, { 
            commitment: 'confirmed', 
            wsEndpoint: '',
            webSocketFactory: mockWS
        });
    }

    /**
     * Create new DexHero token (pays USDC fee + server deploys EVM contracts)
     */
    // Sign an EIP-2612 permit on USDC for FeeRouter to pull `amount` USDC
    // from the user. Offchain — no gas, no MetaMask "send tx" popup, just
    // a typed-data signature prompt. Returns { v, r, s, deadline }.
    async function _signUsdcPermit({ usdcAddress, owner, spender, amount, signer }) {
        const ethers = window.ethers;
        const erc20Permit = new ethers.Contract(usdcAddress, [
            'function name() view returns (string)',
            'function nonces(address) view returns (uint256)',
            'function version() view returns (string)',
            'function DOMAIN_SEPARATOR() view returns (bytes32)',
        ], signer.provider || signer);
        const [name, nonce] = await Promise.all([
            erc20Permit.name().catch(() => 'USD Coin'),
            erc20Permit.nonces(owner),
        ]);
        // Most ERC20Permit deployments expose version() — fall back to '2'
        // (the value Circle's USDC + Aave's GHO use) when missing.
        let version = '2';
        try { version = await erc20Permit.version(); } catch {}
        const chainId = (await signer.getChainId?.()) || (await signer.provider.getNetwork()).chainId;
        const deadline = Math.floor(Date.now() / 1000) + 30 * 60; // 30 minutes from now
        const domain = { name, version, chainId, verifyingContract: usdcAddress };
        const types = {
            Permit: [
                { name: 'owner',    type: 'address' },
                { name: 'spender',  type: 'address' },
                { name: 'value',    type: 'uint256' },
                { name: 'nonce',    type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ],
        };
        const value = { owner, spender, value: amount, nonce, deadline };
        const sig = await signer._signTypedData(domain, types, value);
        const { v, r, s } = ethers.utils.splitSignature(sig);
        return { v, r, s, deadline };
    }

    // Atomic create-DexHero via FeeRouter — simple approve+create flow.
    //
    // First-time UX: 2 popups (approve USDC for FeeRouter once with
    // MaxUint256, then createDexHero). Every subsequent deploy from this
    // wallet: 1 popup (just createDexHero) because the allowance is
    // already in place. Same pattern as Uniswap / 1inch / Aave routers.
    //
    // Returns the same shape as the legacy launchHeroExistingServer
    // result so create-dexhero.html doesn't need to change downstream.
    async function createNewTokenViaFeeRouter(params, baseFeeUSDC, initialBuyUSDC, onStatusUpdate) {
        const ethers = window.ethers;
        if (!ethers) throw new Error('ethers.js not loaded');
        const signer = window.DexHeroBlockchain.signer;
        const user = await signer.getAddress();

        // 1. Pull live config: FeeRouter + USDC.
        onStatusUpdate(' Loading platform config…');
        const cfg = await fetch('/api/config').then(r => r.json());
        const feeRouterAddr = cfg.feeRouter;
        const usdcAddr      = cfg.usdc;
        if (!feeRouterAddr || !/^0x[a-fA-F0-9]{40}$/.test(feeRouterAddr)) {
            throw new Error('FeeRouter address not configured server-side. /api/config.feeRouter is missing.');
        }
        if (!usdcAddr) throw new Error('USDC address not configured.');

        // 2. Check user USDC balance + allowance.
        const usdc = new ethers.Contract(usdcAddr, [
            'function balanceOf(address) view returns (uint256)',
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
        ], signer);
        const totalFeeRaw = ethers.utils.parseUnits(String(baseFeeUSDC + initialBuyUSDC), 6);
        const have = await usdc.balanceOf(user);
        if (have.lt(totalFeeRaw)) {
            throw new Error(
                `Insufficient USDC: need ${ethers.utils.formatUnits(totalFeeRaw, 6)}, have ${ethers.utils.formatUnits(have, 6)}.\n` +
                `Get Sepolia USDC: https://faucet.circle.com or https://staging.aave.com/faucet/`
            );
        }

        // 3. Ensure FeeRouter has allowance to pull the fee. First-time
        //    users hit one approve tx; subsequent deploys reuse the same
        //    MaxUint256 allowance and skip this step entirely.
        const allowance = await usdc.allowance(user, feeRouterAddr);
        if (allowance.lt(totalFeeRaw)) {
            onStatusUpdate(' One-time USDC approval (skipped on future deploys)…');
            const approveTx = await usdc.approve(feeRouterAddr, ethers.constants.MaxUint256);
            onStatusUpdate(`⏳ Approval tx: ${approveTx.hash.slice(0, 10)}…`);
            await approveTx.wait();
            onStatusUpdate(' Approval confirmed. Submitting create…');
        }

        // 4. Build the CreateParams struct matching FeeRouter.sol.
        const characterId = ethers.utils.keccak256(
            ethers.utils.toUtf8Bytes((params.modelUrl || '') + ':' + Date.now())
        );
        const tippingPointUSDC      = ethers.utils.parseUnits(String(params.tippingPoint || 10000), 6);
        const mintPriceUSDC         = ethers.utils.parseUnits(String(params.mintPrice || params.purchasePrice || 10), 6);
        const initialBuyRaw         = ethers.utils.parseUnits(String(initialBuyUSDC || 0), 6);
        const traderSpreadBps       = Math.min(Math.round(parseFloat(params.taxPercentage || 5) * 100), 1000);
        const initialBuySlippageBps = Math.min(Math.round(parseFloat(params.initialBuySlippageBps) || 0), 5000);

        const createParams = {
            gameCollector:         user,
            tokenName:             params.name,
            tokenSymbol:           params.symbol || 'HERO',
            nftName:               params.name + ' Access',
            nftSymbol:             (params.symbol || 'HERO') + 'NFT',
            tippingPointUSDC,
            mintPriceUSDC,
            initialBuyUSDC:        initialBuyRaw,
            dexheroCharacterId:    characterId,
            traderSpreadBps,
            initialBuySlippageBps,
        };

        // 5. Submit FeeRouter.createDexHero — single atomic tx.
        onStatusUpdate(' Submitting atomic create tx…');
        const platformFeeRaw = ethers.utils.parseUnits(String(baseFeeUSDC), 6);
        const feeRouter = new ethers.Contract(feeRouterAddr, [
            'function createDexHero(uint256 platformFeeUSDC, tuple(address gameCollector, string tokenName, string tokenSymbol, string nftName, string nftSymbol, uint256 tippingPointUSDC, uint256 mintPriceUSDC, uint256 initialBuyUSDC, bytes32 dexheroCharacterId, uint256 traderSpreadBps, uint256 initialBuySlippageBps) p) external returns (address manager, address token, address sbt, address router)',
            'event DexHeroCreatedViaRouter(address indexed creator, address indexed gameCollector, address manager, address token, address sbt, address router, uint256 platformFeeUSDC, uint256 initialBuyUSDC)',
        ], signer);
        const tx = await feeRouter.createDexHero(
            platformFeeRaw,
            createParams,
            { gasLimit: 5_000_000 },
        );
        onStatusUpdate(`⏳ Tx submitted: ${tx.hash.slice(0, 10)}…`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
            throw new Error(`FeeRouter tx reverted on-chain: ${tx.hash}`);
        }

        // 6. Parse the event for hero addresses.
        const iface = new ethers.utils.Interface([
            'event DexHeroCreatedViaRouter(address indexed creator, address indexed gameCollector, address manager, address token, address sbt, address router, uint256 platformFeeUSDC, uint256 initialBuyUSDC)',
        ]);
        let parsed = null;
        for (const log of receipt.logs) {
            try {
                const p = iface.parseLog(log);
                if (p.name === 'DexHeroCreatedViaRouter') { parsed = p; break; }
            } catch {}
        }
        if (!parsed) {
            throw new Error('Atomic create succeeded but no DexHeroCreatedViaRouter event found in receipt.');
        }

        const manager        = parsed.args.manager;
        const tokenAddr      = parsed.args.token;
        const sbt            = parsed.args.sbt;
        const router         = parsed.args.router;
        onStatusUpdate(` Deployed: manager=${manager.slice(0,8)}… token=${tokenAddr.slice(0,8)}…`);

        // 7. Post-create bookkeeping on the server (token row + sprite gen).
        //    /api/dexhero/save-after-deploy is the new minimal endpoint that
        //    persists the on-chain addresses + form metadata. Sprite gen
        //    fires async in the same handler.
        try {
            await fetch('/api/dexhero/save-after-deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    txHash:           receipt.transactionHash,
                    creator:          user,
                    manager,
                    contractAddress:  tokenAddr,
                    sbt,
                    router,
                    params,
                    network:          'sepolia',
                }),
            });
        } catch (e) {
            console.warn('[FeeRouter] post-deploy save failed (non-fatal):', e.message);
        }

        return {
            success:            true,
            transactionHash:    receipt.transactionHash,
            transactionSignature: receipt.transactionHash,
            paymentSignature:   receipt.transactionHash, // same tx pays + deploys atomically
            manager,
            token:              tokenAddr,
            contract_address:   tokenAddr,
            sbt,
            router,
            ownerAddress:       user,
            chain:              'sepolia',
            network:            'sepolia',
            mintAddress:        manager,
        };
    }

    async function createNewToken(params, onStatusUpdate = () => { }) {
        try {
            if (!window.DexHeroBlockchain || !window.DexHeroBlockchain.signer) {
                throw new Error('No wallet connected. Please connect a wallet.');
            }

            const wallet = await window.DexHeroBlockchain.signer.getAddress();
            try {
                console.log(' Creating New DexHero token:', params.name);

                // 1. Pay Creation Fee (USDC) — base fee + initial buy in one transaction
                // Base fee comes from the live V3 factory (cfg.v3.platformFeeUSDC)
                // so testnet/temporary fee changes propagate to the UI without a
                // frontend redeploy. Falls back to the legacy $100 if V3 disabled.
                const initialBuyUSDC = parseFloat(params.initialBuyUSDC || 0);
                const cfg = await (window._configPromise ||= fetch('/api/config').then(r => r.ok ? r.json() : {}));
                const liveFee = cfg?.v3?.platformFeeUSDC != null
                    ? Number(cfg.v3.platformFeeUSDC) / 1e6
                    : 100;
                const baseFeeUSDC = params.referralWallet ? +(liveFee * 0.9).toFixed(2) : liveFee;
                const totalFeeUSDC = baseFeeUSDC + initialBuyUSDC;

                // No platform-readiness preflight needed: the user's own USDC
                // funds the factory's initial-buy pull, so the Deploy Wallet
                // doesn't have to be pre-funded. Capital lockup on the
                // operator side is permanently zero.

                onStatusUpdate(` Paying ${totalFeeUSDC} USDC (${baseFeeUSDC} creation fee${params.referralWallet ? ' with referral discount' : ''}${initialBuyUSDC > 0 ? ` + ${initialBuyUSDC.toFixed(2)} initial buy` : ''})...`);
                const paymentResult = await payCreationFee(totalFeeUSDC, onStatusUpdate);
                if (!paymentResult.success) throw new Error(paymentResult.error);
                onStatusUpdate(" Payment confirmed. Starting deployment...");

                // Tell the server what fee we actually paid so its verifier
                // matches the live V3 factory fee (1 USDC during testing, 100
                // in production). Without this it defaults to 100 and rejects
                // any deploy where the user paid less.
                params.feeAmountUSDC = baseFeeUSDC;

                // 2. Server-side deployment — Deploy Wallet calls factory.createHero
                onStatusUpdate(" Triggering Automated Build on EVM...");
                const launchResult = await launchHeroExistingServer(params, paymentResult.transactionHash || paymentResult.signature, onStatusUpdate);

                return {
                    success: true,
                    ...launchResult,
                    createdBy: wallet,
                    name: params.name,
                    symbol: params.symbol,
                    decimals: params.decimals || 9,
                    supply: params.initialSupply || 10000000,
                    imageUrl: params.imageUrl,
                    modelUrl: params.modelUrl,
                    description: params.description,
                    taxPercentage: params.taxPercentage || 10,
                    rentalPrice: params.rentalPrice,
                    purchasePrice: params.purchasePrice,
                    priceIncrement: params.priceIncrement,
                    network: NETWORK,
                    paymentSignature: paymentResult.transactionHash || paymentResult.signature,
                    transactionSignature: launchResult.transactionHash || launchResult.signature,
                    explorerUrl: launchResult.mintAddress ? `https://sepolia.etherscan.io/address/${launchResult.mintAddress}` : null,
                    heroInstance: launchResult.heroInstance
                };

            } catch (error) {
                console.error(' Token creation error:', error);
                return { success: false, error: error.message };
            }
        } catch (error) {
            console.error(' Token creation error:', error);
            return { success: false, error: error.message };
        }
    }


    /**
     * Setup DexHero with an existing token (Solana or EVM)
     * Solana tokens: 1% SPL transfer via Phantom, then server wraps in EVM contracts
     * EVM tokens: 1% ERC20 transfer, then server deploys EVM contracts
     */
    async function setupExistingToken(params, onStatusUpdate = () => { }) {
        try {
            const tokenAddress = params.existingTokenAddress.trim();
            const isSolana = window.DexHeroScanner.isSolanaAddress(tokenAddress);
            const isEVM = window.DexHeroScanner.isEVMAddress(tokenAddress);

            console.log(` Setting up Existing Token (Hybrid)... Chain: ${isSolana ? 'Solana' : (isEVM ? 'EVM' : 'Unknown')}`);

            // Existing-token DexHeros use the supply contribution itself
            // (1 token to the treasury) AS the creation fee. No USDC is
            // charged. This was a deliberate change after the original flow
            // double-charged users (USDC + token); the token transfer is
            // sufficient skin-in-the-game proof.

            if (isSolana) {
                // 1. Transfer 1 token of the Solana mint to the platform treasury
                onStatusUpdate(" Initiating Solana Token Transfer (1 token → treasury)...");
                const transferResult = await transferExistingTokens(tokenAddress, params.onePercentRaw, params.decimals, onStatusUpdate);
                if (!transferResult.success) throw new Error(`Solana Transfer Failed: ${transferResult.error}`);

                // 2. Server deployment — pass null for the (now unused) USDC tx hash
                onStatusUpdate(" Triggering Automated Build on EVM...");
                return await launchHeroExistingServer(params, transferResult.signature, onStatusUpdate, null);
            }
            else if (isEVM) {
                // 1. Request a Sovereign Dynamic Fee quote from the server
                //    (dynamic % of supply, scaled by MC + liquidity).
                const chainId = resolveChainId();
                const creatorWallet = await (window.DexHeroBlockchain?.signer?.getAddress?.() || Promise.resolve(null));
                if (!creatorWallet) throw new Error('Creator wallet unavailable for fee quote.');
                const quote = await requestSovereignQuote(tokenAddress, chainId, creatorWallet, onStatusUpdate);

                // 2. Transfer the fee amount (currently hardcoded to 1 token in
                //    the scanner) to the SovereignFeeVault.
                onStatusUpdate(" Transferring 1 token to Sovereign Vault...");
                const transferResult = await transferExistingTokensEVM(
                    tokenAddress,
                    quote.expectedFeeAmountRaw,
                    quote.decimals,
                    onStatusUpdate,
                    quote.vaultAddress,
                );
                if (!transferResult.success) throw new Error(`EVM Transfer Failed: ${transferResult.error}`);

                // 3. Server deployment — pass the quoteNonce so the server can
                //    match the on-chain transfer to the signed quote and relay
                //    vault.depositFee. usdcTxHash is null (no USDC fee).
                onStatusUpdate(" Triggering Automated Build on EVM...");
                return await launchHeroExistingServer(
                    params,
                    transferResult.signature,
                    onStatusUpdate,
                    null,
                    quote.quoteNonce,
                );
            }
            else {
                throw new Error("Invalid address format. Please provide a Solana (Base58) or EVM (0x) address.");
            }
        } catch (error) {
            console.error(' Hybrid Setup Failed:', error);
            throw error;
        }
    }
    /**
     * Pay creation fee in USDC — supports both EVM and Solana
     */
    async function payCreationFee(amountUSDC, onStatusUpdate = () => {}) {
        console.log(` Paying ${amountUSDC} USDC creation fee...`);
        try {
            if (!window.DexHeroBlockchain || !window.DexHeroBlockchain.signer) {
                throw new Error('No wallet connected. Please connect a wallet.');
            }

            await _treasuryReady;

            const signer = window.DexHeroBlockchain.signer;

            const USDC_ADDRESSES = {
                sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
                ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                bscTestnet: '0x64544969ed7EBf5f083679233325356EbE738930',
                bsc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
                baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            };
            const CHAIN_TO_NETWORK = {
                11155111: 'sepolia',
                1:        'ethereum',
                56:       'bsc',
                97:       'bscTestnet',
                8453:     'base',
                84532:    'baseSepolia',
            };

            // Derive the network from the wallet's CURRENT chainId rather
            // than the stale window.DexHeroBlockchain.network field — that
            // cache is set at connect time and doesn't update when the user
            // switches networks in MetaMask, which previously caused the
            // dapp to ask MetaMask to switch from Sepolia → mainnet.
            const walletChainId = await signer.getChainId();
            const network = CHAIN_TO_NETWORK[walletChainId] || window.DexHeroBlockchain.network || 'sepolia';

            const usdcAddress = USDC_ADDRESSES[network];
            if (!usdcAddress) {
                throw new Error(
                    `No USDC contract configured for the wallet's current chain (chainId ${walletChainId}). ` +
                    `Switch MetaMask to Sepolia, Ethereum, BNB, or Base before paying the creation fee.`
                );
            }

            // payCreationFee is shared between new-token and existing-token
            // paths. New-token sends to the Deploy Wallet (pass-through);
            // existing-token uses the existing Sovereign Vault flow elsewhere
            // and doesn't hit this function. So always route to the
            // paymentReceiver, which the server resolves to the Deploy Wallet.
            const TREASURY = PLATFORM_PAYMENT_RECEIVER_EVM;
            if (!TREASURY) throw new Error('Platform payment receiver not configured.');

            const usdcAbi = [
                'function transfer(address to, uint256 amount) returns (bool)',
                'function balanceOf(address account) view returns (uint256)',
            ];
            const usdc = new window.ethers.Contract(usdcAddress, usdcAbi, signer);
            const amount = window.ethers.utils.parseUnits(amountUSDC.toString(), 6); // USDC is always 6 decimals

            // Pre-flight balance check — gives a clear error instead of cryptic gas estimation failure
            const walletAddr = await signer.getAddress();
            const balance = await usdc.balanceOf(walletAddr);
            if (balance.lt(amount)) {
                const have = window.ethers.utils.formatUnits(balance, 6);
                throw new Error(
                    `Insufficient USDC balance on ${network}.\n` +
                    `Need: ${amountUSDC} USDC\n` +
                    `Have: ${have} USDC\n` +
                    `USDC contract: ${usdcAddress}\n\n` +
                    `If you have USDC on a different network or from a different faucet, it won't show here. ` +
                    `Get Sepolia USDC from the Aave faucet: https://staging.aave.com/faucet/`
                );
            }

            console.log(`[EVM Fee] Sending ${amountUSDC} USDC to treasury ${TREASURY}`);
            const tx = await usdc.transfer(TREASURY, amount);
            const receipt = await tx.wait();

            console.log(' EVM payment successful:', receipt.transactionHash);
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error(' Payment failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Transfer 1% of tokens to platform
     */
    /**
     * Transfer 1% of tokens to platform
     */
    async function transferExistingTokens(tokenAddress, onePercentRaw, decimals, onStatusUpdate = () => { }) {
        // Support object argument (Solana parity)
        if (typeof tokenAddress === 'object') {
            const params = tokenAddress;
            tokenAddress = params.tokenAddress || params.address;
            onePercentRaw = params.onePercentRaw || params.amount;
            decimals = params.decimals;
        }

        console.log(` Transferring 1% of ${tokenAddress} to platform...`);
        try {
            //  EVM path 
            if (window.DexHeroBlockchain && (window.DexHeroBlockchain.signer || window.DexHeroBlockchain.userAddress)) {
                // If it's a valid EVM address, use the blockchain module
                if (tokenAddress && tokenAddress.startsWith('0x')) {
                    console.log("[TokenModule] Delegating to DexHeroBlockchain for EVM transfer...");
                    return await window.DexHeroBlockchain.transferExistingTokens(tokenAddress, onePercentRaw, decimals);
                }
            }

            //  Solana path 
            const provider = window.solana;
            if (!provider) throw new Error("Solana wallet not found. Please install Phantom.");
            // Ensure Solana wallet is actively connected (publicKey from a prior session isn't enough)
            if (!provider.isConnected) {
                console.log('[Solana] Requesting wallet connection...');
                await provider.connect();
            }
            if (!provider.publicKey) throw new Error("Solana wallet not connected");

            const wallet = provider.publicKey;
            const connection = getConnection();

            const activeSplToken = getSplToken();
            if (!activeSplToken) {
                throw new Error("Solana SPL Token library not loaded. Please wait a moment and try again.");
            }

            console.log(` Debug Transfer: tokenAddress="${tokenAddress}", treasury="${PLATFORM_TREASURY}"`);
            const tokenMint = new solanaWeb3.PublicKey(tokenAddress.trim());
            const treasury = new solanaWeb3.PublicKey(PLATFORM_TREASURY.trim());

            const fromATA = await activeSplToken.getAssociatedTokenAddress(
                tokenMint,
                wallet,
                false,
                activeSplToken.TOKEN_PROGRAM_ID,
                activeSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
            );

            // Check if source ATA exists and has balance
            try {
                const balanceInfo = await connection.getTokenAccountBalance(fromATA);
                const userBalance = BigInt(balanceInfo.value.amount);
                const required = BigInt(onePercentRaw);
                console.log(` Token Balance: ${balanceInfo.value.uiAmountString}, Required: ${required.toString()} (raw)`);
                
                if (userBalance < required) {
                    throw new Error(`Insufficient token balance. You have ${balanceInfo.value.uiAmountString} but need at least ${formattedAmount(required, decimals)}.`);
                }
            } catch (e) {
                if (e.message.includes('could not find account')) {
                    throw new Error("You do not own any tokens of this mint. Please make sure you have the tokens in your wallet.");
                }
                throw e;
            }

            const toATA = await activeSplToken.getAssociatedTokenAddress(
                tokenMint,
                treasury,
                false,
                activeSplToken.TOKEN_PROGRAM_ID,
                activeSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
            );
            const transaction = new solanaWeb3.Transaction();
            // Check if destination ATA exists
            const toATAInfo = await connection.getAccountInfo(toATA);
            if (!toATAInfo) {
                console.log(" Treasury ATA does not exist, adding creation instruction...");
                transaction.add(
                    activeSplToken.createAssociatedTokenAccountInstruction(
                        wallet,
                        toATA,
                        treasury,
                        tokenMint,
                        activeSplToken.TOKEN_PROGRAM_ID,
                        activeSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
                    )
                );
            }
            
            console.log(` Adding transfer instruction for ${onePercentRaw} raw units...`);
            transaction.add(
                activeSplToken.createTransferInstruction(
                    fromATA,
                    toATA,
                    wallet,
                    BigInt(onePercentRaw),
                    [],
                    activeSplToken.TOKEN_PROGRAM_ID
                )
            );

            // Add small helper to format amount for error messages
            function formattedAmount(raw, dec) {
                return (Number(raw) / Math.pow(10, dec)).toFixed(4);
            }

            // Use 'finalized' commitment so the blockhash is recognized across RPC nodes
            const latestBlockhash = await connection.getLatestBlockhash('finalized');
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = wallet;

            onStatusUpdate(" Signing Token Transfer...");
            const { signature } = await provider.signAndSendTransaction(transaction);
            console.log(" Transaction confirmed:", signature);

            console.log(' Solana token transfer successful:', signature);
            return { success: true, signature, transactionHash: signature };
        } catch (error) {
            console.error(' Token transfer failed:', error);
            return { success: false, error: error.message };
        }
    }
    /**
     * Transfer 1% of an existing EVM token to the platform
     */
    async function transferExistingTokensEVM(tokenAddress, amountRaw, decimals, onStatusUpdate = () => { }, destinationOverride = null) {
        try {
            if (typeof window.ethers === 'undefined') {
                throw new Error("Ethers.js library not loaded. Please ensure you are on a compatible browser.");
            }

            const evmProvider = getMetaMaskProvider();
            if (!evmProvider) throw new Error("MetaMask not connected. Required for EVM token transfer.");

            const provider = new ethers.providers.Web3Provider(evmProvider);
            const signer = provider.getSigner();
            const wallet = await signer.getAddress();

            onStatusUpdate(" Preparing EVM Transfer...");

            const erc20 = new ethers.Contract(tokenAddress, [
                "function transfer(address to, uint256 amount) public returns (bool)",
                "function balanceOf(address owner) view returns (uint256)",
                "function decimals() view returns (uint8)"
            ], signer);

            const destination = destinationOverride || PLATFORM_TREASURY_EVM;
            if (!destination) throw new Error("EVM transfer destination not configured.");

            // Verify Balance
            const balance = await erc20.balanceOf(wallet);
            if (balance.lt(ethers.BigNumber.from(amountRaw))) {
                throw new Error(`Insufficient token balance on EVM. You have ${ethers.utils.formatUnits(balance, decimals)} but need at least ${ethers.utils.formatUnits(amountRaw, decimals)}.`);
            }

            onStatusUpdate(" Signing EVM Token Transfer (MetaMask)...");
            const tx = await erc20.transfer(destination, amountRaw);

            onStatusUpdate("⏳ Confirming EVM Transaction...");
            const receipt = await tx.wait();

            console.log(' EVM token transfer successful:', receipt.transactionHash);
            return { success: true, signature: receipt.transactionHash, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error(' EVM Token transfer failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Request a signed Sovereign Fee quote from the server. Returns
     *   { quoteNonce, feeBps, feePercent, expectedFeeAmountRaw, decimals, symbol,
     *     mcUsd, liquidityUsd, source, vaultAddress, expiresAt }
     * Shows a confirmation dialog; rejects if user cancels.
     */
    async function requestSovereignQuote(tokenAddress, chainId, creatorWallet, onStatusUpdate = () => {}) {
        onStatusUpdate(" Scanning token market cap & liquidity...");
        const res = await fetch('/api/dexhero/quote-fee', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenAddress, chainId, creatorWallet }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Fee quote failed: ${err.error || res.statusText}`);
        }
        const q = await res.json();

        const humanAmt = window.ethers.utils.formatUnits(q.expectedFeeAmountRaw, q.decimals);
        const mcDisplay = '$' + Number(q.mcUsd).toLocaleString();
        const liqDisplay = '$' + Number(q.liquidityUsd).toLocaleString();
        const msg = [
            `Sovereign Dynamic Fee`,
            `MC: ${mcDisplay}  Liquidity: ${liqDisplay}  (source: ${q.source})`,
            `Fee: ${q.feePercent}% of supply = ${humanAmt} ${q.symbol}`,
            `Escrow: 10 years, 1/120 released monthly to platform treasury`,
            `Expires: ${q.expiresAt}`,
            ``,
            `Confirm the transfer?`,
        ].join('\n');
        if (!window.confirm(msg)) throw new Error('Fee confirmation cancelled by user.');
        return q;
    }

    // Map the blockchain.js `network` string to an EVM chain id for the quote endpoint.
    function resolveChainId() {
        const net = window.DexHeroBlockchain?.network || 'sepolia';
        return ({ sepolia: 11155111, ethereum: 1, base: 8453, baseSepolia: 84532, bsc: 56, bscTestnet: 97 })[net] || 11155111;
    }

    /**
     * Launch Hero on EVM via Server-Side Automated Build
     */
    async function launchHeroExistingServer(params, txHash, onStatusUpdate = () => { }, usdcTxHash = null, quoteNonce = null) {
        try {
            onStatusUpdate(" Sending build request to platform...");
            
            // Get user's EVM address — used as the SBT destination ONLY (no
            // signing on Sepolia for existing-token DexHeros). handleCreate
            // populates window._existingEvmCollector when the creator pasted
            // an address into the prompt OR pulled it from eth_accounts; that
            // wins ahead of every other source. Otherwise fall back to the
            // signer / unified-wallet / eth_accounts chain.
            const signerAddress = window.DexHeroBlockchain?.signer ? await window.DexHeroBlockchain.signer.getAddress() : null;
            const evmCollector = window._existingEvmCollector
                || signerAddress
                || window.UnifiedWallet?.evmAddress
                || (typeof window.ethereum !== 'undefined' ? (await window.ethereum.request({ method: 'eth_accounts' }))[0] : null);

            console.log(`[Deploy] evmCollector resolved to: ${evmCollector} (stashed: ${window._existingEvmCollector}, signer: ${signerAddress}, unified: ${window.UnifiedWallet?.evmAddress})`);

            if (!evmCollector && window.DexHeroScanner.isSolanaAddress(params.existingTokenAddress)) {
                onStatusUpdate(" EVM destination address required to receive the DexHero NFT.");
                throw new Error("Need an EVM (Sepolia) address to receive the DexHero NFT — paste one or connect a wallet that exposes one.");
            }

            const response = await fetch('/api/dexhero/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    txHash,
                    usdcTxHash,  // for existing token path: the USDC fee payment hash
                    params,
                    evmCollector,
                    quoteNonce,  // sovereign dynamic fee: pairs txHash with a signed quote
                })
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Server-side deployment failed.");

            // Server responds 202 with a jobId — poll until complete
            let finalResult = result;
            if (response.status === 202 && result.jobId) {
                const jobId = result.jobId;
                onStatusUpdate('⏳ Deploying contracts on-chain…');
                const POLL_INTERVAL = 3000;  // 3 seconds
                const POLL_TIMEOUT  = 300000; // 5 minutes
                const deadline = Date.now() + POLL_TIMEOUT;
                while (Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, POLL_INTERVAL));
                    const pollRes = await fetch(`/api/dexhero/deploy/status?jobId=${encodeURIComponent(jobId)}`);
                    if (!pollRes.ok) continue; // transient error — keep polling
                    const pollData = await pollRes.json();
                    if (pollData.status === 'complete') {
                        finalResult = pollData.result || pollData;
                        break;
                    }
                    if (pollData.status === 'failed') {
                        throw new Error(pollData.error || 'Deployment failed on server.');
                    }
                    // still pending — keep waiting
                }
                if (Date.now() >= deadline && finalResult.status !== 'complete') {
                    throw new Error('Deployment timed out. Please contact support with your transaction hash.');
                }
            }

            if (!finalResult.manager || finalResult.manager === '0x0000000000000000000000000000000000000000') {
                throw new Error("Deployment succeeded on-chain but no manager contract address was returned. Creation cannot continue.");
            }

            console.log(' Server-side Deployment Successful:', finalResult.manager, '| Owner:', finalResult.ownerAddress, '| NFT:', finalResult.creatorNftId, '| NFT Error:', finalResult.nftError || 'none');
            if (finalResult.nftError) {
                onStatusUpdate(` Creator NFT mint failed: ${finalResult.nftError}`);
            }
            if (finalResult.creatorNftId) {
                onStatusUpdate(` Creator NFT #${finalResult.creatorNftId} minted and sent to ${finalResult.ownerAddress}`);
            }

            // SBT artwork is automatic on V3 — the SBT template's tokenURI
            // override returns a deterministic URL (api/sbt/<sbt>/<id>) when
            // no per-token URI is set. No post-deploy signature required.
            // Genesis holders override images by updating the DexHero row in
            // Supabase (any change to image_url is reflected immediately by
            // the metadata endpoint) or via Manager.setSbtMetadataBase.
            return {
                ...finalResult,
                chain: 'sepolia',
                manager: finalResult.manager,
                manager_address: finalResult.manager,
                router_address: finalResult.router_address || null,
                signature: txHash,
                mintAddress: finalResult.contract_address
            };
        } catch (error) {
            console.error(' Server-side Deployment failed:', error);
            throw error;
        }
    }

    async function saveTokenToDatabase(tokenData) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            console.log(' Saving to database (Server-side):', tokenData);

            const response = await fetch('/api/tokens/upsert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: tokenData.name,
                    symbol: tokenData.symbol,
                    creator_wallet: tokenData.createdBy,
                    contract_address: tokenData.mintAddress,
                    chain: 'ethereum',
                    network: tokenData.network || 'sepolia',
                    manager_address: tokenData.manager_address || null,
                    factory_address: tokenData.factory_address || null,
                    launch_type: tokenData.launchType || 'new',
                    purchase_price_usdc: tokenData.purchasePrice || null,
                    rental_price_usdc: tokenData.rentalPrice || null,
                    price_increment_usdc: tokenData.priceIncrement || null,
                    tipping_point_reached: false,
                    router_address: tokenData.router_address || null,
                    image_url: tokenData.imageUrl,
                    model_url: tokenData.modelUrl,
                    description: tokenData.description,
                    tax_percentage: tokenData.taxPercentage,
                    player_share: tokenData.playerShare,
                    trader_share: tokenData.traderShare,
                    initial_liquidity: tokenData.initialLiquidity || 0,
                    token_decimals: tokenData.decimals,
                    total_supply: tokenData.total_supply || tokenData.supply || tokenData.initialSupply || 0,
                    metadata: {
                        transaction_signature: tokenData.transactionSignature,
                        explorer_url: tokenData.explorerUrl,
                        token_account: tokenData.tokenAccount || null,
                        existingTokenAddress: tokenData.existingTokenAddress || null,
                        blockchain: tokenData.blockchain || null,
                        manager_address: tokenData.manager_address || null,
                        router_address: tokenData.router_address || null,
                        token_address: tokenData.token_address || null
                    }
                })
            });

            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Server-side save failed');

            const data = result.data;
            console.log(' Token saved via server:', data);


            // 2. Handle Referral tracking if present.
            // Priority: referralWallet passed explicitly in params > sessionStorage fallback.
            // Server-gated via POST /api/referrals/log so the anon client
            // can't forge (referee=victim, referrer=attacker) rows. Referee
            // (the buyer) signs "DexHero Referral <ts>" with their wallet;
            // server verifies via the same EIP-191 helper that gates chat,
            // brain-config, and module-equip. Non-blocking: signature
            // rejection / network error doesn't break the deploy — the
            // token is created either way; the referrer just doesn't get
            // credited.
            const referrer = tokenData.referralWallet || sessionStorage.getItem('dexhero_referrer');
            if (referrer && data.id) {
                console.log(' Recording referral for:', referrer);
                try {
                    const signer = window.DexHeroBlockchain?.signer;
                    if (!signer) throw new Error('signer_unavailable');
                    const signedMsg = `DexHero Referral ${Date.now()}`;
                    const signature = await signer.signMessage(signedMsg);
                    const r = await fetch('/api/referrals/log', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            referrer,
                            referee:   tokenData.createdBy,
                            tokenId:   data.id,
                            signature,
                            signedMsg,
                        }),
                    });
                    if (!r.ok) throw new Error(`status_${r.status}`);
                    console.log(' Referral recorded: 50 USDC commission for', referrer);
                } catch (refError) {
                    console.error(' Referral recording failed:', refError?.message || refError);
                }
            }

            return {
                success: true,
                id: data.id,
                data
            };

        } catch (error) {
            console.error(' Save failed:', error);
            return {
                success: false,
                error: error.message || 'Database save failed'
            };
        }
    }

    /**
     * Get tokens created by a wallet
     */
    async function getUserTokens(walletAddress) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            const { data, error } = await supabase
                .from('tokens')
                .select('*')
                .eq('creator_wallet', walletAddress)
                .order('created_at', { ascending: false });

            if (error) throw error;

            return {
                success: true,
                tokens: data || []
            };

        } catch (error) {
            console.error('Error fetching user tokens:', error);
            return {
                success: false,
                tokens: [],
                error: error.message
            };
        }
    }

    /**
     * Get all tokens from database with optional volume data
     */
    async function getAllTokens(includeVolume = false) {
        // Return cached result if still fresh
        if (_allTokensCache && Date.now() < _allTokensCacheExpiry) {
            return _allTokensCache;
        }

        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            // 1. Fetch from 'models' (DexHero Assets)
            const { data: models, error: modelsError } = await supabase
                .from('models')
                .select('*')
                .neq('name', 'Untitled')
                .not('name', 'is', 'null')
                .not('evm_contract_address', 'is', 'null')
                .order('created_at', { ascending: false })
                .limit(500);

            if (modelsError) {
                console.warn('Error fetching models:', modelsError);
            }

            // 2. Fetch from 'tokens' (Legacy/Solana SPL)
            const { data: legacyTokens, error: tokensError } = await supabase
                .from('tokens')
                .select('*')
                .neq('name', 'Untitled')
                .not('name', 'is', 'null')
                .not('contract_address', 'is', 'null')
                .order('created_at', { ascending: false })
                .limit(500);

            if (tokensError) {
                console.warn('Error fetching legacy tokens:', tokensError);
            }

            // Build token lookup by ID for sprite cross-reference
            const tokenById = {};
            (legacyTokens || []).forEach(t => { if (t.id) tokenById[t.id] = t; });

            // Track which token IDs are linked from models (to deduplicate later)
            const linkedTokenIds = new Set();

            // Map models to token structure, pulling sprite data from linked token
            const dexHeroes = (models || []).map(model => {
                const linkedToken = model.token_id ? tokenById[model.token_id] : null;
                if (model.token_id) linkedTokenIds.add(model.token_id);
                return {
                    id: model.id,
                    name: model.name,
                    symbol: model.symbol || (model.description ? model.description.substring(0, 4).toUpperCase() : 'HERO'),
                    description: model.description,
                    image_url: model.thumbnail_url,
                    model_url: model.model_url,
                    chain: (model.blockchain === 'solana') ? 'solana' : 'sepolia',
                    contract_address: model.evm_contract_address || 'Pending',
                    manager_address: linkedToken?.manager_address || model.evm_contract_address || null,
                    creator_wallet: 'Unknown',
                    created_at: model.created_at,
                    tax_percentage: 10,
                    total_supply: 10000000,
                    rental_price: model.rental_price_usd || 0.1,
                    purchase_price_usdc: linkedToken?.purchase_price_usdc || model.purchase_price || null,
                    rental_price_usdc: linkedToken?.rental_price_usdc || model.rental_price_usd || null,
                    volume_24h: 0,
                    games_count: model.games_count || 0,
                    players_count: model.players_count || 0,
                    price_change_24h: (Math.random() * 20 - 5).toFixed(2),
                    // Sprite data from linked token (for 360° turntable display)
                    sprite_url: linkedToken?.sprite_url || null,
                    sprite_frame_count: linkedToken?.sprite_frame_count || null,
                    sprite_status: linkedToken?.sprite_status || null,
                    _source: 'model'
                };
            });

            // Map tokens, excluding any already represented via a models entry
            const mappedLegacy = (legacyTokens || [])
                .filter(t => !linkedTokenIds.has(t.id))
                .map(t => ({
                    ...t,
                    total_supply: t.total_supply || 10000000,
                    volume_24h: 0,
                    games_count: t.games_count || 0,
                    players_count: t.players_count || 0,
                    price_change_24h: (Math.random() * 20 - 5).toFixed(2),
                    _source: 'token'
                }));

            // Merge datasets and sort globally by creation date (newest first)
            let allTokens = [...dexHeroes, ...mappedLegacy].sort((a, b) => {
                return new Date(b.created_at || 0) - new Date(a.created_at || 0);
            });

            // 3. Fetch Volume Data if requested
            if (includeVolume) {
                const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const { data: purchases, error: purchaseError } = await supabase
                    .from('model_purchases')
                    .select('model_id, purchase_price')
                    .gte('purchased_at', twentyFourHoursAgo)
                    .limit(2000);

                if (!purchaseError && purchases) {
                    const volumeMap = {};
                    purchases.forEach(p => {
                        volumeMap[p.model_id] = (volumeMap[p.model_id] || 0) + parseFloat(p.purchase_price);
                    });

                    allTokens = allTokens.map(token => ({
                        ...token,
                        volume_24h: volumeMap[token.id] || 0
                    }));
                }
            }

            const result = {
                success: true,
                tokens: allTokens
            };

            // Cache the result
            _allTokensCache = result;
            _allTokensCacheExpiry = Date.now() + ALL_TOKENS_CACHE_TTL;

            return result;

        } catch (error) {
            console.error('Error fetching all tokens:', error);
            return {
                success: false,
                tokens: [],
                error: error.message
            };
        }
    }

    /**
     * Get top tokens by volume
     */
    async function getTopTokens(limit = 10) {
        const result = await getAllTokens(true);
        if (result.success) {
            // Sort by volume, fallback to created_at
            const sorted = result.tokens.sort((a, b) => {
                if (b.volume_24h !== a.volume_24h) {
                    return b.volume_24h - a.volume_24h;
                }
                return new Date(b.created_at) - new Date(a.created_at);
            });
            return { success: true, tokens: sorted.slice(0, limit) };
        }
        return result;
    }

    /**
     * Get trending tokens by 24h percentage gain
     */
    async function getTrendingTokens(limit = 10) {
        const result = await getAllTokens(true);
        if (result.success) {
            const sorted = result.tokens.sort((a, b) => parseFloat(b.price_change_24h || 0) - parseFloat(a.price_change_24h || 0));
            return { success: true, tokens: sorted.slice(0, limit) };
        }
        return result;
    }

    /**
     * Get latest tokens by creation date
     */
    async function getLatestTokens(limit = 10) {
        const result = await getAllTokens(false);
        if (result.success) {
            const sorted = result.tokens.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            return { success: true, tokens: sorted.slice(0, limit) };
        }
        return result;
    }

    /**
     * Get random tokens to feature
     */
    async function getRandomTokens(limit = 5) {
        const result = await getAllTokens(false);
        if (result.success) {
            const shuffled = result.tokens.sort(() => 0.5 - Math.random());
            return { success: true, tokens: shuffled.slice(0, limit) };
        }
        return result;
    }

    /**
     * Get single token by ID
     */
    async function getTokenById(tokenId) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            // 1. Try 'models' table (DexHero Assets)
            const { data: model, error: modelError } = await supabase
                .from('models')
                .select('*') // Removed join to avoid FK errors
                .eq('id', tokenId)
                .maybeSingle();

            if (model && !modelError) {
                // Fetch creator profile separately
                let creatorProfile = null;
                if (model.user_id) {
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('username, wallet_address')
                        .eq('id', model.user_id)
                        .maybeSingle();
                    creatorProfile = profile;
                }

                // Fetch sprite data from linked token if available
                let spriteData = {};
                if (model.token_id) {
                    const { data: linkedToken } = await supabase
                        .from('tokens')
                        .select('sprite_url, sprite_frame_count, sprite_status, model_url')
                        .eq('id', model.token_id)
                        .maybeSingle();
                    if (linkedToken) spriteData = linkedToken;
                }

                // Map model fields to token structure
                const tokenData = {
                    id: model.id,
                    name: model.name,
                    symbol: model.symbol || (model.description ? model.description.substring(0, 4).toUpperCase() : 'HERO'),
                    description: model.description,
                    image_url: model.thumbnail_url,
                    model_url: model.model_url || spriteData.model_url || null,
                    chain: (model.blockchain === 'solana') ? 'solana' : 'sepolia',
                    contract_address: model.evm_contract_address,

                    // Creator info from profile or fallback
                    creator_wallet: creatorProfile?.wallet_address || 'Unknown',
                    creator_name: creatorProfile?.username,

                    created_at: model.created_at,
                    tax_percentage: 10,
                    player_share: 50,
                    trader_share: 50,
                    total_supply: 10000000,
                    market_cap: 822,
                    rental_price: model.rental_price_usd || 0.1,

                    // Sprite data from linked token
                    sprite_url: spriteData.sprite_url || null,
                    sprite_frame_count: spriteData.sprite_frame_count || null,
                    sprite_status: spriteData.sprite_status || null
                };
                return { success: true, token: tokenData };
            }

            // 2. Fallback to 'tokens' table (Legacy/Solana SPL)
            const { data, error } = await supabase
                .from('tokens')
                .select('*')
                .eq('id', tokenId)
                .maybeSingle();

            if (error) throw error;

                const rentalPrice = data.rental_price_usdc || data.metadata?.rentalPrice || data.rental_price_usd || data.metadata?.base_price || 0.1;
                const purchasePrice = data.purchase_price_usdc || data.metadata?.purchasePrice || data.metadata?.base_price || 5.0;

                return {
                    success: true,
                    token: {
                        ...data,
                        chain: data.chain || 'ethereum',
                        network: data.network || data.metadata?.network || 'sepolia',
                        manager_address: data.manager_address || data.metadata?.manager_address || null,
                        launch_type: data.launch_type || data.metadata?.launchType || 'new',
                        rental_price_usdc: rentalPrice,
                        rental_price: rentalPrice,
                        rental_price_per_day: rentalPrice,
                        purchase_price_usdc: purchasePrice,
                        purchase_price: purchasePrice
                    }
                };

        } catch (error) {
            console.error('Error fetching token:', error);
            return {
                success: false,
                token: null,
                error: error.message
            };
        }
    }

    /**
     * Get total count of all tokens
     */
    async function getTotalTokenCount() {
        const result = await getAllTokens(false);
        if (result.success) {
            return result.tokens.length;
        }
        return 0;
    }

    /**
     * Get total 24h volume of all tokens
     */
    async function getTotalVolume() {
        const result = await getAllTokens(true);
        if (result.success) {
            return result.tokens.reduce((sum, t) => sum + parseFloat(t.volume_24h || 0), 0);
        }
        return 0;
    }

    /**
     * Get total liquidity from all rented DexHeros
     */
    async function getTotalLiquidity() {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) return 0;
            const { data, error } = await supabase
                .from('liquidity_positions')
                .select('initial_value_usd')
                .eq('is_active', true);

            if (error) {
                // If table is missing (404/42P01), fail silently with 0
                if (error.code === '42P01' || error.status === 404) {
                    return 0;
                }
                throw error;
            }
            return (data || []).reduce((sum, lp) => sum + parseFloat(lp.initial_value_usd || 0), 0);
        } catch (error) {
            console.warn(' Liquidity tables not found or inaccessible:', error.message);
            return 0;
        }
    }

    /**
     * Get count of active linked game integrations
     */
    async function getLinkedGamesCount() {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) return 0;
            const { data, error } = await supabase
                .from('registered_games')
                .select('id')
                .eq('is_active', true);

            if (error) {
                if (error.code === '42P01' || error.status === 404) return 0;
                throw error;
            }
            return (data || []).length;
        } catch (error) {
            console.warn(' registered_games table not found or inaccessible:', error.message);
            return 0;
        }
    }

    // Expose functions globally
    window.DexHeroTokens = {
        createNewToken,
        setupExistingToken,
        payCreationFee,
        transferExistingTokens,
        saveTokenToDatabase,
        getUserTokens,
        getAllTokens,
        getTokenById,
        getTopTokens,
        getTrendingTokens,
        getLatestTokens,
        getRandomTokens,
        getTotalTokenCount,
        getTotalVolume,
        getTotalLiquidity,
        getLinkedGamesCount,
        getNetwork: () => NETWORK,
        v3Config,
    };

    console.log(' DexHero Token module loaded (EVM)');

})();
