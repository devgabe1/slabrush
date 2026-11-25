import * as THREE from 'three';
import type { Icon } from '../maps/editor';
import { EDITOR_PALETTES } from '../maps/editor';
import type { MatId, Palette, Solid } from '../sim/map';
import { buildSolidMesh } from './mapMesh';
import { buildCharacter, buildWeaponModel } from './models';
import { makeMaterials } from './textures';

// Pictures of what can be placed in the map editor (its inventory and
// hotbar): each thing built from the game's own models and textures, seen
// from above at three quarters, framed to fit. Rendered once each with a
// small offscreen renderer and kept as data URLs.

const SIZE = 112;

export class ItemThumbs {
  private renderer: THREE.WebGLRenderer | null = null;
  private failed = false;
  private cache = new Map<string, string>();
  private mats = new Map<Palette, Record<MatId, THREE.Material>>();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);

  /** A picture of `icon`, with the materials of `palette` (a data URL; '' if WebGL is not to be had). */
  picture(icon: Icon, palette: Palette): string {
    const key = JSON.stringify(icon) + (icon.kind === 'solid' || icon.kind === 'look' ? EDITOR_PALETTES.indexOf(palette) + JSON.stringify(palette.mats) : '');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const r = this.ensure();
    if (!r) return '';
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404050, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const obj = this.build(icon, icon.kind === 'look' ? EDITOR_PALETTES[icon.palette] : palette, scene);
    scene.add(obj);
    // frame it: from the front right, above, far enough back that all of it fits
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const dist = radius / Math.sin((this.camera.fov / 2) * Math.PI / 180) * 1.02;
    this.camera.position.copy(c).add(new THREE.Vector3(0.62, icon.kind === 'weapon' ? 0.35 : 0.55, 0.85).normalize().multiplyScalar(dist));
    this.camera.lookAt(c);
    r.setClearColor(0x000000, 0);
    r.render(scene, this.camera);
    const url = r.domElement.toDataURL('image/png');
    obj.traverse((o) => { if (o instanceof THREE.Mesh && !(o.userData.shared)) o.geometry.dispose(); });
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, url);
    return url;
  }

  private materials(p: Palette): Record<MatId, THREE.Material> {
    let m = this.mats.get(p);
    if (!m) this.mats.set(p, (m = makeMaterials(p, 1)));
    return m;
  }

  /** The palette with iron in it (for spikes), one per palette so its materials are made once. */
  private withIron(p: Palette): Palette {
    if (p.mats.iron) return p;
    let q = this.iron.get(p);
    if (!q) this.iron.set(p, (q = { ...p, mats: { ...p.mats, iron: '#5a5c62' } }));
    return q;
  }
  private iron = new Map<Palette, Palette>();

  private solid(s: Solid, p: Palette): THREE.Mesh {
    const mesh = buildSolidMesh(s, this.materials(p));
    mesh.userData.shared = false;
    return mesh;
  }

  private build(icon: Icon, p: Palette, scene: THREE.Scene): THREE.Object3D {
    const g = new THREE.Group();
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MatId, ramp = false): Solid =>
      ramp ? { type: 'ramp', min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, high: '-z', mat, surface: 'normal' }
        : { type: 'box', min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, mat, surface: 'normal' };
    const glow = (w: number, h: number, d: number, color: number, opacity = 1) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
    const floor = () => this.solid(box(-1.4, -0.3, -1.4, 1.4, 0, 1.4, p.mats.concrete ? 'concrete' : 'stone'), p);
    switch (icon.kind) {
      case 'solid': {
        const [w, h, d] = icon.size;
        g.add(this.solid(box(-w / 2, 0, -d / 2, w / 2, h, d / 2, icon.mat, icon.ramp), p));
        break;
      }
      case 'spikes': {
        const ip = this.withIron(p);
        for (let x = -0.55; x <= 0.56; x += 1.1) {
          for (let z = -0.55; z <= 0.56; z += 1.1) {
            g.add(this.solid(box(x - 0.13, 0, z - 0.13, x + 0.13, 0.6, z + 0.13, 'iron'), ip));
            g.add(this.solid(box(x - 0.06, 0.6, z - 0.06, x + 0.06, 0.9, z + 0.06, 'iron'), ip));
          }
        }
        g.add(this.solid(box(-1.1, -0.2, -1.1, 1.1, 0, 1.1, 'concrete'), p));
        break;
      }
      case 'weapon': {
        if (icon.weapon === 'random') {
          const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: questionMark(), transparent: true }));
          q.lookAt(0.62, 0.55, 0.85);
          g.add(q);
        } else {
          const m = buildWeaponModel(icon.weapon);
          m.rotation.y = Math.PI / 2; // (side on: the barrel across the picture)
          g.add(m);
        }
        break;
      }
      case 'spawn': {
        const c = buildCharacter(0x3aa6e8);
        c.shadow.visible = c.label.visible = c.hand.visible = c.hand2.visible = false;
        c.root.rotation.y = 0.5;
        g.add(c.root, floor());
        break;
      }
      case 'pad': {
        g.add(floor());
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.1, 0.12, 12), new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.04, 12), new THREE.MeshBasicMaterial({ color: 0xffd23a }));
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 4), new THREE.MeshBasicMaterial({ color: 0xff8a1a }));
        plate.position.y = 0.06; top.position.y = 0.13; arrow.position.y = 0.75;
        g.add(plate, top, arrow);
        break;
      }
      case 'zone': {
        g.add(floor());
        const cube = icon.dark ? glow(2.4, 2.2, 2.4, 0x07060c, 0.92) : glow(2.4, 2.2, 2.4, 0x5ab4ff, 0.32);
        cube.position.y = 1.1;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, 2.2, 2.4)), new THREE.LineBasicMaterial({ color: icon.dark ? 0xb06aff : 0x9ad8ff }));
        edges.position.y = 1.1;
        g.add(cube, edges);
        if (!icon.dark) { const c = buildCharacter(0xe8503a); c.shadow.visible = c.label.visible = c.hand.visible = c.hand2.visible = false; c.root.scale.setScalar(0.6); c.root.position.y = 0.9; g.add(c.root); } // someone floating up in it
        break;
      }
      case 'marker': {
        const color = icon.which === 'start' ? 0xffffff : icon.which === 'checkpoint' ? 0x3aff8a : 0xffd23a;
        g.add(this.solid(box(-1.3, -0.3, -1.3, 1.3, 0, 1.3, p.mats.tile ? 'tile' : 'concrete'), p));
        const fill = glow(2.6, 1.6, 2.6, color, 0.22);
        fill.position.y = 0.8;
        g.add(fill);
        for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) { const b = glow(0.08, 2.4, 0.08, color); b.position.set(x, 1.2, z); g.add(b); }
        break;
      }
      case 'look': {
        // a corner of a map in that look: a floor, a block, a ramp, its sky behind
        scene.background = new THREE.Color(p.sky);
        const m: MatId = p.mats.grass ? 'grass' : p.mats.sand ? 'sand' : p.mats.panel ? 'panel' : 'concrete';
        const b: MatId = p.mats.stone ? 'stone' : p.mats.glass ? 'glass' : 'concreteDark';
        g.add(this.solid(box(-2, -0.4, -2, 2, 0, 2, m), p), this.solid(box(-1.6, 0, -1.6, -0.2, 1.4, -0.2, b), p), this.solid(box(0.2, 0, -1.6, 1.6, 0.8, 0.2, p.mats.tile ? 'tile' : m, true), p));
        break;
      }
    }
    return g;
  }

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setSize(SIZE, SIZE, false);
    } catch {
      this.failed = true; // no WebGL to spare: the inventory shows names only
    }
    return this.renderer;
  }
}

/** A big question mark, for a RANDOM weapon spot. */
let qm: THREE.CanvasTexture | null = null;
function questionMark(): THREE.CanvasTexture {
  if (qm) return qm;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e8c63a';
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', 32, 36);
  qm = new THREE.CanvasTexture(c);
  qm.colorSpace = THREE.SRGBColorSpace;
  return qm;
}
