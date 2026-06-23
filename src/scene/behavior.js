// behavior.js — the "alive" brain for scene mode. Pure logic, no three.js: given a
// scenepack and a dt each frame, it decides WHERE the character is on the floor,
// which way it faces, and which clip to play. Rendering reads the result.
//
// Two layers drive movement:
//   • Random wander — idle at an anchor for a random dwell, then pick a new
//     weighted anchor, walk there (facing the heading), arrive, idle again.
//   • Scheduled visits — any anchor (free OR a foreground-item anchor) with
//     repeatMinutes > 0 is force-visited every N minutes so the character goes and
//     performs that animation on a timer (e.g. sit on the couch every 5 min).
// Position is in floor (u,v) space (see floor.js); the renderer maps it to screen.

import { clampFloor, facingYaw } from './floor.js';
import { pickAnchor, sceneAnchors } from './scenepack.js';

const FACING_YAW = { front: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 };
const TURN_SPEED = 5;   // rad/s — how fast the character pivots toward a new heading/facing

function rand(min, max) { return min + Math.random() * (max - min); }
// Shortest-path angular ease from `cur` toward `target`, at most `maxStep` rad.
function easeAngle(cur, target, maxStep) {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));   // wrap to [-π, π]
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export function createBehavior(scenepack, rng = Math.random) {
  const anchors = sceneAnchors(scenepack);          // free anchors + fg-item anchors
  const wander  = scenepack.wander || {};
  const start   = anchors.find(a => a.weight > 0) || anchors[0]
                || { id: null, u: 0.5, v: 0.7, animation: null, facing: 'front' };

  // Each repeatMinutes>0 anchor gets a clock that counts up to its interval; when
  // it elapses we force a visit and reset it.
  const scheduled = anchors
    .filter(a => a.repeatMinutes > 0)
    .map(a => ({ anchor: a, every: Math.max(1, a.repeatMinutes * 60), t: 0 }));

  const startYaw = FACING_YAW[start.facing] ?? 0;
  const st = {
    phase: 'idle',                 // 'idle' | 'walking'
    pos: { u: start.u, v: start.v },
    yaw: startYaw,
    targetYaw: startYaw,           // yaw eases toward this each frame (smooth turning)
    current: start,                // anchor we're at / came from
    target: null,                  // anchor we're walking to
    forced: false,                 // target came from the scheduler
    dwell: dwellFor(start),
    timer: 0,
  };

  // Per-anchor wait time if set (>0), else a random dwell from the wander config.
  function dwellFor(a) {
    return (a && a.dwell > 0) ? a.dwell : rand(wander.idleMin ?? 4, wander.idleMax ?? 12);
  }

  function clipFor() {
    if (st.phase === 'walking') return 'walk';
    return st.current?.animation || null;   // null → renderer falls back to idle
  }

  // The most-overdue scheduled anchor whose timer has elapsed (or null).
  function dueScheduled() {
    let best = null;
    for (const s of scheduled) {
      if (s.t >= s.every && (!best || (s.t - s.every) > (best.t - best.every))) best = s;
    }
    return best;
  }

  // Advance the simulation by dt seconds. Returns the render snapshot.
  function update(dt) {
    for (const s of scheduled) s.t += dt;

    if (st.phase === 'idle') {
      st.timer += dt;
      const due = dueScheduled();
      if (due) {
        st.target = due.anchor; st.forced = true; st.phase = 'walking';
        due.t = 0; st.timer = 0;
      } else {
        const canWander = wander.enabled !== false
          && anchors.some(a => a.weight > 0 && a.id !== st.current?.id);
        if (canWander && st.timer >= st.dwell) {
          const next = pickAnchor(anchors, st.current?.id);
          if (next) { st.target = next; st.forced = false; st.phase = 'walking'; }
          st.timer = 0;
        }
      }
    } else if (st.phase === 'walking' && st.target) {
      const du = st.target.u - st.pos.u, dv = st.target.v - st.pos.v;
      const distUV = Math.hypot(du, dv);
      const step = (wander.walkSpeed ?? 0.12) * dt;
      if (distUV <= step || distUV < 1e-4) {
        // Arrived: snap position, turn (smoothly) to the anchor's facing, go idle.
        st.pos = { u: st.target.u, v: st.target.v };
        st.current = st.target; st.target = null; st.forced = false;
        st.phase = 'idle'; st.timer = 0;
        st.dwell = dwellFor(st.current);
        const f = FACING_YAW[st.current.facing];
        if (f !== undefined) st.targetYaw = f;   // 'auto' keeps the walk-in heading
      } else {
        st.pos.u += (du / distUV) * step;
        st.pos.v += (dv / distUV) * step;
        const y = facingYaw(du, dv);
        if (y !== null) st.targetYaw = y;
      }
    }
    // Smoothly rotate toward the target heading/facing instead of snapping.
    st.yaw = easeAngle(st.yaw, st.targetYaw, TURN_SPEED * dt);
    const c = clampFloor(st.pos.u, st.pos.v);
    const offset = (st.phase === 'idle' && st.current?.offset) || { x: 0, y: 0 };
    return { u: c.u, v: c.v, yaw: st.yaw, moving: st.phase === 'walking', clip: clipFor(), offset };
  }

  // Force-walk to a specific floor point (e.g. user clicked the scene). Optional.
  function goTo(u, v) {
    st.target = { id: null, u, v, animation: null, facing: 'auto' };
    st.forced = false; st.phase = 'walking';
  }

  // Walk to a specific anchor/prop and play its animation on arrival — used when the
  // user clicks a prop. `a` is an anchor-shaped object { u, v, animation, facing,
  // offset, dwell }.
  function goToAnchor(a) {
    if (!a) return;
    st.target = { id: a.id || null, u: a.u, v: a.v, animation: a.animation || null,
      facing: a.facing || 'auto', offset: a.offset || { x: 0, y: 0 }, dwell: a.dwell || 0 };
    st.forced = true; st.phase = 'walking'; st.timer = 0;
  }

  return { update, goTo, goToAnchor, state: st };
}
