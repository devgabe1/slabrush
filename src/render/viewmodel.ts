import * as THREE from 'three';
import { WEAPONS, type WeaponId } from '../config/weapons';
import { animateJetHammer, buildWeaponModel } from './models';

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

  fire(id: WeaponId): void {
    const def = WEAPONS[id];
    if (def.jet) return; // the hammer never swings: its 'fire' is the rocket roaring
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
    const h = this.holder;
    // Aiming: centred, raised to eye level, pulled closer, steadier.
    const steady = 1 - aim * 0.8;
    h.position.set(
      (fists ? 0 : x * (1 - aim)) + (sx + bobX) * steady,
      (fists ? -0.24 : -0.2 + aim * 0.08) + (sy - bobY) * steady - (1 - this.raise) * 0.3,
      -0.42 + aim * 0.06 + this.kick * 0.035 * (1 - aim * 0.4),
    );
    h.rotation.set(this.kick * 0.09 - (1 - this.raise) * 0.8, sx * 1.5, 0);
    h.scale.setScalar(fists ? 0.8 : 0.62);

    const def = WEAPONS[this.current];
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

  /** JETHAMMER in hand with the trigger held. */
  set jet(on: boolean) { this.right.jet = on; }

  /** hand: 0 = left (dual wield, fired with the first button), anything else = right. */
  onFire(id: WeaponId, hand = -1): void {
    (hand === 0 && this.left.current ? this.left : this.right).fire(id);
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
  }
}
