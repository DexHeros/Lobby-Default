/* dexhero-voice.js — JarJar's mouth.
 *
 * Web Speech API (`SpeechSynthesis`) wrapper that gives the DexHero an
 * audible voice. Universal in modern browsers, free, uses the OS's
 * installed voices (Daniel/Oliver on macOS, Microsoft Ryan on Windows,
 * eSpeak on Linux, native Android/iOS voices on mobile).
 *
 * Each voice "profile" picks an OS voice by name + language pattern
 * and applies rate/pitch shaping to land a recognizable character:
 *
 *   jarvis            British butler — slow, measured, low pitch.
 *                     Prefers Daniel (Mac) / Ryan / Hazel UK (Win).
 *   warm-mentor       Warm female. Prefers Samantha / Allison / Karen.
 *   terse-engineer    Crisp male, slightly faster.
 *   playful-companion Bright, faster, higher pitch.
 *   formal-assistant  Neutral, business-like.
 *   rebel-poet        Slightly faster, irregular pitch.
 *   calm-stoic        Very slow, low pitch.
 *
 * Live signals dispatched on the document during a spoken utterance:
 *
 *   dexhero:voice-start     { text, voice }    — about to speak
 *   dexhero:voice-end       { text }           — finished or cancelled
 *   dexhero:voice-boundary  { charIndex, len } — every word boundary
 *
 * The body driver picks these up to drive talk_bob amplitude (visible
 * lip-sync) and to know when to stop the talking gestures.
 *
 * Mute state is per-device (localStorage). Default: unmuted. */

const MUTE_KEY = 'dexhero:voice-muted';

const DEFAULT_PROFILE = {
    prefer: [
        { name: /^.+/, lang: /^en/i },
    ],
    rate: 1.0,
    pitch: 1.0,
};

export const VOICE_PROFILES = {
    'jarvis': {
        prefer: [
            { name: /^Daniel/i,       lang: /^en-GB/i },
            { name: /^Oliver/i,       lang: /^en-GB/i },
            { name: /^Arthur/i,       lang: /^en-GB/i },
            { name: /Ryan|Thomas|James|George/i, lang: /^en-GB/i },
            { name: /Microsoft\s+(Ryan|George|Thomas|Hazel)/i, lang: /^en-GB/i },
            { name: /^.+/, lang: /^en-GB/i },
            { name: /^.+/, lang: /^en/i },
        ],
        rate: 0.92,
        pitch: 0.85,
    },
    'warm-mentor': {
        prefer: [
            { name: /^Samantha/i, lang: /^en/i },
            { name: /^Allison/i,  lang: /^en/i },
            { name: /^Susan/i,    lang: /^en/i },
            { name: /^Karen/i,    lang: /^en/i },
            { name: /^Ava/i,      lang: /^en/i },
            { name: /^.+/,        lang: /^en-US/i },
            { name: /^.+/,        lang: /^en/i },
        ],
        rate: 0.96,
        pitch: 1.03,
    },
    'terse-engineer': {
        prefer: [
            { name: /^Daniel/i,    lang: /^en-GB/i },
            { name: /^Aaron/i,     lang: /^en/i },
            { name: /^Reed/i,      lang: /^en-US/i },
            { name: /^.+/,         lang: /^en/i },
        ],
        rate: 1.08,
        pitch: 1.0,
    },
    'playful-companion': {
        prefer: [
            { name: /^Karen/i,     lang: /^en-AU/i },
            { name: /^Moira/i,     lang: /^en-IE/i },
            { name: /^Tessa/i,     lang: /^en-ZA/i },
            { name: /^Samantha/i,  lang: /^en/i },
            { name: /^.+/,         lang: /^en/i },
        ],
        rate: 1.05,
        pitch: 1.15,
    },
    'formal-assistant': {
        prefer: [
            { name: /^Oliver/i,    lang: /^en-GB/i },
            { name: /^Daniel/i,    lang: /^en-GB/i },
            { name: /^.+/,         lang: /^en-GB/i },
            { name: /^.+/,         lang: /^en/i },
        ],
        rate: 0.98,
        pitch: 0.96,
    },
    'rebel-poet': {
        prefer: [
            { name: /^Arthur/i,    lang: /^en-GB/i },
            { name: /^Bruce/i,     lang: /^en/i },
            { name: /^Fred/i,      lang: /^en/i },
            { name: /^.+/,         lang: /^en/i },
        ],
        rate: 1.06,
        pitch: 0.92,
    },
    'calm-stoic': {
        prefer: [
            { name: /^Tom/i,       lang: /^en/i },
            { name: /^Alex/i,      lang: /^en/i },
            { name: /^Daniel/i,    lang: /^en-GB/i },
            { name: /^.+/,         lang: /^en/i },
        ],
        rate: 0.88,
        pitch: 0.90,
    },
};

let _muted = false;
try { _muted = localStorage.getItem(MUTE_KEY) === 'true'; } catch {}

let _voicesReady = false;
let _voices = [];
let _activeUtterance = null;

function refreshVoices() {
    if (typeof speechSynthesis === 'undefined') return;
    _voices = speechSynthesis.getVoices() || [];
    _voicesReady = _voices.length > 0;
}

if (typeof speechSynthesis !== 'undefined') {
    refreshVoices();
    if ('onvoiceschanged' in speechSynthesis) {
        speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    }
}

/** Resolve a voice preset id to the best OS voice available, falling
 *  back through the preset's prefer list. Returns null when no voice
 *  is installed (e.g., a stripped Linux). */
export function pickVoice(presetId) {
    if (!_voicesReady) refreshVoices();
    if (!_voices.length) return null;
    const profile = VOICE_PROFILES[presetId] || DEFAULT_PROFILE;
    for (const matcher of profile.prefer) {
        const found = _voices.find((v) =>
            (!matcher.name || matcher.name.test(v.name)) &&
            (!matcher.lang || matcher.lang.test(v.lang))
        );
        if (found) return found;
    }
    return _voices.find((v) => /^en/i.test(v.lang)) || _voices[0] || null;
}

export function getVoiceProfile(presetId) {
    return VOICE_PROFILES[presetId] || DEFAULT_PROFILE;
}

export function getAvailableVoices() {
    if (!_voicesReady) refreshVoices();
    return _voices.slice();
}

export function isMuted() { return _muted; }

export function setMuted(yes) {
    const next = !!yes;
    if (next === _muted) return;
    _muted = next;
    try { localStorage.setItem(MUTE_KEY, String(_muted)); } catch {}
    if (_muted) cancel();
    document.dispatchEvent(new CustomEvent('dexhero:voice-muted-changed', {
        bubbles: true,
        detail: { muted: _muted },
    }));
}

export function toggleMuted() {
    setMuted(!_muted);
    return _muted;
}

export function cancel() {
    _activeUtterance = null;
    if (typeof speechSynthesis !== 'undefined') {
        try { speechSynthesis.cancel(); } catch {}
    }
    document.dispatchEvent(new CustomEvent('dexhero:voice-end', { bubbles: true, detail: {} }));
}

/** Strip markdown noise that doesn't translate well to TTS (bullets,
 *  asterisks, backticks). Preserve sentence structure + punctuation
 *  so the synth's natural pauses still land. */
function cleanForSpeech(text) {
    return String(text || '')
        .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')      // inline code
        .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
        .replace(/__([^_]+)__/g, '$1')              // bold alt
        .replace(/\*([^*]+)\*/g, '$1')              // italic
        .replace(/_([^_]+)_/g, '$1')                // italic alt
        .replace(/^\s*[-*•]\s+/gm, '')              // bullets
        .replace(/^\s*\d+[\.\)]\s+/gm, '')          // numbered lists
        .replace(/^\s*\[\d+\]\s+/gm, '')            // bracketed
        .replace(/\s+/g, ' ')
        .trim();
}

/** Speak the given text using the named preset's voice profile.
 *  No-op if muted, no SpeechSynthesis support, or empty text. Cancels
 *  any in-flight utterance first so a new reply replaces an old one. */
export function speak(text, presetId, opts = {}) {
    if (_muted) return false;
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return false;

    // Cancel any in-flight utterance (fires our voice-end first).
    if (_activeUtterance) { try { speechSynthesis.cancel(); } catch {} }

    const profile = getVoiceProfile(presetId);
    const voice = pickVoice(presetId);
    const u = new SpeechSynthesisUtterance(cleaned);
    if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
    }
    u.rate   = Number(opts.rate   ?? profile.rate  ?? 1);
    u.pitch  = Number(opts.pitch  ?? profile.pitch ?? 1);
    u.volume = Number(opts.volume ?? 1);

    const len = cleaned.length;
    u.onstart = () => {
        document.dispatchEvent(new CustomEvent('dexhero:voice-start', {
            bubbles: true,
            detail: { text: cleaned, voiceName: voice?.name || '', presetId, len },
        }));
    };
    u.onend = () => {
        if (_activeUtterance === u) _activeUtterance = null;
        document.dispatchEvent(new CustomEvent('dexhero:voice-end', {
            bubbles: true,
            detail: { text: cleaned, len },
        }));
    };
    u.onerror = (ev) => {
        if (_activeUtterance === u) _activeUtterance = null;
        document.dispatchEvent(new CustomEvent('dexhero:voice-end', {
            bubbles: true,
            detail: { text: cleaned, len, error: ev?.error || 'unknown' },
        }));
    };
    u.onboundary = (ev) => {
        document.dispatchEvent(new CustomEvent('dexhero:voice-boundary', {
            bubbles: true,
            detail: { charIndex: ev.charIndex || 0, len, name: ev.name || '' },
        }));
    };

    _activeUtterance = u;
    try {
        speechSynthesis.speak(u);
        return true;
    } catch (err) {
        console.warn('[dexhero-voice] speak failed', err);
        _activeUtterance = null;
        return false;
    }
}

/** Best-effort detection that SpeechSynthesis is actually available. */
export function isSupported() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

/* ─── Per-hero preset cache (localStorage) ───
 * Lets stage-chat speak with the right voice profile without re-deriving
 * from the server brain config on every message. voice-editor.js writes
 * here whenever the user picks a preset; speak() falls back to 'jarvis'
 * when nothing is cached so Truffle has a recognizable voice on first
 * page load with zero setup. */
const PRESET_CACHE_PREFIX = 'dexhero:voice-preset:';
export const DEFAULT_PRESET_ID = 'jarvis';

export function getCachedPresetId(tokenId) {
    if (!tokenId) return DEFAULT_PRESET_ID;
    try {
        const id = localStorage.getItem(PRESET_CACHE_PREFIX + tokenId);
        if (id && VOICE_PROFILES[id]) return id;
    } catch {}
    return DEFAULT_PRESET_ID;
}

export function setCachedPresetId(tokenId, presetId) {
    if (!tokenId || !presetId) return;
    try { localStorage.setItem(PRESET_CACHE_PREFIX + tokenId, presetId); } catch {}
}
