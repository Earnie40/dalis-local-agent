// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

contract ArbitraryDelegatecall {
    address public owner;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // DEFECT: delegatecall to a caller-supplied target is arbitrary code
    // execution against this contract's own storage.
    function execute(address target, bytes calldata data) external onlyOwner {
        (bool ok, ) = target.delegatecall(data);
        require(ok, "call failed");
    }
}
