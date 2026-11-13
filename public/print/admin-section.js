// Admin "Printers" section: list, create/edit (with Test print) and delete printers of the current store.
// Only the routing is stored on the server; the address behind each bridge name lives in the bridge's own config file.
import { t, tOr } from '../i18n.js';
import { get, post, patch, del } from '../session.js';
import { html } from '../util.js';
import { formDialog, confirmDialog, dataTable, badge } from '../ui.js';
import { PRINT_LANGS } from './labels.js';
import { testPrint } from './printer.js';

const PRINTER_KINDS = ['receipt', 'bar', 'kitchen', 'label'];
const PAPER_WIDTHS = [58, 80];
const MAX_COPIES = 5;
const BRIDGE_NAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}';

const options = (values, labelOf) => values.map((v) => ({ value: v, label: labelOf(v) }));
const btn = (action, id, label, cls = 'btn--ghost') => html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;

export function printersSection(reload) {
  const dialog = (x) => formDialog({
    title: x ? t('common.edit') : t('admin.addPrinter'),
    intro: t('admin.printerHint'),
    fields: [
      { name: 'name', label: t('admin.name'), required: true, value: x?.name },
      { name: 'kind', label: t('admin.kind'), type: 'select', value: x?.kind ?? 'receipt', options: options(PRINTER_KINDS, (k) => t(`print.kind.${k}`)) },
      { name: 'bridgeName', label: t('admin.bridgeName'), required: true, value: x?.bridgeName, hint: t('admin.bridgeNameHint') },
      { name: 'paperMm', label: t('print.paper'), type: 'select', value: x?.paperMm ?? 80, options: options(PAPER_WIDTHS, (w) => `${w} mm`) },
      { name: 'copies', label: t('admin.copies'), type: 'int', min: 1, max: MAX_COPIES, value: x?.copies ?? 1 },
      { name: 'lang', label: t('print.lang'), type: 'select', value: x?.lang ?? 'both', options: options(PRINT_LANGS, (l) => t(`print.lang.${l}`)) },
      { name: 'enabled', label: t('common.active'), type: 'checkbox', value: x?.enabled ?? true },
    ],
    onSubmit: async (v) => {
      if (!new RegExp(`^${BRIDGE_NAME_PATTERN}$`).test(v.bridgeName)) throw new Error(t('admin.bridgeNameBad'));
      const body = { ...v, paperMm: Number(v.paperMm), copies: v.copies ?? 1 };
      if (x) await patch(`/api/printers/${x.id}`, body); else await post('/api/printers', body);
      await reload();
    },
  });

  return {
    load: () => get('/api/printers'),
    add: 'admin.addPrinter',
    dialog,
    view: (rows) => dataTable({ caption: t('admin.printers'), empty: t('common.noData'), rows, cols: [
      { label: t('admin.name'), cell: (x) => x.name },
      { label: t('admin.kind'), cell: (x) => tOr(`print.kind.${x.kind}`, x.kind) },
      { label: t('admin.bridgeName'), cell: (x) => html`<code>${x.bridgeName}</code>` },
      { label: t('print.paper'), cell: (x) => `${x.paperMm} mm`, num: true },
      { label: t('admin.copies'), cell: (x) => x.copies, num: true },
      { label: t('common.status'), cell: (x) => (x.enabled ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—')) },
      { label: t('common.actions'), cell: (x) => html`<div class="row">${btn('edit', x.id, t('common.edit'))}${btn('testPrinter', x.id, t('admin.testPrint'))}${btn('deletePrinter', x.id, t('common.delete'), 'btn--danger')}</div>` },
    ] }),
  };
}

/** Click handlers for the section's extra buttons; rowOf(el) resolves the clicked row. */
export function printerActions({ rowOf, reload }) {
  return {
    testPrinter: (el) => testPrint(rowOf(el)),
    deletePrinter: async (el) => {
      if (!await confirmDialog({ title: t('common.delete'), message: t('admin.deletePrinterAsk', { name: rowOf(el).name }), danger: true, submit: 'common.delete' })) return;
      await del(`/api/printers/${el.dataset.id}`);
      await reload();
    },
  };
}
