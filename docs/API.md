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
- `GET /api/products[?all=1]`. `POST /api/products {name, nameEn?, category?, price, stock?, trackStock?, station?}`, `PATCH /api/products/:id`, `POST /api/products/:id/stock {delta, reason}` (manager, owner)
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

## Printers (current store; routing only)
- `GET /api/printers` -> `[{id, name, kind: receipt|bar|kitchen|label, bridgeName, paperMm: 58|80, copies: 1..5, enabled, lang: both|zh|en}]` (any signed-in staff)
- `POST /api/printers {name, kind, bridgeName, paperMm?, copies?, enabled?, lang?}` -> `{printerId}` · `PATCH /api/printers/:id` (any subset) · `DELETE /api/printers/:id` (manager, owner)
- `bridgeName` is the name from the print bridge's own config (letters, digits, space . _ -, max 64), never an address. Names are unique per store (case-insensitive), max 20 printers per store.
  Another store's or company's printer id is `404`; invalid values are `422`, a duplicate name `409`.
- Products carry `station`: `''` (prints on no ticket), `bar` or `kitchen`; set it on `POST/PATCH /api/products`; `POST /api/hq/catalog/copy` copies it.
- The bridge itself (`bridge/print-bridge.ts`, 127.0.0.1:9101) is documented in `bridge/README.md`.

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

## Customer app (`/api/guest/*`)
Guest tokens are separate from staff tokens (`Authorization: Bearer <guest token>`, 30 days). Public routes need no token.
- Public: `GET /api/guest/config` -> `{mock, login:{wechat,alipay,douyin,phone}, payments:{wechat,alipay}}` · `GET /api/guest/venue/:company` · `GET /api/guest/venue/:company/:store/menu` · `GET /api/guest/table/:qrToken`
- Provider sign-in: `GET /api/guest/auth/:provider/start?return=/g/...` (302 to the provider) -> provider -> `GET /api/guest/auth/:provider/callback` (302 to `return#login=<one-time code>` or `#loginError=`) -> `POST /api/guest/session {code}` -> `{token, customer}`. State and code are single-use; `return` must be a `/g/` path.
- Phone: `POST /api/guest/otp {phone}` (mainland mobile; 1 per minute per phone, 10 per hour per IP; `devCode` only in mock mode) · `POST /api/guest/login/phone {phone, code}` · `POST /api/guest/me/phone {phone, code}` (verify/link; merges into the account that already owns the phone). 5 wrong guesses kill a code.
- Signed in: `GET/PATCH /api/guest/me {name}` · `POST /api/guest/logout` · `GET /api/guest/account/:company` -> `{phoneVerified, wallet:{balance, ledger}|null, stash, bookings, orders}`
- Orders: `POST /api/guest/orders {qrToken, items:[{productId, qty 1..99}] (1..30), note?}` -> `{orderId}` (409 when an item is retired or short of stock; max 5 pending per guest) · `GET /api/guest/orders/:id` · `POST /api/guest/orders/:id/cancel` (pending only)
- Bill and pay: `GET /api/guest/table/:qrToken/bill` · `POST /api/guest/table/:qrToken/pay {method: wechat|alipay|member, amount?, returnPath?}` -> `{kind: jsapi|redirect|qr|mock|done, ...}` · `GET /api/guest/payments/:outTradeNo` -> `{status, billSettled}` · mock only: `POST /api/guest/payments/:outTradeNo/mock-pay`
- Bookings: `POST /api/guest/bookings {company, store, partySize, eta, name?, note?}` (verified phone; 15 min to 60 days ahead; max 3 upcoming per store) · `POST /api/guest/bookings/:id/cancel`

Staff side: `GET /api/guest-orders?status=pending|accepted|rejected|cancelled` · `GET /api/guest-orders/count` · `POST /api/guest-orders/:id/accept {repId?}` (repId required when the table is free) · `POST /api/guest-orders/:id/reject {reason}` (waiter, cashier, manager, owner) · `POST /api/tables/:id/qr` -> `{qrToken}` (manager, owner). Table rows carry `qr_token`.

## Offline sync
`POST /api/sync {ops:[{opId, type, ref?, ts?, payload}]}` -> `{results:[{opId, status, message?, code?, billId?, settled?, paid?, priceDiffFen?, replayed?}]}`. Any signed-in role; each op is checked with the caller's own permissions, in the caller's current store.
- Ops run strictly in order, each in its own transaction, through the normal domain functions. One failure never aborts the batch. Max 200 ops per batch (422), body max 256 KB (413); any malformed op (bad uuid, non-integer id/qty/amount, unknown field or type) rejects the whole batch with 422 before anything runs.
- Types: `bill.open {tableId, repId, phone?}` with `ref` = client bill ref (uuid or negative temp id as a string); `bill.addLine {billRef, productId, qty}` (no gifts); `bill.pay {billRef, method: cash|credit, amount, expectedDue?}`. `billRef` is a client ref from an earlier `bill.open` (mapped in `sync_refs`, per store) or a real bill id of this store.
- `opId` is a uuid, idempotent per store (`sync_ops`): a replay, even concurrent, returns the stored result with `replayed:true` and changes nothing. Only successful ops are stored, so a failed op can be retried under the same id.
- `status`: `ok`; `conflict` (server state moved on: table occupied, bill already settled, product retired, rep inactive); `error` (permission 403, wrong store, invalid value); `skipped` (its bill was never created, e.g. the bill.open failed). `priceDiffFen` = server due before the payment minus `expectedDue` (the due the cashier saw); the payment applies `min(amount, due)`.

## Self-healing (runs every minute and on demand)
Expires stale stash and unpaid online payments (>15 min); frees tables flagged occupied with no open bill; marks tables with an open bill occupied; settles fully-paid bills that never settled. Alerts (not auto-fixed): settled bills that are underpaid, negative stock.

`POST /platform/companies/:code/active {active:false|true}`: suspend or restore a company (login blocked, sessions revoked, data kept).
