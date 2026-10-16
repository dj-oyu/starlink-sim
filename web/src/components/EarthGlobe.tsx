import { useEffect, useRef } from 'preact/hooks';
import * as THREE from 'three';
import { useFrame, useThree } from '../fiber/PreactFiber';
import { latLonAltToThree } from '../wasm/simEngine';

export interface EarthVisualSettings {
  mode: 'photoreal' | 'hybrid' | 'tactical';
  showClouds: boolean;
  showAtmosphere: boolean;
  showBorders: boolean;
  showGraticule: boolean;
  dayNightShading: boolean;
}

interface EarthGlobeProps {
  sunDirectionRef: { current: [number, number, number] };
  visualSettings: EarthVisualSettings;
  earthMeshRef: { current: THREE.Mesh | null };
}

const EARTH_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vPositionWorld;
  varying vec3 vTangentWorld;
  varying vec3 vBitangentWorld;

  void main() {
    vUv = uv;
    vPositionWorld = position;
    vNormalWorld = normal;

    vec3 tangent = vec3(-normal.z, 0.0, normal.x);
    float len = length(tangent);
    tangent = len > 0.001 ? tangent / len : vec3(1.0, 0.0, 0.0);
    vTangentWorld = tangent;
    vBitangentWorld = cross(normal, tangent);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EARTH_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uPackedMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uSpecularMap;
  uniform vec3 uSunDir;
  uniform float uTacticalMix;
  uniform float uDayNightEnabled;
  uniform float uCloudsEnabled;

  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vPositionWorld;
  varying vec3 vTangentWorld;
  varying vec3 vBitangentWorld;

  void main() {
    vec3 N = normalize(vNormalWorld);
    mat3 TBN = mat3(normalize(vTangentWorld), normalize(vBitangentWorld), N);

    vec3 normalSample = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
    normalSample.xy *= 1.35;
    vec3 perturbedN = normalize(TBN * normalSample);

    vec3 L = uSunDir;
    vec3 V = normalize(cameraPosition - vPositionWorld);
    vec3 H = normalize(L + V);

    vec3 dayColor = texture2D(uDayMap, vUv).rgb;
    vec3 nightColor = texture2D(uNightMap, vUv).rgb;
    vec3 packed = texture2D(uPackedMap, vUv).rgb;
    float specMask = texture2D(uSpecularMap, vUv).r;

    float cloudShadow = 1.0;
    if (uCloudsEnabled > 0.5) {
      vec2 shadowUv = vUv - vec2(L.x, L.y) * 0.0018;
      float shadowCloud = texture2D(uPackedMap, shadowUv).b;
      cloudShadow = 1.0 - shadowCloud * 0.42;
    }

    float sunDot = dot(N, L);
    float pertDot = dot(perturbedN, L);

    float dayFactor = mix(1.0, smoothstep(-0.16, 0.22, sunDot), uDayNightEnabled);
    float diffuse = mix(0.92, max(pertDot, 0.06), uDayNightEnabled);

    float twilight = (1.0 - abs(clamp(sunDot * 4.5, -1.0, 1.0))) * smoothstep(-0.22, 0.05, sunDot);
    vec3 twilightColor = vec3(1.0, 0.38, 0.12) * twilight * 0.48 * uDayNightEnabled;

    float specAngle = max(dot(perturbedN, H), 0.0);
    float spec = pow(specAngle, 48.0) * specMask * max(sunDot, 0.0);
    vec3 specColor = mix(vec3(0.85, 0.93, 1.0), vec3(1.0, 0.65, 0.35), twilight) * spec * 0.75;

    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 atmosScatter = vec3(0.22, 0.58, 1.0) * fresnel * (0.35 + 0.65 * dayFactor);

    vec3 litDay = dayColor * diffuse * cloudShadow + specColor + twilightColor;
    vec3 litNight = nightColor * vec3(1.5, 1.25, 0.9) * 1.45 + dayColor * vec3(0.04, 0.06, 0.11);

    vec3 photorealColor = mix(litNight, litDay, dayFactor) + atmosScatter;

    if (uTacticalMix > 0.001) {
      float landMask = 1.0 - specMask;
      float elevation = packed.r;
      vec3 tacticalLand = vec3(0.035, 0.085, 0.16) + vec3(0.04, 0.16, 0.28) * elevation;
      vec3 tacticalOcean = vec3(0.008, 0.02, 0.045);
      vec3 tacticalBase = mix(tacticalOcean, tacticalLand, landMask);
      vec3 tacticalColor = tacticalBase + nightColor * vec3(0.3, 0.75, 1.0) * 0.65 + vec3(0.05, 0.28, 0.55) * fresnel * 0.55;
      if (uDayNightEnabled > 0.5) {
        tacticalColor *= (0.65 + 0.35 * dayFactor);
      }
      gl_FragColor = vec4(mix(photorealColor, tacticalColor, uTacticalMix), 1.0);
    } else {
      gl_FragColor = vec4(photorealColor, 1.0);
    }
  }
`;

const CLOUDS_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalWorld;

  void main() {
    vUv = uv;
    vNormalWorld = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUDS_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uPackedMap;
  uniform vec3 uSunDir;
  uniform float uDayNightEnabled;

  varying vec2 vUv;
  varying vec3 vNormalWorld;

  void main() {
    float cloud = texture2D(uPackedMap, vUv).b;
    if (cloud < 0.03) discard;

    vec3 N = normalize(vNormalWorld);
    float sunDot = dot(N, uSunDir);
    float dayFactor = mix(1.0, smoothstep(-0.18, 0.25, sunDot), uDayNightEnabled);
    float twilight = (1.0 - abs(clamp(sunDot * 4.0, -1.0, 1.0))) * smoothstep(-0.2, 0.08, sunDot) * uDayNightEnabled;

    vec3 dayCloud = vec3(0.98, 0.99, 1.0);
    vec3 sunsetCloud = vec3(1.0, 0.52, 0.25);
    vec3 nightCloud = vec3(0.05, 0.08, 0.14);

    vec3 cloudColor = mix(nightCloud, dayCloud, dayFactor) + sunsetCloud * twilight * 0.55;
    float alpha = cloud * mix(0.32, 0.86, dayFactor);
    gl_FragColor = vec4(cloudColor, alpha);
  }
`;

const ATMOS_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormalWorld;
  varying vec3 vPositionWorld;

  void main() {
    vPositionWorld = position;
    vNormalWorld = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMOS_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uDayNightEnabled;

  varying vec3 vNormalWorld;
  varying vec3 vPositionWorld;

  void main() {
    vec3 N = normalize(vNormalWorld);
    vec3 V = normalize(cameraPosition - vPositionWorld);

    float viewDot = dot(N, -V);
    float rim = pow(clamp(1.0 - viewDot, 0.0, 1.0), 2.8);

    float sunDot = dot(N, uSunDir);
    float sunFactor = mix(0.85, smoothstep(-0.35, 0.4, sunDot), uDayNightEnabled);
    float twilight = (1.0 - abs(clamp(sunDot * 3.0, -1.0, 1.0))) * smoothstep(-0.3, 0.1, sunDot) * uDayNightEnabled;

    vec3 dayGlow = vec3(0.24, 0.64, 1.0);
    vec3 twilightGlow = vec3(1.0, 0.42, 0.15);
    vec3 nightGlow = vec3(0.06, 0.16, 0.36);

    vec3 color = mix(nightGlow, dayGlow, sunFactor) + twilightGlow * twilight * 0.4;
    float alpha = rim * (0.18 + 0.68 * sunFactor);
    gl_FragColor = vec4(color, alpha);
  }
`;

function parseGeoJsonToLinePositions(geojson: any, radius = 1.0018): Float32Array {
  const segments: number[] = [];

  function addRing(coords: number[][]) {
    for (let i = 0; i + 1 < coords.length; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const [x1, y1, z1] = latLonAltToThree(lat1, lon1, (radius - 1.0) * 6378.135);
      const [x2, y2, z2] = latLonAltToThree(lat2, lon2, (radius - 1.0) * 6378.135);
      segments.push(x1, y1, z1, x2, y2, z2);
    }
  }

  function processGeometry(geom: any) {
    if (!geom) return;
    if (geom.type === 'LineString') {
      addRing(geom.coordinates);
    } else if (geom.type === 'MultiLineString' || geom.type === 'Polygon') {
      for (const ring of geom.coordinates) {
        addRing(ring);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          addRing(ring);
        }
      }
    }
  }

  if (geojson?.features) {
    for (const f of geojson.features) {
      processGeometry(f.geometry);
    }
  }
  return new Float32Array(segments);
}

export function EarthGlobe({
  sunDirectionRef,
  visualSettings,
  earthMeshRef,
}: EarthGlobeProps) {
  const { scene } = useThree();
  const earthMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const cloudsMeshRef = useRef<THREE.Mesh | null>(null);
  const cloudsMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const atmosMeshRef = useRef<THREE.Mesh | null>(null);
  const atmosMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const vectorGroupRef = useRef<THREE.Group | null>(null);
  const coastMatRef = useRef<THREE.LineBasicMaterial | null>(null);
  const borderMatRef = useRef<THREE.LineBasicMaterial | null>(null);
  const gridSegmentsRef = useRef<THREE.LineSegments | null>(null);
  const gridMatRef = useRef<THREE.LineBasicMaterial | null>(null);

  useEffect(() => {
    const rootGroup = new THREE.Group();
    scene.add(rootGroup);

    // 1. Starfield background
    const starCount = 4800;
    const starPos = new Float32Array(starCount * 3);
    const starCol = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 45 + Math.random() * 65;
      const theta = Math.acos(2 * Math.random() - 1);
      const phi = Math.random() * Math.PI * 2;
      starPos[i * 3] = r * Math.sin(theta) * Math.cos(phi);
      starPos[i * 3 + 1] = r * Math.cos(theta);
      starPos[i * 3 + 2] = r * Math.sin(theta) * Math.sin(phi);
      const tint = 0.75 + Math.random() * 0.25;
      starCol[i * 3] = tint;
      starCol[i * 3 + 1] = tint;
      starCol[i * 3 + 2] = Math.min(1, tint + 0.1);
    }
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeom.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    const starMat = new THREE.PointsMaterial({
      size: 0.28,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
    });
    const starPoints = new THREE.Points(starGeom, starMat);
    rootGroup.add(starPoints);

    // 2. Load local 4K & 2K Earth textures
    const loader = new THREE.TextureLoader();
    const conf = (tex: THREE.Texture) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      return tex;
    };
    const dayTex = conf(loader.load('/assets/textures/earth_day_4096.jpg'));
    const nightTex = conf(loader.load('/assets/textures/earth_night_4096.jpg'));
    const packedTex = conf(
      loader.load('/assets/textures/earth_bump_roughness_clouds_4096.jpg'),
    );
    const normalTex = conf(loader.load('/assets/textures/earth_normal_2048.jpg'));
    const specularTex = conf(
      loader.load('/assets/textures/earth_specular_2048.jpg'),
    );

    // 3. Main Earth Sphere (64x64 is visually identical to 96x96 while saving >50% vertex work)
    const earthGeom = new THREE.SphereGeometry(1.0, 64, 64);
    const earthMat = new THREE.ShaderMaterial({
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
      uniforms: {
        uDayMap: { value: dayTex },
        uNightMap: { value: nightTex },
        uPackedMap: { value: packedTex },
        uNormalMap: { value: normalTex },
        uSpecularMap: { value: specularTex },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uTacticalMix: { value: 0.0 },
        uDayNightEnabled: { value: 1.0 },
        uCloudsEnabled: { value: 1.0 },
      },
    });
    const earthMesh = new THREE.Mesh(earthGeom, earthMat);
    earthMesh.userData.isEarthGlobe = true;
    rootGroup.add(earthMesh);
    earthMeshRef.current = earthMesh;
    earthMatRef.current = earthMat;

    // 4. 4K Dynamic Cloud Sphere
    const cloudsGeom = new THREE.SphereGeometry(1.0055, 48, 48);
    const cloudsMat = new THREE.ShaderMaterial({
      vertexShader: CLOUDS_VERTEX_SHADER,
      fragmentShader: CLOUDS_FRAGMENT_SHADER,
      uniforms: {
        uPackedMap: { value: packedTex },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uDayNightEnabled: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
    });
    const cloudsMesh = new THREE.Mesh(cloudsGeom, cloudsMat);
    rootGroup.add(cloudsMesh);
    cloudsMeshRef.current = cloudsMesh;
    cloudsMatRef.current = cloudsMat;

    // 5. Atmospheric Fresnel Rim Halo
    const atmosGeom = new THREE.SphereGeometry(1.032, 48, 48);
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: ATMOS_VERTEX_SHADER,
      fragmentShader: ATMOS_FRAGMENT_SHADER,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uDayNightEnabled: { value: 1.0 },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmosMesh = new THREE.Mesh(atmosGeom, atmosMat);
    rootGroup.add(atmosMesh);
    atmosMeshRef.current = atmosMesh;
    atmosMatRef.current = atmosMat;

    // 6. Coastlines & Country Borders Vector Overlay
    const vectorGroup = new THREE.Group();
    const coastGeom = new THREE.BufferGeometry();
    const coastMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.5,
    });
    const coastLines = new THREE.LineSegments(coastGeom, coastMat);

    const borderGeom = new THREE.BufferGeometry();
    const borderMat = new THREE.LineBasicMaterial({
      color: 0x0ea5e9,
      transparent: true,
      opacity: 0.35,
    });
    const borderLines = new THREE.LineSegments(borderGeom, borderMat);

    vectorGroup.add(coastLines);
    vectorGroup.add(borderLines);
    rootGroup.add(vectorGroup);
    vectorGroupRef.current = vectorGroup;
    coastMatRef.current = coastMat;
    borderMatRef.current = borderMat;

    let active = true;
    Promise.all([
      fetch('/assets/data/ne_110m_coastline.geojson').then((r) => r.json()),
      fetch('/assets/data/ne_110m_borders.geojson').then((r) => r.json()),
    ])
      .then(([coastJson, borderJson]) => {
        if (!active) return;
        const coastPos = parseGeoJsonToLinePositions(coastJson, 1.0018);
        const borderPos = parseGeoJsonToLinePositions(borderJson, 1.0018);
        coastGeom.setAttribute('position', new THREE.BufferAttribute(coastPos, 3));
        borderGeom.setAttribute('position', new THREE.BufferAttribute(borderPos, 3));
      })
      .catch((err) => console.error('Failed to load local GeoJSON:', err));

    // 7. Graticule Lat/Lon Grid
    const pts: number[] = [];
    const rAlt = 0.0015 * 6378.135;
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = -180; lon < 180; lon += 3) {
        const [x1, y1, z1] = latLonAltToThree(lat, lon, rAlt);
        const [x2, y2, z2] = latLonAltToThree(lat, lon + 3, rAlt);
        pts.push(x1, y1, z1, x2, y2, z2);
      }
    }
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -84; lat < 84; lat += 3) {
        const [x1, y1, z1] = latLonAltToThree(lat, lon, rAlt);
        const [x2, y2, z2] = latLonAltToThree(lat + 3, lon, rAlt);
        pts.push(x1, y1, z1, x2, y2, z2);
      }
    }
    const gridGeom = new THREE.BufferGeometry();
    gridGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.14,
    });
    const gridSegments = new THREE.LineSegments(gridGeom, gridMat);
    rootGroup.add(gridSegments);
    gridSegmentsRef.current = gridSegments;
    gridMatRef.current = gridMat;

    return () => {
      active = false;
      scene.remove(rootGroup);
      earthMeshRef.current = null;
    };
  }, [scene]);

  useFrame(() => {
    const [sx, sy, sz] = sunDirectionRef.current;
    const tacticalTarget =
      visualSettings.mode === 'tactical'
        ? 1.0
        : visualSettings.mode === 'hybrid'
          ? 0.28
          : 0.0;
    const dayNightVal = visualSettings.dayNightShading ? 1.0 : 0.0;
    const cloudsVal = visualSettings.showClouds ? 1.0 : 0.0;

    if (earthMatRef.current) {
      earthMatRef.current.uniforms.uSunDir.value.set(sx, sy, sz);
      earthMatRef.current.uniforms.uTacticalMix.value = tacticalTarget;
      earthMatRef.current.uniforms.uDayNightEnabled.value = dayNightVal;
      earthMatRef.current.uniforms.uCloudsEnabled.value = cloudsVal;
    }
    if (cloudsMeshRef.current) {
      cloudsMeshRef.current.visible =
        visualSettings.showClouds && visualSettings.mode !== 'tactical';
    }
    if (cloudsMatRef.current) {
      cloudsMatRef.current.uniforms.uSunDir.value.set(sx, sy, sz);
      cloudsMatRef.current.uniforms.uDayNightEnabled.value = dayNightVal;
    }
    if (atmosMeshRef.current) {
      atmosMeshRef.current.visible = visualSettings.showAtmosphere;
    }
    if (atmosMatRef.current) {
      atmosMatRef.current.uniforms.uSunDir.value.set(sx, sy, sz);
      atmosMatRef.current.uniforms.uDayNightEnabled.value = dayNightVal;
    }
    if (vectorGroupRef.current) {
      vectorGroupRef.current.visible =
        visualSettings.showBorders ||
        visualSettings.mode === 'tactical' ||
        visualSettings.mode === 'hybrid';
    }
    if (coastMatRef.current && borderMatRef.current) {
      coastMatRef.current.opacity =
        visualSettings.mode === 'tactical' ? 0.72 : 0.42;
      borderMatRef.current.opacity =
        visualSettings.mode === 'tactical' ? 0.45 : 0.25;
    }
    if (gridSegmentsRef.current && gridMatRef.current) {
      gridSegmentsRef.current.visible =
        visualSettings.showGraticule ||
        visualSettings.mode === 'tactical' ||
        visualSettings.mode === 'hybrid';
      gridMatRef.current.opacity =
        visualSettings.mode === 'tactical' ? 0.18 : 0.11;
    }
  });

  return null;
}
