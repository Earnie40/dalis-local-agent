// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately SAFE. Used to measure false positives.
pragma solidity ^0.8.20;

contract SafeSignedSettlement {
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(uint256 => bool) public usedNonces;
    mapping(address => bool) public settlers;
    mapping(address => uint256) public owed;

    constructor(bytes32 separator) { DOMAIN_SEPARATOR = separator; }

    // Nonce, deadline, domain separator, and a zero-address rejection.
    function settleWithSig(
        address to, uint256 amount, uint256 nonce, uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        require(block.timestamp <= deadline, "expired");
        require(!usedNonces[nonce], "nonce used");

        bytes32 structHash = keccak256(abi.encode(to, amount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
        require(settlers[signer], "signer not authorized");

        usedNonces[nonce] = true;
        owed[to] += amount;
    }
}
