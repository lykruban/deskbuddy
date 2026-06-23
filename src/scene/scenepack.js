// scenepack.js — the .scenepack data model (schema, defaults, normalization).
//
// A scenepack turns a character into a themed living-wallpaper: a 2D background
// (set as the desktop wallpaper), a floor quad (see floor.js), anchors the
// character strolls between, and foreground ITEMS — floor-placed sprites that
// occlude the character (walk behind the couch) and can double as animation
// anchors (walk to the couch every few minutes and sit). Stored next to the
// characters as `<name>.scenepack` (JSON).
//
// Anchors (free):
//   { id, label, u, v, facing, animation, offset:{x,y}, weight, repeatMinutes }
//   - (u,v)          WHERE on the floor the character stands (floor.js coords)
//   - facing         'auto' | 'front' | 'back' | 'left' | 'right'
//   - animation      clip/state name to play on arrival (null → idle)
//   - offset         fine screen-px nudge if the clip's root isn't centered
//   - weight         how often the random wander picks this anchor (0 = never)
//   - repeatMinutes  if > 0, the character is sent here every N minutes regardless
//
// Foreground items:
//   { id, image, u, v, scale, fullscreen, anchor:{ enabled, animation, facing,
//     offset:{x,y}, repeatMinutes } }
//   - placed on the floor at (u,v); depth-sorted against the character by v so a
//     nearer item draws in front (occlusion). `fullscreen` keeps the legacy full-
//     window occlusion layer. When `anchor.enabled`, the item is also a behavior
//     target with its own animation/offset/schedule.

import { defaultQuad } from './floor.js';

export const SCENEPACK_VERSION = 2;

const rndId = (p) => p + Math.random().toString(36).slice(2, 8);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const pt = (p, d) => ({ x: num(p?.x, d.x), y: num(p?.y, d.y) });

export function defaultScenepack() {
  return {
    version: SCENEPACK_VERSION,
    name: 'Untitled Scene',
    character: null,     // bound character filename — auto-loaded when the scene plays
    background: null,    // image filename inside the scenepack dir (→ wallpaper)
    foregrounds: [],     // placed foreground items (see normalizeForeground)
    floor: defaultQuad(),
    anchors: [],
    wander: { enabled: true, idleMin: 4, idleMax: 12, walkSpeed: 0.12 },
    // Ground shadow: one projected-silhouette shadow per light source. Each light is
    // placed on the floor (u,v) at a height; the shadow falls away from it using the
    // floor perspective. See defaultLight().
    shadow: { enabled: true, lights: [defaultLight()] },
    // Per-character size override, keyed by character filename. A scene can be played
    // by any character; each remembers its own size in this scene (1 = default).
    charScales: {},
  };
}

// Sanitize the {charFilename: scale} map: keep finite, sensibly-clamped numbers only.
export function normalizeCharScales(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (typeof k === 'string' && k && typeof v === 'number' && isFinite(v)) out[k] = Math.min(4, Math.max(0.2, v));
    }
  }
  return out;
}

// A light is positioned ON the floor at (u,v) — its base — and raised by `height`.
// It both casts a projected ground shadow (which points away from the light, using
// the floor perspective) AND tints the character in its `color`.
//   u,v       floor base position (floor.js coords)
//   height    metres-ish above the floor; lower = longer shadow (perspective)
//   distance  shadow throw / point-light reach multiplier
//   mode      'directional' (far, parallel rays) | 'point' (local, glows all around)
//   color     CSS #rrggbb — tints the character
//   intensity shadow darkness + light brightness
//   softness  shadow edge blur
export function defaultLight() { return { u: 0.5, v: 0.30, height: 0.7, distance: 1.0, mode: 'directional', angleAdjust: 0, showGlow: true, color: '#ffffff', intensity: 0.35, softness: 0.4 }; }
const hex6 = (c, d) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : d);
export function normalizeLight(l) {
  const d = defaultLight();
  let { u, v, height, distance } = (l || {});
  // Migrate legacy {angle,length} lights to a floor position opposite the shadow.
  if (typeof u !== 'number' || typeof v !== 'number') {
    const a = num(l?.angle, 90) * Math.PI / 180, len = num(l?.length, 0.55);
    u = 0.5 - Math.cos(a) * 0.3;           // light sits opposite the shadow direction
    v = 0.5 - Math.sin(a) * 0.3;           // (NDC y-up shadow → floor y-down here)
    if (typeof height !== 'number') height = Math.max(0.3, 1.2 - len * 0.45);
    if (typeof distance !== 'number') distance = Math.max(0.4, len * 1.6);
  }
  return {
    u: clamp01(num(u, d.u)),
    v: clamp01(num(v, d.v)),
    height: Math.max(0.05, Math.min(3, num(height, d.height))),
    distance: Math.max(0.1, Math.min(4, num(distance, d.distance))),
    mode: l?.mode === 'point' ? 'point' : 'directional',
    angleAdjust: Math.max(-180, Math.min(180, num(l?.angleAdjust, 0))),   // shadow direction fine-tune (deg)
    showGlow: l?.showGlow !== false,   // hide the glow sprite without disabling the light/shadow
    color: hex6(l?.color, d.color),
    intensity: clamp01(num(l?.intensity, num(l?.opacity, d.intensity))),
    softness: clamp01(num(l?.softness, d.softness)),
  };
}
export function normalizeShadow(sh) {
  const enabled = sh?.enabled !== false;
  // Accept a lights[] array, or migrate a single-light shape (angle/intensity/…
  // or the legacy dirX/opacity/squash) into one light.
  let lights = Array.isArray(sh?.lights) && sh.lights.length ? sh.lights
    : [{ angle: sh?.angle, color: sh?.color, intensity: sh?.intensity ?? sh?.opacity, length: sh?.length, softness: sh?.softness }];
  return { enabled, lights: lights.map(normalizeLight) };
}

// Default ground-shadow config used by the editor when none exists yet.
export function defaultShadow() {
  return { enabled: true, lights: [defaultLight()] };
}

export function defaultAnchor(u = 0.5, v = 0.5) {
  return {
    id: rndId('a'),
    label: 'Anchor',
    u, v,
    facing: 'auto',
    animation: null,
    offset: { x: 0, y: 0 },
    weight: 1,
    repeatMinutes: 0,
    dwell: 0,            // wait time (s) at this anchor; 0 = use the wander default
  };
}

export function defaultForeground(u = 0.5, v = 0.9) {
  return {
    id: rndId('f'),
    label: 'Foreground',
    image: null,
    u, v,
    scale: 1,
    fullscreen: false,
    // Draw layer relative to the character: 0 = auto (by floor depth), <0 = behind,
    // >0 = in front. Larger magnitude = nearer that side; ties stack by list order.
    layer: 0,
    anchor: { enabled: false, animation: null, facing: 'auto', offset: { x: 0, y: 0 }, repeatMinutes: 0, dwell: 0 },
  };
}

export function normalizeAnchor(a) {
  return {
    ...defaultAnchor(),
    ...a,
    u: clamp01(num(a?.u, 0.5)),
    v: clamp01(num(a?.v, 0.5)),
    offset: pt(a?.offset, { x: 0, y: 0 }),
    weight: Math.max(0, num(a?.weight, 1)),
    repeatMinutes: Math.max(0, num(a?.repeatMinutes, 0)),
    dwell: Math.max(0, num(a?.dwell, 0)),
  };
}

export function normalizeForeground(f) {
  const d = defaultForeground();
  const a = f?.anchor || {};
  return {
    ...d,
    ...f,
    id: f?.id || d.id,
    label: f?.label || 'Foreground',
    image: f?.image || null,
    u: clamp01(num(f?.u, d.u)),
    v: clamp01(num(f?.v, d.v)),
    scale: Math.max(0.05, num(f?.scale, 1)),
    fullscreen: !!f?.fullscreen,
    layer: Math.round(Math.max(-99, Math.min(99, num(f?.layer, 0)))),
    anchor: {
      enabled: !!a.enabled,
      animation: a.animation || null,
      facing: a.facing || 'auto',
      offset: pt(a.offset, { x: 0, y: 0 }),
      repeatMinutes: Math.max(0, num(a.repeatMinutes, 0)),
      dwell: Math.max(0, num(a.dwell, 0)),
    },
  };
}

// Fill in missing/invalid fields so the renderer can trust the shape. Returns a
// copy, never throws — bad scenepacks degrade gracefully instead of crashing.
// Also migrates v1 (single `foreground` string) to a fullscreen foreground item.
export function normalizeScenepack(raw) {
  const d = defaultScenepack();
  const s = { ...d, ...(raw || {}) };
  s.version = SCENEPACK_VERSION;
  s.character = (typeof raw?.character === 'string' && raw.character) ? raw.character : null;
  s.floor = {
    farLeft:  pt(raw?.floor?.farLeft,  d.floor.farLeft),
    farRight: pt(raw?.floor?.farRight, d.floor.farRight),
    nearLeft: pt(raw?.floor?.nearLeft, d.floor.nearLeft),
    nearRight:pt(raw?.floor?.nearRight,d.floor.nearRight),
  };
  s.wander = { ...d.wander, ...(raw?.wander || {}) };
  s.shadow = normalizeShadow(raw?.shadow);
  s.charScales = normalizeCharScales(raw?.charScales);
  s.anchors = (Array.isArray(raw?.anchors) ? raw.anchors : []).map(normalizeAnchor);

  let fgs = Array.isArray(raw?.foregrounds) ? raw.foregrounds : [];
  if (!fgs.length && typeof raw?.foreground === 'string' && raw.foreground) {
    fgs = [{ ...defaultForeground(), image: raw.foreground, fullscreen: true, label: 'Foreground' }];
  }
  s.foregrounds = fgs.map(normalizeForeground);
  delete s.foreground;
  return s;
}

// The unified list of behavior targets: free anchors plus foreground items that
// are flagged as anchors (exposed with the same shape so the brain treats them
// uniformly). Foreground anchors don't join the random wander (weight 0) — they
// run on their repeat schedule — unless a weight is set.
export function sceneAnchors(scene) {
  const free = (scene.anchors || []).map(a => ({ ...a, kind: 'anchor' }));
  const fg = (scene.foregrounds || [])
    .filter(f => f.anchor?.enabled)
    .map(f => ({
      id: 'fg:' + f.id,
      label: f.label || 'Item',
      u: f.u, v: f.v,
      facing: f.anchor.facing,
      animation: f.anchor.animation,
      offset: f.anchor.offset,
      weight: 0,
      repeatMinutes: f.anchor.repeatMinutes,
      dwell: f.anchor.dwell || 0,
      kind: 'foreground',
      fgId: f.id,
    }));
  return free.concat(fg);
}

// Weighted random pick over anchors (the wander loop's next destination).
// Avoids repeating `avoidId` when there's more than one option.
export function pickAnchor(anchors, avoidId = null) {
  const pool = anchors.filter(a => a.weight > 0 && (anchors.length === 1 || a.id !== avoidId));
  if (!pool.length) return null;
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of pool) { r -= a.weight; if (r <= 0) return a; }
  return pool[pool.length - 1];
}
