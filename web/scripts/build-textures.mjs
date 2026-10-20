// Regenerates the committed Earth textures (public/assets/textures) from the Solar System Scope
// source images (CC BY 4.0, https://www.solarsystemscope.com/textures/; see ../THIRD_PARTY_NOTICES.md).
// Only needed when the textures change; the results are committed.
//
//   node scripts/build-textures.mjs
//
// Sources are downloaded into a temp dir. Outputs are modified (resized / re-encoded / packed) versions.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures');
const tmp = await mkdtemp(join(tmpdir(), 'sss-'));
const base = 'https://www.solarsystemscope.com/textures/download/';

async function src(name) {
  const res = await fetch(base + name, { headers: { 'user-agent': 'Mozilla/5.0 starlink-sim-build-textures' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
  const p = join(tmp, name);
  await writeFile(p, Buffer.from(await res.arrayBuffer()));
  return p;
}

const jpg = { quality: 85, mozjpeg: true };
await mkdir(out, { recursive: true });

const [day, night, clouds, normal, specular] = await Promise.all([
  src('8k_earth_daymap.jpg'),
  src('8k_earth_nightmap.jpg'),
  src('8k_earth_clouds.jpg'),
  src('2k_earth_normal_map.tif'),
  src('2k_earth_specular_map.tif'),
]);

await sharp(day).resize(4096, 2048).jpeg(jpg).toFile(join(out, 'earth_day_4096.jpg'));
await sharp(night).resize(4096, 2048).jpeg(jpg).toFile(join(out, 'earth_night_4096.jpg'));
// The source normal map is very flat (xy deviation ~1/255) and not unit length: amplify and renormalize.
{
  const { data, info } = await sharp(normal)
    .removeAlpha()
    .resize(2048, 1024)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const K = 8;
  for (let i = 0; i < data.length; i += 3) {
    const x = ((data[i] - 127.5) / 127.5) * K;
    const y = ((data[i + 1] - 127.5) / 127.5) * K;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    data[i] = Math.round(127.5 + 127.5 * x);
    data[i + 1] = Math.round(127.5 + 127.5 * y);
    data[i + 2] = Math.round(127.5 + 127.5 * z);
  }
  await sharp(data, { raw: info }).jpeg(jpg).toFile(join(out, 'earth_normal_2048.jpg'));
}
await sharp(specular).removeAlpha().resize(2048, 1024).jpeg(jpg).toFile(join(out, 'earth_specular_2048.jpg'));

// Packed map: R = land "elevation" proxy (blurred inverted ocean mask, used by the tactical view),
// G = unused (constant), B = cloud cover (clouds + shadows).
const [W, H] = [4096, 2048];
const land = await sharp(specular)
  .removeAlpha()
  .extractChannel(0)
  .negate()
  .resize(W, H)
  .blur(6)
  .toColourspace('b-w')
  .raw()
  .toBuffer();
const cloud = await sharp(clouds).removeAlpha().resize(W, H).greyscale().raw().toBuffer();
const packed = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  packed[i * 3] = land[i];
  packed[i * 3 + 1] = 128;
  packed[i * 3 + 2] = cloud[i];
}
await sharp(packed, { raw: { width: W, height: H, channels: 3 } })
  .jpeg(jpg)
  .toFile(join(out, 'earth_bump_roughness_clouds_4096.jpg'));
console.log('[textures] written to', out);
