import { readFileSync } from 'node:fs';
import { AlipayProvider } from './alipay.ts';
import { MockProvider } from './mock.ts';
import type { OnlineMethod, PayProvider } from './types.ts';
import { WechatProvider } from './wechat.ts';

export type Providers = Partial<Record<OnlineMethod, PayProvider>>;

/** A PEM can be given inline (Railway variable, with \n escapes) or as a file path. */
function pem(env: NodeJS.ProcessEnv, inlineKey: string, pathKey: string): string | undefined {
  const inline = env[inlineKey];
  if (inline) return inline.replace(/\\n/g, '\n');
  const path = env[pathKey];
  return path ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Providers are enabled individually: a method with no credentials is simply unavailable (cash, wallet and
 * credit still work). PAY_MODE=mock swaps in local simulators and must never be used with real customers.
 */
export function buildProviders(env: NodeJS.ProcessEnv): Providers {
  if (env.PAY_MODE === 'mock') {
    const secret = env.MOCK_PAY_SECRET ?? 'dev-mock-secret';
    return { wechat: new MockProvider('wechat', secret), alipay: new MockProvider('alipay', secret) };
  }
  const out: Providers = {};

  const wxKey = pem(env, 'WECHAT_PRIVATE_KEY', 'WECHAT_PRIVATE_KEY_PATH');
  const wxPlatform = pem(env, 'WECHAT_PLATFORM_PUBKEY', 'WECHAT_PLATFORM_PUBKEY_PATH');
  if (env.WECHAT_APPID && env.WECHAT_MCHID && env.WECHAT_SERIAL_NO && env.WECHAT_API_V3_KEY && wxKey && wxPlatform) {
    out.wechat = new WechatProvider({
      appId: env.WECHAT_APPID, mchId: env.WECHAT_MCHID, serialNo: env.WECHAT_SERIAL_NO, apiV3Key: env.WECHAT_API_V3_KEY,
      privateKeyPem: wxKey, platformPublicKeyPem: wxPlatform,
    });
  }

  const aliKey = pem(env, 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PRIVATE_KEY_PATH');
  const aliPub = pem(env, 'ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_PATH');
  if (env.ALIPAY_APP_ID && aliKey && aliPub) {
    out.alipay = new AlipayProvider({ appId: env.ALIPAY_APP_ID, privateKeyPem: aliKey, alipayPublicKeyPem: aliPub, gateway: env.ALIPAY_GATEWAY });
  }
  return out;
}
