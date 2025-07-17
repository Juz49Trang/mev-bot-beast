const WebSocket = require('ws');
const { logger } = require('../src/utils/logger');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
    constructor(server) {
        super();
        this.wss = new WebSocket.Server({ server });
        this.clients = new Map();
        this.channels = new Map();
        
        this.setupWebSocketServer();
        this.startHeartbeat();
    }
    
    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateClientId();
            const clientIp = req.socket.remoteAddress;
            
            const client = {
                id: clientId,
                ws: ws,
                ip: clientIp,
                connectedAt: Date.now(),
                subscriptions: new Set(),
                isAlive: true
            };
            
            this.clients.set(clientId, client);
            
            logger.info(`WebSocket client connected: ${clientId} from ${clientIp}`);
            
            // Send welcome message
            this.sendToClient(client, {
                type: 'welcome',
                clientId: clientId,
                timestamp: Date.now()
            });
            
            // Set up event handlers
            ws.on('message', (message) => this.handleMessage(client, message));
            ws.on('close', () => this.handleDisconnect(client));
            ws.on('error', (error) => this.handleError(client, error));
            ws.on('pong', () => this.handlePong(client));
            
            // Emit connection event
            this.emit('client:connected', client);
        });
        
        logger.info('WebSocket server initialized');
    }
    
    handleMessage(client, message) {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'subscribe':
                    this.handleSubscribe(client, data);
                    break;
                    
                case 'unsubscribe':
                    this.handleUnsubscribe(client, data);
                    break;
                    
                case 'ping':
                    this.sendToClient(client, { type: 'pong', timestamp: Date.now() });
                    break;
                    
                case 'request':
                    this.handleRequest(client, data);
                    break;
                    
                default:
                    logger.warn(`Unknown message type from client ${client.id}: ${data.type}`);
            }
            
        } catch (error) {
            logger.error(`Error handling message from client ${client.id}:`, error);
            this.sendError(client, 'Invalid message format');
        }
    }
    
    handleSubscribe(client, data) {
        const { channels } = data;
        
        if (!Array.isArray(channels)) {
            this.sendError(client, 'Channels must be an array');
            return;
        }
        
        channels.forEach(channel => {
            // Add client to channel
            if (!this.channels.has(channel)) {
                this.channels.set(channel, new Set());
            }
            this.channels.get(channel).add(client.id);
            
            // Add channel to client subscriptions
            client.subscriptions.add(channel);
            
            logger.debug(`Client ${client.id} subscribed to ${channel}`);
        });
        
        this.sendToClient(client, {
            type: 'subscribed',
            channels: channels,
            timestamp: Date.now()
        });
    }
    
    handleUnsubscribe(client, data) {
        const { channels } = data;
        
        if (!Array.isArray(channels)) {
            this.sendError(client, 'Channels must be an array');
            return;
        }
        
        channels.forEach(channel => {
            // Remove client from channel
            if (this.channels.has(channel)) {
                this.channels.get(channel).delete(client.id);
                
                // Clean up empty channels
                if (this.channels.get(channel).size === 0) {
                    this.channels.delete(channel);
                }
            }
            
            // Remove channel from client subscriptions
            client.subscriptions.delete(channel);
            
            logger.debug(`Client ${client.id} unsubscribed from ${channel}`);
        });
        
        this.sendToClient(client, {
            type: 'unsubscribed',
            channels: channels,
            timestamp: Date.now()
        });
    }
    
    handleRequest(client, data) {
        const { request, params } = data;
        
        // Emit request event for handling by dashboard server
        this.emit('client:request', {
            client,
            request,
            params,
            respond: (response) => {
                this.sendToClient(client, {
                    type: 'response',
                    request: request,
                    data: response,
                    timestamp: Date.now()
                });
            }
        });
    }
    
    handleDisconnect(client) {
        logger.info(`WebSocket client disconnected: ${client.id}`);
        
        // Remove from all channels
        client.subscriptions.forEach(channel => {
            if (this.channels.has(channel)) {
                this.channels.get(channel).delete(client.id);
                
                if (this.channels.get(channel).size === 0) {
                    this.channels.delete(channel);
                }
            }
        });
        
        // Remove client
        this.clients.delete(client.id);
        
        // Emit disconnection event
        this.emit('client:disconnected', client);
    }
    
    handleError(client, error) {
        logger.error(`WebSocket error for client ${client.id}:`, error);
        
        // Close connection on error
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.close();
        }
    }
    
    handlePong(client) {
        client.isAlive = true;
    }
    
    startHeartbeat() {
        // Ping clients every 30 seconds to detect broken connections
        this.heartbeatInterval = setInterval(() => {
            this.clients.forEach((client) => {
                if (!client.isAlive) {
                    logger.warn(`Client ${client.id} failed heartbeat check`);
                    client.ws.terminate();
                    this.handleDisconnect(client);
                    return;
                }
                
                client.isAlive = false;
                client.ws.ping();
            });
        }, 30000);
    }
    
    // Broadcasting methods
    broadcast(channel, data) {
        if (!this.channels.has(channel)) {
            return;
        }
        
        const message = JSON.stringify({
            channel,
            ...data,
            timestamp: Date.now()
        });
        
        this.channels.get(channel).forEach(clientId => {
            const client = this.clients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        });
    }
    
    broadcastToAll(data) {
        const message = JSON.stringify({
            ...data,
            timestamp: Date.now()
        });
        
        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        });
    }
    
    sendToClient(client, data) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }
    
    sendError(client, error) {
        this.sendToClient(client, {
            type: 'error',
            error: error,
            timestamp: Date.now()
        });
    }
    
    // Utility methods
    generateClientId() {
        return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    getClientCount() {
        return this.clients.size;
    }
    
    getChannelCount() {
        return this.channels.size;
    }
    
    getStats() {
        const stats = {
            clients: this.clients.size,
            channels: this.channels.size,
            subscriptions: 0
        };
        
        this.clients.forEach(client => {
            stats.subscriptions += client.subscriptions.size;
        });
        
        // Channel breakdown
        stats.channelBreakdown = {};
        this.channels.forEach((clients, channel) => {
            stats.channelBreakdown[channel] = clients.size;
        });
        
        return stats;
    }
    
    // Clean up
    close() {
        // Clear heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Close all client connections
        this.clients.forEach(client => {
            client.ws.close();
        });
        
        // Close WebSocket server
        this.wss.close();
        
        logger.info('WebSocket server closed');
    }
}

// Channel names for different data types
const CHANNELS = {
    TRADES: 'trades',
    OPPORTUNITIES: 'opportunities',
    PERFORMANCE: 'performance',
    GAS_PRICES: 'gas',
    ALERTS: 'alerts',
    SYSTEM: 'system',
    RISK: 'risk'
};

module.exports = { WebSocketManager, CHANNELS };