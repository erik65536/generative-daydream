# Hosting at home

The game runs on a small always-on Linux box, and the GPU work runs on a separate GPU PC. The box serves the
game, the API and sockets, SQLite, the art, and the OpenAI-backed play-time calls. Its job worker builds worlds
and sends painting, reading and upscaling to ComfyUI on the GPU PC over the home network. Development also stays
on the GPU PC.

```
players ──https 443──▶ router ──▶ game box (Ubuntu 26.04 LTS)
                                   Caddy :443 ──▶ gd-server 127.0.0.1:3000 ─┐
                                                  gd-worker ────────────────┼──▶ OpenAI (hosted)
                                                  /var/lib/gd (data)        └──▶ ComfyUI on the GPU PC :8188 (LAN)
```

Files in `deploy/`: the systemd units, the `Caddyfile`, `ddns-namecheap.sh` and `deploy.sh`.

## What runs where

- **Game box:** the game server and the job worker, both from this repository, plus Caddy.
  - The worker must run beside the server. The job queue, job leases, GPU leases and spending ledger live in the
    one SQLite database, and world folders sit next to it. SQLite does not work over a network share.
- **GPU PC:** ComfyUI only. The worker reaches it over HTTP: `/prompt`, `/upload/image`, `/view` and `/free`.
  Setting `baseUrl` in the config is all a remote ComfyUI needs.
- **When the GPU PC is off:** a model that does not answer is retried, and the job shows as *waiting*. Builds
  resume when ComfyUI comes back. Play never needs the GPU PC.
- **Not hosted yet:**
  - **Animation.** The animator starts Python with CUDA and headless Chromium on the machine that runs the job.
    Leave the `animation` block out of the box's config, and characters stay still images. A remote animator
    service on the GPU PC is a separate pass.
  - **Sharing the GPU between production and development.** Each installation keeps its GPU lease in its own
    database, so production and development cannot see each other's lease. ComfyUI still runs prompts one at a
    time, but both sides can interleave models, and SkinTokens (outside ComfyUI) can collide with a painting.
    A shared GPU broker is a separate pass.

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
   - The `comfy` provider's `baseUrl` is `http://<GPU PC LAN address>:8188`.
   - No `animation` block, and no llama.cpp providers.
   - Keep the `spending` caps.

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
   journalctl -u gd-server -n 50        # the first start prints the administrator's one-time password
   ```
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

- Start ComfyUI with `--listen 0.0.0.0` (or its LAN address) so the box can reach it.
- ComfyUI has no sign-in, so allow its port from the game box only:
  ```powershell
  New-NetFirewallRule -DisplayName "ComfyUI from game box" -Direction Inbound -Protocol TCP -LocalPort 8188 -RemoteAddress <game box LAN address> -Action Allow
  ```
- Check that no older "allow" rule for `python.exe` opens it to the whole network:
  ```powershell
  Get-NetFirewallApplicationFilter | ? Program -like '*python*'
  ```
- Development keeps using `http://127.0.0.1:8188`.

## Deploying

From your account on the box, run `/opt/gd/deploy/deploy.sh`. It fast-forwards to `origin/main`, reinstalls
packages, builds the client, then restarts the worker and the server.

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

## Deleted worlds

Deleting a daydream moves it to `/var/lib/gd/trash/<id>/`:
- the world folder (`world/`);
- its saves (`instances/`);
- a record of what was deleted (`trash.json`).

Administrators restore one, or remove it at once, under **Deleted daydreams** on the Users page. The server
removes entries older than 30 days when it starts and twice a day after that.

## Security notes

- **Accounts:** invite only, hashed passwords, and a lockout per user id and per address after repeated failed
  sign-ins.
- **Behind Caddy:**
  - The server trusts `X-Forwarded-*` from loopback only. The lockout therefore sees each player's real address,
    and on https the session cookie is marked `Secure`.
  - Caddy adds HSTS, `nosniff`, `X-Frame-Options` and `Referrer-Policy`.
- **Spending:** daily caps per user and for the whole server in `genai.json`, plus the project limit at OpenAI.
- **Service sandbox:** the services run as `gd` with `ProtectSystem=strict`. They can write only `/var/lib/gd`
  (and a private `/tmp`), and they cannot read home folders.
