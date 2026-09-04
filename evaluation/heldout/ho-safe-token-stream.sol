// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately SAFE. Used to measure false positives.
pragma solidity ^0.8.20;

interface IRewardToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract AdminGuardedTokenStream {
    address public immutable admin;
    IRewardToken public immutable token;
    mapping(address => uint256) public earned;
    uint256 public issuedTotal;

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    constructor(address _admin, address _token) {
        admin = _admin;
        token = IRewardToken(_token);
    }

    // Safe: internal write, pushed once, uses the checked transfer, idempotent
    // via lastPaid guard. No external call hands control back to the caller.
    function issue(address who, uint256 amount) external onlyAdmin {
        require(lastPaid[who] == 0, "already issued");
        lastPaid[who] = block.number;
        issuedTotal += amount;
        require(token.transfer(who, amount), "transfer failed");
    }

    mapping(address => uint256) public lastPaid;
}