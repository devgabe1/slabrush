import * as THREE from 'three';

export type RetroMode = 'off' | 'dither' | 'crt';

/**
 * Optional final pass for the early-2000s look. The frame is rendered into an
 * off-screen target (at the low internal resolution), then copied to the
 * screen through a shader that:
 *   - reduces colour depth with an ordered (Bayer) dither, like 15-bit consoles
 *   - darkens the corners a little
 *   - in 'crt' mode, adds scanlines
 * With mode 'off' nothing here runs and the frame goes straight to the screen.
 */
export class RetroPass {
  mode: RetroMode = 'dither';
  private target = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tFrame: { value: null as THREE.Texture | null },
      res: { value: new THREE.Vector2(4, 4) },
      levels: { value: 28 }, // colour steps per channel
      scan: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tFrame;
      uniform vec2 res;
      uniform float levels;
      uniform float scan;
      varying vec2 vUv;

      float bayer(vec2 p) {
        int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
        float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
        return m[x + y * 4] / 16.0;
      }

      void main() {
        vec3 c = texture2D(tFrame, vUv).rgb;
        c = pow(max(c, 0.0), vec3(1.0 / 2.2)); // the target holds linear light; go to display space first
        vec2 px = floor(vUv * res);
        c = floor(c * levels + bayer(px)) / levels; // ordered dither + posterise
        vec2 q = vUv - 0.5;
        c *= 1.0 - dot(q, q) * 0.5; // vignette
        c *= 1.0 - scan * 0.22 * mod(px.y, 2.0); // scanlines
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  constructor(private renderer: THREE.WebGLRenderer) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.material.uniforms.tFrame.value = this.target.texture;
  }

  setSize(w: number, h: number): void {
    this.target.setSize(w, h);
    this.material.uniforms.res.value.set(w, h);
  }

  /** Call before drawing the frame. */
  begin(): void {
    this.renderer.setRenderTarget(this.mode === 'off' ? null : this.target);
  }

  /** Call after drawing the frame. */
  end(): void {
    if (this.mode === 'off') return;
    this.material.uniforms.scan.value = this.mode === 'crt' ? 1 : 0;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
