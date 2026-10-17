// Downloads third-party runtime assets that are intentionally not committed
// (see ../README.md). Idempotent: existing files are kept unless --force is given.
//
//   node scripts/fetch-assets.mjs [--force]
//
// (The Starlink TLE is NOT handled here: the dev/preview server downloads and refreshes it by
// itself, see server/tle-sync.mjs.)
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const force = process.argv.includes('--force');

// Earth textures shipped in the three.js repository (MIT). Pinned to the tag
// matching the `three` dependency in package.json.
const THREE_TAG = 'r169';
const TEXTURES = [
  'earth_day_4096.jpg',
  'earth_night_4096.jpg',
  'earth_bump_roughness_clouds_4096.jpg',
  'earth_normal_2048.jpg',
  'earth_specular_2048.jpg',
];
const textureUrl = (name) =>
  `https://raw.githubusercontent.com/mrdoob/three.js/${THREE_TAG}/examples/textures/planets/${name}`;

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);
async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'starlink-sim-fetch-assets' } });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 160).trim();
    throw new Error(`HTTP ${res.status} for ${url}${body ? ` (${body})` : ''}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const isJpeg = (b) => b.length > 1024 && b[0] === 0xff && b[1] === 0xd8;
const looksLikeTle = (t) => /^1 \d{5}/m.test(t) && t.split('\n').length > 300;

let failed = false;

async function fetchTextures() {
  for (const name of TEXTURES) {
    const dest = join(root, 'textures', name);
    if (!force && (await exists(dest))) continue;
    try {
      const data = await download(textureUrl(name));
      if (!isJpeg(data)) throw new Error('not a JPEG');
      await save(dest, data);
      console.log(`[assets] downloaded textures/${name} (${(data.length / 1024) | 0} KB)`);
    } catch (e) {
      failed = true;
      console.error(`[assets] FAILED textures/${name}: ${e.message}`);
    }
  }
}

await fetchTextures();
if (failed) {
  console.error('[assets] Some assets could not be downloaded. Check your network and re-run: npm run fetch:assets');
  process.exit(1);
}
