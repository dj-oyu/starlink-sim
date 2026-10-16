///|
/// Parsed Two-Line Element (TLE) orbital parameters in standard SGP4 internal units.
pub struct TleData {
  satnum : Int32
  epoch_year : Int32
  epoch_days : Double
  jdsatepoch : Double
  bstar : Double
  inclo : Double // inclination [rad]
  nodeo : Double // right ascension of ascending node [rad]
  ecco : Double // eccentricity [-]
  argpo : Double // argument of perigee [rad]
  mo : Double // mean anomaly [rad]
  no_kozai : Double // mean motion [rad/min]
}

///|
/// Construct TleData from human-readable TLE orbital elements
/// (angles in degrees, no_kozai in revolutions per day).
pub fn TleData::from_elements(
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
) -> TleData {
  let jdsatepoch = tle_epoch_to_jd(epoch_year, epoch_days)
  let xpdotp = minutes_per_day / two_pi // 229.1831180523293
  {
    satnum,
    epoch_year,
    epoch_days,
    jdsatepoch,
    bstar,
    inclo: inclo_deg * deg_to_rad,
    nodeo: nodeo_deg * deg_to_rad,
    ecco,
    argpo: argpo_deg * deg_to_rad,
    mo: mo_deg * deg_to_rad,
    no_kozai: no_kozai_rpd / xpdotp,
  }
}

///|
/// Helper to parse an ASCII substring [start, end) into a Double.
fn parse_double_slice(s : String, start : Int32, end : Int32) -> Double {
  let len = s.length()
  let actual_end = if end > len { len } else { end }
  if start >= actual_end {
    return 0.0
  }
  let mut sign = 1.0
  let mut i = start
  while i < actual_end && s[i] == ' ' {
    i = i + 1
  }
  if i < actual_end {
    if s[i] == '-' {
      sign = -1.0
      i = i + 1
    } else if s[i] == '+' {
      i = i + 1
    }
  }
  while i < actual_end && s[i] == ' ' {
    i = i + 1
  }
  let mut int_part = 0.0
  while i < actual_end && s[i] >= '0' && s[i] <= '9' {
    int_part = int_part * 10.0 + (s[i].to_int() - '0'.to_int()).to_double()
    i = i + 1
  }
  let mut frac_part = 0.0
  let mut frac_div = 1.0
  if i < actual_end && s[i] == '.' {
    i = i + 1
    while i < actual_end && s[i] >= '0' && s[i] <= '9' {
      frac_part = frac_part * 10.0 + (s[i].to_int() - '0'.to_int()).to_double()
      frac_div = frac_div * 10.0
      i = i + 1
    }
  }
  sign * (int_part + frac_part / frac_div)
}

///|
/// Helper to parse an ASCII substring [start, end) into an Int.
fn parse_int_slice(s : String, start : Int32, end : Int32) -> Int32 {
  let len = s.length()
  let actual_end = if end > len { len } else { end }
  let mut i = start
  while i < actual_end && s[i] == ' ' {
    i = i + 1
  }
  let mut sign = 1
  if i < actual_end {
    if s[i] == '-' {
      sign = -1
      i = i + 1
    } else if s[i] == '+' {
      i = i + 1
    }
  }
  let mut val = 0
  while i < actual_end && s[i] >= '0' && s[i] <= '9' {
    val = val * 10 + (s[i].to_int() - '0'.to_int())
    i = i + 1
  }
  sign * val
}

///|
/// Parse TLE implied-decimal exponential format (e.g. " 47456-3" -> 0.47456e-3).
fn parse_tle_exp(s : String, start : Int32, end : Int32) -> Double {
  let len = s.length()
  let actual_end = if end > len { len } else { end }
  let mut i = start
  while i < actual_end && s[i] == ' ' {
    i = i + 1
  }
  let mut sign = 1.0
  if i < actual_end {
    if s[i] == '-' {
      sign = -1.0
      i = i + 1
    } else if s[i] == '+' {
      i = i + 1
    }
  }
  let mut mantissa = 0.0
  let mut div = 1.0
  while i < actual_end && s[i] >= '0' && s[i] <= '9' {
    mantissa = mantissa * 10.0 + (s[i].to_int() - '0'.to_int()).to_double()
    div = div * 10.0
    i = i + 1
  }
  let mut exp_sign = 1
  if i < actual_end && (s[i] == '-' || s[i] == '+') {
    if s[i] == '-' {
      exp_sign = -1
    }
    i = i + 1
  }
  let mut exp_val = 0
  while i < actual_end && s[i] >= '0' && s[i] <= '9' {
    exp_val = exp_val * 10 + (s[i].to_int() - '0'.to_int())
    i = i + 1
  }
  let base = sign * (mantissa / div)
  let pow10 = @math.pow(10.0, (exp_sign * exp_val).to_double())
  base * pow10
}

///|
/// Parse standard NORAD 2-line element strings (Line 1 and Line 2) into TleData.
pub fn parse_tle_lines(line1 : String, line2 : String) -> TleData {
  let satnum = parse_int_slice(line1, 2, 7)
  let epoch_year = parse_int_slice(line1, 18, 20)
  let epoch_days = parse_double_slice(line1, 20, 32)
  let bstar = parse_tle_exp(line1, 53, 61)
  let inclo_deg = parse_double_slice(line2, 8, 16)
  let nodeo_deg = parse_double_slice(line2, 17, 25)
  let ecco_int = parse_int_slice(line2, 26, 33)
  let ecco = ecco_int.to_double() * 1.0e-7
  let argpo_deg = parse_double_slice(line2, 34, 42)
  let mo_deg = parse_double_slice(line2, 43, 51)
  let no_kozai_rpd = parse_double_slice(line2, 52, 63)
  TleData::from_elements(
    satnum, epoch_year, epoch_days, bstar, inclo_deg, nodeo_deg, ecco, argpo_deg,
    mo_deg, no_kozai_rpd,
  )
}
