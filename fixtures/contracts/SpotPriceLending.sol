// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
}

contract SpotPriceLending {
    IPair public pair;
    mapping(address => uint256) public debt;

    // DEFECT: borrow limit derived from instantaneous pool reserves.
    function borrow(uint256 collateral) external {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        uint256 price = (uint256(r1) * 1e18) / uint256(r0);
        uint256 limit = (collateral * price) / 1e18;
        debt[msg.sender] += limit;
        (bool ok, ) = msg.sender.call{value: limit}("");
        require(ok, "send failed");
    }
}
