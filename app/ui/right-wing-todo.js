/* Right-wing To-Do tab — IDE-style task list, per-wallet.
 *
 * Mirrors the workspace-todo behavior most editor LLM panes ship with:
 * a single text input + a scrollable list of items the user can check
 * off or delete. Persists to localStorage so the list survives page
 * reloads. Scoped by wallet address (lower-cased) so multiple users on
 * one browser don't see each other's tasks; 'anon' bucket when no
 * wallet is connected.
 *
 * Storage layout:
 *   key:   dexhero-todo:<wallet-or-anon>
 *   value: JSON.stringify(Todo[])  where Todo = { id, text, done, ts }
 */

import { on, E } from '../events.js';
import * as wallet from '../services/wallet.js';

const STORAGE_PREFIX = 'dexhero-todo:';
const MAX_ITEMS = 200;

let _wired = false;
let _wallet = '';
let _items = [];
let _root    = null;
let _list    = null;
let _empty   = null;
let _count   = null;
let _trigger = null;   // click-to-prefill bar (replaces the old inline form)
let _unsubs  = [];

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

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Extract a #topic-tag from a /todo body and strip it out. The Topics
 *  tab uses this so a `/todo #vacation pack the bags` shows up grouped
 *  under the "vacation" topic. First tag wins; additional tags are
 *  left in the text so the user can still see/edit them. */
function parseTopic(text) {
    const m = String(text || '').match(/(?:^|\s)#([A-Za-z0-9_-]+)/);
    if (!m) return { text: String(text || '').trim(), topic: null };
    const topic = m[1];
    // Remove just the matched tag (and its leading whitespace) — don't
    // collapse all hashes, just the first one.
    const cleaned = String(text).replace(m[0], m[0].startsWith(' ') ? ' ' : '').replace(/\s+/g, ' ').trim();
    return { text: cleaned || topic, topic };
}

function notifyChanged() {
    document.dispatchEvent(new CustomEvent('dexhero:todo-changed', { bubbles: true }));
}

function setEmptyVisible(visible) { if (_empty) _empty.hidden = !visible; }

function updateCount() {
    if (!_count) return;
    const open = _items.filter((t) => !t.done).length;
    _count.textContent = `${open} open`;
}

function render() {
    if (!_list) return;
    _list.innerHTML = '';
    if (!_items.length) {
        setEmptyVisible(true);
        updateCount();
        return;
    }
    setEmptyVisible(false);
    const frag = document.createDocumentFragment();
    for (const t of _items) {
        const row = document.createElement('div');
        row.className = `todo__row${t.done ? ' is-done' : ''}`;
        row.dataset.id = t.id;
        row.innerHTML = `
            <button type="button" class="todo__check" data-toggle aria-label="${t.done ? 'Mark incomplete' : 'Mark complete'}">
                <span class="todo__check-mark" aria-hidden="true">${t.done ? '✓' : ''}</span>
            </button>
            <span class="todo__text" data-text></span>
            <button type="button" class="todo__del" data-del aria-label="Delete task">×</button>
        `;
        row.querySelector('[data-text]').textContent = t.text;
        row.querySelector('[data-toggle]').addEventListener('click', () => toggle(t.id));
        row.querySelector('[data-del]').addEventListener('click', () => remove(t.id));
        frag.appendChild(row);
    }
    _list.appendChild(frag);
    updateCount();
}

function add(text) {
    const v = String(text || '').trim();
    if (!v) return;
    const { text: cleanText, topic } = parseTopic(v);
    _items.unshift({ id: uid(), text: cleanText, done: false, ts: Date.now(), topic });
    if (_items.length > MAX_ITEMS) _items.length = MAX_ITEMS;
    save();
    render();
    notifyChanged();
}
function toggle(id) {
    const t = _items.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    save();
    render();
    notifyChanged();
}
function remove(id) {
    _items = _items.filter((x) => x.id !== id);
    save();
    render();
    notifyChanged();
}

/** Focus the main lobby chat input below the model and seed it with
 *  "/todo " — visually identical to the user having typed it. This is
 *  the *only* way to add a task; the actual command parsing happens
 *  in stage-chat.js's onSubmit handler, which dispatches
 *  dexhero:add-todo back to us. */
function prefillMainInput() {
    const mainInput = document.getElementById('lobby-stage-chat-input');
    if (!mainInput) return;
    // Force-enable in case the chat input was disabled at boot before
    // syncInputEnabled() ran (or some other code re-disabled it).
    mainInput.disabled = false;
    mainInput.removeAttribute('disabled');
    // Set the value as if typed. Don't squash an existing /todo
    // prefix — append-friendly so repeated clicks don't double-prefix.
    if (!mainInput.value.toLowerCase().startsWith('/todo')) {
        mainInput.value = '/todo ';
    }
    // Fire an `input` event so any listener depending on user typing
    // (e.g. auto-resize, suggestion popups) sees the synthetic value
    // exactly like a keystroke.
    mainInput.dispatchEvent(new Event('input', { bubbles: true }));
    // Scroll into view in case the right wing was scrolled past the
    // chat bar (mobile / small viewports).
    try { mainInput.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    // Focus + caret-to-end. Defer to the next frame so any layout
    // settling from scrollIntoView doesn't steal focus back.
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
    const root = document.querySelector('[data-tab-panel="todo"]');
    if (!root) return false;
    _root    = root;
    _list    = root.querySelector('[data-todo-list]');
    _empty   = root.querySelector('[data-todo-empty]');
    _count   = root.querySelector('[data-todo-count]');
    _trigger = root.querySelector('[data-todo-trigger]');
    if (!_list) return false;
    // Note: click on [data-todo-trigger] is handled by a delegated
    // document-level listener installed in initRightWingTodo() — works
    // regardless of when home.js renders/re-renders the right wing.
    render();
    return true;
}

export function initRightWingTodo() {
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

    // Slash command from the main chat input — stage-chat.js parses
    // "/todo <text>" out of onSubmit and re-dispatches as this event
    // so we never have to touch its DOM directly.
    document.addEventListener('dexhero:add-todo', (ev) => {
        const text = String(ev.detail?.text || '').trim();
        if (!text) return;
        resolvePanel();
        add(text);
    });

    // Delegated click handler — fires no matter when the right wing
    // re-renders the panel. Survives all re-paints because it's bound
    // to document, not the (volatile) trigger element.
    document.addEventListener('click', (ev) => {
        const trigger = ev.target.closest('[data-todo-trigger]');
        if (!trigger) return;
        ev.preventDefault();
        prefillMainInput();
    });

    // The right wing re-renders on subject/wallet changes — re-resolve
    // when our cached node is detached.
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
