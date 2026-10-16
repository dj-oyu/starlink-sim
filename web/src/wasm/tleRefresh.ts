// Live TLE refresh from CelesTrak.
//
// Orbits are propagated locally, so refreshing is only needed to keep the
// elements from going stale (Starlink TLEs degrade within a few days).
// CelesTrak rejects (HTTP 403) repeated downloads of the same group within
// ~2 hours, so every request is gated by timestamps kept in localStorage.

const TLE_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle';

/** CelesTrak refuses re-downloads of a group more often than this. */
export const CELESTRAK_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** Automatic refresh cadence while the app is open. */
export const AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often the app checks whether an automatic refresh is due. */
export const AUTO_CHECK_EVERY_MS = 10 * 60 * 1000;
/** Cached TLEs older than this are ignored at startup. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const K_TEXT = 'starlink-sim:tle';
const K_FETCHED = 'starlink-sim:tle-fetched-at';
const K_ATTEMPT = 'starlink-sim:tle-attempt-at';

function readNum(key: string): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeKey(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // private mode / quota: the app still works without the cache
  }
}

export const lastFetchedAt = () => readNum(K_FETCHED);
export const lastAttemptAt = () => readNum(K_ATTEMPT);

export function looksLikeTle(text: string): boolean {
  return /^1 \d{5}/m.test(text) && /^2 \d{5}/m.test(text);
}

/** Cached live TLE text, or null if absent / too old. */
export function loadCachedTle(): string | null {
  try {
    const at = lastFetchedAt();
    if (!at || Date.now() - at > CACHE_MAX_AGE_MS) return null;
    const text = localStorage.getItem(K_TEXT);
    return text && looksLikeTle(text) ? text : null;
  } catch {
    return null;
  }
}

export type RefreshResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'rate-limited' | 'error'; message: string };

const fmtAgo = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 90 ? `${m}分前` : `${(m / 60).toFixed(1)}時間前`;
};

/**
 * Download the Starlink TLE set. Returns validated text only; the caller loads
 * it into the engine, so a bad response can never wipe the current constellation.
 */
export async function fetchLatestTle(): Promise<RefreshResult> {
  const since = Date.now() - Math.max(lastFetchedAt(), lastAttemptAt());
  if (since < CELESTRAK_MIN_INTERVAL_MS) {
    return {
      ok: false,
      reason: 'rate-limited',
      message: `直近 (${fmtAgo(since)}) に取得済みです。CelesTrak は同じデータの再取得を2時間以内は拒否するため、少し待ってください。`,
    };
  }
  writeKey(K_ATTEMPT, String(Date.now()));
  try {
    const res = await fetch(TLE_URL);
    const text = await res.text();
    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        reason: 'rate-limited',
        message: 'CelesTrak に拒否されました (同じデータは2時間に1回まで)。取得済みのデータを使い続けます。',
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!looksLikeTle(text)) throw new Error('TLE 形式ではない応答でした');
    writeKey(K_TEXT, text);
    writeKey(K_FETCHED, String(Date.now()));
    return { ok: true, text };
  } catch (e: any) {
    return {
      ok: false,
      reason: 'error',
      message: `取得に失敗しました (オフラインまたは CORS): ${e.message}`,
    };
  }
}

/** True when the automatic refresh should run now. */
export function autoRefreshDue(): boolean {
  const last = Math.max(lastFetchedAt(), lastAttemptAt());
  return Date.now() - last >= AUTO_REFRESH_INTERVAL_MS;
}
