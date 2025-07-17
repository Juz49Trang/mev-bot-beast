const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { DatabaseManager } = require('../src/database/DatabaseManager');
const { logger } = require('../src/utils/logger');
const config = require('config');

class DashboardServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.db = new DatabaseManager(config.get('database'));
        
        this.clients = new Set();
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }
    
    setupMiddleware() {
        // Security
        this.app.use(helmet({
            contentSecurityPolicy: false // Allow inline scripts for dashboard
        }));
        
        // Compression
        this.app.use(compression());
        
        // CORS
        this.app.use(cors());
        
        // Body parsing
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // Static files
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Basic auth if enabled
        if (config.get('dashboard.auth.enabled')) {
            this.app.use(this.basicAuth.bind(this));
        }
    }
    
    basicAuth(req, res, next) {
        // Skip auth for WebSocket upgrade requests
        if (req.headers.upgrade === 'websocket') {
            return next();
        }
        
        const auth = req.headers.authorization;
        
        if (!auth || !auth.startsWith('Basic ')) {
            res.status(401).set('WWW-Authenticate', 'Basic realm="MEV Bot Dashboard"').send('Authentication required');
            return;
        }
        
        const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        const username = credentials[0];
        const password = credentials[1];
        
        if (username === config.get('dashboard.auth.username') && 
            password === config.get('dashboard.auth.password')) {
            next();
        } else {
            res.status(401).set('WWW-Authenticate', 'Basic realm="MEV Bot Dashboard"').send('Invalid credentials');
        }
    }
    
    setupRoutes() {
        // API routes
        this.app.get('/api/stats', this.getStats.bind(this));
        this.app.get('/api/trades', this.getTrades.bind(this));
        this.app.get('/api/performance', this.getPerformance.bind(this));
        this.app.get('/api/strategies', this.getStrategies.bind(this));
        this.app.get('/api/risk', this.getRiskMetrics.bind(this));
        this.app.get('/api/bot/status', this.getBotStatus.bind(this));
        this.app.get('/api/gas', this.getGasMetrics.bind(this));
        this.app.get('/api/opportunities', this.getOpportunities.bind(this));
        
        // Control routes
        this.app.post('/api/bot/start', this.startBot.bind(this));
        this.app.post('/api/bot/stop', this.stopBot.bind(this));
        this.app.post('/api/strategy/:name/toggle', this.toggleStrategy.bind(this));
        
        // Serve dashboard
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
    }
    
    setupWebSocket() {
        this.wss.on('connection', (ws, req) => {
            logger.info('Dashboard client connected');
            
            // Store client with metadata
            const client = {
                ws,
                id: Date.now(),
                ip: req.socket.remoteAddress
            };
            
            this.clients.add(client);
            
            // Send initial data
            this.sendInitialData(client);
            
            // Set up ping/pong for connection health
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleClientMessage(client, data);
                } catch (error) {
                    logger.error('Invalid WebSocket message', error);
                }
            });
            
            ws.on('close', () => {
                logger.info('Dashboard client disconnected');
                this.clients.delete(client);
            });
            
            ws.on('error', (error) => {
                logger.error('WebSocket error:', error);
                this.clients.delete(client);
            });
        });
        
        // Heartbeat to detect broken connections
        setInterval(() => {
            this.clients.forEach((client) => {
                if (client.ws.isAlive === false) {
                    client.ws.terminate();
                    this.clients.delete(client);
                    return;
                }
                
                client.ws.isAlive = false;
                client.ws.ping();
            });
        }, 30000);
    }
    
    async sendInitialData(client) {
        try {
            const stats = await this.db.getTradingStats(24);
            const recentTrades = await this.db.getRecentTrades(10);
            const topStrategies = await this.db.getTopStrategies(5);
            
            client.ws.send(JSON.stringify({
                type: 'initial',
                data: {
                    stats,
                    recentTrades,
                    topStrategies,
                    timestamp: Date.now()
                }
            }));
        } catch (error) {
            logger.error('Error sending initial data:', error);
        }
    }
    
    handleClientMessage(client, message) {
        switch (message.type) {
            case 'subscribe':
                // Handle subscription to specific data streams
                client.subscriptions = message.channels || [];
                break;
                
            case 'ping':
                client.ws.send(JSON.stringify({ type: 'pong' }));
                break;
                
            default:
                logger.warn('Unknown message type:', message.type);
        }
    }
    
    broadcast(message) {
        const data = JSON.stringify(message);
        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        });
    }
    
    async getStats(req, res) {
        try {
            const hours = parseInt(req.query.hours) || 24;
            const stats = await this.db.getTradingStats(hours);
            res.json(stats);
        } catch (error) {
            logger.error('Error getting stats:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getTrades(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;
            const strategy = req.query.strategy;
            
            let trades;
            if (strategy) {
                trades = await this.db.getTradesByStrategy(strategy, limit, offset);
            } else {
                trades = await this.db.getRecentTrades(limit);
            }
            
            res.json(trades);
        } catch (error) {
            logger.error('Error getting trades:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getPerformance(req, res) {
        try {
            const performance = {
                daily: await this.db.getTradingStats(24),
                weekly: await this.db.getTradingStats(24 * 7),
                monthly: await this.db.getTradingStats(24 * 30),
                all_time: await this.db.getTradingStats(24 * 365)
            };
            
            // Add profit chart data
            performance.profitChart = await this.db.getProfitHistory(30);
            
            res.json(performance);
        } catch (error) {
            logger.error('Error getting performance:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getStrategies(req, res) {
        try {
            const strategies = await this.db.getTopStrategies(10);
            res.json(strategies);
        } catch (error) {
            logger.error('Error getting strategies:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getRiskMetrics(req, res) {
        try {
            // This would connect to the actual risk manager
            const riskMetrics = {
                currentPositions: 0,
                dailyLossLimit: config.get('risk.maxDailyLossETH'),
                remainingLimit: '0.8 ETH',
                riskScore: 3.5,
                recentEvents: await this.db.getRecentRiskEvents(10)
            };
            res.json(riskMetrics);
        } catch (error) {
            logger.error('Error getting risk metrics:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getBotStatus(req, res) {
        try {
            // This would connect to the actual bot instance
            const status = {
                running: true,
                uptime: process.uptime(),
                version: config.get('bot.version'),
                chain: config.get('chains.base.name'),
                strategies: {
                    arbitrage: { enabled: true, running: true },
                    flashloan: { enabled: true, running: true },
                    liquidation: { enabled: true, running: false },
                    sandwich: { enabled: false, running: false }
                },
                health: {
                    database: await this.checkDatabaseHealth(),
                    rpc: true,
                    memory: process.memoryUsage()
                }
            };
            res.json(status);
        } catch (error) {
            logger.error('Error getting bot status:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getGasMetrics(req, res) {
        try {
            // Mock gas metrics - would connect to GasManager
            const gasMetrics = {
                current: {
                    slow: '20 gwei',
                    standard: '25 gwei',
                    fast: '30 gwei',
                    instant: '40 gwei'
                },
                trend: 'stable',
                avgLast24h: '22 gwei'
            };
            res.json(gasMetrics);
        } catch (error) {
            logger.error('Error getting gas metrics:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async getOpportunities(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const opportunities = await this.db.getRecentOpportunities(limit);
            res.json(opportunities);
        } catch (error) {
            logger.error('Error getting opportunities:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    async startBot(req, res) {
        try {
            // This would send command to actual bot
            logger.info('Start bot command received');
            res.json({ success: true, message: 'Bot starting...' });
        } catch (error) {
            logger.error('Error starting bot:', error);
            res.status(500).json({ error: 'Failed to start bot' });
        }
    }
    
    async stopBot(req, res) {
        try {
            // This would send command to actual bot
            logger.info('Stop bot command received');
            res.json({ success: true, message: 'Bot stopping...' });
        } catch (error) {
            logger.error('Error stopping bot:', error);
            res.status(500).json({ error: 'Failed to stop bot' });
        }
    }
    
    async toggleStrategy(req, res) {
        try {
            const { name } = req.params;
            const { enabled } = req.body;
            
            logger.info(`Toggle strategy ${name} to ${enabled}`);
            res.json({ success: true, strategy: name, enabled });
        } catch (error) {
            logger.error('Error toggling strategy:', error);
            res.status(500).json({ error: 'Failed to toggle strategy' });
        }
    }
    
    async checkDatabaseHealth() {
        try {
            await this.db.pool.query('SELECT 1');
            return true;
        } catch (error) {
            return false;
        }
    }
    
    async start() {
        await this.db.initialize();
        
        const port = config.get('dashboard.port') || 3000;
        const host = config.get('dashboard.host') || '0.0.0.0';
        
        this.server.listen(port, host, () => {
            logger.info(`Dashboard server running at http://${host}:${port}`);
        });
    }
    
    // Methods to receive updates from bot
    updateTrade(trade) {
        this.broadcast({
            type: 'trade',
            data: trade,
            timestamp: Date.now()
        });
    }
    
    updateStats(stats) {
        this.broadcast({
            type: 'stats',
            data: stats,
            timestamp: Date.now()
        });
    }
    
    updatePerformance(performance) {
        this.broadcast({
            type: 'performance',
            data: performance,
            timestamp: Date.now()
        });
    }
    
    updateOpportunity(opportunity) {
        this.broadcast({
            type: 'opportunity',
            data: opportunity,
            timestamp: Date.now()
        });
    }
    
    updateGasPrice(gasData) {
        this.broadcast({
            type: 'gas',
            data: gasData,
            timestamp: Date.now()
        });
    }
    
    sendAlert(alert) {
        this.broadcast({
            type: 'alert',
            data: alert,
            timestamp: Date.now()
        });
    }
}

// Start server if run directly
if (require.main === module) {
    const server = new DashboardServer();
    server.start().catch(error => {
        logger.error('Failed to start dashboard server:', error);
        process.exit(1);
    });
}

module.exports = { DashboardServer };