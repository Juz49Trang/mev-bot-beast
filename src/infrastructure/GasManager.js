const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class GasManager {
    constructor(bot) {
        this.bot = bot;
        this.provider = bot.getProvider();
        
        // Gas price tracking
        this.currentGasPrice = null;
        this.gasPriceHistory = [];
        this.maxHistorySize = 100;
        
        // EIP-1559 support
        this.supportsEIP1559 = null;
        this.baseFeeHistory = [];
        
        // Gas price strategies
        this.strategies = {
            SLOW: { priority: 1, label: 'slow' },
            STANDARD: { priority: 2, label: 'standard' },
            FAST: { priority: 3, label: 'fast' },
            INSTANT: { priority: 5, label: 'instant' }
        };
        
        // Update interval
        this.updateInterval = null;
        
        logger.info('Gas manager initialized');
    }
    
    async start() {
        // Check EIP-1559 support
        await this.checkEIP1559Support();
        
        // Initial gas price fetch
        await this.updateGasPrice();
        
        // Start monitoring
        this.updateInterval = setInterval(async () => {
            await this.updateGasPrice();
        }, 3000); // Every 3 seconds
        
        logger.info('Gas manager started');
    }
    
    async stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        logger.info('Gas manager stopped');
    }
    
    async checkEIP1559Support() {
        try {
            const block = await this.provider.getBlock('latest');
            this.supportsEIP1559 = block.baseFeePerGas !== undefined;
            logger.info(`EIP-1559 support: ${this.supportsEIP1559}`);
        } catch (error) {
            this.supportsEIP1559 = false;
        }
    }
    
    async updateGasPrice() {
        try {
            if (this.supportsEIP1559) {
                await this.updateEIP1559GasPrice();
            } else {
                await this.updateLegacyGasPrice();
            }
            
            // Update history
            this.gasPriceHistory.push({
                timestamp: Date.now(),
                gasPrice: this.currentGasPrice,
                baseFee: this.currentBaseFee
            });
            
            // Trim history
            if (this.gasPriceHistory.length > this.maxHistorySize) {
                this.gasPriceHistory.shift();
            }
            
        } catch (error) {
            logger.error('Error updating gas price', error);
        }
    }
    
    async updateEIP1559GasPrice() {
        const block = await this.provider.getBlock('latest');
        const baseFee = block.baseFeePerGas;
        
        this.currentBaseFee = baseFee;
        
        // Calculate priority fees based on recent blocks
        const priorityFees = await this.calculatePriorityFees();
        
        this.currentGasPrice = {
            type: 'eip1559',
            baseFee,
            slow: {
                maxFeePerGas: baseFee.mul(2),
                maxPriorityFeePerGas: priorityFees.slow
            },
            standard: {
                maxFeePerGas: baseFee.mul(2).add(priorityFees.standard),
                maxPriorityFeePerGas: priorityFees.standard
            },
            fast: {
                maxFeePerGas: baseFee.mul(2).add(priorityFees.fast),
                maxPriorityFeePerGas: priorityFees.fast
            },
            instant: {
                maxFeePerGas: baseFee.mul(3).add(priorityFees.instant),
                maxPriorityFeePerGas: priorityFees.instant
            }
        };
        
        // Track base fee history
        this.baseFeeHistory.push(baseFee);
        if (this.baseFeeHistory.length > 20) {
            this.baseFeeHistory.shift();
        }
    }
    
    async updateLegacyGasPrice() {
        const gasPrice = await this.provider.getGasPrice();
        
        this.currentGasPrice = {
            type: 'legacy',
            slow: gasPrice.mul(90).div(100), // 90% of current
            standard: gasPrice,
            fast: gasPrice.mul(110).div(100), // 110% of current
            instant: gasPrice.mul(130).div(100) // 130% of current
        };
    }
    
    async calculatePriorityFees() {
        try {
            // Get recent blocks to analyze priority fees
            const blockCount = 5;
            const blocks = [];
            const latest = await this.provider.getBlockNumber();
            
            for (let i = 0; i < blockCount; i++) {
                const block = await this.provider.getBlockWithTransactions(latest - i);
                blocks.push(block);
            }
            
            // Extract priority fees from transactions
            const priorityFees = [];
            
            for (const block of blocks) {
                for (const tx of block.transactions) {
                    if (tx.type === 2 && tx.maxPriorityFeePerGas) {
                        priorityFees.push(tx.maxPriorityFeePerGas);
                    }
                }
            }
            
            // Sort and calculate percentiles
            priorityFees.sort((a, b) => a.sub(b));
            
            return {
                slow: this.getPercentile(priorityFees, 25) || ethers.utils.parseUnits('1', 'gwei'),
                standard: this.getPercentile(priorityFees, 50) || ethers.utils.parseUnits('2', 'gwei'),
                fast: this.getPercentile(priorityFees, 75) || ethers.utils.parseUnits('3', 'gwei'),
                instant: this.getPercentile(priorityFees, 95) || ethers.utils.parseUnits('5', 'gwei')
            };
            
        } catch (error) {
            // Fallback to default values
            return {
                slow: ethers.utils.parseUnits('1', 'gwei'),
                standard: ethers.utils.parseUnits('2', 'gwei'),
                fast: ethers.utils.parseUnits('3', 'gwei'),
                instant: ethers.utils.parseUnits('5', 'gwei')
            };
        }
    }
    
    getPercentile(array, percentile) {
        if (array.length === 0) return null;
        
        const index = Math.ceil(array.length * (percentile / 100)) - 1;
        return array[Math.max(0, index)];
    }
    
    async getOptimalGasPrice(priority = 'standard') {
        if (!this.currentGasPrice) {
            await this.updateGasPrice();
        }
        
        if (this.currentGasPrice.type === 'eip1559') {
            return this.currentGasPrice[priority];
        } else {
            return this.currentGasPrice[priority];
        }
    }
    
    async estimateGasForTransaction(tx, priority = 'standard') {
        const gasPrice = await this.getOptimalGasPrice(priority);
        let gasLimit;
        
        try {
            gasLimit = await this.provider.estimateGas(tx);
            // Add 20% buffer
            gasLimit = gasLimit.mul(120).div(100);
        } catch (error) {
            logger.error('Gas estimation failed', error);
            gasLimit = ethers.BigNumber.from(500000); // Fallback
        }
        
        let gasCost;
        
        if (this.currentGasPrice.type === 'eip1559') {
            gasCost = gasPrice.maxFeePerGas.mul(gasLimit);
        } else {
            gasCost = gasPrice.mul(gasLimit);
        }
        
        return {
            gasLimit,
            gasPrice,
            gasCost,
            gasCostETH: ethers.utils.formatEther(gasCost)
        };
    }
    
    getGasPriceStats() {
        if (this.gasPriceHistory.length === 0) {
            return null;
        }
        
        const recent = this.gasPriceHistory.slice(-20);
        const prices = recent.map(h => {
            if (h.gasPrice.type === 'eip1559') {
                return h.gasPrice.standard.maxFeePerGas;
            } else {
                return h.gasPrice.standard;
            }
        });
        
        const sum = prices.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));
        const avg = sum.div(prices.length);
        
        const min = prices.reduce((a, b) => a.lt(b) ? a : b);
        const max = prices.reduce((a, b) => a.gt(b) ? a : b);
        
        return {
            current: this.formatGasPrice(this.currentGasPrice?.standard),
            average: ethers.utils.formatUnits(avg, 'gwei'),
            min: ethers.utils.formatUnits(min, 'gwei'),
            max: ethers.utils.formatUnits(max, 'gwei'),
            trend: this.calculateTrend()
        };
    }
    
    formatGasPrice(gasPrice) {
        if (!gasPrice) return 'N/A';
        
        if (gasPrice.maxFeePerGas) {
            return `${ethers.utils.formatUnits(gasPrice.maxFeePerGas, 'gwei')} gwei`;
        } else {
            return `${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`;
        }
    }
    
    calculateTrend() {
        if (this.gasPriceHistory.length < 5) {
            return 'stable';
        }
        
        const recent = this.gasPriceHistory.slice(-5);
        const first = recent[0];
        const last = recent[recent.length - 1];
        
        let firstPrice, lastPrice;
        
        if (first.gasPrice.type === 'eip1559') {
            firstPrice = first.gasPrice.standard.maxFeePerGas;
            lastPrice = last.gasPrice.standard.maxFeePerGas;
        } else {
            firstPrice = first.gasPrice.standard;
            lastPrice = last.gasPrice.standard;
        }
        
        const change = lastPrice.sub(firstPrice).mul(100).div(firstPrice);
        
        if (change.gt(10)) return 'rising';
        if (change.lt(-10)) return 'falling';
        return 'stable';
    }
    
    shouldExecuteTrade(opportunity, gasEstimate) {
        // Check if gas cost is acceptable for the opportunity
        const maxGasPrice = this.bot.config.risk.maxGasGwei 
            ? ethers.utils.parseUnits(this.bot.config.risk.maxGasGwei.toString(), 'gwei')
            : ethers.utils.parseUnits('100', 'gwei');
        
        const currentGas = this.currentGasPrice?.standard;
        
        if (currentGas) {
            const gasPrice = currentGas.maxFeePerGas || currentGas;
            if (gasPrice.gt(maxGasPrice)) {
                logger.warn('Gas price too high for trade', {
                    current: ethers.utils.formatUnits(gasPrice, 'gwei'),
                    max: ethers.utils.formatUnits(maxGasPrice, 'gwei')
                });
                return false;
            }
        }
        
        // Check if profit covers gas
        const minProfitRatio = this.bot.config.risk.minProfitRatio || 1.5;
        const profitToGasRatio = opportunity.expectedProfit.mul(100).div(gasEstimate.gasCost);
        
        if (profitToGasRatio.lt(minProfitRatio * 100)) {
            logger.debug('Profit to gas ratio too low', {
                ratio: profitToGasRatio.toString(),
                required: minProfitRatio * 100
            });
            return false;
        }
        
        return true;
    }
}

module.exports = { GasManager };