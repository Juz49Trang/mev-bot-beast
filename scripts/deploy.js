const hre = require("hardhat");
const { ethers } = require("hardhat");

async function main() {
    console.log("Starting deployment...");
    
    // Get deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", (await deployer.getBalance()).toString());
    
    // Get network info
    const network = await ethers.provider.getNetwork();
    console.log("Network:", network.name, "ChainId:", network.chainId);
    
    // Deploy MEVBot contract
    console.log("\nDeploying MEVBot contract...");
    const MEVBot = await ethers.getContractFactory("MEVBot");
    
    // WETH addresses by chain
    const WETH_ADDRESSES = {
        8453: "0x4200000000000000000000000000000000000006", // Base
        42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // Arbitrum
        10: "0x4200000000000000000000000000000000000006", // Optimism
        31337: "0x4200000000000000000000000000000000000006" // Hardhat
    };
    
    const wethAddress = WETH_ADDRESSES[network.chainId] || WETH_ADDRESSES[31337];
    console.log("Using WETH address:", wethAddress);
    
    const mevBot = await MEVBot.deploy(wethAddress);
    await mevBot.deployed();
    console.log("MEVBot deployed to:", mevBot.address);
    
    // Deploy FlashLoanReceiver contract
    console.log("\nDeploying FlashLoanReceiver contract...");
    const FlashLoanReceiver = await ethers.getContractFactory("FlashLoanReceiver");
    
    // Flash loan provider addresses by chain
    const PROVIDERS = {
        8453: { // Base
            aave: "0x0000000000000000000000000000000000000000", // Update with actual address
            balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
        },
        42161: { // Arbitrum
            aave: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
            balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
        },
        10: { // Optimism
            aave: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
            balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
        },
        31337: { // Hardhat
            aave: "0x0000000000000000000000000000000000000000",
            balancer: "0x0000000000000000000000000000000000000000"
        }
    };
    
    const providers = PROVIDERS[network.chainId] || PROVIDERS[31337];
    
    const flashLoanReceiver = await FlashLoanReceiver.deploy(
        providers.aave,
        providers.balancer,
        wethAddress
    );
    await flashLoanReceiver.deployed();
    console.log("FlashLoanReceiver deployed to:", flashLoanReceiver.address);
    
    // Set up permissions
    console.log("\nSetting up permissions...");
    
    // Authorize FlashLoanReceiver on MEVBot
    await mevBot.setAuthorized(flashLoanReceiver.address, true);
    console.log("Authorized FlashLoanReceiver on MEVBot");
    
    // Approve tokens on MEVBot (example)
    const tokensToApprove = [
        { symbol: "WETH", address: wethAddress },
        // Add more tokens as needed
    ];
    
    const routers = [
        "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3 on Base
        // Add more routers as needed
    ];
    
    console.log("\nApproving tokens for routers...");
    for (const token of tokensToApprove) {
        for (const router of routers) {
            try {
                await mevBot.approveRouter(
                    token.address,
                    router,
                    ethers.constants.MaxUint256
                );
                console.log(`Approved ${token.symbol} for router ${router}`);
            } catch (error) {
                console.log(`Failed to approve ${token.symbol} for ${router}:`, error.message);
            }
        }
    }
    
    // Save deployment info
    const deployment = {
        network: network.name,
        chainId: network.chainId,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            MEVBot: mevBot.address,
            FlashLoanReceiver: flashLoanReceiver.address
        },
        configurations: {
            WETH: wethAddress,
            aaveProvider: providers.aave,
            balancerVault: providers.balancer
        }
    };
    
    console.log("\n========== Deployment Summary ==========");
    console.log(JSON.stringify(deployment, null, 2));
    console.log("=======================================");
    
    // Write deployment info to file
    const fs = require('fs');
    const deploymentPath = `./deployments/${network.chainId}-${Date.now()}.json`;
    
    // Create deployments directory if it doesn't exist
    if (!fs.existsSync('./deployments')) {
        fs.mkdirSync('./deployments');
    }
    
    fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
    console.log(`\nDeployment info saved to: ${deploymentPath}`);
    
    // Verify contracts if not on local network
    if (network.chainId !== 31337 && process.env.VERIFY_CONTRACTS === 'true') {
        console.log("\nVerifying contracts...");
        
        try {
            await hre.run("verify:verify", {
                address: mevBot.address,
                constructorArguments: [wethAddress],
            });
            console.log("MEVBot verified");
        } catch (error) {
            console.log("MEVBot verification failed:", error.message);
        }
        
        try {
            await hre.run("verify:verify", {
                address: flashLoanReceiver.address,
                constructorArguments: [providers.aave, providers.balancer, wethAddress],
            });
            console.log("FlashLoanReceiver verified");
        } catch (error) {
            console.log("FlashLoanReceiver verification failed:", error.message);
        }
    }
    
    console.log("\nDeployment completed!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });