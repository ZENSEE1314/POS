# NightPOS WeChat mini program (微信小程序)

A thin native shell around the customer app (`/g/<company>`). Everything the guest sees (menu, ordering, bookings,
member card, bottles, songs) is the existing customer app inside a `web-view`. Only three things are native:

| Native part | What it does |
|---|---|
| Sign-in | `wx.login` → `POST /api/guest/mp/login`: the guest is signed in with WeChat in one step, no phone or password |
| 扫码点单 tab | `wx.scanCode` on a table QR code opens that table. Scanning a table QR with the WeChat camera also opens the mini program once 扫普通链接二维码打开小程序 is set up (see below) |
| Pay page | WeChat Pay with `wx.requestPayment` (a web-view cannot pay). Alipay is hidden inside the mini program because WeChat does not allow it |

Tabs: 首页 (venue home), 扫码点单, 我的 (the member page).

## Try it now with a test AppID

1. Install **WeChat DevTools (微信开发者工具)** from developers.weixin.qq.com.
2. Start NightPOS locally (`node scripts/dev.ts`, port 3500). Mock mode turns on mini program sign-in by itself.
3. In DevTools: **导入项目**, choose this `miniprogram` folder. For the AppID either keep 测试号 / touristappid, or get a
   free **测试号** at https://developers.weixin.qq.com/sandbox (it gives a real test AppID and AppSecret).
4. In 详情 → 本地设置, tick **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**.
5. Compile. Paying shows a "模拟付款成功" button, because the dev server does not take real money.

Note: some DevTools versions do not show `web-view` with touristappid. If the home page stays blank, use a 测试号
AppID in `project.config.json`.

## Going live (when the account and domain are ready)

1. `project.config.json`: put your real **AppID** in `appid`.
2. `config.js`: set `BASE_URL` to your ICP-filed HTTPS domain, and `COMPANY` to the venue's company code.
3. On the server, set the environment variables `WECHAT_MP_APPID` and `WECHAT_MP_SECRET` (the AppSecret goes there
   only; never in this folder or in chat).
4. Mini program console (mp.weixin.qq.com) → 开发管理 → 开发设置:
   - **服务器域名 → request 合法域名**: your domain
   - **业务域名**: your domain (download the check file it gives you and put it in NightPOS `public/`)
   - **扫普通链接二维码打开小程序**: rule = `https://<your domain>/g/`, page = `pages/home/home`. Then the table
     QR codes you already print open the mini program directly.
5. WeChat Pay: in 商户平台 → 产品中心 → AppID账号管理, link the mini program AppID to your merchant, and confirm it in
   the mini program console. The server already has the `WECHAT_*` payment variables; nothing else changes.
6. Upload from DevTools (上传), then submit for review (提交审核) in the console. Choose a 休闲娱乐/餐饮 category that
   matches your licences, and fill in the privacy guide (用户隐私保护指引): the app uses the WeChat openid and, if the
   guest adds it, a phone number.

## Files

- `config.js`: domain and company (the only file to edit)
- `utils/api.js`: sign-in, signed requests, the web-view hand-off code
- `utils/paths.js`: which scanned codes and paths are allowed (tested in `test/miniprogram.test.ts`)
- `pages/home`, `pages/me`, `pages/web`: web-view pages
- `pages/scan`, `pages/pay`: native pages
