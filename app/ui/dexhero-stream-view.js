/* dexhero-stream-view — live watch panel for a Cradle session.
 *
 * Owner types /play 2048 in chat → chat-commands.js posts to
 * /api/cradle/session/start, receives { sessionId, workerId }, then
 * calls openStreamView(sessionId) below. This module opens a panel
 * that subscribes to the SSE frame + event streams and renders:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Truffle is playing 2048               [Stop] │
 *   │ ┌──────────────────────────────────────────┐ │
 *   │ │                                          │ │
 *   │ │   live PNG frames (2-5 fps)              │ │
 *   │ │                                          │ │
 *   │ └──────────────────────────────────────────┘ │
 *   │ → up (score 64)                              │
 *   │ → left (score 128)                           │
 *   │ → up (score 256)                             │
 *   └──────────────────────────────────────────────┘
 *
 * Owner-only — the SSE endpoints reject any wallet other than the
 * session's owner. */

import * as wallet from '../services/wallet.js';

let _root = null;
let _frameES = null;
let _eventES = null;
let _sessionId = null;
let _moveList = null;

function _ensureRoot() {
    if (_root) return _root;
    _root = document.createElement('aside');
    _root.id = 'dexhero-stream-view';
    _root.hidden = true;
    _root.innerHTML = `
        <header class="dxs__head">
            <span class="dxs__title">Dexhero is playing —
                <strong data-game>...</strong>
            </span>
            <button type="button" class="dxs__stop" data-stop aria-label="Stop">Stop</button>
            <button type="button" class="dxs__close" data-close aria-label="Close">&times;</button>
        </header>
        <div class="dxs__stage">
            <img class="dxs__frame" data-frame alt="Live game frame">
            <div class="dxs__placeholder" data-placeholder>Waiting for first frame…</div>
        </div>
        <ol class="dxs__moves" data-moves></ol>
    `;
    document.body.appendChild(_root);
    _root.querySelector('[data-close]').addEventListener('click', closeStreamView);
    _root.querySelector('[data-stop]').addEventListener('click', () => stopSession());
    return _root;
}

function _walletHeader() {
    const s = wallet.getStatus?.();
    return s?.address ? { 'x-v3labs-wallet': s.address.toLowerCase() } : {};
}

export async function openStreamView(sessionId, gameLabel) {
    if (_sessionId) closeStreamView();      // tear down any prior view
    _sessionId = sessionId;
    const root = _ensureRoot();
    root.hidden = false;
    root.querySelector('[data-game]').textContent = gameLabel || sessionId;
    const frameEl = root.querySelector('[data-frame]');
    const placeholder = root.querySelector('[data-placeholder]');
    frameEl.removeAttribute('src');
    placeholder.hidden = false;
    _moveList = root.querySelector('[data-moves]');
    _moveList.innerHTML = '';

    // SSE doesn't natively support custom headers; we rely on cookies
    // for wallet auth in production. For L1 development the wallet
    // header is appended as a query param when present.
    const addr = (wallet.getStatus?.()?.address || '').toLowerCase();
    const auth = addr ? `?wallet=${encodeURIComponent(addr)}` : '';

    _frameES = new EventSource(`/api/cradle/session/${encodeURIComponent(sessionId)}/frames${auth}`);
    _frameES.addEventListener('frame', (ev) => {
        try {
            const { png_b64 } = JSON.parse(ev.data);
            if (png_b64) {
                frameEl.src = `data:image/png;base64,${png_b64}`;
                placeholder.hidden = true;
            }
        } catch {}
    });

    _eventES = new EventSource(`/api/cradle/session/${encodeURIComponent(sessionId)}/events${auth}`);
    _eventES.addEventListener('event', (ev) => {
        try {
            const { kind, summary } = JSON.parse(ev.data);
            const li = document.createElement('li');
            li.className = `dxs__move dxs__move--${kind}`;
            li.textContent = summary;
            _moveList.appendChild(li);
            _moveList.scrollTop = _moveList.scrollHeight;
        } catch {}
    });
    _eventES.addEventListener('ended', (ev) => {
        try {
            const { reason, stats } = JSON.parse(ev.data);
            const li = document.createElement('li');
            li.className = 'dxs__move dxs__move--ended';
            li.textContent = `Session ended (${reason}) — ${stats?.moves || 0} moves, score ${stats?.score ?? 'n/a'}`;
            _moveList.appendChild(li);
        } catch {}
        _closeStreams();
    });
}

export async function stopSession() {
    if (!_sessionId) return;
    try {
        await fetch('/api/cradle/session/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ..._walletHeader() },
            body: JSON.stringify({ sessionId: _sessionId }),
        });
    } catch {}
}

function _closeStreams() {
    if (_frameES) { try { _frameES.close(); } catch {} _frameES = null; }
    if (_eventES) { try { _eventES.close(); } catch {} _eventES = null; }
}

export function closeStreamView() {
    _closeStreams();
    _sessionId = null;
    if (_root) _root.hidden = true;
}
