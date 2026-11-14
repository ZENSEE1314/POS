import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { whoOf } from './auth.ts';
import { addLine, attachMember, openCounterSale, openTable, setDiscount, totals, voidLine } from './bills.ts';
import { scanCode } from './retail.ts';
import { cleanPhone } from './phone.ts';
import { payInstant } from './payments.ts';
import { logEvent } from './ops.ts';

/**
 * Replays what a till did while the internet was down. Ops run strictly in order, each in its own transaction, through the
 * same domain functions the online API uses, so every permission check, stock rule, commission rule and audit entry still applies.
 */

export const MAX_SYNC_OPS = 200;
const MAX_AMOUNT_FEN = 1_000_000_000;
const MAX_LINE_QTY = 9999;
const MAX_WEIGHT_G = 1_000_000;
const MAX_CODE_CHARS = 32;
const MAX_REASON_CHARS = 200;
const MAX_PHONE_CHARS = 32;
const MAX_ID = 1_000_000_000_000_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
/** A client bill ref is a uuid or a negative temp id; a billRef may also be a positive real bill id (a bill opened before the outage). */
const CLIENT_REF_RE = new RegExp(`^(?:${UUID}|-[1-9]\\d{0,8})$`, 'i');
const BILL_REF_RE = new RegExp(`^(?:${UUID}|-[1-9]\\d{0,8}|[1-9]\\d{0,14})$`, 'i');
const REAL_BILL_ID_RE = /^[1-9]\d*$/;

type OpType = 'bill.open' | 'counter.open' | 'bill.addLine' | 'bill.scan' | 'bill.member' | 'bill.void' | 'bill.discount' | 'bill.pay';
const OP_TYPES: OpType[] = ['bill.open', 'counter.open', 'bill.addLine', 'bill.scan', 'bill.member', 'bill.void', 'bill.discount', 'bill.pay'];
/** Ops that create a bill and carry the client's ref for it. */
const OPENS_BILL: OpType[] = ['bill.open', 'counter.open'];
type OpStatus = 'ok' | 'conflict' | 'error' | 'skipped';

interface SyncOp { opId: string; type: OpType; ref?: string; clientTs?: number; payload: Record<string, any> }

export interface OpResult {
  opId: string;
  status: OpStatus;
  message?: string;
  code?: number;
  billId?: number;
  settled?: boolean;
  paid?: number;
  /** Server due minus the due the cashier saw offline; non-zero means prices changed while the till was offline. */
  priceDiffFen?: number;
  replayed?: boolean;
}

/** Thrown inside an op transaction so everything the op did (including its idempotency claim) rolls back. */
class OpFailure extends Error {
  status: Exclude<OpStatus, 'ok'>;
  code: number;
  constructor(status: Exclude<OpStatus, 'ok'>, message: string, code: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message: string): never => { throw new DomainError(message, 422); };
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${where}: unexpected field "${k}"`);
}

function parsePayload(type: OpType, at: string, p: unknown): Record<string, any> {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return bad(`${at}: payload must be an object`);
  const x = p as Record<string, any>;
  const billRef = () => {
    if (typeof x.billRef !== 'string' || !BILL_REF_RE.test(x.billRef)) bad(`${at}: billRef is not a valid bill reference`);
  };
  const lineRef = () => {
    if (x.lineRef !== undefined && (typeof x.lineRef !== 'string' || !UUID_RE.test(x.lineRef))) bad(`${at}: lineRef must be a uuid`);
  };
  const reason = () => {
    if (typeof x.reason !== 'string' || !x.reason.trim() || x.reason.length > MAX_REASON_CHARS) bad(`${at}: reason is required (max ${MAX_REASON_CHARS} characters)`);
  };
  const phone = (required: boolean) => {
    if (x.phone === undefined && !required) return;
    if (typeof x.phone !== 'string' || x.phone.length > MAX_PHONE_CHARS) bad(`${at}: phone must be a short string`);
  };
  switch (type) {
    case 'counter.open':
      onlyKeys(x, ['repId', 'phone'], at);
      if (x.repId !== undefined && !isInt(x.repId, 1, MAX_ID)) bad(`${at}: repId must be a positive integer`);
      phone(false);
      return x;
    case 'bill.scan':
      onlyKeys(x, ['billRef', 'code', 'qty', 'lineRef'], at);
      billRef();
      lineRef();
      if (typeof x.code !== 'string' || !x.code || x.code.length > MAX_CODE_CHARS) bad(`${at}: code must be a barcode`);
      if (!isInt(x.qty, 1, MAX_LINE_QTY)) bad(`${at}: qty must be an integer from 1 to ${MAX_LINE_QTY}`);
      return x;
    case 'bill.void':
      onlyKeys(x, ['billRef', 'lineRef', 'lineId', 'reason'], at);
      billRef();
      lineRef();
      if (x.lineId !== undefined && !isInt(x.lineId, 1, MAX_ID)) bad(`${at}: lineId must be a positive integer`);
      if ((x.lineRef === undefined) === (x.lineId === undefined)) bad(`${at}: send either lineRef or lineId`);
      reason();
      return x;
    case 'bill.discount':
      onlyKeys(x, ['billRef', 'amount', 'reason'], at);
      billRef();
      if (!isInt(x.amount, 0, MAX_AMOUNT_FEN)) bad(`${at}: amount must be an integer number of fen`);
      reason();
      return x;
    case 'bill.member':
      onlyKeys(x, ['billRef', 'phone'], at);
      billRef();
      phone(true);
      return x;
    case 'bill.open':
      onlyKeys(x, ['tableId', 'repId', 'phone'], at);
      if (!isInt(x.tableId, 1, MAX_ID)) bad(`${at}: tableId must be a positive integer`);
      if (!isInt(x.repId, 1, MAX_ID)) bad(`${at}: repId must be a positive integer`);
      if (x.phone !== undefined && (typeof x.phone !== 'string' || x.phone.length > MAX_PHONE_CHARS)) bad(`${at}: phone must be a short string`);
      return x;
    case 'bill.addLine':
      onlyKeys(x, ['billRef', 'productId', 'qty', 'weightG', 'lineRef'], at);
      billRef();
      lineRef();
      if (!isInt(x.productId, 1, MAX_ID)) bad(`${at}: productId must be a positive integer`);
      if (!isInt(x.qty, 1, MAX_LINE_QTY)) bad(`${at}: qty must be an integer from 1 to ${MAX_LINE_QTY}`);
      if (x.weightG !== undefined && !isInt(x.weightG, 1, MAX_WEIGHT_G)) bad(`${at}: weightG must be whole grams`);
      return x;
    case 'bill.pay':
      onlyKeys(x, ['billRef', 'method', 'amount', 'expectedDue'], at);
      billRef();
      if (x.method !== 'cash' && x.method !== 'credit') bad(`${at}: method must be cash or credit (other methods need a connection)`);
      if (!isInt(x.amount, 0, MAX_AMOUNT_FEN)) bad(`${at}: amount must be an integer number of fen`);
      if (x.expectedDue !== undefined && !isInt(x.expectedDue, 0, MAX_AMOUNT_FEN)) bad(`${at}: expectedDue must be an integer number of fen`);
      return x;
  }
}

function parseOps(body: any): SyncOp[] {
  onlyKeys(body, ['ops'], 'body');
  if (!Array.isArray(body.ops)) return bad('ops must be an array');
  if (body.ops.length > MAX_SYNC_OPS) throw new DomainError(`too many ops in one batch (max ${MAX_SYNC_OPS})`, 422);
  return body.ops.map((raw: any, i: number): SyncOp => {
    const at = `ops[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${at} must be an object`);
    onlyKeys(raw, ['opId', 'type', 'ref', 'ts', 'payload'], at);
    if (typeof raw.opId !== 'string' || !UUID_RE.test(raw.opId)) bad(`${at}: opId must be a uuid`);
    if (!OP_TYPES.includes(raw.type)) bad(`${at}: unknown type`);
    if (raw.ts !== undefined && !isInt(raw.ts, 0, Number.MAX_SAFE_INTEGER)) bad(`${at}: ts must be epoch milliseconds`);
    if (OPENS_BILL.includes(raw.type)) {
      if (typeof raw.ref !== 'string' || !CLIENT_REF_RE.test(raw.ref)) bad(`${at}: ref must be a uuid or a negative temp id`);
    } else if (raw.ref !== undefined) bad(`${at}: ref is only valid on ops that open a bill`);
    return { opId: raw.opId.toLowerCase(), type: raw.type, ref: raw.ref, clientTs: raw.ts, payload: parsePayload(raw.type, at, raw.payload) };
  });
}

/** A conflict is the server state having moved on (taken table, retired product or rep, settled bill); anything else is an error. */
function classify(e: unknown): OpFailure {
  if (e instanceof OpFailure) return e;
  if (e instanceof DomainError) {
    const stateMoved = e.status === 409 || ((e.status === 404 || e.status === 422) && /product not found|sales rep not found|no product has this barcode|line not found or already void/.test(e.message));
    return new OpFailure(stateMoved ? 'conflict' : 'error', e.message, e.status);
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) return new OpFailure('error', 'invalid value', 422);
  return new OpFailure('error', 'internal error', 500);
}

async function resolveBillId(t: Db, actor: Actor, ref: string): Promise<number> {
  if (REAL_BILL_ID_RE.test(ref)) return Number(ref);
  const row = await t.one('SELECT bill_id FROM sync_refs WHERE store_id = ? AND client_ref = ?', [actor.storeId, ref]);
  if (!row) throw new OpFailure('skipped', 'the bill this belongs to was never created on the server (its table or sale could not be opened)', 409);
  return row.bill_id;
}

async function resolveLineId(t: Db, actor: Actor, p: Record<string, any>): Promise<number> {
  if (p.lineId !== undefined) return p.lineId;
  const row = await t.one('SELECT line_id FROM sync_line_refs WHERE store_id = ? AND client_ref = ?', [actor.storeId, p.lineRef]);
  if (!row) throw new OpFailure('skipped', 'the item this void is for was never added on the server', 409);
  return row.line_id;
}

/** Remembers which real line an offline line became, so a later offline void can find it. */
async function claimLineRef(t: Db, actor: Actor, ref: string | undefined, lineId: number): Promise<void> {
  if (ref === undefined) return;
  if ((await t.run('INSERT INTO sync_line_refs (store_id, client_ref, line_id) VALUES (?,?,?) ON CONFLICT (store_id, client_ref) DO NOTHING', [actor.storeId, ref, lineId])) === 0) {
    throw new OpFailure('conflict', 'this line reference was already used by another operation', 409);
  }
}

async function claimRef(t: Db, actor: Actor, ref: string, billId: number): Promise<void> {
  if ((await t.run('INSERT INTO sync_refs (store_id, client_ref, bill_id) VALUES (?,?,?) ON CONFLICT (store_id, client_ref) DO NOTHING', [actor.storeId, ref, billId])) === 0) {
    throw new OpFailure('conflict', 'this bill reference was already used by another operation', 409);
  }
  await t.run('UPDATE bills SET offline = TRUE WHERE id = ?', [billId]);
}

async function applyOp(t: Db, actor: Actor, op: SyncOp): Promise<OpResult> {
  const p = op.payload;
  switch (op.type) {
    case 'counter.open': {
      const billId = await openCounterSale(t, actor, { repId: p.repId, phone: p.phone });
      await claimRef(t, actor, op.ref!, billId);
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.scan': {
      // Only scale labels are queued as scans (their price comes from the label itself); plain barcodes arrive as bill.addLine.
      const billId = await resolveBillId(t, actor, p.billRef);
      const r = await scanCode(t, actor, billId, p.code, p.qty);
      if ('needsWeight' in r) throw new OpFailure('conflict', 'this item is now sold by weight: add it again with its weight', 409);
      await claimLineRef(t, actor, p.lineRef, r.lineId);
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.void': {
      const billId = await resolveBillId(t, actor, p.billRef);
      await voidLine(t, actor, billId, await resolveLineId(t, actor, p), p.reason.trim());
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.discount': {
      const billId = await resolveBillId(t, actor, p.billRef);
      await setDiscount(t, actor, billId, p.amount, p.reason.trim());
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.member': {
      const billId = await resolveBillId(t, actor, p.billRef);
      await attachMember(t, actor, billId, cleanPhone(p.phone));
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.open': {
      const billId = await openTable(t, actor, { tableId: p.tableId, repId: p.repId, phone: p.phone });
      await claimRef(t, actor, op.ref!, billId);
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.addLine': {
      const billId = await resolveBillId(t, actor, p.billRef);
      const lineId = await addLine(t, actor, billId, { productId: p.productId, qty: p.qty, ...(p.weightG !== undefined ? { weightG: p.weightG } : {}) });
      await claimLineRef(t, actor, p.lineRef, lineId);
      return { opId: op.opId, status: 'ok', billId };
    }
    case 'bill.pay': {
      const billId = await resolveBillId(t, actor, p.billRef);
      // totals() does not scope by store, so prove the bill is ours before reading it.
      if (!(await t.one('SELECT id FROM bills WHERE id = ? AND store_id = ?', [billId, actor.storeId]))) throw new DomainError('bill not found', 404);
      const dueBefore = (await totals(t, billId)).due;
      const r = await payInstant(t, actor, billId, p.method, p.amount);
      // The bill row is locked by payInstant until this transaction ends, so the newest payment row is the one just written.
      if (r.paid > 0) await t.run('UPDATE payments SET offline = TRUE WHERE id = (SELECT MAX(id) FROM payments WHERE bill_id = ?)', [billId]);
      let diff = dueBefore - (p.expectedDue ?? p.amount);
      // Without an expectedDue, paying less than due is a deliberate part-payment, not a price change.
      if (p.expectedDue === undefined && diff > 0) diff = 0;
      const warning = diff === 0 ? {} : {
        priceDiffFen: diff,
        message: diff > 0 ? `prices changed while offline: ${diff} fen more was due than the cashier collected` : `prices changed while offline: ${-diff} fen less was due than the cashier collected`,
      };
      return { opId: op.opId, status: 'ok', billId, settled: r.settled, paid: r.paid, ...warning };
    }
  }
}

async function runOp(db: Db, actor: Actor, op: SyncOp): Promise<OpResult> {
  try {
    return await db.tx(async (t) => {
      // Claim first: a concurrent replay of the same op blocks on this insert until we commit, then reads our stored result.
      const claimed = await t.run('INSERT INTO sync_ops (store_id, op_id, result, ts) VALUES (?,?,?,?) ON CONFLICT (store_id, op_id) DO NOTHING', [actor.storeId, op.opId, '{}', Date.now()]);
      if (claimed === 0) {
        const prev = await t.one('SELECT result FROM sync_ops WHERE store_id = ? AND op_id = ?', [actor.storeId, op.opId]);
        return { ...JSON.parse(prev.result), replayed: true } as OpResult;
      }
      const result = await applyOp(t, actor, op);
      await t.run('UPDATE sync_ops SET result = ? WHERE store_id = ? AND op_id = ?', [JSON.stringify(result), actor.storeId, op.opId]);
      await audit(t, whoOf(actor), `sync.${op.type}`, 'bill', result.billId ?? null, {
        offline: true, clientTs: op.clientTs ?? null, opId: op.opId, ...(result.priceDiffFen ? { priceDiffFen: result.priceDiffFen } : {}),
      });
      return result;
    });
  } catch (e) {
    const failure = classify(e);
    if (failure.code === 500) await logEvent(db, 'error', 'sync.op', (e as Error).message, { opId: op.opId, type: op.type }, { tenantId: actor.tenantId, storeId: actor.storeId });
    return { opId: op.opId, status: failure.status, message: failure.message, code: failure.code };
  }
}

export async function syncOps(db: Db, actor: Actor, body: unknown): Promise<{ results: OpResult[] }> {
  const ops = parseOps(body as any);
  const results: OpResult[] = [];
  for (const op of ops) results.push(await runOp(db, actor, op));
  return { results };
}
