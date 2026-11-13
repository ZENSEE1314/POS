/**
 * Runs the suite through the production `pg` driver and the Postgres wire protocol.
 * No Postgres install needed: PGlite is exposed over a local socket and each test file gets a fresh database.
 * (Async spawn matters: the socket server lives in this process and must keep serving while tests run.)
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const FIRST_PORT = 54340;
const MAX_CONNECTIONS = 10;
// providers.test.ts has no database; everything else runs against the wire-protocol server.
const FILES = readdirSync('test').filter((f) => f.endsWith('.test.ts') && f !== 'providers.test.ts').map((f) => `test/${f}`);

let failed = false;
for (const [i, file] of FILES.entries()) {
  const port = FIRST_PORT + i;
  const lite = new PGlite();
  const server = new PGLiteSocketServer({ db: lite, port, host: '127.0.0.1', maxConnections: MAX_CONNECTIONS });
  await server.start();
  const child = spawn(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable` },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed = true;
  await server.stop();
  await lite.close();
}
process.exit(failed ? 1 : 0);
