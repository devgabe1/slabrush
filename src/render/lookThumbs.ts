import * as THREE from 'three';
import { LOOK_PARTS } from '../config/looks';
import { buildCharacter } from './models';

// Pictures for the character screen: one small portrait per option of a body
// part (every face, every torso, every pair of legs), each worn by the
// player's current character so they can see it in context. Rendered once per
// outfit with a small offscreen renderer and handed out as data URLs.

const SIZE = 144; // pixels (drawn at about half that, so they stay crisp on high-DPI screens)

/**
 * Where the camera looks for each part: [centre height, how much of the body
 * fits in view, viewing direction]. Torsos are seen from further round the
 * side so things worn on the back (backpack, jetpack, cape) show as well.
 */
const FRAME: [y: number, span: number, dir: [number, number, number]][] = [
  [1.56, 0.78, [0.45, 0.18, -1]], // face: the head, three-quarter front
  [1.0, 1.1, [1, 0.22, -0.6]], // torso: chest to hips, from the side (arms hidden)
  [0.42, 1.0, [0.45, 0.18, -1]], // legs: hips to feet
];

export class LookThumbs {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private cache = new Map<string, string[]>();

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404050, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-1.5, 2.5, -2);
    this.scene.add(sun);
  }

  /** Data URLs, one per option of `part` (0 face, 1 torso, 2 legs), worn with the rest of `look`. */
  pictures(part: number, look: readonly number[], color: number): string[] {
    const others = look.map((v, i) => (i === part ? '*' : v)).join(',');
    const key = `${part}|${others}|${color}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = this.ensure();
    if (!r) return [];
    const [y, span, d] = FRAME[part];
    const dist = span / 2 / Math.tan((this.camera.fov / 2) * Math.PI / 180);
    const dir = new THREE.Vector3(...d).normalize();
    this.camera.position.set(dir.x * dist, y + dir.y * dist, dir.z * dist);
    this.camera.lookAt(0, y, 0);
    const out: string[] = [];
    for (let i = 0; i < LOOK_PARTS[part].length; i++) {
      const l = [...look];
      l[part] = i;
      const c = buildCharacter(color, l);
      c.shadow.visible = c.label.visible = c.hand.visible = c.hand2.visible = false;
      if (part === 1) c.armL.visible = c.armR.visible = false; // they would cover the chest
      this.scene.add(c.root);
      r.render(this.scene, this.camera);
      out.push(r.domElement.toDataURL('image/png'));
      this.scene.remove(c.root);
    }
    if (this.cache.size > 24) this.cache.clear(); // outfits change one part at a time: keep it small
    this.cache.set(key, out);
    return out;
  }

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer) return this.renderer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setSize(SIZE, SIZE, false);
      this.renderer.setClearColor(0x000000, 0);
      return this.renderer;
    } catch {
      return null; // no WebGL to spare: the menu shows names only
    }
  }
}
