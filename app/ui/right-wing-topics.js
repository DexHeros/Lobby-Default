/* Right-wing Topics tab — IDE-style topic list, per-wallet.
 *
 * Mirror of right-wing-todo.js — same UX, different storage bucket and
 * slash command. Topics are short labels the user wants to remember
 * to discuss with their DexHero (or any model they've connected). The
 * "+" / hint bar focuses the main lobby chat input and seeds it with
 * "/addtopic " so all typing happens in the same input.
 *
 * Storage layout:
 *   key:   dexhero-topics:<wallet-or-anon>
 *   value: JSON.stringify(Topic[])  where Topic = { id, text, done, ts }
 */

import { on, E } from '../events.js';
import * as wallet from '../services/wallet.js';

const STORAGE_PREFIX = 'dexhero-topics:';
const MAX_ITEMS = 200;

let _wired = false;
let _wallet = '';
let _items = [];
let _root    = null;
let _list    = null;
let _empty   = null;
let _count   = null;
let _trigger = null;
let _unsubs = [];

function storageKey() {
    const w = (_wallet || '').toLowerCase() || 'anon';
    return STORAGE_PREFIX + w;
}
function load() {
    try {
        const raw = localStorage.getItem(storageKey());
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((t) => t && typeof t.text === 'string' && t.id)
            .slice(0, MAX_ITEMS);
    } catch { return []; }
}
function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(_items.slice(0, MAX_ITEMS))); } catch {}
}

function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

function setEmptyVisible(visible) { if (_empty) _empty.hidden = !visible; }

/** Load all to-dos for this wallet and group them by their #topic
 *  tag. Returns Map<topicName, Todo[]>. Topic names are case-sensitive
 *  to match what the user typed. */
function loadTodosByTopic() {
    const w = (_wallet || '').toLowerCase() || 'anon';
    const key = 'dexhero-todo:' + w;
    let todos = [];
    try { todos = JSON.parse(localStorage.getItem(key) || '[]'); } catch { todos = []; }
    if (!Array.isArray(todos)) todos = [];
    const map = new Map();
    for (const t of todos) {
        const topic = String(t?.topic || '').trim();
        if (!topic) continue;
        if (!map.has(topic)) map.set(topic, []);
        map.get(topic).push(t);
    }
    return map;
}

/** Merge explicit topics (from /addtopic) with auto-discovered topics
 *  (from #tags on to-dos). Each topic gets its full list of items. */
function listTopics() {
    const todosByTopic = loadTodosByTopic();
    const knownNames = new Set(_items.map((t) => t.text));
    const merged = _items.map((t) => ({
        id: t.id,
        name: t.text,
        ts: t.ts,
        auto: false,
        items: todosByTopic.get(t.text) || [],
    }));
    for (const [name, items] of todosByTopic) {
        if (knownNames.has(name)) continue;
        merged.push({
            id: 'auto:' + name,
            name,
            ts: items[0]?.ts || Date.now(),
            auto: true,
            items,
        });
    }
    // Sort: topics with newer items first, ties broken by topic ts.
    merged.sort((a, b) => {
        const aT = a.items[0]?.ts || a.ts || 0;
        const bT = b.items[0]?.ts || b.ts || 0;
        return bT - aT;
    });
    return merged;
}

function updateCount() {
    if (!_count) return;
    _count.textContent = String(listTopics().length || 0);
}

function render() {
    if (!_list) return;
    const topics = listTopics();
    _list.innerHTML = '';
    if (!topics.length) {
        setEmptyVisible(true);
        updateCount();
        return;
    }
    setEmptyVisible(false);
    const frag = document.createDocumentFragment();
    for (const t of topics) {
        const card = document.createElement('div');
        card.className = `topics__card${t.auto ? ' is-auto' : ''}`;
        card.dataset.id = t.id;
        const itemsHTML = t.items.length
            ? `<ul class="topics__items">${t.items.map((it) => `
                <li class="topics__item${it.done ? ' is-done' : ''}">${escHtml(it.text)}</li>
              `).join('')}</ul>`
            : `<div class="topics__items-empty">No items yet — tag a /todo with <span class="todo__empty-cmd">#${escHtml(t.name)}</span></div>`;
        card.innerHTML = `
            <div class="topics__card-head">
                <span class="topics__card-title" data-name></span>
                ${t.auto ? '<span class="topics__auto-badge" title="Auto-created from a /todo tag">auto</span>' : ''}
                <span class="topics__card-count">${t.items.length}</span>
                ${t.auto ? '' : '<button type="button" class="todo__del" data-del aria-label="Delete topic">×</button>'}
            </div>
            ${itemsHTML}
        `;
        card.querySelector('[data-name]').textContent = t.name;
        const delBtn = card.querySelector('[data-del]');
        if (delBtn) delBtn.addEventListener('click', () => remove(t.id));
        frag.appendChild(card);
    }
    _list.appendChild(frag);
    updateCount();
}

function add(text) {
    const v = String(text || '').trim();
    if (!v) return;
    _items.unshift({ id: uid(), text: v, ts: Date.now() });
    if (_items.length > MAX_ITEMS) _items.length = MAX_ITEMS;
    save();
    render();
}
function remove(id) {
    _items = _items.filter((x) => x.id !== id);
    save();
    render();
}

/** Focus the main lobby chat input and seed it with "/addtopic " so
 *  the user types the topic name in the same place as everything else. */
function prefillMainInput() {
    const mainInput = document.getElementById('lobby-stage-chat-input');
    if (!mainInput) return;
    mainInput.disabled = false;
    mainInput.removeAttribute('disabled');
    if (!mainInput.value.toLowerCase().startsWith('/addtopic')) {
        mainInput.value = '/addtopic ';
    }
    mainInput.dispatchEvent(new Event('input', { bubbles: true }));
    try { mainInput.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    requestAnimationFrame(() => {
        try { mainInput.focus({ preventScroll: true }); } catch { mainInput.focus(); }
        try {
            const len = mainInput.value.length;
            mainInput.setSelectionRange(len, len);
        } catch {}
    });
}

function resolvePanel() {
    if (_root && _root.isConnected && _list && _list.isConnected) return true;
    const root = document.querySelector('[data-tab-panel="topics"]');
    if (!root) return false;
    _root    = root;
    _list    = root.querySelector('[data-topics-list]');
    _empty   = root.querySelector('[data-topics-empty]');
    _count   = root.querySelector('[data-topics-count]');
    _trigger = root.querySelector('[data-topics-trigger]');
    if (!_list) return false;
    render();
    return true;
}

export function initRightWingTopics() {
    if (_wired) return;
    _wired = true;
    _wallet = wallet.getStatus()?.address || '';
    _items = load();
    resolvePanel();

    _unsubs.push(on(E.WALLET_CHANGED, (w) => {
        _wallet = (w?.address || wallet.getStatus()?.address || '') + '';
        _items = load();
        if (resolvePanel()) render();
    }));

    // Slash command — stage-chat.js parses "/addtopic <text>" out of
    // onSubmit and dispatches this event back to us.
    document.addEventListener('dexhero:add-topic', (ev) => {
        const text = String(ev.detail?.text || '').trim();
        if (!text) return;
        resolvePanel();
        add(text);
    });

    // Any time a to-do is added/toggled/removed, re-render so newly
    // tagged items appear under their topic immediately.
    document.addEventListener('dexhero:todo-changed', () => {
        if (_root && _root.isConnected) render();
    });

    // Delegated click on the trigger so re-renders never break it.
    document.addEventListener('click', (ev) => {
        const trigger = ev.target.closest('[data-topics-trigger]');
        if (!trigger) return;
        ev.preventDefault();
        prefillMainInput();
    });

    const rightWing = document.getElementById('lobby-wing-right');
    if (rightWing) {
        const mo = new MutationObserver(() => {
            if (!_root || !_root.isConnected) {
                _root = _list = _empty = _count = _trigger = null;
                if (resolvePanel()) render();
            }
        });
        mo.observe(rightWing, { childList: true, subtree: true });
    }
}
