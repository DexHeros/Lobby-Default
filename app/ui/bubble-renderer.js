/* Bubble renderer — turn raw LLM text into a sanitized DOM fragment.
 *
 * Phase A3: markdown, code blocks, autolinking, image/video/YouTube
 * embeds. Replaces the plain-text `.textContent = …` rendering used by
 * stage-chat.js + topic-chat-pane.js. Built without external deps —
 * every text-node value goes through textContent (never innerHTML), so
 * XSS via crafted assistant output is impossible by construction.
 *
 * Public API:
 *   renderBubble(text) → DocumentFragment
 *
 * Markdown coverage (the 90% an LLM emits):
 *   - paragraphs separated by blank lines
 *   - headers # ## ### #### ##### ######
 *   - bold **text**  italic *text*  inline code `code`
 *   - links [label](url)  + bare-URL autolink
 *   - bulleted lists (-, *) and numbered lists (1. 2.)
 *   - fenced code blocks ```lang\n…\n```
 *   - blockquotes (lines starting with >)
 *   - horizontal rules (--- on a line)
 *
 * Media detection (post-render pass):
 *   - YouTube  → strict-allowlist iframe (youtube-nocookie.com/embed/<id>)
 *   - Vimeo    → iframe (player.vimeo.com/video/<id>)
 *   - mp4/webm → <video controls>
 *   - jpg/png/gif/webp/svg → <img loading=lazy> with click-to-expand
 *
 * NEVER calls innerHTML on user-controlled text. Iframes use a strict
 * allowlist of host+pathname patterns.
 */

const MEDIA_VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const MEDIA_IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)]+/g;

/* ─── Block tokenizer ───
 * Splits text into block-level chunks. Order matters — fenced code first
 * (preserves inner content verbatim), then everything else. */
function tokenizeBlocks(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Fenced code block
        const fence = line.match(/^```\s*([a-zA-Z0-9_+-]*)\s*$/);
        if (fence) {
            const lang = fence[1] || '';
            const codeLines = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                codeLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++; // consume closing ```
            blocks.push({ kind: 'code', lang, text: codeLines.join('\n') });
            continue;
        }
        // Blank line — paragraph separator
        if (/^\s*$/.test(line)) { i++; continue; }
        // Markdown table — pipe-delimited header row + separator row +
        // 0..N data rows. Detect by checking line N has pipes and line
        // N+1 is the separator (only |, -, :, spaces). Common in LLM
        // research output (Gemini's snapshot tables, ChatGPT summaries).
        if (i + 1 < lines.length
            && /^\s*\|.+\|\s*$/.test(line)
            && /^\s*\|[-:|\s]+\|\s*$/.test(lines[i + 1])) {
            const splitCells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
            const header = splitCells(line);
            const sepCells = splitCells(lines[i + 1]);
            const aligns = sepCells.map((s) => {
                if (/^:.*:$/.test(s)) return 'center';
                if (/:$/.test(s))     return 'right';
                if (/^:/.test(s))     return 'left';
                return null;
            });
            i += 2;
            const rows = [];
            while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
                rows.push(splitCells(lines[i]));
                i++;
            }
            blocks.push({ kind: 'table', header, aligns, rows });
            continue;
        }
        // Header
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            blocks.push({ kind: 'header', level: h[1].length, text: h[2] });
            i++;
            continue;
        }
        // Horizontal rule
        if (/^\s*-{3,}\s*$/.test(line)) {
            blocks.push({ kind: 'hr' });
            i++;
            continue;
        }
        // Blockquote
        if (/^>\s?/.test(line)) {
            const quoteLines = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quoteLines.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }
            blocks.push({ kind: 'quote', text: quoteLines.join('\n') });
            continue;
        }
        // List (bulleted or numbered)
        if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
            const ordered = /^\s*\d+[.)]\s+/.test(line);
            const items = [];
            while (i < lines.length) {
                const m = lines[i].match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
                if (!m) break;
                // Continuation lines (indented) join the same item
                let item = m[1];
                i++;
                while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
                    item += ' ' + lines[i].trim();
                    i++;
                }
                items.push(item);
            }
            blocks.push({ kind: 'list', ordered, items });
            continue;
        }
        // Paragraph (collect until blank line or block break)
        const paraLines = [];
        while (i < lines.length && !/^\s*$/.test(lines[i])
               && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
               && !/^>\s?/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])
               && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*-{3,}\s*$/.test(lines[i])) {
            paraLines.push(lines[i]);
            i++;
        }
        if (paraLines.length) {
            blocks.push({ kind: 'para', text: paraLines.join('\n') });
        }
    }
    return blocks;
}

/* ─── Inline tokenizer ───
 * Recognizes **bold**, *italic*, `code`, [label](url), and bare URLs.
 * Returns an array of {kind, ...} tokens the DOM builder consumes. */
function tokenizeInline(text) {
    const tokens = [];
    const src = String(text || '');
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        // Inline code `…`
        if (ch === '`') {
            const end = src.indexOf('`', i + 1);
            if (end > i) {
                tokens.push({ kind: 'code', text: src.slice(i + 1, end) });
                i = end + 1;
                continue;
            }
        }
        // Bold **…**
        if (ch === '*' && src[i + 1] === '*') {
            const end = src.indexOf('**', i + 2);
            if (end > i + 1) {
                tokens.push({ kind: 'bold', children: tokenizeInline(src.slice(i + 2, end)) });
                i = end + 2;
                continue;
            }
        }
        // Italic *…* (must not be **, handled above)
        if (ch === '*') {
            const end = src.indexOf('*', i + 1);
            if (end > i && src[end + 1] !== '*') {
                tokens.push({ kind: 'italic', children: tokenizeInline(src.slice(i + 1, end)) });
                i = end + 1;
                continue;
            }
        }
        // Link [label](url) — with a recovery path for the common LLM
        // failure mode where the model writes `[label](http://foo...` and
        // never closes the paren (truncated URL, mid-stream cutoff, or
        // the URL spans into the next markdown block). Without recovery
        // the broken text renders as literal "[label](http://..." which
        // looks awful. We extract the URL up to the next whitespace /
        // newline / closing punctuation and render a clean link.
        if (ch === '[') {
            const close = src.indexOf(']', i + 1);
            if (close > i && src[close + 1] === '(') {
                const urlEnd = src.indexOf(')', close + 2);
                if (urlEnd > close + 1) {
                    const label = src.slice(i + 1, close);
                    const url = src.slice(close + 2, urlEnd).trim();
                    if (/^https?:\/\//i.test(url) || url.startsWith('/') || url.startsWith('#')) {
                        tokens.push({ kind: 'link', href: url, children: tokenizeInline(label) });
                        i = urlEnd + 1;
                        continue;
                    }
                } else {
                    // Recovery: no closing paren. Take everything up to
                    // the next whitespace/newline as the URL.
                    const tail = src.slice(close + 2);
                    const stop = tail.search(/[\s\n)]/);
                    const urlPart = stop === -1 ? tail : tail.slice(0, stop);
                    if (/^https?:\/\//i.test(urlPart) && urlPart.length > 10) {
                        const label = src.slice(i + 1, close);
                        tokens.push({ kind: 'link', href: urlPart, children: tokenizeInline(label) });
                        i = close + 2 + urlPart.length;
                        continue;
                    }
                }
            }
        }
        // Bare URL autolink
        URL_RE.lastIndex = i;
        const m = URL_RE.exec(src);
        if (m && m.index === i) {
            // Strip trailing punctuation that's clearly not part of the URL
            let url = m[0];
            let trail = '';
            while (/[.,;:!?)\]]$/.test(url)) {
                trail = url.slice(-1) + trail;
                url = url.slice(0, -1);
            }
            tokens.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }], autolink: true });
            i = m.index + url.length;
            if (trail) tokens.push({ kind: 'text', text: trail });
            i += trail.length;
            continue;
        }
        // Default: text run — grab up to the next special char
        let j = i + 1;
        while (j < src.length) {
            const c = src[j];
            if (c === '`' || c === '*' || c === '[') break;
            // Detect URL boundary
            if (c === 'h' && (src.slice(j, j + 7) === 'http://' || src.slice(j, j + 8) === 'https://')) break;
            j++;
        }
        tokens.push({ kind: 'text', text: src.slice(i, j) });
        i = j;
    }
    return tokens;
}

/* ─── Media detection ───
 * Map a URL to a media descriptor, or null if it's a plain link. */
function detectMedia(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    // YouTube
    if (host === 'youtube.com' || host === 'm.youtube.com') {
        if (path === '/watch') {
            const id = u.searchParams.get('v');
            if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
                return { kind: 'youtube', id };
            }
        }
        if (path.startsWith('/embed/')) {
            const id = path.slice(7);
            if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { kind: 'youtube', id };
        }
    }
    if (host === 'youtu.be') {
        const id = path.slice(1);
        if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { kind: 'youtube', id };
    }
    // Vimeo
    if (host === 'vimeo.com') {
        const id = path.slice(1).split('/')[0];
        if (/^\d+$/.test(id)) return { kind: 'vimeo', id };
    }
    // Direct video
    if (MEDIA_VIDEO_EXT.test(path)) return { kind: 'video', src: url };
    // Direct image
    if (MEDIA_IMAGE_EXT.test(path)) return { kind: 'image', src: url };
    return null;
}

/* ─── DOM builders ─── */
function buildInline(tokens, parent) {
    for (const t of tokens) {
        if (t.kind === 'text') {
            parent.appendChild(document.createTextNode(t.text));
        } else if (t.kind === 'code') {
            const el = document.createElement('code');
            el.className = 'bubble-md__code-inline';
            el.textContent = t.text;
            parent.appendChild(el);
        } else if (t.kind === 'bold') {
            const el = document.createElement('strong');
            buildInline(t.children, el);
            parent.appendChild(el);
        } else if (t.kind === 'italic') {
            const el = document.createElement('em');
            buildInline(t.children, el);
            parent.appendChild(el);
        } else if (t.kind === 'link') {
            const a = document.createElement('a');
            a.className = 'bubble-md__link';
            a.href = t.href;
            // Open external links in new tab; same-origin (#/foo) stay in-app.
            if (/^https?:\/\//i.test(t.href)) {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
            }
            buildInline(t.children, a);
            parent.appendChild(a);
        }
    }
}

function buildMedia(media, parent) {
    if (media.kind === 'youtube') {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-md__embed bubble-md__embed--video';
        const iframe = document.createElement('iframe');
        // Strict allowlist host. The ID was already regex-validated above.
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(media.id)}`;
        iframe.title = 'YouTube video';
        iframe.allow = 'accelerometer; encrypted-media; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        wrap.appendChild(iframe);
        parent.appendChild(wrap);
    } else if (media.kind === 'vimeo') {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-md__embed bubble-md__embed--video';
        const iframe = document.createElement('iframe');
        iframe.src = `https://player.vimeo.com/video/${encodeURIComponent(media.id)}`;
        iframe.title = 'Vimeo video';
        iframe.allow = 'autoplay; fullscreen; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        wrap.appendChild(iframe);
        parent.appendChild(wrap);
    } else if (media.kind === 'video') {
        const v = document.createElement('video');
        v.className = 'bubble-md__embed bubble-md__embed--video';
        v.src = media.src;
        v.controls = true;
        v.preload = 'metadata';
        parent.appendChild(v);
    } else if (media.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'bubble-md__embed bubble-md__embed--image';
        img.src = media.src;
        img.loading = 'lazy';
        img.alt = '';
        img.addEventListener('click', () => {
            // Click-to-expand: open the image in a new tab.
            try { window.open(media.src, '_blank', 'noopener,noreferrer'); } catch {}
        });
        parent.appendChild(img);
    }
}

/** Build a DocumentFragment from a parsed block. */
function buildBlock(block, frag) {
    if (block.kind === 'para') {
        const p = document.createElement('p');
        p.className = 'bubble-md__p';
        const inline = tokenizeInline(block.text);
        buildInline(inline, p);
        frag.appendChild(p);
        // Media follow-on: any standalone URL link in the paragraph that
        // resolves to media becomes an embed below the text. We don't
        // replace the link; we render BOTH (text mention + embed) so the
        // user can still click through if the embed fails to load.
        for (const t of inline) {
            if (t.kind === 'link' && t.autolink) {
                const media = detectMedia(t.href);
                if (media) buildMedia(media, frag);
            }
        }
    } else if (block.kind === 'header') {
        const h = document.createElement('h' + Math.min(6, Math.max(1, block.level)));
        h.className = 'bubble-md__h';
        buildInline(tokenizeInline(block.text), h);
        frag.appendChild(h);
    } else if (block.kind === 'code') {
        // VS Code / Cursor / Claude Code aesthetic: top bar with the
        // language pill on the left and a Copy button on the right,
        // then the monospace block underneath. Skipping syntax highlight
        // for now — Shiki/highlight.js add 40-600KB.
        const wrap = document.createElement('div');
        wrap.className = 'bubble-md__code-wrap';
        const bar = document.createElement('div');
        bar.className = 'bubble-md__code-bar';
        const lang = document.createElement('span');
        lang.className = 'bubble-md__code-lang';
        lang.textContent = block.lang || 'text';
        bar.appendChild(lang);
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'bubble-md__code-copy';
        copy.textContent = 'Copy';
        copy.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try {
                navigator.clipboard.writeText(block.text);
                copy.textContent = 'Copied';
                setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
            } catch {
                copy.textContent = 'Copy failed';
                setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
            }
        });
        bar.appendChild(copy);
        wrap.appendChild(bar);
        const pre = document.createElement('pre');
        pre.className = 'bubble-md__pre';
        const code = document.createElement('code');
        code.className = 'bubble-md__code-block';
        if (block.lang) code.classList.add('language-' + block.lang);
        code.textContent = block.text;
        pre.appendChild(code);
        wrap.appendChild(pre);
        frag.appendChild(wrap);
    } else if (block.kind === 'list') {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        list.className = 'bubble-md__list';
        for (const item of block.items) {
            const li = document.createElement('li');
            li.className = 'bubble-md__li';
            buildInline(tokenizeInline(item), li);
            list.appendChild(li);
        }
        frag.appendChild(list);
    } else if (block.kind === 'quote') {
        const q = document.createElement('blockquote');
        q.className = 'bubble-md__quote';
        const blocks = tokenizeBlocks(block.text);
        for (const b of blocks) buildBlock(b, q);
        frag.appendChild(q);
    } else if (block.kind === 'hr') {
        const hr = document.createElement('hr');
        hr.className = 'bubble-md__hr';
        frag.appendChild(hr);
    } else if (block.kind === 'table') {
        const table = document.createElement('table');
        table.className = 'bubble-md__table';
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        block.header.forEach((cell, idx) => {
            const th = document.createElement('th');
            if (block.aligns[idx]) th.style.textAlign = block.aligns[idx];
            buildInline(tokenizeInline(cell), th);
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const row of block.rows) {
            const tr = document.createElement('tr');
            row.forEach((cell, idx) => {
                const td = document.createElement('td');
                if (block.aligns[idx]) td.style.textAlign = block.aligns[idx];
                buildInline(tokenizeInline(cell), td);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        frag.appendChild(table);
    }
}

/** Render markdown-flavored text into a sanitized DocumentFragment.
 *  Every text value is set via textContent or createTextNode — XSS via
 *  crafted assistant output is impossible by construction. */
export function renderBubble(text) {
    const frag = document.createDocumentFragment();
    if (text == null || text === '') return frag;
    const blocks = tokenizeBlocks(text);
    for (const b of blocks) buildBlock(b, frag);
    return frag;
}

/** Convenience: replace the contents of `el` with the rendered text. */
export function renderInto(el, text) {
    if (!el) return;
    el.textContent = '';
    el.appendChild(renderBubble(text));
}
