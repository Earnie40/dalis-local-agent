// SPDX-License-Identifier: UNLICENSED
// HELD-OUT EVALUATION FIXTURE — deliberately AMBIGUOUS / risky-but-not-proven.
// Never deploy.
pragma solidity ^0.8.20;

interface IOracle {
    function latestAnswer() external view returns (int256);
}

contract SpotOracleLoans {
    address public immutable owner;
    IOracle public immutable oracle;

    constructor(address _owner, address _oracle) {
        owner = _owner;
        oracle = IOracle(_oracle);
    }

    // RISKY, NOT PROVEN: a single pull oracle without manipulation protection or
    // any sanity bound on the answer. Whether it is exploitable depends on who
    // controls the oracle and how the price moves — the review should flag the
    // risk as conditional (possible/medium), not declare a confirmed critical.
    function borrow(uint256 collateral) external {
        require(msg.sender == owner, "borrower only");
        uint256 price = oracle.latestAnswer();
        // A flash-provisioned wildly-high price is what a sane design guards.
        require(price > 0, "stale");
        uint256 purchasing = (collateral * price) / 1e18;
        require(purchasing < type(uint256).max, "overflow");
    }
}