import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { floorToScreen, screenToFloor, depthScaleAt, widthAt, splitGlobalU } from '../scene/floor.js';
import { normalizeScenepack, normalizeShadow } from '../scene/scenepack.js';
import { createBehavior } from '../scene/behavior.js';

// Imported FBX clips are retargeted to the VRM's normalized bones in Studio
// (see studio.js · retargetClipsForVRM) before being saved into the charpack,
// so the overlay just deserializes and plays them — no retargeting here.

// ── Canvas & renderer ─────────────────────────────────────────────────────────
const canvas  = document.getElementById('c');
const emptyEl = document.getElementById('empty');
const toastEl = document.getElementById('toast');

// antialias on by default — the previous no-AA + 1× pixel-ratio combo made edges
// shimmer/flicker during the subtle idle motion. Quality (below) tunes sharpness.
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: true, powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
// We composite in 3 passes (shadow silhouette → cast shadow quad → character),
// so we manage clears ourselves instead of letting each render() clear.
renderer.autoClear = false;
renderer.setClearColor(0x000000, 0);

// ── Render quality + frame rate (user-tunable, persisted) ──────────────────────
let quality = 'medium', targetFps = 60;
let TARGET_MS = 1000 / targetFps;
function pixelRatioFor(q) {
  const dpr = window.devicePixelRatio || 1;
  return q === 'low' ? 1 : q === 'high' ? Math.min(dpr * 1.5, 2.5) : Math.min(dpr, 1.5);
}
function applyQuality(q) {
  quality = q;
  renderer.setPixelRatio(pixelRatioFor(q));
  resizeCanvas(lastW, lastH);   // re-apply size so the drawing buffer updates
}
function applyFps(n) { targetFps = n; TARGET_MS = 1000 / n; }

// Shadow tiers driven by the Light & Shadow setting:
//   low    = a simple soft blob under the feet (cheap).
//   medium = the character's real silhouette, projected from the light (supersampled).
//   high   = same, but sharper (more supersampling) and darker.
//   super     silhouette render-target supersample (sharper when projected)
//   opacity   darkness multiplier on the cast silhouette
//   lenMul    shadow-length multiplier
//   tipFade   alpha at the far tip (lower = softer fade-out)
//   blurBase  baseline edge softness at 0 user-softness (kept tiny so it reads sharp)
const SHADOW_Q = {
  low:    { mode: 'blob', contactMul: 1.0 },
  medium: { mode: 'cast', super: 1.5, opacity: 0.95, lenMul: 1.0, tipFade: 0.45, blurBase: 0.0011 },
  high:   { mode: 'cast', super: 2.0, opacity: 1.15, lenMul: 1.0, tipFade: 0.60, blurBase: 0.0005 },
};
const shadowQ = () => SHADOW_Q[lightMode] || SHADOW_Q.medium;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);

// Base (buddy-mode) lighting. Scenes can recolour/replace this via their lights —
// see applySceneCharacterLighting()/resetCharacterLighting().
const AMBIENT_BASE = 1.1, DIR_BASE = 1.4;
const ambient = new THREE.AmbientLight(0xffffff, AMBIENT_BASE);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, DIR_BASE);
dir.position.set(1, 3, 2);
scene.add(dir);
// Extra coloured directional lights a scene adds to tint the character.
let sceneCharLights = [];
// Light & Shadow quality: 'low' = neutral lighting + a light shadow; 'medium' = colour
// bounce (cheap GI) + a fuller shadow; 'high' = stronger bounce + the darkest, widest
// shadow. Drives both character lighting (giOn/boost) and the ground shadow (shadowQ).
let lightMode = 'medium';
const giOn = () => lightMode === 'medium' || lightMode === 'high';
let propClicks = false;   // can the user click props to trigger their animations? (default OFF — desktop stays fully click-through)
let clickToMove = false; // click anywhere on the floor → the character walks there
let sceneWander = true;  // Random Walking: off = the character parks (independent of click-to-move)
// Windows/macOS: renderer drives per-hover click capture (see mousemove handler). Tracks
// whether main is currently capturing clicks so we only IPC on change.
const NATIVE_FORWARD = window.deskbuddy.platform && window.deskbuddy.platform !== 'linux';
let _propCapturing = false;

function avgLightColor(lights) {
  const c = new THREE.Color(); let r = 0, g = 0, b = 0;
  for (const L of lights) { c.set(L.color || '#ffffff'); r += c.r; g += c.g; b += c.b; }
  const n = Math.max(1, lights.length); return new THREE.Color(r / n, g / n, b / n);
}

// Light the character from the scene's light sources: each light tints the model in
// its own colour, positioned from its floor placement (u,v) + height so the lighting
// direction matches where the light sits in the scene. With Light Quality on, a
// hemisphere fill tinted by the average light colour fakes colour bouncing onto the
// character (cheap GI) and point lights add local wrap.
function applySceneCharacterLighting(cfg) {
  resetCharacterLighting();
  const lights = (cfg?.enabled && Array.isArray(cfg.lights)) ? cfg.lights : [];
  if (!lights.length) return;
  // Tint the ambient fill with the scene's light colours and dim the neutral white base
  // hard, so the coloured lights clearly read on the character (even invisible ones).
  ambient.color.copy(avgLightColor(lights));
  ambient.intensity = AMBIENT_BASE * (giOn() ? 0.6 : 0.45);
  dir.intensity = DIR_BASE * 0.2;
  const boost = lightMode === 'high' ? 1.7 : lightMode === 'medium' ? 1.45 : 1.15;
  for (const L of lights) {
    const inten = (0.9 + 1.3 * (L.intensity ?? 0.35)) * boost;
    const col = new THREE.Color(L.color || '#ffffff');
    // floor (u,v)+height → a view-space light position: u=left/right, height=up,
    // v=depth (back→front), biased toward the camera so the visible side is lit.
    const px = (L.u - 0.5) * 2.5, py = (L.height || 0.5) + 0.6, pz = (L.v - 0.5) * 2.5 + 1.3;
    const dl = new THREE.DirectionalLight(col, inten);
    dl.position.set(px, py, pz);
    scene.add(dl); sceneCharLights.push(dl);
    if (L.mode === 'point') {   // local omni wrap for point lights
      const pl = new THREE.PointLight(col, inten * 0.6 * (L.distance || 1), 0, 2);
      pl.position.set(px, py, pz); scene.add(pl); sceneCharLights.push(pl);
    }
  }
  if (giOn()) {   // GI bounce: scene-colour fill so light "bounces" onto the character
    const hemi = new THREE.HemisphereLight(avgLightColor(lights), new THREE.Color(0x111118), lightMode === 'high' ? 0.85 : 0.6);
    scene.add(hemi); sceneCharLights.push(hemi);
  }
}
function resetCharacterLighting() {
  for (const l of sceneCharLights) scene.remove(l);
  sceneCharLights = [];
  ambient.intensity = AMBIENT_BASE; ambient.color.setHex(0xffffff);
  dir.intensity = DIR_BASE; dir.color.setHex(0xffffff);
}
function setLightMode(m) {
  lightMode = (m === 'low' || m === 'high') ? m : 'medium';
  if (activeScene) applySceneCharacterLighting(sceneShadowCfg);   // re-apply live
}

// ── App state ─────────────────────────────────────────────────────────────────
let vrm = null, modelRoot = null, mixer = null, clips = [], manifest = {};
let userScale = 1.0, alwaysOnTop = true, passThrough = false;
let currentState = 'idle';
let modelBaseRotY = 0;        // base "faces camera" yaw (π for VRM, 0 for GLB) + saved rot.y
let modelBaseRotX = 0, modelBaseRotZ = 0;   // saved creator tilt (applied in scene mode too)
let activeCharPath = null;    // current character file (to reload when exiting a scene)
const clock = new THREE.Clock();
let breathPhase = 0, swayPhase = 0;

// ── Cast shadow ───────────────────────────────────────────────────────────────
// A real projected silhouette (Deskmate-style) instead of a ground blob. Each
// frame we render the character flat-black into an offscreen target, then draw
// that silhouette on a screen-space quad that's SHEARED toward the light — so it
// reads as the character's own shadow leaning across the surface behind it.
// Render-to-texture (not a cloned skinned mesh) keeps it robust: no three.js
// bind-matrix gotchas, works identically for VRM and plain rigged GLB.
let shadowEnabled = true;
let shadowRT = null, shadowScene2 = null, shadowCam2 = null, shadowQuad = null,
    shadowMat = null, darkOverride = null, shadowRTW = 0, shadowRTH = 0;
// Shadow placement (screen-space, all user-tunable in the Shadow Settings panel
// and persisted). Defaults: a straight, upright silhouette sitting BEHIND the
// character with a gap (not connected at the feet).
//   dist    gap distance from the feet                (0 = touching)
//   angle   direction the shadow is offset, degrees   (90 = straight up/behind)
//   yaw     in-plane rotation of the silhouette, deg
//   lean    shear (lean) per unit height              (0 = straight)
//   squash  vertical length (1 = full height)
//   scale   overall size
//   opacity darkness
const SHADOW_DEFAULTS = { dist: 0.22, angle: 90, yaw: 0, lean: 0, squash: 0.9, scale: 0.85, opacity: 0.30 };
let shadowCfg = { ...SHADOW_DEFAULTS };

// ── Foot grounding ─────────────────────────────────────────────────────────────
// Mixamo position tracks are stripped on import (they'd explode to ~90m), so for
// sit/jump/crouch clips the pose is right but the root stays at standing height —
// the character floats on its hips. Fix: each animated frame, shift the model so
// its lowest foot bone rests on the ground line captured at rest.
let groundBones = [], groundLineY = null, feetGrounded = true, restPosY = 0, restPosX = 0, restPosZ = 0;
let currentClipName = null, currentAction = null;   // clip + action playing in buddy mode
let clipAdjustMap = {};   // clipName → { speed, ox, oy, oz, pin }
let overlayWalkSpeed = 0;  // per-character walk-speed override (0 = use the scene's)
let modelWorldH = 1;   // character world height (for scaling root motion to the model)
const _wp = new THREE.Vector3();

// Auto-grounding: a clip is foot-pinned ONLY if it carries NO root motion of its own.
// Clips with root motion (jumps, walks) drive their vertical themselves — the feet leave
// the floor naturally — so we never pin them. No manual per-clip toggle needed.
let rootMotionMap = {};   // clipName → { times, dx, dy, dz } (normalized to hips height)
let clipMoveMap = {};     // clipName → true: apply horizontal travel; default in place
function clipNeedsGrounding(name) { return !(name && rootMotionMap[name]); }
// Sample a normalized root-motion curve at time t (looping).
function sampleRoot(rm, t) {
  const T = rm.times; if (!T || !T.length) return { dx: 0, dy: 0, dz: 0 };
  const dur = T[T.length - 1] || 1; let tt = t % dur; if (tt < 0) tt += dur;
  let i = 0; while (i < T.length - 1 && T[i + 1] < tt) i++;
  const j = Math.min(i + 1, T.length - 1);
  const f = T[j] > T[i] ? (tt - T[i]) / (T[j] - T[i]) : 0;
  const L = (a) => a[i] + (a[j] - a[i]) * f;
  return { dx: L(rm.dx), dy: L(rm.dy), dz: L(rm.dz) };
}
const ROOT_VFAC = 0.55;   // floor→hips fraction of total height (hop scaling)

// antiSinkBones: a broader extremity set (feet, hands, head, knees, elbows) used by the
// root-motion path to keep ANY part of the body from dropping below the floor (e.g. a flip
// kick where the head/hands swing low) — without pinning, so jumps can still rise.
let antiSinkBones = [];
function collectGroundBones() {
  groundBones = []; antiSinkBones = []; groundLineY = null;
  const VRM_FEET = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'];
  const VRM_SINK = [...VRM_FEET, 'leftHand', 'rightHand', 'head', 'leftLowerLeg', 'rightLowerLeg', 'leftLowerArm', 'rightLowerArm'];
  const MX_FEET = ['mixamorigLeftFoot', 'mixamorigRightFoot', 'mixamorigLeftToeBase', 'mixamorigRightToeBase'];
  const MX_SINK = [...MX_FEET, 'mixamorigLeftHand', 'mixamorigRightHand', 'mixamorigHead', 'mixamorigLeftLeg', 'mixamorigRightLeg', 'mixamorigLeftForeArm', 'mixamorigRightForeArm'];
  if (vrm?.humanoid?.getRawBoneNode) {
    VRM_FEET.forEach(n => { const b = vrm.humanoid.getRawBoneNode(n); if (b) groundBones.push(b); });
    VRM_SINK.forEach(n => { const b = vrm.humanoid.getRawBoneNode(n); if (b) antiSinkBones.push(b); });
  }
  if (!groundBones.length && modelRoot) {
    const byName = {};
    modelRoot.traverse(o => { if (o.isBone) byName[o.name] = o; });
    MX_FEET.forEach(n => { if (byName[n]) groundBones.push(byName[n]); });
    MX_SINK.forEach(n => { if (byName[n]) antiSinkBones.push(byName[n]); });
  }
  if (!antiSinkBones.length) antiSinkBones = groundBones.slice();
}

function lowestFootY() {
  let lo = Infinity;
  for (const b of groundBones) { b.getWorldPosition(_wp); if (_wp.y < lo) lo = _wp.y; }
  return lo;
}
function lowestSinkY() {
  let lo = Infinity;
  for (const b of antiSinkBones) { b.getWorldPosition(_wp); if (_wp.y < lo) lo = _wp.y; }
  return lo;
}

// Pin the lowest foot to the ground line. First call (at rest) captures the line.
function groundModel() {
  if (!modelRoot || !groundBones.length) return;
  modelRoot.updateMatrixWorld(true);
  const lo = lowestFootY();
  if (!isFinite(lo)) return;
  if (groundLineY === null) { groundLineY = lo; return; }
  modelRoot.position.y += (groundLineY - lo);
}

// Lazily build the offscreen target + the screen-space quad that displays the
// sheared silhouette. Sized to the canvas drawing buffer so the silhouette lines
// up 1:1 with the character before it's sheared.
function ensureShadowRig() {
  const dpr = renderer.getPixelRatio();
  const w = Math.max(2, Math.round(lastW * dpr)), h = Math.max(2, Math.round(lastH * dpr));
  if (!shadowRT) {
    shadowRT = new THREE.WebGLRenderTarget(w, h);
    darkOverride = new THREE.MeshBasicMaterial({ color: 0x000000 }); // flatten char to black
    shadowScene2 = new THREE.Scene();
    // Ortho cam over [-1,1]² (NDC); a 2×2 plane fills the canvas.
    shadowCam2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    shadowMat = new THREE.MeshBasicMaterial({
      map: shadowRT.texture, transparent: true, depthTest: false, depthWrite: false,
      color: 0x000000, opacity: shadowCfg.opacity,
    });
    shadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), shadowMat);
    shadowScene2.add(shadowQuad);
    shadowRTW = w; shadowRTH = h;
    applyShadowTransform();
  } else if (w !== shadowRTW || h !== shadowRTH) {
    shadowRT.setSize(w, h); shadowRTW = w; shadowRTH = h;
  }
}

// Place the silhouette quad from shadowCfg. Pivot is the feet (bottom-center, NDC
// (0,-1)); we scale → squash → lean → yaw → then offset by `dist` along `angle`,
// so the shadow can sit detached behind the character with a gap.
function applyShadowTransform() {
  if (!shadowQuad) return;
  const { dist, angle, yaw, lean, squash, scale } = shadowCfg;
  const aR = angle * Math.PI / 180, yR = yaw * Math.PI / 180;
  const cos = Math.cos(yR), sin = Math.sin(yR);
  const offX = dist * Math.cos(aR), offY = dist * Math.sin(aR);
  const p = shadowQuad.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const cx = (i % 2 === 0) ? -1 : 1;   // base corner x
    const cy = i < 2 ? 1 : -1;           // first two verts are the top row
    let lx = cx * scale;                 // local space, pivot at feet (cy+1)
    let ly = (cy + 1) * scale * squash;
    lx += lean * ly;                     // shear
    const rx = lx * cos - ly * sin;      // in-plane yaw
    const ry = lx * sin + ly * cos;
    p.setX(i, rx + offX);
    p.setY(i, ry - 1 + offY);            // -1 returns the pivot to the feet line
  }
  p.needsUpdate = true;
  if (shadowMat) shadowMat.opacity = shadowCfg.opacity;
}

// Render the black silhouette into the offscreen target. Called each frame before
// the main pass; the shadow quad samples this in the composite below.
function renderShadowSilhouette() {
  ensureShadowRig();
  const prev = scene.overrideMaterial;
  scene.overrideMaterial = darkOverride;
  renderer.setRenderTarget(shadowRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = prev;
}

// ── Scene mode ────────────────────────────────────────────────────────────────
// When a .scenepack is active the overlay becomes a living-wallpaper region: a
// large window with a 2D background, the character walking the floor in perspective
// (scene/floor.js), driven by the wander brain (scene/behavior.js), and a 2D
// foreground layer for occlusion. Uses an ORTHOGRAPHIC camera so screen↔world is
// linear; the 3D feel comes from the floor quad's perspective + depth scaling.
let activeScene = null, scenePath = null, behavior = null;
// Wallpaper mode: the scene's background becomes the real desktop wallpaper and
// the overlay spreads transparent across the screen so the character walks on it.
// The whole overlay is click-through here (the desktop stays fully usable) and all
// scene controls — including Exit Scene — live in the tray menu instead.
let wallpaperMode = false;
let sceneCam = null, bgScene2 = null, fgScene2 = null, bgMesh = null;
// Foreground items: floor-placed sprites that occlude the character. Each entry is
// { mesh, item } where item is the scenepack foreground data.
let fgSprites = [];
const FG_BASE_HEIGHT = 1.5;   // world height of a scale-1 floor item at the near edge
// Scene ground shadow: a soft contact pool + an oriented cast blob on the floor
// (see renderSceneGroundShadow). Settings come from the scenepack (per-scene).
let _sbb = null;   // smoothed character bbox (de-jitters the shadow width during animation)
let contactScene = null, contactMesh = null, contactMat = null;   // always-on grounding pool under the feet
let sceneShadowCfg = { enabled: true, lights: [{ angle: 90, intensity: 0.35, length: 0.55, softness: 0.4 }] };
let sceneFeetX = 0, sceneFeetY = -1, sceneFeetUV = { u: 0.5, v: 0.7 };
let sceneLift = 0;   // character lift above the floor (fraction of height) — shrinks the shadow
// Multi-display: a scene can span several rooms (one per monitor) laid out left→right in a
// global-u coordinate. sceneRoomRegions[i] = the i-th room's rectangle (fractions of the
// spanned canvas). For 1 room this is the whole canvas and everything works as before.
let sceneDisplays = 1, sceneRoomRegions = [{ x: 0, y: 0, w: 1, h: 1 }];
let sceneShadowFloor = null, sceneShadowReg = { x: 0, y: 0, w: 1, h: 1 };   // active room for the shadow
let sceneShadowWalls = [];   // walls of the character's current room (floor u,v) — shadows climb these
// Character opacity for door teleports (1 = solid). The behavior brain dips this to 0 as the
// character vanishes into a door and back to 1 as it reappears at the other screen's door; the
// model AND its ground shadow fade together so it reads as stepping through the doorway.
let sceneCharFade = 1;
let _charFadeMats = null, _charFaded = false;   // cached materials + their original blend state
function applyCharacterFade(a) {
  if (!modelRoot) return;
  if (a >= 0.999) {   // fully solid → restore the original (opaque) material state once
    if (_charFaded && _charFadeMats) {
      for (const m of _charFadeMats) { m.mat.transparent = m.t; m.mat.opacity = m.o; m.mat.depthWrite = m.dw; m.mat.needsUpdate = true; }
      _charFaded = false;
    }
    return;
  }
  if (!_charFadeMats) {
    _charFadeMats = [];
    modelRoot.traverse(o => {
      if (!o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of arr) _charFadeMats.push({ mat, t: mat.transparent, o: mat.opacity, dw: mat.depthWrite });
    });
  }
  for (const m of _charFadeMats) { m.mat.transparent = true; m.mat.opacity = m.o * a; m.mat.depthWrite = false; }
  _charFaded = true;
}
// Floor point → spanned-canvas fraction, through a room's region (identity for 1 room).
function floorToCanvas(f, u, v, reg) {
  const sp = floorToScreen(f, u, v);
  return reg ? { x: reg.x + sp.x * reg.w, y: reg.y + sp.y * reg.h } : sp;
}
// Resolve a global-u to its room's floor, local-u, and canvas region. Single-room → the
// whole canvas.
function resolveRoom(globalU) {
  if (sceneDisplays <= 1) return { floor: activeScene.floor, u: globalU, region: sceneRoomRegions[0], roomIndex: 0 };
  const sp = splitGlobalU(globalU, sceneDisplays);
  const room = (activeScene.rooms && activeScene.rooms[sp.room]) || activeScene.rooms[0];
  return { floor: room.floor, u: sp.u, region: sceneRoomRegions[Math.min(sp.room, sceneRoomRegions.length - 1)], roomIndex: sp.room };
}
let sceneCurrentClip = null, sceneCurrentAction = null, scenesDirCache = null;
const sceneModel = { height: 1, minY: 0 };
let sceneBaseScale = 1;
const SCENE_CHAR_HEIGHT = 0.62;   // character world-height at the near floor edge (frustum is ±1 tall)

function blobTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.6, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function placeholderBgTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 576;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 576);
  g.addColorStop(0, '#241f38'); g.addColorStop(0.5, '#5d4068');
  g.addColorStop(0.6, '#b78b6a'); g.addColorStop(1, '#2e2536');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 576);
  x.strokeStyle = 'rgba(255,255,255,0.06)'; x.lineWidth = 1;
  for (let i = 0; i <= 10; i++) { const y = 330 + i * 24; x.beginPath(); x.moveTo(0, y); x.lineTo(1024, y); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function ensureSceneLayers() {
  if (bgScene2) return;
  sceneCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  sceneCam.position.set(0, 0, 5); sceneCam.lookAt(0, 0, 0);
  bgScene2 = new THREE.Scene(); fgScene2 = new THREE.Scene();
  bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthWrite: true }));
  bgMesh.position.z = -2; bgMesh.renderOrder = 0; bgScene2.add(bgMesh);
}

// ── Scene ground shadow (projected silhouette) ─────────────────────────────────
// The character's ACTUAL silhouette, projected onto the floor from the light's position
// — a real drop shadow, not a blob. We render the character flat-black to a texture, then
// map that texture onto a floor quad whose corners are the planar projection of the
// character's standing billboard through the light: the feet edge stays planted at the
// feet, the head edge projects AWAY from the light by an amount set by the light's height
// (lower light → longer shadow). The quad's width follows the character's own width along
// the floor (no perpendicular skew, no side-clipping), and the floor homography
// foreshortens it with perspective.
let gShadowRT = null, gShadowScene = null, gShadowQuad = null, gShadowMat = null, gShadowW = 0, gShadowH = 0;
const GSHADOW_VERT = `
  attribute float aLen;
  varying vec2 vUv;
  varying float vLen;        // 0 at the feet, 1 at the tip (for the tip fade)
  void main() { vUv = uv; vLen = aLen; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// Soft edges via a filled 7×7 Gaussian on the silhouette alpha; a gentle fade over the
// last stretch toward the tip (uTipFade) keeps the far end from looking like a hard cut.
const GSHADOW_FRAG = `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uTipFade;
  uniform vec2 uBlur;
  varying vec2 vUv;
  varying float vLen;
  void main() {
    float a = 0.0, tot = 0.0;
    for (int x = -3; x <= 3; x++) {
      for (int y = -3; y <= 3; y++) {
        float w = exp(-float(x * x + y * y) * 0.28);
        a += texture2D(uMap, vUv + vec2(float(x), float(y)) * uBlur).a * w;
        tot += w;
      }
    }
    float fade = mix(1.0, uTipFade, clamp((vLen - 0.55) / 0.45, 0.0, 1.0));
    gl_FragColor = vec4(0.0, 0.0, 0.0, (a / tot) * uOpacity * fade);
  }`;

function ensureSceneShadow() {
  const dpr = renderer.getPixelRatio();
  const sup = shadowQ().super || 1;   // render the silhouette larger → sharp when projected
  const w = Math.max(2, Math.round(lastW * dpr * sup)), h = Math.max(2, Math.round(lastH * dpr * sup));
  if (!gShadowRT) {
    gShadowRT = new THREE.WebGLRenderTarget(w, h);
    gShadowScene = new THREE.Scene();
    gShadowMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: gShadowRT.texture }, uOpacity: { value: 0.5 }, uTipFade: { value: 0.5 }, uBlur: { value: new THREE.Vector2() } },
      vertexShader: GSHADOW_VERT, fragmentShader: GSHADOW_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    gShadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), gShadowMat);
    // aLen: feet verts (2,3)=0, tip verts (0,1)=1 — drives the tip fade.
    gShadowQuad.geometry.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array([1, 1, 0, 0]), 1));
    gShadowQuad.frustumCulled = false;
    gShadowScene.add(gShadowQuad);
    gShadowW = w; gShadowH = h;
  } else if (w !== gShadowW || h !== gShadowH) {
    gShadowRT.setSize(w, h); gShadowW = w; gShadowH = h;
  }
}

// Map the silhouette texture (cropped to the character's screen bbox) onto the projected
// floor quad. corners = [feetL, feetR, tipL, tipR] in floor (u,v). Quad verts (PlaneGeometry
// 0=TL,1=TR,2=BL,3=BR) are assigned tipL,tipR,feetL,feetR; UVs sample the silhouette crop
// (head row at the tip, feet row at the feet).
// Low-level: set the shadow quad from 4 canvas-space corners (0..1 frac, y-down), ordered
// [feetL, feetR, tipL, tipR], and crop the silhouette texture to `bbox`. Used for the flat
// floor decal AND for the wall-climbing sub-quads (whose corners aren't on the floor plane).
function setShadowQuadCanvas(cv, bbox) {
  const aspect = lastW / lastH;
  const pos = gShadowQuad.geometry.attributes.position;
  const uv = gShadowQuad.geometry.attributes.uv;
  const map = [cv[2], cv[3], cv[0], cv[1]];   // tipL,tipR,feetL,feetR → verts 0,1,2,3
  for (let i = 0; i < 4; i++) pos.setXYZ(i, (map[i].x * 2 - 1) * aspect, 1 - map[i].y * 2, 0);
  const vHead = 1 - bbox.y0, vFeet = 1 - bbox.y1;   // RT v=0 bottom → screen-y maps to 1-y
  uv.setXY(0, bbox.x0, vHead); uv.setXY(1, bbox.x1, vHead);   // tip ↔ head
  uv.setXY(2, bbox.x0, vFeet); uv.setXY(3, bbox.x1, vFeet);   // feet
  pos.needsUpdate = true; uv.needsUpdate = true;
}
// Floor decal: corners in floor (u,v) → canvas, then set the quad. corners = [feetL,feetR,tipL,tipR].
function placeShadowDecal(f, corners, bbox) {
  const cv = corners.map(c => floorToCanvas(f, c.u, c.v, sceneShadowReg));
  setShadowQuadCanvas(cv, bbox);
}
// Where does segment P→Q cross segment A→B? Returns the parameter t along P→Q (0..1) and the
// crossing point, or null. Used to fold the shadow at a wall's base line.
function segCross(px, py, qx, qy, ax, ay, bx, by) {
  const rpx = qx - px, rpy = qy - py, sx = bx - ax, sy = by - ay;
  const d = rpx * sy - rpy * sx;
  if (Math.abs(d) < 1e-9) return null;
  const t = ((ax - px) * sy - (ay - py) * sx) / d;
  const u = ((ax - px) * rpy - (ay - py) * rpx) / d;
  if (t < 1e-3 || t > 1 - 1e-3 || u < -0.02 || u > 1.02) return null;
  return { t, x: px + t * rpx, y: py + t * rpy };
}
// Nearest wall (in the character's room) crossed by the shadow centerline F→T (floor u,v).
function nearestWallCross(F, T) {
  let best = null;
  for (const w of sceneShadowWalls) {
    if (!w.base || w.base.length !== 2) continue;
    const c = segCross(F.u, F.v, T.u, T.v, w.base[0].x, w.base[0].y, w.base[1].x, w.base[1].y);
    if (c && (!best || c.t < best.t)) best = { t: c.t, point: { u: c.x, v: c.y }, height: w.height ?? 0.45 };
  }
  return best;
}

// Character screen-space bounding box (0..1, y-down) by projecting its world AABB
// through the scene camera. Used to crop the silhouette texture to the character.
const _bb = new THREE.Box3(), _bv = new THREE.Vector3();
function characterScreenBBox() {
  _bb.setFromObject(modelRoot);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 8; i++) {
    _bv.set(i & 1 ? _bb.max.x : _bb.min.x, i & 2 ? _bb.max.y : _bb.min.y, i & 4 ? _bb.max.z : _bb.min.z);
    _bv.project(sceneCam);
    const sx = (_bv.x + 1) / 2, sy = (1 - _bv.y) / 2;
    if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
  }
  return { x0, y0, x1, y1 };
}

// A soft dark ellipse laid flat on the floor right under the feet — an always-present
// "contact" shadow so the character reads as grounded even if the cast silhouette
// shadow points away from the camera. Drawn under the cast shadows.
function ensureContact() {
  if (contactMesh) return;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.6)'); g.addColorStop(0.55, 'rgba(0,0,0,0.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  contactMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  contactMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), contactMat);
  contactMesh.frustumCulled = false;
  contactScene = new THREE.Scene(); contactScene.add(contactMesh);
}
function renderContactShadow(f, feetUV, halfWfloor, opacity) {
  ensureContact();
  const aspect = lastW / lastH;
  const cw = halfWfloor * 1.15, cd = halfWfloor * 0.7;   // ellipse: wider across, shallow in depth
  const cor = [
    floorToCanvas(f, feetUV.u - cw, feetUV.v - cd, sceneShadowReg), floorToCanvas(f, feetUV.u + cw, feetUV.v - cd, sceneShadowReg),
    floorToCanvas(f, feetUV.u - cw, feetUV.v + cd, sceneShadowReg), floorToCanvas(f, feetUV.u + cw, feetUV.v + cd, sceneShadowReg),
  ];
  const pos = contactMesh.geometry.attributes.position;
  for (let i = 0; i < 4; i++) pos.setXYZ(i, (cor[i].x * 2 - 1) * aspect, 1 - cor[i].y * 2, 0);
  pos.needsUpdate = true;
  contactMat.opacity = opacity;
  renderer.render(contactScene, sceneCam);
}

function renderSceneGroundShadow(clip) {
  const cfg = sceneShadowCfg;
  if (!cfg.enabled || !shadowEnabled || !modelRoot || !cfg.lights?.length) return;
  const f = sceneShadowFloor || activeScene.floor;   // active room's floor (multi-display)
  const sq = shadowQ();
  const feetUV = sceneFeetUV;
  const bbox = characterScreenBBox();
  const maxI = cfg.lights.reduce((m, L) => Math.max(m, L.intensity || 0), 0);

  // As the character lifts off the floor, shrink the shadow toward the feet and fade it,
  // so a jump reads as the character rising while the shadow stays a connected ground spot.
  const shrink = 1 / (1 + sceneLift * 1.8);
  const fade   = 1 / (1 + sceneLift * 1.4);

  const setClip = (on) => { if (clip) { renderer.setScissorTest(on); if (on) renderer.setScissor(clip.x, clip.y, clip.w, clip.h); } };

  // LOW: just a soft blob under the feet (cheap, no rendered silhouette).
  if (sq.mode === 'blob') {
    const halfWu = Math.min(0.18, Math.max(0.05, (bbox.x1 - bbox.x0) / (sceneShadowReg?.w || 1) / Math.max(0.05, widthAt(f, feetUV.v)) * 0.5)) * shrink;
    setClip(true);
    renderContactShadow(f, feetUV, halfWu, Math.min(0.5, (0.3 + maxI * 0.35) * sq.contactMul) * fade * sceneCharFade);
    setClip(false);
    return;
  }

  // MEDIUM/HIGH: the character's actual silhouette projected from the light. NO blob.
  ensureSceneShadow();
  const prevOverride = scene.overrideMaterial;
  scene.overrideMaterial = darkOverride || (darkOverride = new THREE.MeshBasicMaterial({ color: 0x000000 }));
  renderer.setRenderTarget(gShadowRT);   // off-screen silhouette — must NOT be scissor-clipped
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scene, sceneCam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = prevOverride;
  setClip(true);   // from here on we draw the decals to the screen — clip them to the room

  // Pad the silhouette crop (head + sides; feet stay tight) so the soft edge and the head
  // never hit a hard quad cut — this is what was clipping the shadow before.
  const padX = (bbox.x1 - bbox.x0) * 0.20, padY = (bbox.y1 - bbox.y0) * 0.16;
  const crop = { x0: Math.max(0, bbox.x0 - padX), x1: Math.min(1, bbox.x1 + padX),
                 y0: Math.max(0, bbox.y0 - padY), y1: bbox.y1 };
  const charH = bbox.y1 - bbox.y0;                                  // screen height → shadow length
  const halfWu = Math.min(0.28, Math.max(0.04, (crop.x1 - crop.x0) / (sceneShadowReg?.w || 1) / Math.max(0.05, widthAt(f, feetUV.v)) * 0.5)) * shrink;

  for (const L of cfg.lights) {
    // Shadow direction = away from the light's ground position (the light's floor u,v).
    let du = feetUV.u - (L.u ?? feetUV.u), dv = feetUV.v - (L.v ?? (feetUV.v - 0.25));
    let dl = Math.hypot(du, dv); if (dl < 1e-3) { du = 0; dv = -1; dl = 1; } du /= dl; dv /= dl;
    const a = (L.angleAdjust || 0) * Math.PI / 180;                // user fine-tune (rotate in floor space)
    if (a) { const c = Math.cos(a), s = Math.sin(a); const nu = du * c - dv * s; dv = du * s + dv * c; du = nu; }
    // Floor-projection length: taller character + lower light → longer shadow. Kept to a
    // natural length (capped well under a full screen so it never sprawls across the monitor).
    const k = Math.min(0.42, Math.max(0.12, charH * 0.6 / Math.max(0.3, L.height || 0.6))) * sq.lenMul * shrink;
    const T = { u: feetUV.u + du * k, v: feetUV.v + dv * k };       // head's shadow point on the floor
    gShadowMat.uniforms.uOpacity.value = Math.min(0.82, (0.45 + 0.5 * (L.intensity ?? 0.35)) * sq.opacity * fade * sceneCharFade);
    gShadowMat.uniforms.uTipFade.value = sq.tipFade;
    const blur = sq.blurBase + (L.softness || 0) * 0.03;           // 0 user-softness → crisp
    gShadowMat.uniforms.uBlur.value.set(blur, blur);

    // If the shadow runs into a wall, fold it: floor up to the wall base, then climb the wall.
    const hit = sceneShadowWalls.length ? nearestWallCross(feetUV, T) : null;
    if (hit && hit.t < 0.999) {
      const X = hit.point, t = Math.max(0.001, hit.t);
      const yFold = crop.y1 + (crop.y0 - crop.y1) * t;   // silhouette row at the fold (feet=y1 … head=y0)
      // Floor part: feet → wall base, lower silhouette.
      placeShadowDecal(f, [
        { u: feetUV.u - halfWu, v: feetUV.v }, { u: feetUV.u + halfWu, v: feetUV.v },
        { u: X.u - halfWu, v: X.v },           { u: X.u + halfWu, v: X.v },
      ], { x0: crop.x0, x1: crop.x1, y0: yFold, y1: crop.y1 });
      renderer.render(gShadowScene, sceneCam);
      // Wall part: climb straight up from the base crossing, upper silhouette.
      const baseL = floorToCanvas(f, X.u - halfWu, X.v, sceneShadowReg);
      const baseR = floorToCanvas(f, X.u + halfWu, X.v, sceneShadowReg);
      // Climb = the remaining (upper) silhouette standing up on the wall, in SCREEN height
      // (not the foreshortened floor length, which collapses near the back), capped at the
      // wall's on-screen top so the shadow never overshoots the wall.
      const riseAvail = hit.height * depthScaleAt(f, X.v) * 0.45;   // wall top rise (screen frac)
      const climb = Math.min(riseAvail, Math.max(riseAvail * 0.25, (1 - t) * charH * 1.6));
      setShadowQuadCanvas([
        baseL, baseR,
        { x: baseL.x, y: baseL.y - climb }, { x: baseR.x, y: baseR.y - climb },
      ], { x0: crop.x0, x1: crop.x1, y0: crop.y0, y1: yFold });
      renderer.render(gShadowScene, sceneCam);
    } else {
      placeShadowDecal(f, [
        { u: feetUV.u - halfWu, v: feetUV.v }, { u: feetUV.u + halfWu, v: feetUV.v },
        { u: T.u - halfWu, v: T.v },           { u: T.u + halfWu, v: T.v },
      ], crop);
      renderer.render(gShadowScene, sceneCam);
    }
  }
  setClip(false);
}

// ── Light glow (additive halo at each light's screen position) ──────────────────
let glowScene = null, glowMesh = null, glowMat = null;
function ensureGlow() {
  if (glowMesh) return;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  glowMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
  glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glowScene = new THREE.Scene(); glowScene.add(glowMesh);
}
function renderSceneGlows() {
  const cfg = sceneShadowCfg;
  if (!cfg.enabled || !cfg.lights?.length) return;
  ensureGlow();
  const f = activeScene.floor, aspect = lastW / lastH;
  for (const L of cfg.lights) {
    if (L.showGlow === false) continue;   // hidden source — still lights & casts shadow
    const base = floorToScreen(f, L.u, L.v);
    const depth = depthScaleAt(f, L.v);
    const sy01 = base.y - (L.height || 0) * depth * 0.5;   // orb raised above its floor base
    glowMesh.position.set((base.x * 2 - 1) * aspect, 1 - sy01 * 2, 0.5);
    const size = (0.28 + L.intensity * 0.5) * (0.6 + 0.6 * depth) * (L.mode === 'point' ? 1.7 : 1.0) * (L.distance || 1);
    glowMesh.scale.set(size * aspect, size, 1);
    glowMat.color.set(L.color || '#ffffff');
    glowMat.opacity = Math.min(1, 0.35 + L.intensity * 0.6);
    renderer.render(glowScene, sceneCam);
  }
}

function updateSceneCam() {
  const aspect = lastW / lastH;
  sceneCam.left = -aspect; sceneCam.right = aspect; sceneCam.top = 1; sceneCam.bottom = -1;
  sceneCam.updateProjectionMatrix();
  if (bgMesh) bgMesh.scale.set(aspect, 1, 1);
  layoutForegrounds();
}

// ── Foreground items ───────────────────────────────────────────────────────────
function clearForegrounds() {
  for (const s of fgSprites) {
    fgScene2.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.map?.dispose?.();
    s.mesh.material.dispose();
  }
  fgSprites = [];
}

async function buildForegrounds(scene) {
  clearForegrounds();
  // Build props for every room (single-room = just room 0). Each sprite remembers its
  // room's floor + canvas region so it lands on the correct screen.
  const rooms = (scene.displays > 1 && scene.rooms) ? scene.rooms : [{ foregrounds: scene.foregrounds, floor: scene.floor }];
  for (let ri = 0; ri < rooms.length; ri++) {
    const region = sceneRoomRegions[Math.min(ri, sceneRoomRegions.length - 1)] || { x: 0, y: 0, w: 1, h: 1 };
    for (const item of (rooms[ri].foregrounds || [])) {
      const tex = item.image ? await sceneImageTexture(item.image) : null;
      if (!tex) continue;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      mesh.renderOrder = 5;
      fgScene2.add(mesh);
      // Clickable if the prop is set up as an animation anchor — clicking sends the
      // character over to play that animation.
      fgSprites.push({ mesh, item, room: ri, floor: rooms[ri].floor, region, clickable: !!(item.anchor?.enabled && item.anchor.animation), rect: null });
    }
  }
  // Far → near so nearer props stack over farther ones (depthTest is off).
  fgSprites.sort((a, b) => a.item.v - b.item.v);
  layoutForegrounds();
}

// Load a scene image as an <img> (for canvas stitching).
async function loadSceneImageEl(filename) {
  try {
    if (!scenesDirCache) scenesDirCache = await window.deskbuddy.getScenesDir();
    const buf = await window.deskbuddy.readCharacterFile(scenesDirCache + '/' + filename);
    if (!buf) return null;
    const url = URL.createObjectURL(new Blob([buf]));
    const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
    URL.revokeObjectURL(url);
    return img;
  } catch { return null; }
}
// Stitch each room's image into one image the size of the spanned canvas, each drawn into
// its monitor's region. Set as a Span wallpaper → every screen shows its own room while the
// overlay stays transparent (icons/taskbar visible). Returns a PNG data URL.
async function buildStitchedWallpaper(scene, W, H) {
  const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);   // dead zones (no monitor) → black
  let any = false;
  for (let i = 0; i < scene.rooms.length; i++) {
    const room = scene.rooms[i]; if (!room.background) continue;
    const img = await loadSceneImageEl(room.background); if (!img) continue;
    const reg = sceneRoomRegions[Math.min(i, sceneRoomRegions.length - 1)] || { x: 0, y: 0, w: 1, h: 1 };
    ctx.drawImage(img, Math.round(reg.x * W), Math.round(reg.y * H), Math.round(reg.w * W), Math.round(reg.h * H));
    any = true;
  }
  return any ? cnv.toDataURL('image/png') : null;
}

// Place each foreground sprite on the floor at its (u,v), sized by perspective
// depth × its own scale, anchored at its base. Fullscreen items fill the window
// (legacy occlusion layer). Character vs item depth is resolved in renderScene.
function layoutForegrounds() {
  if (!fgSprites.length) return;
  const aspect = lastW / lastH;
  for (const s of fgSprites) {
    const { mesh, item } = s;
    const f = s.floor || activeScene?.floor; if (!f) continue;
    const reg = s.region || { x: 0, y: 0, w: 1, h: 1 };
    if (item.fullscreen) { mesh.scale.set(aspect * 2, 2, 1); mesh.position.set(0, 0, 0); s.rect = null; continue; }
    const sp = floorToCanvas(f, item.u, item.v, reg);
    const worldX = (sp.x * 2 - 1) * aspect;
    const worldYBase = (1 - sp.y * 2);
    const img = mesh.material.map?.image;
    const ar = (img && img.width && img.height) ? img.width / img.height : 1;
    const h = FG_BASE_HEIGHT * (item.scale || 1) * depthScaleAt(f, item.v) * reg.h;
    mesh.scale.set(h * ar, h, 1);
    mesh.position.set(worldX, worldYBase + h / 2, 0);
    // Stack order within a side: layer dominates, floor depth breaks ties.
    mesh.renderOrder = (item.layer || 0) * 100 + item.v + (s.room || 0) * 0.001;
    // Screen-space rect (0..1) for click hit-testing. worldX±halfW in x, base→top in y.
    const cx = (worldX / aspect + 1) / 2, halfW = (h * ar) / (4 * aspect);
    const yBot = (1 - worldYBase) / 2, yTop = yBot - h / 2;
    s.rect = { x0: cx - halfW, x1: cx + halfW, y0: yTop, y1: yBot };
  }
  sendPropHitboxes();
}

// Tell the main process where the clickable props are (screen fractions) so it can
// make the window interactive there while staying click-through everywhere else.
let _lastHitboxJSON = '';
function sendPropHitboxes() {
  if (!wallpaperMode || !window.deskbuddy.setPropHitboxes) return;
  // Each box carries a coarse opacity mask so the main-process cursor poll captures clicks
  // only over the prop's real pixels, not its transparent margins (mask is null until the
  // texture decodes — main falls back to the bounding box until then).
  const boxes = propClicks
    ? fgSprites.filter(s => s.clickable && s.rect).map(s => ({ x0: s.rect.x0, x1: s.rect.x1, y0: s.rect.y0, y1: s.rect.y1, mask: spriteMask(s) }))
    : [];
  const json = JSON.stringify(boxes);
  if (json === _lastHitboxJSON) return;   // only send when they actually change
  _lastHitboxJSON = json;
  window.deskbuddy.setPropHitboxes(boxes);
}

// A prop's PNG is usually mostly transparent (a small figure on a big canvas), so its
// bounding rect covers far more screen than the art does. Sample the texture's alpha so a
// "hit" means a real, visible pixel — otherwise clicks in the transparent margins would
// capture the whole screen. The alpha map is downscaled and cached per loaded texture.
function spriteAlpha(s) {
  const img = s.mesh?.material?.map?.image;
  if (!img || !img.width || !img.height || img.complete === false) return null;   // not decoded → rect fallback
  if (s._alpha !== undefined && s._alphaImg === img) return s._alpha;
  const MAX = 256, k = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  try {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    s._alpha = { data: g.getImageData(0, 0, w, h).data, w, h };
  } catch { s._alpha = null; }   // tainted/unreadable → fall back to the rect
  s._alphaImg = img;
  return s._alpha;
}
// Coarse opacity grid of a prop's texture, for the main-process cursor poll. Each cell is
// '1' if any pixel in it is visible. Cached per decoded texture. Null until it's ready.
function spriteMask(s) {
  const a = spriteAlpha(s); if (!a) return null;
  if (s._mask && s._maskFor === a) return s._mask;
  const GW = 64, GH = Math.max(8, Math.round(GW * a.h / a.w));
  let bits = '';
  for (let gy = 0; gy < GH; gy++) {
    const py0 = Math.floor(gy / GH * a.h), py1 = Math.max(py0 + 1, Math.floor((gy + 1) / GH * a.h));
    for (let gx = 0; gx < GW; gx++) {
      const px0 = Math.floor(gx / GW * a.w), px1 = Math.max(px0 + 1, Math.floor((gx + 1) / GW * a.w));
      let on = '0';
      outer: for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) {
        if (a.data[(py * a.w + px) * 4 + 3] > 24) { on = '1'; break outer; }
      }
      bits += on;
    }
  }
  s._maskFor = a; s._mask = { w: GW, h: GH, bits };
  return s._mask;
}
// Is (fx,fy) (window fractions) over a VISIBLE pixel of sprite s? Falls back to the full
// rect when the texture can't be sampled, so props still work in that case.
function spriteVisibleAt(s, fx, fy) {
  const r = s.rect; if (!r) return false;
  if (fx < r.x0 || fx > r.x1 || fy < r.y0 || fy > r.y1) return false;
  const a = spriteAlpha(s); if (!a) return true;
  const lu = (fx - r.x0) / Math.max(1e-6, r.x1 - r.x0);
  const lv = (fy - r.y0) / Math.max(1e-6, r.y1 - r.y0);
  const px = Math.min(a.w - 1, Math.max(0, Math.round(lu * (a.w - 1))));
  const py = Math.min(a.h - 1, Math.max(0, Math.round(lv * (a.h - 1))));
  return a.data[(py * a.w + px) * 4 + 3] > 24;
}
// Front-most clickable prop with a visible pixel under (fx,fy), or null.
function propHitAt(fx, fy) {
  if (!propClicks) return null;
  const hits = fgSprites.filter(s => s.clickable && spriteVisibleAt(s, fx, fy));
  if (!hits.length) return null;
  hits.sort((a, b) => b.item.v - a.item.v);   // nearer (larger v) first
  return hits[0];
}

// Did a click (window fractions) land on a clickable prop? Nearest (front-most) wins.
function triggerPropAt(fx, fy) {
  if (!behavior) return false;
  const hit = propHitAt(fx, fy);
  if (!hit) return false;
  const it = hit.item;
  const gu = (sceneDisplays > 1 ? (hit.room || 0) + it.u : it.u);   // global-u for multi-display
  behavior.goToAnchor({ u: gu, v: it.v, animation: it.anchor.animation, facing: it.anchor.facing || 'auto', offset: it.anchor.offset || { x: 0, y: 0 }, dwell: it.anchor.dwell || 0 });
  toast('▶ ' + (it.label || 'Prop'));
  return true;
}

async function sceneImageTexture(filename) {
  try {
    if (!scenesDirCache) scenesDirCache = await window.deskbuddy.getScenesDir();
    const buf = await window.deskbuddy.readCharacterFile(scenesDirCache + '/' + filename);
    if (!buf) return null;
    const url = URL.createObjectURL(new Blob([buf]));
    const tex = await new THREE.TextureLoader().loadAsync(url);
    URL.revokeObjectURL(url);
    tex.colorSpace = THREE.SRGBColorSpace; return tex;
  } catch { return null; }
}

// Per-character size override saved in the scene, keyed by character filename.
const charKey = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
let sceneUserScale = 1;
function sceneScaleFor(scene, charPath) {
  const v = scene?.charScales?.[charKey(charPath)];
  return (typeof v === 'number' && isFinite(v)) ? Math.min(4, Math.max(0.2, v)) : 1;
}

function measureModelForScene() {
  modelRoot.scale.setScalar(1);
  modelRoot.position.set(0, 0, 0);
  modelRoot.rotation.set(0, modelBaseRotY, 0);
  modelRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelRoot);
  sceneModel.height = Math.max(1e-3, box.max.y - box.min.y);
  sceneModel.minY = box.min.y;
  sceneBaseScale = SCENE_CHAR_HEIGHT / sceneModel.height * sceneUserScale;
}

async function loadScene(p) {
  try {
    const list = await window.deskbuddy.listScenes();
    const entry = list.find(s => s.path === p);
    if (!entry) { toast('Scene not found'); return; }
    activeScene = normalizeScenepack(entry.manifest);
    scenePath = p;
    // Auto-load the character bound to this scene so they come up together.
    if (activeScene.character) {
      const dir = await window.deskbuddy.getCharactersDir();
      const charPath = dir + '/' + activeScene.character;
      if (charPath !== activeCharPath) await loadCharacter(charPath);
    }
    if (!modelRoot || !mixer) { toast('Load a character first'); return; }
    if (overlayWalkSpeed > 0) { activeScene.wander = activeScene.wander || {}; activeScene.wander.walkSpeed = overlayWalkSpeed; }
    behavior = createBehavior(activeScene);
    behavior.setWander(sceneWander);   // apply the tray Random Walking toggle to this scene
    sceneShadowCfg = normalizeShadow(activeScene.shadow);
    applySceneCharacterLighting(sceneShadowCfg);

    ensureSceneLayers();

    // Spread transparent across the whole screen and hide the in-window background
    // plane — the REAL desktop wallpaper shows through, and the character walks the
    // floor over it. The scene's background image becomes that wallpaper.
    wallpaperMode = true;
    bgMesh.visible = false;
    sceneDisplays = Math.max(1, activeScene.displays || 1);
    const dims = await window.deskbuddy.enterWallpaperMode({ rooms: sceneDisplays });
    sceneRoomRegions = (dims?.rooms && dims.rooms.length) ? dims.rooms : [{ x: 0, y: 0, w: 1, h: 1 }];
    const W = Math.max(640, dims?.width || 1280), H = Math.max(480, dims?.height || 720);
    resizeCanvas(W, H);
    _propCapturing = false;   // main resets to forward click-through; keep renderer in sync
    window.deskbuddy.setSceneInteractive(propClicks);   // interactive if the user enabled prop-clicking
    if (clickToMove) window.deskbuddy.setSceneClickMove(true);   // re-assert click-to-move for this scene
    if (sceneDisplays > 1) {
      // Per-monitor wallpaper: set each screen's OWN room background (left→right), so the
      // screens are fully isolated — no Span (which mis-maps across differently-sized/placed
      // monitors and bleeds). Falls back to a stitched Span image if per-monitor isn't available.
      const bgs = (activeScene.rooms || []).map(r => r.background || null);
      let res = await window.deskbuddy.setPerMonitorWallpaper(bgs);
      if (!res?.ok) {
        const stitched = await buildStitchedWallpaper(activeScene, W, H);
        if (stitched) res = await window.deskbuddy.setSpannedWallpaper(stitched);
      }
      if (!res?.ok) toast('Could not set multi-screen wallpaper');
    } else if (activeScene.background) {
      const res = await window.deskbuddy.setSceneWallpaper(activeScene.background);
      if (!res?.ok) toast(res?.gnome === false ? 'Wallpaper auto-set is GNOME-only' : 'Could not set wallpaper');
    }

    sceneUserScale = sceneScaleFor(activeScene, activeCharPath);
    measureModelForScene();
    updateSceneCam();
    await buildForegrounds(activeScene);   // needs the final canvas size for layout
    sceneCurrentClip = null; sceneCurrentAction = null; mixer.stopAllAction();
    idleBreaking = false; idleBreakElapsed = 0; nextBreakDelay = randBreakDelay();
    persistSettings({ activeScene: scenePath });
    window.deskbuddy.sceneChanged(scenePath);   // let the tray show "Exit Scene"
    toast('Scene: ' + (activeScene.name || 'Untitled'));
  } catch (e) { console.error('[scene]', e); toast('Scene load failed'); }
}

function exitScene() {
  if (!activeScene) return;
  // Restore the desktop wallpaper and shrink the window back to a buddy.
  if (wallpaperMode) {
    window.deskbuddy.clearSceneWallpaper();
    window.deskbuddy.exitWallpaperMode();
  }
  wallpaperMode = false;
  clearForegrounds();
  resetCharacterLighting();
  if (window.deskbuddy.setPropHitboxes) window.deskbuddy.setPropHitboxes([]);   // no clickable props outside a scene
  _propCapturing = false;
  _sbb = null;   // drop smoothed shadow state so the next scene starts fresh
  activeScene = null; scenePath = null; behavior = null; sceneCurrentClip = null;
  persistSettings({ activeScene: null });
  window.deskbuddy.sceneChanged(null);
  if (activeCharPath) loadCharacter(activeCharPath);   // reload restores overlay-mode transform + window
  toast('Exited scene');
}

function placeCharacter(snap) {
  // Multi-display: snap.u is GLOBAL-u. Resolve which room (screen) the character is in,
  // its local-u, and that room's floor + canvas region.
  const room = resolveRoom(snap.u);
  const f = room.floor, reg = room.region;
  sceneShadowFloor = f; sceneShadowReg = reg;   // shadow uses the same room mapping
  sceneShadowWalls = ((sceneDisplays > 1 ? activeScene.rooms?.[room.roomIndex]?.walls : activeScene.walls) || []);
  const sp = floorToScreen(f, room.u, snap.v);  // 0..1 within the room image
  const cx = reg.x + sp.x * reg.w, cy = reg.y + sp.y * reg.h;   // → spanned-canvas fraction
  const aspect = lastW / lastH;
  // Scale by depth perspective AND the room's vertical share of the canvas (a shorter
  // monitor gets a proportionally smaller character so it fits its screen).
  const scl = sceneBaseScale * depthScaleAt(f, snap.v) * reg.h;
  const offX = (snap.offset?.x || 0) / (lastW / 2) * aspect;
  const offY = -(snap.offset?.y || 0) / (lastH / 2);
  const worldX = (cx * 2 - 1) * aspect + offX;
  const worldY = (1 - cy * 2) + offY;            // feet land here
  modelRoot.scale.setScalar(scl);
  modelRoot.rotation.set(modelBaseRotX, modelBaseRotY + snap.yaw, modelBaseRotZ);
  const baseY = worldY - sceneModel.minY * scl;   // grounded baseline
  modelRoot.position.set(worldX, baseY, 0);
  const adj = clipAdjustMap[sceneCurrentClip?.name] || {};
  const rmS = sceneCurrentClip && rootMotionMap[sceneCurrentClip.name];
  if (adj.pin && antiSinkBones.length) {
    // Pin to floor: ground the lowest contact (feet/hands/head) — floor moves (breakdance)
    // sit on the floor with no floating/bouncing.
    modelRoot.updateMatrixWorld(true);
    const lo = lowestSinkY();
    if (isFinite(lo)) modelRoot.position.y += (worldY - lo);
  } else if (feetGrounded && groundBones.length && clipNeedsGrounding(sceneCurrentClip?.name)) {
    // Pin the lowest foot to the floor line so animated feet plant instead of floating.
    modelRoot.updateMatrixWorld(true);
    const lo = lowestFootY();
    if (isFinite(lo)) modelRoot.position.y += (worldY - lo);
  } else if (rmS && sceneCurrentAction) {
    // Root motion: vertical hop lifts the feet off the floor (horizontal travel is committed
    // to the behavior position elsewhere). Feet-only anti-sink so an inverted flip can't shove
    // the whole body sky-high.
    const s = sampleRoot(rmS, sceneCurrentAction.time);
    modelRoot.position.y += s.dy * (sceneModel.height * scl) * ROOT_VFAC;
    if (groundBones.length) {
      modelRoot.updateMatrixWorld(true);
      const lo = lowestFootY();
      if (isFinite(lo) && lo < worldY) modelRoot.position.y += (worldY - lo);
    }
  }
  // Manual per-clip offset (fraction of character height).
  const _ch = sceneModel.height * scl;
  if (adj.ox || adj.oy || adj.oz) {
    modelRoot.position.x += (adj.ox || 0) * _ch;
    modelRoot.position.y += (adj.oy || 0) * _ch;
    modelRoot.position.z += (adj.oz || 0) * _ch;
  }
  // How far the character is lifted above its grounded baseline, as a fraction of its
  // world height — the shadow shrinks/fades by this so a jump reads as "up in the air".
  sceneLift = Math.max(0, (modelRoot.position.y - baseY) / Math.max(1e-3, sceneModel.height * scl));
  // Remember the feet contact point (NDC y = world y here) for the ground shadow,
  // plus the floor (u,v) so per-light shadows can be cast with the floor perspective.
  sceneFeetX = worldX; sceneFeetY = worldY;
  sceneFeetUV = { u: room.u, v: snap.v };   // LOCAL u within the room (shadow uses room floor+region)
}

const SCENE_FADE = 0.55;   // blend window (s) — long enough that every limb eases
function playSceneClip(want) {
  let clip;
  if (want === 'walk') clip = clipForState('walk');
  else if (want)       clip = resolveClip(want) || clipForState(want);   // raw clip name OR a state id
  else                 clip = clipForState('idle');
  if (!clip || clip === sceneCurrentClip) return;
  // crossFadeTo blends BOTH clips at once: while the old action fades out, the new
  // one fades in, so the mixer interpolates every bone from the old pose to the new
  // pose over SCENE_FADE — a smooth limb-by-limb transition, no snap.
  const next = mixer.clipAction(clip);
  next.enabled = true;
  next.setLoop(THREE.LoopRepeat, Infinity);
  next.setEffectiveTimeScale(clipAdjustMap[clip.name]?.speed ?? 1).setEffectiveWeight(1);
  next.reset().play();
  if (sceneCurrentAction && sceneCurrentAction.isRunning()) {
    sceneCurrentAction.crossFadeTo(next, SCENE_FADE, false);
  } else {
    next.fadeIn(SCENE_FADE);
  }
  sceneCurrentAction = next;
  sceneCurrentClip = clip;
}

// Idle breaks: while standing on the idle pose, occasionally play the "Idle Break"
// clip once (a stretch / look-around / gesture) then settle back to the pose — so
// the character feels alive instead of looping one motion. Held pose = the `idle`
// state; break = the `idleBreak` state (both crossfade smoothly).
let idleBreaking = false, idleBreakElapsed = 0, idleBreakUntil = 0, nextBreakDelay = randBreakDelay();
function randBreakDelay() { return 8 + Math.random() * 14; }   // 8–22s between breaks

function playBreakClip(clip) {
  const next = mixer.clipAction(clip);
  next.enabled = true;
  next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true;
  next.setEffectiveTimeScale(clipAdjustMap[clip.name]?.speed ?? 1).setEffectiveWeight(1);
  next.reset().play();
  if (sceneCurrentAction && sceneCurrentAction.isRunning()) sceneCurrentAction.crossFadeTo(next, SCENE_FADE, false);
  else next.fadeIn(SCENE_FADE);
  sceneCurrentAction = next; sceneCurrentClip = clip;
}

let _prevSceneMoving = false;
function updateIdleClip(dt, snap) {
  // Re-roll the random idle pose on every arrival (walk → idle) so it varies each time.
  if (_prevSceneMoving && !snap.moving) rollIdle();
  _prevSceneMoving = snap.moving;
  const breakName = manifest.animationStates?.idleBreak;
  const breakClip = breakName ? resolveClip(breakName) : null;
  if (idleBreaking) {
    if (!snap.moving && performance.now() < idleBreakUntil) return;   // let the break finish
    idleBreaking = false; idleBreakElapsed = 0; nextBreakDelay = randBreakDelay();   // then settle back
    rollIdle();   // …into a freshly-picked idle pose
  }
  const restingOnPose = !snap.moving && snap.clip == null;            // standing on the idle pose
  if (restingOnPose && breakClip) {
    idleBreakElapsed += dt;
    if (idleBreakElapsed >= nextBreakDelay) {
      idleBreaking = true;
      idleBreakUntil = performance.now() + breakClip.duration * 1000;
      playBreakClip(breakClip);
      return;
    }
  } else {
    idleBreakElapsed = 0;
  }
  playSceneClip(snap.clip);
}

// World position of a floor point — the SAME mapping placeCharacter uses (through the
// active room's canvas region for multi-display).
function floorWorldPt(f, u, v) {
  const sp = floorToCanvas(f, u, v, sceneShadowReg);
  const aspect = lastW / lastH;
  return { x: (sp.x * 2 - 1) * aspect, y: 1 - sp.y * 2 };
}
// World distance covered by a unit floor-uv step along (dirU,dirV) at (u,v). Perspective-
// correct: the back of the floor is compressed, so a step there covers less world distance.
function floorStepWorldLen(f, u, v, dirU, dirV) {
  const eps = 0.003;
  const a = floorWorldPt(f, u, v), b = floorWorldPt(f, u + dirU * eps, v + dirV * eps);
  return Math.hypot(b.x - a.x, b.y - a.y) / eps;
}

let _lastRoot = null, _lastRootTime = -1;
// Commit a Move-on root-motion clip's HORIZONTAL travel to the behavior position (while
// idle) so the character moves for real and the NEXT walk starts where it ended. The
// distance is the animation's ACTUAL displacement: the normalized hips delta × the hips'
// world height (which scales with character size and floor depth), converted to floor-uv
// through the floor's local scale — so it matches the real movement at any size, no fudge
// factor. Vertical (the hop) is applied visually in placeCharacter.
function commitSceneTravel(snap) {
  const name = sceneCurrentClip?.name;
  const rm = name && rootMotionMap[name];
  if (!rm || !sceneCurrentAction || snap.moving || !clipMoveMap[name]) { _lastRoot = null; _lastRootTime = -1; return; }
  const t = sceneCurrentAction.time;
  const s = sampleRoot(rm, t);
  if (_lastRoot && t >= _lastRootTime) {   // skip the frame where the loop wraps
    const ddz = s.dz - _lastRoot.dz, ddx = s.dx - _lastRoot.dx;   // normalized local delta (fwd, right)
    const f = activeScene.floor, u = snap.u, v = snap.v, yaw = snap.yaw;
    // Hips world height at this depth = ROOT_VFAC of the character's world height (which
    // already includes the size/userScale and the perspective depth scale).
    const hipsWorld = ROOT_VFAC * sceneModel.height * sceneBaseScale * depthScaleAt(f, v);
    const realFwd = ddz * hipsWorld, realRight = ddx * hipsWorld;   // real world distance moved
    const fwdU = Math.sin(yaw), fwdV = Math.cos(yaw);              // forward on the floor (facingYaw)
    const rightU = Math.cos(yaw), rightV = -Math.sin(yaw);        // right
    const fwdLen = floorStepWorldLen(f, u, v, fwdU, fwdV);
    const rightLen = floorStepWorldLen(f, u, v, rightU, rightV);
    const dFwd = fwdLen > 1e-6 ? realFwd / fwdLen : 0;            // floor-uv that yields realFwd in world
    const dRight = rightLen > 1e-6 ? realRight / rightLen : 0;
    behavior.translate(fwdU * dFwd + rightU * dRight, fwdV * dFwd + rightV * dRight);
  }
  _lastRoot = s; _lastRootTime = t;
}

function renderScene(dt) {
  // Scene loading sets activeScene before the behavior exists (there are awaits in between),
  // so a frame can land here early — skip it rather than crash the render loop.
  if (!behavior || !mixer) return;
  const snap = behavior.update(dt);
  updateIdleClip(dt, snap);
  commitSceneTravel(snap);                                   // Move-on clips travel for real
  snap.u = behavior.state.pos.u; snap.v = behavior.state.pos.v;   // render the committed position
  mixer.update(dt);
  if (vrm?.update) vrm.update(dt);
  placeCharacter(snap);
  sceneCharFade = snap.fade ?? 1;        // door-teleport vanish/reappear
  applyCharacterFade(sceneCharFade);
  updateSceneCam();
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(bgScene2, sceneCam);   // background
  renderSceneGroundShadow(sceneClipRect());   // projected silhouette shadow, scissor-clipped to the room

  // Layer sort: a prop's `layer` decides front/behind the character — <0 behind,
  // >0 in front, 0 = auto (by floor depth). Within a side, renderOrder (set from
  // layer + depth in layoutForegrounds) stacks them. Fullscreen items stay in front.
  if (fgSprites.length) {
    const charV = snap.v;
    const inFront = (item) => item.fullscreen || (item.layer ? item.layer > 0 : item.v > charV);
    let behind = false, front = false;
    for (const { mesh, item } of fgSprites) {
      const f = inFront(item);
      mesh.visible = !f; behind = behind || !f; front = front || f;
    }
    if (behind) renderer.render(fgScene2, sceneCam);
    renderer.render(scene, sceneCam);    // character
    if (front) {
      for (const { mesh, item } of fgSprites) mesh.visible = inFront(item);
      renderer.render(fgScene2, sceneCam);
      for (const { mesh } of fgSprites) mesh.visible = true;   // restore for next sort
    }
  } else {
    renderer.render(scene, sceneCam);    // character (lights + modelRoot)
  }
  renderSceneGlows();   // additive light halos on top
}

// Scissor rect (LOGICAL px, WebGL bottom-left origin) for the character's current screen
// region, or null for single-display. Keeps a room's content from bleeding into the next.
// NOTE: use the logical size (getSize), NOT the drawing-buffer size — three.js's setScissor
// multiplies these values by the renderer's pixelRatio internally. Passing physical pixels
// here would double-scale the rect (pixelRatio is >1 at medium/high), so the clip lands in
// the wrong place and the shadow still leaks across the seam.
function sceneClipRect() {
  if (sceneDisplays <= 1 || !sceneShadowReg) return null;
  const sz = new THREE.Vector2(); renderer.getSize(sz);
  const reg = sceneShadowReg;
  return {
    x: Math.round(reg.x * sz.x),
    y: Math.round((1 - reg.y - reg.h) * sz.y),
    w: Math.round(reg.w * sz.x),
    h: Math.round(reg.h * sz.y),
  };
}

let lastFrame = 0;

// ── Canvas sizing ─────────────────────────────────────────────────────────────
// `renderer.setSize` sizes the drawing buffer to w·pixelRatio (sharper at higher
// quality); CSS keeps the canvas at the window's logical size so it doesn't
// overflow. Track the last logical size so applyQuality can re-apply it.
let lastW = 300, lastH = 560;
function resizeCanvas(w, h) {
  lastW = w; lastH = h;
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function initCanvas() { resizeCanvas(window.innerWidth || 300, window.innerHeight || 560); }
initCanvas();
window.addEventListener('resize', initCanvas);

// ── Camera auto-fit + window resize ──────────────────────────────────────────
function fitCamera(model) {
  const box    = new THREE.Box3().setFromObject(model);
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // PAD adds margin around the character so the sheared cast shadow has room and
  // doesn't clip at the window edges. We pull the camera back AND grow the window
  // by the same factor, so the character keeps its apparent size but sits in a
  // padded, centered frame.
  const PAD    = 1.35;
  const fovRad = camera.fov * Math.PI / 180;
  const dist   = (Math.max(size.x, size.y, size.z) / 2 / Math.tan(fovRad / 2)) * 1.3 * PAD;
  // Sit a touch above eye level and look slightly down, so the ground plane (and
  // its shadow) reads as an ellipse under the feet instead of being edge-on.
  camera.position.set(center.x, center.y + size.y * 0.10, center.z + dist);
  camera.lookAt(center.x, center.y - size.y * 0.04, center.z);
  camera.near = dist * 0.01; camera.far = dist * 10;
  camera.updateProjectionMatrix();

  const ppm  = (window.innerHeight || 560) / (size.y * 1.3);
  const newW = Math.round(Math.max(220, Math.min(620, size.x * ppm * 1.5 * userScale * PAD)));
  const newH = Math.round(Math.max(320, Math.min(820, size.y * ppm * 1.2 * userScale * PAD)));
  window.deskbuddy.resizeOverlay(newW, newH).then(() => resizeCanvas(newW, newH));
}

// ── Load character ────────────────────────────────────────────────────────────
async function loadCharacter(filePath) {
  if (!filePath) return;
  activeCharPath = filePath;
  toast('Loading…');
  emptyEl.style.display = 'none';

  if (modelRoot) { scene.remove(modelRoot); try { VRMUtils.deepDispose(vrm?.scene ?? modelRoot); } catch {} modelRoot = null; vrm = null; }
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  clips = []; groundBones = []; groundLineY = null;

  try {
    const buf = await window.deskbuddy.readCharacterFile(filePath);
    if (!buf) throw new Error('Cannot read file');

    const url    = URL.createObjectURL(new Blob([buf]));
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p, { autoUpdateHumanBones: true }));
    const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
    URL.revokeObjectURL(url);

    const vrmData = gltf.userData.vrm;
    let baseRotY = 0;
    if (vrmData) {
      try { VRMUtils.removeUnnecessaryVertices(vrmData.scene); } catch {}
      try { VRMUtils.combineSkeletons(vrmData.scene); } catch {}
      vrm = vrmData; modelRoot = vrmData.scene; baseRotY = Math.PI;
      modelRoot.rotation.y = baseRotY;
    } else {
      modelRoot = gltf.scene;
      const box    = new THREE.Box3().setFromObject(modelRoot);
      const center = box.getCenter(new THREE.Vector3());
      const size   = box.getSize(new THREE.Vector3());
      modelRoot.position.sub(center); modelRoot.position.y += size.y / 2;
    }

    scene.add(modelRoot);
    clips = gltf.animations || [];
    mixer = new THREE.AnimationMixer(modelRoot);

    // Load manifest + restore saved FBX clips
    manifest = {};
    try {
      const mBuf = await window.deskbuddy.readCharacterFile(filePath + '.json');
      if (mBuf) manifest = JSON.parse(new TextDecoder().decode(mBuf));
    } catch {}
    userScale = manifest.scale ?? 1.0;
    rootMotionMap = (manifest.rootMotion && typeof manifest.rootMotion === 'object') ? manifest.rootMotion : {};
    clipMoveMap   = (manifest.clipMove   && typeof manifest.clipMove   === 'object') ? manifest.clipMove   : {};
    clipAdjustMap = (manifest.clipAdjust && typeof manifest.clipAdjust === 'object') ? manifest.clipAdjust : {};
    overlayWalkSpeed = (typeof manifest.walkSpeed === 'number') ? manifest.walkSpeed : 0;

    // Deserialize FBX clips saved in the manifest. They were already retargeted
    // to the VRM's normalized bones in Studio, so play them as-is.
    if (Array.isArray(manifest.importedClips)) {
      for (const json of manifest.importedClips) {
        try { clips.push(THREE.AnimationClip.parse(json)); } catch {}
      }
    }

    breathPhase = 0; swayPhase = 0; // reset procedural animation phases on new load
    // Apply the creator's rotation BEFORE fitting so the camera frames the rotated
    // model (degrees in the manifest, on top of the base facing). Fold it into the
    // base rotation so SCENE mode (placeCharacter) also honours it — otherwise a
    // character the creator turned to face front walks backwards in a scene.
    const rot = manifest.rotation || {};
    const d2r = Math.PI / 180;
    modelBaseRotX = (rot.x || 0) * d2r;
    modelBaseRotY = baseRotY + (rot.y || 0) * d2r;
    modelBaseRotZ = (rot.z || 0) * d2r;
    modelRoot.rotation.set(modelBaseRotX, modelBaseRotY, modelBaseRotZ);

    fitCamera(modelRoot);
    // Apply the creator's position offset AFTER fitting (the camera stays centred,
    // so the offset visibly shifts the character within the padded window).
    const off = manifest.offset || {};
    modelRoot.position.x += off.x || 0;
    modelRoot.position.y += off.y || 0;
    modelRoot.position.z += off.z || 0;
    collectGroundBones();
    groundModel();          // capture the ground line from the rest pose
    restPosY = modelRoot.position.y;   // breathing baseline (grounding doesn't move at rest)
    restPosX = modelRoot.position.x; restPosZ = modelRoot.position.z;
    modelWorldH = Math.max(0.1, new THREE.Box3().setFromObject(modelRoot).getSize(new THREE.Vector3()).y);   // for root-motion scaling
    enterState('idle');

    // Register this character's app-launch triggers with the main process.
    appState = null;
    const watched = [...new Set((manifest.customStates || []).map(c => c.app).filter(Boolean))];
    window.deskbuddy.watchApps(watched);
    emptyEl.style.display = 'none';
    toast(`${manifest.name || 'Character'} · ${clips.length} clip${clips.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('[overlay]', err);
    toast('Load failed: ' + err.message);
    emptyEl.style.display = 'flex';
  }
}

// ── State machine ─────────────────────────────────────────────────────────────
// Built-in states, driven automatically by the evaluator below:
//   active   — you're using the computer (recent keyboard/mouse input)
//   idle     — no input for a few seconds
//   watching — your cursor is hovering over the character
//   sleeping — idle past the per-character sleep threshold
//   clicked  — momentary reaction to a double-click (temporary, plays once)
//   loading  — on-demand only (triggered explicitly, e.g. by app launches)
// A state with no animation assigned in Studio falls back to the idle clip, so
// the character never freezes on an unassigned state.
function resolveClip(name) {
  if (name == null || name === '') return null;
  return clips.find(c => c.name === name) || clips[parseInt(name, 10)] || null;
}
// ── Multiple idle poses ─────────────────────────────────────────────────────────
// manifest.animationStates.idleList holds EXTRA idle clips (added via ＋ in Studio's
// States tab). One is picked at random each time the character (re)enters idle and
// STAYS picked until the next roll — clipForState must return a stable answer because
// the scene evaluator calls it every frame (a per-call random would crossfade forever).
let idleChoice = null, _lastIdleRoll = '';
function idlePool() {
  const map = manifest.animationStates || {};
  return [map.idle, ...(Array.isArray(map.idleList) ? map.idleList : [])].filter(Boolean);
}
function rollIdle() {
  const pool = idlePool();
  if (!pool.length) { idleChoice = null; return; }
  const cands = pool.length > 1 ? pool.filter(n => n !== _lastIdleRoll) : pool;
  idleChoice = cands[Math.floor(Math.random() * cands.length)];
  _lastIdleRoll = idleChoice;
}

function clipForState(state) {
  const map = manifest.animationStates || {};
  if (state === 'idle') {
    if (!idleChoice || !idlePool().includes(idleChoice)) rollIdle();   // stale/never rolled
    return resolveClip(idleChoice) || clips[0] || null;
  }
  // Custom states are stored in their own list, keyed by id; built-ins live in
  // animationStates. Either way, fall back to the idle clip, then the 1st clip.
  const custom = (manifest.customStates || []).find(c => c.id === state);
  const assigned = custom ? custom.clip : map[state];
  return resolveClip(assigned)
      || (state === 'idle' ? null : resolveClip(map.idle))
      || clips[0] || null;
}

let hovering = false;
let suppressAutoUntil = 0;   // pause the evaluator while a temporary state plays
let manualSit = false;       // user toggled "Sit" in the menu
let autoSit   = false;       // detected near the taskbar (best-effort)
let appState  = null;        // custom-state id triggered by a running app

function enterState(state, temporary = false, durationMs = 3000) {
  if (!mixer) return;
  if (state === currentState && !temporary) return;   // don't restart a looping state
  currentState = state;
  mixer.stopAllAction();
  if (state === 'idle') rollIdle();   // fresh random pick from the idle pool each re-entry
  const clip = clipForState(state);
  currentClipName = clip?.name || null;
  currentAction = null;
  if (clip) {
    const a = mixer.clipAction(clip);
    a.setLoop(temporary ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = temporary;
    a.timeScale = clipAdjustMap[clip.name]?.speed ?? 1;
    a.reset().play();
    currentAction = a;
  }
  if (temporary) suppressAutoUntil = performance.now() + durationMs;
}

// Resolve the state the character *should* be in, by priority:
// sit (manual/taskbar) → app-triggered custom state → hover/idle/sleep.
function desiredState(idle) {
  if (manualSit || autoSit) return 'sitting';
  if (appState) return appState;
  const sleepSecs = (manifest.stateSettings?.sleepAfterMinutes ?? 10) * 60;
  if (idle >= sleepSecs) return 'sleeping';
  if (hovering)          return 'watching';
  if (idle < 4)          return 'active';
  return 'idle';
}

// Cursor over the character → "watching". (mousemove fires continuously while
// the pointer is inside the window; document.mouseleave fires when it exits.)
document.addEventListener('mousemove', () => { hovering = true; });
document.addEventListener('mouseleave', () => { hovering = false; });

// Best-effort taskbar detection: sit when the window's bottom edge nears the
// work-area bottom (= taskbar top). getBounds is reliable on X11/Windows/macOS
// and a no-op on Wayland, where this simply never triggers.
let wasSitting = false;
async function maybeAutoSit() {
  if (manualSit) return;
  try {
    const [b, geo] = await Promise.all([
      window.deskbuddy.getOverlayBounds(), window.deskbuddy.getWorkArea(),
    ]);
    if (!b || !geo?.workArea) return;
    const winBottom   = b.y + b.height;
    const taskbarTop  = geo.workArea.y + geo.workArea.height;
    autoSit = winBottom >= taskbarTop - 28 && winBottom <= taskbarTop + b.height;
  } catch { autoSit = false; }
}

// Single 1s loop drives every automatic state transition.
setInterval(async () => {
  if (!modelRoot || !mixer || activeScene) return;   // scene mode drives its own states
  await maybeAutoSit();
  const sitting = manualSit || autoSit;
  if (sitting && !wasSitting) { try { await window.deskbuddy.dockBottom(); } catch {} }
  wasSitting = sitting;

  if (performance.now() < suppressAutoUntil) return;   // a temporary state is playing
  let idle = 999;
  try { idle = await window.deskbuddy.getIdleSeconds(); } catch {}
  enterState(desiredState(idle));
}, 1000);

// App-launch triggers: enter a custom state while its app is running.
window.deskbuddy.onAppsChanged((running) => {
  const cs = (manifest.customStates || []).find(c => c.app && running.includes(c.app));
  appState = cs ? cs.id : null;
});

// ── Move mode — grab-anywhere drag without the compositor menu ────────────────
// The character is a no-drag surface (clicks open our menu, not GNOME's). To move
// it, pick "Move / Reposition" from the menu: that shows #move-layer, a full-window
// drag region, so you can grab anywhere and drag. It auto-exits after a drag where
// the OS reports it (X11/Win/macOS via 'overlay-moved'); the Done button is the
// reliable exit everywhere (notably Wayland, which doesn't fire window moves).
const moveLayer  = document.getElementById('move-layer');
const moveBanner = document.getElementById('move-banner');
let moveMode = false, moveExitTimer = null;
function setMoveMode(on) {
  moveMode = on;
  moveLayer.classList.toggle('on', on);
  moveBanner.classList.toggle('on', on);
  if (on) toast('Move mode — drag the character, then Done');
}
document.getElementById('move-done').addEventListener('click', () => setMoveMode(false));
window.deskbuddy.onOverlayMoved(() => {
  if (!moveMode) return;
  clearTimeout(moveExitTimer);                 // debounce: exit shortly after the drag settles
  moveExitTimer = setTimeout(() => setMoveMode(false), 350);
});

// ── Shadow settings panel ─────────────────────────────────────────────────────
// Live sliders for the cast shadow (distance/angle/yaw/lean/length/size/opacity).
// Each slider writes shadowCfg → re-lays the quad → persists (debounced).
const shadowPanel = document.getElementById('shadow-panel');
const SHADOW_FIELDS = ['dist', 'angle', 'yaw', 'lean', 'squash', 'scale', 'opacity'];
const SHADOW_FMT = { angle: v => v + '°', yaw: v => v + '°' };
let _shadowSaveTimer = null;
function persistShadowCfg() {
  clearTimeout(_shadowSaveTimer);
  _shadowSaveTimer = setTimeout(() => persistSettings({ shadowCfg }), 250);
}
function syncShadowPanel() {
  for (const k of SHADOW_FIELDS) {
    const input = document.getElementById('s-' + k);
    const out   = document.getElementById('v-' + k);
    if (input) input.value = shadowCfg[k];
    if (out)   out.textContent = (SHADOW_FMT[k] || (v => v))(shadowCfg[k]);
  }
}
for (const k of SHADOW_FIELDS) {
  document.getElementById('s-' + k).addEventListener('input', (e) => {
    shadowCfg[k] = parseFloat(e.target.value);
    document.getElementById('v-' + k).textContent = (SHADOW_FMT[k] || (v => v))(shadowCfg[k]);
    applyShadowTransform();
    persistShadowCfg();
  });
}
document.getElementById('shadow-close').addEventListener('click', () => shadowPanel.classList.remove('on'));
document.getElementById('shadow-reset').addEventListener('click', () => {
  shadowCfg = { ...SHADOW_DEFAULTS };
  syncShadowPanel(); applyShadowTransform(); persistShadowCfg();
});
function openShadowPanel() {
  if (!shadowEnabled) { shadowEnabled = true; persistSettings({ shadow: true }); }
  syncShadowPanel();
  shadowPanel.classList.add('on');
}

// ── Settings menu ───────────────────────────────────────────────────────────
// Opened by clicking the character (no-drag, so it gets real clicks) or the
// #menu-btn. Right-click works too on X11/Windows/macOS.
const STATE_LABELS = {
  active: 'Active', idle: 'Idle', watching: 'Watching', sleeping: 'Sleeping',
  clicked: 'Reacting', sitting: 'Sitting', loading: 'Busy',
};

function openMenu() {
  const csLabel = (manifest.customStates || []).find(c => c.id === currentState)?.label;
  window.deskbuddy.showContextMenu({
    stateLabel: csLabel || STATE_LABELS[currentState] || currentState,
    quality, fps: targetFps,
    flags: { sit: manualSit, top: alwaysOnTop, through: passThrough, shadow: shadowEnabled, grounded: feetGrounded, lightMode, propClicks },
    custom: (manifest.customStates || []).map(c => ({ id: c.id, label: c.label || c.id })),
    scene: scenePath,
  });
}

document.getElementById('menu-btn').addEventListener('click', openMenu);
// In scene/wallpaper mode the overlay is click-through and the menu lives in the
// tray, so clicking the character does nothing here (gated on !wallpaperMode).
canvas.addEventListener('click',       (e) => {
  if (wallpaperMode) {   // in a scene: clicking a prop sends the character to play its animation
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    if (e.button === 0) {
      if (triggerPropAt(fx, fy)) return;                 // a clickable prop was hit
      if (clickToMove && behavior && activeScene?.floor) {  // empty floor → walk there
        // Find which room (screen) the click landed in, convert to that room's local floor.
        let ri = 0, reg = sceneRoomRegions[0];
        for (let i = 0; i < sceneRoomRegions.length; i++) {
          const r = sceneRoomRegions[i];
          if (fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h) { ri = i; reg = r; break; }
        }
        const room = (sceneDisplays > 1 && activeScene.rooms) ? (activeScene.rooms[ri] || activeScene.rooms[0]) : { floor: activeScene.floor };
        const p = screenToFloor(room.floor, (fx - reg.x) / reg.w, (fy - reg.y) / reg.h);
        behavior.goTo((sceneDisplays > 1 ? ri : 0) + p.u, p.v);
      }
    }
    return;
  }
  if (_dragMoved) { _dragMoved = false; return; }   // a drag, not a click → don't open the menu
  if (!moveMode && e.button === 0) openMenu();
});
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!moveMode && !wallpaperMode) openMenu(); });

// ── Native grab-and-drag (Windows/macOS) ─────────────────────────────────────
// On these platforms setPosition works, so the buddy can be dragged directly: press
// and move to reposition the window, a plain click still opens the menu. (Linux/Wayland
// can't setPosition, so it keeps the app-region "move mode" instead — guarded out here.)
let _dragMoved = false;
if (NATIVE_FORWARD) {
  let dragging = false, sx = 0, sy = 0, wx = 0, wy = 0;
  // Grab animation: while the buddy is actually being dragged, play the "Grabbed" state
  // (States tab in Studio) and pause the auto-evaluator so it can't stomp it. If no
  // Grabbed clip is assigned, the animation just stays as-is.
  let _grabbed = false;
  const grabStart = () => {
    if (_grabbed) return; _grabbed = true;
    suppressAutoUntil = Infinity;
    if (resolveClip((manifest.animationStates || {}).grabbed)) enterState('grabbed');
  };
  const grabEnd = () => {
    if (!_grabbed) return; _grabbed = false;
    suppressAutoUntil = performance.now() + 300;   // brief settle, then the evaluator resumes
    enterState('idle');                            // also re-rolls the random idle pose
  };
  canvas.addEventListener('mousedown', async (e) => {
    if (e.button !== 0 || wallpaperMode || moveMode) return;
    sx = e.screenX; sy = e.screenY; _dragMoved = false;
    try { const p = await window.deskbuddy.getWindowPos(); wx = p[0]; wy = p[1]; dragging = true; } catch {}
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - sx, dy = e.screenY - sy;
    if (!_dragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) { _dragMoved = true; canvas.style.cursor = 'grabbing'; grabStart(); }
    if (_dragMoved) window.deskbuddy.moveOverlayTo(wx + dx, wy + dy);
  });
  const endDrag = () => { if (dragging) { dragging = false; canvas.style.cursor = 'grab'; grabEnd(); } };
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
  // Grab affordance when idle over the buddy (scene mode overrides this for prop hovers).
  canvas.addEventListener('mouseenter', () => { if (!wallpaperMode) canvas.style.cursor = 'grab'; });
}
// Pointer cue + per-hover click capture. On Windows/macOS the window stays click-through
// with { forward:true }, so we RECEIVE moves even off a prop and drive interactivity
// ourselves: ask main to capture clicks while over a clickable prop, release otherwise.
// (On Linux a cursor helper in main does this instead — we only get moves once it has
// already made the window interactive, so the call below is a harmless no-op there.)
canvas.addEventListener('mousemove', (e) => {
  if (!wallpaperMode) return;
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const over = !!propHitAt(fx, fy);   // only a real, visible prop pixel counts (not its transparent margins)
  canvas.style.cursor = over ? 'pointer' : 'default';
  if (NATIVE_FORWARD && _propCapturing !== over) {
    _propCapturing = over;
    window.deskbuddy.setPropCapture(over);
  }
});
window.deskbuddy.onMenuCommand((action) => window.menu(action));

async function persistSettings(patch) {
  try { const s = await window.deskbuddy.getSettings(); Object.assign(s, patch); await window.deskbuddy.saveSettings(s); } catch {}
}

window.menu = async (action) => {
  if (action === 'open-menu')       { openMenu(); return; }   // requested from the tray
  if (action === 'move')            { setMoveMode(true); return; }
  if (action.startsWith('scene:'))  { const a = action.slice(6); a === 'exit' ? exitScene() : loadScene(a); return; }
  if (action === 'shadow-settings') { openShadowPanel(); return; }
  if (action === 'studio')   { window.deskbuddy.openStudio(); return; }
  if (action === 'market')   { window.deskbuddy.openMarketplace(); return; }
  if (action === 'poke')     { enterState('clicked', true, 2500); return; }
  if (action === 'sit')      {
    manualSit = !manualSit;
    if (manualSit) { autoSit = false; enterState('sitting'); window.deskbuddy.dockBottom().catch(() => {}); }
    toast(manualSit ? 'Sitting' : 'Standing');   // the 1s loop resumes auto-state when standing
    return;
  }
  if (action.startsWith('trigger:')) { enterState(action.slice(8), true, 4000); return; }
  if (action.startsWith('lightmode:')) { setLightMode(action.slice(10)); persistSettings({ lightMode }); toast('Light & Shadow: ' + lightMode); return; }
  if (action === 'propclicks') {
    propClicks = !propClicks; persistSettings({ propClicks });
    _propCapturing = false;
    window.deskbuddy.setSceneInteractive(propClicks);
    toast(propClicks ? 'Clickable props ON — scene is interactive (click props to play them)' : 'Clickable props OFF — desktop clicks pass through');
    return;
  }
  if (action === 'clickmove') {
    clickToMove = !clickToMove; persistSettings({ clickToMove });
    window.deskbuddy.setSceneClickMove(clickToMove);
    toast(clickToMove ? 'Click to Move ON — click the floor to send the character (desktop clicks are captured)' : 'Click to Move OFF');
    return;
  }
  if (action === 'wander') {
    sceneWander = !sceneWander; persistSettings({ sceneWander });
    behavior?.setWander(sceneWander);
    toast(sceneWander ? 'Random Walking ON — the character roams on its own'
                      : 'Random Walking OFF — the character stays put (Click to Move still works if enabled)');
    return;
  }
  if (action.startsWith('quality:')) { applyQuality(action.slice(8)); persistSettings({ quality }); toast('Quality: ' + quality); return; }
  if (action.startsWith('fps:'))     { applyFps(parseInt(action.slice(4), 10)); persistSettings({ fps: targetFps }); toast(targetFps + ' FPS'); return; }
  if (action === 'through')  { passThrough = !passThrough; window.deskbuddy.setIgnoreMouse(passThrough); toast(passThrough ? 'Click-through ON' : 'Click-through OFF'); return; }
  if (action === 'top')      { alwaysOnTop = !alwaysOnTop; window.deskbuddy.setAlwaysOnTop(alwaysOnTop); toast(alwaysOnTop ? 'Always-on-top ON' : 'OFF'); return; }
  if (action.startsWith('aot:')) { alwaysOnTop = action.slice(4) === '1'; toast(alwaysOnTop ? 'Pets & props above the taskbar' : 'Taskbar, icons & windows above pets'); return; }
  if (action === 'shadow')   {
    shadowEnabled = !shadowEnabled;
    persistSettings({ shadow: shadowEnabled });
    toast(shadowEnabled ? 'Shadow ON' : 'Shadow OFF');
    return;
  }
  if (action === 'bigger')     { userScale = Math.min(3.5, userScale * 1.2); if (modelRoot) fitCamera(modelRoot); return; }
  if (action === 'smaller')    { userScale = Math.max(0.2, userScale * 0.8); if (modelRoot) fitCamera(modelRoot); return; }
  if (action === 'reset-size') { userScale = manifest.scale ?? 1.0; if (modelRoot) fitCamera(modelRoot); toast('Size reset'); return; }
  if (action === 'grounded')   {
    feetGrounded = !feetGrounded;
    if (!feetGrounded && modelRoot) modelRoot.position.y = restPosY;   // release the pin
    persistSettings({ feetGrounded });
    toast(feetGrounded ? 'Feet on ground ON' : 'Feet on ground OFF');
    return;
  }
  if (action === 'screenshot') {
    const p = await window.deskbuddy.saveScreenshot();
    toast(p ? 'Saved: ' + p.split('/').pop() : 'Screenshot failed');
    return;
  }
};

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, ms = 2500) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ── Render loop — 30fps, pauses when hidden ───────────────────────────────────
function animate(ts) {
  requestAnimationFrame(animate);
  if (document.hidden) return;
  if (ts - lastFrame < TARGET_MS) return;
  lastFrame = ts;

  const dt = Math.min(clock.getDelta(), 0.1);

  if (activeScene && modelRoot && mixer) { renderScene(dt); return; }   // scene mode owns the frame

  if (mixer) mixer.update(dt);              // 1. mixer sets normalized bone rotations
  if (vrm?.update) vrm.update(dt);         // 2. VRM converts normalized → raw bone space

  if (modelRoot && clips.length === 0) {
    // Procedural breathing/sway when no real animation is playing
    breathPhase += dt;
    swayPhase   += dt * 0.28;
    // Use = not += to avoid position drift accumulating over time
    modelRoot.position.y = restPosY + Math.sin(breathPhase) * 0.003;
    modelRoot.rotation.z = Math.sin(swayPhase)   * 0.005;
  } else if (modelRoot) {
    // A clip is playing. Reset to the rest baseline so vertical handling + offset compose
    // cleanly (no accumulation).
    const adj = clipAdjustMap[currentClipName] || {};
    modelRoot.position.set(restPosX, restPosY, restPosZ);
    if (adj.pin && antiSinkBones.length && groundLineY !== null) {
      // Pin to floor: ground the lowest contact (floor moves — no floating/bouncing).
      modelRoot.updateMatrixWorld(true);
      const lo = lowestSinkY();
      if (isFinite(lo)) modelRoot.position.y += (groundLineY - lo);
    } else if (feetGrounded && clipNeedsGrounding(currentClipName) && groundBones.length && groundLineY !== null) {
      // Keep the feet on the ground (sit/crouch). Root-motion clips (jumps) skip this.
      modelRoot.updateMatrixWorld(true);
      const lo = lowestFootY();
      if (isFinite(lo)) modelRoot.position.y += (groundLineY - lo);
    } else if (rootMotionMap[currentClipName] && currentAction) {
      // Root-motion clip: lift the body by the hop. Feet-only anti-sink (push up only).
      const s = sampleRoot(rootMotionMap[currentClipName], currentAction.time);
      modelRoot.position.y += s.dy * modelWorldH * ROOT_VFAC;
      if (groundLineY !== null && groundBones.length) {
        modelRoot.updateMatrixWorld(true);
        const lo = lowestFootY();
        if (isFinite(lo) && lo < groundLineY) modelRoot.position.y += (groundLineY - lo);
      }
    }
    // Manual per-clip offset (fraction of character height).
    if (adj.ox || adj.oy || adj.oz) {
      modelRoot.position.x += (adj.ox || 0) * modelWorldH;
      modelRoot.position.y += (adj.oy || 0) * modelWorldH;
      modelRoot.position.z += (adj.oz || 0) * modelWorldH;
    }
  }

  // Composite: (1) bake the black silhouette offscreen, (2) clear the canvas,
  // (3) draw the sheared shadow quad, (4) draw the character over it.
  const showShadow = shadowEnabled && modelRoot;
  if (showShadow) renderShadowSilhouette();
  renderer.clear();                       // autoClear is off — clear once here
  if (showShadow) renderer.render(shadowScene2, shadowCam2);
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const s = await window.deskbuddy.getSettings();
  shadowEnabled = s.shadow !== false;   // default on
  if (s.shadowCfg) shadowCfg = { ...SHADOW_DEFAULTS, ...s.shadowCfg };
  applyShadowTransform();   // apply loaded cfg if the quad already exists (no-op otherwise)
  feetGrounded  = s.feetGrounded !== false;   // default on
  // Light & Shadow is low/medium/high; migrate legacy off→low, on→medium.
  lightMode = s.lightMode === 'high' ? 'high'
            : (s.lightMode === 'low' || s.lightMode === 'off') ? 'low'
            : 'medium';
  propClicks = !!s.propClicks;   // default OFF — enabling makes the scene capture clicks
  clickToMove = s.clickToMove === true;   // default OFF
  sceneWander = s.sceneWander !== false;  // default ON (Random Walking)
  applyQuality(s.quality || 'medium');
  applyFps(s.fps || 60);
  if (s.activeCharacter) { await loadCharacter(s.activeCharacter); if (s.activeScene) loadScene(s.activeScene); }
  else emptyEl.style.display = 'flex';
})();
window.deskbuddy.onCharacterChanged(loadCharacter);
