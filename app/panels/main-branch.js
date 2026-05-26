/* Main Branch — DNA replication infographic HUD.
 *
 * The platform's commit-management surface, rendered as a textbook
 * DNA replication diagram. Five zones, left to right:
 *
 *   ┌──────────┬─────────┬──────────────┬──────────┬─────────┬──────────┐
 *   │ SEALED   │ HELICASE│ COMMUNITY-   │POLYMERASE│ PENDING │ INCOMING │
 *   │ DEFAULT  │ (platf.)│ APPROVED     │(threshold│         │  (new)   │
 *   └──────────┴─────────┴──────────────┴──────────┴─────────┴──────────┘
 *   ←─────────── stable / committed to platform │ growing adoption ────→
 *
 * Each patch = one base pair spanning both strands. Top half = UI portion
 * (CSS / HTML / microcopy), bottom half = UX portion (behaviors).
 *
 * This IS the live commit feed — new authored patches appear as free
 * nucleotides on the far right; adoption migrates them leftward.
 *
 * Plan: /Users/mojo/.claude/plans/i-want-you-to-twinkly-phoenix.md */

import { Panel } from '../ui/panel.js';
import {
    getCommunityFeed, getActiveChain, checkoutCommit, getCreatorAvatar,
} from '../services/upgrades-mock.js';
import { toast } from '../ui/toast.js';
// buildDnaFeedRail used to mount the social feed here; the rail now
// lives in the right-wing (mounted by app/panels/home.js). Import
// retired; the rail module is still imported by home.js.

/* ── Surface palette (color = surface category) ── */
const SURFACE = {
    'equipment-slot': { color: '#06b6d4', soft: '#67d7e2', label: 'Slot popovers' },
    'header-ticker':  { color: '#8b5cf6', soft: '#b89cfb', label: 'Header ticker' },
    'chat-log':       { color: '#3b82f6', soft: '#82aaf8', label: 'Chat log'      },
    'slot':           { color: '#22c55e', soft: '#76e09a', label: 'Slots'         },
    'global':         { color: '#94a3b8', soft: '#c4ccd6', label: 'Global'        },
};
const TIER_GOLD = '#f59e0b';

/* ── Zone classification thresholds ── */
const PROMO_THRESHOLD    = 500;                    // adopters to enter "community approved"
const INCOMING_AGE_MS    = 1000 * 60 * 60 * 24;    // last 24h = candidate for incoming/free-nucleotide
const INCOMING_MAX_ADOPT = 10;
const RECENT_HIGHLIGHT_MS = 1000 * 60 * 60 * 24 * 7;  // pulse glow for past 7 days

/* ── Canvas geometry ──
 *
 * Structure (matches the textbook replication diagram):
 *
 *   ┌──── parent DNA helix ────┬─[topo]─┬─── lagging strand (UI) ─[poly]─── pending UI ───→ ●●●
 *   │     (sealed / promoted)  │        │
 *   │                          │  fork  │
 *   │                          │        │
 *   └──────────────────────────┴────────┴─── leading strand (UX) ─[poly]─── pending UX ───→ ●●●
 *
 * Parent DNA on the left is one helix; after the topoisomerase widget it
 * splits into TWO complete double-helix branches that extend rightward. */

const VIEW_H            = 380;            // tighter viewBox → SVG fills the canvas (was 540)

// Parent DNA (left of topoisomerase) — proper double-helix, BIG so it
// reads as the textbook DNA diagram. Fewer twists = each loop is wider
// and individual base-pair rungs are clearly visible across the helix.
const PARENT_CENTER_Y   = 190;
const PARENT_STRAND_GAP = 100;            // distance peak-to-peak for the topoisomerase widget
const PARENT_AMP        = 50;             // each strand swings 50px from center → 100px total
const PARENT_TWIST      = 130;            // wider twist period → fewer, larger loops (was 60)
const PARENT_SEGS       = 220;            // high resolution → smooth curves

// Branch RNA strands — each branch is ONE straight horizontal strand.
// Strands sit FAR from center so the pegs (BAR_LEN below) can pass cleanly
// THROUGH the polymerase widgets, with peg visible above + below each widget.
const TOP_STRAND_Y      = 78;             // way up top  (was 118)
const BOT_STRAND_Y      = 302;            // way down bottom (was 262)
const CENTER_AXIS_Y     = (TOP_STRAND_Y + BOT_STRAND_Y) / 2;  // 190 (lines up with parent)
const STRAND_WAVE_AMP   = 0;              // straight horizontal ladder backbone
const STRAND_WAVE_PERIOD= 200;             // (kept for API stability; unused when AMP=0)
const BRANCH_SEGS       = 320;

// Polymerase widget dimensions (decoupled from peg height — pegs sit inside
// the widget but don't fill it; widget extends beyond peg on both sides).
const POLY_H            = 76;             // polymerase widget height
const POLY_W            = 56;             // polymerase widget width

// Peg dimensions — stay compact regardless of polymerase size.
const BAR_W             = 8;
const BAR_LEN           = 46;             // peg height (independent of POLY_H)
const BAR_PITCH         = 18;             // (unused for filled pegs; kept for reference)
const SEAL_BAR_PITCH    = 22;

// Polymerase widget sits at the MIDPOINT of each peg.
const UI_POLY_Y         = TOP_STRAND_Y + BAR_LEN / 2;   // 101
const UX_POLY_Y         = BOT_STRAND_Y - BAR_LEN / 2;   // 279

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

export default class MainBranchPanel extends Panel {
    static id        = 'main-branch';
    static variant   = 'codex';
    static width     = 1180;
    static title     = 'Main Branch';
    static titleBreadcrumb = ['MAIN'];
    static stageMode = 'dim';

    constructor(params) {
        super(params);
        this._search = '';
        this._surfaceFilter = new Set();  // empty = all surfaces shown
        this._mineOnly = false;
        this._zoom = 1;
        this._tooltipEl = null;
        this._rafPending = false;
    }

    render() {
        return ''
            + '<div class="dna" data-dna-root>'

            // The two columns live inside a swipe-strip wrapper. On desktop
            // the wrapper is a plain flex container (both visible). On
            // mobile (@media max-width: 720px) the wrapper becomes a 200vw
            // horizontal strip that translates between feed-view (default)
            // and chart-view via the swipe gesture wired in onMount.
            +   '<div class="dna__strip" data-strip>'

            // ── LEFT: SVG diagram + footer (the existing surface) ──
            +     '<div class="dna__main" data-pane-main>'

            // ── Canvas with SVG diagram + tooltip ──
            +       '<div class="dna__canvas" data-canvas>'
            +         '<div class="hud-brackets"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>'
            +         '<div class="dna__viewport" data-viewport>'
            +           this._renderDiagram()
            +         '</div>'
            +         '<div class="dna__tip" data-tip hidden></div>'
            +         '<div class="dna__live" data-live><span class="dna__live-dot"></span>LIVE</div>'
            +       '</div>'

            // ── Footer: surface legend + stats ──
            // (The site-wide "Changes · ON/OFF" master toggle lives in
            //  the lobby bar at the bottom of the page, next to Referrals
            //  — wired by initChangesToggle in app/shell.js.)
            +       '<footer class="dna__footer">'
            +         '<div class="dna__legend">'
            +           this._renderLegend()
            +         '</div>'
            +         this._renderStats()
            +       '</footer>'

            +     '</div>'

            // Social-style commit feed used to live here as a right rail —
            // it now lives in the lobby right-wing as the "Feed" pane,
            // surfaced by the stage right-arrow + accessible from any
            // route. Mount + wiring done in app/panels/home.js
            // _wireRightWing; the swipe-carrier + expand button rules in
            // upgrades.css are dead on this page since .dna__feed no
            // longer exists, but they're harmless (no markup to match).

            +   '</div>'    // /dna__strip

            + '</div>';
    }

    _renderSurfaceChips() {
        return Object.entries(SURFACE).map(([key, v]) => {
            const active = this._surfaceFilter.size === 0 || this._surfaceFilter.has(key);
            return ''
                + '<button type="button" class="dna__chip' + (active ? ' is-active' : '') + '"'
                +   ' data-surface-chip="' + esc(key) + '" style="--c:' + v.color + '">'
                +   '<span class="dna__chip-dot" style="background:' + v.color + '"></span>'
                +   esc(v.label)
                + '</button>';
        }).join('');
    }

    _renderLegend() {
        return ''
            + '<div class="dna__legend-section">'
            +   '<div class="dna__legend-head">SURFACE</div>'
            +   Object.entries(SURFACE).map(([key, v]) =>
                '<div class="dna__legend-row"><span class="dna__legend-dot" style="background:' + v.color + '"></span>' + esc(v.label) + '</div>'
              ).join('')
            + '</div>'
            + '<div class="dna__legend-section">'
            +   '<div class="dna__legend-head">ANATOMY</div>'
            +   '<div class="dna__legend-row"><span class="dna__legend-icon dna__legend-icon--helicase"></span>DexHero · Platform</div>'
            +   '<div class="dna__legend-row"><span class="dna__legend-icon dna__legend-icon--polymerase"></span>Community · Adoption threshold</div>'
            +   '<div class="dna__legend-row"><span class="dna__legend-icon dna__legend-icon--free"></span>Free nucleotide · New commit</div>'
            +   '<div class="dna__legend-row"><span class="dna__legend-dot" style="background:' + TIER_GOLD + '"></span>★ Merged into main</div>'
            + '</div>';
    }

    _renderStats() {
        const cls = this._classify();
        return ''
            + '<div class="dna__stats">'
            +   '<span class="dna__stat"><strong>' + cls.sealed.length + '</strong><span>IN MAIN</span></span>'
            +   '<span class="dna__stat"><strong>' + cls.ui.length     + '</strong><span>LAGGING · UI</span></span>'
            +   '<span class="dna__stat"><strong>' + cls.ux.length     + '</strong><span>LEADING · UX</span></span>'
            + '</div>';
    }

    /* ── Data: classify patches.
     *   - `sealed` = promoted (shown in parent DNA on the left)
     *   - `ui` = non-promoted patches with UI content (top branch)
     *   - `ux` = non-promoted patches with UX content (bottom branch)
     *   - A patch with BOTH UI + UX appears on BOTH branches at the
     *     same x position (linked pair). */
    _classify() {
        const feed = getCommunityFeed({ sort: 'new' });
        const filtered = feed.filter((p) => this._matchesFilter(p));
        const out = { sealed: [], ui: [], ux: [] };
        const isUI = (p) => Boolean(
            (p.css && p.css.trim()) ||
            (p.html_fragments && Object.keys(p.html_fragments).length) ||
            (p.config && Object.keys(p.config).length)
        );
        const isUX = (p) => Boolean(p.behaviors && p.behaviors.length);
        for (const p of filtered) {
            if (p.is_promoted_to_main) { out.sealed.push(p); continue; }
            const ui = isUI(p);
            const ux = isUX(p);
            // Default: every non-promoted patch shows somewhere. If it has
            // neither bucket explicitly, treat as UI (most patches will be).
            if (ui || (!ui && !ux)) out.ui.push(p);
            if (ux)                 out.ux.push(p);
        }
        out.sealed.sort((a, b) => (a.promoted_at || '').localeCompare(b.promoted_at || ''));
        out.ui.sort((a, b)     => (b.adoption_count || 0) - (a.adoption_count || 0));
        out.ux.sort((a, b)     => (b.adoption_count || 0) - (a.adoption_count || 0));
        return out;
    }

    _matchesFilter(p) {
        if (this._surfaceFilter.size > 0 && !this._surfaceFilter.has(p.target_surface)) return false;
        if (this._search) {
            const s = this._search.toLowerCase();
            const t = (p.title || '').toLowerCase();
            const a = (p.author_username || '').toLowerCase();
            if (!t.includes(s) && !a.includes(s)) return false;
        }
        return true;
    }

    /* ── Layout: x-positions for parent DNA, topoisomerase, fork transition,
     *    and the two branch helices. ── */
    _layout(cls) {
        const x0 = 32;
        // Snap parentW to an INTEGER number of full helix twists so the
        // strands start AND end at clean peaks (top strand on top, bottom on
        // bottom). Branches then flow naturally out of those endpoints.
        const desiredParentW = Math.max(240, cls.sealed.length * SEAL_BAR_PITCH + 80);
        const parentW = Math.ceil(desiredParentW / PARENT_TWIST) * PARENT_TWIST;
        const topoW   = 44;                                       // bigger, more textbook-prominent
        const forkW   = 60;                                       // shorter fork transition curve
        const branchInnerW = 480;                                 // each branch's open zone (was 720)
        const branchMaxBars = Math.max(cls.ui.length, cls.ux.length);
        const branchW = Math.max(branchInnerW, branchMaxBars * BAR_PITCH + 80);
        const xParent = x0;
        const xTopo   = xParent + parentW;
        const xFork   = xTopo + topoW;
        const xBranch = xFork + forkW;
        const totalW  = xBranch + branchW + 32;
        const xPoly   = xBranch + branchW * 0.32;                 // polymerase ~32% along (closer to fork)
        return {
            x0, parentW, topoW, forkW, branchW, totalW,
            xParent, xTopo, xFork, xBranch, xPoly,
        };
    }

    /* ── Main SVG diagram ── */
    _renderDiagram() {
        const cls = this._classify();
        const L = this._layout(cls);

        return ''
            + '<svg class="dna__svg" data-svg viewBox="0 0 ' + L.totalW + ' ' + VIEW_H + '" '
            +   'xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">'
            +   svgDefs()
            +   renderBackdrop(L.totalW)
            +   renderParentHelix(L, cls.sealed, [...cls.sealed, ...cls.ui, ...cls.ux])
            +   renderForkTransition(L)
            +   renderRnaStrand(L, TOP_STRAND_Y, cls.ui, 'ui')
            +   renderRnaStrand(L, BOT_STRAND_Y, cls.ux, 'ux')
            +   renderTopoisomerase(L)
            +   renderBranchPolymerase(L, UI_POLY_Y, 'ui')
            +   renderBranchPolymerase(L, UX_POLY_Y, 'ux')
            +   renderBranchLabels(L)
            + '</svg>';
    }

    /* ── Minimap (compressed overview of all patches) ──
     *   Top row = lagging/UI patches, bottom row = leading/UX patches,
     *   gold marks for promoted (parent DNA), divider lines for the
     *   topoisomerase + polymerase positions. */
    _renderMinimap() {
        const cls = this._classify();
        const L = this._layout(cls);
        const W = 100;
        const H = 28;
        const dotR = 0.8;
        const yTop = H * 0.32, yBot = H * 0.68;
        const dots = [];
        // Promoted (gold) along the parent DNA region
        cls.sealed.forEach((p, i) => {
            const localX = L.xParent + 18 + i * SEAL_BAR_PITCH;
            const fx = (localX / L.totalW) * W;
            dots.push('<circle cx="' + fx.toFixed(2) + '" cy="' + (H / 2) + '" r="' + dotR + '" fill="' + TIER_GOLD + '"/>');
        });
        // Lagging UI on top row
        cls.ui.forEach((p, i) => {
            const usable = (L.totalW - 28) - (L.xBranch + 18);
            const pitch = cls.ui.length > 0 ? Math.min(BAR_PITCH, usable / Math.max(cls.ui.length, 8)) : BAR_PITCH;
            const localX = L.xBranch + 18 + i * pitch;
            const fx = (localX / L.totalW) * W;
            const color = (SURFACE[p.target_surface] || SURFACE.global).color;
            dots.push('<circle cx="' + fx.toFixed(2) + '" cy="' + yTop + '" r="' + dotR + '" fill="' + color + '"/>');
        });
        // Leading UX on bottom row
        cls.ux.forEach((p, i) => {
            const usable = (L.totalW - 28) - (L.xBranch + 18);
            const pitch = cls.ux.length > 0 ? Math.min(BAR_PITCH, usable / Math.max(cls.ux.length, 8)) : BAR_PITCH;
            const localX = L.xBranch + 18 + i * pitch;
            const fx = (localX / L.totalW) * W;
            const color = (SURFACE[p.target_surface] || SURFACE.global).color;
            dots.push('<circle cx="' + fx.toFixed(2) + '" cy="' + yBot + '" r="' + dotR + '" fill="' + color + '"/>');
        });
        const topoFx = (L.xTopo / L.totalW) * W;
        const polyFx = (L.xPoly / L.totalW) * W;
        return ''
            + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">'
            +   '<rect width="' + W + '" height="' + H + '" fill="rgba(255,255,255,0.02)"/>'
            +   '<line x1="' + topoFx + '" y1="2" x2="' + topoFx + '" y2="' + (H - 2) + '" stroke="#6ee7ff" stroke-width="0.3" stroke-dasharray="0.6 0.6"/>'
            +   '<line x1="' + polyFx + '" y1="2" x2="' + polyFx + '" y2="' + (H - 2) + '" stroke="#fbbf24" stroke-width="0.3" stroke-dasharray="0.6 0.6"/>'
            +   dots.join('')
            +   '<rect class="dna__mm-viewport" data-mm-viewport x="0" y="0.5" width="' + W + '" height="' + (H - 1) + '" fill="rgba(110,231,255,0.08)" stroke="rgba(110,231,255,0.6)" stroke-width="0.4"/>'
            + '</svg>';
    }

    /* ── Lifecycle ── */

    async onMount() {
        const canvas = this.root.querySelector('[data-canvas]');
        const viewport = this.root.querySelector('[data-viewport]');
        const tip = this.root.querySelector('[data-tip]');
        const liveEl = this.root.querySelector('[data-live]');
        this._tooltipEl = tip;

        /* ── Hover tooltip ── */
        const onMove = (ev) => {
            const target = ev.target.closest('[data-patch-id]');
            if (!target) {
                tip.classList.remove('is-visible');
                setTimeout(() => { if (!tip.classList.contains('is-visible')) tip.hidden = true; }, 120);
                return;
            }
            const title   = target.getAttribute('data-title') || '';
            const author  = target.getAttribute('data-author') || '';
            const adopt   = target.getAttribute('data-adopt') || '0';
            const surface = target.getAttribute('data-surface') || '';
            const promo   = target.getAttribute('data-promoted') === '1';
            const zone    = target.getAttribute('data-zone') || '';
            const surfaceMeta = SURFACE[surface] || { label: surface };
            tip.innerHTML = ''
                + '<div class="dna__tip-row">'
                +   (promo ? '<span class="dna__tip-pin">★ IN MAIN</span>' : '<span class="dna__tip-zone">' + esc(zone.toUpperCase()) + '</span>')
                +   '<span class="dna__tip-title">' + esc(title) + '</span>'
                + '</div>'
                + '<div class="dna__tip-meta">'
                +   (author ? '<span>by <strong>' + esc(author) + '</strong></span><span class="dna__tip-sep">·</span>' : '')
                +   '<span><strong>' + esc(String(adopt)) + '</strong> adopters</span>'
                +   '<span class="dna__tip-sep">·</span>'
                +   '<span style="color:' + (surfaceMeta.color || '#94a3b8') + '">' + esc(surfaceMeta.label) + '</span>'
                + '</div>';
            const rect = canvas.getBoundingClientRect();
            const x = ev.clientX - rect.left;
            const y = ev.clientY - rect.top;
            tip.hidden = false;
            requestAnimationFrame(() => {
                const tr = tip.getBoundingClientRect();
                let left = x + 14;
                if (left + tr.width > rect.width - 12) left = x - tr.width - 14;
                left = Math.max(12, left);
                const top = Math.max(12, Math.min(rect.height - tr.height - 12, y - tr.height - 14));
                tip.style.left = left + 'px';
                tip.style.top  = top + 'px';
                tip.classList.add('is-visible');
            });
        };
        canvas.addEventListener('mousemove', onMove, { signal: this.signal });
        canvas.addEventListener('mouseleave', () => {
            tip.classList.remove('is-visible');
            setTimeout(() => { tip.hidden = true; }, 120);
        }, { signal: this.signal });

        /* ── Click navigation ── */
        canvas.addEventListener('click', (ev) => {
            // Anatomy widget clicks
            const anat = ev.target.closest('[data-anat]');
            if (anat) {
                const a = anat.getAttribute('data-anat');
                if (a === 'helicase')   location.hash = '#/credits';
                if (a === 'polymerase') location.hash = '#/community-upgrades';
                return;
            }
            const node = ev.target.closest('[data-patch-id]');
            if (!node) return;
            const id = node.getAttribute('data-patch-id');
            if (id) location.hash = '#/upgrade/' + encodeURIComponent(id);
        }, { signal: this.signal });

        /* ── Top controls: search + filter chips + jump buttons ── */
        const searchInput = this.root.querySelector('[data-search]');
        if (searchInput) {
            searchInput.addEventListener('input', (ev) => {
                this._search = ev.target.value || '';
                this._refreshDiagram();
            }, { signal: this.signal });
        }
        this.root.addEventListener('click', (ev) => {
            // Collapsible controls bar toggle
            const ctlToggle = ev.target.closest('[data-controls-toggle]');
            if (ctlToggle) {
                const wrap = this.root.querySelector('[data-controls]');
                if (wrap) wrap.classList.toggle('is-collapsed');
                return;
            }
            // Surface chip toggle
            const chip = ev.target.closest('[data-surface-chip]');
            if (chip) {
                const k = chip.getAttribute('data-surface-chip');
                if (this._surfaceFilter.has(k)) this._surfaceFilter.delete(k);
                else this._surfaceFilter.add(k);
                // If they activate the LAST chip, treat empty as "all"; if they deactivate all, also empty
                if (this._surfaceFilter.size === Object.keys(SURFACE).length) this._surfaceFilter.clear();
                this._refreshDiagram();
                return;
            }
            // Jump buttons
            const jump = ev.target.closest('[data-jump]');
            if (jump) {
                const k = jump.getAttribute('data-jump');
                this._jumpTo(k);
                return;
            }
            // Reset to main
            const reset = ev.target.closest('[data-action="reset-to-main"]');
            if (reset) {
                ev.preventDefault();
                const chain = getActiveChain();
                const genesis = chain[0];
                if (!genesis || genesis.op !== 'genesis') return;
                if (!confirm('Reset your branch to main · genesis?\n\nYour commits stay in branch history (recoverable) — only HEAD moves back.')) return;
                checkoutCommit(genesis.id);
                toast('HEAD moved to main · genesis', { kind: 'ok', ttl: 3000 });
                this.refresh();
            }
        }, { signal: this.signal });

        /* ── Live commit subscription ── */
        const onCommit = (ev) => {
            const c = ev?.detail?.commit;
            if (!c) return;
            // Just refresh — virtualization-ready but cheap at fixture scale
            this._refreshDiagram();
            // Briefly flash the LIVE indicator
            if (liveEl) {
                liveEl.classList.remove('is-pinging');
                void liveEl.offsetWidth;
                liveEl.classList.add('is-pinging');
            }
        };
        document.addEventListener('dexhero:commit-added', onCommit);
        this.onClose(() => { try { document.removeEventListener('dexhero:commit-added', onCommit); } catch {} });

        /* Social-style commit feed is now mounted in the lobby right
         * wing (see app/panels/home.js _wireRightWing). The right-arrow
         * (#lobby-stage-next) opens the wing with the Feed pane active.
         * Feed-rail wiring + the desktop expand-feed + mobile swipe-
         * carrier logic that used to live here are all retired. */

        /* ── Initial scroll alignment: center the helicase by default ── */
        requestAnimationFrame(() => this._alignViewport('main'));
    }

    /* Expand the feed to Instagram-width center-stage on desktop. Toggles
     * `is-feed-fullscreen` on the .dna root; CSS handles the layout shift.
     * Click-outside or Esc returns to the side-by-side default. */
    _wireFeedExpand() {
        const root = this.root.querySelector('[data-dna-root]');
        const btn  = this.root.querySelector('[data-action="toggle-feed-fullscreen"]');
        if (!root || !btn) return;
        const expandIcon   = btn.querySelector('[data-icon-expand]');
        const collapseIcon = btn.querySelector('[data-icon-collapse]');
        const setState = (on) => {
            root.classList.toggle('is-feed-fullscreen', on);
            btn.title = on ? 'Collapse feed' : 'Expand feed';
            btn.setAttribute('aria-label', on ? 'Collapse feed' : 'Expand feed');
            if (expandIcon)   expandIcon.hidden   = on;
            if (collapseIcon) collapseIcon.hidden = !on;
        };
        const onBtn = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setState(!root.classList.contains('is-feed-fullscreen'));
        };
        const onKey = (ev) => {
            // Intercept Esc BEFORE the Panel base class's close handler
            // (app/ui/panel.js#L178) sees it — otherwise the whole panel
            // closes instead of just collapsing the fullscreen feed.
            // We register with `capture: true` below so this fires first.
            if (ev.key === 'Escape' && root.classList.contains('is-feed-fullscreen')) {
                ev.preventDefault();
                ev.stopPropagation();
                setState(false);
            }
        };
        const onOutside = (ev) => {
            if (!root.classList.contains('is-feed-fullscreen')) return;
            const feed = this.root.querySelector('[data-feed]');
            if (feed && !feed.contains(ev.target) && !btn.contains(ev.target)) {
                // Clicks outside the feed area collapse — but not on the
                // expand button itself (handled by onBtn above).
                setState(false);
            }
        };
        btn.addEventListener('click', onBtn);
        document.addEventListener('keydown', onKey, true);   // capture: beats the Panel base's Esc handler
        document.addEventListener('click', onOutside, true);
        this.onClose(() => {
            try { document.removeEventListener('keydown', onKey, true); } catch {}
            try { document.removeEventListener('click', onOutside, true); } catch {}
        });
    }

    /* Mobile pointer-driven horizontal swipe between the feed pane and
     * the DNA chart pane. The two panes sit side-by-side in a 200vw strip
     * inside the .dna__strip wrapper (CSS handles the layout). Pointer
     * Events shift `--mobile-strip-x` between 0 (feed) and -100vw (chart).
     * touch-action: pan-y on the strip lets vertical scroll fall through
     * to the feed list, so only horizontal sweeps are intercepted. */
    _wireMobileSwipe() {
        const root  = this.root.querySelector('[data-dna-root]');
        const strip = this.root.querySelector('[data-strip]');
        const hint  = this.root.querySelector('[data-swipe-hint]');
        const hintDir = hint?.querySelector('[data-hint-direction]');
        if (!root || !strip) return;

        // Detect mobile via viewport width. We re-check on resize so a
        // desktop → narrow-window transition activates the swipe handler.
        const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
        const SWIPE_THRESHOLD = 60;             // px to commit a snap
        let view = 'feed';                       // 'feed' | 'chart'
        let startX = null;
        let startY = null;
        let dragging = false;
        let pendingDelta = 0;

        const setView = (next, { animate = true } = {}) => {
            view = next;
            const x = next === 'feed' ? '0vw' : '-100vw';
            if (!animate) strip.style.transition = 'none';
            else          strip.style.transition = '';
            strip.style.setProperty('--mobile-strip-x', x);
            root.setAttribute('data-mobile-view', next);
            if (hint) {
                hint.hidden = !isMobile();
                if (hintDir) hintDir.textContent = next === 'feed' ? '← swipe for DNA chart' : 'swipe for feed →';
            }
            if (!animate) requestAnimationFrame(() => { strip.style.transition = ''; });
        };

        const applyMobile = () => {
            if (isMobile()) {
                root.setAttribute('data-mobile', 'true');
                // Default: feed view (matches the header-button intent).
                setView('feed', { animate: false });
            } else {
                root.removeAttribute('data-mobile');
                root.removeAttribute('data-mobile-view');
                strip.style.removeProperty('--mobile-strip-x');
                if (hint) hint.hidden = true;
            }
        };

        const onDown = (ev) => {
            if (!isMobile()) return;
            if (ev.target.closest('.dna__feed-expand')) return;   // don't hijack button presses
            if (ev.target.closest('button, a, input, [data-social-action]')) return;
            startX = ev.clientX;
            startY = ev.clientY;
            dragging = false;
            pendingDelta = 0;
        };
        const onMove = (ev) => {
            if (!isMobile() || startX == null) return;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!dragging) {
                // Lock direction: only horizontal sweeps engage swipe; let
                // vertical sweeps fall through to native scrolling.
                if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
                if (Math.abs(dy) > Math.abs(dx)) { startX = null; return; }
                dragging = true;
            }
            pendingDelta = dx;
            // Live-drag the strip following the finger.
            const baseVw = view === 'feed' ? 0 : -100;
            const pct = baseVw + (dx / window.innerWidth) * 100;
            strip.style.transition = 'none';
            strip.style.setProperty('--mobile-strip-x', `${pct}vw`);
        };
        const onUp = () => {
            if (!isMobile() || !dragging) { startX = null; return; }
            const dx = pendingDelta;
            // Snap based on direction + threshold.
            if (Math.abs(dx) > SWIPE_THRESHOLD) {
                if (view === 'feed' && dx < 0)      setView('chart');
                else if (view === 'chart' && dx > 0) setView('feed');
                else                                 setView(view);
            } else {
                setView(view);
            }
            startX = null;
            dragging = false;
            pendingDelta = 0;
        };

        strip.addEventListener('pointerdown',   onDown);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup',   onUp);
        document.addEventListener('pointercancel', onUp);
        const mql = window.matchMedia('(max-width: 640px)');
        const onMq = () => applyMobile();
        mql.addEventListener('change', onMq);
        applyMobile();

        this.onClose(() => {
            try { strip.removeEventListener('pointerdown', onDown); } catch {}
            try { document.removeEventListener('pointermove', onMove); } catch {}
            try { document.removeEventListener('pointerup', onUp); } catch {}
            try { document.removeEventListener('pointercancel', onUp); } catch {}
            try { mql.removeEventListener('change', onMq); } catch {}
        });
    }

    _refreshDiagram() {
        const viewport = this.root.querySelector('[data-viewport]');
        if (viewport) viewport.innerHTML = this._renderDiagram();
        // Re-render the chip states (filter buttons may have changed)
        const filters = this.root.querySelector('.dna__filters');
        if (filters) filters.innerHTML = this._renderSurfaceChips();
        // Re-render stats
        const footer = this.root.querySelector('.dna__footer');
        if (footer) {
            const oldStats = footer.querySelector('.dna__stats');
            if (oldStats) {
                const wrap = document.createElement('div');
                wrap.innerHTML = this._renderStats();
                oldStats.replaceWith(wrap.firstElementChild);
            }
        }
    }

    _alignViewport(target) {
        const canvas = this.root.querySelector('[data-canvas]');
        const svg = this.root.querySelector('[data-svg]');
        if (!canvas || !svg) return;
        // The SVG fits to canvas width via viewBox; horizontal scrolling
        // only kicks in if we later force a wider svg.style.width. For
        // now this is a no-op anchor.
    }

    _jumpTo(kind) {
        // Placeholder for now — viewport is fit-to-canvas so jump is
        // visually no-op. Once we add zoom > 1 and virtualization,
        // this scrolls the canvas to the relevant zone.
        if (kind === 'latest') {
            toast('Jumped to latest commits', { kind: 'info', ttl: 1800 });
        } else if (kind === 'main') {
            toast('Jumped to main branch (sealed DNA)', { kind: 'info', ttl: 1800 });
        }
    }

    refresh() {
        const body = this.root && this.root.querySelector('[data-body]');
        if (body) body.innerHTML = this.render();
        this.onMount();
    }
}

/* ════════════════════════════════════════════════════════════════════
 *                          SVG RENDERERS
 * ════════════════════════════════════════════════════════════════════ */

function svgDefs() {
    return ''
        + '<defs>'
        // Strand gradients — top = site cyan, bottom = site blue, visibly
        // distinct so the helix reads as TWO strands twisting around each other.
        +   '<linearGradient id="dna-strand-top" x1="0" y1="0" x2="0" y2="1">'
        +     '<stop offset="0" stop-color="#a8f5ff"/>'
        +     '<stop offset="1" stop-color="#06b6d4"/>'
        +   '</linearGradient>'
        +   '<linearGradient id="dna-strand-bot" x1="0" y1="0" x2="0" y2="1">'
        +     '<stop offset="0" stop-color="#93c5fd"/>'
        +     '<stop offset="1" stop-color="#3b82f6"/>'
        +   '</linearGradient>'
        +   '<linearGradient id="dna-helicase" x1="0" y1="0" x2="1" y2="0">'
        +     '<stop offset="0" stop-color="#06b6d4"/>'
        +     '<stop offset="1" stop-color="#a8f5ff"/>'
        +   '</linearGradient>'
        +   '<radialGradient id="dna-polymerase">'
        +     '<stop offset="0" stop-color="#fde68a"/>'
        +     '<stop offset="0.6" stop-color="#fbbf24"/>'
        +     '<stop offset="1" stop-color="#b45309"/>'
        +   '</radialGradient>'
        // Backdrop radial — soft glow vignette
        +   '<radialGradient id="dna-vignette" cx="0.5" cy="0.5" r="0.7">'
        +     '<stop offset="0" stop-color="#06121e" stop-opacity="0.55"/>'
        +     '<stop offset="1" stop-color="#02060c" stop-opacity="0"/>'
        +   '</radialGradient>'
        // Cyan glow filter — soft ambient halo without distorting the line itself.
        // Source graphic renders crisp on top of a single-pass low-deviation blur.
        +   '<filter id="dna-glow" x="-20%" y="-20%" width="140%" height="140%">'
        +     '<feGaussianBlur stdDeviation="1.6" result="halo"/>'
        +     '<feMerge>'
        +       '<feMergeNode in="halo"/>'
        +       '<feMergeNode in="SourceGraphic"/>'
        +     '</feMerge>'
        +   '</filter>'
        +   '<filter id="dna-glow-soft" x="-50%" y="-50%" width="200%" height="200%">'
        +     '<feGaussianBlur stdDeviation="5"/>'
        +   '</filter>'
        + '</defs>';
}

function renderBackdrop(W) {
    return ''
        + '<rect width="' + W + '" height="' + VIEW_H + '" fill="#02060c"/>'
        + '<rect width="' + W + '" height="' + VIEW_H + '" fill="url(#dna-vignette)"/>'
        + renderRadarRings(W)
        + renderDataParticles(W)
        + renderCornerDataText(W);
}

/* ── Faint concentric rings centered on the helicase region.
 *    Sits BEHIND everything else, very low opacity. Matches the
 *    target/radar visual in the reference image. ── */
function renderRadarRings(W) {
    const cx = W * 0.5;
    const cy = VIEW_H * 0.5;
    let s = '<g class="dna__radar" pointer-events="none">';
    const radii = [40, 80, 130, 180, 230, 280];
    for (const r of radii) {
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(110,231,255,0.06)" stroke-width="0.6"/>';
    }
    // Single dashed ring for accent
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="155" fill="none" stroke="rgba(110,231,255,0.12)" stroke-width="0.8" stroke-dasharray="2 6"/>';
    // Crosshair brackets at the center
    s += '<g stroke="rgba(110,231,255,0.18)" stroke-width="0.8" fill="none">';
    s += '<path d="M ' + (cx - 14) + ' ' + (cy - 18) + ' L ' + (cx - 14) + ' ' + (cy - 12) + ' L ' + (cx - 8) + ' ' + (cy - 12) + '"/>';
    s += '<path d="M ' + (cx + 14) + ' ' + (cy - 18) + ' L ' + (cx + 14) + ' ' + (cy - 12) + ' L ' + (cx + 8) + ' ' + (cy - 12) + '"/>';
    s += '<path d="M ' + (cx - 14) + ' ' + (cy + 18) + ' L ' + (cx - 14) + ' ' + (cy + 12) + ' L ' + (cx - 8) + ' ' + (cy + 12) + '"/>';
    s += '<path d="M ' + (cx + 14) + ' ' + (cy + 18) + ' L ' + (cx + 14) + ' ' + (cy + 12) + ' L ' + (cx + 8) + ' ' + (cy + 12) + '"/>';
    s += '</g>';
    s += '</g>';
    return s;
}

/* ── Scattered cyan data particles in the background ── */
function renderDataParticles(W) {
    let s = '<g class="dna__particles" pointer-events="none">';
    const COUNT = 70;
    for (let i = 0; i < COUNT; i++) {
        // Deterministic pseudo-random scatter so particles don't shift on every render
        const x = ((i * 137.5) % W).toFixed(1);
        const y = ((i * 89.3) % VIEW_H).toFixed(1);
        // Vary opacity + size for depth
        const r = (((i * 13) % 5) * 0.3 + 0.8).toFixed(2);
        const o = (((i * 7) % 5) * 0.06 + 0.18).toFixed(2);
        s += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="#6ee7ff" opacity="' + o + '"/>';
    }
    // Brighter scattered nodes (fewer, bigger)
    const BRIGHT = 14;
    for (let i = 0; i < BRIGHT; i++) {
        const x = ((i * 213.7 + 71) % W).toFixed(1);
        const y = ((i * 167.3 + 41) % VIEW_H).toFixed(1);
        s += '<circle cx="' + x + '" cy="' + y + '" r="2.2" fill="#a8f5ff" opacity="0.42" filter="url(#dna-glow-soft)"/>';
        s += '<circle cx="' + x + '" cy="' + y + '" r="1.4" fill="#fff" opacity="0.75"/>';
    }
    s += '</g>';
    return s;
}

/* ── Faint binary / coordinate text scattered in corners ── */
function renderCornerDataText(W) {
    const TXT = 'font-family="ui-monospace,SF Mono,monospace" font-size="6.5" fill="rgba(110,231,255,0.22)" letter-spacing="0.5"';
    const rows = [
        { x: 24,  y: 36,  t: '01101001 10110010 01010110' },
        { x: 24,  y: 48,  t: 'CHN.STRM v3.7 · 0xA1F2' },
        { x: 24,  y: 510, t: '11000110 01100101 0001' },
        { x: 24,  y: 522, t: 'LAT 38.2°N · LON 92.6°W' },
        // Right-side corner slots are now used by the "Upgrades · UI" and
        // "Upgrades · UX" labels rendered in renderBranchLabels, so we leave
        // these rows empty here to avoid overlapping text.
    ];
    let s = '<g class="dna__bg-text" pointer-events="none">';
    for (const r of rows) {
        s += '<text x="' + r.x + '" y="' + r.y + '" ' + TXT + '>' + esc(r.t) + '</text>';
    }
    s += '</g>';
    return s;
}

/* ── Parent DNA helix (left of topoisomerase): textbook DNA.
 *
 *    Renders like the reference image:
 *      • Two strands (cyan + blue) twisting in a few clean loops.
 *      • COLORED PEGS between the strands — one per community upgrade.
 *        Each peg uses its upgrade's surface color. Promoted upgrades
 *        get the GOLD treatment.
 *      • Pegs are full-height (yMid-amp to yMid+amp) at peak positions
 *        — the "closed gap" version of the half-pegs on the UI/UX strands.
 *      • Strands render ON TOP of the pegs so the strand lines are clearly
 *        visible as the connectors threading through every peg.
 *
 *    PARENT_TWIST=130 gives ~2 wide loops across the parent zone (vs the
 *    tight 4 loops we had before). ── */
function renderParentHelix(L, sealedPatches, communityPatches) {
    const x0 = L.xParent;
    const x1 = L.xTopo;
    const yMid = PARENT_CENTER_Y;
    const amp = PARENT_AMP;
    const SEG = PARENT_SEGS;
    const halfTwist = PARENT_TWIST / 2;

    // Two clean cosine-wave strand paths
    let sA = '', sB = '';
    for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const x = x0 + t * (x1 - x0);
        const localX = x - x0;
        const phase = (localX / PARENT_TWIST) * Math.PI * 2;
        const yA = yMid - amp * Math.cos(phase);
        const yB = yMid + amp * Math.cos(phase);
        sA += (i === 0 ? 'M ' : ' L ') + x.toFixed(2) + ' ' + yA.toFixed(2);
        sB += (i === 0 ? 'M ' : ' L ') + x.toFixed(2) + ' ' + yB.toFixed(2);
    }

    // Build the list of pegs to render in the parent: promoted upgrades
    // first (will get gold), followed by the rest of the community feed
    // (will get their surface colors). All render as full-height bonded
    // base pairs — the "closed gap" version of the unbonded UI/UX pegs.
    const sealedIds = new Set(sealedPatches.map((p) => p.id));
    const others = (communityPatches || []).filter((p) => !sealedIds.has(p.id));
    const ordered = [...sealedPatches, ...others];

    // Place pegs at evenly spaced positions, each SNAPPED to the nearest
    // strand peak (where the strands are at max separation) so every peg
    // renders at full height.
    const usableLocalW = (x1 - x0) - 40;
    const slotCount = Math.max(1, Math.min(ordered.length, Math.floor(usableLocalW / 22)));
    const pegPlacement = ordered.slice(0, slotCount).map((p, idx) => {
        const slotLocalX = 20 + ((idx + 0.5) / slotCount) * usableLocalW;
        const snappedLocalX = Math.round(slotLocalX / halfTwist) * halfTwist;
        return { x: x0 + snappedLocalX, patch: p, isPromoted: sealedIds.has(p.id) };
    });

    let pegs = '';
    pegPlacement.forEach(({ x, patch, isPromoted }) => {
        const meta = SURFACE[patch.target_surface] || SURFACE.global;
        const color = isPromoted ? TIER_GOLD : meta.color;
        const soft  = isPromoted ? '#fde68a' : meta.soft;
        pegs += renderPair({
            x, y1: yMid - amp, y2: yMid + amp,
            color, soft,
            patch, zone: 'sealed', barW: isPromoted ? 14 : 10,
        });
    });

    // Render: pegs FIRST (between the strands), then strands ON TOP so the
    // strand lines clearly thread through every peg position.
    return ''
        + pegs
        + '<path d="' + sA + '" fill="none" stroke="url(#dna-strand-top)" stroke-width="4.0" stroke-linecap="round" stroke-linejoin="round" opacity="1" filter="url(#dna-glow)"/>'
        + '<path d="' + sB + '" fill="none" stroke="url(#dna-strand-bot)" stroke-width="4.0" stroke-linecap="round" stroke-linejoin="round" opacity="1" filter="url(#dna-glow)"/>';
}

/* ── Fork transition: parent strands curve apart into the two RNA strands.
 *    Starts at xTopo (where the parent helix actually ends) and bridges
 *    UNDER the topoisomerase widget so the visual connection is continuous. */
function renderForkTransition(L) {
    const x0 = L.xTopo;                  // parent helix endpoint x
    const x1 = L.xBranch;                // RNA strand start x
    const yMid = PARENT_CENTER_Y;
    // parentW is forced to be an integer multiple of PARENT_TWIST in
    // _layout, so at x=xTopo the LOCAL phase is exactly 2πN. cos(2πN)=1,
    // so strand A is at the TOP peak (yMid-amp) and strand B at the BOTTOM
    // peak (yMid+amp). Branches flow out from those exact endpoints.
    const yTopEnd = yMid - PARENT_AMP;
    const yBotEnd = yMid + PARENT_AMP;
    const xMid = (x0 + x1) / 2;
    const topCurve  = 'M ' + x0 + ' ' + yTopEnd +
                      ' C ' + xMid + ' ' + yTopEnd + ', ' +
                              xMid + ' ' + TOP_STRAND_Y + ', ' +
                              x1 + ' ' + TOP_STRAND_Y;
    const botCurve  = 'M ' + x0 + ' ' + yBotEnd +
                      ' C ' + xMid + ' ' + yBotEnd + ', ' +
                              xMid + ' ' + BOT_STRAND_Y + ', ' +
                              x1 + ' ' + BOT_STRAND_Y;
    return ''
        // Top fork — wide soft halo behind a crisp core line (no filter to avoid bbox clipping)
        + '<path d="' + topCurve + '" fill="none" stroke="#6ee7ff" stroke-width="7" stroke-linecap="round" opacity="0.35"/>'
        + '<path d="' + topCurve + '" fill="none" stroke="#6ee7ff" stroke-width="3.4" stroke-linecap="round" opacity="1"/>'
        // Bottom fork — same two-pass treatment
        + '<path d="' + botCurve + '" fill="none" stroke="#7dd3fc" stroke-width="7" stroke-linecap="round" opacity="0.35"/>'
        + '<path d="' + botCurve + '" fill="none" stroke="#7dd3fc" stroke-width="3.4" stroke-linecap="round" opacity="1"/>';
}

/* ── RNA strand: single smooth backbone with one peg per REAL upgrade
 *    projecting INWARD toward the central axis. Pegs are UNBONDED — they
 *    do NOT reach across to the opposite strand. The central channel
 *    stays empty until the strands enter the topoisomerase and twist
 *    into the parent DNA, where pegs from both strands pair up to form
 *    full base pairs (the parent's rungs). ── */
function renderRnaStrand(L, strandY, patches, kind) {
    const x0 = L.xBranch;
    const x1 = L.totalW - 8;                         // extend all the way to the right edge
    const dir = kind === 'ui' ? 1 : -1;              // ui hangs DOWN (+y); ux rises UP (-y)
    const strandColor = kind === 'ui' ? '#6ee7ff' : '#7dd3fc';   // solid cyan / sky blue

    // Straight horizontal strand line spanning the FULL branch width.
    // NO filter — SVG filter regions are computed from element bounding
    // boxes, and a horizontal line has near-zero bbox height which
    // clips the rendered output. Using a halo line instead of feGaussianBlur.
    const strandSvg = ''
        + '<line x1="' + x0 + '" y1="' + strandY + '" x2="' + x1 + '" y2="' + strandY + '" '
        +   'stroke="' + strandColor + '" stroke-width="7" stroke-linecap="round" '
        +   'opacity="0.35"/>'
        + '<line x1="' + x0 + '" y1="' + strandY + '" x2="' + x1 + '" y2="' + strandY + '" '
        +   'stroke="' + strandColor + '" stroke-width="3.4" stroke-linecap="round" '
        +   'opacity="1"/>';

    // One peg per real upgrade, distributed evenly across the strand.
    // Sorted by adoption_count DESC (in _classify), so position 0 (leftmost
    // = closest to polymerase / parent DNA) has the highest adoption.
    const usableX0 = x0 + 28;
    const usableX1 = x1 - 28;
    const usableW = usableX1 - usableX0;
    const N = patches.length;
    let bars = '';
    patches.forEach((p, idx) => {
        if (N === 0) return;
        const x = usableX0 + ((idx + 0.5) / N) * usableW;
        const yStrand = strandY + STRAND_WAVE_AMP * Math.sin((x / STRAND_WAVE_PERIOD) * Math.PI * 2);
        const yEnd = yStrand + dir * BAR_LEN;
        const meta = SURFACE[p.target_surface] || SURFACE.global;
        bars += renderInwardBar({
            x, yStart: yStrand, yEnd,
            color: meta.color, soft: meta.soft,
            patch: p, zone: kind === 'ui' ? 'lagging-ui' : 'leading-ux',
        });
    });

    // Render bars FIRST, then the strand line ON TOP. The strand is the
    // line that visibly connects all the pegs — it threads across the
    // entire branch passing through every peg attachment point.
    return bars + strandSvg;
}

/* ── A single upgrade bar projecting inward from an RNA strand.
 *    Rounded rectangle + anchor dot at strand + tip cap at inner end. ── */
function renderInwardBar({ x, yStart, yEnd, color, soft, patch, zone }) {
    const id = esc(patch.id || '');
    const surface = patch.target_surface || 'global';
    const adoptCount = Number(patch.adoption_count) || 0;
    const yTop = Math.min(yStart, yEnd);
    const h = Math.abs(yEnd - yStart);
    const tipAttrs = ''
        + ' data-patch-id="' + id + '"'
        + ' data-title="'    + esc(patch.title || '') + '"'
        + ' data-author="'   + esc(patch.author_username || '') + '"'
        + ' data-adopt="'    + adoptCount + '"'
        + ' data-surface="'  + esc(surface) + '"'
        + ' data-promoted="' + (patch.is_promoted_to_main ? '1' : '0') + '"'
        + ' data-zone="'     + esc(zone || '') + '"';
    return ''
        + '<g class="dna__pair" ' + tipAttrs + '>'
        // Anchor dot at the strand
        +   '<circle cx="' + x + '" cy="' + yStart + '" r="3" fill="' + color + '" stroke="rgba(0,0,0,0.4)" stroke-width="0.6"/>'
        // The bar (rounded rect, full length)
        +   '<rect x="' + (x - BAR_W / 2) + '" y="' + yTop + '" width="' + BAR_W + '" height="' + h + '" rx="' + (BAR_W / 2) + '" '
        +       'fill="' + color + '" stroke="rgba(0,0,0,0.3)" stroke-width="0.5" opacity="0.92"/>'
        // Inner highlight (subtle gradient feel)
        +   '<rect x="' + (x - BAR_W / 2 + 0.6) + '" y="' + (yTop + 1) + '" width="' + (BAR_W * 0.4) + '" height="' + (h - 2) + '" rx="' + (BAR_W * 0.2) + '" '
        +       'fill="' + soft + '" opacity="0.55"/>'
        // Tip cap at the inner end
        +   '<circle cx="' + x + '" cy="' + yEnd + '" r="2.4" fill="' + soft + '" opacity="0.9"/>'
        + '</g>';
}

/* ── Topoisomerase: prominent bracketed widget at the fork.
 *    Spans the full parent strand-to-strand gap with a generous overhang. ── */
function renderTopoisomerase(L) {
    const TOPO_X_OFFSET = 60;             // shift the widget rightward into the fork-transition area
    const cx = L.xTopo + L.topoW / 2 + TOPO_X_OFFSET;
    const cy = PARENT_CENTER_Y;
    const w = 54;                         // wider (was 30)
    const h = PARENT_STRAND_GAP + 160;    // taller — 260 total (was 200)
    return ''
        + '<g class="dna__topo" data-anat="helicase" style="cursor:pointer">'
        // Faint highlight box
        +   '<rect x="' + (cx - w / 2) + '" y="' + (cy - h / 2) + '" width="' + w + '" height="' + h + '" '
        +     'fill="rgba(110,231,255,0.08)" stroke="rgba(110,231,255,0.5)" stroke-width="1.0"/>'
        // Corner brackets (cyan) — longer arms for prominence
        +   bracketCorner(cx - w / 2, cy - h / 2, 8,  8)
        +   bracketCorner(cx + w / 2, cy - h / 2, -8, 8)
        +   bracketCorner(cx - w / 2, cy + h / 2, 8,  -8)
        +   bracketCorner(cx + w / 2, cy + h / 2, -8, -8)
        + '</g>';
}
function bracketCorner(x, y, dx, dy) {
    return ''
        + '<path d="M ' + x + ' ' + (y + dy) + ' L ' + x + ' ' + y + ' L ' + (x + dx) + ' ' + y + '" '
        +   'fill="none" stroke="#6ee7ff" stroke-width="1.6" stroke-linecap="round"/>';
}

/* ── DNA Polymerase widget on a branch.
 *    Prominent amber bracketed rectangle — straddles the strand so bars
 *    on either side appear to "pass through" the adoption threshold. ── */
function renderBranchPolymerase(L, centerY, label) {
    const cx = L.xPoly;
    const cy = centerY;
    const w = POLY_W;
    const h = POLY_H;                      // matches BAR_LEN so peg fills it edge-to-edge
    return ''
        + '<g class="dna__polymerase" data-anat="polymerase" style="cursor:pointer">'
        // Soft amber highlight box
        +   '<rect x="' + (cx - w / 2) + '" y="' + (cy - h / 2) + '" width="' + w + '" height="' + h + '" '
        +     'rx="3" fill="rgba(245,158,11,0.12)" stroke="rgba(245,158,11,0.65)" stroke-width="1.2"/>'
        // Amber corner brackets
        +   bracketCornerColor(cx - w / 2, cy - h / 2, 8, 8,  '#fbbf24')
        +   bracketCornerColor(cx + w / 2, cy - h / 2, -8, 8, '#fbbf24')
        +   bracketCornerColor(cx - w / 2, cy + h / 2, 8, -8, '#fbbf24')
        +   bracketCornerColor(cx + w / 2, cy + h / 2, -8, -8,'#fbbf24')
        + '</g>';
}
function bracketCornerColor(x, y, dx, dy, color) {
    return ''
        + '<path d="M ' + x + ' ' + (y + dy) + ' L ' + x + ' ' + y + ' L ' + (x + dx) + ' ' + y + '" '
        +   'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round"/>';
}

/* ── Anatomy labels (textbook-style — staggered across two rows on top
 *    and two on the bottom so labels never crowd each other horizontally,
 *    each with a thin leader line pointing at the structure it names). ── */
function renderBranchLabels(L) {
    const TITLE_Y      = 98;                         // DexHero DNA · Main — anchored above the parent helix
    const ROW_TOP_INNER = 38;                        // inner top row (sub-labels, strand title)
    const ROW_BOT_INNER = VIEW_H - 30;               // inner bottom row (sub-labels, strand title)
    const TITLE = 'font-family="Inter,system-ui,sans-serif" font-size="16" letter-spacing="1.2" font-weight="700"';
    const LABEL = 'font-family="Inter,system-ui,sans-serif" font-size="13" letter-spacing="1.4" font-weight="700"';
    const SUB   = 'font-family="Inter,system-ui,sans-serif" font-size="13" letter-spacing="1.6" font-weight="700"';
    const LEADER = 'stroke="rgba(255,255,255,0.25)" stroke-width="0.7" stroke-dasharray="2 3"';

    const xParentMid = L.xParent + L.parentW / 2;
    const xTopoMid   = L.xTopo + L.topoW / 2 + 60;     // match TOPO_X_OFFSET in renderTopoisomerase
    // Centered in the post-polymerase "pending/free" zone of the strand
    // — left of this zone the COMMUNITY sub-label + polymerase widget sit.
    const xStrandMid = (L.xPoly + L.totalW) / 2;
    const xUI        = xStrandMid;
    const xUX        = xStrandMid;

    return ''
        // Title (moved down + larger): "DexHero DNA · Main", centered over the parent helix
        + '<text x="' + xParentMid + '" y="' + TITLE_Y + '" text-anchor="middle" ' + TITLE + ' '
        +   'fill="rgba(255,255,255,0.88)">DexHero DNA · Main</text>'
        // Top strand title: "UI · Upgrades"
        + '<text x="' + xUI + '" y="' + ROW_TOP_INNER + '" text-anchor="middle" ' + LABEL + ' '
        +   'fill="rgba(110,231,255,0.9)">UI · Upgrades</text>'
        // ROW_TOP_INNER (y=38): TOPOISOMERASE (with leader), DNA POLYMERASE (top, with leader)
        + '<text x="' + xTopoMid + '" y="' + ROW_TOP_INNER + '" text-anchor="middle" ' + SUB + ' '
        +   'fill="rgba(110,231,255,0.78)">DEXHERO</text>'
        + '<line x1="' + xTopoMid + '" y1="' + (ROW_TOP_INNER + 4) + '" x2="' + xTopoMid + '" y2="' + (PARENT_CENTER_Y - PARENT_AMP - 18) + '" ' + LEADER + '/>'
        + '<text x="' + L.xPoly + '" y="' + ROW_TOP_INNER + '" text-anchor="middle" ' + SUB + ' '
        +   'fill="rgba(251,191,36,0.85)">COMMUNITY</text>'
        + '<line x1="' + L.xPoly + '" y1="' + (ROW_TOP_INNER + 4) + '" x2="' + L.xPoly + '" y2="' + (UI_POLY_Y - 26) + '" ' + LEADER + '/>'
        // Bottom strand title: "UX · Upgrades"
        + '<text x="' + xUX + '" y="' + ROW_BOT_INNER + '" text-anchor="middle" ' + LABEL + ' '
        +   'fill="rgba(110,231,255,0.9)">UX · Upgrades</text>'
        // ROW_BOT_INNER (y=VIEW_H-30): DNA POLYMERASE (bottom, with leader)
        + '<text x="' + L.xPoly + '" y="' + ROW_BOT_INNER + '" text-anchor="middle" ' + SUB + ' '
        +   'fill="rgba(251,191,36,0.85)">COMMUNITY</text>'
        + '<line x1="' + L.xPoly + '" y1="' + (ROW_BOT_INNER - 6) + '" x2="' + L.xPoly + '" y2="' + (UX_POLY_Y + 26) + '" ' + LEADER + '/>';
}

/* ── Base pair bar between top and bottom strands ──
 * Two-tone: top half = UI color, bottom half = lighter UX complement.
 * `patch` provides title/author/adoption for the tooltip + click target. */
function renderPair({ x, y1, y2, color, soft, patch, zone, barW = BAR_W, faded = false }) {
    const id = esc(patch.id || '');
    const surface = patch.target_surface || 'global';
    const mid = (y1 + y2) / 2;
    const half = (y2 - y1) / 2;
    const opa = faded ? 0.35 : 1;
    const hasUx = (patch.behaviors && patch.behaviors.length) || (patch.config && Object.keys(patch.config).length);
    const topOp  = opa;
    const botOp  = hasUx ? opa : opa * 0.4;  // patches without behaviors have a faded UX half
    const adoptCount = Number(patch.adoption_count) || 0;
    const tipAttrs = ''
        + ' data-patch-id="' + id + '"'
        + ' data-title="'    + esc(patch.title || '') + '"'
        + ' data-author="'   + esc(patch.author_username || '') + '"'
        + ' data-adopt="'    + adoptCount + '"'
        + ' data-surface="'  + esc(surface) + '"'
        + ' data-promoted="' + (patch.is_promoted_to_main ? '1' : '0') + '"'
        + ' data-zone="'     + esc(zone || '') + '"';
    return ''
        + '<g class="dna__pair" ' + tipAttrs + '>'
        // Top half (UI)
        +   '<rect x="' + (x - barW / 2) + '" y="' + y1 + '" width="' + barW + '" height="' + half + '" rx="2" '
        +       'fill="' + color + '" opacity="' + topOp + '" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"/>'
        // Bottom half (UX) — lighter complement
        +   '<rect x="' + (x - barW / 2) + '" y="' + mid + '" width="' + barW + '" height="' + half + '" rx="2" '
        +       'fill="' + soft + '" opacity="' + botOp + '" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"/>'
        // Subtle center hairline (mimic A=T / G=C hydrogen bond)
        +   '<line x1="' + (x - barW / 2 + 1) + '" y1="' + mid + '" x2="' + (x + barW / 2 - 1) + '" y2="' + mid + '" stroke="rgba(0,0,0,0.5)" stroke-width="0.5"/>'
        + '</g>';
}

/* ── Approved zone bars (between helicase and polymerase) ── */
function renderApprovedBars(L, patches) {
    let s = '';
    patches.forEach((p, i) => {
        const x = L.xApproved + 30 + i * BAR_PITCH;
        if (x > L.xPolymerase - 12) return;
        const meta = SURFACE[p.target_surface] || SURFACE.global;
        s += renderPair({
            x,
            y1: strandY(x, STRAND_TOP_Y),
            y2: strandY(x, STRAND_BOT_Y),
            color: meta.color,
            soft: meta.soft,
            patch: p, zone: 'approved',
        });
    });
    return s;
}

/* ── Pending zone bars (right of polymerase) ── */
function renderPendingBars(L, patches) {
    let s = '';
    patches.forEach((p, i) => {
        const x = L.xPending + 30 + i * BAR_PITCH;
        if (x > L.xIncoming - 12) return;
        const meta = SURFACE[p.target_surface] || SURFACE.global;
        s += renderPair({
            x,
            y1: strandY(x, STRAND_TOP_Y),
            y2: strandY(x, STRAND_BOT_Y),
            color: meta.color,
            soft: meta.soft,
            patch: p, zone: 'pending',
        });
    });
    return s;
}

/* ── Free nucleotides (far right, unbound, drifting) ── */
function renderFreeNucleotides(L, patches) {
    let s = '';
    patches.forEach((p, i) => {
        const x = L.xIncoming + 30 + i * 26;
        const yJitter = ((i * 17) % 50) - 25;
        const y = (STRAND_TOP_Y + STRAND_BOT_Y) / 2 + yJitter;
        const meta = SURFACE[p.target_surface] || SURFACE.global;
        s += renderFreeNucleotide({ x, y, color: meta.color, soft: meta.soft, patch: p });
    });
    return s;
}

function renderFreeNucleotide({ x, y, color, soft, patch }) {
    const id = esc(patch.id || '');
    const adopt = Number(patch.adoption_count) || 0;
    // A small Y-shape (like nucleotide pieces in the textbook reference)
    const path = ''
        + 'M 0 -7 L 4 -2 L 4 6 L -4 6 L -4 -2 Z';   // simple arrow/Y body
    const tipAttrs = ''
        + ' data-patch-id="' + id + '"'
        + ' data-title="'    + esc(patch.title || '') + '"'
        + ' data-author="'   + esc(patch.author_username || '') + '"'
        + ' data-adopt="'    + adopt + '"'
        + ' data-surface="'  + esc(patch.target_surface || '') + '"'
        + ' data-promoted="0"'
        + ' data-zone="incoming"';
    return ''
        + '<g class="dna__free" ' + tipAttrs + ' transform="translate(' + x + ',' + y + ')">'
        +   '<path d="' + path + '" fill="' + color + '" stroke="rgba(0,0,0,0.4)" stroke-width="0.8"/>'
        +   '<line x1="-6" y1="0" x2="-9" y2="-3" stroke="' + color + '" stroke-width="1.4" stroke-linecap="round"/>'
        +   '<line x1="6" y1="0" x2="9" y2="-3" stroke="' + soft + '" stroke-width="1.4" stroke-linecap="round"/>'
        + '</g>';
}

/* ── Anatomy labels with leader lines ── */
function renderAnatomyLabels(L) {
    const cx = (L.xHelicase + L.helicaseW / 2);
    const polyCx = (L.xPolymerase + L.polymeraseW / 2);
    const labelStyle = 'font-family="Inter,system-ui,sans-serif" font-size="9.5" letter-spacing="1.6" font-weight="600" fill="rgba(255,255,255,0.7)"';
    return ''
        // Helicase label (above)
        + '<line x1="' + cx + '" y1="' + (STRAND_TOP_Y - 50) + '" x2="' + cx + '" y2="' + (STRAND_TOP_Y - 8) + '" stroke="rgba(255,255,255,0.4)" stroke-width="0.8"/>'
        + '<text x="' + cx + '" y="' + (STRAND_TOP_Y - 56) + '" text-anchor="middle" ' + labelStyle + '>HELICASE · PLATFORM</text>'
        + '<text x="' + cx + '" y="' + (STRAND_TOP_Y - 44) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="7.5" letter-spacing="2" fill="rgba(255,255,255,0.4)">final promotion authority</text>'
        // Polymerase label (above)
        + '<line x1="' + polyCx + '" y1="' + (STRAND_TOP_Y - 50) + '" x2="' + polyCx + '" y2="' + (STRAND_TOP_Y - 10) + '" stroke="rgba(255,255,255,0.4)" stroke-width="0.8"/>'
        + '<text x="' + polyCx + '" y="' + (STRAND_TOP_Y - 56) + '" text-anchor="middle" ' + labelStyle + '>DNA POLYMERASE</text>'
        + '<text x="' + polyCx + '" y="' + (STRAND_TOP_Y - 44) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="7.5" letter-spacing="2" fill="rgba(255,255,255,0.4)">adoption threshold · ' + PROMO_THRESHOLD + '+</text>'
        // Free nucleotides label
        + '<text x="' + (L.xIncoming + 30) + '" y="' + (STRAND_TOP_Y - 36) + '" ' + labelStyle + '>FREE NUCLEOTIDES</text>'
        + '<text x="' + (L.xIncoming + 30) + '" y="' + (STRAND_TOP_Y - 24) + '" font-family="Inter,system-ui,sans-serif" font-size="7.5" letter-spacing="2" fill="rgba(255,255,255,0.4)">new commits, unbound</text>'
        // Replication fork label
        + '<text x="' + (L.xHelicase - 10) + '" y="' + (STRAND_BOT_Y + 44) + '" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-size="8.5" letter-spacing="2" font-weight="600" fill="rgba(255,255,255,0.5)">REPLICATION FORK</text>'
        + '<line x1="' + (L.xHelicase - 10) + '" y1="' + (STRAND_BOT_Y + 36) + '" x2="' + (L.xHelicase + 10) + '" y2="' + (STRAND_BOT_Y + 8) + '" stroke="rgba(255,255,255,0.3)" stroke-width="0.8"/>'
        // Original template DNA label
        + '<text x="' + (L.xSealed + L.sealedW / 2) + '" y="' + (STRAND_BOT_Y + 50) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="8.5" letter-spacing="2.5" font-weight="600" fill="rgba(255,255,255,0.6)">ORIGINAL (TEMPLATE) DNA</text>'
        + '<text x="' + (L.xSealed + L.sealedW / 2) + '" y="' + (STRAND_BOT_Y + 62) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="7.5" letter-spacing="2" fill="rgba(255,255,255,0.4)">' + 'merged into platform default' + '</text>';
}

/* ── Zone labels strip (sticky bottom inside the canvas) ── */
function renderZoneLabels(L, cls) {
    const y = VIEW_H - 22;
    return ''
        + zoneLabel(L.xSealed + L.sealedW / 2,     y, 'SEALED · DEFAULT',    cls.sealed.length)
        + zoneLabel((L.xApproved + L.xPolymerase) / 2 + L.approvedW / 2 - L.approvedW / 2, y, 'COMMUNITY APPROVED', cls.approved.length, L.xApproved + L.approvedW / 2)
        + zoneLabel(L.xPending + L.pendingW / 2,   y, 'PENDING ADOPTION',     cls.pending.length)
        + zoneLabel(L.xIncoming + L.incomingW / 2, y, 'INCOMING',             cls.incoming.length);
}
function zoneLabel(cx, y, label, count, overrideCx) {
    const x = overrideCx ?? cx;
    return ''
        + '<g class="dna__zone-label">'
        +   '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="9" letter-spacing="2.5" font-weight="700" fill="rgba(255,255,255,0.5)">' + esc(label) + '</text>'
        +   '<text x="' + x + '" y="' + (y + 12) + '" text-anchor="middle" font-family="ui-monospace,SF Mono,monospace" font-size="9" letter-spacing="1" fill="rgba(255,255,255,0.35)">' + count + ' PATCHES</text>'
        + '</g>';
}

/* ── Tiny helpers ── */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000)  return (n / 1000).toFixed(2) + 'k';
    return String(n);
}
