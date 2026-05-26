/**
 * DexHero Blockchain Trading
 * Buy/sell tokens, swap logic, slippage calculations, Uniswap integration.
 */

const _DexHeroTrading = {

    /**
     * Buy DexHero Tokens (mints SBTs or Swap via Router).
     */
    async buyToken(quantity, contractAddress) {
        console.log(`buyToken called: Qty=${quantity}, Address=${contractAddress}`);
        console.log(`Current Network: ${this.network}, Chain ID: ${await this.signer.getChainId()}`);
        if (!contractAddress) throw new Error("Contract address required");

        let targetContractAddress = contractAddress;
        const contracts = this.getContracts();
        const manager = new window.ethers.Contract(targetContractAddress, DEXHERO_MANAGER_ABI, this.signer);

        const heroDetails = await this.getHeroDetails(targetContractAddress);
        const isV2 = heroDetails && heroDetails.isV2;
        const routerAddr = isV2 ? heroDetails.router : null;

        if (!isV2 && quantity > 1) {
            throw new Error("Batch buying is currently disabled for legacy tokens. Please buy 1 token at a time.");
        }

        try {
            console.log("Debug: Verifying Manager contract...");
            await manager.sbt();
            console.log("Debug: Verified valid Manager.");
        } catch (e) {
            console.error("Critical Error: Provided address is not a valid Manager.", e);
            throw new Error("Security Alert: Invalid Manager Contract. Transaction aborted.");
        }

        console.log("Calling priceForNextMint on:", targetContractAddress);
        const pricePerToken = await manager.priceForNextMint();
        console.log("Price per token (Wei):", pricePerToken.toString());

        const price = pricePerToken.mul(quantity);
        console.log("Total Price (Wei):", price.toString());

        const balance = await contracts.usdc.balanceOf(this.userAddress);
        const decimals = await contracts.usdc.decimals();
        console.log(`Debug USDC: Address=${contracts.usdc.address}, User=${this.userAddress}`);
        console.log(`Debug USDC: Balance=${balance.toString()} (${window.ethers.utils.formatUnits(balance, decimals)})`);
        console.log(`Debug USDC: Required=${price.toString()} (${window.ethers.utils.formatUnits(price, decimals)})`);

        if (balance.lt(price)) {
            throw new Error(`Insufficient USDC balance. Have ${window.ethers.utils.formatUnits(balance, decimals)}, Need ${window.ethers.utils.formatUnits(price, decimals)}`);
        }

        if (isV2) {
            console.log("V2 Mode: Buying via Direct Router:", routerAddr);
            const routerABI = ["function buyTokens(uint256 amountUSDC, uint256 minTokensOut, uint256 checkTokenId) external returns (uint256)"];
            const router = new window.ethers.Contract(routerAddr, routerABI, this.signer);

            const allowance = await contracts.usdc.allowance(this.userAddress, routerAddr);
            if (allowance.lt(price)) {
                console.log("Approving Router for exact amount...");
                const approveTx = await contracts.usdc.approve(routerAddr, price);
                await approveTx.wait();
                console.log("Router Approved");
            }

            const quoteABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
            const routerQuoter = new window.ethers.Contract(routerAddr, quoteABI, this.getReadProvider());
            let minTokensOut = 0;
            try {
                const expectedOut = await routerQuoter.quoteBuyTokens(price);
                minTokensOut = expectedOut.mul(SLIPPAGE_NUMERATOR).div(SLIPPAGE_DENOMINATOR);
                console.log(`Slippage protection: minTokensOut=${minTokensOut.toString()} (${SLIPPAGE_NUMERATOR}% of ${expectedOut.toString()})`);
            } catch (e) {
                console.warn("Quote failed, proceeding without slippage protection:", e.message);
            }

            const tx = await router.buyTokens(price, minTokensOut, 0);
            console.log("Buy Transaction sent:", tx.hash);
            const receipt = await tx.wait();
            console.log("Buy confirmed. Gas used:", receipt.gasUsed.toString());
            return {
                success: true,
                transactionHash: receipt.transactionHash
            };

        } else {
            console.log("V1 Mode: Buying via Manager");

            const allowance = await contracts.usdc.allowance(this.userAddress, targetContractAddress);
            if (allowance.lt(price)) {
                console.log("Approving Manager for exact amount...");
                const approveTx = await contracts.usdc.approve(targetContractAddress, price);
                await approveTx.wait();
                console.log("Manager Approved");
            }

            const tx = await manager.buyDexHero(quantity);
            console.log("Buy Transaction sent:", tx.hash);
            const receipt = await tx.wait();

            const event = receipt.events.find(e => e.event === 'SBTMinted');
            const tokenId = event ? event.args.tokenId.toNumber() : 0;

            return {
                success: true,
                tokenId,
                transactionHash: receipt.transactionHash,
                price: window.ethers.utils.formatUnits(price, 6)
            };
        }
    },

    /**
     * Buy V2 Tokens specifying exact USDC amount (Swap).
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

        const balance = await usdc.balanceOf(this.userAddress);
        if (balance.lt(amountWei)) {
            throw new Error(`Insufficient USDC balance.`);
        }

        const allowance = await usdc.allowance(this.userAddress, routerAddr);
        if (allowance.lt(amountWei)) {
            console.log("Approving Router for exact amount...");
            const approveTx = await usdc.approve(routerAddr, amountWei);
            await approveTx.wait();
        }

        const quoteABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
        const routerQuoter = new window.ethers.Contract(routerAddr, quoteABI, this.getReadProvider());
        let minTokensOut = 0;
        try {
            const expectedOut = await routerQuoter.quoteBuyTokens(amountWei);
            minTokensOut = expectedOut.mul(SLIPPAGE_NUMERATOR).div(SLIPPAGE_DENOMINATOR);
            console.log(`Slippage protection: minTokensOut=${minTokensOut.toString()} (${SLIPPAGE_NUMERATOR}% of ${expectedOut.toString()})`);
        } catch (e) {
            console.warn("Quote failed, proceeding without slippage protection:", e.message);
        }

        console.log(`Buying with ${amountUSDC} USDC via Router ${routerAddr}`);
        const tx = await router.buyTokens(amountWei, minTokensOut, 0);
        console.log("Tx sent:", tx.hash);
        const receipt = await tx.wait();

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
        } catch (e) { /* non-critical */ }

        return {
            success: true,
            transactionHash: receipt.transactionHash,
            tokensReceived,
            actualPrice
        };
    },

    /**
     * Quote a Uniswap V3 swap without sending a tx.
     */
    async quoteUniswapSwap(tokenAddress, amountIn, direction = 'buy') {
        const addresses = CONTRACT_ADDRESSES[this.network] || CONTRACT_ADDRESSES.sepolia;
        if (!addresses.uniswapQuoter) throw new Error('Uniswap quoter not configured for this network');

        const quoterABI = [
            'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
        ];
        const quoter = new window.ethers.Contract(addresses.uniswapQuoter, quoterABI, this.getReadProvider());

        const usdcAddr = addresses.usdc;
        const fee = UNISWAP_FEE_TIER;

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
    },

    /**
     * Execute a Uniswap V3 swap for existing/graduated tokens.
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

        const tokenInContract = new window.ethers.Contract(tokenIn, USDC_ABI, this.signer);
        const allowance = await tokenInContract.allowance(this.userAddress, addresses.uniswapRouter);
        if (allowance.lt(amountInWei)) {
            console.log('[Uniswap] Approving router...');
            const approveTx = await tokenInContract.approve(addresses.uniswapRouter, window.ethers.constants.MaxUint256);
            await approveTx.wait();
        }

        const params = {
            tokenIn, tokenOut, fee,
            recipient: this.userAddress,
            amountIn: amountInWei,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        };

        console.log(`[Uniswap] Swapping ${amount} ${direction === 'buy' ? 'USDC -> token' : 'token -> USDC'}`);
        const tx = await router.exactInputSingle(params);
        const receipt = await tx.wait();

        let amountOut = 0;
        try {
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
        } catch (e) { /* non-critical */ }

        return {
            success: true,
            transactionHash: receipt.transactionHash,
            amountOut
        };
    },

    /**
     * Get estimated token amount for a given USDC input.
     */
    async getBuyQuote(amountUSDC, contractAddress) {
        if (!amountUSDC || amountUSDC <= 0) return 0;
        if (!contractAddress) return 0;

        try {
            const heroDetails = await this.getHeroDetails(contractAddress);
            let isV2 = heroDetails && heroDetails.isV2;
            const routerAddr = isV2 ? heroDetails.router : null;

            if (isV2 && routerAddr) {
                const routerABI = ["function quoteBuyTokens(uint256 amountUSDC) view returns (uint256)"];
                const router = new window.ethers.Contract(routerAddr, routerABI, this.provider);

                const amountIn = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);
                const tokensOut = await router.quoteBuyTokens(amountIn);

                return parseFloat(window.ethers.utils.formatUnits(tokensOut, 18));
            }

            return 0;
        } catch (e) {
            console.warn("Error getting buy quote:", e);
            return 0;
        }
    },

    /**
     * Sell DexHero Tokens (Redeem SBTs for USDC).
     */
    async sellToken(quantity, contractAddress, knownRouter = null, knownTokenAddress = null) {
        if (!contractAddress) throw new Error("Contract address required");

        const manager = new window.ethers.Contract(contractAddress, DEXHERO_MANAGER_ABI, this.signer);

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
            console.log("V2 Mode: Selling via Router:", routerAddr);

            const tokenAddress = tokenAddressForSell;
            console.log("Token Address from Factory:", tokenAddress);

            if (!tokenAddress) throw new Error("Could not determine token address for sale.");

            const tokenContract = new window.ethers.Contract(tokenAddress, USDC_ABI, this.signer);
            const decimals = await tokenContract.decimals();

            const amountIn = window.ethers.utils.parseUnits(quantity.toString(), decimals);

            const allowance = await tokenContract.allowance(this.userAddress, routerAddr);
            if (allowance.lt(amountIn)) {
                console.log("Approving Router to spend Tokens...");
                const apTx = await tokenContract.approve(routerAddr, window.ethers.constants.MaxUint256);
                await apTx.wait();
            }

            const routerABI = [
                "function sellTokens(uint256 amountToken, uint256 minUSDCOut, uint256 checkTokenId) external returns (uint256)",
                "event Sold(address indexed seller, uint256 tokenIn, uint256 usdcOut, uint256 spreadCaptured)"
            ];
            const router = new window.ethers.Contract(routerAddr, routerABI, this.signer);

            const tx = await router.sellTokens(amountIn, 0, 0);
            console.log("Sell TX sent:", tx.hash);
            const receipt = await tx.wait();

            let usdcReceived = 0;
            try {
                const soldEvent = receipt.logs
                    .map(log => { try { return router.interface.parseLog(log); } catch { return null; } })
                    .find(e => e?.name === 'Sold');
                if (soldEvent) {
                    usdcReceived = parseFloat(window.ethers.utils.formatUnits(soldEvent.args.usdcOut, 6));
                }
            } catch (e) { /* non-critical */ }

            return {
                success: true,
                transactionHash: receipt.transactionHash,
                usdcReceived
            };

        } else {
            let sbtAddress;
            try {
                sbtAddress = await manager.sbt();
            } catch (e) {
                console.error("Failed to get SBT address from manager:", e);
                throw new Error("Could not determine SBT contract address.");
            }

            const nft = new window.ethers.Contract(sbtAddress, DEXHERO_NFT_ABI, this.signer);

            const balance = await nft.balanceOf(this.userAddress);
            if (balance.lt(quantity)) {
                throw new Error(`Insufficient Token balance. You own ${balance.toString()} units.`);
            }

            const tokenIds = [];
            for (let i = 0; i < quantity; i++) {
                const tokenId = await nft.tokenOfOwnerByIndex(this.userAddress, i);
                tokenIds.push(tokenId);
            }

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
    },

    /**
     * Buy tokens using USDC via the global Router.
     */
    async buyTokens(tokenAddress, amountUSDC) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        if (!addresses.router) return { success: false, error: "Router not configured for this network" };

        const usdc = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);
        const router = new window.ethers.Contract(addresses.router, DEXHEROS_ROUTER_ABI, this.signer);

        try {
            const amountWei = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);

            console.log(`Checking USDC allowance for Router...`);
            const allowance = await usdc.allowance(this.userAddress, addresses.router);
            if (allowance.lt(amountWei)) {
                console.log(`Approving router to spend ${amountUSDC} USDC...`);
                const approveTx = await usdc.approve(addresses.router, window.ethers.constants.MaxUint256);
                await approveTx.wait();
                console.log("Router Approved");
            }

            console.log(`Buying tokens for $${amountUSDC}...`);
            const tx = await router.buyTokens(amountWei, 0, 0, { gasLimit: 300000 });
            const receipt = await tx.wait();
            console.log("Tokens purchased:", receipt.transactionHash);
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error("buyTokens failed:", error);
            return { success: false, error: error.message };
        }
    },

    /**
     * Pay creation fee in USDC (EVM).
     */
    async payCreationFee(amountUSDC) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        const usdc = new window.ethers.Contract(addresses.usdc, USDC_ABI, this.signer);
        const treasury = addresses.treasury;

        try {
            const amountWei = window.ethers.utils.parseUnits(amountUSDC.toString(), 6);
            const normalizedTreasury = window.ethers.utils.getAddress(treasury.toLowerCase());
            console.log(`Transferring ${amountUSDC} USDC to treasury: ${normalizedTreasury}`);
            const tx = await usdc.transfer(normalizedTreasury, amountWei);
            const receipt = await tx.wait();
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error("USDC Payment failed:", error);
            return { success: false, error: error.message };
        }
    },

    /**
     * Transfer existing ERC20 tokens to platform treasury.
     */
    async transferExistingTokens(tokenAddress, amountRaw, decimals) {
        if (!this.signer) await this.connectWallet();
        const addresses = CONTRACT_ADDRESSES[this.network];
        const token = new window.ethers.Contract(tokenAddress, USDC_ABI, this.signer);
        const treasury = addresses.treasury;

        try {
            const normalizedTreasury = window.ethers.utils.getAddress(treasury.toLowerCase());
            console.log(`Transferring ${amountRaw} tokens to treasury: ${normalizedTreasury}`);
            const tx = await token.transfer(normalizedTreasury, amountRaw);
            const receipt = await tx.wait();
            return { success: true, transactionHash: receipt.transactionHash };
        } catch (error) {
            console.error("Token transfer failed:", error);
            return { success: false, error: error.message };
        }
    }
};
