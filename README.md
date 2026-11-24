# NightPOS 夜场收银

Multi-company, multi-store POS and management platform for bars, clubs, restaurants, cafes, grocery and retail shops,
pet cafes and pet shops, salons and spas in China. English / 中文 interface.
WeChat Pay, Alipay and Douyin (抖音来客) integrations; Postgres; self-monitoring.

## Run locally
```bash
npm install
node scripts/dev.ts          # http://localhost:3500: simulated payments + demo company (dev only)
npm test                     # 814 tests on embedded Postgres (PGlite); on a low-memory machine use --test-concurrency=1
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

**Fails closed in production.** With `NODE_ENV=production` (the Dockerfile sets it) the server refuses to start, and `seed()` refuses to run,
when `PAY_MODE=mock`, `SEED_DEMO=1`, or `MOCK_PAY_SECRET=dev-mock-secret` (or unset while mock) is configured. The only override is
`ALLOW_MOCK_IN_PROD=1`, meant for a throwaway demo deployment: never set it where real customers pay. Do not copy mock/demo settings
(`PAY_MODE=mock`, `SEED_DEMO=1`) from a dev `.env` into a production service.

## Business types and modules
Every company has a business type, picked at sign-up (`businessType` on `POST /api/signup` and `/platform/companies`) and
changeable by the owner in **Admin > Business**. The type switches on a starting set of modules; each module can then be
switched on or off for the whole company. Switched-off modules disappear from the till and their API answers 404.

| Module | What it adds | On by default for |
|---|---|---|
| Tables | floor plan, open a table, transfer | bar, restaurant, cafe, pet, other |
| Minimum spend | minimum spend and table fee per table | bar |
| Sales reps | a rep must be chosen to open a table; commission | bar, salon |
| Stored bottles | Stash tab | bar |
| Bookings | Bookings tab, booking from the customer app | bar, restaurant, pet, salon |
| Kitchen tickets | bar / kitchen station per product | bar, restaurant, cafe |
| Counter checkout | **Checkout** tab: quick sales without a table, several can be held open | restaurant, cafe, retail, pet, salon, other |
| Barcodes and weighing | scan box on the bill, items sold per kg, scale labels | retail, pet |
| Purchasing | **Stock** tab: low stock, suppliers, purchase orders, receiving | restaurant, retail, pet |
| Promotions | sale prices and percent-off by product, category or everything; members-only option | all |
| Customer app | Guest orders tab and `/g/<company>` | all |
| Pickup and delivery | guests order ahead from the shop page | restaurant, cafe, retail, pet |

Without the sales reps module, whoever opens a table or sale owns it and no commission rules are created.
Changing the type in Admin resets modules to that type's set; tick *Also set the customer app features* to switch the
customer app extras too (a shop gets loyalty, invites and events, not song requests or stored bottles).

**Shops (grocery, convenience, pet shop):**
- Products carry a barcode, how they are sold (each, or per kg), cost price, member price and a reorder level.
- Scan a product's barcode into the scan box on the bill (a USB/Bluetooth scanner types it and presses Enter). An item sold
  by weight asks for its weight; its stock is kept in grams.
- Shop scale labels (EAN-13 starting with 2: `2` + 6-digit item code + 5-digit value + check digit) are read directly. The
  item code is the product's barcode; the value is the price in fen or the weight in grams (Admin > Business, *Scale
  labels carry*). Price labels charge the printed price.
- Member price applies when the sale has a member; *Add member* on an open sale re-prices lines that are cheaper for members.
  Running promotions are applied when an item is added; the lowest of list, member and promotion price wins. The line shows why.
- **Stock**: low stock (at or below reorder level, with a suggested order), suppliers, purchase orders (draft, ordered,
  received, cancelled). Receiving adds what actually arrived to stock, logs it and sets each item's cost to the price paid.

**Pickup and delivery:** the shop page offers *Order for pickup or delivery* (verified phone needed; items sold by weight
are bought in store). Staff accept it in Guest orders, which opens a pickup or delivery sale under Checkout at today's
prices (member prices included). The guest can then pay it in the app (WeChat Pay, Alipay, wallet) or at the counter. Staff
move it along: pickup *ready* then *done*, delivery *out* then *done*; the guest sees each step under *My orders*.

## Customer app (顾客端)
A mobile web page for guests, at `/g/<company code>` (works in WeChat, Alipay, Douyin and any phone browser; no install).

| Address | What the guest gets |
|---|---|
| `/g/` | **find a place**: search every listed business on the platform by name, city or street, filter by city, plus "my places" (businesses the guest has used). Each company only shares its public name, locations, city and address; owners set city/address in Admin > Locations in the app and can turn listing off in Admin > Customer app |
| `/g/<company>` | **member dashboard**: switch merchant, choose a location, member card (points, wallet, vouchers, progress to the next reward), quick actions (order, menu, book, songs, games, prize wheel, rewards, invite, events, history, pets, contact, only those switched on), next booking, news, recent activity. The member card also shows **total spent** (paid on settled bills under the guest's phone) and, without a wallet yet, an **open a member card** button. After scanning a table code, two cards lead back to **ordering at that table** and **paying its bill** (台位码收款). The venue **WiFi** name and password (set per location in Admin > Locations) show with a copy button. Signed-out guests see the cover and a join card. Bottom menu bar: Home, Order, Rewards, History, Me. Looks are the company's own, set in Admin > App design: theme (Night gold, Midnight blue, Noir, Daylight, Blush), brand colour (text contrast adjusted automatically), headline, tagline, logo and cover photo |
| `/g/<company>/<store>` | the same dashboard with that location chosen (remembered for next time) |
| `/g/<company>/<store>/menu` | the menu with prices and sold-out items (browse only) |
| `/g/<company>/<store>/t/<token>` | **table QR code**: order from the menu, follow "my orders", see the table's bill and pay it |
| `/g/<company>/<store>/book` | request a booking (lands in the staff Bookings tab as "Customer app", status Requested) |
| `/g/<company>/me` | profile and settings: name, phone, sign-in methods, language, switch merchant, sign out, links to every member page (`/account` still works) |
| `/g/<company>/wallet` | wallet balance, top-up and payment history, stored bottles with pick-up codes |
| `/g/<company>/history` | all orders (cancel, pay pickup/delivery orders) and bookings (cancel, book again); `/orders` opens it too |
| `/g/<company>/activity` | one timeline of points, wallet, orders, vouchers and requests, with filters |
| `/g/<company>/bottles` | **my bottles** (stored bottles with pick-up codes) and **store a bottle** (自助存酒): the guest asks staff to keep a bottle they did not finish (how much is left, at their table or chosen location); it lands in Guest orders as "Store bottle" with the guest's verified phone, and staff store it in the Stash tab |
| `/g/<company>/songs` | request a song from the app (sent to the table the guest last scanned, else to the chosen location) and follow the queue |
| `/g/<company>/invite` | invite code and link (share or copy), invited / joined / points earned, enter a friend's code |
| `/g/<company>/rewards` | points, redeem rewards for voucher codes, my vouchers, points history |
| `/g/<company>/spin` | prize wheel (costs points; prizes are points or freebie vouchers, never cash; 10 spins a day) |
| `/g/<company>/events` | upcoming events at every location; *Book for this event* opens the booking form with the event attached |
| `/g/<company>/games` | the prize wheel (when on) and party games on one phone: dice cup, truth or dare, random "who's next" (nothing is sent or bet) |
| `/g/<company>/pets` | the guest's pets and pet care requests (grooming, bath, day care, boarding, visit). Off by default |
| `/g/<company>/support` | chat with the venue: the auto-reply answers common questions at once, staff answer the rest ("Ask our staff" skips the bot) |

- **Sign-in**: WeChat, Alipay, Douyin, phone + SMS code, or phone + password (register in the app, no SMS or outside account needed; always on). A password account's phone is not verified, so it does not unlock the wallet or stash until the guest verifies it by SMS; it is used as the contact number for bookings and pickup/delivery orders. Forgot password: a manager gives a one-time reset code from Admin > Guest passwords (only for accounts without a verified phone), or the guest uses an SMS code once SMS is set up. One guest account works at every company on the platform. A **verified phone** is what links the guest to a company's member wallet and stash (members are keyed by phone), so wallet, stash and booking need it; if the phone already belongs to another guest account (they signed in another way before), the two accounts are merged.
- **Ordering**: guest orders wait in the staff **Guest orders** tab (badge with the waiting count). *Accept* puts the items on the table's open bill through the normal path (current price, stock, waiter commission to the accepting staff, bar/kitchen tickets print); a free table is opened first and needs a sales rep. *Reject* needs a reason the guest sees.
- **Paying**: WeChat Pay (JSAPI inside WeChat when the guest signed in with the same appid; otherwise a QR), Alipay (WAP cashier, returns to the page), or the member wallet. A guest can pay all of it or a share. Paying the last fen settles the bill and frees the table.
- **Services tab at the table**: call staff (waiter, ice, glasses, clean-up, bill, other), request a song, ask for a stored bottle to be brought over, and send a gift. Requests land in **Guest orders > Requests**; staff mark them *Done* (with an optional reply for messages and pet care) or *Decline* with a reason the guest sees.
- **Gifts**: a guest picks items, then chooses another open table under *Who is it for?*. It is charged to the sender's own bill once staff accept it; the ticket prints "B2 (gift from B3)" and the other table's page shows the gift and message for 6 hours.
- **Loyalty**: guests earn points for money paid through the app (default 1 point per ¥1; wallet, WeChat Pay and Alipay payments made in the app; not cash paid at the till). Points buy rewards from Admin > Rewards, which become 8-character voucher codes; staff check and mark them used with *Check voucher* in Guest orders. Vouchers last 30 days.
- **Invite friends**: every guest has an invite code and link (`/g/<company>?ref=CODE`). A new guest who enters it before paying here gets the bonus (default 200 points) together with the friend, but only after the new guest's first payment.
- **Settings**: Admin > Customer app switches each feature on or off for the whole company and sets points per ¥1, the invite bonus and the spin cost. Admin > Events, Rewards and Prize wheel manage those lists (the wheel uses a default set until two prizes of your own are active).
- **QR codes**: Admin > Tables > *QR* shows, prints or renews each table's code (renewing kills printed copies). *Customer page QR* is for posters and Douyin/WeChat profiles. Table codes are random 128-bit tokens, so nobody can order onto a table they cannot see.
- `PAY_MODE=mock` (dev): every sign-in is a simulated consent page, the SMS code is shown on screen and payments have a *Pay* button.

**Going live needs accounts on each platform** (each login turns on only when its variables are set):

| Login | Variables | Platform requirement |
|---|---|---|
| WeChat | `WECHAT_OA_APPID` (defaults to `WECHAT_APPID`), `WECHAT_OA_SECRET` | verified Service Account (服务号); set the 网页授权域名 to your domain, which must be ICP-filed (备案). The Railway domain will not be accepted. |
| WeChat mini program | `WECHAT_MP_APPID`, `WECHAT_MP_SECRET` | the mini program in `miniprogram/` (see its README); for WeChat Pay inside it, link its AppID to the merchant in 商户平台 → AppID账号管理 |
| Alipay | uses the `ALIPAY_*` payment app; `ALIPAY_LOGIN=0` turns it off | the app needs 获取会员信息 for nicknames; set the authorisation redirect domain |
| Douyin | `DOUYIN_CLIENT_KEY`, `DOUYIN_CLIENT_SECRET` | approved Douyin Open Platform web app with `user_info` scope and the redirect domain |
| Phone (SMS) | `ALIYUN_SMS_ACCESS_KEY_ID`, `ALIYUN_SMS_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`, `ALIYUN_SMS_TEMPLATE_CODE` | Aliyun SMS with an approved signature and a verification-code template using `${code}` |

Callbacks go to `PUBLIC_BASE_URL/api/guest/auth/<wechat|alipay|douyin>/callback`. As with payments, these integrations follow the providers' documented APIs but have only been run in mock mode.

## Auto-reply (app and WeChat)
Works like the Reborn WhatsApp bot, with no AI service to pay for: it answers from the company's own FAQ (Admin > Auto-reply; several phrasings per question, Chinese and English, similar wording still matches), then common requests by keyword (address with postal code and an Amap link, upcoming events, booking, menu, song requests, points and wallet). Anything else waits for staff in Guest requests and is listed under *Open questions*, where one click turns the answer into a new FAQ. Switch it off per company in Admin > Customer app (feature *Auto-reply*).

WeChat Official Account: in Admin > Auto-reply, *Link WeChat* with a Token, then in the WeChat console (设置与开发 > 基本配置 > 服务器配置) set the server URL to `PUBLIC_BASE_URL/webhooks/wechat-oa/<company>`, the same Token, plaintext mode. Followers get the same answers as passive replies, a welcome message when they follow, and a "passed to staff" message otherwise (staff then reply in the WeChat console). Needs a verified Official Account and an ICP-filed domain for the server URL; only tested with simulated WeChat calls.

## Merchant sign-up
Self sign-up (`SIGNUP_OPEN=1`) asks for the first location's street address, city and postal code; they are required, so every new business appears in the customer app search with its address and a map button. Owners can change them, and add them for other locations, in Admin > Locations in the app.

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

## Staff: attendance, salary, broadcasts, activity log
- **Clock in / out**: every staff member has a button at the top of the till. Managers see and fix shifts in Reports > Attendance (the old times stay in the activity log).
- **Salary**: Reports > Salary (finance and owner only) per month: set each person's pay (hourly or monthly), and see hours, base pay, commission and total.
- **Broadcast**: Admin > Broadcast sends a message to staff (a banner on every till) or to customers (news on the company's customer page) for 1 to 90 days.
- **Activity log**: Reports > Activity log shows who did what and when, filterable by date, type and staff member.

## Staff home, host desk and office
- **Home** (首页, the first tab for everyone): today's numbers for the person signed in (sales on settled bills they were the rep on, commission, tables, tips, bookings, comps; the day starts at 6 am) and big tiles for every job their role may do: order, host desk, comp, deposits, tip / reward, clock in/out, business analysis, bookings, voucher check, guest orders and songs, stored bottles, office, my customers, members, approvals.
- **Host desk** (咨客台): every table as a card. Open tables show time opened, spend, the sales rep and their department, the guest (phone masked) and what is still short of the minimum spend (低差). Tonight's bookings show on their table; bookings without a table are listed on top. A free table can be **held** for a guest on the way (锁台): nobody can open it until it is released or the guest is seated from the booking made for that table. Sort by table, spend, shortfall or time; filter by area; refreshes every 20 s.
- **Office** (办公):
  - *My requests*: leave, missed clock-in, expense, purchase, other, leaving the job. *Approvals* (manager, owner): an approved missed clock-in becomes a shift in attendance; an approved resignation signs the person out, stops their sign-in and gives their customers back to the venue. Nobody decides their own request.
  - *Departments* (manager, owner): each has a 6-character **join code**. New staff tap "New staff? Join with a code" on the sign-in screen, choose their own username and PIN, and can sign in once a manager approves them in *New staff* (a manager can approve host, waiter or cashier; only the owner approves a new manager). "New code" makes the old code stop working at once.
  - *My customers*: the sales rep on a table becomes the owner of that customer the first time. Dormant customers (not back in 14 / 30 / 60 / 90 days) for calling back. *Assign customers* (manager, owner) moves customers between reps or back to the venue.
  - *Performance* (manager, finance, owner): sales, tables, comps, commission and tips by department and a staff ranking for any dates. *Comp allowances* (manager, owner): how much each person may give away per month at menu price (签送额度) without asking; managers comp freely. *Tips*: every tip and reward with table, method and who recorded it.
- **Tips and rewards** (小费 / 打赏) go to the person named and are not sales. **Deposits** (预收款 / 押金) are taken before or on arrival, then put toward the open bill on their table (paid as method `deposit`; anything left stays held) or handed back with a reason.

## Bar display, stock counts, queue, training, singers, resellers
- **Display** (出品台, tab): every drink and dish on an open bill, grouped by table and oldest first, filtered by bar or kitchen (products with no station count as bar). Tap an item when it is made; it moves to a "just served" strip for 30 minutes where a mistaken tap can be undone. Refreshes every few seconds and can go full screen on a screen behind the bar.
- **Stocktake** (盘点, Stock tab, which every manager now sees; suppliers and purchase orders there still need the purchasing module): starting one snapshots the system stock of every tracked product; staff type what they counted; closing it moves each counted product by (counted - expected), so stock that moved while counting (sales, transfers) is kept. One open stocktake per store; it can be cancelled.
- **Transfers** (调拨, Stock tab): send stock to another store of the company (`GET /api/stores` lists them for any signed-in staff). It leaves the sending store at once and is added to the receiving store, matched by product name, when that store presses Receive. The sender can cancel until then, and the stock comes back.
- **Forfeited bottles** (酒水充公, Stored bottles tab, manager): stored bottles past their keep-until date can be taken by the venue. Full bottles can go back on the shelf as stock; opened ones are written off. It cannot be undone.
- **Queue** (排队叫号, tab): numbers restart every day at 6 am. Staff take a number for walk-ins, call (the till speaks the number), seat or skip. Guests take a number in the customer app (phone required), see how many parties are ahead and the number being called, and can cancel.
- **Training** (员工学院, Office tab): managers write lessons (text and an https video link), mark some required, and see who has not read each required lesson; staff read and press "done".
- **Singers** (驻唱, Admin): performers and their sets per location; the customer app home shows who is on stage now and next.
- **Marketing posters** (营销海报, Admin): made in the browser from a template, the venue's text and picture, with a QR code to the customer app; download as a story-size or square PNG.
- **Distribution** (分销, Admin > Distribution, off by default): the company sets a commission rate (default 5%, at most 50%), a smallest payout and whether new distributors need approval. A guest applies in the customer app (`/g/<company>/earn`) and, once approved, gets a link and QR code (`/g/<company>?dist=CODE`). A guest new to the venue who opens it and signs in joins that distributor's team for good; guests who already paid there cannot be moved to a team. Every later payment that guest makes through the app (WeChat, Alipay, member wallet; not cash at the till) earns the distributor the rate, once per payment. The distributor asks for a payout to an account they type in; finance or the owner pays them outside NightPOS and marks it paid, or returns it to their balance with a reason. A paused distributor earns nothing more but can still be paid out. Managers can give one distributor a personal rate. The distributor sees team members only as a first character and `**`.
- **Resellers** (渠道合作, platform operator): `/platform/resellers` gives each partner a code; a company that signs up with that code (or from `/site?ref=CODE`) is credited to the partner, with their commission rate, for paying out. An unknown code is refused at sign-up.

## Sales website
`/site` is the public sales page for NightPOS (Chinese with an English switch): the problems it solves, features, devices, getting started, reseller programme, FAQ, and a form for demo, quote, partner and referral requests. Requests are stored in `site_leads` (10 per address per hour) and the operator reads them with `GET /platform/leads?status=new|contacted|won|lost` and updates them with `PATCH /platform/leads/:id {status, note}`. "Free trial" opens the sign-up form at `/?signup=1` when `SIGNUP_OPEN=1`.

## Model
Tenant (company) → stores. Tables, products, stock, stash, bookings, bills and commission rules are per store; member wallets are company-wide.
Store staff are pinned to one store; `owner` and `finance` are company-wide and can switch store. See `docs/API.md`.

## Monitoring and self-healing
- Every request is a JSON log line (stdout). Warnings and errors are stored in `ops_events` (`GET /platform/ops`), metrics at `GET /platform/metrics`, health at `/healthz`.
- A check runs every minute (and on `POST /platform/selfheal`): expires stale stash and unpaid online payments, fixes wrong table flags, settles fully-paid bills that never settled; raises alerts for underpaid settled bills, negative stock, and signed payment callbacks that were refused (`webhook.unreconciled`). It also purges expired sessions and prunes `webhook_events` older than 90 days.

## Offline mode
The till keeps trading when the internet drops. A service worker (`public/sw.js`) precaches the whole app shell, so the page even reloads with no network; API calls are never cached by it.
- **Works offline:** see tables, products and sales reps (last copy seen online, per store); open a table; add items; take **cash** or **on-account (credit)** payments. Tables opened before the outage keep working too. A bill paid in full offline is settled locally and its table shows free.
- **Counter sales work offline too** (Checkout tab): start a sale, tap or scan items (product barcodes, items sold per kg with their weight, shop scale labels), add a member (member prices apply at once) and take cash or on-account payment. Sales started before the outage keep working. A sale started offline shows without a number until it syncs, then takes its real number in place. Running promotions are not known offline: the till charges list or member price, and if the server's price is lower the payment is flagged with `priceDiffFen` like any other price change.
- **Voids and discounts work offline too** (managers and owners, with a reason, as online). Items added offline can be voided before they sync. A void or discount may not take the bill below what was already paid; landing exactly on it completes the bill, as online.
- **Gifts and table transfer work offline too.** Gifts need a manager and a reason, as online, and never count toward the bill. Moving a table (转台) frees the old table and takes the new one on the board straight away. If someone took the target table on the server in the meantime, the move comes back as a conflict in "Needs attention" and the bill stays on its old table.
- **Needs a connection** (shows "Needs connection" / 需要联网): WeChat/Alipay, member wallet, Douyin vouchers, top-ups, stash, bookings, reports, admin and HQ, shift open/close, signing in.
- Everything done offline is queued in IndexedDB on the device (survives reloads and closed tabs) and replayed in order to `POST /api/sync` when the connection returns. The header pill shows Online / Offline: N pending / Syncing / Needs attention; click it for details, Retry and Dismiss.
- **Conflict rules (server decides):** a table someone else opened online in the meantime is a conflict and the offline items/payments for it are **not** attached to the other bill (they are listed as "not recorded" so the cash can be reconciled by hand). Retired products and inactive reps are conflicts. The server always uses its current prices; if the bill at sync time differs from what the cashier saw, the payment applies `min(collected, due)` and the op carries a `priceDiffFen` warning. Every op is idempotent (a replay changes nothing) and goes through the same rules, permissions and audit as the online API, plus a `sync.*` audit entry marked `offline: true`. Offline bills and payments are flagged (`bills.offline`, `payments.offline`); offline cash joins the cashier's shift that is open **at sync time**.
- Sessions are kept in `sessionStorage`: if the tab is closed while offline, signing back in needs the connection (the queue waits). If the session expired while offline, the queue is kept and syncs after the same user signs in. Signing out wipes the device's offline data and asks first if anything is unsynced.

## Not production-complete yet
- Douyin: the webhook signature and the live voucher check are assumptions/stubs until an approved 抖音来客 account is available.
- WeChat/Alipay signing is tested with generated keys only; test with real sandbox credentials before taking money.
- One merchant account for all stores. No refunds flow or wall screen yet. Salary is base pay + commission only (no tax, social insurance or deductions). Printing has only been exercised against a fake TCP printer, not real hardware.
- Business rules to confirm: commission is on gross line prices; credit (挂账) counts as revenue when sold; min spend/table fee are fixed when a table is opened.
