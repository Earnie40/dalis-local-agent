// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately fragile. Never deploy.
pragma solidity ^0.8.20;

contract BatchPushPayments {
    address public owner;
    address[] public winners;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // DEFECT: external call inside an unbounded loop. One reverting recipient
    // blocks every payout.
    function distribute(uint256 prize) external onlyOwner {
        for (uint256 i = 0; i < winners.length; i++) {
            payable(winners[i]).transfer(prize);
        }
    }
}
