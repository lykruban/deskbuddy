// ═══════════════════════════════════════════════════════════════════════════
//  DeskBuddy site CONFIG — everything swappable lives here.
// ═══════════════════════════════════════════════════════════════════════════
window.DB_CONFIG = {
  API_BASE: 'https://api.yuvexel.com',

  // Shown before the live count loads (and if the API is unreachable), so the
  // page never displays a bare "0". The real numbers come from /api/app/stats.
  STATS_FALLBACK: { downloads: 0, likes: 0, reviews: 0, rating: 0 },

  DOWNLOAD_URL: 'https://github.com/lykruban/deskbuddy/releases/download/v1.0.0/DeskBuddy-Setup-1.0.0.exe',
  PORTABLE_URL: 'https://github.com/lykruban/deskbuddy/releases/download/v1.0.0/DeskBuddy-Portable-1.0.0.exe',
  ITCH_URL: 'https://lykruban.itch.io/deskbuddy',
  VERSION: 'v1.0.0',
  SIZE: '≈100 MB',

  // Home gallery (real captures).
  MEDIA: [
    { id: 'door-portal',    kind: 'video', ratio: '16/10', src: 'media/door-portal.mp4',    label: 'Portal — walking between monitors',  hint: '' },
    { id: 'door-particles', kind: 'video', ratio: '16/10', src: 'media/door-particles.mp4', label: 'Particle dissolve through a door',   hint: '' },
    { id: 'grab',           kind: 'video', ratio: '16/10', src: 'media/grab.mp4',           label: 'Grab your buddy',                    hint: '' },
    { id: 'door-beam',      kind: 'video', ratio: '16/10', src: 'media/door-beam.mp4',      label: 'Teleport beam',                      hint: '' },
    { id: 'door-poof',      kind: 'video', ratio: '16/10', src: 'media/door-poof.mp4',      label: 'Poof!',                              hint: '' },
    { id: 'studio',         kind: 'image', ratio: '16/10', src: 'media/studio-home.png',    label: 'Character Studio',                   hint: '' },
  ],

  // FAQ — rendered on support.html. Add entries here when a question gets frequent.
  FAQ: [
    { q: 'Windows says "unknown publisher" or blocks the installer. Is it safe?',
      a: 'Yes — the app just isn\'t code-signed yet (certificates cost money; it\'s coming). Click <b>More info → Run anyway</b>. If SmartScreen says it\'s "unreachable", right-click the downloaded file → <b>Properties</b> → tick <b>Unblock</b> → Apply, then run it normally.' },
    { q: 'Is DeskBuddy really free?',
      a: 'Yes. Buddy mode, scenes, and the full Character Studio + Scene Editor are free, no subscription. A one-time Pro unlock (power features) and a creator marketplace are coming later.' },
    { q: 'Can I use my own characters?',
      a: 'Absolutely — that\'s the point. <b>VRM</b> avatars (VRoid, VTuber models) work out of the box. Any other humanoid model just needs a free rig first: upload it to <a href="https://www.mixamo.com" rel="noopener" target="_blank">Mixamo</a> (free Adobe account), let it auto-rig, and import the rigged model — then add Mixamo animations and assign them to states. Step-by-step walkthrough in the <a href="docs.html#rigging">documentation</a>.' },
    { q: 'Is Mixamo free? Do I need it?',
      a: 'Mixamo is a free Adobe service — free account, and the rigs and animations are royalty-free for personal and commercial use. You only need it to (a) rig a non-VRM model, or (b) grab animation clips. VRM avatars skip rigging entirely. Full guide: <a href="docs.html#rigging">how to rig on Mixamo</a>.' },
    { q: 'How do the multi-monitor scenes work?',
      a: 'Each monitor becomes a room of the scene. Your buddy wanders between them through doors you place — with a transition effect you pick per door (portal, particles, beam, vortex, fade, poof).' },
    { q: 'Where do animations come from?',
      a: 'Import free animations from <a href="https://www.mixamo.com" rel="noopener" target="_blank">Mixamo</a> (FBX), or bring your own. The Studio retargets them onto your character.' },
    { q: 'The character isn\'t visible after install.',
      a: 'Check the system tray (bottom-right) → the DeskBuddy paw icon → "Show Buddy". If the tray icon is missing, relaunch the app. Still stuck? Report it below with your Windows version.' },
    { q: 'Does it slow my PC down?',
      a: 'It\'s a lightweight overlay — you can tune Quality and Frame rate from the tray menu. "Low" quality + 30 FPS is nearly free on any modern machine.' },
    { q: 'When is the marketplace coming?',
      a: 'It\'s in active development. Join the waitlist on the home page to get pinged the moment it opens — creators will be able to sell characters, scenes and animation packs.' },
  ],

  // Blog — newest first. Ask Claude to append entries (bug write-ups, tips, announcements).
  BLOG: [
    { id: 'update-root-motion', date: '2026-07-04', title: 'Update: Mixamo-accurate animation travel 🦶',
      body: `Fresh build is up. The headline: <b>"Move on" animations in scenes now play their root
motion exactly as authored</b> — the planted foot stays nailed to the floor while the body moves,
just like the Mixamo preview, and the character genuinely ends up where the animation took it.
"In place" clips are now hips-pinned the same way Mixamo does it: cleanly centred, no
slide-and-snap.<br><br>Also in this build: the tray menu no longer dismisses itself, Save &amp;
Activate mid-scene reloads the scene instead of crashing it, and the app self-heals if a window's
renderer dies. Grab the latest from the <a href="download.html">download page</a> — and the new
<a href="support.html">support page</a> means your bug reports now land directly on our desk.` },
    { id: 'hello-world', date: '2026-07-04', title: 'DeskBuddy is live 🐾',
      body: `Your desktop is lovely — it's also doing nothing. So we built DeskBuddy: a companion that
lives on your screen and in little worlds you build, across every monitor you own.
<br><br>What's in v1.0.0: buddy mode, living-wallpaper scenes, multi-monitor rooms with door
transitions (portal! particles! poof!), a full Character Studio (bring your own models +
Mixamo animations), a Scene Editor, accounts with a portable library, and an in-app update
inbox.<br><br>It's free. Go adopt one — and tell us what to build next.` },
  ],
};
