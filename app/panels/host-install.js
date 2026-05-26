// app/panels/host-install.js — advanced install options (power users only).
//
// The default install path is the consumer stub installer downloadable from
// the big "Download for Windows" button on /#/host. This panel covers the
// rare cases where someone wants to install non-interactively (e.g. an
// operator running a fleet of hosts via Ansible / Group Policy):
//
//   - Headless / CI-friendly PowerShell one-liner that does the same trust
//     bootstrap + install as the stub, with no GUI prompts.
//
// Linked from the host panel as "Advanced install options →".

import { Panel } from '../ui/panel.js';

(function loadStyles() {
    if (document.querySelector('link[data-panel-css="host-play-hud"]')) return;
    const l = document.createElement('link');
    l.rel  = 'stylesheet';
    l.href = '/styles/panels/host-play-hud.css';
    l.setAttribute('data-panel-css', 'host-play-hud');
    document.head.appendChild(l);
})();

const ORIGIN = (typeof location !== 'undefined' ? location.origin : 'https://v3labs.onrender.com');
const STUB_URL    = `${ORIGIN}/api/host/installer/windows`;
const PS_INSTALL  = `iwr ${ORIGIN}/api/host/install -UseBasicParsing | iex`;

export default class HostInstallPanel extends Panel {
    static id              = 'host-install';
    static variant         = 'right';
    static width           = 620;
    static title           = 'Advanced — PowerShell + Headless';
    static titleBreadcrumb = ['HOST', 'INSTALL', 'ADVANCED'];
    static stageMode       = 'dim';
    static parentHash      = '#/host';

    render() {
        const codeStyle = 'user-select:all;cursor:text;background:rgba(0,0,0,0.55);padding:12px 14px;font-size:11.5px;font-family:var(--font-mono);color:var(--ink-0,#fff);border-left:2px solid var(--acc-cyan,#06b6d4);margin-top:10px;overflow-x:auto;white-space:nowrap;letter-spacing:0.04em;';
        return `
            <section class="panel-section" style="padding:0;background:transparent;border:0;">
                <div class="hpd-frame hpd-frame--lit">
                    <div class="hpd-frame__corners"></div>
                    <span class="hpd-eyebrow">
                        <span class="hpd-eyebrow__led hpd-eyebrow__led--warn"></span>
                        Advanced · Power users
                    </span>
                    <h1 class="hpd-display hpd-display--md">Headless install</h1>
                    <p class="hpd-subline">
                        Most hosts should grab the one-click installer from <a href="#/host" style="color:var(--acc-cyan,#06b6d4);">/host</a>.
                        This page is for fleet / CI deploys.
                    </p>

                    <div class="hpd-stat-row">
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Trust anchor</div>
                            <div class="hpd-stat__value hpd-stat__value--cyan" style="font-size:13px;">On-chain</div>
                        </div>
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Signature</div>
                            <div class="hpd-stat__value" style="font-size:13px;">Self-signed</div>
                        </div>
                        <div class="hpd-stat">
                            <div class="hpd-stat__label">Mode</div>
                            <div class="hpd-stat__value hpd-stat__value--warn" style="font-size:13px;">Headless</div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="panel-section" style="padding:0;background:transparent;border:0;margin-top:14px;">
                <div class="hpd-frame">
                    <div class="hpd-frame__corners"></div>
                    <div class="hpd-divider" style="margin-top:0;">
                        <span class="hpd-divider__tag">01 · Direct download</span>
                        <span class="hpd-divider__line"></span>
                    </div>
                    <p class="hpd-subline" style="margin-bottom:0;">
                        Same stub installer the website's button serves. Useful for scripted deployment:
                    </p>
                    <pre style="${codeStyle}">${this._esc(STUB_URL)}</pre>
                </div>
            </section>

            <section class="panel-section" style="padding:0;background:transparent;border:0;margin-top:14px;">
                <div class="hpd-frame">
                    <div class="hpd-frame__corners"></div>
                    <div class="hpd-divider" style="margin-top:0;">
                        <span class="hpd-divider__tag">02 · PowerShell · Headless</span>
                        <span class="hpd-divider__line"></span>
                    </div>
                    <p class="hpd-subline" style="margin-bottom:0;">
                        Run from an elevated prompt — imports the V3Labs code-signing cert, then installs non-interactively.
                    </p>
                    <pre style="${codeStyle}">${this._esc(PS_INSTALL)}</pre>
                    <button class="hpd-cta hpd-cta--secondary" data-copy="${this._esc(PS_INSTALL)}" type="button" style="margin-top:12px;">
                        <span>Copy command</span>
                        <span class="hpd-cta__chev">⎘</span>
                    </button>
                </div>
            </section>

            <section class="panel-section" style="padding:0;background:transparent;border:0;margin-top:14px;">
                <div class="hpd-frame">
                    <div class="hpd-frame__corners"></div>
                    <div class="hpd-divider" style="margin-top:0;">
                        <span class="hpd-divider__tag">03 · Trust model</span>
                        <span class="hpd-divider__line"></span>
                    </div>
                    <p class="hpd-subline">
                        DexHero uses a self-signed code-signing certificate anchored on-chain by the V3Labs Master Wallet.
                        Both install paths above silently import it as a trusted publisher on first run.
                    </p>
                    <nav class="hpd-link-row" style="justify-content:flex-start;margin-top:6px;">
                        <a href="${ORIGIN}/api/host/codesign-attestation" target="_blank">Attestation JSON</a>
                        <span class="hpd-link-row__sep">·</span>
                        <a href="https://github.com/DexHeros/V3Labs/tree/main/tools/installer/codesign" target="_blank">Verification source</a>
                        <span class="hpd-link-row__sep">·</span>
                        <a href="${ORIGIN}/api/host/install" target="_blank">Bootstrap script</a>
                    </nav>
                </div>
            </section>
        `;
    }

    bindEvents() {
        super.bindEvents?.();
        this.root?.querySelectorAll('[data-copy]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const text = btn.getAttribute('data-copy') || '';
                try {
                    await navigator.clipboard.writeText(text);
                    const original = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => { btn.textContent = original; }, 1500);
                } catch {
                    btn.textContent = 'Copy failed';
                }
            });
        });
    }

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
