import { useEffect, useMemo, useRef } from 'preact/hooks';
import * as THREE from 'three';
import { useFrame, useThree, RenderPerfStats } from '../fiber/PreactFiber';
import {
  StarlinkSimEngine,
  ObserverConfig,
  EARTH_RADIUS_KM,
  latLonAltToThree,
  SatelliteTelemetry,
} from '../wasm/simEngine';
import { EarthGlobe, EarthVisualSettings } from './EarthGlobe';

export interface FullPerfSnapshot extends RenderPerfStats {
  wasmPureSgp4Ms: number;
  wasmSlices: number;
  wasmFullPassMs: number;
  gpuPath: boolean;
  calibrationMs: number;
  wasmReadoutMs: number;
  threeBufferSyncMs: number;
  wasmMemoryBytes: number;
  jsHeapMb: number | null;
}

interface ConstellationViewProps {
  engine: StarlinkSimEngine;
  simTimeMsRef: { current: number };
  isPlaying: boolean;
  timeScale: number;
  enabledShells: boolean[];
  searchMatchIndices: Set<number> | null;
  selectedSatIndex: number | null;
  followSelected: boolean;
  showGroundTrack: boolean;
  observer: ObserverConfig;
  showCommLinks: boolean;
  visualSettings: EarthVisualSettings;
  pointsRef: { current: THREE.Points | null };
  earthMeshRef: { current: THREE.Mesh | null };
  viewCommandsRef?: { current: ViewCommands | null };
  showTrails?: boolean;
  onFrameStats: (
    simTimeMs: number,
    visibleCount: number,
    perf: FullPerfSnapshot,
    selectedTelemetry: SatelliteTelemetry | null,
  ) => void;
}

/** Camera operations exposed to the HUD (map-style zoom / home / focus buttons). */
export interface ViewCommands {
  zoom: (factor: number) => void;
  resetView: () => void;
  focusGroundStation: () => void;
  focusSatellite: (idx: number) => void;
  setAutoRotate: (on: boolean) => void;
}

/** Anchor buffers and shared uniforms of the GPU position path (`?gpu=1`). */
interface GpuBuffers {
  pvPoints: THREE.InterleavedBuffer;
  pvTrail: THREE.InstancedInterleavedBuffer;
  tPoints: THREE.BufferAttribute;
  tTrail: THREE.InstancedBufferAttribute;
  styleTrail: THREE.InstancedBufferAttribute;
  uniforms: Record<string, { value: number }>;
}

/** Smooth camera transition state (preallocated; advanced once per frame). */
interface CameraFlight {
  active: boolean;
  t: number;
  dur: number;
  fromDir: THREE.Vector3;
  toDir: THREE.Vector3;
  fromDist: number;
  toDist: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

const _flyQFull = new THREE.Quaternion();
const _flyQPart = new THREE.Quaternion();
const _flyQId = new THREE.Quaternion();
const _flyDir = new THREE.Vector3();
const _origin = new THREE.Vector3(0, 0, 0);

/** Camera distance that fits the whole globe in the viewport (portrait screens sit further back). */
function fitCameraDistance(
  cam: THREE.PerspectiveCamera,
  controls: { minDistance: number; maxDistance: number },
): number {
  const aspect = cam.aspect > 0 ? cam.aspect : 1;
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
  return Math.min(
    controls.maxDistance,
    Math.max(controls.minDistance, 1.1 / (tanHalf * Math.min(aspect, 1))),
  );
}

/**
 * GPU Vertex Shader with built-in SIMT palette lookup:
 * Instead of uploading 3x Float32 RGB colors (128 KB) + 1x Float32 size (42 KB) from CPU,
 * CPU passes a single packed float `aStyle`:
 *  -1.0       : Hidden / Filtered out
 *   0.0 .. 4.0: Orbital Shell 0..4 normal (size 2.4, dimmed)
 *  10.0 ..14.0: Orbital Shell 0..4 search-highlighted (size 4.8)
 *  16.0       : In Ground Station Dish FOV (Emerald, size 5.4)
 *  24.0       : Selected Satellite (Gold, size 8.5)
 */
const SAT_POINTS_VERT = /* glsl */ `
  attribute float aStyle;
  varying vec3 vColor;
  varying float vIntensity;

  vec3 getShellColor(float s) {
    if (s < 0.5) return vec3(0.22, 0.74, 0.97);
    if (s < 1.5) return vec3(0.65, 0.55, 0.98);
    if (s < 2.5) return vec3(0.20, 0.83, 0.60);
    if (s < 3.5) return vec3(0.96, 0.45, 0.71);
    return vec3(0.98, 0.57, 0.24);
  }

  void main() {
    if (aStyle < -0.5) {
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vColor = vec3(0.0);
      return;
    }

    // Background constellation is deliberately small and dim so that only the
    // satellites that matter (in dish FOV, search hits, selection) stand out.
    float baseSize = 2.4;
    vIntensity = 0.75;
    if (aStyle > 20.0) {
      vColor = vec3(1.0, 0.92, 0.25);
      baseSize = 8.5;
      vIntensity = 1.0;
    } else if (aStyle > 15.0) {
      vColor = vec3(0.15, 1.0, 0.55);
      baseSize = 5.4;
      vIntensity = 1.0;
    } else if (aStyle >= 9.5) {
      vColor = getShellColor(aStyle - 10.0);
      baseSize = 4.8;
      vIntensity = 1.0;
    } else {
      vColor = getShellColor(aStyle);
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mvPosition.z, 0.25);
    gl_PointSize = clamp(baseSize * (5.2 / dist), 2.0, 26.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SAT_POINTS_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.2);
    float halo = pow(1.0 - r2, 1.8) * 0.65;
    vec3 col = vColor * (0.75 + 0.65 * core);
    gl_FragColor = vec4(col, (core + halo) * vIntensity);
  }
`;

/** Motion trails: a short fading streak behind each satellite (a hint of motion, not an orbit). */
const TRAIL_LEN = 0.035; // world units (Earth radius = 1)
const TRAIL_DIR_PERIOD_MS = 2000; // sim-time spacing used to estimate each satellite's heading
const TRAIL_VERT = /* glsl */ `
  attribute float aEnd;
  varying float vEnd;
  void main() {
    vEnd = aEnd;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const TRAIL_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vEnd;
  void main() {
    gl_FragColor = vec4(0.55, 0.82, 1.0, vEnd * vEnd * 0.5 * uOpacity);
  }
`;

/**
 * GPU mode: positions are not uploaded per frame. Each satellite carries an "anchor" (exact SGP4
 * state: position aP in km, velocity aV in km/s, TEME frame, at time aT seconds) and the vertex
 * shader rotates it along its near-circular orbit to the current shader time uT:
 *   r(dt) = r0 cos(w dt) + (v0 / w) sin(w dt),  w = |v0| / |r0|
 * then applies the GMST rotation (TEME -> ECEF) and Three.js axes. Error vs full SGP4: ~20 m mean
 * at dt = 60 s, ~0.5 km at 300 s (measured on the real constellation).
 */
const GPU_EXTRAP_GLSL = /* glsl */ `
  attribute vec3 aP;
  attribute vec3 aV;
  attribute float aT;
  uniform float uT;
  uniform float uCosG;
  uniform float uSinG;
  uniform float uInvR;

  vec3 extrapolate(float tOff) {
    float r = length(aP);
    if (r < 1.0) return vec3(1.0e6); // no valid anchor: park far outside the view
    float w = length(aV) / r;
    float dt = uT - aT - tOff;
    float phi = w * dt;
    float c = cos(phi);
    float sw = w > 1.0e-9 ? sin(phi) / w : dt;
    vec3 q = aP * c + aV * sw;
    float ex = uCosG * q.x + uSinG * q.y;
    float ey = -uSinG * q.x + uCosG * q.y;
    return vec3(ex, q.z, -ey) * uInvR;
  }
`;
const SAT_POINTS_VERT_GPU = SAT_POINTS_VERT.replace(
  'attribute float aStyle;',
  'attribute float aStyle;\n' + GPU_EXTRAP_GLSL,
).replace(
  'vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
  'vec4 mvPosition = modelViewMatrix * vec4(extrapolate(0.0), 1.0);',
);
const TRAIL_SEC = 29; // seconds of orbital motion a trail spans (~220 km, same as TRAIL_LEN)
const TRAIL_VERT_GPU = /* glsl */ `
  attribute float aEnd;
  attribute float aStyle;
  uniform float uTrailSec;
  uniform float uDir;
  varying float vEnd;
  ${GPU_EXTRAP_GLSL}
  void main() {
    vEnd = aEnd;
    if (aStyle < -0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 p = extrapolate(uDir * (1.0 - aEnd) * uTrailSec);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const _followCurPos = new THREE.Vector3();
const _followDelta = new THREE.Vector3();

export function ConstellationView({
  engine,
  simTimeMsRef,
  isPlaying,
  timeScale,
  enabledShells,
  searchMatchIndices,
  selectedSatIndex,
  followSelected,
  showGroundTrack,
  observer,
  showCommLinks,
  visualSettings,
  pointsRef,
  earthMeshRef,
  viewCommandsRef,
  showTrails = true,
  onFrameStats,
}: ConstellationViewProps) {
  const { scene, camera, controls, renderer } = useThree();
  const sunDirectionRef = useRef<[number, number, number]>([1, 0, 0]);

  const commLinesGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const orbitLineGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const groundTrackGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const selectedMarkerRef = useRef<THREE.Group | null>(null);
  const obsGroupRef = useRef<THREE.Group | null>(null);
  const obsPinMeshRef = useRef<THREE.Mesh | null>(null);
  const obsRingGeomRef = useRef<THREE.BufferGeometry | null>(null);

  const satCount = engine.count;
  const trailLineRef = useRef<THREE.LineSegments | null>(null);
  const trailMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const trailStateRef = useRef({ prevSimMs: NaN });
  const gpuFrameRef = useRef({ t: 0, cosG: 1, sinG: 0 });
  const gpuRevRef = useRef(-1);
  const styleCtxRef = useRef<{
    shellMask: number;
    search: Set<number> | null | undefined;
    selected: number | null | undefined;
    obs: boolean | undefined;
    count: number;
  }>({ shellMask: -1, search: undefined, selected: undefined, obs: undefined, count: -1 });

  const {
    posAttr,
    styleAttr,
    commLineAttr,
    commLinePositions,
    trailPos,
    trailPosAttr,
    trailEndAttr,
    trailDir,
    prevPos,
    gpuBufs,
  } = useMemo(() => {
    const count = Math.max(satCount, 1);
    const pos = new Float32Array(count * 3);
    const style = new Float32Array(count);
    style.fill(-2.0); // Force initial style upload on frame 1
    const comm = new Float32Array(600 * 6);

    const pAttr = new THREE.BufferAttribute(pos, 3);
    pAttr.setUsage(THREE.DynamicDrawUsage);
    const stAttr = new THREE.BufferAttribute(style, 1);
    stAttr.setUsage(THREE.DynamicDrawUsage);
    const commAttr = new THREE.BufferAttribute(comm, 3);
    commAttr.setUsage(THREE.DynamicDrawUsage);

    // Trails: 2 vertices per satellite (tail, head); aEnd = 0 at the tail, 1 at the head
    const tPos = new Float32Array(count * 6);
    const tPosAttr = new THREE.BufferAttribute(tPos, 3);
    tPosAttr.setUsage(THREE.DynamicDrawUsage);
    const tEnd = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) tEnd[i * 2 + 1] = 1;

    // GPU mode: anchor buffers shared by the points and the (instanced) trail geometry
    let gpuB: GpuBuffers | null = null;
    if (engine.gpuMode && engine.anchorPV.length === satCount * 6 && satCount > 0) {
      const dyn = THREE.DynamicDrawUsage;
      const pvPoints = new THREE.InterleavedBuffer(engine.anchorPV, 6);
      pvPoints.setUsage(dyn);
      const pvTrail = new THREE.InstancedInterleavedBuffer(engine.anchorPV, 6, 1);
      pvTrail.setUsage(dyn);
      const tPoints = new THREE.BufferAttribute(engine.anchorT, 1);
      tPoints.setUsage(dyn);
      const tTrail = new THREE.InstancedBufferAttribute(engine.anchorT, 1, false, 1);
      tTrail.setUsage(dyn);
      const styleTrail = new THREE.InstancedBufferAttribute(style, 1, false, 1);
      styleTrail.setUsage(dyn);
      gpuB = {
        pvPoints,
        pvTrail,
        tPoints,
        tTrail,
        styleTrail,
        uniforms: {
          uT: { value: 0 },
          uCosG: { value: 1 },
          uSinG: { value: 0 },
          uInvR: { value: 1 / EARTH_RADIUS_KM },
          uTrailSec: { value: TRAIL_SEC },
          uDir: { value: 1 },
        },
      };
    }

    return {
      gpuBufs: gpuB,
      posAttr: pAttr,
      styleAttr: stAttr,
      commLineAttr: commAttr,
      commLinePositions: comm,
      trailPos: tPos,
      trailPosAttr: tPosAttr,
      trailEndAttr: new THREE.BufferAttribute(tEnd, 1),
      trailDir: new Float32Array(count * 3),
      prevPos: new Float32Array(count * 3),
    };
  }, [satCount, engine, engine.anchorPV]);

  // Create and attach Three.js Constellation objects to Scene
  useEffect(() => {
    const group = new THREE.Group();
    scene.add(group);

    // 1. Satellites Points Cloud
    const ptsGeom = new THREE.BufferGeometry();
    ptsGeom.setAttribute('position', posAttr);
    ptsGeom.setAttribute('aStyle', styleAttr);
    if (gpuBufs) {
      ptsGeom.setAttribute('aP', new THREE.InterleavedBufferAttribute(gpuBufs.pvPoints, 3, 0));
      ptsGeom.setAttribute('aV', new THREE.InterleavedBufferAttribute(gpuBufs.pvPoints, 3, 3));
      ptsGeom.setAttribute('aT', gpuBufs.tPoints);
    }
    const ptsMat = new THREE.ShaderMaterial({
      vertexShader: gpuBufs ? SAT_POINTS_VERT_GPU : SAT_POINTS_VERT,
      fragmentShader: SAT_POINTS_FRAG,
      uniforms: gpuBufs ? gpuBufs.uniforms : {},
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(ptsGeom, ptsMat);
    pts.name = 'satellites';
    pts.frustumCulled = false;
    group.add(pts);
    pointsRef.current = pts;

    // 1b. Motion trails (additive streaks behind each satellite)
    let trailGeom: THREE.BufferGeometry;
    if (gpuBufs) {
      // One 2-vertex segment instanced per satellite; the shader computes both ends from the anchor
      const ig = new THREE.InstancedBufferGeometry();
      ig.instanceCount = satCount;
      ig.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      ig.setAttribute('aEnd', new THREE.BufferAttribute(new Float32Array([0, 1]), 1));
      ig.setAttribute('aP', new THREE.InterleavedBufferAttribute(gpuBufs.pvTrail, 3, 0));
      ig.setAttribute('aV', new THREE.InterleavedBufferAttribute(gpuBufs.pvTrail, 3, 3));
      ig.setAttribute('aT', gpuBufs.tTrail);
      ig.setAttribute('aStyle', gpuBufs.styleTrail);
      trailGeom = ig;
    } else {
      trailGeom = new THREE.BufferGeometry();
      trailGeom.setAttribute('position', trailPosAttr);
      trailGeom.setAttribute('aEnd', trailEndAttr);
    }
    const trailMat = new THREE.ShaderMaterial({
      vertexShader: gpuBufs ? TRAIL_VERT_GPU : TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: gpuBufs
        ? { uOpacity: { value: 0 }, ...gpuBufs.uniforms }
        : { uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const trailLines = new THREE.LineSegments(trailGeom, trailMat);
    trailLines.name = 'trails';
    trailLines.frustumCulled = false;
    group.add(trailLines);
    trailLineRef.current = trailLines;
    trailMatRef.current = trailMat;

    // 2. Selected Satellite Marker
    const selGroup = new THREE.Group();
    selGroup.visible = false;
    const selDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfde047 }),
    );
    const selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.025, 32),
      new THREE.MeshBasicMaterial({
        color: 0xfde047,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      }),
    );
    selGroup.add(selDot);
    selGroup.add(selRing);
    group.add(selGroup);
    selectedMarkerRef.current = selGroup;

    // 3. Orbit Path & Ground Track Lines
    const orbitGeom = new THREE.BufferGeometry();
    const orbitMat = new THREE.LineBasicMaterial({
      color: 0xfde047,
      transparent: true,
      opacity: 0.88,
    });
    const orbitLine = new THREE.Line(orbitGeom, orbitMat);
    orbitLine.frustumCulled = false;
    group.add(orbitLine);
    orbitLineGeomRef.current = orbitGeom;

    const gtGeom = new THREE.BufferGeometry();
    const gtMat = new THREE.LineBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.78,
    });
    const gtLine = new THREE.Line(gtGeom, gtMat);
    gtLine.frustumCulled = false;
    group.add(gtLine);
    groundTrackGeomRef.current = gtGeom;

    // 4. Ground Station Group (Pin + FOV Circle + Comm Link Beams)
    const obsGroup = new THREE.Group();
    const obsPin = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x10b981 }),
    );
    obsGroup.add(obsPin);
    obsPinMeshRef.current = obsPin;

    const obsRingGeom = new THREE.BufferGeometry();
    const obsRingMat = new THREE.LineBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.55,
    });
    const obsRing = new THREE.LineSegments(obsRingGeom, obsRingMat);
    obsRing.frustumCulled = false;
    obsGroup.add(obsRing);
    obsRingGeomRef.current = obsRingGeom;

    const commGeom = new THREE.BufferGeometry();
    commGeom.setAttribute('position', commLineAttr);
    commGeom.setDrawRange(0, 0);
    const commMat = new THREE.LineBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const commSegments = new THREE.LineSegments(commGeom, commMat);
    commSegments.name = 'commlinks';
    commSegments.frustumCulled = false;
    obsGroup.add(commSegments);
    commLinesGeomRef.current = commGeom;

    group.add(obsGroup);
    obsGroupRef.current = obsGroup;

    // Pre-compile every material now, including objects that are hidden until first use (the
    // selection marker, orbit lines): otherwise the first selection compiles shaders and uploads
    // geometry in the middle of a frame (a ~300 ms hitch on an iPhone). `compileAsync` uses
    // parallel shader compilation where available; visibility is restored right away because the
    // set of materials is collected synchronously.
    {
      const prev: [THREE.Object3D, boolean][] = [];
      group.traverse((o) => {
        prev.push([o, o.visible]);
        o.visible = true;
      });
      void renderer.compileAsync(scene, camera).catch(() => {});
      for (const [o, v] of prev) o.visible = v;
    }

    return () => {
      scene.remove(group);
      pointsRef.current = null;
      trailLineRef.current = null;
      trailMatRef.current = null;
    };
  }, [scene, posAttr, styleAttr, commLineAttr, trailPosAttr, trailEndAttr, gpuBufs, satCount]);

  // Keep MoonBit observer & Ground Station geometry synced
  const obsThreePos = useMemo(() => {
    engine.updateObserver(observer);
    const pos = latLonAltToThree(
      observer.latDeg,
      observer.lonDeg,
      observer.altKm,
    );

    if (obsPinMeshRef.current) {
      obsPinMeshRef.current.position.set(pos[0], pos[1], pos[2]);
    }

    // Update FOV coverage ring at 550km altitude
    const elRad = (observer.minElDeg * Math.PI) / 180;
    const Re = 6378.135;
    const h = 550.0;
    const sinZenith = (Re / (Re + h)) * Math.cos(elRad);
    const psi = Math.acos(Math.min(1, sinZenith)) - elRad;

    const normal = new THREE.Vector3(pos[0], pos[1], pos[2]).normalize();
    const up =
      Math.abs(normal.y) < 0.99
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const tangent1 = new THREE.Vector3().crossVectors(up, normal).normalize();
    const tangent2 = new THREE.Vector3()
      .crossVectors(normal, tangent1)
      .normalize();

    const ringPts: number[] = [];
    const steps = 64;
    const rShell = 1.0 + 550.0 / Re;
    for (let i = 0; i < steps; i++) {
      const a1 = (i / steps) * Math.PI * 2;
      const a2 = ((i + 1) / steps) * Math.PI * 2;
      const p1 = new THREE.Vector3()
        .addScaledVector(normal, Math.cos(psi))
        .addScaledVector(tangent1, Math.sin(psi) * Math.cos(a1))
        .addScaledVector(tangent2, Math.sin(psi) * Math.sin(a1))
        .multiplyScalar(rShell);
      const p2 = new THREE.Vector3()
        .addScaledVector(normal, Math.cos(psi))
        .addScaledVector(tangent1, Math.sin(psi) * Math.cos(a2))
        .addScaledVector(tangent2, Math.sin(psi) * Math.sin(a2))
        .multiplyScalar(rShell);
      ringPts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    }
    if (obsRingGeomRef.current) {
      obsRingGeomRef.current.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(ringPts, 3),
      );
    }
    return pos;
  }, [
    engine,
    observer.latDeg,
    observer.lonDeg,
    observer.altKm,
    observer.minElDeg,
    observer.enabled,
  ]);

  const lastUiReportRef = useRef(0);
  const perfOutRef = useRef<FullPerfSnapshot>({
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
    wasmPureSgp4Ms: 0,
    wasmSlices: 1,
    wasmFullPassMs: 0,
    gpuPath: false,
    calibrationMs: 0,
    wasmReadoutMs: 0,
    threeBufferSyncMs: 0,
    wasmMemoryBytes: 0,
    jsHeapMb: null,
  });
  const lastOrbitCalcRef = useRef<{
    idx: number | null;
    timeMs: number;
    gt: boolean;
  }>({
    idx: null,
    timeMs: 0,
    gt: false,
  });
  const prevSelectedPosRef = useRef<THREE.Vector3 | null>(null);

  // Initial framing: choose a distance that fits the screen (matters on portrait).
  useEffect(() => {
    camera.position.setLength(
      fitCameraDistance(camera as THREE.PerspectiveCamera, controls),
    );
  }, [camera, controls]);

  const flightRef = useRef<CameraFlight>({
    active: false,
    t: 0,
    dur: 0.8,
    fromDir: new THREE.Vector3(),
    toDir: new THREE.Vector3(),
    fromDist: 1,
    toDist: 1,
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(),
  });

  useEffect(() => {
    const flight = flightRef.current;
    const tmp = new THREE.Vector3();
    const persp = camera as THREE.PerspectiveCamera;

    const fitDistance = () => fitCameraDistance(persp, controls);

    const flyTo = (dir: THREE.Vector3, dist: number, target: THREE.Vector3, dur: number) => {
      flight.fromDir.copy(camera.position).normalize();
      flight.fromDist = camera.position.length();
      flight.fromTarget.copy(controls.target);
      flight.toDir.copy(dir).normalize();
      flight.toDist = Math.min(controls.maxDistance, Math.max(controls.minDistance, dist));
      flight.toTarget.copy(target);
      flight.t = 0;
      flight.dur = dur;
      flight.active = true;
    };

    const cancel = () => {
      flight.active = false;
    };
    controls.addEventListener('start', cancel);

    if (viewCommandsRef) {
      viewCommandsRef.current = {
        zoom: (factor) => {
          tmp.copy(camera.position);
          flyTo(tmp, camera.position.length() * factor, controls.target, 0.3);
        },
        resetView: () => {
          tmp.set(0, 0.85, 2.55);
          if (followSelected) tmp.copy(camera.position);
          flyTo(tmp, fitDistance(), followSelected ? controls.target : _origin, 0.9);
        },
        focusGroundStation: () => {
          tmp.set(obsThreePos[0], obsThreePos[1], obsThreePos[2]);
          if (tmp.lengthSq() < 1e-9) return;
          flyTo(tmp, Math.max(2.1, fitDistance() * 0.8), _origin, 1.0);
        },
        focusSatellite: (idx) => {
          const arr = posAttr.array as Float32Array;
          if (engine.gpuMode) {
            const gf = gpuFrameRef.current;
            engine.extrapolateInto(idx, gf.t, gf.cosG, gf.sinG, arr, idx * 3);
          }
          tmp.set(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]);
          if (tmp.lengthSq() < 1e-9) return;
          flyTo(tmp, Math.max(1.9, fitDistance() * 0.75), _origin, 1.0);
        },
        setAutoRotate: (on) => {
          controls.autoRotate = on;
          controls.autoRotateSpeed = 0.6;
        },
      };
    }
    return () => {
      controls.removeEventListener('start', cancel);
      if (viewCommandsRef) viewCommandsRef.current = null;
    };
  }, [viewCommandsRef, camera, controls, obsThreePos, followSelected, posAttr]);

  useEffect(() => {
    if (!followSelected) {
      controls.target.set(0, 0, 0);
      controls.update();
      prevSelectedPosRef.current = null;
    }
  }, [followSelected, controls]);

  useFrame((threeState, delta) => {
    if (satCount === 0) return;

    const fl = flightRef.current;
    if (fl.active) {
      fl.t += Math.min(delta, 0.1) / fl.dur;
      const k = Math.min(1, fl.t);
      const e = k * k * (3 - 2 * k); // smoothstep
      _flyQFull.setFromUnitVectors(fl.fromDir, fl.toDir);
      _flyQPart.copy(_flyQId).slerp(_flyQFull, e);
      _flyDir.copy(fl.fromDir).applyQuaternion(_flyQPart);
      camera.position.copy(_flyDir).multiplyScalar(
        fl.fromDist + (fl.toDist - fl.fromDist) * e,
      );
      controls.target.lerpVectors(fl.fromTarget, fl.toTarget, e);
      if (k >= 1) fl.active = false;
    }

    const dtClamped = Math.min(delta, 0.1);
    if (isPlaying) {
      simTimeMsRef.current += dtClamped * 1000 * timeScale;
    }
    const currentSimMs = simTimeMsRef.current;

    // 1. Run MoonBit Wasm SGP4 propagation
    engine.propagate(currentSimMs, timeScale, isPlaying);
    const gpuB = gpuBufs;
    const gf = gpuFrameRef.current;
    if (gpuB) {
      engine.getGpuFrame(currentSimMs, gf);
      const u = gpuB.uniforms;
      u.uT.value = gf.t;
      u.uCosG.value = gf.cosG;
      u.uSinG.value = gf.sinG;
      u.uDir.value = timeScale < 0 ? -1 : 1;
      if (gpuRevRef.current !== engine.anchorRevision) {
        // Upload only the range of anchors refreshed this frame
        gpuRevRef.current = engine.anchorRevision;
        const lo = engine.anchorLo;
        const hi = engine.anchorHi;
        for (const b of [gpuB.pvPoints, gpuB.pvTrail]) {
          b.clearUpdateRanges();
          b.addUpdateRange(lo * 6, (hi - lo) * 6);
          b.needsUpdate = true;
        }
        for (const a of [gpuB.tPoints, gpuB.tTrail]) {
          a.clearUpdateRanges();
          a.addUpdateRange(lo, hi - lo);
          a.needsUpdate = true;
        }
      }
    }
    sunDirectionRef.current = engine.sunDirectionThree;

    // 2. SWAR 4-sat-at-once status readout + single-pass WebGL buffer sync
    const b0 = performance.now();
    const api = engine.api;
    const satStatus = engine.satStatus;
    const satStatusU32 = engine.satStatusU32;
    const quadLen = satStatusU32.length;

    const dstPos = posAttr.array as Float32Array;
    dstPos.set(engine.getRenderPositions()); // one memcpy instead of 3 wasm calls per satellite
    const dstStyle = styleAttr.array as Float32Array;
    const hasSearch = searchMatchIndices !== null;
    const obsEnabled = observer.enabled;
    const shellMask =
      ((enabledShells[0] ?? true) ? 1 : 0) |
      ((enabledShells[1] ?? true) ? 2 : 0) |
      ((enabledShells[2] ?? true) ? 4 : 0) |
      ((enabledShells[3] ?? true) ? 8 : 0) |
      ((enabledShells[4] ?? true) ? 16 : 0);
    let styleDirty = false;
    let activeVisCount = 0;

    // GPU mode refreshes only a slice of the satellites per frame and a satellite's status only
    // changes when its slice is refreshed, so style work can be limited to that range. Anything
    // that changes how styles are derived (shell filter, search, selection, observer) re-styles
    // every satellite once.
    const sc = styleCtxRef.current;
    const ctxChanged =
      sc.shellMask !== shellMask ||
      sc.search !== searchMatchIndices ||
      sc.selected !== selectedSatIndex ||
      sc.obs !== obsEnabled ||
      sc.count !== satCount;
    if (ctxChanged) {
      sc.shellMask = shellMask;
      sc.search = searchMatchIndices;
      sc.selected = selectedSatIndex;
      sc.obs = obsEnabled;
      sc.count = satCount;
    }
    const partial = gpuB !== null && !ctxChanged;
    const rangeLo = partial ? Math.min(engine.anchorLo, satCount) : 0;
    const rangeHi = partial ? Math.min(engine.anchorHi, satCount) : satCount;

    // Read 4 satellite status bytes per call (only the quads covering the range)
    const qLo = partial ? rangeLo >> 2 : 0;
    const qHi = partial ? Math.min(quadLen, ((rangeHi + 3) >> 2) + 1) : quadLen;
    for (let q = qLo; q < qHi; q++) {
      satStatusU32[q] = api.get_sat_status_quad(q << 2);
    }

    for (let i = rangeLo; i < rangeHi; i++) {
      const st = satStatus[i];
      const shId = st & 7;
      const ok = (st & 8) !== 0;
      const shellEnabled = (shellMask & (1 << shId)) !== 0;
      const matchesSearch = !hasSearch || searchMatchIndices.has(i);

      if (!ok || !shellEnabled || !matchesSearch) {
        if (dstStyle[i] !== -1.0) {
          dstStyle[i] = -1.0;
          styleDirty = true;
          if (!gpuB) trailPos.fill(0, i * 6, i * 6 + 6); // collapse its trail to a degenerate segment
        }
        continue;
      }

      const i3 = i * 3;
      const px = dstPos[i3];
      const py = dstPos[i3 + 1];
      const pz = dstPos[i3 + 2];
      if (!gpuB) {
        const t6 = i * 6;
        trailPos[t6] = px - trailDir[i3] * TRAIL_LEN; // tail
        trailPos[t6 + 1] = py - trailDir[i3 + 1] * TRAIL_LEN;
        trailPos[t6 + 2] = pz - trailDir[i3 + 2] * TRAIL_LEN;
        trailPos[t6 + 3] = px; // head
        trailPos[t6 + 4] = py;
        trailPos[t6 + 5] = pz;
      }

      const isVis = obsEnabled && (st & 16) !== 0;
      if (isVis) activeVisCount++;

      const style =
        i === selectedSatIndex
          ? 24.0
          : isVis
            ? 16.0
            : hasSearch
              ? 10.0 + shId
              : shId;

      if (dstStyle[i] !== style) {
        dstStyle[i] = style;
        styleDirty = true;
      }
    }

    if (gpuB) {
      // Count shown, visible satellites from the (short) visible list instead of the full loop
      activeVisCount = 0;
      if (obsEnabled) {
        const vl = api.get_visible_count();
        for (let k = 0; k < vl; k++) {
          if (dstStyle[api.get_visible_sat_index(k)] >= 0) activeVisCount++;
        }
      }
    }
    engine.visibleCount = activeVisCount;
    if (!gpuB) posAttr.needsUpdate = true; // GPU mode never uploads CPU positions

    // Motion trails: estimate each satellite's apparent heading from how far it
    // moved since the last estimate (every ~2 sim-seconds); after a time jump or
    // on the first frame there are no trails until the next estimate.
    if (!gpuB) {
    const trailState = trailStateRef.current;
    const dtSim = currentSimMs - trailState.prevSimMs;
    if (!(Math.abs(dtSim) < 120000)) {
      trailState.prevSimMs = currentSimMs;
      prevPos.set(dstPos);
      trailDir.fill(0);
    } else if (Math.abs(dtSim) >= TRAIL_DIR_PERIOD_MS) {
      for (let i3 = 0; i3 < satCount * 3; i3 += 3) {
        const dx = dstPos[i3] - prevPos[i3];
        const dy = dstPos[i3 + 1] - prevPos[i3 + 1];
        const dz = dstPos[i3 + 2] - prevPos[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 1e-9) {
          // (satellites not refreshed this cycle by time-slicing keep their last heading)
          const inv = 1 / len;
          trailDir[i3] = dx * inv;
          trailDir[i3 + 1] = dy * inv;
          trailDir[i3 + 2] = dz * inv;
        }
      }
      prevPos.set(dstPos);
      trailState.prevSimMs = currentSimMs;
    }
    }
    const trailMat = trailMatRef.current;
    if (trailMat) {
      // Fade in while time is advancing, fade out when paused (a paused sky has no motion hint)
      const target = showTrails && isPlaying ? 1 : 0;
      const u = trailMat.uniforms.uOpacity;
      u.value += (target - u.value) * Math.min(1, dtClamped * 4);
    }
    if (!gpuB) trailPosAttr.needsUpdate = true;
    if (styleDirty) {
      styleAttr.needsUpdate = true;
      if (gpuB) gpuB.styleTrail.needsUpdate = true;
    }

    // 3. Update Ground Station visibility & communication links via Wasm visible_indices
    if (obsGroupRef.current) {
      obsGroupRef.current.visible = obsEnabled;
      if (obsPinMeshRef.current) {
        obsPinMeshRef.current.position.set(
          obsThreePos[0],
          obsThreePos[1],
          obsThreePos[2],
        );
      }
    }

    if (commLinesGeomRef.current) {
      if (obsEnabled && showCommLinks) {
        const rawVisTotal = api.get_visible_count();
        const [ox, oy, oz] = obsThreePos;
        let ptr = 0;
        for (let k = 0; k < rawVisTotal && ptr < 3600; k++) {
          const sIdx = api.get_visible_sat_index(k);
          if (dstStyle[sIdx] < 0) continue;
          const idx3 = sIdx * 3;
          if (gpuB) engine.extrapolateInto(sIdx, gf.t, gf.cosG, gf.sinG, dstPos, idx3);
          commLinePositions[ptr++] = ox;
          commLinePositions[ptr++] = oy;
          commLinePositions[ptr++] = oz;
          commLinePositions[ptr++] = dstPos[idx3];
          commLinePositions[ptr++] = dstPos[idx3 + 1];
          commLinePositions[ptr++] = dstPos[idx3 + 2];
        }
        commLineAttr.needsUpdate = true;
        commLinesGeomRef.current.setDrawRange(0, ptr / 3);
      } else {
        commLinesGeomRef.current.setDrawRange(0, 0);
      }
    }
    const b1 = performance.now();
    const threeBufferSyncMs = b1 - b0;
    engine.wasmReadoutMs = 0;

    // 4. Update Selected Satellite Marker, Orbit Path & Camera Follow
    if (selectedSatIndex !== null && (satStatus[selectedSatIndex] & 8) !== 0) {
      const s3 = selectedSatIndex * 3;
      if (gpuB) engine.extrapolateInto(selectedSatIndex, gf.t, gf.cosG, gf.sinG, dstPos, s3);
      const sx = dstPos[s3];
      const sy = dstPos[s3 + 1];
      const sz = dstPos[s3 + 2];

      if (selectedMarkerRef.current) {
        selectedMarkerRef.current.position.set(sx, sy, sz);
        selectedMarkerRef.current.lookAt(camera.position);
        selectedMarkerRef.current.visible = true;
      }

      if (
        lastOrbitCalcRef.current.idx !== selectedSatIndex ||
        Math.abs(currentSimMs - lastOrbitCalcRef.current.timeMs) > 15000 ||
        lastOrbitCalcRef.current.gt !== showGroundTrack
      ) {
        lastOrbitCalcRef.current = {
          idx: selectedSatIndex,
          timeMs: currentSimMs,
          gt: showGroundTrack,
        };
        const inertialPts = engine.getOrbitPathThree(
          selectedSatIndex,
          currentSimMs,
          48.0,
          140,
          false,
        );
        if (orbitLineGeomRef.current && inertialPts.length > 1) {
          const flat = new Float32Array(inertialPts.length * 3);
          for (let i = 0; i < inertialPts.length; i++) {
            flat[i * 3] = inertialPts[i][0];
            flat[i * 3 + 1] = inertialPts[i][1];
            flat[i * 3 + 2] = inertialPts[i][2];
          }
          orbitLineGeomRef.current.setAttribute(
            'position',
            new THREE.BufferAttribute(flat, 3),
          );
        }

        if (groundTrackGeomRef.current) {
          if (showGroundTrack) {
            const gtPts = engine.getOrbitPathThree(
              selectedSatIndex,
              currentSimMs,
              48.0,
              140,
              true,
            );
            const flatGt = new Float32Array(gtPts.length * 3);
            for (let i = 0; i < gtPts.length; i++) {
              const v = new THREE.Vector3(
                gtPts[i][0],
                gtPts[i][1],
                gtPts[i][2],
              )
                .normalize()
                .multiplyScalar(1.003);
              flatGt[i * 3] = v.x;
              flatGt[i * 3 + 1] = v.y;
              flatGt[i * 3 + 2] = v.z;
            }
            groundTrackGeomRef.current.setAttribute(
              'position',
              new THREE.BufferAttribute(flatGt, 3),
            );
          } else {
            groundTrackGeomRef.current.setAttribute(
              'position',
              new THREE.BufferAttribute(new Float32Array(0), 3),
            );
          }
        }
      }

      if (followSelected) {
        _followCurPos.set(sx, sy, sz);
        if (!prevSelectedPosRef.current) {
          prevSelectedPosRef.current = new THREE.Vector3(sx, sy, sz);
          _followDelta.copy(_followCurPos).normalize().multiplyScalar(0.38);
          camera.position.copy(_followCurPos).add(_followDelta);
        } else {
          _followDelta.copy(_followCurPos).sub(prevSelectedPosRef.current);
          camera.position.add(_followDelta);
          prevSelectedPosRef.current.copy(_followCurPos);
        }
        controls.target.copy(_followCurPos);
      }
    } else {
      if (selectedMarkerRef.current) {
        selectedMarkerRef.current.visible = false;
      }
      if (orbitLineGeomRef.current && lastOrbitCalcRef.current.idx !== null) {
        lastOrbitCalcRef.current.idx = null;
        orbitLineGeomRef.current.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(0), 3),
        );
        if (groundTrackGeomRef.current) {
          groundTrackGeomRef.current.setAttribute(
            'position',
            new THREE.BufferAttribute(new Float32Array(0), 3),
          );
        }
      }
    }

    // 5. Throttle UI telemetry updates to 4 Hz (250ms) and reuse persistent perfSnapshot object
    const nowPerf = performance.now();
    if (nowPerf - lastUiReportRef.current > 250) {
      lastUiReportRef.current = nowPerf;
      const telemetry =
        selectedSatIndex !== null
          ? engine.getSatelliteTelemetry(selectedSatIndex)
          : null;
      const perfMem = (performance as any).memory;
      const jsHeapMb = perfMem?.usedJSHeapSize
        ? perfMem.usedJSHeapSize / (1024 * 1024)
        : null;

      const ps = threeState.perfStats;
      const snap = perfOutRef.current;
      snap.fps = ps.fps;
      snap.minFps = ps.minFps;
      snap.frameTimeMs = ps.frameTimeMs;
      snap.webglRenderMs = ps.webglRenderMs;
      snap.drawCalls = ps.drawCalls;
      snap.triangles = ps.triangles;
      snap.points = ps.points;
      snap.lines = ps.lines;
      snap.geometries = ps.geometries;
      snap.textures = ps.textures;
      snap.programs = ps.programs;
      snap.wasmPureSgp4Ms = engine.wasmPureSgp4Ms;
      snap.wasmSlices = engine.wasmSlices;
      snap.wasmFullPassMs = engine.wasmFullPassMs;
      snap.gpuPath = engine.gpuMode;
      snap.calibrationMs = engine.fullPassCalibrationMs ?? 0;
      snap.wasmReadoutMs = engine.wasmReadoutMs;
      snap.threeBufferSyncMs = threeBufferSyncMs;
      snap.wasmMemoryBytes = engine.wasmMemoryBytes;
      snap.jsHeapMb = jsHeapMb;

      onFrameStats(currentSimMs, activeVisCount, snap, telemetry);
    }
  });

  return (
    <EarthGlobe
      sunDirectionRef={sunDirectionRef}
      visualSettings={visualSettings}
      earthMeshRef={earthMeshRef}
    />
  );
}
