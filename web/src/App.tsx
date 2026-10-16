import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import { Canvas } from './fiber/PreactFiber';
import {
  StarlinkSimEngine,
  ObserverConfig,
  SHELL_INFO,
  SatelliteTelemetry,
} from './wasm/simEngine';
import {
  ConstellationView,
  FullPerfSnapshot,
  ViewCommands,
} from './components/ConstellationView';
import { SkyPlot } from './components/SkyPlot';
import { EarthVisualSettings } from './components/EarthGlobe';
import {
  PerfMonitorPanel,
  PerfListener,
} from './components/PerfMonitorPanel';
import {
  AUTO_CHECK_EVERY_MS,
  autoRefreshDue,
  fetchLatestTle,
  loadCachedTle,
} from './wasm/tleRefresh';
import {
  Crosshair,
  House,
  Rotate3d,
  LocateFixed,
  Minus,
  Plus,
  Search,
  X,
} from 'lucide-preact';
import './styles.css';

interface CityPreset {
  name: string;
  lat: number;
  lon: number;
  alt: number;
}

const CITY_PRESETS: CityPreset[] = [
  { name: 'Tokyo (東京)', lat: 35.6762, lon: 139.6503, alt: 0.04 },
  { name: 'Osaka (大阪)', lat: 34.6937, lon: 135.5023, alt: 0.02 },
  { name: 'Sapporo (札幌)', lat: 43.0618, lon: 141.3545, alt: 0.03 },
  { name: 'Starbase TX', lat: 25.9968, lon: -97.1558, alt: 0.01 },
  { name: 'New York', lat: 40.7128, lon: -74.006, alt: 0.01 },
  { name: 'London', lat: 51.5074, lon: -0.1278, alt: 0.02 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093, alt: 0.02 },
];

const SPEED_OPTIONS = [-1000, -100, -10, -1, 1, 10, 60, 300, 1000];

const sharedDateUtc = new Date();
const sharedDateJst = new Date();

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatUtcIso(ms: number): string {
  sharedDateUtc.setTime(ms);
  const y = sharedDateUtc.getUTCFullYear();
  if (isNaN(y)) return '----';
  return (
    y +
    '-' +
    pad2(sharedDateUtc.getUTCMonth() + 1) +
    '-' +
    pad2(sharedDateUtc.getUTCDate()) +
    ' ' +
    pad2(sharedDateUtc.getUTCHours()) +
    ':' +
    pad2(sharedDateUtc.getUTCMinutes()) +
    ':' +
    pad2(sharedDateUtc.getUTCSeconds()) +
    ' UTC'
  );
}

function formatJst(ms: number): string {
  sharedDateJst.setTime(ms + 9 * 3600 * 1000);
  const y = sharedDateJst.getUTCFullYear();
  if (isNaN(y)) return '----';
  return (
    '(' +
    y +
    '-' +
    pad2(sharedDateJst.getUTCMonth() + 1) +
    '-' +
    pad2(sharedDateJst.getUTCDate()) +
    ' ' +
    pad2(sharedDateJst.getUTCHours()) +
    ':' +
    pad2(sharedDateJst.getUTCMinutes()) +
    ':' +
    pad2(sharedDateJst.getUTCSeconds()) +
    ' JST)'
  );
}

function toDatetimeLocalValue(ms: number): string {
  sharedDateUtc.setTime(ms);
  const y = sharedDateUtc.getUTCFullYear();
  if (isNaN(y)) return '';
  return (
    y +
    '-' +
    pad2(sharedDateUtc.getUTCMonth() + 1) +
    '-' +
    pad2(sharedDateUtc.getUTCDate()) +
    'T' +
    pad2(sharedDateUtc.getUTCHours()) +
    ':' +
    pad2(sharedDateUtc.getUTCMinutes())
  );
}

interface OverheadItem {
  index: number;
  name: string;
  satnum: number;
  el: number;
  range: number;
}

function OverheadSatellitesPanel({
  engine,
  observer,
  enabledShells,
  selectedSatIndex,
  onSelectSat,
  subscribePerf,
}: {
  engine: StarlinkSimEngine;
  observer: ObserverConfig;
  enabledShells: boolean[];
  selectedSatIndex: number | null;
  onSelectSat: (idx: number) => void;
  subscribePerf: (cb: PerfListener) => () => void;
}) {
  const countSpanRef = useRef<HTMLSpanElement>(null);
  const [items, setItems] = useState<OverheadItem[]>([]);
  const lastSecRef = useRef(-1);

  useEffect(() => {
    const updateList = () => {
      if (countSpanRef.current) {
        countSpanRef.current.textContent = String(engine.visibleCount);
      }
      const secBucket = Math.floor(performance.now() / 3000);
      if (secBucket !== lastSecRef.current) {
        lastSecRef.current = secBucket;
        const api = engine.api;
        const satStatus = engine.satStatus;
        const vLen = api.get_visible_count();
        const topIndices = new Int32Array(25);
        const topEls = new Float32Array(25);
        let topCount = 0;

        for (let i = 0; i < vLen; i++) {
          const idx = api.get_visible_sat_index(i);
          const shId = satStatus[idx] & 7;
          if (!(enabledShells[shId] ?? true)) continue;
          const el = api.get_sat_elevation_deg(idx);
          if (topCount < 25 || el > topEls[topCount - 1]) {
            let insertAt = topCount < 25 ? topCount++ : 24;
            while (insertAt > 0 && topEls[insertAt - 1] < el) {
              topEls[insertAt] = topEls[insertAt - 1];
              topIndices[insertAt] = topIndices[insertAt - 1];
              insertAt--;
            }
            topEls[insertAt] = el;
            topIndices[insertAt] = idx;
          }
        }

        const nextItems = new Array<OverheadItem>(topCount);
        for (let i = 0; i < topCount; i++) {
          const idx = topIndices[i];
          nextItems[i] = {
            index: idx,
            name: engine.getSatName(idx),
            satnum: api.get_sat_satnum(idx),
            el: topEls[i],
            range: api.get_sat_range_km(idx),
          };
        }
        setItems(nextItems);
      }
    };

    updateList();
    return subscribePerf(updateList);
  }, [engine, observer, enabledShells, subscribePerf]);

  return (
    <div>
      <span className="field-label">
        Overhead Satellites (
        <span ref={countSpanRef}>{engine.visibleCount}</span> in Dish FOV):
      </span>
      <div className="sat-list">
        {items.map((s) => (
          <div
            key={s.index}
            className={`sat-list-item ${selectedSatIndex === s.index ? 'selected' : ''}`}
            onClick={() => onSelectSat(s.index)}
          >
            <span style={{ fontWeight: 600, color: '#a7f3d0' }}>{s.name}</span>
            <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>
              El {s.el.toFixed(1)}° · {s.range.toFixed(0)} km
            </span>
          </div>
        ))}
        {items.length === 0 && (
          <div style={{ fontSize: '11px', color: '#64748b' }}>
            No satellites above {observer.minElDeg}° elevation.
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [engine, setEngine] = useState<StarlinkSimEngine | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(
    'Initializing MoonBit SGP4 Wasm & Loading Local 10,652 Starlink TLEs...',
  );
  const [satVersion, setSatVersion] = useState(0);
  const pointsRef = useRef<THREE.Points | null>(null);
  const viewCommandsRef = useRef<ViewCommands | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showTrails, setShowTrails] = useState(true);
  const earthMeshRef = useRef<THREE.Mesh | null>(null);

  // Simulation Clock (updated via Direct DOM refs to avoid Preact VDOM re-renders)
  const simTimeMsRef = useRef<number>(Date.now());
  const anchorTimeMsRef = useRef<number>(Date.now());
  const [isPlaying, setIsPlaying] = useState(true);
  const [timeScale, setTimeScale] = useState(1);

  // Direct DOM refs for high-frequency HUD readouts
  const topInRangeRef = useRef<HTMLSpanElement>(null);
  const topFpsRef = useRef<HTMLSpanElement>(null);
  const topSgp4MsRef = useRef<HTMLSpanElement>(null);
  const utcClockRef = useRef<HTMLSpanElement>(null);
  const jstClockRef = useRef<HTMLSpanElement>(null);
  const sliderInputRef = useRef<HTMLInputElement>(null);
  const datetimeInputRef = useRef<HTMLInputElement>(null);

  // Earth Visual Settings
  const [visualSettings, setVisualSettings] = useState<EarthVisualSettings>({
    mode: 'photoreal',
    showClouds: true,
    showAtmosphere: true,
    showBorders: false,
    showGraticule: false,
    dayNightShading: true,
  });

  // Constellation Filtering & Search
  const [enabledShells, setEnabledShells] = useState<boolean[]>([
    true,
    true,
    true,
    true,
    true,
  ]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSatIndex, setSelectedSatIndex] = useState<number | null>(null);
  const [followSelected, setFollowSelected] = useState(false);
  const [showGroundTrack, setShowGroundTrack] = useState(true);

  // Ground Station Observer
  const [observer, setObserver] = useState<ObserverConfig>({
    name: 'Tokyo (東京)',
    latDeg: 35.6762,
    lonDeg: 139.6503,
    altKm: 0.04,
    minElDeg: 25.0,
    enabled: true,
  });
  const [showCommLinks, setShowCommLinks] = useState(true);
  const [pickGroundStationMode, setPickGroundStationMode] = useState(false);

  // Live Frame Telemetry & Performance Profiler (Direct subscription, zero VNode churn)
  const lastDatetimeMinRef = useRef(-1);
  const [showPerfPanel, setShowPerfPanel] = useState(false);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // bottom sheet on narrow screens
  useEffect(() => {
    if (!showDisplayMenu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest('.menu-anchor')) {
        setShowDisplayMenu(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [showDisplayMenu]);
  const latestPerfRef = useRef<FullPerfSnapshot>({
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
  const perfListenersRef = useRef<PerfListener[]>([]);
  const subscribePerf = useMemo(
    () => (cb: PerfListener) => {
      perfListenersRef.current.push(cb);
      return () => {
        const idx = perfListenersRef.current.indexOf(cb);
        if (idx !== -1) perfListenersRef.current.splice(idx, 1);
      };
    },
    [],
  );

  const [selectedTelemetry, setSelectedTelemetry] =
    useState<SatelliteTelemetry | null>(null);

  // TLE Modal
  const [showTleModal, setShowTleModal] = useState(false);
  const [customTleText, setCustomTleText] = useState('');
  const [tleStatusMsg, setTleStatusMsg] = useState('');

  useEffect(() => {
    const sim = new StarlinkSimEngine();
    sim
      .init()
      .then(() => {
        // Prefer a recent live TLE cached from a previous session (avoids
        // re-downloading on every reload; CelesTrak rate-limits repeats).
        const cached = loadCachedTle();
        if (cached) sim.loadTleDataset(cached);
        const now = Date.now();
        simTimeMsRef.current = now;
        anchorTimeMsRef.current = now;
        setEngine(sim);
      })
      .catch((err) => {
        console.error(err);
        setLoadingMsg(`Error initializing simulator: ${err.message}`);
      });
  }, []);

  // Search filtering (queries Wasm & typed arrays directly without JS object array)
  const { searchMatchIndices, searchResultsList } = useMemo(() => {
    if (!engine) return { searchMatchIndices: null, searchResultsList: [] };
    const q = searchQuery.trim().toUpperCase();
    if (!q) return { searchMatchIndices: null, searchResultsList: [] };
    const set = new Set<number>();
    const list = [];
    const numericPart = q.replace(/^STARLINK-?/, '');
    for (let i = 0; i < engine.count; i++) {
      const slId = engine.starlinkIds[i];
      const satnum = engine.api.get_sat_satnum(i);
      const matchSl = slId > 0 && String(slId).includes(numericPart);
      const matchNorad = String(satnum).includes(q);
      if (matchSl || matchNorad) {
        set.add(i);
        if (list.length < 40) {
          list.push(engine.getSatMeta(i));
        }
      }
    }
    return { searchMatchIndices: set, searchResultsList: list };
  }, [engine, searchQuery, satVersion]);

  const syncClockDom = (ms: number) => {
    if (utcClockRef.current) utcClockRef.current.textContent = formatUtcIso(ms);
    if (jstClockRef.current) jstClockRef.current.textContent = formatJst(ms);
    if (sliderInputRef.current) {
      const offsetMins = (ms - anchorTimeMsRef.current) / 60000;
      sliderInputRef.current.value = String(
        Math.max(-1440, Math.min(1440, offsetMins)),
      );
    }
    const minBucket = Math.floor(ms / 60000);
    if (
      minBucket !== lastDatetimeMinRef.current &&
      datetimeInputRef.current &&
      document.activeElement !== datetimeInputRef.current
    ) {
      lastDatetimeMinRef.current = minBucket;
      datetimeInputRef.current.value = toDatetimeLocalValue(ms);
    }
  };

  // Camera: auto-rotate toggle, fly to a newly selected satellite, keyboard shortcuts
  useEffect(() => {
    viewCommandsRef.current?.setAutoRotate(autoRotate && !followSelected);
  }, [autoRotate, followSelected, engine]);

  useEffect(() => {
    if (selectedSatIndex === null || followSelected) return;
    viewCommandsRef.current?.focusSatellite(selectedSatIndex);
  }, [selectedSatIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const v = viewCommandsRef.current;
      if (!v) return;
      switch (e.key) {
        case '+':
        case '=':
          v.zoom(0.8);
          break;
        case '-':
        case '_':
          v.zoom(1.25);
          break;
        case 'h':
          v.resetView();
          break;
        case 'g':
          v.focusGroundStation();
          break;
        case 'f':
          if (selectedSatIndex !== null) setFollowSelected((x) => !x);
          break;
        case 'r':
          setAutoRotate((x) => !x);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSatIndex]);

  const handleFrameStats = (
    simTimeMs: number,
    visCount: number,
    perf: FullPerfSnapshot,
    selTelemetry: SatelliteTelemetry | null,
  ) => {
    latestPerfRef.current = perf;

    // Direct DOM updates (Zero Preact re-renders of App()!)
    syncClockDom(simTimeMs);
    if (topInRangeRef.current) {
      topInRangeRef.current.textContent = observer.enabled
        ? `${visCount} sats`
        : 'OFF';
    }
    if (topFpsRef.current) {
      topFpsRef.current.textContent = `${perf.fps.toFixed(0)} FPS`;
    }
    if (topSgp4MsRef.current) {
      topSgp4MsRef.current.textContent = `${perf.wasmPureSgp4Ms.toFixed(2)} ms`;
    }
    const listeners = perfListenersRef.current;
    for (let i = 0; i < listeners.length; i++) {
      listeners[i](perf);
    }

    if (selTelemetry !== null || selectedTelemetry !== null) {
      setSelectedTelemetry(selTelemetry);
    }
  };

  const handleJumpToTime = (newTimeMs: number) => {
    simTimeMsRef.current = newTimeMs;
    anchorTimeMsRef.current = newTimeMs;
    syncClockDom(newTimeMs);
  };

  const handleSelectGroundStationCoords = (latDeg: number, lonDeg: number) => {
    setObserver((prev) => ({
      ...prev,
      name: `Custom (${latDeg.toFixed(2)}°, ${lonDeg.toFixed(2)}°)`,
      latDeg: Number(latDeg.toFixed(4)),
      lonDeg: Number(lonDeg.toFixed(4)),
      enabled: true,
    }));
    setPickGroundStationMode(false);
  };

  const handleCanvasClick = (raycaster: THREE.Raycaster, e: MouseEvent) => {
    const earthHits = earthMeshRef.current
      ? raycaster.intersectObject(earthMeshRef.current, false)
      : [];
    const earthDist = earthHits.length > 0 ? earthHits[0].distance : Infinity;

    // 1. If in Pick Ground Station mode or double-clicking Earth
    if ((pickGroundStationMode || e.detail >= 2) && earthHits.length > 0) {
      const p = earthHits[0].point.clone().normalize();
      const latDeg = (Math.asin(Math.max(-1, Math.min(1, p.y))) * 180) / Math.PI;
      const lonDeg = (Math.atan2(-p.z, p.x) * 180) / Math.PI;
      handleSelectGroundStationCoords(latDeg, lonDeg);
      return;
    }

    // 2. Check satellite points hit in front of Earth
    if (pointsRef.current && engine) {
      const satHits = raycaster.intersectObject(pointsRef.current, false);
      const satStatus = engine.satStatus;
      for (const hit of satHits) {
        if (hit.distance < earthDist && typeof hit.index === 'number') {
          const idx = hit.index;
          if (idx >= 0 && idx < engine.count) {
            const st = satStatus[idx];
            if (
              (st & 8) !== 0 &&
              (enabledShells[st & 7] ?? true) &&
              (!searchMatchIndices || searchMatchIndices.has(idx))
            ) {
              setSelectedSatIndex(idx);
              return;
            }
          }
        }
      }
    }
  };

  const handleApplyCustomTle = () => {
    if (!engine || !customTleText.trim()) return;
    const count = engine.loadTleDataset(customTleText);
    if (count > 0) {
      setSelectedSatIndex(null);
      setSatVersion((v) => v + 1);
      setTleStatusMsg(`Successfully loaded ${count.toLocaleString()} satellites into MoonBit SGP4!`);
    } else {
      setTleStatusMsg('No valid 2-line / 3-line TLE entries found.');
    }
  };

  const applyLiveTle = (text: string): number => {
    if (!engine) return 0;
    const count = engine.loadTleDataset(text);
    setSelectedSatIndex(null);
    setSatVersion((v) => v + 1);
    return count;
  };

  const handleFetchLatestCelestrak = async () => {
    if (!engine) return;
    setTleStatusMsg('Fetching latest Starlink TLEs from CelesTrak...');
    const r = await fetchLatestTle();
    if (!r.ok) {
      setTleStatusMsg(r.message);
      return;
    }
    const count = applyLiveTle(r.text);
    setTleStatusMsg(
      `Updated! Loaded ${count.toLocaleString()} live Starlink satellites from CelesTrak.`,
    );
  };

  // Periodic refresh: keeps the elements from going stale while the app stays open.
  useEffect(() => {
    if (!engine) return;
    const tick = async () => {
      if (!autoRefreshDue()) return;
      const r = await fetchLatestTle();
      if (r.ok) {
        const count = applyLiveTle(r.text);
        setTleStatusMsg(`Auto-refreshed TLEs (${count.toLocaleString()} satellites).`);
      }
    };
    tick();
    const id = setInterval(tick, AUTO_CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, [engine]);

  if (!engine) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#030712',
          color: '#38bdf8',
          gap: '14px',
        }}
      >
        <div style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '0.08em' }}>
          STARLINK SGP4 ORBITAL SIMULATOR
        </div>
        <div style={{ fontSize: '13px', color: '#94a3b8' }}>{loadingMsg}</div>
      </div>
    );
  }

  return (
    <div className="sim-layout">
      {/* 3D WebGL Viewport */}
      <div
        className={`canvas-wrapper ${pickGroundStationMode ? 'pick-cursor' : ''}`}
      >
        <Canvas
          cameraPosition={[0, 0.85, 2.55]}
          fov={45}
          onCanvasClick={handleCanvasClick}
        >
          <ConstellationView
            engine={engine}
            simTimeMsRef={simTimeMsRef}
            isPlaying={isPlaying}
            timeScale={timeScale}
            enabledShells={enabledShells}
            searchMatchIndices={searchMatchIndices}
            selectedSatIndex={selectedSatIndex}
            followSelected={followSelected}
            showGroundTrack={showGroundTrack}
            observer={observer}
            showCommLinks={showCommLinks}
            visualSettings={visualSettings}
            pointsRef={pointsRef}
            viewCommandsRef={viewCommandsRef}
            showTrails={showTrails}
            earthMeshRef={earthMeshRef}
            onFrameStats={handleFrameStats}
          />
        </Canvas>
      </div>

      <div className="hud-root">
      {/* TOP TELEMETRY & VISUAL MODE BAR */}
      <header className="hud-panel top-bar">
        <div className="brand-block">
          <div className="brand-title">
            <span>🛰️ STARLINK SGP4 SIMULATOR</span>
            <span className="badge-wasm">MoonBit Wasm + Preact R3F</span>
          </div>
        </div>

        <div className="metrics-row">
          <div className="metric-item">
            <span className="metric-label">Tracked Satellites</span>
            <span className="metric-value cyan">
              {engine.count.toLocaleString()}
            </span>
          </div>
          <div className="metric-item">
            <span className="metric-label">In Range ({observer.name.split(' ')[0]})</span>
            <span ref={topInRangeRef} className="metric-value emerald">
              {observer.enabled ? `${engine.visibleCount} sats` : 'OFF'}
            </span>
          </div>
          <div className="metric-item">
            <span className="metric-label">FPS / Frame</span>
            <span ref={topFpsRef} className="metric-value emerald">
              60 FPS
            </span>
          </div>
          <div className="metric-item">
            <span className="metric-label">MoonBit SGP4 Pure</span>
            <span ref={topSgp4MsRef} className="metric-value cyan">
              3.90 ms
            </span>
          </div>
        </div>

        <div className="top-actions">
          <button
            className={`btn only-narrow ${sidebarOpen ? 'active' : ''}`}
            onClick={() => setSidebarOpen((v) => !v)}
            aria-expanded={sidebarOpen}
          >
            ☰ パネル
          </button>
          <div className="menu-anchor">
            <button
              className={`btn ${showDisplayMenu ? 'active' : ''}`}
              onClick={() => setShowDisplayMenu((v) => !v)}
              aria-expanded={showDisplayMenu}
            >
              🎛️ Display ▾
            </button>
            {showDisplayMenu && (
              <div className="hud-panel menu-popover">
                <span className="field-label">表示モード</span>
                <div className="segmented">
                  {(
                    [
                      ['photoreal', '4K Photoreal'],
                      ['hybrid', 'Hybrid Vector'],
                      ['tactical', 'Tactical Grid'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={`btn ${visualSettings.mode === mode ? 'active' : ''}`}
                      onClick={() => setVisualSettings((s) => ({ ...s, mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={visualSettings.showClouds}
                    onChange={() =>
                      setVisualSettings((s) => ({
                        ...s,
                        showClouds: !s.showClouds,
                      }))
                    }
                  />
                  雲 (Clouds)
                </label>
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={showTrails}
                    onChange={() => setShowTrails((v) => !v)}
                  />
                  衛星の航跡 (Trails)
                </label>
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={visualSettings.dayNightShading}
                    onChange={() =>
                      setVisualSettings((s) => ({
                        ...s,
                        dayNightShading: !s.dayNightShading,
                      }))
                    }
                  />
                  昼夜の陰影 (Day/Night)
                </label>
              </div>
            )}
          </div>
          <button
            className={`btn ${showPerfPanel ? 'active-emerald' : ''}`}
            onClick={() => setShowPerfPanel((p) => !p)}
          >
            📊 Perf Stats
          </button>
          <button className="btn" onClick={() => setShowTleModal(true)}>
            📥 TLE Data
          </button>
        </div>
      </header>

      <div className="hud-middle">
      {/* LEFT SIDEBAR: GROUND STATION, SHELL FILTERS & SEARCH */}
      <aside className={`left-sidebar ${sidebarOpen ? 'sheet-open' : ''}`}>
        {/* Search (top of sidebar, map-style: results overlay below the input) */}
        <section className="hud-panel search-card">
          <div className="search-input-row">
            <Search size={15} aria-hidden="true" />
            <input
              type="text"
              className="search-input"
              placeholder="衛星を検索 (例: STARLINK-1008 / 44714)"
              aria-label="衛星を検索"
              value={searchQuery}
              onInput={(e) =>
                setSearchQuery((e.target as HTMLInputElement).value)
              }
            />
            {searchQuery && (
              <button
                className="icon-btn"
                aria-label="検索をクリア"
                onClick={() => setSearchQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="search-results">
              {searchResultsList.map((m) => (
                <div
                  key={m.index}
                  className={`sat-list-item ${selectedSatIndex === m.index ? 'selected' : ''}`}
                  onClick={() => setSelectedSatIndex(m.index)}
                >
                  <span>{m.name}</span>
                  <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>
                    #{m.satnum} ({m.inclinationDeg.toFixed(1)}°)
                  </span>
                </div>
              ))}
              {searchResultsList.length === 0 && (
                <div style={{ fontSize: '11px', color: '#64748b', padding: '6px 4px' }}>
                  該当する衛星がありません。
                </div>
              )}
            </div>
          )}
        </section>

        {/* Ground Station Section */}
        <section className="hud-panel panel-section">
          <div className="section-header">
            <span>📡 Ground Station (地上局・上空通過)</span>
            <input
              type="checkbox"
              checked={observer.enabled}
              onChange={(e) =>
                setObserver((o) => ({
                  ...o,
                  enabled: (e.target as HTMLInputElement).checked,
                }))
              }
            />
          </div>

          <div className="preset-chips">
            {CITY_PRESETS.map((c) => (
              <button
                key={c.name}
                className={`chip ${observer.name === c.name ? 'active' : ''}`}
                onClick={() =>
                  setObserver((o) => ({
                    ...o,
                    name: c.name,
                    latDeg: c.lat,
                    lonDeg: c.lon,
                    altKm: c.alt,
                    enabled: true,
                  }))
                }
              >
                {c.name}
              </button>
            ))}
          </div>

          <div className="coord-grid">
            <div>
              <label className="field-label">Latitude (°N)</label>
              <input
                type="number"
                step="0.1"
                className="input-text"
                value={observer.latDeg}
                onInput={(e) =>
                  setObserver((o) => ({
                    ...o,
                    name: 'Custom',
                    latDeg: parseFloat((e.target as HTMLInputElement).value) || 0,
                  }))
                }
              />
            </div>
            <div>
              <label className="field-label">Longitude (°E)</label>
              <input
                type="number"
                step="0.1"
                className="input-text"
                value={observer.lonDeg}
                onInput={(e) =>
                  setObserver((o) => ({
                    ...o,
                    name: 'Custom',
                    lonDeg: parseFloat((e.target as HTMLInputElement).value) || 0,
                  }))
                }
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              className={`btn ${pickGroundStationMode ? 'active-emerald' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setPickGroundStationMode((p) => !p)}
            >
              {pickGroundStationMode
                ? '🎯 Click anywhere on Earth...'
                : '📍 Pick on Globe (or Double-Click)'}
            </button>
            <button
              className={`btn ${showCommLinks ? 'active-emerald' : ''}`}
              onClick={() => setShowCommLinks((s) => !s)}
              title="Toggle Laser/RF Link Beams"
            >
              🔗 Links
            </button>
          </div>

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '11px',
                color: '#94a3b8',
              }}
            >
              <span>Min Elevation Angle (最低仰角)</span>
              <span style={{ color: '#34d399', fontWeight: 700 }}>
                {observer.minElDeg}°
              </span>
            </div>
            <input
              type="range"
              min="5"
              max="60"
              step="1"
              style={{ width: '100%', accentColor: '#10b981' }}
              value={observer.minElDeg}
              onInput={(e) =>
                setObserver((o) => ({
                  ...o,
                  minElDeg: parseFloat((e.target as HTMLInputElement).value),
                }))
              }
            />
          </div>

          {observer.enabled && (
            <SkyPlot
              engine={engine}
              observer={observer}
              enabledShells={enabledShells}
              selectedSatIndex={selectedSatIndex}
              onSelectSat={setSelectedSatIndex}
              subscribePerf={subscribePerf}
            />
          )}

          {observer.enabled && (
            <OverheadSatellitesPanel
              engine={engine}
              observer={observer}
              enabledShells={enabledShells}
              selectedSatIndex={selectedSatIndex}
              onSelectSat={setSelectedSatIndex}
              subscribePerf={subscribePerf}
            />
          )}
        </section>

        {/* Orbital Shell Filter Section */}
        <section className="hud-panel panel-section">
          <div className="section-header">
            <span>🌐 Orbital Shells (軌道シェル別表示)</span>
          </div>
          <div className="shell-list">
            {[0, 1, 2, 3, 4].map((shellId) => {
              const info = SHELL_INFO[shellId];
              const enabled = enabledShells[shellId];
              return (
                <div
                  key={shellId}
                  className={`shell-row ${enabled ? '' : 'disabled'}`}
                  onClick={() =>
                    setEnabledShells((prev) => {
                      const next = [...prev];
                      next[shellId] = !next[shellId];
                      return next;
                    })
                  }
                >
                  <div className="shell-left">
                    <span
                      className="shell-dot"
                      style={{ background: info.color }}
                    />
                    <span>{info.label}</span>
                  </div>
                  <span className="shell-count">
                    {engine.shellCounts[shellId].toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </aside>

      <div className="right-column">
      {/* PERFORMANCE PROFILER PANEL */}
      {showPerfPanel && (
        <PerfMonitorPanel
          latestPerfRef={latestPerfRef}
          subscribePerf={subscribePerf}
          satCount={engine.count}
          onClose={() => setShowPerfPanel(false)}
        />
      )}

      {/* RIGHT INSPECTOR PANEL (SELECTED SATELLITE TELEMETRY) */}
      {selectedTelemetry && (
        <aside
          className="hud-panel right-inspector"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: '#fde047',
                }}
              >
                🛰️ {selectedTelemetry.name}
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                NORAD #{selectedTelemetry.satnum} · COSPAR{' '}
                {selectedTelemetry.intlDesig || 'N/A'}
              </div>
            </div>
            <button
              className="btn"
              onClick={() => {
                setSelectedSatIndex(null);
                setFollowSelected(false);
              }}
            >
              ✕
            </button>
          </div>

          <div
            style={{
              fontSize: '11px',
              padding: '4px 8px',
              borderRadius: '5px',
              background: 'rgba(56, 189, 248, 0.14)',
              color: '#7dd3fc',
            }}
          >
            {selectedTelemetry.shellLabel}
          </div>

          <div className="telemetry-grid">
            <div className="telemetry-box">
              <span className="field-label">ALTITUDE (高度)</span>
              <div className="telemetry-val">
                {selectedTelemetry.altKm.toFixed(2)} km
              </div>
            </div>
            <div className="telemetry-box">
              <span className="field-label">VELOCITY (速度)</span>
              <div className="telemetry-val">
                {selectedTelemetry.speedKms.toFixed(3)} km/s
              </div>
            </div>
            <div className="telemetry-box">
              <span className="field-label">LATITUDE (緯度)</span>
              <div className="telemetry-val">
                {selectedTelemetry.latDeg.toFixed(4)}°
              </div>
            </div>
            <div className="telemetry-box">
              <span className="field-label">LONGITUDE (経度)</span>
              <div className="telemetry-val">
                {selectedTelemetry.lonDeg.toFixed(4)}°
              </div>
            </div>
            <div className="telemetry-box">
              <span className="field-label">ELEVATION (仰角)</span>
              <div
                className="telemetry-val"
                style={{
                  color: selectedTelemetry.visible ? '#34d399' : '#94a3b8',
                }}
              >
                {selectedTelemetry.visible
                  ? `${selectedTelemetry.elevationDeg.toFixed(1)}° (VISIBLE)`
                  : 'Below FOV'}
              </div>
            </div>
            <div className="telemetry-box">
              <span className="field-label">SLANT RANGE (距離)</span>
              <div className="telemetry-val">
                {selectedTelemetry.visible
                  ? `${selectedTelemetry.rangeKm.toFixed(0)} km`
                  : '---'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className={`btn ${followSelected ? 'active' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setFollowSelected((f) => !f)}
            >
              {followSelected ? '🎥 Tracking Satellite' : '🎥 Follow Camera'}
            </button>
            <button
              className={`btn ${showGroundTrack ? 'active' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setShowGroundTrack((g) => !g)}
            >
              〰️ Ground Track
            </button>
          </div>
        </aside>
      )}
      </div>
      <div className="map-controls" role="group" aria-label="カメラ操作">
        <button
          className={`fab ${followSelected ? 'on' : ''}`}
          title={
            selectedSatIndex === null
              ? '選択衛星を追従 [F] (衛星を選択してください)'
              : '選択衛星を追従 [F]'
          }
          aria-label="選択衛星を追従"
          aria-pressed={followSelected}
          disabled={selectedSatIndex === null}
          onClick={() => setFollowSelected((v) => !v)}
        >
          <LocateFixed size={18} />
        </button>
        {observer.enabled && (
          <button
            className="fab"
            title="地上局へ視点を移動 [G]"
            aria-label="地上局へ視点を移動"
            onClick={() => viewCommandsRef.current?.focusGroundStation()}
          >
            <Crosshair size={18} />
          </button>
        )}
        <button
          className={`fab ${autoRotate ? 'on' : ''}`}
          title="自動回転 [R]"
          aria-label="自動回転"
          aria-pressed={autoRotate}
          onClick={() => setAutoRotate((v) => !v)}
        >
          <Rotate3d size={18} />
        </button>
        <button
          className="fab"
          title="視点をリセット [H]"
          aria-label="視点をリセット"
          onClick={() => viewCommandsRef.current?.resetView()}
        >
          <House size={18} />
        </button>
        <div className="fab-group">
          <button
            className="fab"
            title="拡大 [+]"
            aria-label="拡大"
            onClick={() => viewCommandsRef.current?.zoom(0.8)}
          >
            <Plus size={18} />
          </button>
          <button
            className="fab"
            title="縮小 [-]"
            aria-label="縮小"
            onClick={() => viewCommandsRef.current?.zoom(1.25)}
          >
            <Minus size={18} />
          </button>
        </div>
      </div>
      </div>

      {/* BOTTOM TIME-TRAVEL CONTROL BAR */}
      <footer className="hud-panel bottom-timebar">
        <div className="timebar-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn active"
              onClick={() => setIsPlaying((p) => !p)}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              className="btn active-emerald"
              onClick={() => {
                setTimeScale(1);
                setIsPlaying(true);
                handleJumpToTime(Date.now());
              }}
            >
              🔴 LIVE (現在時刻)
            </button>
            <button
              className="btn"
              onClick={() => handleJumpToTime(engine.defaultEpochUnixMs)}
              title="Jump to TLE Snapshot Epoch"
            >
              ⚓ TLE Epoch
            </button>
          </div>

          <div className="time-readout">
            <span ref={utcClockRef}>{formatUtcIso(simTimeMsRef.current)}</span>
            <span ref={jstClockRef} style={{ fontSize: '12px', color: '#38bdf8' }}>
              {formatJst(simTimeMsRef.current)}
            </span>
          </div>

          <div className="speed-buttons" role="group" aria-label="再生速度">
            <button
              className="btn"
              aria-label="速度を下げる"
              disabled={SPEED_OPTIONS.indexOf(timeScale) <= 0}
              onClick={() => {
                const i = SPEED_OPTIONS.indexOf(timeScale);
                if (i > 0) setTimeScale(SPEED_OPTIONS[i - 1]);
                setIsPlaying(true);
              }}
            >
              <Minus size={14} />
            </button>
            <select
              className="speed-select"
              aria-label="再生速度"
              value={timeScale}
              onChange={(e) => {
                setTimeScale(Number((e.target as HTMLSelectElement).value));
                setIsPlaying(true);
              }}
            >
              {SPEED_OPTIONS.map((spd) => (
                <option key={spd} value={spd}>
                  {spd > 0 ? `+${spd}x` : `${spd}x`}
                </option>
              ))}
            </select>
            <button
              className="btn"
              aria-label="速度を上げる"
              disabled={SPEED_OPTIONS.indexOf(timeScale) >= SPEED_OPTIONS.length - 1}
              onClick={() => {
                const i = SPEED_OPTIONS.indexOf(timeScale);
                if (i < SPEED_OPTIONS.length - 1) setTimeScale(SPEED_OPTIONS[i + 1]);
                setIsPlaying(true);
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="timeline-slider-row">
          <span style={{ fontSize: '11px', color: '#94a3b8', minWidth: '58px' }}>
            -24 Hours
          </span>
          <input
            ref={sliderInputRef}
            type="range"
            min="-1440"
            max="1440"
            step="0.5"
            className="timeline-slider"
            defaultValue="0"
            onInput={(e) => {
              const offsetMins = parseFloat(
                (e.target as HTMLInputElement).value,
              );
              const nextMs = anchorTimeMsRef.current + offsetMins * 60000;
              simTimeMsRef.current = nextMs;
              syncClockDom(nextMs);
            }}
          />
          <span
            style={{
              fontSize: '11px',
              color: '#94a3b8',
              minWidth: '58px',
              textAlign: 'right',
            }}
          >
            +24 Hours
          </span>

          <input
            ref={datetimeInputRef}
            type="datetime-local"
            className="input-text"
            style={{ width: '175px', fontSize: '11px', padding: '4px 7px' }}
            defaultValue={toDatetimeLocalValue(simTimeMsRef.current)}
            onChange={(e) => {
              const val = (e.target as HTMLInputElement).value;
              if (!val) return;
              const parsed = Date.parse(val + 'Z');
              if (!isNaN(parsed)) {
                handleJumpToTime(parsed);
              }
            }}
          />
        </div>
      </footer>
      </div>

      {/* TLE DATASET MODAL */}
      {showTleModal && (
        <div className="modal-backdrop" onClick={() => setShowTleModal(false)}>
          <div
            className="hud-panel modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-header" style={{ fontSize: '13px' }}>
              <span>📥 TLE Orbital Dataset Manager</span>
              <button className="btn" onClick={() => setShowTleModal(false)}>
                ✕
              </button>
            </div>
            <p style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.5 }}>
              現在ローカルアセット (<code>/assets/data/starlink.tle</code>) から{' '}
              <strong>{engine.count.toLocaleString()} 機</strong>{' '}
              のStarlink軌道データを読み込み済みです。外部通信なしで過去・未来の任意の時刻をSGP4計算できます。
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn active-emerald"
                onClick={handleFetchLatestCelestrak}
              >
                🌐 CelesTrakから最新TLEを1回取得
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const res = await fetch('/assets/data/starlink.tle');
                  const text = await res.text();
                  const count = engine.loadTleDataset(text);
                  setSatVersion((v) => v + 1);
                  setTleStatusMsg(
                    `Restored local snapshot (${count.toLocaleString()} satellites).`,
                  );
                }}
              >
                🔄 ローカル初期データに戻す
              </button>
            </div>
            <div>
              <label className="field-label">
                またはカスタムTLEデータ（2行/3行フォーマット）を貼り付けて反映:
              </label>
              <textarea
                className="tle-textarea"
                placeholder={
                  'STARLINK-1008\n1 44714U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996\n2 44714  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094'
                }
                value={customTleText}
                onInput={(e) =>
                  setCustomTleText((e.target as HTMLTextAreaElement).value)
                }
              />
            </div>
            {tleStatusMsg && (
              <div style={{ fontSize: '12px', color: '#38bdf8' }}>
                {tleStatusMsg}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn active" onClick={handleApplyCustomTle}>
                反映する (Load TLE)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
