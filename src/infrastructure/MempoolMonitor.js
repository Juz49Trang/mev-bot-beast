const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class MempoolMonitor extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.provider = bot.getProvider();
        
        // Mempool state
        this.pendingTransactions = new Map();
        this.processedHashes = new Set();
        this.mempoolSize = 0;
        
        // Configuration
        this.maxMempoolSize = bot.config.monitor.mempoolSize || 1000;
        this.cleanupInterval = 30000; // 30 seconds
        
        // Statistics
        this.stats = {
            totalSeen: 0,
            totalProcessed: 0,
            currentSize: 0,
            avgGasPrice: ethers.BigNumber.from(0)
        };
        
        logger.info('Mempool monitor initialized');
    }
    
    async start() {
        logger.info('Starting mempool monitor...');
        
        // Subscribe to pending transactions
        this.provider.on('pending', this.handlePendingTransaction.bind(this));
        
        // Start cleanup interval
        this.cleanupIntervalId = setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
        
        // Start WebSocket heartbeat if using WebSocket provider
        if (this.provider._websocket) {
            this.startHeartbeat();
        }
        
        logger.info('Mempool monitor started');
    }
    
    async stop() {
        logger.info('Stopping mempool monitor...');
        
        // Remove event listeners
        this.provider.removeAllListeners('pending');
        
        // Clear intervals
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
        }
        
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Clear state
        this.pendingTransactions.clear();
        this.processedHashes.clear();
        
        logger.info('Mempool monitor stopped');
    }
    
    async handlePendingTransaction(txHash) {
        try {
            // Check if already processed
            if (this.processedHashes.has(txHash)) {
                return;
            }
            
            // Mark as processed
            this.processedHashes.add(txHash);
            this.stats.totalSeen++;
            
            // Get transaction details
            const tx = await this.provider.getTransaction(txHash);
            
            if (!tx) {
                return;
            }
            
            // Add timestamp
            tx.timestamp = Date.now();
            tx.pending = true;
            
            // Store in mempool
            this.pendingTransactions.set(txHash, tx);
            this.mempoolSize++;
            
            // Update stats
            this.updateStats(tx);
            
            // Emit for analysis
            this.emit('transaction', tx);
            
            // Check if transaction is interesting
            if (this.isInterestingTransaction(tx)) {
                this.emit('mempool:transaction', tx);
                this.stats.totalProcessed++;
            }
            
            // Enforce size limit
            if (this.mempoolSize > this.maxMempoolSize) {
                this.enforceMaxSize();
            }
            
        } catch (error) {
            // Transaction may have been mined or dropped
            if (error.code !== 'TRANSACTION_REPLACED') {
                logger.debug('Error processing pending transaction', {
                    hash: txHash,
                    error: error.message
                });
            }
        }
    }
    
    isInterestingTransaction(tx) {
        // Filter for potentially profitable transactions
        
        // Must have a target
        if (!tx.to) return false;
        
        // Check if it's to a monitored contract
        const monitoredContracts = [
            ...Object.values(this.bot.config.contracts.dexRouters || {}),
            ...Object.values(this.bot.config.contracts.lendingProtocols || {})
        ];
        
        if (monitoredContracts.some(addr => 
            addr.toLowerCase() === tx.to.toLowerCase()
        )) {
            return true;
        }
        
        // Check value threshold
        const minValue = ethers.utils.parseEther(
            this.bot.config.monitor.minTransactionValue || '0.1'
        );
        
        if (tx.value.gte(minValue)) {
            return true;
        }
        
        // Check if it has input data (contract interaction)
        if (tx.data && tx.data.length > 10) {
            return true;
        }
        
        return false;
    }
    
    updateStats(tx) {
        this.stats.currentSize = this.mempoolSize;
        
        // Update average gas price
        if (tx.gasPrice) {
            const totalGas = this.stats.avgGasPrice.mul(this.stats.totalSeen - 1).add(tx.gasPrice);
            this.stats.avgGasPrice = totalGas.div(this.stats.totalSeen);
        }
    }
    
    enforceMaxSize() {
        // Remove oldest transactions
        const sortedTxs = Array.from(this.pendingTransactions.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const toRemove = sortedTxs.slice(0, this.mempoolSize - this.maxMempoolSize);
        
        for (const [hash, tx] of toRemove) {
            this.pendingTransactions.delete(hash);
            this.mempoolSize--;
        }
    }
    
    cleanup() {
        const now = Date.now();
        const maxAge = 60000; // 1 minute
        const toRemove = [];
        
        // Remove old transactions
        for (const [hash, tx] of this.pendingTransactions) {
            if (now - tx.timestamp > maxAge) {
                toRemove.push(hash);
            }
        }
        
        for (const hash of toRemove) {
            this.pendingTransactions.delete(hash);
            this.mempoolSize--;
        }
        
        // Clean processed hashes
        if (this.processedHashes.size > 10000) {
            this.processedHashes.clear();
        }
        
        logger.debug('Mempool cleanup completed', {
            removed: toRemove.length,
            currentSize: this.mempoolSize
        });
    }
    
    startHeartbeat() {
        // Keep WebSocket connection alive
        this.heartbeatInterval = setInterval(async () => {
            try {
                await this.provider.getBlockNumber();
            } catch (error) {
                logger.error('WebSocket heartbeat failed', error);
                
                // Attempt to reconnect
                this.emit('connection:lost');
            }
        }, 30000); // Every 30 seconds
    }
    
    getTransaction(hash) {
        return this.pendingTransactions.get(hash);
    }
    
    getTransactionsByTo(address) {
        const txs = [];
        const targetAddress = address.toLowerCase();
        
        for (const [hash, tx] of this.pendingTransactions) {
            if (tx.to && tx.to.toLowerCase() === targetAddress) {
                txs.push(tx);
            }
        }
        
        return txs;
    }
    
    getHighValueTransactions(minValue) {
        const txs = [];
        
        for (const [hash, tx] of this.pendingTransactions) {
            if (tx.value.gte(minValue)) {
                txs.push(tx);
            }
        }
        
        return txs.sort((a, b) => b.value.sub(a.value));
    }
    
    getStats() {
        return {
            ...this.stats,
            avgGasPriceGwei: ethers.utils.formatUnits(this.stats.avgGasPrice, 'gwei'),
            oldestTx: this.getOldestTransaction(),
            highValueTxs: this.getHighValueTransactions(
                ethers.utils.parseEther('1')
            ).length
        };
    }
    
    getOldestTransaction() {
        let oldest = null;
        let oldestTime = Date.now();
        
        for (const [hash, tx] of this.pendingTransactions) {
            if (tx.timestamp < oldestTime) {
                oldestTime = tx.timestamp;
                oldest = tx;
            }
        }
        
        return oldest ? {
            hash: oldest.hash,
            age: Date.now() - oldest.timestamp,
            value: ethers.utils.formatEther(oldest.value)
        } : null;
    }
}

module.exports = { MempoolMonitor };