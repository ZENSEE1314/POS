import type { Db } from '../db.ts';
import { DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { handleNotify } from '../payments.ts';
import type { Providers } from '../payments/index.ts';
import type { MockProvider } from '../payments/mock.ts';
import type { OnlineMethod } from '../payments/types.ts';
import { logEvent, RateLimiter } from '../ops.ts';
import { HtmlPage, Redirect } from '../responses.ts';
import {
  consumeAuthState, createAuthState, createLoginCode, customerIdFromToken, endSession, exchangeLoginCode, getCustomer, guestPhone, issuePasswordReset,
  linkPhone, loginWithPassword, loginWithPhone, newBrowserNonce, registerWithPassword, renameCustomer, requestOtp, resetPassword, safeReturnPath,
  signInWithIdentity, createHandoffCode, exchangeHandoffCode, startSession,
} from './accounts.ts';
import type { IdentityProviders, LoginProvider, MiniProgramLogin } from './identity.ts';
import { LOGIN_PROVIDERS } from './identity.ts';
import type { SmsSender } from './sms.ts';
import {
  accountAt, cancelGuestBooking, cancelGuestOrder, createGuestBooking, giftTables, guestOrder, markPaymentFailed, menu, paymentStatus, payFromWallet,
  placeOrder, placeShopOrder, reserveGuestPayment, tableBill, tableInfo, venueInfo,
} from './venue.ts';
import type { PayTarget } from './venue.ts';
import { acceptGuestOrder, fulfilGuestOrder, listGuestOrders, pendingGuestOrderCount, rejectGuestOrder, renewTableQr } from './staff.ts';
import { cancelRequest, createRequest, decideRequest, listGuestRequests, listPets, myRequests, removePet, savePet } from './requests.ts';
import {
  checkVoucher, claimReferral, listPrizes, listRewards, loyaltyAt, redeemReward, savePrize, saveReward, spinWheel, useVoucher,
} from './loyalty.ts';
import { listEvents, saveEvent, upcomingEvents } from './events.ts';
import { guestSettings, updateGuestSettings } from './settings.ts';
import { myPlaces, searchDirectory } from './directory.ts';
import { imageOf, removeImage, saveImage, staffTheme, updateTheme } from './theme.ts';
import { dismissQuestion, listFaqs, listQuestions, saveFaq } from './bot.ts';
import { getWechatOa, saveWechatOa } from './wechat-oa.ts';
import { FileBody } from '../responses.ts';
import { applyAsDistributor, distributionAt, joinDistributor, requestPayout } from '../distribution.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const OTP_PER_IP_PER_HOUR = 10;
// Per phone, whatever the IP: bounds SMS bombing of one number and code guessing to a few hundred tries a day at most.
const OTP_PER_PHONE_PER_HOUR = 5;
const OTP_PER_PHONE_PER_DAY = 10;
const CODE_TRIES_PER_PHONE_PER_HOUR = 10;
const CODE_TRIES_PER_PHONE_PER_DAY = 30;
const PHONE_LOGIN_PER_IP_PER_10MIN = 20;
// Guests at one venue often share its Wi-Fi, so one IP can be many real sign-ups.
const REGISTER_PER_IP_PER_HOUR = 30;
/** Platform-wide ceiling on SMS sent, so a pumping attack across many numbers cannot run up the SMS bill. */
const DEFAULT_SMS_PER_HOUR = 300;
const AUTH_COOKIE = 'np_gauth';
/** Mini program sign-ins per IP per 10 minutes: each app launch is one, and a venue's guests share its Wi-Fi. */
const MP_LOGIN_PER_IP_PER_10MIN = 60;
const MAX_MP_CODE = 128;
const AUTH_COOKIE_MAX_AGE_S = 15 * 60;

interface Ctx { db: Db; actor: Actor; token: string; params: string[]; body: any; query: URLSearchParams; ip: string; cookie: string }

const readCookie = (header: string, name: string): string | undefined =>
  header.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

export interface GuestDeps {
  db: Db;
  payProviders: Providers;
  identities: IdentityProviders;
  /** WeChat mini program sign-in; on when WECHAT_MP_APPID + WECHAT_MP_SECRET are set (or in mock mode). */
  miniProgram?: MiniProgramLogin;
  sms?: SmsSender;
  baseUrl: string;
  isMock: boolean;
  num: (v: unknown) => number;
  smsPerHour?: number;
  otpPerIpPerHour?: number;
  registerPerIpPerHour?: number;
  loginPerIpPer10Min?: number;
}

const loginProvider = (identities: IdentityProviders, name: string) => {
  const p = LOGIN_PROVIDERS.includes(name as LoginProvider) ? identities[name as LoginProvider] : undefined;
  if (!p) throw new DomainError(`${name} sign-in is not available yet`, 404);
  return p;
};

const MOCK_CONSENT_PAGE = (provider: string, state: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated ${provider} sign-in</title>
<style>body{font:16px system-ui,sans-serif;background:#120e24;color:#f1e9d2;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#1d1838;border:1px solid #f7d77455;border-radius:18px;padding:24px;max-width:340px;width:calc(100% - 32px)}
h1{font-size:20px;margin:0 0 8px}p{color:#b7aed4;font-size:14px}label{display:block;font-weight:700;margin:16px 0 4px}
input{width:100%;box-sizing:border-box;min-height:44px;padding:8px 12px;font:inherit;border-radius:12px;border:1px solid #f7d77455;background:#120e24;color:#fff3c4}
button{margin-top:16px;width:100%;min-height:44px;font:inherit;font-weight:800;border:0;border-radius:12px;background:#f7d774;color:#2a1a00}</style></head>
<body><form method="get" action="/api/guest/auth/${provider}/callback"><h1>Simulated ${provider} sign-in 模拟登录</h1>
<p>Development mode: no real ${provider} account is used. The same name always signs in to the same test account.</p>
<input type="hidden" name="state" value="${state}"><label for="n">Your name 你的名字</label>
<input id="n" name="code" required maxlength="40" value="Test Guest" autofocus><button type="submit">Allow 同意</button></form></body></html>`;

/** Customer app API (/api/guest/*) plus the staff endpoints that handle what guests send. */
export function registerGuestRoutes(route: RouteFn, deps: GuestDeps): void {
  const { payProviders, identities, miniProgram, sms, baseUrl, isMock, num } = deps;
  const mpLoginLimiter = new RateLimiter(MP_LOGIN_PER_IP_PER_10MIN, 10 * 60_000);
  const otpIpLimiter = new RateLimiter(deps.otpPerIpPerHour ?? OTP_PER_IP_PER_HOUR, HOUR_MS);
  const otpPhoneHourly = new RateLimiter(OTP_PER_PHONE_PER_HOUR, HOUR_MS);
  const otpPhoneDaily = new RateLimiter(OTP_PER_PHONE_PER_DAY, DAY_MS);
  const smsGlobal = new RateLimiter(deps.smsPerHour ?? DEFAULT_SMS_PER_HOUR, HOUR_MS);
  const codeTriesHourly = new RateLimiter(CODE_TRIES_PER_PHONE_PER_HOUR, HOUR_MS);
  const codeTriesDaily = new RateLimiter(CODE_TRIES_PER_PHONE_PER_DAY, DAY_MS);
  const phoneLoginLimiter = new RateLimiter(deps.loginPerIpPer10Min ?? PHONE_LOGIN_PER_IP_PER_10MIN, 10 * 60_000);
  const registerLimiter = new RateLimiter(deps.registerPerIpPerHour ?? REGISTER_PER_IP_PER_HOUR, HOUR_MS);
  const signedIn = (fn: (ctx: Ctx, customerId: number) => unknown) => async (ctx: Ctx) => fn(ctx, await customerIdFromToken(ctx.db, ctx.token));
  const callbackUrl = (p: string) => `${baseUrl}/api/guest/auth/${p}/callback`;
  const secureCookie = baseUrl.startsWith('https://') ? '; Secure' : '';
  const authCookie = (nonce: string) => `${AUTH_COOKIE}=${nonce}; Path=/api/guest; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_S}${secureCookie}`;
  /** Every code check counts against the phone, across all IPs; the per-IP limit alone is beaten by rotating addresses. */
  const allowCodeTry = (ip: string, rawPhone: unknown) => {
    const key = typeof rawPhone === 'string' ? guestPhone(rawPhone) : '';
    if (!phoneLoginLimiter.allow(ip) || !codeTriesHourly.allow(key) || !codeTriesDaily.allow(key)) throw new DomainError('too many attempts, try again later', 429);
  };

  // ---- public ----
  route('GET', '/api/guest/config', false, () => ({
    mock: isMock,
    login: { wechat: Boolean(identities.wechat), alipay: Boolean(identities.alipay), douyin: Boolean(identities.douyin), phone: Boolean(sms), password: true },
    payments: { wechat: Boolean(payProviders.wechat), alipay: Boolean(payProviders.alipay) },
    miniProgram: Boolean(miniProgram),
  }));
  route('GET', '/api/guest/directory', false, ({ db, query }) => searchDirectory(db, query.get('q') ?? '', query.get('city') ?? ''));
  route('GET', '/api/guest/me/places', false, signedIn(({ db }, id) => myPlaces(db, id)));
  route('GET', '/api/guest/images/:company/:kind', false, async ({ db, params }) => {
    const img = await imageOf(db, params[0], params[1]);
    return new FileBody(img.mime, img.bytes);
  });
  route('GET', '/api/guest/venue/:company', false, ({ db, params }) => venueInfo(db, params[0]));
  route('GET', '/api/guest/venue/:company/:store/menu', false, ({ db, params }) => menu(db, params[0], params[1]));
  route('GET', '/api/guest/table/:token', false, ({ db, params }) => tableInfo(db, params[0]));
  route('GET', '/api/guest/events/:company', false, ({ db, params }) => upcomingEvents(db, params[0]));

  // ---- sign-in with WeChat / Alipay / Douyin: start -> provider -> callback -> one-time code in the URL fragment ----
  route('GET', '/api/guest/auth/:provider/start', false, async ({ db, params, query }) => {
    const p = loginProvider(identities, params[0]);
    const nonce = newBrowserNonce();
    const state = await createAuthState(db, p.name, safeReturnPath(query.get('return')), nonce);
    return new Redirect(p.authorizeUrl(state, callbackUrl(p.name)), { 'Set-Cookie': authCookie(nonce) });
  });
  if (isMock) {
    route('GET', '/api/guest/auth/:provider/mock-consent', false, ({ params, query }) => {
      const p = loginProvider(identities, params[0]);
      const state = query.get('state') ?? '';
      if (!/^[0-9a-f]{48}$/.test(state)) throw new DomainError('bad state', 400);
      return new HtmlPage(MOCK_CONSENT_PAGE(p.name, state));
    });
  }
  route('GET', '/api/guest/auth/:provider/callback', false, async ({ db, params, query, ip, cookie }) => {
    let returnTo = '/g/';
    try {
      const p = loginProvider(identities, params[0]);
      const nonce = readCookie(cookie, AUTH_COOKIE);
      returnTo = await consumeAuthState(db, query.get('state') ?? '', p.name, nonce);
      const code = query.get(p.codeParam);
      // The guest pressed "deny" on the provider's screen.
      if (!code) return new Redirect(`${returnTo}#loginError=cancelled`);
      const profile = await p.exchange(code);
      const customerId = await signInWithIdentity(db, p.name, profile);
      return new Redirect(`${returnTo}#login=${await createLoginCode(db, customerId, nonce!)}`);
    } catch (e) {
      if (!(e instanceof DomainError)) await logEvent(db, 'warn', 'guest.login_failed', `${params[0]} sign-in failed: ${(e as Error).message}`, { ip });
      return new Redirect(`${returnTo}#loginError=${encodeURIComponent(e instanceof DomainError ? e.message : 'provider')}`);
    }
  });
  route('POST', '/api/guest/session', false, ({ db, body, cookie }) => exchangeLoginCode(db, body.code, readCookie(cookie, AUTH_COOKIE)));

  // ---- WeChat mini program: wx.login code -> session; then a one-time code hands the session to its web-view ----
  route('POST', '/api/guest/mp/login', false, async ({ db, body, ip }) => {
    if (!miniProgram) throw new DomainError('mini program sign-in is not available yet', 404);
    if (!mpLoginLimiter.allow(ip)) throw new DomainError('too many attempts, try again later', 429);
    if (typeof body.code !== 'string' || !body.code || body.code.length > MAX_MP_CODE) throw new DomainError('code required', 422);
    let profile;
    try {
      profile = await miniProgram.login(body.code);
    } catch (e) {
      await logEvent(db, 'warn', 'guest.login_failed', `mini program sign-in failed: ${(e as Error).message}`, { ip });
      throw new DomainError('WeChat sign-in failed, please try again', 502);
    }
    return startSession(db, await signInWithIdentity(db, 'wechat', profile));
  });
  route('POST', '/api/guest/mp/handoff', false, signedIn(({ db }, id) => createHandoffCode(db, id)));
  route('POST', '/api/guest/mp/session', false, ({ db, body }) => exchangeHandoffCode(db, body.code));

  // ---- phone + SMS code ----
  route('POST', '/api/guest/otp', false, async ({ db, body, ip }) => {
    if (!sms) throw new DomainError('phone sign-in is not available yet', 404);
    const phone = guestPhone(body.phone);
    if (!otpIpLimiter.allow(ip) || !otpPhoneHourly.allow(phone) || !otpPhoneDaily.allow(phone)) throw new DomainError('too many codes requested, try again later', 429);
    if (!smsGlobal.allow('all')) {
      await logEvent(db, 'error', 'guest.sms_ceiling', 'hourly SMS ceiling reached: possible SMS pumping', { ip });
      throw new DomainError('codes are temporarily unavailable, try again later', 429);
    }
    return requestOtp(db, sms, phone);
  });
  route('POST', '/api/guest/login/phone', false, ({ db, body, ip }) => {
    if (!sms) throw new DomainError('phone sign-in is not available yet', 404);
    allowCodeTry(ip, body.phone);
    return loginWithPhone(db, body.phone, body.code);
  });

  // ---- phone + password (no SMS) ----
  route('POST', '/api/guest/register', false, ({ db, body, ip }) => {
    if (!registerLimiter.allow(ip)) throw new DomainError('too many attempts, try again later', 429);
    return registerWithPassword(db, body.phone, body.password, body.name);
  });
  // Same per-phone guess budget as SMS codes, so rotating IPs does not help guess one account's password.
  route('POST', '/api/guest/login/password', false, ({ db, body, ip }) => {
    allowCodeTry(ip, body.phone);
    return loginWithPassword(db, body.phone, body.password);
  });
  route('POST', '/api/guest/password/reset', false, ({ db, body, ip }) => {
    allowCodeTry(ip, body.phone);
    return resetPassword(db, Boolean(sms), body.phone, body.code, body.password);
  });

  // ---- signed-in guest ----
  route('GET', '/api/guest/me', false, signedIn(({ db }, id) => getCustomer(db, id)));
  route('PATCH', '/api/guest/me', false, signedIn(({ db, body }, id) => renameCustomer(db, id, body.name)));
  route('POST', '/api/guest/logout', false, async ({ db, token }) => {
    await endSession(db, token);
    return { ok: true };
  });
  route('POST', '/api/guest/me/phone', false, signedIn(({ db, body, ip, token }, id) => {
    allowCodeTry(ip, body.phone);
    return linkPhone(db, id, token, body.phone, body.code);
  }));
  route('GET', '/api/guest/account/:company', false, signedIn(({ db, params }, id) => accountAt(db, id, params[0])));

  route('POST', '/api/guest/orders', false, signedIn(({ db, body }, id) => placeOrder(db, id, body)));
  route('POST', '/api/guest/shop-orders', false, signedIn(({ db, body }, id) => placeShopOrder(db, id, body)));
  route('GET', '/api/guest/orders/:id', false, signedIn(({ db, params }, id) => guestOrder(db, id, num(params[0]))));
  route('POST', '/api/guest/orders/:id/cancel', false, signedIn(async ({ db, params }, id) => {
    await cancelGuestOrder(db, id, num(params[0]));
    return { ok: true };
  }));

  route('GET', '/api/guest/table/:token/bill', false, signedIn(({ db, params }) => tableBill(db, params[0])));
  const guestPay = async (db: Db, customerId: number, target: PayTarget, body: any) => {
    const amount = body.amount === undefined || body.amount === null ? undefined : num(body.amount);
    if (body.method === 'member') return { kind: 'done', ...(await payFromWallet(db, customerId, target, amount)) };
    if (body.method !== 'wechat' && body.method !== 'alipay') throw new DomainError('method must be wechat, alipay or member', 422);
    const provider = payProviders[body.method as OnlineMethod];
    if (!provider) throw new DomainError(`${body.method} payments are not available yet`, 422);
    // Inside the mini program WeChat Pay runs under the mini program's appid, with the openid it signed in with.
    const inMiniProgram = body.channel === 'miniprogram';
    if (inMiniProgram && (provider.method !== 'wechat' || !miniProgram)) throw new DomainError('pay with WeChat inside the mini program', 422);
    const r = await reserveGuestPayment(db, customerId, target, provider.method, amount);
    // JSAPI needs the payer's openid for the very appid WeChat Pay is bound to.
    const payAppId = inMiniProgram ? miniProgram!.appId : (provider as { appId?: string }).appId;
    const openId = provider.method === 'wechat' && payAppId
      ? (await db.one("SELECT subject FROM customer_identities WHERE customer_id = ? AND provider = 'wechat' AND app_id = ?", [customerId, payAppId]))?.subject
      : undefined;
    try {
      const charge = await provider.createGuestCharge({
        outTradeNo: r.outTradeNo, amountFen: r.pay, subject: `${r.storeName} #${r.billId}`, notifyUrl: `${baseUrl}/webhooks/${provider.method}`,
        returnUrl: `${baseUrl}${safeReturnPath(body.returnPath)}?paid=${r.outTradeNo}`, openId, appId: inMiniProgram ? payAppId : undefined,
      });
      // Without the openid WeChat would fall back to a QR code, which a guest cannot scan with the phone showing it.
      if (inMiniProgram && charge.kind === 'qr') throw new Error('no WeChat openid for the mini program, please reopen it');
      return { ...charge, outTradeNo: r.outTradeNo, amount: r.pay };
    } catch (e) {
      await markPaymentFailed(db, r.paymentId);
      throw new DomainError(`payment provider error: ${(e as Error).message}`, 502);
    }
  };
  route('POST', '/api/guest/table/:token/pay', false, signedIn(({ db, params, body }, customerId) => guestPay(db, customerId, params[0], body)));
  route('POST', '/api/guest/orders/:id/pay', false, signedIn(({ db, params, body }, customerId) => guestPay(db, customerId, { orderId: num(params[0]) }, body)));
  route('GET', '/api/guest/payments/:outTradeNo', false, signedIn(({ db, params }, id) => paymentStatus(db, id, params[0])));
  if (isMock) {
    // Development: plays the provider's signed callback for the guest's own pending payment.
    route('POST', '/api/guest/payments/:outTradeNo/mock-pay', false, signedIn(async ({ db, params }, customerId) => {
      const p = await db.one("SELECT * FROM payments WHERE out_trade_no = ? AND customer_id = ? AND status = 'pending'", [params[0], customerId]);
      if (!p) throw new DomainError('payment not found', 404);
      const mock = payProviders[p.method as OnlineMethod] as MockProvider;
      const raw = JSON.stringify({ eventId: `evt_${Date.now()}_${Math.random()}`, outTradeNo: p.out_trade_no, amountFen: p.amount, status: 'paid' });
      await handleNotify(db, p.method, mock, { 'x-mock-signature': mock.sign(raw) }, raw);
      return paymentStatus(db, customerId, params[0]);
    }));
  }

  route('POST', '/api/guest/bookings', false, signedIn(({ db, body }, id) => createGuestBooking(db, id, body)));
  route('POST', '/api/guest/bookings/:id/cancel', false, signedIn(async ({ db, params }, id) => {
    await cancelGuestBooking(db, id, num(params[0]));
    return { ok: true };
  }));

  route('GET', '/api/guest/table/:token/tables', false, signedIn(({ db, params }) => giftTables(db, params[0])));

  route('POST', '/api/guest/requests', false, signedIn(({ db, body }, id) => createRequest(db, id, body)));
  route('GET', '/api/guest/requests/:company', false, signedIn(({ db, params }, id) => myRequests(db, id, params[0])));
  route('POST', '/api/guest/requests/:id/cancel', false, signedIn(async ({ db, params }, id) => {
    await cancelRequest(db, id, num(params[0]));
    return { ok: true };
  }));

  route('GET', '/api/guest/loyalty/:company', false, signedIn(({ db, params }, id) => loyaltyAt(db, id, params[0])));
  route('POST', '/api/guest/loyalty/:company/redeem', false, signedIn(({ db, params, body }, id) => redeemReward(db, id, params[0], body.rewardId)));
  route('POST', '/api/guest/loyalty/:company/spin', false, signedIn(({ db, params }, id) => spinWheel(db, id, params[0])));
  route('POST', '/api/guest/referral', false, signedIn(({ db, body }, id) => claimReferral(db, id, body.company, body.code)));

  route('GET', '/api/guest/distribution/:company', false, signedIn(({ db, params }, id) => distributionAt(db, id, params[0])));
  route('POST', '/api/guest/distribution/:company/apply', false, signedIn(({ db, params }, id) => applyAsDistributor(db, id, params[0])));
  route('POST', '/api/guest/distribution/:company/join', false, signedIn(({ db, params, body }, id) => joinDistributor(db, id, params[0], body.code)));
  route('POST', '/api/guest/distribution/:company/payout', false, signedIn(({ db, params, body }, id) => requestPayout(db, id, params[0], body)));

  route('GET', '/api/guest/pets', false, signedIn(({ db }, id) => listPets(db, id)));
  route('POST', '/api/guest/pets', false, signedIn(({ db, body }, id) => savePet(db, id, null, body)));
  route('PATCH', '/api/guest/pets/:id', false, signedIn(({ db, params, body }, id) => savePet(db, id, num(params[0]), body)));
  route('POST', '/api/guest/pets/:id/remove', false, signedIn(async ({ db, params }, id) => {
    await removePet(db, id, num(params[0]));
    return { ok: true };
  }));

  // ---- staff: guest requests, vouchers, customer app settings, rewards, wheel prizes, events ----
  route('GET', '/api/guest-requests', true, ({ db, actor, query }) => listGuestRequests(db, actor, query.get('status') ?? 'pending'));
  for (const outcome of ['done', 'declined'] as const) {
    route('POST', `/api/guest-requests/:id/${outcome === 'done' ? 'done' : 'decline'}`, true, async ({ db, actor, params, body }) => {
      await decideRequest(db, actor, num(params[0]), outcome, body.reply);
      return { ok: true };
    });
  }
  route('GET', '/api/vouchers/:code', true, ({ db, actor, params }) => checkVoucher(db, actor, params[0]));
  route('POST', '/api/vouchers/:code/use', true, ({ db, actor, params }) => useVoucher(db, actor, params[0]));
  route('POST', '/api/guest-password-resets', true, ({ db, actor, body }) => issuePasswordReset(db, actor, body.phone));
  route('GET', '/api/guest-theme', true, ({ db, actor }) => staffTheme(db, actor));
  route('PATCH', '/api/guest-theme', true, ({ db, actor, body }) => updateTheme(db, actor, body));
  route('PUT', '/api/guest-theme/images/:kind', true, ({ db, actor, params, body }) => saveImage(db, actor, params[0], body.dataUrl));
  route('DELETE', '/api/guest-theme/images/:kind', true, ({ db, actor, params }) => removeImage(db, actor, params[0]));
  route('GET', '/api/guest-settings', true, ({ db, actor }) => guestSettings(db, actor.tenantId));
  route('PATCH', '/api/guest-settings', true, ({ db, actor, body }) => updateGuestSettings(db, actor, body));
  route('GET', '/api/loyalty-rewards', true, ({ db, actor }) => listRewards(db, actor));
  route('POST', '/api/loyalty-rewards', true, ({ db, actor, body }) => saveReward(db, actor, null, body));
  route('PATCH', '/api/loyalty-rewards/:id', true, ({ db, actor, params, body }) => saveReward(db, actor, num(params[0]), body));
  route('GET', '/api/spin-prizes', true, ({ db, actor }) => listPrizes(db, actor));
  route('POST', '/api/spin-prizes', true, ({ db, actor, body }) => savePrize(db, actor, null, body));
  route('PATCH', '/api/spin-prizes/:id', true, ({ db, actor, params, body }) => savePrize(db, actor, num(params[0]), body));
  route('GET', '/api/bot/faqs', true, ({ db, actor }) => listFaqs(db, actor));
  route('POST', '/api/bot/faqs', true, ({ db, actor, body }) => saveFaq(db, actor, null, body));
  route('PATCH', '/api/bot/faqs/:id', true, ({ db, actor, params, body }) => saveFaq(db, actor, num(params[0]), body));
  route('GET', '/api/bot/questions', true, ({ db, actor }) => listQuestions(db, actor));
  route('POST', '/api/bot/questions/:id/dismiss', true, async ({ db, actor, params }) => {
    await dismissQuestion(db, actor, num(params[0]));
    return { ok: true };
  });
  route('GET', '/api/bot/wechat', true, ({ db, actor }) => getWechatOa(db, actor, baseUrl));
  route('PUT', '/api/bot/wechat', true, async ({ db, actor, body }) => {
    await saveWechatOa(db, actor, body);
    return { ok: true };
  });
  route('GET', '/api/venue-events', true, ({ db, actor }) => listEvents(db, actor));
  route('POST', '/api/venue-events', true, ({ db, actor, body }) => saveEvent(db, actor, null, body));
  route('PATCH', '/api/venue-events/:id', true, ({ db, actor, params, body }) => saveEvent(db, actor, num(params[0]), body));

  // ---- staff: handle guest orders, renew table QR codes ----
  route('GET', '/api/guest-orders', true, ({ db, actor, query }) => listGuestOrders(db, actor, query.get('status') ?? 'pending'));
  route('GET', '/api/guest-orders/count', true, ({ db, actor }) => pendingGuestOrderCount(db, actor));
  route('POST', '/api/guest-orders/:id/accept', true, ({ db, actor, params, body }) =>
    acceptGuestOrder(db, actor, num(params[0]), body.repId === undefined || body.repId === null || body.repId === '' ? undefined : num(body.repId)));
  route('POST', '/api/guest-orders/:id/fulfil', true, async ({ db, actor, params, body }) => {
    await fulfilGuestOrder(db, actor, num(params[0]), body.step);
    return { ok: true };
  });
  route('POST', '/api/guest-orders/:id/reject', true, async ({ db, actor, params, body }) => {
    await rejectGuestOrder(db, actor, num(params[0]), body.reason);
    return { ok: true };
  });
  route('POST', '/api/tables/:id/qr', true, ({ db, actor, params }) => renewTableQr(db, actor, num(params[0])));
}
