// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: signature replay (no nonce / expiry / idempotency).
pragma solidity ^0.8.20;

contract SignedTransfer {
    address public immutable relayer;
    mapping(address => uint256) public balances;

    constructor(address _relayer) {
        relayer = _relayer;
    }

    // DEFECT: the same signature forwards value repeatedly — there is no nonce
    // and no used-by tracking, so every replay withdraws again.
    function transferWithSig(bytes32 hash, uint8 v, bytes32 r, bytes32 s, address from, address to, uint256 amount)
        external
    {
        require(msg.sender == relayer, "not relayer");
        // No EIP-712 nonce, no "spent" marker, no expiry.
        address recovered = ecrecover(hash, v, r, s);
        require(recovered == from, "bad signature");
        require(balances[from] >= amount, "insufficient");
        balances[from] -= amount;
        balances[to] += amount;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }
}