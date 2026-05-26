/* V3Labs Supabase service — thin wrapper over window.DexHeroSupabase.
   Lazy-initializes; returns null until the supabase-js CDN has finished loading. */

export function get() {
    if (typeof window.DexHeroSupabase === 'object' && window.DexHeroSupabase) {
        const client = window.DexHeroSupabase.get();
        if (client) return client;
    }
    return null;
}

export async function ready({ timeoutMs = 5000 } = {}) {
    if (get()) return get();
    if (window.DexHeroSupabase?.init) window.DexHeroSupabase.init();

    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            const c = get();
            if (c) return resolve(c);
            if (Date.now() > deadline) return reject(new Error('Supabase not ready within timeout'));
            if (window.DexHeroSupabase?.init) window.DexHeroSupabase.init();
            setTimeout(tick, 120);
        };
        tick();
    });
}

/** Convenience wrapper around a single-table select. */
export async function select(table, columns = '*', matcher) {
    const s = await ready();
    let q = s.from(table).select(columns);
    if (matcher) {
        for (const [k, v] of Object.entries(matcher)) q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data;
}
