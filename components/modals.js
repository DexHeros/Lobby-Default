// Modal Components

/**
 * Find the REAL MetaMask provider.
 * When Phantom is installed, it hijacks window.ethereum and sets isMetaMask=true.
 * We detect MetaMask specifically by checking the providers array (created when
 * multiple wallet extensions are installed) and finding the one that is MetaMask
 * but NOT Phantom.
 */
function getMetaMaskProvider() {
    // Case 1: Multiple providers (both Phantom + MetaMask installed)
    if (window.ethereum && window.ethereum.providers) {
        const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isPhantom);
        if (mm) return mm;
    }
    // Case 2: Only MetaMask installed (no providers array)
    if (window.ethereum && window.ethereum.isMetaMask && !window.ethereum.isPhantom) {
        return window.ethereum;
    }
    // Case 3: Check if MetaMask stored a reference
    if (window._metaMaskProvider) {
        return window._metaMaskProvider;
    }
    return null;
}

// Connect Wallet Modal
function createConnectModal() {
    return `
    <div class="modal-overlay hidden" id="connect-modal">
        <div class="modal glass-card wallet-modal">
            <div class="modal-header">
                <h3>Connect Wallet</h3>
                <button class="modal-close" onclick="closeConnectModal()">&times;</button>
            </div>
            <div class="modal-body">
                <p class="modal-subtitle">Choose your preferred wallet</p>
                <div class="wallet-options">
                    <button id="wallet-option-phantom" class="wallet-option" onclick="connectWallet('phantom')">
                        <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28' fill='%23AB9FF2'/><path d='M64 28c-20 0-36 16-36 36v32l8-6 8 6 8-6 8 6 8-6 8 6 8-6 8 6V64c0-20-16-36-36-36zm-12 28c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8zm24 0c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8z' fill='%23fff'/></svg>" alt="Phantom" class="wallet-icon">
                        <span class="wallet-name">Phantom</span>
                        <span class="wallet-tag recommended">EVM</span>
                    </button>
                    <button id="wallet-option-metamask" class="wallet-option" onclick="connectWallet('metamask')">
                        <img src="https://raw.githubusercontent.com/MetaMask/brand-resources/master/SVG/SVG_MetaMask_Icon_Color.svg" alt="MetaMask" class="wallet-icon" onerror="this.src='https://avatars.githubusercontent.com/u/11744586?s=200&v=4'">
                        <span class="wallet-name">MetaMask</span>
                        <span class="wallet-tag recommended">EVM</span>
                    </button>
                </div>
            </div>
            <div class="modal-footer-text">
                <p>By connecting, you agree to our <a href="/pages/terms.html">Terms of Service</a></p>
            </div>
        </div>
    </div>
    <style>
        .wallet-modal {
            max-width: 420px;
        }
        .wallet-options {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .wallet-option {
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            padding: 14px 16px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: left;
        }
        .wallet-option:hover {
            background: rgba(6, 182, 212, 0.1);
            border-color: rgba(6, 182, 212, 0.3);
        }
        .wallet-icon {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            object-fit: contain;
        }
        .wallet-name {
            flex: 1;
            font-size: 15px;
            font-weight: 500;
            color: #fff;
        }
        .wallet-tag {
            font-size: 11px;
            padding: 4px 8px;
            border-radius: 6px;
            font-weight: 500;
        }
        .wallet-tag.recommended {
            background: rgba(6, 182, 212, 0.2);
            color: #06b6d4;
        }
        .modal-subtitle {
            color: #94a3b8;
            font-size: 14px;
            margin-bottom: 20px !important;
        }
        .modal-footer-text {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
        }
        .modal-footer-text p {
            font-size: 12px;
            color: #64748b;
            margin: 0;
        }
        .modal-footer-text a {
            color: #06b6d4;
            text-decoration: none;
        }
        .modal-footer-text a:hover {
            text-decoration: underline;
        }
    </style>
    `;
}

// Manage Token Modal
function createManageModal() {
    return `
    <div class="modal-overlay hidden" id="manage-modal">
        <div class="modal glass-card">
            <div class="modal-header">
                <h3>Manage Token</h3>
                <button class="modal-close" onclick="closeManageModal()">&times;</button>
            </div>
            <div class="modal-body">
                <p class="modal-subtitle">Enter your token mint address to manage</p>
                <div class="form-group">
                    <label for="token-mint">Token Mint Address</label>
                    <input type="text" id="token-mint" class="form-input" placeholder="Enter token mint address...">
                </div>
                <button class="btn-primary full-width" onclick="manageToken()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Manage Token
                </button>
            </div>
        </div>
    </div>
    `;
}

// Network Selector Modal
function createNetworkModal() {
    return `
    <div class="modal-overlay hidden" id="network-modal">
        <div class="modal glass-card network-modal">
            <div class="modal-header">
                <h3>Select Network</h3>
                <button class="modal-close" onclick="closeNetworkModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="network-options">
                    <button class="network-option active" onclick="selectNetwork('sepolia')">
                        <svg class="network-icon-lg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#627EEA"/><text x="20" y="24" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">ETH</text></svg>
                        <div class="network-info">
                            <span class="network-name">Sepolia</span>
                            <span class="network-desc">Ethereum Testnet</span>
                        </div>
                    </button>
                    <button class="network-option" onclick="selectNetwork('bnb')">
                        <svg class="network-icon-lg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#F3BA2F"/><text x="20" y="24" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">BNB</text></svg>
                        <div class="network-info">
                            <span class="network-name">BNB Chain</span>
                            <span class="network-desc">BSC Mainnet</span>
                        </div>
                    </button>
                    <button class="network-option" onclick="selectNetwork('base')">
                        <svg class="network-icon-lg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#0052FF"/><text x="20" y="24" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">BASE</text></svg>
                        <div class="network-info">
                            <span class="network-name">Base</span>
                            <span class="network-desc">L2 Network</span>
                        </div>
                    </button>
                </div>
            </div>
        </div>
    </div>
    `;
}

// On mobile Safari/Chrome the wallet apps don't inject window.ethereum or
// window.solana — those globals only exist inside each wallet's own in-app
// browser. When discoverWallets() comes back empty on mobile we offer
// universal-link buttons that bounce the user into the wallet app at the
// current URL. Once injected there, the normal connect flow takes over.
function isMobileUA() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

function buildMobileWalletDeepLinks() {
    const href = location.href;
    const host = location.host;
    const path = location.pathname + location.search;
    return {
        metamask: `https://metamask.app.link/dapp/${host}${path}`,
        phantom:  `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(host)}`,
        coinbase: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}`,
    };
}

// Modal Control Functions
async function openConnectModal() {
    const modal = document.getElementById('connect-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    // Render the EIP-6963 wallet picker dynamically. Replaces the hardcoded
    // MetaMask + Phantom buttons with every wallet that announces itself.
    const optionsContainer = modal.querySelector('.wallet-options');
    if (!optionsContainer) return;

    optionsContainer.innerHTML = '<div style="padding:14px;text-align:center;color:rgba(255,255,255,0.55);">Detecting wallets…</div>';

    let walletService;
    try {
        walletService = await import('/app/services/wallet.js');
    } catch (err) {
        optionsContainer.innerHTML = `<div style="padding:14px;text-align:center;color:#ef4444;">Wallet service failed to load.<br><small>${err.message}</small></div>`;
        return;
    }

    const wallets = await walletService.discoverWallets();
    // Inline icons reused across the no-wallet (install-link) + mobile (deep-link)
    // branches so both render the same visual button row as the EIP-6963 picker.
    const phantomSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28' fill='%23AB9FF2'/><path d='M64 28c-20 0-36 16-36 36v32l8-6 8 6 8-6 8 6 8-6 8 6 8-6 8 6V64c0-20-16-36-36-36zm-12 28c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8zm24 0c3.3 0 6 3.6 6 8s-2.7 8-6 8-6-3.6-6-8 2.7-8 6-8z' fill='%23fff'/></svg>";
    const metamaskIcon = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28' fill='%23231f20'/><path d='M104 30 70 54l6-15z' fill='%23E2761B'/><path d='M24 30l34 24-6-15zm66 56-9 14 19 5 5-19zm-65 0 5 19 19-5-9-14z' fill='%23E4761B'/><path d='M30 60l-5 8 19 1-1-20zm68 0-13-11-1 20 19-1zM44 100l11-5-10-8zm29-5 11 5-1-13z' fill='%23E4761B'/><path d='M84 100 73 95l1 8v3zm-40 0 10 6v-3l1-8z' fill='%23D7C1B3'/><path d='M54 87 44 84l7-3zm20 0 3-6 7 3z' fill='%23233447'/><path d='m44 100 2-13-10 1zm38-13 2 13 8-12zm12-19-19 1 2 12 7-2 8 5zm-65 5 8-5 7 2 2-12-19-1z' fill='%23CD6116'/></svg>";
    const coinbaseIcon = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28' fill='%230052FF'/><path d='M64 92a28 28 0 1 1 27-35h-15a14 14 0 1 0 0 14h15A28 28 0 0 1 64 92z' fill='%23fff'/></svg>";

    if (!wallets || wallets.length === 0) {
        if (isMobileUA()) {
            const links = buildMobileWalletDeepLinks();
            optionsContainer.innerHTML = `
                <a class="wallet-option" href="${links.metamask}" rel="noopener noreferrer">
                    <img src="${metamaskIcon}" alt="MetaMask" class="wallet-icon">
                    <span class="wallet-name">MetaMask</span>
                    <span class="wallet-tag recommended">OPEN APP</span>
                </a>
                <a class="wallet-option" href="${links.phantom}" rel="noopener noreferrer">
                    <img src="${phantomSvg}" alt="Phantom" class="wallet-icon">
                    <span class="wallet-name">Phantom</span>
                    <span class="wallet-tag recommended">OPEN APP</span>
                </a>
                <a class="wallet-option" href="${links.coinbase}" rel="noopener noreferrer">
                    <img src="${coinbaseIcon}" alt="Coinbase Wallet" class="wallet-icon">
                    <span class="wallet-name">Coinbase Wallet</span>
                    <span class="wallet-tag recommended">OPEN APP</span>
                </a>`;
            return;
        }
        // Desktop, no wallet detected — render the same button row as the
        // EIP-6963 picker, but each button links to the wallet's install page
        // (opens in a new tab so the modal stays visible for retry).
        optionsContainer.innerHTML = `
            <a class="wallet-option" href="https://metamask.io/download.html" target="_blank" rel="noopener noreferrer">
                <img src="${metamaskIcon}" alt="MetaMask" class="wallet-icon">
                <span class="wallet-name">MetaMask</span>
                <span class="wallet-tag recommended">INSTALL</span>
            </a>
            <a class="wallet-option" href="https://phantom.app/download" target="_blank" rel="noopener noreferrer">
                <img src="${phantomSvg}" alt="Phantom" class="wallet-icon">
                <span class="wallet-name">Phantom</span>
                <span class="wallet-tag recommended">INSTALL</span>
            </a>
            <a class="wallet-option" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener noreferrer">
                <img src="${coinbaseIcon}" alt="Coinbase Wallet" class="wallet-icon">
                <span class="wallet-name">Coinbase Wallet</span>
                <span class="wallet-tag recommended">INSTALL</span>
            </a>`;
        return;
    }

    const lastUuid = walletService.getLastWalletUuid?.() || null;

    // Sort: last-used first, then alphabetical by name
    wallets.sort((a, b) => {
        if (a.info.uuid === lastUuid) return -1;
        if (b.info.uuid === lastUuid) return 1;
        return (a.info.name || '').localeCompare(b.info.name || '');
    });

    // Escape a string for safe insertion into an HTML attribute value
    // delimited by double-quotes. Used for src / alt / data-* attributes.
    const attrEscape = (s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

    optionsContainer.innerHTML = wallets.map((w, i) => {
        const safeName = String(w.info.name || 'Wallet').replace(/[<>"']/g, '');
        const initial  = safeName.charAt(0).toUpperCase();
        const iconSrc  = (w.info.icon && /^data:image\/|^https?:\/\//.test(w.info.icon))
            ? w.info.icon
            : '';
        // Brand fallback — wallet.js attaches WALLET_LOGOS[brand] for known
        // rdns (Phantom, MetaMask, Coinbase, etc.). Used as the SECOND-stage
        // fallback when the wallet's announced icon fails to load. This is
        // why Phantom showed a "P" placeholder instead of a logo: Phantom's
        // own announced icon was failing and we had no brand-aware fallback.
        const brandFallback = (w.info.brandIconFallback && /^data:image\/|^https?:\/\//.test(w.info.brandIconFallback))
            ? w.info.brandIconFallback
            : '';
        // Render the <img> WITHOUT inline onerror — inlining HTML markup into
        // an HTML attribute (via JSON.stringify or otherwise) corrupts the
        // surrounding tag, breaking the icon AND leaking placeholder text
        // ("M\">" etc.) into the DOM. The error handler is wired in JS below.
        const iconEl = iconSrc
            ? `<img src="${attrEscape(iconSrc)}" alt="${attrEscape(safeName)}" class="wallet-icon" data-fallback-letter="${attrEscape(initial)}"${brandFallback ? ` data-fallback-icon="${attrEscape(brandFallback)}"` : ''}>`
            : `<div class="wallet-icon" style="background:rgba(6,182,212,0.15);display:flex;align-items:center;justify-content:center;color:#06b6d4;font-weight:700;">${initial}</div>`;
        const tag = w.info.uuid === lastUuid ? '<span class="wallet-tag recommended">LAST USED</span>' : '<span class="wallet-tag recommended">EVM</span>';
        return `
            <button class="wallet-option" data-wallet-idx="${i}">
                ${iconEl}
                <span class="wallet-name">${safeName}</span>
                ${tag}
            </button>`;
    }).join('');

    // Attach fallback-on-error handlers in JS. Two-stage:
    //   1. announced icon fails → swap to brand fallback (data:image/svg+xml…)
    //   2. brand fallback also fails → swap to letter placeholder div
    // Done programmatically (not via inline onerror=) so we never have to
    // escape HTML markup into an attribute.
    optionsContainer.querySelectorAll('img.wallet-icon[data-fallback-letter]').forEach((img) => {
        img.addEventListener('error', function onErr() {
            const fallbackIcon = img.getAttribute('data-fallback-icon');
            // Stage 1: try the brand fallback exactly once. The img element
            // stays in place; we just swap its src so the same handler fires
            // again if the brand fallback ALSO fails.
            if (fallbackIcon && img.src !== fallbackIcon) {
                img.removeAttribute('data-fallback-icon');
                img.src = fallbackIcon;
                return;
            }
            // Stage 2: replace with letter placeholder div.
            const letter = img.getAttribute('data-fallback-letter') || '';
            const div = document.createElement('div');
            div.className = 'wallet-icon';
            div.style.cssText = 'background:rgba(6,182,212,0.15);display:flex;align-items:center;justify-content:center;color:#06b6d4;font-weight:700;';
            div.textContent = letter;
            img.replaceWith(div);
        });
    });

    // Wire clicks
    optionsContainer.querySelectorAll('[data-wallet-idx]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.getAttribute('data-wallet-idx'), 10);
            const picked = wallets[idx];
            if (!picked) return;
            closeConnectModal();
            try {
                await walletService.connect(picked);
            } catch (err) {
                console.error('Wallet connection failed:', err);
                alert('Connection failed: ' + (err?.message || err));
            }
        });
    });

    // Append install-link buttons for any of {MetaMask, Phantom, Coinbase}
    // that weren't detected via EIP-6963. Mainstream wallets always visible
    // so a brand-new user with one wallet installed still sees how to add
    // the others if they want to switch.
    const detectedRdns = wallets.map((w) => (w.info?.rdns || '').toLowerCase());
    const installRows = [];
    if (!detectedRdns.some((r) => r.includes('metamask'))) {
        installRows.push(`<a class="wallet-option" href="https://metamask.io/download.html" target="_blank" rel="noopener noreferrer">
            <img src="${metamaskIcon}" alt="MetaMask" class="wallet-icon">
            <span class="wallet-name">MetaMask</span>
            <span class="wallet-tag recommended">INSTALL</span>
        </a>`);
    }
    if (!detectedRdns.some((r) => r.includes('phantom'))) {
        installRows.push(`<a class="wallet-option" href="https://phantom.app/download" target="_blank" rel="noopener noreferrer">
            <img src="${phantomSvg}" alt="Phantom" class="wallet-icon">
            <span class="wallet-name">Phantom</span>
            <span class="wallet-tag recommended">INSTALL</span>
        </a>`);
    }
    if (!detectedRdns.some((r) => r.includes('coinbase'))) {
        installRows.push(`<a class="wallet-option" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener noreferrer">
            <img src="${coinbaseIcon}" alt="Coinbase Wallet" class="wallet-icon">
            <span class="wallet-name">Coinbase Wallet</span>
            <span class="wallet-tag recommended">INSTALL</span>
        </a>`);
    }
    if (installRows.length) {
        optionsContainer.insertAdjacentHTML('beforeend', installRows.join(''));
    }
}

function closeConnectModal() {
    document.getElementById('connect-modal').classList.add('hidden');
}

function openManageModal() {
    document.getElementById('manage-modal').classList.remove('hidden');
}

function closeManageModal() {
    document.getElementById('manage-modal').classList.add('hidden');
}

function openNetworkModal() {
    document.getElementById('network-modal').classList.remove('hidden');
}

function closeNetworkModal() {
    document.getElementById('network-modal').classList.add('hidden');
}

// Wallet connect / disconnect / init are now thin forwarders to the
// authoritative wallet service at /app/services/wallet.js. The service owns
// state, EIP-6963 discovery, EIP-2255 disconnect, hard-refresh detection,
// EIP-1193 event handlers, and the legacy compat write-through (sessionStorage,
// window.DexHeroBlockchain, window.UnifiedWallet, window 'walletChanged' event).
//
// These wrappers exist so legacy /pages/*.html that calls connectWallet() /
// disconnectWallet() / initWallet() at the global scope keeps working.

async function connectWallet(/* ignored: walletType */) {
    // The legacy callers pass 'metamask' or 'phantom'; the new modal lets the
    // user pick from EIP-6963-detected wallets. Either way we open the picker.
    return openConnectModal();
}

async function disconnectWallet() {
    try {
        const { disconnect } = await import('/app/services/wallet.js');
        await disconnect();
    } catch (err) {
        console.error('Wallet disconnect failed:', err);
    }
    if (typeof updateConnectButton === 'function') updateConnectButton();
}

async function initWallet() {
    // The wallet service runs its own init() on first import. Nothing to do
    // here except wait for it to settle so updateConnectButton sees fresh state.
    try {
        const svc = await import('/app/services/wallet.js');
        await svc.init();
    } catch (err) {
        console.warn('Wallet service init failed:', err);
    }
    if (typeof updateConnectButton === 'function') updateConnectButton();
}

function manageToken() {
    const mintAddress = document.getElementById('token-mint').value;
    if (mintAddress) {
        window.location.href = `/pages/token-detail.html?mint=${mintAddress}`;
    } else {
        alert('Please enter a token mint address');
    }
}

function selectNetwork(network) {
    console.log('Selected network:', network);
    window.currentNetwork = network;
    localStorage.setItem('selectedNetwork', network);

    // Update active state in dropdown
    document.querySelectorAll('.network-option').forEach(opt => opt.classList.remove('active'));
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }

    // Network Data
    const validNetworks = {
        bnb: { name: 'BNB Chain', icon: '/assets/images/bnb-bnb-logo.png' },
        ethereum: { name: 'Ethereum', icon: '/assets/images/ethereum-eth-logo.png' },
        base: { name: 'Base', icon: '/assets/images/base-logo.png' },
        monad: { name: 'Monad', icon: 'https://placehold.co/32x32/800080/ffffff?text=M' }
    };

    const selected = validNetworks[network];
    if (!selected) return;

    // Update Header Display
    const networkNameEl = document.querySelector('.network-selected .network-name');
    const networkIconEl = document.querySelector('.network-selected .network-icon');

    if (networkNameEl) networkNameEl.textContent = selected.name;
    if (networkIconEl) networkIconEl.src = selected.icon;

    // Close modal if it's open (backward compatibility)
    closeNetworkModal();
}

// Inject all modals
function injectModals() {
    const modalsContainer = document.getElementById('modals-placeholder') || document.body;
    const modalsHTML = `
        ${createConnectModal()}
        ${createManageModal()}
        ${createNetworkModal()}
    `;

    if (document.getElementById('modals-placeholder')) {
        document.getElementById('modals-placeholder').innerHTML = modalsHTML;
    } else {
        const div = document.createElement('div');
        div.id = 'modals-container';
        div.innerHTML = modalsHTML;
        document.body.appendChild(div);
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });
    });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    injectModals();
    setTimeout(initWallet, 50); // Minimal delay — must run before page code checks wallet state
});
