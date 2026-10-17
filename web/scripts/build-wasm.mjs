// Builds the MoonBit wasm (release) and copies it into the web app's public assets.
// Package-manager agnostic (plain node), so `npm run` / `pnpm` / `yarn` behave the same.
//
// If the MoonBit toolchain (`moon`) is not installed, the wasm committed in the repository is
// used as is, so the web app can be run without MoonBit. A real compile error still fails.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, '..');
const built = join(root, '_build', 'wasm', 'release', 'build', 'starlink-sim.wasm');
const dest = join(web, 'public', 'assets', 'wasm', 'starlink-sim.wasm');
const shell = process.platform === 'win32'; // `moon` is a .exe/.cmd shim on Windows

const probe = spawnSync('moon', ['version'], { stdio: 'ignore', shell });
if (probe.error || probe.status !== 0) {
  if (existsSync(dest)) {
    console.warn(
      '[wasm] MoonBit (`moon`) not found: using the prebuilt public/assets/wasm/starlink-sim.wasm.\n' +
        '[wasm] Install MoonBit (https://www.moonbitlang.com/download) to rebuild it from source.',
    );
    process.exit(0);
  }
  console.error('[wasm] MoonBit (`moon`) not found and no prebuilt wasm exists. Install MoonBit first.');
  process.exit(1);
}

const r = spawnSync('moon', ['-C', root, 'build', '--target', 'wasm', '--release'], {
  stdio: 'inherit',
  shell,
});
if (r.status !== 0) process.exit(r.status ?? 1);

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log('[wasm] built and copied to public/assets/wasm/starlink-sim.wasm');
