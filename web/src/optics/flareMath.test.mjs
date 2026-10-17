import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glintPoint, sphereUv, sunVisibility } from './flareMath.mjs';

const norm = (a) => {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('sun is fully visible when the Earth is not between camera and Sun', () => {
  assert.equal(sunVisibility([3, 0, 0], [1, 0, 0]), 1); // camera on the sun side
  assert.equal(sunVisibility([0, 3, 0], [1, 0, 0]), 1); // Earth beside the line of sight
});

test('sun is hidden when the Earth is exactly in between', () => {
  assert.equal(sunVisibility([-3, 0, 0], [1, 0, 0]), 0);
  assert.equal(sunVisibility([-3, 0.5, 0], [1, 0, 0]), 0); // still behind the disc
});

test('sun fades smoothly across the limb and is fully visible well outside it', () => {
  const at = (h) => sunVisibility([-3, h, 0], [1, 0, 0]);
  assert.ok(at(0.99) < 0.05);
  assert.ok(at(1.02) > 0.2 && at(1.02) < 0.8);
  assert.ok(at(1.06) > 0.99);
  assert.ok(at(1.0) <= at(1.02) && at(1.02) <= at(1.04)); // monotonic
});

test('glint point lies on the sphere and obeys the law of reflection', () => {
  for (const [cam, s] of [
    [[2.5, 0.3, 1.0], norm([1, 0.4, 0.2])],
    [[-1.0, 2.0, 2.2], norm([0.3, 0.8, 0.5])],
    [[0.2, 0.2, 5.0], norm([0.5, 0.1, 0.8])],
  ]) {
    const { p } = glintPoint(cam, s);
    assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-9);
    // reflect the incoming sunlight (travelling along -s) about the normal p, expect the direction to the camera
    const incoming = s.map((x) => -x);
    const k = 2 * dot(incoming, p);
    const reflected = incoming.map((x, i) => x - k * p[i]);
    const toCam = norm([cam[0] - p[0], cam[1] - p[1], cam[2] - p[2]]);
    assert.ok(dot(reflected, toCam) > 1 - 1e-6, `reflection mismatch ${dot(reflected, toCam)}`);
  }
});

test('glint is visible and lit for a camera on the sun side, and not visible from the dark side', () => {
  const s = [1, 0, 0];
  const day = glintPoint([3, 0.4, 0.2], s);
  assert.ok(day.cosSun > 0.2 && day.cosView > 0.2);
  const night = glintPoint([-3, 0.4, 0.2], s);
  assert.ok(night.cosView < 0.05 || night.cosSun < 0.05);
});

test('sphereUv matches three.js SphereGeometry (u=0.5 at +x, v=1 at the north pole)', () => {
  const a = sphereUv([1, 0, 0]);
  assert.ok(Math.abs(a.u - 0.5) < 1e-9 && Math.abs(a.v - 0.5) < 1e-9);
  assert.ok(Math.abs(sphereUv([0, 1, 0]).v - 1) < 1e-9);
  assert.ok(Math.abs(sphereUv([0, -1, 0]).v - 0) < 1e-9);
  assert.ok(Math.abs(sphereUv([-1, 0, 0]).u - 0) < 1e-9 || Math.abs(sphereUv([-1, 0, 0]).u - 1) < 1e-9);
});
