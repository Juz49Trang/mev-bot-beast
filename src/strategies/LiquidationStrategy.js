const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');

class LiquidationStrategy extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.config = bot.config.strategies.liquidation;
        
        this.isRunning = false;
        this.protocols = new Map();
        this.monitoredPositions = new Map();
        
        // Configuration
        this.healthFactorThreshold = this.config.healthFactorThreshold || 1.05;
        this.minProfitETH = ethers.utils.parseEther(this.config.minProfitETH || '0.01');
        this.scanInterval = this.config.scanInterval || 5000;
        
        // Initialize protocol adapters
        this.initializeProtocols();
        
        logger.info('Liquidation strategy initialized');
    }
    
    initializeProtocols() {
        // Initialize Aave adapter
        if (this.config.protocols.includes('aave')) {
            this.protocols.set('aave', {
                name: 'Aave',
                lendingPool: this.bot.config.contracts.lendingProtocols.aave,
                dataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654' // Example
            });
        }
        
        // Initialize Compound adapter
        if (this.config.protocols.includes('compound')) {
            this.protocols.set('compound', {
                name: 'Compound',
                comptroller: this.bot.config.contracts.lendingProtocols.compound
            });
        }
    }
    
    async start() {
        if (this.isRunning) {
            return;
        }
        
        logger.info('Starting liquidation strategy...');
        
        // Start position monitoring
        this.startPositionMonitoring();
        
        // Subscribe to events
        this.bot.monitor.on('block', this.onNewBlock.bind(this));
        
        this.isRunning = true;
        logger.info('Liquidation strategy started');
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        
        this.isRunning = false;
        logger.info('Liquidation strategy stopped');
    }
    
    startPositionMonitoring() {
        this.scanInterval = setInterval(async () => {
            try {
                await this.scanAllProtocols();
            } catch (error) {
                logger.error('Error scanning for liquidations', error);
            }
        }, this.scanInterval);
    }
    
    async scanAllProtocols() {
        const scanPromises = Array.from(this.protocols.entries()).map(
            ([name, protocol]) => this.scanProtocol(name, protocol)
        );
        
        await Promise.allSettled(scanPromises);
    }
    
    async scanProtocol(name, protocol) {
        try {
            if (name === 'aave') {
                await this.scanAavePositions(protocol);
            } else if (name === 'compound') {
                await this.scanCompoundPositions(protocol);
            }
        } catch (error) {
            logger.error(`Error scanning ${name} positions`, error);
        }
    }
    
    async scanAavePositions(protocol) {
        // Get Aave lending pool contract
        const lendingPool = new ethers.Contract(
            protocol.lendingPool,
            [
                'function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
            ],
            this.bot.getProvider()
        );
        
        // Get users to monitor (from events or known addresses)
        const users = await this.getAaveUsers(protocol);
        
        for (const user of users) {
            try {
                const accountData = await lendingPool.getUserAccountData(user);
                const healthFactor = accountData.healthFactor;
                
                // Convert health factor (1e18 = 1.0)
                const healthFactorNumber = parseFloat(ethers.utils.formatUnits(healthFactor, 18));
                
                if (healthFactorNumber < this.healthFactorThreshold && healthFactorNumber > 0) {
                    const opportunity = await this.calculateAaveLiquidation(user, accountData, protocol);
                    
                    if (opportunity) {
                        this.emit('opportunity', opportunity);
                    }
                }
                
            } catch (error) {
                logger.debug(`Error checking Aave user ${user}`, error);
            }
        }
    }
    
    async scanCompoundPositions(protocol) {
        // Similar implementation for Compound
        logger.debug('Scanning Compound positions...');
        // Implementation would follow similar pattern to Aave
    }
    
    async getAaveUsers(protocol) {
        // In production, this would:
        // 1. Query historical events for borrowers
        // 2. Use a subgraph for active positions
        // 3. Monitor specific known addresses
        
        // For now, return empty array
        return [];
    }
    
    async calculateAaveLiquidation(user, accountData, protocol) {
        try {
            const totalCollateral = accountData.totalCollateralETH;
            const totalDebt = accountData.totalDebtETH;
            
            // Calculate liquidation bonus (typically 5-10%)
            const liquidationBonus = 5; // 5%
            const maxLiquidation = totalDebt.div(2); // Can liquidate up to 50%
            
            // Calculate expected profit
            const collateralReceived = maxLiquidation.mul(100 + liquidationBonus).div(100);
            const profit = collateralReceived.sub(maxLiquidation);
            
            // Account for gas costs
            const gasEstimate = ethers.BigNumber.from(400000);
            const gasPrice = await this.bot.getGasPrice();
            const gasCost = gasEstimate.mul(gasPrice);
            
            const netProfit = profit.sub(gasCost);
            
            if (netProfit.lt(this.minProfitETH)) {
                return null;
            }
            
            return {
                type: 'liquidation',
                strategy: 'liquidation',
                protocol: 'aave',
                user,
                healthFactor: accountData.healthFactor,
                totalCollateral,
                totalDebt,
                maxLiquidation,
                expectedProfit: netProfit,
                gasEstimate,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error('Error calculating Aave liquidation', error);
            return null;
        }
    }
    
    async onNewBlock(blockData) {
        // Quick check for liquidation events
        // This helps identify new liquidatable positions quickly
    }
    
    async calculateProfit(receipt, opportunity) {
        // Parse liquidation events to calculate actual profit
        try {
            // Would parse LiquidationCall events
            return opportunity.expectedProfit;
        } catch (error) {
            logger.error('Error calculating liquidation profit', error);
            return ethers.BigNumber.from(0);
        }
    }
}

module.exports = { LiquidationStrategy };