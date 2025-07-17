// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Aave V3 Flash Loan Interface
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

// Balancer Flash Loan Interface
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

contract FlashLoanReceiver is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Events
    event FlashLoanExecuted(
        address indexed provider,
        address indexed asset,
        uint256 amount,
        uint256 premium,
        uint256 profit
    );
    
    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 profit
    );
    
    // State variables
    IPoolAddressesProvider public immutable AAVE_ADDRESSES_PROVIDER;
    IBalancerVault public immutable BALANCER_VAULT;
    address public immutable WETH;
    
    mapping(address => bool) public authorized;
    
    // Flash loan providers
    enum FlashLoanProvider { AAVE, BALANCER }
    
    modifier onlyAuthorized() {
        require(authorized[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }
    
    constructor(
        address _aaveProvider,
        address _balancerVault,
        address _weth
    ) {
        AAVE_ADDRESSES_PROVIDER = IPoolAddressesProvider(_aaveProvider);
        BALANCER_VAULT = IBalancerVault(_balancerVault);
        WETH = _weth;
        authorized[msg.sender] = true;
    }
    
    // Authorization management
    function setAuthorized(address user, bool status) external onlyOwner {
        authorized[user] = status;
    }
    
    // Initiate flash loan arbitrage
    function executeFlashLoanArbitrage(
        FlashLoanProvider provider,
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyAuthorized nonReentrant {
        if (provider == FlashLoanProvider.AAVE) {
            _executeAaveFlashLoan(asset, amount, params);
        } else if (provider == FlashLoanProvider.BALANCER) {
            _executeBalancerFlashLoan(asset, amount, params);
        }
    }
    
    // Execute Aave flash loan
    function _executeAaveFlashLoan(
        address asset,
        uint256 amount,
        bytes memory params
    ) internal {
        address pool = IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER).getPool();
        IPool(pool).flashLoanSimple(address(this), asset, amount, params, 0);
    }
    
    // Execute Balancer flash loan
    function _executeBalancerFlashLoan(
        address asset,
        uint256 amount,
        bytes memory params
    ) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        
        BALANCER_VAULT.flashLoan(address(this), tokens, amounts, params);
    }
    
    // Aave flash loan callback
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(initiator == address(this), "Invalid initiator");
        require(
            msg.sender == IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER).getPool(),
            "Invalid caller"
        );
        
        // Decode arbitrage parameters
        (
            address sellDex,
            address buyDex,
            address tokenA,
            address tokenB,
            bytes memory sellData,
            bytes memory buyData
        ) = abi.decode(params, (address, address, address, address, bytes, bytes));
        
        // Execute arbitrage
        uint256 profit = _executeArbitrage(
            sellDex,
            buyDex,
            tokenA,
            tokenB,
            amount,
            sellData,
            buyData
        );
        
        // Repay flash loan
        uint256 totalDebt = amount + premium;
        IERC20(asset).approve(msg.sender, totalDebt);
        
        emit FlashLoanExecuted(msg.sender, asset, amount, premium, profit);
        
        return true;
    }
    
    // Balancer flash loan callback
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == address(BALANCER_VAULT), "Invalid caller");
        
        // Decode and execute arbitrage
        (
            address sellDex,
            address buyDex,
            address tokenA,
            address tokenB,
            bytes memory sellData,
            bytes memory buyData
        ) = abi.decode(userData, (address, address, address, address, bytes, bytes));
        
        uint256 profit = _executeArbitrage(
            sellDex,
            buyDex,
            tokenA,
            tokenB,
            amounts[0],
            sellData,
            buyData
        );
        
        // Repay flash loan (Balancer has no fees)
        IERC20(tokens[0]).transfer(msg.sender, amounts[0]);
        
        emit FlashLoanExecuted(msg.sender, tokens[0], amounts[0], 0, profit);
    }
    
    // Execute the arbitrage logic
    function _executeArbitrage(
        address sellDex,
        address buyDex,
        address tokenA,
        address tokenB,
        uint256 amount,
        bytes memory sellData,
        bytes memory buyData
    ) internal returns (uint256) {
        // Approve DEXs
        IERC20(tokenA).approve(sellDex, amount);
        
        // Execute first swap (sell tokenA for tokenB)
        (bool success1,) = sellDex.call(sellData);
        require(success1, "First swap failed");
        
        uint256 tokenBBalance = IERC20(tokenB).balanceOf(address(this));
        IERC20(tokenB).approve(buyDex, tokenBBalance);
        
        // Execute second swap (buy tokenA with tokenB)
        (bool success2,) = buyDex.call(buyData);
        require(success2, "Second swap failed");
        
        uint256 finalBalance = IERC20(tokenA).balanceOf(address(this));
        uint256 profit = finalBalance > amount ? finalBalance - amount : 0;
        
        emit ArbitrageExecuted(tokenA, tokenB, profit);
        
        return profit;
    }
    
    // Emergency functions
    function emergencyWithdraw(address token) external onlyOwner {
        if (token == address(0)) {
            payable(owner()).transfer(address(this).balance);
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(owner(), balance);
        }
    }
    
    // Approve tokens for DEXs
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }
    
    receive() external payable {}
}