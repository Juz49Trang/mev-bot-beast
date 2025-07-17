const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { UniswapV3 } = require('./UniswapV3');
const { SushiSwap } = require('./SushiSwap');
const { Curve } = require('./Curve');

class DEXAggregator {
    constructor(bot) {
        this.bot = bot;
        this.provider = bot.getProvider();
        
        // Initialize DEX adapters
        this.dexes = new Map();
        this.initializeDEXes();
        
        // Cache for quotes
        this.quoteCache = new Map();
        this.cacheDuration = 1000; // 1 second
        
        logger.info('DEX Aggregator initialized', {
            dexes: Array.from(this.dexes.keys())
        });
    }
    
    initializeDEXes() {
        // Initialize each DEX adapter
        const dexConfigs = this.bot.config.dexes || {};
        
        if (dexConfigs.uniswapV3) {
            this.dexes.set('uniswapV3', new UniswapV3(this.provider, dexConfigs.uniswapV3));
        }
        
        if (dexConfigs.sushiswap) {
            this.dexes.set('sushiswap', new SushiSwap(this.provider, dexConfigs.sushiswap));
        }
        
        if (dexConfigs.curve) {
            this.dexes.set('curve', new Curve(this.provider, dexConfigs.curve));
        }
        
        // Add more DEXes as needed
    }
    
    async getBestQuote(tokenIn, tokenOut, amountIn) {
        const quotes = await this.getQuotesFromAllDexs(tokenIn, tokenOut, amountIn);
        
        if (quotes.length === 0) {
            return null;
        }
        
        // Sort by output amount (descending)
        quotes.sort((a, b) => b.outputAmount.sub(a.outputAmount));
        
        return quotes[0];
    }
    
    async getQuotesFromAllDexs(tokenIn, tokenOut, amountIn) {
        // Check cache first
        const cacheKey = `${tokenIn}-${tokenOut}-${amountIn.toString()}`;
        const cached = this.quoteCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
            return cached.quotes;
        }
        
        // Get quotes from all DEXes in parallel
        const quotePromises = [];
        
        for (const [name, dex] of this.dexes) {
            quotePromises.push(
                this.getQuoteFromDex(name, dex, tokenIn, tokenOut, amountIn)
            );
        }
        
        const results = await Promise.allSettled(quotePromises);
        const quotes = results
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);
        
        // Cache results
        this.quoteCache.set(cacheKey, {
            quotes,
            timestamp: Date.now()
        });
        
        // Clean old cache entries
        this.cleanCache();
        
        return quotes;
    }
    
    async getQuoteFromDex(dexName, dex, tokenIn, tokenOut, amountIn) {
        try {
            const quote = await dex.getQuote(tokenIn, tokenOut, amountIn);
            
            if (!quote || quote.outputAmount.eq(0)) {
                return null;
            }
            
            return {
                dex: dexName,
                tokenIn,
                tokenOut,
                amountIn,
                outputAmount: quote.outputAmount,
                path: quote.path || [tokenIn, tokenOut],
                poolFees: quote.poolFees || [],
                priceImpact: quote.priceImpact || 0,
                gasEstimate: quote.gasEstimate || ethers.BigNumber.from(200000),
                data: quote.data, // Encoded swap data
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.debug(`Failed to get quote from ${dexName}`, {
                error: error.message,
                tokenIn,
                tokenOut
            });
            return null;
        }
    }
    
    async getQuote(dexName, tokenIn, tokenOut, amountIn) {
        const dex = this.dexes.get(dexName);
        
        if (!dex) {
            throw new Error(`DEX ${dexName} not found`);
        }
        
        return this.getQuoteFromDex(dexName, dex, tokenIn, tokenOut, amountIn);
    }
    
    async findBestPath(tokenIn, tokenOut, amountIn, maxHops = 3) {
        // Find the best path across all DEXes, including multi-hop routes
        const directQuote = await this.getBestQuote(tokenIn, tokenOut, amountIn);
        
        if (maxHops === 1 || !this.bot.config.dexes.enableMultiHop) {
            return directQuote;
        }
        
        // Try multi-hop paths
        const intermediateTokens = this.getIntermediateTokens(tokenIn, tokenOut);
        const multiHopQuotes = [];
        
        for (const intermediate of intermediateTokens) {
            try {
                // First hop
                const firstHop = await this.getBestQuote(tokenIn, intermediate, amountIn);
                
                if (!firstHop) continue;
                
                // Second hop
                const secondHop = await this.getBestQuote(
                    intermediate,
                    tokenOut,
                    firstHop.outputAmount
                );
                
                if (!secondHop) continue;
                
                // Combine quotes
                const combinedQuote = {
                    type: 'multi-hop',
                    dex: `${firstHop.dex}-${secondHop.dex}`,
                    tokenIn,
                    tokenOut,
                    amountIn,
                    outputAmount: secondHop.outputAmount,
                    path: [tokenIn, intermediate, tokenOut],
                    hops: [firstHop, secondHop],
                    gasEstimate: firstHop.gasEstimate.add(secondHop.gasEstimate),
                    timestamp: Date.now()
                };
                
                multiHopQuotes.push(combinedQuote);
                
            } catch (error) {
                // Continue with other paths
            }
        }
        
        // Compare direct and multi-hop quotes
        const allQuotes = directQuote ? [directQuote, ...multiHopQuotes] : multiHopQuotes;
        
        if (allQuotes.length === 0) {
            return null;
        }
        
        // Sort by output amount minus gas costs
        allQuotes.sort((a, b) => {
            const gasPrice = ethers.utils.parseUnits('30', 'gwei'); // Estimate
            const aCost = a.outputAmount.sub(a.gasEstimate.mul(gasPrice));
            const bCost = b.outputAmount.sub(b.gasEstimate.mul(gasPrice));
            return bCost.sub(aCost);
        });
        
        return allQuotes[0];
    }
    
    getIntermediateTokens(tokenIn, tokenOut) {
        // Common intermediate tokens for routing
        const commonTokens = [
            this.bot.config.tokens.WETH,
            this.bot.config.tokens.USDC,
            this.bot.config.tokens.USDT,
            this.bot.config.tokens.DAI,
            this.bot.config.tokens.WBTC
        ].filter(token => token !== tokenIn && token !== tokenOut);
        
        return commonTokens;
    }
    
    async getTokenPrice(token, baseToken = null) {
        // Get token price in terms of base token (default: USDC)
        const base = baseToken || this.bot.config.tokens.USDC;
        
        if (token === base) {
            return 1;
        }
        
        // Try to get price from DEXes
        const amount = ethers.utils.parseUnits('1', 18); // 1 token
        const quote = await this.getBestQuote(token, base, amount);
        
        if (!quote) {
            return 0;
        }
        
        // Calculate price (assuming USDC has 6 decimals)
        const price = parseFloat(ethers.utils.formatUnits(quote.outputAmount, 6));
        
        return price;
    }
    
    async estimateGas(dexName, tokenIn, tokenOut, amountIn) {
        const dex = this.dexes.get(dexName);
        
        if (!dex || !dex.estimateGas) {
            return ethers.BigNumber.from(200000); // Default estimate
        }
        
        try {
            return await dex.estimateGas(tokenIn, tokenOut, amountIn);
        } catch (error) {
            return ethers.BigNumber.from(200000);
        }
    }
    
    async buildSwapTransaction(quote, recipient, slippageBps = 50) {
        const dex = this.dexes.get(quote.dex);
        
        if (!dex || !dex.buildSwapTx) {
            throw new Error(`DEX ${quote.dex} doesn't support transaction building`);
        }
        
        // Calculate minimum output with slippage
        const minOutput = quote.outputAmount
            .mul(10000 - slippageBps)
            .div(10000);
        
        return dex.buildSwapTx({
            ...quote,
            recipient,
            minOutput,
            deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
        });
    }
    
    cleanCache() {
        // Remove old cache entries
        const now = Date.now();
        const maxAge = 5000; // 5 seconds
        
        for (const [key, value] of this.quoteCache) {
            if (now - value.timestamp > maxAge) {
                this.quoteCache.delete(key);
            }
        }
        
        // Limit cache size
        if (this.quoteCache.size > 1000) {
            // Remove oldest entries
            const entries = Array.from(this.quoteCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            for (let i = 0; i < 500; i++) {
                this.quoteCache.delete(entries[i][0]);
            }
        }
    }
    
    getStats() {
        const stats = {};
        
        for (const [name, dex] of this.dexes) {
            if (dex.getStats) {
                stats[name] = dex.getStats();
            } else {
                stats[name] = { available: true };
            }
        }
        
        return {
            dexes: stats,
            cacheSize: this.quoteCache.size
        };
    }
}

module.exports = { DEXAggregator };