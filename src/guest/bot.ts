// Auto-reply for guest messages: the customer app's Contact page and the company's WeChat Official Account. It works
// like the Reborn WhatsApp bot: the company's own FAQ first, then common requests by keyword (address, events, menu,
// booking, songs, wallet), and anything else is handed to staff and kept as an open question to turn into FAQ.
import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import { guestSettings } from './settings.ts';

export type BotChannel = 'app' | 'wechat';
type Lang = 'zh' | 'en';

const MAX_QUESTION = 300;
const MAX_ANSWER = 1000;
const LIST_LIMIT = 200;
const EVENTS_SHOWN = 3;
/** Share of the shorter phrasing's words or character pairs that must match for two questions to mean the same. */
const FAQ_MATCH = 0.6;
const MAP_SEARCH = 'https://uri.amap.com/search';
const CJK = /[㐀-鿿]/;
const EN_STOP = new Set(('a an the is are was were be do does did you your u i me my we our us it its this that there here what whats how can could ' +
  'would will may please pls any have has got to of for in on at and or with about tell show give want need know').split(' '));

const INTENTS: Array<{ id: Intent; re: RegExp }> = [
  { id: 'location', re: /地址|在哪|位置|怎么走|导航|停车|\baddress\b|where are you|\blocation\b|direction|\bparking\b/i },
  { id: 'events', re: /活动|优惠|派对|\bevents?\b|\bpromos?\b|\bparty\b|what'?s on/i },
  { id: 'book', re: /预订|预定|订位|订座|订台|\bbook(ing)?\b|\breserv/i },
  { id: 'song', re: /点歌|\bsong\b/i },
  { id: 'wallet', re: /积分|储值|余额|存酒|会员卡|\bpoints?\b|\bwallet\b|\bbalance\b|\bbottles?\b/i },
  { id: 'menu', re: /菜单|价格|价钱|多少钱|酒水|\bmenu\b|\bprices?\b|\bdrinks?\b/i },
  { id: 'hello', re: /^\s*(你好|您好|嗨|在吗|在不在|hi|hello|hey|help|帮助|菜单\?)\s*[!！.。?？]*\s*$/i },
];
type Intent = 'location' | 'events' | 'book' | 'song' | 'wallet' | 'menu' | 'hello';

const WORDS: Record<Lang, Record<string, string>> = {
  zh: {
    where: '{company} 的门店：', map: '地图导航', events: '近期活动：', noEvents: '近期暂无活动，欢迎关注我们的消息。', eventsMore: '全部活动：',
    book: '在线预订：', song: '在线点歌：', wallet: '登录后可在“我的”查看积分、储值和存酒：', menu: '菜单和价格：',
    hello: '您好，这里是 {company} 自动回复。您可以问我：地址、活动、预订、菜单、点歌、积分储值。其他问题会转给工作人员。',
    handoff: '收到，您的问题已转给工作人员，我们会尽快回复您。',
  },
  en: {
    where: '{company} locations:', map: 'Map', events: 'Coming up:', noEvents: 'No events planned right now. Watch this space!', eventsMore: 'All events:',
    book: 'Book online:', song: 'Request a song:', wallet: 'Sign in and open "Me" for your points, wallet and stored bottles:', menu: 'Menu and prices:',
    hello: 'Hi, this is the {company} auto-reply. Ask me about our address, events, booking, menu, song requests, or points and wallet. Anything else goes to our staff.',
    handoff: 'Thanks, we have passed your question to our staff and will reply soon.',
  },
};

const langOf = (text: string): Lang => (CJK.test(text) ? 'zh' : 'en');
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// ---------- FAQ matching ----------

function units(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim();
  const out = new Set<string>();
  for (const w of s.split(' ')) {
    if (!w) continue;
    if (CJK.test(w)) {
      // Chinese has no spaces: compare overlapping character pairs (single characters for one-character words).
      if (w.length === 1) out.add(w);
      for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    } else if (!EN_STOP.has(w)) {
      out.add(w.length > 4 ? w.replace(/(ing|ed|s)$/, '') : w);
    }
  }
  return out;
}

/** 0..1: how much of the shorter text is also in the longer one. */
export function similarity(a: string, b: string): number {
  const x = units(a);
  const y = units(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const u of x) if (y.has(u)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Each FAQ question may list several phrasings, one per line. */
const phrasings = (f: { question: string; question_en: string }) => `${f.question}\n${f.question_en}`.split('\n').map((s) => s.trim()).filter(Boolean);

async function faqAnswer(db: Db, tenantId: number, text: string, lang: Lang): Promise<string | null> {
  const faqs = await db.all('SELECT question, question_en, answer, answer_en FROM bot_faqs WHERE tenant_id = ? AND active', [tenantId]);
  let best: { score: number; faq: any } | null = null;
  for (const f of faqs) {
    const score = Math.max(...phrasings(f).map((p) => similarity(text, p)));
    if (score >= FAQ_MATCH && (!best || score > best.score)) best = { score, faq: f };
  }
  if (!best) return null;
  return lang === 'en' && best.faq.answer_en ? best.faq.answer_en : best.faq.answer || best.faq.answer_en;
}

// ---------- keyword answers ----------

async function intentAnswer(db: Db, t0: { id: number; name: string; code: string }, intent: Intent, lang: Lang, baseUrl: string): Promise<string | null> {
  const w = WORDS[lang];
  const stores = await db.all('SELECT name, code, city, address, postal_code FROM stores WHERE tenant_id = ? AND active ORDER BY id', [t0.id]);
  const app = `${baseUrl}/g/${encodeURIComponent(t0.code)}`;
  const first = stores[0] ? `${app}/${encodeURIComponent(stores[0].code)}` : app;
  switch (intent) {
    case 'location': {
      const placed = stores.filter((s) => s.address || s.city);
      if (!placed.length) return null;
      return [fill(w.where, { company: t0.name }), ...placed.map((s) => {
        const line = [s.address, s.city, s.postal_code].filter(Boolean).join(', ');
        const map = `${MAP_SEARCH}?keyword=${encodeURIComponent([s.city, s.address].filter(Boolean).join(' '))}&src=nightpos`;
        return `📍 ${s.name}: ${line}\n${w.map}: ${map}`;
      })].join('\n');
    }
    case 'events': {
      const events = await db.all(
        `SELECT e.title, e.title_en, e.starts_at, s.name AS store FROM venue_events e JOIN stores s ON s.id = e.store_id
         WHERE s.tenant_id = ? AND s.active AND e.active AND e.ends_at >= ? ORDER BY e.starts_at LIMIT ?`, [t0.id, Date.now(), EVENTS_SHOWN]);
      if (!events.length) return w.noEvents;
      const when = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
      return [w.events, ...events.map((e) => `• ${when.format(new Date(Number(e.starts_at)))} ${lang === 'en' && e.title_en ? e.title_en : e.title} (${e.store})`),
        `${w.eventsMore} ${app}/events`].join('\n');
    }
    case 'book': return `${w.book} ${first}/book`;
    case 'song': return `${w.song} ${app}/songs`;
    case 'wallet': return `${w.wallet} ${app}/me`;
    case 'menu': return `${w.menu} ${first}/menu`;
    case 'hello': return fill(w.hello, { company: t0.name });
  }
}

/**
 * The bot's answer to one guest message, or null when it does not know (then a person should answer). `baseUrl` makes
 * links absolute for WeChat; the app passes '' so links stay on the same site.
 */
export async function botAnswer(db: Db, t0: { id: number; name: string; code: string }, text: string, baseUrl: string): Promise<string | null> {
  const lang = langOf(text);
  const faq = await faqAnswer(db, t0.id, text, lang);
  if (faq) return faq;
  const intent = INTENTS.find((i) => i.re.test(text));
  return intent ? intentAnswer(db, t0, intent.id, lang, baseUrl) : null;
}

export const handoffText = (text: string): string => WORDS[langOf(text)].handoff;
export const welcomeText = (company: string, lang: Lang = 'zh'): string => fill(WORDS[lang].hello, { company });

export async function botEnabled(db: Db, tenantId: number): Promise<boolean> {
  return (await guestSettings(db, tenantId)).features.bot;
}

/** Keeps a question the bot could not answer, once per open wording, for staff to answer and turn into FAQ. */
export async function recordQuestion(db: Db, tenantId: number, channel: BotChannel, text: string): Promise<void> {
  const q = text.trim().slice(0, MAX_QUESTION);
  if (!q) return;
  const open = await db.one("SELECT 1 AS x FROM bot_questions WHERE tenant_id = ? AND status = 'open' AND lower(text) = lower(?)", [tenantId, q]);
  if (!open) await db.run('INSERT INTO bot_questions (tenant_id, channel, text, created_at) VALUES (?,?,?,?)', [tenantId, channel, q, Date.now()]);
}

// ---------- staff: Admin > Auto-reply ----------

const field = (v: unknown, name: string, max: number, required = false): string => {
  if (v == null) v = '';
  if (typeof v !== 'string' || v.trim().length > max) throw new DomainError(`${name}: up to ${max} characters`, 422);
  if (required && !v.trim()) throw new DomainError(`${name} is required`, 422);
  return v.trim();
};

export function listFaqs(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all(`SELECT id, question, question_en AS "questionEn", answer, answer_en AS "answerEn", active, created_at AS "createdAt"
    FROM bot_faqs WHERE tenant_id = ? ORDER BY active DESC, id DESC LIMIT ?`, [actor.tenantId, LIST_LIMIT]);
}

/** Creates (id null) or edits one FAQ. Answering an open question passes its id so it leaves the open list. */
export async function saveFaq(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<{ id: number }> {
  require_(actor, 'admin.write');
  const faq = {
    question: field(b.question, 'question', MAX_QUESTION), questionEn: field(b.questionEn, 'English question', MAX_QUESTION),
    answer: field(b.answer, 'answer', MAX_ANSWER), answerEn: field(b.answerEn, 'English answer', MAX_ANSWER),
    active: b.active === undefined ? true : Boolean(b.active),
  };
  if (!faq.question && !faq.questionEn) throw new DomainError('question is required', 422);
  if (!faq.answer && !faq.answerEn) throw new DomainError('answer is required', 422);
  return db.tx(async (t) => {
    let faqId = id;
    if (faqId === null) {
      faqId = await t.insert('INSERT INTO bot_faqs (tenant_id, question, question_en, answer, answer_en, active, created_at) VALUES (?,?,?,?,?,?,?)',
        [actor.tenantId, faq.question, faq.questionEn, faq.answer, faq.answerEn, faq.active, Date.now()]);
    } else {
      const n = await t.run('UPDATE bot_faqs SET question = ?, question_en = ?, answer = ?, answer_en = ?, active = ? WHERE id = ? AND tenant_id = ?',
        [faq.question, faq.questionEn, faq.answer, faq.answerEn, faq.active, faqId, actor.tenantId]);
      if (!n) throw new DomainError('FAQ not found', 404);
    }
    if (typeof b.fromQuestion === 'number') {
      await t.run("UPDATE bot_questions SET status = 'answered' WHERE id = ? AND tenant_id = ?", [b.fromQuestion, actor.tenantId]);
    }
    await audit(t, whoOf(actor), id === null ? 'bot.faq.add' : 'bot.faq.edit', 'bot_faq', faqId, { question: faq.question || faq.questionEn });
    return { id: faqId };
  });
}

export function listQuestions(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all(`SELECT id, channel, text, created_at AS "createdAt" FROM bot_questions WHERE tenant_id = ? AND status = 'open' ORDER BY id DESC LIMIT ?`,
    [actor.tenantId, LIST_LIMIT]);
}

export async function dismissQuestion(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  const n = await db.run("UPDATE bot_questions SET status = 'dismissed' WHERE id = ? AND tenant_id = ? AND status = 'open'", [id, actor.tenantId]);
  if (!n) throw new DomainError('question not found', 404);
}
