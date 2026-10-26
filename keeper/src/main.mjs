import { loadConfig } from './config.mjs';
import { Keeper, reason } from './keeper.mjs';

// The service loop. `--once` runs a single pass and exits (for checks and cron).

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const cfg = loadConfig();
const keeper = await Keeper.create(cfg, log);
const once = process.argv.includes('--once');

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log({ msg: `${sig}: stopping after this pass` });
    stopping = true;
  });
}

let failingSince;
while (!stopping) {
  try {
    await keeper.tick();
    failingSince = undefined;
  } catch (e) {
    log({ level: 'error', msg: 'pass failed', reason: reason(e) });
    failingSince ??= Date.now();
    if (Date.now() - failingSince > 5 * 60_000) {
      const now = Math.floor(Date.now() / 1000);
      await keeper.alerter.raise(keeper.state, [{ key: 'rpc', text: `the keeper's passes have failed for ${Math.round((Date.now() - failingSince) / 60_000)} min: ${reason(e)}` }], now);
    }
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
}
