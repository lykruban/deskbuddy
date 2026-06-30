# DeskBuddy — Server Deployment Handoff (Cloudflare Tunnel)

> **How to use this:** open this file, copy the WHOLE thing, and paste it as your first
> message to the Claude Code session running on your Linux server. It's self-contained — that
> session has none of the context from the machine this was written on, so everything it needs
> is here.

---

You are deploying **DeskBuddy** onto THIS Linux machine (a home server on a LAN — NOT a public
cloud box). DeskBuddy is a Windows desktop app built elsewhere; this server hosts its **backend
API** and its **marketing website**, exposed to the internet via **Cloudflare Tunnel** (so there
is NO port-forwarding, NO public IP requirement, and HTTPS is handled at Cloudflare's edge).

## Context / inputs
- **Git repo (public):** `https://github.com/lykruban/deskbuddy.git`
  - Backend is in `src/server/` — `server.js` exports `startServer(dataDir)`; deps are only
    **express, multer, cors**; it binds **127.0.0.1:4242** and writes a JSON store + uploads
    under the dataDir it's given.
  - Website is the single self-contained file `website/index.html` (no build step, no assets).
- **Cloudflare:** the user already runs **yuvexel.com on Cloudflare**. You'll authenticate
  `cloudflared` against that account/zone (an interactive browser step — see below).
- **Hostnames to publish via the tunnel:**
  - `api.yuvexel.com`        → the backend API (localhost:4242)
  - `deskbuddy.yuvexel.com`  → the website (localhost:8080)

## Rules
- Show me your plan and the exact commands first; proceed once it's sound.
- Never run the Node API as root. Ask before anything destructive or that costs money.
- Secrets/credentials in files with `chmod 600`.

## Do this

**1. System prep**
- Detect distro/init system, confirm sudo, update packages.
- Install: **Node.js LTS** (nodesource or nvm), **git**, **fail2ban**, and **cloudflared**
  (Cloudflare Tunnel daemon — add Cloudflare's apt repo, or download the official binary).

**2. Users & directories**
- Create unprivileged user `deskbuddy`.
- `/opt/deskbuddy`     — the cloned repo (code + website).
- `/var/lib/deskbuddy` — persistent data: JSON store, uploads, announcements (chmod 700, owned deskbuddy).

**3. Get the code**
- `git clone https://github.com/lykruban/deskbuddy.git /opt/deskbuddy` (or `git pull` if it exists).
- Create `/opt/deskbuddy/server-main.js`:
  ```js
  const { startServer } = require('./src/server/server');
  startServer(process.env.DATA_DIR || '/var/lib/deskbuddy')
    .then(p => console.log('DeskBuddy API on', p))
    .catch(e => { console.error(e); process.exit(1); });
  ```
- Install ONLY the backend deps into `/opt/deskbuddy` (do **NOT** `npm install` the root
  `package.json` — it pulls Electron + a huge toolchain you don't need on a server):
  `npm install express@^5.2.1 multer@^2.2.0 cors@^2.8.6 --no-save --prefix /opt/deskbuddy`

**4. Run the API under systemd** — `/etc/systemd/system/deskbuddy-api.service`
- Runs `node server-main.js` as user `deskbuddy`, `WorkingDirectory=/opt/deskbuddy`,
  `EnvironmentFile=/etc/deskbuddy.env`, `Restart=always`, logs to journald.
- `/etc/deskbuddy.env` (chmod 600, owned deskbuddy):
  ```
  NODE_ENV=production
  DATA_DIR=/var/lib/deskbuddy
  RESET_URL_BASE=https://api.yuvexel.com
  # Optional, for REAL password-reset emails (reset still works via recovery codes without this):
  # SMTP_URL=smtp://user:pass@host:587   (or)   SENDGRID_API_KEY=...
  ```
- `systemctl daemon-reload && systemctl enable --now deskbuddy-api`. Confirm it listens on 127.0.0.1:4242
  (`curl http://localhost:4242/api/characters` → JSON array).

**5. Serve the website locally** (Cloudflare Tunnel proxies to it) — a tiny static server on :8080.
- Create `/opt/deskbuddy/web-main.js`:
  ```js
  const http=require('http'),fs=require('fs'),path=require('path');
  const ROOT='/opt/deskbuddy/website', PORT=8080;
  const T={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
  http.createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
    fs.readFile(path.join(ROOT,p),(e,d)=>{if(e){s.writeHead(404);return s.end('404');}
    s.writeHead(200,{'Content-Type':T[path.extname(p)]||'application/octet-stream'});s.end(d);});
  }).listen(PORT,'127.0.0.1',()=>console.log('web on',PORT));
  ```
- systemd unit `deskbuddy-web.service` (user deskbuddy, `node /opt/deskbuddy/web-main.js`, Restart=always). Enable + start.

**6. Cloudflare Tunnel** (this replaces any reverse proxy / Let's Encrypt / open ports)
- `cloudflared tunnel login` — it prints a URL; open it on any device, log into the user's
  Cloudflare account, and authorize the **yuvexel.com** zone. (Ask the user to do this.)
- `cloudflared tunnel create deskbuddy` — note the tunnel UUID + the credentials json path it writes.
- Config `/etc/cloudflared/config.yml`:
  ```yaml
  tunnel: <TUNNEL_UUID>
  credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json
  ingress:
    - hostname: api.yuvexel.com
      service: http://localhost:4242
    - hostname: deskbuddy.yuvexel.com
      service: http://localhost:8080
    - service: http_status:404
  ```
- Create the DNS routes (this adds the CNAMEs in Cloudflare automatically — no manual DNS):
  `cloudflared tunnel route dns deskbuddy api.yuvexel.com`
  `cloudflared tunnel route dns deskbuddy deskbuddy.yuvexel.com`
- Install + start as a service: `cloudflared service install` then enable/start it (it reads the config above).
- In the Cloudflare dashboard the two hostnames should now be **Proxied (orange cloud)** with the
  tunnel as origin; SSL/TLS mode "Full" is fine (tunnel is encrypted end-to-end).

**7. Firewall & SSH hardening** (the tunnel is OUTBOUND, so no inbound web ports needed)
- ufw: allow **OpenSSH only**; default deny incoming; enable. (Do NOT need 80/443 open.)
- Enable fail2ban for sshd.

**8. Harden the API** (edit the server or add middleware; keep changes minimal, tell me what you changed)
- `express-rate-limit` on `/api/auth/*`; `helmet` security headers; confirm body + 100MB upload caps.
- (CORS can stay permissive — the desktop app needs it — or lock to the app/site origins if feasible.)

**9. Announcements (in-app update messages)**
- The app's notification inbox reads `GET /api/announcements`, which serves
  `/var/lib/deskbuddy/announcements.json`. Seed it: `echo '[]' > /var/lib/deskbuddy/announcements.json`
  (chown deskbuddy). To broadcast later, append `{ "id","title","body","link","ts" }`.

**10. Backups**
- Nightly `tar` of `/var/lib/deskbuddy` → `/var/backups/deskbuddy`, keep 14 days (systemd timer or cron).

**11. Verify end-to-end**
- `curl https://api.yuvexel.com/api/characters` → JSON array.
- `https://deskbuddy.yuvexel.com` loads the landing page.
- A signup then login returns a token; `curl https://api.yuvexel.com/api/announcements` → your list.

## Finally, print:
- The live URLs and a one-page runbook:
  - **Update site/API:** `cd /opt/deskbuddy && git pull` (+ `systemctl restart deskbuddy-api deskbuddy-web`).
  - **Broadcast an announcement:** edit `/var/lib/deskbuddy/announcements.json`.
  - **Logs:** `journalctl -u deskbuddy-api -f` · `-u deskbuddy-web -f` · `-u cloudflared -f`.
  - **Restore a backup** from `/var/backups/deskbuddy`.

---

### After it's live (done back on the Windows app, not here)
Point the desktop app at the API by setting **`SERVER_BASE`** to `https://api.yuvexel.com`
(via `settings.serverBase` or the `DESKBUDDY_SERVER` env var); the marketplace client's
hardcoded `localhost:4242` gets updated to match.
