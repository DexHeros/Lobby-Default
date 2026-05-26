/* Stage chat — input + speech bubble for the centered DexHero.
 *
 * The lobby's chat surface in the "character workshop" vision. User types
 * in the input below the nameplate; the configured brain responds in a
 * comic-book speech bubble next to the model. Conversation persists in
 * localStorage so the hero "remembers" the visitor across reloads on the
 * same machine.
 *
 * Lifecycle: mounted by app/stage.js in idle mode, dismounted in context
 * mode. Subscribes to STAGE_SUBJECT — when the centered hero changes, we
 * clear the input, hide the bubble, and reload the new hero's local
 * history so a follow-up message picks up the right context.
 */

import { on, E } from '../events.js';
import * as wallet from '../services/wallet.js';
import * as chat from '../services/dexhero-chat.js';
import { getActiveAccount } from '../services/llm-connect.js';
import * as voice from '../services/dexhero-voice.js';
import { renderInto as renderBubbleInto } from './bubble-renderer.js';

let _dom = null;
let _subject = null;
let _history = [];
let _inFlight = false;
let _unsubs = [];
// Bubble starts suppressed and stays so until the FIRST model swap on
// the stage completes. This makes the bubble appear to come FROM the
// model (after it loads), not from empty space during page boot.
let _modelEverShown = false;
// Bubble stack — every Truffle utterance prepends a new item at the
// TOP of `.lobby-stage__bubble`, pushing older items down. The dots
// bubble that appears while the brain is thinking is the SAME logical
// item that morphs into the reply, so `_pendingItem` tracks which
// in-flight item should receive the reply text.
const MAX_BUBBLE_ITEMS = 5;
let _pendingItem = null;

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}

/* ─── Typewriter effect ───
 * Plays a character-by-character "typing" animation into a body element,
 * like NPC dialog in a game. Clicking the bubble while typing completes
 * the line instantly. */
let _typeTimer = null;
let _typeState = null; // { body, fullText, onDone }

function cancelTyping() {
    if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null; }
    _typeState = null;
}
function completeTyping() {
    if (!_typeState) return;
    const { body, fullText, onDone } = _typeState;
    cancelTyping();
    if (body) {
        body.textContent = fullText;
        // Skip-to-end scrolls the body back to the start so the user
        // sees the BEGINNING after pressing through the typing
        // animation (rather than landing on the tail).
        body.scrollTop = 0;
    }
    if (onDone) onDone();
}
function typeInto(body, text, onDone) {
    cancelTyping();
    if (!body) return;
    body.textContent = '';
    if (!text) { if (onDone) onDone(); return; }

    // Cadence scales so a 1024-token reply (~700-800 words ≈ 5000 chars)
    // doesn't take 90+ seconds to play out:
    //   ≤260 chars  → 1 char/tick   (~28 cps)
    //   ≤900 chars  → 2 chars/tick  (~55 cps)
    //   >900 chars  → 4 chars/tick  (~110 cps) — still readable for
    //                 quick scanning; click-to-skip available.
    const tickMs = 36;
    const charsPerTick = text.length > 900 ? 4 : (text.length > 260 ? 2 : 1);
    // Auto-scroll the BODY span so the typing cursor stays in view —
    // the scroll cap lives on the body now (not the bubble container),
    // so the bubble can keep overflow:visible for the tail pseudo.
    const scroller = body;
    let i = 0;
    _typeState = { body, fullText: text, onDone };
    _typeTimer = setInterval(() => {
        i = Math.min(text.length, i + charsPerTick);
        if (body) body.textContent = text.slice(0, i);
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        if (i >= text.length) {
            cancelTyping();
            if (onDone) onDone();
        }
    }, tickMs);
}

/* ─── Streaming delta path (Phase A0) ───
 * When the chat call streams, deltas land here rather than waiting for
 * the full reply + a typewriter animation. The loading-dots bubble (the
 * same DOM node that typeInto would have written into) gets morphed on
 * the FIRST delta and then deltas append directly to the body span.
 * Click-to-skip is no-op in streaming mode (the model IS the timing).
 *
 * SPILL: when the response grows past SPILL_AT_CHARS, the bubble is
 * frozen with its first N chars + a "→ continued in Activity" pill, and
 * subsequent deltas route to a live entry in the right-wing Activity
 * tab via dexhero:bubble-spill* events. Keeps the lobby bubble dock
 * small while letting Truffle deliver paragraph-length answers. */
const SPILL_AT_CHARS = 380;

let _streamItem = null;
let _streamBody = null;
let _streamHasStarted = false;
let _streamSpilled = false;
let _streamSpillId = null;

function _spillDispatch(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
}

function _appendSpillCta(item) {
    if (!item) return;
    const body = item.querySelector('[data-body]');
    if (body) body.appendChild(document.createTextNode('…'));
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'lobby-stage__bubble-spill-cta';
    cta.textContent = '→ continued in Activity';
    cta.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Click the Activity tab button programmatically so the existing
        // tab logic in mount() handles panel switching for us.
        const btn = document.querySelector('[data-bubble-tab="activity"]');
        if (btn) btn.click();
    });
    item.appendChild(cta);
}

function appendDelta(text) {
    if (!text) return;
    // Lazy morph: the first delta converts the dots bubble into a body
    // bubble. Subsequent deltas append to the same body span.
    if (!_streamHasStarted) {
        const item = _pendingItem && _pendingItem.isConnected ? _pendingItem : null;
        if (item) {
            cancelTyping();   // belt and suspenders — dots bubble owns no typeInto, but stale state could
            item.innerHTML = `<span class="lobby-stage__bubble-body" data-body></span>`;
            _streamItem = item;
            _streamBody = item.querySelector('[data-body]');
            _streamHasStarted = true;
            _pendingItem = null;  // ownership transfers from typeInto path to streaming path
        }
    }
    if (!_streamBody) return;

    // After spill, the bubble is frozen — only forward to Activity.
    if (_streamSpilled) {
        _spillDispatch('dexhero:bubble-spill-delta', {
            spillId: _streamSpillId, tokenId: tokenIdOf(_subject), text,
        });
        return;
    }

    _streamBody.textContent += text;
    _streamBody.scrollTop = _streamBody.scrollHeight;

    if (_streamBody.textContent.length >= SPILL_AT_CHARS) {
        // Cross the spill threshold. Freeze the bubble at its current
        // text, append the CTA pill, and announce the spill so the
        // Activity panel creates a live entry seeded with what we've
        // shown so far. All future deltas this turn route there.
        _streamSpilled = true;
        _streamSpillId = `spill:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const seeded = _streamBody.textContent;
        _spillDispatch('dexhero:bubble-spill', {
            spillId: _streamSpillId, tokenId: tokenIdOf(_subject), accumulated: seeded,
        });
        _appendSpillCta(_streamItem);
    }
}

function finalizeStreamingBubble(fullText) {
    const item = _streamItem;
    const body = _streamBody;
    const wasSpilled = _streamSpilled;
    const spillId = _streamSpillId;
    _streamItem = null;
    _streamBody = null;
    _streamHasStarted = false;
    _streamSpilled = false;
    _streamSpillId = null;

    if (wasSpilled) {
        // Bubble keeps its frozen partial text + CTA pill. Hand off the
        // full reply to the live Activity entry so it can rich-render.
        _spillDispatch('dexhero:bubble-spill-end', {
            spillId, tokenId: tokenIdOf(_subject), fullText: fullText || '',
        });
        if (item) slideItemToStack(item);
        return;
    }

    // Normal (un-spilled) path — promote streamed plaintext to rich DOM.
    if (body && typeof fullText === 'string' && fullText) {
        try {
            renderBubbleInto(body, fullText);
        } catch (err) {
            console.warn('[bubble-renderer]', err?.message);
            body.textContent = fullText;
        }
        body.scrollTop = 0;
    }
    if (item) slideItemToStack(item);
}

function abandonStreamingBubble() {
    // Error path — drop the streaming bubble entirely so the caller can
    // paint a clean error bubble in its place. If a spill is in flight,
    // tell the Activity panel to drop its live entry too.
    if (_streamSpilled && _streamSpillId) {
        _spillDispatch('dexhero:bubble-spill-end', {
            spillId: _streamSpillId, tokenId: tokenIdOf(_subject), fullText: '', abandoned: true,
        });
    }
    if (_streamItem) {
        try { _streamItem.remove(); } catch {}
    }
    _streamItem = null;
    _streamBody = null;
    _streamHasStarted = false;
    _streamSpilled = false;
    _streamSpillId = null;
}

function capBubbleStack() {
    const el = _dom?.bubble;
    if (!el) return;
    while (el.children.length > MAX_BUBBLE_ITEMS) {
        el.removeChild(el.lastChild);
    }
}

function clearBubbleStack() {
    const el = _dom?.bubble;
    if (!el) return;
    cancelTyping();
    _pendingItem = null;
    el.innerHTML = '';
    el.hidden = true;
    document.body.removeAttribute('data-bubble-revealed');
}

// How long the finished bubble lingers AT Truffle before sliding to
// the stack — short enough that the slide feels prompt, long enough
// that the reader sees the speech land at his mouth.
const SLIDE_TO_STACK_HOLD_MS = 4000;

// Idempotency for the idle bubble — the boot sequence fires
// STAGE_SUBJECT + WALLET_CHANGED + llm-account-changed back-to-back,
// and each one reaches reloadHistoryForSubject. Without dedupe the
// same prompt gets rebuilt + re-animated three times in a row, which
// reads as the bubble "flashing". Compare the desired prompt against
// the last one we actually painted; bail out when it's identical.
let _lastIdleKey = null;
let _lastSubjectId = null;

/* slideItemToStack — when the speaking bubble finishes typing, do a
 * FLIP transition to the dock stack so the visual continuity is
 * preserved across the two containers. The item moves from
 * #lobby-stage-speaking-bubble (anchored to the model's head) into
 * #lobby-stage-bubble (anchored to the viewport's right edge).
 *
 * `opts.immediate` skips the 700ms hold and does the move synchronously.
 * Used when a NEW bubble is preempting this one — the upcoming
 * `speakEl.innerHTML = ''` will destroy this node before the normal
 * hold fires, so we have to move it RIGHT NOW or it'll be lost. */
function slideItemToStack(item, opts = {}) {
    if (!item || !item.isConnected) return;
    if (!item.classList.contains('lobby-stage__bubble-item--at-character')) return;
    const run = () => {
        if (!item.isConnected) return;
        const dock = _dom?.bubble;
        if (!dock) return;
        // FLIP step 1 — record where the bubble currently is on screen.
        const fromRect = item.getBoundingClientRect();
        // FLIP step 2 — move the DOM node into the dock container and
        // drop the at-character class so the dock styles take over.
        // The dock container reflows immediately.
        dock.insertBefore(item, dock.firstChild);
        item.classList.remove('lobby-stage__bubble-item--at-character');
        dock.hidden = false;
        capBubbleStack();
        const toRect = item.getBoundingClientRect();
        // FLIP step 3 — animate from old → new transform delta back to 0.
        const dx = fromRect.left - toRect.left;
        const dy = fromRect.top  - toRect.top;
        const skip = Math.hypot(dx, dy) < 2;   // already aligned (rare)
        item.style.transition = 'none';
        item.style.transform = skip ? '' : `translate(${dx}px, ${dy}px)`;
        // Force a paint at the start transform so the browser interpolates
        // back to identity in the next frame.
        // eslint-disable-next-line no-unused-expressions
        item.offsetHeight;
        requestAnimationFrame(() => {
            item.style.transition = 'transform 460ms cubic-bezier(0.22, 1, 0.36, 1), opacity 460ms ease';
            item.style.transform = '';
            const cleanup = () => {
                item.style.transition = '';
                item.style.transform = '';
                item.removeEventListener('transitionend', cleanup);
            };
            item.addEventListener('transitionend', cleanup);
            // Safety: in case `transitionend` never fires (item was
            // removed mid-flight, browser quirk), still clean up.
            setTimeout(cleanup, 600);
        });
        // Speaking surface is empty now — hide so it doesn't leave
        // an invisible bbox flickering at the head anchor.
        const speak = document.getElementById('lobby-stage-speaking-bubble');
        if (speak && !speak.children.length) speak.hidden = true;
    };
    if (opts.immediate) {
        run();
    } else {
        setTimeout(run, SLIDE_TO_STACK_HOLD_MS);
    }
}

/** Prepend a user-message bubble to the dock. Unlike Truffle's
 *  bubbles, the user bubble doesn't go through the at-character /
 *  slide-to-stack flow — it lands directly in the dock as a chat-log
 *  entry. Different chrome (`--user` modifier) so the dialog reads
 *  alternating: AI → user → AI → user … from top down. */
function addUserBubble(text) {
    const el = _dom?.bubble;
    if (!el || !text) return;
    const item = document.createElement('div');
    item.className = 'lobby-stage__bubble-item lobby-stage__bubble-item--user';
    item.innerHTML = `<span class="lobby-stage__bubble-body" data-body></span>`;
    item.querySelector('[data-body]').textContent = text;
    el.insertBefore(item, el.firstChild);
    capBubbleStack();
    el.hidden = false;
    document.body.setAttribute('data-bubble-revealed', 'true');
}

/** Paint a static chat-log entry (no typewriter, no slide animation).
 *  Used to restore prior-session history into the dock so a returning
 *  user picks up where they left off visually. The dock uses CSS
 *  `flex-direction: column-reverse`, so we insertBefore(firstChild)
 *  to put the newest turn at the visual bottom. Older turns push up. */
function addStaticBubble(role, text) {
    const el = _dom?.bubble;
    if (!el || !text) return;
    const item = document.createElement('div');
    item.className = role === 'user'
        ? 'lobby-stage__bubble-item lobby-stage__bubble-item--user'
        : 'lobby-stage__bubble-item';
    item.innerHTML = `<span class="lobby-stage__bubble-body" data-body></span>`;
    const body = item.querySelector('[data-body]');
    body.textContent = String(text);
    // Promote to rich-rendered DOM (markdown, autolinks) for assistant turns
    if (role === 'assistant') {
        try { renderBubbleInto(body, text); } catch {}
    }
    el.insertBefore(item, el.firstChild);
    el.hidden = false;
    document.body.setAttribute('data-bubble-revealed', 'true');
}

/** Repaint the loaded history into the chat-log dock so a returning
 *  user sees their prior turns. Iterate oldest-first; each turn is
 *  inserted before the current firstChild, so the last turn ends up
 *  visually at the bottom (newest), oldest at the top.
 *
 *  Only paints if the dock is empty — assumes caller just cleared it. */
function paintHistoryIntoDock() {
    const el = _dom?.bubble;
    if (!el || !Array.isArray(_history) || !_history.length) return;
    // Iterate from oldest to newest; insertBefore(firstChild) means the
    // newest one ends up as firstChild (visual bottom). Cap at MAX so we
    // don't blow past capBubbleStack on a huge backlog.
    const tail = _history.slice(-MAX_BUBBLE_ITEMS);
    for (const turn of tail) {
        if (turn?.role !== 'user' && turn?.role !== 'assistant') continue;
        if (typeof turn.content !== 'string' || !turn.content) continue;
        addStaticBubble(turn.role, turn.content);
    }
    capBubbleStack();
}

function setBubble(text, { loading = false, persistent = false, cta = null } = {}) {
    const dock = _dom?.bubble;
    if (!dock) return;
    cancelTyping();

    // Empty call → no new bubble; nothing to do.
    if (!loading && !text && !cta) return;

    // Speaking surface — anchored to the model's projected head. The
    // currently-speaking bubble lives here; once typing completes the
    // FLIP slide in `slideItemToStack` re-parents the node into the
    // dock container `#lobby-stage-bubble`.
    const speakEl = document.getElementById('lobby-stage-speaking-bubble');

    // Reuse the pending loading slot when a real reply arrives — the
    // dots bubble morphs into the typed reply (one logical bubble per
    // utterance: dots, then text, in the same DOM node). Otherwise
    // prepend a brand-new at-character bubble.
    let item;
    if (!loading && _pendingItem && _pendingItem.isConnected) {
        item = _pendingItem;
        item.innerHTML = '';
        item.classList.toggle('lobby-stage__bubble-item--cta', !!cta);
        _pendingItem = null;
    } else {
        // Any previous bubble still lingering at Truffle's mouth gets
        // sent to the stack immediately so the new one owns the
        // speaking surface cleanly. Includes bubbles still in the
        // speaking container OR in the dock with --at-character.
        if (speakEl) {
            // CRITICAL: pass { immediate: true } so the move happens
            // synchronously. The normal 700ms hold would let the
            // `speakEl.innerHTML = ''` below destroy this node before
            // the slide fires, and the bubble would be lost forever.
            for (const prev of [...speakEl.querySelectorAll('.lobby-stage__bubble-item--at-character')]) {
                slideItemToStack(prev, { immediate: true });
            }
        }
        dock.querySelectorAll('.lobby-stage__bubble-item--at-character')
            .forEach((p) => p.classList.remove('lobby-stage__bubble-item--at-character'));

        item = document.createElement('div');
        item.className = 'lobby-stage__bubble-item lobby-stage__bubble-item--at-character';
        if (cta) item.classList.add('lobby-stage__bubble-item--cta');
        // Mount in the speaking surface (above the model's head). If
        // the surface isn't in the DOM yet (e.g. very early boot)
        // fall back to the dock so we never lose the message.
        if (speakEl) {
            speakEl.innerHTML = '';            // only one speaking bubble at a time
            speakEl.appendChild(item);
            speakEl.hidden = false;
        } else {
            dock.insertBefore(item, dock.firstChild);
        }
    }
    capBubbleStack();

    if (loading) {
        item.innerHTML = `<span class="lobby-stage__bubble-dots" aria-label="thinking"><i></i><i></i><i></i></span>`;
        _pendingItem = item;
        // Don't slide yet — bubble stays at character with dots until
        // the reply arrives (next setBubble call morphs this item).
    } else if (cta) {
        item.innerHTML = `<span class="lobby-stage__bubble-body" data-body></span>`;
        const body = item.querySelector('[data-body]');
        typeInto(body, text, () => {
            if (!body) return;
            body.appendChild(document.createTextNode(' '));
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lobby-stage__bubble-cta';
            btn.textContent = cta.label;
            btn.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent(cta.action, { bubbles: true }));
            });
            body.appendChild(btn);
            slideItemToStack(item);
        });
    } else {
        item.innerHTML = `<span class="lobby-stage__bubble-body" data-body></span>`;
        const body = item.querySelector('[data-body]');
        typeInto(body, text, () => {
            // Promote the typed plaintext to a rich-rendered DOM tree
            // (markdown, autolinks, media). The typewriter still plays
            // char-by-char first; the swap happens on completion so the
            // user sees the personality of typing AND the final fidelity.
            try { renderBubbleInto(body, text); } catch {}
            slideItemToStack(item);
        });
    }

    // Click-to-skip on the newest item while typing.
    item.onclick = (ev) => {
        if (ev.target.closest('.lobby-stage__bubble-cta')) return;
        if (_typeState) completeTyping();
    };

    dock.hidden = false;
    document.body.setAttribute('data-bubble-revealed', 'true');
}

/* ─── Quick-reply chips ───
 * When a model reply contains question marks or option lists, we render
 * a small right-column bubble with one chip per detected choice. Click a
 * chip → it routes through the same submit path as typed input. The
 * chips bubble shares the head-sway CSS vars with the main bubble so
 * the pair moves together. */

const QUICK_REPLY_MAX_CHIPS = 5;
const QUICK_REPLY_MAX_CHIP_LEN = 64;

/** Heuristic option extraction. Looks for bulleted / numbered lines
 *  and returns up to QUICK_REPLY_MAX_CHIPS distinct labels. Falls back
 *  to Yes/No when the reply ends in `?` with no obvious open-question
 *  word (what/how/why/when/who/where/which). Returns `[]` when no
 *  prompt-for-response is detected. */
function parseChoices(text) {
    if (!text) return [];
    const lines = String(text).split(/\r?\n/);
    const patterns = [
        /^\s*[-*•]\s+(.{2,})$/,                  // - choice  /  * choice
        /^\s*\d+\s*[\.\):]\s+(.{2,})$/,          // 1. choice / 1) choice / 1: choice
        /^\s*\[\s*\d+\s*\]\s+(.{2,})$/,          // [1] choice
        /^\s*[A-Z]\s*[\.\):]\s+(.{2,})$/,        // A. choice / A) choice
    ];
    const chips = [];
    for (const raw of lines) {
        for (const p of patterns) {
            const m = raw.match(p);
            if (!m) continue;
            const txt = m[1].trim().replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/[.?!]+$/, '');
            if (txt.length >= 2 && txt.length <= QUICK_REPLY_MAX_CHIP_LEN && !chips.includes(txt)) {
                chips.push(txt);
            }
            break;
        }
        if (chips.length >= QUICK_REPLY_MAX_CHIPS) break;
    }
    if (chips.length) return chips;
    const trimmed = String(text).trim();
    if (!trimmed.endsWith('?')) return [];
    if (/\b(what|which|how|why|where|when|who)\b/i.test(trimmed.slice(-160))) return [];
    return ['Yes', 'No'];
}

function paintQuickReply(text) {
    const el = _dom?.quickReply;
    if (!el) return;
    const chips = parseChoices(text);
    if (!chips.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `<div class="lobby-stage__quick-reply-label">Reply</div>` +
        chips.map((c) =>
            `<button type="button" class="lobby-stage__quick-reply-chip" data-chip>${escHtml(c)}</button>`
        ).join('');
    el.hidden = false;
    el.querySelectorAll('[data-chip]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const txt = btn.textContent || '';
            if (!txt || !_dom?.input || !_dom?.form) return;
            _dom.input.value = txt;
            hideQuickReply();
            if (typeof _dom.form.requestSubmit === 'function') {
                _dom.form.requestSubmit();
            } else {
                _dom.form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
        });
    });
}

function hideQuickReply() {
    const el = _dom?.quickReply;
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
}

/** Default-state bubble. Reads as the model speaking conversationally
 *  rather than a UI prompt — no buttons, no links, just a line in the
 *  hero's voice.
 *
 *   1. No wallet connected → friendly nudge to connect a wallet so
 *      "we can chat".
 *   2. Wallet connected, prior reply exists → surface the last reply
 *      so the conversation feels continuous across reloads.
 *   3. Wallet connected, fresh session → no bubble (input is ready;
 *      if the user still has no AI model wired, the connect-llm flow
 *      surfaces via the chat error handler when they try to send).
 *
 * Suppressed entirely until the first model swap on the stage has
 * completed — the bubble shouldn't appear over an empty stage during
 * page boot. */
function computeIdleKey() {
    const subjectId = tokenIdOf(_subject) || _subject?.name || 'none';
    const isDefault = !!_subject?._isDefault;
    const w = wallet.getStatus()?.address || '';
    const llmConnected = !!(w && getActiveAccount(w).connected);
    const lastReply = _history.length ? _history[_history.length - 1] : null;
    const lastReplySig = (lastReply?.role === 'assistant')
        ? `${lastReply.ts || ''}:${(lastReply.content || '').slice(0, 60)}`
        : '';
    return `${subjectId}|${isDefault}|${!!w}|${llmConnected}|${lastReplySig}`;
}

function paintIdleBubble() {
    if (!_modelEverShown) return;
    const isDefault = !!_subject?._isDefault;
    const w = wallet.getStatus()?.address || '';
    const acct = w ? getActiveAccount(w) : { connected: false };
    const llmConnected = !!acct.connected;
    const lastReply = _history.length ? _history[_history.length - 1] : null;
    // Compose a signature for the desired bubble state — if it matches
    // the last painted state, skip the work entirely. Boot fires three
    // change-events in quick succession; without this, the same prompt
    // rebuilds three times and reads as a flash.
    const key = computeIdleKey();
    if (key === _lastIdleKey) return;
    _lastIdleKey = key;

    /* Local helper: render the idle text into BOTH the bubble dock AND
     * the Activity-tab chat log. The dock gets it via setBubble (the
     * normal at-character → slide path). The Activity tab gets it via
     * the dexhero:chat-message event the right-wing-activity listener
     * already subscribes to. Without this dual-dispatch, the initial
     * "Give me a brain" / "Welcome back" line was invisible to the
     * Activity panel and could be lost from the dock if the boot
     * sequence preempted it mid-slide. */
    const emit = (text, opts) => {
        if (!text) { setBubble(text, opts); return; }
        setBubble(text, opts);
        try {
            const tokenId = tokenIdOf(_subject) || (_subject?.name || 'default');
            document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
                bubbles: true,
                detail: {
                    tokenId,
                    role: 'assistant',
                    content: text,
                    ts: Date.now(),
                    source: 'idle',
                },
            }));
        } catch {}
    };

    if (isDefault) {
        if (!llmConnected) {
            emit(
                "Give me a brain — pick any AI model in the header to bring me to life.",
                {
                    persistent: true,
                    cta: { label: 'Connect Brain', action: 'dexhero:open-llm-connect' },
                },
            );
            return;
        }
        // Welcome-back greeting when there's prior history; blank
        // input-ready bubble for a fresh session. Don't repeat the
        // last reply — the user can scroll the topic chat / Activity
        // for that. Repeating reads as "the model said the same thing
        // twice."
        emit(
            lastReply ? pickWelcomeBack(_subject) : '',
            { persistent: !!lastReply },
        );
        return;
    }
    if (!w) {
        emit("My brain isn't active yet — try connecting your wallet.", { persistent: true });
        return;
    }
    if (!llmConnected) {
        emit("My brain isn't active yet — try connecting an AI model.", { persistent: true });
        return;
    }
    if (lastReply && lastReply.role === 'assistant') {
        emit(pickWelcomeBack(_subject), { persistent: true });
    } else {
        setBubble('');
    }
}

/** Pick a varied "welcome back" line so a returning user gets a fresh
 *  greeting instead of seeing the same reply that ended the last
 *  session. Keyed by tokenId so the same hero gives the same line
 *  during one page load (avoids re-rolling on every wallet event). */
const _welcomeCache = new Map();
function pickWelcomeBack(subject) {
    const id = subject?.id || subject?.address || subject?.name || 'default';
    const cached = _welcomeCache.get(id);
    if (cached) return cached;
    const lines = subject?._isDefault
        ? [
            'Welcome back to the lobby! Ask me anything.',
            'Back already? Good — I had time to read.',
            'Hey, you returned! What are we building today?',
        ]
        : [
            'Welcome back!',
            'You\'re back — what now?',
            'Good to see you again. Pick up where we left off?',
        ];
    const line = lines[Math.floor(Math.random() * lines.length)];
    _welcomeCache.set(id, line);
    return line;
}

function tokenIdOf(subject) {
    if (!subject) return null;
    if (subject.network === 'create') return null; // CTA placeholder, no brain
    return subject.id || subject.address || null;
}

function reloadHistoryForSubject() {
    const tokenId = tokenIdOf(_subject);
    const w = wallet.getStatus()?.address || '';
    _history = tokenId ? chat.loadHistory(tokenId, w) : [];
    if (_dom?.input) _dom.input.value = '';
    hideQuickReply();
    // Only wipe the stack on actual subject change (different hero).
    // Wallet/LLM toggles fire the same code path but shouldn't blow
    // away an existing reply that the user might still be reading.
    const newSubjectId = tokenId || _subject?.name || null;
    if (newSubjectId !== _lastSubjectId) {
        _lastSubjectId = newSubjectId;
        _lastIdleKey = null;        // force re-evaluation for the new subject
        try { voice.cancel(); } catch {}
        clearBubbleStack();
        // Repaint prior-session history into the dock so the user
        // visually picks up where they left off. Static bubbles, no
        // typewriter or slide animation — they're already-said messages.
        paintHistoryIntoDock();
    }
    paintIdleBubble();
}

/* ── /upgrade slash command ──
 * The dexhero records as part of its NORMAL review-and-answer cycle —
 * no separate "recording" step. Lifecycle:
 *
 *   1. Review + capture BEFORE  (~1.0s)
 *      Bubble: "Reviewing your request…"
 *      Overlay: REC dot + "CAPTURING BEFORE"
 *      The dexhero examines the current UI state — same passive
 *      thinking it would do for any chat reply, but now framed as
 *      simultaneously documenting the starting point.
 *
 *   2. Apply + capture AFTER  (~1.4s)
 *      Bubble: "Applying changes…"
 *      Overlay: REC dot + "CAPTURING AFTER"
 *      The patch is applied to the live lobby via applyPreview so the
 *      user actually SEES the change happen. After the after-frame is
 *      captured, the preview is cleared (the change isn't committed
 *      until the user clicks Save on the proposal card).
 *
 *   3. Present  (immediate)
 *      Bubble: "Done. Review the proposal in the chat log."
 *      Proposal card lands embedding the captured BEFORE/AFTER material.
 *
 * Stage A uses canned patterns + SVG-rendered before/after frames; the
 * "captures" are wall-clock pauses with overlay state changes. Stage B
 * swaps in real MediaRecorder snapshots of the live DOM. */
function _setRecordingOverlay(active, { dexheroName, phase } = {}) {
    const subjectEl = document.getElementById('lobby-stage-subject');
    if (!subjectEl) return;
    let overlay = subjectEl.querySelector('.dexhero-rec-overlay');
    if (!active) {
        if (overlay) {
            overlay.classList.remove('is-active');
            document.body.removeAttribute('data-dexhero-recording');
            document.body.removeAttribute('data-dexhero-rec-phase');
            setTimeout(() => { try { overlay.remove(); } catch {} }, 260);
        }
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'dexhero-rec-overlay';
        overlay.innerHTML = `
            <span class="dexhero-rec-overlay__dot"></span>
            <span class="dexhero-rec-overlay__label" data-rec-label>REC</span>
            <span class="dexhero-rec-overlay__sub" data-rec-sub></span>
        `;
        subjectEl.appendChild(overlay);
    }
    const label = overlay.querySelector('[data-rec-label]');
    const sub   = overlay.querySelector('[data-rec-sub]');
    if (label) label.textContent = phase === 'after' ? 'CAPTURING AFTER' : phase === 'before' ? 'CAPTURING BEFORE' : 'REC';
    if (sub)   sub.textContent   = dexheroName || 'DexHero';
    requestAnimationFrame(() => overlay.classList.add('is-active'));
    document.body.setAttribute('data-dexhero-recording', 'true');
    document.body.setAttribute('data-dexhero-rec-phase', phase || 'before');
}

/* ── Real DOM capture pipeline (Stage B of /upgrade) ─────────────
 *
 * The dexhero genuinely records the lobby's before+after via html-to-image
 * (lazy-loaded the first time /upgrade fires) → offscreen canvas →
 * canvas.captureStream + MediaRecorder. The resulting WebM blob is stored
 * in IndexedDB keyed by patchId and surfaced to the demo-video component
 * via a "demo_url" sentinel + a `dexhero:demo-ready` event for late
 * arrivals.
 *
 * Latency: the chat-loop timers (1.0s + 1.4s) stay authoritative — the
 * capture promise runs concurrently. If the blob isn't ready when the
 * proposal card mounts, the card mounts with the SVG mock and upgrades
 * to <video> via the event when ready.
 *
 * Fallback: if MediaRecorder, canvas.captureStream, or html-to-image
 * isn't available, _captureRegion returns null and the proposal card
 * keeps the SVG mock for that patch. No regression.
 */
let _htmlToImageMod = null;
async function _ensureHtmlToImage() {
    if (_htmlToImageMod) return _htmlToImageMod;
    try {
        _htmlToImageMod = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/+esm');
    } catch (err) {
        console.warn('[capture] html-to-image load failed:', err?.message || err);
        _htmlToImageMod = null;
    }
    return _htmlToImageMod;
}

async function _captureRegion(el, durationMs) {
    if (!el) return null;
    if (typeof window.MediaRecorder === 'undefined') return null;
    if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
    const htmlToImage = await _ensureHtmlToImage();
    if (!htmlToImage || typeof htmlToImage.toCanvas !== 'function') return null;

    const rect = el.getBoundingClientRect();
    // Cap the capture region at 320×220 to keep per-frame DOM-to-canvas
    // cheap. The output reads as a recording even at this resolution.
    const w = Math.min(320, Math.max(120, Math.floor(rect.width  || 320)));
    const h = Math.min(220, Math.max(80,  Math.floor(rect.height || 220)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let stream;
    try { stream = canvas.captureStream(15); } catch { return null; }
    let recorder;
    const mimeTry = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const mt of mimeTry) {
        try {
            if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mt)) continue;
            recorder = new MediaRecorder(stream, { mimeType: mt });
            break;
        } catch {}
    }
    if (!recorder) { try { recorder = new MediaRecorder(stream); } catch { return null; } }

    const chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const blobPromise = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
        recorder.onerror = () => resolve(null);
    });

    try { recorder.start(); } catch { return null; }
    const start = Date.now();
    const frameInterval = 110;   // ~9fps; html-to-image per frame is the bottleneck
    let stopped = false;
    async function tick() {
        if (stopped) return;
        if (Date.now() - start >= durationMs) {
            stopped = true;
            try { recorder.stop(); } catch {}
            return;
        }
        try {
            // skipFonts: true bypasses external stylesheet inlining (CSP).
            // filter: skip <canvas>/<video>/<iframe>/external <img> which
            // html-to-image can't safely serialize into its inline SVG.
            // The captured frame still shows panels + text overlays, which
            // is what visually CHANGES under a typical UI patch.
            const fc = await htmlToImage.toCanvas(el, {
                width: w, height: h,
                pixelRatio: 1,
                cacheBust: false,
                skipFonts: true,
                imagePlaceholder: 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22/>',
                filter: (node) => {
                    if (!node || !node.tagName) return true;
                    const t = node.tagName;
                    if (t === 'CANVAS' || t === 'VIDEO' || t === 'IFRAME') return false;
                    if (t === 'IMG' && node.src && !node.src.startsWith('data:')) {
                        const u = node.src;
                        // Allow same-origin only
                        if (!u.startsWith(location.origin) && !u.startsWith('/')) return false;
                    }
                    return true;
                },
            });
            if (fc) ctx.drawImage(fc, 0, 0, w, h);
        } catch {
            // Skip frame; html-to-image can reject under strict CSP or on
            // complex DOM. We tolerate it — if too few frames land, the
            // min-blob-bytes guard below skips the demo upgrade entirely.
        }
        setTimeout(tick, frameInterval);
    }
    tick();
    return await blobPromise;
}

async function handleUpgradeIntent(userText) {
    // Surface the user's message in both the dock + the chat log first
    // so the conversation reads continuously.
    addUserBubble(`/upgrade ${userText}`);
    const subjectId = tokenIdOf(_subject) || 'lobby';
    const dexheroName = _subject?.name || 'Your DexHero';
    document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
        bubbles: true,
        detail: { tokenId: subjectId, role: 'user', content: `/upgrade ${userText}`, ts: Date.now() },
    }));

    // We need the patch payload UP FRONT so the after-capture phase can
    // actually apply it to the live lobby. Lift the proposal generation
    // out of the way first.
    let proposal;
    let upgradesModule;
    try {
        upgradesModule = await import('../services/upgrades-mock.js');
        proposal = upgradesModule.generateMockProposal(userText);
        if (proposal.kind === 'proposal') {
            proposal.patch = upgradesModule.attachDemoVideo(proposal.patch, {
                dexheroName,
                caption: proposal.patch.description,
            });
        }
    } catch (err) {
        setBubble("Couldn't load the upgrades engine — try again in a sec.");
        return;
    }

    if (proposal.kind === 'refusal') {
        // Manifest-violation refusal — no recording happens (nothing to
        // demonstrate). Just deliver the in-character refusal.
        setBubble(proposal.message, { persistent: true });
        document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
            bubbles: true,
            detail: { tokenId: subjectId, role: 'assistant', content: proposal.message, ts: Date.now() },
        }));
        return;
    }

    // Lazy-import the patch applier so the AFTER phase can apply the
    // change to the live lobby briefly. The user actually SEES the
    // patch happen — that's the proof the after-frame is real.
    let applier = null;
    try { applier = await import('../services/patch-applier-mock.js'); } catch {}

    // Region to capture: try the model wrapper first (where the REC
    // overlay sits) and fall back to the whole lobby stage if missing.
    // This is the visual evidence the dexhero "saw".
    const captureEl = document.getElementById('lobby-stage') || document.getElementById('lobby-stage-subject');

    // ── Phase 1: Review + capture BEFORE ──
    // Kick off the actual recording IN PARALLEL with the wall-clock timer
    // so the timer (1.0s) stays authoritative and the recording can't
    // stretch the chat loop. _captureRegion resolves to a Blob (or null).
    setBubble('Reviewing your request…', { persistent: true });
    _setRecordingOverlay(true, { dexheroName, phase: 'before' });
    const beforeCapture = _captureRegion(captureEl, 1000).catch(() => null);
    await new Promise((r) => setTimeout(r, 1000));

    // ── Phase 2: Apply + capture AFTER ──
    setBubble('Applying changes…', { persistent: true });
    _setRecordingOverlay(true, { dexheroName, phase: 'after' });
    if (applier?.applyPreview) {
        try { applier.applyPreview(proposal.patch); } catch {}
    }
    const afterCapture = _captureRegion(captureEl, 1400).catch(() => null);
    await new Promise((r) => setTimeout(r, 1400));
    if (applier?.clearPreview) {
        try { applier.clearPreview(); } catch {}
    }
    _setRecordingOverlay(false);

    // ── Phase 3: Present ──
    setBubble(`Done. Review the proposal in the chat log — captured before & after.`);
    document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
        bubbles: true,
        detail: {
            tokenId: subjectId,
            role: 'assistant',
            kind: 'upgrade-proposal',
            content: proposal.patch.title,
            proposal: proposal.patch,
            ts: Date.now(),
        },
    }));

    // Mount the proposal card directly into the bubble dock so the user
    // sees the social-style artifact where they were already looking. The
    // legacy listener in stage-chat-log.js no longer fires (that panel
    // is deprecated), so we render the card inline here.
    try {
        const { buildProposalCard } = await import('./upgrade-proposal-card.js');
        const card = buildProposalCard({ kind: 'proposal', patch: proposal.patch });
        if (card) {
            // Wrap the card in a bubble-item shell so the dock's column
            // layout treats it like any other chat message.
            const wrap = document.createElement('div');
            wrap.className = 'lobby-stage__bubble-item lobby-stage__bubble-item--proposal';
            wrap.appendChild(card);
            const dock = _dom?.bubble;
            if (dock) {
                dock.insertBefore(wrap, dock.firstChild);
                capBubbleStack();
                dock.hidden = false;
                document.body.setAttribute('data-bubble-revealed', 'true');
            }
        }
    } catch (err) {
        console.warn('[upgrade] proposal-card mount failed:', err?.message || err);
    }

    // Persist whatever the recorder actually produced. If both BEFORE
    // and AFTER blobs landed, set demo_url on the patch and broadcast
    // dexhero:demo-ready so any already-mounted demo card swaps its
    // SVG panes for <video>. This runs AFTER the proposal card has
    // mounted, so the user never waits longer than the existing 2.4s
    // chat-loop timing.
    Promise.all([beforeCapture, afterCapture]).then(async ([beforeBlob, afterBlob]) => {
        // Minimum viable blob size — a successful WebM with at least one
        // decoded frame is reliably > 4KB. Smaller means MediaRecorder
        // produced just the container header (every html-to-image frame
        // rejected, typically under CSP or complex-DOM serialization
        // issues). Treat as a failed capture and leave the SVG mock.
        const MIN_BLOB_BYTES = 4096;
        if (!beforeBlob || !afterBlob) return;
        if (beforeBlob.size < MIN_BLOB_BYTES || afterBlob.size < MIN_BLOB_BYTES) return;
        const patchId = proposal.patch?.id;
        if (!patchId) return;
        try {
            const okBefore = await upgradesModule._storeBlob(patchId, 'before', beforeBlob);
            const okAfter  = await upgradesModule._storeBlob(patchId, 'after',  afterBlob);
            if (!okBefore || !okAfter) return;
            proposal.patch.demo_url = `idb:${patchId}`;
            document.dispatchEvent(new CustomEvent('dexhero:demo-ready', {
                bubbles: true,
                detail: { patchId, demoUrl: `idb:${patchId}` },
            }));
        } catch (err) {
            console.warn('[capture] persist failed:', err?.message || err);
        }
    });
}

async function onSubmit(ev) {
    ev.preventDefault();
    if (_inFlight) return;
    const text = (_dom?.input?.value || '').trim();
    if (!text) return;
    // Clear the input IMMEDIATELY on submit — the user shouldn't have
    // to see their just-sent text sitting in the field while they wait
    // for a reply. Frees them to type the next message right away.
    if (_dom?.input) _dom.input.value = '';
    // Clear any stale quick-reply chips from the prior turn so the
    // user isn't looking at the wrong options while their new message
    // streams up to the model.
    hideQuickReply();
    // Cut off any voice still speaking the previous reply — the user
    // is moving on, the model shouldn't be heard finishing a stale
    // thought over their new message.
    try { voice.cancel(); } catch {}

    // ── IDE-mode forwarding ──
    // When the user has an active IDE session (kicked off via `/ide`),
    // EVERY typed line — including bare prose like "make the chat
    // overlay corners more rounded" — routes to the agent instead of
    // the regular dexhero brain. /apply, /iterate, /exit are handled
    // inside tryHandleIdeInput. Only /ide itself (to surface "already
    // active" or starting a new one) falls through to the slash bus.
    if (text !== '/ide') {
        try {
            const ide = await import('./chat-commands.js');
            if (ide.isIdeActive?.()) {
                await ide.tryHandleIdeInput(text, { onReply: (reply) => setBubble(reply) });
                return;
            }
        } catch { /* fall through to regular chat */ }
    }

    // ── Slash-command bus ──
    // Commands that start with `/` are intercepted before they ever
    // reach the LLM. Each command short-circuits the chat-send path,
    // dispatches its own event, and shows a brief in-character bubble
    // so the user knows it was understood. Add new commands here.
    if (text.startsWith('/')) {
        const m = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
        const cmd = m ? m[1].toLowerCase() : '';
        const arg = m && m[2] ? m[2].trim() : '';
        if (cmd === 'todo') {
            if (!arg) {
                setBubble("Usage: /todo <your task>. The To-Do tab on the right shows the list.");
                return;
            }
            document.dispatchEvent(new CustomEvent('dexhero:add-todo', {
                bubbles: true, detail: { text: arg },
            }));
            setBubble(`Added to your to-do list: ${arg}`);
            return;
        }
        if (cmd === 'addtopic') {
            if (!arg) {
                setBubble("Usage: /addtopic <name>. The Topics tab on the right shows the list.");
                return;
            }
            document.dispatchEvent(new CustomEvent('dexhero:add-topic', {
                bubbles: true, detail: { text: arg },
            }));
            setBubble(`Added to your topics: ${arg}`);
            return;
        }
        if (cmd === 'upgrade') {
            // /upgrade <description>
            // The dexhero generates a candidate UI patch and posts it as
            // a proposal card in the chat. The user can Preview, Commit
            // (instant push to their branch + community feed), or Discard.
            // Stage A uses a canned generator; Stage C swaps in the real
            // brain via the propose_ui_patch tool.
            if (!arg) {
                setBubble("Usage: /upgrade <describe what you want to change>. Example: /upgrade make popups darker.");
                return;
            }
            handleUpgradeIntent(arg);
            return;
        }
        // Cradle session commands — /play, /stop, /games, /workers,
        // /pair. Owner triggers their dexhero to play a registered
        // game; opens the stream-view panel; uses the owner's BYOK
        // LLM key via the vault. See app/ui/chat-commands.js.
        if (['play', 'stop', 'games', 'workers', 'pair', 'ide', 'apply', 'iterate', 'exit'].includes(cmd)) {
            try {
                const cmds = await import('./chat-commands.js');
                await cmds.tryHandleSlash(text, { onReply: (reply) => setBubble(reply) });
            } catch (err) {
                setBubble(`Cradle command failed: ${err?.message || err}`);
            }
            return;
        }
        // Unknown slash command — surface a hint rather than passing
        // garbage to the LLM. Update this list whenever a new command
        // lands above.
        setBubble(`Unknown command: /${cmd}. Try /todo <task>, /addtopic <name>, /upgrade <change>, /play <game>, /stop, /games, /workers, /pair.`);
        return;
    }

    const tokenId = tokenIdOf(_subject);
    if (!tokenId) {
        // Defensive — the input shouldn't be enabled for the create-CTA placeholder.
        setBubble('Mint a DexHero first — I need a body before I can speak.');
        return;
    }

    _inFlight = true;
    if (_dom?.form) _dom.form.setAttribute('aria-busy', 'true');
    // User's message goes into the dock first (right side, single-line
    // chat-dialog entry) — Truffle's reply prepends ON TOP of it once
    // it lands, so reading the dock top-down gives the conversation
    // in newest-first order: AI reply, user msg, prior AI reply, …
    addUserBubble(text);
    setBubble('', { loading: true });

    const w = wallet.getStatus()?.address || '';
    const sentHistory = _history.slice();

    // Fire the user message into the chat log immediately so it appears
    // while the assistant is still "thinking" — same UX as Claude/ChatGPT
    // where the user line lands before the reply streams in.
    document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
        bubbles: true,
        detail: { tokenId, role: 'user', content: text, ts: Date.now() },
    }));
    document.dispatchEvent(new CustomEvent('dexhero:chat-thinking', {
        bubbles: true,
        detail: { tokenId, thinking: true },
    }));

    try {
        // Platform-default subjects (Truffle Man) skip the vault entirely.
        // Sending a chat to Truffle shouldn't trigger any wallet signature
        // prompt — even when the user has a previously-saved LLM account
        // in the vault, decrypting it for a Truffle reply is pointless
        // because the server 402s anonymous-key Truffle chats. The bubble
        // surfaces the 402's "Give me a brain" copy via the error handler.
        const result = await chat.sendMessageStream(
            tokenId, text, sentHistory, w,
            { skipVault: !!_subject?._isDefault },
            (delta) => appendDelta(delta),
        );
        const reply = (result?.response || '').trim() || '…';
        const nowU = Date.now();
        const nowA = Date.now();
        _history = [
            ...sentHistory,
            { role: 'user',      content: text,  ts: nowU },
            { role: 'assistant', content: reply, ts: nowA },
        ];
        chat.saveHistory(tokenId, w, _history);
        // Resync the idle-paint key so the very next wallet/llm event
        // (which would otherwise see "the desired state differs from
        // what was last idle-painted") doesn't re-prepend a duplicate
        // copy of this reply on top of the bubble we just showed.
        _lastIdleKey = computeIdleKey();
        // Capture spill state BEFORE finalize resets it — used below to
        // suppress the duplicate chat-message dispatch when the spill
        // already rendered the reply in the Activity tab.
        const wasSpilledTurn = _streamSpilled;
        // If streaming morphed the dots bubble already, finalize it.
        // Otherwise (no deltas — error before stream, or empty reply)
        // fall through to setBubble which uses the typewriter on the
        // still-pending dots node.
        if (_streamItem || _streamHasStarted) {
            finalizeStreamingBubble(reply);
        } else {
            setBubble(reply);
        }
        // Speak the reply aloud — Web Speech API + the wallet's chosen
        // voice profile (Jarvis by default for new users). No-op when
        // muted or when the browser has no SpeechSynthesis.
        try { voice.speak(reply, voice.getCachedPresetId(tokenId)); } catch {}
        // Surface quick-reply chips for questions / option lists.
        paintQuickReply(reply);
        document.dispatchEvent(new CustomEvent('dexhero:chat-thinking', {
            bubbles: true,
            detail: { tokenId, thinking: false },
        }));
        // First successful reply flips Truffle (and every DexHero) from
        // "blank" → "awake". The body controller's procedural reactive
        // layer (head tilt while listening, lean + bob on reply) only
        // fires while awake — pre-LLM the body just plays its baked
        // Idle clip and otherwise stays still. The wake-up is sticky
        // for this session.
        document.dispatchEvent(new CustomEvent('dexhero:body-action', {
            bubbles: true,
            detail: { action: 'wake_up' },
        }));
        // Suppress the assistant chat-message dispatch when the spill
        // pipeline already handled this reply — the Activity panel
        // would otherwise render the same response twice (once from
        // the spill entry, once from this event).
        if (!wasSpilledTurn) {
            document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
                bubbles: true,
                detail: { tokenId, role: 'assistant', content: reply, ts: Date.now() },
            }));
        }
    } catch (err) {
        // Drop any partial streaming bubble first so the error refusal
        // doesn't render next to half a sentence Truffle never finished.
        abandonStreamingBubble();
        // Map known error codes to in-character refusals so the bubble
        // never breaks the workshop vibe.
        const code = err?.body?.error || err?.message || '';
        if (code === 'connect_llm_account') {
            // No AI model connected yet. Prefer the in-character copy
            // the server returned so we can tune the wording centrally
            // (the platform-default Truffle Man's line, for example).
            const ln = err?.body?.response
                || "Give me a brain — pick any AI model in the header to bring me to life.";
            setBubble(ln, { persistent: true });
            document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
                bubbles: true,
                detail: { tokenId, role: 'assistant', content: ln, ts: Date.now(), error: true },
            }));
            return;
        }
        if (code === 'vault_locked' || code === 'wallet_not_connected' || code === 'signature_rejected') {
            // Wallet not connected, or the user said no to the one-time
            // sign-in signature that authenticates them. Either way the
            // server can't return their stored API key. In-character refusal.
            const ln = code === 'signature_rejected'
                ? "I need you to sign in once with your wallet so I can use your AI key."
                : "I lost track of your wallet — reconnect it so I can use your AI key.";
            setBubble(ln, { persistent: true });
            document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
                bubbles: true,
                detail: { tokenId, role: 'assistant', content: ln, ts: Date.now(), error: true },
            }));
            return;
        }
        let line;
        const upstream = err?.body?.upstream_message || '';
        if (code === 'not_owner')                       line = "Only my owner can speak with me right now.";
        else if (code === 'wallet_required')            line = "Connect a wallet first — then we can talk.";
        else if (code === 'daily_brain_budget_reached') line = err?.body?.response || "I'm out of breath for today — come back tomorrow.";
        else if (code === 'brain_not_configured')       line = "My brain isn't wired in yet. Connect an LLM account.";
        else if (code === 'user_llm_key_invalid_format') line = "That API key doesn't look right. Reconnect your account.";
        // Upstream-provider failures — these are the actual reasons most
        // chat attempts fail. Surface specific causes so the user knows
        // exactly what to fix (top up credits, reconnect with a fresh key,
        // wait out a rate limit, switch model).
        else if (code === 'upstream_credit_low')        line = "Your API account is out of credits — top up at your provider's billing page to keep chatting.";
        else if (code === 'upstream_unauthorized')      line = "That API key was rejected. Reconnect with a fresh key.";
        else if (code === 'upstream_rate_limit')        line = "You're sending messages faster than your provider allows. Give it a few seconds.";
        // upstream_forbidden / upstream_model_unavailable are handled by
        // the client-side auto-fallback in dexhero-chat.js (it walks the
        // provider's model list); only when every model on the provider
        // rejects do we land here, which usually means the account
        // doesn't have billing / API access enabled.
        else if (code === 'upstream_no_models_available') line = "No model on your provider account would accept this request. Most often that means billing or API access isn't enabled yet — check your provider's console.";
        else if (code === 'upstream_forbidden')         line = "Your provider account doesn't have access to this model. Switch model in the Brain picker.";
        else if (code === 'upstream_model_unavailable') line = "That model isn't on your provider account. Switch model in the Brain picker.";
        else if (code === 'upstream_error')             line = upstream ? `Provider error: ${upstream}` : "Your AI provider returned an error. Try once more.";
        else                                            line = "My brain stuttered. Try once more.";
        setBubble(line);
        // Mirror the in-character refusal into the chat log so the
        // user sees one continuous conversation, not a half-finished
        // exchange where their message has no reply line.
        document.dispatchEvent(new CustomEvent('dexhero:chat-message', {
            bubbles: true,
            detail: { tokenId, role: 'assistant', content: line, ts: Date.now(), error: true },
        }));
    } finally {
        _inFlight = false;
        if (_dom?.form) _dom.form.removeAttribute('aria-busy');
        // Make sure the typing indicator is always cleared, even on
        // error paths that returned early via setBubble + return.
        document.dispatchEvent(new CustomEvent('dexhero:chat-thinking', {
            bubbles: true,
            detail: { tokenId, thinking: false },
        }));
    }
}

/* ─── Proactive-tick surfacing ────────────────────────────────────
 *
 * The server-side `lib/proactive-tick.js` runs every 5 min per token
 * and writes a row to `dexhero_activity_log` (source=proactive,
 * kind=thought). The Activity tab in the right wing already paints
 * these as feed rows, but that's a passive list — Truffle is supposed
 * to feel ALIVE, so we also surface each new proactive thought as a
 * speaking bubble emanating from his head.
 *
 * One poll per centered hero. `since` is set to the latest seen
 * occurred_at so only NEW thoughts spawn bubbles. On hero swap we
 * reset and the next poll's since defaults to "now" so the user
 * doesn't get a flood of historical bubbles.
 */

const PROACTIVE_POLL_MS = 30_000;
let _proactivePollTimer = null;
let _proactiveSinceIso = null;
let _proactivePollSubjectId = null;

function _restartProactivePoll() {
    if (_proactivePollTimer) { clearInterval(_proactivePollTimer); _proactivePollTimer = null; }
    _proactiveSinceIso = new Date().toISOString();   // only NEW from now
    _proactivePollSubjectId = tokenIdOf(_subject);
    if (!_proactivePollSubjectId) return;
    const pollOnce = async () => {
        const tokenId = tokenIdOf(_subject);
        if (!tokenId || tokenId !== _proactivePollSubjectId) return;
        try {
            const url = `/api/dexhero/${encodeURIComponent(tokenId)}/activity` +
                `?since=${encodeURIComponent(_proactiveSinceIso)}&limit=10`;
            const r = await fetch(url, { credentials: 'omit' });
            if (!r.ok) return;
            const { entries } = await r.json();
            if (!Array.isArray(entries) || !entries.length) return;
            // Sort oldest → newest so multiple new ticks render in
            // order. Advance the since cursor past the last entry.
            const fresh = entries
                .slice()
                .reverse()
                .filter((e) => e?.source === 'proactive' && typeof e.summary === 'string' && e.summary.trim());
            for (const e of fresh) {
                // Only render real "thought" / "observation" / "reply"
                // kinds — skip "rest" (silent ticks) and "error".
                if (e.kind === 'rest' || e.kind === 'error') continue;
                setBubble(e.summary);
                _proactiveSinceIso = e.occurred_at || _proactiveSinceIso;
            }
            // Advance even when filtered fresh is empty so the same
            // skipped rows don't replay on the next poll.
            const last = entries[0];
            if (last?.occurred_at && last.occurred_at > _proactiveSinceIso) {
                _proactiveSinceIso = last.occurred_at;
            }
        } catch (err) {
            // Network blips are expected; silent retry next interval.
        }
    };
    _proactivePollTimer = setInterval(pollOnce, PROACTIVE_POLL_MS);
    // Also kick a poll right after a short delay so a user landing on
    // an active DexHero sees recent ticks within seconds, not minutes.
    setTimeout(pollOnce, 1500);
}

function syncInputEnabled() {
    if (!_dom?.input) return;
    // Input stays enabled regardless — slash commands like /todo work
    // without a centered hero. Sending plain text without a hero is
    // caught in onSubmit and surfaces a "mint a hero first" bubble.
    _dom.input.disabled = false;
    _dom.input.placeholder = 'Speak to your DexHero…';
}

/** Wire the chat input + bubble to the existing DOM nodes in index.html.
 *  Call once at app boot — idempotent. */
export function initStageChat() {
    if (_dom) return; // already wired

    _dom = {
        form:        document.getElementById('lobby-stage-chat'),
        input:       document.getElementById('lobby-stage-chat-input'),
        bubble:      document.getElementById('lobby-stage-bubble'),
        quickReply:  document.getElementById('lobby-stage-quick-reply'),
        voiceToggle: document.getElementById('lobby-stage-voice-toggle'),
    };
    if (!_dom.form || !_dom.input || !_dom.bubble) {
        _dom = null;
        return;
    }

    /* Bubble title strip — three tabs: Activity (the bubble dock
     * itself — chat replies + proactive ticks together), To-Do,
     * Topics. Clicking a title swaps `body[data-active-pane]` so the
     * matching wing panel becomes visible. The right wing is always
     * uncollapsed unless the user explicitly toggles it shut with
     * the arrow button (see app/stage.js _toggleRightWing). */
    const titlesEl = document.getElementById('lobby-stage-bubble-titles');
    if (titlesEl) {
        const setActive = (target) => {
            titlesEl.querySelectorAll('.lobby-stage__bubble-title').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-bubble-tab') === target);
            });
            document.body.setAttribute('data-active-pane', target);
            const rightWing = document.getElementById('lobby-wing-right');
            if (rightWing) {
                rightWing.querySelectorAll('[data-tab-panel]').forEach((p) => {
                    p.hidden = p.getAttribute('data-tab-panel') !== target;
                });
            }
        };
        titlesEl.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-bubble-tab]');
            if (!btn) return;
            const target = btn.getAttribute('data-bubble-tab');
            if (target) setActive(target);
        });
        // Initial sync — Activity by default per the new markup.
        const initial = titlesEl.querySelector('.lobby-stage__bubble-title.is-active')?.getAttribute('data-bubble-tab') || 'activity';
        setTimeout(() => setActive(initial), 0);
    }

    /* Chat-log expand toggle — sits inside the chat form. Toggles the
     * floating chat overlay (#lobby-chat-overlay), which holds the chat
     * log on top and the chat input on the bottom as one movable +
     * resizable container.
     *
     * On open: DOM-moves the chat form (#lobby-stage-chat) from its
     * default bottom-of-stage slot into the overlay's footer slot, and
     * sets body.is-chat-overlay-open so the original slot's wrapper
     * collapses (no visible empty bar). The overlay's close button +
     * this button both toggle the state.
     *
     * On close: moves the form back, restores body class, hides overlay. */
    const expandBtn = document.getElementById('lobby-stage-chat-expand');
    const overlay   = document.getElementById('lobby-chat-overlay');
    const overlayFormSlot = overlay?.querySelector('[data-chat-overlay-form-mount]');
    const overlayClose = document.getElementById('lobby-chat-overlay-close');
    const chatForm  = _dom.form;          // the form node we MOVE
    const formHome  = chatForm?.parentElement;   // remember the default parent

    if (expandBtn && overlay && overlayFormSlot && chatForm && formHome) {
        // Insert an invisible placeholder comment node next to the form so
        // we can restore the form to its EXACT original DOM position on
        // close (appendChild would put it at the end of its siblings).
        const placeholder = document.createComment('chat-form-home');
        formHome.insertBefore(placeholder, chatForm);

        const syncExpandState = (open) => {
            expandBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            const label = open ? 'Hide chat log' : 'Show chat log';
            expandBtn.title = label;
            expandBtn.setAttribute('aria-label', label);
        };
        const openOverlay = () => {
            if (!overlay.hidden) return;
            overlayFormSlot.appendChild(chatForm);
            overlay.hidden = false;
            document.body.classList.add('is-chat-overlay-open');
            syncExpandState(true);
            // Focus the input so the user can start typing immediately.
            _dom.input?.focus();
        };
        const closeOverlay = () => {
            if (overlay.hidden) return;
            // Restore the form to its original position (right before
            // the placeholder marker we left in formHome).
            placeholder.parentNode?.insertBefore(chatForm, placeholder);
            overlay.hidden = true;
            document.body.classList.remove('is-chat-overlay-open');
            syncExpandState(false);
        };
        syncExpandState(false);
        expandBtn.addEventListener('click', () => {
            if (overlay.hidden) openOverlay();
            else                closeOverlay();
        });
        overlayClose?.addEventListener('click', closeOverlay);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.hidden) closeOverlay();
        });
    }

    /* Voice mute toggle — first click on Send already satisfies any
     * autoplay-gesture restriction so TTS plays freely from there. */
    if (_dom.voiceToggle) {
        _dom.voiceToggle.setAttribute('aria-pressed', voice.isMuted() ? 'true' : 'false');
        _dom.voiceToggle.title = voice.isMuted() ? 'Unmute voice' : 'Mute voice';
        _dom.voiceToggle.addEventListener('click', () => {
            const muted = voice.toggleMuted();
            _dom.voiceToggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
            _dom.voiceToggle.title = muted ? 'Unmute voice' : 'Mute voice';
        });
    }

    document.addEventListener('dexhero:voice-muted-changed', () => {
        if (!_dom.voiceToggle) return;
        const m = voice.isMuted();
        _dom.voiceToggle.setAttribute('aria-pressed', m ? 'true' : 'false');
        _dom.voiceToggle.title = m ? 'Unmute voice' : 'Mute voice';
    });

    _dom.form.addEventListener('submit', onSubmit);

    // Subscribe to centered-hero changes. The stage always emits
    // STAGE_SUBJECT once items load, so this populates _subject before
    // the user has any reason to type.
    _unsubs.push(on(E.STAGE_SUBJECT, (subject) => {
        _subject = subject || null;
        reloadHistoryForSubject();
        syncInputEnabled();
        _restartProactivePoll();
    }));

    // Wallet swap re-keys the localStorage history. Reload so the
    // displayed conversation matches the new viewer's identity.
    _unsubs.push(on(E.WALLET_CHANGED, () => {
        reloadHistoryForSubject();
        syncInputEnabled();
    }));

    // The LLM connect modal fires this after a successful Save (or
    // Disconnect). Refresh the bubble + input state so the user can
    // chat without a manual reload.
    document.addEventListener('dexhero:llm-account-changed', () => {
        reloadHistoryForSubject();
        syncInputEnabled();
    });
    // Vault unlock from any surface (modal, chat-send retry) → refresh
    // the bubble so a stale "Unlock Vault" CTA goes away.
    document.addEventListener('dexhero:vault-unlocked', () => {
        paintIdleBubble();
    });

    // Wait for the FIRST model to actually be VISIBLE on stage before
    // allowing the bubble to paint. Three-step gate:
    //   1. We must have observed data-swapping="true" at least once
    //      (i.e. a real model swap actually started). This filters out
    //      spurious mutations from sibling code appending elements to
    //      the subject (e.g. the annotations overlay).
    //   2. data-swapping is then removed → swap animation finished, the
    //      new content (model-viewer / img / sprite / letter) is in
    //      the slot.
    //   3. The actual content has loaded — for <model-viewer> we wait
    //      for its `load` event (GLB decoded), for <img> we wait for
    //      image.load. Sprite/letter fallbacks have no load event so
    //      the swap-finish IS the visible signal.
    // Safety net: 4s timeout unblocks even if a GLB never decodes.
    const subjectEl = document.getElementById('lobby-stage-subject');
    if (subjectEl) {
        let sawSwapping = false;
        let attached = false;
        const onReady = () => {
            if (_modelEverShown) return;
            _modelEverShown = true;
            try { mo.disconnect(); } catch {}
            paintIdleBubble();
        };
        const mo = new MutationObserver(() => {
            const swapping = subjectEl.getAttribute('data-swapping') === 'true';
            if (swapping) { sawSwapping = true; return; }
            // Swap-finish branch — only valid AFTER we've seen a swap.
            if (!sawSwapping || attached) return;
            const mv  = subjectEl.querySelector('model-viewer');
            const img = subjectEl.querySelector('img');
            if (mv) {
                attached = true;
                if (mv.loaded) onReady();
                else mv.addEventListener('load', onReady, { once: true });
            } else if (img) {
                attached = true;
                if (img.complete && img.naturalWidth > 0) onReady();
                else img.addEventListener('load', onReady, { once: true });
            } else {
                attached = true;
                onReady();
            }
        });
        mo.observe(subjectEl, {
            attributes: true,
            attributeFilter: ['data-swapping'],
            childList: true,
        });
        setTimeout(onReady, 4000);
    } else {
        _modelEverShown = true;
    }

    syncInputEnabled();
    // NOTE: no initial paintIdleBubble() here. The MutationObserver
    // above triggers it once the model is visibly in place.
}
