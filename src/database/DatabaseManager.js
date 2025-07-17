const { Pool } = require('pg');
const { logger } = require('../utils/logger');

class DatabaseManager {
    constructor(config) {
        this.config = config;
        this.pool = null;
    }
    
    async initialize() {
        try {
            this.pool = new Pool({
                host: this.config.host,
                port: this.config.port,
                database: this.config.database,
                user: this.config.user,
                password: this.config.password,
                max: this.config.pool?.max || 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });
            
            // Test connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();
            
            // Create tables if not exist
            await this.createTables();
            
            logger.info('Database connected successfully');
        } catch (error) {
            logger.error('Database connection failed:', error);
            throw error;
        }
    }
    
    async createTables() {
        const queries = [
            // Opportunities table
            `CREATE TABLE IF NOT EXISTS opportunities (
                id SERIAL PRIMARY KEY,
                strategy VARCHAR(50) NOT NULL,
                type VARCHAR(50) NOT NULL,
                data JSONB NOT NULL,
                expected_profit NUMERIC(20, 8),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // Trades table
            `CREATE TABLE IF NOT EXISTS trades (
                id SERIAL PRIMARY KEY,
                opportunity_id INTEGER REFERENCES opportunities(id),
                strategy VARCHAR(50) NOT NULL,
                type VARCHAR(50) NOT NULL,
                tx_hash VARCHAR(66) UNIQUE,
                block_number INTEGER,
                gas_used NUMERIC(20, 0),
                gas_price NUMERIC(20, 0),
                profit NUMERIC(20, 8),
                status VARCHAR(20),
                error TEXT,
                data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                executed_at TIMESTAMP
            )`,
            
            // Performance snapshots
            `CREATE TABLE IF NOT EXISTS performance_snapshots (
                id SERIAL PRIMARY KEY,
                total_profit NUMERIC(20, 8),
                successful_trades INTEGER,
                failed_trades INTEGER,
                success_rate NUMERIC(5, 2),
                opportunities_analyzed INTEGER,
                profit_per_hour NUMERIC(20, 8),
                data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // Risk events
            `CREATE TABLE IF NOT EXISTS risk_events (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50),
                severity VARCHAR(20),
                description TEXT,
                data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // Create indexes
            `CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy)`,
            `CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`,
            `CREATE INDEX IF NOT EXISTS idx_opportunities_created_at ON opportunities(created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_opportunities_strategy ON opportunities(strategy)`
        ];
        
        for (const query of queries) {
            await this.pool.query(query);
        }
        
        logger.info('Database tables created/verified');
    }
    
    async recordOpportunity(opportunity) {
        const query = `
            INSERT INTO opportunities (strategy, type, data, expected_profit)
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        
        const values = [
            opportunity.strategy,
            opportunity.type,
            JSON.stringify(opportunity),
            opportunity.expectedProfit?.toString() || '0'
        ];
        
        const result = await this.pool.query(query, values);
        return result.rows[0].id;
    }
    
    async recordSuccessfulTrade(trade) {
        const query = `
            INSERT INTO trades (
                opportunity_id, strategy, type, tx_hash, block_number,
                gas_used, gas_price, profit, status, data, executed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
            RETURNING id
        `;
        
        const values = [
            trade.opportunityId || null,
            trade.strategy,
            trade.type,
            trade.txHash,
            trade.blockNumber,
            trade.gasUsed,
            trade.gasPrice?.toString() || '0',
            trade.profit?.toString() || '0',
            'success',
            JSON.stringify(trade)
        ];
        
        const result = await this.pool.query(query, values);
        return result.rows[0].id;
    }
    
    async recordFailedTrade(trade) {
        const query = `
            INSERT INTO trades (
                opportunity_id, strategy, type, tx_hash, status, error, data
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `;
        
        const values = [
            trade.opportunityId || null,
            trade.strategy,
            trade.type,
            trade.txHash || null,
            'failed',
            trade.error || trade.reason,
            JSON.stringify(trade)
        ];
        
        const result = await this.pool.query(query, values);
        return result.rows[0].id;
    }
    
    async recordRejectedOpportunity(opportunity, reason) {
        const query = `
            UPDATE opportunities 
            SET status = 'rejected', data = data || jsonb_build_object('rejectionReason', $2)
            WHERE id = $1
        `;
        
        await this.pool.query(query, [opportunity.id, reason]);
    }
    
    async savePerformanceSnapshot(snapshot) {
        const query = `
            INSERT INTO performance_snapshots (
                total_profit, successful_trades, failed_trades,
                success_rate, opportunities_analyzed, profit_per_hour, data
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        
        const values = [
            snapshot.totalProfit,
            snapshot.successfulTrades,
            snapshot.failedTrades,
            snapshot.successRate,
            snapshot.opportunitiesAnalyzed,
            snapshot.profitPerHour,
            JSON.stringify(snapshot)
        ];
        
        await this.pool.query(query, values);
    }
    
    async recordRiskEvent(type, severity, description, data = {}) {
        const query = `
            INSERT INTO risk_events (type, severity, description, data)
            VALUES ($1, $2, $3, $4)
        `;
        
        await this.pool.query(query, [type, severity, description, JSON.stringify(data)]);
    }
    
    async getTradingStats(hours = 24) {
        const query = `
            SELECT 
                COUNT(*) as total_trades,
                COUNT(*) FILTER (WHERE status = 'success') as successful_trades,
                COUNT(*) FILTER (WHERE status = 'failed') as failed_trades,
                SUM(profit) FILTER (WHERE status = 'success') as total_profit,
                AVG(gas_used) as avg_gas_used,
                AVG(profit) FILTER (WHERE status = 'success' AND profit > 0) as avg_profit
            FROM trades
            WHERE created_at > NOW() - INTERVAL '${hours} hours'
        `;
        
        const result = await this.pool.query(query);
        return result.rows[0];
    }
    
    async getTopStrategies(limit = 5) {
        const query = `
            SELECT 
                strategy,
                COUNT(*) as trades,
                SUM(profit) as total_profit,
                AVG(profit) as avg_profit,
                COUNT(*) FILTER (WHERE status = 'success') as successful_trades
            FROM trades
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY strategy
            ORDER BY total_profit DESC
            LIMIT $1
        `;
        
        const result = await this.pool.query(query, [limit]);
        return result.rows;
    }
    
    async getRecentTrades(limit = 100) {
        const query = `
            SELECT * FROM trades
            ORDER BY created_at DESC
            LIMIT $1
        `;
        
        const result = await this.pool.query(query, [limit]);
        return result.rows;
    }
    
    async close() {
        if (this.pool) {
            await this.pool.end();
            logger.info('Database connection closed');
        }
    }
}

module.exports = { DatabaseManager };