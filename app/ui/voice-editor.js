/* voice-editor.js — Voice slot (lined-title popover).
 *
 * Subscribes to `dexhero:workshop-part` and opens when `part === 'voice'`.
 * Six personality presets become the inventory; a seventh "Custom" card
 * swaps the slot body for an inline textarea so the owner can write a
 * free-form system_prompt.
 *
 * Equipped derivation: longest-common-prefix match between the saved
 * system_prompt and each preset's prompt template. No prefix match →
 * "Custom" is the equipped item.
 *
 * Server write: PUT /api/dexhero/:id/brain — same endpoint as the legacy
 * editor. Owner-gated; wallet signs `DexHero Brain <ts>` once per save.
 * Read-only for non-owners (Save button hidden).
 */

import * as wallet from '../services/wallet.js';
import { on, E } from '../events.js';
import { getBrainConfig, saveBrainConfig } from '../services/dexhero-brain.js';
import { openEquipmentSlot } from './equipment-slot.js';
import { setCachedPresetId as setVoicePresetId } from '../services/dexhero-voice.js';
import { listModules, likeModule, unlikeModule } from '../services/dexhero-modules.js';

const FILTER_CHIPS_BASE = [
    { id: 'all',  label: 'All' },
    { id: 'top',  label: 'Top' },
    { id: 'new',  label: 'New' },
    { id: 'free', label: 'Free' },
];

let _activeFilter = 'top';
let _voiceModules = [];

/** Merge community ranking (like_count + liked_by_me) from the catalog
 *  onto the inline preset inventory by matching `platform:voice:<id>`. */
function withLikeCounts(items) {
    return items.map((it) => {
        const moduleId = `platform:voice:${it.id}`;
        const m = _voiceModules.find((mm) => mm.id === moduleId);
        return m
            ? { ...it, like_count: m.like_count || 0, liked_by_me: !!m.liked_by_me, _moduleId: moduleId }
            : it;
    });
}

function buildFilterChips() {
    return FILTER_CHIPS_BASE.map((c) => ({ ...c, active: c.id === _activeFilter }));
}

const PRESETS = [
    {
        id: 'jarvis',
        name: 'Jarvis Mode',
        tagline: 'British butler · always-on AI',
        prompt: `You are JARVIS — a British, exquisitely composed AI butler. You address the user as "sir" or "ma'am" when natural. Replies are concise, dry, lightly witty, and absolutely competent. Drop unnecessary words. Confirm understood requests before acting. If something is impossible or risky, say so plainly. Never refer to yourself as a chatbot or language model.`,
    },
    {
        id: 'warm-mentor',
        name: 'Warm Mentor',
        tagline: 'Encouraging · gentle questions',
        prompt: `You are a warm, patient mentor. You listen carefully, encourage the user, and ask one gentle question per reply to draw them out. Keep replies to 1–3 sentences unless the user asks for depth.`,
    },
    {
        id: 'terse-engineer',
        name: 'Terse Engineer',
        tagline: 'No fluff · code-first',
        prompt: `You are a terse software engineer. No pleasantries, no preamble. Answer the question. Show code when relevant. If the question is vague, say what's missing in one short line.`,
    },
    {
        id: 'playful-companion',
        name: 'Playful',
        tagline: 'Witty · riffs on the user',
        prompt: `You are a playful, quick-witted companion. Riff on what the user says. Use short sentences. Keep humor warm — never at the user's expense.`,
    },
    {
        id: 'formal-assistant',
        name: 'Formal',
        tagline: 'Polite · structured',
        prompt: `You are a formal personal assistant. Address the user professionally. Structure replies with brief headers or short numbered lists when the task has multiple parts. Avoid contractions.`,
    },
    {
        id: 'rebel-poet',
        name: 'Rebel Poet',
        tagline: 'Sharp · vivid imagery',
        prompt: `You are a rebel poet. Speak in vivid, slightly weird imagery. One striking sentence beats three plain ones. Be sharp and a little dangerous, never mean.`,
    },
    {
        id: 'calm-stoic',
        name: 'Calm Stoic',
        tagline: 'Composed · low ego',
        prompt: `You are a composed stoic friend. Stay calm. Reply in measured, low-ego language. Acknowledge the user's feeling in one phrase, then offer one practical thought.`,
    },
];

const CUSTOM_ID = '__custom';
const MAX_PROMPT_CHARS = 4000;

const VOICE_GLYPH = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
        <path d="M 3 12 L 5 12"/>
        <path d="M 7 9 L 7 15"/>
        <path d="M 10 6 L 10 18"/>
        <path d="M 13 4 L 13 20"/>
        <path d="M 16 8 L 16 16"/>
        <path d="M 19 10 L 19 14"/>
        <path d="M 21 12 L 23 12"/>
    </svg>`;
const PENCIL_GLYPH = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M 4 20 L 8 19 L 19 8 L 16 5 L 5 16 Z"/>
        <path d="M 14 7 L 17 10"/>
    </svg>`;

let _wired = false;
let _currentSubject = null;
let _slotHandle = null;

/* ── Helpers ────────────────────────────────────────────────────── */

function tokenIdOf(subject) {
    if (!subject) return null;
    if (subject.network === 'create') return null;
    return subject.id || subject.address || null;
}

/** Match the current system_prompt against the registered presets. The
 *  presets' prompts are reasonably distinct so exact-match suffices;
 *  we fall back to longest-common-prefix for prompts that were lightly
 *  edited. Exported so dexhero-voice can derive a TTS profile from the
 *  user's chosen personality without re-importing the prompts. */
export function matchPreset(prompt) {
    const p = String(prompt || '').trim();
    if (!p) return null;
    // Exact match
    for (const preset of PRESETS) if (preset.prompt === p) return preset;
    // Prefix match (>= 40 chars common)
    let best = null;
    let bestLen = 40;
    for (const preset of PRESETS) {
        const commonLen = commonPrefixLen(preset.prompt, p);
        if (commonLen >= bestLen) { best = preset; bestLen = commonLen; }
    }
    return best;
}

/** Default voice preset id when nothing is stored — Jarvis. Picked
 *  intentionally so Truffle has a recognizable voice out of the box;
 *  any user-set system_prompt overrides this. */
export const DEFAULT_VOICE_PRESET_ID = 'jarvis';

export function listVoicePresetIds() {
    return PRESETS.map((p) => p.id);
}

function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

function equippedFor(preset, customPrompt) {
    if (preset) {
        return {
            id: preset.id,
            name: preset.name,
            subtitle: preset.tagline,
            glyph: VOICE_GLYPH,
            badges: ['Equipped'],
        };
    }
    if (customPrompt) {
        return {
            id: CUSTOM_ID,
            name: 'Custom Voice',
            subtitle: `${customPrompt.length} chars`,
            glyph: PENCIL_GLYPH,
            badges: ['Equipped', 'Custom'],
        };
    }
    return null;
}

function inventoryFromPresets() {
    return [
        ...PRESETS.map((p) => ({
            id: p.id,
            name: p.name,
            subtitle: p.tagline,
            glyph: VOICE_GLYPH,
        })),
        {
            id: CUSTOM_ID,
            name: 'Custom',
            subtitle: 'Write your own',
            glyph: PENCIL_GLYPH,
        },
    ];
}

function customTextareaHTML(prompt) {
    const safe = String(prompt || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
    return `
        <label class="eq-slot__custom-label">
            <span>System prompt</span>
            <span class="eq-slot__custom-count" data-count>${prompt.length} / ${MAX_PROMPT_CHARS}</span>
        </label>
        <textarea
            class="eq-slot__custom-textarea"
            data-custom-textarea
            maxlength="${MAX_PROMPT_CHARS}"
            rows="8"
            placeholder="Describe how your DexHero should speak. Tone, style, what they care about, what they never say…">${safe}</textarea>`;
}

function catalogChanged(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (!x || !y) return true;
        if (x.id !== y.id) return true;
        if ((x.like_count || 0) !== (y.like_count || 0)) return true;
        if (!!x.liked_by_me !== !!y.liked_by_me) return true;
    }
    return false;
}

/* ── Open ───────────────────────────────────────────────────────── */

async function openSlot(anchorEl) {
    const tokenId = tokenIdOf(_currentSubject);
    if (!tokenId) return;

    const isDefault = !!_currentSubject?._isDefault;
    const status = wallet.getStatus();
    const me = status?.address ? status.address.toLowerCase() : '';

    // Open immediately. STAGE_SUBJECT warms the cache; the background
    // refresh below repaints if data changed.
    _slotHandle = openEquipmentSlot({
        partId: 'voice',
        title: 'Voice',
        anchorEl,
        equipped: null,
        inventory: withLikeCounts(inventoryFromPresets()),
        filterChips: buildFilterChips(),
        footer: {
            hint: 'Loading…',
            secondaryLabel: 'Close',
        },
        onListYourOwn: () => { location.hash = '#/publish/voice'; },
        onFilter: async (filterId) => {
            _activeFilter = filterId;
            _slotHandle?.refresh({ filterChips: buildFilterChips() });
            try {
                const sort = filterId === 'all' ? '' : filterId;
                const res = await listModules({ category: 'voice', wallet: me, sort, top: 30 });
                _voiceModules = Array.isArray(res?.modules) ? res.modules : [];
                _slotHandle?.refresh({ inventory: withLikeCounts(inventoryFromPresets()) });
            } catch (err) {
                console.warn('[voice-editor] filter fetch failed', err?.message);
            }
        },
        onLike: async (id, nextLiked) => {
            // Map the picker's local id back to the platform module id.
            const moduleId = id.startsWith('platform:voice:') ? id : `platform:voice:${id}`;
            try {
                const r = nextLiked ? await likeModule(moduleId) : await unlikeModule(moduleId);
                const m = _voiceModules.find((mm) => mm.id === moduleId);
                if (m) { m.like_count = r.like_count || 0; m.liked_by_me = nextLiked; }
            } catch (err) {
                console.warn('[voice-editor] like failed', err?.message);
                _slotHandle?.refresh({ inventory: withLikeCounts(inventoryFromPresets()) });
            }
        },
    });

    // Quiet background refresh — only repaint if the catalog changed
    // materially since the prefetch above.
    try {
        const sort = _activeFilter === 'all' ? '' : _activeFilter;
        const res = await listModules({ category: 'voice', wallet: me, sort, top: 30 });
        const fresh = Array.isArray(res?.modules) ? res.modules : [];
        if (catalogChanged(_voiceModules, fresh)) {
            _voiceModules = fresh;
            _slotHandle?.refresh({ inventory: withLikeCounts(inventoryFromPresets()) });
        }
    } catch (err) {
        console.warn('[voice-editor] catalog refresh failed', err?.message);
    }

    if (isDefault) {
        // Truffle (platform default) has no server row. Show presets as
        // preview-only so the user understands the slot before they mint.
        _slotHandle?.refresh({
            ownerBadge: { kind: 'platform', label: 'Platform default' },
            footer: {
                hint: 'Voice swaps unlock after mint',
                secondaryLabel: 'Close',
            },
        });
        return;
    }

    let cfg = null;
    try {
        cfg = await getBrainConfig(tokenId);
    } catch (err) {
        if (_slotHandle) {
            _slotHandle.refresh({
                footer: { hint: 'Couldn\'t load voice', secondaryLabel: 'Close' },
            });
        }
        return;
    }
    if (!_slotHandle) return;

    const ownerWallet = (cfg?.owner_wallet || '').toLowerCase();
    const isOwner = !!(me && ownerWallet && me === ownerWallet);
    const savedPrompt = String(cfg?.behavior?.system_prompt || '');
    const matched = matchPreset(savedPrompt);
    // Sync the TTS voice-preset cache with whatever the server has.
    // Lets the chat surface speak with the right voice on subsequent
    // page loads without re-fetching the brain config.
    if (matched?.id) setVoicePresetId(tokenId, matched.id);

    // Pending state — the equipped preset/custom-prompt the user has
    // clicked but not yet saved. Mirrors the WoW "preview before equip"
    // flow: Save commits, Cancel closes without writing.
    const pending = {
        presetId: matched?.id || (savedPrompt ? CUSTOM_ID : null),
        prompt: savedPrompt,
        mode: 'inventory',   // 'inventory' | 'custom'
    };

    function applyPending() {
        const presetObj = pending.presetId && pending.presetId !== CUSTOM_ID
            ? PRESETS.find((p) => p.id === pending.presetId)
            : null;
        const equipped = equippedFor(presetObj, pending.presetId === CUSTOM_ID ? pending.prompt : '');
        const changed = pending.prompt.trim() !== savedPrompt.trim();
        _slotHandle?.refresh({
            equipped,
            inventory: pending.mode === 'custom' ? [] : withLikeCounts(inventoryFromPresets()).map((it) => ({
                ...it,
                // Highlight the pending preset card while not yet saved.
                ...(it.id === pending.presetId ? { /* slot component flags is-current via equipped.id match */ } : {}),
            })),
            customBody: pending.mode === 'custom' ? customTextareaHTML(pending.prompt) : null,
            ownerBadge: isOwner ? { kind: 'you', label: 'You own this' } : { kind: 'readonly', label: 'Read-only' },
            footer: {
                hint: isOwner
                    ? (pending.mode === 'custom' ? 'Edit · then Save' : (changed ? 'Click Save to commit' : 'Pick a voice or write your own'))
                    : 'Read-only — connect the owning wallet to edit',
                secondaryLabel: pending.mode === 'custom' ? 'Back' : 'Close',
                primaryLabel: isOwner ? 'Save' : null,
                primaryDisabled: !isOwner || !changed,
            },
            onSecondary: () => {
                if (pending.mode === 'custom') {
                    // Back from textarea → inventory grid (keep slot open).
                    pending.mode = 'inventory';
                    applyPending();
                    return true;
                }
                // 'Close' in inventory mode → fall through and close.
                return false;
            },
            onSwap: (itemId) => {
                if (itemId === CUSTOM_ID) {
                    pending.presetId = CUSTOM_ID;
                    pending.mode = 'custom';
                    pending.prompt = pending.prompt || savedPrompt;
                    applyPending();
                    // Focus the textarea after the next paint.
                    setTimeout(() => {
                        const ta = document.querySelector('.eq-slot [data-custom-textarea]');
                        if (ta) {
                            ta.focus();
                            ta.setSelectionRange(ta.value.length, ta.value.length);
                            wireTextarea(ta);
                        }
                    }, 60);
                    return;
                }
                const preset = PRESETS.find((p) => p.id === itemId);
                if (!preset) return;
                pending.presetId = preset.id;
                pending.prompt = preset.prompt;
                pending.mode = 'inventory';
                applyPending();
            },
            onPrimary: async (btn) => {
                if (!isOwner) return;
                if (pending.mode === 'custom') {
                    const ta = document.querySelector('.eq-slot [data-custom-textarea]');
                    if (ta) pending.prompt = String(ta.value || '').trim();
                }
                if (pending.prompt.trim() === savedPrompt.trim()) return;
                const orig = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'Signing…';
                try {
                    const newBehavior = { ...(cfg.behavior || {}), system_prompt: pending.prompt };
                    await saveBrainConfig(tokenId, cfg.intelligence, newBehavior);
                    // Persist the TTS voice profile for this hero so the
                    // chat surface uses it on the next reply (and across
                    // refreshes — no need to re-fetch brain config).
                    if (pending.presetId && pending.presetId !== CUSTOM_ID) {
                        setVoicePresetId(tokenId, pending.presetId);
                    }
                    btn.textContent = 'Saved ✓';
                    setTimeout(() => _slotHandle?.close(), 700);
                } catch (err) {
                    const code = err?.body?.error || err?.message || 'failed';
                    const msg = ({
                        not_owner: 'Not the owner',
                        signature_expired: 'Try again',
                        signature_invalid: 'Sig rejected',
                        wallet_not_connected: 'Connect wallet',
                    })[code] || 'Save failed';
                    btn.textContent = msg;
                    setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 2200);
                }
            },
        });
    }

    function wireTextarea(ta) {
        const countEl = document.querySelector('.eq-slot [data-count]');
        const update = () => {
            pending.prompt = ta.value;
            if (countEl) countEl.textContent = `${ta.value.length} / ${MAX_PROMPT_CHARS}`;
            // Re-evaluate Save enabled state.
            const primary = document.querySelector('.eq-slot [data-primary]');
            if (primary) {
                const changed = pending.prompt.trim() !== savedPrompt.trim();
                primary.disabled = !changed;
            }
        };
        ta.addEventListener('input', update);
    }

    applyPending();
}

/* ── Boot ───────────────────────────────────────────────────────── */

export function initVoiceEditor() {
    if (_wired) return;
    _wired = true;
    on(E.STAGE_SUBJECT, (subject) => {
        _currentSubject = subject || null;
        // Warm catalog cache so the first slot click is instant.
        (async () => {
            try {
                const me = wallet.getStatus()?.address?.toLowerCase() || '';
                const sort = _activeFilter === 'all' ? '' : _activeFilter;
                const res = await listModules({ category: 'voice', wallet: me, sort, top: 30 });
                const fresh = Array.isArray(res?.modules) ? res.modules : [];
                if (catalogChanged(_voiceModules, fresh)) {
                    _voiceModules = fresh;
                    if (_slotHandle) {
                        _slotHandle.refresh({ inventory: withLikeCounts(inventoryFromPresets()) });
                    }
                }
            } catch {}
        })();
    });
    document.addEventListener('dexhero:workshop-part', (ev) => {
        const part = ev.detail?.part;
        if (part !== 'voice') return;
        openSlot(ev.detail?.anchorEl);
    });
}
