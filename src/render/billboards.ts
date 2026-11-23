import * as THREE from 'three';
import { Rng } from '../core/rng';

// Digital billboards for the neon city: every ad is drawn here in code. A
// style makes one tall canvas of FRAMES slides, stacked; a screen shows one
// slide at a time (the texture's offset picks it) and flips to the next every
// few seconds with a burst of glitch. The ads are invented: gradients, bold
// shapes, made-up glyphs for lettering. Nothing real is pictured or named.

export const FRAMES = 4;
const W = 128, H = 64; // one slide

const NEON = ['#ff2e88', '#2ee8ff', '#ffd23a', '#9a5aff', '#3aff9a', '#ff6a2e', '#ffffff'];

/** A made-up glyph: a 3x5 grid of cells, some lit. Seeded, so the same "word" comes out the same. */
function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rng: Rng): void {
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      if (rng.next() < 0.55 || (gx === 1 && gy % 2 === 0)) ctx.fillRect(x + gx * s, y + gy * s, s, s);
    }
  }
}

function word(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, letters: number, rng: Rng): number {
  for (let i = 0; i < letters; i++) glyph(ctx, x + i * 4 * s, y, s, rng);
  return letters * 4 * s;
}

/** One slide of an ad, at (0, top). */
function slide(ctx: CanvasRenderingContext2D, top: number, rng: Rng, vertical: boolean): void {
  const pick = () => NEON[Math.floor(rng.next() * NEON.length)];
  const a = pick(), b = pick();
  const g = vertical ? ctx.createLinearGradient(0, top, 0, top + H) : ctx.createLinearGradient(0, top, W, top + H);
  g.addColorStop(0, a);
  g.addColorStop(1, rng.next() < 0.5 ? '#12061e' : b);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, W, H);
  ctx.clip();
  const kind = Math.floor(rng.next() * 5);
  ctx.fillStyle = rng.next() < 0.5 ? '#ffffff' : '#0a0410';
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 4;
  const cx = vertical ? W / 2 : W * (0.25 + rng.next() * 0.2), cy = top + H / 2;
  switch (kind) {
    case 0: ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.fill(); break; // a disc
    case 1: ctx.beginPath(); ctx.moveTo(cx, cy - 22); ctx.lineTo(cx + 22, cy + 18); ctx.lineTo(cx - 22, cy + 18); ctx.closePath(); ctx.fill(); break; // a triangle
    case 2: for (let r = 8; r <= 26; r += 9) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); } break; // rings
    case 3: ctx.beginPath(); ctx.moveTo(cx, cy - 24); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx, cy + 24); ctx.lineTo(cx - 18, cy); ctx.closePath(); ctx.fill(); break; // a diamond
    default: for (let i = 0; i < 6; i++) ctx.fillRect(cx - 24 + i * 8, cy + 18 - i * 7, 6, i * 7 + 4); // a rising bar chart
  }
  // Lettering: a headline and a line or two of small print, all in invented glyphs.
  ctx.fillStyle = '#ffffff';
  if (vertical) {
    for (let i = 0; i < 2; i++) glyph(ctx, W / 2 - 6, top + 4 + i * 30, 4, rng);
  } else {
    const x0 = W * 0.55;
    word(ctx, x0, top + 10, 3, 3 + Math.floor(rng.next() * 2), rng);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    word(ctx, x0, top + 34, 1.5, 6, rng);
    word(ctx, x0, top + 44, 1.5, 5, rng);
    ctx.fillStyle = pick();
    ctx.fillRect(x0, top + 54, 30 + rng.next() * 20, 4); // a call to action bar
  }
  // Scanlines.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = top; y < top + H; y += 3) ctx.fillRect(0, y, W, 1);
  ctx.restore();
}

/** A style's texture: FRAMES slides stacked top to bottom. `vertical` styles are tall, narrow signs. */
export function billboardTexture(style: number, vertical: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H * FRAMES;
  const ctx = canvas.getContext('2d')!;
  const rng = new Rng(1000 + style * 7919);
  for (let f = 0; f < FRAMES; f++) slide(ctx, f * H, rng, vertical);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(1, 1 / FRAMES);
  return tex;
}
