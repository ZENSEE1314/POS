const DEFAULT_MOCK_SECRET = 'dev-mock-secret';

/**
 * Reasons this environment is unsafe to run as production, or [] when it is fine.
 * Mock payments, demo seed data and the well-known mock secret each let anyone forge payments or log in with published PINs.
 * NOTE: an unset MOCK_PAY_SECRET is only a problem together with PAY_MODE=mock (the secret is read nowhere else), so a live
 * deployment that never defined it still starts.
 */
export function productionViolations(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'production' || env.ALLOW_MOCK_IN_PROD === '1') return [];
  const problems: string[] = [];
  const isMock = env.PAY_MODE === 'mock';
  if (isMock) problems.push('PAY_MODE=mock');
  if (env.SEED_DEMO === '1') problems.push('SEED_DEMO=1 (demo company with published PINs)');
  if (env.MOCK_PAY_SECRET === DEFAULT_MOCK_SECRET) problems.push(`MOCK_PAY_SECRET is the default "${DEFAULT_MOCK_SECRET}"`);
  else if (isMock && !env.MOCK_PAY_SECRET) problems.push('MOCK_PAY_SECRET is unset while PAY_MODE=mock');
  return problems;
}

export function assertSafeForProduction(env: NodeJS.ProcessEnv): void {
  const problems = productionViolations(env);
  if (problems.length === 0) return;
  throw new Error(`refusing to start with NODE_ENV=production: ${problems.join('; ')}. Fix the configuration, or set ALLOW_MOCK_IN_PROD=1 to override (never with real customers).`);
}
