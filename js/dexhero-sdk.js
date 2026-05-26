/**
 * DexHero Game SDK
 *
 * Include this script in your game's index.html to enable DexHero character
 * integration when your game is hosted on the V3Labs platform.
 *
 * Usage:
 *   <script src="https://YOUR_PLATFORM_DOMAIN/js/dexhero-sdk.js"></script>
 *
 *   // Get all DexHeros the connected player has access to (from your allowlist)
 *   const { dexheros } = await window.DexHeroSDK.getPlayerDexheros();
 *
 *   // Get the hero the player selected in the platform UI
 *   const { heroId, wallet } = await window.DexHeroSDK.getSelectedDexhero();
 *
 *   // Get metadata for a specific hero by UUID
 *   const { dexhero } = await window.DexHeroSDK.getDexhero(heroId);
 *
 *   // React to hero selection changes
 *   window.DexHeroSDK.onHeroSelected(({ heroId, wallet }) => { ... });
 *
 * All methods return Promises that resolve with the API response or reject on
 * timeout (5 seconds). The platform wrapper handles authentication — your game
 * never needs an API key.
 *
 * For self-hosted games (not hosted on V3Labs), call the REST API directly:
 *   GET /api/game/player/dexheros?wallet=0x...
 *   X-API-Key: dh_live_<your_key>
 */
window.DexHeroSDK = (() => {
    const _pending = new Map(); // id → { resolve, reject, timeout }

    window.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'dexhero:rpcResponse') return;
        const p = _pending.get(e.data.id);
        if (!p) return;
        clearTimeout(p.timeout);
        _pending.delete(e.data.id);
        if (e.data.error) {
            p.reject(new Error(e.data.error));
        } else {
            p.resolve(e.data.result);
        }
    });

    function _rpc(method, params) {
        return new Promise((resolve, reject) => {
            const id = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2) + Date.now().toString(36);

            const timeout = setTimeout(() => {
                _pending.delete(id);
                reject(new Error('DexHeroSDK timeout: ' + method));
            }, 5000);

            _pending.set(id, { resolve, reject, timeout });

            window.parent.postMessage(
                { type: 'dexhero:rpc', id, method, params: params || {} },
                '*'
            );
        });
    }

    return {
        /**
         * Returns all DexHeros on this game's allowlist that the connected
         * player has active access to (permanent owner or active rental).
         * @returns {Promise<{ dexheros: Array, checked_at: string }>}
         */
        getPlayerDexheros() {
            return _rpc('getPlayerDexheros');
        },

        /**
         * Returns the DexHero the player selected in the platform UI chip bar,
         * plus the connected wallet address.
         * @returns {Promise<{ heroId: string|null, wallet: string|null }>}
         */
        getSelectedDexhero() {
            return _rpc('getSelectedDexhero');
        },

        /**
         * Returns full metadata for a specific DexHero by its UUID.
         * @param {string} id - DexHero token UUID
         * @returns {Promise<{ dexhero: object }>}
         */
        getDexhero(id) {
            return _rpc('getDexhero', { id });
        },

        /**
         * Register a callback for when the player changes their selected DexHero.
         * @param {function} callback - called with { heroId, wallet }
         */
        onHeroSelected(callback) {
            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'dexhero:heroSelected') {
                    callback({ heroId: e.data.heroId, wallet: e.data.wallet });
                }
            });
        }
    };
})();
