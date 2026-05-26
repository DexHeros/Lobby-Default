/* V3Labs — tiny pub/sub event bus.
   Used by services and panels to coordinate without direct coupling. */

const _listeners = new Map();

export function on(event, fn) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(fn);
    return () => off(event, fn);
}

export function off(event, fn) {
    const set = _listeners.get(event);
    if (set) set.delete(fn);
}

export function emit(event, payload) {
    const set = _listeners.get(event);
    if (!set) return;
    for (const fn of set) {
        try { fn(payload); }
        catch (err) { console.error(`[events] listener for "${event}" threw:`, err); }
    }
}

export function once(event, fn) {
    const unsub = on(event, (p) => { unsub(); fn(p); });
    return unsub;
}

/* Standard event names (keep in sync with legacy window events) */
export const E = {
    WALLET_CONNECTED:    'wallet:connected',
    WALLET_DISCONNECTED: 'wallet:disconnected',
    WALLET_CHANGED:      'wallet:changed',
    ROUTE_CHANGE:        'route:change',
    STAGE_SUBJECT:       'stage:subject',
    TOAST:               'toast',
    // DOM-level CustomEvent names — dispatched via document.dispatchEvent
    // (NOT this bus). Kept here so callers can reference them via
    // import { E } from './events.js' instead of magic strings.
    BODY_READY:          'dexhero:body-ready',
    BODY_ACTION:         'dexhero:body-action',
    LLM_ACCOUNT_CHANGED: 'dexhero:llm-account-changed',
    VAULT_UNLOCKED:      'dexhero:vault-unlocked',
};
