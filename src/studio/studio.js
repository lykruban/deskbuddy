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
scene.add(new THREE.GridHelper(4, 16, 0x333355, 0x1e1e38));

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
      <button class="clip-play" title="Preview" onclick="previewClipByName('${escName(c.name)}')">▶</button>`;
    list.appendChild(row);
  });

  importedClips.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'clip-row';
    row.innerHTML = `
      <span class="clip-name" title="${c.name}">${c.name || `FBX ${i+1}`}</span>
      <span class="clip-dur">${c.duration.toFixed(1)}s</span>
      <span class="clip-src src-fbx">Mixamo</span>
      <button class="clip-play" title="Preview" onclick="previewClipByName('${escName(c.name)}')">▶</button>
      <button class="clip-del" title="Remove" onclick="removeImportedClip(${i})">✕</button>`;
    list.appendChild(row);
  });
}

function escName(n) { return (n || '').replace(/'/g, "\\'"); }

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

window.importFBXAnimation = async () => {
  if (!model) { setStatus('Load a character model first, then import an animation'); return; }

  const r = await window.deskbuddy.importFBXAnimation();
  if (!r) return;

  setStatus(`Reading ${r.filename}…`);
  const buf = await window.deskbuddy.readFileBuffer(r.path);
  if (!buf) { setStatus('Cannot read file'); return; }
  const ext = (r.filename.split('.').pop() || '').toLowerCase();

  try {
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
      // BVHLoader names tracks ".bones[Name].position|quaternion" — strip to Name.
      clips.forEach(c => c.tracks.forEach(t => { t.name = t.name.replace(/^\.bones\[(.+?)\]/, '$1'); }));
      sourceRoot = new THREE.Object3D();
      if (bvh.skeleton?.bones?.[0]) sourceRoot.add(bvh.skeleton.bones[0]);
    } else {
      setStatus('Unsupported animation format: .' + ext); return;
    }
    if (!clips.length) { setStatus('No animation clips found in this file'); return; }
    processImportedClips(clips, sourceRoot, r.filename, ext);
  } catch (err) {
    console.error('animation import error:', err);
    setStatus('Animation error: ' + (err.message || String(err)));
  }
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

  // Step 5: add (de-duplicating names).
  const added = [];
  clips.forEach(clip => {
    let name = clip.name, n = 1;
    while (importedClips.some(c => c.name === name)) name = `${clip.name} (${++n})`;
    clip.name = name;
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
    stateSettings:   { sleepAfterMinutes: parseInt($('sleep-sl').value, 10) || 10 },
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
function collectGroundBones() {
  sGroundBones = [];
  if (vrmData?.humanoid?.getRawBoneNode) {
    ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].forEach(n => {
      const b = vrmData.humanoid.getRawBoneNode(n); if (b) sGroundBones.push(b);
    });
  }
  if (!sGroundBones.length && model) {
    const byName = {};
    model.traverse(o => { if (o.isBone) byName[o.name] = o; });
    ['mixamorigLeftFoot', 'mixamorigRightFoot', 'mixamorigLeftToeBase', 'mixamorigRightToeBase']
      .forEach(n => { if (byName[n]) sGroundBones.push(byName[n]); });
  }
}
function groundPreview() {
  if (!model || !sGroundBones.length) return;
  model.updateMatrixWorld(true);
  let lo = Infinity;
  for (const b of sGroundBones) { b.getWorldPosition(_sFootWP); if (_sFootWP.y < lo) lo = _sFootWP.y; }
  if (isFinite(lo)) model.position.y += (0 - lo);   // pin lowest foot to the grid floor
}

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  if (mixer) mixer.update(dt);       // 1. mixer writes to normalized bones
  if (vrmData?.update) vrmData.update(dt); // 2. VRM converts normalized → raw bone space
  // Ground the feet only while a clip is actually playing (leaves the manual
  // rig/transform editing free to position the model however the user wants).
  if (previewPlaying) groundPreview();
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
const SE = { scene: null, bgImg: null, fgImgs: {}, sel: null, selKind: null, drag: null, inited: false };

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
    version: 2, name: 'My Scene', character: null, background: null, foregrounds: [], charScales: {},
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
const findAnchor = (id) => SE.scene.anchors.find(a => a.id === id);
const findFg = (id) => SE.scene.foregrounds.find(f => f.id === id);

const seClamp01 = (v) => Math.min(1, Math.max(0, v));
function seDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
// The stage shows a margin AROUND the wallpaper image so floor-quad corners can be
// dragged outside the image (e.g. a near edge that runs off-screen). The image
// occupies floor coords 0..1; the canvas spans floor coords [-PAD, 1+PAD].
const STAGE_PAD = 0.2;
const sxFrac = (n) => (n + STAGE_PAD) / (1 + 2 * STAGE_PAD);   // floor coord → 0..1 canvas fraction
const nxFrac = (fr) => fr * (1 + 2 * STAGE_PAD) - STAGE_PAD;   // 0..1 canvas fraction → floor coord
const PXx = (n, W) => sxFrac(n) * W;
const PXy = (n, H) => sxFrac(n) * H;
function seStageXY(e) {
  const cv = $('scene-stage'), r = cv.getBoundingClientRect();
  // Clamp to the canvas (fraction 0..1), which maps to floor coords [-PAD, 1+PAD] —
  // so a dragged corner can leave the image but stays visible and grabbable.
  return { x: nxFrac(seClamp01((e.clientX - r.left) / r.width)), y: nxFrac(seClamp01((e.clientY - r.top) / r.height)) };
}

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
  // floor quad
  const ring = [f.farLeft, f.farRight, f.nearRight, f.nearLeft];
  ctx.strokeStyle = 'rgba(99,102,241,0.9)'; ctx.lineWidth = 2; ctx.beginPath();
  ring.forEach((p, i) => { const x = PXx(p.x, W), y = PXy(p.y, H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath(); ctx.fillStyle = 'rgba(99,102,241,0.10)'; ctx.fill(); ctx.stroke();
  // foreground props (farther first so nearer ones overlap)
  (SE.scene.foregrounds || []).slice().sort((a, b) => a.v - b.v).forEach(it => drawFgItem(ctx, it, W, H));
  // floor corner handles (on top of props so they're grabbable)
  [f.farLeft, f.farRight, f.nearLeft, f.nearRight].forEach(p => {
    const x = PXx(p.x, W), y = PXy(p.y, H);
    ctx.fillStyle = '#6366f1'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
  });
  // anchors
  SE.scene.anchors.forEach(a => {
    const s = floorToScreen(f, a.u, a.v), x = PXx(s.x, W), y = PXy(s.y, H);
    const seld = a.id === SE.sel && SE.selKind === 'anchor';
    ctx.fillStyle = seld ? '#f59e0b' : (a.repeatMinutes > 0 ? '#38bdf8' : '#22c55e');
    ctx.beginPath(); ctx.arc(x, y, seld ? 7 : 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0d0d12'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(a.label || '', x, y - 10);
  });
  // light handles (draggable ☀) — drawn last so they sit on top and stay grabbable
  const sh = SE.scene.shadow;
  if (sh?.enabled && Array.isArray(sh.lights)) sh.lights.forEach((L, i) => drawLightHandle(ctx, L, i, W, H));
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

function seInitStage() {
  if (SE.inited) return; SE.inited = true;
  const cv = $('scene-stage');
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const p = seStageXY(e), f = SE.scene.floor;
    // light handles first — they sit on top and must stay grabbable. Grab by the
    // glowing orb OR the floor base.
    const sh = SE.scene.shadow;
    if (sh?.enabled && Array.isArray(sh.lights)) {
      for (let i = 0; i < sh.lights.length; i++) {
        const L = sh.lights[i], o = lightOrbPos(L);
        if (seDist(p, o) < 0.07 || seDist(p, o.base) < 0.06) { SE.drag = { type: 'light', idx: i }; return; }
      }
    }
    for (const k of ['farLeft', 'farRight', 'nearLeft', 'nearRight']) {
      if (seDist(p, f[k]) < 0.05) { SE.drag = { type: 'corner', key: k }; return; }
    }
    // foreground bases (nearer first — they sit on top)
    const fgs = (SE.scene.foregrounds || []).filter(x => !x.fullscreen).slice().sort((a, b) => b.v - a.v);
    for (const it of fgs) {
      if (seDist(p, floorToScreen(f, it.u, it.v)) < 0.06) { selectFg(it.id); SE.drag = { type: 'fg', id: it.id }; return; }
    }
    for (const a of SE.scene.anchors) {
      if (seDist(p, floorToScreen(f, a.u, a.v)) < 0.05) { selectAnchor(a.id); SE.drag = { type: 'anchor', id: a.id }; return; }
    }
    const uv = screenToFloor(f, p.x, p.y);
    const a = newAnchor(uv.u, uv.v);
    SE.scene.anchors.push(a); selectAnchor(a.id); SE.drag = null;
  });
  cv.addEventListener('pointermove', (e) => {
    if (!SE.drag) return;
    const p = seStageXY(e), f = SE.scene.floor;
    if (SE.drag.type === 'corner') f[SE.drag.key] = { x: p.x, y: p.y };
    else if (SE.drag.type === 'light') { const L = SE.scene.shadow?.lights?.[SE.drag.idx]; if (L) { const poleImg = (L.height || 0) * depthScaleAt(f, L.v) * 0.5 * (1 + 2 * STAGE_PAD); const uv = screenToFloor(f, p.x, p.y + poleImg); L.u = clampUnit(uv.u); L.v = clampUnit(uv.v); } }
    else if (SE.drag.type === 'anchor') { const a = findAnchor(SE.drag.id); if (a) { const uv = screenToFloor(f, p.x, p.y); a.u = uv.u; a.v = uv.v; } }
    else if (SE.drag.type === 'fg') { const it = findFg(SE.drag.id); if (it) { const uv = screenToFloor(f, p.x, p.y); it.u = uv.u; it.v = uv.v; } }
    drawStage();
  });
  cv.addEventListener('pointerup', () => { SE.drag = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sceneStageSetFs(false); });
}

// Fullscreen editing: blow the stage up to fill the window for precise corner/anchor
// work, and bump the canvas backing resolution so it stays crisp. Hit-testing is in
// normalized floor space, so it works identically at any display size.
const STAGE_RES = { normal: [560, 315], full: [1280, 720] };
function sceneStageSetFs(on) {
  const wrap = $('scene-stage-wrap'), cv = $('scene-stage'); if (!wrap || !cv) return;
  if (wrap.classList.contains('fs') === on) return;
  wrap.classList.toggle('fs', on);
  const [w, h] = on ? STAGE_RES.full : STAGE_RES.normal;
  cv.width = w; cv.height = h;
  drawStage();
}
window.sceneStageToggleFs = () => sceneStageSetFs(!$('scene-stage-wrap')?.classList.contains('fs'));

function selectAnchor(id) { SE.sel = id; SE.selKind = 'anchor'; refreshAnchorUI(); refreshFgUI(); drawStage(); }
function selectFg(id) { SE.sel = id; SE.selKind = 'fg'; refreshFgUI(); refreshAnchorUI(); drawStage(); }

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

window.sceneEditorNew = () => {
  SE.scene = defaultEditorScene(); SE.bgImg = null; SE.fgImgs = {}; SE.sel = null; SE.selKind = null;
  $('scene-name').value = SE.scene.name;
  $('wander-speed').value = SE.scene.wander.walkSpeed; $('wander-speed-lbl').textContent = SE.scene.wander.walkSpeed;
  $('wander-min').value = SE.scene.wander.idleMin; $('wander-max').value = SE.scene.wander.idleMax;
  renderShadowLights();
  refreshAnchorUI(); refreshFgUI(); populateSceneCharSelect(); drawStage();
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
  renderShadowLights();
  refreshAnchorUI(); refreshFgUI(); populateSceneCharSelect(); drawStage();
};

window.sceneEditorSave = async () => {
  if (!SE.scene) return;
  SE.scene.name = $('scene-name').value.trim() || 'Scene';
  SE.scene.wander = { enabled: true, walkSpeed: parseFloat($('wander-speed').value), idleMin: parseFloat($('wander-min').value), idleMax: parseFloat($('wander-max').value) };
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
  refreshAnchorUI(); refreshFgUI();
  drawStage();
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadCharList();
})();
