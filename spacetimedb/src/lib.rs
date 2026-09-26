//! golfgame — server-authoritative top-down minigolf with "fading gravity".
//!
//! Core mechanic (the interesting bit): when you hit the ball, gravity is at
//! 100% and pulls the ball around planets. As the ball slows, gravity fades
//! linearly to 0% over a duration `t_half` that is ESTIMATED AT SHOT TIME from
//! the initial speed alone (no gravity in the estimate). So:
//!
//!   - estimate the shot as if gravity did nothing: constant rolling friction
//!     FRICTION (px/s^2) decelerates the ball from v0. It would stop after
//!     t_stop = v0/FRICTION, having travelled D = v0^2/(2*FRICTION).
//!   - t_half = the time it takes that gravity-free ball to cover HALF of D.
//!     For constant deceleration this has the closed form
//!         t_half = (v0/FRICTION) * (1 - sqrt(2)/2)
//!     (independent of walls/planets — it's a pure estimate, by design).
//!   - gravity multiplier gmult(t) = max(0, 1 - t/t_half): 1.0 the instant you
//!     hit, falling to 0.0 at t_half. After that the ball coasts on friction
//!     alone and settles — gravity never hinders the final roll to a stop.
//!
//! Planets are solid circles (ball bounces off) that ALSO emit inverse-square
//! gravity scaled by gmult. A strong pull can re-accelerate the ball, so a
//! real shot may travel further/longer than the estimate — the estimate is
//! deliberately naive, and the fade clock is frozen at shot time.
//!
//! NOTE: all physics here MUST stay op-for-op mirrored in client/src/world.ts
//! so the client can predict its own ball and draw the aim trajectory.

use spacetimedb::{ConnectionId, Identity, ReducerContext, ScheduleAt, Table};

// ---------------------------------------------------------------------------
// Course geometry (mirror client/src/world.ts exactly)
// ---------------------------------------------------------------------------

pub const WORLD_W: f64 = 1600.0;
pub const WORLD_H: f64 = 900.0;

pub const BALL_R: f64 = 8.0;

pub const TEE_X: f64 = 140.0;
pub const TEE_Y: f64 = 450.0;

pub const HOLE_X: f64 = 1460.0;
pub const HOLE_Y: f64 = 450.0;
pub const HOLE_R: f64 = 15.0;
pub const CAPTURE_SPEED: f64 = 100.0; // faster than this and the ball rolls over the cup

pub const PAR: u32 = 4;

#[derive(Clone, Copy)]
struct Planet {
    x: f64,
    y: f64,
    r: f64,
}

#[derive(Clone, Copy)]
struct Wall {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

// solid gravity planets (mass ∝ r^2, like spacegame)
const PLANETS: [Planet; 5] = [
    Planet { x: 580.0, y: 280.0, r: 50.0 },
    Planet { x: 800.0, y: 620.0, r: 62.0 },
    Planet { x: 1020.0, y: 360.0, r: 54.0 },
    Planet { x: 1240.0, y: 640.0, r: 48.0 },
    Planet { x: 1380.0, y: 280.0, r: 42.0 },
];

// internal bumper walls (top-down minigolf obstacles)
const WALLS: [Wall; 3] = [
    Wall { x0: 420.0, y0: 0.0, x1: 460.0, y1: 380.0 },
    Wall { x0: 950.0, y0: 520.0, x1: 990.0, y1: 900.0 },
    Wall { x0: 1180.0, y0: 0.0, x1: 1220.0, y1: 300.0 },
];

// ---------------------------------------------------------------------------
// Physics constants (mirror client/src/world.ts exactly)
// ---------------------------------------------------------------------------

const FRICTION: f64 = 120.0; // constant rolling deceleration, px/s^2
const G_GOLF: f64 = 500.0; // gravity constant, accel = G_GOLF * r^2 / d^2 * gmult
const MIN_D: f64 = 26.0; // clamp on gravity distance (avoids the singularity)
const REST: f64 = 0.86; // wall/planet bounce restitution
const MAX_SHOT: f64 = 700.0; // max initial speed, px/s
const MIN_SHOT: f64 = 30.0; // below this a "hit" does nothing
const SETTLE_EPS: f64 = 2.0; // px/s — below this the ball is considered at rest

const TICK_HZ: u64 = 20;
const SUBSTEPS: u32 = 8; // per tick (fine integration so fast shots don't tunnel)
const GRACE_TICKS: u64 = 600; // 30 s a disconnected ball lingers before removal

/// Closed-form estimate: time for a gravity-free ball shot at v0 to cover
/// half of its total stopping distance D = v0^2/(2*FRICTION).
/// Derived from s(t) = v0*t - 0.5*FRICTION*t^2 with s(t_half) = D/2:
///   t_half = (v0/FRICTION) * (1 - sqrt(2)/2)
pub fn estimate_t_half(v0: f64) -> f64 {
    (v0 / FRICTION) * (1.0 - (2.0_f64).sqrt() / 2.0)
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

/// Sum of gravitational acceleration from all planets (no cutoff — the course
/// is small and planets are few). Scaled by gmult so the pull fades out.
fn gravity(x: f64, y: f64, gmult: f64) -> (f64, f64) {
    let mut ax = 0.0_f64;
    let mut ay = 0.0_f64;
    for p in PLANETS {
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
fn step_ball(s: &mut Ball, dt: f64) {
    s.age += dt;
    let gmult = (1.0 - s.age / s.t_half).max(0.0);

    let (gx, gy) = gravity(s.x, s.y, gmult);
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

/// Circle vs AABB (closest point). Bounces with restitution.
fn collide_wall(s: &mut Ball, w: &Wall) {
    let cx = s.x.clamp(w.x0, w.x1);
    let cy = s.y.clamp(w.y0, w.y1);
    let dx = s.x - cx;
    let dy = s.y - cy;
    let d2 = dx * dx + dy * dy;
    if d2 >= BALL_R * BALL_R || d2 == 0.0 {
        return;
    }
    let d = d2.sqrt();
    let nx = dx / d;
    let ny = dy / d;
    // push out of the wall
    s.x = cx + nx * BALL_R;
    s.y = cy + ny * BALL_R;
    // reflect velocity about the normal
    let vdotn = s.vx * nx + s.vy * ny;
    if vdotn < 0.0 {
        s.vx -= (1.0 + REST) * vdotn * nx;
        s.vy -= (1.0 + REST) * vdotn * ny;
    }
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

/// Ball state machine: 0 = ready (at rest, can be hit), 1 = rolling, 2 = holed.
const STATE_READY: u8 = 0;
const STATE_ROLLING: u8 = 1;
const STATE_HOLED: u8 = 2;

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
    pub state: u8,
    pub strokes: u32,
    pub shot_age: f64, // seconds since current shot (drives gravity fade)
    pub t_half: f64, // fade duration for current shot
    pub connected: bool,
    pub offline_since_tick: u64,
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
    let mut name = name;
    while name.chars().count() > 16 {
        name.pop();
    }
    if name.trim().is_empty() {
        name = "golfer".into();
    }
    ctx.db.player().try_insert(Player {
        identity: me,
        name,
        x: TEE_X,
        y: TEE_Y,
        vx: 0.0,
        vy: 0.0,
        state: STATE_READY,
        strokes: 0,
        shot_age: 0.0,
        t_half: 0.0,
        connected: true,
        offline_since_tick: 0,
    })?;
    Ok(())
}

/// Hit the ball. (dx, dy) is the aim direction (normalized server-side),
/// `power` the initial speed in px/s (clamped to MAX_SHOT). Only valid while
/// the ball is at rest (STATE_READY).
#[spacetimedb::reducer]
pub fn hit(ctx: &ReducerContext, dx: f64, dy: f64, power: f64) -> Result<(), String> {
    let me = ctx.sender();
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not spawned".into());
    };
    if p.state != STATE_READY {
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
        state: STATE_ROLLING,
        strokes: p.strokes + 1,
        shot_age: 0.0,
        t_half,
        ..p.clone()
    });
    Ok(())
}

/// Reset the ball to the tee, clear strokes. Usable any time.
#[spacetimedb::reducer]
pub fn retee(ctx: &ReducerContext) {
    let me = ctx.sender();
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.player().identity().update(Player {
            x: TEE_X,
            y: TEE_Y,
            vx: 0.0,
            vy: 0.0,
            state: STATE_READY,
            strokes: 0,
            shot_age: 0.0,
            t_half: 0.0,
            ..p.clone()
        });
    }
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

/// 20 Hz physics heartbeat. The scheduled table re-fires automatically.
#[spacetimedb::reducer]
pub fn tick(ctx: &ReducerContext, _timer: TickTimer) {
    let Some(meta) = ctx.db.meta().id().find(0) else {
        return; // init not run yet
    };
    let tick_n = meta.tick + 1;
    ctx.db.meta().id().update(Meta { id: 0, tick: tick_n });

    let dt = (1.0 / TICK_HZ as f64) / SUBSTEPS as f64;

    // which identities have at least one live connection right now
    let online_ids: Vec<Identity> = ctx.db.conn().iter().map(|c| c.identity).collect();

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

        // only rolling balls get physics
        if p.state == STATE_ROLLING {
            let mut b = Ball {
                x: p.x,
                y: p.y,
                vx: p.vx,
                vy: p.vy,
                age: p.shot_age,
                t_half: p.t_half,
            };
            for _ in 0..SUBSTEPS {
                step_ball(&mut b, dt);
                collide_boundary(&mut b);
                for w in WALLS {
                    collide_wall(&mut b, &w);
                }
                for pl in PLANETS {
                    collide_planet(&mut b, &pl);
                }
                let gmult = (1.0 - b.age / b.t_half).max(0.0);
                // hole capture (must be slow enough or it rolls over the cup)
                let hdx = b.x - HOLE_X;
                let hdy = b.y - HOLE_Y;
                let hd = (hdx * hdx + hdy * hdy).sqrt();
                if hd < HOLE_R && speed(&b) < CAPTURE_SPEED {
                    b.x = HOLE_X;
                    b.y = HOLE_Y;
                    b.vx = 0.0;
                    b.vy = 0.0;
                    p.state = STATE_HOLED;
                    break;
                }
                // settle only once the gravity fade has fully completed —
                // while gmult > 0 a planet is still allowed to pull a slow
                // ball back (the estimate is blind to that, by design)
                if gmult <= 0.0 && speed(&b) < SETTLE_EPS {
                    b.vx = 0.0;
                    b.vy = 0.0;
                    p.state = STATE_READY;
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

        if changed {
            ctx.db.player().identity().update(p);
        }
    }
}
