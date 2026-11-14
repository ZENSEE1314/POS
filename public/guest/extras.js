// Venue-level screens: rewards (points, vouchers, invites), the prize wheel, events, contacting the venue and pet care.
import { t, getLang } from './i18n.js';
import { html, raw, setHtml, fmtDate, fmtDateTime, session, get, post, patch, sheet, toast, busy, skeleton } from './core.js';
import { ensureSignedIn } from './login.js';

const enc = encodeURIComponent;
const REF_KEY = 'nightpos.ref';
const SPIN_TURNS = 6;
const SPIN_MS = 4200;
const WHEEL_R = 150;
const LABEL_R = 100;
const REQ_TONE = { pending: 'pending', done: 'ok', declined: 'bad', cancelled: 'neutral' };
const PET_SPECIES = ['dog', 'cat', 'other'];
const PET_SERVICES = ['grooming', 'bath', 'daycare', 'boarding', 'visit', 'other'];
const DEFAULT_LEAD_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const bi = (zh, en) => (getLang() === 'en' && en ? en : zh);

function signedOut(root, again) {
  setHtml(root, html`<div class="g-card"><p class="g-muted g-lead">${t('login.why')}</p>
    <button type="button" class="g-btn g-btn--primary g-btn--block" data-signin>${t('login.title')}</button></div>`);
  root.querySelector('[data-signin]').addEventListener('click', async () => { if (await ensureSignedIn()) await again(); });
}

/** Guards a signed-in screen: renders the sign-in card until there is a guest. */
async function withGuest(root, load) {
  if (!session.customer) { signedOut(root, () => withGuest(root, load)); return; }
  setHtml(root, skeleton(4));
  await load();
}

// ---------- invite links ----------

/** /g/<company>?ref=CODE: keep the code until the guest is signed in, then use it once. */
export function captureReferral(company) {
  const code = new URLSearchParams(location.search).get('ref');
  if (!code || !company) return;
  try { localStorage.setItem(REF_KEY, JSON.stringify({ company, code })); } catch { /* no storage: the guest can type the code */ }
  history.replaceState(null, '', location.pathname);
}

export async function claimPendingReferral(company) {
  if (!session.customer) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(REF_KEY) ?? 'null'); } catch { return; }
  if (!saved || saved.company.toLowerCase() !== String(company).toLowerCase()) return;
  try { localStorage.removeItem(REF_KEY); } catch { /* ignore */ }
  try {
    await post('/api/guest/referral', { company: saved.company, code: saved.code });
    toast(t('ref.applied'), 'success');
  } catch { /* an old, own or already-used code: nothing to tell the guest */ }
}

// ---------- rewards ----------

const reasonLabel = (r) => t(`rw.reason.${r}`);

function voucherHtml(v) {
  const expired = v.status === 'issued' && v.expiresAt < Date.now();
  const tone = v.status === 'used' ? 'neutral' : expired ? 'bad' : 'ok';
  const state = v.status === 'used' ? t('rw.used') : expired ? t('rw.expired') : t('rw.validUntil', { date: fmtDate(v.expiresAt) });
  return html`<li><span><strong>${v.title}</strong><br><span class="g-hint">${state}</span></span>
    <span class="g-voucher g-num ${tone !== 'ok' ? 'g-voucher--off' : ''}" aria-label="${t('rw.show')}">${v.code}</span></li>`;
}

export async function mountRewards(root, { company, navigate }) {
  const load = async () => {
    let d;
    try {
      d = await get(`/api/guest/loyalty/${enc(company)}`);
    } catch (e) {
      if (e.status === 404) { setHtml(root, html`<p class="g-empty">${t('rw.off')}</p>`); return; }
      throw e;
    }
    setHtml(root, html`
      <div class="g-hero"><p class="g-hero__eyebrow">${d.company.name}</p><h1 class="g-hero__title">${t('rw.title')}</h1></div>
      <section class="g-card" aria-labelledby="pts"><h2 id="pts" class="g-card__title">${t('rw.points')}</h2>
        <p class="g-balance g-num">${d.balance}</p><p class="g-hint">${t('rw.earn', { n: d.pointsPerYuan })}</p>
        ${d.spin && html`<a class="g-tile g-gap" href="/g/${enc(company)}/spin" data-link><span class="g-tile__mark" aria-hidden="true">◎</span>
          <span class="g-tile__text"><strong>${t('rw.spinTile')}</strong><span>${t('rw.spinSub', { n: d.spin.cost })}</span></span></a>`}</section>
      <section class="g-card" aria-labelledby="cat"><h2 id="cat" class="g-card__title">${t('rw.catalog')}</h2>
        ${d.rewards.length ? html`<ul class="g-lines">${d.rewards.map((r) => html`<li><span><strong>${bi(r.name, r.nameEn)}</strong></span>
          <button type="button" class="g-btn g-btn--small ${d.balance >= r.cost ? 'g-btn--primary' : ''}" data-redeem="${r.id}" ${d.balance < r.cost ? 'disabled' : ''}>${t('rw.redeem', { n: t('rw.pts', { n: r.cost }) })}</button></li>`)}</ul>`
          : html`<p class="g-muted">${t('rw.none')}</p>`}</section>
      <section class="g-card" aria-labelledby="vch"><h2 id="vch" class="g-card__title">${t('rw.vouchers')}</h2>
        ${d.vouchers.length ? html`<ul class="g-lines">${d.vouchers.map(voucherHtml)}</ul>` : html`<p class="g-muted">${t('rw.noVouchers')}</p>`}</section>
      ${d.referral && html`<section class="g-card" aria-labelledby="ref"><h2 id="ref" class="g-card__title">${t('ref.title')}</h2>
        <p class="g-muted g-lead">${t('ref.text', { n: d.referral.points })}</p>
        <dl class="g-sum"><dt>${t('ref.code')}</dt><dd class="g-voucher g-num">${d.referral.code}</dd></dl>
        ${d.referral.invited > 0 && html`<p class="g-hint">${t('ref.stats', { n: d.referral.invited, done: d.referral.rewarded })}</p>`}
        <button type="button" class="g-btn g-btn--block g-gap" data-copy="${location.origin}/g/${enc(company)}?ref=${d.referral.code}">${t('ref.copy')}</button>
        ${d.referral.referredBy ? html`<p class="g-hint g-gap">${t('ref.used')}</p>` : html`<form class="g-gap" data-refform novalidate>
          <div class="g-field"><label for="rc">${t('ref.enter')}</label><input id="rc" maxlength="8" autocapitalize="characters" autocomplete="off" placeholder="${t('ref.ph')}"></div>
          <button type="submit" class="g-btn g-btn--block">${t('ref.apply')}</button></form>`}</section>`}
      <section class="g-card" aria-labelledby="hist"><h2 id="hist" class="g-card__title">${t('rw.history')}</h2>
        ${d.ledger.length ? html`<ul class="g-lines">${d.ledger.map((l) => html`<li><span>${fmtDate(l.ts)}<br><span class="g-hint">${reasonLabel(l.reason)}</span></span>
          <span class="g-num">${l.delta > 0 ? '+' : ''}${l.delta}</span></li>`)}</ul>` : html`<p class="g-muted">${t('rw.noHistory')}</p>`}</section>`);
  };

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.redeem) {
      await busy(b, async () => {
        const r = await post(`/api/guest/loyalty/${enc(company)}/redeem`, { rewardId: Number(b.dataset.redeem) });
        toast(t('rw.redeemed', { code: r.voucher.code }), 'success');
        await load();
      })();
    } else if (b.dataset.copy) {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('ref.copied'), 'success'); } catch { toast(b.dataset.copy); }
    }
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-refform]');
    if (!form) return;
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      await post('/api/guest/referral', { company, code: form.querySelector('input').value });
      toast(t('ref.applied'), 'success');
      await load();
    })();
  });
  void navigate;
  await withGuest(root, load);
}

// ---------- prize wheel ----------

function wheelSvg(prizes) {
  const seg = 360 / prizes.length;
  const point = (deg, r) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  };
  const slices = prizes.map((p, i) => {
    const a0 = i * seg;
    const a1 = a0 + seg;
    const mid = a0 + seg / 2;
    const [lx, ly] = point(mid, LABEL_R).split(' ');
    const text = bi(p.label, p.labelEn);
    return `<path class="g-wheel__slice g-wheel__slice--${i % 2 ? 'b' : 'a'}${p.kind === 'none' ? ' g-wheel__slice--none' : ''}"
      d="M0 0 L${point(a0, WHEEL_R)} A${WHEEL_R} ${WHEEL_R} 0 ${seg > 180 ? 1 : 0} 1 ${point(a1, WHEEL_R)} Z"/>
      <text class="g-wheel__label" x="${lx}" y="${ly}" transform="rotate(${mid} ${lx} ${ly})" text-anchor="middle" dominant-baseline="middle">${String(html`${text}`)}</text>`;
  }).join('');
  return `<svg viewBox="-160 -160 320 320" role="img" aria-hidden="true"><g class="g-wheel__disc">${slices}<circle r="${WHEEL_R}" class="g-wheel__rim"/></g>
    <circle r="22" class="g-wheel__hub"/></svg>`;
}

export async function mountSpin(root, { company }) {
  let rotation = 0;
  let spinning = false;
  const load = async () => {
    let d;
    try {
      d = await get(`/api/guest/loyalty/${enc(company)}`);
    } catch (e) {
      if (e.status === 404) { setHtml(root, html`<p class="g-empty">${t('rw.off')}</p>`); return; }
      throw e;
    }
    if (!d.spin) { setHtml(root, html`<p class="g-empty">${t('rw.off')}</p>`); return; }
    const { prizes, cost } = d.spin;
    setHtml(root, html`<div class="g-hero"><p class="g-hero__eyebrow">${d.company.name}</p><h1 class="g-hero__title">${t('spin.title')}</h1>
        <p class="g-hero__text" data-cost>${t('spin.cost', { n: cost, balance: d.balance })}</p></div>
      <div class="g-wheel"><span class="g-wheel__pointer" aria-hidden="true">▼</span><div class="g-wheel__spin" style="transform: rotate(${rotation}deg)">${raw(wheelSvg(prizes))}</div></div>
      <p class="g-center g-lead" aria-live="polite" data-result></p>
      <button type="button" class="g-btn g-btn--primary g-btn--block" data-spin ${d.balance < cost ? 'disabled' : ''}>${t('spin.go', { n: cost })}</button>
      <p class="g-hint g-gap">${t('spin.rules')}</p>`);
    const btn = root.querySelector('[data-spin]');
    btn.addEventListener('click', busy(btn, async () => {
      if (spinning) return;
      spinning = true;
      const resultEl = root.querySelector('[data-result]');
      resultEl.textContent = t('spin.spinning');
      try {
        const r = await post(`/api/guest/loyalty/${enc(company)}/spin`);
        const seg = 360 / prizes.length;
        const target = 360 - (r.index + 0.5) * seg;
        rotation += SPIN_TURNS * 360 + ((target - (rotation % 360)) + 360) % 360;
        const wheel = root.querySelector('.g-wheel__spin');
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        wheel.style.transition = reduced ? 'none' : `transform ${SPIN_MS}ms cubic-bezier(0.17, 0.67, 0.12, 0.99)`;
        wheel.style.transform = `rotate(${rotation}deg)`;
        await new Promise((res) => setTimeout(res, reduced ? 0 : SPIN_MS));
        const name = bi(r.prize.label, r.prize.labelEn);
        resultEl.textContent = r.prize.kind === 'none' ? t('spin.none') : `${t('spin.win', { prize: name })}${r.voucher ? ` ${t('spin.voucher', { code: r.voucher.code })}` : ''}`;
        root.querySelector('[data-cost]').textContent = t('spin.cost', { n: cost, balance: r.balance });
        btn.disabled = r.balance < cost;
      } catch (e) {
        resultEl.textContent = '';
        throw e;
      } finally {
        spinning = false;
      }
    }));
  };
  await withGuest(root, load);
}

// ---------- events ----------

export async function mountEvents(root, { company, navigate }) {
  const events = await get(`/api/guest/events/${enc(company)}`);
  const now = Date.now();
  setHtml(root, html`<div class="g-hero"><h1 class="g-hero__title">${t('ev.title')}</h1></div>
    ${events.length ? events.map((e) => html`<article class="g-card g-event">
      <p class="g-hero__eyebrow">${e.startsAt <= now ? html`<span class="g-badge g-badge--ok">${t('ev.now')}</span> ` : ''}${fmtDateTime(e.startsAt)} · ${e.storeName}</p>
      <h2 class="g-card__title">${bi(e.title, e.titleEn)}</h2>
      ${e.description && html`<p class="g-muted g-lead g-pre">${e.description}</p>`}
      <button type="button" class="g-btn g-btn--primary g-btn--block" data-book="${e.id}" data-store="${e.storeCode}">${t('ev.book')}</button></article>`)
      : html`<p class="g-empty">${t('ev.none')}</p>`}`);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-book]');
    if (b) navigate(`/g/${enc(company)}/${enc(b.dataset.store)}/book?event=${b.dataset.book}`);
  });
}

// ---------- requests history (shared by support and pet care) ----------

export function requestsHtml(list) {
  if (!list.length) return html`<p class="g-muted">${t('req.none')}</p>`;
  return html`<ul class="g-lines">${list.map((r) => html`<li><span><strong>${t(`req.kind.${r.kind}`)}</strong> · ${requestSummary(r)}<br>
      <span class="g-hint">${fmtDateTime(r.createdAt)}${r.tableName ? ` · ${r.tableName}` : ` · ${r.storeName}`}</span>
      ${r.reply && html`<br><span class="g-hint">${t('req.reply', { reply: r.reply })}</span>`}
      ${r.status === 'pending' && html`<br><button type="button" class="g-link" data-cancel-request="${r.id}">${t('req.cancel')}</button>`}</span>
    <span class="g-badge g-badge--${REQ_TONE[r.status]}">${t(`req.${r.status}`)}</span></li>`)}</ul>`;
}

function requestSummary(r) {
  const d = r.detail;
  switch (r.kind) {
    case 'service': return t(`svc.reason.${d.reason}`) + (d.note ? `: ${d.note}` : '');
    case 'song': return d.artist ? `${d.title} · ${d.artist}` : d.title;
    case 'bottle': return d.name;
    case 'support': return d.message;
    case 'pet': return `${d.pet.name} · ${t(`pet.svc.${d.service}`)} · ${fmtDateTime(d.when)}`;
    default: return '';
  }
}

export function onCancelRequest(root, after) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cancel-request]');
    if (!b) return;
    await busy(b, async () => {
      await post(`/api/guest/requests/${b.dataset.cancelRequest}/cancel`);
      toast(t('req.cancelledToast'));
      await after();
    })();
  });
}

const storeSelect = (stores, id) => (stores.length > 1
  ? html`<div class="g-field"><label for="${id}">${t('sup.store')}</label><select id="${id}" name="store">${stores.map((s) => html`<option value="${s.code}">${s.name}</option>`)}</select></div>`
  : '');

// ---------- contact the venue ----------

export async function mountSupport(root, { company, stores }) {
  const load = async () => {
    const list = await get(`/api/guest/requests/${enc(company)}`);
    setHtml(root, html`<div class="g-hero"><h1 class="g-hero__title">${t('sup.title')}</h1></div>
      <form class="g-card" novalidate data-support>${storeSelect(stores, 'sst')}
        <div class="g-field"><label for="msg">${t('sup.message')}</label><textarea id="msg" name="message" maxlength="1000" required placeholder="${t('sup.ph')}"></textarea></div>
        <p class="g-error" role="alert" hidden></p><button type="submit" class="g-btn g-btn--primary g-btn--block">${t('sup.send')}</button></form>
      <section class="g-card" aria-labelledby="sh"><h2 id="sh" class="g-card__title">${t('sup.history')}</h2>${requestsHtml(list)}</section>`);
    const form = root.querySelector('[data-support]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.g-error');
      err.hidden = true;
      try {
        await post('/api/guest/requests', { kind: 'support', company, store: form.elements.store?.value ?? stores[0].code, message: form.elements.message.value });
        toast(t('sup.sent'), 'success');
        await load();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  };
  onCancelRequest(root, load);
  await withGuest(root, load);
}

// ---------- pet care ----------

function petForm(pet) {
  return sheet(pet ? pet.name : t('pet.add'), (body, close) => {
    setHtml(body, html`<form novalidate>
      <div class="g-field"><label for="pn">${t('pet.name')}</label><input id="pn" name="name" maxlength="40" required value="${pet?.name ?? ''}"></div>
      <div class="g-field"><label for="ps">${t('pet.species')}</label><select id="ps" name="species">${PET_SPECIES.map((s) =>
        html`<option value="${s}" ${pet?.species === s ? 'selected' : ''}>${t(`pet.species.${s}`)}</option>`)}</select></div>
      <div class="g-field"><label for="pb">${t('pet.breed')}</label><input id="pb" name="breed" maxlength="60" value="${pet?.breed ?? ''}"></div>
      <div class="g-field"><label for="pd">${t('pet.birthday')}</label><input id="pd" name="birthday" type="date" value="${pet?.birthday ?? ''}"></div>
      <div class="g-field"><label for="pt">${t('pet.notes')}</label><textarea id="pt" name="notes" maxlength="500">${pet?.notes ?? ''}</textarea></div>
      <p class="g-error" role="alert" hidden></p><button type="submit" class="g-btn g-btn--primary g-btn--block">${t('pet.save')}</button></form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const data = { name: f.name.value, species: f.species.value, breed: f.breed.value, birthday: f.birthday.value, notes: f.notes.value };
      try {
        if (pet) await patch(`/api/guest/pets/${pet.id}`, data); else await post('/api/guest/pets', data);
        toast(t('pet.saved'), 'success');
        close(true);
      } catch (ex) {
        const err = form.querySelector('.g-error');
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

function petBooking(pet, company, stores) {
  return sheet(`${t('pet.book')} · ${pet.name}`, (body, close) => {
    setHtml(body, html`<form novalidate>${storeSelect(stores, 'pbs')}
      <div class="g-field"><label for="sv">${t('pet.service')}</label><select id="sv" name="service">${PET_SERVICES.map((s) => html`<option value="${s}">${t(`pet.svc.${s}`)}</option>`)}</select></div>
      <div class="g-field"><label for="pw">${t('pet.when')}</label><input id="pw" name="when" type="datetime-local" required value="${toLocalInput(Date.now() + DEFAULT_LEAD_MS)}"></div>
      <div class="g-field"><label for="pnote">${t('pet.note')}</label><textarea id="pnote" name="note" maxlength="200"></textarea></div>
      <p class="g-error" role="alert" hidden></p><button type="submit" class="g-btn g-btn--primary g-btn--block">${t('pet.book')}</button></form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      try {
        await post('/api/guest/requests', {
          kind: 'pet', company, store: f.store?.value ?? stores[0].code, petId: pet.id, service: f.service.value,
          when: new Date(f.when.value).getTime(), note: f.note.value,
        });
        toast(t('pet.sent'), 'success');
        close(true);
      } catch (ex) {
        const err = form.querySelector('.g-error');
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

export async function mountPets(root, { company, stores }) {
  let pets = [];
  const load = async () => {
    const [list, requests] = await Promise.all([get('/api/guest/pets'), get(`/api/guest/requests/${enc(company)}`)]);
    pets = list;
    setHtml(root, html`<div class="g-hero"><h1 class="g-hero__title">${t('pet.title')}</h1></div>
      <section class="g-card" aria-labelledby="pm"><h2 id="pm" class="g-card__title">${t('pet.mine')}</h2>
        ${pets.length ? html`<ul class="g-lines">${pets.map((p) => html`<li><span><strong>${p.name}</strong> · ${t(`pet.species.${p.species}`)}${p.breed ? ` · ${p.breed}` : ''}
          ${p.notes && html`<br><span class="g-hint">${p.notes}</span>`}<br>
          <button type="button" class="g-link" data-edit="${p.id}">${t('pet.edit')}</button> · <button type="button" class="g-link" data-remove="${p.id}">${t('pet.remove')}</button></span>
          <button type="button" class="g-btn g-btn--small g-btn--primary" data-care="${p.id}">${t('pet.book')}</button></li>`)}</ul>`
          : html`<p class="g-muted">${t('pet.none')}</p>`}
        <button type="button" class="g-btn g-btn--block g-gap" data-add>${t('pet.add')}</button></section>
      <section class="g-card" aria-labelledby="pr"><h2 id="pr" class="g-card__title">${t('req.mine')}</h2>${requestsHtml(requests.filter((r) => r.kind === 'pet'))}</section>`);
  };
  const byId = (id) => pets.find((p) => p.id === Number(id));
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add !== undefined) { if (await petForm(null)) await load(); }
    else if (b.dataset.edit) { if (await petForm(byId(b.dataset.edit))) await load(); }
    else if (b.dataset.care) { if (await petBooking(byId(b.dataset.care), company, stores)) await load(); }
    else if (b.dataset.remove) {
      await busy(b, async () => { await post(`/api/guest/pets/${b.dataset.remove}/remove`); toast(t('pet.removed')); await load(); })();
    }
  });
  onCancelRequest(root, load);
  await withGuest(root, load);
}
