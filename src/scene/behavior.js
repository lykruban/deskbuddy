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

import { clampFloor, facingYaw, floorToScreen, screenToFloor } from './floor.js';
import { pickAnchor, sceneAnchors, pointInPolygon } from './scenepack.js';

// Collect no-walk zones in the same coordinate space as the anchors (global-u for multi-
// room: room i's local point becomes global u = i + x).
// A wall base segment becomes a thin no-walk barrier polygon so the character can't walk
// through the wall (and pathfinds around its ends).
function wallToPoly(base) {
  const a = base[0], b = base[1];
  let nx = b.y - a.y, ny = -(b.x - a.x); const m = Math.hypot(nx, ny) || 1; nx = nx / m * 0.015; ny = ny / m * 0.015;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }];
}
function collectZones(scene, multi) {
  const out = [];
  const addRoom = (room, off) => {
    (room.zones || []).forEach(z => { if (z.points && z.points.length >= 3) out.push(z.points.map(p => ({ x: off + p.x, y: p.y }))); });
    (room.walls || []).forEach(w => { if (w.base?.length === 2) out.push(wallToPoly(w.base).map(p => ({ x: off + p.x, y: p.y }))); });
  };
  if (multi) (scene.rooms || []).forEach((room, i) => addRoom(room, i));
  else addRoom(scene, 0);
  return out;
}
// Doors: the first door of each room, in global-u (room i's local u → i + u). Map room→{u,v}.
function collectDoors(scene, multi) {
  const map = {};
  const add = (room, i) => { const d = (room.doors || [])[0]; if (d) map[i] = { u: i + d.u, v: d.v }; };
  if (multi) (scene.rooms || []).forEach((room, i) => add(room, i));
  else add(scene, 0);
  return map;
}
// Do segments AB and CD properly cross?
function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}
// Does segment AB cross/enter any zone?
function segHitsZones(ax, ay, bx, by, zones) {
  for (const poly of zones) {
    if (pointInPolygon((ax + bx) / 2, (ay + by) / 2, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segSeg(ax, ay, bx, by, poly[j].x, poly[j].y, poly[i].x, poly[i].y)) return true;
    }
  }
  return false;
}
// Shortest path from `from` to `target` around the zones (visibility graph over slightly
// outset zone corners + Dijkstra). Returns [waypoints…] ending at target. Falls back to a
// straight line if the path is clear or no route exists.
function findPath(from, target, zones) {
  if (!zones.length || !segHitsZones(from.u, from.v, target.u, target.v, zones)) return [target];
  const nodes = [{ u: from.u, v: from.v }];
  for (const poly of zones) {
    let cx = 0, cy = 0; for (const p of poly) { cx += p.x; cy += p.y; } cx /= poly.length; cy /= poly.length;
    for (const p of poly) { const dx = p.x - cx, dy = p.y - cy, m = Math.hypot(dx, dy) || 1; nodes.push({ u: p.x + dx / m * 0.05, v: p.y + dy / m * 0.05 }); }
  }
  nodes.push({ u: target.u, v: target.v });
  const N = nodes.length, adj = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    if (!segHitsZones(nodes[i].u, nodes[i].v, nodes[j].u, nodes[j].v, zones)) {
      const w = Math.hypot(nodes[i].u - nodes[j].u, nodes[i].v - nodes[j].v);
      adj[i].push([j, w]); adj[j].push([i, w]);
    }
  }
  const dist = Array(N).fill(Infinity), prev = Array(N).fill(-1), seen = Array(N).fill(false);
  dist[0] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1, best = Infinity;
    for (let k = 0; k < N; k++) if (!seen[k] && dist[k] < best) { best = dist[k]; u = k; }
    if (u < 0) break; seen[u] = true;
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
  }
  if (dist[N - 1] === Infinity) return [target];   // boxed in → fall back to straight
  const path = [];
  for (let k = N - 1; k > 0; k = prev[k]) path.unshift(k === N - 1 ? target : { u: nodes[k].u, v: nodes[k].v });
  return path.length ? path : [target];
}

// Multi-room anchors in GLOBAL-u space: room i occupies u ∈ [i, i+1), so an anchor at
// local u in room i becomes global u = i + u. The character walks across rooms (screens)
// in this continuous coordinate; the renderer splits u back into room + local-u.
function multiRoomAnchors(scene) {
  const out = [];
  (scene.rooms || []).forEach((room, i) => {
    (room.anchors || []).forEach(a => out.push({ ...a, u: i + a.u, room: i, kind: 'anchor' }));
    (room.foregrounds || []).filter(f => f.anchor?.enabled).forEach(f => out.push({
      id: 'fg:' + i + ':' + f.id, label: f.label || 'Item', u: i + f.u, v: f.v,
      facing: f.anchor.facing, animation: f.anchor.animation, offset: f.anchor.offset,
      weight: 0, repeatMinutes: f.anchor.repeatMinutes, dwell: f.anchor.dwell || 0,
      kind: 'foreground', fgId: f.id, room: i,
    }));
  });
  return out;
}

const FACING_YAW = { front: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 };
const TURN_SPEED = 5;   // rad/s — how fast the character pivots toward a new heading/facing
// Door teleport timing: cross-screen trips don't walk the character over the seam — it walks
// to its screen's door, vanishes, and reappears at the other screen's door. TELE_HALF is each
// half: fade-OUT at the exit door (1→0), snap to the enter door, then fade-IN there (0→1).
const TELE_HALF = 0.22;   // seconds per half

function rand(min, max) { return min + Math.random() * (max - min); }
// Shortest-path angular ease from `cur` toward `target`, at most `maxStep` rad.
function easeAngle(cur, target, maxStep) {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));   // wrap to [-π, π]
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export function createBehavior(scenepack, rng = Math.random) {
  const nRooms  = scenepack.rooms?.length || 1;
  const multi   = nRooms > 1;
  // Multi-room scenes wander across all rooms in global-u; single-room is unchanged.
  const anchors = multi ? multiRoomAnchors(scenepack) : sceneAnchors(scenepack);
  // Clamp keeps u inside the whole strip of rooms (0 … nRooms) for multi, or one room for single.
  const clamp = multi ? (u, v) => ({ u: Math.min(nRooms - 1e-4, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) }) : clampFloor;
  const zones = collectZones(scenepack, multi);   // no-walk polygons (floor / global-u space)
  // Doors: where the character enters each room/screen (one per room, in global-u). Used so a
  // cross-screen walk arrives THROUGH the doorway, and so the scene starts at the door.
  const doors = collectDoors(scenepack, multi);
  const roomOf = (u) => Math.min(nRooms - 1, Math.max(0, Math.floor(u)));
  const doorOf = (r) => doors[r] || null;
  const roomFloorOf = (r) => (multi ? scenepack.rooms?.[r]?.floor : scenepack.floor) || scenepack.floor;
  // Confine a position to the part of the floor that's actually ON the background image (the
  // [0,1] screen rect). The floor quad may stretch past the image for perspective, but the
  // character must stay on-image — off-image floor is ignored except for perspective. Keeps
  // the character (and thus its shadow) on its own screen.
  // Horizontal margin leaves room for the character's body width so its whole sprite stays on
  // its own screen (it turns around just before the screen edge instead of being cut at the
  // seam). Vertical margin is tiny so it can still use the near/far floor.
  const MARGIN_X = 0.12, MARGIN_Y = 0.01;
  function confineToImage(gu, v) {
    const r = roomOf(gu); let lu = Math.min(1, Math.max(0, gu - r)); v = Math.min(1, Math.max(0, v));
    const f = roomFloorOf(r); if (!f) return { u: r + lu, v };
    const s = floorToScreen(f, lu, v);
    const sx = Math.min(1 - MARGIN_X, Math.max(MARGIN_X, s.x));
    const sy = Math.min(1 - MARGIN_Y, Math.max(MARGIN_Y, s.y));
    if (sx !== s.x || sy !== s.y) {
      const fl = screenToFloor(f, sx, sy);
      lu = Math.min(1, Math.max(0, fl.u)); v = Math.min(1, Math.max(0, fl.v));
    }
    return { u: r + lu, v };
  }
  // A path to `target`: same room → route around zones; another room → walk OUT this room's
  // door, IN the target room's door, then to the target. So crossings happen through doorways.
  const planPath = (from, target) => {
    if (multi) {
      const ra = roomOf(from.u), rb = roomOf(target.u);
      if (ra !== rb) {
        const wps = [];
        // Tag the two door waypoints so update() can teleport between them (vanish at the exit
        // door, reappear at the enter door) instead of walking the character across the seam.
        const exit = doorOf(ra); if (exit) wps.push({ u: exit.u, v: exit.v, doorExit: true });
        const enter = doorOf(rb); if (enter) wps.push({ u: enter.u, v: enter.v, doorEnter: true });
        const legFrom = enter ? { u: enter.u, v: enter.v } : from;
        return [...wps, ...findPath(legFrom, target, zones)];
      }
    }
    return findPath(from, target, zones);
  };

  // ── Hard no-walk enforcement ──────────────────────────────────────────────────
  // Pathing routes around zones, but a target INSIDE a zone (or a boxed-in fallback) could
  // still march the character straight in. These guards make a zone a true wall: the
  // character can never stand in one, and a step that would enter one is blocked/slid.
  function nearestOutside(u, v) {   // push a point that's inside a zone just past its nearest edge
    for (const poly of zones) {
      if (!pointInPolygon(u, v, poly)) continue;
      let best = null;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const ax = poly[j].x, ay = poly[j].y, bx = poly[i].x, by = poly[i].y;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
        let t = ((u - ax) * dx + (v - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy, d = Math.hypot(u - cx, v - cy);
        if (!best || d < best.d) best = { d, cx, cy };
      }
      // Step OUTWARD from the nearest edge point (away from the interior point), so the result
      // lands just OUTSIDE the zone. (u-cx,v-cy) points inward, so subtract it.
      if (best) { const ox = u - best.cx, oy = v - best.cy, m = Math.hypot(ox, oy) || 1; u = best.cx - ox / m * 0.04; v = best.cy - oy / m * 0.04; }
    }
    return { u, v };
  }
  const wander  = scenepack.wander || {};
  // Tray "Random Walking" toggle: true/false forces roaming on/off; null follows the scenepack.
  let wanderOverride = null;
  const start   = anchors.find(a => a.weight > 0) || anchors[0]
                || { id: null, u: 0.5, v: 0.7, animation: null, facing: 'front' };

  // Each repeatMinutes>0 anchor gets a clock that counts up to its interval; when
  // it elapses we force a visit and reset it.
  const scheduled = anchors
    .filter(a => a.repeatMinutes > 0)
    .map(a => ({ anchor: a, every: Math.max(1, a.repeatMinutes * 60), t: 0 }));

  const startYaw = FACING_YAW[start.facing] ?? 0;
  // Enter the scene at a door if one exists (the room of the starting anchor, else room 0).
  const startDoor = doorOf(roomOf(start.u)) || doorOf(0);
  const startPos = confineToImage(startDoor ? startDoor.u : start.u, startDoor ? startDoor.v : start.v);
  const st = {
    phase: 'idle',                 // 'idle' | 'walking'
    pos: { u: startPos.u, v: startPos.v },
    yaw: startYaw,
    targetYaw: startYaw,           // yaw eases toward this each frame (smooth turning)
    current: start,                // anchor we're at / came from
    target: null,                  // anchor we're walking to
    path: null, wp: 0,             // planned waypoints around no-walk zones
    forced: false,                 // target came from the scheduler
    dwell: dwellFor(start),
    timer: 0,
  };

  // Per-anchor wait time if set (>0), else a random dwell from the wander config.
  function dwellFor(a) {
    return (a && a.dwell > 0) ? a.dwell : rand(wander.idleMin ?? 4, wander.idleMax ?? 12);
  }

  // Start walking to a target; the path (around no-walk zones) is planned lazily next tick.
  // A target inside a zone is pulled just outside first, so we never aim into a no-walk area.
  function beginWalk(target, forced) {
    let safe = nearestOutside(target.u, target.v);   // out of no-walk zones…
    safe = confineToImage(safe.u, safe.v);           // …and onto the in-image floor
    st.target = { ...target, u: safe.u, v: safe.v };
    st.forced = forced; st.phase = 'walking'; st.path = null; st.wp = 0;
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
      // Roam gate: with Random Walking toggled off, the character stays parked — no wandering
      // and no scheduled visits. User-initiated moves (goTo/goToAnchor via click-to-move or
      // prop clicks) still work, and idle/idle-break animations keep playing.
      const roamOn = wanderOverride == null ? (wander.enabled !== false) : wanderOverride;
      const due = roamOn ? dueScheduled() : null;
      if (due) {
        beginWalk(due.anchor, true);
        due.t = 0; st.timer = 0;
      } else {
        const canWander = roamOn
          && anchors.some(a => a.weight > 0 && a.id !== st.current?.id);
        if (canWander && st.timer >= st.dwell) {
          const next = pickAnchor(anchors, st.current?.id);
          if (next) beginWalk(next, false);
          st.timer = 0;
        }
      }
    } else if (st.phase === 'walking' && st.target) {
      // Follow the planned path (waypoints around no-walk zones) toward the final target.
      if (!st.path) { st.path = planPath(st.pos, st.target); st.wp = 0; }
      const wp = st.path[st.wp] || st.target;
      const du = wp.u - st.pos.u, dv = wp.v - st.pos.v;
      const distUV = Math.hypot(du, dv);
      const step = (wander.walkSpeed ?? 0.12) * dt;
      if (distUV <= step || distUV < 1e-4) {
        st.pos = { u: wp.u, v: wp.v };
        const nxt = st.path[st.wp + 1];
        if (wp.doorExit && nxt && nxt.doorEnter) {
          // Reached this screen's door with the next waypoint being the OTHER screen's door:
          // teleport across instead of walking the seam. Fade out here, then reappear there.
          st.phase = 'teleport'; st.teleT = 0; st.teleSnapped = false;
          st.teleEnter = { u: nxt.u, v: nxt.v };
          st.wp += 2;   // consume both door waypoints; resume at the next real waypoint
        } else {
          st.wp++;
          if (st.wp >= st.path.length) {
            // Arrived at the final target: turn (smoothly) to its facing, go idle.
            st.current = st.target; st.target = null; st.path = null; st.forced = false;
            st.phase = 'idle'; st.timer = 0;
            st.dwell = dwellFor(st.current);
            const f = FACING_YAW[st.current.facing];
            if (f !== undefined) st.targetYaw = f;   // 'auto' keeps the walk-in heading
          }
        }
      } else {
        // Follow the validated waypoint smoothly (the path already routes around zones/walls;
        // no per-step blocking here — that traps the character and breaks cross-room travel).
        st.pos.u += (du / distUV) * step;
        st.pos.v += (dv / distUV) * step;
        const y = facingYaw(du, dv);
        if (y !== null) st.targetYaw = y;
      }
    } else if (st.phase === 'teleport') {
      // Door crossing: fade out at the exit door, snap to the enter door at the midpoint,
      // fade back in there, then resume the walk toward the target.
      st.teleT += dt;
      if (st.teleT >= TELE_HALF && !st.teleSnapped) {
        st.pos = { u: st.teleEnter.u, v: st.teleEnter.v };   // reappear at the other screen's door
        st.teleSnapped = true;
      }
      if (st.teleT >= TELE_HALF * 2) st.phase = 'walking';   // continue to the target from here
    }
    // Smoothly rotate toward the target heading/facing instead of snapping.
    st.yaw = easeAngle(st.yaw, st.targetYaw, TURN_SPEED * dt);
    const c = confineToImage(st.pos.u, st.pos.v);   // render only on the in-image floor
    const offset = (st.phase === 'idle' && st.current?.offset) || { x: 0, y: 0 };
    // Character opacity: 1 normally; during a door teleport it dips 1→0 (vanish into the door)
    // then climbs 0→1 (reappear at the other door). The renderer fades the model + its shadow.
    let fade = 1;
    if (st.phase === 'teleport') {
      fade = st.teleT < TELE_HALF ? 1 - st.teleT / TELE_HALF : (st.teleT - TELE_HALF) / TELE_HALF;
      fade = Math.max(0, Math.min(1, fade));
    }
    return { u: c.u, v: c.v, yaw: st.yaw, moving: st.phase === 'walking', clip: clipFor(), offset, fade };
  }

  // Force-walk to a specific floor point (e.g. user clicked the scene). Optional.
  function goTo(u, v) {
    beginWalk({ id: null, u, v, animation: null, facing: 'auto' }, false);
  }

  // Walk to a specific anchor/prop and play its animation on arrival — used when the
  // user clicks a prop. `a` is an anchor-shaped object { u, v, animation, facing,
  // offset, dwell }.
  function goToAnchor(a) {
    if (!a) return;
    beginWalk({ id: a.id || null, u: a.u, v: a.v, animation: a.animation || null,
      facing: a.facing || 'auto', offset: a.offset || { x: 0, y: 0 }, dwell: a.dwell || 0 }, true);
    st.timer = 0;
  }

  // Commit a floor-space displacement to the character's CURRENT position (used by
  // root-motion travel: a clip that walks/jumps forward moves the character for real, so
  // the next wander walks from where it ended — not from where it started). Only meaningful
  // while idle; ignored mid-walk (the walk already drives st.pos).
  function translate(du, dv) {
    if (st.phase !== 'idle') return;
    const c = clamp(st.pos.u + du, st.pos.v + dv);
    st.pos.u = c.u; st.pos.v = c.v;
  }

  // Force roaming on/off from outside (tray toggle); pass null to follow the scenepack again.
  function setWander(v) { wanderOverride = (v == null) ? null : !!v; }

  return { update, goTo, goToAnchor, translate, setWander, state: st };
}
