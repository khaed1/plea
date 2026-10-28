import {
  createPublicClient, http, encodeFunctionData, decodeFunctionResult, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gateAbi, letterboxAbi, tribunalAbi, seasonsAbi, hookAbi, multicall3Abi, MULTICALL3, allErrorsAbi } from './abi.mjs';
import { discover, snapshot } from './chain.mjs';
import { plan, alertsFor, fmt, iso } from './plan.mjs';
import { loadState, saveState, markDone, logAction } from './state.mjs';
import { makeAlerter } from './alerts.mjs';

export class Keeper {
  static async create(cfg, log, { client, sendClient } = {}) {
    const k = new Keeper();
    k.cfg = cfg;
    k.log = log;
    k.client = client ?? createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 2 }) });
    k.sendClient = sendClient ?? createPublicClient({ transport: http(cfg.sendRpcUrl, { retryCount: 0 }) });
    k.account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
    k.address = k.account?.address ?? cfg.keeperAddress;
    k.chainId = await k.client.getChainId();
    k.state = loadState(cfg.stateFile);
    k.alerter = makeAlerter(cfg, log);
    k.sys = null;
    k.nonce = undefined;
    log({ msg: 'keeper started', keeper: k.address, chainId: k.chainId, launch: cfg.launch, dryRun: cfg.dryRun });
    return k;
  }

  /** One pass: read, plan, send what is due, alert, save. */
  async tick() {
    if (!this.sys) {
      this.sys = await discover(this.client, this.cfg.launch);
      if (!this.sys) {
        this.log({ msg: 'trading not open yet (no hook, Letterbox or Tribunal, or not seeded); waiting' });
        return { jobs: [] };
      }
      this.log({ msg: 'system found', ...this.sys });
    }
    const snap = await snapshot(this.client, this.sys, this.address, this.state);
    const { jobs, done, notes } = plan(snap, this.state, this.cfg);
    markDone(this.state, done);
    await this.alerter.raise(this.state, alertsFor(snap, notes, this.cfg), Number(snap.now));
    const results = [];
    for (const j of jobs) {
      const r = await this.run(j, snap);
      results.push({ ...j, result: r });
      if (r === 'stop') break;
    }
    await this.summary(snap);
    this.pruneAlerts(snap.now);
    saveState(this.cfg.stateFile, this.state);
    return { snap, jobs: results };
  }

  call(j) {
    const s = this.sys;
    switch (j.kind) {
      case 'deliver': return { address: s.letterbox, abi: letterboxAbi, functionName: 'deliver', args: [j.id] };
      case 'settleLetter': return { address: s.letterbox, abi: letterboxAbi, functionName: 'settle', args: [j.id] };
      case 'expirePlea': return { address: s.gate, abi: gateAbi, functionName: 'expire', args: [j.id] };
      case 'expireObjection': return { address: s.tribunal, abi: tribunalAbi, functionName: 'expire', args: [j.id] };
      case 'settleObjection': return { address: s.tribunal, abi: tribunalAbi, functionName: 'settle', args: [j.id] };
      case 'record': return { address: s.seasons, abi: seasonsAbi, functionName: 'record', args: [j.id] };
      case 'closeSeason': return { address: s.seasons, abi: seasonsAbi, functionName: 'closeSeason', args: [j.ids] };
      case 'flush': return { address: s.seasons, abi: seasonsAbi, functionName: 'flushToWall', args: [] };
      case 'rebalance': return { address: s.hook, abi: hookAbi, functionName: 'rebalance', args: [] };
      default: throw new Error(`unknown job ${j.kind}`);
    }
  }

  /** @returns 'sent' | 'reverted' | 'skipped' | 'waiting' | 'dry' | 'stop' */
  async run(j, snap) {
    const c = this.call(j);
    const tag = { job: j.kind, id: j.id, ids: j.ids };
    const prio = j.urgent ? this.cfg.urgentPriority : this.cfg.priority;
    const cap = j.urgent ? this.cfg.urgentMaxFee : this.cfg.maxFee;
    if (snap.baseFee + prio > cap) {
      this.log({ msg: 'gas above the cap; waiting', ...tag, baseFee: snap.baseFee, cap });
      return 'waiting';
    }
    const maxFeePerGas = minBig(cap, 2n * snap.baseFee + prio);

    if (j.kind === 'rebalance') {
      this.state.lastRebalanceAt = snap.now.toString();
      const w = await this.rebalanceWork();
      if (!w.work) {
        this.log({ msg: 'rebalance would do no real work; next cycle', ...tag, ...w });
        return 'skipped';
      }
    }

    let gas;
    try {
      // The other contracts' errors too: a settle's revert may come from the gate it calls.
      const withErrors = { ...c, abi: [...c.abi, ...allErrorsAbi] };
      await this.client.simulateContract({ ...withErrors, account: this.address });
      gas = await this.client.estimateContractGas({ ...withErrors, account: this.address });
    } catch (e) {
      this.log({ level: 'debug', msg: 'simulation refused; skipped', ...tag, reason: reason(e) });
      return 'skipped';
    }
    gas = (gas * BigInt(Math.round(this.cfg.gasMultiplier * 100))) / 100n;
    if (this.cfg.dryRun) {
      this.log({ msg: 'DRY RUN: would send', ...tag, gas, maxFeePerGas });
      return 'dry';
    }

    if (this.nonce === undefined) this.nonce = await this.client.getTransactionCount({ address: this.address, blockTag: 'latest' });
    const nonce = this.nonce;
    const serializedTransaction = await this.account.signTransaction({
      chainId: this.chainId, type: 'eip1559', to: c.address, data: encodeFunctionData(c), value: 0n,
      gas, maxFeePerGas, maxPriorityFeePerGas: prio, nonce,
    });
    let hash;
    try {
      hash = await this.sendClient.sendRawTransaction({ serializedTransaction });
    } catch (e) {
      this.log({ level: 'warn', msg: 'send refused', ...tag, reason: reason(e) });
      this.nonce = undefined;
      return 'stop';
    }
    this.log({ msg: 'sent', ...tag, hash, nonce, gas, maxFeePerGas });

    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: this.cfg.receiptTimeoutSeconds * 1000, pollingInterval: 2000 });
    } catch {
      const latest = await this.client.getTransactionCount({ address: this.address, blockTag: 'latest' });
      this.nonce = latest;
      if (latest > nonce) receipt = await this.client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) {
        await this.alerter.raise(this.state, [{ key: `notIncluded:${j.kind}:${j.id}`, once: true, text: `${j.kind} #${j.id} was not included within ${this.cfg.receiptTimeoutSeconds} s (tx ${hash}); it will be tried again.` }], Number(snap.now));
        return 'stop';
      }
    }
    this.nonce = nonce + 1;
    if (receipt.status !== 'success') {
      await this.alerter.raise(this.state, [{ key: `reverted:${j.kind}:${j.id}`, once: true, text: `${j.kind} #${j.id} reverted on chain (tx ${hash}).` }], Number(snap.now));
      this.log({ level: 'warn', msg: 'reverted', ...tag, hash });
      return 'reverted';
    }
    logAction(this.state, snap.now, { kind: j.kind, id: j.id.toString(), hash, gasUsed: receipt.gasUsed.toString(), fee: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
    this.log({ msg: 'done', ...tag, hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    if (j.kind === 'closeSeason') await this.alerter.send(`season ${j.id} closed (tx ${hash}).`);
    return 'sent';
  }

  /**
   * Rule 1 of the rebalance rules: simulate `rebalance()` with the hook's views before and after it,
   * in one Multicall3 eth_call, and call it real work only if the wall moved, the reserve fell or
   * the PLEA claims fell.
   */
  async rebalanceWork() {
    const h = this.sys.hook;
    const views = ['wall', 'retainedImd', 'retainClaims', 'pleaClaims'];
    const view = (fn) => ({ target: h, allowFailure: true, callData: encodeFunctionData({ abi: hookAbi, functionName: fn }) });
    const calls = [...views.map(view), { target: h, allowFailure: true, callData: encodeFunctionData({ abi: hookAbi, functionName: 'rebalance' }) }, ...views.map(view)];
    const { data } = await this.client.call({ to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }) });
    const res = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data });
    const read = (i, fn) => decodeFunctionResult({ abi: hookAbi, functionName: fn, data: res[i].returnData });
    const [wb, rb, cb, pb] = views.map((fn, i) => read(i, fn));
    const ok = res[4].success;
    if (!ok) return { work: false, simulated: 'reverted' };
    const [wa, ra, ca, pa] = views.map((fn, i) => read(5 + i, fn));
    const wallMoved = wb[0] !== wa[0] || wb[1] !== wa[1] || wb[2] !== wa[2];
    const reserveFell = ra + ca < rb + cb;
    const claimsFell = pa < pb;
    return { work: wallMoved || reserveFell || claimsFell, wallMoved, reserveFell, claimsFell };
  }

  async summary(snap) {
    const now = new Date(Number(snap.now) * 1000);
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== this.cfg.summaryUtcHour || this.state.lastSummaryDay === day) return;
    this.state.lastSummaryDay = day;
    const counts = {};
    let feeWei = 0n;
    for (const a of this.state.actions) {
      counts[a.kind] = (counts[a.kind] ?? 0) + 1;
      feeWei += BigInt(a.fee ?? 0);
    }
    const did = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
    const g = snap.gate;
    const clock = g.alive ? `the Cabal dies ${iso(g.lastVerdictAt + g.deadman)} without a new verdict` : g.diedAt > 0n ? `the Cabal died ${iso(g.diedAt)}` : 'trading not open';
    const b = snap.seasons.bounds;
    const close = b.exists ? `season ${snap.seasons.nextToClose} closable from ${iso(b.end + snap.seasons.closeGrace)}` : snap.seasons.finished ? 'all seasons closed' : 'no season running';
    const open = snap.pleas.filter((p) => p.status === 1).length;
    await this.alerter.send(
      `daily summary. Last 24 h: ${did}; gas ${fmt(feeWei, 5)} ETH; tips earned ${(counts.deliver ?? 0) * 0.25} IMD. `
      + `Keeper holds ${fmt(snap.keeper.eth)} ETH and ${fmt(snap.keeper.imd)} IMD. Pending pleas ${open}. ${close}; ${clock}.`,
    );
  }

  pruneAlerts(now) {
    const cutoff = Number(now) - 30 * 86_400;
    for (const [k, t] of Object.entries(this.state.alerts)) if (t < cutoff) delete this.state.alerts[k];
  }
}

function minBig(a, b) {
  return a < b ? a : b;
}

/** A readable reason for a refused simulation: the custom error's name when there is one. */
export function reason(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e?.message ?? e);
}

