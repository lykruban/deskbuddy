// floor.js — perspective math for scene mode.
//
// A "floor" is a quad drawn on the 2D background during scene setup, given by its
// four corners in NORMALIZED screen coords (0..1, origin top-left):
//
//     farLeft ──────── farRight       (v = 0, the back edge — smaller/further)
//        │                │
//     nearLeft ─────── nearRight      (v = 1, the front edge — bigger/closer)
//
// A character's logical position on the floor is (u, v):
//   u = 0 (left)  → 1 (right)
//   v = 0 (far)   → 1 (near, toward the camera)
//
// Everything the scene needs — screen position, perspective scale, walk facing —
// derives from this quad, so the scene designer only ever draws four dots. No
// camera matching, no FOV math. Pure functions, no three.js dependency, so this
// is trivially unit-testable in node.

export function lerp(a, b, t) { return a + (b - a) * t; }

export function clampFloor(u, v) {
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}

// PERSPECTIVE mapping of the unit square (u,v) → the quad, via the projective
// transform (homography) that takes the corners
//   (0,0)→farLeft  (1,0)→farRight  (1,1)→nearRight  (0,1)→nearLeft.
// Unlike bilinear interpolation, this foreshortens correctly: equal steps in v bunch
// up toward the back edge, exactly like a real floor receding to a vanishing point.
// (Heckbert, "Projective Mappings for Image Warping".)
function quadCoeffs(q) {
  const x0 = q.farLeft.x,  y0 = q.farLeft.y;
  const x1 = q.farRight.x, y1 = q.farRight.y;
  const x2 = q.nearRight.x, y2 = q.nearRight.y;
  const x3 = q.nearLeft.x,  y3 = q.nearLeft.y;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {   // affine (parallelogram)
    return { a11: x1 - x0, a21: x2 - x1, a31: x0, a12: y1 - y0, a22: y2 - y1, a32: y0, a13: 0, a23: 0, a33: 1 };
  }
  const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const a13 = (dx3 * dy2 - dx2 * dy3) / den;
  const a23 = (dx1 * dy3 - dx3 * dy1) / den;
  return {
    a11: x1 - x0 + a13 * x1, a21: x3 - x0 + a23 * x3, a31: x0,
    a12: y1 - y0 + a13 * y1, a22: y3 - y0 + a23 * y3, a32: y0,
    a13, a23, a33: 1,
  };
}

// (u, v) → normalized screen point (perspective-correct).
export function floorToScreen(quad, u, v) {
  const c = quadCoeffs(quad);
  const w = c.a13 * u + c.a23 * v + c.a33 || 1e-9;
  return { x: (c.a11 * u + c.a21 * v + c.a31) / w, y: (c.a12 * u + c.a22 * v + c.a32) / w };
}

// Horizontal screen width of the floor at depth v (left edge → right edge), now
// perspective-correct so the far edge is properly narrower than the near edge.
export function widthAt(quad, v) {
  const l = floorToScreen(quad, 0, v), r = floorToScreen(quad, 1, v);
  return Math.hypot(r.x - l.x, r.y - l.y);
}

// Perspective scale at depth v, normalized so scale === 1 at refV (default the
// near edge). This is what makes the character shrink as it walks away — for free,
// straight from the quad's shape.
export function depthScaleAt(quad, v, refV = 1) {
  const ref = widthAt(quad, refV);
  if (ref < 1e-6) return 1;
  return widthAt(quad, v) / ref;
}

// Walk facing as a yaw (radians) to ADD on top of the character's base "faces the
// camera" orientation. du = +right, dv = +toward camera.
//   toward camera (dv>0) → 0 (front)   right (du>0) → +90°
//   away (dv<0) → 180°                  left  (du<0) → -90°
export function facingYaw(du, dv) {
  if (Math.abs(du) < 1e-6 && Math.abs(dv) < 1e-6) return null; // not moving → keep facing
  return Math.atan2(du, dv);
}

// Screen point → (u, v): the exact inverse of the homography above (the inverse of a
// projective map is just another projective map — the adjugate of its matrix). Used
// for editor clicks ("where on the floor did I click?"). Returned (u,v) is clamped.
export function screenToFloor(quad, x, y) {
  const c = quadCoeffs(quad);
  // M = [[a11,a21,a31],[a12,a22,a32],[a13,a23,a33]] maps (u,v,1)→(wx,wy,w).
  const m00 = c.a11, m01 = c.a21, m02 = c.a31;
  const m10 = c.a12, m11 = c.a22, m12 = c.a32;
  const m20 = c.a13, m21 = c.a23, m22 = c.a33;
  // adjugate (transpose of cofactors) — sufficient since we only need ratios.
  const A00 = m11 * m22 - m12 * m21, A01 = m02 * m21 - m01 * m22, A02 = m01 * m12 - m02 * m11;
  const A10 = m12 * m20 - m10 * m22, A11 = m00 * m22 - m02 * m20, A12 = m02 * m10 - m00 * m12;
  const A20 = m10 * m21 - m11 * m20, A21 = m01 * m20 - m00 * m21, A22 = m00 * m11 - m01 * m10;
  const U = A00 * x + A01 * y + A02;
  const V = A10 * x + A11 * y + A12;
  const W = A20 * x + A21 * y + A22 || 1e-9;
  return clampFloor(U / W, V / W);
}

// Split a global-u coordinate (spanning N rooms left→right, room i = u∈[i,i+1)) into
// { room, u } with room clamped to [0, N-1] and u in [0,1]. Used by multi-display scenes
// to figure out which screen/room a character is in and where within it.
export function splitGlobalU(globalU, nRooms) {
  let room = Math.floor(globalU);
  if (room < 0) room = 0;
  if (room > nRooms - 1) room = nRooms - 1;
  return { room, u: Math.min(1, Math.max(0, globalU - room)) };
}

// Default centered quad (a sensible starting shape before the designer adjusts it).
export function defaultQuad() {
  return {
    farLeft:  { x: 0.30, y: 0.55 }, farRight:  { x: 0.70, y: 0.55 },
    nearLeft: { x: 0.10, y: 0.92 }, nearRight: { x: 0.90, y: 0.92 },
  };
}
