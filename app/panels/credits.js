/* Credits — hall of fame for every creator whose patch the platform
 * promoted into the default base. Permanent visibility. */

import { Panel } from '../ui/panel.js';
import { getCreditsList } from '../services/upgrades-mock.js';

export default class CreditsPanel extends Panel {
    static id        = 'credits';
    static variant   = 'codex';
    static width     = 720;
    static title     = 'Credits';
    static titleBreadcrumb = ['CREDITS'];
    static stageMode = 'dim';

    render() {
        const list = getCreditsList();
        return `
            <div class="credits">
                <header class="credits__head">
                    <div class="hud-display" style="font-size:26px;letter-spacing:0.14em;">DEFAULT BASE<br>CREDITS</div>
                    <div class="hud-body hud-dim" style="margin-top:6px;max-width:520px;">
                        Every creator whose patch the platform team merged into the everything-avatar default experience. Permanent attribution.
                    </div>
                </header>

                ${list.length ? `
                    <ul class="credits__list">
                        ${list.map(({ patch, creator }) => `
                            <li class="credits__row">
                                <span class="credits__thumb">${esc(patch.preview_thumb || '◆')}</span>
                                <div class="credits__meta">
                                    <a class="credits__patch-title" href="#/upgrade/${esc(patch.id)}">${esc(patch.title)}</a>
                                    <div class="credits__byline hud-body hud-dim">
                                        by <a href="#/creator/${esc(patch.author_username)}">${esc(patch.author_username)}</a>
                                        ${patch.promoted_at ? `· promoted ${esc(patch.promoted_at.slice(0, 10))}` : ''}
                                    </div>
                                </div>
                                <span class="credits__star" aria-hidden="true">★</span>
                            </li>
                        `).join('')}
                    </ul>
                ` : `<div class="hud-body hud-dim">No promoted patches yet. The first one earns permanent attribution.</div>`}
            </div>
        `;
    }
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
