/* topic-chat-pane.js — per-topic decrypted chat view.
 *
 *   Mounts inside an eq-slot popover (or anywhere else). Renders the
 *   topic's history, scrolls to bottom on new messages, and registers
 *   itself as the active topic so the lobby chat input (the universal
 *   input below the 3D model) routes messages here.
 *
 *   No input element of its own — the lobby chat bar is the input.
 *
 *   Public:
 *     mountTopicChatPane(host, { walletAddr, tokenId, topic }) →
 *       { unmount, refresh }
 *
 *     topic = { topic_id, topic_key, name, icon? } — the row from
 *     /api/dexhero/:tokenId/topics. May be a 'pending' synthetic
 *     row (topic_id absent) for which no history is loaded.
 */

import * as topics from '../services/dexhero-topics.js';
import * as e2e from '../services/dexhero-e2e.js';
import * as wallet from '../services/wallet.js';
import { renderBubble as renderRichBubble } from './bubble-renderer.js';

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

/** Build a chat bubble <li> with rich markdown rendering. Returns a
 *  DocumentFragment-wrapping <li>; caller appends to the list. */
function buildBubbleNode(msg) {
    const who  = msg.role === 'assistant' ? 'them' : 'me';
    const time = new Date(msg.ts || msg.created_at || Date.now())
        .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const li = document.createElement('li');
    li.className = `topic-chat__bubble topic-chat__bubble--${who}`;
    const text = document.createElement('div');
    text.className = 'topic-chat__bubble-text';
    text.appendChild(renderRichBubble(msg.content || ''));
    const meta = document.createElement('div');
    meta.className = 'topic-chat__bubble-meta';
    meta.textContent = time;
    li.appendChild(text);
    li.appendChild(meta);
    return li;
}

function renderEmpty(topicName) {
    return `
        <li class="topic-chat__empty">
            <div class="topic-chat__empty-title">New conversation</div>
            <div class="topic-chat__empty-hint">Type in the chat bar below to start talking about ${esc(topicName || 'this topic')}.</div>
        </li>`;
}

function renderError(message) {
    return `
        <li class="topic-chat__error">
            <div class="topic-chat__error-title">Couldn't decrypt this message</div>
            <div class="topic-chat__error-hint">${esc(message || 'Wrong wallet key. Reconnect the original wallet to read this thread.')}</div>
        </li>`;
}

export function mountTopicChatPane(host, opts) {
    const walletAddr = String(opts?.walletAddr || '').toLowerCase();
    const tokenId   = String(opts?.tokenId || '');
    const topic     = opts?.topic || null;
    if (!host || !walletAddr || !tokenId || !topic?.topic_id) {
        // Render an inert "key needed / bootstrap pending" placeholder
        // and bail. Caller can refresh once data is available.
        if (host) {
            host.classList.add('topic-chat');
            host.innerHTML = `
                <ul class="topic-chat__list">
                    ${renderEmpty(topic?.name || '')}
                </ul>`;
        }
        return { unmount() {}, refresh() {} };
    }

    host.classList.add('topic-chat');
    host.dataset.topicId = topic.topic_id;
    host.innerHTML = `
        <ul class="topic-chat__list" data-topic-list></ul>`;

    const listEl = host.querySelector('[data-topic-list]');
    let isAlive = true;
    let messages = [];
    let keyMismatch = false;

    const scrollBottom = () => {
        // The popover overflow is on the host's parent — but the list
        // is itself a scrolling container. Both selectors covered.
        requestAnimationFrame(() => {
            try { listEl.scrollTop = listEl.scrollHeight; } catch {}
            try { host.scrollTop = host.scrollHeight; } catch {}
        });
    };

    const paint = () => {
        if (!isAlive) return;
        if (keyMismatch && !messages.length) {
            listEl.innerHTML = renderError();
            return;
        }
        if (!messages.length) {
            listEl.innerHTML = renderEmpty(topic.name);
            return;
        }
        // Rich render bypasses innerHTML — every bubble is a DOM node
        // built with textContent / createElement so assistant output can't
        // inject markup. Clearing + appendChild is the safe replacement
        // for the old innerHTML-of-joined-strings pattern.
        listEl.replaceChildren(...messages.map(buildBubbleNode));
        scrollBottom();
    };

    const loadFromCache = async () => {
        try {
            const ms = await e2e.getCachedTopicMessages(walletAddr, tokenId, topic.topic_id);
            if (!isAlive) return;
            messages = Array.isArray(ms) ? ms : [];
            paint();
        } catch (err) {
            console.warn('[topic-chat] cache load fail:', err.message);
        }
    };

    const syncFromServer = async () => {
        try {
            await e2e.syncFromServer(walletAddr, tokenId);
            await loadFromCache();
        } catch (err) {
            console.warn('[topic-chat] sync fail:', err.message);
        }
    };

    // Register as the active topic so the lobby input routes here.
    topics.setActiveTopic({
        wallet:   walletAddr,
        tokenId,
        topicId:  topic.topic_id,
        topicKey: topic.topic_key,
        topicName: topic.name,
    });

    // First paint from cache, sync in background.
    loadFromCache().then(syncFromServer);

    // Re-paint when new messages arrive for this topic (fired by
    // dexhero-chat.sendMessage after a successful encrypt+upload).
    const onMessageAppended = (ev) => {
        const d = ev.detail || {};
        if (d.tokenId !== tokenId || d.topicId !== topic.topic_id) return;
        // Detail carries either the plaintext (when we just sent) or
        // just a "refresh" hint; either way pull from cache.
        loadFromCache();
    };
    document.addEventListener('dexhero:topic-message-appended', onMessageAppended);

    // If the user clears the key / signs out, blank the pane out.
    const offKeyMismatch = e2e.onKeyMismatch?.(() => {
        keyMismatch = true;
        paint();
    });

    // Mark this topic as read on mount so the unread badge clears.
    topics.patchTopic(walletAddr, tokenId, topic.topic_id, {
        last_seen_at: new Date().toISOString(),
    }).catch(() => {});

    return {
        refresh() {
            loadFromCache();
        },
        unmount() {
            isAlive = false;
            document.removeEventListener('dexhero:topic-message-appended', onMessageAppended);
            try { offKeyMismatch?.(); } catch {}
            const cur = topics.getActiveTopic();
            if (cur && cur.topicId === topic.topic_id) {
                topics.setActiveTopic(null);
            }
        },
    };
}

/** Helper for the 4 slot pickers (brain/voice/body/movement). After
 *  the picker opens its eq-slot, call this to (a) ensure the user has
 *  bootstrapped topics for the current DexHero, (b) find the matching
 *  default topic, and (c) mount a topic-chat pane inside the popover.
 *
 *  Returns a teardown function the picker can call from its own
 *  cleanup hook. Most pickers don't need to — closing the eq-slot
 *  removes the DOM which detaches our listeners.
 *
 *  No-ops gracefully for anonymous visitors (no wallet → no topics →
 *  no chat persistence; chat still works through dexhero-chat.js's
 *  ephemeral path). */
export async function attachTopicChatToPicker(slotHandle, topicKey, opts = {}) {
    if (!slotHandle?.root) return () => {};
    const status = wallet.getStatus?.();
    const walletAddr = status?.address ? status.address.toLowerCase() : '';
    const subject = opts.subject || null;
    const tokenId = subject?.id || subject?.address || opts.tokenId || null;
    if (!walletAddr || !tokenId) {
        return () => {};   // anon / pre-bootstrap → silent skip
    }
    // Find or create a host inside the popover.
    let host = slotHandle.root.querySelector('[data-topic-chat]');
    if (!host) {
        host = document.createElement('div');
        host.dataset.topicChat = '';
        slotHandle.root.appendChild(host);
    }
    // Ensure topics + locate the default one for this slot.
    let topicRow = null;
    try {
        topicRow = await topics.getDefaultTopic(walletAddr, tokenId, topicKey);
    } catch { topicRow = null; }
    if (!slotHandle.root.isConnected) return () => {};
    if (!topicRow) {
        // Render the pane in "pending" state — it'll be re-mountable
        // once bootstrap completes on a later interaction.
        const pane = mountTopicChatPane(host, { walletAddr, tokenId, topic: null });
        return () => pane.unmount();
    }
    const pane = mountTopicChatPane(host, { walletAddr, tokenId, topic: topicRow });
    return () => pane.unmount();
}
