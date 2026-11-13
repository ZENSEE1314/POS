# NightPOS API

All money is integer **fen** (1 yuan = 100). All times are epoch milliseconds. JSON in/out. Errors: `{ "error": "message" }` with status 4xx/5xx.
Authenticated routes need `Authorization: Bearer <token>`. Rate limits: 10 failed logins / 10 min per ip+company+username (429), 600 API calls / min / ip.

Roles: `host`, `waiter`, `cashier`, `manager`, `finance`, `owner`. `owner` and `finance` are tenant-wide and can switch store; the rest are pinned to one store.

## Public
| Route | Body / notes |
|---|---|
| `GET /healthz` | `{ok, mode}` |
| `GET /api/config` | `{mock, signupOpen, payments:{wechat,alipay}}` (which online methods are configured) |
| `POST /api/login` | `{company, username, pin, storeId?}` -> `{token, actor:{id,name,role,tenantId,storeId}}` |
| `POST /api/signup` | `{name, code, storeName, ownerName, ownerUsername, ownerPin}` (only if `signupOpen`) |

## Session
`POST /api/logout` · `GET /api/me` -> `{actor, store, company}` · `POST /api/switch-store {storeId}` (owner/finance)

## Floor (current store)
- `GET /api/tables[?all=1]` -> rows with `bill_id` when occupied. `POST /api/tables {name, zone?, kind: bar|booth|room, capacity?, minSpend?, tableFee?}` and `PATCH /api/tables/:id` (manager, owner)
- `GET /api/products[?all=1]`. `POST /api/products {name, nameEn?, category?, price, stock?, trackStock?}`, `PATCH /api/products/:id`, `POST /api/products/:id/stock {delta, reason}` (manager, owner)
- `GET/POST /api/commission-rules {role: sales|waiter, category?, productId?, bps, fixed?}`, `DELETE /api/commission-rules/:id` (write: manager, owner)

## Bills
- `POST /api/bills {tableId, repId?, phone?, bookingId?}` -> `{billId}`. A sales rep is required (or comes from the booking). Rep must work at this store.
- `GET /api/bills/:id` -> `{bill, lines, payments, totals:{subtotal, minSpendTopUp, tableFee, discount, total, paid, due}}`
- `POST /api/bills/:id/lines {productId, qty, gift?, reason?}` (gift: manager/owner + reason)
- `POST /api/bills/:id/lines/:lid/void {reason}` (manager/owner) · `POST /api/bills/:id/discount {amount, reason}` (manager/owner)
- `POST /api/bills/:id/transfer {toTableId}`
- `POST /api/bills/:id/pay {method: cash|member|credit, amount?}` (cashier, manager, owner). Amount defaults to what is due; capped at due. Settles when fully paid.
- `POST /api/bills/:id/pay-online {method: wechat|alipay, amount?}` -> `{paymentId, outTradeNo, qrContent, amount}` (422 if the method is not configured). Completion arrives by provider webhook.
- `POST /api/bills/:id/redeem {code}` Douyin voucher as payment.

## Bookings
`GET /api/bookings` · `POST /api/bookings {phone, name?, partySize?, eta, tableId?, repId?}` · `POST /api/bookings/:id/confirm {tableId, repId}` · `POST /api/bookings/:id/cancel {noShow?}`
Webhook `POST /webhooks/douyin` (HMAC `x-douyin-signature`), `POST /webhooks/wechat|alipay` (provider-signed).

## Stash, members
- `POST /api/stash {phone, productId, qtyMilli, kind?, days?}` -> `{id, code}` (1000 milli = 1 bottle) · `GET /api/stash?q=phoneOrCode` · `POST /api/stash/:id/retrieve {qtyMilli, billId}` · `POST /api/stash/:id/transfer {toStoreId}` (manager/owner)
- `POST /api/members/topup {phone, amount, bonus?}` (manager/owner; wallet is tenant-wide) · `GET /api/members?q=` · `GET /api/members/:phone`

## Cash control and reports
- `POST /api/shifts/open {openingCash}` · `GET /api/shifts/current` · `POST /api/shifts/close {countedCash}` -> variance · `GET /api/shifts` (manager, finance, owner)
- `GET /api/receivables` · `POST /api/receivables/:paymentId/collect {amount, method: cash|wechat|alipay|transfer}` (finance, owner)
- `GET /api/reports/daily?from&to` (manager, finance, owner) · `GET /api/payroll?from&to[&all=1]` (finance, owner) · `GET /api/audit[?all=1]`

## Staff and head office
- `GET /api/staff` (manager, owner) · `PATCH /api/staff/:id {active?, pin?, name?, role?}` (owner)
- `GET /api/hq/stores` (owner, finance) · `POST /api/hq/stores {name, code, douyinPoiId?, copyCatalogFrom?}` (owner) · `POST /api/hq/staff {name, username, role, pin, storeId?}` (owner) · `POST /api/hq/catalog/copy {fromStoreId, toStoreIds}` (owner) · `GET /api/hq/summary?from&to` (owner, finance)

## Platform operator (header `x-admin-key: $PLATFORM_ADMIN_KEY`, disabled if unset)
`GET/POST /platform/companies` · `GET /platform/ops?level=&limit=` (warn/error events) · `GET /platform/metrics` · `POST /platform/selfheal` (run invariant checks + safe repairs)

## Self-healing (runs every minute and on demand)
Expires stale stash and unpaid online payments (>15 min); frees tables flagged occupied with no open bill; marks tables with an open bill occupied; settles fully-paid bills that never settled. Alerts (not auto-fixed): settled bills that are underpaid, negative stock.
