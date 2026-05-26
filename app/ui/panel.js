/* V3Labs Panel — base class for every slide-in / overlay / bottom sheet.
   Lifecycle: new → mount(host) → open() → close() → unmount().
   Subclasses override render() (returns HTML string) and optionally onMount(), onUnmount(). */

import { createFocusTrap } from './focus-trap.js';
import { router } from '../router.js';

/* ── Body scroll lock ─────────────────────────────────────────────
   When a panel is mounted, the lobby behind it must not scroll. On
   mobile the panel goes full-width and the lobby (which can exceed
   viewport height once wings stack vertically) would otherwise
   scroll under touches that fall on the panel. iOS Safari ignores
   plain `overflow: hidden` on body once a touch starts, so we use
   the position:fixed/top:-scrollY trick and restore on unlock.
   Counted because router-driven nav briefly overlaps two panels
   during the 300ms close transition. */

let _scrollLockCount = 0;
function lockBodyScroll() {
    _scrollLockCount++;
    if (_scrollLockCount > 1) return;
    const y = window.scrollY || window.pageYOffset || 0;
    document.body.dataset.panelOpen = 'true';
    document.body.dataset.scrollLockY = String(y);
    document.body.style.position = 'fixed';
    document.body.style.top = `-${y}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
}
function unlockBodyScroll() {
    if (_scrollLockCount <= 0) return;
    _scrollLockCount--;
    if (_scrollLockCount > 0) return;
    const y = parseInt(document.body.dataset.scrollLockY || '0', 10);
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    delete document.body.dataset.panelOpen;
    delete document.body.dataset.scrollLockY;
    window.scrollTo(0, y);
}

export class Panel {
    /* Metadata — override in subclass */
    static id        = '';              // e.g. 'market'
    static variant   = 'right';         // 'right' | 'left' | 'bottom' | 'overlay' | 'full' | 'codex'
    static width     = 520;             // px, side panels
    static height    = '70vh';          // bottom sheets
    static maxWidth  = 1200;            // px, overlay
    static title     = '';              // displayed in head + used for aria-label
    static stageMode = 'keep';          // 'keep' | 'dim' | 'subject:<fn>'
    static titleBreadcrumb = [];        // optional breadcrumb segments for head

    constructor(params = {}) {
        this.params = params;
        this.root = null;
        this.veil = null;
        this.host = null;
        this._abort = new AbortController();
        this._trap = null;
        this._state = 'pre';
        this._closing = false;
        this._onCloseExternal = [];
    }

    /* Signal shortcut for listeners that should drop on unmount */
    get signal() { return this._abort.signal; }

    /* ── Override points ─────────────────────────────────────── */

    /** Return HTML string for panel body. Default: empty loading state. */
    render() {
        return `<div class="panel-state"><div class="hud-spin"></div><div>${this.constructor.title || 'Loading'}</div></div>`;
    }

    /** Wire listeners, fetch data. Called after DOM is in place. */
    async onMount() {}

    /** Cleanup (most listener cleanup is handled by AbortController). */
    onUnmount() {}

    /** Wallet state changed while panel is open. Subclass can override. */
    onWalletChange(status) {}

    /** Same route, different params. */
    onParamsChange(params) { this.params = params; }

    /* ── Lifecycle ───────────────────────────────────────────── */

    async mount(host) {
        this.host = host;
        const v = this.constructor;

        // Veil for overlay/full variants
        if (v.variant === 'overlay' || v.variant === 'full') {
            this.veil = el('div', { class: 'panel-veil' });
            host.appendChild(this.veil);
        }

        const classes = ['panel', `panel--${v.variant}`];
        this.root = el('section', {
            class: classes.join(' '),
            role: v.variant === 'overlay' || v.variant === 'full' ? 'dialog' : 'region',
            'aria-modal': v.variant === 'overlay' || v.variant === 'full' ? 'true' : 'false',
            'aria-label': v.title || v.id,
            'data-panel-id': v.id,
            'data-state': 'pre',
            tabindex: '-1',
        });

        // Style vars from static config
        if (v.variant === 'right' || v.variant === 'left' || v.variant === 'codex') {
            this.root.style.setProperty('--panel-w', typeof v.width === 'number' ? v.width + 'px' : v.width);
        } else if (v.variant === 'bottom') {
            this.root.style.setProperty('--panel-h', typeof v.height === 'number' ? v.height + 'px' : v.height);
        } else if (v.variant === 'overlay') {
            this.root.style.setProperty('--panel-max', typeof v.maxWidth === 'number' ? v.maxWidth + 'px' : v.maxWidth);
        }

        // Chrome — head + body.
        //   Back button (←)  → rendered when there's somewhere to go back to:
        //                       either the panel declares a static parentHash
        //                       (multi-step flows like Create → Type → DexHero),
        //                       or the router reports at least one earlier
        //                       panel in this session's history. Suppressed
        //                       when the previous hash was home, since the X
        //                       would land the user in the same place.
        //   Close button (×) → always present. Dismisses the panel and
        //                       returns to the lobby home.
        const bc = this._buildBreadcrumb();
        const parentHash = v.parentHash;
        const showBack = !!parentHash || (router && typeof router.canGoBack === 'function' && router.canGoBack());
        const backBtn = showBack ? `
            <button class="panel__back" type="button" aria-label="Back" data-back>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
            </button>` : '';
        const headHTML = `
            <header class="panel__head">
                <div class="panel__head-lead">${backBtn}<div class="panel__title">${bc}</div></div>
                <button class="panel__close" type="button" aria-label="Close panel" data-close>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </header>
            <div class="panel__body" data-body></div>`;
        this.root.innerHTML = headHTML;
        host.appendChild(this.root);

        // Render body
        const body = this.root.querySelector('[data-body]');
        body.innerHTML = this.render();

        // Wire close
        this.root.querySelector('[data-close]').addEventListener('click', () => this.close(), { signal: this.signal });
        if (this.veil) this.veil.addEventListener('click', () => this.close(), { signal: this.signal });

        // Wire back — prefer a declared parentHash (multi-step flows have an
        // explicit parent), else pop the browser hash history so ad-hoc
        // panel→panel navigation returns to the previous panel.
        const backEl = this.root.querySelector('[data-back]');
        if (backEl) {
            backEl.addEventListener('click', () => {
                const target = (typeof this.constructor.parentHash === 'function')
                    ? this.constructor.parentHash(this.params)
                    : this.constructor.parentHash;
                if (target) {
                    location.hash = target.startsWith('#') ? target : '#' + target;
                } else {
                    history.back();
                }
            }, { signal: this.signal });
        }

        // Escape key closes
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); this.close(); }
        }, { signal: this.signal });

        // Focus trap for modal-ish variants
        if (v.variant === 'overlay' || v.variant === 'full') {
            this._trap = createFocusTrap(this.root);
        }

        // Lock the body so the lobby behind this panel can't scroll while
        // the user is interacting with the panel (especially on mobile,
        // where the panel goes full-width and the lobby exceeds viewport).
        lockBodyScroll();
        this._scrollLocked = true;

        // Transition into view (next frame so initial state renders first)
        requestAnimationFrame(() => {
            this.root.setAttribute('data-state', 'mounted');
            if (this.veil) this.veil.setAttribute('data-active', 'true');
            this._state = 'mounted';
            if (this._trap) this._trap.activate();
        });

        // Subclass mount hook
        try { await this.onMount(); }
        catch (err) {
            console.error(`[panel ${v.id}] mount error:`, err);
            body.innerHTML = `<div class="panel-state"><div class="panel-state__title">Error</div><div class="panel-state__body">${escapeHTML(err.message || String(err))}</div></div>`;
        }
    }

    close() {
        if (this._closing) return;
        this._closing = true;
        const v = this.constructor;
        this.root.setAttribute('data-state', 'leaving');
        if (this.veil) this.veil.setAttribute('data-active', 'false');

        const done = () => {
            if (this._trap) this._trap.release();
            this._abort.abort();
            try { this.onUnmount(); } catch (err) { console.error(`[panel ${v.id}] unmount:`, err); }
            this.root.remove();
            if (this.veil) this.veil.remove();
            if (this._scrollLocked) { unlockBodyScroll(); this._scrollLocked = false; }
            for (const cb of this._onCloseExternal) try { cb(); } catch {}
        };

        setTimeout(done, 300);
    }

    /** External listeners to the close event (shell uses this to manage stack). */
    onClose(cb) { this._onCloseExternal.push(cb); }

    /** Subclass helper: get the body container to re-render. */
    get body() { return this.root && this.root.querySelector('[data-body]'); }

    /** Subclass helper: re-render body with current state. */
    rerender() {
        if (this.body) this.body.innerHTML = this.render();
    }

    /** Build breadcrumb HTML from the static titleBreadcrumb config */
    _buildBreadcrumb() {
        const parts = this.constructor.titleBreadcrumb && this.constructor.titleBreadcrumb.length
            ? this.constructor.titleBreadcrumb
            : [this.constructor.title || this.constructor.id];
        return parts.map((p, i) => {
            const isLast = i === parts.length - 1;
            return (i > 0 ? '<span class="sep">▸</span>' : '') + (isLast ? `<strong>${escapeHTML(p)}</strong>` : escapeHTML(p));
        }).join('');
    }
}

/* ── Helpers ─────────────────────────────────────────────────── */

export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

export function escapeHTML(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtNum(n, opts = {}) {
    if (n == null || isNaN(n)) return '—';
    const { compact = true, decimals = 2 } = opts;
    if (compact && Math.abs(n) >= 1000) {
        return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
    }
    return Number(n).toLocaleString('en', { maximumFractionDigits: decimals });
}

export function fmtAddress(a) {
    if (!a) return '—';
    return a.slice(0, 6) + '…' + a.slice(-4);
}

export function sanitizeURL(u) {
    if (!u) return '';
    try {
        const p = new URL(u, window.location.origin);
        return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : '';
    } catch { return ''; }
}
