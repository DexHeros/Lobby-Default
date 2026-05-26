import { Panel } from '../ui/panel.js';

export default class FeesPanel extends Panel {
    static id        = 'fees';
    static variant   = 'codex';
    static width     = 520;
    static title     = 'Fees';
    static titleBreadcrumb = ['FEES'];
    static stageMode = 'dim';

    render() {
        const rows = [
            ['Create DexHero',      '0.005 ETH', 'One-time deploy fee on the chosen network.'],
            ['Register Game',       '0.02 ETH',  'Lists your game, allocates tier slot.'],
            ['Add Liquidity',       '0%',        'Protocol takes nothing; only network gas.'],
            ['Remove Liquidity',    '0%',        'Protocol takes nothing; only network gas.'],
            ['WarpStream Server',   '7%',        'Revenue share paid to hosting server per session.'],
            ['Secondary Trades',    '1%',        'Applied to secondary-market DexHero sales.'],
        ];
        return `
            <div class="hud-display" style="font-size:28px;letter-spacing:0.18em;margin-bottom:20px;">FEE<br>SCHEDULE</div>
            <div class="hud-body hud-dim" style="margin-bottom:28px;">Transparent. No hidden cuts.</div>
            <div>
                ${rows.map(([n, v, d]) => `
                    <div style="display:grid;grid-template-columns:1fr auto;gap:14px;padding:18px 0;border-bottom:1px solid var(--rule);">
                        <div>
                            <div style="font-family:var(--font-display);font-weight:600;font-size:15px;color:var(--ink-0);">${n}</div>
                            <div class="hud-body hud-dim" style="font-size:12.5px;margin-top:2px;">${d}</div>
                        </div>
                        <div class="hud-mono" style="color:var(--acc-cyan);font-size:14px;font-weight:600;letter-spacing:0.1em;align-self:start;">${v}</div>
                    </div>`).join('')}
            </div>
        `;
    }
}
