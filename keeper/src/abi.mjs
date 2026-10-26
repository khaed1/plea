import { parseAbi } from 'viem';

// Only what the keeper reads or calls. Enums are uint8 on the wire.

export const launchAbi = parseAbi([
  'function plea() view returns (address)',
  'function gate() view returns (address)',
  'function seasons() view returns (address)',
  'function hook() view returns (address)',
  'function letterbox() view returns (address)',
  'function tribunal() view returns (address)',
  'function opened() view returns (bool)',
]);

export const gateAbi = parseAbi([
  'struct Plea { address seller; uint8 factScore; uint8 need; uint8 score; uint8 status; bool appealed; bool isAppeal; uint8 flags; uint128 amount; uint64 submittedAt; uint64 verdictAt; uint64 originalId; bytes32 intakeId; string text; }',
  'function getPlea(uint256 id) view returns (Plea)',
  'function nextId() view returns (uint256)',
  'function startedAt() view returns (uint64)',
  'function lastVerdictAt() view returns (uint64)',
  'function cabalAlive() view returns (bool)',
  'function diedAt() view returns (uint64)',
  'function intake() view returns (address)',
  'function DEADMAN() view returns (uint256)',
  'function PENDING_EXPIRY() view returns (uint256)',
  'function EXECUTE_WINDOW() view returns (uint256)',
  'function expire(uint256 id)',
  'error NotPending()',
  'error NotStale()',
  'error WindowLapsed()',
  'error TooLate()',
  'error CabalNotWatching()',
]);

export const intakeAbi = parseAbi([
  'function requests(bytes32 requestId) view returns (address payer, address callbackTarget, bytes4 callbackSelector, bool completed)',
]);

export const letterboxAbi = parseAbi([
  'function escrowOf(uint256 id) view returns (address writer, bool open, uint256 amount, uint256 soldFor)',
  'function deliver(uint256 id) returns (uint256 out)',
  'function settle(uint256 id)',
  'event Delivered(uint256 indexed id, address indexed runner, uint256 out, uint256 tip, uint256 fee)',
  'error NotOpen(uint256 id)',
  'error NotSettleable(uint256 id)',
]);

export const tribunalAbi = parseAbi([
  'struct Objection { uint64 pleaId; address objector; uint8 ruling; uint8 newScore; bool settled; uint64 filedAt; bytes32 intakeId; string text; }',
  'function objection(uint256 id) view returns (Objection)',
  'function standing(uint256 pleaId) view returns (bool held, bool sustained, uint8 lowest)',
  'function nextId() view returns (uint256)',
  'function PENDING_EXPIRY() view returns (uint256)',
  'function expire(uint256 id)',
  'function settle(uint256 id)',
  'error NotPending()',
  'error NotStale()',
  'error NotRuled(uint256 id)',
  'error AlreadySettled(uint256 id)',
]);

export const seasonsAbi = parseAbi([
  'function nextToClose() view returns (uint256)',
  'function seasonBounds(uint256 season) view returns (bool exists, uint64 start, uint64 end, bool ended)',
  'function finished() view returns (bool)',
  'function pot() view returns (uint256)',
  'function recorded(uint256 pleaId) view returns (bool)',
  'function closed(uint256 season) view returns (bool)',
  'function excluded(address wallet) view returns (bool)',
  'function SEASON() view returns (uint256)',
  'function CLOSE_GRACE() view returns (uint256)',
  'function record(uint256 pleaId)',
  'function closeSeason(uint256[] pleaIds)',
  'function flushToWall()',
  'event SeasonClosedOut(uint256 indexed season, uint256 amountIn, uint256 paid)',
  'error NotApproved(uint256 pleaId)',
  'error AlreadyRecorded(uint256 pleaId)',
  'error OwnerExcluded()',
  'error SeasonClosed(uint256 season)',
  'error Held(uint256 pleaId)',
  'error ObjectionSustained(uint256 pleaId)',
  'error NotReady(uint256 season)',
  'error NotFinished()',
]);

export const hookAbi = parseAbi([
  'function seeded() view returns (bool)',
  'function imd() view returns (address)',
  'function pendingRebalance() view returns (bool)',
  'function retainedImd() view returns (uint256)',
  'function retainClaims() view returns (uint256)',
  'function pleaClaims() view returns (uint256)',
  'function pleaInWall() view returns (uint256)',
  'function wall() view returns (int24 tickLower, int24 tickUpper, uint128 liquidity)',
  'function WALL_MIN_FILL() view returns (uint256)',
  'function rebalance()',
  'error RebalanceNotNeeded()',
  'error PartialFill(uint256 filled, uint256 requested)',
  'error NotEnoughGas(uint256 needed, uint256 left)',
  'error PriceMoved()',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** CabalGate.Status */
export const Status = { None: 0, Pending: 1, Approved: 2, Denied: 3, Executed: 4, Lapsed: 5, Expired: 6 };
/** Tribunal.Ruling */
export const Ruling = { None: 0, Pending: 1, Sustained: 2, Overruled: 3, Void: 4 };

/** Every error the keeper may meet in a simulation, for readable logs. */
export const allErrorsAbi = [
  ...gateAbi, ...letterboxAbi, ...tribunalAbi, ...seasonsAbi, ...hookAbi,
].filter((x) => x.type === 'error');
