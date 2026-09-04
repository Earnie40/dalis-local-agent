// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

contract UnsafeSettlement {
    mapping(bytes32 => bool) public settled;
    mapping(address => uint256) public owed;

    event Settled(bytes32 indexed obligationId, bytes32 evidenceHash);

    // DEFECT: signature verified with no nonce (replayable) and no zero-address check.
    function settleWithSig(
        address to,
        uint256 amount,
        bytes32 digest,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        address signer = ecrecover(digest, v, r, s);
        owed[to] += amount;
        emit Settled(digest, digest);
        require(signer == to, "bad signer");
    }
}
