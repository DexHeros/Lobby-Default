/* DexHeroPlayer — record-class browser cloud-gaming client.
 *
 * Phase 0.3 / 0.4 / 0.5 / 0.7 / 0.11 / 0.12 architecture:
 *
 *   Browser side (this file):
 *     1. Open WebSocket to host (signaling channel only).
 *     2. WS receives WebRTC offer SDP from the streamer subprocess
 *        on the host. We answer.
 *     3. RTCPeerConnection bootstraps:
 *          - iceServers from connectInfo.iceServers (STUN only)
 *          - playoutDelayHint = 0 on the receiving track (drop default
 *            jitter buffer, AdaptiveJitterController handles loss recovery)
 *          - Insertable Streams to extract EncodedVideoChunk from RTP
 *            without ever going through MediaSource (saves ~100ms MSE buffer)
 *          - Separate RTCDataChannel { ordered: false, maxRetransmits: 0 }
 *            for input — keeps input independent of video HoL blocking
 *     4. EncodedVideoChunks → AdaptiveJitterController → VideoDecoder
 *     5. VideoDecoder.output → drawn to canvas via requestVideoFrameCallback;
 *        canvas.captureStream() bound to videoEl.srcObject
 *     6. Input events captured locally, predicted by InputPredictor,
 *        forwarded as binary control frames over the input DataChannel
 *     7. Per-frame motion-to-photon measurement + POST to
 *        /api/session/latency for SLO tracking
 *
 *   Host side (separate — node-agent.js spawns moonlight-web-stream's
 *   `streamer` Rust binary, bridges its IPC to the WebSocket).
 *
 * Browser pinning: this code uses Insertable Streams + rVFC +
 * playoutDelayHint, all best-supported on Chromium (Chrome 105+,
 * Edge 105+). Safari + Firefox fall through to soft-degraded paths
 * with documented latency cost.
 */

import { AdaptiveJitterController } from './jitter-controller.js';
import { InputPredictor, profileFor } from './input-prediction.js';

const SUPPORTS_INSERTABLE_STREAMS = typeof RTCRtpReceiver !== 'undefined'
    && typeof RTCRtpReceiver.prototype.createEncodedStreams === 'function';
const SUPPORTS_RVFC = typeof HTMLVideoElement !== 'undefined'
    && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';

/** Browser detection for Phase 0.4 banner. Caller renders the banner. */
export function browserCapabilityReport() {
    const ua = navigator.userAgent || '';
    const isChromium = /Chrome|Chromium|Edg/i.test(ua) && !/OPR/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua);
    return {
        isChromium, isFirefox, isSafari,
        insertableStreams: SUPPORTS_INSERTABLE_STREAMS,
        requestVideoFrameCallback: SUPPORTS_RVFC,
        webCodecs: typeof VideoDecoder !== 'undefined',
        recommended: isChromium && SUPPORTS_INSERTABLE_STREAMS && SUPPORTS_RVFC && typeof VideoDecoder !== 'undefined',
    };
}

export class DexHeroPlayer {
    /**
     * @param {object} opts
     * @param {HTMLVideoElement} opts.videoEl
     * @param {string} opts.wsUrl                — signaling channel
     * @param {string} opts.token                — pairing token (subprotocol)
     * @param {string} opts.sessionId            — session id (for latency telemetry)
     * @param {object} [opts.latencyHints]       — connectInfo.latencyHints
     * @param {RTCIceServer[]} [opts.iceServers] — connectInfo.iceServers (STUN-only)
     * @param {string[]} [opts.preferredCodecs]  — host-ranked codec preferences
     * @param {string|number} [opts.gameKey]     — for input-prediction profile lookup
     * @param {(s:object)=>void} [opts.onStats]
     * @param {(state:string)=>void} [opts.onStateChange]
     * @param {(err:Error)=>void} [opts.onError]
     * @param {(msg:string)=>void} [opts.onHint] — non-fatal UX hints
     *                                            (e.g. pointer-lock denied).
     * @param {object} [opts.attestor]    — P1.3 SessionAttestor handle. When
     *                                      present, the player runs a 60s
     *                                      attestation tick: capture metrics,
     *                                      sign with the ephemeral key, POST
     *                                      to /api/session/attestation.
     */
    constructor(opts) {
        this.videoEl = opts.videoEl;
        this.wsUrl = opts.wsUrl;
        this.token = opts.token;
        this.sessionId = opts.sessionId || null;
        this.latencyHints = opts.latencyHints || {};
        this.iceServers = opts.iceServers && opts.iceServers.length
            ? opts.iceServers
            : [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
        this.preferredCodecs = opts.preferredCodecs || ['h264'];
        this.gameKey = opts.gameKey || null;
        this.onStats = opts.onStats || (() => {});
        this.onStateChange = opts.onStateChange || (() => {});
        this.onError = opts.onError || (() => {});
        this.onHint = opts.onHint || (() => {});
        this.attestor = opts.attestor || null;

        this.ws = null;
        this.pc = null;
        this.inputChannel = null;
        this.decoder = null;
        this.jitter = null;
        this.predictor = null;
        this.canvas = null;
        this.canvasCtx = null;
        this.state = 'idle';

        this._statsTimer = null;
        this._latencyPostTimer = null;
        this._statsCounters = { frames: 0, dropped: 0, bytes: 0, lastSampleTs: 0 };
        this._inputSeq = 0;
        this._lastInputAtMs = new Map();   // seq → performance.now()
        this._lastFrameAtMs = 0;
        this._lastDecodeLatencyMs = 0;
        this._reconnectAttempts = 0;

        // P1.3 attestation tick state. Reset every 60s when the tick fires.
        // _frameTotal is a NON-resetting cumulative frame count (the existing
        // _statsCounters.frames is zeroed every 500ms by the stats loop, so
        // we can't use it for window-delta math).
        this._frameTotal = 0;
        this._attestTimer = null;
        this._attestCount = 0;
        this._attestWindow = {
            startedAt:     0,
            framesAtStart: 0,                // _frameTotal sample at window-open
            inputCounts:   Object.create(null), // histogram by event kind for Shannon entropy
            inputTotal:    0,
        };
    }

    _setState(s) {
        this.state = s;
        try { this.onStateChange(s); } catch {}
    }

    async start() {
        this._setState('connecting');

        if (typeof VideoDecoder === 'undefined') {
            this._setState('error');
            this.onError(new Error('Browser missing WebCodecs support — use Chrome 105+ or Edge 105+'));
            return;
        }

        // ── 1. Video output sink. ──
        // Phase 0 latency win: prefer MediaStreamTrackGenerator (Chrome 94+,
        // Edge 94+). Decoded VideoFrames go DIRECTLY into the video
        // element's MediaStream via a WritableStream — bypassing the
        // canvas + captureStream roundtrip (which costs ~5ms via the
        // browser's video processing pipeline). Falls back to the canvas
        // path on browsers without MSTG support (Firefox, older versions).
        this._useMSTG = (typeof MediaStreamTrackGenerator !== 'undefined');
        if (this._useMSTG) {
            this._mstg = new MediaStreamTrackGenerator({ kind: 'video' });
            this._mstgWriter = this._mstg.writable.getWriter();
            const ms = new MediaStream([this._mstg]);
            this.videoEl.srcObject = ms;
        } else {
            // Fallback canvas + captureStream path. Works everywhere
            // WebCodecs does, but adds ~5ms of compositor overhead.
            this.canvas = document.createElement('canvas');
            this.canvas.width = this.latencyHints.targetWidth || 1920;
            this.canvas.height = this.latencyHints.targetHeight || 1080;
            this.canvasCtx = this.canvas.getContext('2d');
            const captureStream = this.canvas.captureStream(this.latencyHints.targetFps || 60);
            this.videoEl.srcObject = captureStream;
        }
        this.videoEl.play().catch(() => {});

        // ── 2. WebCodecs.VideoDecoder. ──
        const codecCfg = await this._selectCodec();
        if (!codecCfg) {
            this._setState('error');
            this.onError(new Error('No supported codec from preferredCodecs list'));
            return;
        }
        this.decoder = new VideoDecoder({
            output: (frame) => this._onDecodedFrame(frame),
            error: (e) => {
                console.error('[player] VideoDecoder error:', e);
                this._statsCounters.dropped += 1;
                this.jitter?.onLoss('decoder_error');
            },
        });
        this.decoder.configure(codecCfg);

        // ── 3. AdaptiveJitterController + InputPredictor. ──
        this.jitter = new AdaptiveJitterController(this.decoder, {
            onMetric: (m) => { /* hook for SLO ingest later */ },
        });

        const profile = profileFor(this.gameKey);
        this.predictor = new InputPredictor({
            videoEl: this.videoEl,
            profile,
            smoothingMs: 50,
        });

        // ── 4. Open signaling WebSocket + WebRTC peer connection. ──
        try {
            await this._openSignalingWs();
            await this._openPeerConnection();
        } catch (e) {
            this._setState('error');
            this.onError(e);
            return;
        }

        this._setState('streaming');
        this._attachInputCapture();
        this._startStatsLoop();
    }

    stop() {
        this._setState('closing');
        if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
        if (this._latencyPostTimer) { clearInterval(this._latencyPostTimer); this._latencyPostTimer = null; }
        if (this._attestTimer) { clearInterval(this._attestTimer); this._attestTimer = null; }
        if (this._gamepadTimer) { clearInterval(this._gamepadTimer); this._gamepadTimer = null; }
        if (this._onPointerLockErr) { try { document.removeEventListener('pointerlockerror', this._onPointerLockErr); } catch {} this._onPointerLockErr = null; }
        try { this.predictor?.destroy(); } catch {}
        try { this.inputChannel?.close(); } catch {}
        try { this.pc?.close(); } catch {}
        try { this.ws?.close(1000, 'client-stop'); } catch {}
        try { this.jitter?.flush(); } catch {}
        try { this.decoder?.close(); } catch {}
        try { this._mstgWriter?.close(); } catch {}
        try { this.videoEl.srcObject = null; } catch {}
        try { if (this._audioEl) { this._audioEl.srcObject = null; this._audioEl.remove(); } } catch {}
        this.ws = null;
        this.pc = null;
        this.inputChannel = null;
        this.decoder = null;
        this.jitter = null;
        this.predictor = null;
        this._mstg = null;
        this._mstgWriter = null;
        this._audioEl = null;
    }

    // ── Signaling WS + WebRTC bootstrap ─────────────────────────────

    _openSignalingWs() {
        return new Promise((resolve, reject) => {
            const proto = `dexhero-token.${(this.token || '').replace(/^0x/, '')}`;
            this.ws = new WebSocket(this.wsUrl, [proto]);
            this.ws.binaryType = 'arraybuffer';
            const timer = setTimeout(() => reject(new Error('signaling WS timeout')), 10_000);
            this.ws.onopen = () => { clearTimeout(timer); resolve(); };
            this.ws.onmessage = (ev) => this._handleSignalingMessage(ev.data);
            this.ws.onerror = (e) => { clearTimeout(timer); reject(e); };
            this.ws.onclose = (ev) => {
                if (this.state === 'streaming' && ev.code !== 1000) {
                    this.onError(new Error(`signaling WS closed: ${ev.code} ${ev.reason || ''}`));
                }
            };
        });
    }

    async _openPeerConnection() {
        // Phase 0.7 — direct-only ICE policy. STUN candidates only;
        // any TURN/relay candidates the streamer offers are ignored.
        // Translation: iceTransportPolicy='all' but we omit TURN from
        // iceServers; the peer still uses host + srflx candidates.
        this.pc = new RTCPeerConnection({
            iceServers: this.iceServers,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
        });

        // Receive-only video. The track event fires once the streamer
        // sends its offer + we answer.
        this.pc.addTransceiver('video', { direction: 'recvonly' });
        this.pc.addTransceiver('audio', { direction: 'recvonly' });

        // Input DataChannel — separate from video, unordered + no retransmits.
        // We CREATE it here so it's in the SDP we answer with. Streamer
        // negotiates the same channel ID on its side. ordered:false +
        // maxRetransmits:0 = unreliable, low-latency UDP-like semantics.
        this.inputChannel = this.pc.createDataChannel('dexhero-input', {
            ordered: false,
            maxRetransmits: 0,
            negotiated: true,
            id: 1,
        });
        this.inputChannel.onopen = () => console.log('[player] input DC open');
        this.inputChannel.onclose = () => console.log('[player] input DC closed');
        this.inputChannel.onmessage = (ev) => this._handleInputDcMessage(ev.data);

        this.pc.ontrack = (ev) => this._onTrack(ev);
        this.pc.onicecandidate = (ev) => {
            if (ev.candidate) this._sendSignaling({ type: 'candidate', candidate: ev.candidate });
        };
        this.pc.oniceconnectionstatechange = () => {
            const s = this.pc.iceConnectionState;
            if (s === 'failed' || s === 'disconnected') {
                this.onError(new Error(`ICE state: ${s}`));
            }
        };
    }

    async _handleSignalingMessage(data) {
        let msg;
        if (data instanceof ArrayBuffer) {
            try { msg = JSON.parse(new TextDecoder().decode(data)); }
            catch { return; }
        } else {
            try { msg = JSON.parse(data); }
            catch { return; }
        }
        if (!msg || !msg.type) return;

        switch (msg.type) {
            case 'offer': {
                if (!this.pc) return;
                await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
                const answer = await this.pc.createAnswer();
                // Prefer codecs in the order the host advertised.
                if (this.preferredCodecs?.length) {
                    answer.sdp = _reorderCodecs(answer.sdp, this.preferredCodecs);
                }
                await this.pc.setLocalDescription(answer);
                this._sendSignaling({ type: 'answer', sdp: answer.sdp });
                break;
            }
            case 'candidate': {
                if (msg.candidate) {
                    try { await this.pc.addIceCandidate(msg.candidate); }
                    catch (e) { console.warn('[player] addIceCandidate:', e.message); }
                }
                break;
            }
            case 'error':
                this.onError(new Error(msg.message || 'signaling error'));
                break;
            default:
                /* unknown signaling — ignore */
        }
    }

    _sendSignaling(obj) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    // ── Track → Insertable Streams → VideoDecoder ───────────────────

    _onTrack(ev) {
        const receiver = ev.receiver;
        const track = ev.track;

        // Audio path — Phase 0 functional completeness. Streamer routes
        // game audio over a WebRTC audio track; we attach it to a
        // hidden <audio> element so the user actually hears the game.
        // playoutDelayHint=0 on the audio receiver too — no need for
        // OPUS resync buffer in steady state. (Phase 1.2 audio
        // concealment tunes the loss-recovery side; this is just
        // get-the-bits-to-the-speakers.)
        if (track.kind === 'audio') {
            try { receiver.playoutDelayHint = 0; } catch {}
            if (!this._audioEl) {
                this._audioEl = document.createElement('audio');
                this._audioEl.style.display = 'none';
                this._audioEl.autoplay = true;
                document.body.appendChild(this._audioEl);
            }
            this._audioEl.srcObject = new MediaStream([track]);
            this._audioEl.play().catch(() => {
                // Autoplay blocked until user gesture — should be fine
                // since user clicked Play to get here, but document the
                // failure so we surface it via Sentry if persistent.
                console.warn('[player] audio autoplay blocked; click anywhere to enable');
            });
            return;
        }

        if (track.kind !== 'video') return;

        // Phase 0.3 — playoutDelayHint=0 on the RTP receiver. This is
        // the Chromium knob that drops the default WebRTC jitter
        // buffer. Safari/Firefox ignore it (they fall through to
        // their default jitter buffer; latency penalty documented).
        try { receiver.playoutDelayHint = 0; } catch {}

        if (!SUPPORTS_INSERTABLE_STREAMS) {
            console.warn('[player] Insertable Streams unsupported — falling back to MediaStream path with extra ~100ms latency');
            // Soft-degrade: hand the track to videoEl directly. Lossy
            // for latency, but functional.
            const ms = new MediaStream([track]);
            this.videoEl.srcObject = ms;
            this.videoEl.play().catch(() => {});
            return;
        }

        // Phase 0.3 — Insertable Streams. Read EncodedVideoChunks
        // straight off the RTP receiver and feed them to our
        // AdaptiveJitterController → VideoDecoder. No MediaSource,
        // no MediaStream pipeline — saves ~100ms of MSE buffering.
        const { readable } = receiver.createEncodedStreams();
        const reader = readable.getReader();
        (async () => {
            while (true) {
                let { value: chunk, done } = await reader.read();
                if (done) break;
                if (!chunk) continue;
                this._statsCounters.bytes += chunk.data?.byteLength || 0;
                // Re-package as EncodedVideoChunk for the decoder.
                const evc = new EncodedVideoChunk({
                    type:      chunk.type === 'key' ? 'key' : 'delta',
                    timestamp: chunk.timestamp,
                    duration:  chunk.duration || undefined,
                    data:      chunk.data,
                });
                this.jitter.push(evc);
            }
        })().catch((e) => console.warn('[player] insertable-stream reader:', e?.message));
    }

    _onDecodedFrame(frame) {
        this._statsCounters.frames += 1;
        this._frameTotal += 1;             // P1.3 — cumulative; never reset
        this._lastFrameAtMs = performance.now();
        if (this._useMSTG && this._mstgWriter) {
            // Direct path: VideoFrame → MediaStreamTrackGenerator. The
            // writer takes ownership of the frame; no manual close
            // needed. Saves ~5ms vs. canvas+captureStream.
            try {
                this._mstgWriter.write(frame);
            } catch (e) {
                this._statsCounters.dropped += 1;
                try { frame.close(); } catch {}
            }
            return;
        }
        // Fallback canvas path — phase-locked draw-to-canvas inside
        // the decoder output callback.
        try {
            this.canvasCtx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        } catch (e) {
            this._statsCounters.dropped += 1;
        } finally {
            try { frame.close(); } catch {}
        }
    }

    // ── Input capture → DataChannel ─────────────────────────────────

    _attachInputCapture() {
        const sendInput = (kind, payload) => {
            if (!this.inputChannel || this.inputChannel.readyState !== 'open') return;
            const seq = ++this._inputSeq;
            const evt = { kind, seq, t: performance.now(), ...payload };
            this._lastInputAtMs.set(seq, evt.t);
            // P1.3 — tally event kind for Shannon-entropy + per-minute counter.
            try {
                this._attestWindow.inputCounts[kind] = (this._attestWindow.inputCounts[kind] || 0) + 1;
                this._attestWindow.inputTotal++;
            } catch { /* attestor not active or window not initialized */ }
            try { this.inputChannel.send(JSON.stringify(evt)); }
            catch { /* DC send failure → drop */ }
            // Trim the seq map so it doesn't grow unbounded.
            if (this._lastInputAtMs.size > 256) {
                const oldestKey = this._lastInputAtMs.keys().next().value;
                this._lastInputAtMs.delete(oldestKey);
            }
        };

        // Keyboard.
        this._kbDown = (e) => {
            if (e.key === 'Escape') return;        // reserve for disconnect
            e.preventDefault();
            sendInput('kb', { code: e.code, down: 1, mods: _modBits(e) });
        };
        this._kbUp = (e) => {
            if (e.key === 'Escape') return;
            e.preventDefault();
            sendInput('kb', { code: e.code, down: 0, mods: _modBits(e) });
        };
        window.addEventListener('keydown', this._kbDown);
        window.addEventListener('keyup', this._kbUp);

        // Mouse — relative deltas via Pointer Lock when available.
        this._mouseMove = (e) => {
            const dx = e.movementX != null ? e.movementX : 0;
            const dy = e.movementY != null ? e.movementY : 0;
            if (dx === 0 && dy === 0) return;
            this.predictor?.onMouseMove(dx, dy);   // local prediction overlay
            sendInput('mm', { dx, dy });
        };
        this._mouseDown = (e) => sendInput('mb', { btn: _mouseBtn(e), down: 1 });
        this._mouseUp = (e) => sendInput('mb', { btn: _mouseBtn(e), down: 0 });
        this._mouseWheel = (e) => sendInput('mw', { dy: e.deltaY });
        this.videoEl.addEventListener('mousemove', this._mouseMove);
        this.videoEl.addEventListener('mousedown', this._mouseDown);
        this.videoEl.addEventListener('mouseup', this._mouseUp);
        this.videoEl.addEventListener('wheel', this._mouseWheel, { passive: true });

        // Click → request pointer lock for relative-delta capture.
        // Chrome 112+ returns a Promise; older browsers return undefined.
        // Either way we want to surface the failure — silent fallback to
        // absolute-mouse mode makes FPS aim feel broken with no
        // explanation.
        this._clickToLock = () => {
            if (document.pointerLockElement === this.videoEl) return;
            const result = this.videoEl.requestPointerLock?.();
            if (result && typeof result.catch === 'function') {
                result.catch((err) => {
                    console.warn('[player] pointer-lock denied:', err?.message || err);
                    this.onHint?.('Pointer lock unavailable — try fullscreen (F) for full mouse sensitivity.');
                });
            }
        };
        this.videoEl.addEventListener('click', this._clickToLock);
        // Some browsers fire pointerlockerror on the document instead of
        // rejecting the Promise. Catch both so the user always gets a
        // hint.
        this._onPointerLockErr = () => {
            console.warn('[player] pointerlockerror — falling back to absolute mouse');
            this.onHint?.('Pointer lock unavailable — try fullscreen (F) for full mouse sensitivity.');
        };
        document.addEventListener('pointerlockerror', this._onPointerLockErr);

        // Gamepad polling (60Hz).
        this._gamepadTimer = setInterval(() => {
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            for (const p of pads) {
                if (!p || !p.connected) continue;
                const buttons = p.buttons.reduce((m, b, i) => m | ((b.pressed ? 1 : 0) << i), 0) | 0;
                const ax = (a) => Math.max(-32768, Math.min(32767, Math.round((a || 0) * 32767)));
                const trig = (b) => Math.max(0, Math.min(255, Math.round((b?.value || 0) * 255)));
                sendInput('gp', {
                    idx: p.index,
                    buttons,
                    lx: ax(p.axes[0]), ly: ax(p.axes[1]),
                    rx: ax(p.axes[2]), ry: ax(p.axes[3]),
                    lt: trig(p.buttons[6]), rt: trig(p.buttons[7]),
                });
            }
        }, 16);
    }

    /** Inbound input DC traffic = host echo with timing + (optionally)
     *  cursor reconcile data for the prediction overlay. */
    _handleInputDcMessage(data) {
        let msg;
        if (typeof data === 'string') {
            try { msg = JSON.parse(data); } catch { return; }
        } else if (data instanceof ArrayBuffer) {
            try { msg = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
        } else return;
        if (!msg || !msg.kind) return;

        if (msg.kind === 'echo' && typeof msg.seq === 'number') {
            // Compute round-trip; the host echoes seqs + a server-time
            // we use to estimate motion-to-photon at the next frame.
            const sentAt = this._lastInputAtMs.get(msg.seq);
            if (sentAt) {
                const networkMs = (performance.now() - sentAt);
                this._lastDecodeLatencyMs = networkMs;   // rough proxy
            }
        } else if (msg.kind === 'reconcile' && msg.x != null) {
            this.predictor?.reconcile(msg.x, msg.y);
        }
    }

    // ── Stats + latency SLO upload ──────────────────────────────────

    _startStatsLoop() {
        this._statsCounters.lastSampleTs = performance.now();
        this._statsTimer = setInterval(() => {
            const now = performance.now();
            const dt = Math.max(1, now - this._statsCounters.lastSampleTs);
            const fps = Math.round((this._statsCounters.frames * 1000) / dt);
            const bitrateKbps = Math.round((this._statsCounters.bytes * 8) / dt);
            const dropped = this._statsCounters.dropped;
            this._statsCounters = { frames: 0, dropped: 0, bytes: 0, lastSampleTs: now };
            try {
                this.onStats({
                    fps:     fps || null,
                    bitrate: bitrateKbps || null,
                    dropped,
                    rtt:     Math.round(this._lastDecodeLatencyMs) || null,
                });
            } catch {}
        }, 500);

        // Phase 0.9 — POST motion-to-photon samples to /api/session/latency.
        // Every 5 seconds, batch the most recent measurements.
        this._latencyPostTimer = setInterval(async () => {
            if (!this.sessionId || !this._lastDecodeLatencyMs) return;
            try {
                await fetch('/api/session/latency', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: this.sessionId,
                        m2pMs:     Math.round(this._lastDecodeLatencyMs),
                    }),
                });
            } catch { /* best-effort */ }
        }, 5_000);

        // P1.3 — per-minute attestation tick. Only runs when an attestor was
        // injected via opts.attestor (i.e. the panel ran startSession + got
        // the one-shot delegation popup confirmed by the player).
        if (this.attestor) {
            this._beginAttestWindow();
            this._attestTimer = setInterval(() => this._tickAttestation(), 60_000);
        }
    }

    /** Re-arm the attestation window. Called at start and after each tick. */
    _beginAttestWindow() {
        this._attestWindow = {
            startedAt:     performance.now(),
            framesAtStart: this._frameTotal,
            inputCounts:   Object.create(null),
            inputTotal:    0,
        };
    }

    /** Pull rttMs from the active RTCPeerConnection.getStats(). Returns 0 if
     *  unavailable so the digest still encodes a deterministic uint256. */
    async _captureRttMs() {
        if (!this.pc || typeof this.pc.getStats !== 'function') return 0;
        try {
            const report = await this.pc.getStats();
            let rttSec = null;
            report.forEach((s) => {
                // candidate-pair stats are the canonical source; remote-inbound-rtp
                // is a fallback.
                if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') {
                    rttSec = s.currentRoundTripTime;
                }
            });
            if (rttSec == null) {
                report.forEach((s) => {
                    if (s.type === 'remote-inbound-rtp' && typeof s.roundTripTime === 'number') {
                        rttSec = s.roundTripTime;
                    }
                });
            }
            return rttSec != null ? Math.round(rttSec * 1000) : 0;
        } catch { return 0; }
    }

    /** 60s attestation tick — sign with the ephemeral key and POST. */
    async _tickAttestation() {
        if (!this.attestor || !this.sessionId) return;
        const win = this._attestWindow;
        const elapsedSec = Math.max(1, (performance.now() - win.startedAt) / 1000);
        // fps over the window. Player.js doesn't expose VideoDecoder.outputCount
        // directly (it's a Chromium-only field); we use the existing
        // _statsCounters.frames running counter instead, which is incremented
        // in _onDecodedFrame for every successful VideoDecoder output. Same
        // signal, more portable.
        const framesDelta = Math.max(0, this._frameTotal - win.framesAtStart);
        const fps = Math.round(framesDelta / elapsedSec);

        const rttMs = await this._captureRttMs();

        // Lazy-import to keep player.js loadable in environments where
        // session-attestor isn't present (panel teardown, cold path).
        let inputEntropyScore = 0;
        try {
            const mod = await import('../services/session-attestor.js');
            inputEntropyScore = mod.shannonEntropyScore(win.inputCounts);
        } catch { /* fall through with 0 */ }

        // inputEventsPerMin = events captured this 60s window, scaled to /min.
        const inputEventsPerMin = Math.round((win.inputTotal * 60) / elapsedSec);

        const count = this._attestCount++;
        try {
            const attestation = await this.attestor.signAttestation(
                { fps, rttMs, inputEntropyScore, inputEventsPerMin },
                count,
            );
            await fetch('/api/session/attestation', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    sessionId:        this.sessionId,
                    side:             'player',
                    attestationCount: String(count),
                    attestation,
                }),
            }).catch(() => { /* server may not be ready yet — best-effort */ });
        } catch (e) {
            console.warn('[player] attestation tick failed:', e?.message || e);
        } finally {
            this._beginAttestWindow();
        }
    }

    // ── Codec selection ─────────────────────────────────────────────

    async _selectCodec() {
        const PROFILES = {
            h264:  'avc1.42E01E',
            avc1:  'avc1.42E01E',
            hevc:  'hev1.1.6.L93.B0',
            h265:  'hev1.1.6.L93.B0',
            av1:   'av01.0.05M.08',
            av01:  'av01.0.05M.08',
        };
        for (const raw of this.preferredCodecs) {
            const c = (raw || '').toLowerCase();
            const codec = PROFILES[c] || raw;
            try {
                const support = await VideoDecoder.isConfigSupported({ codec });
                if (support?.supported) {
                    return { codec, hardwareAcceleration: 'prefer-hardware' };
                }
            } catch { /* try next */ }
        }
        return null;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

function _modBits(e) {
    return (e.ctrlKey  ? 1 : 0)
         | (e.shiftKey ? 2 : 0)
         | (e.altKey   ? 4 : 0)
         | (e.metaKey  ? 8 : 0);
}
function _mouseBtn(e) {
    if (e.button === 0) return 1;   // left
    if (e.button === 1) return 2;   // middle
    if (e.button === 2) return 3;   // right
    return 0;
}

/** Best-effort SDP rewrite to put the preferred codecs first in the
 *  m=video line. Non-strict: if anything looks unexpected, return SDP
 *  unchanged and let the streamer's default ordering apply. */
function _reorderCodecs(sdp, preferredCodecs) {
    if (typeof sdp !== 'string') return sdp;
    const lines = sdp.split(/\r?\n/);
    const mIdx = lines.findIndex((l) => l.startsWith('m=video '));
    if (mIdx < 0) return sdp;
    // Map: codec name (lowercase) → list of payload type IDs.
    const ptByCodec = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)/);
        if (m) {
            const pt = m[1];
            const name = m[2].toLowerCase();
            if (!ptByCodec.has(name)) ptByCodec.set(name, []);
            ptByCodec.get(name).push(pt);
        }
    }
    const parts = lines[mIdx].split(' ');
    if (parts.length < 4) return sdp;
    const head = parts.slice(0, 3);                 // m=video <port> UDP/TLS/RTP/SAVPF
    const allPts = parts.slice(3);
    const preferred = [];
    for (const raw of preferredCodecs) {
        const c = (raw || '').toLowerCase();
        const aliases = c === 'h264' ? ['h264'] : c === 'hevc' || c === 'h265' ? ['h265', 'hevc'] : c === 'av1' ? ['av1'] : [c];
        for (const alias of aliases) {
            const pts = ptByCodec.get(alias);
            if (pts) for (const pt of pts) if (!preferred.includes(pt)) preferred.push(pt);
        }
    }
    if (preferred.length === 0) return sdp;
    const remainder = allPts.filter((pt) => !preferred.includes(pt));
    lines[mIdx] = [...head, ...preferred, ...remainder].join(' ');
    return lines.join('\r\n');
}

export default DexHeroPlayer;
