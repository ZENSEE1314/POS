import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto';
import type { ChargeRequest, ChargeResult, NotifyResult, PayProvider } from './types.ts';

export interface WechatConfig {
  appId: string;
  mchId: string;
  serialNo: string;
  apiV3Key: string;           // 32 bytes
  privateKeyPem: string;      // merchant API private key
  platformPublicKeyPem: string; // WeChat platform certificate public key, for verifying callbacks
  baseUrl?: string;
}

const NATIVE_PATH = '/v3/pay/transactions/native';
const AUTH_SCHEME = 'WECHATPAY2-SHA256-RSA2048';

/** WeChat Pay APIv3 Native (scan-to-pay) payments. */
export class WechatProvider implements PayProvider {
  readonly method = 'wechat' as const;
  private cfg: WechatConfig;

  constructor(cfg: WechatConfig) {
    this.cfg = cfg;
  }

  /** Authorization header: signature over METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY\n. */
  buildAuthorization(method: string, path: string, body: string, timestamp = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex')): string {
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(this.cfg.privateKeyPem, 'base64');
    return `${AUTH_SCHEME} mchid="${this.cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.cfg.serialNo}"`;
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const body = JSON.stringify({
      appid: this.cfg.appId,
      mchid: this.cfg.mchId,
      description: req.subject,
      out_trade_no: req.outTradeNo,
      notify_url: req.notifyUrl,
      amount: { total: req.amountFen, currency: 'CNY' },
    });
    const res = await fetch((this.cfg.baseUrl ?? 'https://api.mch.weixin.qq.com') + NATIVE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.buildAuthorization('POST', NATIVE_PATH, body),
      },
      body,
    });
    const json = (await res.json()) as any;
    if (!res.ok || !json.code_url) throw new Error(`wechat native order failed: ${json.code ?? res.status} ${json.message ?? ''}`);
    return { qrContent: json.code_url };
  }

  parseNotify(headers: Record<string, string | undefined>, rawBody: string): NotifyResult {
    const timestamp = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const signature = headers['wechatpay-signature'];
    if (!timestamp || !nonce || !signature) throw new Error('missing wechatpay signature headers');
    const ok = createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${rawBody}\n`).verify(this.cfg.platformPublicKeyPem, signature, 'base64');
    if (!ok) throw new Error('bad wechatpay signature');

    const envelope = JSON.parse(rawBody);
    const plain = decryptResource(this.cfg.apiV3Key, envelope.resource);
    return {
      outTradeNo: plain.out_trade_no,
      amountFen: plain.amount.total,
      providerRef: plain.transaction_id,
      paid: plain.trade_state === 'SUCCESS',
      eventId: envelope.id,
      ackBody: JSON.stringify({ code: 'SUCCESS', message: 'OK' }),
    };
  }
}

/** AES-256-GCM; the last 16 bytes of the ciphertext are the auth tag. */
export function decryptResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }): any {
  const data = Buffer.from(resource.ciphertext, 'base64');
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  decipher.setAAD(Buffer.from(resource.associated_data ?? ''));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
