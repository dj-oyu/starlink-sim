export type Vec3 = [number, number, number];
export function sunVisibility(cam: Vec3, s: Vec3): number;
export function glintPoint(
  cam: Vec3,
  s: Vec3,
): { p: Vec3; cosSun: number; cosView: number };
export function sphereUv(p: Vec3): { u: number; v: number };
