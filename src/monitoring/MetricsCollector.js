const prometheus = require('prom-client');
const { logger } = require('../utils/logger');

class MetricsCollector {
    constructor() {
        // Create registry
        this.register = new prometheus.Registry();
        
        // Add default metrics
        prometheus.collectDefaultMetrics({ register: this.register });
        
        // Initialize custom metrics
        this.initializeMetrics();
        
        logger.info('Metrics collector initialized');
    }
    
    initializeMetrics() {
        // Trading metrics
        this.metrics = {
            // Counters
            tradesTotal: new prometheus.Counter({
                name: 'mev_bot_trades_total',
                help: 'Total number of trades executed',
                labelNames: ['strategy', 'status'],
                registers: [this.register]
            }),
            
            opportunitiesFound: new prometheus.Counter({
                name: 'mev_bot_opportunities_found_total',
                help: 'Total number of opportunities found',
                labelNames: ['strategy', 'type'],
                registers: [this.register]
            }),
            
            errorsTotal: new prometheus.Counter({
                name: 'mev_bot_errors_total',
                help: 'Total number of errors',
                labelNames: ['type', 'strategy'],
                registers: [this.register]
            }),
            
            // Gauges
            profitTotal: new prometheus.Gauge({
                name: 'mev_bot_profit_total_eth',
                help: 'Total profit in ETH',
                labelNames: ['strategy'],
                registers: [this.register]
            }),
            
            gasPrice: new prometheus.Gauge({
                name: 'mev_bot_gas_price_gwei',
                help: 'Current gas price in gwei',
                labelNames: ['type'],
                registers: [this.register]
            }),
            
            walletBalance: new prometheus.Gauge({
                name: 'mev_bot_wallet_balance_eth',
                help: 'Wallet balance in ETH',
                labelNames: ['wallet'],
                registers: [this.register]
            }),
            
            activeStrategies: new prometheus.Gauge({
                name: 'mev_bot_active_strategies',
                help: 'Number of active strategies',
                registers: [this.register]
            }),
            
            riskScore: new prometheus.Gauge({
                name: 'mev_bot_risk_score',
                help: 'Current risk score (0-10)',
                registers: [this.register]
            }),
            
            // Histograms
            tradeExecutionTime: new prometheus.Histogram({
                name: 'mev_bot_trade_execution_duration_seconds',
                help: 'Trade execution duration in seconds',
                labelNames: ['strategy'],
                buckets: [0.1, 0.5, 1, 2, 5, 10],
                registers: [this.register]
            }),
            
            opportunityProcessingTime: new prometheus.Histogram({
                name: 'mev_bot_opportunity_processing_duration_seconds',
                help: 'Opportunity processing duration in seconds',
                labelNames: ['strategy'],
                buckets: [0.01, 0.05, 0.1, 0.5, 1],
                registers: [this.register]
            }),
            
            profitPerTrade: new prometheus.Histogram({
                name: 'mev_bot_profit_per_trade_eth',
                help: 'Profit per trade in ETH',
                labelNames: ['strategy'],
                buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 10],
                registers: [this.register]
            }),
            
            gasUsedPerTrade: new prometheus.Histogram({
                name: 'mev_bot_gas_used_per_trade',
                help: 'Gas used per trade',
                labelNames: ['strategy'],
                buckets: [100000, 200000, 300000, 500000, 1000000],
                registers: [this.register]
            })
        };
        
        // System metrics
        this.systemMetrics = {
            memoryUsage: new prometheus.Gauge({
                name: 'mev_bot_memory_usage_bytes',
                help: 'Memory usage in bytes',
                labelNames: ['type'],
                registers: [this.register]
            }),
            
            cpuUsage: new prometheus.Gauge({
                name: 'mev_bot_cpu_usage_percent',
                help: 'CPU usage percentage',
                registers: [this.register]
            }),
            
            eventLoopLag: new prometheus.Gauge({
                name: 'mev_bot_event_loop_lag_ms',
                help: 'Event loop lag in milliseconds',
                registers: [this.register]
            })
        };
        
        // Network metrics
        this.networkMetrics = {
            rpcLatency: new prometheus.Histogram({
                name: 'mev_bot_rpc_latency_ms',
                help: 'RPC call latency in milliseconds',
                labelNames: ['provider', 'method'],
                buckets: [10, 50, 100, 500, 1000, 5000],
                registers: [this.register]
            }),
            
            rpcErrors: new prometheus.Counter({
                name: 'mev_bot_rpc_errors_total',
                help: 'Total RPC errors',
                labelNames: ['provider', 'error'],
                registers: [this.register]
            }),
            
            blockDelay: new prometheus.Gauge({
                name: 'mev_bot_block_delay_seconds',
                help: 'Delay in receiving new blocks',
                registers: [this.register]
            })
        };
    }
    
    // Record methods
    recordTrade(status, strategy, profit = 0) {
        this.metrics.tradesTotal.labels(strategy, status).inc();
        
        if (status === 'success' && profit > 0) {
            this.metrics.profitTotal.labels(strategy).inc(profit);
            this.metrics.profitPerTrade.labels(strategy).observe(profit);
        }
    }
    
    recordOpportunity(strategy, type) {
        this.metrics.opportunitiesFound.labels(strategy, type).inc();
    }
    
    recordError(type, strategy = 'unknown') {
        this.metrics.errorsTotal.labels(type, strategy).inc();
    }
    
    recordTradeExecution(strategy, duration) {
        this.metrics.tradeExecutionTime.labels(strategy).observe(duration);
    }
    
    recordOpportunityProcessing(strategy, duration) {
        this.metrics.opportunityProcessingTime.labels(strategy).observe(duration);
    }
    
    recordGasUsed(strategy, gasUsed) {
        this.metrics.gasUsedPerTrade.labels(strategy).observe(gasUsed);
    }
    
    updateGasPrice(type, priceGwei) {
        this.metrics.gasPrice.labels(type).set(priceGwei);
    }
    
    updateWalletBalance(wallet, balanceEth) {
        this.metrics.walletBalance.labels(wallet).set(balanceEth);
    }
    
    updateActiveStrategies(count) {
        this.metrics.activeStrategies.set(count);
    }
    
    updateRiskScore(score) {
        this.metrics.riskScore.set(score);
    }
    
    recordRPCLatency(provider, method, latencyMs) {
        this.networkMetrics.rpcLatency.labels(provider, method).observe(latencyMs);
    }
    
    recordRPCError(provider, error) {
        this.networkMetrics.rpcErrors.labels(provider, error).inc();
    }
    
    updateBlockDelay(delaySeconds) {
        this.networkMetrics.blockDelay.set(delaySeconds);
    }
    
    // System metrics collection
    start() {
        // Collect system metrics every 10 seconds
        this.systemInterval = setInterval(() => {
            this.collectSystemMetrics();
        }, 10000);
        
        // Monitor event loop lag
        this.monitorEventLoopLag();
    }
    
    collectSystemMetrics() {
        // Memory usage
        const memUsage = process.memoryUsage();
        this.systemMetrics.memoryUsage.labels('heapUsed').set(memUsage.heapUsed);
        this.systemMetrics.memoryUsage.labels('heapTotal').set(memUsage.heapTotal);
        this.systemMetrics.memoryUsage.labels('rss').set(memUsage.rss);
        this.systemMetrics.memoryUsage.labels('external').set(memUsage.external);
        
        // CPU usage
        const cpuUsage = process.cpuUsage();
        const totalCpu = cpuUsage.user + cpuUsage.system;
        this.systemMetrics.cpuUsage.set(totalCpu / 1000000); // Convert to percentage
    }
    
    monitorEventLoopLag() {
        let lastCheck = Date.now();
        
        setInterval(() => {
            const now = Date.now();
            const lag = now - lastCheck - 1000; // Expected 1000ms interval
            
            if (lag > 0) {
                this.systemMetrics.eventLoopLag.set(lag);
            }
            
            lastCheck = now;
        }, 1000);
    }
    
    // Express middleware for metrics endpoint
    metricsMiddleware() {
        return async (req, res) => {
            try {
                res.set('Content-Type', this.register.contentType);
                res.end(await this.register.metrics());
            } catch (error) {
                logger.error('Error generating metrics', error);
                res.status(500).end();
            }
        };
    }
    
    // Get metrics for internal use
    async getMetrics() {
        return this.register.getMetricsAsJSON();
    }
    
    // Reset all metrics
    reset() {
        this.register.resetMetrics();
    }
    
    // Clean up
    stop() {
        if (this.systemInterval) {
            clearInterval(this.systemInterval);
        }
    }
}

module.exports = { MetricsCollector };