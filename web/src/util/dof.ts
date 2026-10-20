import * as THREE from 'three';

/**
 * Shared "depth of field" inputs. ConstellationView updates them every frame; the satellite points
 * and the Earth / cloud shaders read them (the same object is referenced by every material).
 *
 * uFocus: distance from the camera to the focal plane (the Earth's surface while orbiting the
 *         globe). The effect only starts once the camera is closer than ~0.7 Earth radii to the
 *         surface, so the default framing looks exactly as before; it is off while following.
 * uDofPx: maximum defocus radius in drawing-buffer pixels.
 */
export const dofUniforms = {
  uFocus: { value: 6 } as THREE.IUniform<number>,
  uDofPx: { value: 8 } as THREE.IUniform<number>,
};

/**
 * The defocus code is compiled in only while it is needed (`#ifdef DOF`): at the default framing
 * the shaders are exactly the plain ones, so there is no cost on slow GPUs (register pressure and
 * extra fetches are paid even by a never-taken branch on mobile). Hysteresis avoids flip-flopping.
 */
export const dofState = { on: false };
export function updateDofState(focus: number): void {
  dofState.on = dofState.on ? focus < 0.75 : focus < 0.7;
}
/** Switch a material's DOF variant (recompiles only when the state changes; programs are cached). */
export function applyDof(mat: THREE.ShaderMaterial): void {
  if (!!mat.defines?.DOF === dofState.on) return;
  mat.defines = dofState.on ? { DOF: 1 } : {};
  mat.needsUpdate = true;
}

/** Maximum defocus radius in CSS pixels (multiplied by the device pixel ratio). */
export const DOF_MAX_CSS_PX = 8;

/**
 * GLSL helpers. `dofZoom()` depends only on uniforms, so `if (dofZoom() > 0.0)` is a uniform branch:
 * no cost when zoomed out, and texture fetches inside it stay in uniform control flow.
 */
export const DOF_GLSL = /* glsl */ `
  uniform float uFocus;
  uniform float uDofPx;

  float dofZoom() {
    return 1.0 - smoothstep(0.1, 0.7, uFocus);
  }

  // Defocus amount 0..1 of a point at distance \`dist\` from the camera.
  float dofCoc(float dist) {
    return dofZoom() * clamp(abs(dist - uFocus) / max(dist, 0.05), 0.0, 1.0);
  }
`;
