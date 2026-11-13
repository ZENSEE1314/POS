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

export interface PayProvider {
  readonly method: OnlineMethod;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /** Throws if the signature is invalid. Never trust the body before this passes. */
  parseNotify(headers: Record<string, string | undefined>, rawBody: string): NotifyResult;
}
