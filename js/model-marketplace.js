/**
 * DexHero Model Marketplace Module
 * Handles 3D model purchases, uploads, and marketplace queries
 */

(function () {
    'use strict';

    /**
     * Upload model file to Supabase Storage
     */
    async function uploadModelFile(file, walletAddress) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            // Generate unique filename
            const timestamp = Date.now();
            const extension = file.name.split('.').pop();
            const filename = `${walletAddress}/${timestamp}.${extension}`;

            console.log(' Uploading model file:', filename);

            const { data, error } = await supabase.storage
                .from('models')
                .upload(filename, file, {
                    contentType: file.type,
                    cacheControl: '3600',
                    upsert: false
                });

            if (error) throw error;

            // Get public URL
            const { data: { publicUrl } } = supabase.storage
                .from('models')
                .getPublicUrl(filename);

            console.log(' Model uploaded:', publicUrl);

            return {
                success: true,
                url: publicUrl,
                path: filename,
                size: file.size / (1024 * 1024) // Convert to MB
            };

        } catch (error) {
            console.error(' Model upload failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * List a model for sale in the marketplace
     */
    async function listModel(params) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            // Validate minimum price
            if (params.price < MIN_PRICE_SOL) {
                throw new Error(`Minimum price is ${MIN_PRICE_SOL} SOL`);
            }

            console.log(' Listing model:', params);

            const { data, error } = await supabase
                .from('models')
                .insert([{
                    name: params.name,
                    description: params.description,
                    model_url: params.modelUrl,
                    preview_image_url: params.previewImageUrl,
                    purchase_price: params.price,
                    creator_wallet: params.creatorWallet,
                    token_id: params.tokenId || null,
                    token_benefit_description: params.tokenBenefit || null,
                    file_type: params.fileType || 'glb',
                    file_size_mb: params.fileSizeMb,
                    category: params.category || 'uncategorized',
                    tags: params.tags || [],
                    is_for_sale: true,
                    is_for_rent: false // Phase 4
                }])
                .select()
                .single();

            if (error) throw error;

            console.log(' Model listed:', data);

            return {
                success: true,
                model: data
            };

        } catch (error) {
            console.error(' List model failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Purchase a model (EVM payment)
     * TODO: Implement EVM-based model purchase to replace legacy Solana payment flow
     */
    async function purchaseModel(modelId, modelPrice, sellerWallet) {
        return { success: false, error: 'Model purchases are being migrated to EVM. Coming soon.' };
    }

    /**
     * Get all models from marketplace
     */
    async function getAllModels(filters = {}) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            let query = supabase
                .from('models')
                .select('*')
                .eq('is_for_sale', true)
                .order('created_at', { ascending: false });

            // Apply filters
            if (filters.minPrice) {
                query = query.gte('purchase_price', filters.minPrice);
            }
            if (filters.maxPrice) {
                query = query.lte('purchase_price', filters.maxPrice);
            }
            if (filters.category && filters.category !== 'all') {
                query = query.eq('category', filters.category);
            }
            if (filters.search) {
                query = query.ilike('name', `%${filters.search}%`);
            }

            const { data, error } = await query.limit(100);

            if (error) throw error;

            return {
                success: true,
                models: data || []
            };

        } catch (error) {
            console.error('Error fetching models:', error);
            return {
                success: false,
                models: [],
                error: error.message
            };
        }
    }

    /**
     * Get model by ID
     */
    async function getModelById(modelId) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            const { data, error } = await supabase
                .from('models')
                .select('*')
                .eq('id', modelId)
                .single();

            if (error) throw error;

            return {
                success: true,
                model: data
            };

        } catch (error) {
            console.error('Error fetching model:', error);
            return {
                success: false,
                model: null,
                error: error.message
            };
        }
    }

    /**
     * Get user's purchased models
     */
    async function getUserPurchases(walletAddress) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            // Get purchases with model details
            const { data, error } = await supabase
                .from('model_purchases')
                .select(`
                    *,
                    models (*)
                `)
                .eq('buyer_wallet', walletAddress)
                .order('purchased_at', { ascending: false })
                .limit(100);

            if (error) throw error;

            return {
                success: true,
                purchases: data || []
            };

        } catch (error) {
            console.error('Error fetching purchases:', error);
            return {
                success: false,
                purchases: [],
                error: error.message
            };
        }
    }

    /**
     * Get user's listed models
     */
    async function getUserListings(walletAddress) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            const { data, error } = await supabase
                .from('models')
                .select('*')
                .eq('creator_wallet', walletAddress)
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) throw error;

            return {
                success: true,
                models: data || []
            };

        } catch (error) {
            console.error('Error fetching listings:', error);
            return {
                success: false,
                models: [],
                error: error.message
            };
        }
    }

    /**
     * Check if user owns a model
     */
    async function userOwnsModel(modelId, walletAddress) {
        try {
            const supabase = window.DexHeroSupabase.get();
            if (!supabase) {
                throw new Error('Supabase not initialized');
            }

            const { data, error } = await supabase
                .from('model_purchases')
                .select('id')
                .eq('model_id', modelId)
                .eq('buyer_wallet', walletAddress)
                .limit(1);

            if (error) throw error;

            return {
                owns: data && data.length > 0
            };

        } catch (error) {
            console.error('Error checking ownership:', error);
            return {
                owns: false
            };
        }
    }

    // Expose functions globally
    window.DexHeroMarketplace = {
        uploadModelFile,
        listModel,
        purchaseModel,
        getAllModels,
        getModelById,
        getUserPurchases,
        getUserListings,
        getCreatorModels: getUserListings, // Alias for consistency
        userOwnsModel,
        MIN_PRICE_SOL,
        getNetwork: () => NETWORK
    };

    console.log(' DexHero Marketplace module loaded (Min Price: ' + MIN_PRICE_SOL + ' SOL)');

})();
