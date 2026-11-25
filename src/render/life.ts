import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LifeDef } from '../sim/map';

// Living scenery: birds, butterflies, falling water, fire, walking animals,
// drifting clouds, blowing sand. Everything is animated from the clock alone,
// instanced where there are many, and none of it is solid.

/** A small steady random number from an index (the same every frame). */
const hash = (i: number, k = 0) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };

/** Boxes merged into one geometry: [w, h, d, x, y, z] each. */
function boxes(parts: number[][]): THREE.BufferGeometry {
  return mergeGeometries(parts.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)))!;
}

/** A striped texture for falls: streaks of light and dark that stream down as its offset moves. */
function streakTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 64;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 16; x++) {
      const v = 0.72 + 0.28 * Math.sin(y * 0.4 + hash(x) * 6) + (hash(x, y) - 0.5) * 0.25;
      const g = Math.max(0, Math.min(255, Math.round(v * 255)));
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Anim { (time: number): void }

export class Life {
  group = new THREE.Group();
  private anims: Anim[] = [];
  private owned: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(defs: LifeDef[]) {
    const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => { this.owned.push(x); return x; };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();
    // Shared shapes.
    const wing = keep(boxes([[0.9, 0.08, 0.35, -0.45, 0, 0], [0.9, 0.08, 0.35, 0.45, 0, 0], [0.3, 0.2, 0.6, 0, 0, 0]]));
    const mote = keep(new THREE.BoxGeometry(1, 1, 1));
    const beast = keep(boxes([[0.9, 0.7, 1.5, 0, 0.9, 0], [0.6, 0.6, 0.6, 0, 1.25, 0.95], [0.25, 0.6, 0.25, -0.3, 0.3, 0.55], [0.25, 0.6, 0.25, 0.3, 0.3, 0.55], [0.25, 0.6, 0.25, -0.3, 0.3, -0.55], [0.25, 0.6, 0.25, 0.3, 0.3, -0.55]]));
    const camel = keep(boxes([[0.8, 0.8, 2, 0, 1.9, 0], [0.7, 0.6, 0.8, 0, 2.55, -0.2], [0.35, 1.1, 0.35, 0, 2.3, 1.15], [0.4, 0.35, 0.7, 0, 2.85, 1.35],
      [0.25, 1.5, 0.25, -0.25, 0.75, 0.7], [0.25, 1.5, 0.25, 0.25, 0.75, 0.7], [0.25, 1.5, 0.25, -0.25, 0.75, -0.7], [0.25, 1.5, 0.25, 0.25, 0.75, -0.7]]));
    const alien = keep(boxes([[0.22, 0.7, 0.22, -0.16, 0.35, 0], [0.22, 0.7, 0.22, 0.16, 0.35, 0], [0.5, 0.7, 0.3, 0, 1.05, 0], [0.16, 0.6, 0.16, -0.38, 1.05, 0], [0.16, 0.6, 0.16, 0.38, 1.05, 0],
      [0.75, 0.6, 0.6, 0, 1.7, 0], [0.06, 0.4, 0.06, -0.2, 2.15, 0], [0.06, 0.4, 0.06, 0.2, 2.15, 0], [0.12, 0.12, 0.12, -0.2, 2.38, 0], [0.12, 0.12, 0.12, 0.2, 2.38, 0]]));
    const streaks = keep(streakTexture());

    for (const d of defs) {
      switch (d.kind) {
        case 'flock': {
          // Birds circling, each at its own radius, height and place round the ring; wings flap by squashing the V.
          const mesh = new THREE.InstancedMesh(wing, keep(new THREE.MeshBasicMaterial({ color: d.color })), d.count);
          mesh.frustumCulled = false;
          this.group.add(mesh);
          this.anims.push((t) => {
            for (let i = 0; i < d.count; i++) {
              const a = t * d.speed / d.radius + (i / d.count) * Math.PI * 2 + hash(i) * 0.6;
              const r = d.radius * (0.75 + hash(i, 1) * 0.5);
              p.set(d.center.x + Math.cos(a) * r, d.center.y + Math.sin(t * 0.7 + i) * 1.5 + hash(i, 2) * 4, d.center.z + Math.sin(a) * r);
              e.set(0, -a, Math.sin(t * 0.8 + i) * 0.2);
              q.setFromEuler(e);
              const flap = Math.sin(t * 9 + i * 1.7);
              s.set(d.size, d.size * (0.4 + flap * 1.4), d.size);
              m.compose(p, q, s);
              mesh.setMatrixAt(i, m);
            }
            mesh.instanceMatrix.needsUpdate = true;
          });
          break;
        }
        case 'swarm': {
          const mesh = new THREE.InstancedMesh(mote, keep(new THREE.MeshBasicMaterial({ color: 0xffffff })), d.count);
          mesh.frustumCulled = false;
          const c = new THREE.Color();
          for (let i = 0; i < d.count; i++) mesh.setColorAt(i, c.setHex(d.colors[i % d.colors.length]));
          this.group.add(mesh);
          this.anims.push((t) => {
            for (let i = 0; i < d.count; i++) {
              const a = t * (0.4 + hash(i) * 0.6) + i;
              p.set(d.center.x + Math.sin(a * 1.3) * d.spread * hash(i, 1), d.center.y + Math.sin(a * 2.1) * 1.2 + hash(i, 2) * 2, d.center.z + Math.cos(a) * d.spread * hash(i, 3));
              const flap = 0.3 + Math.abs(Math.sin(t * 14 + i)) * 0.7;
              s.set(d.size * flap, d.size * 0.2, d.size * 0.6);
              q.setFromEuler(e.set(0, a, 0));
              mesh.setMatrixAt(i, m.compose(p, q, s));
            }
            mesh.instanceMatrix.needsUpdate = true;
          });
          break;
        }
        case 'fall': {
          const w = d.max.x - d.min.x, h = d.max.y - d.min.y, dd = d.max.z - d.min.z;
          const tex = keep(streaks.clone());
          tex.repeat.set(1, h / 3);
          const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, dd)), keep(new THREE.MeshBasicMaterial({ map: tex, color: d.color, transparent: true, opacity: 0.85, depthWrite: false })));
          mesh.position.set((d.min.x + d.max.x) / 2, (d.min.y + d.max.y) / 2, (d.min.z + d.max.z) / 2);
          this.group.add(mesh);
          // A puff of spray where it ends.
          const foam = new THREE.Mesh(keep(new THREE.BoxGeometry(w * 2.2, 0.8, Math.max(dd, 0.5) * 2.2)), keep(new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.35, depthWrite: false })));
          foam.position.set(mesh.position.x, d.min.y + 0.3, mesh.position.z);
          this.group.add(foam);
          this.anims.push((t) => {
            tex.offset.y = t * d.speed / 3;
            foam.scale.set(1 + Math.sin(t * 6) * 0.08, 1 + Math.sin(t * 9) * 0.2, 1 + Math.cos(t * 7) * 0.08);
          });
          break;
        }
        case 'flame': {
          // Three tongues of fire, each flickering on its own.
          const cols = [0xff3a10, 0xff9a20, 0xffe060];
          const parts = cols.map((col, i) => {
            const mesh = new THREE.Mesh(mote, keep(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 - i * 0.1, depthWrite: false, blending: THREE.AdditiveBlending })));
            this.group.add(mesh);
            return mesh;
          });
          const seed = d.pos.x * 0.37 + d.pos.z * 0.71;
          this.anims.push((t) => {
            parts.forEach((mesh, i) => {
              const f = 0.75 + Math.sin(t * (11 + i * 3) + seed) * 0.15 + Math.sin(t * (23 + i * 5) + seed * 2) * 0.1;
              const sz = d.size * (1 - i * 0.28);
              mesh.scale.set(sz * f, sz * (1.4 + i * 0.3) * f, sz * f);
              mesh.position.set(d.pos.x + Math.sin(t * 7 + i + seed) * 0.05 * d.size, d.pos.y + mesh.scale.y / 2, d.pos.z + Math.cos(t * 6 + i + seed) * 0.05 * d.size);
              mesh.rotation.y = t * (1 + i) + seed;
            });
          });
          break;
        }
        case 'walkers': {
          const mesh = new THREE.InstancedMesh(d.shape === 'camel' ? camel : d.shape === 'alien' ? alien : beast, keep(new THREE.MeshLambertMaterial({ color: 0xffffff })), d.count);
          mesh.frustumCulled = false;
          const c = new THREE.Color();
          for (let i = 0; i < d.count; i++) mesh.setColorAt(i, c.setHex(d.colors[i % d.colors.length]));
          this.group.add(mesh);
          const len = Math.hypot(d.b.x - d.a.x, d.b.z - d.a.z), yaw = Math.atan2(d.b.x - d.a.x, d.b.z - d.a.z);
          this.anims.push((t) => {
            for (let i = 0; i < d.count; i++) {
              // there and back: a triangle wave along the path, the line keeping its order
              const u = ((t * d.speed) / len + i * (d.gap / len) * -1) % 2;
              const w = u < 0 ? u + 2 : u;
              const f = w < 1 ? w : 2 - w, back = w >= 1;
              p.set(d.a.x + (d.b.x - d.a.x) * f, d.a.y + Math.abs(Math.sin(t * 6 + i)) * 0.08 * d.size, d.a.z + (d.b.z - d.a.z) * f);
              q.setFromEuler(e.set(0, yaw + (back ? Math.PI : 0), Math.sin(t * 6 + i) * 0.04));
              s.setScalar(d.size);
              mesh.setMatrixAt(i, m.compose(p, q, s));
            }
            mesh.instanceMatrix.needsUpdate = true;
          });
          break;
        }
        case 'mummy': {
          // Wrapped in yellowed bandages (dark straps round them), arms out in front, eyes glowing green.
          // It shuffles from a to b and back: legs dragging, body lurching side to side, arms bobbing.
          const wrap = keep(new THREE.MeshLambertMaterial({ color: 0xd8cba4 }));
          const strap = keep(new THREE.MeshLambertMaterial({ color: 0x8a7a58 }));
          const eye = keep(new THREE.MeshBasicMaterial({ color: 0x8aff5a }));
          const root = new THREE.Group(), body = new THREE.Group();
          const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material) => { const o = new THREE.Mesh(keep(geo), mat); parent.add(o); return o; };
          add(body, boxes([[0.78, 0.9, 0.44, 0, 1.33, 0], [0.5, 0.52, 0.48, 0, 2.03, 0.02]]), wrap); // torso, head
          add(body, boxes([[0.82, 0.08, 0.48, 0, 1.0, 0], [0.82, 0.08, 0.48, 0, 1.3, 0], [0.82, 0.08, 0.48, 0, 1.62, 0], [0.54, 0.07, 0.52, 0, 1.92, 0.02], [0.54, 0.07, 0.52, 0, 2.18, 0.02],
            [0.1, 0.6, 0.05, 0.25, 0.95, -0.24]]), strap); // straps round the body and head, one hanging loose behind
          add(body, boxes([[0.1, 0.07, 0.05, -0.12, 2.06, 0.27], [0.1, 0.07, 0.05, 0.12, 2.06, 0.27]]), eye);
          const arms = new THREE.Group();
          arms.position.set(0, 1.68, 0);
          add(arms, boxes([[0.2, 0.2, 0.8, -0.32, 0, 0.4], [0.2, 0.2, 0.8, 0.32, 0, 0.4]]), wrap);
          add(arms, boxes([[0.22, 0.22, 0.07, -0.32, 0, 0.3], [0.22, 0.22, 0.07, 0.32, 0, 0.55], [0.06, 0.45, 0.04, -0.36, -0.25, 0.78]]), strap); // a strip trailing from one hand
          body.add(arms);
          const legs = [-0.18, 0.18].map((x) => {
            const hip = new THREE.Group();
            hip.position.set(x, 0.9, 0);
            add(hip, boxes([[0.32, 0.9, 0.34, 0, -0.45, 0]]), wrap);
            add(hip, boxes([[0.35, 0.07, 0.37, 0, -0.3, 0], [0.35, 0.07, 0.37, 0, -0.65, 0]]), strap);
            root.add(hip);
            return hip;
          });
          root.add(body);
          root.scale.setScalar(d.size);
          this.group.add(root);
          const len = Math.hypot(d.b.x - d.a.x, d.b.z - d.a.z), yaw = Math.atan2(d.b.x - d.a.x, d.b.z - d.a.z);
          this.anims.push((t) => {
            const u = ((t * d.speed) / len) % 2, f = u < 1 ? u : 2 - u, back = u >= 1;
            const step = Math.sin(t * d.speed * 4.5);
            root.position.set(d.a.x + (d.b.x - d.a.x) * f, d.a.y + Math.abs(step) * 0.05 * d.size, d.a.z + (d.b.z - d.a.z) * f);
            root.rotation.y = yaw + (back ? Math.PI : 0);
            body.rotation.z = step * 0.1; // the lurch
            body.rotation.x = 0.08;
            arms.rotation.x = Math.sin(t * 1.9) * 0.14 - 0.05;
            legs[0].rotation.x = step * 0.35;
            legs[1].rotation.x = -step * 0.35;
          });
          break;
        }
        case 'snakes': {
          // Cobras: a chain of segments each, slithering about the patch on a slow wandering
          // path, the body swinging side to side behind the head; the front of each reared up,
          // hood spread, head swaying, a red tongue flicking. Dark bands down the back.
          const SEG = 16, n = d.count * SEG;
          const body = new THREE.InstancedMesh(mote, keep(new THREE.MeshLambertMaterial({ color: 0xffffff })), n);
          body.frustumCulled = false;
          const c = new THREE.Color();
          for (let i = 0; i < n; i++) {
            const k = i % SEG, sn = Math.floor(i / SEG);
            const base = sn % 2 ? 0xb8903a : 0x8a7a3a; // tan and olive cobras
            body.setColorAt(i, c.setHex(k === 0 ? 0x5a4420 : k % 3 === 2 ? 0x2a2014 : base)); // dark bands down the back
          }
          const eyes = new THREE.InstancedMesh(mote, keep(new THREE.MeshBasicMaterial({ color: 0xffd23a })), d.count * 2);
          const tongues = new THREE.InstancedMesh(mote, keep(new THREE.MeshBasicMaterial({ color: 0xd01a1a })), d.count);
          eyes.frustumCulled = tongues.frustumCulled = false;
          this.group.add(body, eyes, tongues);
          const cx = (d.min.x + d.max.x) / 2, cz = (d.min.z + d.max.z) / 2;
          const ax = (d.max.x - d.min.x) / 2 * 0.8, az = (d.max.z - d.min.z) / 2 * 0.8, y0 = d.min.y;
          const path = (sn: number, t: number, out: THREE.Vector3) => {
            const w1 = (0.5 + hash(sn, 1) * 0.4) / Math.max(1, ax), w2 = (0.5 + hash(sn, 2) * 0.4) / Math.max(1, az); // about a metre a second
            return out.set(cx + ax * Math.sin(t * w1 + hash(sn, 3) * 6.28), y0, cz + az * Math.sin(t * w2 + hash(sn, 4) * 6.28));
          };
          const a = new THREE.Vector3(), b = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
          this.anims.push((t) => {
            for (let sn = 0; sn < d.count; sn++) {
              let headYaw = 0;
              for (let k = 0; k < SEG; k++) {
                const tk = t - k * 0.24; // each segment where the head was a moment ago (about 0.2 m behind)
                path(sn, tk, a); path(sn, tk + 0.05, b);
                fwd.subVectors(b, a); fwd.y = 0;
                const yaw = Math.atan2(fwd.x, fwd.z);
                side.set(Math.cos(yaw), 0, -Math.sin(yaw));
                const wig = Math.sin(t * 5 - k * 0.8) * 0.12 * Math.min(1, k / 3); // the slither
                const rear = Math.max(0, 4 - k); // the front four segments rear up
                const w = k === 0 ? 0.2 : k === 1 || k === 2 ? 0.34 : 0.18 * (1 - k / (SEG + 4)); // the hood behind the head
                p.set(a.x + side.x * wig, y0 + 0.08 + rear * 0.15, a.z + side.z * wig);
                if (k < 4) { // reared: lean back towards the body, sway a little
                  p.x += Math.sin(t * 1.7 + sn) * 0.05 * rear;
                }
                q.setFromEuler(e.set(k < 4 ? -0.5 : 0, yaw, 0));
                s.set(w * 1.15, k < 4 ? 0.16 : 0.14, 0.3);
                body.setMatrixAt(sn * SEG + k, m.compose(p, q, s));
                if (k === 0) {
                  headYaw = yaw;
                  for (const ey of [-1, 1]) {
                    eyes.setMatrixAt(sn * 2 + (ey > 0 ? 1 : 0), m.compose(b.set(p.x + side.x * ey * 0.07 + Math.sin(yaw) * 0.08, p.y + 0.06, p.z + side.z * ey * 0.07 + Math.cos(yaw) * 0.08), q, s.setScalar(0.04)));
                  }
                  const flick = Math.sin(t * 9 + sn * 2) > 0.3 ? 1 : 0; // the tongue darts in and out
                  tongues.setMatrixAt(sn, m.compose(b.set(p.x + Math.sin(headYaw) * (0.17 + flick * 0.08), p.y - 0.02, p.z + Math.cos(headYaw) * (0.17 + flick * 0.08)), q, s.set(0.03, 0.02, 0.06 + flick * 0.12)));
                }
              }
            }
            body.instanceMatrix.needsUpdate = eyes.instanceMatrix.needsUpdate = tongues.instanceMatrix.needsUpdate = true;
          });
          break;
        }
        case 'dragon': {
          // A great dragon of the starlit realm: silver-blue scales, a pale belly, wide wings of
          // deep blue membrane on pale bones, a ridge of glowing cyan crystals down its back and
          // tail, cyan eyes. It circles, banking into the turn, rising and falling, wings beating,
          // neck and tail swaying. Built facing +z, about 30 m from snout to tail at size 1.
          const scale = keep(new THREE.MeshLambertMaterial({ color: 0x8ea4c8 }));
          const belly = keep(new THREE.MeshLambertMaterial({ color: 0xd4deee }));
          const membrane = keep(new THREE.MeshLambertMaterial({ color: 0x3e5a9a, side: THREE.DoubleSide }));
          const bone = keep(new THREE.MeshLambertMaterial({ color: 0xe6eefa }));
          const shine = keep(new THREE.MeshBasicMaterial({ color: 0x6af0ff }));
          const add = (parent: THREE.Object3D, parts: number[][], mat: THREE.Material) => { const o = new THREE.Mesh(keep(boxes(parts)), mat); parent.add(o); return o; };
          const root = new THREE.Group(), body = new THREE.Group();
          root.add(body);
          root.rotation.order = 'YXZ';
          add(body, [[2.6, 2.3, 6.4, 0, 0, 0], [2.9, 2.6, 2.6, 0, 0.1, 2.6]], scale); // body, chest
          add(body, [[2.2, 0.5, 7.5, 0, -1.2, 0.6]], belly);
          add(body, [[0.4, 0.8, 0.5, 0, 1.45, -2.4], [0.45, 1.1, 0.55, 0, 1.6, -0.6], [0.5, 1.3, 0.6, 0, 1.7, 1.2], [0.45, 1.0, 0.5, 0, 1.6, 2.9]], shine); // the crystal ridge
          add(body, [[0.6, 1.6, 0.8, -1.1, -1.6, 2.6], [0.6, 1.6, 0.8, 1.1, -1.6, 2.6], [0.6, 1.4, 0.9, -1.0, -1.5, -2.2], [0.6, 1.4, 0.9, 1.0, -1.5, -2.2]], scale); // legs, tucked
          // the neck: a chain of segments rising forward, the head at its end
          const neck: THREE.Group[] = [];
          let at: THREE.Object3D = body, z0 = 3.6;
          for (let i = 0; i < 5; i++) {
            const g = new THREE.Group();
            g.position.set(0, i ? 0.35 : 0.6, z0);
            const w = 1.6 - i * 0.12;
            add(g, [[w, w, 1.9, 0, 0, 0.9]], scale);
            add(g, [[w * 0.8, 0.3, 1.8, 0, -w / 2, 0.9]], belly);
            add(g, [[0.3, 0.55, 0.4, 0, w / 2 + 0.2, 0.9]], shine);
            at.add(g); neck.push(g); at = g; z0 = 1.8;
          }
          const head = new THREE.Group();
          head.position.set(0, 0.1, 1.9);
          add(head, [[1.8, 1.3, 2.4, 0, 0, 0.9], [1.3, 0.8, 1.6, 0, -0.1, 2.7]], scale); // skull, snout
          add(head, [[1.2, 0.35, 2.6, 0, -0.75, 1.9]], belly); // jaw
          add(head, [[0.3, 0.3, 2.2, -0.6, 0.75, -0.3], [0.3, 0.3, 2.2, 0.6, 0.75, -0.3], [0.22, 0.22, 1.2, -0.75, 0.95, -1.4], [0.22, 0.22, 1.2, 0.75, 0.95, -1.4]], bone); // horns swept back
          add(head, [[0.3, 0.2, 0.2, -0.72, 0.25, 1.9], [0.3, 0.2, 0.2, 0.72, 0.25, 1.9]], shine); // eyes
          head.rotation.x = 0.25;
          at.add(head);
          // the tail: a tapering chain, a crystal fin at its tip
          const tail: THREE.Group[] = [];
          at = body; z0 = -3.2;
          for (let i = 0; i < 8; i++) {
            const g = new THREE.Group();
            g.position.set(0, i ? 0 : 0.1, z0);
            const w = 1.9 - i * 0.2;
            add(g, [[w, w * 0.9, 2.1, 0, 0, -1.0]], scale);
            if (i % 2 === 0) add(g, [[0.25, 0.5, 0.35, 0, w * 0.45 + 0.2, -1.0]], shine);
            at.add(g); tail.push(g); at = g; z0 = -2.0;
          }
          add(at, [[0.2, 1.6, 1.4, 0, 0.5, -2.4], [0.2, 1.0, 1.0, 0, -0.5, -2.3]], shine);
          // the wings: an inner and an outer panel each side, on pale bones, hinged at shoulder and elbow
          const wings = [-1, 1].map((sd) => {
            const shoulder = new THREE.Group();
            shoulder.position.set(sd * 1.2, 0.9, 1.4);
            add(shoulder, [[7, 0.12, 5, sd * 3.5, 0, -1.6]], membrane);
            add(shoulder, [[7, 0.4, 0.45, sd * 3.5, 0.1, 0.8]], bone);
            const elbow = new THREE.Group();
            elbow.position.set(sd * 7, 0, 0.6);
            add(elbow, [[7.5, 0.1, 4, sd * 3.7, 0, -2.2]], membrane);
            add(elbow, [[7.5, 0.32, 0.38, sd * 3.7, 0.08, 0.2], [0.3, 0.25, 4.2, sd * 4.5, 0.05, -2.1], [0.3, 0.25, 3.6, sd * 7.2, 0.05, -1.8]], bone);
            add(elbow, [[0.5, 0.5, 0.9, sd * 7.6, 0.1, 0.5]], bone); // a claw at the wrist
            shoulder.add(elbow);
            body.add(shoulder);
            return { shoulder, elbow, sd };
          });
          root.scale.setScalar(d.size);
          this.group.add(root);
          this.anims.push((t) => {
            const th = (t * d.speed) / d.radius;
            const swoop = Math.sin(t * 0.45);
            root.position.set(d.center.x + Math.cos(th) * d.radius, d.center.y + swoop * 4 * d.size, d.center.z + Math.sin(th) * d.radius);
            root.rotation.y = Math.atan2(-Math.sin(th), Math.cos(th)); // along its path (anticlockwise seen from above)
            root.rotation.z = -0.28; // banking into the turn
            root.rotation.x = -Math.cos(t * 0.45) * 0.12; // nose up as it climbs, down as it dives
            const beat = Math.sin(t * 2.3);
            for (const w of wings) {
              w.shoulder.rotation.z = w.sd * (beat * 0.55 + 0.1);
              w.elbow.rotation.z = w.sd * (Math.sin(t * 2.3 - 0.7) * 0.35 - 0.05);
            }
            body.position.y = -beat * 0.35; // each beat lifts it
            neck.forEach((g, i) => { g.rotation.y = Math.sin(t * 1.1 + i * 0.5) * 0.07; g.rotation.x = -0.12 + Math.sin(t * 0.9 + i * 0.4) * 0.04; });
            tail.forEach((g, i) => { g.rotation.y = Math.sin(t * 1.5 - i * 0.55) * 0.12; g.rotation.x = 0.03; });
          });
          break;
        }
        case 'clouds': {
          const mesh = new THREE.InstancedMesh(mote, keep(new THREE.MeshBasicMaterial({ color: 0xffffff })), d.boxes.length);
          mesh.frustumCulled = false;
          this.group.add(mesh);
          const span = d.x1 - d.x0;
          this.anims.push((t) => {
            d.boxes.forEach((bx, i) => {
              let x = (bx.x - d.x0 + t * d.speed) % span;
              if (x < 0) x += span;
              mesh.setMatrixAt(i, m.compose(p.set(d.x0 + x, bx.y, bx.z), q.identity(), s.set(bx.w, 2, bx.d)));
            });
            mesh.instanceMatrix.needsUpdate = true;
          });
          break;
        }
        case 'pyramidWorks': {
          this.pyramidWorks(d, keep);
          break;
        }
        case 'wind': {
          const mesh = new THREE.InstancedMesh(mote, keep(new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.7, depthWrite: false })), d.count);
          mesh.frustumCulled = false;
          this.group.add(mesh);
          const span = d.x1 - d.x0;
          this.anims.push((t) => {
            for (let i = 0; i < d.count; i++) {
              const x = (hash(i) * span + t * d.speed * (0.7 + hash(i, 1) * 0.6)) % span;
              const y = d.y0 + (d.y1 - d.y0) * hash(i, 2) + Math.sin(t * 2 + i) * 0.6;
              const z = d.z0 + (d.z1 - d.z0) * hash(i, 3) + Math.sin(t * 1.3 + i * 0.7) * 1.5;
              mesh.setMatrixAt(i, m.compose(p.set(d.x0 + x, y, z), q.identity(), s.set(0.9, 0.06, 0.06)));
            }
            mesh.instanceMatrix.needsUpdate = true;
          });
          break;
        }
      }
    }
  }

  /**
   * The aliens' building site. Tiers of big blocks, each tier two blocks
   * narrower than the one below; the top tiers go up block by block. Every
   * block has a saucer and a moment: the saucer lifts it off the stockpile in a
   * beam, flies it over, lowers it into place. A cycle: build, glow, take apart.
   */
  private pyramidWorks(d: Extract<LifeDef, { kind: 'pyramidWorks' }>, keep: <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T) => T): void {
    const B = d.block, H = B * 0.7, c = d.center;
    const tiers = Math.ceil(d.base / 2);
    // Every block of the pyramid: where it sits, and its tier.
    const slots: { x: number; y: number; z: number; tier: number }[] = [];
    for (let t = 0; t < tiers; t++) {
      const n = d.base - 2 * t;
      const order: { x: number; y: number; z: number; tier: number }[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) order.push({ x: c.x + (i - (n - 1) / 2) * B, y: c.y + t * H + H / 2, z: c.z + (j - (n - 1) / 2) * B, tier: t });
      }
      if (t >= d.prebuilt) order.sort((a, b) => hash(a.x * 3.1 + a.z) - hash(b.x * 3.1 + b.z)); // built in no tidy order
      slots.push(...order);
    }
    const first = slots.findIndex((sl) => sl.tier >= d.prebuilt); // the first block still to come
    const toBuild = slots.length - first;
    const BUILD = 120, HOLD = 25, TEARDOWN = 8, CYCLE = BUILD + HOLD + TEARDOWN;
    const every = BUILD / toBuild, trip = 7;
    const placedAt = (k: number) => (k - first + 1) * every; // seconds into the cycle block k lands

    const stone = keep(new THREE.MeshLambertMaterial({ color: 0xd2ae74 }));
    const blockGeo = keep(new THREE.BoxGeometry(B * 0.98, H * 0.98, B * 0.98));
    const blocks = new THREE.InstancedMesh(blockGeo, stone, slots.length);
    blocks.frustumCulled = false;
    this.group.add(blocks);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    // The capstone: gold, glowing once the last block is in.
    const cap = new THREE.Mesh(keep(new THREE.OctahedronGeometry(B * 0.6, 0)), keep(new THREE.MeshBasicMaterial({ color: 0xffc83a })));
    cap.position.set(c.x, c.y + tiers * H + B * 0.4, c.z);
    this.group.add(cap);
    // The stockpile of quarried blocks beside the site.
    const pile = new THREE.Vector3(c.x + d.base * B * 0.5 + 30, c.y, c.z + 10);
    const pileMesh = new THREE.InstancedMesh(blockGeo, stone, 18);
    for (let i = 0; i < 18; i++) {
      const lvl = Math.floor(i / 9), k = i % 9;
      pileMesh.setMatrixAt(i, m.compose(p.set(pile.x + ((k % 3) - 1) * B, c.y + H / 2 + lvl * H, pile.z + (Math.floor(k / 3) - 1) * B), q.identity(), s.set(1, 1, 1)));
    }
    this.group.add(pileMesh);
    // Saucers, each with the block it carries and its beam.
    const metal = keep(new THREE.MeshLambertMaterial({ color: 0x9aa4b0 }));
    const dome = keep(new THREE.MeshBasicMaterial({ color: 0x7affd0, transparent: true, opacity: 0.7 }));
    const lightMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff27a }));
    const beamMat = keep(new THREE.MeshBasicMaterial({ color: 0x5aff9a, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const discGeo = keep(new THREE.CylinderGeometry(4, 4.6, 0.9, 20)), domeGeo = keep(new THREE.SphereGeometry(1.8, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2));
    const lightGeo = keep(new THREE.BoxGeometry(0.5, 0.35, 0.5)), beamGeo = keep(new THREE.CylinderGeometry(1, 2.2, 1, 16, 1, true));
    const saucers = Array.from({ length: d.saucers }, () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(discGeo, metal));
      const dm = new THREE.Mesh(domeGeo, dome);
      dm.position.y = 0.4;
      g.add(dm);
      const lights = new THREE.Group();
      for (let i = 0; i < 8; i++) {
        const l = new THREE.Mesh(lightGeo, lightMat);
        l.position.set(Math.cos((i / 8) * Math.PI * 2) * 4.1, -0.1, Math.sin((i / 8) * Math.PI * 2) * 4.1);
        lights.add(l);
      }
      g.add(lights);
      const load = new THREE.Mesh(blockGeo, stone);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      this.group.add(g, load, beam);
      return { g, lights, load, beam };
    });
    // The mothership, high above, turning slowly; its beam lights the capstone when the work is done.
    const mother = new THREE.Group();
    mother.add(new THREE.Mesh(keep(new THREE.CylinderGeometry(26, 32, 5, 32)), metal));
    const ring = new THREE.Group();
    for (let i = 0; i < 24; i++) {
      const l = new THREE.Mesh(keep(new THREE.BoxGeometry(2.4, 1.6, 2.4)), i % 2 ? lightMat : dome);
      l.position.set(Math.cos((i / 24) * Math.PI * 2) * 31, -1.5, Math.sin((i / 24) * Math.PI * 2) * 31);
      ring.add(l);
    }
    mother.add(ring);
    // Its underside glows: a ring of light and a bright core (from below it would otherwise be a black hole in the sky).
    const under = new THREE.Mesh(keep(new THREE.TorusGeometry(20, 1.6, 6, 40)), keep(new THREE.MeshBasicMaterial({ color: 0x5aff9a })));
    under.rotation.x = Math.PI / 2;
    under.position.y = -2.6;
    mother.add(under);
    const core = new THREE.Mesh(keep(new THREE.CylinderGeometry(7, 7, 0.4, 24)), keep(new THREE.MeshBasicMaterial({ color: 0xd8fff0 })));
    core.position.y = -2.7;
    mother.add(core);
    const belly = new THREE.Mesh(keep(new THREE.CylinderGeometry(31, 31, 0.3, 32)), keep(new THREE.MeshBasicMaterial({ color: 0x3a4250 })));
    belly.position.y = -2.55;
    mother.add(belly);
    const motherY = c.y + tiers * H + 45;
    mother.position.set(c.x, motherY, c.z);
    const bigBeam = new THREE.Mesh(beamGeo, beamMat);
    this.group.add(mother, bigBeam);
    const cruise = c.y + tiers * H + 14;

    this.anims.push((time) => {
      const t = ((time % CYCLE) + CYCLE) % CYCLE;
      const tearing = t > BUILD + HOLD ? (t - BUILD - HOLD) / TEARDOWN : 0;
      // The blocks: the prebuilt tiers always, the rest once placed (lifting away again in the teardown).
      for (let k = 0; k < slots.length; k++) {
        const sl = slots[k];
        const shown = k < first || (t >= placedAt(k) && t < BUILD + HOLD + TEARDOWN);
        const lift = k >= first ? tearing * tearing * 120 : 0;
        const sc = shown ? (k >= first && tearing > 0 ? 1 - tearing : 1) : 0;
        blocks.setMatrixAt(k, m.compose(p.set(sl.x, sl.y + lift, sl.z), q.identity(), s.setScalar(Math.max(0.0001, sc))));
      }
      blocks.instanceMatrix.needsUpdate = true;
      const done = t >= BUILD && t < BUILD + HOLD;
      cap.visible = done || (tearing > 0 && tearing < 0.5);
      cap.rotation.y = time;
      // Saucers: each takes every nth block. Between trips it flies back to the stockpile.
      saucers.forEach((sc, i) => {
        // the trip this saucer is on (or the next one)
        let k = first + i;
        while (k < slots.length && placedAt(k) < t) k += d.saucers;
        const busy = k < slots.length && t >= placedAt(k) - trip && t < BUILD;
        const sl = slots[Math.min(k, slots.length - 1)];
        const slot = new THREE.Vector3(sl.x, sl.y, sl.z);
        let pos: THREE.Vector3, load: THREE.Vector3 | null = null;
        if (busy) {
          const u = (t - (placedAt(k) - trip)) / trip;
          const over = new THREE.Vector3(slot.x, cruise, slot.z), home = new THREE.Vector3(pile.x, cruise, pile.z);
          if (u < 0.25) { // lifting a block off the pile
            pos = home;
            load = new THREE.Vector3(pile.x, c.y + H * 2.5 + (cruise - 6 - c.y - H * 2.5) * (u / 0.25), pile.z);
          } else if (u < 0.75) { // flying it over
            const f = (u - 0.25) / 0.5, e = f * f * (3 - 2 * f);
            pos = home.clone().lerp(over, e);
            pos.y += Math.sin(f * Math.PI) * 6;
            load = pos.clone().setY(pos.y - 6);
          } else { // lowering it into place
            pos = over;
            load = new THREE.Vector3(slot.x, cruise - 6 + (slot.y - cruise + 6) * ((u - 0.75) / 0.25), slot.z);
          }
        } else {
          // idle: drift back over the pile (or circle there once the work is done)
          const a = time * 0.4 + i;
          pos = new THREE.Vector3(pile.x + Math.cos(a) * 12, cruise + 4 + Math.sin(time + i) * 1.5, pile.z + Math.sin(a) * 12);
        }
        sc.g.position.copy(pos);
        sc.g.position.y += Math.sin(time * 2 + i) * 0.3;
        sc.lights.rotation.y = time * 2;
        sc.load.visible = sc.beam.visible = !!load;
        if (load) {
          sc.load.position.copy(load);
          const len = Math.max(0.5, pos.y - load.y);
          sc.beam.position.set(pos.x, pos.y - len / 2, pos.z);
          sc.beam.scale.set(1, len, 1);
        }
      });
      mother.rotation.y = time * 0.05;
      ring.rotation.y = time * 0.3;
      bigBeam.visible = done;
      if (done) {
        const len = motherY - cap.position.y;
        bigBeam.position.set(c.x, cap.position.y + len / 2, c.z);
        bigBeam.scale.set(2.5 + Math.sin(time * 4) * 0.4, len, 2.5 + Math.sin(time * 4) * 0.4);
      }
    });
  }

  update(time: number): void {
    for (const a of this.anims) a(time);
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
  }
}
