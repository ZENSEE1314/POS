# NightPOS 夜场收银

Multi-company, multi-store POS and management platform for bars and clubs in China. English / 中文 interface.
WeChat Pay, Alipay and Douyin (抖音来客) integrations; Postgres; self-monitoring.

## Run locally
```bash
npm install
node scripts/dev.ts          # http://localhost:3500: simulated payments + demo company (dev only)
npm test                     # 462 tests on embedded Postgres (PGlite)
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

## Customer app (顾客端)
A mobile web page for guests, at `/g/<company code>` (works in WeChat, Alipay, Douyin and any phone browser; no install).

| Address | What the guest gets |
|---|---|
| `/g/<company>` | venue home: choose a location, menu, book a table, my account |
| `/g/<company>/<store>/menu` | the menu with prices and sold-out items (browse only) |
| `/g/<company>/<store>/t/<token>` | **table QR code**: order from the menu, follow "my orders", see the table's bill and pay it |
| `/g/<company>/<store>/book` | request a booking (lands in the staff Bookings tab as "Customer app", status Requested) |
| `/g/<company>/account` | wallet balance and history, stored bottles with pick-up codes, bookings, recent orders |

- **Sign-in**: WeChat, Alipay, Douyin or phone + SMS code. One guest account works at every company on the platform. A **verified phone** is what links the guest to a company's member wallet and stash (members are keyed by phone), so wallet, stash and booking need it; if the phone already belongs to another guest account (they signed in another way before), the two accounts are merged.
- **Ordering**: guest orders wait in the staff **Guest orders** tab (badge with the waiting count). *Accept* puts the items on the table's open bill through the normal path (current price, stock, waiter commission to the accepting staff, bar/kitchen tickets print); a free table is opened first and needs a sales rep. *Reject* needs a reason the guest sees.
- **Paying**: WeChat Pay (JSAPI inside WeChat when the guest signed in with the same appid; otherwise a QR), Alipay (WAP cashier, returns to the page), or the member wallet. A guest can pay all of it or a share. Paying the last fen settles the bill and frees the table.
- **QR codes**: Admin > Tables > *QR* shows, prints or renews each table's code (renewing kills printed copies). *Customer page QR* is for posters and Douyin/WeChat profiles. Table codes are random 128-bit tokens, so nobody can order onto a table they cannot see.
- `PAY_MODE=mock` (dev): every sign-in is a simulated consent page, the SMS code is shown on screen and payments have a *Pay* button.

**Going live needs accounts on each platform** (each login turns on only when its variables are set):

| Login | Variables | Platform requirement |
|---|---|---|
| WeChat | `WECHAT_OA_APPID` (defaults to `WECHAT_APPID`), `WECHAT_OA_SECRET` | verified Service Account (服务号); set the 网页授权域名 to your domain, which must be ICP-filed (备案). The Railway domain will not be accepted. |
| Alipay | uses the `ALIPAY_*` payment app; `ALIPAY_LOGIN=0` turns it off | the app needs 获取会员信息 for nicknames; set the authorisation redirect domain |
| Douyin | `DOUYIN_CLIENT_KEY`, `DOUYIN_CLIENT_SECRET` | approved Douyin Open Platform web app with `user_info` scope and the redirect domain |
| Phone (SMS) | `ALIYUN_SMS_ACCESS_KEY_ID`, `ALIYUN_SMS_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`, `ALIYUN_SMS_TEMPLATE_CODE` | Aliyun SMS with an approved signature and a verification-code template using `${code}` |

Callbacks go to `PUBLIC_BASE_URL/api/guest/auth/<wechat|alipay|douyin>/callback`. As with payments, these integrations follow the providers' documented APIs but have only been run in mock mode.

## Create the first company
```bash
curl -X POST $URL/platform/companies -H "x-admin-key: $PLATFORM_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"My Group","code":"mygroup","storeName":"Main Bar","ownerName":"Owner","ownerUsername":"owner","ownerPin":"choose-a-strong-pin"}'
```

## Printing
Receipts, kitchen/bar tickets, stash slips and shift reports print on ESC/POS thermal printers (58 mm / 80 mm, LAN port 9100 or a
Windows-shared USB printer) **without going through the cloud**, so they keep printing when the internet is down.

```
browser (NightPOS) --http 127.0.0.1:9101--> print bridge (venue PC) --> printer
   renders the slip as an image                relays bytes by printer NAME
```

- **In the browser** (`public/print/`): a bill, ticket, stash or shift report becomes a print *model* (`templates.js`, bilingual EN/中文),
  is drawn on a canvas with the system CJK font and encoded as 1-bit ESC/POS raster bands plus partial cut (`raster.js`, `escpos.js`). Raster means
  Chinese prints correctly with no GB18030 code-page tables. `printer.js` sends it to the bridge, keeps a local log of the last 100 jobs (with
  **Reprint**) and never blocks a sale: a failed print shows a toast and stays in the log.
- **On the server**: only *routing* is stored: `/api/printers` (name, kind `receipt|bar|kitchen|label`, the bridge's printer name, paper width,
  copies) and `products.station` (`bar`, `kitchen` or none). Network addresses never reach the database, so a compromised cloud cannot point the
  bridge at other hosts.
- **The bridge** (`bridge/print-bridge.ts`, zero dependencies, see `bridge/README.md`): listens on 127.0.0.1 only, needs a pairing token and an
  allow-listed Origin, takes printers by name, caps size and rate, logs every job.

**Install on a venue PC** (Node 24+): copy `bridge/bridge.config.example.json` to `bridge.config.json`, run `node bridge/print-bridge.ts --gen-token` and paste the
token in, set `allowedOrigins` to your NightPOS address, list printers (`{name, type:"tcp", host, port}` for LAN printers; `{name, type:"share", path:"\\\\localhost\\EPSON_TM"}` for a
Windows-shared USB printer: find the share name in Printer properties > Sharing, the IP from the printer's self-test sheet). Prove the wiring with
`node bridge/print-bridge.ts --self-test Receipt`, then start it with `node bridge/print-bridge.ts` and make it start with Windows (Task Scheduler or NSSM,
see `bridge/README.md`).

**Pair a device**: header **Printing** > bridge address `http://127.0.0.1:9101`, paste the token, *Test connection*. Per-device toggles choose what prints
automatically: receipt when a bill settles, tickets when items are added (new lines only, grouped per station, batched for 3 s so a burst of taps is one
ticket), stash slip after storing wine, shift report on close. Then a manager adds printers in **Admin > Printers** (use the bridge's names; *Test print* checks each) and sets
**Station** on products (bar / kitchen). A **Print receipt** button is on every bill and **Print slip** on every stash row.

**Fallback**: with no token set, the Print buttons open the browser print dialog (HTML laid out at 58/80 mm, `@page` margins 0); automatic printing stays off.
If the bridge is paired but unreachable, receipts, slips and reports fall back to the same dialog (switchable); kitchen/bar tickets never do: they stay in the log to reprint.

**Limits**: the bridge is loopback-only, so the browser must run on the PC the printers are attached to (a separate tablet cannot reach it). Safari/iOS block https to
http://127.0.0.1; use Chrome or Edge (details in `bridge/README.md`). Pending ticket batches are lost if the tab is closed within 3 s of the last tap.

## Model
Tenant (company) → stores. Tables, products, stock, stash, bookings, bills and commission rules are per store; member wallets are company-wide.
Store staff are pinned to one store; `owner` and `finance` are company-wide and can switch store. See `docs/API.md`.

## Monitoring and self-healing
- Every request is a JSON log line (stdout). Warnings and errors are stored in `ops_events` (`GET /platform/ops`), metrics at `GET /platform/metrics`, health at `/healthz`.
- A check runs every minute (and on `POST /platform/selfheal`): expires stale stash and unpaid online payments, fixes wrong table flags, settles fully-paid bills that never settled; raises alerts for underpaid settled bills, negative stock, and signed payment callbacks that were refused (`webhook.unreconciled`).

## Offline mode
The till keeps trading when the internet drops. A service worker (`public/sw.js`) precaches the whole app shell, so the page even reloads with no network; API calls are never cached by it.
- **Works offline:** see tables, products and sales reps (last copy seen online, per store); open a table; add items; take **cash** or **on-account (credit)** payments. Tables opened before the outage keep working too. A bill paid in full offline is settled locally and its table shows free.
- **Needs a connection** (shows "Needs connection" / 需要联网): gifts, voids, discounts, table transfer, WeChat/Alipay, member wallet, Douyin vouchers, top-ups, stash, bookings, reports, admin and HQ, shift open/close, signing in.
- Everything done offline is queued in IndexedDB on the device (survives reloads and closed tabs) and replayed in order to `POST /api/sync` when the connection returns. The header pill shows Online / Offline: N pending / Syncing / Needs attention; click it for details, Retry and Dismiss.
- **Conflict rules (server decides):** a table someone else opened online in the meantime is a conflict and the offline items/payments for it are **not** attached to the other bill (they are listed as "not recorded" so the cash can be reconciled by hand). Retired products and inactive reps are conflicts. The server always uses its current prices; if the bill at sync time differs from what the cashier saw, the payment applies `min(collected, due)` and the op carries a `priceDiffFen` warning. Every op is idempotent (a replay changes nothing) and goes through the same rules, permissions and audit as the online API, plus a `sync.*` audit entry marked `offline: true`. Offline bills and payments are flagged (`bills.offline`, `payments.offline`); offline cash joins the cashier's shift that is open **at sync time**.
- Sessions are kept in `sessionStorage`: if the tab is closed while offline, signing back in needs the connection (the queue waits). If the session expired while offline, the queue is kept and syncs after the same user signs in. Signing out wipes the device's offline data and asks first if anything is unsynced.

## Not production-complete yet
- Douyin: the webhook signature and the live voucher check are assumptions/stubs until an approved 抖音来客 account is available.
- WeChat/Alipay signing is tested with generated keys only; test with real sandbox credentials before taking money.
- One merchant account for all stores. No refunds flow, wall screen, or attendance yet. Printing has only been exercised against a fake TCP printer, not real hardware.
- Business rules to confirm: commission is on gross line prices; credit (挂账) counts as revenue when sold; min spend/table fee are fixed when a table is opened.
