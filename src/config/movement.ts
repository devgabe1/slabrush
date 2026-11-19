// ALL movement tuning lives here. Units: meters, seconds.
// The simulation runs at a fixed tick (see config/game.ts), so these values
// behave identically on every machine.
export const MOVE = {
  // --- basics ---
  gravity: 22,
  jumpSpeed: 7.4, // initial upward velocity (jump height ≈ v² / 2g ≈ 1.25 m)
  autoHop: true, // true: holding jump re-jumps on landing (easy bhop). false: must time each press

  runSpeed: 8,
  walkSpeed: 3.6, // slow-walk key
  crouchSpeed: 3.6,

  // --- ground ---
  groundAccel: 10,
  groundFriction: 6,
  stopSpeed: 2.5, // below this speed friction acts as if moving at stopSpeed (snappy stops)

  // --- air (Quake-style air strafing) ---
  // Air acceleration only pushes until your velocity *along the wish direction*
  // reaches airWishSpeedCap. Turning the mouse while strafing keeps that
  // projection small, so you keep gaining speed: that is air strafing.
  airAccel: 12,
  airWishSpeedCap: 1.0,

  // --- air control (steering) ---
  // In mid-air the movement keys point your trajectory where you want it:
  //   - your velocity TURNS towards the held direction at airTurnRate, keeping
  //     its speed. A or D alone swings you sideways; W makes you follow the
  //     crosshair; W+A goes diagonally.
  //   - slower than runSpeed, you also accelerate (airControlAccel) up to
  //     runSpeed, so a standing jump can still go somewhere.
  //   - holding the direction opposite to your movement brakes (airBrake).
  // Steering never adds speed above runSpeed: that still comes from hops,
  // strafing, slides and explosions. Set airTurnRate to 0 for pure Quake air movement.
  airTurnRate: 4.2, // radians per second (~240 deg/s: a full sideways swing in well under one jump)
  airControlAccel: 1.4,
  airBrake: 18, // m/s^2
  // --- jump pads (trampolines) ---
  // A pad bounces you up and keeps you going the way you were already moving,
  // a little faster; landing on one standing still sends you straight up.
  padBounce: 13, // upward speed (m/s): about 3.8 m high (pads leading higher throw harder)
  padBoost: 2.5, // horizontal speed added along your direction (m/s)...
  padMaxSpeed: 14, // ...up to this; already faster than this, you keep your speed
  // Pads throw you along the way you are moving, so you steer with the keys
  // straight away (needed to reach anything from a standing start). Raise this
  // to lock steering for a moment after a pad.
  padSteerLock: 0, // seconds after a jump pad during which the keys do not steer

  // --- bunny hopping ---
  // Jumping again within hopWindow seconds of landing is a "hop": it keeps all
  // your speed (no ground friction) and adds hopBoost, until you reach
  // runSpeed * hopSpeedCap. With autoHop you just hold the jump key.
  hopWindow: 0.1,
  hopBoost: 0.8, // m/s gained per hop
  hopSpeedCap: 1.5, // hops alone take you to 1.5x run speed; strafing can go beyond

  // --- collision ---
  stepHeight: 0.45, // max ledge height climbed without jumping
  minGroundNormalY: 0.7, // surfaces steeper than this (~45°) are not walkable
  maxSpeed: 60, // hard safety clamp

  // --- crouch slide ---
  slideMinSpeed: 6.5, // horizontal speed needed to enter a slide when crouching
  slideEndSpeed: 3.0, // slide ends below this speed
  slideBoost: 2.0, // one-off speed added when a slide starts...
  slideBoostCooldown: 1.5, // ...at most this often (stops boost spamming)
  slideFriction: 3.5, // constant deceleration in m/s² while sliding (not a Quake friction factor)
  slideSteerAccel: 12, // steering while sliding uses air-style acceleration
  slideSlopeGravity: 1.5, // multiplier on gravity along the slope: >1 = slopes are generous

  // --- wall jump ---
  wallJumpMax: 2, // wall jumps allowed per airtime (refills on landing)
  wallJumpPush: 6.5, // speed away from the wall
  wallJumpUp: 7.2, // vertical speed set by a wall jump
  wallJumpCooldown: 0.2,
  wallDetectDist: 0.25, // how close to a wall you must be
  // Wall run: meet a wall in the air moving along it fast enough and you run along it for a moment, no key
  // needed: a small lift, then gravity comes back bit by bit, so you trace a gentle arc and keep your speed.
  wallRunMinSpeed: 5, // speed along the wall needed to start (m/s); below 60% of it the run ends
  wallRunTime: 1.2, // longest run (s)
  wallRunLift: 2, // upward speed you start with, at least (m/s)...
  wallRunMaxRise: 3, // ...and at most: a jump into a wall becomes a run along it, not a climb up it (m/s)
  wallRunGravity: 0.08, // share of gravity at the start of the run; it grows back to full by the end
  wallRunMax: 2, // runs per airtime (refills on landing), like wall jumps
  wallRunCooldown: 0.35, // after one ends, before the next can start (s)

  // --- surfaces / status ---
  iceFriction: 0.4,
  iceAccel: 1.5,
  stunSpeedScale: 0.45, // ground speed multiplier while stunned (hit by a thrown weapon)
};
