/* Schedule editor — owner-gated workshop modal for the JarJar
 * always-on (proactive) scheduler dials per DexHero.
 *
 * Subscribes to `dexhero:workshop-part` and opens when
 * `part === 'schedule'` (added to stage-annotations as a new clickable
 * label). Reads/writes /api/dexhero/:id/proactive-settings; next
 * signed CharacterRecipe at /api/dexhero/:id/recipe inherits the new
 * dials so JarJar's local planner honors them.
 *
 * Modeled on app/ui/brain-picker.js + voice-editor.js (same popover
 * shell, signed-msg pattern, close-on-Escape, click-outside). Reuses
 * .brain-picker__* CSS for visual consistency. */

import * as wallet from '../services/wallet.js';
import { on, E } from '../events.js';
import { getProactiveSettings, saveProactiveSettings } from '../services/dexhero-proactive.js';

let _wired = false;
let _popover = null;
let _currentSubject = null;

const POLL_OPTIONS = [
    { value: 5,   label: '5 min'  },
    { value: 15,  label: '15 min' },
    { value: 30,  label: '30 min' },
    { value: 60,  label: '1 hr'   },
    { value: 120, label: '2 hr'   },
];
const BUDGET_OPTIONS = [
    { value: 0,    label: 'Local only ($0)' },
    { value: 0.50, label: '$0.50/day'       },
    { value: 1.0,  label: '$1/day'          },
    { value: 5.0,  label: '$5/day'          },
    { value: 25.0, label: '$25/day'         },
];

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}

function closePopover() {
    if (!_popover) return;
    try { _popover.remove(); } catch {}
    _popover = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
}
function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); closePopover(); } }
function onOutside(ev) {
    if (!_popover) return;
    if (_popover.contains(ev.target)) return;
    closePopover();
}

function positionPopover(popover, anchorEl) {
    if (!popover || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const pw = 380;
    let left = rect.left + window.scrollX + rect.width / 2 - pw / 2;
    let top  = rect.bottom + window.scrollY + 10;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 12;
    if (left > maxLeft) left = maxLeft;
    if (left < 12 + window.scrollX) left = 12 + window.scrollX;
    popover.style.left = `${left}px`;
    popover.style.top  = `${top}px`;
}

function tokenIdOf(subject) {
    if (!subject) return null;
    if (subject.network === 'create') return null;
    return subject.id || subject.address || null;
}

function browserTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
}

async function openEditor(anchorEl) {
    closePopover();
    const tokenId = tokenIdOf(_currentSubject);
    if (!tokenId) return;

    const status = wallet.getStatus();

    _popover = document.createElement('div');
    _popover.className = 'brain-picker';
    _popover.setAttribute('role', 'dialog');
    _popover.setAttribute('aria-label', 'JarJar schedule editor');
    _popover.innerHTML = `
        <div class="brain-picker__head">
            <span class="brain-picker__title">Schedule</span>
            <button type="button" class="brain-picker__close" aria-label="Close">×</button>
        </div>
        <div class="brain-picker__body" data-body>
            <div class="brain-picker__loading">Loading…</div>
        </div>
    `;
    document.body.appendChild(_popover);
    positionPopover(_popover, anchorEl || document.body);
    _popover.querySelector('.brain-picker__close')?.addEventListener('click', closePopover);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

    let cfg;
    try {
        cfg = await getProactiveSettings(tokenId);
    } catch (err) {
        const body = _popover?.querySelector('[data-body]');
        if (body) body.innerHTML = `<div class="brain-picker__error">Couldn't load schedule (${escHtml(err?.message || 'unknown')}).</div>`;
        return;
    }
    if (!_popover) return;

    const isOwner = status?.connected && status.address
        && (cfg.owner_wallet || '').toLowerCase() === status.address.toLowerCase();
    // If no row yet, default `owner_wallet` is null — assume the connected
    // wallet COULD become owner on save. Server still gates by NFT ownership.
    const isProbablyOwner = isOwner || !cfg.owner_wallet;

    const pollHtml = POLL_OPTIONS.map((o) => `
        <option value="${o.value}" ${o.value === cfg.poll_interval_minutes ? 'selected' : ''}>${o.label}</option>
    `).join('');
    const budgetHtml = BUDGET_OPTIONS.map((o) => `
        <option value="${o.value}" ${Number(o.value) === Number(cfg.daily_budget_usd) ? 'selected' : ''}>${o.label}</option>
    `).join('');

    const body = _popover.querySelector('[data-body]');
    body.innerHTML = `
        <p class="brain-picker__hint" style="margin:0 0 10px;">
            Controls JarJar's always-on loop on the user's desktop. When enabled, the agent ticks in the background — planning, learning, drafting — even when the lobby is closed.
        </p>

        <label class="voice-editor__label" style="margin-top:4px;">
            <input type="checkbox" data-enabled ${cfg.enabled ? 'checked' : ''} ${isProbablyOwner ? '' : 'disabled'}>
            <span style="margin-left:8px;">Run JarJar in the background</span>
        </label>

        <div class="voice-editor__grid">
            <label class="voice-editor__label">
                <span>Poll interval</span>
                <select data-poll ${isProbablyOwner ? '' : 'disabled'}>${pollHtml}</select>
            </label>
            <label class="voice-editor__label">
                <span>Daily budget</span>
                <select data-budget ${isProbablyOwner ? '' : 'disabled'}>${budgetHtml}</select>
            </label>
        </div>

        <div class="voice-editor__grid">
            <label class="voice-editor__label">
                <span>Quiet start (local)</span>
                <input type="time" data-quiet-start value="${escHtml(cfg.quiet_hours_start || '')}" ${isProbablyOwner ? '' : 'disabled'}>
            </label>
            <label class="voice-editor__label">
                <span>Quiet end (local)</span>
                <input type="time" data-quiet-end value="${escHtml(cfg.quiet_hours_end || '')}" ${isProbablyOwner ? '' : 'disabled'}>
            </label>
        </div>

        <label class="voice-editor__label">
            <span>Timezone</span>
            <input type="text" data-tz value="${escHtml(cfg.timezone || browserTimezone())}" placeholder="IANA tz, e.g. America/Los_Angeles" ${isProbablyOwner ? '' : 'disabled'}>
        </label>

        <label class="voice-editor__label">
            <span>Max runs / day (1–1440)</span>
            <input type="number" min="1" max="1440" step="1" data-max-runs value="${Number(cfg.max_runs_per_day) || 24}" ${isProbablyOwner ? '' : 'disabled'}>
        </label>

        <div class="brain-picker__row" style="justify-content:space-between;align-items:center;gap:8px;margin-top:8px;">
            <span class="brain-picker__hint" data-status>${isProbablyOwner ? '' : 'Read-only — connect the owning wallet to edit.'}</span>
            <div style="display:flex;gap:8px;">
                <button type="button" class="brain-picker__btn brain-picker__btn--ghost" data-action="cancel">Close</button>
                <button type="button" class="brain-picker__btn"                          data-action="save" ${isProbablyOwner ? '' : 'disabled'}>Save</button>
            </div>
        </div>
    `;

    const statusEl = body.querySelector('[data-status]');
    body.querySelector('[data-action="cancel"]')?.addEventListener('click', closePopover);
    body.querySelector('[data-action="save"]')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const settings = {
                enabled:               body.querySelector('[data-enabled]').checked,
                poll_interval_minutes: Number(body.querySelector('[data-poll]').value),
                quiet_hours_start:     body.querySelector('[data-quiet-start]').value || null,
                quiet_hours_end:       body.querySelector('[data-quiet-end]').value   || null,
                timezone:              body.querySelector('[data-tz]').value.trim() || 'UTC',
                daily_budget_usd:      Number(body.querySelector('[data-budget]').value),
                max_runs_per_day:      Math.max(1, Math.min(1440, Number(body.querySelector('[data-max-runs]').value) || 24)),
            };
            await saveProactiveSettings(tokenId, settings);
            closePopover();
        } catch (err) {
            btn.textContent = 'Save';
            btn.disabled = false;
            const code = err?.body?.error || err?.message || 'failed';
            const msg = ({
                not_owner:            'Only the owner can edit this DexHero.',
                signature_expired:    'Signature expired — try again.',
                signature_invalid:    'Signature was rejected — reconnect your wallet.',
                wallet_not_connected: 'Connect a wallet first.',
            })[code] || `Save failed (${escHtml(code)}).`;
            if (statusEl) statusEl.textContent = msg;
        }
    });
}

/** Wire the schedule editor against the workshop-part event stream.
 *  Call once at app boot — idempotent. */
export function initScheduleEditor() {
    if (_wired) return;
    _wired = true;

    on(E.STAGE_SUBJECT, (subject) => { _currentSubject = subject || null; });
    document.addEventListener('dexhero:workshop-part', (ev) => {
        const { part, anchorEl } = ev.detail || {};
        if (part !== 'schedule') return;
        openEditor(anchorEl);
    });
}
