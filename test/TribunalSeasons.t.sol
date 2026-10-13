// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Tribunal} from "../src/Tribunal.sol";
import {Seasons} from "../src/Seasons.sol";
import {CabalGate} from "../src/CabalGate.sol";

/// @notice How Seasons waits for the Tribunal: held points, sustained pleas, closes that skip held
/// pleas, letters that sell during a hold, and the timing bound inside the close grace.
contract TribunalSeasonsTest is Fixture {
    uint256 constant WINDOW = 20 minutes;

    function withTribunal() internal pure override returns (bool) {
        return true;
    }

    /// @dev Two-day seasons: a season end is reachable while the 33-hour Cabal still lives.
    function setTimings() internal override {
        SEASON = 2 days;
    }

    function setUp() public virtual override {
        super.setUp();
        buy(alice, 50e18);
        buy(bob, 50e18);
        buy(carol, 50e18);
        skip(1 days);
    }

    function test_theTimingBoundHoldsInsideTheCloseGrace() public view {
        assertLt(tribunal.OBJECTION_WINDOW() + tribunal.PENDING_EXPIRY(), seasons.CLOSE_GRACE());
    }

    function test_seasonsFindsTheTribunalThroughTheLauncher() public view {
        assertEq(launch.tribunal(), address(tribunal));
        assertEq(launch.predictTribunal(), address(tribunal));
        assertTrue(seasons.excluded(OWNER));
        assertFalse(seasons.excluded(alice));
    }

    function test_recordWaitsForTheWindowThenForAPendingObjection() public {
        uint256 id = approvedPlea(alice, 40);
        vm.expectRevert(abi.encodeWithSelector(Seasons.Held.selector, id));
        seasons.record(id);
        skip(WINDOW - 1);
        uint256 oid = objectTo(bob, id);
        skip(2);
        vm.expectRevert(abi.encodeWithSelector(Seasons.Held.selector, id)); // pending objection past the window
        seasons.record(id);
        assertTrue(rule(oid, 44));
        seasons.record(id);
        assertEq(seasons.bestOf(0, alice)[0], 40);
        assertTrue(seasons.recorded(id));
    }

    function test_recordIsFreeOnceTheWindowClosesWithNoObjection() public {
        uint256 id = approvedPlea(alice, 40);
        skip(WINDOW);
        vm.expectRevert(abi.encodeWithSelector(Seasons.Held.selector, id));
        seasons.record(id);
        skip(1);
        seasons.record(id);
        objectFails(bob, id, abi.encodeWithSelector(Tribunal.WindowClosed.selector, id));
    }

    function test_closeSeasonSkipsHeldPleasAndRecordsThemLater() public {
        // A plea approved just before the season ends is still held when the close could run.
        keepAlive(carol);
        uint256 end = uint256(gate.startedAt()) + SEASON;
        vm.warp(end - 10 minutes);
        uint256 id = approvedPlea(alice, 40);
        uint256 oid = objectTo(bob, id);
        vm.warp(end + 1 hours); // the close grace has passed; the objection is 20 minutes stale
        // Stale: no longer held, so the close records it (the ruling never came).
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        seasons.closeSeason(ids);
        assertTrue(seasons.recorded(id), "a stale objection does not keep a plea out of its season");
        assertEq(seasons.bestOf(0, alice)[0], 40);
        tribunal.expire(oid);
        tribunal.settle(oid);
    }

    function test_closeListsAHeldPleaOfTheRunningSeasonWithoutReverting() public {
        // Season 0 is closable; a plea of season 1 approved just now is held: the list skips it.
        keepAlive(carol);
        vm.warp(uint256(gate.startedAt()) + SEASON + 1 hours);
        uint256 id = approvedPlea(alice, 40);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        seasons.closeSeason(ids);
        assertFalse(seasons.recorded(id));
        skip(WINDOW + 1);
        seasons.record(id);
        assertEq(seasons.bestOf(1, alice)[0], 40);
    }

    function test_approvalInTheLastSecondIsRuledAndRecordedInsideTheGrace() public {
        keepAlive(carol);
        uint256 end = uint256(gate.startedAt()) + SEASON;
        vm.warp(end - 1);
        uint256 id = approvedPlea(alice, 40);
        vm.warp(end - 1 + WINDOW); // last second of the objection window
        uint256 oid = objectTo(bob, id);
        vm.warp(end - 1 + WINDOW + tribunal.PENDING_EXPIRY()); // last second of the ruling
        assertTrue(rule(oid, 38));
        assertLt(vm.getBlockTimestamp(), end + seasons.CLOSE_GRACE(), "ruled before the close could run");
        vm.warp(end + seasons.CLOSE_GRACE());
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        seasons.closeSeason(ids);
        assertTrue(seasons.recorded(id));
        assertEq(seasons.bestOf(0, alice)[0], 38);
    }

    function test_aSustainedPleaIsNeverRecordedEvenByAClose() public {
        uint256 id = approvedPlea(alice, 40);
        uint256 oid = objectTo(bob, id);
        assertTrue(rule(oid, 0));
        vm.warp(uint256(gate.startedAt()) + SEASON + 1 hours);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        seasons.closeSeason(ids);
        assertFalse(seasons.recorded(id));
        assertEq(seasons.bestOf(0, alice)[0], 0);
    }

    function test_aLetterSellsDuringTheHoldAndItsPointsAreRecordedLater() public {
        // A site-style plea through the Letterbox (auto-sell): deliver sells inside the 7-minute
        // window while the objection window is still open; the points come later.
        uint256 amount = plea.balanceOf(alice) / 10;
        vm.prank(alice);
        uint256 id = letterbox.plead(amount, "Rent is due and I keep the rest.");
        assertTrue(answer(id, 40));
        vm.prank(keeper);
        letterbox.deliver(id);
        assertEq(uint8(gate.getPlea(id).status), uint8(CabalGate.Status.Executed));
        assertFalse(seasons.recorded(id), "held: not recorded by the delivery");
        uint256 oid = objectTo(bob, id);
        assertTrue(rule(oid, 39));
        skip(WINDOW + 1);
        seasons.record(id);
        assertEq(seasons.bestOf(0, alice)[0], 39, "the lowest panel's score, recorded after the sale");
    }
}

/// @notice A plea recorded before the Tribunal was deployed is out of its reach.
contract TribunalLateDeployTest is Fixture {
    function withTribunal() internal pure override returns (bool) {
        return true;
    }

    function deployTribunalAtLaunch() internal pure override returns (bool) {
        return false;
    }

    function test_aPleaRecordedBeforeTheTribunalCannotBeObjectedTo() public {
        assertEq(launch.tribunal(), address(0));
        buy(alice, 50e18);
        skip(1 days);
        uint256 id = approvedPlea(alice, 40);
        seasons.record(id); // no Tribunal yet: recorded at once, today's behaviour
        tribunal = Tribunal(launch.deployTribunal(type(Tribunal).creationCode));
        assertTrue(seasons.recorded(id));
        (, bool sustained,) = tribunal.standing(id);
        assertFalse(sustained);
        objectFails(bob, id, abi.encodeWithSelector(Tribunal.AlreadyRecorded.selector, id));
        // The next approval is held like any other.
        buy(carol, 50e18);
        skip(1 days);
        uint256 id2 = approvedPlea(carol, 40);
        vm.expectRevert(abi.encodeWithSelector(Seasons.Held.selector, id2));
        seasons.record(id2);
    }
}
