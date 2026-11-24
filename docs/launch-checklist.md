# Opening a new venue on NightPOS / 新店上线清单

Use this for a venue that opens on a fixed date (for example a bar opening on 10 January). Start at least two weeks before.

## 1. What to get from the venue (开业前向商家收集)

| Item | 内容 | Used for |
|---|---|---|
| Company name and short code (letters, e.g. `hzbar`) | 公司名称、英文简码 | Sign-up, customer app address `/g/<code>` |
| Each location: name, street, city, postal code | 门店名称、地址、城市、邮编 | Customer app search and map |
| Menu: name (中文 + English if wanted), category, price, which are bottles to keep (存酒) | 酒水单：名称、分类、价格、是否可存酒 | Admin > Products |
| Opening stock per tracked bottle | 开业库存 | Admin > Products > Adjust stock |
| Tables / booths / rooms: name, area, seats, minimum spend, table fee | 台位：名称、区域、人数、低消、台费 | Admin > Tables |
| Staff list with role (host, waiter, cashier, manager, finance) and department | 员工名单、岗位、部门 | Office > Departments join codes |
| Sales reps and their commission rules | 业务员与提成规则 | Admin > Commission rules |
| Printers: model, LAN IP or USB, which station (bar / kitchen / receipt) | 打印机型号、IP、出品位置 | Print bridge on the venue PC |
| Logo, cover photo, brand colour | 标志、封面图、品牌色 | Admin > App design, posters |
| Opening night offers, singers or DJs | 开业活动、驻唱 / DJ 安排 | Events, Performers, Posters |
| Whether to run 分销 and at what rate | 是否开启分销及佣金比例 | Admin > Distribution |

## 2. Set up (系统设置)

1. Create the company: self sign-up at `/site` (needs `SIGNUP_OPEN=1`) or `POST /platform/companies` (see README).
2. Admin > Business: choose the business type (bar).
3. Admin > Products, Tables, Commission rules, Printers; Office > Departments; send staff their join code.
4. Admin > Customer app: switch features on or off; App design: logo, cover, colour.
5. Admin > Tables > QR for every table; print and stick them on. Queue tab: print the queue QR for the door.
6. Admin > Events and Performers for opening night; Admin > Posters: make the opening poster for WeChat Moments and Douyin.
7. Admin > Distribution: switch on if the venue wants guests to promote it, set the rate and smallest payout, decide who pays out (finance or owner).

## 3. Test before opening (开业前演练)

- Each staff member signs in, clocks in and out.
- Open a table, order, send to the bar display, print a ticket and a receipt, settle in cash.
- A phone scans a table QR, orders, staff accept, guest pays (only works once WeChat Pay / Alipay are connected; until then cash and member wallet).
- Store a bottle, take it out again, print the slip.
- Take a queue number on a phone and call it from the till.
- Close the shift and read Reports.

## 4. Still needed before real online payments and WeChat login (仍需办理)

- ICP filing (备案) for the domain, by the company that owns it.
- WeChat mini program and WeChat Pay merchant account under that company; their AppID, secret and merchant keys go into the server settings, never into chat.
- Alipay merchant account if guests should pay with Alipay.

Until these are in place the venue can run fully on the till (cash, card machine, member wallet), with the customer app for menu, booking, queue and points.
