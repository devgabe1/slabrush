import * as THREE from 'three';
import { flatMat } from './models';

// Wear and tear: the lower a player's health, the more beaten up they look.
// Seven wounds open one by one as health falls, from a bloody scuff to bare
// bone: ribs through the chest, the bones of an arm and a shin, and finally
// the skull showing through the face.
//
// Outfits differ wildly in shape (a barrel, a crate, a ribcage, stilts...), so
// nothing is placed by hand: when a character is built, a ray is cast at the
// body part from outside, and the wound is stuck to whatever surface it hits,
// facing out along that surface. Each wound is a child of its body part, so it
// moves with the arm, the leg, or the head (mouth included).

const BLOOD = 0x6a0c12, DEEP = 0x2a0508, BONE = 0xe8e0c8, BONE_DARK = 0xb8ad94, STAIN = 0x3a1a10;

/** HP below which each stage opens (out of 100). */
export const WOUND_STAGES = [85, 70, 57, 45, 33, 22, 12] as const;

interface Wound {
  group: THREE.Group;
  below: number; // shown while health is below this
  pop: number; // 0..1, grows in when it first opens
}

export interface Wounds {
  list: Wound[];
}

/** What the wounds are attached to. Everything must be in its rest pose, with the root at the origin. */
export interface WoundTargets {
  root: THREE.Object3D;
  torso: THREE.Object3D[]; // the torso's own meshes (not arms, head or hands)
  body: THREE.Object3D; // the torso's parent group
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  face: THREE.Object3D; // the head's meshes, inside the mouth's hinged lid
}

function box(g: THREE.Object3D, w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMat(color));
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// ----- the pieces. Each is built in a frame where +Z points out of the surface and +Y is up.

/** A raw wound: blood, a dark middle, a drip. */
function gash(g: THREE.Group, w: number, h: number): void {
  box(g, w, h, 0.01, BLOOD, 0, 0, 0.005);
  box(g, w * 0.7, h * 0.72, 0.01, DEEP, 0, 0, 0.009);
  box(g, 0.02, h * 0.45, 0.008, BLOOD, w * 0.22, -h * 0.6, 0.004);
}

/** A bone lying in the wound, knuckled at both ends, along Y. */
function bone(g: THREE.Group, len: number): void {
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, len, 6), flatMat(BONE));
  shaft.position.z = 0.02;
  g.add(shaft);
  for (const s of [-1, 1]) {
    box(g, 0.05, 0.035, 0.035, BONE, 0, (s * len) / 2, 0.02);
    box(g, 0.022, 0.03, 0.03, BONE_DARK, 0.013, (s * len) / 2 + s * 0.012, 0.024);
  }
}

const STAGE_BUILDERS: ((g: THREE.Group) => void)[] = [
  (g) => { // 85: a bloody scuff, no bone yet
    box(g, 0.14, 0.08, 0.008, STAIN, 0, 0, 0.004);
    box(g, 0.08, 0.06, 0.008, BLOOD, 0.03, -0.02, 0.007);
    box(g, 0.05, 0.03, 0.008, BLOOD, -0.05, 0.03, 0.006);
  },
  (g) => { gash(g, 0.09, 0.2); bone(g, 0.15); }, // 70: an arm opened to the bone
  (g) => { gash(g, 0.1, 0.22); bone(g, 0.17); }, // 57: a shin bone
  (g) => { // 45: ribs through the chest
    gash(g, 0.24, 0.26);
    for (const y of [-0.075, 0, 0.075]) box(g, 0.19, 0.026, 0.024, BONE, 0, y, 0.022);
    box(g, 0.03, 0.2, 0.026, BONE_DARK, 0, 0, 0.026); // the breastbone
  },
  (g) => { // 33: the skull through the cheek, teeth and all
    box(g, 0.13, 0.13, 0.01, BLOOD, 0, 0, 0.005);
    box(g, 0.1, 0.1, 0.02, BONE, 0, 0.005, 0.012);
    box(g, 0.04, 0.035, 0.012, DEEP, 0.015, 0.025, 0.024); // a socket
    for (let k = 0; k < 4; k++) box(g, 0.018, 0.026, 0.014, BONE, -0.034 + k * 0.022, -0.05, 0.02);
  },
  (g) => { gash(g, 0.09, 0.2); bone(g, 0.15); }, // 22: the other arm
  (g) => { gash(g, 0.1, 0.22); bone(g, 0.17); }, // 12: the other shin
];

/** Orient a wound so its +Z is `n` (both in the parent's space), keeping +Y as close to up as possible. */
function orient(g: THREE.Group, n: THREE.Vector3): void {
  const z = n.clone().normalize();
  const up = Math.abs(z.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

const ray = new THREE.Raycaster();

/**
 * Cast a ray at `targets` from `from` along `dir` (world space) and stick a
 * wound to the first surface it hits, as a child of `parent`. Returns null on
 * a miss (some legs and torsos have gaps; that wound is simply left out).
 */
function stick(parent: THREE.Object3D, targets: THREE.Object3D[], from: THREE.Vector3, dir: THREE.Vector3): THREE.Group | null {
  ray.set(from, dir.clone().normalize());
  ray.far = 5;
  const hit = ray.intersectObjects(targets, true).find((h) => h.face);
  if (!hit || !hit.face) return null;
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  if (n.dot(dir) > 0) n.negate(); // always facing back at the ray
  const g = new THREE.Group();
  const inv = parent.matrixWorld.clone().invert();
  g.position.copy(hit.point.clone().add(n.clone().multiplyScalar(0.004)).applyMatrix4(inv));
  orient(g, n.transformDirection(inv));
  parent.add(g);
  return g;
}

/** Build every wound for a character, hidden. `side` (1 or -1) mirrors which arm and leg go first. */
export function buildWounds(t: WoundTargets, side: number): Wounds {
  t.root.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(t.face);
  const faceMid = box3.getCenter(new THREE.Vector3()), faceSize = box3.getSize(new THREE.Vector3());
  const front = new THREE.Vector3(0, 0, 1); // rays travel towards +Z: they hit the front (-Z) of the body
  const at = (x: number, y: number) => new THREE.Vector3(x, y, -3);
  /** From the front at (x, y); if that goes through a gap (a ribcage, an open frame), try a little around it. */
  const near = (parent: THREE.Object3D, targets: THREE.Object3D[], x: number, y: number) => {
    for (const [dx, dy] of [[0, 0], [0, 0.04], [0, -0.04], [0.05, 0], [-0.05, 0], [0, 0.09], [0, -0.09], [0.05, 0.05], [-0.05, -0.05]]) {
      const g = stick(parent, targets, at(x + dx, y + dy), front);
      if (g) return g;
    }
    return null;
  };
  const legs = side > 0 ? [t.legR, t.legL] : [t.legL, t.legR];
  const arms = side > 0 ? [t.armR, t.armL] : [t.armL, t.armR];

  /** An arm: on its outer side, halfway down, whatever way it is pointing. */
  const onArm = (arm: THREE.Mesh) => {
    const out = arm === t.armR ? 1 : -1;
    const centre = new THREE.Vector3(0, -0.3, 0).applyMatrix4(arm.matrixWorld);
    const outward = new THREE.Vector3(out, 0, 0).transformDirection(arm.matrixWorld);
    return stick(arm, [arm], centre.clone().addScaledVector(outward, 1), outward.clone().negate());
  };
  /** A leg: on its front, at the shin. */
  const onLeg = (leg: THREE.Object3D) => {
    const p = new THREE.Vector3(0, -0.42, 0).applyMatrix4(leg.matrixWorld);
    return near(leg, [leg], p.x, p.y);
  };

  const places: (() => THREE.Group | null)[] = [
    () => near(t.body, t.torso, side * 0.11, 1.15), // scuff, high on the chest
    () => onArm(arms[0]),
    () => onLeg(legs[0]),
    () => near(t.body, t.torso, -side * 0.05, 0.98), // ribs
    () => near(t.face.parent!, [t.face], faceMid.x + side * faceSize.x * 0.22, faceMid.y - faceSize.y * 0.05), // cheek
    () => onArm(arms[1]),
    () => onLeg(legs[1]),
  ];
  const list: Wound[] = [];
  places.forEach((place, k) => {
    const g = place();
    if (!g) return;
    STAGE_BUILDERS[k](g);
    g.visible = false;
    list.push({ group: g, below: WOUND_STAGES[k], pop: 0 });
  });
  return { list };
}

/** Show the wounds for this much health, in percent of full (100 = none); each one pops in quickly when it opens. */
export function showWounds(w: Wounds, health: number, dt: number): void {
  for (const x of w.list) {
    const open = health < x.below;
    if (!open) { x.group.visible = false; x.pop = 0; continue; }
    x.group.visible = true;
    if (x.pop < 1) {
      x.pop = Math.min(1, x.pop + dt * 6);
      x.group.scale.setScalar(0.3 + 0.7 * x.pop);
    }
  }
}
