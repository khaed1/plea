import { parseEther, parseGwei, isAddress, getAddress } from 'viem';

export function loadConfig(env = process.env) {
  const need = (k) => {
    if (!env[k]) throw new Error(`${k} is required`);
    return env[k];
  };
  const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const launch = need('LAUNCH');
  if (!isAddress(launch)) throw new Error('LAUNCH is not an address');
  const key = env.KEEPER_PRIVATE_KEY;
  if (!dryRun && !/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('KEEPER_PRIVATE_KEY is required (0x + 64 hex) unless DRY_RUN=1');
  if (dryRun && !key && !env.KEEPER_ADDRESS) throw new Error('DRY_RUN needs KEEPER_PRIVATE_KEY or KEEPER_ADDRESS');
  return {
    rpcUrl: need('RPC_URL'),
    sendRpcUrl: env.SEND_RPC_URL || env.RPC_URL,
    launch: getAddress(launch),
    privateKey: key || undefined,
    keeperAddress: env.KEEPER_ADDRESS ? getAddress(env.KEEPER_ADDRESS) : undefined,
    stateFile: env.STATE_FILE || './keeper-state.json',
    dryRun,
    pollSeconds: num('POLL_SECONDS', 12),
    rebalanceEverySeconds: num('REBALANCE_EVERY_SECONDS', 600),
    rebalanceMinReserve: parseEther(env.REBALANCE_MIN_RESERVE_IMD || '1'),
    maxFee: parseGwei(env.MAX_FEE_GWEI || '10'),
    urgentMaxFee: parseGwei(env.URGENT_MAX_FEE_GWEI || '50'),
    priority: parseGwei(env.PRIORITY_GWEI || '0.05'),
    urgentPriority: parseGwei(env.URGENT_PRIORITY_GWEI || '0.5'),
    minEth: parseEther(env.MIN_ETH || '0.01'),
    imdSlowMinutes: num('IMD_SLOW_MINUTES', 5),
    receiptTimeoutSeconds: num('RECEIPT_TIMEOUT_SECONDS', 180),
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChat: env.TELEGRAM_CHAT_ID || undefined,
    alertRepeatHours: num('ALERT_REPEAT_HOURS', 6),
    summaryUtcHour: num('SUMMARY_UTC_HOUR', 8),
    gasMultiplier: num('GAS_MULTIPLIER', 1.25),
  };
}
