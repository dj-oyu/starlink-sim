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
    for (let i = 0; i < n; i++) h.renderFrame();
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

// ---------------------------------------------------------------------------------------------
// Stall bisect: the periodic display stalls seen on iPhone at dpr 3 did not reproduce in the
// standalone probe (/stall.html), so this runs the REAL app with one feature switched off at a time
// and counts rAF intervals > 28 ms for each variant.

export interface StallBisectDeps {
  handle: ThreeContextState;
  settings: EarthVisualSettings;
  applySettings: (settings: EarthVisualSettings) => Promise<void>;
  setPostFx: (on: boolean) => Promise<void>;
  /** Freeze / resume all wasm propagation work (the engine's debug switch). */
  setFrozen: (frozen: boolean) => void;
  onProgress: (msg: string) => void;
}

interface StallVariant {
  label: string;
  apply: () => Promise<void>;
  revert: () => Promise<void>;
}

export async function runStallBisect(d: StallBisectDeps): Promise<Record<string, unknown>> {
  const { handle } = d;
  const { scene, renderer } = handle;
  const original = d.settings;
  const WARMUP_MS = 1200;
  const MEASURE_MS = 8000;
  const HITCH_MS = 28;

  const hide = (names: string[]): StallVariant => {
    let prev: boolean[] = [];
    let objs: THREE.Object3D[] = [];
    return {
      label: `非表示: ${names.join('+')}`,
      apply: async () => {
        objs = names.map((n) => scene.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
        prev = objs.map((o) => o.visible);
        objs.forEach((o) => (o.visible = false));
      },
      revert: async () => objs.forEach((o, i) => (o.visible = prev[i])),
    };
  };
  const settingsVariant = (label: string, patch: Partial<EarthVisualSettings>): StallVariant => ({
    label,
    apply: () => d.applySettings({ ...original, ...patch }),
    revert: () => d.applySettings(original),
  });
  const root = document.documentElement;
  const startRatio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  const variants: StallVariant[] = [
    { label: '基準 (現在の設定)', apply: async () => {}, revert: async () => {} },
    hide(['satellites']),
    hide(['trails']),
    hide(['commlinks']),
    hide(['satellites', 'trails', 'commlinks']),
    settingsVariant('雲・大気・昼夜OFF', { showClouds: false, showAtmosphere: false, dayNightShading: false }),
    settingsVariant('レンズフレアOFF', { showFlare: false }),
    {
      label: 'Lens FX(後処理)OFF',
      apply: () => d.setPostFx(false),
      revert: () => d.setPostFx(true),
    },
    {
      label: 'HUD非表示',
      apply: async () => root.classList.add('bench-hud-hidden'),
      revert: async () => root.classList.remove('bench-hud-hidden'),
    },
    {
      label: 'wasm計算を停止',
      apply: async () => d.setFrozen(true),
      revert: async () => d.setFrozen(false),
    },
    {
      label: '空シーン (scene.visible=false)',
      apply: async () => {
        scene.visible = false;
      },
      revert: async () => {
        scene.visible = true;
      },
    },
    {
      label: 'フレームコールバック・controls停止 (描画のみ)',
      apply: async () => {
        handle.debugSkipCallbacks = true;
      },
      revert: async () => {
        handle.debugSkipCallbacks = false;
      },
    },
    {
      label: '空シーン + コールバック停止 + HUD非表示 (ループのみ)',
      apply: async () => {
        scene.visible = false;
        handle.debugSkipCallbacks = true;
        root.classList.add('bench-hud-hidden');
      },
      revert: async () => {
        scene.visible = true;
        handle.debugSkipCallbacks = false;
        root.classList.remove('bench-hud-hidden');
      },
    },
    {
      label: 'ピクセル比2 (対照: 消えるはず)',
      apply: async () => {
        renderer.setPixelRatio(2);
        renderer.setSize(size.x, size.y, false);
      },
      revert: async () => {
        renderer.setPixelRatio(startRatio);
        renderer.setSize(size.x, size.y, false);
      },
    },
    {
      label: '地球のみ (衛星・軌跡・リンク・HUD・wasm停止)',
      apply: async () => {
        await hide(['satellites', 'trails', 'commlinks']).apply();
        root.classList.add('bench-hud-hidden');
        d.setFrozen(true);
      },
      revert: async () => {
        d.setFrozen(false);
        root.classList.remove('bench-hud-hidden');
      },
    },
  ];
  // hide() keeps its restore state per instance, so keep the objects used for 'earth only' reversible
  const earthOnlyHidden = hide(['satellites', 'trails', 'commlinks']);
  variants[variants.length - 1] = {
    label: variants[variants.length - 1].label,
    apply: async () => {
      await earthOnlyHidden.apply();
      root.classList.add('bench-hud-hidden');
      d.setFrozen(true);
    },
    revert: async () => {
      d.setFrozen(false);
      root.classList.remove('bench-hud-hidden');
      await earthOnlyHidden.revert();
    },
  };

  const results: Record<string, unknown>[] = [];
  const measure = async () => {
    const intervals: number[] = [];
    const hitchAt: number[] = [];
    let last = await raf();
    const t0 = last;
    while (last - t0 < WARMUP_MS + MEASURE_MS) {
      const t = await raf();
      if (last - t0 > WARMUP_MS) {
        intervals.push(t - last);
        if (t - last > HITCH_MS) hitchAt.push(t);
      }
      last = t;
    }
    const sorted = intervals.slice().sort((a, b) => a - b);
    const events: number[] = [];
    for (const t of hitchAt) if (events.length === 0 || t - events[events.length - 1] > 150) events.push(t);
    const gaps: number[] = [];
    for (let i = 1; i < events.length; i++) gaps.push(events[i] - events[i - 1]);
    gaps.sort((a, b) => a - b);
    const sum = intervals.reduce((a, b) => a + b, 0);
    return {
      fps: +((intervals.length * 1000) / Math.max(1, sum)).toFixed(1),
      p99Ms: +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0).toFixed(1),
      maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(0),
      hitches: hitchAt.length,
      hitchesPerS: +(hitchAt.length / (MEASURE_MS / 1000)).toFixed(2),
      hitchSpacingMs: gaps.length ? Math.round(gaps[gaps.length >> 1]) : null,
    };
  };

  try {
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      d.onProgress(`[${i + 1}/${variants.length}] ${v.label}`);
      await v.apply();
      await frames(3);
      results.push({ variant: v.label, ...(await measure()) });
      await v.revert();
      await frames(3);
    }
  } finally {
    handle.debugSkipCallbacks = false;
    scene.visible = true;
    renderer.setPixelRatio(startRatio);
    renderer.setSize(size.x, size.y, false);
    d.setFrozen(false);
    document.documentElement.classList.remove('bench-hud-hidden');
    await d.applySettings(original);
  }
  return {
    kind: 'stall-bisect',
    device: collectDeviceInfo(),
    pixelRatio: renderer.getPixelRatio(),
    drawingBuffer: `${renderer.domElement.width}x${renderer.domElement.height}`,
    hitchThresholdMs: HITCH_MS,
    results,
  };
}
