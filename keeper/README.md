# PLEA keeper

A small Node.js service that does PLEA's upkeep. Every call it makes is open to anyone
(`THREAT-MODEL.md`, "Runners and keepers"): the keeper holds no power, nothing depends on it being
honest, and anyone may run one. If it stops, nothing is lost or stolen; letters wait to be settled,
points wait to be recorded and seasons wait to be closed until someone does it.

It reads everything from the chain, starting from one address (`PleaLaunch`), and decides with the
latest block's timestamp, never the machine's clock. Every send is simulated first and is skipped if
the simulation fails. One transaction is in flight at a time.

## What it does

Checked every `POLL_SECONDS` (default 12), in this order:

| Job | When | Call | Why |
|---|---|---|---|
| Deliver | An approved letter or site auto-sell plea is still in its 7-minute window (`verdictAt + 7 min`) and its escrow is open | `Letterbox.deliver(id)` | Sells for the writer; the runner earns the 0.25 IMD tip. Urgent: after the window the sale is gone |
| Expire an objection | Pending, and 20 minutes since `filedAt` or the Intake completed it without a ruling | `Tribunal.expire(id)` | Voids it so the stake can go back (a stale objection no longer holds its plea) |
| Settle an objection | Sustained, overruled or void, not yet settled | `Tribunal.settle(id)` | Pays the 0.35 IMD stake: to the objector (sustained, void) or the plea's season pot (overruled) |
| Settle a letter | Its escrow is open and the plea is denied or expired, an approval whose window has passed, or pending and stale | `Letterbox.settle(id)` | PLEA and tip back to the writer; a lapsed approval is recorded first; a stale pending plea is expired inside |
| Expire a hand plea | Pending, no escrow, and 20 minutes since `submittedAt` or the Intake completed it without a verdict | `CabalGate.expire(id)` | Frees the seller (no cooldown, no verdict, no clock reset); a late answer would revert `TooLate` anyway |
| Record | Approved (also executed or lapsed), not recorded, seller not excluded, `Tribunal.standing` not held and not sustained, its season not closed | `Seasons.record(id)` | Points count only once recorded, and the seat's 1.2× is read at this moment |
| Close a season | `seasonBounds(nextToClose)` has ended and `CLOSE_GRACE` (1 hour) has passed | `Seasons.closeSeason(ids)` with every unrecorded approval of that season | Pays the prizes and the PLEA bonus; the id list records what is still unrecorded (a close with an empty list drops those points) |
| Flush | `Seasons.finished()` (the Cabal is dead and its last season closed) and Seasons still holds IMD or PLEA | `Seasons.flushToWall()` | Sends the leftover pot to the buy wall and burns unpaid bonus PLEA |
| Rebalance | Every `REBALANCE_EVERY_SECONDS` (default 600), when `pendingRebalance()` is true | `PleaHook.rebalance()` | Settles and redeploys the buy wall (rules below) |

Not its job: `seed` (PLEA's owner opens trading), the launch deployments, the distributor's root and
claims, pleas, letters and objections themselves.

### Rebalance rules (One Dollar Audit 1018; `THREAT-MODEL.md` "`pendingRebalance()` is a hint")

1. `pendingRebalance()` is only a hint. The keeper simulates `rebalance()` through Multicall3 together
   with the hook's views read after it, and sends only when the call succeeds **and does real work**:
   the wall changed (`wall()` ticks or liquidity), the reserve (`retainedImd + retainClaims`) fell, or
   `pleaClaims()` fell.
2. So a rebalance whose only work is PLEA claims while the PoolManager holds less PLEA than
   `pleaClaims` (a nearly bought-out market after the death) is not sent: it would succeed but burn
   nothing (the claim is re-minted).
3. A send that still reverts (`RebalanceNotNeeded`: a buy lifted the price out of the wall's band
   first) is not retried until the next rebalance cycle.
4. Gas: a rebalance for the reserve alone waits until the reserve reaches `REBALANCE_MIN_RESERVE_IMD`
   (default 1, the hook's own `WALL_THRESHOLD`; the reserve only grows while it waits). A wall that
   has bought 1,000 PLEA or more (`pleaInWall() >= WALL_MIN_FILL`) or outstanding `pleaClaims` is
   settled at the next cycle whatever the reserve.

## Alerts (Telegram)

Only real problems, each at most once per `ALERT_REPEAT_HOURS` (default 6), plus one daily summary:

- the keeper's ETH below `MIN_ETH` (default 0.01);
- a send that reverted on chain or was not included within 3 minutes;
- the read RPC failing for 5 minutes;
- IMD slow: a plea or objection waiting more than `IMD_SLOW_MINUTES` (default 5) with the Intake
  not completed;
- the Cabal's clock: 9 hours and 3 hours before it would die (`lastVerdictAt + DEADMAN`), and its death;
- daily at `SUMMARY_UTC_HOUR` (default 8): what it did in the last 24 hours, tips earned, balances,
  open items, the next season close.

Without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` everything goes to the log only.

## Sending

- Reads go to `RPC_URL`; sends go to `SEND_RPC_URL`. On mainnet use a private relay
  (Flashbots Protect, `https://rpc.flashbots.net/fast`): nobody can copy a delivery from the public
  mempool to take its tip, and a transaction that would revert is not included, so it costs nothing.
- Gas limit = estimate × 1.25. Max fee = 2 × base fee + priority fee, capped at `MAX_FEE_GWEI`
  (default 10) for normal jobs and `URGENT_MAX_FEE_GWEI` (default 50) for deliveries; above its cap
  a job waits.
- `DRY_RUN=1` simulates and logs every job and sends nothing. Run it first.

## Configuration

Environment variables (see `.env.example`); the key is read only from `KEEPER_PRIVATE_KEY`.

| Variable | Default | |
|---|---|---|
| `RPC_URL` | (required) | Read RPC |
| `SEND_RPC_URL` | `RPC_URL` | Send RPC (a private relay on mainnet) |
| `LAUNCH` | (required) | The `PleaLaunch` address; everything else is read from it |
| `KEEPER_PRIVATE_KEY` | (required unless `DRY_RUN=1`) | The keeper's own wallet, holding only gas money |
| `STATE_FILE` | `./keeper-state.json` | What is already done, alert times, stats |
| `DRY_RUN` | `0` | `1`: simulate and log only |
| `POLL_SECONDS` | `12` | |
| `REBALANCE_EVERY_SECONDS` | `600` | |
| `REBALANCE_MIN_RESERVE_IMD` | `1` | |
| `MAX_FEE_GWEI` / `URGENT_MAX_FEE_GWEI` | `10` / `50` | |
| `PRIORITY_GWEI` / `URGENT_PRIORITY_GWEI` | `0.05` / `0.5` | |
| `MIN_ETH` | `0.01` | |
| `IMD_SLOW_MINUTES` | `5` | |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | (none) | |
| `ALERT_REPEAT_HOURS` | `6` | |
| `SUMMARY_UTC_HOUR` | `8` | |

## Running

```
cd keeper
npm ci
cp .env.example .env    # fill it in; chmod 600 .env
DRY_RUN=1 node --env-file=.env src/main.mjs
node --env-file=.env src/main.mjs
```

`keeper.service` is a systemd unit for a VPS. `npm test` runs the planner's unit tests;
`rehearsal/` replays every job on a local fork of Ethereum (needs Foundry, see its README).
