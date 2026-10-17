// Stall probe: runs a fixed series of rendering experiments on the device, measures the rAF
// interval statistics of each, and reports a table + JSON. It exists to separate the causes of the
// periodic display stalls seen on iPhone at devicePixelRatio 3 (see the Perf "recentHitches").
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type SceneKind = 'clear' | 'full';
interface Exp {
  id: string;
  title: string;
  dpr: number;
  aa: boolean;
  scene: SceneKind;
  heightFrac?: number; // canvas height as a fraction of the viewport (the drawing buffer shrinks too)
  preserve?: boolean;
  skipOdd?: boolean; // render every other frame (30 Hz)
  bigTex?: boolean; // 3 x 4096^2 textures with mipmaps (~270 MB), like the real Earth
  overlay?: 'blur' | 'flat'; // HUD-like DOM panels over the canvas (with / without backdrop-filter)
  upload?: 'none' | 'partial' | 'full'; // per-frame vertex-buffer updates like the real app (anchors etc.)
  comm?: boolean; // plus a small buffer fully rewritten every frame (comm links)
  opaque?: boolean; // WebGL context with alpha:false (the real app)
  orbit?: boolean; // OrbitControls attached to the canvas (touch-action:none, pointer listeners)
  nest?: boolean; // canvas inside nested containers like the app (100dvh, relative, overflow hidden)
  infoReset?: boolean; // renderer.info.autoReset=false + reset() every frame (the real app)
  linear?: boolean; // renderer.outputColorSpace = Linear (the real app)
  c2d?: { count: number; hz: number; scale: number }; // 2D canvases (sky plot + perf chart) redrawn at `hz` (0 = every frame)
}

const WARMUP_S = 1.5;
const MEASURE_S = 8;
const HITCH_MS = 28;

const dprNative = window.devicePixelRatio || 1;
const EXPS_A: Exp[] = [
  { id: 'A1', title: 'full / dpr3 / AA (基準)', dpr: 3, aa: true, scene: 'full' },
  { id: 'A2', title: 'full / dpr2 / AA', dpr: 2, aa: true, scene: 'full' },
  { id: 'A3', title: 'full / dpr3 / AAなし', dpr: 3, aa: false, scene: 'full' },
  { id: 'A4', title: 'clearのみ / dpr3 / AA', dpr: 3, aa: true, scene: 'clear' },
  { id: 'A5', title: 'full / dpr2.5 / AA', dpr: 2.5, aa: true, scene: 'full' },
  { id: 'A6', title: 'full / dpr2.25 / AA', dpr: 2.25, aa: true, scene: 'full' },
  { id: 'A7', title: 'full / dpr2.75 / AA', dpr: 2.75, aa: true, scene: 'full' },
  { id: 'A8', title: 'full / dpr3 / AA / canvas高さ50%', dpr: 3, aa: true, scene: 'full', heightFrac: 0.5 },
  { id: 'A9', title: 'full / dpr3 / AA / preserveDrawingBuffer', dpr: 3, aa: true, scene: 'full', preserve: true },
  { id: 'A10', title: 'full / dpr3 / AA / 30Hz(1フレームおき)', dpr: 3, aa: true, scene: 'full', skipOdd: true },
  { id: 'A11', title: 'full / dpr2 / AAなし', dpr: 2, aa: false, scene: 'full' },
  { id: 'A12', title: 'full / dpr3 / AA (再測定: 熱・順序の影響)', dpr: 3, aa: true, scene: 'full' },
];

// Set B (default): the A set found NO stall with a small scene and no DOM, so these add the
// remaining differences from the real app: big textures (GPU memory) and HUD-like DOM over the canvas.
const EXPS_B: Exp[] = [
  { id: 'B1', title: 'full+大テクスチャ / dpr3 / AA', dpr: 3, aa: true, scene: 'full', bigTex: true },
  { id: 'B2', title: 'full+大テクスチャ / dpr2 / AA', dpr: 2, aa: true, scene: 'full', bigTex: true },
  { id: 'B3', title: 'full / dpr3 / AA / HUD(blurあり)', dpr: 3, aa: true, scene: 'full', overlay: 'blur' },
  { id: 'B4', title: 'full / dpr3 / AA / HUD(blurなし)', dpr: 3, aa: true, scene: 'full', overlay: 'flat' },
  { id: 'B5', title: 'full+大テクスチャ+HUD(blur) / dpr3 / AA (実アプリ相当)', dpr: 3, aa: true, scene: 'full', bigTex: true, overlay: 'blur' },
  { id: 'B6', title: 'full+大テクスチャ+HUD(blur) / dpr2 / AA', dpr: 2, aa: true, scene: 'full', bigTex: true, overlay: 'blur' },
  { id: 'B7', title: 'full+大テクスチャ+HUD(blurなし) / dpr3 / AA', dpr: 3, aa: true, scene: 'full', bigTex: true, overlay: 'flat' },
  { id: 'B8', title: 'full+大テクスチャ+HUD(blur) / dpr3 / AAなし', dpr: 3, aa: false, scene: 'full', bigTex: true, overlay: 'blur' },
];

// Set C: B found no stall either (even big textures + HUD blur), so what is left is the real app's
// per-frame dynamic vertex-buffer uploads (GPU anchors refreshed 1/30 per frame, comm links).
const EXPS_C: Exp[] = [
  { id: 'C1', title: 'full+属性追加 / dpr3 / 更新なし', dpr: 3, aa: true, scene: 'full', upload: 'none' },
  { id: 'C2', title: 'full / dpr3 / 部分更新(1/30)', dpr: 3, aa: true, scene: 'full', upload: 'partial' },
  { id: 'C3', title: 'full / dpr2 / 部分更新(1/30)', dpr: 2, aa: true, scene: 'full', upload: 'partial' },
  { id: 'C4', title: 'full / dpr3 / 部分更新+通信リンク全更新', dpr: 3, aa: true, scene: 'full', upload: 'partial', comm: true },
  { id: 'C5', title: 'full / dpr2 / 部分更新+通信リンク全更新', dpr: 2, aa: true, scene: 'full', upload: 'partial', comm: true },
  { id: 'C6', title: 'full / dpr3 / 全体更新(毎フレーム)', dpr: 3, aa: true, scene: 'full', upload: 'full' },
  { id: 'C7', title: 'full / dpr2 / 全体更新(毎フレーム)', dpr: 2, aa: true, scene: 'full', upload: 'full' },
  { id: 'C8', title: '実アプリ相当(大テクスチャ+HUD blur+部分更新+通信) / dpr3', dpr: 3, aa: true, scene: 'full', bigTex: true, overlay: 'blur', upload: 'partial', comm: true },
];

// Set D (default): C found nothing either, but the REAL app stalls even with an empty scene. These
// add the remaining renderer / page differences of the app, one at a time and then all together.
const EXPS_D: Exp[] = [
  { id: 'D0', title: 'full / dpr3 / 基準', dpr: 3, aa: true, scene: 'full' },
  { id: 'D1', title: 'full / dpr3 / alpha:false', dpr: 3, aa: true, scene: 'full', opaque: true },
  { id: 'D2', title: 'full / dpr3 / OrbitControls', dpr: 3, aa: true, scene: 'full', orbit: true },
  { id: 'D3', title: 'full / dpr3 / 入れ子コンテナ(100dvh)', dpr: 3, aa: true, scene: 'full', nest: true },
  { id: 'D4', title: 'full / dpr3 / info.autoReset=false', dpr: 3, aa: true, scene: 'full', infoReset: true },
  { id: 'D5', title: 'full / dpr3 / outputColorSpace=Linear', dpr: 3, aa: true, scene: 'full', linear: true },
  { id: 'D6', title: 'clear+alpha:false+Orbit+入れ子+info+Linear / dpr3', dpr: 3, aa: true, scene: 'clear', opaque: true, orbit: true, nest: true, infoReset: true, linear: true },
  { id: 'D7', title: 'full+全部入り+大テクスチャ+HUD(blur)+更新 / dpr3', dpr: 3, aa: true, scene: 'full', bigTex: true, overlay: 'blur', upload: 'partial', comm: true, opaque: true, orbit: true, nest: true, infoReset: true, linear: true },
  { id: 'D8', title: 'D7と同じ / dpr2', dpr: 2, aa: true, scene: 'full', bigTex: true, overlay: 'blur', upload: 'partial', comm: true, opaque: true, orbit: true, nest: true, infoReset: true, linear: true },
];

// Set E (default): D found nothing either. The app also has 2D canvases (sky plot, perf chart) that
// are redrawn ~4x a second at devicePixelRatio 3 - hidden HUD (visibility) does not stop that.
const EXPS_E: Exp[] = [
  { id: 'E0', title: 'full / dpr3 / 基準', dpr: 3, aa: true, scene: 'full' },
  { id: 'E1', title: 'full / dpr3 / 2Dキャンバス1枚 4Hz (backing x3)', dpr: 3, aa: true, scene: 'full', c2d: { count: 1, hz: 4, scale: 3 } },
  { id: 'E2', title: 'full / dpr3 / 2Dキャンバス2枚 4Hz (backing x3)', dpr: 3, aa: true, scene: 'full', c2d: { count: 2, hz: 4, scale: 3 } },
  { id: 'E3', title: 'full / dpr3 / 2Dキャンバス2枚 4Hz (backing x1)', dpr: 3, aa: true, scene: 'full', c2d: { count: 2, hz: 4, scale: 1 } },
  { id: 'E4', title: 'full / dpr3 / 2Dキャンバス2枚 毎フレーム (backing x3)', dpr: 3, aa: true, scene: 'full', c2d: { count: 2, hz: 0, scale: 3 } },
  { id: 'E5', title: 'full / dpr2 / 2Dキャンバス2枚 4Hz (backing x3)', dpr: 2, aa: true, scene: 'full', c2d: { count: 2, hz: 4, scale: 3 } },
  { id: 'E6', title: 'full / dpr3 / 2Dキャンバス2枚 1Hz (backing x3)', dpr: 3, aa: true, scene: 'full', c2d: { count: 2, hz: 1, scale: 3 } },
  { id: 'E7', title: 'full / dpr3 / 基準 (再測定)', dpr: 3, aa: true, scene: 'full' },
];

const stage = document.getElementById('stage') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const report = document.getElementById('report') as HTMLDivElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7) & 255;
    data[i + 1] = (i >> 5) & 255;
    data[i + 2] = (i >> 9) & 255;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** HUD-like panels (header, sheet, time bar) over the canvas; one of them updates 4x a second. */
function makeOverlay(kind: 'blur' | 'flat'): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none';
  const panel = (css: string) => {
    const d = document.createElement('div');
    const blur = kind === 'blur' ? 'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' : '';
    d.style.cssText = `position:absolute;left:8px;right:8px;border-radius:12px;border:1px solid rgba(56,189,248,.35);background:rgba(8,16,32,.55);${blur}${css}`;
    root.appendChild(d);
    return d;
  };
  panel('top:8px;height:52px');
  panel('bottom:210px;height:72px');
  const bar = panel('bottom:8px;height:140px;color:#7dd3fc;font:14px monospace;padding:8px');
  const timer = window.setInterval(() => {
    bar.textContent = new Date().toISOString();
  }, 250);
  (root as unknown as { stop: () => void }).stop = () => window.clearInterval(timer);
  return root;
}

function makeFullScene(bigTex: boolean, upload: 'none' | 'partial' | 'full', comm: boolean) {
  const scene = new THREE.Scene();
  // an Earth-like sphere: 4 texture fetches + a little math in the fragment shader (a stand-in for the real one)
  const small = makeTexture(1024);
  const t0 = bigTex ? makeTexture(4096) : small;
  const t1 = bigTex ? makeTexture(4096) : small;
  const t2 = bigTex ? makeTexture(4096) : small;
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: { t0: { value: t0 }, t1: { value: t1 }, t2: { value: t2 }, time: { value: 0 } },
      vertexShader:
        'varying vec2 vUv; varying vec3 vN; void main(){ vUv=uv; vN=normalMatrix*normal; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:
        'uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform float time; varying vec2 vUv; varying vec3 vN; void main(){ vec3 a=texture2D(t0,vUv).rgb; vec3 b=texture2D(t1,vUv*3.0+time*0.01).rgb; vec3 c=texture2D(t2,vUv*7.0).rgb; vec3 d=texture2D(t0,vUv*13.0).rgb; float l=max(dot(normalize(vN),vec3(0.5,0.4,0.8)),0.0); gl_FragColor=vec4((a*0.5+b*0.2+c*0.2+d*0.1)*(0.2+l),1.0);}',
    }),
  );
  scene.add(earth);
  // ~10.6k additive points on a shell (the satellites)
  const n = 10652;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 1.08 + Math.random() * 0.05;
    const th = Math.acos(2 * Math.random() - 1);
    const ph = Math.random() * Math.PI * 2;
    pos[i * 3] = r * Math.sin(th) * Math.cos(ph);
    pos[i * 3 + 1] = r * Math.cos(th);
    pos[i * 3 + 2] = r * Math.sin(th) * Math.sin(ph);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // dynamic vertex data like the GPU path: anchor position/velocity (2 x vec3) + anchor time, in two
  // geometries (points + trail quads stand-in), each with its own GL buffers
  const dyn: THREE.BufferAttribute[] = [];
  const mkDyn = (geom: THREE.BufferGeometry) => {
    for (const [name, size] of [['aPa', 3], ['aPb', 3], ['aT', 1]] as const) {
      const a = new THREE.BufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute(name, a);
      dyn.push(a);
    }
  };
  mkDyn(g);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader:
      'attribute vec3 aPa; attribute vec3 aPb; attribute float aT; void main(){ vec3 p=position+(aPa+aPb)*1e-9+vec3(aT*1e-9); gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); gl_PointSize=3.0; }',
    fragmentShader: 'void main(){ gl_FragColor=vec4(0.3,0.6,0.9,0.5); }',
  });
  const pts = new THREE.Points(g, mat);
  scene.add(pts);
  // second geometry (trails stand-in): a second set of dynamic buffers on a few points
  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  mkDyn(g2);
  const pts2 = new THREE.Points(g2, mat);
  scene.add(pts2);
  // comm links: ~1200 segments rewritten every frame
  const commArr = new Float32Array(3600 * 3);
  const cg = new THREE.BufferGeometry();
  const ca = new THREE.BufferAttribute(commArr, 3);
  ca.setUsage(THREE.DynamicDrawUsage);
  cg.setAttribute("position", ca);
  if (!comm) cg.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.4 }));
  lines.frustumCulled = false;
  scene.add(lines);
  let cursor = 0;
  const update = () => {
    if (upload === 'none') return;
    const k = 30;
    const lo = Math.floor((n * (cursor % k)) / k);
    const hi = Math.floor((n * ((cursor % k) + 1)) / k);
    cursor++;
    for (const a of dyn) {
      const sz = a.itemSize;
      a.array[lo * sz] = cursor; // touch the data so it is not constant
      if (upload === 'partial') {
        a.clearUpdateRanges();
        a.addUpdateRange(lo * sz, (hi - lo) * sz);
      }
      a.needsUpdate = true;
    }
    if (comm) {
      for (let i = 0; i < 90; i++) commArr[i * 3] = Math.sin(cursor * 0.1 + i);
      ca.needsUpdate = true;
      cg.setDrawRange(0, 1200);
    }
  };
  return { scene, earth, pts, update };
}

interface Result {
  id: string;
  title: string;
  buffer: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  hitches: number;
  hitchesPerS: number;
  hitchSpacingMs: number | null;
  slowSubmits: number; // frames whose render() call took > 8 ms of CPU
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function runExp(exp: Exp, idx: number, total: number): Promise<Result> {
  stage.innerHTML = '';
  let host: HTMLElement = stage;
  if (exp.nest) {
    // like the app: a 100dvh root > relative 100% wrapper > canvas
    const outer = document.createElement('div');
    outer.style.cssText = 'position:absolute;inset:0;height:100dvh;overflow:hidden';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:100%;height:100%;position:relative';
    outer.appendChild(inner);
    stage.appendChild(outer);
    host = inner;
  }
  const w = window.innerWidth;
  const h = Math.round(window.innerHeight * (exp.heightFrac ?? 1));
  const renderer = new THREE.WebGLRenderer({
    antialias: exp.aa,
    alpha: !exp.opaque,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: !!exp.preserve,
  });
  renderer.setPixelRatio(exp.dpr);
  renderer.setSize(w, h);
  renderer.setClearColor(0x02050d, 1);
  if (exp.linear) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  if (exp.infoReset) renderer.info.autoReset = false;
  host.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  camera.position.set(0, 0.4, 2.2);
  camera.lookAt(0, 0, 0);
  const controls = exp.orbit ? new OrbitControls(camera, renderer.domElement) : null;
  if (controls) controls.enableDamping = true;
  const full = exp.scene === 'full' ? makeFullScene(!!exp.bigTex, exp.upload ?? 'none', !!exp.comm) : null;
  const overlay = exp.overlay ? makeOverlay(exp.overlay) : null;
  if (overlay) document.body.appendChild(overlay);
  const emptyScene = new THREE.Scene();
  const buffer = `${renderer.domElement.width}x${renderer.domElement.height}`;
  // 2D canvases like the sky plot (280x280 css) and the perf chart (400x80 css), shown over the canvas
  const c2ds: { ctx: CanvasRenderingContext2D; w: number; h: number; el: HTMLCanvasElement }[] = [];
  if (exp.c2d) {
    const sizes = [[280, 280], [400, 80]];
    for (let i = 0; i < exp.c2d.count; i++) {
      const [cw, ch] = sizes[i];
      const el = document.createElement('canvas');
      el.width = cw * exp.c2d.scale;
      el.height = ch * exp.c2d.scale;
      el.style.cssText = `position:fixed;z-index:1;left:8px;top:${8 + i * 300}px;width:${cw}px;height:${ch}px;background:rgba(8,16,32,.5);border-radius:8px`;
      document.body.appendChild(el);
      c2ds.push({ ctx: el.getContext('2d')!, w: cw, h: ch, el });
    }
  }
  let lastC2d = 0;
  const drawC2d = (now: number) => {
    for (const c of c2ds) {
      const { ctx, w, h } = c;
      ctx.setTransform(c.el.width / w, 0, 0, c.el.height / h, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(148,163,184,.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2 - 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#34d399';
      for (let k = 0; k < 70; k++) {
        const a = k * 0.7 + now / 1000;
        ctx.beginPath();
        ctx.arc(w / 2 + Math.cos(a) * (k % 9) * 12, h / 2 + Math.sin(a) * (k % 9) * 9, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const intervals: number[] = [];
  const hitchAt: number[] = [];
  let slowSubmits = 0;
  let frame = 0;
  let last = 0;
  let t0 = 0;
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      if (t0 === 0) t0 = now;
      const elapsed = (now - t0) / 1000;
      if (last !== 0 && elapsed > WARMUP_S) {
        const dt = now - last;
        intervals.push(dt);
        if (dt > HITCH_MS) hitchAt.push(now);
      }
      last = now;
      if (elapsed > WARMUP_S + MEASURE_S) {
        resolve();
        return;
      }
      frame++;
      if (!(exp.skipOdd && frame % 2 === 1)) {
        if (full) {
          full.earth.rotation.y += 0.002;
          full.pts.rotation.y += 0.002;
          full.update();
          (full.earth.material as THREE.ShaderMaterial).uniforms.time.value = now / 1000;
        }
        if (c2ds.length && (exp.c2d!.hz === 0 || now - lastC2d >= 1000 / exp.c2d!.hz)) {
          lastC2d = now;
          drawC2d(now);
        }
        controls?.update();
        if (exp.infoReset) renderer.info.reset();
        const r0 = performance.now();
        renderer.render(full ? full.scene : emptyScene, camera);
        if (performance.now() - r0 > 8 && elapsed > WARMUP_S) slowSubmits++;
      }
      if (frame % 20 === 0) {
        const left = Math.max(0, Math.ceil(WARMUP_S + MEASURE_S - elapsed));
        hud.textContent = `[${idx + 1}/${total}] ${exp.id} ${exp.title}  残り${left}s`;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const sorted = intervals.slice().sort((a, b) => a - b);
  const sum = intervals.reduce((a, b) => a + b, 0);
  // cluster hitches closer than 150 ms into one event, then take the spacing between events
  const events: number[] = [];
  for (const t of hitchAt) if (events.length === 0 || t - events[events.length - 1] > 150) events.push(t);
  const spacings: number[] = [];
  for (let i = 1; i < events.length; i++) spacings.push(events[i] - events[i - 1]);
  spacings.sort((a, b) => a - b);
  const res: Result = {
    id: exp.id,
    title: exp.title,
    buffer,
    frames: intervals.length,
    fps: +(1000 / (sum / Math.max(1, intervals.length))).toFixed(1),
    p50: +pct(sorted, 0.5).toFixed(1),
    p95: +pct(sorted, 0.95).toFixed(1),
    p99: +pct(sorted, 0.99).toFixed(1),
    maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(0),
    hitches: hitchAt.length,
    hitchesPerS: +(hitchAt.length / MEASURE_S).toFixed(2),
    hitchSpacingMs: spacings.length ? Math.round(spacings[Math.floor(spacings.length / 2)]) : null,
    slowSubmits,
  };
  (overlay as unknown as { stop?: () => void } | null)?.stop?.();
  overlay?.remove();
  full?.earth.geometry.dispose();
  const mat = full?.earth.material as THREE.ShaderMaterial | undefined;
  if (mat) for (const k of ['t0', 't1', 't2']) (mat.uniforms[k].value as THREE.Texture).dispose();
  c2ds.forEach((c) => c.el.remove());
  controls?.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  stage.innerHTML = '';
  await sleep(600); // let the browser release the buffers between experiments
  return res;
}

function copyText(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function show(results: Result[], startedAt: string) {
  hud.style.display = 'none';
  const json = JSON.stringify(
    {
      kind: 'stall-probe',
      startedAt,
      device: {
        userAgent: navigator.userAgent,
        devicePixelRatio: dprNative,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        screen: `${screen.width}x${screen.height}`,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      hitchThresholdMs: HITCH_MS,
      results,
    },
    null,
    2,
  );
  const rows = results
    .map((r) => {
      const bad = r.hitchesPerS > 0.5 || r.p99 > 40;
      return `<tr><td>${r.id} ${r.title}<br><span style="color:#64748b">${r.buffer}</span></td><td>${r.fps}</td><td>${r.p50}</td><td>${r.p99}</td><td>${r.maxMs}</td><td class="${bad ? 'bad' : 'ok'}">${r.hitchesPerS}</td><td>${r.hitchSpacingMs ?? '-'}</td><td>${r.slowSubmits}</td></tr>`;
    })
    .join('');
  report.style.display = 'block';
  report.innerHTML = `<div style="font-size:15px;color:#e2e8f0;margin-bottom:6px">Stall probe 結果 (各 ${MEASURE_S}s)</div>
    <button id="copy">JSONをコピー</button><button id="again">もう一度</button><span id="msg"></span>
    <table><tr><th>実験</th><th>fps</th><th>p50</th><th>p99</th><th>max</th><th>停止/s</th><th>間隔ms</th><th>遅submit</th></tr>${rows}</table>
    <p style="color:#94a3b8">停止/s: ${HITCH_MS}ms超の間隔(150ms以内は1件)。間隔ms: 停止同士の中央値。遅submit: render()が8ms超の回数。</p>
    <textarea id="json" readonly></textarea>`;
  (document.getElementById('json') as HTMLTextAreaElement).value = json;
  document.getElementById('copy')!.onclick = () => {
    const ok = copyText(json);
    document.getElementById('msg')!.textContent = ok ? ' コピーしました' : ' 下のテキストを長押しでコピーしてください';
    if (!ok) {
      const ta = document.getElementById('json') as HTMLTextAreaElement;
      ta.removeAttribute('readonly');
      ta.focus();
      ta.select();
    }
  };
  document.getElementById('again')!.onclick = () => location.reload();
}

async function main() {
  const params = new URLSearchParams(location.search);
  const only = params.get('only')?.split(',');
  const setName = params.get('set');
  const all = setName === 'A' ? EXPS_A : setName === 'B' ? EXPS_B : setName === 'C' ? EXPS_C : setName === 'D' ? EXPS_D : EXPS_E;
  const list = only ? all.filter((e) => only.includes(e.id)) : all;
  hud.textContent = `Stall probe: ${list.length} 実験 x ${WARMUP_S + MEASURE_S}s。画面に触れずそのままお待ちください。`;
  await sleep(2500);
  const startedAt = new Date().toISOString();
  const results: Result[] = [];
  for (let i = 0; i < list.length; i++) {
    results.push(await runExp(list[i], i, list.length));
  }
  show(results, startedAt);
  (window as unknown as { __stallResults: Result[] }).__stallResults = results;
}

main().catch((e) => {
  hud.textContent = `失敗: ${e?.message ?? e}`;
});
