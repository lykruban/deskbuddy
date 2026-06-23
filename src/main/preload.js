const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskbuddy', {
  // Settings
  getSettings:      ()  => ipcRenderer.invoke('get-settings'),
  saveSettings:     (s) => ipcRenderer.invoke('save-settings', s),

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

  // Directories
  getAnimationsDir:  () => ipcRenderer.invoke('get-animations-dir'),
  getCharactersDir:  () => ipcRenderer.invoke('get-characters-dir'),
  getScenesDir:      () => ipcRenderer.invoke('get-scenes-dir'),

  // Scenes
  listScenes: ()    => ipcRenderer.invoke('list-scenes'),
  saveScene:  (d)   => ipcRenderer.invoke('save-scene', d),
  pickImage:  ()    => ipcRenderer.invoke('pick-image'),
  setSceneWallpaper:   (f) => ipcRenderer.invoke('set-scene-wallpaper', f),
  clearSceneWallpaper: ()  => ipcRenderer.invoke('clear-scene-wallpaper'),
  enterWallpaperMode:  ()  => ipcRenderer.invoke('enter-wallpaper-mode'),
  exitWallpaperMode:   ()  => ipcRenderer.invoke('exit-wallpaper-mode'),
  sceneChanged:        (p) => ipcRenderer.invoke('scene-changed', p),
  setPropHitboxes:     (b) => ipcRenderer.invoke('set-prop-hitboxes', b),
  setSceneInteractive: (v) => ipcRenderer.invoke('set-scene-interactive', v),

  // Window (dragging is native via -webkit-app-region: drag in the overlay)
  getWindowPos:     ()     => ipcRenderer.invoke('get-window-pos'),
  resizeOverlay:    (w, h) => ipcRenderer.invoke('resize-overlay', [w, h]),
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

  // Events
  onCharacterChanged: (cb) => ipcRenderer.on('character-changed', (_, p) => cb(p)),
  onOverlayMoved:     (cb) => ipcRenderer.on('overlay-moved', () => cb()),
});
