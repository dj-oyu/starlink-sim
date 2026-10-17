// Stall probe: runs a fixed series of rendering experiments on the device, measures the rAF
// interval statistics of each, and reports a table + JSON. It exists to separate the causes of the
// periodic display stalls seen on iPhone at devicePixelRatio 3 (see the Perf "recentHitches").
import * as THREE from 'three';

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

function makeFullScene(bigTex: boolean) {
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
  const pts = new THREE.Points(
    g,
    new THREE.PointsMaterial({ size: 0.012, color: 0x7dd3fc, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  scene.add(pts);
  return { scene, earth, pts };
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
  const w = window.innerWidth;
  const h = Math.round(window.innerHeight * (exp.heightFrac ?? 1));
  const renderer = new THREE.WebGLRenderer({
    antialias: exp.aa,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: !!exp.preserve,
  });
  renderer.setPixelRatio(exp.dpr);
  renderer.setSize(w, h);
  renderer.setClearColor(0x02050d, 1);
  stage.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  camera.position.set(0, 0.4, 2.2);
  camera.lookAt(0, 0, 0);
  const full = exp.scene === 'full' ? makeFullScene(!!exp.bigTex) : null;
  const overlay = exp.overlay ? makeOverlay(exp.overlay) : null;
  if (overlay) document.body.appendChild(overlay);
  const emptyScene = new THREE.Scene();
  const buffer = `${renderer.domElement.width}x${renderer.domElement.height}`;

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
          (full.earth.material as THREE.ShaderMaterial).uniforms.time.value = now / 1000;
        }
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
  const all = params.get('set') === 'A' ? EXPS_A : EXPS_B;
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
