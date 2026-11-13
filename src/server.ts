import { openDb } from './db.ts';
import { createAppWithMetrics } from './app.ts';
import { seed } from './seed.ts';
import { logEvent, startSelfHealLoop } from './ops.ts';

const PORT = Number(process.env.PORT ?? 3500);
const DATABASE_URL = process.env.DATABASE_URL ?? 'pglite:data/pglite';
const SELF_HEAL_EVERY_MS = Number(process.env.SELF_HEAL_EVERY_MS ?? 60_000);
const isMock = process.env.PAY_MODE === 'mock';

if (isMock) console.warn('[nightpos] PAY_MODE=mock: simulated payments. Never use with real customers.');
if (!DATABASE_URL.startsWith('postgres')) console.warn('[nightpos] using embedded PGlite (dev only). Set DATABASE_URL=postgres://... for production');
if (!process.env.PLATFORM_ADMIN_KEY) console.warn('[nightpos] PLATFORM_ADMIN_KEY not set: /platform/* is disabled');

const db = await openDb(DATABASE_URL);
if (isMock || process.env.SEED_DEMO === '1') await seed(db);

const { server } = createAppWithMetrics(db);
const stopHeal = startSelfHealLoop(db, SELF_HEAL_EVERY_MS);
server.listen(PORT, '0.0.0.0', () => void logEvent(db, 'info', 'server.start', `listening on :${PORT}`, { mode: isMock ? 'mock' : 'live' }));

const shutdown = () => {
  stopHeal();
  server.close(() => void db.close().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => void logEvent(db, 'error', 'unhandledRejection', String(e)));
