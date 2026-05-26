/* sound-popup.js — Sound slot's custom layout.
 *
 * Replaces the generic tile-grid for this one slot. Shape:
 *
 *   ┌──────────────────────────────────────────┐
 *   │  Sound                              ×    │
 *   ├──────────────────────────────────────────┤
 *   │  NOW PLAYING                             │
 *   │  ⏵ Voice  Jarvis Mode               ▶   │
 *   │  ⏵ Music  Lo-fi  · playing          ⏸   │
 *   │  ⏵ Cry    Chirp                     ▶   │
 *   ├──────────────────────────────────────────┤
 *   │  [Voice] [Music] [SFX]                   │
 *   ├──────────────────────────────────────────┤
 *   │   ▾ tab-specific layout                  │
 *   │     • voice → rich rows                  │
 *   │     • music → card grid w/ mood color    │
 *   │     • sfx   → compact pill row           │
 *   └──────────────────────────────────────────┘
 *
 * The popup uses openEquipmentSlot for its chrome (rounded glass +
 * close × + Truffle bubble pre-connect) with `omitLoadout: true` and
 * `customBody: soundBodyHTML(ctx)` — the body string is everything
 * below the head. After each paint, mountSoundHandlers() re-binds
 * delegated click handlers on the fresh DOM.
 *
 * The voice tab's "Save system prompt" flow lives in voice-editor.js
 * (matchPreset / applyVoicePending). This module only renders the UI
 * and dispatches user actions back through a small `actions` object.
 */

import { openEquipmentSlot } from './equipment-slot.js';
import {
    MUSIC_PRESETS, SFX_PRESETS,
    setActiveMusic, stopMusic, setActiveSfx,
    getActiveMusicId, getActiveSfxId, playSfx,
} from '../services/dexhero-sound.js';
import { attachTopicChatToPicker } from './topic-chat-pane.js';

let _handle = null;

/* ── Public ────────────────────────────────────────────────────── */

export function openSoundPopup({ anchorEl, tokenId, voicePresets, voiceCustomId, ctx, actions }) {
    const state = {
        tokenId,
        tab: 'voice',
        voicePresets,
        voiceCustomId,
        ctx,           // { activeVoiceId, savedPrompt, pendingPrompt, isOwner, customMode }
        actions,       // { onVoicePick, onCustomEdit, onCustomSave, onCustomBack, onMusicPick, onSfxPick, onMusicToggle }
        musicPlaying:  Boolean(getActiveMusicId(tokenId)),
    };

    _handle = openEquipmentSlot({
        partId: 'voice',
        title: 'Sound',
        anchorEl,
        omitLoadout: true,
        customBody: soundBodyHTML(state),
        footer: null,
    });
    mountSoundHandlers(_handle.root, state);
    attachTopicChatToPicker(_handle, 'voice', { tokenId }).catch(() => {});
    return {
        close: () => _handle?.close(),
        rerender: (patch) => {
            Object.assign(state, patch || {});
            _handle?.refresh({ customBody: soundBodyHTML(state) });
            mountSoundHandlers(_handle.root, state);
        },
    };
}

/* ── HTML ──────────────────────────────────────────────────────── */

function soundBodyHTML(state) {
    return `
        <div class="sound-pop">
            ${nowPlayingHTML(state)}
            ${tabsHTML(state)}
            <div class="sound-pop__body" data-tab-body>
                ${tabBodyHTML(state)}
            </div>
        </div>`;
}

function nowPlayingHTML(state) {
    const v = currentVoice(state);
    const m = currentMusic(state);
    const s = currentSfx(state);
    return `
        <div class="sound-pop__now">
            <span class="sound-pop__now-label">Now playing</span>
            <button class="sound-pop__now-row" type="button" data-now="voice" data-active="${state.tab === 'voice' ? 'true' : 'false'}">
                <span class="sound-pop__now-kind">VOICE</span>
                <span class="sound-pop__now-name">${escHtml(v?.name || '—')}</span>
                ${v?.tagline ? `<span class="sound-pop__now-sub">${escHtml(v.tagline)}</span>` : ''}
            </button>
            <button class="sound-pop__now-row" type="button" data-now="music" data-active="${state.tab === 'music' ? 'true' : 'false'}">
                <span class="sound-pop__now-kind">MUSIC</span>
                <span class="sound-pop__now-name">${escHtml(m?.name || '—')}</span>
                ${m && m.id !== 'mute' ? `<span class="sound-pop__now-state" data-music-state="${state.musicPlaying ? 'playing' : 'paused'}">${state.musicPlaying ? '◉ playing' : '◌ paused'}</span>` : ''}
                ${m && m.id !== 'mute' ? `<span class="sound-pop__now-toggle" data-action="music-toggle" role="button" tabindex="0" aria-label="${state.musicPlaying ? 'Pause music' : 'Resume music'}">${state.musicPlaying ? '⏸' : '▶'}</span>` : ''}
            </button>
            <button class="sound-pop__now-row" type="button" data-now="sfx" data-active="${state.tab === 'sfx' ? 'true' : 'false'}">
                <span class="sound-pop__now-kind">CRY</span>
                <span class="sound-pop__now-name">${escHtml(s?.name || '—')}</span>
                <span class="sound-pop__now-toggle" data-action="sfx-preview" role="button" tabindex="0" aria-label="Preview cry">▶</span>
            </button>
        </div>`;
}

function tabsHTML(state) {
    const tabs = [
        { id: 'voice', label: 'Voice' },
        { id: 'music', label: 'Music' },
        { id: 'sfx',   label: 'SFX'   },
    ];
    return `
        <nav class="sound-pop__tabs" role="tablist">
            ${tabs.map((t) =>
                `<button type="button" class="sound-pop__tab${t.id === state.tab ? ' is-active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === state.tab ? 'true' : 'false'}">${t.label}</button>`
            ).join('')}
        </nav>`;
}

function tabBodyHTML(state) {
    if (state.tab === 'music') return musicTabHTML(state);
    if (state.tab === 'sfx')   return sfxTabHTML(state);
    return voiceTabHTML(state);
}

/* ── Voice tab — rich vertical rows ────────────────────────────── */

function voiceTabHTML(state) {
    if (state.ctx.customMode) {
        return `
            <div class="sound-pop__custom">
                <div class="sound-pop__custom-head">
                    <button type="button" class="sound-pop__back" data-action="voice-custom-back">← Back</button>
                    <span class="sound-pop__custom-count" data-custom-count>${state.ctx.pendingPrompt.length} / 4000</span>
                </div>
                <textarea class="sound-pop__custom-text" data-custom-text rows="9" maxlength="4000"
                          placeholder="Describe how your DexHero should speak. Tone, style, what they care about…">${escHtml(state.ctx.pendingPrompt)}</textarea>
                <div class="sound-pop__custom-foot">
                    <button type="button" class="sound-pop__save"${state.ctx.isOwner ? '' : ' disabled'} data-action="voice-custom-save">Save voice</button>
                </div>
            </div>`;
    }
    const activeId = state.ctx.activeVoiceId;
    const rows = state.voicePresets.map((p) => `
        <button type="button" class="sound-pop__voice-row${p.id === activeId ? ' is-active' : ''}" data-voice-id="${escAttr(p.id)}">
            <span class="sound-pop__voice-mark" aria-hidden="true"></span>
            <span class="sound-pop__voice-info">
                <span class="sound-pop__voice-name">${escHtml(p.name)}</span>
                <span class="sound-pop__voice-tag">${escHtml(p.tagline || '')}</span>
            </span>
            ${p.id === activeId ? '<span class="sound-pop__voice-badge">Active</span>' : ''}
        </button>`).join('');
    return `
        <div class="sound-pop__voices">
            ${rows}
            <button type="button" class="sound-pop__voice-row sound-pop__voice-row--custom${activeId === state.voiceCustomId ? ' is-active' : ''}" data-voice-id="${escAttr(state.voiceCustomId)}" data-action="voice-custom-open">
                <span class="sound-pop__voice-mark sound-pop__voice-mark--plus" aria-hidden="true">+</span>
                <span class="sound-pop__voice-info">
                    <span class="sound-pop__voice-name">Custom</span>
                    <span class="sound-pop__voice-tag">Write your own personality</span>
                </span>
            </button>
        </div>`;
}

/* ── Music tab — mainstream app connections (Spotify / Apple / etc) ── */

function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
    const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
    const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function musicTabHTML(state) {
    const activeId = getActiveMusicId(state.tokenId);
    const cards = MUSIC_PRESETS.map((p) => {
        const brand = p.brand || '#94a3b8';
        const tint = hexToRgba(brand, 0.18);
        const ring = hexToRgba(brand, 0.55);
        const isActive = p.id === activeId;
        return `
            <button type="button" class="sound-pop__music-card${isActive ? ' is-active' : ''}"
                    data-music-id="${escAttr(p.id)}"
                    style="--mood-tint: ${tint}; --brand-ring: ${ring}; --brand-color: ${brand};">
                <span class="sound-pop__music-glyph" aria-hidden="true">${p.glyph || ''}</span>
                <span class="sound-pop__music-info">
                    <span class="sound-pop__music-name">${escHtml(p.name)}</span>
                    <span class="sound-pop__music-tag">${escHtml(p.tagline)}</span>
                    <span class="sound-pop__music-stat">${escHtml(p.stat || '')}</span>
                </span>
                ${isActive ? '<span class="sound-pop__music-dot" aria-hidden="true"></span>' : ''}
            </button>`;
    }).join('');
    return `<div class="sound-pop__music-grid">${cards}</div>`;
}

/* ── SFX tab — compact pill row + tiny waveform preview ────────── */

function sfxTabHTML(state) {
    const activeId = getActiveSfxId(state.tokenId);
    const pills = SFX_PRESETS.map((p) => `
        <button type="button" class="sound-pop__sfx-pill${p.id === activeId ? ' is-active' : ''}" data-sfx-id="${escAttr(p.id)}">
            <span class="sound-pop__sfx-wave" aria-hidden="true">
                <svg viewBox="0 0 32 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                    <path d="M2 6 L5 6 L7 2 L11 10 L13 4 L15 8 L17 6 L20 6 L22 3 L24 9 L26 6 L30 6"/>
                </svg>
            </span>
            <span class="sound-pop__sfx-name">${escHtml(p.name)}</span>
            ${p.id === activeId ? '<span class="sound-pop__sfx-dot" aria-hidden="true"></span>' : ''}
        </button>`).join('');
    return `
        <div class="sound-pop__sfx-wrap">
            <p class="sound-pop__sfx-hint">Click any cry — equips and previews the sound my voice plays before I speak.</p>
            <div class="sound-pop__sfx-row">${pills}</div>
        </div>`;
}

/* ── Handlers (delegated; re-bound after each paint) ───────────── */

function mountSoundHandlers(root, state) {
    if (!root) return;
    const body = root.querySelector('.sound-pop');
    if (!body) return;

    body.addEventListener('click', (ev) => {
        const tabBtn  = ev.target.closest('[data-tab]');
        const nowBtn  = ev.target.closest('[data-now]');
        const action  = ev.target.closest('[data-action]')?.getAttribute('data-action');
        const voice   = ev.target.closest('[data-voice-id]')?.getAttribute('data-voice-id');
        const music   = ev.target.closest('[data-music-id]')?.getAttribute('data-music-id');
        const sfx     = ev.target.closest('[data-sfx-id]')?.getAttribute('data-sfx-id');

        if (action === 'music-toggle') {
            ev.preventDefault(); ev.stopPropagation();
            const cur = getActiveMusicId(state.tokenId);
            if (state.musicPlaying && cur) {
                stopMusic();
                state.musicPlaying = false;
            } else if (cur && cur !== 'mute') {
                setActiveMusic(state.tokenId, cur);
                state.musicPlaying = true;
            }
            rerenderSelf(root, state);
            return;
        }
        if (action === 'sfx-preview') {
            ev.preventDefault(); ev.stopPropagation();
            playSfx(getActiveSfxId(state.tokenId));
            return;
        }
        if (action === 'voice-custom-open') {
            ev.preventDefault();
            state.ctx.customMode = true;
            state.actions?.onCustomEdit?.();
            rerenderSelf(root, state);
            return;
        }
        if (action === 'voice-custom-back') {
            ev.preventDefault();
            state.ctx.customMode = false;
            state.actions?.onCustomBack?.();
            rerenderSelf(root, state);
            return;
        }
        if (action === 'voice-custom-save') {
            ev.preventDefault();
            state.actions?.onCustomSave?.(state.ctx.pendingPrompt);
            return;
        }
        if (tabBtn) {
            state.tab = tabBtn.getAttribute('data-tab');
            rerenderSelf(root, state);
            return;
        }
        if (nowBtn && nowBtn.hasAttribute('data-now') && !action) {
            // Clicking a Now Playing row jumps to that tab.
            state.tab = nowBtn.getAttribute('data-now');
            rerenderSelf(root, state);
            return;
        }
        if (voice) {
            state.ctx.activeVoiceId = voice;
            if (voice === state.voiceCustomId) {
                state.ctx.customMode = true;
                state.actions?.onCustomEdit?.();
            } else {
                state.actions?.onVoicePick?.(voice);
            }
            rerenderSelf(root, state);
            return;
        }
        if (music) {
            state.actions?.onMusicPick?.(music);
            state.musicPlaying = music !== 'mute';
            rerenderSelf(root, state);
            return;
        }
        if (sfx) {
            state.actions?.onSfxPick?.(sfx);
            rerenderSelf(root, state);
            return;
        }
    });

    // Live char count + sync pendingPrompt while typing in the custom
    // textarea. The Save click reads the latest value below.
    const ta = body.querySelector('[data-custom-text]');
    if (ta) {
        const count = body.querySelector('[data-custom-count]');
        ta.addEventListener('input', () => {
            state.ctx.pendingPrompt = ta.value;
            if (count) count.textContent = `${ta.value.length} / 4000`;
        });
        // Auto-focus when first entering custom mode so the user can
        // start typing without an extra click.
        setTimeout(() => {
            try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
        }, 60);
    }
}

function rerenderSelf(root, state) {
    if (!_handle?.refresh) return;
    _handle.refresh({ customBody: soundBodyHTML(state) });
    mountSoundHandlers(_handle.root, state);
}

/* ── Now-playing helpers ───────────────────────────────────────── */

function currentVoice(state) {
    const id = state.ctx.activeVoiceId;
    if (!id) return null;
    if (id === state.voiceCustomId) return { name: 'Custom', tagline: 'Your prompt' };
    return state.voicePresets.find((p) => p.id === id) || null;
}
function currentMusic(state) {
    const id = getActiveMusicId(state.tokenId);
    return id ? MUSIC_PRESETS.find((p) => p.id === id) : null;
}
function currentSfx(state) {
    const id = getActiveSfxId(state.tokenId);
    return id ? SFX_PRESETS.find((p) => p.id === id) : null;
}

/* ── Escape ────────────────────────────────────────────────────── */

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}
function escAttr(s) { return escHtml(s); }
