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
  'nav.reports': 'Reports', 'nav.admin': 'Admin', 'nav.hq': 'HQ',

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
  'floor.billMeta': 'Bill #{id} · opened {time} · rep {rep}', 'floor.billOpen': 'Open', 'floor.billSettled': 'Settled',
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
  'source.manual': 'Manual', 'source.douyin': 'Douyin',
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
  'nav.reports': '报表', 'nav.admin': '管理', 'nav.hq': '总部',

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
  'floor.billMeta': '账单 #{id} · 开台 {time} · 营销 {rep}', 'floor.billOpen': '进行中', 'floor.billSettled': '已结账',
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
  'source.manual': '手动', 'source.douyin': '抖音',
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
};

const DICT = { en, zh };

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
