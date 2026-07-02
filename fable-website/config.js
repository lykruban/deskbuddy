// ═══════════════════════════════════════════════════════════════════════════
//  DeskBuddy site CONFIG — everything swappable lives here.
// ═══════════════════════════════════════════════════════════════════════════
window.DB_CONFIG = {
  // Where the API lives (waitlist form posts to `${API_BASE}/api/waitlist`).
  API_BASE: 'https://api.yuvexel.com',

  // The hosted installer. Set to the real URL once it's on GitHub Releases / the server.
  // While empty, the download buttons explain hosting is being set up.
  DOWNLOAD_URL: '',            // e.g. 'https://github.com/lykruban/deskbuddy/releases/download/v1.0.0/DeskBuddy.Setup.1.0.0.exe'
  PORTABLE_URL: '',            // e.g. '.../DeskBuddy-Portable-1.0.0.exe'
  VERSION: 'v1.0.0',
  SIZE: '≈100 MB',

  // Live 3D buddy roster (CC0 VRoid samples via jsDelivr, CORS-enabled). Swap freely.
  MODELS: [
    { name: 'Shino',    url: 'https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shino.vrm' },
    { name: 'Shibu',    url: 'https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shibu.vrm' },
    { name: 'Fumiriya', url: 'https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sakurada_Fumiriya.vrm' },
  ],
  SWITCH_SECONDS: 4.5,         // buddy showcase cycles every N seconds (3–5)

  // Gallery media. `src:''` renders a beautiful labeled placeholder slot.
  // Drop real files in /media and set src to activate (mp4 loops muted, or png/jpg/gif).
  MEDIA: [
    { id: 'buddy-desktop', kind: 'video', ratio: '16/10', src: '', label: 'Buddy wandering a real desktop',       hint: 'screen capture · 10–15s loop' },
    { id: 'door-teleport', kind: 'video', ratio: '32/10', src: '', label: 'Walking between monitors — through a door', hint: 'dual-monitor capture · the money shot' },
    { id: 'scene-mode',    kind: 'image', ratio: '16/10', src: '', label: 'A living-wallpaper scene',              hint: 'screenshot of scene mode' },
    { id: 'studio',        kind: 'image', ratio: '16/10', src: '', label: 'Character Studio',                      hint: 'import your own model' },
    { id: 'scene-editor',  kind: 'image', ratio: '16/10', src: '', label: 'Scene Editor',                          hint: 'walls · doors · lights' },
    { id: 'characters',    kind: 'image', ratio: '16/10', src: '', label: 'Community characters',                  hint: 'a few example buddies' },
  ],

  // What the buddy mutters as you scroll past each section. Keep it charming, never mean.
  QUIPS: {
    hero:        'hi. i live here now.',
    showcase:    'ooh, screenshots of me. flattering angle, obviously.',
    versus:      'a fair fight? no. but a fun one.',
    features:    'i contain multitudes. six of them, apparently.',
    pricing:     'free?? i\'m worth at least $9.',
    marketplace: 'soon you can sell your own me. wild.',
    download:    'this is the part where we move in together.',
  },
};
