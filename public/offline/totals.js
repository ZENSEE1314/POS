// Pure bill arithmetic, a line-for-line mirror of totals() in src/bills.ts. No DOM, no network: unit-tested against the server.

/** Active sale lines only: gifts and voided lines never count toward the subtotal. */
const isBillable = (l) => l.status === 'active' && l.kind === 'sale';

export function computeTotals(bill, lines, payments) {
  const subtotal = lines.filter(isBillable).reduce((sum, l) => sum + l.qty * l.unit_price, 0);
  const paid = payments.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0);
  const minSpendTopUp = Math.max(0, bill.min_spend - subtotal);
  const total = Math.max(0, subtotal + minSpendTopUp + bill.table_fee - bill.discount);
  return { subtotal, minSpendTopUp, tableFee: bill.table_fee, discount: bill.discount, total, paid, due: Math.max(0, total - paid) };
}
