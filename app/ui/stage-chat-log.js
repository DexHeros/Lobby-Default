/* Stage chat log — full conversation transcript on the right wing.
 *
 * Mirrors what shows up in the bubble above the centered DexHero,
 * but in the "professional AI chat" form factor that Claude, ChatGPT,
 * Cursor, etc. ship: a scrolling transcript with role labels, the
 * user's messages right-aligned in a soft bubble, the DexHero's
 * messages left-aligned with a small avatar + role tag, and a typing
 * indicator while the model is generating.
 *
 * The shell of this UI is product-agnostic — when the user wires their
 * own LLM account ([[user_role]]), this is where they see the same
 * transcript they would normally read inside their AI's native client.
 *
 * Source of truth: events dispatched from app/ui/stage-chat.js
 *   - `dexhero:chat-message`   { tokenId, role, content, ts, error? }
 *   - `dexhero:chat-thinking`  { tokenId, thinking }
 *
 * History on subject change is reloaded from
 * app/services/dexhero-chat.js::loadHistory(tokenId, wallet) so the
 * panel always matches what the bubble would say next.
 */

import { on, E } from '../events.js';
import * as wallet from '../services/wallet.js';
import * as chat from '../services/dexhero-chat.js';
// Phase G live JarJar trace stream is removed entirely — the wallet-
// signed WebSocket auth was a UX dead-end (signature prompts on every
// body switch + every 4-min refresh). The chat-log panel now only
// renders dexhero:chat-message events from the existing browser chat
// path; live agent-step playback can return later via a different
// mechanism (server-side Bearer, EventSource, etc.) that doesn't
// touch the wallet at all.

let _root = null;          // [data-tab-panel="chatlog"] container
let _list = null;          // scrollable message list
let _empty = null;         // empty-state element shown when no messages
let _subjectLabel = null;  // header sub-label showing current hero's name
let _subject = null;
let _wallet = '';
let _wired = false;
let _unsubs = [];
let _typingEl = null;      // assistant typing indicator row, if visible

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

function tokenIdOf(subject) {
    if (!subject) return null;
    if (subject.network === 'create') return null;
    return subject.id || subject.address || null;
}

function heroNameOf(subject) {
    return (subject?.name || 'DexHero').trim() || 'DexHero';
}

function heroInitial(subject) {
    const n = heroNameOf(subject);
    return (n[0] || 'D').toUpperCase();
}

function formatTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
}

/** Build one message row. `role` ∈ user|assistant. Industry-standard
 *  AI chat panel layout (Cursor / Windsurf / Claude.ai / ChatGPT):
 *  small muted role + timestamp meta on top, sans-serif body
 *  underneath, copy button on hover, no decorative bubbles. */
function renderRow(role, content, opts = {}) {
    const row = document.createElement('div');
    row.className = `chat-log__row chat-log__row--${role}${opts.error ? ' chat-log__row--error' : ''}`;
    const labelText = role === 'assistant' ? heroNameOf(_subject) : 'You';
    const time = opts.ts ? formatTime(opts.ts) : '';
    row.innerHTML = `
        <div class="chat-log__meta">
            <span class="chat-log__role" data-role-name></span>
            ${time ? `<span class="chat-log__time">${escHtml(time)}</span>` : ''}
            <button type="button" class="chat-log__copy" data-copy aria-label="Copy message" title="Copy">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
            </button>
        </div>
        <div class="chat-log__body" data-body></div>
    `;
    // textContent never interprets tokens as HTML even if a future LLM
    // emits angle brackets or script tags inside its reply.
    row.querySelector('[data-role-name]').textContent = labelText;
    row.querySelector('[data-body]').textContent = String(content ?? '');
    const copyBtn = row.querySelector('[data-copy]');
    if (copyBtn) {
        copyBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const text = row.querySelector('[data-body]')?.textContent || '';
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.classList.add('chat-log__copy--ok');
                setTimeout(() => copyBtn.classList.remove('chat-log__copy--ok'), 1100);
            } catch { /* clipboard blocked — silent */ }
        });
    }
    return row;
}

function clearTyping() {
    if (_typingEl && _typingEl.parentNode) {
        _typingEl.parentNode.removeChild(_typingEl);
    }
    _typingEl = null;
}

function showTyping() {
    if (!_list || _typingEl) return;
    const row = document.createElement('div');
    row.className = 'chat-log__row chat-log__row--assistant chat-log__row--typing';
    row.innerHTML = `
        <div class="chat-log__meta">
            <span class="chat-log__role" data-role-name></span>
        </div>
        <div class="chat-log__body chat-log__body--typing">
            <span class="chat-log__dots" aria-label="thinking"><i></i><i></i><i></i></span>
        </div>
    `;
    row.querySelector('[data-role-name]').textContent = heroNameOf(_subject);
    // Newest-on-top column: typing indicator lives at the top of the list.
    _list.insertBefore(row, _list.firstChild);
    _typingEl = row;
    scrollToTop();
}

/** Stack ordering: the chat log displays newest-on-top — like a
 *  notifications panel. New messages slide in from the right (from
 *  where the speech bubble lives on the stage), older messages
 *  naturally drift DOWN as the list grows and eventually scroll out
 *  past the bottom of the visible area. Auto-scroll snaps to the top
 *  (newest) when the user is already near it; if they've scrolled
 *  down to re-read older context, we don't yank them back. */
function isNearTop() {
    if (!_list) return true;
    return _list.scrollTop < 80;
}
function scrollToTop(force = false) {
    if (!_list) return;
    if (!force && !isNearTop()) return;
    requestAnimationFrame(() => { _list.scrollTop = 0; });
}

function setEmptyVisible(visible) {
    if (!_empty) return;
    _empty.hidden = !visible;
}

function appendMessage(role, content, opts = {}) {
    if (!_list) return;
    // Newest-on-top column. The typing indicator (when present) sits
    // at the TOP of the list — it's the most-recent "in-flight" event.
    // Real messages prepend above any existing rows EXCEPT the typing
    // indicator, which stays at slot 0 while the assistant is thinking
    // (user message tucks in just below it). When the real assistant
    // reply lands, the typing indicator is removed and the reply takes
    // its place at slot 0.
    if (role === 'assistant' && _typingEl) clearTyping();
    const row = renderRow(role, content, opts);
    if (role === 'user' && _typingEl) {
        // Typing indicator is at index 0; user's just-sent line goes below it.
        if (_typingEl.nextSibling) {
            _list.insertBefore(row, _typingEl.nextSibling);
        } else {
            _list.appendChild(row);
        }
    } else {
        // Newest row goes to the top of the list.
        _list.insertBefore(row, _list.firstChild);
    }
    setEmptyVisible(false);
    scrollToTop();
}

// Phase G agent-step row renderer removed alongside the jarjar-stream
// import. When live-trace playback returns it'll arrive via a different
// transport (server-side Bearer + EventSource) with no wallet involvement;
// the rendering shape will look different then anyway.

/** Render an upgrade-proposal card (interactive — has Preview / Save /
 *  Discard buttons) into the chat log. Behaves like an assistant row
 *  for ordering purposes: prepends at the top, clears typing indicator. */
function appendProposalCard(patch, opts = {}) {
    if (!_list) return;
    if (_typingEl) clearTyping();
    // Wrap the card in a chat-log row shell so it inherits the same
    // newest-on-top layout + role label as any other assistant message.
    const row = document.createElement('div');
    row.className = 'chat-log__row chat-log__row--assistant chat-log__row--proposal';
    const time = opts.ts ? formatTime(opts.ts) : '';
    row.innerHTML = `
        <div class="chat-log__meta">
            <span class="chat-log__role">${escHtml(heroNameOf(_subject))}</span>
            ${time ? `<span class="chat-log__time">${escHtml(time)}</span>` : ''}
        </div>
        <div class="chat-log__body chat-log__body--proposal" data-proposal-mount></div>
    `;
    const mount = row.querySelector('[data-proposal-mount]');
    import('./upgrade-proposal-card.js').then(({ buildProposalCard }) => {
        const card = buildProposalCard({ kind: 'proposal', patch });
        if (card) mount.appendChild(card);
    }).catch(() => {
        mount.textContent = `Proposal: ${patch?.title || 'Untitled'}`;
    });
    _list.insertBefore(row, _list.firstChild);
    setEmptyVisible(false);
    scrollToTop();
}

/** Reload the transcript from persisted history when the subject or
 *  wallet changes. */
function reloadHistory() {
    if (!_list) return;
    clearTyping();
    _list.innerHTML = '';
    const tokenId = tokenIdOf(_subject);
    if (!tokenId) {
        setEmptyVisible(true);
        return;
    }
    let history = [];
    try { history = chat.loadHistory(tokenId, _wallet) || []; } catch { history = []; }
    if (!history.length) {
        setEmptyVisible(true);
        return;
    }
    setEmptyVisible(false);
    // History is stored oldest → newest. We display newest at the top
    // of the list, so iterate in reverse and append in that reversed
    // order. End result: history[N-1] (newest) is at slot 0, history[0]
    // (oldest) is at the end of the list. Suppress the per-row entry
    // animation here — these aren't NEW messages, they're being
    // restored from storage; animating each one would feel chaotic.
    const frag = document.createDocumentFragment();
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        const role = m.role === 'user' ? 'user' : 'assistant';
        const row = renderRow(role, m.content, { ts: m.ts });
        row.classList.add('chat-log__row--restored');
        frag.appendChild(row);
    }
    _list.appendChild(frag);
    scrollToTop(true);   // newest visible on initial load
}

/** Find the panel in the DOM. Returns true once we've latched on. The
 *  right-wing HTML is re-rendered by home.js on wallet changes, so we
 *  re-resolve on every event tick where _root has gone stale. */
function resolvePanel() {
    if (_root && _root.isConnected && _list && _list.isConnected) return true;
    const root = document.querySelector('[data-tab-panel="chatlog"]');
    if (!root) return false;
    _root  = root;
    _list  = root.querySelector('[data-chatlog-list]');
    _empty = root.querySelector('[data-chatlog-empty]');
    _subjectLabel = root.querySelector('[data-chatlog-subject]');
    if (!_list) return false;
    updateSubjectLabel();
    reloadHistory();
    return true;
}

function updateSubjectLabel() {
    if (!_subjectLabel) return;
    const tokenId = tokenIdOf(_subject);
    _subjectLabel.textContent = tokenId ? heroNameOf(_subject) : '—';
}

export function initStageChatLog() {
    if (_wired) return;
    _wired = true;

    // Boot-time resolution might fail if home.js hasn't rendered yet.
    // We re-resolve lazily on every relevant event.
    resolvePanel();

    _unsubs.push(on(E.STAGE_SUBJECT, (subject) => {
        _subject = subject || null;
        if (resolvePanel()) { updateSubjectLabel(); reloadHistory(); }
    }));
    _unsubs.push(on(E.WALLET_CHANGED, (w) => {
        _wallet = (w?.address || wallet.getStatus()?.address || '') + '';
        if (resolvePanel()) reloadHistory();
    }));
    // Seed initial wallet — WALLET_CHANGED may have fired before init.
    _wallet = wallet.getStatus()?.address || '';

    document.addEventListener('dexhero:chat-message', (ev) => {
        if (!resolvePanel()) return;
        const d = ev.detail || {};
        // Only render messages for the currently-centered hero — the
        // panel shows ONE conversation at a time, matching the stage.
        if (d.tokenId && tokenIdOf(_subject) && d.tokenId !== tokenIdOf(_subject)) return;
        // Special message kind: upgrade-proposal renders as an interactive
        // patch card with Preview / Save / Discard buttons instead of a
        // plaintext row.
        if (d.kind === 'upgrade-proposal' && d.proposal) {
            appendProposalCard(d.proposal, { ts: d.ts || Date.now() });
            return;
        }
        appendMessage(d.role === 'user' ? 'user' : 'assistant', d.content, {
            ts: d.ts || Date.now(),
            error: !!d.error,
        });
    });
    document.addEventListener('dexhero:chat-thinking', (ev) => {
        if (!resolvePanel()) return;
        const d = ev.detail || {};
        if (d.tokenId && tokenIdOf(_subject) && d.tokenId !== tokenIdOf(_subject)) return;
        if (d.thinking) showTyping(); else clearTyping();
    });

    // Phase G live-trace listeners (dexhero:agent-step /
    // dexhero:agent-step-status) deleted alongside the jarjar-stream
    // import. The WebSocket auth model (wallet.signMessage on every
    // body switch + every 4-minute refresh) was the wrong tradeoff for
    // every user. The chat-log now only renders what's posted via the
    // existing browser chat path (no wallet, no signature). Future
    // re-introduction of live trace MUST use a server-side Bearer +
    // EventSource or similar — wallet signing belongs nowhere near a
    // background subscriber.


    // When the right-wing tab strip re-renders (wallet swap re-paints
    // home.js), the panel node is replaced and our cached refs go
    // stale. A MutationObserver on the right wing catches the swap and
    // re-attaches.
    const rightWing = document.getElementById('lobby-wing-right');
    if (rightWing) {
        const mo = new MutationObserver(() => {
            if (!_root || !_root.isConnected) {
                _root = _list = _empty = null;
                resolvePanel();
            }
        });
        mo.observe(rightWing, { childList: true, subtree: true });
    }
}

export function disposeStageChatLog() {
    for (const u of _unsubs) { try { u(); } catch {} }
    _unsubs = [];
    _root = _list = _empty = _typingEl = null;
    _wired = false;
}
