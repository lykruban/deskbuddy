const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskbuddy', {
  // Settings
  getSettings:      ()  => ipcRenderer.invoke('get-settings'),
  saveSettings:     (s) => ipcRenderer.invoke('save-settings', s),

  // Account / shared auth session (one login across Studio + Marketplace)
  authState:      ()  => ipcRenderer.invoke('auth-state'),
  authLogin:      (c) => ipcRenderer.invoke('auth-login', c),
  authSignup:     (c) => ipcRenderer.invoke('auth-signup', c),
  authLogout:     ()  => ipcRenderer.invoke('auth-logout'),
  authServerBase: ()  => ipcRenderer.invoke('auth-server-base'),
  authForgot:     (c) => ipcRenderer.invoke('auth-forgot', c),
  authReset:      (c) => ipcRenderer.invoke('auth-reset', c),
  authResetCode:  (c) => ipcRenderer.invoke('auth-reset-code', c),

  // Whole-library export / import (portable folder, linked to your account)
  exportLibrary:  ()  => ipcRenderer.invoke('export-library'),
  importLibrary:  ()  => ipcRenderer.invoke('import-library'),

  // Characters
  listCharacters:    ()  => ipcRenderer.invoke('list-characters'),
  importCharacter:   ()  => ipcRenderer.invoke('import-character'),
  readCharacterFile: (p) => ipcRenderer.invoke('read-character-file', p),
  saveCharpack:      (d) => ipcRenderer.invoke('save-charpack', d),
  activateCharacter: (p) => ipcRenderer.invoke('activate-character', p),
  deleteCharacter:   (p) => ipcRenderer.invoke('delete-character', p),
  deleteScene:       (p) => ipcRenderer.invoke('delete-scene', p),

  // Animation packs
  listAnimationPacks:   ()        => ipcRenderer.invoke('list-animation-packs'),
  importAnimationPack:  ()        => ipcRenderer.invoke('import-animation-pack'),
  importFBXAnimation:   ()        => ipcRenderer.invoke('import-fbx-animation'),
  saveAnimationPack:    (name, d) => ipcRenderer.invoke('save-animation-pack', { name, data: d }),
  readFileBuffer:       (p)       => ipcRenderer.invoke('read-file-buffer', p),

  // Animation source library (reusable across characters)
  saveAnimationSource:   (d) => ipcRenderer.invoke('save-animation-source', d),
  listAnimationSources:  ()  => ipcRenderer.invoke('list-animation-sources'),
  deleteAnimationSource: (p) => ipcRenderer.invoke('delete-animation-source', p),

  // Directories
  getAnimationsDir:  () => ipcRenderer.invoke('get-animations-dir'),
  getCharactersDir:  () => ipcRenderer.invoke('get-characters-dir'),
  getScenesDir:      () => ipcRenderer.invoke('get-scenes-dir'),

  // Scenes
  listScenes: ()    => ipcRenderer.invoke('list-scenes'),
  saveScene:  (d)   => ipcRenderer.invoke('save-scene', d),
  pickImage:  ()    => ipcRenderer.invoke('pick-image'),
  setSceneWallpaper:   (f) => ipcRenderer.invoke('set-scene-wallpaper', f),
  setSpannedWallpaper: (d) => ipcRenderer.invoke('set-spanned-wallpaper', d),
  setPerMonitorWallpaper: (f) => ipcRenderer.invoke('set-per-monitor-wallpaper', f),
  clearSceneWallpaper: ()  => ipcRenderer.invoke('clear-scene-wallpaper'),
  enterWallpaperMode:  (opts) => ipcRenderer.invoke('enter-wallpaper-mode', opts),
  exitWallpaperMode:   ()  => ipcRenderer.invoke('exit-wallpaper-mode'),
  sceneChanged:        (p) => ipcRenderer.invoke('scene-changed', p),
  setPropHitboxes:     (b) => ipcRenderer.invoke('set-prop-hitboxes', b),
  setSceneInteractive: (v) => ipcRenderer.invoke('set-scene-interactive', v),
  setSceneClickMove:   (v) => ipcRenderer.invoke('set-scene-clickmove', v),
  setPropCapture:      (v) => ipcRenderer.invoke('set-prop-capture', v),

  // Window (dragging is native via -webkit-app-region: drag in the overlay)
  getWindowPos:     ()     => ipcRenderer.invoke('get-window-pos'),
  resizeOverlay:    (w, h) => ipcRenderer.invoke('resize-overlay', [w, h]),
  moveOverlayTo:    (x, y) => ipcRenderer.invoke('move-overlay-to', [x, y]),
  getWorkArea:      ()     => ipcRenderer.invoke('get-work-area'),
  getOverlayBounds: ()     => ipcRenderer.invoke('get-overlay-bounds'),
  dockBottom:       ()     => ipcRenderer.invoke('dock-overlay-bottom'),

  // App-launch triggers
  watchApps:      (apps) => ipcRenderer.invoke('watch-apps', apps),
  onAppsChanged:  (cb)   => ipcRenderer.on('apps-changed', (_, running) => cb(running)),

  // Native context menu + screenshot
  showContextMenu: (payload) => ipcRenderer.invoke('show-context-menu', payload),
  onMenuCommand:   (cb)      => ipcRenderer.on('menu-command', (_, action) => cb(action)),
  saveScreenshot:  ()        => ipcRenderer.invoke('save-screenshot'),

  // App windows
  openStudio:      () => ipcRenderer.invoke('open-studio'),
  openMarketplace: () => ipcRenderer.invoke('open-marketplace'),
  installCharacter:     (d) => ipcRenderer.invoke('install-character', d),
  installAnimationPack: (d) => ipcRenderer.invoke('install-animation-pack', d),
  openExternal:    (u) => ipcRenderer.invoke('open-external', u),

  // System
  setAlwaysOnTop: (v) => ipcRenderer.invoke('set-always-on-top', v),
  setIgnoreMouse: (v) => ipcRenderer.invoke('set-ignore-mouse', v),
  getIdleSeconds: ()  => ipcRenderer.invoke('get-idle-seconds'),
  getServerPort:  ()  => ipcRenderer.invoke('get-server-port'),

  // Platform (renderer hit-tests props itself on win32/darwin — see overlay mousemove)
  platform: process.platform,

  // Events
  onCharacterChanged: (cb) => ipcRenderer.on('character-changed', (_, p) => cb(p)),
  onOverlayMoved:     (cb) => ipcRenderer.on('overlay-moved', () => cb()),
});
