# DeskBuddy — Server Deployment Handoff

> **How to use this:** open this file, copy the WHOLE thing, and paste it as your first
> message to the Claude Code session running on your Linux server. It is self-contained —
> that session has none of the context from the machine this was written on, so everything
> it needs is here. Fill in the two `<...>` values first.

---

You are deploying **DeskBuddy** onto THIS Linux machine. DeskBuddy is a Windows desktop app
(built elsewhere); this server hosts its **backend API** and its **marketing website**. Deploy
and harden both, behind one reverse proxy with automatic HTTPS.

## Inputs (ask me for any that are blank, then stop)
- **Server public IP:** `<SERVER_IP>`  (I will point DNS at this.)
- **Git repo:** `https://github.com/lykruban/deskbuddy.git`
  - Backend lives in `src/server/` — `server.js` exports `startServer(dataDir)`/`stopServer`,
    requires `./store`; its only deps are **express, multer, cors**. It binds **127.0.0.1:4242**
    and writes a JSON store + uploads under the dataDir it's given.
  - Website is the single self-contained file `website/index.html` (no build step, no assets).
- **Domains** (I will create these DNS A records → `<SERVER_IP>` BEFORE you request certs):
  - `api.yuvexel.com`        → the backend API
  - `deskbuddy.yuvexel.com`  → the website

## Rules
- Show me your plan and the exact commands first; proceed once it's sound.
- Never run Node as root. Never expose port 4242 publicly. Secrets in env files, `chmod 600`.
- Ask before anything destructive or that costs money.

## Do this

**1. System prep**
- Detect distro/init system, confirm sudo, update packages.
- Install: Node.js LTS (nodesource or nvm), git, ufw, fail2ban, **caddy** (the reverse proxy
  with automatic Let's Encrypt HTTPS).

**2. Users & directories**
- Create unprivileged user `deskbuddy`.
- `/opt/deskbuddy`        — the cloned repo (code).
- `/var/lib/deskbuddy`    — persistent data: JSON store, uploads, announcements (chmod 700, owned by deskbuddy).
- The website is served straight from the repo (`/opt/deskbuddy/website`).

**3. Get the code**
- Clone `https://github.com/lykruban/deskbuddy.git` to `/opt/deskbuddy` (or `git pull` if it exists).
- Create `/opt/deskbuddy/server-main.js`:
  ```js
  const { startServer } = require('./src/server/server');
  startServer(process.env.DATA_DIR || '/var/lib/deskbuddy')
    .then(p => console.log('DeskBuddy API on', p))
    .catch(e => { console.error(e); process.exit(1); });
  ```
- Create `/opt/deskbuddy/server.package.json` with ONLY the backend deps and install them
  into `/opt/deskbuddy` (do **NOT** `npm install` the root `package.json` — it pulls in
  Electron and a huge toolchain you don't need on a server):
  ```json
  { "name":"deskbuddy-api","private":true,
    "dependencies":{ "express":"^5.2.1","multer":"^2.2.0","cors":"^2.8.6" } }
  ```
  e.g. `cp server.package.json package-server.json` then `npm install express@^5.2.1 multer@^2.2.0 cors@^2.8.6 --no-save --prefix /opt/deskbuddy` (or install from the minimal manifest — your call, just don't install Electron).

**4. Run the API under systemd** — `/etc/systemd/system/deskbuddy-api.service`
- Runs `node server-main.js` as user `deskbuddy`, `WorkingDirectory=/opt/deskbuddy`,
  `EnvironmentFile=/etc/deskbuddy.env`, `Restart=always`, logs to journald.
- `/etc/deskbuddy.env` (chmod 600, owned deskbuddy):
  ```
  NODE_ENV=production
  DATA_DIR=/var/lib/deskbuddy
  RESET_URL_BASE=https://api.yuvexel.com
  # Optional, to send REAL password-reset emails (otherwise reset still works via recovery codes):
  # SMTP_URL=smtp://user:pass@host:587   (or)   SENDGRID_API_KEY=...
  ```
- `systemctl daemon-reload && systemctl enable --now deskbuddy-api`. Confirm it's listening on 127.0.0.1:4242.

**5. Reverse proxy + HTTPS (Caddy)** — `/etc/caddy/Caddyfile`
```
api.yuvexel.com {
    reverse_proxy 127.0.0.1:4242
}

deskbuddy.yuvexel.com {
    root * /opt/deskbuddy/website
    file_server
    encode gzip
}
```
- `systemctl reload caddy`. Caddy auto-issues Let's Encrypt certs for both (needs the DNS A
  records live first — confirm they resolve, then reload). Verify HTTPS works on both.

**6. Firewall & SSH hardening**
- ufw: allow OpenSSH, 80, 443; default deny incoming; enable.
- Enable fail2ban for sshd.

**7. Harden the API** (edit the server or add middleware; keep changes minimal and tell me what you changed)
- `express-rate-limit` on `/api/auth/*` (stop brute-force logins).
- `helmet` for security headers.
- Confirm the JSON body + 100MB upload caps are in place.
- Lock CORS to the app + site origins instead of `*` if feasible.

**8. Announcements (in-app update messages)**
- The app's notification inbox reads `GET /api/announcements`, which serves
  `/var/lib/deskbuddy/announcements.json`. Seed it: `echo '[]' > /var/lib/deskbuddy/announcements.json`
  (chown deskbuddy). To broadcast an update to every user later, append an item:
  `{ "id":"unique-id", "title":"...", "body":"...", "link":"https://...", "ts": <epoch-ms> }`.
- (Future hardening: sign this payload so the client can verify it's genuinely from us.)

**9. Backups**
- Nightly `tar` of `/var/lib/deskbuddy` → `/var/backups/deskbuddy`, keep 14 days (systemd timer or cron).

**10. Verify end-to-end**
- `curl https://api.yuvexel.com/api/characters` → JSON array.
- `https://deskbuddy.yuvexel.com` loads the landing page.
- A signup then login returns a token; `curl https://api.yuvexel.com/api/announcements` → your list.

## Finally, print:
- The live URLs (`https://api.yuvexel.com`, `https://deskbuddy.yuvexel.com`).
- A one-page runbook:
  - **Update the website or API:** `cd /opt/deskbuddy && git pull` (then `npm install` + `systemctl restart deskbuddy-api` if backend deps changed; the site needs no restart).
  - **Broadcast an announcement:** edit `/var/lib/deskbuddy/announcements.json`.
  - **Logs:** `journalctl -u deskbuddy-api -f`. **Caddy:** `journalctl -u caddy -f`.
  - **Restore a backup** from `/var/backups/deskbuddy`.

---

### After the server is live (done back on the Windows app, not here)
Point the desktop app at the deployed API by setting **`SERVER_BASE`** to `https://api.yuvexel.com`
(via `settings.serverBase`, or the `DESKBUDDY_SERVER` env var). The marketplace client's hardcoded
`localhost:4242` is also updated to use it.
