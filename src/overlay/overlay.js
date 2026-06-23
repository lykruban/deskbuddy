import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { floorToScreen, depthScaleAt, widthAt } from '../scene/floor.js';
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
// Light & Shadow quality: 'off' = normal lighting + basic shadow; 'on' = colour bounce
// (cheap GI) + soft shadow; 'high' = stronger bounce + heavily-softened "rendered" shadow.
let lightMode = 'on';
const giOn = () => lightMode === 'on' || lightMode === 'high';
let propClicks = true;   // can the user click props to trigger their animations?

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
  const boost = lightMode === 'high' ? 1.7 : lightMode === 'on' ? 1.45 : 1.15;
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
  lightMode = (m === 'off' || m === 'high') ? m : 'on';
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
let groundBones = [], groundLineY = null, feetGrounded = true, restPosY = 0;
const _wp = new THREE.Vector3();

function collectGroundBones() {
  groundBones = []; groundLineY = null;
  if (vrm?.humanoid?.getRawBoneNode) {
    ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].forEach(n => {
      const b = vrm.humanoid.getRawBoneNode(n); if (b) groundBones.push(b);
    });
  }
  if (!groundBones.length && modelRoot) {
    const byName = {};
    modelRoot.traverse(o => { if (o.isBone) byName[o.name] = o; });
    ['mixamorigLeftFoot', 'mixamorigRightFoot', 'mixamorigLeftToeBase', 'mixamorigRightToeBase']
      .forEach(n => { if (byName[n]) groundBones.push(byName[n]); });
  }
}

function lowestFootY() {
  let lo = Infinity;
  for (const b of groundBones) { b.getWorldPosition(_wp); if (_wp.y < lo) lo = _wp.y; }
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
// Scene ground shadow: the character's silhouette projected onto the floor at the
// feet, stretched along a light angle. Settings come from the scenepack (per-scene).
let gShadowRT = null, gShadowScene = null, gShadowQuad = null, gShadowMat = null, gShadowW = 0, gShadowH = 0;
let _sbb = null;   // smoothed silhouette bbox (de-jitters the cast shadow during animation)
let contactScene = null, contactMesh = null, contactMat = null;   // always-on grounding pool under the feet
let sceneShadowCfg = { enabled: true, lights: [{ angle: 90, intensity: 0.35, length: 0.55, softness: 0.4 }] };
let sceneFeetX = 0, sceneFeetY = -1, sceneFeetUV = { u: 0.5, v: 0.7 };
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
// Render the character flat-black to an offscreen target, then draw that texture
// on a quad that's obliquely projected onto the floor: each silhouette pixel at
// height `h` above the feet lands at feet + dir·h·length, so the shape flattens
// and stretches along the light angle. Edges are softened by a few offset taps.
// Single-pass 3×3 Gaussian on the silhouette's alpha. One draw per light gives
// exactly ONE soft shadow per light (no ghosting), and the blur radius — driven by
// `softness` — feathers the edge. 9 taps: cheap enough for every frame.
const GSHADOW_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// FILLED 5×5 Gaussian (25 taps over the whole disc, not discrete rings) so a hard-edged
// silhouette blurs SMOOTHLY into one soft shadow — no ghost copies. uBlur is the step
// between taps; uBlur = 0 → every tap hits the centre → a perfectly crisp single shadow.
const GSHADOW_FRAG = `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform vec2 uBlur;
  varying vec2 vUv;
  void main() {
    float a = 0.0, tot = 0.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        float w = exp(-float(x * x + y * y) * 0.4);
        a += texture2D(uMap, vUv + vec2(float(x), float(y)) * uBlur).a * w;
        tot += w;
      }
    }
    gl_FragColor = vec4(0.0, 0.0, 0.0, (a / tot) * uOpacity);
  }`;

function ensureSceneShadow() {
  const dpr = renderer.getPixelRatio();
  const w = Math.max(2, Math.round(lastW * dpr)), h = Math.max(2, Math.round(lastH * dpr));
  if (!gShadowRT) {
    gShadowRT = new THREE.WebGLRenderTarget(w, h);
    gShadowScene = new THREE.Scene();
    gShadowMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: gShadowRT.texture }, uOpacity: { value: 0.35 }, uBlur: { value: new THREE.Vector2() } },
      vertexShader: GSHADOW_VERT, fragmentShader: GSHADOW_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide,   // footprint winding flips as the character walks — never cull
    });
    // A flat quad LAID ON THE FLOOR (positions set per light from the floor quad).
    // vertex order for PlaneGeometry(1,1,1,1): 0=TL,1=TR,2=BL,3=BR.
    gShadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), gShadowMat);
    gShadowQuad.frustumCulled = false;
    gShadowScene.add(gShadowQuad);
    gShadowW = w; gShadowH = h;
  } else if (w !== gShadowW || h !== gShadowH) {
    gShadowRT.setSize(w, h); gShadowW = w; gShadowH = h;
  }
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
    floorToScreen(f, feetUV.u - cw, feetUV.v - cd), floorToScreen(f, feetUV.u + cw, feetUV.v - cd),
    floorToScreen(f, feetUV.u - cw, feetUV.v + cd), floorToScreen(f, feetUV.u + cw, feetUV.v + cd),
  ];
  const pos = contactMesh.geometry.attributes.position;
  for (let i = 0; i < 4; i++) pos.setXYZ(i, (cor[i].x * 2 - 1) * aspect, 1 - cor[i].y * 2, 0);
  pos.needsUpdate = true;
  contactMat.opacity = opacity;
  renderer.render(contactScene, sceneCam);
}

// Set the decal quad's 4 corners (sceneCam world space) + UVs (silhouette crop).
function placeShadowDecal(corners, bbox) {
  const pos = gShadowQuad.geometry.attributes.position;
  const uv = gShadowQuad.geometry.attributes.uv;
  // corners: [tipL, tipR, feetL, feetR] in 0..1 screen; map to verts 0,1,2,3
  const aspect = lastW / lastH;
  for (let i = 0; i < 4; i++) {
    const wx = (corners[i].x * 2 - 1) * aspect, wy = 1 - corners[i].y * 2;
    pos.setXYZ(i, wx, wy, 0);
  }
  // UVs: RT texture has v=0 at the bottom, so screen-y → v = 1 - y. head=y0(top), feet=y1(bottom).
  const uHead = 1 - bbox.y0, uFeet = 1 - bbox.y1;
  uv.setXY(0, bbox.x0, uHead); uv.setXY(1, bbox.x1, uHead);   // tip ↔ head
  uv.setXY(2, bbox.x0, uFeet); uv.setXY(3, bbox.x1, uFeet);   // feet
  pos.needsUpdate = true; uv.needsUpdate = true;
}

function renderSceneGroundShadow() {
  const cfg = sceneShadowCfg;
  if (!cfg.enabled || !shadowEnabled || !modelRoot || !cfg.lights?.length) return;
  ensureSceneShadow();
  // 1) silhouette → offscreen (rendered once; reused by every light)
  const prev = scene.overrideMaterial;
  scene.overrideMaterial = darkOverride || (darkOverride = new THREE.MeshBasicMaterial({ color: 0x000000 }));
  renderer.setRenderTarget(gShadowRT);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scene, sceneCam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = prev;
  // 2) one shadow per light, laid FLAT on the floor. The footprint is a quad on the
  // floor from the feet to a tip (away from the light, length from height/distance),
  // with the character's width; its corners are mapped to screen via the floor
  // homography, so the shadow foreshortens with the perspective and can't collapse
  // to a line as the character walks around.
  const f = activeScene.floor;
  // Smooth the silhouette box over time so an animated pose (e.g. a dance) doesn't make
  // the shadow jitter — the box drives the shadow's width and texture crop.
  const raw = characterScreenBBox();
  if (!_sbb) _sbb = { ...raw };
  else { const k = 0.18; _sbb.x0 += (raw.x0 - _sbb.x0) * k; _sbb.x1 += (raw.x1 - _sbb.x1) * k; _sbb.y0 += (raw.y0 - _sbb.y0) * k; _sbb.y1 += (raw.y1 - _sbb.y1) * k; }
  const bbox = _sbb;
  // Anchor the base at the STABLE foot contact (the floor placement), not the jittery
  // full-body box — the shadow stays planted at the feet while the character moves.
  const feetUV = sceneFeetUV;
  const halfWfloor = Math.max(0.03, (bbox.x1 - bbox.x0) / Math.max(0.05, widthAt(f, feetUV.v)) * 0.5);
  // Contact pool first (under the cast shadows) so the feet always look grounded.
  const maxI = cfg.lights.reduce((m, L) => Math.max(m, L.intensity || 0), 0);
  renderContactShadow(f, feetUV, halfWfloor, Math.min(0.5, 0.3 + maxI * 0.4));
  for (const L of cfg.lights) {
    let du = feetUV.u - L.u, dv = feetUV.v - L.v;               // away from the light (floor space)
    const dl = Math.hypot(du, dv) || 1e-3; du /= dl; dv /= dl;
    const a = (L.angleAdjust || 0) * Math.PI / 180;             // user fine-tune (rotate in floor space)
    if (a) { const c = Math.cos(a), s = Math.sin(a); const nu = du * c - dv * s; dv = du * s + dv * c; du = nu; }
    const lenF = Math.min(1.6, (L.distance || 1) * 0.45 / Math.max(0.12, L.height || 0.5));   // lower light → longer
    const pu = -dv, pv = du;                                    // perpendicular (footprint width axis)
    const tu = feetUV.u + du * lenF, tv = feetUV.v + dv * lenF; // tip on the floor
    const corners = [
      floorToScreen(f, tu + pu * halfWfloor, tv + pv * halfWfloor),     // tipL
      floorToScreen(f, tu - pu * halfWfloor, tv - pv * halfWfloor),     // tipR
      floorToScreen(f, feetUV.u + pu * halfWfloor, feetUV.v + pv * halfWfloor), // feetL
      floorToScreen(f, feetUV.u - pu * halfWfloor, feetUV.v - pv * halfWfloor), // feetR
    ];
    placeShadowDecal(corners, bbox);
    gShadowMat.uniforms.uOpacity.value = L.intensity;
    // Blur scales with softness ONLY (0 softness → 0 blur → crisp single shadow). High
    // mode widens it further. 5×5 filled kernel means this stays a smooth soft shadow.
    const qMul = lightMode === 'high' ? 2.2 : lightMode === 'on' ? 1.4 : 1.0;
    const b = L.softness * 0.025 * qMul;   // UV step (full-screen silhouette space); 0 = crisp
    gShadowMat.uniforms.uBlur.value.set(b, b);
    renderer.render(gShadowScene, sceneCam);
  }
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
  for (const item of (scene.foregrounds || [])) {
    const tex = item.image ? await sceneImageTexture(item.image) : null;
    if (!tex) continue;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 5;
    fgScene2.add(mesh);
    // Clickable if the prop is set up as an animation anchor — clicking sends the
    // character over to play that animation.
    fgSprites.push({ mesh, item, clickable: !!(item.anchor?.enabled && item.anchor.animation), rect: null });
  }
  // Far → near so nearer props stack over farther ones (depthTest is off).
  fgSprites.sort((a, b) => a.item.v - b.item.v);
  layoutForegrounds();
}

// Place each foreground sprite on the floor at its (u,v), sized by perspective
// depth × its own scale, anchored at its base. Fullscreen items fill the window
// (legacy occlusion layer). Character vs item depth is resolved in renderScene.
function layoutForegrounds() {
  const f = activeScene?.floor; if (!f || !fgSprites.length) return;
  const aspect = lastW / lastH;
  for (const s of fgSprites) {
    const { mesh, item } = s;
    if (item.fullscreen) { mesh.scale.set(aspect * 2, 2, 1); mesh.position.set(0, 0, 0); s.rect = null; continue; }
    const sp = floorToScreen(f, item.u, item.v);
    const worldX = (sp.x * 2 - 1) * aspect;
    const worldYBase = (1 - sp.y * 2);
    const img = mesh.material.map?.image;
    const ar = (img && img.width && img.height) ? img.width / img.height : 1;
    const h = FG_BASE_HEIGHT * (item.scale || 1) * depthScaleAt(f, item.v);
    mesh.scale.set(h * ar, h, 1);
    mesh.position.set(worldX, worldYBase + h / 2, 0);
    // Stack order within a side: layer dominates, floor depth breaks ties.
    mesh.renderOrder = (item.layer || 0) * 100 + item.v;
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
  const boxes = propClicks ? fgSprites.filter(s => s.clickable && s.rect).map(s => s.rect) : [];
  const json = JSON.stringify(boxes);
  if (json === _lastHitboxJSON) return;   // only send when they actually change
  _lastHitboxJSON = json;
  window.deskbuddy.setPropHitboxes(boxes);
}

// Did a click (window fractions) land on a clickable prop? Nearest (front-most) wins.
function triggerPropAt(fx, fy) {
  if (!behavior) return false;
  const hits = fgSprites.filter(s => s.clickable && s.rect && fx >= s.rect.x0 && fx <= s.rect.x1 && fy >= s.rect.y0 && fy <= s.rect.y1);
  if (!hits.length) return false;
  hits.sort((a, b) => b.item.v - a.item.v);   // nearer (larger v) first
  const it = hits[0].item;
  behavior.goToAnchor({ u: it.u, v: it.v, animation: it.anchor.animation, facing: it.anchor.facing || 'auto', offset: it.anchor.offset || { x: 0, y: 0 }, dwell: it.anchor.dwell || 0 });
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
    behavior = createBehavior(activeScene);
    sceneShadowCfg = normalizeShadow(activeScene.shadow);
    applySceneCharacterLighting(sceneShadowCfg);

    ensureSceneLayers();

    // Spread transparent across the whole screen and hide the in-window background
    // plane — the REAL desktop wallpaper shows through, and the character walks the
    // floor over it. The scene's background image becomes that wallpaper.
    wallpaperMode = true;
    bgMesh.visible = false;
    const dims = await window.deskbuddy.enterWallpaperMode();
    const W = Math.max(640, dims?.width || 1280), H = Math.max(480, dims?.height || 720);
    resizeCanvas(W, H);
    window.deskbuddy.setSceneInteractive(propClicks);   // interactive if the user enabled prop-clicking
    if (activeScene.background) {
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
  _sbb = null;   // drop smoothed shadow state so the next scene starts fresh
  activeScene = null; scenePath = null; behavior = null; sceneCurrentClip = null;
  persistSettings({ activeScene: null });
  window.deskbuddy.sceneChanged(null);
  if (activeCharPath) loadCharacter(activeCharPath);   // reload restores overlay-mode transform + window
  toast('Exited scene');
}

function placeCharacter(snap) {
  const f = activeScene.floor;
  const sp = floorToScreen(f, snap.u, snap.v);     // 0..1, top-left origin
  const aspect = lastW / lastH;
  const scl = sceneBaseScale * depthScaleAt(f, snap.v);
  const offX = (snap.offset?.x || 0) / (lastW / 2) * aspect;
  const offY = -(snap.offset?.y || 0) / (lastH / 2);
  const worldX = (sp.x * 2 - 1) * aspect + offX;
  const worldY = (1 - sp.y * 2) + offY;            // feet land here
  modelRoot.scale.setScalar(scl);
  modelRoot.rotation.set(modelBaseRotX, modelBaseRotY + snap.yaw, modelBaseRotZ);
  modelRoot.position.set(worldX, worldY - sceneModel.minY * scl, 0);
  // Pin the lowest foot BONE to the floor line (worldY) each frame, so animated
  // feet plant on the ground instead of sinking/floating off the rest pose. Reuses
  // the same groundBones the desktop overlay uses; honours the "Feet on Ground" toggle.
  if (feetGrounded && groundBones.length) {
    modelRoot.updateMatrixWorld(true);
    const lo = lowestFootY();
    if (isFinite(lo)) modelRoot.position.y += (worldY - lo);
  }
  // Remember the feet contact point (NDC y = world y here) for the ground shadow,
  // plus the floor (u,v) so per-light shadows can be cast with the floor perspective.
  sceneFeetX = worldX; sceneFeetY = worldY;
  sceneFeetUV = { u: snap.u, v: snap.v };
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
  next.setEffectiveTimeScale(1).setEffectiveWeight(1);
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
  next.setEffectiveTimeScale(1).setEffectiveWeight(1);
  next.reset().play();
  if (sceneCurrentAction && sceneCurrentAction.isRunning()) sceneCurrentAction.crossFadeTo(next, SCENE_FADE, false);
  else next.fadeIn(SCENE_FADE);
  sceneCurrentAction = next; sceneCurrentClip = clip;
}

function updateIdleClip(dt, snap) {
  const breakName = manifest.animationStates?.idleBreak;
  const breakClip = breakName ? resolveClip(breakName) : null;
  if (idleBreaking) {
    if (!snap.moving && performance.now() < idleBreakUntil) return;   // let the break finish
    idleBreaking = false; idleBreakElapsed = 0; nextBreakDelay = randBreakDelay();   // then settle back
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

function renderScene(dt) {
  const snap = behavior.update(dt);
  updateIdleClip(dt, snap);
  mixer.update(dt);
  if (vrm?.update) vrm.update(dt);
  placeCharacter(snap);
  updateSceneCam();
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(bgScene2, sceneCam);   // background
  renderSceneGroundShadow();             // projected silhouette shadow on the floor

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
function clipForState(state) {
  const map = manifest.animationStates || {};
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
  const clip = clipForState(state);
  if (clip) {
    const a = mixer.clipAction(clip);
    a.setLoop(temporary ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = temporary;
    a.reset().play();
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
    if (e.button === 0) triggerPropAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    return;
  }
  if (!moveMode && e.button === 0) openMenu();
});
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!moveMode && !wallpaperMode) openMenu(); });
// Pointer cue when hovering a clickable prop (we only get moves while main has made
// the window interactive over a prop).
canvas.addEventListener('mousemove', (e) => {
  if (!wallpaperMode) return;
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const over = fgSprites.some(s => s.clickable && s.rect && fx >= s.rect.x0 && fx <= s.rect.x1 && fy >= s.rect.y0 && fy <= s.rect.y1);
  canvas.style.cursor = over ? 'pointer' : 'default';
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
    window.deskbuddy.setSceneInteractive(propClicks);
    toast(propClicks ? 'Clickable props ON — scene is interactive (click props to play them)' : 'Clickable props OFF — desktop clicks pass through');
    return;
  }
  if (action.startsWith('quality:')) { applyQuality(action.slice(8)); persistSettings({ quality }); toast('Quality: ' + quality); return; }
  if (action.startsWith('fps:'))     { applyFps(parseInt(action.slice(4), 10)); persistSettings({ fps: targetFps }); toast(targetFps + ' FPS'); return; }
  if (action === 'through')  { passThrough = !passThrough; window.deskbuddy.setIgnoreMouse(passThrough); toast(passThrough ? 'Click-through ON' : 'Click-through OFF'); return; }
  if (action === 'top')      { alwaysOnTop = !alwaysOnTop; window.deskbuddy.setAlwaysOnTop(alwaysOnTop); toast(alwaysOnTop ? 'Always-on-top ON' : 'OFF'); return; }
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
  } else if (feetGrounded) {
    // An animation is playing → keep the feet on the ground (sit/jump/crouch).
    groundModel();
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
  lightMode = ['off', 'on', 'high'].includes(s.lightMode) ? s.lightMode : 'on';   // default 'on'
  propClicks = !!s.propClicks;   // default OFF — enabling makes the scene capture clicks
  applyQuality(s.quality || 'medium');
  applyFps(s.fps || 60);
  if (s.activeCharacter) { await loadCharacter(s.activeCharacter); if (s.activeScene) loadScene(s.activeScene); }
  else emptyEl.style.display = 'flex';
})();
window.deskbuddy.onCharacterChanged(loadCharacter);
