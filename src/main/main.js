const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, nativeImage, powerMonitor, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec, execSync, spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(exec);
const { startServer, stopServer, PORT } = require('../server/server');

// Force the X11/XWayland backend. On native Wayland, Electron's setIgnoreMouseEvents
// (click-through) and setPosition are no-ops, which broke scene mode (the full-screen
// overlay swallowed every click). Under XWayland these work properly. Must be set
// before app is ready. Honoured on Linux; harmless elsewhere.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  // Dev/AppImage sandboxing often fails on Linux; previously passed as a CLI flag in
  // the `start` script, now applied here so the script is cross-platform.
  app.commandLine.appendSwitch('no-sandbox');
}

// Single instance only. Multiple overlays would each toggle scene click-through
// independently and fight each other (props flicker between clickable/not). If another
// instance already holds the lock, bail out immediately.
if (!app.requestSingleInstanceLock()) { app.exit(0); }

let overlayWindow = null, studioWindow = null, marketplaceWindow = null, tray = null;

const CHARACTERS_DIR  = path.join(app.getPath('userData'), 'characters');
const ANIMATIONS_DIR  = path.join(app.getPath('userData'), 'animations');
const SCENES_DIR      = path.join(app.getPath('userData'), 'scenes');
const SETTINGS_FILE   = path.join(app.getPath('userData'), 'settings.json');

// Importable 3D model formats (charpack = our saved bundle).
const MODEL_EXTS  = ['glb', 'gltf', 'vrm', 'fbx', 'obj', 'dae', 'stl', 'ply', '3mf', 'charpack'];
const MODEL_EXT_RE = new RegExp('\\.(' + MODEL_EXTS.join('|') + ')$', 'i');
const ANIM_EXTS   = ['fbx', 'bvh', 'glb', 'gltf'];

function ensureDirs() {
  [CHARACTERS_DIR, ANIMATIONS_DIR, SCENES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// Seed a starter scene the first time so scene mode is testable before the editor
// exists. background:null → the overlay draws a generated placeholder backdrop.
// Anchors use animation:null so they fall back to the character's idle clip — the
// character just strolls between spots, which is exactly the mechanic to verify.
function seedSampleScene() {
  try {
    ensureDirs();
    const dest = path.join(SCENES_DIR, 'sample-scene.scenepack');
    if (fs.existsSync(dest)) return;
    const sample = {
      version: 1, name: 'Sample Scene', background: null, foreground: null,
      floor: { farLeft:{x:0.28,y:0.50}, farRight:{x:0.72,y:0.50}, nearLeft:{x:0.06,y:0.95}, nearRight:{x:0.94,y:0.95} },
      anchors: [
        { id:'a1', label:'Left',   u:0.15, v:0.85, facing:'right', animation:null, offset:{x:0,y:0}, weight:2 },
        { id:'a2', label:'Center', u:0.50, v:0.40, facing:'front', animation:null, offset:{x:0,y:0}, weight:1 },
        { id:'a3', label:'Right',  u:0.85, v:0.80, facing:'left',  animation:null, offset:{x:0,y:0}, weight:2 },
      ],
      wander: { enabled:true, idleMin:3, idleMax:7, walkSpeed:0.16 },
      shadow: { enabled:true },
    };
    fs.writeFileSync(dest, JSON.stringify(sample, null, 2));
  } catch (e) { console.error('seedSampleScene:', e.message); }
}

function listScenesSync() {
  try {
    ensureDirs();
    return fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.scenepack')).map(f => {
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8')); } catch {}
      return { filename: f, name: manifest.name || f.replace(/\.scenepack$/, ''), path: path.join(SCENES_DIR, f), manifest };
    });
  } catch { return []; }
}

function loadSettings() {
  try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return { scale: 1.0, activeCharacter: null, position: { x: 80, y: 80 }, alwaysOnTop: true, shadow: true, quality: 'medium', fps: 60 };
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

// ── Windows ───────────────────────────────────────────────────────────────────
function createOverlayWindow() {
  const s = loadSettings();
  overlayWindow = new BrowserWindow({
    width: 300, height: 560,
    x: s.position?.x ?? 80, y: s.position?.y ?? 80,
    transparent: true, frame: false,
    alwaysOnTop: s.alwaysOnTop !== false,
    skipTaskbar: true, resizable: false, hasShadow: false, focusable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  overlayWindow.loadFile(path.join(__dirname, '../overlay/overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });

  // Persist position after the user drags the window (via -webkit-app-region:drag
  // in the overlay). Debounced; getPosition is a no-op on Wayland but harmless.
  let savePosTimer = null;
  overlayWindow.on('moved', () => {
    // Tell the overlay a drag finished so it can auto-exit "move mode" (X11/Win/
    // macOS fire this; Wayland may not — the move-mode banner has a Done button as
    // the reliable fallback there).
    overlayWindow.webContents.send('overlay-moved');
    clearTimeout(savePosTimer);
    savePosTimer = setTimeout(() => {
      if (!overlayWindow) return;
      const [x, y] = overlayWindow.getPosition();
      const s = loadSettings(); s.position = { x, y }; saveSettings(s);
    }, 400);
  });
}

function createStudioWindow() {
  if (studioWindow) { studioWindow.focus(); return; }
  studioWindow = new BrowserWindow({
    width: 1160, height: 740, title: 'DeskBuddy Studio',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  studioWindow.loadFile(path.join(__dirname, '../studio/studio.html'));
  studioWindow.on('closed', () => { studioWindow = null; });
}

function createMarketplaceWindow() {
  if (marketplaceWindow) { marketplaceWindow.focus(); return; }
  marketplaceWindow = new BrowserWindow({
    width: 1040, height: 720, title: 'DeskBuddy Marketplace',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  marketplaceWindow.loadFile(path.join(__dirname, '../marketplace/marketplace.html'));
  marketplaceWindow.on('closed', () => { marketplaceWindow = null; });
}

// Tray menu — the primary control surface while a scene is active (the full-screen
// wallpaper overlay is click-through, so the character itself can't be clicked).
// Rebuilt via refreshTray() whenever the scene state changes so "Exit Scene" and
// the active-scene radio stay in sync.
let currentScenePath = null;
function trayTemplate() {
  const sendCmd = (a) => overlayWindow?.webContents.send('menu-command', a);
  const scenes = listScenesSync();
  return [
    { label: notifUnread > 0 ? `📬 Messages (${notifUnread})` : '📬 Messages', click: openStudioNotifications },
    { type: 'separator' },
    { label: 'Show Buddy',       click: () => overlayWindow?.show() },
    { label: 'Hide Buddy',       click: () => overlayWindow?.hide() },
    { type: 'separator' },
    { label: currentScenePath ? 'Scene  ●' : 'Scene', submenu: [
        ...scenes.map(s => ({
          label: s.name, type: 'radio', checked: currentScenePath === s.path,
          click: () => sendCmd('scene:' + s.path),
        })),
        ...(scenes.length ? [{ type: 'separator' }] : []),
        { label: 'Exit Scene', enabled: !!currentScenePath, click: () => sendCmd('scene:exit') },
    ] },
    { label: 'Buddy Menu…',      click: () => sendCmd('open-menu') },
    // Click-to-move (display targeting now lives in Character Studio → Scene settings).
    { label: 'Click to Move', type: 'checkbox', checked: loadSettings().clickToMove === true,
      click: () => { const s = loadSettings(); s.clickToMove = !(s.clickToMove === true); saveSettings(s); sendCmd('clickmove'); refreshTray(); } },
    // (Behind Desktop Icons removed for now — reparenting the transparent, GPU-accelerated
    // overlay into the WorkerW wallpaper layer crashes Chromium's compositor. The scene just
    // floats in front of the icons until that's reworked.)
    // Quality also drives shadow quality (low/medium/high) — exposed here so it's
    // adjustable while a scene plays (the buddy itself is click-through then). We persist
    // it in main too so the radio reflects the choice when the tray menu reopens.
    { label: 'Quality', submenu: ['low', 'medium', 'high'].map(q => ({
        label: q[0].toUpperCase() + q.slice(1), type: 'radio',
        checked: (loadSettings().quality || 'medium') === q,
        click: () => { const s = loadSettings(); s.quality = q; saveSettings(s); sendCmd('quality:' + q); refreshTray(); },
    })) },
    { label: 'Frame rate', submenu: [30, 60, 120].map(n => ({
        label: n + ' FPS', type: 'radio', checked: Number(loadSettings().fps || 60) === n,
        click: () => { const s = loadSettings(); s.fps = n; saveSettings(s); sendCmd('fps:' + n); refreshTray(); },
    })) },
    { label: 'Light & Shadow', submenu: (() => {
        const lm = loadSettings().lightMode;
        const cur = lm === 'high' ? 'high' : (lm === 'low' || lm === 'off') ? 'low' : 'medium';
        return [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([m, label]) => ({
          label, type: 'radio', checked: cur === m,
          click: () => { const s = loadSettings(); s.lightMode = m; saveSettings(s); sendCmd('lightmode:' + m); refreshTray(); },
        }));
      })() },
    { label: 'Cast Shadow', type: 'checkbox', checked: loadSettings().shadow !== false,
      click: () => { const s = loadSettings(); s.shadow = !(s.shadow !== false); saveSettings(s); sendCmd('shadow'); refreshTray(); },
    },
    { type: 'separator' },
    { label: 'Character Studio', click: createStudioWindow },
    { label: 'Marketplace — Coming Soon', enabled: false },
    { type: 'separator' },
    { label: `DeskBuddy v${app.getVersion()}  ·  © 2026 Yuvexel`, enabled: false },
    { label: 'Quit DeskBuddy',   click: () => app.quit() },
  ];
}
function refreshTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayTemplate())); }
// Change which display(s) a scene targets; reload the active scene so the new bounds +
// wallpaper (span vs single) take effect immediately.
function setSceneDisplay(v) {
  const s = loadSettings(); s.sceneDisplay = v; saveSettings(s); refreshTray();
  if (currentScenePath) overlayWindow?.webContents.send('menu-command', 'scene:' + currentScenePath);
}
function createTray() {
  const iconPath = path.join(__dirname, '../../assets/icons/tray.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('DeskBuddy');
  refreshTray();
  tray.on('double-click', () => overlayWindow?.show());
}

// ── IPC: window ───────────────────────────────────────────────────────────────
// Dragging the overlay is done natively in the renderer via
// `-webkit-app-region: drag` (overlay.html) — the only mechanism that works on
// Wayland. Position is persisted from the window's own `moved` event above.
ipcMain.handle('get-window-pos', () => overlayWindow?.getPosition() ?? [80, 80]);
ipcMain.handle('resize-overlay', (_, [w, h]) => { overlayWindow?.setSize(Math.round(w), Math.round(h)); });
// Native grab-and-drag (Windows/macOS): the renderer streams absolute positions while
// the user drags the buddy. No-op while maximized/in a scene (setBounds owns position then).
ipcMain.handle('move-overlay-to', (_, [x, y]) => {
  if (!overlayWindow || overlayWindow.isMaximized()) return;
  try { overlayWindow.setPosition(Math.round(x), Math.round(y)); } catch {}
});

// Screen geometry — used to detect/sit on the taskbar. `workArea` excludes the
// taskbar/panels, so its bottom edge is the taskbar's top edge.
ipcMain.handle('get-work-area', () => {
  const b = overlayWindow ? overlayWindow.getBounds() : null;
  const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay();
  return { workArea: d.workArea, bounds: d.bounds, scaleFactor: d.scaleFactor };
});
ipcMain.handle('get-overlay-bounds', () => overlayWindow?.getBounds() ?? null);

// Best-effort: drop the window so its bottom rests on the taskbar top, keeping x.
// setPosition is honoured on X11/Windows/macOS; it's a no-op on Wayland.
ipcMain.handle('dock-overlay-bottom', () => {
  if (!overlayWindow) return null;
  const b  = overlayWindow.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  overlayWindow.setPosition(Math.round(b.x), Math.round(wa.y + wa.height - b.height));
  return overlayWindow.getBounds();
});

// ── IPC: native right-click menu ───────────────────────────────────────────────
// A native popup menu isn't clipped by the tiny overlay window (an HTML menu is),
// so every option — including Studio — is reachable by right-clicking anywhere on
// the character. Clicks are routed back to the overlay as 'menu-command'.
ipcMain.handle('show-context-menu', (_, p = {}) => {
  if (!overlayWindow) return;
  const send = (a) => overlayWindow.webContents.send('menu-command', a);
  const f = p.flags || {};
  const custom = Array.isArray(p.custom) ? p.custom : [];
  const tmpl = [
    { label: `DeskBuddy${p.stateLabel ? ' · ' + p.stateLabel : ''}`, enabled: false },
    { type: 'separator' },
    { label: '✥  Move / Reposition', click: () => send('move') },
    { type: 'separator' },
    { label: 'Character Studio', click: () => send('studio') },
    { label: 'Marketplace — Coming Soon', enabled: false },
    { type: 'separator' },
    { label: 'Scene', submenu: [
        ...listScenesSync().map(s => ({
          label: s.name, type: 'radio', checked: p.scene === s.path,
          click: () => send('scene:' + s.path),
        })),
        ...(listScenesSync().length ? [{ type: 'separator' }] : []),
        { label: 'Exit Scene', enabled: !!p.scene, click: () => send('scene:exit') },
    ] },
    { type: 'separator' },
    { label: 'Poke / React',   click: () => send('poke') },
    { label: 'Sit on taskbar', type: 'checkbox', checked: !!f.sit, click: () => send('sit') },
    ...(custom.length
      ? [{ type: 'separator' }, ...custom.map(c => ({ label: '▶  ' + c.label, click: () => send('trigger:' + c.id) }))]
      : []),
    { type: 'separator' },
    { label: 'Quality', submenu: ['low', 'medium', 'high'].map(q => ({
        label: q[0].toUpperCase() + q.slice(1), type: 'radio', checked: p.quality === q, click: () => send('quality:' + q) })) },
    { label: 'Frame rate', submenu: [30, 60, 120].map(n => ({
        label: n + ' FPS', type: 'radio', checked: Number(p.fps) === n, click: () => send('fps:' + n) })) },
    { label: 'Light & Shadow', submenu: (() => {
        const cur = f.lightMode === 'high' ? 'high' : (f.lightMode === 'low' || f.lightMode === 'off') ? 'low' : 'medium';
        return [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([m, label]) => ({
          label, type: 'radio', checked: cur === m, click: () => send('lightmode:' + m),
        }));
      })() },
    { label: 'Clickable props', type: 'checkbox', checked: f.propClicks !== false, click: () => send('propclicks') },
    { type: 'separator' },
    { label: 'Bigger  (+20%)', click: () => send('bigger') },
    { label: 'Smaller (−20%)', click: () => send('smaller') },
    { label: 'Reset Size',     click: () => send('reset-size') },
    { type: 'separator' },
    { label: 'Always on Top', type: 'checkbox', checked: !!f.top,      click: () => send('top') },
    { label: 'Click-Through', type: 'checkbox', checked: !!f.through,   click: () => send('through') },
    { label: 'Cast Shadow', type: 'checkbox', checked: !!f.shadow,      click: () => send('shadow') },
    { label: 'Shadow Settings…', click: () => send('shadow-settings') },
    { label: 'Feet on Ground', type: 'checkbox', checked: !!f.grounded, click: () => send('grounded') },
    { type: 'separator' },
    { label: 'Save Screenshot', click: () => send('screenshot') },
    { label: 'Hide Buddy',      click: () => overlayWindow.hide() },
    { label: 'Quit DeskBuddy',  click: () => app.quit() },
  ];
  Menu.buildFromTemplate(tmpl).popup({ window: overlayWindow });
});

// Capture the overlay window (works even on Wayland, unlike OS screen grabs).
ipcMain.handle('save-screenshot', async () => {
  if (!overlayWindow) return null;
  try {
    const img = await overlayWindow.webContents.capturePage();
    const dir = app.getPath('pictures') || app.getPath('desktop');
    const file = path.join(dir, `deskbuddy-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch (e) { console.error('screenshot:', e.message); return null; }
});

// ── IPC: app-launch triggers ───────────────────────────────────────────────────
// The overlay registers the process names referenced by a character's custom
// states; we poll the process list and notify it when the running set changes.
let watchedApps = [];
let appPollTimer = null;
let lastRunningKey = '';
function pollApps() {
  if (!watchedApps.length || !overlayWindow) { lastRunningKey = ''; return; }
  const cmd = process.platform === 'win32' ? 'tasklist /fo csv /nh' : 'ps -A -o comm=';
  exec(cmd, { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => {
    if (err || !overlayWindow) return;
    const hay = stdout.toLowerCase();
    const running = watchedApps.filter(a => hay.includes(a.toLowerCase()));
    const key = running.slice().sort().join('|');
    if (key !== lastRunningKey) {
      lastRunningKey = key;
      overlayWindow.webContents.send('apps-changed', running);
    }
  });
}
ipcMain.handle('watch-apps', (_, apps) => {
  watchedApps = Array.isArray(apps) ? apps.filter(Boolean) : [];
  lastRunningKey = '';
  if (appPollTimer) { clearInterval(appPollTimer); appPollTimer = null; }
  if (watchedApps.length) { pollApps(); appPollTimer = setInterval(pollApps, 3000); }
  return true;
});

// ── IPC: settings ─────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, s) => { saveSettings(s); return true; });

// ── IPC: characters ───────────────────────────────────────────────────────────
ipcMain.handle('list-characters', () => {
  ensureDirs();
  return fs.readdirSync(CHARACTERS_DIR)
    .filter(f => MODEL_EXT_RE.test(f))
    .map(f => {
      const base = f.replace(MODEL_EXT_RE, '');
      const cPath = path.join(CHARACTERS_DIR, f);
      const jPath = cPath + '.json';
      let manifest = {};
      try { if (fs.existsSync(jPath)) manifest = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch {}
      let mtime = 0; try { mtime = fs.statSync(cPath).mtimeMs; } catch {}
      return { filename: f, name: manifest.name || base, path: cPath, mtime, manifest };
    });
});

ipcMain.handle('import-character', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Import Character',
    filters: [
      { name: '3D Models', extensions: MODEL_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0], filename = path.basename(src), dest = path.join(CHARACTERS_DIR, filename);
  fs.copyFileSync(src, dest);

  // OBJ/DAE keep materials + textures in sibling files — copy them alongside so
  // the studio can resolve them (referenced by basename in the .mtl).
  const ext = path.extname(src).slice(1).toLowerCase();
  if (ext === 'obj' || ext === 'dae') {
    try {
      const srcDir = path.dirname(src);
      for (const sib of fs.readdirSync(srcDir)) {
        if (/\.(mtl|png|jpe?g|tga|bmp|gif|webp)$/i.test(sib)) {
          try { fs.copyFileSync(path.join(srcDir, sib), path.join(CHARACTERS_DIR, sib)); } catch {}
        }
      }
    } catch (e) { console.error('copy assets:', e.message); }
  }
  return { filename, name: filename.replace(MODEL_EXT_RE, ''), path: dest };
});

ipcMain.handle('read-character-file', (_, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).buffer;
});

ipcMain.handle('save-charpack', (_, { name, glbData, manifest, originalPath }) => {
  ensureDirs();
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dest = path.join(CHARACTERS_DIR, `${safe}.charpack`);
  fs.writeFileSync(dest, Buffer.from(glbData));
  fs.writeFileSync(dest + '.json', JSON.stringify(manifest, null, 2));
  // If this was a rename of an existing saved character, remove the old files so the
  // edit replaces it instead of leaving a stale duplicate. Only touch our own
  // charpacks (never a freshly-imported source model living elsewhere).
  if (originalPath && originalPath !== dest
      && path.dirname(originalPath) === CHARACTERS_DIR && originalPath.endsWith('.charpack')) {
    try { fs.existsSync(originalPath) && fs.unlinkSync(originalPath); } catch {}
    try { fs.existsSync(originalPath + '.json') && fs.unlinkSync(originalPath + '.json'); } catch {}
    const s = loadSettings();
    if (s.activeCharacter === originalPath) { s.activeCharacter = dest; saveSettings(s); }
  }
  return dest;
});

ipcMain.handle('activate-character', (_, filePath) => {
  const s = loadSettings(); s.activeCharacter = filePath; saveSettings(s);
  overlayWindow?.webContents.send('character-changed', filePath);
  return true;
});

ipcMain.handle('delete-character', (_, filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(filePath + '.json')) fs.unlinkSync(filePath + '.json');   // sidecar manifest
    const s = loadSettings();
    if (s.activeCharacter === filePath) { s.activeCharacter = null; saveSettings(s); overlayWindow?.webContents.send('character-changed', null); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-scene', (_, scenePath) => {
  try {
    if (fs.existsSync(scenePath)) fs.unlinkSync(scenePath);
    const base = path.basename(scenePath).replace(/\.scenepack$/, '');
    for (const f of fs.readdirSync(SCENES_DIR)) {   // remove this scene's images
      if (f.startsWith(base + '-') && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f)) {
        try { fs.unlinkSync(path.join(SCENES_DIR, f)); } catch {}
      }
    }
    const s = loadSettings();
    if (s.activeScene === scenePath) { s.activeScene = null; saveSettings(s); }
    if (currentScenePath === scenePath) { currentScenePath = null; }
    refreshTray();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: animation packs ──────────────────────────────────────────────────────
ipcMain.handle('list-animation-packs', () => {
  ensureDirs();
  return fs.readdirSync(ANIMATIONS_DIR)
    .filter(f => f.endsWith('.animpack'))
    .map(f => {
      const p = path.join(ANIMATIONS_DIR, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      try { return { filename: f, path: p, mtime, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
      catch { return { filename: f, path: p, mtime, name: f, animations: [] }; }
    });
});

// ── Animation source library ───────────────────────────────────────────────────
// Imported animation FILES (FBX/GLB/BVH) are kept in the app so any character can reuse
// them: adding from the library re-imports + retargets the source for that character.
const ANIM_SRC_EXTS = ['fbx', 'glb', 'gltf', 'bvh'];
ipcMain.handle('save-animation-source', (_, { name, bytes, ext }) => {
  ensureDirs();
  const safe = (name || 'animation').replace(/[^a-zA-Z0-9_-]/g, '_');
  const e = ANIM_SRC_EXTS.includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'fbx';
  let dest = path.join(ANIMATIONS_DIR, `${safe}.${e}`), n = 1;
  while (fs.existsSync(dest)) dest = path.join(ANIMATIONS_DIR, `${safe}-${n++}.${e}`);
  fs.writeFileSync(dest, Buffer.from(bytes));
  return { ok: true, path: dest, filename: path.basename(dest) };
});
ipcMain.handle('list-animation-sources', () => {
  ensureDirs();
  return fs.readdirSync(ANIMATIONS_DIR)
    .filter(f => ANIM_SRC_EXTS.some(e => f.toLowerCase().endsWith('.' + e)))
    .map(f => {
      const p = path.join(ANIMATIONS_DIR, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      return { filename: f, name: f.replace(/\.[^.]+$/, ''), ext: (f.split('.').pop() || '').toLowerCase(), path: p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
});
ipcMain.handle('delete-animation-source', (_, p) => {
  try { if (p && fs.existsSync(p) && path.dirname(p) === ANIMATIONS_DIR) fs.unlinkSync(p); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Open file dialog for animation clips (Mixamo FBX, BVH mocap, animated glTF)
ipcMain.handle('import-fbx-animation', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Import Animation (FBX / BVH / glTF)',
    filters: [
      { name: 'Animations', extensions: ANIM_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  return { filename: path.basename(src), path: src }; // don't copy — just read in place
});

ipcMain.handle('import-animation-pack', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Import Animation Pack',
    filters: [{ name: 'Animation Packs', extensions: ['animpack', 'bvh'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0], filename = path.basename(src), dest = path.join(ANIMATIONS_DIR, filename);
  fs.copyFileSync(src, dest);
  return { filename, path: dest };
});

ipcMain.handle('save-animation-pack', (_, { name, data }) => {
  ensureDirs();
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dest = path.join(ANIMATIONS_DIR, `${safe}.animpack`);
  fs.writeFileSync(dest, JSON.stringify(data, null, 2));
  return dest;
});

ipcMain.handle('read-file-buffer', (_, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).buffer;
});

// ── IPC: misc ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-studio',      () => { createStudioWindow(); return true; });
ipcMain.handle('open-marketplace', () => { createMarketplaceWindow(); return true; });
ipcMain.handle('open-external',    (_, url) => shell.openExternal(url));
ipcMain.handle('set-always-on-top', (_, v) => {
  // 'floating' (not 'screen-saver') keeps the overlay above windows WITHOUT triggering
  // Windows' fullscreen-exclusive detection that hides the taskbar. Re-assert click-through
  // since setAlwaysOnTop drops the input-shape region.
  try { overlayWindow?.setAlwaysOnTop(!!v, 'floating'); } catch {}
  const s = loadSettings(); s.alwaysOnTop = v; saveSettings(s);
  const reassert = () => applySceneInteractive();
  reassert(); setTimeout(reassert, 80); setTimeout(reassert, 300);
});
ipcMain.handle('set-ignore-mouse', (_, v)  => { overlayWindow?.setIgnoreMouseEvents(v, { forward: true }); });
ipcMain.handle('get-idle-seconds', () => powerMonitor.getSystemIdleTime());
ipcMain.handle('get-server-port',  () => PORT);
ipcMain.handle('get-animations-dir', () => ANIMATIONS_DIR);
ipcMain.handle('get-characters-dir', () => CHARACTERS_DIR);
ipcMain.handle('get-scenes-dir',     () => SCENES_DIR);

// ── IPC: account / shared auth session ──────────────────────────────────────────
// One login for the whole app (Studio + Marketplace share it). The token is persisted
// in settings so it survives restarts. All auth goes over HTTP to SERVER_BASE so it
// behaves identically whether the backend is the in-app localhost server (now) or a
// remote deployed server (later — just point `serverBase` at the domain).
const SERVER_BASE = () => (loadSettings().serverBase || process.env.DESKBUDDY_SERVER || `http://127.0.0.1:${PORT}`);
async function authFetch(p, opts = {}) {
  const res  = await fetch(SERVER_BASE() + '/api' + p, opts);
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}
function getAuthToken() { return loadSettings().authToken || null; }
function setAuthToken(t) { const s = loadSettings(); if (t) s.authToken = t; else delete s.authToken; saveSettings(s); }
async function currentAccount() {
  const token = getAuthToken(); if (!token) return null;
  try { const r = await authFetch('/auth/me', { headers: { Authorization: 'Bearer ' + token } }); return r.ok ? (r.data?.user || null) : null; }
  catch { return null; }
}

ipcMain.handle('auth-server-base', () => SERVER_BASE());
ipcMain.handle('auth-state', async () => {
  const token = getAuthToken();
  if (!token) return { token: null, user: null };
  const user = await currentAccount();
  if (!user) { setAuthToken(null); return { token: null, user: null }; }   // stale/invalid → clear
  return { token, user };
});
ipcMain.handle('auth-login', async (_, { username, password } = {}) => {
  try {
    const r = await authFetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (r.ok && r.data?.token) { setAuthToken(r.data.token); return { ok: true, user: r.data.user }; }
    return { ok: false, error: r.data?.error || 'Login failed' };
  } catch { return { ok: false, error: 'Cannot reach the server' }; }
});
ipcMain.handle('auth-signup', async (_, { username, password, email } = {}) => {
  try {
    const r = await authFetch('/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, email }) });
    if (r.ok && r.data?.token) { setAuthToken(r.data.token); return { ok: true, user: r.data.user, recoveryCode: r.data.recoveryCode }; }
    return { ok: false, error: r.data?.error || 'Signup failed' };
  } catch { return { ok: false, error: 'Cannot reach the server' }; }
});
ipcMain.handle('auth-logout', async () => {
  const token = getAuthToken();
  if (token) { try { await authFetch('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch {} }
  setAuthToken(null);
  return { ok: true };
});
// Password recovery: email path (forgot → reset with token) and offline path (reset-code).
ipcMain.handle('auth-forgot', async (_, { email } = {}) => {
  try { const r = await authFetch('/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); return r.data || { ok: true }; }
  catch { return { ok: false, error: 'Cannot reach the server' }; }
});
ipcMain.handle('auth-reset', async (_, { token, password } = {}) => {
  try { const r = await authFetch('/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) }); return r.ok ? { ok: true } : { ok: false, error: r.data?.error || 'Reset failed' }; }
  catch { return { ok: false, error: 'Cannot reach the server' }; }
});
ipcMain.handle('auth-reset-code', async (_, { username, code, password } = {}) => {
  try { const r = await authFetch('/auth/reset-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, code, password }) }); return r.ok ? { ok: true, recoveryCode: r.data?.recoveryCode } : { ok: false, error: r.data?.error || 'Reset failed' }; }
  catch { return { ok: false, error: 'Cannot reach the server' }; }
});

// ── IPC: whole-library export / import ──────────────────────────────────────────
// Your "App Library" = the characters, animation packs, and scenes saved on this PC.
// Export copies ALL of it (incl. scene background images) into a portable folder you
// can move to another PC; import loads such a folder back in (merge or replace). The
// export is stamped with your account so it's linked to your login.
const LIB_DIRS = () => ({ characters: CHARACTERS_DIR, animations: ANIMATIONS_DIR, scenes: SCENES_DIR });
function copyDirInto(src, dest, replace) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dest, name);
    try {
      const st = fs.statSync(s);
      if (st.isDirectory()) { n += copyDirInto(s, d, replace); continue; }
      if (!replace && fs.existsSync(d)) continue;   // merge: don't clobber existing files
      fs.copyFileSync(s, d); n++;
    } catch {}
  }
  return n;
}
function emptyDir(dir) {
  try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {}
}

ipcMain.handle('export-library', async () => {
  const r = await dialog.showOpenDialog({ title: 'Export Library to…', buttonLabel: 'Export Here', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const root = path.join(r.filePaths[0], 'DeskBuddyLibrary');
  const dirs = LIB_DIRS(), counts = {};
  try { for (const k of Object.keys(dirs)) counts[k] = copyDirInto(dirs[k], path.join(root, k), true); }
  catch (e) { return { ok: false, error: e.message }; }
  const account = await currentAccount();
  const manifest = { app: 'DeskBuddy', kind: 'library-export', version: app.getVersion(), exportedAt: Date.now(),
    account: account ? { id: account.id, username: account.username } : null, counts };
  try { fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify(manifest, null, 2)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, path: root, counts, account: manifest.account };
});

ipcMain.handle('import-library', async () => {
  const r = await dialog.showOpenDialog({ title: 'Select a DeskBuddyLibrary folder', buttonLabel: 'Choose Folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  let root = r.filePaths[0];
  // Accept either the DeskBuddyLibrary folder itself or a parent that contains it.
  if (!fs.existsSync(path.join(root, 'library.json')) && fs.existsSync(path.join(root, 'DeskBuddyLibrary', 'library.json')))
    root = path.join(root, 'DeskBuddyLibrary');
  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8')); } catch {}
  if (!manifest || manifest.kind !== 'library-export') return { ok: false, error: 'No DeskBuddy library was found in that folder.' };
  const c = manifest.counts || {};
  const who = manifest.account?.username ? `\nExported by: ${manifest.account.username}` : '';
  const pick = await dialog.showMessageBox({
    type: 'question', title: 'Import Library', message: 'Import this library?',
    detail: `Characters: ${c.characters || 0}   Animations: ${c.animations || 0}   Scenes: ${c.scenes || 0}${who}\n\n` +
            `Merge — keep your current items and add these (duplicates skipped).\nReplace — clear your current library first, then load these.`,
    buttons: ['Merge', 'Replace', 'Cancel'], defaultId: 0, cancelId: 2, normalizeAccessKeys: true,
  });
  if (pick.response === 2) return { canceled: true };
  const replace = pick.response === 1;
  const dirs = LIB_DIRS(), counts = {};
  try {
    for (const k of Object.keys(dirs)) {
      fs.mkdirSync(dirs[k], { recursive: true });
      if (replace) emptyDir(dirs[k]);
      counts[k] = copyDirInto(path.join(root, k), dirs[k], replace);
    }
  } catch (e) { return { ok: false, error: e.message }; }
  refreshTray();   // newly imported scenes should appear in the tray Scene list
  return { ok: true, mode: replace ? 'replace' : 'merge', counts };
});

// ── IPC: in-app notifications / update messages ─────────────────────────────────
// A permanent, per-account message inbox. Messages are NEVER deleted. Two sources:
//  • a one-time personalised WELCOME on a user's first login, and
//  • dev ANNOUNCEMENTS pulled from the trusted server (SERVER_BASE) — so they can't be
//    injected locally; on the deployed server these can be signed for authenticity.
const NOTIF_FILE = path.join(app.getPath('userData'), 'notifications.json');
const DOT_ICON   = path.join(__dirname, '../../assets/icons/dot.png');
let notifUnread = 0;   // cached so the (synchronous) tray menu can show the count

function loadNotif() { try { return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); } catch { return { users: {} }; } }
function saveNotif(d) { try { fs.writeFileSync(NOTIF_FILE, JSON.stringify(d, null, 2)); } catch {} }
function welcomeMessage(username) {
  return {
    id: 'welcome', kind: 'welcome', title: `Welcome to DeskBuddy, ${username}! 🐾`,
    body: `Hey ${username} — so glad you're here. This is your message inbox: app updates, new features, and announcements land here, and nothing ever gets removed. Now go make a buddy, build a scene, and have fun. 💜`,
    link: '', ts: Date.now(), read: false,
  };
}
// Ensure the signed-in account has its welcome + any new dev announcements, recompute the
// unread badge, and return the account's messages (newest first). No-op if not signed in.
async function syncNotifications() {
  const user = await currentAccount();
  if (!user) { notifUnread = 0; updateNotifBadges(); return []; }
  const d = loadNotif(); d.users = d.users || {};
  const rec = d.users[user.id] || (d.users[user.id] = { welcomed: false, seen: [], messages: [] });
  let changed = false;
  if (!rec.welcomed) { rec.messages.push(welcomeMessage(user.username)); rec.welcomed = true; changed = true; }
  try {
    const r = await authFetch('/announcements');
    const anns = (r.ok && Array.isArray(r.data)) ? r.data : [];
    for (const a of anns) {
      if (!a || a.id == null) continue;
      const aid = String(a.id);
      if (rec.seen.includes(aid)) continue;
      rec.seen.push(aid);
      rec.messages.push({ id: 'ann:' + aid, kind: 'update', title: a.title || 'Update',
        body: a.body || '', link: a.link || '', ts: a.ts || Date.now(), read: false });
      changed = true;
    }
  } catch {}
  if (changed) saveNotif(d);
  notifUnread = rec.messages.filter(m => !m.read).length;
  updateNotifBadges();
  return rec.messages.slice().sort((a, b) => b.ts - a.ts);
}
function updateNotifBadges() {
  // Taskbar (Windows): a red dot overlay on the Studio window's taskbar button.
  if (studioWindow && !studioWindow.isDestroyed()) {
    try {
      if (notifUnread > 0 && fs.existsSync(DOT_ICON)) studioWindow.setOverlayIcon(nativeImage.createFromPath(DOT_ICON), `${notifUnread} new messages`);
      else studioWindow.setOverlayIcon(null, '');
    } catch {}
  }
  if (tray) tray.setToolTip(notifUnread > 0 ? `DeskBuddy · ${notifUnread} new message${notifUnread > 1 ? 's' : ''}` : 'DeskBuddy');
  refreshTray();
  studioWindow?.webContents.send('notifications-changed');
}
ipcMain.handle('notif-sync',   () => syncNotifications());
ipcMain.handle('notif-unread', () => notifUnread);
ipcMain.handle('notif-mark-read', async (_, ids) => {
  const user = await currentAccount(); if (!user) return { ok: true };
  const d = loadNotif(); const rec = d.users?.[user.id]; if (!rec) return { ok: true };
  const set = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;   // null → mark all
  for (const m of rec.messages) if (!set || set.has(String(m.id))) m.read = true;
  saveNotif(d);
  notifUnread = rec.messages.filter(m => !m.read).length;
  updateNotifBadges();
  return { ok: true, unread: notifUnread };
});
function openStudioNotifications() {
  const existed = !!studioWindow;
  createStudioWindow();
  const send = () => studioWindow?.webContents.send('studio-cmd', 'open-notifications');
  if (existed) { studioWindow.focus(); send(); }
  else studioWindow.webContents.once('did-finish-load', send);
}

// ── IPC: scenes (.scenepack) ───────────────────────────────────────────────────
ipcMain.handle('list-scenes', () => listScenesSync());

ipcMain.handle('save-scene', (_, { name, scenepack }) => {
  ensureDirs();
  const safe = (name || 'scene').replace(/[^a-zA-Z0-9_-]/g, '_');
  // New images arrive inlined as data URLs (`_bgData` on the scene, `_dataUrl` on
  // each foreground prop). Write them to disk and replace with the filename.
  const writeData = (dataUrl, suffix) => {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const ext = (dataUrl.slice(5, dataUrl.indexOf(';')).split('/')[1] || 'png').replace('jpeg', 'jpg');
    const fname = `${safe}-${suffix}.${ext}`;
    fs.writeFileSync(path.join(SCENES_DIR, fname), Buffer.from(dataUrl.split(',')[1], 'base64'));
    return fname;
  };
  // Write inlined images to disk for a room (or the legacy top-level), keyed so each
  // room's files don't collide.
  const writeRoomImages = (room, prefix) => {
    if (room._bgData) { const fn = writeData(room._bgData, prefix + 'bg'); if (fn) room.background = fn; }
    delete room._bgData;
    for (const it of (room.foregrounds || [])) {
      if (it._dataUrl) { const fn = writeData(it._dataUrl, prefix + (it.id || 'fg')); if (fn) it.image = fn; }
      delete it._dataUrl;
    }
  };
  writeRoomImages(scenepack, '');                       // legacy top-level (= room 0 mirror)
  if (Array.isArray(scenepack.rooms)) {
    scenepack.rooms.forEach((room, i) => writeRoomImages(room, `r${i}-`));
    // keep the top-level mirror (room 0) consistent with the written filenames
    if (scenepack.rooms[0]) { scenepack.background = scenepack.rooms[0].background; scenepack.foregrounds = scenepack.rooms[0].foregrounds; }
  }
  delete scenepack.foreground;   // drop the legacy single-foreground field
  const dest = path.join(SCENES_DIR, `${safe}.scenepack`);
  fs.writeFileSync(dest, JSON.stringify(scenepack, null, 2));
  refreshTray();   // a new/renamed scene should show up in the tray's Scene list
  // If this scene is the one currently playing, reload it so edited shadow/lighting
  // (and everything else) takes effect immediately instead of on next selection.
  if (currentScenePath === dest) overlayWindow?.webContents.send('menu-command', 'scene:' + dest);
  return { path: dest, scenepack };
});

// ── IPC: marketplace auto-install ──────────────────────────────────────────────
// Downloads from the marketplace install straight into the app: characters land in
// the character library (and activate if nothing else is loaded); animation packs
// land in the global animations library so any character can use them.
ipcMain.handle('install-character', (_, { name, bytes, manifest }) => {
  ensureDirs();
  const safe = (name || 'character').replace(/[^a-zA-Z0-9_-]/g, '_');
  let dest = path.join(CHARACTERS_DIR, `${safe}.charpack`), n = 1;
  while (fs.existsSync(dest)) dest = path.join(CHARACTERS_DIR, `${safe}-${n++}.charpack`);
  fs.writeFileSync(dest, Buffer.from(bytes));
  if (manifest) { try { fs.writeFileSync(dest + '.json', JSON.stringify(manifest, null, 2)); } catch {} }
  const s = loadSettings();
  if (!s.activeCharacter) { s.activeCharacter = dest; saveSettings(s); overlayWindow?.webContents.send('character-changed', dest); }
  return { ok: true, path: dest };
});
ipcMain.handle('install-animation-pack', (_, { name, data }) => {
  ensureDirs();
  const safe = (name || 'animations').replace(/[^a-zA-Z0-9_-]/g, '_');
  let dest = path.join(ANIMATIONS_DIR, `${safe}.animpack`), n = 1;
  while (fs.existsSync(dest)) dest = path.join(ANIMATIONS_DIR, `${safe}-${n++}.animpack`);
  fs.writeFileSync(dest, JSON.stringify(data, null, 2));
  return { ok: true, path: dest };
});

// Pick an image via the native dialog and return it as a data URL. The scene
// editor used an HTML <input type=file> which the GNOME/Wayland file-chooser
// portal silently drops — every other importer in the app goes through
// dialog.showOpenDialog (which works), so this does too.
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose an image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const file = r.filePaths[0];
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
  const buf = fs.readFileSync(file);
  return { dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`, name: path.basename(file) };
});

// ── Desktop wallpaper (scene mode) ───────────────────────────────────────────
// Activating a scene swaps the REAL desktop wallpaper to the scene background so
// the character looks like it's walking on it. We snapshot the user's wallpaper
// first and restore it on scene exit / quit. GNOME-only for now (gsettings);
// elsewhere it's a no-op and scene mode just runs transparent over the existing
// wallpaper. The backup lives in settings so a crash can be recovered next launch.
const GSET = 'org.gnome.desktop.background';
function isGnome() {
  const d = (process.env.XDG_CURRENT_DESKTOP || '') + '|' + (process.env.XDG_SESSION_DESKTOP || '');
  return process.platform === 'linux' && /gnome|unity|cinnamon|ubuntu|pop/i.test(d);
}
async function gsGet(key) {
  try { const { stdout } = await pexec(`gsettings get ${GSET} ${key}`); return stdout.trim().replace(/^'|'$/g, ''); }
  catch { return null; }
}
async function gsSet(key, val) {
  try { await pexec(`gsettings set ${GSET} ${key} "${val}"`); return true; } catch { return false; }
}

// ── Windows wallpaper (Win32 SystemParametersInfo via PowerShell) ────────────
// We drive PowerShell with -EncodedCommand (UTF-16LE base64) so script content needs
// no shell-escaping. SPI_SETDESKWALLPAPER=20; SPIF_UPDATEINIFILE|SENDWININICHANGE=3.
// WallpaperStyle 2 = stretched (matches the GNOME 'stretched' so the floor lines up).
function psEncode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }
function winSetWallpaperScript(p, style, tile) {
  const esc = (v) => String(v).replace(/'/g, "''");
  return `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' WallpaperStyle '${esc(style ?? 2)}'
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' TileWallpaper '${esc(tile ?? 0)}'
Add-Type -Namespace DeskBuddy -Name Wp -MemberDefinition '[DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern int SystemParametersInfo(int a,int b,string c,int d);'
[DeskBuddy.Wp]::SystemParametersInfo(20,0,'${esc(p)}',3) | Out-Null`;
}
function regGet(name) {
  try {
    const o = execSync(`reg query "HKCU\\Control Panel\\Desktop" /v ${name}`, { encoding: 'utf8', timeout: 4000 });
    const m = o.match(new RegExp(name + '\\s+REG_\\w+\\s+(.*)', 'i'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
function winGetWallpaper() {
  return { path: regGet('WallPaper'), style: regGet('WallpaperStyle') || '2', tile: regGet('TileWallpaper') || '0' };
}
async function winSetWallpaper(p, style, tile) {
  try { await pexec(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(winSetWallpaperScript(p, style, tile))}`, { timeout: 8000 }); return true; }
  catch { return false; }
}

async function snapshotWallpaper() {
  const s = loadSettings();
  if (s.wallpaperBackup) return;   // keep the first (true original) backup
  if (isGnome()) {
    s.wallpaperBackup = {
      kind: 'gnome',
      uri:     await gsGet('picture-uri'),
      uriDark: await gsGet('picture-uri-dark'),
      options: await gsGet('picture-options'),
    };
  } else if (process.platform === 'win32') {
    s.wallpaperBackup = { kind: 'win', ...winGetWallpaper() };
  } else return;
  saveSettings(s);
}
async function restoreWallpaper() {
  const s = loadSettings(); const bk = s.wallpaperBackup;
  if (bk?.kind === 'win-multi' && process.platform === 'win32') {
    await runDw('restore', bk.monitors.map(m => m.left + '=' + m.path).join(';'));
  } else if (bk?.kind === 'win' && process.platform === 'win32') {
    if (bk.path) await winSetWallpaper(bk.path, bk.style, bk.tile);
  } else if (bk && (bk.kind === 'gnome' || bk.uri) && isGnome()) {   // bk.uri: legacy untagged backup
    if (bk.options) await gsSet('picture-options', bk.options);
    if (bk.uri)     await gsSet('picture-uri', bk.uri);
    if (bk.uriDark) await gsSet('picture-uri-dark', bk.uriDark);
  }
  if (bk) { delete s.wallpaperBackup; saveSettings(s); }
}
function restoreWallpaperSync() {
  const s = loadSettings(); const bk = s.wallpaperBackup;
  if (!bk) return;
  try {
    if (bk.kind === 'win-multi' && process.platform === 'win32') {
      const data = bk.monitors.map(m => m.left + '=' + m.path).join(';');
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureDwScript(), '-Mode', 'restore', '-Data', data], { timeout: 12000 });
    } else if (bk.kind === 'win' && process.platform === 'win32') {
      if (bk.path) execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(winSetWallpaperScript(bk.path, bk.style, bk.tile))}`, { timeout: 8000 });
    } else if ((bk.kind === 'gnome' || bk.uri) && isGnome()) {
      if (bk.options) execSync(`gsettings set ${GSET} picture-options "${bk.options}"`);
      if (bk.uri)     execSync(`gsettings set ${GSET} picture-uri "${bk.uri}"`);
      if (bk.uriDark) execSync(`gsettings set ${GSET} picture-uri-dark "${bk.uriDark}"`);
    }
  } catch {}
  delete s.wallpaperBackup; saveSettings(s);
}

ipcMain.handle('set-scene-wallpaper', async (_, filename) => {
  if (!filename) return { ok: false };
  const abs = path.isAbsolute(filename) ? filename : path.join(SCENES_DIR, filename);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'missing' };
  await snapshotWallpaper();
  let ok = false;
  if (isGnome()) {
    await gsSet('picture-options', 'stretched');
    const uri = 'file://' + abs;
    // Set BOTH light and dark — GNOME shows picture-uri-dark when the color scheme
    // is dark, so setting only picture-uri leaves a dark-mode desktop unchanged.
    const a = await gsSet('picture-uri', uri);
    const b = await gsSet('picture-uri-dark', uri);
    ok = a || b;
  } else if (process.platform === 'win32') {
    // Span (22) across all monitors when the scene spans displays; otherwise fill (2).
    const span = loadSettings().sceneDisplay === 'all';
    ok = await winSetWallpaper(abs, span ? 22 : 2, 0);
  }
  return { ok, gnome: isGnome(), platform: process.platform };
});
ipcMain.handle('clear-scene-wallpaper', async () => { await restoreWallpaper(); return { ok: true }; });

// Multi-display: a pre-stitched, virtual-desktop-sized image set as a SPAN wallpaper so each
// monitor shows its room and the overlay can stay transparent (icons/taskbar visible).
ipcMain.handle('set-spanned-wallpaper', async (_, dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') return { ok: false };
  const m = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  if (!m) return { ok: false };
  await snapshotWallpaper();
  const file = path.join(SCENES_DIR, '_spanned-wallpaper.png');
  try { fs.writeFileSync(file, Buffer.from(m[1], 'base64')); } catch (e) { return { ok: false, error: e.message }; }
  let ok = false;
  if (process.platform === 'win32') ok = await winSetWallpaper(file, 22, 0);   // 22 = Span across monitors
  else if (isGnome()) { await gsSet('picture-options', 'spanned'); const uri = 'file://' + file; ok = (await gsSet('picture-uri', uri)) || (await gsSet('picture-uri-dark', uri)); }
  return { ok, platform: process.platform };
});

// ── Per-monitor wallpaper (Windows IDesktopWallpaper COM) ───────────────────────
// True isolation: each monitor gets its OWN room background (no Span, which mis-maps when
// monitors differ in size/position). Images are assigned left→right, matching the scene's
// room order. Position 2 = STRETCH so image [0,1] == monitor [0,1], lining up with the floor.
const DW_PS = `param([string]$Mode,[string]$Data)
$ErrorActionPreference='Stop'
$cs=@"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace DB {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDesktopWallpaper {
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string m, [MarshalAs(UnmanagedType.LPWStr)] string w);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string m);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint i);
    uint GetMonitorDevicePathCount();
    RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string m);
    void SetBackgroundColor(uint c); uint GetBackgroundColor();
    void SetPosition(int p); int GetPosition();
  }
  [ComImport, Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD")] public class CoDW { }
  public static class DW {
    static IDesktopWallpaper N(){ return (IDesktopWallpaper)(new CoDW()); }
    static List<KeyValuePair<int,string>> Mons(IDesktopWallpaper d){
      var L=new List<KeyValuePair<int,string>>(); uint n=d.GetMonitorDevicePathCount();
      for(uint i=0;i<n;i++){ string id=d.GetMonitorDevicePathAt(i); try{ var r=d.GetMonitorRECT(id); L.Add(new KeyValuePair<int,string>(r.L,id)); }catch{} }
      L.Sort((a,b)=>a.Key.CompareTo(b.Key)); return L;
    }
    public static string List(){ var d=N(); var s=""; foreach(var m in Mons(d)){ s+=m.Key+"|"+d.GetWallpaper(m.Value)+"\\n"; } return s; }
    public static void ApplyOrdered(string[] paths, int pos){ var d=N(); var m=Mons(d); d.SetPosition(pos); for(int i=0;i<paths.Length && i<m.Count;i++){ if(!string.IsNullOrEmpty(paths[i])) d.SetWallpaper(m[i].Value, paths[i]); } }
    public static void RestoreByLeft(int[] lefts, string[] paths){ var d=N(); foreach(var m in Mons(d)){ for(int k=0;k<lefts.Length;k++){ if(lefts[k]==m.Key && !string.IsNullOrEmpty(paths[k])){ try{ d.SetWallpaper(m.Value, paths[k]); }catch{} } } } }
  }
}
"@
Add-Type -TypeDefinition $cs
if($Mode -eq 'list'){ [DB.DW]::List() }
elseif($Mode -eq 'apply'){ $p=$Data -split '\\|'; [DB.DW]::ApplyOrdered([string[]]$p,2) }
elseif($Mode -eq 'restore'){ $rows=$Data -split ';'; $lefts=@(); $paths=@(); foreach($r in $rows){ if($r){ $kv=$r -split '=',2; $lefts+=[int]$kv[0]; $paths+=$kv[1] } }; [DB.DW]::RestoreByLeft([int[]]$lefts,[string[]]$paths) }`;
let dwScript = null;
function ensureDwScript() {
  if (dwScript) return dwScript;
  dwScript = path.join(app.getPath('userData'), '_dw.ps1');
  try { fs.writeFileSync(dwScript, DW_PS); } catch {}
  return dwScript;
}
function runDw(mode, data) {
  return new Promise((resolve) => {
    try {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureDwScript(), '-Mode', mode, '-Data', data || ''],
        { timeout: 12000 }, (err, stdout) => resolve(err ? null : (stdout || '')));
    } catch { resolve(null); }
  });
}
// Snapshot the current per-monitor wallpapers (so we can restore them exactly on exit).
async function snapshotPerMonitor() {
  const s = loadSettings();
  if (s.wallpaperBackup) return;   // keep the first true-original backup
  const out = await runDw('list', '');
  if (out == null) return;
  const monitors = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf('|'); return { left: parseInt(l.slice(0, i), 10), path: l.slice(i + 1) }; });
  if (monitors.length) { s.wallpaperBackup = { kind: 'win-multi', monitors }; saveSettings(s); }
}
ipcMain.handle('set-per-monitor-wallpaper', async (_, filenames) => {
  if (process.platform !== 'win32' || !Array.isArray(filenames)) return { ok: false };
  const abs = filenames.map(f => (!f ? '' : (path.isAbsolute(f) ? f : path.join(SCENES_DIR, f))));
  if (!abs.some(Boolean)) return { ok: false };
  await snapshotPerMonitor();
  const out = await runDw('apply', abs.join('|'));
  return { ok: out != null };
});

// ── Living-wallpaper layer (Windows WorkerW) ────────────────────────────────────
// Reparent the overlay INTO the desktop's wallpaper layer so it renders BEHIND the
// desktop icons (icons, taskbar and app windows all sit on top) — a true living
// wallpaper, and the desktop stays fully usable because the window is no longer in the
// click path at all. We spawn the WorkerW (SendMessage 0x052C to Progman), find it, then
// SetParent the overlay to it and SetWindowPos it to the scene's virtual-desktop rect.
const WORKERW_PS = `param([string]$Hwnd,[string]$Mode,[int]$X,[int]$Y,[int]$W,[int]$H)
Add-Type @"
using System;using System.Runtime.InteropServices;
public class WW{
 [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c,string w);
 [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string cl,string wn);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c,IntPtr p);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd,IntPtr after,int x,int y,int cx,int cy,uint flags);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 public static IntPtr worker=IntPtr.Zero;
 public static IntPtr Find(){
  IntPtr progman=FindWindow("Progman",null);IntPtr res;
  SendMessageTimeout(progman,0x052C,new IntPtr(0),IntPtr.Zero,0,1000,out res);
  worker=IntPtr.Zero;
  EnumWindows(new EnumProc((top,p)=>{
   if(FindWindowEx(top,IntPtr.Zero,"SHELLDLL_DefView",null)!=IntPtr.Zero){worker=FindWindowEx(IntPtr.Zero,top,"WorkerW",null);}
   return true;}),IntPtr.Zero);
  if(worker==IntPtr.Zero) worker=progman;
  return worker;}
}
"@
$h=[IntPtr]::new([int64]::Parse($Hwnd))
if($Mode -eq "below"){
 $w=[WW]::Find()
 [WW]::SetParent($h,$w) | Out-Null
 [WW]::SetWindowPos($h,[IntPtr]::Zero,$X,$Y,$W,$H,0x0010) | Out-Null
 Write-Output ("below parent="+$w.ToString())
}else{
 [WW]::SetParent($h,[IntPtr]::Zero) | Out-Null
 Write-Output "above"
}`;
let workerwScript = null;
function ensureWorkerwScript() {
  if (workerwScript) return workerwScript;
  workerwScript = path.join(app.getPath('userData'), '_workerw.ps1');
  try { fs.writeFileSync(workerwScript, WORKERW_PS); } catch {}
  return workerwScript;
}
// Reparent the overlay below the icons (below=true) or detach back to a normal top-level
// window (below=false). No-op off Windows.
function setBehindIcons(below) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !overlayWindow) return resolve(false);
    let hwnd;
    try { hwnd = overlayWindow.getNativeWindowHandle().readBigUInt64LE(0).toString(); } catch { return resolve(false); }
    // WorkerW-relative target rect (physical px). WorkerW spans the virtual desktop, so the
    // child's origin is the scene's union minus the virtual-desktop origin, scaled to pixels.
    const all = screen.getAllDisplays();
    let vx = Infinity, vy = Infinity; for (const d of all) { vx = Math.min(vx, d.bounds.x); vy = Math.min(vy, d.bounds.y); }
    const b = (sceneRoomLayout && sceneRoomLayout.bounds) || (overlayWindow.getBounds());
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const X = Math.round((b.x - vx) * sf), Y = Math.round((b.y - vy) * sf);
    const W = Math.round(b.width * sf), H = Math.round(b.height * sf);
    try {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ensureWorkerwScript(),
        '-Hwnd', hwnd, '-Mode', below ? 'below' : 'above', '-X', String(X), '-Y', String(Y), '-W', String(W), '-H', String(H)],
        { windowsHide: true, timeout: 9000 }, (err, stdout) => {
          console.log('[workerw]', below ? 'below' : 'above', (stdout || '').toString().trim(), err ? ('ERR ' + err.message) : '');
          resolve(!err);
        });
    } catch (e) { console.log('[workerw] spawn failed', e.message); resolve(false); }
  });
}
let behindIconsActive = false;

// Cover the screen with the transparent overlay so the character can roam the
// whole wallpaper. Wayland blocks setPosition, so we maximize() (the window stays
// composited over the desktop → its transparency shows the wallpaper) rather than
// setFullScreen() which would unredirect to a black surface. Returns the size the
// renderer should fill; the overlay re-enables hit-testing over the character.
let preWallpaperBounds = null;
// Clickable props in scene mode. Per-hover click-through toggling needs a live cursor
// position. Electron's getCursorScreenPoint is stuck under XWayland and mouse-forwarding
// isn't supported on Linux — but X11 query_pointer works, so a tiny Python helper streams
// the cursor to us and we make the overlay interactive ONLY while the cursor is over a
// prop. Everywhere else stays click-through, so the desktop keeps working. If the helper
// isn't available we fall back to making the whole scene interactive while enabled.
// Windows & macOS support setIgnoreMouseEvents(..., { forward:true }) — the window stays
// click-through but the renderer still RECEIVES mousemove, so it can hit-test props itself
// and ask us to capture clicks per-hover. No external cursor helper needed there; the
// Python/X11 helper below is the Linux-only fallback (Wayland breaks forwarding).
const NATIVE_FORWARD = process.platform !== 'linux';
let wallpaperActive = false, sceneInteractive = false, propHitboxes = [];
let sceneClickMove = false;   // click anywhere on the floor → walk the character there
let sceneRoomLayout = null;   // { bounds, rooms:[{x,y,w,h,displayId,bounds}] } for the active scene

// ── Multi-display targeting ────────────────────────────────────────────────────
// A scene can play on one display or SPAN all of them (one wide canvas). The target is
// stored in settings.sceneDisplay: 'auto' (the display under the buddy), 'all' (span the
// whole virtual desktop), or a specific display id.
function unionBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function sceneDisplayBounds() {
  const sel = loadSettings().sceneDisplay || 'auto';
  if (sel === 'all') return unionBounds();
  if (sel !== 'auto') {
    const d = screen.getAllDisplays().find(d => String(d.id) === String(sel));
    if (d) return d.bounds;
  }
  const ref = preWallpaperBounds || (overlayWindow && overlayWindow.getBounds());
  return (ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay()).bounds;
}
let cursorHelper = null, propInteractive = false, helperUnavailable = false;
const PY_POINTER = "import sys,time,os\n" +
  "try:\n from Xlib import display\nexcept Exception:\n sys.exit(2)\n" +
  "try:\n d=display.Display()\nexcept Exception:\n sys.exit(3)\n" +
  "r=d.screen().root\n" +
  "pp=os.getppid()\n" +
  "while True:\n" +
  " if os.getppid()!=pp: break\n" +   // parent (electron) died → don't linger as an orphan
  " try:\n  p=r.query_pointer(); sys.stdout.write('%d %d\\n'%(p.root_x,p.root_y)); sys.stdout.flush()\n" +
  " except Exception:\n  break\n" +
  " time.sleep(0.04)\n";
let lastCursorTs = 0, cursorWatchdog = null;
function setInteractive(on) {   // on = capture clicks (over a prop); off = click-through
  if (propInteractive === on) return;
  propInteractive = on;
  try {
    if (!overlayWindow) return;
    // on = capture (cursor is over a prop); off = click-through so the desktop works. The
    // cursor poll (Windows/macOS) or the X11 helper (Linux) calls this; no move-forwarding.
    overlayWindow.setIgnoreMouseEvents(!on);
  } catch {}
}
function onCursor(x, y) {
  lastCursorTs = Date.now();
  if (!overlayWindow || !wallpaperActive || !sceneInteractive) return;
  const b = overlayWindow.getBounds();
  let over = false;
  for (const r of propHitboxes) {
    const x0 = b.x + r.x0 * b.width, x1 = b.x + r.x1 * b.width;
    const y0 = b.y + r.y0 * b.height, y1 = b.y + r.y1 * b.height;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    // Inside the prop's bounding box. If we have its opacity mask, only a filled cell counts
    // (so the prop's transparent margins pass clicks through); without a mask, fall back to
    // the box. This is what keeps the click layer from leaking across the whole screen.
    if (r.mask && r.mask.bits) {
      const gx = Math.min(r.mask.w - 1, Math.max(0, Math.floor((x - x0) / (x1 - x0) * r.mask.w)));
      const gy = Math.min(r.mask.h - 1, Math.max(0, Math.floor((y - y0) / (y1 - y0) * r.mask.h)));
      if (r.mask.bits[gy * r.mask.w + gx] === '1') { over = true; break; }
    } else { over = true; break; }
  }
  setInteractive(over);
}
function startCursorHelper() {
  if (cursorHelper || helperUnavailable) return;
  try { cursorHelper = spawn('python3', ['-c', PY_POINTER], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { helperUnavailable = true; applySceneInteractive(); return; }
  lastCursorTs = Date.now();
  let buf = '';
  cursorHelper.stdout.on('data', (c) => {
    buf += c.toString(); let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const parts = buf.slice(0, nl).split(' '); buf = buf.slice(nl + 1);
      const x = +parts[0], y = +parts[1];
      if (Number.isFinite(x) && Number.isFinite(y)) onCursor(x, y);
    }
  });
  cursorHelper.on('error', () => {});
  cursorHelper.on('exit', (code) => {
    cursorHelper = null;
    if (code === 2 || code === 3) helperUnavailable = true;   // python / Xlib missing
    setInteractive(false);   // NEVER leave the window stuck capturing clicks
    if (!helperUnavailable && wallpaperActive && sceneInteractive) setTimeout(startCursorHelper, 400);   // transient death → restart
  });
  // Watchdog: if the helper goes silent while interactive, drop back to click-through so
  // the desktop can never get permanently stuck.
  if (!cursorWatchdog) cursorWatchdog = setInterval(() => {
    if (propInteractive && Date.now() - lastCursorTs > 700) setInteractive(false);
  }, 300);
}
function stopCursorHelper() {
  if (cursorHelper) { try { cursorHelper.kill(); } catch {} cursorHelper = null; }
  if (cursorWatchdog) { clearInterval(cursorWatchdog); cursorWatchdog = null; }
  propInteractive = false;
}
// Windows/macOS: poll the real cursor (getCursorScreenPoint works there, unlike Wayland) and
// capture clicks ONLY while it's over a prop hitbox. This is far more robust than relying on
// renderer-forwarded mousemoves — the window can never get stuck capturing the whole desktop.
let cursorPoll = null;
function startCursorPoll() {
  if (cursorPoll) return;
  cursorPoll = setInterval(() => {
    if (!overlayWindow || !wallpaperActive || !sceneInteractive) { setInteractive(false); return; }
    try { const p = screen.getCursorScreenPoint(); onCursor(p.x, p.y); } catch {}
  }, 40);
}
function stopCursorPoll() { if (cursorPoll) { clearInterval(cursorPoll); cursorPoll = null; } }
function applySceneInteractive() {
  if (!overlayWindow) return;
  // Click-to-move: capture ALL clicks (the whole floor is clickable to send the character).
  // The desktop is intercepted while this is on — it's a deliberate, user-toggled mode.
  if (wallpaperActive && sceneClickMove) {
    stopCursorHelper(); stopCursorPoll(); propInteractive = true;
    try { overlayWindow.setIgnoreMouseEvents(false); } catch {}
    return;
  }
  const want = wallpaperActive && sceneInteractive;
  if (!want) {
    stopCursorHelper(); stopCursorPoll();
    propInteractive = false;
    // Fully click-through so the desktop is 100% usable. (No forwarding needed now that the
    // cursor poll, not renderer moves, drives prop capture.)
    try { overlayWindow.setIgnoreMouseEvents(true); } catch {}
    return;
  }
  // Windows/macOS: poll the real cursor and capture ONLY while it's over a visible prop
  // pixel (the renderer sends a per-prop opacity mask; onCursor tests it). This is robust —
  // unlike { forward:true }, which doesn't reliably deliver mousemove to a transparent,
  // click-through window, so the renderer never saw the cursor.
  if (NATIVE_FORWARD) {
    startCursorPoll();
    try { overlayWindow.setIgnoreMouseEvents(!propInteractive); } catch {}
    return;
  }
  // Linux: no move forwarding → stream the cursor from a helper. If unavailable, stay
  // click-through (desktop usable); props just won't be clickable. We never block the desktop.
  if (helperUnavailable) { try { overlayWindow.setIgnoreMouseEvents(true); } catch {} return; }
  startCursorHelper();
  try { overlayWindow.setIgnoreMouseEvents(!propInteractive); } catch {}   // click-through until the cursor is over a prop
}
// Clickable props: capture clicks ONLY while the cursor is over a real (non-transparent)
// prop pixel — the desktop stays fully click-through everywhere else, so the click layer
// never leaks onto the whole screen. On Win/macOS the renderer does precise per-pixel
// alpha hit-testing and drives capture via set-prop-capture; on Linux the X11 cursor
// helper falls back to rect hit-testing (set-prop-hitboxes/onCursor). Honors propClicks.
ipcMain.handle('set-scene-interactive', (_, v) => { sceneInteractive = !!v; applySceneInteractive(); });
ipcMain.handle('set-scene-clickmove', (_, on) => { sceneClickMove = !!on; applySceneInteractive(); });
ipcMain.handle('set-prop-hitboxes', (_, boxes) => { propHitboxes = Array.isArray(boxes) ? boxes : []; });
// Legacy renderer-driven capture — superseded by the mask-aware cursor poll, which is
// authoritative. Kept as a no-op so old renderer calls don't fight the poll.
ipcMain.handle('set-prop-capture', () => {});

// Pick the displays a scene uses (left→right) and the spanned bounds + per-room screen
// regions (canvas fractions). 1 room = the display under the buddy; N rooms = the N
// left-most displays (capped to what's connected), spanning their union.
function sceneLayout(nRooms) {
  const displays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x);
  let used;
  if (nRooms <= 1) {
    const ref = preWallpaperBounds || (overlayWindow && overlayWindow.getBounds());
    used = [ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay()];
  } else {
    used = displays.slice(0, Math.min(nRooms, displays.length));
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of used) { const b = d.bounds; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
  const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const N = Math.max(1, nRooms);
  const rooms = [];
  if (N <= used.length) {
    // One room per monitor — each room fills its own display (works at any size/aspect ratio).
    for (let i = 0; i < N; i++) {
      const b = used[i].bounds;
      rooms.push({ x: (b.x - x0) / bounds.width, y: (b.y - y0) / bounds.height, w: b.width / bounds.width, h: b.height / bounds.height, displayId: used[i].id, bounds: b });
    }
  } else {
    // Fewer monitors than rooms: tile the available area into N equal vertical strips so EVERY
    // room still gets its own distinct region (no overlap → clipping works, nothing bleeds). The
    // scene then shows all rooms side-by-side on the screens you do have.
    for (let i = 0; i < N; i++) {
      rooms.push({ x: i / N, y: 0, w: 1 / N, h: 1, displayId: used[0].id,
        bounds: { x: Math.round(x0 + bounds.width * i / N), y: y0, width: Math.round(bounds.width / N), height: bounds.height } });
    }
  }
  return { bounds, rooms };
}

ipcMain.handle('enter-wallpaper-mode', (_, opts = {}) => {
  if (!overlayWindow) return null;
  const win = overlayWindow;
  preWallpaperBounds = win.getBounds();
  const nRooms = Math.max(1, Math.round(opts.rooms || 1));
  const layout = sceneLayout(nRooms);
  const d = { bounds: layout.bounds };   // single display, or the union across rooms
  sceneRoomLayout = layout;              // remembered for per-room wallpaper
  win.setResizable(true);
  // Make the window fully click-through so the desktop stays usable; all scene
  // control lives in the tray. The catch: the WM reconfigures the window when it
  // maximizes, which DROPS the X11 input-shape region that setIgnoreMouseEvents
  // installs — so clicks start landing on the overlay again. Re-assert it after
  // the maximize settles (and a few delayed times) so click-through actually sticks.
  wallpaperActive = true; helperUnavailable = false;   // re-try the cursor helper each scene
  // Click-through (or interactive, if the user enabled prop-clicking). The WM drops the
  // X11 input-shape on reconfigure, so re-assert the correct state a few times.
  const reassert = () => applySceneInteractive();
  win.once('maximize', () => { reassert(); setTimeout(reassert, 80); });
  // Cover the FULL display so the canvas matches the desktop wallpaper. (The WM may
  // still clamp to the work area; the renderer sizes to its actual window either way.)
  try { win.setBounds(d.bounds); } catch {}
  reassert();
  setTimeout(() => { try { win.setBounds(d.bounds); } catch {} reassert(); }, 60);
  setTimeout(reassert, 120);
  setTimeout(reassert, 400);
  const b = win.getContentBounds();
  console.log('[wallpaper] enter: rooms=', nRooms, 'bounds=', d.bounds.width, 'x', d.bounds.height, 'content=', b.width, 'x', b.height);
  // Living-wallpaper: drop the overlay BEHIND the desktop icons (icons/taskbar on top, desktop
  // usable). Done after the bounds settle so the WorkerW SetWindowPos lands on the final rect.
  behindIconsActive = false;
  // Opt-in only (default OFF): the WorkerW reparent crashes the transparent GPU overlay.
  if (process.platform === 'win32' && loadSettings().behindIcons === true) {
    setTimeout(() => setBehindIcons(true).then(ok => { behindIconsActive = ok; }), 350);
  }
  // Strip the absolute display bounds from the returned regions (renderer only needs fractions).
  const rooms = layout.rooms.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  return { width: d.bounds.width, height: d.bounds.height, rooms };
});
ipcMain.handle('exit-wallpaper-mode', async () => {
  if (!overlayWindow) return;
  wallpaperActive = false; stopCursorHelper(); stopCursorPoll();
  if (behindIconsActive) { await setBehindIcons(false); behindIconsActive = false; }   // detach from the wallpaper layer first
  overlayWindow.setIgnoreMouseEvents(false);
  if (overlayWindow.isMaximized()) overlayWindow.unmaximize();
  if (preWallpaperBounds) { try { overlayWindow.setBounds(preWallpaperBounds); } catch {} }
  overlayWindow.setResizable(false);
  console.log('[wallpaper] exit');
});

// The overlay tells us when a scene starts/stops so the tray menu can offer
// "Exit Scene" and check the active scene.
ipcMain.handle('scene-changed', (_, p) => { currentScenePath = p || null; refreshTray(); return true; });

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  ensureDirs();
  seedSampleScene();
  // Recover from a crash that left a scene wallpaper applied: if we're NOT going
  // straight back into a scene, restore the user's original wallpaper.
  const s0 = loadSettings();
  if (s0.wallpaperBackup && !s0.activeScene) { await restoreWallpaper(); }
  try { await startServer(app.getPath('userData')); } catch (e) { console.error('Server:', e.message); }
  createOverlayWindow();
  createTray();
  syncNotifications().catch(() => {});   // welcome + dev announcements; sets the tray badge
  app.on('activate', () => { if (!overlayWindow) createOverlayWindow(); });
});

app.on('before-quit', () => { stopServer(); restoreWallpaperSync(); stopCursorHelper(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
