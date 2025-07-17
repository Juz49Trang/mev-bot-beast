const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class Curve {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        
        // Contract addresses
        this.contracts = {
            router: config.router,
            registry: config.registry
        };
        
        // Pool cache
        this.poolCache = new Map();
        
        // Common pools
        this.commonPools = {
            '3pool': '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // DAI/USDC/USDT
            'tricrypto': '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46' // USDT/WBTC/ETH
        };
        
        logger.info('Curve adapter initialized');
    }
    
    async getQuote(tokenIn, tokenOut, amountIn) {
        try {
            // Find the best pool for this pair
            const pool = await this.findBestPool(tokenIn, tokenOut);
            
            if (!pool) {
                return null;
            }
            
            // Get quote from pool
            const quote = await this.getPoolQuote(pool, tokenIn, tokenOut, amountIn);
            
            if (!quote || quote.outputAmount.eq(0)) {
                return null;
            }
            
            return {
                outputAmount: quote.outputAmount,
                pool: pool.address,
                poolType: pool.type,
                gasEstimate: ethers.BigNumber.from(250000), // Curve uses more gas
                data: await this.encodeSwapData(pool, tokenIn, tokenOut, amountIn)
            };
            
        } catch (error) {
            logger.debug('Failed to get Curve quote', {
                error: error.message,
                tokenIn,
                tokenOut
            });
            return null;
        }
    }
    
    async findBestPool(tokenA, tokenB) {
        // Check cache first
        const cacheKey = `${tokenA}-${tokenB}`;
        if (this.poolCache.has(cacheKey)) {
            return this.poolCache.get(cacheKey);
        }
        
        try {
            // Check common pools first
            for (const [name, address] of Object.entries(this.commonPools)) {
                const pool = await this.getPoolInfo(address);
                if (pool && this.poolSupportsTokens(pool, tokenA, tokenB)) {
                    this.poolCache.set(cacheKey, pool);
                    return pool;
                }
            }
            
            // Query registry for pool
            if (this.contracts.registry) {
                const registryContract = new ethers.Contract(
                    this.contracts.registry,
                    [
                        'function find_pool_for_coins(address from, address to) view returns (address)'
                    ],
                    this.provider
                );
                
                const poolAddress = await registryContract.find_pool_for_coins(tokenA, tokenB);
                
                if (poolAddress !== ethers.constants.AddressZero) {
                    const pool = await this.getPoolInfo(poolAddress);
                    this.poolCache.set(cacheKey, pool);
                    return pool;
                }
            }
            
            return null;
            
        } catch (error) {
            logger.debug('Error finding Curve pool', error);
            return null;
        }
    }
    
    async getPoolInfo(poolAddress) {
        try {
            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function coins(uint256) view returns (address)',
                    'function balances(uint256) view returns (uint256)',
                    'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)'
                ],
                this.provider
            );
            
            // Get pool coins
            const coins = [];
            for (let i = 0; i < 4; i++) {
                try {
                    const coin = await poolContract.coins(i);
                    if (coin === ethers.constants.AddressZero) break;
                    coins.push(coin);
                } catch {
                    break;
                }
            }
            
            return {
                address: poolAddress,
                coins,
                type: coins.length === 2 ? 'plain' : 'meta',
                contract: poolContract
            };
            
        } catch (error) {
            return null;
        }
    }
    
    poolSupportsTokens(pool, tokenA, tokenB) {
        return pool.coins.includes(tokenA) && pool.coins.includes(tokenB);
    }
    
    async getPoolQuote(pool, tokenIn, tokenOut, amountIn) {
        try {
            const i = pool.coins.indexOf(tokenIn);
            const j = pool.coins.indexOf(tokenOut);
            
            if (i === -1 || j === -1) {
                return null;
            }
            
            const outputAmount = await pool.contract.get_dy(i, j, amountIn);
            
            return {
                outputAmount,
                i,
                j
            };
            
        } catch (error) {
            logger.debug('Error getting pool quote', error);
            return null;
        }
    }
    
    async encodeSwapData(pool, tokenIn, tokenOut, amountIn) {
        const i = pool.coins.indexOf(tokenIn);
        const j = pool.coins.indexOf(tokenOut);
        
        // Encode exchange function call
        const iface = new ethers.utils.Interface([
            'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)'
        ]);
        
        return iface.encodeFunctionData('exchange', [
            i,
            j,
            amountIn,
            0 // min_dy will be set by executor
        ]);
    }
    
    async buildSwapTx(quote) {
        const { pool, tokenIn, tokenOut, amountIn, minOutput } = quote;
        
        const poolInfo = await this.getPoolInfo(pool);
        const i = poolInfo.coins.indexOf(tokenIn);
        const j = poolInfo.coins.indexOf(tokenOut);
        
        const iface = new ethers.utils.Interface([
            'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)'
        ]);
        
        return {
            to: pool,
            data: iface.encodeFunctionData('exchange', [i, j, amountIn, minOutput]),
            value: 0,
            gasLimit: ethers.BigNumber.from(300000)
        };
    }
    
    async estimateGas(tokenIn, tokenOut, amountIn) {
        // Curve swaps typically use more gas
        return ethers.BigNumber.from(250000);
    }
    
    getStats() {
        return {
            available: true,
            poolsCached: this.poolCache.size
        };
    }
}

module.exports = { Curve };