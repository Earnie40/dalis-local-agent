// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

contract TxOriginAuth {
    address public owner;
    mapping(address => uint256) public balances;

    // DEFECT: tx.origin used for authorization.
    function sweep(address payable to) external {
        require(tx.origin == owner, "not owner");
        to.transfer(address(this).balance);
    }
}
