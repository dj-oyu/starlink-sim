import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createTleSync, newestEpochMs, TLE_URL_PATH, STATUS_URL_PATH } from './tle-sync.mjs';

const HOUR = 3600 * 1000;

/** TLE epoch field (columns 19-32 of line 1: YYDDD.DDDDDDDD) for a point in time. */
function epochField(ms) {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const doy = (ms - Date.UTC(year, 0, 1)) / 86400000 + 1;
  return String(year % 100).padStart(2, '0') + doy.toFixed(8).padStart(12, '0');
}

/**
 * Fake TLE set. `epochAgeMs`: epoch age of the NEWEST element set; `oldAgeMs`: age of all the
 * others (real data has a long tail of old epochs).
 */
function fakeTle(tag, { n = 400, epochAgeMs = HOUR, oldAgeMs = epochAgeMs } = {}) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const id = String(10000 + i);
    const age = i === 0 ? epochAgeMs : oldAgeMs;
    lines.push(
      `STARLINK-${tag}-${i}`,
      `1 ${id}U 19074B   ${epochField(Date.now() - age)}  .00051451  00000+0  47456-3 0  9996`,
      `2 ${id}  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094`,
    );
  }
  return lines.join('\n') + '\n';
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('newestEpochMs', () => {
  test('parses the newest epoch of a real-format line (YYDDD.DDDDDDDD, UTC)', () => {
    const text =
      '1 44714U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996\n' +
      '2 44714  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094\n' +
      '1 44715U 19074C   26288.50000000  .00051451  00000+0  47456-3 0  9996\n';
    const expected = Date.UTC(2026, 0, 1) + 288.17018502 * 86400000;
    assert.ok(Math.abs(newestEpochMs(text, expected + 1e9) - expected) < 1);
  });

  test('two-digit years: < 57 is 20xx, >= 57 is 19xx', () => {
    const l = (yy) => `1 00001U 00000A   ${yy}001.00000000  .0 00000+0 00000+0 0  9990\n`;
    assert.equal(newestEpochMs(l('26'), Date.UTC(2027, 0, 1)), Date.UTC(2026, 0, 1));
    assert.equal(newestEpochMs(l('98'), Date.UTC(2027, 0, 1)), Date.UTC(1998, 0, 1));
  });

  test('garbage and far-future epochs are ignored', () => {
    assert.equal(newestEpochMs('hello\nworld\n'), 0);
    assert.equal(newestEpochMs(`1 00001U 00000A   99999.99999999  .0 00000+0 00000+0 0  9990\n`), 0);
    const future = `1 00001U 00000A   ${epochField(Date.now() + 10 * 86400000)}  .0 00000+0 00000+0 0  9990\n`;
    assert.equal(newestEpochMs(future), 0);
  });
});

describe('server-side TLE sync (decided by TLE epoch, cool-down by attempt-file mtime)', () => {
  let dir, upstream, upstreamPort, hits, mode, app, appPort, sync, upstreamAge;

  const startApp = async (opts = {}) => {
    sync = createTleSync({ dir, url: `http://127.0.0.1:${upstreamPort}/tle`, log: () => {}, ...opts });
    app = createServer((req, res) => sync.handle(req, res, () => ((res.statusCode = 404), res.end())));
    appPort = await listen(app);
  };
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${appPort}${path}`, { headers });
  const setMtimeAgo = async (path, ms) => {
    const t = new Date(Date.now() - ms);
    await utimes(path, t, t);
  };
  const tlePath = () => join(dir, 'starlink.tle');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tle-test-'));
    hits = 0;
    mode = 'ok';
    upstreamAge = 1 * HOUR; // epoch age of what upstream serves
    upstream = createServer((req, res) => {
      hits++;
      if (mode === 'ok') {
        res.setHeader('content-type', 'text/plain');
        res.end(fakeTle(`v${hits}`, { epochAgeMs: upstreamAge }));
      } else if (mode === '403') {
        res.statusCode = 403;
        res.end('GP data has not updated since your last successful download');
      } else {
        res.end('<html>not a tle</html>');
      }
    });
    upstreamPort = await listen(upstream);
  });

  afterEach(async () => {
    app?.close();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('concurrent first requests share ONE upstream download', async () => {
    await startApp();
    const rs = await Promise.all(Array.from({ length: 8 }, () => get(TLE_URL_PATH)));
    assert.deepEqual(rs.map((r) => r.status), Array(8).fill(200));
    assert.equal(hits, 1);
    assert.match(await rs[0].text(), /STARLINK-v1-0/);
  });

  test('data with a fresh epoch is served without touching upstream, whatever the file mtime says', async () => {
    await writeFile(tlePath(), fakeTle('local', { epochAgeMs: 2 * HOUR }));
    await setMtimeAgo(tlePath(), 30 * 24 * HOUR); // e.g. restored from a backup: mtime is meaningless
    await startApp();
    const r = await get(TLE_URL_PATH);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /STARLINK-local-0/);
    assert.equal(hits, 0);
  });

  test('data with an old epoch is refreshed even if the file was written just now', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR })); // mtime = now (e.g. a plain cp)
    await startApp();
    await sync.ensureFresh();
    assert.equal(hits, 1);
    assert.match(await readFile(tlePath(), 'utf8'), /STARLINK-v1-0/);
  });

  test('stale data is served immediately and refreshed in the background', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR }));
    await startApp();
    const r = await get(TLE_URL_PATH);
    assert.match(await r.text(), /STARLINK-old-0/); // stale-while-revalidate
    await sync.ensureFresh(); // joins / waits for the background refresh
    assert.equal(hits, 1);
    const r2 = await get(TLE_URL_PATH);
    assert.match(await r2.text(), /STARLINK-v1-0/);
  });

  test('freshness is judged by the NEWEST epoch (a long tail of old epochs does not matter)', async () => {
    await writeFile(tlePath(), fakeTle('mixed', { epochAgeMs: 3 * HOUR, oldAgeMs: 600 * HOUR }));
    await startApp();
    await get(TLE_URL_PATH);
    await sync.ensureFresh();
    assert.equal(hits, 0);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.equal(st.stale, false);
    assert.ok(Math.abs(st.ageSec - 3 * 3600) < 60);
  });

  test('cool-down comes from the attempt file timestamp and survives a restart', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR }));
    await writeFile(join(dir, '.starlink.tle.attempt'), 'x'); // attempted just now
    await startApp(); // "restarted" server: no in-memory state
    await get(TLE_URL_PATH);
    await sync.ensureFresh();
    assert.equal(hits, 0);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.equal(st.stale, true);
    assert.ok(st.cooldownRemainingSec > 0);
  });

  test('once the cool-down has elapsed stale data is refreshed', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR }));
    await writeFile(join(dir, '.starlink.tle.attempt'), 'x');
    await setMtimeAgo(join(dir, '.starlink.tle.attempt'), 3 * HOUR);
    await startApp();
    await sync.ensureFresh();
    assert.equal(hits, 1);
    assert.ok((await stat(tlePath())).mtimeMs > Date.now() - 5000);
  });

  test('upstream 403: the existing file keeps being served, the error is reported', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR }));
    mode = '403';
    await startApp();
    await sync.ensureFresh();
    const r = await get(TLE_URL_PATH);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /STARLINK-old-0/);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.match(st.lastError, /403/);
    await sync.ensureFresh(); // and it does not hammer upstream afterwards (cool-down)
    assert.equal(hits, 1);
  });

  test('no file and upstream failing: 503 with Retry-After', async () => {
    mode = '403';
    await startApp();
    const r = await get(TLE_URL_PATH);
    assert.equal(r.status, 503);
    assert.ok(Number(r.headers.get('retry-after')) >= 30);
  });

  test('a non-TLE upstream payload is rejected and never replaces the file', async () => {
    await writeFile(tlePath(), fakeTle('old', { epochAgeMs: 13 * HOUR }));
    mode = 'html';
    await startApp();
    await sync.ensureFresh();
    assert.match(await readFile(tlePath(), 'utf8'), /STARLINK-old-0/);
  });

  test('upstream data with an OLDER newest epoch than ours never replaces the file', async () => {
    await writeFile(tlePath(), fakeTle('ours', { epochAgeMs: 13 * HOUR })); // stale, so we ask...
    upstreamAge = 20 * HOUR; // ...but upstream is even older
    await startApp();
    await sync.ensureFresh();
    assert.equal(hits, 1);
    assert.match(await readFile(tlePath(), 'utf8'), /STARLINK-ours-0/);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.match(st.lastError, /older than ours/);
  });

  test('conditional GET returns 304 when unchanged', async () => {
    await writeFile(tlePath(), fakeTle('local'));
    await startApp();
    const first = await get(TLE_URL_PATH);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.equal((await get(TLE_URL_PATH, { 'if-none-match': etag })).status, 304);
  });
});
