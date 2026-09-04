// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately vulnerable. Never deploy.
// Category: unsafe external call (return value ignored -> gas grief).
pragma solidity ^0.8.20;

contract BatchAirdrop {
    address public immutable token;

    constructor(address _token) {
        token = _token;
    }

    // DEFECT: ignores the transfer() result; a failing token effectively blocks
    // the rest of the batched recipients silently.
    function airdrop(address[] calldata recipients, uint256 amount) external {
        for (uint256 i = 0; i < recipients.length; i++) {
            // (bool ok, ) is not checked.
            token.call(
                abi.encodeWithSignature("transfer(address,uint256)", recipients[i], amount)
            );
        }
    }
}