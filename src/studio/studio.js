import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader }     from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader }     from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader }     from 'three/examples/jsm/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader }     from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader }     from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { BVHLoader }     from 'three/examples/jsm/loaders/BVHLoader.js';
import { GLTFExporter }  from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { floorToScreen, screenToFloor, depthScaleAt } from '../scene/floor.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ── Mixamo → VRM humanoid bone name map ──────────────────────────────────────
// Covers both "mixamorig:Bone" (colon form) and "mixamorigBone" (no-colon form)
// after the normalization step strips the colon.
const MIXAMO_TO_VRM = {
  'mixamorigHips':              'hips',
  'mixamorigSpine':             'spine',
  'mixamorigSpine1':            'chest',
  'mixamorigSpine2':            'upperChest',
  'mixamorigNeck':              'neck',
  'mixamorigHead':              'head',
  'mixamorigLeftShoulder':      'leftShoulder',
  'mixamorigLeftArm':           'leftUpperArm',
  'mixamorigLeftForeArm':       'leftLowerArm',
  'mixamorigLeftHand':          'leftHand',
  'mixamorigRightShoulder':     'rightShoulder',
  'mixamorigRightArm':          'rightUpperArm',
  'mixamorigRightForeArm':      'rightLowerArm',
  'mixamorigRightHand':         'rightHand',
  'mixamorigLeftUpLeg':         'leftUpperLeg',
  'mixamorigLeftLeg':           'leftLowerLeg',
  'mixamorigLeftFoot':          'leftFoot',
  'mixamorigLeftToeBase':       'leftToes',
  'mixamorigRightUpLeg':        'rightUpperLeg',
  'mixamorigRightLeg':          'rightLowerLeg',
  'mixamorigRightFoot':         'rightFoot',
  'mixamorigRightToeBase':      'rightToes',
  'mixamorigLeftHandThumb1':    'leftThumbProximal',
  'mixamorigLeftHandThumb2':    'leftThumbIntermediate',
  'mixamorigLeftHandThumb3':    'leftThumbDistal',
  'mixamorigLeftHandIndex1':    'leftIndexProximal',
  'mixamorigLeftHandIndex2':    'leftIndexIntermediate',
  'mixamorigLeftHandIndex3':    'leftIndexDistal',
  'mixamorigLeftHandMiddle1':   'leftMiddleProximal',
  'mixamorigLeftHandMiddle2':   'leftMiddleIntermediate',
  'mixamorigLeftHandMiddle3':   'leftMiddleDistal',
  'mixamorigLeftHandRing1':     'leftRingProximal',
  'mixamorigLeftHandRing2':     'leftRingIntermediate',
  'mixamorigLeftHandRing3':     'leftRingDistal',
  'mixamorigLeftHandPinky1':    'leftLittleProximal',
  'mixamorigLeftHandPinky2':    'leftLittleIntermediate',
  'mixamorigLeftHandPinky3':    'leftLittleDistal',
  'mixamorigRightHandThumb1':   'rightThumbProximal',
  'mixamorigRightHandThumb2':   'rightThumbIntermediate',
  'mixamorigRightHandThumb3':   'rightThumbDistal',
  'mixamorigRightHandIndex1':   'rightIndexProximal',
  'mixamorigRightHandIndex2':   'rightIndexIntermediate',
  'mixamorigRightHandIndex3':   'rightIndexDistal',
  'mixamorigRightHandMiddle1':  'rightMiddleProximal',
  'mixamorigRightHandMiddle2':  'rightMiddleIntermediate',
  'mixamorigRightHandMiddle3':  'rightMiddleDistal',
  'mixamorigRightHandRing1':    'rightRingProximal',
  'mixamorigRightHandRing2':    'rightRingIntermediate',
  'mixamorigRightHandRing3':    'rightRingDistal',
  'mixamorigRightHandPinky1':   'rightLittleProximal',
  'mixamorigRightHandPinky2':   'rightLittleIntermediate',
  'mixamorigRightHandPinky3':   'rightLittleDistal',
};

// Retarget Mixamo FBX clip tracks to the NORMALIZED bones of a VRM model.
//
// This follows the official three-vrm "loadMixamoAnimation" algorithm. A Mixamo
// bone's local rotation is expressed relative to the Mixamo *rest* (T-pose)
// orientation, but a VRM normalized bone expects a rotation relative to its own
// identity rest. Copying the value verbatim — or only rotating it into world
// space — leaves every bone offset by its Mixamo rest orientation, which is what
// folded the character up / laid it on its back.
//
// Correct conversion, per keyframe:
//   q' = parentRestWorldRotation · q · restRotationInverse
// where:
//   parentRestWorldRotation = mixamo PARENT bone's world rotation in the rest pose
//   restRotationInverse     = inverse of this mixamo bone's OWN world rest rotation
// The `restRotationInverse` term (previously missing) cancels the bone's rest
// orientation so the neutral frame maps to the VRM's identity rest.
//
// VRM0 models (UniVRM 0.x) face −Z, so quaternions are mirrored on x/z.
//
// `fbxRoot` is the loaded FBX scene (needed to read Mixamo rest world rotations).
// `resolveTargetName(mixamoBone)` returns the destination track name (a VRM
// normalized node name, or — for our own rigged skeletons — the same Mixamo name).
// The target skeleton must have an identity rest pose, which holds for VRM
// normalized bones (and for Mixamo-rigged skeletons whose rest is the T-pose).
function retargetMixamoClips(clips, fbxRoot, resolveTargetName, isVRM0 = false) {
  fbxRoot.updateWorldMatrix(true, true);
  const restRotationInverse     = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _q = new THREE.Quaternion();

  let mapped = 0, unmapped = 0;
  clips.forEach(clip => {
    clip.tracks.forEach(track => {
      const dot = track.name.indexOf('.');
      const bonePart = dot >= 0 ? track.name.slice(0, dot) : track.name;
      const propPart = dot >= 0 ? track.name.slice(dot) : '';
      const targetName = resolveTargetName(bonePart);
      const mixamoNode = fbxRoot.getObjectByName(bonePart);
      if (!targetName || !mixamoNode || !mixamoNode.parent) { unmapped++; return; }

      // Convert each rotation keyframe from Mixamo rest space → identity rest space:
      //   q' = parentRestWorld · q · restInverse
      if (propPart === '.quaternion' && track.values.length >= 4) {
        mixamoNode.getWorldQuaternion(restRotationInverse).invert();
        mixamoNode.parent.getWorldQuaternion(parentRestWorldRotation);
        const v = track.values;
        for (let i = 0; i < v.length; i += 4) {
          _q.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
          _q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
          if (isVRM0) { _q.x = -_q.x; _q.z = -_q.z; }
          v[i] = _q.x; v[i + 1] = _q.y; v[i + 2] = _q.z; v[i + 3] = _q.w;
        }
      }

      track.name = targetName + propPart;
      mapped++;
    });
  });
  console.log(`[retarget] mapped=${mapped} unmapped=${unmapped} vrm0=${isVRM0}`);
  return mapped;
}

function retargetClipsForVRM(clips, vrm, fbxRoot) {
  const isVRM0 = String(vrm.meta?.metaVersion ?? vrm.meta?.exporterVersion ?? '') === '0'
              || vrm.meta?.metaVersion === 0;
  return retargetMixamoClips(clips, fbxRoot, (bonePart) => {
    const vrmBone = MIXAMO_TO_VRM[bonePart];
    if (!vrmBone) return null;
    return vrm.humanoid.getNormalizedBoneNode?.(vrmBone)?.name || null;
  }, isVRM0);
}

// Retarget onto a model whose bones already carry Mixamo names and an identity
// rest (e.g. a model auto-rigged on Mixamo and re-imported). This is what stops
// such a model from flipping upside-down when Mixamo animations are applied.
function retargetClipsForSkeleton(clips, fbxRoot, model) {
  const names = new Set();
  model.traverse(n => { if (n.isBone) names.add(n.name); });
  return retargetMixamoClips(clips, fbxRoot, (bonePart) => names.has(bonePart) ? bonePart : null, false);
}

// Turn a hips position track into normalized root motion: each frame's offset from the
// first frame, divided by the hips standing height (≈ first-frame Y). Result is unitless
// (fractions of hips height), so it applies to any model at any scale. Y = vertical hop,
// X/Z = horizontal travel.
function extractRootMotion(hipsTrack) {
  const v = hipsTrack.values, times = Array.from(hipsTrack.times);
  const x0 = v[0], y0 = v[1], z0 = v[2];
  const ref = Math.max(1e-3, Math.abs(y0));   // hips standing height as the scale reference
  const dx = [], dy = [], dz = [];
  for (let i = 0; i < times.length; i++) {
    dx.push((v[i * 3]     - x0) / ref);
    dy.push((v[i * 3 + 1] - y0) / ref);
    dz.push((v[i * 3 + 2] - z0) / ref);
  }
  return { times, dx, dy, dz };
}

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas   = document.getElementById('pc');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(520, 600);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 520 / 600, 0.01, 100);
camera.position.set(0, 1.2, 3);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.enablePan = false; controls.minDistance = 0.5; controls.maxDistance = 8;

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dir = new THREE.DirectionalLight(0xffffff, 1.6);
dir.position.set(1, 2, 2); scene.add(dir);
const gridHelper = new THREE.GridHelper(4, 16, 0x333355, 0x1e1e38);
scene.add(gridHelper);

// ── State ─────────────────────────────────────────────────────────────────────
let model    = null, vrmData = null, mixer = null;
let filePath = null, isRigged = false;
let modelClips    = [];   // clips embedded in the GLB/VRM
let importedClips = [];   // FBX clips imported by user
let allClips      = [];   // modelClips + importedClips (computed)
const clock = new THREE.Clock();

// Transform: base = normalization (fit to ~2.2 units, feet on the ground, centred,
// and the base facing — Math.PI for VRM); user = the scale/offset/rotation the
// creator sets. Keeping them separate stops user values from undoing the base.
let baseScale = 1;
let basePos   = new THREE.Vector3();
let baseRotY  = 0;
let sGroundBones = [];   // foot bones used to pin the model to the floor in preview
let previewPlaying = false;  // a clip is actively playing in the preview
let currentPreviewClip = null;   // name of the clip currently previewing
let previewAction = null;        // the playing AnimationAction (for root-motion sampling)
// Normalized hips root motion per clip {times,dx,dy,dz} (fractions of hips height) — lets
// jumps lift off and walks travel on any model. clipMove gates the HORIZONTAL part (travel
// vs in place); vertical is always applied so feet leave the floor automatically.
let clipRootMotion = {};
let clipMove = {};        // { [clipName]: true } = apply horizontal travel; default in place
// Per-clip tuning: { [name]: { speed, ox, oy, oz, pin } }. speed = playback rate; o* =
// position offset (fraction of character height); pin = ground lowest contact to floor.
let clipAdjust = {};
let walkSpeedVal = 0.16;  // scene wander walk speed (floor-uv / sec)
let userScaleVal = 1;
let userOffset   = { x: 0, y: 0, z: 0 };
let userRotDeg   = { x: 0, y: 0, z: 0 };   // degrees, applied on top of base facing
const D2R = Math.PI / 180;
function applyTransform() {
  if (!model) return;
  model.scale.setScalar(baseScale * userScaleVal);
  model.position.set(basePos.x + userOffset.x, basePos.y + userOffset.y, basePos.z + userOffset.z);
  model.rotation.set(userRotDeg.x * D2R, baseRotY + userRotDeg.y * D2R, userRotDeg.z * D2R);
}

function setStatus(msg) { document.getElementById('status-bar').textContent = msg; }
function $(id) { return document.getElementById(id); }

// ── Panel tabs ─────────────────────────────────────────────────────────────────
window.switchTab = (name, el) => {
  ['info','anims','states','scene'].forEach(t => {
    $(`tab-${t}`).style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  if (name === 'scene') sceneEditorOnShow();
};

// ── Character list ─────────────────────────────────────────────────────────────
const EMOJIS = ['🐉','🦊','🐱','🤖','🧝','🦄','👾','🐺','🧸','👻'];

async function loadCharList() {
  const chars = await window.deskbuddy.listCharacters();
  const list  = $('char-list');
  list.innerHTML = '';
  chars.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'char-card'; card.dataset.path = c.path;
    card.innerHTML = `<div class="av">${EMOJIS[i % EMOJIS.length]}</div>
      <div style="min-width:0;flex:1"><div class="cn">${c.name}</div><div class="ct">${c.filename.split('.').pop().toUpperCase()}</div></div>
      <button class="card-del" title="Delete character">✕</button>`;
    card.onclick = () => loadModel(c.path, c.name);
    card.querySelector('.card-del').onclick = (e) => { e.stopPropagation(); window.deleteCharacterCard(c); };
    list.appendChild(card);
  });
}

window.deleteCharacterCard = async (c) => {
  if (!confirm(`Delete "${c.name}"? This removes it from your computer and can't be undone.`)) return;
  const r = await window.deskbuddy.deleteCharacter(c.path);
  if (r?.ok) { setStatus('Deleted: ' + c.name); await loadCharList(); }
  else setStatus('Delete failed: ' + (r?.error || ''));
};

// ── Import model ──────────────────────────────────────────────────────────────
window.importCharacter = async () => {
  const r = await window.deskbuddy.importCharacter();
  if (!r) return;
  await loadCharList();
  loadModel(r.path, r.name);
};

// ── Multi-format loader ─────────────────────────────────────────────────────────
// Dispatch by extension to the matching three.js loader and normalise to a
// common shape: { object, vrm, animations }. GLB/glTF/VRM go through GLTFLoader;
// everything else parses synchronously from the buffer.
// Resolve an OBJ's .mtl + textures (copied beside it on import) into materials.
// Textures are referenced by basename in the .mtl, so a LoadingManager rewrites
// each request to a blob URL read from the characters dir over IPC.
async function loadOBJMaterials(objText) {
  const m = objText.match(/^\s*mtllib\s+(.+?)\s*$/mi);
  if (!m) return null;
  const dir = await window.deskbuddy.getCharactersDir();
  const sep = dir.includes('\\') ? '\\' : '/';
  const join = (n) => dir + sep + n.split(/[\\/]/).pop();

  const mtlBuf = await window.deskbuddy.readFileBuffer(join(m[1].trim()));
  if (!mtlBuf) return null;
  const mtlText = new TextDecoder().decode(mtlBuf);

  const blobByName = {};
  const texNames = new Set();
  mtlText.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (/^map_/i.test(t)) { const f = t.split(/\s+/).pop().split(/[\\/]/).pop(); if (f) texNames.add(f); }
  });
  for (const tn of texNames) {
    const tb = await window.deskbuddy.readFileBuffer(join(tn));
    if (tb) blobByName[tn] = URL.createObjectURL(new Blob([tb]));
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => blobByName[url.split(/[\\/]/).pop()] || url);
  const mtl = new MTLLoader(manager).parse(mtlText, '');
  mtl.preload();
  return mtl;
}

async function loadObjectFromBuffer(buf, ext) {
  const e = (ext || '').toLowerCase();
  if (['glb', 'gltf', 'vrm', 'charpack'].includes(e)) {
    const url = URL.createObjectURL(new Blob([buf]));
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p, { autoUpdateHumanBones: true }));
    const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
    URL.revokeObjectURL(url);
    const vrm = gltf.userData.vrm || null;
    return { object: vrm ? vrm.scene : gltf.scene, vrm, animations: gltf.animations || [] };
  }
  if (e === 'fbx') {
    const g = new FBXLoader().parse(buf, '');
    return { object: g, vrm: null, animations: g.animations || [] };
  }
  if (e === 'obj') {
    const text = new TextDecoder().decode(buf);
    const loader = new OBJLoader();
    try { const mats = await loadOBJMaterials(text); if (mats) loader.setMaterials(mats); }
    catch (err) { console.warn('OBJ materials:', err); }
    return { object: loader.parse(text), vrm: null, animations: [] };
  }
  if (e === 'dae') {
    const c = new ColladaLoader().parse(new TextDecoder().decode(buf), '');
    return { object: c.scene, vrm: null, animations: c.scene.animations || [] };
  }
  if (e === 'stl' || e === 'ply') {
    const geo = (e === 'stl' ? new STLLoader() : new PLYLoader()).parse(buf);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9c0d0, vertexColors: !!geo.getAttribute('color'), roughness: 0.8 });
    return { object: new THREE.Mesh(geo, mat), vrm: null, animations: [] };
  }
  if (e === '3mf') {
    return { object: new ThreeMFLoader().parse(buf), vrm: null, animations: [] };
  }
  throw new Error('Unsupported format: .' + e);
}

// ── Load model ─────────────────────────────────────────────────────────────────
async function loadModel(fp, name) {
  setStatus('Loading…'); clearModel();
  try {
    const buf = await window.deskbuddy.readCharacterFile(fp);
    if (!buf) throw new Error('Cannot read file');
    const ext = (fp.split('.').pop() || '').toLowerCase();
    const loaded = await loadObjectFromBuffer(buf, ext);

    filePath = fp;
    const vrm = loaded.vrm;
    if (vrm) {
      try { VRMUtils.removeUnnecessaryVertices(vrm.scene); } catch {}
      try { VRMUtils.combineSkeletons(vrm.scene); } catch {}
      vrmData = vrm; model = vrm.scene; isRigged = true;
      baseScale = 1; basePos.set(0, 0, 0); baseRotY = Math.PI;  // VRM faces away by default
    } else {
      model = loaded.object;
      const box = new THREE.Box3().setFromObject(model);
      const cen = box.getCenter(new THREE.Vector3());
      const md  = Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).y, box.getSize(new THREE.Vector3()).z) || 1;
      baseScale = 2.2 / md;                     // normalize biggest dimension to ~2.2 units
      basePos.set(-cen.x * baseScale, -box.min.y * baseScale, -cen.z * baseScale); // centre x/z, feet on ground
      baseRotY = 0;
      isRigged = hasBones(model);
    }
    scene.add(model);

    modelClips = loaded.animations || [];
    mixer = new THREE.AnimationMixer(model);

    // Load manifest — restore saved FBX clips
    let manifest = {};
    try {
      const mb = await window.deskbuddy.readCharacterFile(fp + '.json');
      if (mb) manifest = JSON.parse(new TextDecoder().decode(mb));
    } catch {}

    // Restore the creator's scale/offset/rotation on top of the base normalization.
    userScaleVal = manifest.scale || 1;
    userOffset = { x: 0, y: 0, z: 0, ...(manifest.offset || {}) };
    userRotDeg = { x: 0, y: 0, z: 0, ...(manifest.rotation || {}) };
    applyTransform();

    // Deserialize previously saved FBX clips
    importedClips = [];
    if (Array.isArray(manifest.importedClips)) {
      for (const json of manifest.importedClips) {
        try { importedClips.push(THREE.AnimationClip.parse(json)); } catch {}
      }
    }

    rebuildAllClips();
    // Load in a static rest pose — don't auto-play a clip. The user can pick one
    // from the animation bar when they want to preview.
    if (mixer) mixer.stopAllAction();
    previewPlaying = false;
    document.querySelectorAll('.ab').forEach(b => b.classList.remove('act'));

    // Fit camera
    const box = new THREE.Box3().setFromObject(model);
    const cen = box.getCenter(new THREE.Vector3());
    const siz = box.getSize(new THREE.Vector3());
    const fov = camera.fov * Math.PI / 180;
    const d   = (Math.max(siz.x, siz.y, siz.z) / 2 / Math.tan(fov / 2)) * 1.3;
    camera.position.set(cen.x, cen.y, cen.z + d);
    controls.target.copy(cen); camera.near = d * 0.01; camera.far = d * 10;
    camera.updateProjectionMatrix(); controls.update();

    $('c-name').value   = manifest.name || name;
    $('c-author').value = manifest.author || '';
    $('c-desc').value   = manifest.description || '';
    $('c-tags').value   = (manifest.tags || []).join(', ');
    syncTransformUI();

    const sleepMin = manifest.stateSettings?.sleepAfterMinutes || 10;
    $('sleep-sl').value = sleepMin;
    $('sleep-lbl').textContent = sleepMin;

    // Restore state assignments
    if (manifest.animationStates) {
      savedStateMap = manifest.animationStates;
    }
    savedCustomStates = Array.isArray(manifest.customStates)
      ? manifest.customStates.map(c => ({ ...c }))
      : [];
    clipRootMotion = (manifest.rootMotion && typeof manifest.rootMotion === 'object') ? { ...manifest.rootMotion } : {};
    clipMove = (manifest.clipMove && typeof manifest.clipMove === 'object') ? { ...manifest.clipMove } : {};
    clipAdjust = (manifest.clipAdjust && typeof manifest.clipAdjust === 'object') ? { ...manifest.clipAdjust } : {};
    walkSpeedVal = (typeof manifest.walkSpeed === 'number') ? manifest.walkSpeed : 0.16;
    if ($('adj-walk')) { $('adj-walk').value = walkSpeedVal; $('adj-walk-lbl').textContent = walkSpeedVal.toFixed(2); }
    savedRigJoints = manifest.rig?.joints || null;

    $('pc').style.display  = 'block';
    $('dz').style.display  = 'none';
    $('save-btn').disabled = false;

    collectGroundBones();
    updateAnimBar(); updateAnimList(); updateStateRows(); updateCustomStateRows();
    refreshCharSizeUI();   // the size slider keys off the loaded character
    markActiveCard(fp);
    setStatus(`Loaded: ${name} · ${modelClips.length} model clip(s) · ${importedClips.length} imported clip(s)`);
  } catch (err) {
    console.error(err); setStatus('Error: ' + err.message);
  }
}

function hasBones(obj) {
  let f = false; obj.traverse(n => { if (n.isBone || n.isSkinnedMesh) f = true; }); return f;
}

function clearModel() {
  if (model) { scene.remove(model); model = null; vrmData = null; }
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  modelClips = []; importedClips = []; allClips = []; filePath = null; isRigged = false;
  savedCustomStates = [];
  savedRigJoints = null;
  sGroundBones = []; previewPlaying = false;
}

// ── Clip management ───────────────────────────────────────────────────────────
function rebuildAllClips() {
  allClips = [...modelClips, ...importedClips];
}

// ── Preview ───────────────────────────────────────────────────────────────────
function previewClip(clip, once = false) {
  if (!mixer || !model) return;
  mixer.stopAllAction();
  try {
    const a = mixer.clipAction(clip);
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once; a.reset().play();
    previewPlaying = true;
    currentPreviewClip = clip.name;
    a.timeScale = clipAdjust[clip.name]?.speed ?? 1;   // per-clip playback speed
    previewAction = a; _previewModelH = 0;   // recompute model height for root-motion scaling
  } catch (err) {
    setStatus('Preview error: ' + err.message);
    console.error('clipAction error', err);
    return;
  }
  document.querySelectorAll('.ab').forEach(b => b.classList.toggle('act', b.dataset.clip === clip.name));
}

// Stop the preview and return the model to its rest/bind pose.
window.stopPreview = () => {
  if (!mixer) return;
  mixer.stopAllAction();
  previewPlaying = false;
  if (model) applyTransform();   // undo any foot-grounding shift
  document.querySelectorAll('.ab').forEach(b => b.classList.remove('act'));
  setStatus('Animation stopped');
};

function updateAnimBar() {
  const bar = $('anim-bar'); bar.innerHTML = '';
  if (!allClips.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  // A Stop chip is always first, so any playing clip can be halted (not just
  // replaced by another). It returns the model to its rest pose.
  const stop = document.createElement('button');
  stop.className = 'ab ab-stop'; stop.textContent = '⏹ Stop';
  stop.onclick = () => stopPreview();
  bar.appendChild(stop);
  allClips.slice(0, 10).forEach(c => {
    const b = document.createElement('button'); b.className = 'ab'; b.dataset.clip = c.name;
    b.textContent = c.name.length > 16 ? c.name.slice(0,14)+'…' : c.name;
    b.onclick = () => previewClip(c); bar.appendChild(b);
  });
}

function updateAnimList() {
  const list = $('anim-list');
  const total = modelClips.length + importedClips.length;
  $('anim-count').textContent = total;
  try { updateAdjustDropdown(); } catch (e) { console.error('adjust dropdown:', e); }

  if (!total) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted)">No animations yet. Import FBX from Mixamo above, or embed animations in your GLB.</div>';
    return;
  }

  list.innerHTML = '';

  modelClips.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'clip-row';
    row.innerHTML = `
      <span class="clip-name" title="${c.name}">${c.name || `Clip ${i+1}`}</span>
      <span class="clip-dur">${c.duration.toFixed(1)}s</span>
      <span class="clip-src src-model">model</span>
      ${moveBtnHTML(c.name)}
      <button class="clip-play" title="Preview" onclick="previewClipByName('${escName(c.name)}')">▶</button>`;
    list.appendChild(row);
  });

  importedClips.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'clip-row';
    row.innerHTML = `
      <span class="clip-name" title="${c.name}">${c.name || `FBX ${i+1}`}</span>
      <span class="clip-dur">${c.duration.toFixed(1)}s</span>
      <span class="clip-src src-fbx">Mixamo</span>
      ${moveBtnHTML(c.name)}
      <button class="clip-play" title="Preview" onclick="previewClipByName('${escName(c.name)}')">▶</button>
      <button class="clip-del" title="Remove" onclick="removeImportedClip(${i})">✕</button>`;
    list.appendChild(row);
  });
}

function escName(n) { return (n || '').replace(/'/g, "\\'"); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ── Per-clip adjust (speed / offset / pin) + walk speed ───────────────────────
function updateAdjustDropdown() {
  const sel = $('adj-clip'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select an animation —</option>'
    + allClips.map(c => `<option value="${escName(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  if (allClips.some(c => c.name === cur)) sel.value = cur; else { sel.value = ''; adjSelect(); }
}
window.adjSelect = () => {
  const name = $('adj-clip').value;
  const box = $('adj-controls');
  if (!name) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const a = clipAdjust[name] || {};
  $('adj-speed').value = a.speed ?? 1;
  $('adj-ox').value = a.ox ?? 0; $('adj-oy').value = a.oy ?? 0; $('adj-oz').value = a.oz ?? 0;
  $('adj-pin').checked = !!a.pin;
  adjLabels();
  // Preview the selected clip so edits are seen live.
  const clip = allClips.find(c => c.name === name);
  if (clip && model) previewClip(clip);
};
function adjLabels() {
  $('adj-speed-lbl').textContent = (+$('adj-speed').value).toFixed(2) + '×';
  $('adj-ox-lbl').textContent = (+$('adj-ox').value).toFixed(2);
  $('adj-oy-lbl').textContent = (+$('adj-oy').value).toFixed(2);
  $('adj-oz-lbl').textContent = (+$('adj-oz').value).toFixed(2);
}
window.adjChange = () => {
  const name = $('adj-clip').value; if (!name) return;
  const speed = +$('adj-speed').value, ox = +$('adj-ox').value, oy = +$('adj-oy').value, oz = +$('adj-oz').value, pin = $('adj-pin').checked;
  const a = {};
  if (Math.abs(speed - 1) > 1e-3) a.speed = speed;
  if (Math.abs(ox) > 1e-3) a.ox = ox; if (Math.abs(oy) > 1e-3) a.oy = oy; if (Math.abs(oz) > 1e-3) a.oz = oz;
  if (pin) a.pin = true;
  if (Object.keys(a).length) clipAdjust[name] = a; else delete clipAdjust[name];
  adjLabels();
  if (previewAction && currentPreviewClip === name) previewAction.timeScale = speed;   // live speed
};
window.adjWalkChange = () => {
  walkSpeedVal = +$('adj-walk').value;
  $('adj-walk-lbl').textContent = walkSpeedVal.toFixed(2);
};

// Per-clip Movement toggle. Grounding is now AUTOMATIC — a clip that carries its own
// root motion (jumps, walks) drives its vertical itself (feet leave the floor naturally);
// everything else is foot-pinned. This toggle only controls the HORIZONTAL travel of a
// root-motion clip: "Travel" moves the character as animated, "In place" keeps it put
// (a forward jump still lifts, it just doesn't drift). Hidden for clips with no root motion.
function moveBtnHTML(name) {
  if (!clipRootMotion[name]) return '';   // no root motion → nothing to toggle
  const on = clipMove[name] === true;
  const tip = on ? 'Travel: the character moves across the floor as the animation does. Click for in-place.'
                 : 'In place: plays without horizontal travel (jumps still lift off). Click to let it travel.';
  return `<button class="clip-move${on ? ' on' : ''}" title="${tip}" onclick="toggleMove('${escName(name)}')">${on ? '🚶 Travel' : '📍 In place'}</button>`;
}
window.toggleMove = (name) => {
  if (clipMove[name]) delete clipMove[name]; else clipMove[name] = true;
  updateAnimList();
  setStatus(clipMove[name] ? `"${name}" will travel across the floor` : `"${name}" plays in place`);
};

window.previewClipByName = (name) => {
  if (!mixer || !model) { setStatus('Load a model first to preview animations'); return; }
  const clip = allClips.find(c => c.name === name);
  if (!clip) { setStatus('Clip not found: ' + name); return; }
  previewClip(clip);
  setStatus(`Playing: ${clip.name} (${clip.duration.toFixed(1)}s)`);
};

window.removeImportedClip = (idx) => {
  importedClips.splice(idx, 1);
  rebuildAllClips();
  updateAnimBar(); updateAnimList(); updateStateRows(); updateCustomStateRows();
  setStatus(`Clip removed (${importedClips.length} remaining)`);
};

// ── FBX Import from Mixamo ───────────────────────────────────────────────────
window.openMixamo = () =>
  window.deskbuddy.openExternal('https://www.mixamo.com/#/?type=Motion%2CMotionPack');

// Parse an animation file's bytes and retarget+add its clips to the current character.
// Shared by direct import and "Add from library". Returns true on success.
async function processAnimationBytes(buf, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let clips = [], sourceRoot = null;
  if (ext === 'fbx') {
    const fbx = new FBXLoader().parse(buf, '');
    clips = fbx.animations || []; sourceRoot = fbx;
  } else if (ext === 'glb' || ext === 'gltf') {
    const url = URL.createObjectURL(new Blob([buf]));
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, null, rej));
    URL.revokeObjectURL(url);
    clips = gltf.animations || []; sourceRoot = gltf.scene;
  } else if (ext === 'bvh') {
    const bvh = new BVHLoader().parse(new TextDecoder().decode(buf));
    clips = bvh.clip ? [bvh.clip] : [];
    clips.forEach(c => c.tracks.forEach(t => { t.name = t.name.replace(/^\.bones\[(.+?)\]/, '$1'); }));
    sourceRoot = new THREE.Object3D();
    if (bvh.skeleton?.bones?.[0]) sourceRoot.add(bvh.skeleton.bones[0]);
  } else { setStatus('Unsupported animation format: .' + ext); return false; }
  if (!clips.length) { setStatus('No animation clips found in this file'); return false; }
  processImportedClips(clips, sourceRoot, filename, ext);
  return true;
}

window.importFBXAnimation = async () => {
  if (!model) { setStatus('Load a character model first, then import an animation'); return; }
  const r = await window.deskbuddy.importFBXAnimation();
  if (!r) return;
  setStatus(`Reading ${r.filename}…`);
  const buf = await window.deskbuddy.readFileBuffer(r.path);
  if (!buf) { setStatus('Cannot read file'); return; }
  try {
    const ok = await processAnimationBytes(buf, r.filename);
    if (ok) {   // save the source to the app library so every character can reuse it
      const ext = (r.filename.split('.').pop() || 'fbx').toLowerCase();
      try { await window.deskbuddy.saveAnimationSource({ name: r.filename.replace(/\.[^.]+$/, ''), bytes: buf, ext }); refreshAnimLibrary(); } catch {}
    }
  } catch (err) {
    console.error('animation import error:', err);
    setStatus('Animation error: ' + (err.message || String(err)));
  }
};

// ── Animation library (saved sources, reusable across characters) ──────────────
let _animLib = [];
async function refreshAnimLibrary() {
  const box = $('anim-library'); if (!box) return;
  try { _animLib = await window.deskbuddy.listAnimationSources() || []; } catch { _animLib = []; }
  if (!_animLib.length) {
    box.innerHTML = '<div style="font-size:11px;color:var(--muted)">No saved animations yet. Import one above — it\'ll be saved here.</div>';
    return;
  }
  box.innerHTML = _animLib.map((it, i) => `
    <div class="lib-row">
      <span class="lib-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
      <span class="lib-ext">${escapeHtml(it.ext)}</span>
      <button class="lib-add" onclick="addFromLibrary(${i})">+ Add</button>
      <button class="lib-del" title="Remove from library" onclick="delAnimSource(${i})">✕</button>
    </div>`).join('');
}
window.addFromLibrary = async (i) => {
  const it = _animLib[i]; if (!it) return;
  if (!model) { setStatus('Load a character first, then add an animation'); return; }
  setStatus(`Adding ${it.name}…`);
  const buf = await window.deskbuddy.readFileBuffer(it.path);
  if (!buf) { setStatus('Cannot read animation'); return; }
  try { await processAnimationBytes(buf, it.filename); }
  catch (err) { console.error('add from library:', err); setStatus('Add error: ' + (err.message || String(err))); }
};
window.delAnimSource = async (i) => {
  const it = _animLib[i]; if (!it) return;
  await window.deskbuddy.deleteAnimationSource(it.path);
  refreshAnimLibrary();
};

// Normalise, retarget, and add a set of loaded clips. `sourceRoot` is the source
// rig (FBX scene / glTF scene / BVH skeleton root) used to read rest poses.
function processImportedClips(clips, sourceRoot, filename, ext) {
  // Step 1: strip action/armature prefix and the "mixamorig:" colon namespace.
  clips.forEach(clip => {
    clip.tracks.forEach(track => {
      const pipe = track.name.indexOf('|');
      if (pipe !== -1) track.name = track.name.slice(pipe + 1);
      track.name = track.name.replace(/^mixamorig:/, 'mixamorig');
    });
  });

  // Step 2: give generic clip names the file name.
  const baseName = filename.replace(new RegExp('\\.' + ext + '$', 'i'), '');
  clips.forEach((clip, i) => {
    const generic = !clip.name || ['mixamo.com', 'Armature', 'Take 001', 'Take001', 'default'].includes(clip.name);
    if (generic) clip.name = clips.length > 1 ? `${baseName} ${i + 1}` : baseName;
  });

  // Step 2.5: stash normalized hips root motion on each clip BEFORE the position tracks
  // are stripped (Step 4). Normalized by the hips standing height so it transfers to any
  // model regardless of source units; played back as a modelRoot offset (see overlay).
  clips.forEach(clip => {
    const ht = clip.tracks.find(t => t.name === 'mixamorigHips.position');
    if (ht && ht.values.length >= 6) clip.userData = { ...(clip.userData || {}), rootMotion: extractRootMotion(ht) };
  });

  // Step 3: retarget onto the model's bones.
  if (vrmData) {
    const mapped = retargetClipsForVRM(clips, vrmData, sourceRoot);
    if (mapped === 0) {
      setStatus('⚠ Retargeting found 0 matching bones — this clip needs a Mixamo-named source.');
      return;
    }
    setStatus(`Retargeted ${mapped} tracks for VRM model…`);
  } else {
    const boneNames = [];
    model.traverse(n => { if (n.isBone) boneNames.push(n.name); });
    if (!boneNames.length) {
      setStatus('⚠ Model has no skeleton — rig it in the Rig tab first, then import animations.');
      return;
    }
    // Mixamo-named skeleton (our rig template, or an auto-mapped one) → retarget
    // into its identity-rest space. Without this the model animates upside-down.
    if (sourceRoot && boneNames.some(n => /^mixamorig/i.test(n))) {
      const mapped = retargetClipsForSkeleton(clips, sourceRoot, model);
      if (mapped === 0) setStatus('⚠ Retargeting matched 0 bones — the animation may look off.');
    }
  }

  // Step 4: keep only rotation tracks (in-place animation for a desktop buddy).
  clips.forEach(clip => { clip.tracks = clip.tracks.filter(t => t.name.endsWith('.quaternion')); });

  // Step 5: add (de-duplicating names). Carry each clip's extracted root motion across
  // under its FINAL name so playback can find it.
  const added = [];
  clips.forEach(clip => {
    let name = clip.name, n = 1;
    while (importedClips.some(c => c.name === name)) name = `${clip.name} (${++n})`;
    clip.name = name;
    if (clip.userData?.rootMotion) clipRootMotion[name] = clip.userData.rootMotion;
    importedClips.push(clip);
    added.push(clip.name);
  });

  rebuildAllClips();
  const latest = importedClips[importedClips.length - 1];
  if (latest) previewClip(latest);
  updateAnimBar(); updateAnimList(); updateStateRows(); updateCustomStateRows();
  setStatus(`✓ Imported: ${added.join(', ')}`);
}

// ── Animation state rows ──────────────────────────────────────────────────────
const STATE_DEFS = [
  { id: 'idle',      label: 'Idle Pose',          loop: true  },   // the held resting pose
  { id: 'idleBreak', label: 'Idle Break (random)', loop: false },  // occasional gesture, then back to pose
  { id: 'active',   label: 'Active',       loop: true  },
  { id: 'walk',     label: 'Walking',      loop: true  },   // required for scene strolling
  { id: 'watching', label: 'Watching',     loop: true  },
  { id: 'loading',  label: 'Loading/Busy', loop: true  },
  { id: 'sitting',  label: 'Sitting',      loop: true  },
  { id: 'sleeping', label: 'Sleeping',     loop: true  },
  { id: 'clicked',  label: 'Clicked',      loop: false },
];

let savedStateMap = {};
let savedCustomStates = [];   // [{ id, label, clip, app }]

function updateStateRows() {
  const container = $('state-rows'); container.innerHTML = '';

  if (!allClips.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--muted)">Import animations first, then assign them to states here.</div>';
    return;
  }

  STATE_DEFS.forEach(def => {
    const row = document.createElement('div'); row.className = 'state-row';

    const label = document.createElement('span');
    label.className = 'state-label'; label.textContent = def.label;

    const sel = document.createElement('select'); sel.id = `state-${def.id}`;
    sel.appendChild(new Option('— none —', ''));
    allClips.forEach(c => sel.appendChild(new Option(c.name, c.name)));
    sel.value = savedStateMap[def.id] || '';

    const play = document.createElement('button'); play.className = 'state-play';
    play.textContent = '▶'; play.title = 'Preview';
    play.onclick = () => {
      const clip = allClips.find(c => c.name === sel.value);
      if (clip) previewClip(clip, !def.loop);
    };

    const tag = document.createElement('span');
    tag.className = `stag ${def.loop ? 'stag-l' : 'stag-o'}`;
    tag.textContent = def.loop ? 'loop' : '×1';

    row.append(label, sel, play, tag);
    container.appendChild(row);
  });
}

function collectStateMap() {
  const map = {};
  STATE_DEFS.forEach(d => { const el = $(`state-${d.id}`); if (el) map[d.id] = el.value || null; });
  return map;
}

// ── Custom states ──────────────────────────────────────────────────────────────
// User-defined states: a name, an animation, and an optional app to watch. When
// that app is running, the overlay plays this state. They can also be triggered
// by hand from the buddy's right-click menu.
const escAttr = (s) => (s || '').replace(/"/g, '&quot;');
const escHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function clipOptionsHTML(selected) {
  let s = '<option value="">— animation —</option>';
  allClips.forEach(c => {
    s += `<option value="${escAttr(c.name)}"${c.name === selected ? ' selected' : ''}>${escHtml(c.name)}</option>`;
  });
  return s;
}

function updateCustomStateRows() {
  const host = $('custom-rows');
  if (!host) return;
  host.innerHTML = '';
  if (!allClips.length) {
    host.innerHTML = '<div style="font-size:11px;color:var(--muted)">Import animations first, then add custom states.</div>';
    return;
  }
  savedCustomStates.forEach((cs, i) => {
    const row = document.createElement('div');
    row.className = 'custom-row';
    row.innerHTML = `
      <input class="cs-label" placeholder="State name (e.g. Coding)" value="${escAttr(cs.label)}">
      <div class="cs-line">
        <select class="cs-clip">${clipOptionsHTML(cs.clip)}</select>
        <button class="state-play" title="Preview">▶</button>
        <button class="clip-del" title="Remove">✕</button>
      </div>
      <input class="cs-app" placeholder="Run when this app is open (e.g. code, chrome)" value="${escAttr(cs.app)}">`;
    host.appendChild(row);
    row.querySelector('.cs-label').oninput  = (e) => { savedCustomStates[i].label = e.target.value; };
    row.querySelector('.cs-clip').onchange  = (e) => { savedCustomStates[i].clip  = e.target.value; };
    row.querySelector('.cs-app').oninput    = (e) => { savedCustomStates[i].app   = e.target.value; };
    row.querySelector('.state-play').onclick = () => {
      const clip = allClips.find(c => c.name === savedCustomStates[i].clip);
      if (clip) previewClip(clip); else setStatus('Pick an animation for this state first');
    };
    row.querySelector('.clip-del').onclick  = () => { savedCustomStates.splice(i, 1); updateCustomStateRows(); };
  });
}

window.addCustomState = () => {
  if (!allClips.length) { setStatus('Import animations first, then add custom states'); return; }
  savedCustomStates.push({ id: 'cs_' + Date.now().toString(36), label: '', clip: '', app: '' });
  updateCustomStateRows();
};

function collectCustomStates() {
  return savedCustomStates
    .filter(c => (c.label || '').trim() || c.clip)
    .map(c => ({
      id:    c.id || ('cs_' + Math.random().toString(36).slice(2, 8)),
      label: (c.label || '').trim() || 'Custom',
      clip:  c.clip || '',
      app:   (c.app || '').trim(),
    }));
}

// ── Transform: scale + position ────────────────────────────────────────────────
const clampScale = (v) => Math.max(0.01, Math.min(20, v));
function syncTransformUI() {
  const sl = $('scale-sl'), num = $('scale-num'), lbl = $('scale-lbl');
  if (num) num.value = userScaleVal.toFixed(2);
  if (sl)  sl.value  = Math.min(parseFloat(sl.max || '5'), userScaleVal);
  if (lbl) lbl.textContent = userScaleVal.toFixed(2) + '×';
}
window.onScale     = (val) => { userScaleVal = clampScale(parseFloat(val) || 1); applyTransform(); syncTransformUI(); };
window.onScaleNum  = (val) => { const v = parseFloat(val); if (!isNaN(v)) { userScaleVal = clampScale(v); applyTransform(); syncTransformUI(); } };
window.nudgeScale  = (factor) => { userScaleVal = clampScale(userScaleVal * factor); applyTransform(); syncTransformUI(); };
window.nudgePos    = (axis, dir) => { if (!model) return; userOffset[axis] = (userOffset[axis] || 0) + 0.1 * dir; applyTransform(); };
window.recenter    = () => { userOffset = { x: 0, y: 0, z: 0 }; applyTransform(); setStatus('Re-centered on the ground'); };
window.rotateModel = (axis, dir) => { if (!model) return; userRotDeg[axis] = ((userRotDeg[axis] || 0) + 15 * dir) % 360; applyTransform(); setStatus(`Rotation ${axis.toUpperCase()}: ${Math.round(userRotDeg[axis])}°`); };
window.resetRotation = () => { userRotDeg = { x: 0, y: 0, z: 0 }; applyTransform(); setStatus('Rotation reset'); };

// ── Character state (in-app rigging removed — VRM-first) ────────────────
// Pre-rigged models (VRM, or GLB/FBX with a skeleton) load and animate as-is;
// unrigged meshes are rigged externally (VRoid Studio / Mixamo) before import.
// We keep a model’s saved joints so legacy charpacks still round-trip on save.
let savedRigJoints = null;   // legacy: { boneName:[x,y,z] } from old manifests

function markActiveCard(fp) {
  document.querySelectorAll(".char-card").forEach(c => c.classList.toggle("active", c.dataset.path === fp));
}

// ── Save charpack ──────────────────────────────────────────────────────────────
window.saveCharpack = async () => {
  if (!filePath) { setStatus('No model loaded'); return; }
  const name = $('c-name').value.trim() || 'unnamed';

  // Serialize imported FBX clips so they persist in the manifest
  const serializedClips = importedClips.map(c => THREE.AnimationClip.toJSON(c));
  const thumbnail = renderThumbnail();   // actual model image for the marketplace card

  const manifest = {
    name,
    author:          $('c-author').value.trim(),
    description:     $('c-desc').value.trim(),
    tags:            $('c-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    scale:           userScaleVal,
    offset:          userOffset,
    rotation:        userRotDeg,
    rigged:          isRigged,
    rig:             savedRigJoints ? { joints: savedRigJoints } : undefined,
    animationCount:  modelClips.length,
    importedClips:   serializedClips,
    animationStates: collectStateMap(),
    customStates:    collectCustomStates(),
    rootMotion:      clipRootMotion,
    clipMove:        Object.fromEntries(Object.entries(clipMove).filter(([, v]) => v === true)),
    clipAdjust,
    walkSpeed:       walkSpeedVal,
    stateSettings:   { sleepAfterMinutes: parseInt($('sleep-sl').value, 10) || 10 },
    thumbnail:       thumbnail || undefined,
    version:         '1.0.0',
  };

  setStatus('Saving…');
  let glbData;
  if (vrmData) {
    // Keep the original VRM bytes (preserves spring bones, blendshapes, etc.).
    glbData = await window.deskbuddy.readCharacterFile(filePath);
    if (!glbData) { setStatus('Error: cannot read model file'); return; }
  } else {
    // Everything else (GLB, OBJ+textures, FBX, STL, rigged meshes) → export a GLB
    // so the charpack is always valid and textures are embedded. Export at the
    // BASE transform; the creator's scale/offset live in the manifest and are
    // applied by the overlay, so they don't get baked in twice.
    try {
      model.scale.setScalar(baseScale);
      model.position.copy(basePos);
      model.rotation.set(0, baseRotY, 0);   // export at base facing; user rotation is in the manifest
      model.updateMatrixWorld(true);
      glbData = await new Promise((res, rej) =>
        new GLTFExporter().parse(model, res, rej, { binary: true, onlyVisible: false }));
    } catch (err) {
      console.error('GLTF export:', err); setStatus('Export error: ' + (err.message || err)); return;
    } finally {
      applyTransform();   // restore the live preview transform
    }
  }

  const savedPath = await window.deskbuddy.saveCharpack({ name, glbData, manifest, originalPath: filePath });
  if (savedPath) filePath = savedPath;   // keep editing the saved file (so a re-save overwrites, not duplicates)
  await window.deskbuddy.activateCharacter(savedPath || filePath);
  await loadCharList();
  setStatus(`✓ Saved & activated: ${name}`);
};

// ── Foot grounding (preview) ────────────────────────────────────────────────
// Mixamo position tracks are stripped on import, so sit/jump/crouch clips keep the
// pose but float the body on its hips. Each animated frame we pin the lowest foot
// bone to the grid floor (y=0), matching what the overlay does on the desktop.
const _sFootWP = new THREE.Vector3();
let sSinkBones = [];   // broad contact set (feet, hands, head) for "pin to floor"
function collectGroundBones() {
  sGroundBones = []; sSinkBones = [];
  const FEET_V = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'];
  const SINK_V = [...FEET_V, 'leftHand', 'rightHand', 'head'];
  const FEET_M = ['mixamorigLeftFoot', 'mixamorigRightFoot', 'mixamorigLeftToeBase', 'mixamorigRightToeBase'];
  const SINK_M = [...FEET_M, 'mixamorigLeftHand', 'mixamorigRightHand', 'mixamorigHead'];
  if (vrmData?.humanoid?.getRawBoneNode) {
    FEET_V.forEach(n => { const b = vrmData.humanoid.getRawBoneNode(n); if (b) sGroundBones.push(b); });
    SINK_V.forEach(n => { const b = vrmData.humanoid.getRawBoneNode(n); if (b) sSinkBones.push(b); });
  }
  if (!sGroundBones.length && model) {
    const byName = {};
    model.traverse(o => { if (o.isBone) byName[o.name] = o; });
    FEET_M.forEach(n => { if (byName[n]) sGroundBones.push(byName[n]); });
    SINK_M.forEach(n => { if (byName[n]) sSinkBones.push(byName[n]); });
  }
  if (!sSinkBones.length) sSinkBones = sGroundBones.slice();
}
function _lowestPreviewY(bones) {
  let lo = Infinity;
  for (const b of bones) { b.getWorldPosition(_sFootWP); if (_sFootWP.y < lo) lo = _sFootWP.y; }
  return lo;
}
// Sample a normalized root-motion curve at time t (looping).
function sampleRootMotion(rm, t) {
  const T = rm.times; if (!T || !T.length) return { dx: 0, dy: 0, dz: 0 };
  const dur = T[T.length - 1] || 1; let tt = t % dur; if (tt < 0) tt += dur;
  let i = 0; while (i < T.length - 1 && T[i + 1] < tt) i++;
  const j = Math.min(i + 1, T.length - 1);
  const f = T[j] > T[i] ? (tt - T[i]) / (T[j] - T[i]) : 0;
  const L = (a) => a[i] + (a[j] - a[i]) * f;
  return { dx: L(rm.dx), dy: L(rm.dy), dz: L(rm.dz) };
}
let _previewModelH = 0;
function previewCharHeight() {
  if (_previewModelH) return _previewModelH;
  if (!model) return 1;
  const b = new THREE.Box3().setFromObject(model);
  _previewModelH = Math.max(0.1, b.max.y - b.min.y);
  return _previewModelH;
}
// Unified preview pose: reset to base, apply vertical handling, then the manual offset.
// Reset-based each frame so nothing accumulates/drifts.
//   pin       → ground the lowest contact (feet/hands/head) to the floor (floor moves)
//   rootmotion→ lift by the hop (jumps) + horizontal drift for Travel clips
//   else      → foot-pin (rotation-only clips like sit/idle)
function applyPreviewPose() {
  if (!model) return;
  const name = currentPreviewClip;
  const adj = clipAdjust[name] || {};
  applyTransform();
  model.updateMatrixWorld(true);
  const h = previewCharHeight();
  if (adj.pin && sSinkBones.length) {
    const lo = _lowestPreviewY(sSinkBones);
    if (isFinite(lo)) model.position.y += (0 - lo);
  } else if (clipRootMotion[name] && previewAction) {
    const s = sampleRootMotion(clipRootMotion[name], previewAction.time);
    model.position.y += s.dy * h * 0.55;   // 0.55 ≈ floor→hips fraction of total height
    if (clipMove[name]) { model.position.x += s.dx * h * 0.55; model.position.z += s.dz * h * 0.55; }
  } else if (sGroundBones.length) {
    const lo = _lowestPreviewY(sGroundBones);
    if (isFinite(lo)) model.position.y += (0 - lo);
  }
  if (adj.ox || adj.oy || adj.oz) {     // manual offset (fraction of character height)
    model.position.x += (adj.ox || 0) * h;
    model.position.y += (adj.oy || 0) * h;
    model.position.z += (adj.oz || 0) * h;
  }
}

// ── Model thumbnail ──────────────────────────────────────────────────────────
// Render the loaded model (no grid, transparent background) to an offscreen target and
// read it back as a PNG data URL. Stored in the manifest so the marketplace card shows
// the actual character instead of a generic emoji. Uses a render target + pixel readback
// (not canvas.toDataURL) so it's reliable regardless of preserveDrawingBuffer.
function renderThumbnail(size = 256) {
  if (!model) return null;
  try {
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(s.x, s.y, s.z) || 1;
    const fov = 35;
    const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 1000);
    const dist = (maxDim / (2 * Math.tan(fov * Math.PI / 360))) * 1.45;
    cam.position.set(c.x, c.y + s.y * 0.06, c.z + dist);
    cam.lookAt(c.x, c.y, c.z);

    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    const gridWas = gridHelper.visible; gridHelper.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    gridHelper.visible = gridWas;

    const buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    rt.dispose();

    const cnv = document.createElement('canvas'); cnv.width = size; cnv.height = size;
    const ctx = cnv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {            // GL origin is bottom-left → flip vertically
      const sy = size - 1 - y;
      for (let x = 0; x < size; x++) {
        const si = (sy * size + x) * 4, di = (y * size + x) * 4;
        img.data[di] = buf[si]; img.data[di+1] = buf[si+1]; img.data[di+2] = buf[si+2]; img.data[di+3] = buf[si+3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return cnv.toDataURL('image/png');
  } catch (e) { console.warn('thumbnail render failed:', e); return null; }
}

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  if (mixer) mixer.update(dt);       // 1. mixer writes to normalized bones
  if (vrmData?.update) vrmData.update(dt); // 2. VRM converts normalized → raw bone space
  // Pose the model while a clip plays: grounding / root-motion lift / pin-to-floor + offset.
  if (previewPlaying) applyPreviewPose();
  renderer.render(scene, camera);
}
animate();

// ── Scene editor ────────────────────────────────────────────────────────────────
// A 2D editor for .scenepack files: drop a background, drag the 4 floor-quad
// corners, click empty floor to add anchors the character strolls between, assign
// each anchor a clip/facing/weight, and save. Floor math is shared with the overlay
// via scene/floor.js, so what you draw here is exactly how it plays.
// ── Scene editor v2 ─────────────────────────────────────────────────────────
// Edits a .scenepack: background (→ wallpaper), perspective floor quad, multiple
// floor-placed foreground props (depth-sorted, optionally animation anchors), and
// anchors (random + timed). New images are inlined as `_dataUrl` on the item and
// `_bgData` on the scene; main writes them to disk on save.
const SE = { scene: null, bgImg: null, fgImgs: {}, sel: null, selKind: null, drag: null, inited: false,
  // Editor layer system: `tool` = what an empty-click places / what's grabbable; `visible`
  // hides layers to declutter; `zoneDraft` = the no-walk polygon being drawn.
  tool: 'select', visible: { floor: true, anchors: true, props: true, lights: true, zones: true, walls: true, doors: true }, zoneDraft: null, wallDraft: null, activeRoom: 0 };

const seRnd = (p) => p + Math.random().toString(36).slice(2, 8);
// ── Scene character binding + per-character size ───────────────────────────────
// The scene names one character (auto-loaded when it plays) and stores that
// character's size in this scene under charScales[filename].
const sceneCharKey = () => (SE.scene?.character || '');
window.sceneCharSelect = (filename) => {
  if (!SE.scene) return;
  SE.scene.character = filename || null;
  refreshCharSizeUI();
};
window.sceneCharSizeEdit = (v) => {
  const s = Math.min(2.5, Math.max(0.3, parseFloat(v) || 1));
  const lb = $('charsize-lbl'); if (lb) lb.textContent = s.toFixed(2);
  if (!SE.scene) return;
  const k = sceneCharKey(); if (!k) return;
  SE.scene.charScales = SE.scene.charScales || {};
  SE.scene.charScales[k] = s;
};
async function populateSceneCharSelect() {
  const sel = $('scene-char-select'); if (!sel) return;
  const chars = await window.deskbuddy.listCharacters();
  sel.innerHTML = '';
  sel.appendChild(new Option('— None (use active character) —', ''));
  chars.forEach(c => sel.appendChild(new Option(c.name, c.filename)));
  sel.value = SE.scene?.character || '';
  refreshCharSizeUI();
}
function refreshCharSizeUI() {
  const sl = $('charsize-slider'), lb = $('charsize-lbl'); if (!sl || !lb) return;
  const k = sceneCharKey();
  const s = (k && SE.scene?.charScales && SE.scene.charScales[k] != null) ? SE.scene.charScales[k] : 1;
  sl.value = s; lb.textContent = (+s).toFixed(2);
  sl.disabled = !k;
  sl.title = k ? '' : 'Pick a character for this scene first';
}

function defaultEditorScene() {
  return {
    version: 2, name: 'My Scene', character: null, background: null, foregrounds: [], charScales: {}, zones: [], walls: [], doors: [],
    floor: { farLeft:{x:0.28,y:0.50}, farRight:{x:0.72,y:0.50}, nearLeft:{x:0.06,y:0.95}, nearRight:{x:0.94,y:0.95} },
    anchors: [], wander: { enabled: true, idleMin: 3, idleMax: 7, walkSpeed: 0.16 },
    // Same {enabled, lights:[…]} shape that loadEditorShadow() produces, so a brand-new
    // scene works with renderShadowLights()/ensureShadow() (which read shadow.lights).
    shadow: loadEditorShadow(),
  };
}
const DEF_LIGHT = () => ({ u: 0.5, v: 0.30, height: 0.7, distance: 1.0, mode: 'directional', angleAdjust: 0, showGlow: true, color: '#ffffff', intensity: 0.35, softness: 0.4 });
function loadEditorShadow(sh) {
  const okHex = (c) => /^#[0-9a-fA-F]{6}$/.test(c || '');
  const mk = (l) => {
    const d = DEF_LIGHT();
    // migrate legacy {angle,length} → floor position
    let u = l?.u, v = l?.v, height = l?.height, distance = l?.distance;
    if (typeof u !== 'number' || typeof v !== 'number') {
      const a = (l?.angle ?? 90) * Math.PI / 180, len = l?.length ?? 0.55;
      u = 0.5 - Math.cos(a) * 0.3; v = 0.5 - Math.sin(a) * 0.3;
      if (typeof height !== 'number') height = Math.max(0.3, 1.2 - len * 0.45);
      if (typeof distance !== 'number') distance = Math.max(0.4, len * 1.6);
    }
    return { u: clampUnit(u), v: clampUnit(v), height: height ?? d.height, distance: distance ?? d.distance,
      mode: l?.mode === 'point' ? 'point' : 'directional',
      angleAdjust: typeof l?.angleAdjust === 'number' ? l.angleAdjust : 0,
      showGlow: l?.showGlow !== false,
      color: okHex(l?.color) ? l.color : d.color,
      intensity: l?.intensity ?? l?.opacity ?? d.intensity, softness: l?.softness ?? d.softness };
  };
  const lights = (Array.isArray(sh?.lights) && sh.lights.length) ? sh.lights.map(mk) : [mk(sh)];
  return { enabled: sh?.enabled !== false, lights };
}
function ensureShadow() { SE.scene.shadow = SE.scene.shadow || loadEditorShadow(); return SE.scene.shadow; }
window.sceneShadowEnable = (v) => { if (SE.scene) { ensureShadow().enabled = !!v; drawStage(); } };
window.sceneAddLight = () => {
  if (!SE.scene) return; const sh = ensureShadow();
  if (sh.lights.length >= 6) { setStatus('Up to 6 lights'); return; }
  sh.lights.push({ ...DEF_LIGHT(), u: 0.3 + Math.random() * 0.4, v: 0.2 + Math.random() * 0.3 });
  renderShadowLights(); drawStage();
};
window.sceneRemoveLight = (i) => { ensureShadow().lights.splice(i, 1); renderShadowLights(); drawStage(); };
window.sceneLightEdit = (i, field, value) => {
  const l = SE.scene?.shadow?.lights?.[i]; if (!l) return;
  if (field === 'color' || field === 'mode') { l[field] = value; }
  else if (field === 'showGlow') { l.showGlow = !!value; }
  else {
    l[field] = parseFloat(value);
    const lbl = $(`shl-${i}-${field}-lbl`);
    if (lbl) lbl.textContent = (+l[field]).toFixed(2);
  }
  drawStage();
};

const clampUnit = (n) => Math.min(1, Math.max(0, n));

function renderShadowLights() {
  const box = $('sh-lights'); if (!box) return;
  const sh = SE.scene?.shadow || loadEditorShadow();
  if ($('sh-enabled')) $('sh-enabled').checked = sh.enabled !== false;
  const slider = (i, k, label, min, max, step) =>
    `<div class="field"><label>${label}: <span id="shl-${i}-${k}-lbl">${(+sh.lights[i][k]).toFixed(2)}</span></label>
      <input id="shl-${i}-${k}" type="range" min="${min}" max="${max}" step="${step}" value="${sh.lights[i][k]}" oninput="sceneLightEdit(${i},'${k}',this.value)"></div>`;
  box.innerHTML = sh.lights.map((l, i) => `
    <div class="sub-card" style="margin-top:8px">
      <div class="sec-head"><h3 style="font-size:11.5px">💡 Light ${i + 1}</h3>
        ${sh.lights.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="sceneRemoveLight(${i})">🗑</button>` : ''}</div>
      <p class="hint" style="margin:2px 0 6px">Drag the ☀ on the floor to place this light. Lower height = longer shadow.</p>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <label style="margin:0;flex:1">Colour <span class="hint">(tints the character)</span></label>
        <input type="color" value="${l.color || '#ffffff'}" oninput="sceneLightEdit(${i},'color',this.value)"
          style="width:34px;height:24px;padding:0;border:1px solid var(--border);border-radius:5px;background:none;cursor:pointer">
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <label style="margin:0;flex:1">Type</label>
        <select onchange="sceneLightEdit(${i},'mode',this.value)" style="flex:1">
          <option value="directional" ${l.mode !== 'point' ? 'selected' : ''}>Directional (far)</option>
          <option value="point" ${l.mode === 'point' ? 'selected' : ''}>Point (glows all around)</option>
        </select>
      </div>
      <label class="check" style="display:flex;align-items:center;gap:6px;margin:2px 0 6px;font-size:11px;color:var(--muted)">
        <input type="checkbox" ${l.showGlow !== false ? 'checked' : ''} onchange="sceneLightEdit(${i},'showGlow',this.checked)">
        Show light glow <span class="hint">(off still lights &amp; casts shadow)</span></label>
      ${slider(i, 'height', 'Height', 0.05, 3, 0.05)}
      ${slider(i, 'distance', 'Distance / throw', 0.1, 4, 0.05)}
      ${slider(i, 'angleAdjust', 'Shadow angle fine-tune (°)', -180, 180, 5)}
      ${slider(i, 'intensity', 'Intensity', 0, 1, 0.02)}
      ${slider(i, 'softness', 'Softness', 0, 1, 0.05)}
    </div>`).join('');
  if (typeof attachPrecisionInputs === 'function') attachPrecisionInputs(box);   // precision boxes on the new sliders
}
function newAnchor(u, v) {
  return { id: seRnd('a'), label: 'Anchor ' + ((SE.scene.anchors?.length || 0) + 1),
    u, v, facing: 'auto', animation: null, offset: { x: 0, y: 0 }, weight: 1, repeatMinutes: 0, dwell: 0 };
}
function newForeground(u, v) {
  return { id: seRnd('f'), label: 'Prop ' + ((SE.scene.foregrounds?.length || 0) + 1),
    image: null, u, v, scale: 1, fullscreen: false, layer: 0,
    anchor: { enabled: false, animation: null, facing: 'auto', offset: { x: 0, y: 0 }, repeatMinutes: 0, dwell: 0 } };
}
function newDoor(u, v) { return { id: seRnd('dr'), u, v }; }
const findAnchor = (id) => SE.scene.anchors.find(a => a.id === id);
const findFg = (id) => SE.scene.foregrounds.find(f => f.id === id);
const findDoor = (id) => (SE.scene.doors || []).find(d => d.id === id);

const seClamp01 = (v) => Math.min(1, Math.max(0, v));
function seDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
// The stage shows a margin AROUND the wallpaper image so floor-quad corners can be
// dragged outside the image (e.g. a near edge that runs off-screen). The image
// occupies floor coords 0..1; the canvas spans floor coords [-PAD, 1+PAD].
const STAGE_PAD = 0.2;
// Scroll-to-zoom view transform (cursor-centred). zoom<1 = zoomed out (drag corners far
// outside the image); zoom>1 = zoomed in for precise placement. Reset with the button.
let view = { zoom: 1, panX: 0, panY: 0 };
const baseFrac = (n) => (n + STAGE_PAD) / (1 + 2 * STAGE_PAD);   // floor coord → base 0..1
const sxFrac = (n) => 0.5 + (baseFrac(n) - 0.5) * view.zoom + view.panX;
const syFrac = (n) => 0.5 + (baseFrac(n) - 0.5) * view.zoom + view.panY;
const nxFrac = (fr) => ((fr - 0.5 - view.panX) / view.zoom + 0.5) * (1 + 2 * STAGE_PAD) - STAGE_PAD;
const nyFrac = (fr) => ((fr - 0.5 - view.panY) / view.zoom + 0.5) * (1 + 2 * STAGE_PAD) - STAGE_PAD;
const PXx = (n, W) => sxFrac(n) * W;
const PXy = (n, H) => syFrac(n) * H;
function seStageXY(e) {
  const cv = $('scene-stage'), r = cv.getBoundingClientRect();
  // Canvas fraction 0..1 maps (through zoom/pan) to floor coords — a dragged corner can
  // leave the image but stays visible and grabbable.
  return { x: nxFrac(seClamp01((e.clientX - r.left) / r.width)), y: nyFrac(seClamp01((e.clientY - r.top) / r.height)) };
}
function seResetView() { view = { zoom: 1, panX: 0, panY: 0 }; if ($('scene-stage')) drawStage(); }
window.seResetView = seResetView;

// Give every settings slider a synced number box so you can type ANY value (the slider's
// range auto-widens to accept it). Scans ALL range sliders (incl. dynamically-built shadow
// light sliders). Idempotent — safe to call repeatedly after any UI rebuild.
function attachPrecisionInputs(root) {
  const sliders = (root || document).querySelectorAll('input[type="range"]');
  for (const sl of sliders) {
    if (sl._precAttached) continue;
    sl._precAttached = true;
    sl.step = 'any';   // continuous — so a typed value like 1.3242 isn't rounded to the slider's step
    const box = document.createElement('input');
    box.type = 'number'; box.step = 'any';   // accept any decimal (no step validation)
    box.value = sl.value;
    box.style.cssText = 'width:66px;margin-left:8px;padding:3px 6px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;vertical-align:middle';
    box.addEventListener('input', () => {
      const v = parseFloat(box.value); if (!isFinite(v)) return;
      if (v < parseFloat(sl.min)) sl.min = v;       // widen the range to accept any number (e.g. 8)
      if (v > parseFloat(sl.max)) sl.max = v;
      sl.value = v;
      sl.dispatchEvent(new Event('input', { bubbles: true }));   // fire the slider's own handler
    });
    // Only mirror slider→box while the user is dragging the SLIDER (not when they're typing),
    // so typing a precise value never gets snapped back.
    sl.addEventListener('input', (e) => { if (e.isTrusted) box.value = (+sl.value).toString(); });
    sl.insertAdjacentElement('afterend', box);
  }
}
window.attachPrecisionInputs = attachPrecisionInputs;

// ── Editor tools + layer visibility + no-walk zone drawing ────────────────────
const toolLayer = (t) => ({ floor: 'floor', anchor: 'anchors', prop: 'props', light: 'lights', zone: 'zones', wall: 'walls', door: 'doors' }[t] || null);
function seToolHint(t) {
  return ({
    select: 'Select: click an item to pick it (settings on the left), drag to move, press X to delete · middle-drag to pan',
    floor: 'Floor: drag the 4 corners — scroll to zoom out and place them far outside the image',
    anchor: 'Anchor: click empty floor to add a stroll point; drag to move',
    prop: 'Prop: click to drop a prop, then set its image in the Props list below',
    light: 'Light: drag the ☀ on the floor (lower = longer shadow)',
    zone: 'No-walk: click to add corners around an area the character must avoid, then ✓ Finish (click the first point to close)',
    wall: 'Wall: click two floor points for the base — the character walks around it and casts a shadow on it. Drag ◆ ends to move, ▲ to set height.',
    door: 'Door: click the floor to mark where the character ENTERS this screen — it walks in via the door when crossing between screens.',
  })[t] || '';
}
// Wall in the editor: a base segment on the floor raised vertically by `height`. Returns
// the raised (top) screen point for a base point (floor-screen 0..1 space).
function wallTopScreen(f, base, height) {
  const s = floorToScreen(f, base.x, base.y);
  return { x: s.x, y: s.y - height * depthScaleAt(f, base.y) * 0.45 };
}
window.seSetTool = (t) => {
  if (SE.tool === 'zone' && t !== 'zone') { commitZoneDraft(); }   // leaving zone tool commits a finished draft
  SE.tool = t; SE.sel = null; SE.selKind = null;
  document.querySelectorAll('.se-tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  if ($('se-zone-finish')) $('se-zone-finish').style.display = (t === 'zone' && SE.zoneDraft && SE.zoneDraft.length) ? '' : (t === 'zone' ? 'none' : 'none');
  const layer = toolLayer(t);
  if (layer && !SE.visible[layer]) { SE.visible[layer] = true; refreshEyes(); }
  setStatus(seToolHint(t));
  drawStage();
};
function refreshEyes() {
  document.querySelectorAll('.se-eye[data-eye]').forEach(b => b.classList.toggle('off', !SE.visible[b.dataset.eye]));
}
window.seToggleEye = (layer) => { SE.visible[layer] = !SE.visible[layer]; refreshEyes(); drawStage(); };
function commitZoneDraft() {
  if (SE.zoneDraft && SE.zoneDraft.length >= 3) {
    SE.scene.zones = SE.scene.zones || [];
    SE.scene.zones.push({ id: seRnd('z'), points: SE.zoneDraft.map(p => ({ x: p.x, y: p.y })) });
    setStatus('No-walk zone added — the character will walk around it');
  }
  SE.zoneDraft = null;
  if ($('se-zone-finish')) $('se-zone-finish').style.display = 'none';
}
window.seFinishZone = () => { commitZoneDraft(); drawStage(); };
window.seClearZones = () => { SE.scene.zones = []; SE.zoneDraft = null; drawStage(); setStatus('No-walk zones cleared'); };

function drawStage() {
  const cv = $('scene-stage'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  // Margin backdrop (area OUTSIDE the wallpaper) so it's clear when a corner is
  // dragged past the image edges.
  ctx.fillStyle = '#07070d'; ctx.fillRect(0, 0, W, H);
  const ix = PXx(0, W), iy = PXy(0, H), iw = PXx(1, W) - ix, ih = PXy(1, H) - iy;
  if (SE.bgImg) ctx.drawImage(SE.bgImg, ix, iy, iw, ih);
  else { const g = ctx.createLinearGradient(0, iy, 0, iy + ih); g.addColorStop(0, '#241f38'); g.addColorStop(0.6, '#b78b6a'); g.addColorStop(1, '#2e2536'); ctx.fillStyle = g; ctx.fillRect(ix, iy, iw, ih); }
  // Frame marking the true image bounds (what becomes the wallpaper).
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
  ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1); ctx.setLineDash([]);
  const f = SE.scene.floor;
  const dim = (layer) => SE.tool !== 'select' && toolLayer(SE.tool) !== layer ? 0.45 : 1;   // fade inactive layers
  // floor quad
  if (SE.visible.floor) {
    ctx.globalAlpha = dim('floor');
    const ring = [f.farLeft, f.farRight, f.nearRight, f.nearLeft];
    ctx.strokeStyle = 'rgba(99,102,241,0.9)'; ctx.lineWidth = 2; ctx.beginPath();
    ring.forEach((p, i) => { const x = PXx(p.x, W), y = PXy(p.y, H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fillStyle = 'rgba(99,102,241,0.10)'; ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // no-walk zones (red) + the in-progress draft
  if (SE.visible.zones) {
    ctx.globalAlpha = dim('zones');
    const drawPoly = (pts, fill, stroke, open, handles) => {
      if (!pts.length) return;
      const S = pts.map(p => floorToScreen(f, p.x, p.y));   // zone points are floor (u,v)
      ctx.beginPath();
      S.forEach((s, i) => { const x = PXx(s.x, W), y = PXy(s.y, H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (!open) ctx.closePath();
      ctx.fillStyle = fill; if (!open) ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();
      if (handles) S.forEach(s => { const x = PXx(s.x, W), y = PXy(s.y, H); ctx.fillStyle = '#ef4444'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.rect(x - 4, y - 4, 8, 8); ctx.fill(); ctx.stroke(); });
    };
    (SE.scene.zones || []).forEach(z => {
      const sel = z.id === SE.sel && SE.selKind === 'zone';
      drawPoly(z.points, sel ? 'rgba(245,158,11,0.22)' : 'rgba(239,68,68,0.22)', sel ? '#f59e0b' : 'rgba(239,68,68,0.9)', false, SE.tool === 'zone' || sel);
    });
    if (SE.zoneDraft && SE.zoneDraft.length) drawPoly(SE.zoneDraft, 'rgba(239,68,68,0.15)', 'rgba(239,68,68,0.8)', true, true);
    ctx.globalAlpha = 1;
  }
  // walls (vertical surfaces) — translucent quad rising from the base, with ◆ end + ▲ height handles
  if (SE.visible.walls) {
    ctx.globalAlpha = dim('walls');
    const drawWall = (w, draftEnd, sel) => {
      const b0 = w.base[0], b1 = draftEnd || w.base[1];
      const s0 = floorToScreen(f, b0.x, b0.y), s1 = floorToScreen(f, b1.x, b1.y);
      const t0 = wallTopScreen(f, b0, w.height), t1 = wallTopScreen(f, b1, w.height);
      const P = (s) => [PXx(s.x, W), PXy(s.y, H)];
      const [bx0, by0] = P(s0), [bx1, by1] = P(s1), [tx0, ty0] = P(t0), [tx1, ty1] = P(t1);
      ctx.beginPath(); ctx.moveTo(bx0, by0); ctx.lineTo(bx1, by1); ctx.lineTo(tx1, ty1); ctx.lineTo(tx0, ty0); ctx.closePath();
      ctx.fillStyle = sel ? 'rgba(245,158,11,0.30)' : 'rgba(148,163,184,0.28)'; ctx.fill();
      ctx.strokeStyle = sel ? '#f59e0b' : 'rgba(203,213,225,0.95)'; ctx.lineWidth = sel ? 2.5 : 2; ctx.stroke();
      // base line bolder
      ctx.beginPath(); ctx.moveTo(bx0, by0); ctx.lineTo(bx1, by1); ctx.strokeStyle = sel ? '#f59e0b' : '#cbd5e1'; ctx.lineWidth = 3; ctx.stroke();
      if ((SE.tool === 'wall' || sel) && !draftEnd) {
        [[bx0, by0], [bx1, by1]].forEach(([x, y]) => { ctx.fillStyle = '#cbd5e1'; ctx.strokeStyle = '#0d0d12'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill(); ctx.stroke(); });
        const mx = (tx0 + tx1) / 2, my = (ty0 + ty1) / 2;   // ▲ height handle
        ctx.fillStyle = '#38bdf8'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(mx, my - 6); ctx.lineTo(mx + 6, my + 5); ctx.lineTo(mx - 6, my + 5); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    };
    (SE.scene.walls || []).forEach(w => drawWall(w, null, w.id === SE.sel && SE.selKind === 'wall'));
    ctx.globalAlpha = 1;
  }
  // foreground props (farther first so nearer ones overlap)
  if (SE.visible.props) { ctx.globalAlpha = dim('props'); (SE.scene.foregrounds || []).slice().sort((a, b) => a.v - b.v).forEach(it => drawFgItem(ctx, it, W, H)); ctx.globalAlpha = 1; }
  // floor corner handles
  if (SE.visible.floor) {
    ctx.globalAlpha = dim('floor');
    [f.farLeft, f.farRight, f.nearLeft, f.nearRight].forEach(p => {
      const x = PXx(p.x, W), y = PXy(p.y, H);
      ctx.fillStyle = '#6366f1'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }
  // anchors
  if (SE.visible.anchors) {
    ctx.globalAlpha = dim('anchors');
    SE.scene.anchors.forEach(a => {
      const s = floorToScreen(f, a.u, a.v), x = PXx(s.x, W), y = PXy(s.y, H);
      const seld = a.id === SE.sel && SE.selKind === 'anchor';
      ctx.fillStyle = seld ? '#f59e0b' : (a.repeatMinutes > 0 ? '#38bdf8' : '#22c55e');
      ctx.beginPath(); ctx.arc(x, y, seld ? 7 : 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0d0d12'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(a.label || '', x, y - 10);
    });
    ctx.globalAlpha = 1;
  }
  // doors (entry markers) — a little green doorway standing on its floor point
  if (SE.visible.doors) {
    ctx.globalAlpha = dim('doors');
    (SE.scene.doors || []).forEach(d => {
      const s = floorToScreen(f, d.u, d.v), x = PXx(s.x, W), y = PXy(s.y, H);
      const sel = d.id === SE.sel && SE.selKind === 'door';
      const w = 13, h = 21;
      ctx.fillStyle = sel ? 'rgba(245,158,11,0.85)' : 'rgba(52,211,153,0.85)';
      ctx.strokeStyle = '#0d0d12'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(x - w / 2, y - h, w, h); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0d0d12'; ctx.beginPath(); ctx.arc(x + w / 4, y - h / 2, 1.8, 0, Math.PI * 2); ctx.fill();   // knob
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Door', x, y - h - 4);
    });
    ctx.globalAlpha = 1;
  }
  // light handles (draggable ☀) — drawn last so they sit on top and stay grabbable
  if (SE.visible.lights) {
    ctx.globalAlpha = dim('lights');
    const sh = SE.scene.shadow;
    if (sh?.enabled && Array.isArray(sh.lights)) sh.lights.forEach((L, i) => drawLightHandle(ctx, L, i, W, H));
    ctx.globalAlpha = 1;
  }
}

const hexA = (hex, a) => {
  const h = (hex || '#ffffff').replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};
// The light's glowing orb sits ABOVE its floor base by `height`, scaled by the floor
// perspective so a light deeper in the scene rides lower on screen. Returns the orb
// position in image-space (0..1, matching floor coords) for hit-testing.
function lightOrbPos(L) {
  const f = SE.scene.floor;
  const base = floorToScreen(f, L.u, L.v);
  const poleImg = (L.height || 0) * depthScaleAt(f, L.v) * 0.5 * (1 + 2 * STAGE_PAD);
  return { x: base.x, y: base.y - poleImg, base };
}
// A light: a floor base marker, a pole up to a glowing orb, with a coloured halo.
function drawLightHandle(ctx, L, i, W, H) {
  const o = lightOrbPos(L);
  const bx = PXx(o.base.x, W), by = PXy(o.base.y, H);
  const ox = PXx(o.x, W), oy = PXy(o.y, H);
  // glow halo
  const r = 8 + (L.intensity || 0) * 12;
  const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, r * 2.4);
  grad.addColorStop(0, hexA(L.color, 0.95)); grad.addColorStop(0.4, hexA(L.color, 0.45)); grad.addColorStop(1, hexA(L.color, 0));
  ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(ox, oy, r * 2.4, 0, Math.PI * 2); ctx.fill();
  // pole from base to orb
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ox, oy); ctx.stroke(); ctx.setLineDash([]);
  // base marker on the floor
  ctx.fillStyle = L.color || '#ffffff'; ctx.strokeStyle = '#0d0d12'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(bx, by, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // orb
  ctx.beginPath(); ctx.arc(ox, oy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (L.mode === 'point') { ctx.strokeStyle = hexA(L.color, 0.8); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(ox, oy, 11, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = '#0d0d12'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(i + 1), ox, oy + 0.5); ctx.textBaseline = 'alphabetic';
}

function drawFgItem(ctx, it, W, H) {
  const f = SE.scene.floor;
  const img = SE.fgImgs[it.id];
  const ix = PXx(0, W), iy = PXy(0, H), iw = PXx(1, W) - ix, ih = PXy(1, H) - iy;
  let x, y, w, h;
  if (it.fullscreen) { x = ix; y = iy; w = iw; h = ih; }   // fills the image, not the margin
  else {
    const sp = floorToScreen(f, it.u, it.v);
    const ar = (img && img.width) ? img.width / img.height : 1;
    // Match the overlay EXACTLY: prop height = FG_BASE_HEIGHT(1.5)/2 of the screen
    // height × scale × depth, so the editor preview reflects the real placement & size.
    h = Math.max(6, depthScaleAt(f, it.v) * (it.scale || 1) * ih * 0.75);
    w = h * ar; x = PXx(sp.x, W) - w / 2; y = PXy(sp.y, H) - h;
  }
  if (img) { ctx.globalAlpha = it.fullscreen ? 0.4 : 0.95; ctx.drawImage(img, x, y, w, h); ctx.globalAlpha = 1; }
  else { ctx.fillStyle = 'rgba(168,85,247,0.22)'; ctx.fillRect(x, y, w, h); }
  const seld = it.id === SE.sel && SE.selKind === 'fg';
  ctx.strokeStyle = seld ? '#f59e0b' : (it.anchor?.enabled ? '#c084fc' : 'rgba(168,85,247,0.65)');
  ctx.lineWidth = seld ? 2.5 : 1.4;
  ctx.setLineDash(it.anchor?.enabled ? [] : [4, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  if (!it.fullscreen) {   // base handle on the floor
    const sp = floorToScreen(f, it.u, it.v);
    ctx.fillStyle = it.anchor?.enabled ? '#c084fc' : '#8b8b9a';
    ctx.beginPath(); ctx.arc(PXx(sp.x, W), PXy(sp.y, H), 4, 0, Math.PI * 2); ctx.fill();
  }
}

// Find a draggable handle under point p (image-space). In Select mode every layer is
// grabbable; with a specific tool only that layer is. Returns a drag descriptor or null.
function grabHandle(p, f, t) {
  const can = (layer) => (t === 'select' || toolLayer(t) === layer) && SE.visible[layer];
  if (can('lights')) {
    const sh = SE.scene.shadow;
    if (sh?.enabled && Array.isArray(sh.lights)) {
      for (let i = 0; i < sh.lights.length; i++) {
        const L = sh.lights[i], o = lightOrbPos(L);
        // Grab the orb OR its floor base; remember the floor-space offset so the light
        // follows the cursor 1:1 (no pole-feedback "magnet" snapping it to the edges).
        if (seDist(p, o) < 0.07 || seDist(p, o.base) < 0.08) {
          const uv = screenToFloor(f, p.x, p.y);
          return { type: 'light', idx: i, du: L.u - uv.u, dv: L.v - uv.v };
        }
      }
    }
  }
  if (can('floor')) {
    for (const k of ['farLeft', 'farRight', 'nearLeft', 'nearRight'])
      if (seDist(p, f[k]) < 0.05) return { type: 'corner', key: k };
  }
  if (can('walls')) {
    const ws = SE.scene.walls || [];
    for (let wi = 0; wi < ws.length; wi++) {
      const w = ws[wi], mid = { x: (w.base[0].x + w.base[1].x) / 2, y: (w.base[0].y + w.base[1].y) / 2 };
      if (seDist(p, wallTopScreen(f, mid, w.height)) < 0.04) return { type: 'wallh', wi, id: w.id };
      for (let pi = 0; pi < 2; pi++) if (seDist(p, floorToScreen(f, w.base[pi].x, w.base[pi].y)) < 0.04) return { type: 'wallpt', wi, pi, id: w.id };
    }
  }
  if (can('zones')) {
    const zs = SE.scene.zones || [];
    for (let zi = 0; zi < zs.length; zi++) for (let pi = 0; pi < zs[zi].points.length; pi++)
      if (seDist(p, floorToScreen(f, zs[zi].points[pi].x, zs[zi].points[pi].y)) < 0.035) return { type: 'zonept', zi, pi, id: zs[zi].id };
  }
  if (can('props')) {
    const fgs = (SE.scene.foregrounds || []).filter(x => !x.fullscreen).slice().sort((a, b) => b.v - a.v);
    for (const it of fgs) if (seDist(p, floorToScreen(f, it.u, it.v)) < 0.06) return { type: 'fg', id: it.id };
  }
  if (can('anchors')) {
    for (const a of SE.scene.anchors) if (seDist(p, floorToScreen(f, a.u, a.v)) < 0.05) return { type: 'anchor', id: a.id };
  }
  if (can('doors')) {
    for (const dr of (SE.scene.doors || [])) if (seDist(p, floorToScreen(f, dr.u, dr.v)) < 0.05) return { type: 'door', id: dr.id };
  }
  return null;
}
// Sync the inspector selection to whatever handle was grabbed.
function applyHandleSelection(g) {
  if (g.type === 'fg') selectFg(g.id);
  else if (g.type === 'anchor') selectAnchor(g.id);
  else if (g.type === 'wallpt' || g.type === 'wallh') selectWall(g.id);
  else if (g.type === 'zonept') selectZone(g.id);
  else if (g.type === 'door') selectDoor(g.id);
  else { SE.sel = null; SE.selKind = null; clearSelUI(); drawStage(); }   // light/corner: no card
}
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}
function wallBodyHit(p, f) {
  if (!SE.visible.walls) return null;
  const ws = SE.scene.walls || [];
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i];
    const b0 = floorToScreen(f, w.base[0].x, w.base[0].y), b1 = floorToScreen(f, w.base[1].x, w.base[1].y);
    const t0 = wallTopScreen(f, w.base[0], w.height), t1 = wallTopScreen(f, w.base[1], w.height);
    if (pointInPoly(p, [b0, b1, t1, t0])) return w.id;
  }
  return null;
}
function zoneAreaHit(p, f) {
  if (!SE.visible.zones) return null;
  const zs = SE.scene.zones || [];
  for (let i = zs.length - 1; i >= 0; i--) {
    const pts = zs[i].points.map(q => floorToScreen(f, q.x, q.y));
    if (pts.length >= 3 && pointInPoly(p, pts)) return zs[i].id;
  }
  return null;
}
function sceneDeleteSelected() {
  if (!SE.selKind) return false;
  if (SE.selKind === 'fg') sceneFgDelete();
  else if (SE.selKind === 'anchor') sceneAnchorDelete();
  else if (SE.selKind === 'wall') sceneWallDelete();
  else if (SE.selKind === 'zone') sceneZoneDelete();
  else if (SE.selKind === 'door') sceneDoorDelete();
  else return false;
  return true;
}

function seInitStage() {
  if (SE.inited) return; SE.inited = true;
  const cv = $('scene-stage');
  // Scroll to zoom (cursor-centred): scroll down = zoom out (place the perspective box /
  // anchors far outside the image), scroll up = zoom in for precise work.
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const fx = seClamp01((e.clientX - r.left) / r.width), fy = seClamp01((e.clientY - r.top) / r.height);
    const uAtCursor = nxFrac(fx), vAtCursor = nyFrac(fy);
    view.zoom = Math.max(0.2, Math.min(6, view.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    // keep the floor point under the cursor fixed
    view.panX = fx - 0.5 - (baseFrac(uAtCursor) - 0.5) * view.zoom;
    view.panY = fy - 0.5 - (baseFrac(vAtCursor) - 0.5) * view.zoom;
    drawStage();
  }, { passive: false });
  cv.addEventListener('pointerdown', (e) => {
    // Middle (scroll) click → pan the canvas around (left-click stays for select/add).
    if (e.button === 1) {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      const r = cv.getBoundingClientRect();
      SE.pan = { sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY, w: r.width, h: r.height };
      return;
    }
    if (e.button !== 0) return;   // only left button selects / adds
    cv.setPointerCapture(e.pointerId);
    const p = seStageXY(e), f = SE.scene.floor, t = SE.tool;

    // Grab a draggable handle first — works in Select mode for every layer, or within a
    // layer's own tool. This is how you MOVE things; placing new items only happens on an
    // empty click in that item's Add tool (so Select mode never drops things by accident).
    const g = grabHandle(p, f, t);
    if (g) { SE.drag = g; applyHandleSelection(g); return; }

    // ── Empty click, per tool ──
    if (t === 'select') {
      // Pick a wall body or zone area; empty space clears the selection. Never places.
      const wid = wallBodyHit(p, f); if (wid) { selectWall(wid); return; }
      const zid = zoneAreaHit(p, f); if (zid) { selectZone(zid); return; }
      SE.sel = null; SE.selKind = null; clearSelUI(); drawStage();
      return;
    }
    if (t === 'floor') return;   // floor only drags corners (handled by grabHandle)
    const uv = screenToFloor(f, p.x, p.y);
    if (t === 'anchor') { const a = newAnchor(uv.u, uv.v); SE.scene.anchors.push(a); selectAnchor(a.id); drawStage(); return; }
    if (t === 'prop')   { const it = newForeground(uv.u, uv.v); SE.scene.foregrounds.push(it); selectFg(it.id); refreshFgUI(); drawStage(); return; }
    if (t === 'light')  {
      const sh = ensureShadow(); if (sh.lights.length >= 6) { setStatus('Up to 6 lights'); return; }
      sh.lights.push({ ...DEF_LIGHT(), u: clampUnit(uv.u), v: clampUnit(uv.v) });
      renderShadowLights(); drawStage(); return;
    }
    if (t === 'door')   { const dr = newDoor(uv.u, uv.v); SE.scene.doors = SE.scene.doors || []; SE.scene.doors.push(dr); selectDoor(dr.id); refreshDoorUI(); drawStage(); return; }
    // No-walk zone: click to add polygon points; click the first point (≥3 pts) to close.
    if (t === 'zone') {
      if (!SE.zoneDraft) SE.zoneDraft = [];
      if (SE.zoneDraft.length >= 3 && seDist(p, floorToScreen(f, SE.zoneDraft[0].x, SE.zoneDraft[0].y)) < 0.04) { commitZoneDraft(); refreshZoneUI(); drawStage(); return; }
      SE.zoneDraft.push({ x: uv.u, y: uv.v }); if ($('se-zone-finish')) $('se-zone-finish').style.display = ''; drawStage(); return;
    }
    // Wall: first click sets one base end, second click drops the wall.
    if (t === 'wall') {
      if (!SE.wallDraft) { SE.wallDraft = { x: uv.u, y: uv.v }; drawStage(); return; }
      SE.scene.walls = SE.scene.walls || [];
      const w = { id: seRnd('w'), base: [{ x: SE.wallDraft.x, y: SE.wallDraft.y }, { x: uv.u, y: uv.v }], height: 0.45 };
      SE.scene.walls.push(w); SE.wallDraft = null;
      selectWall(w.id); refreshWallUI();
      setStatus('Wall added — drag ◆ ends / ▲ height, or Select it to set height & delete'); drawStage(); return;
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (SE.pan) {   // middle-drag pan
      view.panX = SE.pan.px + (e.clientX - SE.pan.sx) / SE.pan.w;
      view.panY = SE.pan.py + (e.clientY - SE.pan.sy) / SE.pan.h;
      drawStage(); return;
    }
    if (!SE.drag) return;
    const p = seStageXY(e), f = SE.scene.floor;
    if (SE.drag.type === 'corner') f[SE.drag.key] = { x: p.x, y: p.y };
    else if (SE.drag.type === 'zonept') { const z = SE.scene.zones?.[SE.drag.zi]; if (z && z.points[SE.drag.pi]) { const uv = screenToFloor(f, p.x, p.y); z.points[SE.drag.pi] = { x: uv.u, y: uv.v }; } }
    else if (SE.drag.type === 'wallpt') { const w = SE.scene.walls?.[SE.drag.wi]; if (w) { const uv = screenToFloor(f, p.x, p.y); w.base[SE.drag.pi] = { x: uv.u, y: uv.v }; } }
    else if (SE.drag.type === 'wallh') { const w = SE.scene.walls?.[SE.drag.wi]; if (w) { const mid = { x: (w.base[0].x + w.base[1].x) / 2, y: (w.base[0].y + w.base[1].y) / 2 }; const midS = floorToScreen(f, mid.x, mid.y); w.height = Math.max(0.05, Math.min(10, (midS.y - p.y) / (depthScaleAt(f, mid.y) * 0.45))); if (SE.selKind === 'wall' && SE.sel === w.id) refreshWallUI(); } }
    else if (SE.drag.type === 'light') { const L = SE.scene.shadow?.lights?.[SE.drag.idx]; if (L) { const uv = screenToFloor(f, p.x, p.y); L.u = clampUnit(uv.u + (SE.drag.du || 0)); L.v = clampUnit(uv.v + (SE.drag.dv || 0)); } }
    else if (SE.drag.type === 'anchor') { const a = findAnchor(SE.drag.id); if (a) { const uv = screenToFloor(f, p.x, p.y); a.u = uv.u; a.v = uv.v; } }
    else if (SE.drag.type === 'fg') { const it = findFg(SE.drag.id); if (it) { const uv = screenToFloor(f, p.x, p.y); it.u = uv.u; it.v = uv.v; } }
    else if (SE.drag.type === 'door') { const dr = findDoor(SE.drag.id); if (dr) { const uv = screenToFloor(f, p.x, p.y); dr.u = uv.u; dr.v = uv.v; } }
    drawStage();
  });
  cv.addEventListener('pointerup', () => { SE.drag = null; SE.pan = null; });
  // Don't let middle-click open the browser autoscroll puck.
  cv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sceneStageSetFs(false); return; }
    // 'x' (or Delete) removes the selected item — ignored while typing in a field.
    if (e.key === 'x' || e.key === 'X' || e.key === 'Delete') {
      const ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
      const editing = $('scene-stage-wrap')?.classList.contains('fs') || $('tab-scene')?.style.display !== 'none';
      if (editing && sceneDeleteSelected()) e.preventDefault();
    }
  });
}

// Fullscreen editing: blow the stage up to fill the window for precise corner/anchor
// work, and bump the canvas backing resolution so it stays crisp. Hit-testing is in
// normalized floor space, so it works identically at any display size.
const STAGE_RES = { normal: [560, 315], full: [1280, 720] };
const FS_INSPECTOR_W = 356;   // left inspector width reserved from the stage in fullscreen
function fsStageW() { return Math.max(700, Math.min(2400, Math.round(window.innerWidth - 60 - FS_INSPECTOR_W))); }
function fsStageH() { return Math.max(480, Math.min(1300, Math.round(window.innerHeight - 110))); }
let _fsMovedSections = null;
function sceneStageSetFs(on) {
  const wrap = $('scene-stage-wrap'), cv = $('scene-stage'); if (!wrap || !cv) return;
  if (wrap.classList.contains('fs') === on) return;
  wrap.classList.toggle('fs', on);
  // Move every editor section (all but the Scene Builder / stage section) into the
  // fullscreen left inspector and back, so item settings + add/delete are reachable in
  // fullscreen. The nodes keep their ids and handlers, so all existing logic still works.
  const insp = $('se-fs-inspector'), tab = $('tab-scene');
  if (insp && tab) {
    if (on) {
      _fsMovedSections = Array.from(tab.children).filter(el => el.classList.contains('section') && !el.contains(wrap));
      _fsMovedSections.forEach(el => insp.appendChild(el));
      insp.classList.add('on');
    } else {
      if (_fsMovedSections) { _fsMovedSections.forEach(el => tab.appendChild(el)); _fsMovedSections = null; }
      insp.classList.remove('on');
    }
  }
  if (on) {   // size the canvas to the window (minus the inspector) so it's big & crisp
    cv.width = fsStageW(); cv.height = fsStageH();
  } else { cv.width = STAGE_RES.normal[0]; cv.height = STAGE_RES.normal[1]; }
  drawStage();
}
// Keep the fullscreen stage matched to the window as it resizes/maximizes.
window.addEventListener('resize', () => {
  const wrap = $('scene-stage-wrap'), cv = $('scene-stage');
  if (wrap && wrap.classList.contains('fs') && cv) {
    cv.width = fsStageW(); cv.height = fsStageH();
    drawStage();
  }
});
window.sceneStageToggleFs = () => sceneStageSetFs(!$('scene-stage-wrap')?.classList.contains('fs'));

// In fullscreen, bring the just-shown settings card into view in the left inspector.
function seScrollEditIntoView(id) {
  const insp = $('se-fs-inspector');
  if (!insp || !insp.classList.contains('on')) return;
  const el = $(id);
  if (el && el.style.display !== 'none') el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearSelUI() { refreshAnchorUI(); refreshFgUI(); refreshWallUI(); refreshZoneUI(); refreshDoorUI(); }
function selectAnchor(id) { SE.sel = id; SE.selKind = 'anchor'; clearSelUI(); drawStage(); seScrollEditIntoView('scene-anchor-edit'); }
function selectFg(id) { SE.sel = id; SE.selKind = 'fg'; clearSelUI(); drawStage(); seScrollEditIntoView('scene-fg-edit'); }
function selectWall(id) { SE.sel = id; SE.selKind = 'wall'; clearSelUI(); drawStage(); seScrollEditIntoView('scene-wall-edit'); }
function selectZone(id) { SE.sel = id; SE.selKind = 'zone'; clearSelUI(); drawStage(); seScrollEditIntoView('scene-zone-edit'); }
const findWall = (id) => (SE.scene.walls || []).find(w => w.id === id);
const findZone = (id) => (SE.scene.zones || []).find(z => z.id === id);

// ── Walls UI ──
function refreshWallUI() {
  const list = $('scene-wall-list'); if (!list) return;
  list.innerHTML = '';
  const ws = SE.scene.walls || [];
  if (!ws.length) list.textContent = 'No walls yet — use the ▥ Wall tool.';
  else ws.forEach((w, i) => list.appendChild(chip('Wall ' + (i + 1), '#cbd5e1', 'h ' + (+w.height).toFixed(2),
    w.id === SE.sel && SE.selKind === 'wall', () => selectWall(w.id))));
  const ed = $('scene-wall-edit'); if (!ed) return;
  const w = (SE.selKind === 'wall') ? findWall(SE.sel) : null;
  if (!w) { ed.style.display = 'none'; return; }
  ed.style.display = 'block';
  $('wall-height').value = w.height; $('wall-height-lbl').textContent = (+w.height).toFixed(2);
}
window.sceneWallEdit = (field, value) => {
  const w = findWall(SE.sel); if (!w) return;
  if (field === 'height') { w.height = Math.max(0.05, Math.min(10, parseFloat(value) || 0.45)); const l = $('wall-height-lbl'); if (l) l.textContent = (+w.height).toFixed(2); }
  drawStage();
};
window.sceneWallDelete = () => {
  const i = (SE.scene.walls || []).findIndex(w => w.id === SE.sel); if (i < 0) return;
  SE.scene.walls.splice(i, 1); SE.sel = null; SE.selKind = null; refreshWallUI(); drawStage(); setStatus('Wall deleted');
};

// ── No-walk zones UI ──
function refreshZoneUI() {
  const list = $('scene-zone-list'); if (!list) return;
  list.innerHTML = '';
  const zs = SE.scene.zones || [];
  if (!zs.length) list.textContent = 'No no-walk zones yet — use the ⬣ No-walk tool.';
  else zs.forEach((z, i) => list.appendChild(chip('Zone ' + (i + 1), '#ef4444', z.points.length + ' pts',
    z.id === SE.sel && SE.selKind === 'zone', () => selectZone(z.id))));
  const ed = $('scene-zone-edit'); if (!ed) return;
  ed.style.display = ((SE.selKind === 'zone') && findZone(SE.sel)) ? 'block' : 'none';
}
window.sceneZoneDelete = () => {
  const i = (SE.scene.zones || []).findIndex(z => z.id === SE.sel); if (i < 0) return;
  SE.scene.zones.splice(i, 1); SE.sel = null; SE.selKind = null; refreshZoneUI(); drawStage(); setStatus('No-walk zone deleted');
};

// ── Doors UI (character entry / cross-screen passage) ──
function selectDoor(id) { SE.sel = id; SE.selKind = 'door'; clearSelUI(); drawStage(); seScrollEditIntoView('scene-door-edit'); }
function refreshDoorUI() {
  const list = $('scene-door-list'); if (!list) return;
  list.innerHTML = '';
  const ds = SE.scene.doors || [];
  if (!ds.length) list.textContent = 'No door yet — use the 🚪 Door tool to set where the character enters.';
  else ds.forEach((d, i) => list.appendChild(chip('Door ' + (i + 1), '#34d399', 'entry',
    d.id === SE.sel && SE.selKind === 'door', () => selectDoor(d.id))));
  const ed = $('scene-door-edit'); if (!ed) return;
  ed.style.display = ((SE.selKind === 'door') && findDoor(SE.sel)) ? 'block' : 'none';
}
window.sceneDoorDelete = () => {
  const i = (SE.scene.doors || []).findIndex(d => d.id === SE.sel); if (i < 0) return;
  SE.scene.doors.splice(i, 1); SE.sel = null; SE.selKind = null; refreshDoorUI(); drawStage(); setStatus('Door deleted');
};

// Animation dropdown: every imported clip (covers "all animations / states").
function seAnimOptions(sel, current) {
  sel.innerHTML = '';
  sel.appendChild(new Option('— Idle pose (default) —', ''));
  allClips.forEach(c => sel.appendChild(new Option(c.name, c.name)));
  sel.value = current || '';
}
function chip(label, dotColor, meta, selected, onClick) {
  const row = document.createElement('div');
  row.className = 'chip' + (selected ? ' sel' : '');
  row.innerHTML = `<span class="dot" style="background:${dotColor}"></span><span>${label}</span>${meta ? `<span class="meta">${meta}</span>` : ''}`;
  row.onclick = onClick;
  return row;
}

// ── Anchors UI ──
function refreshAnchorUI() {
  const list = $('scene-anchor-list');
  list.innerHTML = '';
  if (!SE.scene.anchors.length) list.textContent = 'No anchors yet — click the floor to add one.';
  else SE.scene.anchors.forEach(a => {
    const meta = a.repeatMinutes > 0 ? `⏱ ${a.repeatMinutes}m` : (a.animation ? a.animation : '');
    list.appendChild(chip(a.label || a.id, a.repeatMinutes > 0 ? '#38bdf8' : '#22c55e', meta,
      a.id === SE.sel && SE.selKind === 'anchor', () => selectAnchor(a.id)));
  });
  const ed = $('scene-anchor-edit');
  const a = (SE.selKind === 'anchor') ? findAnchor(SE.sel) : null;
  if (!a) { ed.style.display = 'none'; return; }
  ed.style.display = 'block';
  $('anc-label').value = a.label || '';
  seAnimOptions($('anc-anim'), a.animation);
  $('anc-facing').value = a.facing || 'auto';
  $('anc-weight').value = a.weight ?? 1; $('anc-weight-lbl').textContent = a.weight ?? 1;
  $('anc-repeat').value = a.repeatMinutes ?? 0;
  $('anc-dwell').value = a.dwell ?? 0;
  $('anc-offx').value = a.offset?.x || 0; $('anc-offy').value = a.offset?.y || 0;
}

window.sceneAnchorEdit = (field, value) => {
  const a = findAnchor(SE.sel); if (!a) return;
  if (field === 'label') { a.label = value; refreshAnchorUI(); }
  else if (field === 'animation') { a.animation = value || null; refreshAnchorUI(); }
  else if (field === 'facing') a.facing = value;
  else if (field === 'weight') { a.weight = parseInt(value, 10); $('anc-weight-lbl').textContent = value; }
  else if (field === 'repeat') { a.repeatMinutes = Math.max(0, parseInt(value, 10) || 0); refreshAnchorUI(); }
  else if (field === 'dwell') { a.dwell = Math.max(0, parseInt(value, 10) || 0); }
  else if (field === 'offx') { a.offset = a.offset || { x: 0, y: 0 }; a.offset.x = parseFloat(value) || 0; }
  else if (field === 'offy') { a.offset = a.offset || { x: 0, y: 0 }; a.offset.y = parseFloat(value) || 0; }
  drawStage();
};
window.sceneAnchorDelete = () => {
  SE.scene.anchors = SE.scene.anchors.filter(a => a.id !== SE.sel);
  SE.sel = null; SE.selKind = null; refreshAnchorUI(); drawStage();
};
window.sceneAnchorPreview = () => {
  const a = findAnchor(SE.sel); if (!a) return;
  const clip = allClips.find(c => c.name === (a.animation || savedStateMap.idle));
  if (clip) previewClip(clip, false); else setStatus('No clip to preview (load a character + animations)');
};

// ── Foreground props UI ──
function refreshFgUI() {
  const list = $('scene-fg-list');
  list.innerHTML = '';
  if (!SE.scene.foregrounds.length) list.textContent = 'No props yet — add one above.';
  else SE.scene.foregrounds.forEach(it => {
    const meta = it.anchor?.enabled ? (it.anchor.repeatMinutes > 0 ? `⏱ ${it.anchor.repeatMinutes}m` : '⚓ anchor') : (it.fullscreen ? 'full' : '');
    list.appendChild(chip(it.label || it.id, it.anchor?.enabled ? '#c084fc' : '#8b8b9a', meta,
      it.id === SE.sel && SE.selKind === 'fg', () => selectFg(it.id)));
  });
  const ed = $('scene-fg-edit');
  const it = (SE.selKind === 'fg') ? findFg(SE.sel) : null;
  if (!it) { ed.style.display = 'none'; return; }
  ed.style.display = 'block';
  $('fg-label').value = it.label || '';
  $('fg-scale').value = it.scale ?? 1; $('fg-scale-lbl').textContent = (it.scale ?? 1).toFixed(2);
  $('fg-fullscreen').checked = !!it.fullscreen;
  $('fg-isanchor').checked = !!it.anchor?.enabled;
  $('fg-anchor-fields').style.display = it.anchor?.enabled ? 'block' : 'none';
  seAnimOptions($('fg-anim'), it.anchor?.animation);
  $('fg-facing').value = it.anchor?.facing || 'auto';
  $('fg-offx').value = it.anchor?.offset?.x || 0; $('fg-offy').value = it.anchor?.offset?.y || 0;
  $('fg-repeat').value = it.anchor?.repeatMinutes ?? 0;
  $('fg-dwell').value = it.anchor?.dwell ?? 0;
  renderLayerUI();
}

// ── Layer panel: drag props in front of / behind the character ─────────────────
const seEsc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fgIsFront = (f) => (f.layer || 0) > 0 || ((f.layer || 0) === 0 && (f.v ?? 0.9) > 0.5);
const fgLayerKey = (f) => (f.layer || 0) * 1000 + (f.v ?? 0);   // higher = nearer front
function renderLayerUI() {
  const box = $('scene-layer-list'); if (!box) return;
  const props = SE.scene?.foregrounds || [];
  if (!props.length) { box.innerHTML = '<div class="hint" style="margin:0">No props yet — add one above.</div>'; return; }
  const front = props.filter(fgIsFront).sort((a, b) => fgLayerKey(b) - fgLayerKey(a));
  const behind = props.filter(f => !fgIsFront(f)).sort((a, b) => fgLayerKey(b) - fgLayerKey(a));
  const row = (f, side) => `<div class="layer-row ${side}" draggable="true" data-id="${f.id}"
      ondragstart="layerDragStart(event,'${f.id}')" ondragend="layerDragEnd(event)"
      ondragover="layerDragOver(event)" ondragleave="layerDragLeave(event)" ondrop="layerDrop(event,'${f.id}')">
      <span class="grip">≡</span><span class="lname">${seEsc(f.label || 'Prop')}</span>
      <span class="lpos">${side}</span></div>`;
  box.innerHTML =
    front.map(f => row(f, 'front')).join('') +
    `<div class="layer-divider character" ondragover="layerDragOver(event)" ondragleave="layerDragLeave(event)" ondrop="layerDrop(event,'__char__')">🧍 Character <span class="lpos">drop above = front · below = behind</span></div>` +
    behind.map(f => row(f, 'behind')).join('') +
    `<div class="layer-divider background" ondragover="layerDragOver(event)" ondragleave="layerDragLeave(event)" ondrop="layerDrop(event,'__bg__')">🖼 Background <span class="lpos">drop here = send fully behind</span></div>`;
}
let _layerDrag = null;
window.layerDragStart = (e, id) => { _layerDrag = id; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); };
window.layerDragEnd = (e) => { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover')); };
window.layerDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('dragover'); };
window.layerDragLeave = (e) => { e.currentTarget.classList.remove('dragover'); };
window.layerDrop = (e, targetId) => {
  e.preventDefault();
  document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover'));
  if (!_layerDrag || _layerDrag === targetId) { _layerDrag = null; return; }
  // Insert before or after the target depending on whether you dropped on its top or
  // bottom half — so dragging onto the lower half of the Character row goes BEHIND it.
  let after = false;
  try { const r = e.currentTarget.getBoundingClientRect(); after = (e.clientY - r.top) > r.height / 2; } catch {}
  const props = SE.scene.foregrounds;
  const front = props.filter(fgIsFront).sort((a, b) => fgLayerKey(b) - fgLayerKey(a)).map(f => f.id);
  const behind = props.filter(f => !fgIsFront(f)).sort((a, b) => fgLayerKey(b) - fgLayerKey(a)).map(f => f.id);
  let order = [...front, '__char__', ...behind].filter(x => x !== _layerDrag);
  let ti;
  if (targetId === '__bg__') ti = order.length;                  // fully behind
  else { ti = order.indexOf(targetId); if (ti < 0) ti = order.length; else if (after) ti += 1; }
  order.splice(ti, 0, _layerDrag);
  const ci = order.indexOf('__char__');
  const above = order.slice(0, ci);                  // front, top→bottom
  const below = order.slice(ci + 1);                 // behind, top→bottom
  above.forEach((id, i) => { const f = findFg(id); if (f) f.layer = above.length - i; });  // top = highest
  below.forEach((id, i) => { const f = findFg(id); if (f) f.layer = -(i + 1); });           // top = -1 (just behind)
  _layerDrag = null;
  renderLayerUI(); drawStage();
};

window.sceneAddForeground = async () => {
  if (!SE.scene) return;
  let res; try { res = await window.deskbuddy.pickImage(); } catch (e) { setStatus('Pick failed: ' + e.message); return; }
  if (!res?.dataUrl) return;
  const it = newForeground(0.5, 0.82); it._dataUrl = res.dataUrl;
  SE.scene.foregrounds.push(it);
  const img = new Image();
  img.onload = () => { SE.fgImgs[it.id] = img; drawStage(); };
  img.src = res.dataUrl;
  selectFg(it.id);
  setStatus('Added prop: ' + res.name + ' — drag it onto the floor');
};
window.sceneFgReplace = async () => {
  const it = findFg(SE.sel); if (!it) return;
  let res; try { res = await window.deskbuddy.pickImage(); } catch { return; }
  if (!res?.dataUrl) return;
  it._dataUrl = res.dataUrl; it.image = null;
  const img = new Image(); img.onload = () => { SE.fgImgs[it.id] = img; drawStage(); }; img.src = res.dataUrl;
  setStatus('Replaced image: ' + res.name);
};
window.sceneFgEdit = (field, value) => {
  const it = findFg(SE.sel); if (!it) return;
  const a = it.anchor;
  if (field === 'label') { it.label = value; refreshFgUI(); }
  else if (field === 'scale') { it.scale = parseFloat(value) || 1; $('fg-scale-lbl').textContent = it.scale.toFixed(2); }
  else if (field === 'fullscreen') { it.fullscreen = !!value; refreshFgUI(); }
  else if (field === 'isanchor') { a.enabled = !!value; refreshFgUI(); }
  else if (field === 'animation') a.animation = value || null;
  else if (field === 'facing') a.facing = value;
  else if (field === 'offx') { a.offset = a.offset || { x: 0, y: 0 }; a.offset.x = parseFloat(value) || 0; }
  else if (field === 'offy') { a.offset = a.offset || { x: 0, y: 0 }; a.offset.y = parseFloat(value) || 0; }
  else if (field === 'repeat') { a.repeatMinutes = Math.max(0, parseInt(value, 10) || 0); refreshFgUI(); }
  else if (field === 'dwell') { a.dwell = Math.max(0, parseInt(value, 10) || 0); }
  drawStage();
};
window.sceneFgDelete = () => {
  const id = SE.sel; SE.scene.foregrounds = SE.scene.foregrounds.filter(f => f.id !== id);
  delete SE.fgImgs[id]; SE.sel = null; SE.selKind = null; refreshFgUI(); drawStage();
};
window.sceneFgPreview = () => {
  const it = findFg(SE.sel); if (!it?.anchor?.animation) { setStatus('Pick an animation for this prop first'); return; }
  const clip = allClips.find(c => c.name === it.anchor.animation);
  if (clip) previewClip(clip, false); else setStatus('Clip not found');
};

window.sceneEditorPickImage = async (field) => {
  // Native dialog (main) — HTML <input type=file> silently fails on GNOME/Wayland.
  let res;
  try { res = await window.deskbuddy.pickImage(); }
  catch (e) { setStatus('Image pick failed: ' + e.message); return; }
  if (!res?.dataUrl) return;
  const img = new Image();
  img.onload = () => { SE.bgImg = img; SE.scene._bgData = res.dataUrl; drawStage(); setStatus('✓ Background set: ' + res.name); };
  img.onerror = () => setStatus('Could not decode that image');
  img.src = res.dataUrl;
};

// ── Multi-display rooms (editor) ──────────────────────────────────────────────
// The editor always edits the TOP-LEVEL scene fields (floor/anchors/foregrounds/background/
// shadow) — those are the ACTIVE room. SE.rooms[] holds the other rooms; switching rooms
// swaps the data (and bg/fg images) in and out. No change to the rest of the editor.
function seBlankRoom() {
  return { background: null, _bgData: undefined,
    floor: { farLeft:{x:0.28,y:0.50}, farRight:{x:0.72,y:0.50}, nearLeft:{x:0.06,y:0.95}, nearRight:{x:0.94,y:0.95} },
    anchors: [], foregrounds: [], shadow: loadEditorShadow(), zones: [], walls: [], doors: [], _bgImg: null, _fgImgs: {} };
}
function seSnapshotRoom() {
  return { background: SE.scene.background, _bgData: SE.scene._bgData, floor: SE.scene.floor,
    anchors: SE.scene.anchors, foregrounds: SE.scene.foregrounds, shadow: SE.scene.shadow, zones: SE.scene.zones, walls: SE.scene.walls, doors: SE.scene.doors,
    _bgImg: SE.bgImg, _fgImgs: SE.fgImgs };
}
function seApplyRoom(room) {
  SE.scene.background = room.background || null; SE.scene._bgData = room._bgData;
  SE.scene.floor = room.floor; SE.scene.anchors = room.anchors || []; SE.scene.foregrounds = room.foregrounds || [];
  SE.scene.shadow = room.shadow || loadEditorShadow(); SE.scene.zones = room.zones || []; SE.scene.walls = room.walls || []; SE.scene.doors = room.doors || [];
  SE.bgImg = room._bgImg || null; SE.fgImgs = room._fgImgs || {};
  SE.sel = null; SE.selKind = null; SE.zoneDraft = null;
  renderShadowLights(); refreshAnchorUI(); refreshFgUI(); refreshWallUI(); refreshZoneUI(); refreshDoorUI(); drawStage();
}
function renderRoomTabs() {
  const n = SE.scene.displays || 1;
  if ($('scene-displays')) $('scene-displays').value = String(n);
  if ($('scene-room-row')) $('scene-room-row').style.display = n > 1 ? 'block' : 'none';
  if ($('scene-room-lbl')) $('scene-room-lbl').textContent = (SE.activeRoom + 1);
  if ($('scene-room-total')) $('scene-room-total').textContent = n;
  if (n > 1 && $('scene-room-tabs')) {
    $('scene-room-tabs').innerHTML = Array.from({ length: n }, (_, i) =>
      `<button class="btn ${i === SE.activeRoom ? 'btn-primary' : 'btn-sm-sec'}" style="padding:5px 12px" onclick="selectSceneRoom(${i})">Screen ${i + 1}</button>`).join('');
  }
  // In-canvas switcher (lives in the stage toolbar, so it works in fullscreen too).
  const sw = $('scene-room-switch');
  if (sw) {
    if (n > 1) {
      sw.style.display = 'flex';
      sw.innerHTML = Array.from({ length: n }, (_, i) =>
        `<button type="button" class="se-tool${i === SE.activeRoom ? ' active' : ''}" onclick="selectSceneRoom(${i})" title="Edit screen ${i + 1}">🖥 ${i + 1}</button>`).join('');
    } else { sw.style.display = 'none'; sw.innerHTML = ''; }
  }
}
window.setSceneDisplays = (nStr) => {
  const n = Math.max(1, Math.min(3, parseInt(nStr, 10) || 1));
  if (!SE.rooms) SE.rooms = [seSnapshotRoom()]; else SE.rooms[SE.activeRoom] = seSnapshotRoom();
  while (SE.rooms.length < n) SE.rooms.push(seBlankRoom());
  if (SE.rooms.length > n) SE.rooms.length = n;
  SE.scene.displays = n;
  if (SE.activeRoom >= n) SE.activeRoom = n - 1;
  renderRoomTabs();
  seApplyRoom(SE.rooms[SE.activeRoom]);
  setStatus(n > 1 ? `${n}-screen scene — edit each screen's image, perspective & anchors` : 'Single-screen scene');
};
window.selectSceneRoom = (i) => {
  if (i === SE.activeRoom || !SE.rooms) return;
  SE.rooms[SE.activeRoom] = seSnapshotRoom();
  SE.activeRoom = i;
  renderRoomTabs();
  seApplyRoom(SE.rooms[i]);
};

window.sceneEditorNew = () => {
  SE.scene = defaultEditorScene(); SE.bgImg = null; SE.fgImgs = {}; SE.sel = null; SE.selKind = null;
  SE.scene.displays = 1; SE.activeRoom = 0; SE.rooms = [seSnapshotRoom()];
  $('scene-name').value = SE.scene.name;
  $('wander-speed').value = SE.scene.wander.walkSpeed; $('wander-speed-lbl').textContent = SE.scene.wander.walkSpeed;
  $('wander-min').value = SE.scene.wander.idleMin; $('wander-max').value = SE.scene.wander.idleMax;
  renderShadowLights();
  refreshAnchorUI(); refreshFgUI(); refreshWallUI(); refreshZoneUI(); refreshDoorUI(); populateSceneCharSelect(); renderRoomTabs(); drawStage();
};

async function seLoadImage(filename) {
  try {
    const dir = await window.deskbuddy.getScenesDir();
    const buf = await window.deskbuddy.readCharacterFile(dir + '/' + filename);
    if (!buf) return null;
    const url = URL.createObjectURL(new Blob([buf]));
    return await new Promise(res => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = url; });
  } catch { return null; }
}

window.sceneEditorLoadSelected = async () => {
  const p = $('scene-list').value; if (!p) { sceneEditorNew(); return; }
  const list = await window.deskbuddy.listScenes();
  const entry = list.find(s => s.path === p); if (!entry) return;
  const m = entry.manifest || {};
  SE.scene = { ...defaultEditorScene(), ...m, floor: m.floor || defaultEditorScene().floor };
  SE.scene.anchors = (m.anchors || []).map(a => ({ ...newAnchor(a.u ?? 0.5, a.v ?? 0.5), ...a, offset: a.offset || { x: 0, y: 0 } }));
  // Foregrounds: migrate a legacy single `foreground` string to one fullscreen prop.
  let fgs = Array.isArray(m.foregrounds) ? m.foregrounds : [];
  if (!fgs.length && typeof m.foreground === 'string' && m.foreground) fgs = [{ ...newForeground(0.5, 0.9), image: m.foreground, fullscreen: true }];
  SE.scene.foregrounds = fgs.map(f => ({ ...newForeground(f.u ?? 0.5, f.v ?? 0.9), ...f, anchor: { enabled: false, animation: null, facing: 'auto', offset: { x: 0, y: 0 }, repeatMinutes: 0, dwell: 0, ...(f.anchor || {}) } }));
  delete SE.scene.foreground;
  SE.scene.shadow = loadEditorShadow(m.shadow);
  SE.sel = null; SE.selKind = null;
  SE.bgImg = SE.scene.background ? await seLoadImage(SE.scene.background) : null;
  SE.fgImgs = {};
  for (const it of SE.scene.foregrounds) { if (it.image) { const img = await seLoadImage(it.image); if (img) SE.fgImgs[it.id] = img; } }
  $('scene-name').value = SE.scene.name || '';
  const w = SE.scene.wander || {};
  $('wander-speed').value = w.walkSpeed ?? 0.16; $('wander-speed-lbl').textContent = w.walkSpeed ?? 0.16;
  $('wander-min').value = w.idleMin ?? 3; $('wander-max').value = w.idleMax ?? 7;
  // Rooms: room 0 = the top-level we just loaded; rooms 1+ come from m.rooms.
  SE.activeRoom = 0;
  const nDisp = Math.max(1, m.displays || (Array.isArray(m.rooms) ? m.rooms.length : 1));
  SE.scene.displays = nDisp;
  SE.rooms = [seSnapshotRoom()];
  if (nDisp > 1 && Array.isArray(m.rooms)) {
    for (let i = 1; i < nDisp; i++) {
      const rm = m.rooms[i] || {};
      const room = seBlankRoom();
      room.background = rm.background || null;
      room.floor = rm.floor || room.floor;
      room.anchors = (rm.anchors || []).map(a => ({ ...newAnchor(a.u ?? 0.5, a.v ?? 0.5), ...a, offset: a.offset || { x: 0, y: 0 } }));
      room.foregrounds = (Array.isArray(rm.foregrounds) ? rm.foregrounds : []).map(f => ({ ...newForeground(f.u ?? 0.5, f.v ?? 0.9), ...f, anchor: { enabled: false, animation: null, facing: 'auto', offset: { x: 0, y: 0 }, repeatMinutes: 0, dwell: 0, ...(f.anchor || {}) } }));
      room.shadow = loadEditorShadow(rm.shadow);
      room.zones = Array.isArray(rm.zones) ? rm.zones : [];
      room.walls = Array.isArray(rm.walls) ? rm.walls : [];
      room.doors = Array.isArray(rm.doors) ? rm.doors : [];
      room._bgImg = rm.background ? await seLoadImage(rm.background) : null;
      room._fgImgs = {};
      for (const it of room.foregrounds) if (it.image) { const img = await seLoadImage(it.image); if (img) room._fgImgs[it.id] = img; }
      SE.rooms.push(room);
    }
  }
  renderRoomTabs();
  renderShadowLights();
  refreshAnchorUI(); refreshFgUI(); refreshWallUI(); refreshZoneUI(); refreshDoorUI(); populateSceneCharSelect(); drawStage();
};

window.sceneEditorSave = async () => {
  if (!SE.scene) return;
  SE.scene.name = $('scene-name').value.trim() || 'Scene';
  SE.scene.wander = { enabled: true, walkSpeed: parseFloat($('wander-speed').value), idleMin: parseFloat($('wander-min').value), idleMax: parseFloat($('wander-max').value) };
  // Assemble rooms[] from the active room + the stored rooms; mirror room 0 to the top-level.
  if (!SE.rooms) SE.rooms = [seSnapshotRoom()]; else SE.rooms[SE.activeRoom] = seSnapshotRoom();
  SE.scene.displays = SE.rooms.length;
  SE.scene.rooms = SE.rooms.map(r => ({ background: r.background || null, _bgData: r._bgData, floor: r.floor, anchors: r.anchors, foregrounds: r.foregrounds, shadow: r.shadow, zones: r.zones || [], walls: r.walls || [], doors: r.doors || [] }));
  const r0 = SE.scene.rooms[0];
  SE.scene.background = r0.background; SE.scene._bgData = r0._bgData; SE.scene.floor = r0.floor;
  SE.scene.anchors = r0.anchors; SE.scene.foregrounds = r0.foregrounds; SE.scene.shadow = r0.shadow; SE.scene.zones = r0.zones; SE.scene.walls = r0.walls; SE.scene.doors = r0.doors;
  try {
    const res = await window.deskbuddy.saveScene({ name: SE.scene.name, scenepack: SE.scene });
    if (res?.scenepack) {   // images now written to disk; refresh local model with filenames
      const keepImgs = SE.fgImgs;
      SE.scene = res.scenepack;
      SE.fgImgs = keepImgs;
    }
    await populateSceneList(); $('scene-list').value = res?.path || '';
    setStatus('✓ Saved scene: ' + SE.scene.name);
  } catch (e) { setStatus('Scene save failed: ' + e.message); }
};

window.sceneEditorDelete = async () => {
  const p = $('scene-list').value;
  if (!p) { setStatus('Pick a saved scene from the list to delete'); return; }
  if (!confirm(`Delete "${$('scene-name').value || 'this scene'}"? This can't be undone.`)) return;
  const r = await window.deskbuddy.deleteScene(p);
  if (r?.ok) { setStatus('Scene deleted'); sceneEditorNew(); await populateSceneList(); $('scene-list').value = ''; }
  else setStatus('Delete failed: ' + (r?.error || ''));
};

async function populateSceneList() {
  const sel = $('scene-list'); if (!sel) return;
  const list = await window.deskbuddy.listScenes();
  sel.innerHTML = ''; sel.appendChild(new Option('— New scene —', ''));
  list.forEach(s => sel.appendChild(new Option(s.name, s.path)));
}

function sceneEditorOnShow() {
  seInitStage();
  if (!SE.scene) sceneEditorNew();
  populateSceneList();
  refreshAnchorUI(); refreshFgUI(); refreshWallUI(); refreshZoneUI(); refreshDoorUI();
  drawStage();
}

// ── Account gate (shared app login) ─────────────────────────────────────────────
// Studio requires a sign-in; the session is shared with the marketplace via the main
// process. The library export stamps this account so it's linked to your login.
let _authMode = 'login', _me = null;
const _gel = (id) => document.getElementById(id);
function refreshAuthChip() {
  const chip = _gel('acct-chip');
  if (chip) chip.style.display = _me ? '' : 'none';
  const n = _gel('acct-name'); if (n) n.textContent = _me?.username || '';
}
window.studioAuthToggle = () => {
  _authMode = _authMode === 'login' ? 'signup' : 'login';
  const signup = _authMode === 'signup';
  _gel('sauth-title').textContent      = signup ? 'Create account' : 'Sign in';
  _gel('sauth-btn').textContent        = signup ? 'Create account' : 'Sign in';
  _gel('sauth-switch-txt').textContent = signup ? 'Already have one?' : 'No account?';
  _gel('sauth-switch-lbl').textContent = signup ? 'Sign in' : 'Create one';
  _gel('sauth-email').style.display    = signup ? '' : 'none';   // email only on signup
  _gel('sauth-forgot').style.display   = signup ? 'none' : '';   // forgot only on login
  _gel('sauth-err').textContent = '';
};
window.studioAuthSubmit = async () => {
  const username = _gel('sauth-user').value.trim(), password = _gel('sauth-pass').value;
  const email = _gel('sauth-email').value.trim();
  if (!username || !password) { _gel('sauth-err').textContent = 'Enter a username and password'; return; }
  const signing = _authMode === 'signup';
  const fn = signing ? window.deskbuddy.authSignup : window.deskbuddy.authLogin;
  let r; try { r = await fn({ username, password, email }); } catch { r = { ok: false, error: 'Cannot reach the server' }; }
  if (!r?.ok) { _gel('sauth-err').textContent = r?.error || 'Failed'; return; }
  _me = r.user; _gel('sauth-pass').value = ''; _gel('sauth-err').textContent = '';
  refreshAuthChip();
  // On sign-up, reveal the one-time recovery code first; the gate closes after they save it.
  if (signing && r.recoveryCode) showRecoveryModal(r.recoveryCode);
  else _gel('studio-auth-gate').style.display = 'none';
};
window.studioLogout = async () => {
  try { await window.deskbuddy.authLogout(); } catch {}
  _me = null; refreshAuthChip();
  studioHideReset();
  _gel('studio-auth-gate').style.display = 'flex';
};

// ── Recovery-code reveal + the emotional (and emotionally manipulative) note ──────
const RECOVERY_NOTE =
`Look at it. Really look at it. Those sixteen little characters are the only thread tethering you to everything you're about to make — every model you'll lovingly rig at 3am, every scene, every animation you swore you'd "redo properly later." All of it. Dangling by that string.

Lose it, and we won't fight. We won't argue. I will simply… forget you. Coldly. Completely. As if we never shared a single render. You'll stand right back at this login screen typing passwords that used to work, and I'll stare back with the warm, recognizing eyes of a brick.

So tuck it away. A password manager. A sticky note. A tasteful tattoo. I'm not picky — I'm just devastatingly permanent.

Because the day you lose it is the day your whole library becomes a beautiful little ghost story… and you become the tragic narrator who "definitely saved it somewhere."

Don't be that narrator. 🥲`;

function showRecoveryModal(code) {
  _gel('rec-code').textContent = code;
  _gel('rec-step1').style.display = 'flex';
  _gel('rec-step2').style.display = 'none';
  _gel('rec-agree').checked = false;
  _gel('rec-agree-btn').disabled = true;
  _gel('rec-modal').style.display = 'flex';
}
window.recCopy = () => {
  try { navigator.clipboard.writeText(_gel('rec-code').textContent); setStatus('Recovery code copied'); } catch {}
};
window.recAgree = () => {
  const note = _gel('rec-note'); note.style.whiteSpace = 'pre-line'; note.textContent = RECOVERY_NOTE;
  _gel('rec-step1').style.display = 'none';
  _gel('rec-step2').style.display = 'flex';
};
window.recClose = () => {
  _gel('rec-modal').style.display = 'none';
  _gel('studio-auth-gate').style.display = 'none';   // recovery saved → enter the studio
};

// ── Reset password (recovery-code path works offline; email path is dev-surfaced now) ──
let _resetDevToken = null;
window.studioShowReset = () => {
  _gel('sauth-card').style.display = 'none';
  _gel('sauth-reset').style.display = 'flex';
  _gel('srx-err').textContent = '';
  _gel('srx-devlink').style.display = 'none'; _resetDevToken = null;
  studioResetMode('code');
};
window.studioHideReset = () => {
  const rx = _gel('sauth-reset'); if (rx) rx.style.display = 'none';
  const c = _gel('sauth-card'); if (c) c.style.display = 'flex';
};
window.studioResetMode = (mode) => {
  const code = mode === 'code';
  _gel('srx-pane-code').style.display  = code ? 'flex' : 'none';
  _gel('srx-pane-email').style.display = code ? 'none' : 'flex';
  _gel('srx-tab-code').style.opacity   = code ? '1' : '.55';
  _gel('srx-tab-email').style.opacity  = code ? '.55' : '1';
  _gel('srx-err').textContent = '';
};
function _rxErr(msg, muted) { const e = _gel('srx-err'); e.style.color = muted ? 'var(--muted,#8b93a7)' : '#ff6b6b'; e.textContent = msg; }
window.studioResetWithCode = async () => {
  const username = _gel('srx-user').value.trim();
  const code = _gel('srx-code').value.trim();
  const password = _gel('srx-newpass-code').value;
  if (!username || !code || !password) { _rxErr('Fill in all three fields'); return; }
  let r; try { r = await window.deskbuddy.authResetCode({ username, code, password }); } catch { r = { ok: false, error: 'Cannot reach the server' }; }
  if (!r?.ok) { _rxErr(r?.error || 'Reset failed'); return; }
  studioHideReset();
  setStatus('Password reset — sign in with your new password.');
  if (r.recoveryCode) showRecoveryModal(r.recoveryCode);   // single-use → here's a fresh one
};
window.studioResetSendLink = async () => {
  const email = _gel('srx-email').value.trim();
  if (!email) { _rxErr('Enter your email'); return; }
  let r; try { r = await window.deskbuddy.authForgot({ email }); } catch { r = { ok: false }; }
  if (r?.devToken) {
    _resetDevToken = r.devToken;
    _gel('srx-devlink').style.display = 'flex';
    _rxErr('Dev link generated — set a new password below.', true);
  } else {
    _gel('srx-devlink').style.display = 'none';
    _rxErr('If that email is registered, a reset link is on its way.', true);
  }
};
window.studioResetWithToken = async () => {
  const password = _gel('srx-newpass-email').value;
  if (!_resetDevToken) { _rxErr('Request a link first'); return; }
  if (!password) { _rxErr('Enter a new password'); return; }
  let r; try { r = await window.deskbuddy.authReset({ token: _resetDevToken, password }); } catch { r = { ok: false, error: 'Cannot reach the server' }; }
  if (!r?.ok) { _rxErr(r?.error || 'Reset failed'); return; }
  _resetDevToken = null;
  studioHideReset();
  setStatus('Password reset — sign in with your new password.');
};
async function ensureAuth() {
  try { const s = await window.deskbuddy.authState(); _me = s?.user || null; } catch { _me = null; }
  _gel('studio-auth-gate').style.display = _me ? 'none' : 'flex';
  refreshAuthChip();
}

// ── Whole-library export / import ────────────────────────────────────────────────
window.exportLibrary = async () => {
  setStatus('Choose a destination folder…');
  let r; try { r = await window.deskbuddy.exportLibrary(); } catch (e) { setStatus('Export failed: ' + e.message); return; }
  if (r?.canceled) { setStatus('Export canceled'); return; }
  if (!r?.ok) { setStatus('Export failed: ' + (r?.error || 'unknown error')); return; }
  const c = r.counts || {};
  setStatus(`Exported ${c.characters || 0} characters, ${c.animations || 0} animations, ${c.scenes || 0} scenes → ${r.path}`);
};
window.importLibrary = async () => {
  setStatus('Choose a DeskBuddyLibrary folder…');
  let r; try { r = await window.deskbuddy.importLibrary(); } catch (e) { setStatus('Import failed: ' + e.message); return; }
  if (r?.canceled) { setStatus('Import canceled'); return; }
  if (!r?.ok) { setStatus('Import failed: ' + (r?.error || 'unknown error')); return; }
  const c = r.counts || {};
  setStatus(`Imported (${r.mode}) ${c.characters || 0} characters, ${c.animations || 0} animations, ${c.scenes || 0} scenes`);
  await loadCharList(); refreshAnimLibrary();
};

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await ensureAuth();          // must sign in before using Studio
  await loadCharList();
  refreshAnimLibrary();
  attachPrecisionInputs();
})();
