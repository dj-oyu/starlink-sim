import { assetUrl } from '../util/assetUrl';

export interface WasmSimExports {
  memory: WebAssembly.Memory;
  reset_constellation: () => void;
  add_satellite_elements: (
    satnum: number,
    epoch_year: number,
    epoch_days: number,
    bstar: number,
    inclo_deg: number,
    nodeo_deg: number,
    ecco: number,
    argpo_deg: number,
    mo_deg: number,
    no_kozai_rpd: number,
  ) => number;
  get_satellite_count: () => number;
  set_observer: (
    lat_deg: number,
    lon_deg: number,
    alt_km: number,
    min_el_deg: number,
    enabled: number,
  ) => void;
  propagate_constellation: (unix_ms: number) => number;
  propagate_constellation_slice: (unix_ms: number, slice: number, slice_count: number) => number;
  get_sat_ecef_x: (idx: number) => number;
  get_sat_ecef_y: (idx: number) => number;
  get_sat_ecef_z: (idx: number) => number;
  get_sat_speed_kms: (idx: number) => number;
  get_sat_status: (idx: number) => number;
  get_sat_status_quad: (base_idx: number) => number;
  propagate_constellation_slice_anchored: (unix_ms: number, slice: number, slice_count: number, base_ms: number) => number;
  prepare_anchor_buffers: () => number;
  get_anchor_pv_ptr: () => number;
  get_anchor_t_ptr: () => number;
  prepare_render_buffer: () => number;
  get_render_buffer_ptr: () => number;
  get_sat_valid: (idx: number) => number;
  get_sat_visible: (idx: number) => number;
  get_sat_elevation_deg: (idx: number) => number;
  get_sat_azimuth_deg: (idx: number) => number;
  get_sat_range_km: (idx: number) => number;
  get_visible_count: () => number;
  get_visible_sat_index: (k: number) => number;
  get_sat_satnum: (idx: number) => number;
  get_sat_shell: (idx: number) => number;
  get_sat_inclination_deg: (idx: number) => number;
  get_sat_lat_deg: (idx: number) => number;
  get_sat_lon_deg: (idx: number) => number;
  get_sat_alt_km: (idx: number) => number;
  get_sun_ecef_x: () => number;
  get_sun_ecef_y: () => number;
  get_sun_ecef_z: () => number;
  compute_orbit_path: (
    idx: number,
    center_unix_ms: number,
    half_span_mins: number,
    num_steps: number,
    use_ground_track: number,
  ) => number;
  get_orbit_path_coord: (pt_idx: number, comp: number) => number;
}

export interface SatelliteMeta {
  index: number;
  name: string;
  satnum: number;
  intlDesig: string;
  shellId: number;
  inclinationDeg: number;
}

export interface SatelliteTelemetry {
  index: number;
  name: string;
  satnum: number;
  intlDesig: string;
  shellId: number;
  shellLabel: string;
  inclinationDeg: number;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  visible: boolean;
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  threePos: [number, number, number];
}

export interface ObserverConfig {
  name: string;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  minElDeg: number;
  enabled: boolean;
}

export const EARTH_RADIUS_KM = 6378.135;

// Adaptive time-slicing of the wasm propagation (see StarlinkSimEngine.propagate)
const WASM_BUDGET_MS = 4; // target wasm time per frame
const MAX_SLICES = 8;
const MAX_STALE_KM = 12; // max position age error (~0.5 px on a 400 px globe)
const JUMP_MS = 60000; // sim-time step treated as a seek (forces a full pass)
// --- GPU mode (`?gpu=1`) ---------------------------------------------------------------
// wasm refreshes per-satellite "anchors" (exact SGP4 state) at a low rate; the GPU rotates each
// satellite along its orbit from its anchor to the current time (see ConstellationView shaders).
// `?gpu=1` forces the GPU path on, `?gpu=0` off; otherwise it is chosen automatically at startup
// from the measured cost of a full wasm pass (see StarlinkSimEngine.init).
const GPU_PARAM: boolean | null = (() => {
  try {
    const v = new URLSearchParams(location.search).get('gpu');
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
})();
const GPU_AUTO_THRESHOLD_MS = 4; // a full pass slower than this -> use the GPU path
const GPU_BUDGET_MS = 1.5; // target wasm time per frame in GPU mode
const GPU_MAX_SLICES = 64;
// Anchor refresh cycle (sim seconds): the CPU-side features (visible list, sky plot, picking)
// see positions at most this stale. Rendering error grows with anchor age (~0.5 km mean at
// 300 s, ~20 m at 60 s), so at high playback speeds the cycle is allowed to be longer.
const GPU_CYCLE_SIM_S = 30;
const GPU_CYCLE_SIM_FAST_S = 240;
const GPU_FAST_SPEED = 100; // playback speed (x) above which the longer cycle is used
const GPU_REBASE_S = 3000; // keep float32 anchor times small (precision ~0.2 ms at 3000 s)

/** Greenwich mean sidereal time (rad), IAU-82 - identical to `gstime` in time.mbt. */
export function gmstRad(unixMs: number): number {
  const jd = 2440587.5 + unixMs / 86400000.0;
  const t = (jd - 2451545.0) / 36525.0;
  let temp =
    -6.2e-6 * t * t * t +
    0.093104 * t * t +
    (876600.0 * 3600.0 + 8640184.812866) * t +
    67310.54841;
  temp = ((temp * Math.PI) / 180.0 / 240.0) % (2 * Math.PI);
  if (temp < 0) temp += 2 * Math.PI;
  return temp;
}

// `?slices=N` forces N slices per frame (testing / comparing devices); 0 = automatic.
const FORCED_SLICES = (() => {
  try {
    return Math.max(0, Math.min(MAX_SLICES, Number(new URLSearchParams(location.search).get('slices')) || 0));
  } catch {
    return 0;
  }
})();

export const SHELL_INFO: Record<
  number,
  { label: string; shortLabel: string; color: string; rgb: [number, number, number] }
> = {
  0: {
    label: '53° Main Shell (~540 km)',
    shortLabel: '53° Main',
    color: '#38bdf8',
    rgb: [0.22, 0.74, 0.97],
  },
  1: {
    label: '43° Mid-Lat Shell (~530 km)',
    shortLabel: '43° Mid-Lat',
    color: '#a78bfa',
    rgb: [0.65, 0.55, 0.98],
  },
  2: {
    label: '70° High-Inc Shell (~570 km)',
    shortLabel: '70° High-Inc',
    color: '#34d399',
    rgb: [0.2, 0.83, 0.6],
  },
  3: {
    label: '97.6° Polar Shell (~560 km)',
    shortLabel: '97.6° Polar',
    color: '#f472b6',
    rgb: [0.96, 0.45, 0.71],
  },
  4: {
    label: 'VLEO / Orbit Raising (<450 km)',
    shortLabel: 'VLEO / Raising',
    color: '#fb923c',
    rgb: [0.98, 0.57, 0.24],
  },
};

function parseTleExp(str: string): number {
  const s = str.trim();
  if (!s) return 0;
  const m = s.match(/^([+-]?)(\d+)([+-]\d+)$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const mant = parseFloat('0.' + m[2]);
  const exp = parseInt(m[3], 10);
  return sign * mant * Math.pow(10, exp);
}

/**
 * Convert ECEF (km) to Three.js SphereGeometry-aligned coordinates (Earth radius = 1.0):
 * X_three = +ECEF_x / R_earth
 * Y_three = +ECEF_z / R_earth
 * Z_three = -ECEF_y / R_earth
 */
export function ecefToThree(
  ex: number,
  ey: number,
  ez: number,
): [number, number, number] {
  const invR = 1.0 / EARTH_RADIUS_KM;
  return [ex * invR, ez * invR, -ey * invR];
}

export function latLonAltToThree(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const r = 1.0 + altKm / EARTH_RADIUS_KM;
  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.sin(lat);
  const z = -r * Math.cos(lat) * Math.sin(lon);
  return [x, y, z];
}

export class StarlinkSimEngine {
  public api!: WasmSimExports;
  public count = 0;
  public starlinkIds: Int32Array = new Int32Array(0);
  /**
   * Unified bit-packed status buffer (4-byte aligned for 32-bit SWAR quad operations):
   * - bits 0..2 (`status & 7`): shellId (0..4)
   * - bit 3 (`status & 8`): valid flag
   * - bit 4 (`status & 16`): visible from ground station flag
   */
  public satStatus: Uint8Array = new Uint8Array(0);
  public satStatusU32: Uint32Array = new Uint32Array(0);
  private lastSimMs = NaN;
  private forceFullPass = true;
  private sliceCursor = 0;
  private fullPassMsEma = 0;
  private emaReady = false;
  /** Number of slices the last `propagate()` split the constellation into (1 = full pass). */
  public wasmSlices = 1;
  /** Smoothed estimate of the cost of one full pass in ms. */
  get wasmFullPassMs(): number {
    return this.fullPassMsEma;
  }
  // --- GPU mode state ---
  public gpuMode = GPU_PARAM === true;
  /** Full-pass time measured at startup for the automatic path choice (ms); null if forced by URL. */
  public fullPassCalibrationMs: number | null = null;
  private pathChosen = false;
  /** Per-satellite anchors for the GPU: x y z (km) vx vy vz (km/s) in TEME, 6 floats each. */
  public anchorPV: Float32Array = new Float32Array(0);
  /** Anchor times in seconds since `anchorBaseMs` (float32; re-based to stay small). */
  public anchorT: Float32Array = new Float32Array(0);
  public anchorBaseMs = NaN;
  /** Satellite index range [lo, hi) of anchors refreshed by the last propagate(); bumps `anchorRevision`. */
  public anchorLo = 0;
  public anchorHi = 0;
  public anchorRevision = 0;
  private anchorPvView: Float32Array = new Float32Array(0);
  private anchorTView: Float32Array = new Float32Array(0);
  private anchorPvPtr = 0;
  private anchorTPtr = 0;
  private renderView: Float32Array = new Float32Array(0);
  private renderPtr = 0;
  private renderFloats = 0;
  public visibleCount = 0;
  public shellCounts: number[] = [0, 0, 0, 0, 0];
  public sunDirectionThree: [number, number, number] = [1, 0, 0];
  public defaultEpochUnixMs: number = Date.now();
  public lastPropagateMs = 0;
  public wasmPureSgp4Ms = 0;
  public wasmReadoutMs = 0;
  public wasmMemoryBytes = 0;

  /** Allocate the GPU-path anchor buffers (wasm side and the JS arrays the GPU attributes use). */
  private setupGpuBuffers(total: number): void {
    this.api.prepare_anchor_buffers();
    this.anchorPvPtr = this.api.get_anchor_pv_ptr();
    this.anchorTPtr = this.api.get_anchor_t_ptr();
    // Keep the same typed arrays when the count is unchanged (GPU attributes reference them)
    if (this.anchorPV.length !== total * 6) {
      this.anchorPV = new Float32Array(total * 6);
      this.anchorT = new Float32Array(total);
    } else {
      this.anchorPV.fill(0);
      this.anchorT.fill(0);
    }
    this.anchorBaseMs = NaN;
    this.anchorPvView = new Float32Array(0);
    this.anchorTView = new Float32Array(0);
  }

  /** Median wall time (ms) of a full pass over the constellation, after one warm-up pass. */
  private measureFullPassMs(): number {
    const t = Date.now();
    this.api.propagate_constellation(t);
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      this.api.propagate_constellation(t + (i + 1) * 16);
      ms.push(performance.now() - s);
    }
    ms.sort((a, b) => a - b);
    return ms[1];
  }

  async init(): Promise<void> {
    const wasmRes = await fetch(assetUrl('assets/wasm/starlink-sim.wasm'));
    const wasmBytes = await wasmRes.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    this.api = instance.exports as unknown as WasmSimExports;

    // The server owns the TLE file and keeps it fresh; we only read it. (If it is not available
    // yet, the app starts empty and the periodic server check in App fills it in later. The
    // position path is chosen inside loadTleDataset, once satellites exist.)
    await this.loadTleFromServer();
  }

  /** ETag / Last-Modified of the server's TLE file that is currently loaded (change detection only). */
  private tleVersion = '';

  /**
   * Load the Starlink TLE from this app's own server (`/assets/data/starlink.tle`). The server
   * decides when to refresh it from upstream (by file timestamp, with a shared cool-down), so
   * clients never contact CelesTrak and store nothing. Conditional requests keep polling cheap:
   * the dataset is only re-parsed when the server's file actually changed (unless `force`).
   */
  async loadTleFromServer(
    force = false,
  ): Promise<{ status: 'loaded' | 'unchanged' | 'unavailable'; count: number }> {
    try {
      const res = await fetch(assetUrl('assets/data/starlink.tle'), { cache: 'no-cache' });
      if (!res.ok) return { status: 'unavailable', count: this.count };
      const version = res.headers.get('etag') || res.headers.get('last-modified') || '';
      if (!force && version && version === this.tleVersion && this.count > 0) {
        return { status: 'unchanged', count: this.count };
      }
      const text = await res.text();
      if (!/^1 \d{5}/m.test(text) || !/^2 \d{5}/m.test(text)) {
        return { status: 'unavailable', count: this.count }; // e.g. an HTML fallback page
      }
      const count = this.loadTleDataset(text);
      if (count > 0) this.tleVersion = version;
      return { status: count > 0 ? 'loaded' : 'unavailable', count: this.count };
    } catch {
      return { status: 'unavailable', count: this.count };
    }
  }

  /**
   * Pick the position path once, the first time satellites are loaded (the TLE may arrive late,
   * e.g. downloaded by the app on a fresh clone): slow engines (iOS Safari runs this wasm ~20x
   * slower) use the GPU path. One-time cost: 4 full passes (~1 ms each on desktop, ~70 ms on the
   * phone). `?gpu=0/1` skips the measurement.
   */
  private choosePath(): void {
    if (this.pathChosen || this.count === 0) return;
    this.pathChosen = true;
    if (GPU_PARAM !== null) return;
    this.fullPassCalibrationMs = this.measureFullPassMs();
    if (this.fullPassCalibrationMs > GPU_AUTO_THRESHOLD_MS) {
      this.gpuMode = true;
      this.setupGpuBuffers(this.count);
    }
    // Calibration propagated at "now"; make the first real frame a consistent full pass again
    this.forceFullPass = true;
  }

  getSatName(idx: number): string {
    const slId = this.starlinkIds[idx];
    if (slId > 0) return `STARLINK-${slId}`;
    return `SAT-${this.api.get_sat_satnum(idx)}`;
  }

  getSatMeta(idx: number): SatelliteMeta {
    return {
      index: idx,
      name: this.getSatName(idx),
      satnum: this.api.get_sat_satnum(idx),
      intlDesig: '',
      shellId: this.satStatus[idx] & 7,
      inclinationDeg: this.api.get_sat_inclination_deg(idx),
    };
  }

  /**
   * Zero-allocation single-pass TLE scanner that pushes numeric orbital elements
   * directly into MoonBit Wasm linear memory without creating intermediate String[] or Object[].
   */
  loadTleDataset(tleText: string): number {
    if (!this.api) return 0;
    this.api.reset_constellation();
    this.shellCounts = [0, 0, 0, 0, 0];

    const tempStarlinkIds: number[] = [];
    let epochSum = 0;
    let epochCount = 0;

    const len = tleText.length;
    let pos = 0;
    let prevLineStart = -1;
    let prevLineEnd = -1;
    let l1Start = -1;
    let l1End = -1;

    const nextLine = (): [number, number] | null => {
      while (pos < len) {
        let lineStart = pos;
        let nl = tleText.indexOf('\n', pos);
        if (nl === -1) nl = len;
        pos = nl + 1;
        let lineEnd = nl;
        while (lineStart < lineEnd && tleText.charCodeAt(lineStart) <= 32) {
          lineStart++;
        }
        while (lineEnd > lineStart && tleText.charCodeAt(lineEnd - 1) <= 32) {
          lineEnd--;
        }
        if (lineEnd > lineStart) {
          return [lineStart, lineEnd];
        }
      }
      return null;
    };

    while (true) {
      const span = nextLine();
      if (!span) break;
      const [s, e] = span;
      const c0 = tleText.charCodeAt(s);
      const c1 = s + 1 < e ? tleText.charCodeAt(s + 1) : 0;

      if (c0 === 49 && c1 === 32 && e - s >= 61) {
        // Line 1 ('1 ')
        l1Start = s;
        l1End = e;
      } else if (c0 === 50 && c1 === 32 && e - s >= 63 && l1Start !== -1) {
        // Line 2 ('2 ') paired with preceding Line 1
        const l1 = tleText.slice(l1Start, l1End);
        const l2 = tleText.slice(s, e);

        const satnum = parseInt(l1.slice(2, 7), 10);
        const epochYr = parseInt(l1.slice(18, 20), 10);
        const epochDays = parseFloat(l1.slice(20, 32));
        const bstar = parseTleExp(l1.slice(53, 61));

        const inclo = parseFloat(l2.slice(8, 16));
        const nodeo = parseFloat(l2.slice(17, 25));
        const ecco = parseInt(l2.slice(26, 33), 10) * 1e-7;
        const argpo = parseFloat(l2.slice(34, 42));
        const mo = parseFloat(l2.slice(43, 51));
        const no = parseFloat(l2.slice(52, 63));

        if (!isNaN(satnum) && !isNaN(epochDays) && !isNaN(no) && no > 0) {
          const idx = this.api.add_satellite_elements(
            satnum,
            epochYr,
            epochDays,
            bstar,
            inclo,
            nodeo,
            ecco,
            argpo,
            mo,
            no,
          );
          const shellId = this.api.get_sat_shell(idx);
          if (shellId >= 0 && shellId < 5) {
            this.shellCounts[shellId]++;
          }

          // Extract numeric suffix if name is "STARLINK-XXXX"
          let slId = 0;
          if (prevLineStart !== -1 && prevLineEnd - prevLineStart > 9) {
            const nameSlice = tleText.slice(prevLineStart, prevLineEnd);
            const dashIdx = nameSlice.indexOf('-');
            if (dashIdx !== -1) {
              const parsed = parseInt(nameSlice.slice(dashIdx + 1), 10);
              if (!isNaN(parsed)) slId = parsed;
            }
          }
          tempStarlinkIds.push(slId);

          const fullYear = epochYr < 57 ? 2000 + epochYr : 1900 + epochYr;
          const jan1Ms = Date.UTC(fullYear, 0, 1, 0, 0, 0);
          epochSum += jan1Ms + (epochDays - 1) * 86400000;
          epochCount++;
        }
        l1Start = -1;
        prevLineStart = -1;
      } else {
        // Title/Name line (Line 0)
        prevLineStart = s;
        prevLineEnd = e;
        l1Start = -1;
      }
    }

    const total = this.api.get_satellite_count();
    this.count = total;
    this.starlinkIds = new Int32Array(tempStarlinkIds);
    const alignedBytes = ((total + 3) & ~3);
    const statusBuf = new ArrayBuffer(alignedBytes);
    this.satStatus = new Uint8Array(statusBuf, 0, total);
    this.satStatusU32 = new Uint32Array(statusBuf);
    this.visibleCount = 0;
    for (let i = 0; i < total; i++) {
      this.satStatus[i] = this.api.get_sat_status(i);
    }
    if (epochCount > 0) {
      this.defaultEpochUnixMs = epochSum / epochCount;
    }
    // Render-ready positions live in wasm memory; JS bulk-copies them each frame
    // (instead of 3 JS->wasm calls per satellite, which is very slow on Safari/JSC).
    this.forceFullPass = true; // new satellites: make everything consistent first
    if (this.gpuMode) this.setupGpuBuffers(total);
    this.renderFloats = this.api.prepare_render_buffer();
    this.renderPtr = this.api.get_render_buffer_ptr();
    this.renderView = new Float32Array(0);
    this.wasmMemoryBytes = this.api.memory?.buffer?.byteLength ?? 0;
    this.choosePath();
    return total;
  }

  /**
   * Positions of all satellites in Three.js axes (x, z, -y) in Earth radii, as a view
   * over wasm memory, valid after `propagate()`. The view is re-created if wasm memory
   * grew (which detaches the old ArrayBuffer).
   */
  getRenderPositions(): Float32Array {
    const buf = this.api.memory.buffer;
    if (this.renderView.buffer !== buf) {
      this.renderView = new Float32Array(buf, this.renderPtr, this.renderFloats);
    }
    return this.renderView;
  }

  updateObserver(obs: ObserverConfig): void {
    if (!this.api) return;
    this.api.set_observer(
      obs.latDeg,
      obs.lonDeg,
      obs.altKm,
      obs.minElDeg,
      obs.enabled ? 1 : 0,
    );
  }

  /**
   * Advance the constellation to `unixMs`.
   *
   * On slow devices (e.g. iOS Safari runs this wasm ~20x slower than desktop Chrome) a full
   * pass can exceed the frame budget. When the measured cost of a full pass is above
   * `WASM_BUDGET_MS`, only 1/k of the satellites are refreshed per frame (k up to
   * `MAX_SLICES`). A satellite's position can then be up to k-1 frames old; k is capped so
   * that this staleness stays below `MAX_STALE_KM` at the current playback speed (so fast
   * playback and time jumps always use a full pass).
   */
  propagate(unixMs: number, timeScale = 1, isPlaying = true): void {
    if (!this.api) return;
    if (this.gpuMode) {
      this.propagateGpu(unixMs, timeScale, isPlaying);
      return;
    }
    const jumped = !(Math.abs(unixMs - this.lastSimMs) < JUMP_MS);
    this.lastSimMs = unixMs;

    // Staleness cap from playback speed (LEO ground speed ~7.6 km/s)
    const speed = isPlaying ? Math.abs(timeScale) : 0;
    const kmPerFrame = (7.6 * speed) / 60;
    const kAllowed =
      kmPerFrame <= 0
        ? MAX_SLICES
        : Math.max(1, Math.min(MAX_SLICES, Math.floor(1 + MAX_STALE_KM / kmPerFrame)));
    const kCost =
      FORCED_SLICES > 0
        ? FORCED_SLICES
        : Math.max(1, Math.min(MAX_SLICES, Math.ceil(this.fullPassMsEma / WASM_BUDGET_MS)));
    let k = Math.min(kAllowed, kCost);
    if (jumped || this.forceFullPass) k = 1;
    this.forceFullPass = false;

    const t0 = performance.now();
    if (k === 1) {
      this.api.propagate_constellation(unixMs);
      this.sliceCursor = 0;
    } else {
      const idx = this.sliceCursor % k;
      this.api.propagate_constellation_slice(unixMs, idx, k);
      this.sliceCursor = (idx + 1) % k;
    }
    const t1 = performance.now();

    // Cost of one *full* pass, estimated from whatever was just measured
    const est = (t1 - t0) * k;
    this.fullPassMsEma = this.emaReady ? this.fullPassMsEma * 0.9 + est * 0.1 : est;
    this.emaReady = true;
    this.wasmSlices = k;

    const api = this.api;
    const sx = api.get_sun_ecef_x();
    const sy = api.get_sun_ecef_y();
    const sz = api.get_sun_ecef_z();
    this.sunDirectionThree[0] = sx;
    this.sunDirectionThree[1] = sz;
    this.sunDirectionThree[2] = -sy;

    this.wasmPureSgp4Ms = t1 - t0;
    this.lastPropagateMs = t1 - t0;
    this.wasmMemoryBytes = api.memory?.buffer?.byteLength ?? 0;
  }

  /**
   * GPU mode: refresh 1/k of the satellites' anchors (exact SGP4 state) per frame. The GPU
   * extrapolates every satellite from its anchor, so k can be large: the cycle is limited only by
   * how stale the CPU-side features may get (and, at high playback speeds, by anchor age).
   */
  private propagateGpu(unixMs: number, timeScale: number, isPlaying: boolean): void {
    const api = this.api;
    const n = this.count;
    const jumped = !(Math.abs(unixMs - this.lastSimMs) < JUMP_MS);
    this.lastSimMs = unixMs;

    if (!Number.isFinite(this.anchorBaseMs)) this.anchorBaseMs = unixMs;
    let rebased = false;
    if (Math.abs((unixMs - this.anchorBaseMs) / 1000) > GPU_REBASE_S) {
      const shift = (unixMs - this.anchorBaseMs) / 1000;
      const t = this.anchorT;
      for (let i = 0; i < t.length; i++) t[i] -= shift;
      this.anchorBaseMs = unixMs;
      rebased = true;
    }

    const speed = isPlaying ? Math.abs(timeScale) : 0;
    const simPerFrame = speed / 60;
    const cycleSim = speed > GPU_FAST_SPEED ? GPU_CYCLE_SIM_FAST_S : GPU_CYCLE_SIM_S;
    const kAllowed =
      simPerFrame <= 0
        ? GPU_MAX_SLICES
        : Math.max(1, Math.min(GPU_MAX_SLICES, Math.floor(cycleSim / simPerFrame)));
    const kCost = Math.max(1, Math.ceil(this.fullPassMsEma / GPU_BUDGET_MS));
    let k = Math.min(kAllowed, kCost, n);
    if (jumped || this.forceFullPass) {
      k = 1;
      this.anchorBaseMs = unixMs;
      this.anchorT.fill(0);
    }
    this.forceFullPass = false;

    const idx = k === 1 ? 0 : this.sliceCursor % k;
    this.sliceCursor = k === 1 ? 0 : (idx + 1) % k;
    const t0 = performance.now();
    api.propagate_constellation_slice_anchored(unixMs, idx, k, this.anchorBaseMs);
    const t1 = performance.now();

    // Copy the refreshed range of anchors out of wasm memory (re-create views if memory grew)
    const buf = api.memory.buffer;
    if (this.anchorPvView.buffer !== buf) {
      this.anchorPvView = new Float32Array(buf, this.anchorPvPtr, n * 6);
      this.anchorTView = new Float32Array(buf, this.anchorTPtr, n);
    }
    const lo = Math.floor((n * idx) / k);
    const hi = Math.floor((n * (idx + 1)) / k);
    this.anchorPV.set(this.anchorPvView.subarray(lo * 6, hi * 6), lo * 6);
    this.anchorT.set(this.anchorTView.subarray(lo, hi), lo);
    // A re-base changed every anchor time, so upload everything this frame
    this.anchorLo = rebased || k === 1 ? 0 : lo;
    this.anchorHi = rebased || k === 1 ? n : hi;
    this.anchorRevision++;

    const est = (t1 - t0) * k; // cost of one full anchored pass
    this.fullPassMsEma = this.emaReady ? this.fullPassMsEma * 0.9 + est * 0.1 : est;
    this.emaReady = true;
    this.wasmSlices = k;

    const sx = api.get_sun_ecef_x();
    const sy = api.get_sun_ecef_y();
    const sz = api.get_sun_ecef_z();
    this.sunDirectionThree[0] = sx;
    this.sunDirectionThree[1] = sz;
    this.sunDirectionThree[2] = -sy;
    this.wasmPureSgp4Ms = t1 - t0;
    this.lastPropagateMs = t1 - t0;
    this.wasmMemoryBytes = api.memory?.buffer?.byteLength ?? 0;
  }

  /** Shader time (seconds since the anchor base) and GMST rotation for `unixMs`. */
  getGpuFrame(unixMs: number, out: { t: number; cosG: number; sinG: number }): void {
    out.t = (unixMs - this.anchorBaseMs) / 1000;
    const g = gmstRad(unixMs);
    out.cosG = Math.cos(g);
    out.sinG = Math.sin(g);
  }

  /**
   * CPU twin of the vertex shader: satellite `i` at shader time `tSec` in Three.js axes (Earth
   * radii), written to out[o..o+2]. Used for the few satellites CPU-side features need exactly
   * (selected marker, comm-link endpoints) so they stay glued to what the GPU draws.
   */
  extrapolateInto(
    i: number,
    tSec: number,
    cosG: number,
    sinG: number,
    out: Float32Array,
    o: number,
  ): void {
    const pv = this.anchorPV;
    const b = i * 6;
    const x = pv[b], y = pv[b + 1], z = pv[b + 2];
    const vx = pv[b + 3], vy = pv[b + 4], vz = pv[b + 5];
    const dt = tSec - this.anchorT[i];
    const r = Math.sqrt(x * x + y * y + z * z);
    const w = Math.sqrt(vx * vx + vy * vy + vz * vz) / Math.max(r, 1);
    const phi = w * dt;
    const c = Math.cos(phi);
    const sw = w > 1e-9 ? Math.sin(phi) / w : dt;
    const qx = x * c + vx * sw;
    const qy = y * c + vy * sw;
    const qz = z * c + vz * sw;
    const invR = 1 / EARTH_RADIUS_KM;
    out[o] = (cosG * qx + sinG * qy) * invR;
    out[o + 1] = qz * invR;
    out[o + 2] = -(-sinG * qx + cosG * qy) * invR;
  }

  /** Extrapolate every satellite to `unixMs` into `out` (3 floats each); used before picking. */
  extrapolateAll(unixMs: number, out: Float32Array): void {
    const g = gmstRad(unixMs);
    const cg = Math.cos(g);
    const sg = Math.sin(g);
    const t = (unixMs - this.anchorBaseMs) / 1000;
    for (let i = 0; i < this.count; i++) this.extrapolateInto(i, t, cg, sg, out, i * 3);
  }

  getSatelliteTelemetry(idx: number): SatelliteTelemetry | null {
    if (!this.api || idx < 0 || idx >= this.count) return null;
    const status = this.satStatus[idx];
    const shellId = status & 7;
    const shell = SHELL_INFO[shellId] ?? SHELL_INFO[0];
    const invR = 1.0 / EARTH_RADIUS_KM;
    const ex = this.api.get_sat_ecef_x(idx);
    const ey = this.api.get_sat_ecef_y(idx);
    const ez = this.api.get_sat_ecef_z(idx);
    return {
      index: idx,
      name: this.getSatName(idx),
      satnum: this.api.get_sat_satnum(idx),
      intlDesig: '',
      shellId,
      shellLabel: shell.label,
      inclinationDeg: this.api.get_sat_inclination_deg(idx),
      latDeg: this.api.get_sat_lat_deg(idx),
      lonDeg: this.api.get_sat_lon_deg(idx),
      altKm: this.api.get_sat_alt_km(idx),
      speedKms: this.api.get_sat_speed_kms(idx),
      visible: (status & 16) !== 0,
      elevationDeg: this.api.get_sat_elevation_deg(idx),
      azimuthDeg: this.api.get_sat_azimuth_deg(idx),
      rangeKm: this.api.get_sat_range_km(idx),
      threePos: [ex * invR, ez * invR, -ey * invR],
    };
  }

  getOrbitPathThree(
    idx: number,
    unixMs: number,
    halfSpanMins = 48.0,
    steps = 120,
    groundTrack = false,
  ): [number, number, number][] {
    if (!this.api || idx < 0 || idx >= this.count) return [];
    const n = this.api.compute_orbit_path(
      idx,
      unixMs,
      halfSpanMins,
      steps,
      groundTrack ? 1 : 0,
    );
    const pts: [number, number, number][] = [];
    const invR = 1.0 / EARTH_RADIUS_KM;
    for (let i = 0; i < n; i++) {
      const ex = this.api.get_orbit_path_coord(i, 0);
      const ey = this.api.get_orbit_path_coord(i, 1);
      const ez = this.api.get_orbit_path_coord(i, 2);
      pts.push([ex * invR, ez * invR, -ey * invR]);
    }
    return pts;
  }
}
