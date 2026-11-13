export type OnlineMethod = 'wechat' | 'alipay';

export interface ChargeRequest {
  outTradeNo: string;
  amountFen: number;
  subject: string;
  notifyUrl: string;
}

export interface ChargeResult {
  /** QR payload the customer scans (code_url / qr_code). */
  qrContent: string;
  providerRef?: string;
}

export interface NotifyResult {
  outTradeNo: string;
  amountFen: number;
  providerRef: string;
  paid: boolean;
  /** Unique id for replay protection. */
  eventId: string;
  /** Exact body the provider expects in the HTTP response. */
  ackBody: string;
}

export interface GuestChargeRequest extends ChargeRequest {
  /** Where the provider sends the guest back after paying (Alipay WAP). */
  returnUrl: string;
  /** WeChat openid of the payer for the pay appid; enables in-WeChat JSAPI pay. */
  openId?: string;
}

/** How the guest's phone completes the payment. */
export type GuestCharge =
  | { kind: 'jsapi'; params: Record<string, string> }  // WeixinJSBridge getBrandWCPayRequest
  | { kind: 'redirect'; url: string }                 // Alipay WAP cashier page
  | { kind: 'qr'; qrContent: string }                 // fallback: scan with another phone / long-press
  | { kind: 'mock' };                                 // dev simulator

export interface PayProvider {
  readonly method: OnlineMethod;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /** Charge started by the guest on their own phone (customer app). */
  createGuestCharge(req: GuestChargeRequest): Promise<GuestCharge>;
  /** Throws if the signature is invalid. Never trust the body before this passes. */
  parseNotify(headers: Record<string, string | undefined>, rawBody: string): NotifyResult;
}
