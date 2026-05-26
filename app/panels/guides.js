import { Panel } from '../ui/panel.js';

export default class GuidesPanel extends Panel {
    static id        = 'guides';
    static variant   = 'codex';
    static width     = 640;
    static title     = 'Guides';
    static titleBreadcrumb = ['DOCS', 'GUIDES'];
    static stageMode = 'dim';

    render() {
        const topics = [
            { t: 'Create your first DexHero',       d: 'Name, symbol, chain, model, launch. Five fields, one signed message.',  h: '#/create/dexhero' },
            { t: 'Wire a DexHero to a game',        d: 'From any token-detail, use the + action to link into a registered game.', h: '#/market' },
            { t: 'Run a WarpStream server',         d: 'Hardware check, signed heartbeat, revenue share — in that order.',       h: '#/nodes/onboard' },
            { t: 'Add or remove liquidity',         d: 'Two buttons on any token page. Slippage is adaptive.',                   h: '#/token/demo' },
            { t: 'Generate a game API key',         d: 'Open a game dashboard, sign, copy. Key is shown once.',                  h: '#/profile' },
            { t: 'Bridge with LayerZero V2',        d: 'Supported across Ethereum, Base, BNB Chain, Monad.',                     h: '#/docs/api' },
        ];
        return `
            <div class="hud-display" style="font-size:28px;letter-spacing:0.18em;margin-bottom:8px;">GUIDES</div>
            <div class="hud-body hud-dim" style="margin-bottom:24px;">Short reads. Every flow in 5 minutes.</div>
            <div>
                ${topics.map((x) => `
                    <a class="panel-row" href="${x.h}" style="--row-cols: 1fr auto;">
                        <span style="display:flex;flex-direction:column;gap:3px;">
                            <span style="color:var(--ink-0);font-family:var(--font-display);font-weight:600;font-size:14px;">${x.t}</span>
                            <span class="hud-body hud-dim" style="font-size:12.5px;">${x.d}</span>
                        </span>
                        <span style="color:var(--ink-3);font-family:var(--font-mono);">→</span>
                    </a>`).join('')}
            </div>
        `;
    }
}
