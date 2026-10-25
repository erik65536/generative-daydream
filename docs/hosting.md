# Hosting at home

The game runs on a small always-on Linux box, and the GPU work runs on a separate GPU PC. The box serves the
game, the API and sockets, SQLite, the art, and the OpenAI-backed play-time calls. Its job worker builds worlds
and sends painting, reading and upscaling to ComfyUI on the GPU PC over the home network. Development also stays
on the GPU PC.

```
players ──https 443──▶ router ──▶ game box (Ubuntu 26.04 LTS)
                                   Caddy :443 ──▶ gd-server 127.0.0.1:3000 ─┐
                                                  gd-worker ────────────────┼──▶ OpenAI (hosted)
                                                  /var/lib/gd (data)        └──▶ GPU broker on the GPU PC :8190 (LAN) ──▶ ComfyUI
```

Files in `deploy/`: the systemd units, the `Caddyfile`, `ddns-namecheap.sh` and `deploy.sh`.

## What runs where

- **Game box:** the game server and the job worker, both from this repository, plus Caddy.
  - The worker must run beside the server. The job queue, job leases, GPU leases and spending ledger live in the
    one SQLite database, and world folders sit next to it. SQLite does not work over a network share.
- **GPU PC:** ComfyUI behind the GPU broker (`docs/gpu-broker.md`), which takes turns on the GPU for production
  and development alike. The worker speaks ComfyUI's HTTP API to the broker.
  - Start the broker by hand with `npm run broker`. While it is not running, GPU work waits.
- **When the GPU PC is off:** a model that does not answer is retried, and the job shows as *waiting*. Builds
  resume when ComfyUI comes back. Play never needs the GPU PC.
- **Not hosted yet:**
  - **Animation.** The animator starts Python with CUDA and headless Chromium on the machine that runs the job.
    Leave the `animation` block out of the box's config, and characters stay still images. A remote animator
    service on the GPU PC is a separate pass.

## Game box setup (once)

1. **Node 24 LTS or newer.** Use the Ubuntu archive if `apt policy nodejs` shows 24 or newer. Otherwise use
   NodeSource. Also install git, Caddy and unattended-upgrades:
   `sudo apt install git caddy unattended-upgrades`. Automatic security updates are on by default; check
   `/etc/apt/apt.conf.d/20auto-upgrades`.
2. **A service user and folders.** The checkout belongs to you, the services run as `gd`, and the data lives
   outside the checkout:
   ```bash
   sudo useradd --system --home /var/lib/gd --shell /usr/sbin/nologin gd
   sudo mkdir -p /opt/gd /etc/gd && sudo chown "$USER" /opt/gd
   git clone https://github.com/erik65536/generative-daydream.git /opt/gd   # a read-only deploy key if the repo is private
   cd /opt/gd && npm ci && npm run build
   ```
3. **Model config.** Make `/etc/gd/genai.json` from your own `config/genai.json`, with these changes:
   - Every OpenAI provider uses `"apiKey": "credential:openai"`.
   - The `comfy` provider has `"baseUrl": "http://<GPU PC LAN address>:8190"`, `"broker": true` and
     `"apiKey": "credential:gpu-broker"`.
   - The broker token is a long random string (`openssl rand -hex 32`). It is stored as the `gpu-broker`
     credential on the box, and under the client `prod` in the GPU PC's `config/broker.json`.
   - No `animation` block.
   - Keep `spending.dailyTotalUsd`, the whole server's daily ceiling. Each player's budget is monthly and is set
     on the Users page, not in this file.
   - Only the provider types `openai-responses`, `openai-decision`, `openai-transcribe` and `comfyui` exist. The
     server refuses to start if the file names another, such as an old `llm` or `decider` provider.

   Make it readable by `gd` only:
   ```bash
   sudo chown root:gd /etc/gd/genai.json
   sudo chmod 640 /etc/gd/genai.json
   ```
4. **Secrets as encrypted systemd credentials.** No `.env` on the box. Each command reads the secret from
   standard input, so type it and press Ctrl+D:
   ```bash
   sudo mkdir -p /etc/credstore.encrypted
   sudo systemd-creds encrypt --name=openai - /etc/credstore.encrypted/openai
   sudo systemd-creds encrypt --name=namecheap-ddns - /etc/credstore.encrypted/namecheap-ddns
   sudo systemd-creds encrypt --name=gpu-broker - /etc/credstore.encrypted/gpu-broker
   ```
   - The files are encrypted with the machine's TPM if it has one, else with a host key in `/var/lib/systemd`.
   - systemd decrypts a credential only for the services that list it. Each service sees it as a file in its
     own `$CREDENTIALS_DIRECTORY`.
   - `"credential:NAME"` in the config reads that file. Unlike an environment variable, it is not inherited by
     child processes.
   - Use a key from an OpenAI project of its own, with a monthly budget limit set at OpenAI.
5. **Services:**
   ```bash
   sudo cp /opt/gd/deploy/systemd/gd-*.service /opt/gd/deploy/systemd/gd-ddns.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now gd-server gd-worker gd-ddns.timer
   journalctl -u gd-server -n 50        # the first start prints the administrator's invite link
   ```
   - The first start of an empty server prints an invite link (`<site>/#/invite/<code>`). It works for 5 days.
     Open it on the real address, `https://daydream.erik.engineer`, after the DNS and HTTPS steps below, and pick
     a user name and a password, a passkey or both. The first account set up becomes the administrator.
   - Passkeys are tied to the site's host name, so set them up on the real address rather than a LAN IP. A
     passkey made on one machine's `localhost` does not work on another site.
   - If the link runs out, make a new one with the console tools (below): `list`, then `reset <id>`.
6. **DNS (Namecheap).**
   - In *Domain List → erik.engineer → Advanced DNS*, turn on **Dynamic DNS**. Its password is the
     `namecheap-ddns` credential.
   - Add an **A + Dynamic DNS** record for host `daydream`.
   - The timer checks the public address every 5 minutes and updates the record only when the address changes.
     See `journalctl -u gd-ddns`.
7. **HTTPS.**
   ```bash
   sudo cp /opt/gd/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
   - The router forwards 443 to the box. Caddy gets a Let's Encrypt certificate through the TLS-ALPN challenge,
     so port 80 is not needed.
   - Each future site on the domains is another block in the Caddyfile, for example `blog.erik.engineer`.
     Several sites can share 443 this way.
8. **Firewall:** allow only SSH from the LAN and 443 from anywhere.
   ```bash
   sudo ufw default deny incoming
   sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Adjust the LAN range to yours. Port 3000 needs no rule: the server listens on 127.0.0.1 only (`GD_HOST`).

## GPU PC setup

- **ComfyUI listens on 127.0.0.1** (its default, without `--listen`), so only the broker reaches it.
- **The broker:** `config/broker.json` from `config/broker.example.json`, with the `prod` token, then
  `npm run broker`. It listens on port 8190.
- **Firewall:** allow the broker's port from the game box only:
  ```powershell
  New-NetFirewallRule -DisplayName "GPU broker from game box" -Direction Inbound -Protocol TCP -LocalPort 8190 -RemoteAddress <game box LAN address> -Action Allow
  ```
- Check that no older "allow" rule for `python.exe` or `node.exe` opens ports to the whole network:
  ```powershell
  Get-NetFirewallApplicationFilter | ? Program -match 'python|node'
  ```
- **Development** points its `comfy` provider at `http://127.0.0.1:8190` with `"broker": true`.

## Deploying

From your account on the box, run `/opt/gd/deploy/deploy.sh`. It fast-forwards to `origin/main`, reinstalls
packages, builds the client, then restarts the worker and the server.

### Once: upgrading a box that ran a version from before October 2026

The account system changed (invite links, passkeys, monthly budgets), and so did the model config. On a box that
already has a database from an older version, do this before the first deploy of the new code. A fresh box
needs none of it.

1. Stop the services and back the database up:
   ```bash
   sudo systemctl stop gd-server gd-worker
   sudo -u gd cp /var/lib/gd/gd.sqlite /var/lib/gd/gd.sqlite.before-accounts
   ```
2. Pull the new code by hand, without restarting yet:
   ```bash
   cd /opt/gd && git fetch && git merge --ff-only origin/main && npm ci && npm run build
   ```
3. Upgrade the users table:
   ```bash
   sudo -u gd node /opt/gd/deploy/upgrade-accounts.cjs /var/lib/gd/gd.sqlite
   ```
   - Each existing account stays active with its user name and password and gets a $10 monthly budget.
   - An account that still had a one-time password becomes an invite again, and the script prints its code.
   - Running the script twice does nothing.
4. Edit `/etc/gd/genai.json` (`sudo nano /etc/gd/genai.json`) and remove these keys:
   - `providers.llm` and `providers.decider`. The server refuses to start while these exist.
   - `combineNpcDecisionAndDialogue`, `worldGenParallelism`, `gpuIdleUnloadMs`, `spending.dailyPerUserUsd` and
     `purposes."npc.dialogue"`. These are ignored, but they are clutter.
5. Start the services and check that they run:
   ```bash
   sudo systemctl start gd-server gd-worker
   journalctl -u gd-server -n 30
   ```
6. On the GPU PC, restart the broker (`npm run broker`) with the new code.

The tables `meta`, `gpu_lease` and `gpu_wait` in an old database are no longer read and can stay.

### Console tools on the box

The tools in `packages/server/src/cli/` work on the box's data when run as `gd`, with the same settings as the
services. Run them from `/opt/gd/packages/server`:

```bash
cd /opt/gd/packages/server
sudo -u gd env GD_DATA_DIR=/var/lib/gd GD_GENAI_CONFIG=/etc/gd/genai.json ../../node_modules/.bin/tsx src/cli/users.ts list
```

- `users.ts list`: every account with its id, user name, name, role and status (and its invite code while it is
  invited).
- `users.ts invite <name>`: a new invite, printing its code.
- `users.ts reset <user name or id>`: the account becomes an invite again with a new code. Use the id for an
  account that has not chosen a user name yet.
- `users.ts admin <user name or id> on|off`: make an account an administrator, or a player again.
- `worldpack.ts` moves worlds in and out (see below).

Restarting is safe:
- The server saves running games when it stops.
- The worker pauses jobs at a safe point, and they resume from their checkpoints.
- `/var/lib/gd` and `/etc/gd` are never touched by a deploy.

## Logs

```bash
journalctl -u gd-server -f
journalctl -u gd-worker -f
journalctl -u caddy
```

The admin pages (Users, GPU) work as in development. The GPU page reads VRAM from ComfyUI's own report, because
`nvidia-smi` is not on the box.

## Moving worlds between machines

A world takes hours of GPU to build, so build it once and carry it: from development to the game box, or from the
game box home to reproduce a bug. On the machine that has it (in `packages/server`):

```
npm run worldpack -- export <worldId> thimble.gdpack --saves
```

Copy the file over, then on the other machine (the server can be running):

```
npm run worldpack -- import thimble.gdpack --owner <username>
```

On the game box, copy the pack somewhere `gd` can read it (`/tmp` works) and run the tool as `gd` (see *Console
tools on the box*):

```bash
scp thimble.gdpack <box>:/tmp/
cd /opt/gd/packages/server
sudo -u gd env GD_DATA_DIR=/var/lib/gd GD_GENAI_CONFIG=/etc/gd/genai.json ../../node_modules/.bin/tsx src/cli/worldpack.ts import /tmp/thimble.gdpack --owner <username>
```

The `--owner` account must already be set up there.

The world belongs to `--owner`; with `--saves` its saves come along, each player given to the account of the same
name there (or the owner). Something already there is kept unless `--replace`. `--rigs` adds the animation rigs (to
animate again) and `--draft` the build's intermediate steps (to lay places out again); neither is needed to play.
A pack is a gzipped tar read with the system's `tar`, and is checked before anything is copied in.

## Deleted worlds

Deleting a daydream moves it to `/var/lib/gd/trash/<id>/`:
- the world folder (`world/`);
- its saves (`instances/`);
- a record of what was deleted (`trash.json`).

Administrators restore one, or remove it at once, under **Deleted daydreams** on the Users page. The server
removes entries older than 30 days when it starts and twice a day after that.

## Security notes

- **Accounts:** invite only (links that run out after 5 days), scrypt-hashed passwords and/or passkeys (WebAuthn,
  checked against the site's own origin), and a lockout per user name and per address after repeated failed
  sign-ins or invite guesses.
- **Behind Caddy:**
  - The server trusts `X-Forwarded-*` from loopback only. The lockout therefore sees each player's real address,
    and on https the session cookie is marked `Secure`.
  - Caddy adds HSTS, `nosniff`, `X-Frame-Options` and `Referrer-Policy`.
- **Reveries:** each is its owner's alone. An administrator reaches someone else's only by asking for it
  explicitly (see `docs/server-architecture.md`).
- **Spending:** a monthly budget per account (set on the Users page), a daily ceiling for the whole server in
  `genai.json`, plus the project limit at OpenAI.
- **Service sandbox:** the services run as `gd` with `ProtectSystem=strict`. They can write only `/var/lib/gd`
  (and a private `/tmp`), and they cannot read home folders.
