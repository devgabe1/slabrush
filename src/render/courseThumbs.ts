import * as THREE from 'three';
import type { Course } from '../maps/parkour';
import { MapExtras } from './mapExtras';
import { buildMapMesh } from './mapMesh';
import { makeMaterials } from './textures';

// Pictures of the parkour courses, for the menus: each course seen from just
// behind its start, looking out along it, under its own sky. Rendered in code
// like everything else, with a small offscreen renderer, one course per idle
// moment (building a course's meshes takes a little while), and kept as data
// URLs.

const W = 480, H = 270;

export class CourseThumbs {
  private cache = new Map<string, string>();
  private queue: Course[] = [];
  private renderer: THREE.WebGLRenderer | null = null;
  private failed = false;
  /** Called when a course's picture is ready. */
  onReady: (id: string) => void = () => {};

  /** The picture of a course, or null while it is still being made (or cannot be). */
  picture(id: string): string | null {
    return this.cache.get(id) ?? null;
  }

  /** Make every course's picture, one at a time, when the page has a moment. */
  warm(courses: readonly Course[]): void {
    this.queue.push(...courses.filter((c) => !this.cache.has(c.id) && !this.queue.includes(c)));
    this.next();
  }

  private next(): void {
    if (!this.queue.length || this.failed) { this.release(); return; }
    const later = (fn: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
    later(() => {
      const c = this.queue.shift();
      if (!c) return;
      const url = this.render(c);
      if (url) { this.cache.set(c.id, url); this.onReady(c.id); }
      this.next();
    });
  }

  private render(c: Course): string | null {
    const r = this.ensure();
    if (!r) return null;
    const map = c.map, pal = map.palette;
    const scene = new THREE.Scene();
    scene.background = skyGradient(pal.sky);
    scene.fog = new THREE.Fog(pal.sky, pal.fogNear, pal.fogFar * 1.15);
    scene.add(new THREE.HemisphereLight(pal.ambientSky, pal.ambientGround, 1.6));
    const sun = new THREE.DirectionalLight(pal.sun, 2.2);
    sun.position.set(0.45, 1, 0.3);
    scene.add(sun);
    const mats = makeMaterials(pal, map.seed);
    const group = buildMapMesh(map, mats);
    const extras = new MapExtras(map, mats);
    extras.update(240, 4);
    scene.add(group, extras.group);
    // From behind the start and above it, looking out along the first stretch of the course.
    const s = map.spawns[0], fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const camera = new THREE.PerspectiveCamera(62, W / H, 0.1, 900);
    camera.position.set(s.pos.x - fx * 16, s.pos.y + 10, s.pos.z - fz * 16);
    camera.lookAt(s.pos.x + fx * 48, s.pos.y - 2, s.pos.z + fz * 48);
    let url: string | null = null;
    try {
      r.render(scene, camera);
      url = r.domElement.toDataURL('image/jpeg', 0.86);
    } catch {
      url = null;
    }
    // Let it all go again: the picture is all we keep.
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    extras.dispose();
    for (const m of Object.values(mats)) {
      const map2 = (m as THREE.MeshBasicMaterial).map;
      map2?.dispose();
      m.dispose();
    }
    (scene.background as THREE.Texture).dispose();
    return url;
  }

  private ensure(): THREE.WebGLRenderer | null {
    if (this.renderer) return this.renderer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setSize(W, H, false);
      return this.renderer;
    } catch {
      this.failed = true; // no WebGL to spare: the menus show the course names only
      return null;
    }
  }

  /** Done for now: give the GPU context back. */
  private release(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer = null;
  }
}

/** A sky for the picture: the palette's colour at the horizon, deepening upwards. */
function skyGradient(sky: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const ctx = c.getContext('2d')!;
  const base = new THREE.Color(sky), top = base.clone().offsetHSL(0.03, 0.1, -0.2);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#' + top.getHexString());
  g.addColorStop(1, '#' + base.getHexString());
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
