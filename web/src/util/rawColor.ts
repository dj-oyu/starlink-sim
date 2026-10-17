import * as THREE from 'three';

/**
 * The renderer outputs linear values unchanged (outputColorSpace = LinearSRGB), exactly like the
 * custom shaders, so the image is identical whether the frame is drawn straight to the canvas or
 * through the post-processing target. Built-in materials therefore need colours given as the final
 * sRGB values: hex -> a Color holding those components as-is.
 */
export function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);
}

/** linear -> sRGB transfer for a single component (for authoring vertex colours as linear values). */
export function srgbEncode(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
