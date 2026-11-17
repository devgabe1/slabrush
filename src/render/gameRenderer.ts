import * as THREE from 'three';
import { PLAYER } from '../config/game';
import type { WeaponId } from '../config/weapons';
import type { SimView } from '../net/session';
import { isDual } from '../sim/game';
import type { MapDef } from '../sim/map';
import type { Player } from '../sim/types';
import { Effects } from './effects';
import { MapExtras } from './mapExtras';
import { buildMapMesh } from './mapMesh';
import { animateCharacter, buildCharacter, buildProjectileModel, buildWeaponModel, flatMat, setLabel, type CharacterView } from './models';
import { RetroPass, type RetroMode } from './retroPass';
import { makeMaterials } from './textures';
import { ViewModel } from './viewmodel';

interface PickupView {
  group: THREE.Group;
  model: THREE.Group;
  base: THREE.Mesh;
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
 */
export interface CamMode {
  mode: 'first' | 'spectate' | 'orbit';
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
  shake = 0;
  /** 0 disables screen shake, 1 is the default (Settings). */
  shakeScale = 1;

  private mapGroup: THREE.Group | null = null;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.6);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private chars = new Map<number, CharacterView>();
  private pickupViews = new Map<number, PickupView>();
  private projViews = new Map<number, THREE.Object3D>();
  private eyeH = PLAYER.eyeHeight;
  private smoothY = 0;
  private fovKick = 0;
  private baseFov = 100;
  private scale = 0.5;
  private time = 0;
  private extras: MapExtras | null = null;
  private skyColor = new THREE.Color();
  private sunColor = new THREE.Color();
  private fogNear = 20;
  private fogFar = 120;
  private darkness = 0; // 0..1, eases in when the camera enters a dark area
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
    const target = this.extras?.isDark(this.camera.position) ? 1 : 0;
    this.darkness += (target - this.darkness) * Math.min(1, dt * 5);
    const k = this.darkness;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.skyColor).multiplyScalar(1 - 0.94 * k);
    (this.scene.background as THREE.Color).copy(fog.color);
    fog.near = this.fogNear * (1 - k) + 1.5 * k;
    fog.far = this.fogFar * (1 - k) + 17 * k;
    this.hemi.intensity = 1.6 * (1 - 0.75 * k);
    this.sun.intensity = 2.2 * (1 - 0.85 * k);
    (this.dome.material as THREE.MeshBasicMaterial).color.setScalar(1 - 0.94 * k);
    (this.sunDisc.material as THREE.MeshBasicMaterial).color.copy(this.sunColor).multiplyScalar(1 - k);
    this.sky.position.copy(this.camera.position);
  }

  clearEntities(): void {
    for (const c of this.chars.values()) this.scene.remove(c.root);
    for (const p of this.pickupViews.values()) this.scene.remove(p.group);
    for (const p of this.projViews.values()) this.scene.remove(p);
    this.chars.clear();
    this.pickupViews.clear();
    this.projViews.clear();
    this.fx.clear();
    this.zoneMesh.visible = false;
  }

  /** Where tracers of the local player start: roughly the viewmodel muzzle. */
  muzzleWorld(hand = -1): THREE.Vector3 {
    return new THREE.Vector3(hand === 0 ? -0.2 : 0.18, -0.14, -0.7).applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }

  /** Blow a player's model apart. */
  spawnCorpse(p: Player, floorY: number): void {
    let view = this.chars.get(p.id);
    if (!view) {
      view = buildCharacter(p.color, p.look);
      view.root.position.set(p.pos.x, p.pos.y, p.pos.z);
      view.root.rotation.y = p.yaw;
    }
    view.root.visible = true;
    view.root.updateMatrixWorld(true);
    for (const part of view.parts) {
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.4, Math.random() - 0.5).multiplyScalar(7);
      vel.x += p.vel.x * 0.5;
      vel.z += p.vel.z * 0.5;
      this.fx.debris(part, vel, floorY);
    }
    view.root.visible = false;
  }

  private preview: CharacterView | null = null;
  private previewKey = '';

  /** Customization screen: a walking, turning copy of the character beside the menu. null = none. */
  setPreview(look: readonly number[] | null, color = 0xe8503a): void {
    const key = look ? look.join() + color : '';
    if (key === this.previewKey) return;
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
      this.preview.root.rotation.y = this.time * 0.9;
      animateCharacter(this.preview, { speed: 3.2, grounded: true, crouched: false, sliding: false, pitch: 0 }, dt);
    }
    this.extras?.update(this.time * 60, this.time);
    this.applyDarkness(dt);
    this.fx.update(dt);
    this.present(false);
  }

  /** alpha = how far we are between the previous and the current sim tick. */
  render(sim: SimView, localId: number, alpha: number, dt: number, view: ViewState, cam: CamMode): void {
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
      c.shadow.visible = p.grounded;
      // Name tag: readable at any distance (it grows with distance, within limits),
      // but hidden by walls like the player it belongs to.
      setLabel(c, p.name, p.color);
      const far = c.root.position.distanceTo(this.camera.position);
      const size = Math.max(1.1, Math.min(7, far * 0.13));
      c.label.scale.set(size * 2, size * 0.5, 1);
      c.label.position.y = (p.crouched ? 1.55 : 2.2) + size * 0.25;
      animateCharacter(c, {
        speed: Math.hypot(p.vel.x, p.vel.z), grounded: p.grounded, crouched: p.crouched, sliding: p.sliding, pitch: p.pitch,
        celebrate: orbit && p.id === cam.target, dual: isDual(p),
      }, dt);
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
    }
    for (const [id, c] of this.chars) if (!seen.has(id)) { this.scene.remove(c.root); this.chars.delete(id); }

    // --- pickups ---
    seen.clear();
    for (const pk of sim.pickups) {
      seen.add(pk.id);
      let v = this.pickupViews.get(pk.id);
      if (!v) {
        const group = new THREE.Group();
        const model = buildWeaponModel(pk.weapon.type);
        model.scale.setScalar(1.5);
        const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.5), flatMat(0xe8c63a));
        base.position.y = 0.03;
        group.add(model, base);
        this.scene.add(group);
        this.pickupViews.set(pk.id, (v = { group, model, base }));
      }
      v.group.position.set(
        lerp3(pk.prevPos.x, pk.pos.x, alpha), lerp3(pk.prevPos.y, pk.pos.y, alpha), lerp3(pk.prevPos.z, pk.pos.z, alpha),
      );
      v.base.visible = pk.resting && pk.weapon.ammo > 0;
      if (pk.resting) {
        v.model.position.y = 0.5 + Math.sin(this.time * 2.5 + pk.id) * 0.07;
        v.model.rotation.set(0, this.time * 1.6 + pk.id, pk.weapon.ammo > 0 ? 0 : 1.4);
        if (pk.weapon.ammo <= 0) v.model.position.y = 0.12; // empty weapons just lie there
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
      if (pr.kind === 'postman' || pr.kind === 'bigone' || pr.kind === 'stapler') {
        m.lookAt(m.position.x + pr.vel.x, m.position.y + pr.vel.y, m.position.z + pr.vel.z);
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
    this.shake *= Math.exp(-dt * 7);
    if (orbit && target) {
      // Circle the winner.
      const a = this.time * 0.7;
      const tx = lerp3(target.prevPos.x, target.pos.x, alpha), ty = lerp3(target.prevPos.y, target.pos.y, alpha), tz = lerp3(target.prevPos.z, target.pos.z, alpha);
      this.camera.position.set(tx + Math.cos(a) * 4.6, ty + 2.5, tz + Math.sin(a) * 4.6);
      this.camera.lookAt(tx, ty + 1.15, tz);
      fov = 68;
      this.fovKick = 0;
    } else if (spectate && target) {
      this.camera.position.set(target.pos.x, target.pos.y + (target.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), target.pos.z);
      this.camera.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
      this.fovKick = 0;
    } else if (me) {
      const x = lerp3(me.prevPos.x, me.pos.x, alpha), y = lerp3(me.prevPos.y, me.pos.y, alpha), z = lerp3(me.prevPos.z, me.pos.z, alpha);
      const k = Math.min(1, dt * 14);
      if (me.alive) {
        // Smooth eye height over stairs and crouch transitions; never in the air.
        if (me.grounded && Math.abs(y - this.smoothY) < 0.7) this.smoothY += (y - this.smoothY) * Math.min(1, dt * 25);
        else this.smoothY = y;
        this.eyeH += ((me.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight) - this.eyeH) * k;
        const sh = this.shake * 0.05 * this.shakeScale;
        this.camera.position.set(x, this.smoothY + this.eyeH, z);
        this.camera.rotation.set(
          view.pitch + (Math.random() - 0.5) * sh, view.yaw + (Math.random() - 0.5) * sh, me.sliding ? 0.045 : 0, 'YXZ',
        );
        const speed = Math.hypot(me.vel.x, me.vel.z);
        this.fovKick += (Math.max(0, Math.min(14, (speed - 8.5) * 1.1)) - this.fovKick) * Math.min(1, dt * 6);
        if (isDual(me)) this.vm.setWeapons(me.weapons[1]!.type, me.weapons[0]!.type); // right hand, left hand
        else this.vm.setWeapons(me.weapons[me.active]?.type ?? 'fists', null);
        this.vm.update(dt, speed, me.grounded, view.mouseDX, view.mouseDY);
        drawVm = !me.noclip; // no hands while free-flying in the map lab
      } else {
        // Dead with nobody to watch: the camera lies on the floor where you fell.
        this.camera.position.set(x, me.pos.y + 0.35, z);
        this.camera.rotation.set(view.pitch * 0.3, view.yaw, 0.6, 'YXZ');
        this.fovKick = 0;
        this.smoothY = y;
      }
      fov += this.fovKick;
    }
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();

    this.applyDarkness(dt);
    this.fx.update(dt);
    this.present(drawVm);
  }
}
