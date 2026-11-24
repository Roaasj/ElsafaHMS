// الدفاتر: القيود اليومية ← دليل الحسابات ← ميزان المراجعة ← كشف الحساب ← إعدادات الربط والقفل
import { api, html, icon, $, $$, money, modal, toast, toastError, askReason, can, ApiError } from '../core.js';
import { latinDigits } from '/shared/text.js';

const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
const monthStart = () => todayStr().slice(0, 8) + '01';
const dFmt = (d) => (d ? d.split('-').reverse().join('/') : '—');
const num = (v) => latinDigits(String(v ?? '')).replace(/[,،\s]/g, '');
const SRC_CLS = { manual: 'py', payout_accrual: 'warn', payout_pay: 'ok', reversal: '' };
const TYPE_COLOR = { asset: 'var(--py)', liability: 'var(--warn)', equity: '#7048e8', revenue: 'var(--ok)', expense: 'var(--danger)' };
const empty = (ic, title, text = '') => html`<div class="card empty"><div class="art">${icon(ic)}</div><b>${title}</b>${text}</div>`;
const S = { from: monthStart(), to: todayStr(), accounts: null, types: {} };

async function loadAccounts() {
  const r = await api.get('/ledger/accounts');
  S.accounts = r.accounts; S.types = r.types;
  S.byId = Object.fromEntries(r.accounts.map((a) => [a.id, a]));
  S.depth = (a) => { let d = 0, x = a; while (x.parentId && S.byId[x.parentId]) { d++; x = S.byId[x.parentId]; } return d; };
  return r;
}
const leafOptions = (sel) => (S.accounts || []).filter((a) => !a.isGroup && a.active).map((a) => html`<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.code} · ${a.name}</option>`);
const rangeBar = (extra = '') => html`<div class="card" style="padding:10px 14px;margin-bottom:12px"><div class="row wrap" style="gap:10px;align-items:end">
  <div class="field" style="flex:0 0 150px"><label>من</label><input class="input" type="date" id="lf" value="${S.from}"></div>
  <div class="field" style="flex:0 0 150px"><label>إلى</label><input class="input" type="date" id="lt" value="${S.to}"></div>${extra}</div></div>`;

export async function renderLedger(view, { query, setTitle }) {
  const all = [['entries', 'القيود', 'receipt'], ['chart', 'دليل الحسابات', 'layers'], ['trial', 'ميزان المراجعة', 'chart'], ['statement', 'كشف حساب', 'file'], ['settings', 'الإعدادات', 'settings']];
  const tab = all.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'entries';
  setTitle('الدفاتر', { entries: 'القيود اليومية (تلقائية ويدوية)', chart: 'شجرة الحسابات', trial: 'أرصدة كل الحسابات في فترة', statement: 'حركة حساب برصيد متحرك', settings: 'ربط العمليات بالحسابات وقفل الفترات' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">${all.map(([k, n, ic]) => html`<a href="#/ledger?tab=${k}" class="stab ${tab === k ? 'on' : ''}">${icon(ic)}<span>${n}</span></a>`)}</nav><div id="lp"></div>`);
  await loadAccounts();
  const pane = $('#lp', view);
  const fn = { entries: entriesPane, chart: chartPane, trial: trialPane, statement: statementPane, settings: settingsPane }[tab];
  return fn(pane, query);
}

// ---------- عرض قيد ----------
async function openEntry(id, reload) {
  const { entry: e } = await api.get('/ledger/entries/' + id);
  const dr = e.lines.reduce((a, l) => a + HMS.money.toMinor(l.debit), 0) / HMS.money.F;
  const mm = modal({
    title: `قيد رقم ${e.no}`, wide: true,
    body: html`<div class="row wrap" style="gap:8px;margin-bottom:10px"><span class="badge ${SRC_CLS[e.source] || ''}">${e.sourceName}</span><span class="badge">${dFmt(e.date)}</span>
        ${e.status === 'reversed' ? html`<span class="badge danger">معكوس</span>` : ''}${e.reversalOf ? html`<span class="badge">قيد عكسي لقيد ${e.reversalOf}</span>` : ''}<span class="spacer"></span><small class="muted">${e.by || ''}</small></div>
      <div style="font-weight:800;margin-bottom:10px">${e.description}</div>
      <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الحساب</th><th>بيان</th><th class="n">مدين</th><th class="n">دائن</th></tr></thead><tbody>
        ${e.lines.map((l) => html`<tr><td><b class="num">${l.code}</b> ${l.account}</td><td class="muted">${l.memo || ''}</td><td class="n num">${l.debit ? money(l.debit) : ''}</td><td class="n num">${l.credit ? money(l.credit) : ''}</td></tr>`)}
        <tr style="font-weight:900"><td colspan="2">الإجمالي</td><td class="n num">${money(dr)}</td><td class="n num">${money(dr)}</td></tr></tbody></table></div></div>`,
    foot: html`${e.status === 'posted' && !e.reversalOf && can('ledger.reverse') ? html`<button class="btn ghost" data-rev style="margin-inline-end:auto;color:var(--danger)">${icon('undo', 'sm')} اعكس القيد</button>` : ''}<button class="btn ghost" data-close>قفل</button>`,
  });
  $('[data-rev]', mm.el)?.addEventListener('click', async () => {
    const reason = await askReason({ title: `عكس قيد ${e.no}`, note: 'هيتسجل قيد عكسي بنفس المبالغ والقيد الأصلي بيتعلّم «معكوس». مفيش مسح.' });
    if (!reason) return;
    try { await api.post(`/ledger/entries/${e.id}/reverse`, { reason }); mm.close(); toast('اتعكس'); reload?.(); } catch (er) { toastError(er); }
  });
}

// ---------- القيود ----------
async function entriesPane(pane) {
  const F = { q: '', source: '' };
  const load = async () => {
    const qs = new URLSearchParams({ from: S.from, to: S.to, ...(F.q ? { q: F.q } : {}), ...(F.source ? { source: F.source } : {}) });
    const r = await api.get('/ledger/entries?' + qs);
    pane.innerHTML = String(html`${rangeBar(html`<div class="field" style="flex:1 1 180px"><label>بحث</label><input class="input" id="lq" value="${F.q}" placeholder="بيان أو رقم قيد"></div>
        <div class="field" style="flex:0 0 190px"><label>المصدر</label><select class="select" id="ls"><option value="">الكل</option>${[['manual', 'قيد يدوي'], ['payout_accrual', 'اعتماد مستحقات'], ['payout_pay', 'صرف مستحقات'], ['reversal', 'قيد عكسي']].map(([k, n]) => html`<option value="${k}" ${F.source === k ? 'selected' : ''}>${n}</option>`)}</select></div>
        <span class="spacer"></span>${can('ledger.post') ? html`<button class="btn" id="newE">${icon('plus', 'sm')} قيد يدوي</button>` : ''}`)}
      ${r.entries.length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>التاريخ</th><th>البيان</th><th>المصدر</th><th class="n">المبلغ</th><th></th></tr></thead><tbody>
        ${r.entries.map((e) => html`<tr data-e="${e.id}" style="cursor:pointer"><td class="num"><b>${e.no}</b></td><td>${dFmt(e.date)}</td><td>${e.description}</td><td><span class="badge ${SRC_CLS[e.source] || ''}">${e.sourceName}</span>${e.status === 'reversed' ? html` <span class="badge danger">معكوس</span>` : ''}</td><td class="n num"><b>${money(e.debit)}</b></td><td class="n">${icon('chev-left', 'sm')}</td></tr>`)}
        </tbody></table></div></div>${r.total > r.entries.length ? html`<div class="muted" style="margin-top:8px;font-weight:700">معروض آخر ${r.entries.length} من ${r.total}. ضيّق الفترة أو ابحث.</div>` : ''}`
        : empty('receipt', 'مفيش قيود في الفترة دي', 'القيود التلقائية بتظهر لما مستحقات الأطباء تتعتمد وتتصرف.')}`);
  };
  pane.onchange = (e) => {
    if (e.target.id === 'lf') { S.from = e.target.value; load(); } else if (e.target.id === 'lt') { S.to = e.target.value; load(); } else if (e.target.id === 'ls') { F.source = e.target.value; load(); }
  };
  pane.onkeydown = (e) => { if (e.target.id === 'lq' && e.key === 'Enter') { F.q = e.target.value.trim(); load(); } };
  pane.onclick = async (e) => {
    try {
      const row = e.target.closest('[data-e]');
      if (row) return await openEntry(Number(row.dataset.e), load);
      if (e.target.closest('#newE')) return manualEntry(load);
    } catch (er) { toastError(er); }
  };
  await load();
  return () => { pane.onclick = pane.onchange = pane.onkeydown = null; };
}

function manualEntry(reload) {
  const L = [{ accountId: '', debit: '', credit: '', memo: '' }, { accountId: '', debit: '', credit: '', memo: '' }];
  const tot = () => ({ d: L.reduce((a, x) => a + (Number(num(x.debit)) || 0), 0), c: L.reduce((a, x) => a + (Number(num(x.credit)) || 0), 0) });
  const mm = modal({
    title: 'قيد يدوي', wide: true,
    body: html`<div class="row wrap" style="gap:10px"><div class="field" style="flex:0 0 170px"><label>التاريخ</label><input class="input" type="date" name="date" value="${todayStr()}"></div>
        <div class="field" style="flex:1 1 300px" data-f="description"><label>البيان <span class="req">*</span></label><input class="input" name="desc" placeholder="مثلًا: رصيد افتتاحي"><div class="msg"></div></div></div>
      <div id="el" style="margin-top:6px"></div>`,
    foot: html`<span id="et" class="muted" style="margin-inline-end:auto;font-weight:800"></span><button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} رحّل القيد</button>`,
  });
  const draw = () => {
    $('#el', mm.el).innerHTML = String(html`<div class="table-wrap"><table class="table"><thead><tr><th>الحساب</th><th class="n" style="width:130px">مدين</th><th class="n" style="width:130px">دائن</th><th style="width:40px"></th></tr></thead><tbody>
      ${L.map((l, i) => html`<tr><td><select class="select" data-k="accountId" data-i="${i}"><option value="">اختار الحساب</option>${leafOptions(l.accountId)}</select></td>
        <td><input class="input num" data-k="debit" data-i="${i}" value="${l.debit}" inputmode="decimal"></td><td><input class="input num" data-k="credit" data-i="${i}" value="${l.credit}" inputmode="decimal"></td>
        <td>${L.length > 2 ? html`<button class="btn ghost icon sm" data-del="${i}">${icon('x', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div>
      <button class="btn ghost sm" data-add style="margin-top:8px">${icon('plus', 'sm')} سطر</button>`);
    upd();
  };
  const upd = () => { const t = tot(); const ok = t.d > 0 && Math.abs(t.d - t.c) < 0.0001; $('#et', mm.el).innerHTML = `مدين ${money(t.d)} · دائن ${money(t.c)} ${ok ? '✓ متوازن' : '· غير متوازن'}`; $('#et', mm.el).style.color = ok ? 'var(--ok)' : 'var(--danger)'; };
  mm.el.addEventListener('input', (e) => { const k = e.target.dataset.k; if (k) { L[Number(e.target.dataset.i)][k] = e.target.value; upd(); } });
  mm.el.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k === 'accountId') L[Number(e.target.dataset.i)][k] = e.target.value; });
  mm.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) { L.push({ accountId: '', debit: '', credit: '', memo: '' }); draw(); }
    const d = e.target.closest('[data-del]'); if (d) { L.splice(Number(d.dataset.del), 1); draw(); }
  });
  $('[data-ok]', mm.el).addEventListener('click', async () => {
    try {
      await api.post('/ledger/entries', { date: $('[name=date]', mm.el).value, description: $('[name=desc]', mm.el).value,
        lines: L.filter((l) => l.accountId || l.debit || l.credit).map((l) => ({ accountId: Number(l.accountId), debit: num(l.debit), credit: num(l.credit) })) });
      mm.close(); toast('اتسجّل القيد'); reload?.();
    } catch (er) { if (er instanceof ApiError && er.data?.errors?.description) { const f = $('[data-f=description]', mm.el); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.description; } toastError(er); }
  });
  draw();
}

// ---------- دليل الحسابات ----------
async function chartPane(pane) {
  const canM = can('ledger.manage');
  const draw = () => {
    pane.innerHTML = String(html`<div class="row wrap" style="margin-bottom:10px;gap:8px"><span class="muted" style="font-weight:700">الحسابات التجميعية بتجمّع اللي تحتها، والقيود بتتسجّل على الحسابات الفرعية بس.</span><span class="spacer"></span>
        ${canM ? html`<button class="btn" data-add="">${icon('plus', 'sm')} حساب جديد</button>` : ''}</div>
      <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الكود</th><th>الحساب</th><th>النوع</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${S.accounts.map((a) => html`<tr style="${a.active ? '' : 'opacity:.55'}"><td class="num"><b>${a.code}</b></td>
        <td style="padding-inline-start:${12 + S.depth(a) * 22}px">${a.isGroup ? icon('layers', 'sm') : ''} <b style="${a.isGroup ? '' : 'font-weight:600'}">${a.name}</b>${a.mapped ? html` <span class="badge py" title="متربط بعملية في الإعدادات">متربط</span>` : ''}</td>
        <td><span class="badge" style="background:${TYPE_COLOR[a.type]};color:#fff">${a.typeName}</span></td><td>${a.active ? '' : html`<span class="badge">موقوف</span>`}${a.used ? html` <span class="badge ok">عليه قيود</span>` : ''}</td>
        <td class="n" style="white-space:nowrap">${canM ? html`${a.isGroup ? html`<button class="btn ghost sm" data-add="${a.id}">${icon('plus', 'sm')} فرعي</button> ` : ''}<button class="btn ghost sm" data-edit="${a.id}">${icon('edit', 'sm')}</button>` : ''}</td></tr>`)}
      </tbody></table></div></div>`);
  };
  const form = (a, parentId) => {
    const isNew = !a;
    const mm = modal({
      title: isNew ? 'حساب جديد' : `تعديل ${a.name}`,
      body: html`<div class="row wrap" style="gap:10px"><div class="field" style="flex:0 0 140px"><label>الكود <span class="req">*</span></label><input class="input num" name="code" value="${a?.code || ''}"></div>
          <div class="field" style="flex:1 1 220px"><label>الاسم <span class="req">*</span></label><input class="input" name="name" value="${a?.name || ''}"></div></div>
        <div class="row wrap" style="gap:10px;margin-top:8px"><div class="field" style="flex:1 1 220px"><label>الحساب الأب</label><select class="select" name="parent"><option value="">— رئيسي —</option>
          ${S.accounts.filter((x) => x.isGroup && x.id !== a?.id).map((x) => html`<option value="${x.id}" ${String(a ? a.parentId : parentId) === String(x.id) ? 'selected' : ''}>${x.code} · ${x.name}</option>`)}</select></div>
          <div class="field" style="flex:0 0 170px"><label>النوع</label><select class="select" name="type" ${a?.used ? 'disabled' : ''}>${Object.entries(S.types).map(([k, n]) => html`<option value="${k}" ${(a?.type || 'asset') === k ? 'selected' : ''}>${n}</option>`)}</select></div></div>
        <div class="muted" style="font-size:12.5px;margin-top:6px;font-weight:600">لو اخترت أب، النوع بيتاخد منه.</div>
        <label class="row" style="gap:8px;margin-top:12px;font-weight:700"><input type="checkbox" name="grp" ${a?.isGroup ? 'checked' : ''} ${a?.used ? 'disabled' : ''}> حساب تجميعي (بيجمّع حسابات فرعية ومفيهوش قيود)</label>
        ${!isNew ? html`<label class="row" style="gap:8px;margin-top:8px;font-weight:700"><input type="checkbox" name="act" ${a.active ? 'checked' : ''}> شغّال</label>` : ''}`,
      foot: html`${!isNew && !a.used && !a.mapped ? html`<button class="btn ghost" data-del style="margin-inline-end:auto;color:var(--danger)">${icon('trash', 'sm')} امسح</button>` : ''}<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} حفظ</button>`,
    });
    const body = () => ({ code: $('[name=code]', mm.el).value.trim(), name: $('[name=name]', mm.el).value.trim(), parentId: $('[name=parent]', mm.el).value || null, type: $('[name=type]', mm.el).value, isGroup: $('[name=grp]', mm.el).checked, ...(isNew ? {} : { active: $('[name=act]', mm.el).checked }) });
    $('[data-ok]', mm.el).addEventListener('click', async () => { try { if (isNew) await api.post('/ledger/accounts', body()); else await api.put('/ledger/accounts/' + a.id, body()); mm.close(); toast('اتحفظ'); await loadAccounts(); draw(); } catch (er) { toastError(er); } });
    $('[data-del]', mm.el)?.addEventListener('click', async () => { try { await api.del('/ledger/accounts/' + a.id); mm.close(); toast('اتمسح'); await loadAccounts(); draw(); } catch (er) { toastError(er); } });
  };
  pane.onclick = (e) => {
    const ad = e.target.closest('[data-add]'); if (ad) return form(null, ad.dataset.add || null);
    const ed = e.target.closest('[data-edit]'); if (ed) return form(S.byId[Number(ed.dataset.edit)]);
  };
  draw();
  return () => { pane.onclick = null; };
}

// ---------- ميزان المراجعة ----------
async function trialPane(pane) {
  const load = async () => {
    const r = await api.get(`/ledger/trial?from=${S.from}&to=${S.to}`);
    const kids = {}; for (const a of r.rows) (kids[a.parentId || 0] ||= []).push(a);
    const sums = {}; // تجميع الحسابات التجميعية من الفروع
    const roll = (a) => { const s = sums[a.id] = { open: 0, debit: 0, credit: 0, close: 0 }; if (a.isGroup) { for (const k of kids[a.id] || []) { const c = roll(k); s.open += c.open; s.debit += c.debit; s.credit += c.credit; s.close += c.close; } } else { s.open = a.open; s.debit = a.debit; s.credit = a.credit; s.close = a.close; } return s; };
    (kids[0] || []).forEach(roll);
    const shown = r.rows.filter((a) => a.active || a.debit || a.credit || a.open);
    pane.innerHTML = String(html`${rangeBar(html`<span class="spacer"></span><span class="badge ${r.balanced ? 'ok' : 'danger'}">${r.balanced ? 'الميزان متوازن' : 'الميزان مش متوازن'}</span>`)}
      <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الكود</th><th>الحساب</th><th class="n">رصيد أول</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">رصيد آخر</th></tr></thead><tbody>
      ${shown.map((a) => { const s = sums[a.id]; const depth = (() => { let d = 0, x = a; const by = Object.fromEntries(r.rows.map((y) => [y.id, y])); while (x.parentId && by[x.parentId]) { d++; x = by[x.parentId]; } return d; })();
        return html`<tr ${a.isGroup ? 'style="background:var(--bg-2)"' : `data-acc="${a.id}" style="cursor:pointer"`}><td class="num"><b>${a.code}</b></td><td style="padding-inline-start:${12 + depth * 22}px"><b style="${a.isGroup ? '' : 'font-weight:600'}">${a.name}</b></td>
          <td class="n num">${s.open ? money(s.open) : '—'}</td><td class="n num">${s.debit ? money(s.debit) : '—'}</td><td class="n num">${s.credit ? money(s.credit) : '—'}</td><td class="n num"><b>${s.close ? money(s.close) : '—'}</b></td></tr>`; })}
      <tr style="font-weight:900"><td colspan="2">إجمالي حركة الفترة</td><td></td><td class="n num">${money(r.totals.debit)}</td><td class="n num">${money(r.totals.credit)}</td><td></td></tr>
      <tr style="font-weight:900"><td colspan="2">إجمالي الأرصدة (مدين / دائن)</td><td></td><td class="n num">${money(r.totals.closeDebit)}</td><td class="n num">${money(r.totals.closeCredit)}</td><td></td></tr></tbody></table></div></div>`);
  };
  pane.onchange = (e) => { if (e.target.id === 'lf') { S.from = e.target.value; load(); } else if (e.target.id === 'lt') { S.to = e.target.value; load(); } };
  pane.onclick = (e) => { const r = e.target.closest('[data-acc]'); if (r) { S.stmt = Number(r.dataset.acc); location.hash = '#/ledger?tab=statement'; } };
  await load();
  return () => { pane.onclick = pane.onchange = null; };
}

// ---------- كشف حساب ----------
async function statementPane(pane) {
  const load = async () => {
    const opts = S.accounts.filter((a) => a.active || a.used).map((a) => html`<option value="${a.id}" ${S.stmt === a.id ? 'selected' : ''}>${a.code} · ${a.name}</option>`);
    const head = rangeBar(html`<div class="field" style="flex:1 1 260px"><label>الحساب</label><select class="select" id="la"><option value="">اختار الحساب</option>${opts}</select></div>`);
    if (!S.stmt) { pane.innerHTML = String(html`${head}${empty('file', 'اختار حساب', 'هتشوف حركته برصيد متحرك.')}`); return; }
    const r = await api.get(`/ledger/statement?accountId=${S.stmt}&from=${S.from}&to=${S.to}`);
    pane.innerHTML = String(html`${head}<div class="acc-kpis rep-kpis" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:12px">
        <div class="akpi"><div><small>رصيد أول الفترة</small><b class="num">${money(r.opening)} ${HMS.money.symbol}</b></div></div>
        <div class="akpi" style="--kc:var(--ok)"><div><small>رصيد آخر الفترة</small><b class="num">${money(r.closing)} ${HMS.money.symbol}</b></div></div></div>
      ${r.rows.length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>قيد</th><th>التاريخ</th><th>البيان</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">الرصيد</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr data-e="${x.entryId}" style="cursor:pointer"><td class="num"><b>${x.no}</b></td><td>${dFmt(x.date)}</td><td>${x.description}${r.account.isGroup ? html`<br><small class="muted">${x.account}</small>` : ''}</td><td class="n num">${x.debit ? money(x.debit) : ''}</td><td class="n num">${x.credit ? money(x.credit) : ''}</td><td class="n num"><b>${money(x.balance)}</b></td></tr>`)}</tbody></table></div></div>`
        : empty('file', 'مفيش حركة في الفترة دي')}`);
  };
  pane.onchange = (e) => { if (e.target.id === 'lf') { S.from = e.target.value; load(); } else if (e.target.id === 'lt') { S.to = e.target.value; load(); } else if (e.target.id === 'la') { S.stmt = Number(e.target.value) || null; load(); } };
  pane.onclick = (e) => { const r = e.target.closest('[data-e]'); if (r) openEntry(Number(r.dataset.e), load).catch(toastError); };
  await load();
  return () => { pane.onclick = pane.onchange = null; };
}

// ---------- الإعدادات ----------
async function settingsPane(pane) {
  const st = await api.get('/ledger/settings');
  const canM = st.canManage;
  const pend = (await api.get('/ledger/shifts/pending')).count;
  pane.innerHTML = String(html`${pend ? html`<div class="card pad" style="max-width:760px;margin-bottom:14px;border-color:#f0b429"><b>${pend} وردية مقفولة لسه ماتحسبتش في الدفاتر</b>
      <div class="muted" style="font-weight:600;margin:6px 0 10px">الورديات القديمة (قبل تشغيل القيود) أو اللي اتقفلت والربط ناقص بترحّلها من هنا مرة واحدة، وكل وردية بتتقيّد مرة واحدة بس.</div>
      <button class="btn" id="ps">${icon('check')} رحّل الورديات دلوقتي</button></div>` : ''}<div class="card pad" style="max-width:760px"><h3 style="margin-top:0">${icon('settings', 'sm')} تشغيل القيود وقفل الفترات</h3>
      <label class="row" style="gap:8px;font-weight:800"><input type="checkbox" id="en" ${st.enabled ? 'checked' : ''} ${canM ? '' : 'disabled'}> القيود المحاسبية شغّالة (لو اتوقفت، العمليات بتكمل من غير قيود)</label>
      <div class="field" style="margin-top:12px;max-width:240px"><label>قفل الدفاتر لحد تاريخ</label><input class="input" type="date" id="lk" value="${st.lockDate || ''}" ${canM ? '' : 'disabled'}></div>
      <div class="muted" style="font-size:12.5px;font-weight:600">أي قيد بتاريخ لحد التاريخ ده بيترفض، إلا لمن عنده صلاحية «التسجيل في فترة مقفولة». سيبه فاضي لو مفيش قفل.</div></div>
    <div class="card pad" style="max-width:760px;margin-top:14px"><h3 style="margin-top:0">${icon('percent', 'sm')} ربط العمليات بالحسابات</h3>
      <div class="muted" style="font-weight:600;margin-bottom:10px">كل عملية بتتقيّد على الحساب اللي تختاره هنا. لو اتسابت من غير ربط، العملية بتتوقف برسالة واضحة.</div>
      ${st.map.map((m) => html`<div class="row" style="gap:10px;margin-bottom:8px;align-items:center"><b style="flex:0 0 250px">${m.name}</b><select class="select" data-map="${m.key}" style="flex:1" ${canM ? '' : 'disabled'}>
        <option value="">${m.dynamic ? '— على الحساب الإجمالي —' : '— مش متربط —'}</option>${S.accounts.filter((a) => !a.isGroup && a.active && a.type === m.type).map((a) => html`<option value="${a.id}" ${m.accountId === a.id ? 'selected' : ''}>${a.code} · ${a.name}</option>`)}</select></div>`)}
      ${canM ? html`<button class="btn" id="sv" style="margin-top:8px">${icon('check')} حفظ</button>` : ''}</div>`);
  pane.onclick = async (e) => {
    if (e.target.closest('#ps')) {
      try { const r = await api.post('/ledger/shifts/post', {}); toast(`اترحّل ${r.posted} وردية${r.skipped ? ` (اتخطّى ${r.skipped})` : ''}`); settingsPane(pane); } catch (er) { toastError(er); }
      return;
    }
    if (!e.target.closest('#sv')) return;
    try {
      const map = {}; $$('[data-map]', pane).forEach((s) => { if (s.value) map[s.dataset.map] = Number(s.value); else if (/^(revenue\.clinic|doctor\.expense\.clinic|expense\.cat)\./.test(s.dataset.map)) map[s.dataset.map] = 0; });
      await api.put('/ledger/settings', { enabled: $('#en', pane).checked, lockDate: $('#lk', pane).value, map });
      toast('اتحفظ');
    } catch (er) { toastError(er); }
  };
  return () => { pane.onclick = null; };
}
