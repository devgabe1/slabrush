import * as THREE from 'three';
import { buildWounds, showWounds, type Wounds } from './wounds';
import type { WeaponId } from '../config/weapons';

// All models are built from primitives in code. Weapons point down -Z with
// the grip near the origin; `userData.muzzle` is the muzzle's Z coordinate.

const matCache = new Map<number, THREE.MeshLambertMaterial>();
export function flatMat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) matCache.set(color, (m = new THREE.MeshLambertMaterial({ color })));
  return m;
}

function part(
  parent: THREE.Object3D, w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

const STEEL = 0x2e3238, DARK = 0x1c1d20, WOOD = 0x7a4a26, ORANGE = 0xe8642a, YELLOW = 0xe8c63a, SKIN = 0xd8b89a;
const CHROME = 0xb8bcc4, GREEN = 0x4a5a3c, PURPLE = 0x6a3aa8, RED = 0xc8281e;

/** Cylinder lying along Z (barrels, tubes). */
function tube(
  parent: THREE.Object3D, r0: number, r1: number, len: number, color: number, x: number, y: number, z: number,
  sides = 8, glow = false,
): THREE.Mesh {
  // r0 = radius at the front (-Z) end, r1 = at the back
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, sides), glow ? glowMat(color) : flatMat(color));
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

const glowCache = new Map<number, THREE.MeshBasicMaterial>();
/** Unlit, always-bright material for glowing bits. */
function glowMat(color: number): THREE.MeshBasicMaterial {
  let m = glowCache.get(color);
  if (!m) glowCache.set(color, (m = new THREE.MeshBasicMaterial({ color })));
  return m;
}
function glow(parent: THREE.Object3D, w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glowMat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

export function buildWeaponModel(id: WeaponId): THREE.Group {
  const g = new THREE.Group();
  let muzzle = 0;
  switch (id) {
    case 'fists': {
      // Two blocky hands; the viewmodel animates them by name.
      const l = part(g, 0.09, 0.09, 0.2, SKIN, -0.2, 0, -0.05);
      const r = part(g, 0.09, 0.09, 0.2, SKIN, 0.2, 0, -0.05);
      l.name = 'handL';
      r.name = 'handR';
      break;
    }
    case 'kingpin': { // minigun: six barrels that spin, a boxy motor, an ammo box
      const barrels = new THREE.Group();
      barrels.name = 'spin';
      barrels.position.set(0, 0.04, -0.42);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        tube(barrels, 0.016, 0.016, 0.5, STEEL, Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0, 5);
      }
      tube(barrels, 0.07, 0.07, 0.03, DARK, 0, 0, -0.24, 8);
      tube(barrels, 0.07, 0.07, 0.03, DARK, 0, 0, 0.05, 8);
      g.add(barrels);
      part(g, 0.13, 0.14, 0.3, 0x3a3f4a, 0, 0.04, -0.03);
      part(g, 0.1, 0.12, 0.12, YELLOW, -0.12, -0.02, -0.03);
      part(g, 0.03, 0.05, 0.16, DARK, 0, 0.14, -0.03);
      part(g, 0.04, 0.12, 0.05, DARK, 0, -0.08, 0.08).rotation.x = 0.3;
      muzzle = -0.68;
      break;
    }
    case 'verdict': // railgun: two long rails with a glowing channel between them
      part(g, 0.02, 0.06, 0.85, 0x2a3140, -0.035, 0.05, -0.4);
      part(g, 0.02, 0.06, 0.85, 0x2a3140, 0.035, 0.05, -0.4);
      glow(g, 0.03, 0.02, 0.8, 0x4ad8ff, 0, 0.05, -0.4);
      for (let i = 0; i < 4; i++) part(g, 0.11, 0.09, 0.03, CHROME, 0, 0.05, -0.12 - i * 0.2);
      part(g, 0.09, 0.11, 0.3, 0x2a3140, 0, 0.03, 0.14);
      glow(g, 0.05, 0.05, 0.05, 0x4ad8ff, 0, 0.12, 0.14).name = 'blink';
      part(g, 0.04, 0.12, 0.05, DARK, 0, -0.07, 0.06).rotation.x = 0.3;
      muzzle = -0.84;
      break;
    case 'bigone': // one absurdly fat launch tube with hazard bands
      tube(g, 0.13, 0.13, 0.75, 0x8a1e1e, 0, 0.09, -0.22, 8);
      tube(g, 0.15, 0.135, 0.1, YELLOW, 0, 0.09, -0.6, 8);
      tube(g, 0.135, 0.135, 0.06, YELLOW, 0, 0.09, -0.3, 8);
      tube(g, 0.135, 0.135, 0.06, DARK, 0, 0.09, -0.1, 8);
      part(g, 0.04, 0.13, 0.05, DARK, 0, -0.08, -0.05).rotation.x = 0.25;
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.08, -0.36);
      muzzle = -0.66;
      break;
    case 'pinata': { // party launcher: bright bands on a stubby tube
      tube(g, 0.07, 0.07, 0.34, 0xe8e0d0, 0, 0.06, -0.28, 8);
      [0xff5ae8, 0xffd23a, 0x4ad8ff, 0x7dff5a].forEach((c, i) => tube(g, 0.075, 0.075, 0.04, c, 0, 0.06, -0.16 - i * 0.085, 8, true));
      tube(g, 0.1, 0.1, 0.15, PURPLE, 0, 0.03, -0.03, 6).name = 'spin';
      part(g, 0.05, 0.08, 0.24, DARK, 0, 0.02, 0.15);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.07, 0.06).rotation.x = 0.3;
      muzzle = -0.48;
      break;
    }
    case 'banhammer': // a hammer the size of a door
      tube(g, 0.024, 0.024, 0.62, WOOD, 0, 0.03, -0.22, 6);
      part(g, 0.2, 0.2, 0.3, 0xc8a02a, 0, 0.03, -0.6);
      part(g, 0.22, 0.22, 0.05, 0x8a6a1a, 0, 0.03, -0.46);
      part(g, 0.22, 0.22, 0.05, 0x8a6a1a, 0, 0.03, -0.74);
      glow(g, 0.12, 0.12, 0.01, RED, 0, 0.03, -0.752);
      tube(g, 0.03, 0.03, 0.03, DARK, 0, 0.03, 0.1, 6);
      muzzle = -0.76;
      break;
    case 'fish': { // a fish
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), flatMat(0x7aa0b8));
      body.scale.set(0.45, 0.9, 3);
      body.position.set(0, 0.03, -0.26);
      g.add(body);
      part(g, 0.012, 0.16, 0.1, 0x5a8098, 0, 0.03, 0.02).rotation.x = 0.4;
      part(g, 0.012, 0.07, 0.1, 0x5a8098, 0, 0.11, -0.24);
      glow(g, 0.085, 0.03, 0.03, 0xf4f0e0, 0, 0.05, -0.44);
      glow(g, 0.09, 0.015, 0.015, DARK, 0, 0.05, -0.445);
      muzzle = -0.5;
      break;
    }
    case 'potato': { // a potato with a lit fuse
      const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), flatMat(0x9a7448));
      lump.scale.set(1, 0.85, 1.3);
      lump.position.set(0, 0.03, -0.07);
      g.add(lump);
      part(g, 0.012, 0.07, 0.012, DARK, 0.02, 0.12, -0.07).rotation.z = 0.3;
      glow(g, 0.03, 0.03, 0.03, ORANGE, 0.03, 0.16, -0.07).name = 'blink';
      muzzle = -0.1;
      break;
    }
    case 'icebox': // freeze ray: a cooler box with a frosty nozzle
      part(g, 0.1, 0.11, 0.24, 0xd8ecf4, 0, 0.03, 0);
      part(g, 0.105, 0.02, 0.245, 0x3a8ac8, 0, 0.09, 0);
      tube(g, 0.03, 0.045, 0.22, 0x9ab4c8, 0, 0.04, -0.22, 6);
      glow(g, 0.05, 0.05, 0.04, 0xeafcff, 0, 0.04, -0.34);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.07, 0.06).rotation.x = 0.3;
      muzzle = -0.36;
      break;
    case 'reeler': { // harpoon gun with a reel on the side
      part(g, 0.055, 0.07, 0.36, 0x5a4a3a, 0, 0.03, -0.1);
      tube(g, 0.012, 0.012, 0.3, CHROME, 0, 0.04, -0.42, 5);
      const hook = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 4), flatMat(CHROME));
      hook.rotation.x = -Math.PI / 2;
      hook.position.set(0, 0.04, -0.62);
      g.add(hook);
      const reel = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.02, 4, 8), flatMat(0xc8a070));
      reel.rotation.y = Math.PI / 2;
      reel.position.set(0.05, 0.03, -0.06);
      g.add(reel);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.06, 0.04).rotation.x = 0.3;
      muzzle = -0.66;
      break;
    }
    case 'stapler': // an office stapler that takes itself seriously
      part(g, 0.06, 0.035, 0.4, RED, 0, 0.08, -0.16).rotation.x = -0.07;
      part(g, 0.065, 0.03, 0.42, DARK, 0, 0.01, -0.17);
      part(g, 0.05, 0.03, 0.34, CHROME, 0, 0.04, -0.2);
      part(g, 0.06, 0.07, 0.05, RED, 0, 0.045, 0.04);
      part(g, 0.04, 0.1, 0.05, DARK, 0, -0.06, 0.02).rotation.x = 0.3;
      muzzle = -0.38;
      break;
    case 'gambler': { // gold pistol with a die for a sight
      part(g, 0.05, 0.07, 0.26, 0xc8a02a, 0, 0.03, -0.09);
      part(g, 0.042, 0.12, 0.06, 0x6a1e1e, 0, -0.05, 0.01).rotation.x = 0.25;
      const die = part(g, 0.06, 0.06, 0.06, 0xf4f0e0, 0, 0.1, -0.04);
      die.rotation.set(0.3, 0.6, 0.2);
      die.name = 'spin';
      glow(g, 0.015, 0.015, 0.005, DARK, 0, 0.1, -0.072);
      muzzle = -0.24;
      break;
    }
    case 'toaster': // flamethrower built out of a toaster
      part(g, 0.13, 0.11, 0.2, CHROME, 0, 0.04, 0);
      part(g, 0.035, 0.012, 0.15, DARK, -0.03, 0.097, 0);
      part(g, 0.035, 0.012, 0.15, DARK, 0.03, 0.097, 0);
      tube(g, 0.035, 0.03, 0.26, STEEL, 0, 0.04, -0.22, 6);
      glow(g, 0.04, 0.04, 0.03, ORANGE, 0, 0.04, -0.36).name = 'blink';
      part(g, 0.02, 0.05, 0.02, DARK, 0.075, 0.02, 0.06);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.07, 0.04).rotation.x = 0.3;
      muzzle = -0.38;
      break;
    case 'snapper': { // bear trap: two toothed jaws on a plate
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 8), flatMat(DARK));
      plate.position.set(0, 0.01, -0.08);
      g.add(plate);
      for (const side of [-1, 1]) {
        const jaw = part(g, 0.2, 0.02, 0.02, CHROME, 0, 0.06, -0.08 + side * 0.07);
        jaw.rotation.x = side * 0.7;
        for (let t = -2; t <= 2; t++) part(g, 0.016, 0.05, 0.016, CHROME, t * 0.04, 0.09, -0.08 + side * 0.045).rotation.x = side * 0.4;
      }
      glow(g, 0.04, 0.012, 0.04, RED, 0, 0.025, -0.08).name = 'blink';
      muzzle = -0.1;
      break;
    }
    case 'popper': { // spring plate: striped pad on a coil
      part(g, 0.18, 0.02, 0.18, YELLOW, 0, 0.1, -0.08);
      part(g, 0.18, 0.022, 0.05, DARK, 0, 0.1, -0.08);
      for (let k = 0; k < 3; k++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.01, 4, 8), flatMat(CHROME));
        coil.rotation.x = Math.PI / 2;
        coil.position.set(0, 0.03 + k * 0.025, -0.08);
        g.add(coil);
      }
      part(g, 0.14, 0.015, 0.14, DARK, 0, 0.008, -0.08);
      muzzle = -0.1;
      break;
    }
    case 'sentry': { // little gun on a tripod
      const head = new THREE.Group();
      head.name = 'spin';
      head.position.set(0, 0.13, -0.08);
      part(head, 0.07, 0.06, 0.12, 0x3a3f4a);
      part(head, 0.02, 0.02, 0.12, DARK, 0, 0, -0.1);
      glow(head, 0.025, 0.025, 0.01, RED, 0, 0.02, -0.062);
      g.add(head);
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI * 2) / 3;
        const leg = part(g, 0.012, 0.13, 0.012, CHROME, Math.cos(a) * 0.045, 0.05, -0.08 + Math.sin(a) * 0.045);
        leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      }
      muzzle = -0.1;
      break;
    }
    case 'stinker': { // gas canister with a valve and a warning band
      const can = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8), flatMat(0x4f7a2a));
      can.position.set(0, 0.07, -0.08);
      g.add(can);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.035, 8), flatMat(YELLOW));
      band.position.set(0, 0.08, -0.08);
      g.add(band);
      part(g, 0.03, 0.03, 0.03, CHROME, 0, 0.165, -0.08);
      part(g, 0.07, 0.01, 0.012, RED, 0, 0.185, -0.08);
      muzzle = -0.1;
      break;
    }
    case 'rivet':
      part(g, 0.045, 0.065, 0.24, STEEL, 0, 0.03, -0.08);
      part(g, 0.04, 0.12, 0.06, DARK, 0, -0.05, 0.01).rotation.x = 0.25;
      part(g, 0.05, 0.02, 0.1, ORANGE, 0, 0.07, -0.03);
      part(g, 0.02, 0.02, 0.03, DARK, 0, 0.075, -0.19);
      muzzle = -0.22;
      break;
    case 'pepper': // stubby burst pistol with a long magazine and a three-slot brake
      part(g, 0.05, 0.07, 0.2, 0x3a3f4a, 0, 0.03, -0.06);
      part(g, 0.06, 0.05, 0.06, DARK, 0, 0.03, -0.19);
      for (let i = 0; i < 3; i++) part(g, 0.065, 0.012, 0.012, YELLOW, 0, 0.03, -0.172 - i * 0.018);
      part(g, 0.04, 0.11, 0.055, DARK, 0, -0.05, 0.02).rotation.x = 0.25;
      part(g, 0.034, 0.2, 0.04, YELLOW, 0, -0.1, -0.05);
      muzzle = -0.24;
      break;
    case 'magnate': // revolver: long barrel, fat cylinder, wooden grip
      tube(g, 0.02, 0.02, 0.26, CHROME, 0, 0.055, -0.2, 6);
      part(g, 0.03, 0.02, 0.24, CHROME, 0, 0.03, -0.19);
      tube(g, 0.045, 0.045, 0.085, CHROME, 0, 0.04, -0.03, 6);
      part(g, 0.04, 0.085, 0.07, STEEL, 0, 0.03, 0.04);
      part(g, 0.042, 0.13, 0.055, WOOD, 0, -0.06, 0.07).rotation.x = 0.45;
      part(g, 0.012, 0.03, 0.02, STEEL, 0, 0.09, 0.07);
      muzzle = -0.34;
      break;
    case 'chatter':
      part(g, 0.06, 0.09, 0.36, STEEL, 0, 0.03, -0.12);
      part(g, 0.03, 0.03, 0.14, DARK, 0, 0.04, -0.36);
      part(g, 0.04, 0.2, 0.06, YELLOW, 0, -0.1, -0.16).rotation.x = -0.15;
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.06, 0.02).rotation.x = 0.3;
      part(g, 0.03, 0.03, 0.16, DARK, 0, 0.05, 0.13);
      muzzle = -0.44;
      break;
    case 'hornet': { // tiny machine pistol with a drum, wasp stripes
      part(g, 0.055, 0.075, 0.24, YELLOW, 0, 0.03, -0.08);
      for (let i = 0; i < 3; i++) part(g, 0.058, 0.078, 0.025, DARK, 0, 0.03, -0.16 + i * 0.07);
      tube(g, 0.016, 0.016, 0.08, DARK, 0, 0.035, -0.24, 6);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 8), flatMat(DARK));
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -0.05, -0.1);
      g.add(drum);
      part(g, 0.04, 0.1, 0.045, DARK, 0, -0.05, 0.02).rotation.x = 0.3;
      muzzle = -0.28;
      break;
    }
    case 'ledger': // rifle: long body, wooden stock, curved magazine, raised sight
      part(g, 0.055, 0.08, 0.46, STEEL, 0, 0.03, -0.18);
      tube(g, 0.016, 0.016, 0.3, DARK, 0, 0.04, -0.55, 6);
      part(g, 0.05, 0.1, 0.3, WOOD, 0, 0, 0.19).rotation.x = -0.12;
      part(g, 0.06, 0.05, 0.2, WOOD, 0, 0, -0.34);
      part(g, 0.04, 0.17, 0.06, DARK, 0, -0.09, -0.12).rotation.x = -0.3;
      part(g, 0.04, 0.1, 0.05, DARK, 0, -0.06, 0.02).rotation.x = 0.3;
      part(g, 0.015, 0.04, 0.12, ORANGE, 0, 0.09, -0.16);
      muzzle = -0.7;
      break;
    case 'slab':
      part(g, 0.07, 0.07, 0.62, STEEL, 0, 0.04, -0.3);
      part(g, 0.09, 0.07, 0.2, WOOD, 0, -0.01, -0.36);
      part(g, 0.06, 0.1, 0.26, WOOD, 0, -0.02, 0.12).rotation.x = -0.2;
      part(g, 0.04, 0.1, 0.05, DARK, 0, -0.06, -0.02).rotation.x = 0.3;
      muzzle = -0.62;
      break;
    case 'twins': // double barrel: two fat tubes side by side
      tube(g, 0.032, 0.032, 0.5, STEEL, -0.034, 0.045, -0.3, 8);
      tube(g, 0.032, 0.032, 0.5, STEEL, 0.034, 0.045, -0.3, 8);
      part(g, 0.14, 0.02, 0.03, CHROME, 0, 0.045, -0.5);
      part(g, 0.12, 0.06, 0.2, WOOD, 0, 0, -0.26);
      part(g, 0.13, 0.08, 0.1, STEEL, 0, 0.03, -0.03);
      part(g, 0.07, 0.1, 0.24, WOOD, 0, -0.03, 0.14).rotation.x = -0.25;
      muzzle = -0.56;
      break;
    case 'needle': // sniper: absurdly long thin barrel and a fat scope
      part(g, 0.05, 0.07, 0.4, 0x2a3a2e, 0, 0.03, -0.1);
      tube(g, 0.013, 0.013, 0.75, DARK, 0, 0.04, -0.66, 6);
      tube(g, 0.026, 0.026, 0.08, DARK, 0, 0.04, -1.0, 6);
      tube(g, 0.032, 0.026, 0.3, DARK, 0, 0.115, -0.12, 8);
      glow(g, 0.04, 0.04, 0.005, 0x6ae8ff, 0, 0.115, -0.272);
      part(g, 0.02, 0.04, 0.03, DARK, 0, 0.08, -0.04);
      part(g, 0.02, 0.04, 0.03, DARK, 0, 0.08, -0.2);
      part(g, 0.05, 0.09, 0.28, 0x2a3a2e, 0, -0.01, 0.2).rotation.x = -0.1;
      part(g, 0.035, 0.1, 0.05, DARK, 0, -0.06, 0.03).rotation.x = 0.3;
      muzzle = -1.05;
      break;
    case 'bouncer': { // ricochet rifle: hexagonal barrel, rubber-ball colours
      tube(g, 0.035, 0.035, 0.5, PURPLE, 0, 0.04, -0.3, 6);
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), glowMat(0xff5ae8));
      ball.position.set(0, 0.04, -0.58);
      g.add(ball);
      part(g, 0.06, 0.09, 0.22, DARK, 0, 0.03, 0);
      for (let i = 0; i < 3; i++) glow(g, 0.075, 0.015, 0.02, 0xff5ae8, 0, 0.04, -0.14 - i * 0.12);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.06, 0.03).rotation.x = 0.3;
      part(g, 0.045, 0.07, 0.2, PURPLE, 0, 0.01, 0.2);
      muzzle = -0.62;
      break;
    }
    case 'postman': {
      tube(g, 0.075, 0.075, 0.85, GREEN, 0, 0.07, -0.2, 8);
      tube(g, 0.1, 0.085, 0.12, DARK, 0, 0.07, -0.66, 8);
      part(g, 0.04, 0.12, 0.05, DARK, 0, -0.04, -0.05).rotation.x = 0.25;
      part(g, 0.04, 0.1, 0.05, DARK, 0, -0.04, -0.32);
      part(g, 0.03, 0.07, 0.1, YELLOW, 0, 0.17, -0.2);
      muzzle = -0.74;
      break;
    }
    case 'lobber': { // grenade launcher: short fat tube and a big revolving drum
      tube(g, 0.065, 0.065, 0.3, STEEL, 0, 0.06, -0.3, 8);
      tube(g, 0.075, 0.065, 0.04, ORANGE, 0, 0.06, -0.46, 8);
      const drum = tube(g, 0.1, 0.1, 0.16, 0x4a4e56, 0, 0.03, -0.07, 6);
      drum.name = 'spin';
      part(g, 0.05, 0.08, 0.26, DARK, 0, 0.02, 0.14);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.07, 0.06).rotation.x = 0.3;
      part(g, 0.04, 0.1, 0.05, WOOD, 0, -0.05, -0.28);
      muzzle = -0.5;
      break;
    }
    case 'pineapple': { // hand grenade: knobbly green lump with a lever and pin
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 0), flatMat(GREEN));
      body.scale.set(1, 1.25, 1);
      body.position.set(0, 0.03, -0.06);
      g.add(body);
      part(g, 0.045, 0.035, 0.045, CHROME, 0, 0.135, -0.06);
      part(g, 0.02, 0.1, 0.012, CHROME, 0.04, 0.08, -0.06).rotation.z = -0.25;
      glow(g, 0.03, 0.03, 0.03, YELLOW, -0.045, 0.14, -0.06);
      muzzle = -0.1;
      break;
    }
    case 'clinger': { // proximity mine: spiked disc with a red eye
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.11, 0.05, 8), flatMat(0x3a3d42));
      disc.position.set(0, 0.03, -0.08);
      g.add(disc);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + 0.4;
        part(g, 0.02, 0.02, 0.07, CHROME, Math.cos(a) * 0.1, 0.03, -0.08 + Math.sin(a) * 0.1).rotation.y = -a + Math.PI / 2;
      }
      glow(g, 0.045, 0.02, 0.045, RED, 0, 0.065, -0.08).name = 'blink';
      muzzle = -0.1;
      break;
    }
    case 'shiv': // knife: bright blade, dark handle, small guard
      part(g, 0.008, 0.04, 0.24, CHROME, 0, 0.03, -0.2);
      part(g, 0.008, 0.02, 0.06, CHROME, 0, 0.02, -0.34).rotation.x = 0.4;
      part(g, 0.05, 0.02, 0.015, STEEL, 0, 0.03, -0.075);
      part(g, 0.028, 0.035, 0.12, DARK, 0, 0.03, -0.01);
      part(g, 0.03, 0.012, 0.12, RED, 0, 0.05, -0.01);
      muzzle = -0.3;
      break;
    case 'slugger': { // bat: tapered wood, taped grip, a few nails for character
      tube(g, 0.05, 0.022, 0.62, WOOD, 0, 0.03, -0.36, 7);
      tube(g, 0.024, 0.024, 0.16, DARK, 0, 0.03, 0.02, 7);
      tube(g, 0.032, 0.032, 0.02, DARK, 0, 0.03, 0.105, 7);
      part(g, 0.14, 0.012, 0.012, CHROME, 0, 0.03, -0.56);
      part(g, 0.012, 0.14, 0.012, CHROME, 0, 0.03, -0.5);
      muzzle = -0.6;
      break;
    }
    case 'zapper': { // arc gun: two prongs and glowing coils
      part(g, 0.07, 0.09, 0.22, 0x38465a, 0, 0.03, -0.02);
      part(g, 0.015, 0.02, 0.34, CHROME, -0.04, 0.05, -0.28).rotation.y = -0.07;
      part(g, 0.015, 0.02, 0.34, CHROME, 0.04, 0.05, -0.28).rotation.y = 0.07;
      for (let i = 0; i < 3; i++) tube(g, 0.036, 0.036, 0.025, 0x6ae8ff, 0, 0.05, -0.16 - i * 0.07, 6, true);
      const spark = glow(g, 0.03, 0.03, 0.03, 0xffffff, 0, 0.05, -0.46);
      spark.name = 'blink';
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.06, 0.04).rotation.x = 0.3;
      part(g, 0.05, 0.05, 0.1, YELLOW, 0, 0.1, 0.02);
      muzzle = -0.46;
      break;
    }
    case 'gust': { // air cannon: wide funnel, air tank on the back
      tube(g, 0.14, 0.05, 0.3, 0xc8ccd4, 0, 0.06, -0.34, 8);
      tube(g, 0.05, 0.05, 0.16, STEEL, 0, 0.06, -0.12, 8);
      tube(g, 0.075, 0.075, 0.26, 0x3a8ac8, 0, 0.09, 0.12, 8);
      part(g, 0.02, 0.06, 0.02, CHROME, 0, 0.18, 0.12);
      part(g, 0.04, 0.12, 0.05, DARK, 0, -0.04, -0.04).rotation.x = 0.25;
      muzzle = -0.5;
      break;
    }
    case 'monologue': { // the legendary beam: a chunky gauntlet with a glowing emitter on the knuckles
      part(g, 0.13, 0.12, 0.3, 0x1c1e2a, 0, 0.03, 0.04); // the sleeve
      part(g, 0.14, 0.03, 0.31, 0xd8b64a, 0, 0.1, 0.04); // gold trim
      part(g, 0.12, 0.1, 0.1, 0x2c3048, 0, 0.03, -0.15); // the fist
      for (let i = 0; i < 3; i++) tube(g, 0.075, 0.075, 0.022, 0x7af0ff, 0, 0.03, -0.02 + i * 0.07, 8, true); // coils
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.016, 4, 12), flatMat(0xd8b64a));
      ring.position.set(0, 0.03, -0.22);
      ring.name = 'spin';
      g.add(ring);
      glow(g, 0.05, 0.05, 0.04, 0xeaffff, 0, 0.03, -0.23); // the emitter
      const spark = glow(g, 0.02, 0.02, 0.02, 0x7af0ff, 0, 0.12, 0.14);
      spark.name = 'blink';
      muzzle = -0.25;
      break;
    }
    case 'swapper': { // swap gun: a ring between two differently coloured orbs
      part(g, 0.055, 0.08, 0.26, 0x2a2c34, 0, 0.03, -0.02);
      tube(g, 0.02, 0.02, 0.2, CHROME, 0, 0.04, -0.24, 6);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 4, 10), flatMat(CHROME));
      ring.position.set(0, 0.04, -0.4);
      ring.name = 'spin';
      g.add(ring);
      glow(g, 0.04, 0.04, 0.04, 0x7dff5a, -0.075, 0.04, -0.4);
      glow(g, 0.04, 0.04, 0.04, 0xff5ae8, 0.075, 0.04, -0.4);
      part(g, 0.04, 0.11, 0.05, DARK, 0, -0.06, 0.04).rotation.x = 0.3;
      muzzle = -0.44;
      break;
    }
  }
  g.userData.muzzle = muzzle;
  return g;
}

/** What a fired projectile looks like in flight. */
export function buildProjectileModel(id: WeaponId): THREE.Object3D {
  const g = new THREE.Group();
  if (id === 'lobber') {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), flatMat(0x2a2c30));
    g.add(m);
    glow(g, 0.24, 0.05, 0.05, ORANGE);
  } else if (id === 'pineapple') {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), flatMat(GREEN));
    m.scale.y = 1.25;
    g.add(m);
    part(g, 0.05, 0.05, 0.05, CHROME, 0, 0.14, 0);
  } else if (id === 'clinger') {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.07, 8), flatMat(0x3a3d42));
    g.add(disc);
    glow(g, 0.07, 0.04, 0.07, RED, 0, 0.05, 0).name = 'blink';
  } else if (id === 'snapper' || id === 'popper' || id === 'sentry' || id === 'stinker') {
    // a placed trap is its hand model, larger, standing on the ground
    const m = buildWeaponModel(id);
    m.scale.setScalar(2.4);
    m.position.set(0, -0.02, 0.19);
    g.add(m);
  } else if (id === 'bigone') {
    part(g, 0.3, 0.3, 0.8, 0x8a1e1e);
    part(g, 0.32, 0.32, 0.12, YELLOW, 0, 0, 0.2);
    glow(g, 0.2, 0.2, 0.2, 0xffd070, 0, 0, -0.5);
  } else if (id === 'pinata') {
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), glowMat(0xff5ae8)));
    glow(g, 0.24, 0.05, 0.05, 0xffd23a);
    glow(g, 0.05, 0.24, 0.05, 0x4ad8ff);
  } else if (id === 'potato') {
    const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), flatMat(0x9a7448));
    lump.scale.set(1, 0.85, 1.3);
    g.add(lump);
    glow(g, 0.06, 0.06, 0.06, ORANGE, 0.04, 0.14, 0).name = 'blink';
  } else if (id === 'stapler') {
    part(g, 0.03, 0.03, 0.4, CHROME);
  } else {
    glow(g, 0.12, 0.12, 0.45, 0xffd070);
  }
  return g;
}

// ------------------------------------------------------------- characters
// A blocky cyclops: huge cube head, one eye, stubby limbs.
export interface CharacterView {
  root: THREE.Group; // at the player's feet, rotated by yaw
  body: THREE.Group; // squashes when crouching, leans when sliding
  head: THREE.Group;
  mouth: MouthRig; // the head flips open when this player talks
  wounds: Wounds; // wear and tear, opened as health falls
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  hand: THREE.Group; // weapon attachment (right)
  hand2: THREE.Group; // left hand, used when dual wielding
  weapon2: WeaponId | null;
  shadow: THREE.Mesh; // blob on the ground under the feet
  label: THREE.Sprite; // name tag floating above the head
  name: string; // what the label currently says
  parts: THREE.Mesh[]; // everything that flies apart on death
  look: string; // which face/torso/legs this was built with
  phase: number;
  weapon: WeaponId | null;
}

/** A limb whose pivot is at its top end. */
function limb(parent: THREE.Object3D, w: number, h: number, d: number, color: number, x: number, y: number): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const m = new THREE.Mesh(geo, flatMat(color));
  m.position.set(x, y, 0);
  parent.add(m);
  return m;
}

/** Draw a player's name onto a name tag (a camera-facing sprite). */
export function setLabel(v: CharacterView, name: string, color: number): void {
  if (name === v.name) return;
  v.name = name;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 46px Impact, "Arial Narrow Bold", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = name.toUpperCase();
  const w = Math.min(248, ctx.measureText(text).width + 22);
  ctx.fillStyle = 'rgba(12, 11, 9, 0.85)';
  ctx.fillRect(128 - w / 2, 2, w, 60);
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.fillRect(128 - w / 2, 54, w, 8);
  ctx.fillStyle = '#fff6e0';
  ctx.fillText(text, 128, 29, 236);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; // crisp at the low internal resolution
  const mat = v.label.material;
  mat.map?.dispose();
  mat.map = tex;
  mat.needsUpdate = true;
  v.label.visible = text.length > 0;
}

// --------------------------------------------------------- character looks
// Three lists of interchangeable parts, in the same order as the names in
// config/looks.ts. Each builder adds meshes to the group it is given.
// Front is -Z. `c` = the player's colour, `light`/`dark` = tints of it, so
// whatever the outfit, you can still tell who is who.

/** Upright cylinder / cone / prism. */
function cyl(
  parent: THREE.Object3D, rTop: number, rBot: number, h: number, color: number, x: number, y: number, z: number,
  sides = 8, lit = false,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, sides), lit ? glowMat(color) : flatMat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function ball(parent: THREE.Object3D, r: number, color: number, x: number, y: number, z: number, detail = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), flatMat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

const BONE = 0xe8e0d0, EYE = 0xf4f0e0, INK = 0x111111;
type PartFn = (g: THREE.Object3D, c: number, light: number, dark: number) => void;

/** Heads. Built in a group whose origin is the neck; a head is about 0.46 tall. */
const FACE_BUILDERS: PartFn[] = [
  (g, _c, light) => { // CYCLOPS: one big eye, an antenna
    part(g, 0.48, 0.46, 0.48, light, 0, 0.23, 0);
    part(g, 0.3, 0.2, 0.04, EYE, 0, 0.26, -0.245);
    part(g, 0.1, 0.11, 0.03, INK, 0, 0.26, -0.265);
    part(g, 0.03, 0.2, 0.03, DARK, 0.12, 0.56, 0.1);
    part(g, 0.08, 0.08, 0.08, YELLOW, 0.12, 0.68, 0.1);
  },
  (g, _c, light) => { // GOOGLY: two eyes that do not agree with each other
    part(g, 0.48, 0.46, 0.48, light, 0, 0.23, 0);
    part(g, 0.2, 0.22, 0.04, EYE, -0.11, 0.29, -0.245);
    part(g, 0.13, 0.13, 0.04, EYE, 0.13, 0.24, -0.245);
    part(g, 0.08, 0.08, 0.03, INK, -0.07, 0.25, -0.265);
    part(g, 0.06, 0.06, 0.03, INK, 0.15, 0.27, -0.265);
    part(g, 0.2, 0.03, 0.03, INK, 0.02, 0.09, -0.25).rotation.z = 0.15;
  },
  (g, c, _l, dark) => { // VISOR: a helmet with one glowing strip
    part(g, 0.48, 0.46, 0.48, dark, 0, 0.23, 0);
    glow(g, 0.44, 0.1, 0.03, c, 0, 0.28, -0.245);
    part(g, 0.3, 0.1, 0.06, DARK, 0, 0.08, -0.24);
    part(g, 0.5, 0.05, 0.5, DARK, 0, 0.44, 0);
  },
  (g, c) => { // TV HEAD: screen, rabbit ears, one knob
    part(g, 0.58, 0.42, 0.4, 0x3a3028, 0, 0.22, 0);
    glow(g, 0.42, 0.3, 0.02, 0x9ad2c8, -0.04, 0.22, -0.205);
    glow(g, 0.42, 0.04, 0.025, c, -0.04, 0.2, -0.21);
    part(g, 0.05, 0.05, 0.03, YELLOW, 0.23, 0.3, -0.21);
    part(g, 0.05, 0.05, 0.03, DARK, 0.23, 0.16, -0.21);
    part(g, 0.02, 0.3, 0.02, CHROME, -0.1, 0.56, 0).rotation.z = 0.5;
    part(g, 0.02, 0.3, 0.02, CHROME, 0.1, 0.56, 0).rotation.z = -0.5;
  },
  (g) => { // PUMPKIN: carved, lit from inside
    ball(g, 0.29, 0xe07a1a, 0, 0.25, 0, 1).scale.set(1, 0.85, 1);
    part(g, 0.05, 0.1, 0.05, 0x4f7a2a, 0, 0.53, 0);
    for (const s of [-1, 1]) glow(g, 0.1, 0.1, 0.03, 0xffe14a, s * 0.11, 0.31, -0.262).rotation.z = Math.PI / 4;
    glow(g, 0.26, 0.05, 0.03, 0xffe14a, 0, 0.14, -0.26);
    for (const s of [-1, 0, 1]) part(g, 0.04, 0.05, 0.035, 0xe07a1a, s * 0.08, 0.14, -0.262);
  },
  (g) => { // SKULL
    part(g, 0.44, 0.34, 0.44, BONE, 0, 0.29, 0);
    part(g, 0.3, 0.14, 0.3, BONE, 0, 0.07, -0.04);
    for (const s of [-1, 1]) part(g, 0.12, 0.12, 0.04, INK, s * 0.1, 0.3, -0.21);
    part(g, 0.05, 0.07, 0.04, INK, 0, 0.18, -0.21);
    for (let k = -2; k <= 2; k++) part(g, 0.015, 0.1, 0.02, INK, k * 0.055, 0.07, -0.195);
  },
  (g) => { // TRAFFIC CONE: it has seen things
    part(g, 0.5, 0.04, 0.5, 0xe8642a, 0, 0.02, 0);
    cyl(g, 0.03, 0.24, 0.6, 0xe8642a, 0, 0.33, 0, 8);
    cyl(g, 0.115, 0.165, 0.1, EYE, 0, 0.33, 0, 8);
    for (const s of [-1, 1]) part(g, 0.05, 0.05, 0.04, INK, s * 0.07, 0.19, -0.2);
  },
  (g, c) => { // BUCKET: a pail with a slit to see through
    cyl(g, 0.28, 0.22, 0.44, CHROME, 0, 0.22, 0, 8);
    part(g, 0.34, 0.06, 0.04, INK, 0, 0.27, -0.24);
    cyl(g, 0.29, 0.29, 0.03, 0x8a9098, 0, 0.44, 0, 8);
    part(g, 0.6, 0.02, 0.02, 0x8a9098, 0, 0.3, 0);
    cyl(g, 0.23, 0.23, 0.04, c, 0, 0.04, 0, 8);
  },
  (g, c) => { // TOASTER: breakfast is permanently ready
    part(g, 0.52, 0.36, 0.34, CHROME, 0, 0.18, 0);
    for (const s of [-1, 1]) {
      part(g, 0.36, 0.02, 0.07, INK, 0, 0.362, s * 0.08);
      part(g, 0.3, 0.16, 0.04, 0xc8a070, 0, 0.42, s * 0.08);
    }
    for (const s of [-1, 1]) part(g, 0.06, 0.06, 0.03, INK, s * 0.12, 0.22, -0.175);
    part(g, 0.04, 0.1, 0.04, c, 0.28, 0.22, 0);
  },
  (g) => { // FROG: eyes on top, mouth from ear to ear
    part(g, 0.58, 0.3, 0.46, 0x5aa83a, 0, 0.15, 0);
    for (const s of [-1, 1]) {
      part(g, 0.18, 0.18, 0.18, 0x5aa83a, s * 0.17, 0.36, -0.08);
      part(g, 0.12, 0.12, 0.03, EYE, s * 0.17, 0.37, -0.18);
      part(g, 0.05, 0.08, 0.03, INK, s * 0.17, 0.37, -0.195);
    }
    part(g, 0.5, 0.025, 0.03, INK, 0, 0.11, -0.232);
    part(g, 0.46, 0.1, 0.03, 0xc8e08a, 0, 0.04, -0.231);
  },
  (g) => { // ALIEN: tall, three eyes, no opinion of you
    cyl(g, 0.28, 0.17, 0.62, 0x8ad2a0, 0, 0.31, 0, 6);
    for (const [x, y] of [[-0.11, 0.38], [0.11, 0.38], [0, 0.5]]) {
      part(g, 0.1, 0.13, 0.05, INK, x, y, -0.21).rotation.z = x * 3;
    }
    part(g, 0.06, 0.02, 0.03, INK, 0, 0.16, -0.17);
  },
  (g) => { // SMILEY
    ball(g, 0.28, 0xf4d23a, 0, 0.27, 0, 1);
    for (const s of [-1, 1]) part(g, 0.05, 0.1, 0.03, INK, s * 0.09, 0.35, -0.26);
    part(g, 0.16, 0.03, 0.03, INK, 0, 0.16, -0.265);
    for (const s of [-1, 1]) part(g, 0.06, 0.03, 0.03, INK, s * 0.1, 0.185, -0.255).rotation.z = -s * 0.7;
  },
  (g, c) => { // BLOCKHEAD: a voxel-game head, all square pixels
    part(g, 0.5, 0.5, 0.5, SKIN, 0, 0.25, 0);
    part(g, 0.52, 0.12, 0.52, c, 0, 0.47, 0); // hair cap in the player's colour
    for (const [x, z, h] of [[-0.16, -0.1, 0.1], [0.04, 0.06, 0.14], [0.17, -0.14, 0.08], [-0.06, 0.18, 0.12]]) {
      part(g, 0.12, h, 0.12, c, x, 0.53 + h / 2, z); // blocky tufts sticking up
    }
    part(g, 0.52, 0.08, 0.06, c, 0, 0.39, -0.24); // fringe
    for (const s of [-1, 1]) {
      part(g, 0.1, 0.1, 0.02, INK, s * 0.12, 0.28, -0.255); // square eyes
      part(g, 0.04, 0.04, 0.02, EYE, s * 0.12 - 0.025, 0.305, -0.262); // with a glint
      part(g, 0.08, 0.05, 0.02, 0xe08a7a, s * 0.17, 0.17, -0.254); // rosy pixel cheeks
    }
    part(g, 0.14, 0.04, 0.02, 0x8a4a3a, 0, 0.12, -0.255);
  },
  (g, c) => { // SCRAPBOT: a dented robot, mostly eyes
    const shell = cyl(g, 0.27, 0.25, 0.44, 0x8a9098, 0, 0.24, 0, 8);
    shell.rotation.z = 0.06; // a little crooked
    part(g, 0.4, 0.28, 0.04, DARK, 0, 0.25, -0.24); // face screen
    glow(g, 0.15, 0.15, 0.02, EYE, -0.09, 0.27, -0.265);
    glow(g, 0.11, 0.11, 0.02, EYE, 0.11, 0.25, -0.265); // one eye smaller than the other
    part(g, 0.07, 0.07, 0.02, INK, -0.08, 0.26, -0.28);
    part(g, 0.05, 0.05, 0.02, INK, 0.12, 0.24, -0.28);
    part(g, 0.02, 0.18, 0.02, CHROME, 0.1, 0.55, 0).rotation.z = -0.3;
    glow(g, 0.06, 0.06, 0.06, c, 0.13, 0.65, 0).name = 'blink';
    for (const [x, y] of [[-0.2, 0.42], [0.2, 0.1]]) part(g, 0.04, 0.04, 0.04, STEEL, x, y, -0.2); // bolts
    part(g, 0.1, 0.03, 0.03, 0x6a7078, -0.14, 0.4, -0.235).rotation.z = 0.4; // a dent
  },
  (g, c, light) => { // CAT HOOD: a cartoon animal hood with ears
    part(g, 0.52, 0.5, 0.5, c, 0, 0.25, 0.01);
    part(g, 0.34, 0.3, 0.04, SKIN, 0, 0.23, -0.24); // the face peeking out
    for (const s of [-1, 1]) {
      const ear = cyl(g, 0, 0.1, 0.18, c, s * 0.17, 0.57, 0, 4);
      ear.rotation.y = Math.PI / 4;
      cyl(g, 0, 0.055, 0.1, light, s * 0.17, 0.55, -0.05, 4).rotation.y = Math.PI / 4;
      part(g, 0.05, 0.07, 0.02, INK, s * 0.08, 0.28, -0.265);
      part(g, 0.08, 0.06, 0.02, 0xe8a0a0, s * 0.12, 0.18, -0.262);
    }
    part(g, 0.04, 0.03, 0.02, 0xc86a6a, 0, 0.21, -0.265); // nose
    for (const s of [-1, 1]) part(g, 0.05, 0.02, 0.02, INK, s * 0.025, 0.17, -0.265).rotation.z = s * 0.5; // :3
  },
  (g, c) => { // ASTRONAUT: helmet with a gold visor
    ball(g, 0.3, 0xeeeeea, 0, 0.27, 0, 1);
    const visor = ball(g, 0.22, 0xd8a23a, 0, 0.28, -0.11, 1);
    visor.scale.set(1.05, 0.8, 0.7);
    glow(g, 0.1, 0.03, 0.02, 0xfff2c0, -0.08, 0.36, -0.27).rotation.z = 0.4; // shine
    for (const s of [-1, 1]) cyl(g, 0.05, 0.05, 0.06, DARK, s * 0.29, 0.28, 0, 8).rotation.z = Math.PI / 2;
    glow(g, 0.04, 0.04, 0.04, c, 0.31, 0.28, -0.04).name = 'blink'; // suit light
    cyl(g, 0.22, 0.24, 0.06, 0xb8b8b4, 0, 0.0, 0, 10); // neck ring
  },
  (g, c) => { // DISCO BALL
    const b = ball(g, 0.28, CHROME, 0, 0.27, 0, 1);
    b.name = 'spin';
    const tiles = [0xffffff, c, 0x9ae8ff, 0xff8ad8];
    for (let k = 0; k < 14; k++) {
      const a = k * 2.4, y = 0.27 + Math.sin(k * 1.7) * 0.2, r = Math.sqrt(Math.max(0, 0.28 * 0.28 - (y - 0.27) ** 2)) + 0.01;
      glow(b, 0.06, 0.06, 0.02, tiles[k % tiles.length], Math.sin(a) * r, y - 0.27, Math.cos(a) * r).lookAt(0, 0, 0);
    }
    part(g, 0.03, 0.12, 0.03, CHROME, 0, 0.6, 0); // the hook it hung from
  },
  (g) => { // MOAI: a long stone face that has seen a few centuries
    const STONE = 0x7a756c, SHADE = 0x5a564f;
    part(g, 0.44, 0.66, 0.46, STONE, 0, 0.33, 0.02);
    part(g, 0.48, 0.1, 0.18, SHADE, 0, 0.5, -0.16); // heavy brow
    part(g, 0.12, 0.3, 0.14, STONE, 0, 0.32, -0.25); // long nose
    part(g, 0.2, 0.06, 0.06, SHADE, 0, 0.17, -0.235); // tight lips
    part(g, 0.36, 0.1, 0.1, STONE, 0, 0.05, -0.2); // jutting chin
    for (const s of [-1, 1]) {
      part(g, 0.12, 0.05, 0.03, INK, s * 0.12, 0.42, -0.245); // deep-set eyes
      part(g, 0.06, 0.34, 0.12, SHADE, s * 0.245, 0.34, 0); // long ears
    }
  },
  // ---------------------------------------------------------------- STEVE (Minecraft)
  (g, c) => {
    // caixa cúbica, pele pálida, cabelo castanho escuro, olhos de pixel
    const SKIN_MC = 0xc89a76, HAIR_MC = 0x3a2416, SHIRT_MC = 0x3a9ec4;
    part(g, 0.5, 0.5, 0.5, SKIN_MC, 0, 0.25, 0);
    part(g, 0.52, 0.14, 0.52, HAIR_MC, 0, 0.47, 0);          // hair cap
    part(g, 0.52, 0.06, 0.06, HAIR_MC, 0, 0.39, -0.24);       // fringe
    part(g, 0.5, 0.08, 0.06, HAIR_MC, 0, 0.30, -0.235);       // sideburns
    for (const s of [-1, 1]) {
      part(g, 0.1, 0.1, 0.02, 0xf4f0e0, s * 0.12, 0.28, -0.255); // eye white
      part(g, 0.05, 0.05, 0.02, 0x3a2a1a, s * 0.10, 0.28, -0.265); // pupil
    }
    part(g, 0.16, 0.03, 0.02, 0x8a4a3a, 0, 0.15, -0.255);    // mouth
    part(g, 0.54, 0.02, 0.54, SHIRT_MC, 0, 0.02, 0);          // collar hint
  },
  // ---------------------------------------------------------------- CREEPER
  // ---------------------------------------------------------------- CREEPER
  (g) => {
    const SKIN_C = 0x5aa83a, DARK_C = 0x3a7a22, INK_C = 0x080808;
    // Base quadrada, sem relevo
    part(g, 0.5, 0.5, 0.5, SKIN_C, 0, 0.25, 0);
    
    // Textura de "folhas" (quadrados escuros aleatórios) nas laterais e topo
    const spots = [
      [-0.15, 0.4, 0.15], [0.1, 0.45, -0.1], [0.18, 0.1, 0.12], [-0.18, 0.15, -0.18],
      [-0.05, 0.05, 0.2], [0.12, 0.35, 0.18], [-0.2, 0.3, -0.05], [0.05, 0.12, -0.22]
    ];
    for (const [x, y, z] of spots) {
      // Aplica a mancha nas 4 faces do cubo
      part(g, 0.08, 0.08, 0.02, DARK_C, x, y, 0.255);
      part(g, 0.08, 0.08, 0.02, DARK_C, x, y, -0.255);
      part(g, 0.02, 0.08, 0.08, DARK_C, 0.255, y, z);
      part(g, 0.02, 0.08, 0.08, DARK_C, -0.255, y, z);
    }
    // Topo
    part(g, 0.15, 0.02, 0.15, DARK_C, -0.1, 0.51, -0.1);
    part(g, 0.12, 0.02, 0.12, DARK_C, 0.15, 0.51, 0.05);

    // ROSTO (A face fica na frente, z = -0.26)
    // Olhos quadrados
    for (const s of [-1, 1]) {
      part(g, 0.1, 0.1, 0.02, INK_C, s * 0.12, 0.30, -0.255);
    }
    // Boca em T invertido
    part(g, 0.1, 0.14, 0.02, INK_C, 0, 0.16, -0.255); // Centro para baixo
    for (const s of [-1, 1]) {
      part(g, 0.12, 0.08, 0.02, INK_C, s * 0.11, 0.15, -0.255); // Abas laterais
      part(g, 0.06, 0.06, 0.02, INK_C, s * 0.17, 0.24, -0.255); // Cantos superiores da boca
    }
  },
  // ---------------------------------------------------------------- ENDERMAN
  (g) => {
    const SKIN_E = 0x1a1a24, EYE_E = 0xa06aff;
    part(g, 0.46, 0.5, 0.46, SKIN_E, 0, 0.25, 0);
    part(g, 0.5, 0.06, 0.5, 0x2a2a36, 0, 0.48, 0);
    for (const s of [-1, 1]) {
      glow(g, 0.16, 0.03, 0.03, EYE_E, s * 0.10, 0.30, -0.245);
      glow(g, 0.10, 0.02, 0.02, EYE_E, s * 0.10, 0.26, -0.245);
    }
    part(g, 0.24, 0.03, 0.02, 0x0a0a10, 0, 0.14, -0.245);
  },
  // ---------------------------------------------------------------- ALEX
  (g) => {
    const SKIN_A = 0xd8b08a, HAIR_A = 0xd86a1a, SHIRT_A = 0x4f8a3a;
    part(g, 0.5, 0.5, 0.5, SKIN_A, 0, 0.25, 0);
    part(g, 0.52, 0.14, 0.52, HAIR_A, 0, 0.47, 0);
    part(g, 0.52, 0.08, 0.06, HAIR_A, 0, 0.38, -0.24);
    part(g, 0.12, 0.4, 0.12, HAIR_A, 0.24, 0.28, 0.08).rotation.z = 0.2; // ponytail
    for (const s of [-1, 1]) {
      part(g, 0.1, 0.1, 0.02, 0xf4f0e0, s * 0.12, 0.28, -0.255);
      part(g, 0.05, 0.05, 0.02, 0x3a2a1a, s * 0.10, 0.28, -0.265);
    }
    part(g, 0.16, 0.03, 0.02, 0x8a4a3a, 0, 0.15, -0.255);
    part(g, 0.54, 0.02, 0.54, SHIRT_A, 0, 0.02, 0);
  },
  // ---------------------------------------------------------------- FINN HAT (Adventure Time)
  (g) => {
    const SKIN_F = 0xf4e0c8, HAT_F = 0xf4f4f4, INK_F = 0x111111;
    ball(g, 0.27, SKIN_F, 0, 0.26, 0, 1);                     // round face
    // the iconic white hat with ears
    cyl(g, 0, 0.22, 0.34, HAT_F, 0, 0.50, 0, 8);
    for (const s of [-1, 1]) {
      const ear = part(g, 0.12, 0.16, 0.04, HAT_F, s * 0.16, 0.62, 0);
      ear.rotation.z = s * 0.4;
    }
    for (const s of [-1, 1]) part(g, 0.06, 0.08, 0.02, INK_F, s * 0.10, 0.26, -0.255).rotation.z = -s * 0.2;
    part(g, 0.16, 0.04, 0.02, INK_F, 0, 0.14, -0.255);
    for (const s of [-1, 1]) part(g, 0.04, 0.04, 0.02, 0xe88a8a, s * 0.18, 0.20, -0.245);
  },
  // ---------------------------------------------------------------- MORDECAI (Regular Show)
  (g) => {
    const FEATH_M = 0x8ab4d8, BEAK_M = 0xe8a23a, EYE_M = 0x111111;
    ball(g, 0.28, FEATH_M, 0, 0.27, 0, 1);
    // beak
    part(g, 0.12, 0.08, 0.16, BEAK_M, 0, 0.20, -0.28);
    // flight goggles pushed up on the head
    for (const s of [-1, 1]) {
      cyl(g, 0.07, 0.07, 0.03, CHROME, s * 0.08, 0.52, -0.08, 8).rotation.x = 0.4;
      part(g, 0.05, 0.05, 0.02, EYE_M, s * 0.08, 0.52, -0.10);
    }
    part(g, 0.36, 0.04, 0.04, 0x3a3a3a, 0, 0.52, -0.06);
    // hair crest
    for (let k = 0; k < 3; k++) part(g, 0.04, 0.14, 0.04, 0x2a3a5a, 0.02 + k * 0.03, 0.56 + k * 0.02, 0.06);
    for (const s of [-1, 1]) part(g, 0.06, 0.06, 0.02, EYE_M, s * 0.10, 0.30, -0.245);
  },
  // ---------------------------------------------------------------- RIGBY (Regular Show)
  (g) => {
    const SKIN_R = 0xd8d8b0, EYE_R = 0x111111, NOSE_R = 0x8a5a3a;
    ball(g, 0.24, SKIN_R, 0, 0.24, 0, 1);
    // long snout
    part(g, 0.14, 0.10, 0.22, SKIN_R, 0, 0.18, -0.28);
    part(g, 0.06, 0.05, 0.04, NOSE_R, 0, 0.20, -0.40);
    // ears
    for (const s of [-1, 1]) {
      cyl(g, 0.02, 0.08, 0.18, SKIN_R, s * 0.14, 0.50, 0.02, 6).rotation.z = s * 0.3;
      cyl(g, 0.01, 0.05, 0.10, 0xe8b8b8, s * 0.14, 0.50, -0.01, 6).rotation.z = s * 0.3;
    }
    // the beanie (his actual character trait)
    part(g, 0.44, 0.12, 0.44, 0x3a5a8a, 0, 0.48, 0);
    part(g, 0.44, 0.04, 0.44, 0x2a3a5a, 0, 0.42, 0);
    part(g, 0.10, 0.10, 0.02, 0xe8d23a, 0, 0.52, -0.22);
    for (const s of [-1, 1]) part(g, 0.07, 0.07, 0.02, EYE_R, s * 0.10, 0.28, -0.245);
    part(g, 0.16, 0.03, 0.02, 0x3a2a1a, 0, 0.10, -0.245);
  },
  // ---------------------------------------------------------------- GUMBALL (Amazing World of Gumball)
  (g) => {
    const SKIN_G = 0x8ad8f4, EYE_G = 0x111111, MOUTH_G = 0x3a3a4a;
    ball(g, 0.28, SKIN_G, 0, 0.26, 0, 1);
    // cat ears, tall and thin
    for (const s of [-1, 1]) {
      part(g, 0.14, 0.24, 0.04, SKIN_G, s * 0.16, 0.54, 0).rotation.z = s * 0.2;
      part(g, 0.06, 0.14, 0.02, 0xe8a8c8, s * 0.16, 0.54, -0.03).rotation.z = s * 0.2;
    }
    // huge round eyes
    for (const s of [-1, 1]) {
      part(g, 0.14, 0.16, 0.03, 0xf4f4f4, s * 0.10, 0.30, -0.245);
      part(g, 0.08, 0.08, 0.02, EYE_G, s * 0.09, 0.28, -0.26);
    }
    // wide flat mouth
    part(g, 0.26, 0.04, 0.02, MOUTH_G, 0, 0.14, -0.255);
    // whiskers
    for (const s of [-1, 1]) {
      part(g, 0.12, 0.01, 0.01, MOUTH_G, s * 0.22, 0.18, -0.24).rotation.z = s * 0.3;
      part(g, 0.12, 0.01, 0.01, MOUTH_G, s * 0.22, 0.14, -0.24).rotation.z = s * -0.3;
    }
    part(g, 0.28, 0.06, 0.28, 0x5ab8d8, 0, 0.02, 0); // collar hint
  },
  // ---------------------------------------------------------------- LINCOLN LOUD (The Loud House)
  (g) => {
    const SKIN_L = 0xf4e0c8, HAIR_L = 0xf4f4f4, SHIRT_L = 0xe8503a, INK_L = 0x111111;
    part(g, 0.5, 0.5, 0.5, SKIN_L, 0, 0.25, 0);
    // big white quiff of hair
    part(g, 0.52, 0.20, 0.52, HAIR_L, 0, 0.46, 0);
    for (let k = 0; k < 3; k++) {
      part(g, 0.16, 0.14, 0.16, HAIR_L, -0.10 + k * 0.10, 0.58 + (k % 2) * 0.03, -0.08 + k * 0.06).rotation.y = k * 0.3;
    }
    part(g, 0.52, 0.06, 0.06, HAIR_L, 0, 0.38, -0.24);
    for (const s of [-1, 1]) {
      part(g, 0.10, 0.10, 0.02, 0xf4f4f4, s * 0.12, 0.28, -0.255);   // eye
      part(g, 0.04, 0.04, 0.02, INK_L, s * 0.10, 0.27, -0.265);      // pupil
      part(g, 0.06, 0.06, 0.02, 0xe8a0a0, s * 0.20, 0.18, -0.245);   // freckle cheek
    }
    // buck teeth
    part(g, 0.10, 0.05, 0.02, 0xf4f4f4, 0, 0.14, -0.255);
    part(g, 0.16, 0.02, 0.02, INK_L, 0, 0.10, -0.245);
  },
  // ---------------------------------------------------------------- RICK (Rick and Morty)
  (g) => {
    const SKIN_RK = 0xe8c8a8, HAIR_RK = 0x9ab8d8, EYE_RK = 0xf4f4f4, BROW_RK = 0x5a6a8a;
    part(g, 0.48, 0.48, 0.48, SKIN_RK, 0, 0.24, 0);
    // wild spiked hair
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const spike = part(g, 0.10, 0.24, 0.10, HAIR_RK, Math.sin(a) * 0.20, 0.58 + Math.cos(a) * 0.05, Math.cos(a) * 0.10);
      spike.rotation.z = Math.sin(a) * 0.4;
      spike.rotation.x = Math.cos(a) * 0.3;
    }
    // unibrow
    part(g, 0.34, 0.05, 0.02, BROW_RK, 0, 0.38, -0.245);
    // drooling eyes, slightly mismatched
    part(g, 0.14, 0.14, 0.03, EYE_RK, -0.11, 0.28, -0.245);
    part(g, 0.12, 0.12, 0.03, EYE_RK, 0.12, 0.26, -0.245);
    part(g, 0.05, 0.05, 0.02, 0x111111, -0.10, 0.27, -0.265);
    part(g, 0.05, 0.05, 0.02, 0x111111, 0.12, 0.25, -0.265);
    // drippy mouth
    part(g, 0.18, 0.03, 0.02, 0x6a4a3a, 0, 0.12, -0.245);
    glow(g, 0.05, 0.10, 0.02, 0x8ae8f4, 0.04, 0.10, -0.245); // drool
  },
  // ---------------------------------------------------------------- BENDER (Futurama)
  (g) => {
    const METAL_B = 0x9aa0a8, DARK_B = 0x3a3f48, LENS_B = 0xf4e0a0, CAP_B = 0x6a7078;
    // cylindrical head
    cyl(g, 0.26, 0.24, 0.50, METAL_B, 0, 0.25, 0, 10);
    // the visor / eye strip
    part(g, 0.52, 0.14, 0.10, DARK_B, 0, 0.30, -0.22);
    for (const s of [-1, 1]) glow(g, 0.12, 0.10, 0.03, LENS_B, s * 0.10, 0.30, -0.28);
    // the antenna
    const ant = part(g, 0.04, 0.32, 0.04, CAP_B, 0, 0.62, 0);
    ant.rotation.z = 0.15;
    glow(g, 0.08, 0.08, 0.08, 0xe8503a, 0, 0.80, 0).name = 'blink';
    // the "speaker" mouth
    part(g, 0.26, 0.10, 0.03, DARK_B, 0, 0.12, -0.245);
    for (let k = 0; k < 4; k++) part(g, 0.02, 0.06, 0.02, METAL_B, -0.09 + k * 0.06, 0.12, -0.255);
    // the cap brim
    part(g, 0.36, 0.04, 0.16, DARK_B, 0, 0.46, -0.18);
  },
  // ---------------------------------------------------------------- CORVO (Dishonored)
  (g) => {
    const SKIN_CV = 0xe8d0b8, MASK_CV = 0x8a7a5a, LENS_CV = 0x4ad8ff, HOOD_CV = 0x2a2e38;
    part(g, 0.5, 0.5, 0.5, HOOD_CV, 0, 0.25, 0);
    // skull-like mask
    part(g, 0.34, 0.36, 0.06, MASK_CV, 0, 0.24, -0.25);
    for (const s of [-1, 1]) {
      glow(g, 0.08, 0.06, 0.03, LENS_CV, s * 0.09, 0.30, -0.28);
      // rivets
      for (let k = 0; k < 3; k++) part(g, 0.02, 0.02, 0.02, 0x5a4a3a, s * (0.13 + k * 0.02), 0.20 + k * 0.06, -0.27);
    }
    // filter slits at the mouth
    for (let k = -2; k <= 2; k++) part(g, 0.015, 0.06, 0.02, 0x3a2a1a, k * 0.03, 0.12, -0.27);
    // hood peak
    part(g, 0.4, 0.14, 0.4, HOOD_CV, 0, 0.46, 0.02).rotation.x = 0.1;
    // scarf or cord tails
    part(g, 0.06, 0.24, 0.03, 0x5a1e1e, 0.22, 0.14, -0.22).rotation.z = 0.4;
    part(g, 0.06, 0.20, 0.03, 0x5a1e1e, -0.22, 0.16, -0.22).rotation.z = -0.4;
    // cheek bone ridge
    for (const s of [-1, 1]) part(g, 0.04, 0.02, 0.02, 0x5a4a3a, s * 0.13, 0.22, -0.28);
  },
  // ---------------------------------------------------------------- VAULT BOY (Fallout)
  (g) => {
    const SKIN_V = 0xf4e0c0, HAIR_V = 0xe8c84a, BLUE_V = 0x3a6ac8, INK_V = 0x111111;
    ball(g, 0.28, SKIN_V, 0, 0.26, 0, 1);
    // the hair swirl
    for (let k = 0; k < 3; k++) {
      part(g, 0.22 - k * 0.05, 0.10, 0.22 - k * 0.05, HAIR_V, 0, 0.50 + k * 0.02, -0.02 + k * 0.02).rotation.y = k * 0.6;
    }
    // the wink
    part(g, 0.10, 0.06, 0.03, INK_V, -0.11, 0.30, -0.245);
    part(g, 0.08, 0.08, 0.03, INK_V, 0.11, 0.30, -0.245);
    // the thumbs-up mouth
    part(g, 0.24, 0.04, 0.02, INK_V, 0, 0.15, -0.245);
    for (const s of [-1, 1]) part(g, 0.04, 0.06, 0.02, INK_V, s * 0.10, 0.19, -0.245).rotation.z = s * 0.6;
    // suit collar
    part(g, 0.34, 0.06, 0.28, BLUE_V, 0, 0.02, -0.02);
    part(g, 0.10, 0.06, 0.03, 0xe8c84a, 0, 0.02, -0.18); // yellow clasp
  },
  // ---------------------------------------------------------------- HEXTECH (Arcane / LoL)
  (g) => {
    const METAL_H = 0x3a4a5a, GOLD_H = 0xd8a23a, GEM_H = 0x4ad8ff, DARK_H = 0x1a2028;
    part(g, 0.5, 0.5, 0.5, METAL_H, 0, 0.25, 0);
    // the mask: smooth plate with a central gem
    part(g, 0.4, 0.42, 0.06, DARK_H, 0, 0.25, -0.25);
    glow(g, 0.10, 0.10, 0.03, GEM_H, 0, 0.32, -0.28).name = 'blink';
    // gold trim
    for (let k = 0; k < 3; k++) part(g, 0.42, 0.03, 0.03, GOLD_H, 0, 0.12 + k * 0.10, -0.275);
    for (const s of [-1, 1]) part(g, 0.03, 0.42, 0.03, GOLD_H, s * 0.19, 0.25, -0.275);
    // side horns / vents
    for (const s of [-1, 1]) {
      const vent = part(g, 0.10, 0.20, 0.14, GOLD_H, s * 0.26, 0.36, 0);
      vent.rotation.z = s * -0.3;
    }
    // mouth grille
    for (let k = -2; k <= 2; k++) part(g, 0.02, 0.08, 0.02, GOLD_H, k * 0.04, 0.10, -0.28);
    // crown spike
    part(g, 0.08, 0.18, 0.08, GOLD_H, 0, 0.55, 0).rotation.x = 0.1;
  },
  // ---------------------------------------------------------------- VIVI (FF IX)
  (g) => {
    const HAT_V = 0x4a3a6a, FACE_V = 0x111111, EYE_V = 0xf4d23a, GOLD_V = 0xd8a23a, FEATH_V = 0xe8e0d0;
    // huge wizard hat
    cyl(g, 0.30, 0.36, 0.20, HAT_V, 0, 0.36, 0, 10);
    const cone = cyl(g, 0, 0.28, 0.5, HAT_V, 0, 0.68, 0, 10);
    cone.rotation.z = 0.18;
    // brim
    cyl(g, 0.42, 0.42, 0.05, HAT_V, 0, 0.28, 0, 12);
    // face: black void with two glowing eyes
    ball(g, 0.22, FACE_V, 0, 0.18, -0.10, 1).scale.set(1, 0.9, 0.7);
    for (const s of [-1, 1]) glow(g, 0.06, 0.07, 0.03, EYE_V, s * 0.08, 0.19, -0.29);
    // gold hat band
    cyl(g, 0.31, 0.31, 0.05, GOLD_V, 0, 0.26, 0, 10);
    // the feather plume
    const plume = part(g, 0.04, 0.30, 0.04, FEATH_V, 0.18, 0.72, 0.05);
    plume.rotation.z = -0.4;
    glow(g, 0.05, 0.05, 0.02, GOLD_V, 0.24, 0.86, 0.05); // hat jewel
    // the wide collar that hides the face from the side
    part(g, 0.5, 0.12, 0.34, HAT_V, 0, 0.04, -0.02);
    part(g, 0.5, 0.05, 0.34, GOLD_V, 0, 0.10, -0.02);
  },
];

/** Torsos. Built in the body group: chest spans y 0.71..1.33, shoulders at x +-0.34. */
const TORSO_BUILDERS: PartFn[] = [
  (g, c) => { part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0); }, // SLAB
  (g, c, _l, dark) => { // BARREL
    cyl(g, 0.29, 0.29, 0.62, c, 0, 1.02, 0, 10);
    for (const y of [0.84, 1.2]) cyl(g, 0.3, 0.3, 0.05, dark, 0, y, 0, 10);
  },
  (g, c) => { // TUXEDO: dressed for the occasion
    part(g, 0.52, 0.62, 0.3, 0x18181c, 0, 1.02, 0);
    part(g, 0.16, 0.5, 0.02, EYE, 0, 1.04, -0.152);
    for (const s of [-1, 1]) part(g, 0.08, 0.07, 0.03, c, s * 0.05, 1.27, -0.16).rotation.z = s * 0.5;
    for (let k = 0; k < 3; k++) part(g, 0.025, 0.025, 0.02, INK, 0, 1.14 - k * 0.12, -0.165);
    part(g, 0.54, 0.05, 0.32, c, 0, 0.74, 0);
  },
  (g, c) => { // HAZARD VEST
    part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0);
    part(g, 0.54, 0.44, 0.32, 0xe8d23a, 0, 1.08, 0);
    for (const y of [0.98, 1.16]) glow(g, 0.55, 0.045, 0.33, 0xf4f4f4, 0, y, 0);
    part(g, 0.14, 0.44, 0.33, c, 0, 1.08, 0);
  },
  (g, c, _l, dark) => { // ARMOUR: chest plate and shoulder pads
    part(g, 0.5, 0.62, 0.28, dark, 0, 1.02, 0);
    part(g, 0.46, 0.34, 0.06, CHROME, 0, 1.12, -0.15);
    part(g, 0.3, 0.14, 0.06, 0x8a9098, 0, 0.86, -0.15);
    for (const s of [-1, 1]) part(g, 0.2, 0.1, 0.24, c, s * 0.36, 1.34, 0);
    glow(g, 0.06, 0.06, 0.02, c, 0, 1.14, -0.185);
  },
  (g, c) => { // CRATE: fragile, this way up
    part(g, 0.56, 0.6, 0.4, WOOD, 0, 1.02, 0);
    for (const y of [0.76, 1.02, 1.28]) part(g, 0.58, 0.05, 0.42, 0x5a3418, 0, y, 0);
    for (const s of [-1, 1]) part(g, 0.05, 0.6, 0.42, 0x5a3418, s * 0.26, 1.02, 0);
    part(g, 0.2, 0.12, 0.02, c, 0, 1.15, -0.212);
  },
  (g, c, _l, dark) => { // BACKPACK: packed for a long trip
    part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0);
    part(g, 0.4, 0.46, 0.2, dark, 0, 1.04, 0.24);
    cyl(g, 0.07, 0.07, 0.42, 0x8a6a3a, 0, 1.32, 0.24, 8).rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) part(g, 0.05, 0.6, 0.31, DARK, s * 0.17, 1.03, 0);
    part(g, 0.2, 0.14, 0.05, 0x8a6a3a, 0, 0.94, 0.36);
  },
  (g, c) => { // RIBCAGE: nothing to hide
    part(g, 0.08, 0.62, 0.08, BONE, 0, 1.02, 0.08);
    for (let k = 0; k < 4; k++) {
      part(g, 0.44 - k * 0.04, 0.05, 0.26, BONE, 0, 1.26 - k * 0.12, 0);
    }
    part(g, 0.3, 0.1, 0.2, BONE, 0, 0.76, 0);
    glow(g, 0.1, 0.1, 0.1, c, -0.07, 1.14, -0.02).name = 'blink';
  },
  (g, c, light) => { // MUSCLE: skipped leg day
    const chest = cyl(g, 0.44, 0.24, 0.62, c, 0, 1.02, 0, 4);
    chest.rotation.y = Math.PI / 4;
    chest.scale.z = 0.62;
    for (const s of [-1, 1]) ball(g, 0.12, light, s * 0.36, 1.3, 0);
    part(g, 0.02, 0.3, 0.02, INK, 0, 1.1, -0.2);
  },
  (g, c) => { // TRASH CAN
    cyl(g, 0.27, 0.25, 0.6, 0x6a7078, 0, 1.01, 0, 10);
    for (const y of [0.86, 1.02, 1.18]) cyl(g, 0.28, 0.28, 0.03, 0x4a4e56, 0, y, 0, 10);
    cyl(g, 0.31, 0.31, 0.05, 0x8a9098, 0, 1.33, 0, 10);
    cyl(g, 0.285, 0.285, 0.07, c, 0, 0.76, 0, 10);
  },
  (g, c) => { // JETPACK: not actually connected to anything
    part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0);
    for (const s of [-1, 1]) {
      cyl(g, 0.09, 0.09, 0.46, CHROME, s * 0.12, 1.06, 0.24, 8);
      cyl(g, 0.05, 0.09, 0.1, DARK, s * 0.12, 0.79, 0.24, 8);
      cyl(g, 0.04, 0.01, 0.12, 0xffa23a, s * 0.12, 0.69, 0.24, 6, true).name = 'blink';
    }
    part(g, 0.3, 0.06, 0.06, DARK, 0, 1.2, 0.2);
  },
  (g, c, light) => { // CAPE
    part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0);
    part(g, 0.6, 0.86, 0.03, light, 0, 0.9, 0.21).rotation.x = 0.16;
    part(g, 0.56, 0.06, 0.34, light, 0, 1.31, 0);
    glow(g, 0.07, 0.07, 0.02, YELLOW, 0, 1.3, -0.165);
  },
  (g, c, light, dark) => { // HOODIE: hood down, hands in the pocket
    part(g, 0.54, 0.62, 0.32, c, 0, 1.02, 0);
    part(g, 0.36, 0.16, 0.03, dark, 0, 0.86, -0.17); // front pocket
    part(g, 0.46, 0.18, 0.2, light, 0, 1.3, 0.16); // the hood, bunched at the back
    for (const s of [-1, 1]) part(g, 0.025, 0.2, 0.02, EYE, s * 0.06, 1.18, -0.17); // drawstrings
    part(g, 0.56, 0.06, 0.34, dark, 0, 0.73, 0); // ribbed hem
  },
  (g, c) => { // SPACESUIT
    part(g, 0.56, 0.64, 0.34, 0xeeeeea, 0, 1.02, 0);
    part(g, 0.26, 0.16, 0.05, 0xb8b8b4, 0, 1.08, -0.18); // chest control box
    for (const [x, col] of [[-0.08, 0xe8503a], [0, 0x5ad86a], [0.08, YELLOW]] as const) glow(g, 0.04, 0.04, 0.02, col, x, 1.1, -0.21);
    part(g, 0.12, 0.08, 0.02, c, -0.17, 1.24, -0.172); // mission patch
    part(g, 0.36, 0.42, 0.18, 0xd8d8d4, 0, 1.06, 0.25); // life support pack
    part(g, 0.58, 0.06, 0.36, 0xb8b8b4, 0, 0.74, 0);
  },
  (g, c) => { // SCRAP CHASSIS: a riveted robot body with a glowing core
    part(g, 0.54, 0.6, 0.34, 0x6a7078, 0, 1.03, 0);
    part(g, 0.2, 0.2, 0.04, DARK, 0, 1.1, -0.18);
    glow(g, 0.12, 0.12, 0.02, c, 0, 1.1, -0.2).name = 'blink'; // core
    for (let k = 0; k < 4; k++) part(g, 0.3, 0.025, 0.02, DARK, 0, 0.88 - k * 0.04, -0.175); // vent
    for (const [x, y] of [[-0.23, 1.28], [0.23, 1.28], [-0.23, 0.78], [0.23, 0.78]]) part(g, 0.035, 0.035, 0.02, CHROME, x, y, -0.175);
    cyl(g, 0.035, 0.035, 0.5, 0x8a6a3a, 0.2, 1.05, 0.2, 6).rotation.x = 0.3; // exposed pipe
    part(g, 0.18, 0.12, 0.03, 0x8a5a2a, -0.14, 0.95, -0.172).rotation.z = 0.2; // patched-on plate
  },
  (g, c) => { // PIXEL TEE: a shirt with a pixel heart
    part(g, 0.52, 0.62, 0.3, c, 0, 1.02, 0);
    const heart = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
    const px = 0.035;
    heart.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === 'X') part(g, px, px, 0.02, 0xf4f0e0, (i - 3) * px, 1.17 - j * px, -0.16);
    }));
    part(g, 0.54, 0.05, 0.32, 0xf4f0e0, 0, 1.31, 0); // collar
  },
  // ---------------------------------------------------------------- STEVE SHIRT
  (g) => { // camisa azul ciano, caixa dura, cinto marrom
    const SHIRT = 0x3a9ec4, BELT = 0x3a2416, SKIN_MC = 0xc89a76;
    part(g, 0.52, 0.5, 0.32, SHIRT, 0, 1.0, 0);
    part(g, 0.52, 0.06, 0.32, BELT, 0, 0.76, 0);
    for (const s of [-1, 1]) part(g, 0.08, 0.5, 0.32, SKIN_MC, s * 0.30, 1.0, 0); // bare arms
    part(g, 0.10, 0.12, 0.02, 0xf4f0e0, 0, 1.12, -0.165); // collar patch
  },
  // ---------------------------------------------------------------- CREEPER HIDE
  (g) => {
    const SKIN_C = 0x5aa83a, DARK_C = 0x3a7a22, INK_C = 0x080808;
    // Base retangular
    part(g, 0.52, 0.62, 0.32, SKIN_C, 0, 1.02, 0);
    
    // Textura de pixels aleatórios
    const spots = [
      [-0.15, 1.25, 0.16], [0.1, 0.85, -0.16], [0.2, 1.1, 0.05], [-0.2, 0.9, -0.1],
      [0.05, 1.3, -0.1], [-0.05, 1.0, 0.16], [0.15, 0.95, 0.1], [-0.1, 0.8, -0.16]
    ];
    for (const [x, y, z] of spots) {
      // Aplica as manchas nas faces do torso
      part(g, 0.1, 0.1, 0.02, DARK_C, x, y, 0.165);
      part(g, 0.1, 0.1, 0.02, DARK_C, x, y, -0.165);
      part(g, 0.02, 0.1, 0.1, DARK_C, 0.265, y, z);
      part(g, 0.02, 0.1, 0.1, DARK_C, -0.265, y, z);
    }
  },
  // ---------------------------------------------------------------- DIAMOND CHEST
  (g, c) => { // armadura de diamante, ombreiras quadradas
    const DIAMOND = 0x4ad8c8, DIAMOND_D = 0x2aa8a0, TRIM = 0x9af4ec;
    part(g, 0.54, 0.62, 0.34, DIAMOND, 0, 1.02, 0);
    part(g, 0.54, 0.06, 0.34, TRIM, 0, 1.28, 0);
    part(g, 0.54, 0.06, 0.34, DIAMOND_D, 0, 0.74, 0);
    for (const s of [-1, 1]) {
      part(g, 0.20, 0.16, 0.24, DIAMOND_D, s * 0.36, 1.32, 0);
      part(g, 0.20, 0.05, 0.24, TRIM, s * 0.36, 1.24, 0);
    }
    // faceted highlight
    for (let k = 0; k < 3; k++) part(g, 0.06, 0.06, 0.02, TRIM, -0.12 + k * 0.12, 1.10, -0.18).rotation.z = Math.PI / 4;
    // team colour pips
    glow(g, 0.04, 0.04, 0.02, c, 0, 0.90, -0.185);
  },
  // ---------------------------------------------------------------- ENDER CLOAK
  (g) => { // capa escura, gola alta, borda roxa brilhante
    const BLACK = 0x1a1a24, DARK = 0x0a0a12, PURPLE = 0xa06aff;
    part(g, 0.52, 0.62, 0.32, BLACK, 0, 1.02, 0);
    // high collar
    part(g, 0.36, 0.20, 0.20, DARK, 0, 1.34, 0.06);
    part(g, 0.40, 0.04, 0.22, PURPLE, 0, 1.44, 0.06);
    // cloak back, longer than the body
    part(g, 0.56, 0.9, 0.03, DARK, 0, 0.9, 0.22).rotation.x = 0.12;
    // glowing runes on the front
    for (let k = 0; k < 4; k++) glow(g, 0.04, 0.06, 0.02, PURPLE, -0.15 + k * 0.10, 1.10 - (k % 2) * 0.06, -0.165);
    glow(g, 0.10, 0.10, 0.02, PURPLE, 0, 0.96, -0.165).name = 'blink';
  },
  // ---------------------------------------------------------------- FINN SHIRT
  (g, c) => { // camiseta azul-marinho, mochila verde, short
    const SHIRT = 0x2a3a6a, PACK = 0x5a8a3a, TRIM = 0xe8d23a;
    part(g, 0.52, 0.62, 0.32, SHIRT, 0, 1.02, 0);
    part(g, 0.40, 0.42, 0.24, PACK, 0, 1.04, 0.24);
    part(g, 0.30, 0.06, 0.26, 0x3a5a1a, 0, 1.24, 0.24);
    // straps
    for (const s of [-1, 1]) part(g, 0.06, 0.5, 0.34, 0x3a5a1a, s * 0.14, 1.04, 0.02);
    // little yellow patch
    part(g, 0.10, 0.10, 0.02, TRIM, 0.12, 1.14, -0.165);
    // team colour trim at the hem
    part(g, 0.54, 0.04, 0.34, c, 0, 0.72, 0);
  },
  // ---------------------------------------------------------------- MORDECAI FEATHER
  (g) => { // peito de pássaro azul com peitilho branco
    const FEATH = 0x8ab4d8, WHITE = 0xf4f4f4, BEAK = 0xe8a23a;
    part(g, 0.52, 0.62, 0.32, FEATH, 0, 1.02, 0);
    // chest plumage, layered
    for (let k = 0; k < 3; k++) {
      part(g, 0.40 - k * 0.06, 0.08, 0.02, WHITE, 0, 1.18 - k * 0.10, -0.165);
    }
    // feather tips at the shoulders
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const f = part(g, 0.06, 0.16, 0.02, 0x6a94b8, s * 0.30, 1.30 - k * 0.05, -0.14);
        f.rotation.z = s * (0.2 + k * 0.2);
      }
    }
    // the beak-like clasp
    part(g, 0.12, 0.06, 0.06, BEAK, 0, 1.30, -0.18);
  },
  // ---------------------------------------------------------------- GUMBALL SWEATER
  (g) => { // suéter bege, gola, listra, e um peixinho
    const SWEATER = 0xd8c8a8, STRIPE = 0x8ad8f4, COLLAR = 0xb8a888;
    part(g, 0.54, 0.62, 0.34, SWEATER, 0, 1.02, 0);
    part(g, 0.54, 0.06, 0.34, STRIPE, 0, 1.18, 0);
    part(g, 0.54, 0.04, 0.34, STRIPE, 0, 0.80, 0);
    // big collar
    part(g, 0.34, 0.10, 0.36, COLLAR, 0, 1.36, 0);
    // sleeves (chunky)
    for (const s of [-1, 1]) part(g, 0.16, 0.44, 0.30, SWEATER, s * 0.32, 1.06, 0);
    // the fish patch
    part(g, 0.12, 0.06, 0.02, 0xe8503a, 0, 1.04, -0.175);
    part(g, 0.06, 0.08, 0.02, 0xe8503a, 0.08, 1.04, -0.175);
  },
 // ---------------------------------------------------------------- LINCOLN STRIPES
  (g, c) => { // camisa listrada laranja/branco
    const ORANGE = 0xe8503a, WHITE = 0xf4f4f4;
    part(g, 0.52, 0.62, 0.32, WHITE, 0, 1.02, 0);
    for (let k = 0; k < 4; k++) part(g, 0.52, 0.07, 0.34, ORANGE, 0, 0.82 + k * 0.14, 0);
    part(g, 0.30, 0.06, 0.34, WHITE, 0, 1.34, 0);
    for (const s of [-1, 1]) {
      part(g, 0.14, 0.42, 0.30, ORANGE, s * 0.32, 1.06, 0);
      part(g, 0.16, 0.04, 0.32, WHITE, s * 0.32, 0.86, 0);
    }
    glow(g, 0.04, 0.04, 0.02, c, 0, 1.10, -0.175);   // ← c agora existe
  },
  // ---------------------------------------------------------------- VAULT SUIT
  (g) => { // macacão azul com listra amarela e o número 111
    const BLUE = 0x3a6ac8, YELLOW = 0xe8c84a, DARK = 0x2a4a8a;
    part(g, 0.52, 0.62, 0.32, BLUE, 0, 1.02, 0);
    // the yellow vertical stripe
    part(g, 0.08, 0.58, 0.34, YELLOW, 0, 1.02, 0);
    // belt
    part(g, 0.52, 0.06, 0.34, DARK, 0, 0.74, 0);
    part(g, 0.10, 0.06, 0.02, YELLOW, 0, 0.74, -0.18);
    // collar
    part(g, 0.30, 0.08, 0.34, DARK, 0, 1.34, 0);
    // number patches
    part(g, 0.14, 0.10, 0.02, YELLOW, -0.16, 1.10, -0.175);
    part(g, 0.14, 0.10, 0.02, YELLOW, 0.16, 1.10, -0.175);
  },
  // ---------------------------------------------------------------- HEXTECH ARMOUR
  (g) => { // placa de metal azul-escuro com gemas e ouro
    const METAL = 0x3a4a5a, GOLD = 0xd8a23a, GEM = 0x4ad8ff, DARK = 0x1a2028;
    part(g, 0.54, 0.62, 0.34, METAL, 0, 1.02, 0);
    // central gem plate
    part(g, 0.30, 0.26, 0.06, DARK, 0, 1.10, -0.18);
    glow(g, 0.12, 0.12, 0.03, GEM, 0, 1.10, -0.21).name = 'blink';
    // gold trim on shoulders and belt
    for (const s of [-1, 1]) {
      part(g, 0.20, 0.14, 0.24, METAL, s * 0.36, 1.32, 0);
      part(g, 0.20, 0.04, 0.24, GOLD, s * 0.36, 1.24, 0);
    }
    part(g, 0.54, 0.05, 0.36, GOLD, 0, 0.74, 0);
    // gold rivets
    for (let k = 0; k < 4; k++) part(g, 0.03, 0.03, 0.02, GOLD, -0.20 + k * 0.14, 1.26, -0.18);
  },
  // ---------------------------------------------------------------- BENDER PLATE
  (g) => { // chassi metálico com porta de "forno" no peito
    const METAL = 0x9aa0a8, DARK = 0x3a3f48, DOOR = 0x6a7078, RED = 0xe8503a;
    part(g, 0.52, 0.62, 0.34, METAL, 0, 1.02, 0);
    // the little door
    part(g, 0.26, 0.20, 0.03, DOOR, 0, 1.06, -0.185);
    for (let k = -1; k <= 1; k++) part(g, 0.20, 0.02, 0.02, DARK, 0, 1.06 + k * 0.05, -0.20);
    part(g, 0.04, 0.04, 0.02, DARK, 0.11, 1.06, -0.20); // handle
    // vents at the bottom
    for (let k = -2; k <= 2; k++) part(g, 0.02, 0.08, 0.02, DARK, k * 0.05, 0.82, -0.185);
    // rivets and a warning stripe
    for (const s of [-1, 1]) part(g, 0.03, 0.03, 0.02, RED, s * 0.20, 1.26, -0.185);
    part(g, 0.52, 0.05, 0.36, DARK, 0, 0.72, 0);
    part(g, 0.52, 0.04, 0.36, RED, 0, 0.66, 0);
  },
  // ---------------------------------------------------------------- CORVO COAT
  (g) => { // sobretudo azul-escuro, gola alta, cinto, fivelas
    const COAT = 0x2a2e38, DARK = 0x1a1e28, BELT = 0x3a2a1a, BUCKLE = 0x8a9098;
    part(g, 0.54, 0.62, 0.34, COAT, 0, 1.02, 0);
    // coat tails
    part(g, 0.56, 0.30, 0.04, COAT, 0, 0.80, 0.20).rotation.x = 0.1;
    // high collar
    part(g, 0.36, 0.16, 0.24, DARK, 0, 1.38, 0.02);
    // lapels
    for (const s of [-1, 1]) part(g, 0.10, 0.30, 0.02, DARK, s * 0.14, 1.10, -0.175).rotation.z = s * 0.15;
    // belt and buckle
    part(g, 0.54, 0.06, 0.36, BELT, 0, 0.78, 0);
    part(g, 0.08, 0.06, 0.02, BUCKLE, 0, 0.78, -0.185);
    // small buttons
    for (let k = 0; k < 3; k++) part(g, 0.03, 0.03, 0.02, BUCKLE, 0, 1.16 - k * 0.10, -0.185);
    // the empty-handed assassin's subtle flourish
    glow(g, 0.04, 0.04, 0.02, 0x4ad8ff, -0.22, 1.24, -0.18);
  },

];

/**
 * Legs. Each builder makes ONE leg: a mesh whose origin is the hip (so it
 * swings from there), 0.72 long, with any extras attached as children.
 * `side` is -1 for the left leg, +1 for the right.
 */
type LegFn = (root: THREE.Object3D, x: number, c: number, dark: number, side: number) => THREE.Mesh;
const HIP = 0.72;
const LEG_BUILDERS: LegFn[] = [
  (r, x, _c, dark) => limb(r, 0.17, HIP, 0.2, dark, x, HIP), // STUBS
  (r, x, _c, dark) => { // STILTS
    const l = limb(r, 0.06, HIP, 0.06, CHROME, x, HIP);
    part(l, 0.16, 0.05, 0.26, dark, 0, -0.695, -0.05);
    part(l, 0.1, 0.04, 0.1, DARK, 0, -0.36, 0);
    return l;
  },
  (r, x, _c, dark) => { // BOOTS
    const l = limb(r, 0.15, HIP, 0.17, dark, x, HIP);
    part(l, 0.2, 0.26, 0.24, 0x3a2a1a, 0, -0.59, 0);
    part(l, 0.2, 0.12, 0.14, 0x3a2a1a, 0, -0.66, -0.17);
    part(l, 0.21, 0.04, 0.4, INK, 0, -0.71, -0.06);
    return l;
  },
  (r, x, c) => { // SPRINGS
    const l = limb(r, 0.03, HIP, 0.03, CHROME, x, HIP);
    for (let k = 0; k < 6; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 4, 8), flatMat(CHROME));
      ring.rotation.x = Math.PI / 2 + 0.25;
      ring.position.y = -0.08 - k * 0.105;
      l.add(ring);
    }
    part(l, 0.18, 0.05, 0.22, c, 0, -0.695, -0.02);
    return l;
  },
  (r, x, _c, dark, side) => { // PEG LEG: one of each
    if (side < 0) {
      const l = limb(r, 0.13, 0.3, 0.15, dark, x, HIP);
      cyl(l, 0.055, 0.03, 0.42, WOOD, 0, -0.51, 0, 6);
      cyl(l, 0.07, 0.07, 0.04, CHROME, 0, -0.3, 0, 6);
      return l;
    }
    const l = limb(r, 0.15, HIP, 0.17, dark, x, HIP);
    part(l, 0.19, 0.14, 0.32, 0x3a2a1a, 0, -0.65, -0.07);
    return l;
  },
  (r, x, c) => { // ROBOT: joints and a status light
    const l = limb(r, 0.13, HIP, 0.13, 0x8a9098, x, HIP);
    part(l, 0.17, 0.1, 0.17, 0x4a4e56, 0, -0.36, 0);
    glow(l, 0.05, 0.05, 0.02, c, 0, -0.36, -0.09);
    part(l, 0.19, 0.08, 0.3, 0x4a4e56, 0, -0.68, -0.05);
    return l;
  },
  (r, x, c) => { // SHORTS: knees out, socks up
    const l = limb(r, 0.12, HIP, 0.13, SKIN, x, HIP);
    part(l, 0.19, 0.3, 0.22, c, 0, -0.15, 0);
    part(l, 0.14, 0.16, 0.15, EYE, 0, -0.56, 0);
    part(l, 0.17, 0.09, 0.3, 0xc8281e, 0, -0.675, -0.06);
    return l;
  },
  (r, x) => { // TREADS: a tank from the waist down
    const l = limb(r, 0.2, 0.5, 0.2, 0x4a4e56, x, HIP);
    part(l, 0.2, 0.24, 0.5, INK, 0, -0.6, 0);
    for (let k = -2; k <= 2; k++) part(l, 0.215, 0.04, 0.03, 0x6a7078, 0, -0.71, k * 0.1);
    for (const z of [-0.17, 0.17]) cyl(l, 0.09, 0.09, 0.21, CHROME, 0, -0.6, z, 8).rotation.z = Math.PI / 2;
    return l;
  },
  (r, x) => { // CHICKEN
    const l = limb(r, 0.045, HIP, 0.045, 0xe8c63a, x, HIP);
    part(l, 0.19, 0.24, 0.2, EYE, 0, -0.12, 0);
    for (const a of [-0.5, 0, 0.5]) {
      const toe = part(l, 0.035, 0.03, 0.2, 0xe8c63a, Math.sin(a) * 0.08, -0.705, -0.08);
      toe.rotation.y = -a;
    }
    part(l, 0.035, 0.03, 0.08, 0xe8c63a, 0, -0.705, 0.05);
    return l;
  },
  (r, x, c, dark) => { // WHEELS
    const l = limb(r, 0.1, 0.58, 0.1, dark, x, HIP);
    cyl(l, 0.14, 0.14, 0.09, INK, 0, -0.58, 0, 10).rotation.z = Math.PI / 2;
    cyl(l, 0.06, 0.06, 0.1, c, 0, -0.58, 0, 6).rotation.z = Math.PI / 2;
    return l;
  },
  (r, x) => { // FLIPPERS
    const l = limb(r, 0.13, HIP, 0.14, 0x2a6a8a, x, HIP);
    part(l, 0.24, 0.035, 0.5, 0xe8a02a, 0, -0.7, -0.19);
    part(l, 0.15, 0.07, 0.16, 0xe8a02a, 0, -0.675, 0);
    return l;
  },
  (r, x, c, dark) => { // BELL BOTTOMS
    const l = limb(r, 0.14, 0.46, 0.15, dark, x, HIP);
    cyl(l, 0.09, 0.19, 0.3, dark, 0, -0.57, 0, 6);
    cyl(l, 0.195, 0.195, 0.03, c, 0, -0.705, 0, 6);
    return l;
  },
  (r, x) => { // PIXEL PANTS: square legs, square shoes
    const l = limb(r, 0.2, HIP, 0.2, 0x3a4a8a, x, HIP);
    part(l, 0.21, 0.12, 0.26, 0x4a4a52, 0, -0.66, -0.03);
    part(l, 0.21, 0.04, 0.21, 0x2a3a6a, 0, -0.5, 0); // a darker pixel band
    return l;
  },
  (r, x, c) => { // MOON BOOTS
    const l = limb(r, 0.14, HIP, 0.15, 0xd8d8d4, x, HIP);
    part(l, 0.26, 0.3, 0.32, 0xeeeeea, 0, -0.56, -0.03);
    part(l, 0.27, 0.06, 0.34, 0x6a6a68, 0, -0.69, -0.03); // thick sole
    part(l, 0.265, 0.05, 0.325, c, 0, -0.48, -0.03); // stripe
    return l;
  },
  (r, x, c, dark) => { // ROLLER SKATES
    const l = limb(r, 0.15, HIP, 0.16, dark, x, HIP);
    part(l, 0.19, 0.2, 0.26, 0xf4f0e0, 0, -0.55, -0.03);
    part(l, 0.2, 0.03, 0.3, DARK, 0, -0.645, -0.03);
    for (const z of [-0.14, 0.08]) {
      for (const s of [-1, 1]) cyl(l, 0.035, 0.035, 0.035, c, s * 0.07, -0.685, z, 8).rotation.z = Math.PI / 2;
    }
    part(l, 0.06, 0.05, 0.05, 0xe8503a, 0, -0.6, -0.18); // toe stop
    return l;
  },
  (r, x, c, dark) => { // HOVER: no feet, just thrusters
    const l = limb(r, 0.15, 0.42, 0.16, dark, x, HIP);
    cyl(l, 0.09, 0.06, 0.1, CHROME, 0, -0.47, 0, 8);
    cyl(l, 0.06, 0.0, 0.2, c, 0, -0.62, 0, 8, true).name = 'blink'; // the glowing jet
    return l;
  },
  // ---------------------------------------------------------------- STEVE JEANS
  (r, x, _c, dark) => { // jeans azul-escuro, caixa, botas
    const l = limb(r, 0.18, 0.5, 0.18, 0x2a3a6a, x, HIP);
    part(l, 0.20, 0.14, 0.20, 0x3a2416, 0, -0.5, 0);     // boot
    part(l, 0.20, 0.06, 0.20, 0x1a1410, 0, -0.58, 0);    // sole
    part(l, 0.20, 0.06, 0.20, 0x1a243a, 0, 0.03, 0);     // waistband
    return l;
  },
  // ---------------------------------------------------------------- DIAMOND LEGS
  (r, x, _c, dark) => { // pernas de diamante com joelheiras facetadas
    const l = limb(r, 0.16, 0.5, 0.16, 0x4ad8c8, x, HIP);
    part(l, 0.18, 0.14, 0.18, 0x2aa8a0, 0, -0.1, 0);     // knee joint
    part(l, 0.06, 0.06, 0.02, 0x9af4ec, 0, -0.1, -0.10).rotation.z = Math.PI / 4; // knee facet
    part(l, 0.18, 0.12, 0.18, 0x2aa8a0, 0, -0.52, 0);    // boot
    part(l, 0.20, 0.06, 0.20, 0x9af4ec, 0, -0.6, 0);     // trim
    return l;
  },
  // ---------------------------------------------------------------- CREEPER FEET
  (r, x, _c, dark) => { 
    const l = limb(r, 0.16, 0.5, 0.16, 0x5aa83a, x, HIP);
    // Manchas aleatórias na perna
    part(l, 0.08, 0.08, 0.02, 0x3a7a22, 0, -0.2, -0.085);
    part(l, 0.02, 0.1, 0.1, 0x3a7a22, 0.085, -0.3, 0);
    // Pé quadrado e escuro embaixo
    part(l, 0.18, 0.14, 0.20, 0x3a7a22, 0, -0.54, 0);
    part(l, 0.18, 0.06, 0.20, 0x5aa83a, 0, -0.62, 0);
    return l;
  },
  // ---------------------------------------------------------------- ENDER STILTS
  (r, x, _c, dark) => { // pernas longas e finas, pés flutuantes
    const l = limb(r, 0.10, 0.8, 0.10, 0x1a1a24, x, HIP);
    for (let k = 0; k < 3; k++) glow(l, 0.04, 0.04, 0.02, 0xa06aff, 0, -0.2 - k * 0.2, -0.06);
    part(l, 0.14, 0.14, 0.20, 0x1a1a24, 0, -0.84, 0);   // floating foot
    return l;
  },
  // ---------------------------------------------------------------- FINN JEANS
  (r, x, _c, dark) => { // jeans azuis com cano dobrado e tênis
    const l = limb(r, 0.16, 0.46, 0.16, 0x2a3a6a, x, HIP);
    part(l, 0.18, 0.06, 0.18, 0x1a243a, 0, -0.4, 0);     // cuff
    part(l, 0.18, 0.12, 0.22, 0xf4f4f4, 0, -0.52, 0);    // shoe
    part(l, 0.20, 0.04, 0.24, 0xe8503a, 0, -0.6, 0);     // sole
    return l;
  },
  // ---------------------------------------------------------------- MORDECAI TALONS
  (r, x, _c, dark) => { // pernas finas de pássaro com garras
    const l = limb(r, 0.08, 0.5, 0.08, 0x3a5a7a, x, HIP);
    part(l, 0.10, 0.10, 0.10, 0x8ab4d8, 0, -0.22, 0);   // feather knee
    part(l, 0.04, 0.04, 0.20, 0xe8a23a, 0, -0.5, -0.02);
    for (let k = -1; k <= 1; k++) part(l, 0.03, 0.03, 0.10, 0xe8a23a, k * 0.03, -0.56, -0.14);
    part(l, 0.04, 0.04, 0.12, 0xe8a23a, 0, -0.56, 0.08);
    return l;
  },
  // ---------------------------------------------------------------- GUMBALL JEANS
  (r, x, _c, dark) => { // jeans apertados, tênis vermelhos grandes
    const l = limb(r, 0.15, 0.46, 0.15, 0x3a4a7a, x, HIP);
    part(l, 0.20, 0.14, 0.24, 0xe8503a, 0, -0.52, 0);    // shoe
    for (let k = 0; k < 3; k++) part(l, 0.10, 0.02, 0.02, 0xf4f4f4, 0, -0.48 + k * 0.03, -0.12);
    part(l, 0.22, 0.04, 0.26, 0x8a2a1e, 0, -0.6, 0);     // sole
    return l;
  },
  // ---------------------------------------------------------------- LINCOLN CHUCKS
  (r, x, _c, dark) => { // shorts e tênis de lona
    const l = limb(r, 0.14, 0.20, 0.14, 0xd8b08a, x, HIP); // bare shin
    part(l, 0.17, 0.24, 0.17, 0x3a5a8a, 0, 0.12, 0);     // shorts
    part(l, 0.18, 0.14, 0.22, 0xf4f4f4, 0, -0.54, 0);    // canvas
    part(l, 0.19, 0.04, 0.23, 0xe8503a, 0, -0.62, 0);    // toe
    for (let k = 0; k < 3; k++) part(l, 0.10, 0.02, 0.02, 0x8a9098, 0, -0.48 + k * 0.03, -0.11);
    return l;
  },
  // ---------------------------------------------------------------- VAULT BOOTS
  (r, x, _c, dark) => { // botas de couro com faixa amarela
    const l = limb(r, 0.17, 0.44, 0.17, 0x3a2a1a, x, HIP);
    part(l, 0.18, 0.05, 0.18, 0xe8c84a, 0, -0.44, 0);
    part(l, 0.20, 0.14, 0.24, 0x3a2a1a, 0, -0.54, 0);
    part(l, 0.22, 0.04, 0.26, 0x1a1410, 0, -0.62, 0);
    part(l, 0.06, 0.06, 0.02, 0x8a9098, 0, -0.36, -0.10); // buckle
    return l;
  },
  // ---------------------------------------------------------------- HEXTECH GREAVES
  (r, x, _c, dark) => { // grevas de metal com juntas douradas
    const l = limb(r, 0.17, 0.5, 0.17, 0x3a4a5a, x, HIP);
    part(l, 0.20, 0.14, 0.20, 0x3a4a5a, 0, -0.1, 0);     // knee
    part(l, 0.20, 0.05, 0.20, 0xd8a23a, 0, -0.18, 0);    // gold trim
    part(l, 0.19, 0.10, 0.19, 0xd8a23a, 0, -0.36, 0);    // gold band
    part(l, 0.20, 0.12, 0.24, 0x3a4a5a, 0, -0.54, 0);    // boot
    glow(l, 0.04, 0.04, 0.02, 0x4ad8ff, 0, -0.28, -0.10); // gem
    return l;
  },
  // ---------------------------------------------------------------- BENDER ROLLERS
  (r, x, _c, dark) => { // pernas metálicas com rodas de tanque
    const l = limb(r, 0.16, 0.5, 0.16, 0x9aa0a8, x, HIP);
    part(l, 0.18, 0.16, 0.18, 0x3a3f48, 0, -0.1, 0);
    part(l, 0.20, 0.12, 0.24, 0x3a3f48, 0, -0.44, 0);
    const wheel = cyl(l, 0.10, 0.10, 0.06, 0x1a1e24, 0, -0.54, 0, 12);
    wheel.rotation.z = Math.PI / 2;
    cyl(l, 0.04, 0.04, 0.07, 0x6a7078, 0, -0.54, 0, 8).rotation.z = Math.PI / 2;
    part(l, 0.04, 0.10, 0.04, 0x9aa0a8, 0, -0.48, 0);
    return l;
  },
  // ---------------------------------------------------------------- CORVO BOOTS
  (r, x, _c, dark) => { // botas de couro com fivelas, cano alto
    const l = limb(r, 0.17, 0.5, 0.17, 0x2a1e14, x, HIP);
    part(l, 0.18, 0.06, 0.18, 0x1a1410, 0, -0.42, 0);
    part(l, 0.20, 0.08, 0.20, 0x3a2a1a, 0, -0.06, 0);    // folded cuff
    for (let k = 0; k < 2; k++) part(l, 0.06, 0.04, 0.02, 0x8a9098, 0, -0.44 - k * 0.14, -0.10); // buckles
    part(l, 0.20, 0.14, 0.24, 0x2a1e14, 0, -0.54, 0);
    part(l, 0.22, 0.04, 0.26, 0x0a0806, 0, -0.62, 0);
    return l;
  },
  // ---------------------------------------------------------------- VIVI BOOTS
  (r, x, _c, dark) => { // botas de mestre com bicos longos e dobra dourada
    const l = limb(r, 0.16, 0.5, 0.16, 0x4a3a6a, x, HIP);
    part(l, 0.18, 0.06, 0.18, 0xd8a23a, 0, -0.42, 0);
    part(l, 0.18, 0.14, 0.22, 0x4a3a6a, 0, -0.52, 0);
    const toe = part(l, 0.14, 0.08, 0.18, 0x4a3a6a, 0, -0.56, -0.14);
    toe.rotation.x = -0.5;
    part(l, 0.14, 0.04, 0.22, 0x1a1410, 0, -0.62, 0);
    part(l, 0.04, 0.04, 0.02, 0xd8a23a, 0, -0.46, -0.10);
    return l;
  },
];

// ------------------------------------------------------------------ mouths
// Every head talks like a puppet: the whole head is a lid hinged at the back
// of its base. When the player speaks it flips up, showing a red mouth with a
// tongue and teeth, and snaps shut between syllables. It is built from the
// head's own shape, so every face gets it without any per-face work.

/** How far the head flips open at full volume (radians; 0.7 = about 40 degrees). */
export const MOUTH_OPEN = 0.7;
const MOUTH_RED = 0x5a0f18, PALATE = 0x3a0a10, TONGUE = 0xd2506a, TOOTH = 0xf4f0e0;

export interface MouthRig {
  lid: THREE.Group; // the hinged head
  jaw: THREE.Group; // lower mouth (stays put), grows as the mouth opens
  palate: THREE.Group; // roof of the mouth and upper teeth, under the lid
  open: number; // 0..1, smoothed
}

/**
 * Wrap a freshly built head (`face`, in neck space) in a hinge and add the
 * inside of the mouth. Returns the rig; `head` ends up holding lid + jaw.
 */
function rigMouth(head: THREE.Group, face: THREE.Group): MouthRig {
  // Where is the bottom of this head? Measure the real geometry.
  face.updateMatrixWorld(true);
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  face.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone());
  });
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  if (!pts.length) { minY = 0; maxY = 0.46; }
  // The lower half of the head: round and pointy-chinned heads have almost no
  // base, so the hinge and the mouth are sized from here, not from the very bottom.
  const band = minY + Math.max(0.06, (maxY - minY) * 0.5);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.y > band) continue;
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  if (!(x1 > x0)) { x0 = -0.2; x1 = 0.2; z0 = -0.2; z1 = 0.2; }
  // Keep the mouth a sensible size whatever the head (a ball head has a tiny base).
  const w = Math.min(0.5, Math.max(0.26, (x1 - x0) * 0.8));
  const d = Math.min(0.46, Math.max(0.24, (z1 - z0) * 0.8));
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const front = cz - d / 2; // -Z is the front

  // The hinge: back edge of the base. The head is moved so it pivots there.
  const lid = new THREE.Group();
  lid.position.set(0, minY, z1);
  face.position.set(0, -minY, -z1);
  lid.add(face);
  head.add(lid);

  const teeth = (parent: THREE.Object3D, y: number, z: number, h: number) => {
    const n = Math.max(3, Math.round(w / 0.075));
    const tw = (w * 0.86) / n;
    for (let k = 0; k < n; k++) part(parent, tw * 0.72, h, 0.04, TOOTH, cx - (w * 0.86) / 2 + tw * (k + 0.5), y, z);
  };

  // Lower mouth: a red floor with a tongue and a row of teeth along the front.
  // Its origin is at the hinge height, so scaling it up from 0 grows it out of the base.
  const jaw = new THREE.Group();
  jaw.position.set(0, minY, 0);
  part(jaw, w, 0.05, d, MOUTH_RED, cx, -0.02, cz);
  part(jaw, w * 0.5, 0.035, d * 0.55, TONGUE, cx, 0.02, cz + d * 0.1).rotation.x = -0.08;
  teeth(jaw, 0.03, front + 0.03, 0.05);
  jaw.visible = false;
  head.add(jaw);

  // Upper mouth: the roof and the top teeth, hanging under the lid.
  const palate = new THREE.Group();
  palate.position.set(0, minY, 0);
  part(palate, w, 0.012, d, PALATE, cx, -0.007, cz);
  teeth(palate, -0.03, front + 0.03, 0.05);
  palate.visible = false;
  face.add(palate);

  return { lid, jaw, palate, open: 0 };
}

/**
 * Open the mouth by `level` (0 = closed, 1 = as wide as it goes): the voice's
 * loudness right now. Opens fast and shuts a little slower, so the mouth snaps
 * open on every syllable and flaps through a sentence, Muppet style.
 */
export function animateMouth(m: MouthRig, level: number, dt: number): void {
  const target = Math.max(0, Math.min(1, level));
  m.open += (target - m.open) * Math.min(1, dt * (target > m.open ? 38 : 13));
  if (m.open < 0.004) m.open = 0;
  m.lid.rotation.x = m.open * MOUTH_OPEN;
  const shown = m.open > 0.03;
  m.jaw.visible = m.palate.visible = shown;
  const s = Math.max(0.001, Math.min(1, m.open * 2.5));
  m.jaw.scale.y = m.palate.scale.y = s;
}

/** How many options exist per slot (must match config/looks.ts; checked by a test). */
export const LOOK_COUNTS = [FACE_BUILDERS.length, TORSO_BUILDERS.length, LEG_BUILDERS.length];

export function buildCharacter(color: number, look: readonly number[] = [0, 0, 0]): CharacterView {
  const c = new THREE.Color(color);
  const dark = c.clone().multiplyScalar(0.45).getHex();
  const light = c.clone().lerp(new THREE.Color(0xffffff), 0.25).getHex();
  const pick = <T>(list: T[], n: number): T => list[Number.isInteger(n) && n >= 0 && n < list.length ? n : 0];

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const leg = pick(LEG_BUILDERS, look[2]);
  const legL = leg(root, -0.13, color, dark, -1);
  const legR = leg(root, 0.13, color, dark, 1);

  const torsoFrom = body.children.length;
  pick(TORSO_BUILDERS, look[1])(body, color, light, dark);
  const torso = body.children.slice(torsoFrom);
  const armL = limb(body, 0.13, 0.52, 0.13, dark, -0.34, 1.3);
  const armR = limb(body, 0.13, 0.52, 0.13, dark, 0.34, 1.3);
  armR.rotation.x = 1.25; // right arm points forward, holding the weapon

  const head = new THREE.Group();
  head.position.set(0, 1.33, 0);
  body.add(head);
  const face = new THREE.Group();
  pick(FACE_BUILDERS, look[0])(face, color, light, dark);
  const mouth = rigMouth(head, face);

  // Everything built so far flies apart when the player dies.
  const parts: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) parts.push(o); });

  // Wounds come after, so their little pieces never fly off on their own.
  // Which arm and leg go first differs between players (their colour decides).
  const wounds = buildWounds({ root, torso, body, armL, armR, legL, legR, face }, (color >> 4) & 1 ? 1 : -1);

  // A soft dark disc instead of real shadows: cheap, and it reads well at low resolution.
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10), SHADOW_MAT);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  root.add(shadow);

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
  label.position.y = 2.25;
  label.visible = false;
  root.add(label);

  const hand = new THREE.Group();
  hand.position.set(0.34, 1.12, -0.5);
  body.add(hand);
  const hand2 = new THREE.Group();
  hand2.position.set(-0.34, 1.12, -0.5);
  body.add(hand2);

  return {
    root, body, head, mouth, wounds, legL, legR, armL, armR, hand, hand2, shadow, label, name: '',
    parts, look: look.join(), phase: 0, weapon: null, weapon2: null,
  };
}

const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false });

export interface CharAnim {
  speed: number;
  grounded: boolean;
  crouched: boolean;
  sliding: boolean;
  pitch: number;
  celebrate?: boolean; // match winner: arms up, bouncing
  dual?: boolean; // a weapon in each hand: the left arm points forward too
  talk?: number; // 0..1: how loud this player's voice is right now (opens the mouth)
  health?: number; // 0..100: the lower, the more wounds show (default: none)
}

export function animateCharacter(v: CharacterView, a: CharAnim, dt: number): void {
  animateMouth(v.mouth, a.talk ?? 0, dt);
  showWounds(v.wounds, a.health ?? 100, dt);
  v.phase += a.speed * dt * 1.7;
  const k = Math.min(1, dt * 14);
  let legL = 0, legR = 0;
  if (a.sliding) { legL = 1.2; legR = 0.9; }
  else if (!a.grounded) { legL = 0.7; legR = -0.4; }
  else {
    const amp = Math.min(1, a.speed / 7) * 0.9;
    legL = Math.sin(v.phase) * amp;
    legR = -legL;
  }
  v.legL.rotation.x += (legL - v.legL.rotation.x) * k;
  v.legR.rotation.x += (legR - v.legR.rotation.x) * k;
  v.armL.rotation.x += ((a.dual ? 1.25 : -legL * 0.8) - v.armL.rotation.x) * k;
  // Crouching squashes the upper body down onto the legs.
  const squash = a.crouched ? 0.6 : 1;
  v.body.scale.y += (squash - v.body.scale.y) * k;
  const legScale = a.crouched ? 0.55 : 1;
  v.legL.scale.y += (legScale - v.legL.scale.y) * k;
  v.legR.scale.y = v.legL.scale.y;
  v.legL.position.y = v.legR.position.y = 0.72 * v.legL.scale.y;
  v.body.position.y = -0.72 * (1 - v.legL.scale.y) * 0.6;
  v.body.rotation.x += ((a.sliding ? 0.45 : 0) - v.body.rotation.x) * k;
  v.head.rotation.x = a.pitch * 0.7;
  if (a.celebrate) {
    v.phase += dt * 9;
    const wave = Math.sin(v.phase);
    v.armL.rotation.x = 2.8 + wave * 0.35;
    v.armR.rotation.x = 2.8 - wave * 0.35;
    v.armL.rotation.z = -0.35; v.armR.rotation.z = 0.35;
    v.body.position.y += Math.abs(Math.sin(v.phase * 0.5)) * 0.22;
    v.head.rotation.x = -0.25;
    v.head.rotation.z = wave * 0.15;
  } else if (v.armL.rotation.z !== 0) {
    v.armL.rotation.z = v.armR.rotation.z = v.head.rotation.z = 0;
    v.armR.rotation.x = 1.25;
  }
}
