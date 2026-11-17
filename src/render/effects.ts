import * as THREE from 'three';
import type { Vec3 } from '../core/vec';

// Short-lived visual effects: tracers, particle bursts, explosions, and the
// body parts that fly apart when someone dies. Purely cosmetic, so it may use
// Math.random freely — nothing here feeds back into the simulation.

interface Particle {
  mesh: THREE.Mesh;
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

  constructor(private scene: THREE.Scene) {}

  clear(): void {
    for (const p of this.particles) this.scene.remove(p.mesh);
    for (const f of this.flashes) this.scene.remove(f.mesh);
    this.particles = [];
    this.flashes = [];
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
  debris(src: THREE.Mesh, vel: THREE.Vector3, floorY: number): void {
    const mesh = new THREE.Mesh(src.geometry, src.material);
    src.updateWorldMatrix(true, false);
    src.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    this.scene.add(mesh);
    this.particles.push({
      mesh, vel, spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5),
      life: 3.5, maxLife: 3.5, gravity: 20, floorY, shrink: false, owned: false,
    });
  }

  update(dt: number): void {
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
