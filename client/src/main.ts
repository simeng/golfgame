import { DbConnection } from "./module_bindings";
import PlayerRowSchema from "./module_bindings/player_table";
import RoundRowSchema from "./module_bindings/round_table";
import { Identity, Infer } from "spacetimedb";

type PlayerRow = Infer<typeof PlayerRowSchema>;
type RoundRow = Infer<typeof RoundRowSchema>;
import {
  BALL_R,
  Ball,
  DEFAULT_TEE_X,
  DEFAULT_TEE_Y,
  estimateTHalf,
  fullSubstep,
  generateHole,
  Hole,
  HOLE_R,
  holePar,
  MAX_SHOT,
  MIN_SHOT,
  SETTLE_EPS,
  simulateShot,
  speed,
  straightDrivePower,
  SUB_DT,
  Vec2,
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
// player (same ball + same round if still inside the 30 s grace period).
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

const playerRows = new Map<string, PlayerRow>(); // all players (latest rows, incl. me)
const snaps = new Map<string, Snap<PlayerRow>>(); // interpolation snapshots for others

// round + course
let round: RoundRow = { id: 0, phase: 0, seed: 0, holes: 0, holeIdx: 0 };
let hole: Hole | null = null;
let holeKey = "";

// my ball: fully predicted locally with the exact server physics
const myBall = {
  state: 0 as 0 | 1 | 2, // ball_state: 0 ready, 1 rolling, 2 holed
  ball: null as Ball | null,
};
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
function myRow(): PlayerRow | null {
  return myIdentityHex ? playerRows.get(myIdentityHex) ?? null : null;
}

/**
 * Reconcile the locally predicted ball with a server row. Position/velocity
 * lerp 50%, hard-snap when far off; the authoritative age (drives the gravity
 * fade) lerps with a snap guard.
 */
function adoptBall(p: PlayerRow): void {
  myBall.state = p.ballState as 0 | 1 | 2;
  if (p.ballState === 1) {
    if (!myBall.ball) {
      myBall.ball = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, age: p.shotAge, tHalf: p.tHalf };
      return;
    }
    const b = myBall.ball;
    const ex = p.x - b.x;
    const ey = p.y - b.y;
    if (ex * ex + ey * ey > 40 * 40) {
      b.x = p.x;
      b.y = p.y;
      b.vx = p.vx;
      b.vy = p.vy;
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
    myBall.ball = { x: p.x, y: p.y, vx: 0, vy: 0, age: 0, tHalf: 0 };
  }
}

function applyPlayerInsert(p: PlayerRow): void {
  const now = performance.now();
  if (isMine(p)) {
    meId = pid(p);
    myName = p.name;
    playerRows.set(meId, p);
    adoptBall(p);
    setOverlay(false);
  } else {
    playerRows.set(pid(p), p);
    snaps.set(pid(p), { prev: null, curr: p, tPrev: now, tCurr: now });
  }
  updatePanels();
}

function applyPlayerUpdate(_old: PlayerRow, p: PlayerRow): void {
  const id = pid(p);
  if (isMine(p)) {
    if (meId === null) {
      meId = id;
      myName = p.name;
    }
    playerRows.set(id, p);
    adoptBall(p);
  } else {
    playerRows.set(id, p);
    const s = snaps.get(id);
    const now = performance.now();
    if (s) {
      s.prev = s.curr;
      s.tPrev = s.tCurr;
      s.curr = p;
      s.tCurr = now;
    } else {
      snaps.set(id, { prev: null, curr: p, tPrev: now, tCurr: now });
    }
  }
  updatePanels();
}

function applyPlayerDelete(row: PlayerRow): void {
  const id = pid(row);
  playerRows.delete(id);
  snaps.delete(id);
  if (id === meId) {
    // server removed us (grace expired)
    meId = null;
    myBall.ball = null;
    myBall.state = 0;
    setOverlay(true);
    setOverlayMsg("Your round was cleared (30 s away). Tee off again!");
  }
  updatePanels();
}

function applyRound(r: RoundRow): void {
  const key = `${r.seed}:${r.holeIdx}`;
  round = r;
  if (r.phase === 1) {
    if (key !== holeKey) {
      holeKey = key;
      hole = generateHole(r.seed, r.holeIdx);
      flashHole(`HOLE ${r.holeIdx + 1} / ${r.holes}`);
    }
  } else if (r.phase === 0) {
    hole = null;
    holeKey = "";
  }
  updatePanels();
}

/** After the subscription snapshot lands, check whether we have a ball to rejoin. */
async function tryRejoin(): Promise<void> {
  if (meId !== null || !myIdentityHex) return;
  try {
    const row = db.db.player.identity.find(new Identity(myIdentityHex));
    if (row) {
      myName = (row as PlayerRow).name;
      applyPlayerInsert(row as PlayerRow);
      persistIdentity();
      console.log("rejoined as", myName, "phase", (row as PlayerRow).phase);
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
  } catch (e) {
    console.error(e);
    setOverlayMsg("Tee-off failed: " + String(e));
  }
}

async function sendHit(dx: number, dy: number, power: number): Promise<void> {
  try {
    await db.reducers.hit({ dx, dy, power });
    // optimistic local state so prediction starts on this very frame
    if (myBall.ball) {
      const d = Math.hypot(dx, dy);
      myBall.ball.vx = (dx / d) * power;
      myBall.ball.vy = (dy / d) * power;
      myBall.ball.age = 0;
      myBall.ball.tHalf = estimateTHalf(power);
      myBall.state = 1;
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
async function sendPickCourse(holes: number): Promise<void> {
  try {
    await db.reducers.pickCourse({ holes });
  } catch (e) {
    console.warn("pickCourse failed", e);
  }
}
async function sendStart(): Promise<void> {
  try {
    await db.reducers.startMatch({});
  } catch (e) {
    console.warn("startMatch failed", e);
  }
}
async function sendToLobby(): Promise<void> {
  try {
    await db.reducers.toLobby({});
  } catch (e) {
    console.warn("toLobby failed", e);
  }
}

// ---------------------------------------------------------------------------
// HUD / panels
// ---------------------------------------------------------------------------

const overlay = document.getElementById("overlay")!;
const overlayMsg = document.getElementById("overlay-msg")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const hud = document.getElementById("hud")!;
const lobbyEl = document.getElementById("lobby")!;
const lobbyPlayers = document.getElementById("lobby-players")!;
const lobbyCount = document.getElementById("lobby-count")!;
const lobbyStart = document.getElementById("lobby-start") as HTMLButtonElement;
const lobbyNote = document.getElementById("lobby-note")!;
const pick8 = document.getElementById("pick-8") as HTMLButtonElement;
const pick16 = document.getElementById("pick-16") as HTMLButtonElement;
const scoreboardEl = document.getElementById("scoreboard")!;
const scoreboardTitle = document.getElementById("scoreboard-title")!;
const scoreboardRows = document.getElementById("scoreboard-rows")!;
const finishedEl = document.getElementById("finished")!;
const finishedRows = document.getElementById("finished-rows")!;
const chip = document.getElementById("chip")!;
const holecard = document.getElementById("holecard")!;

function setOverlay(show: boolean): void {
  overlay.style.display = show ? "flex" : "none";
}
function setOverlayMsg(msg: string): void {
  overlayMsg.textContent = msg;
}

let holecardTimer = 0;
function flashHole(text: string): void {
  holecard.textContent = text;
  holecard.classList.remove("show");
  void holecard.offsetWidth; // restart the CSS animation
  holecard.classList.add("show");
  clearTimeout(holecardTimer);
  holecardTimer = window.setTimeout(() => holecard.classList.remove("show"), 1600);
}

function majorityHoles(): number {
  let n8 = 0;
  let n16 = 0;
  for (const p of playerRows.values()) {
    if (p.courseChoice === 1) n16++;
    else n8++;
  }
  return n16 > n8 ? 16 : 8;
}

function ballColor(hex: string): string {
  const palette: Array<[number, number, number]> = [
    [255, 150, 120],
    [120, 200, 255],
    [170, 230, 130],
    [230, 180, 250],
    [250, 220, 120],
    [140, 230, 220],
  ];
  let h = 0;
  for (let i = 0; i < hex.length; i += 2) h = (h * 31 + parseInt(hex.substr(i, 2), 16)) | 0;
  const c = palette[Math.abs(h) % palette.length];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

interface RowInfo {
  id: string;
  name: string;
  phase: number;
  ballState: number;
  strokes: number;
  total: number;
  connected: boolean;
  mine: boolean;
}

function rowInfo(p: PlayerRow): RowInfo {
  return {
    id: pid(p),
    name: p.name,
    phase: p.phase,
    ballState: p.ballState,
    strokes: p.strokes,
    total: p.totalStrokes,
    connected: p.connected,
    mine: p.phase !== undefined && isMine(p),
  };
}

function sortedInfos(): RowInfo[] {
  const infos = Array.from(playerRows.values()).map(rowInfo);
  const inRound = round.phase === 2;
  infos.sort((a, b) => {
    const aActive = a.phase === 1;
    const bActive = b.phase === 1;
    if (inRound) {
      // final standings: in-round players by total, spectators last
      const aFin = a.phase === 2 ? 0 : 1;
      const bFin = b.phase === 2 ? 0 : 1;
      if (aFin !== bFin) return aFin - bFin;
      return a.total - b.total || a.name.localeCompare(b.name);
    }
    // live scoreboard: holed first (by total), then rolling/ready (by strokes)
    const aHoled = a.ballState === 2 ? 0 : 1;
    const bHoled = b.ballState === 2 ? 0 : 1;
    if (aHoled !== bHoled) return aHoled - bHoled;
    if (aActive !== bActive) return aActive ? -1 : 1;
    const key = aHoled === 0 ? a.total : a.strokes;
    const key2 = bHoled === 0 ? b.total : b.strokes;
    return key - key2 || a.name.localeCompare(b.name);
  });
  return infos;
}

function updatePanels(): void {
  const me = myRow();
  // lobby
  const showLobby = me !== null && me.phase === 0 && round.phase !== 2;
  lobbyEl.style.display = showLobby ? "flex" : "none";
  if (showLobby) {
    lobbyCount.textContent = `${playerRows.size}/10 golfers`;
    const rows = sortedInfos();
    lobbyPlayers.innerHTML = rows
      .map(
        (r) =>
          `<div class="lp${r.mine ? " me" : ""}${r.connected ? "" : " away"}">
             <span class="dot" style="background:${ballColor(r.id)}"></span>
             <span class="nm">${r.name}</span>
             <span class="ch">${playerChoiceText(r.id)}</span>
           </div>`,
      )
      .join("");
    const choice = me.courseChoice;
    pick8.classList.toggle("active", choice === 0);
    pick16.classList.toggle("active", choice === 1);
    if (round.phase === 0) {
      lobbyStart.disabled = false;
      lobbyStart.textContent = `START MATCH — ${majorityHoles()} holes (majority choice)`;
      lobbyNote.textContent = "Everyone plays the same holes at the same time. Anyone can start; tie on 8/16 goes to 8.";
    } else {
      lobbyStart.disabled = true;
      lobbyStart.textContent = "ROUND IN PROGRESS — SPECTATING";
      lobbyNote.textContent = "You joined mid-round. Watch the live scoreboard; join the next round after it's over.";
    }
  }
  // scoreboard
  const showBoard = me !== null && round.phase >= 1;
  scoreboardEl.style.display = showBoard ? "block" : "none";
  if (showBoard) {
    scoreboardTitle.textContent = round.phase === 2 ? `FINAL — ${round.holes} holes` : `HOLE ${round.holeIdx + 1} / ${round.holes}`;
    scoreboardRows.innerHTML = sortedInfos()
      .map(
        (r) =>
          `<div class="sr${r.mine ? " me" : ""}${r.connected ? "" : " away"}">
             <span class="nm">${r.name}${r.mine ? " (you)" : ""}${r.connected ? "" : " · away"}</span>
             <span class="num">${round.phase === 2 ? r.total : r.ballState === 2 ? r.total : r.strokes}</span>
             <span class="num dim">${round.phase === 2 ? "" : r.ballState === 2 ? "✓ in" : r.phase === 0 ? "lobby" : ""}</span>
           </div>`,
      )
      .join("");
  }
  // finished panel
  finishedEl.style.display = round.phase === 2 ? "flex" : "none";
  if (round.phase === 2) {
    const infos = sortedInfos();
    finishedRows.innerHTML = infos
      .map(
        (r, i) =>
          `<div class="fr${r.mine ? " me" : ""}">
             <span class="rank">${r.phase === 2 ? i + 1 : "–"}</span>
             <span class="nm">${r.name}${r.mine ? " (you)" : ""}</span>
             <span class="num">${r.phase === 2 ? `${r.total} strokes` : "spectated"}</span>
           </div>`,
      )
      .join("");
  }
  // chip: my status during a live round
  if (me && round.phase === 1) {
    if (me.ballState === 2) chip.textContent = "IN! — spectating until everyone's in the cup";
    else if (me.phase === 0) chip.textContent = "spectating — round in progress";
    else chip.textContent = "";
    chip.style.display = chip.textContent ? "block" : "none";
  } else {
    chip.style.display = "none";
  }
}

function playerChoiceText(id: string): string {
  const p = playerRows.get(id);
  if (!p) return "";
  return p.phase === 0 ? (p.courseChoice === 1 ? "16 holes" : "8 holes") : "in round";
}

nameInput.value = localStorage.getItem(LS_NAME) || "golfer-" + Math.floor(Math.random() * 900 + 100);
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
pick8.onclick = () => void sendPickCourse(8);
pick16.onclick = () => void sendPickCourse(16);
lobbyStart.onclick = () => void sendStart();
(document.getElementById("lobby-leave") as HTMLButtonElement).onclick = () => void sendToLobby();
(document.getElementById("to-lobby") as HTMLButtonElement).onclick = () => void sendToLobby();
window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") void sendRetee();
});

// ---------------------------------------------------------------------------
// Input (slingshot aiming)
// ---------------------------------------------------------------------------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function toWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
}

function canAim(): boolean {
  const me = myRow();
  return me !== null && me.phase === 1 && myBall.state === 0 && hole !== null;
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  if (e.button !== 0) return;
  const w = toWorld(e.clientX, e.clientY);
  pointer.x = w.x;
  pointer.y = w.y;
  pointer.down = true;
  if (canAim() && myBall.ball) {
    aiming = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e: PointerEvent) => {
  const w = toWorld(e.clientX, e.clientY);
  pointer.x = w.x;
  pointer.y = w.y;
});
canvas.addEventListener("pointerup", () => {
  pointer.down = false;
  if (!aiming) return;
  aiming = false;
  if (lastAim && lastAim.power >= MIN_SHOT && canAim()) {
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

function drawPlanet(p: { x: number; y: number; r: number }, gmult: number): void {
  const x = sx(p.x);
  const y = sy(p.y);
  const r = p.r * view.scale;
  // gravity well glow — bright while a shot's gravity is active
  const glow = 0.1 + 0.5 * gmult;
  const wellR = r * 2.6;
  const gwell = ctx.createRadialGradient(x, y, r * 0.5, x, y, wellR);
  gwell.addColorStop(0, `rgba(120,200,255,${glow * 0.55})`);
  gwell.addColorStop(1, "rgba(120,200,255,0)");
  ctx.fillStyle = gwell;
  ctx.beginPath();
  ctx.arc(x, y, wellR, 0, Math.PI * 2);
  ctx.fill();
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

function drawCup(cup: Vec2): void {
  const x = sx(cup.x);
  const y = sy(cup.y);
  const r = HOLE_R * view.scale;
  ctx.fillStyle = "rgba(120,220,150,0.35)";
  ctx.beginPath();
  ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
  ctx.fill();
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

function drawTeeMark(tee: Vec2): void {
  const x = sx(tee.x);
  const y = sy(tee.y);
  ctx.strokeStyle = "rgba(220,240,255,0.4)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(x, y, 26 * view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function interp<T extends { x: number; y: number }>(s: Snap<T>, at: number): T {
  if (!s.prev || s.tCurr === s.tPrev) return s.curr;
  const a = Math.min(1, Math.max(0, (at - s.tPrev) / (s.tCurr - s.tPrev)));
  return { ...s.curr, x: s.prev.x + (s.curr.x - s.prev.x) * a, y: s.prev.y + (s.curr.y - s.prev.y) * a };
}

function drawAim(): void {
  if (!aiming || !canAim() || !myBall.ball || !hole) return;
  const b = myBall.ball;
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
  const sim = simulateShot(b.x, b.y, dx * power, dy * power, tHalf, hole, 8, 4);

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

  // power meter + straight-drive hint
  const px = sx(b.x);
  const py = sy(b.y);
  const frac = power / MAX_SHOT;
  ctx.fillStyle = "rgba(10,16,26,0.7)";
  ctx.fillRect(px - 34, py - 46, 68, 8);
  ctx.fillStyle = frac > 0.85 ? "#ff8080" : frac > 0.5 ? "#ffc060" : "#90e0a0";
  ctx.fillRect(px - 33, py - 45, 66 * frac, 6);
  ctx.fillStyle = "rgba(230,240,255,0.9)";
  ctx.font = "10px monospace";
  const straight = straightDrivePower(Math.hypot(hole.cup.x - b.x, hole.cup.y - b.y));
  ctx.fillText(`${Math.round(power)} px/s  ·  straight: ${Math.round(straight)}`, px, py - 52);
}

function draw(): void {
  const now = performance.now();
  const renderT = now - INTERP_DELAY;

  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, W, H);

  // course surface
  ctx.fillStyle = "#0b2417";
  ctx.fillRect(sx(0), sy(0), WORLD_W * view.scale, WORLD_H * view.scale);
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  for (let i = 0; i < WORLD_W; i += 200) {
    ctx.fillRect(sx(i), sy(0), 100 * view.scale, WORLD_H * view.scale);
  }
  ctx.strokeStyle = "#3d5a80";
  ctx.lineWidth = 6;
  ctx.strokeRect(sx(0), sy(0), WORLD_W * view.scale, WORLD_H * view.scale);

  const me = myRow();
  const myGmult =
    me && me.phase === 1 && myBall.state === 1 && myBall.ball
      ? Math.max(0, 1 - myBall.ball.age / myBall.ball.tHalf)
      : 0;

  if (hole) {
    for (const p of hole.planets) drawPlanet(p, myGmult);
    drawTeeMark(hole.tee);
    drawCup(hole.cup);
  } else {
    // lobby: no course yet
    drawTeeMark({ x: DEFAULT_TEE_X, y: DEFAULT_TEE_Y });
    ctx.fillStyle = "rgba(200,225,205,0.5)";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.fillText("the course is generated when the round starts", sx(WORLD_W / 2), sy(WORLD_H / 2));
  }

  // other players (interpolated)
  for (const [id, s] of snaps) {
    const p = interp(s, renderT);
    const label = `${p.name} · ${p.ballState === 2 ? "in" : p.strokes}${p.connected ? "" : " (away)"}`;
    drawBall(p.x, p.y, ballColor(id), label, !p.connected);
  }

  // my ball
  if (me && myBall.ball) {
    const b = myBall.ball;
    if (me.phase === 1 && myBall.state === 2 && hole) {
      drawBall(hole.cup.x, hole.cup.y, "#ffffff", `${me.name} · in`, false);
    } else {
      drawBall(b.x, b.y, "#ffffff", `${me.name} (you)`, false);
    }
  }

  drawAim();

  // HUD
  if (me) {
    let lines = "";
    if (me.phase === 1 && hole) {
      const par = holePar(hole);
      lines += `Hole ${round.holeIdx + 1}/${round.holes} · par ${par}\n`;
      const stateTxt =
        myBall.state === 0
          ? "ready — drag to aim"
          : myBall.state === 1
            ? `rolling · gravity ${Math.round(myGmult * 100)}%`
            : "in the cup — spectating";
      lines += `${stateTxt}\n`;
    } else if (me.phase === 0) {
      lines += round.phase === 1 ? "spectating a live round\n" : "in the lobby\n";
    } else {
      lines += "round over\n";
    }
    lines += `strokes ${me.strokes} · total ${me.totalStrokes} · R = re-tee`;
    hud.textContent = lines;
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

  const me = myRow();
  if (me && me.phase === 1 && myBall.state === 1 && myBall.ball && hole) {
    // advance the exact number of server-sized substeps that fit in dt
    acc += dt;
    let steps = 0;
    while (acc >= SUB_DT && steps < 64) {
      acc -= SUB_DT;
      steps++;
      const holed = fullSubstep(myBall.ball, hole);
      if (holed) {
        myBall.state = 2;
        break;
      }
      const b = myBall.ball;
      const gmult = Math.max(0, 1 - b.age / b.tHalf);
      if (gmult <= 0 && speed(b) < SETTLE_EPS) {
        b.vx = 0;
        b.vy = 0;
        myBall.state = 0;
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
db.db.round.onInsert((_ctx, r) => applyRound(r as RoundRow));
db.db.round.onUpdate((_ctx, _old, r) => applyRound(r as RoundRow));

requestAnimationFrame(frame);
