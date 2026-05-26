/**
 * Monad Chain Integration
 * Provides read access to MonadComputeRegistry for compute-minutes,
 * distinct days, legitimacy scores, and node registration status.
 */

const MonadIntegration = (() => {
    let _provider = null;
    let _computeRegistry = null;
    let _nodeRegistrar = null;

    // ── Provider ─────────────────────────────────────────────────

    function getProvider() {
        if (_provider) return _provider;
        const net = NETWORKS.monad;
        if (!net) throw new Error('Monad network not configured');
        _provider = new ethers.providers.JsonRpcProvider(net.rpcUrl, {
            chainId: parseInt(net.chainId, 16),
            name: net.chainName
        });
        return _provider;
    }

    // ── Contract Instances ───────────────────────────────────────

    const COMPUTE_REGISTRY_ABI = [
        "function computeMinutesServed(address wallet, uint256 dexheroId) view returns (uint256)",
        "function distinctDaysActive(address wallet, uint256 dexheroId) view returns (uint256)",
        "function weeklyMinutes(address wallet, uint256 dexheroId) view returns (uint256)",
        "function legitimacyScore(address wallet, uint256 dexheroId) view returns (uint256)",
        "function isRegistered(address wallet, uint256 dexheroId) view returns (bool)",
        "function nodeCapabilities(address wallet) view returns (string gpu, uint256 vramGb, uint256 uploadMbps, string encoder)"
    ];

    const NODE_REGISTRAR_ABI = [
        "function registeredNodes(address wallet, uint256 dexheroId) view returns (bool verified, uint256 registeredAt)",
        "function registerNode(uint256 dexheroId) external"
    ];

    function getComputeRegistry() {
        if (_computeRegistry) return _computeRegistry;
        const addr = CONTRACT_ADDRESSES.monad?.computeRegistry;
        if (!addr) throw new Error('MonadComputeRegistry address not configured');
        _computeRegistry = new ethers.Contract(addr, COMPUTE_REGISTRY_ABI, getProvider());
        return _computeRegistry;
    }

    function getNodeRegistrar() {
        if (_nodeRegistrar) return _nodeRegistrar;
        const addr = CONTRACT_ADDRESSES.monad?.nodeRegistrar;
        if (!addr) throw new Error('NodeRegistrar address not configured');
        _nodeRegistrar = new ethers.Contract(addr, NODE_REGISTRAR_ABI, getProvider());
        return _nodeRegistrar;
    }

    // ── Read Functions ───────────────────────────────────────────

    async function getComputeProgress(wallet, dexheroId) {
        const registry = getComputeRegistry();
        const [minutes, days, weeklyMin, legit] = await Promise.all([
            registry.computeMinutesServed(wallet, dexheroId),
            registry.distinctDaysActive(wallet, dexheroId),
            registry.weeklyMinutes(wallet, dexheroId),
            registry.legitimacyScore(wallet, dexheroId)
        ]);
        const minutesNum = minutes.toNumber();
        const daysNum = days.toNumber();
        const weeklyNum = weeklyMin.toNumber();
        const legitNum = legit.toNumber();

        const rarity = determineRarity(minutesNum, daysNum);
        const nextRarity = getNextRarity(rarity);
        const nextThreshold = nextRarity ? COMPUTE_THRESHOLDS[nextRarity] : null;
        const nextDays = nextRarity ? DISTINCT_DAY_REQUIREMENTS[nextRarity] : null;

        return {
            computeMinutes: minutesNum,
            distinctDays: daysNum,
            weeklyMinutes: weeklyNum,
            legitimacyScore: legitNum,
            currentRarity: rarity,
            nextRarity,
            nextThreshold,
            nextDaysRequired: nextDays,
            weeklyCap: WEEKLY_COMPUTE_CAP,
            weeklyCapPct: Math.min(100, (weeklyNum / WEEKLY_COMPUTE_CAP) * 100)
        };
    }

    async function getNodeRegistration(wallet, dexheroId) {
        const registrar = getNodeRegistrar();
        const [verified, registeredAt] = await registrar.registeredNodes(wallet, dexheroId);
        return {
            verified,
            registeredAt: registeredAt.toNumber(),
            registeredDate: registeredAt.toNumber() > 0
                ? new Date(registeredAt.toNumber() * 1000)
                : null
        };
    }

    async function isNodeRegistered(wallet, dexheroId) {
        const reg = await getNodeRegistration(wallet, dexheroId);
        return reg.verified;
    }

    // ── Rarity Helpers ───────────────────────────────────────────

    function determineRarity(minutes, days) {
        if (minutes >= COMPUTE_THRESHOLDS.LEGENDARY && days >= DISTINCT_DAY_REQUIREMENTS.LEGENDARY) return 'LEGENDARY';
        if (minutes >= COMPUTE_THRESHOLDS.RARE && days >= DISTINCT_DAY_REQUIREMENTS.RARE) return 'RARE';
        if (minutes >= COMPUTE_THRESHOLDS.UNCOMMON && days >= DISTINCT_DAY_REQUIREMENTS.UNCOMMON) return 'UNCOMMON';
        if (minutes >= COMPUTE_THRESHOLDS.COMMON && days >= DISTINCT_DAY_REQUIREMENTS.COMMON) return 'COMMON';
        return null;
    }

    function getNextRarity(current) {
        const order = ['COMMON', 'UNCOMMON', 'RARE', 'LEGENDARY'];
        if (!current) return 'COMMON';
        const idx = order.indexOf(current);
        return idx < order.length - 1 ? order[idx + 1] : null;
    }

    function estimateUnlockDate(currentMinutes, currentDays, hoursPerDay = 4) {
        const effectiveMinPerDay = hoursPerDay * 60 * DEFAULT_NETWORK_UTILIZATION * DEFAULT_LEGITIMACY_SCORE;
        const results = {};

        for (const [rarity, threshold] of Object.entries(COMPUTE_THRESHOLDS)) {
            const daysReq = DISTINCT_DAY_REQUIREMENTS[rarity];
            const minutesRemaining = Math.max(0, threshold - currentMinutes);
            const daysRemaining = Math.max(0, daysReq - currentDays);
            const daysByMinutes = minutesRemaining > 0 ? Math.ceil(minutesRemaining / effectiveMinPerDay) : 0;
            const calendarDays = Math.max(daysByMinutes, daysRemaining);

            const unlockDate = new Date();
            unlockDate.setDate(unlockDate.getDate() + calendarDays);

            results[rarity] = {
                threshold,
                daysRequired: daysReq,
                minutesRemaining,
                distinctDaysRemaining: Math.max(0, daysReq - currentDays),
                estimatedCalendarDays: calendarDays,
                estimatedUnlockDate: unlockDate,
                eligible: minutesRemaining === 0 && daysRemaining === 0
            };
        }
        return results;
    }

    // ── Ethereum Play Pass Helpers ───────────────────────────────

    async function hasPlayPass(wallet, ethProvider) {
        const addr = CONTRACT_ADDRESSES.sepolia?.platformPlayPass;
        if (!addr) return false;
        const contract = new ethers.Contract(addr, PLATFORM_PLAY_PASS_ABI, ethProvider);
        return contract.hasActivePlayPass(wallet);
    }

    async function getAttestedMinutes(wallet, dexheroId, ethProvider) {
        const addr = CONTRACT_ADDRESSES.sepolia?.crossChainAttestor;
        if (!addr) return { minutes: 0, days: 0 };
        const contract = new ethers.Contract(addr, CROSS_CHAIN_ATTESTOR_ABI, ethProvider);
        const [minutes, days] = await Promise.all([
            contract.attestedMinutes(wallet, dexheroId),
            contract.attestedDays(wallet, dexheroId)
        ]);
        return { minutes: minutes.toNumber(), days: days.toNumber() };
    }

    // ── Public API ───────────────────────────────────────────────

    return {
        getProvider,
        getComputeProgress,
        getNodeRegistration,
        isNodeRegistered,
        determineRarity,
        getNextRarity,
        estimateUnlockDate,
        hasPlayPass,
        getAttestedMinutes
    };
})();

window.MonadIntegration = MonadIntegration;
