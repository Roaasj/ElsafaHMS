// أدوات الواجهة المشتركة
import { makeMoney } from '/shared/money.js';
import { moduleOfPerm } from '/shared/modules.js';
export const state = { money: makeMoney(), currency: null, me: null, hospital: '', tz: 'Africa/Cairo', dayStart: 420, brand: { name: '', sub: '', logo: '/brand/logo', footer: '' }, shiftNames: { am: 'صباحي', pm: 'مسائي', night: 'سهر' } };
globalThis.HMS = state; // الوصول للمنطقة الزمنية والهوية من أي ملف

// ---------- هوية المستشفى: ألوان بتتولد من اللون الأساسي والمكمّل ----------
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return [h, s * 100, l * 100];
}
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(Math.max(0, Math.min(100, s)))}% ${Math.round(Math.max(0, Math.min(100, l)))}%)`;
export function brandVars(primary, accent) {
  const [h, s, l] = hexToHsl(primary), [ah, as, al] = hexToHsl(accent);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16));
  return {
    '--brand': primary, '--brand-2': hsl(h + 3, s, l + 8), '--brand-deep': hsl(h, s, Math.max(10, l * 0.55)), '--brand-soft': hsl(h, Math.min(s, 70), 95),
    '--peach': accent, '--peach-soft': hsl(ah, Math.min(as, 100), 94), '--orange': hsl(ah, as, Math.max(30, al - 18)), '--tan': hsl(ah, Math.min(as, 45), Math.max(35, al - 22)),
    '--brand-rgb': `${r}, ${g}, ${b}`, '--st-occupied': primary,
    '--rail-1': hsl(h, Math.min(s, 85), 26), '--rail-2': hsl(h, Math.min(s, 82), 19), '--rail-3': hsl(h, Math.min(s, 80), 13),
    '--art-1': hsl(h, Math.min(s, 85), 30), '--art-2': hsl(h, Math.min(s, 82), 22), '--art-3': hsl(h, Math.min(s, 80), 14),
    '--tint-1': hsl(ah, 62, 82), '--tint-2': hsl(ah, 62, 88), '--tint-3': hsl(ah, 62, 85), '--tint-4': hsl(ah, 70, 92), '--tint-5': hsl(ah, 45, 70),
  };
}
export function applyBrand(b) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(brandVars(b.primary, b.accent))) root.style.setProperty(k, v);
  state.modules = b.modules || {};
  state.brand = { name: b.name, sub: b.sub, logo: b.logo, footer: b.footer || '' };
  if (b.patientFields) state.patientFields = b.patientFields;
  if (b.dx) state.dx = b.dx;
  if (b.currency) { state.currency = b.currency; state.money = makeMoney(b.currency); }
  state.hospital = b.name; state.tz = b.tz || state.tz; state.dayStart = b.dayStart ?? state.dayStart;
  if (b.shiftNames) state.shiftNames = b.shiftNames;
  const tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.setAttribute('content', b.primary);
  const fav = document.querySelector('link[rel=icon]'); if (fav) fav.setAttribute('href', b.logo);
}


// ---------- HTML آمن ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
function val(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  if (v === false || v == null) return '';
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1];
  return raw(out);
}
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);

export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, data) { super(data?.error || 'حصلت مشكلة'); this.status = status; this.data = data || {}; }
}
export async function api(method, url, body) {
  let r;
  try {
    r = await fetch('/api' + url, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, { error: 'مفيش اتصال بالسيرفر. اتأكد من الشبكة.' });
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/login') { window.dispatchEvent(new CustomEvent('auth:lost')); }
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}
api.get = (u) => api('GET', u);
api.post = (u, b) => api('POST', u, b ?? {});
api.put = (u, b) => api('PUT', u, b);
api.del = (u, b) => api('DELETE', u, b);
api.patch = (u, b) => api('PATCH', u, b);

// ---------- تنسيق ----------
export const money = (n) => HMS.money.fmt(n);
export const egp = (n) => raw(HMS.money.symbolPos === 'before' ? `${HMS.money.symbol} <span class="num">${money(n)}</span>` : `<span class="num">${money(n)}</span> ${HMS.money.symbol}`);
export const fmtTime = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: HMS.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
export const fmtDate = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: HMS.tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d));
export const fmtDay = (d = new Date()) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: HMS.tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d));
export function fmtWhen(d) {
  const x = new Date(d), today = new Date();
  const sameDay = (a, b) => a.toLocaleDateString('en-CA', { timeZone: HMS.tz }) === b.toLocaleDateString('en-CA', { timeZone: HMS.tz });
  if (sameDay(x, today)) return 'النهارده ' + fmtTime(x);
  const y = new Date(today.getTime() - 86400e3);
  if (sameDay(x, y)) return 'امبارح ' + fmtTime(x);
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: HMS.tz, day: 'numeric', month: 'short', year: 'numeric' }).format(x);
}
export function ago(d) {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'دلوقتي';
  if (m === 1) return 'من دقيقة';
  if (m === 2) return 'من دقيقتين';
  if (m <= 10) return `من ${m} دقايق`;
  if (m < 60) return `من ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? 'من ساعة' : h === 2 ? 'من ساعتين' : `من ${h} ساعات`;
  return fmtWhen(d);
}
export function initials(name) {
  const p = String(name || '').replace(/^(د\.|دكتور)\s*/, '').trim().split(/\s+/).filter((w) => w !== 'عبد');
  const strip = (w) => (w || '').replace(/^ال(?=..)/, '');
  const first = strip(p[0]), second = strip(p[1]);
  return (first[0] || '؟') + (second ? ' ' + second[0] : '');
}
/** 17:00 => 5 م ، 09:30 => 9:30 ص */
export function fmtHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  const h12 = h % 12 || 12;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' ص' : ' م');
}
export function fmtSlot(s) {
  if (s.from === '00:00' && (s.to === '23:59' || s.to === '24:00')) return 'طول اليوم';
  return `من ${fmtHM(s.from)} لـ ${fmtHM(s.to)}`;
}
export const sexName = (s) => (s === 'M' ? 'ذكر' : s === 'F' ? 'أنثى' : '');

// الأقسام وأنواع الدخول وأنواع الغرف: بتتحمّل من /api/lookups وبتتحدّث في نفس الأوبجكتات
// (فالشاشات اللي مستوردة DEPT / ADM / KIND بتشوف التغيير من غير ما تتغير)
export const DEPT = {};
/** أقسام الزيارة الخارجية */
export const DEPT_KEYS = [];
/** كل أقسام الخدمات (الزيارة + الإقامة + العمليات + أي قسم جديد) */
export const SVC_KEYS = [];
export const ADM = {};
export const ADM_KEYS = [];
export const KIND = {};
export const KIND_KEYS = [];
export const KIND_ICON = {};
/** أول قسم بسلوك معين (للقيم الافتراضية) */
export const firstDept = (...b) => Object.keys(DEPT).find((k) => DEPT[k].active && b.includes(DEPT[k].behavior)) || SVC_KEYS[0];
/** سلوك كل قسم (clinic / lab / ward …) للشاشات اللي بتفرّق بالسلوك */
export const DEPT_BEHAVIOR = {};
export const soft = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const m = (c) => Math.round(c * 0.12 + 255 * 0.88);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => m(c).toString(16).padStart(2, '0')).join('')}`;
};
function refillObj(o, entries) { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, Object.fromEntries(entries)); }
function refillArr(a, items) { a.length = 0; a.push(...items); }
export function applyLookups(L) {
  const depts = L.dept.filter((d) => d.active);
  refillObj(DEPT, L.dept.map((d) => [d.code, { name: d.name, short: d.short, icon: d.icon || 'layers', color: d.color, behavior: d.behavior, active: d.active, pay: d.meta.pay || 'before', prefix: d.meta.prefix }]));
  Object.assign(DEPT, EXTRA_DEPT);
  refillObj(DEPT_BEHAVIOR, L.dept.map((d) => [d.code, d.behavior]));
  refillArr(DEPT_KEYS, depts.filter((d) => d.meta.visit).map((d) => d.code));
  refillArr(SVC_KEYS, depts.map((d) => d.code));
  refillObj(ADM, L.admission_type.map((a) => [a.code, { name: a.name, icon: a.icon || 'bed', kind: a.meta.roomKind, color: a.color, behavior: a.behavior, active: a.active }]));
  refillArr(ADM_KEYS, L.admission_type.filter((a) => a.active).map((a) => a.code));
  refillObj(KIND, L.room_kind.map((k) => [k.code, k.name]));
  refillObj(KIND_ICON, L.room_kind.map((k) => [k.code, k.icon || 'bed']));
  refillArr(KIND_KEYS, L.room_kind.filter((k) => k.active).map((k) => k.code));
  refillArr(COVER_KEYS, [...SVC_KEYS, 'drugs', 'supplies']);
  let st = document.getElementById('lookup-css');
  if (!st) { st = document.createElement('style'); st.id = 'lookup-css'; document.head.appendChild(st); }
  st.textContent = [
    ...L.dept.map((d) => `.d-${d.code}{--dc:${d.color};--ds:${soft(d.color)}}`),
    ...L.admission_type.map((a) => `.t-${a.code}{--tc:${a.color}}`),
    ...L.room_kind.map((k) => `.k-${k.code}{--kc:${k.color}}`),
  ].join('\n');
}
export async function refreshLookups() { applyLookups(await api.get('/lookups')); }
/** الدكتور/الشاشة تسأل: القسم ده سلوكه إيه */
export const deptIs = (code, ...b) => b.includes(DEPT_BEHAVIOR[code]);
export const BED_ST = {
  free: { name: 'فاضي', icon: 'check' },
  occupied: { name: 'مشغول', icon: 'user' },
  cleaning: { name: 'تحت التنظيف', icon: 'sparkle' },
  reserved: { name: 'محجوز', icon: 'clock' },
};
/** عدد أيام القاهرة من تاريخ معين لحد النهارده (يوم الدخول = 1) */
export function stayDays(from) {
  const d = (x) => new Date(new Date(x).toLocaleDateString('en-CA', { timeZone: HMS.tz }) + 'T00:00:00Z');
  return Math.round((d(new Date()) - d(from)) / 86400e3) + 1;
}
/** عدد الليالي بالعربي */
export function nightsText(n) {
  if (n === 1) return 'ليلة';
  if (n === 2) return 'ليلتين';
  if (n >= 3 && n <= 10) return n + ' ليالي';
  return n + ' ليلة';
}

// ---------- إشعارات ----------
export function toast(msg, kind = 'ok', ms = 3200) {
  const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info';
  const t = el(html`<div class="toast ${kind}">${icon(ic)}<span>${msg}</span></div>`);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, ms);
}
export function toastError(e) {
  toast(e?.message || 'حصلت مشكلة', 'err', 4500);
}

// ---------- النوافذ ----------
export function modal({ title, body, foot = '', wide = false, onClose } = {}) {
  const ov = el(html`<div class="overlay" role="dialog" aria-modal="true">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${title}</h3><button class="btn ghost icon sm x" data-close aria-label="اقفل">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? html`<div class="modal-foot">${foot}</div>` : ''}
    </div></div>`);
  const prev = document.activeElement;
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    prev?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  setTimeout(() => ($('[autofocus]', ov) || $('input,select,textarea,button:not([data-close])', ov))?.focus(), 30);
  return { el: ov, close };
}

/** نافذة تأكيد بسبب (للإلغاء) */
export function askReason({ title, label = 'السبب', confirm = 'تأكيد', danger = true, note = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: html`${note ? html`<div class="alertbar warn" style="margin-bottom:12px">${icon('alert')}<span>${note}</span></div>` : ''}
        <div class="field"><label>${label} <span class="req">*</span></label><textarea class="input" rows="3" autofocus></textarea><div class="msg"></div></div>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:${danger ? 'var(--danger)' : 'var(--brand)'}">${confirm}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const ta = $('textarea', m.el);
    const ok = () => {
      const v = ta.value.trim();
      if (v.length < 3) { ta.closest('.field').classList.add('err'); $('.msg', m.el).textContent = 'اكتب السبب'; ta.focus(); return; }
      done = true; m.close(); resolve(v);
    };
    $('[data-ok]', m.el).addEventListener('click', ok);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok(); });
  });
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** فتح الإيصال للطباعة */
export function printReceipt(id, auto = true) {
  const fmt = localStorage.getItem('printFmt') || 'a5';
  const w = window.open(`/print/receipt/${id}?fmt=${fmt}${auto ? '&auto=1' : ''}`, 'receipt' + id, 'width=720,height=900');
  if (!w) toast('المتصفح منع نافذة الطباعة. اسمح بالنوافذ المنبثقة للموقع ده.', 'warn', 6000);
}

export const can = (perm) => {
  const mod = moduleOfPerm(perm);
  if (mod && state.modules?.[mod] === false) return false; // القسم موقوف من الإعدادات
  const p = state.me?.permissions || [];
  return p.includes('*') || p.includes(perm);
};

/** حالة تغطية البند في التعاقد */
export const COVER = {
  none: null,
  covered: { name: 'متغطي', cls: 'ok' },
  excluded: { name: 'مش مغطاة', cls: 'danger' },
  pending: { name: 'مستني المراجعة', cls: 'warn' },
  tempcash: { name: 'نقدي مؤقت', cls: 'warn' },
  approved: { name: 'موافقة معتمدة', cls: 'ok' },
  rejected: { name: 'موافقة مرفوضة', cls: 'danger' },
};
export const AP_ST = {
  pending: { name: 'مستني المراجعة', cls: 'warn' },
  tempcash: { name: 'نقدي مؤقت', cls: 'warn' },
  approved: { name: 'اتعتمدت', cls: 'ok' },
  rejected: { name: 'اترفضت', cls: 'danger' },
};

/** رفع صورة الموافقة */
export async function uploadApprovalImage(id, file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) throw new ApiError(400, { error: 'الصورة أكبر من 8 ميجا' });
  const r = await fetch(`/api/approvals/${id}/image`, { method: 'POST', body: file, credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
}

/** طباعة صفحة (إذن، تسليم وردية، تقرير) */
export function openPrint(url, name = 'print') {
  const w = window.open(url, name, 'width=820,height=900');
  if (!w) toast('المتصفح منع نافذة الطباعة. اسمح بالنوافذ المنبثقة للموقع ده.', 'warn', 6000);
}
export const printOrder = (id) => openPrint(`/print/order/${id}?auto=1`, 'order' + id);
export const printShift = (id) => openPrint(`/print/shift/${id}?auto=1`, 'shift' + id);

/** الإذن اتعمل: المريض يروح الخزينة */
export function showOrder(o, { autoPrint = true } = {}) {
  if (autoPrint) printOrder(o.id);
  const out = o.amount < 0;
  const m = modal({
    title: '',
    body: html`<div class="success order">
      <div class="tick" style="background:var(--py-soft);color:var(--py)">${icon(out ? 'undo' : 'wallet')}</div>
      <h3>${out ? 'إذن صرف للخزينة' : 'إذن دفع للخزينة'}</h3>
      <div class="ordno num">${o.no}</div>
      <div class="rno">${out ? 'يُصرف للمريض' : 'المطلوب'} <b class="num">${money(Math.abs(o.amount))}</b> ${HMS.money.unitWord}${o.credit ? html` · آجل <b class="num">${money(o.credit)}</b>` : ''}</div>
      <p class="muted" style="margin:10px 0 0;font-weight:700">${out ? 'المريض يستلم المبلغ من الخزينة بالرقم ده' : 'المريض يدفع في الخزينة بالرقم ده، والإيصال بيطلع من هناك'}</p>
    </div>`,
    foot: html`<button class="btn ghost" data-print>${icon('print')} ${autoPrint ? 'اطبع الإذن تاني' : 'اطبع الإذن'}</button><a class="btn soft" href="#/patients" data-close>${icon('user-plus')} المريض اللي بعده</a><button class="btn" data-close autofocus>تمام</button>`,
  });
  $('.modal-head h3', m.el)?.remove();
  $('[data-print]', m.el).addEventListener('click', () => printOrder(o.id));
}

let dutyCache = null;
/** الخزينة شغالة؟ (الاستقبال يعمل إذن بدل ما يقبض) */
export async function cashierDuty(force = false) {
  if (!dutyCache || force || Date.now() - dutyCache.at > 30e3) dutyCache = { ...(await api.get('/orders/duty')), at: Date.now() };
  return dutyCache;
}

/** الأشعة */
export const MOD = {
  us: { name: 'سونار', cls: 'm-us' }, ct: { name: 'مقطعية', cls: 'm-ct' }, mri: { name: 'رنين', cls: 'm-mri' },
  xray: { name: 'عادية', cls: 'm-xray' }, mammo: { name: 'ماموجرام', cls: 'm-mammo' }, other: { name: 'أخرى', cls: 'm-other' },
};
export const RAD_ST = {
  waiting: { name: 'مستني الفحص', cls: '' }, done: { name: 'اتعمل · مستني التقرير', cls: 'warn' }, sent: { name: 'اتبعت للدكتور', cls: 'py' },
  reported: { name: 'التقرير جاهز', cls: 'ok' }, delivered: { name: 'اتسلّم', cls: 'ok' },
};
export const printRad = (key) => openPrint(`/print/rad/${key}?auto=1`, 'rad' + key);

/** المعمل */
export const LAB_ST = {
  waiting: { name: 'مستني السحب', cls: '' }, collected: { name: 'في المعمل', cls: 'lab' }, sent: { name: 'اتبعت بره', cls: 'py' },
  done: { name: 'مستني الاعتماد', cls: 'warn' }, verified: { name: 'جاهزة', cls: 'ok' }, delivered: { name: 'اتسلّمت', cls: 'ok' },
};
export const LAB_SECTIONS = { hematology: 'أمراض دم', chemistry: 'كيمياء', hormones: 'هرمونات', serology: 'مناعة وفيروسات', urine: 'بول', stool: 'براز', coagulation: 'سيولة', other: 'أخرى' };
export const printLab = (gkey, keys) => openPrint(`/print/lab/${gkey}?auto=1${keys ? '&keys=' + keys.join(',') : ''}`, 'lab' + gkey);
export const printLabels = (gkey) => openPrint(`/print/lab-labels/${gkey}?auto=1`, 'lbl' + gkey);
/** نفس منطق السيرفر: أنسب معدل حسب النوع والسن */
export function labRange(ranges, sex, age) {
  const list = (ranges || []).filter((r) => (!r.s || r.s === sex) && (r.a0 == null || (age != null && age >= r.a0)) && (r.a1 == null || (age != null && age < r.a1)));
  list.sort((a, b) => ((b.s ? 1 : 0) + (b.a0 != null || b.a1 != null ? 2 : 0)) - ((a.s ? 1 : 0) + (a.a0 != null || a.a1 != null ? 2 : 0)));
  return list[0] || null;
}
export function labFlag(v, value, sex, age) {
  const s = String(value ?? '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).replace(/٫/g, '.').trim();
  if (!s) return null;
  if (v.kind === 'num') {
    const n = Number(s.replace(/[<>]/g, ''));
    if (!Number.isFinite(n)) return null;
    const r = labRange(v.ranges, sex, age);
    if (!r) return null;
    if (r.lo != null && n < r.lo) return 'L';
    if (r.hi != null && n > r.hi) return 'H';
    return null;
  }
  if (v.kind === 'select' && v.normal) return s.toLowerCase() === String(v.normal).toLowerCase() ? null : 'A';
  return null;
}

/** حسابات الإقامة: بنود الفاتورة الإجمالية */
export const TCAT = {
  night: { name: 'الإقامة', short: 'إقامة', icon: 'bed', c: '#7a3fb8' },
  service: { name: 'الخدمات', short: 'خدمات', icon: 'clipboard', c: '#0e8a87' },
  drug: { name: 'الأدوية', short: 'أدوية', icon: 'pill', c: '#d6336c' },
  supply: { name: 'المستلزمات', short: 'مستلزمات', icon: 'box', c: '#c97505' },
  fee: { name: 'أتعاب الأطباء', short: 'أتعاب', icon: 'steth', c: '#2c6ddc' },
  visit: { name: 'الزيارات', short: 'زيارات', icon: 'user', c: '#12708a' },
};
export const TICKET_KEYS = ['drug', 'supply', 'service', 'visit', 'fee'];
/** الفاتورة: detail تفصيلية | summary إجمالية */
export const printBill = (id, mode = 'detail', auto = false) => openPrint(`/print/admission/${id}?mode=${mode}${auto ? '&auto=1' : ''}`, 'inv' + id + mode);
/** أقسام مش من القوائم المرجعية (أدوية/مستلزمات/صيدلية): بتتضاف تاني بعد أي تحميل للقوائم، لأن applyLookups بتفضّي DEPT */
const EXTRA_DEPT = {
  drugs: { name: 'الأدوية', short: 'أدوية', icon: 'pill' },
  pharmacy: { name: 'الصيدلية', short: 'صيدلية', icon: 'pill' },
  supplies: { name: 'المستلزمات', short: 'مستلزمات', icon: 'box' },
};
Object.assign(DEPT, EXTRA_DEPT);
/** أقسام التغطية في التعاقد */
export const COVER_KEYS = [];

/** الكمية بأصغر وحدة ← نص بالوحدات (2 علبة + 3 شريط + 1 قرص) */
export function unitsText(qty, units) {
  const q = Number(qty || 0);
  if (!units?.length) return String(q);
  const base = units[0];
  if (q === 0) return `0 ${base.name}`;
  const neg = q < 0;
  let left = Math.abs(q);
  const parts = [];
  for (const u of [...units].sort((a, b) => b.factor - a.factor)) {
    if (u.factor === 1) continue;
    const n = Math.floor(left / u.factor);
    if (n) { parts.push(`${n} ${u.name}`); left -= n * u.factor; }
  }
  left = Math.round(left * 100) / 100;
  if (left || !parts.length) parts.push(`${left} ${base.name}`);
  return (neg ? '− ' : '') + parts.join(' + ');
}
export const TR_ST = {
  requested: { name: 'مطلوب', cls: 'warn' }, issued: { name: 'مستني الاستلام', cls: 'py' }, received: { name: 'مستني التأكيد', cls: 'lab' },
  confirmed: { name: 'خلص', cls: 'ok' }, cancelled: { name: 'اتلغى', cls: '' },
};
