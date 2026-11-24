// حسابات الإقامة: لوحة المرضى المقيمين، كتابة التذكرة اليومية، قفلها، المستحقات اللاحقة، والأصناف
import {
  api, html, icon, $, $$, money, egp, fmtWhen, fmtTime, ago, initials, modal, toast, toastError, askReason, can, debounce, ApiError,
  TCAT, TICKET_KEYS, ADM, printBill, showOrder, stayDays, nightsText, state,
} from '../core.js';
import { searchKey, latinDigits } from '/shared/text.js';
import { pickDoctor } from './pickers.js';

const WD = ['الحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
const wd = (d) => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
const dm = (d) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
const dayShort = (d) => `${wd(d)} ${dm(d)}`;
const dayLong = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d + 'T00:00:00Z'));
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
const catStyle = (k) => `--cc:${TCAT[k].c}`;
const autoPrint = () => localStorage.getItem('autoPrint') !== '0';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
};
const LATE_ST = { open: { name: 'مستني قرار', cls: 'warn' }, billed: { name: 'على المريض', cls: 'py' }, charged: { name: 'اتحمّلت', cls: 'danger' }, cancelled: { name: 'اتلغت', cls: '' } };

let catalogCache = null;
async function catalog(force = false) {
  if (!catalogCache || force || Date.now() - catalogCache.at > 3 * 60e3) {
    const [s, it] = await Promise.all([api.get('/catalog/services'), api.get('/tickets/items')]);
    catalogCache = { services: s.services, items: it.items, at: Date.now() };
  }
  return catalogCache;
}
/** الاختيارات لكل نوع في التذكرة */
function choices(cat, C) {
  if (cat === 'drug' || cat === 'supply') return C.items.filter((x) => x.kind === cat).map((x) => ({ ref: x, id: x.id, name: x.name, sub: x.unit, price: x.price, code: x.code }));
  const list = C.services.filter((s) => (cat === 'service' ? !s.ticketCat : s.ticketCat === cat));
  const order = { ward: 0, or: 1, lab: 2, radiology: 3, emergency: 4, clinic: 5 };
  list.sort((a, b) => (order[a.dept] ?? 9) - (order[b.dept] ?? 9) || (b.quick - a.quick));
  return list.map((s) => ({ ref: s, id: s.id, name: s.name, sub: { ward: 'إقامة', or: 'عمليات', lab: 'معمل', radiology: 'أشعة', emergency: 'طوارئ', clinic: 'عيادة' }[s.dept] || '', price: s.price, code: s.code, open: s.openPrice, doc: s.hasDoctor || cat === 'fee' || cat === 'visit' }));
}

// ======================= الشاشة الرئيسية =======================
export async function renderAccounts(view, { query, setTitle }) {
  const tab = ['late', 'items'].includes(query.get('tab')) ? query.get('tab') : 'list';
  setTitle('حسابات الإقامة', { list: 'التذكرة اليومية لكل مريض مقيم', late: 'حاجات اتنست بعد خروج المريض', items: 'أصناف الأدوية والمستلزمات وأسعارها' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">
    <a href="#/accounts" class="stab ${tab === 'list' ? 'on' : ''}">${icon('ticket')}<span>المرضى المقيمين</span></a>
    <a href="#/accounts?tab=late" class="stab ${tab === 'late' ? 'on' : ''}">${icon('history')}<span>مستحقات لاحقة</span><b class="badge warn hide" id="lateBadge"></b></a>
    <a href="#/accounts?tab=items" class="stab ${tab === 'items' ? 'on' : ''}">${icon('pill')}<span>الأصناف</span></a></nav><div id="ap"></div>`);
  const pane = $('#ap', view);
  if (tab === 'late') return latePane(pane);
  if (tab === 'items') return itemsPane(pane);
  return boardPane(pane);
}

async function boardPane(pane) {
  const S = { f: store.get('accFilter') || 'all', q: '' };
  pane.innerHTML = String(html`<div class="acc-kpis" id="kp"></div>
    <div class="row wrap" style="gap:10px;margin:14px 0 12px">
      <div class="chips" id="fl"></div>
      <div class="big-search" style="flex:1 1 240px;max-width:360px;margin-inline-start:auto">${icon('search')}<input class="input" id="aq" type="search" placeholder="اسم المريض، رقم الملف، أو الغرفة" style="height:44px;font-size:15px;padding-inline-start:42px;border-radius:12px"></div>
    </div><div id="al"><div class="skel" style="height:260px"></div></div>`);
  let data;
  const FILTERS = [['all', 'الكل'], ['today', 'محتاج تذكرة النهارده'], ['missing', 'عنده أيام ناقصة'], ['closed', 'اتقفلت']];
  const match = (a) => {
    if (S.f === 'today' && (a.closed || a.ticketsToday)) return false;
    if (S.f === 'missing' && !a.missing.length) return false;
    if (S.f === 'closed' && !a.closed) return false;
    const q = searchKey(S.q);
    return !q || searchKey(a.patient.name).includes(q) || String(a.patient.no) === q || String(a.bed.room).includes(q);
  };
  const card = (a) => {
    const st = a.closed ? 'closed' : a.ticketsToday ? 'ok' : 'none';
    return html`<article class="card acc-card st-${st}" data-open="${a.id}" tabindex="0">
      <div class="ac-top"><span class="pavatar ${a.patient.sex || ''}" style="width:42px;height:42px;border-radius:13px;font-size:14px">${initials(a.patient.name)}</span>
        <div style="min-width:0"><b>${a.patient.name}</b><small>غرفة <span class="num">${a.bed.room}</span> · ${a.bed.label} · ${ADM[a.type]?.name || ''} · ${nightsText(stayDays(a.admittedAt))}</small></div>
        <div class="ac-amt"><small>الحساب</small><b>${egp(a.gross)}</b></div></div>
      <div class="ac-meta">${a.payer ? html`<span class="badge py">${icon('shield', 'sm')} ${a.payer}</span>` : html`<span class="badge">نقدي</span>`}
        ${a.doctor ? html`<span class="muted">${icon('steth', 'sm')} ${a.doctor}</span>` : ''}</div>
      <div class="ac-status">
        ${a.closed ? html`<span class="tkst closed">${icon('lock', 'sm')} اتقفلت ${fmtTime(a.closedAt)}${a.order ? html` · إذن <span class="num">${a.order.no}</span> في الخزينة` : ''}</span>`
          : a.ticketsToday ? html`<span class="tkst ok">${icon('check', 'sm')} النهارده: ${a.ticketsToday === 1 ? 'دفعة' : a.ticketsToday === 2 ? 'دفعتين' : a.ticketsToday + ' دفعات'}</span>`
          : html`<span class="tkst none">${icon('ticket', 'sm')} لسه ما اتكتبش النهارده</span>`}
        ${a.missing.length && !a.closed ? html`<span class="tkst miss" title="${a.missing.map(dayShort).join('، ')}">${icon('alert', 'sm')} ${a.missing.length === 1 ? 'يوم ناقص' : a.missing.length === 2 ? 'يومين ناقصين' : a.missing.length + ' أيام ناقصة'}</span>` : ''}
        <span class="spacer"></span>${a.lastTicket ? html`<small class="muted">آخر دفعة ${ago(a.lastTicket.at)} · ${a.lastTicket.by.split(' ')[0]}</small>` : ''}
      </div></article>`;
  };
  const draw = () => {
    const c = data.counts;
    $('#kp', pane).innerHTML = String(html`
      <div class="akpi"><span class="gi">${icon('bed')}</span><div><small>مقيمين دلوقتي</small><b class="num">${c.total}</b></div></div>
      <div class="akpi warn"><span class="gi">${icon('ticket')}</span><div><small>محتاجين تذكرة النهارده</small><b class="num">${c.noTicketToday}</b></div></div>
      <div class="akpi danger"><span class="gi">${icon('alert')}</span><div><small>عندهم أيام ناقصة</small><b class="num">${c.missing}</b></div></div>
      <div class="akpi py"><span class="gi">${icon('lock')}</span><div><small>اتقفلت · مستنية الخروج</small><b class="num">${c.closed}</b></div></div>
      <a class="akpi late" href="#/accounts?tab=late"><span class="gi">${icon('history')}</span><div><small>مستحقات لاحقة مفتوحة</small><b class="num">${c.late}</b></div></a>`);
    const lb = $('#lateBadge');
    if (lb) { lb.textContent = c.late; lb.classList.toggle('hide', !c.late); }
    $('#fl', pane).innerHTML = String(html`${FILTERS.map(([k, n]) => html`<button class="chip ${S.f === k ? 'on' : ''}" data-f="${k}">${n}</button>`)}`);
    const list = data.admissions.filter(match);
    const floors = [...new Set(list.map((a) => a.bed.floor))];
    $('#al', pane).innerHTML = !list.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${data.admissions.length ? 'مفيش حد هنا' : 'مفيش مرضى مقيمين دلوقتي'}</b>${S.f === 'today' && data.admissions.length ? 'كل المرضى اتكتبلهم تذكرة النهارده 👏' : ''}</div>`)
      : String(html`${floors.map((f) => { const xs = list.filter((a) => a.bed.floor === f); return html`<section class="acc-floor"><h3 class="bb-fh"><span class="fno num">${f}</span>${xs[0].bed.floorName}<small>${xs.length} مريض</small></h3><div class="acc-grid">${xs.map(card)}</div></section>`; })}`);
  };
  const load = async () => { data = await api.get('/tickets/board'); draw(); };
  pane.onclick = (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { S.f = f.dataset.f; store.set('accFilter', S.f); draw(); return; }
    const o = e.target.closest('[data-open]');
    if (o && !e.target.closest('a')) window.go('/ticket/' + o.dataset.open);
  };
  pane.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-open]')) window.go('/ticket/' + e.target.dataset.open);
    if (e.key === 'Enter' && e.target.id === 'aq') { const l = data.admissions.filter(match); if (l.length === 1) window.go('/ticket/' + l[0].id); }
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'aq') { S.q = e.target.value; draw(); } }, 150);
  await load();
  setTimeout(() => $('#aq', pane)?.focus(), 40);
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 30000);
  return () => { clearInterval(timer); pane.onclick = pane.onkeydown = pane.oninput = null; };
}

// ======================= التذكرة =======================
export async function renderTicket(view, { params, setTitle }) {
  const id = Number(params[0]);
  view.innerHTML = String(html`<div class="skel" style="height:140px"></div>`);
  const [d0, C] = await Promise.all([api.get('/tickets/adm/' + id), catalog()]);
  const KEY = 'tkcur:' + id;
  const saved = store.get(KEY);
  const S = {
    d: d0, cat: saved?.cat || 'drug', q: '', sel: 0, date: saved?.date || d0.defaultDate, paperNo: saved?.paperNo || '',
    tk: saved?.tk || null, store: saved?.store || null, day: null, openTk: new Set(), flash: null, busy: 0, chain: Promise.resolve(),
  };
  // الدفعة اللي الموظف شغال فيها: لازم تكون بتاعته وبنفس اليوم
  const validTk = () => { const t = S.tk && S.d.tickets.find((x) => x.id === S.tk); if (!t || t.date !== S.date || (state.me && t.createdById !== state.me.id)) S.tk = null; };
  validTk();
  // سعر الدور اللي المريض فيه يوم التذكرة (الخدمات والزيارات بس)
  const floorNow = () => S.d.days.find((x) => x.date === S.date)?.floorId ?? S.d.days.at(-1)?.floorId;
  const priceOf = (x, cat) => (cat === 'drug' || cat === 'supply' || cat === 'fee' ? x.price : (S.d.floorSvc?.[floorNow()]?.[x.id] ?? x.price));
  // المتاح في مخزن الدور
  // المخزن اللي بيتصرف منه: اختيار الموظف، وإلا مخزن الدفعة، وإلا الافتراضي (الدور أو العناية/الحضانة)
  const storeNow = () => {
    const tk = S.tk && S.d.tickets.find((x) => x.id === S.tk);
    const ok = (v) => v && S.d.stores?.some((x) => x.id === v);
    if (ok(S.store)) return S.store;
    if (tk && ok(tk.storeId)) return tk.storeId;
    return S.d.days.find((x) => x.date === S.date)?.storeId ?? S.d.days.at(-1)?.storeId ?? null;
  };
  const stockOf = (x, cat) => {
    if (!S.d.stockDeduct || (cat !== 'drug' && cat !== 'supply')) return '';
    const q = S.d.stockByStore?.[storeNow()]?.[x.id] ?? 0;
    return html` · <span class="stk ${q <= 0 ? 'none' : ''}">${q <= 0 ? 'مش موجود في المخزن' : `متاح ${q}`}</span>`;
  };
  const curLines = () => (S.tk ? S.d.items.filter((i) => i.ticketId === S.tk && i.status === 'active') : []);
  /** كل طلبات الحفظ بالترتيب (عشان الدفعة ماتتعملش مرتين لو الكتابة سريعة) */
  const enqueue = (fn) => { S.busy++; drawSaving(); const p = S.chain.then(fn).finally(() => { S.busy--; drawSaving(); }); S.chain = p.catch(() => {}); return p; };
  const A = () => S.d.admission;
  const isOpen = () => A().status === 'active' && A().bill.status !== 'closed';
  const editable = () => isOpen() && can('adm.bill');
  const persist = () => store.set(KEY, { tk: S.tk, date: S.date, paperNo: S.paperNo, cat: S.cat, store: S.store });
  // اللي اتكتب للمريض قبل كده (للإضافة السريعة)
  const usedBefore = (cat) => {
    const seen = new Map();
    for (const i of S.d.items) {
      if (i.status !== 'active' || i.cat !== cat) continue;
      const k = cat === 'drug' || cat === 'supply' ? i.stockItemId : i.serviceId;
      if (k && !seen.has(k)) seen.set(k, { n: 0 });
      if (k) seen.get(k).n += i.qty;
    }
    const all = choices(cat, C);
    return [...seen.entries()].map(([k, v]) => ({ ...all.find((x) => x.id === k), n: v.n })).filter((x) => x.name).sort((a, b) => b.n - a.n).slice(0, 10);
  };
  const results = () => {
    const all = choices(S.cat, C);
    const q = searchKey(S.q);
    if (!q) return all.slice(0, 60);
    const words = q.split(' ').filter(Boolean);
    const hit = (x) => { const k = searchKey(x.name + ' ' + (x.code || '')); return words.every((w) => k.includes(w)); };
    // الأقرب الأول: الاسم بيبدأ بالكلام ← فيه الكلام متصل ← الكلمات متفرقة
    const rank = (x) => { const k = searchKey(x.name); return k.startsWith(q) ? 0 : k.includes(q) ? 1 : 2; };
    const mine = all.filter(hit).sort((a, b) => rank(a) - rank(b)).slice(0, 60);
    if (mine.length) return mine;
    // مش لاقيه هنا؟ ندوّر في باقي الأنواع
    return TICKET_KEYS.filter((k) => k !== S.cat).flatMap((k) => choices(k, C).filter(hit).map((x) => ({ ...x, cat: k }))).slice(0, 24);
  };

  const drawHead = () => {
    const a = A(), p = S.d.patient, b = S.d.bed, t = S.d.totals;
    setTitle(`تذكرة ${p.name.split(' ').slice(0, 2).join(' ')}`, `دخول ${a.no} · غرفة ${b.room.no} سرير ${b.label}`);
    $('#th', view).innerHTML = String(html`
      <div class="th-main"><span class="pavatar lg ${p.sex || ''}">${initials(p.name)}</span>
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><h2>${p.name}</h2><a class="fileno num" href="#/patient/${p.id}">#${p.no}</a>
          ${a.status !== 'active' ? html`<span class="badge">خرج ${fmtWhen(a.dischargedAt)}</span>` : a.bill.status === 'closed' ? html`<span class="badge py">${icon('lock', 'sm')} التذكرة اتقفلت</span>` : html`<span class="badge ok dot">التذكرة مفتوحة</span>`}</div>
          <div class="pmeta"><span>${icon('door', 'sm')}الدور ${b.floor.no} · غرفة <b class="num">${b.room.no}</b> · سرير ${b.label} · ${b.cls.name}</span>
            <span>${icon('clock', 'sm')}دخل ${fmtWhen(a.admittedAt)} · ${nightsText(a.nights)}</span>
            ${a.doctorName ? html`<span>${icon('steth', 'sm')}${a.doctorName}</span>` : ''}
            ${a.payer ? html`<span class="badge py">${icon('shield', 'sm')} ${a.payer.name} · ${a.payer.tierName}</span>` : html`<span class="badge">نقدي</span>`}</div></div></div>
      <div class="th-money">
        <div class="mtile"><small>الحساب</small><b>${egp(t.total)}</b></div>
        ${t.payer > 0 ? html`<div class="mtile py"><small>على ${a.payer?.name || 'التعاقد'}</small><b>${egp(t.payer)}</b></div>` : ''}
        <div class="mtile"><small>المدفوع</small><b style="color:var(--ok)">${egp(t.paid)}</b></div>
        <div class="mtile ${t.balance > 0 ? 'due' : 'ok'}"><small>${t.balance >= 0 ? 'المطلوب' : 'رصيد للمريض'}</small><b>${t.balance === 0 ? 'خالص' : egp(Math.abs(t.balance))}</b></div>
      </div>`);
  };

  // ----- إدخال البنود -----
  const drawEntry = () => {
    const box = $('#te', view);
    if (!editable()) {
      const a = A();
      box.innerHTML = String(html`<div class="tk-closed">
        <div class="tk-ic big">${icon(a.status === 'active' ? 'lock' : 'check')}</div>
        <h3>${a.status !== 'active' ? 'المريض خرج والحساب اتقفل' : a.bill.status === 'closed' ? 'التذكرة اتقفلت' : 'مش مسموح لك تكتب في التذكرة'}</h3>
        ${a.bill.closedAt ? html`<p class="muted">قفلها ${a.bill.closedBy || ''} · ${fmtWhen(a.bill.closedAt)}${a.bill.reopened ? html` · اتفتحت قبل كده ${a.bill.reopened} مرة` : ''}</p>` : ''}
        ${S.d.orders?.find((o) => o.kind === 'discharge') ? html`<div class="dutybar" style="justify-content:center">${icon('wallet', 'sm')}<span>إذن الخروج رقم <b class="num">${S.d.orders.find((o) => o.kind === 'discharge').no}</b> مستني في الخزينة · <b class="num">${money(Math.abs(S.d.orders.find((o) => o.kind === 'discharge').amount))}</b> ${HMS.money.symbol}</span></div>`
          : a.status === 'active' && a.bill.status === 'closed' ? html`<div class="alertbar info">${icon('info')}<span>${S.d.totals.balance === 0 ? 'الحساب خالص. الاستقبال يخرّج المريض.' : 'مفيش خزينة شغالة دلوقتي، الاستقبال هيحصّل ويخرّج المريض.'}</span></div>` : ''}
        <div class="row wrap" style="gap:8px;justify-content:center;margin-top:12px">
          <button class="btn" data-a="bill-s">${icon('print')} الفاتورة الإجمالية</button><button class="btn ghost" data-a="bill-d">${icon('list')} التفصيلية</button>
          ${a.status === 'active' && a.bill.status === 'closed' && can('adm.reopen') ? html`<button class="btn ghost" data-a="reopen">${icon('undo')} افتح التذكرة</button>` : ''}
          ${a.status !== 'active' && can('late.create') ? html`<button class="btn soft" data-a="late" style="--c:var(--warn)">${icon('history')} سجّل حاجة اتنست</button>` : ''}
        </div></div>`);
      return;
    }
    const min = S.d.days[0]?.date || S.date;
    box.innerHTML = String(html`
      <div class="tk-bar">
        <div class="field" style="flex:0 0 170px"><label>${icon('calendar', 'sm')} يوم التذكرة</label><input class="input num" type="date" id="tdate" value="${S.date}" min="${min}" max="${todayStr()}"></div>
        <div class="field" style="flex:0 1 150px"><label>رقم الورقة <span class="hint">اختياري</span></label><input class="input num" id="tpaper" value="${S.paperNo}" placeholder="مثلًا 1452" inputmode="numeric"></div>
        ${S.d.stockDeduct && S.d.stores?.length ? html`<div class="field" style="flex:0 1 190px"><label>${icon('box', 'sm')} اتصرف من</label><select class="select" id="tstore">${S.d.stores.map((x) => html`<option value="${x.id}" ${storeNow() === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></div>` : ''}
        <div class="tk-day">${S.date === todayStr() ? 'النهارده' : dayLong(S.date)}<small>${S.tk ? `بتكمّل في الدفعة رقم ${S.d.tickets.find((x) => x.id === S.tk)?.no || ''}` : S.d.days.find((x) => x.date === S.date)?.tickets ? `اتكتب فيه ${S.d.days.find((x) => x.date === S.date).tickets} دفعة قبل كده` : 'أول دفعة في اليوم ده'}</small>${S.d.floors?.[floorNow()] ? html`<span class="tk-floor">${icon('layers', 'sm')} أسعار الدور ${S.d.floors[floorNow()].no}</span>` : ''}</div>
      </div>
      <div class="tk-tabs" role="tablist">${TICKET_KEYS.map((k, i) => html`<button class="tk-tab ${S.cat === k ? 'on' : ''}" data-cat="${k}" style="${catStyle(k)}" role="tab" title="${TCAT[k].name} · Alt+${i + 1}">${icon(TCAT[k].icon, 'sm')} ${TCAT[k].short}
        ${curLines().filter((l) => l.cat === k).length ? html`<i class="num">${curLines().filter((l) => l.cat === k).length}</i>` : ''}</button>`)}</div>
      <div class="tk-search" style="${catStyle(S.cat)}">${icon('search')}<input class="input" id="tq" type="search" autocomplete="off" value="${S.q}"
        placeholder="${{ drug: 'اكتب اسم الدوا… (Enter يضيف)', supply: 'اكتب اسم المستلزم…', service: 'اكتب اسم الخدمة…', visit: 'زيارة طبيب أو استشاري…', fee: 'أتعاب جراح، تخدير، مساعد…' }[S.cat]}">
        <span class="kbd">↑↓ Enter</span></div>
      <div id="tqr"></div>
      <div class="tk-draft" id="td"></div>`);
    drawResults();
    drawDraft();
  };
  const drawResults = () => {
    const box = $('#tqr', view);
    if (!box) return;
    const list = results();
    if (S.sel >= list.length) S.sel = Math.max(0, list.length - 1);
    const used = !S.q ? usedBefore(S.cat) : [];
    box.innerHTML = String(html`
      ${used.length ? html`<div class="tk-used"><small>${icon('history', 'sm')} اتكتب للمريض قبل كده</small>${used.map((x) => html`<button class="chip" data-add="${x.id}">${x.name}${x.price ? html` <span class="num muted">${money(priceOf(x, S.cat))}</span>` : ''}</button>`)}</div>` : ''}
      ${list.length && list[0].cat ? html`<div class="tk-other">${icon('info', 'sm')} مش في ${TCAT[S.cat].name}، بس لقيته هنا:</div>` : ''}
      <div class="tk-results" style="${catStyle(S.cat)}">${list.map((x, i) => html`<button class="tk-res ${i === S.sel ? 'sel' : ''}" data-add="${x.id}" data-i="${i}" ${x.cat ? html`data-acat="${x.cat}" style="${catStyle(x.cat)}"` : ''}>
        <b>${x.name}</b><small>${x.cat ? html`<span style="color:${TCAT[x.cat].c};font-weight:800">${TCAT[x.cat].short}</span> · ` : ''}${x.sub || ''}${x.code ? html` · <span class="num">${x.code}</span>` : ''}${stockOf(x, x.cat || S.cat)}</small>
        ${x.doc ? html`<span class="doc-ic" title="محتاج دكتور">${icon('steth', 'sm')}</span>` : ''}
        <span class="pr">${x.open ? html`<small>سعر مفتوح</small>` : priceOf(x, x.cat || S.cat) !== x.price ? html`<small>سعر الدور</small>` : ''}<span class="num">${money(priceOf(x, x.cat || S.cat))}</span> ${HMS.money.symbol}</span></button>`)}
        ${!list.length ? html`<div class="empty" style="padding:18px">${C[S.cat === 'drug' || S.cat === 'supply' ? 'items' : 'services'].length ? 'مفيش حاجة بالاسم ده' : 'لسه مفيش أصناف. المدير أو مشرف الحسابات يضيفها من «الأصناف».'}</div>` : ''}</div>`);
    box.querySelector('.tk-res.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const drawSaving = () => {
    const e = $('#tsv', view);
    if (e) e.innerHTML = String(S.busy ? html`<span class="tk-sv busy">${icon('clock', 'sm')} بيتحفظ…</span>` : html`<span class="tk-sv ok">${icon('check', 'sm')} بيتحفظ لوحده</span>`);
  };
  // اختيار الوحدة (علبة/شريط/قرص) للأصناف اللي ليها أكتر من وحدة
  const unitPick = (l) => {
    if (!l.stockItemId) return '';
    const it = C.items.find((x) => x.id === l.stockItemId);
    if (!it) return '';
    const us = [{ key: 'base', name: it.unit || 'وحدة', f: 1 }, ...(it.midUnit && it.midQty ? [{ key: 'mid', name: it.midUnit, f: it.midQty }] : []), ...(it.packUnit && it.packQty ? [{ key: 'pack', name: it.packUnit, f: it.packQty }] : [])];
    if (us.length < 2) return '';
    const curF = l.unitFactor || 1;
    return html`<select class="select usel" data-unit="${l.id}">${us.map((u) => html`<option value="${u.key}" ${u.f === curF ? 'selected' : ''}>${u.name}</option>`)}</select>`;
  };
  const drawDraft = () => {
    const box = $('#td', view);
    if (!box) return;
    // نحافظ على مكان الكتابة لو اترسم تاني
    const ae = document.activeElement, keep = ae && box.contains(ae) ? (ae.dataset.qty ? `[data-qty="${ae.dataset.qty}"]` : ae.dataset.price ? `[data-price="${ae.dataset.price}"]` : null) : null;
    const lines = curLines();
    const tk = S.d.tickets.find((x) => x.id === S.tk);
    const total = lines.reduce((a, l) => a + l.amount, 0);
    box.innerHTML = !lines.length ? String(html`<div class="tk-empty">${icon('ticket')}<div><b>${S.tk ? 'الدفعة دي فاضية' : 'ابدأ اكتب الورقة'}</b><small>دوّر على البند واضغط Enter، واكتب العدد واضغط Enter تاني. كل سطر بيتحفظ لوحده، مفيش زرار حفظ.</small></div></div>`)
      : String(html`<div class="tk-dh"><b>${icon('list', 'sm')} الدفعة رقم <span class="num">${tk?.no || ''}</span></b><span class="muted">${lines.length} بند</span><span class="spacer"></span><span id="tsv"></span></div>
        <div class="tk-lines">${lines.map((l) => { const open = !!C.services.find((x) => x.id === l.serviceId)?.openPrice && l.cat !== 'drug' && l.cat !== 'supply'; return html`<div class="tk-line ${S.flash === l.id ? 'new' : ''}" style="${catStyle(l.cat)}" data-li="${l.id}">
          <span class="tk-ci">${icon(TCAT[l.cat].icon, 'sm')}</span>
          <div class="nm"><b>${l.name}</b><small>${l.doctorName ? html`${icon('steth', 'sm')} ${l.doctorName}` : TCAT[l.cat].name}${l.cover === 'pending' ? html` · <span style="color:var(--warn)">مستني موافقة</span>` : ''}</small></div>
          <label class="qty"><small>العدد</small><input class="input num" data-qty="${l.id}" value="${l.qty}" inputmode="numeric" autocomplete="off">${unitPick(l)}</label>
          ${open ? html`<label class="qty pr"><small>المبلغ</small><input class="input num" data-price="${l.id}" value="${l.unitPrice}" inputmode="decimal" autocomplete="off"></label>` : html`<span class="up num">× ${money(l.unitPrice)}</span>`}
          <b class="am num">${money(l.amount)}</b>
          <button class="rm" data-rmi="${l.id}" title="شيل">${icon('x', 'sm')}</button></div>`; })}</div>
        <div class="tk-foot"><div><small>إجمالي الدفعة</small><b>${egp(total)}</b></div>
          <button class="btn soft" data-a="newtk" style="margin-inline-start:auto" title="لما تنزل ورقة جديدة">${icon('plus')} ورقة جديدة</button></div>`);
    drawSaving();
    if (keep) { const f = $(keep, box); if (f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch { /* */ } } }
  };

  const refresh = (r, flash = null) => {
    S.d = r; validTk(); persist(); S.flash = flash;
    drawHead(); drawSide(); drawDraft();
    // عداد التبويبات
    $$('.tk-tab', view).forEach((b) => { const k = b.dataset.cat; const n = curLines().filter((l) => l.cat === k).length; let i = $('i', b); if (n) { if (!i) { i = document.createElement('i'); i.className = 'num'; b.append(i); } i.textContent = n; } else i?.remove(); });
    const dd = $('.tk-day small', view); if (dd && S.tk) dd.textContent = `بتكمّل في الدفعة رقم ${S.d.tickets.find((x) => x.id === S.tk)?.no || ''}`;
    setTimeout(() => { S.flash = null; }, 900);
  };

  const addChoice = async (x) => {
    if (!x) return;
    if (x.cat && x.cat !== S.cat) { S.cat = x.cat; persist(); drawEntry(); }
    const cat = S.cat;
    let doctor = null;
    if (x.doc) {
      doctor = await pickDoctor(`الدكتور · ${x.name}`);
      if (!doctor) return;
    }
    S.q = ''; S.sel = 0;
    const inp = $('#tq', view); if (inp) inp.value = '';
    drawResults();
    const stock = cat === 'drug' || cat === 'supply';
    // نفس الصنف ونفس الدكتور في نفس الدفعة: نزوّد العدد بدل سطر جديد
    const same = !x.open && curLines().find((l) => l.cat === cat && (stock ? l.stockItemId : l.serviceId) === x.id && (l.doctorId || null) === (doctor?.id || null));
    try {
      if (same) {
        const r = await enqueue(() => api.patch(`/tickets/adm/${id}/items/${same.id}`, { qty: same.qty + 1 }));
        refresh(r, same.id);
        const f = $(`[data-qty="${same.id}"]`, view); if (f) { f.focus(); f.select(); }
        return;
      }
      const r = await enqueue(() => api.post(`/tickets/adm/${id}/lines`, {
        ticketId: S.tk, date: S.date, paperNo: S.paperNo, storeId: S.d.stockDeduct ? storeNow() : undefined,
        line: { cat, qty: 1, doctorId: doctor?.id, price: x.open ? x.price : undefined, ...(stock ? { stockItemId: x.id } : { serviceId: x.id }) },
      }));
      if (S.tk !== r.ticket.id) S.openTk = new Set([r.ticket.id]);
      S.tk = r.ticket.id;
      refresh(r, r.itemId);
      if (r.pending) toast(`«${x.name}» محتاج موافقة ${A().payer?.name || 'التعاقد'}`, 'info', 4000);
      const f = $(`[data-${x.open ? 'price' : 'qty'}="${r.itemId}"]`, view); if (f) { f.focus(); f.select(); }
    } catch (e) { toastError(e); $('#tq', view)?.focus(); }
  };

  /** حفظ العدد/المبلغ لما الموظف يسيب الخانة */
  const commit = async (el) => {
    const iid = Number(el.dataset.qty || el.dataset.price);
    const it = S.d.items.find((i) => i.id === iid);
    if (!it) return;
    const v = latinDigits(el.value).trim();
    const isQty = el.dataset.qty != null;
    if (isQty ? Number(v) === it.qty : Number(v) === it.unitPrice) return;
    if (isQty && !(Number.isInteger(Number(v)) && Number(v) >= 1)) { toast('العدد لازم رقم صحيح من 1', 'err'); el.value = it.qty; return; }
    if (!isQty && !(Number(v) > 0)) { toast('اكتب المبلغ', 'err'); el.value = it.unitPrice; return; }
    try {
      const r = await enqueue(() => api.patch(`/tickets/adm/${id}/items/${iid}`, isQty ? { qty: Number(v) } : { price: Number(v) }));
      refresh(r);
    } catch (e) { toastError(e); el.value = isQty ? it.qty : it.unitPrice; }
  };

  const removeLine = async (iid) => {
    const it = S.d.items.find((i) => i.id === iid);
    try { refresh(await enqueue(() => api.del(`/tickets/adm/${id}/items/${iid}`, {}))); toast(`اتشال «${it.name}»`, 'info'); } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const reason = await askReason({ title: `شيل «${it.name}»`, confirm: 'شيل البند', note: 'السطر ده اتكتب من بدري أو كتبه موظف تاني، فلازم سبب.' });
        if (!reason) return;
        try { refresh(await enqueue(() => api.del(`/tickets/adm/${id}/items/${iid}`, { reason }))); toast('اتشال البند', 'info'); } catch (er) { toastError(er); }
      } else toastError(e);
    }
    $('#tq', view)?.focus();
  };

  // ----- الحساب والدفعات -----
  const drawSide = () => {
    const t = S.d.totals, bc = t.byCat || {};
    const tks = [...S.d.tickets].reverse().filter((x) => !S.day || x.date === S.day);
    const itemById = new Map(S.d.items.map((i) => [i.id, i]));
    const maxCat = Math.max(1, ...Object.values(bc));
    $('#ts', view).innerHTML = String(html`
      <div class="tk-sum">
        <div class="bill-head"><h3>${icon('wallet')} الحساب</h3><span class="spacer"></span>
          <button class="btn ghost sm" data-a="bill-s" title="الفاتورة الإجمالية">${icon('print', 'sm')} إجمالية</button><button class="btn ghost sm" data-a="bill-d" title="الفاتورة التفصيلية">${icon('list', 'sm')} تفصيلية</button></div>
        <div class="tk-cats">${Object.entries(TCAT).map(([k, c]) => html`<div class="tk-cat" style="--cc:${c.c}"><span>${icon(c.icon, 'sm')}</span><small>${c.name}</small><b>${egp(bc[k] || 0)}</b><i style="width:${Math.round(((bc[k] || 0) / maxCat) * 100)}%"></i></div>`)}</div>
        <div class="tk-total"><span>الإجمالي</span><b>${egp(t.total)}</b></div>
      </div>
      <div class="tk-days"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b style="font-size:14px">${icon('calendar', 'sm')} الأيام</b>
        ${S.d.missing.length ? html`<span class="badge danger">${S.d.missing.length} يوم من غير تذكرة</span>` : html`<span class="badge ok">${icon('check', 'sm')} كل الأيام متسجلة</span>`}</div>
        <div class="dchips">${S.d.days.map((x) => html`<button class="dchip ${x.tickets ? 'ok' : x.date < todayStr() ? 'miss' : 'none'} ${S.day === x.date ? 'on' : ''}" data-day="${x.date}" title="${dayLong(x.date)}${x.tickets ? ` · ${x.tickets} دفعة · ${money(x.total)} ${HMS.money.symbol}` : ' · مفيش تذكرة'}">
          <small>${wd(x.date)}</small><b class="num">${dm(x.date)}</b><i>${x.tickets ? x.tickets : x.date < todayStr() ? '!' : '·'}</i></button>`)}</div></div>
      <div class="tk-list"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b style="font-size:14px">${icon('ticket', 'sm')} الدفعات ${S.day ? html`<span class="muted">· ${dayLong(S.day)}</span>` : ''}</b>
        ${S.day ? html`<button class="linkbtn" data-day="">كل الأيام</button>` : html`<span class="muted num" style="font-size:13px">${S.d.tickets.length}</span>`}</div>
        ${!tks.length ? html`<div class="muted" style="font-size:13px;font-weight:600;padding:8px 2px">${S.day ? 'مفيش دفعات في اليوم ده' : 'لسه مفيش دفعات'}</div>` : ''}
        ${tks.map((tk) => { const open = S.openTk.has(tk.id); return html`<div class="tkb ${open ? 'open' : ''} ${S.flashTk === tk.id ? 'new' : ''}">
          <button class="tkb-h" data-tk="${tk.id}"><span class="tkno num">${tk.no}</span><div style="min-width:0"><b>${dayShort(tk.date)} · ${tk.shiftName || ''}${tk.paperNo ? html` · ورقة <span class="num">${tk.paperNo}</span>` : ''}</b>${tk.storeName && S.d.stockDeduct ? html`<span class="tk-store">${icon('box', 'sm')} ${tk.storeName}</span>` : ''}
            <small>${tk.createdBy} · ${fmtTime(tk.createdAt)} · ${tk.lines} بند${tk.voided ? ` · ${tk.voided} اتشال` : ''}</small></div><b class="num" style="margin-inline-start:auto">${money(tk.total)}</b>${icon(open ? 'chev-left' : 'chev-left', 'sm tkchev')}</button>
          ${open ? html`<div class="tkb-b">${tk.items.map((iid) => itemById.get(iid)).filter(Boolean).map((i) => html`<div class="tkl ${i.status}" style="${catStyle(i.cat || 'service')}">
            <span class="tk-ci sm">${icon(TCAT[i.cat || 'service'].icon, 'sm')}</span><span class="nm">${i.name}${i.qty > 1 ? html` <span class="muted num">× ${i.qty}</span>` : ''}${i.doctorName ? html` <small>· ${i.doctorName}</small>` : ''}${i.status === 'voided' ? html` <small>(${i.voidReason})</small>` : ''}</span>
            ${i.cover === 'pending' && i.status === 'active' ? html`<span class="badge warn">موافقة</span>` : ''}<b class="num">${money(i.amount)}</b>
            ${editable() && i.status === 'active' ? html`<button class="rm" data-void="${i.id}" title="شيل البند">${icon('trash', 'sm')}</button>` : html`<span></span>`}</div>`)}</div>` : ''}
        </div>`; })}</div>
      ${A().status === 'active' && A().bill.status !== 'closed' && can('adm.close') ? html`<div class="tk-close"><button class="btn lg full" data-a="close" style="--c:var(--py)">${icon('lock')} قفل التذكرة · المريض خارج</button>
        <small class="muted">بعد القفل الحساب بيتجمد، و${S.d.totals.balance !== 0 ? 'إذن الخروج بيروح للخزينة لوحده لو شغالة' : 'الاستقبال يخرّج المريض'}</small></div>` : ''}`);
  };

  view.innerHTML = String(html`<div class="card thead" id="th"></div>
    <div class="tgrid"><section class="card tentry" id="te"></section><aside class="card tside" id="ts"></aside></div>`);
  const drawAll = () => { drawHead(); drawEntry(); drawSide(); };
  drawAll();
  setTimeout(() => $('#tq', view)?.focus(), 50);

  const closeTicket = async (confirmPending = false) => {
    const fq = view.querySelector('[data-qty]:focus,[data-price]:focus');
    if (fq) await commit(fq);
    await S.chain;
    const t = S.d.totals, bc = t.byCat || {};
    if (!confirmPending) {
      const ok = await new Promise((resolve) => {
        let done = false;
        const m = modal({
          title: 'قفل التذكرة',
          body: html`${S.d.missing.length ? html`<div class="alertbar warn" style="margin-bottom:12px">${icon('alert')}<span>فيه ${S.d.missing.length} يوم من غير تذكرة: ${S.d.missing.map(dayShort).join('، ')}. اتأكد إن مفيش حاجة ناقصة.</span></div>` : ''}
            <div class="tk-cats close">${Object.entries(TCAT).filter(([k]) => bc[k]).map(([k, c]) => html`<div class="tk-cat" style="--cc:${c.c}"><span>${icon(c.icon, 'sm')}</span><small>${c.name}</small><b>${egp(bc[k])}</b></div>`)}</div>
            <div class="dsum" style="margin-top:12px"><div><small>الإجمالي</small><b>${egp(t.total)}</b></div>${t.payer > 0 ? html`<div class="py"><small>على التعاقد</small><b>${egp(t.payer)}</b></div>` : ''}<div><small>المدفوع</small><b style="color:var(--ok)">${egp(t.paid)}</b></div></div>
            <div class="dfinal ${t.balance < 0 ? 'ret' : t.balance === 0 ? 'zero' : ''}"><span>${t.balance > 0 ? 'المريض يدفع عند الخروج' : t.balance < 0 ? 'يرجع للمريض' : 'الحساب خالص'}</span><b>${t.balance === 0 ? '✓' : egp(Math.abs(t.balance))}</b></div>
            <div class="field" style="margin-top:12px"><label>ملاحظة <span class="hint">اختياري</span></label><input class="input" name="note" placeholder="مثلًا: خروج بأمر الدكتور"></div>
            <p class="muted" style="font-size:12.5px;font-weight:600;margin:10px 0 0">بعد القفل محدش يقدر يضيف أو يشيل. الفتح تاني لمشرف الحسابات أو المدير.</p>`,
          foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--py)">${icon('lock')} اقفل التذكرة</button>`,
          onClose: () => { if (!done) resolve(null); },
        });
        $('[data-ok]', m.el).addEventListener('click', () => { done = true; const note = $('[name=note]', m.el).value; m.close(); resolve({ note }); });
      });
      if (!ok) return;
      S.closeNote = ok.note;
    }
    try {
      const r = await api.post(`/tickets/adm/${id}/close`, { note: S.closeNote, confirmPending });
      S.d = r; drawAll(); window.refreshShell?.();
      if (r.order) showOrder(r.order, { autoPrint: autoPrint() });
      else toast('التذكرة اتقفلت');
      if (autoPrint()) printBill(id, 'summary', true);
    } catch (e) {
      if (e instanceof ApiError && e.data.pendingApprovals) {
        const go2 = await new Promise((resolve) => {
          const m = modal({ title: 'موافقات لسه مستنية', body: html`<div class="alertbar warn">${icon('alert')}<span>${e.message}</span></div>`,
            foot: html`<button class="btn ghost" data-close>استنى المراجعة</button><button class="btn" data-ok style="--c:var(--py)">اقفل برضه</button>`, onClose: () => resolve(false) });
          $('[data-ok]', m.el).addEventListener('click', () => { resolve(true); m.close(); });
        });
        if (go2) return closeTicket(true);
        return;
      }
      toastError(e);
    }
  };

  view.onclick = async (e) => {
    const t = e.target;
    const c = t.closest('[data-cat]');
    if (c) { S.cat = c.dataset.cat; S.q = ''; S.sel = 0; persist(); drawEntry(); $('#tq', view)?.focus(); return; }
    const ad = t.closest('[data-add]');
    if (ad) { const ct = ad.dataset.acat || S.cat; const x = choices(ct, C).find((y) => y.id === Number(ad.dataset.add)); return addChoice(x && { ...x, cat: ct }); }
    const rl = t.closest('[data-rmi]');
    if (rl) return removeLine(Number(rl.dataset.rmi));
    const dy = t.closest('[data-day]');
    if (dy) { S.day = dy.dataset.day || null; if (S.day && editable() && S.day !== S.date) { S.date = S.day; S.tk = null; persist(); drawEntry(); } drawSide(); return; }
    const tk = t.closest('[data-tk]');
    if (tk) { const k = Number(tk.dataset.tk); if (S.openTk.has(k)) S.openTk.delete(k); else S.openTk.add(k); S.flashTk = null; drawSide(); return; }
    const vd = t.closest('[data-void]');
    if (vd) {
      const it = S.d.items.find((i) => i.id === Number(vd.dataset.void));
      const reason = await askReason({ title: `شيل «${it.name}» من التذكرة`, confirm: 'شيل البند', note: 'العملية دي متسجلة باسمك.' });
      if (!reason) return;
      try { S.d = await api.del(`/tickets/adm/${id}/items/${it.id}`, { reason }); drawHead(); drawSide(); toast('اتشال البند', 'info'); } catch (er) { toastError(er); }
      return;
    }
    const a = t.closest('[data-a]')?.dataset.a;
    if (a === 'newtk') { await S.chain; S.tk = null; S.paperNo = ''; persist(); drawEntry(); drawSide(); $('#tpaper', view)?.focus(); toast('ورقة جديدة: اكتب رقمها لو موجود وابدأ', 'info'); return; }
    if (a === 'bill-s') return printBill(id, 'summary');
    if (a === 'bill-d') return printBill(id, 'detail');
    if (a === 'close') return closeTicket();
    if (a === 'late') return lateModal({ admission: { id, no: A().no, patient: S.d.patient } });
    if (a === 'reopen') {
      const reason = await askReason({ title: 'فتح التذكرة تاني', confirm: 'افتح التذكرة', danger: false, note: S.d.orders?.some((o) => o.kind === 'discharge') ? 'إذن الخروج اللي في الخزينة هيتلغي.' : '' });
      if (!reason) return;
      try { S.d = await api.post(`/tickets/adm/${id}/reopen`, { reason }); drawAll(); toast('التذكرة اتفتحت'); window.refreshShell?.(); } catch (er) { toastError(er); }
    }
  };
  view.oninput = (e) => {
    const t = e.target;
    if (t.id === 'tq') { S.q = t.value; S.sel = 0; drawResults(); return; }
    if (t.id === 'tpaper') { S.paperNo = t.value; persist(); }
  };
  view.onchange = async (e) => {
    const t = e.target;
    if (t.id === 'tdate') { if (/^\d{4}-\d{2}-\d{2}$/.test(t.value) && t.value !== S.date) { await S.chain; S.date = t.value; S.tk = null; persist(); drawEntry(); } return; }
    if (t.id === 'tstore') { await S.chain; const v = Number(t.value); const def = S.d.days.find((x) => x.date === S.date)?.storeId; S.store = v === def ? null : v; S.tk = null; persist(); drawEntry(); toast(`الصرف من «${S.d.stores.find((x) => x.id === v)?.name}» · دفعة جديدة`, 'info'); return; }
    if (t.dataset.unit != null) {
      try { refresh(await enqueue(() => api.patch(`/tickets/adm/${id}/items/${t.dataset.unit}`, { unit: t.value }))); } catch (er) { toastError(er); drawDraft(); }
      return;
    }
    if (t.id === 'tpaper' && S.tk) { try { refresh(await enqueue(() => api.put(`/tickets/adm/${id}/t/${S.tk}`, { paperNo: S.paperNo }))); } catch (er) { toastError(er); } return; }
  };
  // سيبت خانة العدد/المبلغ: يتحفظ
  view.addEventListener('focusout', (e) => { if (e.target.dataset?.qty != null || e.target.dataset?.price != null) commit(e.target); });
  const onKey = (e) => {
    if (document.querySelector('.overlay')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); const f = view.querySelector('[data-qty]:focus,[data-price]:focus'); (f ? commit(f) : Promise.resolve()).then(() => S.chain).then(() => toast('كله محفوظ')); return; }
    if (e.altKey && /^[1-5]$/.test(e.key) && editable()) { e.preventDefault(); S.cat = TICKET_KEYS[Number(e.key) - 1]; S.q = ''; persist(); drawEntry(); $('#tq', view)?.focus(); return; }
    const t = e.target;
    if (t.id === 'tq') {
      const list = results();
      if (e.key === 'ArrowDown') { e.preventDefault(); S.sel = Math.min(list.length - 1, S.sel + 1); drawResults(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); S.sel = Math.max(0, S.sel - 1); drawResults(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (S.q || list.length) addChoice(list[S.sel]); }
      return;
    }
    if ((t.dataset.qty != null || t.dataset.price != null) && e.key === 'Enter') {
      e.preventDefault();
      // Enter = السطر خلص ← الحفظ بيحصل لما الخانة تفقد التركيز (focusout)
      if (t.dataset.price != null) { const q = $(`[data-qty="${t.dataset.price}"]`, view); q?.focus(); q?.select(); return; }
      $('#tq', view)?.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => { document.removeEventListener('keydown', onKey); view.onclick = view.oninput = view.onchange = null; };
}

// ======================= المستحقات اللاحقة =======================
function lateModal({ admission = null, onDone } = {}) {
  return (async () => {
    const C = await catalog();
    const X = { adm: admission, cat: 'drug', q: '', item: null, doctor: null, qty: 1, price: '', reason: '', aq: '', found: [] };
    const m = modal({ title: 'تسجيل حاجة اتنست بعد الخروج', wide: true, body: html`<div id="lx"></div>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--warn)">${icon('check')} سجّل</button>` });
    const draw = async () => {
      const box = $('#lx', m.el);
      if (!X.adm) {
        box.innerHTML = String(html`<div class="field"><label>المريض اللي خرج</label><div class="big-search">${icon('search')}<input class="input" id="lq" value="${X.aq}" placeholder="اسم المريض، رقم الملف، رقم الدخول، أو التليفون" style="height:46px;padding-inline-start:44px" autofocus></div></div>
          <div class="late-adms">${X.found.map((a) => html`<button class="late-adm" data-adm="${a.id}"><span class="pavatar" style="width:36px;height:36px;border-radius:11px;font-size:12px">${initials(a.patient.name)}</span><div><b>${a.patient.name}</b><small>ملف <span class="num">${a.patient.no}</span> · دخول <span class="num">${a.no}</span> · خرج ${fmtWhen(a.dischargedAt)}</small></div></button>`)}
          ${!X.found.length ? html`<div class="muted" style="padding:10px;font-weight:600">${X.aq ? 'مفيش نتايج' : 'آخر المرضى اللي خرجوا هيظهروا هنا'}</div>` : ''}</div>`);
        const i = $('#lq', box); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
        return;
      }
      const list = choices(X.cat, C).filter((x) => !X.q || searchKey(x.name).includes(searchKey(X.q))).slice(0, 30);
      box.innerHTML = String(html`<div class="pricehead" style="--ds:var(--warn-soft);--dc:var(--warn)"><span class="dicon">${icon('history')}</span><div><b>${X.adm.patient.name}</b><small>دخول رقم <span class="num">${X.adm.no}</span></small></div>${admission ? '' : html`<button class="linkbtn" data-chg style="margin-inline-start:auto">غيّر</button>`}</div>
        ${X.item ? html`<div class="late-pick" style="${catStyle(X.cat)}"><span class="tk-ci">${icon(TCAT[X.cat].icon, 'sm')}</span><div style="min-width:0"><b>${X.item.name}</b><small>${TCAT[X.cat].name}${X.doctor ? ' · ' + X.doctor.name : ''}</small></div><button class="linkbtn" data-unpick>غيّر</button></div>
          <div class="row" style="gap:10px;margin-top:10px"><div class="field" style="flex:0 0 110px"><label>العدد</label><input class="input num" name="qty" value="${X.qty}"></div>
          ${X.item.open ? html`<div class="field" style="flex:0 0 140px"><label>المبلغ</label><input class="input num" name="price" value="${X.price}"></div>` : html`<div class="field" style="flex:1"><label>السعر</label><div class="input num" style="display:flex;align-items:center;background:var(--bg-2)">${money(X.item.price)} ${HMS.money.symbol}</div></div>`}</div>`
        : html`<div class="tk-tabs" style="margin-top:12px">${TICKET_KEYS.map((k) => html`<button class="tk-tab ${X.cat === k ? 'on' : ''}" data-lcat="${k}" style="${catStyle(k)}">${icon(TCAT[k].icon, 'sm')} ${TCAT[k].short}</button>`)}</div>
          <input class="input" id="liq" value="${X.q}" placeholder="دوّر…" style="margin-top:8px">
          <div class="tk-results sm" style="${catStyle(X.cat)}">${list.map((x) => html`<button class="tk-res" data-lpick="${x.id}"><b>${x.name}</b><small>${x.sub || ''}</small><span class="pr"><span class="num">${money(x.price)}</span> ${HMS.money.symbol}</span></button>`)}</div>`}
        <div class="field" style="margin-top:12px" data-f="reason"><label>إيه اللي حصل؟ <span class="req">*</span></label><input class="input" name="reason" value="${X.reason}" placeholder="مثلًا: التمريض نسي يكتب القسطرة في التذكرة"><div class="msg"></div></div>`);
      if (!X.item) $('#liq', box)?.focus();
    };
    const search = debounce(async () => { X.found = (await api.get('/tickets/late/admissions?q=' + encodeURIComponent(X.aq))).admissions; draw(); }, 220);
    X.found = (await api.get('/tickets/late/admissions')).admissions;
    draw();
    m.el.addEventListener('input', (e) => {
      if (e.target.id === 'lq') { X.aq = e.target.value; search(); }
      if (e.target.id === 'liq') { X.q = e.target.value; const pos = e.target.selectionStart; draw().then(() => { const i = $('#liq', m.el); i?.setSelectionRange(pos, pos); }); }
      if (e.target.name === 'qty') X.qty = latinDigits(e.target.value);
      if (e.target.name === 'price') X.price = latinDigits(e.target.value);
      if (e.target.name === 'reason') X.reason = e.target.value;
    });
    m.el.addEventListener('click', async (e) => {
      const ad = e.target.closest('[data-adm]');
      if (ad) { const a = X.found.find((x) => x.id === Number(ad.dataset.adm)); X.adm = a; return draw(); }
      if (e.target.closest('[data-chg]')) { X.adm = null; X.item = null; return draw(); }
      const lc = e.target.closest('[data-lcat]');
      if (lc) { X.cat = lc.dataset.lcat; X.q = ''; return draw(); }
      const lp = e.target.closest('[data-lpick]');
      if (lp) {
        const x = choices(X.cat, C).find((y) => y.id === Number(lp.dataset.lpick));
        if (x.doc) { const d = await pickDoctor(`الدكتور · ${x.name}`); if (!d) return; X.doctor = d; } else X.doctor = null;
        X.item = x; X.price = x.price; return draw();
      }
      if (e.target.closest('[data-unpick]')) { X.item = null; return draw(); }
      if (!e.target.closest('[data-ok]')) return;
      if (!X.adm) return toast('اختار المريض الأول', 'err');
      if (!X.item) return toast('اختار البند', 'err');
      try {
        const r = await api.post('/tickets/late', {
          admissionId: X.adm.id, cat: X.cat, qty: X.qty, reason: X.reason, doctorId: X.doctor?.id, price: X.item.open ? X.price : undefined,
          ...(X.cat === 'drug' || X.cat === 'supply' ? { stockItemId: X.item.id } : { serviceId: X.item.id }),
        });
        m.close(); toast(`اتسجل المستحق رقم ${r.late.no} · ${money(r.late.amount)} ${HMS.money.unitWord}`); onDone?.(r.late);
      } catch (er) {
        if (er instanceof ApiError && er.data.errors?.reason) { const f = $('[data-f=reason]', m.el); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.reason; $('input', f).focus(); } else toastError(er);
      }
    });
  })();
}

function decideModal(l, after) {
  return (async () => {
    const names = await api.get('/tickets/late/names').catch(() => ({ users: [], employees: [], depts: [] }));
    let to = 'patient';
    const m = modal({
      title: `قرار المستحق رقم ${l.no}`,
      body: html`<div class="pricehead" style="--ds:var(--warn-soft);--dc:var(--warn)"><span class="dicon">${icon(TCAT[l.cat]?.icon || 'history')}</span><div><b>${l.name}${l.qty > 1 ? ` × ${l.qty}` : ''}</b><small>${l.patient.name} · ${l.patient.phone ? html`<a class="num" href="tel:${l.patient.phone}">${l.patient.phone}</a>` : 'من غير تليفون'}</small></div><div class="cur"><b>${egp(l.amount)}</b></div></div>
        <p class="muted" style="font-weight:600;font-size:13px;margin:10px 0">${l.reason}</p>
        <div class="seg full" id="dto"><button data-to="patient" class="on">${icon('user', 'sm')} المريض هيدفع</button><button data-to="employee">${icon('users', 'sm')} على موظف</button><button data-to="dept">${icon('door', 'sm')} على القسم</button><button data-to="cancel">${icon('x', 'sm')} إلغاء</button></div>
        <div id="dbody" style="margin-top:12px"></div>
        <datalist id="emps">${[...new Set([...names.employees, ...names.users.map((u) => u.name)])].map((n) => html`<option value="${n}">`)}</datalist>
        <datalist id="depts">${names.depts.map((n) => html`<option value="${n}">`)}</datalist>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok>${icon('check')} تمام</button>`,
    });
    const drawB = () => {
      $('#dbody', m.el).innerHTML = String(to === 'patient' ? html`<div class="alertbar info">${icon('info')}<span>البند هيتضاف على حساب المريض${''}، ولو الخزينة شغالة هيطلع إذن دفع بيه.</span></div><input class="input" name="note" placeholder="ملاحظة (مثلًا: اتصلنا بابنه ووافق)" style="margin-top:8px">`
        : to === 'cancel' ? html`<div class="field" data-f="note"><label>سبب الإلغاء <span class="req">*</span></label><input class="input" name="note"><div class="msg"></div></div>`
        : html`<div class="field" data-f="name"><label>${to === 'employee' ? 'اسم الموظف' : 'القسم / المكان'} <span class="req">*</span></label><input class="input" name="name" list="${to === 'employee' ? 'emps' : 'depts'}" autocomplete="off"><div class="msg"></div></div>
          <input class="input" name="note" placeholder="ملاحظة (مثلًا: المريض رفض يدفع)" style="margin-top:8px">`);
      $('input', $('#dbody', m.el))?.focus();
    };
    drawB();
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-to]');
      if (b) { to = b.dataset.to; $$('[data-to]', m.el).forEach((x) => x.classList.toggle('on', x === b)); drawB(); return; }
      if (!e.target.closest('[data-ok]')) return;
      const val = (n) => $(`[name=${n}]`, m.el)?.value || '';
      if ((to === 'employee' || to === 'dept') && val('name').trim().length < 2) { const f = $('[data-f=name]', m.el); f.classList.add('err'); $('.msg', f).textContent = 'مطلوب'; return; }
      if (to === 'cancel' && val('note').trim().length < 3) { const f = $('[data-f=note]', m.el); f.classList.add('err'); $('.msg', f).textContent = 'اكتب السبب'; return; }
      try {
        const r = await api.post(`/tickets/late/${l.id}/decide`, { to, name: val('name'), note: val('note') });
        m.close(); after?.();
        if (r.order) showOrder(r.order, { autoPrint: autoPrint() }); else toast('اتسجل القرار');
      } catch (er) { toastError(er); }
    });
  })();
}

async function latePane(pane) {
  const S = { st: 'open', from: '', to: '' };
  pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px">
      <div class="seg" id="lst">${[['open', 'مستني قرار'], ['billed', 'على المريض'], ['charged', 'اتحمّلت'], ['all', 'الكل']].map(([k, n]) => html`<button data-st="${k}" class="${S.st === k ? 'on' : ''}">${n}</button>`)}</div>
      <input class="input num" type="date" id="lf" style="width:160px" title="من"><input class="input num" type="date" id="lt" style="width:160px" title="لحد">
      <span class="spacer"></span>
      ${can('late.create') ? html`<button class="btn" data-a="new" style="--c:var(--warn)">${icon('plus')} سجّل حاجة اتنست</button>` : ''}
    </div><div id="lsum"></div><div id="lls"><div class="skel" style="height:200px"></div></div>`);
  let data;
  const draw = () => {
    const s = data.summary;
    $('#lsum', pane).innerHTML = String(html`<div class="late-sum">
      <div class="akpi warn"><span class="gi">${icon('hourglass')}</span><div><small>مستني قرار</small><b>${egp(s.open.amount)}</b><em>${s.open.n} بند</em></div></div>
      <div class="akpi py"><span class="gi">${icon('user')}</span><div><small>المريض دفعها / هيدفعها</small><b>${egp(s.billed.amount)}</b><em>${s.billed.n} بند</em></div></div>
      <div class="akpi danger"><span class="gi">${icon('alert')}</span><div><small>اتحمّلت على موظف أو قسم</small><b>${egp(s.charged.amount)}</b><em>${s.charged.n} بند</em></div></div>
      ${s.byWho.length ? html`<div class="card late-who"><b>${icon('users', 'sm')} التحميل على مين</b>${s.byWho.slice(0, 6).map((g) => html`<div class="lw"><span>${icon(g.to === 'employee' ? 'user' : 'door', 'sm')} ${g.name}</span><small class="muted">${g.n}</small><b class="num">${money(g.amount)}</b></div>`)}</div>` : ''}
    </div>`);
    $('#lls', pane).innerHTML = !data.late.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${S.st === 'open' ? 'مفيش حاجة مستنية قرار' : 'مفيش حاجة هنا'}</b></div>`)
      : String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>المريض</th><th>البند</th><th class="n">المبلغ</th><th>اللي حصل</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${data.late.map((l) => html`<tr><td class="num">${l.no}</td><td><b>${l.patient.name}</b><div class="muted" style="font-size:12px">دخول <span class="num">${l.admission.no}</span> · ${fmtWhen(l.createdAt)} · ${l.createdBy}</div></td>
          <td><span class="dtag" style="--ds:color-mix(in srgb, ${TCAT[l.cat]?.c} 12%, #fff);--dc:${TCAT[l.cat]?.c}">${icon(TCAT[l.cat]?.icon || 'plus', 'sm')} ${l.name}${l.qty > 1 ? ` × ${l.qty}` : ''}</span></td>
          <td class="n"><b class="num">${money(l.amount)}</b></td><td style="max-width:240px;font-size:13px">${l.reason}</td>
          <td><span class="badge ${LATE_ST[l.status].cls}">${LATE_ST[l.status].name}</span>${l.chargeName ? html`<div style="font-size:12px;margin-top:3px;font-weight:700">${l.chargeName}</div>` : ''}${l.order ? html`<div class="muted" style="font-size:12px">إذن <span class="num">${l.order.no}</span>${l.order.status === 'done' ? ' · اتحصّل' : ''}</div>` : ''}</td>
          <td>${l.status === 'open' && data.canDecide ? html`<button class="btn sm" data-dec="${l.id}">${icon('check', 'sm')} قرار</button>` : ''}</td></tr>`)}
      </tbody></table></div></div>`);
  };
  const load = async () => {
    const qs = new URLSearchParams();
    if (S.st !== 'all') qs.set('status', S.st);
    if (S.from) qs.set('from', S.from);
    if (S.to) qs.set('to', S.to);
    data = await api.get('/tickets/late?' + qs);
    draw();
  };
  pane.onclick = (e) => {
    const st = e.target.closest('[data-st]');
    if (st) { S.st = st.dataset.st; $$('[data-st]', pane).forEach((x) => x.classList.toggle('on', x === st)); return load(); }
    if (e.target.closest('[data-a="new"]')) return lateModal({ onDone: () => { S.st = 'open'; load(); } });
    const dc = e.target.closest('[data-dec]');
    if (dc) return decideModal(data.late.find((x) => x.id === Number(dc.dataset.dec)), load);
  };
  pane.onchange = (e) => { if (e.target.id === 'lf') { S.from = e.target.value; load(); } if (e.target.id === 'lt') { S.to = e.target.value; load(); } };
  await load();
  return () => { pane.onclick = pane.onchange = null; };
}

// ======================= الأصناف =======================
export async function itemsPane(pane) {
  const edit = can('stock.edit');
  const S = { kind: 'all', q: '', all: edit };
  pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px">
      <div class="seg" id="ik">${[['all', 'الكل'], ['drug', 'أدوية'], ['supply', 'مستلزمات']].map(([k, n]) => html`<button data-k="${k}" class="${S.kind === k ? 'on' : ''}">${n}</button>`)}</div>
      <div class="big-search" style="flex:1 1 220px;max-width:340px">${icon('search')}<input class="input" id="iq" type="search" placeholder="اسم الصنف أو الكود" style="height:42px;padding-inline-start:42px;border-radius:12px"></div>
      <span class="spacer"></span>
      ${edit ? html`<a class="btn ghost" href="/api/tickets/items/export">${icon('download')} تصدير إكسل</a>
        <label class="btn ghost" style="cursor:pointer">${icon('upload')} استيراد من إكسل<input type="file" id="ifile" accept=".xlsx" hidden></label>
        <button class="btn ghost" data-a="units">${icon('settings')} الوحدات</button>
        <button class="btn" data-a="new">${icon('plus')} صنف جديد</button>` : ''}
    </div><div id="il"><div class="skel" style="height:240px"></div></div>`);
  let items = [], units = [];
  const draw = () => {
    const q = searchKey(S.q);
    const list = items.filter((x) => (S.kind === 'all' || x.kind === S.kind) && (!q || searchKey(x.name + ' ' + x.code).includes(q)));
    $('#il', pane).innerHTML = String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الكود</th><th>اسم الصنف</th><th>النوع</th><th>الوحدة</th><th class="n">السعر</th>${edit ? html`<th></th>` : ''}</tr></thead><tbody>
      ${list.slice(0, 400).map((x) => html`<tr class="${x.active ? '' : 'off-row'} ${edit ? 'click' : ''}" data-edit="${x.id}"><td class="num">${x.code}</td><td><b>${x.name}</b>${x.active ? '' : html` <span class="badge">موقوف</span>`}</td>
        <td><span class="dtag" style="--ds:color-mix(in srgb, ${TCAT[x.kind].c} 12%, #fff);--dc:${TCAT[x.kind].c}">${icon(TCAT[x.kind].icon, 'sm')} ${x.kind === 'drug' ? 'دواء' : 'مستلزم'}</span></td><td>${x.unit}${x.midUnit ? html` <small class="muted">· ${x.midUnit} ${x.midQty}</small>` : ''}${x.packUnit ? html` <small class="muted">· ${x.packUnit} ${x.packQty}</small>` : ''}</td>
        <td class="n"><b class="num">${money(x.price)}</b></td>${edit ? html`<td>${icon('edit', 'sm')}</td>` : ''}</tr>`)}
      ${!list.length ? html`<tr><td colspan="6"><div class="empty">مفيش أصناف</div></td></tr>` : ''}</tbody></table></div>
      ${list.length > 400 ? html`<div class="muted" style="padding:8px;font-weight:600">بيظهر أول 400 بس. دوّر بالاسم.</div>` : ''}</div>`);
  };
  const load = async () => { [items, units] = await Promise.all([api.get('/tickets/items' + (S.all ? '?all=1' : '')).then((r) => r.items), api.get('/tickets/units').then((r) => r.units)]); catalogCache = null; draw(); };
  const editModal = (x) => {
    const v = x || { name: '', kind: S.kind === 'supply' ? 'supply' : 'drug', unit: '', price: '', code: '', barcode: '', active: true, midUnit: '', midQty: null, packUnit: '', packQty: null, minQty: null };
    const uOpts = (cur, none) => html`<option value="">${none}</option>${[...units.filter((u) => u.active || u.name === cur).map((u) => u.name), ...(cur && !units.some((u) => u.name === cur) ? [cur] : [])].map((n) => html`<option value="${n}" ${n === cur ? 'selected' : ''}>${n}</option>`)}`;
    const unitOpts = (cur) => html`<option value="" ${!cur ? 'selected' : ''}>زي الوضع العادي</option><option value="base" ${cur === 'base' ? 'selected' : ''}>الوحدة الصغيرة</option><option value="mid" ${cur === 'mid' ? 'selected' : ''}>الوحدة الوسطى</option><option value="pack" ${cur === 'pack' ? 'selected' : ''}>الوحدة الكبيرة</option>`;
    const m = modal({
      title: x ? 'تعديل صنف' : 'صنف جديد',
      body: html`<div class="grid" style="gap:12px">
        <div class="seg full" id="ek"><button data-ek="drug" class="${v.kind === 'drug' ? 'on' : ''}">${icon('pill', 'sm')} دواء</button><button data-ek="supply" class="${v.kind === 'supply' ? 'on' : ''}">${icon('box', 'sm')} مستلزم</button></div>
        <div class="field" data-f="name"><label>اسم الصنف <span class="req">*</span></label><input class="input" name="name" value="${v.name}" autofocus autocomplete="off"><div class="msg"></div><div id="dupbox"></div></div>
        <div class="row" style="gap:10px"><div class="field" data-f="unit" style="flex:1"><label>أصغر وحدة <span class="hint">السعر عليها</span></label><select class="select" name="unit">${uOpts(v.unit, 'اختار الوحدة')}</select><div class="msg"></div></div>
          <div class="field" data-f="price" style="flex:1"><label>السعر <span class="req">*</span></label><input class="input num" name="price" value="${v.price}" inputmode="decimal"><div class="msg"></div></div></div>
        <div class="row" style="gap:10px"><div class="field" data-f="midUnit" style="flex:1"><label>وحدة وسطى <span class="hint">اختياري</span></label><select class="select" name="midUnit">${uOpts(v.midUnit, 'بدون')}</select></div>
          <div class="field" data-f="midQty" style="flex:1"><label>فيها كام ${v.unit || 'وحدة'}</label><input class="input num" name="midQty" value="${v.midQty ?? ''}" inputmode="numeric"><div class="msg"></div></div></div>
        <div class="row" style="gap:10px"><div class="field" data-f="packUnit" style="flex:1"><label>وحدة كبيرة <span class="hint">اختياري</span></label><select class="select" name="packUnit">${uOpts(v.packUnit, 'بدون')}</select></div>
          <div class="field" data-f="packQty" style="flex:1"><label>فيها كام ${v.unit || 'وحدة'}</label><input class="input num" name="packQty" value="${v.packQty ?? ''}" inputmode="numeric"><div class="msg"></div></div>
          <div class="field" data-f="minQty" style="flex:1"><label>حد الطلب <span class="hint">بالوحدة الصغيرة</span></label><input class="input num" name="minQty" value="${v.minQty ?? ''}" inputmode="numeric"><div class="msg"></div></div></div>
        <div class="row" style="gap:10px"><div class="field" data-f="saleUnit" style="flex:1"><label>وحدة البيع الافتراضية</label><select class="select" name="saleUnit">${unitOpts(v.saleUnit)}</select><div class="msg"></div></div>
          <div class="field" data-f="purchaseUnit" style="flex:1"><label>وحدة الشراء الافتراضية</label><select class="select" name="purchaseUnit">${unitOpts(v.purchaseUnit)}</select><div class="msg"></div></div></div>
        <div class="row" style="gap:10px"><div class="field" data-f="code" style="flex:1"><label>الكود <span class="hint">لو فاضي بيتعمل لوحده</span></label><input class="input num" name="code" value="${v.code}"><div class="msg"></div></div>
          <div class="field" style="flex:1"><label>الباركود</label><input class="input num" name="barcode" value="${v.barcode}"></div></div>
        ${x ? html`<label class="swl"><button type="button" class="switch" role="switch" data-act aria-checked="${v.active ? 'true' : 'false'}"></button><span>الصنف شغال (بيظهر في التذكرة)</span></label>` : ''}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    // أثناء كتابة الاسم: الأصناف الشبه بتظهر عشان ما يتكررش صنف
    const showDup = () => {
      const q = searchKey($('[name=name]', m.el).value);
      const box = $('#dupbox', m.el);
      if (q.length < 2) { box.innerHTML = ''; return; }
      const others = items.filter((x) => !(x.id === v.id) && searchKey(x.name).includes(q));
      const rank = (x) => (searchKey(x.name) === q ? 0 : searchKey(x.name).startsWith(q) ? 1 : searchKey(x.name).split(' ').some((w) => w.startsWith(q)) ? 2 : 3);
      others.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ar'));
      const exact = others.some((x) => rank(x) === 0);
      box.innerHTML = String(html`${exact ? html`<div class="alertbar danger" style="margin-top:6px">${icon('alert')}<span><b>الصنف ده موجود بنفس الاسم.</b> راجعه قبل ما تضيفه تاني.</span></div>` : ''}
        ${others.length ? html`<div class="dup-list"><div class="muted" style="font-size:12px;font-weight:700;margin:6px 0 4px">أصناف شبه اللي بتكتبه (${others.length}):</div>${others.slice(0, 6).map((x) => html`<div class="dup-row ${x.active ? '' : 'off-row'}"><b>${x.name}</b><span class="muted">${x.kind === 'drug' ? 'دواء' : 'مستلزم'} · ${x.unit || ''} · <span class="num">${x.code}</span>${x.active ? '' : ' · موقوف'}</span></div>`)}${others.length > 6 ? html`<div class="muted" style="font-size:12px">و${others.length - 6} كمان... كمّل كتابة للتضييق</div>` : ''}</div>` : ''}`);
    };
    $('[name=name]', m.el).addEventListener('input', showDup);
    showDup();
    let kind = v.kind;
    m.el.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-ek]');
      if (k) { kind = k.dataset.ek; $$('[data-ek]', m.el).forEach((b) => b.classList.toggle('on', b === k)); return; }
      const sw = e.target.closest('[data-act]');
      if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
      if (!e.target.closest('[data-ok]')) return;
      const g = (n) => $(`[name=${n}]`, m.el).value;
      const body = {
        kind, name: g('name'), unit: g('unit'), price: latinDigits(g('price')), code: g('code'), barcode: g('barcode'), active: x ? $('[data-act]', m.el).getAttribute('aria-checked') === 'true' : true,
        midUnit: g('midUnit'), midQty: latinDigits(g('midQty')), packUnit: g('packUnit'), packQty: latinDigits(g('packQty')), minQty: latinDigits(g('minQty')),
        saleUnit: g('saleUnit'), purchaseUnit: g('purchaseUnit'),
      };
      try {
        if (x) await api.put('/tickets/items/' + x.id, body); else await api.post('/tickets/items', body);
        m.close(); toast('اتحفظ الصنف'); load();
      } catch (er) {
        $$('.field', m.el).forEach((f) => { f.classList.remove('err'); const mm = $('.msg', f); if (mm) mm.textContent = ''; });
        if (er instanceof ApiError && er.data.errors) for (const [f, msg] of Object.entries(er.data.errors)) { const b = $(`[data-f="${f}"]`, m.el); if (b) { b.classList.add('err'); $('.msg', b).textContent = msg; } else toast(msg, 'err'); }
        else toastError(er);
      }
    });
  };
  // إدارة الوحدات: إضافة وحدة جديدة، وإيقاف/تشغيل (الأصناف بتختار منها بس)
  const unitsModal = () => {
    const draw = () => String(html`<div class="row" style="gap:8px;margin-bottom:12px"><input class="input" name="un" placeholder="وحدة جديدة (مثلًا: كرتونة)" maxlength="30" style="flex:1"><button class="btn" data-uadd>${icon('plus', 'sm')} ضيف</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${units.map((u) => html`<button class="chip ${u.active ? 'on' : ''}" data-ut="${u.id}" title="${u.active ? 'اضغط للإيقاف' : 'اضغط للتشغيل'}">${u.name}${u.active ? '' : ' (موقوفة)'}</button>`)}</div>
      <div class="muted" style="font-size:12.5px;margin-top:10px">الوحدة الموقوفة بتختفي من القوايم، والأصناف اللي بتستخدمها بتفضل زي ما هي.</div>`);
    const m = modal({ title: 'وحدات الأصناف', body: html`<div id="ub">${draw()}</div>`, foot: html`<button class="btn" data-close>تمام</button>` });
    const redraw = () => { $('#ub', m.el).innerHTML = draw(); };
    m.el.addEventListener('click', async (e) => {
      try {
        if (e.target.closest('[data-uadd]')) { const i = $('[name=un]', m.el); units = (await api.post('/tickets/units', { name: i.value })).units; redraw(); toast('اتضافت الوحدة'); return; }
        const t = e.target.closest('[data-ut]');
        if (t) { const u = units.find((x) => x.id === Number(t.dataset.ut)); units = (await api.put('/tickets/units/' + u.id, { active: !u.active })).units; redraw(); }
      } catch (er) { toastError(er); }
    });
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.name === 'un') { e.preventDefault(); $('[data-uadd]', m.el).click(); } });
  };
  const importFile = async (file) => {
    const send = (mode) => fetch('/api/tickets/items/import' + (mode ? '?mode=' + mode : ''), { method: 'POST', body: file, credentials: 'same-origin' }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new ApiError(r.status, j); return j; });
    try {
      const pv = await send();
      const c = pv.counts;
      const m = modal({
        title: 'استيراد الأصناف', wide: true,
        body: html`<div class="row wrap" style="gap:8px;margin-bottom:10px"><span class="badge ok">${c.new} جديد</span><span class="badge warn">${c.update} تعديل</span><span class="badge">${c.same} زي ما هو</span>${c.error ? html`<span class="badge danger">${c.error} فيه أخطاء</span>` : ''}</div>
          ${c.error ? html`<div class="alertbar danger" style="margin-bottom:10px">${icon('alert')}<span>صلّح الصفوف اللي فيها أخطاء في الملف وارفعه تاني.</span></div>` : ''}
          <div class="table-wrap" style="max-height:50vh"><table class="table"><thead><tr><th>صف</th><th>الصنف</th><th>النوع</th><th class="n">السعر</th><th>الحالة</th></tr></thead><tbody>
          ${pv.plan.map((x) => html`<tr><td class="num">${x.row}</td><td>${x.name}</td><td>${x.kind === 'drug' ? 'دواء' : x.kind === 'supply' ? 'مستلزم' : '—'}</td><td class="n num">${x.oldPrice != null && x.oldPrice !== x.price ? html`<s class="muted">${money(x.oldPrice)}</s> ` : ''}${money(x.price)}</td>
            <td>${x.status === 'error' ? html`<span class="badge danger">${x.errors.join('، ')}</span>` : x.status === 'new' ? html`<span class="badge ok">جديد</span>` : html`<span class="badge warn">تعديل</span>`}</td></tr>`)}</tbody></table></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok ${c.error || !(c.new + c.update) ? 'disabled' : ''}>${icon('check')} نفّذ</button>`,
      });
      $('[data-ok]', m.el).addEventListener('click', async () => {
        try { const r = await send('apply'); m.close(); toast(`اتضاف ${r.applied.created} واتعدل ${r.applied.updated}`); load(); } catch (er) { toastError(er); }
      });
    } catch (er) { toastError(er); }
  };
  pane.onclick = (e) => {
    const k = e.target.closest('[data-k]');
    if (k) { S.kind = k.dataset.k; $$('[data-k]', pane).forEach((b) => b.classList.toggle('on', b === k)); return draw(); }
    if (e.target.closest('[data-a="new"]')) return editModal(null);
    if (e.target.closest('[data-a="units"]')) return unitsModal();
    const ed = e.target.closest('[data-edit]');
    if (ed && edit) editModal(items.find((x) => x.id === Number(ed.dataset.edit)));
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'iq') { S.q = e.target.value; draw(); } }, 150);
  pane.onchange = (e) => { if (e.target.id === 'ifile' && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; } };
  await load();
  return () => { pane.onclick = pane.oninput = pane.onchange = null; };
}
