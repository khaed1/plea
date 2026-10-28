import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// What the keeper remembers between runs: ids it never needs to read again, when it last tried a
// rebalance, when it last sent each alert, and a 24-hour log of what it did. Losing the file is
// harmless: the keeper re-reads every id once and may repeat an alert.

export function emptyState() {
  return { done: { pleas: [], objections: [] }, lastRebalanceAt: undefined, alerts: {}, actions: [], lastSummaryDay: undefined };
}

export function loadState(path) {
  if (!existsSync(path)) return emptyState();
  const s = JSON.parse(readFileSync(path, 'utf8'));
  return { ...emptyState(), ...s, done: { ...emptyState().done, ...(s.done ?? {}) } };
}

export function saveState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

export function markDone(state, done) {
  const add = (list, ids) => {
    const have = new Set(list);
    for (const id of ids) if (!have.has(id.toString())) list.push(id.toString());
  };
  add(state.done.pleas, done.pleas);
  add(state.done.objections, done.objections);
}

/** Keeps the last 24 hours (block time) of the action log. */
export function logAction(state, now, entry) {
  state.actions.push({ t: Number(now), ...entry });
  const cutoff = Number(now) - 86_400;
  state.actions = state.actions.filter((a) => a.t >= cutoff);
}
