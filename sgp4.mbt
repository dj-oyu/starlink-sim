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
  // Frame-to-frame sin/cos memo for `sgp4_pos_into` (see `sincos_memo_threshold`):
  // the angle at which (s, c) were last evaluated exactly, per slow/fast angle.
  mut memo_xmdf_ref : Double
  mut memo_xmdf_s : Double
  mut memo_xmdf_c : Double
  mut memo_argp_ref : Double
  mut memo_argp_s : Double
  mut memo_argp_c : Double
  mut memo_node_ref : Double
  mut memo_node_s : Double
  mut memo_node_c : Double
}

///|
/// Max |theta - theta_ref| (rad) for which the memoized sin/cos are rotated by a
/// 5th-order small-angle series instead of being re-evaluated. At 0.03 rad the
/// series truncation error is d^6/720 < 1.1e-12 (< 1e-8 m at Starlink radii).
let sincos_memo_threshold : Double = 0.03

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
    memo_xmdf_ref: 1.0e300,
    memo_xmdf_s: 0.0,
    memo_xmdf_c: 1.0,
    memo_argp_ref: 1.0e300,
    memo_argp_s: 0.0,
    memo_argp_c: 1.0,
    memo_node_ref: 1.0e300,
    memo_node_s: 0.0,
    memo_node_c: 1.0,
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

  // sin/cos(xmdf): rotate the memoized pair by the small delta since the last
  // exact evaluation (5th-order series, see `sincos_memo_threshold`), else re-anchor.
  let d_xmdf = xmdf - sat.memo_xmdf_ref
  let mut sin_xmdf = 0.0
  let mut cos_xmdf = 0.0
  if d_xmdf.abs() < sincos_memo_threshold {
    let d2 = d_xmdf * d_xmdf
    let cd = 1.0 - d2 * (0.5 - d2 * 0.041666666666666664)
    let sd = d_xmdf *
      (1.0 - d2 * (0.16666666666666666 - d2 * 0.008333333333333333))
    let s = sat.memo_xmdf_s
    let c = sat.memo_xmdf_c
    sin_xmdf = s * cd + c * sd
    cos_xmdf = c * cd - s * sd
  } else {
    sincos_fast(xmdf)
    sin_xmdf = sc_out.s
    cos_xmdf = sc_out.c
    sat.memo_xmdf_ref = xmdf
    sat.memo_xmdf_s = sin_xmdf
    sat.memo_xmdf_c = cos_xmdf
  }
  if !sat.isimp {
    let delomg = sat.omgcof * tsince
    let delmtemp = 1.0 + sat.eta * cos_xmdf
    let delm = sat.xmcof * (delmtemp * delmtemp * delmtemp - sat.delmo)
    let temp = delomg + delm
    mm = xmdf + temp
    argpm = argpdf - temp
    let t3 = t2 * tsince
    let t4 = t3 * tsince
    tempa = tempa - sat.d2 * t2 - sat.d3 * t3 - sat.d4 * t4
    // sin(mm) = sin(xmdf + temp) by angle addition; `temp` is a tiny drag
    // correction (~1e-3 rad for fresh TLEs), so a 9th-order series is exact to
    // 1e-16 for |temp| < 0.1. Stale TLEs fall back to the full evaluation.
    let sin_mm = if temp.abs() < 0.1 {
      let tt = temp * temp
      let ct = 1.0 +
        tt * (-0.5 + tt * (0.041666666666666664 - tt * 0.001388888888888889))
      let st = temp *
        (
          1.0 +
          tt *
          (
            -0.16666666666666666 +
            tt * (0.008333333333333333 - tt * 0.0001984126984126984)
          )
        )
      sin_xmdf * ct + cos_xmdf * st
    } else {
      sin_rad(mm)
    }
    tempe = tempe + sat.bstar * sat.cc5 * (sin_mm - sat.sinmao)
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

  // No angle normalization here: every angle below is only ever used through
  // `sincos_fast` (whose Cody-Waite range reduction handles |x| up to ~1e5 rad
  // with <1e-12 rad error) or as a difference of two such angles, so the
  // mod-2pi reductions of the reference implementation are mathematically
  // redundant. `mp` == `mm` (mod 2pi) exactly.
  mm = mm + nm_init * templ
  let mp = mm

  let sinim = sat.sinio
  let cosim = sat.cosio
  let ep = em
  let argpp = argpm
  let nodep = nodem

  // Long period periodics (argpp drifts ~1e-5 rad/min: memo almost never re-anchors)
  let d_argp = argpp - sat.memo_argp_ref
  let mut sin_argpp = 0.0
  let mut cos_argpp = 0.0
  if d_argp.abs() < sincos_memo_threshold {
    let d2 = d_argp * d_argp
    let cd = 1.0 - d2 * (0.5 - d2 * 0.041666666666666664)
    let sd = d_argp *
      (1.0 - d2 * (0.16666666666666666 - d2 * 0.008333333333333333))
    let s = sat.memo_argp_s
    let c = sat.memo_argp_c
    sin_argpp = s * cd + c * sd
    cos_argpp = c * cd - s * sd
  } else {
    sincos_fast(argpp)
    sin_argpp = sc_out.s
    cos_argpp = sc_out.c
    sat.memo_argp_ref = argpp
    sat.memo_argp_s = sin_argpp
    sat.memo_argp_c = cos_argpp
  }
  let axnl = ep * cos_argpp
  let temp = 1.0 / (am * (1.0 - ep * ep))
  let aynl = ep * sin_argpp + temp * sat.aycof

  // Solve Kepler's equation for u = xl - nodep (unnormalized).
  // u = xmdf + argpp + w, where w = (mm - xmdf) + (argpm - argpdf) + xlcof term
  // is a small drag/long-period correction, so sin/cos(u) follow from the
  // already computed sin/cos(xmdf), sin/cos(argpp) by angle addition plus a
  // 9th-order series rotation by w (exact to 1e-16 for |w| < 0.1).
  let u = mp + argpp + temp * sat.xlcof * axnl
  let w = u - xmdf - argpp
  let mut s0 = 0.0
  let mut c0 = 0.0
  if w.abs() < 0.1 {
    let ww = w * w
    let cw = 1.0 +
      ww * (-0.5 + ww * (0.041666666666666664 - ww * 0.001388888888888889))
    let sw = w *
      (
        1.0 +
        ww *
        (
          -0.16666666666666666 +
          ww * (0.008333333333333333 - ww * 0.0001984126984126984)
        )
      )
    let sxa = sin_xmdf * cos_argpp + cos_xmdf * sin_argpp
    let cxa = cos_xmdf * cos_argpp - sin_xmdf * sin_argpp
    s0 = sxa * cw + cxa * sw
    c0 = cxa * cw - sxa * sw
  } else {
    sincos_fast(u)
    s0 = sc_out.s
    c0 = sc_out.c
  }
  let mut sineo1 = s0
  let mut coseo1 = c0

  if axnl.abs() + aynl.abs() < 0.01 {
    // Near-circular fast path (all Starlink: e ~ 1e-4..3e-3): three fixed
    // Newton steps from E0 = u sharing one reciprocal of f'(E0) (so a single
    // division-free series), with sin/cos(E) carried along by small-angle
    // rotations (5th-order, then 1st-order twice). Per-step contraction is
    // ~e^2, so at e = 0.01 the residual after step 3 is < 1e-15 rad, and the
    // two 1st-order rotations contribute < (e^3/2)^2/2 < 2e-13 rad.
    // Larger eccentricities use the general loop below.
    // 1/(1 - x) with |x| < 0.01 as a geometric series (rel. error x^5 < 1e-10,
    // which only perturbs the Newton contraction, not the fixed point).
    let x = axnl * c0 + aynl * s0
    let inv_fp = 1.0 + x * (1.0 + x * (1.0 + x * (1.0 + x)))
    let d1 = (axnl * s0 - aynl * c0) * inv_fp
    let d1_2 = d1 * d1
    let cd1 = 1.0 - d1_2 * (0.5 - d1_2 * 0.041666666666666664)
    let sd1 = d1 *
      (1.0 - d1_2 * (0.16666666666666666 - d1_2 * 0.008333333333333333))
    let s1 = s0 * cd1 + c0 * sd1
    let c1 = c0 * cd1 - s0 * sd1
    let d2 = (axnl * s1 - aynl * c1 - d1) * inv_fp
    let s2 = s1 + c1 * d2
    let c2 = c1 - s1 * d2
    let d3 = (axnl * s2 - aynl * c2 - (d1 + d2)) * inv_fp
    sineo1 = s2 + c2 * d3
    coseo1 = c2 - s2 * d3
  } else {
    // General case (rare: e >= ~0.01): the reference Newton iteration with
    // exact sin/cos per step, on the normalized angle so the 1e-12 tolerance
    // is resolvable in double precision.
    let un = normalize_rad(u)
    let mut eo1 = un
    let mut ktr = 1
    while ktr <= 10 {
      let mut tem5 = (un - aynl * coseo1 + axnl * sineo1 - eo1) /
        (1.0 - coseo1 * axnl - sineo1 * aynl)
      if tem5.abs() >= 0.95 {
        tem5 = if tem5 > 0.0 { 0.95 } else { -0.95 }
      }
      eo1 = eo1 + tem5
      sincos_fast(eo1)
      sineo1 = sc_out.s
      coseo1 = sc_out.c
      if tem5.abs() < 1.0e-12 {
        break
      }
      ktr = ktr + 1
    }
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

  // (Replacing this sqrt and the three divisions by near-circular series was
  // measured to be slower than the hardware ops, so they are kept exact.)
  let rl = am * (1.0 - ecose)
  let betal = one_minus_el2.sqrt()
  let temp_sp = esine / (1.0 + betal)
  let am_o_rl = am / rl
  let temp_pl = 1.0 / pl
  let sinu = am_o_rl * (sineo1 - aynl - axnl * temp_sp)
  let cosu = am_o_rl * (coseo1 - axnl + aynl * temp_sp)
  let sin2u = (cosu + cosu) * sinu
  let cos2u = 1.0 - 2.0 * sinu * sinu
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
  let d_node = xnode - sat.memo_node_ref
  let mut snod = 0.0
  let mut cnod = 0.0
  if d_node.abs() < sincos_memo_threshold {
    let d2 = d_node * d_node
    let cd = 1.0 - d2 * (0.5 - d2 * 0.041666666666666664)
    let sd = d_node *
      (1.0 - d2 * (0.16666666666666666 - d2 * 0.008333333333333333))
    let s = sat.memo_node_s
    let c = sat.memo_node_c
    snod = s * cd + c * sd
    cnod = c * cd - s * sd
  } else {
    sincos_fast(xnode)
    snod = sc_out.s
    cnod = sc_out.c
    sat.memo_node_ref = xnode
    sat.memo_node_s = snod
    sat.memo_node_c = cnod
  }
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
