// Sales website: Chinese by default with an English switch, and the demo / quote / partner / referral form.
const LANG_KEY = 'nightpos.site.lang';
const MESSAGES = {
  zh: { sent: '已收到！我们会在一个工作日内联系你。', sending: '提交中…', required: '请填写称呼和手机号。', failed: '提交失败，请稍后再试或直接电话联系我们。' },
  en: { sent: 'Thanks! We will contact you within one working day.', sending: 'Sending…', required: 'Please enter your name and phone.', failed: 'Could not send. Please try again later or call us.' },
};

let lang = 'zh';

function readLang() {
  try { return localStorage.getItem(LANG_KEY); } catch { return null; }
}

function setLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode: language just isn't remembered */ }
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
  for (const el of document.querySelectorAll('[data-en]')) {
    if (el.dataset.zh === undefined) el.dataset.zh = el.textContent;
    el.textContent = next === 'en' ? el.dataset.en : el.dataset.zh;
  }
  document.getElementById('lang').textContent = next === 'en' ? '中文' : 'EN';
}

function showReferrerField(form) {
  const kind = form.elements.kind.value;
  for (const el of form.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== kind;
}

async function submitLead(form) {
  const msg = document.getElementById('lead-msg');
  const say = (text, cls) => { msg.textContent = text; msg.className = `form__msg ${cls}`; };
  const body = Object.fromEntries(new FormData(form));
  if (!String(body.name).trim() || !String(body.phone).trim()) { say(MESSAGES[lang].required, 'err'); return; }
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  say(MESSAGES[lang].sending, '');
  try {
    const res = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      say(err.error ?? MESSAGES[lang].failed, 'err');
      return;
    }
    form.reset();
    showReferrerField(form);
    say(MESSAGES[lang].sent, 'ok');
  } catch {
    say(MESSAGES[lang].failed, 'err');
  } finally {
    button.disabled = false;
  }
}

function boot() {
  setLang(readLang() === 'en' ? 'en' : 'zh');
  document.getElementById('lang').addEventListener('click', () => setLang(lang === 'en' ? 'zh' : 'en'));
  document.getElementById('year').textContent = String(new Date().getFullYear());

  const form = document.getElementById('lead-form');
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') showReferrerField(form); });
  form.addEventListener('submit', (e) => { e.preventDefault(); submitLead(form); });
  showReferrerField(form);

  // "Apply as a partner" and similar buttons preselect the form.
  for (const a of document.querySelectorAll('a[data-kind]')) {
    a.addEventListener('click', () => {
      form.elements.kind.value = a.dataset.kind;
      showReferrerField(form);
    });
  }
}

boot();
