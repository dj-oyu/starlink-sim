// Pure geometry for the lens-flare effect (no three.js, unit-tested in flareMath.test.mjs).
// World frame = the app's Three.js frame: Earth is a unit sphere at the origin, `cam` is the camera
// position and `s` the unit vector towards the Sun (a point at infinity).

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of the Sun is NOT hidden by the Earth (+ its thin atmosphere), 0..1, soft across the
 * limb. 1 when the Earth is not between the camera and the Sun.
 */
export function sunVisibility(cam, s) {
  const tc = -dot(cam, s); // distance along the Sun direction to the point nearest the Earth's centre
  if (tc <= 0) return 1;
  const closest = [cam[0] + s[0] * tc, cam[1] + s[1] * tc, cam[2] + s[2] * tc];
  return smoothstep(0.985, 1.045, len(closest));
}

/**
 * Point on the unit sphere where sunlight reflects straight into the camera (the sun glint):
 * the surface normal there is the half-vector of the Sun and view directions. The view direction
 * depends on the point itself, so iterate (converges quickly: the camera is not at infinity).
 * Returns the point and the two cosines that tell whether it can be seen / is lit.
 */
export function glintPoint(cam, s) {
  let p = norm([s[0] + cam[0] / len(cam), s[1] + cam[1] / len(cam), s[2] + cam[2] / len(cam)]);
  for (let i = 0; i < 4; i++) {
    const v = norm([cam[0] - p[0], cam[1] - p[1], cam[2] - p[2]]);
    p = norm([s[0] + v[0], s[1] + v[1], s[2] + v[2]]);
  }
  const v = norm([cam[0] - p[0], cam[1] - p[1], cam[2] - p[2]]);
  return { p, cosSun: dot(p, s), cosView: dot(p, v) };
}

/**
 * Equirectangular (u, v) of a point on the unit sphere for three.js' SphereGeometry mapping
 * (the same one the Earth textures use): u = phi / 2pi with phi = atan2(z, -x), v = 1 - theta / pi.
 */
export function sphereUv(p) {
  let phi = Math.atan2(p[2], -p[0]);
  if (phi < 0) phi += 2 * Math.PI;
  const theta = Math.acos(Math.min(1, Math.max(-1, p[1])));
  return { u: phi / (2 * Math.PI), v: 1 - theta / Math.PI };
}
