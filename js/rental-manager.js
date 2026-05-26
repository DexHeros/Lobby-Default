/**
 * DexHero Rental Integration
 * Manages character rental flow across model pages
 */

class DexHeroRental {
    constructor() {
        this.blockchain = window.DexHeroBlockchain;
        this.wallet = window.UnifiedWallet;
        this.currentModel = null;
    }

    /**
     * Show rental modal for a model
     */
    async showRentalModal(modelId) {
        try {
            // Load model details from database
            const { data: model, error } = await supabase
                .from('models')
                .select('*, users(username, wallet_address)')
                .eq('id', modelId)
                .single();

            if (error) throw error;

            this.currentModel = model;

            // Check if EVM contract exists
            if (!model.evm_contract_address) {
                alert('This model does not have a rental contract deployed yet.');
                return;
            }

            // Create modal
            const modal = this.createRentalModal(model);
            document.body.appendChild(modal);

            // Load current price
            await this.loadRentalPrice(model);

        } catch (error) {
            console.error('Error loading rental modal:', error);
            alert('Failed to load rental information: ' + error.message);
        }
    }

    /**
     * Create rental modal HTML
     */
    createRentalModal(model) {
        const modalHTML = `
            <div id="rental-modal" class="modal-overlay" onclick="closeRentalModal(event)">
                <div class="modal-content" onclick="event.stopPropagation()" 
                    style="max-width: 500px; background: var(--bg-glass); border: 1px solid var(--border-color); border-radius: 20px; padding: 32px;">
                    
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                        <h2 style="margin: 0;">Rent Character</h2>
                        <button onclick="closeRentalModal()" 
                            style="background: none; border: none; color: white; font-size: 24px; cursor: pointer;">×</button>
                    </div>

                    <!-- Model Preview -->
                    <div style="text-align: center; margin-bottom: 24px;">
                        <img src="${(typeof sanitizeUrl === 'function' ? sanitizeUrl : (u)=>u)(model.thumbnail_url || '/assets/placeholder.png')}"
                            style="width: 100%; max-width: 300px; border-radius: 12px; margin-bottom: 12px;">
                        <h3 style="margin: 0 0 8px 0;">${(typeof escapeHtml === 'function' ? escapeHtml : (s)=>s)(model.name)}</h3>
                        <p style="color: var(--text-muted); font-size: 14px;">by ${(typeof escapeHtml === 'function' ? escapeHtml : (s)=>s)(model.users?.username || 'Unknown')}</p>
                    </div>

                    <!-- Pricing Display -->
                    <div style="text-align: center; padding: 24px; background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(59, 130, 246, 0.1)); border-radius: 15px; margin-bottom: 24px;">
                        <div style="color: rgba(255,255,255,0.7); font-size: 14px; margin-bottom: 8px;">Current Pass Price</div>
                        <div id="rental-price" style="font-size: 36px; font-weight: bold; background: linear-gradient(135deg, #3b82f6, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
                            Loading...
                        </div>
                        <div id="active-renters" style="color: rgba(255,255,255,0.6); font-size: 13px; margin-top: 8px;">
                            -- active players
                        </div>
                    </div>

                    <!-- How It Works -->
                    <div style="background: rgba(59, 130, 246, 0.05); padding: 16px; border-radius: 12px; margin-bottom: 24px;">
                        <h4 style="margin: 0 0 12px 0; font-size: 14px;">How It Works:</h4>
                        <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: rgba(255,255,255,0.7); line-height: 1.8;">
                            <li>Pay USDC to get Pass (deposit is locked)</li>
                            <li>Receive NFT receipt for access</li>
                            <li>Play as the character in UEFN/game</li>
                            <li>Withdraw anytime to get deposit back</li>
                            <li>Price changes based on active players</li>
                        </ul>
                    </div>

                    <!-- Chain Info -->
                    <div style="padding: 12px; background: rgba(59, 130, 246, 0.1); border-radius: 8px; margin-bottom: 24px; font-size: 13px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                            <span style="color: rgba(255,255,255,0.6);">Blockchain:</span>
                            <span id="rental-chain" style="font-weight: 600;">${(typeof escapeHtml === 'function' ? escapeHtml : (s)=>s)(model.blockchain || 'Ethereum')}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: rgba(255,255,255,0.6);">Contract:</span>
                            <span style="font-family: monospace; font-size: 11px;">${(typeof escapeHtml === 'function' ? escapeHtml : (s)=>s)(model.evm_contract_address?.substring(0, 10) + '...' || 'Not deployed')}</span>
                        </div>
                    </div>

                    <!-- Action Buttons -->
                        style="width: 100%; padding: 16px; background: linear-gradient(135deg, #3b82f6, #3b82f6); border: none; border-radius: 12px; color: white; font-size: 16px; font-weight: bold; cursor: pointer; transition: all 0.3s;">
                        Connect Wallet to Rent
                    </button>

                    <p style="font-size: 12px; color: rgba(255,255,255,0.5); text-align: center; margin-top: 12px;">
                        Your USDC deposit will be held until you stop renting
                    </p>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = modalHTML;
        return div.firstElementChild;
    }

    /**
     * Load current rental price and stats
     */
    async loadRentalPrice(model) {
        try {
            // Connect to contract
            this.blockchain.network = model.blockchain || 'sepolia';

            // Get current price
            const price = await this.blockchain.getCurrentPrice();
            const activeCount = await this.blockchain.getActivePositions();

            // Update UI
            document.getElementById('rental-price').textContent = '$' + parseFloat(price).toFixed(2);
            document.getElementById('active-renters').textContent = activeCount + ' active players';

            // Update button
            const btn = document.getElementById('rent-now-btn');
            btn.textContent = `Rent for $${parseFloat(price).toFixed(2)} (3 Day Play Pass)`;
            btn.disabled = false;

        } catch (error) {
            console.error('Error loading rental price:', error);
            document.getElementById('rental-price').textContent = 'Error loading price';
            document.getElementById('active-renters').textContent = 'Please try again';
        }
    }

    /**
     * Execute rental transaction
     */
    async executeRental() {
        try {
            const btn = document.getElementById('rent-now-btn');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            // Connect wallet if needed
            if (!this.wallet.isConnected()) {
                await this.wallet.connectEVM();
            }

            // Execute rental
            const result = await this.blockchain.rentDexHero(this.currentModel.id);

            // Record rental in database
            await supabase.from('rental_history').insert({
                user_wallet: this.wallet.connectedAddress,
                model_id: this.currentModel.id,
                token_id: result.tokenId.toString(),
                blockchain: this.blockchain.network,
                deposit_amount: result.price,
                is_active: true
            });

            // Success!
            alert(`Success! You've rented the character. NFT Token ID: ${result.tokenId}`);
            window.closeRentalModal();

            // Redirect to profile rentals
            window.location.href = '/pages/profile.html?tab=rentals';

        } catch (error) {
            console.error('Rental failed:', error);
            alert('Rental failed: ' + error.message);

            const btn = document.getElementById('rent-now-btn');
            btn.disabled = false;
            btn.textContent = 'Try Again';
        }
    }

    /**
     * Get user's active rentals
     */
    async getUserRentals(walletAddress) {
        try {
            // Get from blockchain
            const rentals = await this.blockchain.getUserRentals();

            // Get additional info from database
            const { data: dbRentals, error } = await supabase
                .from('rental_history')
                .select('*, models(id, name, thumbnail_url, users(username))')
                .eq('user_wallet', walletAddress)
                .eq('is_active', true);

            if (error) throw error;

            // Merge blockchain and database data
            return rentals.map(rental => {
                const dbRental = dbRentals.find(r => r.token_id === rental.tokenId.toString());
                return {
                    ...rental,
                    model: dbRental?.models,
                    startedAt: dbRental?.started_at
                };
            });

        } catch (error) {
            console.error('Error loading rentals:', error);
            return [];
        }
    }

    /**
     * Stop renting (redeem NFT)
     */
    async stopRenting(tokenId) {
        // Fetch rentals to check timestamp
        const rentals = await this.blockchain.getUserRentals();
        const rental = rentals.find(r => r.tokenId.toString() === tokenId.toString());

        if (rental && rental.depositTs > 0) {
            const passDuration = 3 * 24 * 60 * 60; // 3 days
            const now = Math.floor(Date.now() / 1000);
            if (now < rental.depositTs + passDuration) {
                if (!confirm("Early Withdrawal Alert: You are withdrawing before the 3-day pass expires. A 10% penalty fee will be deducted and sent to the protocol treasury. Do you wish to proceed?")) {
                    return;
                }
            } else {
                if (!confirm('Are you sure you want to stop renting? You will get your USDC deposit back.')) {
                    return;
                }
            }
        } else {
            if (!confirm('Are you sure you want to stop renting? You will get your USDC deposit back.')) {
                return;
            }
        }

        try {
            const result = await this.blockchain.stopRenting(tokenId);

            // Update database
            await supabase
                .from('rental_history')
                .update({
                    is_active: false,
                    ended_at: new Date().toISOString()
                })
                .eq('token_id', tokenId);

            alert(`Rental ended successfully! You received $${result.refundAmount} back.`);

            // Reload page
            window.location.reload();

        } catch (error) {
            console.error('Failed to stop rental:', error);
            alert('Failed to stop rental: ' + error.message);
        }
    }
}

// Global functions for onclick handlers
function closeRentalModal(event) {
    if (event && event.target.id !== 'rental-modal') return;
    const modal = document.getElementById('rental-modal');
    if (modal) modal.remove();
}

async function executeRental() {
    const rentalManager = window.DexHeroRental;
    if (rentalManager) {
        await rentalManager.executeRental();
    }
}

// Initialize global instance
window.DexHeroRental = new DexHeroRental();

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DexHeroRental;
}
