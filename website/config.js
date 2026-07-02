/* ============================================================================
   DESKBUDDY SITE CONFIG — the ONLY file you should need to touch.
   Flip download links, version, API base, hero avatars and gallery media here.
   ============================================================================ */
window.DESKBUDDY_CONFIG = {

  // ---- Backend ------------------------------------------------------------
  API_BASE: "https://api.yuvexel.com",

  // ---- Download -----------------------------------------------------------
  // Paste the hosted installer URL (e.g. a GitHub Release asset link).
  // While this is empty, the download buttons show a friendly "almost ready"
  // state and point people at the waitlist instead.
  DOWNLOAD_URL: "",          // e.g. "https://github.com/lykruban/deskbuddy/releases/download/v1.0.0/DeskBuddy.Setup.1.0.0.exe"
  PORTABLE_URL: "",          // e.g. ".../DeskBuddy.1.0.0-Portable-.exe"
  VERSION: "1.0.0",
  FILE_SIZE: "~95 MB",

  // ---- Hero avatars ---------------------------------------------------------
  // .vrm gets the full treatment (walk cycle, gaze, blinking, expressions).
  // .glb also works (auto-scaled, bob + slide only). Add your own below —
  // relative paths are fine, e.g. "models/goku.glb".
  AVATARS: [
    { name: "Shino",    url: "https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shino.vrm" },
    { name: "Shibu",    url: "https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shibu.vrm" },
    { name: "Fumiriya", url: "https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sakurada_Fumiriya.vrm" }
  ],

  // ---- Gallery media --------------------------------------------------------
  // Set `src` to a real file (drop it in website/media/ and use "media/foo.mp4").
  // While `src` is null the site renders a clearly-labeled placeholder slot
  // with the ideal aspect ratio, so the layout is honest before capture day.
  //   type: "video" → silent autoplay loop (mp4/webm). type: "image" → jpg/png/gif.
  MEDIA: [
    {
      id: "buddy-desktop", type: "video", src: null, aspect: "16 / 9",
      title: "Buddy mode",
      caption: "A buddy loose on a real desktop, ignoring your deadlines with you.",
      ideal: "1920×1080 MP4, 5–10s silent loop"
    },
    {
      id: "door-walk", type: "video", src: null, aspect: "21 / 9",
      title: "The door trick",
      caption: "Walking out of one monitor and into the next. We made commuting cute.",
      ideal: "ultrawide capture of both monitors, MP4 loop"
    },
    {
      id: "character-studio", type: "image", src: null, aspect: "16 / 9",
      title: "Character Studio",
      caption: "Import your own models + Mixamo animations.",
      ideal: "1920×1080 screenshot"
    },
    {
      id: "scene-editor", type: "image", src: null, aspect: "16 / 9",
      title: "Scene Editor",
      caption: "Rooms, walls, doors, no-walk zones, lighting. City planning, but cozy.",
      ideal: "1920×1080 screenshot"
    },
    {
      id: "example-characters", type: "image", src: null, aspect: "4 / 3",
      title: "Your cast",
      caption: "Any character you can import is a character you can live with.",
      ideal: "collage / 4:3 screenshot"
    },
    {
      id: "example-scene", type: "image", src: null, aspect: "16 / 9",
      title: "A built world",
      caption: "A finished scene, lit and inhabited.",
      ideal: "1920×1080 screenshot"
    }
  ]
};
