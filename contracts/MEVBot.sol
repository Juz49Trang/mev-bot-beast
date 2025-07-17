// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract MEVBot is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Events
    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 profit
    );
    
    event EmergencyWithdraw(address token, uint256 amount);
    
    // State variables
    address public immutable WETH;
    mapping(address => bool) public authorized;
    
    // Modifiers
    modifier onlyAuthorized() {
        require(authorized[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }
    
    constructor(address _weth) {
        WETH = _weth;
        authorized[msg.sender] = true;
    }
    
    // Receive ETH
    receive() external payable {}
    
    // Authorization management
    function setAuthorized(address user, bool status) external onlyOwner {
        authorized[user] = status;
    }
    
    // Main arbitrage execution function
    function executeArbitrage(
        address[] calldata routers,
        bytes[] calldata swapData,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyAuthorized nonReentrant {
        require(routers.length == swapData.length, "Length mismatch");
        require(routers.length >= 2, "Need at least 2 swaps");
        
        // Record initial balance
        uint256 initialBalance;
        if (tokenIn == WETH) {
            initialBalance = address(this).balance;
            // Wrap ETH if needed
            if (address(this).balance >= amountIn) {
                IWETH(WETH).deposit{value: amountIn}();
            }
        } else {
            initialBalance = IERC20(tokenIn).balanceOf(address(this));
        }
        
        // Execute swaps
        for (uint i = 0; i < routers.length; i++) {
            _executeSwap(routers[i], swapData[i]);
        }
        
        // Calculate profit
        uint256 finalBalance;
        if (tokenIn == WETH) {
            // Unwrap WETH
            uint256 wethBalance = IWETH(WETH).balanceOf(address(this));
            if (wethBalance > 0) {
                IWETH(WETH).withdraw(wethBalance);
            }
            finalBalance = address(this).balance;
        } else {
            finalBalance = IERC20(tokenIn).balanceOf(address(this));
        }
        
        require(finalBalance > initialBalance, "No profit");
        uint256 profit = finalBalance - initialBalance;
        require(profit >= minProfit, "Profit too low");
        
        emit ArbitrageExecuted(tokenIn, tokenOut, amountIn, profit);
    }
    
    // Execute swap on DEX
    function _executeSwap(address router, bytes calldata swapData) internal {
        (bool success, bytes memory result) = router.call(swapData);
        require(success, "Swap failed");
    }
    
    // Multi-path arbitrage
    function executeMultiPathArbitrage(
        address[][] calldata paths,
        address[] calldata routers,
        bytes[] calldata swapData,
        uint256[] calldata amounts,
        uint256 minTotalProfit
    ) external onlyAuthorized nonReentrant {
        uint256 totalProfit = 0;
        
        for (uint i = 0; i < paths.length; i++) {
            // Execute each path
            uint256 balanceBefore = _getBalance(paths[i][0]);
            
            // Execute the swap for this path
            _executeSwap(routers[i], swapData[i]);
            
            uint256 balanceAfter = _getBalance(paths[i][0]);
            if (balanceAfter > balanceBefore) {
                totalProfit += balanceAfter - balanceBefore;
            }
        }
        
        require(totalProfit >= minTotalProfit, "Total profit too low");
    }
    
    // Helper function to get token balance
    function _getBalance(address token) internal view returns (uint256) {
        if (token == WETH) {
            return address(this).balance + IWETH(WETH).balanceOf(address(this));
        }
        return IERC20(token).balanceOf(address(this));
    }
    
    // Emergency functions
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(owner()).transfer(balance);
        emit EmergencyWithdraw(address(0), balance);
    }
    
    function emergencyWithdrawToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
        emit EmergencyWithdraw(token, balance);
    }
    
    // Approve tokens for DEX routers
    function approveRouter(address token, address router, uint256 amount) external onlyOwner {
        IERC20(token).approve(router, amount);
    }
    
    // Batch approve for efficiency
    function batchApprove(
        address[] calldata tokens,
        address[] calldata routers,
        uint256[] calldata amounts
    ) external onlyOwner {
        require(tokens.length == routers.length && routers.length == amounts.length, "Length mismatch");
        
        for (uint i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).approve(routers[i], amounts[i]);
        }
    }
}