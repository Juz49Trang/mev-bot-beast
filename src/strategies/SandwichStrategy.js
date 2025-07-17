const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { DEXAggregator } = require('../dex/DEXAggregator');

class SandwichStrategy extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.config = bot.config.strategies.sandwich;
        this.dexAggregator = new DEXAggregator(bot);
        
        this.isRunning = false;
        this.pendingVictims = new Map();
        
        // Configuration
        this.minVictimTxValue = ethers.utils.parseEther(this.config.minVictimTxValue || '1');
        this.maxPositionSize = ethers.utils.parseEther(this.config.maxPositionSize || '5');
        this.frontrunGasMultiplier = this.config.frontrunGasPrice || 105;
        this.backrunGasMultiplier = this.config.backrunGasPrice || 95;
        
        logger.info('Sandwich strategy initialized (Note: Disabled by default for ethical reasons)');
    }
    
    async start() {
        if (!this.config.enabled) {
            logger.warn('Sandwich strategy is disabled in configuration');
            return;
        }
        
        if (this.isRunning) {
            return;
        }
        
        logger.info('Starting sandwich strategy...');
        
        // Subscribe to mempool events
        this.bot.monitor.on('mempool:transaction', this.analyzeMempoolTx.bind(this));
        
        this.isRunning = true;
        logger.info('Sandwich strategy started');
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        this.isRunning = false;
        logger.info('Sandwich strategy stopped');
    }
    
    async analyzeMempoolTx(tx) {
        try {
            // Only analyze DEX swaps
            if (!this.isDEXSwap(tx)) {
                return;
            }
            
            // Check minimum value
            if (tx.value.lt(this.minVictimTxValue)) {
                return;
            }
            
            // Analyze sandwich opportunity
            const opportunity = await this.calculateSandwichOpportunity(tx);
            
            if (opportunity && opportunity.expectedProfit.gt(0)) {
                logger.info('Sandwich opportunity detected', {
                    victim: tx.hash,
                    expectedProfit: ethers.utils.formatEther(opportunity.expectedProfit)
                });
                
                this.emit('opportunity', opportunity);
            }
            
        } catch (error) {
            logger.debug('Error analyzing mempool tx for sandwich', error);
        }
    }
    
    isDEXSwap(tx) {
        if (!tx.decoded || tx.decoded.type !== 'swap') {
            return false;
        }
        
        // Check if it's a swap on a known DEX
        const knownDEXes = Object.values(this.bot.config.contracts.dexRouters || {});
        return knownDEXes.includes(tx.to?.toLowerCase());
    }
    
    async calculateSandwichOpportunity(victimTx) {
        const { tokenIn, tokenOut, amountIn } = victimTx.decoded;
        
        // Calculate optimal frontrun amount
        const frontrunAmount = await this.calculateOptimalFrontrunAmount(
            tokenIn,
            tokenOut,
            amountIn
        );
        
        if (frontrunAmount.gt(this.maxPositionSize)) {
            return null;
        }
        
        // Simulate frontrun impact
        const frontrunQuote = await this.dexAggregator.getBestQuote(
            tokenIn,
            tokenOut,
            frontrunAmount
        );
        
        if (!frontrunQuote) {
            return null;
        }
        
        // Calculate victim's output after our frontrun
        const victimOutputAfterFrontrun = await this.estimateVictimOutput(
            tokenIn,
            tokenOut,
            amountIn,
            frontrunQuote
        );
        
        // Calculate backrun quote
        const backrunQuote = await this.dexAggregator.getBestQuote(
            tokenOut,
            tokenIn,
            frontrunQuote.outputAmount
        );
        
        if (!backrunQuote) {
            return null;
        }
        
        // Calculate profit
        const profit = backrunQuote.outputAmount.sub(frontrunAmount);
        
        // Estimate gas costs
        const gasPrice = victimTx.gasPrice || await this.bot.getGasPrice();
        const frontrunGas = ethers.BigNumber.from(200000);
        const backrunGas = ethers.BigNumber.from(200000);
        const totalGasCost = gasPrice.mul(frontrunGas.add(backrunGas));
        
        const netProfit = profit.sub(totalGasCost);
        
        if (netProfit.lte(0)) {
            return null;
        }
        
        return {
            type: 'sandwich',
            strategy: 'sandwich',
            victimTx: victimTx,
            tokenIn,
            tokenOut,
            frontrunAmount,
            frontrunQuote,
            backrunQuote,
            expectedProfit: netProfit,
            gasPrice,
            frontrunTx: this.buildFrontrunTx(frontrunQuote, gasPrice),
            backrunTx: this.buildBackrunTx(backrunQuote, gasPrice),
            timestamp: Date.now()
        };
    }
    
    async calculateOptimalFrontrunAmount(tokenIn, tokenOut, victimAmount) {
        // Simplified calculation - in production would use more sophisticated model
        // Aim for 10-20% of victim's trade
        return victimAmount.mul(15).div(100);
    }
    
    async estimateVictimOutput(tokenIn, tokenOut, amount, ourImpact) {
        // Estimate how much worse the victim's trade will be after our frontrun
        // This is simplified - real implementation would model the AMM curve
        const normalQuote = await this.dexAggregator.getBestQuote(tokenIn, tokenOut, amount);
        
        if (!normalQuote) {
            return null;
        }
        
        // Assume 0.5% worse price due to our trade
        return normalQuote.outputAmount.mul(995).div(1000);
    }
    
    buildFrontrunTx(quote, victimGasPrice) {
        return {
            to: quote.dex,
            data: quote.data,
            value: quote.tokenIn === this.bot.config.tokens.WETH ? quote.amountIn : 0,
            gasPrice: victimGasPrice.mul(this.frontrunGasMultiplier).div(100),
            gasLimit: ethers.BigNumber.from(250000)
        };
    }
    
    buildBackrunTx(quote, victimGasPrice) {
        return {
            to: quote.dex,
            data: quote.data,
            value: 0,
            gasPrice: victimGasPrice.mul(this.backrunGasMultiplier).div(100),
            gasLimit: ethers.BigNumber.from(250000)
        };
    }
    
    async calculateProfit(receipt, opportunity) {
        // Calculate actual profit from sandwich execution
        try {
            // This would parse events from the receipt to calculate actual profit
            const events = receipt.logs;
            
            // Simplified - in production would parse Transfer events
            return opportunity.expectedProfit;
            
        } catch (error) {
            logger.error('Error calculating sandwich profit', error);
            return ethers.BigNumber.from(0);
        }
    }
}

module.exports = { SandwichStrategy };