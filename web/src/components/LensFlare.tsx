import { useEffect, useRef } from 'preact/hooks';
import * as THREE from 'three';
import { useFrame, useThree } from '../fiber/PreactFiber';
import { assetUrl } from '../util/assetUrl';
import { glintPoint, sphereUv, sunVisibility } from '../optics/flareMath.mjs';
import type { Vec3 } from '../optics/flareMath.mjs';

/**
 * Optical effects for strong sunlight, drawn as a handful of procedural quads in screen space
 * (one draw call, no post-processing, no textures):
 *   - the Sun itself (glow, halo, star, anamorphic streak) when it is in view and not hidden by the
 *     Earth, with ghosts along the line through the screen centre; it fades smoothly across the limb
 *   - the sun glint: where sunlight mirrors off the ocean into the camera (a glow + star on the
 *     reflection point, only over water, using the same specular mask as the Earth shader)
 */

const QUADS = 12;
// quad kinds (see the fragment shader)
const GLOW = 0;
const RING = 1;
const HEX = 2;
const STREAK = 3;
const DISC = 4;
const STAR = 5;

const VERT = /* glsl */ `
  attribute vec2 aCenter;
  attribute vec2 aSize;
  attribute vec4 aColor;
  attribute float aKind;
  uniform float uAspect;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vKind;
  void main() {
    vUv = position.xy;
    vColor = aColor;
    vKind = aKind;
    // aSize is a radius in units of half the screen height; correct x for the aspect ratio
    vec2 ndc = aCenter + vec2(position.x * aSize.x / uAspect, position.y * aSize.y);
    gl_Position = vec4(ndc, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vKind;

  float hexDist(vec2 p) {
    p = abs(p);
    return max(dot(p, vec2(0.8660254, 0.5)), p.y);
  }

  void main() {
    vec2 p = vUv;
    float r = length(p);
    float a = 0.0;
    if (vKind < 0.5) {            // soft glow
      a = exp(-r * r * 5.5);
    } else if (vKind < 1.5) {     // halo ring
      a = smoothstep(0.16, 0.0, abs(r - 0.78)) * (1.0 - smoothstep(0.9, 1.0, r)) + 0.04 * (1.0 - r);
    } else if (vKind < 2.5) {     // hexagonal aperture ghost: brighter rim, faint fill
      float h = hexDist(p);
      a = smoothstep(1.0, 0.9, h) * (0.22 + 0.78 * smoothstep(0.62, 0.98, h));
    } else if (vKind < 3.5) {     // anamorphic streak
      a = exp(-p.y * p.y * 220.0) * pow(max(1.0 - abs(p.x), 0.0), 2.0);
    } else if (vKind < 4.5) {     // round ghost
      a = smoothstep(1.0, 0.88, r) * (0.18 + 0.82 * smoothstep(0.45, 0.98, r));
    } else {                       // four-point star + core
      float s1 = exp(-abs(p.y) * 46.0) * pow(max(1.0 - abs(p.x), 0.0), 1.6);
      float s2 = exp(-abs(p.x) * 46.0) * pow(max(1.0 - abs(p.y), 0.0), 1.6);
      a = (s1 + s2) * 0.55 + exp(-r * r * 16.0);
    }
    gl_FragColor = vec4(vColor.rgb * (a * vColor.a), 1.0); // additive blending
  }
`;

interface Props {
  sunDirectionRef: { current: [number, number, number] };
  enabled: boolean;
}

/** Downscaled ocean/land mask (the Earth's specular map) for the sun-glint test; null until loaded. */
function useSpecularMask() {
  const mask = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = 256;
      const h = 128;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      mask.current = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    };
    img.src = assetUrl('assets/textures/earth_specular_2048.jpg');
    return () => {
      cancelled = true;
    };
  }, []);
  return mask;
}

const _ndc = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export function LensFlare({ sunDirectionRef, enabled }: Props) {
  const { scene, camera, renderer } = useThree();
  const maskRef = useSpecularMask();
  const meshRef = useRef<THREE.Mesh | null>(null);
  const attrs = useRef<{
    center: Float32Array;
    size: Float32Array;
    color: Float32Array;
    kind: Float32Array;
    geom: THREE.BufferGeometry;
    mat: THREE.ShaderMaterial;
  } | null>(null);

  useEffect(() => {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(QUADS * 4 * 3);
    const index: number[] = [];
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let q = 0; q < QUADS; q++) {
      for (let c = 0; c < 4; c++) {
        pos[(q * 4 + c) * 3] = corners[c * 2];
        pos[(q * 4 + c) * 3 + 1] = corners[c * 2 + 1];
      }
      const b = q * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const center = new Float32Array(QUADS * 4 * 2);
    const size = new Float32Array(QUADS * 4 * 2);
    const color = new Float32Array(QUADS * 4 * 4);
    const kind = new Float32Array(QUADS * 4);
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setIndex(index);
    for (const [name, arr, n] of [
      ['aCenter', center, 2],
      ['aSize', size, 2],
      ['aColor', color, 4],
      ['aKind', kind, 1],
    ] as const) {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute(name, a);
    }
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uAspect: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10000; // after everything else
    mesh.name = 'lensflare';
    mesh.visible = false;
    scene.add(mesh);
    meshRef.current = mesh;
    attrs.current = { center, size, color, kind, geom, mat };
    return () => {
      scene.remove(mesh);
      geom.dispose();
      mat.dispose();
      meshRef.current = null;
      attrs.current = null;
    };
  }, [scene]);

  useFrame(() => {
    const mesh = meshRef.current;
    const a = attrs.current;
    if (!mesh || !a) return;
    if (!enabled) {
      mesh.visible = false;
      return;
    }

    const cam: Vec3 = [camera.position.x, camera.position.y, camera.position.z];
    const sd = sunDirectionRef.current;
    const s: Vec3 = [sd[0], sd[1], sd[2]];
    camera.getWorldDirection(_fwd);
    const ar = (renderer.domElement.width || 1) / (renderer.domElement.height || 1);
    a.mat.uniforms.uAspect.value = ar;

    let q = 0;
    const put = (cx: number, cy: number, sx: number, sy: number, r: number, g: number, b: number, inten: number, kind: number) => {
      if (inten <= 0.002 || q >= QUADS) return;
      for (let c = 0; c < 4; c++) {
        const v = q * 4 + c;
        a.center[v * 2] = cx;
        a.center[v * 2 + 1] = cy;
        a.size[v * 2] = sx;
        a.size[v * 2 + 1] = sy;
        a.color[v * 4] = r;
        a.color[v * 4 + 1] = g;
        a.color[v * 4 + 2] = b;
        a.color[v * 4 + 3] = inten;
        a.kind[v] = kind;
      }
      q++;
    };
    const edgeFade = (x: number, y: number) => 1 - smoothstep(1.15, 2.1, Math.max(Math.abs(x), Math.abs(y)));

    // ---- the Sun ----
    if (_fwd.x * s[0] + _fwd.y * s[1] + _fwd.z * s[2] > 0.02) {
      _ndc.set(cam[0] + s[0] * 60, cam[1] + s[1] * 60, cam[2] + s[2] * 60).project(camera);
      const sx = _ndc.x;
      const sy = _ndc.y;
      const vis = sunVisibility(cam, s) * edgeFade(sx, sy);
      if (vis > 0.003) {
        // strongest as the Sun slips out from behind the limb
        const limb = 1 + 0.9 * Math.max(0, 1 - Math.abs(vis - 0.45) / 0.45);
        put(sx, sy, 0.42, 0.42, 1.0, 0.9, 0.72, 0.85 * vis, GLOW);
        put(sx, sy, 0.62, 0.62, 1.0, 0.8, 0.55, 0.2 * vis * limb, RING);
        put(sx, sy, 1.15, 0.9, 0.7, 0.82, 1.0, 0.42 * vis * limb, STREAK);
        put(sx, sy, 0.36, 0.36, 1.0, 0.95, 0.85, 0.5 * vis, STAR);
        // ghosts along the line from the Sun through the screen centre (reflections inside the lens)
        const ghosts: [number, number, number, number, number, number, number][] = [
          // t (0 = Sun, 1 = centre, 2 = mirror image), size, r, g, b, intensity, kind
          [0.42, 0.1, 0.45, 0.8, 1.0, 0.14, DISC],
          [0.74, 0.07, 1.0, 0.65, 0.35, 0.12, HEX],
          [1.28, 0.16, 0.5, 1.0, 0.65, 0.09, DISC],
          [1.62, 0.09, 1.0, 0.45, 0.7, 0.13, HEX],
          [2.1, 0.24, 0.55, 0.7, 1.0, 0.08, RING],
        ];
        for (const [t, size, r, g, b, inten, kind] of ghosts) {
          put(sx * (1 - t), sy * (1 - t), size, size, r, g, b, inten * Math.pow(vis, 0.7) * limb, kind);
        }
      }
    }

    // ---- sun glint on the ocean ----
    {
      const gl = glintPoint(cam, s);
      const m = maskRef.current;
      if (gl.cosSun > 0.05 && gl.cosView > 0.08 && m) {
        const { u, v } = sphereUv(gl.p);
        const px = Math.min(m.w - 1, Math.floor(u * m.w));
        const py = Math.min(m.h - 1, Math.floor((1 - v) * m.h));
        const water = m.data[(py * m.w + px) * 4] / 255; // specular mask: bright = ocean
        _ndc.set(gl.p[0], gl.p[1], gl.p[2]).project(camera);
        if (_ndc.z < 1) {
          const strength =
            water * smoothstep(0.05, 0.4, gl.cosSun) * smoothstep(0.08, 0.5, gl.cosView) * edgeFade(_ndc.x, _ndc.y);
          put(_ndc.x, _ndc.y, 0.3, 0.3, 0.8, 0.92, 1.0, 0.55 * strength, GLOW);
          put(_ndc.x, _ndc.y, 0.26, 0.26, 0.9, 0.95, 1.0, 0.4 * strength, STAR);
          put(_ndc.x, _ndc.y, 0.8, 0.5, 0.75, 0.9, 1.0, 0.16 * strength, STREAK);
        }
      }
    }

    // unused quads are collapsed to nothing
    for (let i = q; i < QUADS; i++) {
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        a.size[v * 2] = 0;
        a.size[v * 2 + 1] = 0;
        a.color[v * 4 + 3] = 0;
      }
    }
    mesh.visible = q > 0;
    if (q > 0) {
      for (const n of ['aCenter', 'aSize', 'aColor', 'aKind']) {
        (a.geom.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  });

  return null;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
