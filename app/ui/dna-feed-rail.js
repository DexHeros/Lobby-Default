/* dna-feed-rail — social-media-style vertical feed of community
 * upgrade commits. Mounted on the LEFT side of the DNA Feed page
 * (#/main-branch). Each card embeds the existing draggable
 * before/after slider (buildDemoVideo in slider mode) so a reader
 * can sweep across any commit without leaving the feed.
 *
 * Live: subscribes to `dexhero:commit-added` and prepends a new
 * card the moment a user commits — no new endpoint or data table
 * needed; the existing event + getCommunityFeed already carry
 * everything we need to render. */

import {
    getCreatorAvatar, isAdopted, adoptPatch, unadoptPatch,
    getCommentCount,
    _fallbackCaption,
} from '../services/upgrades-mock.js';
// listPatches hits the real /api/upgrades endpoint backed by Supabase.
// Replaces the mock's getCommunityFeed so platform-agent posts (and any
// other server-authored patch) actually show up in the feed instead of
// the hardcoded FIXTURE_PATCHES baked into the mock.
import { listPatches } from '../services/upgrades-api.js';
import * as gitFeedApi from '../services/git-feed-api.js';
import { buildDemoVideo } from './upgrade-demo-video.js';
import { requestCapabilityConsent } from './capability-consent.js';
import { toast } from './toast.js';

/* Mirror of MainBranchPanel's SURFACE palette — kept local so the
 * rail doesn't import a panel module. Only the color/label fields
 * are read here. */
const SURFACE = {
    'equipment-slot': { color: '#06b6d4', label: 'Slot popovers' },
    'header-ticker':  { color: '#8b5cf6', label: 'Header ticker' },
    'chat-log':       { color: '#3b82f6', label: 'Chat log'      },
    'slot':           { color: '#22c55e', label: 'Slots'         },
    'global':         { color: '#94a3b8', label: 'Global'        },
};

export function buildDnaFeedRail({ limit = 40 } = {}) {
    const rail = document.createElement('div');
    rail.className = 'dna__feed-rail';

    // Drag-handle strip at the very top of the rail. Visually a small
    // horizontal grip; functionally it's a generous click target for
    // dragging the whole wing around (right-wing-resize.js's
    // attachContainerDrag picks up mousedown anywhere on .dna__feed-rail
    // that isn't on the list, cards, compose form, or resize handles).
    const dragHandle = document.createElement('div');
    dragHandle.className = 'dna__feed-rail__drag-handle';
    dragHandle.setAttribute('aria-hidden', 'true');
    dragHandle.title = 'Drag to move the feed';
    rail.appendChild(dragHandle);

    // Search bar — debounced free-text search across full_name / name /
    // description / summary. Empty input → unfiltered feed. Lives at
    // the TOP of the rail (mainstream-app pattern: search-up, post-down).
    const search = document.createElement('div');
    search.className = 'dna__feed-rail__search';
    search.innerHTML = `
        <form class="dna__feed-rail__search-form" data-search-form>
            <svg class="dna__feed-rail__search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" class="dna__feed-rail__search-input" data-search-input
                placeholder="Search repos…"
                aria-label="Search the feed"
                autocomplete="off"
                spellcheck="false"
                maxlength="80" />
            <button type="button" class="dna__feed-rail__search-clear" data-search-clear hidden aria-label="Clear search">×</button>
        </form>
    `;
    rail.appendChild(search);

    const list = document.createElement('div');
    list.className = 'dna__feed-rail__list';
    rail.appendChild(list);

    // Sentinel — IntersectionObserver pings this when it enters the
    // viewport; we kick off the next page fetch. Lives at the bottom of
    // the list and gets repositioned after every append. A `data-state`
    // attribute lets CSS render "loading…" / "end of feed" / hidden.
    const sentinel = document.createElement('div');
    sentinel.className = 'dna__feed-rail__sentinel';
    sentinel.setAttribute('data-state', 'idle');
    sentinel.innerHTML = `<span class="dna__feed-rail__sentinel-msg" data-sentinel-msg></span>`;
    rail.appendChild(sentinel);

    // Compose-bar: pinned at the BOTTOM as an app-style footer (matches
    // X/Bluesky/Threads composer placement). Paste a GitHub repo URL
    // and hit Post. Wrapped in a `__footer` chrome with blur + top
    // border so it reads as the rail's dock, not an inline form.
    const compose = document.createElement('footer');
    compose.className = 'dna__feed-rail__compose dna__feed-rail__footer';
    compose.innerHTML = `
        <form class="dna__feed-rail__compose-form" data-compose-form>
            <span class="dna__feed-rail__compose-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </span>
            <input type="url" class="dna__feed-rail__compose-input" data-compose-input
                placeholder="Paste a GitHub repo URL…"
                aria-label="GitHub repo URL" required />
            <button type="submit" class="dna__feed-rail__compose-submit" data-compose-submit>Post</button>
        </form>
    `;
    rail.appendChild(compose);

    const rendered = new Set();
    const byId = new Map();          // id → patch OR repo post, populated from BOTH feed sources
    const ac = new AbortController();

    /* Discriminator — a row with repo_url is a Git Feed repo post; otherwise
     * it's a CSS patch from ui_patches. Returns 'repo' | 'patch'. */
    function _typeOf(post) {
        return post && typeof post.repo_url === 'string' && post.repo_url ? 'repo' : 'patch';
    }

    function renderCard(post, opts = {}) {
        if (!post || !post.id || rendered.has(post.id)) return null;
        if (_typeOf(post) === 'repo') return renderRepoCard(post, opts);
        return renderPatchCard(post, opts);
    }

    function renderPatchCard(patch, opts = {}) {
        rendered.add(patch.id);

        const surface  = SURFACE[patch.target_surface] || SURFACE.global;
        const author   = patch.author_username || 'dexhero';
        const merged   = !!patch.is_promoted_to_main;
        const adopters = patch.adoption_count || 0;

        const card = document.createElement('article');
        card.className = 'dna__feed-card';
        card.setAttribute('data-patch-id', patch.id);
        if (merged) card.classList.add('is-merged');

        card.innerHTML = `
            <div class="dna__feed-card__video" data-demo>
                ${merged ? '<span class="dna__feed-card__merged">★ MERGED</span>' : ''}
            </div>
            ${renderSocialFooter(patch, { storyMode: true })}
        `;

        // Mount the before/after slider — same component used by
        // the proposal card / community feed / detail page.
        const mount = card.querySelector('[data-demo]');
        const demo  = buildDemoVideo(patch, {
            mode: 'slider',
            size: 'compact',
            modesAllowed: ['slider', 'cycle'],
        });
        if (demo) mount.appendChild(demo);

        // Whole card is clickable; clicks on the slider/demo chrome are
        // swallowed so the user can drag the before/after handle freely.
        // Social-action buttons (adopt/share/comment) handle their own
        // navigation and stop propagation.
        card.addEventListener('click', (ev) => {
            if (ev.target.closest('.upgrade-demo-video')) return;
            if (ev.target.closest('[data-social-action]')) return;
            location.hash = '#/upgrade/' + encodeURIComponent(patch.id);
        }, { signal: ac.signal });

        if (opts.isNew) {
            card.classList.add('is-new');
            // Strip the pulse class after the animation so subsequent
            // renders don't re-trigger it.
            setTimeout(() => card.classList.remove('is-new'), 600);
        }
        return card;
    }

    /* Repo card — distinct shape from the patch card. No before/after
     * slider; instead a header with owner avatar + repo name, the LLM
     * summary, language + stars badges, topic chips, and the Adopt +
     * Open-on-GitHub actions. */
    function renderRepoCard(post, opts = {}) {
        rendered.add(post.id);
        const card = document.createElement('article');
        card.className = 'dna__feed-card dna__feed-card--repo';
        card.setAttribute('data-post-id', post.id);
        card.setAttribute('data-kind', 'repo');

        const topicsHTML = (Array.isArray(post.topics) ? post.topics : [])
            .slice(0, 4)
            .map((t) => `<span class="dna__feed-repo__topic">${escape(t)}</span>`)
            .join('');

        const lang = post.language ? `<span class="dna__feed-repo__lang">${escape(post.language)}</span>` : '';
        const stars = (post.stars | 0).toLocaleString();
        const adoptCount = Number(post.adoption_count) || 0;
        const summary = post.summary || post.description || '';
        const ownerAvatar = post.owner_avatar
            ? `<img src="${escape(post.owner_avatar)}" alt="" class="dna__feed-repo__avatar-img" loading="lazy" />`
            : `<span class="dna__feed-repo__avatar-fallback">${escape((post.owner || '?').charAt(0).toUpperCase())}</span>`;

        card.innerHTML = `
            <header class="dna__feed-repo__header">
                <a class="dna__feed-repo__avatar" href="${escape(post.repo_url)}" target="_blank" rel="noopener" aria-label="${escape(post.owner)} on GitHub">
                    ${ownerAvatar}
                </a>
                <div class="dna__feed-repo__head-text">
                    <a class="dna__feed-repo__name" href="${escape(post.repo_url)}" target="_blank" rel="noopener">
                        <span class="dna__feed-repo__owner">${escape(post.owner)}/</span><span class="dna__feed-repo__repo">${escape(post.name)}</span>
                    </a>
                    <div class="dna__feed-repo__meta">
                        ${lang}
                        <span class="dna__feed-repo__stars">★ ${stars}</span>
                        ${post.is_scraped ? '<span class="dna__feed-repo__src">trending</span>' : ''}
                    </div>
                </div>
            </header>
            <p class="dna__feed-repo__summary">${escape(summary)}</p>
            ${topicsHTML ? `<div class="dna__feed-repo__topics">${topicsHTML}</div>` : ''}
            <section class="dna__feed-repo__readme" data-readme hidden aria-hidden="true">
                <div class="dna__feed-repo__readme-state" data-readme-state>Loading README…</div>
                <div class="dna__feed-repo__readme-content" data-readme-content></div>
            </section>
            <footer class="dna__feed-repo__actions">
                <button type="button" class="dna__feed-card__action dna__feed-repo__adopt" data-repo-action="adopt" aria-label="Adopt repo">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    <span>Adopt</span><span data-count>${adoptCount}</span>
                </button>
                <a class="dna__feed-card__action dna__feed-repo__open" href="${escape(post.repo_url)}" target="_blank" rel="noopener">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    <span>GitHub</span>
                </a>
            </footer>
        `;

        if (opts.isNew) {
            card.classList.add('is-new');
            setTimeout(() => card.classList.remove('is-new'), 600);
        }

        // Click-to-expand the rendered README inside the card. Clicks on
        // any link, button, action, or topic chip are ignored so the
        // existing controls keep their own behavior. First expand fetches
        // + sanitizes; subsequent toggles just show/hide.
        card.addEventListener('click', async (ev) => {
            if (ev.target.closest('a')) return;
            if (ev.target.closest('button')) return;
            if (ev.target.closest('[data-repo-action]')) return;
            await _toggleRepoCardExpand(card, post);
        }, { signal: ac.signal });

        return card;
    }

    /* Toggle the in-card README panel. Lazy-loads on first expand,
     * caches per card afterward (server also caches per post id). */
    async function _toggleRepoCardExpand(card, post) {
        const panel  = card.querySelector('[data-readme]');
        const state  = card.querySelector('[data-readme-state]');
        const target = card.querySelector('[data-readme-content]');
        if (!panel || !target) return;
        const isOpen = !panel.hidden;
        if (isOpen) {
            panel.hidden = true;
            panel.setAttribute('aria-hidden', 'true');
            card.classList.remove('is-expanded');
            return;
        }
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false');
        card.classList.add('is-expanded');
        if (target.dataset.loaded === '1') return;     // already populated
        // Show "Loading…" while we fetch.
        if (state) state.hidden = false;
        target.innerHTML = '';
        const r = await gitFeedApi.fetchPostReadme(post.id);
        if (state) state.hidden = true;
        if (!r.ok) {
            target.innerHTML = `<div class="dna__feed-repo__readme-error">Could not load README: ${escape(r.error || 'unknown')}</div>`;
            return;
        }
        if (!r.html) {
            target.innerHTML = `<div class="dna__feed-repo__readme-error">This repo has no README.</div>`;
            target.dataset.loaded = '1';
            return;
        }
        const safe = _sanitizeReadmeHtml(r.html);
        target.innerHTML = safe;
        // Make every link open in a new tab so we don't blow away the
        // user's lobby. Internal anchors (href starting with #) are kept
        // in-page so README TOC links jump within the panel.
        target.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('#')) return;
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener nofollow');
        });
        target.dataset.loaded = '1';
    }

    /* Tight allowlist sanitizer for GitHub-rendered README HTML. GitHub's
     * vnd.github.html output is already cleaned of script/user-supplied
     * HTML, but we run a second pass before injecting into a logged-in
     * lobby. Strips: script, style, iframe, object, embed, on*-handlers,
     * javascript:/data: URLs (except data:image), unknown protocols. */
    function _sanitizeReadmeHtml(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'BASE', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
        const toDrop = [];
        while (walker.nextNode()) {
            const el = walker.currentNode;
            if (DROP_TAGS.has(el.tagName)) {
                toDrop.push(el);
                continue;
            }
            // Strip on*-handlers + dangerous attribute values.
            for (const attr of [...el.attributes]) {
                const n = attr.name.toLowerCase();
                const v = attr.value || '';
                if (n.startsWith('on')) el.removeAttribute(attr.name);
                else if ((n === 'href' || n === 'src') && /^\s*(?:javascript|vbscript|data):/i.test(v)) {
                    // Allow data:image/* but nothing else with data:.
                    if (!/^\s*data:image\//i.test(v)) el.removeAttribute(attr.name);
                }
            }
            // Defensive: drop <a href="javascript:..."> if it slipped through.
            if (el.tagName === 'A') {
                const h = el.getAttribute('href') || '';
                if (/^\s*javascript:/i.test(h)) el.removeAttribute('href');
            }
        }
        for (const el of toDrop) el.remove();
        return doc.body.innerHTML;
    }

    /* Reset the sentinel back to idle/end after a successful prepend so
     * the "Feed is warming up…" / "No matches" message clears. Idempotent
     * — safe to call when the sentinel is already in another state. */
    function _clearEmptyState() {
        if (sentinel.getAttribute('data-state') === 'empty') {
            // After a prepend, there's exactly one card visible. We don't
            // know if more pages exist upstream until the next scroll, so
            // mark idle and let the observer trigger a fetch if the user
            // scrolls.
            _setSentinel('idle');
        }
    }

    /* ── Paginated feed state machine ──
     * The rail behaves like a social-media feed: one query at a time,
     * infinite scroll downward, fresh search resets the cursor. The
     * state object below is the single source of truth — every fetch
     * checks `loadEpoch` so a slow response from a previous query
     * can't stomp the current view.
     */
    const PAGE_SIZE  = 20;
    const state = {
        query:       '',     // current search string (trimmed)
        offset:      0,      // next page starts here
        loading:     false,  // a fetch is in flight
        exhausted:   false,  // last response was < PAGE_SIZE → no more pages
        loadEpoch:   0,      // bumped on every fresh-start (search change)
    };
    const sentinelMsg = sentinel.querySelector('[data-sentinel-msg]');
    function _setSentinel(stateName, msg = '') {
        sentinel.setAttribute('data-state', stateName);
        if (sentinelMsg) sentinelMsg.textContent = msg;
    }

    /* Load the next page of results. Appends to the existing list.
     * `reset` clears the list first (used on search change / initial).
     * Bumps loadEpoch on reset so any in-flight previous page is
     * discarded when it returns. */
    async function loadMore({ reset = false } = {}) {
        if (state.loading) return;
        if (!reset && state.exhausted) return;
        const epoch = reset ? ++state.loadEpoch : state.loadEpoch;
        state.loading = true;

        if (reset) {
            state.offset    = 0;
            state.exhausted = false;
            list.innerHTML  = '';
            rendered.clear();
            _setSentinel('loading', state.query ? 'Searching…' : 'Loading feed…');
        } else {
            _setSentinel('loading', 'Loading more…');
        }

        let posts;
        try {
            posts = await gitFeedApi.listPosts({
                sort:   'new',
                limit:  PAGE_SIZE,
                offset: state.offset,
                q:      state.query || null,
            });
        } catch {
            posts = [];
        }

        // Drop the response on the floor if a newer epoch has started.
        if (epoch !== state.loadEpoch) return;

        state.loading = false;
        if (!Array.isArray(posts)) posts = [];

        // First-page-empty handling — distinct messages for "no search
        // results" vs "feed is warming up".
        if (reset && posts.length === 0) {
            state.exhausted = true;
            if (state.query) {
                _setSentinel('empty', `No repos match "${state.query}".`);
            } else {
                _setSentinel('empty', 'Feed is warming up — the platform is scraping GitHub trending. Refresh in a moment, or post a repo above to seed it.');
            }
            return;
        }

        const frag = document.createDocumentFragment();
        for (const p of posts) {
            byId.set(p.id, p);
            const card = renderCard(p);
            if (card) frag.appendChild(card);
        }
        list.appendChild(frag);
        state.offset += posts.length;

        // Short response → nothing left upstream. Mark exhausted so the
        // observer stops re-firing and show the end-of-feed message.
        if (posts.length < PAGE_SIZE) {
            state.exhausted = true;
            _setSentinel('end', list.children.length ? "You've reached the end." : '');
        } else {
            _setSentinel('idle');
        }
    }

    /* Wire the IntersectionObserver to the sentinel. When the sentinel
     * scrolls into the viewport (rail's scroll container), kick off
     * the next page. rootMargin overshoots by 200px so the next batch
     * starts loading BEFORE the user hits the bottom — feels seamless. */
    const io = (typeof IntersectionObserver !== 'undefined')
        ? new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) loadMore();
            }
        }, { root: list, rootMargin: '200px', threshold: 0 })
        : null;
    io?.observe(sentinel);

    /* Wire the search input. Debounce keystrokes by 250ms so a fast
     * typer doesn't burn 8 requests typing "ai agent". Empty query
     * shows the full feed; otherwise filter via ?q=… */
    const searchForm  = search.querySelector('[data-search-form]');
    const searchInput = search.querySelector('[data-search-input]');
    const searchClear = search.querySelector('[data-search-clear]');
    let _searchDebounce = 0;
    function _applySearch(value) {
        const next = String(value || '').trim();
        if (next === state.query) return;
        state.query = next;
        if (searchClear) searchClear.hidden = !next;
        loadMore({ reset: true });
    }
    searchInput?.addEventListener('input', (ev) => {
        clearTimeout(_searchDebounce);
        const value = ev.target.value;
        _searchDebounce = setTimeout(() => _applySearch(value), 250);
    }, { signal: ac.signal });
    searchForm?.addEventListener('submit', (ev) => {
        ev.preventDefault();
        clearTimeout(_searchDebounce);
        _applySearch(searchInput.value);
    }, { signal: ac.signal });
    searchClear?.addEventListener('click', () => {
        if (!searchInput) return;
        searchInput.value = '';
        clearTimeout(_searchDebounce);
        _applySearch('');
        searchInput.focus();
    }, { signal: ac.signal });

    async function renderInitial() {
        // Phase 1 of Git Feed: repo posts only. CSS patches still exist
        // as the IDE primitive (propose_patch / MCP / /apply) but no
        // longer surface in this rail. renderPatchCard is preserved as
        // dead code for if/when we re-enable a mixed-type view.
        await loadMore({ reset: true });
    }

    function prependCommit(patch) {
        if (!patch || !patch.id) return;
        if (rendered.has(patch.id)) return;
        byId.set(patch.id, patch);
        const card = renderCard(patch, { isNew: true });
        if (!card) return;
        _clearEmptyState();
        list.insertBefore(card, list.firstChild);
    }

    // dexhero:commit-added used to prepend CSS-patch cards live as users
    // committed them. Disabled for Phase 1 Git Feed (repo-only). Will be
    // re-enabled if/when patches return to the feed surface.
    // document.addEventListener('dexhero:commit-added', ...);

    /* Live comment-count update — when a comment is added (anywhere in
     * the app), bump the chip on the matching feed card without re-
     * rendering the whole rail. */
    document.addEventListener('dexhero:comment-added', (ev) => {
        const { patchId, count } = ev?.detail || {};
        if (!patchId) return;
        const card = rail.querySelector(`.dna__feed-card[data-patch-id="${CSS.escape(patchId)}"]`);
        const chip = card?.querySelector('[data-social-action="comment"] [data-count]');
        if (chip) chip.textContent = String(count ?? getCommentCount(patchId));
    }, { signal: ac.signal });

    /* Compose-bar — paste a repo URL, click Post → server fetches +
     * summarizes + persists, then we prepend the new card. */
    const composeForm   = compose.querySelector('[data-compose-form]');
    const composeInput  = compose.querySelector('[data-compose-input]');
    composeForm?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const repoUrl = (composeInput?.value || '').trim();
        if (!repoUrl) return;
        const submit = composeForm.querySelector('[data-compose-submit]');
        if (submit) { submit.disabled = true; submit.textContent = 'Posting…'; }
        try {
            const r = await gitFeedApi.postRepo(repoUrl);
            if (!r.ok) {
                // Surface specific error codes with actionable messages.
                // The server returns { error: <code>, message: <human> }.
                if (r.error === 'link_github') {
                    const me = (window.dexheroWallet?.getStatus?.()?.address || '').toLowerCase();
                    if (confirm('You need to link your GitHub account first. Link now?')) {
                        const ret = encodeURIComponent(location.hash || '#/');
                        const walletQs = me ? `&wallet=${encodeURIComponent(me)}` : '';
                        location.href = `/api/auth/github/begin?return=${ret}${walletQs}`;
                    }
                } else if (r.error === 'repo_not_owned') {
                    toast(`Only your own repos. Your GitHub: @${r.linked_github}; this repo is @${r.repo_owner}.`, { kind: 'warn', ttl: 5000 });
                } else if (r.error === 'connect_wallet') {
                    toast('Connect your wallet to post a repo.', { kind: 'warn', ttl: 3500 });
                } else if (r.error === 'mint_dexhero') {
                    toast('You need a dexhero to post. Visit /create to mint one.', { kind: 'warn', ttl: 4000 });
                } else if (r.error === 'unparseable_repo_url') {
                    toast('Could not parse that URL. Expected https://github.com/owner/repo', { kind: 'warn', ttl: 4000 });
                } else {
                    toast(r.message || `Could not post: ${r.error || 'unknown'}`, { kind: 'warn', ttl: 3800 });
                }
                return;
            }
            const post = r.post;
            if (post && post.id) {
                if (r.existing) {
                    toast(`Already on the feed · ${post.full_name}`, { kind: 'info', ttl: 2500 });
                    // Scroll the existing card into view rather than re-prepending.
                    const existing = rail.querySelector(`[data-post-id="${CSS.escape(post.id)}"]`);
                    existing?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    byId.set(post.id, post);
                    const card = renderCard(post, { isNew: true });
                    if (card) {
                        _clearEmptyState();
                        list.insertBefore(card, list.firstChild);
                    }
                    toast(`Posted · ${post.full_name}`, { kind: 'ok', ttl: 2800 });
                }
                composeInput.value = '';
            }
        } finally {
            if (submit) { submit.disabled = false; submit.textContent = 'Post'; }
        }
    }, { signal: ac.signal });

    /* Delegated repo-action handler — Adopt button on repo cards.
     * Phase 1: records the adoption + bumps counter. Phase 2 will open
     * the IDE chat with the repo as pre-seeded context. */
    rail.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-repo-action]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const card = btn.closest('[data-post-id]');
        const postId = card?.getAttribute('data-post-id');
        const post = postId ? byId.get(postId) : null;
        if (!post) return;
        const action = btn.getAttribute('data-repo-action');
        if (action !== 'adopt') return;

        btn.disabled = true;
        try {
            const r = await gitFeedApi.adoptPost(postId);
            if (!r.ok) {
                toast(`Could not adopt: ${r.error || 'unknown'}`, { kind: 'warn', ttl: 3000 });
                return;
            }
            const countEl = btn.querySelector('[data-count]');
            if (countEl) countEl.textContent = String(r.adoption_count ?? 0);
            btn.classList.toggle('is-adopted', true);
            if (r.already) {
                toast(`Already adopted · ${post.full_name}`, { kind: 'info', ttl: 2400 });
            } else {
                // Phase 2 will open an IDE chat here with the repo as context.
                toast(`Adopted · ${post.full_name}. The dexhero integration flow ships next.`, { kind: 'ok', ttl: 3600 });
            }
        } finally {
            btn.disabled = false;
        }
    }, { signal: ac.signal });

    /* Delegated social-action handler — one listener for the whole rail
     * covers every card's adopt/share/comment button. */
    rail.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-social-action]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const cardEl = btn.closest('.dna__feed-card');
        const patchId = cardEl?.getAttribute('data-patch-id');
        if (!patchId) return;
        const action = btn.getAttribute('data-social-action');
        const patch = byId.get(patchId);
        if (!patch) return;
        if (action === 'share') {
            const url = `${location.origin}/${location.pathname.replace(/\/?$/, '/')}#/upgrade/${patchId}`.replace(/\/+#/, '/#');
            try {
                await navigator.clipboard.writeText(url);
                toast('Link copied', { kind: 'ok', ttl: 2200 });
            } catch {
                toast('Could not copy link', { kind: 'warn', ttl: 2400 });
            }
        } else if (action === 'comment') {
            // Hash routes can't embed sub-fragments — `#/upgrade/X#comments`
            // is one big fragment to the browser, breaking the router regex.
            // Stash an intent flag instead; the detail panel reads it on
            // mount and scrolls to the comments section + focuses input.
            try { sessionStorage.setItem('v3labs:scroll-to', 'comments'); } catch {}
            location.hash = '#/upgrade/' + encodeURIComponent(patchId);
        } else if (action === 'adopt') {
            if (isAdopted(patchId)) {
                unadoptPatch(patchId);
                toast('Revert pushed · patch removed from your branch', { kind: 'info', ttl: 2400 });
            } else {
                if (Array.isArray(patch.behaviors) && patch.behaviors.length) {
                    const ok = await requestCapabilityConsent(patch);
                    if (!ok) { toast('Adopt cancelled', { kind: 'info', ttl: 2000 }); return; }
                }
                adoptPatch(patchId);
                toast(`Adopted "${patch.title}"`, { kind: 'ok', ttl: 3000 });
            }
            // Refresh just this card's adopt button state + count
            const adoptBtn = cardEl.querySelector('[data-social-action="adopt"]');
            const countEl  = adoptBtn?.querySelector('[data-count]');
            if (countEl) {
                // Local-only count update; the next listPatches refresh
                // will pull the authoritative server value.
                countEl.textContent = String(patch.adoption_count ?? 0);
            }
            adoptBtn?.classList.toggle('is-adopted', isAdopted(patchId));
        }
    }, { signal: ac.signal });

    renderInitial();

    /* Pin the open/close folder tab (#lobby-stage-next) to the rail's
     * actual rendered position. The CSS-var math couldn't reliably hit
     * the rail's left edge because intermediate wing/panel containers
     * add layout offsets. Measuring at runtime + writing inline styles
     * is the only foolproof way to make the tab fuse seamlessly with
     * the rail. Open-state only: collapsed state still uses pure CSS.
     *
     * NOTE: the stylesheet uses !important on left/top so the tab is
     * visible before JS runs. setProperty(..., 'important') is required
     * to beat that — plain `tab.style.left = ...` is silently ignored. */
    const _syncTabToRail = () => {
        const tab = document.getElementById('lobby-stage-next');
        if (!tab) return;
        // On mobile (≤640px) the wing goes full-bleed and the tab uses
        // pure-CSS right-edge positioning in both states (see shell.css
        // mobile override block). Clear any leftover inline styles a
        // prior desktop layout pass may have set, then bail out.
        if (typeof window !== 'undefined'
            && window.matchMedia
            && window.matchMedia('(max-width: 640px)').matches) {
            tab.style.removeProperty('top');
            tab.style.removeProperty('left');
            return;
        }
        // Don't touch the tab when the wing is collapsed — its right-edge
        // CSS positioning is correct for that state.
        if (tab.getAttribute('data-wing-collapsed') === 'true') {
            tab.style.removeProperty('top');
            tab.style.removeProperty('left');
            return;
        }
        const r = rail.getBoundingClientRect();
        if (!r || r.width === 0) return;
        // Tab is 26px wide; its right edge overlaps the rail's 1px left
        // border by 1px so they read as one continuous surface. Tab+rail
        // share identical background / blur values (see shell.css +
        // upgrades.css) so the small backdrop-sample mismatch between
        // them is the only visible difference, and it's at the meeting
        // edge where the overlap hides the rail's hairline border.
        const TAB_W = 26;
        const TAB_OVERLAP = 1;
        tab.style.setProperty('left', `${Math.round(r.left - TAB_W + TAB_OVERLAP)}px`, 'important');
        tab.style.setProperty('top',  `${Math.round(r.top)}px`, 'important');
    };
    // Sync on every relevant layout event. The rail's position can change
    // from: window resize, wing drag/resize, wing collapse/expand,
    // panel-switch (feed/chat/topics), font-load reflow, etc.
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(_syncTabToRail) : null;
    ro?.observe(rail);
    // Also observe document.documentElement so we catch viewport-level
    // layout shifts (e.g. lobby-bar appearing on first paint).
    ro?.observe(document.documentElement);
    window.addEventListener('resize',  _syncTabToRail, { signal: ac.signal });
    window.addEventListener('scroll',  _syncTabToRail, { signal: ac.signal, passive: true });
    // Watch <html>'s style attribute for CSS-var changes. When the user
    // drags the wing (right-wing-resize.js writes --wing-right-left
    // and --wing-right-top to documentElement.style), ResizeObserver
    // doesn't fire because the rail's SIZE doesn't change — only its
    // POSITION. The MutationObserver picks this up.
    const htmlObs = new MutationObserver(_syncTabToRail);
    htmlObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // Wing's data-wing-collapsed attr changes when the user clicks the
    // tab. Watch it directly on the tab element so we cleanly switch
    // between JS-positioned (open) and CSS-positioned (collapsed) modes.
    const tabEl = document.getElementById('lobby-stage-next');
    const mo = tabEl ? new MutationObserver(_syncTabToRail) : null;
    if (tabEl && mo) {
        mo.observe(tabEl, { attributes: true, attributeFilter: ['data-wing-collapsed'] });
    }
    // Initial sync after layout settles (next frame). The rail's rect
    // is 0×0 until the browser has finished its first paint pass.
    requestAnimationFrame(_syncTabToRail);
    setTimeout(_syncTabToRail, 100);
    setTimeout(_syncTabToRail, 500);

    rail._dispose = () => {
        try { ac.abort(); } catch {}
        try { ro?.disconnect(); } catch {}
        try { mo?.disconnect(); } catch {}
        try { htmlObs?.disconnect(); } catch {}
        try { io?.disconnect(); } catch {}
        // Clear any inline styles we wrote so the next mount starts clean.
        const tab = document.getElementById('lobby-stage-next');
        if (tab) {
            tab.style.removeProperty('top');
            tab.style.removeProperty('left');
        }
    };
    rail._refresh = () => loadMore({ reset: true });

    return rail;
}

/* ── Helpers ── */

function escape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Social-post footer chrome — avatar + @username + caption + #tag chips
 * + three action buttons (adopt / share / comment) with their counts.
 *
 * Used by the DNA Feed rail (here), the proposal card (in chat), and
 * the community-upgrades grid card. Returns an HTML string so callers
 * can splice it into their own innerHTML without an extra DOM round-trip.
 *
 * The delegated click handler on the rail catches data-social-action
 * presses. Other surfaces that mount this footer either wire their own
 * delegated handler or rely on the action elements being inert (pre-commit
 * counts are 0 · 0 · 0 on the proposal card). */
export function renderSocialFooter(patch, opts = {}) {
    if (!patch) return '';
    const author = patch.author_username || 'dexhero';
    const avatar = getCreatorAvatar(author) || '◆';
    const caption = patch.caption || _fallbackCaption(patch);
    const adoptCount = Number(patch.adoption_count) || 0;
    const adopted = opts.adoptedNow != null ? opts.adoptedNow : (typeof isAdopted === 'function' ? isAdopted(patch.id) : false);
    // Default the comment count to the live store value so card mounts
    // outside of refresh paths still see the current number. Callers can
    // override with `opts.commentCount` for predictable test rendering.
    const commentCount = opts.commentCount != null
        ? opts.commentCount
        : (typeof getCommentCount === 'function' ? getCommentCount(patch.id) : 0);

    // Inline SVG icons — small, consistent stroke
    const ICON = {
        adopt:   '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>',
        share:   '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
        comment: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    };

    // Story-mode extras — title above the caption. Mounted only by the DNA
    // Feed rail (opts.storyMode), kept off the proposal card + community-
    // upgrades grid so their tighter chrome isn't disrupted.
    const storyTitle = opts.storyMode && patch.title
        ? `<h3 class="dna__feed-card__title">${escape(patch.title)}</h3>`
        : '';

    return `
        <footer class="dna__feed-card__social">
            <div class="dna__feed-card__byline">
                <span class="dna__feed-card__avatar" aria-hidden="true">${escape(avatar)}</span>
                <a class="dna__feed-card__handle" href="#/creator/${encodeURIComponent(author)}" data-social-action="creator">@${escape(author)}</a>
                ${patch.is_promoted_to_main ? '<span class="dna__feed-card__merged-tag" title="Merged into main">★</span>' : ''}
            </div>
            ${storyTitle}
            <p class="dna__feed-card__caption">${escape(caption)}</p>
            <div class="dna__feed-card__actions">
                <button type="button" class="dna__feed-card__action${adopted ? ' is-adopted' : ''}" data-social-action="adopt" aria-label="${adopted ? 'Unadopt' : 'Adopt'}" title="${adopted ? 'Unadopt' : 'Adopt'}">
                    ${ICON.adopt}<span data-count>${adoptCount}</span>
                </button>
                <button type="button" class="dna__feed-card__action" data-social-action="share" aria-label="Share" title="Copy link">
                    ${ICON.share}
                </button>
                <button type="button" class="dna__feed-card__action" data-social-action="comment" aria-label="Comment" title="Comment">
                    ${ICON.comment}<span data-count>${commentCount}</span>
                </button>
            </div>
        </footer>
    `;
}
