import { Panel } from '../ui/panel.js';

export default class PrivacyPanel extends Panel {
    static id        = 'privacy';
    static variant   = 'codex';
    static width     = 560;
    static title     = 'Privacy';
    static titleBreadcrumb = ['PRIVACY'];
    static stageMode = 'dim';

    render() {
        return `
            <div class="hud-display" style="font-size:28px;letter-spacing:0.18em;margin-bottom:20px;">PRIVACY</div>
            <article class="hud-body hud-dim" style="display:flex;flex-direction:column;gap:14px;max-width:60ch;">
                <p>DexHero is on-chain first. Your wallet address and signed messages are necessary for every action.</p>
                <p>We store the minimum metadata needed to render your DexHeros: name, symbol, image, optional 3D model URL. All stored in Supabase; public read, owner-write via signed messages.</p>
                <p>No email. No tracking pixels. No ad network. No third-party analytics beyond uptime monitoring.</p>
                <p>IPFS is permanent — images and metadata pinned via Pinata are public forever by design.</p>
                <p>You can disconnect at any time. Nothing client-side persists beyond your session except a cached wallet address you opted into storing.</p>
            </article>
        `;
    }
}
