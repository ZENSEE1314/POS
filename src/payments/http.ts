/** How long an unpaid online payment stays reserved; also sent to the provider so it closes the order at the same moment. */
export const PENDING_HOLD_MS = 15 * 60 * 1000;

/** Upper bound for any outbound provider call, so a hung provider cannot pin a request (and its pending payment) forever. */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/** fetch with a hard timeout; a timeout surfaces as a plain Error that says so. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error(`request timed out after ${OUTBOUND_TIMEOUT_MS / 1000}s`);
    throw e;
  }
}

/** WeChat time_expire: RFC3339 with the +08:00 offset, e.g. 2026-01-02T15:04:05+08:00. */
export function wechatTimeExpire(nowMs = Date.now()): string {
  const beijing = new Date(nowMs + PENDING_HOLD_MS + 8 * 3600_000);
  return `${beijing.toISOString().slice(0, 19)}+08:00`;
}

/** Alipay timeout_express: relative to when Alipay receives the order, e.g. "15m". */
export function alipayTimeoutExpress(): string {
  return `${PENDING_HOLD_MS / 60_000}m`;
}
