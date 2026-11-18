import * as THREE from 'three';
import { animateMouth, buildCharacter, type CharacterView } from './models';

// The heads on the hold-Tab scoreboard: every player's real head, live, turning
// slowly on the spot, its mouth flapping when they talk on voice. One small
// offscreen renderer draws each head in turn and copies it into that row's
// <canvas>. Only runs while the scoreboard is open.

const SIZE = 128; // pixels rendered (shown at about half that: crisp on high-DPI screens)
/** Head height to aim at, and how much fits in view (room for the open mouth too). */
const AIM_Y = 1.62, SPAN = 1.05;

export interface PortraitRow {
  id: number;
  color: number;
  look: number[];
  alive: boolean;
  canvas: HTMLCanvasElement;
}

export class HeadPortraits {
  private renderer: THREE.WebGLRenderer | null = null;
  private failed = false;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private heads = new Map<number, { key: string; c: CharacterView }>();
  private time = 0;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404050, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-1.5, 2.5, -2);
    this.scene.add(sun);
    const dist = SPAN / 2 / Math.tan((this.camera.fov / 2) * Math.PI / 180);
    const dir = new THREE.Vector3(0, 0.12, -1).normalize(); // in front of the face (front is -Z), a touch above
    this.camera.position.set(dir.x * dist, AIM_Y + dir.y * dist, dir.z * dist);
    this.camera.lookAt(0, AIM_Y, 0);
  }

  /** Draw every row's head. `talk` = how loud each player's voice is right now (0..1). */
  draw(rows: PortraitRow[], talk: (id: number) => number, dt: number): void {
    const r = this.ensure();
    if (!r) return;
    this.time += dt;
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const c = this.head(row);
      // Each head turns at its own phase so they never all face the same way; the
      // dead spin slowly, tipped over on their side.
      const t = this.time + row.id * 1.3;
      c.root.rotation.set(0, row.alive ? t * 1.5 : t * 0.5, 0);
      c.head.rotation.z = row.alive ? 0 : 0.55; // tipped over at the neck
      c.root.position.y = row.alive ? Math.sin(t * 2.4) * 0.025 : -0.08;
      animateMouth(c.mouth, row.alive ? talk(row.id) : 0, dt);
      this.scene.add(c.root);
      r.render(this.scene, this.camera);
      this.scene.remove(c.root);
      const ctx = row.canvas.getContext('2d');
      if (!ctx) continue;
      ctx.clearRect(0, 0, row.canvas.width, row.canvas.height);
      ctx.drawImage(r.domElement, 0, 0, row.canvas.width, row.canvas.height);
    }
    for (const id of [...this.heads.keys()]) if (!seen.has(id)) this.heads.delete(id);
  }

  /** Forget every head (a new session). */
  clear(): void {
    this.heads.clear();
  }

  /** A whole character with everything but the head hidden, so it turns about its own axis. */
  private head(row: PortraitRow): CharacterView {
    const key = `${row.look.join()}|${row.color}`;
    const hit = this.heads.get(row.id);
    if (hit && hit.key === key) return hit.c;
    const c = buildCharacter(row.color, row.look);
    c.legL.visible = c.legR.visible = c.shadow.visible = c.label.visible = false;
    for (const part of c.body.children) part.visible = part === c.head;
    this.heads.set(row.id, { key, c });
    return c;
  }

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setSize(SIZE, SIZE, false);
      this.renderer.setClearColor(0x000000, 0);
    } catch {
      this.failed = true; // no WebGL to spare: the scoreboard shows colours instead of heads
    }
    return this.renderer;
  }
}
