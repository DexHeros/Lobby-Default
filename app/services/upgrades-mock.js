/* Upgrades mock service — Stage A of the community-built everything-avatar.
 *
 * Single source of truth for the prototype. All "data" lives in localStorage
 * plus the fixture arrays below. When Stage B brings up real /api/upgrades
 * endpoints, this whole module gets swapped for a thin fetch wrapper that
 * preserves the same exported shape.
 *
 * See plan: /Users/mojo/.claude/plans/i-want-you-to-twinkly-phoenix.md (Stage A).
 */

const STORE_KEY = 'dexhero:upgrades:store:v2';
const SCHEMA_VERSION = 2;

/* The five surfaces that EVERY user experience must keep intact. Patches
 * can restyle / reposition / reskin these but the IDs must remain present,
 * named, and functional. */
export const PROTECTED_SURFACES = [
    {
        id: 'surface.chat-log',
        label: 'Chat log',
        dom: '[data-tab-panel="chatlog"]',
        rule: 'Must render last N messages; user/assistant distinction visible.',
    },
    {
        id: 'surface.main-input',
        label: 'Main text bar',
        dom: '#lobby-stage-chat-input',
        rule: 'Must accept text + Enter to submit + dispatch to dexhero brain.',
    },
    {
        id: 'surface.model-view',
        label: 'Model view area',
        dom: '#lobby-stage-subject',
        rule: 'Must render the active dexhero 3D model.',
    },
    {
        id: 'surface.dexhero-bar',
        label: 'DexHero selection bar',
        dom: '#lobby-stage-dots, #lobby-stage-slots',
        rule: 'Must let user swap between owned dexheros.',
    },
    {
        id: 'surface.create-dexhero',
        label: 'Playable Internet / Create DexHero',
        dom: '[data-nav-tab="create"]',
        rule: 'Must remain reachable from lobby; CTA launches create flow.',
    },
];

export const PROTECTED_IDS = new Set(PROTECTED_SURFACES.map((s) => s.id));

/* Capability descriptors — shown to users at adopt time. */
export const CAPABILITIES = {
    'dom.read':         { label: 'Read DOM',       blurb: 'Read text + attributes inside the patch\'s region.' },
    'dom.style':        { label: 'Restyle UI',     blurb: 'Update CSS variables on this patch\'s owned region.' },
    'events.subscribe': { label: 'Listen to events', blurb: 'Subscribe to lobby events (slot active, hero swap, etc.).' },
    'chat.append':      { label: 'Speak in chat',  blurb: 'Append a message into the dexhero chat (rate-limited).' },
};

/* Demo-video template kinds. The upgrade-demo-video component renders
 * the appropriate mini-scene based on this. Each template knows how to
 * show a before/after representation of changes to that surface kind. */
const DEMO_KINDS = ['popover', 'ticker', 'chat-row', 'slot', 'global'];

/* Pick the right demo template for a given target surface. */
function defaultDemoKind(targetSurface) {
    switch (targetSurface) {
        case 'equipment-slot':  return 'popover';
        case 'header-ticker':   return 'ticker';
        case 'chat-log':        return 'chat-row';
        case 'global':          return 'global';
        default:                return 'popover';
    }
}

/* Build a default demo_video descriptor for a patch. The component
 * receives this object and renders a live before/after. */
function buildDefaultDemoVideo(patch, { dexheroName = 'Truffle Man' } = {}) {
    return {
        kind: defaultDemoKind(patch.target_surface),
        // Used by the SVG renderer to apply patch CSS to the "after" pane.
        after_css: patch.css || '',
        after_config: patch.config || {},
        // Recorder identity baked into the chrome.
        recorded_by: dexheroName,
        // Caption shown beneath the surface. Falls back to the patch description.
        caption: patch.description || patch.title || 'Demonstration',
        // Duration shown in the timer chrome.
        duration_seconds: 6,
        // Cycle period — how often the before→after transition plays.
        cycle_ms: 3000,
    };
}

/* Social-caption fallback — used when the user's LLM doesn't provide one
 * (Stage A canned proposals + Truffle Man's brain-less path). Composes a
 * short Twitter-length line from the patch's own metadata so every card
 * still reads like a social post. */
export function _fallbackCaption(patch) {
    if (!patch) return '';
    if (patch.caption && typeof patch.caption === 'string') return patch.caption;
    const title = (patch.title || '').trim();
    if (title) return `${title} — try it on your branch.`;
    const desc = (patch.description || '').trim();
    if (desc) return desc.length > 140 ? desc.slice(0, 137) + '…' : desc;
    return 'New look — adopt to try it on your branch.';
}

/* Social-hashtag fallback — derives 2-3 tags from target_surface +
 * patch shape (behaviors, layout overrides, CSS hints). Stable across
 * reloads so the same patch always shows the same chips. */
const _SURFACE_TAGS = {
    'equipment-slot': ['popovers', 'slots'],
    'header-ticker':  ['ticker'],
    'chat-log':       ['chat'],
    'slot':           ['slots'],
    'global':         ['theme'],
};
export function _fallbackTags(patch) {
    if (!patch) return [];
    if (Array.isArray(patch.tags) && patch.tags.length) return patch.tags.slice(0, 5);
    const surface = patch.target_surface || 'global';
    const tags = [..._SURFACE_TAGS[surface] || _SURFACE_TAGS.global];
    // Add a flavor tag from the patch content.
    const css = (patch.css || '').toLowerCase();
    if (Array.isArray(patch.behaviors) && patch.behaviors.length) tags.push('animated');
    else if (/border-radius:\s*0/i.test(css))                     tags.push('flat');
    else if (/#050|#060|#020|background[^;]*#0a0/.test(css))      tags.push('dark');
    else if (/text-shadow|box-shadow:[^;]*0 0 \d/i.test(css))     tags.push('glow');
    else if (Object.keys(patch.config || {}).some((k) => k.startsWith('microcopy.'))) tags.push('microcopy');
    else if (Object.keys(patch.config || {}).some((k) => k.endsWith('.layout')))      tags.push('layout');
    return tags.slice(0, 3);
}

/* Fixture creators — the dramatis personae for the ticker, feed, and
 * leaderboard. Adoption counts are stable per fixture so the prototype
 * always looks alive. */
const FIXTURE_CREATORS = [
    { wallet: '0xA11ce0001',  username: 'twinkly_phoenix', avatar: '✦', followers: 1247, joined: '2026-02-10' },
    { wallet: '0xB0b00002',    username: 'glass_orca',      avatar: '◉', followers: 893,  joined: '2026-01-22' },
    { wallet: '0xC4ff31333',   username: 'lattice_baron',   avatar: '◆', followers: 612,  joined: '2026-03-05' },
    { wallet: '0xDeadbeef4',   username: 'midnight_chef',   avatar: '☾', followers: 488,  joined: '2026-02-28' },
    { wallet: '0xE15ee05555',  username: 'pixel_hermit',    avatar: '◈', followers: 414,  joined: '2026-04-01' },
    { wallet: '0xF0xy00006',   username: 'foxy_thread',     avatar: '✺', followers: 387,  joined: '2026-03-19' },
    { wallet: '0x117117777',   username: 'iridescent_cog',  avatar: '✧', followers: 322,  joined: '2026-04-12' },
    { wallet: '0x12345abc8',   username: 'soft_brutalist',  avatar: '▣', followers: 211,  joined: '2026-04-29' },
    { wallet: '0x67890def9',   username: 'cyan_drift',      avatar: '◐', followers: 198,  joined: '2026-05-02' },
    { wallet: '0xABCDEF1234A', username: 'matte_terminal',  avatar: '▢', followers: 175,  joined: '2026-05-05' },
];

/* Fixture patches — every visual variety we want to show off. Adoption
 * counts are tuned so leaderboard ranking looks natural. */
const FIXTURE_PATCHES = [
    {
        id: 'patch_fx_compact_dark',
        author_wallet: '0xA11ce0001', author_username: 'twinkly_phoenix',
        title: 'Compact dark popups',
        description: 'Tighter spacing, deeper black, rounder corners for every slot popover.',
        caption: 'Tighter, blacker, rounder. The popovers quietly disappear into the bg now.',
        tags: ['darkmode', 'popovers', 'minimal'],
        target_surface: 'equipment-slot',
        manifest_version: '1.0',
        css: `:root { --slot-bg: #050608; --slot-radius: 14px; --slot-border: rgba(180,200,220,0.08); }
.lobby-equipment-popover, .equipment-popover, .panel--codex { background: var(--slot-bg) !important; border-radius: var(--slot-radius) !important; border: 1px solid var(--slot-border) !important; }`,
        config: {},
        behaviors: [],
        preview_thumb: '◆ Compact dark',
        created_at: '2026-04-18T14:22:00Z',
        adoption_count: 1247,
        is_promoted_to_main: true,
        promoted_at: '2026-05-02T10:00:00Z',
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_neon_ticker',
        author_wallet: '0xB0b00002', author_username: 'glass_orca',
        title: 'Neon attribution ticker',
        description: 'Replaces the muted ticker color with a soft neon cyan, adds a subtle pulse.',
        caption: 'Gave the ticker a soft neon glow. Names actually catch your eye now.',
        tags: ['ticker', 'neon', 'glow'],
        target_surface: 'header-ticker',
        manifest_version: '1.0',
        css: `.lobby-ticker { background: linear-gradient(180deg, rgba(0,30,50,0.6), rgba(0,10,20,0.85)) !important; }
.lobby-ticker__item strong { color: #6ff5ff !important; text-shadow: 0 0 8px rgba(111,245,255,0.4); }
.lobby-ticker__item .up { color: #6ff5ff !important; }`,
        config: {},
        behaviors: [],
        preview_thumb: '✺ Neon',
        created_at: '2026-04-22T08:14:00Z',
        adoption_count: 893,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_warm_chat',
        author_wallet: '0xC4ff31333', author_username: 'lattice_baron',
        title: 'Warm chat bubbles',
        description: 'Switches the chat log\'s assistant bubble to a warm amber palette. Easier on the eyes at night.',
        caption: 'Warmed up the chat replies. Reads way better at 2am.',
        tags: ['chat', 'warm', 'nightmode'],
        target_surface: 'chat-log',
        manifest_version: '1.0',
        css: `.chat-log__row--assistant .chat-log__body { color: #f5d896 !important; }
.chat-log__row--assistant .chat-log__role { color: #f0b85a !important; }`,
        config: {},
        behaviors: [],
        preview_thumb: '☾ Warm',
        created_at: '2026-04-25T19:50:00Z',
        adoption_count: 612,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_slot_pulse',
        author_wallet: '0xDeadbeef4', author_username: 'midnight_chef',
        title: 'Slot pulse on activate',
        description: 'Adds a soft pulse animation around the active equipment slot when you select one.',
        caption: 'When you tap a slot it now breathes. Tiny detail, huge vibe.',
        tags: ['slots', 'pulse', 'animated'],
        target_surface: 'equipment-slot',
        manifest_version: '1.0',
        css: `@keyframes patch-slot-pulse { 0% { box-shadow: 0 0 0 0 rgba(120,220,255,0.55); } 70% { box-shadow: 0 0 0 14px rgba(120,220,255,0); } 100% { box-shadow: 0 0 0 0 rgba(120,220,255,0); } }
.equipment-slot.is-active, .lobby-equipment-slot.is-active { animation: patch-slot-pulse 1.4s ease-out infinite !important; }`,
        config: {},
        behaviors: [
            { id: 'on-slot-active', trigger: 'event:dexhero:slot-active', capabilities_requested: ['events.subscribe', 'dom.style'] },
        ],
        preview_thumb: '◉ Pulse',
        created_at: '2026-04-28T02:08:00Z',
        adoption_count: 488,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_microcopy_friendly',
        author_wallet: '0xE15ee05555', author_username: 'pixel_hermit',
        title: 'Friendlier slot labels',
        description: 'Rewrites Brain → "Mind", Body → "Form", Voice → "Tone", Movement → "Stride". A softer vocabulary.',
        caption: 'Renamed the slots — Brain → Mind, Body → Form, Voice → Tone, Movement → Stride.',
        tags: ['microcopy', 'slots', 'language'],
        target_surface: 'equipment-slot',
        manifest_version: '1.0',
        css: '',
        config: {
            'microcopy.equipment-slot.title.brain':    'Mind',
            'microcopy.equipment-slot.title.body':     'Form',
            'microcopy.equipment-slot.title.voice':    'Tone',
            'microcopy.equipment-slot.title.movement': 'Stride',
        },
        behaviors: [],
        preview_thumb: '✧ Microcopy',
        created_at: '2026-04-30T13:45:00Z',
        adoption_count: 414,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_rows_layout',
        author_wallet: '0xF0xy00006', author_username: 'foxy_thread',
        title: 'Inventory as rows',
        description: 'Show every slot picker\'s inventory as a vertical list of rows instead of a grid of tiles.',
        caption: 'Switched slot inventory from grid to rows. Faster to scan.',
        tags: ['layout', 'inventory', 'rows'],
        target_surface: 'equipment-slot',
        manifest_version: '1.0',
        css: '',
        config: { 'equipment-slot.inventory.layout': 'rows' },
        behaviors: [],
        preview_thumb: '▤ Rows',
        created_at: '2026-05-01T11:11:00Z',
        adoption_count: 387,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_iridescent_creator_chip',
        author_wallet: '0x117117777', author_username: 'iridescent_cog',
        title: 'Iridescent creator chips',
        description: 'Promoted creators in the ticker glow with a shifting iridescent gradient instead of flat gold.',
        caption: 'Promoted creators shimmer in iridescent gradient instead of flat gold now.',
        tags: ['ticker', 'iridescent', 'promoted'],
        target_surface: 'header-ticker',
        manifest_version: '1.0',
        css: `@keyframes patch-irid { 0%,100% { color: #ffd97a; } 33% { color: #b8e2ff; } 66% { color: #f0b8ff; } }
.lobby-ticker__item--promoted strong { animation: patch-irid 6s linear infinite !important; text-shadow: 0 0 6px currentColor; }`,
        config: {},
        behaviors: [],
        preview_thumb: '✦ Iridescent',
        created_at: '2026-05-03T20:30:00Z',
        adoption_count: 322,
        is_promoted_to_main: true,
        promoted_at: '2026-05-15T09:00:00Z',
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_soft_brutal',
        author_wallet: '0x12345abc8', author_username: 'soft_brutalist',
        title: 'Soft brutalist popovers',
        description: 'Removes border-radius entirely and adds heavy off-black borders to every popover. Brutalism but cozy.',
        caption: 'Brutalist popovers — zero radius, thick borders, hard shadow. Cozy though.',
        tags: ['brutalism', 'popovers', 'flat'],
        target_surface: 'equipment-slot',
        manifest_version: '1.0',
        css: `.lobby-equipment-popover, .equipment-popover, .panel--codex { border-radius: 0 !important; border: 3px solid #1a1c20 !important; box-shadow: 8px 8px 0 0 rgba(0,0,0,0.4) !important; }`,
        config: {},
        behaviors: [],
        preview_thumb: '▣ Brutal',
        created_at: '2026-05-08T16:00:00Z',
        adoption_count: 211,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_cyan_drift_chat',
        author_wallet: '0x67890def9', author_username: 'cyan_drift',
        title: 'Drifting cyan accent',
        description: 'A slow cyan-to-magenta drift on every accent in the lobby. Subtle motion, not distracting.',
        caption: 'All accents drift cyan → magenta over 18s. Slow motion at the edges.',
        tags: ['theme', 'drift', 'animated'],
        target_surface: 'global',
        manifest_version: '1.0',
        css: `@keyframes patch-cyan-drift { 0%,100% { --acc-cyan: #6ff5ff; } 50% { --acc-cyan: #f078ff; } }
:root { animation: patch-cyan-drift 18s ease-in-out infinite !important; }`,
        config: {},
        behaviors: [
            { id: 'drift-tick', trigger: 'interval:5000', capabilities_requested: ['dom.style'] },
        ],
        preview_thumb: '◐ Drift',
        created_at: '2026-05-12T07:42:00Z',
        adoption_count: 198,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
    {
        id: 'patch_fx_matte_terminal',
        author_wallet: '0xABCDEF1234A', author_username: 'matte_terminal',
        title: 'Matte terminal',
        description: 'Switches the design language to flat matte greys with a single accent color. Terminal aesthetic.',
        caption: 'Switched the whole lobby to a matte terminal aesthetic. Monospace everywhere.',
        tags: ['theme', 'terminal', 'monospace'],
        target_surface: 'global',
        manifest_version: '1.0',
        css: `:root { --bg-primary: #0d0e10 !important; --ink-0: #d8d8d8 !important; --ink-3: #6a6c6e !important; --rule: rgba(255,255,255,0.06) !important; }
.lobby-chip, .lobby-tabs__tab { font-family: ui-monospace, monospace !important; letter-spacing: 0.04em !important; }`,
        config: {},
        behaviors: [],
        preview_thumb: '▢ Matte',
        created_at: '2026-05-16T22:14:00Z',
        adoption_count: 175,
        is_promoted_to_main: false,
        version: 1, parent_patch_id: null,
    },
];

/* Backfill every fixture with a demo_video descriptor + a social caption
 * + tags — every patch shipped or proposed in this prototype carries proof
 * of the change AND a social-post framing. */
for (const p of FIXTURE_PATCHES) {
    if (!p.demo_video) {
        p.demo_video = buildDefaultDemoVideo(p, { dexheroName: `${p.author_username}'s DexHero` });
    }
    if (!p.caption) p.caption = _fallbackCaption(p);
    if (!Array.isArray(p.tags) || !p.tags.length) p.tags = _fallbackTags(p);
}

/* ── IndexedDB blob storage for dexhero-recorded before/after clips ──
 *
 * Every patch authored via /upgrade is "recorded" by the dexhero — two
 * short WebM clips (before + after the change) captured client-side via
 * canvas.captureStream + MediaRecorder. Blobs are heavy for localStorage,
 * so we tuck them in a dedicated IndexedDB database. LRU-capped at 20
 * patches (40 blobs total) so a heavy authoring session doesn't blow the
 * quota.
 *
 * Public API:
 *   _storeBlob(patchId, kind, blob)  — `kind` is 'before' or 'after'
 *   getBlobUrl(patchId, kind) → Promise<string|null>  — object URL the
 *     demo-video component consumes
 *   hasStoredClips(patchId) → Promise<boolean>
 */
const _CLIP_DB_NAME = 'dexhero-clips';
const _CLIP_DB_STORE = 'clips';
const _CLIP_LRU_MAX_PATCHES = 20;
let _clipDbPromise = null;

function _openClipDb() {
    if (_clipDbPromise) return _clipDbPromise;
    if (typeof indexedDB === 'undefined') {
        _clipDbPromise = Promise.reject(new Error('indexeddb_unavailable'));
        return _clipDbPromise;
    }
    _clipDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(_CLIP_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(_CLIP_DB_STORE)) {
                const store = db.createObjectStore(_CLIP_DB_STORE, { keyPath: 'id' });
                store.createIndex('patchId', 'patchId', { unique: false });
                store.createIndex('ts',      'ts',      { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
    return _clipDbPromise;
}

/* Internal: enforce LRU cap on stored patches (each patch may have 2
 * blobs — before + after). When unique patch count exceeds the cap,
 * evict the oldest patch's blobs by timestamp. */
async function _evictLruClips(db) {
    return new Promise((resolve) => {
        const tx = db.transaction(_CLIP_DB_STORE, 'readwrite');
        const store = tx.objectStore(_CLIP_DB_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
            const all = req.result || [];
            const byPatch = new Map();
            for (const r of all) {
                const cur = byPatch.get(r.patchId);
                byPatch.set(r.patchId, Math.max(cur || 0, r.ts || 0));
            }
            if (byPatch.size <= _CLIP_LRU_MAX_PATCHES) { resolve(); return; }
            const sorted = [...byPatch.entries()].sort((a, b) => a[1] - b[1]);
            const drop = sorted.slice(0, byPatch.size - _CLIP_LRU_MAX_PATCHES).map((e) => e[0]);
            for (const r of all) {
                if (drop.includes(r.patchId)) store.delete(r.id);
            }
            tx.oncomplete = () => resolve();
            tx.onerror    = () => resolve();
        };
        req.onerror = () => resolve();
    });
}

export async function _storeBlob(patchId, kind, blob) {
    if (!patchId || !blob) return false;
    try {
        const db = await _openClipDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(_CLIP_DB_STORE, 'readwrite');
            tx.objectStore(_CLIP_DB_STORE).put({
                id:      `${patchId}:${kind}`,
                patchId, kind,
                blob,
                ts: Date.now(),
            });
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
        // Fire-and-forget LRU cleanup so it doesn't block the caller.
        _evictLruClips(db).catch(() => {});
        return true;
    } catch (err) {
        console.warn('[clips] _storeBlob failed:', err?.message || err);
        return false;
    }
}

export async function getBlobUrl(patchId, kind) {
    if (!patchId) return null;
    try {
        const db = await _openClipDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(_CLIP_DB_STORE, 'readonly');
            const req = tx.objectStore(_CLIP_DB_STORE).get(`${patchId}:${kind}`);
            req.onsuccess = () => {
                const rec = req.result;
                if (!rec || !rec.blob) return resolve(null);
                resolve(URL.createObjectURL(rec.blob));
            };
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

export async function hasStoredClips(patchId) {
    if (!patchId) return false;
    try {
        const db = await _openClipDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(_CLIP_DB_STORE, 'readonly');
            const store = tx.objectStore(_CLIP_DB_STORE);
            const beforeReq = store.get(`${patchId}:before`);
            const afterReq  = store.get(`${patchId}:after`);
            let done = 0;
            let okBefore = false, okAfter = false;
            const check = () => { if (++done === 2) resolve(okBefore && okAfter); };
            beforeReq.onsuccess = () => { okBefore = !!beforeReq.result?.blob; check(); };
            beforeReq.onerror   = check;
            afterReq.onsuccess  = () => { okAfter  = !!afterReq.result?.blob;  check(); };
            afterReq.onerror    = check;
        });
    } catch {
        return false;
    }
}

/* ── Master enable/disable switch ────────────────────────────────
 *
 * A single localStorage flag that the patch applier checks before
 * applying ANY patch. When false, the user sees the platform default
 * (= whatever ships in git main) without losing their commit history.
 * Toggling back on restores their lobby to exactly the state it was
 * in before they flipped the switch.
 *
 * Different from `togglePatch(patchId)` (per-patch on/off via a
 * `toggle` commit). The master switch is non-destructive — it doesn't
 * touch the commit chain at all, so it never shows up in `/profile/upgrades`
 * as a commit row. Pure runtime gating. */
const _MASTER_KEY = 'dexhero:upgrades:master-enabled';

export function getMasterEnabled() {
    try {
        const raw = localStorage.getItem(_MASTER_KEY);
        if (raw === null) return true;       // default ON
        return raw !== 'false';
    } catch { return true; }
}

export function setMasterEnabled(enabled) {
    try {
        localStorage.setItem(_MASTER_KEY, enabled ? 'true' : 'false');
    } catch {}
    // Re-apply so the lobby reflects the new state instantly.
    document.dispatchEvent(new CustomEvent('dexhero:upgrades-changed', {
        bubbles: true,
        detail: { reason: 'master-toggle', enabled: !!enabled },
    }));
}

/* ── Comments per patch ─────────────────────────────────────────
 *
 * Stage A: a single localStorage entry mapping patchId → [comments].
 * Each comment is `{ id, patchId, wallet, username, body, ts }`.
 *
 * The DNA Feed's social-card footer (renderSocialFooter) reads the
 * count via getCommentCount; the patch detail page's comments section
 * reads the full list. addComment dispatches `dexhero:comment-added`
 * with the patchId so every card's count chip can live-update.
 *
 * Stage B mirror: when localStorage['dexhero:upgrades:backend']='1'
 * is set, also POSTs to /api/upgrades/:id/comments — but the local
 * cache stays authoritative for reads so the UI feels instant. */
const _COMMENTS_KEY = 'dexhero:upgrades:comments:v1';

function _readCommentsAll() {
    try {
        const raw = localStorage.getItem(_COMMENTS_KEY);
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
}
function _writeCommentsAll(map) {
    try { localStorage.setItem(_COMMENTS_KEY, JSON.stringify(map)); }
    catch {}
}

export function getComments(patchId) {
    if (!patchId) return [];
    const all = _readCommentsAll();
    const list = Array.isArray(all[patchId]) ? all[patchId] : [];
    // Cheap sort: oldest first so the reader scrolls down chronologically.
    return [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export function getCommentCount(patchId) {
    if (!patchId) return 0;
    const all = _readCommentsAll();
    return Array.isArray(all[patchId]) ? all[patchId].length : 0;
}

export function addComment(patchId, { body, wallet, username } = {}) {
    if (!patchId) return null;
    const text = String(body || '').trim();
    if (!text) return null;
    const comment = {
        id: `c_${Date.now().toString(36)}_${_shortRand()}`,
        patchId,
        wallet:   wallet   || 'local:me',
        username: username || 'you',
        body:     text.slice(0, 800),         // sane upper bound
        ts:       Date.now(),
    };
    const all = _readCommentsAll();
    const list = Array.isArray(all[patchId]) ? all[patchId].slice() : [];
    list.push(comment);
    all[patchId] = list;
    _writeCommentsAll(all);
    try {
        document.dispatchEvent(new CustomEvent('dexhero:comment-added', {
            bubbles: true,
            detail: { patchId, count: list.length, comment },
        }));
    } catch {}
    return comment;
}

/* ── Persistent store — GIT-STYLE COMMIT CHAIN ──────────────────
 *
 * Every action the user takes (authoring a patch, adopting one,
 * enabling/disabling, reverting) becomes a commit on their personal
 * branch. The store is a flat commit log + a HEAD pointer.
 *
 * Active state at any moment = replay the chain from genesis to HEAD,
 * applying each commit's op, skipping commits that have been reverted
 * by a later `revert` commit.
 *
 * Properties this buys us:
 *   • Nothing is destructive — every state the user has been in is
 *     a commit, addressable by id, recoverable via checkout.
 *   • The community feed sees the same snapshot from every wallet
 *     because adoption snapshots the patch at commit time.
 *   • "Revert to here" is a single HEAD move; the now-stale commits
 *     are still in the log, displayed as out-of-chain.
 *   • Adoption is INSTANT on consent — no "save" half-step.
 *
 * Commit shape:
 *   { id, parent_id, ts, author, op, patch_id, patch_snapshot,
 *     reverts_commit, message }
 *
 * Ops:
 *   - genesis : the baseline (one row, immutable)
 *   - author  : user authored a new patch (patch_snapshot = full patch)
 *   - adopt   : user adopted a community patch (patch_snapshot = snapshot of fixture)
 *   - revert  : undoes a specific earlier commit (reverts_commit = target id)
 *   - toggle  : flips enable state for a patch (patch_id)
 */

function readStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return defaultStore();
        const parsed = JSON.parse(raw);
        if (parsed.schema !== SCHEMA_VERSION) return defaultStore();
        return parsed;
    } catch {
        return defaultStore();
    }
}

function defaultStore() {
    const genesis = {
        id: 'commit_genesis',
        parent_id: null,
        ts: '2026-01-01T00:00:00Z',
        author: 'platform',
        op: 'genesis',
        patch_id: null,
        patch_snapshot: null,
        reverts_commit: null,
        message: 'main · platform default base',
    };
    return {
        schema: SCHEMA_VERSION,
        commits: [genesis],
        head: genesis.id,
    };
}

function writeStore(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}

function _shortRand() {
    return Math.random().toString(36).slice(2, 8);
}

/* Append a new commit on top of HEAD. */
function _commit({ op, patch_id, patch_snapshot, reverts_commit, message }) {
    const s = readStore();
    const c = {
        id: `commit_${Date.now().toString(36)}_${_shortRand()}`,
        parent_id: s.head,
        ts: new Date().toISOString(),
        author: 'local:me',
        op,
        patch_id: patch_id || (patch_snapshot && patch_snapshot.id) || null,
        patch_snapshot: patch_snapshot ? JSON.parse(JSON.stringify(patch_snapshot)) : null,
        reverts_commit: reverts_commit || null,
        message: message || '',
    };
    s.commits.push(c);
    s.head = c.id;
    writeStore(s);
    document.dispatchEvent(new CustomEvent('dexhero:upgrades-changed', { bubbles: true }));
    document.dispatchEvent(new CustomEvent('dexhero:commit-added', { bubbles: true, detail: { commit: c } }));
    return c;
}

/* Walk parent pointers from HEAD back to genesis. Returns oldest→newest. */
function _activeChain() {
    const s = readStore();
    const byId = new Map(s.commits.map((c) => [c.id, c]));
    const chain = [];
    let cur = byId.get(s.head);
    let guard = 0;
    while (cur && guard++ < 10_000) {
        chain.push(cur);
        cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    return chain.reverse();
}

/* Replay the active chain into a live state snapshot. */
function _replay(chain = _activeChain()) {
    // First pass: collect commits that have been reverted.
    const reverted = new Set();
    for (const c of chain) {
        if (c.op === 'revert' && c.reverts_commit) reverted.add(c.reverts_commit);
    }
    const state = {
        authoredOrder: [],   // patch objects in adoption order (newest first)
        adoptedOrder: [],
        toggleCount: new Map(),
    };
    for (const c of chain) {
        if (c.op === 'genesis' || c.op === 'revert') continue;
        if (reverted.has(c.id)) continue;
        if (c.op === 'author' && c.patch_snapshot) {
            state.authoredOrder.unshift(c.patch_snapshot);
        } else if (c.op === 'adopt' && c.patch_snapshot) {
            if (!state.adoptedOrder.some((p) => p.id === c.patch_snapshot.id)) {
                state.adoptedOrder.unshift(c.patch_snapshot);
            }
        } else if (c.op === 'toggle' && c.patch_id) {
            state.toggleCount.set(c.patch_id, (state.toggleCount.get(c.patch_id) || 0) + 1);
        }
    }
    state.disabled = new Set();
    for (const [id, count] of state.toggleCount) {
        if (count % 2 === 1) state.disabled.add(id);
    }
    return state;
}

/* ── Public API: read state ──────────────────────────────────── */

export function getCommits() {
    return readStore().commits.slice();
}

export function getActiveChain() {
    return _activeChain();
}

export function getHead() {
    return readStore().head;
}

export function getStaleCommits() {
    // Commits in the log but not in the active chain (orphaned by a
    // checkout to an earlier commit, or by a later revert).
    const chain = new Set(_activeChain().map((c) => c.id));
    return readStore().commits.filter((c) => !chain.has(c.id));
}

export function getAuthored() {
    return _replay().authoredOrder;
}

export function getAdopted() {
    return _replay().adoptedOrder;
}

export function isAdopted(patchId) {
    return _replay().adoptedOrder.some((p) => p.id === patchId);
}

export function getDisabled() {
    return _replay().disabled;
}

export function isEnabled(patchId) {
    return !_replay().disabled.has(patchId);
}

/* ── Public API: write state ─────────────────────────────────── */

/* Commit an authored patch. Always becomes the new HEAD. */
export function saveAuthored(patch) {
    const stored = {
        ...patch,
        // Preserve an existing id (set by attachDemoVideo during /upgrade so
        // the recorder's IndexedDB blobs already key against this patch).
        // If none present, mint a new one.
        id: patch.id || `patch_user_${Date.now().toString(36)}_${_shortRand()}`,
        author_wallet: patch.author_wallet || 'local:me',
        author_username: patch.author_username || 'you',
        adoption_count: 0,
        is_promoted_to_main: false,
        version: 1,
        parent_patch_id: null,        // No forking in this model.
        created_at: new Date().toISOString(),
        demo_video: patch.demo_video || buildDefaultDemoVideo(patch, { dexheroName: patch.recorded_by || 'Your DexHero' }),
        caption: patch.caption || _fallbackCaption(patch),
        tags: (Array.isArray(patch.tags) && patch.tags.length) ? patch.tags.slice(0, 5) : _fallbackTags(patch),
    };
    _commit({
        op: 'author',
        patch_snapshot: stored,
        message: `commit · authored "${stored.title}"`,
    });
    return stored;
}

/* Adopt a community patch — instant, no extra confirmation beyond the
 * capability consent dialog (which the caller handles when behaviors
 * are present). Creates an adopt commit; the patch is live immediately. */
export function adoptPatch(patchId) {
    if (isAdopted(patchId)) return null;
    // Search the FULL corpus: fixtures AND authored patches. A user can
    // adopt any patch the moment its author commits + pushes — promotion
    // to platform default is a separate, optional event downstream.
    const authored = _replay().authoredOrder || [];
    const patch = [...FIXTURE_PATCHES, ...authored].find((p) => p.id === patchId);
    if (!patch) return null;
    patch.adoption_count = (patch.adoption_count || 0) + 1;
    return _commit({
        op: 'adopt',
        patch_snapshot: { ...patch },
        message: `commit · adopted "${patch.title}" by ${patch.author_username}`,
    });
}

/* Reverse the latest adopt commit for this patch via a revert commit. */
export function unadoptPatch(patchId) {
    const chain = _activeChain();
    const adoptCommit = [...chain].reverse()
        .find((c) => c.op === 'adopt' && c.patch_snapshot && c.patch_snapshot.id === patchId);
    if (!adoptCommit) return null;
    return _commit({
        op: 'revert',
        patch_id: patchId,
        reverts_commit: adoptCommit.id,
        message: `revert · unadopted "${adoptCommit.patch_snapshot.title}"`,
    });
}

export function togglePatch(patchId) {
    const enabled = isEnabled(patchId);
    return _commit({
        op: 'toggle',
        patch_id: patchId,
        message: `commit · ${enabled ? 'disabled' : 'enabled'} patch`,
    });
}

/* Revert a specific commit (creates a new revert commit). Used by the
 * commit log UI's "Undo this commit" affordance. */
export function revertCommit(commitId) {
    const s = readStore();
    const target = s.commits.find((c) => c.id === commitId);
    if (!target || target.op === 'genesis') return null;
    const desc = target.message?.replace(/^commit · /, '') || commitId;
    return _commit({
        op: 'revert',
        reverts_commit: commitId,
        message: `revert · undid "${desc}"`,
    });
}

/* Move HEAD to an earlier commit. Commits past the new HEAD remain in
 * the log (visible as stale / out-of-chain), nothing is destroyed.
 * If the user makes a new commit while HEAD is rewound, the new commit
 * branches from the rewound HEAD and the previously-active "future"
 * commits stay orphaned in the log. Pure git semantics. */
export function checkoutCommit(commitId) {
    const s = readStore();
    if (!s.commits.some((c) => c.id === commitId)) return;
    s.head = commitId;
    writeStore(s);
    document.dispatchEvent(new CustomEvent('dexhero:upgrades-changed', { bubbles: true }));
    document.dispatchEvent(new CustomEvent('dexhero:head-moved', { bubbles: true, detail: { head: commitId } }));
}

/* Active patches = (promoted in default base) + (user's authored + adopted from chain).
 * Order: promoted first (in adoption order), then user commits in commit order. */
export function getActivePatches() {
    // Platform default = whatever ships in git main. The patch applier
    // ONLY layers the user's own patches (authored + adopted) on top of
    // that default. `is_promoted_to_main` is a creator-credit flag that
    // surfaces on /credits + as gold rungs in the DNA chart — it does
    // NOT cause the patch's CSS to auto-apply, because by the time the
    // platform team promotes a patch they've already ported its CSS
    // into the repo (so the next `git push` deploys it as default code).
    const replay = _replay();
    const user = [...replay.authoredOrder, ...replay.adoptedOrder];
    const seen = new Set();
    const merged = [];
    for (const p of user) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
    }
    return merged.filter((p) => !replay.disabled.has(p.id));
}

/* Community feed: union of fixtures + user-authored (which auto-publish
 * the moment they're committed). Reads "mine" from the active commit
 * chain — every `author` op contributes its patch_snapshot here. */
export function getCommunityFeed({ sort = 'top', surface = 'all', includeMine = true } = {}) {
    const mine = includeMine ? _replay().authoredOrder : [];
    const all = [...FIXTURE_PATCHES, ...mine];
    // Dedupe by id (a user-authored patch could share an id with a fixture
    // only if seeded manually; defensive).
    const seen = new Set();
    let list = [];
    for (const p of all) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        list.push(p);
    }
    if (surface !== 'all') list = list.filter((p) => p.target_surface === surface);
    if (sort === 'top') list.sort((a, b) => (b.adoption_count || 0) - (a.adoption_count || 0));
    else if (sort === 'new') list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return list;
}

/* Creator leaderboard for the ticker. Top N by total adoption count
 * across all of their patches. */
export function getCreatorLeaderboard(limit = 12) {
    const totals = new Map();
    for (const p of FIXTURE_PATCHES) {
        const cur = totals.get(p.author_wallet) || { wallet: p.author_wallet, username: p.author_username, adopters: 0, hasPromoted: false };
        cur.adopters += p.adoption_count;
        if (p.is_promoted_to_main) cur.hasPromoted = true;
        totals.set(p.author_wallet, cur);
    }
    const list = [...totals.values()].sort((a, b) => b.adopters - a.adopters).slice(0, limit);
    // Stable mock "trending delta" — first few are trending up; older accounts neutral.
    return list.map((c, i) => ({
        ...c,
        change_24h: i < 3 ? +12 - i * 3 : i < 6 ? +3 : i % 2 === 0 ? -1 : 0,
    }));
}

/* Quick lookup: what glyph does a creator use as their avatar? Used by
 * the galaxy view to bake a creator's identity into the bubble core. */
export function getCreatorAvatar(username) {
    const c = FIXTURE_CREATORS.find((x) => x.username === username);
    return (c && c.avatar) || '◯';
}

export function getCreatorByUsername(username) {
    const c = FIXTURE_CREATORS.find((x) => x.username === username);
    if (!c) return null;
    const patches = FIXTURE_PATCHES.filter((p) => p.author_username === username);
    const totalAdopters = patches.reduce((sum, p) => sum + p.adoption_count, 0);
    const hasPromoted = patches.some((p) => p.is_promoted_to_main);
    return { ...c, patches, totalAdopters, hasPromoted };
}

export function getPatchById(id) {
    // Search fixtures + every patch in the user's branch history. Previous
    // versions referenced `store.authored` directly; the commit-chain
    // refactor replaced that field with the replay-derived `authoredOrder`.
    const authored = _replay().authoredOrder || [];
    return [...FIXTURE_PATCHES, ...authored].find((p) => p.id === id) || null;
}

export function getCreditsList() {
    return FIXTURE_PATCHES
        .filter((p) => p.is_promoted_to_main)
        .map((p) => ({
            patch: p,
            creator: FIXTURE_CREATORS.find((c) => c.username === p.author_username) || null,
        }))
        .sort((a, b) => (b.patch.promoted_at || '').localeCompare(a.patch.promoted_at || ''));
}

/* ── Canned proposal generator for Stage A ──────────────────────
 * Maps user `/upgrade <text>` requests to predetermined proposal
 * payloads. Pattern-matched on keywords so the prototype responds
 * to a handful of intents without needing a real LLM call. */
export function generateMockProposal(userText) {
    const text = String(userText || '').toLowerCase().trim();

    // Manifest-violation refusal — protected surfaces can be restyled
    // but not removed/hidden. The dexhero refuses politely.
    if (/\b(hide|remove|delete|kill|drop)\b/.test(text) &&
        /\b(chat\s*log|input|main\s*text|model\s*view|dexhero\s*bar|selection\s*bar|create|playable internet)\b/.test(text)) {
        return {
            kind: 'refusal',
            reason: 'manifest_violation',
            message: 'That touches a Platform Manifest surface — I can restyle it, reposition it, even reskin it, but I can\'t remove or hide it. The five protected surfaces (chat log, main input, model view, dexhero bar, Create section) must always exist. Want me to make it more compact or move it instead?',
        };
    }

    // Particle / sparkle / glow / pulse → behavior patch
    if (/\b(particle|sparkle|glow|pulse|animate|animation)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Pulsing slot highlight',
                description: 'Adds a soft cyan pulse around the active equipment slot every time you activate one.',
                target_surface: 'equipment-slot',
                manifest_version: '1.0',
                css: `@keyframes user-slot-pulse { 0% { box-shadow: 0 0 0 0 rgba(120,220,255,0.55); } 70% { box-shadow: 0 0 0 16px rgba(120,220,255,0); } 100% { box-shadow: 0 0 0 0 rgba(120,220,255,0); } }
.equipment-slot.is-active, .lobby-equipment-slot.is-active { animation: user-slot-pulse 1.4s ease-out infinite !important; }`,
                config: {},
                behaviors: [
                    { id: 'on-slot-active', trigger: 'event:dexhero:slot-active', capabilities_requested: ['events.subscribe', 'dom.style'] },
                ],
                parent_patch_id: null,
            },
        };
    }

    // Dark / darker / black / night → CSS-var compact-dark patch
    if (/\b(dark|darker|black|night|moody|deep|matte)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Deeper darks everywhere',
                description: 'Pushes the lobby background, popover surfaces, and panels closer to true black. Higher contrast text accents.',
                target_surface: 'global',
                manifest_version: '1.0',
                css: `:root { --bg-primary: #050608 !important; --ink-3: #8a8c8e !important; --rule: rgba(255,255,255,0.05) !important; }
.lobby-equipment-popover, .equipment-popover, .panel--codex, .panel--right { background: #080a0c !important; border-color: rgba(255,255,255,0.04) !important; }`,
                config: {},
                behaviors: [],
                parent_patch_id: null,
            },
        };
    }

    // Compact / tight / dense / smaller → CSS spacing patch
    if (/\b(compact|tight|dense|small|smaller|tiny|condense)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Compact popovers',
                description: 'Tightens padding, line-height, and gaps inside every slot popover.',
                target_surface: 'equipment-slot',
                manifest_version: '1.0',
                css: `.lobby-equipment-popover, .equipment-popover { padding: 10px !important; }
.lobby-equipment-popover .lobby-equipment-popover__row, .equipment-popover__row { padding: 6px 8px !important; }
.lobby-equipment-popover *, .equipment-popover * { line-height: 1.3 !important; }`,
                config: {},
                behaviors: [],
                parent_patch_id: null,
            },
        };
    }

    // Rename / microcopy / rebrand → microcopy patch
    if (/\b(rename|relabel|microcopy|rebrand|call|word)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Softer slot vocabulary',
                description: 'Renames slot labels: Brain → Mind, Body → Form, Voice → Tone, Movement → Stride.',
                target_surface: 'equipment-slot',
                manifest_version: '1.0',
                css: '',
                config: {
                    'microcopy.equipment-slot.title.brain':    'Mind',
                    'microcopy.equipment-slot.title.body':     'Form',
                    'microcopy.equipment-slot.title.voice':    'Tone',
                    'microcopy.equipment-slot.title.movement': 'Stride',
                },
                behaviors: [],
                parent_patch_id: null,
            },
        };
    }

    // Rows / list / vertical → layout-variant patch
    if (/\b(row|rows|list|vertical|stack|stacked)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Rows-style inventory',
                description: 'Switches every slot picker\'s inventory from grid tiles to a vertical row list.',
                target_surface: 'equipment-slot',
                manifest_version: '1.0',
                css: '',
                config: { 'equipment-slot.inventory.layout': 'rows' },
                behaviors: [],
                parent_patch_id: null,
            },
        };
    }

    // Neon / cyan / glow ticker
    if (/\b(neon|cyan|glow|color)\b/.test(text)) {
        return {
            kind: 'proposal',
            patch: {
                title: 'Neon ticker accent',
                description: 'Adds a glowing cyan tint to the creator-attribution ticker text + numbers.',
                target_surface: 'header-ticker',
                manifest_version: '1.0',
                css: `.lobby-ticker__item strong { color: #6ff5ff !important; text-shadow: 0 0 8px rgba(111,245,255,0.4) !important; }
.lobby-ticker__item .up { color: #6ff5ff !important; }`,
                config: {},
                behaviors: [],
                parent_patch_id: null,
            },
        };
    }

    // Default fallback — a tasteful generic restyle so /upgrade always
    // produces something. The dexhero "tried its best".
    return {
        kind: 'proposal',
        patch: {
            title: 'Subtle lobby polish',
            description: 'A gentle pass: tighter ticker, slightly warmer accents, softer panel borders.',
            target_surface: 'global',
            manifest_version: '1.0',
            css: `.lobby-ticker { background: rgba(0,0,0,0.55) !important; }
.lobby-ticker__item strong { color: #e8d8a8 !important; }
.panel--codex, .panel--right { border-color: rgba(232,216,168,0.18) !important; }`,
            config: {},
            behaviors: [],
            parent_patch_id: null,
        },
    };
}

/* Attach a demo_video descriptor to a generated proposal — called by
 * stage-chat after the dexhero "records" its demonstration. Pure helper. */
export function attachDemoVideo(patch, { dexheroName = 'Your DexHero', caption } = {}) {
    return {
        ...patch,
        // Provisional ID so the recorder can key blobs in IndexedDB during
        // the BEFORE/AFTER capture phases. If saveAuthored later replaces
        // it with the real persisted ID, the blobs become orphaned and
        // get LRU-evicted naturally; for matching the proposal card that
        // mounts pre-save, the provisional ID is all we need.
        id: patch.id || `patch_proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        demo_video: buildDefaultDemoVideo({ ...patch, description: caption || patch.description }, { dexheroName }),
        caption: patch.caption || caption || _fallbackCaption(patch),
        tags: (Array.isArray(patch.tags) && patch.tags.length) ? patch.tags : _fallbackTags(patch),
    };
}

/* Build a summary string for a patch's diff — what surfaces it touches. */
export function describePatchChanges(patch) {
    const parts = [];
    if (patch.css) parts.push('CSS rules');
    const cfgKeys = Object.keys(patch.config || {});
    if (cfgKeys.length) parts.push(`${cfgKeys.length} config override${cfgKeys.length === 1 ? '' : 's'}`);
    if (Array.isArray(patch.behaviors) && patch.behaviors.length) {
        parts.push(`${patch.behaviors.length} behavior${patch.behaviors.length === 1 ? '' : 's'}`);
    }
    if (!parts.length) parts.push('no changes');
    const surface = patch.target_surface ? `target: ${patch.target_surface}` : '';
    return `${parts.join(' + ')}${surface ? ` · ${surface}` : ''}`;
}

/* Admin: promote a community patch into the platform default base.
 * Stage A — local-only flip (the FIXTURE_PATCHES entry's flag is
 * mutated; persisted across reloads via the store mirror). Stage E
 * adds a real wallet-allowlist-gated server endpoint that updates
 * the ui_patches row + recomputes the leaderboard.
 *
 * After promotion the patch is part of the default base for EVERY
 * user (applied before any user patches). The author appears
 * permanently on the /credits page. */
export function promotePatch(patchId, { promoter = 'platform' } = {}) {
    const patch = FIXTURE_PATCHES.find((p) => p.id === patchId);
    if (!patch) return null;
    if (patch.is_promoted_to_main) return patch;
    patch.is_promoted_to_main = true;
    patch.promoted_at = new Date().toISOString();
    patch.promoted_by = promoter;
    document.dispatchEvent(new CustomEvent('dexhero:upgrades-changed', { bubbles: true }));
    document.dispatchEvent(new CustomEvent('dexhero:patch-promoted', {
        bubbles: true, detail: { patch },
    }));
    return patch;
}

export function unpromotePatch(patchId) {
    const patch = FIXTURE_PATCHES.find((p) => p.id === patchId);
    if (!patch || !patch.is_promoted_to_main) return null;
    patch.is_promoted_to_main = false;
    patch.promoted_at = null;
    patch.promoted_by = null;
    document.dispatchEvent(new CustomEvent('dexhero:upgrades-changed', { bubbles: true }));
    return patch;
}

/* For prototype/dev — wipe local store. Useful from devtools. */
export function _resetStore() {
    try { localStorage.removeItem(STORE_KEY); } catch {}
}
if (typeof window !== 'undefined') {
    window.DexHeroUpgrades = {
        _resetStore,
        getActivePatches, getCommunityFeed, getCreatorLeaderboard,
        getCommits, getActiveChain, getHead, getStaleCommits,
        checkoutCommit, revertCommit,
        promotePatch, unpromotePatch,
    };
}

/* ── Stage B bridge ──────────────────────────────────────
 *
 * When `localStorage['dexhero:upgrades:backend'] === '1'` AND the
 * server's upgrades endpoints are reachable, mirror every local commit
 * to the server in the background. This lets the same `commit` /
 * `adopt` calls eventually persist to Supabase (Stage B.1) without the
 * UI layer needing to change. Errors are silent — the local mock store
 * remains authoritative until Stage B.1 inverts the relationship.
 *
 * Reads still come from the local store for snappy UI; cross-device
 * sync arrives once the swap completes. */
async function _bridgeIfEnabled(fn) {
    try {
        const api = await import('./upgrades-api.js');
        if (!api.isBackendEnabled()) return;
        await fn(api);
    } catch (err) {
        if (typeof console !== 'undefined') console.warn('[upgrades] backend bridge:', err?.message);
    }
}

// Bridge: every locally-committed action also hits the server endpoint
// when the backend flag is enabled. Stage B.1 will flip this to make
// the server authoritative.
document.addEventListener('dexhero:commit-added', (ev) => {
    const c = ev?.detail?.commit;
    if (!c) return;
    _bridgeIfEnabled(async (api) => {
        if (c.op === 'author' && c.patch_snapshot) {
            await api.commitAuthor(c.patch_snapshot);
        } else if (c.op === 'adopt' && c.patch_id) {
            await api.commitAdopt(c.patch_id);
        } else if (c.op === 'revert' && c.reverts_commit) {
            await api.commitRevert(c.reverts_commit, { message: c.message });
        } else if (c.op === 'toggle' && c.patch_id) {
            await api.commitToggle(c.patch_id);
        }
    });
});
