import * as THREE from 'three';
import type { Vec3 } from '../core/vec';
import { AIM, BIKE, PLAYER } from '../config/game';
import { WEAPONS, type WeaponId } from '../config/weapons';
import type { SimView } from '../net/session';
import { HOLD_CENTRE, aimDir, isDual } from '../sim/game';
import { specialIn } from '../sim/pmove';
import { Beams } from './beams';
import type { MapDef } from '../sim/map';
import type { Player } from '../sim/types';
import { Effects } from './effects';
import { MapExtras } from './mapExtras';
import { buildMapMesh } from './mapMesh';
import { animateCharacter, animateJetHammer, animateKiOrb, animateKiPickup, animateBike, animateSixSeven, buildCharacter, buildProjectileModel, buildTank, buildWeaponModel, flatMat, setLabel, type CharacterView } from './models';
import { RetroPass, type RetroMode } from './retroPass';
import { makeMaterials, setAnisotropy } from './textures';
import { ViewModel } from './viewmodel';

interface PickupView {
  group: THREE.Group;
  model: THREE.Group;
  base: THREE.Mesh;
  pillar: THREE.Mesh | null; // legendaries: a column of light, visible from across the map
}

export interface ViewState {
  yaw: number;
  pitch: number;
  mouseDX: number;
  mouseDY: number;
}

/**
 * Whose eyes we look through.
 *  first    - the local player (or their death camera)
 *  spectate - first person of another player (you are dead, the round goes on)
 *  orbit    - circling a player from outside (the match winner's lap of honour)
 *  head     - the local player just died: the view is their head, knocked off and tumbling
 */
export interface CamMode {
  mode: 'first' | 'spectate' | 'orbit' | 'head'; // head: you just died, and you ARE your flying head
  target: number;
}

/** projectiles that leave a smoke trail */
const SMOKY = new Set<WeaponId>(['postman', 'lobber', 'bigone', 'pinata']);
const SUN_DIR = new THREE.Vector3(-0.6, 0.5, 0.4).normalize();
const lerp3 = (a: number, b: number, t: number) => a + (b - a) * t;

/** Draws the simulation state. Reads the sim, never writes to it. */
export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(100, 1, 0.05, 700);
  vm = new ViewModel();
  fx: Effects;
  private beams: Beams;
  shake = 0;
  private specId = -1; // whose hands are in the viewmodel while spectating
  private specYaw = 0;
  private specPitch = 0;
  /** 0 disables screen shake, 1 is the default (Settings). */
  shakeScale = 1;

  private mapGroup: THREE.Group | null = null;
  /** Wall slides: where each sliding player's wall is (its normal and the contact point), and when that was checked (s). */
  private walls = new Map<number, { n: THREE.Vector3 | null; at: THREE.Vector3; t: number }>();
  /** First person: how far the camera is tilted away from a wall we slide down (eased). */
  private wallRoll = 0;
  /** Name tags: whether each player was in sight at the last check, and when that was (s). */
  private sight = new Map<number, { seen: boolean; at: number }>();
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.6);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private chars = new Map<number, CharacterView>();
  private pickupViews = new Map<number, PickupView>();
  private broomViews = new Map<number, THREE.Object3D>(); // SKYSWEEPER: each rider's broom, on their character
  private bikeViews = new Map<number, { pivot: THREE.Group; model: THREE.Object3D; lift: number; roll: number }>(); // SLABRIDER: each rider's bike
  private kiBlend = new Map<number, number>(); // KI BLAST: each player's eased firing pose (0..1)
  private projViews = new Map<number, THREE.Object3D>();
  private eyeH = PLAYER.eyeHeight;
  private smoothY = 0;
  private fovKick = 0;
  // SLABRIDER wheelie, on a spring (it overshoots as the front pops up, bounces as it slams down).
  private wheelieLift = 0;
  private wheelieVel = 0;
  private wheelieOn = false;
  // SLABRIDER: thrown off a wheelie, each player's tumble (when it started, by our clock).
  private tumbles = new Map<number, number>();
  /** How far round a tumble has rolled `e` seconds in: two backward somersaults, slowing, ending upright. */
  private static tumbleAngle(e: number): number {
    const x = Math.min(1, e / BIKE.tumble);
    return x >= 1 ? 0 : Math.PI * 4 * (1 - (1 - x) * (1 - x));
  }
  /** 0..1: how far into aiming the view is (eases in and out). */
  private aimT = 0;
  /** 0..1: how much of the screen the sniper scope covers; the HUD draws the reticle with it. */
  scope = 0;
  private scopeFov = 0; // the scope of the weapon being aimed (kept while easing out)
  /** Current field of view relative to the normal one (aiming / scoping zooms in); scales mouse sensitivity. */
  zoom = 1;
  private baseFov = 100;
  private scale = 0.5;
  private time = 0;
  private extras: MapExtras | null = null;
  private skyColor = new THREE.Color();
  private sunColor = new THREE.Color();
  private fogNear = 20;
  private fogFar = 120;
  private darkness = 0; // 0..1, eases in when the camera enters a dark area
  private tintColor = new THREE.Color(); // the haze of a tinted dark area
  private tinted = 0; // 0..1, how much of it
  private hazeFog: [number, number] | null = null; // its own fog distances, if any
  private night = new THREE.Color(0.035, 0.045, 0.11); // the sky in a tinted dark area
  private markers = new THREE.Group(); // map lab: spawn point markers
  private trailT = 0;
  private retro: RetroPass;
  /** Sky: a gradient dome and a sun disc that follow the camera. */
  private sky = new THREE.Group();
  private dome: THREE.Mesh;
  private sunDisc: THREE.Mesh;
  /** Sudden-death zone wall: a tall translucent ring, scaled to the zone radius. */
  private zoneMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 60, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff3a1e, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, fog: false }),
  );

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy())); // floors stay sharp far off
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.retro = new RetroPass(this.renderer);
    this.sun.position.copy(SUN_DIR);

    const domeGeo = new THREE.SphereGeometry(600, 20, 12);
    domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(domeGeo.attributes.position.count * 3), 3));
    this.dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -2;
    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(34, 20),
      new THREE.MeshBasicMaterial({ fog: false, depthWrite: false, transparent: true, opacity: 0.95 }),
    );
    this.sunDisc.position.copy(SUN_DIR).multiplyScalar(560);
    this.sunDisc.lookAt(0, 0, 0);
    this.sunDisc.renderOrder = -1;
    this.sky.add(this.dome, this.sunDisc);

    this.scene.add(this.hemi, this.sun, this.zoneMesh, this.sky);
    this.zoneMesh.visible = false;
    this.fx = new Effects(this.scene);
    this.beams = new Beams(this.scene);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Internal resolution = window size * scale; CSS stretches it back up, pixelated. */
  setRenderScale(scale: number): void {
    this.scale = scale;
    this.resize();
  }

  setFov(fov: number): void {
    this.baseFov = fov;
  }

  setRetro(mode: RetroMode): void {
    this.retro.mode = mode;
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const rw = Math.max(160, Math.round(w * this.scale)), rh = Math.max(90, Math.round(h * this.scale));
    this.renderer.setSize(rw, rh, false);
    this.retro.setSize(rw, rh);
    this.camera.aspect = this.vm.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.camera.updateProjectionMatrix();
  }

  setMap(map: MapDef): void {
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.MeshLambertMaterial;
          m.map?.dispose();
          m.dispose();
        }
      });
    }
    if (this.extras) {
      this.scene.remove(this.extras.group);
      this.extras.dispose();
    }
    this.clearEntities();
    this.setMarkers([]);
    const pal = map.palette;
    const mats = makeMaterials(pal, map.seed);
    this.mapGroup = buildMapMesh(map, mats);
    this.extras = new MapExtras(map, mats);
    this.extras.update(0, 0);
    this.scene.add(this.mapGroup, this.extras.group);
    this.skyColor.setHex(pal.sky);
    this.sunColor.setHex(pal.sun);
    this.fogNear = pal.fogNear;
    this.fogFar = pal.fogFar;
    this.darkness = 0;
    this.tinted = 0;
    this.hazeFog = null;
    this.scene.background = new THREE.Color(pal.sky);
    this.scene.fog = new THREE.Fog(pal.sky, pal.fogNear, pal.fogFar);
    this.hemi.intensity = 1.6;
    this.sun.intensity = 2.2;
    this.hemi.color.setHex(pal.ambientSky);
    this.hemi.groundColor.setHex(pal.ambientGround);
    this.sun.color.setHex(pal.sun);
    this.paintSky();
  }

  /** Horizon = fog colour (so distant geometry melts into it), deepening towards the zenith. */
  private paintSky(): void {
    const horizon = this.skyColor;
    const zenith = horizon.clone().offsetHSL(0.03, 0.1, -0.2);
    const below = horizon.clone().multiplyScalar(0.8);
    const pos = this.dome.geometry.attributes.position, col = this.dome.geometry.attributes.color;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / 600;
      if (t < 0) c.copy(horizon).lerp(below, Math.min(1, -t * 3));
      else c.copy(horizon).lerp(zenith, Math.pow(t, 0.55));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  /** Map lab: tall beacons at the given points (spawn positions). */
  setMarkers(points: { x: number; y: number; z: number }[]): void {
    this.markers.clear();
    if (!this.markers.parent) this.scene.add(this.markers);
    const geo = new THREE.BoxGeometry(0.25, 14, 0.25);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3aff6a, transparent: true, opacity: 0.55, fog: false });
    for (const p of points) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(p.x, p.y + 7, p.z);
      this.markers.add(m);
    }
  }

  /** Fade towards near-black fog and dim lights while the camera is in a dark area. */
  private applyDarkness(dt: number): void {
    const target = this.extras?.darkness(this.camera.position) ?? 0;
    this.darkness += (target - this.darkness) * Math.min(1, dt * 5);
    const k = this.darkness;
    const haze = this.extras?.haze(this.camera.position) ?? null;
    if (haze) { this.tintColor.setHex(haze.tint); this.hazeFog = haze.fog ?? null; }
    this.tinted += ((haze ? 1 : 0) - this.tinted) * Math.min(1, dt * 5);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.skyColor).multiplyScalar(1 - 0.94 * k).lerp(this.tintColor, this.tinted);
    (this.scene.background as THREE.Color).copy(fog.color);
    fog.near = this.fogNear * (1 - k) + 1.5 * k;
    fog.far = this.fogFar * (1 - k) + 17 * k;
    if (this.hazeFog) { // a haze with its own distances (an open void: see far, in the dark)
      fog.near += (this.hazeFog[0] - fog.near) * this.tinted;
      fog.far += (this.hazeFog[1] - fog.far) * this.tinted;
    }
    this.hemi.intensity = 1.6 * (1 - 0.75 * k);
    this.sun.intensity = 2.2 * (1 - 0.85 * k);
    (this.dome.material as THREE.MeshBasicMaterial).color.setScalar(1 - 0.94 * k).lerp(this.night, this.tinted);
    this.dome.visible = this.tinted < 0.98; // all the way into a tinted haze: no sky left, only its colour (and whatever shines in it)
    (this.sunDisc.material as THREE.MeshBasicMaterial).color.copy(this.sunColor).multiplyScalar((1 - k) * (1 - this.tinted));
    this.sky.position.copy(this.camera.position);
  }

  clearEntities(): void {
    this.beams.clear();
    for (const c of this.chars.values()) this.scene.remove(c.root);
    for (const p of this.pickupViews.values()) this.scene.remove(p.group);
    this.broomViews.clear(); // (they go with their characters)
    this.bikeViews.clear();
    for (const p of this.projViews.values()) this.scene.remove(p);
    this.chars.clear();
    this.pickupViews.clear();
    this.projViews.clear();
    this.fx.clear();
    this.zoneMesh.visible = false;
  }

  /** Put this player's weapons in the first-person hands. */
  private holdWeapons(p: Player): void {
    if (isDual(p)) this.vm.setWeapons(p.weapons[1]!.type, p.weapons[0]!.type); // right hand, left hand
    else this.vm.setWeapons(p.weapons[p.active]?.type ?? 'fists', null);
  }

  /**
   * Which side of this player the wall they slide down is on, as they face:
   * -1 left, 1 right (a wall dead ahead or behind counts as the right). Found
   * by feeling around at chest height against the map, ten times a second.
   */
  private wallSide(p: Player, feet: THREE.Vector3): number {
    let w = this.walls.get(p.id);
    if (!w || this.time - w.t > 0.1) {
      const targets: THREE.Object3D[] = [];
      if (this.mapGroup) targets.push(this.mapGroup);
      if (this.extras) targets.push(...this.extras.moverMeshes);
      const o = new THREE.Vector3(feet.x, feet.y + 1, feet.z);
      let best: THREE.Intersection | undefined;
      for (let i = 0; i < 8 && targets.length; i++) {
        const a = (i * Math.PI) / 4;
        this.ray.set(o, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
        this.ray.far = 1;
        const hit = this.ray.intersectObjects(targets, true)[0];
        if (hit?.face && Math.abs(hit.face.normal.y) < 0.5 && (!best || hit.distance < best.distance)) best = hit;
      }
      const n = best?.face ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : null;
      this.walls.set(p.id, (w = { n, at: best ? best.point.clone() : o, t: this.time }));
    }
    if (!w.n) return 0;
    // The wall is the other way from its normal; in the player's own frame (front -Z, right +X).
    const x = -w.n.x * Math.cos(p.yaw) + w.n.z * Math.sin(p.yaw);
    return x >= 0 ? 1 : -1;
  }

  /**
   * Can the camera see any of this player: head, chest or feet? Checked
   * against the map (walls, and doors and platforms where they are now) ten
   * times a second per player, not every frame.
   */
  private inSight(id: number, at: THREE.Vector3, crouched: boolean): boolean {
    const last = this.sight.get(id);
    if (last && this.time - last.at < 0.1) return last.seen;
    const targets: THREE.Object3D[] = [];
    if (this.mapGroup) targets.push(this.mapGroup);
    if (this.extras) targets.push(...this.extras.moverMeshes);
    const eye = this.camera.position;
    let seen = !targets.length;
    for (const up of crouched ? [1.0, 0.6, 0.2] : [1.6, 1.0, 0.2]) {
      const point = new THREE.Vector3(at.x, at.y + up, at.z);
      const dir = point.clone().sub(eye);
      const dist = dir.length();
      if (dist < 0.01) { seen = true; break; }
      this.ray.set(eye, dir.divideScalar(dist));
      this.ray.far = dist - 0.05;
      if (!this.ray.intersectObjects(targets, true).length) { seen = true; break; }
    }
    this.sight.set(id, { seen, at: this.time });
    return seen;
  }

  /** Where tracers of the local player (or the one you spectate) start: roughly the viewmodel muzzle. */
  muzzleWorld(hand = -1): THREE.Vector3 {
    return new THREE.Vector3(hand === 0 ? -0.2 : 0.18, -0.14, -0.7).applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }

  // ------------------------------------------------------- death camera
  /** How long the head camera flies before spectating takes over (it stays if there is nobody to watch). */
  static readonly HEAD_CAM_TIME = 2.6;
  private headCam: { pos: THREE.Vector3; vel: THREE.Vector3; rot: THREE.Quaternion; spin: THREE.Vector3; floorY: number; t: number } | null = null;
  /** Called when the flying head hits something, with how hard (m/s): the app plays a thud. */
  onHeadBonk: (speed: number) => void = () => {};

  /** True while the head camera should be shown (a few seconds after dying). */
  get headCamFlying(): boolean { return !!this.headCam && this.headCam.t < GameRenderer.HEAD_CAM_TIME; }
  get headCamExists(): boolean { return !!this.headCam; }

  /**
   * We died: the camera becomes our head, knocked off away from whoever did it
   * (or in our own direction of travel), tumbling, with a big shake.
   */
  startHeadCam(eye: Vec3, away: Vec3, vel: Vec3, floorY: number, yaw: number, pitch: number): void {
    const dir = new THREE.Vector3(away.x, 0, away.z);
    if (dir.lengthSq() < 1e-4) dir.set(-Math.sin(yaw), 0, -Math.cos(yaw)).negate(); // no killer: it pops off backwards
    dir.normalize();
    const v = dir.multiplyScalar(3.2 + Math.random());
    v.y = 6.5 + Math.random();
    v.x += vel.x * 0.5; v.z += vel.z * 0.5;
    this.headCam = {
      pos: new THREE.Vector3(eye.x, eye.y, eye.z), vel: v,
      rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
      spin: new THREE.Vector3((Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 2), (Math.random() - 0.5) * 3, (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 2)),
      floorY, t: 0,
    };
    this.shake += 3.2;
  }

  stopHeadCam(): void { this.headCam = null; }

  private static readonly HEAD_R = 0.22;
  private ray = new THREE.Raycaster();

  /** Fly / bounce / roll the head camera, colliding with the real map geometry. */
  private stepHeadCam(dt: number): void {
    const h = this.headCam!;
    h.t += dt;
    const steps = Math.ceil(dt / 0.01); // small steps so it never tunnels through a wall
    for (let k = 0; k < steps; k++) {
      const d = dt / steps;
      h.vel.y -= 20 * d;
      const from = h.pos.clone(), move = h.vel.clone().multiplyScalar(d), len = move.length();
      if (len > 1e-6 && this.mapGroup) {
        this.ray.set(from, move.clone().divideScalar(len));
        this.ray.far = len + GameRenderer.HEAD_R;
        const hit = this.ray.intersectObject(this.mapGroup, true)[0];
        if (hit && hit.face) {
          const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
          const into = h.vel.dot(n);
          if (into < 0) {
            h.pos.copy(hit.point).addScaledVector(n, GameRenderer.HEAD_R);
            h.vel.addScaledVector(n, -1.3 * into).multiplyScalar(0.55); // bounce, losing most of its energy
            h.spin.multiplyScalar(0.4);
            if (-into > 2) { this.shake += Math.min(1.6, -into * 0.12); this.onHeadBonk(-into); }
            continue;
          }
        }
      }
      h.pos.add(move);
      if (h.pos.y < h.floorY + GameRenderer.HEAD_R && h.vel.y < 0) { // the floor we died on, if the ray missed it
        h.pos.y = h.floorY + GameRenderer.HEAD_R;
        if (-h.vel.y > 2) { this.shake += Math.min(1.6, -h.vel.y * 0.12); this.onHeadBonk(-h.vel.y); }
        h.vel.y *= -0.3; h.vel.x *= 0.45; h.vel.z *= 0.45; h.spin.multiplyScalar(0.35);
      }
    }
    // Once it is down it rolls only a little: heavy friction on the floor.
    const down = h.pos.y <= h.floorY + GameRenderer.HEAD_R + 0.02 || h.vel.length() < 2;
    const slow = Math.exp(-dt * (down ? 9 : 0.4));
    h.spin.multiplyScalar(slow);
    if (down) { h.vel.x *= Math.exp(-dt * 9); h.vel.z *= Math.exp(-dt * 9); }
    const w = h.spin.length();
    if (w > 1e-4) h.rot.premultiply(new THREE.Quaternion().setFromAxisAngle(h.spin.clone().divideScalar(w), w * dt));
  }

  /** Blow a player's model apart. */
  /** Height of the floor under a point (the map's real geometry), or -Infinity over the void. */
  floorBelow(x: number, y: number, z: number): number {
    if (!this.mapGroup) return y;
    this.ray.set(new THREE.Vector3(x, y + 0.6, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = 60;
    const hit = this.ray.intersectObject(this.mapGroup, true)[0];
    return hit ? hit.point.y : -Infinity;
  }

  /**
   * Blow a player's model apart. The pieces and the head stay on the ground for
   * the rest of the round. Returns the floor height used (-Infinity over the void).
   */
  spawnCorpse(p: Player, voidDeath: boolean, headVel: Vec3 | null = null, keepHead = true): number {
    let view = this.chars.get(p.id);
    if (!view) {
      view = buildCharacter(p.color, p.look);
      view.root.position.set(p.pos.x, p.pos.y, p.pos.z);
      view.root.rotation.y = p.yaw;
    }
    // The pieces start where the body is DRAWN (other players are drawn slightly in the
    // past online), and land on the real floor under it, even if they died in mid-air.
    const at = view.root.position;
    const floorY = voidDeath ? -Infinity : this.floorBelow(at.x, at.y, at.z);
    const corpse = this.fx.newCorpse();
    view.root.visible = true;
    view.root.updateMatrixWorld(true);
    const head = view.head;
    const inHead = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q === head) return true; return false; };
    for (const part of view.parts) {
      if (inHead(part)) continue; // the head goes in one piece, below
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.4, Math.random() - 0.5).multiplyScalar(7);
      vel.x += p.vel.x * 0.5;
      vel.z += p.vel.z * 0.5;
      this.fx.debris(part, vel, floorY, corpse);
    }
    // The head flies off, whole and spinning, with a spurt from the neck.
    const neck = new THREE.Vector3();
    head.getWorldPosition(neck);
    if (keepHead) {
      const hv = headVel ? new THREE.Vector3(headVel.x, headVel.y, headVel.z)
        : new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(3.5).setY(6.5);
      const spin = new THREE.Vector3(Math.random() * 7 - 3.5, Math.random() * 4 - 2, Math.random() * 7 - 3.5);
      this.fx.debrisGroup(head, hv, spin, floorY, corpse);
    }
    this.fx.burst(neck, 0xa81818, 16, 4, 0.6, 0.07);
    this.fx.burst(neck, 0x7a0c0c, 8, 2.5, 0.8, 0.09);
    view.root.visible = false;
    return floorY;
  }

  private preview: CharacterView | null = null;
  /** Seconds into the preview's little remark after a change of outfit (Infinity = quiet). */
  private babble = Infinity;
  /** Your microphone level while the character screen is open (0..1), set by the app. */
  previewTalk = 0;
  private previewKey = '';
  /** Which way the preview faces (radians), and seconds since the player last turned it by hand. */
  private previewYaw = 0;
  private previewHeld = Infinity;

  /** The player is turning the preview with the mouse: by `radians`. It stops turning by itself for a while. */
  turnPreview(radians: number): void {
    this.previewYaw += radians;
    this.previewHeld = 0;
  }

  /** Customization screen: a walking, turning copy of the character beside the menu. null = none. */
  setPreview(look: readonly number[] | null, color = 0xe8503a): void {
    const key = look ? look.join() + color : '';
    if (key === this.previewKey) return;
    // A new part: the character says something about it.
    if (this.preview && look) this.babble = 0;
    this.previewKey = key;
    if (this.preview) this.camera.remove(this.preview.root);
    this.preview = null;
    if (!look) return;
    if (!this.camera.parent) this.scene.add(this.camera); // so things attached to the camera get drawn
    this.preview = buildCharacter(color, look);
    this.preview.shadow.visible = false;
    this.camera.add(this.preview.root);
  }

  /** Draw the frame, through the retro filter if it is on. */
  private present(drawVm: boolean): void {
    this.retro.begin();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (drawVm) {
      this.renderer.clearDepth();
      this.renderer.render(this.vm.scene, this.vm.camera);
    }
    this.retro.end();
  }

  /** Menu background: slow orbit around the map. */
  renderMenu(dt: number): void {
    this.time += dt;
    const a = this.time * 0.08;
    // High enough to look down over the perimeter wall into the map.
    this.camera.position.set(Math.cos(a) * 40, 36, Math.sin(a) * 40);
    this.camera.lookAt(0, 0, 0);
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    if (this.preview) {
      // to the right of the panel, slowly turning, walking on the spot
      this.preview.root.position.set(this.camera.aspect > 1.2 ? 1.5 : 0.95, -1.05, -3.3);
      // turning slowly by itself, unless the player has just turned it by hand (then it eases back in after a while)
      this.previewHeld += dt;
      this.previewYaw += dt * 0.9 * Math.min(1, Math.max(0, (this.previewHeld - 2.5) / 1.5));
      this.preview.root.rotation.y = this.previewYaw;
      // Mouths along with your microphone; otherwise remarks on each new outfit
      // ("oh! hey there!": four syllables of different lengths).
      this.babble += dt;
      const syll = [[0, 0.16, 0.9], [0.26, 0.38, 0.6], [0.44, 0.58, 1], [0.66, 0.86, 0.75]];
      let chat = 0;
      for (const [a, b, amp] of syll) if (this.babble > a && this.babble < b) chat = amp * Math.sin(((this.babble - a) / (b - a)) * Math.PI);
      animateCharacter(this.preview, {
        speed: 3.2, grounded: true, crouched: false, sliding: false, pitch: 0, talk: Math.max(chat, this.previewTalk),
      }, dt);
    }
    this.extras?.update(this.time * 60, this.time);
    this.applyDarkness(dt);
    this.fx.update(dt);
    this.present(false);
  }

  /** alpha = how far we are between the previous and the current sim tick. */
  render(
    sim: SimView, localId: number, alpha: number, dt: number, view: ViewState, cam: CamMode,
    /** How loud each player's voice is right now (0..1): opens their mouth. */
    talk: (id: number) => number = () => 0,
  ): void {
    this.time += dt;

    this.extras?.update(sim.worldTick - 1 + alpha, this.time);
    this.zoneMesh.visible = !!sim.zone;
    if (sim.zone) {
      this.zoneMesh.position.set(sim.zone.x, 20, sim.zone.z);
      this.zoneMesh.scale.set(sim.zone.radius, 1, sim.zone.radius);
      (this.zoneMesh.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(this.time * 4) * 0.06;
    }
    const me = sim.getPlayer(localId);
    const target = cam.mode === 'first' ? undefined : sim.getPlayer(cam.target);
    const orbit = cam.mode === 'orbit' && !!target;
    const spectate = cam.mode === 'spectate' && !!target && target.alive;

    // --- characters ---
    const seen = new Set<number>();
    for (const p of sim.players) {
      if (p.id === localId && !orbit) continue; // you only see your own body from outside
      seen.add(p.id);
      let c = this.chars.get(p.id);
      if (c && c.look !== p.look.join()) { this.scene.remove(c.root); c = undefined; } // changed outfit: rebuild
      if (!c) {
        c = buildCharacter(p.color, p.look);
        this.chars.set(p.id, c);
        this.scene.add(c.root);
      }
      c.root.visible = p.alive && !(spectate && p.id === cam.target); // not from inside their head
      if (!p.alive) continue;
      c.root.position.set(
        lerp3(p.prevPos.x, p.pos.x, alpha), lerp3(p.prevPos.y, p.pos.y, alpha), lerp3(p.prevPos.z, p.pos.z, alpha),
      );
      c.root.rotation.y = p.yaw;
      // Thrown off a wheelie: head over heels, rolling about the middle, low to the ground.
      if (p.tumbleT > 0 && p.alive) { if (!this.tumbles.has(p.id)) this.tumbles.set(p.id, this.time); }
      else this.tumbles.delete(p.id);
      const tStart = this.tumbles.get(p.id);
      const ta = tStart === undefined ? 0 : GameRenderer.tumbleAngle(this.time - tStart);
      c.root.rotation.order = 'YXZ';
      c.root.rotation.x = ta;
      if (ta) {
        const cy = 0.9 - 0.45 * Math.abs(Math.sin(ta)); // where the middle is: lower while lying along the ground
        const ly = cy - 0.9 * Math.cos(ta), lz = -0.9 * Math.sin(ta);
        c.root.position.x += Math.sin(p.yaw) * lz;
        c.root.position.z += Math.cos(p.yaw) * lz;
        c.root.position.y += ly;
      }
      c.shadow.visible = p.grounded;
      // Name tag: readable at any distance (it grows with distance, within limits),
      // but only shown while you can actually see the player. The tag floats
      // above the head (higher the further off it is), so on its own it would
      // peek over a wall that hides them.
      setLabel(c, p.name, p.color);
      const far = c.root.position.distanceTo(this.camera.position);
      const size = Math.max(1.1, Math.min(7, far * 0.13));
      c.label.scale.set(size * 2, size * 0.5, 1);
      c.label.position.y = (p.crouched ? 1.55 : 2.2) + size * 0.25;
      c.label.visible = !!p.name && this.inSight(p.id, c.root.position, p.crouched);
      const wallSide = p.wallRunning ? this.wallSide(p, c.root.position) : 0;
      animateCharacter(c, {
        speed: Math.hypot(p.vel.x, p.vel.z), grounded: p.grounded, crouched: p.crouched, sliding: p.sliding, pitch: p.pitch,
        celebrate: orbit && p.id === cam.target, dual: isDual(p), talk: talk(p.id), health: p.health, wallSide,
        riding: p.broomT > 0, bike: p.bikeT > 0 ? (p.wheelie ? 2 : 1) : 0,
      }, dt);
      // SLABRIDER: the bike under them. A wheelie lifts the front, pivoting on the back tyre.
      let bv = this.bikeViews.get(p.id);
      if (p.bikeT > 0 && !bv) {
        const pivot = new THREE.Group();
        pivot.position.set(0, 0, 0.66); // the back tyre's contact patch
        const model = buildWeaponModel('slabrider');
        model.position.z = -0.66;
        pivot.add(model);
        c.root.add(pivot);
        this.bikeViews.set(p.id, (bv = { pivot, model, lift: 0, roll: 0 }));
      }
      if (bv) {
        bv.pivot.visible = p.bikeT > 0;
        bv.lift += ((p.wheelie ? 1.05 + Math.sin(this.time * 2.3 + p.id) * 0.07 : 0) - bv.lift) * Math.min(1, dt * (p.wheelie ? 9 : 14)); // up high, balancing
        bv.pivot.rotation.x = bv.lift;
        // The seat swings back and up with the front: the rider goes with it (the bike, shifted
        // the other way, stays where it stands).
        const sa = Math.sin(bv.lift), ca = Math.cos(bv.lift);
        const dy = 0.76 * ca + 0.66 * sa - 0.76, dz = 0.66 + 0.76 * sa - 0.66 * ca;
        c.root.position.x += Math.sin(c.root.rotation.y) * dz;
        c.root.position.z += Math.cos(c.root.rotation.y) * dz;
        c.root.position.y += dy;
        bv.pivot.position.set(0, -dy, 0.66 - dz);
        bv.roll += Math.hypot(p.vel.x, p.vel.z) * dt;
        animateBike(bv.model, bv.roll);
      }
      // SKYSWEEPER: the broom under them, handle forwards, bristles behind.
      let broom = this.broomViews.get(p.id);
      if (p.broomT > 0 && !broom) {
        broom = buildWeaponModel('skysweeper');
        broom.position.set(0, 0.8, 0.05);
        c.root.add(broom);
        this.broomViews.set(p.id, broom);
      }
      if (broom) {
        broom.visible = p.broomT > 0;
        broom.rotation.z = Math.sin(this.time * 2.1 + p.id) * 0.05; // a gentle rocking
        broom.position.y = 0.8 + Math.sin(this.time * 2.7 + p.id) * 0.02;
      }
      // Dual wielding: slot 1 in the left hand, slot 2 in the right.
      const dual = isDual(p);
      const off: WeaponId | null = dual ? p.weapons[0]!.type : null;
      if (off !== c.weapon2) {
        c.hand2.clear();
        if (off) c.hand2.add(buildWeaponModel(off));
        c.weapon2 = off;
      }
      const held: WeaponId | null = (dual ? p.weapons[1] : p.weapons[p.active])?.type ?? null;
      if (held !== c.weapon) {
        c.hand.clear();
        if (held) c.hand.add(buildWeaponModel(held));
        c.weapon = held;
      }
      // AFTERBURN: its tank rides on the back of whoever has it in their hands. Shoot it.
      let tank = c.body.getObjectByName('tank');
      const wantTank = !!held && !!WEAPONS[held].torch;
      if (wantTank && !tank) {
        tank = buildTank();
        tank.position.set(0, 1.18, 0.3); // behind the shoulders (front is -Z)
        c.body.add(tank);
      }
      if (tank) tank.visible = wantTank;
      // JETHAMMER: the compartment opens when they hold the trigger; flying, a roaring exhaust trail behind them.
      const hammer = c.hand.children[0];
      if (hammer?.userData.jetHammer) animateJetHammer(hammer, p.jetT > 0, dt);
      if (hammer) animateSixSeven(hammer, this.time + p.id); // SIX SEVEN: their hands bob too
      if (hammer?.getObjectByName('orb')) {
        // KI BLAST: ease in and out of the firing pose, so their hands flow rather than jump.
        const firing = p.kiFireT > 0;
        const was = this.kiBlend.get(p.id) ?? 0;
        const blend = was + ((firing ? 1 : 0) - was) * Math.min(1, dt * (firing ? 18 : 5));
        this.kiBlend.set(p.id, blend);
        animateKiOrb(hammer, p.kiCharge / (WEAPONS.kiblast.ki!.charge), blend, this.time);
      }
      if (p.jetT > 0 && p.jetSpeed > 0 && this.trailT <= 0.01) this.exhaust(p, alpha);
      // Running along a wall: dust off the feet and the trailing hand, where they meet the wall.
      const wall = p.wallRunning ? this.walls.get(p.id) : undefined;
      if (wall?.n && this.trailT <= 0.01 && Math.random() < 0.7) {
        const up = Math.random() < 0.5 ? 1.45 : 0.35;
        this.fx.puff({ x: wall.at.x + wall.n.x * 0.05, y: c.root.position.y + up + (Math.random() - 0.5) * 0.2, z: wall.at.z + wall.n.z * 0.05 }, 0xa89c88, 0.08 + Math.random() * 0.06);
      }
    }
    for (const [id, c] of this.chars) if (!seen.has(id)) { this.scene.remove(c.root); this.chars.delete(id); this.broomViews.delete(id); this.bikeViews.delete(id); }

    // --- pickups ---
    seen.clear();
    for (const pk of sim.pickups) {
      seen.add(pk.id);
      let v = this.pickupViews.get(pk.id);
      if (!v) {
        const group = new THREE.Group();
        const model = buildWeaponModel(pk.weapon.type);
        model.scale.setScalar(WEAPONS[pk.weapon.type].category === 'vehicle' ? 1 : 1.5); // a broom is big enough as it is
        const legendary = WEAPONS[pk.weapon.type].category === 'legendary';
        const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.5), legendary
          ? new THREE.MeshBasicMaterial({ color: 0xc88aff }) : flatMat(0xe8c63a));
        base.position.y = 0.03;
        group.add(model, base);
        let pillar: THREE.Mesh | null = null;
        if (legendary) {
          pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 9, 10, 1, true), new THREE.MeshBasicMaterial({
            color: 0xb070ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
          }));
          pillar.position.y = 4.5;
          group.add(pillar);
        }
        this.scene.add(group);
        this.pickupViews.set(pk.id, (v = { group, model, base, pillar }));
      }
      v.group.position.set(
        lerp3(pk.prevPos.x, pk.pos.x, alpha), lerp3(pk.prevPos.y, pk.pos.y, alpha), lerp3(pk.prevPos.z, pk.pos.z, alpha),
      );
      v.base.visible = pk.resting && pk.weapon.ammo > 0 && pk.weapon.type !== 'slabrider'; // (a bike just stands there)
      if (v.pillar) {
        v.pillar.visible = v.base.visible;
        (v.pillar.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(this.time * 3 + pk.id) * 0.06;
      }
      animateKiPickup(v.model, this.time + pk.id); // (only does anything for a KI BLAST)
      // SIX SEVEN: two separate hands, so an empty one is laid flat (tipped over like other
      // empty weapons, one hand would sink into the floor), hands still, flames out.
      const pair = !!v.model.getObjectByName('sixL');
      const spent = pk.resting && pk.weapon.ammo <= 0;
      if (pair && spent) {
        for (const n of ['sixL', 'sixR']) {
          const hnd = v.model.getObjectByName(n)!;
          hnd.position.y = 0;
          hnd.rotation.set(0, 0, 0);
          const fl = hnd.getObjectByName('flame');
          if (fl) fl.visible = false;
        }
      } else animateSixSeven(v.model, this.time + pk.id); // (and this only for a SIX SEVEN)
      if (pk.weapon.type === 'slabrider') {
        // A bike stands on its wheels where it was left, turning slowly so you notice it.
        v.model.position.y = 0;
        v.model.rotation.set(0, pk.resting ? this.time * 0.5 + pk.id : v.model.rotation.y, 0);
      } else if (pk.resting) {
        v.model.position.y = 0.5 + Math.sin(this.time * 2.5 + pk.id) * 0.07;
        v.model.rotation.set(0, this.time * 1.6 + pk.id, pk.weapon.ammo > 0 || pair ? 0 : 1.4);
        if (pk.weapon.ammo <= 0) v.model.position.y = pair ? 0.08 : 0.12; // empty weapons just lie there
      } else {
        v.model.position.y = 0.15;
        v.model.rotation.x += dt * 14;
        v.model.rotation.y += dt * 5;
      }
    }
    for (const [id, v] of this.pickupViews) if (!seen.has(id)) { this.scene.remove(v.group); this.pickupViews.delete(id); }

    // --- projectiles ---
    seen.clear();
    this.trailT -= dt;
    const trail = this.trailT <= 0;
    if (trail) this.trailT = 0.02;
    for (const pr of sim.projectiles) {
      seen.add(pr.id);
      let m = this.projViews.get(pr.id);
      if (!m) {
        m = buildProjectileModel(pr.kind);
        this.scene.add(m);
        this.projViews.set(pr.id, m);
      }
      m.position.set(
        lerp3(pr.prevPos.x, pr.pos.x, alpha), lerp3(pr.prevPos.y, pr.pos.y, alpha), lerp3(pr.prevPos.z, pr.pos.z, alpha),
      );
      if (pr.kind === 'rearview') {
        // A caught bullet: hangs still with a faint shiver, then streaks back.
        if (Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z) > 0.1) {
          m.lookAt(m.position.x + pr.vel.x, m.position.y + pr.vel.y, m.position.z + pr.vel.z);
          if (trail) this.fx.puff(m.position, 0x9ad8ff, 0.07); // a faint trail, so you can watch it come for you
        }
        else m.rotation.set(Math.sin(this.time * 31 + pr.id) * 0.05, pr.id, 0);
      } else if (pr.kind === 'sixseven') {
        // A blue fireball: it flickers and throbs, and leaves a trail of blue flame.
        m.scale.setScalar(1 + Math.sin(this.time * 31 + pr.id) * 0.12);
        m.rotation.set(this.time * 9, this.time * 7 + pr.id, 0);
        if (trail) this.fx.puff(m.position, Math.random() < 0.5 ? 0x4aa8ff : 0x9ad8ff, 0.1);
      } else if (pr.kind === 'postman' || pr.kind === 'bigone' || pr.kind === 'stapler') {
        m.lookAt(m.position.x + pr.vel.x, m.position.y + pr.vel.y, m.position.z + pr.vel.z);
      } else if (pr.kind === 'afterburn') {
        // A burning patch: flames flicker and sway, and smoke now and then.
        m.rotation.set(0, this.time * 3 + pr.id, 0);
        m.scale.set(1, 0.75 + Math.sin(this.time * 19 + pr.id * 3) * 0.25, 1);
        if (trail && Math.random() < 0.25) this.fx.puff({ x: m.position.x, y: m.position.y + 0.6, z: m.position.z }, Math.random() < 0.5 ? 0xff7a1a : 0x555049, 0.22);
      } else if (!pr.stuck) {
        m.rotation.x += dt * 11; // grenades tumble
        m.rotation.z += dt * 4;
      } else {
        m.rotation.set(0, pr.id * 1.7, 0); // come to rest upright
        const turret = m.getObjectByName('spin');
        if (turret) turret.rotation.y = this.time * 2.2; // a sentry sweeps the room
      }
      if (pr.kind === 'stinker' && pr.gen === 2 && trail) {
        // the cloud: sickly green puffs all through its radius
        for (let k = 0; k < 2; k++) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * 3.8;
          this.fx.puff({ x: pr.pos.x + Math.cos(a) * r, y: pr.pos.y + 0.2 + Math.random() * 1.6, z: pr.pos.z + Math.sin(a) * r }, 0x9ad23a, 0.3);
        }
      }
      const blink = m.getObjectByName('blink');
      if (blink) blink.visible = !(pr.stuck || pr.kind === 'potato') || Math.floor(this.time * 6) % 2 === 0; // armed mines and lit fuses blink
      if (trail && !pr.stuck && SMOKY.has(pr.kind)) this.fx.puff(m.position, 0x888888, pr.kind === 'bigone' ? 0.34 : 0.16);
    }
    for (const [id, m] of this.projViews) if (!seen.has(id)) { this.scene.remove(m); this.projViews.delete(id); }

    // --- camera ---
    let drawVm = false;
    let fov = this.baseFov;
    // Aiming, for whoever's eyes we are looking through.
    const eye = spectate ? target : orbit ? undefined : me;
    const held = eye && eye.alive && eye.aiming ? eye.weapons[eye.active] : null;
    const scoped = held ? WEAPONS[held.type].scope ?? 0 : 0;
    this.aimT += ((held ? 1 : 0) - this.aimT) * Math.min(1, dt * AIM.blend);
    if (!held && this.aimT < 0.01) this.aimT = 0;
    if (held) this.scopeFov = scoped;
    this.shake *= Math.exp(-dt * 7);
    if (orbit && target) {
      // Circle the winner.
      const a = this.time * 0.7;
      const tx = lerp3(target.prevPos.x, target.pos.x, alpha), ty = lerp3(target.prevPos.y, target.pos.y, alpha), tz = lerp3(target.prevPos.z, target.pos.z, alpha);
      this.camera.position.set(tx + Math.cos(a) * 4.6, ty + 2.5, tz + Math.sin(a) * 4.6);
      this.camera.lookAt(tx, ty + 1.15, tz);
      fov = 68;
      this.fovKick = 0;
    } else if (cam.mode === 'head' && this.headCam) {
      // Dead: we are the head, flying off and tumbling. The shake rattles it on top.
      this.stepHeadCam(dt);
      const h = this.headCam, sh = this.shake * 0.04 * this.shakeScale;
      this.camera.position.set(h.pos.x + (Math.random() - 0.5) * sh, h.pos.y + (Math.random() - 0.5) * sh, h.pos.z + (Math.random() - 0.5) * sh);
      this.camera.quaternion.copy(h.rot);
      if (sh > 0) this.camera.rotateZ((Math.random() - 0.5) * sh * 0.6);
      fov = this.baseFov + 12; // a little wider: disorienting
      this.fovKick = 0;
    } else if (spectate && target) {
      this.camera.position.set(target.pos.x, target.pos.y + (target.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), target.pos.z);
      this.camera.rotation.set(target.pitch, target.yaw, target.sliding ? 0.045 : 0, 'YXZ');
      this.fovKick = 0;
      // Their hands and weapons, as they see them. The sway follows how they turn.
      if (this.specId !== target.id) { this.specId = target.id; this.specYaw = target.yaw; this.specPitch = target.pitch; }
      let dYaw = target.yaw - this.specYaw;
      dYaw -= Math.round(dYaw / (Math.PI * 2)) * Math.PI * 2;
      const swayX = -dYaw / 0.0022, swayY = -(target.pitch - this.specPitch) / 0.0022; // back to "mouse pixels"
      this.specYaw = target.yaw;
      this.specPitch = target.pitch;
      this.holdWeapons(target);
      this.vm.jet = target.jetT > 0;
      this.vm.pose = this.specialPose(target);
      this.vm.setKi(target.kiCharge / (WEAPONS.kiblast.ki!.charge), target.kiFireT > 0);
      this.vm.broom = target.broomT > 0;
      this.vm.bike = target.bikeT > 0 ? (target.wheelie ? 2 : 1) : 0;
      this.vm.update(dt, Math.hypot(target.vel.x, target.vel.z), target.grounded, Math.max(-60, Math.min(60, swayX)), Math.max(-60, Math.min(60, swayY)), this.aimT);
      drawVm = true;
    } else if (me) {
      this.specId = -1; // next time we spectate, the hands start from rest
      const x = lerp3(me.prevPos.x, me.pos.x, alpha), y = lerp3(me.prevPos.y, me.pos.y, alpha), z = lerp3(me.prevPos.z, me.pos.z, alpha);
      const k = Math.min(1, dt * 14);
      if (me.alive) {
        // Smooth eye height over stairs and crouch transitions; never in the air.
        if (me.grounded && Math.abs(y - this.smoothY) < 0.7) this.smoothY += (y - this.smoothY) * Math.min(1, dt * 25);
        else this.smoothY = y;
        this.eyeH += ((me.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight) - this.eyeH) * k;
        // SLABRIDER: popping a wheelie throws the view up and back with a jolt; balancing on the
        // back wheel it sways; the front slamming down jolts it again.
        const up = me.bikeT > 0 && me.wheelie;
        if (up !== this.wheelieOn) {
          if (up) { this.shake = Math.max(this.shake, 0.6); this.wheelieVel += 6; }
          else if (me.bikeT > 0) { this.shake = Math.max(this.shake, 0.9); this.wheelieVel -= 4; }
          this.wheelieOn = up;
        }
        if (me.bikeT <= 0) { this.wheelieLift = this.wheelieVel = 0; }
        const wdt = Math.min(dt, 0.033);
        this.wheelieVel += ((up ? 1 : 0) - this.wheelieLift) * 160 * wdt - this.wheelieVel * 11 * wdt;
        this.wheelieLift += this.wheelieVel * wdt;
        const wl = this.wheelieLift;
        const sh = this.shake * 0.05 * this.shakeScale;
        // Thrown off a wheelie: the view goes head over heels with you, low to the ground.
        const tStart = me.tumbleT > 0 ? this.tumbles.get(me.id) ?? this.time : undefined;
        if (me.tumbleT > 0 && !this.tumbles.has(me.id)) this.tumbles.set(me.id, this.time);
        const ta = tStart === undefined ? 0 : GameRenderer.tumbleAngle(this.time - tStart);
        const low = ta ? Math.abs(Math.sin(ta / 2)) : 0;
        this.camera.position.set(x, this.smoothY + this.eyeH * (1 - low * 0.7) + wl * 0.28, z);
        // Running along a wall: the view tilts away from it.
        const side = me.wallRunning ? this.wallSide(me, this.camera.position.clone().setY(me.pos.y)) : 0;
        this.wallRoll += (side * 0.1 - this.wallRoll) * Math.min(1, dt * 10);
        this.vm.setWall(side);
        this.camera.rotation.set(
          view.pitch + wl * 0.26 + (Math.random() - 0.5) * sh, view.yaw + (Math.random() - 0.5) * sh,
          (me.sliding ? 0.045 : 0) + this.wallRoll + Math.sin(this.time * 2.3) * 0.035 * Math.max(0, wl), 'YXZ',
        );
        if (ta) { this.camera.rotateX(ta); this.camera.rotateZ(Math.sin(ta) * 0.35); }
        const speed = Math.hypot(me.vel.x, me.vel.z);
        this.fovKick += (Math.max(0, Math.min(14, (speed - 8.5) * 1.1)) + Math.max(0, wl) * 7 - this.fovKick) * Math.min(1, dt * 6);
        this.holdWeapons(me);
        this.vm.jet = me.jetT > 0;
        this.vm.pose = this.specialPose(me);
        this.vm.setKi(me.kiCharge / (WEAPONS.kiblast.ki!.charge), me.kiFireT > 0);
        this.vm.broom = me.broomT > 0;
        this.vm.bike = me.bikeT > 0 ? (me.wheelie ? 2 : 1) : 0;
        if (me.kiFireT > 0) this.shake = Math.max(this.shake, 0.35); // the beam shakes you
        this.vm.update(dt, speed, me.grounded, view.mouseDX, view.mouseDY, this.aimT);
        drawVm = !me.noclip && !(me.tumbleT > 0); // no hands while free-flying in the map lab (or tumbling)
      } else {
        // Dead with nobody to watch: the camera lies on the floor where you fell.
        this.camera.position.set(x, me.pos.y + 0.35, z);
        this.camera.rotation.set(view.pitch * 0.3, view.yaw, 0.6, 'YXZ');
        this.fovKick = 0;
        this.smoothY = y;
      }
      fov += this.fovKick;
    }
    // Zoom: iron sights narrow the view a little; a scope (NEEDLE) a lot, and
    // hides the gun once you are looking through it.
    const plain = fov;
    if (this.scopeFov > 0) {
      fov += (this.scopeFov - fov) * this.aimT;
      this.scope = Math.max(0, Math.min(1, (this.aimT - 0.55) / 0.35));
      if (this.scope > 0.5) drawVm = false;
    } else {
      fov *= 1 + (AIM.fov - 1) * this.aimT;
      this.scope = 0;
    }
    this.zoom = fov / plain;
    if (this.aimT === 0) this.scopeFov = 0;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();

    this.drawBeams(sim, localId, alpha, cam, spectate, orbit);
    this.applyDarkness(dt);
    this.fx.update(dt);
    this.present(drawVm);
  }

  /** A melee special being held, for the first-person hands: guarding, or winding up (and how far). */
  private specialPose(p: Player): { kind: 'guard' | 'charge'; amount: number } | null {
    const sp = specialIn(p);
    if (!sp || p.specialT <= 0) return null;
    if (sp.kind === 'guard') return { kind: 'guard', amount: 1 };
    if (sp.kind === 'charge') return { kind: 'charge', amount: Math.min(1, p.specialT / sp.time) };
    return null;
  }

  /** The JETHAMMER's flame and smoke, left behind a player whose rocket is burning (also our own: seen when we look back). */
  private exhaust(p: Player, alpha: number): void {
    const x = lerp3(p.prevPos.x, p.pos.x, alpha), y = lerp3(p.prevPos.y, p.pos.y, alpha), z = lerp3(p.prevPos.z, p.pos.z, alpha);
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    const bx = -p.vel.x / sp, by = -p.vel.y / sp, bz = -p.vel.z / sp;
    for (let k = 0; k < 3; k++) {
      const d = 0.8 + k * 0.9;
      this.fx.puff({ x: x + bx * d, y: y + 1.5 + by * d, z: z + bz * d }, k === 0 ? 0xffd23a : k === 1 ? 0xff7a1a : 0x6a6660, 0.18 + k * 0.1);
    }
  }

  /** MONOLOGUE: every beam that is on, and the shell around everyone caught in one. Needs the camera already placed. */
  private drawBeams(sim: SimView, localId: number, alpha: number, cam: CamMode, spectate: boolean, orbit: boolean): void {
    this.beams.begin();
    const at = (p: Player, up = 0) => new THREE.Vector3(
      lerp3(p.prevPos.x, p.pos.x, alpha), lerp3(p.prevPos.y, p.pos.y, alpha) + up, lerp3(p.prevPos.z, p.pos.z, alpha));
    // Whose eyes the camera is: their beam starts at the first-person hands, and a beam holding them ends just below the view.
    const eyes = orbit || cam.mode === 'head' ? -1 : spectate ? cam.target : localId;
    for (const p of sim.players) {
      if (!p.alive) continue;
      const mw = p.weapons[p.active];
      const mirror = p.mirrorT > 0 && mw ? WEAPONS[mw.type].mirror : undefined;
      const ki = mw ? WEAPONS[mw.type].ki : undefined;
      if (ki && p.kiFireT > 0) {
        // KI BLAST: the beam, from the hands to the first wall along it. Our own follows the
        // direction the host has (it sweeps behind the aim); others' follow their aim.
        const own = p.id === eyes;
        const c = this.chars.get(p.id);
        // Our own starts right at the orb between our hands, as we see it.
        const orb = own ? this.vm.orbScreen() : null;
        const from = orb ? this.camera.position.clone().addScaledVector(orb.clone().setZ(0.5).unproject(this.camera).sub(this.camera.position).normalize(), 0.9)
          : own ? this.muzzleWorld(-1) : c ? c.hand.localToWorld(new THREE.Vector3(0, 0.04, -0.2)) : at(p, PLAYER.eyeHeight - 0.3);
        const d = own && p.kiDir ? p.kiDir : aimDir(p.yaw, p.pitch);
        const dir = new THREE.Vector3(d.x, d.y, d.z).normalize();
        const o = own ? this.camera.position.clone() : at(p, PLAYER.eyeHeight);
        this.ray.set(o, dir);
        this.ray.far = ki.range;
        const hit = this.mapGroup ? this.ray.intersectObject(this.mapGroup, true)[0] : undefined;
        const to = hit ? hit.point : o.clone().addScaledVector(dir, ki.range);
        const radius = ki.radius[0] + (ki.radius[1] - ki.radius[0]) * p.kiPower;
        this.beams.kiBeam(p.id, from, to, radius, this.time);
        if (this.trailT <= 0.01) this.fx.puff({ x: to.x, y: to.y, z: to.z }, Math.random() < 0.5 ? 0xbfeaff : 0x7a7a88, radius * 0.5);
      }
      if (mirror) {
        // REARVIEW: the field hangs where the sim has it, in front of their eyes.
        const own = p.id === eyes;
        const d = aimDir(p.yaw, p.pitch);
        const n = own ? this.camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(d.x, d.y, d.z);
        const eye = own ? this.camera.position.clone() : at(p, p.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight);
        this.beams.field(p.id, eye.addScaledVector(n, mirror.distance), n, mirror.radius, this.time, own);
      }
      if (p.heldBy >= 0 && p.id !== eyes) this.beams.shell(p.id, at(p, HOLD_CENTRE), this.time, !!sim.getPlayer(p.heldBy)?.beamHurt);
      if (p.beamT <= 0) continue;
      const c = this.chars.get(p.id);
      const from = p.id === eyes ? this.muzzleWorld(-1)
        : c ? c.hand.localToWorld(new THREE.Vector3(0, 0.03, -0.3)) : at(p, PLAYER.eyeHeight - 0.3);
      const v = p.holding >= 0 ? sim.getPlayer(p.holding) : undefined;
      let to: THREE.Vector3;
      if (v?.alive) {
        to = v.id === eyes ? this.camera.position.clone().add(new THREE.Vector3(0, -0.6, 0)) : at(v, HOLD_CENTRE);
      } else {
        // Searching: the beam reaches out to the first wall, or as far as it goes.
        const o = p.id === eyes ? this.camera.position.clone() : at(p, p.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight);
        const d = aimDir(p.yaw, p.pitch);
        const dir = new THREE.Vector3(d.x, d.y, d.z);
        const reach = WEAPONS.monologue.range;
        this.ray.set(o, dir);
        this.ray.far = reach;
        const hit = this.mapGroup ? this.ray.intersectObject(this.mapGroup, true)[0] : undefined;
        to = hit ? hit.point : o.addScaledVector(dir, reach);
      }
      this.beams.beam(p.id, from, to, this.time, !!v?.alive, p.beamHurt && !!v?.alive);
    }
    this.beams.end();
  }
}
