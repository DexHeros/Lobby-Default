/* chat-commands — parse slash-commands from the lobby chat input.
 *
 * Hooks into the chat form's submit handler. When the input starts
 * with a known command, we intercept (e.g. /play 2048), route to the
 * matching action, and DON'T let the message reach the LLM.
 *
 * Commands in L1:
 *   /play <gameId>     start a Cradle session for the active dexhero
 *                      (matchmaker picks a Worker, owner watches via
 *                      the stream-view panel)
 *   /stop              stop the active session
 *   /games             list registered games
 *   /workers           list paired Cradle Workers + their status
 *   /pair [label]      mint a new reg_token for a fresh Worker box
 *
 * The Workers + Games surfaces (full UI) come in L7 polish. For L1
 * these commands print results into chat as a system message and
 * open the stream-view when /play succeeds. */

import * as wallet from '../services/wallet.js';
import { openStreamView } from './dexhero-stream-view.js';
import { toast } from './toast.js';

let _activeSessionId = null;

/* IDE-mode state — sticky once /ide starts. Subsequent chat input
 * routes to the agent instead of the regular dexhero brain. /exit
 * (or browser refresh) ends it. */
const _ideState = {
    sessionId:   null,
    es:          null,            // EventSource for streaming
    accumText:   '',              // current assistant turn's text buffer
    hasDraft:    false,           // true when patch_drafted fired this turn
    onAssistant: null,            // optional UI callback the chat sets
};

export function isIdeActive()      { return !!_ideState.sessionId; }
export function getIdeSessionId()  { return _ideState.sessionId; }

function _walletHeader() {
    const s = wallet.getStatus?.();
    return s?.address ? { 'x-v3labs-wallet': s.address.toLowerCase() } : {};
}

async function _apiPost(path, body) {
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ..._walletHeader() },
        body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
}

async function _apiGet(path) {
    const r = await fetch(path, { headers: { ..._walletHeader() } });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
}

/* Read the connected LLM key from the existing vault surface so we
 * can pump it through to the Cradle Worker. Vault decryption needs a
 * wallet signature unlock that the connect-master flow already does
 * for chat — we assume the user has unlocked at least once this
 * session before /play. */
async function _getActiveLlmKey() {
    try {
        const vault = await import('../services/llm-vault.js');
        const wstat = wallet.getStatus?.();
        const me = wstat?.address?.toLowerCase();
        if (!me) return null;
        // The vault module exposes a get-account-by-wallet helper
        // (Phase A6). Falls back to any first-account if the canonical
        // helper isn't present in the build.
        if (typeof vault.getActiveAccount === 'function') {
            return vault.getActiveAccount(me) || null;
        }
        if (typeof vault.getAllLlmAccounts === 'function') {
            const accounts = vault.getAllLlmAccounts(me) || [];
            return accounts[0] || null;
        }
    } catch {}
    return null;
}

async function _findAnthropicKey() {
    try {
        const vault = await import('../services/llm-vault.js');
        const wstat = wallet.getStatus?.();
        const me = wstat?.address?.toLowerCase();
        if (!me) return null;
        const accounts = (vault.getAllLlmAccounts?.(me)) || [];
        // Prefer the active one if marked, otherwise first anthropic-flavored one.
        const anth = accounts.find((a) => (a.provider || '').toLowerCase() === 'anthropic');
        return anth || null;
    } catch { return null; }
}

function _closeIdeStream() {
    if (_ideState.es) {
        try { _ideState.es.close(); } catch {}
        _ideState.es = null;
    }
    _ideState.sessionId = null;
    _ideState.accumText = '';
    _ideState.hasDraft  = false;
}

/* Subscribe to the IDE session's event SSE. The same /session/:id/events
 * endpoint the game/proposal sessions use — events of kind text_delta,
 * tool_use, tool_result, patch_drafted, turn_end. We render via the
 * provided onReply callback so the chat overlay shows the streaming
 * response in real time. */
function _subscribeIdeStream(sessionId, onReply) {
    const me = (wallet.getStatus?.()?.address || '').toLowerCase();
    const url = `/api/cradle/session/${encodeURIComponent(sessionId)}/events?wallet=${encodeURIComponent(me)}`;
    const es = new EventSource(url);
    _ideState.es = es;
    es.addEventListener('event', (ev) => {
        let payload = {};
        try { payload = JSON.parse(ev.data); } catch { return; }
        const kind = payload.kind;
        const data = payload.data || {};
        if (kind === 'text_delta') {
            _ideState.accumText += payload.summary || '';
            onReply(`__STREAM__${payload.summary || ''}`);   // chat overlay can detect prefix; falls back to bubble append
        } else if (kind === 'tool_use') {
            const ksum = (data.input_keys || []).join(', ');
            onReply(`🔧 ${payload.summary}(${ksum})`);
        } else if (kind === 'tool_result') {
            const detail = data.summary || data.error || '';
            onReply(`   → ${payload.summary} — ${detail}`);
        } else if (kind === 'patch_drafted') {
            _ideState.hasDraft = true;
            const title = payload.summary || '(untitled)';
            onReply(`✨ Draft patch ready: "${title}". Type \`/apply\` to publish to your branch + Genetics, or \`/iterate <feedback>\` to refine.`);
        } else if (kind === 'turn_end') {
            // Reset accumulator for the next turn.
            _ideState.accumText = '';
        } else if (kind === 'brain_error' || kind === 'workspace_error' || kind === 'busy') {
            onReply(`⚠️ ${payload.summary}`);
        } else if (kind === 'ready') {
            onReply(`🟢 ${payload.summary}`);
        }
    });
    es.addEventListener('ended', () => {
        onReply('IDE session closed.');
        _closeIdeStream();
    });
    es.onerror = () => { /* keep open — EventSource auto-reconnects */ };
}

async function _ideApi(path, body) {
    const me = (wallet.getStatus?.()?.address || '').toLowerCase();
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-v3labs-wallet': me },
        body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
}

/* Public hook the chat submit handler calls when IDE mode is active.
 * Returns true if the message was handled (don't pass to regular chat). */
export async function tryHandleIdeInput(text, { onReply } = {}) {
    if (!_ideState.sessionId) return false;
    const reply = onReply || ((m) => toast(m, { kind: 'info', ttl: 3000 }));
    // Built-in inline commands during an IDE session.
    if (text === '/apply') {
        const { ok, json } = await _ideApi(`/api/cradle/ide/${encodeURIComponent(_ideState.sessionId)}/apply`, {});
        if (!ok) { reply(`Apply failed: ${json.code || json.error}`); return true; }
        reply(`✅ Published patch ${json.patch?.id}: "${json.patch?.title}". Live in your Genetics feed.`);
        _ideState.hasDraft = false;
        return true;
    }
    if (text === '/exit') {
        const sid = _ideState.sessionId;
        if (sid) await _ideApi(`/api/cradle/ide/${encodeURIComponent(sid)}/stop`, {});
        _closeIdeStream();
        reply('IDE mode exited.');
        return true;
    }
    if (text.startsWith('/iterate ')) {
        const followup = text.slice('/iterate '.length).trim();
        const { ok, json } = await _ideApi('/api/cradle/ide/message',
            { sessionId: _ideState.sessionId, text: followup });
        if (!ok) reply(`Iterate failed: ${json.code || json.error}`);
        return true;
    }
    // Default: forward the typed message to the agent.
    const { ok, json } = await _ideApi('/api/cradle/ide/message',
        { sessionId: _ideState.sessionId, text });
    if (!ok) reply(`Message failed: ${json.code || json.error}`);
    return true;
}

const HANDLERS = {
    async ide() {
        if (_ideState.sessionId) {
            return { reply: 'IDE session already active. Just type. (Inline commands: /apply, /iterate <msg>, /exit)' };
        }
        const account = await _findAnthropicKey();
        if (!account?.api_key) {
            return { reply: 'No Anthropic key in vault. Open "Start here" → AI Keys → Link Anthropic, then /ide again.' };
        }
        const { ok, json } = await _ideApi('/api/cradle/ide/start', {
            llmKey:      account.api_key,
            llmProvider: 'anthropic',
            llmModel:    account.model || 'claude-opus-4-5-20251022',
        });
        if (!ok) return { reply: `Could not start IDE: ${json.code || json.error} — ${json.message || ''}` };
        _ideState.sessionId = json.sessionId;
        return {
            reply: `IDE session ${json.sessionId} on worker ${json.workerId}. Type any instruction — you're chatting with Claude inside your wallet-isolated V3Labs workspace. Use /apply when you have a patch ready, /iterate <msg> to refine, /exit to close.`,
            startIdeStream: true,
        };
    },
    async play(arg) {
        const gameId = String(arg || '').trim().toLowerCase();
        if (!gameId) return { reply: 'Usage: /play <gameId>  — try /games to see available' };
        const account = await _getActiveLlmKey();
        if (!account?.api_key) {
            return { reply: 'No LLM key in vault. Open the "Start here" popover → AI Keys → Link one, then try again.' };
        }
        const { ok, json } = await _apiPost('/api/cradle/session/start', {
            gameId,
            llmKey:      account.api_key,
            llmProvider: account.provider,
            llmModel:    account.model || account.default_model,
            maxMoves:    100,
            tickDelayMs: 600,
        });
        if (!ok) return { reply: `Could not start: ${json.code || json.error || 'unknown'} — ${json.message || ''}` };
        _activeSessionId = json.sessionId;
        await openStreamView(json.sessionId, gameId);
        return { reply: `Started ${gameId} on worker ${json.workerId}. Watch in the stream panel.` };
    },
    async stop() {
        if (!_activeSessionId) return { reply: 'No active session.' };
        const { ok, json } = await _apiPost('/api/cradle/session/stop', { sessionId: _activeSessionId });
        const sid = _activeSessionId; _activeSessionId = null;
        return { reply: ok ? `Stopped ${sid}.` : `Could not stop: ${json.error}` };
    },
    async workers() {
        const { ok, json } = await _apiGet('/api/cradle/my-workers');
        if (!ok) return { reply: `Could not list workers: ${json.error}` };
        if (!json.workers?.length) {
            return { reply: 'No paired workers. Type /pair to create a registration token.' };
        }
        const lines = json.workers.map((w) =>
            `• ${w.label} — ${w.online ? 'online' : 'offline'} — games: ${(w.capabilities?.games || []).join(', ') || 'none'}`);
        return { reply: ['Your Cradle Workers:', ...lines].join('\n') };
    },
    async pair(arg) {
        const label = String(arg || '').trim();
        const { ok, json } = await _apiPost('/api/cradle/pair', { label });
        if (!ok) return { reply: `Could not mint reg_token: ${json.error}` };
        return { reply:
            `Reg token (one-time, paste into your Worker's .env as WORKER_REG_TOKEN):\n${json.reg_token}\n\n` +
            `Then on your Worker box: docker run -d --env-file .env --restart=unless-stopped ghcr.io/v3labs/cradle-worker:latest`,
        };
    },
    games() {
        // Static list mirroring cradle-worker/games/registry.py.
        return { reply: 'Available games:\n• 2048\n• wordle' };
    },
};

/* Public: returns true if the input was a command and was handled.
 * Returns false to let the existing chat send-flow continue. */
export async function tryHandleSlash(rawInput, { onReply } = {}) {
    const s = String(rawInput || '').trim();
    if (!s.startsWith('/')) return false;
    const [cmdRaw, ...rest] = s.slice(1).split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(' ');
    const fn = HANDLERS[cmd];
    if (!fn) return false;
    try {
        const r = await fn(arg);
        if (r?.reply) {
            if (typeof onReply === 'function') onReply(r.reply);
            else toast(r.reply.split('\n')[0], { kind: 'info', ttl: 4000 });
        }
        // /ide just started — subscribe to the event SSE so streaming
        // assistant text + tool calls render into the chat.
        if (r?.startIdeStream && _ideState.sessionId && typeof onReply === 'function') {
            _subscribeIdeStream(_ideState.sessionId, onReply);
        }
    } catch (err) {
        if (typeof onReply === 'function') onReply(`Error: ${err?.message || err}`);
    }
    return true;
}
