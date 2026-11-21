import * as THREE from 'three';
import { WEAPONS, type WeaponId } from '../config/weapons';
import { animateJetHammer, animateKiOrb, animateSixSeven, buildWeaponModel } from './models';

/** One hand's worth of first-person weapon: its model, recoil, muzzle flash and swing. */
class Hand {
  holder = new THREE.Group();
  current: WeaponId | null = null;
  private model: THREE.Group | null = null;
  private flash: THREE.Mesh;
  private flashT = 0;
  private kick = 0; // recoil spring
  private raise = 1; // 0 = lowered (just switched), 1 = ready
  private punchT = 0;
  private punchSide = 1;
  /** JETHAMMER: is the trigger held (the compartment open, the rocket lit)? Set every frame by the renderer. */
  jet = false;
  /** KI BLAST: how far charged (0..1), and whether the beam is out. Set every frame by the renderer. */
  ki = { charge: 0, firing: false };
  private kiDraw = 0; // eased: drawn back to the hip while charging
  private kiThrust = 0; // eased: thrust out while the beam is out
  /** Wall run, fists only: how far the fist on that side (-1 left, 1 right) has gone out to the wall. */
  wallReach = 0;
  /** Melee special being held: 'guard' (fists up) or 'charge' with how far it is wound (0..1). Set every frame by the renderer. */
  pose: { kind: 'guard' | 'charge'; amount: number } | null = null;
  private poseT = 0; // eases in and out

  constructor(scene: THREE.Scene) {
    scene.add(this.holder);
    this.flash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.07),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95 }),
    );
    this.flash.visible = false;
    this.holder.add(this.flash);
  }

  set(id: WeaponId | null): void {
    if (id === this.current) return;
    if (this.model) this.holder.remove(this.model);
    this.model = id ? buildWeaponModel(id) : null;
    if (this.model) {
      this.holder.add(this.model);
      this.flash.position.set(0, 0.04, (this.model.userData.muzzle as number) - 0.06);
    }
    this.current = id;
    this.raise = 0;
    this.holder.visible = !!id;
  }

  part(name: string): THREE.Object3D | undefined {
    return this.model?.getObjectByName(name);
  }

  private sixShot = 0; // SIX SEVEN: 1 just after a fireball, fading
  private sixSide = 1; // and from which hand (-1 left, 1 right)

  /** `hand`: 0 left, 1 right, -1 not said. */
  fire(id: WeaponId, hand = -1): void {
    const def = WEAPONS[id];
    if (def.jet) return; // the hammer never swings: its 'fire' is the rocket roaring
    if (def.fireball) { this.sixShot = 1; this.sixSide = hand === 0 ? -1 : 1; }
    this.kick += def.recoil.kick;
    if (def.kind === 'melee' || def.consumed) {
      // swing / throw
      this.punchT = 1;
      this.punchSide = -this.punchSide;
    } else if (def.tracer !== null) {
      this.flashT = 0.05;
      this.flash.rotation.z = Math.random() * 6;
      this.flash.scale.setScalar(0.8 + def.recoil.kick * 0.5);
      (this.flash.material as THREE.MeshBasicMaterial).color.setHex(def.tracer?.color ?? 0xffe08a);
    }
  }

  /**
   * `x` = where this hand sits across the screen; `mirror` flips the swing for
   * the left hand; `aim` (0..1) brings the gun up to the middle of the view.
   */
  update(dt: number, x: number, bobX: number, bobY: number, sx: number, sy: number, clock: number, mirror: number, aim = 0): void {
    this.raise = Math.min(1, this.raise + dt * 6);
    this.kick *= Math.exp(-dt * 13);
    this.punchT = Math.max(0, this.punchT - dt * 5);
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (!this.current) return;

    const fists = this.current === 'fists';
    const bare = fists || this.current === 'sixseven'; // bare hands: held centred and low
    const h = this.holder;
    // Aiming: centred, raised to eye level, pulled closer, steadier.
    const steady = 1 - aim * 0.8;
    h.position.set(
      (bare ? 0 : x * (1 - aim)) + (sx + bobX) * steady,
      (bare ? -0.24 : -0.2 + aim * 0.08) + (sy - bobY) * steady - (1 - this.raise) * 0.3,
      -0.42 + aim * 0.06 + this.kick * 0.035 * (1 - aim * 0.4),
    );
    h.rotation.set(this.kick * 0.09 - (1 - this.raise) * 0.8, sx * 1.5, 0);
    h.scale.setScalar(bare || this.current === 'kiblast' ? 0.8 : 0.62); // (the KI BLAST is fists too)

    const def = WEAPONS[this.current];
    // Melee special poses: guarding brings the fists up in front of the face; winding up draws the weapon back over the shoulder.
    this.poseT += ((this.pose ? 1 : 0) - this.poseT) * Math.min(1, dt * 14);
    if (this.poseT > 0.01) {
      const k = this.poseT;
      if (this.pose?.kind === 'charge' || (!this.pose && def.special?.kind === 'charge')) {
        const wind = this.pose?.amount ?? 0;
        h.rotation.x += k * (0.9 + wind * 0.6);
        h.rotation.z += k * (0.5 + wind * 0.4);
        h.position.x += k * 0.08;
        h.position.y += k * 0.08;
        h.position.z += k * 0.12 + Math.sin(clock * 40) * 0.004 * wind; // straining
      } else {
        h.position.y += k * 0.12;
        h.position.z += k * 0.1;
        h.rotation.x += k * 0.35;
      }
    }
    if (this.model?.getObjectByName('orb')) {
      // KI BLAST, the classic stance, side on: the fists (one above the orb, one below) come in from
      // the right edge; gathering, they tremble more and more as the orb swells. Released: they come
      // back to the middle, side by side where fists are held, the beam pouring out between them,
      // shuddering with the force of it. Everything eases, so the motion flows.
      const c = this.ki.charge;
      this.kiDraw += ((c > 0 && !this.ki.firing ? 1 : 0) - this.kiDraw) * Math.min(1, dt * 7);
      this.kiThrust += ((this.ki.firing ? 1 : 0) - this.kiThrust) * Math.min(1, dt * (this.ki.firing ? 18 : 5));
      animateKiOrb(this.model, c, this.kiThrust, clock); // the hands blend between the poses as it eases
      const d = this.kiDraw, t = this.kiThrust, side = 1 - t;
      const tremble = (0.002 + 0.01 * c) * d + 0.012 * t;
      const breathe = Math.sin(clock * 2.2) * 0.012 * d;
      h.position.x += -side * 0.03 - d * 0.02 - t * 0.2 + Math.sin(clock * 53) * tremble;
      h.position.y += side * 0.07 - t * 0.04 + breathe + Math.sin(clock * 47 + 1) * tremble;
      h.position.z += d * 0.05 - t * 0.08;
      h.rotation.y += side * (0.6 + d * 0.15); // side on: the fists come in from the right edge
      h.rotation.z += -side * d * 0.06;
      h.rotation.x += Math.sin(clock * 31) * tremble * 2;
    }
    if (this.model?.getObjectByName('sixL')) {
      // SIX SEVEN: the hands bob in turn, and the one that just flung a fireball jerks up.
      this.sixShot = Math.max(0, this.sixShot - dt * 6);
      animateSixSeven(this.model, clock, this.sixShot, this.sixSide);
      h.position.y += 0.07; // up into view, so the pumping hands are plain to see
      h.rotation.x += 0.12;
    }
    if (this.model?.userData.jetHammer) {
      // Held up like any hammer; as the rocket opens it is thrust out ahead, head first, and shakes.
      const o = animateJetHammer(this.model, this.jet, dt);
      h.rotation.x += 0.15 - o * 1.25 + (o > 0.9 ? (Math.random() - 0.5) * 0.04 : 0);
      h.rotation.z = -0.15 * (1 - o) * mirror;
      h.position.y += -0.04 + o * 0.05;
      h.position.z -= o * 0.1;
    } else if (!fists && (def.kind === 'melee' || def.consumed)) {
      // Held blade-up; a use is one quick chop forwards and down.
      const swing = Math.sin(this.punchT * Math.PI);
      h.rotation.x += 0.45 - swing * 1.5;
      h.rotation.z = (-0.25 + swing * 0.5 * this.punchSide) * mirror;
      h.position.z -= swing * 0.14;
      h.position.y += 0.03 + swing * 0.05;
    }
    if (!this.model) return;
    if (fists) {
      // Alternate jabs: the punching hand shoots forward and comes back.
      const jab = Math.sin(this.punchT * Math.PI) * 0.28;
      const l = this.model.getObjectByName('handL')!, r = this.model.getObjectByName('handR')!;
      l.position.z = -0.05 - (this.punchSide < 0 ? jab : 0);
      r.position.z = -0.05 - (this.punchSide > 0 ? jab : 0);
      // Wall run: the fist on the wall side goes out flat against it, up and to the edge, scraping along.
      const reach = Math.abs(this.wallReach), side = Math.sign(this.wallReach);
      const scrape = Math.sin(clock * 47) * 0.006 * reach;
      for (const [hand, s] of [[l, -1], [r, 1]] as const) {
        const on = side === s ? reach : 0;
        hand.position.x = (hand.userData.x0 ??= hand.position.x) + s * 0.24 * on;
        hand.position.y = (hand.userData.y0 ??= hand.position.y) + 0.16 * on + (side === s ? scrape : 0);
        hand.rotation.z = -s * 0.9 * on;
      }
    }
    // Little bits of life: spinning drums and rings, blinking lights.
    const spin = this.model.getObjectByName('spin');
    if (spin) spin.rotation.z = clock * 2 + this.kick * 2;
    const blink = this.model.getObjectByName('blink');
    if (blink) blink.visible = Math.floor(clock * 4) % 2 === 0;
  }
}

/**
 * First-person weapons. Drawn in their own scene on top of the world (depth
 * cleared in between) so they never clip into walls and keep a fixed FOV.
 * Normally one weapon in the right hand; when dual wielding, the second
 * one-handed weapon appears in the left hand with its own recoil and flash.
 */
export class ViewModel {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private right: Hand;
  private left: Hand;
  /** Running along a wall on this side (-1 left, 1 right, 0 not). Set every frame. */
  wall = 0;
  /** On a SKYSWEEPER: its handle runs out in front of you, below the view. Set every frame. */
  broom = false;
  private broomModel: THREE.Object3D | null = null;
  private broomT = 0; // eases in and out
  private wallT = 0; // eases in and out
  private wallSideShown = 1;
  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  private clock = 0;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-1, 2, 1);
    this.scene.add(sun);
    this.right = new Hand(this.scene);
    this.left = new Hand(this.scene);
    this.left.set(null);
    this.left.holder.visible = false;
  }

  /** `offhand` = the weapon in the left hand while dual wielding, else null. */
  setWeapons(main: WeaponId, offhand: WeaponId | null): void {
    this.right.set(main);
    this.left.set(offhand);
  }

  /** A named part of the weapon in the (right) hand, if there is one: e.g. the REARVIEW's 'glass'. */
  part(name: string): THREE.Object3D | undefined {
    return this.right.part(name);
  }

  /** JETHAMMER in hand with the trigger held. */
  set jet(on: boolean) { this.right.jet = on; }

  /**
   * KI BLAST: where the orb is on screen (normalised device coordinates), so
   * the beam can start from it, or null when there is no orb in hand.
   */
  orbScreen(): THREE.Vector3 | null {
    const orb = this.right.part('orb');
    if (!orb) return null;
    this.scene.updateMatrixWorld();
    return orb.getWorldPosition(new THREE.Vector3()).project(this.camera);
  }

  /** KI BLAST in hand: how far charged (0..1), and whether the beam is out. */
  setKi(charge: number, firing: boolean): void { this.right.ki = { charge, firing }; }

  /** Running along a wall: -1 on the left, 1 on the right, 0 not. */
  setWall(side: number): void { this.wall = side; }

  /** A melee special being held (guard, wind-up), or null. */
  set pose(p: { kind: 'guard' | 'charge'; amount: number } | null) { this.right.pose = p; }

  /** hand: 0 = left (dual wield, fired with the first button), anything else = right. */
  onFire(id: WeaponId, hand = -1): void {
    (hand === 0 && this.left.current ? this.left : this.right).fire(id, hand);
  }

  /** `aim` (0..1): how far the gun is brought up to the eye (aiming down the sights). */
  update(dt: number, speed: number, grounded: boolean, mouseDX: number, mouseDY: number, aim = 0): void {
    this.clock += dt;
    if (grounded) this.bob += dt * speed * 1.4;
    const bobAmt = grounded ? Math.min(1, speed / 8) : 0;
    this.swayX += (-mouseDX * 0.0006 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (mouseDY * 0.0006 - this.swayY) * Math.min(1, dt * 10);
    const sx = Math.max(-0.04, Math.min(0.04, this.swayX));
    const sy = Math.max(-0.04, Math.min(0.04, this.swayY));
    const bobX = Math.cos(this.bob) * 0.008 * bobAmt, bobY = Math.abs(Math.sin(this.bob)) * 0.012 * bobAmt;
    const dual = !!this.left.current;
    this.right.update(dt, dual ? 0.23 : 0.2, bobX, bobY, sx, sy, this.clock, 1, dual ? 0 : aim);
    this.left.update(dt, -0.23, -bobX, bobY, sx, sy, this.clock + 0.4, -1);

    // SKYSWEEPER: the handle runs out ahead of you from under the view, rocking a little.
    this.broomT += ((this.broom ? 1 : 0) - this.broomT) * Math.min(1, dt * 6);
    if (this.broomT > 0.01 && !this.broomModel) {
      this.broomModel = buildWeaponModel('skysweeper');
      this.scene.add(this.broomModel);
    }
    if (this.broomModel) {
      const b = this.broomModel, t = this.broomT;
      b.visible = t > 0.01;
      b.position.set(0.03, -0.62 + t * 0.17 + Math.sin(this.clock * 2.7) * 0.006, -0.25);
      b.rotation.set(0.1, -0.03, Math.sin(this.clock * 2.1) * 0.04);
    }

    // Wall run: with fists, the one on the wall side goes out to the wall (Hand.update);
    // anything else leans away from the wall to make room.
    if (this.wall) this.wallSideShown = this.wall;
    this.wallT += ((this.wall ? 1 : 0) - this.wallT) * Math.min(1, dt * 12);
    const w = this.wallT, side = this.wallSideShown;
    this.right.wallReach = side * w;
    for (const h of [this.right, this.left]) {
      if (h.current === 'fists') continue;
      h.holder.position.x -= side * 0.07 * w;
      h.holder.rotation.z -= side * 0.12 * w;
    }
  }
}
