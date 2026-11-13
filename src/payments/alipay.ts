import { createSign, createVerify } from 'node:crypto';
import type { ChargeRequest, ChargeResult, GuestCharge, GuestChargeRequest, NotifyResult, PayProvider } from './types.ts';

export interface AlipayConfig {
  appId: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  gateway?: string;
}

/** Canonical sign string: params sorted by key, empty values and sign fields dropped. */
export function canonicalString(params: Record<string, string>, excludeSignType: boolean): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && !(excludeSignType && k === 'sign_type') && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function alipayTimestamp(d = new Date()): string {
  // Alipay expects Beijing time, yyyy-MM-dd HH:mm:ss.
  const bj = new Date(d.getTime() + 8 * 3600_000);
  return bj.toISOString().slice(0, 19).replace('T', ' ');
}

/** Alipay alipay.trade.precreate (merchant shows QR, customer scans). RSA2 signing. */
export class AlipayProvider implements PayProvider {
  readonly method = 'alipay' as const;
  private cfg: AlipayConfig;

  constructor(cfg: AlipayConfig) {
    this.cfg = cfg;
  }

  signParams(params: Record<string, string>): string {
    return createSign('RSA-SHA256').update(canonicalString(params, false)).sign(this.cfg.privateKeyPem, 'base64');
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: 'alipay.trade.precreate',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: req.notifyUrl,
      biz_content: JSON.stringify({
        out_trade_no: req.outTradeNo,
        total_amount: (req.amountFen / 100).toFixed(2),
        subject: req.subject,
      }),
    };
    params.sign = this.signParams(params);
    const res = await fetch(this.cfg.gateway ?? 'https://openapi.alipay.com/gateway.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as any;
    const r = json.alipay_trade_precreate_response;
    if (!r || r.code !== '10000' || !r.qr_code) throw new Error(`alipay precreate failed: ${r?.code} ${r?.sub_msg ?? r?.msg ?? res.status}`);
    return { qrContent: r.qr_code };
  }

  /** Mobile browser / Alipay app: the guest is sent to Alipay's WAP cashier, then back to returnUrl. */
  async createGuestCharge(req: GuestChargeRequest): Promise<GuestCharge> {
    const params = this.commonParams('alipay.trade.wap.pay', {
      notify_url: req.notifyUrl,
      return_url: req.returnUrl,
      biz_content: JSON.stringify({
        out_trade_no: req.outTradeNo,
        total_amount: (req.amountFen / 100).toFixed(2),
        subject: req.subject,
        product_code: 'QUICK_WAP_WAY',
      }),
    });
    params.sign = this.signParams(params);
    return { kind: 'redirect', url: `${this.gateway}?${new URLSearchParams(params).toString()}` };
  }

  /** Signed call to any gateway method (used by Alipay login: alipay.system.oauth.token, alipay.user.info.share). */
  async call(method: string, extra: Record<string, string>): Promise<any> {
    const params = this.commonParams(method, extra);
    params.sign = this.signParams(params);
    const res = await fetch(this.gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as any;
    const key = `${method.replace(/\./g, '_')}_response`;
    if (json.error_response) throw new Error(`alipay ${method} failed: ${json.error_response.code} ${json.error_response.sub_msg ?? json.error_response.msg ?? ''}`);
    return json[key];
  }

  get appId(): string {
    return this.cfg.appId;
  }

  private get gateway(): string {
    return this.cfg.gateway ?? 'https://openapi.alipay.com/gateway.do';
  }

  private commonParams(method: string, extra: Record<string, string>): Record<string, string> {
    return { app_id: this.cfg.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp: alipayTimestamp(), version: '1.0', ...extra };
  }

  /** Notify is form-urlencoded; sign covers every field except sign and sign_type. */
  parseNotify(_headers: Record<string, string | undefined>, rawBody: string): NotifyResult {
    const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;
    const ok = createVerify('RSA-SHA256').update(canonicalString(params, true)).verify(this.cfg.alipayPublicKeyPem, params.sign ?? '', 'base64');
    if (!ok) throw new Error('bad alipay signature');
    if (params.app_id !== this.cfg.appId) throw new Error('alipay app_id mismatch');
    return {
      outTradeNo: params.out_trade_no,
      amountFen: Math.round(parseFloat(params.total_amount) * 100),
      providerRef: params.trade_no,
      paid: params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED',
      eventId: params.notify_id,
      ackBody: 'success',
    };
  }
}
