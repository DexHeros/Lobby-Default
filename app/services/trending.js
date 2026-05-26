/* V3Labs trending service — feeds the stage carousel with created DexHeros.
   Source of truth: window.DexHeroTokens (exposed by /js/token-creation.js).
   That module merges the `models` table (DexHero Assets) + `tokens` table
   (legacy/Solana) and cross-references sprite data — same path the old
   homepage used to show all DexHeros. */

const TTL = 60 * 1000;
let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/** Wait up to timeoutMs for window.DexHeroTokens to be installed by the loader. */
async function dexHeroTokensReady(timeoutMs = 5000) {
    if (window.DexHeroTokens) return window.DexHeroTokens;
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (window.DexHeroTokens) return resolve(window.DexHeroTokens);
            if (Date.now() > deadline) return reject(new Error('DexHeroTokens not available'));
            setTimeout(tick, 80);
        };
        tick();
    });
}

export async function getTrendingHeroes(limit = 10) {
    const now = Date.now();
    if (_cache && now - _cacheAt < TTL) return _cache.slice(0, limit);
    if (_inflight) return _inflight;

    _inflight = (async () => {
        try {
            const api = await dexHeroTokensReady();
            // Prefer random sampling (like the old homepage's featuredResult)
            // so every refresh surfaces a different slice of DexHeros.
            let result = await api.getRandomTokens(Math.max(limit * 3, 30));
            if (!result?.success || !result.tokens?.length) {
                // Fallback: latest by creation date
                result = await api.getLatestTokens(limit);
            }
            const tokens = (result?.tokens || []).filter((t) => t && t.name);
            _cache = tokens.map(shape);
            _cacheAt = Date.now();
            return _cache.slice(0, limit);
        } catch (err) {
            console.warn('[trending] fetch failed, using fallback:', err.message);
            _cache = fallback();
            _cacheAt = Date.now();
            return _cache.slice(0, limit);
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

export function bust() { _cache = null; _cacheAt = 0; }

/**
 * Public-lobby ranking: sort by adoption (players_count desc), then newest.
 * Used when no wallet/Steam is signed in. Skips the random-sample cache that
 * getTrendingHeroes uses — this is called once per auth-state change, not
 * per page paint, so caching adds complexity without saving requests.
 */
export async function getTopHeroes(limit = 10) {
    try {
        const api = await dexHeroTokensReady();
        // getAllTokens(useCache=true) returns a merged + cached view of
        // the models + tokens tables (DexHero Assets + legacy).
        const res = await api.getAllTokens(true);
        const tokens = (res?.tokens || [])
            .filter((t) => t && t.name)
            .sort((a, b) => {
                const pa = Number(a.players_count || a.holders_count || 0);
                const pb = Number(b.players_count || b.holders_count || 0);
                if (pb !== pa) return pb - pa;
                return new Date(b.created_at || 0) - new Date(a.created_at || 0);
            });
        const list = tokens.slice(0, limit).map(shape);
        // Fall back to the placeholder card when the DB is empty (fresh
        // install / local dev). Without this the stage renders nothing
        // because `_items.length` is zero and `_paintCurrent` short-
        // circuits — the lobby just sits there with no model.
        return list.length ? list : fallback();
    } catch (err) {
        console.warn('[trending] getTopHeroes failed:', err.message);
        return fallback();
    }
}

/**
 * Personal-lobby data source: the DexHeros owned by ANY of the passed
 * wallets (union, deduped). Accepts a single string OR an array — the
 * multi-wallet form supports "merge accounts via Steam link", where one
 * Steam session may have several wallets bonded to it.
 *
 * Returns [] when none of the wallets owns anything — the caller (stage)
 * renders a "Create your first DexHero" CTA card so the carousel never
 * looks broken.
 *
 * Note: `steam:<id>` synthetic keys are filtered out — Steam-only users
 * without a linked wallet have no on-chain ownership and therefore no
 * personal DexHeros to surface here. The shell resolver should pick
 * linked wallets when present and only fall through to the synthetic
 * key for background preferences, not the carousel.
 */
export async function getMyHeroes(walletOrWallets, limit = 10) {
    const list = Array.isArray(walletOrWallets) ? walletOrWallets : [walletOrWallets];
    const wallets = list
        .filter((w) => typeof w === 'string' && /^0x[0-9a-f]{40}$/i.test(w))
        .map((w) => w.toLowerCase());
    if (!wallets.length) return [];
    try {
        const api = await dexHeroTokensReady();
        // Query each wallet's tokens in parallel; union by id (preferring
        // the first occurrence). Sort by newest creation date overall so
        // the user's freshest DexHero leads regardless of which wallet
        // minted it.
        const results = await Promise.all(wallets.map((w) =>
            api.getUserTokens(w).then((r) => r?.tokens || []).catch(() => [])
        ));
        const seen = new Set();
        const merged = [];
        for (const arr of results) {
            for (const t of arr) {
                if (!t || !t.name) continue;
                const key = t.id || t.contract_address || t.manager_address;
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);
                merged.push(t);
            }
        }
        merged.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return merged.slice(0, limit).map(shape);
    } catch (err) {
        console.warn('[trending] getMyHeroes failed:', err.message);
        return [];
    }
}

/** Normalize the token record (from DexHeroTokens) into a stage-subject shape.
    The stage-subject renderer expects: name, symbol, address, network, image, model, sprite, spriteFrames. */
function shape(t) {
    const address = t.manager_address || t.contract_address || null;
    const network = t.network || t.chain || 'ethereum';
    return {
        id: t.id,
        name: t.name,
        symbol: t.symbol || '',
        address,
        network,
        image: t.image_url || t.thumbnail_url || null,
        model: t.model_url || null,
        sprite: t.sprite_url || null,
        spriteFrames: t.sprite_frame_count || 0,
        holders: t.holders_count || t.players_count || 0,
        // Gamified-roster stats — surfaced under the carousel nameplate
        // so the player can scan adoption + breadth at a glance. The
        // carousel is sorted by players_count desc, so the top of the
        // list is implicitly the highest-ranked DexHero.
        players: Number(t.players_count || 0),
        games:   Number(t.games_count   || 0),
        marketCap: t.market_cap || 0,
        change24h: parseFloat(t.price_change_24h || 0),
        // Mint / purchase price in USDC. Picks the most specific field
        // present so the lobby's slider title can show "Included Games ·
        // <name> · $0.12" right next to the centered hero.
        price: Number(t.price_usdc ?? t.purchase_price_usdc ?? t.base_price ?? t.rental_price_usdc ?? 0) || 0,
        created_at: t.created_at || null,
        // Platform-default flag — set on at most one row via
        // db/mark-default-dexhero.sql. Pinned to slot 0 by stage.js.
        isDefault: !!t.is_default,
    };
}

function fallback() {
    return [{
        id: 'idle',
        name: 'DEXHERO',
        symbol: 'DXH',
        address: null,
        network: 'ethereum',
        image: null, model: null, sprite: null, spriteFrames: 0,
        holders: 0, marketCap: 0, change24h: 0,
    }];
}
