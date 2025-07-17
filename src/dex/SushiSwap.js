const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class SushiSwap {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        
        // Contract addresses
        this.contracts = {
            router: config.router,
            factory: config.factory
        };
        
        // Initialize contract instances
        this.router = new ethers.Contract(
            this.contracts.router,
            [
                'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
                'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
                'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
            ],
            provider
        );
        
        this.factory = new ethers.Contract(
            this.contracts.factory,
            [
                'function getPair(address tokenA, address tokenB) external view returns (address pair)'
            ],
            provider
        );
        
        // Cache for pairs
        this.pairCache = new Map();
        
        logger.info('SushiSwap adapter initialized');
    }
    
    async getQuote(tokenIn, tokenOut, amountIn) {
        try {
            // Check if direct pair exists
            const directPair = await this.getPair(tokenIn, tokenOut);
            
            if (directPair !== ethers.constants.AddressZero) {
                // Direct swap
                const path = [tokenIn, tokenOut];
                const amounts = await this.router.getAmountsOut(amountIn, path);
                
                return {
                    outputAmount: amounts[1],
                    path,
                    gasEstimate: ethers.BigNumber.from(150000),
                    data: await this.encodeSwapData(path, amountIn, amounts[1])
                };
            }
            
            // Try multi-hop through WETH
            const weth = this.config.WETH || '0x4200000000000000000000000000000000000006';
            
            if (tokenIn !== weth && tokenOut !== weth) {
                const pathThruWETH = [tokenIn, weth, tokenOut];
                
                try {
                    const amounts = await this.router.getAmountsOut(amountIn, pathThruWETH);
                    
                    if (amounts[2].gt(0)) {
                        return {
                            outputAmount: amounts[2],
                            path: pathThruWETH,
                            gasEstimate: ethers.BigNumber.from(200000), // Higher for multi-hop
                            data: await this.encodeSwapData(pathThruWETH, amountIn, amounts[2])
                        };
                    }
                } catch (error) {
                    // Multi-hop failed, no route available
                }
            }
            
            return null;
            
        } catch (error) {
            logger.debug('Failed to get SushiSwap quote', {
                error: error.message,
                tokenIn,
                tokenOut
            });
            return null;
        }
    }
    
    async getPair(tokenA, tokenB) {
        const cacheKey = `${tokenA}-${tokenB}`;
        
        if (this.pairCache.has(cacheKey)) {
            return this.pairCache.get(cacheKey);
        }
        
        try {
            const pair = await this.factory.getPair(tokenA, tokenB);
            this.pairCache.set(cacheKey, pair);
            this.pairCache.set(`${tokenB}-${tokenA}`, pair); // Cache both directions
            
            return pair;
        } catch (error) {
            return ethers.constants.AddressZero;
        }
    }
    
    async encodeSwapData(path, amountIn, minAmountOut) {
        const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
        const recipient = ethers.constants.AddressZero; // Will be replaced
        
        if (path[0] === this.config.WETH) {
            // ETH -> Token
            return this.router.interface.encodeFunctionData('swapExactETHForTokens', [
                minAmountOut,
                path,
                recipient,
                deadline
            ]);
        } else if (path[path.length - 1] === this.config.WETH) {
            // Token -> ETH
            return this.router.interface.encodeFunctionData('swapExactTokensForETH', [
                amountIn,
                minAmountOut,
                path,
                recipient,
                deadline
            ]);
        } else {
            // Token -> Token
            return this.router.interface.encodeFunctionData('swapExactTokensForTokens', [
                amountIn,
                minAmountOut,
                path,
                recipient,
                deadline
            ]);
        }
    }
    
    async buildSwapTx(quote) {
        const { path, amountIn, minOutput, recipient, deadline } = quote;
        
        let data;
        let value = ethers.BigNumber.from(0);
        
        if (path[0] === this.config.WETH) {
            // ETH -> Token
            data = this.router.interface.encodeFunctionData('swapExactETHForTokens', [
                minOutput,
                path,
                recipient,
                deadline
            ]);
            value = amountIn;
        } else if (path[path.length - 1] === this.config.WETH) {
            // Token -> ETH
            data = this.router.interface.encodeFunctionData('swapExactTokensForETH', [
                amountIn,
                minOutput,
                path,
                recipient,
                deadline
            ]);
        } else {
            // Token -> Token
            data = this.router.interface.encodeFunctionData('swapExactTokensForTokens', [
                amountIn,
                minOutput,
                path,
                recipient,
                deadline
            ]);
        }
        
        return {
            to: this.contracts.router,
            data,
            value,
            gasLimit: path.length === 2 ? ethers.BigNumber.from(150000) : ethers.BigNumber.from(200000)
        };
    }
    
    async estimateGas(tokenIn, tokenOut, amountIn) {
        // Check if multi-hop is needed
        const directPair = await this.getPair(tokenIn, tokenOut);
        
        if (directPair !== ethers.constants.AddressZero) {
            return ethers.BigNumber.from(150000);
        } else {
            return ethers.BigNumber.from(200000); // Multi-hop
        }
    }
    
    static decodeTransaction(tx) {
        try {
            const iface = new ethers.utils.Interface([
                'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)',
                'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)',
                'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)'
            ]);
            
            const decoded = iface.parseTransaction({ data: tx.data });
            
            let result = {
                dex: 'sushiswap',
                method: decoded.name,
                type: 'swap'
            };
            
            if (decoded.name === 'swapExactTokensForTokens') {
                result = {
                    ...result,
                    tokenIn: decoded.args.path[0],
                    tokenOut: decoded.args.path[decoded.args.path.length - 1],
                    amountIn: decoded.args.amountIn,
                    amountOutMin: decoded.args.amountOutMin,
                    path: decoded.args.path,
                    recipient: decoded.args.to
                };
            } else if (decoded.name === 'swapExactETHForTokens') {
                result = {
                    ...result,
                    tokenIn: 'ETH',
                    tokenOut: decoded.args.path[decoded.args.path.length - 1],
                    amountIn: tx.value,
                    amountOutMin: decoded.args.amountOutMin,
                    path: decoded.args.path,
                    recipient: decoded.args.to
                };
            }
            
            return result;
            
        } catch (error) {
            return null;
        }
    }
    
    getStats() {
        return {
            available: true,
            pairsCached: this.pairCache.size
        };
    }
}

module.exports = { SushiSwap };