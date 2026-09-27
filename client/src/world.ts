// Shared world model — MUST stay bit-for-bit mirrored with spacetimedb/src/lib.rs (Rust).
// Same constants, same order of operations, f64 math on both sides.
// All hash math is 32-bit integer ops so JS (Math.imul/>>>) and Rust (u32 wrapping) agree.

// --- course geometry (mirror lib.rs) --------------------------------------

export const WORLD_W = 1600.0;
export const WORLD_H = 900.0;
export const BALL_R = 8.0;
export const HOLE_R = 15.0;
export const CAPTURE_SPEED = 100.0;
export const DEFAULT_TEE_X = 140.0; // lobby parking spot
export const DEFAULT_TEE_Y = 450.0;

// --- physics constants (mirror lib.rs) -------------------------------------

export const FRICTION = 120.0; // constant rolling deceleration, px/s^2
const G_GOLF = 4500.0;
const MIN_D = 26.0;
const REST = 0.86;
export const MAX_SHOT = 700.0;
export const MIN_SHOT = 30.0;
export const SETTLE_EPS = 2.0;
export const GEN_CORRIDOR = 75.0; // half-width of the guaranteed straight tee→cup path
export const GEN_MARGIN = 10.0; // extra safety clearance on the corridor

export const TICK_HZ = 20;
export const SUBSTEPS = 8;
export const SUB_DT = 1.0 / TICK_HZ / SUBSTEPS; // the exact substep the server uses

// --- the fading-gravity estimate (mirror of lib.rs estimate_t_half) --------

/**
 * Closed-form estimate: time for a gravity-free ball shot at v0 to cover half
 * of its total stopping distance. t_half = (v0/FRICTION) * (1 - sqrt(2)/2).
 * This is the gravity-fade duration, frozen at shot time.
 */
export function estimateTHalf(v0: number): number {
  return (v0 / FRICTION) * (1.0 - Math.SQRT2 / 2.0);
}

// --- random course generation (mirror of lib.rs, op-for-op) -----------------

export interface Planet {
  x: number;
  y: number;
  r: number;
}
export interface Vec2 {
  x: number;
  y: number;
}
export interface Hole {
  planets: Planet[];
  tee: Vec2;
  cup: Vec2;
}

// murmur3 finalizer (identical op order to Rust fmix)
function fmix(x: number): number {
  x = (x ^ (x >>> 16)) | 0;
  x = Math.imul(x, 0x85ebca6b);
  x = (x ^ (x >>> 13)) | 0;
  x = Math.imul(x, 0xc2b2ae35);
  x = (x ^ (x >>> 16)) | 0;
  return x >>> 0;
}

// 24-bit float in [0,1) — exact in f64
function t(h: number): number {
  return ((h >>> 8) & 0x00ffffff) / 16777216.0;
}

// Deterministic value n of the hole stream derived from seed.
function gen(seed: number, n: number): number {
  const a = fmix(seed);
  const b = fmix((n + 0x9e3779b9) | 0);
  return t(fmix((a ^ ((Math.imul(b, 0x85ebca6b) + 0xcc9e2d51) | 0)) | 0));
}

/** Exact distance from a point to a segment (mirrored in Rust). */
export function pointSegDist(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const tparam = len2 > 0.0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0.0;
  const qx = x0 + dx * tparam;
  const qy = y0 + dy * tparam;
  const ex = px - qx;
  const ey = py - qy;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Generate the layout of one hole from (seed, hole index) — identical to the
 * server. Values are drawn from gen() in a FIXED ORDER; planets are
 * rejection-sampled with a corridor guarantee: the straight tee→cup line
 * stays >= r + 75 + 10 clear of every planet, so a straight drive can always
 * reach the cup.
 */
export function generateHole(seed: number, holeIdx: number): Hole {
  const s = (seed ^ fmix((holeIdx + 1) | 0)) >>> 0;
  let i = 0;
  const draw = (): number => {
    const v = gen(s, i);
    i = (i + 1) | 0;
    return v;
  };

  // tee / cup boxes (right/left), sometimes mirrored
  const flip = draw() < 0.5;
  let teeX = 80.0 + draw() * 340.0;
  let teeY = 80.0 + draw() * 740.0;
  let cupX = 1180.0 + draw() * 340.0;
  let cupY = 80.0 + draw() * 740.0;
  if (flip) {
    const tx = teeX;
    teeX = cupX;
    cupX = tx;
  }
  // redraw until tee and cup are meaningfully apart (deterministic bound)
  for (let k = 0; k < 24; k++) {
    const ddx = teeX - cupX;
    const ddy = teeY - cupY;
    if (ddx * ddx + ddy * ddy >= 700.0 * 700.0) break;
    teeX = 80.0 + draw() * 340.0;
    teeY = 80.0 + draw() * 740.0;
    cupX = 1180.0 + draw() * 340.0;
    cupY = 80.0 + draw() * 740.0;
    if (flip) {
      const tx = teeX;
      teeX = cupX;
      cupX = tx;
    }
  }

  // planets: 4..6, rejection-sampled
  const nPlanets = 4 + Math.floor(draw() * 3.0);
  const planets: Planet[] = [];
  for (let k = 0; k < nPlanets; k++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const px = 100.0 + draw() * (WORLD_W - 200.0);
      const py = 100.0 + draw() * (WORLD_H - 200.0);
      const r = 35.0 + draw() * 30.0;
      if (px - r < 50.0 || px + r > WORLD_W - 50.0 || py - r < 50.0 || py + r > WORLD_H - 50.0) continue;
      // guaranteed path: the straight tee→cup line stays clear
      if (pointSegDist(px, py, teeX, teeY, cupX, cupY) < r + GEN_CORRIDOR + GEN_MARGIN) continue;
      const dtx = px - teeX;
      const dty = py - teeY;
      if (dtx * dtx + dty * dty < (r + 90.0) * (r + 90.0)) continue;
      const dcx = px - cupX;
      const dcy = py - cupY;
      if (dcx * dcx + dcy * dcy < (r + 100.0) * (r + 100.0)) continue;
      let clear = true;
      for (const q of planets) {
        const dqx = px - q.x;
        const dqy = py - q.y;
        const need = r + q.r + 80.0;
        if (dqx * dqx + dqy * dqy < need * need) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      planets.push({ x: px, y: py, r });
      break;
    }
  }

  return { planets, tee: { x: teeX, y: teeY }, cup: { x: cupX, y: cupY } };
}

/** Par for a hole (display only): short = 3, long = 4. */
export function holePar(h: Hole): number {
  const dx = h.cup.x - h.tee.x;
  const dy = h.cup.y - h.tee.y;
  return Math.sqrt(dx * dx + dy * dy) < 1000.0 ? 3 : 4;
}

/** Power for a straight drive that stops exactly at distance d (aim hint). */
export function straightDrivePower(d: number): number {
  return Math.min(Math.sqrt(2.0 * FRICTION * Math.max(0, d)), MAX_SHOT);
}

// --- physics step (mirrored by server tick, op-for-op) ----------------------

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number; // seconds since the current shot (drives the gravity fade)
  tHalf: number; // fade duration, frozen at shot time
}

/** Sum of gravitational acceleration from the hole's planets, scaled by gmult. */
export function gravity(x: number, y: number, gmult: number, hole: Hole): [number, number] {
  let ax = 0.0;
  let ay = 0.0;
  for (const p of hole.planets) {
    const dx = p.x - x;
    const dy = p.y - y;
    let d2 = dx * dx + dy * dy;
    if (d2 < MIN_D * MIN_D) d2 = MIN_D * MIN_D;
    const d = Math.sqrt(d2);
    const a = (G_GOLF * p.r * p.r) / d2 * gmult;
    ax += (a * dx) / d;
    ay += (a * dy) / d;
  }
  return [ax, ay];
}

/**
 * One physics substep: gravity (faded) → friction → integrate.
 * MUST be op-for-op identical to server `step_ball`.
 */
export function stepBall(b: Ball, dt: number, hole: Hole): void {
  b.age += dt;
  const gmult = Math.max(0.0, 1.0 - b.age / b.tHalf);

  const [gx, gy] = gravity(b.x, b.y, gmult, hole);
  b.vx += gx * dt;
  b.vy += gy * dt;

  // constant rolling friction (deceleration, not proportional drag)
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  if (sp > 0.0) {
    const decel = FRICTION * dt;
    if (decel >= sp) {
      b.vx = 0.0;
      b.vy = 0.0;
    } else {
      const k = (sp - decel) / sp;
      b.vx *= k;
      b.vy *= k;
    }
  }

  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

/** Circle vs circle (planet). Bounces with restitution. */
export function collidePlanet(b: Ball, p: Planet): void {
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const rr = BALL_R + p.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0.0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  b.x = p.x + nx * rr;
  b.y = p.y + ny * rr;
  const vdotn = b.vx * nx + b.vy * ny;
  if (vdotn < 0.0) {
    b.vx -= (1.0 + REST) * vdotn * nx;
    b.vy -= (1.0 + REST) * vdotn * ny;
  }
}

/** Outer boundary bounce. */
export function collideBoundary(b: Ball): void {
  if (b.x < BALL_R) {
    b.x = BALL_R;
    if (b.vx < 0.0) b.vx = -b.vx * REST;
  } else if (b.x > WORLD_W - BALL_R) {
    b.x = WORLD_W - BALL_R;
    if (b.vx > 0.0) b.vx = -b.vx * REST;
  }
  if (b.y < BALL_R) {
    b.y = BALL_R;
    if (b.vy < 0.0) b.vy = -b.vy * REST;
  } else if (b.y > WORLD_H - BALL_R) {
    b.y = WORLD_H - BALL_R;
    if (b.vy > 0.0) b.vy = -b.vy * REST;
  }
}

export function speed(b: Ball): number {
  return Math.sqrt(b.vx * b.vx + b.vy * b.vy);
}

/**
 * Run one full server-style substep (step + all collisions) on the ball,
 * exactly as the tick reducer does. Returns true if the ball was captured in
 * the cup. Settle is NOT applied here — the caller decides (mirrors server).
 */
export function fullSubstep(b: Ball, hole: Hole): boolean {
  stepBall(b, SUB_DT, hole);
  collideBoundary(b);
  for (const p of hole.planets) collidePlanet(b, p);
  const hdx = b.x - hole.cup.x;
  const hdy = b.y - hole.cup.y;
  const hd = Math.sqrt(hdx * hdx + hdy * hdy);
  if (hd < HOLE_R && speed(b) < CAPTURE_SPEED) {
    b.x = hole.cup.x;
    b.y = hole.cup.y;
    b.vx = 0.0;
    b.vy = 0.0;
    return true;
  }
  return false;
}

/**
 * Simulate a shot from scratch (aim preview + client-side prediction).
 * Mirrors the server substep loop op-for-op: same SUB_DT, same collision
 * order, same settle rule (settle only once the gravity fade completes).
 */
export interface ShotSim {
  pts: { x: number; y: number; age: number }[];
  holed: boolean;
  settled: boolean;
  endAge: number;
}

export function simulateShot(
  x: number,
  y: number,
  vx: number,
  vy: number,
  tHalf: number,
  hole: Hole,
  maxSeconds: number,
  sampleEvery: number,
): ShotSim {
  const b: Ball = { x, y, vx, vy, age: 0, tHalf };
  const pts: ShotSim["pts"] = [{ x, y, age: 0 }];
  const maxSteps = Math.ceil(maxSeconds / SUB_DT);
  let holed = false;
  let settled = false;
  for (let k = 0; k < maxSteps; k++) {
    const wasHoled = fullSubstep(b, hole);
    if (k % sampleEvery === 0) pts.push({ x: b.x, y: b.y, age: b.age });
    if (wasHoled) {
      holed = true;
      break;
    }
    const gmult = Math.max(0.0, 1.0 - b.age / b.tHalf);
    if (gmult <= 0.0 && speed(b) < SETTLE_EPS) {
      b.vx = 0.0;
      b.vy = 0.0;
      settled = true;
      break;
    }
  }
  return { pts, holed, settled, endAge: b.age };
}

/**
 * Preview-only substep: same friction + collisions + cup capture as the
 * server, but WITHOUT gravity. Used ONLY by the aim guide — it shows the
 * naive gravity-free path, so the player has to account for the planets'
 * pull themselves (a full-fidelity preview made the game trivial).
 * Prediction/reconciliation keeps using the exact mirror (simulateShot).
 */
function previewSubstep(b: Ball, hole: Hole): boolean {
  b.age += SUB_DT;
  // constant rolling friction (identical arithmetic to step_ball)
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  if (sp > 0.0) {
    const decel = FRICTION * SUB_DT;
    if (decel >= sp) {
      b.vx = 0.0;
      b.vy = 0.0;
    } else {
      const k = (sp - decel) / sp;
      b.vx *= k;
      b.vy *= k;
    }
  }
  b.x += b.vx * SUB_DT;
  b.y += b.vy * SUB_DT;
  collideBoundary(b);
  for (const p of hole.planets) collidePlanet(b, p);
  const hdx = b.x - hole.cup.x;
  const hdy = b.y - hole.cup.y;
  const hd = Math.sqrt(hdx * hdx + hdy * hdy);
  if (hd < HOLE_R && speed(b) < CAPTURE_SPEED) {
    b.x = hole.cup.x;
    b.y = hole.cup.y;
    b.vx = 0.0;
    b.vy = 0.0;
    return true;
  }
  return false;
}

/** Gravity-free shot path for the aim guide (see previewSubstep). */
export function previewShot(
  x: number,
  y: number,
  vx: number,
  vy: number,
  hole: Hole,
  maxSeconds: number,
  sampleEvery: number,
): ShotSim {
  const b: Ball = { x, y, vx, vy, age: 0, tHalf: 0 };
  const pts: ShotSim["pts"] = [{ x, y, age: 0 }];
  const maxSteps = Math.ceil(maxSeconds / SUB_DT);
  let holed = false;
  let settled = false;
  for (let k = 0; k < maxSteps; k++) {
    const wasHoled = previewSubstep(b, hole);
    if (k % sampleEvery === 0) pts.push({ x: b.x, y: b.y, age: b.age });
    if (wasHoled) {
      holed = true;
      break;
    }
    if (speed(b) < SETTLE_EPS) {
      b.vx = 0.0;
      b.vy = 0.0;
      settled = true;
      break;
    }
  }
  return { pts, holed, settled, endAge: b.age };
}
