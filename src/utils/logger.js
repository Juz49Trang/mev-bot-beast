const winston = require('winston');
const path = require('path');

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
};

// Define colors for each level
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    verbose: 'cyan',
    debug: 'blue',
    silly: 'grey'
};

winston.addColors(colors);

// Create format
const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        
        if (metadata && Object.keys(metadata).length) {
            // Don't log error stack in the message
            const { stack, ...otherMetadata } = metadata;
            if (Object.keys(otherMetadata).length) {
                msg += ` ${JSON.stringify(otherMetadata)}`;
            }
            if (stack) {
                msg += `\n${stack}`;
            }
        }
        
        return msg;
    })
);

// Console format with colors
const consoleFormat = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        
        if (metadata && Object.keys(metadata).length) {
            const { stack, ...otherMetadata } = metadata;
            if (Object.keys(otherMetadata).length) {
                msg += ` ${JSON.stringify(otherMetadata, null, 2)}`;
            }
            if (stack) {
                msg += `\n${stack}`;
            }
        }
        
        return msg;
    })
);

// Create transports
const transports = [];

// Console transport
if (process.env.NODE_ENV !== 'test') {
    transports.push(
        new winston.transports.Console({
            format: consoleFormat,
            level: process.env.LOG_LEVEL || 'info'
        })
    );
}

// File transports
if (process.env.NODE_ENV === 'production') {
    // Error log
    transports.push(
        new winston.transports.File({
            filename: path.join('logs', 'error.log'),
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        })
    );
    
    // Combined log
    transports.push(
        new winston.transports.File({
            filename: path.join('logs', 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true
        })
    );
    
    // Trading specific log
    transports.push(
        new winston.transports.File({
            filename: path.join('logs', 'trades.log'),
            level: 'info',
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    );
}

// Create logger
const logger = winston.createLogger({
    levels,
    format,
    transports,
    exitOnError: false
});

// Create child loggers for specific modules
const createModuleLogger = (module) => {
    return logger.child({ module });
};

// Export logger utilities
module.exports = {
    logger,
    createModuleLogger,
    
    // Convenience methods
    error: (message, meta) => logger.error(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    info: (message, meta) => logger.info(message, meta),
    http: (message, meta) => logger.http(message, meta),
    verbose: (message, meta) => logger.verbose(message, meta),
    debug: (message, meta) => logger.debug(message, meta),
    
    // Trading specific loggers
    logTrade: (trade) => {
        logger.info('Trade executed', {
            type: 'trade',
            ...trade
        });
    },
    
    logOpportunity: (opportunity) => {
        logger.info('Opportunity found', {
            type: 'opportunity',
            ...opportunity
        });
    },
    
    logError: (error, context = {}) => {
        logger.error(error.message, {
            stack: error.stack,
            ...context
        });
    }
};