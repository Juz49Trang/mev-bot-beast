const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { PositionSizer } = require('./PositionSizer');

class RiskManager {
    constructor(config) {
        this.config = config;
        this.positionSizer = new PositionSizer(config);
        
        // Risk parameters
        this.maxPositionSize = ethers.utils.parseEther(config.maxPositionETH || '10');
        this.maxDailyLoss = ethers.utils.parseEther(config.maxDailyLossETH || '1');
        this.maxGasPrice = ethers.utils.parseUnits(config.maxGasGwei || '100', 'gwei');
        this.minProfitRatio = config.minProfitRatio || 1.5; // Profit must be 1.5x gas cost
        
        // Risk tracking
        this.dailyStats = {
            date: this.getCurrentDate(),
            totalLoss: ethers.BigNumber.from(0),
            totalProfit: ethers.BigNumber.from(0),
            tradesExecuted: 0,
            tradesRejected: 0
        };
        
        // Token risk scores
        this.tokenRiskScores = new Map();
        this.dexRiskScores = new Map();
        
        // Initialize risk scores
        this.initializeRiskScores();
        
        logger.info('Risk manager initialized', {
            maxPositionSize: ethers.utils.formatEther(this.maxPositionSize),
            maxDailyLoss: ethers.utils.formatEther(this.maxDailyLoss),
            maxGasPrice: ethers.utils.formatUnits(this.maxGasPrice, 'gwei')
        });
    }
    
    initializeRiskScores() {
        // Token risk scores (0-10, lower is safer)
        const tokenScores = {
            'WETH': 1,
            'USDC': 1,
            'USDT': 2,
            'DAI': 1,
            'WBTC': 2,
            'UNI': 3,
            'LINK': 3,
            'AAVE': 3
        };
        
        for (const [token, score] of Object.entries(tokenScores)) {
            this.tokenRiskScores.set(token, score);
        }
        
        // DEX risk scores
        const dexScores = {
            'uniswapV3': 1,
            'uniswapV2': 2,
            'sushiswap': 2,
            'curve': 1,
            'balancer': 2,
            'bancor': 3
        };
        
        for (const [dex, score] of Object.entries(dexScores)) {
            this.dexRiskScores.set(dex, score);
        }
    }
    
    async assessOpportunity(opportunity) {
        try {
            // Reset daily stats if needed
            this.checkDailyReset();
            
            // Run all risk checks
            const checks = await Promise.all([
                this.checkDailyLossLimit(),
                this.checkPositionSize(opportunity),
                this.checkGasPrice(opportunity),
                this.checkProfitRatio(opportunity),
                this.checkTokenRisk(opportunity),
                this.checkDexRisk(opportunity),
                this.checkSlippage(opportunity),
                this.checkLiquidity(opportunity)
            ]);
            
            // Calculate overall risk score
            const riskFactors = checks.filter(c => !c.passed);
            const riskScore = this.calculateRiskScore(checks);
            
            // Determine if approved
            const approved = riskFactors.length === 0 && riskScore < this.config.maxRiskScore;
            
            // Calculate position size if approved
            let positionSize = null;
            if (approved) {
                positionSize = await this.positionSizer.calculatePositionSize(
                    opportunity,
                    riskScore
                );
            }
            
            const assessment = {
                approved,
                score: riskScore,
                checks,
                failedChecks: riskFactors,
                reason: approved ? null : riskFactors[0]?.reason,
                positionSize,
                timestamp: Date.now()
            };
            
            // Update stats
            if (approved) {
                this.dailyStats.tradesExecuted++;
            } else {
                this.dailyStats.tradesRejected++;
                logger.debug('Opportunity rejected', {
                    reason: assessment.reason,
                    score: riskScore,
                    failedChecks: riskFactors.length
                });
            }
            
            return assessment;
            
        } catch (error) {
            logger.error('Error assessing opportunity', error);
            
            return {
                approved: false,
                reason: 'Risk assessment error',
                error: error.message
            };
        }
    }
    
    checkDailyReset() {
        const currentDate = this.getCurrentDate();
        
        if (currentDate !== this.dailyStats.date) {
            // Reset daily stats
            this.dailyStats = {
                date: currentDate,
                totalLoss: ethers.BigNumber.from(0),
                totalProfit: ethers.BigNumber.from(0),
                tradesExecuted: 0,
                tradesRejected: 0
            };
            
            logger.info('Daily risk stats reset');
        }
    }
    
    async checkDailyLossLimit() {
        const remainingLoss = this.maxDailyLoss.sub(this.dailyStats.totalLoss);
        
        return {
            name: 'dailyLossLimit',
            passed: remainingLoss.gt(0),
            value: ethers.utils.formatEther(remainingLoss),
            reason: remainingLoss.lte(0) ? 'Daily loss limit reached' : null,
            weight: 10 // High weight - critical check
        };
    }
    
    async checkPositionSize(opportunity) {
        const positionSize = opportunity.amount || opportunity.inputAmount || ethers.BigNumber.from(0);
        const passed = positionSize.lte(this.maxPositionSize);
        
        return {
            name: 'positionSize',
            passed,
            value: ethers.utils.formatEther(positionSize),
            maxValue: ethers.utils.formatEther(this.maxPositionSize),
            reason: !passed ? 'Position size exceeds maximum' : null,
            weight: 8
        };
    }
    
    async checkGasPrice(opportunity) {
        const gasPrice = opportunity.gasPrice || await this.getGasPrice();
        const passed = gasPrice.lte(this.maxGasPrice);
        
        return {
            name: 'gasPrice',
            passed,
            value: ethers.utils.formatUnits(gasPrice, 'gwei'),
            maxValue: ethers.utils.formatUnits(this.maxGasPrice, 'gwei'),
            reason: !passed ? 'Gas price too high' : null,
            weight: 6
        };
    }
    
    async checkProfitRatio(opportunity) {
        const expectedProfit = opportunity.expectedProfit || opportunity.netProfit;
        const gasCost = opportunity.gasCost;
        
        if (!expectedProfit || !gasCost || gasCost.eq(0)) {
            return {
                name: 'profitRatio',
                passed: false,
                reason: 'Invalid profit calculation',
                weight: 9
            };
        }
        
        const ratio = expectedProfit.mul(100).div(gasCost).toNumber() / 100;
        const passed = ratio >= this.minProfitRatio;
        
        return {
            name: 'profitRatio',
            passed,
            value: ratio.toFixed(2),
            minValue: this.minProfitRatio,
            reason: !passed ? 'Profit ratio too low' : null,
            weight: 7
        };
    }
    
    async checkTokenRisk(opportunity) {
        const tokens = this.extractTokens(opportunity);
        let maxRisk = 0;
        let riskyToken = null;
        
        for (const token of tokens) {
            const risk = this.tokenRiskScores.get(token) || 5; // Default medium risk
            if (risk > maxRisk) {
                maxRisk = risk;
                riskyToken = token;
            }
        }
        
        const maxAllowedRisk = this.config.maxTokenRisk || 5;
        const passed = maxRisk <= maxAllowedRisk;
        
        return {
            name: 'tokenRisk',
            passed,
            value: maxRisk,
            maxValue: maxAllowedRisk,
            riskyToken,
            reason: !passed ? `Token ${riskyToken} risk too high` : null,
            weight: 5
        };
    }
    
    async checkDexRisk(opportunity) {
        const dexes = this.extractDexes(opportunity);
        let maxRisk = 0;
        let riskyDex = null;
        
        for (const dex of dexes) {
            const risk = this.dexRiskScores.get(dex) || 5;
            if (risk > maxRisk) {
                maxRisk = risk;
                riskyDex = dex;
            }
        }
        
        const maxAllowedRisk = this.config.maxDexRisk || 5;
        const passed = maxRisk <= maxAllowedRisk;
        
        return {
            name: 'dexRisk',
            passed,
            value: maxRisk,
            maxValue: maxAllowedRisk,
            riskyDex,
            reason: !passed ? `DEX ${riskyDex} risk too high` : null,
            weight: 4
        };
    }
    
    async checkSlippage(opportunity) {
        // Estimate potential slippage
        const estimatedSlippage = this.estimateSlippage(opportunity);
        const maxSlippage = this.config.maxSlippageBps || 50; // 0.5%
        
        const passed = estimatedSlippage <= maxSlippage;
        
        return {
            name: 'slippage',
            passed,
            value: estimatedSlippage,
            maxValue: maxSlippage,
            reason: !passed ? 'Slippage too high' : null,
            weight: 6
        };
    }
    
    async checkLiquidity(opportunity) {
        // Simple liquidity check based on trade size
        const tradeSize = opportunity.amount || opportunity.inputAmount;
        const estimatedLiquidity = await this.estimateLiquidity(opportunity);
        
        if (!tradeSize || !estimatedLiquidity) {
            return {
                name: 'liquidity',
                passed: true, // Pass if we can't check
                weight: 3
            };
        }
        
        const liquidityRatio = estimatedLiquidity.div(tradeSize);
        const minRatio = 10; // Liquidity should be at least 10x trade size
        
        const passed = liquidityRatio.gte(minRatio);
        
        return {
            name: 'liquidity',
            passed,
            value: liquidityRatio.toString(),
            minValue: minRatio,
            reason: !passed ? 'Insufficient liquidity' : null,
            weight: 5
        };
    }
    
    calculateRiskScore(checks) {
        let totalScore = 0;
        let totalWeight = 0;
        
        for (const check of checks) {
            const weight = check.weight || 1;
            totalWeight += weight;
            
            if (!check.passed) {
                totalScore += weight * 10; // Failed checks add to risk
            } else {
                // Partial score based on how close to limits
                if (check.value && check.maxValue) {
                    const ratio = parseFloat(check.value) / parseFloat(check.maxValue);
                    totalScore += weight * ratio * 5;
                }
            }
        }
        
        // Normalize to 0-10 scale
        return Math.min(10, (totalScore / totalWeight));
    }
    
    extractTokens(opportunity) {
        const tokens = new Set();
        
        if (opportunity.tokenA) tokens.add(opportunity.tokenA);
        if (opportunity.tokenB) tokens.add(opportunity.tokenB);
        if (opportunity.path) {
            opportunity.path.forEach(token => tokens.add(token));
        }
        if (opportunity.asset) tokens.add(opportunity.asset);
        
        return Array.from(tokens);
    }
    
    extractDexes(opportunity) {
        const dexes = new Set();
        
        if (opportunity.dex) dexes.add(opportunity.dex);
        if (opportunity.buyDex) dexes.add(opportunity.buyDex);
        if (opportunity.sellDex) dexes.add(opportunity.sellDex);
        if (opportunity.quotes) {
            opportunity.quotes.forEach(quote => {
                if (quote.dex) dexes.add(quote.dex);
            });
        }
        
        return Array.from(dexes);
    }
    
    estimateSlippage(opportunity) {
        // Estimate slippage based on trade size and type
        const baseSlippage = 10; // 0.1% base
        
        // Add slippage for larger trades
        const tradeSize = opportunity.amount || opportunity.inputAmount;
        if (tradeSize && tradeSize.gt(ethers.utils.parseEther('100'))) {
            return baseSlippage * 2;
        }
        
        // Add slippage for complex paths
        if (opportunity.path && opportunity.path.length > 2) {
            return baseSlippage * 1.5;
        }
        
        return baseSlippage;
    }
    
    async estimateLiquidity(opportunity) {
        // Placeholder for liquidity estimation
        // In production, this would query DEX reserves
        return ethers.utils.parseEther('1000');
    }
    
    async getGasPrice() {
        // Get current gas price from bot
        return ethers.utils.parseUnits('30', 'gwei');
    }
    
    updateTradeResult(result) {
        // Update daily stats based on trade result
        if (result.success) {
            if (result.profit.gt(0)) {
                this.dailyStats.totalProfit = this.dailyStats.totalProfit.add(result.profit);
            } else {
                this.dailyStats.totalLoss = this.dailyStats.totalLoss.add(result.profit.abs());
            }
        }
    }
    
    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }
    
    getStats() {
        return {
            dailyStats: {
                ...this.dailyStats,
                totalProfit: ethers.utils.formatEther(this.dailyStats.totalProfit),
                totalLoss: ethers.utils.formatEther(this.dailyStats.totalLoss),
                netPnL: ethers.utils.formatEther(
                    this.dailyStats.totalProfit.sub(this.dailyStats.totalLoss)
                )
            },
            limits: {
                maxPositionSize: ethers.utils.formatEther(this.maxPositionSize),
                maxDailyLoss: ethers.utils.formatEther(this.maxDailyLoss),
                maxGasPrice: ethers.utils.formatUnits(this.maxGasPrice, 'gwei')
            },
            riskScores: {
                tokens: Object.fromEntries(this.tokenRiskScores),
                dexes: Object.fromEntries(this.dexRiskScores)
            }
        };
    }
}

module.exports = { RiskManager };