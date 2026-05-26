// ─── Supabase Realtime — session status subscription ────────────────────
// Replaces the previous polling pattern on /api/matchmaker/session-status.
// Players (and node orchestrators) subscribe to their session_id row in
// streaming_sessions and receive push notifications on status changes.
//
// Prerequisites:
//   1. Supabase Realtime enabled on the streaming_sessions table:
//      ALTER PUBLICATION supabase_realtime ADD TABLE streaming_sessions;
//   2. RLS policy allows the subscriber to SELECT their own row (already done
//      by supabase-migration-rls-hardening.sql — participant reads).
//
// Usage (browser):
//   import { subscribeToSession, unsubscribeFromSession } from '/js/blockchain/session-realtime.js';
//   const channel = subscribeToSession(sessionId, (row) => {
//       console.log('Session status:', row.status, 'node:', row.node_wallet);
//       if (row.status === 'streaming') startStream(row);
//   });
//   // Later: unsubscribeFromSession(channel);

const REALTIME_URL = window.SUPABASE_URL || '';  // set by your bootstrap/config
const REALTIME_KEY = window.SUPABASE_ANON_KEY || '';

let _client = null;

async function _getClient() {
    if (_client) return _client;
    if (!REALTIME_URL || !REALTIME_KEY) {
        throw new Error('[Realtime] SUPABASE_URL / SUPABASE_ANON_KEY must be set on window before loading this module.');
    }
    // Lazy-import the supabase-js client from CDN so we don't bloat the entry bundle.
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    _client = mod.createClient(REALTIME_URL, REALTIME_KEY, {
        realtime: { params: { eventsPerSecond: 10 } },
    });
    return _client;
}

/**
 * Subscribe to status changes for a specific session. Callback fires on every
 * UPDATE that touches the row. Returns the channel so caller can unsubscribe.
 */
export async function subscribeToSession(sessionId, onChange) {
    const supabase = await _getClient();
    const channel = supabase
        .channel(`session:${sessionId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'streaming_sessions',
                filter: `session_id=eq.${sessionId}`,
            },
            (payload) => {
                try { onChange(payload.new); }
                catch (err) { console.error('[Realtime] session-status handler threw:', err); }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`[Realtime] Subscribed to session ${sessionId}`);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn(`[Realtime] Subscription issue (${status}) for session ${sessionId} — client may need to fall back to polling`);
            }
        });
    return channel;
}

export async function unsubscribeFromSession(channel) {
    if (!channel) return;
    try { await channel.unsubscribe(); } catch (_) { /* best effort */ }
}

/**
 * Subscribe to a player's or node's session list — fires on any session
 * insert/update where they're a participant. Useful for dashboards.
 */
export async function subscribeToWalletSessions(wallet, onChange) {
    const supabase = await _getClient();
    const channel = supabase
        .channel(`wallet-sessions:${wallet}`)
        .on('postgres_changes', {
            event: '*', schema: 'public', table: 'streaming_sessions',
            filter: `player_wallet=eq.${wallet.toLowerCase()}`,
        }, p => onChange(p.new || p.old))
        .on('postgres_changes', {
            event: '*', schema: 'public', table: 'streaming_sessions',
            filter: `node_wallet=eq.${wallet.toLowerCase()}`,
        }, p => onChange(p.new || p.old))
        .subscribe();
    return channel;
}
