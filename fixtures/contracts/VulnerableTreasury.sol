// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract VulnerableTreasury {
    mapping(address => uint256) public balances;
    address public treasury;
    IERC20 public token;

    // DEFECT: no access control on a privileged configuration setter.
    function setTreasury(address newTreasury) external {
        treasury = newTreasury;
    }

    // DEFECT: external call before the state update (reentrancy).
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }
}
