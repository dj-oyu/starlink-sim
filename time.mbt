///|
/// Normalize an angle in radians to the range [0, 2*pi).
pub fn normalize_rad(angle : Double) -> Double {
  let mut a = angle % two_pi
  if a < 0.0 {
    a = a + two_pi
  }
  a
}

///|
/// Convert Unix timestamp in milliseconds to Julian Date (JD).
/// Unix epoch (1970-01-01T00:00:00Z) is JD 2440587.5.
pub fn unix_ms_to_jd(unix_ms : Double) -> Double {
  2440587.5 + unix_ms / 86400000.0
}

///|
/// Convert Julian Date (JD) to Unix timestamp in milliseconds.
pub fn jd_to_unix_ms(jd : Double) -> Double {
  (jd - 2440587.5) * 86400000.0
}

///|
/// Convert calendar date and UTC time to Julian Date.
pub fn calendar_to_jd(
  year : Int32,
  month : Int32,
  day : Int32,
  hour : Int32,
  minute : Int32,
  sec : Double,
) -> Double {
  let y = year.to_double()
  let m = month.to_double()
  let d = day.to_double()
  let term1 = 367.0 * y
  let term2 = (7.0 * (y + ((m + 9.0) / 12.0).floor()) * 0.25).floor()
  let term3 = (275.0 * m / 9.0).floor()
  let jd0 = term1 - term2 + term3 + d + 1721013.5
  let frac = ((sec / 60.0 + minute.to_double()) / 60.0 + hour.to_double()) /
    24.0
  jd0 + frac
}

///|
/// Convert TLE 2-digit or 4-digit year and day-of-year (1-based) to Julian Date.
pub fn tle_epoch_to_jd(epoch_year : Int32, epoch_days : Double) -> Double {
  let full_year = if epoch_year < 57 {
    epoch_year + 2000
  } else if epoch_year < 100 {
    epoch_year + 1900
  } else {
    epoch_year
  }
  // JD at Jan 0.0 of full_year (which is Dec 31.0 of full_year - 1)
  let jan1_jd = calendar_to_jd(full_year, 1, 1, 0, 0, 0.0)
  jan1_jd + (epoch_days - 1.0)
}

///|
/// Compute Greenwich Mean Sidereal Time (GMST) in radians from Julian Date (UT1/UTC),
/// following the IAU-82 / SGP4 standard formula used in Vallado's SGP4 implementation.
pub fn gstime(jdut1 : Double) -> Double {
  let tut1 = (jdut1 - 2451545.0) / 36525.0
  let mut temp = -6.2e-6 * tut1 * tut1 * tut1 +
    0.093104 * tut1 * tut1 +
    (876600.0 * 3600.0 + 8640184.812866) * tut1 +
    67310.54841
  // 1/240 degrees per second -> radians
  temp = temp * deg_to_rad / 240.0 % two_pi
  if temp < 0.0 {
    temp = temp + two_pi
  }
  temp
}

///|
/// Compute the unit vector pointing toward the Sun in the ECEF frame (x, y, z)
/// for a given Julian Date. Used for realistic day/night & atmospheric shading.
pub fn sun_direction_ecef(jd : Double) -> (Double, Double, Double) {
  let n = jd - 2451545.0
  // Mean longitude of the Sun (deg)
  let l_deg = 280.460 + 0.9856474 * n
  // Mean anomaly of the Sun (rad)
  let g_rad = normalize_rad((357.528 + 0.9856003 * n) * deg_to_rad)
  // Ecliptic longitude (rad)
  let lambda_rad = normalize_rad(
    (l_deg + 1.915 * @math.sin(g_rad) + 0.020 * @math.sin(2.0 * g_rad)) *
    deg_to_rad,
  )
  // Obliquity of the ecliptic (rad)
  let eps_rad = (23.439 - 0.0000004 * n) * deg_to_rad
  // Sun unit vector in ECI/TEME
  let sun_eci_x = @math.cos(lambda_rad)
  let sun_eci_y = @math.cos(eps_rad) * @math.sin(lambda_rad)
  let sun_eci_z = @math.sin(eps_rad) * @math.sin(lambda_rad)
  // Rotate by GMST into ECEF
  let gmst = gstime(jd)
  let cos_g = @math.cos(gmst)
  let sin_g = @math.sin(gmst)
  let ecef_x = cos_g * sun_eci_x + sin_g * sun_eci_y
  let ecef_y = -sin_g * sun_eci_x + cos_g * sun_eci_y
  let ecef_z = sun_eci_z
  (ecef_x, ecef_y, ecef_z)
}
