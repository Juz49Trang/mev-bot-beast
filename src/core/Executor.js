const { ethers } = require('ethers');
const { logger } = require('../utils/logger');
const { FlashbotsProvider } = require('../infrastructure/FlashbotsProvider');
const { simulateTransaction } = require('../utils/helpers');

class Executor {
    constructor(bot) {
        this.bot = bot;
        this.flashbotsProvider = new FlashbotsProvider(bot.config.flashbots);
        this.pendingTxs = new Map();
        this.nonces = new Map();
        
        // Transaction queue for ordering
        this.txQueue = [];
        this.isProcessing = false;
        
        // Execution statistics
        this.stats = {
            submitted: 0,
            confirmed: 0,
            failed: 0,
            reverted: 0
        };
    }
    
    async execute(opportunity, riskAssessment) {
        const startTime = Date.now();
        
        try {
            // Get optimal wallet for this transaction
            const wallet = this.selectWallet(opportunity, riskAssessment);
            
            // Build transaction
            const tx = await this.buildTransaction(opportunity, wallet, riskAssessment);
            
            // Simulate transaction
            const simulation = await this.simulate(tx, wallet);
            
            if (!simulation.success) {
                return {
                    success: false,
                    reason: 'Simulation failed',
                    error: simulation.error,
                    simulationResult: simulation
                };
            }
            
            // Check profitability after simulation
            const actualProfit = simulation.profit;
            const minProfit = ethers.utils.parseEther(
                this.bot.config.strategies[opportunity.strategy].minProfitETH || '0.001'
            );
            
            if (actualProfit.lt(minProfit)) {
                return {
                    success: false,
                    reason: 'Profit below minimum threshold',
                    simulatedProfit: actualProfit,
                    minProfit: minProfit
                };
            }
            
            // Execute based on opportunity type
            let result;
            
            if (opportunity.type === 'sandwich') {
                result = await this.executeSandwich(opportunity, wallet, simulation);
            } else if (opportunity.type === 'flashloan') {
                result = await this.executeFlashLoan(opportunity, wallet, simulation);
            } else if (opportunity.requiresBundle) {
                result = await this.executeBundle(opportunity, wallet, simulation);
            } else {
                result = await this.executeStandard(tx, wallet, opportunity);
            }
            
            // Record execution time
            result.executionTime = Date.now() - startTime;
            
            return result;
            
        } catch (error) {
            logger.error('Execution error', error);
            
            return {
                success: false,
                reason: 'Execution error',
                error: error.message,
                executionTime: Date.now() - startTime
            };
        }
    }
    
    selectWallet(opportunity, riskAssessment) {
        // Use burner wallets for high-risk operations
        if (riskAssessment.score > 7 || opportunity.type === 'sandwich') {
            const burners = this.bot.wallets.filter(w => w.type === 'burner');
            if (burners.length > 0) {
                // Rotate through burner wallets
                const index = this.stats.submitted % burners.length;
                return burners[index].wallet;
            }
        }
        
        // Use main wallet for low-risk operations
        return this.bot.getWallet('main');
    }
    
    async buildTransaction(opportunity, wallet, riskAssessment) {
        const gasPrice = await this.bot.getGasPrice();
        const nonce = await this.getNonce(wallet.address);
        
        // Base transaction
        const tx = {
            from: wallet.address,
            nonce: nonce,
            gasPrice: gasPrice,
            gasLimit: opportunity.estimatedGas || ethers.BigNumber.from(500000),
            value: opportunity.value || ethers.BigNumber.from(0)
        };
        
        // Add opportunity-specific data
        switch (opportunity.type) {
            case 'arbitrage':
                tx.to = opportunity.contract;
                tx.data = opportunity.calldata;
                break;
                
            case 'liquidation':
                tx.to = opportunity.lendingProtocol;
                tx.data = this.encodeLiquidation(opportunity);
                break;
                
            case 'sandwich':
                // Sandwich requires special handling
                return this.buildSandwichTxs(opportunity, wallet, gasPrice, nonce);
                
            default:
                tx.to = opportunity.to;
                tx.data = opportunity.data;
        }
        
        // Adjust gas based on priority
        if (opportunity.priority === 'high') {
            tx.gasPrice = gasPrice.mul(110).div(100); // 10% premium
        }
        
        return tx;
    }
    
    async simulate(tx, wallet) {
        try {
            // Use Tenderly or local fork for simulation
            const result = await simulateTransaction(
                tx,
                wallet,
                this.bot.getProvider()
            );
            
            return {
                success: result.success,
                profit: result.profit || ethers.BigNumber.from(0),
                gasUsed: result.gasUsed,
                revertReason: result.revertReason,
                error: result.error
            };
            
        } catch (error) {
            logger.error('Simulation error', error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async executeStandard(tx, wallet, opportunity) {
        try {
            this.stats.submitted++;
            
            // Sign transaction
            const signedTx = await wallet.signTransaction(tx);
            
            // Submit transaction
            const txResponse = await this.bot.getProvider().sendTransaction(signedTx);
            
            logger.info('Transaction submitted', {
                hash: txResponse.hash,
                nonce: tx.nonce,
                gasPrice: ethers.utils.formatUnits(tx.gasPrice, 'gwei')
            });
            
            // Add to pending
            this.pendingTxs.set(txResponse.hash, {
                opportunity,
                timestamp: Date.now()
            });
            
            // Wait for confirmation
            const receipt = await this.waitForConfirmation(txResponse, opportunity);
            
            if (receipt.status === 1) {
                this.stats.confirmed++;
                
                // Calculate actual profit
                const profit = await this.calculateActualProfit(receipt, opportunity);
                
                return {
                    success: true,
                    txHash: receipt.transactionHash,
                    blockNumber: receipt.blockNumber,
                    gasUsed: receipt.gasUsed.toString(),
                    profit: profit,
                    receipt: receipt
                };
                
            } else {
                this.stats.reverted++;
                
                return {
                    success: false,
                    reason: 'Transaction reverted',
                    txHash: receipt.transactionHash,
                    receipt: receipt
                };
            }
            
        } catch (error) {
            this.stats.failed++;
            throw error;
        } finally {
            // Clean up pending
            if (tx.hash) {
                this.pendingTxs.delete(tx.hash);
            }
        }
    }
    
    async executeBundle(opportunity, wallet, simulation) {
        try {
            // Build bundle transactions
            const bundle = await this.buildBundle(opportunity, wallet);
            
            // Submit to Flashbots
            const result = await this.flashbotsProvider.sendBundle(bundle, wallet);
            
            if (result.success) {
                this.stats.confirmed++;
                
                return {
                    success: true,
                    bundleHash: result.bundleHash,
                    blockNumber: result.blockNumber,
                    profit: result.profit,
                    txHashes: result.txHashes
                };
            } else {
                return {
                    success: false,
                    reason: 'Bundle not included',
                    bundleHash: result.bundleHash
                };
            }
            
        } catch (error) {
            logger.error('Bundle execution error', error);
            throw error;
        }
    }
    
    async executeSandwich(opportunity, wallet, simulation) {
        const { victimTx, frontrunTx, backrunTx } = opportunity;
        
        try {
            // Build sandwich bundle
            const bundle = [
                await this.buildAndSignTx(frontrunTx, wallet),
                victimTx.rawTransaction, // Include victim tx
                await this.buildAndSignTx(backrunTx, wallet)
            ];
            
            // Submit to Flashbots
            const targetBlock = await this.bot.getProvider().getBlockNumber() + 1;
            
            const result = await this.flashbotsProvider.sendBundle(
                bundle,
                targetBlock,
                {
                    minTimestamp: Math.floor(Date.now() / 1000),
                    maxTimestamp: Math.floor(Date.now() / 1000) + 60
                }
            );
            
            if (result.success) {
                return {
                    success: true,
                    type: 'sandwich',
                    bundleHash: result.bundleHash,
                    profit: result.profit,
                    frontrunTx: result.txHashes[0],
                    backrunTx: result.txHashes[2]
                };
            } else {
                return {
                    success: false,
                    reason: 'Sandwich bundle failed',
                    error: result.error
                };
            }
            
        } catch (error) {
            logger.error('Sandwich execution error', error);
            throw error;
        }
    }
    
    async executeFlashLoan(opportunity, wallet, simulation) {
        // Flash loan execution requires calling the smart contract
        const flashLoanContract = new ethers.Contract(
            this.bot.config.contracts.flashLoanExecutor,
            ['function executeFlashLoan(address asset, uint256 amount, bytes calldata params)'],
            wallet
        );
        
        try {
            const tx = await flashLoanContract.executeFlashLoan(
                opportunity.asset,
                opportunity.amount,
                opportunity.params,
                {
                    gasPrice: await this.bot.getGasPrice(),
                    gasLimit: opportunity.gasLimit || 2000000
                }
            );
            
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                const profit = await this.calculateFlashLoanProfit(receipt, opportunity);
                
                return {
                    success: true,
                    type: 'flashloan',
                    txHash: receipt.transactionHash,
                    profit: profit,
                    gasUsed: receipt.gasUsed.toString()
                };
            } else {
                return {
                    success: false,
                    reason: 'Flash loan reverted',
                    txHash: receipt.transactionHash
                };
            }
            
        } catch (error) {
            logger.error('Flash loan execution error', error);
            throw error;
        }
    }
    
    async waitForConfirmation(txResponse, opportunity, maxWaitTime = 30000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            try {
                const receipt = await txResponse.wait(1);
                return receipt;
            } catch (error) {
                if (error.code === 'TRANSACTION_REPLACED') {
                    // Handle replaced transaction
                    if (error.replacement) {
                        logger.info('Transaction replaced', {
                            oldHash: txResponse.hash,
                            newHash: error.replacement.hash
                        });
                        return error.replacement.wait(1);
                    }
                }
                
                // Check if still pending
                const tx = await this.bot.getProvider().getTransaction(txResponse.hash);
                if (!tx) {
                    throw new Error('Transaction not found');
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        throw new Error('Transaction confirmation timeout');
    }
    
    async calculateActualProfit(receipt, opportunity) {
        // Calculate profit based on token transfers in logs
        const profitCalculator = this.bot.strategies.get(opportunity.strategy);
        
        if (profitCalculator && profitCalculator.calculateProfit) {
            return profitCalculator.calculateProfit(receipt, opportunity);
        }
        
        // Default: return expected profit minus gas
        const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);
        return opportunity.expectedProfit.sub(gasCost);
    }
    
    async calculateFlashLoanProfit(receipt, opportunity) {
        // Parse flash loan events to calculate actual profit
        const iface = new ethers.utils.Interface([
            'event FlashLoanExecuted(address asset, uint256 amount, uint256 premium, uint256 profit)'
        ]);
        
        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed.name === 'FlashLoanExecuted') {
                    return parsed.args.profit;
                }
            } catch (e) {
                // Not our event
            }
        }
        
        // Fallback to gas calculation
        const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);
        return opportunity.expectedProfit.sub(gasCost);
    }
    
    buildSandwichTxs(opportunity, wallet, gasPrice, nonce) {
        // Build frontrun and backrun transactions
        return {
            frontrun: {
                ...opportunity.frontrun,
                nonce: nonce,
                gasPrice: gasPrice.mul(105).div(100), // 5% higher
                from: wallet.address
            },
            backrun: {
                ...opportunity.backrun,
                nonce: nonce + 1,
                gasPrice: gasPrice.mul(95).div(100), // 5% lower
                from: wallet.address
            }
        };
    }
    
    async buildAndSignTx(tx, wallet) {
        const signedTx = await wallet.signTransaction(tx);
        return signedTx;
    }
    
    async buildBundle(opportunity, wallet) {
        const bundle = [];
        const nonce = await this.getNonce(wallet.address);
        
        for (let i = 0; i < opportunity.transactions.length; i++) {
            const tx = {
                ...opportunity.transactions[i],
                nonce: nonce + i,
                from: wallet.address,
                gasPrice: await this.bot.getGasPrice()
            };
            
            const signedTx = await wallet.signTransaction(tx);
            bundle.push(signedTx);
        }
        
        return bundle;
    }
    
    encodeLiquidation(opportunity) {
        const iface = new ethers.utils.Interface([
            'function liquidatePosition(address user, address asset, uint256 amount)'
        ]);
        
        return iface.encodeFunctionData('liquidatePosition', [
            opportunity.user,
            opportunity.asset,
            opportunity.amount
        ]);
    }
    
    async getNonce(address) {
        // Track nonces locally for speed
        const currentNonce = this.nonces.get(address) || 
            await this.bot.getProvider().getTransactionCount(address, 'pending');
        
        this.nonces.set(address, currentNonce + 1);
        return currentNonce;
    }
    
    resetNonce(address) {
        this.nonces.delete(address);
    }
}

module.exports = { Executor };