// Rejoin test: connect, join the lobby, capture the server-issued token (like
// the browser would in localStorage), disconnect, then reconnect WITH the
// token and verify the same identity is still in the lobby (grace period).
// Then start a solo round, verify the ball is on the generated hole, and hit.
import { DbConnection } from "./src/module_bindings";
import PlayerRowSchema from "./src/module_bindings/player_table";
import { Identity, Infer } from "spacetimedb";
import { generateHole } from "./src/world";

type PlayerRow = Infer<typeof PlayerRowSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const fail = (m: string) => { console.error("FAIL:", m); ok = false; };
const pass = (m: string) => console.log("PASS:", m);

// ---- session A -------------------------------------------------------------
const dbA = DbConnection.builder()
  .withUri("ws://127.0.0.1:3000")
  .withDatabaseName("golfgame")
  .onConnect((_c, id, token) => { identA = (id as Identity).toHexString(); tokenA = token || null; connA = true; })
  .build();
let identA: string | null = null;
let tokenA: string | null = null;
let connA = false;
for (let i = 0; i < 100 && !connA; i++) await sleep(100);
if (!connA) throw new Error("connect A timeout");

await dbA.reducers.spawn({ name: "rejoinbot" });
await sleep(300); // let a couple of ticks flow
console.log(`session A identity=${identA} tokenLen=${tokenA ? tokenA.length : 0}`);
if (!tokenA) fail("server did not issue a token for anonymous connect");
else pass("server issued a persistent token");

dbA.disconnect();
await sleep(400); // let the server process the disconnect

// ---- session B: same token --------------------------------------------------
const dbB = DbConnection.builder()
  .withUri("ws://127.0.0.1:3000")
  .withDatabaseName("golfgame")
  .withToken(tokenA!)
  .onConnect((_c, id) => { identB = (id as Identity).toHexString(); connB = true; })
  .build();
let identB: string | null = null;
let connB = false;
for (let i = 0; i < 100 && !connB; i++) await sleep(100);
if (!connB) throw new Error("connect B timeout");

console.log(`session B identity=${identB}`);
if (identA !== identB) fail("token did not restore the same identity");
else pass("same identity restored from token");

dbB.subscriptionBuilder().subscribeToAllTables();
await sleep(200);
const row = dbB.db.player.identity.find(new Identity(identB!)) as PlayerRow | null;
if (!row) fail("player was gone after reload (grace period broken?)");
else {
  pass(`still in the game after reconnect: pos=(${row.x.toFixed(1)},${row.y.toFixed(1)}) phase=${row.phase} connected=${row.connected}`);
  if (!row.connected) fail("server did not mark the player connected again");
  else pass("server marked player connected on rejoin");
}

// start a solo round and play it
await dbB.reducers.startMatch({});
await sleep(300);
const r2 = dbB.db.player.identity.find(new Identity(identB!)) as PlayerRow | null;
const round = dbB.db.round.id.find(0);
if (!r2 || !round) fail("no rows after startMatch");
else {
  console.log(`round: phase=${round.phase} holes=${round.holes} seed=${round.seed} | player: phase=${r2.phase} pos=(${r2.x.toFixed(1)},${r2.y.toFixed(1)})`);
  if (round.phase === 1 && r2.phase === 1) pass("solo round started after rejoin");
  else fail(`round phase=${round?.phase} player phase=${r2?.phase}`);
  const hole = generateHole(round.seed, round.holeIdx);
  const d = Math.hypot(r2.x - hole.tee.x, r2.y - hole.tee.y);
  if (d < 35) pass(`ball placed at the generated tee (d=${d.toFixed(1)}px)`);
  else fail(`ball not at generated tee (d=${d.toFixed(1)}px)`);

  // and we can still hit it
  const dx = hole.cup.x - r2.x;
  const dy = hole.cup.y - r2.y;
  await dbB.reducers.hit({ dx, dy, power: 400 });
  await sleep(800);
  const r3 = dbB.db.player.identity.find(new Identity(identB!)) as PlayerRow | null;
  if (r3) {
    const moved = Math.hypot(r3.x - r2.x, r3.y - r2.y);
    console.log(`hit after rejoin: moved ${moved.toFixed(1)}px in 0.8s, ballState=${r3.ballState} strokes=${r3.strokes}`);
    if (moved < 20 || r3.ballState !== 1) fail("ball did not roll after rejoin");
    else pass("ball rolls after rejoin (strokes=" + r3.strokes + ")");
  }
  // clean up back to the lobby for the next test run
  await dbB.reducers.toLobby({});
}

console.log(ok ? "REJOIN PASS ✅" : "REJOIN FAIL ❌");
process.exit(ok ? 0 : 1);
