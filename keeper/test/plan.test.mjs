import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, alertsFor, ORDER } from '../src/plan.mjs';
import { Status, Ruling } from '../src/abi.mjs';
import { emptyState } from '../src/state.mjs';

const T0 = 1_800_000_000n; // trading opened
const SEASON = 15n * 86_400n;
const MIN = 60n;
const cfg = { imdSlowMinutes: 5, rebalanceEverySeconds: 600, rebalanceMinReserve: 10n ** 18n, minEth: 10n ** 16n };

function snap(over = {}) {
  const base = {
    now: T0 + 2n * 86_400n,
    baseFee: 1n,
    gate: { startedAt: T0, lastVerdictAt: T0 + 2n * 86_400n - 100n, alive: true, diedAt: 0n, deadman: 118_800n, pendingExpiry: 20n * MIN, executeWindow: 7n * MIN },
    tribunal: { pendingExpiry: 20n * MIN },
    seasons: {
      nextToClose: 0n, finished: false, pot: 0n, pleaBalance: 0n, length: SEASON, closeGrace: 3600n,
      bounds: { exists: true, start: T0, end: T0 + SEASON, ended: false }, closed: {},
    },
    hook: { seeded: true, pendingRebalance: false, retainedImd: 0n, retainClaims: 0n, pleaClaims: 0n, pleaInWall: 0n, wallMinFill: 1000n * 10n ** 18n },
    keeper: { eth: 10n ** 18n, imd: 0n },
    pleas: [],
    objections: [],
  };
  return deepMerge(base, over);
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' && !Array.isArray(a[k])) a[k] = deepMerge({ ...a[k] }, v);
    else a[k] = v;
  }
  return a;
}

function p(over) {
  return {
    id: 1n, seller: '0x0000000000000000000000000000000000000001', status: Status.Pending, flags: 0,
    submittedAt: T0 + 2n * 86_400n - 60n, verdictAt: 0n, intakeId: '0x', escrowOpen: false,
    recorded: false, held: false, sustained: false, excluded: false, intakeCompleted: false, ...over,
  };
}

const kinds = (r) => r.jobs.map((j) => `${j.kind}:${j.id}`);
const now = T0 + 2n * 86_400n;

test('a fresh pending hand plea waits; IMD slow after 5 minutes; expired after 20', () => {
  assert.deepEqual(kinds(plan(snap({ pleas: [p({})] }), emptyState(), cfg)), []);
  const slow = plan(snap({ pleas: [p({ submittedAt: now - 6n * MIN })] }), emptyState(), cfg);
  assert.deepEqual(kinds(slow), []);
  assert.equal(slow.notes[0].kind, 'imdSlow');
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ submittedAt: now - 20n * MIN })] }), emptyState(), cfg)), [], 'exactly 20 min is not stale yet');
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ submittedAt: now - 20n * MIN - 1n })] }), emptyState(), cfg)), ['expirePlea:1']);
});

test('a pending plea the Intake completed without a verdict is expired at once', () => {
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ intakeCompleted: true })] }), emptyState(), cfg)), ['expirePlea:1']);
});

test('a stale pending letter is settled (the settle expires it), never expired directly', () => {
  const r = plan(snap({ pleas: [p({ escrowOpen: true, submittedAt: now - 21n * MIN })] }), emptyState(), cfg);
  assert.deepEqual(kinds(r), ['settleLetter:1']);
});

test('an approved letter inside its window is delivered (urgent), not recorded yet', () => {
  const r = plan(snap({ pleas: [p({ status: Status.Approved, escrowOpen: true, verdictAt: now - 6n * MIN, held: true })] }), emptyState(), cfg);
  assert.deepEqual(kinds(r), ['deliver:1']);
  assert.equal(r.jobs[0].urgent, true);
  const edge = plan(snap({ pleas: [p({ status: Status.Approved, escrowOpen: true, verdictAt: now - 7n * MIN, held: false })] }), emptyState(), cfg);
  assert.deepEqual(kinds(edge), ['deliver:1'], 'the last second of the window still delivers');
});

test('an approved letter past its window is settled, and the settle records it', () => {
  const r = plan(snap({ pleas: [p({ status: Status.Approved, escrowOpen: true, verdictAt: now - 7n * MIN - 1n })] }), emptyState(), cfg);
  assert.deepEqual(kinds(r), ['settleLetter:1']);
});

test('a denied or expired letter is settled; once settled it is done', () => {
  for (const status of [Status.Denied, Status.Expired]) {
    assert.deepEqual(kinds(plan(snap({ pleas: [p({ status, escrowOpen: true })] }), emptyState(), cfg)), ['settleLetter:1']);
    const r = plan(snap({ pleas: [p({ status })] }), emptyState(), cfg);
    assert.deepEqual(kinds(r), []);
    assert.deepEqual(r.done.pleas, [1n]);
  }
});

test('an executed plea is recorded once its hold ends, then done', () => {
  const sold = { status: Status.Executed, verdictAt: now - 10n * MIN };
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ ...sold, held: true })] }), emptyState(), cfg)), []);
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ ...sold })] }), emptyState(), cfg)), ['record:1']);
  const r = plan(snap({ pleas: [p({ ...sold, recorded: true })] }), emptyState(), cfg);
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.done.pleas, [1n]);
});

test('a lapsed hand approval (approved, window passed, never sold) is still recorded', () => {
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ status: Status.Approved, verdictAt: now - 30n * MIN })] }), emptyState(), cfg)), ['record:1']);
  assert.deepEqual(kinds(plan(snap({ pleas: [p({ status: Status.Lapsed, verdictAt: now - 30n * MIN })] }), emptyState(), cfg)), ['record:1']);
});

test('sustained, excluded or closed-season approvals are never recorded and are done', () => {
  const base = { status: Status.Executed, verdictAt: now - 30n * MIN };
  for (const over of [{ sustained: true }, { excluded: true }]) {
    const r = plan(snap({ pleas: [p({ ...base, ...over })] }), emptyState(), cfg);
    assert.deepEqual(kinds(r), []);
    assert.deepEqual(r.done.pleas, [1n]);
  }
  const r = plan(snap({ pleas: [p({ ...base })], seasons: { closed: { 0: true } } }), emptyState(), cfg);
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.done.pleas, [1n]);
});

test('objections: stale pending expired, ruled settled, settled done, slow noted', () => {
  const o = (over) => ({ id: 1n, pleaId: 1n, ruling: Ruling.Pending, settled: false, filedAt: now - 60n, intakeId: '0x', intakeCompleted: false, ...over });
  assert.deepEqual(kinds(plan(snap({ objections: [o({})] }), emptyState(), cfg)), []);
  assert.equal(plan(snap({ objections: [o({ filedAt: now - 6n * MIN })] }), emptyState(), cfg).notes[0].what, 'objection');
  assert.deepEqual(kinds(plan(snap({ objections: [o({ filedAt: now - 21n * MIN })] }), emptyState(), cfg)), ['expireObjection:1']);
  assert.deepEqual(kinds(plan(snap({ objections: [o({ intakeCompleted: true })] }), emptyState(), cfg)), ['expireObjection:1']);
  for (const ruling of [Ruling.Sustained, Ruling.Overruled, Ruling.Void]) {
    assert.deepEqual(kinds(plan(snap({ objections: [o({ ruling })] }), emptyState(), cfg)), ['settleObjection:1']);
    const r = plan(snap({ objections: [o({ ruling, settled: true })] }), emptyState(), cfg);
    assert.deepEqual(r.done.objections, [1n]);
  }
});

test('a season closes an hour after it ends, listing only its own unrecorded approvals', () => {
  const end = T0 + SEASON;
  const pleas = [
    p({ id: 1n, status: Status.Executed, verdictAt: T0 + 100n, held: true }),
    p({ id: 2n, status: Status.Executed, verdictAt: T0 + 200n, recorded: true }),
    p({ id: 3n, status: Status.Executed, verdictAt: end + 10n, held: true }), // next season
    p({ id: 4n, status: Status.Denied, verdictAt: T0 + 300n }),
    p({ id: 5n, status: Status.Executed, verdictAt: T0 + 400n, sustained: true }),
  ];
  const bounds = { exists: true, start: T0, end, ended: true };
  const early = plan(snap({ now: end + 3599n, seasons: { bounds }, pleas }), emptyState(), cfg);
  assert.equal(early.jobs.filter((j) => j.kind === 'closeSeason').length, 0);
  const r = plan(snap({ now: end + 3600n, seasons: { bounds }, pleas }), emptyState(), cfg);
  const close = r.jobs.find((j) => j.kind === 'closeSeason');
  assert.equal(close.id, 0n);
  assert.deepEqual(close.ids, [1n]);
});

test('flush once finished and Seasons still holds something', () => {
  assert.deepEqual(kinds(plan(snap({ seasons: { finished: true, pot: 5n } }), emptyState(), cfg)), ['flush:0']);
  assert.deepEqual(kinds(plan(snap({ seasons: { finished: true, pleaBalance: 5n } }), emptyState(), cfg)), ['flush:0']);
  assert.deepEqual(kinds(plan(snap({ seasons: { finished: true } }), emptyState(), cfg)), []);
});

test('rebalance: due, hinted and worth it; the reserve waits for its minimum; a filled wall does not', () => {
  const hook = { pendingRebalance: true, retainedImd: 6n * 10n ** 17n, retainClaims: 4n * 10n ** 17n };
  assert.deepEqual(kinds(plan(snap({ hook }), emptyState(), cfg)), ['rebalance:0']);
  const small = { pendingRebalance: true, retainedImd: 5n * 10n ** 17n };
  assert.deepEqual(kinds(plan(snap({ hook: small }), emptyState(), cfg)), []);
  assert.deepEqual(kinds(plan(snap({ hook: { ...small, pleaInWall: 1000n * 10n ** 18n } }), emptyState(), cfg)), ['rebalance:0']);
  assert.deepEqual(kinds(plan(snap({ hook: { ...small, pleaClaims: 1n } }), emptyState(), cfg)), ['rebalance:0']);
  const recent = { ...emptyState(), lastRebalanceAt: (now - 599n).toString() };
  assert.deepEqual(kinds(plan(snap({ hook }), recent, cfg)), [], 'not before the next cycle');
  assert.deepEqual(kinds(plan(snap({ hook: { ...hook, pendingRebalance: false } }), emptyState(), cfg)), []);
  assert.deepEqual(kinds(plan(snap({ hook: { ...hook, seeded: false } }), emptyState(), cfg)), []);
});

test('jobs come out in the fixed order, deliveries first', () => {
  const pleas = [
    p({ id: 1n, status: Status.Executed, verdictAt: now - 30n * MIN }),
    p({ id: 2n, status: Status.Approved, escrowOpen: true, verdictAt: now - MIN, held: true }),
    p({ id: 3n, status: Status.Denied, escrowOpen: true }),
  ];
  const r = plan(snap({ pleas, hook: { pendingRebalance: true, retainedImd: 2n * 10n ** 18n } }), emptyState(), cfg);
  assert.deepEqual(kinds(r), ['deliver:2', 'settleLetter:3', 'record:1', 'rebalance:0']);
  assert.ok(ORDER.indexOf('deliver') === 0);
});

test('alerts: low ETH, the Cabal clock at 9 h and 3 h, its death', () => {
  const low = alertsFor(snap({ keeper: { eth: 10n ** 15n } }), [], cfg);
  assert.equal(low[0].key, 'lowEth');
  const lv = now - (118_800n - 8n * 3600n); // 8 h left
  assert.match(alertsFor(snap({ gate: { lastVerdictAt: lv } }), [], cfg)[0].key, /^death9h:/);
  const lv3 = now - (118_800n - 2n * 3600n); // 2 h left
  assert.match(alertsFor(snap({ gate: { lastVerdictAt: lv3 } }), [], cfg)[0].key, /^death3h:/);
  assert.equal(alertsFor(snap({}), [], cfg).length, 0);
  const dead = alertsFor(snap({ gate: { alive: false, diedAt: now - 10n } }), [], cfg);
  assert.match(dead[0].key, /^dead:/);
  assert.equal(dead[0].once, true);
});
