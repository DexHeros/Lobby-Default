/* connect-master.js — unified Connections popover.
 *
 * Single header chip + dropdown. Lists every platform the user might
 * link to their wallet (Linktree-style) so the wallet becomes the
 * master key across all linked services.
 *
 * UX rules in force:
 *   - Wallet row is the gateway, always at top.
 *   - A search input sits directly under the wallet row.
 *   - By default the AI brains list is collapsed to the three most-
 *     used providers (Anthropic, OpenAI, Google) + any provider the
 *     wallet has already linked. The full list comes up via search.
 *   - When search has a query, every provider/platform whose
 *     name/tagline matches stays visible; non-matches hide.
 *   - "Soon" stubs hide while searching to keep results clean.
 *
 * Row clicks route to the existing wire-ups (LLM modal via custom
 * event, Steam OAuth begin, wallet connect/disconnect) — no logic
 * is duplicated here, only labeled and surfaced.
 */

import * as wallet from '../services/wallet.js';
import { getAllAccounts as getAllLlmAccounts } from '../services/llm-connect.js';
import { PROVIDERS } from '../services/llm-providers.js';
import { providerGlyph } from './icons-llm.js';
import { steamFetch } from '../services/steam-session.js';
import { on, E } from '../events.js';
import { getCurrentSubject } from '../stage.js';
import { toast } from './toast.js';

const DEFAULT_BRAINS = ['anthropic', 'openai', 'google'];

const SLOT_DEFS = [
    { id: 'brain',    label: 'Brain',    workshopPart: 'brain' },
    { id: 'voice',    label: 'Voice',    workshopPart: 'voice' },
    { id: 'body',     label: 'Body',     workshopPart: 'body' },
    { id: 'movement', label: 'Movement', workshopPart: 'movement' },
];

/* Companies the user can link to their wallet, organized by category.
 * Steam is the only one with a live OAuth backend today; everything
 * else lands as a "Soon" stub until its connector is wired. Adding a
 * new platform = one row in this array; the per-category rendering +
 * search + filter all pick it up automatically. */
const PLATFORM_CATEGORIES = [
    {
        id: 'development', label: 'Development',
        items: [
            { id: 'github',      title: 'GitHub',       meta: 'Code + creator module repos' },
            { id: 'gitlab',      title: 'GitLab',       meta: 'Alt code host' },
            { id: 'npm',         title: 'npm',          meta: 'Package publisher' },
            { id: 'vercel',      title: 'Vercel',       meta: 'Deploy automation' },
            { id: 'huggingface', title: 'Hugging Face', meta: 'Model hub' },
        ],
    },
    {
        id: 'gaming', label: 'Gaming',
        steam: true,                                   // Steam injected at top
        items: [
            { id: 'epic',      title: 'Epic Games',          meta: 'Launcher library' },
            { id: 'battlenet', title: 'Battle.net',          meta: 'Blizzard library' },
            { id: 'xbox',      title: 'Xbox Live',           meta: 'Microsoft gaming' },
            { id: 'psn',       title: 'PlayStation Network', meta: 'Sony gaming' },
            { id: 'riot',      title: 'Riot Games',          meta: 'League / Valorant' },
            { id: 'twitch',    title: 'Twitch',              meta: 'Streaming + drops' },
        ],
    },
    {
        id: 'social', label: 'Social',
        items: [
            { id: 'discord',   title: 'Discord',   meta: 'Sign-in + roles' },
            { id: 'x',         title: 'X',         meta: 'Auto-post activity' },
            { id: 'farcaster', title: 'Farcaster', meta: 'Onchain social' },
            { id: 'lens',      title: 'Lens',      meta: 'Decentralized social' },
            { id: 'telegram',  title: 'Telegram',  meta: 'Chat + bots' },
            { id: 'reddit',    title: 'Reddit',    meta: 'Communities' },
        ],
    },
    {
        id: 'finance', label: 'Finance',
        items: [
            { id: 'coinbase', title: 'Coinbase', meta: 'Exchange + wallet' },
            { id: 'stripe',   title: 'Stripe',   meta: 'Payments' },
            { id: 'binance',  title: 'Binance',  meta: 'Exchange' },
            { id: 'kraken',   title: 'Kraken',   meta: 'Exchange' },
            { id: 'paypal',   title: 'PayPal',   meta: 'Payments' },
        ],
    },
    {
        id: 'platform', label: 'Platform',
        items: [
            { id: 'apple',     title: 'Apple ID',  meta: 'iCloud + ecosystem' },
            { id: 'google',    title: 'Google',    meta: 'Workspace + Drive' },
            { id: 'microsoft', title: 'Microsoft', meta: 'Outlook + 365' },
            { id: 'spotify',   title: 'Spotify',   meta: 'Music + podcasts' },
        ],
    },
];

let _wired = false;
let _btn = null;
let _pop = null;
let _open = false;
let _query = '';
let _steamState = null;       // null | { linked, persona_name?, avatar_url? }
let _equippedBySlot = {};     // { brain?, voice?, body?, movement? } for current DexHero
let _equippedTokenId = null;  // token id _equippedBySlot belongs to
let _mcpState = { tokens: [] }; // paired Claude Code clients (last-6 previews only)
let _githubState = null;      // null | { linked: bool, github_username?, github_avatar_url? }

/* ── Row builders ──────────────────────────────────────────────── */

function walletRow(s) {
    const linked = !!s.connected;
    return rowHTML({
        id: 'wallet',
        glyph: walletSvg(),
        title: 'Wallet',
        meta: linked ? `Linked · ${short(s.address)}` : '',
        state: linked ? 'linked' : 'idle',
        action: linked ? 'Disconnect' : 'Start here',
    });
}

function pickBrains(s, accounts, query) {
    const q = query.toLowerCase().trim();
    if (q) {
        return PROVIDERS.filter((p) => {
            const hay = `${p.name || ''} ${p.tagline || ''} ${p.id || ''}`.toLowerCase();
            return hay.includes(q);
        });
    }
    // No query → show every AI provider. Used to trim to a short
    // "popular" set with a "+ N more brains" hint; users wanted the
    // full list visible by default so they can scan all options.
    return PROVIDERS.slice();
}

function llmRows(s, accounts, providers) {
    const accountsByProvider = new Map(accounts.map((a) => [a.provider, a]));
    return providers.map((p) => {
        const a = accountsByProvider.get(p.id);
        const linked = !!a;
        return rowHTML({
            id: `llm-${p.id}`,
            glyph: providerGlyph(p.id, { size: 16 }),
            title: p.name,
            meta: linked
                ? (a.model ? `Linked · ${a.model}` : 'Linked')
                : (p.tagline || 'AI provider'),
            state: linked ? 'linked' : (s.connected ? 'idle' : 'gated'),
            action: linked ? 'Manage' : (s.connected ? 'Link' : 'Connect wallet'),
        });
    }).join('');
}

/* ── Existing IDE connectors (MCP, subscription-billed) ────────── */

/* Distinct from AI Keys: these IDEs use the user's own subscription
 * (Claude Pro/Max, Cursor Pro, Windsurf, etc.) and connect to V3Labs
 * via the Model Context Protocol — we issue a bearer token, the user
 * registers it in their IDE's MCP config. Inference billing flows to
 * the IDE's subscription, not to V3Labs and not via API key. */
const IDE_CONNECTORS = [
    {
        id: 'claude-code',
        title: 'Claude Code',
        tagline: 'Anthropic CLI + VS Code · Pro/Max subscription',
        glyph: () => ideGlyph('claude'),
        instructions: ({ token, url }) => ([
            {
                kind: 'command',
                label: 'Paste into your terminal:',
                text: `claude mcp add v3labs --transport http --url ${url} --header "Authorization: Bearer ${token}"`,
            },
        ]),
    },
    {
        id: 'cursor',
        title: 'Cursor',
        tagline: 'AI-first VS Code fork · Cursor Pro',
        glyph: () => ideGlyph('cursor'),
        instructions: ({ token, url }) => ([
            {
                kind: 'json',
                label: 'Settings → MCP → Add server (or edit ~/.cursor/mcp.json):',
                text: JSON.stringify({
                    mcpServers: {
                        v3labs: { url, headers: { Authorization: `Bearer ${token}` } },
                    },
                }, null, 2),
            },
        ]),
    },
    {
        id: 'windsurf',
        title: 'Windsurf',
        tagline: 'Codeium\'s AI IDE',
        glyph: () => ideGlyph('windsurf'),
        instructions: ({ token, url }) => ([
            {
                kind: 'json',
                label: 'Cascade → MCP servers → Add (or edit ~/.codeium/windsurf/mcp_config.json):',
                text: JSON.stringify({
                    mcpServers: {
                        v3labs: { serverUrl: url, headers: { Authorization: `Bearer ${token}` } },
                    },
                }, null, 2),
            },
        ]),
    },
    {
        id: 'cline',
        title: 'Cline',
        tagline: 'VS Code extension · BYOK or Cline plan',
        glyph: () => ideGlyph('cline'),
        instructions: ({ token, url }) => ([
            {
                kind: 'json',
                label: 'Cline → MCP Servers → Edit Configuration:',
                text: JSON.stringify({
                    mcpServers: {
                        v3labs: {
                            type: 'streamableHttp',
                            url,
                            headers: { Authorization: `Bearer ${token}` },
                        },
                    },
                }, null, 2),
            },
        ]),
    },
];

function ideRows(s) {
    const tokensByLabel = new Map();
    for (const t of (_mcpState?.tokens || [])) {
        const k = String(t.label || '').toLowerCase();
        tokensByLabel.set(k, (tokensByLabel.get(k) || 0) + 1);
    }
    return IDE_CONNECTORS.map((ide) => {
        const n = tokensByLabel.get(ide.id.toLowerCase()) || tokensByLabel.get(ide.title.toLowerCase()) || 0;
        const linked = n > 0;
        return rowHTML({
            id: `ide-${ide.id}`,
            glyph: ide.glyph(),
            title: ide.title,
            meta: linked
                ? (n === 1 ? 'Linked' : `Linked · ${n}×`)
                : (s.connected ? ide.tagline : 'Connect wallet to pair'),
            state: linked ? 'linked' : (s.connected ? 'idle' : 'gated'),
            action: linked ? 'Add another' : (s.connected ? 'Pair' : 'Connect wallet'),
        });
    }).join('');
}

function ideGlyph(kind) {
    const svgs = {
        claude: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <path d="M7 17 L12 4 L17 17"/>
            <path d="M9.2 12.5 L14.8 12.5"/>
        </svg>`,
        cursor: `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
            <path d="M5 3 L19 12 L13 13.5 L11 20 Z"/>
        </svg>`,
        windsurf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <path d="M3 14 Q7 10 12 14 T21 14"/>
            <path d="M3 18 Q7 14 12 18 T21 18"/>
            <path d="M12 14 V4"/>
            <path d="M12 4 L18 7"/>
        </svg>`,
        cline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2"/>
            <polyline points="8 10 6 12 8 14"/>
            <line x1="11" y1="15" x2="14" y2="9"/>
        </svg>`,
    };
    return svgs[kind] || letterGlyph(kind?.[0] || '?');
}

// Retired — every provider now renders by default. The "+ N more
// brains / Search to find" CTA is gone; the top search bar handles
// filtering across the whole popover when the user wants to narrow.
function moreBrainsHintHTML() { return ''; }

function slotRow(slot) {
    const equipped = _equippedBySlot[slot.id];
    const linked = !!equipped;
    return rowHTML({
        id: `slot-${slot.id}`,
        glyph: slotGlyph(slot.id),
        title: slot.label,
        meta: linked
            ? `Equipped · ${equipped.name || equipped.id}`
            : 'No module equipped',
        state: linked ? 'linked' : 'idle',
        action: null,           // slot rows are click-through; no pill
    });
}

function slotGlyph(slotId) {
    // Tiny inline SVGs that read at 16px. Matches the slot popovers'
    // per-category accent color hints.
    const svgs = {
        brain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <path d="M9 3a3 3 0 0 0-3 3v2a3 3 0 0 0 0 6v2a3 3 0 0 0 3 3"/>
            <path d="M15 3a3 3 0 0 1 3 3v2a3 3 0 0 1 0 6v2a3 3 0 0 1-3 3"/>
            <path d="M9 7v10"/>
            <path d="M15 7v10"/>
        </svg>`,
        voice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <path d="M3 12 L5 12"/>
            <path d="M7 9 L7 15"/>
            <path d="M10 6 L10 18"/>
            <path d="M13 4 L13 20"/>
            <path d="M16 8 L16 16"/>
            <path d="M19 10 L19 14"/>
            <path d="M21 12 L23 12"/>
        </svg>`,
        body: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <circle cx="12" cy="5" r="3"/>
            <path d="M8 22v-7a4 4 0 0 1 8 0v7"/>
            <line x1="9" y1="14" x2="9" y2="22"/>
            <line x1="15" y1="14" x2="15" y2="22"/>
        </svg>`,
        movement: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <path d="M 4 16 A 8 8 0 0 1 20 16"/>
            <path d="M 20 8 A 8 8 0 0 0 4 8"/>
            <polyline points="20,12 20,8 16,8"/>
            <polyline points="4,12 4,16 8,16"/>
        </svg>`,
    };
    return svgs[slotId] || letterGlyph(slotId.charAt(0));
}

function steamRow() {
    const linked = !!_steamState?.linked;
    const name = _steamState?.persona_name || '';
    return rowHTML({
        id: 'steam',
        glyph: steamSvg(),
        title: 'Steam',
        meta: linked ? `Linked${name ? ' · ' + name : ''}` : 'Sign in to map your library',
        state: linked ? 'linked' : 'idle',
        action: linked ? 'Manage' : 'Link',
    });
}

function categoryHTML(category) {
    // Steam (Gaming) + GitHub (Development) are the platforms with a
    // live OAuth backend today; each gets a real row pinned at the top
    // of its category. Everything else renders as a "Soon" stub.
    let rows = '';
    if (category.steam) rows += steamRow();
    rows += category.items.map((item) => {
        if (item.id === 'github') return githubRow();
        return rowHTML({
            id: `stub-${item.id}`,
            glyph: letterGlyph(item.title.charAt(0)),
            title: item.title,
            meta: item.meta,
            state: 'soon',
            action: 'Soon',
        });
    }).join('');
    return rows;
}

function githubRow() {
    const s = wallet.getStatus();
    const linked = !!_githubState?.linked;
    const handle = _githubState?.github_username || '';
    return rowHTML({
        id: 'github',
        glyph: githubGlyph(),
        title: 'GitHub',
        meta: linked
            ? `Linked · @${handle}`
            : (s.connected ? 'Link to post repos to the Genetics feed' : 'Connect wallet to link'),
        state: linked ? 'linked' : (s.connected ? 'idle' : 'gated'),
        action: linked ? 'Unlink' : (s.connected ? 'Link' : 'Connect wallet'),
    });
}

function githubGlyph() {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
        <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/>
    </svg>`;
}

function filterPlatformRows(rowsHTML, query) {
    // Quick HTML filter — pull each <button>...</button> and keep if
    // its inner text matches the query. Cheap because there are <10
    // platform rows total.
    if (!query) return rowsHTML;
    const q = query.toLowerCase().trim();
    if (!q) return rowsHTML;
    const tmp = document.createElement('div');
    tmp.innerHTML = rowsHTML;
    Array.from(tmp.querySelectorAll('.connect-master__row')).forEach((el) => {
        const txt = (el.textContent || '').toLowerCase();
        // Hide "soon" stubs while searching unless their name matches.
        const isSoon = el.classList.contains('connect-master__row--soon');
        const matches = txt.includes(q);
        if (!matches || (isSoon && !el.querySelector('.connect-master__row-title').textContent.toLowerCase().includes(q))) {
            el.remove();
        }
    });
    return tmp.innerHTML;
}

function rowHTML({ id, glyph, title, meta, state, action }) {
    const actionHTML = action
        ? `<span class="connect-master__row-action">${escHtml(action)}</span>`
        : '';
    return `
        <button type="button" class="connect-master__row connect-master__row--${escAttr(state)}${action ? '' : ' connect-master__row--no-action'}" data-row="${escAttr(id)}">
            <span class="connect-master__row-glyph">${glyph || ''}</span>
            <span class="connect-master__row-body">
                <span class="connect-master__row-title">${escHtml(title)}</span>
                <span class="connect-master__row-meta">${escHtml(meta)}</span>
            </span>
            ${actionHTML}
        </button>`;
}

/* ── SSO offer (DexHero as identity provider) ──────────────────── */

function ssoFooterHTML(s) {
    if (!s.connected) return '';
    return `
        <div class="connect-master__sso">
            <div class="connect-master__sso-title">Sign in with DexHero</div>
            <div class="connect-master__sso-meta">Any site can accept your wallet as the login. They only see your wallet address; everything linked above stays in your vault.</div>
            <button type="button" class="connect-master__sso-cta" data-row="sso">Get embed snippet</button>
        </div>`;
}

/* ── Paint ─────────────────────────────────────────────────────── */

function paintShell() {
    if (!_pop) return;
    const s = wallet.getStatus();
    const me = s.address ? s.address.toLowerCase() : '';
    const accounts = me ? getAllLlmAccounts(me) : [];
    const linkedCount = (s.connected ? 1 : 0) + accounts.length + (_steamState?.linked ? 1 : 0);

    _pop.innerHTML = `
        <div class="connect-master__search">
            <svg class="connect-master__search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="7" cy="7" r="5"></circle>
                <line x1="11" y1="11" x2="14" y2="14"></line>
            </svg>
            <input type="search" class="connect-master__search-input"
                data-search-input
                placeholder="Search platforms…"
                value="${escAttr(_query)}"
                aria-label="Search platforms">
        </div>
        <div class="connect-master__group-label" data-wallet-label>Defi</div>
        <div class="connect-master__group" data-wallet-row>
            ${walletRow(s)}
        </div>
        <div class="connect-master__group-label" data-brains-label>AI Keys</div>
        <div class="connect-master__group" data-brains></div>
        <div class="connect-master__group-label" data-ides-label>Existing IDE</div>
        <div class="connect-master__group" data-ides></div>
        ${PLATFORM_CATEGORIES.map((c) => `
            <div class="connect-master__group-label" data-cat-label="${escAttr(c.id)}">${escHtml(c.label)}</div>
            <div class="connect-master__group" data-cat="${escAttr(c.id)}"></div>
        `).join('')}
        <div class="connect-master__group-label" data-loadout-label>Your DexHero</div>
        <div class="connect-master__group" data-loadout></div>
        <div data-web-search-slot></div>
        <div data-sso-slot>${ssoFooterHTML(s)}</div>
        <div class="connect-master__foot">
            <span class="connect-master__foot-hint">Your wallet is the master key — links above re-hydrate on every sign-in.</span>
        </div>
    `;

    // Update header count badge to match.
    const countEl = document.getElementById('lobby-connect-count');
    if (countEl) {
        if (linkedCount > 0) {
            countEl.textContent = String(linkedCount);
            countEl.hidden = false;
        } else {
            countEl.hidden = true;
        }
    }
    if (_btn) _btn.setAttribute('data-linked-count', String(linkedCount));

    // Wire the search input + initial body paint.
    const search = _pop.querySelector('[data-search-input]');
    if (search) {
        search.addEventListener('input', (ev) => {
            _query = String(ev.target.value || '');
            paintRows();
        });
    }
    paintRows();
    bindRows();
}

function paintRows() {
    if (!_pop) return;
    const s = wallet.getStatus();
    const me = s.address ? s.address.toLowerCase() : '';
    const accounts = me ? getAllLlmAccounts(me) : [];
    const brains = pickBrains(s, accounts, _query);

    const loadoutEl   = _pop.querySelector('[data-loadout]');
    const loadoutLbl  = _pop.querySelector('[data-loadout-label]');
    const brainsEl    = _pop.querySelector('[data-brains]');
    const brainsLabel = _pop.querySelector('[data-brains-label]');
    const idesEl      = _pop.querySelector('[data-ides]');
    const idesLabel   = _pop.querySelector('[data-ides-label]');

    // ── Loadout (Brain / Voice / Body / Movement for current DexHero) ──
    let loadoutHTML = SLOT_DEFS.map(slotRow).join('');
    loadoutHTML = filterPlatformRows(loadoutHTML, _query);
    if (loadoutEl) loadoutEl.innerHTML = loadoutHTML;
    if (loadoutLbl) loadoutLbl.style.display = loadoutHTML.trim() ? '' : 'none';

    // ── Per-category platform sections ─────────────────────────────
    for (const cat of PLATFORM_CATEGORIES) {
        const groupEl = _pop.querySelector(`[data-cat="${cat.id}"]`);
        const labelEl = _pop.querySelector(`[data-cat-label="${cat.id}"]`);
        if (!groupEl) continue;
        let html = categoryHTML(cat);
        html = filterPlatformRows(html, _query);
        groupEl.innerHTML = html;
        if (labelEl) labelEl.style.display = html.trim() ? '' : 'none';
    }

    if (brainsEl) {
        brainsEl.innerHTML = llmRows(s, accounts, brains);
    }
    if (brainsLabel) brainsLabel.style.display = brains.length ? '' : 'none';

    // ── Existing IDE (MCP — subscription-billed: Claude Code, Cursor, …) ──
    let idesHTML = ideRows(s);
    idesHTML = filterPlatformRows(idesHTML, _query);
    if (idesEl) idesEl.innerHTML = idesHTML;
    if (idesLabel) idesLabel.style.display = idesHTML.trim() ? '' : 'none';

    // ── Web-search fallback ────────────────────────────────────────
    // When the user types something into the top search bar and none
    // of our curated sections match, surface a "Search the web for X"
    // affordance. Clicking it opens a Google search in a new tab so
    // the user can discover sign-in / credential platforms beyond the
    // built-in catalog. Hidden when the query is empty or when any
    // local rows did match.
    const webSlot = _pop.querySelector('[data-web-search-slot]');
    if (webSlot) {
        const q = (_query || '').trim();
        const anyLocalMatch = (
            (loadoutEl?.innerHTML.trim()) ||
            PLATFORM_CATEGORIES.some((c) => _pop.querySelector(`[data-cat="${c.id}"]`)?.innerHTML.trim()) ||
            brains.length
        );
        if (q && !anyLocalMatch) {
            const enc = encodeURIComponent(`${q} sign in OAuth API`);
            webSlot.innerHTML = `
                <div class="connect-master__hint">
                    <span>No match in V3Labs catalog</span>
                    <a class="connect-master__hint-cta"
                       href="https://www.google.com/search?q=${enc}"
                       target="_blank" rel="noopener noreferrer">
                        Search the web for "${escHtml(q)}"
                    </a>
                </div>`;
        } else {
            webSlot.innerHTML = '';
        }
    }

    bindRows();
}

function bindRows() {
    if (!_pop) return;
    _pop.querySelectorAll('[data-row]').forEach((row) => {
        if (row.__bound) return;
        row.__bound = true;
        row.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = row.getAttribute('data-row');
            handleRow(id);
        });
    });
    _pop.querySelectorAll('[data-search-focus]').forEach((btn) => {
        if (btn.__bound) return;
        btn.__bound = true;
        btn.addEventListener('click', () => {
            const inp = _pop.querySelector('[data-search-input]');
            inp?.focus();
        });
    });
}

function handleRow(id) {
    if (id === 'wallet') {
        const s = wallet.getStatus();
        if (s.connected) {
            wallet.disconnect().catch(() => {});
            close();
        } else if (typeof window.openConnectModal === 'function') {
            try { window.openConnectModal(); } catch {}
            close();
        } else {
            wallet.connect().catch(() => {});
            close();
        }
        return;
    }
    if (id?.startsWith('llm-')) {
        document.dispatchEvent(new CustomEvent('dexhero:open-llm-connect', {
            bubbles: true,
            detail: { provider: id.slice(4) },
        }));
        close();
        return;
    }
    if (id?.startsWith('slot-')) {
        // Open the matching slot picker on the centered DexHero. The
        // existing pickers (brain/voice/body/movement) all subscribe to
        // `dexhero:workshop-part` events — same path the lined-title
        // annotations on the centered hero use. No anchor element →
        // popovers center themselves over the stage.
        const slotId = id.slice('slot-'.length);
        const def = SLOT_DEFS.find((sd) => sd.id === slotId);
        if (!def) return;
        document.dispatchEvent(new CustomEvent('dexhero:workshop-part', {
            bubbles: true,
            detail: { part: def.workshopPart },
        }));
        close();
        return;
    }
    if (id?.startsWith('ide-')) {
        const s = wallet.getStatus();
        if (!s.connected) {
            // Same gating UX as the per-provider rows — bounce to wallet
            // connect when not linked.
            if (typeof window.openConnectModal === 'function') {
                try { window.openConnectModal(); } catch {}
            } else {
                wallet.connect().catch(() => {});
            }
            close();
            return;
        }
        openIdePairDialog(id.slice('ide-'.length));
        return;
    }
    if (id === 'steam') {
        if (_steamState?.linked) {
            location.hash = '#/market/steam';
            close();
            return;
        }
        const ret = encodeURIComponent(location.hash || '#/');
        window.location.href = `/api/steam/auth/begin?return=${ret}`;
        return;
    }
    if (id === 'github') {
        const s = wallet.getStatus();
        if (!s.connected || !s.address) {
            // Bounce to wallet connect first; same pattern as IDE rows.
            if (typeof window.openConnectModal === 'function') {
                try { window.openConnectModal(); } catch {}
            } else {
                wallet.connect().catch(() => {});
            }
            close();
            return;
        }
        if (_githubState?.linked) {
            // Already linked — Unlink action.
            unlinkGithubFlow(s.address);
            return;
        }
        // Kick off OAuth — full-page redirect so we land on github.com.
        const ret = encodeURIComponent(location.hash || '#/');
        window.location.href = `/api/auth/github/begin?wallet=${encodeURIComponent(s.address.toLowerCase())}&return=${ret}`;
        return;
    }
    if (id === 'sso') {
        location.hash = '#/docs/sign-in-with-dexhero';
        close();
        return;
    }
    if (id?.startsWith('stub-')) {
        return;
    }
}

/* ── Open / close ──────────────────────────────────────────────── */

function open() {
    if (!_pop) return;
    _query = '';
    paintShell();
    _pop.hidden = false;
    _open = true;
    _btn?.setAttribute('aria-expanded', 'true');
    refreshSteamState();
    refreshEquipped();
    refreshMcpState();
    refreshGithubState();
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

function close() {
    if (!_pop) return;
    _pop.hidden = true;
    _open = false;
    _query = '';
    _btn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
}

function toggle() {
    if (_open) close();
    else open();
}

function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } }
function onOutside(ev) {
    if (!_pop || !_open) return;
    if (_pop.contains(ev.target)) return;
    if (_btn && _btn.contains(ev.target)) return;
    close();
}

/* ── Background equipped-modules fetch (current DexHero loadout) ─ */

async function refreshEquipped() {
    let subject;
    try { subject = getCurrentSubject(); } catch { subject = null; }
    const tokenId = subject?.id || subject?.address || null;
    if (!tokenId) { _equippedBySlot = {}; _equippedTokenId = null; return; }
    if (tokenId === _equippedTokenId && Object.keys(_equippedBySlot).length) {
        // Already loaded for this subject — skip refetch unless something
        // explicitly invalidated it.
    }
    try {
        const r = await fetch(`/api/dexhero/${encodeURIComponent(tokenId)}/equipped`);
        if (!r.ok) return;
        const j = await r.json();
        _equippedBySlot = j?.equipped || {};
        _equippedTokenId = tokenId;
        if (_open) paintRows();
    } catch {}
}

/* ── Claude Code (MCP) pairing ────────────────────────────────── */

async function refreshMcpState() {
    try {
        const s = wallet.getStatus();
        if (!s.connected || !s.address) { _mcpState = { tokens: [] }; return; }
        const r = await fetch(`/api/mcp/my-tokens?wallet=${encodeURIComponent(s.address)}`, {
            headers: { 'x-v3labs-wallet': s.address.toLowerCase() },
        });
        if (!r.ok) return;
        const j = await r.json();
        _mcpState = { tokens: Array.isArray(j?.tokens) ? j.tokens : [] };
        if (_open) paintRows();
        refreshBadge();
    } catch {}
}

async function openIdePairDialog(ideId) {
    const ide = IDE_CONNECTORS.find((c) => c.id === ideId);
    if (!ide) return;
    const s = wallet.getStatus();
    if (!s.connected || !s.address) return;

    // Mint the token up-front. The pairing snippet IS the secret — we
    // show it once, then it lives in the IDE's MCP config. Cancelling
    // without copying isn't fatal — user can revoke + repair later.
    // Label the token with the IDE id so /api/mcp/my-tokens can show
    // per-IDE link counts.
    let payload;
    try {
        const r = await fetch('/api/mcp/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-v3labs-wallet': s.address.toLowerCase() },
            body: JSON.stringify({ label: ide.id }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        payload = await r.json();
    } catch (err) {
        alert(`Could not mint ${ide.title} token: ${err?.message || err}`);
        return;
    }

    const snippets = ide.instructions({ token: payload.token, url: payload.url });
    const snippetsHTML = snippets.map((snip, i) => `
        <div class="connect-master__mcp-dialog-snip">
            <div class="connect-master__mcp-dialog-snip-label">${escHtml(snip.label)}</div>
            <pre class="connect-master__mcp-dialog-cmd" data-cmd="${i}">${escHtml(snip.text)}</pre>
            <button type="button" class="connect-master__mcp-dialog-btn connect-master__mcp-dialog-btn--small" data-copy="${i}">Copy</button>
        </div>
    `).join('');

    const wrap = document.createElement('div');
    wrap.className = 'connect-master__mcp-dialog';
    wrap.innerHTML = `
        <div class="connect-master__mcp-dialog-backdrop" data-close></div>
        <div class="connect-master__mcp-dialog-card" role="dialog" aria-modal="true" aria-label="Connect ${escAttr(ide.title)}">
            <div class="connect-master__mcp-dialog-title">Connect ${escHtml(ide.title)}</div>
            <div class="connect-master__mcp-dialog-meta">
                ${escHtml(ide.title)} will pair with this wallet and gain access to V3Labs
                patch tools — propose CSS upgrades, list the Genetics feed, read design tokens.
                The snippet below embeds a long-lived token; treat it like an API key.
                Inference is billed by your ${escHtml(ide.title)} subscription, not by V3Labs.
            </div>
            ${snippetsHTML}
            <div class="connect-master__mcp-dialog-row">
                <button type="button" class="connect-master__mcp-dialog-btn connect-master__mcp-dialog-btn--ghost" data-close>Done</button>
            </div>
            <div class="connect-master__mcp-dialog-foot">
                Revoke from the Existing IDE list anytime — paired clients show with a last-6 preview.
            </div>
        </div>
    `;
    document.body.appendChild(wrap);
    const cleanup = () => {
        document.removeEventListener('keydown', onKeyDown, true);
        wrap.remove();
        refreshMcpState();
    };
    const onKeyDown = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); cleanup(); } };
    document.addEventListener('keydown', onKeyDown, true);
    wrap.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', cleanup));
    wrap.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = btn.getAttribute('data-copy');
            const pre = wrap.querySelector(`[data-cmd="${idx}"]`);
            const text = pre?.textContent || '';
            try {
                await navigator.clipboard.writeText(text);
                btn.textContent = 'Copied';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
            } catch {
                if (pre) {
                    const range = document.createRange();
                    range.selectNodeContents(pre);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
        });
    });
    close(); // close the connect popover behind the dialog
}

/* ── GitHub link state ────────────────────────────────────────── */

async function refreshGithubState() {
    try {
        const s = wallet.getStatus();
        if (!s.connected || !s.address) { _githubState = { linked: false }; return; }
        const r = await fetch(`/api/auth/github/me?wallet=${encodeURIComponent(s.address.toLowerCase())}`, {
            headers: { 'x-v3labs-wallet': s.address.toLowerCase() },
        });
        if (!r.ok) return;
        _githubState = await r.json();
        if (_open) paintRows();
        refreshBadge();
    } catch {}
}

async function unlinkGithubFlow(address) {
    if (!confirm('Unlink GitHub from this wallet?')) return;
    try {
        const r = await fetch('/api/auth/github/unlink', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-v3labs-wallet': String(address).toLowerCase() },
        });
        if (!r.ok) { toast(`Unlink failed: HTTP ${r.status}`, { kind: 'warn', ttl: 3000 }); return; }
        _githubState = { linked: false };
        toast('GitHub unlinked.', { kind: 'info', ttl: 2400 });
        if (_open) paintRows();
        refreshBadge();
    } catch (err) {
        toast(`Unlink failed: ${err?.message || err}`, { kind: 'warn', ttl: 3000 });
    }
}

/* Handle the post-OAuth flag the server appends to the redirect URL.
 * Runs once on boot — checks the location for ?github_linked=foo or
 * ?github_link_error=foo and shows the right toast. */
function _consumePostOAuthFlag() {
    try {
        // The flag lives in the hash route's querystring, e.g. "#/?github_linked=alice".
        const h = location.hash || '';
        const qIdx = h.indexOf('?');
        if (qIdx < 0) return;
        const params = new URLSearchParams(h.slice(qIdx + 1));
        const linked = params.get('github_linked');
        const errCode = params.get('github_link_error');
        if (!linked && !errCode) return;
        // Strip the flag from the URL so a refresh doesn't re-fire.
        params.delete('github_linked');
        params.delete('github_link_error');
        const remaining = params.toString();
        location.hash = h.slice(0, qIdx) + (remaining ? '?' + remaining : '');
        if (linked) {
            toast(`GitHub linked · @${linked}`, { kind: 'ok', ttl: 3200 });
            refreshGithubState();
        } else if (errCode) {
            toast(`GitHub link failed: ${errCode}`, { kind: 'warn', ttl: 4000 });
        }
    } catch {}
}

/* ── Background steam state ────────────────────────────────────── */

async function refreshSteamState() {
    try {
        const s = wallet.getStatus();
        const qs = s.connected ? `?wallet=${encodeURIComponent(s.address)}` : '';
        const r = await steamFetch(`/api/steam/me${qs}`);
        if (!r.ok) return;
        const j = await r.json();
        _steamState = j;
        if (_open) paintRows();
        refreshBadge();
    } catch {}
}

function refreshBadge() {
    if (!_btn) return;
    const s = wallet.getStatus();
    const me = s.address ? s.address.toLowerCase() : '';
    const accounts = me ? getAllLlmAccounts(me) : [];
    const linkedCount = (s.connected ? 1 : 0) + accounts.length + (_steamState?.linked ? 1 : 0);
    const countEl = document.getElementById('lobby-connect-count');
    if (countEl) {
        countEl.textContent = String(linkedCount);
        countEl.hidden = linkedCount === 0;
    }
    _btn.setAttribute('data-linked-count', String(linkedCount));
}

/* ── Helpers ───────────────────────────────────────────────────── */

function short(addr) {
    const a = String(addr || '');
    if (a.length <= 10) return a;
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function walletSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
        <rect x="3" y="6" width="18" height="13" rx="2"/>
        <path d="M16 13h3"/>
        <path d="M3 9h15"/>
    </svg>`;
}
function steamSvg() {
    return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M12 2C6.6 2 2.2 6 2 11.1l5.4 2.3c.5-.3 1-.5 1.6-.5h.1l2.4-3.5v-.1a3.6 3.6 0 1 1 3.6 3.6h-.1L11.6 15v.1a2.9 2.9 0 0 1-5.7.6L2 14.1A10 10 0 1 0 12 2z"/>
    </svg>`;
}
function letterGlyph(letter) {
    return `<span class="connect-master__row-letter">${escHtml(String(letter || '?').toUpperCase())}</span>`;
}
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}
function escAttr(s) { return escHtml(s); }

/* ── Connect button label (the wallet chip absorbed) ───────────── */

function refreshButtonLabel() {
    if (!_btn) return;
    const s = wallet.getStatus();
    const labelEl = _btn.querySelector('.lobby-connect__label');
    if (!labelEl) return;
    if (s.connected && s.address) {
        labelEl.textContent = short(s.address);
        _btn.setAttribute('data-connected', 'true');
    } else {
        labelEl.textContent = 'Start here';
        _btn.setAttribute('data-connected', 'false');
    }
}

/* ── Boot ──────────────────────────────────────────────────────── */

export function initConnectMaster() {
    if (_wired) return;
    _wired = true;
    _btn = document.getElementById('lobby-connect');
    _pop = document.getElementById('lobby-connect-pop');
    if (!_btn || !_pop) return;
    _btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(); });
    document.addEventListener('dexhero:llm-account-changed', () => {
        if (_open) paintRows();
        refreshBadge();
    });
    on(E.WALLET_CHANGED, () => {
        refreshButtonLabel();
        if (_open) paintRows();
        refreshBadge();
        refreshSteamState();
        refreshGithubState();
    });
    // STAGE_SUBJECT fires when the centered hero changes; the loadout
    // section needs to repaint with the new token's equipped modules.
    on(E.STAGE_SUBJECT, () => {
        _equippedBySlot = {};
        _equippedTokenId = null;
        if (_open) { refreshEquipped(); }
    });
    window.addEventListener('hashchange', () => close());
    refreshButtonLabel();
    setTimeout(refreshSteamState, 800);
    setTimeout(refreshGithubState, 800);
    // On first boot, consume any post-OAuth callback flag in the URL.
    _consumePostOAuthFlag();
}
