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

  // Gallery media. `src:''` renders a clean labeled placeholder slot.
  // Drop real files in /media and set src to activate (mp4 loops muted, or png/jpg/gif).
  MEDIA: [
    { id: 'buddy-desktop', kind: 'video', ratio: '16/10', src: '', label: 'Buddy wandering a real desktop',            hint: 'screen capture · 10–15s loop' },
    { id: 'door-teleport', kind: 'video', ratio: '32/10', src: '', label: 'Walking between monitors — through a door', hint: 'dual-monitor capture' },
    { id: 'scene-mode',    kind: 'image', ratio: '16/10', src: '', label: 'A living-wallpaper scene',                  hint: 'scene mode screenshot' },
    { id: 'studio',        kind: 'image', ratio: '16/10', src: '', label: 'Character Studio',                          hint: 'import your own model' },
    { id: 'scene-editor',  kind: 'image', ratio: '16/10', src: '', label: 'Scene Editor',                              hint: 'walls · doors · lights' },
    { id: 'characters',    kind: 'image', ratio: '16/10', src: '', label: 'Community characters',                      hint: 'example buddies' },
  ],
};
