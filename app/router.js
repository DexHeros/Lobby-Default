/* V3Labs router — hash-based, supports params (#/token/:address),
   dynamic panel imports, and a single active-panel stack. */

import { emit, E } from './events.js';

const ROUTES = [
    // [pattern, panelModulePath, meta]
    { pat: /^$/,                                      mod: './panels/home.js'          },
    { pat: /^market\/?$/,                             mod: './panels/market.js'        },
    { pat: /^market\/(dexheros|tokens|games|steam)$/, mod: './panels/market.js'        },
    { pat: /^token\/([^/]+)$/,                        mod: './panels/token-detail.js', params: ['address'] },
    { pat: /^game\/([^/]+)$/,                         mod: './panels/game-dashboard.js', params: ['id'] },
    { pat: /^create\/?$/,                             mod: './panels/create.js'        },
    { pat: /^create\/dexhero$/,                       mod: './panels/create-dexhero.js' },
    { pat: /^create\/type$/,                          mod: './panels/create-token-type.js' },
    { pat: /^create\/token-type$/,                    mod: './panels/create-token-type.js' },
    { pat: /^create\/index$/,                         mod: './panels/create.js'        },
    { pat: /^register-game$/,                         mod: './panels/register-game.js' },
    { pat: /^manage\/?$/,                             mod: './panels/manage.js'        },
    { pat: /^profile\/?$/,                            mod: './panels/profile.js'       },
    { pat: /^models\/?$/,                             mod: './panels/model-marketplace.js' },
    { pat: /^models\/buy\/([^/]+)$/,                  mod: './panels/purchase-model.js', params: ['id'] },
    { pat: /^models\/upload$/,                        mod: './panels/upload-model.js' },
    { pat: /^models\/generate$/,                      mod: './panels/generate-model.js' },
    { pat: /^liquidity\/add(?:\/([^/]+))?$/,          mod: './panels/add-liquidity.js', params: ['token'] },
    { pat: /^liquidity\/remove(?:\/([^/]+))?$/,       mod: './panels/remove-liquidity.js', params: ['token'] },
    { pat: /^nodes\/?$/,                              mod: './panels/node-dashboard.js' },
    { pat: /^nodes\/onboard$/,                        mod: './panels/node-onboarding.js' },
    { pat: /^cloud-gaming$/,                          mod: './panels/cloud-gaming.js' },
    { pat: /^host\/?$/,                               mod: './panels/host.js'          },
    { pat: /^host\/queue-status$/,                    mod: './panels/host-queue-status.js' },
    { pat: /^host\/install$/,                         mod: './panels/host-install.js' },
    { pat: /^status\/?$/,                             mod: './panels/status.js'        },
    { pat: /^play\/?$/,                               mod: './panels/play.js'          },
    { pat: /^buy-pass\/?$/,                           mod: './panels/buy-pass.js'      },
    { pat: /^publish\/?$/,                            mod: './panels/publish-module.js' },
    { pat: /^publish\/(brain|voice|movement|body)$/,  mod: './panels/publish-module.js', params: ['category'] },
    { pat: /^developer$/,                             mod: './panels/developer-portal.js' },
    { pat: /^admin\/?$/,                              mod: './admin/console.js'        },
    { pat: /^admin\/games$/,                          mod: './panels/admin-games.js' },
    { pat: /^estimate$/,                              mod: './panels/threshold-estimator.js' },
    { pat: /^buy-feature$/,                           mod: './panels/buy-feature.js' },
    { pat: /^select-chain$/,                          mod: './panels/select-chain.js' },
    { pat: /^update-metadata$/,                       mod: './panels/update-metadata.js' },
    { pat: /^docs\/?$/,                               mod: './panels/api-docs.js'       },
    { pat: /^docs\/api$/,                             mod: './panels/api-docs.js'       },
    { pat: /^docs\/guides$/,                          mod: './panels/guides.js'         },
    { pat: /^fees$/,                                  mod: './panels/fees.js'           },
    { pat: /^referrals$/,                             mod: './panels/referrals.js'      },
    { pat: /^privacy$/,                               mod: './panels/privacy.js'        },
    { pat: /^terms$/,                                 mod: './panels/terms.js'          },
    { pat: /^play\/([^/]+)$/,                         mod: './panels/play-game.js',     params: ['id'] },

    // Community-built everything-avatar (Stage A). Plan file:
    // /Users/mojo/.claude/plans/i-want-you-to-twinkly-phoenix.md
    { pat: /^community-upgrades$/,                    mod: './panels/community-upgrades.js' },
    { pat: /^upgrade\/([^/]+)$/,                      mod: './panels/upgrade-detail.js',    params: ['id'] },
    { pat: /^creator\/([^/]+)$/,                      mod: './panels/creator-profile.js',   params: ['username'] },
    { pat: /^profile\/upgrades$/,                     mod: './panels/profile-upgrades.js' },
    { pat: /^profile\/autonomous$/,                   mod: './panels/profile-autonomous.js' },
    { pat: /^credits$/,                               mod: './panels/credits.js' },
    { pat: /^main$/,                                  mod: './panels/main-branch.js' },
];

const moduleCache = new Map();
let currentPanel = null;
let currentRoute = null;
let panelHost = null;

/* Count of panels the user has visited since last returning to home (#/).
   Used by the panel chrome to decide whether a Back button makes sense:
   at depth >= 2 there's a previous panel to pop to, so we show Back even
   when the panel didn't declare a static parentHash. */
let panelsSinceHome = 0;

function parseHash() {
    const raw = (location.hash || '#/').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const path = (pathPart || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const query = {};
    if (queryPart) {
        for (const kv of queryPart.split('&')) {
            if (!kv) continue;
            const [k, v = ''] = kv.split('=');
            query[decodeURIComponent(k)] = decodeURIComponent(v);
        }
    }
    return { path, query, raw };
}

function match(path) {
    for (const route of ROUTES) {
        const m = route.pat.exec(path);
        if (m) {
            const params = {};
            (route.params || []).forEach((name, i) => {
                if (m[i + 1] != null) params[name] = decodeURIComponent(m[i + 1]);
            });
            // Tab param for /market/tokens etc.
            if (route.pat === /^market\/(tokens|games)$/ || String(route.pat).includes('market')) {
                if (m[1]) params.tab = m[1];
            }
            return { route, params };
        }
    }
    return null;
}

async function loadModule(path) {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const mod = await import(path);
    moduleCache.set(path, mod);
    return mod;
}

async function activate() {
    const { path, query } = parseHash();
    const matched = match(path);

    if (!matched) {
        // Unknown route → home
        if (path !== '') { location.hash = '#/'; return; }
    }

    const { route, params } = matched || { route: ROUTES[0], params: {} };
    const fullParams = { ...(params || {}), ...(query || {}) };

    // Depth tracking: reset at home, increment on each new non-home panel.
    // Skip increments for same-route param updates (handled further down).
    if (path === '') panelsSinceHome = 0;
    else if (currentRoute !== route) panelsSinceHome++;

    emit(E.ROUTE_CHANGE, { path, params: fullParams });

    // Same panel, just params changed → call onParamsChange
    if (currentPanel && currentRoute === route && currentPanel.constructor.variant !== 'home') {
        currentPanel.onParamsChange?.(fullParams);
        return;
    }

    // Close current panel (if any)
    if (currentPanel) {
        const p = currentPanel;
        currentPanel = null;
        p.close();
    }
    currentRoute = route;

    try {
        const mod = await loadModule(route.mod);
        const PanelClass = mod.default || Object.values(mod).find((x) => typeof x === 'function');
        if (!PanelClass) throw new Error(`Panel module ${route.mod} has no default export`);
        const inst = new PanelClass(fullParams);
        inst.onClose(() => {
            if (currentPanel === inst) {
                currentPanel = null;
                currentRoute = null;
                // Restore stage to idle when closing any context panel via close button
                try {
                    import('./stage.js').then(({ setIdle }) => setIdle());
                } catch {}
                // Navigate back to the lobby home so the HomePanel re-mounts
                // and re-paints the left + right wings. Using location.hash
                // (not history.pushState) guarantees a hashchange event fires,
                // which is what the router listens for to activate routes.
                if (!_navSuppressBack) {
                    if (location.hash && location.hash !== '#/') {
                        location.hash = '#/';
                    } else {
                        // Already at #/ — the home panel isn't mounted because
                        // we just closed it via nav flow; re-activate manually.
                        activate();
                    }
                }
            }
        });
        currentPanel = inst;
        panelHost.setAttribute('data-has-panels', 'true');
        await inst.mount(panelHost);
    } catch (err) {
        console.error('[router] panel load failed:', err);
        // Render a minimal error card in the panel host
        const box = document.createElement('section');
        box.className = 'panel panel--right';
        box.style.setProperty('--panel-w', '420px');
        box.innerHTML = `
            <header class="panel__head"><div class="panel__title"><strong>ERROR</strong></div></header>
            <div class="panel__body"><div class="panel-state"><div class="panel-state__title">Panel failed to load</div><div class="panel-state__body">${(err.message || err).toString()}</div></div></div>`;
        panelHost.appendChild(box);
        setTimeout(() => box.setAttribute('data-state', 'mounted'), 10);
    }
}

let _navSuppressBack = false;

export const router = {
    init(host) {
        panelHost = host;
        window.addEventListener('hashchange', activate);
        // Cross-frame nav bridge — legacy iframes (e.g. pages/create-dexhero.html)
        // run inside a same-origin sandbox WITHOUT allow-top-navigation, so they
        // can't drive `window.top.location` directly. They postMessage the
        // intended hash; we accept same-origin messages and navigate the SPA.
        //
        // Silent-reattach trigger: legacy iframes connect the user's wallet
        // through their own path (blockchain-integration.js) which doesn't
        // populate the SPA wallet service's STATE. After the iframe finishes
        // and asks us to navigate, we silently re-hydrate the SPA wallet
        // state from window.ethereum's eth_accounts so the destination panel
        // sees the user as connected.
        window.addEventListener('message', async (e) => {
            if (e.origin !== window.location.origin) return;
            if (e.data && e.data.type === 'dexhero:navigate' && typeof e.data.href === 'string') {
                try {
                    const wallet = await import('./services/wallet.js');
                    if (typeof wallet.silentReattach === 'function') {
                        await wallet.silentReattach();
                    }
                } catch (_) { /* non-fatal */ }
                const h = e.data.href.replace(/^\/?#?/, '#');
                if (h.startsWith('#/')) location.hash = h;
            }
        });
        // Prime on load — default landing is the lobby home. (Earlier
        // builds primed #/main on phones because the DNA social feed
        // was hosted there; the feed has since moved to the right-wing
        // and is accessed via the stage right-arrow, so the mobile
        // default no longer needs to be the chart page.)
        if (!location.hash) location.hash = '#/';
        activate();
    },
    go(hash) {
        if (hash === location.hash) { activate(); return; }
        location.hash = hash.startsWith('#') ? hash : `#/${hash.replace(/^\/+/, '')}`;
    },
    back() {
        _navSuppressBack = true;
        history.back();
        setTimeout(() => { _navSuppressBack = false; }, 100);
    },
    current() { return { route: currentRoute, panel: currentPanel, hash: location.hash }; },
    /* True if the user has visited at least two panels since last returning
       to home, i.e. there's a previous panel in this session's hash history
       that `history.back()` can meaningfully pop to. */
    canGoBack() { return panelsSinceHome >= 2; },
};
