///|
/// Mathematical and WGS-72 physical constants for SGP4 propagation.
pub let pi : Double = 3.14159265358979323846

///|
pub let two_pi : Double = 6.28318530717958647692

///|
pub let half_pi : Double = 1.57079632679489661923

///|
pub let deg_to_rad : Double = 0.01745329251994329577

///|
pub let rad_to_deg : Double = 57.2957795130823208768

///|
pub let minutes_per_day : Double = 1440.0

///|
pub let seconds_per_day : Double = 86400.0

///|
/// WGS-72 Earth radius in km (standard for SGP4 TLEs).
pub let earth_radius_km : Double = 6378.135

///|
/// WGS-72 gravitational constant mu in km^3 / s^2.
pub let mu_earth : Double = 398600.8

///|
/// Square root of (G * M) in (earth radii)^(3/2) / minute.
pub let xke : Double = 0.0743669161331734132

///|
/// WGS-72 J2 zonal harmonic coefficient.
pub let j2 : Double = 0.001082616

///|
/// WGS-72 J3 zonal harmonic coefficient.
pub let j3 : Double = -0.00000253881

///|
/// WGS-72 J4 zonal harmonic coefficient.
pub let j4 : Double = -0.00000165597

///|
/// J3 / J2 ratio.
pub let j3oj2 : Double = -0.002345069719992869

///|
/// WGS-84 flattening factor for geodetic latitude conversion.
pub let wgs84_a : Double = 6378.137

///|
pub let wgs84_f : Double = 1.0 / 298.257223563

///|
pub let wgs84_e2 : Double = wgs84_f * (2.0 - wgs84_f)
