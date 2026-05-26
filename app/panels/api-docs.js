import { Panel } from '../ui/panel.js';

export default class ApiDocsPanel extends Panel {
    static id        = 'api-docs';
    static variant   = 'codex';
    static width     = 720;
    static title     = 'API';
    static titleBreadcrumb = ['DOCS', 'API'];
    static stageMode = 'dim';

    render() {
        const groups = [
            { h: 'Game', items: [
                ['POST', '/api/game/keys/generate',     'Rotate a signed API key for a registered game.'],
                ['POST', '/api/game/register',          'Register a game; returns game id and slug.'],
                ['POST', '/api/game/tokens/link',       'Link a DexHero token to a game (owner signature).'],
                ['GET',  '/api/game/player/dexheros',   'Player\'s linked DexHeros for a given game.'],
            ]},
            { h: 'Cloud', items: [
                ['GET',  '/api/cloud/availability',     'Active sessions, servers online, avg quality.'],
                ['POST', '/api/matchmaker/request-session', 'Request a WarpStream session.'],
                ['POST', '/api/session/heartbeat',      'Keep a session alive.'],
            ]},
            { h: 'Server', items: [
                ['POST', '/api/node/heartbeat',         'Server → backend heartbeat with hardware fingerprint.'],
                ['POST', '/api/node/register',          'Register a new server (tier-based).'],
                ['GET',  '/api/network/stats',          'Aggregate network metrics.'],
            ]},
            { h: 'Token', items: [
                ['POST', '/api/tokens/upsert',          'Create or update token metadata.'],
                ['POST', '/api/tokens/update-model',    'Update the 3D model URL for a token.'],
                ['POST', '/api/sprites/generate',       'Trigger sprite turntable generation.'],
            ]},
        ];
        return `
            <div class="hud-display" style="font-size:28px;letter-spacing:0.18em;margin-bottom:24px;">API</div>
            ${groups.map((g) => `
                <section class="panel-section">
                    <div class="panel-section__head"><span class="panel-section__title">${g.h}</span></div>
                    <div>
                        ${g.items.map(([m, p, d]) => `
                            <div style="padding:12px 0;border-bottom:1px solid var(--rule);display:flex;align-items:baseline;gap:12px;">
                                <span class="hud-badge hud-badge--${m === 'POST' ? 'pending' : 'live'}" style="flex-shrink:0;">${m}</span>
                                <div style="flex:1;min-width:0;">
                                    <div class="hud-mono" style="color:var(--ink-0);font-size:13px;word-break:break-all;">${p}</div>
                                    <div class="hud-body hud-dim" style="font-size:12.5px;margin-top:4px;">${d}</div>
                                </div>
                            </div>`).join('')}
                    </div>
                </section>`).join('')}
        `;
    }
}
