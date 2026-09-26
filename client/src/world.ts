// Shared world model — MUST stay bit-for-bit mirrored with spacetimedb/src/lib.rs (Rust).
// Same constants, same order of operations, f64 math on both sides.

// --- course geometry (mirror lib.rs) --------------------------------------

export const WORLD_W = 1600.0;
export const WORLD_H = 900.0;
export const BALL_R = 8.0;
export const TEE_X = 140.0;
export const TEE_Y = 450.0;
export const HOLE_X = 1460.0;
export const HOLE_Y = 450.0;
export const HOLE_R = 15.0;
export const CAPTURE_SPEED = 100.0;
export const PAR = 4;

export interface Planet {
  x: number;
  y: number;
  r: number;
}
export interface Wall {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const PLANETS: Planet[] = [
  { x: 580.0, y: 280.0, r: 50.0 },
  { x: 800.0, y: 620.0, r: 62.0 },
  { x: 1020.0, y: 360.0, r: 54.0 },
  { x: 1240.0, y: 640.0, r: 48.0 },
  { x: 1380.0, y: 280.0, r: 42.0 },
];

export const WALLS: Wall[] = [
  { x0: 420.0, y0: 0.0, x1: 460.0, y1: 380.0 },
  { x0: 950.0, y0: 520.0, x1: 990.0, y1: 900.0 },
  { x0: 1180.0, y0: 0.0, x1: 1220.0, y1: 300.0 },
];

// --- physics constants (mirror lib.rs) -------------------------------------

export const FRICTION = 120.0; // constant rolling deceleration, px/s^2
const G_GOLF = 500.0;
const MIN_D = 26.0;
const REST = 0.86;
export const MAX_SHOT = 700.0;
export const MIN_SHOT = 30.0;
export const SETTLE_EPS = 2.0;

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

// --- physics step (mirrored by server tick, op-for-op) ----------------------

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number; // seconds since the current shot (drives the gravity fade)
  tHalf: number; // fade duration, frozen at shot time
}

/** Sum of gravitational acceleration from all planets, scaled by gmult. */
export function gravity(x: number, y: number, gmult: number): [number, number] {
  let ax = 0.0;
  let ay = 0.0;
  for (const p of PLANETS) {
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
export function stepBall(b: Ball, dt: number): void {
  b.age += dt;
  const gmult = Math.max(0.0, 1.0 - b.age / b.tHalf);

  const [gx, gy] = gravity(b.x, b.y, gmult);
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

/** Circle vs AABB (closest point). Bounces with restitution. */
export function collideWall(b: Ball, w: Wall): void {
  const cx = Math.min(Math.max(b.x, w.x0), w.x1);
  const cy = Math.min(Math.max(b.y, w.y0), w.y1);
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= BALL_R * BALL_R || d2 === 0.0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  b.x = cx + nx * BALL_R;
  b.y = cy + ny * BALL_R;
  const vdotn = b.vx * nx + b.vy * ny;
  if (vdotn < 0.0) {
    b.vx -= (1.0 + REST) * vdotn * nx;
    b.vy -= (1.0 + REST) * vdotn * ny;
  }
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
 * the hole, false otherwise. Settle is NOT applied here — the caller decides
 * (mirrors the server, which checks after each substep).
 */
export function fullSubstep(b: Ball): boolean {
  stepBall(b, SUB_DT);
  collideBoundary(b);
  for (const w of WALLS) collideWall(b, w);
  for (const p of PLANETS) collidePlanet(b, p);
  const hdx = b.x - HOLE_X;
  const hdy = b.y - HOLE_Y;
  const hd = Math.sqrt(hdx * hdx + hdy * hdy);
  if (hd < HOLE_R && speed(b) < CAPTURE_SPEED) {
    b.x = HOLE_X;
    b.y = HOLE_Y;
    b.vx = 0.0;
    b.vy = 0.0;
    return true;
  }
  return false;
}

/**
 * Simulate a shot from scratch (for the aim preview and for client-side
 * prediction of our own ball). Mirrors the server substep loop op-for-op:
 * same SUB_DT, same collision order, same settle rule (settle only once the
 * gravity fade has fully completed).
 *
 * Returns sampled path points (every `sampleEvery` substeps) plus the outcome.
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
  maxSeconds: number,
  sampleEvery: number,
): ShotSim {
  const b: Ball = { x, y, vx, vy, age: 0, tHalf };
  const pts: ShotSim["pts"] = [{ x, y, age: 0 }];
  const maxSteps = Math.ceil(maxSeconds / SUB_DT);
  let holed = false;
  let settled = false;
  for (let k = 0; k < maxSteps; k++) {
    const wasHoled = fullSubstep(b);
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
