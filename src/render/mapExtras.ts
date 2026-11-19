import * as THREE from 'three';
import type { Vec3 } from '../core/vec';
import type { MapDef, MatId, MoverDef } from '../sim/map';
import { moverFraction } from '../sim/world';
import { buildSolidMesh, darkBoxes } from './mapMesh';

// The parts of a map that move or glow: moving brushes, jump pads,
// teleporters, low-gravity volumes, plus the "am I in a dark area" test.

const TELE_COLORS = [0x3ae8ff, 0xff5ae8, 0x8aff3a, 0xffa23a];

export class MapExtras {
  group = new THREE.Group();
  private movers: { mesh: THREE.Mesh; def: MoverDef }[] = [];

  /** Doors, platforms and elevators: solid things that can stand between the camera and a player. */
  get moverMeshes(): THREE.Mesh[] { return this.movers.map((m) => m.mesh); }
  private pulsing: { mat: THREE.MeshBasicMaterial; base: number; speed: number }[] = [];
  private spinning: THREE.Object3D[] = [];
  /** arrows that slide along conveyor belts, showing which way they run */
  private chevrons: { mesh: THREE.Mesh; ox: number; oz: number; dx: number; dz: number; len: number; phase: number; speed: number }[] = [];
  private dark: { min: Vec3; max: Vec3 }[] = [];
  private owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(map: MapDef, mats: Record<MatId, THREE.Material>) {
    this.dark = darkBoxes(map.triggers);
    for (const s of map.solids) {
      if (!s.mover) continue;
      const mesh = buildSolidMesh(s, mats);
      this.owned.push(mesh.geometry);
      this.group.add(mesh);
      this.movers.push({ mesh, def: s.mover });
    }

    const basic = (color: number, opacity = 1, extra: THREE.MeshBasicMaterialParameters = {}) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, ...extra });
      this.owned.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T): T => { this.owned.push(g); return g; };

    // Conveyor arrows: flat triangles gliding along each belt at belt speed.
    const tri = geo(new THREE.BufferGeometry());
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0.38, 0, 0, -0.22, 0, 0.42, -0.22, 0, -0.42], 3));
    const arrowMat = basic(0xffd23a, 0.85, { side: THREE.DoubleSide, depthWrite: false });
    for (const s of map.solids) {
      if (!s.push || s.mover) continue;
      const speed = Math.hypot(s.push.x, s.push.z);
      if (speed < 0.01) continue;
      const dx = s.push.x / speed, dz = s.push.z / speed;
      const alongX = Math.abs(dx) > Math.abs(dz);
      const len = alongX ? s.max.x - s.min.x : s.max.z - s.min.z;
      // start at the upstream end, centred across the belt
      const ox = alongX ? (dx > 0 ? s.min.x : s.max.x) : (s.min.x + s.max.x) / 2;
      const oz = alongX ? (s.min.z + s.max.z) / 2 : (dz > 0 ? s.min.z : s.max.z);
      const count = Math.max(2, Math.round(len / 1.5));
      for (let k = 0; k < count; k++) {
        const mesh = new THREE.Mesh(tri, arrowMat);
        mesh.position.y = s.max.y + 0.03;
        mesh.rotation.y = Math.atan2(-dz, dx);
        this.group.add(mesh);
        this.chevrons.push({ mesh, ox, oz, dx, dz, len, phase: (k / count) * len, speed });
      }
    }

    for (const t of map.triggers) {
      const cx = (t.min.x + t.max.x) / 2, cz = (t.min.z + t.max.z) / 2;
      const w = t.max.x - t.min.x, d = t.max.z - t.min.z, h = t.max.y - t.min.y;
      if (t.type === 'jumppad') {
        const plate = new THREE.Mesh(geo(new THREE.BoxGeometry(w, 0.1, d)), basic(0x2a2a2e));
        plate.position.set(cx, t.min.y + 0.05, cz);
        const glowMat = basic(0xffd23a);
        const glow = new THREE.Mesh(geo(new THREE.BoxGeometry(w * 0.72, 0.04, d * 0.72)), glowMat);
        glow.position.set(cx, t.min.y + 0.12, cz);
        this.pulsing.push({ mat: glowMat, base: 0.75, speed: 7 });
        // A little arrow pointing up: the pad throws you up, and onwards the way you were going.
        const arrow = new THREE.Mesh(geo(new THREE.ConeGeometry(0.28, 0.7, 4)), basic(0xff8a1a));
        arrow.position.set(cx, t.min.y + 0.55, cz);
        this.group.add(plate, glow, arrow);
      } else if (t.type === 'teleporter') {
        const color = TELE_COLORS[t.pair % TELE_COLORS.length];
        const plate = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.8, 0.9, 0.1, 8)), basic(color));
        plate.position.set(cx, t.min.y + 0.05, cz);
        const beamMat = basic(color, 0.3, { side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
        const beam = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.7, 0.7, h, 6, 1, true)), beamMat);
        beam.position.set(cx, t.min.y + h / 2, cz);
        this.pulsing.push({ mat: beamMat, base: 0.3, speed: 3 });
        this.spinning.push(beam);
        this.group.add(plate, beam);
      } else if (t.type === 'lowgrav') {
        const box = geo(new THREE.BoxGeometry(w, h, d));
        const fill = new THREE.Mesh(box, basic(0x8fb4ff, 0.07, { side: THREE.DoubleSide, depthWrite: false }));
        fill.position.set(cx, t.min.y + h / 2, cz);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.5 });
        this.owned.push(lineMat);
        const edges = new THREE.LineSegments(geo(new THREE.EdgesGeometry(box)), lineMat);
        edges.position.copy(fill.position);
        this.group.add(fill, edges);
      }
    }
  }

  /** `tick` may be fractional: movers are drawn between simulation ticks. */
  update(tick: number, time: number): void {
    for (const m of this.movers) {
      const f = moverFraction(m.def, tick);
      m.mesh.position.set(m.def.dx * f, m.def.dy * f, m.def.dz * f);
    }
    for (const c of this.chevrons) {
      const d = (c.phase + time * c.speed) % c.len;
      c.mesh.position.x = c.ox + c.dx * d;
      c.mesh.position.z = c.oz + c.dz * d;
    }
    for (const p of this.pulsing) p.mat.opacity = p.base + Math.sin(time * p.speed) * 0.2;
    for (const s of this.spinning) s.rotation.y = time * 1.5;
  }

  /** Is this point inside a dark area? */
  isDark(p: { x: number; y: number; z: number }): boolean {
    for (const b of this.dark) {
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return true;
    }
    return false;
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
  }
}
