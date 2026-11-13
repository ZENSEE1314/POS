# NightPOS 夜场收银

Multi-company, multi-store POS and management platform for bars and clubs in China. English / 中文 interface.
WeChat Pay, Alipay and Douyin (抖音来客) integrations; Postgres; self-monitoring.

## Run locally
```bash
npm install
node scripts/dev.ts          # http://localhost:3500: simulated payments + demo company (dev only)
npm test                     # 313 tests on embedded Postgres (PGlite)
node scripts/test-pg.ts      # same suite through the production `pg` driver over the Postgres wire protocol
node scripts/simulate.ts http://localhost:3500 dev-admin-key 4 25   # multi-company load simulation + books audit
```
Dev demo login: company `doloruu`; owner/6666, finance/5555, `flag.manager`/4444, `flag.cashier`/3333, `flag.host`/1111, `flag.waiter`/2222.

## Deploy (Railway)
`Dockerfile` + `railway.json` are included. Required variables on the app service:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PLATFORM_ADMIN_KEY` | operator key for `/platform/*` (create companies, read ops log/metrics) |
| `PUBLIC_BASE_URL` | public https URL (payment callbacks) |
| `SIGNUP_OPEN=1` | optional: allow self sign-up of new companies |

Payments are enabled per provider when their credentials exist (cash, wallet and credit always work):
`WECHAT_APPID, WECHAT_MCHID, WECHAT_SERIAL_NO, WECHAT_API_V3_KEY, WECHAT_PRIVATE_KEY, WECHAT_PLATFORM_PUBKEY` and
`ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY` (PEM text, `\n` escapes allowed). Douyin: `DOUYIN_WEBHOOK_SECRET`.
`PAY_MODE=mock` swaps in simulated providers: development only, never with real customers.

## Create the first company
```bash
curl -X POST $URL/platform/companies -H "x-admin-key: $PLATFORM_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"My Group","code":"mygroup","storeName":"Main Bar","ownerName":"Owner","ownerUsername":"owner","ownerPin":"choose-a-strong-pin"}'
```

## Model
Tenant (company) → stores. Tables, products, stock, stash, bookings, bills and commission rules are per store; member wallets are company-wide.
Store staff are pinned to one store; `owner` and `finance` are company-wide and can switch store. See `docs/API.md`.

## Monitoring and self-healing
- Every request is a JSON log line (stdout). Warnings and errors are stored in `ops_events` (`GET /platform/ops`), metrics at `GET /platform/metrics`, health at `/healthz`.
- A check runs every minute (and on `POST /platform/selfheal`): expires stale stash and unpaid online payments, fixes wrong table flags, settles fully-paid bills that never settled; raises alerts for underpaid settled bills, negative stock, and signed payment callbacks that were refused (`webhook.unreconciled`).

## Not production-complete yet
- Douyin: the webhook signature and the live voucher check are assumptions/stubs until an approved 抖音来客 account is available.
- WeChat/Alipay signing is tested with generated keys only; test with real sandbox credentials before taking money.
- One merchant account for all stores. No refunds flow, offline mode, printer bridge, wall screen, or attendance yet.
- Business rules to confirm: commission is on gross line prices; credit (挂账) counts as revenue when sold; min spend/table fee are fixed when a table is opened.
