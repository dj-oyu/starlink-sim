import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createTleSync, TLE_URL_PATH, STATUS_URL_PATH } from './tle-sync.mjs';

const HOUR = 3600 * 1000;

function fakeTle(tag, n = 400) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const id = String(10000 + i);
    lines.push(`STARLINK-${tag}-${i}`, `1 ${id}U 19074B   26289.17018502  .00051451  00000+0  47456-3 0  9996`, `2 ${id}  53.1444 201.1192 0002831 127.3037 232.8238 15.67116217383094`);
  }
  return lines.join('\n') + '\n';
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('server-side TLE sync', () => {
  let dir, upstream, upstreamPort, hits, mode, app, appPort, sync;

  const startApp = async (opts = {}) => {
    sync = createTleSync({ dir, url: `http://127.0.0.1:${upstreamPort}/tle`, log: () => {}, ...opts });
    app = createServer((req, res) => sync.handle(req, res, () => ((res.statusCode = 404), res.end())));
    appPort = await listen(app);
  };
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${appPort}${path}`, { headers });
  const ago = async (path, ms) => {
    const t = new Date(Date.now() - ms);
    await utimes(path, t, t);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tle-test-'));
    hits = 0;
    mode = 'ok';
    upstream = createServer((req, res) => {
      hits++;
      if (mode === 'ok') {
        res.setHeader('content-type', 'text/plain');
        res.end(fakeTle(`v${hits}`));
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

  test('a fresh file (by mtime) is served without touching upstream', async () => {
    await writeFile(join(dir, 'starlink.tle'), fakeTle('local'));
    await startApp();
    const r = await get(TLE_URL_PATH);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /STARLINK-local-0/);
    assert.equal(hits, 0);
  });

  test('a stale file (by mtime) is served immediately and refreshed in the background', async () => {
    const f = join(dir, 'starlink.tle');
    await writeFile(f, fakeTle('old'));
    await ago(f, 7 * HOUR);
    await startApp();
    const r = await get(TLE_URL_PATH);
    assert.match(await r.text(), /STARLINK-old-0/); // stale-while-revalidate
    await sync.ensureFresh(); // joins / waits for the background refresh
    assert.equal(hits, 1);
    const r2 = await get(TLE_URL_PATH);
    assert.match(await r2.text(), /STARLINK-v1-0/);
  });

  test('cool-down comes from the attempt file timestamp and survives a restart', async () => {
    const f = join(dir, 'starlink.tle');
    await writeFile(f, fakeTle('old'));
    await ago(f, 7 * HOUR);
    await writeFile(join(dir, '.starlink.tle.attempt'), 'x'); // attempted just now
    await startApp(); // "restarted" server: no in-memory state
    await get(TLE_URL_PATH);
    await sync.ensureFresh();
    assert.equal(hits, 0);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.equal(st.stale, true);
    assert.ok(st.cooldownRemainingSec > 0);
  });

  test('once the cool-down has elapsed a stale file is refreshed', async () => {
    const f = join(dir, 'starlink.tle');
    await writeFile(f, fakeTle('old'));
    await ago(f, 7 * HOUR);
    await writeFile(join(dir, '.starlink.tle.attempt'), 'x');
    await ago(join(dir, '.starlink.tle.attempt'), 3 * HOUR);
    await startApp();
    await sync.ensureFresh();
    assert.equal(hits, 1);
    assert.ok((await stat(f)).mtimeMs > Date.now() - 5000);
  });

  test('upstream 403: the existing file keeps being served, the error is reported', async () => {
    const f = join(dir, 'starlink.tle');
    await writeFile(f, fakeTle('old'));
    await ago(f, 7 * HOUR);
    mode = '403';
    await startApp();
    await sync.ensureFresh();
    const r = await get(TLE_URL_PATH);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /STARLINK-old-0/);
    const st = await (await get(STATUS_URL_PATH)).json();
    assert.match(st.lastError, /403/);
    // and it does not hammer upstream afterwards (cool-down)
    await sync.ensureFresh();
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
    const f = join(dir, 'starlink.tle');
    await writeFile(f, fakeTle('old'));
    await ago(f, 7 * HOUR);
    mode = 'html';
    await startApp();
    await sync.ensureFresh();
    assert.match(await readFile(f, 'utf8'), /STARLINK-old-0/);
  });

  test('conditional GET returns 304 when unchanged', async () => {
    await writeFile(join(dir, 'starlink.tle'), fakeTle('local'));
    await startApp();
    const first = await get(TLE_URL_PATH);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.equal((await get(TLE_URL_PATH, { 'if-none-match': etag })).status, 304);
  });
});
