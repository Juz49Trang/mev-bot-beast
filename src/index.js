require('dotenv').config();
const { MEVBot } = require('./core/Bot');
const { logger } = require('./utils/logger');
const config = require('config');

// Global error handlers
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown handler
let bot;

async function shutdown(signal) {
    logger.info(`Received ${signal}, starting graceful shutdown...`);
    
    try {
        if (bot) {
            await bot.stop();
        }
        
        logger.info('Graceful shutdown completed');
        process.exit(0);
        
    } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Main function
async function main() {
    try {
        logger.info('🚀 MEV Bot Beast Starting...');
        logger.info('Environment:', process.env.NODE_ENV || 'development');
        logger.info('Version:', config.get('bot.version'));
        
        // Validate configuration
        validateConfig();
        
        // Initialize bot
        bot = new MEVBot(config);
        
        // Start bot
        await bot.start();
        
        logger.info('✅ MEV Bot Beast is running!');
        
        // Keep process alive
        setInterval(() => {
            // Health check
            const stats = bot.getStats();
            logger.debug('Bot health check', stats);
        }, 60000); // Every minute
        
    } catch (error) {
        logger.error('Failed to start bot:', error);
        process.exit(1);
    }
}

function validateConfig() {
    // Check required environment variables
    const required = [
        'MAIN_WALLET_PRIVATE_KEY',
        'DB_HOST',
        'DB_USER',
        'DB_PASSWORD'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    // Validate wallet private key format
    const privateKey = process.env.MAIN_WALLET_PRIVATE_KEY;
    if (!privateKey.match(/^0x[a-fA-F0-9]{64}$/)) {
        throw new Error('Invalid private key format');
    }
    
    logger.info('Configuration validated successfully');
}

// Start the bot
main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});