/* dexhero-sound.js — music loop + SFX playback for the Sound slot.
 *
 * Music: a single looping HTMLAudioElement. setActiveMusic(preset)
 *   swaps the src and crossfades volume to a chill background level.
 *   Music persists per-token via localStorage so the user's choice
 *   restores on next visit.
 *
 * SFX: short oneshot synthesized via the Web Audio API — no asset
 *   files needed for the MVP. playSfx() is also called by stage-chat
 *   right before TTS speaks, so the equipped SFX is the DexHero's
 *   signature chirp / Pokémon-cry.
 *
 * Synthesis-only audio means zero asset weight, predictable cost,
 * and the creator marketplace can later list both real audio files
 * AND parametric SFX (just a small JSON of frequencies + envelope).
 */

const MUSIC_STORAGE_PREFIX = 'dexhero:music:';
const SFX_STORAGE_PREFIX   = 'dexhero:sfx:';

let _audioCtx = null;
let _musicEl = null;       // HTMLAudioElement for music loop
let _musicGain = null;     // GainNode for fade in/out
let _activeMusicId = null;
let _activeSfxId   = null;

function audioCtx() {
    if (_audioCtx) return _audioCtx;
    try {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
    return _audioCtx;
}

/* ── Music ─────────────────────────────────────────────────────── */

/** Music source slots — one per mainstream music app. Each preset
 *  carries the brand's media-kit identity (name, color, glyph,
 *  catalog tagline, scale stat) so the music-tab cards read as
 *  real-app shelves, not generic placeholders. Click to set as
 *  active source; real OAuth + playback hands off via authUrl
 *  in a follow-up. */
const SVG = {
    spotify: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.5 17.3a.75.75 0 0 1-1 .25c-2.8-1.7-6.3-2-10.4-1.1a.75.75 0 0 1-.3-1.5c4.5-1 8.4-.6 11.5 1.3.4.2.5.7.2 1Zm1.5-3.3a.94.94 0 0 1-1.3.3c-3.2-2-8.1-2.5-11.9-1.4a.94.94 0 1 1-.5-1.8c4.3-1.3 9.7-.7 13.4 1.6.4.3.5.9.3 1.3Zm.1-3.4c-3.8-2.3-10.2-2.5-13.9-1.4a1.12 1.12 0 1 1-.6-2.2c4.2-1.3 11.3-1 15.7 1.6a1.12 1.12 0 0 1-1.2 1.9Z"/></svg>',
    apple:   '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.5 4.7c-1 .1-2.1.7-2.8 1.5-.6.7-1.1 1.8-.9 2.8 1 .1 2.1-.5 2.8-1.3.6-.7 1.1-1.8.9-3Zm3.4 13.4c-.5 1.2-.8 1.7-1.5 2.8-1 1.5-2.4 3.4-4.1 3.4-1.6 0-2-1-4.1-1-2.2 0-2.7 1-4.2 1-1.7 0-3-1.7-4-3.2C0 17.5-.5 12.6 1.5 9.8c1.4-1.9 3.6-3 5.6-3 2.1 0 3.4 1.1 5.2 1.1 1.7 0 2.7-1.1 5.2-1.1 1.9 0 3.9 1 5.2 2.7-4.6 2.5-3.8 9 .2 8.6Z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="#fff"/></svg>',
    pandora: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 2h11a5 5 0 0 1 5 5v3a5 5 0 0 1-5 5H9v7H4V2Zm5 4v5h5a1.5 1.5 0 0 0 1.5-1.5v-2A1.5 1.5 0 0 0 14 6H9Z"/></svg>',
    soundcloud: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 14v4h2v-4H2Zm3-2v6h2v-6H5Zm3-2v8h2v-8H8Zm3-1v9h2v-9h-2Zm3 2v7h6a4 4 0 0 0 1-7.9V12a4 4 0 0 0-7-2v8"/></svg>',
    tidal:   '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6l4 4-4 4-4-4 4-4Zm8 0l4 4-4 4-4-4 4-4Zm8 0l4 4-4 4-4-4 4-4Zm-8 8l4 4-4 4-4-4 4-4Z"/></svg>',
    amazon:  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 16.5c4.8 3.5 11.2 3.7 16 .4.5-.3.9.3.5.8-1.6 1.9-4.5 3.3-7.8 3.3-3.6 0-6.9-1.4-9.2-3.7-.2-.2 0-.7.5-.8Zm17.6.7c-.4-.5-2.4-.2-3.3-.1-.3 0-.3-.2 0-.4 1.6-1.1 4.2-.8 4.5-.4.3.4-.1 3-1.6 4.3-.2.2-.5.1-.4-.2.4-.9 1.2-2.7.8-3.2ZM11 4.5c2.2 0 4 1.1 4 3.4v5c0 .9.3 1.5.8 2 .1.1.1.3 0 .4l-1.6 1.4c-.2.1-.4.1-.5 0-.7-.6-.9-1-1.2-1.6-.9 1-1.7 1.5-3.4 1.5-2 0-3.6-1.3-3.6-3.7 0-2 1.1-3.3 2.6-3.9 1.3-.6 3.1-.7 4.5-.9V7.5c0-.7-.4-1.6-1.7-1.6-1.1 0-2 .6-2.2 1.7-.1.2-.2.4-.4.4l-2-.2c-.2 0-.4-.2-.3-.5C6.4 5.5 8.7 4.5 11 4.5Zm-.4 6.4c-1 .5-1.6 1.3-1.6 2.5 0 1 .5 1.7 1.5 1.7.8 0 1.4-.5 1.7-1.1.5-.9.4-1.7.4-3-.7.1-1.4.1-2 .2v-.3Z"/></svg>',
    deezer:  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="14" width="4" height="3"/><rect x="7" y="11" width="4" height="6"/><rect x="12" y="8" width="4" height="9"/><rect x="17" y="5" width="4" height="12"/></svg>',
    mute:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
};

export const MUSIC_PRESETS = [
    { id: 'spotify',    name: 'Spotify',       tagline: 'Music for everyone',     stat: '615M+ listeners',    brand: '#1db954', glyph: SVG.spotify,    authUrl: null },
    { id: 'apple',      name: 'Apple Music',   tagline: 'Spatial audio · radio',  stat: '100M+ songs',        brand: '#fa243c', glyph: SVG.apple,      authUrl: null },
    { id: 'youtube',    name: 'YouTube Music', tagline: 'Mixes for your mood',    stat: '80M+ subscribers',   brand: '#ff0000', glyph: SVG.youtube,    authUrl: null },
    { id: 'pandora',    name: 'Pandora',       tagline: 'Stations from a song',   stat: '50M+ stations',      brand: '#00a0e3', glyph: SVG.pandora,    authUrl: null },
    { id: 'soundcloud', name: 'SoundCloud',    tagline: 'Hear what\'s next',      stat: '320M+ tracks',       brand: '#ff5500', glyph: SVG.soundcloud, authUrl: null },
    { id: 'tidal',      name: 'Tidal',         tagline: 'HiFi lossless audio',    stat: 'Master quality',     brand: '#00ffe6', glyph: SVG.tidal,      authUrl: null },
    { id: 'amazon',     name: 'Amazon Music',  tagline: 'Library · ad-free',      stat: '100M+ songs · HD',   brand: '#00a8e1', glyph: SVG.amazon,     authUrl: null },
    { id: 'deezer',     name: 'Deezer',        tagline: 'Flow · your sound',      stat: '120M+ tracks',       brand: '#ef5466', glyph: SVG.deezer,     authUrl: null },
    { id: 'mute',       name: 'Mute',          tagline: 'Quiet stage',            stat: 'No background music',brand: '#94a3b8', glyph: SVG.mute,       authUrl: null, _mute: true },
];

function tokenKey(tokenId) { return tokenId ? String(tokenId) : null; }

function readActiveMusic(tokenId) {
    const k = tokenKey(tokenId);
    if (!k) return null;
    try { return localStorage.getItem(MUSIC_STORAGE_PREFIX + k); } catch { return null; }
}
function persistActiveMusic(tokenId, id) {
    const k = tokenKey(tokenId);
    if (!k) return;
    try { localStorage.setItem(MUSIC_STORAGE_PREFIX + k, id || ''); } catch {}
}

export function getActiveMusicId(tokenId) {
    return _activeMusicId || readActiveMusic(tokenId);
}

function ensureMusicEl() {
    if (_musicEl) return _musicEl;
    const ctx = audioCtx();
    _musicEl = new Audio();
    _musicEl.loop = true;
    _musicEl.crossOrigin = 'anonymous';
    _musicEl.preload = 'auto';
    if (ctx) {
        try {
            const source = ctx.createMediaElementSource(_musicEl);
            _musicGain = ctx.createGain();
            _musicGain.gain.value = 0;
            source.connect(_musicGain).connect(ctx.destination);
        } catch (err) {
            console.warn('[sound] failed to wire music to ctx', err?.message);
        }
    }
    return _musicEl;
}

/** Crossfade volume to target over ms. Called on activate/stop. */
function fadeMusic(target, ms = 400) {
    if (!_musicGain) return;
    const ctx = audioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    _musicGain.gain.cancelScheduledValues(now);
    _musicGain.gain.setValueAtTime(_musicGain.gain.value, now);
    _musicGain.gain.linearRampToValueAtTime(target, now + ms / 1000);
}

export function setActiveMusic(tokenId, presetId) {
    const preset = MUSIC_PRESETS.find((p) => p.id === presetId);
    if (!preset) return false;
    _activeMusicId = preset.id;
    persistActiveMusic(tokenId, preset.id);
    if (preset._mute || !preset.url) {
        stopMusic();
        return true;
    }
    const el = ensureMusicEl();
    try { audioCtx()?.resume(); } catch {}
    if (el.src !== preset.url) {
        el.src = preset.url;
        el.load();
    }
    el.play().catch(() => {});
    fadeMusic(0.18, 600);
    return true;
}

export function stopMusic() {
    if (!_musicEl) return;
    fadeMusic(0, 300);
    setTimeout(() => { try { _musicEl?.pause(); } catch {} }, 320);
}

/* ── SFX (Web Audio synthesis — zero assets) ───────────────────── */

/** SFX presets. Each is a tiny synthesis recipe: oscillator type,
 *  start + end frequency (sweep), duration, and amplitude. The point
 *  is one-shot character noises (chirp, blip, hum) without any audio
 *  files in the repo. */
export const SFX_PRESETS = [
    { id: 'chirp',  name: 'Chirp',   tagline: 'Bright · quick rise',   type: 'sine',     f0:  680, f1: 1100, dur: 0.14, amp: 0.22 },
    { id: 'blip',   name: 'Blip',    tagline: 'Pokédex · 8-bit',       type: 'square',   f0:  520, f1:  840, dur: 0.12, amp: 0.18 },
    { id: 'pop',    name: 'Pop',     tagline: 'Soft mouth-pop',        type: 'sine',     f0:  260, f1:  120, dur: 0.10, amp: 0.30 },
    { id: 'hum',    name: 'Hum',     tagline: 'Robot acknowledge',     type: 'sawtooth', f0:  220, f1:  220, dur: 0.22, amp: 0.16 },
    { id: 'sparkle',name: 'Sparkle', tagline: 'Magical · arpeggio',    type: 'triangle', f0:  880, f1: 1760, dur: 0.20, amp: 0.18 },
    { id: 'silent', name: 'Silent',  tagline: 'No speak-chirp',        type: 'sine',     f0:    0, f1:    0, dur: 0,    amp: 0    },
];

function readActiveSfx(tokenId) {
    const k = tokenKey(tokenId);
    if (!k) return null;
    try { return localStorage.getItem(SFX_STORAGE_PREFIX + k); } catch { return null; }
}
function persistActiveSfx(tokenId, id) {
    const k = tokenKey(tokenId);
    if (!k) return;
    try { localStorage.setItem(SFX_STORAGE_PREFIX + k, id || ''); } catch {}
}

export function getActiveSfxId(tokenId) {
    return _activeSfxId || readActiveSfx(tokenId);
}

export function setActiveSfx(tokenId, presetId) {
    const preset = SFX_PRESETS.find((p) => p.id === presetId);
    if (!preset) return false;
    _activeSfxId = preset.id;
    persistActiveSfx(tokenId, preset.id);
    return true;
}

/** Play a preset by id — when called with no id, plays the active
 *  SFX for the given token. Used by stage-chat right before TTS so
 *  the DexHero's "voice cry" announces every reply. */
export function playSfx(idOrToken, maybeTokenId) {
    // Two call shapes: playSfx(presetId) → preview by id;
    //                  playSfx(null, tokenId) → play active for token.
    let preset = null;
    if (idOrToken && typeof idOrToken === 'string' && SFX_PRESETS.some((p) => p.id === idOrToken)) {
        preset = SFX_PRESETS.find((p) => p.id === idOrToken);
    } else if (maybeTokenId) {
        const active = getActiveSfxId(maybeTokenId);
        preset = SFX_PRESETS.find((p) => p.id === active);
    }
    if (!preset || !preset.dur) return;
    const ctx = audioCtx();
    if (!ctx) return;
    try { ctx.resume(); } catch {}
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = preset.type;
    osc.frequency.setValueAtTime(preset.f0, now);
    if (preset.f1 !== preset.f0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, preset.f1), now + preset.dur);
    }
    // ADSR-ish envelope so SFX don't click on/off.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(preset.amp, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + preset.dur + 0.05);
}

/** Restore the active music + sfx on hero change. Called by the
 *  stage when STAGE_SUBJECT fires. */
export function applySoundFor(tokenId) {
    if (!tokenId) return;
    const musicId = readActiveMusic(tokenId);
    if (musicId) setActiveMusic(tokenId, musicId);
    const sfxId = readActiveSfx(tokenId);
    if (sfxId) _activeSfxId = sfxId;
}
