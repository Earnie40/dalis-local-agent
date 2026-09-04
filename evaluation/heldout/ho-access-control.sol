// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: access control (privileged setter with no authorization check).
pragma solidity ^0.8.20;

contract ProtocolAdmin {
    address public owner;
    address public feeRecipient = address(0);
    uint256 public feeBps = 0;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    // DEFECT: no access control — anyone can seize fee routing.
    function setFeeRecipient(address recipient) external {
        feeRecipient = recipient;
    }

    // DEFECT: no access control — anyone can set fees.
    function setFeeBps(uint256 basisPoints) external {
        require(basisPoints <= 10_000, "bps too high");
        feeBps = basisPoints;
    }

    function setOwner(address nextOwner) external {
        require(msg.sender == owner, "not owner");
        owner = nextOwner;
    }
}