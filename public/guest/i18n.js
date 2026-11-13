// Customer app strings, English and Simplified Chinese. Shares the language choice with the staff app.
const LANG_KEY = 'nightpos.lang';
export const LANGS = ['zh', 'en'];

const en = {
  'app.name': 'NightPOS', 'lang.zh': '中文', 'lang.en': 'EN', 'lang.label': 'Language',
  'common.close': 'Close', 'common.cancel': 'Cancel', 'common.back': 'Back', 'common.loading': 'Loading', 'common.retry': 'Try again',
  'err.network': 'Cannot reach the venue right now. Check your connection.', 'err.generic': 'Something went wrong.',

  'landing.eyebrow': 'Bars and clubs', 'landing.title': 'Order, book and pay from your phone',
  'landing.text': 'Scan the QR code on your table, or enter the venue code you were given.',
  'landing.code': 'Venue code', 'landing.go': 'Open venue', 'landing.notFound': 'No venue with that code.',

  'venue.welcome': 'Welcome to', 'venue.pickStore': 'Choose a location', 'venue.storeSub': 'Menu and table booking', 'venue.menu': 'See the menu', 'venue.menuSub': 'Drinks, food and prices',
  'venue.book': 'Book a table', 'venue.bookSub': 'Reserve for tonight or another day', 'venue.account': 'My account',
  'venue.accountSub': 'Wallet balance, stored bottles, bookings', 'venue.scanHint': 'At the venue? Scan the QR code on your table to order.',
  'venue.notFound': 'This venue page does not exist or is closed.',

  'table.at': 'You are at', 'table.tab.menu': 'Menu', 'table.tab.orders': 'My orders', 'table.tab.bill': 'Bill',
  'table.notFound': 'This table code is not valid any more. Ask the staff for a new one.',
  'menu.all': 'All', 'menu.soldOut': 'Sold out', 'menu.empty': 'The menu is empty for now.', 'menu.add': 'Add {name}', 'menu.remove': 'Remove one {name}',
  'menu.browseOnly': 'Browsing only. Scan the QR code on your table to order.',
  'cat.none': 'Other', 'cat.spirits': 'Spirits', 'cat.beer': 'Beer', 'cat.food': 'Food', 'cat.wine': 'Wine', 'cat.soft': 'Soft drinks',
  'cart.items': '{n} items', 'cart.review': 'Review order', 'cart.title': 'Your order', 'cart.note': 'Note for the staff (optional)',
  'cart.notePh': 'e.g. less ice, extra glasses', 'cart.send': 'Send order', 'cart.sent': 'Order sent. Staff will confirm it shortly.',
  'cart.staffNote': 'Staff confirm every order before it goes on your bill.',
  'orders.empty': 'No orders from you at this table yet.', 'orders.pending': 'Waiting for staff', 'orders.accepted': 'Confirmed',
  'orders.rejected': 'Not accepted', 'orders.cancelled': 'Cancelled', 'orders.cancel': 'Cancel order', 'orders.reason': 'Reason: {reason}',
  'orders.cancelled.toast': 'Order cancelled.',
  'bill.none': 'This table has no open bill yet. Once staff confirm your first order, it appears here.',
  'bill.subtotal': 'Items', 'bill.topUp': 'Minimum spend top-up', 'bill.tableFee': 'Table fee', 'bill.discount': 'Discount',
  'bill.total': 'Total', 'bill.paid': 'Paid', 'bill.due': 'To pay', 'bill.gift': 'Gift', 'bill.allPaid': 'All paid. Thank you!',
  'pay.title': 'Pay the bill', 'pay.amount': 'Amount to pay (¥)', 'pay.amountHint': 'Leave as is to pay everything, or enter your share.',
  'pay.wechat': 'WeChat Pay', 'pay.alipay': 'Alipay', 'pay.wallet': 'Member wallet ({balance})', 'pay.walletNoPhone': 'Member wallet (verify phone first)',
  'pay.waiting': 'Waiting for payment confirmation…', 'pay.done': 'Payment received. Thank you!', 'pay.failed': 'Payment was not completed.',
  'pay.qrTitle': 'Scan to pay', 'pay.qrHint': 'Long-press the code in WeChat, or scan it with another phone.',
  'pay.mockTitle': 'Simulated payment', 'pay.mockText': 'Development mode: no real money moves. Press Pay to simulate {method} paying {amount}.',
  'pay.mockPay': 'Pay {amount}', 'pay.badAmount': 'Enter an amount such as 100 or 88.50.', 'pay.unavailable': 'Online payment is not available at this venue yet.',
  'pay.wechatOutside': 'WeChat Pay works best inside WeChat. Outside WeChat you will get a QR code.',

  'login.title': 'Sign in', 'login.why': 'Sign in so the staff know who ordered, and to see your wallet and bookings.',
  'login.wechat': 'Continue with WeChat', 'login.alipay': 'Continue with Alipay', 'login.douyin': 'Continue with Douyin', 'login.phone': 'Use phone number',
  'login.none': 'Sign-in is not available at this venue yet.', 'login.or': 'or', 'login.wechatOutside': 'Open this page inside WeChat to use WeChat sign-in.',
  'login.done': 'Signed in.', 'login.failed': 'Sign-in did not complete: {reason}', 'login.cancelled': 'Sign-in was cancelled.',
  'phone.label': 'Mobile number', 'phone.ph': '11-digit mainland number', 'phone.send': 'Send code', 'phone.resend': 'Resend in {s}s',
  'phone.code': 'Code from SMS', 'phone.submit': 'Sign in', 'phone.verify': 'Verify', 'phone.sent': 'Code sent.',
  'phone.devCode': 'Development mode, your code is {code}', 'phone.title': 'Verify your phone',
  'phone.why': 'Your phone number connects you to your member wallet and stored bottles at this venue. It is also how the venue confirms your bookings.',
  'phone.verified': 'Phone verified.',

  'account.title': 'My account', 'account.hello': 'Hello, {name}', 'account.guest': 'guest', 'account.signedVia': 'Signed in with {list}',
  'account.phone': 'Phone', 'account.noPhone': 'Not verified', 'account.verify': 'Verify phone', 'account.rename': 'Change name', 'account.name': 'Your name',
  'account.logout': 'Sign out', 'account.wallet': 'Wallet', 'account.noWallet': 'No member wallet at this venue yet. Ask the staff about top-up offers.',
  'account.walletNeedsPhone': 'Verify your phone to see your wallet and stored bottles.', 'account.history': 'Recent activity',
  'account.stash': 'Stored bottles', 'account.noStash': 'No bottles stored.', 'account.stashLeft': '{n} bottle left', 'account.expires': 'until {date}',
  'account.stashCode': 'Code {code}', 'account.bookings': 'My bookings', 'account.noBookings': 'No bookings yet.', 'account.orders': 'Recent orders',
  'account.noOrders': 'No orders yet.', 'account.saved': 'Saved.', 'account.save': 'Save', 'account.topUp': 'Top-up', 'account.spent': 'Payment',
  'provider.wechat': 'WeChat', 'provider.alipay': 'Alipay', 'provider.douyin': 'Douyin', 'provider.phone': 'phone',

  'book.title': 'Book a table', 'book.store': 'Location', 'book.when': 'Date and time', 'book.party': 'Number of guests', 'book.name': 'Name for the booking',
  'book.note': 'Requests (optional)', 'book.notePh': 'e.g. birthday, a booth near the stage', 'book.submit': 'Request booking',
  'book.done': 'Booking requested. The venue will confirm it with you.', 'book.needPhone': 'To book, first verify your phone so the venue can reach you.',
  'book.cancel': 'Cancel booking', 'book.cancelled': 'Booking cancelled.', 'book.party.n': '{n} guests',
  'bookingStatus.submitted': 'Requested', 'bookingStatus.confirmed': 'Confirmed', 'bookingStatus.checked_in': 'Arrived',
  'bookingStatus.redeemed': 'Completed', 'bookingStatus.cancelled': 'Cancelled', 'bookingStatus.no_show': 'Missed',
  'foot.text': 'Powered by NightPOS',
};

const zh = {
  'app.name': '夜场收银', 'lang.zh': '中文', 'lang.en': 'EN', 'lang.label': '语言',
  'common.close': '关闭', 'common.cancel': '取消', 'common.back': '返回', 'common.loading': '加载中', 'common.retry': '重试',
  'err.network': '暂时无法连接门店，请检查网络。', 'err.generic': '出了点问题。',

  'landing.eyebrow': '酒吧 · 夜店', 'landing.title': '用手机点单、订座、买单',
  'landing.text': '扫描桌上的二维码，或输入门店提供的场所代码。',
  'landing.code': '场所代码', 'landing.go': '进入', 'landing.notFound': '找不到这个场所代码。',

  'venue.welcome': '欢迎光临', 'venue.pickStore': '选择门店', 'venue.storeSub': '酒水单与预订', 'venue.menu': '查看酒水单', 'venue.menuSub': '酒水、小食和价格',
  'venue.book': '预订卡座', 'venue.bookSub': '今晚或其他日期', 'venue.account': '我的账户',
  'venue.accountSub': '储值余额、存酒、预订', 'venue.scanHint': '已到店？扫描桌上的二维码即可点单。',
  'venue.notFound': '该场所页面不存在或已关闭。',

  'table.at': '您所在的位置', 'table.tab.menu': '点单', 'table.tab.orders': '我的订单', 'table.tab.bill': '账单',
  'table.notFound': '此桌码已失效，请联系服务员获取新的二维码。',
  'menu.all': '全部', 'menu.soldOut': '已售罄', 'menu.empty': '暂无商品。', 'menu.add': '加一份{name}', 'menu.remove': '减一份{name}',
  'menu.browseOnly': '仅浏览。扫描桌上的二维码即可点单。',
  'cat.none': '其他', 'cat.spirits': '洋酒', 'cat.beer': '啤酒', 'cat.food': '小食', 'cat.wine': '葡萄酒', 'cat.soft': '软饮',
  'cart.items': '{n} 件', 'cart.review': '去下单', 'cart.title': '我的点单', 'cart.note': '给服务员的备注（可选）',
  'cart.notePh': '例如：少冰、多拿几个杯子', 'cart.send': '提交订单', 'cart.sent': '订单已提交，服务员确认后上单。',
  'cart.staffNote': '每笔订单都由服务员确认后才计入账单。',
  'orders.empty': '您在这桌还没有下单。', 'orders.pending': '等待确认', 'orders.accepted': '已确认',
  'orders.rejected': '未接受', 'orders.cancelled': '已取消', 'orders.cancel': '取消订单', 'orders.reason': '原因：{reason}',
  'orders.cancelled.toast': '订单已取消。',
  'bill.none': '这桌还没有开单。服务员确认您的第一笔订单后，账单会显示在这里。',
  'bill.subtotal': '消费', 'bill.topUp': '低消补足', 'bill.tableFee': '台费', 'bill.discount': '折扣',
  'bill.total': '合计', 'bill.paid': '已付', 'bill.due': '待付', 'bill.gift': '赠送', 'bill.allPaid': '已全部付清，谢谢惠顾！',
  'pay.title': '买单', 'pay.amount': '支付金额（元）', 'pay.amountHint': '不改即全部付清，也可输入您要分摊的金额。',
  'pay.wechat': '微信支付', 'pay.alipay': '支付宝', 'pay.wallet': '会员储值（{balance}）', 'pay.walletNoPhone': '会员储值（请先验证手机号）',
  'pay.waiting': '等待支付结果…', 'pay.done': '已收到付款，谢谢！', 'pay.failed': '支付未完成。',
  'pay.qrTitle': '扫码支付', 'pay.qrHint': '在微信中长按识别二维码，或用另一台手机扫码。',
  'pay.mockTitle': '模拟支付', 'pay.mockText': '开发模式：不会产生真实扣款。点击支付即模拟用{method}支付 {amount}。',
  'pay.mockPay': '支付 {amount}', 'pay.badAmount': '请输入金额，例如 100 或 88.50。', 'pay.unavailable': '该门店暂未开通线上支付。',
  'pay.wechatOutside': '请在微信内打开以使用微信支付；在微信外将显示付款二维码。',

  'login.title': '登录', 'login.why': '登录后服务员可确认是谁点的单，您也可以查看储值和预订。',
  'login.wechat': '微信登录', 'login.alipay': '支付宝登录', 'login.douyin': '抖音登录', 'login.phone': '手机号登录',
  'login.none': '该门店暂未开通登录。', 'login.or': '或', 'login.wechatOutside': '请在微信中打开本页面以使用微信登录。',
  'login.done': '登录成功。', 'login.failed': '登录未完成：{reason}', 'login.cancelled': '已取消登录。',
  'phone.label': '手机号', 'phone.ph': '11 位手机号', 'phone.send': '获取验证码', 'phone.resend': '{s} 秒后重发',
  'phone.code': '短信验证码', 'phone.submit': '登录', 'phone.verify': '验证', 'phone.sent': '验证码已发送。',
  'phone.devCode': '开发模式，验证码为 {code}', 'phone.title': '验证手机号',
  'phone.why': '手机号用于关联您在本门店的会员储值和存酒，门店也会通过它确认您的预订。',
  'phone.verified': '手机号已验证。',

  'account.title': '我的账户', 'account.hello': '您好，{name}', 'account.guest': '贵宾', 'account.signedVia': '已通过{list}登录',
  'account.phone': '手机号', 'account.noPhone': '未验证', 'account.verify': '验证手机号', 'account.rename': '修改称呼', 'account.name': '称呼',
  'account.logout': '退出登录', 'account.wallet': '储值余额', 'account.noWallet': '您在本门店还没有会员储值，可向服务员咨询充值优惠。',
  'account.walletNeedsPhone': '验证手机号后可查看储值和存酒。', 'account.history': '最近记录',
  'account.stash': '我的存酒', 'account.noStash': '暂无存酒。', 'account.stashLeft': '剩余 {n} 瓶', 'account.expires': '有效期至 {date}',
  'account.stashCode': '取酒码 {code}', 'account.bookings': '我的预订', 'account.noBookings': '暂无预订。', 'account.orders': '最近订单',
  'account.noOrders': '暂无订单。', 'account.saved': '已保存。', 'account.save': '保存', 'account.topUp': '充值', 'account.spent': '消费',
  'provider.wechat': '微信', 'provider.alipay': '支付宝', 'provider.douyin': '抖音', 'provider.phone': '手机号',

  'book.title': '预订卡座', 'book.store': '门店', 'book.when': '到店时间', 'book.party': '人数', 'book.name': '预订人称呼',
  'book.note': '特殊要求（可选）', 'book.notePh': '例如：生日、靠近舞台的卡座', 'book.submit': '提交预订',
  'book.done': '预订已提交，门店会与您确认。', 'book.needPhone': '预订前请先验证手机号，方便门店联系您。',
  'book.cancel': '取消预订', 'book.cancelled': '预订已取消。', 'book.party.n': '{n} 人',
  'bookingStatus.submitted': '待确认', 'bookingStatus.confirmed': '已确认', 'bookingStatus.checked_in': '已到店',
  'bookingStatus.redeemed': '已完成', 'bookingStatus.cancelled': '已取消', 'bookingStatus.no_show': '未到店',
  'foot.text': '由 夜场收银 NightPOS 提供',
};

const DICTS = { en, zh };
let lang = 'zh';

export function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch { /* storage blocked */ }
  lang = LANGS.includes(saved) ? saved : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function setLang(next) {
  lang = LANGS.includes(next) ? next : 'zh';
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage blocked */ }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export const getLang = () => lang;

export function t(key, vars = {}) {
  const s = DICTS[lang][key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const tOr = (key, fallback) => (DICTS[lang][key] ?? en[key] ?? fallback);
