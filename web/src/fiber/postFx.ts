import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Vignette + radial chromatic aberration + peripheral blur in one pass. The centre of the screen
// takes the single-tap fast path, so the cost is only paid towards the edges.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform vec2 uTexel;     // 1 / drawing-buffer size
  uniform float uPx;       // device pixels per CSS pixel
  uniform float uAspect;
  varying vec2 vUv;

  void main() {
    vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(d) / length(vec2(uAspect, 1.0) * 0.5); // 0 centre .. 1 corner
    float edge = smoothstep(0.35, 1.0, r);
    vec2 dir = normalize(d + 1e-6) * vec2(1.0 / uAspect, 1.0);
    vec3 c;
    if (edge < 0.002) {
      c = texture2D(tScene, vUv).rgb;
    } else {
      float ca = edge * 1.5 * uPx;        // up to ~1.5 CSS px at the corners
      float bl = edge * 1.1 * uPx;        // blur radius
      vec2 o = dir * uTexel * ca;
      vec2 b = uTexel * bl;
      vec3 acc = vec3(0.0);
      vec2 offs[4];
      offs[0] = vec2( b.x,  b.y);
      offs[1] = vec2(-b.x,  b.y);
      offs[2] = vec2( b.x, -b.y);
      offs[3] = vec2(-b.x, -b.y);
      for (int i = 0; i < 4; i++) {
        vec2 u = vUv + offs[i];
        acc.r += texture2D(tScene, u + o).r;
        acc.g += texture2D(tScene, u).g;
        acc.b += texture2D(tScene, u - o).b;
      }
      c = acc * 0.25;
    }
    c *= 1.0 - 0.35 * smoothstep(0.55, 1.15, r); // vignette
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * Optional full-screen post pass. The scene is rendered into a half-float target tagged sRGB, so
 * three.js converts built-in materials exactly as it would on screen while the raw custom shaders
 * are untouched; the pass then writes the stored values back unchanged apart from the effect.
 */
export class PostFx {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tScene: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uPx: { value: 1 },
        uAspect: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    // one oversized triangle
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const m = new THREE.Mesh(g, this.mat);
    m.frustumCulled = false;
    this.scene.add(m);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.getDrawingBufferSize(this.size);
    const w = this.size.x;
    const h = this.size.y;
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples: 4,
        depthBuffer: true,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.target.texture.colorSpace = THREE.SRGBColorSpace;
    }
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const u = this.mat.uniforms;
    u.tScene.value = this.target.texture;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uPx.value = renderer.getPixelRatio();
    u.uAspect.value = w / h;
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.target?.dispose();
    this.mat.dispose();
  }
}
