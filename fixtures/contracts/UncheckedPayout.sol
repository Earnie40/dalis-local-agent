// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

contract UncheckedPayout {
    address public owner;
    mapping(address => uint256) public owed;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // DEFECT: low-level call return value is never checked.
    function payout(address to, uint256 amount) external onlyOwner {
        owed[to] = 0;
        to.call{value: amount}("");
    }
}
