// Vite plugin: attaches the server-side TLE sync (see tle-sync.mjs) to the dev server and to
// `vite preview`, so every browser connected to one server shares a single, self-refreshing TLE
// file. The data lives in <root>/public/assets/data (override with env TLE_DATA_DIR); a TLE that
// happens to be there at build time is not copied into dist (the server serves/updates its own).
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTleSync } from './tle-sync.mjs';

export default function tleSync() {
  let root = process.cwd();
  let outDir = 'dist';
  const dataDir = () => resolve(process.env.TLE_DATA_DIR || join(root, 'public', 'assets', 'data'));

  const attach = (server) => {
    const sync = createTleSync({ dir: dataDir() });
    server.middlewares.use((req, res, next) => void sync.handle(req, res, next));
    sync.startBackgroundCheck();
  };

  return {
    name: 'tle-sync',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    configureServer: attach,
    configurePreviewServer: attach,
    async closeBundle() {
      // keep a possibly stale local TLE (and the cool-down marker) out of the build output
      for (const f of ['starlink.tle', '.starlink.tle.attempt']) {
        await rm(join(root, outDir, 'assets', 'data', f), { force: true });
      }
    },
  };
}
