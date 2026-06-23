const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, nativeImage, powerMonitor, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(exec);
const { startServer, stopServer, PORT } = require('../server/server');

// Force the X11/XWayland backend. On native Wayland, Electron's setIgnoreMouseEvents
// (click-through) and setPosition are no-ops, which broke scene mode (the full-screen
// overlay swallowed every click). Under XWayland these work properly. Must be set
// before app is ready. Honoured on Linux; harmless elsewhere.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

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
    { type: 'separator' },
    { label: 'Character Studio', click: createStudioWindow },
    { label: 'Marketplace',      click: createMarketplaceWindow },
    { type: 'separator' },
    { label: 'Quit DeskBuddy',   click: () => app.quit() },
  ];
}
function refreshTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayTemplate())); }
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
    { label: 'Marketplace',      click: () => send('market') },
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
    { label: 'Light & Shadow', submenu: [
        { label: 'Off (normal light)',     type: 'radio', checked: f.lightMode === 'off',  click: () => send('lightmode:off') },
        { label: 'On (colour bounce)',     type: 'radio', checked: (f.lightMode || 'on') === 'on', click: () => send('lightmode:on') },
        { label: 'High (rendered shadow)', type: 'radio', checked: f.lightMode === 'high', click: () => send('lightmode:high') },
      ] },
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
ipcMain.handle('set-always-on-top', (_, v) => { overlayWindow?.setAlwaysOnTop(v, 'screen-saver'); const s = loadSettings(); s.alwaysOnTop = v; saveSettings(s); });
ipcMain.handle('set-ignore-mouse', (_, v)  => { overlayWindow?.setIgnoreMouseEvents(v, { forward: true }); });
ipcMain.handle('get-idle-seconds', () => powerMonitor.getSystemIdleTime());
ipcMain.handle('get-server-port',  () => PORT);
ipcMain.handle('get-animations-dir', () => ANIMATIONS_DIR);
ipcMain.handle('get-characters-dir', () => CHARACTERS_DIR);
ipcMain.handle('get-scenes-dir',     () => SCENES_DIR);

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
  if (scenepack._bgData) { const fn = writeData(scenepack._bgData, 'bg'); if (fn) scenepack.background = fn; }
  delete scenepack._bgData;
  for (const it of (scenepack.foregrounds || [])) {
    if (it._dataUrl) { const fn = writeData(it._dataUrl, it.id || 'fg'); if (fn) it.image = fn; }
    delete it._dataUrl;
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
async function snapshotWallpaper() {
  const s = loadSettings();
  if (s.wallpaperBackup || !isGnome()) return;   // keep the first (true original) backup
  s.wallpaperBackup = {
    uri:     await gsGet('picture-uri'),
    uriDark: await gsGet('picture-uri-dark'),
    options: await gsGet('picture-options'),
  };
  saveSettings(s);
}
async function restoreWallpaper() {
  const s = loadSettings(); const bk = s.wallpaperBackup;
  if (bk && isGnome()) {
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
    if (isGnome()) {
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
  }
  return { ok, gnome: isGnome() };
});
ipcMain.handle('clear-scene-wallpaper', async () => { await restoreWallpaper(); return { ok: true }; });

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
let wallpaperActive = false, sceneInteractive = false, propHitboxes = [];
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
  try { if (overlayWindow) overlayWindow.setIgnoreMouseEvents(!on); } catch {}
}
function onCursor(x, y) {
  lastCursorTs = Date.now();
  if (!overlayWindow || !wallpaperActive || !sceneInteractive) return;
  const b = overlayWindow.getBounds();
  let over = false;
  for (const r of propHitboxes) {
    if (x >= b.x + r.x0 * b.width && x <= b.x + r.x1 * b.width && y >= b.y + r.y0 * b.height && y <= b.y + r.y1 * b.height) { over = true; break; }
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
function applySceneInteractive() {
  if (!overlayWindow) return;
  const want = wallpaperActive && sceneInteractive;
  if (!want) { stopCursorHelper(); try { overlayWindow.setIgnoreMouseEvents(wallpaperActive); } catch {} return; }
  // No cursor helper available → stay click-through (desktop usable); props just won't be
  // clickable. We never block the whole desktop.
  if (helperUnavailable) { try { overlayWindow.setIgnoreMouseEvents(true); } catch {} return; }
  startCursorHelper();
  try { overlayWindow.setIgnoreMouseEvents(!propInteractive); } catch {}   // click-through until the cursor is over a prop
}
ipcMain.handle('set-scene-interactive', (_, on) => { sceneInteractive = !!on; applySceneInteractive(); });
ipcMain.handle('set-prop-hitboxes', (_, boxes) => { propHitboxes = Array.isArray(boxes) ? boxes : []; });

ipcMain.handle('enter-wallpaper-mode', () => {
  if (!overlayWindow) return null;
  const win = overlayWindow;
  preWallpaperBounds = win.getBounds();
  const d = screen.getDisplayMatching(preWallpaperBounds);
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
  console.log('[wallpaper] enter: bounds=', d.bounds.width, 'x', d.bounds.height, 'content=', b.width, 'x', b.height);
  return { width: d.bounds.width, height: d.bounds.height };
});
ipcMain.handle('exit-wallpaper-mode', () => {
  if (!overlayWindow) return;
  wallpaperActive = false; stopCursorHelper();
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
  app.on('activate', () => { if (!overlayWindow) createOverlayWindow(); });
});

app.on('before-quit', () => { stopServer(); restoreWallpaperSync(); stopCursorHelper(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
