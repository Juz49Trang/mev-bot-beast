const EventEmitter = require('events');
const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { ProviderManager } = require('../infrastructure/ProviderManager');
const { Executor } = require('./Executor');
const { Monitor } = require('./Monitor');
const { RiskManager } = require('../risk/RiskManager');
const { DatabaseManager } = require('../database/DatabaseManager');
const { MetricsCollector } = require('../monitoring/MetricsCollector');
const { ArbitrageStrategy } = require('../strategies/ArbitrageStrategy');
const { SandwichStrategy } = require('../strategies/SandwichStrategy');
const { LiquidationStrategy } = require('../strategies/LiquidationStrategy');
const { FlashLoanArbitrage } = require('../strategies/FlashLoanArbitrage');
const { GasManager } = require('../infrastructure/GasManager');
const { CircuitBreaker } = require('../risk/CircuitBreaker');

class MEVBot extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.isRunning = false;
        
        // Core components
        this.providerManager = new ProviderManager(config.providers);
        this.executor = new Executor(this);
        this.monitor = new Monitor(this);
        this.riskManager = new RiskManager(config.risk);
        this.gasManager = new GasManager(this);
        this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
        
        // Database and monitoring
        this.db = new DatabaseManager(config.database);
        this.metrics = new MetricsCollector();
        
        // Strategies
        this.strategies = new Map();
        this.initializeStrategies();
        
        // Performance tracking
        this.performance = {
            startTime: Date.now(),
            totalProfit: ethers.BigNumber.from(0),
            successfulTrades: 0,
            failedTrades: 0,
            opportunitiesAnalyzed: 0
        };
        
        // Wallet management
        this.wallets = this.initializeWallets();
        
        logger.info('MEV Bot initialized', {
            strategies: Array.from(this.strategies.keys()),
            chains: config.chains,
            wallets: this.wallets.length
        });
    }
    
    initializeStrategies() {
        // Initialize all strategies based on config
        if (this.config.strategies.arbitrage.enabled) {
            this.strategies.set('arbitrage', new ArbitrageStrategy(this));
        }
        
        if (this.config.strategies.sandwich.enabled) {
            this.strategies.set('sandwich', new SandwichStrategy(this));
        }
        
        if (this.config.strategies.liquidation.enabled) {
            this.strategies.set('liquidation', new LiquidationStrategy(this));
        }
        
        if (this.config.strategies.flashloan.enabled) {
            this.strategies.set('flashloan', new FlashLoanArbitrage(this));
        }
        
        // Set up strategy event handlers
        this.strategies.forEach((strategy, name) => {
            strategy.on('opportunity', (opp) => this.handleOpportunity(opp, name));
            strategy.on('error', (err) => this.handleStrategyError(err, name));
        });
    }
    
    initializeWallets() {
        const wallets = [];
        
        // Main wallet
        const mainWallet = new ethers.Wallet(
            this.config.wallets.main.privateKey,
            this.providerManager.getProvider()
        );
        wallets.push({ type: 'main', wallet: mainWallet });
        
        // Burner wallets for different strategies
        if (this.config.wallets.burners) {
            this.config.wallets.burners.forEach((key, index) => {
                const burner = new ethers.Wallet(key, this.providerManager.getProvider());
                wallets.push({ type: 'burner', index, wallet: burner });
            });
        }
        
        return wallets;
    }
    
    async start() {
        if (this.isRunning) {
            logger.warn('Bot is already running');
            return;
        }
        
        logger.info('Starting MEV Bot...');
        
        try {
            // Initialize database
            await this.db.initialize();
            
            // Check balances
            await this.checkBalances();
            
            // Start monitoring
            await this.monitor.start();
            
            // Start strategies
            for (const [name, strategy] of this.strategies) {
                await strategy.start();
                logger.info(`Started strategy: ${name}`);
            }
            
            // Start metrics collection
            this.metrics.start();
            
            // Start gas price monitoring
            await this.gasManager.start();
            
            // Enable circuit breaker
            this.circuitBreaker.enable();
            
            this.isRunning = true;
            this.emit('started');
            
            logger.info('MEV Bot started successfully');
            
            // Start performance reporting
            this.startPerformanceReporting();
            
        } catch (error) {
            logger.error('Failed to start bot', error);
            throw error;
        }
    }
    
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        logger.info('Stopping MEV Bot...');
        
        // Stop all strategies
        for (const [name, strategy] of this.strategies) {
            await strategy.stop();
        }
        
        // Stop monitoring
        await this.monitor.stop();
        
        // Stop gas manager
        await this.gasManager.stop();
        
        // Disable circuit breaker
        this.circuitBreaker.disable();
        
        // Close database connections
        await this.db.close();
        
        this.isRunning = false;
        this.emit('stopped');
        
        logger.info('MEV Bot stopped');
    }
    
    async handleOpportunity(opportunity, strategyName) {
        try {
            this.performance.opportunitiesAnalyzed++;
            
            // Check circuit breaker
            if (this.circuitBreaker.isTripped()) {
                logger.warn('Circuit breaker is tripped, skipping opportunity');
                return;
            }
            
            // Risk assessment
            const riskAssessment = await this.riskManager.assessOpportunity(opportunity);
            
            if (!riskAssessment.approved) {
                logger.info('Opportunity rejected by risk manager', {
                    reason: riskAssessment.reason,
                    strategy: strategyName
                });
                await this.db.recordRejectedOpportunity(opportunity, riskAssessment.reason);
                return;
            }
            
            // Log opportunity
            logger.info('Processing opportunity', {
                strategy: strategyName,
                type: opportunity.type,
                expectedProfit: ethers.utils.formatEther(opportunity.expectedProfit),
                riskScore: riskAssessment.score
            });
            
            // Execute opportunity
            const result = await this.executor.execute(opportunity, riskAssessment);
            
            // Record result
            if (result.success) {
                this.performance.successfulTrades++;
                this.performance.totalProfit = this.performance.totalProfit.add(result.profit);
                
                await this.db.recordSuccessfulTrade({
                    ...opportunity,
                    ...result,
                    strategy: strategyName
                });
                
                this.metrics.recordTrade('success', strategyName, result.profit);
                
                logger.info('Trade executed successfully', {
                    profit: ethers.utils.formatEther(result.profit),
                    gasUsed: result.gasUsed,
                    txHash: result.txHash
                });
                
            } else {
                this.performance.failedTrades++;
                this.circuitBreaker.recordFailure();
                
                await this.db.recordFailedTrade({
                    ...opportunity,
                    ...result,
                    strategy: strategyName
                });
                
                this.metrics.recordTrade('failure', strategyName, ethers.BigNumber.from(0));
                
                logger.error('Trade execution failed', {
                    reason: result.reason,
                    error: result.error
                });
            }
            
        } catch (error) {
            logger.error('Error handling opportunity', error);
            this.circuitBreaker.recordFailure();
        }
    }
    
    handleStrategyError(error, strategyName) {
        logger.error(`Strategy error: ${strategyName}`, error);
        this.metrics.recordError(strategyName, error);
        
        // Check if we should disable the strategy
        if (this.circuitBreaker.shouldDisableStrategy(strategyName)) {
            logger.warn(`Disabling strategy due to errors: ${strategyName}`);
            this.strategies.get(strategyName).stop();
        }
    }
    
    async checkBalances() {
        const balances = [];
        
        for (const { type, wallet, index } of this.wallets) {
            const balance = await wallet.getBalance();
            const address = wallet.address;
            
            balances.push({
                type,
                index,
                address,
                balance: ethers.utils.formatEther(balance)
            });
            
            // Check minimum balance
            if (balance.lt(ethers.utils.parseEther(this.config.minBalance))) {
                logger.warn(`Low balance warning`, {
                    wallet: type,
                    address,
                    balance: ethers.utils.formatEther(balance)
                });
            }
        }
        
        logger.info('Wallet balances', balances);
        return balances;
    }
    
    startPerformanceReporting() {
        // Report performance every minute
        setInterval(async () => {
            const runtime = Date.now() - this.performance.startTime;
            const runtimeHours = runtime / (1000 * 60 * 60);
            
            const report = {
                runtime: `${Math.floor(runtimeHours)} hours`,
                totalProfit: ethers.utils.formatEther(this.performance.totalProfit),
                successfulTrades: this.performance.successfulTrades,
                failedTrades: this.performance.failedTrades,
                successRate: this.performance.successfulTrades / 
                    (this.performance.successfulTrades + this.performance.failedTrades) || 0,
                opportunitiesAnalyzed: this.performance.opportunitiesAnalyzed,
                profitPerHour: ethers.utils.formatEther(
                    this.performance.totalProfit.div(Math.max(1, Math.floor(runtimeHours)))
                )
            };
            
            logger.info('Performance Report', report);
            
            // Save to database
            await this.db.savePerformanceSnapshot(report);
            
            // Emit for dashboard
            this.emit('performance', report);
            
        }, 60000); // Every minute
    }
    
    // Getters for strategies to access bot resources
    getProvider() {
        return this.providerManager.getProvider();
    }
    
    getWallet(type = 'main') {
        const walletObj = this.wallets.find(w => w.type === type);
        return walletObj ? walletObj.wallet : null;
    }
    
    getGasPrice() {
        return this.gasManager.getOptimalGasPrice();
    }
}

module.exports = { MEVBot };