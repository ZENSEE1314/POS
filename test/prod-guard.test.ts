import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeForProduction, productionViolations } from '../src/prod-guard.ts';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

test('mock payments are allowed outside production', () => {
  assert.deepEqual(productionViolations(env({ PAY_MODE: 'mock', SEED_DEMO: '1' })), []);
});

test('production refuses PAY_MODE=mock', () => {
  assert.throws(() => assertSafeForProduction(env({ NODE_ENV: 'production', PAY_MODE: 'mock', MOCK_PAY_SECRET: 'x' })), /PAY_MODE=mock/);
});

test('production refuses SEED_DEMO=1', () => {
  assert.throws(() => assertSafeForProduction(env({ NODE_ENV: 'production', SEED_DEMO: '1' })), /SEED_DEMO/);
});

test('production refuses the default mock secret', () => {
  assert.throws(() => assertSafeForProduction(env({ NODE_ENV: 'production', MOCK_PAY_SECRET: 'dev-mock-secret' })), /MOCK_PAY_SECRET/);
});

test('production refuses mock mode with no secret set', () => {
  assert.equal(productionViolations(env({ NODE_ENV: 'production', PAY_MODE: 'mock' })).length, 2);
});

test('production starts when live and nothing mock is configured', () => {
  assert.deepEqual(productionViolations(env({ NODE_ENV: 'production', PLATFORM_ADMIN_KEY: 'k' })), []);
});

test('ALLOW_MOCK_IN_PROD=1 overrides the guard', () => {
  assert.deepEqual(productionViolations(env({ NODE_ENV: 'production', PAY_MODE: 'mock', SEED_DEMO: '1', ALLOW_MOCK_IN_PROD: '1' })), []);
});

test('seed refuses to plant the demo company in production', async () => {
  const db = await openDb();
  await assert.rejects(seed(db, env({ NODE_ENV: 'production' })), /refusing to start/);
  await db.close();
});
