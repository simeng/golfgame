# golfgame — gravity minigolf

Top-down minigolf with **fading gravity**. Built on SpacetimeDB (server-
authoritative, 20 Hz) as a sibling of [spacegame](../spacegame). Every player
has their own ball on the same course — shoot, curve around planets, sink the
cup, beat par.

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

## Controls

- **Drag** from anywhere (slingshot — pull back, release): pull direction sets
  the shot direction, pull length sets the power (300 px drag = full power,
  700 px/s).
- **R** — re-tee (reset your ball and strokes, any time).
- That's it.

## The course

1600×900, par 4. Tee at the left, cup at the right. Three internal walls make
a zigzag corridor:

```
 tee              under wall A        over wall B       past the centre      under wall C      cup
 (140,450)  →   (open below y=380) → (open above y=520) → planet (1020,360) → (open below y=300) → (1460,450)
```

Five planets, solid and bouncy (restitution 0.86):

| Planet | Position | r | Character |
|---|---|---|---|
| 1 | (580, 280) | 50 | hangs above the first corridor — hooks low shots upward out of the tee |
| 2 | (800, 620) | 62 | the big one, under the middle corridor — a straight drive dies on it |
| 3 | (1020, 360) | 54 | solid obstacle in the middle of the middle section; thread above it (y ≲ 295) |
| 4 | (1240, 640) | 48 | lower-right hazard for anyone running the bottom |
| 5 | (1380, 280) | 42 | the last curve, hovering over the approach to the cup |

Strategy notes (spoilers): the line is *low → high → low*: exit the tee box
under wall A (planet 1 will try to yank you up into it), rise over wall B
(planet 2 pulls you down as you pass — that's your slingshot window, the pull
is strongest while you're still fast), then thread the tight band above planet
3 and under wall C's bottom edge (y ≈ 280–295 from x ≈ 1000 to x ≈ 1200), and
drop down to the cup. A full-power straight shot bounces straight back off
planet 2 — or you can settle behind it and re-shoot from closer range
(strokes are strokes). Fast balls **roll over the cup** (capture needs
< 100 px/s at the cup) — an over-cut is as classic as it gets.

## Multiplayer

All players share the course simultaneously, each with their own ball and
stroke counter (balls don't collide with each other). Disconnected players
linger as dim balls for 30 s — reload within the window and your ball is
exactly where you left it, mid-roll included (persistent identity via
localStorage token).

## Running it

See [AGENTS.md](AGENTS.md) for the full dev workflow, the physics invariant,
and the SpacetimeDB v2 gotchas. Short version:

```bash
export PATH="$HOME/.local/bin:$PATH"   # SpacetimeDB CLI (v2.10.1 prebuilt)
# dev DB (shared with spacegame) on 127.0.0.1:3000 must be running
spacetime publish --server local --yes
cd client && npm install
npm run test:smoke && npm run test:rejoin
npm run dev      # http://localhost:5173
```

## Tuning

Everything lives in `spacetimedb/src/lib.rs` (server) and
`client/src/world.ts` (client mirror — **must stay identical**):

- `FRICTION` — rolling deceleration; sets shot range and the fade duration
  (`t_half = (v0/FRICTION)·(1−√2/2)`).
- `G_GOLF` — gravity strength (planet mass ∝ r²).
- `MAX_SHOT` / `MIN_SHOT` — power limits.
- `REST` — wall & planet bounciness.
- `CAPTURE_SPEED` — how fast a ball can be and still drop in the cup.
- `PLANETS` / `WALLS` / tee & cup — the course itself.

Retuned the course? `npm run test:smoke` re-validates the client/server
mirror (it simulates a full shot locally and demands the server's rest
position matches within 0.01 px).
