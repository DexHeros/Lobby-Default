import { Panel } from '../ui/panel.js';

export default class TermsPanel extends Panel {
    static id        = 'terms';
    static variant   = 'codex';
    static width     = 560;
    static title     = 'Terms';
    static titleBreadcrumb = ['TERMS'];
    static stageMode = 'dim';

    render() {
        return `
            <div class="hud-display" style="font-size:28px;letter-spacing:0.18em;margin-bottom:20px;">TERMS</div>
            <article class="hud-body hud-dim" style="display:flex;flex-direction:column;gap:14px;max-width:60ch;">
                <p>DexHero is experimental software interacting with public blockchains. You are responsible for your wallet, your keys, and the transactions you sign.</p>
                <p>Nothing here is investment advice. Tokens launched via DexHero may go to zero. Liquidity pools may be drained. Games may fail to launch. WarpStream servers may drop connections.</p>
                <p>Creator fees, tier ranks, and revenue shares are configured per-launch and may change between versions.</p>
                <p>By connecting a wallet, you acknowledge that on-chain actions are final and irreversible.</p>
                <p>Use at your own risk. Treat your wallet like it holds your real savings — because it does.</p>
            </article>
        `;
    }
}
