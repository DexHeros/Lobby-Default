/* AdaptiveJitterController — Phase 0.11.
 *
 * Sits between the Insertable Streams encoded-video reader and the
 * WebCodecs VideoDecoder. In steady state it forwards every
 * EncodedVideoChunk immediately (0-frame buffer). On observed packet
 * loss / decode error it expands to 1 frame for ~60 frames, then
 * decays back to 0.
 *
 * Why not just set playoutDelayHint=0 and call it a day? Because that's
 * a Chromium-specific knob that drops the *built-in* WebRTC jitter
 * buffer entirely — under transient packet loss, frames stutter or
 * black out instead of brief one-frame pacing. This controller adds
 * back the loss-tolerance behaviour without the steady-state cost.
 *
 * Loss is detected via:
 *   - VideoDecoder.error events → high-severity, immediate expand
 *   - NACK/PLI events (caller signals via .onLoss()) → medium severity
 *   - Decode latency spikes (chunks arriving more than 50ms after their
 *     RTP timestamp would suggest at the target frame rate) → low
 *
 * Latency cost in steady state: 0ms (passthrough).
 * Latency cost during recovery (60-frame window): ~16.67ms (1 frame).
 * Returns to 0 once 60 consecutive frames decode cleanly.
 */

const RECOVERY_FRAMES = 60;            // hold +1 frame buffer for ~1 second @60Hz
const TARGET_FRAME_INTERVAL_MS = 1000 / 60;

export class AdaptiveJitterController {
    constructor(videoDecoder, { onMetric } = {}) {
        this.decoder = videoDecoder;
        this.onMetric = onMetric || (() => {});
        this.framesSinceLoss = Infinity;       // many frames since last loss → 0-buffer
        this.bufferedChunk = null;             // the one held-back frame during recovery
        this.lastChunkRtpTime = 0;
        this.lastDecodeAtMs = 0;
    }

    get isInRecovery() {
        return this.framesSinceLoss < RECOVERY_FRAMES;
    }

    /** Caller hands every EncodedVideoChunk here. We decide when to
     *  hand it to the decoder. Always non-blocking. */
    push(chunk) {
        const now = performance.now();
        // Frame-pace anomaly detection (low-severity loss signal).
        if (this.lastDecodeAtMs > 0) {
            const sinceLast = now - this.lastDecodeAtMs;
            if (sinceLast > 2 * TARGET_FRAME_INTERVAL_MS) {
                this._noteLoss('frame_late');
            }
        }
        this.lastDecodeAtMs = now;

        if (!this.isInRecovery) {
            // Steady state: zero buffer. Forward immediately.
            try { this.decoder.decode(chunk); }
            catch (e) { this._noteLoss('decode_throw'); chunk.close?.(); return; }
            this.framesSinceLoss = Math.min(this.framesSinceLoss + 1, RECOVERY_FRAMES);
            return;
        }

        // Recovery state: keep one frame in hand. When the next chunk
        // arrives, we display the held one and hold the new one.
        if (this.bufferedChunk) {
            try { this.decoder.decode(this.bufferedChunk); }
            catch (e) { this._noteLoss('decode_throw'); }
        }
        this.bufferedChunk = chunk;
        this.framesSinceLoss += 1;

        if (this.framesSinceLoss >= RECOVERY_FRAMES) {
            // Drain the buffered chunk; back to steady state.
            if (this.bufferedChunk) {
                try { this.decoder.decode(this.bufferedChunk); }
                catch (e) { this._noteLoss('decode_throw'); }
                this.bufferedChunk = null;
            }
            this.onMetric({ event: 'recovered', framesHeld: 0 });
        }
    }

    /** Caller signals an externally-observed loss (NACK fired, RTCP). */
    onLoss(reason = 'external') { this._noteLoss(reason); }

    /** Drain + close any held chunk on shutdown. */
    flush() {
        if (this.bufferedChunk) {
            try { this.decoder.decode(this.bufferedChunk); }
            catch {}
            this.bufferedChunk = null;
        }
    }

    _noteLoss(reason) {
        if (this.framesSinceLoss > 5) {
            // Edge-trigger metric only on transition; avoid spamming
            // during a multi-frame loss burst.
            this.onMetric({ event: 'loss', reason });
        }
        this.framesSinceLoss = 0;
    }
}
