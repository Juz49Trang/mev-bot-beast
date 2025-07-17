const EventEmitter = require('events');
const { logger } = require('../utils/logger');

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100); // Increase limit for complex bot
        
        // Event tracking
        this.eventCounts = new Map();
        this.eventHandlers = new Map();
        
        // Performance monitoring
        this.eventLatencies = new Map();
        
        // Set up error handling
        this.on('error', this.handleError.bind(this));
    }
    
    /**
     * Enhanced emit with tracking
     */
    emit(event, ...args) {
        const startTime = Date.now();
        
        // Track event count
        const count = this.eventCounts.get(event) || 0;
        this.eventCounts.set(event, count + 1);
        
        // Emit the event
        const result = super.emit(event, ...args);
        
        // Track latency
        const latency = Date.now() - startTime;
        const latencies = this.eventLatencies.get(event) || [];
        latencies.push(latency);
        
        // Keep only last 100 latencies
        if (latencies.length > 100) {
            latencies.shift();
        }
        this.eventLatencies.set(event, latencies);
        
        // Log slow events
        if (latency > 100) {
            logger.warn(`Slow event processing: ${event} took ${latency}ms`);
        }
        
        return result;
    }
    
    /**
     * Register event handler with metadata
     */
    register(event, handler, metadata = {}) {
        this.on(event, handler);
        
        // Store handler metadata
        const handlers = this.eventHandlers.get(event) || [];
        handlers.push({
            handler,
            metadata,
            registeredAt: Date.now()
        });
        this.eventHandlers.set(event, handlers);
        
        logger.debug(`Registered handler for event: ${event}`, metadata);
    }
    
    /**
     * Unregister specific handler
     */
    unregister(event, handler) {
        this.removeListener(event, handler);
        
        // Remove from metadata
        const handlers = this.eventHandlers.get(event) || [];
        const filtered = handlers.filter(h => h.handler !== handler);
        this.eventHandlers.set(event, filtered);
    }
    
    /**
     * Get event statistics
     */
    getEventStats() {
        const stats = {};
        
        for (const [event, count] of this.eventCounts) {
            const latencies = this.eventLatencies.get(event) || [];
            const avgLatency = latencies.length > 0
                ? latencies.reduce((a, b) => a + b, 0) / latencies.length
                : 0;
            
            stats[event] = {
                count,
                handlers: this.listenerCount(event),
                avgLatency: Math.round(avgLatency * 100) / 100
            };
        }
        
        return stats;
    }
    
    /**
     * Clear all event data
     */
    reset() {
        this.eventCounts.clear();
        this.eventLatencies.clear();
        this.eventHandlers.clear();
        this.removeAllListeners();
    }
    
    /**
     * Handle errors
     */
    handleError(error) {
        logger.error('EventBus error:', error);
    }
}

// Singleton instance
const eventBus = new EventBus();

module.exports = { eventBus, EventBus };