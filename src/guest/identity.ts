import { createHash } from 'node:crypto';
import { AlipayProvider } from '../payments/alipay.ts';
import { fetchWithTimeout } from '../payments/http.ts';

export type LoginProvider = 'wechat' | 'alipay' | 'douyin';
export const LOGIN_PROVIDERS: LoginProvider[] = ['wechat', 'alipay', 'douyin'];

/** Who the provider says signed in. `subject` is stable per (provider, appId). */
export interface IdentityProfile {
  subject: string;
  appId: string;
  unionId?: string;
  displayName: string;
}

export interface IdentityProvider {
  readonly name: LoginProvider;
  /** Name of the query parameter the provider puts the one-time code in on the callback. */
  readonly codeParam: string;
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string): Promise<IdentityProfile>;
}

const MAX_NAME = 40;
const cleanName = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '');

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`unexpected response ${res.status}`);
  }
}

/**
 * WeChat Official Account (公众号) web authorisation. Works inside the WeChat app only; the account must be a verified
 * 服务号 and the callback domain must be set as its 网页授权域名 (needs an ICP-filed domain).
 */
export class WechatLogin implements IdentityProvider {
  readonly name = 'wechat' as const;
  readonly codeParam = 'code';
  private appId: string;
  private secret: string;

  constructor(appId: string, secret: string) {
    this.appId = appId;
    this.secret = secret;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ appid: this.appId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_userinfo', state });
    return `https://open.weixin.qq.com/connect/oauth2/authorize?${q}#wechat_redirect`;
  }

  async exchange(code: string): Promise<IdentityProfile> {
    const q = new URLSearchParams({ appid: this.appId, secret: this.secret, code, grant_type: 'authorization_code' });
    const tok = await getJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${q}`);
    if (tok.errcode || !tok.openid) throw new Error(`wechat token: ${tok.errcode ?? 'no openid'} ${tok.errmsg ?? ''}`);
    let displayName = '';
    try {
      const info = await getJson(`https://api.weixin.qq.com/sns/userinfo?${new URLSearchParams({ access_token: tok.access_token, openid: tok.openid, lang: 'zh_CN' })}`);
      displayName = cleanName(info.nickname);
    } catch { /* the nickname is cosmetic; the openid is what signs the guest in */ }
    return { subject: tok.openid, appId: this.appId, unionId: tok.unionid || undefined, displayName };
  }
}

/** Alipay web authorisation (auth_user); the app needs the 获取会员信息 product for the nickname. */
export class AlipayLogin implements IdentityProvider {
  readonly name = 'alipay' as const;
  readonly codeParam = 'auth_code';
  private alipay: AlipayProvider;

  constructor(alipay: AlipayProvider) {
    this.alipay = alipay;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ app_id: this.alipay.appId, scope: 'auth_user', redirect_uri: redirectUri, state });
    return `https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?${q}`;
  }

  async exchange(code: string): Promise<IdentityProfile> {
    const tok = await this.alipay.call('alipay.system.oauth.token', { grant_type: 'authorization_code', code });
    // Newer apps get open_id instead of user_id; either is stable for this app.
    const subject = tok?.open_id ?? tok?.user_id;
    if (!subject) throw new Error('alipay token: no user id');
    let displayName = '';
    try {
      const info = await this.alipay.call('alipay.user.info.share', { auth_token: tok.access_token });
      displayName = cleanName(info?.nick_name);
    } catch { /* nickname needs an extra permission; signing in does not */ }
    return { subject: String(subject), appId: this.alipay.appId, displayName };
  }
}

/** Douyin Open Platform web authorisation (user_info scope). */
export class DouyinLogin implements IdentityProvider {
  readonly name = 'douyin' as const;
  readonly codeParam = 'code';
  private clientKey: string;
  private clientSecret: string;

  constructor(clientKey: string, clientSecret: string) {
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_key: this.clientKey, response_type: 'code', scope: 'user_info', redirect_uri: redirectUri, state });
    return `https://open.douyin.com/platform/oauth/connect/?${q}`;
  }

  async exchange(code: string): Promise<IdentityProfile> {
    const tok = await getJson('https://open.douyin.com/oauth/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_key: this.clientKey, client_secret: this.clientSecret, code, grant_type: 'authorization_code' }),
    });
    const d = tok.data ?? {};
    if (d.error_code || !d.open_id) throw new Error(`douyin token: ${d.error_code ?? 'no open_id'} ${d.description ?? ''}`);
    let displayName = '';
    try {
      const info = await getJson('https://open.douyin.com/oauth/userinfo/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: d.access_token, open_id: d.open_id }).toString(),
      });
      displayName = cleanName(info.data?.nickname);
    } catch { /* cosmetic */ }
    return { subject: d.open_id, appId: this.clientKey, unionId: d.union_id || undefined, displayName };
  }
}

/**
 * Development stand-in: the "provider" is a consent page on this server where you type a name. The same name always
 * maps to the same account, so several test guests can be simulated. Only installed with PAY_MODE=mock.
 */
export class MockLogin implements IdentityProvider {
  readonly name: LoginProvider;
  readonly codeParam = 'code';

  constructor(name: LoginProvider) {
    this.name = name;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    return `/api/guest/auth/${this.name}/mock-consent?${new URLSearchParams({ state, redirect_uri: redirectUri })}`;
  }

  async exchange(code: string): Promise<IdentityProfile> {
    const name = cleanName(code) || 'Guest';
    return { subject: `mock-${createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 24)}`, appId: `mock-${this.name}`, displayName: name };
  }
}

export type IdentityProviders = Partial<Record<LoginProvider, IdentityProvider>>;

/** Each login is enabled only when its credentials exist, like payments. */
export function buildIdentityProviders(env: NodeJS.ProcessEnv, alipay?: AlipayProvider): IdentityProviders {
  if (env.PAY_MODE === 'mock') return { wechat: new MockLogin('wechat'), alipay: new MockLogin('alipay'), douyin: new MockLogin('douyin') };
  const out: IdentityProviders = {};
  // The Official Account is usually the same appid WeChat Pay is bound to, which is what lets JSAPI pay reuse the openid.
  const wxAppId = env.WECHAT_OA_APPID ?? env.WECHAT_APPID;
  if (wxAppId && env.WECHAT_OA_SECRET) out.wechat = new WechatLogin(wxAppId, env.WECHAT_OA_SECRET);
  if (alipay && env.ALIPAY_LOGIN !== '0') out.alipay = new AlipayLogin(alipay);
  if (env.DOUYIN_CLIENT_KEY && env.DOUYIN_CLIENT_SECRET) out.douyin = new DouyinLogin(env.DOUYIN_CLIENT_KEY, env.DOUYIN_CLIENT_SECRET);
  return out;
}
