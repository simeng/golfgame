//! golfgame — server-authoritative top-down minigolf with fading gravity.
//!
//! Multiplayer rounds (up to 10 players): players gather in a LOBBY, pick an
//! 8- or 16-hole course (majority wins, tie = 8), anyone starts the match, and
//! everyone plays the SAME holes at the SAME TIME. When your ball drops in the
//! cup you're done for that hole and spectate until everyone else is in too;
//! then the next hole starts. When the final hole is done the round is over
//! and anyone can send everyone back to the lobby.
//!
//! Courses are RANDOM: every hole of a round is generated deterministically
//! from (seed, hole index) — the client regenerates the identical hole. A
//! straight-line corridor from tee to cup is kept clear of planets, so every
//! hole is reachable by a straight drive of the right power.
//!
//! The shot mechanic (the interesting bit): gravity is at 100% when you hit
//! and fades linearly to 0% over `t_half`, the ESTIMATED time (no gravity in
//! the estimate) for the ball to cover half of its total stopping distance:
//!   t_stop = v0/FRICTION, D = v0²/(2·FRICTION), t_half = (v0/FRICTION)(1-√2/2)
//! So gravity bends fast, fresh shots hard and never hinders the final roll.
//! A pull can re-accelerate the ball, so real shots may outlive the estimate —
//! the fade clock is frozen at shot time and the estimate is blind to that.
//!
//! NOTE: all physics + course generation MUST stay op-for-op mirrored in
//! client/src/world.ts so the client can predict its own ball and render the
//! identical hole.

use spacetimedb::{ConnectionId, Identity, ReducerContext, ScheduleAt, Table};

// ---------------------------------------------------------------------------
// Course geometry (mirror client/src/world.ts exactly)
// ---------------------------------------------------------------------------

pub const WORLD_W: f64 = 1600.0;
pub const WORLD_H: f64 = 900.0;
pub const BALL_R: f64 = 8.0;
pub const HOLE_R: f64 = 15.0;
pub const CAPTURE_SPEED: f64 = 100.0; // faster than this and the ball rolls over the cup
pub const DEFAULT_TEE_X: f64 = 140.0; // lobby parking spot
pub const DEFAULT_TEE_Y: f64 = 450.0;

// ---------------------------------------------------------------------------
// Ball physics constants (mirror client/src/world.ts exactly)
// ---------------------------------------------------------------------------

const FRICTION: f64 = 120.0; // constant rolling deceleration, px/s^2
const G_GOLF: f64 = 500.0; // gravity constant, accel = G_GOLF * r^2 / d^2 * gmult
const MIN_D: f64 = 26.0; // clamp on gravity distance (avoids the singularity)
const REST: f64 = 0.86; // planet bounce restitution
const MAX_SHOT: f64 = 700.0; // max initial speed, px/s
const MIN_SHOT: f64 = 30.0; // below this a "hit" does nothing
const SETTLE_EPS: f64 = 2.0; // px/s — below this (and gravity off) the ball rests

const TICK_HZ: u64 = 20;
const SUBSTEPS: u32 = 8; // per tick (fine integration so fast shots don't tunnel)
const GRACE_TICKS: u64 = 600; // 30 s a disconnected ball lingers before removal

/// Closed-form estimate: time for a gravity-free ball shot at v0 to cover half
/// of its total stopping distance. t_half = (v0/FRICTION) * (1 - sqrt(2)/2).
pub fn estimate_t_half(v0: f64) -> f64 {
    (v0 / FRICTION) * (1.0 - (2.0_f64).sqrt() / 2.0)
}

// ---------------------------------------------------------------------------
// Random course generation (deterministic — identical to the TS client)
// ---------------------------------------------------------------------------

const MAX_PLANETS: usize = 6;
const CORRIDOR: f64 = 75.0; // half-width of the guaranteed straight tee→cup path
const GEN_MARGIN: f64 = 10.0; // extra safety clearance on the corridor
const MAX_PLAYERS: usize = 10;

#[derive(Clone, Copy)]
struct Planet {
    x: f64,
    y: f64,
    r: f64,
}

#[derive(Clone, Copy)]
struct Hole {
    planets: [Planet; MAX_PLANETS],
    n_planets: u32,
    tee_x: f64,
    tee_y: f64,
    cup_x: f64,
    cup_y: f64,
}

/// murmur3 finalizer (same op order as the TS client's fmix)
fn fmix(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 13;
    x = x.wrapping_mul(0xc2b2_ae35);
    x ^= x >> 16;
    x
}

/// 24-bit float in [0,1) — exact in f64
fn t(h: u32) -> f64 {
    ((h >> 8) & 0x00ff_ffff) as f64 / 16_777_216.0
}

/// Deterministic value n of the hole stream derived from seed.
fn genval(seed: u32, n: u32) -> f64 {
    let a = fmix(seed);
    let b = fmix(n.wrapping_add(0x9e37_79b9));
    t(fmix(a ^ (b.wrapping_mul(0x85eb_ca6b)).wrapping_add(0xcc9e_2d51)))
}

/// Exact distance from a point to a segment (mirrored in TS).
fn point_seg_dist(px: f64, py: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len2 = dx * dx + dy * dy;
    let tparam = if len2 > 0.0 {
        (((px - x0) * dx + (py - y0) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let qx = x0 + dx * tparam;
    let qy = y0 + dy * tparam;
    let ex = px - qx;
    let ey = py - qy;
    (ex * ex + ey * ey).sqrt()
}

/// Generate the layout of one hole from (seed, hole index). The values are
/// drawn from `gen` in a FIXED ORDER (see client world.ts for the mirror):
///   flip, tee(2), cup(2), [min-distance redraws], planet count, then per
///   planet up to 40 attempts of (x, y, r) with rejection:
///     - stays in bounds (50 px margin)
///     - keeps the whole tee→cup line >= r + CORRIDOR + GEN_MARGIN clear
///       (this is what guarantees a straight drive can reach the cup)
///     - stays off the tee (r+90) and the cup (r+100)
///     - stays >= r1+r2+80 from every already-placed planet
fn generate_hole(seed: u32, hole_idx: u32) -> Hole {
    let s = seed ^ fmix(hole_idx.wrapping_add(1));
    let mut i = 0u32;
    let mut draw = || -> f64 {
        let v = genval(s, i);
        i = i.wrapping_add(1);
        v
    };

    // tee / cup boxes (right/left), sometimes mirrored
    let flip = draw() < 0.5;
    let mut tee_x = 80.0 + draw() * 340.0;
    let mut tee_y = 80.0 + draw() * 740.0;
    let mut cup_x = 1180.0 + draw() * 340.0;
    let mut cup_y = 80.0 + draw() * 740.0;
    if flip {
        let tx = tee_x;
        tee_x = cup_x;
        cup_x = tx;
    }
    // redraw until tee and cup are meaningfully apart (deterministic bound)
    for _ in 0..24 {
        let ddx = tee_x - cup_x;
        let ddy = tee_y - cup_y;
        if ddx * ddx + ddy * ddy >= 700.0 * 700.0 {
            break;
        }
        tee_x = 80.0 + draw() * 340.0;
        tee_y = 80.0 + draw() * 740.0;
        cup_x = 1180.0 + draw() * 340.0;
        cup_y = 80.0 + draw() * 740.0;
        if flip {
            let tx = tee_x;
            tee_x = cup_x;
            cup_x = tx;
        }
    }

    // planets: 4..6, rejection-sampled
    let n_planets = 4 + (draw() * 3.0).floor() as u32;
    let mut planets = [Planet { x: 0.0, y: 0.0, r: 0.0 }; MAX_PLANETS];
    let mut n_p = 0u32;
    for _ in 0..n_planets {
        for _ in 0..40 {
            let px = 100.0 + draw() * (WORLD_W - 200.0);
            let py = 100.0 + draw() * (WORLD_H - 200.0);
            let r = 35.0 + draw() * 30.0;
            if px - r < 50.0 || px + r > WORLD_W - 50.0 || py - r < 50.0 || py + r > WORLD_H - 50.0 {
                continue;
            }
            // guaranteed path: the straight tee→cup line stays clear
            if point_seg_dist(px, py, tee_x, tee_y, cup_x, cup_y) < r + CORRIDOR + GEN_MARGIN {
                continue;
            }
            let dtx = px - tee_x;
            let dty = py - tee_y;
            if dtx * dtx + dty * dty < (r + 90.0) * (r + 90.0) {
                continue;
            }
            let dcx = px - cup_x;
            let dcy = py - cup_y;
            if dcx * dcx + dcy * dcy < (r + 100.0) * (r + 100.0) {
                continue;
            }
            let mut clear = true;
            for k in 0..n_p {
                let dqx = px - planets[k as usize].x;
                let dqy = py - planets[k as usize].y;
                let need = r + planets[k as usize].r + 80.0;
                if dqx * dqx + dqy * dqy < need * need {
                    clear = false;
                    break;
                }
            }
            if !clear {
                continue;
            }
            planets[n_p as usize] = Planet { x: px, y: py, r };
            n_p += 1;
            break;
        }
    }

    Hole {
        planets,
        n_planets: n_p,
        tee_x,
        tee_y,
        cup_x,
        cup_y,
    }
}

/// Deterministic parking offsets around a tee so up to 10 balls don't stack
/// perfectly: identities sorted → 5-wide grid, 14 px spacing.
fn tee_offsets(ids: &[Identity]) -> Vec<(f64, f64)> {
    let mut sorted: Vec<Identity> = ids.to_vec();
    sorted.sort();
    sorted.dedup();
    ids.iter()
        .map(|id| {
            let k = sorted.iter().position(|s| s == id).unwrap_or(0);
            let ox = (k % 5) as f64 * 14.0 - 28.0;
            let oy = (k / 5) as f64 * 14.0 - 14.0;
            (ox, oy)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Physics step (same op order as client world.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Ball {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    age: f64, // seconds since the current shot (drives the gravity fade)
    t_half: f64, // fade duration, frozen at shot time
}

/// Sum of gravitational acceleration from the hole's planets, scaled by gmult.
fn gravity(x: f64, y: f64, gmult: f64, hole: &Hole) -> (f64, f64) {
    let mut ax = 0.0_f64;
    let mut ay = 0.0_f64;
    for k in 0..hole.n_planets {
        let p = hole.planets[k as usize];
        let dx = p.x - x;
        let dy = p.y - y;
        let d2 = (dx * dx + dy * dy).max(MIN_D * MIN_D);
        let d = d2.sqrt();
        let a = G_GOLF * p.r * p.r / d2 * gmult;
        ax += a * dx / d;
        ay += a * dy / d;
    }
    (ax, ay)
}

/// One physics substep: gravity (faded) → friction → integrate.
/// MUST be op-for-op identical to client world.ts `stepBall`.
fn step_ball(s: &mut Ball, dt: f64, hole: &Hole) {
    s.age += dt;
    let gmult = (1.0 - s.age / s.t_half).max(0.0);

    let (gx, gy) = gravity(s.x, s.y, gmult, hole);
    s.vx += gx * dt;
    s.vy += gy * dt;

    // constant rolling friction (deceleration, not proportional drag)
    let sp = (s.vx * s.vx + s.vy * s.vy).sqrt();
    if sp > 0.0 {
        let decel = FRICTION * dt;
        if decel >= sp {
            s.vx = 0.0;
            s.vy = 0.0;
        } else {
            let k = (sp - decel) / sp;
            s.vx *= k;
            s.vy *= k;
        }
    }

    s.x += s.vx * dt;
    s.y += s.vy * dt;
}

/// Circle vs circle (planet). Bounces with restitution.
fn collide_planet(s: &mut Ball, p: &Planet) {
    let dx = s.x - p.x;
    let dy = s.y - p.y;
    let rr = BALL_R + p.r;
    let d2 = dx * dx + dy * dy;
    if d2 >= rr * rr || d2 == 0.0 {
        return;
    }
    let d = d2.sqrt();
    let nx = dx / d;
    let ny = dy / d;
    s.x = p.x + nx * rr;
    s.y = p.y + ny * rr;
    let vdotn = s.vx * nx + s.vy * ny;
    if vdotn < 0.0 {
        s.vx -= (1.0 + REST) * vdotn * nx;
        s.vy -= (1.0 + REST) * vdotn * ny;
    }
}

/// Outer boundary bounce.
fn collide_boundary(s: &mut Ball) {
    if s.x < BALL_R {
        s.x = BALL_R;
        if s.vx < 0.0 {
            s.vx = -s.vx * REST;
        }
    } else if s.x > WORLD_W - BALL_R {
        s.x = WORLD_W - BALL_R;
        if s.vx > 0.0 {
            s.vx = -s.vx * REST;
        }
    }
    if s.y < BALL_R {
        s.y = BALL_R;
        if s.vy < 0.0 {
            s.vy = -s.vy * REST;
        }
    } else if s.y > WORLD_H - BALL_R {
        s.y = WORLD_H - BALL_R;
        if s.vy > 0.0 {
            s.vy = -s.vy * REST;
        }
    }
}

fn speed(s: &Ball) -> f64 {
    (s.vx * s.vx + s.vy * s.vy).sqrt()
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// Ball state: 0 = ready (at rest, can be hit), 1 = rolling, 2 = holed.
const BALL_READY: u8 = 0;
const BALL_ROLLING: u8 = 1;
const BALL_HOLED: u8 = 2;

/// Player phase: 0 = lobby, 1 = in the round, 2 = round finished.
const PHASE_LOBBY: u8 = 0;
const PHASE_PLAYING: u8 = 1;
const PHASE_FINISHED: u8 = 2;

/// Round phase: 0 = lobby, 1 = playing, 2 = finished.
const ROUND_LOBBY: u8 = 0;
const ROUND_PLAYING: u8 = 1;
const ROUND_FINISHED: u8 = 2;

/// Course choice: 0 = 8 holes, 1 = 16 holes.
const CHOICE_8: u8 = 0;
const CHOICE_16: u8 = 1;

#[derive(Clone)]
#[spacetimedb::table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub ball_state: u8,
    pub shot_age: f64, // seconds since current shot (drives the gravity fade)
    pub t_half: f64, // fade duration for current shot
    pub phase: u8,
    pub hole: u8, // current hole index
    pub strokes: u32, // strokes this hole
    pub total_strokes: u32, // all holes so far (incl. this hole's)
    pub course_choice: u8, // 0 = 8 holes, 1 = 16
    pub connected: bool,
    pub offline_since_tick: u64,
}

/// One row (id 0) for the shared round.
#[derive(Clone)]
#[spacetimedb::table(accessor = round, public)]
pub struct Round {
    #[primary_key]
    pub id: u32, // always 0
    pub phase: u8,
    pub seed: u32, // course seed (random at match start)
    pub holes: u8, // 8 or 16
    pub hole_idx: u8, // current hole index
}

#[spacetimedb::table(accessor = meta)]
pub struct Meta {
    #[primary_key]
    pub id: u32, // always 0
    pub tick: u64,
}

#[spacetimedb::table(accessor = tick_timer, scheduled(tick))]
pub struct TickTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

/// One row per live connection (private bookkeeping for rejoin grace).
#[spacetimedb::table(accessor = conn)]
pub struct Conn {
    #[primary_key]
    pub connection_id: ConnectionId,
    pub identity: Identity,
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    if ctx.db.meta().id().find(0).is_none() {
        ctx.db.meta().insert(Meta { id: 0, tick: 0 });
    }
    if ctx.db.round().id().find(0).is_none() {
        ctx.db.round().insert(Round { id: 0, phase: ROUND_LOBBY, seed: 0, holes: 0, hole_idx: 0 });
    }
    if ctx.db.tick_timer().count() == 0 {
        let at = ScheduleAt::Interval(std::time::Duration::from_millis(50).into());
        ctx.db.tick_timer().insert(TickTimer { scheduled_id: 0, scheduled_at: at });
    }
}

#[spacetimedb::reducer]
pub fn spawn(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let me = ctx.sender();
    if ctx.db.player().identity().find(me).is_some() {
        return Err("already spawned".into());
    }
    let existing: Vec<Player> = ctx.db.player().iter().collect();
    if existing.len() >= MAX_PLAYERS {
        return Err("course is full (max 10)".into());
    }
    let mut name = name;
    while name.chars().count() > 16 {
        name.pop();
    }
    if name.trim().is_empty() {
        name = "golfer".into();
    }
    // park at the lobby tee (spread grid incl. the newcomer)
    let mut ids: Vec<Identity> = existing.iter().map(|p| p.identity).collect();
    ids.push(me);
    let (ox, oy) = tee_offsets(&ids)[existing.len()];
    ctx.db.player().try_insert(Player {
        identity: me,
        name,
        x: DEFAULT_TEE_X + ox,
        y: DEFAULT_TEE_Y + oy,
        vx: 0.0,
        vy: 0.0,
        ball_state: BALL_READY,
        shot_age: 0.0,
        t_half: 0.0,
        phase: PHASE_LOBBY,
        hole: 0,
        strokes: 0,
        total_strokes: 0,
        course_choice: CHOICE_8,
        connected: true,
        offline_since_tick: 0,
    })?;
    Ok(())
}

/// Pick the course length for the next round (only meaningful in the lobby).
#[spacetimedb::reducer]
pub fn pick_course(ctx: &ReducerContext, holes: u8) -> Result<(), String> {
    let me = ctx.sender();
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not spawned".into());
    };
    let Some(r) = ctx.db.round().id().find(0) else {
        return Err("round not initialized".into());
    };
    if r.phase != ROUND_LOBBY {
        return Err("a round is underway".into());
    }
    let choice = if holes == 16 {
        CHOICE_16
    } else if holes == 8 {
        CHOICE_8
    } else {
        return Err("choose 8 or 16 holes".into());
    };
    ctx.db.player().identity().update(Player { course_choice: choice, ..p.clone() });
    Ok(())
}

/// Anyone can start. Course length = the majority choice (tie → 8).
/// A solo player starts a solo round.
#[spacetimedb::reducer]
pub fn start_match(ctx: &ReducerContext) -> Result<(), String> {
    let Some(r) = ctx.db.round().id().find(0) else {
        return Err("round not initialized".into());
    };
    if r.phase != ROUND_LOBBY {
        return Err("a round is already underway".into());
    }
    let players: Vec<Player> = ctx.db.player().iter().collect();
    if players.is_empty() {
        return Err("the lobby is empty".into());
    }
    let n8 = players.iter().filter(|p| p.course_choice == CHOICE_8).count();
    let holes: u8 = if players.len() - n8 > n8 { 16 } else { 8 };
    let seed: u32 = ctx.random();

    ctx.db.round().id().update(Round { id: 0, phase: ROUND_PLAYING, seed, holes, hole_idx: 0 });
    let h = generate_hole(seed, 0);
    let offs = tee_offsets(&players.iter().map(|p| p.identity).collect::<Vec<_>>());
    for (i, p) in players.iter().enumerate() {
        ctx.db.player().identity().update(Player {
            x: h.tee_x + offs[i].0,
            y: h.tee_y + offs[i].1,
            vx: 0.0,
            vy: 0.0,
            ball_state: BALL_READY,
            shot_age: 0.0,
            t_half: 0.0,
            phase: PHASE_PLAYING,
            hole: 0,
            strokes: 0,
            total_strokes: 0,
            ..p.clone()
        });
    }
    Ok(())
}

/// Hit the ball. (dx, dy) is the aim direction (normalized server-side),
/// `power` the initial speed in px/s (clamped to MAX_SHOT). Only valid while
/// the player is in the round and the ball is at rest.
#[spacetimedb::reducer]
pub fn hit(ctx: &ReducerContext, dx: f64, dy: f64, power: f64) -> Result<(), String> {
    let me = ctx.sender();
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not spawned".into());
    };
    if p.phase != PHASE_PLAYING {
        return Err("not in a round".into());
    }
    if p.ball_state != BALL_READY {
        return Err("ball is not ready".into());
    }
    let len = (dx * dx + dy * dy).sqrt();
    if len < 0.001 {
        return Err("no direction".into());
    }
    let power = power.clamp(0.0, MAX_SHOT);
    if power < MIN_SHOT {
        return Err("too weak".into());
    }
    let ux = dx / len;
    let uy = dy / len;
    let t_half = estimate_t_half(power);
    ctx.db.player().identity().update(Player {
        vx: ux * power,
        vy: uy * power,
        ball_state: BALL_ROLLING,
        strokes: p.strokes + 1,
        total_strokes: p.total_strokes + 1,
        shot_age: 0.0,
        t_half,
        ..p.clone()
    });
    Ok(())
}

/// Reset the ball to the current hole's tee and zero this hole's strokes.
#[spacetimedb::reducer]
pub fn retee(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender();
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not spawned".into());
    };
    if p.phase != PHASE_PLAYING {
        return Err("not in a round".into());
    }
    let Some(r) = ctx.db.round().id().find(0) else {
        return Err("round not initialized".into());
    };
    let h = generate_hole(r.seed, p.hole as u32);
    ctx.db.player().identity().update(Player {
        x: h.tee_x,
        y: h.tee_y,
        vx: 0.0,
        vy: 0.0,
        ball_state: BALL_READY,
        shot_age: 0.0,
        t_half: 0.0,
        strokes: 0,
        ..p.clone()
    });
    Ok(())
}

/// End the round (or pull everyone out of a finished one) back to the lobby.
#[spacetimedb::reducer]
pub fn to_lobby(ctx: &ReducerContext) -> Result<(), String> {
    let Some(r) = ctx.db.round().id().find(0) else {
        return Err("round not initialized".into());
    };
    if r.phase == ROUND_LOBBY {
        return Err("already in the lobby".into());
    }
    ctx.db.round().id().update(Round { id: 0, phase: ROUND_LOBBY, seed: 0, holes: 0, hole_idx: 0 });
    let players: Vec<Player> = ctx.db.player().iter().collect();
    let offs = tee_offsets(&players.iter().map(|p| p.identity).collect::<Vec<_>>());
    for (i, p) in players.iter().enumerate() {
        ctx.db.player().identity().update(Player {
            x: DEFAULT_TEE_X + offs[i].0,
            y: DEFAULT_TEE_Y + offs[i].1,
            vx: 0.0,
            vy: 0.0,
            ball_state: BALL_READY,
            shot_age: 0.0,
            t_half: 0.0,
            phase: PHASE_LOBBY,
            hole: 0,
            strokes: 0,
            total_strokes: 0,
            ..p.clone()
        });
    }
    Ok(())
}

#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) {
    let me = ctx.sender();
    if let Some(cid) = ctx.connection_id() {
        let _ = ctx.db.conn().try_insert(Conn { connection_id: cid, identity: me });
    }
    if let Some(p) = ctx.db.player().identity().find(me) {
        if !p.connected {
            ctx.db.player().identity().update(Player {
                connected: true,
                offline_since_tick: 0,
                ..p.clone()
            });
        }
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    // ball lingers for GRACE_TICKS (see tick) so the player can rejoin
    if let Some(cid) = ctx.connection_id() {
        ctx.db.conn().connection_id().delete(cid);
    }
}

/// 20 Hz physics heartbeat + round progression. The scheduled table
/// re-fires automatically.
#[spacetimedb::reducer]
pub fn tick(ctx: &ReducerContext, _timer: TickTimer) {
    let Some(meta) = ctx.db.meta().id().find(0) else {
        return; // init not run yet
    };
    let tick_n = meta.tick + 1;
    ctx.db.meta().id().update(Meta { id: 0, tick: tick_n });

    let Some(round) = ctx.db.round().id().find(0) else {
        return;
    };

    let dt = (1.0 / TICK_HZ as f64) / SUBSTEPS as f64;

    // which identities have at least one live connection right now
    let online_ids: Vec<Identity> = ctx.db.conn().iter().map(|c| c.identity).collect();

    // course for the current hole (regenerated each tick — cheap, and the
    // client generates the identical one from (seed, hole_idx))
    let course = if round.phase == ROUND_PLAYING {
        Some(generate_hole(round.seed, round.hole_idx as u32))
    } else {
        None
    };

    let players: Vec<Player> = ctx.db.player().iter().collect();

    for prow in &players {
        let mut p = prow.clone();
        let online = online_ids.contains(&p.identity);
        let mut changed = false;

        // connection bookkeeping
        if !online && p.connected {
            p.connected = false;
            p.offline_since_tick = tick_n;
            changed = true;
        } else if online && !p.connected {
            p.connected = true;
            p.offline_since_tick = 0;
            changed = true;
        }

        // grace expiry: remove long-gone players
        if !online && tick_n.saturating_sub(p.offline_since_tick) >= GRACE_TICKS {
            ctx.db.player().identity().delete(p.identity);
            continue;
        }

        // only rolling balls of players in the round get physics
        if p.phase == PHASE_PLAYING && p.ball_state == BALL_ROLLING {
            if let Some(h) = &course {
                let mut b = Ball {
                    x: p.x,
                    y: p.y,
                    vx: p.vx,
                    vy: p.vy,
                    age: p.shot_age,
                    t_half: p.t_half,
                };
                for _ in 0..SUBSTEPS {
                    step_ball(&mut b, dt, h);
                    collide_boundary(&mut b);
                    for k in 0..h.n_planets {
                        collide_planet(&mut b, &h.planets[k as usize]);
                    }
                    let gmult = (1.0 - b.age / b.t_half).max(0.0);
                    // hole capture (must be slow enough or it rolls over the cup)
                    let hdx = b.x - h.cup_x;
                    let hdy = b.y - h.cup_y;
                    let hd = (hdx * hdx + hdy * hdy).sqrt();
                    if hd < HOLE_R && speed(&b) < CAPTURE_SPEED {
                        b.x = h.cup_x;
                        b.y = h.cup_y;
                        b.vx = 0.0;
                        b.vy = 0.0;
                        p.ball_state = BALL_HOLED;
                        break;
                    }
                    // settle only once the gravity fade has fully completed —
                    // while gmult > 0 a planet is still allowed to pull a slow
                    // ball back (the estimate is blind to that, by design)
                    if gmult <= 0.0 && speed(&b) < SETTLE_EPS {
                        b.vx = 0.0;
                        b.vy = 0.0;
                        p.ball_state = BALL_READY;
                        break;
                    }
                }
                p.x = b.x;
                p.y = b.y;
                p.vx = b.vx;
                p.vy = b.vy;
                p.shot_age = b.age;
                changed = true;
            }
        }

        if changed {
            ctx.db.player().identity().update(p);
        }
    }

    // --- round progression -------------------------------------------------
    // Everyone in the round is in the cup → next hole (or round over).
    if round.phase == ROUND_PLAYING {
        let playing: Vec<Player> = ctx
            .db
            .player()
            .iter()
            .filter(|p| p.phase == PHASE_PLAYING)
            .collect();
        if !playing.is_empty() && playing.iter().all(|p| p.ball_state == BALL_HOLED) {
            let next = round.hole_idx as u32 + 1;
            if next >= round.holes as u32 {
                // round over
                ctx.db.round().id().update(Round {
                    id: 0,
                    phase: ROUND_FINISHED,
                    seed: round.seed,
                    holes: round.holes,
                    hole_idx: round.hole_idx,
                });
                for p in &playing {
                    ctx.db.player().identity().update(Player {
                        phase: PHASE_FINISHED,
                        ..p.clone()
                    });
                }
            } else {
                ctx.db.round().id().update(Round {
                    id: 0,
                    phase: ROUND_PLAYING,
                    seed: round.seed,
                    holes: round.holes,
                    hole_idx: next as u8,
                });
                let h = generate_hole(round.seed, next);
                let offs = tee_offsets(&playing.iter().map(|p| p.identity).collect::<Vec<_>>());
                for (i, p) in playing.iter().enumerate() {
                    ctx.db.player().identity().update(Player {
                        x: h.tee_x + offs[i].0,
                        y: h.tee_y + offs[i].1,
                        vx: 0.0,
                        vy: 0.0,
                        ball_state: BALL_READY,
                        shot_age: 0.0,
                        t_half: 0.0,
                        hole: next as u8,
                        strokes: 0,
                        ..p.clone()
                    });
                }
            }
        }
    }
}
