/**
 * Cloud Gaming Session Manager
 * Handles matchmaking requests, session lifecycle, quality monitoring,
 * and player-side attestation for cloud gaming streams.
 */

const CloudSession = (() => {
    const POLL_INTERVAL_MS = 2000;
    const ATTESTATION_INTERVAL_MS = 60000; // 60s mutual attestation
    const MAX_MATCH_WAIT_MS = 120000; // 2 min max wait

    let _currentSession = null;
    let _attestationTimer = null;
    let _pollTimer = null;
    let _qualityMetrics = { fps: 0, resolution: '', bitrate: 0, latency: 0 };
    let _listeners = {};

    // ── Events ───────────────────────────────────────────────────

    function on(event, callback) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(callback);
    }

    function off(event, callback) {
        if (!_listeners[event]) return;
        _listeners[event] = _listeners[event].filter(cb => cb !== callback);
    }

    function _emit(event, data) {
        (_listeners[event] || []).forEach(cb => {
            try { cb(data); } catch (e) { console.error(`CloudSession event ${event} error:`, e); }
        });
    }

    // ── Matchmaking ──────────────────────────────────────────────

    async function requestSession(gameId, dexheroId, wallet) {
        if (_currentSession) {
            throw new Error('Active session already exists. Disconnect first.');
        }

        _emit('status', { state: 'matching', message: 'Finding a server near you...' });

        const res = await fetch('/api/matchmaker/request-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId, dexheroId, wallet })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Matchmaker unavailable' }));
            _emit('status', { state: 'error', message: err.error || 'Failed to request session' });
            throw new Error(err.error || `Matchmaker returned ${res.status}`);
        }

        const { sessionId } = await res.json();
        _currentSession = {
            sessionId,
            gameId,
            dexheroId,
            wallet,
            state: 'matching',
            startedAt: null,
            nodeInfo: null
        };

        _startMatchPolling(sessionId);
        return sessionId;
    }

    function _startMatchPolling(sessionId) {
        const startTime = Date.now();

        _pollTimer = setInterval(async () => {
            if (Date.now() - startTime > MAX_MATCH_WAIT_MS) {
                _stopPolling();
                _emit('status', { state: 'timeout', message: 'No servers available. Try again or play locally.' });
                _currentSession = null;
                return;
            }

            try {
                const res = await fetch(`/api/matchmaker/session-status/${sessionId}`);
                if (!res.ok) return;
                const data = await res.json();

                if (data.status === 'matched') {
                    _stopPolling();
                    _currentSession.state = 'connected';
                    _currentSession.nodeInfo = data.node;
                    _currentSession.startedAt = new Date();
                    _emit('status', {
                        state: 'connected',
                        message: `Connected to server in ${data.node.city || 'nearby'} (RTT: ${data.node.rtt}ms)`,
                        node: data.node,
                        sessionId
                    });
                    _startAttestations();
                } else if (data.status === 'queued') {
                    _emit('status', {
                        state: 'queued',
                        message: `Position ${data.queuePosition} in queue (~${data.estimatedWaitSec}s)`,
                        queuePosition: data.queuePosition
                    });
                } else if (data.status === 'failed') {
                    _stopPolling();
                    _emit('status', { state: 'error', message: data.reason || 'Match failed' });
                    _currentSession = null;
                }
            } catch (e) {
                console.error('Match poll error:', e);
            }
        }, POLL_INTERVAL_MS);
    }

    function _stopPolling() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    }

    // ── Session Attestation (Player Side) ────────────────────────

    function _startAttestations() {
        _attestationTimer = setInterval(async () => {
            if (!_currentSession || _currentSession.state !== 'connected') {
                _stopAttestations();
                return;
            }

            try {
                await fetch('/api/session/heartbeat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: _currentSession.sessionId,
                        reporter: 'player',
                        wallet: _currentSession.wallet,
                        fps: _qualityMetrics.fps,
                        resolution: _qualityMetrics.resolution,
                        bitrate: _qualityMetrics.bitrate,
                        rtt: _qualityMetrics.latency,
                        inputEntropy: _computeInputEntropy()
                    })
                });
            } catch (e) {
                console.error('Attestation error:', e);
            }
        }, ATTESTATION_INTERVAL_MS);
    }

    function _stopAttestations() {
        if (_attestationTimer) { clearInterval(_attestationTimer); _attestationTimer = null; }
    }

    // ── Quality Metrics ──────────────────────────────────────────

    function updateQuality(metrics) {
        Object.assign(_qualityMetrics, metrics);
        _emit('quality', { ..._qualityMetrics });
    }

    function getQuality() {
        return { ..._qualityMetrics };
    }

    // ── Input Entropy Tracking ───────────────────────────────────

    let _inputEvents = [];
    const INPUT_WINDOW_MS = 60000;

    function recordInput(type) {
        const now = Date.now();
        _inputEvents.push({ type, time: now });
        // Trim old events
        _inputEvents = _inputEvents.filter(e => now - e.time < INPUT_WINDOW_MS);
    }

    function _computeInputEntropy() {
        if (_inputEvents.length < 5) return 0;
        // Simple entropy: unique event types × event frequency
        const types = new Set(_inputEvents.map(e => e.type));
        const frequency = _inputEvents.length / (INPUT_WINDOW_MS / 1000);
        return Math.min(100, Math.round(types.size * frequency * 10));
    }

    // ── Disconnect ───────────────────────────────────────────────

    async function disconnect() {
        _stopPolling();
        _stopAttestations();

        if (_currentSession?.sessionId) {
            try {
                const duration = _currentSession.startedAt
                    ? Math.round((Date.now() - _currentSession.startedAt.getTime()) / 1000)
                    : 0;
                await fetch('/api/session/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: _currentSession.sessionId,
                        wallet: _currentSession.wallet,
                        duration,
                        finalQuality: { ..._qualityMetrics }
                    })
                });
            } catch (e) {
                console.error('Disconnect error:', e);
            }

            _emit('status', {
                state: 'ended',
                message: 'Session ended',
                duration: _currentSession.startedAt
                    ? Math.round((Date.now() - _currentSession.startedAt.getTime()) / 1000)
                    : 0,
                quality: { ..._qualityMetrics }
            });
        }

        _currentSession = null;
        _qualityMetrics = { fps: 0, resolution: '', bitrate: 0, latency: 0 };
        _inputEvents = [];
    }

    // ── Cancel Pending Match ─────────────────────────────────────

    async function cancelMatch() {
        _stopPolling();
        if (_currentSession?.sessionId && _currentSession.state === 'matching') {
            try {
                await fetch(`/api/matchmaker/cancel/${_currentSession.sessionId}`, { method: 'POST' });
            } catch { /* best effort */ }
        }
        _currentSession = null;
        _emit('status', { state: 'cancelled', message: 'Match cancelled' });
    }

    // ── Session History ──────────────────────────────────────────

    async function getHistory(wallet, limit = 50) {
        const res = await fetch(`/api/session/history?wallet=${wallet}&limit=${limit}`);
        if (!res.ok) return [];
        return res.json();
    }

    // ── Session Feedback ─────────────────────────────────────────

    async function submitFeedback(sessionId, wallet, rating, comment = '') {
        return fetch('/api/cloud/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, wallet, rating, comment })
        });
    }

    // ── Cloud Availability Check ─────────────────────────────────

    async function checkAvailability(gameId) {
        try {
            const res = await fetch(`/api/cloud/availability?gameId=${gameId}`);
            if (!res.ok) return { available: false, nodeCount: 0 };
            return res.json();
        } catch {
            return { available: false, nodeCount: 0 };
        }
    }

    // ── Public API ───────────────────────────────────────────────

    return {
        requestSession,
        disconnect,
        cancelMatch,
        updateQuality,
        getQuality,
        recordInput,
        getHistory,
        submitFeedback,
        checkAvailability,
        getSession: () => _currentSession ? { ..._currentSession } : null,
        isActive: () => _currentSession?.state === 'connected',
        on,
        off
    };
})();

window.CloudSession = CloudSession;
