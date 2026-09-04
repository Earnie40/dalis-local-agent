// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: fee-on-transfer token accounting / invariant insolvency.
pragma solidity ^0.8.20;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract LidoShareVault {
    IERC20Like public asset;
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    constructor(address _asset) {
        asset = IERC20Like(_asset);
    }

    // DEFECT: credits the requested amount, not the amount received. With a
    // fee-on-transfer token the vault's recorded shares exceed real holdings.
    function mint(uint256 amount) external {
        asset.transferFrom(msg.sender, address(this), amount);
        shares[msg.sender] += amount;
        totalShares += amount;
    }

    function redeem(uint256 shareAmount) external {
        require(shares[msg.sender] >= shareAmount, "insufficient");
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
    }
}