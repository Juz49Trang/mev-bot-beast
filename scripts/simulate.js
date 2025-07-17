require('dotenv').config();
const { ethers } = require('ethers');
const config = require('config');
const { logger } = require('../src/utils/logger');

// Import bot components
const { MEVBot } = require('../src/core/Bot');
const { ArbitrageStrategy } = require('../src/strategies/ArbitrageStrategy');

// Simulation configuration
const SIMULATION_CONFIG = {
    duration: 60 * 60 * 1000, // 1 hour
    blockTime: 2000, // 2 seconds per block
    mempoolTxRate: 10, // 10 transactions per second
    priceVolatility: 0.02, // 2% price movements
    startingBalance: ethers.utils.parseEther('10')
};

class MEVBotSimulator {
    constructor() {
        this.bot = null;
        this.provider = null;
        this.mockData = {
            blockNumber: 15000000,
            gasPrice: ethers.utils.parseUnits('30', 'gwei'),
            trades: [],
            profits: ethers.BigNumber.from(0)
        };
    }
    
    async initialize() {
        logger.info('Initializing MEV Bot Simulator...');
        
        // Create mock provider
        this.provider = new MockProvider(this.mockData);
        
        // Override config for simulation
        const simConfig = {
            ...config,
            providers: {
                primary: {
                    type: 'mock',
                    url: 'mock://localhost'
                }
            },
            strategies: {
                ...config.strategies,
                arbitrage: {
                    ...config.strategies.arbitrage,
                    enabled: true,
                    scanInterval: 1000
                }
            }
        };
        
        // Initialize bot with mock provider
        this.bot = new MEVBot(simConfig);
        
        // Override provider getter
        this.bot.getProvider = () => this.provider;
        
        // Set up event listeners
        this.setupEventListeners();
        
        logger.info('Simulator initialized');
    }
    
    setupEventListeners() {
        this.bot.on('opportunity', (opp) => {
            logger.info('Opportunity detected in simulation', {
                type: opp.type,
                expectedProfit: ethers.utils.formatEther(opp.expectedProfit)
            });
        });
        
        this.bot.on('trade', (trade) => {
            this.mockData.trades.push(trade);
            this.mockData.profits = this.mockData.profits.add(trade.profit);
            
            logger.info('Trade executed in simulation', {
                profit: ethers.utils.formatEther(trade.profit),
                totalProfit: ethers.utils.formatEther(this.mockData.profits)
            });
        });
    }
    
    async run() {
        logger.info('Starting simulation...');
        
        // Start the bot
        await this.bot.start();
        
        // Start block production
        this.startBlockProduction();
        
        // Start mempool simulation
        this.startMempoolSimulation();
        
        // Start price movements
        this.startPriceSimulation();
        
        // Run for specified duration
        await new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, SIMULATION_CONFIG.duration);
        });
        
        // Stop simulation
        await this.stop();
    }
    
    startBlockProduction() {
        this.blockInterval = setInterval(() => {
            this.mockData.blockNumber++;
            this.provider.emit('block', this.mockData.blockNumber);
            
            // Vary gas price
            const variance = Math.random() * 10 - 5; // ±5 gwei
            this.mockData.gasPrice = this.mockData.gasPrice.add(
                ethers.utils.parseUnits(variance.toString(), 'gwei')
            );
            
            if (this.mockData.blockNumber % 30 === 0) {
                logger.info(`Block ${this.mockData.blockNumber} produced`);
            }
        }, SIMULATION_CONFIG.blockTime);
    }
    
    startMempoolSimulation() {
        this.mempoolInterval = setInterval(() => {
            // Generate random swap transaction
            const tx = this.generateMockSwapTx();
            this.provider.emit('pending', tx);
        }, 1000 / SIMULATION_CONFIG.mempoolTxRate);
    }
    
    startPriceSimulation() {
        // Simulate price movements
        this.priceInterval = setInterval(() => {
            // Update mock DEX prices
            const tokens = ['WETH', 'USDC', 'USDT', 'DAI'];
            
            for (let i = 0; i < tokens.length; i++) {
                for (let j = i + 1; j < tokens.length; j++) {
                    const change = (Math.random() - 0.5) * SIMULATION_CONFIG.priceVolatility;
                    this.provider.updatePrice(tokens[i], tokens[j], change);
                }
            }
        }, 5000); // Every 5 seconds
    }
    
    generateMockSwapTx() {
        const tokens = ['WETH', 'USDC', 'USDT', 'DAI'];
        const tokenIn = tokens[Math.floor(Math.random() * tokens.length)];
        let tokenOut = tokens[Math.floor(Math.random() * tokens.length)];
        
        while (tokenOut === tokenIn) {
            tokenOut = tokens[Math.floor(Math.random() * tokens.length)];
        }
        
        const amount = ethers.utils.parseEther((Math.random() * 10).toFixed(4));
        
        return {
            hash: ethers.utils.id(Math.random().toString()),
            from: ethers.Wallet.createRandom().address,
            to: '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap V3
            value: tokenIn === 'WETH' ? amount : ethers.BigNumber.from(0),
            data: '0x', // Simplified
            gasPrice: this.mockData.gasPrice,
            decoded: {
                type: 'swap',
                tokenIn,
                tokenOut,
                amountIn: amount
            }
        };
    }
    
    async stop() {
        logger.info('Stopping simulation...');
        
        // Clear intervals
        clearInterval(this.blockInterval);
        clearInterval(this.mempoolInterval);
        clearInterval(this.priceInterval);
        
        // Stop bot
        await this.bot.stop();
        
        // Print results
        this.printResults();
    }
    
    printResults() {
        const duration = SIMULATION_CONFIG.duration / 1000 / 60; // minutes
        
        console.log('\n========== Simulation Results ==========');
        console.log(`Duration: ${duration} minutes`);
        console.log(`Blocks produced: ${this.mockData.blockNumber - 15000000}`);
        console.log(`Trades executed: ${this.mockData.trades.length}`);
        console.log(`Total profit: ${ethers.utils.formatEther(this.mockData.profits)} ETH`);
        console.log(`Average profit per trade: ${
            this.mockData.trades.length > 0 
                ? ethers.utils.formatEther(this.mockData.profits.div(this.mockData.trades.length))
                : '0'
        } ETH`);
        console.log(`Profit per hour: ${
            ethers.utils.formatEther(
                this.mockData.profits.mul(60).div(duration)
            )
        } ETH`);
        console.log('=======================================\n');
        
        // Strategy breakdown
        const strategyStats = {};
        this.mockData.trades.forEach(trade => {
            if (!strategyStats[trade.strategy]) {
                strategyStats[trade.strategy] = {
                    count: 0,
                    profit: ethers.BigNumber.from(0)
                };
            }
            strategyStats[trade.strategy].count++;
            strategyStats[trade.strategy].profit = 
                strategyStats[trade.strategy].profit.add(trade.profit);
        });
        
        console.log('Strategy Performance:');
        Object.entries(strategyStats).forEach(([strategy, stats]) => {
            console.log(`${strategy}: ${stats.count} trades, ${
                ethers.utils.formatEther(stats.profit)
            } ETH profit`);
        });
    }
}

// Mock Provider for simulation
class MockProvider extends ethers.providers.BaseProvider {
    constructor(mockData) {
        super(8453); // Base chain ID
        this.mockData = mockData;
        this.prices = new Map();
        this.initializePrices();
    }
    
    initializePrices() {
        // Initialize mock prices
        this.prices.set('WETH-USDC', 3800);
        this.prices.set('USDC-USDT', 1.001);
        this.prices.set('USDT-DAI', 0.999);
        this.prices.set('WETH-DAI', 3795);
    }
    
    async getBlockNumber() {
        return this.mockData.blockNumber;
    }
    
    async getGasPrice() {
        return this.mockData.gasPrice;
    }
    
    async getBalance(address) {
        return SIMULATION_CONFIG.startingBalance;
    }
    
    updatePrice(tokenA, tokenB, change) {
        const key = `${tokenA}-${tokenB}`;
        const currentPrice = this.prices.get(key) || 1;
        this.prices.set(key, currentPrice * (1 + change));
    }
}

// Run simulation
async function main() {
    const simulator = new MEVBotSimulator();
    
    try {
        await simulator.initialize();
        await simulator.run();
    } catch (error) {
        logger.error('Simulation error:', error);
        process.exit(1);
    }
}

main().catch(console.error);