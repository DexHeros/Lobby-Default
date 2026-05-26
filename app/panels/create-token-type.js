/* Create-token-type — step 2 of the create flow.
   Two tiles: Launch New Token | Use Existing Token.
   Reads ?method=generate|upload from the route params and routes to the
   appropriate step-3 panel (generate-model vs create-dexhero). */

import { Panel } from '../ui/panel.js';
import { renderSteps, panelStyles } from './create.js';

export default class CreateTokenTypePanel extends Panel {
    static id        = 'create-token-type';
    static variant   = 'right';
    static width     = 480;
    static title     = 'Token Type';
    static titleBreadcrumb = ['CREATE', 'TYPE'];
    static stageMode = 'keep';
    static parentHash = '#/create';   // Back → method chooser

    constructor(params) {
        super(params);
        this.method = params.method === 'upload' ? 'upload' : 'generate';
    }

    render() {
        const m = this.method;
        const step3Route = (launchType) => m === 'upload'
            ? `#/create/dexhero?launchType=${launchType}`
            : `#/models/generate?launchType=${launchType}`;

        return `
            <div class="hud-display" style="font-size:24px;letter-spacing:0.18em;margin-bottom:10px;">CHOOSE<br>YOUR TOKEN TYPE</div>
            <div class="hud-body hud-dim" style="margin-bottom:28px;font-size:13px;">Are you launching a brand-new token, or connecting an existing one?</div>

            ${renderSteps(2)}

            <div style="display:flex;flex-direction:column;gap:12px;">
                <a class="tile" href="${step3Route('new')}">
                    <span class="tile__icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    </span>
                    <span class="tile__body">
                        <span class="tile__name">Launch New Token</span>
                        <span class="tile__desc">$100 USDC fee + 1% of supply to treasury.</span>
                    </span>
                    <span class="tile__arrow">→</span>
                </a>

                <a class="tile" href="${step3Route('existing')}">
                    <span class="tile__icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    </span>
                    <span class="tile__body">
                        <span class="tile__name">Use Existing Token</span>
                        <span class="tile__desc">1% of your existing supply to treasury — no flat fee.</span>
                    </span>
                    <span class="tile__arrow">→</span>
                </a>
            </div>

            <style>${panelStyles()}</style>
        `;
    }

    onParamsChange(params) {
        const next = params.method === 'upload' ? 'upload' : 'generate';
        if (next !== this.method) {
            this.method = next;
            this.rerender();
        }
    }
}
