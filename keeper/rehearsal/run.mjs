// The keeper's rehearsal on a local fork of Ethereum (anvil): the real Intake v2, IMD, PoolManager,
// imd/acc's Stacker and the seat NFT, our contracts deployed from the repo's build with a test oracle
// signer, IMD's writer impersonated to deliver verdicts signed by that key. Every keeper job is
// driven and checked. Nothing leaves the fork.
//
//   FOUNDRY_PROFILE=full forge build     # at the repo root: ./out with the contracts and test/utils/Mocks.sol
//   cd keeper && node rehearsal/run.mjs  # FORK_URL (default publicnode), ARTIFACTS (default ../out)

import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  createPublicClient, createWalletClient, http, parseEther, encodeAbiParameters, keccak256, toHex, stringToHex,
  getContractAddress, concat, padHex, parseAbi, formatEther,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { Keeper } from '../src/keeper.mjs';
import { loadConfig } from '../src/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(process.env.ARTIFACTS ?? join(here, '../../out'));
const FORK_URL = process.env.FORK_URL ?? 'https://ethereum-rpc.publicnode.com';
const PORT = Number(process.env.ANVIL_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;

const INTAKE = '0xa43e6F75ee006411F79Ac1C84120606C2330DE82';
const WRITER = '0x3d3C0Df7C1a17d384545e9D7C8228897bD9625CB';
const IMD = '0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7';
const PM = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const STACKER = '0x06909f672301f28a810f78cfe7a754851269f4f0';
const SEAT = '0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D';
const WHALE = '0xE54d6571aCa515614927F3A70B8957c2B511603C'; // an IMD holder, impersonated on the fork only
const SEASON = 15n * 86_400n;
const DEADMAN = 118_800n;
const SIGNER_KEY = padHex('0xa11ce', { size: 32 });

// anvil's default accounts: 0 owner, 1-5 players, 9 keeper.
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];
const KEEPER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

const art = (file, name = file) => JSON.parse(readFileSync(join(ARTIFACTS, `${file}.sol`, `${name}.json`), 'utf8'));
const A = {
  PLEA: art('PLEA'), CabalGate: art('CabalGate'), Seasons: art('Seasons'), PleaDistributor: art('PleaDistributor'),
  PleaLaunch: art('PleaLaunch'), Letterbox: art('Letterbox'), Tribunal: art('Tribunal'), PleaHook: art('PleaHook'),
  BuyRouter: art('Mocks', 'BuyRouter'),
};
const code = (a) => a.bytecode.object;
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)']);
const intakeAbi = parseAbi(['function complete(bytes32 requestId, uint8 status, bytes32 resultHash, string uri, bytes args)']);

const pub = createPublicClient({ transport: http(RPC), chain: mainnet });
const rpc = (method, params = []) => pub.request({ method, params });
const wallet = (key) => createWalletClient({ account: privateKeyToAccount(key), transport: http(RPC), chain: mainnet });
const W = KEYS.map(wallet);
const owner = W[0];
const players = W.slice(1);
const keeperAccount = privateKeyToAccount(KEEPER_KEY);

let pass = 0;
const ok = (cond, what) => {
  assert.ok(cond, what);
  pass++;
  console.log(`  ✓ ${what}`);
};

async function startAnvil() {
  const a = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--silent', '--no-storage-caching', '--gas-limit', '200000000'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      await pub.getBlockNumber();
      return a;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('anvil did not start');
}

async function send(w, address, abi, functionName, args = []) {
  const hash = await w.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
async function warp(seconds) {
  await rpc('evm_increaseTime', [Number(seconds)]);
  await rpc('evm_mine');
}
const now = async () => (await pub.getBlock()).timestamp;

async function impersonated(addr) {
  await rpc('anvil_impersonateAccount', [addr]);
  await rpc('anvil_setBalance', [addr, toHex(parseEther('10'))]);
  return createWalletClient({ account: addr, transport: http(RPC), chain: mainnet });
}

async function deploy() {
  const d = owner;
  const [o] = [d.account.address];
  const n0 = await pub.getTransactionCount({ address: o });
  const at = (i) => getContractAddress({ from: o, nonce: BigInt(n0 + i) });
  const [plea, gate, seasons, distributor, launch] = [0, 1, 2, 3, 4].map(at);
  const now0 = await now();
  // PLEA.setLauncher must run in PLEA's deploy block: send the five launch transactions into one block.
  await rpc('evm_setAutomine', [false]);
  const tx = [
    [A.PLEA, [o]],
    [A.CabalGate, [plea, INTAKE, IMD, IMD, privateKeyToAccount(SIGNER_KEY).address, SEASON, DEADMAN]],
    [A.Seasons, [plea, gate, IMD, SEAT]],
    [A.PleaDistributor, [plea, o]],
    [A.PleaLaunch, [plea, gate, seasons, distributor, PM, IMD, STACKER, 400_000n, now0 + 7n * 86_400n, IMD, false,
      keccak256(code(A.Letterbox)), keccak256(code(A.Tribunal))]],
  ];
  const hashes = [];
  for (const [i, [a, args]] of tx.entries()) {
    hashes.push(await d.deployContract({ abi: a.abi, bytecode: code(a), args, nonce: n0 + i, gas: 15_000_000n }));
  }
  await rpc('evm_mine');
  await rpc('evm_setAutomine', [true]);
  for (const h of hashes) assert.equal((await pub.getTransactionReceipt({ hash: h })).status, 'success');
  await send(d, launch, A.PleaLaunch.abi, 'deployLetterbox', [code(A.Letterbox)]);
  await send(d, launch, A.PleaLaunch.abi, 'deployTribunal', [code(A.Tribunal)]);
  const initCode = concat([code(A.PleaHook), encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [PM, plea, IMD, STACKER, o, seasons, 400_000n],
  )]);
  const want = await read(launch, A.PleaLaunch.abi, 'hookInitCodeHash');
  assert.equal(keccak256(initCode), want, 'hook init code');
  const flags = BigInt(await read(launch, A.PleaLaunch.abi, 'FLAGS'));
  let salt = 0n;
  for (;; salt++) {
    const addr = getContractAddress({ opcode: 'CREATE2', from: launch, salt: padHex(toHex(salt), { size: 32 }), bytecodeHash: want });
    if ((BigInt(addr) & 0x3fffn) === flags) break;
  }
  await send(d, launch, A.PleaLaunch.abi, 'deployHook', [padHex(toHex(salt), { size: 32 }), initCode]);
  const sys = {
    plea, gate, seasons, distributor, launch,
    hook: await read(launch, A.PleaLaunch.abi, 'hook'),
    letterbox: await read(launch, A.PleaLaunch.abi, 'letterbox'),
    tribunal: await read(launch, A.PleaLaunch.abi, 'tribunal'),
  };
  const router = await d.deployContract({ abi: A.BuyRouter.abi, bytecode: code(A.BuyRouter), args: [PM, sys.hook, IMD, plea] });
  sys.router = (await pub.waitForTransactionReceipt({ hash: router })).contractAddress;
  return sys;
}

async function main() {
  const anvil = await startAnvil();
  const logs = [];
  try {
    console.log(`fork of Ethereum at block ${await pub.getBlockNumber()}, artifacts ${ARTIFACTS}`);
    const whale = await impersonated(WHALE);
    const writer = await impersonated(WRITER);
    for (const w of [owner, ...players]) await send(whale, IMD, erc20, 'transfer', [w.account.address, parseEther('300')]);
    await rpc('anvil_setBalance', [keeperAccount.address, toHex(parseEther('1'))]);

    const S = await deploy();
    console.log('deployed:', JSON.stringify(S));
    for (const w of [owner, ...players]) {
      for (const spender of [S.router, S.gate, S.tribunal]) await send(w, IMD, erc20, 'approve', [spender, 2n ** 255n]);
      await send(w, S.plea, erc20, 'approve', [S.gate, 2n ** 255n]);
    }

    const stateFile = join(mkdtempSync(join(tmpdir(), 'plea-keeper-')), 'state.json');
    const env = { RPC_URL: RPC, LAUNCH: S.launch, KEEPER_PRIVATE_KEY: KEEPER_KEY, STATE_FILE: stateFile, MAX_FEE_GWEI: '100', URGENT_MAX_FEE_GWEI: '100', RECEIPT_TIMEOUT_SECONDS: '30' };
    const log = (o) => logs.push(o);
    const keeper = await Keeper.create(loadConfig(env), log);
    const tick = async () => {
      const r = await keeper.tick();
      const sent = r.jobs.filter((j) => j.result === 'sent').map((j) => `${j.kind}:${j.id}`);
      const other = r.jobs.filter((j) => j.result !== 'sent').map((j) => `${j.kind}:${j.id}=${j.result}`);
      console.log(`    keeper: sent [${sent.join(', ')}]${other.length ? ` other [${other.join(', ')}]` : ''}`);
      return sent;
    };
    const keeperImd = () => read(IMD, erc20, 'balanceOf', [keeperAccount.address]);
    const G = (fn, args) => read(S.gate, A.CabalGate.abi, fn, args);
    const SE = (fn, args) => read(S.seasons, A.Seasons.abi, fn, args);
    const buy = (w, imd) => send(w, S.router, A.BuyRouter.abi, 'buyExactIn', [parseEther(imd), encodeAbiParameters([{ type: 'address' }], [w.account.address])]);
    let nonce = 0n;
    const attest = (score) => {
      nonce++;
      return {
        requestId: keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['keeper rehearsal', nonce])),
        chainId: 1n, questionHash: keccak256(stringToHex('q')), answerType: 3, answer: encodeAbiParameters([{ type: 'uint256' }], [BigInt(score)]),
        figure: BigInt(score), fromBlock: 1n, toBlock: 2n, blockHash: keccak256(stringToHex('b')),
        panelJobId: keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['job', nonce])),
        panelSize: 30, quorum: 17, agreed: 20,
      };
    };
    const attType = A.CabalGate.abi.find((x) => x.name === 'onOracleResult').inputs[1];
    const answerTo = async (consumer, abi, rid, score) => {
      const t = await now();
      const a = { ...attest(score), issuedAt: t, expiresAt: t + 3600n };
      const digest = await read(consumer, abi, 'attestationDigest', [a]);
      const sig = await sign({ hash: digest, privateKey: SIGNER_KEY, to: 'hex' });
      const args = encodeAbiParameters([{ type: 'bytes32' }, attType, { type: 'bytes' }], [rid, a, sig]);
      await send(writer, INTAKE, intakeAbi, 'complete', [rid, 0, keccak256(stringToHex('attestation')), 'uri', args]);
    };
    const answer = async (id, score) => answerTo(S.gate, A.CabalGate.abi, (await G('getPlea', [id])).intakeId, score);
    const answerObjection = async (id, score) => answerTo(S.tribunal, A.Tribunal.abi, (await read(S.tribunal, A.Tribunal.abi, 'objection', [id])).intakeId, score);
    const letter = async (w, text) => {
      const hash = await w.sendTransaction({ to: S.letterbox, data: stringToHex(text), gas: 3_000_000n });
      assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success', 'letter');
      return G('lastPleaOf', [w.account.address]);
    };
    const handPlea = async (w, share = 10n) => {
      const bal = await read(S.plea, erc20, 'balanceOf', [w.account.address]);
      await send(w, S.gate, A.CabalGate.abi, 'submitSell', [bal * share / 100n, 'I bought early and need the IMD for gas this week; I keep the rest.']);
      return G('lastPleaOf', [w.account.address]);
    };
    const object = async (w, pleaId) => {
      await send(w, S.tribunal, A.Tribunal.abi, 'object', [pleaId, 'The plea says nothing specific about the seller.']);
      return (await read(S.tribunal, A.Tribunal.abi, 'nextId')) - 1n;
    };
    const status = async (id) => (await G('getPlea', [id])).status;
    const [p1, p2, p3, p4, p5] = players;

    console.log('\n1. Before trading opens: the keeper waits');
    ok((await keeper.tick()).jobs.length === 0, 'no jobs before the seed');

    console.log('\n2. Seed, the opening buy, a launch-window buy: the wall reserve is worth a rebalance');
    await send(owner, S.launch, A.PleaLaunch.abi, 'seed');
    await buy(owner, '2');
    await buy(p5, '6');
    ok(await read(S.hook, A.PleaHook.abi, 'pendingRebalance'), 'pendingRebalance() is true');
    ok((await tick()).includes('rebalance:0'), 'the keeper rebalances');
    ok((await read(S.hook, A.PleaHook.abi, 'wall'))[2] > 0n, 'a buy wall is deployed');
    ok((await tick()).length === 0, 'and does not rebalance again inside the cycle');

    await warp(91 * 60);
    for (const w of [p1, p2, p3, p4]) await buy(w, '100');
    await warp(86_400);

    console.log('\n3. A letter approved: delivered inside the window (dry run first), recorded after the hold');
    const L1 = await letter(p1, 'I have held a day, I am at a loss and I need the IMD to pay for my seat. I keep most of my PLEA.');
    ok(!(await tick()).some((j) => j.endsWith(`:${L1}`)), 'nothing to do while it is pending');
    await answer(L1, 45);
    const dry = await Keeper.create(loadConfig({ ...env, DRY_RUN: '1', STATE_FILE: `${stateFile}.dry` }), () => {});
    const nonceBefore = await pub.getTransactionCount({ address: keeperAccount.address });
    const dr = await dry.tick();
    ok(dr.jobs.some((j) => j.kind === 'deliver' && j.result === 'dry'), 'a dry run would deliver');
    ok(await pub.getTransactionCount({ address: keeperAccount.address }) === nonceBefore, 'and sends nothing');
    const tip0 = await keeperImd();
    ok((await tick()).includes(`deliver:${L1}`), 'the keeper delivers the approved letter');
    ok((await keeperImd()) - tip0 === parseEther('0.25'), 'and earns the 0.25 IMD tip');
    ok((await status(L1)) === 4, 'the plea is executed');
    ok(!(await tick()).includes(`record:${L1}`), 'no record during the 20-minute hold');
    await warp(21 * 60);
    ok((await tick()).includes(`record:${L1}`), 'recorded after the hold');
    ok(await SE('recorded', [L1]), 'Seasons.recorded is true');

    console.log('\n4. A letter denied: settled (PLEA and tip back)');
    const L2 = await letter(p2, 'I would like to sell a fifth of my PLEA to pay my rent this month.');
    await answer(L2, 0);
    const p2Before = await read(S.plea, erc20, 'balanceOf', [p2.account.address]);
    ok((await tick()).includes(`settleLetter:${L2}`), 'the keeper settles the denied letter');
    ok((await read(S.plea, erc20, 'balanceOf', [p2.account.address])) > p2Before, "the writer's PLEA is back");

    console.log('\n5. A letter IMD never answers: settled after 20 minutes');
    const L3 = await letter(p3, 'A third letter that the panel will never answer in this rehearsal.');
    await warp(19 * 60);
    ok(!(await tick()).includes(`settleLetter:${L3}`), 'not before 20 minutes');
    await warp(2 * 60);
    ok((await tick()).includes(`settleLetter:${L3}`), 'settled after 20 minutes');
    ok((await status(L3)) === 6, 'the plea is expired');

    console.log('\n6. A hand plea IMD never answers: expired after 20 minutes');
    const H1 = await handPlea(p4);
    await warp(21 * 60);
    ok((await tick()).includes(`expirePlea:${H1}`), 'the keeper expires it');

    console.log('\n7. A hand approval sold, an objection SUSTAINED: the stake goes back, no points');
    const H2 = await handPlea(p4);
    await answer(H2, 45);
    await send(p4, S.gate, A.CabalGate.abi, 'executeSell', [0n]);
    const O1 = await object(p1, H2);
    await answerObjection(O1, 0);
    ok((await tick()).includes(`settleObjection:${O1}`), 'the keeper settles the sustained objection');
    await warp(21 * 60);
    ok(!(await tick()).includes(`record:${H2}`), 'and never records the sustained plea');

    console.log('\n8. An objection IMD never answers: expired, its stake settled, the plea recorded');
    await warp(4 * 3600); // p2's cooldown after its denial
    const H3 = await handPlea(p2);
    await answer(H3, 45);
    await send(p2, S.gate, A.CabalGate.abi, 'executeSell', [0n]);
    const O2 = await object(p3, H3);
    await warp(21 * 60);
    const t8 = [...(await tick()), ...(await tick())];
    ok(t8.includes(`expireObjection:${O2}`), 'the stale objection is expired');
    ok(t8.includes(`settleObjection:${O2}`), 'its stake is settled');
    ok(t8.includes(`record:${H3}`), 'and the plea is recorded');

    console.log('\n9. An objection OVERRULED: the stake goes to the season pot; p1 reaches 90 points');
    const H4 = await handPlea(p1);
    await answer(H4, 45);
    await send(p1, S.gate, A.CabalGate.abi, 'executeSell', [0n]);
    const O3 = await object(p4, H4);
    await answerObjection(O3, 45);
    ok((await tick()).includes(`settleObjection:${O3}`), 'the keeper settles the overruled objection');
    await warp(21 * 60);
    ok((await tick()).includes(`record:${H4}`), 'and records the plea');

    console.log('\n10a. A site auto-sell plea approved: delivered, the 0.35 IMD fee to the pot, recorded');
    const p3Imd = await read(IMD, erc20, 'balanceOf', [p3.account.address]);
    const p3Bal = await read(S.plea, erc20, 'balanceOf', [p3.account.address]);
    await send(p3, S.letterbox, A.Letterbox.abi, 'plead', [p3Bal / 10n, 'I need some IMD for my seat this week and keep the rest of my PLEA.']);
    const B1 = await G('lastPleaOf', [p3.account.address]);
    await answer(B1, 45);
    const pot0 = await SE('pot');
    ok((await tick()).includes(`deliver:${B1}`), 'the keeper delivers the site plea');
    ok((await read(IMD, erc20, 'balanceOf', [p3.account.address])) > p3Imd, 'the seller is paid');
    ok((await SE('pot')) - pot0 >= parseEther('0.35'), 'the 0.35 IMD auto-sell fee reached the season pot');
    await warp(21 * 60);
    ok((await tick()).includes(`record:${B1}`), 'and it is recorded after the hold');

    console.log('\n10b. A letter IMD reports as failed (onPleaFailure): settled');
    const L4 = await letter(p4, 'A letter whose panel will disagree in this rehearsal; I keep the rest.');
    const rid = (await G('getPlea', [L4])).intakeId;
    const failArgs = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'bytes' }],
      [rid, 2, stringToHex('disagreed', { size: 32 }), 12, 28, '0x']);
    await send(writer, INTAKE, intakeAbi, 'complete', [rid, 2, padHex('0x', { size: 32 }), 'uri', failArgs]);
    ok((await status(L4)) === 6, 'the gate expired it on the failure callback');
    ok((await tick()).includes(`settleLetter:${L4}`), 'the keeper settles the letter at once');

    console.log('\n10c. An answer whose delivery fails (a bad signature): the Intake closes the request, the keeper expires the plea at once');
    const H5 = await handPlea(p5);
    const rid5 = (await G('getPlea', [H5])).intakeId;
    const t5 = await now();
    const a5 = { ...attest(45), issuedAt: t5, expiresAt: t5 + 3600n };
    const badSig = await sign({ hash: await read(S.gate, A.CabalGate.abi, 'attestationDigest', [a5]), privateKey: KEYS[5], to: 'hex' });
    let closed = true;
    try {
      await send(writer, INTAKE, intakeAbi, 'complete', [rid5, 0, keccak256(stringToHex('attestation')),
        'uri', encodeAbiParameters([{ type: 'bytes32' }, attType, { type: 'bytes' }], [rid5, a5, badSig])]);
    } catch {
      closed = false;
    }
    if (closed) {
      ok((await status(H5)) === 1, 'the plea is still pending (the callback reverted)');
      ok((await tick()).includes(`expirePlea:${H5}`), 'the keeper expires it without waiting 20 minutes');
    } else {
      console.log('  (the Intake reverts the whole completion when the callback fails: nothing to rehearse)');
      await warp(21 * 60);
      ok((await tick()).includes(`expirePlea:${H5}`), 'the keeper expires it after 20 minutes');
    }

    console.log('\n10. Keeping the Cabal alive to the end of season 0 (a denied plea a day), then the close');
    const t0 = await G('startedAt');
    let i = 0;
    while ((await now()) < t0 + SEASON) {
      const w = [p5, p3][i++ % 2];
      const id = await handPlea(w);
      await answer(id, 0);
      await tick();
      await warp(24 * 3600);
    }
    const end = t0 + SEASON;
    const left = end + 3600n - (await now());
    if (left > 0n) await warp(left);
    const potBefore = await read(IMD, erc20, 'balanceOf', [p1.account.address]);
    ok((await tick()).includes('closeSeason:0'), 'the keeper closes season 0 an hour after it ends');
    ok(await SE('closed', [0n]), 'season 0 is closed');
    ok((await read(IMD, erc20, 'balanceOf', [p1.account.address])) > potBefore, 'p1 (90 points) is paid its prize');

    console.log('\n11. The death: the remaining season closes, the pot goes to the wall, the wall is rebuilt');
    await warp(DEADMAN + 3600n);
    ok(!(await G('cabalAlive')), 'the Cabal is dead');
    const after = [];
    for (let k = 0; k < 4; k++) {
      after.push(...(await tick()));
      await warp(601);
    }
    ok(after.includes('closeSeason:1'), 'season 1 is closed');
    ok(await SE('finished'), 'Seasons is finished');
    ok(after.includes('flush:0'), 'the pot is flushed to the wall');
    ok(after.includes('rebalance:0'), 'the wall is rebuilt');

    const sentHashes = logs.filter((l) => l.msg === 'sent').map((l) => l.hash);
    let reverted = 0;
    for (const hash of sentHashes) if ((await pub.getTransactionReceipt({ hash })).status !== 'success') reverted++;
    ok(reverted === 0, `none of the keeper's ${sentHashes.length} transactions reverted`);
    const alerts = logs.filter((l) => l.level === 'alert').map((l) => l.text);
    ok(alerts.some((t) => t.includes('The Cabal died')), 'it alerted the death');
    console.log(`\nalerts raised: ${alerts.length}\n  ${alerts.join('\n  ')}`);
    console.log(`\nkeeper: ${sentHashes.length} transactions, ${formatEther(await keeperImd())} IMD in tips`);
    console.log(`\nREHEARSAL PASSED: ${pass} checks`);
  } catch (e) {
    console.error('\nREHEARSAL FAILED:', e?.shortMessage ?? e?.message ?? e);
    for (const l of logs.slice(-15)) console.error('  log', JSON.stringify(l, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    process.exitCode = 1;
  } finally {
    anvil.kill();
  }
}

await main();
