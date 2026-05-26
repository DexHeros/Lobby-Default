/* Install JarJar — workshop modal for pairing the desktop runtime.
 *
 * Subscribes to `dexhero:workshop-part` and opens when
 * `part === 'install'` (added to stage-annotations as the 6th label).
 * Flow:
 *
 *   1. User clicks Install → modal opens, calls /api/jarjar/pair/begin
 *      with a signed message. Server inserts a `pending` install row
 *      and returns { install_id, pair_token, expires_at }.
 *   2. Modal shows a copy-paste box with the pair message JarJar's
 *      desktop CLI expects:  v3labs:jarjar-pair:<pair_token>
 *      User runs `jarjar pair <token>` on their machine; JarJar's
 *      CLI signs the message with the wallet and hits /pair/complete.
 *   3. Modal polls /api/jarjar/installs every 4s. As soon as the row
 *      flips to status='active', modal swaps to a success view.
 *
 * Existing paired installs are listed below the pair widget with a
 * Revoke button each. Server confirms wallet ownership on revoke. */

import * as wallet from '../services/wallet.js';
import { on, E } from '../events.js';
import { beginPair, getInstalls, revokeInstall } from '../services/jarjar-pair.js';

let _wired = false;
let _popover = null;
let _pollTimer = null;
let _activePairToken = null;

const POLL_INTERVAL_MS = 4000;

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

function fmtRelative(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000)     return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

function closePopover() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _activePairToken = null;
    if (!_popover) return;
    try { _popover.remove(); } catch {}
    _popover = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
}
function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); closePopover(); } }
function onOutside(ev) {
    if (!_popover) return;
    if (_popover.contains(ev.target)) return;
    closePopover();
}

function positionPopover(popover, anchorEl) {
    if (!popover || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const pw = 400;
    let left = rect.left + window.scrollX + rect.width / 2 - pw / 2;
    let top  = rect.bottom + window.scrollY + 10;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 12;
    if (left > maxLeft) left = maxLeft;
    if (left < 12 + window.scrollX) left = 12 + window.scrollX;
    popover.style.left = `${left}px`;
    popover.style.top  = `${top}px`;
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {}
    // Fallback for non-secure contexts.
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch { return false; }
}

function installsListHtml(installs) {
    if (!installs.length) {
        return `<div class="brain-picker__hint">No paired installs yet.</div>`;
    }
    return `
        <table class="install-jarjar__table">
            <thead>
                <tr>
                    <th>Install</th><th>Status</th><th>Last seen</th><th></th>
                </tr>
            </thead>
            <tbody>
                ${installs.map((i) => `
                    <tr data-install="${escHtml(i.install_id)}">
                        <td>${escHtml(i.label || i.install_id.slice(0, 14) + '…')}</td>
                        <td>
                            <span class="install-jarjar__status install-jarjar__status--${escHtml(i.status)}">
                                ${escHtml(i.status)}
                            </span>
                        </td>
                        <td class="install-jarjar__when">${escHtml(fmtRelative(i.last_seen_at || i.paired_at))}</td>
                        <td>
                            ${i.status === 'active'
                                ? `<button type="button" class="install-jarjar__revoke" data-revoke="${escHtml(i.install_id)}">Revoke</button>`
                                : ''}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function bindInstallsActions(host) {
    host.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Revoking…';
            try {
                await revokeInstall(btn.dataset.revoke);
                await refreshInstallsList();
            } catch (err) {
                btn.textContent = 'Revoke failed';
                console.warn('[install-jarjar] revoke:', err);
            }
        });
    });
}

async function refreshInstallsList() {
    if (!_popover) return;
    const host = _popover.querySelector('[data-installs]');
    if (!host) return;
    try {
        const r = await getInstalls();
        const installs = Array.isArray(r?.installs) ? r.installs : [];
        host.innerHTML = installsListHtml(installs);
        bindInstallsActions(host);
        return installs;
    } catch (err) {
        host.innerHTML = `<div class="brain-picker__error">Couldn't load installs (${escHtml(err?.message || 'unknown')}).</div>`;
        return [];
    }
}

async function openInstall(anchorEl) {
    closePopover();
    const status = wallet.getStatus();
    if (!status?.connected || !status.address) {
        // Lobby has a separate connect-wallet flow; surface a toast-like
        // hint in the popover and bail.
        _popover = document.createElement('div');
        _popover.className = 'brain-picker';
        _popover.innerHTML = `
            <div class="brain-picker__head">
                <span class="brain-picker__title">Install JarJar</span>
                <button type="button" class="brain-picker__close" aria-label="Close">×</button>
            </div>
            <div class="brain-picker__body">
                <div class="brain-picker__error">Connect your wallet first to pair a JarJar desktop install.</div>
            </div>`;
        document.body.appendChild(_popover);
        positionPopover(_popover, anchorEl);
        _popover.querySelector('.brain-picker__close')?.addEventListener('click', closePopover);
        document.addEventListener('keydown', onKey, true);
        return;
    }

    _popover = document.createElement('div');
    _popover.className = 'brain-picker install-jarjar';
    _popover.setAttribute('role', 'dialog');
    _popover.setAttribute('aria-label', 'Install JarJar desktop runtime');
    _popover.innerHTML = `
        <div class="brain-picker__head">
            <span class="brain-picker__title">Install JarJar</span>
            <button type="button" class="brain-picker__close" aria-label="Close">×</button>
        </div>
        <div class="brain-picker__body" data-body>
            <p class="brain-picker__hint" style="margin:0 0 8px;">
                Pair this lobby with a JarJar desktop install. Once paired, JarJar pulls signed CharacterRecipes for every DexHero you own and runs them in the background.
            </p>

            <div class="install-jarjar__pair" data-pair-block>
                <div class="install-jarjar__pair-loading">Requesting pair token…</div>
            </div>

            <div class="voice-editor__label" style="margin-top:14px;">
                <span>Paired installs</span>
            </div>
            <div data-installs>
                <div class="brain-picker__loading">Loading installs…</div>
            </div>
        </div>
    `;
    document.body.appendChild(_popover);
    positionPopover(_popover, anchorEl);
    _popover.querySelector('.brain-picker__close')?.addEventListener('click', closePopover);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

    //  Kick the pair flow + the existing-installs list in parallel.
    refreshInstallsList();
    await beginPairFlow();
}

async function beginPairFlow() {
    if (!_popover) return;
    const host = _popover.querySelector('[data-pair-block]');
    if (!host) return;
    try {
        const r = await beginPair({ label: window.navigator?.platform || 'desktop' });
        _activePairToken = r.pair_token;
        const expiresMs = new Date(r.expires_at).getTime();
        const pairMsg = `${r.pair_message_prefix}${r.pair_token}`;

        host.innerHTML = `
            <div class="install-jarjar__step">
                <div class="install-jarjar__step-num">1</div>
                <div>
                    Download JarJar for your platform:
                    <div class="install-jarjar__downloads">
                        <a href="https://github.com/DexHeros/JarJar/releases/latest" target="_blank" rel="noopener">macOS</a>
                        <a href="https://github.com/DexHeros/JarJar/releases/latest" target="_blank" rel="noopener">Windows</a>
                        <a href="https://github.com/DexHeros/JarJar/releases/latest" target="_blank" rel="noopener">Linux</a>
                    </div>
                </div>
            </div>
            <div class="install-jarjar__step">
                <div class="install-jarjar__step-num">2</div>
                <div>
                    Run this in JarJar's CLI on that machine:
                    <pre class="install-jarjar__code" data-pair-msg>${escHtml('jarjar pair ' + r.pair_token)}</pre>
                    <div class="install-jarjar__row">
                        <button type="button" class="brain-picker__btn brain-picker__btn--ghost" data-copy="${escHtml('jarjar pair ' + r.pair_token)}">Copy command</button>
                        <span class="install-jarjar__expiry" data-expiry></span>
                    </div>
                    <details class="install-jarjar__details">
                        <summary>Raw pair message</summary>
                        <pre class="install-jarjar__code">${escHtml(pairMsg)}</pre>
                    </details>
                </div>
            </div>
            <div class="install-jarjar__step">
                <div class="install-jarjar__step-num">3</div>
                <div>
                    JarJar will ask you to sign once with your wallet. After that, this panel will update automatically.
                </div>
            </div>
            <div class="install-jarjar__waiting" data-waiting>
                <span class="install-jarjar__waiting-dot"></span>
                Waiting for desktop to complete pairing…
            </div>
        `;

        const expiryEl = host.querySelector('[data-expiry]');
        const tickExpiry = () => {
            if (!_popover || !expiryEl) return;
            const remaining = expiresMs - Date.now();
            if (remaining <= 0) {
                expiryEl.textContent = 'expired — close and reopen to get a fresh token';
                expiryEl.classList.add('install-jarjar__expiry--out');
                if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
                return;
            }
            const s = Math.ceil(remaining / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            expiryEl.textContent = `expires in ${m}:${String(sec).padStart(2, '0')}`;
        };
        tickExpiry();

        host.querySelector('[data-copy]')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const ok = await copyToClipboard(btn.dataset.copy || '');
            const orig = btn.textContent;
            btn.textContent = ok ? 'Copied' : 'Copy failed';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        });

        //  Poll for the row flipping to status='active'.
        _pollTimer = setInterval(async () => {
            tickExpiry();
            const installs = await refreshInstallsList();
            const justPaired = installs?.find?.((i) => i.status === 'active' && _wasJustPaired(i));
            if (justPaired) {
                clearInterval(_pollTimer); _pollTimer = null;
                showPairSuccess(justPaired);
            }
        }, POLL_INTERVAL_MS);
    } catch (err) {
        host.innerHTML = `<div class="brain-picker__error">Couldn't start pair: ${escHtml(err?.body?.error || err?.message || 'unknown')}.</div>`;
    }
}

function _wasJustPaired(install) {
    // "Just paired" = paired_at within the last 60s. Cheap heuristic so we
    // only trigger the success swap once per pair, not on every poll.
    if (!install?.paired_at) return false;
    return Date.now() - new Date(install.paired_at).getTime() < 60_000;
}

function showPairSuccess(install) {
    if (!_popover) return;
    const host = _popover.querySelector('[data-pair-block]');
    if (!host) return;
    host.innerHTML = `
        <div class="install-jarjar__success">
            <div class="install-jarjar__success-title">Paired ✓</div>
            <div class="install-jarjar__success-sub">
                ${escHtml(install.label || install.install_id.slice(0, 14) + '…')} is now linked to this wallet.
                JarJar will fetch recipes for every DexHero you own.
            </div>
        </div>
    `;
}

/** Wire the install modal against the workshop-part event stream.
 *  Call once at app boot — idempotent. */
export function initInstallJarjar() {
    if (_wired) return;
    _wired = true;
    on(E.STAGE_SUBJECT, () => { /* no-op — install isn't per-token */ });
    document.addEventListener('dexhero:workshop-part', (ev) => {
        const { part, anchorEl } = ev.detail || {};
        if (part !== 'install') return;
        openInstall(anchorEl);
    });
}
