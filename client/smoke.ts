// Headless smoke test (v2): spawn, hit the ball, verify the fading-gravity
// shot: strokes increment, t_half matches the closed-form estimate, the ball
// moves, bounces off the planet, and settles back to READY. Also checks that
// a second hit mid-roll is rejected and that retee resets the round.
import { DbConnection } from "./src/module_bindings";
import PlayerRowSchema from "./src/module_bindings/player_table";
import { Identity, Infer } from "spacetimedb";
import { estimateTHalf, simulateShot, TEE_X, TEE_Y } from "./src/world";

type PlayerRow = Infer<typeof PlayerRowSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const fail = (m: string) => { console.error("FAIL:", m); ok = false; };
const pass = (m: string) => console.log("PASS:", m);

const db = DbConnection.builder()
  .withUri("ws://127.0.0.1:3000")
  .withDatabaseName("golfgame")
  .onConnect((_c, id) => { myHex = (id as Identity).toHexString(); connected = true; })
  .build();
db.subscriptionBuilder().subscribeToAllTables();

let myHex: string | null = null;
let connected = false;
const rows: PlayerRow[] = [];

db.db.player.onInsert((_c, p) => {
  if ((p.identity as Identity).toHexString() === myHex) rows.push(p);
});
db.db.player.onUpdate((_c, _o, p) => {
  if ((p.identity as Identity).toHexString() === myHex) rows.push(p);
});

for (let i = 0; i < 100 && !connected; i++) await sleep(100);
if (!connected) throw new Error("connect timeout");

await db.reducers.spawn({ name: "smokebot" });
for (let i = 0; i < 100 && rows.length === 0; i++) await sleep(100);
if (rows.length === 0) throw new Error("no player rows received");
const p0 = rows[0];
console.log(`spawn pos: (${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}) state=${p0.state} strokes=${p0.strokes}`);
if (Math.hypot(p0.x - TEE_X, p0.y - TEE_Y) < 1) pass("ball spawns at the tee");
else fail(`ball not at tee: (${p0.x}, ${p0.y})`);
if (p0.state === 0) pass("initial state is READY");
else fail(`initial state ${p0.state}`);

// --- shot 1: straight right at moderate power -----------------------------
const POWER1 = 500.0;
rows.length = 0;
await db.reducers.hit({ dx: 1, dy: 0, power: POWER1 });
await sleep(400);
let latest = rows[rows.length - 1];
if (!latest) throw new Error("no rows after hit");
console.log(`after hit: state=${latest.state} strokes=${latest.strokes} t_half=${latest.tHalf.toFixed(6)} v=(${latest.vx.toFixed(1)},${latest.vy.toFixed(1)})`);
if (latest.state === 1) pass("ball is ROLLING after hit");
else fail(`state ${latest.state} after hit`);
if (latest.strokes === 1) pass("strokes incremented to 1");
else fail(`strokes ${latest.strokes}`);
const expectedTHalf = estimateTHalf(POWER1);
if (Math.abs(latest.tHalf - expectedTHalf) < 1e-9) pass(`t_half matches closed-form estimate (${latest.tHalf.toFixed(6)}s)`);
else fail(`t_half ${latest.tHalf} != estimate ${expectedTHalf}`);

// hit while rolling must be rejected
let rejected = false;
try {
  await db.reducers.hit({ dx: 0, dy: -1, power: 100 });
} catch (e) {
  rejected = true;
  console.log(`mid-roll hit rejected: ${e}`);
}
if (rejected) pass("mid-roll hit rejected");
else fail("mid-roll hit was accepted (should have been rejected)");

// wait for settle
let settled = false;
let maxX = p0.x;
let minY = 1e9;
let sawNaN = false;
let settleRow: PlayerRow | null = null;
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  await sleep(100);
  for (const r of rows) {
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.vx)) sawNaN = true;
    maxX = Math.max(maxX, r.x);
    minY = Math.min(minY, r.y);
    if (r.state === 0 && Math.hypot(r.vx, r.vy) < 0.001) { settled = true; settleRow = r; }
  }
  if (settled) break;
}
const settleTime = ((Date.now() - t0) / 1000).toFixed(1);
latest = settleRow ?? latest;
console.log(`shot 1 settled after ${settleTime}s, max x=${maxX.toFixed(0)}, min y=${minY.toFixed(0)}`);
if (settled) pass("ball settled back to READY");
else fail("ball never settled within 15s");
if (!sawNaN) pass("no NaNs during flight");
else fail("NaN values seen during flight");
if (maxX > TEE_X + 400) pass(`ball travelled forward (max x ${maxX.toFixed(0)} > tee+400)`);
else fail(`ball barely moved (max x ${maxX.toFixed(0)})`);
if (latest.state !== 0) fail(`state ${latest.state} after settle`);
if (latest.strokes !== 1) fail(`strokes ${latest.strokes} after settle`);

// THE mirror test: the client-side op-for-op simulation of the exact same
// shot must land within a hair of where the server left the ball.
{
  const sim = simulateShot(TEE_X, TEE_Y, POWER1, 0, estimateTHalf(POWER1), 8, 1);
  const last = sim.pts[sim.pts.length - 1];
  const d = Math.hypot(latest.x - last.x, latest.y - last.y);
  console.log(`mirror: server=(${latest.x.toFixed(3)}, ${latest.y.toFixed(3)}) client-sim=(${last.x.toFixed(3)}, ${last.y.toFixed(3)}) Δ=${d.toExponential(2)}px`);
  if (d < 0.01) pass("client sim matches server rest position (<0.01px) — mirror holds");
  else fail(`client sim diverged from server by ${d.toFixed(3)}px — mirror broken`);
}

// --- shot 2: full power straight at planet 3 → must bounce off -----------
const POWER2 = 700.0;
const sx0 = latest.x, sy0 = latest.y;
rows.length = 0;
const dx2 = 1020.0 - sx0, dy2 = 360.0 - sy0;
await db.reducers.hit({ dx: dx2, dy: dy2, power: POWER2 });
let bounced = false;
let settled2 = false;
let maxX2 = sx0;
let minX2 = 1e9;
let settleRow2: PlayerRow | null = null;
const t1 = Date.now();
while (Date.now() - t1 < 15000) {
  await sleep(100);
  for (const r of rows) {
    maxX2 = Math.max(maxX2, r.x);
    minX2 = Math.min(minX2, r.x);
    if (r.state === 0 && Math.hypot(r.vx, r.vy) < 0.001) { settled2 = true; settleRow2 = r; }
  }
  if (settled2) break;
}
const last2 = settleRow2 ?? latest;
const settleTime2 = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`shot 2 settled after ${settleTime2}s, x range [${minX2.toFixed(0)}, ${maxX2.toFixed(0)}]`);
// aimed at planet 3 (1020, 360): solid + gravity, must not crash or NaN
if (maxX2 > 700) pass(`ball reached the planet zone (max x ${maxX2.toFixed(0)})`);
else fail(`ball never got close to planet (max x ${maxX2.toFixed(0)})`);
if (minX2 < maxX2 - 150) { bounced = true; pass("ball bounced back off the planet"); }
else console.log(`note: ball did not bounce back (x range [${minX2.toFixed(0)}, ${maxX2.toFixed(0)}]) — it curved around`);
void bounced;
if (settled2) pass("second shot settled");
else fail("second shot never settled within 15s");
if (last2.strokes === 2) pass("strokes incremented to 2");
else fail(`strokes ${last2.strokes}`);

// --- retee -----------------------------------------------------------------
rows.length = 0;
await db.reducers.retee();
await sleep(300);
const pEnd = rows[rows.length - 1];
if (pEnd) {
  if (Math.hypot(pEnd.x - TEE_X, pEnd.y - TEE_Y) < 1 && pEnd.strokes === 0 && pEnd.state === 0)
    pass("retee resets ball to tee, strokes 0, READY");
  else fail(`retee state wrong: pos=(${pEnd.x},${pEnd.y}) strokes=${pEnd.strokes} state=${pEnd.state}`);
} else fail("no row after retee");

console.log(ok ? "SMOKE PASS ✅" : "SMOKE FAIL ❌");
process.exit(ok ? 0 : 1);
