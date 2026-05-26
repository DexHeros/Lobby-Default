/**
 * DexHero Contract Scanner
 *
 * Validates existing tokens before integration. The on-chain probe
 * (basic ERC-20 reads + bytecode-selector grep) runs as a fast first pass
 * for instant UX feedback, then `/api/security` is queried server-side for
 * the authoritative honeypot / rug / bundler analysis (GoPlus + RugCheck +
 * Bubblemaps + market-data thresholds — see lib/security.js).
 *
 * Hard flags from the server are merged into `redFlags`. The Create button
 * consumes `decision.ok` from the server response, NOT just
 * `redFlags.length === 0`, so the same threshold logic runs in both places.
 *
 * Callers must pass the wallet's actual ethers provider (from the user's
 * connected chain) — the scanner no longer assumes Sepolia.
 */

window.DexHeroScanner = (function () {

    // ABI for basic ERC20 info
    const ERC20_ABI = [
        "function totalSupply() view returns (uint256)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function owner() view returns (address)",
        "function mint(address to, uint256 amount) external" // Used to check if mint function exists
    ];

    // Friendly chain name for error messages. Falls back to "chainId N" so we
    // never leave the user staring at a number.
    const _CHAIN_NAMES = {
        1:        'Ethereum',
        10:       'Optimism',
        25:       'Cronos',
        56:       'BNB Smart Chain',
        97:       'BNB Testnet',
        100:      'Gnosis',
        137:      'Polygon',
        169:      'Manta Pacific',
        250:      'Fantom',
        324:      'zkSync Era',
        1101:     'Polygon zkEVM',
        5000:     'Mantle',
        8453:     'Base',
        11155111: 'Sepolia',
        42161:    'Arbitrum One',
        42220:    'Celo',
        43114:    'Avalanche',
        59144:    'Linea',
        81457:    'Blast',
        84532:    'Base Sepolia',
        130:      'Unichain',
        534352:   'Scroll',
    };
    function _chainNameFor(chainId) {
        if (chainId === 'solana') return 'Solana';
        return _CHAIN_NAMES[chainId] || `chainId ${chainId}`;
    }

    /**
     * Scan an EVM contract on any chain.
     *  @param {string}        address — 0x… token address
     *  @param {ethers.Provider} provider — ethers provider already bound to the
     *                                      wallet's actual chain (no longer
     *                                      assumes Sepolia).
     *  @param {number}        chainIdForServer — int chainId used for the
     *                                            server-side safety lookup
     *                                            (passed to /api/security).
     */
    async function scanEVM(address, provider, chainIdForServer) {
        console.log(`[Scanner] Scanning EVM contract: ${address} (chainId=${chainIdForServer})`);
        try {
            // 0. Bytecode pre-flight. Do this BEFORE the ERC-20 reads so we
            //    can give a useful error when the user pastes a contract that
            //    only exists on a different chain (a CALL_EXCEPTION on
            //    totalSupply() would otherwise be cryptic). This is the
            //    overwhelmingly common cause of "scan failed" — wallet on
            //    Sepolia/Base, address on Ethereum mainnet, etc.
            const code = await provider.getCode(address);
            if (code === '0x' || code === '') {
                const chainName = _chainNameFor(chainIdForServer);
                return {
                    success: false,
                    error: `No contract found at ${address} on ${chainName}. Switch your wallet to the chain where this token actually lives, then scan again.`,
                };
            }

            const contract = new window.ethers.Contract(address, ERC20_ABI, provider);

            // 1. Fetch Basic Info. totalSupply must succeed — if it doesn't,
            //    the address is something other than an ERC-20 (despite having
            //    bytecode). Surface a clean error rather than the ethers
            //    CALL_EXCEPTION dump.
            let name, symbol, decimals, totalSupply;
            try {
                [name, symbol, decimals, totalSupply] = await Promise.all([
                    contract.name().catch(() => "Unknown"),
                    contract.symbol().catch(() => "???"),
                    contract.decimals().catch(() => 18),
                    contract.totalSupply()
                ]);
            } catch (e) {
                return {
                    success: false,
                    error: `Address ${address} has bytecode on ${_chainNameFor(chainIdForServer)} but does not implement the ERC-20 interface (totalSupply() reverted). Verify the address and chain.`,
                };
            }

            // 2. Calculate 1%
            const onePercent = totalSupply.div(100);
            const formattedTotal = window.ethers.utils.formatUnits(totalSupply, decimals);
            const formattedOnePercent = window.ethers.utils.formatUnits(onePercent, decimals);

            // 3. Risk Assessment — flag anything that will harm users or block integration.
            //    We already have `code` from the pre-flight above.
            const redFlags = [];

            {
                // Mint — owner can inflate supply and dump
                if (code.includes('40c10f19')) {
                    redFlags.push("Mint function detected. Owner can create unlimited tokens.");
                }

                // Pause — owner can freeze all transfers (honeypot risk)
                if (code.includes('8456312a')) {
                    redFlags.push("Pause function detected. Owner can freeze trading at any time.");
                }

                // Blacklist — owner can block wallets from trading
                if (code.includes('60128c6e')) {
                    redFlags.push("Blacklist function detected. Owner can block wallet addresses.");
                }

                // (Note: tax-on-transfer / hidden-fee detection is delegated
                // to the server's /api/security proxy via GoPlus, which actually
                // simulates buy+sell rather than relying on selector grep.)

                // Check for proxy/upgradeable pattern — owner can swap out contract logic
                if (code.includes('3659cfe6')) {
                    redFlags.push("Upgradeable proxy detected. Contract logic can be replaced by owner.");
                }

                // Zero supply check
                if (totalSupply.isZero()) {
                    redFlags.push("Total supply is zero. Cannot calculate or transfer 1%.");
                }

            }

            const oneTokenBN = window.ethers.utils.parseUnits("1", decimals);

            // Authoritative server-side scan (GoPlus / Bubblemaps / market data).
            // Caller passes chainId so the right chain-specific check fires.
            // Failure to reach the server is itself a hard flag — fail-closed.
            let serverScan = null;
            try {
                serverScan = await window.DexHeroSecurity.evaluate({
                    tokenAddress: address,
                    chainId: chainIdForServer,
                });
                for (const f of serverScan?.decision?.hardFlags || []) redFlags.push(f);
            } catch (e) {
                redFlags.push(`Safety scan service unavailable — cannot verify token. (${e.message})`);
            }

            return {
                success: true,
                type: 'EVM',
                address,
                chainId: chainIdForServer,
                name,
                symbol,
                decimals,
                totalSupply: formattedTotal,
                onePercent: "1", // Hardcoded to 1 for testing
                onePercentRaw: oneTokenBN.toString(),
                oneToken: "1",
                oneTokenRaw: oneTokenBN.toString(),
                redFlags,
                decision: serverScan?.decision || null,
                market:   serverScan?.market   || null,
                security: serverScan?.security || null,
                cluster:  serverScan?.cluster  || null,
            };

        } catch (error) {
            console.error("[Scanner] EVM Error:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Fetch Metaplex Metadata for a Solana Token
     */
    async function fetchMetaplexMetadata(mintAddress, connection) {
        try {
            const { PublicKey } = solanaWeb3;
            const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
            const mintPublicKey = new PublicKey(mintAddress);

            const [metadataPDA] = await PublicKey.findProgramAddress(
                [
                    Buffer.from('metadata'),
                    METADATA_PROGRAM_ID.toBuffer(),
                    mintPublicKey.toBuffer(),
                ],
                METADATA_PROGRAM_ID
            );

            // Direct JSON-RPC for the same reason as scanSolana — the SDK's
            // schema rejects valid modern responses. Best-effort: if no RPC
            // URL is reachable, fall through to the SPL/SPL defaults.
            const rpcUrl = connection?._rpcEndpoint || connection?.rpcEndpoint;
            if (!rpcUrl) return null;
            const dataBytes = await _rawGetAccountInfo(rpcUrl, metadataPDA.toBase58());
            if (!dataBytes) return null;

            // Metaplex Metadata layout (Borsh):
            //   [0]       key (u8)
            //   [1..33)   update_authority (Pubkey)
            //   [33..65)  mint (Pubkey)
            //   [65..101) name   = u32 LE length + 32 utf-8 bytes (padded)
            //   [101..115) symbol = u32 LE length + 10 utf-8 bytes (padded)
            //   ...
            // Each Borsh String is `u32 length + bytes` — the previous
            // implementation sliced AT the length prefix, which left the
            // first 4 bytes of each string as the length integer (decoded
            // as junk control chars) AND truncated long symbols to ~6 chars
            // ("DARKDOGE" → "DarkDo"). Read the length-prefix properly,
            // then take min(declaredLen, maxLen) and trim trailing nulls.
            const decodeFixedString = (buf, offset, maxLen) => {
                if (!buf || offset + 4 + maxLen > buf.length) return '';
                const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                const declaredLen = view.getUint32(offset, true);
                const len = Math.min(declaredLen, maxLen);
                const slice = buf.slice(offset + 4, offset + 4 + len);
                return new TextDecoder('utf-8', { fatal: false })
                    .decode(slice)
                    .replace(/\0+$/g, '')
                    .trim();
            };

            const name   = decodeFixedString(dataBytes, 65, 32);
            const symbol = decodeFixedString(dataBytes, 101, 10);

            return { name, symbol };
        } catch (e) {
            console.warn("[Scanner] Metaplex fetch failed:", e.message);
            return null;
        }
    }

    /**
     * Decode the raw 82-byte SPL Mint account layout. Works for both classic
     * SPL Token and Token-2022 (the first 82 bytes are identical; Token-2022
     * extensions live after that and we don't need them here).
     *
     * Layout (Borsh):
     *   [0..4)   COption tag (u32 LE) for mint_authority   (1 = present, 0 = absent)
     *   [4..36)  mint_authority pubkey (32 bytes, valid only if tag = 1)
     *   [36..44) supply (u64 LE)
     *   [44]     decimals (u8)
     *   [45]     is_initialized (bool)
     *   [46..50) COption tag for freeze_authority
     *   [50..82) freeze_authority pubkey (valid only if tag = 1)
     */
    /**
     * Direct JSON-RPC `getAccountInfo` — bypasses the @solana/web3.js SDK's
     * strict superstruct validation, which rejects modern Solana RPC responses
     * because newer node versions add fields (`space` at the value level,
     * sometimes a u64-max `rentEpoch`) that the SDK schema doesn't allow.
     *
     * Returns the account's `data` field as a Uint8Array, or `null` if the
     * account does not exist.
     *
     * Once @solana/web3.js is upgraded to a version that tolerates these
     * fields, this helper can be deleted and we can go back to
     * `connection.getAccountInfo(...)`.
     */
    async function _rawGetAccountInfo(rpcUrl, addressBase58) {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getAccountInfo',
                params: [addressBase58, { encoding: 'base64' }],
            }),
        });
        if (!res.ok) {
            // 429 = upstream throttled (server already retried once with backoff).
            if (res.status === 429) {
                throw new Error('Solana RPC is rate-limiting us. Please wait ~30 seconds and try again. (For production, set SOLANA_RPC_URL to a Helius/QuickNode endpoint.)');
            }
            throw new Error(`Solana RPC HTTP ${res.status}`);
        }
        const j = await res.json();
        if (j.error) {
            const msg = j.error.message || JSON.stringify(j.error);
            // Surface throttling errors that come back inside a 200 body.
            if (/too many requests|rate.?limit/i.test(msg)) {
                throw new Error('Solana RPC is rate-limiting us. Please wait ~30 seconds and try again. (For production, set SOLANA_RPC_URL to a Helius/QuickNode endpoint.)');
            }
            throw new Error(`Solana RPC error: ${msg}`);
        }
        const value = j.result?.value;
        if (!value) return null;                 // account does not exist
        const dataField = value.data;
        const b64 = Array.isArray(dataField) ? dataField[0] : dataField;
        if (typeof b64 !== 'string') throw new Error('Unexpected data shape from Solana RPC');
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function _parseSplMint(buf, PublicKey) {
        if (!buf || buf.length < 82) throw new Error('Account is not a valid SPL mint (data too short).');
        // Coerce Uint8Array → Buffer-like access. Different SDK versions return
        // either a Node Buffer or a Uint8Array; DataView works on both.
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const u8   = (i) => view.getUint8(i);
        const u32  = (i) => view.getUint32(i, true);
        const u64  = (i) => view.getBigUint64(i, true);
        const slice = (a, b) => buf.slice(a, b);

        const mintAuthorityOption   = u32(0);
        const mintAuthority         = mintAuthorityOption === 1 ? new PublicKey(slice(4, 36)).toBase58() : null;
        const supply                = u64(36).toString();
        const decimals              = u8(44);
        const isInitialized         = u8(45) === 1;
        const freezeAuthorityOption = u32(46);
        const freezeAuthority       = freezeAuthorityOption === 1 ? new PublicKey(slice(50, 82)).toBase58() : null;

        return { mintAuthority, supply, decimals, isInitialized, freezeAuthority };
    }

    /**
     * Scan a Solana SPL Token
     */
    async function scanSolana(mintAddress, connection) {
        // If connection doesn't have the internal mock, apply it now to be safe
        const mockWS = {
            on: () => {},
            off: () => {},
            close: () => {},
            send: () => {},
            terminate: () => {},
            readyState: 3,
            addEventListener: () => {},
            removeEventListener: () => {}
        };
        if (connection && !connection._rpcWebSocketClient) {
            connection._rpcWebSocketClient = mockWS;
        }
        console.log(`[Scanner] Scanning Solana Token: ${mintAddress}`);
        try {
            const { PublicKey } = solanaWeb3;
            const mintPublicKey = new PublicKey(mintAddress);

            // 1. Get Mint Info — direct JSON-RPC, bypassing the SDK's strict
            //    response schema (which rejects modern RPC responses; see
            //    _rawGetAccountInfo for details). Manual SPL Mint layout
            //    parse below works for both classic SPL and Token-2022.
            const rpcUrl = connection?._rpcEndpoint || connection?.rpcEndpoint;
            if (!rpcUrl) throw new Error('Solana RPC endpoint not available on connection.');
            const dataBytes = await _rawGetAccountInfo(rpcUrl, mintAddress);
            if (!dataBytes) throw new Error('Token not found on Solana mainnet.');

            const data = _parseSplMint(dataBytes, PublicKey);
            const { decimals, supply } = data;

            // 2. Fetch metadata if possible (Metaplex)
            const metadata = await fetchMetaplexMetadata(mintAddress, connection);
            const name = metadata?.name || "SPL Token";
            const symbol = metadata?.symbol || "SPL";

            const totalSupplyBN = BigInt(supply);
            const onePercentBN = totalSupplyBN / 100n;

            const formattedTotal = Number(totalSupplyBN) / Math.pow(10, decimals);
            const formattedOnePercent = Number(onePercentBN) / Math.pow(10, decimals);

            // 3. Risk Assessment
            const redFlags = [];
            if (data.mintAuthority) {
                redFlags.push(`Active Mint Authority: ${data.mintAuthority}`);
            }
            if (data.freezeAuthority) {
                redFlags.push(`Active Freeze Authority: ${data.freezeAuthority}`);
            }

            const oneTokenBN = BigInt(10 ** decimals);

            // Authoritative server-side scan (RugCheck / Bubblemaps / market).
            let serverScan = null;
            try {
                serverScan = await window.DexHeroSecurity.evaluate({
                    tokenAddress: mintAddress,
                    chainId: 'solana',
                });
                for (const f of serverScan?.decision?.hardFlags || []) redFlags.push(f);
            } catch (e) {
                redFlags.push(`Safety scan service unavailable — cannot verify token. (${e.message})`);
            }

            return {
                success: true,
                type: 'Solana',
                address: mintAddress,
                chainId: 'solana',
                name,
                symbol,
                decimals,
                totalSupply: formattedTotal.toString(),
                onePercent: "1", // Hardcoded to 1 for testing
                onePercentRaw: oneTokenBN.toString(),
                oneToken: "1",
                oneTokenRaw: oneTokenBN.toString(),
                redFlags,
                decision: serverScan?.decision || null,
                market:   serverScan?.market   || null,
                security: serverScan?.security || null,
                cluster:  serverScan?.cluster  || null,
            };

        } catch (error) {
            console.error("[Scanner] Solana Error:", error);
            return { success: false, error: error.message };
        }
    }

    function isSolanaAddress(address) {
        if (!address) return false;
        // Solana addresses are Base58 strings, usually 32-44 characters
        // Simple regex to check for Base58 characters
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    }

    function isEVMAddress(address) {
        if (!address) return false;
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    return {
        scanEVM,
        scanSolana,
        isSolanaAddress,
        isEVMAddress
    };

})();
