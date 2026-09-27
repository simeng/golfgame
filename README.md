# golfgame — gravity minigolf

Top-down **multiplayer** minigolf with **fading gravity**. Built on SpacetimeDB
(server-authoritative, 20 Hz) as a sibling of [spacegame](../spacegame).
Up to 10 players gather in a **lobby**, vote on an **8- or 16-hole** course,
and then play the **same round simultaneously** — each with their own ball
(balls don't collide). Every hole is **randomly generated with a guaranteed
straight path to the cup**. Players who hole out watch the finishers.

## The rule that makes it weird

When you hit the ball, the course's "planets" pull on it at **100% strength**.
The game then estimates how far the ball would have rolled **without any
gravity** (pure friction), and finds the moment when that imaginary ball has
travelled **half** of its stopping distance. From the instant of your strike,
the planets' pull fades linearly to **0%** over exactly that duration — and
stays off for the rest of the shot.

So:

- **Drives** (fast, fresh) feel the full pull — planets bend them hard, you can
  slingshot around a planet or bank it off the pull.
- **Putts** (slow, late in the shot) feel nothing — gravity is already gone,
  the ball rolls true and can settle right up against a planet without being
  dragged back.
- The estimate is naive on purpose: a strong early pull can *re-accelerate* the
  ball, so real shots sometimes outlive their fade window. The clock always
  runs from the moment of impact.

The aim preview shows this directly: the dashed path is **amber** while gravity
is active, **white** after it fades, with a ring marking the fade point.

## A round

1. **Lobby** — spawn, pick 8 or 16 holes (majority wins, tie → 8), and wait.
   Any player can press START.
2. **Playing** — the course is generated from a fresh random seed; you and
   everyone else play the same hole at the same time. When *all* players in
   the round hole out, the course advances to the next hole and everyone's
   ball is reset to the new tee (strokes for the hole reset, total kept).
   Finished players spectate — the scoreboard keeps updating.
3. **Finished** — after the last hole, the scoreboard stands until someone
   pulls everyone back to the lobby.

## The course (random, but fair)

1600×900. Each hole is generated from the round seed + hole index: tee on one
side, cup on the other (at least 700 px apart), and **4–6 planets** placed so
that the **straight tee→cup line is always clear** — no planet ever blocks the
drive. Par is 3 for short holes, 4 for long ones.

What that buys you: a full-power straight drive can *always* reach the cup
line without hitting anything. What it doesn't: gravity still bends the drive,
so the ball often stops a few metres short of the cup — thread a line, or
drive and putt. Fast balls **roll over the cup** (capture needs < 100 px/s at
the cup) — an over-cut is as classic as it gets.

## Controls

- **Drag** from anywhere (slingshot — pull back, release): pull direction sets
  the shot direction, pull length sets the power (300 px drag = full power,
  700 px/s).
- **R** — re-tee (reset your ball and strokes, any time).
- That's it.

## Multiplayer & rejoin

- Max 10 players; the 11th gets "course is full".
- Players who join mid-round sit in the lobby as spectators.
- Disconnected players linger as dim balls for 30 s — reload within the window
  and your ball is exactly where you left it, mid-roll included (persistent
  identity via localStorage token).

## Running it

See [AGENTS.md](AGENTS.md) for the full dev workflow, the physics invariant,
and the SpacetimeDB v2 gotchas. Short version:

```bash
export PATH="$HOME/.local/bin:$PATH"   # SpacetimeDB CLI (v2.10.1 prebuilt)
# dev DB (shared with spacegame) on 127.0.0.1:3000 must be running
spacetime publish --server local --yes
cd client && npm install
npm run test:smoke && npm run test:rejoin
npm run dev      # http://localhost:5174
```

## Tuning

Everything lives in `spacetimedb/src/lib.rs` (server) and
`client/src/world.ts` (client mirror — **must stay identical**, including the
course generator and its RNG draw order):

- `FRICTION` — rolling deceleration; sets shot range and the fade duration
  (`t_half = (v0/FRICTION)·(1−√2/2)`).
- `G_GOLF` — gravity strength (planet mass ∝ r²).
- `MAX_SHOT` / `MIN_SHOT` — power limits.
- `REST` — wall & planet bounciness.
- `CAPTURE_SPEED` — how fast a ball can be and still drop in the cup.
- `GEN_CORRIDOR` / `GEN_MARGIN` — the guaranteed corridor width around the
  straight tee→cup line.
- `MAX_PLAYERS`, `GRACE_TICKS` — lobby cap, rejoin window.

Changed the generator or physics? `npm run test:smoke` re-validates the
client/server mirror (it plays a real round, simulates a full shot locally,
and demands the server's rest position matches within 0.01 px — currently
bit-exact).
