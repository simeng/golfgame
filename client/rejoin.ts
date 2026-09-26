// Rejoin test: connect, spawn, capture the server-issued token (like the
// browser would in localStorage), disconnect, then reconnect WITH the token
// and verify the same identity sees its own ball still on the course
// (grace period), and that the ball can still be hit.
import { DbConnection } from "./src/module_bindings";
import PlayerRowSchema from "./src/module_bindings/player_table";
import { Identity, Infer } from "spacetimedb";
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
if (!row) fail("ball was gone after reload (grace period broken?)");
else {
  pass(`ball still exists after reconnect: pos=(${row.x.toFixed(1)},${row.y.toFixed(1)}) state=${row.state} connected=${row.connected}`);
  if (!row.connected) fail("server did not mark the ball connected again");
  else pass("server marked ball connected on rejoin");
}

// and we can still hit it
await dbB.reducers.hit({ dx: 1, dy: 0.3, power: 300 });
await sleep(800);
const row2 = dbB.db.player.identity.find(new Identity(identB!)) as PlayerRow | null;
if (row2 && row) {
  const moved = Math.hypot(row2.x - row.x, row2.y - row.y);
  console.log(`hit after rejoin: moved ${moved.toFixed(1)}px in 0.8s, state=${row2.state} strokes=${row2.strokes}`);
  if (moved < 20 || row2.state !== 1) fail("ball did not roll after rejoin");
  else pass("ball rolls after rejoin (strokes=" + row2.strokes + ")");
}

console.log(ok ? "REJOIN PASS ✅" : "REJOIN FAIL ❌");
process.exit(ok ? 0 : 1);
