import * as THREE from 'three';

// The MONOLOGUE's beam: a white-hot core in a wobbling cyan glow, with rings
// of light running down it towards whoever is caught. And the crackling
// shell around a player held in one. Endpoints come from the renderer; this
// only draws. Call begin(), then beam()/shell() for everything on screen this
// frame, then end() to put away whatever was not drawn.

const CORE = 0xeaffff, GLOW = 0x5ae0ff, SHELL = 0x7af0ff;
const HOT_CORE = 0xfff0e0, HOT_GLOW = 0xff3a22; // burning (both fire buttons): the beam runs red
const RINGS = 4;

const add = (color: number, opacity: number) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
});
const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
const ringGeo = new THREE.TorusGeometry(1, 0.18, 4, 12);
const shellGeo = new THREE.IcosahedronGeometry(1, 1);
const UP = new THREE.Vector3(0, 1, 0);

interface BeamView { group: THREE.Group; core: THREE.Mesh; glow: THREE.Mesh; rings: THREE.Mesh[]; used: boolean }
interface ShellView { group: THREE.Group; used: boolean }
interface FieldView { group: THREE.Group; ripple: THREE.Mesh; used: boolean }
const discGeo = new THREE.CircleGeometry(1, 32);
const rimGeo = new THREE.RingGeometry(0.93, 1, 32);

export class Beams {
  private beams = new Map<number, BeamView>();
  private shells = new Map<number, ShellView>();
  private fields = new Map<number, FieldView>();
  private dir = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {}

  begin(): void {
    for (const b of this.beams.values()) b.used = false;
    for (const s of this.shells.values()) s.used = false;
    for (const f of this.fields.values()) f.used = false;
  }

  /**
   * REARVIEW: player `id`'s field, an oval sheet of rippling silver facing
   * along `normal`. `own` = it is in front of our own eyes: fainter, so we can
   * still see through it.
   */
  field(id: number, centre: THREE.Vector3, normal: THREE.Vector3, radius: number, time: number, own: boolean): void {
    let f = this.fields.get(id);
    if (!f) {
      const group = new THREE.Group();
      const sheet = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
        color: 0xbfe4f4, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({
        color: 0xfff2c8, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      const ripple = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({
        color: 0x9ad8ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      group.add(sheet, rim, ripple);
      this.scene.add(group);
      this.fields.set(id, (f = { group, ripple, used: true }));
    }
    f.used = true;
    f.group.position.copy(centre);
    f.group.lookAt(centre.clone().add(normal));
    f.group.scale.set(radius * 0.85, radius, 1); // a vanity oval: taller than wide
    const k = (time * 1.2 + id * 0.37) % 1; // a ripple running out from the middle
    f.ripple.scale.setScalar(0.15 + k * 0.85);
    (f.ripple.material as THREE.MeshBasicMaterial).opacity = (own ? 0.2 : 0.45) * (1 - k);
    for (const m of f.group.children) {
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (m !== f.ripple) mat.opacity = (m === f.group.children[0] ? 0.16 : 0.55) * (own ? 0.45 : 1);
    }
  }

  /**
   * Player `id`'s beam from `from` to `to`. `locked` = it has someone: brighter,
   * and the rings run. `hot` = it is burning them: red, fatter, and faster.
   */
  beam(id: number, from: THREE.Vector3, to: THREE.Vector3, time: number, locked: boolean, hot = false): void {
    let b = this.beams.get(id);
    if (!b) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(tubeGeo, add(CORE, 0.95));
      const glow = new THREE.Mesh(tubeGeo, add(GLOW, 0.32));
      const rings = Array.from({ length: RINGS }, () => new THREE.Mesh(ringGeo, add(GLOW, 0.7)));
      group.add(core, glow, ...rings);
      this.scene.add(group);
      this.beams.set(id, (b = { group, core, glow, rings, used: true }));
    }
    b.used = true;
    (b.core.material as THREE.MeshBasicMaterial).color.setHex(hot ? HOT_CORE : CORE);
    (b.glow.material as THREE.MeshBasicMaterial).color.setHex(hot ? HOT_GLOW : GLOW);
    for (const r of b.rings) (r.material as THREE.MeshBasicMaterial).color.setHex(hot ? HOT_GLOW : GLOW);
    const len = Math.max(0.01, from.distanceTo(to));
    this.dir.subVectors(to, from).divideScalar(len);
    b.group.position.copy(from).addScaledVector(this.dir, len / 2);
    b.group.quaternion.setFromUnitVectors(UP, this.dir);
    const wobble = 1 + Math.sin(time * 37 + id) * 0.18 + Math.sin(time * 23) * 0.1;
    b.core.scale.set(0.022 * wobble, len, 0.022 * wobble);
    const fat = (locked ? 0.1 : 0.065) * (hot ? 1.5 : 1);
    b.glow.scale.set(fat * wobble, len, fat * wobble);
    (b.glow.material as THREE.MeshBasicMaterial).opacity = locked ? 0.38 : 0.24;
    b.rings.forEach((r, k) => {
      // Rings slide from the hand to the far end, growing as they go.
      const f = (time * (locked ? 1.6 : 0.9) * (hot ? 2.2 : 1) + k / RINGS) % 1;
      r.visible = locked || k % 2 === 0;
      r.position.set(0, (f - 0.5) * len, 0);
      r.rotation.set(Math.PI / 2, 0, 0);
      r.scale.setScalar(0.05 + f * 0.09);
      (r.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - f * 0.6);
    });
  }

  /** The shell around player `id`, frozen in a beam, centred on `at`. `hot`: the beam is burning them (red, faster). */
  shell(id: number, at: THREE.Vector3, time: number, hot = false): void {
    let s = this.shells.get(id);
    if (!s) {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
        color: SHELL, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const fill = new THREE.Mesh(shellGeo, add(GLOW, 0.1));
      group.add(mesh, fill);
      this.scene.add(group);
      this.shells.set(id, (s = { group, used: true }));
    }
    s.used = true;
    for (const m of s.group.children as THREE.Mesh[]) (m.material as THREE.MeshBasicMaterial).color.setHex(hot ? HOT_GLOW : m === s.group.children[0] ? SHELL : GLOW);
    s.group.position.copy(at);
    const pulse = 1 + Math.sin(time * (hot ? 22 : 9) + id) * (hot ? 0.07 : 0.04);
    s.group.scale.set(0.72 * pulse, 1.12 * pulse, 0.72 * pulse);
    s.group.rotation.set(Math.sin(time * 1.3) * 0.15, time * 1.7, 0);
  }

  end(): void {
    for (const [id, b] of this.beams) if (!b.used) { this.scene.remove(b.group); this.beams.delete(id); }
    for (const [id, s] of this.shells) if (!s.used) { this.scene.remove(s.group); this.shells.delete(id); }
    for (const [id, f] of this.fields) if (!f.used) { this.scene.remove(f.group); this.fields.delete(id); }
  }

  clear(): void {
    this.begin();
    this.end();
  }
}
