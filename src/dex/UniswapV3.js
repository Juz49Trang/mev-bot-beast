const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class UniswapV3 {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        
        // Contract addresses
        this.contracts = {
            router: config.router,
            quoter: config.quoter,
            factory: config.factory
        };
        
        // Initialize contract instances
        this.quoter = new ethers.Contract(
            this.contracts.quoter,
            [
                'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
                'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'
            ],
            provider
        );
        
        this.router = new ethers.Contract(
            this.contracts.router,
            [
                'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
                'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) external payable returns (uint256 amountOut)',
                'function multicall(uint256 deadline, bytes[] data) external payable returns (bytes[] results)'
            ],
            provider
        );
        
        // Fee tiers
        this.feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
        
        // Pool cache
        this.poolCache = new Map();
        
        logger.info('UniswapV3 adapter initialized');
    }
    
    async getQuote(tokenIn, tokenOut, amountIn) {
        try {
            // Try different fee tiers
            let bestQuote = null;
            let bestOutput = ethers.BigNumber.from(0);
            
            for (const fee of this.feeTiers) {
                try {
                    const params = {
                        tokenIn,
                        tokenOut,
                        fee,
                        amountIn,
                        sqrtPriceLimitX96: 0
                    };
                    
                    const result = await this.quoter.callStatic.quoteExactInputSingle(params);
                    
                    if (result.amountOut.gt(bestOutput)) {
                        bestOutput = result.amountOut;
                        bestQuote = {
                            outputAmount: result.amountOut,
                            fee,
                            gasEstimate: result.gasEstimate || ethers.BigNumber.from(180000),
                            sqrtPriceX96After: result.sqrtPriceX96After,
                            path: this.encodePath([tokenIn, tokenOut], [fee])
                        };
                    }
                    
                } catch (error) {
                    // Pool doesn't exist for this fee tier
                    continue;
                }
            }
            
            if (!bestQuote) {
                return null;
            }
            
            // Calculate price impact
            bestQuote.priceImpact = await this.calculatePriceImpact(
                tokenIn,
                tokenOut,
                amountIn,
                bestQuote.outputAmount,
                bestQuote.fee
            );
            
            // Add swap data
            bestQuote.data = await this.encodeSwapData(
                tokenIn,
                tokenOut,
                bestQuote.fee,
                amountIn,
                bestQuote.outputAmount
            );
            
            return bestQuote;
            
        } catch (error) {
            logger.debug('Failed to get UniswapV3 quote', {
                error: error.message,
                tokenIn,
                tokenOut
            });
            return null;
        }
    }
    
    async getMultiHopQuote(path, fees, amountIn) {
        try {
            // Encode path for multi-hop swap
            const encodedPath = this.encodePath(path, fees);
            
            const result = await this.quoter.callStatic.quoteExactInput(
                encodedPath,
                amountIn
            );
            
            return {
                outputAmount: result.amountOut,
                path,
                fees,
                gasEstimate: result.gasEstimate || ethers.BigNumber.from(250000),
                encodedPath
            };
            
        } catch (error) {
            logger.debug('Failed to get multi-hop quote', {
                error: error.message,
                path
            });
            return null;
        }
    }
    
    encodePath(path, fees) {
        // Encode path for exact input swaps
        // Path encoding: token0 - fee0 - token1 - fee1 - token2...
        if (path.length !== fees.length + 1) {
            throw new Error('Path/fee length mismatch');
        }
        
        let encoded = '0x';
        
        for (let i = 0; i < fees.length; i++) {
            encoded += path[i].slice(2); // Remove 0x
            encoded += fees[i].toString(16).padStart(6, '0'); // 3 bytes for fee
        }
        
        encoded += path[path.length - 1].slice(2);
        
        return encoded;
    }
    
    async calculatePriceImpact(tokenIn, tokenOut, amountIn, amountOut, fee) {
        try {
            // Get pool info to calculate price impact
            const poolAddress = await this.getPoolAddress(tokenIn, tokenOut, fee);
            
            if (!poolAddress) {
                return 0;
            }
            
            // Simplified price impact calculation
            // In production, would query pool state and calculate actual impact
            const baseAmount = ethers.utils.parseUnits('1', 18);
            const baseQuote = await this.quoter.callStatic.quoteExactInputSingle({
                tokenIn,
                tokenOut,
                fee,
                amountIn: baseAmount,
                sqrtPriceLimitX96: 0
            });
            
            const expectedOutput = amountIn.mul(baseQuote.amountOut).div(baseAmount);
            const actualOutput = amountOut;
            
            const impact = expectedOutput.sub(actualOutput).mul(10000).div(expectedOutput);
            
            return impact.toNumber(); // In basis points
            
        } catch (error) {
            return 0;
        }
    }
    
    async getPoolAddress(tokenA, tokenB, fee) {
        const cacheKey = `${tokenA}-${tokenB}-${fee}`;
        
        if (this.poolCache.has(cacheKey)) {
            return this.poolCache.get(cacheKey);
        }
        
        try {
            const factoryContract = new ethers.Contract(
                this.contracts.factory,
                ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'],
                this.provider
            );
            
            const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee);
            
            if (poolAddress !== ethers.constants.AddressZero) {
                this.poolCache.set(cacheKey, poolAddress);
                return poolAddress;
            }
            
            return null;
            
        } catch (error) {
            return null;
        }
    }
    
    async encodeSwapData(tokenIn, tokenOut, fee, amountIn, minAmountOut) {
        const params = {
            tokenIn,
            tokenOut,
            fee,
            recipient: ethers.constants.AddressZero, // Will be replaced
            deadline: 0, // Will be replaced
            amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        };
        
        return this.router.interface.encodeFunctionData('exactInputSingle', [params]);
    }
    
    async buildSwapTx(quote) {
        const { tokenIn, tokenOut, amountIn, minOutput, recipient, deadline } = quote;
        
        const params = {
            tokenIn,
            tokenOut,
            fee: quote.fee,
            recipient,
            deadline,
            amountIn,
            amountOutMinimum: minOutput,
            sqrtPriceLimitX96: 0
        };
        
        const value = tokenIn === this.config.WETH ? amountIn : 0;
        
        return {
            to: this.contracts.router,
            data: this.router.interface.encodeFunctionData('exactInputSingle', [params]),
            value,
            gasLimit: quote.gasEstimate.mul(120).div(100) // 20% buffer
        };
    }
    
    async estimateGas(tokenIn, tokenOut, amountIn) {
        try {
            // Get best fee tier
            const quote = await this.getQuote(tokenIn, tokenOut, amountIn);
            
            if (!quote) {
                return ethers.BigNumber.from(200000);
            }
            
            return quote.gasEstimate;
            
        } catch (error) {
            return ethers.BigNumber.from(200000);
        }
    }
    
    static decodeTransaction(tx) {
        try {
            const iface = new ethers.utils.Interface([
                'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
                'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params)',
                'function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params)',
                'function exactOutput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params)'
            ]);
            
            const decoded = iface.parseTransaction({ data: tx.data });
            
            let result = {
                dex: 'uniswapV3',
                method: decoded.name,
                type: 'swap'
            };
            
            if (decoded.name === 'exactInputSingle') {
                const params = decoded.args.params;
                result = {
                    ...result,
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    amountIn: params.amountIn,
                    amountOutMinimum: params.amountOutMinimum,
                    fee: params.fee,
                    recipient: params.recipient
                };
            } else if (decoded.name === 'exactInput') {
                const params = decoded.args.params;
                const { tokens, fees } = UniswapV3.decodePath(params.path);
                
                result = {
                    ...result,
                    path: tokens,
                    fees,
                    amountIn: params.amountIn,
                    amountOutMinimum: params.amountOutMinimum,
                    recipient: params.recipient
                };
            }
            
            return result;
            
        } catch (error) {
            return null;
        }
    }
    
    static decodePath(path) {
        const tokens = [];
        const fees = [];
        
        let i = 0;
        while (i < path.length) {
            // Read token address (20 bytes)
            tokens.push('0x' + path.slice(i + 2, i + 42));
            i += 40;
            
            // Read fee if not at the end
            if (i < path.length) {
                fees.push(parseInt(path.slice(i + 2, i + 8), 16));
                i += 6;
            }
        }
        
        return { tokens, fees };
    }
    
    getStats() {
        return {
            available: true,
            poolsCached: this.poolCache.size,
            feeTiers: this.feeTiers
        };
    }
}

module.exports = { UniswapV3 };