import * as THREE from 'three';
import type { Vec3 } from '../core/vec';
import type { MapDef, MatId, MoverDef } from '../sim/map';
import { moverFraction } from '../sim/world';
import { buildSolidMesh, darkBoxes } from './mapMesh';
import { FRAMES, billboardTexture } from './billboards';
import { Life } from './life';

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
  /** Digital billboards: each flips to its next slide every few seconds, with a glitch. */
  private screens: { tex: THREE.Texture; phase: number; every: number }[] = [];
  /** Lanes of traffic: lights sliding from a to b, over and over. */
  private lanes: { mesh: THREE.InstancedMesh; a: THREE.Vector3; b: THREE.Vector3; count: number; speed: number; len: number; phase: number }[] = [];
  /** Birds, falls, fires, walkers, clouds, wind. */
  private life: Life | null = null;
  /** Holograms: they turn and bob. */
  private holos: { obj: THREE.Object3D; y: number; spin: number; bob: number }[] = [];
  /** arrows that slide along conveyor belts, showing which way they run */
  private chevrons: { mesh: THREE.Mesh; ox: number; oz: number; dx: number; dz: number; len: number; phase: number; speed: number }[] = [];
  private dark: { min: Vec3; max: Vec3; level?: number; tint?: number; fog?: [number, number] }[] = [];
  private owned: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(map: MapDef, mats: Record<MatId, THREE.Material>) {
    this.dark = darkBoxes(map.triggers);
    for (const s of map.solids) {
      if (!s.mover) continue;
      const mesh = buildSolidMesh(s, mats, this.dark);
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

    // Glowing scenery (neon signs, light strips, clouds): every box in one unlit mesh, each in its own colour.
    if (map.decor?.length) {
      const pos: number[] = [], col: number[] = [];
      const c = new THREE.Color();
      for (const d of map.decor) {
        c.setHex(d.color);
        const { min: lo, max: hi } = d;
        const v = (i: number, j: number, k: number) => [i ? hi.x : lo.x, j ? hi.y : lo.y, k ? hi.z : lo.z];
        const quads = [
          [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
          [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
          [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
        ];
        for (const q of quads) for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...q[i]); col.push(c.r, c.g, c.b); }
      }
      const g = geo(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.group.add(new THREE.Mesh(g, basic(0xffffff, 1, { vertexColors: true, side: THREE.DoubleSide })));
    }

    // Digital billboards. A style is drawn once and shared; each screen gets its own copy to animate.
    if (map.screens?.length) {
      const styles = new Map<string, THREE.CanvasTexture>();
      for (const sc of map.screens) {
        const dx = sc.max.x - sc.min.x, dy = sc.max.y - sc.min.y, dz = sc.max.z - sc.min.z;
        const along = sc.face === '+x' || sc.face === '-x' ? dz : dx;
        const vertical = dy > along * 1.5;
        const key = `${sc.style % 12}:${vertical}`;
        let base = styles.get(key);
        if (!base) { styles.set(key, (base = billboardTexture(sc.style % 12, vertical))); this.owned.push(base); }
        const tex = base.clone();
        this.owned.push(tex);
        const mesh = new THREE.Mesh(geo(new THREE.PlaneGeometry(along, dy)), basic(0xffffff, 1, { map: tex }));
        const n = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] }[sc.face];
        const cx = (sc.min.x + sc.max.x) / 2, cz = (sc.min.z + sc.max.z) / 2;
        // On the face of the box, a hair in front of it.
        const fx = n[0] > 0 ? sc.max.x + 0.02 : n[0] < 0 ? sc.min.x - 0.02 : cx;
        const fz = n[1] > 0 ? sc.max.z + 0.02 : n[1] < 0 ? sc.min.z - 0.02 : cz;
        mesh.position.set(fx, (sc.min.y + sc.max.y) / 2, fz);
        mesh.rotation.y = Math.atan2(n[0], n[1]);
        this.group.add(mesh);
        this.screens.push({ tex, phase: (sc.style * 1.37) % 7, every: 2.6 + (sc.style % 5) * 0.4 });
      }
    }

    // Traffic: each lane a stream of little lights.
    if (map.traffic?.length) {
      const dot = geo(new THREE.BoxGeometry(1.4, 0.35, 0.35));
      for (const l of map.traffic) {
        const mesh = new THREE.InstancedMesh(dot, basic(l.color), l.count);
        const a = new THREE.Vector3(l.a.x, l.a.y, l.a.z), b = new THREE.Vector3(l.b.x, l.b.y, l.b.z);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.lanes.push({ mesh, a, b, count: l.count, speed: l.speed, len: a.distanceTo(b), phase: (a.x * 0.37 + a.z * 0.11) % 1 });
      }
    }

    if (map.life?.length) {
      this.life = new Life(map.life);
      this.group.add(this.life.group);
    }

    // Holograms: big translucent shapes turning in the sky.
    for (const h of map.holos ?? []) {
      const mat = basic(h.color, 0.35, { wireframe: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const shape = [
        new THREE.TorusKnotGeometry(h.size * 0.6, h.size * 0.12, 64, 8),
        new THREE.IcosahedronGeometry(h.size, 1),
        new THREE.TorusGeometry(h.size, h.size * 0.08, 6, 32),
        new THREE.OctahedronGeometry(h.size, 0),
      ][h.kind % 4];
      const obj = new THREE.Mesh(geo(shape), mat);
      obj.position.set(h.pos.x, h.pos.y, h.pos.z);
      this.group.add(obj);
      this.holos.push({ obj, y: h.pos.y, spin: 0.25 + (h.kind % 3) * 0.12, bob: h.size * 0.08 });
    }

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

    // Parkour booster strips: arrows racing along them, the way they send you.
    for (const t of map.triggers) {
      if (t.type !== 'boost') continue;
      const speed = Math.hypot(t.vel.x, t.vel.z);
      const dx = t.vel.x / speed, dz = t.vel.z / speed;
      const alongX = Math.abs(dx) > Math.abs(dz);
      const len = alongX ? t.max.x - t.min.x : t.max.z - t.min.z;
      const across = alongX ? t.max.z - t.min.z : t.max.x - t.min.x;
      const rows = Math.max(1, Math.floor(across / 3));
      const boostMat = basic(0x3affd2, 0.9, { side: THREE.DoubleSide, depthWrite: false });
      for (let r = 0; r < rows; r++) {
        const off = (r + 0.5) / rows;
        const ox = alongX ? (dx > 0 ? t.min.x : t.max.x) : t.min.x + (t.max.x - t.min.x) * off;
        const oz = alongX ? t.min.z + (t.max.z - t.min.z) * off : (dz > 0 ? t.min.z : t.max.z);
        for (let k = 0; k < 3; k++) {
          const mesh = new THREE.Mesh(tri, boostMat);
          mesh.position.y = t.min.y + 0.06;
          mesh.scale.setScalar(1.6);
          mesh.rotation.y = Math.atan2(-dz, dx);
          this.group.add(mesh);
          this.chevrons.push({ mesh, ox, oz, dx, dz, len, phase: (k / 3) * len, speed: 9 });
        }
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
      } else if (t.type === 'teleporter' && !t.plain) {
        const color = TELE_COLORS[t.pair % TELE_COLORS.length];
        const plate = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.8, 0.9, 0.1, 8)), basic(color));
        plate.position.set(cx, t.min.y + 0.05, cz);
        const beamMat = basic(color, 0.3, { side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
        const beam = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.7, 0.7, h, 6, 1, true)), beamMat);
        beam.position.set(cx, t.min.y + h / 2, cz);
        this.pulsing.push({ mat: beamMat, base: 0.3, speed: 3 });
        this.spinning.push(beam);
        this.group.add(plate, beam);
      } else if (t.type === 'start' || t.type === 'checkpoint' || t.type === 'finish') {
        // Parkour: a glowing volume over the platform, and a beam of light at each corner, seen from far off.
        const color = t.type === 'start' ? 0xffffff : t.type === 'checkpoint' ? 0x3aff8a : 0xffd23a;
        const fillMat = basic(color, 0.08, { depthWrite: false, blending: THREE.AdditiveBlending }); // outside only: from inside it would tint everything
        const fill = new THREE.Mesh(geo(new THREE.BoxGeometry(w, h, d)), fillMat);
        fill.position.set(cx, t.min.y + h / 2, cz);
        const beamMat = basic(color, 0.35, { depthWrite: false, blending: THREE.AdditiveBlending });
        const beamGeo = geo(new THREE.BoxGeometry(0.18, 30, 0.18));
        for (const [bx, bz] of [[t.min.x, t.min.z], [t.min.x, t.max.z], [t.max.x, t.min.z], [t.max.x, t.max.z]]) {
          const beam = new THREE.Mesh(beamGeo, beamMat);
          beam.position.set(bx, t.min.y + 15, bz);
          this.group.add(beam);
        }
        this.group.add(fill);
      } else if (t.type === 'lowgrav') {
        const box = geo(new THREE.BoxGeometry(w, h, d));
        const fill = new THREE.Mesh(box, basic(0x8fb4ff, 0.07, { depthWrite: false })); // outside only: from inside it would haze everything
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
    // Billboards: the next slide every few seconds, and a moment of glitch as it changes.
    for (const sc of this.screens) {
      const t = time / sc.every + sc.phase;
      const frame = Math.floor(t) % FRAMES, into = t - Math.floor(t);
      const glitch = into < 0.06;
      sc.tex.offset.set(glitch ? (Math.sin(time * 97) * 0.08) : 0, 1 - (frame + 1) / FRAMES + (glitch ? 0.02 : 0));
    }
    // Traffic.
    const m = new THREE.Matrix4(), q = new THREE.Vector3();
    for (const l of this.lanes) {
      for (let i = 0; i < l.count; i++) {
        const f = ((time * l.speed) / l.len + i / l.count + l.phase) % 1;
        q.lerpVectors(l.a, l.b, f);
        m.makeTranslation(q.x, q.y, q.z);
        m.multiply(new THREE.Matrix4().makeRotationY(Math.atan2(-(l.b.z - l.a.z), l.b.x - l.a.x)));
        l.mesh.setMatrixAt(i, m);
      }
      l.mesh.instanceMatrix.needsUpdate = true;
    }
    this.life?.update(time);
    for (const h of this.holos) {
      h.obj.rotation.y = time * h.spin;
      h.obj.rotation.x = Math.sin(time * 0.3) * 0.3;
      h.obj.position.y = h.y + Math.sin(time * 0.7) * h.bob;
    }
  }

  /** The haze at this point (a tinted dark area: its colour, and its own fog distances if it has them), or null. */
  haze(p: { x: number; y: number; z: number }): { tint: number; fog?: [number, number] } | null {
    for (const b of this.dark) {
      if (b.tint !== undefined && p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return { tint: b.tint, fog: b.fog };
    }
    return null;
  }

  /** How dark it is at this point: 0 outside any dark area, up to 1. */
  darkness(p: { x: number; y: number; z: number }): number {
    let k = 0;
    for (const b of this.dark) {
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) k = Math.max(k, b.level ?? 1);
    }
    return k;
  }

  dispose(): void {
    this.life?.dispose();
    for (const o of this.owned) o.dispose();
  }
}
