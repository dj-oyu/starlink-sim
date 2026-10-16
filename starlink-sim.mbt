///|
/// Global simulation state holding initialized SGP4 satellites and per-frame outputs.
priv struct SimState {
  satellites : Array[SatRec]
  mut ecef_x : Array[Double]
  mut ecef_y : Array[Double]
  mut ecef_z : Array[Double]
  mut vel_x : Array[Double]
  mut vel_y : Array[Double]
  mut vel_z : Array[Double]
  mut sat_ok : Array[Bool]
  mut sat_el_deg : Array[Double]
  mut sat_az_deg : Array[Double]
  mut sat_range_km : Array[Double]
  mut sat_visible : Array[Bool]
  mut obs_lat_deg : Double
  mut obs_lon_deg : Double
  mut obs_alt_km : Double
  mut obs_min_el_deg : Double
  mut obs_enabled : Bool
  mut visible_count : Int32
  mut sun_x : Double
  mut sun_y : Double
  mut sun_z : Double
  orbit_path_xyz : Array[Double]
}

///|
let sim_state : SimState = {
  satellites: [],
  ecef_x: [],
  ecef_y: [],
  ecef_z: [],
  vel_x: [],
  vel_y: [],
  vel_z: [],
  sat_ok: [],
  sat_el_deg: [],
  sat_az_deg: [],
  sat_range_km: [],
  sat_visible: [],
  obs_lat_deg: 35.6762, // Tokyo default
  obs_lon_deg: 139.6503,
  obs_alt_km: 0.04,
  obs_min_el_deg: 25.0,
  obs_enabled: true,
  visible_count: 0,
  sun_x: 1.0,
  sun_y: 0.0,
  sun_z: 0.0,
  orbit_path_xyz: [],
}

///|
/// Clear all loaded satellites from the simulator state.
pub fn reset_constellation() -> Unit {
  sim_state.satellites.clear()
  sim_state.ecef_x = []
  sim_state.ecef_y = []
  sim_state.ecef_z = []
  sim_state.vel_x = []
  sim_state.vel_y = []
  sim_state.vel_z = []
  sim_state.sat_ok = []
  sim_state.sat_el_deg = []
  sim_state.sat_az_deg = []
  sim_state.sat_range_km = []
  sim_state.sat_visible = []
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
  sim_state.vel_x.push(0.0)
  sim_state.vel_y.push(0.0)
  sim_state.vel_z.push(0.0)
  sim_state.sat_ok.push(false)
  sim_state.sat_el_deg.push(-90.0)
  sim_state.sat_az_deg.push(0.0)
  sim_state.sat_range_km.push(0.0)
  sim_state.sat_visible.push(false)
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
}

///|
/// Propagate all satellites in the constellation to `unix_ms` (UTC milliseconds).
/// Computes SGP4 TEME state, rotates to ECEF, updates Sun direction, and evaluates
/// Ground Station visibility for every satellite.
/// Returns the number of valid propagated satellites.
pub fn propagate_constellation(unix_ms : Double) -> Int32 {
  let jd = unix_ms_to_jd(unix_ms)
  let gmst = gstime(jd)
  let cos_g = @math.cos(gmst)
  let sin_g = @math.sin(gmst)

  let (sx, sy, sz) = sun_direction_ecef(jd)
  sim_state.sun_x = sx
  sim_state.sun_y = sy
  sim_state.sun_z = sz

  // Precompute observer ECEF and topocentric basis vectors
  let (ox, oy, oz) = geodetic_to_ecef(
    sim_state.obs_lat_deg,
    sim_state.obs_lon_deg,
    sim_state.obs_alt_km,
  )
  let lat_r = sim_state.obs_lat_deg * deg_to_rad
  let lon_r = sim_state.obs_lon_deg * deg_to_rad
  let sin_lat = @math.sin(lat_r)
  let cos_lat = @math.cos(lat_r)
  let sin_lon = @math.sin(lon_r)
  let cos_lon = @math.cos(lon_r)
  let up_x = cos_lat * cos_lon
  let up_y = cos_lat * sin_lon
  let up_z = sin_lat
  let min_sin_el = @math.sin(sim_state.obs_min_el_deg * deg_to_rad)

  let n = sim_state.satellites.length()
  let mut valid_count = 0
  let mut vis_count = 0

  let mut i = 0
  while i < n {
    let sat = sim_state.satellites[i]
    let tsince = (jd - sat.jdsatepoch) * minutes_per_day
    let (rx, ry, rz, vx, vy, vz, ok) = sgp4_propagate(sat, tsince)
    if ok {
      let ex = cos_g * rx + sin_g * ry
      let ey = -sin_g * rx + cos_g * ry
      let ez = rz
      sim_state.ecef_x[i] = ex
      sim_state.ecef_y[i] = ey
      sim_state.ecef_z[i] = ez
      sim_state.vel_x[i] = cos_g * vx + sin_g * vy
      sim_state.vel_y[i] = -sin_g * vx + cos_g * vy
      sim_state.vel_z[i] = vz
      sim_state.sat_ok[i] = true
      valid_count = valid_count + 1

      if sim_state.obs_enabled {
        let dx = ex - ox
        let dy = ey - oy
        let dz = ez - oz
        let top_z = up_x * dx + up_y * dy + up_z * dz
        // Fast horizon cull: if top_z <= 0, satellite is below horizon
        if top_z > 0.0 {
          let range_sq = dx * dx + dy * dy + dz * dz
          let range = @math.pow(range_sq, 0.5)
          let sin_el = top_z / range
          if sin_el >= min_sin_el {
            let el_deg = @math.asin(if sin_el > 1.0 { 1.0 } else { sin_el }) *
              rad_to_deg
            let top_s = sin_lat * cos_lon * dx +
              sin_lat * sin_lon * dy -
              cos_lat * dz
            let top_e = -sin_lon * dx + cos_lon * dy
            let mut az_rad = @math.atan2(-top_e, top_s) + pi
            if az_rad < 0.0 {
              az_rad = az_rad + two_pi
            } else if az_rad >= two_pi {
              az_rad = az_rad - two_pi
            }
            sim_state.sat_el_deg[i] = el_deg
            sim_state.sat_az_deg[i] = az_rad * rad_to_deg
            sim_state.sat_range_km[i] = range
            sim_state.sat_visible[i] = true
            vis_count = vis_count + 1
          } else {
            sim_state.sat_visible[i] = false
          }
        } else {
          sim_state.sat_visible[i] = false
        }
      } else {
        sim_state.sat_visible[i] = false
      }
    } else {
      sim_state.sat_ok[i] = false
      sim_state.sat_visible[i] = false
    }
    i = i + 1
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
/// Get satellite velocity magnitude (speed) in km/s.
pub fn get_sat_speed_kms(idx : Int32) -> Double {
  let vx = sim_state.vel_x[idx]
  let vy = sim_state.vel_y[idx]
  let vz = sim_state.vel_z[idx]
  @math.pow(vx * vx + vy * vy + vz * vz, 0.5)
}

///|
/// Return 1 if satellite `idx` has a valid position, 0 otherwise.
pub fn get_sat_valid(idx : Int32) -> Int32 {
  if sim_state.sat_ok[idx] {
    1
  } else {
    0
  }
}

///|
/// Return 1 if satellite `idx` is currently visible from the observer ground station.
pub fn get_sat_visible(idx : Int32) -> Int32 {
  if sim_state.sat_visible[idx] {
    1
  } else {
    0
  }
}

///|
/// Get observer elevation angle (degrees) for satellite `idx`.
pub fn get_sat_elevation_deg(idx : Int32) -> Double {
  sim_state.sat_el_deg[idx]
}

///|
/// Get observer azimuth angle (degrees) for satellite `idx`.
pub fn get_sat_azimuth_deg(idx : Int32) -> Double {
  sim_state.sat_az_deg[idx]
}

///|
/// Get observer slant range (km) for satellite `idx`.
pub fn get_sat_range_km(idx : Int32) -> Double {
  sim_state.sat_range_km[idx]
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
/// Coordinates are stored in ECEF (or snapshot-locked ECI rotated by `current_gmst` so the
/// inertial orbital ring is smooth) and can be retrieved via `get_orbit_path_coord`.
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
    let (rx, ry, rz, _, _, _, ok) = sgp4_propagate(sat, tsince)
    if ok {
      if use_ground_track != 0 {
        let g = gstime(sample_jd)
        let (ex, ey, ez) = teme_to_ecef(rx, ry, rz, g)
        sim_state.orbit_path_xyz.push(ex)
        sim_state.orbit_path_xyz.push(ey)
        sim_state.orbit_path_xyz.push(ez)
      } else {
        // Inertial ring rotated into current Earth orientation
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
