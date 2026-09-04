// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
// Probes TOKEN ACCOUNTING, a class the current analyzer has no detector for.
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract FeeOnTransferVault {
    IERC20 public token;
    mapping(address => uint256) public credited;
    uint256 public totalCredited;

    // DEFECT: credits the requested amount, not the amount actually received.
    // With a fee-on-transfer token the vault becomes insolvent.
    function deposit(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        credited[msg.sender] += amount;
        totalCredited += amount;
    }
}
