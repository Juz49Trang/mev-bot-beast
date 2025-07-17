const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class PositionSizer {
    constructor(config) {
        this.config = config;
        
        // Kelly Criterion parameters
        this.kellyFraction = 0.25; // Use 25% of Kelly for safety
        this.minPositionSize = ethers.utils.parseEther('0.1');
        this.maxPositionSize = ethers.utils.parseEther(config.maxPositionETH || '10');
        
        // Track historical performance for dynamic sizing
        this.recentTrades = [];
        this.maxRecentTrades = 100;
        
        logger.info('Position sizer initialized');
    }
    
    async calculatePositionSize(opportunity, riskScore) {
        try {
            // Get current balance
            const balance = await this.getCurrentBalance();
            
            // Calculate base position size
            let positionSize = await this.calculateBasePosition(opportunity, balance);
            
            // Apply risk adjustments
            positionSize = this.applyRiskAdjustment(positionSize, riskScore);
            
            // Apply strategy-specific limits
            positionSize = this.applyStrategyLimits(positionSize, opportunity.strategy);
            
            // Apply Kelly Criterion if we have enough data
            if (this.recentTrades.length >= 20) {
                positionSize = this.applyKellyCriterion(positionSize, opportunity);
            }
            
            // Ensure within bounds
            positionSize = this.ensureWithinBounds(positionSize, balance);
            
            logger.debug('Position size calculated', {
                strategy: opportunity.strategy,
                riskScore,
                positionSize: ethers.utils.formatEther(positionSize)
            });
            
            return positionSize;
            
        } catch (error) {
            logger.error('Error calculating position size', error);
            return this.minPositionSize;
        }
    }
    
    async calculateBasePosition(opportunity, balance) {
        // Base position is percentage of available balance
        const basePercentage = 5; // 5% of balance
        let basePosition = balance.mul(basePercentage).div(100);
        
        // Adjust based on opportunity confidence
        if (opportunity.confidence) {
            const confidenceMultiplier = Math.max(0.5, Math.min(2, opportunity.confidence));
            basePosition = basePosition.mul(Math.floor(confidenceMultiplier * 100)).div(100);
        }
        
        // Adjust based on expected profit
        if (opportunity.expectedProfit && opportunity.amount) {
            const profitRatio = opportunity.expectedProfit.mul(10000).div(opportunity.amount).toNumber() / 100;
            
            if (profitRatio > 1) { // More than 1% profit
                basePosition = basePosition.mul(120).div(100); // Increase by 20%
            } else if (profitRatio < 0.5) { // Less than 0.5% profit
                basePosition = basePosition.mul(80).div(100); // Decrease by 20%
            }
        }
        
        return basePosition;
    }
    
    applyRiskAdjustment(positionSize, riskScore) {
        // Risk score is 0-10, where 0 is safest
        // Apply exponential decay for higher risk
        const riskMultiplier = Math.exp(-riskScore / 5);
        
        return positionSize.mul(Math.floor(riskMultiplier * 100)).div(100);
    }
    
    applyStrategyLimits(positionSize, strategy) {
        // Different strategies have different risk profiles
        const strategyLimits = {
            arbitrage: 1.0,      // Full size for arbitrage
            flashloan: 1.2,      // Can be larger due to borrowed capital
            liquidation: 0.8,    // Slightly conservative
            sandwich: 0.5        // Most risky, use half size
        };
        
        const limit = strategyLimits[strategy] || 0.8;
        return positionSize.mul(Math.floor(limit * 100)).div(100);
    }
    
    applyKellyCriterion(positionSize, opportunity) {
        // Calculate win rate and average win/loss from recent trades
        const wins = this.recentTrades.filter(t => t.profit > 0);
        const losses = this.recentTrades.filter(t => t.profit <= 0);
        
        if (losses.length === 0) {
            // No losses yet, be conservative
            return positionSize.mul(50).div(100);
        }
        
        const winRate = wins.length / this.recentTrades.length;
        const avgWin = wins.reduce((sum, t) => sum + t.profit, 0) / wins.length || 0;
        const avgLoss = Math.abs(losses.reduce((sum, t) => sum + t.profit, 0) / losses.length) || 1;
        
        // Kelly formula: f = (p * b - q) / b
        // where p = win rate, q = loss rate, b = win/loss ratio
        const b = avgWin / avgLoss;
        const q = 1 - winRate;
        const kellyFraction = (winRate * b - q) / b;
        
        // Apply safety factor and ensure positive
        const safeKelly = Math.max(0, Math.min(1, kellyFraction * this.kellyFraction));
        
        // Apply Kelly to position size
        return positionSize.mul(Math.floor(safeKelly * 100)).div(100);
    }
    
    ensureWithinBounds(positionSize, balance) {
        // Ensure we don't exceed max position size
        positionSize = positionSize.gt(this.maxPositionSize) 
            ? this.maxPositionSize 
            : positionSize;
        
        // Ensure we meet minimum position size
        positionSize = positionSize.lt(this.minPositionSize) 
            ? this.minPositionSize 
            : positionSize;
        
        // Ensure we don't exceed available balance
        const maxAvailable = balance.mul(90).div(100); // Keep 10% reserve
        positionSize = positionSize.gt(maxAvailable) 
            ? maxAvailable 
            : positionSize;
        
        return positionSize;
    }
    
    async getCurrentBalance() {
        // This would get actual wallet balance
        // For now, return a placeholder
        return ethers.utils.parseEther('10');
    }
    
    recordTradeResult(trade) {
        // Record trade for Kelly Criterion calculation
        this.recentTrades.push({
            timestamp: Date.now(),
            profit: parseFloat(ethers.utils.formatEther(trade.profit || 0)),
            strategy: trade.strategy
        });
        
        // Keep only recent trades
        if (this.recentTrades.length > this.maxRecentTrades) {
            this.recentTrades.shift();
        }
    }
    
    getStats() {
        const wins = this.recentTrades.filter(t => t.profit > 0);
        const losses = this.recentTrades.filter(t => t.profit <= 0);
        
        return {
            totalTrades: this.recentTrades.length,
            winRate: this.recentTrades.length > 0 
                ? (wins.length / this.recentTrades.length * 100).toFixed(2) + '%'
                : '0%',
            avgWin: wins.length > 0 
                ? (wins.reduce((sum, t) => sum + t.profit, 0) / wins.length).toFixed(4)
                : 0,
            avgLoss: losses.length > 0 
                ? (losses.reduce((sum, t) => sum + t.profit, 0) / losses.length).toFixed(4)
                : 0
        };
    }
}

module.exports = { PositionSizer };