// All user-visible strings, English and Simplified Chinese, plus the t() lookup and error mapping.
const LANG_KEY = 'nightpos.lang';
export const LANGS = ['en', 'zh'];

const en = {
  'app.name': 'NightPOS',
  'app.tagline': 'Night venue point of sale',
  'app.title': 'NightPOS · Night venue POS',
  'lang.label': 'Language',
  'lang.en': 'EN',
  'lang.zh': '中文',
  'a11y.skip': 'Skip to content',

  'common.cancel': 'Cancel', 'common.close': 'Close', 'common.save': 'Save', 'common.confirm': 'Confirm',
  'common.create': 'Create', 'common.edit': 'Edit', 'common.delete': 'Delete', 'common.search': 'Search',
  'common.refresh': 'Refresh', 'common.loading': 'Loading', 'common.all': 'All', 'common.actions': 'Actions',
  'common.status': 'Status', 'common.active': 'Active', 'common.inactive': 'Inactive', 'common.noData': 'Nothing to show yet.',

  'err.badAmount': 'Enter a valid amount, such as 12.50.',
  'err.badQty': 'Enter a valid number with up to 3 decimals.',
  'err.network': 'Cannot reach the server. Check the connection.',

  'login.company': 'Company code', 'login.username': 'Username', 'login.pin': 'PIN', 'login.submit': 'Sign in',
  'login.createCompany': 'Create a company', 'login.required': 'Enter company code, username and PIN.',
  'login.expired': 'Your session expired. Please sign in again.',
  'signup.title': 'Create a company', 'signup.intro': 'Sets up your company, first store and an owner account.',
  'signup.company': 'Company name', 'signup.code': 'Company code', 'signup.codeHint': 'Staff type this when signing in. 2 to 31 letters, digits or hyphens.',
  'signup.store': 'First store name', 'signup.ownerName': 'Owner name', 'signup.pinHint': 'At least 6 digits.',
  'signup.submit': 'Create and sign in',

  'shell.store': 'Store', 'shell.logout': 'Sign out', 'shell.nav': 'Main sections',
  'nav.floor': 'Floor', 'nav.bookings': 'Bookings', 'nav.stash': 'Stash', 'nav.members': 'Members',
  'nav.reports': 'Reports', 'nav.admin': 'Admin', 'nav.hq': 'HQ', 'nav.orders': 'Guest orders',
  'guestOrders.intro': 'Orders guests send from the QR code on their table. Accepting puts the items on the table\'s bill (and prints bar/kitchen tickets); a free table is opened first.',
  'guestOrders.status.pending': 'Waiting', 'guestOrders.status.accepted': 'Accepted', 'guestOrders.status.rejected': 'Rejected', 'guestOrders.status.cancelled': 'Cancelled',
  'guestOrders.empty.pending': 'No guest orders waiting.', 'guestOrders.empty.accepted': 'No accepted guest orders yet.', 'guestOrders.empty.rejected': 'No rejected guest orders.',
  'guestOrders.emptyHint': 'Print the table QR codes in Admin > Tables so guests can order from their phones.',
  'guestOrders.table': 'Table {name}', 'guestOrders.guest': 'Guest', 'guestOrders.note': 'Note', 'guestOrders.reason': 'Reason',
  'guestOrders.reasonPh': 'Shown to the guest, e.g. sold out tonight', 'guestOrders.addsToBill': 'Adds to open bill #{id}.',
  'guestOrders.opensTable': 'Table is free: accepting opens it.', 'guestOrders.accept': 'Accept', 'guestOrders.reject': 'Reject',
  'guestOrders.rejectIntro': 'The guest sees this reason on their phone.', 'guestOrders.openTitle': 'Open table {name}',
  'guestOrders.openIntro': 'This table is free. Choose the sales rep who owns it, as when opening it from the floor.',
  'guestOrders.accepted': 'Order for {name} accepted.', 'guestOrders.openBill': 'Open bill', 'guestOrders.badge': '{n} waiting',
  'admin.qr': 'QR', 'admin.qrTitle': 'Table {name} QR code', 'admin.qrHint': 'Print this and place it on the table. Guests scan it to order, see the bill and pay.',
  'admin.qrRenew': 'New code', 'admin.qrRenewAsk': 'Make a new QR code for {name}? Printed copies of the old code stop working.', 'admin.qrPrint': 'Print',
  'admin.venueQr': 'Customer page QR', 'admin.venueQrTitle': 'Customer page', 'admin.venueQrHint': 'For posters, Douyin and WeChat: guests open the menu, book a table and see their wallet.',
  'admin.qrLink': 'Link',

  'role.host': 'Host', 'role.waiter': 'Waiter', 'role.cashier': 'Cashier', 'role.manager': 'Manager',
  'role.finance': 'Finance', 'role.owner': 'Owner',
  'commRole.sales': 'Sales rep', 'commRole.waiter': 'Waiter',

  'floor.tables': 'Tables', 'floor.billPanel': 'Current bill', 'floor.noTables': 'No tables set up yet.',
  'floor.zoneDefault': 'Main floor', 'floor.free': 'Free', 'floor.occupied': 'Occupied',
  'floor.seats': '{n} seats', 'floor.minSpend': 'Min spend', 'floor.billTotal': 'Bill',
  'kind.bar': 'Bar', 'kind.booth': 'Booth', 'kind.room': 'Private room',
  'floor.pickTable': 'Select a table', 'floor.pickTableHint': 'Tap a free table to open it, or an occupied table to see its bill.',
  'floor.openTitle': 'Open table {name}', 'floor.openMinSpend': 'Minimum spend {amount}. The guest pays the difference if they spend less.',
  'floor.rep': 'Sales rep (commission owner)', 'floor.chooseRep': 'Choose a rep', 'floor.repId': 'Sales rep staff ID',
  'floor.repIdHint': 'Your role cannot list staff, so enter the rep\'s staff ID.',
  'floor.phone': 'Phone', 'floor.phoneHint': 'Optional. Links the bill to a member wallet.', 'floor.open': 'Open table', 'floor.cannotOpen': 'Your role cannot open tables.',
  'floor.billMeta': 'Bill #{id} · opened {time} · rep {rep}', 'floor.offlineBillMeta': 'Offline bill (syncs when online) · opened {time} · rep {rep}', 'floor.billOpen': 'Open', 'floor.billSettled': 'Settled',
  'floor.transfer': 'Transfer table', 'floor.toTable': 'Move to table', 'floor.noFreeTables': 'No free tables to move to.',
  'floor.setDiscount': 'Discount', 'floor.discountAmount': 'Discount amount (¥)',
  'floor.items': 'Items', 'floor.noLines': 'No items yet. Add some below.', 'floor.giftTag': 'Gift', 'floor.voidTag': 'Void',
  'floor.void': 'Void', 'floor.addOne': 'Add one more {name}', 'floor.reason': 'Reason', 'floor.giftTitle': 'Gift this item',
  'floor.addItems': 'Add items', 'floor.qty': 'Qty', 'floor.gift': 'Gift', 'floor.search': 'Search products',
  'floor.searchPlaceholder': 'Name…', 'floor.category': 'Category', 'floor.noProducts': 'No matching products.',
  'floor.soldOut': 'Sold out', 'floor.stock': 'Stock {n}',
  'cat.none': 'Uncategorised', 'cat.spirits': 'Spirits', 'cat.beer': 'Beer', 'cat.food': 'Food',
  'floor.subtotal': 'Subtotal', 'floor.topUp': 'Min spend top-up ({min})', 'floor.tableFee': 'Table fee',
  'floor.discount': 'Discount', 'floor.total': 'Total', 'floor.paid': 'Paid', 'floor.due': 'Due',
  'floor.payments': 'Payments', 'floor.takePayment': 'Take payment', 'floor.payAmount': 'Amount (¥), blank = full amount due',
  'floor.cannotSettle': 'Ask a cashier or manager to take payment.',
  'pay.cash': 'Cash', 'pay.member': 'Member wallet', 'pay.credit': 'On account', 'pay.wechat': 'WeChat Pay',
  'pay.alipay': 'Alipay', 'pay.douyin_voucher': 'Douyin voucher',
  'payStatus.paid': 'Paid', 'payStatus.pending': 'Pending', 'payStatus.expired': 'Expired', 'payStatus.failed': 'Failed',
  'floor.creditConfirm': 'Put this amount on the guest\'s account to be collected later?',
  'floor.paidToast': 'Payment of {amount} recorded.', 'floor.settledToast': 'Bill settled. Table is free again.',
  'floor.scanToPay': 'Scan to pay {amount} with {method}', 'floor.qrLabel': 'QR code for {method}',
  'floor.waiting': 'Waiting for payment…', 'floor.simulate': 'Simulate payment success', 'floor.hideQr': 'Hide',
  'floor.onlinePaid': '{method} payment of {amount} received', 'floor.redeem': 'Redeem Douyin voucher',
  'floor.redeemGo': 'Redeem', 'floor.voucherCode': 'Voucher code', 'floor.voucherOk': 'Voucher applied: {amount}',

  'shift.none': 'No open shift', 'shift.open': 'Open shift', 'shift.close': 'Close shift', 'shift.openSince': 'Shift open since {time}',
  'shift.expected': 'Expected cash', 'shift.openingCash': 'Opening cash (¥)', 'shift.counted': 'Counted cash',
  'shift.variance': 'Variance', 'shift.balanced': 'balanced', 'shift.over': 'over', 'shift.short': 'short',
  'shift.closeIntro': 'Count the drawer. Expected cash is {expected}.', 'shift.closed': 'Shift closed', 'shift.stillOpen': 'Open',

  'bookings.create': 'New booking', 'bookings.eta': 'Arrival', 'bookings.guest': 'Guest', 'bookings.name': 'Guest name',
  'bookings.party': 'Party', 'bookings.source': 'Source', 'bookings.table': 'Table', 'bookings.status': 'Status',
  'bookings.noTable': 'Not assigned', 'bookings.chooseTable': 'Choose a table', 'bookings.confirm': 'Confirm',
  'bookings.openTable': 'Open table', 'bookings.cancel': 'Cancel', 'bookings.noShow': 'No-show',
  'bookings.cancelAsk': 'Mark the booking for {name} as released?', 'bookings.empty': 'No upcoming bookings.',
  'source.manual': 'Manual', 'source.douyin': 'Douyin', 'source.guest': 'Customer app',
  'bookingStatus.submitted': 'Awaiting confirmation', 'bookingStatus.confirmed': 'Confirmed',

  'stash.search': 'Phone or stash code', 'stash.searchPlaceholder': 'Phone or code', 'stash.searchHint': 'Search by phone or code to see stored bottles.',
  'stash.store': 'Store wine', 'stash.stored': 'Stored. Code: {code}', 'stash.none': 'Nothing stored for that search.',
  'stash.code': 'Code', 'stash.item': 'Item', 'stash.left': 'Left / total (bottles)', 'stash.kind': 'Type', 'stash.expires': 'Expires',
  'stash.expired': 'Expired', 'stash.daysLeft': '{n} days left', 'stash.bottles': 'Bottles', 'stash.bottlesHint': 'Decimals allowed, e.g. 0.5.',
  'stash.days': 'Days to keep', 'stash.daysHint': 'Optional. Blank uses the default.', 'stashKind.purchased': 'Purchased', 'stashKind.free': 'Complimentary',
  'stash.retrieve': 'Retrieve', 'stash.retrieveTitle': 'Retrieve {name}', 'stash.toBill': 'Add to bill', 'stash.noOpenBills': 'There are no open bills to add it to.',
  'stash.transfer': 'Transfer', 'stash.toStore': 'Destination store', 'stash.toStoreId': 'Destination store ID',

  'members.search': 'Phone or name', 'members.searchPlaceholder': 'Search members', 'members.name': 'Name', 'members.balance': 'Wallet balance',
  'members.empty': 'No members found.', 'members.topup': 'Top up', 'members.topupIntro': 'The wallet works in every store of your company.',
  'members.amount': 'Amount paid (¥)', 'members.bonus': 'Bonus (¥)', 'members.bonusHint': 'Extra credit added on top.',
  'members.topupDone': 'Top-up done. New balance {balance}.',

  'reports.daily': 'Daily', 'reports.payroll': 'Payroll', 'reports.shifts': 'Shifts', 'reports.receivables': 'Receivables', 'reports.audit': 'Audit log',
  'reports.date': 'Date', 'reports.from': 'From', 'reports.to': 'To', 'reports.bills': 'Bills', 'reports.revenue': 'Revenue', 'reports.voids': 'Voids', 'reports.gifts': 'Gifts',
  'reports.discounts': 'Discounts', 'reports.byMethod': 'By payment method', 'reports.topItems': 'Top items', 'reports.method': 'Method',
  'reports.count': 'Count', 'reports.amount': 'Amount', 'reports.employee': 'Employee', 'reports.role': 'Role', 'reports.store': 'Store',
  'reports.commission': 'Commission', 'reports.total': 'Total', 'reports.allStores': 'All stores', 'reports.cashier': 'Cashier',
  'reports.opened': 'Opened', 'reports.closed': 'Closed', 'reports.bill': 'Bill', 'reports.collected': 'Collected',
  'reports.outstanding': 'Outstanding', 'reports.collect': 'Collect', 'reports.cleared': 'Cleared', 'reports.leftToast': 'Collected. Outstanding now {amount}.',
  'collect.cash': 'Cash', 'collect.wechat': 'WeChat', 'collect.alipay': 'Alipay', 'collect.transfer': 'Bank transfer',
  'reports.time': 'Time', 'reports.actor': 'Actor', 'reports.action': 'Action', 'reports.entity': 'Record', 'reports.detail': 'Detail',

  'admin.tables': 'Tables', 'admin.products': 'Products', 'admin.rules': 'Commission rules', 'admin.staff': 'Staff',
  'admin.addTable': 'Add table', 'admin.addProduct': 'Add product', 'admin.addRule': 'Add rule', 'admin.name': 'Name',
  'admin.zone': 'Zone', 'admin.kind': 'Type', 'admin.capacity': 'Seats', 'admin.nameEn': 'English name', 'admin.category': 'Category',
  'admin.categoryHint': 'e.g. spirits, beer, food', 'admin.price': 'Price (¥)', 'admin.stock': 'Stock', 'admin.trackStock': 'Track stock',
  'admin.adjustStock': 'Adjust stock', 'admin.stockTitle': 'Adjust stock: {name}', 'admin.stockNow': 'Current stock: {n}',
  'admin.delta': 'Change', 'admin.deltaHint': 'Positive adds stock, negative removes it.',
  'admin.appliesTo': 'Applies to', 'admin.rate': 'Rate', 'admin.fixed': 'Fixed per item (¥)', 'admin.product': 'Product',
  'admin.ratePercent': 'Rate (%)', 'admin.ratePercentHint': 'e.g. 5 for 5%.', 'admin.ruleHint': 'A product rule beats a category rule, which beats the default.',
  'admin.deleteRuleAsk': 'Delete this commission rule?', 'admin.allStores': 'All stores', 'admin.deactivate': 'Deactivate',
  'admin.activate': 'Reactivate', 'admin.deactivateAsk': '{name} will be signed out and unable to log in. Continue?',
  'admin.resetPin': 'Reset PIN', 'admin.newPin': 'New PIN',

  'hq.today': 'Today', 'hq.week': 'Last 7 days', 'hq.month': 'Last 30 days', 'hq.range': 'Date range',
  'hq.bills': 'Bills', 'hq.credit': 'On account', 'hq.openBills': 'Open bills', 'hq.stashItems': 'Stash items',
  'hq.copy': 'Copy', 'hq.createStore': 'New store', 'hq.createStaff': 'New staff', 'hq.copyCatalog': 'Copy catalog', 'hq.storeCode': 'Store code',
  'hq.poi': 'Douyin POI ID (optional)', 'hq.copyFrom': 'Copy catalog from', 'hq.noCopy': 'Start empty', 'hq.copyTo': 'Copy to',
  'hq.copyHint': 'Copies active products and commission rules into the selected stores.', 'hq.pickStores': 'Pick at least one store.',
  'hq.copied': 'Copied {products} products to {stores} store(s).', 'hq.usernameHint': '2 to 32 letters, digits, dot, dash or underscore.',
  'hq.storeHint': 'Ignored for finance and owner, who see every store.', 'hq.staffCreated': 'Created {name}.',

  'print.header': 'Printing', 'print.title': 'Printing', 'print.receipt': 'Print receipt', 'print.slip': 'Print slip',
  'print.intro': 'Receipts and tickets print through a small bridge program on a PC in the venue, so they keep printing when the internet is down. These settings apply to this device only.',
  'print.bridgeUrl': 'Bridge address', 'print.token': 'Bridge token',
  'print.tokenHint': 'Copy it from the bridge config file on the venue PC. Leave it empty to print through the browser only.',
  'print.test': 'Test connection', 'print.testing': 'Checking…', 'print.bridgeOk': 'Bridge v{version} is reachable. Printers: {names}',
  'print.paper': 'Paper width', 'print.paperHint': 'Used for browser printing. Thermal printers use the width set in Admin.',
  'print.lang': 'Receipt language', 'print.lang.both': 'English + 中文', 'print.lang.zh': '中文', 'print.lang.en': 'English',
  'print.footer': 'Receipt footer text', 'print.autoTitle': 'Automatic printing',
  'print.autoReceipt': 'Print the receipt when a bill is paid', 'print.autoTickets': 'Print kitchen and bar tickets when items are added',
  'print.autoStash': 'Print a slip after storing wine', 'print.autoShift': 'Print the shift report when a shift is closed',
  'print.fallback': 'Open the browser print dialog when the bridge cannot be reached',
  'print.badUrl': 'The bridge address must look like http://127.0.0.1:9101 (this computer only).', 'print.saved': 'Printing settings saved.',
  'print.log': 'Recent print jobs', 'print.logEmpty': 'No print jobs yet on this device.', 'print.reprint': 'Reprint',
  'print.status.ok': 'Printed', 'print.status.failed': 'Failed', 'print.status.fallback': 'Browser', 'print.status.pending': 'Sending',
  'print.sent': 'Sent to {name}.', 'print.failed': 'Could not print to {name}: {error}. It is saved in the print log.',
  'print.noPrinter': 'No {kind} printer is set up for this store. Add one in Admin.',
  'print.kind.receipt': 'Receipt', 'print.kind.bar': 'Bar', 'print.kind.kitchen': 'Kitchen', 'print.kind.label': 'Label / stash',
  'print.fallbackOpened': 'Bridge unavailable: opened the browser print dialog instead.',
  'print.needSettings': 'Set the bridge address and token on this device first (header, Printing).',
  'print.noModel': 'This job is too old to reprint.', 'print.browser': 'Browser',
  'print.err.bridge': 'Cannot reach the print bridge. Is it running on this computer?', 'print.err.token': 'The bridge rejected the token. Check it in Printing settings.',
  'admin.printers': 'Printers', 'admin.addPrinter': 'Add printer', 'admin.bridgeName': 'Bridge printer name', 'admin.copies': 'Copies',
  'admin.printerHint': 'Pick what this printer is for. Its network address stays in the bridge config on the venue PC, never here.',
  'admin.bridgeNameHint': 'Exactly the name in the bridge config file (not an IP address).',
  'admin.bridgeNameBad': 'Letters, digits, space, dot, dash or underscore only, up to 64 characters.',
  'admin.testPrint': 'Test print', 'admin.deletePrinterAsk': 'Delete printer {name}?',
  'admin.station': 'Station', 'admin.stationHint': 'Where item tickets print when this product is ordered.',
  'station.none': 'None', 'station.bar': 'Bar', 'station.kitchen': 'Kitchen',
};

const zh = {
  'app.name': '夜场收银',
  'app.tagline': '夜场门店收银系统',
  'app.title': '夜场收银 · NightPOS',
  'lang.label': '语言',
  'lang.en': 'EN',
  'lang.zh': '中文',
  'a11y.skip': '跳到主要内容',

  'common.cancel': '取消', 'common.close': '关闭', 'common.save': '保存', 'common.confirm': '确认',
  'common.create': '创建', 'common.edit': '编辑', 'common.delete': '删除', 'common.search': '搜索',
  'common.refresh': '刷新', 'common.loading': '加载中', 'common.all': '全部', 'common.actions': '操作',
  'common.status': '状态', 'common.active': '启用', 'common.inactive': '停用', 'common.noData': '暂无数据。',

  'err.badAmount': '请输入有效金额，例如 12.50。',
  'err.badQty': '请输入有效数字，最多三位小数。',
  'err.network': '无法连接服务器，请检查网络。',

  'login.company': '公司代码', 'login.username': '用户名', 'login.pin': 'PIN 码', 'login.submit': '登录',
  'login.createCompany': '创建公司', 'login.required': '请填写公司代码、用户名和 PIN 码。',
  'login.expired': '登录已过期，请重新登录。',
  'signup.title': '创建公司', 'signup.intro': '将创建公司、第一家门店和店主账号。',
  'signup.company': '公司名称', 'signup.code': '公司代码', 'signup.codeHint': '员工登录时需要输入。2 至 31 位字母、数字或连字符。',
  'signup.store': '第一家门店名称', 'signup.ownerName': '店主姓名', 'signup.pinHint': '至少 6 位数字。',
  'signup.submit': '创建并登录',

  'shell.store': '门店', 'shell.logout': '退出登录', 'shell.nav': '主要栏目',
  'nav.floor': '前台', 'nav.bookings': '订座', 'nav.stash': '存酒', 'nav.members': '会员',
  'nav.reports': '报表', 'nav.admin': '管理', 'nav.hq': '总部', 'nav.orders': '扫码点单',
  'guestOrders.intro': '客人扫描桌上二维码提交的订单。接单后商品计入该台账单（并打印吧台/厨房单）；空台会先开台。',
  'guestOrders.status.pending': '待处理', 'guestOrders.status.accepted': '已接单', 'guestOrders.status.rejected': '已拒绝', 'guestOrders.status.cancelled': '已取消',
  'guestOrders.empty.pending': '暂无待处理的扫码订单。', 'guestOrders.empty.accepted': '暂无已接的扫码订单。', 'guestOrders.empty.rejected': '暂无被拒绝的扫码订单。',
  'guestOrders.emptyHint': '在 管理 > 台位 中打印台位二维码，客人即可用手机点单。',
  'guestOrders.table': '{name} 台', 'guestOrders.guest': '客人', 'guestOrders.note': '备注', 'guestOrders.reason': '原因',
  'guestOrders.reasonPh': '会显示给客人，例如：今晚已售罄', 'guestOrders.addsToBill': '将加入已开账单 #{id}。',
  'guestOrders.opensTable': '空台：接单时将开台。', 'guestOrders.accept': '接单', 'guestOrders.reject': '拒绝',
  'guestOrders.rejectIntro': '客人会在手机上看到这个原因。', 'guestOrders.openTitle': '开台 {name}',
  'guestOrders.openIntro': '该台位空闲。请选择负责该台的销售（与在台位图开台相同）。',
  'guestOrders.accepted': '{name} 的订单已接。', 'guestOrders.openBill': '打开账单', 'guestOrders.badge': '{n} 单待处理',
  'admin.qr': '二维码', 'admin.qrTitle': '{name} 台二维码', 'admin.qrHint': '打印后放在桌上。客人扫码即可点单、查看账单和买单。',
  'admin.qrRenew': '换新码', 'admin.qrRenewAsk': '为 {name} 生成新二维码？已打印的旧码将失效。', 'admin.qrPrint': '打印',
  'admin.venueQr': '顾客页面二维码', 'admin.venueQrTitle': '顾客页面', 'admin.venueQrHint': '用于海报、抖音、微信：客人可查看酒水单、预订卡座、查询储值。',
  'admin.qrLink': '链接',

  'role.host': '迎宾', 'role.waiter': '服务员', 'role.cashier': '收银', 'role.manager': '经理',
  'role.finance': '财务', 'role.owner': '店主',
  'commRole.sales': '营销', 'commRole.waiter': '服务员',

  'floor.tables': '台位', 'floor.billPanel': '当前账单', 'floor.noTables': '还没有设置台位。',
  'floor.zoneDefault': '大厅', 'floor.free': '空闲', 'floor.occupied': '占用',
  'floor.seats': '{n} 座', 'floor.minSpend': '低消', 'floor.billTotal': '账单',
  'kind.bar': '吧台', 'kind.booth': '卡座', 'kind.room': '包厢',
  'floor.pickTable': '请选择台位', 'floor.pickTableHint': '点空闲台位开台，点占用台位查看账单。',
  'floor.openTitle': '开台 {name}', 'floor.openMinSpend': '最低消费 {amount}，不足部分由客人补齐。',
  'floor.rep': '营销（提成归属）', 'floor.chooseRep': '请选择营销', 'floor.repId': '营销员工编号',
  'floor.repIdHint': '当前角色无法查看员工列表，请直接输入营销的员工编号。',
  'floor.phone': '手机号', 'floor.phoneHint': '选填，用于关联会员钱包。', 'floor.open': '开台', 'floor.cannotOpen': '当前角色无权开台。',
  'floor.billMeta': '账单 #{id} · 开台 {time} · 营销 {rep}', 'floor.offlineBillMeta': '离线账单（联网后同步） · 开台 {time} · 营销 {rep}', 'floor.billOpen': '进行中', 'floor.billSettled': '已结账',
  'floor.transfer': '转台', 'floor.toTable': '转到台位', 'floor.noFreeTables': '没有可转入的空闲台位。',
  'floor.setDiscount': '折扣', 'floor.discountAmount': '优惠金额（¥）',
  'floor.items': '消费明细', 'floor.noLines': '还没有点单，请在下方添加。', 'floor.giftTag': '赠送', 'floor.voidTag': '已作废',
  'floor.void': '作废', 'floor.addOne': '再加一份{name}', 'floor.reason': '原因', 'floor.giftTitle': '赠送此商品',
  'floor.addItems': '点单', 'floor.qty': '数量', 'floor.gift': '赠送', 'floor.search': '搜索商品',
  'floor.searchPlaceholder': '商品名…', 'floor.category': '分类', 'floor.noProducts': '没有匹配的商品。',
  'floor.soldOut': '已售罄', 'floor.stock': '库存 {n}',
  'cat.none': '未分类', 'cat.spirits': '洋酒', 'cat.beer': '啤酒', 'cat.food': '小食',
  'floor.subtotal': '小计', 'floor.topUp': '低消补差（低消 {min}）', 'floor.tableFee': '台费',
  'floor.discount': '优惠', 'floor.total': '应收', 'floor.paid': '已付', 'floor.due': '待付',
  'floor.payments': '付款记录', 'floor.takePayment': '收款', 'floor.payAmount': '金额（¥），留空为全部待付',
  'floor.cannotSettle': '请联系收银或经理收款。',
  'pay.cash': '现金', 'pay.member': '会员钱包', 'pay.credit': '挂账', 'pay.wechat': '微信支付',
  'pay.alipay': '支付宝', 'pay.douyin_voucher': '抖音券',
  'payStatus.paid': '已付', 'payStatus.pending': '待支付', 'payStatus.expired': '已过期', 'payStatus.failed': '失败',
  'floor.creditConfirm': '将此金额记入客人账上，日后收款？',
  'floor.paidToast': '已记录收款 {amount}。', 'floor.settledToast': '账单已结清，台位已释放。',
  'floor.scanToPay': '请扫码支付 {amount}（{method}）', 'floor.qrLabel': '{method} 付款二维码',
  'floor.waiting': '等待付款…', 'floor.simulate': '模拟支付成功', 'floor.hideQr': '隐藏',
  'floor.onlinePaid': '已收到 {method} 付款 {amount}', 'floor.redeem': '核销抖音券',
  'floor.redeemGo': '核销', 'floor.voucherCode': '券码', 'floor.voucherOk': '核销成功：{amount}',

  'shift.none': '未开班', 'shift.open': '开班', 'shift.close': '交班', 'shift.openSince': '{time} 开班',
  'shift.expected': '应有现金', 'shift.openingCash': '备用金（¥）', 'shift.counted': '清点现金',
  'shift.variance': '差异', 'shift.balanced': '账实相符', 'shift.over': '长款', 'shift.short': '短款',
  'shift.closeIntro': '请清点钱箱。应有现金为 {expected}。', 'shift.closed': '已交班', 'shift.stillOpen': '进行中',

  'bookings.create': '新建订座', 'bookings.eta': '到店时间', 'bookings.guest': '客人', 'bookings.name': '客人姓名',
  'bookings.party': '人数', 'bookings.source': '来源', 'bookings.table': '台位', 'bookings.status': '状态',
  'bookings.noTable': '未分配', 'bookings.chooseTable': '请选择台位', 'bookings.confirm': '确认',
  'bookings.openTable': '开台', 'bookings.cancel': '取消订座', 'bookings.noShow': '未到店',
  'bookings.cancelAsk': '确定释放 {name} 的订座吗？', 'bookings.empty': '暂无待到店订座。',
  'source.manual': '手动', 'source.douyin': '抖音', 'source.guest': '顾客端',
  'bookingStatus.submitted': '待确认', 'bookingStatus.confirmed': '已确认',

  'stash.search': '手机号或存酒码', 'stash.searchPlaceholder': '手机号或存酒码', 'stash.searchHint': '输入手机号或存酒码查询寄存的酒。',
  'stash.store': '存酒', 'stash.stored': '已存酒，存酒码：{code}', 'stash.none': '没有查到寄存记录。',
  'stash.code': '存酒码', 'stash.item': '商品', 'stash.left': '剩余 / 总量（瓶）', 'stash.kind': '类型', 'stash.expires': '到期',
  'stash.expired': '已过期', 'stash.daysLeft': '剩 {n} 天', 'stash.bottles': '瓶数', 'stash.bottlesHint': '可填小数，如 0.5。',
  'stash.days': '保存天数', 'stash.daysHint': '选填，留空使用默认值。', 'stashKind.purchased': '购买', 'stashKind.free': '赠送',
  'stash.retrieve': '取酒', 'stash.retrieveTitle': '取酒：{name}', 'stash.toBill': '加入账单', 'stash.noOpenBills': '当前没有可加入的进行中账单。',
  'stash.transfer': '转店', 'stash.toStore': '目标门店', 'stash.toStoreId': '目标门店编号',

  'members.search': '手机号或姓名', 'members.searchPlaceholder': '搜索会员', 'members.name': '姓名', 'members.balance': '钱包余额',
  'members.empty': '没有找到会员。', 'members.topup': '充值', 'members.topupIntro': '钱包在公司所有门店通用。',
  'members.amount': '实付金额（¥）', 'members.bonus': '赠送金额（¥）', 'members.bonusHint': '额外赠送的储值。',
  'members.topupDone': '充值成功，当前余额 {balance}。',

  'reports.daily': '日报', 'reports.payroll': '提成', 'reports.shifts': '班次', 'reports.receivables': '挂账', 'reports.audit': '操作日志',
  'reports.date': '日期', 'reports.from': '开始', 'reports.to': '结束', 'reports.bills': '账单数', 'reports.revenue': '营业额', 'reports.voids': '作废', 'reports.gifts': '赠送',
  'reports.discounts': '优惠', 'reports.byMethod': '按支付方式', 'reports.topItems': '热销商品', 'reports.method': '方式',
  'reports.count': '笔数', 'reports.amount': '金额', 'reports.employee': '员工', 'reports.role': '角色', 'reports.store': '门店',
  'reports.commission': '提成', 'reports.total': '合计', 'reports.allStores': '所有门店', 'reports.cashier': '收银员',
  'reports.opened': '开始', 'reports.closed': '结束', 'reports.bill': '账单', 'reports.collected': '已收回',
  'reports.outstanding': '未收', 'reports.collect': '收款', 'reports.cleared': '已结清', 'reports.leftToast': '已收款，剩余未收 {amount}。',
  'collect.cash': '现金', 'collect.wechat': '微信', 'collect.alipay': '支付宝', 'collect.transfer': '转账',
  'reports.time': '时间', 'reports.actor': '操作人', 'reports.action': '动作', 'reports.entity': '对象', 'reports.detail': '详情',

  'admin.tables': '台位', 'admin.products': '商品', 'admin.rules': '提成规则', 'admin.staff': '员工',
  'admin.addTable': '添加台位', 'admin.addProduct': '添加商品', 'admin.addRule': '添加规则', 'admin.name': '名称',
  'admin.zone': '区域', 'admin.kind': '类型', 'admin.capacity': '座位数', 'admin.nameEn': '英文名', 'admin.category': '分类',
  'admin.categoryHint': '如 spirits、beer、food', 'admin.price': '价格（¥）', 'admin.stock': '库存', 'admin.trackStock': '管理库存',
  'admin.adjustStock': '调整库存', 'admin.stockTitle': '调整库存：{name}', 'admin.stockNow': '当前库存：{n}',
  'admin.delta': '变动数量', 'admin.deltaHint': '正数入库，负数出库。',
  'admin.appliesTo': '适用范围', 'admin.rate': '比例', 'admin.fixed': '每件固定（¥）', 'admin.product': '商品',
  'admin.ratePercent': '比例（%）', 'admin.ratePercentHint': '例如 5 表示 5%。', 'admin.ruleHint': '商品规则优先于分类规则，分类规则优先于默认规则。',
  'admin.deleteRuleAsk': '确定删除这条提成规则吗？', 'admin.allStores': '所有门店', 'admin.deactivate': '停用',
  'admin.activate': '重新启用', 'admin.deactivateAsk': '{name} 将被强制退出且无法登录，继续吗？',
  'admin.resetPin': '重置 PIN', 'admin.newPin': '新 PIN 码',

  'hq.today': '今天', 'hq.week': '近 7 天', 'hq.month': '近 30 天', 'hq.range': '日期范围',
  'hq.bills': '账单数', 'hq.credit': '挂账', 'hq.openBills': '未结账单', 'hq.stashItems': '寄存件数',
  'hq.copy': '复制', 'hq.createStore': '新建门店', 'hq.createStaff': '新建员工', 'hq.copyCatalog': '复制商品库', 'hq.storeCode': '门店代码',
  'hq.poi': '抖音 POI ID（选填）', 'hq.copyFrom': '复制商品库来源', 'hq.noCopy': '从空白开始', 'hq.copyTo': '复制到',
  'hq.copyHint': '把启用的商品和提成规则复制到所选门店。', 'hq.pickStores': '请至少选择一家门店。',
  'hq.copied': '已复制 {products} 件商品到 {stores} 家门店。', 'hq.usernameHint': '2 至 32 位字母、数字、点、横线或下划线。',
  'hq.storeHint': '财务和店主可查看所有门店，此项对其无效。', 'hq.staffCreated': '已创建 {name}。',

  'print.header': '打印', 'print.title': '打印设置', 'print.receipt': '打印小票', 'print.slip': '打印凭条',
  'print.intro': '小票和单据通过店内电脑上的打印桥接程序出单，网络中断时也能继续打印。以下设置仅对本设备生效。',
  'print.bridgeUrl': '桥接程序地址', 'print.token': '桥接口令',
  'print.tokenHint': '从店内电脑的桥接配置文件中复制。留空则只使用浏览器打印。',
  'print.test': '测试连接', 'print.testing': '检查中…', 'print.bridgeOk': '桥接程序 v{version} 已连接。打印机：{names}',
  'print.paper': '纸宽', 'print.paperHint': '用于浏览器打印。热敏打印机使用后台设置的纸宽。',
  'print.lang': '小票语言', 'print.lang.both': '中英双语', 'print.lang.zh': '中文', 'print.lang.en': 'English',
  'print.footer': '小票页脚文字', 'print.autoTitle': '自动打印',
  'print.autoReceipt': '结账后自动打印小票', 'print.autoTickets': '加单时自动打印厨房/吧台单',
  'print.autoStash': '寄存酒水后自动打印凭条', 'print.autoShift': '关班时自动打印班次报表',
  'print.fallback': '无法连接桥接程序时，打开浏览器打印窗口',
  'print.badUrl': '桥接程序地址须形如 http://127.0.0.1:9101（仅限本机）。', 'print.saved': '打印设置已保存。',
  'print.log': '最近的打印任务', 'print.logEmpty': '本设备暂无打印记录。', 'print.reprint': '重印',
  'print.status.ok': '已打印', 'print.status.failed': '失败', 'print.status.fallback': '浏览器', 'print.status.pending': '发送中',
  'print.sent': '已发送到 {name}。', 'print.failed': '无法打印到 {name}：{error}。已保存在打印记录中，可重印。',
  'print.noPrinter': '本店尚未设置{kind}打印机，请在后台添加。',
  'print.kind.receipt': '小票', 'print.kind.bar': '吧台', 'print.kind.kitchen': '厨房', 'print.kind.label': '标签/寄存',
  'print.fallbackOpened': '桥接程序不可用，已改用浏览器打印。',
  'print.needSettings': '请先在本设备的“打印”设置中填写桥接地址和口令。',
  'print.noModel': '该任务已无法重印。', 'print.browser': '浏览器',
  'print.err.bridge': '无法连接打印桥接程序，请确认它已在本机运行。', 'print.err.token': '桥接程序拒绝了口令，请在打印设置中检查。',
  'admin.printers': '打印机', 'admin.addPrinter': '添加打印机', 'admin.bridgeName': '桥接打印机名称', 'admin.copies': '份数',
  'admin.printerHint': '选择这台打印机的用途。网络地址只保存在店内电脑的桥接配置中，不会放在这里。',
  'admin.bridgeNameHint': '须与桥接配置文件中的名称完全一致（不是 IP 地址）。',
  'admin.bridgeNameBad': '仅限字母、数字、空格、点、横线、下划线，最长 64 位。',
  'admin.testPrint': '测试打印', 'admin.deletePrinterAsk': '删除打印机 {name}？',
  'admin.station': '出单站', 'admin.stationHint': '点此商品时在哪里出单。',
  'station.none': '不出单', 'station.bar': '吧台', 'station.kitchen': '厨房',
};

const DICT = { en, zh };

/** Lets a feature module bring its own strings: addStrings({ en: {...}, zh: {...} }). */
export function addStrings(extra) {
  Object.assign(en, extra.en);
  Object.assign(zh, extra.zh);
}

const ERRORS_ZH = {
  'invalid credentials': '公司代码、用户名或 PIN 码不正确。',
  unauthenticated: '登录已失效，请重新登录。',
  'too many attempts, try again in a few minutes': '尝试次数过多，请几分钟后再试。',
  'rate limit exceeded': '请求过于频繁，请稍后再试。',
  'network error': '无法连接服务器，请检查网络。',
  'table already occupied': '该台位已有客人。',
  'target table is not free': '目标台位不是空闲状态。',
  'table not found': '找不到该台位。',
  'bill not found': '找不到该账单。',
  'product not found': '找不到该商品。',
  'sales rep (repId) is required to open a table': '开台必须选择营销。',
  'sales rep not found in this store': '本店没有这位营销。',
  'insufficient member balance': '会员钱包余额不足。',
  'bill has no member': '这张账单没有绑定会员手机号。',
  'nothing due': '没有待付金额。',
  'gift requires a reason': '赠送需要填写原因。',
  'void requires a reason': '作废需要填写原因。',
  'discount requires a reason': '优惠需要填写原因。',
  'not enough left in stash': '寄存余量不足。',
  'stash expired': '这份寄存已过期。',
  'you already have an open shift': '你已经有一个进行中的班次。',
  'no open shift': '当前没有进行中的班次。',
  'voucher invalid or already used': '券码无效或已被使用。',
  'voucher already redeemed': '该券已核销。',
  'collection exceeds the outstanding amount': '收款金额超过未收金额。',
  'table name already used': '台位名称已存在。',
  'product name already used': '商品名称已存在。',
  'self sign-up is disabled': '未开放自助注册。',
  'phone required': '请填写手机号。',
  'member not found': '找不到该会员。',
};

const ERROR_PATTERNS_ZH = [
  [/^role (\w+) may not (.+)$/, (m) => `当前角色（${m[1]}）无权执行此操作（${m[2]}）。`],
  [/^(\w+) payments are not configured for this server$/, (m) => `服务器尚未配置 ${m[1]} 支付。`],
  [/needs at least (\d+)/, (m) => `PIN 码至少需要 ${m[1]} 位。`],
  [/^(bill|booking|stash) is (\w+)$/, (m) => `当前状态为 ${m[2]}，无法执行此操作。`],
];

let lang = 'en';

export const getLang = () => lang;

export function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch { /* storage blocked */ }
  lang = LANGS.includes(saved) ? saved : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function setLang(next) {
  lang = LANGS.includes(next) ? next : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage blocked */ }
}

const fill = (text, params) => text.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));

export function t(key, params = {}) {
  return fill(DICT[lang][key] ?? DICT.en[key] ?? key, params);
}

/** Like t(), but falls back to `fallback` (e.g. a server-provided value) when the key is unknown. */
export function tOr(key, fallback) {
  return DICT[lang][key] ?? DICT.en[key] ?? fallback;
}

export function errorText(error) {
  const message = error?.message ?? String(error);
  if (lang === 'en') return message === 'network error' ? t('err.network') : message;
  if (ERRORS_ZH[message]) return ERRORS_ZH[message];
  for (const [pattern, toText] of ERROR_PATTERNS_ZH) {
    const match = pattern.exec(message);
    if (match) return toText(match);
  }
  return message;
}
