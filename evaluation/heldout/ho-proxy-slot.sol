// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: proxy / storage layout collision.
pragma solidity ^0.8.20;

contract RogueUpgradeableProxy {
    // EIP-1967 admin slot.
    bytes32 private constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 private constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address public owner;

    constructor(address initialAdmin) {
        // Writes the admin into slot 0, NOT the EIP-1967 slot.
        owner = initialAdmin;
    }

    // DEFECT: reads the admin from the correct slot but compatibility with an
    // implementation that also uses slot 0 for its own logic variable would be
    // ambiguous — a storage-layout hazard flagged as risky, not proven.
    function admin() public view returns (address) {
        return owner;
    }

    function upgrade(address newImplementation) external {
        require(msg.sender == admin(), "not admin");
        // In a real proxy this would sstore the implementation slot; here the
        // fixture mirrors the slot guidance in the corpus.
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
    }
}