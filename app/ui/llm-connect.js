/* LLM Connect modal — "bring your own brain" for DexHero chat.
 *
 * Opens when anything dispatches `dexhero:open-llm-connect`. Vertical
 * list of 9 provider cards; clicking a card expands it in place to show
 * the key input (or endpoint dropdown for the local provider). Only one
 * card expands at a time — the layout reads like a settings page, not a
 * carousel.
 *
 *   • Provider monogram + name + tagline on every row
 *   • Status pill on the right: CONNECT / CONNECTED ✓ / CHANGE KEY
 *   • Expanded panel: password input or URL field + Connect button
 *   • Connected state shows masked key + Disconnect inline
 *
 * Wallet must be connected before the modal opens — open() defers to the
 * wallet-connect modal first if not, then re-enters once the user signs.
 */

import * as wallet from '../services/wallet.js';
import {
    getAccount,
    setAccount,
    removeAccount,
    validateKeyFormat,
    PROVIDERS,
} from '../services/llm-connect.js';
import * as vault from '../services/llm-vault.js';
import { providerGlyph } from './icons-llm.js';

let _wired = false;
let _modal = null;
let _expanded = null;     // currently-expanded provider id
let _busy = false;        // suppress accordion toggles mid-connect

function notifyChange() {
    document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
}

function close() {
    if (!_modal) return;
    _modal.setAttribute('data-state', 'closing');
    const node = _modal;
    _modal = null;
    _expanded = null;
    _busy = false;
    document.removeEventListener('keydown', _onKey, true);
    document.removeEventListener('dexhero:llm-account-changed', _onAccountsChanged);
    setTimeout(() => { try { node.remove(); } catch {} }, 220);
}
function _onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
}
function _onAccountsChanged() {
    // Auto-repaint whenever the underlying cache updates (server
    // load, save, disconnect, model swap, or a parallel tab). Bypasses
    // the in-handler paintList calls' race-with-async-cache problem.
    if (_modal) paintList();
}

/** Defer this modal until the wallet is connected. The vault encryption
 *  key derives from the wallet signature, so without a wallet there's no
 *  way to store an API key locally. */
function deferUntilWalletConnects() {
    if (typeof window.openConnectModal === 'function') {
        try { window.openConnectModal(); } catch {}
    } else {
        location.hash = '#/profile';
        return;
    }
    let unsub = null;
    const timer = setTimeout(() => { try { unsub?.(); } catch {} }, 5 * 60 * 1000);
    unsub = wallet.onConnect(() => {
        clearTimeout(timer);
        try { unsub?.(); } catch {}
        setTimeout(open, 60);
    });
}

function open() {
    if (_modal) return;

    const ws = wallet.getStatus();
    if (!ws?.connected || !ws.address) {
        deferUntilWalletConnects();
        return;
    }

    _expanded = null;

    _modal = document.createElement('div');
    _modal.className = 'llm-connect-overlay';
    _modal.setAttribute('role', 'dialog');
    _modal.setAttribute('aria-modal', 'true');
    _modal.setAttribute('aria-label', 'Connect Brain');
    _modal.setAttribute('data-state', 'opening');
    _modal.innerHTML = `
        <div class="llm-connect-overlay__backdrop" data-close></div>
        <div class="llm-connect" role="document">
            <div class="llm-connect__head">
                <div class="llm-connect__head-lead">
                    <span class="llm-connect__head-eyebrow">Brain Sign-In</span>
                    <h2 class="llm-connect__head-title">Bring your own AI</h2>
                </div>
                <button type="button" class="llm-connect__close" data-close aria-label="Close">×</button>
            </div>
            <div class="llm-connect__list" data-list></div>
            <div class="llm-connect__foot">
                <span class="llm-connect__foot-dot" aria-hidden="true"></span>
                <span class="llm-connect__foot-text">Encrypted on this device · Wallet signs once to decrypt</span>
            </div>
        </div>`;
    document.body.appendChild(_modal);

    _modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    document.addEventListener('keydown', _onKey, true);
    document.addEventListener('dexhero:llm-account-changed', _onAccountsChanged);
    paintList();
    requestAnimationFrame(() => _modal?.setAttribute('data-state', 'open'));

    // If we don't have a cached entry for this wallet yet, fetch the
    // server-stored keys. On a fresh device this triggers one wallet
    // sign-in to authenticate; subsequent opens are silent.
    const cached = vault.getCachedKeys?.(ws.address);
    if (!cached?.loaded) {
        (async () => {
            try { await vault.loadKeys(ws.address, { requireMint: false }); } catch {}
            // Still not loaded → prompt for sign-in once (silently swallow
            // if user rejects; the modal stays usable for fresh keys).
            const after = vault.getCachedKeys?.(ws.address);
            if (!after?.loaded) {
                try { await vault.loadKeys(ws.address, { requireMint: true }); } catch {}
            }
            if (_modal) paintList();
        })();
    }
}

/* ── Paint ──────────────────────────────────────────────────────── */

function paintList() {
    if (!_modal) return;
    const host = _modal.querySelector('[data-list]');
    if (!host) return;
    const w = wallet.getStatus()?.address || '';
    host.innerHTML = PROVIDERS.map((p) => providerCardHTML(p, w)).join('');
    host.querySelectorAll('.llm-connect__card').forEach((card) => {
        const head = card.querySelector('.llm-connect__card-head');
        head?.addEventListener('click', () => {
            if (_busy) return;
            toggleExpand(card.dataset.provider);
        });
        wireCardActions(card);
    });
}

function providerCardHTML(p, w) {
    const acct = getAccount(w, p.id);
    const isExpanded = _expanded === p.id;
    const isConnected = !!acct.connected;
    const statusKind = isConnected ? 'connected' : 'idle';
    const statusLabel = isConnected ? 'Connected' : 'Connect';
    return `
        <article class="llm-connect__card${isExpanded ? ' is-expanded' : ''}${isConnected ? ' is-connected' : ''}" data-provider="${escAttr(p.id)}">
            <button type="button" class="llm-connect__card-head" aria-expanded="${isExpanded ? 'true' : 'false'}">
                <span class="llm-connect__monogram" aria-hidden="true">${providerGlyph(p.id, { size: 28 })}</span>
                <span class="llm-connect__card-info">
                    <span class="llm-connect__card-name">${escHtml(p.name)}</span>
                    <span class="llm-connect__card-tag">${escHtml(p.tagline || '')}</span>
                </span>
                <span class="llm-connect__status llm-connect__status--${statusKind}">
                    ${isConnected ? '<span class="llm-connect__status-dot" aria-hidden="true"></span>' : ''}
                    <span class="llm-connect__status-label">${statusLabel}</span>
                </span>
                <span class="llm-connect__chev" aria-hidden="true">▾</span>
            </button>
            ${isExpanded ? expandedHTML(p, acct) : ''}
        </article>`;
}

function expandedHTML(p, acct) {
    if (acct.connected) {
        return `
            <div class="llm-connect__card-body">
                <div class="llm-connect__row">
                    <span class="llm-connect__masked" title="Encrypted with your wallet signature">${escHtml(acct.masked || '••••••')}</span>
                    <button type="button" class="llm-connect__btn llm-connect__btn--ghost" data-action="disconnect">Disconnect</button>
                </div>
                <p class="llm-connect__hint">Key stored encrypted in your browser. Disconnecting removes it.</p>
            </div>`;
    }
    if (p.id === 'local' && Array.isArray(p.endpoints)) {
        const endpoints = p.endpoints.map((e, i) =>
            `<option value="${i}" ${i === 0 ? 'selected' : ''}>${escHtml(e.label)}${e.url ? ` — ${escHtml(e.url)}` : ''}</option>`
        ).join('');
        return `
            <div class="llm-connect__card-body">
                <select class="llm-connect__select" data-endpoint aria-label="Local endpoint preset">${endpoints}</select>
                <div class="llm-connect__row">
                    <input type="url" class="llm-connect__input" data-key-input
                           placeholder="${escAttr(p.keyHint)}"
                           autocomplete="off" spellcheck="false" autocorrect="off"
                           value="${escAttr(p.endpoints[0]?.url || '')}">
                    <button type="button" class="llm-connect__btn llm-connect__btn--primary" data-action="connect">Connect</button>
                </div>
                <p class="llm-connect__hint" data-hint>Runs on your machine · $0 · keys never leave the browser.</p>
            </div>`;
    }
    return `
        <div class="llm-connect__card-body">
            <div class="llm-connect__row">
                <input type="password" class="llm-connect__input" data-key-input
                       placeholder="${escAttr(p.keyHint)}"
                       autocomplete="off" spellcheck="false" autocorrect="off">
                <button type="button" class="llm-connect__btn llm-connect__btn--primary" data-action="connect" disabled>Connect</button>
            </div>
            <p class="llm-connect__hint" data-hint>
                ${p.consoleUrl ? `Encrypted on this device · <a href="${escAttr(p.consoleUrl)}" target="_blank" rel="noopener">Get a ${escHtml(p.name)} key ↗</a>` : 'Encrypted on this device'}
            </p>
        </div>`;
}

function toggleExpand(providerId) {
    _expanded = (_expanded === providerId) ? null : providerId;
    paintList();
    if (_expanded) {
        setTimeout(() => {
            const input = _modal?.querySelector('[data-key-input]');
            input?.focus();
        }, 80);
    }
}

/* ── Actions ────────────────────────────────────────────────────── */

function wireCardActions(card) {
    const provId = card.dataset.provider;
    const provDef = PROVIDERS.find((p) => p.id === provId);
    if (!provDef) return;

    const input = card.querySelector('[data-key-input]');
    const hint = card.querySelector('[data-hint]');
    const connectBtn = card.querySelector('[data-action="connect"]');
    const disconnectBtn = card.querySelector('[data-action="disconnect"]');
    const endpoint = card.querySelector('[data-endpoint]');

    const baseHint = () => {
        if (!hint) return;
        hint.classList.remove('is-err');
        if (provId === 'local') {
            hint.textContent = 'Runs on your machine · $0 · keys never leave the browser.';
        } else if (provDef.consoleUrl) {
            hint.innerHTML = `Encrypted on this device · <a href="${escAttr(provDef.consoleUrl)}" target="_blank" rel="noopener">Get a ${escHtml(provDef.name)} key ↗</a>`;
        } else {
            hint.textContent = 'Encrypted on this device';
        }
    };

    function validate() {
        if (!input) return;
        const ok = validateKeyFormat(provId, input.value);
        if (connectBtn) connectBtn.disabled = !ok;
        if (!input.value || ok) {
            baseHint();
        } else if (hint) {
            hint.textContent = provId === 'local'
                ? 'Expected http:// or https:// URL'
                : `Expected format: ${provDef.keyHint}`;
            hint.classList.add('is-err');
        }
    }
    input?.addEventListener('input', validate);
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && connectBtn && !connectBtn.disabled) {
            ev.preventDefault();
            connectBtn.click();
        }
    });
    endpoint?.addEventListener('change', () => {
        const e = provDef.endpoints[Number(endpoint.value)];
        if (input) input.value = e?.url || '';
        input?.focus();
        validate();
    });
    // Initial validity (e.g., local provider with pre-filled URL).
    if (input) validate();

    connectBtn?.addEventListener('click', async () => {
        if (connectBtn.disabled) return;
        const origText = connectBtn.textContent;
        _busy = true;
        connectBtn.disabled = true;
        try {
            // Warm the IndexedDB-backed vault (no signature). Throws only
            // if the wallet isn't connected, which we already gate on.
            await vault.unlock();
            connectBtn.textContent = 'Saving…';
            const w = wallet.getStatus()?.address || '';
            const opts = provId === 'local' ? { model: 'auto' } : {};
            await setAccount(w, provId, input.value, opts);
            notifyChange();
            _busy = false;
            paintList();   // re-render to collapse the form into the connected pill
        } catch (err) {
            _busy = false;
            connectBtn.disabled = false;
            connectBtn.textContent = origText;
            const code = err?.code || err?.message || '';
            const msg = ({
                key_format_invalid:   provId === 'local' ? 'Expected http:// or https:// URL' : `Expected format: ${provDef.keyHint}`,
                signature_rejected:   'Wallet rejected the signature.',
                signature_malformed:  'Try signing once more.',
                wallet_not_connected: 'Connect wallet first.',
                vault_locked:         "Vault couldn't unlock.",
                encrypt_failed:       'Encryption failed.',
            })[code] || `Failed (${code})`;
            if (hint) { hint.textContent = msg; hint.classList.add('is-err'); }
        }
    });

    disconnectBtn?.addEventListener('click', async () => {
        if (disconnectBtn.disabled) return;
        const origText = disconnectBtn.textContent;
        disconnectBtn.disabled = true;
        disconnectBtn.textContent = 'Removing…';
        try {
            const w = wallet.getStatus()?.address || '';
            // removeAccount() is async — it round-trips DELETE /api/llm-keys
            // and only THEN updates the in-memory cache. Awaiting ensures
            // paintList() reads the post-disconnect state.
            await removeAccount(w, provId);
            notifyChange();
            if (_modal) paintList();
        } catch (err) {
            disconnectBtn.disabled = false;
            disconnectBtn.textContent = origText;
            if (hint) {
                hint.textContent = `Disconnect failed (${err?.code || err?.message || 'unknown'})`;
                hint.classList.add('is-err');
            }
        }
    });
}

/* ── Escape ─────────────────────────────────────────────────────── */

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}
function escAttr(s) { return escHtml(s); }

/** Wire the modal to the global open event. Call once at app boot. */
export function initLlmConnect() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('dexhero:open-llm-connect', () => open());
}

/** Mount the provider-list connect UI into any host element. Used by
 *  brain-picker to embed the same card UI inside the brain popover
 *  instead of opening a separate modal. Returns nothing — re-call to
 *  repaint after llm-account-changed if you keep the host alive.
 *
 *  options.hideConnected — when true, skip providers that already
 *  have a connected key. brain-picker uses this since the connected
 *  one is already shown in the popover's top bar. */
export function mountConnectPanel(host, options = {}) {
    if (!host) return;
    const w = wallet.getStatus()?.address || '';
    const hideConnected = !!options.hideConnected;
    const providers = hideConnected
        ? PROVIDERS.filter((p) => !getAccount(w, p.id).connected)
        : PROVIDERS;
    host.innerHTML = providers.map((p) => providerCardHTML(p, w)).join('');
    host.querySelectorAll('.llm-connect__card').forEach((card) => {
        const head = card.querySelector('.llm-connect__card-head');
        head?.addEventListener('click', () => {
            if (_busy) return;
            _expanded = (_expanded === card.dataset.provider) ? null : card.dataset.provider;
            mountConnectPanel(host, options);
            if (_expanded) {
                setTimeout(() => host.querySelector('[data-key-input]')?.focus(), 80);
            }
        });
        wireCardActions(card);
    });
}
