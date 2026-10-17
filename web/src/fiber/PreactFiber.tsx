import { createContext, ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PostFx } from './postFx';
import { rawColor } from '../util/rawColor';

export type FrameCallback = (state: ThreeContextState, delta: number) => void;

/** Bits set by frame callbacks (`perfStats.events`) to say what work happened in a frame. */
export const FRAME_EVENT = {
  uiReport: 1, // 4 Hz HUD/telemetry update
  anchorFullUpload: 2, // every GPU anchor re-uploaded (re-base / seek)
  orbitRecalc: 4, // selected satellite's orbit line recomputed
  styleAll: 8, // selection / filter / search / observer changed: all satellites re-styled
  fullPass: 16, // wasm full pass (jump or forced)
} as const;

/** A frame that ended a long interval, with what ran in it and in the frame before. */
export interface HitchRecord {
  atS: number; // seconds since the page started
  intervalMs: number; // time since the previous frame
  gapMs: number; // time between the previous frame's end and this frame's start (outside our code)
  prevCpuMs: number; // our work in the previous frame (callbacks + render submit)
  cpuMs: number; // our work in this frame
  prevEvents: string[];
  events: string[];
}

export interface RenderPerfStats {
  /** Event bits of the frame in progress (see FRAME_EVENT); reset every frame. */
  events: number;
  /** Most recent frames whose interval exceeded 28 ms (newest last). */
  hitches: HitchRecord[];
  fps: number;
  minFps: number;
  frameTimeMs: number;
  webglRenderMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface ThreeContextState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  perfStats: RenderPerfStats;
  registerFrame: (cb: FrameCallback) => () => void;
  /** Diagnostics (Stall Bisect): when true the loop skips controls and all frame callbacks. */
  debugSkipCallbacks: boolean;
  /** Draws one frame the way the main loop does (through the post pass when it is on). */
  renderFrame: () => void;
}

const ThreeContext = createContext<ThreeContextState | null>(null);

/** Live handle to the renderer/scene for tools outside the canvas tree (e.g. the GPU bench). */
export const threeHandleRef: { current: ThreeContextState | null } = { current: null };

export function useThree(): ThreeContextState {
  const ctx = useContext(ThreeContext);
  if (!ctx) {
    throw new Error('useThree must be used inside PreactFiber <Canvas>');
  }
  return ctx;
}

export function useFrame(cb: FrameCallback): void {
  const { registerFrame } = useThree();
  const cbRef = useRef<FrameCallback>(cb);
  cbRef.current = cb;

  useEffect(() => {
    return registerFrame((state, delta) => {
      cbRef.current(state, delta);
    });
  }, [registerFrame]);
}

interface CanvasProps {
  children?: ComponentChildren;
  cameraPosition?: [number, number, number];
  fov?: number;
  /** Vignette + peripheral chromatic aberration/blur pass (renders through an off-screen target). */
  postFx?: boolean;
  onCanvasClick?: (
    raycaster: THREE.Raycaster,
    event: MouseEvent,
    state: ThreeContextState,
  ) => void;
}

export function Canvas({
  children,
  cameraPosition = [0, 0.85, 2.55],
  fov = 45,
  postFx = false,
  onCanvasClick,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ctxState, setCtxState] = useState<ThreeContextState | null>(null);
  const frameListenersRef = useRef<FrameCallback[]>([]);
  const onCanvasClickRef = useRef(onCanvasClick);
  onCanvasClickRef.current = onCanvasClick;
  const postFxOnRef = useRef(postFx);
  postFxOnRef.current = postFx;

  const registerFrame = useMemo(
    () => (cb: FrameCallback) => {
      frameListenersRef.current.push(cb);
      return () => {
        const idx = frameListenersRef.current.indexOf(cb);
        if (idx !== -1) frameListenersRef.current.splice(idx, 1);
      };
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 250);
    camera.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2]);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    // Cap at 2: on an iPhone (dpr 3, 1320x2388 buffer) the GPU time is small (+0.35 ms vs 2x) but
    // the buffer hand-off stalls the display: every ~0.3 s a ~25 ms submit followed by a 50-70 ms
    // gap (minFps 15); at 2x those stalls are gone (minFps 40). `?dpr=N` overrides it.
    const dprParam = Number(new URLSearchParams(location.search).get('dpr')) || 0;
    renderer.setPixelRatio(dprParam > 0 ? dprParam : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    // linear output: see util/rawColor.ts
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(rawColor(0x02050d), 1);

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.07;
    controls.maxDistance = 7.0;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.9;

    const perfStats: RenderPerfStats = {
      events: 0,
      hitches: [],
      fps: 60,
      minFps: 60,
      frameTimeMs: 16.6,
      webglRenderMs: 0,
      drawCalls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    };

    renderer.info.autoReset = false;
    let post: PostFx | null = null;
    const state: ThreeContextState = {
      scene,
      camera,
      renderer,
      controls,
      perfStats,
      registerFrame,
      debugSkipCallbacks: false,
      renderFrame: () => {
        if (postFxOnRef.current) {
          post ??= new PostFx();
          post.render(renderer, scene, camera);
        } else {
          if (post) {
            post.dispose(); // switched off: give the target memory back
            post = null;
          }
          renderer.render(scene, camera);
        }
      },
    };
    setCtxState(state);
    threeHandleRef.current = state;

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    let downX = 0;
    let downY = 0;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.018 };

    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };

    const onClick = (e: MouseEvent) => {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 25) return;
      if (!onCanvasClickRef.current) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      onCanvasClickRef.current(raycaster, e, state);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('click', onClick);

    let rafId = 0;
    let lastTime = performance.now();
    let smoothedFps = 60;
    const recentFrameTimes = new Float32Array(60);
    let ftCount = 0;
    let ftPtr = 0;

    let prevEnd = performance.now();
    let prevCpu = 0;
    let prevEvents = 0;
    const eventNames = (bits: number) =>
      (Object.keys(FRAME_EVENT) as (keyof typeof FRAME_EVENT)[]).filter((k) => bits & FRAME_EVENT[k]);

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const frameStart = performance.now();
      perfStats.events = 0;
      const dtMs = now - lastTime;
      const delta = dtMs / 1000;
      lastTime = now;

      const hitchPending = dtMs > 28 && dtMs < 3000;
      if (dtMs > 0 && dtMs < 500) {
        const instFps = 1000 / dtMs;
        smoothedFps = smoothedFps * 0.9 + instFps * 0.1;
        recentFrameTimes[ftPtr] = dtMs;
        ftPtr = (ftPtr + 1) % 60;
        if (ftCount < 60) ftCount++;
        let worstDt = dtMs;
        for (let i = 0; i < ftCount; i++) {
          if (recentFrameTimes[i] > worstDt) worstDt = recentFrameTimes[i];
        }
        perfStats.fps = smoothedFps;
        perfStats.minFps = 1000 / worstDt;
        perfStats.frameTimeMs = dtMs;
      }

      if (!state.debugSkipCallbacks) {
        controls.update();
        const listeners = frameListenersRef.current;
        for (let i = 0; i < listeners.length; i++) {
          listeners[i](state, delta);
        }
      }

      renderer.info.reset(); // two render calls per frame with the post pass: count both
      const r0 = performance.now();
      state.renderFrame();
      const r1 = performance.now();

      const cpuMs = r1 - frameStart;
      if (hitchPending) {
        const h = perfStats.hitches;
        h.push({
          atS: +(now / 1000).toFixed(2),
          intervalMs: +dtMs.toFixed(1),
          gapMs: +Math.max(0, frameStart - prevEnd).toFixed(1),
          prevCpuMs: +prevCpu.toFixed(1),
          cpuMs: +cpuMs.toFixed(1),
          prevEvents: eventNames(prevEvents),
          events: eventNames(perfStats.events),
        });
        if (h.length > 12) h.shift();
      }
      prevEnd = r1;
      prevCpu = cpuMs;
      prevEvents = perfStats.events;

      perfStats.webglRenderMs = r1 - r0;
      perfStats.drawCalls = renderer.info.render.calls;
      perfStats.triangles = renderer.info.render.triangles;
      perfStats.points = renderer.info.render.points;
      perfStats.lines = renderer.info.render.lines;
      perfStats.geometries = renderer.info.memory.geometries;
      perfStats.textures = renderer.info.memory.textures;
      perfStats.programs = renderer.info.programs?.length ?? 0;
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      post?.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {ctxState && (
        <ThreeContext.Provider value={ctxState}>
          {children}
        </ThreeContext.Provider>
      )}
    </div>
  );
}
