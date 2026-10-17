// Server-side TLE sync: the single source of truth for the Starlink TLE file.
//
// Browsers only ever read `/assets/data/starlink.tle` from this server. The server keeps the file
// fresh by itself, deciding purely from FILE TIMESTAMPS (never from process start time):
//   - the TLE file's mtime tells how old the data is  -> refresh when older than `maxAgeMs`
//   - a sidecar "attempt" file's mtime tells when we last asked upstream -> at most one upstream
//     request per `cooldownMs`, even across restarts and failed attempts (CelesTrak answers 403 to
//     repeated downloads within ~2 h)
//   - concurrent clients share one in-flight download (single-flight)
// No dependencies: plain Node (>= 18, global fetch).
import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle';
export const TLE_URL_PATH = '/assets/data/starlink.tle';
export const STATUS_URL_PATH = '/api/tle-status';

const HOUR = 3600 * 1000;

export function looksLikeTle(text) {
  return /^1 \d{5}/m.test(text) && /^2 \d{5}/m.test(text) && text.split('\n').length > 300;
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
 * @param {number} [o.maxAgeMs] refresh when the file is older than this (default 6 h)
 * @param {number} [o.cooldownMs] minimum time between upstream attempts (default 2 h 5 min)
 * @param {(msg: string) => void} [o.log]
 */
export function createTleSync({
  dir,
  url = process.env.TLE_SOURCE_URL || CELESTRAK_URL,
  maxAgeMs = 6 * HOUR,
  cooldownMs = 2 * HOUR + 5 * 60 * 1000,
  log = (m) => console.log(`[tle] ${m}`),
}) {
  const file = join(dir, 'starlink.tle');
  const attemptFile = join(dir, '.starlink.tle.attempt');
  let inflight = null;
  let lastError = null;

  const ageMs = async () => {
    const m = await mtimeMs(file);
    return m ? Date.now() - m : Infinity;
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
      if ((await ageMs()) <= maxAgeMs) return; // fresh enough (file timestamp)
      if ((await cooldownRemainingMs()) > 0) return; // asked upstream recently (file timestamp)
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
    const cd = await cooldownRemainingMs();
    return {
      exists: m > 0,
      updatedAt: m ? new Date(m).toISOString() : null,
      ageSec: m ? Math.round((Date.now() - m) / 1000) : null,
      stale: (await ageMs()) > maxAgeMs,
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
      } else if ((await ageMs()) > maxAgeMs) {
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

