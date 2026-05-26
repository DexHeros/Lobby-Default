/**
 * generate-model.js  v7
 *
 * Sequential per-view generation flow:
 *  - Front generated first (text-only or from uploaded image as reference)
 *  - User approves Front → Left generated using approved Front as reference
 *  - User approves Left  → Right generated using approved Front as reference
 *  - User approves Right → Back  generated using approved Front as reference
 *  - After all 4 approved → "Generate 3D Model" calls Tripo multiview_to_model
 *
 * Both "Text to Img" and "Img to 3D" tabs use this same sequential approval UI.
 */

const blockchain = new DexHeroBlockchain();
window.DexHeroBlockchain = blockchain; // Make it global for modals.js sync

document.addEventListener('DOMContentLoaded', async () => {
    
    //  Shared UI DOM 
    const statusBox            = document.getElementById('status-box');
    const statusText           = document.getElementById('status-text');
    const statusLoader         = document.getElementById('status-loader');
    const modelViewerContainer = document.getElementById('model-viewer-container');
    const modelViewer          = document.getElementById('final-model-viewer');
    const btnProceed           = document.getElementById('btn-proceed');
    const btnGenerateText      = document.getElementById('btn-generate-text');

    const img3dUploadStep = document.getElementById('img3d-upload-step');
    const img3dSeqStep    = document.getElementById('img3d-seq-step');

    const seqStepNum      = document.getElementById('seq-step-num');
    const seqStepName     = document.getElementById('seq-step-name');
    const seqViewZone     = document.getElementById('seq-view-zone');
    const seqViewLabel    = document.getElementById('seq-view-label');
    const seqLoading      = document.getElementById('seq-loading');
    const seqLoadingText  = document.getElementById('seq-loading-text');
    const seqPreview      = document.getElementById('seq-preview');
    const seqImg          = document.getElementById('seq-img');
    const seqActionBtns   = document.getElementById('seq-action-btns');
    const btnRetryView    = document.getElementById('btn-retry-view');
    const btnApproveView  = document.getElementById('btn-approve-view');
    const seqFinalContainer = document.getElementById('seq-final-container');
    const btnFinalGenerate  = document.getElementById('btn-final-generate');
    const btnSeqStartOver   = document.getElementById('btn-seq-start-over');
    const btnSeqCancel      = document.getElementById('btn-seq-cancel');

    // Constants & State
    const VIEW_ORDER = ['front', 'left', 'back', 'right'];
    const VIEW_LABELS = { front: 'Front', left: 'Left', right: 'Right', back: 'Back' };

    let pollInterval      = null;
    let generatedModelUrl = null;
    let seqState = {
        mode: null, prompt: '', sourceBase64: null, currentIndex: 0,
        approvedImages: {}, approvedBase64: {}, generating: false,
        // Per-view background-upload state. Each entry holds a Promise that
        // resolves to the Supabase URL once the upload completes (null if
        // upload errored). startTripoFromImages awaits these before sending,
        // so by the time the 4th approve fires the heavy data is already on
        // our server and the start-from-images request body is ~600 bytes
        // of URLs instead of 1-3 MB of base64. Closes the body-upload
        // window where an instant browser-close could lose work.
        viewUploadPromises: {},
    };

    function uploadViewInBackground(view, file) {
        const wallet = blockchain.userAddress;
        if (!wallet) return Promise.resolve(null); // wallet may be set later — fall back to base64
        const fd = new FormData();
        fd.append('file', file);
        fd.append('view', view);
        fd.append('wallet', wallet);
        // No keepalive here: PNGs are 100-500KB, over the 64KB keepalive cap.
        // These uploads run during normal approval (not at close), so regular
        // fetch is fine — if a view's upload doesn't finish, startTripoFromImages
        // falls back to that view's base64.
        return fetch('/api/uploads/view-image', { method: 'POST', body: fd })
            .then(async (r) => {
                if (!r.ok) { console.warn(`[view-upload] ${view} HTTP ${r.status}`); return null; }
                const j = await r.json().catch(() => null);
                if (!j?.url) { console.warn(`[view-upload] ${view} no url in response`); return null; }
                console.log(`[view-upload] ${view} → ${j.url}`);
                return j.url;
            })
            .catch((err) => { console.warn(`[view-upload] ${view} failed:`, err.message); return null; });
    }

    //  Wallet sync (NO session restore — fresh page every time)
    //
    // Wipe any non-wallet sessionStorage from a previous flow. Past models
    // live server-side and surface only through the profile draft list,
    // never silently into this page.
    try {
        sessionStorage.removeItem('dexhero_generated_model');
        sessionStorage.removeItem('dexhero_pending_model_url');
        sessionStorage.removeItem('dexhero_launch_type');
        sessionStorage.removeItem('pass_verified_addr');
    } catch (_) {}

    const urlParams = new URLSearchParams(window.location.search);
    const presetLaunchType = urlParams.get('launchType') || null;

    if (sessionStorage.getItem('walletConnected') === 'true') {
        blockchain.userAddress = sessionStorage.getItem('walletAddress');
        console.log(' Loaded wallet from session:', blockchain.userAddress);
    }

    window.addEventListener('walletAccountChanged', (e) => {
        if (e.detail && e.detail.address) {
            blockchain.userAddress = e.detail.address;
            console.log('Wallet connected via modal:', blockchain.userAddress);
            updateButtonTexts();
        }
    });

    function updateButtonTexts() {
        const isConnected = !!blockchain.userAddress;
        document.getElementById('btn-start-text-generation').textContent = isConnected ? 'Start Generation' : 'Connect Wallet';
        const btnGenFromImg = document.getElementById('btn-generate-from-image');
        if (btnGenFromImg) btnGenFromImg.textContent = isConnected ? 'Generate 4 Views' : 'Connect Wallet';
        const btnFinalGen = document.getElementById('btn-final-generate');
        if (btnFinalGen) btnFinalGen.textContent = isConnected ? 'Generate 3D Model' : 'Connect Wallet';
        if (btnGenerateText) btnGenerateText.textContent = isConnected ? 'Generate 3D Model' : 'Connect Wallet';
    }
    updateButtonTexts();

    async function ensureWallet() {
        if (blockchain.userAddress) return true;
        console.log(' No wallet connected, opening modal...');
        if (typeof openConnectModal === 'function') {
            openConnectModal();
        } else {
            alert('Please connect your wallet to continue.');
        }
        return false;
    }

    //  Tabs 
    function switchTab(id) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === id));
    }
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    //  Core Logic
    async function showFinalModel(url) {
        generatedModelUrl = url;
        if (img3dUploadStep) img3dUploadStep.style.display = 'none';
        if (img3dSeqStep)    img3dSeqStep.style.display    = 'none';
        statusBox.classList.remove('visible');
        if (btnGenerateText) { btnGenerateText.disabled = false; updateButtonTexts(); }

        // Resolve the front-view Supabase URL that was uploaded in the
        // background during the approve flow. By the time Tripo finishes,
        // this promise has almost always resolved — we await with a tiny
        // ceiling so a slow upload doesn't strand the navigation. Without
        // this, create-dexhero.html opens with no front-view thumbnail in
        // the top-left and the user loses the visual continuity from the
        // 4-view approval flow.
        let frontImageUrl = null;
        try {
            const p = seqState?.viewUploadPromises?.front;
            if (p) {
                frontImageUrl = await Promise.race([
                    p,
                    new Promise((res) => setTimeout(() => res(null), 1500)),
                ]);
            }
        } catch (_) { /* non-fatal */ }

        // Hand the generated model off via URL params only — no sessionStorage.
        // A return visit to create-dexhero.html without ?modelUrl=… in the URL
        // is a fresh page; past models are reachable only through the profile
        // draft list.
        const lt = presetLaunchType || 'new';
        const params = new URLSearchParams({ modelUrl: url, launchType: lt });
        if (frontImageUrl) params.set('imageUrl', frontImageUrl);
        window.location.href = `create-dexhero.html?${params.toString()}`;
    }

    // Server-side save of the FINAL completed model only, keyed by wallet.
    // This is what the profile page reads to surface the user's drafts so
    // they can revisit a finished model without paying to regenerate. No
    // partial state, no images, no in-progress Tripo task IDs — just the
    // final URL.
    async function saveCompletedModel(modelUrl) {
        const wallet = blockchain.userAddress;
        if (!wallet || !modelUrl) return;
        try {
            const body = { wallet_address: wallet, model_url: modelUrl };
            // If the server-side worker already created a session row for this
            // generation (via /api/tripo/track), upsert into the SAME row so
            // we don't end up with duplicate drafts.
            if (trackedSessionId) body.id = trackedSessionId;
            await fetch('/api/dexhero/save-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            console.log('Completed model saved to profile drafts');
        } catch (e) { console.error('Failed to save completed model:', e.message); }
    }

    // Session id assigned by /api/tripo/start-from-images (or text-to-3D's
    // /api/tripo/track call). Used by saveCompletedModel to upsert into
    // the same row the server-side worker is updating, so the client and
    // server converge on a single dexhero_sessions row.
    let trackedSessionId = null;

    // Used by the text_to_model flow which uses a different start endpoint.
    async function trackTripoTask(taskId, phase = 'model', originalModelTaskId = null) {
        const wallet = blockchain.userAddress;
        if (!wallet || !taskId) return null;
        try {
            const res = await fetch('/api/tripo/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    wallet_address: wallet,
                    tripo_task_id: taskId,
                    phase,
                    original_model_task_id: originalModelTaskId || taskId,
                }),
            });
            const data = await res.json();
            if (data?.session_id) {
                trackedSessionId = data.session_id;
                console.log(`[Tripo] Registered task ${taskId} with server-side worker. session=${trackedSessionId}`);
            }
            return trackedSessionId;
        } catch (e) {
            console.warn('[Tripo] track call failed (client polling continues):', e.message);
            return null;
        }
    }

    //  Play Pass Gate — generator is restricted to active pass holders
    const PLAY_PASS_ABI_MIN = [
        'function hasActivePlayPass(address wallet) view returns (bool)',
        'function PURCHASE_AMOUNT() view returns (uint256)',
        'function purchase() external',
        'function purchaseWithPermit(uint256 deadline, uint8 v, bytes32 r, bytes32 s) external'
    ];
    const USDC_ABI_MIN = [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
        'function name() view returns (string)',
        'function version() view returns (string)',
        'function nonces(address) view returns (uint256)'
    ];
    const passOverlay = document.getElementById('pass-lock-overlay');
    const btnCheck    = document.getElementById('btn-check-pass');
    const btnBuy      = document.getElementById('btn-buy-pass');
    const statusMsg   = document.getElementById('pass-status-msg');
    const passSpinner = document.getElementById('pass-check-spinner');

    // Renamed to avoid collision with the Tripo-generation `setStatus` further
    // down in this file (which toggles the loader inside #status-box).
    function setPassStatus(msg, isErr = false) {
        if (!statusMsg) return;
        statusMsg.textContent = msg || '';
        statusMsg.style.color = isErr ? '#FF2A5F' : 'var(--text-secondary)';
    }
    // UI states for the pass-lock overlay. Exactly one of these is visible at a
    // time; the spinner runs while we read on-chain state so the user never
    // sees a flash of the "Get a Play Pass" button if they already own one.
    function showSpinner() {
        if (btnCheck)    btnCheck.style.display    = 'none';
        if (btnBuy)      btnBuy.style.display      = 'none';
        if (passSpinner) passSpinner.style.display = 'inline-block';
    }
    function showConnect() {
        if (passSpinner) passSpinner.style.display = 'none';
        if (btnBuy)      btnBuy.style.display      = 'none';
        if (btnCheck)    btnCheck.style.display    = 'inline-flex';
    }
    function showBuy() {
        if (passSpinner) passSpinner.style.display = 'none';
        if (btnCheck)    btnCheck.style.display    = 'none';
        if (btnBuy)      btnBuy.style.display      = 'inline-flex';
    }

    // Get the site's currently-connected wallet. When this page is in an
    // iframe (SPA panel), the parent's sessionStorage is the source of truth
    // — the SPA's _stub.js eventually mirrors keys to the iframe but the
    // timing is racy. Peek at parent storage directly (same-origin) so we
    // don't depend on the mirror having run yet.
    function getConnectedAddress() {
        try {
            if (sessionStorage.getItem('walletConnected') === 'true') {
                return (sessionStorage.getItem('walletAddress') || '').toLowerCase() || null;
            }
        } catch {}
        try {
            if (window.top && window.top !== window && window.top.sessionStorage) {
                if (window.top.sessionStorage.getItem('walletConnected') === 'true') {
                    const addr = (window.top.sessionStorage.getItem('walletAddress') || '').toLowerCase();
                    if (addr) {
                        // Mirror parent → iframe so subsequent reads inside the
                        // iframe (getActiveProvider, etc.) see the keys too.
                        try {
                            ['walletConnected', 'walletAddress', 'walletChain', 'walletType', 'dexhero_wallet_base'].forEach((k) => {
                                const v = window.top.sessionStorage.getItem(k);
                                if (v != null) sessionStorage.setItem(k, v);
                            });
                        } catch {}
                        return addr;
                    }
                }
            }
        } catch {}
        return null;
    }

    // Resolve the active EVM provider, peeking at the parent window when the
    // current frame doesn't have one (some mobile in-app browsers only inject
    // window.ethereum into the top frame).
    function resolveEthereum() {
        try {
            if (window.ethereum && typeof window.ethereum.request === 'function') return window.ethereum;
        } catch {}
        try {
            if (window.top && window.top !== window && window.top.ethereum && typeof window.top.ethereum.request === 'function') {
                return window.top.ethereum;
            }
        } catch {}
        return null;
    }

    // Return the provider the user actually connected with (MetaMask, Phantom,
    // or any injected EVM wallet) — NOT a blind reach for window.ethereum, which
    // can point at whichever extension hijacked the global when both are
    // installed.
    function getActiveProvider() {
        // Iframe-aware: when this page is loaded as an SPA panel iframe inside
        // MetaMask's mobile in-app browser, MM only injects window.ethereum
        // into the TOP frame. Walk up to find the provider rather than
        // returning null.
        const candidates = [];
        try { if (window.UnifiedWallet && window.UnifiedWallet.evmWallet) candidates.push(window.UnifiedWallet.evmWallet); } catch {}
        try { if (window.ethereum) candidates.push(window.ethereum); } catch {}
        try {
            if (window.top && window.top !== window) {
                if (window.top.UnifiedWallet && window.top.UnifiedWallet.evmWallet) candidates.push(window.top.UnifiedWallet.evmWallet);
                if (window.top.ethereum) candidates.push(window.top.ethereum);
            }
        } catch {}
        if (!candidates.length) return null;

        const type = sessionStorage.getItem('walletType');
        for (const root of candidates) {
            const list = (root.providers && root.providers.length) ? root.providers : [root];
            if (type === 'phantom')  { const p = list.find(p => p.isPhantom); if (p) return p; }
            if (type === 'metamask') { const p = list.find(p => p.isMetaMask && !p.isPhantom); if (p) return p; }
        }
        return candidates[0];
    }

    // "Get a Play Pass" — single wallet popup. The user signs ONE plain
    // USDC.transfer($100, treasury); the server (using its Deploy Wallet,
    // authorized by the Master Wallet) then calls mintPlayPassByRelay
    // on the user's behalf via /api/play-pass/relay-mint. No permit
    // signature, no chain-switch round-trip beyond the one implicit in
    // the transfer prompt — wallet reads it as a normal "Send 100 USDC".
    async function doPurchasePlayPass() {
        console.log('[play-pass] purchase click');
        const addr = getConnectedAddress();
        if (!addr) { setPassStatus('Connect your wallet first.', true); showConnect(); return; }
        const usdcAddr = (typeof CONTRACT_ADDRESSES !== 'undefined') ? CONTRACT_ADDRESSES.sepolia?.usdc : '';
        if (!usdcAddr) { setPassStatus('Play Pass contract not configured for this network.', true); return; }
        const active = getActiveProvider();
        if (!active) { setPassStatus('No wallet detected. Install MetaMask or Phantom to continue.', true); return; }

        const TREASURY_ADDR = '0x5cb65422ed872b9c37c5e2e35d27c929d6ca90a8';
        const SEPOLIA_HEX   = '0xaa36a7';
        const prevLabel = btnBuy.textContent;
        btnBuy.style.pointerEvents = 'none';
        btnBuy.style.opacity = '0.7';
        try {
            // Switch to Sepolia if needed (USDC contract only exists there).
            const chainIdHex = await active.request({ method: 'eth_chainId' });
            if (chainIdHex.toLowerCase() !== SEPOLIA_HEX) {
                btnBuy.textContent = 'Switching network…';
                try {
                    await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_HEX }] });
                } catch (swErr) {
                    if (swErr && swErr.code === 4902) {
                        await active.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: SEPOLIA_HEX, chainName: 'Sepolia',
                                rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
                                nativeCurrency: { name: 'SepoliaETH', symbol: 'ETH', decimals: 18 },
                                blockExplorerUrls: ['https://sepolia.etherscan.io'],
                            }],
                        });
                    } else { throw swErr; }
                }
            }

            const provider = new window.ethers.providers.Web3Provider(active);
            const signer = provider.getSigner();
            const usdc = new window.ethers.Contract(
                usdcAddr,
                ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'],
                signer,
            );
            const amount = window.ethers.utils.parseUnits('100', 6);
            const signerAddr = await signer.getAddress();

            // Read-only pre-flight: gas + USDC balance.
            try {
                const [ethBal, usdcBal] = await Promise.all([
                    provider.getBalance(signerAddr),
                    usdc.balanceOf(signerAddr),
                ]);
                console.log(`[play-pass] balances — ETH: ${window.ethers.utils.formatEther(ethBal)} · USDC: ${window.ethers.utils.formatUnits(usdcBal, 6)}`);
                if (ethBal.lt(window.ethers.utils.parseUnits('0.001', 18))) {
                    setPassStatus('Low Gas Error', true);
                    btnBuy.textContent = prevLabel; btnBuy.style.pointerEvents = ''; btnBuy.style.opacity = ''; return;
                }
                if (usdcBal.lt(amount)) {
                    setPassStatus('Need 100 USDC.', true);
                    btnBuy.textContent = prevLabel; btnBuy.style.pointerEvents = ''; btnBuy.style.opacity = ''; return;
                }
            } catch (preErr) {
                console.warn('[play-pass] pre-flight failed:', preErr?.message || preErr);
            }

            // The one and only wallet popup — plain USDC transfer.
            btnBuy.textContent = 'Confirm transfer…';
            setPassStatus('Confirm the $100 transfer in your wallet…');
            const tx = await usdc.transfer(TREASURY_ADDR, amount);
            console.log('[play-pass] transfer tx:', tx.hash);
            btnBuy.textContent = 'Sending…';
            setPassStatus('Transfer sent — waiting for confirmation…');
            await tx.wait();

            // Hand the tx hash to the server; it verifies the Transfer event
            // and mints the pass to the sender. Server pays the mint gas.
            btnBuy.textContent = 'Activating…';
            setPassStatus('Activating your Play Pass…');
            const r = await fetch('/api/play-pass/relay-mint', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ txHash: tx.hash, wallet: signerAddr }),
                credentials: 'include',
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data?.error || 'Mint relay failed');
            console.log('[play-pass] minted via relay:', data);

            unlock(signerAddr.toLowerCase());
        } catch (err) {
            console.error('[play-pass] purchase failed:', err);
            const rawMsg = err?.reason || err?.data?.message || err?.error?.message || err?.message || '';
            if (/pass already active|alreadyActive/i.test(rawMsg)) {
                try {
                    const addrForUnlock = getConnectedAddress();
                    if (addrForUnlock) { unlock(addrForUnlock); return; }
                } catch {}
            }
            setPassStatus(rawMsg || 'Purchase failed.', true);
            btnBuy.textContent = prevLabel;
            btnBuy.style.pointerEvents = '';
            btnBuy.style.opacity = '';
        }
    }
    // Expose for the inline onclick on the button in generate-model.html so the
    // handler works even if the addEventListener race somehow misfires.
    window.dexheroBuyPlayPass = doPurchasePlayPass;
    btnBuy?.addEventListener('click', (e) => {
        e.preventDefault();
        doPurchasePlayPass();
    });

    async function verifyPassFor(address) {
        if (typeof window.ethers === 'undefined') return false;
        const passAddr = (typeof CONTRACT_ADDRESSES !== 'undefined') ? CONTRACT_ADDRESSES.sepolia?.platformPlayPass : '';
        if (!passAddr) { setPassStatus('Play Pass contract not yet deployed.', true); return false; }
        // Read-only check via Sepolia. Try multiple public RPCs — publicnode
        // intermittently rate-limits browser callers, which used to silently
        // turn this into "no pass" for users who own one. Fall through to
        // the next endpoint on any error, only fail if every RPC errors.
        const rpcs = [
            'https://ethereum-sepolia-rpc.publicnode.com',
            'https://eth-sepolia.public.blastapi.io',
            'https://endpoints.omniatech.io/v1/eth/sepolia/public',
            'https://rpc.sepolia.org',
        ];
        let lastErr = null;
        for (const rpc of rpcs) {
            try {
                const provider = new window.ethers.providers.JsonRpcProvider(rpc);
                const contract = new window.ethers.Contract(passAddr, PLAY_PASS_ABI_MIN, provider);
                const has = await contract.hasActivePlayPass(address);
                console.log(`[play-pass] verify ${address} via ${rpc} → ${has}`);
                return has;
            } catch (err) {
                lastErr = err;
                console.warn(`[play-pass] rpc ${rpc} failed: ${err?.message || err}`);
            }
        }
        throw lastErr || new Error('All Sepolia RPCs failed');
    }

    function unlock(address) {
        passOverlay.classList.add('hidden');
        setPassStatus('');
    }

    // Click "Connect Wallet" — on mobile inside a wallet's in-app browser
    // (window.ethereum injected), call eth_requestAccounts directly on the
    // injected provider. The modal flow has multiple async hops (EIP-6963
    // discovery + wallet_requestPermissions w/ fallback) that race or fail
    // intermittently in mobile in-app browsers; a single eth_requestAccounts
    // call is the most reliable connect path there. On desktop, fall back
    // to the modal so the user can pick between extensions.
    btnCheck?.addEventListener('click', async () => {
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
        // Use resolveEthereum() so we find the wallet even when MetaMask
        // (or another in-app browser) only injects window.ethereum into the
        // TOP frame, not into the panel iframe this page is loaded in.
        const eth = resolveEthereum();
        if (isMobile && eth) {
            try {
                setPassStatus('Connecting…');
                const accounts = await eth.request({ method: 'eth_requestAccounts' });
                if (Array.isArray(accounts) && accounts.length && accounts[0]) {
                    const addr = String(accounts[0]).toLowerCase();
                    const t = eth.isPhantom ? 'phantom'
                            : eth.isMetaMask ? 'metamask'
                            : eth.isCoinbaseWallet ? 'coinbase'
                            : 'evm';
                    // Write to BOTH iframe and parent so every consumer sees it
                    // — the parent shell's wallet state and the iframe's gate
                    // both need the keys.
                    const writeKeys = (storage) => {
                        try {
                            storage.setItem('walletConnected', 'true');
                            storage.setItem('walletAddress', addr);
                            storage.setItem('walletChain', 'evm');
                            storage.setItem('walletType', t);
                            storage.setItem('dexhero_wallet_base', JSON.stringify({ chain: 'evm', address: addr }));
                        } catch {}
                    };
                    writeKeys(sessionStorage);
                    try {
                        if (window.top && window.top !== window && window.top.sessionStorage) {
                            writeKeys(window.top.sessionStorage);
                        }
                    } catch {}
                    try { blockchain.userAddress = addr; } catch {}
                    try {
                        if (window.UnifiedWallet) {
                            window.UnifiedWallet.evmAddress = addr;
                            window.UnifiedWallet.connectedAddress = addr;
                            window.UnifiedWallet.evmWallet = eth;
                        }
                    } catch {}
                    // Dispatch in BOTH windows so any listener (iframe's
                    // verifyAndUnlock, parent's _stub.js sync, header.js
                    // updates) gets the event.
                    const detail = { connected: true, address: addr };
                    try { window.dispatchEvent(new CustomEvent('walletChanged', { detail })); } catch {}
                    try { window.dispatchEvent(new CustomEvent('walletAccountChanged', { detail: { address: addr } })); } catch {}
                    try { window.top?.dispatchEvent(new CustomEvent('walletChanged', { detail })); } catch {}
                    try { window.top?.dispatchEvent(new CustomEvent('walletAccountChanged', { detail: { address: addr } })); } catch {}
                    verifyAndUnlock();
                    return;
                }
            } catch (err) {
                if (err && err.code === 4001) {
                    setPassStatus('Connection cancelled.', true);
                    return;
                }
                console.warn('[play-pass] mobile direct connect failed, falling back to modal:', err?.message || err);
            }
        }
        // Desktop / no injected provider / direct path failed → modal
        try {
            if (window.top && window.top !== window && typeof window.top.openConnectModal === 'function') {
                window.top.openConnectModal();
                return;
            }
        } catch {}
        if (typeof openConnectModal === 'function') {
            openConnectModal();
        } else if (typeof window.openConnectModal === 'function') {
            window.openConnectModal();
        } else {
            setPassStatus('Wallet modal unavailable. Refresh and try again.', true);
        }
    });

    // Last-resort silent reconnect (MOBILE ONLY): when sessionStorage says
    // "not connected" but the user is on mobile inside a wallet's in-app
    // browser, probe eth_accounts. If the dapp is authorized, it returns the
    // address with no popup. Desktop skips this so the user is required to
    // click Connect explicitly.
    async function silentEthAccountsRehydrate() {
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
        if (!isMobile) return null;
        const eth = resolveEthereum();
        if (!eth) return null;
        try {
            const accounts = await eth.request({ method: 'eth_accounts' });
            if (!Array.isArray(accounts) || !accounts.length || !accounts[0]) return null;
            const addr = String(accounts[0]).toLowerCase();
            const t = eth.isPhantom ? 'phantom'
                    : eth.isMetaMask ? 'metamask'
                    : eth.isCoinbaseWallet ? 'coinbase'
                    : 'evm';
            try {
                sessionStorage.setItem('walletConnected', 'true');
                sessionStorage.setItem('walletAddress', addr);
                sessionStorage.setItem('walletChain', 'evm');
                sessionStorage.setItem('walletType', t);
            } catch {}
            try { blockchain.userAddress = addr; } catch {}
            try {
                if (window.UnifiedWallet) {
                    window.UnifiedWallet.evmAddress = addr;
                    window.UnifiedWallet.connectedAddress = addr;
                    window.UnifiedWallet.evmWallet = eth;
                }
            } catch {}
            return addr;
        } catch {
            return null;
        }
    }

    // One verify-and-unlock entry point, triggered from both initial bootstrap
    // and from wallet events (walletChanged from modals.js/wallet.js,
    // walletAccountChanged from unified-wallet.js).
    async function verifyAndUnlock() {
        let currentAddr = getConnectedAddress();
        if (!currentAddr) {
            currentAddr = await silentEthAccountsRehydrate();
        }
        if (!currentAddr) { showConnect(); setPassStatus(''); return; }

        // Show the spinner and hide both CTAs until we know the on-chain answer,
        // so a wallet that already owns a pass never sees the "Get a Play Pass"
        // button flash before the overlay unlocks.
        showSpinner();
        setPassStatus('Checking for a Play Pass on this wallet…');
        try {
            const hasPass = await verifyPassFor(currentAddr);
            if (hasPass) {
                unlock(currentAddr);
            } else {
                showBuy();
                setPassStatus('No active Play Pass on this wallet.', true);
            }
        } catch (err) {
            showBuy();
            setPassStatus(err?.reason || err?.message || 'Unable to verify Play Pass.', true);
        }
    }

    window.addEventListener('walletChanged', verifyAndUnlock);
    window.addEventListener('walletAccountChanged', verifyAndUnlock);
    // Fired by the SPA panel-stub once the parent shell's wallet
    // sessionStorage has been mirrored into this iframe. Without it, a
    // page that booted before storage landed never re-checks and stays
    // stuck on "Connect Wallet" even when the parent is connected.
    window.addEventListener('parentWalletSynced', verifyAndUnlock);
    verifyAndUnlock();

    //  Thumbnail strip helpers 
    function setThumbImage(view, base64) {
        const img   = document.getElementById(`thumb-img-${view}`);
        const check = document.getElementById(`thumb-check-${view}`);
        const zone  = document.getElementById(`thumb-${view}`);
        if (img)   { img.src = `data:image/png;base64,${base64}`; img.classList.add('visible'); }
        if (check) check.classList.add('visible');
        if (zone)  zone.classList.add('approved');
    }

    function resetThumbs() {
        VIEW_ORDER.forEach(v => {
            const img   = document.getElementById(`thumb-img-${v}`);
            const check = document.getElementById(`thumb-check-${v}`);
            const zone  = document.getElementById(`thumb-${v}`);
            if (img)   { img.src = ''; img.classList.remove('visible'); }
            if (check) check.classList.remove('visible');
            if (zone)  zone.classList.remove('approved');
        });
    }

    function setSeqViewCard(view) {
        if (seqStepNum)  seqStepNum.textContent  = (VIEW_ORDER.indexOf(view) + 1).toString();
        if (seqStepName) seqStepName.textContent = `Generating ${view.charAt(0).toUpperCase() + view.slice(1)} View...`;
        if (seqPreview)  seqPreview.classList.remove('visible');
        if (seqLoading)  seqLoading.classList.add('visible');
        if (seqActionBtns) seqActionBtns.style.display = 'none';
    }

    function showSeqResult(base64) {
        if (seqImg) seqImg.src = `data:image/png;base64,${base64}`;
        if (seqLoading) seqLoading.classList.remove('visible');
        if (seqPreview) seqPreview.classList.add('visible');
        if (seqActionBtns) seqActionBtns.style.display = 'flex';
    }

    // 
    //  CORE: generate a single view via Gemini
    // 
    async function generateView(view, prompt, referenceBase64) {
        const body = { prompt, target_view: view };
        if (referenceBase64) body.reference_image = referenceBase64;

        const res  = await fetch('/api/gemini/generate-reference-view', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || `Failed to generate ${view} view`);
        return data.data.image_data; // raw base64
    }

    //  Start the sequential flow 
    async function startSequentialFlow() {
        seqState.currentIndex  = 0;
        seqState.approvedImages = {};
        seqState.approvedBase64 = {};
        seqState.generating     = false;
        resetThumbs();

        if (img3dSeqStep)    img3dSeqStep.style.display   = '';
        if (img3dUploadStep) img3dUploadStep.style.display = 'none';
        if (seqFinalContainer) seqFinalContainer.style.display = 'none';
        if (seqActionBtns)   seqActionBtns.style.display  = 'none';

        await generateCurrentView();
    }

    async function generateCurrentView() {
        if (!await ensureWallet()) return;
        if (seqState.generating) return;
        seqState.generating = true;
        
        // Immediate Anti-Spam: Disable buttons synchronously
        if (btnRetryView)   btnRetryView.disabled   = true;
        if (btnApproveView) btnApproveView.disabled = true;

        const view = VIEW_ORDER[seqState.currentIndex];
        setSeqViewCard(view);

        try {
            let refBase64 = null;

            if (view === 'front') {
                // Front: use uploaded image as reference (image mode) OR text-only (text mode)
                refBase64 = seqState.mode === 'image' ? seqState.sourceBase64 : null;
            } else {
                // Left / Right / Back: always use approved FRONT as reference
                refBase64 = seqState.approvedBase64['front'] || null;
            }

            const prompt = seqState.prompt || 'character';
            const b64    = await generateView(view, prompt, refBase64);

            showSeqResult(b64);
            // store as pending (not yet approved)
            seqState._pendingBase64 = b64;

        } catch (err) {
            seqLoading?.classList.remove('visible');
            if (seqActionBtns) seqActionBtns.style.display = '';
            // Friendly-up the message: strip server-side prefixes so users
            // see only the actionable reason, and translate the safety /
            // copyright / no-image tokens into prose. Anything we don't
            // recognise passes through verbatim so users can copy-paste a
            // specific upstream error to support.
            let msg = err.message || 'Unknown error';
            if (msg.startsWith('GEMINI_UPSTREAM: ')) msg = msg.slice('GEMINI_UPSTREAM: '.length);
            if (msg.startsWith('GEMINI_NO_IMAGE: ')) {
                const detail = msg.slice('GEMINI_NO_IMAGE: '.length);
                msg = `Gemini refused to generate this image. Reason: ${detail}. Try a simpler prompt or a different reference image (e.g. a cleaner cartoon-style character).`;
            }
            if (msg === 'SAFETY_FILTER_BLOCK')        msg = 'Gemini blocked this image for safety reasons. Try a different reference image or prompt.';
            if (msg === 'COPYRIGHT_CONTENT_DETECTED') msg = 'Gemini detected copyrighted content. Try a different reference image or prompt.';
            alert(`Generation error for ${view}: ${msg}`);
        } finally {
            seqState.generating     = false;
            if (btnRetryView)   btnRetryView.disabled   = false;
            if (btnApproveView) btnApproveView.disabled = false;
        }
    }

    //  Retry current view 
    btnRetryView?.addEventListener('click', () => {
        if (seqState.generating) return;
        generateCurrentView();
    });

    //  Approve current view, move to next 
    btnApproveView?.addEventListener('click', async () => {
        if (seqState.generating) return;
        const view = VIEW_ORDER[seqState.currentIndex];
        const b64  = seqState._pendingBase64;
        if (!b64) return;

        // 1. Store approved data synchronously for instant local use
        const blob = base64ToBlob(b64, 'image/png');
        const file = new File([blob], `${view}.png`, { type: 'image/png' });
        seqState.approvedImages[view] = file;
        seqState.approvedBase64[view] = b64;
        setThumbImage(view, b64);

        // 1b. Fire-and-forget: upload this view to our Supabase NOW, in the
        // background, while the user continues approving other views. By the
        // time they hit the 4th approve, three views are typically already
        // uploaded and the start-from-images request becomes a tiny URL-only
        // payload. seqState.viewUploadPromises[view] resolves to a URL or null.
        seqState.viewUploadPromises[view] = uploadViewInBackground(view, file);

        // 2. OPTIMISTIC UI: Advance index and start next step instantly
        seqState.currentIndex++;

        if (seqState.currentIndex < VIEW_ORDER.length) {
            // Start next generation without awaiting previous persistence
            generateCurrentView().catch(err => {
                console.error('Optimistic generation failed:', err);
                seqState.generating = false;
                if (btnApproveView) btnApproveView.disabled = false;
            });
        } else {
            // All 4 approved — auto-start the entire Tripo generation flow
            // server-side. No second click required. The seqFinalContainer
            // (Generate 3D Model button) stays in the DOM as a retry path
            // if the auto-start fails.
            seqLoading?.classList.remove('visible');
            seqPreview?.classList.add('visible'); // keep last image showing
            if (seqActionBtns)     seqActionBtns.style.display     = 'none';
            if (seqFinalContainer) seqFinalContainer.style.display  = '';
            if (btnSeqCancel)      btnSeqCancel.style.display       = 'none';
            if (seqStepName) seqStepName.textContent = 'All views approved!';
            if (seqStepNum)  seqStepNum.textContent  = '4';

            // Auto-trigger generation — the user already opted in by
            // approving the 4th view.
            if (await ensureWallet()) {
                startTripoFromImages(seqState.approvedImages);
            }
        }
    });

    //  Final: send approved images to Tripo 
    btnFinalGenerate?.addEventListener('click', async () => {
        if (!await ensureWallet()) return;
        await startTripoFromImages(seqState.approvedImages);
    });

    //  Start over 
    function resetToUploadStep() {
        if (img3dSeqStep)    img3dSeqStep.style.display   = 'none';
        if (img3dUploadStep) img3dUploadStep.style.display = '';
        seqState = { ...seqState, currentIndex: 0, approvedImages: {}, approvedBase64: {}, generating: false };
        updateButtonTexts();
    }
    btnSeqStartOver?.addEventListener('click', resetToUploadStep);
    btnSeqCancel?.addEventListener('click', resetToUploadStep);

    // 
    //  TAB: IMG TO 3D — front upload → sequential flow
    // 
    const zoneFront   = document.getElementById('zone-front');
    const fileFront   = document.getElementById('file-front');
    const removeFront = document.getElementById('remove-front');
    const btnGenFromImage = document.getElementById('btn-generate-from-image');

    let frontUploadedBase64 = null;

    function initFrontZone() {
        if (!zoneFront || !fileFront) return;
        zoneFront.addEventListener('click', e => {
            if (e.target === removeFront || removeFront?.contains(e.target)) return;
            fileFront.click();
        });
        zoneFront.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileFront.click(); } });
        fileFront.addEventListener('change', () => { if (fileFront.files[0]) handleFrontFile(fileFront.files[0]); fileFront.value = ''; });
        zoneFront.addEventListener('dragover', e => { e.preventDefault(); zoneFront.classList.add('drag-over'); });
        zoneFront.addEventListener('dragleave', e => { if (!zoneFront.contains(e.relatedTarget)) zoneFront.classList.remove('drag-over'); });
        zoneFront.addEventListener('drop', e => {
            e.preventDefault(); zoneFront.classList.remove('drag-over');
            const f = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'));
            if (f) handleFrontFile(f);
        });
        removeFront?.addEventListener('click', e => { e.stopPropagation(); clearFrontZone(); });
    }

    // Convert any browser-decodable image (PNG/JPG/WebP/HEIC/AVIF/GIF/etc.)
    // to JPEG via canvas. Gemini's image API rejects formats it can't decode
    // (HEIC from iPhone, AVIF from Chrome) — going through canvas standardizes
    // every upload to a payload Gemini accepts. Also caps the long edge at
    // 1280 px so a 12 MP HEIC isn't shipped as a 16 MB base64 — keeps body
    // under the 10 MB server limit and the Gemini call fast.
    async function normalizeToJpegBase64(file) {
        const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload  = () => resolve(r.result);
            r.onerror = () => reject(new Error('FileReader failed'));
            r.readAsDataURL(file);
        });
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload  = () => resolve(i);
            i.onerror = () => reject(new Error('Browser cannot decode this image. Try PNG or JPEG.'));
            i.src = dataUrl;
        });
        const MAX = 1280;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';      // flatten transparency to white — anti-cheat for HEIC alpha quirks
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        // toDataURL is sync + universally supported. 0.9 quality keeps detail without bloating.
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        return { jpegDataUrl, base64: jpegDataUrl.split(',')[1] };
    }

    async function handleFrontFile(file) {
        if (!file.type.startsWith('image/')) { alert('Please upload an image file.'); return; }
        if (file.size > 10 * 1024 * 1024) { alert('Max 10MB'); return; }
        try {
            const { jpegDataUrl, base64 } = await normalizeToJpegBase64(file);
            frontUploadedBase64 = base64;

            // Show image in zone
            document.getElementById('placeholder-front').style.display = 'none';
            const preview = document.getElementById('preview-front');
            preview.classList.add('visible');
            document.getElementById('prev-img-front').src = jpegDataUrl;
            removeFront?.classList.add('visible');
            if (btnGenFromImage) { btnGenFromImage.disabled = false; updateButtonTexts(); }
        } catch (err) {
            alert(err?.message || 'Could not read this image — try a PNG or JPEG.');
        }
    }

    function clearFrontZone() {
        frontUploadedBase64 = null;
        document.getElementById('placeholder-front').style.display = '';
        document.getElementById('preview-front').classList.remove('visible');
        document.getElementById('prev-img-front').src = '';
        removeFront?.classList.remove('visible');
        if (btnGenFromImage) { btnGenFromImage.disabled = true; updateButtonTexts(); }
    }

    btnGenFromImage?.addEventListener('click', async () => {
        if (!frontUploadedBase64) return;
        if (!await ensureWallet()) return;
        seqState.mode        = 'image';
        seqState.prompt      = '';
        seqState.sourceBase64 = frontUploadedBase64;
        startSequentialFlow();
    });

    initFrontZone();

    // 
    //  TAB: TEXT TO IMG — text → sequential flow (uses progress grid first)
    // 
    const btnStartTextGen   = document.getElementById('btn-start-text-generation');
    const geminiPromptInput = document.getElementById('gemini-prompt-input');

    btnStartTextGen?.addEventListener('click', async () => {
        const prompt = (geminiPromptInput?.value || '').trim();
        if (prompt.length < 10) { alert('Please enter at least 10 characters.'); return; }

        if (!await ensureWallet()) return;

        // Switch to Img to 3D tab and run the sequential flow
        seqState.mode        = 'text';
        seqState.prompt      = prompt;
        seqState.sourceBase64 = null;
        switchTab('img-to-3d');
        startSequentialFlow();
    });

    //  TAB 3: Direct Text to 3D 
    btnGenerateText?.addEventListener('click', async () => {
        const prompt = (document.getElementById('text-prompt-input')?.value || '').trim();
        if (prompt.length < 10) { alert('Please enter at least 10 characters.'); return; }

        if (!await ensureWallet()) return;

        // Direct Tripo text-to-model
        setStatus('Step 1: Generating 3D model from text...');
        if (btnGenerateText) btnGenerateText.disabled = true;

        try {
            const taskRes = await fetch('/api/tripo/proxy', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    endpoint: '/task', 
                    method: 'POST', 
                    body: { type: 'text_to_model', prompt: prompt } 
                })
            });

            const td = await taskRes.json();
            if (!taskRes.ok) throw new Error(td.error || 'Tripo task start failed');

            // Register with the server-side worker so completion survives
            // client disconnects, then start client-side polling for live UI.
            trackTripoTask(td.data.task_id, 'model', td.data.task_id);
            pollTripoTask(td.data.task_id, 'model', td.data.task_id);
        } catch (err) {
            clearStatus();
            if (btnGenerateText) { btnGenerateText.disabled = false; updateButtonTexts(); }
        }
    });

    //
    //  TRIPO: upload images → multiview_to_model → rig → animate
    // 
    async function startTripoFromImages(imageMap) {
        hideModelOutput(); setStatus('Starting 3D generation…');
        if (btnFinalGenerate)  btnFinalGenerate.disabled  = true;
        if (btnSeqStartOver)   btnSeqStartOver.disabled   = true;
        if (img3dSeqStep)    img3dSeqStep.style.display    = 'none';
        if (img3dUploadStep) img3dUploadStep.style.display = 'none';

        const wallet = blockchain.userAddress;
        if (!wallet) {
            clearStatus();
            if (btnFinalGenerate) btnFinalGenerate.disabled = false;
            if (btnSeqStartOver)  btnSeqStartOver.disabled  = false;
            if (img3dSeqStep) img3dSeqStep.style.display = '';
            alert('Please connect your wallet first.');
            return;
        }

        // Build the image map. Prefer Supabase URLs (uploaded in the background
        // during approval) so the request body is ~600 bytes instead of 1-3 MB.
        // Fall back to base64 if a view's background upload failed or hasn't
        // resolved yet (rare — uploads are usually faster than the user's
        // approval cadence).
        const uploadResults = await Promise.all(VIEW_ORDER.map(v =>
            (seqState.viewUploadPromises?.[v] || Promise.resolve(null))
        ));
        const images = {};
        for (let i = 0; i < VIEW_ORDER.length; i++) {
            const view = VIEW_ORDER[i];
            const url = uploadResults[i];
            if (url) {
                images[view] = url;
            } else {
                const b64 = seqState.approvedBase64?.[view];
                if (!b64) {
                    clearStatus();
                    if (btnFinalGenerate) btnFinalGenerate.disabled = false;
                    if (btnSeqStartOver)  btnSeqStartOver.disabled  = false;
                    if (img3dSeqStep) img3dSeqStep.style.display = '';
                    alert(`Missing approved image for ${view} — please re-generate.`);
                    return;
                }
                images[view] = b64;
            }
        }
        console.log('[Tripo] start-from-images payload sources:',
            VIEW_ORDER.map(v => `${v}=${images[v].startsWith('http') ? 'url' : 'base64'}`).join(' '));

        try {
            // Single server call — uploads all 4 to Tripo, starts the task,
            // creates the dexhero_sessions row, enqueues the poll worker.
            // keepalive: true tells the browser to COMPLETE this request
            // server-side even if the user closes the tab the moment after
            // hitting approve. Without keepalive, the browser aborts in-flight
            // fetches on tab close → request never lands → no row → no draft.
            // Body is ~600 bytes of URLs (when per-view uploads succeeded),
            // well under the 64KB keepalive cap. Falls back to base64 if any
            // view upload errored, which can exceed the cap — but at that
            // point the Promise.all wait already happened in the foreground,
            // so the fetch is in-flight before close anyway.
            const payload = JSON.stringify({ wallet_address: wallet, images });
            const fetchOpts = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
            };
            // Only set keepalive when the payload fits — otherwise the browser
            // rejects the fetch outright. 60KB cushion under the 64KB spec cap.
            if (payload.length < 60 * 1024) fetchOpts.keepalive = true;

            const res = await fetch('/api/tripo/start-from-images', fetchOpts);
            const data = await res.json();
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || `Failed to start generation (${res.status})`);
            }
            console.log('[Tripo] Generation started server-side:', data);
            if (data.session_id) trackedSessionId = data.session_id;

            // Now run the live progress poll for UI feedback. The server
            // worker is also polling — both converge on the same session row.
            setStatus('Generating 3D model…');
            pollTripoTask(data.tripo_task_id, 'model', data.tripo_task_id);
        } catch (err) {
            console.error('[Tripo] start-from-images failed:', err);
            clearStatus();
            if (btnFinalGenerate) btnFinalGenerate.disabled = false;
            if (btnSeqStartOver)  btnSeqStartOver.disabled  = false;
            // Stay on the all-approved state so the user can retry without
            // re-doing approvals — show seqFinalContainer (Generate 3D Model
            // button) as the explicit retry path.
            if (img3dSeqStep) img3dSeqStep.style.display = '';
            if (seqFinalContainer) seqFinalContainer.style.display = '';
            setStatus(`Error: ${err.message}. Tap Generate 3D Model to retry.`, false);
        }
    }

    //  Tripo polling 
    function pollTripoTask(taskId, phase = 'model', originalModelTaskId = null) {
        if (pollInterval) clearInterval(pollInterval);
        let attempts = 0;
        const modelTaskId = originalModelTaskId || taskId;

        pollInterval = setInterval(async () => {
            if (++attempts > 240) { // Increased to 12 mins
                console.error(` Poll Timeout: Phase=${phase} TaskID=${taskId} attempts=${attempts}`);
                clearInterval(pollInterval); clearStatus(); 
                alert(`Tripo generation timed out in ${phase} phase. Please try again.`); 
                return; 
            }
            console.log(` Polling Tripo: Phase=${phase} Status=${statusText.textContent} Attempts=${attempts}`);
            try {
                const res  = await fetch('/api/tripo/proxy', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: `/task/${taskId}`, method: 'GET' })
                });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || `Poll failed (${res.status})`);
                const status = d.data.status;
                const pct    = d.data.progress || 0;
                if (status === 'failed' || status === 'cancelled') {
                    console.error('[Tripo] Task failed, full response:', JSON.stringify(d.data));
                }

                if (status === 'success') {
                    clearInterval(pollInterval);
                    if (phase === 'model') {
                        console.log(' Model phase success. Starting Rig phase...');
                        setStatus('Step 3/4: Auto-rigging...');
                        const rr = await fetch('/api/tripo/proxy', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ endpoint: '/task', method: 'POST',
                                body: { type: 'animate_rig', original_model_task_id: modelTaskId, out_format: 'glb', style: 'walk_in_place' } })
                        });
                        const rd = await rr.json();
                        if (!rr.ok) throw new Error(rd.error || 'Rig task failed to start');
                        console.log(' Rig task started:', rd.data.task_id);
                        pollTripoTask(rd.data.task_id, 'rig', modelTaskId);

                    } else if (phase === 'rig') {
                        console.log(' Rig phase success. Full task data:', JSON.stringify(d.data?.output || d.data?.result || {}));
                        const result = d.data.output || d.data.result || d.data;
                        // pbr_model / model are string URLs directly in Tripo API v2
                        const url    = (typeof result?.pbr_model === 'string' ? result.pbr_model : result?.pbr_model?.url)
                                    || (typeof result?.model === 'string' ? result.model : result?.model?.url)
                                    || result?.glb_url || result?.model_url;
                        console.log('[Tripo] Final model URL:', url);


                        
                        setStatus('Downloading securely...');
                        const dlr = await fetch('/api/tripo/download', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model_url: url })
                        });
                        if (!dlr.ok) throw new Error('Download failed');
                        const dld = await dlr.json();
                        generatedModelUrl = dld.url;
                        
                        setStatus('Finalizing session...');
                        await saveCompletedModel(generatedModelUrl);
                        // Await so the "Finalizing..." spinner stays up
                        // until the navigation actually fires (showFinalModel
                        // is async — it resolves the front-view URL with a
                        // short timeout before navigating).
                        await showFinalModel(generatedModelUrl);
                        clearStatus();
                    }
                } else if (status === 'failed' || status === 'cancelled') {
                    clearInterval(pollInterval); clearStatus();
                    if (btnGenerateText)  btnGenerateText.disabled  = false;
                    if (btnFinalGenerate) btnFinalGenerate.disabled  = false;
                    if (btnSeqStartOver)  btnSeqStartOver.disabled   = false;
                    // Restore the 4-view UI so the user can retry.
                    if (img3dSeqStep) img3dSeqStep.style.display = '';
                    alert('Model generation ' + status + '. Please try again.');
                } else {
                    statusText.textContent = phase === 'animate' ? `Animating... ${pct}%`
                        : phase === 'rig' ? `Rigging... ${pct}%`
                        : `Generating 3D... ${pct}%`;
                }
            } catch (e) { 
                console.error(` Tripo Poll Loop Critical Error:`, e);
                // If it's a structural error in our code or a persistent 500, we should stop
                if (e.message.includes('failed to start') || e.message.includes('Rig task failed')) {
                    clearInterval(pollInterval);
                    clearStatus();
                    alert(`Error starting next Tripo phase: ${e.message}`);
                }
            }
        }, 3000);
    }

    //  Proceed button
    btnProceed?.addEventListener('click', () => {
        if (!generatedModelUrl) return;
        // Hand the generated model off via URL params only — no sessionStorage.
        const lt = presetLaunchType || 'new';
        window.location.href = `create-dexhero.html?modelUrl=${encodeURIComponent(generatedModelUrl)}&launchType=${encodeURIComponent(lt)}`;
    });

    //  Animation Toggle 
    //  Animation Toggle 
    let isAnimationPlaying = true; // Autoplay is on by default now
    window.toggleModelAnimation = function() {
        const btn = document.getElementById('btn-toggle-animation');
        if (!modelViewer || !btn) return;

        if (isAnimationPlaying) {
            modelViewer.pause();
            btn.innerHTML = ' Play Animation';
            isAnimationPlaying = false;
        } else {
            modelViewer.play();
            btn.innerHTML = '⏸ Pause Animation';
            isAnimationPlaying = true;
        }
    };

    const toggleBtn = document.getElementById('btn-toggle-animation');
    if (toggleBtn) {
        modelViewer.addEventListener('load', () => toggleBtn.style.display = 'block');
        toggleBtn.addEventListener('click', window.toggleModelAnimation);
    }

    //  UI helpers 
    function setStatus(msg, loading = true) {
        statusBox.classList.add('visible');
        statusText.textContent = msg;
        statusLoader.style.display = loading ? 'block' : 'none';
        btnProceed.classList.remove('visible');
        modelViewerContainer.classList.remove('visible');
    }
    function clearStatus()     { statusBox.classList.remove('visible'); }
    function hideModelOutput() { btnProceed.classList.remove('visible'); modelViewerContainer.classList.remove('visible'); }

    //  Utility 
    function base64ToBlob(base64, mime = 'image/png') {
        const bytes = atob(base64); const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }
});
