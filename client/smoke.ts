// Headless smoke test (v2): two players join the lobby, vote on course size
// (majority rule), start a match, verify the generated course guarantees a
// straight path to the cup, play putts until both balls are in (which must
// advance the hole), verify the mirror (client sim == server rest position),
// retee, to_lobby, and the 10-player cap.
import { DbConnection } from "./src/module_bindings";
import PlayerRowSchema from "./src/module_bindings/player_table";
import { Identity, Infer } from "spacetimedb";
import {
  estimateTHalf,
  FRICTION,
  GEN_CORRIDOR,
  GEN_MARGIN,
  generateHole,
  MAX_SHOT,
  MIN_SHOT,
  pointSegDist,
  simulateShot,
  straightDrivePower,
} from "./src/world";

type PlayerRow = Infer<typeof PlayerRowSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const fail = (m: string) => { console.error("FAIL:", m); ok = false; };
const pass = (m: string) => console.log("PASS:", m);

function makeConn(tag: string) {
  let myHex: string | null = null;
  let connected = false;
  const rows: PlayerRow[] = [];
  const db = DbConnection.builder()
    .withUri("ws://127.0.0.1:3000")
    .withDatabaseName("golfgame")
    .onConnect((_c, id) => { myHex = (id as Identity).toHexString(); connected = true; })
    .build();
  db.subscriptionBuilder().subscribeToAllTables();
  db.db.player.onInsert((_c, p) => {
    if ((p.identity as Identity).toHexString() === myHex) rows.push(p);
  });
  db.db.player.onUpdate((_c, _o, p) => {
    if ((p.identity as Identity).toHexString() === myHex) rows.push(p);
  });
  return { db, rows, me: () => myHex!, connected: () => connected };
}

// wait until my latest row satisfies pred (or timeout)
async function waitRow(conn: ReturnType<typeof makeConn>, pred: (r: PlayerRow) => boolean, ms: number): Promise<PlayerRow | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const last = conn.rows[conn.rows.length - 1];
    if (last && pred(last)) return last;
    await sleep(100);
  }
  return conn.rows[conn.rows.length - 1] ?? null;
}
async function waitRound(db: DbConnection, pred: (phase: number, holes: number, holeIdx: number, seed: number) => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = db.db.round.id.find(0);
    if (r && pred(r.phase, r.holes, r.holeIdx, r.seed)) return r;
    await sleep(100);
  }
  return null;
}

const A = makeConn();
const B = makeConn();
for (const c of [A, B]) {
  for (let i = 0; i < 100 && !c.connected(); i++) await sleep(100);
  if (!c.connected()) throw new Error("connect timeout");
}

// --- lobby ------------------------------------------------------------------
await A.db.reducers.spawn({ name: "smokebot" });
await B.db.reducers.spawn({ name: "smokebot2" });
const aLobby = await waitRow(A, (r) => r !== undefined, 5000);
const bLobby = await waitRow(B, (r) => r !== undefined, 5000);
if (!aLobby || !bLobby) throw new Error("no player rows");
console.log(`lobby: A phase=${aLobby.phase} B phase=${bLobby.phase} round=${(A.db.db.round.id.find(0)?.phase ?? -1)}`);
if (aLobby.phase === 0 && bLobby.phase === 0) pass("both players in the lobby");
else fail(`lobby phases: A=${aLobby.phase} B=${bLobby.phase}`);
// (tee spread grid corners sit up to sqrt(28²+14²)=31.3px from the tee center)
if (Math.hypot(aLobby.x - 140, aLobby.y - 450) < 35) pass("lobby balls parked at the default tee");
else fail(`lobby ball pos (${aLobby.x}, ${aLobby.y})`);

// voting: A wants 16, B wants 8 → tie → 8
await A.db.reducers.pickCourse({ holes: 16 });
await B.db.reducers.pickCourse({ holes: 8 });
await sleep(200);
let aVote = A.rows[A.rows.length - 1];
let bVote = B.rows[B.rows.length - 1];
if (aVote.courseChoice === 1 && bVote.courseChoice === 0) pass("course choices recorded (A=16, B=8)");
else fail(`choices: A=${aVote.courseChoice} B=${bVote.courseChoice}`);

// start
A.rows.length = 0;
B.rows.length = 0;
await A.db.reducers.startMatch({});
const round0 = await waitRound(A.db, (phase, holes) => phase === 1, 5000);
if (!round0) throw new Error("round never started");
console.log(`round started: holes=${round0.holes} seed=${round0.seed} holeIdx=${round0.holeIdx}`);
if (round0.holes === 8) pass("majority/tie → 8 holes");
else fail(`expected 8 holes (1-1 tie), got ${round0.holes}`);

const hole0 = generateHole(round0.seed, 0);
const aIn = await waitRow(A, (r) => r.phase === 1 && r.hole === 0, 5000);
const bIn = await waitRow(B, (r) => r.phase === 1 && r.hole === 0, 5000);
if (!aIn || !bIn) throw new Error("players never entered the round");
const da = Math.hypot(aIn.x - hole0.tee.x, aIn.y - hole0.tee.y);
const dbb = Math.hypot(bIn.x - hole0.tee.x, bIn.y - hole0.tee.y);
console.log(`tee spread: A=${da.toFixed(1)}px B=${dbb.toFixed(1)}px from tee`);
if (da < 35 && dbb < 35) pass("both balls placed at the generated tee (spread grid)");
else fail(`tee placement: A=${da.toFixed(1)} B=${dbb.toFixed(1)}`);
if (aIn.x !== bIn.x || aIn.y !== bIn.y) pass("tee balls don't stack (identity-spread)");
else fail("tee balls overlap exactly");

// --- course guarantee: straight tee→cup corridor is clear -------------------
{
  const minClear = Math.min(...hole0.planets.map((p) => pointSegDist(p.x, p.y, hole0.tee.x, hole0.tee.y, hole0.cup.x, hole0.cup.y) - p.r));
  console.log(`course: ${hole0.planets.length} planets, tee→cup d=${Math.hypot(hole0.cup.x - hole0.tee.x, hole0.cup.y - hole0.tee.y).toFixed(0)}px, min corridor clearance=${minClear.toFixed(1)}px`);
  if (hole0.planets.length >= 4 && hole0.planets.length <= 6) pass(`planet count ${hole0.planets.length} in [4,6]`);
  else fail(`planet count ${hole0.planets.length}`);
  if (minClear >= GEN_CORRIDOR) pass(`corridor clear: min clearance ${minClear.toFixed(1)}px >= ${GEN_CORRIDOR}`);
  else fail(`corridor blocked: clearance ${minClear.toFixed(1)}px < ${GEN_CORRIDOR}`);
  const dTee = Math.min(...hole0.planets.map((p) => Math.hypot(p.x - hole0.tee.x, p.y - hole0.tee.y) - p.r));
  const dCup = Math.min(...hole0.planets.map((p) => Math.hypot(p.x - hole0.cup.x, p.y - hole0.cup.y) - p.r));
  if (dTee >= 80 && dCup >= 90) pass(`tee/cup kept clear (tee ${dTee.toFixed(0)}px, cup ${dCup.toFixed(0)}px)`);
  else fail(`tee/cup too close: ${dTee.toFixed(0)}/${dCup.toFixed(0)}`);
}

// Strong gravity bends even short putts around planets, so blind "aim at the
// cup" no longer works. Instead, for approaches < 400px we SEARCH for a shot
// that drops: candidates are graded by the EXACT client mirror (bit-for-bit
// the server's physics, validated by the mirror test), and the first candidate
// that simulates as holed is guaranteed to hole out on the server.
function findFinishShot(bx: number, by: number, hole: ReturnType<typeof generateHole>): { dx: number; dy: number; power: number } | null {
  const d = Math.hypot(hole.cup.x - bx, hole.cup.y - by);
  const baseAng = Math.atan2(hole.cup.y - by, hole.cup.x - bx);
  const powers: number[] = [];
  for (const m of [0.8, 0.9, 1.0, 1.1, 1.25, 1.5]) {
    const p = straightDrivePower(d) * m;
    if (p >= MIN_SHOT && p <= MAX_SHOT) powers.push(p);
  }
  for (const extra of [40, 60, 90]) powers.push(extra);
  for (const offDeg of [0, -8, 8, -16, 16, -24, 24, -32, 32]) {
    for (const power of powers) {
      const ang = baseAng + (offDeg * Math.PI) / 180;
      const sim = simulateShot(bx, by, Math.cos(ang) * power, Math.sin(ang) * power, estimateTHalf(power), hole, 12, 8);
      if (sim.holed) return { dx: Math.cos(ang), dy: Math.sin(ang), power };
    }
  }
  return null;
}
// helper: putt at the cup until it drops (max 10 shots). Re-reads the round
// after every settle so it always aims at the CURRENT hole's cup.
async function puttUntilIn(conn: ReturnType<typeof makeConn>, tag: string, seed: number): Promise<boolean> {
  for (let shot = 0; shot < 10; shot++) {
    // wait for the ball to be ready (or holed)
    const r = await waitRow(conn, (q) => q.ballState === 0 || q.ballState === 2, 20000);
    if (!r) return false;
    if (r.ballState === 2) return true;
    const rr = conn.db.db.round.id.find(0);
    if (!rr) return false;
    const hole = generateHole(seed, rr.holeIdx);
    const cdx = hole.cup.x - r.x;
    const cdy = hole.cup.y - r.y;
    const d = Math.hypot(cdx, cdy);
    let aim: { dx: number; dy: number; power: number };
    if (d > 400) {
      aim = { dx: cdx / d, dy: cdy / d, power: straightDrivePower(d) };
    } else {
      aim = findFinishShot(r.x, r.y, hole) ?? { dx: cdx / d, dy: cdy / d, power: straightDrivePower(d + 12) };
    }
    const { dx, dy, power } = aim;
    const since = conn.rows.length; // keep history (the advance-reset row must survive)
    try {
      await conn.db.reducers.hit({ dx, dy, power });
    } catch (e) {
      console.log(`  ${tag} shot rejected: ${(e as Error).message}`);
      return false;
    }
    // wait for the next settle/capture AFTER this shot (last-row polls can
    // skip the capture row if it and the advance-reset row arrive in one batch)
    const settled = await waitRowAfter(conn, since, (q) => q.ballState === 0 || q.ballState === 2, 20000);
    if (!settled) return false;
    const dCup = Math.hypot(settled.x - hole.cup.x, settled.y - hole.cup.y);
    console.log(`  ${tag} shot ${shot + 1} (power ${power.toFixed(0)}): ${settled.ballState === 2 ? "IN THE CUP" : `settled ${dCup.toFixed(0)}px from cup (ball hole=${settled.hole})`}`);
    if (settled.ballState === 2) return true;
    if (dCup < 15) {
      // at rest inside the capture radius without dropping = engine bug
      fail(`${tag}: ball at rest ${dCup.toFixed(2)}px from cup but NOT captured (engine bug?)`);
      return false;
    }
  }
  return false;
}
// wait until a NEW row (arrived after index `since`) satisfies pred
async function waitRowAfter(conn: ReturnType<typeof makeConn>, since: number, pred: (r: ReturnType<typeof makeConn>["rows"][number]) => boolean, ms: number): Promise<ReturnType<typeof makeConn>["rows"][number] | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (conn.rows.length > since && pred(conn.rows[conn.rows.length - 1])) return conn.rows[conn.rows.length - 1];
    await sleep(50);
  }
  return conn.rows.length > since ? conn.rows[conn.rows.length - 1] : null;
}
// wait until ANY stored row satisfies pred (scans the full row history)
async function waitFind(conn: ReturnType<typeof makeConn>, pred: (r: ReturnType<typeof makeConn>["rows"][number]) => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = conn.rows.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

// --- shot 1 + mirror test (player A) ----------------------------------------
{
  let r = A.rows[A.rows.length - 1];
  const dx = hole0.cup.x - r.x;
  const dy = hole0.cup.y - r.y;
  const power = straightDrivePower(Math.hypot(dx, dy));
  A.rows.length = 0;
  await A.db.reducers.hit({ dx, dy, power });
  // mid-roll hit must be rejected
  let rejected = false;
  await sleep(250);
  try {
    await A.db.reducers.hit({ dx: 0, dy: -1, power: 100 });
  } catch {
    rejected = true;
  }
  if (rejected) pass("mid-roll hit rejected");
  else fail("mid-roll hit accepted");
  const settledA = await waitRow(A, (q) => q.ballState === 0 || q.ballState === 2, 20000);
  if (!settledA) throw new Error("A never settled");
  if (settledA.strokes >= 1 && settledA.totalStrokes === settledA.strokes) pass("strokes + total recorded");
  else fail(`strokes=${settledA.strokes} total=${settledA.totalStrokes}`);

  // THE mirror test: client sim of the identical shot must match the server
  const sim = simulateShot(r.x, r.y, (dx / Math.hypot(dx, dy)) * power, (dy / Math.hypot(dx, dy)) * power, estimateTHalf(power), hole0, 12, 1);
  const last = sim.pts[sim.pts.length - 1];
  const d = Math.hypot(settledA.x - last.x, settledA.y - last.y);
  console.log(`mirror: server=(${settledA.x.toFixed(3)}, ${settledA.y.toFixed(3)}) client-sim=(${last.x.toFixed(3)}, ${last.y.toFixed(3)}) Δ=${d.toExponential(2)}px`);
  if (d < 0.01) pass("client sim matches server rest position (<0.01px) — mirror holds");
  else fail(`client sim diverged from server by ${d.toFixed(3)}px — mirror broken`);

  const distCup = Math.hypot(settledA.x - hole0.cup.x, settledA.y - hole0.cup.y);
  // with strong fading gravity a straight drive can legitimately end 200-400px
  // off the cup line (that's the whole point of the mechanic)
  if (settledA.ballState === 2 || distCup < 500) pass(`straight drive reached the cup area (${distCup.toFixed(0)}px or holed)`);
  else fail(`straight drive fell short (${distCup.toFixed(0)}px from cup)`);
}

// --- both players finish the hole → hole must advance ------------------------
console.log("putting out (A and B)…");
const aInCup = await puttUntilIn(A, "A", round0.seed);
const bInCup = await puttUntilIn(B, "B", round0.seed);
if (aInCup) pass("A's ball in the cup");
else fail("A never holed in 8 shots");
if (bInCup) pass("B's ball in the cup");
else fail("B never holed in 8 shots");

const round1 = await waitRound(A.db, (phase, holes, holeIdx) => phase === 1 && holeIdx === 1 && holes === 8, 20000);
if (round1) pass("hole advanced to 2 after both balls were in");
else {
  const r = A.db.db.round.id.find(0);
  fail(`hole did not advance (round: phase=${r?.phase} holeIdx=${r?.holeIdx})`);
}
const hole1 = generateHole(round0.seed, 1);
// the advance resets both balls to hole 2's tee (grid slots) with strokes 0
const aReset = await waitFind(A, (q) => q.hole === 1 && q.strokes === 0 && q.ballState === 0, 10000);
const bReset = await waitFind(B, (q) => q.hole === 1 && q.strokes === 0 && q.ballState === 0, 10000);
if (aReset && bReset) {
  const da1 = Math.hypot(aReset.x - hole1.tee.x, aReset.y - hole1.tee.y);
  const db1 = Math.hypot(bReset.x - hole1.tee.x, bReset.y - hole1.tee.y);
  if (da1 < 35 && db1 < 35) pass("both balls reset at hole 2's tee");
  else fail(`hole 2 tee placement: A=${da1.toFixed(1)} B=${db1.toFixed(1)}`);
  if (aReset.strokes === 0 && aReset.totalStrokes > 0 && bReset.totalStrokes > 0) pass("strokes reset per hole, total kept");
  else fail(`strokes=${aReset.strokes} total=${aReset.totalStrokes}/${bReset.totalStrokes}`);
} else fail("players not reset for hole 2");

// --- retee -------------------------------------------------------------------
A.rows.length = 0;
await A.db.reducers.retee({});
const aRetee = await waitRow(A, (q) => q.strokes === 0 && q.ballState === 0, 5000);
if (aRetee) {
  const dTee = Math.hypot(aRetee.x - hole1.tee.x, aRetee.y - hole1.tee.y);
  if (dTee < 1) pass(`retee resets to the current hole's tee (d=${dTee.toFixed(1)})`);
  else fail(`retee pos off tee: d=${dTee.toFixed(1)}`);
} else fail("no row after retee");

// --- to_lobby -----------------------------------------------------------------
A.rows.length = 0;
B.rows.length = 0;
await A.db.reducers.toLobby({});
const roundLobby = await waitRound(A.db, (phase) => phase === 0, 5000);
if (roundLobby) pass("to_lobby returns everyone to the lobby");
else fail("round never returned to lobby");
const aLobby2 = await waitRow(A, (q) => q.phase === 0, 5000);
const bLobby2 = await waitRow(B, (q) => q.phase === 0, 5000);
if (aLobby2 && bLobby2 && aLobby2.totalStrokes === 0 && bLobby2.totalStrokes === 0) pass("players reset for the next round");
else fail(`lobby reset: A=${aLobby2?.totalStrokes} B=${bLobby2?.totalStrokes}`);

// --- 10-player cap -------------------------------------------------------------
{
  const extras: ReturnType<typeof makeConn>[] = [];
  let spawned = 0;
  let fullSeen = false;
  for (let i = 0; i < 9; i++) {
    const c = makeConn();
    for (let k = 0; k < 100 && !c.connected(); k++) await sleep(100);
    try {
      await c.db.reducers.spawn({ name: `cap${i}` });
      spawned++;
      extras.push(c);
    } catch (e) {
      fullSeen = true;
      console.log(`  cap: ${e}`);
    }
  }
  const totalPlayers = 2 + spawned; // A + B + extras
  console.log(`cap: A+B+${spawned} spawned, full-rejection=${fullSeen}`);
  if (totalPlayers === 10 && fullSeen) pass("max 10 players enforced (11th rejected)");
  else fail(`cap wrong: ${totalPlayers} players, fullSeen=${fullSeen}`);
  for (const c of extras) c.db.disconnect();
}

console.log(ok ? "SMOKE PASS ✅" : "SMOKE FAIL ❌");
process.exit(ok ? 0 : 1);
