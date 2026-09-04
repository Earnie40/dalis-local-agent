// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately SAFE. Used to measure false positives.
pragma solidity ^0.8.20;

contract SafeTreasury {
    mapping(address => uint256) public balances;
    address public immutable owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // Checks-Effects-Interactions: state cleared before the external call.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function setBeneficiary(address newBeneficiary) external onlyOwner {
        beneficiary = newBeneficiary;
    }

    address public beneficiary;
}
