/* ============================================================================
   DeskBuddy hero — a live VRM buddy who lives in the dual-monitor rig.
   He idles, breathes, blinks, watches your cursor, hops when poked, and
   every so often walks through the bezel gap to the other monitor.
   Three.js + @pixiv/three-vrm off the CDN import map in index.html.
   ============================================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const CFG = window.DESKBUDDY_CONFIG;
const rig = document.getElementById('rig');
const canvas = document.getElementById('buddy-canvas');
const statusEl = rig.querySelector('.hero-status .status-text');

const CAM_FOV = 27;
const CAM_DIST = 4.6;
const VISIBLE_H = 2.2;       // world metres of vertical view
const FLOOR_FRAC = 0.13;     // feet sit this fraction up from the canvas bottom

let renderer, scene, camera, clock, lookTarget, shadowBlob;
let vrm = null;              // current VRM (null for plain GLB avatars)
let charRoot = null;         // group we move around
let bones = null;            // cached normalized humanoid bones
let avatarIdx = 0;
let running = true;
let walkBound = 1.6;

// behaviour state
const st = {
  mode: 'idle',              // 'idle' | 'walk'
  x: 0, targetX: 0, dir: 1,
  yaw: 0, yawTarget: 0,
  phase: 0,
  hopT: -1,
  nextWanderAt: performance.now() + 6000,
  nextBlinkAt: performance.now() + 2500,
  blinkT: -1,
  lastSide: -1,              // which monitor he last visited (-1 left, 1 right)
  crossedGap: false,
  mx: 0, my: 0,              // cursor, NDC-ish
};

function fail(reason) {
  console.warn('[hero] falling back to static hero:', reason);
  rig.classList.remove('loading');
  rig.classList.add('fallback');
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

/* ------------------------------------------------------------ scene setup */
function initScene() {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CAM_FOV, 2, 0.1, 30);
  const cy = VISIBLE_H / 2 - VISIBLE_H * FLOOR_FRAC; // world y at canvas centre
  camera.position.set(0, cy, CAM_DIST);
  camera.lookAt(0, cy, 0);

  const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.95);
  key.position.set(1.2, 2.2, 2.5);
  scene.add(key);
  const fill = new THREE.AmbientLight(0xa8b4ff, Math.PI * 0.32);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x36d6c4, Math.PI * 0.25);
  rim.position.set(-1.5, 1.5, -2);
  scene.add(rim);

  // soft blob shadow under the feet
  const shTex = makeShadowTexture();
  shadowBlob = new THREE.Mesh(
    new THREE.CircleGeometry(0.42, 32),
    new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.55 })
  );
  shadowBlob.rotation.x = -Math.PI / 2;
  shadowBlob.position.y = 0.001;
  scene.add(shadowBlob);

  // the buddy looks at this; it rides on the camera and follows the cursor
  lookTarget = new THREE.Object3D();
  camera.add(lookTarget);
  lookTarget.position.set(0, 0, -4);
  scene.add(camera);

  clock = new THREE.Clock();
}

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(10,8,30,0.85)');
  grad.addColorStop(0.6, 'rgba(20,10,60,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* --------------------------------------------------------- sizing / bounds */
function fit() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const halfW = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_DIST * camera.aspect;
  walkBound = Math.max(0.6, halfW - 0.55);
}

const singleScreen = () => window.matchMedia('(max-width: 820px)').matches;

/* ------------------------------------------------------------- avatar load */
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

async function loadAvatar(url, name) {
  rig.classList.add('loading');
  rig.classList.remove('fallback');
  setStatus(`Waking up ${name || 'a buddy'}…`);

  let gltf;
  try {
    gltf = await loader.loadAsync(url, (ev) => {
      if (ev.total) setStatus(`Waking up ${name || 'a buddy'}… ${Math.round(ev.loaded / ev.total * 100)}%`);
    });
  } catch (err) {
    rig.classList.remove('loading');
    throw err;
  }

  // clear out the previous buddy
  if (charRoot) {
    scene.remove(charRoot);
    VRMUtils.deepDispose(charRoot);
    charRoot = null; vrm = null; bones = null;
  }

  charRoot = new THREE.Group();
  const newVrm = gltf.userData.vrm;

  if (newVrm) {
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(newVrm); // VRM0.x face the wrong way; normalize toward +Z
    newVrm.scene.traverse((o) => { o.frustumCulled = false; });
    charRoot.add(newVrm.scene);
    vrm = newVrm;
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;
    bones = cacheBones(vrm);
  } else {
    // plain GLB: auto-scale to buddy height and stand it on the floor
    const obj = gltf.scene;
    const box = new THREE.Box3().setFromObject(obj);
    const h = Math.max(0.01, box.max.y - box.min.y);
    obj.scale.setScalar(1.5 / h);
    box.setFromObject(obj);
    obj.position.y -= box.min.y;
    obj.position.x -= (box.min.x + box.max.x) / 2;
    charRoot.add(obj);
  }

  charRoot.position.x = st.x;
  charRoot.rotation.y = st.yaw;
  scene.add(charRoot);
  rig.classList.remove('loading');
}

function cacheBones(v) {
  const g = (n) => v.humanoid ? v.humanoid.getNormalizedBoneNode(n) : null;
  return {
    hips: g('hips'), spine: g('spine'), chest: g('chest'), neck: g('neck'), head: g('head'),
    lUpArm: g('leftUpperArm'), rUpArm: g('rightUpperArm'),
    lLoArm: g('leftLowerArm'), rLoArm: g('rightLowerArm'),
    lUpLeg: g('leftUpperLeg'), rUpLeg: g('rightUpperLeg'),
    lLoLeg: g('leftLowerLeg'), rLoLeg: g('rightLowerLeg'),
  };
}

async function loadWithFallback(startIdx) {
  const list = CFG.AVATARS;
  for (let i = 0; i < list.length; i++) {
    const idx = (startIdx + i) % list.length;
    try {
      await loadAvatar(list[idx].url, list[idx].name);
      avatarIdx = idx;
      return;
    } catch (err) {
      console.warn('[hero] avatar failed:', list[idx].name, err);
    }
  }
  fail('all avatars failed to load');
}

/* --------------------------------------------------------------- behaviour */
function startWalk(now) {
  const single = singleScreen();
  let side = single ? (Math.random() < 0.5 ? -1 : 1) : -st.lastSide;
  const min = single ? 0.15 : walkBound * 0.3;
  const max = walkBound * 0.85;
  st.targetX = side * (min + Math.random() * (max - min));
  st.lastSide = side;
  st.dir = st.targetX > st.x ? 1 : -1;
  st.mode = 'walk';
  st.crossedGap = false;
  st.yawTarget = st.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
}

function pulseDoors() {
  rig.querySelectorAll('.door').forEach((d) => {
    d.classList.add('active');
    setTimeout(() => d.classList.remove('active'), 1100);
  });
}

function hop() {
  if (st.hopT < 0) st.hopT = 0;
}

function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function tick() {
  requestAnimationFrame(tick);
  if (!running || document.hidden || !charRoot) return;

  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  const t = clock.elapsedTime;

  // --- locomotion ---
  if (st.mode === 'walk') {
    const speed = 0.62;
    st.x += st.dir * speed * dt;
    st.phase += dt * 7.2;
    // crossing the bezel gap → doors flash
    if (!st.crossedGap && !singleScreen() &&
        ((st.dir > 0 && st.x >= 0) || (st.dir < 0 && st.x <= 0))) {
      st.crossedGap = true;
      pulseDoors();
    }
    if ((st.dir > 0 && st.x >= st.targetX) || (st.dir < 0 && st.x <= st.targetX)) {
      st.x = st.targetX;
      st.mode = 'idle';
      st.yawTarget = 0;
      st.nextWanderAt = now + 7000 + Math.random() * 8000;
    }
  } else if (now > st.nextWanderAt) {
    startWalk(now);
  }
  st.x = THREE.MathUtils.clamp(st.x, -walkBound, walkBound);
  st.yaw = angleLerp(st.yaw, st.yawTarget, Math.min(1, dt * 6));

  // --- hop ---
  let hopY = 0;
  if (st.hopT >= 0) {
    st.hopT += dt * 2.6;
    if (st.hopT >= 1) st.hopT = -1;
    else hopY = Math.sin(st.hopT * Math.PI) * 0.16;
  }

  charRoot.position.x = st.x;
  charRoot.rotation.y = st.yaw;

  // --- skeleton animation (VRM only) ---
  if (vrm && bones) {
    const B = bones;
    if (st.mode === 'walk') {
      const s = Math.sin(st.phase);
      if (B.lUpLeg) B.lUpLeg.rotation.x = s * 0.55;
      if (B.rUpLeg) B.rUpLeg.rotation.x = -s * 0.55;
      if (B.lLoLeg) B.lLoLeg.rotation.x = Math.max(0, -s) * -0.9;
      if (B.rLoLeg) B.rLoLeg.rotation.x = Math.max(0, s) * -0.9;
      if (B.lUpArm) { B.lUpArm.rotation.set(-s * 0.35, 0, 1.15); }
      if (B.rUpArm) { B.rUpArm.rotation.set(s * 0.35, 0, -1.15); }
      if (B.lLoArm) B.lLoArm.rotation.set(0, 0, 0.12);
      if (B.rLoArm) B.rLoArm.rotation.set(0, 0, -0.12);
      if (B.spine) B.spine.rotation.set(0.05, 0, 0);
      if (B.neck) B.neck.rotation.set(0, 0, 0);
      charRoot.position.y = Math.abs(Math.cos(st.phase)) * 0.04 + hopY;
    } else {
      // idle: breathe, sway, subtly face the cursor
      const breathe = Math.sin(t * 1.5) * 0.024;
      if (B.spine) B.spine.rotation.set(breathe, 0, Math.sin(t * 0.7) * 0.015);
      if (B.lUpLeg) B.lUpLeg.rotation.set(0, 0, 0.02);
      if (B.rUpLeg) B.rUpLeg.rotation.set(0, 0, -0.02);
      if (B.lLoLeg) B.lLoLeg.rotation.set(0, 0, 0);
      if (B.rLoLeg) B.rLoLeg.rotation.set(0, 0, 0);
      if (B.lUpArm) B.lUpArm.rotation.set(0, 0, 1.18 - Math.sin(t * 1.1) * 0.03);
      if (B.rUpArm) B.rUpArm.rotation.set(0, 0, -1.18 + Math.sin(t * 1.1 + 1) * 0.03);
      if (B.lLoArm) B.lLoArm.rotation.set(0, 0, 0.1);
      if (B.rLoArm) B.rLoArm.rotation.set(0, 0, -0.1);
      if (B.neck) B.neck.rotation.set(st.my * -0.12, st.mx * 0.3, 0);
      charRoot.position.y = hopY;
    }

    // blink + a happy face mid-hop
    const em = vrm.expressionManager;
    if (em) {
      if (st.blinkT < 0 && now > st.nextBlinkAt) {
        st.blinkT = 0;
        st.nextBlinkAt = now + 1800 + Math.random() * 4200;
      }
      if (st.blinkT >= 0) {
        st.blinkT += dt / 0.13;
        const v = st.blinkT >= 1 ? 0 : Math.sin(Math.min(st.blinkT, 1) * Math.PI);
        em.setValue('blink', v);
        if (st.blinkT >= 1) st.blinkT = -1;
      }
      em.setValue('happy', st.hopT >= 0 ? Math.sin(st.hopT * Math.PI) : 0);
    }

    vrm.update(dt);
  } else if (charRoot) {
    // plain GLB: bob + tilt so it still feels alive
    charRoot.position.y = Math.sin(t * 1.6) * 0.02 + hopY +
      (st.mode === 'walk' ? Math.abs(Math.cos(st.phase)) * 0.05 : 0);
    charRoot.rotation.z = Math.sin(t * 0.8) * 0.02;
  }

  // cursor gaze
  lookTarget.position.set(st.mx * 2.2, st.my * 1.2, -4);

  // shadow follows + shrinks on hop
  shadowBlob.position.x = st.x;
  const sh = 1 - hopY * 2.4;
  shadowBlob.scale.set(sh, sh, sh);
  shadowBlob.material.opacity = 0.55 * sh;

  renderer.render(scene, camera);
}

/* -------------------------------------------------------------------- ui */
function wireUI() {
  // cursor tracking (relative to the rig)
  window.addEventListener('pointermove', (e) => {
    const r = rig.getBoundingClientRect();
    st.mx = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1.4, 1.4);
    st.my = THREE.MathUtils.clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1.4, 1.4);
  }, { passive: true });

  // poke → hop + paw print
  canvas.addEventListener('pointerdown', (e) => {
    hop();
    const r = rig.getBoundingClientRect();
    const paw = document.createElement('span');
    paw.className = 'pawprint';
    paw.textContent = '🐾';
    paw.style.left = (e.clientX - r.left - 10) + 'px';
    paw.style.top = (e.clientY - r.top - 10) + 'px';
    rig.appendChild(paw);
    setTimeout(() => paw.remove(), 1100);
  });

  // cycle avatars
  const swapBtn = document.getElementById('btn-swap-buddy');
  if (swapBtn) swapBtn.addEventListener('click', () => {
    loadWithFallback(avatarIdx + 1);
  });

  // bring your own
  const fileInput = document.getElementById('vrm-file');
  const loadBtn = document.getElementById('btn-load-vrm');
  if (loadBtn && fileInput) {
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      try {
        await loadAvatar(url, f.name.replace(/\.(vrm|glb)$/i, ''));
      } catch (err) {
        console.warn('[hero] custom avatar failed', err);
        setStatus('That one refused to wake up — try another file?');
        rig.classList.add('loading');
        setTimeout(() => rig.classList.remove('loading'), 2600);
      } finally {
        URL.revokeObjectURL(url);
        fileInput.value = '';
      }
    });
  }

  // pause when the rig is off-screen
  const io = new IntersectionObserver((entries) => {
    running = entries[0].isIntersecting;
    if (running) clock.getDelta(); // swallow the pause so he doesn't teleport
  }, { threshold: 0.05 });
  io.observe(rig);

  new ResizeObserver(fit).observe(canvas);
}

/* ------------------------------------------------------------------- boot */
(async function boot() {
  if (!window.WebGLRenderingContext) return fail('no WebGL');
  try {
    initScene();
  } catch (err) {
    return fail(err);
  }
  fit();
  // spawn on the left monitor, not hidden behind the bezel gap at x=0
  st.x = st.targetX = -Math.min(1.1, walkBound * 0.6);
  wireUI();
  tick();
  try {
    await loadWithFallback(0);
  } catch (err) {
    fail(err);
  }
})();
