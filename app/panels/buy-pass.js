/* Buy-Pass panel — the single SPA entry point for purchasing the Platform
   Play Pass. Linked from the Host panel (gate state), the Profile panel
   (status row), and any direct deep link.

   Route: #/buy-pass[?return=/some/hash]
     - return defaults to /host so the natural flow Host → Buy → Host loops.
     - The return hash is normalized: the leading "#" or "/" is optional.

   On success the panel routes back to `#${return}` automatically. */

import { Panel } from '../ui/panel.js';
import * as wallet from '../services/wallet.js';
import { verifyPass, purchasePass, describePurchaseError, PASS_PRICE_USDC } from '../services/play-pass.js';
import { on, E } from '../events.js';
import { toast } from '../ui/toast.js';

export default class BuyPassPanel extends Panel {
    static id        = 'buy-pass';
    static variant   = 'right';
    static width     = 480;
    static title     = 'Play Pass';
    static titleBreadcrumb = ['PLAY PASS'];
    static stageMode = 'keep';

    constructor(params) {
        super(params);
        // Where to send the user after they own a pass. Defaults to the
        // host flow since that's the most likely entry point.
        const raw = (params.return || '/host').toString();
        this.returnHash = '#' + (raw.startsWith('/') ? raw : '/' + raw);
        this.state = 'checking';   // 'checking' | 'no-wallet' | 'active' | 'idle' | 'purchasing' | 'success'
        this.statusText = '';      // sub-line during purchase
    }

    render() {
        const s = wallet.getStatus();
        if (this.state === 'checking') {
            return `
                <div class="panel-state">
                    <div class="hud-spin"></div>
                    <div>Checking pass status</div>
                </div>`;
        }
        if (this.state === 'no-wallet' || !s.connected) {
            return `
                <div class="panel-state">
                    <div class="panel-state__title">Connect Wallet</div>
                    <div class="panel-state__body">Connect a wallet to check or purchase your Play Pass.</div>
                    <button class="hud-btn hud-btn--primary" data-connect>Connect</button>
                </div>`;
        }
        if (this.state === 'active' || this.state === 'success') {
            const heading = this.state === 'success' ? 'Pass activated' : 'Play Pass active';
            const body    = this.state === 'success'
                ? 'Your purchase is confirmed. Returning you to where you were.'
                : 'You already own a Platform Play Pass. You\'re cleared to host and create.';
            return `
                <section class="panel-section">
                    <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid rgba(34,197,94,0.35);border-radius:var(--r-2);background:rgba(34,197,94,0.05);">
                        <span class="hud-dot hud-dot--live"></span>
                        <div style="flex:1;min-width:0;">
                            <div class="hud-display" style="font-size:16px;">${heading}</div>
                            <div class="hud-label" style="margin-top:4px;">${body}</div>
                        </div>
                    </div>
                </section>
                <section class="panel-section">
                    <button class="hud-btn hud-btn--primary hud-btn--block hud-btn--lg" data-continue>Continue →</button>
                </section>`;
        }
        // idle | purchasing
        const purchasing = this.state === 'purchasing';
        return `
            <section class="panel-section">
                <div class="hud-display" style="font-size:22px;letter-spacing:0.18em;">$${PASS_PRICE_USDC} <span style="opacity:0.5;">USDC</span></div>
                <div class="hud-label" style="margin-top:4px;">One-time · Sepolia · unlocks hosting + AI character creation</div>
            </section>

            <section class="panel-section">
                <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;color:var(--ink-2);font-size:13px;line-height:1.5;">
                    <li>· Run a WarpStream host node</li>
                    <li>· Generate AI DexHero characters with Tripo</li>
                    <li>· Single signature: USDC permit + mint in one transaction</li>
                    <li>· Tied to your wallet — no expiry, no per-use fees</li>
                </ul>
            </section>

            <section class="panel-section">
                <button class="hud-btn hud-btn--primary hud-btn--block hud-btn--lg" data-buy ${purchasing ? 'disabled' : ''}>
                    ${purchasing ? 'Working…' : `Approve & Purchase $${PASS_PRICE_USDC} USDC`}
                </button>
                <div class="hud-label" data-status style="margin-top:10px;text-align:center;min-height:14px;">${this.statusText || ''}</div>
            </section>`;
    }

    async onMount() {
        // Re-run the verification when the wallet state changes (connect,
        // disconnect, account switch).
        const unsub = on(E.WALLET_CHANGED, () => {
            this.state = 'checking';
            this.statusText = '';
            this.rerender();
            this._wire();
            this._refreshStatus();
        });
        this._abort.signal.addEventListener('abort', unsub, { once: true });

        this._wire();
        await this._refreshStatus();
    }

    async _refreshStatus() {
        const s = wallet.getStatus();
        if (!s.connected) {
            this.state = 'no-wallet';
            this.rerender();
            this._wire();
            return;
        }
        const has = await verifyPass(s.address);
        this.state = has ? 'active' : 'idle';
        this.rerender();
        this._wire();
    }

    _wire() {
        const root = this.root;
        if (!root) return;

        root.querySelector('[data-connect]')?.addEventListener('click', () => {
            try {
                if (typeof window.openConnectModal === 'function') window.openConnectModal();
                else wallet.connect().catch(() => {});
            } catch {}
        }, { signal: this.signal });

        root.querySelector('[data-continue]')?.addEventListener('click', () => {
            location.hash = this.returnHash;
        }, { signal: this.signal });

        root.querySelector('[data-buy]')?.addEventListener('click', () => this._buy(), { signal: this.signal });
    }

    async _buy() {
        if (this.state === 'purchasing') return;
        this.state = 'purchasing';
        this.statusText = 'Preparing…';
        this.rerender();
        this._wire();
        try {
            await purchasePass({
                onStatus: (text) => {
                    this.statusText = text;
                    const el = this.root?.querySelector('[data-status]');
                    if (el) el.textContent = text;
                },
            });
            this.state = 'success';
            this.statusText = '';
            this.rerender();
            this._wire();
            toast('Play Pass activated', { kind: 'ok' });
            // Brief pause so the user can read the success state, then loop
            // back to wherever they came from.
            setTimeout(() => { location.hash = this.returnHash; }, 1500);
        } catch (err) {
            const msg = describePurchaseError(err);
            // "Pass already active" is a happy-path race (e.g. another tab
            // bought it first). Treat as success.
            if (msg === 'Pass already active') {
                this.state = 'active';
                toast('Play Pass active', { kind: 'ok' });
            } else {
                this.state = 'idle';
                toast(msg, { kind: 'err' });
            }
            this.statusText = '';
            this.rerender();
            this._wire();
        }
    }
}
