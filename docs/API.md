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
| `POST /api/signup` | `{name, code, storeName, ownerName, ownerUsername, ownerPin, address, city, postalCode}` (only if `signupOpen`; the address fields are required) |

## Session
`POST /api/logout` · `GET /api/me` -> `{actor, store, company, business}` · `POST /api/switch-store {storeId}` (owner/finance)

## Business type and modules
- `GET /api/business` -> `{type: bar|restaurant|cafe|retail|pet|salon|other, modules: {tables, minSpend, reps, stash, bookings, kitchen, counter, barcode, purchasing, promotions, guestApp, delivery}, scaleMode: price|weight}`
- `PATCH /api/business {type?, modules?: {name: bool}, scaleMode?, applyGuestPreset?}` (owner). A new type resets modules to its preset, then `modules` is applied on top.
- A route of a switched-off module answers `404` (stash, counter sales, scanning, purchasing, promotions, shop orders).

## Counter sales, scanning, member prices
- `GET /api/counter-sales` -> open bills without a table (counter, pickup, delivery) with `total` · `POST /api/counter-sales {phone?, repId?}` -> `{billId}` (counter module)
- `POST /api/bills/:id/scan {code, qty?}` -> `{lineId, productId}` or `{needsWeight: true, product}` (barcode module). Scale labels: see README.
- `POST /api/bills/:id/lines` also takes `weightG` (whole grams, required with `qty: 1` for items sold per kg).
- `POST /api/bills/:id/member {phone}` puts a member on an open bill and lowers lines to member prices.
- Bill lines carry `weight_g` and `price_note` (`member`, `label`, `promo:<name>`). Bills carry `channel` (`table`, `counter`, `pickup`, `delivery`); `table_id` is null for the last three.

## Purchasing and promotions (manager, owner)
- `GET/POST /api/suppliers {name, contact?, phone?, note?}`, `PATCH /api/suppliers/:id` (suppliers are company-wide)
- `GET /api/purchase-orders[?status=]` · `POST /api/purchase-orders {supplierId, note?, lines: [{productId, qty, unitCost}]}` (grams and per-kg cost for items sold by weight)
- `POST /api/purchase-orders/:id/order` · `/cancel` · `/receive {received?: {lineId: qty}}` (default: as ordered)
- `GET /api/low-stock` -> items at or below `reorderLevel`, with `suggest`
- `GET/POST /api/promotions {name, productId? | category?, kind: price|percent, value, membersOnly?, startsAt, endsAt}`, `PATCH /api/promotions/:id`

## Floor (current store)
- `GET /api/tables[?all=1]` -> rows with `bill_id` when occupied. `POST /api/tables {name, zone?, kind: bar|booth|room, capacity?, minSpend?, tableFee?}` and `PATCH /api/tables/:id` (manager, owner)
- `GET /api/products[?all=1]`. `POST /api/products {name, nameEn?, category?, price, stock?, trackStock?, station?, barcode?, unit?: each|kg, cost?, memberPrice?, reorderLevel?}`, `PATCH /api/products/:id`, `POST /api/products/:id/stock {delta, reason}` (manager, owner)
- `GET/POST /api/commission-rules {role: sales|waiter, category?, productId?, bps, fixed?}`, `DELETE /api/commission-rules/:id` (write: manager, owner)

## Bills
- `POST /api/bills {tableId, repId?, phone?, bookingId?}` -> `{billId}`. With the reps module a sales rep is required (or comes from the booking); without it the person opening the table owns the bill. Rep must work at this store.
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
- `GET /api/activity?from&to&staff&action&before&all=1` (manager, finance, owner): audit trail with staff and store names, 100 per page (`next` = pass as `before`); `action` is a prefix (`order.` matches voids and gifts). Pay changes (`staff.pay`) show no detail unless the reader is finance or owner.

## Auto-reply (manager, owner)
- `GET /api/bot/faqs` · `POST /api/bot/faqs {question?, questionEn?, answer?, answerEn?, active?, fromQuestion?}` · `PATCH /api/bot/faqs/:id {…}` (a question may hold several phrasings, one per line; `fromQuestion` closes that open question)
- `GET /api/bot/questions` (questions the bot could not answer, open only) · `POST /api/bot/questions/:id/dismiss`
- `GET /api/bot/wechat` → `{url, appId, hasToken}` (the token is never returned) · `PUT /api/bot/wechat {appId?, token}` (empty token unlinks)
- `GET|POST /webhooks/wechat-oa/:company` (called by WeChat, signed with the company's token): GET echoes `echostr`, POST answers text messages and follow events with a passive XML reply
- Guest side: `POST /api/guest/requests {kind: 'support', …, human?: true}` returns `autoReply` (the bot's answer, or null when staff will answer); answered messages come back with `byBot: true`

## Attendance, salary and broadcasts
- `GET /api/attendance/me` · `POST /api/attendance/clock-in` · `POST /api/attendance/clock-out` (every staff member, for themselves; one open shift each)
- `GET /api/attendance?from&to[&all=1]` (manager, finance, owner) · `POST /api/attendance {employeeId, clockIn, clockOut, note?}` · `PATCH /api/attendance/:id {clockIn, clockOut, note?}` (manager, owner; own store unless owner; shifts up to 24 h, not in the future; old times kept in the audit log)
- `GET /api/salary?from&to[&all=1]` (finance, owner): per staff member base pay (finished hours x hourly rate, or the monthly salary once; the till asks for one calendar month) + commission = total · `PUT /api/staff-pay/:employeeId {kind: hourly|monthly, rate}` (finance, owner; rate in fen)
- `GET /api/broadcasts` · `POST /api/broadcasts {audience: staff|guests, title, body?, days?: 1-90}` · `POST /api/broadcasts/:id/stop` (manager, owner; a store manager's message is for their store, the owner's for every store) · `GET /api/news` (every staff member: live staff messages). Live guest messages appear as `news` in `GET /api/guest/venue/:company`.

## Staff and head office
- `GET /api/staff` (manager, owner) · `PATCH /api/staff/:id {active?, pin?, name?, role?}` (owner)
- `GET /api/hq/stores` (owner, finance) · `POST /api/hq/stores {name, code, city?, address?, postalCode?, douyinPoiId?, copyCatalogFrom?}` (owner) · `POST /api/hq/staff {name, username, role, pin, storeId?}` (owner) · `POST /api/hq/catalog/copy {fromStoreId, toStoreIds}` (owner) · `GET /api/hq/summary?from&to` (owner, finance)

## Platform operator (header `x-admin-key: $PLATFORM_ADMIN_KEY`, disabled if unset)
`GET/POST /platform/companies` · `GET /platform/ops?level=&limit=` (warn/error events) · `GET /platform/metrics` · `POST /platform/selfheal` (run invariant checks + safe repairs)

## Customer app (`/api/guest/*`)
Guest tokens are separate from staff tokens (`Authorization: Bearer <guest token>`, 30 days). Public routes need no token.
- `GET /api/guest/venue/:company` also returns `business`, `orderAhead`, `bookings`, `tables`; menu products carry `byWeight`.
- Order ahead: `POST /api/guest/shop-orders {company, store, mode: pickup|delivery, items, note?, address? (delivery), pickupAt?}` (verified phone; delivery module; no items sold by weight) · `POST /api/guest/orders/:id/pay {method, amount?}` once accepted. Orders carry `mode, address, pickupAt, fulfilStatus, bill: {id, status, due}`.
- Staff: `POST /api/guest-orders/:id/fulfil {step}`: pickup `ready`, `done`; delivery `out`, `done`.
- Directory: `GET /api/guest/directory?q=&city=` -> `{results: [{company:{name,code,business}, stores:[{name,code,city,address,postalCode}]}] (max 50), cities}`; only active companies with `listed` on; `q` matches company name/code, location name, city or address. `GET /api/guest/me/places` (signed in) -> same entries for businesses the guest has ordered, booked or earned points with, newest first. Owner: `PATCH /api/hq/stores/:id/location {city, address, postalCode}` (hq.write); `listed` is part of `/api/guest-settings`.
- App design: venue and table info carry `theme: {preset, accent, headline, tagline, layout, logo, cover}` (logo/cover are URLs or null). Staff (admin.write; audited): `GET/PATCH /api/guest-theme {preset: night|midnight|noir|daylight|blush, accent: '#rrggbb'|'', headline (60), tagline (140), layout: list|grid}` · `PUT /api/guest-theme/images/:kind {dataUrl}` (kind logo|cover; JPEG/PNG/WebP checked by file signature, max 180 KB) · `DELETE /api/guest-theme/images/:kind`. Public: `GET /api/guest/images/:company/:kind` (bytes, cached a day; URL changes on upload).
- Public: `GET /api/guest/config` -> `{mock, login:{wechat,alipay,douyin,phone,password}, payments:{wechat,alipay}}` · `GET /api/guest/venue/:company` · `GET /api/guest/venue/:company/:store/menu` · `GET /api/guest/table/:qrToken`
- Provider sign-in: `GET /api/guest/auth/:provider/start?return=/g/...` (302 to the provider) -> provider -> `GET /api/guest/auth/:provider/callback` (302 to `return#login=<one-time code>` or `#loginError=`) -> `POST /api/guest/session {code}` -> `{token, customer}`. State and code are single-use; `return` must be a `/g/` path.
- Phone: `POST /api/guest/otp {phone}` (mainland mobile; 1 per minute per phone, 10 per hour per IP; `devCode` only in mock mode) · `POST /api/guest/login/phone {phone, code}` · `POST /api/guest/me/phone {phone, code}` (verify/link; merges into the account that already owns the phone). 5 wrong guesses kill a code.
- Phone + password (no SMS): `POST /api/guest/register {phone, password (8..72), name?}` -> `{token, customer}` (409 if the phone already has a password account; 30 per hour per IP) · `POST /api/guest/login/password {phone, password}` (401 `wrong phone number or password` for both unknown phone and wrong password; shares the per-phone guess limit with SMS codes). The phone is a login name only: `customer.loginPhone` is set, `customer.phone` stays null until verified by SMS.
- Forgot password: staff `POST /api/guest-password-resets {phone}` (admin.write; audited) -> `{phone, code (8 digits), expiresAt}` (30 min, single use, 5 wrong tries; 404 no password account, 409 when the account has a verified phone) · guest `POST /api/guest/password/reset {phone, code, password}` -> `{token, customer}`; `code` is the staff code, or an SMS code from `/api/guest/otp` when SMS is set up. Ends every other session of the account.
- Signed in: `GET/PATCH /api/guest/me {name}` · `POST /api/guest/logout` · `GET /api/guest/account/:company` -> `{phoneVerified, wallet:{balance, ledger}|null, stash, bookings, orders}`
- Orders: `POST /api/guest/orders {qrToken, items:[{productId, qty 1..99}] (1..30), note?}` -> `{orderId}` (409 when an item is retired or short of stock; max 5 pending per guest) · `GET /api/guest/orders/:id` · `POST /api/guest/orders/:id/cancel` (pending only)
- Bill and pay: `GET /api/guest/table/:qrToken/bill` · `POST /api/guest/table/:qrToken/pay {method: wechat|alipay|member, amount?, returnPath?}` -> `{kind: jsapi|redirect|qr|mock|done, ...}` · `GET /api/guest/payments/:outTradeNo` -> `{status, billSettled}` · mock only: `POST /api/guest/payments/:outTradeNo/mock-pay`
- Bookings: `POST /api/guest/bookings {company, store, partySize, eta, name?, note?, eventId?}` (verified phone; 15 min to 60 days ahead; max 3 upcoming per store; an event's title is prefixed to the note) · `POST /api/guest/bookings/:id/cancel`
- Venue and table responses carry `features` (which extras the company has on). `GET /api/guest/table/:qrToken` also returns `gifts` received in the last 6 hours.
- Gifts: `GET /api/guest/table/:qrToken/tables` (other open tables) · `POST /api/guest/orders {..., giftTo: tableId}` (charged to the sender's table)
- Requests: `POST /api/guest/requests {kind, ...}`: `service {qrToken, reason: waiter|ice|glasses|cleanup|bill|other, note?}` · `song {qrToken, title, artist?, note?}` · `bottle {qrToken, code}` (own stash at that store; verified phone) · `support {company, store, message}` · `pet {company, store, petId, service: grooming|bath|daycare|boarding|visit|other, when, note?}`. Max 5 waiting and 20 an hour per guest. `GET /api/guest/requests/:company` · `POST /api/guest/requests/:id/cancel`
- Loyalty: `GET /api/guest/loyalty/:company` -> `{balance, ledger, rewards, vouchers, pointsPerYuan, referral:{code, points, referredBy, invited, rewarded}|null, spin:{cost, prizes}|null}` · `POST /api/guest/loyalty/:company/redeem {rewardId}` -> `{balance, voucher}` · `POST /api/guest/loyalty/:company/spin` -> `{index, prize, balance, voucher}` (402 without enough points, 429 after 10 a day) · `POST /api/guest/referral {company, code}` (409 once the guest has paid there)
- Events: `GET /api/guest/events/:company` (public). Pets: `GET/POST /api/guest/pets` · `PATCH /api/guest/pets/:id` · `POST /api/guest/pets/:id/remove`

Staff side: `GET /api/guest-orders?status=pending|accepted|rejected|cancelled` · `GET /api/guest-orders/count` -> `{pending, orders, requests}` ·
`GET /api/guest-requests?status=pending|done|declined|cancelled` · `POST /api/guest-requests/:id/done {reply?}` · `POST /api/guest-requests/:id/decline {reply}` · `GET /api/vouchers/:code` · `POST /api/vouchers/:code/use` (all: order.add) ·
`GET/PATCH /api/guest-settings {features:{...}, pointsPerYuan, referralPoints, spinCost}` · `GET/POST /api/loyalty-rewards`, `PATCH /api/loyalty-rewards/:id` · `GET/POST /api/spin-prizes`, `PATCH /api/spin-prizes/:id` · `GET/POST /api/venue-events`, `PATCH /api/venue-events/:id` (all: admin.write) · `POST /api/guest-orders/:id/accept {repId?}` (repId required when the table is free) · `POST /api/guest-orders/:id/reject {reason}` (waiter, cashier, manager, owner) · `POST /api/tables/:id/qr` -> `{qrToken}` (manager, owner). Table rows carry `qr_token`.

## Offline sync
`POST /api/sync {ops:[{opId, type, ref?, ts?, payload}]}` -> `{results:[{opId, status, message?, code?, billId?, settled?, paid?, priceDiffFen?, replayed?}]}`. Any signed-in role; each op is checked with the caller's own permissions, in the caller's current store.
- Ops run strictly in order, each in its own transaction, through the normal domain functions. One failure never aborts the batch. Max 200 ops per batch (422), body max 256 KB (413); any malformed op (bad uuid, non-integer id/qty/amount, unknown field or type) rejects the whole batch with 422 before anything runs.
- Types: `bill.open {tableId, repId, phone?}` and `counter.open {repId?, phone?}` (counter module), each with `ref` = client bill ref (uuid or negative temp id as a string); `bill.addLine {billRef, productId, qty, weightG?, lineRef?, gift?: true, reason?}` (`reason` is required with `gift` and refused without it); `bill.scan {billRef, code, qty, lineRef?}` (scale labels: the price is read from the code, as online); `bill.member {billRef, phone}`; `bill.void {billRef, lineRef | lineId, reason}`; `bill.discount {billRef, amount, reason}`; `bill.transfer {billRef, toTableId}` (a target taken meanwhile is a `conflict`); `bill.pay {billRef, method: cash|credit, amount, expectedDue?}`. `billRef` is a client ref from an earlier open op (mapped in `sync_refs`, per store) or a real bill id of this store. `lineRef` (uuid) names a line added offline (mapped in `sync_line_refs`), so a later `bill.void` can point at it; a real line id is sent as `lineId`. A void whose line was never created is `skipped`.
- `opId` is a uuid, idempotent per store (`sync_ops`): a replay, even concurrent, returns the stored result with `replayed:true` and changes nothing. Only successful ops are stored, so a failed op can be retried under the same id.
- `status`: `ok`; `conflict` (server state moved on: table occupied, bill already settled, product retired, rep inactive); `error` (permission 403, wrong store, invalid value); `skipped` (its bill was never created, e.g. the bill.open failed). `priceDiffFen` = server due before the payment minus `expectedDue` (the due the cashier saw); the payment applies `min(amount, due)`.

## Self-healing (runs every minute and on demand)
Expires stale stash and unpaid online payments (>15 min); frees tables flagged occupied with no open bill; marks tables with an open bill occupied; settles fully-paid bills that never settled. Alerts (not auto-fixed): settled bills that are underpaid, negative stock.

`POST /platform/companies/:code/active {active:false|true}`: suspend or restore a company (login blocked, sessions revoked, data kept).
