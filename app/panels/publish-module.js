/* publish-module.js — creator listing flow (Phase 2 of the Agent Store
 * roadmap).
 *
 * One form. Four always-visible fields. One category-aware field. One
 * signature. One line on success.
 *
 *   [ Brain ] [ Voice ] [ Movement ] [ Body ]    ← category chip row
 *   [ Name                                  ]
 *   [ Price (USDC)              0           ]    ← 0 = free / "Get"
 *   [ Description (optional)                ]
 *   ────────────────────────────────────────
 *   [ Personality / Voice / Movement / Emoji ]   ← category-aware
 *   ────────────────────────────────────────
 *   [ Publish ]
 *
 * Submit → wallet sig → POST /api/modules → "Published ✓ — live in your
 * slot" → auto-route back to the lobby home. In production the
 * server's response uses status `pending_review` and the success line
 * says "Submitted — awaiting review".
 *
 * The category-aware field intentionally does NOT expose `framework`
 * for brain modules — that's a runtime choice in the Install tab, not
 * a creator field (see plan §3 phase 5).
 *
 * Optional deep link: `#/publish/brain` (or `voice|movement|body`)
 * preselects the category, useful when launched from a slot popover.
 */

import { Panel } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { publishModule } from '../services/dexhero-modules.js';

const CATEGORIES = ['brain', 'voice', 'movement', 'body'];
const CATEGORY_LABEL = { brain: 'Brain', voice: 'Voice', movement: 'Movement', body: 'Body' };

const VOICE_PRESET_OPTIONS = [
    { id: 'jarvis',            label: 'Jarvis — British butler' },
    { id: 'warm-mentor',       label: 'Warm mentor' },
    { id: 'terse-engineer',    label: 'Terse engineer' },
    { id: 'playful-companion', label: 'Playful companion' },
    { id: 'formal-assistant',  label: 'Formal assistant' },
    { id: 'rebel-poet',        label: 'Rebel poet' },
    { id: 'calm-stoic',        label: 'Calm stoic' },
];

const MOVEMENT_PRESET_OPTIONS = [
    { id: 'natural',   label: 'Natural'   },
    { id: 'calm',      label: 'Calm'      },
    { id: 'energetic', label: 'Energetic' },
    { id: 'stoic',     label: 'Stoic'     },
    { id: 'playful',   label: 'Playful'   },
];

const BRAIN_LLM_OPTIONS = [
    { id: 'anthropic:claude-haiku-4-5',  label: 'Claude Haiku 4.5 · fast'    },
    { id: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · balanced' },
    { id: 'openai:gpt-4o-mini',          label: 'GPT-4o mini · fast'         },
    { id: 'openai:gpt-4o',               label: 'GPT-4o · balanced'          },
    { id: 'google:gemini-1.5-flash',     label: 'Gemini 1.5 Flash · fast'    },
];

const ERR_LABELS = {
    wallet_not_connected:        'Connect your wallet',
    signature_expired:           'Sig expired — try again',
    signature_invalid:           'Sig rejected',
    name_required:               'Name is required',
    name_too_long:                'Name too long',
    invalid_category:            'Pick a slot',
    price_invalid:               'Price 0–100000',
    brain_provider_invalid:      'Pick an LLM',
    brain_model_invalid:         'Pick an LLM',
    brain_system_prompt_required:'Personality is required',
    voice_provider_invalid:      'Pick a voice',
    voice_id_required:           'Pick a voice',
    movement_kind_invalid:       'Pick a movement preset',
    body_kind_invalid:           'Pick an emoji',
};

export default class PublishModulePanel extends Panel {
    static id        = 'publish';
    static variant   = 'right';
    static width     = 520;
    static title     = 'List a module';
    static titleBreadcrumb = ['LIST A MODULE'];
    static parentHash = '#/';
    static stageMode = 'keep';

    constructor(params) {
        super(params);
        const cat = String(params.category || params.cat || 'brain').toLowerCase();
        this.form = {
            category:    CATEGORIES.includes(cat) ? cat : 'brain',
            name:        '',
            description: '',
            price:       0,
            // Category-aware fields. Stored in one bag so swapping
            // category doesn't lose the user's per-category drafts.
            brain:    { llm: BRAIN_LLM_OPTIONS[0].id, prompt: '' },
            voice:    { preset: VOICE_PRESET_OPTIONS[0].id },
            movement: { preset: MOVEMENT_PRESET_OPTIONS[0].id },
            body:     { glyph: '🎩' },
        };
        this.state = 'idle';     // 'idle' | 'submitting' | 'success' | 'error'
        this.errorLabel = '';
    }

    render() {
        const s = wallet.getStatus();
        if (!s.connected) {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Connect wallet to publish</div>
                    <button class="hud-btn hud-btn--primary" data-connect>Connect</button>
                </div>`;
        }
        if (this.state === 'success') {
            return `
                <section class="panel-section">
                    <div class="hud-display" style="font-size:18px;">Published ✓</div>
                    <div class="hud-label" style="margin-top:6px;">Live in your slot inventory.</div>
                </section>`;
        }

        const cat = this.form.category;
        const chipRow = CATEGORIES.map((c) =>
            `<button type="button" class="pm-chip${c === cat ? ' is-active' : ''}" data-chip="${c}">${CATEGORY_LABEL[c]}</button>`
        ).join('');

        const categoryField = this._renderCategoryField(cat);
        const submitting = this.state === 'submitting';

        return `
            <section class="panel-section">
                <div class="pm-chips" role="tablist">${chipRow}</div>
            </section>
            <section class="panel-section">
                <label class="pm-label">Name</label>
                <input class="hud-input pm-input" type="text" maxlength="80"
                    data-field="name" value="${this._esc(this.form.name)}"
                    placeholder="${this._namePlaceholder(cat)}">
            </section>
            <section class="panel-section">
                <label class="pm-label">Price (USDC) — <span style="opacity:0.55;">0 = free</span></label>
                <input class="hud-input pm-input" type="number" min="0" max="100000" step="0.5"
                    data-field="price" value="${Number(this.form.price) || 0}">
            </section>
            <section class="panel-section">
                <label class="pm-label">Description <span style="opacity:0.55;">— optional</span></label>
                <input class="hud-input pm-input" type="text" maxlength="200"
                    data-field="description" value="${this._esc(this.form.description)}"
                    placeholder="One short sentence.">
            </section>
            <hr class="pm-rule">
            <section class="panel-section">${categoryField}</section>
            <hr class="pm-rule">
            <section class="panel-section">
                <button class="hud-btn hud-btn--primary hud-btn--block hud-btn--lg" data-submit ${submitting ? 'disabled' : ''}>
                    ${submitting ? 'Signing…' : 'Publish'}
                </button>
                <div class="hud-label pm-error" data-error>${this.errorLabel || ''}</div>
            </section>
        `;
    }

    _renderCategoryField(cat) {
        if (cat === 'brain') {
            const llmOpts = BRAIN_LLM_OPTIONS.map((o) =>
                `<option value="${o.id}" ${this.form.brain.llm === o.id ? 'selected' : ''}>${o.label}</option>`
            ).join('');
            return `
                <label class="pm-label">LLM</label>
                <select class="hud-input pm-input" data-field="brain-llm">${llmOpts}</select>
                <label class="pm-label" style="margin-top:14px;">Personality</label>
                <textarea class="hud-input pm-textarea" rows="6" maxlength="4000"
                    data-field="brain-prompt"
                    placeholder="You are a sharp-witted poet who notices everything…">${this._esc(this.form.brain.prompt)}</textarea>`;
        }
        if (cat === 'voice') {
            const opts = VOICE_PRESET_OPTIONS.map((o) =>
                `<option value="${o.id}" ${this.form.voice.preset === o.id ? 'selected' : ''}>${o.label}</option>`
            ).join('');
            return `
                <label class="pm-label">Voice</label>
                <select class="hud-input pm-input" data-field="voice-preset">${opts}</select>`;
        }
        if (cat === 'movement') {
            const opts = MOVEMENT_PRESET_OPTIONS.map((o) =>
                `<option value="${o.id}" ${this.form.movement.preset === o.id ? 'selected' : ''}>${o.label}</option>`
            ).join('');
            return `
                <label class="pm-label">Movement</label>
                <select class="hud-input pm-input" data-field="movement-preset">${opts}</select>`;
        }
        // body
        return `
            <label class="pm-label">Emoji</label>
            <input class="hud-input pm-input pm-emoji" type="text" maxlength="8"
                data-field="body-glyph" value="${this._esc(this.form.body.glyph)}">`;
    }

    _namePlaceholder(cat) {
        return ({
            brain:    'Curious Mushroom',
            voice:    'Late-night Radio Host',
            movement: 'Skater Vibe',
            body:     'Wizard Hat',
        })[cat] || 'Untitled';
    }

    async onMount() {
        this._wire();
    }

    _wire() {
        const root = this.root;
        if (!root) return;

        root.querySelector('[data-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });

        root.querySelectorAll('[data-chip]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const next = btn.getAttribute('data-chip');
                if (!CATEGORIES.includes(next) || next === this.form.category) return;
                this.form.category = next;
                this.errorLabel = '';
                this.rerender();
                this._wire();
            }, { signal: this.signal });
        });

        root.querySelectorAll('[data-field]').forEach((el) => {
            const k = el.getAttribute('data-field');
            const evName = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(evName, (e) => {
                const v = e.target.value;
                if (k === 'name')            this.form.name = v;
                else if (k === 'description') this.form.description = v;
                else if (k === 'price')      this.form.price = v;
                else if (k === 'brain-llm')  this.form.brain.llm = v;
                else if (k === 'brain-prompt') this.form.brain.prompt = v;
                else if (k === 'voice-preset')   this.form.voice.preset = v;
                else if (k === 'movement-preset') this.form.movement.preset = v;
                else if (k === 'body-glyph') this.form.body.glyph = v;
            }, { signal: this.signal });
        });

        root.querySelector('[data-submit]')?.addEventListener('click', () => this._submit(), { signal: this.signal });
    }

    _buildSpec() {
        const cat = this.form.category;
        if (cat === 'brain') {
            const [provider, model] = String(this.form.brain.llm || '').split(':');
            return {
                llm_provider:  provider,
                llm_model:     model,
                system_prompt: String(this.form.brain.prompt || '').trim(),
            };
        }
        if (cat === 'voice') {
            return { provider: 'platform', voice_id: String(this.form.voice.preset || '') };
        }
        if (cat === 'movement') {
            // Movement modules clone a platform preset's overrides.
            // Real per-creator tuning lands in a Phase 2.5 advanced UX.
            const m = (PLATFORM_MOVEMENT_OVERRIDES[this.form.movement.preset] || {});
            return { kind: 'gesture_overrides', gesture_overrides: m };
        }
        // body
        return { kind: 'hat', attach_bones: ['head'], glyph: String(this.form.body.glyph || '').trim() };
    }

    async _submit() {
        if (this.state === 'submitting') return;
        this.state = 'submitting';
        this.errorLabel = '';
        this.rerender();
        this._wire();
        try {
            const spec = this._buildSpec();
            const payload = {
                name:        String(this.form.name || '').trim(),
                description: String(this.form.description || '').trim(),
                category:    this.form.category,
                price_usdc:  Number(this.form.price) || 0,
                spec,
            };
            await publishModule(payload);
            this.state = 'success';
            this.rerender();
            this._wire();
            setTimeout(() => { location.hash = '#/'; }, 1400);
        } catch (err) {
            const code = err?.body?.error || err?.message || 'failed';
            this.state = 'error';
            this.errorLabel = ERR_LABELS[code] || 'Publish failed';
            this.rerender();
            this._wire();
            // Re-enable submit after a short pause so the user sees the
            // error label without it disappearing instantly.
            setTimeout(() => {
                if (this.state === 'error') {
                    this.state = 'idle';
                    const errEl = this.root?.querySelector('[data-error]');
                    if (errEl) errEl.textContent = this.errorLabel; // keep error visible
                    const submitEl = this.root?.querySelector('[data-submit]');
                    if (submitEl) { submitEl.disabled = false; submitEl.textContent = 'Publish'; }
                }
            }, 600);
        }
    }

    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }
}

/* Mirror of the platform-default movement override matrices. Source of
 * truth lives in lib/agent-modules.js — duplicated here so the panel
 * can build a spec without a server round-trip. The two MUST stay in
 * lockstep; if a new preset lands server-side, add it here too. */
const PLATFORM_MOVEMENT_OVERRIDES = {
    natural: {},
    calm: {
        idle_sway:  { amplitudeMul: 0.55 },
        talk_bob:   { amplitudeMul: 0.60, frequencyMul: 0.70 },
        nod:        { amplitudeMul: 0.70 },
        wave:       { durationMul:  1.25 },
    },
    energetic: {
        idle_sway:  { amplitudeMul: 1.35, frequencyMul: 1.20 },
        talk_bob:   { amplitudeMul: 1.40, frequencyMul: 1.25 },
        nod:        { amplitudeMul: 1.30 },
        wave:       { amplitudeMul: 1.20 },
    },
    stoic: {
        idle_sway:  { amplitudeMul: 0.25 },
        talk_bob:   { amplitudeMul: 0.45 },
        nod:        { amplitudeMul: 0.60 },
        shake_head: { amplitudeMul: 0.55 },
    },
    playful: {
        idle_sway:  { amplitudeMul: 1.15 },
        talk_bob:   { amplitudeMul: 1.25 },
        nod:        { amplitudeMul: 1.45 },
        shrug:      { amplitudeMul: 1.30 },
        wave:       { amplitudeMul: 1.50, frequencyMul: 1.20 },
    },
};
