# DeskBuddy — Handoff (Linux → Windows)

This doc briefs a fresh Claude Code session (on Windows) on the project, everything built
so far, the Windows-specific work remaining, and the plan for packaging + DRM for a paid
release. The **code is the source of truth**; this fills in the *why* and the *gotchas*.

---

## 1. What the app is

DeskBuddy is an **Electron desktop-pet / living-wallpaper** app.

- **Buddy mode:** a 3D character (VRM or GLB) sits on the desktop as a clickable pet.
- **Scene mode (living wallpaper):** the character walks a **perspective floor** over a
  background that becomes the desktop wallpaper, with props it walks in front of/behind,
  per-light coloured lighting, projected shadows, and clickable props that trigger animations.
- **Character Studio:** import models, retarget animations, build/edit scenes.
- **Marketplace:** browse + publish characters/animation packs (local Express API on `:4242`).

**Stack:** Electron, Three.js, `@pixiv/three-vrm`, Express + Multer (server), electron-builder.

### Source layout
```
src/main/main.js          Electron main: windows, tray menu, IPC, wallpaper mode, single-instance lock
src/main/preload.js       contextBridge (window.deskbuddy.*)
src/overlay/overlay.*     the character/scene renderer window (buddy + wallpaper)
src/studio/studio.*       Character Studio (import, animation, SCENE EDITOR)
src/marketplace/*         marketplace browser + publish modal
src/scene/scenepack.js    .scenepack data model + normalization
src/scene/floor.js        floor PERSPECTIVE math (homography) — pure, unit-testable
src/scene/behavior.js     the "brain": where the character walks / which clip plays
src/server/server.js      Express marketplace API (port 4242)
src/server/store.js       server data store
assets/icons/             ⚠️ EMPTY — needs icon.ico / icon.icns / icon.png before building
```

### Where data lives
User data (settings, characters, scenes, animations) in Electron `userData`:
- Linux: `~/.config/deskbuddy/`
- **Windows: `%APPDATA%/deskbuddy/`** (created automatically)
Files: `settings.json`, `characters/`, `scenes/*.scenepack`, `animations/*.animpack`.

---

## 2. What was built/changed in the last session (all working on Linux)

- **Scene editor dropdown bug** fixed (`defaultEditorScene()` produced a flat shadow with no
  `lights[]`, which threw in `renderShadowLights()` and aborted populating the scene list).
- **Floor perspective rewrite** (`src/scene/floor.js`): replaced bilinear interpolation with a
  proper **projective homography** (square→quad, Heckbert). `floorToScreen`, inverse
  `screenToFloor` (adjugate), `widthAt`, `depthScaleAt` all updated. Fixes character placement,
  anchors, props, shadow base. Pure module — `node` round-trip tested.
- **Studio scene editor:** fullscreen stage toggle; floor-quad corners draggable OUTSIDE the
  image (padded viewport, `STAGE_PAD`); draggable lights; **prop drag + size** (matches overlay
  size now — editor used 0.42, overlay uses FG_BASE_HEIGHT/2 = 0.75).
- **Lights redesigned** (`scenepack.js` `defaultLight`/`normalizeLight`): floor-positioned
  `{u,v,height,distance,mode:'directional'|'point',angleAdjust,showGlow,color,intensity,softness}`.
  Draggable ☀ on the floor, height affects shadow length, perspective-correct. Legacy
  `{angle,length}` auto-migrates.
- **Shadows:** rewritten from a screen-space shear (which collapsed to a line / ghosted as "3
  shadows") to a **flat decal projected onto the floor quad** (`side: DoubleSide`,
  `frustumCulled=false`), plus an always-on **contact shadow** under the feet, **smoothed
  silhouette bbox** (de-jitters dance animations), and a **filled 25-tap Gaussian** blur (no
  ghost copies; 0 softness = crisp). One shadow per light, perspective-correct direction.
- **Light & Shadow quality** tray submenu: Off / On (colour bounce) / High (rendered) — drives
  GI hemisphere bounce + shadow blur strength.
- **Per-character size in a scene:** `scene.charScales[charFilename]` + a slider in Scene
  settings ("Size of the chosen character in this scene").
- **Scene ↔ character binding:** `scene.character` (filename). Overlay auto-loads that character
  when the scene plays.
- **Character rotation persisted:** the Studio's saved `rotation` is now folded into scene-mode
  facing (`modelBaseRotX/Y/Z`) so a character turned to face front no longer "walks backwards".
- **No auto-play** of an animation when loading a character into the Studio; **rename fix** for
  saved characters (was orphaning the old file).
- **Full-screen wallpaper window:** `enter-wallpaper-mode` sets bounds to the full display so the
  floor matches the desktop wallpaper and the shadow isn't clipped at the taskbar. (WM may still
  clamp to the work area; the renderer sizes to its actual window — see §3.)
- **Marketplace Publish** rewritten: instead of a manual file picker, it lists the user's whole
  **Studio library** (characters + animation packs) with **sorting** (name/type/recent — needs
  `mtime`, added to the list IPCs) and **multi-select**; publishes each selected item.
- **Layers:** props have a `layer` (0 = auto by depth, <0 behind character, >0 in front).
  Scene settings has a **draggable layer list** (drop above the Character row = front, on the
  lower half / on the Background row = behind). Overlay renders by layer.
- **Clickable props** (see §3 — this is the main Windows item).
- **Single-instance lock** added (`app.requestSingleInstanceLock()`), so two copies can't run and
  fight over click-through.

---

## 3. ⚠️ WINDOWS WORK TO DO (priority order)

### 3a. Clickable props — replace the Linux hack with the NATIVE Windows path
**Background:** clicking a prop in scene mode should make the character walk over and play that
prop's animation. The window is normally click-through (so the desktop works); it must become
interactive ONLY while the cursor is over a prop.

On **Linux/Wayland this is broken**: `screen.getCursorScreenPoint()` is frozen and
`setIgnoreMouseEvents(..., { forward: true })` is unsupported. So the current code spawns a
**Python (`python-xlib`) helper** that streams the real cursor position to `main.js`, which
per-hover toggles `setIgnoreMouseEvents`. It works but is fragile (we left it "good enough").

**On Windows both native APIs WORK**, so do it the clean way and you can DELETE the Python helper:
1. In `enter-wallpaper-mode` (or when prop-clicking is on), call
   `win.setIgnoreMouseEvents(true, { forward: true })`. The renderer then RECEIVES `mousemove`
   even while click-through.
2. In `overlay.js`, on `mousemove`, hit-test the cursor against prop rects (`fgSprites[].rect`,
   already computed in `layoutForegrounds`, in 0..1 of the canvas via `getBoundingClientRect`).
   When over a clickable prop, ask main to set `setIgnoreMouseEvents(false)`; otherwise
   `setIgnoreMouseEvents(true, {forward:true})`. Click handler already calls `triggerPropAt`.
3. **Platform-branch it.** Keep the helper for `process.platform === 'linux'`; use the
   forward-based path for `win32`/`darwin`. Relevant code:
   - `main.js`: `PY_POINTER`, `onCursor`, `startCursorHelper`/`stopCursorHelper`,
     `applySceneInteractive`, `setInteractive`, `set-scene-interactive`, `set-prop-hitboxes`,
     the watchdog. (`spawn` import too.)
   - `overlay.js`: `sendPropHitboxes`, `triggerPropAt`, the `mousemove` cursor handler, the
     `set-scene-interactive` call in `loadScene`, the **Clickable props** tray toggle (`propClicks`).
   - `preload.js`: `setSceneInteractive`, `setPropHitboxes`.
   The clickable-prop requirement: a prop is clickable when its anchor is enabled AND has an
   `animation` (`item.anchor?.enabled && item.anchor.animation`). Verified working via the
   behavior sim (`behavior.goToAnchor`).

### 3b. Desktop wallpaper integration
- `setSceneWallpaper`/`clearSceneWallpaper`/`restoreWallpaper(Sync)` in `main.js` currently use
  **GNOME `gsettings`** (Linux/GNOME only). On Windows, set the desktop wallpaper via
  `SystemParametersInfo(SPI_SETDESKWALLPAPER)` — e.g. shell out to PowerShell, or use a small
  native helper, or the `wallpaper` npm package. Back up + restore the user's original.
- **Decide the model:** (a) set the real desktop wallpaper to the scene background AND float a
  transparent click-through overlay for the character/props (current Linux approach), or (b) a
  true **wallpaper-layer window** behind icons (Windows `WorkerW` trick). (a) is simpler and
  matches what we built; (b) looks more "native" but is more work.

### 3c. Wallpaper-mode window sizing / layering
- `enter-wallpaper-mode` does `setBounds(d.bounds)` (full display). On GNOME the WM clamps it to
  the work area; the renderer copes because the `resize` event re-runs `resizeCanvas` to the real
  inner size, and all hit-testing uses `getBoundingClientRect`. **On Windows verify** the
  borderless transparent always-on-top window actually covers the full screen and the floor lines
  up with the background. `setFullScreen()` was avoided on Linux (black surface); re-evaluate on Win.

### 3d. Strip Linux-only launch flags
- `package.json` `start` is `electron . --no-sandbox --ozone-platform=x11`. Make a
  `start:win`/cross-platform script without those. `app.commandLine.appendSwitch('ozone-platform','x11')`
  is already guarded by `process.platform === 'linux'` — leave it.

### 3e. Build assets
- **`assets/icons/` is empty.** Add `icon.ico` (Win, 256px multi-res), `icon.icns` (mac),
  `icon.png` (Linux) before `npm run build:win`, or electron-builder fails.

---

## 4. Packaging the `.exe`

`package.json` already has electron-builder config (NSIS target, win/mac/linux). On Windows:
```
npm install
npm run build:win        # → dist/ NSIS installer
```
- **Code-signing** (do this — unsigned installers hit SmartScreen): get a code-signing cert
  (OV/EV). Point electron-builder at it via `CSC_LINK` + `CSC_KEY_PASSWORD` env vars, or
  `build.win.certificateFile`. Keep certs OUT of git (already in `.gitignore`).
- Set a real `build.appId`, author, and a proper version scheme.

---

## 5. DRM / "hard to crack" — realistic plan

Be honest with expectations: Electron apps are **inherently crackable** (the JS lives in
`app.asar`, which anyone can extract). You can raise the bar a lot, but not to "uncrackable".
The durable protection is **server-side**, not client-side. Recommended layers:

1. **Server-side licensing (the real protection).** Premium content (marketplace downloads,
   premium scenes/characters) lives behind YOUR backend and is only served to a validated
   license. The existing Express server is a starting point but the production validator should
   be on a server you control, not bundled.
2. **License-key activation.** On launch, validate a key against the backend; cache an activation
   token with an expiry + offline grace period; bind to a machine fingerprint (soft).
3. **Bundle hardening (raises effort, not a wall):**
   - electron-builder ships an `app.asar` already; enable **asar integrity** checks.
   - Compile sensitive modules to V8 bytecode with **`bytenode`** (license check, premium logic).
   - Obfuscate the license/activation module (`javascript-obfuscator`).
4. **Don't ship secrets in the client.** No private API keys, no "if(licensed)" gate that's a
   single client-side boolean — gate the actual *content/feature* server-side.

A reasonable v1: license activation + server-gated premium content + asar integrity + bytecode
the license module. Iterate from there.

---

## 6. Environment gotchas / notes

- **Single instance:** `app.requestSingleInstanceLock()` — a 2nd launch exits. (Good on all OS.)
- **Local server** runs on **port 4242** (`startServer`). Ensure it's free / configurable.
- **Linux cursor helper** needs `python3` + `python-xlib` — **Windows does not need this** (delete
  that path for win32).
- `floor.js`, `scenepack.js`, `behavior.js` are pure and unit-testable with plain `node`
  (`node --input-type=module -e '...'`) — handy for sanity checks.
- This session verified features with: `node --check` (syntax), pure-function tests, an offscreen
  WebGL harness (shader compiles + pixel readback), and an Electron harness loading the studio/
  marketplace HTML with stubbed IPC. Reuse those patterns on Windows.

---

## 7. Suggested first steps on Windows

1. `git clone` this repo, `npm install`.
2. Add real icons to `assets/icons/`.
3. `npm start` (make a win script) — confirm buddy mode + scene mode render.
4. Do §3a (native click-through) and §3b (wallpaper) — the two real Windows ports.
5. `npm run build:win`, then set up signing.
6. Layer in the licensing (§5) before any public/paid release.
