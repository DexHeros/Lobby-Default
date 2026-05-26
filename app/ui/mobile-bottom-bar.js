/* Mobile bottom navigation bar — social-app style.
 *
 * Four icon tabs pinned to the bottom of the viewport at ≤640px:
 *   Home   — collapse the wing (return to the 3D lobby stage)
 *   Post   — open the wing's feed pane + focus the compose input
 *   Stream — navigate to the play route (live games / streams)
 *   Search — open the wing's feed pane + focus the search input
 *
 * Desktop (>640px) renders nothing — the bar self-no-ops above
 * the breakpoint. The bar lives directly under <body> so it's
 * never inside the wing's clipped overflow.
 *
 * Click flow for Post/Search:
 *   1. If the wing is collapsed, click the existing #lobby-stage-next
 *      toggle to open it (full-bleed on mobile per shell.css).
 *   2. Wait one transition tick so the wing is visible.
 *   3. Focus the input — either [data-compose-input] or [data-search-input].
 *
 * The bar's active-state highlight tracks: route (Home/Stream) +
 * wing-open state (Post/Search). Updates on hashchange and on every
 * change to the wing's collapsed class. */

const BAR_ID = 'v3-mobile-bottom-bar';
const MOBILE_QUERY = '(max-width: 640px)';

const ICONS = {
    home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5z"/></svg>',
    post: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    stream: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

const TABS = [
    { id: 'home',   label: 'Home',   icon: ICONS.home   },
    { id: 'post',   label: 'Post',   icon: ICONS.post   },
    { id: 'stream', label: 'Stream', icon: ICONS.stream },
    { id: 'search', label: 'Search', icon: ICONS.search },
];

let _wired = false;

export function initMobileBottomBar() {
    if (_wired) return;
    _wired = true;

    if (document.getElementById(BAR_ID)) return;

    const bar = document.createElement('nav');
    bar.id = BAR_ID;
    bar.className = 'mobile-bottom-bar';
    bar.setAttribute('aria-label', 'Primary');
    bar.innerHTML = TABS.map((t) => `
        <button type="button" class="mobile-bottom-bar__tab" data-tab="${t.id}" aria-label="${t.label}">
            <span class="mobile-bottom-bar__icon" aria-hidden="true">${t.icon}</span>
            <span class="mobile-bottom-bar__label">${t.label}</span>
        </button>
    `).join('');
    document.body.appendChild(bar);

    bar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-tab]');
        if (!btn) return;
        const id = btn.getAttribute('data-tab');
        switch (id) {
            case 'home':   handleHome();   break;
            case 'post':   handlePost();   break;
            case 'stream': handleStream(); break;
            case 'search': handleSearch(); break;
        }
    });

    // Active-state tracking: hashchange covers route, MutationObserver on
    // the wing covers open/collapsed transitions.
    const refresh = () => paintActive(bar);
    window.addEventListener('hashchange', refresh);
    const wing = document.querySelector('.lobby-wing--right');
    if (wing) {
        new MutationObserver(refresh).observe(wing, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }
    refresh();
}

function isWingOpen() {
    const w = document.querySelector('.lobby-wing--right');
    return !!w && !w.classList.contains('lobby-wing--collapsed');
}

function paintActive(bar) {
    const route = (location.hash || '#/').split('?')[0];
    const open  = isWingOpen();
    let active = null;
    if (open) {
        // When the wing is open, Post or Search reflects the user's
        // intent — we can't reliably tell which focus they came from,
        // so neither lights up alone. Treat the wing as "Feed" view
        // and dim Home.
        active = null;
    } else if (route === '#/' || route === '#') {
        active = 'home';
    } else if (route.startsWith('#/play') || route.startsWith('#/game/')) {
        active = 'stream';
    }
    bar.querySelectorAll('[data-tab]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === active);
    });
}

function handleHome() {
    // Two-step: close the wing first (if open), then route to home.
    if (isWingOpen()) {
        document.getElementById('lobby-stage-next')?.click();
    }
    if ((location.hash || '#/') !== '#/') {
        location.hash = '#/';
    }
}

function handleStream() {
    if (isWingOpen()) document.getElementById('lobby-stage-next')?.click();
    location.hash = '#/play';
}

function handlePost() {
    openWingThen(() => {
        const input = document.querySelector('[data-compose-input]');
        if (input) {
            input.focus();
            try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
        }
    });
}

function handleSearch() {
    openWingThen(() => {
        const input = document.querySelector('[data-search-input]');
        if (input) {
            input.focus();
            try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
        }
    });
}

function openWingThen(cb) {
    if (!isWingOpen()) {
        document.getElementById('lobby-stage-next')?.click();
        // Wait for the wing's transform transition to finish (240ms in
        // shell.css). 260ms gives the input layout time to settle.
        setTimeout(cb, 260);
    } else {
        cb();
    }
}
