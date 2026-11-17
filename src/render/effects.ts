import * as THREE from 'three';
import type { Vec3 } from '../core/vec';

// Short-lived visual effects: tracers, particle bursts, explosions, and the
// body parts that fly apart when someone dies. Purely cosmetic, so it may use
// Math.random freely — nothing here feeds back into the simulation.

interface Particle {
  mesh: THREE.Object3D; // a single mesh, or a whole group (a head flying off)
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  floorY: number; // bounces at this height (-Infinity = never)
  shrink: boolean;
  owned: boolean; // true: material is ours to dispose
}

interface Flash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  grow: number;
}

const MAX_PARTICLES = 400;
/** Bodies kept on the ground at once (oldest go first). A round has at most six players. */
const MAX_CORPSES = 14;
/** Seconds for a pool of blood to spread to its full size. */
const POOL_TIME = 2.4;
const disc = new THREE.CircleGeometry(1, 14);
const bloodMat = new THREE.MeshLambertMaterial({ color: 0x5c0808, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

/** A piece of a body on the ground (or still flying). Kept until the round ends. */
interface Remain {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  floorY: number;
  corpse: number;
  head: boolean;
  rest: boolean; // stopped: no longer simulated
}
const cube = new THREE.BoxGeometry(1, 1, 1);
const sphere = new THREE.SphereGeometry(1, 10, 6);
const basicCache = new Map<number, THREE.MeshBasicMaterial>();
function basic(color: number): THREE.MeshBasicMaterial {
  let m = basicCache.get(color);
  if (!m) basicCache.set(color, (m = new THREE.MeshBasicMaterial({ color })));
  return m;
}

export class Effects {
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private remains: Remain[] = [];
  private pools: { obj: THREE.Group; corpse: number; t: number; size: number }[] = [];
  private corpses: number[] = [];
  private nextCorpse = 1;
  private poolCount = 0;

  constructor(private scene: THREE.Scene) {}

  clear(): void {
    for (const p of this.particles) this.scene.remove(p.mesh);
    for (const f of this.flashes) this.scene.remove(f.mesh);
    for (const r of this.remains) this.scene.remove(r.obj);
    for (const p of this.pools) this.scene.remove(p.obj);
    this.particles = [];
    this.flashes = [];
    this.remains = [];
    this.pools = [];
    this.corpses = [];
  }

  burst(pos: Vec3, color: number, count: number, speed: number, life = 0.5, size = 0.07, gravity = 14): void {
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const mesh = new THREE.Mesh(cube, basic(color));
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      this.scene.add(mesh);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5)
        .normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.particles.push({
        mesh, vel, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0),
        life: life * (0.6 + Math.random() * 0.4), maxLife: life, gravity, floorY: -Infinity, shrink: true, owned: false,
      });
    }
  }

  /** Smoke puff: a grey cube that floats up and shrinks. */
  puff(pos: Vec3, color = 0x888888, size = 0.16): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const mesh = new THREE.Mesh(cube, basic(color));
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);
    this.particles.push({
      mesh, vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.8, (Math.random() - 0.5) * 0.6),
      spin: new THREE.Vector3(1, 2, 0), life: 0.45, maxLife: 0.45, gravity: 0, floorY: -Infinity, shrink: true, owned: false,
    });
  }

  tracer(from: THREE.Vector3, to: Vec3, color = 0xfff2b0, width = 0.025, life = 0.09): void {
    const end = new THREE.Vector3(to.x, to.y, to.z);
    const len = from.distanceTo(end);
    if (len < 0.5) return;
    const mesh = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    mesh.position.copy(from).lerp(end, 0.5);
    mesh.lookAt(end);
    mesh.scale.set(width, width, len);
    this.scene.add(mesh);
    this.flashes.push({ mesh, life, maxLife: life, grow: 0 });
  }

  explosion(pos: Vec3, radius: number): void {
    for (const [color, scale, life] of [[0xffe9a0, 0.35, 0.16], [0xff8a2a, 0.6, 0.3]] as const) {
      const mesh = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.scale.setScalar(radius * scale * 0.4);
      this.scene.add(mesh);
      this.flashes.push({ mesh, life, maxLife: life, grow: radius * scale * 2.2 });
    }
    this.burst(pos, 0xffb040, 18, 13, 0.6, 0.14);
    this.burst(pos, 0x3a3632, 14, 8, 0.9, 0.2, 6);
  }

  /** Detach a body part and send it tumbling. */
  // ------------------------------------------------------------ remains
  // Body parts stay where they land for the rest of the round (they are
  // simulated until they come to rest, then left alone), and each body leaves
  // a pool of blood. Only the newest MAX_CORPSES bodies are kept, so a
  // practice range full of respawning dummies cannot pile up forever.

  /** A piece of a body flying apart (cloned in place, sharing geometry and materials). */
  debris(src: THREE.Mesh, vel: THREE.Vector3, floorY: number, corpse: number): void {
    const mesh = new THREE.Mesh(src.geometry, src.material);
    src.updateWorldMatrix(true, false);
    src.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    this.scene.add(mesh);
    const spin = new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
    this.remains.push({ obj: mesh, vel, spin, floorY, corpse, head: false, rest: false });
  }

  /**
   * A whole group (a character's head with its eyes, hat and all) thrown as one
   * tumbling piece. Heads are heavier on the ground: they roll a little, then stop.
   */
  debrisGroup(src: THREE.Object3D, vel: THREE.Vector3, spin: THREE.Vector3, floorY: number, corpse: number): void {
    src.updateWorldMatrix(true, true);
    const obj = src.clone(true);
    src.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
    obj.visible = true;
    this.scene.add(obj);
    this.remains.push({ obj, vel, spin, floorY, corpse, head: true, rest: false });
  }

  /** A pool of blood spreading out on the floor under a body: a few overlapping blobs, so it is not a perfect circle. */
  bloodPool(x: number, floorY: number, z: number, corpse: number): void {
    const group = new THREE.Group();
    const lift = 0.012 + (this.poolCount++ % 8) * 0.002; // pools that overlap must not flicker against each other
    group.position.set(x, floorY + lift, z);
    for (let k = 0; k < 4; k++) {
      const blob = new THREE.Mesh(disc, bloodMat);
      blob.rotation.x = -Math.PI / 2;
      const a = Math.random() * Math.PI * 2, r = k === 0 ? 0 : 0.25 + Math.random() * 0.35;
      blob.position.set(Math.cos(a) * r, k * 0.0004, Math.sin(a) * r);
      blob.scale.setScalar(k === 0 ? 0.95 : 0.45 + Math.random() * 0.35);
      group.add(blob);
    }
    group.scale.setScalar(0.05);
    this.scene.add(group);
    this.pools.push({ obj: group, corpse, t: 0, size: 0.9 + Math.random() * 0.4 });
  }

  /** Start a new body; drops the oldest one if there are too many. Returns its id. */
  newCorpse(): number {
    const id = this.nextCorpse++;
    this.corpses.push(id);
    while (this.corpses.length > MAX_CORPSES) {
      const old = this.corpses.shift()!;
      this.remains = this.remains.filter((r) => (r.corpse === old ? (this.scene.remove(r.obj), false) : true));
      this.pools = this.pools.filter((p) => (p.corpse === old ? (this.scene.remove(p.obj), false) : true));
    }
    return id;
  }

  private updateRemains(dt: number): void {
    for (let i = this.remains.length - 1; i >= 0; i--) {
      const r = this.remains[i];
      if (r.rest) continue;
      const o = r.obj;
      r.vel.y -= 20 * dt;
      o.position.addScaledVector(r.vel, dt);
      o.rotation.x += r.spin.x * dt;
      o.rotation.y += r.spin.y * dt;
      o.rotation.z += r.spin.z * dt;
      if (o.position.y < -80) { this.scene.remove(o); this.remains.splice(i, 1); continue; } // fell into the void
      const ground = r.floorY + (r.head ? 0.2 : 0.08);
      if (o.position.y < ground && r.vel.y < 0) {
        o.position.y = ground;
        r.vel.y *= r.head ? -0.25 : -0.3;
        r.vel.x *= r.head ? 0.35 : 0.5; r.vel.z *= r.head ? 0.35 : 0.5;
        r.spin.multiplyScalar(r.head ? 0.3 : 0.4);
      }
      if (o.position.y <= ground + 0.01) {
        // Sliding / rolling along the floor: friction until it stops.
        const k = Math.exp(-dt * (r.head ? 9 : 6));
        r.vel.x *= k; r.vel.z *= k; r.spin.multiplyScalar(k);
        if (Math.hypot(r.vel.x, r.vel.y, r.vel.z) < 0.15 && r.spin.length() < 0.3) r.rest = true;
      }
    }
    for (const p of this.pools) {
      if (p.t >= POOL_TIME) continue;
      p.t = Math.min(POOL_TIME, p.t + dt);
      const k = p.t / POOL_TIME;
      p.obj.scale.setScalar(p.size * (1 - (1 - k) * (1 - k))); // spreads fast, then slower
    }
  }

  update(dt: number): void {
    this.updateRemains(dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      if (p.mesh.position.y < p.floorY + 0.1 && p.vel.y < 0) {
        p.mesh.position.y = p.floorY + 0.1;
        p.vel.y *= -0.35;
        p.vel.x *= 0.6; p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.5);
      }
      if (p.shrink) p.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 2.2));
      else if (p.life < 0.4) p.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 6));
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        mat.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      mat.opacity = 0.9 * (f.life / f.maxLife);
      if (f.grow) f.mesh.scale.addScalar(f.grow * dt / f.maxLife);
    }
  }
}
