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
  get_sat_ecef_x: (idx: number) => number;
  get_sat_ecef_y: (idx: number) => number;
  get_sat_ecef_z: (idx: number) => number;
  get_sat_speed_kms: (idx: number) => number;
  get_sat_valid: (idx: number) => number;
  get_sat_visible: (idx: number) => number;
  get_sat_elevation_deg: (idx: number) => number;
  get_sat_azimuth_deg: (idx: number) => number;
  get_sat_range_km: (idx: number) => number;
  get_visible_count: () => number;
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
  public metadata: SatelliteMeta[] = [];
  public positionsThree: Float32Array = new Float32Array(0);
  public validFlags: Uint8Array = new Uint8Array(0);
  public visibleFlags: Uint8Array = new Uint8Array(0);
  public shellIds: Uint8Array = new Uint8Array(0);
  public visibleIndices: number[] = [];
  public shellCounts: number[] = [0, 0, 0, 0, 0];
  public sunDirectionThree: [number, number, number] = [1, 0, 0];
  public defaultEpochUnixMs: number = Date.now();
  public lastPropagateMs = 0;
  public wasmPureSgp4Ms = 0;
  public wasmReadoutMs = 0;
  public wasmMemoryBytes = 0;

  async init(): Promise<void> {
    const [wasmRes, tleRes] = await Promise.all([
      fetch('/assets/wasm/starlink-sim.wasm'),
      fetch('/assets/data/starlink.tle'),
    ]);
    const wasmBytes = await wasmRes.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    this.api = instance.exports as unknown as WasmSimExports;

    const tleText = await tleRes.text();
    this.loadTleDataset(tleText);
  }

  loadTleDataset(tleText: string): number {
    if (!this.api) return 0;
    this.api.reset_constellation();
    this.metadata = [];
    this.shellCounts = [0, 0, 0, 0, 0];

    const lines = tleText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let epochSum = 0;
    let epochCount = 0;

    for (let i = 0; i < lines.length; ) {
      // Support both 3-line (Name + Line1 + Line2) and 2-line TLE formats
      let name = '';
      let l1 = '';
      let l2 = '';

      if (
        lines[i].startsWith('1 ') &&
        i + 1 < lines.length &&
        lines[i + 1].startsWith('2 ')
      ) {
        l1 = lines[i];
        l2 = lines[i + 1];
        name = `STARLINK-${l1.slice(2, 7).trim()}`;
        i += 2;
      } else if (
        i + 2 < lines.length &&
        lines[i + 1].startsWith('1 ') &&
        lines[i + 2].startsWith('2 ')
      ) {
        name = lines[i];
        l1 = lines[i + 1];
        l2 = lines[i + 2];
        i += 3;
      } else {
        i += 1;
        continue;
      }

      const satnum = parseInt(l1.slice(2, 7), 10);
      const intlDesig = l1.slice(9, 17).trim();
      const epochYr = parseInt(l1.slice(18, 20), 10);
      const epochDays = parseFloat(l1.slice(20, 32));
      const bstar = parseTleExp(l1.slice(53, 61));

      const inclo = parseFloat(l2.slice(8, 16));
      const nodeo = parseFloat(l2.slice(17, 25));
      const ecco = parseInt(l2.slice(26, 33), 10) * 1e-7;
      const argpo = parseFloat(l2.slice(34, 42));
      const mo = parseFloat(l2.slice(43, 51));
      const no = parseFloat(l2.slice(52, 63));

      if (isNaN(satnum) || isNaN(epochDays) || isNaN(no) || no <= 0) {
        continue;
      }

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

      this.metadata.push({
        index: idx,
        name,
        satnum,
        intlDesig,
        shellId,
        inclinationDeg: inclo,
      });

      const fullYear = epochYr < 57 ? 2000 + epochYr : 1900 + epochYr;
      const jan1Ms = Date.UTC(fullYear, 0, 1, 0, 0, 0);
      const satEpochMs = jan1Ms + (epochDays - 1) * 86400000;
      epochSum += satEpochMs;
      epochCount++;
    }

    const total = this.metadata.length;
    this.positionsThree = new Float32Array(total * 3);
    this.validFlags = new Uint8Array(total);
    this.visibleFlags = new Uint8Array(total);
    this.shellIds = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      this.shellIds[i] = this.metadata[i].shellId;
    }
    if (epochCount > 0) {
      this.defaultEpochUnixMs = epochSum / epochCount;
    }
    this.wasmMemoryBytes = this.api.memory?.buffer?.byteLength ?? 0;
    return total;
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

  propagate(unixMs: number): void {
    if (!this.api) return;
    const t0 = performance.now();
    this.api.propagate_constellation(unixMs);
    const t1 = performance.now();

    const sx = this.api.get_sun_ecef_x();
    const sy = this.api.get_sun_ecef_y();
    const sz = this.api.get_sun_ecef_z();
    this.sunDirectionThree = [sx, sz, -sy];

    const api = this.api;
    const count = this.metadata.length;
    const invR = 1.0 / EARTH_RADIUS_KM;
    const pos = this.positionsThree;
    const valid = this.validFlags;
    const vis = this.visibleFlags;
    const visList = this.visibleIndices;
    visList.length = 0;

    for (let i = 0; i < count; i++) {
      const ok = api.get_sat_valid(i);
      valid[i] = ok;
      const i3 = i * 3;
      if (ok) {
        const ex = api.get_sat_ecef_x(i);
        const ey = api.get_sat_ecef_y(i);
        const ez = api.get_sat_ecef_z(i);
        pos[i3] = ex * invR;
        pos[i3 + 1] = ez * invR;
        pos[i3 + 2] = -ey * invR;

        const isVis = api.get_sat_visible(i);
        vis[i] = isVis;
        if (isVis) {
          visList.push(i);
        }
      } else {
        pos[i3] = 0;
        pos[i3 + 1] = 0;
        pos[i3 + 2] = 0;
        vis[i] = 0;
      }
    }

    const t2 = performance.now();
    this.wasmPureSgp4Ms = t1 - t0;
    this.wasmReadoutMs = t2 - t1;
    this.lastPropagateMs = t2 - t0;
    this.wasmMemoryBytes = api.memory?.buffer?.byteLength ?? 0;
  }

  getSatelliteTelemetry(idx: number): SatelliteTelemetry | null {
    if (!this.api || idx < 0 || idx >= this.metadata.length) return null;
    const meta = this.metadata[idx];
    const shell = SHELL_INFO[meta.shellId] ?? SHELL_INFO[0];
    const i3 = idx * 3;
    return {
      index: idx,
      name: meta.name,
      satnum: meta.satnum,
      intlDesig: meta.intlDesig,
      shellId: meta.shellId,
      shellLabel: shell.label,
      inclinationDeg: meta.inclinationDeg,
      latDeg: this.api.get_sat_lat_deg(idx),
      lonDeg: this.api.get_sat_lon_deg(idx),
      altKm: this.api.get_sat_alt_km(idx),
      speedKms: this.api.get_sat_speed_kms(idx),
      visible: this.visibleFlags[idx] === 1,
      elevationDeg: this.api.get_sat_elevation_deg(idx),
      azimuthDeg: this.api.get_sat_azimuth_deg(idx),
      rangeKm: this.api.get_sat_range_km(idx),
      threePos: [
        this.positionsThree[i3],
        this.positionsThree[i3 + 1],
        this.positionsThree[i3 + 2],
      ],
    };
  }

  getOrbitPathThree(
    idx: number,
    unixMs: number,
    halfSpanMins = 48.0,
    steps = 120,
    groundTrack = false,
  ): [number, number, number][] {
    if (!this.api || idx < 0 || idx >= this.metadata.length) return [];
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
