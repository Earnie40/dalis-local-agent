// SPDX-License-Identifier: UNLICENSED
// LOCAL TEST FIXTURE — deliberately SAFE. Used to measure false positives.
pragma solidity ^0.8.20;

contract SafeUpgradeable {
    address public admin;

    // Correctly protected initializer.
    function initialize(address newAdmin) external initializer {
        admin = newAdmin;
    }

    constructor() { _disableInitializers(); }

    modifier initializer() { _; }
    function _disableInitializers() internal {}
}
