// Text printed on paper. Separate from public/i18n.js on purpose: a receipt can be bilingual ("Total 合计")
// whatever language the screen is in, which the single-language t() lookup cannot express.
const LABELS = {
  receipt: ['Receipt', '收据'],
  preBill: ['Bill (unpaid)', '账单（未结）'],
  bill: ['Bill', '账单'],
  table: ['Table', '台位'],
  opened: ['Opened', '开台'],
  closed: ['Closed', '结账'],
  cashier: ['Cashier', '收银'],
  sales: ['Sales', '营销'],
  item: ['Item', '品名'],
  gift: ['Gift', '赠送'],
  subtotal: ['Subtotal', '小计'],
  topUp: ['Min spend top-up', '低消补差'],
  tableFee: ['Table fee', '台费'],
  discount: ['Discount', '优惠'],
  total: ['Total', '合计'],
  paid: ['Paid', '已付'],
  due: ['Due', '待付'],
  payments: ['Payments', '支付'],
  thanks: ['Thank you!', '谢谢惠顾'],
  bar: ['BAR', '吧台'],
  kitchen: ['KITCHEN', '厨房'],
  ticketTable: ['Table', '台位'],
  waiter: ['Waiter', '服务员'],
  time: ['Time', '时间'],
  items: ['items', '项'],
  stash: ['WINE STASH', '寄存凭条'],
  stashCode: ['Pickup code', '取酒码'],
  phone: ['Phone', '手机'],
  product: ['Item', '酒品'],
  bottlesLeft: ['Left', '剩余'],
  bottlesUnit: ['btl', '瓶'],
  stored: ['Stored', '存入'],
  expires: ['Expires', '到期'],
  kind: ['Type', '类型'],
  keepSlip: ['Keep this slip', '请保管好此凭条'],
  shiftReport: ['Shift report', '班次报表'],
  shiftOpened: ['Opened', '开班'],
  shiftClosed: ['Closed', '关班'],
  openingCash: ['Opening cash', '备用金'],
  expectedCash: ['Expected cash', '应有现金'],
  countedCash: ['Counted cash', '清点现金'],
  variance: ['Variance', '差额'],
  byMethod: ['Takings by method', '分渠道收入'],
  testTitle: ['TEST PRINT', '测试打印'],
  testPrinter: ['Printer', '打印机'],
  testPaper: ['Paper', '纸宽'],
  testSample: ['Sample', '样张'],
  'pay.cash': ['Cash', '现金'],
  'pay.member': ['Member wallet', '会员钱包'],
  'pay.credit': ['On account', '挂账'],
  'pay.wechat': ['WeChat Pay', '微信支付'],
  'pay.alipay': ['Alipay', '支付宝'],
  'pay.douyin_voucher': ['Douyin voucher', '抖音券'],
  'kind.purchased': ['Purchased', '已购'],
  'kind.free': ['Complimentary', '赠送'],
};

export const PRINT_LANGS = ['both', 'zh', 'en'];

/** One label in the requested language, or both ("Total 合计"). Unknown keys fall back to the key itself. */
export function label(key, lang = 'both') {
  const pair = LABELS[key];
  if (!pair) return key;
  if (lang === 'en') return pair[0];
  if (lang === 'zh') return pair[1];
  return `${pair[0]} ${pair[1]}`;
}

/** A product or payment-method name for the paper: the Chinese name is the master, the English one is optional. */
export function nameFor(name, nameEn, lang) {
  if (lang === 'en') return nameEn || name;
  return name;
}

/** Second line shown under the Chinese name when the receipt is bilingual. */
export function subNameFor(name, nameEn, lang) {
  return lang === 'both' && nameEn && nameEn !== name ? nameEn : '';
}
