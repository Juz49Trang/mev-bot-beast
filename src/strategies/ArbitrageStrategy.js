const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { DEXAggregator } = require('../dex/DEXAggregator');
const { calculateOptimalAmount } = require('../utils/helpers');

class ArbitrageStrategy extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.config = bot.config.strategies.arbitrage;
        this.dexAggregator = new DEXAggregator(bot);
        
        // State
        this.isRunning = false;
        this.priceFeeds = new Map();
        this.opportunities = new Map();
        
        // Arbitrage paths
        this.paths = this.initializePaths();
        
        // Performance tracking
        this.stats = {
            opportunitiesFound: 0,
            opportunitiesExecuted: 0,
            totalProfit: ethers.BigNumber.from(0),
            successRate: 0
        };
        
        // Price deviation threshold (in basis points)
        this.minProfitBps = this.config.minProfitBps || 10; // 0.1%
        
        logger.info('Arbitrage strategy initialized', {
            paths: this.paths.length,
            minProfitBps: this.minProfitBps
        });
    }
    
    initializePaths() {
        const paths = [];
        
        // Simple triangular arbitrage paths
        const tokens = this.config.tokens || [
            this.bot.config.tokens.WETH,
            this.bot.config.tokens.USDC,
            this.bot.config.tokens.USDT,
            this.bot.config.tokens.DAI
        ];
        
        // Generate all possible triangular paths
        for (let i = 0; i < tokens.length; i++) {
            for (let j = 0; j < tokens.length; j++) {
                for (let k = 0; k < tokens.length; k++) {
                    if (i !== j && j !== k && i === k) {
                        paths.push({
                            tokens: [tokens[i], tokens[j], tokens[k]],
                            type: 'triangular'
                        });
                    }
                }
            }
        }
        
        // Add direct arbitrage paths (same pair, different DEXs)
        for (let i = 0; i < tokens.length; i++) {
            for (let j = i + 1; j < tokens.length; j++) {
                paths.push({
                    tokens: [tokens[i], tokens[j]],
                    type: 'direct'
                });
            }
        }
        
        return paths;
    }
    
    async start() {
        if (this.isRunning) {
            return;
        }
        
        logger.info('Starting arbitrage strategy...');
        
        // Subscribe to relevant events
        this.subscribeToEvents();
        
        // Start continuous arbitrage scanning
        this.startContinuousScanning();
        
        // Start price monitoring
        this.startPriceMonitoring();
        
        this.isRunning = true;
        logger.info('Arbitrage strategy started');
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        logger.info('Stopping arbitrage strategy...');
        
        // Clear intervals
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        
        if (this.priceInterval) {
            clearInterval(this.priceInterval);
        }
        
        this.isRunning = false;
        logger.info('Arbitrage strategy stopped');
    }
    
    subscribeToEvents() {
        // Listen for swap events from monitor
        this.bot.monitor.on('swap', async (tx) => {
            try {
                await this.analyzeSwapImpact(tx);
            } catch (error) {
                logger.error('Error analyzing swap impact', error);
            }
        });
        
        // Listen for high-value transactions
        this.bot.monitor.on('highValue', async (tx) => {
            try {
                await this.checkImmediateArbitrage(tx);
            } catch (error) {
                logger.error('Error checking immediate arbitrage', error);
            }
        });
        
        // Listen for gas updates
        this.bot.monitor.on('gasUpdate', (gasInfo) => {
            this.updateProfitThresholds(gasInfo);
        });
    }
    
    startContinuousScanning() {
        const scanInterval = this.config.scanInterval || 1000; // 1 second default
        
        this.scanInterval = setInterval(async () => {
            try {
                await this.scanAllPaths();
            } catch (error) {
                logger.error('Error in continuous scanning', error);
            }
        }, scanInterval);
    }
    
    startPriceMonitoring() {
        const priceInterval = this.config.priceUpdateInterval || 500; // 500ms default
        
        this.priceInterval = setInterval(async () => {
            try {
                await this.updatePrices();
            } catch (error) {
                logger.error('Error updating prices', error);
            }
        }, priceInterval);
    }
    
    async scanAllPaths() {
        const scanPromises = this.paths.map(path => this.analyzePath(path));
        const results = await Promise.allSettled(scanPromises);
        
        // Process results
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled' && results[i].value) {
                const opportunity = results[i].value;
                await this.processOpportunity(opportunity);
            }
        }
    }
    
    async analyzePath(path) {
        try {
            if (path.type === 'triangular') {
                return this.analyzeTriangularPath(path);
            } else if (path.type === 'direct') {
                return this.analyzeDirectPath(path);
            }
        } catch (error) {
            logger.debug('Error analyzing path', { path, error: error.message });
            return null;
        }
    }
    
    async analyzeTriangularPath(path) {
        const { tokens } = path;
        const amount = this.getOptimalStartAmount(tokens[0]);
        
        // Get quotes for each step
        const quotes = [];
        let currentAmount = amount;
        
        for (let i = 0; i < tokens.length - 1; i++) {
            const fromToken = tokens[i];
            const toToken = tokens[i + 1];
            
            const quote = await this.dexAggregator.getBestQuote(
                fromToken,
                toToken,
                currentAmount
            );
            
            if (!quote || quote.outputAmount.eq(0)) {
                return null;
            }
            
            quotes.push(quote);
            currentAmount = quote.outputAmount;
        }
        
        // Calculate profit
        const finalAmount = currentAmount;
        const profit = finalAmount.sub(amount);
        const profitBps = profit.mul(10000).div(amount);
        
        // Check if profitable
        if (profitBps.lt(this.minProfitBps)) {
            return null;
        }
        
        // Calculate gas costs
        const estimatedGas = this.estimateGasForPath(quotes);
        const gasPrice = await this.bot.getGasPrice();
        const gasCost = estimatedGas.mul(gasPrice);
        
        // Calculate net profit
        const netProfit = profit.sub(gasCost);
        
        if (netProfit.lte(0)) {
            return null;
        }
        
        // Build opportunity
        return {
            type: 'triangular-arbitrage',
            strategy: 'arbitrage',
            path: tokens,
            quotes: quotes,
            inputAmount: amount,
            outputAmount: finalAmount,
            profit: profit,
            netProfit: netProfit,
            profitBps: profitBps.toNumber(),
            gasCost: gasCost,
            estimatedGas: estimatedGas,
            timestamp: Date.now(),
            expectedProfit: netProfit
        };
    }
    
    async analyzeDirectPath(path) {
        const [tokenA, tokenB] = path.tokens;
        const amount = this.getOptimalStartAmount(tokenA);
        
        // Get quotes from different DEXs
        const quotes = await this.dexAggregator.getQuotesFromAllDexs(
            tokenA,
            tokenB,
            amount
        );
        
        if (quotes.length < 2) {
            return null;
        }
        
        // Sort by output amount
        quotes.sort((a, b) => b.outputAmount.sub(a.outputAmount));
        
        // Calculate arbitrage opportunity
        const bestBuy = quotes[quotes.length - 1]; // Lowest output (best to buy)
        const bestSell = quotes[0]; // Highest output (best to sell)
        
        // Check if there's a price difference
        const priceDiff = bestSell.outputAmount.sub(bestBuy.outputAmount);
        const priceDiffBps = priceDiff.mul(10000).div(bestBuy.outputAmount);
        
        if (priceDiffBps.lt(this.minProfitBps)) {
            return null;
        }
        
        // Build arbitrage path
        // Buy on DEX with lower price, sell on DEX with higher price
        const buyQuote = await this.dexAggregator.getQuote(
            bestBuy.dex,
            tokenB,
            tokenA,
            bestBuy.outputAmount
        );
        
        if (!buyQuote) {
            return null;
        }
        
        const profit = amount.sub(buyQuote.outputAmount);
        
        // Calculate gas costs
        const estimatedGas = ethers.BigNumber.from(300000); // Approximate
        const gasPrice = await this.bot.getGasPrice();
        const gasCost = estimatedGas.mul(gasPrice);
        
        const netProfit = profit.sub(gasCost);
        
        if (netProfit.lte(0)) {
            return null;
        }
        
        return {
            type: 'direct-arbitrage',
            strategy: 'arbitrage',
            buyDex: bestBuy.dex,
            sellDex: bestSell.dex,
            tokenA: tokenA,
            tokenB: tokenB,
            amount: amount,
            buyQuote: bestBuy,
            sellQuote: bestSell,
            profit: profit,
            netProfit: netProfit,
            profitBps: priceDiffBps.toNumber(),
            gasCost: gasCost,
            estimatedGas: estimatedGas,
            timestamp: Date.now(),
            expectedProfit: netProfit
        };
    }
    
    async analyzeSwapImpact(swapTx) {
        // Analyze the impact of a large swap on arbitrage opportunities
        if (!swapTx.decoded || swapTx.decoded.type !== 'swap') {
            return;
        }
        
        try {
            // Extract swap details
            const { tokenIn, tokenOut, amountIn } = swapTx.decoded;
            
            // Check if this swap creates arbitrage opportunities
            const relatedPaths = this.paths.filter(path => 
                path.tokens.includes(tokenIn) || path.tokens.includes(tokenOut)
            );
            
            // Analyze each related path with urgency
            for (const path of relatedPaths) {
                const opportunity = await this.analyzePath(path);
                
                if (opportunity) {
                    opportunity.trigger = 'swap-impact';
                    opportunity.triggerTx = swapTx.hash;
                    opportunity.priority = 'high';
                    
                    await this.processOpportunity(opportunity);
                }
            }
            
        } catch (error) {
            logger.error('Error analyzing swap impact', error);
        }
    }
    
    async checkImmediateArbitrage(tx) {
        // Quick check for immediate arbitrage after high-value transactions
        const quickPaths = this.paths.filter(p => p.type === 'direct').slice(0, 5);
        
        const promises = quickPaths.map(path => this.analyzePath(path));
        const opportunities = await Promise.allSettled(promises);
        
        for (const result of opportunities) {
            if (result.status === 'fulfilled' && result.value) {
                result.value.priority = 'high';
                result.value.trigger = 'high-value-tx';
                await this.processOpportunity(result.value);
            }
        }
    }
    
    async processOpportunity(opportunity) {
        try {
            this.stats.opportunitiesFound++;
            
            // Check if opportunity is still valid
            if (Date.now() - opportunity.timestamp > 5000) {
                logger.debug('Opportunity expired', { age: Date.now() - opportunity.timestamp });
                return;
            }
            
            // Check if we're already processing a similar opportunity
            const opportunityKey = this.getOpportunityKey(opportunity);
            
            if (this.opportunities.has(opportunityKey)) {
                const existing = this.opportunities.get(opportunityKey);
                if (Date.now() - existing.timestamp < 1000) {
                    return; // Skip duplicate
                }
            }
            
            // Store opportunity
            this.opportunities.set(opportunityKey, opportunity);
            
            // Clean old opportunities
            this.cleanOldOpportunities();
            
            // Log opportunity
            logger.info('Arbitrage opportunity found', {
                type: opportunity.type,
                profit: ethers.utils.formatEther(opportunity.netProfit),
                profitBps: opportunity.profitBps,
                trigger: opportunity.trigger || 'scan'
            });
            
            // Emit for execution
            this.emit('opportunity', opportunity);
            
        } catch (error) {
            logger.error('Error processing opportunity', error);
        }
    }
    
    async updatePrices() {
        // Update price feeds for monitored tokens
        const tokens = [...new Set(this.paths.flatMap(p => p.tokens))];
        
        const pricePromises = tokens.map(async (token) => {
            try {
                const price = await this.dexAggregator.getTokenPrice(token);
                this.priceFeeds.set(token, {
                    price,
                    timestamp: Date.now()
                });
            } catch (error) {
                // Keep old price if update fails
            }
        });
        
        await Promise.allSettled(pricePromises);
    }
    
    updateProfitThresholds(gasInfo) {
        // Adjust profit thresholds based on gas prices
        const baseThreshold = this.config.minProfitBps || 10;
        const gasMultiplier = gasInfo.gasPriceGwei / 30; // Normalize to 30 gwei
        
        this.minProfitBps = Math.ceil(baseThreshold * Math.max(1, gasMultiplier));
        
        logger.debug('Updated profit threshold', {
            minProfitBps: this.minProfitBps,
            gasPrice: gasInfo.gasPriceGwei
        });
    }
    
    getOptimalStartAmount(token) {
        // Calculate optimal amount based on liquidity and gas costs
        const config = this.config.amounts || {};
        const defaultAmount = ethers.utils.parseEther('1');
        
        // Use configured amounts
        if (config[token]) {
            return ethers.BigNumber.from(config[token]);
        }
        
        // Use price-based calculation
        const priceInfo = this.priceFeeds.get(token);
        if (priceInfo && priceInfo.price) {
            // Target ~$1000-5000 USD value
            const targetUSD = 2500;
            const tokenPrice = priceInfo.price;
            
            if (tokenPrice > 0) {
                const amount = ethers.utils.parseEther(
                    (targetUSD / tokenPrice).toFixed(6)
                );
                return amount;
            }
        }
        
        return defaultAmount;
    }
    
    estimateGasForPath(quotes) {
        // Estimate gas based on number of swaps and DEX types
        let totalGas = ethers.BigNumber.from(50000); // Base gas
        
        for (const quote of quotes) {
            const dexGas = this.getDexGasEstimate(quote.dex);
            totalGas = totalGas.add(dexGas);
        }
        
        // Add buffer for safety
        return totalGas.mul(120).div(100); // 20% buffer
    }
    
    getDexGasEstimate(dex) {
        const gasEstimates = {
            'uniswapV3': 180000,
            'uniswapV2': 150000,
            'sushiswap': 150000,
            'curve': 250000,
            'balancer': 200000
        };
        
        return ethers.BigNumber.from(gasEstimates[dex] || 200000);
    }
    
    getOpportunityKey(opportunity) {
        if (opportunity.type === 'triangular-arbitrage') {
            return `tri-${opportunity.path.join('-')}`;
        } else if (opportunity.type === 'direct-arbitrage') {
            return `direct-${opportunity.tokenA}-${opportunity.tokenB}-${opportunity.buyDex}-${opportunity.sellDex}`;
        }
        
        return `${opportunity.type}-${Date.now()}`;
    }
    
    cleanOldOpportunities() {
        const maxAge = 10000; // 10 seconds
        const now = Date.now();
        
        for (const [key, opp] of this.opportunities) {
            if (now - opp.timestamp > maxAge) {
                this.opportunities.delete(key);
            }
        }
    }
    
    // Calculate actual profit from receipt
    async calculateProfit(receipt, opportunity) {
        try {
            // Parse transfer events to calculate actual profit
            const transferEvents = receipt.logs.filter(log => 
                log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
            );
            
            if (opportunity.type === 'triangular-arbitrage') {
                // Find first and last transfer of the starting token
                const startToken = opportunity.path[0];
                const relevantTransfers = transferEvents.filter(log => 
                    log.address.toLowerCase() === startToken.toLowerCase()
                );
                
                if (relevantTransfers.length >= 2) {
                    const firstTransfer = ethers.BigNumber.from(relevantTransfers[0].data);
                    const lastTransfer = ethers.BigNumber.from(
                        relevantTransfers[relevantTransfers.length - 1].data
                    );
                    
                    return lastTransfer.sub(firstTransfer);
                }
            }
            
            // Fallback: use gas calculation
            const gasUsed = receipt.gasUsed;
            const gasPrice = receipt.effectiveGasPrice || opportunity.gasPrice;
            const gasCost = gasUsed.mul(gasPrice);
            
            return opportunity.expectedProfit.sub(gasCost);
            
        } catch (error) {
            logger.error('Error calculating actual profit', error);
            return ethers.BigNumber.from(0);
        }
    }
    
    getStats() {
        return {
            ...this.stats,
            currentOpportunities: this.opportunities.size,
            priceFeeds: this.priceFeeds.size,
            isRunning: this.isRunning,
            minProfitBps: this.minProfitBps,
            pathsMonitored: this.paths.length
        };
    }
}