// Server-side TLE sync: the single source of truth for the Starlink TLE file.
//
// Browsers only ever read `/assets/data/starlink.tle` from this server. The server keeps the file
// fresh by itself, deciding purely from the DATA and file timestamps (never from process start):
//   - how old the data is = age of the NEWEST TLE epoch in the file (line 1, columns 19-32) ->
//     refresh when older than `maxEpochAgeMs`. The epoch is a property of the data, so copying or
//     restoring the file cannot make old data look fresh. (Newest, not median: a few decayed or
//     parked satellites have epochs weeks old.)
//   - a sidecar "attempt" file's mtime tells when we last asked upstream -> at most one upstream
//     request per `cooldownMs`, even across restarts and failed attempts (CelesTrak answers 403 to
//     repeated downloads within ~2 h)
//   - concurrent clients share one in-flight download (single-flight)
//   - a download whose newest epoch is OLDER than the one we already have never replaces it
// No dependencies: plain Node (>= 18, global fetch).
import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle';
export const TLE_URL_PATH = '/assets/data/starlink.tle';
export const STATUS_URL_PATH = '/api/tle-status';

const HOUR = 3600 * 1000;

export function looksLikeTle(text) {
  return /^1 \d{5}/m.test(text) && /^2 \d{5}/m.test(text) && text.split('\n').length > 300;
}

// The TLE epoch parser lives in MoonBit (tle.mbt `newest_epoch_unix_ms`), the same package that
// parses TLEs for the simulator, so the column layout is defined in one place. The server loads the
// wasm the web app ships (public/assets/wasm/starlink-sim.wasm; rebuilt by `npm run build:wasm`).
const WASM_PATH = fileURLToPath(new URL('../public/assets/wasm/starlink-sim.wasm', import.meta.url));
let wasm = null;
function wasmExports() {
  wasm ??= new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM_PATH)), {}).exports;
  return wasm;
}

/**
 * Epoch (ms since Unix epoch, UTC) of the newest element set in a TLE text, or 0 if none can be
 * read. Epochs more than a day in the future are ignored (clock skew / garbage).
 */
export function newestEpochMs(text, now = Date.now()) {
  const bytes = Buffer.from(text, 'utf8');
  const e = wasmExports();
  const ptr = e.tle_scan_buffer(bytes.length);
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes); // read memory.buffer after the alloc: it may have grown
  return e.tle_newest_epoch_ms(bytes.length, now);
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * @param {object} o
 * @param {string} o.dir        directory holding starlink.tle (created if missing)
 * @param {string} [o.url]      upstream URL (env TLE_SOURCE_URL overrides; used by tests)
 * @param {number} [o.maxEpochAgeMs] refresh when the newest TLE epoch is older than this (default 12 h;
 *   at download time the newest epoch is typically ~4 h old, SpaceX refreshes elements every few hours)
 * @param {number} [o.cooldownMs] minimum time between upstream attempts (default 2 h 5 min)
 * @param {(msg: string) => void} [o.log]
 */
export function createTleSync({
  dir,
  url = process.env.TLE_SOURCE_URL || CELESTRAK_URL,
  maxEpochAgeMs = 12 * HOUR,
  cooldownMs = 2 * HOUR + 5 * 60 * 1000,
  log = (m) => console.log(`[tle] ${m}`),
}) {
  const file = join(dir, 'starlink.tle');
  const attemptFile = join(dir, '.starlink.tle.attempt');
  let inflight = null;
  let lastError = null;

  // Newest epoch of the current file, cached per (mtime, size) so requests don't re-parse 1.7 MB
  let epochCache = { key: '', epoch: 0 };
  const currentEpochMs = async () => {
    let st;
    try {
      st = await stat(file);
    } catch {
      return 0;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (epochCache.key !== key) {
      epochCache = { key, epoch: newestEpochMs(await readFile(file, 'utf8')) };
    }
    return epochCache.epoch;
  };
  /** Age of the data (newest epoch); Infinity when there is no readable data. */
  const ageMs = async () => {
    const e = await currentEpochMs();
    return e ? Date.now() - e : Infinity;
  };
  const cooldownRemainingMs = async () => {
    const m = await mtimeMs(attemptFile);
    return m ? Math.max(0, m + cooldownMs - Date.now()) : 0;
  };

  async function download() {
    await mkdir(dir, { recursive: true });
    // Record the attempt first (by file timestamp) so that restarts / other processes also back off
    await writeFile(attemptFile, String(Date.now())); // (writing sets the mtime)
    log(`downloading ${url}`);
    const res = await fetch(url, {
      headers: { 'user-agent': 'starlink-sim-tle-sync' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).trim()}`);
    if (!looksLikeTle(text)) throw new Error(`unexpected response: ${text.slice(0, 120).trim()}`);
    const fetchedEpoch = newestEpochMs(text);
    const haveEpoch = await currentEpochMs();
    if (!fetchedEpoch) throw new Error('downloaded data has no readable epoch');
    if (haveEpoch && fetchedEpoch < haveEpoch) {
      throw new Error(
        `upstream data is older than ours (newest epoch ${new Date(fetchedEpoch).toISOString()} < ${new Date(haveEpoch).toISOString()}); keeping ours`,
      );
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file); // atomic: readers never see a partial file
    lastError = null;
    log(`updated (${(text.length / 1024) | 0} KB)`);
  }

  /** Refresh now if (and only if) the timestamps say so. Resolves when the attempt is finished. */
  function ensureFresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      if ((await ageMs()) <= maxEpochAgeMs) return; // fresh enough (newest TLE epoch)
      if ((await cooldownRemainingMs()) > 0) return; // asked upstream recently (attempt file mtime)
      try {
        await download();
      } catch (e) {
        lastError = String(e.message || e);
        log(`refresh failed: ${lastError}`);
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function status() {
    const m = await mtimeMs(file);
    const epoch = await currentEpochMs();
    const cd = await cooldownRemainingMs();
    return {
      exists: m > 0,
      updatedAt: m ? new Date(m).toISOString() : null, // when this server wrote the file
      newestEpoch: epoch ? new Date(epoch).toISOString() : null, // the data's own timestamp
      ageSec: epoch ? Math.round((Date.now() - epoch) / 1000) : null, // age of the data (newest epoch)
      stale: (await ageMs()) > maxEpochAgeMs,
      refreshing: inflight !== null,
      cooldownRemainingSec: Math.ceil(cd / 1000),
      lastError,
    };
  }

  /** Connect-style middleware serving the TLE file and a small status endpoint. */
  async function handle(req, res, next) {
    const path = (req.url || '').split('?')[0];
    if (path !== TLE_URL_PATH && path !== STATUS_URL_PATH) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      if (path === STATUS_URL_PATH) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(await status()));
        return;
      }
      let m = await mtimeMs(file);
      if (!m) {
        await ensureFresh(); // nothing to serve yet: the first client waits for the download
        m = await mtimeMs(file);
      } else if ((await ageMs()) > maxEpochAgeMs) {
        void ensureFresh(); // stale-while-revalidate: serve what we have, refresh in background
      }
      if (!m) {
        const retry = Math.max(30, Math.ceil((await cooldownRemainingMs()) / 1000));
        res.statusCode = 503;
        res.setHeader('retry-after', String(retry));
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`TLE not available yet: ${lastError || 'no data and upstream is in cool-down'}\n`);
        return;
      }
      const st = await stat(file);
      const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
      res.setHeader('etag', etag);
      res.setHeader('last-modified', new Date(st.mtimeMs).toUTCString());
      res.setHeader('cache-control', 'no-cache'); // always revalidate; the server decides freshness
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('content-length', String(st.size));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(await readFile(file));
    } catch (e) {
      next(e);
    }
  }

  /**
   * Check the file timestamps now and then, so the data stays fresh even with no client connected.
   * (The check itself is just two stat() calls; upstream is only contacted when they say so.)
   */
  function startBackgroundCheck(intervalMs = 10 * 60 * 1000) {
    void ensureFresh();
    const t = setInterval(() => void ensureFresh(), intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  return { file, attemptFile, ensureFresh, status, handle, startBackgroundCheck };
}

