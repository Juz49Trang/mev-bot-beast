const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class ProviderManager {
    constructor(config) {
        this.config = config;
        this.providers = new Map();
        this.providerStats = new Map();
        this.primaryProvider = null;
        
        // Initialize providers
        this.initializeProviders();
        
        // Health check interval
        this.healthCheckInterval = null;
        this.startHealthChecks();
        
        logger.info('Provider manager initialized', {
            providerCount: this.providers.size
        });
    }
    
    initializeProviders() {
        for (const [name, providerConfig] of Object.entries(this.config)) {
            try {
                let provider;
                
                if (providerConfig.type === 'websocket') {
                    provider = new ethers.providers.WebSocketProvider(providerConfig.url);
                } else {
                    provider = new ethers.providers.JsonRpcProvider(providerConfig.url);
                }
                
                // Add custom properties
                provider._name = name;
                provider._priority = providerConfig.priority || 1;
                provider._rateLimit = providerConfig.rateLimit || 100;
                
                this.providers.set(name, provider);
                
                // Initialize stats
                this.providerStats.set(name, {
                    requests: 0,
                    errors: 0,
                    latency: [],
                    lastError: null,
                    healthy: true
                });
                
                // Set primary provider
                if (!this.primaryProvider || providerConfig.primary) {
                    this.primaryProvider = provider;
                }
                
                logger.info(`Provider initialized: ${name}`, {
                    type: providerConfig.type,
                    url: providerConfig.url.replace(/\/\/.*@/, '//***@') // Hide credentials
                });
                
            } catch (error) {
                logger.error(`Failed to initialize provider: ${name}`, error);
            }
        }
    }
    
    getProvider(name = null) {
        if (name) {
            return this.providers.get(name);
        }
        
        // Return the healthiest provider with lowest latency
        return this.getBestProvider();
    }
    
    getBestProvider() {
        let bestProvider = this.primaryProvider;
        let bestScore = Infinity;
        
        for (const [name, provider] of this.providers) {
            const stats = this.providerStats.get(name);
            
            if (!stats.healthy) continue;
            
            // Calculate score (lower is better)
            const avgLatency = stats.latency.length > 0 
                ? stats.latency.reduce((a, b) => a + b) / stats.latency.length 
                : 100;
            
            const errorRate = stats.requests > 0 
                ? stats.errors / stats.requests 
                : 0;
            
            const score = avgLatency + (errorRate * 1000) - (provider._priority * 10);
            
            if (score < bestScore) {
                bestScore = score;
                bestProvider = provider;
            }
        }
        
        return bestProvider;
    }
    
    async getAllProviders() {
        return Array.from(this.providers.values());
    }
    
    async executeWithFallback(method, params = []) {
        const providers = this.getSortedProviders();
        let lastError;
        
        for (const provider of providers) {
            try {
                const start = Date.now();
                const result = await provider[method](...params);
                
                // Update stats
                this.updateProviderStats(provider._name, true, Date.now() - start);
                
                return result;
                
            } catch (error) {
                lastError = error;
                this.updateProviderStats(provider._name, false, 0, error);
                
                logger.debug(`Provider ${provider._name} failed for ${method}`, {
                    error: error.message
                });
            }
        }
        
        throw lastError || new Error('All providers failed');
    }
    
    getSortedProviders() {
        // Sort providers by health and performance
        return Array.from(this.providers.values()).sort((a, b) => {
            const statsA = this.providerStats.get(a._name);
            const statsB = this.providerStats.get(b._name);
            
            // Unhealthy providers go last
            if (statsA.healthy !== statsB.healthy) {
                return statsB.healthy - statsA.healthy;
            }
            
            // Sort by error rate
            const errorRateA = statsA.requests > 0 ? statsA.errors / statsA.requests : 0;
            const errorRateB = statsB.requests > 0 ? statsB.errors / statsB.requests : 0;
            
            if (errorRateA !== errorRateB) {
                return errorRateA - errorRateB;
            }
            
            // Sort by average latency
            const avgLatencyA = statsA.latency.length > 0 
                ? statsA.latency.reduce((a, b) => a + b) / statsA.latency.length 
                : 100;
            
            const avgLatencyB = statsB.latency.length > 0 
                ? statsB.latency.reduce((a, b) => a + b) / statsB.latency.length 
                : 100;
            
            return avgLatencyA - avgLatencyB;
        });
    }
    
    updateProviderStats(name, success, latency = 0, error = null) {
        const stats = this.providerStats.get(name);
        if (!stats) return;
        
        stats.requests++;
        
        if (success) {
            stats.latency.push(latency);
            
            // Keep only last 100 latency measurements
            if (stats.latency.length > 100) {
                stats.latency.shift();
            }
        } else {
            stats.errors++;
            stats.lastError = error;
            
            // Mark unhealthy if error rate is too high
            if (stats.requests > 10 && stats.errors / stats.requests > 0.5) {
                stats.healthy = false;
                logger.warn(`Provider ${name} marked unhealthy due to high error rate`);
            }
        }
    }
    
    startHealthChecks() {
        // Check provider health every 30 seconds
        this.healthCheckInterval = setInterval(async () => {
            await this.performHealthChecks();
        }, 30000);
        
        // Initial health check
        this.performHealthChecks();
    }
    
    async performHealthChecks() {
        const checks = Array.from(this.providers.entries()).map(async ([name, provider]) => {
            try {
                const start = Date.now();
                const blockNumber = await provider.getBlockNumber();
                const latency = Date.now() - start;
                
                const stats = this.providerStats.get(name);
                
                // Check if block number is reasonable
                const currentBlock = await this.primaryProvider.getBlockNumber();
                const blockDiff = Math.abs(currentBlock - blockNumber);
                
                if (blockDiff > 5) {
                    stats.healthy = false;
                    logger.warn(`Provider ${name} is ${blockDiff} blocks behind`);
                } else {
                    stats.healthy = true;
                }
                
                // Update latency
                stats.latency.push(latency);
                if (stats.latency.length > 100) {
                    stats.latency.shift();
                }
                
                return { name, healthy: stats.healthy, blockNumber, latency };
                
            } catch (error) {
                const stats = this.providerStats.get(name);
                stats.healthy = false;
                stats.lastError = error;
                
                logger.error(`Health check failed for ${name}`, error);
                
                return { name, healthy: false, error: error.message };
            }
        });
        
        const results = await Promise.allSettled(checks);
        
        // Log health check summary
        const summary = results.map(r => r.value || r.reason);
        const healthyCount = summary.filter(s => s.healthy).length;
        
        logger.debug('Provider health check completed', {
            total: this.providers.size,
            healthy: healthyCount,
            results: summary
        });
        
        // Switch primary provider if unhealthy
        const primaryStats = this.providerStats.get(this.primaryProvider._name);
        if (!primaryStats.healthy) {
            const newPrimary = this.getBestProvider();
            if (newPrimary !== this.primaryProvider) {
                logger.info(`Switching primary provider from ${this.primaryProvider._name} to ${newPrimary._name}`);
                this.primaryProvider = newPrimary;
            }
        }
    }
    
    async broadcastTransaction(signedTx) {
        // Broadcast to multiple providers for reliability
        const providers = this.getSortedProviders().slice(0, 3); // Top 3 providers
        
        const broadcasts = providers.map(provider => 
            provider.sendTransaction(signedTx).catch(err => ({
                error: err,
                provider: provider._name
            }))
        );
        
        const results = await Promise.allSettled(broadcasts);
        
        // Return first successful result
        for (const result of results) {
            if (result.status === 'fulfilled' && !result.value.error) {
                return result.value;
            }
        }
        
        // All failed, throw error
        const errors = results.map(r => r.reason || r.value.error);
        throw new Error(`Transaction broadcast failed on all providers: ${errors.join(', ')}`);
    }
    
    getStats() {
        const stats = {};
        
        for (const [name, providerStats] of this.providerStats) {
            const avgLatency = providerStats.latency.length > 0
                ? providerStats.latency.reduce((a, b) => a + b) / providerStats.latency.length
                : 0;
            
            stats[name] = {
                healthy: providerStats.healthy,
                requests: providerStats.requests,
                errors: providerStats.errors,
                errorRate: providerStats.requests > 0 
                    ? (providerStats.errors / providerStats.requests * 100).toFixed(2) + '%'
                    : '0%',
                avgLatency: Math.round(avgLatency) + 'ms',
                lastError: providerStats.lastError ? providerStats.lastError.message : null
            };
        }
        
        return {
            primaryProvider: this.primaryProvider._name,
            providers: stats
        };
    }
    
    async stop() {
        // Clear health check interval
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        // Close WebSocket connections
        for (const provider of this.providers.values()) {
            if (provider._websocket) {
                await provider._websocket.destroy();
            }
        }
        
        logger.info('Provider manager stopped');
    }
}

module.exports = { ProviderManager };