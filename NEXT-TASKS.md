# DeskBuddy — Next Tasks (handoff roadmap)

_For any future Claude/Fable session: **read `CLAUDE.md` first** (architecture + current state),
then pick a task below. Each has enough detail to execute without the original session. Ask the
user for the "Needs from user" items — don't guess credentials, purchases, or brand decisions.
Follow the working agreements in CLAUDE.md (commit often in small parts; verify visual/rendering
changes before committing; push to `main`; the server auto-updates via `git pull`)._

## Current live state (2026-07)
- App is LIVE against **https://api.yuvexel.com** (Node backend, Cloudflare Tunnel) and the site
  domain **https://deskbuddy.yuvexel.com** is served from this repo's `website/` folder.
- Windows installer builds via `npm run build:win`; packaging fix in place (vendored three loaders).
- Repo `github.com/lykruban/deskbuddy` PUBLIC, branch `main`, push creds cached on the user's PC.
- Deploy an update: push to `main` → on the server `cd /opt/deskbuddy && git pull && sudo systemctl
  restart deskbuddy-api deskbuddy-web`.

---

## 1. Website — BUILT in `fable-website/`; review → media → go live  ⭐
- **What:** the from-scratch interactive site is DONE and verified (see `fable-website/README.md`):
  live VRM buddy in the hero (walks, docks + follows on scroll, cycles characters, load-your-own,
  sarcastic per-section speech bubbles), gallery with config-driven media slots, versus, features,
  pricing, waitlist (already wired to `POST /api/waitlist`), full download flow, CTAs throughout.
  All swappables live in `fable-website/config.js`. Headless-verified: buddy loads with zero errors.
- **Remaining:** (a) user reviews the design and requests tweaks; (b) drop real screenshots/loops
  into `fable-website/media/` + set `src` in config (task 4); (c) set `DOWNLOAD_URL` (task 2);
  (d) go live: point the server's `deskbuddy-web` service root at `/opt/deskbuddy/fable-website`
  (or copy over `website/`), then `git pull` + restart on the server.
- **Done when:** deskbuddy.yuvexel.com serves it with real media and a working download.

## 2. Host the installer + wire the download link
- **What:** a public URL for `DeskBuddy Setup 1.0.0.exe` so the site's download button works.
- **How (recommended):** create a **GitHub Release** on `lykruban/deskbuddy` and attach the installer
  (Releases support large binaries; the 100MB exe can't live in git). Via web UI: Releases → Draft
  new release → tag `v1.0.0` → attach `dist/DeskBuddy Setup 1.0.0.exe` (+ the Portable exe) → publish.
  (Or `gh release create v1.0.0 "dist/DeskBuddy Setup 1.0.0.exe" ...` if `gh` is installed.) Then set
  the site's `DOWNLOAD_URL` to that asset link. Alternative: serve the exe from the server.
- **Needs from user:** they can create the release, or ask them to run the `gh`/UI steps.
- **Done when:** anyone can download + install from the site.

## 3. Waitlist endpoint — DONE (verify only)
- `POST /api/waitlist {email}` is implemented in `src/server/server.js` (dedupes into
  `dataDir/waitlist.json`). After deploy, verify: `curl -X POST https://api.yuvexel.com/api/waitlist
  -H "Content-Type: application/json" -d '{"email":"a@b.com"}'` → `{ok:true}`.

## 4. Real screenshots / demo media
- **What:** replace placeholder gallery/hero media with real captures: buddy on desktop, a
  multi-monitor scene with the character walking through a door, Character Studio, Scene Editor,
  example characters/scenes. Short silent-loop GIFs/MP4s are gold for this category.
- **How:** run the app (`npm start`), capture; drop files into the site's media manifest/config.
- **Needs from user:** they may want to record these themselves (their monitors/characters).

## 5. Marketplace — make SCENES publishable
- **What:** characters + animation packs already publish; scenes don't. Scenes reference separate
  background image files, so publishing needs **bundling** + a server `scene` type end-to-end.
- **How:** on publish, inline a scene's images (base64) into one self-contained blob (mirror how
  `save-scene` in `main.js` handles `_bgData`/`_dataUrl`); add server routes for `type:'scene'`
  (list/get/upload/download/purchase — the JSON store is already generic); add scenes to the publish
  library in `marketplace.js` (currently only characters + anim packs); on download, unpack images
  back into the scenes dir. Add a "Scenes" browse tab.
- **Done when:** a scene can be published and re-installed with its images intact.

## 6. Marketplace — unify login onto the shared session
- **What:** `marketplace.js` has its own localStorage auth; the rest of the app uses the shared
  main-process session (`auth-*` IPC). Unify so one login covers marketplace + Studio.
- **How:** replace marketplace's localStorage token flow with the preload `authState/authLogin/
  authSignup/authLogout` (already exposed); the shared `SERVER_BASE` already points at prod.

## 7. Google (and other) OAuth login  — needs user + Google Cloud
- **What:** "Sign in with Google" (deferred earlier; the HTTPS server now exists so it's unblocked).
- **How:** desktop OAuth pattern — app opens the system browser to
  `https://api.yuvexel.com/api/auth/google` → Google → callback on the server → server mints a
  session token → hand back to the app (loopback port or a `deskbuddy://` custom protocol). Add the
  server endpoints + a "Sign in with Google" button in the Studio/marketplace gates.
- **Needs from user:** a Google Cloud OAuth client (client id/secret + authorized redirect URI
  `https://api.yuvexel.com/api/auth/google/callback`). Ask before building.

## 8. Code-signing (removes the Windows SmartScreen warning)  — costs money + identity
- **What:** signed installer so users don't see "unknown publisher".
- **How:** buy a cert and wire electron-builder signing. **Azure Trusted Signing (~$10/mo)** is the
  cheapest cloud option; an **EV cert** gives instant SmartScreen trust (pricier). No more simple
  .pfx files (2023 rule). Then set the signing config in `package.json` build / `win.signtoolOptions`.
- **Needs from user:** purchase + identity verification (their sole-prop/Yuvexel entity helps).
  Ask which route; don't spend money without confirmation.

## 9. Render quality (overlay.js)  — visual; verify with the user
- **What:** make scenes look less "cheap". Ordered:
  1. **Quick wins:** `renderer.toneMapping = ACESFilmicToneMapping` + per-scene exposure (set bg/fg/
     shadow materials `toneMapped=false` to keep the photo un-graded); tint+soften the contact shadow;
     sample the real bg color under the feet for the bounce fill (replaces the flat hemisphere).
  2. **Bake pipeline:** on scene save, precompute + store in the scenepack a PMREM env map (IBL) + a
     9-coeff SH light probe + key-light dir/color → cheap, real light-bounce at runtime.
  3. **Perspective camera:** replace the ORTHOGRAPHIC `sceneCam` (`overlay.js` ~L400) + `depthScaleAt`
     heuristic with a PerspectiveCamera derived from the floor-quad homography → the character sits
     correctly in photographed scenes.
- **Note:** the user tests rendering visually on dual monitors — confirm before committing each step.

## 10. Voice companion (Pro feature)  — explored, deferred
- **What:** the character says context-aware quips ("ooh, watching a video?"). One-way to start.
- **How:** poll the foreground window title (PowerShell/Win32) → classify activity → speak via the
  Web Speech API with canned lines per activity + a chattiness/mute/volume panel. Premium later:
  cloud TTS + LLM-written lines + lip-sync. Personality (cheeky / cute / chill / hyper) is still
  UNCHOSEN — ask the user.

## 11. Housekeeping (nice-to-have)
- Trim `src/vendor/three-jsm/` (15MB, mostly unused) to only the imported loaders + their deps — test
  the packaged build after (that's what broke before).
- Don't start the redundant in-app local server when `SERVER_BASE` is remote.
- Revisit `asar: true` (smaller/obfuscated) — but re-verify packaged renderer loading via the CDP
  method in CLAUDE.md before shipping.
- Marketplace IP/moderation policy + takedown process before it opens (users will upload copyrighted
  characters).
