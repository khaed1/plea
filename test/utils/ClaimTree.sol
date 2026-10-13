// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Eight distinct bitmap-edge indices, including adjacent words and the last possible word.
library ClaimTree {
    function index(uint256 position) internal pure returns (uint256) {
        uint256[8] memory indices = [uint256(0), 1, 254, 255, 256, 257, 65535, type(uint256).max];
        return indices[position];
    }

    function amount(uint256 position) internal pure returns (uint256) {
        return (position + 1) * 1_000_000e18;
    }

    function leaf(uint256 position, address account) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index(position), account, amount(position)));
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function tree(address[4] memory actors) internal pure returns (bytes32[15] memory nodes) {
        for (uint256 i; i < 8; ++i) {
            nodes[7 + i] = leaf(i, actors[i % 4]);
        }
        for (uint256 i = 7; i > 0; --i) {
            nodes[i - 1] = pair(nodes[2 * i - 1], nodes[2 * i]);
        }
    }

    function proof(address[4] memory actors, uint256 position) internal pure returns (bytes32[] memory path) {
        bytes32[15] memory nodes = tree(actors);
        path = new bytes32[](3);
        uint256 at = 7 + position;
        for (uint256 i; i < 3; ++i) {
            path[i] = nodes[at % 2 == 0 ? at - 1 : at + 1];
            at = (at - 1) / 2;
        }
    }
}
