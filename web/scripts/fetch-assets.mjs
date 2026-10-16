// Downloads third-party runtime assets that are intentionally not committed
// (see ../README.md). Idempotent: existing files are kept unless --force is given.
//
//   node scripts/fetch-assets.mjs [--force] [--only=textures|tle]
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const force = process.argv.includes('--force');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

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

// CelesTrak GP data (3-line format with names). It refuses repeated downloads
// within ~2 hours and answers with a plain-text notice instead of data.
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=3le';

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);
const ageMs = (p) => stat(p).then((s) => Date.now() - s.mtimeMs, () => Infinity);

// Starlink TLEs go stale within days; refresh on dev/build when older than this.
// (CelesTrak rate-limits repeats, so keep this well above its 2 h minimum.)
const TLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

async function fetchTle() {
  const dest = join(root, 'data', 'starlink.tle');
  const have = await exists(dest);
  if (!force && have && (await ageMs(dest)) < TLE_MAX_AGE_MS) return;
  try {
    const text = (await download(TLE_URL)).toString('utf8');
    if (!looksLikeTle(text)) throw new Error(`unexpected response: ${text.slice(0, 120).trim()}`);
    await save(dest, text);
    console.log(`[assets] downloaded data/starlink.tle (${(text.length / 1024) | 0} KB)`);
  } catch (e) {
    // A failed refresh must not break a working setup that already has a TLE file.
    if (!have) failed = true;
    console.error(`[assets] ${have ? 'kept existing' : 'FAILED'} data/starlink.tle: ${e.message}`);
  }
}

if (!only || only === 'textures') await fetchTextures();
if (!only || only === 'tle') await fetchTle();
if (failed) {
  console.error('[assets] Some assets could not be downloaded. Check your network and re-run: npm run fetch:assets');
  process.exit(1);
}
