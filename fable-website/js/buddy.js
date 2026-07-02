// ═══════════════════════════════════════════════════════════════════════════
//  The live buddy — a real VRM character that lives ON the page.
//  · walks the hero floor, then docks bottom-right and follows you down the page
//  · cycles showcase characters every few seconds; "load your own .vrm" takes over
//  · sarcastic speech bubbles per section (DOM, projected from the 3D head)
//  Hard-won correctness notes (from a previous broken attempt):
//  · VRMUtils.rotateVRM0() is the OFFICIAL way to orient VRM0 models to face the
//    camera-at-+Z convention — never guess facing.
//  · Auto-frame by bounding box (scale to a target height, feet on a known ground
//    line) so ANY model lands in frame regardless of its authored size.
//  · The canvas sits ABOVE page content (z-index, pointer-events:none) so opaque
//    sections can never hide the character.
//  · Everything is wrapped so a failure degrades to a clean page, never a broken one.
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const CFG = window.DB_CONFIG || {};
const MODELS = CFG.MODELS || [];
const QUIPS = CFG.QUIPS || {};
const SWITCH_MS = (CFG.SWITCH_SECONDS || 4.5) * 1000;

const canvas = document.getElementById('buddy-stage');
const shadowEl = document.getElementById('buddy-shadow');
const bubbleEl = document.getElementById('buddy-bubble');
const nameTxt = document.getElementById('buddy-name-txt');
const hud = document.getElementById('buddy-hud');

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer, scene, camera, clock, current = null, dead = false;
// Declared up here (not next to their functions): the boot block below runs during module
// evaluation and calls startRoster()/swapTo() — `let` any lower and it's a TDZ crash.
let switching = false;
let rosterIdx = 0, rosterTimer = null, failures = 0;

// Debug breadcrumbs — inspect window.__buddy in devtools to see exactly where things stand.
const DBG = (window.__buddy = { stage: 'module-start', errors: [] });
addEventListener('error', (e) => DBG.errors.push(String(e.message || e)));
addEventListener('unhandledrejection', (e) => DBG.errors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));

function die(e) {
  console.warn('buddy disabled:', e);
  dead = true;
  canvas?.remove(); shadowEl?.remove(); bubbleEl?.remove(); hud?.remove();
}
function onResize() {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
function toggleBuddy() {
  const off = document.body.classList.toggle('buddy-off');
  document.getElementById('buddy-toggle').textContent = off ? '🐾 bring back' : '🙈 hide';
}

// ── loading + normalization ──────────────────────────────────────────────────
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const TARGET_H = 1.55;   // world height every character is normalized to

function loadVRM(url, label) {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      try {
        const vrm = gltf.userData.vrm;
        if (!vrm) return reject(new Error('no vrm in file'));
        try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
        try { VRMUtils.combineSkeletons ? VRMUtils.combineSkeletons(gltf.scene) : VRMUtils.removeUnnecessaryJoints(gltf.scene); } catch {}
        VRMUtils.rotateVRM0(vrm);                      // official facing fix (no-op for VRM1)
        vrm.scene.traverse(o => { o.frustumCulled = false; });
        // Auto-frame: normalize to TARGET_H, feet at local y=0 via a wrapper group.
        const bbox = new THREE.Box3().setFromObject(vrm.scene);
        const h = Math.max(0.1, bbox.max.y - bbox.min.y);
        const s = TARGET_H / h;
        const root = new THREE.Group();
        vrm.scene.scale.setScalar(s);
        vrm.scene.position.y = -bbox.min.y * s;        // feet on the group's origin
        root.add(vrm.scene);
        // lower arms from T-pose so it reads natural
        setBone(vrm, 'leftUpperArm', b => b.rotation.z = 1.15);
        setBone(vrm, 'rightUpperArm', b => b.rotation.z = -1.15);
        resolve({ vrm, root, name: label });
      } catch (e) { reject(e); }
    }, undefined, reject);
  });
}
function setBone(vrm, name, fn) { const b = vrm.humanoid?.getNormalizedBoneNode(name); if (b) fn(b); }

async function swapTo(url, label) {
  if (switching || dead) return;
  switching = true;
  DBG.stage = 'loading:' + label;
  if (nameTxt) nameTxt.textContent = 'loading ' + label + '…';
  try {
    const next = await loadVRM(url, label);
    if (current) { scene.remove(current.root); try { VRMUtils.deepDispose(current.vrm.scene); } catch {} }
    current = next;
    current.pop = 0;                                  // scale-in "poof"
    scene.add(current.root);
    if (nameTxt) nameTxt.textContent = label;
    DBG.stage = 'live:' + label;
  } catch (e) {
    console.warn('load failed:', label, e);
    DBG.errors.push('load ' + label + ': ' + (e && e.message || e));
    if (nameTxt) nameTxt.textContent = label + ' didn\'t make it 😢';
  }
  switching = false;
}

async function startRoster() {
  if (!MODELS.length) return die(new Error('no models configured'));
  await swapTo(MODELS[0].url, MODELS[0].name);
  if (!current) { if (++failures >= MODELS.length) return die(new Error('all models failed')); }
  rosterTimer = setInterval(() => {
    rosterIdx = (rosterIdx + 1) % MODELS.length;
    swapTo(MODELS[rosterIdx].url, MODELS[rosterIdx].name);
  }, SWITCH_MS);
}
function onPickFile(e) {
  const f = e.target.files?.[0]; if (!f) return;
  if (rosterTimer) { clearInterval(rosterTimer); rosterTimer = null; }   // your character takes over
  const url = URL.createObjectURL(f);
  swapTo(url, f.name.replace(/\.vrm$/i, '')).then(() => setTimeout(() => URL.revokeObjectURL(url), 5000));
  say('oh?? a new me. i love them.');
}

// ── placement: hero stroll → corner dock, driven by scroll ──────────────────
// World x half-width visible on the ground plane (z=0).
function groundHalfW() {
  const h = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * camera.position.z;
  return (h * camera.aspect) / 2;
}
// Where the ground line sits in world-y so feet land ~N px from the viewport bottom.
function groundYForPixelBottom(pxFromBottom) {
  const hWorld = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * camera.position.z;
  const yNdc = (pxFromBottom / innerHeight) * 2 - 1;    // -1 = bottom
  return camera.position.y + yNdc * (hWorld / 2);
}

const S = { x: 0, y: 0, scale: 1, yaw: 0, walkPhase: 0, stroll: { dir: 1, t: 0 } };

function tick() {
  if (dead) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // scroll progress over the hero (0 = top, 1 = fully past)
  const prog = Math.min(1, Math.max(0, scrollY / (innerHeight * 0.9)));

  // hero: stroll between ±38% of the visible ground; docked: park at 78% right, small
  const halfW = groundHalfW();
  let targetX, targetScale, walking;
  if (prog < 0.55) {
    S.stroll.t += dt;
    const range = halfW * 0.38;
    const stroll = Math.sin(S.stroll.t * 0.34) * range;      // slow, smooth pace
    targetX = stroll;
    targetScale = 1.0;
    walking = !reduced;
    S.stroll.vel = Math.cos(S.stroll.t * 0.34);              // for facing
  } else {
    targetX = halfW * 0.78;
    targetScale = 0.52;
    walking = false;
  }
  const groundHero = groundYForPixelBottom(118);             // hero floor line
  const groundDock = groundYForPixelBottom(84);              // docked: near the very bottom
  const targetY = THREE.MathUtils.lerp(groundHero, groundDock, Math.min(1, prog * 1.4));

  // smooth everything
  const k = Math.min(1, dt * 5);
  S.x += (targetX - S.x) * k;
  S.y += (targetY - S.y) * k;
  S.scale += (targetScale - S.scale) * k;

  // facing: walk direction in the hero, face the visitor when docked
  const facing = prog < 0.55
    ? (S.stroll.vel >= 0 ? Math.PI / 2 - 0.9 : -Math.PI / 2 + 0.9)   // angled toward camera while walking
    : -0.35;                                                          // docked: face slightly inward
  S.yaw += (facing - S.yaw) * Math.min(1, dt * 4);

  if (current) {
    const { vrm, root } = current;
    // pop-in
    current.pop = Math.min(1, (current.pop ?? 1) + dt * 2.6);
    const pop = 1 - Math.pow(1 - current.pop, 3);
    root.position.set(S.x, S.y, 0);
    root.scale.setScalar(S.scale * pop);
    root.rotation.y = S.yaw;

    // procedural life: walk cycle or idle breathe
    if (walking) {
      S.walkPhase += dt * 6.4;
      const sw = Math.sin(S.walkPhase), cw = Math.cos(S.walkPhase);
      setBone(vrm, 'leftUpperLeg', b => b.rotation.x = sw * 0.5);
      setBone(vrm, 'rightUpperLeg', b => b.rotation.x = -sw * 0.5);
      setBone(vrm, 'leftLowerLeg', b => b.rotation.x = Math.max(0, -sw) * 0.75);
      setBone(vrm, 'rightLowerLeg', b => b.rotation.x = Math.max(0, sw) * 0.75);
      setBone(vrm, 'leftUpperArm', b => b.rotation.x = -sw * 0.35);
      setBone(vrm, 'rightUpperArm', b => b.rotation.x = sw * 0.35);
      setBone(vrm, 'hips', b => b.position.y = Math.abs(cw) * 0.035);
      setBone(vrm, 'spine', b => b.rotation.x = 0.04 + Math.abs(sw) * 0.04);
    } else {
      setBone(vrm, 'leftUpperLeg', b => b.rotation.x *= 0.9);
      setBone(vrm, 'rightUpperLeg', b => b.rotation.x *= 0.9);
      setBone(vrm, 'leftLowerLeg', b => b.rotation.x *= 0.9);
      setBone(vrm, 'rightLowerLeg', b => b.rotation.x *= 0.9);
      setBone(vrm, 'spine', b => b.rotation.x = Math.sin(t * 1.4) * 0.025);
      setBone(vrm, 'hips', b => b.position.y = Math.sin(t * 1.4) * 0.012);
    }
    setBone(vrm, 'head', b => b.rotation.y = Math.sin(t * 0.6) * 0.16);
    setBone(vrm, 'neck', b => b.rotation.x = Math.sin(t * 0.9) * 0.03);
    vrm.update(dt);

    positionDomAnchors();
  }
  renderer.render(scene, camera);
}

// project 3D points → CSS pixels for the shadow + speech bubble
const _v = new THREE.Vector3();
function toScreen(x, y, z) {
  _v.set(x, y, z).project(camera);
  return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight };
}
function positionDomAnchors() {
  const feet = toScreen(S.x, S.y, 0);
  const head = toScreen(S.x, S.y + TARGET_H * S.scale, 0);
  if (shadowEl) {
    const w = 150 * S.scale;
    shadowEl.style.width = w + 'px';
    shadowEl.style.height = w * 0.22 + 'px';
    shadowEl.style.left = (feet.x - w / 2) + 'px';
    shadowEl.style.top = (feet.y - w * 0.1) + 'px';
    shadowEl.style.opacity = current ? 0.8 : 0;
  }
  if (bubbleEl && bubbleEl.classList.contains('show')) {
    bubbleEl.style.left = Math.min(innerWidth - 260, Math.max(12, head.x + 26)) + 'px';
    bubbleEl.style.top = Math.max(70, head.y - 54) + 'px';
  }
}

// ── speech bubbles (sections quip as you scroll past) ────────────────────────
let bubbleTimer = null, lastQuip = '';
export function say(text) {
  if (dead || !bubbleEl || !text || text === lastQuip) return;
  lastQuip = text;
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubbleEl.classList.remove('show'); lastQuip = ''; }, 3200);
}
// observe sections with data-quip
const qio = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) {
    const key = e.target.getAttribute('data-quip');
    if (QUIPS[key]) say(QUIPS[key]);
  }
}, { threshold: 0.45 });
document.querySelectorAll('[data-quip]').forEach(el => qio.observe(el));

// ── boot (fail soft) ─────────────────────────────────────────────────────────
// Deliberately LAST in the module: it runs during evaluation and calls the functions
// above, so every module-level const/let must already be initialized (TDZ bit us twice).
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 1.05, 5.4);
  camera.lookAt(0, 0.95, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(1.4, 2.6, 2.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7c5cff, 0.9); rim.position.set(-2.2, 1.4, -1.6); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xaebbff, 0x22242e, 0.55));
  clock = new THREE.Clock();
  onResize(); addEventListener('resize', onResize);
  document.getElementById('vrm-file')?.addEventListener('change', onPickFile);
  document.getElementById('buddy-toggle')?.addEventListener('click', toggleBuddy);
  DBG.stage = 'starting-roster';
  startRoster();
  renderer.setAnimationLoop(tick);
} catch (e) { die(e); }
