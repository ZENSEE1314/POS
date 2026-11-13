import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChargeRequest, ChargeResult, NotifyResult, OnlineMethod, PayProvider } from './types.ts';

/** Local simulator: no real money moves. Notify bodies are HMAC-signed so the webhook path is exercised for real. */
export class MockProvider implements PayProvider {
  readonly method: OnlineMethod;
  private secret: string;

  constructor(method: OnlineMethod, secret: string) {
    this.method = method;
    this.secret = secret;
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    return { qrContent: `mock-${this.method}://pay/${req.outTradeNo}?amount=${req.amountFen}`, providerRef: `mock_${req.outTradeNo}` };
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseNotify(headers: Record<string, string | undefined>, rawBody: string): NotifyResult {
    const given = Buffer.from(headers['x-mock-signature'] ?? '', 'hex');
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad mock signature');
    const body = JSON.parse(rawBody);
    return {
      outTradeNo: body.outTradeNo,
      amountFen: body.amountFen,
      providerRef: body.providerRef ?? `mock_${body.outTradeNo}`,
      paid: body.status === 'paid',
      eventId: body.eventId,
      ackBody: 'ok',
    };
  }
}
