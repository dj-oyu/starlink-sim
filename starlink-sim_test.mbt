///|
test "Vallado AIAA 2006-6753 SGP4 benchmark verification (Sat 00005)" {
  let line1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753"
  let line2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"
  let tle = @starlink-sim.parse_tle_lines(line1, line2)
  assert_eq(tle.satnum, 5)
  let sat = @starlink-sim.sgp4_init(tle)

  // t = 0.0 min
  let (rx0, ry0, rz0, vx0, vy0, vz0, ok0) = @starlink-sim.sgp4_propagate(
    sat, 0.0,
  )
  assert_true(ok0)
  assert_true((rx0 - 7022.46529266).abs() < 1.0e-4)
  assert_true((ry0 - -1400.08296755).abs() < 1.0e-4)
  assert_true((rz0 - 0.03995155).abs() < 1.0e-4)
  assert_true((vx0 - 1.893841015).abs() < 1.0e-5)
  assert_true((vy0 - 6.405893759).abs() < 1.0e-5)
  assert_true((vz0 - 4.534807250).abs() < 1.0e-5)

  // t = 360.0 min
  let (rx1, ry1, rz1, vx1, vy1, vz1, ok1) = @starlink-sim.sgp4_propagate(
    sat, 360.0,
  )
  assert_true(ok1)
  assert_true((rx1 - -7154.03120202).abs() < 1.0e-3)
  assert_true((ry1 - -3783.17682504).abs() < 1.0e-3)
  assert_true((rz1 - -3536.19412294).abs() < 1.0e-3)
  assert_true((vx1 - 4.741887409).abs() < 1.0e-5)
  assert_true((vy1 - -4.151817765).abs() < 1.0e-5)
  assert_true((vz1 - -2.093935425).abs() < 1.0e-5)

  let (px1, py1, pz1, pok1) = @starlink-sim.sgp4_propagate_pos(sat, 360.0)
  assert_true(pok1)
  assert_true((px1 - rx1).abs() < 1.0e-5)
  assert_true((py1 - ry1).abs() < 1.0e-5)
  assert_true((pz1 - rz1).abs() < 1.0e-5)
}

///|
test "Starlink TLE propagation, ECEF geodetic conversion, and constellation API" {
  @starlink-sim.reset_constellation()
  let line1 = "1 44714U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996"
  let line2 = "2 44714  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094"
  let tle = @starlink-sim.parse_tle_lines(line1, line2)
  assert_eq(tle.satnum, 44714)

  let idx = @starlink-sim.add_satellite_elements(
    44714, 26, 289.17018502, 0.00047456, 53.1444, 201.1192, 0.0002831, 127.3037,
    232.8238, 15.67116217,
  )
  assert_eq(idx, 0)
  assert_eq(@starlink-sim.get_satellite_count(), 1)

  let epoch_ms = @starlink-sim.jd_to_unix_ms(tle.jdsatepoch)
  let valid = @starlink-sim.propagate_constellation(epoch_ms)
  assert_eq(valid, 1)
  assert_eq(@starlink-sim.get_sat_valid(0), 1)

  let lat = @starlink-sim.get_sat_lat_deg(0)
  let lon = @starlink-sim.get_sat_lon_deg(0)
  let alt = @starlink-sim.get_sat_alt_km(0)
  let speed = @starlink-sim.get_sat_speed_kms(0)

  assert_true(lat >= -54.0 && lat <= 54.0)
  assert_true(lon >= -180.0 && lon <= 180.0)
  assert_true(alt > 300.0 && alt < 650.0)
  assert_true(speed > 7.0 && speed < 8.0)

  // Place observer directly underneath satellite to verify zenith visibility
  @starlink-sim.set_observer(lat, lon, 0.0, 25.0, 1)
  let _ = @starlink-sim.propagate_constellation(epoch_ms)
  assert_eq(@starlink-sim.get_sat_visible(0), 1)
  assert_eq(@starlink-sim.get_visible_count(), 1)
  assert_true(@starlink-sim.get_sat_elevation_deg(0) > 88.0)

  // Test orbit trajectory sampling
  let pts = @starlink-sim.compute_orbit_path(0, epoch_ms, 47.5, 60, 0)
  assert_eq(pts, 61)
}

///|
test "sincos_rad and sin_rad/cos_rad agree with @math across orbital angles" {
  let mut x = -100.0
  while x <= 100.0 {
    let (s, c) = @starlink-sim.sincos_rad(x)
    assert_true((s - @math.sin(x)).abs() < 1.0e-14)
    assert_true((c - @math.cos(x)).abs() < 1.0e-14)
    assert_true((@starlink-sim.sin_rad(x) - @math.sin(x)).abs() < 1.0e-14)
    assert_true((@starlink-sim.cos_rad(x) - @math.cos(x)).abs() < 1.0e-13)
    x = x + 0.137
  }
}

///|
test "time conversions: JD, Unix ms, TLE epoch" {
  assert_true(
    (@starlink-sim.calendar_to_jd(2000, 1, 1, 12, 0, 0.0) - 2451545.0).abs() <
    1.0e-9,
  )
  assert_true((@starlink-sim.unix_ms_to_jd(0.0) - 2440587.5).abs() < 1.0e-9)
  let ms = 1.7e12
  assert_true(
    (@starlink-sim.jd_to_unix_ms(@starlink-sim.unix_ms_to_jd(ms)) - ms).abs() <
    0.1,
  )
  // 2-digit year 00 -> 2000, day 179.78495062 == Jun 27 + 0.78495062
  let jd = @starlink-sim.tle_epoch_to_jd(0, 179.78495062)
  let expect = @starlink-sim.calendar_to_jd(2000, 6, 27, 0, 0, 0.0) + 0.78495062
  assert_true((jd - expect).abs() < 1.0e-9)
  // 2-digit year 58 -> 1958
  let jd58 = @starlink-sim.tle_epoch_to_jd(58, 1.0)
  assert_true(
    (jd58 - @starlink-sim.calendar_to_jd(1958, 1, 1, 0, 0, 0.0)).abs() < 1.0e-9,
  )
}

///|
test "gstime matches Vallado example 3-5 (1992-08-20 12:14 UT1)" {
  let jd = @starlink-sim.calendar_to_jd(1992, 8, 20, 12, 14, 0.0)
  let deg = @starlink-sim.gstime(jd) * 180.0 / 3.141592653589793
  assert_true((deg - 152.578787810).abs() < 1.0e-5)
}

///|
test "parse_tle_lines extracts all fields" {
  let t = @starlink-sim.parse_tle_lines(
    "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753", "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667",
  )
  assert_eq(t.satnum, 5)
  assert_eq(t.epoch_year, 0)
  assert_true((t.epoch_days - 179.78495062).abs() < 1.0e-9)
  assert_true((t.bstar - 0.28098e-4).abs() < 1.0e-12)
  assert_true((t.inclo - 34.2682 * 3.141592653589793 / 180.0).abs() < 1.0e-9)
  assert_true((t.ecco - 0.1859667).abs() < 1.0e-12)
  let rpd = t.no_kozai * 1440.0 / (2.0 * 3.141592653589793)
  assert_true((rpd - 10.82419157).abs() < 1.0e-8)
}

///|
test "sun_direction_ecef is a unit vector" {
  let (x, y, z) = @starlink-sim.sun_direction_ecef(2460000.5)
  assert_true((x * x + y * y + z * z - 1.0).abs() < 1.0e-12)
}

///|
/// Regression test for the fast position-only path (`sgp4_propagate_pos`):
/// its memoized sin/cos, division-free near-circular short-period terms and
/// fixed-step Kepler solve must agree with the exact `sgp4_propagate` to
/// better than 1 mm over a synthetic Starlink-like constellation that spans
/// every shell, e in [1e-4, 3e-3], bstar in [-2e-2, 5e-2] and TLE ages up to
/// 26 days, evaluated both with arbitrary time jumps (+-24 h) and as a
/// sequence of 16 ms frames (the memo rotation path).
test "fast position path matches exact SGP4 over a synthetic Starlink constellation" {
  let incs = [53.0, 53.2, 43.0, 70.0, 97.6, 33.0]
  let alts = [340.0, 400.0, 480.0, 530.0, 550.0, 560.0, 575.0]
  let eccs = [0.0001, 0.0003, 0.0007, 0.0015, 0.0033]
  let bstars = [-0.02, 0.0001, 0.0005, 0.002, 0.01, 0.055]
  let ages = [-0.5, 0.1, 1.0, 3.0, 8.0, 26.0]
  let mut seed = 20261017
  fn rnd() -> Double {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    seed.to_double() / 2147483647.0
  }

  let sats : Array[@starlink-sim.SatRec] = []
  let mut k = 0
  while k < 420 {
    let inc = incs[k % incs.length()]
    let alt = alts[k / 6 % alts.length()]
    let ecc = eccs[k / 42 % eccs.length()]
    let bstar = bstars[k / 7 % bstars.length()]
    let age = ages[k % ages.length()]
    // mean motion (rev/day) for a circular orbit at `alt`
    let a_km = 6378.135 + alt
    let n_rad_s = (398600.8 / (a_km * a_km * a_km)).sqrt()
    let no_rpd = n_rad_s * 86400.0 / (2.0 * 3.141592653589793)
    let tle = @starlink-sim.TleData::from_elements(
      k,
      26,
      290.0 - age,
      bstar,
      inc,
      rnd() * 360.0,
      ecc,
      rnd() * 360.0,
      rnd() * 360.0,
      no_rpd,
    )
    sats.push(@starlink-sim.sgp4_init(tle))
    k = k + 1
  }
  let mut max_err_km = 0.0
  fn check(sat : @starlink-sim.SatRec, tsince : Double) -> Unit raise {
    let (px, py, pz, pok) = @starlink-sim.sgp4_propagate_pos(sat, tsince)
    let (rx, ry, rz, _, _, _, ok) = @starlink-sim.sgp4_propagate(sat, tsince)
    assert_eq(pok, ok)
    if ok {
      let dx = px - rx
      let dy = py - ry
      let dz = pz - rz
      let e = (dx * dx + dy * dy + dz * dz).sqrt()
      if e > max_err_km {
        max_err_km = e
      }
    }
  }

  // Epoch of the simulated "now": day 290.0 of 2026 -> tsince = age (days) * 1440
  let mut i = 0
  while i < sats.length() {
    let sat = sats[i]
    let t_now = ages[i % ages.length()] * 1440.0
    // arbitrary jumps over +-24 h
    let mut h = -24.0
    while h <= 24.0 {
      check(sat, t_now + h * 60.0)
      h = h + 1.5
    }
    // sequential 16 ms frames (memoized rotation path), then 1 s steps
    let mut t = t_now
    let mut f = 0
    while f < 150 {
      t = t + 16.0 / 60000.0
      check(sat, t)
      f = f + 1
    }
    f = 0
    while f < 60 {
      t = t + 1.0 / 60.0
      check(sat, t)
      f = f + 1
    }
    i = i + 1
  }
  // 1e-6 km = 1 mm; observed maximum is 2.5e-7 km, and only on the degenerate
  // bstar = -0.02 / 26-day cases whose SGP4 drag polynomial has already blown
  // the orbit up to ~16 Earth radii (rounding-level relative error, 2.5e-12).
  assert_true(max_err_km < 1.0e-6)
}

///|
test "Starlink orbit stays bounded over one day of propagation" {
  let tle = @starlink-sim.parse_tle_lines(
    "1 44714U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996", "2 44714  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094",
  )
  let sat = @starlink-sim.sgp4_init(tle)
  let mut t = 0.0
  while t <= 1440.0 {
    let (x, y, z, ok) = @starlink-sim.sgp4_propagate_pos(sat, t)
    assert_true(ok)
    let r = (x * x + y * y + z * z).sqrt()
    assert_true(r > 6678.0 && r < 7000.0)
    t = t + 10.0
  }
}

///|
test "render buffer is sized 3 floats per satellite and exposes a stable pointer" {
  @starlink-sim.reset_constellation()
  let line1 = "1 44714U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996"
  let line2 = "2 44714  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094"
  let tle = @starlink-sim.parse_tle_lines(line1, line2)
  let _ = @starlink-sim.add_satellite_elements(
    44714, 26, 289.17018502, 0.00047456, 53.1444, 201.1192, 0.0002831, 127.3037,
    232.8238, 15.67116217,
  )
  assert_eq(@starlink-sim.prepare_render_buffer(), 3)
  let p0 = @starlink-sim.get_render_buffer_ptr()
  assert_true(p0 > 0)
  let epoch_ms = @starlink-sim.jd_to_unix_ms(tle.jdsatepoch)
  let _ = @starlink-sim.propagate_constellation(epoch_ms)
  // propagation must write into the same buffer, not reallocate it
  assert_eq(@starlink-sim.get_render_buffer_ptr(), p0)
}

///|
fn load_test_constellation() -> Int32 {
  @starlink-sim.reset_constellation()
  let mut m = 0.0
  while m < 360.0 {
    let _ = @starlink-sim.add_satellite_elements(
      44714, 26, 289.17018502, 0.00047456, 53.1444, 201.1192, 0.0002831, 127.3037,
      m, 15.67116217,
    )
    m = m + 17.0
  }
  @starlink-sim.get_satellite_count()
}

///|
test "sliced propagation over all slices equals one full pass (positions, status, visible list)" {
  let n = load_test_constellation()
  let t = @starlink-sim.jd_to_unix_ms(
      @starlink-sim.tle_epoch_to_jd(26, 289.17018502),
    ) +
    3600000.0
  @starlink-sim.set_observer(35.6762, 139.6503, 0.04, 5.0, 1)
  let _ = @starlink-sim.propagate_constellation(t)
  let fx : Array[Double] = []
  let fy : Array[Double] = []
  let fs : Array[Int32] = []
  for i in 0..<n {
    fx.push(@starlink-sim.get_sat_ecef_x(i))
    fy.push(@starlink-sim.get_sat_ecef_y(i))
    fs.push(@starlink-sim.get_sat_status(i))
  }
  let full_visible = @starlink-sim.get_visible_count()
  // Same constellation, fresh state, refreshed in 4 slices at the same instant
  let _ = load_test_constellation()
  @starlink-sim.set_observer(35.6762, 139.6503, 0.04, 5.0, 1)
  for k in 0..<4 {
    let _ = @starlink-sim.propagate_constellation_slice(t, k, 4)
  }
  for i in 0..<n {
    assert_true((@starlink-sim.get_sat_ecef_x(i) - fx[i]).abs() < 1.0e-9)
    assert_true((@starlink-sim.get_sat_ecef_y(i) - fy[i]).abs() < 1.0e-9)
    assert_eq(@starlink-sim.get_sat_status(i), fs[i])
  }
  assert_eq(@starlink-sim.get_visible_count(), full_visible)
  // visible list entries must all have the visible bit set
  for k in 0..<@starlink-sim.get_visible_count() {
    assert_eq(
      @starlink-sim.get_sat_visible(@starlink-sim.get_visible_sat_index(k)),
      1,
    )
  }
  // invalid slice arguments are rejected without touching state
  assert_eq(@starlink-sim.propagate_constellation_slice(t, 4, 4), 0)
  assert_eq(@starlink-sim.propagate_constellation_slice(t, 0, 0), 0)
}
