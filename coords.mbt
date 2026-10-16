///|
/// Rotate TEME position (km) by GMST angle (rad) into ECEF position (km).
pub fn teme_to_ecef(
  rx : Double,
  ry : Double,
  rz : Double,
  gmst : Double,
) -> (Double, Double, Double) {
  let cos_g = @math.cos(gmst)
  let sin_g = @math.sin(gmst)
  let x = cos_g * rx + sin_g * ry
  let y = -sin_g * rx + cos_g * ry
  (x, y, rz)
}

///|
/// Convert ECEF coordinates (km) to WGS-84 Geodetic coordinates:
/// `(lat_deg, lon_deg, alt_km)`.
pub fn ecef_to_geodetic(
  x : Double,
  y : Double,
  z : Double,
) -> (Double, Double, Double) {
  let r = @math.pow(x * x + y * y, 0.5)
  let lon_rad = @math.atan2(y, x)
  let mut lat_rad = @math.atan2(z, r)
  let mut c = 1.0
  let mut k = 0
  while k < 4 {
    let sin_lat = @math.sin(lat_rad)
    c = 1.0 / @math.pow(1.0 - wgs84_e2 * sin_lat * sin_lat, 0.5)
    lat_rad = @math.atan2(z + wgs84_a * c * wgs84_e2 * sin_lat, r)
    k = k + 1
  }
  let cos_lat = @math.cos(lat_rad)
  let sin_lat = @math.sin(lat_rad)
  let alt_km = if cos_lat.abs() > 1.0e-6 {
    r / cos_lat - wgs84_a * c
  } else {
    z.abs() / sin_lat.abs() - wgs84_a * c * (1.0 - wgs84_e2)
  }
  (lat_rad * rad_to_deg, lon_rad * rad_to_deg, alt_km)
}

///|
/// Convert WGS-84 Geodetic coordinates `(lat_deg, lon_deg, alt_km)` to ECEF (km).
pub fn geodetic_to_ecef(
  lat_deg : Double,
  lon_deg : Double,
  alt_km : Double,
) -> (Double, Double, Double) {
  let lat = lat_deg * deg_to_rad
  let lon = lon_deg * deg_to_rad
  let sin_lat = @math.sin(lat)
  let cos_lat = @math.cos(lat)
  let sin_lon = @math.sin(lon)
  let cos_lon = @math.cos(lon)
  let n = wgs84_a / @math.pow(1.0 - wgs84_e2 * sin_lat * sin_lat, 0.5)
  let x = (n + alt_km) * cos_lat * cos_lon
  let y = (n + alt_km) * cos_lat * sin_lon
  let z = (n * (1.0 - wgs84_e2) + alt_km) * sin_lat
  (x, y, z)
}

///|
/// Compute topocentric look angles `(azimuth_deg, elevation_deg, range_km)`
/// from an observer at `(obs_lat_deg, obs_lon_deg, obs_alt_km)` to a satellite
/// at ECEF `(sat_x, sat_y, sat_z)`.
pub fn compute_look_angles(
  obs_lat_deg : Double,
  obs_lon_deg : Double,
  obs_alt_km : Double,
  sat_x : Double,
  sat_y : Double,
  sat_z : Double,
) -> (Double, Double, Double) {
  let (ox, oy, oz) = geodetic_to_ecef(obs_lat_deg, obs_lon_deg, obs_alt_km)
  let rx = sat_x - ox
  let ry = sat_y - oy
  let rz = sat_z - oz
  let range_km = @math.pow(rx * rx + ry * ry + rz * rz, 0.5)
  if range_km < 1.0e-6 {
    return (0.0, 90.0, 0.0)
  }
  let lat = obs_lat_deg * deg_to_rad
  let lon = obs_lon_deg * deg_to_rad
  let sin_lat = @math.sin(lat)
  let cos_lat = @math.cos(lat)
  let sin_lon = @math.sin(lon)
  let cos_lon = @math.cos(lon)

  // Topocentric South-East-Zenith (SEZ) frame
  let top_s = sin_lat * cos_lon * rx + sin_lat * sin_lon * ry - cos_lat * rz
  let top_e = -sin_lon * rx + cos_lon * ry
  let top_z = cos_lat * cos_lon * rx + cos_lat * sin_lon * ry + sin_lat * rz

  let el_rad = @math.asin(
    if top_z / range_km > 1.0 {
      1.0
    } else if top_z / range_km < -1.0 {
      -1.0
    } else {
      top_z / range_km
    },
  )
  let mut az_rad = @math.atan2(-top_e, top_s) + pi
  if az_rad < 0.0 {
    az_rad = az_rad + two_pi
  } else if az_rad >= two_pi {
    az_rad = az_rad - two_pi
  }
  (az_rad * rad_to_deg, el_rad * rad_to_deg, range_km)
}
