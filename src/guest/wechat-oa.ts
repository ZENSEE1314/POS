// WeChat Official Account (公众号) auto-reply. Each company links its own account: in the WeChat admin console it sets the
// server URL to /webhooks/wechat-oa/<company> and the same Token as here (plaintext message mode). WeChat then posts each
// follower message to us and shows our reply in the chat, so the bot answers on WeChat exactly as in the app.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import { tenantByCode } from './venue.ts';
import { botAnswer, botEnabled, handoffText, recordQuestion, welcomeText } from './bot.ts';

// WeChat's own rule for the console's Token field.
const TOKEN_PATTERN = /^[A-Za-z0-9]{3,32}$/;
const APP_ID_PATTERN = /^wx[0-9a-f]{16}$/i;
/** WeChat drops a passive reply longer than this many bytes. */
const MAX_REPLY_BYTES = 2000;

export interface OaResponse { status: number; body: string; type: string }

const webhookUrl = (baseUrl: string, code: string) => `${baseUrl}/webhooks/wechat-oa/${encodeURIComponent(code)}`;

export async function getWechatOa(db: Db, actor: Actor, baseUrl: string) {
  require_(actor, 'admin.write');
  const t0 = await db.one('SELECT code FROM tenants WHERE id = ?', [actor.tenantId]);
  const row = await db.one('SELECT app_id, token FROM wechat_oa WHERE tenant_id = ?', [actor.tenantId]);
  // The token is a shared secret with WeChat: say whether one is set, never send it back.
  return { url: webhookUrl(baseUrl, t0.code), appId: row?.app_id ?? '', hasToken: Boolean(row?.token) };
}

export async function saveWechatOa(db: Db, actor: Actor, b: Record<string, unknown>): Promise<void> {
  require_(actor, 'admin.write');
  const appId = typeof b.appId === 'string' ? b.appId.trim() : '';
  if (appId && !APP_ID_PATTERN.test(appId)) throw new DomainError('AppID looks like wx followed by 16 letters or digits', 422);
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!token) {
    await db.run('DELETE FROM wechat_oa WHERE tenant_id = ?', [actor.tenantId]);
    await audit(db, whoOf(actor), 'bot.wechat.unlink', 'tenant', actor.tenantId, {});
    return;
  }
  if (!TOKEN_PATTERN.test(token)) throw new DomainError('Token: 3-32 letters or digits, the same as in the WeChat console', 422);
  await db.run(`INSERT INTO wechat_oa (tenant_id, app_id, token, updated_at) VALUES (?,?,?,?)
    ON CONFLICT (tenant_id) DO UPDATE SET app_id = EXCLUDED.app_id, token = EXCLUDED.token, updated_at = EXCLUDED.updated_at`, [actor.tenantId, appId, token, Date.now()]);
  await audit(db, whoOf(actor), 'bot.wechat.link', 'tenant', actor.tenantId, { appId });
}

/** WeChat signs every call with sha1 of the sorted token, timestamp and nonce. */
export function oaSignature(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');
}

function signedBy(token: string, q: URLSearchParams): boolean {
  const given = Buffer.from(q.get('signature') ?? '');
  const want = Buffer.from(oaSignature(token, q.get('timestamp') ?? '', q.get('nonce') ?? ''));
  return given.length === want.length && timingSafeEqual(given, want);
}

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
  return (m?.[1] ?? m?.[2] ?? '').trim();
};
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** Cuts to WeChat's limit on a character boundary. */
function clip(text: string): string {
  let out = text;
  while (Buffer.byteLength(out) > MAX_REPLY_BYTES) out = out.slice(0, -10);
  return out === text ? text : `${out}…`;
}

const textReply = (to: string, from: string, content: string) => `<xml><ToUserName>${cdata(to)}</ToUserName><FromUserName>${cdata(from)}</FromUserName>`
  + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>${cdata('text')}</MsgType><Content>${cdata(clip(content))}</Content></xml>`;

/**
 * One call from WeChat. GET is the console's "verify server URL" check (echo back echostr); POST is a follower message or
 * event. Any answer we cannot give is "success", which WeChat treats as "no reply".
 */
export async function handleWechatOa(db: Db, company: string, method: string, q: URLSearchParams, raw: string, baseUrl: string): Promise<OaResponse> {
  const plain = (status: number, body: string): OaResponse => ({ status, body, type: 'text/plain; charset=utf-8' });
  let t0;
  try { t0 = await tenantByCode(db, company); } catch { return plain(404, 'unknown company'); }
  const row = await db.one('SELECT token FROM wechat_oa WHERE tenant_id = ?', [t0.id]);
  if (!row || !signedBy(row.token, q)) return plain(401, 'bad signature');
  if (method === 'GET') return plain(200, q.get('echostr') ?? '');

  const msgType = tag(raw, 'MsgType');
  const follower = tag(raw, 'FromUserName');
  const account = tag(raw, 'ToUserName');
  if (!follower || !account || !await botEnabled(db, t0.id)) return plain(200, 'success');
  let reply: string | null = null;
  if (msgType === 'event' && tag(raw, 'Event') === 'subscribe') reply = welcomeText(t0.name);
  else if (msgType === 'text') {
    const text = tag(raw, 'Content');
    reply = await botAnswer(db, t0, text, baseUrl);
    if (!reply && text) {
      await recordQuestion(db, t0.id, 'wechat', text);
      reply = handoffText(text);
    }
  }
  return reply ? { status: 200, body: textReply(follower, account, reply), type: 'application/xml; charset=utf-8' } : plain(200, 'success');
}
