// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately SAFE. Used to measure false positives.
pragma solidity ^0.8.20;

contract SafePersonalEscrow {
    address public immutable owner;
    mapping(address => uint256) public balances;
    uint256 private _locked;

    modifier noReentrancy() {
        require(_locked == 0, "locked");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // Checks-Effects-Interactions AND a reentrancy guard. Nothing can re-enter.
    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing");
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }
}