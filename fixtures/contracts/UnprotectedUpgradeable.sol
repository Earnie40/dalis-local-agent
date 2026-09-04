// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately vulnerable. Never deploy.
pragma solidity ^0.8.20;

contract UnprotectedUpgradeable {
    address public admin;
    bool private _started;

    // DEFECT: initializer with no initializer modifier — anyone may claim admin.
    function initialize(address newAdmin) external {
        admin = newAdmin;
        _started = true;
    }

    function setAdmin(address newAdmin) external {
        require(msg.sender == admin, "not admin");
        admin = newAdmin;
    }
}
