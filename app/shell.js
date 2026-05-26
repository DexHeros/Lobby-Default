/* V3Labs shell bootstrap — wires services, stage, router, nav, bar.
   Single entry from index.html via <script type="module"> */

import * as wallet from './services/wallet.js';
import { initSteamSession, getSteamToken, clearSteamSession, steamFetch } from './services/steam-session.js';
import { initConnectMaster } from './ui/connect-master.js';
import { initStage, rebuildRibbon } from './stage.js';
import { router } from './router.js';
import { toast } from './ui/toast.js';
import { emit, on, E } from './events.js';
import { fmtAddress } from './ui/panel.js';
import { getActiveAccount, removeAccount as removeLlmAccount } from './services/llm-connect.js';
import { getProvider } from './services/llm-providers.js';

/* Primary nav tabs — the Fortnite lobby top bar */
const TABS = [
    { id: 'home',    label: 'Lobby',    hash: '#/',                match: (h) => h === '' || h === '#/' },
    { id: 'play',    label: 'Play',     hash: '#/play',            match: (h) => h === '#/play' || h.startsWith('#/play/') },
    { id: 'market',  label: 'Market',   hash: '#/market',          match: (h) => h.startsWith('#/market') || h.startsWith('#/token/') },
    { id: 'register',label: 'Register', hash: '#/register-game',   match: (h) => h === '#/register-game' },
    { id: 'host',    label: 'Host',     hash: '#/host',            match: (h) => h === '#/host' || h.startsWith('#/nodes') || h === '#/cloud-gaming' },
    // Profile is now reached via the chip dropdown (wallet/Steam) instead
    // of a top-nav tab to slim the header. The route still works for
    // deep-links; updateActiveTab simply won't highlight any tab while on it.
    { id: 'docs',    label: 'Docs',     hash: '#/docs',            match: (h) => h.startsWith('#/docs') || h === '#/fees' },
];

/* Secondary links surfaced inside the mobile dropdown only — these aren't
   primary tabs but are still reachable on phones via the slide-out menu.
   DNA Feed leads because phones default-land on #/main and users will want
   to navigate back there from anywhere; the header CTA was hidden on phones
   so the hamburger has room. */
const MOBILE_EXTRA = [
    { label: 'Genetics',            hash: '#/main'             },
    { label: 'Your Branch',         hash: '#/profile/upgrades' },
    { label: 'Autonomous Mode',     hash: '#/profile/autonomous' },
    { label: 'Community Upgrades',  hash: '#/community-upgrades' },
    { label: 'Credits',             hash: '#/credits'          },
    { label: 'Manage',     hash: '#/manage'           },
    { label: 'Referrals',  hash: '#/referrals'        },
    { label: 'Fees',       hash: '#/fees'             },
    { label: 'X',          href: 'https://x.com/DexHero', external: true },
];

/* DOM refs populated in boot() */
const dom = {};

async function boot() {
    // Mark body so shell CSS applies
    document.body.classList.add('lobby-body');

    // Purge any chat history saved under the anon namespace from older
    // builds. Anonymous visitors get no localStorage persistence — a
    // refresh always starts fresh; wallet-keyed history is preserved.
    try {
        const chat = await import('./services/dexhero-chat.js');
        chat.purgeAnonChatHistory?.();
    } catch { /* non-fatal */ }

    // Resolve DOM refs
    dom.root       = document.getElementById('lobby-root');
    dom.ticker     = document.getElementById('lobby-ticker');
    dom.tabs       = document.getElementById('lobby-tabs');
    dom.leftWing   = document.getElementById('lobby-wing-left');
    dom.rightWing  = document.getElementById('lobby-wing-right');
    dom.stage      = document.getElementById('lobby-stage');
    dom.stageWrap  = document.querySelector('.lobby-stage-wrap');
    dom.carousel   = document.getElementById('lobby-carousel');
    dom.solo       = document.getElementById('lobby-stage-solo');
    dom.subject    = document.getElementById('lobby-stage-subject');
    dom.nameplate  = document.getElementById('lobby-stage-nameplate');
    dom.dots       = document.getElementById('lobby-stage-dots');
    dom.caption    = document.getElementById('lobby-stage-caption');
    dom.prevBtn    = document.getElementById('lobby-stage-prev');
    dom.nextBtn    = document.getElementById('lobby-stage-next');
    dom.slots      = document.getElementById('lobby-stage-slots');
    dom.bar        = document.getElementById('lobby-bar');
    dom.barChip    = document.getElementById('lobby-bar-chip');
    dom.walletBtn  = document.getElementById('lobby-wallet');
    dom.walletPop     = document.getElementById('lobby-wallet-pop');
    dom.steamBtn      = document.getElementById('lobby-steam');
    dom.steamPop      = document.getElementById('lobby-steam-pop');
    dom.steamAvatar   = document.getElementById('lobby-steam-avatar');
    dom.steamLabel    = document.getElementById('lobby-steam-label');
    dom.llmBtn        = document.getElementById('lobby-llm');
    dom.llmPop        = document.getElementById('lobby-llm-pop');
    dom.llmLabel      = dom.llmBtn?.querySelector('.lobby-llm__label') || null;
    dom.linkBtn       = document.getElementById('lobby-link');
    dom.linkPopover   = document.getElementById('lobby-link-popover');
    dom.brandWrap     = document.getElementById('lobby-brand-wrap');
    dom.brandPop      = document.getElementById('lobby-brand-pop');
    dom.panelHost  = document.getElementById('lobby-panels');

    // Build top-nav tabs
    renderTabs();

    // Build mobile slide-out nav (hamburger menu) — only visible at ≤768px
    renderMobileNav();

    // Boot services (non-blocking; services handle their own delayed init)
    wallet.init().catch((err) => console.warn('[shell] wallet init:', err.message));

    // Autonomous DNA-Feed agent (Item 6) — if the user had it enabled
    // last session, re-arm the loop. Idempotent + safe even when the
    // wallet/brain aren't connected yet (the tick itself checks).
    import('./services/autonomous-agent.js').then((m) => {
        try { m.bootFromSettings(); } catch (err) { console.warn('[autonomous] boot:', err.message); }
    }).catch(() => {});

    // Steam: pull any token left in the URL hash by /api/steam/auth/callback
    // into sessionStorage, then strip it from the address bar. This MUST
    // run before the router so the cleaned hash is what gets routed.
    initSteamSession();

    // Unified Connections button + popover. Replaces the cluster of
    // header chips that used to surface LLM / Steam / link CTAs
    // individually. Legacy chips remain in the DOM (hidden) so their
    // existing JS hooks keep populating state in the background.
    initConnectMaster();

    // Wire top-nav listeners
    dom.walletBtn.addEventListener('click', onWalletBtnClick);
    on(E.WALLET_CHANGED, renderWalletChip);
    on(E.WALLET_CHANGED, renderMobileWalletAction);

    // Steam button — sits next to the wallet button. Sign-in routes to the
    // OpenID flow; while signed in shows the persona avatar + name and a
    // click toggles sign-out. State persists site-wide via the SPA session
    // service (sessionStorage token + cookie fallback).
    if (dom.steamBtn) {
        dom.steamBtn.addEventListener('click', onSteamBtnClick);
        // Repaint Steam chip whenever the wallet changes (a wallet-link can
        // promote a cookie-only session into a wallet-bound link, etc.).
        on(E.WALLET_CHANGED, () => refreshSteamChip().catch(() => {}));
        // Initial paint
        refreshSteamChip().catch(() => {});
    }

    // Link button (⇄) — bridges the connected wallet to the active Steam
    // account so DexHeros from both pile into one personal lobby. Repaints
    // on every wallet/Steam change.
    if (dom.linkBtn) {
        dom.linkBtn.addEventListener('click', onLinkBtnClick);
        on(E.WALLET_CHANGED, () => refreshLinkIcon().catch(() => {}));
        refreshLinkIcon().catch(() => {});
    }

    // LLM brain chip — third top-level identity alongside Wallet and Steam.
    // When empty: opens the existing LLM Connect modal (fires the same
    // `dexhero:open-llm-connect` event the workshop brain picker uses).
    // When connected: toggles a Disconnect popover. State source of truth is
    // app/services/llm-connect.js; we resync on every related event.
    if (dom.llmBtn) {
        dom.llmBtn.addEventListener('click', onLlmBtnClick);
        on(E.WALLET_CHANGED, () => renderLlmChip());
        document.addEventListener('dexhero:llm-account-changed', () => renderLlmChip());
        document.addEventListener('dexhero:vault-unlocked',     () => renderLlmChip());
        renderLlmChip();
    }

    // Brand hover-popover — Lobby Background picker lives here now so a
    // signed-in user can swap the backdrop one-click without leaving the
    // lobby. Open on hover OR tap (touch users); close on mouseleave OR
    // click-outside. Visible only when signed in (wallet OR Steam).
    if (dom.brandWrap && dom.brandPop) {
        let hideTimer = null;
        const show = () => {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            if (dom.brandPop.hidden) {
                renderBrandBgPicker();   // re-render so swatches show the current pref
                dom.brandPop.hidden = false;
            }
        };
        const scheduleHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { dom.brandPop.hidden = true; hideTimer = null; }, 180);
        };
        dom.brandWrap.addEventListener('mouseenter', show);
        dom.brandWrap.addEventListener('mouseleave', scheduleHide);
        dom.brandWrap.addEventListener('focusin', show);
        dom.brandWrap.addEventListener('focusout', (e) => {
            // Only hide if focus leaves the wrap entirely (not just child→child).
            if (!dom.brandWrap.contains(e.relatedTarget)) scheduleHide();
        });
        on(E.WALLET_CHANGED, () => loadBrandBg().catch(() => {}));
        loadBrandBg().catch(() => {});
    }

    // Single click-outside listener covers all three header popovers
    // (Steam, ⇄ link, Wallet) — dismiss whichever is open when the click
    // lands outside its own chip + its own popover.
    document.addEventListener('click', (e) => {
        const closeIfOutside = (btn, pop) => {
            if (!btn || !pop || pop.hidden) return;
            if (btn.contains(e.target) || pop.contains(e.target)) return;
            pop.hidden = true;
        };
        closeIfOutside(dom.linkBtn,   dom.linkPopover);
        closeIfOutside(dom.walletBtn, dom.walletPop);
        closeIfOutside(dom.steamBtn,  dom.steamPop);
    });

    // Repaint nav active state on hashchange + auto-close mobile nav
    window.addEventListener('hashchange', () => {
        updateActiveTab();
        closeMobileNav();
        // Re-poll Steam: covers the post-OpenID return (callback redirects
        // back to the SPA with a fresh token in the hash) and any other
        // route change where the linked status might have shifted.
        refreshSteamChip().catch(() => {});
        // Post-Steam-OpenID we also need to re-resolve the lobby (the
        // ownerKey just changed). Cheap when nothing changed since
        // resolveOwnerKey reads from in-memory state + a single fetch.
        if ((location.hash || '').includes('steam_link=ok')) {
            rebuildLobby().catch(() => {});
        }
    });

    // Kick off carousel + stage (initial paint uses the public top list;
    // rebuildLobby() below re-resolves immediately for signed-in users).
    initStage({
        stage:     dom.stage,
        stageWrap: dom.stageWrap,
        leftWing:  dom.leftWing,
        rightWing: dom.rightWing,
        carousel:  dom.carousel,
        solo:      dom.solo,
        subject:   dom.subject,
        nameplate: dom.nameplate,
        dots:      dom.dots,
        caption:   dom.caption,
        prevBtn:   dom.prevBtn,
        nextBtn:   dom.nextBtn,
        slots:     dom.slots,
    });

    // Cycle Bg1→Bg4 each time the carousel lands on a new DexHero.
    initLobbyBgCycle();

    // Personalize the lobby whenever auth state changes: wallet
    // connect/disconnect or Steam link/unlink. Initial call also runs
    // on boot so an already-connected user sees their carousel + saved
    // background without needing to reconnect.
    on(E.WALLET_CHANGED, () => rebuildLobby().catch((err) => console.warn('[shell] rebuildLobby:', err.message)));
    rebuildLobby().catch((err) => console.warn('[shell] rebuildLobby (boot):', err.message));

    // Ticker
    primeTicker();

    // Community-built upgrades — apply any patches the local user has
    // authored or adopted. Promoted-to-main patches load for ALL users
    // as part of the default base. See Stage A plan.
    import('./services/patch-applier-mock.js')
        .then((m) => m.initPatchApplier())
        .catch((err) => console.warn('[shell] patch-applier:', err?.message));

    // Site-wide "Changes · ON/OFF" toggle in the bottom bar — non-
    // destructive switch that pauses every patch so the user sees the
    // platform default (= what's currently in git main) without losing
    // their commit history. Flipping back restores their lobby to the
    // exact state it was in.
    initChangesToggle();
    initAutonomousToggle();

    // Router → mounts the right panel based on hash
    router.init(dom.panelHost);
    updateActiveTab();

    // First-time wallet chip paint (reflect any pre-existing session)
    renderWalletChip(wallet.getStatus());

    // Live counters in the bottom bar (next to the ONLINE chip).
    // Refresh every 30s while the app is open. Best-effort — silently
    // ignore failures; the bar just shows the last-known value.
    primeLiveStats();
    setInterval(primeLiveStats, 30_000);
}

async function primeLiveStats() {
    const host = document.getElementById('lobby-bar-stats');
    if (!host) return;
    try {
        const r = await fetch('/api/stats/live').then((r) => r.json());
        if (!r) return;
        const fmt = (n) => {
            n = Number(n) || 0;
            if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
            return String(n);
        };
        const set = (k, v) => {
            const el = host.querySelector(`[data-stat="${k}"]`);
            if (el) el.textContent = fmt(v);
        };
        set('players', r.playersOnline);
        set('servers', r.serversLive);
        set('sessions', r.sessions24h);
    } catch { /* keep last-known values */ }
}

function renderTabs() {
    dom.tabs.innerHTML = TABS.map((t) => (
        `<a class="lobby-tab" data-tab="${t.id}" href="${t.hash}">${t.label}</a>`
    )).join('');
}

function renderMobileNav() {
    // Avoid double-injection on hot-reload.
    if (document.getElementById('lobby-mobile-nav-panel')) return;

    const overlay = document.createElement('div');
    overlay.className = 'mobile-nav-overlay';
    overlay.id = 'lobby-mobile-nav-overlay';

    const panel = document.createElement('div');
    panel.className = 'mobile-nav-panel';
    panel.id = 'lobby-mobile-nav-panel';

    const navLinks = TABS.map((t) =>
        `<a href="${t.hash}" data-mobile-tab="${t.id}">${escape(t.label)}</a>`
    ).join('');

    const extraLinks = MOBILE_EXTRA.map((x) => x.external
        ? `<a href="${x.href}" target="_blank" rel="noopener">${escape(x.label)}</a>`
        : `<a href="${x.hash}">${escape(x.label)}</a>`
    ).join('');

    panel.innerHTML = `
        <div class="mobile-nav-header">
            <h3>Menu</h3>
            <button class="mobile-nav-close" id="lobby-mobile-nav-close" type="button" aria-label="Close menu"></button>
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">Navigate</div>
            ${navLinks}
        </div>
        <div class="mobile-nav-section">
            <div class="mobile-nav-section-title">More</div>
            ${extraLinks}
        </div>
        <div class="mobile-nav-actions">
            <button class="btn-connect" id="lobby-mobile-wallet" type="button">Connect Wallet</button>
            <button class="btn-connect btn-connect--steam" id="lobby-mobile-steam" type="button">Steam</button>
            <button class="btn-connect btn-connect--link" id="lobby-mobile-link" type="button" hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="17 1 21 5 17 9"/>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <polyline points="7 23 3 19 7 15"/>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                </svg>
                <span>Link wallet ↔ Steam</span>
            </button>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    dom.menuToggle = document.getElementById('lobby-menu-toggle');
    dom.mobileNavOverlay = overlay;
    dom.mobileNavPanel = panel;
    dom.mobileWalletBtn = document.getElementById('lobby-mobile-wallet');
    dom.mobileSteamBtn  = document.getElementById('lobby-mobile-steam');
    dom.mobileLinkBtn   = document.getElementById('lobby-mobile-link');

    if (dom.menuToggle) {
        dom.menuToggle.addEventListener('click', () => {
            if (dom.mobileNavPanel.classList.contains('open')) closeMobileNav();
            else openMobileNav();
        });
    }
    overlay.addEventListener('click', closeMobileNav);
    document.getElementById('lobby-mobile-nav-close')?.addEventListener('click', closeMobileNav);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.mobileNavPanel.classList.contains('open')) closeMobileNav();
    });
    dom.mobileWalletBtn.addEventListener('click', onMobileWalletBtnClick);
    dom.mobileSteamBtn?.addEventListener('click', () => { closeMobileNav(); onSteamBtnClick(); });
    dom.mobileLinkBtn?.addEventListener('click', () => { closeMobileNav(); onLinkBtnClick(); });

    renderMobileWalletAction(wallet.getStatus());
    syncMobileSteamAndLink();
}

function syncMobileSteamAndLink() {
    if (dom.mobileSteamBtn && dom.steamBtn) {
        const linked = dom.steamBtn.getAttribute('data-linked') === 'true';
        const label = dom.steamLabel?.textContent || 'Steam';
        dom.mobileSteamBtn.textContent = linked ? `${label} — Sign out` : 'Sign in with Steam';
        dom.mobileSteamBtn.classList.toggle('connected', linked);
    }
    if (dom.mobileLinkBtn && dom.linkBtn) {
        dom.mobileLinkBtn.hidden = !!dom.linkBtn.hidden;
        const state = dom.linkBtn.getAttribute('data-state') || 'hidden';
        dom.mobileLinkBtn.setAttribute('data-state', state);
        const span = dom.mobileLinkBtn.querySelector('span');
        if (span) {
            span.textContent = state === 'linked'
                ? 'Manage linked wallets'
                : state === 'ready'
                    ? 'Link this wallet ↔ Steam'
                    : 'Link wallet ↔ Steam';
        }
    }
}

function openMobileNav() {
    if (!dom.mobileNavPanel) return;
    dom.mobileNavOverlay.classList.add('open');
    dom.mobileNavPanel.classList.add('open');
    document.body.classList.add('body-locked');
    dom.menuToggle?.setAttribute('aria-expanded', 'true');
}

function closeMobileNav() {
    if (!dom.mobileNavPanel) return;
    dom.mobileNavOverlay.classList.remove('open');
    dom.mobileNavPanel.classList.remove('open');
    document.body.classList.remove('body-locked');
    dom.menuToggle?.setAttribute('aria-expanded', 'false');
}

function renderMobileWalletAction(status) {
    if (!dom.mobileWalletBtn) return;
    if (!status) status = wallet.getStatus();
    const connected = !!status?.connected;
    dom.mobileWalletBtn.textContent = connected
        ? `Disconnect (${fmtAddress(status.address)})`
        : 'Connect Wallet';
    dom.mobileWalletBtn.classList.toggle('connected', connected);
}

async function onMobileWalletBtnClick() {
    const s = wallet.getStatus();
    if (s.connected) {
        await wallet.disconnect();
        toast('Wallet disconnected', { kind: 'info' });
        closeMobileNav();
        return;
    }
    closeMobileNav();
    if (typeof window.openConnectModal === 'function') {
        window.openConnectModal();
    } else {
        try {
            await wallet.connect();
            toast('Wallet connected', { kind: 'ok' });
        } catch (err) {
            toast(err.message || 'Connection failed', { kind: 'err', ttl: 5000 });
        }
    }
}

function updateActiveTab() {
    const h = location.hash || '#/';
    const matched = TABS.find((t) => t.match(h));
    const activeId = matched ? matched.id : 'home';
    for (const t of TABS) {
        const el = dom.tabs.querySelector(`[data-tab="${t.id}"]`);
        if (el) el.setAttribute('aria-current', t.id === activeId ? 'true' : 'false');
        // Mirror onto the mobile dropdown anchors so they highlight the same route.
        const mEl = document.querySelector(`[data-mobile-tab="${t.id}"]`);
        if (mEl) mEl.setAttribute('aria-current', t.id === activeId ? 'true' : 'false');
    }
}

// Refresh the Steam button chip by polling /api/steam/me. The endpoint
// auto-resolves auth via (1) wallet param, (2) X-Steam-Session header,
// (3) cookie — so the same call works for wallet-bound + cookie-only
// users. Site-wide-persistent because the token sits in sessionStorage
// (tab-scoped) AND a HttpOnly cookie (browser-scoped, server-readable).
async function refreshSteamChip() {
    if (!dom.steamBtn) return;
    // IMPORTANT: only activate the chip on a REAL Steam session in this
    // browser (mode === 'session'), not on the wallet-derived public link
    // record. The wallet path returns persona/avatar for display purposes
    // but doesn't represent an authenticated browser session — so the
    // chip stays in its signed-out state, the avatar stays hidden, and
    // clicking it kicks off the OpenID flow (not a no-op sign-out).
    let signedIn = false, name = null, avatar = null;
    try {
        const r = await steamFetch('/api/steam/me');
        if (r.ok) {
            const j = await r.json();
            if (j?.linked && j?.mode === 'session') {
                signedIn = true;
                name = j?.persona_name || null;
                avatar = j?.avatar_url || null;
            }
        }
    } catch (_) { /* offline / 401 — treat as logged out */ }

    dom.steamBtn.setAttribute('data-linked', String(signedIn));
    dom.steamBtn.setAttribute(
        'title',
        signedIn
            ? `Signed in as ${name || 'Steam user'} — click to sign out`
            : 'Sign in with Steam'
    );
    // Avatar slot is intentionally left empty — the Steam logo stays
    // visible in both signed-out and signed-in states so the chip remains
    // branded and never falls back to a "?" placeholder.
    if (dom.steamAvatar) {
        dom.steamAvatar.removeAttribute('src');
        dom.steamAvatar.hidden = true;
    }
    if (dom.steamLabel) {
        dom.steamLabel.textContent = signedIn ? (name || 'Steam') : 'Steam';
    }
    syncMobileSteamAndLink();
}

async function onSteamBtnClick() {
    const linked = dom.steamBtn?.getAttribute('data-linked') === 'true';
    if (linked) {
        // Replaces the browser confirm() dialog with a small in-app
        // popover that mirrors the wallet dropdown.
        return toggleSteamPopover();
    }
    // Begin OpenID flow. Server redirects to Steam, Steam returns to
    // /api/steam/auth/callback which sets cookie + bounces back to the SPA
    // with steam_token in the hash. initSteamSession() (called at boot)
    // strips the token into sessionStorage.
    const wallet0 = wallet.getStatus();
    const back = encodeURIComponent(location.hash || '#/');
    const wParam = wallet0?.address ? `&wallet=${encodeURIComponent(wallet0.address)}` : '';
    location.href = `/api/steam/auth/begin?return=${back}${wParam}`;
}

function toggleSteamPopover() {
    if (!dom.steamPop) return;
    if (dom.walletPop) dom.walletPop.hidden = true;
    if (dom.linkPopover) dom.linkPopover.hidden = true;
    if (!dom.steamPop.hidden) { dom.steamPop.hidden = true; return; }
    dom.steamPop.innerHTML = chipPopHtml();
    dom.steamPop.querySelector('[data-profile]')?.addEventListener('click', () => { dom.steamPop.hidden = true; }, { once: true });
    dom.steamPop.querySelector('[data-action]')?.addEventListener('click', async () => {
        dom.steamPop.hidden = true;
        try { await clearSteamSession(); } catch {}
        await refreshSteamChip();
        await rebuildLobby().catch(() => {});
        toast('Signed out of Steam', { kind: 'info' });
    }, { once: true });
    dom.steamPop.hidden = false;
}

// Unified popover markup so wallet + Steam dropdowns are visually
// identical — same Profile + Sign Out menu. The caller wires whichever
// sign-out path matches the chip clicked; Profile routes to /#/profile.
function chipPopHtml() {
    return `
        <a class="lobby-chip-pop__btn" href="#/profile" data-profile>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
            </svg>
            <span>Profile</span>
        </a>
        <button class="lobby-chip-pop__btn" type="button" data-action>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span>Sign Out</span>
        </button>
    `;
}

function renderWalletChip(status) {
    if (!status) status = wallet.getStatus();
    const connected = !!status?.connected;
    dom.walletBtn.setAttribute('data-connected', String(connected));
    dom.walletBtn.innerHTML = connected
        ? `<span class="hud-dot hud-dot--live"></span><span class="lobby-wallet__addr">${fmtAddress(status.address)}</span>`
        : `<span class="hud-dot hud-dot--idle"></span><span>Connect</span>`;
}

/* ── Link icon (⇄) — bridges wallet ↔ Steam account ──────────────────
   Four states based on the wallet/Steam combo + whether the active
   wallet is in the steam_links rows of the active Steam session:
     - hidden      : neither Steam nor wallet present
     - ready       : both present, current wallet NOT yet linked → click signs+links
     - linked      : both present, current wallet IS linked → click opens popover
     - half        : only one of them present → dimmed + tooltip hint */
let _linkState = null;

async function refreshLinkIcon() {
    if (!dom.linkBtn) return;
    const w = wallet.getStatus();
    const walletAddr = (w?.connected && w.address) ? w.address.toLowerCase() : null;

    // Resolve Steam-linked wallet list. Only authoritative when an active
    // Steam session exists; on 401 the array is empty.
    //
    // SECURITY: only count `mode === 'session'` as a real Steam sign-in
    // in this browser. The wallet-driven path (mode==='wallet') returns
    // `linked: true` for a public display lookup, but doesn't grant the
    // permission to call /api/steam/linked-wallets or /api/steam/link-wallet
    // — both require an X-Steam-Session token. Counting it as signedIn
    // would show the ⇄ icon in a state where its popover 401s.
    let linkedWallets = [];
    let steamSigned = false;
    try {
        const r = await steamFetch('/api/steam/me');
        if (r.ok) {
            const j = await r.json();
            steamSigned = !!(j?.linked && j?.mode === 'session');
        }
    } catch {}
    if (steamSigned) {
        try {
            const r = await steamFetch('/api/steam/linked-wallets');
            if (r.ok) {
                const j = await r.json();
                linkedWallets = (j?.wallets || []).map((x) => x.wallet_address?.toLowerCase()).filter(Boolean);
            }
        } catch {}
    }
    _linkState = { walletAddr, steamSigned, linkedWallets };

    // Visual state — Steam session is the gating signal.
    //   - Steam signed in + wallet connected & NOT yet linked → 'ready'
    //     (pulse cyan): click signs a message and inserts the link.
    //   - Steam signed in + linked context (current wallet IS linked,
    //     OR Steam-only viewer with at least one linked wallet to show)
    //     → 'linked' (green): click opens the management popover.
    //   - Otherwise → hidden (no Steam session, OR Steam-only with
    //     no linked wallets and no wallet connected to add one).
    const isLinkedAsCurrent = !!(walletAddr && linkedWallets.includes(walletAddr));
    const hasUnlinkedWallet = !!(walletAddr && !linkedWallets.includes(walletAddr));
    const hasLinkedToShow   = linkedWallets.length > 0;
    let state, title;
    if (!steamSigned) {
        state = 'hidden'; title = '';
    } else if (hasUnlinkedWallet) {
        state = 'ready'; title = 'Link this wallet to your Steam account';
    } else if (isLinkedAsCurrent || hasLinkedToShow) {
        state = 'linked';
        title = `Linked wallets (${linkedWallets.length}). Click to view.`;
    } else {
        state = 'hidden'; title = '';
    }

    dom.linkBtn.hidden = (state === 'hidden');
    dom.linkBtn.setAttribute('data-state', state);
    dom.linkBtn.setAttribute('title', title);
    // Close popover automatically if state isn't 'linked'
    if (state !== 'linked' && dom.linkPopover) dom.linkPopover.hidden = true;
    syncMobileSteamAndLink();
}

async function onLinkBtnClick() {
    // The icon is only visible when a Steam session is active. From there:
    //   - Wallet connected + NOT yet linked → sign + link (one-tap)
    //   - Anything else (linked, or Steam-only viewer) → open popover
    const s = _linkState || {};
    if (!s.steamSigned) return;
    if (s.walletAddr && !s.linkedWallets.includes(s.walletAddr)) return doLinkCurrentWallet();
    return togglePopover();
}

async function doLinkCurrentWallet() {
    const s = wallet.getStatus();
    if (!s.connected || !s.address) return toast('Connect a wallet first', { kind: 'info' });
    try {
        const signer = wallet.getSigner();
        if (!signer) throw new Error('Signer unavailable — reconnect wallet');
        const walletLower = s.address.toLowerCase();
        const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
        const message = `DexHero link-steam: ${walletLower} ${minuteBucket}`;
        toast('Sign the link request…', { kind: 'info' });
        const signature = await signer.signMessage(message);
        const r = await steamFetch('/api/steam/link-wallet', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: walletLower, signature }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        toast('Wallet linked to Steam ✓', { kind: 'ok' });
        await refreshLinkIcon();
        // Merge the new wallet into the carousel right away.
        await rebuildLobby();
    } catch (err) {
        const msg = err?.message || String(err);
        // Mute user-rejected sign cases — they're not errors.
        if (/rejected|user denied/i.test(msg)) return;
        toast(msg, { kind: 'err' });
    }
}

function togglePopover() {
    if (!dom.linkPopover) return;
    if (dom.linkPopover.hidden) renderLinkPopover();
    dom.linkPopover.hidden = !dom.linkPopover.hidden;
}

function renderLinkPopover() {
    const s = _linkState || {};
    if (!dom.linkPopover) return;
    const items = (s.linkedWallets || []).map((w) => `
        <div class="lobby-link__row" data-row="${escapeAttr(w)}">
            <span class="lobby-link__addr" title="${escapeAttr(w)}">${fmtAddress(w)}</span>
            ${w === s.walletAddr ? '<span class="lobby-link__active">active</span>' : ''}
            <button class="lobby-link__unlink" type="button" data-unlink="${escapeAttr(w)}" aria-label="Unlink ${escapeAttr(w)}">×</button>
        </div>
    `).join('');
    const canAddCurrent = s.walletAddr && !s.linkedWallets?.includes(s.walletAddr);
    // Empty-state copy reflects whether a wallet is connected. When the
    // user is signed into Steam but has no wallet connected, the popover
    // is view-only — they need to connect a wallet to add one.
    const emptyCopy = s.walletAddr
        ? 'No wallets linked yet.'
        : 'No wallets linked yet. Connect a wallet to add one.';
    dom.linkPopover.innerHTML = `
        <div class="lobby-link__head">Linked wallets (${(s.linkedWallets || []).length})</div>
        <div class="lobby-link__list">${items || `<div class="lobby-link__empty">${emptyCopy}</div>`}</div>
        ${canAddCurrent ? `<button class="lobby-link__add" type="button" data-add>+ Link current wallet (${fmtAddress(s.walletAddr)})</button>` : ''}
        <div class="lobby-link__footnote">Linked wallets merge their DexHeros into your personal lobby.</div>
    `;
    dom.linkPopover.querySelectorAll('[data-unlink]').forEach((btn) => {
        btn.addEventListener('click', () => doUnlinkWallet(btn.getAttribute('data-unlink')));
    });
    dom.linkPopover.querySelector('[data-add]')?.addEventListener('click', () => doLinkCurrentWallet());
}

async function doUnlinkWallet(walletAddr) {
    if (!walletAddr) return;
    const currentAddr = wallet.getStatus()?.address?.toLowerCase();
    // Unlinking a wallet that's NOT the currently connected one would still
    // require its signature — server enforces. Tell the user to connect it.
    if (currentAddr !== walletAddr) {
        toast(`Connect ${fmtAddress(walletAddr)} to unlink it (signature required).`, { kind: 'info' });
        return;
    }
    if (!confirm(`Unlink ${fmtAddress(walletAddr)} from your Steam account?`)) return;
    try {
        const signer = wallet.getSigner();
        if (!signer) throw new Error('Signer unavailable');
        const minuteBucket = Math.floor(Date.now() / 60000) * 60000;
        const message = `DexHero unlink-steam: ${walletAddr} ${minuteBucket}`;
        const signature = await signer.signMessage(message);
        const r = await fetch('/api/steam/unlink', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: walletAddr, signature }),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j?.error || `HTTP ${r.status}`);
        }
        toast('Wallet unlinked', { kind: 'ok' });
        await refreshLinkIcon();
        renderLinkPopover();
        await rebuildLobby();
    } catch (err) {
        const msg = err?.message || String(err);
        if (/rejected|user denied/i.test(msg)) return;
        toast(msg, { kind: 'err' });
    }
}

function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

async function onWalletBtnClick() {
    const s = wallet.getStatus();
    if (s.connected) {
        // Replaces the old browser confirm() dialog with a small in-app
        // popover that matches the toast / mini-notification aesthetic.
        return toggleWalletPopover();
    }
    // Open the shared legacy connect modal (MetaMask + Phantom picker from
    // /components/modals.js). The modal's own connectWallet() writes
    // sessionStorage and fires a window `walletChanged` event; we rebroadcast
    // it onto the internal bus below so the chip + panels all react.
    if (typeof window.openConnectModal === 'function') {
        window.openConnectModal();
    } else {
        // Fallback if /components/modals.js hasn't loaded for any reason
        try {
            await wallet.connect();
            toast('Wallet connected', { kind: 'ok' });
        } catch (err) {
            toast(err.message || 'Connection failed', { kind: 'err', ttl: 5000 });
        }
    }
}

function toggleWalletPopover() {
    if (!dom.walletPop) return;
    if (dom.steamPop) dom.steamPop.hidden = true;
    if (dom.linkPopover) dom.linkPopover.hidden = true;
    if (!dom.walletPop.hidden) { dom.walletPop.hidden = true; return; }
    dom.walletPop.innerHTML = chipPopHtml();
    dom.walletPop.querySelector('[data-profile]')?.addEventListener('click', () => { dom.walletPop.hidden = true; }, { once: true });
    dom.walletPop.querySelector('[data-action]')?.addEventListener('click', async () => {
        dom.walletPop.hidden = true;
        try {
            await wallet.disconnect();
            toast('Wallet disconnected', { kind: 'info' });
        } catch (err) {
            toast(err?.message || 'Disconnect failed', { kind: 'err' });
        }
    }, { once: true });
    dom.walletPop.hidden = false;
}

// Legacy `walletChanged` window event is now broadcast BY /app/services/wallet.js
// itself on every state change. Shell only needs to listen via the internal
// bus (already wired above on line 54: `on(E.WALLET_CHANGED, renderWalletChip)`).
// The previous duplicate handler here was redundant.

/* ─── LLM brain chip ───
   Third top-level identity in the header. The active LLM is what JarJar
   will read from CharacterRecipe.intelligence.providers[] — picking the
   provider here is, conceptually, picking the brain that powers every
   DexHero this wallet owns. */

function shortProviderName(id) {
    const map = {
        anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google',
        mistral: 'Mistral', xai: 'Grok', deepseek: 'DeepSeek', local: 'Local',
    };
    return map[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
}
function shortModelName(modelId) {
    if (!modelId) return '';
    // claude-haiku-4-5 → Haiku, gpt-4o-mini → 4o-mini, gemini-1.5-flash → 1.5 Flash
    return String(modelId)
        .replace(/^claude-(haiku|sonnet|opus)-?.*$/i, (_, k) => k[0].toUpperCase() + k.slice(1))
        .replace(/^gpt-/i, '')
        .replace(/^gemini-/i, '')
        .replace(/^mistral-/i, '')
        .replace(/^grok-/i, 'Grok ')
        .replace(/^deepseek-/i, '')
        .slice(0, 18);
}

function renderLlmChip() {
    if (!dom.llmBtn) return;
    const w = wallet.getStatus()?.address || '';
    const a = getActiveAccount(w);
    if (a && a.connected) {
        dom.llmBtn.setAttribute('data-connected', 'true');
        dom.llmBtn.setAttribute('aria-label', `LLM: ${a.provider} ${a.model || ''}`);
        if (dom.llmLabel) {
            // Header is crowded when wallet+steam+llm are all signed in;
            // drop the provider prefix and show just the model nickname
            // (which is what the user picked and uniquely identifies it).
            // Fallback to provider name if no model is set yet.
            const m = shortModelName(a.model);
            dom.llmLabel.textContent = m || shortProviderName(a.provider);
        }
    } else {
        dom.llmBtn.setAttribute('data-connected', 'false');
        dom.llmBtn.setAttribute('aria-label', 'Link LLM');
        if (dom.llmLabel) dom.llmLabel.textContent = 'LLM';
    }
}

function onLlmBtnClick(ev) {
    if (!dom.llmBtn) return;
    const connected = dom.llmBtn.getAttribute('data-connected') === 'true';
    if (!connected) {
        // Existing LLM Connect modal subscribes to this event — same entry
        // point the workshop brain picker uses; we just promote it to the
        // header so the LLM identity is a peer to Wallet + Steam.
        document.dispatchEvent(new CustomEvent('dexhero:open-llm-connect', { bubbles: true }));
        return;
    }
    toggleLlmPopover();
}

function toggleLlmPopover() {
    if (!dom.llmPop) return;
    if (dom.walletPop) dom.walletPop.hidden = true;
    if (dom.steamPop) dom.steamPop.hidden = true;
    if (dom.linkPopover) dom.linkPopover.hidden = true;
    if (!dom.llmPop.hidden) { dom.llmPop.hidden = true; return; }

    const w = wallet.getStatus()?.address || '';
    const a = getActiveAccount(w);
    const provider = getProvider(a.provider) || { name: a.provider, tier: '', privacy: '' };
    const meta = a.model
        ? `${provider.name || a.provider} · <span style="color:var(--ink-1)">${escapeAttr(a.model)}</span>`
        : (provider.name || a.provider);
    dom.llmPop.innerHTML = `
        <div class="lobby-chip-pop__row" style="padding:8px 14px;font-family:var(--font-mono);font-size:11px;color:var(--ink-2);">
            ${meta}
        </div>
        <button type="button" class="lobby-chip-pop__btn" data-action="reconfigure">Change brain…</button>
        <button type="button" class="lobby-chip-pop__btn" data-action="disconnect" style="color:#fda4af;">Disconnect</button>
    `;
    dom.llmPop.querySelector('[data-action="reconfigure"]')?.addEventListener('click', () => {
        dom.llmPop.hidden = true;
        document.dispatchEvent(new CustomEvent('dexhero:open-llm-connect', { bubbles: true }));
    }, { once: true });
    dom.llmPop.querySelector('[data-action="disconnect"]')?.addEventListener('click', () => {
        dom.llmPop.hidden = true;
        try {
            removeLlmAccount(w, a.provider);
            toast(`Disconnected ${shortProviderName(a.provider)}`, { kind: 'info' });
            document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
        } catch (err) {
            toast(err?.message || 'Disconnect failed', { kind: 'err' });
        }
    }, { once: true });
    dom.llmPop.hidden = false;
}

/* ── Ticker: scrolling creator-attribution tape ──
 *
 * Replaces the old token-price ticker with a celebration of the
 * community members whose upgrades the lobby is wearing right now.
 * Each item is a creator: their username, their total adopter count
 * across all patches, and a 24h trending delta. Promoted creators
 * (whose patches the platform merged into the default base) get a
 * gold accent.
 *
 * Data source in Stage A: app/services/upgrades-mock.js. Stage B
 * swaps this for a fetch to /api/creator-leaderboard.
 */

/* Site-wide "Changes · ON/OFF" toggle in the bottom bar.
 *
 * Reads/writes the same master flag the patch applier honors. Click
 * flips between "all my patches apply" (ON) and "show the platform
 * default" (OFF) — non-destructive; the commit chain is untouched
 * either way. Visual is text-only to fit the lobby-bar link style:
 * "Changes · ON" in default ink, "Changes · OFF" in muted amber so
 * the off-default state reads at a glance. */
async function initChangesToggle() {
    const btn = document.getElementById('lobby-changes-toggle');
    if (!btn) return;
    let getMasterEnabled, setMasterEnabled;
    try {
        ({ getMasterEnabled, setMasterEnabled } = await import('./services/upgrades-mock.js'));
    } catch (err) {
        console.warn('[changes-toggle] module load:', err?.message);
        return;
    }
    const labelEl = btn.querySelector('[data-label]');
    const paint = () => {
        const on = getMasterEnabled();
        btn.setAttribute('data-state', on ? 'on' : 'off');
        btn.title = on
            ? 'Pause all your patches — show the platform default'
            : 'Re-apply all your patches';
        if (labelEl) labelEl.textContent = on ? 'Changes · ON' : 'Changes · OFF';
    };
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        setMasterEnabled(!getMasterEnabled());
        paint();
    });
    document.addEventListener('dexhero:upgrades-changed', paint);
    paint();
}

/* Site-wide "Auto · ON/OFF" toggle in the bottom bar — matches the
 * "Changes" toggle visual register. Click flips the autonomous loop
 * on or off. When ON, fires an immediate scan so the user sees content
 * appear without waiting 10 min. Tick results surface as toasts so
 * the user knows what happened (especially when nothing posts —
 * vault_locked / no_brain_connected / brain failure all explain
 * themselves visibly). */
async function initAutonomousToggle() {
    const btn = document.getElementById('lobby-autonomous-toggle');
    if (!btn) return;
    let agent, toastMod;
    try {
        agent = await import('./services/autonomous-agent.js');
        toastMod = await import('./ui/toast.js').catch(() => null);
    } catch (err) {
        console.warn('[auto-toggle] module load:', err?.message);
        return;
    }
    const toast = toastMod?.toast || ((msg) => console.log('[auto]', msg));
    const labelEl = btn.querySelector('[data-label]');
    const paint = () => {
        const on = agent.getSettings().enabled;
        btn.setAttribute('data-state', on ? 'on' : 'off');
        btn.title = on
            ? 'Stop autonomous posting'
            : 'Let my dexhero autonomously scan and post upgrades';
        if (labelEl) labelEl.textContent = on ? 'Auto · ON' : 'Auto · OFF';
    };
    btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const next = !agent.getSettings().enabled;

        // Pre-flight: when turning ON, require a connected wallet AND an
        // unlocked LLM vault. Refusing here is much better than letting
        // the tick fire and fail silently (or worse, popping a wallet-
        // sign modal that blocks the page). We surface exactly the next
        // step the user needs to take.
        if (next) {
            const w = (await import('./services/wallet.js')).getStatus?.();
            if (!w?.connected) {
                toast('Connect your wallet first', { kind: 'warn', ttl: 3500 });
                return;
            }
            const llmConn = await import('./services/llm-connect.js');
            const acct = llmConn.getActiveAccount(w.address);
            if (!acct?.providerId) {
                toast('Connect an LLM brain first (header → AI button)', { kind: 'warn', ttl: 3500 });
                return;
            }
            const vault = await import('./services/llm-vault.js');
            const cached = vault.getCachedKey(w.address, acct.providerId);
            if (!cached?.key) {
                toast('Open LLM Connect once to unlock your brain vault', { kind: 'warn', ttl: 4000 });
                return;
            }
        }

        agent.setSettings({ enabled: next });
        if (next) {
            toast('Autonomous Mode ON · first scan running…', { kind: 'info', ttl: 2200 });
            agent.startLoop({ immediate: true });
        } else {
            toast('Autonomous Mode OFF', { kind: 'info', ttl: 1800 });
        }
        paint();
    });
    document.addEventListener('dexhero:autonomous-settings-changed', paint);

    // Surface every tick result so failures are visible (vault_locked,
    // no_brain_connected, brain_failed, etc.). Without this, a silent
    // failure looks identical to "still ticking" to the user.
    document.addEventListener('dexhero:autonomous-status', (ev) => {
        const code = ev.detail?.lastCode;
        if (!code || code === 'ok') return;       // ok already toasts as the new card landing
        const msg = {
            no_wallet:           'Auto: connect a wallet first',
            no_brain_connected:  'Auto: connect an LLM first (header → AI button)',
            vault_locked:        'Auto: brain key vault is locked — open LLM connect to unlock',
            no_valid_patch:      'Auto: brain didn\'t emit a valid patch this tick',
            manifest_rejected:   'Auto: patch violated the manifest, rejected',
            duplicate_title:     'Auto: brain repeated a title, skipped',
            budget_exceeded:     'Auto: daily budget reached',
            count_exceeded:      'Auto: 24 posts/day cap reached',
            paused:              'Auto: paused for 1h after consecutive failures',
            fetch_error:         'Auto: network error reaching the scan endpoint',
            timeout:             'Auto: brain took >90s — will retry next tick',
        }[code] || `Auto: tick failed (${code})`;
        toast(msg, { kind: 'warn', ttl: 4000 });
    });
    paint();
}

async function primeTicker() {
    let items;
    try {
        const { getCreatorLeaderboard } = await import('./services/upgrades-mock.js');
        const board = getCreatorLeaderboard(12);
        items = board.map((c) => ({
            username: c.username,
            adopters: c.adopters,
            change: Number(c.change_24h || 0),
            promoted: !!c.hasPromoted,
        }));
    } catch (err) {
        console.warn('[shell] creator leaderboard unavailable:', err?.message);
        items = [
            { username: 'DEXHERO',          adopters: 0, change: 0, promoted: false },
            { username: 'THE PLAYABLE INTERNET', adopters: 0, change: 0, promoted: false },
        ];
    }

    if (!items.length) {
        dom.ticker.innerHTML = '';
        return;
    }

    // Duplicate for seamless scroll
    const html = items.concat(items).map((t) => {
        const sign = t.change > 0 ? '+' : '';
        const changeCls = t.change > 0 ? 'up' : t.change < 0 ? 'down' : '';
        return `
            <span class="lobby-ticker__item${t.promoted ? ' lobby-ticker__item--promoted' : ''}" data-creator="${escape(t.username)}">
                <strong>${escape(t.username)}</strong>
                <span style="color:var(--ink-3);">${escape(fmtAdopters(t.adopters))} adopters</span>
                ${t.change ? `<span class="${changeCls}">${sign}${Number(t.change).toFixed(0)}</span>` : ''}
            </span>
        `;
    }).join('');
    dom.ticker.innerHTML = `<div class="lobby-ticker__track">${html}</div>`;

    // Click a creator chip → navigate to their profile page
    dom.ticker.addEventListener('click', (ev) => {
        const chip = ev.target.closest('[data-creator]');
        if (!chip) return;
        const name = chip.getAttribute('data-creator');
        if (name) location.hash = `#/creator/${encodeURIComponent(name)}`;
    });
}

function fmtAdopters(n) {
    n = Number(n) || 0;
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    if (n >= 1000)  return `${(n / 1000).toFixed(2)}k`;
    return String(n);
}

/* Branch-status chip — sits inside #lobby-ticker (right-anchored, fixed
 * to the chrome row). Surfaces the user's git-style branch state:
 *   • "main"                          — at platform baseline (genesis only)
 *   • "your-branch · 3"               — 3 commits past genesis
 *   • "your-branch · 3 · checkout"    — HEAD moved to an earlier commit
 *
 * Click → opens the commit log at /profile/upgrades. */
async function primeBranchChip() {
    if (!dom.ticker) return;
    let chip = document.getElementById('lobby-branch-chip');
    if (!chip) {
        chip = document.createElement('a');
        chip.id = 'lobby-branch-chip';
        chip.className = 'lobby-branch-chip';
        chip.href = '#/profile/upgrades';
        chip.title = 'Open commit log';
        // Anchor next to the ticker so it floats over the right edge
        dom.ticker.parentElement?.appendChild(chip);
    }
    try {
        const { getCommits, getActiveChain, getHead, getStaleCommits } =
            await import('./services/upgrades-mock.js');
        const commits = getCommits();
        const chain = getActiveChain();
        const head = getHead();
        const stale = getStaleCommits();
        const past = chain.length - 1; // exclude genesis
        const headShort = head === 'commit_genesis' ? 'genesis'
            : head.split('_').slice(-1)[0].slice(0, 6);
        const isClean = past === 0;
        const isRewound = stale.length > 0 && chain[chain.length - 1].id === head;
        chip.innerHTML = `
            <span class="lobby-branch-chip__icon" aria-hidden="true">⎇</span>
            <span class="lobby-branch-chip__label">${isClean ? 'main' : 'your-branch'}</span>
            ${past > 0 ? `<span class="lobby-branch-chip__count">${past}</span>` : ''}
            <span class="lobby-branch-chip__hash">${escape(headShort)}</span>
            ${isRewound ? `<span class="lobby-branch-chip__tag">stale ${stale.length}</span>` : ''}
        `;
        chip.classList.toggle('is-clean', isClean);
        chip.classList.toggle('is-rewound', isRewound);
    } catch {
        chip.innerHTML = '<span class="lobby-branch-chip__icon">⎇</span><span class="lobby-branch-chip__label">main</span>';
    }
}

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

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}

/* Lobby background carousel: every THIRD DexHero the carousel settles on,
   advance to the next of the 4 backdrop layers. CSS handles the fade.
   A short debounce coalesces rapid emissions (mid-swipe / inertial scroll)
   into a single transition so the backdrop reads as steady, not strobing. */
const BG_CYCLE_EVERY = 3;
let _bgCycleFrozen = false;          // true while a saved user background is pinned
const DEFAULT_BG_URLS = [
    "url('/assets/images/Bg1.png')",
    "url('/assets/images/Bg2.png')",
    "url('/assets/images/Bg3.png')",
    "url('/assets/images/Bg4.png')",
];

function initLobbyBgCycle() {
    const layers = document.querySelectorAll('#lobby-bg .lobby-bg__layer');
    if (!layers.length) return;
    let idx = 0;
    let settledCount = 0;
    let pending = null;
    const advance = () => {
        if (_bgCycleFrozen) return;
        layers[idx].classList.remove('is-active');
        idx = (idx + 1) % layers.length;
        layers[idx].classList.add('is-active');
    };
    on(E.STAGE_SUBJECT, () => {
        if (_bgCycleFrozen) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = null;
            settledCount += 1;
            if (settledCount % BG_CYCLE_EVERY === 0) advance();
        }, 220);
    });
}

/* ── Personalized lobby orchestrator ────────────────────────────
   Resolves the active "owner key" (wallet or Steam-linked wallet or
   synthetic steam:<id>) and:
     1. Tells the stage which data source to use for the carousel.
     2. Loads + applies the user's saved lobby background (if any),
        otherwise restores the default Bg1..Bg4 cycle.
   Called at boot, on WALLET_CHANGED, and on hashchange post-Steam-OpenID. */

async function resolveOwnerKey() {
    // Two-bucket preferences: wallet pref OR Steam pref. Wallet overrides
    // Steam whenever both are present. Steam-only mode uses the synthetic
    // `steam:<id>` key — never a linked wallet's row, so the two identities
    // keep their own backgrounds cleanly separated.
    const w = wallet.getStatus();
    if (w?.connected && w.address) return w.address.toLowerCase();
    try {
        const r = await steamFetch('/api/steam/me');
        if (r.ok) {
            const j = await r.json();
            if (j?.linked && j?.steam_id_64) return `steam:${j.steam_id_64}`;
        }
    } catch { /* offline / 401 — treat as signed out */ }
    return null;
}

/**
 * Full set of wallets the current "user identity" controls — the
 * connected wallet (if any) PLUS every wallet linked to the active
 * Steam session. Deduped, lowercased, only valid 0x… addresses.
 *
 * Used by rebuildLobby so the carousel can show the merged DexHero set
 * across all linked accounts (the user's primary feature ask). Returns
 * [] when no wallet is connected and no Steam-linked wallets exist.
 */
async function resolveOwnerWallets() {
    const set = new Set();
    const w = wallet.getStatus();
    if (w?.connected && w.address && /^0x[0-9a-f]{40}$/i.test(w.address)) {
        set.add(w.address.toLowerCase());
    }
    try {
        const r = await steamFetch('/api/steam/linked-wallets');
        if (r.ok) {
            const j = await r.json();
            for (const row of (j?.wallets || [])) {
                const a = (row?.wallet_address || '').toLowerCase();
                if (/^0x[0-9a-f]{40}$/.test(a)) set.add(a);
            }
        }
    } catch { /* non-fatal */ }
    return Array.from(set);
}

async function applyLobbyBackground(ownerKey) {
    const layers = Array.from(document.querySelectorAll('#lobby-bg .lobby-bg__layer'));
    if (!layers.length) return;
    // Default state: ensure the four layers point at Bg1..Bg4 (in case a
    // previous session had pinned a custom URL) and let the cycle advance.
    const resetToDefault = () => {
        _bgCycleFrozen = false;
        layers.forEach((el, i) => {
            el.style.backgroundImage = DEFAULT_BG_URLS[i] || DEFAULT_BG_URLS[0];
            el.classList.toggle('is-active', i === 0);
        });
    };
    if (!ownerKey) { resetToDefault(); return; }
    // Authed: fetch saved preference. wallet keys go in ?wallet=…; Steam
    // synthetic keys ride the X-Steam-Session header via steamFetch().
    const isWallet = /^0x[0-9a-f]{40}$/i.test(ownerKey);
    const url = isWallet
        ? `/api/user/lobby-bg?wallet=${encodeURIComponent(ownerKey)}`
        : '/api/user/lobby-bg';
    let saved = null;
    try {
        const r = await steamFetch(url);
        if (r.ok) saved = (await r.json())?.url || null;
    } catch { /* non-fatal */ }
    if (!saved) { resetToDefault(); return; }
    // Pinned: freeze the cycle, point ONLY the first layer at the saved
    // URL, hide the rest. Avoids a half-second flash of Bg1 before swap.
    _bgCycleFrozen = true;
    layers.forEach((el, i) => {
        el.style.backgroundImage = i === 0 ? `url('${saved}')` : 'none';
        el.classList.toggle('is-active', i === 0);
    });
}

/* ── Brand-popover background picker ─────────────────────────────
   Lives in the top-left brand dropdown so any signed-in user can pick
   one of the Bg1..Bg4 presets OR upload a custom image. Reuses the
   /api/user/lobby-bg endpoints — same auth resolution as Profile used
   to hit before this UI moved here. */

let _brandBgUrl = null; // last-loaded preference

async function loadBrandBg() {
    if (!dom.brandPop) return;
    const ownerKey = await resolveOwnerKey();
    if (!ownerKey) {
        _brandBgUrl = null;
        renderBrandBgPicker();
        return;
    }
    const isWalletKey = /^0x[0-9a-f]{40}$/i.test(ownerKey);
    const url = isWalletKey
        ? `/api/user/lobby-bg?wallet=${encodeURIComponent(ownerKey)}`
        : '/api/user/lobby-bg';
    try {
        const r = await steamFetch(url);
        _brandBgUrl = r.ok ? ((await r.json())?.url || null) : null;
    } catch { _brandBgUrl = null; }
    renderBrandBgPicker();
}

function renderBrandBgPicker() {
    if (!dom.brandPop) return;
    const current = _brandBgUrl;
    const isPreset = (u) => /^\/assets\/images\/Bg[1-4]\.png$/i.test(u || '');
    // Cycle swatch — represents the default Bg1→Bg2→Bg3→Bg4 rotation.
    // Selected when there's no pinned preference (current === null) so
    // users see at-a-glance that cycling is what's active. Clicking it
    // posts { url: null } which resets back to cycle.
    const cycleSel = !current ? ' is-selected' : '';
    const cycleSwatch = `
        <button type="button" class="brand-bg__swatch brand-bg__swatch--cycle${cycleSel}" data-bg-cycle aria-label="Auto-cycle backgrounds">
            <div class="brand-bg__cycle-grid">
                <span style="background-image:url('/assets/images/Bg1.png');"></span>
                <span style="background-image:url('/assets/images/Bg2.png');"></span>
                <span style="background-image:url('/assets/images/Bg3.png');"></span>
                <span style="background-image:url('/assets/images/Bg4.png');"></span>
            </div>
            <span class="brand-bg__cycle-label">Cycle</span>
        </button>
    `;
    const swatch = (n) => {
        const url = `/assets/images/Bg${n}.png`;
        const sel = current === url ? ' is-selected' : '';
        return `<button type="button" class="brand-bg__swatch${sel}" data-bg-preset="${url}" aria-label="Use Bg${n}" style="background-image:url('${url}');"></button>`;
    };
    const customThumb = current && !isPreset(current)
        ? `<div class="brand-bg__current is-selected" style="background-image:url('${escapeAttr(current)}');" title="Current custom background"></div>`
        : '';
    dom.brandPop.innerHTML = `
        <div class="brand-bg__head"><span>Lobby Background</span></div>
        <div class="brand-bg__swatches">
            ${cycleSwatch}
            ${[1,2,3,4].map(swatch).join('')}
            ${customThumb}
        </div>
        <div class="brand-bg__upload">
            <input type="file" accept="image/png,image/jpeg,image/webp" data-bg-file hidden>
            <button type="button" class="brand-bg__upload-btn" data-bg-pick>Upload custom…</button>
        </div>
    `;
    wireBrandBgPicker();
}

function wireBrandBgPicker() {
    if (!dom.brandPop) return;
    dom.brandPop.querySelectorAll('[data-bg-preset]').forEach((btn) => {
        btn.addEventListener('click', () => saveBrandBg(btn.getAttribute('data-bg-preset')));
    });
    // Cycle swatch — null pref = auto-cycle the default Bg1..Bg4 set.
    dom.brandPop.querySelector('[data-bg-cycle]')?.addEventListener('click', () => saveBrandBg(null));
    const pick = dom.brandPop.querySelector('[data-bg-pick]');
    const file = dom.brandPop.querySelector('[data-bg-file]');
    pick?.addEventListener('click', () => file?.click());
    file?.addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) return toast('File too large — max 5 MB', { kind: 'err' });
        const fd = new FormData();
        fd.append('file', f);
        fd.append('kind', 'lobby-bg');
        toast('Uploading…', { kind: 'info' });
        try {
            const r = await steamFetch('/api/upload', { method: 'POST', body: fd });
            if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
            const j = await r.json();
            const url = j?.url || j?.publicUrl || j?.path;
            if (!url) throw new Error('upload returned no url');
            await saveBrandBg(url);
        } catch (err) {
            toast(err?.message || 'Upload failed', { kind: 'err' });
        } finally {
            file.value = '';
        }
    });
}

async function saveBrandBg(url) {
    const ownerKey = await resolveOwnerKey();
    if (!ownerKey) return toast('Sign in to save lobby background', { kind: 'info' });
    const isWalletKey = /^0x[0-9a-f]{40}$/i.test(ownerKey);
    const endpoint = isWalletKey
        ? `/api/user/lobby-bg?wallet=${encodeURIComponent(ownerKey)}`
        : '/api/user/lobby-bg';
    try {
        const r = await steamFetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j?.error || `HTTP ${r.status}`);
        }
        _brandBgUrl = url;
        renderBrandBgPicker();
        toast(url ? 'Lobby background saved' : 'Reset to default cycle', { kind: 'ok' });
        // applyLobbyBackground reads the latest preference; rebuild only
        // refreshes the visible backdrop so the user sees their pick
        // immediately without re-fetching the carousel.
        await applyLobbyBackground(ownerKey);
    } catch (err) {
        toast(err?.message || 'Save failed', { kind: 'err' });
    }
}

let _rebuildInflight = null;
async function rebuildLobby() {
    // Coalesce rapid calls (wallet change + post-create redirect can fire
    // in quick succession) — second caller awaits the first.
    if (_rebuildInflight) return _rebuildInflight;
    _rebuildInflight = (async () => {
        try {
            // Resolve full wallet set first (current + Steam-linked) so the
            // carousel merges DexHeros across all linked accounts.
            const wallets = await resolveOwnerWallets();
            await rebuildRibbon({
                source: wallets.length ? 'personal' : 'public',
                wallets,
            });
            // Backgrounds key on the SINGLE preference row — resolve the
            // primary owner key (connected wallet first, else Steam fallback).
            const ownerKey = await resolveOwnerKey();
            await applyLobbyBackground(ownerKey);
            // Repaint link-icon state since linked-wallet list may have changed.
            refreshLinkIcon().catch(() => {});
        } finally {
            _rebuildInflight = null;
        }
    })();
    return _rebuildInflight;
}

/* Kick off on DOMContentLoaded (script loaded as module with defer semantics) */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
