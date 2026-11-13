// Table QR codes (guests scan to order and pay) and the customer-page QR, shown in Admin and printable.
import { t } from './i18n.js';
import { app, post } from './session.js';
import { html, raw } from './util.js';
import { infoDialog, confirmDialog, notifyError } from './ui.js';
import { qrSvg } from './qr.js';

const enc = encodeURIComponent;
const PRINT_WINDOW = 'width=420,height=600';

export const tableQrUrl = (table) => `${location.origin}/g/${enc(app.company.code)}/${enc(app.store.code)}/t/${table.qr_token}`;
const venueUrl = () => `${location.origin}/g/${enc(app.company.code)}/${enc(app.store.code)}`;

/** Opens a bare page holding just the code and its caption, and prints it (the app chrome must not be on the sticker). */
function printQr(svg, caption, sub) {
  const w = window.open('', '_blank', PRINT_WINDOW);
  if (!w) return;
  const style = 'body{margin:0;font-family:sans-serif;text-align:center;color:#000}svg{width:70mm;height:70mm}h1{font-size:20pt;margin:6mm 0 2mm}p{font-size:10pt;margin:0}';
  w.document.write(`<!doctype html><title>${caption}</title><style>${style}</style><h1>${caption}</h1>${svg.replace('var(--color-qr-bg)', '#fff').replace('var(--color-qr-fg)', '#000')}<p>${sub}</p>`);
  w.document.close();
  w.focus();
  w.print();
}

function showQr({ title, url, hint, caption, onRenew }) {
  const svg = qrSvg(url, title) ?? '';
  infoDialog(title, html`<div class="table-qr">${raw(svg)}<p>${hint}</p>
    <p class="table-qr__link">${t('admin.qrLink')}: <a href="${url}" target="_blank" rel="noopener">${url}</a></p>
    <div class="row"><button type="button" class="btn btn--primary" data-qr-print>${t('admin.qrPrint')}</button>
    ${onRenew && html`<button type="button" class="btn btn--danger" data-qr-renew>${t('admin.qrRenew')}</button>`}</div></div>`);
  const dlg = document.querySelector('dialog[open]');
  // Text that goes into the print window is escaped by html`` first.
  dlg.querySelector('[data-qr-print]').addEventListener('click', () => printQr(svg, html`${caption}`.text, html`${app.company.name} · ${app.store.name}`.text));
  dlg.querySelector('[data-qr-renew]')?.addEventListener('click', async () => {
    dlg.close();
    try { await onRenew(); } catch (e) { notifyError(e); }
  });
}

export function showTableQr(table, reload) {
  showQr({
    title: t('admin.qrTitle', { name: table.name }),
    url: tableQrUrl(table),
    hint: t('admin.qrHint'),
    caption: table.name,
    onRenew: async () => {
      if (!await confirmDialog({ title: t('admin.qrRenew'), message: t('admin.qrRenewAsk', { name: table.name }), danger: true, submit: 'admin.qrRenew' })) return;
      const { qrToken } = await post(`/api/tables/${table.id}/qr`);
      await reload();
      showTableQr({ ...table, qr_token: qrToken }, reload);
    },
  });
}

export function showVenueQr() {
  showQr({ title: t('admin.venueQrTitle'), url: venueUrl(), hint: t('admin.venueQrHint'), caption: app.store.name });
}
