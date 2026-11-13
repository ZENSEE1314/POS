// Fallback when no bridge is reachable: the same print model rendered as HTML at thermal-paper width and sent to
// window.print(). Pure string building (modelToHtml) is separate from the DOM/print step (printModelHtml).
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SAFETY_CLEANUP_MS = 120_000;
const HOST_CLASS = 'rcpt-host';
const PAGE_STYLE_ID = 'rcpt-page-style';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SIZE_CLASS = { 2: ' rcpt__s2', 3: ' rcpt__s3' };

export function modelToHtml(model, paperMm) {
  const body = model.blocks.map((b) => {
    if (b.t === 'gap') return `<div class="rcpt__gap rcpt__gap--${Math.min(3, Math.max(1, Math.round(b.h ?? 1)))}"></div>`;
    if (b.t === 'rule') return `<hr class="rcpt__rule rcpt__rule--${b.style === 'solid' ? 'solid' : 'dash'}">`;
    if (b.t === 'text') {
      const cls = `rcpt__text${SIZE_CLASS[b.size] ?? ''}${b.bold ? ' rcpt__b' : ''}${b.align === 'center' ? ' rcpt__c' : b.align === 'right' ? ' rcpt__rt' : ''}${b.invert ? ' rcpt__inv' : ''}`;
      return `<p class="${cls}">${esc(b.text)}</p>`;
    }
    const cls = `rcpt__row${SIZE_CLASS[b.size] ?? ''}${b.bold ? ' rcpt__b' : ''}`;
    return `<div class="${cls}"><span class="rcpt__l">${esc(b.left)}</span><span class="rcpt__r">${esc(b.right)}</span></div>${b.sub ? `<div class="rcpt__sub">${esc(b.sub)}</div>` : ''}`;
  }).join('');
  return `<div class="rcpt rcpt--${paperMm === 58 ? 58 : 80}">${body}</div>`;
}

const PRINT_CSS = `
.${HOST_CLASS} { display: none; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.${HOST_CLASS}) { display: none !important; }
  .${HOST_CLASS} { display: block !important; }
  .rcpt { box-sizing: border-box; margin: 0; padding: 1mm 2mm; color: #000; background: #fff; font: 12pt/1.3 "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "SimHei", sans-serif; }
  .rcpt--58 { width: 58mm; }
  .rcpt--80 { width: 80mm; }
  .rcpt__text { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .rcpt__row { display: flex; justify-content: space-between; gap: 2mm; }
  .rcpt__l { flex: 1 1 auto; overflow-wrap: anywhere; }
  .rcpt__r { flex: 0 0 auto; text-align: right; white-space: nowrap; }
  .rcpt__sub { margin-left: 3mm; font-size: 9.5pt; }
  .rcpt__s2 { font-size: 16pt; }
  .rcpt__s3 { font-size: 26pt; line-height: 1.1; }
  .rcpt__b { font-weight: 700; }
  .rcpt__c { text-align: center; }
  .rcpt__rt { text-align: right; }
  .rcpt__inv { color: #fff; background: #000; padding: 1mm 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rcpt__rule { margin: 1.5mm 0; border: 0; border-top: 0.4mm dashed #000; }
  .rcpt__rule--solid { border-top-style: solid; border-top-width: 0.6mm; }
  .rcpt__gap--1 { height: 2mm; }
  .rcpt__gap--2 { height: 4mm; }
  .rcpt__gap--3 { height: 6mm; }
}`;

let baseStyle = null;

function ensureBaseStyle() {
  if (baseStyle?.isConnected) return;
  baseStyle = document.createElement('style');
  baseStyle.textContent = PRINT_CSS;
  document.head.append(baseStyle);
}

/** Adds the model to the page as a print-only block, opens the browser print dialog, then removes it again. */
export function printModelHtml(model, paperMm) {
  ensureBaseStyle();
  const page = document.createElement('style');
  page.id = PAGE_STYLE_ID;
  page.textContent = `@page { size: ${paperMm === 58 ? 58 : 80}mm auto; margin: 0; }`;
  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.innerHTML = modelToHtml(model, paperMm);
  document.head.append(page);
  document.body.append(host);
  const cleanup = () => {
    host.remove();
    page.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, SAFETY_CLEANUP_MS);
  window.print();
}
