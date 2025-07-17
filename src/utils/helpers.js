const { ethers } = require('ethers');
const { logger } = require('./logger');

/**
 * Retry a function with exponential backoff
 */
async function retry(fn, options = {}) {
    const {
        attempts = 3,
        delay = 1000,
        factor = 2,
        maxDelay = 30000,
        onRetry = () => {}
    } = options;
    
    let lastError;
    
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (i < attempts - 1) {
                const waitTime = Math.min(delay * Math.pow(factor, i), maxDelay);
                onRetry(error, i + 1, waitTime);
                await sleep(waitTime);
            }
        }
    }
    
    throw lastError;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format wei to human readable
 */
function formatUnits(value, decimals = 18) {
    return ethers.utils.formatUnits(value, decimals);
}

/**
 * Parse human readable to wei
 */
function parseUnits(value, decimals = 18) {
    return ethers.utils.parseUnits(value.toString(), decimals);
}

/**
 * Calculate percentage change
 */
function calculatePercentageChange(oldValue, newValue) {
    if (oldValue.eq(0)) return 0;
    
    const change = newValue.sub(oldValue);
    return change.mul(10000).div(oldValue).toNumber() / 100;
}

/**
 * Calculate price impact
 */
function calculatePriceImpact(amountIn, amountOut, expectedOut) {
    if (expectedOut.eq(0)) return 0;
    
    const impact = expectedOut.sub(amountOut).mul(10000).div(expectedOut);
    return impact.toNumber() / 100;
}

/**
 * Get current timestamp in seconds
 */
function getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
}

/**
 * Get deadline timestamp
 */
function getDeadline(seconds = 300) {
    return getCurrentTimestamp() + seconds;
}

/**
 * Check if address is valid
 */
function isValidAddress(address) {
    try {
        ethers.utils.getAddress(address);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get token decimals
 */
async function getTokenDecimals(tokenAddress, provider) {
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function decimals() view returns (uint8)'],
        provider
    );
    
    try {
        return await tokenContract.decimals();
    } catch {
        return 18; // Default to 18
    }
}

/**
 * Get token balance
 */
async function getTokenBalance(tokenAddress, walletAddress, provider) {
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
    );
    
    return tokenContract.balanceOf(walletAddress);
}

/**
 * Estimate gas with buffer
 */
async function estimateGasWithBuffer(transaction, signer, bufferPercent = 20) {
    try {
        const estimatedGas = await signer.estimateGas(transaction);
        const buffer = estimatedGas.mul(bufferPercent).div(100);
        return estimatedGas.add(buffer);
    } catch (error) {
        logger.error('Gas estimation failed:', error);
        return ethers.BigNumber.from(500000); // Fallback
    }
}

/**
 * Simulate transaction
 */
async function simulateTransaction(transaction, signer, provider) {
    try {
        // Try static call first
        const result = await signer.callStatic[transaction.method](...transaction.args, {
            from: transaction.from,
            value: transaction.value || 0
        });
        
        return {
            success: true,
            result,
            gasEstimate: await estimateGasWithBuffer(transaction, signer)
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            revertReason: parseRevertReason(error)
        };
    }
}

/**
 * Parse revert reason from error
 */
function parseRevertReason(error) {
    if (error.reason) return error.reason;
    
    if (error.error?.data) {
        const reason = ethers.utils.toUtf8String('0x' + error.error.data.slice(138));
        return reason;
    }
    
    return 'Unknown revert reason';
}

/**
 * Calculate optimal amount for arbitrage
 */
function calculateOptimalAmount(reserveIn, reserveOut, fee = 997) {
    // Uniswap V2 style calculation
    const numerator = ethers.BigNumber.from(fee).mul(reserveIn);
    const denominator = ethers.BigNumber.from(1000).add(fee);
    
    return numerator.div(denominator);
}

/**
 * Sort tokens for consistent pair ordering
 */
function sortTokens(tokenA, tokenB) {
    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];
    
    return { token0, token1 };
}

/**
 * Create a rate limiter
 */
function createRateLimiter(requestsPerSecond) {
    const queue = [];
    const interval = 1000 / requestsPerSecond;
    let lastCall = 0;
    
    return async function rateLimited(fn) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCall;
        
        if (timeSinceLastCall < interval) {
            await sleep(interval - timeSinceLastCall);
        }
        
        lastCall = Date.now();
        return fn();
    };
}

/**
 * Chunk array into smaller arrays
 */
function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Get gas price with priority fee
 */
async function getGasPrice(provider, priority = 'standard') {
    try {
        const block = await provider.getBlock('latest');
        const baseFee = block.baseFeePerGas;
        
        if (!baseFee) {
            // Legacy gas price
            return provider.getGasPrice();
        }
        
        // EIP-1559 gas pricing
        const priorityFees = {
            slow: ethers.utils.parseUnits('1', 'gwei'),
            standard: ethers.utils.parseUnits('2', 'gwei'),
            fast: ethers.utils.parseUnits('3', 'gwei'),
            instant: ethers.utils.parseUnits('5', 'gwei')
        };
        
        const priorityFee = priorityFees[priority] || priorityFees.standard;
        const maxFee = baseFee.mul(2).add(priorityFee);
        
        return {
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: priorityFee
        };
    } catch (error) {
        logger.error('Error getting gas price:', error);
        return provider.getGasPrice();
    }
}

module.exports = {
    retry,
    sleep,
    formatUnits,
    parseUnits,
    calculatePercentageChange,
    calculatePriceImpact,
    getCurrentTimestamp,
    getDeadline,
    isValidAddress,
    getTokenDecimals,
    getTokenBalance,
    estimateGasWithBuffer,
    simulateTransaction,
    parseRevertReason,
    calculateOptimalAmount,
    sortTokens,
    createRateLimiter,
    chunk,
    getGasPrice
};