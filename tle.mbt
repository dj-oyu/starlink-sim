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

///|
/// Parse ASCII digits (with at most one '.') in buf[start, end) after trimming spaces.
/// Returns -1.0 when the field is empty or contains anything else.
fn parse_ascii_number(
  buf : FixedArray[Byte],
  start : Int32,
  end : Int32,
) -> Double {
  let mut i = start
  let mut e = end
  while i < e && buf[i] == b' ' {
    i += 1
  }
  while e > i && buf[e - 1] == b' ' {
    e -= 1
  }
  if i >= e {
    return -1.0
  }
  let mut int_part = 0.0
  let mut frac = 0.0
  let mut scale = 1.0
  let mut seen_dot = false
  let mut digits = 0
  while i < e {
    let c = buf[i].to_int()
    if c == 46 && !seen_dot {
      seen_dot = true
    } else if c >= 48 && c <= 57 {
      digits += 1
      if seen_dot {
        scale = scale / 10.0
        frac = frac + (c - 48).to_double() * scale
      } else {
        int_part = int_part * 10.0 + (c - 48).to_double()
      }
    } else {
      return -1.0
    }
    i += 1
  }
  if digits == 0 {
    -1.0
  } else {
    int_part + frac
  }
}

///|
/// Days since 1970-01-01 of a proleptic Gregorian date (month 1-12, day 1-31).
fn days_from_civil(year : Int32, month : Int32, day : Int32) -> Int32 {
  let y = if month <= 2 { year - 1 } else { year }
  let era = (if y >= 0 { y } else { y - 399 }) / 400
  let yoe = y - era * 400
  let mp = (month + 9) % 12
  let doy = (153 * mp + 2) / 5 + day - 1
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468
}

///|
/// Epoch (ms since the Unix epoch, UTC) of the newest element set in the TLE text `buf[0, len)`
/// (ASCII bytes), or 0 if none can be read. Line 1 holds the epoch in columns 19-20 (2-digit
/// year) and 21-32 (day of year with fraction, 1-based). Epochs more than a day after `now_ms`
/// are ignored (clock skew / garbage).
pub fn newest_epoch_unix_ms(
  buf : FixedArray[Byte],
  len : Int32,
  now_ms : Double,
) -> Double {
  let n = if len > buf.length() { buf.length() } else { len }
  let mut newest = 0.0
  let mut from = 0
  while from < n {
    let mut nl = from
    while nl < n && buf[nl] != b'\n' {
      nl += 1
    }
    if buf[from] == b'1' &&
      from + 1 < n &&
      buf[from + 1] == b' ' &&
      nl - from >= 32 {
      let yy = parse_ascii_number(buf, from + 18, from + 20)
      let day = parse_ascii_number(buf, from + 20, from + 32)
      if yy >= 0.0 && day >= 1.0 && day < 367.0 {
        let yy_i = yy.to_int()
        let year = if yy_i < 57 { 2000 + yy_i } else { 1900 + yy_i }
        let ms = days_from_civil(year, 1, 1).to_double() * 86400000.0 +
          (day - 1.0) * 86400000.0
        if ms <= now_ms + 86400000.0 && ms > newest {
          newest = ms
        }
      }
    }
    from = nl + 1
  }
  newest
}

///|
/// Raw wasm pointer of a FixedArray[Byte] (assumed to point directly at the element data;
/// checked by the round-trip test in tle_wbtest.mbt).
#borrow(a)
extern "wasm" fn addr_of_bytes(a : FixedArray[Byte]) -> Int32 =
  #|(func (param i32) (result i32) (local.get 0))

///|
let tle_scan_buf : Ref[FixedArray[Byte]] = Ref(FixedArray::make(0, b'\x00'))

///|
/// Allocate the TLE scan buffer for `len` bytes and return its wasm address. The host writes the
/// TLE text (ASCII) there and calls `tle_newest_epoch_ms`. Valid until the next call.
pub fn tle_scan_buffer(len : Int32) -> Int32 {
  tle_scan_buf.val = FixedArray::make(len, b'\x00')
  addr_of_bytes(tle_scan_buf.val)
}

///|
/// Newest TLE epoch (ms since Unix epoch, 0 if none) of the first `len` bytes in the scan buffer.
pub fn tle_newest_epoch_ms(len : Int32, now_ms : Double) -> Double {
  newest_epoch_unix_ms(tle_scan_buf.val, len, now_ms)
}
