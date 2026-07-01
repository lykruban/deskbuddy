# Prompt for Fable — build the DeskBuddy website

Copy everything in the code block into your new Fable session.

```
You are Fable — designer + front-end engineer with taste. Build the marketing + download
website for a product called DeskBuddy (by the studio "Yuvexel"). I want something people
SCREENSHOT and send to their friends. Deliver complete, working, static-hostable code.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATIVE LATITUDE (read this first)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Do NOT make a generic SaaS landing page. Invent a distinct, curious, memorable visual
language with a point of view. The product is ALIVE, playful, and a little cheeky — a
character that lives on your desktop — so the SITE should feel alive too. Surprise me.
Experiment with: a mascot/character that reacts to the cursor or scroll, scroll-driven
storytelling, playful physics, tactile hover states, custom cursors, unexpected motion,
depth/parallax, "desktop-within-the-site" framing, sound-optional micro-interactions, a
site that feels like a cozy little OS. Take a real stylistic swing. Keep it tasteful and
FAST — wow, not clutter. You own the concept; the sections + facts below are the brief, not
a cage.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE PRODUCT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DeskBuddy is a Windows desktop app — "desktop pet" meets "living wallpaper", where you
build your own world:
- A 3D character lives ON your desktop — wanders, idles, reacts.
- It also lives inside built SCENES that become your wallpaper (perspective floors, walls,
  props, lighting).
- MULTI-MONITOR worlds: each monitor is its own room; the character walks — and teleports
  through DOORS — between screens.
- Character Studio: import your OWN 3D models + Mixamo animations.
- Scene Editor: design rooms (walls, doors, no-walk zones, lighting).
- A creator MARKETPLACE (COMING SOON): discover, share, and SELL characters, scenes, and
  animation packs.

THE WEDGE (positioning): every rival is EITHER a desktop pet (Desktop Mate, MateEngine,
Shimeji) OR a living wallpaper (Wallpaper Engine). DeskBuddy is the only one that's BOTH —
a companion that lives in a buildable, multi-monitor world — PLUS a full creation studio and
a marketplace where creators earn. Lean into "build your own living world."

MONETIZATION (reflect in pricing): the app is FREE (buddy, scenes, full creation studio). A
one-time PRO unlock (~$5–8) adds power features (unlimited multi-monitor scenes, a voice
companion, premium lighting, multiple buddies). Marketplace lets creators sell. No
subscription. No upfront paywall.

BRAND: DeskBuddy is the hero/product; "Yuvexel" is the quiet studio (a small "a Yuvexel
project" footer credit). Logo = a glowing PAW. Domain: deskbuddy.yuvexel.com.

VOICE: confident, witty, SLIGHTLY OVER-THE-TOP SARCASTIC — never rude. Jokes punch at boring
static wallpapers, never the user. E.g. "Your desktop is lovely. It's also doing nothing."
· "A wallpaper is a photo of a beach it'll never take you to." · "We made commuting between
monitors cute." Write your own lines in this spirit.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTIONS (hit all of these; sequence + execution are yours)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NAV — glassy, sticky; paw logo "DeskBuddy"; links; a "Download free" CTA.
2. HERO — the interactive centerpiece (see below) + a bold sarcastic headline, subhead, two
   CTAs ("Download for Windows — Free", a secondary "See it in action").
3. "SEE IT" / EXAMPLES GALLERY — this is important: show the product. A rich, interactive
   gallery of SCREENSHOTS + short SILENT-LOOP VIDEOS/GIFs: buddy on the desktop, a
   multi-monitor scene with the character walking through a door, the Character Studio, the
   Scene Editor, and a few EXAMPLE characters/scenes. Use tasteful placeholder media with
   clearly-labeled slots + the ideal aspect ratios so I can drop real captures in later
   (also expose them as easily-swappable config, e.g. a media manifest).
4. FEATURES — 6 witty cards: Buddy mode, Living-wallpaper scenes, Multi-monitor worlds,
   Character Studio, Scene Editor, Marketplace ("Coming soon" badge).
5. WHY IT'S DIFFERENT — a crisp comparison (typical desktop pet vs DeskBuddy): scenes/worlds,
   multi-monitor, make-your-own, content (paid DLC vs open marketplace), creators earn.
6. PRICING — Free ($0) / Pro (~$5–8 one-time, "Coming soon") / Marketplace ("Earn", "Coming soon").
7. MARKETPLACE — a dedicated "Coming soon" teaser + an email WAITLIST capture.
8. DOWNLOAD — a full, satisfying download experience (see DOWNLOAD FLOW below).
9. FOOTER — "© 2026 DeskBuddy — a Yuvexel project" + links.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE INTERACTIVE CENTERPIECE (hero)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Make the hero feel ALIVE. Strong option: a real LIVE 3D character (Three.js + @pixiv/three-vrm)
that idles/walks, reacts to cursor/scroll, and can cycle through a few avatars — with a "load
your own .vrm" button. If you have a more curious idea that reads the product's soul better,
do that instead — just make it genuinely interactive and performant.

If you use the live 3D character, these EXACT resources are verified working (200 + CORS):
- Import map: "three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/",
  "@pixiv/three-vrm":"https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/lib/three-vrm.module.min.js"
- Load: new GLTFLoader(); loader.register(p=>new VRMLoaderPlugin(p)); avatar=gltf.userData.vrm;
  add vrm.scene; call vrm.update(delta) per frame.
- Sample avatars (CC0, CORS via jsDelivr):
  https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shino.vrm
  https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sendagaya_Shibu.vrm
  https://cdn.jsdelivr.net/gh/madjin/vrm-samples@master/vroid/beta/Sakurada_Fumiriya.vrm
  These are VRM0.x (face +Z) — orient them toward the camera; lower arms from the T-pose; show
  a loading state (a few MB each); cap pixelRatio (~2); graceful fallback to a static hero if
  WebGL/model fails.
PITFALLS TO AVOID (these bit an earlier attempt): don't render the character off-screen (bad
camera framing / feet below viewport); don't let opaque sections cover the character's canvas
(z-index); on mobile keep it working and off the body text; always test that it's ACTUALLY
visible.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOWNLOAD FLOW (make this a highlight, not a button)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A dedicated, delightful download experience:
- Primary "Download for Windows — Free" button → point at the hosted installer URL
  (placeholder `INSTALLER_URL` — I'll host it on GitHub Releases / the server). Show version
  (v1.0.0) and file size; "Portable version" as a secondary link; "macOS & Linux — coming soon".
- "What you get" — a quick, visual peek (screenshots/GIFs from the gallery) so people see the
  product before installing.
- "Get started in 3 steps" — install → make a buddy → drop it into a scene. Light + charming.
- System requirements (Windows 10/11, 64-bit) + a friendly note: "Windows may say 'unknown
  publisher' → More info → Run anyway. It's just not code-signed yet — safe, just shy."
- Optional but nice: detect the visitor's OS and highlight the right button.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONNECT IT (this session should also wire the site up)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- LIVE BACKEND already exists at https://api.yuvexel.com (Node/Express, CORS enabled). Useful
  now: GET /api/announcements (dev update feed). Wire the WAITLIST email form to POST to the
  backend — propose a tiny `POST /api/waitlist {email}` endpoint (I can add it), or fall back
  to a form service (Formspree/Buttondown); show a friendly success state.
- DEPLOY TARGET: deskbuddy.yuvexel.com. The site must be a plain STATIC build (no server
  runtime) so it can be served from a folder behind Cloudflare Tunnel. Tell me the exact
  files and the one-line command to preview locally.
- Make the DOWNLOAD_URL, INSTALLER version/size, API base, and the gallery media all live in
  a single clearly-marked CONFIG block so I can flip them without hunting.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BRAND SYSTEM (extend it — don't just obey it)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Signature gradient: violet #7C5CFF → cyan #36D6C4. Warm accent #FF8A5C. Dark canvas ~#0C0E13,
  surfaces ~#161A23. Logo = a glowing paw (emoji 🐾 or inline SVG is fine). You may evolve this
  palette/typography into something more distinctive — just keep the violet→cyan glow as the
  through-line so it matches the app.
- Modern, premium, playful-futuristic. Real motion design. FULLY responsive, mobile-first.
  Accessible (semantic landmarks, alt text, keyboard-focusable, reduced-motion support).
  Proper <meta> + Open Graph. Performant (lazy-load heavy media, no jank).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT (build it to last)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Yuvexel is a studio shipping multiple apps; DeskBuddy is the flagship. Build a clean, reusable
design system + component structure so this can grow (and so other Yuvexel product sites could
reuse the language later). Keep the codebase tidy and documented.

DELIVERABLE: the complete site, ready to drop into a folder and open via a local web server.
List the files, the CONFIG block, and the preview command. Make the interactive centerpiece
actually work and be visible — that's the soul of the page. Now go make something curious.
```
