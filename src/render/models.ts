import * as THREE from 'three';
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
];

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

  pick(TORSO_BUILDERS, look[1])(body, color, light, dark);
  const armL = limb(body, 0.13, 0.52, 0.13, dark, -0.34, 1.3);
  const armR = limb(body, 0.13, 0.52, 0.13, dark, 0.34, 1.3);
  armR.rotation.x = 1.25; // right arm points forward, holding the weapon

  const head = new THREE.Group();
  head.position.set(0, 1.33, 0);
  body.add(head);
  pick(FACE_BUILDERS, look[0])(head, color, light, dark);

  // Everything built so far flies apart when the player dies.
  const parts: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) parts.push(o); });

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
    root, body, head, legL, legR, armL, armR, hand, hand2, shadow, label, name: '',
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
}

export function animateCharacter(v: CharacterView, a: CharAnim, dt: number): void {
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
