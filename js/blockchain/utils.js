/**
 * DexHero Blockchain Utilities
 * Shared helpers used across blockchain modules.
 */

const _DexHeroUtils = {

    /**
     * Validate if an address is potentially an EVM address.
     */
    isEvmAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return address.startsWith('0x') && address.length === 42;
    },

    /**
     * Check if an address looks like a Solana address (base58, 32-44 chars).
     */
    isSolanaAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !address.startsWith('0x');
    },

    /**
     * Estimate the starting block number given a creation timestamp.
     * @param {number} currentBlock - Current block number
     * @param {string|number} creationTime - ISO string or timestamp
     * @param {number} bufferBlocks - Extra buffer blocks to add
     * @returns {number} Estimated start block
     */
    estimateStartBlock(currentBlock, creationTime, bufferBlocks = SEARCH_BUFFER_BLOCKS) {
        if (!creationTime) return 0;
        const createdAt = new Date(creationTime).getTime();
        const ageSec = (Date.now() - createdAt) / 1000;
        const blocksAgo = Math.floor(ageSec / BLOCK_TIME_SECONDS) + bufferBlocks;
        return Math.max(0, currentBlock - blocksAgo);
    },

    /**
     * Format a BigNumber from USDC (6 decimals) to a float.
     */
    formatUSDC(bigNum) {
        return parseFloat(window.ethers.utils.formatUnits(bigNum, 6));
    },

    /**
     * Format a BigNumber from standard ERC20 (18 decimals) to a float.
     */
    formatToken(bigNum) {
        return parseFloat(window.ethers.utils.formatUnits(bigNum, 18));
    },

    /**
     * Parse a human amount into USDC wei (6 decimals).
     */
    parseUSDC(amount) {
        return window.ethers.utils.parseUnits(amount.toString(), 6);
    }
};
