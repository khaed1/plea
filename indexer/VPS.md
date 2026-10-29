# Running the PLEA indexer on a VPS

For Ubuntu 22.04 or later on x86_64, run as root, on the same machine as the keeper (`keeper/VPS.md`). The indexer
(built by IMD's swarm, job `32c3663b`: https://github.com/identity-md-launches/launch-2652-build-read-only-ponder-indexer)
reads PLEA's events from Ethereum into a Postgres database and answers the site's queries at
`https://indexer.pleaimd.fun/graphql`. It holds no key and sends no transaction. It needs about
0.6 GB of memory (Ponder ~0.4 GB on Node 24, Postgres ~0.2 GB; the service is capped at 1 GB)
and well under 1 GB of disk.

What you need first:
- **An Ethereum RPC URL.** The free public `https://ethereum-rpc.publicnode.com` (no sign-up, no
  key) is enough: once running, the indexer only asks about new blocks (about 35,000 calls a day, at
  most 4 a second), and its answers are kept in Postgres. Public endpoints serve only about a week
  of old logs, so to rebuild from an *empty* database later on, use a provider with full history for
  that once (e.g. Ankr; a rebuild costs a few thousand calls), then switch back.
- **The DNS record:** at your registrar, for `pleaimd.fun`, add a record of type `A`, name
  `indexer`, value = the VPS's IP address (`curl -4 ifconfig.me` on the VPS prints it).

## 1. A user and Node.js 24 (the keeper's version)

```
useradd --system --create-home --home-dir /opt/plea-indexer --shell /usr/sbin/nologin plea-indexer
cd /opt/plea-indexer
curl -fSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
curl -fSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
grep ' node-v24.21.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check
tar --no-same-owner -xJf node-v24.21.0-linux-x64.tar.xz && ln -s node-v24.21.0-linux-x64 node
rm node-v24.21.0-linux-x64.tar.xz SHASUMS256.txt
/opt/plea-indexer/node/bin/node --version
```

The check must print `node-v24.21.0-linux-x64.tar.xz: OK`, and the last line `v24.21.0`.

## 2. Postgres

```
apt-get install -y postgresql
PW=$(openssl rand -hex 24)
runuser -u postgres -- psql -qc "CREATE USER plea_indexer PASSWORD '$PW';" -c "CREATE DATABASE plea_indexer OWNER plea_indexer;"
```

Keep this shell open for step 4 (it holds the password in `$PW`; it is never printed). Postgres
listens only on the machine itself.

## 3. The code (the checked commit)

```
apt-get install -y git
git clone https://github.com/identity-md-launches/launch-2652-build-read-only-ponder-indexer /opt/plea-indexer/app
cd /opt/plea-indexer/app && git checkout 763cd34feaf31f41c3a7b42c348765e7c5c2910e
PATH=/opt/plea-indexer/node/bin:$PATH npx -y pnpm@10.28.2 install --frozen-lockfile --prod
chown -R plea-indexer:plea-indexer /opt/plea-indexer/app
git config --global --add safe.directory /opt/plea-indexer/app
```

## 4. Settings

Paste these one line at a time. If `$PW` is empty (a new shell since step 2), first run
`PW=$(openssl rand -hex 24) && runuser -u postgres -- psql -qc "ALTER USER plea_indexer PASSWORD '$PW';"`.

```
[ -n "$PW" ] && echo "PW is set" || echo "PW is EMPTY"
cd /opt/plea-indexer/app
(umask 077; printf 'DATABASE_URL=postgresql://plea_indexer:%s@localhost:5432/plea_indexer\nPONDER_RPC_URL_1=https://ethereum-rpc.publicnode.com\n' "$PW" > .env.local)
chown plea-indexer:plea-indexer .env.local && unset PW
ls -l .env.local; grep -c 'plea_indexer:[0-9a-f]\{48\}@' .env.local; grep PONDER_RPC .env.local
```

The last line must show `-rw------- 1 plea-indexer plea-indexer`, then `1` (the password is in the
file; it is not printed), then the RPC line. To use another RPC, change that line with `nano .env.local`.
Keep a copy of `.env.local` somewhere safe.

## 5. Check it

```
cd /opt/plea-indexer/app
set -a; . ./.env.local; set +a
runuser -u plea-indexer -- /opt/plea-indexer/node/bin/node node_modules/ponder/dist/esm/bin/ponder.js start --schema plea_v1 --hostname 127.0.0.1 --port 42069
```

Within a minute it prints `Completed backfill indexing` and `Started returning 200 responses
endpoint=/ready`. In a second terminal, `curl -s http://127.0.0.1:42069/status` prints the last
block it has, e.g. `{"mainnet":{"id":1,"block":{"number":26294449,…}}}`. Stop it with Ctrl+C (it
keeps what it indexed).

## 6. Run it as a service

```
cat > /etc/systemd/system/plea-indexer.service <<'EOF'
[Unit]
Description=PLEA indexer (Ponder)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=plea-indexer
WorkingDirectory=/opt/plea-indexer/app
EnvironmentFile=/opt/plea-indexer/app/.env.local
ExecStart=/opt/plea-indexer/node/bin/node node_modules/ponder/dist/esm/bin/ponder.js start --schema plea_v1 --hostname 127.0.0.1 --port 42069
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/plea-indexer/app
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now plea-indexer
journalctl -u plea-indexer -f
```

It restarts by itself after a crash or a reboot and carries on from the last block it had.

## 7. HTTPS with Caddy

Ubuntu 24.04: `apt-get install -y caddy`. Ubuntu 22.04: Caddy's own package repository
(https://caddyserver.com/docs/install, "Debian, Ubuntu, Raspbian").

```
cat > /etc/caddy/Caddyfile <<'EOF'
indexer.pleaimd.fun {
	request_body {
		max_size 16KB
	}
	@api path /graphql /health /ready /status
	handle @api {
		reverse_proxy 127.0.0.1:42069
	}
	handle {
		respond 404
	}
}
EOF
systemctl reload caddy
```

Ports 80 and 443 must be open: `ufw status`; if it is active, `ufw allow 80/tcp` and
`ufw allow 443/tcp` (and in your VPS provider's firewall, if it has one). Caddy fetches a free
certificate and renews it by itself. Only the four indexer paths are public; the indexer's own port
42069 stays closed to the outside.

Check from your own computer:

```
curl -s https://indexer.pleaimd.fun/status
```

It must print the same kind of line as in step 5. To compare it with the chain log for log (on the
VPS, in `/opt/plea-indexer/app`; `<to>` = a block it has indexed, within the RPC's log window):

```
PATH=/opt/plea-indexer/node/bin:$PATH node scripts/compare.mjs https://indexer.pleaimd.fun/graphql https://ethereum-rpc.publicnode.com 26293890 <to>
```

It must end with `MATCH`.

## Updating (only to a commit you have reviewed)

```
cd /opt/plea-indexer/app && git fetch && git checkout <new commit>
PATH=/opt/plea-indexer/node/bin:$PATH npx -y pnpm@10.28.2 install --frozen-lockfile --prod
chown -R plea-indexer:plea-indexer /opt/plea-indexer/app
systemctl restart plea-indexer
```

If the update changes the indexer's code or settings, Ponder refuses the old `--schema` name: change
`plea_v1` to `plea_v2` in `/etc/systemd/system/plea-indexer.service`, `systemctl daemon-reload`,
`systemctl restart plea-indexer`. It builds a fresh index in a few minutes (its RPC answers are kept
in Postgres, so this costs little); the site keeps working meanwhile from the chain directly. The old
schema can be dropped afterwards: `runuser -u postgres -- psql -d plea_indexer -c 'DROP SCHEMA plea_v1 CASCADE;'`.

Nothing here needs a backup: everything in the database can be rebuilt from the chain.
