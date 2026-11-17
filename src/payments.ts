import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { settleIfPaid, totals } from './bills.ts';
import type { OnlineMethod, PayProvider } from './payments/types.ts';
import { PENDING_HOLD_MS } from './payments/http.ts';
import { logEvent } from './ops.ts';
import { earnForPayment } from './guest/loyalty.ts';

async function lockOpenBill(t: Db, actor: Actor, billId: number): Promise<any> {
  const bill = await t.one('SELECT * FROM bills WHERE id = ? AND store_id = ? FOR UPDATE', [billId, actor.storeId]);
  if (!bill) throw new DomainError('bill not found', 404);
  if (bill.status !== 'open') throw new DomainError(`bill is ${bill.status}`, 409);
  return bill;
}

function newOutTradeNo(billId: number): string {
  return `NP${billId}T${Date.now()}${randomBytes(3).toString('hex')}`;
}

/** Cash / member-wallet payments confirm instantly. Amount is capped at what is still due. */
export async function payInstant(db: Db, actor: Actor, billId: number, method: 'cash' | 'member' | 'credit', amount?: number): Promise<{ settled: boolean; paid: number }> {
  require_(actor, 'bill.settle');
  return db.tx(async (t) => {
    const bill = await lockOpenBill(t, actor, billId);
    const due = (await totals(t, billId)).due;
    // Zero total (comped, fully discounted or opened by mistake): nothing to collect, but the table must still be closable.
    if (due === 0 && (await settleIfPaid(t, actor.id, billId))) return { settled: true, paid: 0 };
    const pay = Math.min(amount ?? due, due);
    if (pay <= 0) throw new DomainError('nothing due', 409);

    if (method === 'member') {
      if (!bill.member_id) throw new DomainError('bill has no member', 422);
      // Atomic guard: balance can never go negative even under concurrent spends.
      const n = await t.run('UPDATE members SET balance = balance - ? WHERE id = ? AND balance >= ?', [pay, bill.member_id, pay]);
      if (n === 0) throw new DomainError('insufficient member balance', 402);
      await t.run('INSERT INTO wallet_ledger (member_id, store_id, delta, reason, bill_id, ts) VALUES (?,?,?,?,?,?)', [bill.member_id, actor.storeId, -pay, 'bill payment', billId, Date.now()]);
    }
    // 'credit' (挂账) books the receivable; collection is handled by finance later.
    const shift = await t.one('SELECT id FROM shifts WHERE cashier_id = ? AND closed_at IS NULL', [actor.id]);
    await t.run("INSERT INTO payments (bill_id, method, amount, status, created_at, paid_at, shift_id) VALUES (?,?,?,'paid',?,?,?)", [billId, method, pay, Date.now(), Date.now(), shift?.id ?? null]);
    await audit(t, whoOf(actor), `pay.${method}`, 'bill', billId, { amount: pay });
    return { settled: await settleIfPaid(t, actor.id, billId), paid: pay };
  });
}

/** Money another guest's phone is still in the middle of paying (unfinished online payments that have not timed out). */
export async function pendingHeld(t: Db, billId: number): Promise<number> {
  const r = await t.one("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE bill_id = ? AND status = 'pending' AND customer_id IS NOT NULL AND created_at > ?",
    [billId, Date.now() - PENDING_HOLD_MS]);
  return r.s;
}

/** Books a pending online payment for at most what is due on an open bill of this store; the provider call happens outside the transaction. */
export async function reservePayment(
  db: Db, storeId: number, billId: number, method: OnlineMethod, amount?: number, customerId: number | null = null,
): Promise<{ paymentId: number; outTradeNo: string; pay: number }> {
  return db.tx(async (t) => {
    const bill = await t.one('SELECT status FROM bills WHERE id = ? AND store_id = ? FOR UPDATE', [billId, storeId]);
    if (!bill) throw new DomainError('bill not found', 404);
    if (bill.status !== 'open') throw new DomainError(`bill is ${bill.status}`, 409);
    let due = (await totals(t, billId)).due;
    if (customerId !== null) {
      // A guest retrying replaces their own unfinished payment; other guests' unfinished payments are held back so two
      // phones at one table cannot both pay the whole bill.
      await t.run("UPDATE payments SET status = 'expired' WHERE bill_id = ? AND customer_id = ? AND status = 'pending'", [billId, customerId]);
      due -= await pendingHeld(t, billId);
      if (due <= 0) throw new DomainError('someone at this table is paying right now; try again in a few minutes', 409);
    }
    const pay = Math.min(amount ?? due, due);
    if (pay <= 0) throw new DomainError('nothing due', 409);
    const outTradeNo = newOutTradeNo(billId);
    const paymentId = await t.insert(
      "INSERT INTO payments (bill_id, method, amount, status, out_trade_no, created_at, customer_id) VALUES (?,?,?,'pending',?,?,?)",
      [billId, method, pay, outTradeNo, Date.now(), customerId]);
    return { paymentId, outTradeNo, pay };
  });
}

/** Creates a pending online payment and asks the provider for a QR the customer scans. */
export async function startOnlinePayment(
  db: Db, actor: Actor, provider: PayProvider, publicBaseUrl: string, billId: number, amount?: number,
): Promise<{ paymentId: number; outTradeNo: string; qrContent: string; amount: number }> {
  require_(actor, 'bill.settle');
  const { paymentId, outTradeNo, pay } = await reservePayment(db, actor.storeId, billId, provider.method, amount);
  try {
    const charge = await provider.createCharge({
      outTradeNo, amountFen: pay, subject: `Bill ${billId}`, notifyUrl: `${publicBaseUrl}/webhooks/${provider.method}`,
    });
    await db.run('UPDATE payments SET provider_ref = ? WHERE id = ?', [charge.providerRef ?? null, paymentId]);
    return { paymentId, outTradeNo, qrContent: charge.qrContent, amount: pay };
  } catch (e) {
    await db.run("UPDATE payments SET status = 'failed' WHERE id = ?", [paymentId]);
    throw new DomainError(`payment provider error: ${(e as Error).message}`, 502);
  }
}

/**
 * Handles a signed provider callback. Idempotent: replays of the same event, or a second
 * notify for an already-paid payment, change nothing. Amount must match what we asked for.
 */
export async function handleNotify(db: Db, providerName: OnlineMethod, provider: PayProvider, headers: Record<string, string | undefined>, rawBody: string): Promise<string> {
  const n = provider.parseNotify(headers, rawBody); // throws on bad signature
  await db.tx(async (t) => {
    // Insert-or-skip is race-free; two simultaneous deliveries of one event cannot both proceed.
    const fresh = await t.run('INSERT INTO webhook_events (id, provider, ts) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING', [`${providerName}:${n.eventId}`, providerName, Date.now()]);
    if (fresh === 0 || !n.paid) return;
    const p = await t.one('SELECT * FROM payments WHERE out_trade_no = ? FOR UPDATE', [n.outTradeNo]);
    if (!p) throw new DomainError('unknown out_trade_no', 404);
    if (p.method !== providerName) throw new DomainError(`payment was started with ${p.method}, not ${providerName}`, 409);
    if (p.status === 'paid') return;
    if (p.amount !== n.amountFen) throw new DomainError(`amount mismatch: expected ${p.amount}, got ${n.amountFen}`, 409);
    await t.run("UPDATE payments SET status = 'paid', provider_ref = ?, paid_at = ? WHERE id = ?", [n.providerRef, Date.now(), p.id]);
    const bill = await t.one('SELECT b.store_id, b.status, s.tenant_id FROM bills b JOIN stores s ON s.id = b.store_id WHERE b.id = ?', [p.bill_id]);
    await audit(t, { tenantId: bill.tenant_id, storeId: bill.store_id }, `pay.${providerName}`, 'bill', p.bill_id, { amount: p.amount, ref: n.providerRef });
    await settleIfPaid(t, null, p.bill_id);
    if (p.customer_id) await earnForPayment(t, p.customer_id, p.bill_id, p.id, p.amount);
    // The money has moved, so it is recorded; but a bill that was already paid off needs a human to refund the guest.
    const tot = await totals(t, p.bill_id);
    if (tot.paid > tot.total) {
      await logEvent(t, 'error', 'payment.overpaid', `bill ${p.bill_id} received ${tot.paid - tot.total} fen more than its total (late ${providerName} payment ${p.out_trade_no}): refund the guest`,
        { billId: p.bill_id, paymentId: p.id, over: tot.paid - tot.total, wasSettled: bill.status === 'settled' }, { tenantId: bill.tenant_id, storeId: bill.store_id });
    }
  });
  return n.ackBody;
}
