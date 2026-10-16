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
  onFrameStats: (
    simTimeMs: number,
    visibleCount: number,
    perf: FullPerfSnapshot,
    selectedTelemetry: SatelliteTelemetry | null,
  ) => void;
}

/**
 * GPU Vertex Shader with built-in SIMT palette lookup:
 * Instead of uploading 3x Float32 RGB colors (128 KB) + 1x Float32 size (42 KB) from CPU,
 * CPU passes a single packed float `aStyle`:
 *  -1.0       : Hidden / Filtered out
 *   0.0 .. 4.0: Orbital Shell 0..4 normal (size 2.8)
 *  10.0 ..14.0: Orbital Shell 0..4 search-highlighted (size 4.8)
 *  16.0       : In Ground Station Dish FOV (Emerald, size 5.4)
 *  24.0       : Selected Satellite (Gold, size 8.5)
 */
const SAT_POINTS_VERT = /* glsl */ `
  attribute float aStyle;
  varying vec3 vColor;

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

    float baseSize = 2.8;
    if (aStyle > 20.0) {
      vColor = vec3(1.0, 0.92, 0.25);
      baseSize = 8.5;
    } else if (aStyle > 15.0) {
      vColor = vec3(0.15, 1.0, 0.55);
      baseSize = 5.4;
    } else if (aStyle >= 9.5) {
      vColor = getShellColor(aStyle - 10.0);
      baseSize = 4.8;
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

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.2);
    float halo = pow(1.0 - r2, 1.8) * 0.65;
    vec3 col = vColor * (0.75 + 0.65 * core);
    gl_FragColor = vec4(col, core + halo);
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
  onFrameStats,
}: ConstellationViewProps) {
  const { scene, camera, controls } = useThree();
  const sunDirectionRef = useRef<[number, number, number]>([1, 0, 0]);

  const commLinesGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const orbitLineGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const groundTrackGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const selectedMarkerRef = useRef<THREE.Group | null>(null);
  const obsGroupRef = useRef<THREE.Group | null>(null);
  const obsPinMeshRef = useRef<THREE.Mesh | null>(null);
  const obsRingGeomRef = useRef<THREE.BufferGeometry | null>(null);

  const satCount = engine.count;

  const {
    posAttr,
    styleAttr,
    commLineAttr,
    commLinePositions,
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

    return {
      posAttr: pAttr,
      styleAttr: stAttr,
      commLineAttr: commAttr,
      commLinePositions: comm,
    };
  }, [satCount]);

  // Create and attach Three.js Constellation objects to Scene
  useEffect(() => {
    const group = new THREE.Group();
    scene.add(group);

    // 1. Satellites Points Cloud
    const ptsGeom = new THREE.BufferGeometry();
    ptsGeom.setAttribute('position', posAttr);
    ptsGeom.setAttribute('aStyle', styleAttr);
    const ptsMat = new THREE.ShaderMaterial({
      vertexShader: SAT_POINTS_VERT,
      fragmentShader: SAT_POINTS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(ptsGeom, ptsMat);
    pts.frustumCulled = false;
    group.add(pts);
    pointsRef.current = pts;

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
    commSegments.frustumCulled = false;
    obsGroup.add(commSegments);
    commLinesGeomRef.current = commGeom;

    group.add(obsGroup);
    obsGroupRef.current = obsGroup;

    return () => {
      scene.remove(group);
      pointsRef.current = null;
    };
  }, [scene, posAttr, styleAttr, commLineAttr]);

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

  useEffect(() => {
    if (!followSelected) {
      controls.target.set(0, 0, 0);
      controls.update();
      prevSelectedPosRef.current = null;
    }
  }, [followSelected, controls]);

  useFrame((threeState, delta) => {
    if (satCount === 0) return;

    const dtClamped = Math.min(delta, 0.1);
    if (isPlaying) {
      simTimeMsRef.current += dtClamped * 1000 * timeScale;
    }
    const currentSimMs = simTimeMsRef.current;

    // 1. Run MoonBit Wasm SGP4 propagation
    engine.propagate(currentSimMs);
    sunDirectionRef.current = engine.sunDirectionThree;

    // 2. SWAR 4-sat-at-once status readout + single-pass WebGL buffer sync
    const b0 = performance.now();
    const api = engine.api;
    const invR = 1.0 / EARTH_RADIUS_KM;
    const satStatus = engine.satStatus;
    const satStatusU32 = engine.satStatusU32;
    const quadLen = satStatusU32.length;

    // Read 4 satellite status bytes per call (2,663 calls instead of 21,304 calls)
    for (let q = 0; q < quadLen; q++) {
      satStatusU32[q] = api.get_sat_status_quad(q << 2);
    }

    const dstPos = posAttr.array as Float32Array;
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

    for (let i = 0; i < satCount; i++) {
      const st = satStatus[i];
      const shId = st & 7;
      const ok = (st & 8) !== 0;
      const shellEnabled = (shellMask & (1 << shId)) !== 0;
      const matchesSearch = !hasSearch || searchMatchIndices.has(i);

      if (!ok || !shellEnabled || !matchesSearch) {
        if (dstStyle[i] !== -1.0) {
          dstStyle[i] = -1.0;
          styleDirty = true;
        }
        continue;
      }

      const i3 = i * 3;
      dstPos[i3] = api.get_sat_ecef_x(i) * invR;
      dstPos[i3 + 1] = api.get_sat_ecef_z(i) * invR;
      dstPos[i3 + 2] = -api.get_sat_ecef_y(i) * invR;

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

    engine.visibleCount = activeVisCount;
    posAttr.needsUpdate = true;
    if (styleDirty) {
      styleAttr.needsUpdate = true;
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
