const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { MempoolMonitor } = require('../infrastructure/MempoolMonitor');

class Monitor extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.provider = bot.getProvider();
        this.mempoolMonitor = new MempoolMonitor(bot);
        
        // Monitoring state
        this.isMonitoring = false;
        this.blockSubscription = null;
        this.pendingSubscription = null;
        
        // Performance tracking
        this.stats = {
            blocksProcessed: 0,
            transactionsAnalyzed: 0,
            mempoolTxAnalyzed: 0,
            lastBlockTime: Date.now(),
            avgBlockTime: 0
        };
        
        // Target contracts to monitor
        this.targetContracts = new Set([
            ...Object.values(bot.config.contracts.dexRouters || {}),
            ...Object.values(bot.config.contracts.lendingProtocols || {}),
            ...Object.values(bot.config.contracts.flashLoanProviders || {})
        ]);
        
        // Transaction cache to avoid duplicates
        this.processedTxs = new Set();
        this.txCache = new Map(); // LRU cache
        this.maxCacheSize = 10000;
    }
    
    async start() {
        if (this.isMonitoring) {
            logger.warn('Monitor is already running');
            return;
        }
        
        logger.info('Starting blockchain monitor...');
        
        try {
            // Start block monitoring
            this.startBlockMonitoring();
            
            // Start mempool monitoring
            await this.mempoolMonitor.start();
            
            // Start pending transaction monitoring
            this.startPendingMonitoring();
            
            // Start chain reorganization monitoring
            this.startReorgMonitoring();
            
            // Start gas price monitoring
            this.startGasPriceMonitoring();
            
            this.isMonitoring = true;
            this.emit('started');
            
            logger.info('Blockchain monitor started successfully');
            
        } catch (error) {
            logger.error('Failed to start monitor', error);
            throw error;
        }
    }
    
    async stop() {
        if (!this.isMonitoring) {
            return;
        }
        
        logger.info('Stopping blockchain monitor...');
        
        // Remove event listeners
        if (this.blockSubscription) {
            this.provider.off('block', this.blockSubscription);
        }
        
        if (this.pendingSubscription) {
            this.provider.off('pending', this.pendingSubscription);
        }
        
        // Stop mempool monitor
        await this.mempoolMonitor.stop();
        
        // Clear caches
        this.processedTxs.clear();
        this.txCache.clear();
        
        this.isMonitoring = false;
        this.emit('stopped');
        
        logger.info('Blockchain monitor stopped');
    }
    
    startBlockMonitoring() {
        this.blockSubscription = async (blockNumber) => {
            try {
                const startTime = Date.now();
                
                // Get block with transactions
                const block = await this.provider.getBlockWithTransactions(blockNumber);
                
                if (!block) {
                    logger.warn(`Block ${blockNumber} not found`);
                    return;
                }
                
                // Update stats
                this.updateBlockStats(block, startTime);
                
                // Process transactions in parallel
                const txPromises = block.transactions.map(tx => 
                    this.processTransaction(tx, 'block', block)
                );
                
                await Promise.allSettled(txPromises);
                
                // Emit block event
                this.emit('block', {
                    number: block.number,
                    hash: block.hash,
                    timestamp: block.timestamp,
                    transactionCount: block.transactions.length,
                    gasUsed: block.gasUsed.toString(),
                    baseFeePerGas: block.baseFeePerGas?.toString()
                });
                
                // Clean up old cache entries
                this.cleanupCache();
                
            } catch (error) {
                logger.error(`Error processing block ${blockNumber}`, error);
            }
        };
        
        this.provider.on('block', this.blockSubscription);
        logger.info('Block monitoring started');
    }
    
    startPendingMonitoring() {
        // Monitor pending transactions
        this.pendingSubscription = async (txHash) => {
            try {
                // Check if already processed
                if (this.processedTxs.has(txHash)) {
                    return;
                }
                
                // Get transaction
                const tx = await this.provider.getTransaction(txHash);
                
                if (!tx) {
                    return;
                }
                
                // Process if it's to a target contract
                if (this.isTargetTransaction(tx)) {
                    await this.processTransaction(tx, 'pending');
                }
                
            } catch (error) {
                // Pending transactions may disappear, this is normal
                if (error.code !== 'TRANSACTION_REPLACED') {
                    logger.debug('Error processing pending tx', { hash: txHash, error: error.message });
                }
            }
        };
        
        this.provider.on('pending', this.pendingSubscription);
        logger.info('Pending transaction monitoring started');
    }
    
    startReorgMonitoring() {
        // Monitor for chain reorganizations
        let lastBlockHash = null;
        
        setInterval(async () => {
            try {
                const latestBlock = await this.provider.getBlock('latest');
                
                if (lastBlockHash && latestBlock.parentHash !== lastBlockHash) {
                    // Potential reorg detected
                    logger.warn('Potential chain reorganization detected', {
                        expectedParent: lastBlockHash,
                        actualParent: latestBlock.parentHash,
                        blockNumber: latestBlock.number
                    });
                    
                    this.emit('reorg', {
                        blockNumber: latestBlock.number,
                        newHash: latestBlock.hash,
                        oldHash: lastBlockHash
                    });
                    
                    // Clear caches as state may have changed
                    this.processedTxs.clear();
                    this.txCache.clear();
                }
                
                lastBlockHash = latestBlock.hash;
                
            } catch (error) {
                logger.error('Error monitoring for reorgs', error);
            }
        }, 5000); // Check every 5 seconds
    }
    
    startGasPriceMonitoring() {
        // Monitor gas prices for optimal execution
        setInterval(async () => {
            try {
                const gasPrice = await this.provider.getGasPrice();
                const block = await this.provider.getBlock('latest');
                
                const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
                const baseFeeGwei = block.baseFeePerGas ? 
                    ethers.utils.formatUnits(block.baseFeePerGas, 'gwei') : null;
                
                this.emit('gasUpdate', {
                    gasPrice: gasPrice.toString(),
                    gasPriceGwei: parseFloat(gasPriceGwei),
                    baseFeePerGas: block.baseFeePerGas?.toString(),
                    baseFeeGwei: baseFeeGwei ? parseFloat(baseFeeGwei) : null,
                    blockNumber: block.number
                });
                
            } catch (error) {
                logger.error('Error monitoring gas prices', error);
            }
        }, 3000); // Every 3 seconds
    }
    
    async processTransaction(tx, source, block = null) {
        try {
            // Mark as processed
            this.processedTxs.add(tx.hash);
            this.stats.transactionsAnalyzed++;
            
            if (source === 'pending') {
                this.stats.mempoolTxAnalyzed++;
            }
            
            // Skip if not interesting
            if (!this.isInterestingTransaction(tx)) {
                return;
            }
            
            // Decode transaction
            const decoded = await this.decodeTransaction(tx);
            
            if (!decoded) {
                return;
            }
            
            // Add metadata
            const enrichedTx = {
                ...tx,
                decoded,
                source,
                timestamp: block ? block.timestamp : Date.now() / 1000,
                blockNumber: block ? block.number : null,
                baseFeePerGas: block ? block.baseFeePerGas : null
            };
            
            // Cache transaction
            this.txCache.set(tx.hash, enrichedTx);
            
            // Emit for strategies to analyze
            this.emit('transaction', enrichedTx);
            
            // Emit specific events based on transaction type
            this.emitSpecificEvents(enrichedTx);
            
        } catch (error) {
            logger.debug('Error processing transaction', {
                hash: tx.hash,
                error: error.message
            });
        }
    }
    
    isTargetTransaction(tx) {
        // Check if transaction is to a monitored contract
        if (!tx.to) return false; // Contract creation
        
        return this.targetContracts.has(tx.to.toLowerCase());
    }
    
    isInterestingTransaction(tx) {
        // Filter for potentially profitable transactions
        
        // Must have a target
        if (!tx.to) return false;
        
        // Check value threshold
        const minValue = ethers.utils.parseEther(
            this.bot.config.monitor.minTransactionValue || '0.1'
        );
        
        if (tx.value.gte(minValue)) {
            return true;
        }
        
        // Check if it's to a known protocol
        if (this.isTargetTransaction(tx)) {
            return true;
        }
        
        // Check data size (likely a contract interaction)
        if (tx.data && tx.data.length > 10) {
            return true;
        }
        
        return false;
    }
    
    async decodeTransaction(tx) {
        try {
            // Try to decode based on known contract ABIs
            for (const [name, address] of Object.entries(this.bot.config.contracts.dexRouters || {})) {
                if (tx.to?.toLowerCase() === address.toLowerCase()) {
                    return this.decodeDEXTransaction(tx, name);
                }
            }
            
            for (const [name, address] of Object.entries(this.bot.config.contracts.lendingProtocols || {})) {
                if (tx.to?.toLowerCase() === address.toLowerCase()) {
                    return this.decodeLendingTransaction(tx, name);
                }
            }
            
            // Generic decoding attempt
            return this.genericDecode(tx);
            
        } catch (error) {
            logger.debug('Failed to decode transaction', {
                hash: tx.hash,
                error: error.message
            });
            return null;
        }
    }
    
    decodeDEXTransaction(tx, dexName) {
        // Decode based on DEX type
        const decoders = {
            uniswapV3: require('../dex/UniswapV3').decodeTransaction,
            sushiswap: require('../dex/SushiSwap').decodeTransaction,
            curve: require('../dex/Curve').decodeTransaction
        };
        
        const decoder = decoders[dexName.toLowerCase()];
        if (decoder) {
            return decoder(tx);
        }
        
        return null;
    }
    
    decodeLendingTransaction(tx, protocolName) {
        // Decode lending protocol transactions
        const commonLendingABI = [
            'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)',
            'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
            'function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf)'
        ];
        
        try {
            const iface = new ethers.utils.Interface(commonLendingABI);
            const decoded = iface.parseTransaction({ data: tx.data });
            
            return {
                protocol: protocolName,
                method: decoded.name,
                args: decoded.args
            };
        } catch (error) {
            return null;
        }
    }
    
    genericDecode(tx) {
        // Try to identify transaction type by method signature
        const methodId = tx.data.slice(0, 10);
        
        const knownMethods = {
            '0x7ff36ab5': { name: 'swapExactETHForTokens', type: 'swap' },
            '0x38ed1739': { name: 'swapExactTokensForTokens', type: 'swap' },
            '0x8803dbee': { name: 'swapTokensForExactTokens', type: 'swap' },
            '0xa9059cbb': { name: 'transfer', type: 'transfer' },
            '0x23b872dd': { name: 'transferFrom', type: 'transfer' },
            '0x095ea7b3': { name: 'approve', type: 'approval' }
        };
        
        const method = knownMethods[methodId];
        
        if (method) {
            return {
                method: method.name,
                type: method.type,
                methodId: methodId
            };
        }
        
        return {
            method: 'unknown',
            methodId: methodId
        };
    }
    
    emitSpecificEvents(tx) {
        // Emit events based on transaction type
        if (tx.decoded) {
            switch (tx.decoded.type) {
                case 'swap':
                    this.emit('swap', tx);
                    break;
                    
                case 'liquidation':
                    this.emit('liquidation', tx);
                    break;
                    
                case 'flashloan':
                    this.emit('flashloan', tx);
                    break;
                    
                case 'borrow':
                case 'repay':
                    this.emit('lending', tx);
                    break;
            }
        }
        
        // Emit high-value transaction event
        const highValueThreshold = ethers.utils.parseEther(
            this.bot.config.monitor.highValueThreshold || '10'
        );
        
        if (tx.value.gte(highValueThreshold)) {
            this.emit('highValue', tx);
        }
    }
    
    updateBlockStats(block, startTime) {
        this.stats.blocksProcessed++;
        
        // Calculate block time
        const blockTime = Date.now() - startTime;
        const timeSinceLastBlock = Date.now() - this.stats.lastBlockTime;
        
        // Update average block time
        if (this.stats.avgBlockTime === 0) {
            this.stats.avgBlockTime = timeSinceLastBlock;
        } else {
            this.stats.avgBlockTime = 
                (this.stats.avgBlockTime * 0.9) + (timeSinceLastBlock * 0.1);
        }
        
        this.stats.lastBlockTime = Date.now();
        
        // Log if block processing is slow
        if (blockTime > 1000) {
            logger.warn('Slow block processing', {
                blockNumber: block.number,
                processingTime: blockTime,
                transactionCount: block.transactions.length
            });
        }
    }
    
    cleanupCache() {
        // Remove old entries if cache is too large
        if (this.txCache.size > this.maxCacheSize) {
            const entriesToRemove = this.txCache.size - (this.maxCacheSize * 0.8);
            const entries = Array.from(this.txCache.entries());
            
            for (let i = 0; i < entriesToRemove; i++) {
                this.txCache.delete(entries[i][0]);
            }
        }
        
        // Clear processed transactions older than 1 hour
        if (this.processedTxs.size > 50000) {
            this.processedTxs.clear();
        }
    }
    
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.txCache.size,
            processedTxCount: this.processedTxs.size,
            isMonitoring: this.isMonitoring
        };
    }
}

module.exports = { Monitor };