import { Status, Ruling } from './abi.mjs';

// The planner is pure: a snapshot of the chain (read at one block) and the keeper's state in, the
// jobs to try out. Every job is simulated again before it is sent, so a job planned on a stale view
// costs at most one eth_call.

/** Jobs in the order they are tried. */
export const ORDER = [
  'deliver',
  'expireObjection',
  'settleObjection',
  'settleLetter',
  'expirePlea',
  'record',
  'closeSeason',
  'flush',
  'rebalance',
];

const APPROVED_LIKE = new Set([Status.Approved, Status.Executed, Status.Lapsed]);

export function seasonOf(snap, verdictAt) {
  return (verdictAt - snap.gate.startedAt) / snap.seasons.length;
}

/**
 * @returns {{ jobs: object[], done: { pleas: bigint[], objections: bigint[] }, notes: object[] }}
 *   `done` lists ids the keeper never needs to read again; `notes` are observations for alerts.
 */
export function plan(snap, state, cfg) {
  const now = snap.now;
  const jobs = [];
  const done = { pleas: [], objections: [] };
  const notes = [];
  const g = snap.gate;
  const slowAfter = BigInt(cfg.imdSlowMinutes * 60);

  for (const p of snap.pleas) {
    const st = p.status;
    if (st === Status.None) continue;
    const stale = now > p.submittedAt + g.pendingExpiry || p.intakeCompleted;
    const inWindow = st === Status.Approved && now <= p.verdictAt + g.executeWindow;
    const approvedLike = APPROVED_LIKE.has(st);
    let settling = false;

    if (st === Status.Pending) {
      if (stale) {
        jobs.push(p.escrowOpen ? job('settleLetter', p.id) : job('expirePlea', p.id));
        settling = p.escrowOpen;
      } else if (now - p.submittedAt >= slowAfter) {
        notes.push({ kind: 'imdSlow', what: 'plea', id: p.id, minutes: Number((now - p.submittedAt) / 60n) });
      }
    } else if (p.escrowOpen) {
      if (inWindow) {
        jobs.push(job('deliver', p.id, { urgent: true }));
      } else if (approvedLike || st === Status.Denied || st === Status.Expired) {
        jobs.push(job('settleLetter', p.id));
        settling = true;
      }
    }

    let seasonClosed = false;
    if (approvedLike) {
      const season = seasonOf(snap, p.verdictAt);
      seasonClosed = snap.seasons.closed[season.toString()] === true;
      const recordable = !p.recorded && !p.excluded && !p.sustained && !p.held && !seasonClosed;
      // A settle records a lapsed approval itself; a plea inside its window is still held.
      if (recordable && !settling && !inWindow) jobs.push(job('record', p.id));
    }

    const finalNoPoints = st === Status.Denied || st === Status.Expired;
    const finalPoints = approvedLike && (p.recorded || p.excluded || p.sustained || seasonClosed);
    if (!p.escrowOpen && (finalNoPoints || finalPoints)) done.pleas.push(p.id);
  }

  const tExpiry = snap.tribunal.pendingExpiry;
  for (const o of snap.objections) {
    if (o.ruling === Ruling.None) continue;
    if (o.ruling === Ruling.Pending) {
      if (now > o.filedAt + tExpiry || o.intakeCompleted) jobs.push(job('expireObjection', o.id));
      else if (now - o.filedAt >= slowAfter) {
        notes.push({ kind: 'imdSlow', what: 'objection', id: o.id, minutes: Number((now - o.filedAt) / 60n) });
      }
    } else if (!o.settled) {
      jobs.push(job('settleObjection', o.id));
    } else {
      done.objections.push(o.id);
    }
  }

  const s = snap.seasons;
  if (s.bounds.exists && s.bounds.ended && now >= s.bounds.end + s.closeGrace) {
    const ids = snap.pleas
      .filter((p) => APPROVED_LIKE.has(p.status) && !p.recorded && !p.excluded && !p.sustained)
      .filter((p) => seasonOf(snap, p.verdictAt) === s.nextToClose)
      .map((p) => p.id);
    jobs.push(job('closeSeason', s.nextToClose, { ids }));
  }

  if (s.finished && (s.pot > 0n || s.pleaBalance > 0n)) jobs.push(job('flush', 0n));

  const h = snap.hook;
  const due = state.lastRebalanceAt === undefined || now >= BigInt(state.lastRebalanceAt) + BigInt(cfg.rebalanceEverySeconds);
  if (h.seeded && h.pendingRebalance && due) {
    const reserve = h.retainedImd + h.retainClaims;
    const urgentWork = h.pleaInWall >= h.wallMinFill || h.pleaClaims > 0n;
    if (urgentWork || reserve >= cfg.rebalanceMinReserve) jobs.push(job('rebalance', 0n));
  }

  jobs.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { jobs, done, notes };
}

function job(kind, id, extra = {}) {
  return { kind, id, urgent: false, ...extra };
}

/** Alerts that follow from a snapshot alone (the executor adds send failures). */
export function alertsFor(snap, notes, cfg) {
  const out = [];
  const g = snap.gate;
  if (snap.keeper.eth < cfg.minEth) {
    out.push({ key: 'lowEth', text: `Keeper ETH is low: ${fmt(snap.keeper.eth)} ETH (alert below ${fmt(cfg.minEth)}).` });
  }
  for (const n of notes) {
    if (n.kind === 'imdSlow') {
      out.push({ key: `slow:${n.what}:${n.id}`, once: true, text: `IMD slow: ${n.what} #${n.id} has waited ${n.minutes} min with no answer.` });
    }
  }
  if (g.startedAt > 0n) {
    if (g.alive) {
      const left = g.lastVerdictAt + g.deadman - snap.now;
      if (left <= 3n * 3600n) {
        out.push({ key: `death3h:${g.lastVerdictAt}`, once: true, text: `The Cabal dies in ${hm(left)} without a new verdict (last verdict ${iso(g.lastVerdictAt)}).` });
      } else if (left <= 9n * 3600n) {
        out.push({ key: `death9h:${g.lastVerdictAt}`, once: true, text: `The Cabal dies in ${hm(left)} without a new verdict (last verdict ${iso(g.lastVerdictAt)}).` });
      }
    } else if (g.diedAt > 0n) {
      out.push({ key: `dead:${g.diedAt}`, once: true, text: `The Cabal died at ${iso(g.diedAt)}. PLEA trades freely now; the keeper keeps closing seasons and the wall.` });
    }
  }
  return out;
}

export function fmt(wei, decimals = 4) {
  const s = (Number(wei) / 1e18).toFixed(decimals);
  return s;
}

function hm(seconds) {
  const m = Number(seconds / 60n);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function iso(ts) {
  return new Date(Number(ts) * 1000).toISOString().replace('.000Z', 'Z');
}
