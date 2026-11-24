// Admin section: marketing posters (营销海报) for WeChat Moments / Douyin. Drawn on a canvas in the browser with the
// venue's own colours and a QR code to the customer app; the background photo never leaves this device.
import { t, addStrings } from './i18n.js';
import { app, get } from './session.js';
import { html, fmtDateTime, fmtTime } from './util.js';
import { notifyError } from './ui.js';
import { qrSvg } from './qr.js';
import { themeVars } from './guest/themes.js';
import { hasModule } from './business.js';

const SIZES = { story: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 } };
const TEMPLATES = ['neon', 'frame', 'block'];
const MARGIN = 96;
const QR_SIZE = { story: 300, square: 220 };
const QR_PADDING = 18;
const HEADLINE_PX = { story: 120, square: 96 };
const SUB_PX = { story: 52, square: 44 };
const DATE_PX = { story: 46, square: 40 };
const VENUE_PX = 36;
const CAPTION_PX = 30;
const LINE_GAP = 1.22;
const MAX_HEADLINE_LINES = 4;
const PHOTO_SCRIM = 'rgba(0, 0, 0, 0.55)';
// Neon and photo posters are always dark with light text, whatever the venue's theme: a light theme made them a blank white page.
const NIGHT = { bg: '#0d0b18', raised: '#2a1d4a', fg: '#f7f4ff' };
const FRAME_WIDTH = 10;
const QR_LIGHT = '#ffffff';
const QR_DARK = '#000000';
const PNG = 'image/png';
const URL_REVOKE_MS = 10_000;

addStrings({
  en: {
    'admin.posters': 'Posters',
    'poster.intro': 'Make a poster for WeChat Moments or Douyin in your venue colours, with a QR code to your customer app. Photos stay on this device.',
    'poster.template': 'Template', 'poster.template.neon': 'Neon glow', 'poster.template.frame': 'Gold frame', 'poster.template.block': 'Colour block',
    'poster.size': 'Size', 'poster.size.story': 'Story 1080×1920 (Moments, Douyin)', 'poster.size.square': 'Square 1080×1080',
    'poster.event': 'Use an event (optional)', 'poster.noEvent': '— none —', 'poster.headline': 'Headline', 'poster.headlinePh': 'e.g. Friday Ladies Night',
    'poster.sub': 'Sub-line', 'poster.subPh': 'e.g. Free cocktail for every lady', 'poster.when': 'Date and time', 'poster.whenPh': 'e.g. Fri 20 Dec · 21:00',
    'poster.photo': 'Background photo (optional)', 'poster.photoHint': 'Stays on this device.', 'poster.removePhoto': 'Remove photo',
    'poster.download': 'Download poster', 'poster.preview': 'Poster preview', 'poster.scan': 'Scan to join and see what is on',
  },
  zh: {
    'admin.posters': '营销海报',
    'poster.intro': '用门店的品牌色制作朋友圈 / 抖音海报，自带会员小程序二维码。照片只在本机处理，不会上传。',
    'poster.template': '模板', 'poster.template.neon': '霓虹', 'poster.template.frame': '金框', 'poster.template.block': '色块',
    'poster.size': '尺寸', 'poster.size.story': '竖版 1080×1920（朋友圈、抖音）', 'poster.size.square': '方形 1080×1080',
    'poster.event': '选用活动（选填）', 'poster.noEvent': '— 不选 —', 'poster.headline': '主标题', 'poster.headlinePh': '例如：周五女士之夜',
    'poster.sub': '副标题', 'poster.subPh': '例如：女士每人送一杯鸡尾酒', 'poster.when': '日期时间', 'poster.whenPh': '例如：12月20日 周五 21:00',
    'poster.photo': '背景图（选填）', 'poster.photoHint': '只在本机使用，不会上传。', 'poster.removePhoto': '移除背景图',
    'poster.download': '下载海报', 'poster.preview': '海报预览', 'poster.scan': '扫码入会，查看最新活动',
  },
});

const customerAppUrl = () => `${location.origin}/g/${encodeURIComponent(app.company.code)}`;

/** The venue's colours as plain values a canvas can use: its theme applied to a probe element, read back. */
function venuePalette(theme) {
  const probe = document.createElement('div');
  probe.hidden = true;
  for (const [k, v] of Object.entries(themeVars(theme).vars)) probe.style.setProperty(k, v);
  document.body.append(probe);
  const css = getComputedStyle(probe);
  const read = (name) => css.getPropertyValue(name).trim();
  const palette = {
    bg: read('--color-bg'), raised: read('--color-bg-raised'), fg: read('--color-fg-strong'), muted: read('--color-muted'),
    accent: read('--color-primary'), accentFg: read('--color-primary-fg'), display: read('--font-display'), body: read('--font-body'),
  };
  probe.remove();
  return palette;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** qr.js draws with CSS variables; a canvas needs literal colours, so the SVG is coloured before it becomes an image. */
function qrImage(url) {
  const svg = (qrSvg(url, t('poster.scan')) ?? '').replace('var(--color-qr-bg)', QR_LIGHT).replace('var(--color-qr-fg)', QR_DARK);
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

// One token per Chinese / full-width character and one per Latin word (with its trailing space), so both wrap naturally.
const WRAP_TOKENS = /[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+\s*|\s+/g;

/** Splits text into lines that fit `maxWidth`. */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const token of para.match(WRAP_TOKENS) ?? []) {
      if (line && ctx.measureText(line + token).width > maxWidth) { lines.push(line.trimEnd()); line = token.trimStart(); } else line += token;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function drawText(ctx, text, { x, y, px, family, color, maxWidth, weight = 'bold', align = 'center', maxLines = Infinity, glow = null }) {
  if (!text) return y;
  ctx.font = `${weight} ${px}px ${family}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.shadowColor = glow ?? 'transparent';
  ctx.shadowBlur = glow ? px / 3 : 0;
  let cursor = y;
  for (const line of wrapLines(ctx, text, maxWidth).slice(0, maxLines)) {
    ctx.fillText(line, x, cursor);
    cursor += px * LINE_GAP;
  }
  ctx.shadowBlur = 0;
  return cursor;
}

function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.fillStyle = PHOTO_SCRIM;
  ctx.fillRect(0, 0, w, h);
}

function drawBackground(ctx, p, template, w, h, photo) {
  if (photo) { drawCover(ctx, photo, w, h); return; }
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, template === 'block' ? p.raised : p.bg);
  g.addColorStop(1, template === 'neon' ? p.raised : p.bg);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawDecoration(ctx, p, template, w, h) {
  if (template === 'frame') {
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = FRAME_WIDTH;
    ctx.strokeRect(MARGIN / 2, MARGIN / 2, w - MARGIN, h - MARGIN);
    ctx.lineWidth = FRAME_WIDTH / 3;
    ctx.strokeRect(MARGIN / 2 + FRAME_WIDTH * 2, MARGIN / 2 + FRAME_WIDTH * 2, w - MARGIN - FRAME_WIDTH * 4, h - MARGIN - FRAME_WIDTH * 4);
  } else if (template === 'block') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, w, h * 0.42);
  }
}

/** Draws the whole poster. Text colours follow the template: on the colour block the headline sits on the accent. */
function drawPoster(canvas, { p: venueColours, template, size, headline, sub, when, photo, qr, venueName }) {
  const p = photo || template === 'neon' ? { ...venueColours, ...NIGHT } : venueColours;
  const { w, h } = SIZES[size];
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, p, template, w, h, photo);
  drawDecoration(ctx, p, template, w, h);

  const onBlock = template === 'block' && !photo;
  const headColor = onBlock ? p.accentFg : template === 'neon' ? p.accent : p.fg;
  const align = template === 'block' ? 'left' : 'center';
  const x = align === 'left' ? MARGIN : w / 2;
  const maxWidth = w - MARGIN * 2.4;
  let y = MARGIN * 1.4;
  y = drawText(ctx, venueName, { x, y, px: VENUE_PX, family: p.body, color: onBlock ? p.accentFg : p.accent, maxWidth, align });
  y = drawText(ctx, headline, {
    x, y: y + MARGIN / 2, px: HEADLINE_PX[size], family: p.display, color: headColor, maxWidth, align,
    maxLines: MAX_HEADLINE_LINES, glow: template === 'neon' ? p.accent : null,
  });
  if (onBlock) y = Math.max(y, h * 0.42) + MARGIN / 2;
  y = drawText(ctx, sub, { x, y: y + MARGIN / 3, px: SUB_PX[size], family: p.body, color: p.fg, maxWidth, align, weight: 'normal' });
  drawText(ctx, when, { x, y: y + MARGIN / 3, px: DATE_PX[size], family: p.body, color: p.accent, maxWidth, align });

  const qrSize = QR_SIZE[size];
  const qrX = align === 'left' ? MARGIN : (w - qrSize) / 2;
  const qrY = h - MARGIN * 1.2 - qrSize - CAPTION_PX * 2;
  ctx.fillStyle = QR_LIGHT;
  ctx.fillRect(qrX - QR_PADDING, qrY - QR_PADDING, qrSize + QR_PADDING * 2, qrSize + QR_PADDING * 2);
  if (qr) ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);
  drawText(ctx, t('poster.scan'), { x: align === 'left' ? qrX : w / 2, y: qrY + qrSize + QR_PADDING * 2, px: CAPTION_PX, family: p.body, color: p.fg, maxWidth, align, weight: 'normal' });
}

const eventWhen = (ev) => `${fmtDateTime(ev.startsAt)} – ${fmtTime(ev.endsAt)}`;

export function postersSection() {
  let theme = null;
  let events = [];
  let photo = null;
  let qr = null;

  const view = () => html`<p class="muted">${t('poster.intro')}</p>
    <div class="poster">
      <form class="poster__form" data-poster-form novalidate>
        <div class="field"><label for="ps-template">${t('poster.template')}</label><select id="ps-template" name="template">
          ${TEMPLATES.map((id) => html`<option value="${id}">${t(`poster.template.${id}`)}</option>`)}</select></div>
        <div class="field"><label for="ps-size">${t('poster.size')}</label><select id="ps-size" name="size">
          ${Object.keys(SIZES).map((id) => html`<option value="${id}">${t(`poster.size.${id}`)}</option>`)}</select></div>
        ${events.length > 0 && html`<div class="field"><label for="ps-event">${t('poster.event')}</label><select id="ps-event" name="event">
          <option value="">${t('poster.noEvent')}</option>${events.map((ev) => html`<option value="${ev.id}">${ev.title}</option>`)}</select></div>`}
        <div class="field"><label for="ps-headline">${t('poster.headline')}</label><input id="ps-headline" name="headline" placeholder="${t('poster.headlinePh')}" autocomplete="off"></div>
        <div class="field"><label for="ps-sub">${t('poster.sub')}</label><input id="ps-sub" name="sub" placeholder="${t('poster.subPh')}" autocomplete="off"></div>
        <div class="field"><label for="ps-when">${t('poster.when')}</label><input id="ps-when" name="when" placeholder="${t('poster.whenPh')}" autocomplete="off"></div>
        <div class="field"><label for="ps-photo">${t('poster.photo')}</label><input id="ps-photo" name="photo" type="file" accept="image/*">
          <p class="hint">${t('poster.photoHint')}</p></div>
        <div class="row"><button type="button" class="btn btn--ghost" data-poster-clear hidden>${t('poster.removePhoto')}</button>
          <button type="button" class="btn btn--primary" data-poster-download>${t('poster.download')}</button></div>
      </form>
      <canvas class="poster__canvas" role="img" aria-label="${t('poster.preview')}"></canvas>
    </div>`;

  function mounted(el) {
    const form = el.querySelector('[data-poster-form]');
    const canvas = el.querySelector('canvas');
    const p = venuePalette(theme);
    const redraw = () => drawPoster(canvas, {
      p, photo, qr, venueName: app.company.name,
      template: form.elements.template.value, size: form.elements.size.value,
      headline: form.elements.headline.value.trim(), sub: form.elements.sub.value.trim(), when: form.elements.when.value.trim(),
    });

    form.addEventListener('input', (e) => {
      if (e.target.name === 'event') {
        const ev = events.find((x) => x.id === Number(e.target.value));
        if (ev) {
          form.elements.headline.value = ev.title;
          form.elements.sub.value = (ev.description ?? '').split('\n')[0];
          form.elements.when.value = eventWhen(ev);
        }
      }
      if (e.target.name !== 'photo') redraw();
    });
    form.elements.photo.addEventListener('change', () => {
      const file = form.elements.photo.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadImage(reader.result).then((img) => {
        photo = img;
        el.querySelector('[data-poster-clear]').hidden = false;
        redraw();
      }, notifyError);
      reader.readAsDataURL(file);
    });
    el.querySelector('[data-poster-clear]').addEventListener('click', (e) => {
      photo = null;
      form.elements.photo.value = '';
      e.currentTarget.hidden = true;
      redraw();
    });
    el.querySelector('[data-poster-download]').addEventListener('click', () => {
      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `poster-${form.elements.size.value}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), URL_REVOKE_MS);
      }, PNG);
    });
    redraw();
    if (!qr) qrImage(customerAppUrl()).then((img) => { qr = img; redraw(); }, notifyError);
  }

  return {
    posters: {
      load: async () => {
        const hasGuestApp = hasModule('guestApp');
        [theme, events] = await Promise.all([
          hasGuestApp ? get('/api/guest-theme') : null,
          hasGuestApp ? get('/api/venue-events').then((list) => list.filter((ev) => ev.active && ev.endsAt > Date.now())) : [],
        ]);
        return [];
      },
      add: null,
      view,
      mounted,
    },
  };
}
