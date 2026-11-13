import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, validateConfig } from '../bridge/print-bridge.ts';
import type { Bridge, BridgeConfig } from '../bridge/print-bridge.ts';
import { encodeRaster, toBase64 } from '../public/print/escpos.js';

const TOKEN = 'unit-test-token-0123456789';
const ORIGIN = 'https://pos.example.com';
const MAX_JOB = 4096;

let fake: TcpServer;
const received: Buffer[] = [];
let bridge: Bridge;
let base: string;
let port: number;
let logs: string[];
let shareDir: string;
let deadPort: number;

/** A 16x2 bitmap: left byte black, right byte white. */
const tinyJob = () => encodeRaster({ width: 16, height: 2, pixels: Uint8Array.from([...Array(8).fill(1), ...Array(8).fill(0), ...Array(8).fill(1), ...Array(8).fill(0)]) });

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const headers = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-bridge-token': TOKEN, origin: ORIGIN, ...extra });
const post = (body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/print`, { method: 'POST', headers: headers(extra), body: typeof body === 'string' ? body : JSON.stringify(body) });

const waitForBytes = async (n: number): Promise<Buffer> => {
  for (let i = 0; i < 50 && Buffer.concat(received).length < n; i++) await new Promise((r) => setTimeout(r, 20));
  return Buffer.concat(received);
};

before(async () => {
  fake = createServer((socket) => {
    socket.on('data', (c) => received.push(c));
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  deadPort = await freePort();
  shareDir = mkdtempSync(join(tmpdir(), 'bridge-share-'));
  logs = [];
  const config: BridgeConfig = {
    token: TOKEN, allowedOrigins: [ORIGIN], port: 0, maxJobBytes: MAX_JOB, connectTimeoutMs: 400, totalTimeoutMs: 1500, log: (l) => logs.push(l),
    printers: [
      { name: 'Receipt', type: 'tcp', host: '127.0.0.1', port: (fake.address() as AddressInfo).port },
      { name: 'Dead', type: 'tcp', host: '127.0.0.1', port: deadPort },
      { name: 'ShareFile', type: 'share', path: join(shareDir, 'job.bin') },
    ],
  };
  bridge = createBridge(config);
  port = (await bridge.listen()).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await bridge.close();
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(shareDir, { recursive: true, force: true });
});

test('a raster job reaches the printer byte for byte (ESC @, GS v 0, feed, cut)', async () => {
  received.length = 0;
  const job = tinyJob();
  const res = await post({ printer: 'Receipt', data: toBase64(job) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, bytes: job.length });
  const got = await waitForBytes(job.length);
  assert.deepEqual([...got], [...job]);
  assert.deepEqual([...got.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...got.subarray(2, 6)], [0x1d, 0x76, 0x30, 0x00]);
  assert.deepEqual([...got.subarray(got.length - 4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('a Windows-share style printer receives the bytes as a file write', async () => {
  const job = tinyJob();
  const res = await post({ printer: 'ShareFile', data: toBase64(job) });
  assert.equal(res.status, 200);
  assert.deepEqual([...readFileSync(join(shareDir, 'job.bin'))], [...job]);
});

test('every job is logged to stdout with printer, size and origin', async () => {
  assert.ok(logs.some((l) => l.includes('JOB printer="Receipt"') && l.includes(`origin=${ORIGIN}`) && l.includes(' ok ')));
});

test('a request without the token is refused', async () => {
  const res = await fetch(`${base}/print`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ printer: 'Receipt', data: toBase64(tinyJob()) }) });
  assert.equal(res.status, 401);
});

test('a wrong token is refused, a token of another length too', async () => {
  for (const token of ['wrong', TOKEN + 'x', TOKEN.slice(1), '']) {
    const res = await post({ printer: 'Receipt', data: toBase64(tinyJob()) }, { 'x-bridge-token': token });
    assert.equal(res.status, 401, token);
  }
});

test('an origin outside the allowlist is rejected and receives no CORS headers', async () => {
  const res = await post({ printer: 'Receipt', data: toBase64(tinyJob()) }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a preflight from the allowed origin succeeds with private-network permission', async () => {
  const res = await fetch(`${base}/print`, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-bridge-token', 'access-control-request-private-network': 'true' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-bridge-token/);
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
});

test('a preflight from an unknown origin is refused', async () => {
  const res = await fetch(`${base}/print`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('responses to the allowed origin carry CORS headers', async () => {
  const res = await fetch(`${base}/status`, { headers: headers() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const body: any = await res.json();
  assert.deepEqual(body.printers, ['Receipt', 'Dead', 'ShareFile']);
  assert.ok(body.version);
});

test('status needs the token too', async () => {
  assert.equal((await fetch(`${base}/status`, { headers: { origin: ORIGIN } })).status, 401);
});

test('an unknown printer name is rejected', async () => {
  const res = await post({ printer: 'Nope', data: toBase64(tinyJob()) });
  assert.equal(res.status, 404);
});

test('an oversize job is rejected before reaching the printer', async () => {
  received.length = 0;
  const big = Buffer.alloc(MAX_JOB + 1, 7).toString('base64');
  const res = await post({ printer: 'Receipt', data: big });
  assert.equal(res.status, 413);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(Buffer.concat(received).length, 0);
});

test('a huge request body is cut off with 413', async () => {
  const res = await post({ printer: 'Receipt', data: 'A'.repeat(MAX_JOB * 3) });
  assert.equal(res.status, 413);
});

test('malformed bodies are 400, never a crash', async () => {
  for (const body of ['not json', '[]', 'null', JSON.stringify({ printer: 'Receipt' }), JSON.stringify({ printer: 'Receipt', data: '***' }), JSON.stringify({ printer: 'Receipt', data: 12 })]) {
    const res = await post(body);
    assert.equal(res.status, 400, body);
  }
});

test('an unreachable printer returns an error quickly instead of hanging', async () => {
  const started = Date.now();
  const res = await post({ printer: 'Dead', data: toBase64(tinyJob()) });
  assert.equal(res.status, 502);
  const body: any = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unreachable/);
  assert.ok(Date.now() - started < 3000);
});

test('the request cannot choose the host or port: extra fields are ignored, unknown names fail', async () => {
  received.length = 0;
  const trap = createServer((s) => { received.push(Buffer.from('TRAP')); s.destroy(); });
  await new Promise<void>((r) => trap.listen(0, '127.0.0.1', r));
  const trapPort = (trap.address() as AddressInfo).port;
  const withAddress = await post({ printer: 'Receipt', host: '127.0.0.1', port: trapPort, data: toBase64(tinyJob()) });
  assert.equal(withAddress.status, 200);
  const asName = await post({ printer: `127.0.0.1:${trapPort}`, data: toBase64(tinyJob()) });
  assert.equal(asName.status, 404);
  const got = await waitForBytes(1);
  assert.equal(got.includes(Buffer.from('TRAP')), false);
  await new Promise<void>((r) => trap.close(() => r()));
});

test('a foreign Host header (DNS rebinding) is refused', async () => {
  assert.equal(await fetchWithHost('evil.example'), 403);
  assert.equal(await fetchWithHost(`evil.example:${port}`), 403);
  assert.equal(await fetchWithHost(`127.0.0.1:${port}`), 200);
});

async function fetchWithHost(host: string): Promise<number> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/status', headers: { host, 'x-bridge-token': TOKEN } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('the bridge listens on the loopback address only', async () => {
  const addr = bridge.server.address() as AddressInfo;
  assert.equal(addr.address, '127.0.0.1');
});

test('unknown paths and methods are 404', async () => {
  assert.equal((await fetch(`${base}/other`, { headers: headers() })).status, 404);
  assert.equal((await fetch(`${base}/print`, { headers: headers() })).status, 404);
});

test('two jobs to one printer do not interleave', async () => {
  received.length = 0;
  const a = Buffer.alloc(3000, 0x41).toString('base64');
  const b = Buffer.alloc(3000, 0x42).toString('base64');
  const [ra, rb] = await Promise.all([post({ printer: 'Receipt', data: a }), post({ printer: 'Receipt', data: b })]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  const all = await waitForBytes(6000);
  const text = all.toString('latin1');
  assert.ok(/^(A{3000}B{3000}|B{3000}A{3000})$/.test(text), 'bytes of the two jobs were mixed');
});

test('too many bad tokens trigger a lockout', async () => {
  const local = createBridge({ token: TOKEN, allowedOrigins: [ORIGIN], port: 0, printers: [{ name: 'X', type: 'tcp', host: '127.0.0.1', port: 9 }], log: () => {} });
  const p = (await local.listen()).port;
  const call = (token: string) => fetch(`http://127.0.0.1:${p}/status`, { headers: { 'x-bridge-token': token, origin: ORIGIN } });
  for (let i = 0; i < 20; i++) assert.equal((await call('bad')).status, 401);
  assert.equal((await call('bad')).status, 429);
  assert.equal((await call(TOKEN)).status, 429);
  await local.close();
});

test('weak or unsafe configs refuse to start', () => {
  const ok = { token: TOKEN, allowedOrigins: [ORIGIN], printers: [{ name: 'A', type: 'tcp', host: 'h' }] } as BridgeConfig;
  assert.doesNotThrow(() => validateConfig(ok));
  assert.throws(() => validateConfig({ ...ok, token: 'short' }));
  assert.throws(() => validateConfig({ ...ok, token: 'REPLACE-WITH-A-LONG-RANDOM-STRING' }));
  assert.throws(() => validateConfig({ ...ok, allowedOrigins: [] }));
  assert.throws(() => validateConfig({ ...ok, allowedOrigins: ['*'] }));
  assert.throws(() => validateConfig({ ...ok, allowedOrigins: ['https://pos.example.com/path'] }));
  assert.throws(() => validateConfig({ ...ok, printers: [] }));
  assert.throws(() => validateConfig({ ...ok, printers: [{ name: 'A', type: 'tcp', host: 'h' }, { name: 'A', type: 'tcp', host: 'h2' }] }));
  assert.throws(() => validateConfig({ ...ok, printers: [{ name: 'A', type: 'usb' } as any] }));
});
