import { createContext, ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type FrameCallback = (state: ThreeContextState, delta: number) => void;

export interface RenderPerfStats {
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
}

const ThreeContext = createContext<ThreeContextState | null>(null);

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
  onCanvasClick,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ctxState, setCtxState] = useState<ThreeContextState | null>(null);
  const frameListenersRef = useRef<FrameCallback[]>([]);
  const onCanvasClickRef = useRef(onCanvasClick);
  onCanvasClickRef.current = onCanvasClick;

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x02050d, 1);

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

    const state: ThreeContextState = {
      scene,
      camera,
      renderer,
      controls,
      perfStats,
      registerFrame,
    };
    setCtxState(state);

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

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const dtMs = now - lastTime;
      const delta = dtMs / 1000;
      lastTime = now;

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

      controls.update();
      const listeners = frameListenersRef.current;
      for (let i = 0; i < listeners.length; i++) {
        listeners[i](state, delta);
      }

      const r0 = performance.now();
      renderer.render(scene, camera);
      const r1 = performance.now();

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
