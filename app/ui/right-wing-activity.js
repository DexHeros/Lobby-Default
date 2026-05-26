/* Right-wing Activity tab — the "while you were away" feed.
 *
 * Reads /api/dexhero/:tokenId/activity for the currently-centered
 * DexHero. Polls on a long cadence so a tab left open over hours
 * picks up new entries without hammering the server. Re-mounts when
 * the home panel re-renders (the right wing's HTML gets re-painted
 * on wallet changes — same pattern as right-wing-topics.js).
 */

import { on, E } from '../events.js';
import { renderBubble as renderRichBubble } from './bubble-renderer.js';

const POLL_INTERVAL_MS = 60_000;        // 60s polling while open
const FEED_LIMIT = 80;

// Live entries are reply bubbles that spilled over from the stage chat
// (see SPILL_AT_CHARS in stage-chat.js). They're maintained in-memory
// here, prepended above the polled list, and preserved across polls so
// fetchAndRender doesn't wipe them mid-stream.
const _liveEntries = new Map(); // spillId -> { node, body, accumulated, tokenId }
const KIND_GLYPH = {
    observation: '👁',
    thought:     '💭',
    action:      '⚙',
    reply:       '💬',
    rest:        '💤',
    error:       '⚠',
};

let _wired = false;
let _root = null;
let _list = null;
let _empty = null;
let _sub = null;
let _tokenId = null;
let _pollTimer = null;
let _lastIds = new Set();   // dedupe across polls

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

// Legacy entryRowHTML (string-templated row) is gone — buildPolledNode
// + buildChatNode + buildRow build the DOM directly so role/avatar
// markup stays consistent across all entry types.

function ago(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    const now = Date.now();
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60)     return `${s}s ago`;
    if (s < 3600)   return `${Math.round(s / 60)}m ago`;
    if (s < 86400)  return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

/** Build a timeline-style row: vertical rail with a colored status dot
 *  on the left, content on the right (action label + optional subtitle
 *  + optional body / IO block). Mirrors Claude Code / Cursor's IDE
 *  transcript view where every event sits on a single visual timeline. */
function buildRow({ kind, status, action, sub, time, body, ioBlocks, dataAttrs }) {
    const div = document.createElement('div');
    div.className = `activity__row activity__row--${kind}`;
    if (status) div.setAttribute('data-status', status);
    if (dataAttrs) {
        for (const [k, v] of Object.entries(dataAttrs)) div.setAttribute(k, v);
    }

    // Left: rail + dot (the timeline node for this event)
    const rail = document.createElement('div');
    rail.className = 'activity__rail';
    const dot = document.createElement('div');
    dot.className = 'activity__rail-dot';
    rail.appendChild(dot);
    div.appendChild(rail);

    // Right: content column
    const content = document.createElement('div');
    content.className = 'activity__row-content';

    const head = document.createElement('div');
    head.className = 'activity__row-head';
    const actionEl = document.createElement('span');
    actionEl.className = 'activity__row-action';
    actionEl.textContent = action;
    head.appendChild(actionEl);
    if (time) {
        const t = document.createElement('span');
        t.className = 'activity__row-time';
        t.textContent = time;
        head.appendChild(t);
    }
    content.appendChild(head);

    if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'activity__row-subtitle';
        subEl.textContent = sub;
        content.appendChild(subEl);
    }
    if (body) content.appendChild(body);
    if (Array.isArray(ioBlocks)) {
        for (const io of ioBlocks) {
            if (!io) continue;
            const block = document.createElement('div');
            block.className = 'activity__io-block';
            const label = document.createElement('div');
            label.className = 'activity__io-label';
            label.textContent = io.label || '';
            const bodyEl = document.createElement('div');
            bodyEl.className = 'activity__io-body';
            bodyEl.textContent = io.text || '';
            block.appendChild(label);
            block.appendChild(bodyEl);
            content.appendChild(block);
        }
    }

    div.appendChild(content);
    return div;
}

/** Build a row for a polled proactive-tick entry. */
function buildPolledNode(entry) {
    const kind = entry.kind || 'thought';
    const isReply = kind === 'reply';
    const action = isReply ? 'Truffle Man' : kind.charAt(0).toUpperCase() + kind.slice(1);
    const body = document.createElement('div');
    body.className = 'activity__row-body';
    if (isReply) {
        body.appendChild(renderRichBubble(entry.summary || ''));
    } else {
        body.textContent = entry.summary || '';
    }
    return buildRow({
        kind, action,
        time: ago(entry.occurred_at),
        body,
        dataAttrs: { 'data-id': String(entry.id || '') },
    });
}

/** Build a chat message entry (from dexhero:chat-message events). */
function buildChatNode(role, content, ts) {
    const isUser = role === 'user';
    const kind = isUser ? 'user' : 'reply';
    const body = document.createElement('div');
    body.className = 'activity__row-body';
    if (isUser) {
        body.textContent = content || '';
    } else {
        body.appendChild(renderRichBubble(content || ''));
    }
    return buildRow({
        kind,
        action: isUser ? 'You' : 'Truffle Man',
        time: 'just now',
        body,
        dataAttrs: { 'data-chat-ts': String(ts || Date.now()) },
    });
}

/** Build a tool-call timeline entry. Goes through two states: 'running'
 *  (amber pulsing dot, "calling…" subtitle) → 'ok' (green dot, result
 *  preview) or 'error' (red dot). The same node is updated in place when
 *  the matching tool_result event arrives, so the user sees a single
 *  timeline node morph from in-progress to complete. */
function _toolDisplayName(name) {
    if (!name) return 'Tool';
    return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function buildToolNode({ id, name, server, args }) {
    const display = _toolDisplayName(name);
    const sub = server ? 'via your AI provider' : 'function call';
    const ioBlocks = [];
    if (args && Object.keys(args).length) {
        // Compact one-line preview of the args ({"url":"https://..."})
        let argsLine;
        try { argsLine = JSON.stringify(args); } catch { argsLine = String(args); }
        ioBlocks.push({ label: 'IN', text: argsLine.length > 240 ? argsLine.slice(0, 240) + '…' : argsLine });
    }
    return buildRow({
        kind: 'tool',
        status: 'running',
        action: display,
        sub,
        time: 'calling…',
        ioBlocks,
        dataAttrs: { 'data-tool-id': String(id || '') },
    });
}

function _onChatToolEvent(ev) {
    const detail = ev.detail || {};
    if (!ensureMounted() || !_list) return;
    if (detail.type === 'tool_use') {
        const id = detail.id || `t:${Date.now()}:${Math.random().toString(36).slice(2,6)}`;
        const node = buildToolNode({
            id, name: detail.name, server: detail.server, args: detail.args || detail.input,
        });
        _list.appendChild(node);
        _toolRows.set(id, node);
        if (_empty) _empty.hidden = true;
        _scrollListBottom();
    } else if (detail.type === 'tool_result') {
        const id = detail.tool_use_id || detail.id;
        const node = id ? _toolRows.get(id) : null;
        if (!node) return;
        const ok = detail.ok !== false;
        node.setAttribute('data-status', ok ? 'ok' : 'error');
        const time = node.querySelector('.activity__row-time');
        if (time) time.textContent = ok ? 'done' : 'failed';
        const sub = node.querySelector('.activity__row-subtitle');
        if (sub) {
            const parts = [];
            if (typeof detail.hits === 'number') parts.push(`${detail.hits} result${detail.hits === 1 ? '' : 's'}`);
            if (detail.error) parts.push(detail.error);
            sub.textContent = parts.length ? parts.join(' · ') : (ok ? 'completed' : 'failed');
        }
        _toolRows.delete(id);
    }
}

// Tool rows are tracked by tool id so a tool_result event can update
// the matching tool_use row in place (running → ok / error).
const _toolRows = new Map();

function _scrollListBottom() {
    if (_list) requestAnimationFrame(() => { _list.scrollTop = _list.scrollHeight; });
}

function renderAll(entries) {
    if (!_list) return;
    // Preserve any live (in-progress) spill + already-rendered chat
    // entries — yanking them mid-stream would lose state. Pull them
    // out, write the polled entries, then re-attach the preserved
    // nodes so newest stays at the bottom of the list.
    const liveNodes = [..._list.querySelectorAll('[data-spill-id]')];
    const chatNodes = [..._list.querySelectorAll('[data-chat-ts]')];
    for (const n of liveNodes) n.remove();
    for (const n of chatNodes) n.remove();

    if (!entries.length && !liveNodes.length && !chatNodes.length) {
        _list.replaceChildren();
        if (_empty) _empty.hidden = false;
        if (_sub)   _sub.textContent = 'While you were away';
        return;
    }

    // Polled entries (proactive ticks) sort oldest → newest so the
    // chronological reading order is top → bottom (IDE-chat convention).
    const sorted = [...entries].sort((a, b) => {
        const ta = new Date(a.occurred_at || 0).getTime();
        const tb = new Date(b.occurred_at || 0).getTime();
        return ta - tb;
    });
    _list.replaceChildren(...sorted.map(buildPolledNode));

    // Re-attach preserved nodes at the bottom (newest after polled).
    for (const n of chatNodes) _list.appendChild(n);
    for (const n of liveNodes) _list.appendChild(n);

    if (_empty) _empty.hidden = true;
    if (_sub) {
        const n = entries.length + liveNodes.length + chatNodes.length;
        _sub.textContent = n === 1 ? '1 message' : `${n} messages`;
    }
    _lastIds = new Set(entries.map((e) => e.id));
}

/* ─── Live spill entries ───
 * stage-chat dispatches three events as a long reply spills over:
 *   bubble-spill        — create entry seeded with what we've shown so far
 *   bubble-spill-delta  — append each subsequent text chunk
 *   bubble-spill-end    — finalize; rich-render markdown into the entry
 * The entry stays in the list after end so the user can read the full
 * reply later. */

function _buildLiveNode(spillId) {
    const body = document.createElement('div');
    body.className = 'activity__row-body';
    body.setAttribute('data-summary', '');
    const node = buildRow({
        kind: 'reply',
        roleLabel: 'Truffle Man',
        time: 'streaming…',
        body,
        dataAttrs: { 'data-spill-id': spillId },
    });
    node.classList.add('activity__row--live');
    return node;
}

function _onSpillStart(ev) {
    if (!ensureMounted()) return;
    const { spillId, tokenId, accumulated } = ev.detail || {};
    if (!spillId) return;
    const node = _buildLiveNode(spillId);
    // Append at bottom (newest at bottom matches IDE chat convention
    // and the scroll-to-bottom-on-new-message behavior below).
    _list.appendChild(node);
    const body = node.querySelector('[data-summary]');
    if (body) body.textContent = accumulated || '';
    _liveEntries.set(spillId, { node, body, tokenId, accumulated: accumulated || '' });
    if (_empty) _empty.hidden = true;
    _scrollListBottom();
}

function _onSpillDelta(ev) {
    const { spillId, text } = ev.detail || {};
    const entry = spillId ? _liveEntries.get(spillId) : null;
    if (!entry || !text) return;
    entry.accumulated += text;
    if (entry.body) {
        // Plain textContent during streaming — incremental markdown
        // would re-tokenize the whole string per delta (cheap but
        // visually jumpy). Final markdown rendering happens on end.
        entry.body.textContent = entry.accumulated;
    }
    _scrollListBottom();
}

function _onSpillEnd(ev) {
    const { spillId, fullText, abandoned } = ev.detail || {};
    const entry = spillId ? _liveEntries.get(spillId) : null;
    if (!entry) return;
    if (abandoned) {
        // Stream errored mid-spill — drop the live entry entirely.
        try { entry.node.remove(); } catch {}
        _liveEntries.delete(spillId);
        return;
    }
    const finalText = (typeof fullText === 'string' && fullText) ? fullText : entry.accumulated;
    if (entry.body) {
        try {
            entry.body.textContent = '';
            entry.body.appendChild(renderRichBubble(finalText));
        } catch (err) {
            entry.body.textContent = finalText;
        }
    }
    entry.node.classList.remove('activity__row--live');
    // Flip the "streaming…" tag → "now" so meta reads as a normal reply.
    const time = entry.node.querySelector('.activity__row-time');
    if (time) time.textContent = 'now';
    _liveEntries.delete(spillId);
    _scrollListBottom();
}

async function fetchAndRender() {
    if (!_tokenId || !_list) return;
    try {
        const u = new URL(`/api/dexhero/${encodeURIComponent(_tokenId)}/activity`, window.location.origin);
        u.searchParams.set('limit', String(FEED_LIMIT));
        const r = await fetch(u.toString());
        if (!r.ok) return;
        const d = await r.json();
        renderAll(Array.isArray(d?.entries) ? d.entries : []);
    } catch (err) {
        console.warn('[right-wing-activity] fetch failed', err?.message);
    }
}

function mount() {
    const root = document.querySelector('[data-tab-panel="activity"]');
    if (!root) return false;
    _root = root;
    _list = root.querySelector('[data-activity-list]');
    _empty = root.querySelector('[data-activity-empty]');
    _sub = root.querySelector('[data-activity-sub]');
    return !!(_list && _empty);
}

function ensureMounted() {
    if (_root && _root.isConnected && _list && _list.isConnected) return true;
    return mount();
}

function startPolling() {
    stopPolling();
    fetchAndRender();
    _pollTimer = setInterval(fetchAndRender, POLL_INTERVAL_MS);
}
function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export function initRightWingActivity() {
    if (_wired) return;
    _wired = true;

    // Defer mount one tick so home.js render lands first on cold boot.
    setTimeout(() => { ensureMounted(); fetchAndRender(); }, 0);

    on(E.STAGE_SUBJECT, (subject) => {
        _tokenId = subject?.id || subject?.address || null;
        if (ensureMounted()) fetchAndRender();
    });

    // Re-mount + re-fetch when the home panel re-renders the right wing
    // (wallet swap / hash route change repaints the host).
    const obs = new MutationObserver(() => {
        // Cheap check — only re-mount when our panel actually disappeared.
        if (!_root || !_root.isConnected) {
            _root = _list = _empty = _sub = null;
            if (ensureMounted()) fetchAndRender();
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Start polling while the tab is visible. The home panel hides
    // panels via the `hidden` attribute; we poll regardless and let
    // the user see fresh entries the moment they switch tabs.
    startPolling();

    // Pause polling when the document is hidden — saves the loop from
    // burning cycles + LLM cost when nobody's watching.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling();
        else startPolling();
    });

    // Bubble spill — stage-chat hands long replies off to us so the
    // lobby bubble stays small. Listeners are document-level so they
    // survive home.js re-renders that drop our root node.
    document.addEventListener('dexhero:bubble-spill',       _onSpillStart);
    document.addEventListener('dexhero:bubble-spill-delta', _onSpillDelta);
    document.addEventListener('dexhero:bubble-spill-end',   _onSpillEnd);

    // Tool events — `dexhero-chat.js` dispatches `dexhero:chat-tool-event`
    // for every tool_use / tool_result the stream emits. Each one
    // becomes a timeline node in the activity feed (running → ok / err).
    document.addEventListener('dexhero:chat-tool-event', _onChatToolEvent);

    // Chat message events — render both user messages and short
    // (non-spilled) assistant replies as IDE-style rows so the Activity
    // tab is the full conversation log. Long assistant replies arrive
    // via spill events instead — to avoid double-rendering, we suppress
    // the chat-message handler for an assistant turn that has a live
    // spill in progress for the same token.
    document.addEventListener('dexhero:chat-message', (ev) => {
        const { tokenId, role, content, ts } = ev.detail || {};
        if (!ensureMounted() || !_list) return;
        if (role === 'assistant') {
            // Suppress if a spill for this token is mid-flight — the
            // spill-end handler will render the final assistant message.
            for (const entry of _liveEntries.values()) {
                if (entry.tokenId === tokenId) return;
            }
        }
        if (role !== 'user' && role !== 'assistant') return;
        if (!content) return;
        const node = buildChatNode(role, content, ts);
        _list.appendChild(node);
        if (_empty) _empty.hidden = true;
        _scrollListBottom();
    });
}
