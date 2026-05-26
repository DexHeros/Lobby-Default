/* Git Feed API client — thin fetch wrapper over /api/git-feed/* on the
 * server. Plan §16. Mirrors the auth pattern of upgrades-api.js: wallet
 * in x-v3labs-wallet header for mutations, ?wallet= query param for
 * SSE/GET fallbacks. */

import * as walletSvc from './wallet.js';

function _wallet() {
    try {
        const s = walletSvc.getStatus?.();
        const a = s?.address;
        return (a && /^0x[0-9a-fA-F]{40}$/.test(a)) ? a.toLowerCase() : '';
    } catch { return ''; }
}

function _authHeaders() {
    const w = _wallet();
    const h = { 'content-type': 'application/json' };
    if (w) h['x-v3labs-wallet'] = w;
    return h;
}

/* Submit a GitHub repo URL. Server fetches metadata + README, calls the
 * LLM summarizer, persists the post. Returns { ok, existing, post,
 * summary_fallback } on success or { ok: false, error } on failure. */
export async function postRepo(repoUrl, { authorUsername } = {}) {
    try {
        const r = await fetch('/api/git-feed/post', {
            method:  'POST',
            headers: _authHeaders(),
            body:    JSON.stringify({ repoUrl, authorUsername: authorUsername || null }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            return {
                ok:            false,
                error:         j?.error   || `HTTP ${r.status}`,
                message:       j?.message || null,
                repo_owner:    j?.repo_owner    || null,
                linked_github: j?.linked_github || null,
                status:        r.status,
            };
        }
        return { ok: true, ...j };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/* Fetch the feed. Sorts: 'new' | 'top' | 'adopted'.
 * Pagination: `offset` + `limit`. Free-text search: `q` (matches name /
 * full_name / description / summary, case-insensitive, server-side ILIKE).
 * Returns posts[] (empty on error — never throws). */
export async function listPosts({ sort = 'new', limit = 50, offset = 0, language = null, topic = null, q = null } = {}) {
    try {
        const qs = new URLSearchParams({ sort, limit: String(limit) });
        if (offset)   qs.set('offset',   String(offset));
        if (language) qs.set('language', language);
        if (topic)    qs.set('topic',    topic);
        if (q)        qs.set('q',        q);
        const r = await fetch(`/api/git-feed/posts?${qs.toString()}`);
        if (!r.ok) return [];
        const j = await r.json().catch(() => ({}));
        return Array.isArray(j?.posts) ? j.posts : [];
    } catch { return []; }
}

/* Adopt a repo post. Phase 1: records the adoption row + bumps counter.
 * Phase 2 will also kick off an IDE session with the repo as context. */
export async function adoptPost(postId, { integrationNotes } = {}) {
    try {
        const r = await fetch('/api/git-feed/adopt', {
            method:  'POST',
            headers: _authHeaders(),
            body:    JSON.stringify({ postId, integrationNotes: integrationNotes || null }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
        return { ok: true, ...j };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/* Fetch a post's README as GitHub-rendered HTML (handles GFM, syntax
 * highlight, relative image URLs, emoji). Server caches per post id
 * for an hour so click-to-expand is cheap on repeat clicks. Returns
 * { ok, html, cached } or { ok: false, error }. */
export async function fetchPostReadme(postId) {
    try {
        const r = await fetch(`/api/git-feed/posts/${encodeURIComponent(postId)}/readme`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
        return { ok: true, html: j?.html || '', cached: !!j?.cached };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/* List adopted repos for the connected wallet. Returns [] when unauth. */
export async function listMyAdoptions({ limit = 50 } = {}) {
    const w = _wallet();
    if (!w) return [];
    try {
        const r = await fetch(`/api/git-feed/my-adopts?wallet=${encodeURIComponent(w)}&limit=${limit}`, {
            headers: { 'x-v3labs-wallet': w },
        });
        if (!r.ok) return [];
        const j = await r.json().catch(() => ({}));
        return Array.isArray(j?.adoptions) ? j.adoptions : [];
    } catch { return []; }
}
