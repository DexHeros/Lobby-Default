/* Brain-tool registry — single source of truth for the V3Labs platform.
 *
 * Every brain framework (JarJar, MCP server, native function-calling on
 * OpenAI/Anthropic/Gemini, LangChain, WS bridges) consumes its tool
 * definitions FROM HERE rather than defining its own. When the patch
 * shape evolves, this file is the only place that changes — V3Labs
 * server-side validation reads the same schema the brain was told to
 * emit, so there is no drift between "what the brain produces" and
 * "what the platform accepts."
 *
 * The actual definitions live in `brain-tools.json` so they're also
 * consumable from non-JS contexts (Rust agent in JarJar, Python MCP
 * server, the Node server-side validator, future tooling). This module
 * just re-exports them for ergonomic JS client use.
 *
 * Versioning: every tool carries `manifest_version`. Bump it whenever
 * a breaking change to the patch shape lands — Stage A fallbacks fill
 * missing fields so older brain outputs still validate at the lower
 * version. Forward compatibility is intentional.
 *
 * Public HTTP endpoint: `GET /api/brain-tools` returns the JSON
 * verbatim, so a brain hosted on any platform can pin or fetch the
 * schema at startup. */

/* Catalog loader — works in both browser and Node without requiring
 * the newer `import ... with { type: 'json' }` syntax (Node 22+ only).
 * In the browser this lazy-fetches /api/brain-tools or the static JSON
 * via the dev server. In Node it reads the file from disk. Returns a
 * frozen snapshot. */
let _catalog = null;
let _catalogPromise = null;

async function _loadCatalog() {
    if (_catalog) return _catalog;
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = (async () => {
        let raw;
        if (typeof window !== 'undefined') {
            // Browser: prefer the static file from the same origin so the
            // catalog is fetchable without depending on the API endpoint
            // being deployed.
            const res = await fetch(new URL('./brain-tools.json', import.meta.url));
            if (!res.ok) throw new Error('brain-tools.json load failed: ' + res.status);
            raw = await res.json();
        } else {
            // Node: read from disk relative to this module.
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const here = path.dirname(new URL(import.meta.url).pathname);
            const txt = await fs.readFile(path.join(here, 'brain-tools.json'), 'utf8');
            raw = JSON.parse(txt);
        }
        _catalog = Object.freeze({
            schema_version: raw.schema_version,
            tools: Object.freeze(raw.tools.slice()),
            byName: Object.freeze(raw.tools.reduce((a, t) => { a[t.name] = t; return a; }, {})),
        });
        return _catalog;
    })();
    return _catalogPromise;
}

/** Returns the full catalog snapshot (await once at startup, then cache). */
export async function getBrainCatalog() {
    return await _loadCatalog();
}

/** Returns a single tool by name, or null. */
export async function getBrainTool(name) {
    const cat = await _loadCatalog();
    return cat.byName[name] || null;
}

/** Returns the ordered list of tools (preserves source order). */
export async function getBrainToolList() {
    const cat = await _loadCatalog();
    return cat.tools;
}

/** Catalog schema version. */
export async function getBrainToolsVersion() {
    const cat = await _loadCatalog();
    return cat.schema_version;
}
