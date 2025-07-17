const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { DEXAggregator } = require('../dex/DEXAggregator');

class FlashLoanArbitrage extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.config = bot.config.strategies.flashloan;
        this.dexAggregator = new DEXAggregator(bot);
        
        // Flash loan providers
        this.providers = {
            aave: {
                address: this.config.providers.aave,
                fee: 9, // 0.09%
                supported: ['WETH', 'USDC', 'USDT', 'DAI']
            },
            balancer: {
                address: this.config.providers.balancer,
                fee: 0, // No fee on Balancer
                supported: ['WETH', 'USDC', 'DAI', 'WBTC']
            },
            dydx: {
                address: this.config.providers.dydx,
                fee: 2, // 0.02%
                supported: ['WETH', 'USDC', 'DAI']
            }
        };
        
        // Contract interface for flash loan
        this.flashLoanContract = new ethers.Contract(
            this.config.executorContract,
            [
                'function executeFlashLoanArbitrage(address provider, address asset, uint256 amount, bytes calldata params)',
                'event FlashLoanExecuted(address provider, address asset, uint256 amount, uint256 profit)'
            ],
            this.bot.getWallet('main')
        );
        
        this.isRunning = false;
        this.opportunities = new Map();
        
        logger.info('Flash loan arbitrage strategy initialized');
    }
    
    async start() {
        if (this.isRunning) {
            return;
        }
        
        logger.info('Starting flash loan arbitrage strategy...');
        
        // Subscribe to events
        this.subscribeToEvents();
        
        // Start scanning for opportunities
        this.startScanning();
        
        this.isRunning = true;
        logger.info('Flash loan arbitrage strategy started');
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        
        this.isRunning = false;
        logger.info('Flash loan arbitrage strategy stopped');
    }
    
    subscribeToEvents() {
        // Listen for large price movements
        this.bot.monitor.on('swap', async (tx) => {
            if (tx.value && tx.value.gt(ethers.utils.parseEther('10'))) {
                await this.checkFlashLoanOpportunity(tx);
            }
        });
        
        // Listen for liquidations
        this.bot.monitor.on('liquidation', async (tx) => {
            await this.checkLiquidationArbitrage(tx);
        });
    }
    
    startScanning() {
        const interval = this.config.scanInterval || 2000;
        
        this.scanInterval = setInterval(async () => {
            try {
                await this.scanMarkets();
            } catch (error) {
                logger.error('Error scanning flash loan opportunities', error);
            }
        }, interval);
    }
    
    async scanMarkets() {
        // Scan for large arbitrage opportunities that require more capital
        const pairs = this.config.pairs || [
            ['WETH', 'USDC'],
            ['WETH', 'USDT'],
            ['USDC', 'USDT'],
            ['WETH', 'DAI']
        ];
        
        for (const [tokenA, tokenB] of pairs) {
            await this.checkPairArbitrage(tokenA, tokenB);
        }
    }
    
    async checkPairArbitrage(tokenA, tokenB) {
        try {
            // Check different loan amounts
            const loanAmounts = [
                ethers.utils.parseEther('10'),
                ethers.utils.parseEther('50'),
                ethers.utils.parseEther('100'),
                ethers.utils.parseEther('500')
            ];
            
            for (const amount of loanAmounts) {
                const opportunity = await this.calculateArbitrageWithFlashLoan(
                    tokenA,
                    tokenB,
                    amount
                );
                
                if (opportunity && opportunity.netProfit.gt(0)) {
                    await this.processOpportunity(opportunity);
                }
            }
            
        } catch (error) {
            logger.debug('Error checking pair arbitrage', {
                tokenA,
                tokenB,
                error: error.message
            });
        }
    }
    
    async calculateArbitrageWithFlashLoan(tokenA, tokenB, loanAmount) {
        // Find best flash loan provider for this asset
        const provider = this.getBestProvider(tokenA, loanAmount);
        
        if (!provider) {
            return null;
        }
        
        // Calculate flash loan cost
        const loanFee = loanAmount.mul(provider.fee).div(10000);
        const totalRepayment = loanAmount.add(loanFee);
        
        // Get quotes from all DEXs
        const quotes = await this.dexAggregator.getQuotesFromAllDexs(
            tokenA,
            tokenB,
            loanAmount
        );
        
        if (quotes.length < 2) {
            return null;
        }
        
        // Find best arbitrage path
        const sorted = quotes.sort((a, b) => b.outputAmount.sub(a.outputAmount));
        const bestSell = sorted[0];
        const bestBuy = sorted[sorted.length - 1];
        
        // Calculate if we can make profit after buying back
        const buyBackQuote = await this.dexAggregator.getQuote(
            bestBuy.dex,
            tokenB,
            tokenA,
            bestSell.outputAmount
        );
        
        if (!buyBackQuote || buyBackQuote.outputAmount.lte(totalRepayment)) {
            return null;
        }
        
        // Calculate profit
        const grossProfit = buyBackQuote.outputAmount.sub(totalRepayment);
        
        // Estimate gas costs
        const gasEstimate = ethers.BigNumber.from(500000); // Flash loan uses more gas
        const gasPrice = await this.bot.getGasPrice();
        const gasCost = gasEstimate.mul(gasPrice);
        
        const netProfit = grossProfit.sub(gasCost);
        
        if (netProfit.lte(0)) {
            return null;
        }
        
        // Build execution params
        const params = this.encodeArbitrageParams({
            sellDex: bestSell.dex,
            buyDex: bestBuy.dex,
            tokenA,
            tokenB,
            sellData: bestSell.data,
            buyData: buyBackQuote.data
        });
        
        return {
            type: 'flashloan-arbitrage',
            strategy: 'flashloan',
            provider: provider.name,
            providerAddress: provider.address,
            asset: tokenA,
            amount: loanAmount,
            tokenA,
            tokenB,
            sellDex: bestSell.dex,
            buyDex: bestBuy.dex,
            sellQuote: bestSell,
            buyQuote: buyBackQuote,
            loanFee,
            grossProfit,
            netProfit,
            gasCost,
            gasEstimate,
            params,
            timestamp: Date.now(),
            expectedProfit: netProfit
        };
    }
    
    async checkFlashLoanOpportunity(swapTx) {
        // Check if a large swap created an arbitrage opportunity
        try {
            const { tokenIn, tokenOut, amountIn } = swapTx.decoded;
            
            // Only check if swap is large enough
            if (amountIn.lt(ethers.utils.parseEther('10'))) {
                return;
            }
            
            // Check reverse arbitrage with flash loan
            const opportunity = await this.calculateArbitrageWithFlashLoan(
                tokenOut,
                tokenIn,
                amountIn.mul(2) // Try with 2x the swap amount
            );
            
            if (opportunity) {
                opportunity.trigger = 'large-swap';
                opportunity.triggerTx = swapTx.hash;
                opportunity.priority = 'high';
                
                await this.processOpportunity(opportunity);
            }
            
        } catch (error) {
            logger.error('Error checking flash loan opportunity', error);
        }
    }
    
    async checkLiquidationArbitrage(liquidationTx) {
        // Check if liquidation created arbitrage opportunity
        try {
            const { collateralAsset, debtAsset, amount } = liquidationTx.decoded;
            
            // Liquidations often create price imbalances
            const opportunity = await this.calculateArbitrageWithFlashLoan(
                collateralAsset,
                debtAsset,
                amount
            );
            
            if (opportunity) {
                opportunity.trigger = 'liquidation';
                opportunity.triggerTx = liquidationTx.hash;
                opportunity.priority = 'high';
                
                await this.processOpportunity(opportunity);
            }
            
        } catch (error) {
            logger.error('Error checking liquidation arbitrage', error);
        }
    }
    
    getBestProvider(asset, amount) {
        // Find the best flash loan provider for this asset and amount
        let bestProvider = null;
        let lowestFee = Infinity;
        
        for (const [name, provider] of Object.entries(this.providers)) {
            if (provider.supported.includes(asset)) {
                // Check if provider has enough liquidity (simplified)
                if (provider.fee < lowestFee) {
                    lowestFee = provider.fee;
                    bestProvider = { ...provider, name };
                }
            }
        }
        
        return bestProvider;
    }
    
    encodeArbitrageParams(params) {
        // Encode parameters for the flash loan executor contract
        const abiCoder = new ethers.utils.AbiCoder();
        
        return abiCoder.encode(
            ['address', 'address', 'address', 'address', 'bytes', 'bytes'],
            [
                params.sellDex,
                params.buyDex,
                params.tokenA,
                params.tokenB,
                params.sellData,
                params.buyData
            ]
        );
    }
    
    async processOpportunity(opportunity) {
        try {
            // Validate opportunity is still fresh
            if (Date.now() - opportunity.timestamp > 3000) {
                return;
            }
            
            // Check minimum profit threshold
            const minProfit = ethers.utils.parseEther(this.config.minProfitETH || '0.01');
            
            if (opportunity.netProfit.lt(minProfit)) {
                return;
            }
            
            // Log opportunity
            logger.info('Flash loan arbitrage opportunity found', {
                provider: opportunity.provider,
                profit: ethers.utils.formatEther(opportunity.netProfit),
                loanAmount: ethers.utils.formatEther(opportunity.amount),
                pair: `${opportunity.tokenA}/${opportunity.tokenB}`,
                trigger: opportunity.trigger || 'scan'
            });
            
            // Double-check profitability with fresh quotes
            const freshOpp = await this.calculateArbitrageWithFlashLoan(
                opportunity.tokenA,
                opportunity.tokenB,
                opportunity.amount
            );
            
            if (freshOpp && freshOpp.netProfit.gt(minProfit)) {
                this.emit('opportunity', freshOpp);
            }
            
        } catch (error) {
            logger.error('Error processing flash loan opportunity', error);
        }
    }
    
    async simulateFlashLoan(opportunity) {
        // Simulate the flash loan execution
        try {
            const result = await this.flashLoanContract.callStatic.executeFlashLoanArbitrage(
                opportunity.providerAddress,
                opportunity.asset,
                opportunity.amount,
                opportunity.params
            );
            
            return {
                success: true,
                profit: result
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Calculate actual profit from receipt
    async calculateProfit(receipt, opportunity) {
        try {
            // Parse FlashLoanExecuted event
            const events = receipt.logs.map(log => {
                try {
                    return this.flashLoanContract.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            }).filter(e => e && e.name === 'FlashLoanExecuted');
            
            if (events.length > 0) {
                return events[0].args.profit;
            }
            
            // Fallback to expected profit minus gas
            const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);
            return opportunity.expectedProfit.sub(gasCost);
            
        } catch (error) {
            logger.error('Error calculating flash loan profit', error);
            return ethers.BigNumber.from(0);
        }
    }
}

module.exports = { FlashLoanArbitrage };