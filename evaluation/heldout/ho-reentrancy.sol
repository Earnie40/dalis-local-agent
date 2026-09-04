// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: reentrancy (external call before state update).
pragma solidity ^0.8.20;

contract DigitalRewardsVault {
    mapping(address => uint256) public rewards;
    address public immutable operator;

    constructor(address _operator) {
        operator = _operator;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    // DEFECT: pays out before clearing the balance, so a caller can re-enter.
    function claimReward() external {
        uint256 amount = rewards[msg.sender];
        require(amount > 0, "nothing to claim");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "payment failed");
        rewards[msg.sender] = 0;
    }

    // Operator-facing accounting; self-service callers cannot reach it.
    function credit(address who, uint256 amount) external onlyOperator {
        rewards[who] += amount;
    }
}