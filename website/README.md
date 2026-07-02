# DeskBuddy website

Static site served at **https://deskbuddy.yuvexel.com** (see `DEPLOY-HANDOFF.md` — a tiny static
server behind Cloudflare Tunnel points at this folder).

## Files
| file | what |
|---|---|
| `index.html` | the whole page (nav → hero → gallery → features → compare → pricing → marketplace/waitlist → download → footer) |
| `config.js`  | **THE config block** — download URLs, version/size, API base, hero avatars, gallery media manifest. Edit this, not the code. |
| `site.css`   | design system ("cozy little OS": violet→cyan glow, glass chrome, the dual-monitor rig) |
| `hero.js`    | the live 3D buddy (three.js + @pixiv/three-vrm via CDN import map) — idles, follows the cursor, blinks, hops when clicked, walks between the two hero monitors through the bezel gap |
| `site.js`    | everything else: gallery from the media manifest, waitlist POST, download wiring + OS detect, reveals, taskbar clocks, announcements toast |
| `media/`     | (create it) drop real screenshots/clips here and point `MEDIA[].src` at them |

## Preview locally
```
npx http-server website -p 8080
```
(or any static server — `python -m http.server 8080` from inside `website/` works too), then open
http://localhost:8080. Everything external (three.js, VRM avatars, fonts) loads from CDNs, so you
need to be online.

## Flip-the-switch checklist
1. **Download live:** set `DOWNLOAD_URL` (+ `PORTABLE_URL`) in `config.js` to the GitHub Release
   asset links. Until then the buttons show "Almost ready — join the waitlist".
2. **Real media:** drop captures into `website/media/`, set each `MEDIA[].src` in `config.js`
   (placeholders list each slot's ideal capture format).
3. **Own avatars:** add `{ name, url }` entries to `AVATARS` (relative paths OK; `.vrm` gets the
   full walk/gaze/blink treatment, `.glb` gets bob+slide).
4. Deploy: commit + push, then on the server `cd /opt/deskbuddy && git pull` (static server picks
   it up immediately).

## Wired to the live backend
- Waitlist form → `POST {API_BASE}/api/waitlist {email}` (already deployed).
- Hero toast → `GET {API_BASE}/api/announcements` (latest item, fails silently).
