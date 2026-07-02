# DeskBuddy website (fable-website)

A from-scratch, static marketing + download site. Concept: **the site is a living desktop** —
a real 3D VRM buddy walks the hero, docks bottom-right and follows you down the page, cycles
showcase characters every ~4.5s, accepts your own `.vrm`, and drops sarcastic speech-bubble
quips as you scroll past each section.

## Structure
```
fable-website/
├─ index.html        # semantic markup, all sections, import map
├─ config.js         # ⚙️ EVERYTHING swappable: API base, download URLs, models, media, quips
├─ css/style.css     # design system (dark editorial, violet→cyan glow, grain, motion)
├─ js/buddy.js       # the live 3D companion (three.js + @pixiv/three-vrm, ES module)
├─ js/main.js        # gallery builder, waitlist → API, download buttons, reveals
└─ media/            # drop real screenshots/loops here, then set src in config.js MEDIA
```

## Preview locally
Any static server works (ES modules won't run from file://):
```
cd fable-website && npx serve .          # or: python -m http.server 8090
```

## Go live (deskbuddy.yuvexel.com)
The server serves `/opt/deskbuddy/website`. Either point the `deskbuddy-web` service root at
`/opt/deskbuddy/fable-website`, or copy these files over `website/`. Then `git pull` on the
server. No build step.

## Wire-ups
- **Waitlist** posts to `${API_BASE}/api/waitlist` (endpoint live at api.yuvexel.com).
- **Download buttons** read `DOWNLOAD_URL` / `PORTABLE_URL` in `config.js` — set them once the
  installer is hosted (GitHub Release recommended; see NEXT-TASKS.md task 2).
- **Gallery**: drop captures in `media/`, set each item's `src` in `config.js`.

## Buddy correctness notes (do not regress)
- `VRMUtils.rotateVRM0(vrm)` is the official facing fix — never guess orientation.
- Models are auto-framed by bounding box (normalized height, feet on a wrapper-group origin).
- The canvas is fixed, `z-index` ABOVE content, `pointer-events:none` — sections can't hide it.
- Everything fails soft: if WebGL/models die, the buddy layer removes itself and the page
  stays clean.
