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
