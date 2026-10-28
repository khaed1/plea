// Creates the keeper's wallet and writes its key into the env file (default .env, made from
// .env.example if missing) with mode 600. Prints only the address: the key is never shown.
//   node src/new-wallet.mjs [path]

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const path = process.argv[2] ?? '.env';
let text = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync('.env.example', 'utf8');
const m = text.match(/^KEEPER_PRIVATE_KEY=(.*)$/m);
if (m && m[1].trim()) {
  console.log(`${path} already holds a keeper key; its address: ${privateKeyToAccount(m[1].trim()).address}`);
  process.exit(0);
}
const key = generatePrivateKey();
text = m ? text.replace(/^KEEPER_PRIVATE_KEY=.*$/m, `KEEPER_PRIVATE_KEY=${key}`) : `${text}\nKEEPER_PRIVATE_KEY=${key}\n`;
writeFileSync(path, text, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`New keeper wallet written to ${path} (the key is not shown). Address: ${privateKeyToAccount(key).address}`);
