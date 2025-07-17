const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class CrossChainArbitrage extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.config = bot.config.strategies.crossChain || {};
        
        this.isRunning = false;
        this.chains = new Map();
        this.bridges = new Map();
        this.priceFeeds = new Map();
        
        // Supported chains
        this.supportedChains = ['base', 'arbitrum', 'optimism'];
        
        // Bridge configurations
        this.bridgeConfigs = {
            'hop': {
                name: 'Hop Protocol',
                supportedTokens: ['USDC', 'USDT', 'DAI', 'ETH'],
                estimatedTime: 5 * 60 // 5 minutes
            },
            'stargate': {
                name: 'Stargate',
                supportedTokens: ['USDC', 'USDT', 'ETH'],
                estimatedTime: 2 * 60 // 2 minutes
            },
            'across': {
                name: 'Across Protocol',
                supportedTokens: ['USDC', 'WETH'],
                estimatedTime: 10 * 60 // 10 minutes
            }
        };
        
        logger.info('Cross-chain arbitrage strategy initialized');
    }
    
    async start() {
        if (this.isRunning) {
            return;
        }
        
        logger.info('Starting cross-chain arbitrage strategy...');
        
        // Initialize chain connections
        await this.initializeChains();
        
        // Start price monitoring
        this.startPriceMonitoring();
        
        // Start opportunity scanning
        this.startScanning();
        
        this.isRunning = true;
        logger.info('Cross-chain arbitrage strategy started');
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        
        if (this.priceInterval) {
            clearInterval(this.priceInterval);
        }
        
        this.isRunning = false;
        logger.info('Cross-chain arbitrage strategy stopped');
    }
    
    async initializeChains() {
        for (const chainName of this.supportedChains) {
            const chainConfig = this.bot.config.chains[chainName];
            
            if (chainConfig && chainConfig.enabled) {
                try {
                    const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpc.primary);
                    
                    this.chains.set(chainName, {
                        name: chainName,
                        chainId: chainConfig.chainId,
                        provider,
                        tokens: chainConfig.tokens,
                        dexes: chainConfig.dexes
                    });
                    
                    logger.info(`Initialized chain: ${chainName}`);
                } catch (error) {
                    logger.error(`Failed to initialize chain ${chainName}`, error);
                }
            }
        }
    }
    
    startPriceMonitoring() {
        const interval = this.config.priceUpdateInterval || 5000;
        
        this.priceInterval = setInterval(async () => {
            await this.updateAllPrices();
        }, interval);
        
        // Initial price fetch
        this.updateAllPrices();
    }
    
    startScanning() {
        const interval = this.config.scanInterval || 10000;
        
        this.scanInterval = setInterval(async () => {
            await this.scanForOpportunities();
        }, interval);
    }
    
    async updateAllPrices() {
        const tokens = ['USDC', 'USDT', 'DAI', 'WETH'];
        
        for (const [chainName, chain] of this.chains) {
            for (const token of tokens) {
                try {
                    const price = await this.getTokenPrice(chainName, token);
                    
                    if (price) {
                        const key = `${chainName}-${token}`;
                        this.priceFeeds.set(key, {
                            price,
                            timestamp: Date.now()
                        });
                    }
                } catch (error) {
                    logger.debug(`Error fetching price for ${token} on ${chainName}`, error);
                }
            }
        }
    }
    
    async getTokenPrice(chainName, tokenSymbol) {
        const chain = this.chains.get(chainName);
        if (!chain) return null;
        
        const tokenAddress = chain.tokens[tokenSymbol];
        if (!tokenAddress) return null;
        
        // Get price in USDC
        const usdcAddress = chain.tokens.USDC;
        
        try {
            // Use the bot's DEX aggregator if available
            // For now, return mock price
            const mockPrices = {
                'WETH': 3800,
                'USDC': 1,
                'USDT': 0.999,
                'DAI': 1.001
            };
            
            return mockPrices[tokenSymbol] || 0;
        } catch (error) {
            return null;
        }
    }
    
    async scanForOpportunities() {
        const tokens = ['USDC', 'USDT', 'DAI'];
        const minProfitUSD = this.config.minProfitUSD || 50;
        
        for (const token of tokens) {
            const opportunities = await this.findArbitrageForToken(token);
            
            for (const opp of opportunities) {
                if (opp.profitUSD >= minProfitUSD) {
                    logger.info('Cross-chain arbitrage opportunity found', {
                        token,
                        profit: `$${opp.profitUSD.toFixed(2)}`,
                        fromChain: opp.fromChain,
                        toChain: opp.toChain
                    });
                    
                    this.emit('opportunity', opp);
                }
            }
        }
    }
    
    async findArbitrageForToken(token) {
        const opportunities = [];
        const chains = Array.from(this.chains.keys());
        
        // Compare prices between all chain pairs
        for (let i = 0; i < chains.length; i++) {
            for (let j = i + 1; j < chains.length; j++) {
                const chainA = chains[i];
                const chainB = chains[j];
                
                const priceA = this.getLatestPrice(chainA, token);
                const priceB = this.getLatestPrice(chainB, token);
                
                if (!priceA || !priceB) continue;
                
                // Check both directions
                if (priceA < priceB) {
                    const opp = await this.calculateOpportunity(
                        token,
                        chainA,
                        chainB,
                        priceA,
                        priceB
                    );
                    
                    if (opp) opportunities.push(opp);
                }
                
                if (priceB < priceA) {
                    const opp = await this.calculateOpportunity(
                        token,
                        chainB,
                        chainA,
                        priceB,
                        priceA
                    );
                    
                    if (opp) opportunities.push(opp);
                }
            }
        }
        
        return opportunities;
    }
    
    getLatestPrice(chain, token) {
        const key = `${chain}-${token}`;
        const priceFeed = this.priceFeeds.get(key);
        
        if (!priceFeed) return null;
        
        // Check if price is fresh (< 30 seconds)
        if (Date.now() - priceFeed.timestamp > 30000) {
            return null;
        }
        
        return priceFeed.price;
    }
    
    async calculateOpportunity(token, fromChain, toChain, buyPrice, sellPrice) {
        const amount = 10000; // $10k USD worth
        const tokenAmount = amount / buyPrice;
        
        // Calculate gross profit
        const grossProfit = (sellPrice - buyPrice) * tokenAmount;
        
        // Estimate costs
        const costs = await this.estimateCosts(token, fromChain, toChain, amount);
        
        if (!costs) return null;
        
        const netProfit = grossProfit - costs.total;
        
        if (netProfit <= 0) return null;
        
        return {
            type: 'cross-chain-arbitrage',
            strategy: 'crossChain',
            token,
            fromChain,
            toChain,
            amount: amount,
            buyPrice,
            sellPrice,
            priceDiff: sellPrice - buyPrice,
            priceDiffPercent: ((sellPrice - buyPrice) / buyPrice * 100).toFixed(2),
            grossProfit,
            costs,
            netProfit,
            profitUSD: netProfit,
            expectedProfit: ethers.utils.parseEther((netProfit / 3800).toFixed(6)), // Convert to ETH
            estimatedTime: costs.bridgeTime,
            timestamp: Date.now()
        };
    }
    
    async estimateCosts(token, fromChain, toChain, amount) {
        try {
            // Bridge fee (usually 0.05% - 0.3%)
            const bridgeFeePercent = 0.001; // 0.1%
            const bridgeFee = amount * bridgeFeePercent;
            
            // Slippage on both sides (0.3% each)
            const slippage = amount * 0.006;
            
            // Gas costs
            const fromChainGas = await this.estimateGasCost(fromChain, 'swap');
            const toChainGas = await this.estimateGasCost(toChain, 'swap');
            const bridgeGas = await this.estimateGasCost(fromChain, 'bridge');
            
            // Convert gas to USD
            const ethPrice = 3800; // Should get from price feed
            const totalGasUSD = (fromChainGas + toChainGas + bridgeGas) * ethPrice;
            
            // Find best bridge
            const bridge = this.selectBestBridge(token, fromChain, toChain);
            
            if (!bridge) return null;
            
            return {
                bridgeFee,
                slippage,
                gasUSD: totalGasUSD,
                total: bridgeFee + slippage + totalGasUSD,
                bridge: bridge.name,
                bridgeTime: bridge.estimatedTime
            };
            
        } catch (error) {
            logger.error('Error estimating costs', error);
            return null;
        }
    }
    
    async estimateGasCost(chain, operation) {
        const gasEstimates = {
            'swap': 200000,
            'bridge': 300000,
            'approve': 50000
        };
        
        const chainGasPrices = {
            'base': 0.001, // Very low on L2s
            'arbitrum': 0.001,
            'optimism': 0.001,
            'ethereum': 30 // Much higher on mainnet
        };
        
        const gasLimit = gasEstimates[operation] || 200000;
        const gasPrice = chainGasPrices[chain] || 1;
        
        // Return cost in ETH
        return (gasLimit * gasPrice) / 1e9;
    }
    
    selectBestBridge(token, fromChain, toChain) {
        // Find bridges that support this token and route
        const availableBridges = [];
        
        for (const [name, config] of Object.entries(this.bridgeConfigs)) {
            if (config.supportedTokens.includes(token)) {
                availableBridges.push({
                    name,
                    ...config
                });
            }
        }
        
        // Sort by estimated time (fastest first)
        availableBridges.sort((a, b) => a.estimatedTime - b.estimatedTime);
        
        return availableBridges[0] || null;
    }
    
    async calculateProfit(receipt, opportunity) {
        // This would calculate actual profit from cross-chain execution
        // For now, return expected profit
        return opportunity.expectedProfit;
    }
    
    getStats() {
        return {
            isRunning: this.isRunning,
            chainsMonitored: this.chains.size,
            priceFeeds: this.priceFeeds.size,
            chains: Array.from(this.chains.keys())
        };
    }
}

module.exports = { CrossChainArbitrage };