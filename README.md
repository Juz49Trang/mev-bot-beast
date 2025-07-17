# MEV Bot Beast 🚀

A production-ready MEV (Maximum Extractable Value) bot with multiple strategies for DeFi arbitrage, liquidations, and more.

## Features

### Core Strategies
- **Arbitrage**: Multi-DEX and triangular arbitrage opportunities
- **Flash Loan Arbitrage**: Capital-efficient arbitrage using Aave and Balancer
- **Liquidations**: Monitor and execute liquidations on lending protocols
- **Sandwich Attacks**: Detect and execute profitable sandwich opportunities (disabled by default)

### Infrastructure
- **Multi-Provider Support**: Redundant RPC providers with automatic failover
- **Risk Management**: Comprehensive risk assessment and position sizing
- **Real-time Monitoring**: Grafana dashboards and Prometheus metrics
- **Database Storage**: PostgreSQL with TimescaleDB for time-series data
- **High Performance**: Optimized for low-latency execution

### Supported Chains
- Base (default)
- Arbitrum One
- Optimism

### Supported DEXs
- Uniswap V3
- SushiSwap
- Curve Finance
- Balancer

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 7+
- Docker & Docker Compose (optional)
- At least 0.1 ETH for gas fees

## Installation

### 1. Clone the repository
```bash
git clone https://github.com/yourusername/mev-bot-beast.git
cd mev-bot-beast
```

### 2. Install dependencies
```bash
npm install
```

### 3. Deploy smart contracts
```bash
npx hardhat compile
npx hardhat run scripts/deploy.js --network base
```

### 4. Configure environment
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 5. Set up database
```bash
# Using Docker
docker-compose up -d postgres redis

# Or manually
psql -U postgres -c "CREATE DATABASE mev_bot;"
psql -U postgres -d mev_bot -f scripts/schema.sql
```

## Configuration

### Essential Settings

1. **Wallet Configuration**
   - `MAIN_WALLET_PRIVATE_KEY`: Your main bot wallet
   - `BURNER_WALLET_*`: Optional burner wallets for high-risk operations

2. **RPC Providers**
   - `ALCHEMY_API_KEY`: Alchemy API key for WebSocket connection
   - Add multiple providers for redundancy

3. **Risk Parameters**
   - `MAX_POSITION_ETH`: Maximum position size per trade
   - `MAX_DAILY_LOSS_ETH`: Daily loss limit
   - `MIN_PROFIT_USD`: Minimum profit threshold

### Strategy Configuration

Edit `config/default.json` to enable/disable strategies and adjust parameters:

```json
{
  "strategies": {
    "arbitrage": {
      "enabled": true,
      "minProfitETH": "0.001",
      "scanInterval": 1000
    },
    "flashloan": {
      "enabled": true,
      "minProfitETH": "0.01"
    }
  }
}
```

## Running the Bot

### Development Mode
```bash
npm run start:dev
```

### Production Mode

#### Using Docker Compose (Recommended)
```bash
docker-compose up -d
```

#### Manual Start
```bash
npm start
```

### Dashboard
Access the monitoring dashboard at http://localhost:3000

Default credentials:
- Username: admin
- Password: (set in .env)

## Monitoring

### Grafana Dashboards
Access at http://localhost:3001

Pre-configured dashboards:
- Bot Performance
- Trade Analytics
- System Health
- Risk Metrics

### Prometheus Metrics
Available at http://localhost:9090/metrics

Key metrics:
- `mev_bot_trades_total`: Total trades executed
- `mev_bot_profit_total`: Total profit in ETH
- `mev_bot_opportunities_found`: Opportunities detected
- `mev_bot_gas_price`: Current gas price

## Development

### Running Tests
```bash
npm test
npm run test:coverage
```

### Backtesting
```bash
npm run backtest -- --from 2024-01-01 --to 2024-01-31
```

### Simulation Mode
```bash
npm run simulate
```

## Architecture

```
mev-bot-beast/
├── src/
│   ├── core/           # Core bot logic
│   ├── strategies/     # Trading strategies
│   ├── dex/           # DEX integrations
│   ├── risk/          # Risk management
│   └── monitoring/    # Metrics and alerts
├── contracts/         # Smart contracts
├── dashboard/         # Web dashboard
└── docker/           # Docker configuration
```

## Safety & Security

- Never share your private keys
- Use burner wallets for testing
- Start with small position sizes
- Monitor the bot closely during initial runs
- Implement proper access controls
- Regular security audits recommended

## Performance Optimization

1. **RPC Optimization**
   - Use WebSocket connections
   - Multiple provider redundancy
   - Local node recommended for production

2. **Gas Optimization**
   - Dynamic gas pricing
   - Transaction batching
   - Priority fee management

3. **Execution Speed**
   - Mempool monitoring
   - Direct contract calls
   - Optimized routing algorithms

## Troubleshooting

### Common Issues

1. **"Insufficient funds" error**
   - Ensure wallet has enough ETH for gas
   - Check minimum balance configuration

2. **"No opportunities found"**
   - Verify RPC connection
   - Check strategy configuration
   - Ensure sufficient liquidity on DEXs

3. **High failure rate**
   - Adjust slippage tolerance
   - Increase gas price limits
   - Check for network congestion

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - see LICENSE file

## Disclaimer

This software is for educational purposes only. Use at your own risk. The authors are not responsible for any financial losses incurred through the use of this software. Always test thoroughly on testnets before mainnet deployment.

## Support

- Documentation: [docs/](./docs)
- Issues: GitHub Issues
- Discord: [Join our server](#)

---

Built with ❤️ by the MEV Bot Beast team