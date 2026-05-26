/* DexHero chat — client-side wrapper around the brain endpoint.
 *
 *  - sendMessage(tokenId, text, history, wallet?) → Promise<{response,…}>
 *  - loadHistory(tokenId, wallet?) → conversation[]
 *  - saveHistory(tokenId, wallet?, history) → void
 *
 *  Connected wallet path (the live path):
 *    History lives in the per-topic E2E cache (app/services/dexhero-e2e.js)
 *    — server-side stored as ciphertext, client-side decrypted in a worker.
 *    `sendMessage` reads the union of ALL topics from that cache, sends it
 *    to the LLM proxy, then encrypts both the user and assistant turn and
 *    posts them to the active topic (or `brain` as default).
 *
 *  Anonymous / pre-bootstrap path:
 *    Falls back to the original localStorage cache so unconnected visitors
 *    still see a chat that survives within the page. Trimmed to 20 turns.
 *
 *  The user's LLM API key is pulled from llm-connect.js and included in
 *  the request body. The server uses it for the upstream Anthropic call
 *  and never persists it. No key → server falls back to the platform
 *  default for the platform-default DexHero only.
 */

import { getActiveAccount, getRawKey, setAccountModel } from './llm-connect.js';
import { getProvider } from './llm-providers.js';
import * as vault from './llm-vault.js';
import * as e2e from './dexhero-e2e.js';
import * as topicsSvc from './dexhero-topics.js';

const MAX_TURNS = 20;

// Chat history is wallet-scoped. Anonymous visitors (no wallet
// connected) get NO localStorage persistence — a refresh always
// starts the page fresh. Once a wallet connects, history loads +
// saves under a key that includes the wallet address so multiple
// users on the same browser don't bleed into each other's
// conversations.
function key(tokenId, wallet) {
    if (!wallet) return null;
    return `dexhero-brain:${wallet.toLowerCase()}:${tokenId}`;
}

export function loadHistory(tokenId, wallet) {
    if (!tokenId) return [];
    const k = key(tokenId, wallet);
    if (!k) return [];   // anon: nothing persisted, return empty
    try {
        const raw = localStorage.getItem(k);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-MAX_TURNS);
    } catch {
        return [];
    }
}

export function saveHistory(tokenId, wallet, history) {
    if (!tokenId) return;
    const k = key(tokenId, wallet);
    if (!k) return;      // anon: never persist
    try {
        const trimmed = Array.isArray(history) ? history.slice(-MAX_TURNS) : [];
        localStorage.setItem(k, JSON.stringify(trimmed));
    } catch {}
}

export function clearHistory(tokenId, wallet) {
    if (!tokenId) return;
    const k = key(tokenId, wallet);
    if (!k) return;
    try { localStorage.removeItem(k); } catch {}
}

/** Page-load housekeeping. Sweeps any legacy `dexhero-brain:anon:*`
 *  keys left over from before the anon-persistence rule landed.
 *  Cheap; runs once per page load. */
export function purgeAnonChatHistory() {
    try {
        const toDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('dexhero-brain:anon:')) toDelete.push(k);
        }
        for (const k of toDelete) localStorage.removeItem(k);
    } catch {}
}

// ─── E2E adoption helpers (connected-wallet path) ─────────────────

const _migratedKeys = new Set();

function legacyKey(tokenId, wallet) {
    return `dexhero-brain:${String(wallet).toLowerCase()}:${tokenId}`;
}
function migratedFlag(tokenId, wallet) {
    return `dexhero-brain-migrated:${String(wallet).toLowerCase()}:${tokenId}`;
}

/** Best-effort one-shot import of the legacy 20-turn localStorage cache
 *  into the new E2E-encrypted 'brain' topic. Idempotent — flagged in
 *  localStorage so a refresh doesn't re-import. Failures silent
 *  (most commonly: no Bearer session yet → retried next load). */
async function migrateLegacyHistoryOnce(tokenId, wallet) {
    if (!tokenId || !wallet) return;
    const lk = legacyKey(tokenId, wallet);
    const fk = migratedFlag(tokenId, wallet);
    if (_migratedKeys.has(fk)) return;
    try {
        if (localStorage.getItem(fk)) {
            _migratedKeys.add(fk);
            return;
        }
        const raw = localStorage.getItem(lk);
        if (!raw) {
            localStorage.setItem(fk, '1');
            _migratedKeys.add(fk);
            return;
        }
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.length) {
            localStorage.removeItem(lk);
            localStorage.setItem(fk, '1');
            _migratedKeys.add(fk);
            return;
        }
        const brain = await topicsSvc.getDefaultTopic(wallet, tokenId, 'brain');
        if (!brain) return;   // not bootstrapped yet, retry next session
        for (const m of arr) {
            if (m?.role !== 'user' && m?.role !== 'assistant') continue;
            if (typeof m.content !== 'string' || !m.content) continue;
            try {
                await topicsSvc.sendPlaintext(wallet, tokenId, brain.topic_id, m.role, m.content);
            } catch { /* keep going through the batch */ }
        }
        localStorage.removeItem(lk);
        localStorage.setItem(fk, '1');
        _migratedKeys.add(fk);
    } catch (err) {
        // Don't set the flag — we want to retry next session.
        console.warn('[dexhero-chat] legacy migration deferred:', err.message);
    }
}

async function resolveActiveTopicId(wallet, tokenId) {
    const cur = topicsSvc.getActiveTopic?.();
    if (cur && cur.wallet === String(wallet).toLowerCase() && cur.tokenId === tokenId) {
        return { topic_id: cur.topicId, topic_key: cur.topicKey };
    }
    const brain = await topicsSvc.getDefaultTopic(wallet, tokenId, 'brain');
    if (brain) return { topic_id: brain.topic_id, topic_key: 'brain' };
    // Bootstrap defensively.
    try {
        const list = await topicsSvc.bootstrapTopics(wallet, tokenId);
        const b = list.find((t) => t.topic_key === 'brain');
        if (b) return { topic_id: b.topic_id, topic_key: 'brain' };
    } catch {}
    return null;
}

/** Read the UNION of all topics from the E2E cache as the LLM ctx.
 *  Returns `[{role, content}]` matching the wire shape the server
 *  expects. Empty array if the cache is cold / no key derived yet. */
async function loadUnionHistoryForLLM(tokenId, wallet) {
    if (!tokenId || !wallet) return [];
    try {
        const msgs = await e2e.getCachedUnionMessages(wallet, tokenId);
        return (msgs || [])
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map((m) => ({ role: m.role, content: m.content }));
    } catch { return []; }
}

/** Low-level POST → /api/dexhero/:id/chat/stream for one (provider, model).
 *  Calls `onEvent` for every server-sent event:
 *    { type:'text_delta', text }   — append to bubble
 *    { type:'final', response, tokens, cost_usd, ... } — full result
 *    { type:'error', error, ... }  — model/provider/budget failure
 *  Returns the final-event payload on success, throws an Error with
 *  `code` (= the server's error string) on a streamed error event.
 *
 *  Pre-flight failures (rate-limit, no-key, bad-format) come back as a
 *  normal HTTP error (the server hasn't flushed SSE headers yet); we
 *  parse the JSON body and throw the same shape as chatFetch(). */
async function chatFetchStream(tokenId, text, history, wallet, userKey, providerId, model, onEvent) {
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            message: text,
            conversation: history || [],
            wallet: wallet || '',
            user_llm_key: userKey || '',
            user_llm_provider: providerId || '',
            user_llm_model: model || '',
        }),
    });
    if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `chat_failed_${r.status}`);
        err.status = r.status;
        err.body = body;
        err.code = body?.error || `chat_failed_${r.status}`;
        throw err;
    }
    if (!r.body || typeof r.body.getReader !== 'function') {
        const err = new Error('streaming_unsupported');
        err.code = 'streaming_unsupported';
        throw err;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalEvent = null;
    let streamedError = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames separated by blank lines. Within each frame each
        // non-comment line starts with `data: `. Server emits one JSON
        // object per frame, so parsing the concatenated `data:` lines
        // per frame is enough.
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() || '';
        for (const frame of frames) {
            const dataLines = [];
            for (const line of frame.split(/\r?\n/)) {
                const t = line.trimStart();
                if (!t || t.startsWith(':')) continue;
                if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
            }
            if (!dataLines.length) continue;
            let ev;
            try { ev = JSON.parse(dataLines.join('\n')); } catch { continue; }
            if (ev.type === 'final') {
                finalEvent = ev;
            } else if (ev.type === 'error') {
                streamedError = ev;
            }
            try { onEvent && onEvent(ev); } catch (e) { console.warn('[chatStream] handler:', e?.message); }
        }
    }
    if (streamedError) {
        const err = new Error(streamedError.error || 'brain_failure');
        err.code = streamedError.error || 'brain_failure';
        err.body = streamedError;
        throw err;
    }
    if (!finalEvent) {
        const err = new Error('stream_truncated');
        err.code = 'stream_truncated';
        throw err;
    }
    // Mirror chatFetch() return shape so callers can use either path.
    return {
        response:   finalEvent.response,
        tokens:     finalEvent.tokens,
        cost_usd:   finalEvent.cost_usd,
        latency_ms: finalEvent.latency_ms,
        mode:       finalEvent.mode,
        provider:   finalEvent.provider,
        model:      finalEvent.model,
    };
}

/** Low-level POST → /api/dexhero/:id/chat for one (provider, model) combo.
 *  Throws an error with `code` (= server's body.error) on non-2xx. */
async function chatFetch(tokenId, text, history, wallet, userKey, providerId, model) {
    const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            message: text,
            conversation: history || [],
            wallet: wallet || '',
            user_llm_key: userKey || '',
            user_llm_provider: providerId || '',
            user_llm_model: model || '',
        }),
    });
    if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch {}
        const err = new Error(body?.error || `chat_failed_${r.status}`);
        err.status = r.status;
        err.body = body;
        err.code = body?.error || `chat_failed_${r.status}`;
        throw err;
    }
    return await r.json();
}

// Errors that mean "this specific model isn't usable on this account" —
// when we hit them we try the next model in the provider's list before
// surfacing the failure to the user. Everything else (credit, auth,
// rate-limit, network) aborts immediately because retrying with a
// different model wouldn't help.
const MODEL_FALLBACK_CODES = new Set(['upstream_model_unavailable', 'upstream_forbidden']);

/** Send one chat turn. Auto-falls-back across the active provider's
 *  models when the user's account doesn't have access to the currently-
 *  selected one (e.g., gemini-1.5-pro on a free-tier Google key) and
 *  persists the working model so the next message uses it directly.
 *
 *  `opts.skipVault` is a no-op kept for source compatibility. A brand-
 *  new visitor (no connected provider) skips the unlock path because
 *  `providerId` is empty. Once a brain is connected, every chat —
 *  Truffle Man or otherwise — uses that key. Vault-restore from
 *  localStorage (see llm-vault.js) keeps refreshes silent after the
 *  first signature. */
/** Streaming variant of sendMessage. Same arguments + an `onDelta(text)`
 *  callback that fires for every text chunk the model emits. Returns the
 *  full result object (response, tokens, cost_usd, ...) once the model
 *  finishes — identical shape to sendMessage so callers can swap.
 *
 *  Model-fallback chain works the same: a model that 4xx's gets skipped,
 *  the next model in the provider's list is tried. The streaming path
 *  surfaces fallback errors before any deltas arrive (pre-flight failures
 *  come back as a non-2xx HTTP response, not as SSE frames). */
export async function sendMessageStream(tokenId, text, history, wallet, opts = {}, onDelta) {
    if (wallet && !vault.getCachedKeys?.(wallet)?.loaded) {
        try { await vault.loadKeys(wallet, { requireMint: false }); } catch {}
    }
    let unionHistory = null;
    if (wallet) {
        topicsSvc.bootstrapTopics(wallet, tokenId).catch(() => {});
        migrateLegacyHistoryOnce(tokenId, wallet);
        unionHistory = await loadUnionHistoryForLLM(tokenId, wallet);
    }
    const llmHistory = unionHistory != null ? unionHistory : (history || []);
    const active = getActiveAccount(wallet);
    const providerId = active.connected ? active.provider : '';
    let userKey = '';
    if (providerId) {
        try {
            userKey = await getRawKey(wallet, providerId);
        } catch (err) {
            if (err?.code === 'wallet_not_connected') throw err;
            if (err?.code === 'signature_rejected') throw err;
            userKey = '';
        }
    }

    const handleEvent = (ev) => {
        if (ev.type === 'text_delta' && typeof onDelta === 'function') {
            try { onDelta(ev.text || ''); } catch (e) { console.warn('[onDelta]', e?.message); }
        }
        // Surface tool events so the activity-tab timeline can render
        // a node per call (running → ok/error). Document-scope so the
        // listener in right-wing-activity.js picks them up regardless
        // of who initiated the chat.
        if (ev.type === 'tool_use' || ev.type === 'tool_result') {
            try {
                document.dispatchEvent(new CustomEvent('dexhero:chat-tool-event', {
                    bubbles: true,
                    detail: { tokenId, ...ev },
                }));
            } catch {}
        }
    };

    let result = null;
    let lastErr = null;

    if (!userKey || !providerId) {
        result = await chatFetchStream(tokenId, text, llmHistory, wallet, '', '', '', handleEvent);
    } else {
        const provider = getProvider(providerId);
        const preferred = active.model || provider?.defaultModel || '';
        const chain = [];
        const seen = new Set();
        const push = (m) => { if (m && !seen.has(m)) { chain.push(m); seen.add(m); } };
        push(preferred);
        push(provider?.defaultModel);
        for (const m of provider?.models || []) push(m.id);

        for (const model of chain) {
            try {
                result = await chatFetchStream(tokenId, text, llmHistory, wallet, userKey, providerId, model, handleEvent);
                if (model !== preferred) {
                    try {
                        setAccountModel(wallet, providerId, model);
                        document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
                    } catch {}
                }
                break;
            } catch (err) {
                lastErr = err;
                if (!MODEL_FALLBACK_CODES.has(err?.code)) throw err;
            }
        }
        if (!result) {
            if (lastErr) {
                const e = new Error('upstream_no_models_available');
                e.code = 'upstream_no_models_available';
                e.status = lastErr.status;
                e.body = lastErr.body;
                e.cause = lastErr;
                throw e;
            }
            throw new Error('chat_failed_unknown');
        }
    }

    // Persist after the stream completes — same wire path as sendMessage
    // so the topics service sees identical traffic.
    if (wallet && result?.response) {
        const userText = String(text || '');
        const assistantText = String(result.response || '');
        (async () => {
            try {
                const route = await resolveActiveTopicId(wallet, tokenId);
                if (!route?.topic_id) return;
                if (userText) {
                    await topicsSvc.sendPlaintext(wallet, tokenId, route.topic_id, 'user', userText);
                }
                if (assistantText) {
                    await topicsSvc.sendPlaintext(wallet, tokenId, route.topic_id, 'assistant', assistantText);
                }
                document.dispatchEvent(new CustomEvent('dexhero:topic-message-appended', {
                    detail: { wallet, tokenId, topicId: route.topic_id },
                }));
            } catch (err) {
                console.warn('[dexhero-chat] persist after stream:', err.message);
            }
        })();
    }

    return result;
}

export async function sendMessage(tokenId, text, history, wallet, opts = {}) {
    // Silent prefetch — if we have a stored session token but the cache
    // hasn't been populated yet (chat hit before module-init auto-load
    // fired), populate it before reading the active provider. Never
    // prompts; if no session, the cache stays empty and we fall through
    // to the "no provider" branch (server 402 → "connect a brain").
    if (wallet && !vault.getCachedKeys?.(wallet)?.loaded) {
        try { await vault.loadKeys(wallet, { requireMint: false }); } catch {}
    }

    // Connected-wallet path: rebuild `history` from the E2E union cache
    // so the LLM sees ALL topics chronologically. The popover the user
    // is staring at shows a single topic, but the underlying DexHero
    // mind remembers it all. Ignores the caller's `history` argument
    // when a wallet is available; for anonymous visitors we keep using
    // the legacy localStorage cache the caller already loaded.
    let unionHistory = null;
    if (wallet) {
        // Lazy bootstrap + one-shot legacy migration. Fire-and-forget;
        // the LLM call should not wait for them.
        topicsSvc.bootstrapTopics(wallet, tokenId).catch(() => {});
        migrateLegacyHistoryOnce(tokenId, wallet);
        unionHistory = await loadUnionHistoryForLLM(tokenId, wallet);
    }
    const llmHistory = unionHistory != null ? unionHistory : (history || []);
    const active = getActiveAccount(wallet);
    const providerId = active.connected ? active.provider : '';
    let userKey = '';
    if (providerId) {
        try {
            userKey = await getRawKey(wallet, providerId);
        } catch (err) {
            // Server-backed vault. getRawKey may prompt one wallet
            // signature (first sign-in per device); failures here mean:
            //   wallet_not_connected → no wallet → re-throw
            //   signature_rejected   → user said no to sign-in → re-throw
            //   anything else        → drop the key and let the server
            //                          402 the request with "connect a
            //                          brain", which is harmless.
            if (err?.code === 'wallet_not_connected') throw err;
            if (err?.code === 'signature_rejected') throw err;
            userKey = '';
        }
    }
    let result = null;
    let lastErr = null;

    // No usable credentials → send empty fields (server will 402 with
    // "connect a brain", which is the right copy for Truffle / anon).
    if (!userKey || !providerId) {
        result = await chatFetch(tokenId, text, llmHistory, wallet, '', '', '');
    } else {
        // Build the model-fallback chain. Order:
        //   1. Currently-selected model (user's preference comes first)
        //   2. Provider's defaultModel (fast / free tier)
        //   3. Remaining models in provider registry order (fast → balanced
        //      → deepest, matches the order in app/services/llm-providers.js)
        const provider = getProvider(providerId);
        const preferred = active.model || provider?.defaultModel || '';
        const chain = [];
        const seen = new Set();
        const push = (m) => { if (m && !seen.has(m)) { chain.push(m); seen.add(m); } };
        push(preferred);
        push(provider?.defaultModel);
        for (const m of provider?.models || []) push(m.id);

        for (const model of chain) {
            try {
                result = await chatFetch(tokenId, text, llmHistory, wallet, userKey, providerId, model);
                if (model !== preferred) {
                    try {
                        setAccountModel(wallet, providerId, model);
                        document.dispatchEvent(new CustomEvent('dexhero:llm-account-changed', { bubbles: true }));
                    } catch {}
                }
                break;
            } catch (err) {
                lastErr = err;
                if (!MODEL_FALLBACK_CODES.has(err?.code)) {
                    // Credit / auth / rate-limit / network — surface immediately.
                    throw err;
                }
                // else: try the next model in the chain
            }
        }
        if (!result) {
            // Every model on this provider rejected the request. Most likely:
            // the account has no access to any model (free tier not enabled,
            // billing not set up, etc.). Re-throw with a clearer code so the
            // chat UI can render the right copy.
            if (lastErr) {
                const e = new Error('upstream_no_models_available');
                e.code = 'upstream_no_models_available';
                e.status = lastErr.status;
                e.body = lastErr.body;
                e.cause = lastErr;
                throw e;
            }
            throw new Error('chat_failed_unknown');
        }
    }

    // Connected-wallet path: persist both turns into the active topic.
    // Fire-and-forget so the UI updates immediately with the response
    // and the cross-device sync happens in the background. We never
    // block the LLM return on the encrypt+upload — latency is sacred.
    if (wallet && result?.response) {
        const userText = String(text || '');
        const assistantText = String(result.response || '');
        (async () => {
            try {
                const route = await resolveActiveTopicId(wallet, tokenId);
                if (!route?.topic_id) return;
                if (userText) {
                    await topicsSvc.sendPlaintext(wallet, tokenId, route.topic_id, 'user', userText);
                }
                if (assistantText) {
                    await topicsSvc.sendPlaintext(wallet, tokenId, route.topic_id, 'assistant', assistantText);
                }
                document.dispatchEvent(new CustomEvent('dexhero:topic-message-appended', {
                    detail: { wallet, tokenId, topicId: route.topic_id },
                }));
            } catch (err) {
                console.warn('[dexhero-chat] persist after LLM:', err.message);
            }
        })();
    }

    return result;
}
