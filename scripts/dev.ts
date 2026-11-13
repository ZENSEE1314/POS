/** Local dev entry: simulated payments, demo company, platform key. Never used in production. */
process.env.PAY_MODE ??= 'mock';
process.env.SEED_DEMO ??= '1';
process.env.PLATFORM_ADMIN_KEY ??= 'dev-admin-key';
process.env.SIGNUP_OPEN ??= '1';
process.env.DATABASE_URL ??= 'pglite:data/dev-pglite';
await import('../src/server.ts');
