/* Stub factory — produces a right-panel stub that introduces the flow, lets
   the user launch an iframe of the legacy page inside the panel (stays in the
   lobby shell — no navigation away), and falls back to a direct link if the
   iframe fails. Each stubbed module gets replaced by a fully native panel in
   subsequent waves. */

import { Panel } from '../ui/panel.js';

export function createStub({
    id,
    title,
    legacyHref,
    breadcrumb,
    variant = 'right',
    width = 560,
    stageMode = 'keep',
    blurb = '',
    openLabel = 'Open',
    autoEmbed = true,              // if true, load iframe immediately on mount
    clearOnClose = [],             // sessionStorage keys to wipe (both parent + iframe) on panel close
    parentHash = null,             // '#/...' or a function (params) => '#/...'. When set, renders a Back button.
}) {
    return class StubPanel extends Panel {
        static id        = id;
        static variant   = variant;
        static width     = width;
        static title     = title;
        static titleBreadcrumb = breadcrumb || [title.toUpperCase()];
        static stageMode = stageMode;
        static parentHash = parentHash;

        // Resolve legacyHref lazily so callers can forward route params (e.g.
        // ?launchType=existing&address=…) into the iframe URL. Strings pass
        // through unchanged for the existing static-href consumers.
        _href() {
            return typeof legacyHref === 'function'
                ? legacyHref(this.params || {})
                : legacyHref;
        }

        onUnmount() {
            // Wipe any draft-state keys the legacy page uses so subsequent
            // re-opens start from a clean slate (no stale generated model,
            // no stale launch-type branch, etc.). Clears both the parent
            // window AND the iframe's same-origin sessionStorage.
            if (!clearOnClose.length) return;
            const frame = this.root?.querySelector('.stub-embed-frame');
            const frameStorage = (() => {
                try { return frame?.contentWindow?.sessionStorage; } catch { return null; }
            })();
            for (const key of clearOnClose) {
                try { sessionStorage.removeItem(key); } catch {}
                try { frameStorage?.removeItem(key); } catch {}
            }
        }

        render() {
            const href = this._href();
            if (this._embed && href) {
                return `
                    <div class="stub-embed-host">
                        <div class="stub-embed-spin"><div class="hud-spin"></div></div>
                        <iframe
                            class="stub-embed-frame"
                            src="${escape(href)}"
                            title="${escape(title)}"
                            allow="clipboard-write"
                            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                        ></iframe>
                    </div>
                    <style>${embedStyles()}</style>
                `;
            }

            return `
                <div class="hud-display" style="font-size:24px;letter-spacing:0.18em;margin-bottom:12px;">${escape(title.toUpperCase())}</div>
                ${blurb ? `<div class="hud-body hud-dim" style="margin-bottom:28px;font-size:13px;">${escape(blurb)}</div>` : ''}

                ${href ? `
                    <div style="display:flex;flex-direction:column;gap:10px;">
                        <button class="hud-btn hud-btn--primary hud-btn--block" data-embed>${escape(openLabel)}</button>
                        <a class="hud-btn hud-btn--ghost hud-btn--block" href="${escape(href)}" target="_blank" rel="noopener">Open in new tab</a>
                    </div>
                    <div class="hud-mono hud-muted" style="margin-top:18px;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;">
                        Panel upgrade pending — full legacy view available
                    </div>
                ` : ''}
            `;
        }

        async onMount() {
            if (autoEmbed && this._href()) {
                this._embed = true;
                this.rerender();
                this._wireFrame();
                return;
            }
            this.root.querySelector('[data-embed]')?.addEventListener('click', () => {
                this._embed = true;
                this.rerender();
                this._wireFrame();
            }, { signal: this.signal });
        }

        _wireFrame() {
            const frame = this.root.querySelector('.stub-embed-frame');
            const spin  = this.root.querySelector('.stub-embed-spin');
            if (!frame) return;

            // Re-inject on EVERY load — each navigation inside the iframe creates
            // a new document, wiping previously-injected styles. We check for the
            // style element in the current document each time and re-add if absent.
            const tryInject = () => {
                try {
                    const doc = frame.contentDocument || frame.contentWindow?.document;
                    if (!doc || !doc.head) return false;
                    if (doc.getElementById('__v3-embed-css')) return true;
                    injectEmbedCSS(frame, variant);
                    if (spin) spin.style.display = 'none';
                    return true;
                } catch {
                    return false;
                }
            };

            frame.addEventListener('load', tryInject, { signal: this.signal });

            // Poll continuously: handles the case where the real-page load already
            // fired before our listener attached, AND re-applies after any internal
            // navigation that wipes the injected style.
            let attempts = 0;
            const poll = setInterval(() => {
                if (attempts++ > 200) { clearInterval(poll); return; }
                tryInject();
            }, 200);
            try { this.signal.addEventListener('abort', () => clearInterval(poll)); } catch {}

            // Live wallet-state bridge: sessionStorage isn't shared across
            // iframes even same-origin, so mirror the shell's wallet keys into
            // the iframe whenever the shell's walletChanged event fires, then
            // re-dispatch walletChanged inside the iframe so in-iframe code
            // (pass-lock, node-onboarding, etc.) reacts without reimplementing
            // the connect flow itself.
            //
            // Two distinct operations split out below — they MUST stay
            // separate. Some legacy pages (token-detail.html) handle
            // walletAccountChanged by calling location.reload(); if we fire
            // the event on every iframe load, the reload makes the iframe
            // load fire again and we loop forever. So:
            //   - mirrorStorage(): plain sessionStorage copy. Safe to run on
            //     every iframe load (first paint needs storage populated).
            //   - syncAndNotify(): mirror + dispatch events. Only fires when
            //     the parent's walletChanged event tells us the wallet
            //     actually changed.
            const WALLET_KEYS = ['walletConnected', 'walletAddress', 'walletChain', 'walletType', 'dexhero_wallet_base'];
            const mirrorStorage = () => {
                try {
                    const storage = frame.contentWindow?.sessionStorage;
                    if (!storage) return;
                    WALLET_KEYS.forEach((k) => {
                        const v = window.sessionStorage.getItem(k);
                        if (v != null) storage.setItem(k, v);
                        else storage.removeItem(k);
                    });
                } catch {}
            };
            const syncAndNotify = () => {
                mirrorStorage();
                try {
                    if (!frame.contentWindow) return;
                    const address = window.sessionStorage.getItem('walletAddress') || null;
                    const chain   = window.sessionStorage.getItem('walletChain') || 'evm';
                    frame.contentWindow.dispatchEvent(new Event('walletChanged'));
                    frame.contentWindow.dispatchEvent(new CustomEvent('walletAccountChanged', {
                        detail: { address, chain, wallet: window.sessionStorage.getItem('walletType') || null },
                    }));
                } catch {}
            };
            window.addEventListener('walletChanged', syncAndNotify, { signal: this.signal });
            // On initial iframe load: mirror storage, then fire a custom
            // `parentWalletSynced` event INSIDE the iframe. Pages that
            // need to re-run a wallet-aware boot (pass check, etc.) listen
            // for this name. Distinct from walletChanged so reload-on-change
            // pages (token-detail.html) don't see a fake change and loop.
            frame.addEventListener('load', () => {
                setTimeout(() => {
                    mirrorStorage();
                    try { frame.contentWindow?.dispatchEvent(new Event('parentWalletSynced')); } catch {}
                }, 50);
            }, { signal: this.signal });
        }
    };
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}

/** Styles for the iframe host. The iframe itself gets its own chrome-hiding
    CSS injected into its document via injectEmbedCSS below. */
function embedStyles() {
    return `
        .stub-embed-host {
            position: relative;
            width: calc(100% + 48px);
            height: calc(100% + 48px);
            margin: -24px;
            overflow: hidden;
            /* Transparent so the lobby's cycling backdrop (Bg1-4 starfield)
               shows through the panel's semi-transparent gradient instead
               of being boxed off by an opaque black iframe wrapper. */
            background: transparent;
        }
        .stub-embed-spin {
            position: absolute; inset: 0;
            display: flex; align-items: center; justify-content: center;
            z-index: 1;
        }
        .stub-embed-frame {
            position: relative;
            width: 100%; height: 100%;
            border: 0; background: transparent;
            display: block;
            color-scheme: dark;
            z-index: 2;
        }
    `;
}

/** Inject CSS into the legacy iframe's document so its chrome (ticker, header,
    footer, page padding, hero section, etc.) is hidden — the panel already
    provides header/nav/bar context. Same-origin iframe, so this is safe.

    `variant` controls whether the narrow-panel typography/layout overrides
    fire. Fullscreen variants (play, create-dexhero) keep the legacy page's
    own centered layout because they have viewport-scale real estate; only
    the side-slide variants (`right`, `left`, `codex`) need the 480-tuned
    overrides that compress headings + force 100% widths. */
function injectEmbedCSS(frame, variant = 'right') {
    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return;
    if (doc.getElementById('__v3-embed-css')) return;

    const isNarrow = variant !== 'full' && variant !== 'overlay';

    const css = `
        /* Hide shell chrome that duplicates the lobby shell */
        .ticker-container,
        #header-placeholder, #footer-placeholder,
        .nav-container, header.site-header, nav.site-nav,
        .hero-section-new, .hero-full-width-wrapper,
        .featured-showcase, .intro-overlay { display: none !important; }

        /* Hide legacy in-page back links — the panel's chrome provides its
           own Back button (to the panel's parentHash) and the X returns to
           the lobby. Having two "Back" controls is confusing, and clicking
           an in-iframe href="/" navigates the iframe to the lobby shell
           itself, rendering the whole home page inside the side panel. */
        .back-link, #back-link, .btn-back,
        a.back-link, .back-button, .btn-back-link,
        .step-breadcrumb,
        a[href="/"], a[href="/index.html"], a[href="index.html"],
        a[href="./"], a[href=".."] { display: none !important; }

        /* Reset body padding/top offsets that assumed fixed ticker+header.
           Match the parent panel's gradient exactly (panel.css .panel--right)
           so the embedded page has the SAME background as the surrounding
           method-picker panels — no navy tint, no visible boundary. The
           iframe element's default white canvas is hidden by the solid
           gradient stops, and the lobby's cycling Bg1-4 starfield still
           shows through the alpha < 1.0 channels. */
        html, body {
            padding: 0 !important;
            margin: 0 !important;
            background: linear-gradient(180deg,
                rgba(0, 0, 0, 0.92) 0%,
                rgba(5, 6, 10, 0.95) 100%) !important;
        }
        .main-content, main, .page-content { padding-top: 20px !important; max-width: 100% !important; }

        /* Ensure the main form area fills the panel comfortably. 24px H
           padding matches .panel__body so the form aligns with the
           method-picker tiles in the same flow. */
        .page-content, .main-content, body > main {
            padding: 16px 24px 40px !important;
        }

        ${isNarrow ? `
        /* Legacy in-page containers (.generate-container, .create-form, etc.)
           assumed a full-page viewport (max-width 960px+, centered with auto
           margins). Inside the 480-wide panel that just leaves wasted side
           gutters and centers small content awkwardly. Force them to fill
           the available width and align left so the layout matches the
           tile-stack rhythm of the method-picker.
           ─ NARROW-ONLY ─ fullscreen variants (play, create-dexhero) keep
           the legacy centered layout because they have room for it. */
        .generate-container,
        .create-form,
        .container,
        .page-wrapper,
        .select-chain-container {
            max-width: 100% !important;
            margin: 0 !important;
            text-align: left !important;
        }

        /* Headings — match the method-picker's HUD display (24px uppercase,
           heavy letter-spacing) so a user moving from "CHOOSE YOUR METHOD"
           into "GENERATE DEXHERO" sees the same heading rhythm instead of a
           jarring jump to a big centered marketing h1. */
        .select-chain-header h1,
        .create-form h1,
        .page-content h1,
        main h1 {
            font-size: 24px !important;
            font-weight: 600 !important;
            letter-spacing: 0.18em !important;
            text-transform: uppercase !important;
            line-height: 1.2 !important;
            margin-bottom: 10px !important;
            text-align: left !important;
        }
        .select-chain-header p,
        .select-chain-header > p,
        main > .page-content > p:first-of-type {
            font-size: 13px !important;
            color: rgba(255, 255, 255, 0.6) !important;
            margin-bottom: 22px !important;
            text-align: left !important;
        }

        /* Action rows — the method-picker stacks tiles full-width; legacy
           pages center their primary CTA. Center on a 480-wide panel just
           leaves the button floating. Use left/start alignment so CTAs sit
           where the user's eye already is from reading the form. */
        .action-container { justify-content: flex-start !important; }
        ` : ''}

        /* Scrollbar tuning to match panel */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(6,182,212,0.4); }

        /* Defense in depth: legacy model-upload.css had a @media(max-width:768px)
           rule that clamped .model-preview-container to height:240px, which the
           iframe triggers (720px wide) and clipped the bottom of the viewer
           plus the entire Remove button strip. Force content-sized height and
           flex-column layout regardless of the cached CSS file. */
        .model-preview-container {
            height: auto !important;
            max-height: none !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: visible !important;
        }
        .model-preview-container.active { display: flex !important; }
        .model-preview-container:not(.active) { display: none !important; }
        .model-preview {
            width: 100% !important;
            height: 320px !important;
            flex: 0 0 auto !important;
        }
        /* Layout-only overrides — do NOT force display state. The model
           uploader sets display:none inline when the model came from
           the generator path (isGenerated=true) to hide the upload-only
           remove bar; a display:flex !important here would override that
           and the remove bar would flash on every generated DexHero. */
        .model-preview-info {
            flex: 0 0 auto !important;
            background: rgba(255,255,255,0.03) !important;
        }
    `;
    const style = doc.createElement('style');
    style.id = '__v3-embed-css';
    style.textContent = css;
    doc.head.appendChild(style);

    // Also strip the chrome containers outright once DOM is parsed — some
    // legacy pages read their sizes/positions at boot before the CSS rule
    // wins, so nuking the nodes prevents content jumps.
    ['ticker-container', 'header-placeholder', 'footer-placeholder', 'modals-placeholder'].forEach((sel) => {
        const el = doc.querySelector('.' + sel) || doc.getElementById(sel);
        if (el && !sel.endsWith('placeholder')) el.remove();
        // Keep placeholders so injection scripts don't error, but shrink them.
        if (el && sel.endsWith('placeholder')) el.style.display = 'none';
    });

    // Defense-in-depth: any in-iframe link that points to the lobby root would
    // load the whole home page inside the panel iframe. Remove those outright
    // so neither CSS timing nor user clicks can expose the issue.
    doc.querySelectorAll('a[href="/"], a[href="/index.html"], a[href="index.html"], a[href="./"]')
       .forEach((a) => a.remove());

    // Re-emit wallet state from the parent shell into the iframe so legacy
    // pages that read sessionStorage already have the keys they expect.
    // (sessionStorage is NOT shared across iframes even same-origin, so copy.)
    try {
        const parent = frame.ownerDocument.defaultView;
        ['walletConnected', 'walletAddress', 'walletChain', 'walletType', 'dexhero_wallet_base'].forEach((k) => {
            const v = parent.sessionStorage.getItem(k);
            if (v != null) frame.contentWindow.sessionStorage.setItem(k, v);
        });
    } catch {}
}
