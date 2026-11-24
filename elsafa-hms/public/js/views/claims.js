// حسابات التعاقدات: الشهر لكل جهة ← مراجعة الحالات (حالة حالة) ← المطالبة (Cover + تفصيلي) ← الشيك والمرفوضات
import {
  api, html, icon, $, $$, money, egp, fmtWhen, fmtDate, modal, toast, toastError, askReason, can, debounce, AP_ST, openPrint, ApiError, initials,
} from '../core.js';
import { searchKey, latinDigits } from '/shared/text.js';

const CASE_ST = { pending: { name: 'مستنية', cls: '', ic: 'hourglass' }, ok: { name: 'تمام', cls: 'ok', ic: 'check' }, note: { name: 'فيها ملاحظة', cls: 'warn', ic: 'alert' } };
const CLAIM_ST = { draft: { name: 'مسودة', cls: '' }, sent: { name: 'اتبعتت', cls: 'py' }, partial: { name: 'اتدفع جزء', cls: 'warn' }, closed: { name: 'خلصت', cls: 'ok' } };
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const thisPeriod = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz }).slice(0, 7);
const shift = (p, n) => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const pName = (p) => { const [y, m] = p.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const dShort = (d) => (d ? `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}` : '—');
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } } };
const uploadCaseFile = async (caseId, file, label) => {
  if (!file) return null;
  if (file.size > 12 * 1024 * 1024) throw new ApiError(400, { error: 'الملف أكبر من 12 ميجا' });
  const r = await fetch(`/api/claims/cases/${caseId}/files?label=${encodeURIComponent(label || file.name.replace(/\.[^.]+$/, ''))}`, { method: 'POST', body: file, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j);
  return j;
};
const pickFile = () => new Promise((resolve) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,application/pdf'; i.onchange = () => resolve(i.files[0] || null); i.click(); });

// ========================= الشاشة الرئيسية =========================
export async function renderClaims(view, { query, setTitle }) {
  const tabs = [['month', 'الشهر', 'calendar'], ['claims', 'المطالبات', 'file'], ['rejections', 'المرفوضات', 'x']];
  const tab = tabs.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'month';
  setTitle('حسابات التعاقدات', { month: 'مراجعة الحالات والمطالبة', claims: 'المطالبات والشيكات', rejections: 'المرفوض والمخصوم' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">${tabs.map(([k, n, ic]) => html`<a href="#/claims?tab=${k}" class="stab ${tab === k ? 'on' : ''}">${icon(ic)}<span>${n}</span></a>`)}</nav><div id="cp"></div>`);
  const pane = $('#cp', view);
  if (tab === 'claims') return claimsList(pane);
  if (tab === 'rejections') return rejections(pane);
  return monthPane(pane, query);
}

async function monthPane(pane, query) {
  const S = { period: query.get('period') || store.get('clPeriod') || thisPeriod() };
  const draw = (d) => {
    const all = d.payers.reduce((a, p) => ({ cases: a.cases + p.cases, ok: a.ok + p.ok, note: a.note + p.note, amount: a.amount + p.amount }), { cases: 0, ok: 0, note: 0, amount: 0 });
    pane.innerHTML = String(html`<div class="cl-month card">
        <button class="btn ghost icon" data-m="-1" aria-label="الشهر اللي فات">${icon('chev-right')}</button>
        <div class="cl-mname"><b>${d.periodName}</b><small>${S.period === thisPeriod() ? 'الشهر الحالي' : ''}</small></div>
        <button class="btn ghost icon" data-m="1" aria-label="الشهر الجاي" ${S.period >= thisPeriod() ? 'disabled' : ''}>${icon('chev-left')}</button>
        <span class="spacer"></span>
        ${d.notes ? html`<span class="badge warn">${icon('alert', 'sm')} ${d.notes} حالة راجعة للاستقبال</span>` : ''}
      </div>
      <div class="acc-kpis cl-kpis">
        <div class="akpi"><span class="gi">${icon('users')}</span><div><small>حالات الشهر</small><b class="num">${all.cases}</b></div></div>
        <div class="akpi ok"><span class="gi">${icon('check')}</span><div><small>اتراجعت</small><b class="num">${all.ok}</b></div></div>
        <div class="akpi warn"><span class="gi">${icon('alert')}</span><div><small>فيها ملاحظات</small><b class="num">${all.note}</b></div></div>
        <div class="akpi late"><span class="gi">${icon('wallet')}</span><div><small>على الجهات</small><b class="num">${money(all.amount)} ${HMS.money.symbol}</b></div></div></div>
      ${!d.payers.length ? html`<div class="card empty"><div class="art">${icon('shield')}</div><b>مفيش حالات تعاقد في ${d.periodName}</b>الحالات بتظهر هنا لوحدها أول ما الزيارة تتدفع أو المريض يخرج</div>`
        : html`<div class="cl-grid">${d.payers.map((p) => {
          const done = p.cases ? Math.round((p.ok / p.cases) * 100) : 0, nt = p.cases ? (p.note / p.cases) * 100 : 0;
          const last = p.claims.at(-1);
          return html`<div class="card cl-payer">
            <div class="cl-ph"><span class="cl-av">${initials(p.payer.name)}</span><div style="min-width:0"><b>${p.payer.name}</b><small>${p.visits ? `${p.visits} خارجي` : ''}${p.visits && p.admissions ? ' · ' : ''}${p.admissions ? `${p.admissions} داخلي` : ''}</small></div>
              ${last ? html`<span class="badge ${CLAIM_ST[last.status].cls}" style="margin-inline-start:auto">مطالبة ${last.no} · ${CLAIM_ST[last.status].name}</span>` : ''}</div>
            <div class="cl-amt"><b class="num">${money(p.amount)}</b> ${HMS.money.symbol} <small>على الجهة</small>${p.outstanding !== p.amount ? html`<small class="muted"> · لسه ما اتطالبش بـ <span class="num">${money(p.outstanding)}</span></small>` : ''}</div>
            <div class="cl-prog"><i class="ok" style="width:${done}%"></i><i class="nt" style="width:${nt}%"></i></div>
            <div class="cl-pf"><small><b class="num">${p.ok}</b> من <b class="num">${p.cases}</b> اتراجعت${p.note ? html` · <span style="color:var(--warn)">${p.note} ملاحظة</span>` : ''}</small>
              <span class="spacer"></span>
              ${p.claims.map((c) => html`<a class="btn ghost sm" href="#/claim/${c.id}">${icon('file', 'sm')} ${c.no}</a>`)}
              <a class="btn sm" href="#/claims/review?payer=${p.payer.id}&period=${S.period}">${icon('clipboard', 'sm')} ${p.pending || p.note ? 'راجع' : 'افتح'}</a></div>
          </div>`; })}</div>`}`);
  };
  const load = async () => { draw(await api.get('/claims/overview?period=' + S.period)); };
  pane.onclick = (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { S.period = shift(S.period, Number(m.dataset.m)); store.set('clPeriod', S.period); return load(); }
  };
  await load();
  return () => { pane.onclick = null; };
}

async function claimsList(pane) {
  const S = { f: 'all' };
  const draw = (d) => {
    const list = d.claims.filter((c) => S.f === 'all' || (S.f === 'open' ? ['sent', 'partial'].includes(c.status) : c.status === S.f));
    const left = d.claims.filter((c) => ['sent', 'partial'].includes(c.status)).reduce((s, c) => s + c.left, 0);
    pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px">
        <div class="chips">${[['all', 'الكل'], ['draft', 'مسودات'], ['open', 'مستنية شيك'], ['closed', 'خلصت']].map(([k, n]) => html`<button class="chip ${S.f === k ? 'on' : ''}" data-f="${k}">${n}</button>`)}</div>
        <span class="spacer"></span><span class="badge py">لسه على الشركات <b class="num">${money(left)}</b> ${HMS.money.symbol}</span></div>
      ${!list.length ? html`<div class="card empty"><div class="art">${icon('file')}</div><b>مفيش مطالبات</b>المطالبة بتتعمل من «الشهر» ← الجهة ← «اعمل المطالبة»</div>`
        : html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>الجهة</th><th>الشهر</th><th>الإصدار</th><th>الحالة</th><th class="n">المطالبة</th><th class="n">اتدفع</th><th class="n">مرفوض</th><th class="n">الباقي</th></tr></thead><tbody>
        ${list.map((c) => html`<tr class="click" data-c="${c.id}"><td class="num"><b>${c.no}</b></td><td><b>${c.payer}</b></td><td>${c.periodName}</td><td class="num">${c.issueDate ? c.issueDate.split('-').reverse().join('/') : '—'}</td>
          <td><span class="badge ${CLAIM_ST[c.status].cls}">${CLAIM_ST[c.status].name}</span></td><td class="n num"><b>${money(c.total)}</b></td><td class="n num" style="color:var(--ok)">${c.paid ? money(c.paid) : '—'}</td>
          <td class="n num" style="color:var(--danger)">${c.rejected ? money(c.rejected) : '—'}</td><td class="n num">${c.status === 'draft' ? '—' : money(c.left)}</td></tr>`)}</tbody></table></div></div>`}`);
  };
  let d;
  pane.onclick = (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { S.f = f.dataset.f; return draw(d); }
    const c = e.target.closest('[data-c]');
    if (c) window.go('/claim/' + c.dataset.c);
  };
  d = await api.get('/claims/list');
  draw(d);
  return () => { pane.onclick = null; };
}

async function rejections(pane) {
  const y = thisPeriod().slice(0, 4);
  const S = { from: y + '-01', to: thisPeriod() };
  const draw = (d) => {
    const mx = Math.max(...d.byPayer.map((x) => x.amount), 0);
    pane.innerHTML = String(html`<div class="card rep-ctl"><div class="field"><label>من شهر</label><input class="input" type="month" id="rf" value="${S.from}"></div><div class="field"><label>لـ</label><input class="input" type="month" id="rt" value="${S.to}"></div></div>
      <div class="acc-kpis cl-kpis"><div class="akpi danger"><span class="gi">${icon('x')}</span><div><small>المرفوض والمخصوم (على المستشفى)</small><b class="num">${money(d.total)} ${HMS.money.symbol}</b></div></div>
        ${d.byKind.map((k) => html`<div class="akpi"><span class="gi">${icon(k.name === 'داخلي' ? 'bed' : 'users')}</span><div><small>${k.name}</small><b class="num">${money(k.amount)} ${HMS.money.symbol}</b></div></div>`)}</div>
      <div class="rep-grid"><div class="card rep-card"><h4 class="subh">${icon('shield', 'sm')} بالجهة</h4><table class="table"><tbody>${d.byPayer.map((x) => html`<tr><td><b>${x.name}</b></td><td style="width:40%"><span class="rbar"><i style="width:${mx ? Math.max(3, (x.amount / mx) * 100) : 0}%;background:var(--danger)"></i></span></td><td class="n num"><b>${money(x.amount)}</b></td></tr>`)}</tbody></table></div>
        <div class="card rep-card"><h4 class="subh">${icon('info', 'sm')} بالسبب</h4><table class="table"><tbody>${d.byReason.map((x) => html`<tr><td>${x.name}</td><td class="n num"><b>${money(x.amount)}</b></td></tr>`)}</tbody></table></div></div>
      <div class="card rep-card" style="margin-top:12px"><div class="table-wrap"><table class="table"><thead><tr><th>مطالبة</th><th>الجهة</th><th>المريض</th><th>الخدمة</th><th class="n">مطلوب</th><th class="n">مرفوض</th><th>السبب</th></tr></thead><tbody>
        ${d.lines.map((l) => html`<tr><td class="num">${l.claimNo}</td><td>${l.payer}</td><td>${l.patient}</td><td>${l.text} <small class="muted num">${dShort(l.date)}</small></td><td class="n num">${money(l.amount)}</td><td class="n num" style="color:var(--danger)"><b>${money(l.rejected)}</b></td><td>${l.reason || ''}</td></tr>`)}
        ${!d.lines.length ? html`<tr><td colspan="7"><div class="empty" style="padding:16px"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش مرفوضات</b></div></td></tr>` : ''}</tbody></table></div></div>`);
  };
  const load = async () => draw(await api.get(`/claims/reports/rejections?from=${S.from}&to=${S.to}`));
  pane.onchange = (e) => { if (e.target.id === 'rf') S.from = e.target.value; if (e.target.id === 'rt') S.to = e.target.value; load(); };
  await load();
  return () => { pane.onchange = null; };
}

// ========================= المراجعة =========================
export async function renderClaimReview(view, { query, setTitle }) {
  const payerId = Number(query.get('payer'));
  const period = /^\d{4}-\d{2}$/.test(query.get('period') || '') ? query.get('period') : thisPeriod();
  const S = { d: null, sel: Number(query.get('case')) || null, c: null, f: 'todo', q: '', busy: false };
  view.innerHTML = String(html`<div class="skel" style="height:420px"></div>`);
  const loadList = async () => { S.d = await api.get(`/claims/cases?payerId=${payerId}&period=${period}`); };
  await loadList();
  setTitle('مراجعة ' + S.d.payer.name, S.d.periodName);
  const canRev = can('claims.review'), canMan = can('claims.manage');
  view.innerHTML = String(html`<div class="cr-top card" id="crt"></div><div class="cr-grid"><aside class="card cr-list"><div class="cr-lh">
      <div class="big-search">${icon('search')}<input class="input" id="crq" type="search" placeholder="اسم المريض أو الكارنيه" autocomplete="off"></div>
      <div class="chips" id="crf"></div></div><div id="crl" class="cr-items"></div></aside><section class="card cr-detail" id="crd"></section></div>`);
  const list = () => {
    const q = searchKey(S.q);
    return S.d.cases.filter((c) => (S.f === 'all' || (S.f === 'todo' ? c.status !== 'ok' : S.f === 'visit' || S.f === 'admission' ? c.kind === S.f : c.status === S.f))
      && (!q || searchKey(`${c.patient.name} ${c.cardNo || ''} ${c.patient.no}`).includes(q)));
  };
  const drawTop = () => {
    const cs = S.d.cases, ok = cs.filter((c) => c.status === 'ok').length, nt = cs.filter((c) => c.status === 'note').length;
    const amt = cs.reduce((s, c) => s + c.amount, 0), out = cs.filter((c) => c.status === 'ok').reduce((s, c) => s + c.outstanding, 0);
    $('#crt', view).innerHTML = String(html`<a class="back-link" href="#/claims?period=${period}" style="margin:0">${icon('chev-right', 'sm')} الشهر</a>
      <div class="cr-title"><span class="cl-av">${initials(S.d.payer.name)}</span><div><b>${S.d.payer.name}</b><small>${S.d.periodName} · ${cs.length} حالة · على الجهة <span class="num">${money(amt)}</span> ${HMS.money.symbol}</small></div></div>
      <div class="cr-prog"><div class="cl-prog"><i class="ok" style="width:${cs.length ? (ok / cs.length) * 100 : 0}%"></i><i class="nt" style="width:${cs.length ? (nt / cs.length) * 100 : 0}%"></i></div><small><b class="num">${ok}</b> من <b class="num">${cs.length}</b> اتراجعت${nt ? ` · ${nt} ملاحظة` : ''}</small></div>
      <span class="spacer"></span>
      ${canMan ? (S.d.draft ? html`<a class="btn" href="#/claim/${S.d.draft.id}">${icon('file')} المسودة رقم ${S.d.draft.no}</a>` : html`<button class="btn" id="mkc" ${ok ? '' : 'disabled'} title="${ok ? '' : 'علّم الحالات «تمام» الأول'}">${icon('file')} اعمل المطالبة <small class="num" style="opacity:.8">${money(out)}</small></button>`) : ''}`);
    const n = (f) => S.d.cases.filter((c) => (f === 'all' ? true : f === 'todo' ? c.status !== 'ok' : f === 'visit' || f === 'admission' ? c.kind === f : c.status === f)).length;
    $('#crf', view).innerHTML = String(html`${[['todo', 'لسه'], ['note', 'ملاحظات'], ['ok', 'تمام'], ['all', 'الكل'], ['visit', 'خارجي'], ['admission', 'داخلي']].map(([k, nm]) => html`<button class="chip ${S.f === k ? 'on' : ''}" data-f="${k}">${nm} <span class="num">${n(k)}</span></button>`)}`);
  };
  const drawList = () => {
    const xs = list();
    $('#crl', view).innerHTML = !xs.length ? String(html`<div class="empty" style="padding:24px 10px"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${S.f === 'todo' ? 'كل الحالات اتراجعت' : 'مفيش حالات هنا'}</b></div>`)
      : String(html`${xs.map((c) => html`<button class="cr-item st-${c.status} ${S.sel === c.id ? 'on' : ''}" data-case="${c.id}">
        <span class="cr-ic">${icon(CASE_ST[c.status].ic, 'sm')}</span>
        <div class="cr-in"><b>${c.patient.name}</b><small><span class="kpill k-${c.kind}">${c.kind === 'visit' ? 'خارجي' : 'داخلي'}</span> ${c.ref.typeName} · ${dShort((c.ref.out || c.ref.date || '').slice(0, 10))}${c.deferred ? html` · <span style="color:var(--py)">مؤجلة</span>` : ''}${c.period < period ? html` · <span style="color:var(--py)">من ${pName(c.period).split(' ')[0]}</span>` : ''}${c.afterClaim ? html` · <span style="color:var(--py)">فرق بعد المطالبة</span>` : ''}</small>
          ${c.flags.length ? html`<small class="cr-flags">${c.flags.join(' · ')}</small>` : ''}</div>
        <b class="num cr-amt">${money(c.afterClaim ? c.outstanding : c.amount)}</b></button>`)}`);
  };
  const tdRow = (label, valueHtml) => html`<div class="cr-kv"><span>${label}</span>${valueHtml}</div>`;
  const drawDetail = () => {
    const box = $('#crd', view);
    if (!S.c) { box.innerHTML = String(html`<div class="empty" style="padding:60px 10px"><div class="art">${icon('clipboard')}</div><b>اختار حالة من القايمة</b>Enter = تمام والحالة اللي بعدها · ↑↓ للتنقل</div>`); return; }
    const { case: c, items, approvals, files, adjustments, claims } = S.c;
    const ed = canRev;
    const tot = items.reduce((a, i) => ({ gross: a.gross + i.gross, payer: a.payer + i.payer, patient: a.patient + i.patient }), { gross: 0, payer: 0, patient: 0 });
    box.innerHTML = String(html`<div class="cr-dh">
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><h3 style="margin:0">${c.patient.name}</h3><span class="badge ${CASE_ST[c.status].cls}">${CASE_ST[c.status].name}</span>
          ${c.deferred ? html`<span class="badge py">مؤجلة من ${pName(c.basePeriod)}</span>` : ''}</div>
          <small class="muted">ملف <span class="num">${c.patient.no}</span> · ${c.kind === 'visit' ? html`زيارة ${c.ref.typeName} <a href="#/visit/${c.ref.id}" class="num">${c.ref.no}</a> · ${fmtWhen(c.ref.date)}` : html`${c.ref.typeName} · دخول <a href="#/admission/${c.ref.id}" class="num">${c.ref.no}</a> · من ${fmtDate(c.ref.date)} لـ ${fmtDate(c.ref.out)}`}</small></div>
        <div class="cr-acts">
          ${ed && c.status !== 'ok' ? html`<button class="btn" data-a="ok" style="--c:var(--ok)">${icon('check')} تمام <kbd>Enter</kbd></button>` : ''}
          ${ed && c.status === 'ok' ? html`<button class="btn ghost" data-a="pending">${icon('undo')} رجّعها للمراجعة</button>` : ''}
          ${ed ? html`<button class="btn soft" data-a="note" style="--c:var(--warn)">${icon('alert')} ملاحظة</button>` : ''}
          ${ed ? html`<button class="btn ghost" data-a="defer" title="${c.deferred ? 'رجّعها لشهرها' : 'تتأجل للشهر الجاي'}">${icon('calendar')} ${c.deferred ? 'رجّعها' : 'أجّل'}</button>` : ''}
        </div></div>
      ${c.status === 'note' ? html`<div class="alertbar warn" style="margin:10px 0 0">${icon('alert')}<span><b>${c.note}</b><br><small>${c.noteBy || ''} · ${fmtWhen(c.noteAt)} · راجعة للاستقبال</small></span></div>` : ''}
      ${c.fixedAt && c.status === 'pending' ? html`<div class="alertbar info" style="margin:10px 0 0">${icon('check')}<span>الاستقبال صلّح الملاحظة ${fmtWhen(c.fixedAt)}${c.note ? ` («${c.note}»)` : ''}</span></div>` : ''}
      <div class="cr-fields">
        <div class="field"><label>رقم الكارنيه</label><input class="input num ${c.cardNo ? '' : 'miss'}" data-fld="cardNo" value="${c.cardNo || ''}" ${ed ? '' : 'disabled'}></div>
        <div class="field" style="flex:2 1 260px"><label>التشخيص</label><input class="input ${c.diagnosis ? '' : 'miss'}" data-fld="diagnosis" value="${c.diagnosis || ''}" ${ed ? '' : 'disabled'} placeholder="الاستقبال بيكتبه وقت التسجيل"></div>
        ${tdRow('الدرجة', html`<b>${c.tier || '—'}</b>`)}
      </div>
      ${approvals.length ? html`<h4 class="subh">${icon('shield', 'sm')} الموافقات</h4><div class="cr-aps">${approvals.map((a) => html`<div class="cr-ap">
          <div style="min-width:0;flex:1"><b>${a.item}</b> <span class="badge ${AP_ST[a.status]?.cls || ''}">${AP_ST[a.status]?.name || a.status}</span></div>
          <input class="input num" data-ap="${a.id}" data-k="no" value="${a.no || ''}" placeholder="رقم الموافقة" ${ed ? '' : 'disabled'} style="width:150px">
          <input class="input" type="date" data-ap="${a.id}" data-k="date" value="${a.date || ''}" ${ed ? '' : 'disabled'} style="width:150px">
          ${a.hasImage ? html`<a class="btn ghost sm" href="/api/approvals/${a.id}/image" target="_blank">${icon('eye', 'sm')} الصورة</a>` : ed ? html`<button class="btn ghost sm" data-apimg="${a.id}">${icon('upload', 'sm')} صورة</button>` : html`<span class="muted">مفيش صورة</span>`}</div>`)}</div>` : ''}
      <h4 class="subh">${icon('list', 'sm')} البنود <small class="muted">على الجهة <b class="num">${money(tot.payer)}</b> من <span class="num">${money(tot.gross)}</span></small></h4>
      <div class="table-wrap"><table class="table cr-items-t"><thead><tr><th>التاريخ</th><th>الخدمة</th><th class="n">العدد</th><th class="n">القيمة</th><th class="n">المريض</th><th class="n">على الجهة</th>${ed ? html`<th></th>` : ''}</tr></thead><tbody>
        ${items.map((i) => html`<tr class="${i.status === 'voided' ? 'off-row' : ''}"><td class="num">${dShort(i.date)}</td><td>${i.name}${i.claimed && i.outstanding ? html` <span class="badge py" style="height:18px;font-size:10.5px">فرق <span class="num">${money(i.outstanding)}</span></span>` : ''}</td>
          <td class="n num">${i.qty}</td><td class="n num">${money(i.gross)}</td><td class="n num muted">${money(i.patient)}</td><td class="n num"><b>${money(i.payer)}</b></td>
          ${ed ? html`<td class="n"><button class="btn ghost icon sm" data-adj="${i.id}" title="تسوية نصيب الشركة">${icon('edit', 'sm')}</button></td>` : ''}</tr>`)}
        <tr class="sub"><td colspan="3">الإجمالي</td><td class="n num">${money(tot.gross)}</td><td class="n num">${money(tot.patient)}</td><td class="n num"><b>${money(tot.payer)}</b></td>${ed ? html`<td></td>` : ''}</tr></tbody></table></div>
      ${adjustments.length ? html`<div class="cr-adj">${adjustments.map((a) => html`<div>${icon('edit', 'sm')} <span>${a.text}</span> <b class="num" style="color:${a.amount < 0 ? 'var(--danger)' : 'var(--ok)'}">${a.amount > 0 ? '+' : ''}${money(a.amount)}</b> <small class="muted">${a.by} · ${fmtWhen(a.at)}</small></div>`)}</div>` : ''}
      <h4 class="subh">${icon('folder', 'sm')} المستندات ${ed ? html`<button class="btn ghost sm" data-a="file" style="margin-inline-start:auto">${icon('upload', 'sm')} ارفع مستند</button>` : ''}</h4>
      <div class="cr-files">${files.map((f) => html`<a class="cr-file" href="/api/claims/files/${f.id}" target="_blank">${icon(f.ext === 'pdf' ? 'file' : 'eye', 'sm')}<b>${f.label}</b><small>${f.by}</small></a>`)}${!files.length ? html`<span class="muted" style="font-weight:600">مفيش مستندات مرفوعة</span>` : ''}</div>
      ${claims.length ? html`<div class="muted" style="margin-top:10px;font-weight:600">${icon('file', 'sm')} في المطالبات: ${claims.map((x) => html`<a href="#/claim/${x.id}">رقم ${x.no} (${x.statusName}) <span class="num">${money(x.amount)}</span></a> `)}</div>` : ''}`);
  };
  const openCase = async (id) => {
    S.sel = id; drawList();
    $('#crd', view).classList.add('loading');
    try { S.c = await api.get('/claims/cases/' + id); drawDetail(); history.replaceState(null, '', `#/claims/review?payer=${payerId}&period=${period}&case=${id}`); } catch (e) { toastError(e); }
    $('#crd', view).classList.remove('loading');
  };
  const applyCase = (d) => {
    S.c = d;
    const i = S.d.cases.findIndex((c) => c.id === d.case.id);
    if (i >= 0) S.d.cases[i] = d.case;
    drawTop(); drawList(); drawDetail();
  };
  const next = () => { const xs = list(); const i = xs.findIndex((c) => c.id === S.sel); const n = xs[i + 1] || xs[i - 1] || xs.find((c) => c.id !== S.sel); if (n) openCase(n.id); else { S.c = null; S.sel = null; drawList(); drawDetail(); } };
  const act = async (a) => {
    const id = S.sel;
    if (!id || S.busy) return;
    S.busy = true;
    try {
      if (a === 'ok') { const d = await api.post(`/claims/cases/${id}/status`, { status: 'ok' }); applyCase(d); toast(`«${d.case.patient.name}» تمام`); if (S.f === 'todo' || S.f === 'note') next(); }
      if (a === 'pending') applyCase(await api.post(`/claims/cases/${id}/status`, { status: 'pending' }));
      if (a === 'defer') { const d = await api.post(`/claims/cases/${id}/defer`, S.c.case.deferred ? { undo: true } : {}); toast(d.case.deferred ? `اتأجلت لـ ${pName(d.case.period)}` : 'رجعت لشهرها', 'info'); await loadList(); drawTop(); drawList(); if (d.case.period === period) applyCase(d); else next(); }
      if (a === 'note') {
        const m = modal({
          title: 'ملاحظة على الحالة',
          body: html`<div class="chips" style="margin-bottom:8px">${['صورة الكارنيه ناقصة', 'التشخيص ناقص', 'رقم الموافقة ناقص', 'الروشتة أو التقرير ناقص', 'توقيع المريض ناقص'].map((x) => html`<button type="button" class="chip" data-t="${x}">${x}</button>`)}</div>
            <div class="field"><label>الملاحظة <span class="hint">بتروح للاستقبال يصلّحها، والحالة مش هتدخل المطالبة لحد ما تتصلح</span></label><textarea class="input" name="n" rows="3" style="height:auto">${S.c.case.note || ''}</textarea></div>`,
          foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:var(--warn)">${icon('send')} ابعتها للاستقبال</button>`,
        });
        m.el.addEventListener('click', async (e) => {
          const t = e.target.closest('[data-t]');
          if (t) { const ta = $('[name=n]', m.el); ta.value = ta.value ? ta.value + '، ' + t.dataset.t : t.dataset.t; return; }
          if (!e.target.closest('[data-ok]')) return;
          try { applyCase(await api.post(`/claims/cases/${id}/status`, { status: 'note', note: $('[name=n]', m.el).value })); m.close(); toast('الملاحظة راحت للاستقبال'); window.refreshShell?.(); } catch (er) { toastError(er); }
        });
      }
      if (a === 'file') {
        const f = await pickFile();
        if (f) { applyCase(await uploadCaseFile(id, f)); toast('اترفع المستند'); }
      }
    } catch (er) { toastError(er); } finally { S.busy = false; }
  };
  view.onclick = async (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { S.f = f.dataset.f; drawTop(); drawList(); return; }
    const cs = e.target.closest('[data-case]');
    if (cs) return openCase(Number(cs.dataset.case));
    const a = e.target.closest('[data-a]');
    if (a) return act(a.dataset.a);
    const ai = e.target.closest('[data-apimg]');
    if (ai) {
      const fl = await pickFile();
      if (!fl) return;
      try { const r = await fetch(`/api/approvals/${ai.dataset.apimg}/image`, { method: 'POST', body: fl, credentials: 'same-origin' }); if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({}))); applyCase(await api.get('/claims/cases/' + S.sel)); toast('اترفعت صورة الموافقة'); } catch (er) { toastError(er); }
      return;
    }
    const adj = e.target.closest('[data-adj]');
    if (adj) {
      const it = S.c.items.find((x) => x.id === Number(adj.dataset.adj));
      const m = modal({
        title: `تسوية «${it.name}»`,
        body: html`<div class="kv-mini"><span>قيمة البند <b class="num">${money(it.gross)}</b></span><span>على المريض <b class="num">${money(it.patient)}</b></span><span>على الجهة دلوقتي <b class="num">${money(it.payer)}</b></span></div>
          <div class="field" style="margin-top:12px"><label>المبلغ الصح على الجهة</label><input class="input num" name="a" value="${it.payer}" style="font-size:22px;height:54px;font-weight:800;text-align:center" autofocus></div>
          <div class="field" style="margin-top:10px"><label>السبب <span class="req">*</span></label><input class="input" name="r" placeholder="مثلًا: سعر التعاقد غير كده"></div>
          <div class="alertbar info" style="margin-top:10px">${icon('info')}<span>إيصال المريض مش بيتغير. الفرق على المستشفى (أو ليها). لو الغلطة في نصيب المريض، اعمل «ملاحظة» للاستقبال.</span></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} سجّل التسوية</button>`,
      });
      setTimeout(() => $('[name=a]', m.el)?.select(), 40);
      $('[data-ok]', m.el).addEventListener('click', async () => {
        try { applyCase(await api.post(`/claims/cases/${S.sel}/adjust`, { itemId: it.id, amount: latinDigits($('[name=a]', m.el).value), reason: $('[name=r]', m.el).value })); m.close(); toast('اتسجلت التسوية'); } catch (er) { toastError(er); }
      });
      return;
    }
    if (e.target.closest('#mkc')) {
      try { const d = await api.post('/claims', { payerId, period }); toast(`اتعملت المطالبة رقم ${d.claim.no}`); window.go('/claim/' + d.claim.id); } catch (er) { toastError(er); }
    }
  };
  view.onchange = async (e) => {
    const t = e.target;
    try {
      if (t.dataset.fld) { applyCase(await api.put('/claims/cases/' + S.sel, { [t.dataset.fld]: t.value })); toast('اتحفظ'); }
      if (t.dataset.ap) {
        const row = t.closest('.cr-ap');
        applyCase(await api.put(`/claims/cases/${S.sel}/approvals/${t.dataset.ap}`, { no: $('[data-k=no]', row).value, date: $('[data-k=date]', row).value || null }));
        toast('اتحفظ');
      }
    } catch (er) { toastError(er); }
  };
  view.oninput = debounce((e) => { if (e.target.id === 'crq') { S.q = e.target.value; drawList(); } }, 150);
  const onKey = (e) => {
    if (document.querySelector('.overlay')) return;
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { if (e.key === 'Enter' && tag === 'INPUT' && e.target.dataset.fld) e.target.blur(); return; }
    if (e.key === 'Enter' && S.sel && canRev && S.c?.case.status !== 'ok') { e.preventDefault(); act('ok'); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const xs = list(); const i = xs.findIndex((c) => c.id === S.sel);
      const n = xs[Math.max(0, Math.min(xs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { openCase(n.id); $(`[data-case="${n.id}"]`, view)?.scrollIntoView({ block: 'nearest' }); }
    }
  };
  document.addEventListener('keydown', onKey);
  drawTop();
  if (!list().length && S.f === 'todo') S.f = 'all';
  drawTop(); drawList(); drawDetail();
  const first = S.sel && S.d.cases.some((c) => c.id === S.sel) ? S.sel : list()[0]?.id;
  if (first && window.innerWidth > 900) openCase(first);
  return () => { document.removeEventListener('keydown', onKey); view.onclick = view.onchange = view.oninput = null; };
}

// ========================= المطالبة =========================
export async function renderClaim(view, { params, setTitle }) {
  const id = Number(params[0]);
  let d = await api.get('/claims/' + id);
  const canMan = can('claims.manage');
  const S = { open: new Set() };
  const draw = () => {
    const c = d.claim, T = d.totals, draft = c.status === 'draft';
    setTitle(`مطالبة ${c.no}${c.supplement ? ' (تكميلية)' : ''}`, `${c.payer.name} · ${c.periodName}`);
    view.innerHTML = String(html`<a class="back-link" href="#/claims/review?payer=${c.payer.id}&period=${c.period}">${icon('chev-right', 'sm')} مراجعة ${c.payer.name}</a>
      <div class="card cm-head">
        <div class="cm-no"><small>مطالبة</small><b class="num">${c.no}</b></div>
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><h2 style="margin:0">${c.payer.name}</h2><span class="badge ${CLAIM_ST[c.status].cls}">${CLAIM_ST[c.status].name}</span>${c.supplement ? html`<span class="badge py">تكميلية</span>` : ''}</div>
          <small class="muted">عن ${c.periodName}${c.issueDate ? ` · اتصدرت ${c.issueDate.split('-').reverse().join('/')}` : ''} · عملها ${c.createdBy}${c.sentBy ? ` · بعتها ${c.sentBy}` : ''}</small></div>
        <span class="spacer"></span>
        <div class="row wrap" style="gap:6px">
          <button class="btn ghost" data-a="print">${icon('print')} اطبع</button>
          <a class="btn ghost" href="/api/claims/${id}?format=xlsx">${icon('sheet')} إكسل</a>
          ${draft && canMan ? html`<button class="btn ghost" data-a="del" style="--c:var(--danger)">${icon('trash')} امسح المسودة</button><button class="btn" data-a="send">${icon('send')} اتبعتت للشركة</button>` : ''}
          ${!draft && can('settings.manage') && !T.paid && !T.rejected ? html`<button class="btn ghost" data-a="reopen">${icon('undo')} افتحها</button>` : ''}
          ${!draft && canMan && c.status !== 'closed' ? html`<button class="btn" data-a="pay" style="--c:var(--ok)">${icon('cash')} سجّل شيك</button>` : ''}
        </div></div>
      ${draft ? html`<div class="alertbar info" style="margin:0 0 10px">${icon('info')}<span>المسودة بتتحدث لوحدها مع أي مراجعة أو تسوية. لما تتبعت للشركة بتتقفل، وأي فرق بعدها بيروح للمطالبة اللي بعدها.</span></div>` : ''}
      ${d.pending.length ? html`<div class="alertbar warn" style="margin:0 0 10px">${icon('alert')}<span>${d.pending.length} حالة لسه ما اتراجعتش ومش داخلة المطالبة (<span class="num">${money(d.pending.reduce((s, x) => s + x.outstanding, 0))}</span> ${HMS.money.symbol})</span><span class="spacer"></span><a class="btn sm" href="#/claims/review?payer=${c.payer.id}&period=${c.period}">راجعها</a></div>` : ''}
      <div class="cm-cover card">
        <div class="cm-cv"><small>الخارجي</small><b class="num">${money(T.visitsAmount)}</b><span>${T.visits} حالة</span></div>
        <div class="cm-cv"><small>الداخلي</small><b class="num">${money(T.admissionsAmount)}</b><span>${T.admissions} حالة</span></div>
        <div class="cm-cv tot"><small>إجمالي المطالبة</small><b class="num">${money(T.total)} ${HMS.money.symbol}</b><span>${T.words}</span></div>
        ${!draft ? html`<div class="cm-cv ok"><small>اتدفع</small><b class="num">${money(T.paid)}</b></div><div class="cm-cv bad"><small>مرفوض / مخصوم</small><b class="num">${money(T.rejected)}</b></div><div class="cm-cv left"><small>الباقي</small><b class="num">${money(T.left)}</b></div>` : ''}
      </div>
      ${draft && canMan ? html`<div class="field" style="margin:10px 0"><label>ملاحظات على الـ Cover <span class="hint">اختياري</span></label><input class="input" id="cnote" value="${c.note || ''}" placeholder="مثلًا: مرفق صور الموافقات"></div>` : ''}
      ${d.payments.length ? html`<h4 class="subh">${icon('cash', 'sm')} الشيكات</h4><div class="cm-pays">${d.payments.map((p) => html`<div class="cm-pay"><span class="gi">${icon('cash', 'sm')}</span><div><b>شيك <span class="num">${p.chequeNo}</span>${p.bank ? ` · ${p.bank}` : ''}</b><small>${p.date ? p.date.split('-').reverse().join('/') : ''} · ${p.by}${p.note ? ' · ' + p.note : ''}</small></div><b class="num" style="margin-inline-start:auto;color:var(--ok)">${money(p.amount)} ${HMS.money.symbol}</b>
        ${can('settings.manage') ? html`<button class="btn ghost icon sm" data-dpay="${p.id}" title="امسح الشيك">${icon('x', 'sm')}</button>` : ''}</div>`)}</div>` : ''}
      <h4 class="subh">${icon('list', 'sm')} التفصيلي <small class="muted">${d.cases.length} حالة</small>${!draft && canMan ? html`<small class="muted" style="margin-inline-start:auto">اكتب المرفوض قدام البند والسبب، وبيتحفظ لوحده</small>` : ''}</h4>
      <div class="cm-cases">${d.cases.map((x, i) => {
        const open = S.open.has(x.id) || (!draft && x.rejected > 0);
        return html`<div class="card cm-case ${open ? 'open' : ''}">
          <button class="cm-ch" data-tog="${x.id}"><span class="cm-n num">${i + 1}</span><div style="min-width:0;flex:1"><b>${x.patient.name}</b>
            <small><span class="kpill k-${x.kind}">${x.kind === 'visit' ? 'خارجي' : 'داخلي'}</span> ${x.ref.typeName} · كارنيه <span class="num">${x.cardNo || '—'}</span> · ${x.diagnosis || html`<span style="color:var(--danger)">من غير تشخيص</span>`}</small></div>
            ${x.rejected ? html`<span class="badge danger num">مرفوض ${money(x.rejected)}</span>` : ''}<b class="num">${money(x.total)}</b>${icon('chev-left', 'sm cmchev')}</button>
          ${open ? html`<div class="table-wrap"><table class="table"><thead><tr><th>التاريخ</th><th>الخدمة</th><th class="n">العدد</th><th class="n">القيمة</th><th class="n">على الجهة</th>${!draft ? html`<th class="n" style="width:110px">مرفوض</th><th style="width:30%">السبب</th>` : ''}</tr></thead><tbody>
            ${x.lines.map((l) => html`<tr><td class="num">${dShort(l.date)}</td><td>${l.text}</td><td class="n num">${l.qty}</td><td class="n num muted">${l.full ? money(l.full) : ''}</td><td class="n num"><b>${money(l.amount)}</b></td>
              ${!draft ? (canMan ? html`<td class="n"><input class="input num cm-rj" data-rj="${l.id}" value="${l.rejected || ''}" placeholder="0"></td><td><input class="input cm-rr" data-rr="${l.id}" value="${l.reason || ''}" placeholder="${l.rejected ? 'اكتب السبب' : ''}" list="rjReasons"></td>`
                : html`<td class="n num">${l.rejected ? money(l.rejected) : ''}</td><td>${l.reason || ''}</td>`) : ''}</tr>`)}</tbody></table></div>` : ''}
        </div>`; })}</div>
      <datalist id="rjReasons">${['مش مغطى في العقد', 'من غير موافقة', 'تجاوز الحد', 'فرق سعر', 'مستند ناقص', 'تكرار'].map((x) => html`<option value="${x}">`)}</datalist>`);
  };
  draw();
  const act = async (a) => {
    try {
      if (a === 'print') return openPrint(`/print/claim/${id}`, 'claim' + id);
      if (a === 'del') { const r = await askReason({ title: 'مسح المسودة؟', label: 'اكتب «امسح» للتأكيد', confirm: 'امسح' }); if (r == null) return; await api.del('/claims/' + id); toast('اتمسحت المسودة', 'info'); return window.go(`/claims/review?payer=${d.claim.payer.id}&period=${d.claim.period}`); }
      if (a === 'reopen') { const r = await askReason({ title: 'فتح المطالبة', label: 'السبب' }); if (!r) return; d = await api.post(`/claims/${id}/reopen`, { reason: r }); draw(); return toast('المطالبة رجعت مسودة', 'info'); }
      if (a === 'send') {
        const m = modal({
          title: `إرسال المطالبة ${d.claim.no} لـ ${d.claim.payer.name}`,
          body: html`<div class="field"><label>تاريخ الإصدار</label><input class="input" type="date" name="dt" value="${todayStr()}"></div>
            <div class="alertbar warn" style="margin-top:12px">${icon('lock')}<span>بعد الإرسال المطالبة بتتقفل (${money(d.totals.total)} ${HMS.money.symbol}). أي تعديل بعد كده بيروح للمطالبة اللي بعدها، والمدير بس يقدر يفتحها.</span></div>`,
          foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok>${icon('send')} اتبعتت</button>`,
        });
        $('[data-ok]', m.el).addEventListener('click', async () => { try { d = await api.post(`/claims/${id}/send`, { issueDate: $('[name=dt]', m.el).value }); m.close(); draw(); toast('المطالبة اتقفلت واتسجلت إنها اتبعتت'); } catch (er) { toastError(er); } });
      }
      if (a === 'pay') {
        const m = modal({
          title: 'تسجيل شيك',
          body: html`<div class="row wrap" style="gap:10px"><div class="field" data-f="chequeNo" style="flex:1 1 150px"><label>رقم الشيك</label><input class="input num" name="no" autofocus><div class="msg"></div></div>
              <div class="field" style="flex:1 1 150px"><label>البنك</label><input class="input" name="bank"></div></div>
            <div class="row wrap" style="gap:10px;margin-top:10px"><div class="field" data-f="amount" style="flex:1 1 150px"><label>المبلغ <span class="hint">الباقي ${money(d.totals.left)}</span></label><input class="input num" name="amt" value="${d.totals.left}" style="font-size:20px;font-weight:800;height:50px"><div class="msg"></div></div>
              <div class="field" style="flex:1 1 150px"><label>تاريخ الشيك</label><input class="input" type="date" name="dt" value="${todayStr()}"></div></div>
            <input class="input" name="note" placeholder="ملاحظة (اختياري)" style="margin-top:10px">
            <div class="muted" style="margin-top:8px;font-weight:600">لو الشيك أقل من المطالبة: سجّل المرفوض قدام البنود عشان الباقي يقفل.</div>`,
          foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} سجّل</button>`,
        });
        $('[data-ok]', m.el).addEventListener('click', async () => {
          try { d = await api.post(`/claims/${id}/payments`, { chequeNo: $('[name=no]', m.el).value, bank: $('[name=bank]', m.el).value, amount: latinDigits($('[name=amt]', m.el).value), date: $('[name=dt]', m.el).value, note: $('[name=note]', m.el).value }); m.close(); draw(); toast('اتسجل الشيك'); }
          catch (er) { if (er instanceof ApiError && er.data.errors) for (const [k, v] of Object.entries(er.data.errors)) { const f = $(`[data-f="${k}"]`, m.el); if (f) { f.classList.add('err'); $('.msg', f).textContent = v; } } toastError(er); }
        });
      }
    } catch (er) { toastError(er); }
  };
  view.onclick = async (e) => {
    const a = e.target.closest('[data-a]');
    if (a) return act(a.dataset.a);
    const t = e.target.closest('[data-tog]');
    if (t) { const k = Number(t.dataset.tog); S.open.has(k) ? S.open.delete(k) : S.open.add(k); return draw(); }
    const dp = e.target.closest('[data-dpay]');
    if (dp) { try { d = await api.del(`/claims/${id}/payments/${dp.dataset.dpay}`); draw(); toast('اتمسح الشيك', 'info'); } catch (er) { toastError(er); } }
  };
  view.onchange = async (e) => {
    const t = e.target;
    if (t.id === 'cnote') { try { d = await api.put('/claims/' + id, { note: t.value }); toast('اتحفظ'); } catch (er) { toastError(er); } return; }
    const lid = t.dataset.rj || t.dataset.rr;
    if (!lid) return;
    const row = t.closest('tr');
    const rj = latinDigits($('[data-rj]', row).value || '0'), rr = $('[data-rr]', row).value;
    if (Number(rj) > 0 && !rr) { $('[data-rr]', row).focus(); $('[data-rr]', row).classList.add('miss'); return; }
    try { const keep = new Set(S.open); d = await api.put(`/claims/${id}/lines/${lid}`, { rejected: rj, reason: rr }); keep.forEach((k) => S.open.add(k)); const cs = d.cases.find((c) => c.lines.some((l) => l.id === Number(lid))); if (cs) S.open.add(cs.id); draw(); toast('اتحفظ'); }
    catch (er) { toastError(er); }
  };
  return () => { view.onclick = view.onchange = null; };
}

// ========================= ملاحظات للاستقبال =========================
export async function renderClaimNotes(view, { setTitle }) {
  setTitle('ملاحظات حسابات التعاقدات', 'حالات محتاجة تصليح قبل ما تدخل المطالبة');
  const draw = (d) => {
    view.innerHTML = !d.cases.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش ملاحظات</b>كل الحالات تمام</div>`)
      : String(html`<div class="cn-grid">${d.cases.map((c) => html`<div class="card cn-card">
          <div class="row" style="gap:10px"><span class="cl-av">${initials(c.patient.name)}</span><div style="min-width:0;flex:1"><b>${c.patient.name}</b><small class="muted">${c.payer.name} · ${c.kind === 'visit' ? 'زيارة ' + c.ref.typeName : c.ref.typeName} <span class="num">${c.ref.no}</span></small></div></div>
          <div class="alertbar warn" style="margin:10px 0">${icon('alert')}<span><b>${c.note}</b><br><small>${c.noteBy || ''} · ${fmtWhen(c.noteAt)}</small></span></div>
          <button class="btn" data-fix="${c.id}" style="width:100%">${icon('edit')} صلّح</button></div>`)}</div>`);
  };
  const fix = async (cid) => {
    let d = await api.get('/claims/cases/' + cid);
    const body = () => html`<div class="alertbar warn" style="margin:0 0 10px">${icon('alert')}<span>${d.case.note}</span></div>
      <div class="field"><label>رقم الكارنيه</label><input class="input num" name="card" value="${d.case.cardNo || ''}"></div>
      <div class="field" style="margin-top:10px"><label>التشخيص</label><input class="input" name="diag" value="${d.case.diagnosis || ''}"></div>
      ${d.approvals.length ? html`<h4 class="subh">الموافقات</h4>${d.approvals.map((a) => html`<div class="cr-ap"><div style="flex:1;min-width:0"><b>${a.item}</b></div><input class="input num" data-ap="${a.id}" data-k="no" value="${a.no || ''}" placeholder="رقم الموافقة" style="width:140px"><input class="input" type="date" data-ap="${a.id}" data-k="date" value="${a.date || ''}" style="width:140px"></div>`)}` : ''}
      <h4 class="subh">المستندات <button type="button" class="btn ghost sm" data-up style="margin-inline-start:auto">${icon('upload', 'sm')} ارفع</button></h4>
      <div class="cr-files">${d.files.map((f) => html`<a class="cr-file" href="/api/claims/files/${f.id}" target="_blank">${icon('file', 'sm')}<b>${f.label}</b></a>`)}${!d.files.length ? html`<span class="muted">مفيش</span>` : ''}</div>`;
    const m = modal({ title: `${d.case.patient.name} · ${d.case.payer.name}`, wide: true, body: body(), foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} اتصلحت، رجّعها للمراجعة</button>` });
    m.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-up]')) {
        const f = await pickFile();
        if (f) { try { d = await uploadCaseFile(cid, f); $('.modal-body', m.el).innerHTML = String(body()); toast('اترفع'); } catch (er) { toastError(er); } }
        return;
      }
      if (!e.target.closest('[data-ok]')) return;
      try {
        await api.put('/claims/cases/' + cid, { cardNo: $('[name=card]', m.el).value, diagnosis: $('[name=diag]', m.el).value });
        for (const row of $$('.cr-ap', m.el)) { const no = $('[data-k=no]', row); await api.put(`/claims/cases/${cid}/approvals/${no.dataset.ap}`, { no: no.value, date: $('[data-k=date]', row).value || null }); }
        await api.post(`/claims/cases/${cid}/fixed`);
        m.close(); toast('رجعت لحسابات التعاقدات'); window.refreshShell?.(); draw(await api.get('/claims/notes'));
      } catch (er) { toastError(er); }
    });
  };
  view.onclick = (e) => { const f = e.target.closest('[data-fix]'); if (f) fix(Number(f.dataset.fix)); };
  draw(await api.get('/claims/notes'));
  return () => { view.onclick = null; };
}
void egp;
