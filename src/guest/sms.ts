import { createHmac, randomUUID } from 'node:crypto';
import { fetchWithTimeout } from '../payments/http.ts';

/** Sends the one-time login code. `devCode` is only ever returned by the development sender. */
export interface SmsSender {
  readonly live: boolean;
  sendCode(phone: string, code: string): Promise<void>;
}

/** Development: nothing is sent; the API hands the code back so the flow can be tested. */
export class MockSms implements SmsSender {
  readonly live = false;

  async sendCode(): Promise<void> {}
}

export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;     // 短信签名, approved in the Aliyun console
  templateCode: string; // 验证码模板 with a ${code} variable
  endpoint?: string;
}

/** RFC 3986 encoding as Aliyun's RPC signature requires. */
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Aliyun SMS (dysmsapi SendSms, RPC signature v1, HMAC-SHA1). */
export class AliyunSms implements SmsSender {
  readonly live = true;
  private cfg: AliyunSmsConfig;

  constructor(cfg: AliyunSmsConfig) {
    this.cfg = cfg;
  }

  signedQuery(phone: string, code: string, timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce = randomUUID()): string {
    const params: Record<string, string> = {
      AccessKeyId: this.cfg.accessKeyId, Action: 'SendSms', Format: 'JSON', PhoneNumbers: phone, RegionId: 'cn-hangzhou',
      SignName: this.cfg.signName, SignatureMethod: 'HMAC-SHA1', SignatureNonce: nonce, SignatureVersion: '1.0',
      TemplateCode: this.cfg.templateCode, TemplateParam: JSON.stringify({ code }), Timestamp: timestamp, Version: '2017-05-25',
    };
    const canonical = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
    const signature = createHmac('sha1', `${this.cfg.accessKeySecret}&`).update(`GET&${pct('/')}&${pct(canonical)}`).digest('base64');
    return `Signature=${pct(signature)}&${canonical}`;
  }

  async sendCode(phone: string, code: string): Promise<void> {
    const res = await fetchWithTimeout(`${this.cfg.endpoint ?? 'https://dysmsapi.aliyuncs.com'}/?${this.signedQuery(phone, code)}`);
    const json = (await res.json().catch(() => ({}))) as any;
    if (json.Code !== 'OK') throw new Error(`sms not sent: ${json.Code ?? res.status} ${json.Message ?? ''}`);
  }
}

export function buildSms(env: NodeJS.ProcessEnv): SmsSender | undefined {
  if (env.PAY_MODE === 'mock') return new MockSms();
  const { ALIYUN_SMS_ACCESS_KEY_ID: id, ALIYUN_SMS_ACCESS_KEY_SECRET: secret, ALIYUN_SMS_SIGN_NAME: signName, ALIYUN_SMS_TEMPLATE_CODE: templateCode } = env;
  return id && secret && signName && templateCode ? new AliyunSms({ accessKeyId: id, accessKeySecret: secret, signName, templateCode }) : undefined;
}
