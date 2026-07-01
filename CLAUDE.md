# DeskBuddy — project context & status

_Last updated: 2026-07-01. This file auto-loads for Claude Code sessions in this repo. Keep it current._

> **➡️ Taking over the project? Read this file, then open [`NEXT-TASKS.md`](NEXT-TASKS.md) — the full,
> executable roadmap for everything remaining (website, installer hosting, marketplace, OAuth,
> code-signing, render quality, voice). Each task has steps + what to ask the user for.**

## What this is
**DeskBuddy** — a Windows desktop-pet / living-wallpaper app (Electron + three.js + @pixiv/three-vrm).
A 3D character lives on your desktop (**buddy mode**) or inside built **scenes** that span multiple
monitors (**scene/wallpaper mode**), walking — and teleporting through **doors** — between screens.
Includes a **Character Studio** (import your own models + Mixamo animations), a **Scene Editor**
(rooms, walls, doors, no-walk zones, anchors, lighting), **accounts**, an in-app **notification inbox**,
whole-library **export/import**, and a **creator marketplace** (WIP).

**Studio/brand:** the app is **DeskBuddy**; the umbrella studio is **Yuvexel** (footer credit only).
EXE properties carry `© 2026 Yuvexel`. Domain: `yuvexel.com` (Cloudflare).

## ✅ Current status (LIVE)
- **Backend + site are DEPLOYED and live** on the user's home Linux server via **Cloudflare Tunnel**
  (no public IP / no port-forwarding / auto-HTTPS at Cloudflare's edge):
  - API  → **https://api.yuvexel.com**  (Node/Express from `src/server/`, systemd `deskbuddy-api`, binds 127.0.0.1:4242)
  - Site → **https://deskbuddy.yuvexel.com**  (serves `website/index.html` via a tiny static server, systemd `deskbuddy-web` :8080)
- **The desktop app points at production by default:** `SERVER_BASE` in `main.js` defaults to
  `https://api.yuvexel.com` (override for local dev with env `DESKBUDDY_SERVER` or `settings.serverBase`,
  e.g. `http://127.0.0.1:4242`). `marketplace.js` reads the shared base at init (no more hardcoded localhost).
- Verified end-to-end: signup/login/recovery work on prod. A throwaway `deploytest` account (id:1) exists
  on prod — clear `/var/lib/deskbuddy/marketplace/users.json` on the server for a clean slate.
- **GitHub:** `github.com/lykruban/deskbuddy` (PUBLIC), branch **`main`**, tag `v1.0.0`. Push creds cached locally.
- **Installers:** `npm run build:win` → `dist/DeskBuddy Setup 1.0.0.exe` + `-Portable-`. Copies staged on the
  user's Desktop under `SHARED/` (a Windows SMB share the server can mount).

## Run / build / deploy
```
npm start                 # run the app (points at prod by default; set DESKBUDDY_SERVER for local)
npm run build:win         # build the Windows installer + portable into dist/
node scripts/make-icons.js  (via: npx electron scripts/make-icons.js)   # regen icons from assets/icons/logo-src.png
```
**Deploy a backend/site update:** push to `main`, then on the server: `cd /opt/deskbuddy && git pull &&
sudo systemctl restart deskbuddy-api deskbuddy-web`. Full server setup lives in **`DEPLOY-HANDOFF.md`**
(Cloudflare Tunnel version — paste into the server's Claude).
**Broadcast an in-app message to all users:** edit `/var/lib/deskbuddy/announcements.json` on the server
(JSON array of `{id,title,body,link,ts}`) — the app's 🔔 inbox reads `GET /api/announcements`.

## Architecture (where things live)
- `src/main/main.js` — Electron main: windows, tray, overlay, wallpaper/multi-display (`sceneLayout`),
  shared **auth** IPC (over `SERVER_BASE`), **library export/import**, **notification** store + tray/taskbar badge.
- `src/main/preload.js` — the `window.deskbuddy` IPC bridge.
- `src/overlay/overlay.js` — the renderer that draws the character + scenes (three.js): scene camera is
  **orthographic** + `depthScaleAt` (perspective is approximate — see backlog), shadows, door-teleport fade.
- `src/scene/{behavior,floor,scenepack}.js` — wander AI, floor math, scene format (rooms/walls/doors/zones).
- `src/studio/` — Character Studio + Scene Editor (login gate, library buttons, 🔔 bell, Yuvexel credit).
- `src/marketplace/` — marketplace window (own login via localStorage — NOT yet unified with the shared session).
- `src/server/{server,store}.js` — Express API + JSON store (accounts w/ scrypt, recovery codes, reset,
  characters/animations, purchase, `/api/announcements`). Runs locally in-app AND is what's deployed remotely.
- `assets/icons/` — `icon.png/tray.png/icon.ico` (brand paw), `logo-src.png` (master art).

## Working agreements (see memory too)
- **Commit often, in small logical parts** (file-level; interactive `git add -p` is unavailable here).
- **Verify visual/rendering changes before committing** — the user checks on their real dual-monitor setup
  (1920×1080 + 2560×1440) and confirms before commit.
- Syntax-check ES modules by copying to `.mjs` and `node --check`. Renderer `console.log` does NOT reach
  terminal stdout — forward via `webContents.on('console-message', …)` in main.js to debug.
- Run the app from a tool with output to a FILE (`npx electron . > log 2>&1 &`), NOT piped through `head`
  (head closing the pipe SIGKILLs electron mid-run).

## Backlog / TODO (not yet done)
1. **Website rebuild** — user is generating a new landing page via **Kimi** (prompt in `website/KIMI-PROMPT.md`
   / `deskbuddy-website/KIMI-PROMPT.md`). The live `deskbuddy.yuvexel.com` currently serves the interim 3D-VRM
   `website/index.html` (character had z-index/framing bugs). When Kimi's code arrives: integrate, swap in the
   user's own Goku/skeleton GLBs (their `.charpack` files ARE GLB), wire waitlist+download, `git pull` on server.
2. **Code-signing cert** — removes the Windows SmartScreen "unknown publisher" warning. Not started (costs $ +
   identity verification; Azure Trusted Signing ~$10/mo recommended, or EV cert for instant trust).
3. **Marketplace: make SCENES publishable** — scenes reference separate bg-image files, so publishing needs
   bundling + a server `scene` type (characters + animation packs already publish).
4. **Unify the marketplace login** onto the shared main-process session (it still uses its own localStorage token).
5. **Google/OAuth login** — deferred; needs the deployed HTTPS server (now available) + a Google Cloud app.
6. **Render quality** (overlay.js) — quick wins (ACES tone mapping, ground-bounce, shadow tint), a bake pipeline
   (PMREM env map + SH light-probe baked into the scenepack), and the real **perspective camera** (replace the
   ortho cam / `depthScaleAt` heuristic) so the character sits correctly in photographed scenes.
7. **Voice companion** (context-aware quips) — explored, deferred.
8. Optional: stop running the redundant in-app local server when `SERVER_BASE` is remote.

## Gotchas
- **PACKAGING (critical):** electron-builder's default file filter STRIPS `node_modules/*/examples/`
  from the build — that deleted `three/examples/jsm/` (all the loaders), which silently broke
  `studio.js`/`overlay.js` (ES module import fails → no `window.*` handlers → nothing clickable,
  login gate never shows). FIX: the three.js jsm loaders are **vendored into `src/vendor/three-jsm/`**
  (always packaged, not under node_modules) and the import maps in `studio.html`/`overlay.html` point
  there. `asar: false` is also set (safe, aids debugging). If you `npm update three`, re-copy:
  `cp -r node_modules/three/examples/jsm src/vendor/three-jsm`. Renderer console is forwarded to the
  main log via `wireRendererLogs` (visible with `ELECTRON_ENABLE_LOGGING=1`) — use it to debug packaged builds.
- Monetization plan: FREE app + one-time **Pro** unlock (~$5–8) + marketplace cut. No subscription.
- The app still starts its **in-app local server** on 4242 even though it points at prod (harmless, unused).
- `website/models/` (large local GLBs) is gitignored. Installers are too big for git (use the build output).
