import { useEffect, useMemo, useRef } from 'preact/hooks';
import * as THREE from 'three';
import { useFrame, useThree, RenderPerfStats } from '../fiber/PreactFiber';
import {
  StarlinkSimEngine,
  ObserverConfig,
  SHELL_INFO,
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

const SAT_POINTS_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mvPosition.z, 0.25);
    gl_PointSize = clamp(aSize * (5.2 / dist), 2.0, 26.0);
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

  const satCount = engine.metadata.length;

  const {
    posAttr,
    colAttr,
    sizeAttr,
    commLineAttr,
    commLinePositions,
    prevStateCode,
    shellRgbFlat,
  } = useMemo(() => {
    const count = Math.max(satCount, 1);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const sz = new Float32Array(count);
    const comm = new Float32Array(600 * 6);
    const stateCode = new Uint8Array(count);
    stateCode.fill(255);

    const pAttr = new THREE.BufferAttribute(pos, 3);
    pAttr.setUsage(THREE.DynamicDrawUsage);
    const cAttr = new THREE.BufferAttribute(col, 3);
    cAttr.setUsage(THREE.DynamicDrawUsage);
    const sAttr = new THREE.BufferAttribute(sz, 1);
    sAttr.setUsage(THREE.DynamicDrawUsage);
    const commAttr = new THREE.BufferAttribute(comm, 3);
    commAttr.setUsage(THREE.DynamicDrawUsage);

    const rgbFlat = new Float32Array(5 * 3);
    for (let s = 0; s < 5; s++) {
      const rgb = SHELL_INFO[s]?.rgb ?? [0.22, 0.74, 0.97];
      rgbFlat[s * 3] = rgb[0];
      rgbFlat[s * 3 + 1] = rgb[1];
      rgbFlat[s * 3 + 2] = rgb[2];
    }

    return {
      posAttr: pAttr,
      colAttr: cAttr,
      sizeAttr: sAttr,
      commLineAttr: commAttr,
      commLinePositions: comm,
      prevStateCode: stateCode,
      shellRgbFlat: rgbFlat,
    };
  }, [satCount]);

  // Create and attach Three.js Constellation objects to Scene
  useEffect(() => {
    const group = new THREE.Group();
    scene.add(group);

    // 1. Satellites Points Cloud
    const ptsGeom = new THREE.BufferGeometry();
    ptsGeom.setAttribute('position', posAttr);
    ptsGeom.setAttribute('aColor', colAttr);
    ptsGeom.setAttribute('aSize', sizeAttr);
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
  }, [scene, posAttr, colAttr, sizeAttr, commLineAttr]);

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

    // 2. Update satellite Points attributes
    const b0 = performance.now();
    const srcPos = engine.positionsThree;
    const valid = engine.validFlags;
    const vis = engine.visibleFlags;
    const shellIds = engine.shellIds;
    const dstPos = posAttr.array as Float32Array;
    const dstCol = colAttr.array as Float32Array;
    const dstSize = sizeAttr.array as Float32Array;
    const hasSearch = searchMatchIndices !== null;
    const obsEnabled = observer.enabled;
    const s0 = enabledShells[0] ?? true;
    const s1 = enabledShells[1] ?? true;
    const s2 = enabledShells[2] ?? true;
    const s3 = enabledShells[3] ?? true;
    const s4 = enabledShells[4] ?? true;
    let styleDirty = false;

    for (let i = 0; i < satCount; i++) {
      const shId = shellIds[i];
      const shellEnabled =
        shId === 0
          ? s0
          : shId === 1
            ? s1
            : shId === 2
              ? s2
              : shId === 3
                ? s3
                : s4;
      const matchesSearch = !hasSearch || searchMatchIndices.has(i);
      const i3 = i * 3;

      if (!valid[i] || !shellEnabled || !matchesSearch) {
        dstPos[i3] = 0;
        dstPos[i3 + 1] = 0;
        dstPos[i3 + 2] = 0;
        if (prevStateCode[i] !== 0) {
          prevStateCode[i] = 0;
          dstSize[i] = 0;
          styleDirty = true;
        }
        continue;
      }

      dstPos[i3] = srcPos[i3];
      dstPos[i3 + 1] = srcPos[i3 + 1];
      dstPos[i3 + 2] = srcPos[i3 + 2];

      let code: number;
      if (i === selectedSatIndex) {
        code = 3;
      } else if (obsEnabled && vis[i]) {
        code = 2;
      } else {
        code = hasSearch ? 4 : 1;
      }

      if (prevStateCode[i] !== code) {
        prevStateCode[i] = code;
        styleDirty = true;
        if (code === 3) {
          dstCol[i3] = 1.0;
          dstCol[i3 + 1] = 0.92;
          dstCol[i3 + 2] = 0.25;
          dstSize[i] = 8.5;
        } else if (code === 2) {
          dstCol[i3] = 0.15;
          dstCol[i3 + 1] = 1.0;
          dstCol[i3 + 2] = 0.55;
          dstSize[i] = 5.4;
        } else {
          const cIdx = shId * 3;
          dstCol[i3] = shellRgbFlat[cIdx];
          dstCol[i3 + 1] = shellRgbFlat[cIdx + 1];
          dstCol[i3 + 2] = shellRgbFlat[cIdx + 2];
          dstSize[i] = code === 4 ? 4.8 : 2.8;
        }
      }
    }

    posAttr.needsUpdate = true;
    if (styleDirty) {
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
    }

    // 3. Update Ground Station visibility & communication links
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
        const visIndices = engine.visibleIndices;
        const linkCount = Math.min(visIndices.length, 600);
        const [ox, oy, oz] = obsThreePos;
        let ptr = 0;
        for (let k = 0; k < linkCount; k++) {
          const sIdx = visIndices[k];
          const shId = shellIds[sIdx];
          const shellEnabled =
            shId === 0
              ? s0
              : shId === 1
                ? s1
                : shId === 2
                  ? s2
                  : shId === 3
                    ? s3
                    : s4;
          if (!shellEnabled) continue;
          const idx3 = sIdx * 3;
          commLinePositions[ptr++] = ox;
          commLinePositions[ptr++] = oy;
          commLinePositions[ptr++] = oz;
          commLinePositions[ptr++] = srcPos[idx3];
          commLinePositions[ptr++] = srcPos[idx3 + 1];
          commLinePositions[ptr++] = srcPos[idx3 + 2];
        }
        commLineAttr.needsUpdate = true;
        commLinesGeomRef.current.setDrawRange(0, ptr / 3);
      } else {
        commLinesGeomRef.current.setDrawRange(0, 0);
      }
    }
    const b1 = performance.now();
    const threeBufferSyncMs = b1 - b0;

    // 4. Update Selected Satellite Marker, Orbit Path & Camera Follow
    if (selectedSatIndex !== null && valid[selectedSatIndex]) {
      const s3 = selectedSatIndex * 3;
      const sx = srcPos[s3];
      const sy = srcPos[s3 + 1];
      const sz = srcPos[s3 + 2];

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
        const curPos = new THREE.Vector3(sx, sy, sz);
        if (!prevSelectedPosRef.current) {
          const outward = curPos.clone().normalize().multiplyScalar(0.38);
          camera.position.copy(curPos).add(outward);
        } else {
          const deltaMove = curPos.clone().sub(prevSelectedPosRef.current);
          camera.position.add(deltaMove);
        }
        controls.target.copy(curPos);
        prevSelectedPosRef.current = curPos;
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

    // 5. Throttle UI telemetry state updates
    const nowPerf = performance.now();
    if (nowPerf - lastUiReportRef.current > 80) {
      lastUiReportRef.current = nowPerf;
      const telemetry =
        selectedSatIndex !== null
          ? engine.getSatelliteTelemetry(selectedSatIndex)
          : null;
      const perfMem = (performance as any).memory;
      const jsHeapMb = perfMem?.usedJSHeapSize
        ? perfMem.usedJSHeapSize / (1024 * 1024)
        : null;

      onFrameStats(
        currentSimMs,
        engine.visibleIndices.length,
        {
          ...threeState.perfStats,
          wasmPureSgp4Ms: engine.wasmPureSgp4Ms,
          wasmReadoutMs: engine.wasmReadoutMs,
          threeBufferSyncMs,
          wasmMemoryBytes: engine.wasmMemoryBytes,
          jsHeapMb,
        },
        telemetry,
      );
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
