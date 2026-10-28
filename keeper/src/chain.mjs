import { zeroAddress } from 'viem';
import {
  launchAbi, gateAbi, intakeAbi, letterboxAbi, tribunalAbi, seasonsAbi, hookAbi, erc20Abi, MULTICALL3, Status, Ruling,
} from './abi.mjs';

const BATCH = 150; // calls per multicall

/** The system's addresses and constants, read from PleaLaunch. Null until trading is open. */
export async function discover(client, launch) {
  const r = await many(client, [
    [launch, launchAbi, 'plea'],
    [launch, launchAbi, 'gate'],
    [launch, launchAbi, 'seasons'],
    [launch, launchAbi, 'hook'],
    [launch, launchAbi, 'letterbox'],
    [launch, launchAbi, 'tribunal'],
    [launch, launchAbi, 'opened'],
  ]);
  const [plea, gate, seasons, hook, letterbox, tribunal, opened] = r;
  if (!opened || [hook, letterbox, tribunal].includes(zeroAddress)) return null;
  const c = await many(client, [
    [gate, gateAbi, 'intake'],
    [gate, gateAbi, 'DEADMAN'],
    [gate, gateAbi, 'PENDING_EXPIRY'],
    [gate, gateAbi, 'EXECUTE_WINDOW'],
    [tribunal, tribunalAbi, 'PENDING_EXPIRY'],
    [seasons, seasonsAbi, 'SEASON'],
    [seasons, seasonsAbi, 'CLOSE_GRACE'],
    [hook, hookAbi, 'imd'],
    [hook, hookAbi, 'WALL_MIN_FILL'],
  ]);
  const [intake, deadman, pendingExpiry, executeWindow, tribunalExpiry, seasonLength, closeGrace, imd, wallMinFill] = c;
  return {
    launch, plea, gate, seasons, hook, letterbox, tribunal, intake, imd,
    deadman, pendingExpiry, executeWindow, tribunalExpiry, seasonLength, closeGrace, wallMinFill,
  };
}

/** One consistent read of everything the planner needs, at one block. */
export async function snapshot(client, sys, keeper, state) {
  const block = await client.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const top = await many(client, [
    [sys.gate, gateAbi, 'nextId'],
    [sys.gate, gateAbi, 'startedAt'],
    [sys.gate, gateAbi, 'lastVerdictAt'],
    [sys.gate, gateAbi, 'cabalAlive'],
    [sys.gate, gateAbi, 'diedAt'],
    [sys.tribunal, tribunalAbi, 'nextId'],
    [sys.seasons, seasonsAbi, 'nextToClose'],
    [sys.seasons, seasonsAbi, 'finished'],
    [sys.seasons, seasonsAbi, 'pot'],
    [sys.plea, erc20Abi, 'balanceOf', [sys.seasons]],
    [sys.hook, hookAbi, 'seeded'],
    [sys.hook, hookAbi, 'pendingRebalance'],
    [sys.hook, hookAbi, 'retainedImd'],
    [sys.hook, hookAbi, 'retainClaims'],
    [sys.hook, hookAbi, 'pleaClaims'],
    [sys.hook, hookAbi, 'pleaInWall'],
    [sys.imd, erc20Abi, 'balanceOf', [keeper]],
  ], at);
  const [nextId, startedAt, lastVerdictAt, alive, diedAt, nextObjection, nextToClose, finished, pot, seasonsPlea,
    seeded, pendingRebalance, retainedImd, retainClaims, pleaClaims, pleaInWall, keeperImd] = top;
  const [bounds] = await many(client, [[sys.seasons, seasonsAbi, 'seasonBounds', [nextToClose]]], at);
  const eth = await client.getBalance({ address: keeper, blockNumber: block.number });

  const donePleas = new Set(state.done.pleas);
  const pleaIds = [];
  for (let id = 1n; id < nextId; id++) if (!donePleas.has(id.toString())) pleaIds.push(id);
  const per = await many(client, pleaIds.flatMap((id) => [
    [sys.gate, gateAbi, 'getPlea', [id]],
    [sys.letterbox, letterboxAbi, 'escrowOf', [id]],
    [sys.seasons, seasonsAbi, 'recorded', [id]],
    [sys.tribunal, tribunalAbi, 'standing', [id]],
  ]), at);
  const pleas = pleaIds.map((id, i) => {
    const [p, e, recorded, s] = per.slice(4 * i, 4 * i + 4);
    return {
      id,
      seller: p.seller,
      status: p.status,
      flags: p.flags,
      amount: p.amount,
      submittedAt: p.submittedAt,
      verdictAt: p.verdictAt,
      intakeId: p.intakeId,
      escrowOpen: e[1],
      recorded,
      held: s[0],
      sustained: s[1],
      excluded: false,
      intakeCompleted: false,
    };
  });

  const doneObjections = new Set(state.done.objections);
  const objIds = [];
  for (let id = 1n; id < nextObjection; id++) if (!doneObjections.has(id.toString())) objIds.push(id);
  const objs = await many(client, objIds.map((id) => [sys.tribunal, tribunalAbi, 'objection', [id]]), at);
  const objections = objIds.map((id, i) => ({
    id,
    pleaId: objs[i].pleaId,
    ruling: objs[i].ruling,
    settled: objs[i].settled,
    filedAt: objs[i].filedAt,
    intakeId: objs[i].intakeId,
    intakeCompleted: false,
  }));

  // Second round: sellers' exclusion, the Intake's view of pending requests, closed seasons.
  const sellers = [...new Set(pleas.map((p) => p.seller))];
  const pendingP = pleas.filter((p) => p.status === Status.Pending);
  const pendingO = objections.filter((o) => o.ruling === Ruling.Pending);
  const approved = pleas.filter((p) => [Status.Approved, Status.Executed, Status.Lapsed].includes(p.status));
  const seasonsOfApproved = [...new Set(approved.map((p) => ((p.verdictAt - startedAt) / sys.seasonLength).toString()))];
  const second = await many(client, [
    ...sellers.map((a) => [sys.seasons, seasonsAbi, 'excluded', [a]]),
    ...pendingP.map((p) => [sys.intake, intakeAbi, 'requests', [p.intakeId]]),
    ...pendingO.map((o) => [sys.intake, intakeAbi, 'requests', [o.intakeId]]),
    ...seasonsOfApproved.map((k) => [sys.seasons, seasonsAbi, 'closed', [BigInt(k)]]),
  ], at);
  let k = 0;
  const excluded = new Map(sellers.map((a) => [a, second[k++]]));
  for (const p of pleas) p.excluded = excluded.get(p.seller);
  for (const p of pendingP) p.intakeCompleted = second[k++][3];
  for (const o of pendingO) o.intakeCompleted = second[k++][3];
  const closed = {};
  for (const s of seasonsOfApproved) closed[s] = second[k++];

  return {
    now: block.timestamp,
    blockNumber: block.number,
    baseFee: block.baseFeePerGas ?? 0n,
    gate: {
      nextId, startedAt, lastVerdictAt, alive, diedAt,
      deadman: sys.deadman, pendingExpiry: sys.pendingExpiry, executeWindow: sys.executeWindow,
    },
    tribunal: { nextId: nextObjection, pendingExpiry: sys.tribunalExpiry },
    seasons: {
      nextToClose, finished, pot, pleaBalance: seasonsPlea, length: sys.seasonLength, closeGrace: sys.closeGrace,
      bounds: { exists: bounds[0], start: bounds[1], end: bounds[2], ended: bounds[3] },
      closed,
    },
    hook: { seeded, pendingRebalance, retainedImd, retainClaims, pleaClaims, pleaInWall, wallMinFill: sys.wallMinFill },
    keeper: { address: keeper, eth, imd: keeperImd },
    pleas,
    objections,
  };
}

/** Reads `calls` ([address, abi, functionName, args?]) through Multicall3; throws on any failure. */
export async function many(client, calls, at = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH);
    const res = await client.multicall({
      contracts: chunk.map(([address, abi, functionName, args]) => ({ address, abi, functionName, args })),
      allowFailure: false,
      multicallAddress: MULTICALL3,
      ...at,
    });
    out.push(...res);
  }
  return out;
}
