const { ethers } = require('ethers');

// Chain IDs
const CHAIN_IDS = {
    BASE: 8453,
    ARBITRUM: 42161,
    OPTIMISM: 10,
    ETHEREUM: 1,
    POLYGON: 137
};

// Token Addresses by Chain
const TOKENS = {
    [CHAIN_IDS.BASE]: {
        WETH: '0x4200000000000000000000000000000000000006',
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        WBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095'
    },
    [CHAIN_IDS.ARBITRUM]: {
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'
    },
    [CHAIN_IDS.OPTIMISM]: {
        WETH: '0x4200000000000000000000000000000000000006',
        USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
        USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        WBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095'
    }
};

// DEX Router Addresses by Chain
const DEX_ROUTERS = {
    [CHAIN_IDS.BASE]: {
        UNISWAP_V3: '0x2626664c2603336E57B271c5C0b26F421741e481',
        SUSHISWAP: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
        AERODROME: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'
    },
    [CHAIN_IDS.ARBITRUM]: {
        UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        SUSHISWAP: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        CAMELOT: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d'
    },
    [CHAIN_IDS.OPTIMISM]: {
        UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        VELODROME: '0x9c12939390052919aF3155f41Bf4160Fd3666A6f'
    }
};

// Common Constants
const COMMON = {
    // Gas limits
    DEFAULT_GAS_LIMIT: ethers.BigNumber.from(500000),
    SWAP_GAS_LIMIT: ethers.BigNumber.from(300000),
    FLASHLOAN_GAS_LIMIT: ethers.BigNumber.from(1000000),
    
    // Slippage
    DEFAULT_SLIPPAGE_BPS: 50, // 0.5%
    HIGH_SLIPPAGE_BPS: 100, // 1%
    
    // Deadlines
    DEFAULT_DEADLINE_SECONDS: 300, // 5 minutes
    
    // Profit thresholds
    MIN_PROFIT_USD: 10,
    MIN_PROFIT_BPS: 10, // 0.1%
    
    // Risk parameters
    MAX_POSITION_SIZE: ethers.utils.parseEther('10'),
    MAX_GAS_PRICE: ethers.utils.parseUnits('100', 'gwei'),
    
    // Pool fees (Uniswap V3)
    POOL_FEES: [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
    
    // Transaction types
    TX_TYPES: {
        SWAP: 'swap',
        ARBITRAGE: 'arbitrage',
        LIQUIDATION: 'liquidation',
        FLASHLOAN: 'flashloan',
        SANDWICH: 'sandwich'
    }
};

// Error messages
const ERRORS = {
    INSUFFICIENT_BALANCE: 'Insufficient balance',
    SLIPPAGE_TOO_HIGH: 'Slippage tolerance exceeded',
    UNPROFITABLE: 'Transaction would be unprofitable',
    GAS_TOO_HIGH: 'Gas price too high',
    SIMULATION_FAILED: 'Transaction simulation failed',
    NO_ROUTE_FOUND: 'No profitable route found',
    POOL_NOT_FOUND: 'Liquidity pool not found',
    DEADLINE_EXCEEDED: 'Transaction deadline exceeded'
};

// Event names
const EVENTS = {
    // Bot events
    BOT_STARTED: 'bot:started',
    BOT_STOPPED: 'bot:stopped',
    BOT_ERROR: 'bot:error',
    
    // Trading events
    OPPORTUNITY_FOUND: 'opportunity:found',
    TRADE_EXECUTED: 'trade:executed',
    TRADE_FAILED: 'trade:failed',
    
    // Monitor events
    BLOCK_RECEIVED: 'block:received',
    TRANSACTION_DETECTED: 'transaction:detected',
    MEMPOOL_TRANSACTION: 'mempool:transaction',
    
    // Risk events
    RISK_LIMIT_REACHED: 'risk:limit_reached',
    CIRCUIT_BREAKER_TRIGGERED: 'risk:circuit_breaker'
};

// ABI snippets
const ABI = {
    ERC20: [
        'function balanceOf(address owner) view returns (uint256)',
        'function transfer(address to, uint256 amount) returns (bool)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)'
    ],
    WETH: [
        'function deposit() payable',
        'function withdraw(uint256 amount)',
        'function balanceOf(address owner) view returns (uint256)'
    ]
};

module.exports = {
    CHAIN_IDS,
    TOKENS,
    DEX_ROUTERS,
    COMMON,
    ERRORS,
    EVENTS,
    ABI
};