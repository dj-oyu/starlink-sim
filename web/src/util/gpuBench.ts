import * as THREE from 'three';
import type { ThreeContextState } from '../fiber/PreactFiber';
import type { EarthVisualSettings } from '../components/EarthGlobe';
import { collectDeviceInfo } from './clipboard';

/**
 * On-device GPU cost benchmark.
 *
 * Safari has no GPU timer queries, so GPU time is measured by rendering N frames
 * back-to-back and then forcing completion with a 1-pixel `readPixels`; total / N gives
 * ms per frame even with iOS's 1 ms timer resolution. This includes driver + submit cost
 * (it is a throughput number for the WebGL work, not a pure GPU-busy time). Browser
 * compositing (e.g. `backdrop-filter` on the HUD) is NOT part of it, so a separate
 * end-to-end rAF fps comparison is made with the HUD hidden / blur disabled.
 */
export interface GpuBenchDeps {
  handle: ThreeContextState;
  settings: EarthVisualSettings;
  /** Replace the app's visual settings and resolve once they have been applied. */
  applySettings: (settings: EarthVisualSettings) => Promise<void>;
  onProgress: (msg: string) => void;
}

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await raf();
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

interface Timing {
  median: number;
  min: number;
}

function syncRenderMs(h: ThreeContextState, n = 20, reps = 7): Timing {
  const { renderer, scene, camera } = h;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const px = new Uint8Array(4);
  const once = () => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // forces the GPU to finish
    return (performance.now() - t0) / n;
  };
  once(); // warm-up (shader compile, uploads)
  const r: number[] = [];
  for (let i = 0; i < reps; i++) r.push(once());
  return { median: +median(r).toFixed(2), min: +Math.min(...r).toFixed(2) };
}

async function e2eFps(seconds: number): Promise<{ fps: number; worstMs: number }> {
  let last = await raf();
  const t0 = last;
  let n = 0;
  let worst = 0;
  while (last - t0 < seconds * 1000) {
    const t = await raf();
    worst = Math.max(worst, t - last);
    last = t;
    n++;
  }
  return { fps: +((n * 1000) / (last - t0)).toFixed(1), worstMs: +worst.toFixed(1) };
}

export async function runGpuBench(d: GpuBenchDeps): Promise<Record<string, unknown>> {
  const { handle } = d;
  const { renderer, scene } = handle;
  const original = d.settings;
  const startRatio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  const out: Record<string, unknown> = { device: collectDeviceInfo() };

  const withHidden = (names: string[], fn: () => Timing) => {
    const objs = names
      .map((n) => scene.getObjectByName(n))
      .filter((o): o is THREE.Object3D => !!o);
    const prev = objs.map((o) => o.visible);
    objs.forEach((o) => (o.visible = false));
    const v = fn();
    objs.forEach((o, i) => (o.visible = prev[i]));
    return v;
  };
  const setRatio = (r: number) => {
    renderer.setPixelRatio(r);
    renderer.setSize(size.x, size.y, false);
  };

  // min = least-disturbed run (GPU clocks/scheduling add noise upwards); median = typical
  const rows: { label: string; medianMs: number; minMs: number }[] = [];
  const add = (label: string, t: Timing) => rows.push({ label, medianMs: t.median, minMs: t.min });
  const step = (msg: string) => d.onProgress(msg);

  try {
    step('基準 (現在の設定)');
    await frames(2);
    out.drawingBuffer = `${renderer.domElement.width}x${renderer.domElement.height}`;
    out.pixelRatio = startRatio;
    add('current', syncRenderMs(handle));
    out.rendererInfo = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      points: renderer.info.render.points,
      lines: renderer.info.render.lines,
    };

    step('空シーン (固定オーバーヘッド)');
    const prevVisible = scene.visible;
    scene.visible = false;
    add('empty scene (fixed overhead)', syncRenderMs(handle));
    scene.visible = prevVisible;

    for (const r of [1, 1.5, 2, 3]) {
      step(`ピクセル比 ${r}`);
      setRatio(r);
      await frames(2);
      add(
        `pixelRatio ${r} (${renderer.domElement.width}x${renderer.domElement.height})`,
        syncRenderMs(handle),
      );
    }
    setRatio(startRatio);
    await frames(2);

    step('オブジェクト別');
    add('without satellites', withHidden(['satellites'], () => syncRenderMs(handle)));
    add('without trails', withHidden(['trails'], () => syncRenderMs(handle)));
    add('without comm links', withHidden(['commlinks'], () => syncRenderMs(handle)));
    add(
      'earth only (no satellites/trails/links)',
      withHidden(['satellites', 'trails', 'commlinks'], () => syncRenderMs(handle)),
    );

    const variants: [string, Partial<EarthVisualSettings>][] = [
      ['clouds off', { showClouds: false }],
      ['atmosphere off', { showAtmosphere: false }],
      ['lens flare off', { showFlare: false }],
      ['day/night shading off', { dayNightShading: false }],
      [
        'clouds+atmosphere+day/night off',
        { showClouds: false, showAtmosphere: false, dayNightShading: false },
      ],
      ['mode hybrid (vector)', { mode: 'hybrid' }],
      ['mode tactical (grid)', { mode: 'tactical' }],
    ];
    for (const [label, patch] of variants) {
      step(label);
      await d.applySettings({ ...original, ...patch });
      await frames(3);
      add(label, syncRenderMs(handle));
    }
    await d.applySettings(original);
    await frames(3);

    out.webglSyncMsPerFrame = rows;

    // End-to-end frame rate incl. browser compositing (HUD blur etc.)
    const root = document.documentElement;
    const e2e: Record<string, { fps: number; worstMs: number }> = {};
    step('実フレームレート (通常)');
    e2e['normal'] = await e2eFps(2.5);
    root.classList.add('bench-no-blur');
    step('実フレームレート (HUD のぼかしなし)');
    e2e['hud blur off'] = await e2eFps(2.5);
    root.classList.add('bench-hud-hidden');
    step('実フレームレート (HUD 非表示)');
    e2e['hud hidden'] = await e2eFps(2.5);
    root.classList.remove('bench-no-blur', 'bench-hud-hidden');
    out.endToEndFps = e2e;
  } finally {
    setRatio(startRatio);
    scene.visible = true;
    document.documentElement.classList.remove('bench-no-blur', 'bench-hud-hidden');
    await d.applySettings(original);
  }
  return out;
}
