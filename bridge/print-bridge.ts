/**
 * NightPOS local print bridge. Runs on a venue PC next to the printers and relays raw ESC/POS bytes sent by the
 * NightPOS web app in the browser. Zero dependencies: `node bridge/print-bridge.ts [--config file]`.
 *
 * Threat model: any website the user visits can send requests to 127.0.0.1. So every request needs the shared token,
 * the browser Origin must be allow-listed, the Host header must be loopback (DNS rebinding), printers are addressed
 * only by NAME (the host/port/share live in this machine's config file, never in a request), and sizes/rates are capped.
 */
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BRIDGE_VERSION = '1.0.0';
const DEFAULT_PORT = 9101;
const LOOPBACK = '127.0.0.1';
const MAX_JOB_BYTES = 512 * 1024;
const BASE64_OVERHEAD = 4 / 3;
const JSON_ENVELOPE_BYTES = 2048;
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10_000;
const SOCKET_CLOSE_GRACE_MS = 300;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 240;
const MAX_FAILED_AUTH_PER_WINDOW = 20;
const MIN_TOKEN_LENGTH = 16;
const PREFLIGHT_MAX_AGE_S = 600;
const DEFAULT_TCP_PORT = 9100;

export interface TcpPrinter { name: string; type: 'tcp'; host: string; port?: number }
export interface SharePrinter { name: string; type: 'share'; path: string }
export type PrinterTarget = TcpPrinter | SharePrinter;

export interface BridgeConfig {
  token: string;
  allowedOrigins: string[];
  printers: PrinterTarget[];
  /** 0 picks a free port (tests). */
  port?: number;
  maxJobBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface Bridge {
  server: Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Throws with a readable reason when the config could expose the bridge; never starts half-configured. */
export function validateConfig(config: BridgeConfig): void {
  if (typeof config.token !== 'string' || config.token.length < MIN_TOKEN_LENGTH || /^REPLACE/i.test(config.token)) {
    throw new Error(`config.token must be a secret of at least ${MIN_TOKEN_LENGTH} characters (run with --gen-token)`);
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) throw new Error('config.allowedOrigins must list the NightPOS origin(s)');
  for (const o of config.allowedOrigins) {
    if (typeof o !== 'string' || o === '*' || !/^https?:\/\/[^/\s]+$/.test(o)) throw new Error(`allowedOrigins entry "${o}" must look like https://host[:port] (no path, no wildcard)`);
  }
  if (!Array.isArray(config.printers) || config.printers.length === 0) throw new Error('config.printers must list at least one printer');
  const seen = new Set<string>();
  for (const p of config.printers) {
    if (typeof p?.name !== 'string' || !p.name) throw new Error('every printer needs a name');
    if (seen.has(p.name)) throw new Error(`duplicate printer name "${p.name}"`);
    seen.add(p.name);
    if (p.type === 'tcp') {
      if (typeof p.host !== 'string' || !p.host) throw new Error(`printer "${p.name}": tcp needs a host`);
      if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) throw new Error(`printer "${p.name}": bad port`);
    } else if (p.type === 'share') {
      if (typeof p.path !== 'string' || !p.path) throw new Error(`printer "${p.name}": share needs a path such as \\\\localhost\\EPSON_TM`);
    } else {
      throw new Error(`printer "${p.name}": type must be "tcp" or "share"`);
    }
  }
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Hashing first makes both sides 32 bytes, so the comparison is constant-time even when the lengths differ. */
function sameToken(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(given ?? ''), digest(expected)) && Boolean(given);
}

/** Sliding-window counter; one instance per concern (all requests, failed authentications). */
function createWindowLimiter(limit: number, windowMs: number) {
  let hits: number[] = [];
  return {
    allow(): boolean {
      const now = Date.now();
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= limit) return false;
      hits.push(now);
      return true;
    },
    peek(): boolean {
      const now = Date.now();
      return hits.filter((t) => now - t < windowMs).length < limit;
    },
  };
}

/** Writes the bytes to one printer. Exported for the self-test; requests can never reach it with an address. */
export function sendToPrinter(target: PrinterTarget, bytes: Uint8Array, opts: { connectTimeoutMs?: number; totalTimeoutMs?: number } = {}): Promise<void> {
  const connectMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const totalMs = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  if (target.type === 'share') {
    return writeFile(target.path, bytes, { signal: AbortSignal.timeout(totalMs) }).catch((e: NodeJS.ErrnoException) => {
      throw new Error(`share write failed (${e.code ?? e.name})`);
    });
  }
  return new Promise<void>((resolveJob, rejectJob) => {
    let settled = false;
    const socket = connect({ host: target.host, port: target.port ?? DEFAULT_TCP_PORT });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      socket.destroy();
      if (err) rejectJob(err); else resolveJob();
    };
    const connectTimer = setTimeout(() => finish(new Error('printer unreachable (connect timeout)')), connectMs);
    const totalTimer = setTimeout(() => finish(new Error('printer too slow (timeout)')), totalMs);
    socket.on('error', (e: NodeJS.ErrnoException) => finish(new Error(`printer unreachable (${e.code ?? 'error'})`)));
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      socket.end(Buffer.from(bytes), () => {
        // Printers rarely close first: give a close a moment, then treat flushed-to-the-OS as delivered.
        const grace = setTimeout(() => finish(), SOCKET_CLOSE_GRACE_MS);
        socket.once('close', () => { clearTimeout(grace); finish(); });
      });
    });
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<any> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError('payload too large', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new HttpError('payload too large', 413);
    chunks.push(c as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError('body must be a JSON object', 400);
  }
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeData(data: unknown, maxBytes: number): Buffer {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !STRICT_BASE64.test(data)) throw new HttpError('data must be base64 ESC/POS bytes', 400);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maxBytes) throw new HttpError('payload too large', 413);
  return bytes;
}

export function createBridge(config: BridgeConfig): Bridge {
  validateConfig(config);
  const log = config.log ?? ((line: string) => console.log(line));
  const maxJobBytes = config.maxJobBytes ?? MAX_JOB_BYTES;
  const maxBodyBytes = Math.ceil(maxJobBytes * BASE64_OVERHEAD) + JSON_ENVELOPE_BYTES;
  const allowedOrigins = new Set(config.allowedOrigins);
  const printers = new Map(config.printers.map((p) => [p.name, p]));
  const queues = new Map<string, Promise<unknown>>();
  const requestLimiter = createWindowLimiter(MAX_REQUESTS_PER_WINDOW, RATE_WINDOW_MS);
  const authFailLimiter = createWindowLimiter(MAX_FAILED_AUTH_PER_WINDOW, RATE_WINDOW_MS);
  let boundPort = 0;

  const hostAllowed = (host: string | undefined): boolean => {
    if (!host) return false;
    const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(host);
    return Boolean(m) && Number(m![2]) === boundPort;
  };

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(body));
  };

  const corsHeaders = (origin: string): Record<string, string> => ({
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-bridge-token',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_S),
  });

  /** Serialises jobs per printer: two tablets printing at once must not interleave bytes on one connection. */
  const enqueue = <T>(name: string, job: () => Promise<T>): Promise<T> => {
    const run = (queues.get(name) ?? Promise.resolve()).then(job, job);
    queues.set(name, run.catch(() => undefined));
    return run;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin as string | undefined;
    const cors = origin && allowedOrigins.has(origin) ? corsHeaders(origin) : {};
    const who = origin ?? 'no-origin';
    try {
      if (!hostAllowed(req.headers.host)) throw new HttpError('bad host', 403);
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        log(`${new Date().toISOString()} REJECT origin=${who}`);
        throw new HttpError('origin not allowed', 403);
      }
      if (!requestLimiter.allow()) throw new HttpError('rate limit exceeded', 429);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Content-Length': '0' });
        res.end();
        return;
      }
      if (!authFailLimiter.peek()) throw new HttpError('too many bad tokens, slow down', 429);
      if (!sameToken(req.headers['x-bridge-token'] as string | undefined, config.token)) {
        authFailLimiter.allow();
        log(`${new Date().toISOString()} REJECT bad-token origin=${who}`);
        throw new HttpError('invalid token', 401);
      }
      const path = new URL(req.url ?? '/', `http://${LOOPBACK}`).pathname;
      if (req.method === 'GET' && path === '/status') {
        return send(res, 200, { ok: true, version: BRIDGE_VERSION, printers: [...printers.keys()] }, cors);
      }
      if (req.method === 'POST' && path === '/print') {
        const body = await readJsonBody(req, maxBodyBytes);
        const name = typeof body.printer === 'string' ? body.printer : '';
        const target = printers.get(name);
        if (!target) throw new HttpError('unknown printer', 404);
        const bytes = decodeData(body.data, maxJobBytes);
        const started = Date.now();
        try {
          await enqueue(name, () => sendToPrinter(target, bytes, { connectTimeoutMs: config.connectTimeoutMs, totalTimeoutMs: config.totalTimeoutMs }));
        } catch (e) {
          log(`${new Date().toISOString()} JOB printer="${name}" bytes=${bytes.length} origin=${who} FAILED ${(e as Error).message}`);
          throw new HttpError((e as Error).message, 502);
        }
        log(`${new Date().toISOString()} JOB printer="${name}" bytes=${bytes.length} origin=${who} ok ${Date.now() - started}ms`);
        return send(res, 200, { ok: true, bytes: bytes.length }, cors);
      }
      throw new HttpError('not found', 404);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message }, cors);
      log(`${new Date().toISOString()} ERROR ${(e as Error).message}`);
      return send(res, 500, { ok: false, error: 'internal error' }, cors);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = TOTAL_TIMEOUT_MS * 2;
  server.headersTimeout = 5000;

  return {
    server,
    listen: () => new Promise<AddressInfo>((ok, fail) => {
      server.once('error', fail);
      // Always the loopback address: the bridge is never reachable from the LAN, whatever the config says.
      server.listen(config.port ?? DEFAULT_PORT, LOOPBACK, () => {
        const addr = server.address() as AddressInfo;
        boundPort = addr.port;
        ok(addr);
      });
    }),
    close: () => new Promise<void>((ok) => {
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}

// ---- CLI ---------------------------------------------------------------------------------------------

function loadConfig(path: string): BridgeConfig {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${(e as Error).message}`);
  }
}

/** A tiny ASCII + raster test page, so a venue can prove the wiring before touching NightPOS. */
export function buildTestPage(printerName: string): Uint8Array {
  const text = (s: string) => Buffer.from(`${s}\n`, 'ascii');
  const ESC_INIT = Buffer.from([0x1b, 0x40]);
  const CENTER = Buffer.from([0x1b, 0x61, 0x01]);
  const LEFT = Buffer.from([0x1b, 0x61, 0x00]);
  const BOLD_ON = Buffer.from([0x1b, 0x45, 0x01]);
  const BOLD_OFF = Buffer.from([0x1b, 0x45, 0x00]);
  const FEED_4 = Buffer.from([0x1b, 0x64, 0x04]);
  const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
  // 16 bytes wide (128 dots) x 16 rows: a checker pattern that proves GS v 0 raster printing works.
  const widthBytes = 16;
  const rows = 16;
  const pattern = Buffer.alloc(widthBytes * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < widthBytes; x++) pattern[y * widthBytes + x] = (Math.floor(y / 4) + x) % 2 === 0 ? 0xf0 : 0x0f;
  const rasterHeader = Buffer.from([0x1d, 0x76, 0x30, 0x00, widthBytes, 0x00, rows, 0x00]);
  return Buffer.concat([
    ESC_INIT, CENTER, BOLD_ON, text('NightPOS print bridge'), BOLD_OFF,
    text(`printer: ${printerName}`), text(new Date().toISOString()), text('--------------------------------'),
    text('Raster test (checker pattern):'), rasterHeader, pattern, text(''), text('If you can read this the'), text('bridge and printer work.'), LEFT, FEED_4, CUT,
  ]);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function selfTest(config: BridgeConfig, printerName: string): Promise<number> {
  const target = config.printers.find((p) => p.name === printerName);
  if (!target) {
    console.error(`unknown printer "${printerName}". Configured: ${config.printers.map((p) => p.name).join(', ')}`);
    return 1;
  }
  try {
    await sendToPrinter(target, buildTestPage(printerName));
    console.log(`test page sent to "${printerName}"`);
    return 0;
  } catch (e) {
    console.error(`self-test failed: ${(e as Error).message}`);
    return 1;
  }
}

/** Queries a running bridge, used by `--status` to check the install without a browser. */
function queryStatus(config: BridgeConfig): Promise<number> {
  return new Promise((done) => {
    const port = config.port ?? DEFAULT_PORT;
    const req = httpRequest({ host: LOOPBACK, port, path: '/status', headers: { 'x-bridge-token': config.token }, timeout: 3000 }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { console.log(`${res.statusCode} ${out}`); done(res.statusCode === 200 ? 0 : 1); });
    });
    req.on('error', (e) => { console.error(`bridge not reachable on ${LOOPBACK}:${port} (${e.message})`); done(1); });
    req.end();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--gen-token')) {
    console.log(randomBytes(24).toString('hex'));
    return;
  }
  const configPath = resolve(argValue(args, '--config') ?? process.env.BRIDGE_CONFIG ?? 'bridge.config.json');
  let config: BridgeConfig;
  try {
    config = loadConfig(configPath);
    validateConfig(config);
  } catch (e) {
    console.error(`[bridge] ${(e as Error).message}`);
    process.exit(1);
  }
  if (args.includes('--self-test')) process.exit(await selfTest(config, argValue(args, '--self-test') ?? config.printers[0].name));
  if (args.includes('--status')) process.exit(await queryStatus(config));
  const bridge = createBridge(config);
  const addr = await bridge.listen();
  console.log(`[bridge] v${BRIDGE_VERSION} listening on http://${addr.address}:${addr.port} (loopback only); printers: ${config.printers.map((p) => p.name).join(', ')}`);
  console.log(`[bridge] allowed origins: ${config.allowedOrigins.join(', ')}`);
  const stop = () => void bridge.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[bridge] ${(e as Error).message}`);
    process.exit(1);
  });
}
