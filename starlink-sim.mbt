///|
/// Global simulation state holding initialized SGP4 satellites and compact bit-packed outputs.
/// `sat_status[i]` packs: bit0..2 = shell_id (0..4), bit3 = valid (8), bit4 = visible (16).
priv struct SimState {
  satellites : Array[SatRec]
  mut ecef_x : Array[Double]
  mut ecef_y : Array[Double]
  mut ecef_z : Array[Double]
  mut sat_status : Array[Int32]
  // Render-ready positions (Three.js axes, Earth radii, Float32) written straight into
  // wasm linear memory so JS can bulk-copy them instead of making 3 calls per satellite.
  mut render_pos : FixedArray[Float]
  // GPU-extrapolation anchors: per satellite the exact SGP4 TEME state (x y z km, vx vy vz km/s)
  // and the time it was computed (seconds since the host-chosen base time), in wasm memory.
  mut anchor_pv : FixedArray[Float]
  mut anchor_t : FixedArray[Float]
  mut visible_indices : Array[Int32]
  mut obs_lat_deg : Double
  mut obs_lon_deg : Double
  mut obs_alt_km : Double
  mut obs_min_el_deg : Double
  mut obs_enabled : Bool
  mut obs_ox : Double
  mut obs_oy : Double
  mut obs_oz : Double
  mut obs_sin_lat : Double
  mut obs_cos_lat : Double
  mut obs_sin_lon : Double
  mut obs_cos_lon : Double
  mut visible_count : Int32
  mut sun_x : Double
  mut sun_y : Double
  mut sun_z : Double
  mut last_jd : Double
  orbit_path_xyz : Array[Double]
}

///|
let sim_state : SimState = {
  satellites: [],
  ecef_x: [],
  ecef_y: [],
  ecef_z: [],
  sat_status: [],
  render_pos: FixedArray::make(0, Float::from_double(0.0)),
  anchor_pv: FixedArray::make(0, Float::from_double(0.0)),
  anchor_t: FixedArray::make(0, Float::from_double(0.0)),
  visible_indices: [],
  obs_lat_deg: 35.6762, // Tokyo default
  obs_lon_deg: 139.6503,
  obs_alt_km: 0.04,
  obs_min_el_deg: 25.0,
  obs_enabled: true,
  obs_ox: -3954.8,
  obs_oy: 3354.9,
  obs_oz: 3700.2,
  obs_sin_lat: 0.5832,
  obs_cos_lat: 0.8123,
  obs_sin_lon: 0.6474,
  obs_cos_lon: -0.7621,
  visible_count: 0,
  sun_x: 1.0,
  sun_y: 0.0,
  sun_z: 0.0,
  last_jd: 2461330.5,
  orbit_path_xyz: [],
}

///|
/// Clear all loaded satellites from the simulator state.
pub fn reset_constellation() -> Unit {
  sim_state.satellites.clear()
  sim_state.ecef_x = []
  sim_state.ecef_y = []
  sim_state.ecef_z = []
  sim_state.sat_status = []
  sim_state.render_pos = FixedArray::make(0, Float::from_double(0.0))
  sim_state.anchor_pv = FixedArray::make(0, Float::from_double(0.0))
  sim_state.anchor_t = FixedArray::make(0, Float::from_double(0.0))
  sim_state.visible_indices = []
  sim_state.visible_count = 0
}

///|
/// Add a satellite from parsed TLE numerical elements and initialize its SGP4 record.
/// Returns the 0-based index of the added satellite.
pub fn add_satellite_elements(
  satnum : Int32,
  epoch_year : Int32,
  epoch_days : Double,
  bstar : Double,
  inclo_deg : Double,
  nodeo_deg : Double,
  ecco : Double,
  argpo_deg : Double,
  mo_deg : Double,
  no_kozai_rpd : Double,
) -> Int32 {
  let tle = TleData::from_elements(
    satnum, epoch_year, epoch_days, bstar, inclo_deg, nodeo_deg, ecco, argpo_deg,
    mo_deg, no_kozai_rpd,
  )
  let rec = sgp4_init(tle)
  let idx = sim_state.satellites.length()
  sim_state.satellites.push(rec)
  sim_state.ecef_x.push(0.0)
  sim_state.ecef_y.push(0.0)
  sim_state.ecef_z.push(0.0)
  sim_state.sat_status.push(rec.shell_id & 7)
  idx
}

///|
/// Return the total number of satellites in the constellation.
pub fn get_satellite_count() -> Int32 {
  sim_state.satellites.length()
}

///|
/// Configure the Ground Station observer location and minimum elevation angle.
pub fn set_observer(
  lat_deg : Double,
  lon_deg : Double,
  alt_km : Double,
  min_el_deg : Double,
  enabled : Int32,
) -> Unit {
  sim_state.obs_lat_deg = lat_deg
  sim_state.obs_lon_deg = lon_deg
  sim_state.obs_alt_km = alt_km
  sim_state.obs_min_el_deg = min_el_deg
  sim_state.obs_enabled = enabled != 0
  let (ox, oy, oz) = geodetic_to_ecef(lat_deg, lon_deg, alt_km)
  sim_state.obs_ox = ox
  sim_state.obs_oy = oy
  sim_state.obs_oz = oz
  sim_state.obs_sin_lat = @math.sin(lat_deg * deg_to_rad)
  sim_state.obs_cos_lat = @math.cos(lat_deg * deg_to_rad)
  sim_state.obs_sin_lon = @math.sin(lon_deg * deg_to_rad)
  sim_state.obs_cos_lon = @math.cos(lon_deg * deg_to_rad)
}

///|
/// Propagate every satellite to `unix_ms` (UTC milliseconds).
/// Computes SGP4 TEME state, rotates to ECEF, updates Sun direction, and packs
/// `(shell_id | (valid << 3) | (visible << 4))` into `sat_status` with zero transcendental calls.
/// Returns the number of valid propagated satellites.
pub fn propagate_constellation(unix_ms : Double) -> Int32 {
  propagate_slice_impl(unix_ms, 0, 1, false, 0.0)
}

///|
/// Propagate only slice `slice` of `slice_count` equal contiguous slices of the
/// constellation to `unix_ms`; the other satellites keep their previous state. Lets the
/// host spread the work over several frames on slow devices. Sun direction, ground-station
/// geometry and the visible list are refreshed on every call. Returns the number of valid
/// satellites in the slice.
pub fn propagate_constellation_slice(
  unix_ms : Double,
  slice : Int32,
  slice_count : Int32,
) -> Int32 {
  if slice_count < 1 || slice < 0 || slice >= slice_count {
    return 0
  }
  propagate_slice_impl(unix_ms, slice, slice_count, false, 0.0)
}

///|
/// Finite-difference step used to derive anchor velocities.
let anchor_dt_sec : Double = 0.5

///|
let anchor_dt_min : Double = 0.5 / 60.0

///|
/// Standard gravitational parameter of the Earth (WGS-72, as used by SGP4), km^3/s^2.
let earth_mu_km3s2 : Double = 398600.8

///|
/// Like `propagate_constellation_slice`, but also records each refreshed satellite's SGP4 TEME state and its time (seconds since `base_ms`) in
/// the anchor buffers (see `prepare_anchor_buffers`). A GPU vertex shader can then extrapolate
/// positions from these anchors at render time, so anchors only need refreshing at a low rate.
pub fn propagate_constellation_slice_anchored(
  unix_ms : Double,
  slice : Int32,
  slice_count : Int32,
  base_ms : Double,
) -> Int32 {
  if slice_count < 1 || slice < 0 || slice >= slice_count {
    return 0
  }
  propagate_slice_impl(unix_ms, slice, slice_count, true, base_ms)
}

///|
fn propagate_slice_impl(
  unix_ms : Double,
  slice : Int32,
  slice_count : Int32,
  anchored : Bool,
  base_ms : Double,
) -> Int32 {
  let jd = unix_ms_to_jd(unix_ms)
  sim_state.last_jd = jd
  let gmst = gstime(jd)
  let cos_g = @math.cos(gmst)
  let sin_g = @math.sin(gmst)

  let (sx, sy, sz) = sun_direction_ecef(jd)
  sim_state.sun_x = sx
  sim_state.sun_y = sy
  sim_state.sun_z = sz

  // Precompute observer ECEF and topocentric zenith unit vector
  let (ox, oy, oz) = geodetic_to_ecef(
    sim_state.obs_lat_deg,
    sim_state.obs_lon_deg,
    sim_state.obs_alt_km,
  )
  sim_state.obs_ox = ox
  sim_state.obs_oy = oy
  sim_state.obs_oz = oz
  let lat_r = sim_state.obs_lat_deg * deg_to_rad
  let lon_r = sim_state.obs_lon_deg * deg_to_rad
  let sin_lat = @math.sin(lat_r)
  let cos_lat = @math.cos(lat_r)
  let sin_lon = @math.sin(lon_r)
  let cos_lon = @math.cos(lon_r)
  sim_state.obs_sin_lat = sin_lat
  sim_state.obs_cos_lat = cos_lat
  sim_state.obs_sin_lon = sin_lon
  sim_state.obs_cos_lon = cos_lon
  let up_x = cos_lat * cos_lon
  let up_y = cos_lat * sin_lon
  let up_z = sin_lat
  let min_sin_el = @math.sin(sim_state.obs_min_el_deg * deg_to_rad)
  let min_sin_el_sq = min_sin_el * min_sin_el
  let obs_on = sim_state.obs_enabled

  let visible_indices = sim_state.visible_indices
  if slice_count == 1 {
    visible_indices.clear()
  }
  // Hoist the per-call invariant array handles out of the loop; all four
  // output arrays are kept at exactly `satellites.length()` entries by
  // `add_satellite_elements` / `reset_constellation`, so unchecked access is safe.
  let satellites = sim_state.satellites
  let ecef_x = sim_state.ecef_x
  let ecef_y = sim_state.ecef_y
  let ecef_z = sim_state.ecef_z
  let sat_status = sim_state.sat_status
  let n = satellites.length()
  guard ecef_x.length() == n &&
    ecef_y.length() == n &&
    ecef_z.length() == n &&
    sat_status.length() == n else {
    return 0
  }
  let render_pos = sim_state.render_pos
  let write_render = render_pos.length() == n * 3
  let anchor_pv = sim_state.anchor_pv
  let anchor_t = sim_state.anchor_t
  let write_anchor = anchored &&
    anchor_pv.length() == n * 6 &&
    anchor_t.length() == n
  let anchor_time = Float::from_double((unix_ms - base_ms) / 1000.0)
  let inv_r = 1.0 / earth_radius_km
  let mut valid_count = 0
  let mut vis_count = 0
  let lo = n * slice / slice_count
  let hi = n * (slice + 1) / slice_count
  if slice_count > 1 {
    // Incremental update: forget this slice's previous visible entries (they are re-added
    // below if still visible) instead of rescanning every satellite's status.
    let len = visible_indices.length()
    let mut w = 0
    let mut r = 0
    while r < len {
      let idx = visible_indices[r]
      if idx < lo || idx >= hi {
        visible_indices[w] = idx
        w = w + 1
      }
      r = r + 1
    }
    visible_indices.truncate(w)
  }

  let mut i = lo
  while i < hi {
    let sat = satellites.unsafe_get(i)
    let shell_bits = sat.shell_id & 7
    let tsince = (jd - sat.jdsatepoch) * minutes_per_day
    let ok = sgp4_pos_into(sat, tsince)
    if ok {
      let rx = pos_out.x
      let ry = pos_out.y
      let rz = pos_out.z
      if write_anchor {
        // Velocity from a second (cheap, memoised) fast-path evaluation half a second later:
        // v = (p1 - p0) / dt - 0.5 * a * dt (a points inward, so this adds a term), a = two-body gravity at p0 (the J2 part of
        // the acceleration is ~1e-3 of this, so the remaining error is a few mm/s).
        let r2 = rx * rx + ry * ry + rz * rz
        let r1 = r2.sqrt()
        let mut vx = 0.0
        let mut vy = 0.0
        let mut vz = 0.0
        if sgp4_pos_into(sat, tsince + anchor_dt_min) {
          let g = 0.5 * anchor_dt_sec * earth_mu_km3s2 / (r2 * r1)
          vx = (pos_out.x - rx) / anchor_dt_sec + g * rx
          vy = (pos_out.y - ry) / anchor_dt_sec + g * ry
          vz = (pos_out.z - rz) / anchor_dt_sec + g * rz
        }
        let a6 = i * 6
        anchor_pv.unsafe_set(a6, Float::from_double(rx))
        anchor_pv.unsafe_set(a6 + 1, Float::from_double(ry))
        anchor_pv.unsafe_set(a6 + 2, Float::from_double(rz))
        anchor_pv.unsafe_set(a6 + 3, Float::from_double(vx))
        anchor_pv.unsafe_set(a6 + 4, Float::from_double(vy))
        anchor_pv.unsafe_set(a6 + 5, Float::from_double(vz))
        anchor_t.unsafe_set(i, anchor_time)
      }
      let ex = cos_g * rx + sin_g * ry
      let ey = -sin_g * rx + cos_g * ry
      let ez = rz
      ecef_x.unsafe_set(i, ex)
      ecef_y.unsafe_set(i, ey)
      ecef_z.unsafe_set(i, ez)
      if write_render {
        // Three.js frame: (x, z, -y), in Earth radii
        let o = i * 3
        render_pos.unsafe_set(o, Float::from_double(ex * inv_r))
        render_pos.unsafe_set(o + 1, Float::from_double(ez * inv_r))
        render_pos.unsafe_set(o + 2, Float::from_double(-ey * inv_r))
      }
      valid_count = valid_count + 1

      let mut status = shell_bits | 8
      if obs_on {
        let dx = ex - ox
        let dy = ey - oy
        let dz = ez - oz
        let top_z = up_x * dx + up_y * dy + up_z * dz
        // Pure algebraic elevation cone test (zero sqrt / asin / atan2 in hot loop!)
        if top_z > 0.0 {
          let range_sq = dx * dx + dy * dy + dz * dz
          if top_z * top_z >= range_sq * min_sin_el_sq {
            status = status | 16
            visible_indices.push(i)
            vis_count = vis_count + 1
          }
        }
      }
      sat_status.unsafe_set(i, status)
    } else {
      sat_status.unsafe_set(i, shell_bits)
    }
    i = i + 1
  }
  if slice_count > 1 {
    vis_count = visible_indices.length()
  }
  sim_state.visible_count = vis_count
  valid_count
}

///|
/// Get satellite ECEF X coordinate in km.
pub fn get_sat_ecef_x(idx : Int32) -> Double {
  sim_state.ecef_x[idx]
}

///|
/// Get satellite ECEF Y coordinate in km.
pub fn get_sat_ecef_y(idx : Int32) -> Double {
  sim_state.ecef_y[idx]
}

///|
/// Get satellite ECEF Z coordinate in km.
pub fn get_sat_ecef_z(idx : Int32) -> Double {
  sim_state.ecef_z[idx]
}

///|
/// Get bit-packed status byte for satellite `idx`:
/// `bits 0..2 = shell_id (0..4)`, `bit 3 (8) = valid`, `bit 4 (16) = visible`.
pub fn get_sat_status(idx : Int32) -> Int32 {
  sim_state.sat_status[idx]
}

///|
/// SWAR (SIMD Within A Register): Pack 4 consecutive satellite status bytes
/// (`base_idx .. base_idx + 3`) into a single 32-bit integer word.
pub fn get_sat_status_quad(base_idx : Int32) -> Int32 {
  let n = sim_state.sat_status.length()
  let b0 = if base_idx < n { sim_state.sat_status[base_idx] } else { 0 }
  let b1 = if base_idx + 1 < n { sim_state.sat_status[base_idx + 1] } else { 0 }
  let b2 = if base_idx + 2 < n { sim_state.sat_status[base_idx + 2] } else { 0 }
  let b3 = if base_idx + 3 < n { sim_state.sat_status[base_idx + 3] } else { 0 }
  b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
}

///|
/// Get satellite index at position `k` (`0 .. visible_count - 1`) in the visible list.
pub fn get_visible_sat_index(k : Int32) -> Int32 {
  sim_state.visible_indices[k]
}

///|
/// Get satellite velocity magnitude (speed) in km/s (computed on-demand for selected satellite).
pub fn get_sat_speed_kms(idx : Int32) -> Double {
  let sat = sim_state.satellites[idx]
  let tsince = (sim_state.last_jd - sat.jdsatepoch) * minutes_per_day
  let (_, _, _, vx, vy, vz, ok) = sgp4_propagate(sat, tsince)
  if ok {
    (vx * vx + vy * vy + vz * vz).sqrt()
  } else {
    0.0
  }
}

///|
/// Return 1 if satellite `idx` has a valid position, 0 otherwise.
pub fn get_sat_valid(idx : Int32) -> Int32 {
  (sim_state.sat_status[idx] >> 3) & 1
}

///|
/// Return 1 if satellite `idx` is currently visible from the observer ground station.
pub fn get_sat_visible(idx : Int32) -> Int32 {
  (sim_state.sat_status[idx] >> 4) & 1
}

///|
/// Compute observer elevation angle (degrees) on-demand for satellite `idx`.
pub fn get_sat_elevation_deg(idx : Int32) -> Double {
  let dx = sim_state.ecef_x[idx] - sim_state.obs_ox
  let dy = sim_state.ecef_y[idx] - sim_state.obs_oy
  let dz = sim_state.ecef_z[idx] - sim_state.obs_oz
  let range = (dx * dx + dy * dy + dz * dz).sqrt()
  if range <= 1.0e-9 {
    return -90.0
  }
  let up_x = sim_state.obs_cos_lat * sim_state.obs_cos_lon
  let up_y = sim_state.obs_cos_lat * sim_state.obs_sin_lon
  let up_z = sim_state.obs_sin_lat
  let sin_el = (up_x * dx + up_y * dy + up_z * dz) / range
  let clamped = if sin_el > 1.0 {
    1.0
  } else if sin_el < -1.0 {
    -1.0
  } else {
    sin_el
  }
  @math.asin(clamped) * rad_to_deg
}

///|
/// Compute observer azimuth angle (degrees) on-demand for satellite `idx`.
pub fn get_sat_azimuth_deg(idx : Int32) -> Double {
  let dx = sim_state.ecef_x[idx] - sim_state.obs_ox
  let dy = sim_state.ecef_y[idx] - sim_state.obs_oy
  let dz = sim_state.ecef_z[idx] - sim_state.obs_oz
  let top_s = sim_state.obs_sin_lat * sim_state.obs_cos_lon * dx +
    sim_state.obs_sin_lat * sim_state.obs_sin_lon * dy -
    sim_state.obs_cos_lat * dz
  let top_e = -sim_state.obs_sin_lon * dx + sim_state.obs_cos_lon * dy
  let mut az_rad = @math.atan2(-top_e, top_s) + pi
  if az_rad < 0.0 {
    az_rad = az_rad + two_pi
  } else if az_rad >= two_pi {
    az_rad = az_rad - two_pi
  }
  az_rad * rad_to_deg
}

///|
/// Compute observer slant range (km) on-demand for satellite `idx`.
pub fn get_sat_range_km(idx : Int32) -> Double {
  let dx = sim_state.ecef_x[idx] - sim_state.obs_ox
  let dy = sim_state.ecef_y[idx] - sim_state.obs_oy
  let dz = sim_state.ecef_z[idx] - sim_state.obs_oz
  (dx * dx + dy * dy + dz * dz).sqrt()
}

///|
/// Get count of satellites currently visible from the observer ground station.
pub fn get_visible_count() -> Int32 {
  sim_state.visible_count
}

///|
/// Get NORAD catalog number for satellite `idx`.
pub fn get_sat_satnum(idx : Int32) -> Int32 {
  sim_state.satellites[idx].satnum
}

///|
/// Get orbital shell ID (0..4) for satellite `idx`.
pub fn get_sat_shell(idx : Int32) -> Int32 {
  sim_state.satellites[idx].shell_id
}

///|
/// Get orbital inclination in degrees for satellite `idx`.
pub fn get_sat_inclination_deg(idx : Int32) -> Double {
  sim_state.satellites[idx].inclo * rad_to_deg
}

///|
/// Get geodetic latitude (deg) for satellite `idx` from its current ECEF position.
pub fn get_sat_lat_deg(idx : Int32) -> Double {
  let (lat, _, _) = ecef_to_geodetic(
    sim_state.ecef_x[idx],
    sim_state.ecef_y[idx],
    sim_state.ecef_z[idx],
  )
  lat
}

///|
/// Get geodetic longitude (deg) for satellite `idx` from its current ECEF position.
pub fn get_sat_lon_deg(idx : Int32) -> Double {
  let (_, lon, _) = ecef_to_geodetic(
    sim_state.ecef_x[idx],
    sim_state.ecef_y[idx],
    sim_state.ecef_z[idx],
  )
  lon
}

///|
/// Get geodetic altitude (km) for satellite `idx` from its current ECEF position.
pub fn get_sat_alt_km(idx : Int32) -> Double {
  let (_, _, alt) = ecef_to_geodetic(
    sim_state.ecef_x[idx],
    sim_state.ecef_y[idx],
    sim_state.ecef_z[idx],
  )
  alt
}

///|
/// Get current Sun unit vector X in ECEF.
pub fn get_sun_ecef_x() -> Double {
  sim_state.sun_x
}

///|
/// Get current Sun unit vector Y in ECEF.
pub fn get_sun_ecef_y() -> Double {
  sim_state.sun_y
}

///|
/// Get current Sun unit vector Z in ECEF.
pub fn get_sun_ecef_z() -> Double {
  sim_state.sun_z
}

///|
/// Compute an orbital trajectory path for satellite `idx` centered around `center_unix_ms`,
/// spanning `[-half_span_mins, +half_span_mins]` with `num_steps` sample points.
pub fn compute_orbit_path(
  idx : Int32,
  center_unix_ms : Double,
  half_span_mins : Double,
  num_steps : Int32,
  use_ground_track : Int32,
) -> Int32 {
  sim_state.orbit_path_xyz.clear()
  if idx < 0 || idx >= sim_state.satellites.length() || num_steps <= 1 {
    return 0
  }
  let sat = sim_state.satellites[idx]
  let center_jd = unix_ms_to_jd(center_unix_ms)
  let center_gmst = gstime(center_jd)
  let cos_cg = @math.cos(center_gmst)
  let sin_cg = @math.sin(center_gmst)

  let mut step = 0
  let mut count = 0
  while step <= num_steps {
    let frac = step.to_double() / num_steps.to_double()
    let offset_min = -half_span_mins + 2.0 * half_span_mins * frac
    let sample_jd = center_jd + offset_min / minutes_per_day
    let tsince = (sample_jd - sat.jdsatepoch) * minutes_per_day
    let (rx, ry, rz, ok) = sgp4_propagate_pos(sat, tsince)
    if ok {
      if use_ground_track != 0 {
        let g = gstime(sample_jd)
        let (ex, ey, ez) = teme_to_ecef(rx, ry, rz, g)
        sim_state.orbit_path_xyz.push(ex)
        sim_state.orbit_path_xyz.push(ey)
        sim_state.orbit_path_xyz.push(ez)
      } else {
        let ex = cos_cg * rx + sin_cg * ry
        let ey = -sin_cg * rx + cos_cg * ry
        let ez = rz
        sim_state.orbit_path_xyz.push(ex)
        sim_state.orbit_path_xyz.push(ey)
        sim_state.orbit_path_xyz.push(ez)
      }
      count = count + 1
    }
    step = step + 1
  }
  count
}

///|
/// Get coordinate component `comp` (0=x, 1=y, 2=z) of point `pt_idx` from the last `compute_orbit_path` call.
pub fn get_orbit_path_coord(pt_idx : Int32, comp : Int32) -> Double {
  sim_state.orbit_path_xyz[pt_idx * 3 + comp]
}

///|
/// Raw wasm pointer of a FixedArray[Float]; in this backend it points directly at the element data
/// (verified: no object header precedes the first element).
#borrow(a)
extern "wasm" fn addr_of_floats(a : FixedArray[Float]) -> Int32 =
  #|(func (param i32) (result i32) (local.get 0))

///|
/// Allocate the render-ready position buffer (3 Float32 per satellite). Call after all
/// satellites are loaded (and again if the count changes). Returns the number of floats.
pub fn prepare_render_buffer() -> Int32 {
  let n = sim_state.satellites.length()
  sim_state.render_pos = FixedArray::make(n * 3, Float::from_double(0.0))
  n * 3
}

///|
/// Byte address in wasm linear memory of the first float of the render buffer, written by
/// `propagate_constellation`. Valid until the next `prepare_render_buffer` / `reset_constellation`.
pub fn get_render_buffer_ptr() -> Int32 {
  addr_of_floats(sim_state.render_pos)
}

///|
/// Allocate the GPU-anchor buffers (6 + 1 Float32 per satellite). Call after all satellites are
/// loaded. Returns the number of satellites.
pub fn prepare_anchor_buffers() -> Int32 {
  let n = sim_state.satellites.length()
  sim_state.anchor_pv = FixedArray::make(n * 6, Float::from_double(0.0))
  sim_state.anchor_t = FixedArray::make(n, Float::from_double(0.0))
  n
}

///|
/// Wasm address of the anchor state buffer (6 Float32 per satellite: x y z vx vy vz, TEME, km & km/s).
pub fn get_anchor_pv_ptr() -> Int32 {
  addr_of_floats(sim_state.anchor_pv)
}

///|
/// Wasm address of the anchor time buffer (1 Float32 per satellite: seconds since `base_ms`).
pub fn get_anchor_t_ptr() -> Int32 {
  addr_of_floats(sim_state.anchor_t)
}
