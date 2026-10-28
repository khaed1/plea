# Keeper rehearsal

`run.mjs` starts anvil on a fork of Ethereum, deploys PLEA from this repo's build (the five launch
contracts in one block, then the Letterbox, the Tribunal and the hook with a mined salt) with a
test oracle signer, and drives every keeper job against the real Intake v2 (IMD's writer is
impersonated on the fork to deliver verdicts signed by the test key), IMD, PoolManager, imd/acc's
Stacker and the seat NFT. Test wallets are funded from an IMD holder impersonated on the fork. Nothing
is sent to a real chain.

```
FOUNDRY_PROFILE=full forge build      # at the repo root (the build of the branch to rehearse)
cd keeper && npm ci
node rehearsal/run.mjs                # FORK_URL (default publicnode), ARTIFACTS (default ../out), ANVIL_PORT (8546)
```

On chain id 1, `seed` refuses a Sepolia build (5,700 IMD market cap): rehearse the `mainnet`
branch's build, e.g. `ARTIFACTS=/path/to/mainnet/out`.

What it checks, in order (it stops at the first failure):

1. Before trading opens the keeper only waits.
2. The seed, the opening buy and a launch-window buy fill the wall's reserve: one rebalance, a wall
   deployed, none again inside the cycle.
3. An approved letter: a dry run would deliver and sends nothing; the keeper delivers it inside the
   window, earns the 0.25 IMD tip, and records it only after the 20-minute hold.
4. A denied letter is settled (PLEA and tip back).
5. A letter IMD never answers is settled after 20 minutes, not before.
6. A hand plea IMD never answers is expired after 20 minutes.
7. A sold hand approval with a sustained objection: the stake is settled back, the plea never recorded.
8. An objection IMD never answers: expired, its stake settled, the plea recorded.
9. An overruled objection: the stake settled to the pot, the plea recorded (90 points for one wallet).
10. A site auto-sell plea: delivered, the seller paid, the 0.35 IMD fee in the pot, recorded; a letter
    IMD reports as failed is settled at once; an answer whose delivery reverts (bad signature): the
    Intake closes the request and the keeper expires the plea without waiting 20 minutes; a denied
    plea a day keeps the Cabal alive to the end of season 0, which the keeper closes an hour after it
    ends, paying the 90-point wallet.
11. The death: the last season closed, `flushToWall`, the wall rebuilt; none of the keeper's
    transactions reverted; the death alerted.
