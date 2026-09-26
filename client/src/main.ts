import { DbConnection } from "./module_bindings";
import PlayerRowSchema from "./module_bindings/player_table";
import { Identity, Infer } from "spacetimedb";

type PlayerRow = Infer<typeof PlayerRowSchema>;
import {
  BALL_R,
  Ball,
  estimateTHalf,
  fullSubstep,
  HOLE_R,
  HOLE_X,
  HOLE_Y,
  MAX_SHOT,
  MIN_SHOT,
  PAR,
  Planet,
  PLANETS,
  SETTLE_EPS,
  simulateShot,
  speed,
  SUB_DT,
  TEE_X,
  TEE_Y,
  Wall,
  WALLS,
  WORLD_H,
  WORLD_W,
} from "./world";

// ---------------------------------------------------------------------------
// Server connection (v2 SDK — generated bindings)
// ---------------------------------------------------------------------------

const WS_URL = import.meta.env.VITE_WS ?? "ws://127.0.0.1:3000";
const DB_NAME = "golfgame";

// ---------------------------------------------------------------------------
// Persistent identity: localStorage token so a reload rejoins as the same
// player (same ball if still inside the 30 s grace period).
// ---------------------------------------------------------------------------

const HOST_KEY = new URL(WS_URL).host.replace(/[^a-z0-9.]/gi, "_");
const LS_TOKEN = `golfgame.${HOST_KEY}.token`;
const LS_IDENTITY = `golfgame.${HOST_KEY}.identity`;
const LS_NAME = `golfgame.${HOST_KEY}.name`;

const savedToken: string | null = localStorage.getItem(LS_TOKEN);
const savedIdentityHex: string | null = localStorage.getItem(LS_IDENTITY);
let serverToken: string | null = savedToken;

function persistIdentity(): void {
  if (!myIdentityHex) return;
  localStorage.setItem(LS_IDENTITY, myIdentityHex);
  if (serverToken) localStorage.setItem(LS_TOKEN, serverToken);
}

const dbBuilder = DbConnection.builder()
  .withUri(WS_URL)
  .withDatabaseName(DB_NAME);
if (savedToken) dbBuilder.withToken(savedToken);
const db = dbBuilder
  .onConnect((_conn, identity, token) => {
    myIdentityHex = (identity as Identity).toHexString();
    serverToken = token || null;
    setOverlayMsg("");
    console.log("connected, identity:", myIdentityHex);
    if (myIdentityHex !== savedIdentityHex && !wantToJoin) {
      localStorage.removeItem(LS_IDENTITY);
      localStorage.removeItem(LS_TOKEN);
    }
    if (meId === null && wantToJoin) void doSpawn();
  })
  .onDisconnect(() => {
    console.warn("disconnected from", WS_URL);
    setOverlayMsg("Lost connection to the game server.");
  })
  .build();

const subBuilder = db.subscriptionBuilder();
subBuilder.onApplied(() => void tryRejoin());
subBuilder.subscribeToAllTables();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Snap<T> {
  prev: T | null;
  curr: T;
  tPrev: number;
  tCurr: number;
}

const players = new Map<string, Snap<PlayerRow>>(); // other players (interpolated)

// my ball: fully predicted locally with the exact server physics
// state mirrors the server: 0 ready, 1 rolling, 2 holed
const myState = {
  state: 0 as 0 | 1 | 2,
  strokes: 0,
  ball: null as Ball | null,
};

function setMyState(s: 0 | 1 | 2): void {
  if (s === 2 && myState.state !== 2) showHoleBanner();
  myState.state = s;
}
let myIdentityHex: string | null = null;
let meId: string | null = null;
let myName = "";
let wantToJoin = false;

// aiming (slingshot)
let aiming = false;
const pointer = { x: 0, y: 0, down: false };
let lastAim: { dx: number; dy: number; power: number } | null = null;

const POWER_SCALE = MAX_SHOT / 300.0; // 300 px drag = full power
const INTERP_DELAY = 100;

function pid(row: PlayerRow): string {
  return (row.identity as Identity).toHexString();
}

function isMine(p: PlayerRow): boolean {
  return pid(p) === myIdentityHex;
}

/**
 * Reconcile the locally predicted ball with a server row. Position/velocity
 * lerp 50%, hard-snap when far off; the authoritative age (which drives the
 * gravity fade) is lerped with a snap guard.
 */
function adoptBall(p: PlayerRow): void {
  setMyState(p.state as 0 | 1 | 2);
  myState.strokes = p.strokes;
  if (p.state === 1) {
    if (!myState.ball) {
      // first time seeing this ball (spawn or rejoin mid-roll)
      myState.ball = {
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        age: p.shotAge, tHalf: p.tHalf,
      };
      return;
    }
    const b = myState.ball;
    const ex = p.x - b.x;
    const ey = p.y - b.y;
    if (ex * ex + ey * ey > 40 * 40) {
      b.x = p.x; b.y = p.y; b.vx = p.vx; b.vy = p.vy;
    } else {
      b.x += ex * 0.5;
      b.y += ey * 0.5;
      b.vx += (p.vx - b.vx) * 0.5;
      b.vy += (p.vy - b.vy) * 0.5;
    }
    const da = p.shotAge - b.age;
    if (Math.abs(da) > 0.1) b.age = p.shotAge;
    else b.age += da * 0.5;
    if (Math.abs(p.tHalf - b.tHalf) > 1e-9) b.tHalf = p.tHalf;
  } else {
    // settled or holed: adopt server state exactly, stop predicting
    myState.ball = {
      x: p.x, y: p.y, vx: 0, vy: 0,
      age: 0, tHalf: 0,
    };
  }
}

function applyPlayerInsert(p: PlayerRow): void {
  const now = performance.now();
  if (isMine(p)) {
    meId = pid(p);
    myName = p.name;
    adoptBall(p);
  } else {
    players.set(pid(p), { prev: null, curr: p, tPrev: now, tCurr: now });
  }
}

function applyPlayerUpdate(_old: PlayerRow, p: PlayerRow): void {
  const id = pid(p);
  if (isMine(p)) {
    if (meId === null) {
      meId = id;
      myName = p.name;
    }
    adoptBall(p);
    return;
  }
  const s = players.get(id);
  const now = performance.now();
  if (s) {
    s.prev = s.curr;
    s.tPrev = s.tCurr;
    s.curr = p;
    s.tCurr = now;
  } else {
    players.set(id, { prev: null, curr: p, tPrev: now, tCurr: now });
  }
}

function applyPlayerDelete(row: PlayerRow): void {
  const id = pid(row);
  if (id === meId) {
    // server removed us (grace expired)
    meId = null;
    myState.ball = null;
    myState.state = 0;
    setOverlay(true);
    setOverlayMsg("Your round was cleared (30 s away). Tee off again!");
  }
  players.delete(id);
}

/** After the subscription snapshot lands, check whether we have a ball to rejoin. */
async function tryRejoin(): Promise<void> {
  if (meId !== null || !myIdentityHex) return;
  try {
    const row = db.db.player.identity.find(new Identity(myIdentityHex));
    if (row) {
      myName = row.name;
      applyPlayerInsert(row as PlayerRow);
      persistIdentity();
      setOverlay(false);
      console.log("rejoined round as", myName);
    }
  } catch (e) {
    console.warn("rejoin lookup failed", e);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function doSpawn(): Promise<void> {
  try {
    await db.reducers.spawn({ name: myName });
    persistIdentity(); // remember this identity for the next visit
    localStorage.setItem(LS_NAME, myName);
    setOverlay(false);
  } catch (e) {
    console.error(e);
    setOverlayMsg("Tee-off failed: " + String(e));
  }
}

async function sendHit(dx: number, dy: number, power: number): Promise<void> {
  try {
    await db.reducers.hit({ dx, dy, power });
    // optimistic local state so prediction starts on this very frame
    if (myState.ball) {
      myState.ball.vx = (dx / Math.hypot(dx, dy)) * power;
      myState.ball.vy = (dy / Math.hypot(dx, dy)) * power;
      myState.ball.age = 0;
      myState.ball.tHalf = estimateTHalf(power);
      setMyState(1);
      myState.strokes += 1;
    }
  } catch (e) {
    console.warn("hit failed", e);
  }
}

async function sendRetee(): Promise<void> {
  try {
    await db.reducers.retee({});
  } catch (e) {
    console.warn("retee failed", e);
  }
}

// ---------------------------------------------------------------------------
// HUD / overlay
// ---------------------------------------------------------------------------

const overlay = document.getElementById("overlay")!;
const overlayMsg = document.getElementById("overlay-msg")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const hud = document.getElementById("hud")!;
const banner = document.getElementById("banner")!;
const bannerText = document.getElementById("banner-text")!;

function setOverlay(show: boolean): void {
  overlay.style.display = show ? "flex" : "none";
}
function setOverlayMsg(msg: string): void {
  overlayMsg.textContent = msg;
}
function showHoleBanner(): void {
  const s = myState.strokes;
  const diff = s - PAR;
  const label =
    diff < 0 ? `${s} — ${-diff} under par! 🏆` : diff === 0 ? `${s} — exactly par!` : `${s} — ${diff} over par`;
  bannerText.textContent = `HOLE IN ${label}`;
  banner.classList.add("show");
}

nameInput.value =
  localStorage.getItem(LS_NAME) || "golfer-" + Math.floor(Math.random() * 900 + 100);
if (savedIdentityHex)
  setOverlayMsg(`Returning as ${nameInput.value || "your last handle"} — your ball may still be out there.`);

function launch(): void {
  myName = nameInput.value.trim() || "golfer";
  wantToJoin = true;
  if (myIdentityHex) void doSpawn();
}
(document.getElementById("launch") as HTMLButtonElement).onclick = launch;
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") launch();
});
(document.getElementById("retee-btn") as HTMLButtonElement).onclick = () => {
  banner.classList.remove("show");
  void sendRetee();
};
window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") {
    banner.classList.remove("show");
    void sendRetee();
  }
});

// ---------------------------------------------------------------------------
// Input (slingshot aiming)
// ---------------------------------------------------------------------------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function toWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  if (e.button !== 0) return;
  const w = toWorld(e.clientX, e.clientY);
  pointer.x = w.x;
  pointer.y = w.y;
  pointer.down = true;
  if (meId !== null && myState.state === 0 && myState.ball) {
    aiming = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e: PointerEvent) => {
  const w = toWorld(e.clientX, e.clientY);
  pointer.x = w.x;
  pointer.y = w.y;
});
canvas.addEventListener("pointerup", (e: PointerEvent) => {
  pointer.down = false;
  if (!aiming) return;
  aiming = false;
  if (lastAim && lastAim.power >= MIN_SHOT && myState.state === 0) {
    void sendHit(lastAim.dx, lastAim.dy, lastAim.power);
  }
  lastAim = null;
});
canvas.addEventListener("pointercancel", () => {
  pointer.down = false;
  aiming = false;
  lastAim = null;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let W = 0;
let H = 0;
const view = { scale: 1, ox: 0, oy: 0 };
let fpsSmooth = 60;

function resize(): void {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  const pad = 40;
  view.scale = Math.min((W - pad) / WORLD_W, (H - pad) / WORLD_H);
  view.ox = (W - WORLD_W * view.scale) / 2;
  view.oy = (H - WORLD_H * view.scale) / 2;
}
window.addEventListener("resize", resize);
resize();

function sx(x: number): number {
  return x * view.scale + view.ox;
}
function sy(y: number): number {
  return y * view.scale + view.oy;
}

const BALL_COLORS: Array<[number, number, number]> = [
  [255, 150, 120],
  [120, 200, 255],
  [170, 230, 130],
  [230, 180, 250],
  [250, 220, 120],
  [140, 230, 220],
];
function playerColor(hex: string): string {
  let h = 0;
  for (let i = 0; i < hex.length; i += 2) {
    h = (h * 31 + parseInt(hex.substr(i, 2), 16)) | 0;
  }
  const c = BALL_COLORS[Math.abs(h) % BALL_COLORS.length];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawWall(w: Wall): void {
  const x = sx(w.x0);
  const y = sy(w.y0);
  const ww = (w.x1 - w.x0) * view.scale;
  const wh = (w.y1 - w.y0) * view.scale;
  ctx.fillStyle = "#2c3e50";
  ctx.fillRect(x, y, ww, wh);
  ctx.strokeStyle = "rgba(160,190,230,0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, ww - 2, wh - 2);
}

function drawPlanet(p: Planet, gmult: number): void {
  const x = sx(p.x);
  const y = sy(p.y);
  const r = p.r * view.scale;
  // gravity well glow — bright while a shot's gravity is active
  const glow = 0.10 + 0.5 * gmult;
  const wellR = r * 2.6;
  const gwell = ctx.createRadialGradient(x, y, r * 0.5, x, y, wellR);
  gwell.addColorStop(0, `rgba(120,200,255,${glow * 0.55})`);
  gwell.addColorStop(1, "rgba(120,200,255,0)");
  ctx.fillStyle = gwell;
  ctx.beginPath();
  ctx.arc(x, y, wellR, 0, Math.PI * 2);
  ctx.fill();
  // body
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, "#9fd7ff");
  g.addColorStop(0.6, "#3f7fbf");
  g.addColorStop(1, "#16304f");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(160,210,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHole(): void {
  const x = sx(HOLE_X);
  const y = sy(HOLE_Y);
  const r = HOLE_R * view.scale;
  // green rim
  ctx.fillStyle = "rgba(120,220,150,0.35)";
  ctx.beginPath();
  ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
  ctx.fill();
  // cup
  const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
  g.addColorStop(0, "#000000");
  g.addColorStop(1, "#101c14");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(220,240,255,0.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // flag
  ctx.strokeStyle = "rgba(230,240,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - r * 3.2);
  ctx.stroke();
  ctx.fillStyle = "#ff6b6b";
  ctx.beginPath();
  ctx.moveTo(x, y - r * 3.2);
  ctx.lineTo(x + r * 1.6, y - r * 2.7);
  ctx.lineTo(x, y - r * 2.2);
  ctx.closePath();
  ctx.fill();
}

function drawBall(x: number, y: number, color: string, label: string, ghost: boolean): void {
  const px = sx(x);
  const py = sy(y);
  const r = BALL_R * view.scale;
  if (ghost) ctx.globalAlpha = 0.4;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(px + 2, py + 3, r, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(px - r * 0.4, py - r * 0.4, r * 0.2, px, py, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.35, color);
  g.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  if (label) {
    ctx.fillStyle = "rgba(220,235,255,0.8)";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, px, py - r - 8);
  }
}

function drawTee(): void {
  const x = sx(TEE_X);
  const y = sy(TEE_Y);
  ctx.strokeStyle = "rgba(220,240,255,0.4)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(x, y, 22 * view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function interp<T extends { x: number; y: number }>(s: Snap<T>, at: number): T {
  if (!s.prev || s.tCurr === s.tPrev) return s.curr;
  const a = Math.min(1, Math.max(0, (at - s.tPrev) / (s.tCurr - s.tPrev)));
  return { ...s.curr, x: s.prev.x + (s.curr.x - s.prev.x) * a, y: s.prev.y + (s.curr.y - s.prev.y) * a };
}

function drawAim(): void {
  if (!aiming || !myState.ball || myState.state !== 0) return;
  const b = myState.ball;
  // recompute the current aim (slingshot: pull back, ball goes the other way)
  const ax = b.x - pointer.x;
  const ay = b.y - pointer.y;
  const alen = Math.hypot(ax, ay);
  const power = Math.min(alen * POWER_SCALE, MAX_SHOT);
  if (alen < 1 || power < MIN_SHOT) {
    lastAim = null;
    return;
  }
  const dx = ax / alen;
  const dy = ay / alen;
  lastAim = { dx, dy, power };

  const tHalf = estimateTHalf(power);
  const sim = simulateShot(b.x, b.y, dx * power, dy * power, tHalf, 8, 4);

  // pull band
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(sx(b.x), sy(b.y));
  ctx.lineTo(sx(pointer.x), sy(pointer.y));
  ctx.stroke();
  ctx.setLineDash([]);

  // predicted path: amber while gravity is active, white after the fade
  ctx.lineWidth = 2.5;
  for (let i = 0; i < sim.pts.length - 1; i++) {
    const p0 = sim.pts[i];
    const p1 = sim.pts[i + 1];
    const active = p0.age <= tHalf;
    ctx.strokeStyle = active ? "rgba(255,190,80,0.85)" : "rgba(220,235,255,0.5)";
    ctx.beginPath();
    ctx.moveTo(sx(p0.x), sy(p0.y));
    ctx.lineTo(sx(p1.x), sy(p1.y));
    ctx.stroke();
  }
  // marker where gravity fades out
  let fadePt = sim.pts[0];
  for (const p of sim.pts) {
    if (p.age <= tHalf) fadePt = p;
    else break;
  }
  ctx.strokeStyle = "rgba(255,190,80,0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(sx(fadePt.x), sy(fadePt.y), 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,190,80,0.9)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.fillText("gravity fades", sx(fadePt.x), sy(fadePt.y) - 12);

  // power meter near the ball
  const px = sx(b.x);
  const py = sy(b.y);
  const frac = power / MAX_SHOT;
  ctx.fillStyle = "rgba(10,16,26,0.7)";
  ctx.fillRect(px - 30, py - 46, 60, 8);
  ctx.fillStyle = frac > 0.85 ? "#ff8080" : frac > 0.5 ? "#ffc060" : "#90e0a0";
  ctx.fillRect(px - 29, py - 45, 58 * frac, 6);
  ctx.fillStyle = "rgba(230,240,255,0.9)";
  ctx.font = "10px monospace";
  ctx.fillText(`${Math.round(power)} px/s`, px, py - 52);
}

function draw(): void {
  const now = performance.now();
  const renderT = now - INTERP_DELAY;

  // backdrop
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, W, H);

  // course surface
  ctx.fillStyle = "#0b2417";
  ctx.fillRect(sx(0), sy(0), WORLD_W * view.scale, WORLD_H * view.scale);
  // mowing stripes
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  for (let i = 0; i < WORLD_W; i += 200) {
    ctx.fillRect(sx(i), sy(0), 100 * view.scale, WORLD_H * view.scale);
  }
  // outer boundary
  ctx.strokeStyle = "#3d5a80";
  ctx.lineWidth = 6;
  ctx.strokeRect(sx(0), sy(0), WORLD_W * view.scale, WORLD_H * view.scale);

  // gravity multiplier for my ball (drives the planet glow)
  const myGmult =
    myState.state === 1 && myState.ball ? Math.max(0, 1 - myState.ball.age / myState.ball.tHalf) : 0;

  for (const w of WALLS) drawWall(w);
  for (const p of PLANETS) drawPlanet(p, myGmult);
  drawTee();
  drawHole();

  // other players (interpolated)
  for (const [id, s] of players) {
    const p = interp(s, renderT);
    const label = p.connected ? `${p.name} · ${p.strokes}` : `${p.name} · ${p.strokes} (away)`;
    drawBall(p.x, p.y, playerColor(id), label, !p.connected);
  }

  // my ball
  if (meId !== null && myState.ball) {
    const b = myState.ball;
    if (myState.state === 2) {
      // ball sitting in the cup
      drawBall(HOLE_X, HOLE_Y, "#ffffff", "you", false);
    } else {
      drawBall(b.x, b.y, "#ffffff", myName ? `you · ${myState.strokes}` : "you", false);
    }
  }

  drawAim();

  // HUD
  if (meId !== null) {
    const stateTxt =
      myState.state === 0 ? "ready — drag to aim" :
      myState.state === 1 && myState.ball ? `rolling · gravity ${Math.round(myGmult * 100)}%` :
      "holed!";
    hud.textContent =
      `${myName}  ·  strokes ${myState.strokes}  ·  par ${PAR}\n` +
      `${stateTxt}  ·  ${players.size + 1} on course  ·  ${Math.round(fpsSmooth)} fps\n` +
      `R = re-tee`;
  } else {
    hud.textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Main loop: local prediction of my ball with the exact server physics
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
let acc = 0; // substep accumulator

function frame(): void {
  const now = performance.now();
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (dt > 0.1) dt = 0.1;
  fpsSmooth += ((1 / Math.max(dt, 1e-4)) - fpsSmooth) * 0.05;

  if (meId !== null && myState.state === 1 && myState.ball) {
    // advance the exact number of server-sized substeps that fit in dt
    acc += dt;
    let steps = 0;
    while (acc >= SUB_DT && steps < 64) {
      acc -= SUB_DT;
      steps++;
      const holed = fullSubstep(myState.ball);
      if (holed) {
        setMyState(2);
        break;
      }
      const b = myState.ball;
      const gmult = Math.max(0, 1 - b.age / b.tHalf);
      if (gmult <= 0 && speed(b) < SETTLE_EPS) {
        b.vx = 0;
        b.vy = 0;
        setMyState(0);
        acc = 0;
        break;
      }
    }
    if (steps >= 64) acc = 0; // fell far behind; let reconciliation snap
  } else {
    acc = 0;
  }

  draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Wire up server streams + boot
// ---------------------------------------------------------------------------

db.db.player.onInsert((_ctx, p) => applyPlayerInsert(p));
db.db.player.onUpdate((_ctx, _old, p) => applyPlayerUpdate(_old, p));
db.db.player.onDelete((_ctx, row) => applyPlayerDelete(row));

requestAnimationFrame(frame);
