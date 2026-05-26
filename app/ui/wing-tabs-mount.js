/* wing-tabs-mount — physically move the Activity / To-Do / Topics tab
 * strip into the right wing as its header bar.
 *
 * Why a JS move instead of editing markup: the strip lives in
 * index.html (static) with click handlers wired by stage-chat.js. The
 * right wing's contents are rendered DYNAMICALLY by home.js, which
 * calls `right.innerHTML = ''` on every wallet/route change — that
 * wipes our moved strip (and document.getElementById then returns
 * null because the node is detached). Caching the reference fixes
 * this: we keep our own pointer to the strip element, re-insert it
 * after each wing re-render via MutationObserver, and the click
 * handler keeps working because it's bound to the JS reference, not
 * to a DOM position.
 */

const TABS_ID = 'lobby-stage-bubble-titles';
const WING_ID = 'lobby-wing-right';

let _wired = false;
let _tabsRef = null;          // cached reference survives home.js wipes

function tabsEl() {
    // Cache once. After home.js does `innerHTML = ''` the element is
    // detached but the JS reference is still valid — we re-insert it.
    // If we lose the reference entirely, fall back to getElementById
    // (works on the very first call before the move).
    if (_tabsRef) return _tabsRef;
    _tabsRef = document.getElementById(TABS_ID);
    return _tabsRef;
}

function ensureMounted() {
    const tabs = tabsEl();
    const wing = document.getElementById(WING_ID);
    if (!tabs || !wing) return false;
    // No-op if already mounted as the wing's first child.
    if (tabs.parentElement === wing && wing.firstElementChild === tabs) return true;
    // Re-insert at the top of the wing.
    wing.insertBefore(tabs, wing.firstElementChild);
    // Re-apply the active tab's panel visibility — home.js renders
    // panels with their static `hidden` state, but the user may be on
    // a different tab. Toggling here lets setActive's prior state win.
    syncActivePanel();
    return true;
}

function syncActivePanel() {
    const wing = document.getElementById(WING_ID);
    if (!wing) return;
    const target = document.body.getAttribute('data-active-pane') || 'activity';
    wing.querySelectorAll('[data-tab-panel]').forEach((p) => {
        p.hidden = p.getAttribute('data-tab-panel') !== target;
    });
}

export function initWingTabsMount() {
    if (_wired) return;
    _wired = true;

    if (!ensureMounted()) setTimeout(ensureMounted, 0);

    const obs = new MutationObserver(() => {
        const tabs = tabsEl();
        const wing = document.getElementById(WING_ID);
        if (!tabs || !wing) return;
        if (tabs.parentElement !== wing || wing.firstElementChild !== tabs) {
            ensureMounted();
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });
}
