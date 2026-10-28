# Running the keeper on a VPS

For Ubuntu 22.04 or later on x86_64, run as root. The keeper gets its own Linux user, its own Node.js
and its own wallet. It can share a machine with the IMD worker; it needs little memory (under
512 MB) and makes about one RPC call batch every 12 seconds.

## 1. A user and Node.js 24

```
useradd --system --create-home --home-dir /opt/plea-keeper --shell /usr/sbin/nologin plea-keeper
cd /opt/plea-keeper
curl -fSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
curl -fSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
grep ' node-v24.21.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check
tar --no-same-owner -xJf node-v24.21.0-linux-x64.tar.xz && ln -s node-v24.21.0-linux-x64 node
rm node-v24.21.0-linux-x64.tar.xz SHASUMS256.txt
/opt/plea-keeper/node/bin/node --version
```

The check must print `node-v24.21.0-linux-x64.tar.xz: OK`, and the last line `v24.21.0`.

## 2. The code

```
apt-get install -y git
git clone --branch main https://github.com/khaed1/plea /opt/plea-keeper/plea
cd /opt/plea-keeper/plea/keeper
PATH=/opt/plea-keeper/node/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R plea-keeper:plea-keeper /opt/plea-keeper/plea
git config --global --add safe.directory /opt/plea-keeper/plea   # lets root run git pull here later
```


## 3. The keeper's wallet

```
cd /opt/plea-keeper/plea/keeper
runuser -u plea-keeper -- /opt/plea-keeper/node/bin/node src/new-wallet.mjs
```

It creates `.env` (from `.env.example`) with a new key, readable only by `plea-keeper`, and prints
the address; the key is never shown. Send that address about **0.05 ETH** for gas. It needs nothing
else: deliveries earn it 0.25 IMD each, which stays in this wallet. Never use this wallet for
anything else, and never put the owner's key here. Keep a copy of `.env` somewhere safe (it holds the
key to the tips).

## 4. Telegram

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name; it gives you a token.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN=...` (`nano .env`).
3. Send your new bot any message, then:

```
runuser -u plea-keeper -- /opt/plea-keeper/node/bin/node --env-file=.env src/telegram-chat.mjs
```

4. Put the printed `TELEGRAM_CHAT_ID=...` line in `.env`.

## 5. The rest of `.env`

- `LAUNCH`: the `PleaLaunch` address, known once the mainnet launch is live.
- `RPC_URL`: the public default works; a provider URL with your own key (Alchemy, Infura,
  QuickNode, a free plan is enough) is more reliable.
- `SEND_RPC_URL`: keep `https://rpc.flashbots.net/fast`.
- Keep `DRY_RUN=1` for now.

## 6. Check it

```
cd /opt/plea-keeper/plea/keeper
runuser -u plea-keeper -- /opt/plea-keeper/node/bin/node --env-file=.env src/main.mjs --test-alert
runuser -u plea-keeper -- /opt/plea-keeper/node/bin/node --env-file=.env src/main.mjs --once
```

The first sends "test alert: Telegram works." to your chat. The second does one dry pass and prints
JSON lines: before trading opens it says it is waiting; after, it lists what it would send.

## 7. Run it as a service

```
cp keeper.service /etc/systemd/system/plea-keeper.service
systemctl daemon-reload
systemctl enable --now plea-keeper
journalctl -u plea-keeper -f
```

It restarts by itself after a crash or a reboot. When the dry run looks right (at the latest when
trading opens), set `DRY_RUN=0` in `.env` and `systemctl restart plea-keeper`.

## Updating

```
cd /opt/plea-keeper/plea && git pull
cd keeper && PATH=/opt/plea-keeper/node/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R plea-keeper:plea-keeper /opt/plea-keeper/plea
systemctl restart plea-keeper
```
