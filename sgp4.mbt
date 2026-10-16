///|
/// Initialized SGP4 satellite record with precomputed secular and periodic coefficients.
pub struct SatRec {
  satnum : Int32
  jdsatepoch : Double
  bstar : Double
  inclo : Double
  nodeo : Double
  ecco : Double
  argpo : Double
  mo : Double
  no_kozai : Double
  no_unkozai : Double
  a : Double
  alta : Double
  altp : Double
  sinio : Double
  cosio : Double
  con41 : Double
  cc1 : Double
  cc4 : Double
  cc5 : Double
  d2 : Double
  d3 : Double
  d4 : Double
  delmo : Double
  eta : Double
  argpdot : Double
  omgcof : Double
  xmcof : Double
  sinmao : Double
  t2cof : Double
  t3cof : Double
  t4cof : Double
  t5cof : Double
  x1mth2 : Double
  x7thm1 : Double
  mdot : Double
  nodedot : Double
  xlcof : Double
  aycof : Double
  nodecf : Double
  isimp : Bool
  shell_id : Int32
}

///|
/// Classify Starlink orbital shell from inclination (deg) and altitude (km):
/// 0: ~53 deg (Main Shell)
/// 1: ~43 deg (Mid-inclination Shell)
/// 2: ~70 deg (High-inclination Shell)
/// 3: ~97.6 deg (Polar / Sun-Synchronous Shell)
/// 4: Very Low / Deorbiting / Orbit Raising (< 480 km)
pub fn classify_shell(inclo_rad : Double, alt_km : Double) -> Int32 {
  if alt_km < 450.0 {
    return 4
  }
  let inc_deg = inclo_rad * rad_to_deg
  if inc_deg > 85.0 {
    3
  } else if inc_deg > 62.0 {
    2
  } else if inc_deg < 48.0 {
    1
  } else {
    0
  }
}

///|
/// Initialize SGP4 satellite record from TleData (Vallado AIAA 2006-6753 SGP4 init).
pub fn sgp4_init(tle : TleData) -> SatRec {
  let x2o3 = 2.0 / 3.0
  let eccsq = tle.ecco * tle.ecco
  let omeosq = 1.0 - eccsq
  let rteosq = omeosq.sqrt()
  let cosio = @math.cos(tle.inclo)
  let cosio2 = cosio * cosio

  // Un-Kozai the mean motion
  let ak = @math.pow(xke / tle.no_kozai, x2o3)
  let d1 = 0.75 * j2 * (3.0 * cosio2 - 1.0) / (rteosq * omeosq)
  let mut del_ = d1 / (ak * ak)
  let adel = ak *
    (1.0 - del_ * del_ - del_ * (1.0 / 3.0 + 134.0 * del_ * del_ / 81.0))
  del_ = d1 / (adel * adel)
  let no_unkozai = tle.no_kozai / (1.0 + del_)

  let ao = @math.pow(xke / no_unkozai, x2o3)
  let sinio = @math.sin(tle.inclo)
  let po = ao * omeosq
  let con42 = 1.0 - 5.0 * cosio2
  let con41 = -con42 - cosio2 - cosio2
  let posq = po * po
  let rp = ao * (1.0 - tle.ecco)

  let alta = ao * (1.0 + tle.ecco) - 1.0
  let altp = rp - 1.0

  // SGP4 atmospheric density parameter s and qoms2t
  let mut sfour = 78.0 / earth_radius_km + 1.0
  let mut qzms24 = @math.pow((120.0 - 78.0) / earth_radius_km, 4.0)
  let perige = (rp - 1.0) * earth_radius_km

  if perige < 156.0 {
    sfour = perige - 78.0
    if perige < 98.0 {
      sfour = 20.0
    }
    qzms24 = @math.pow((120.0 - sfour) / earth_radius_km, 4.0)
    sfour = sfour / earth_radius_km + 1.0
  }

  let pinvsq = 1.0 / posq
  let tsi = 1.0 / (ao - sfour)
  let eta = ao * tle.ecco * tsi
  let etasq = eta * eta
  let eeta = tle.ecco * eta
  let psisq = (1.0 - etasq).abs()
  let tsi2 = tsi * tsi
  let coef = qzms24 * tsi2 * tsi2
  let coef1 = coef / (psisq * psisq * psisq * psisq.sqrt())
  let cc2 = coef1 *
    no_unkozai *
    (
      ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
      0.375 * j2 * tsi / psisq * con41 * (8.0 + 3.0 * etasq * (8.0 + etasq))
    )
  let cc1 = tle.bstar * cc2
  let mut cc3 = 0.0
  if tle.ecco > 1.0e-4 {
    cc3 = -2.0 * coef * tsi * j3oj2 * no_unkozai * sinio / tle.ecco
  }
  let x1mth2 = 1.0 - cosio2
  let cc4 = 2.0 *
    no_unkozai *
    coef1 *
    ao *
    omeosq *
    (
      eta * (2.0 + 0.5 * etasq) +
      tle.ecco * (0.5 + 2.0 * etasq) -
      j2 *
      tsi /
      (ao * psisq) *
      (
        -3.0 * con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
        0.75 *
        x1mth2 *
        (2.0 * etasq - eeta * (1.0 + etasq)) *
        @math.cos(2.0 * tle.argpo)
      )
    )
  let cc5 = 2.0 *
    coef1 *
    ao *
    omeosq *
    (1.0 + 2.75 * (etasq + eeta) + eeta * etasq)

  let cosio4 = cosio2 * cosio2
  let temp1 = 1.5 * j2 * pinvsq * no_unkozai
  let temp2 = 0.5 * temp1 * j2 * pinvsq
  let temp3 = -0.46875 * j4 * pinvsq * pinvsq * no_unkozai
  let mdot = no_unkozai +
    0.5 * temp1 * rteosq * con41 +
    0.0625 * temp2 * rteosq * (13.0 - 78.0 * cosio2 + 137.0 * cosio4)
  let argpdot = -0.5 * temp1 * con42 +
    0.0625 * temp2 * (7.0 - 114.0 * cosio2 + 395.0 * cosio4) +
    temp3 * (3.0 - 36.0 * cosio2 + 49.0 * cosio4)
  let xhdot1 = -temp1 * cosio
  let nodedot = xhdot1 +
    (0.5 * temp2 * (4.0 - 19.0 * cosio2) + 2.0 * temp3 * (3.0 - 7.0 * cosio2)) *
    cosio
  let omgcof = tle.bstar * cc3 * @math.cos(tle.argpo)
  let mut xmcof = 0.0
  if tle.ecco > 1.0e-4 {
    xmcof = -x2o3 * coef * tle.bstar / eeta
  }
  let nodecf = 3.5 * omeosq * xhdot1 * cc1
  let t2cof = 1.5 * cc1
  let xlcof = if (cosio + 1.0).abs() > 1.5e-12 {
    -0.25 * j3oj2 * sinio * (3.0 + 5.0 * cosio) / (1.0 + cosio)
  } else {
    -0.25 * j3oj2 * sinio * (3.0 + 5.0 * cosio) / 1.5e-12
  }
  let aycof = -0.5 * j3oj2 * sinio
  let delmo_base = 1.0 + eta * @math.cos(tle.mo)
  let delmo = delmo_base * delmo_base * delmo_base
  let sinmao = @math.sin(tle.mo)
  let x7thm1 = 7.0 * cosio2 - 1.0

  // Check for perigee < 220 km (isimp = true skips higher-order drag terms)
  let isimp = rp < 220.0 / earth_radius_km + 1.0
  let mut d2 = 0.0
  let mut d3 = 0.0
  let mut d4 = 0.0
  let mut t3cof = 0.0
  let mut t4cof = 0.0
  let mut t5cof = 0.0

  if !isimp {
    let cc1sq = cc1 * cc1
    d2 = 4.0 * ao * tsi * cc1sq
    let temp = d2 * tsi * cc1 / 3.0
    d3 = (17.0 * ao + sfour) * temp
    d4 = 0.5 * temp * ao * tsi * (221.0 * ao + 31.0 * sfour) * cc1
    t3cof = d2 + 2.0 * cc1sq
    t4cof = 0.25 * (3.0 * d3 + cc1 * (12.0 * d2 + 10.0 * cc1sq))
    t5cof = 0.2 *
      (
        3.0 * d4 +
        12.0 * cc1 * d3 +
        6.0 * d2 * d2 +
        15.0 * cc1sq * (2.0 * d2 + cc1sq)
      )
  }
  let mean_alt_km = (ao - 1.0) * earth_radius_km
  let shell_id = classify_shell(tle.inclo, mean_alt_km)

  {
    satnum: tle.satnum,
    jdsatepoch: tle.jdsatepoch,
    bstar: tle.bstar,
    inclo: tle.inclo,
    nodeo: tle.nodeo,
    ecco: tle.ecco,
    argpo: tle.argpo,
    mo: tle.mo,
    no_kozai: tle.no_kozai,
    no_unkozai,
    a: ao,
    alta,
    altp,
    sinio,
    cosio,
    con41,
    cc1,
    cc4,
    cc5,
    d2,
    d3,
    d4,
    delmo,
    eta,
    argpdot,
    omgcof,
    xmcof,
    sinmao,
    t2cof,
    t3cof,
    t4cof,
    t5cof,
    x1mth2,
    x7thm1,
    mdot,
    nodedot,
    xlcof,
    aycof,
    nodecf,
    isimp,
    shell_id,
  }
}

///|
priv struct PosOut {
  mut x : Double
  mut y : Double
  mut z : Double
}

///|
let pos_out : PosOut = { x: 0.0, y: 0.0, z: 0.0, }

///|
/// Allocation-free position-only SGP4: result in `pos_out`, returns validity.
fn sgp4_pos_into(sat : SatRec, tsince : Double) -> Bool {
  let xmdf = sat.mo + sat.mdot * tsince
  let argpdf = sat.argpo + sat.argpdot * tsince
  let nodedf = sat.nodeo + sat.nodedot * tsince
  let mut argpm = argpdf
  let mut mm = xmdf
  let t2 = tsince * tsince
  let nodem = nodedf + sat.nodecf * t2
  let mut tempa = 1.0 - sat.cc1 * tsince
  let mut tempe = sat.bstar * sat.cc4 * tsince
  let mut templ = sat.t2cof * t2

  if !sat.isimp {
    let delomg = sat.omgcof * tsince
    let delmtemp = 1.0 + sat.eta * cos_rad(xmdf)
    let delm = sat.xmcof * (delmtemp * delmtemp * delmtemp - sat.delmo)
    let temp = delomg + delm
    mm = xmdf + temp
    argpm = argpdf - temp
    let t3 = t2 * tsince
    let t4 = t3 * tsince
    tempa = tempa - sat.d2 * t2 - sat.d3 * t3 - sat.d4 * t4
    tempe = tempe + sat.bstar * sat.cc5 * (sin_rad(mm) - sat.sinmao)
    templ = templ + sat.t3cof * t3 + t4 * (sat.t4cof + tsince * sat.t5cof)
  }

  let nm_init = sat.no_unkozai
  if nm_init <= 0.0 {
    return false
  }

  // sat.a is already (xke / no_unkozai)^(2/3)
  let am = sat.a * tempa * tempa
  let mut em = sat.ecco - tempe

  if em >= 1.0 || em < -0.001 {
    return false
  }
  if em < 1.0e-6 {
    em = 1.0e-6
  }

  mm = mm + nm_init * templ
  let xlm = mm + argpm + nodem
  let nodem_norm = normalize_rad(nodem)
  let argpm_norm = normalize_rad(argpm)
  let xlm_norm = normalize_rad(xlm)
  let mp = normalize_rad(xlm_norm - argpm_norm - nodem_norm)

  let sinim = sat.sinio
  let cosim = sat.cosio
  let ep = em
  let argpp = argpm_norm
  let nodep = nodem_norm

  // Long period periodics using fused sincos_rad
  sincos_fast(argpp)
  let sin_argpp = sc_out.s
  let cos_argpp = sc_out.c
  let axnl = ep * cos_argpp
  let temp = 1.0 / (am * (1.0 - ep * ep))
  let aynl = ep * sin_argpp + temp * sat.aycof
  let xl = mp + argpp + nodep + temp * sat.xlcof * axnl

  // Solve Kepler's equation for (u = xl - nodep)
  let u = normalize_rad(xl - nodep)
  let mut eo1 = u
  let mut tem5 = 9999.9
  let mut ktr = 1
  sincos_fast(eo1)
  let s0 = sc_out.s
  let c0 = sc_out.c
  let mut sineo1 = s0
  let mut coseo1 = c0

  while ktr <= 10 {
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) /
      (1.0 - coseo1 * axnl - sineo1 * aynl)
    if tem5.abs() >= 0.95 {
      tem5 = if tem5 > 0.0 { 0.95 } else { -0.95 }
    }
    eo1 = eo1 + tem5
    let abs_t5 = tem5.abs()
    if abs_t5 < 1.0e-12 {
      break
    }
    if abs_t5 < 0.02 {
      // Algebraic 3rd-order rotation update (accurate to < 6e-9, refined by next Newton step)
      let t5_2 = tem5 * tem5
      let cd = 1.0 - 0.5 * t5_2
      let sd = tem5 * (1.0 - t5_2 / 6.0)
      let next_s = sineo1 * cd + coseo1 * sd
      let next_c = coseo1 * cd - sineo1 * sd
      sineo1 = next_s
      coseo1 = next_c
    } else {
      sincos_fast(eo1)
      let sn = sc_out.s
      let cn = sc_out.c
      sineo1 = sn
      coseo1 = cn
    }
    ktr = ktr + 1
  }

  // Short period preliminary quantities using hardware sqrt()
  let ecose = axnl * coseo1 + aynl * sineo1
  let esine = axnl * sineo1 - aynl * coseo1
  let el2 = axnl * axnl + aynl * aynl
  let one_minus_el2 = 1.0 - el2
  let pl = am * one_minus_el2
  if pl < 0.0 {
    return false
  }

  let rl = am * (1.0 - ecose)
  let betal = one_minus_el2.sqrt()
  let temp_sp = esine / (1.0 + betal)
  let am_o_rl = am / rl
  let sinu = am_o_rl * (sineo1 - aynl - axnl * temp_sp)
  let cosu = am_o_rl * (coseo1 - axnl + aynl * temp_sp)
  let sin2u = (cosu + cosu) * sinu
  let cos2u = 1.0 - 2.0 * sinu * sinu
  let temp_pl = 1.0 / pl
  let temp1_sp = 0.5 * j2 * temp_pl
  let temp2_sp = temp1_sp * temp_pl

  let mrt = rl * (1.0 - 1.5 * temp2_sp * betal * sat.con41) +
    0.5 * temp1_sp * sat.x1mth2 * cos2u
  if mrt < 1.0 {
    return false
  }

  // su_corr = su - du where |du| ~ 2.7e-4 rad -> 3rd-order Taylor is exact to 1e-12
  let du = 0.25 * temp2_sp * sat.x7thm1 * sin2u
  let cos_du = 1.0 - 0.5 * du * du
  let sin_du = du * (1.0 - du * du / 6.0)
  let sinsu = sinu * cos_du - cosu * sin_du
  let cossu = cosu * cos_du + sinu * sin_du

  // xinc = inclo + dinc where |dinc| ~ 8e-4 rad
  let dinc = 1.5 * temp2_sp * cosim * sinim * cos2u
  let cos_dinc = 1.0 - 0.5 * dinc * dinc
  let sin_dinc = dinc * (1.0 - dinc * dinc / 6.0)
  let sini = sinim * cos_dinc + cosim * sin_dinc
  let cosi = cosim * cos_dinc - sinim * sin_dinc

  let xnode = nodep + 1.5 * temp2_sp * cosim * sin2u
  sincos_fast(xnode)
  let snod = sc_out.s
  let cnod = sc_out.c
  let xmx = -snod * cosi
  let xmy = cnod * cosi
  let ux = xmx * sinsu + cnod * cossu
  let uy = xmy * sinsu + snod * cossu
  let uz = sini * sinsu

  let r_km = mrt * earth_radius_km
  pos_out.x = r_km * ux
  pos_out.y = r_km * uy
  pos_out.z = r_km * uz
  true
}

///|
/// Fast position-only SGP4 propagation in TEME frame.
pub fn sgp4_propagate_pos(
  sat : SatRec,
  tsince : Double,
) -> (Double, Double, Double, Bool) {
  let ok = sgp4_pos_into(sat, tsince)
  (pos_out.x, pos_out.y, pos_out.z, ok)
}

///|
/// Full SGP4 propagation returning both position (km) and velocity (km/s) in TEME frame.
pub fn sgp4_propagate(
  sat : SatRec,
  tsince : Double,
) -> (Double, Double, Double, Double, Double, Double, Bool) {
  let vkmpersec = earth_radius_km * xke / 60.0

  // Update for secular gravity and atmospheric drag
  let xmdf = sat.mo + sat.mdot * tsince
  let argpdf = sat.argpo + sat.argpdot * tsince
  let nodedf = sat.nodeo + sat.nodedot * tsince
  let mut argpm = argpdf
  let mut mm = xmdf
  let t2 = tsince * tsince
  let nodem = nodedf + sat.nodecf * t2
  let mut tempa = 1.0 - sat.cc1 * tsince
  let mut tempe = sat.bstar * sat.cc4 * tsince
  let mut templ = sat.t2cof * t2

  if !sat.isimp {
    let delomg = sat.omgcof * tsince
    let delmtemp = 1.0 + sat.eta * @math.cos(xmdf)
    let delm = sat.xmcof * (delmtemp * delmtemp * delmtemp - sat.delmo)
    let temp = delomg + delm
    mm = xmdf + temp
    argpm = argpdf - temp
    let t3 = t2 * tsince
    let t4 = t3 * tsince
    tempa = tempa - sat.d2 * t2 - sat.d3 * t3 - sat.d4 * t4
    tempe = tempe + sat.bstar * sat.cc5 * (@math.sin(mm) - sat.sinmao)
    templ = templ + sat.t3cof * t3 + t4 * (sat.t4cof + tsince * sat.t5cof)
  }

  let nm_init = sat.no_unkozai
  let mut em = sat.ecco
  let inclm = sat.inclo

  if nm_init <= 0.0 {
    return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false)
  }

  let am = sat.a * tempa * tempa
  let am_sqrt = am.sqrt()
  let nm = xke / (am * am_sqrt)
  em = em - tempe

  if em >= 1.0 || em < -0.001 {
    return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false)
  }
  if em < 1.0e-6 {
    em = 1.0e-6
  }

  mm = mm + nm_init * templ
  let xlm = mm + argpm + nodem
  let nodem_norm = normalize_rad(nodem)
  let argpm_norm = normalize_rad(argpm)
  let xlm_norm = normalize_rad(xlm)
  let mm_norm = normalize_rad(xlm_norm - argpm_norm - nodem_norm)

  let sinim = sat.sinio
  let cosim = sat.cosio

  let ep = em
  let xincp = inclm
  let argpp = argpm_norm
  let nodep = nodem_norm
  let mp = mm_norm

  if ep <= 0.0 || ep >= 1.0 {
    return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false)
  }

  // Long period periodics
  let axnl = ep * @math.cos(argpp)
  let temp = 1.0 / (am * (1.0 - ep * ep))
  let aynl = ep * @math.sin(argpp) + temp * sat.aycof
  let xl = mp + argpp + nodep + temp * sat.xlcof * axnl

  // Solve Kepler's equation for (u = xl - nodep)
  let u = normalize_rad(xl - nodep)
  let mut eo1 = u
  let mut tem5 = 9999.9
  let mut ktr = 1
  let mut sineo1 = 0.0
  let mut coseo1 = 0.0

  while tem5.abs() >= 1.0e-12 && ktr <= 10 {
    sineo1 = @math.sin(eo1)
    coseo1 = @math.cos(eo1)
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5
    if tem5.abs() >= 0.95 {
      tem5 = if tem5 > 0.0 { 0.95 } else { -0.95 }
    }
    eo1 = eo1 + tem5
    ktr = ktr + 1
  }
  sineo1 = @math.sin(eo1)
  coseo1 = @math.cos(eo1)

  // Short period preliminary quantities
  let ecose = axnl * coseo1 + aynl * sineo1
  let esine = axnl * sineo1 - aynl * coseo1
  let el2 = axnl * axnl + aynl * aynl
  let one_minus_el2 = 1.0 - el2
  let pl = am * one_minus_el2
  if pl < 0.0 {
    return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false)
  }

  let rl = am * (1.0 - ecose)
  let rdotl = am_sqrt * esine / rl
  let rvdotl = pl.sqrt() / rl
  let betal = one_minus_el2.sqrt()
  let temp_sp = esine / (1.0 + betal)
  let sinu = am / rl * (sineo1 - aynl - axnl * temp_sp)
  let cosu = am / rl * (coseo1 - axnl + aynl * temp_sp)
  let mut su = @math.atan2(sinu, cosu)
  if su < 0.0 {
    su = su + two_pi
  }
  let sin2u = (cosu + cosu) * sinu
  let cos2u = 1.0 - 2.0 * sinu * sinu
  let temp_pl = 1.0 / pl
  let temp1_sp = 0.5 * j2 * temp_pl
  let temp2_sp = temp1_sp * temp_pl

  // Update for short period periodics
  let mrt = rl * (1.0 - 1.5 * temp2_sp * betal * sat.con41) +
    0.5 * temp1_sp * sat.x1mth2 * cos2u
  let su_corr = su - 0.25 * temp2_sp * sat.x7thm1 * sin2u
  let xnode = nodep + 1.5 * temp2_sp * cosim * sin2u
  let xinc = xincp + 1.5 * temp2_sp * cosim * sinim * cos2u
  let mvt = rdotl - nm * temp1_sp * sat.x1mth2 * sin2u / xke
  let rvdot = rvdotl +
    nm * temp1_sp * (sat.x1mth2 * cos2u + 1.5 * sat.con41) / xke

  // Orientation vectors
  let sinsu = @math.sin(su_corr)
  let cossu = @math.cos(su_corr)
  let snod = @math.sin(xnode)
  let cnod = @math.cos(xnode)
  let sini = @math.sin(xinc)
  let cosi = @math.cos(xinc)
  let xmx = -snod * cosi
  let xmy = cnod * cosi
  let ux = xmx * sinsu + cnod * cossu
  let uy = xmy * sinsu + snod * cossu
  let uz = sini * sinsu
  let vx_u = xmx * cossu - cnod * sinsu
  let vy_u = xmy * cossu - snod * sinsu
  let vz_u = sini * cossu

  // Position (km) and Velocity (km/s) in TEME frame
  let rx = mrt * ux * earth_radius_km
  let ry = mrt * uy * earth_radius_km
  let rz = mrt * uz * earth_radius_km
  let vx = (mvt * ux + rvdot * vx_u) * vkmpersec
  let vy = (mvt * uy + rvdot * vy_u) * vkmpersec
  let vz = (mvt * uz + rvdot * vz_u) * vkmpersec

  if mrt < 1.0 {
    return (rx, ry, rz, vx, vy, vz, false)
  }

  (rx, ry, rz, vx, vy, vz, true)
}
