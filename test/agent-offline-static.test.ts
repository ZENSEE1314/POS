import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { buildAssetManifest } from '../src/static-assets.ts';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  server = createApp(db, { PAY_MODE: 'mock' } as NodeJS.ProcessEnv);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.close();
});

test('sw.js is served fresh, with the app shell list and a build version injected', async () => {
  const res = await fetch(`${base}/sw.js`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.ok(!body.includes('/*BUILD*/ null'), 'placeholder was replaced');
  const manifest = JSON.parse(/const BUILD = (\{.*\});/.exec(body)![1]);
  assert.match(manifest.version, /^[0-9a-f]{12}$/);
  for (const f of ['index.html', 'app.js', 'session.js', 'offline/emulator.js', 'offline/sync.js', 'manifest.webmanifest', 'icon.svg', 'app.css']) assert.ok(manifest.files.includes(f), `${f} is precached`);
  assert.ok(!manifest.files.includes('sw.js'));
});

test('every precached file is actually served (a missing file would fail the whole install)', async () => {
  const body = await (await fetch(`${base}/sw.js`)).text();
  const manifest = JSON.parse(/const BUILD = (\{.*\});/.exec(body)![1]);
  for (const f of ['/', ...manifest.files.map((x: string) => `/${x}`)]) assert.equal((await fetch(base + f)).status, 200, f);
});

test('the web manifest has its own media type and the CSP still blocks inline script', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.match(res.headers.get('content-type') ?? '', /application\/manifest\+json/);
  assert.equal(JSON.parse(await res.text()).display, 'standalone');
  const csp = (await fetch(`${base}/sw.js`)).headers.get('content-security-policy') ?? '';
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.equal(scriptSrc, "script-src 'self'");
});

test('the asset version changes when any file changes and not otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'np-assets-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.js'), 'one');
    writeFileSync(join(dir, 'sub', 'b.js'), 'two');
    writeFileSync(join(dir, 'sw.js'), 'ignored');
    writeFileSync(join(dir, '.hidden'), 'ignored');
    const first = buildAssetManifest(dir);
    assert.deepEqual(first.files, ['a.js', 'sub/b.js']);
    assert.equal(buildAssetManifest(dir).version, first.version);
    writeFileSync(join(dir, 'sub', 'b.js'), 'twelve');
    assert.notEqual(buildAssetManifest(dir).version, first.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
