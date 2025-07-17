const EventEmitter = require('events');
const { logger } = require('../utils/logger');

class CircuitBreaker extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        
        // Circuit breaker states
        this.states = {
            CLOSED: 'closed',    // Normal operation
            OPEN: 'open',        // Blocking all operations
            HALF_OPEN: 'half-open' // Testing if system recovered
        };
        
        this.state = this.states.CLOSED;
        this.failures = 0;
        this.consecutiveFailures = 0;
        this.lastFailureTime = null;
        this.hourlyFailures = [];
        
        // Strategy-specific failures
        this.strategyFailures = new Map();
        
        // Configuration
        this.maxFailuresPerHour = config.maxFailuresPerHour || 10;
        this.maxConsecutiveFailures = config.maxConsecutiveFailures || 5;
        this.cooldownMinutes = config.cooldownMinutes || 30;
        this.strategyDisableThreshold = config.strategyDisableThreshold || 20;
        
        // Start monitoring
        this.startMonitoring();
        
        logger.info('Circuit breaker initialized', {
            maxFailuresPerHour: this.maxFailuresPerHour,
            maxConsecutiveFailures: this.maxConsecutiveFailures
        });
    }
    
    enable() {
        this.state = this.states.CLOSED;
        logger.info('Circuit breaker enabled');
    }
    
    disable() {
        this.state = this.states.OPEN;
        logger.info('Circuit breaker disabled');
    }
    
    isTripped() {
        return this.state === this.states.OPEN;
    }
    
    recordFailure(strategy = null) {
        this.failures++;
        this.consecutiveFailures++;
        this.lastFailureTime = Date.now();
        
        // Record hourly failure
        this.hourlyFailures.push({
            timestamp: Date.now(),
            strategy
        });
        
        // Record strategy-specific failure
        if (strategy) {
            const count = this.strategyFailures.get(strategy) || 0;
            this.strategyFailures.set(strategy, count + 1);
        }
        
        // Check if circuit should trip
        this.evaluateCircuit();
        
        logger.warn('Failure recorded', {
            totalFailures: this.failures,
            consecutiveFailures: this.consecutiveFailures,
            strategy
        });
    }
    
    recordSuccess() {
        this.consecutiveFailures = 0;
        
        // If in half-open state, close the circuit
        if (this.state === this.states.HALF_OPEN) {
            this.close();
        }
    }
    
    evaluateCircuit() {
        // Remove old hourly failures
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        this.hourlyFailures = this.hourlyFailures.filter(f => f.timestamp > oneHourAgo);
        
        // Check consecutive failures
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            this.trip('Max consecutive failures reached');
            return;
        }
        
        // Check hourly failures
        if (this.hourlyFailures.length >= this.maxFailuresPerHour) {
            this.trip('Max hourly failures reached');
            return;
        }
    }
    
    trip(reason) {
        if (this.state === this.states.OPEN) {
            return; // Already tripped
        }
        
        this.state = this.states.OPEN;
        this.emit('tripped', { reason, timestamp: Date.now() });
        
        logger.error('Circuit breaker tripped!', {
            reason,
            failures: this.failures,
            consecutiveFailures: this.consecutiveFailures,
            hourlyFailures: this.hourlyFailures.length
        });
        
        // Schedule recovery attempt
        setTimeout(() => {
            this.attemptRecovery();
        }, this.cooldownMinutes * 60 * 1000);
    }
    
    attemptRecovery() {
        if (this.state !== this.states.OPEN) {
            return;
        }
        
        logger.info('Attempting circuit breaker recovery...');
        
        this.state = this.states.HALF_OPEN;
        this.emit('recovery-attempt', { timestamp: Date.now() });
    }
    
    close() {
        this.state = this.states.CLOSED;
        this.consecutiveFailures = 0;
        
        logger.info('Circuit breaker closed (normal operation resumed)');
        this.emit('closed', { timestamp: Date.now() });
    }
    
    shouldDisableStrategy(strategy) {
        const failures = this.strategyFailures.get(strategy) || 0;
        return failures >= this.strategyDisableThreshold;
    }
    
    getStrategyHealth(strategy) {
        const failures = this.strategyFailures.get(strategy) || 0;
        const health = Math.max(0, 100 - (failures / this.strategyDisableThreshold * 100));
        
        return {
            strategy,
            failures,
            health: health.toFixed(2) + '%',
            status: health > 80 ? 'healthy' : health > 50 ? 'degraded' : 'critical'
        };
    }
    
    startMonitoring() {
        // Reset strategy failures daily
        setInterval(() => {
            this.strategyFailures.clear();
            logger.info('Daily strategy failure counts reset');
        }, 24 * 60 * 60 * 1000);
        
        // Log status every 5 minutes
        setInterval(() => {
            this.logStatus();
        }, 5 * 60 * 1000);
    }
    
    logStatus() {
        const status = {
            state: this.state,
            totalFailures: this.failures,
            consecutiveFailures: this.consecutiveFailures,
            hourlyFailures: this.hourlyFailures.length,
            strategyHealth: Array.from(this.strategyFailures.keys()).map(s => 
                this.getStrategyHealth(s)
            )
        };
        
        logger.info('Circuit breaker status', status);
    }
    
    getStatus() {
        return {
            state: this.state,
            isTripped: this.isTripped(),
            failures: {
                total: this.failures,
                consecutive: this.consecutiveFailures,
                hourly: this.hourlyFailures.length
            },
            lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
            strategies: Array.from(this.strategyFailures.entries()).map(([strategy, failures]) => ({
                strategy,
                failures,
                health: this.getStrategyHealth(strategy)
            }))
        };
    }
    
    reset() {
        this.state = this.states.CLOSED;
        this.failures = 0;
        this.consecutiveFailures = 0;
        this.hourlyFailures = [];
        this.strategyFailures.clear();
        
        logger.info('Circuit breaker reset');
        this.emit('reset', { timestamp: Date.now() });
    }
}

module.exports = { CircuitBreaker };