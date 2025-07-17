const { ethers } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const { logger } = require('../utils/logger');

class FlashbotsProvider {
    constructor(config) {
        this.config = config;
        this.provider = null;
        this.flashbotsProvider = null;
        this.authSigner = null;
        
        // Bundle tracking
        this.pendingBundles = new Map();
        this.bundleStats = {
            submitted: 0,
            included: 0,
            failed: 0
        };
    }
    
    async initialize(provider, authSigner) {
        try {
            this.provider = provider;
            this.authSigner = authSigner || ethers.Wallet.createRandom();
            
            // Initialize Flashbots provider
            this.flashbotsProvider = await FlashbotsBundleProvider.create(
                provider,
                this.authSigner,
                this.config.relayUrl || 'https://relay.flashbots.net',
                'mainnet' // or network name
            );
            
            logger.info('Flashbots provider initialized', {
                relay: this.config.relayUrl || 'https://relay.flashbots.net'
            });
            
            return true;
        } catch (error) {
            logger.error('Failed to initialize Flashbots provider', error);
            return false;
        }
    }
    
    async sendBundle(transactions, targetBlockNumber, options = {}) {
        try {
            if (!this.flashbotsProvider) {
                throw new Error('Flashbots provider not initialized');
            }
            
            // Build bundle
            const bundle = transactions.map(tx => ({
                signer: tx.signer || this.authSigner,
                transaction: {
                    to: tx.to,
                    data: tx.data,
                    value: tx.value || 0,
                    gasLimit: tx.gasLimit,
                    chainId: tx.chainId || 1
                }
            }));
            
            // Simulate bundle first
            const simulation = await this.flashbotsProvider.simulate(
                bundle,
                targetBlockNumber
            );
            
            if ('error' in simulation || simulation.firstRevert) {
                logger.error('Bundle simulation failed', {
                    error: simulation.error,
                    firstRevert: simulation.firstRevert
                });
                
                return {
                    success: false,
                    error: simulation.error || 'Simulation reverted',
                    simulation
                };
            }
            
            logger.info('Bundle simulation successful', {
                totalGasUsed: simulation.totalGasUsed,
                profit: ethers.utils.formatEther(simulation.coinbaseDiff)
            });
            
            // Send bundle
            const bundleSubmission = await this.flashbotsProvider.sendRawBundle(
                bundle,
                targetBlockNumber,
                {
                    minTimestamp: options.minTimestamp,
                    maxTimestamp: options.maxTimestamp,
                    revertingTxHashes: options.revertingTxHashes || []
                }
            );
            
            this.bundleStats.submitted++;
            
            // Track bundle
            const bundleHash = bundleSubmission.bundleHash;
            this.pendingBundles.set(bundleHash, {
                targetBlock: targetBlockNumber,
                submittedAt: Date.now(),
                transactions: bundle.length
            });
            
            // Wait for inclusion
            const waitResponse = await bundleSubmission.wait();
            
            if (waitResponse === 0) {
                this.bundleStats.included++;
                this.pendingBundles.delete(bundleHash);
                
                logger.info('Bundle included!', {
                    bundleHash,
                    targetBlock: targetBlockNumber
                });
                
                return {
                    success: true,
                    bundleHash,
                    blockNumber: targetBlockNumber,
                    profit: simulation.coinbaseDiff,
                    txHashes: bundle.map(b => ethers.utils.keccak256(b.transaction))
                };
            } else {
                this.bundleStats.failed++;
                this.pendingBundles.delete(bundleHash);
                
                const stats = await this.getBundleStats(bundleHash, targetBlockNumber);
                
                logger.warn('Bundle not included', {
                    bundleHash,
                    targetBlock: targetBlockNumber,
                    stats
                });
                
                return {
                    success: false,
                    bundleHash,
                    reason: 'Not included',
                    stats
                };
            }
            
        } catch (error) {
            logger.error('Error sending bundle', error);
            this.bundleStats.failed++;
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async getBundleStats(bundleHash, blockNumber) {
        try {
            return await this.flashbotsProvider.getBundleStats(
                bundleHash,
                blockNumber
            );
        } catch (error) {
            logger.error('Error getting bundle stats', error);
            return null;
        }
    }
    
    async getUserStats() {
        try {
            return await this.flashbotsProvider.getUserStats();
        } catch (error) {
            logger.error('Error getting user stats', error);
            return null;
        }
    }
    
    async simulateBundle(transactions, blockNumber) {
        try {
            const bundle = transactions.map(tx => ({
                signer: tx.signer || this.authSigner,
                transaction: {
                    to: tx.to,
                    data: tx.data,
                    value: tx.value || 0,
                    gasLimit: tx.gasLimit,
                    chainId: tx.chainId || 1
                }
            }));
            
            return await this.flashbotsProvider.simulate(bundle, blockNumber);
        } catch (error) {
            logger.error('Bundle simulation error', error);
            throw error;
        }
    }
    
    async sendPrivateTransaction(transaction, options = {}) {
        try {
            const signedTx = await transaction.signer.signTransaction(transaction);
            
            const result = await this.flashbotsProvider.sendPrivateTransaction(
                {
                    tx: signedTx,
                    maxBlockNumber: options.maxBlockNumber,
                    preferences: options.preferences
                }
            );
            
            return result;
        } catch (error) {
            logger.error('Error sending private transaction', error);
            throw error;
        }
    }
    
    async cancelPrivateTransaction(txHash) {
        try {
            return await this.flashbotsProvider.cancelPrivateTransaction(txHash);
        } catch (error) {
            logger.error('Error canceling private transaction', error);
            throw error;
        }
    }
    
    getStats() {
        return {
            ...this.bundleStats,
            pendingBundles: this.pendingBundles.size,
            successRate: this.bundleStats.submitted > 0
                ? (this.bundleStats.included / this.bundleStats.submitted * 100).toFixed(2) + '%'
                : '0%'
        };
    }
    
    cleanup() {
        // Clean up old pending bundles
        const now = Date.now();
        const maxAge = 5 * 60 * 1000; // 5 minutes
        
        for (const [hash, bundle] of this.pendingBundles) {
            if (now - bundle.submittedAt > maxAge) {
                this.pendingBundles.delete(hash);
            }
        }
    }
}

module.exports = { FlashbotsProvider };