# DeskBuddy website (fable-website)

A minimalist, dark, static marketing + download site. Typography-led, hairline borders,
one restrained violet→cyan gradient accent, sarcastic-but-kind copy. No 3D/WebGL — the
earlier live-VRM hero was removed by request (git history has it if ever wanted back).

## Structure
```
fable-website/
├─ index.html        # semantic markup, all sections
├─ config.js         # ⚙️ EVERYTHING swappable: API base, download URLs, media
├─ css/style.css     # minimalist dark design system
├─ js/main.js        # gallery builder, waitlist → API, download buttons, reveals
└─ media/            # drop real screenshots/loops here, then set src in config.js MEDIA
```

## Preview locally
Any static server (e.g. `npx serve .` or `python -m http.server 8090`).

## Go live (deskbuddy.yuvexel.com)
The server serves `/opt/deskbuddy/website`. Either point the `deskbuddy-web` service root at
`/opt/deskbuddy/fable-website`, or copy these files over `website/`. Then `git pull` on the
server. No build step.

## Wire-ups
- **Waitlist** posts to `${API_BASE}/api/waitlist` (endpoint live at api.yuvexel.com).
- **Download buttons** read `DOWNLOAD_URL` / `PORTABLE_URL` in `config.js` — set them once the
  installer is hosted (GitHub Release recommended; see NEXT-TASKS.md task 2).
- **Gallery**: drop captures in `media/`, set each item's `src` in `config.js`.
