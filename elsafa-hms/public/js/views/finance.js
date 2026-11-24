// الحسابات العامة: صرف الدكاترة (بالضريبة) ← الموردين ← المصروفات ← الأقساط ← الشيكات ← إذون الصرف النقدي، وشاشة المدير
import {
  api, html, icon, $, $$, money, fmtWhen, modal, toast, toastError, askReason, can, openPrint, ApiError, initials,
} from '../core.js';
import { latinDigits } from '/shared/text.js';

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
const thisPeriod = () => todayStr().slice(0, 7);
const shiftP = (p, n) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const pName = (p) => { const [y, m] = p.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const dFmt = (d) => (d ? d.split('-').reverse().join('/') : '—');
const dShort = (d) => (d ? `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}` : '—');
const daysTo = (d) => Math.round((Date.parse(d) - Date.parse(todayStr())) / 86400e3);
const num = (v) => latinDigits(String(v ?? '')).replace(/[,،\s]/g, '');
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } } };
const KIND_CLS = { payout: 'py', expense: 'warn', supplier: 'lab', installment: 'rad' };
const ST_EXP = { pending: ['مستني موافقة', 'warn'], approved: ['معتمد', 'ok'], rejected: ['مرفوض', 'danger'], void: ['ملغي', ''] };
const M_NAME = { bank: 'تحويل بنكي', cash: 'نقدي من الخزينة', cheque: 'شيك' };

function showErrs(m, er) {
  if (er instanceof ApiError && er.data?.errors) {
    for (const [k, v] of Object.entries(er.data.errors)) { const f = $(`[data-f="${k}"]`, m.el); if (f) { f.classList.add('err'); const g = $('.msg', f); if (g) g.textContent = v; } }
  }
  toastError(er);
}
const clearErrs = (m) => $$('.field.err', m.el).forEach((f) => { f.classList.remove('err'); const g = $('.msg', f); if (g) g.textContent = ''; });
const field = (name, label, inner, { flex = '1 1 150px', hint = '' } = {}) => html`<div class="field" data-f="${name}" style="flex:${flex}"><label>${label}${hint ? html` <span class="hint">${hint}</span>` : ''}</label>${inner}<div class="msg"></div></div>`;
const monthBar = (S, extra = '') => html`<div class="cl-month card"><button class="btn ghost icon" data-m="-1" aria-label="الشهر اللي فات">${icon('chev-right')}</button>
  <div class="cl-mname"><b>${pName(S.period)}</b><small>${S.period === thisPeriod() ? 'الشهر الحالي' : ''}</small></div>
  <button class="btn ghost icon" data-m="1" aria-label="الشهر الجاي" ${S.period >= thisPeriod() ? 'disabled' : ''}>${icon('chev-left')}</button><span class="spacer"></span>${extra}</div>`;
const empty = (ic, title, text = '') => html`<div class="card empty"><div class="art">${icon(ic)}</div><b>${title}</b>${text}</div>`;

// ========================= الشاشة =========================
export async function renderFinance(view, { query, setTitle }) {
  const all = [['doctors', 'صرف الدكاترة', 'steth', 'fin.payout'], ['suppliers', 'الموردين', 'box', 'fin.supplier'], ['expenses', 'المصروفات', 'receipt', 'fin.expense'],
    ['installments', 'الأقساط', 'calendar', 'fin.oblig'], ['cheques', 'الشيكات', 'cash', 'fin.view'], ['vouchers', 'إذون الصرف', 'cashbox', 'fin.view']];
  const tabs = all.filter((t) => can(t[3]) || can('fin.view'));
  const tab = tabs.some((t) => t[0] === query.get('tab')) ? query.get('tab') : tabs[0][0];
  setTitle('الحسابات العامة', { doctors: 'مستحقات الأطباء والضريبة', suppliers: 'فواتير الموردين ودفعاتهم', expenses: 'مصروفات المستشفى', installments: 'أقساط علينا', cheques: 'الشيكات المستحقة', vouchers: 'الصرف النقدي من الخزينة' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">${tabs.map(([k, n, ic]) => html`<a href="#/finance?tab=${k}" class="stab ${tab === k ? 'on' : ''}">${icon(ic)}<span>${n}</span></a>`)}</nav><div id="fp"></div>`);
  const pane = $('#fp', view);
  const fn = { doctors: doctorsPane, suppliers: suppliersPane, expenses: expensesPane, installments: installmentsPane, cheques: chequesPane, vouchers: vouchersPane }[tab];
  return fn(pane, query);
}
export async function renderVouchers(view, { setTitle }) {
  setTitle('إذون الصرف', 'الصرف النقدي من الخزينة');
  view.innerHTML = '<div id="fp"></div>';
  return vouchersPane($('#fp', view));
}

// ========================= صرف الدكاترة =========================
async function doctorsPane(pane) {
  const S = { period: store.get('finPeriod') || null, sel: new Set(), data: null, list: [], pend: [] };
  const canPay = can('fin.payout');
  const draw = () => {
    const d = S.data;
    const payable = d.rows.filter((x) => x.gross > 0);
    pane.innerHTML = String(html`${monthBar(S, html`<span class="badge py">${icon('percent', 'sm')} ضريبة ${d.taxPct}%</span>
        ${can('settings.manage') ? html`<button class="btn ghost sm" data-a="settings">${icon('settings', 'sm')} إعدادات الصرف</button>` : ''}
        <a class="btn ghost sm" href="javascript:void 0" data-a="print">${icon('print', 'sm')} كشف الصرف</a>`)}
      ${d.early ? html`<div class="alertbar warn" style="margin-bottom:12px">${icon('clock')}<span>الصرف عادةً بعد يوم ${d.payoutDay} من الشهر. لسه قبل الميعاد، لكن تقدر تصدر الإذن لو عايز.</span></div>` : ''}
      <div class="acc-kpis rep-kpis" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:12px">
        <div class="akpi"><span class="gi">${icon('steth')}</span><div><small>مستحق الصرف</small><b class="num">${money(d.totals.gross)} ${HMS.money.symbol}</b></div></div>
        <div class="akpi warn"><span class="gi">${icon('percent')}</span><div><small>ضريبة ${d.taxPct}%</small><b class="num">${money(d.totals.tax)} ${HMS.money.symbol}</b></div></div>
        <div class="akpi" style="--kc:var(--ok)"><span class="gi">${icon('cash')}</span><div><small>الصافي للدكاترة</small><b class="num">${money(d.totals.net)} ${HMS.money.symbol}</b></div></div></div>
      ${!payable.length ? empty('check', 'مفيش مستحقات جديدة للصرف', `كل مستحقات ${d.periodName} اتصرفت أو اتجهزت`)
        : html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr>${canPay ? html`<th style="width:38px"><input type="checkbox" data-all ${S.sel.size === payable.length ? 'checked' : ''}></th>` : ''}<th>الدكتور</th><th class="n">البنود</th><th class="n">المستحق</th><th class="n">الضريبة</th><th class="n">الصافي</th><th class="n">معلّق عند الشركات</th></tr></thead><tbody>
          ${payable.map((x) => html`<tr>${canPay ? html`<td><input type="checkbox" data-sel="${x.id}" ${S.sel.has(x.id) ? 'checked' : ''}></td>` : ''}<td><b>${x.name}</b>${x.specialty ? html`<br><small class="muted">${x.specialty}</small>` : ''}</td><td class="n num">${x.count}</td>
            <td class="n num">${money(x.gross)}</td><td class="n num" style="color:var(--warn)">${money(x.tax)}</td><td class="n num"><b>${money(x.net)}</b></td><td class="n num muted">${x.pending ? money(x.pending) : '—'}</td></tr>`)}
          </tbody></table></div></div>
        ${canPay ? html`<div class="row" style="margin-top:12px;gap:10px;flex-wrap:wrap"><span class="muted" style="font-weight:700">${S.sel.size ? `${S.sel.size} دكتور مختار` : 'اختار الدكاترة اللي هتصرفلهم'}</span><span class="spacer"></span>
          <button class="btn" data-a="issue" ${S.sel.size ? '' : 'disabled'}>${icon('cashbox')} إصدار إذن صرف للمختارين</button></div>` : ''}`}
      ${S.list.length ? html`<h4 class="subh" style="margin-top:20px">${icon('history', 'sm')} الصرف اللي اتعمل في ${d.periodName}</h4>
        <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>الدكتور</th><th class="n">المستحق</th><th class="n">الضريبة</th><th class="n">الصافي</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${S.list.map((p) => html`<tr><td class="num">${p.no}</td><td><b>${p.doctor}</b><br><small class="muted">${fmtWhen(p.at)}</small></td><td class="n num">${money(p.gross)}</td><td class="n num">${money(p.tax)}</td><td class="n num"><b>${money(p.net)}</b></td>
          <td>${p.stage === 'paid' ? html`<span class="badge ok">${icon('check', 'sm')} اتصرف</span>` : p.stage === 'approved' ? html`<span class="badge warn">${icon('hourglass', 'sm')} مستني الخزينة${p.voucherNo ? ` · إذن ${p.voucherNo}` : ''}</span>${p.approvedBy ? html`<br><small class="muted">اعتمده ${p.approvedBy}</small>` : ''}` : p.stage === 'pending' ? html`<span class="badge py">${icon('shield', 'sm')} مستني اعتماد المدير المالي</span>` : html`<span class="badge">اتلغى</span>`}
            ${p.editedBy ? html`<br><small class="muted" title="${p.editNote || ''}">اتعدّل بواسطة ${p.editedBy}</small>` : ''}</td>
          <td class="n" style="white-space:nowrap">${p.stage === 'pending' && can('fin.approve') ? html`<button class="btn sm" data-appr="${p.id}" style="--c:var(--ok)">${icon('check', 'sm')} اعتمد</button> ` : ''}
            ${(p.stage === 'pending' || p.stage === 'approved') && can('fin.payoutEdit') ? html`<button class="btn ghost sm" data-edit="${p.id}">${icon('edit', 'sm')} عدّل</button> ` : ''}
            ${(p.stage === 'pending' || p.stage === 'approved') && canPay ? html`<button class="btn ghost sm" data-void="${p.id}">إلغاء</button>` : ''}</td></tr>`)}</tbody></table></div></div>` : ''}
      ${S.pend.length ? html`<h4 class="subh" style="margin-top:20px">${icon('shield', 'sm')} نصيب الشركات من أتعاب الدكاترة <span class="muted" style="font-weight:600">(مستحق بعد ما الشركة تدفع)</span></h4>
        <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الدكتور</th><th>الجهة</th><th class="n">البنود</th><th class="n">المبلغ</th><th></th></tr></thead><tbody>
        ${S.pend.map((x) => html`<tr><td><b>${x.doctor}</b></td><td>${x.payer}</td><td class="n num">${x.count}</td><td class="n num">${money(x.amount)}</td>
          <td>${canPay ? html`<button class="btn ghost sm" data-rel="${x.doctorId}:${x.payerId}">${icon('check', 'sm')} الشركة دفعت · حرّر</button>` : ''}</td></tr>`)}</tbody></table></div></div>` : ''}`);
  };
  const load = async () => {
    const q = S.period ? `?period=${S.period}` : '';
    S.data = await api.get('/finance/payouts/prepare' + q);
    S.period = S.data.period;
    [S.list, S.pend] = await Promise.all([api.get(`/finance/payouts?period=${S.period}`).then((r) => r.payouts), api.get('/finance/payouts/pending-payer').then((r) => r.rows)]);
    S.sel = new Set([...S.sel].filter((id) => S.data.rows.some((x) => x.id === id && x.gross > 0)));
    draw();
  };
  pane.onclick = async (e) => {
    try {
      const m = e.target.closest('[data-m]');
      if (m) { S.period = shiftP(S.period, Number(m.dataset.m)); store.set('finPeriod', S.period); S.sel.clear(); return await load(); }
      if (e.target.closest('[data-all]')) { const rows = S.data.rows.filter((x) => x.gross > 0); S.sel = S.sel.size === rows.length ? new Set() : new Set(rows.map((x) => x.id)); return draw(); }
      const s = e.target.closest('[data-sel]');
      if (s) { const id = Number(s.dataset.sel); S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); return draw(); }
      const ap = e.target.closest('[data-appr]');
      if (ap) {
        const p = S.list.find((x) => x.id === Number(ap.dataset.appr));
        const mm = modal({ title: `اعتماد مستحق ${p.doctor}`, body: html`<div class="alertbar info">${icon('info')}<span>بعد الاعتماد بيظهر إذن صرف عند موظف الخزينة بمبلغ <b class="num">${money(p.net)}</b> ${HMS.money.symbol} (بعد الضريبة).</span></div>`,
          foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} اعتمد</button>` });
        $('[data-ok]', mm.el).addEventListener('click', async () => { try { await api.post(`/finance/payouts/${p.id}/approve`, {}); mm.close(); toast('اتعتمد. الإذن ظهر عند الخزينة'); await load(); } catch (er) { toastError(er); } });
        return;
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        const p = S.list.find((x) => x.id === Number(ed.dataset.edit));
        const mm = modal({ title: `تعديل مستحق ${p.doctor}`,
          body: html`<div class="row wrap" style="gap:10px">${field('gross', 'المستحق (قبل الضريبة)', html`<input class="input num" name="gross" value="${p.gross}">`)}${field('tx', 'نسبة الضريبة %', html`<input class="input num" name="tx" value="${p.taxPct}">`)}</div>
            ${field('why', 'سبب التعديل (إجباري)', html`<input class="input" name="why">`)}
            <div class="muted" style="margin-top:8px;font-weight:600">${p.stage === 'approved' ? 'إذن الخزينة بيتعدّل بنفس المبلغ لحد ما يتصرف. ' : ''}التعديل متسجل باسمك وبسببه.</div>`,
          foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ التعديل</button>` });
        $('[data-ok]', mm.el).addEventListener('click', async () => {
          try { await api.put(`/finance/payouts/${p.id}`, { gross: Number(num($('[name=gross]', mm.el).value)), taxPct: Number(num($('[name=tx]', mm.el).value)), reason: $('[name=why]', mm.el).value }); mm.close(); toast('اتعدّل'); await load(); } catch (er) { toastError(er); }
        });
        return;
      }
      const v = e.target.closest('[data-void]');
      if (v) {
        const reason = await askReason({ title: 'إلغاء إذن الصرف', note: 'الإذن لسه ما اتصرفش من الخزينة. المستحق هيرجع يظهر في القايمة.' });
        if (!reason) return;
        await api.post(`/finance/payouts/${v.dataset.void}/void`, { reason });
        toast('اتلغى'); return await load();
      }
      const rel = e.target.closest('[data-rel]');
      if (rel) {
        const [doctorId, payerId] = rel.dataset.rel.split(':').map(Number);
        const r = await api.post('/finance/payouts/release', { doctorId, payerId });
        toast(`اتحرر ${r.released} بند. هيظهروا في مستحقات الصرف`); return await load();
      }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'print') return openPrint(`/print/payouts?period=${S.period}`, 'payouts');
      if (a === 'issue') {
        const rows = S.data.rows.filter((x) => S.sel.has(x.id));
        const net = rows.reduce((t, x) => t + HMS.money.toMinor(x.net), 0) / HMS.money.F;
        const mm = modal({
          title: `إصدار إذن صرف · ${S.data.periodName}`,
          body: html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>${S.data.approval ? 'هيتعمل مستحق لكل دكتور ومستني اعتماد المدير المالي، وبعدها يظهر عند الخزينة.' : 'هيتعمل إذن صرف نقدي لكل دكتور والخزينة تصرفه مباشرة (الاعتماد متوقف من الإعدادات).'} الصافي بعد ضريبة ${S.data.taxPct}%.</span></div>
            <div class="card" style="padding:4px 12px">${rows.map((x) => html`<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line-2)"><b>${x.name}</b><span class="spacer"></span><span class="muted num">${money(x.gross)} − ${money(x.tax)}</span><b class="num" style="min-width:90px;text-align:end">${money(x.net)} ${HMS.money.symbol}</b></div>`)}
            <div class="row" style="padding:10px 0"><b>الإجمالي</b><span class="spacer"></span><b class="num" style="font-size:18px">${money(net)} ${HMS.money.symbol}</b></div></div>
            <input class="input" name="note" placeholder="ملاحظة (اختياري)" style="margin-top:10px">`,
          foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok>${icon('cashbox')} إصدار ${rows.length} إذن</button>`,
        });
        $('[data-ok]', mm.el).addEventListener('click', async () => {
          try {
            const r = await api.post('/finance/payouts', { period: S.period, doctorIds: [...S.sel], note: $('[name=note]', mm.el).value });
            mm.close(); S.sel.clear(); toast(S.data.approval ? `اتعمل ${r.payouts.length} مستحق ومستنيين الاعتماد` : `اتعمل ${r.payouts.length} إذن صرف. الخزينة هتصرفهم`); await load();
          } catch (er) { toastError(er); }
        });
      }
      if (a === 'settings') {
        const st = await api.get('/finance/settings');
        const mm = modal({
          title: 'إعدادات صرف الدكاترة',
          body: html`<div class="row wrap" style="gap:10px">${field('taxPct', 'نسبة الضريبة %', html`<input class="input num" name="tax" value="${st.taxPct}">`)}${field('payoutDay', 'يوم الصرف من الشهر', html`<input class="input num" name="day" value="${st.payoutDay}">`)}</div>
            <label class="row" style="gap:8px;margin-top:12px;font-weight:700"><input type="checkbox" name="appr" ${st.approval ? 'checked' : ''}> محتاجة اعتماد المدير المالي قبل ما تظهر للخزينة</label>
            <div class="muted" style="margin-top:8px;font-weight:600">النسبة بتتخصم من مستحق الدكتور وقت الصرف. التغيير بيسري على الصرف الجاي بس.</div>`,
          foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} حفظ</button>`,
        });
        $('[data-ok]', mm.el).addEventListener('click', async () => {
          try { await api.put('/finance/settings', { taxPct: Number(num($('[name=tax]', mm.el).value)), payoutDay: Number(num($('[name=day]', mm.el).value)), approval: $('[name=appr]', mm.el).checked }); mm.close(); toast('اتحفظ'); await load(); } catch (er) { toastError(er); }
        });
      }
    } catch (er) { toastError(er); }
  };
  await load();
  return () => { pane.onclick = null; };
}

// ========================= الموردين =========================
async function suppliersPane(pane, query) {
  const S = { sel: Number(query.get('s')) || 0, list: [], d: null, f: '' };
  const canW = can('fin.supplier');
  const draw = () => {
    const totalBal = S.list.reduce((a, s) => a + HMS.money.toMinor(s.balance), 0) / HMS.money.F;
    const lateN = S.list.filter((s) => s.overdue).length;
    const list = S.list.filter((s) => !S.f || s.name.includes(S.f));
    pane.innerHTML = String(html`<div class="acc-kpis rep-kpis" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:12px">
        <div class="akpi late"><span class="gi">${icon('wallet')}</span><div><small>علينا للموردين</small><b class="num">${money(totalBal)} ${HMS.money.symbol}</b></div></div>
        <div class="akpi ${lateN ? 'danger' : 'ok'}"><span class="gi">${icon(lateN ? 'alert' : 'check')}</span><div><small>موردين متأخرين</small><b class="num">${lateN}</b></div></div>
        <div class="akpi"><span class="gi">${icon('box')}</span><div><small>عدد الموردين</small><b class="num">${S.list.length}</b></div></div></div>
      <div class="fin-split"><div class="fin-side"><div class="row" style="gap:8px;margin-bottom:10px"><input class="input" id="sf" type="search" placeholder="دوّر على مورد" value="${S.f}" style="flex:1">
          ${canW ? html`<button class="btn sm" data-a="sup-new">${icon('plus', 'sm')} مورد</button>` : ''}</div>
        <div class="fin-list">${list.map((s) => html`<button class="fin-item ${S.sel === s.id ? 'on' : ''}" data-s="${s.id}"><span class="cl-av">${initials(s.name)}</span><div><b>${s.name}</b><small>${s.nextDue ? `أقرب ميعاد ${dShort(s.nextDue)}` : 'مفيش مستحقات'}</small></div>
          <span class="fin-bal ${s.overdue ? 'late' : ''}"><b class="num">${money(s.balance)}</b>${s.overdue ? html`<small>متأخر</small>` : ''}</span></button>`)}
          ${!list.length ? html`<div class="muted" style="padding:14px;text-align:center">مفيش موردين</div>` : ''}</div></div>
        <div class="fin-main">${S.d ? supDetail() : empty('box', 'اختار مورد', 'هتشوف فواتيره ودفعاته وشيكاته')}</div></div>`);
  };
  const supDetail = () => {
    const d = S.d;
    return html`<div class="card pad"><div class="row wrap" style="gap:10px;align-items:center"><span class="cl-av lg">${initials(d.supplier.name)}</span><div style="min-width:0"><h3 style="margin:0">${d.supplier.name}</h3><small class="muted">${d.supplier.phone || ''}</small></div><span class="spacer"></span>
        ${canW ? html`<button class="btn ghost sm" data-a="sup-edit">${icon('edit', 'sm')}</button><button class="btn ghost sm" data-a="inv-new">${icon('plus', 'sm')} فاتورة</button><button class="btn sm" data-a="pay-new">${icon('cash', 'sm')} دفع</button>` : ''}</div>
      <div class="ledger-sum card" style="margin-top:12px;grid-template-columns:repeat(3,1fr)"><div><small>فواتير</small><b class="num">${money(d.totals.invoiced)}</b></div><div><small>اتدفع</small><b class="num" style="color:var(--ok)">${money(d.totals.paid)}</b></div><div><small>الباقي</small><b class="num" style="color:var(--danger)">${money(d.totals.balance)}</b></div></div></div>
      <h4 class="subh" style="margin-top:14px">${icon('file', 'sm')} الفواتير</h4>
      ${d.invoices.filter((i) => i.state !== 'void').length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>فاتورة المورد</th><th>التاريخ</th><th>الاستحقاق</th><th class="n">المبلغ</th><th class="n">الباقي</th><th></th></tr></thead><tbody>
        ${d.invoices.filter((i) => i.state !== 'void').map((i) => html`<tr><td class="num">${i.no}</td><td>${i.docNo || '—'}</td><td>${dFmt(i.docDate)}</td>
          <td>${i.dueDate ? dFmt(i.dueDate) : '—'} ${i.overdue ? html`<span class="badge danger">متأخرة</span>` : ''}</td><td class="n num">${money(i.amount)}</td>
          <td class="n num">${i.state === 'paid' ? html`<span class="badge ok">${icon('check', 'sm')} اتسددت</span>` : html`<b>${money(i.left)}</b>`}</td>
          <td>${canW && i.state !== 'paid' ? html`<button class="btn ghost sm" data-payinv="${i.id}">دفع</button>` : ''}${canW && i.state === 'open' ? html`<button class="btn ghost sm" data-voidinv="${i.id}" title="إلغاء">${icon('trash', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div></div>` : html`<div class="muted" style="padding:10px">مفيش فواتير</div>`}
      <h4 class="subh" style="margin-top:14px">${icon('cash', 'sm')} الدفعات</h4>
      ${d.payments.length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>التاريخ</th><th>الطريقة</th><th>على فاتورة</th><th class="n">المبلغ</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${d.payments.map((p) => html`<tr style="${p.status === 'void' ? 'opacity:.5' : ''}"><td>${dFmt(p.date)}</td><td>${p.methodName}${p.chequeNo ? html` <span class="num">${p.chequeNo}</span>` : ''}${p.chequeDate ? html`<br><small class="muted">استحقاق ${dFmt(p.chequeDate)}${p.bank ? ' · ' + p.bank : ''}</small>` : ''}</td><td>${p.docNo || (p.invoiceId ? p.invNo : 'على الحساب')}</td><td class="n num"><b>${money(p.amount)}</b></td>
          <td>${p.status === 'void' ? html`<span class="badge">اتلغت</span>` : p.method === 'cheque' ? (p.cleared ? html`<span class="badge ok">اتصرف</span>` : html`<span class="badge warn">شيك مستحق</span>`) : p.method === 'cash' ? (p.voucherStatus === 'paid' ? html`<span class="badge ok">اتصرف</span>` : html`<span class="badge warn">مستني الخزينة · ${p.voucherNo}</span>`) : html`<span class="badge ok">اتحوّل</span>`}</td>
          <td>${canW && p.status === 'ok' && !p.cleared && p.voucherStatus !== 'paid' ? html`<button class="btn ghost sm" data-voidpay="${p.id}" title="إلغاء">${icon('trash', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div></div>` : html`<div class="muted" style="padding:10px">مفيش دفعات</div>`}`;
  };
  const loadList = async () => { S.list = (await api.get('/finance/suppliers')).suppliers; };
  const loadOne = async () => { S.d = S.sel ? await api.get(`/finance/suppliers/${S.sel}`) : null; };
  const reload = async () => { await loadList(); await loadOne(); draw(); };

  const supForm = (s) => {
    const m = modal({
      title: s ? 'تعديل المورد' : 'مورد جديد',
      body: html`${field('name', 'اسم المورد', html`<input class="input" name="name" value="${s?.name || ''}" autofocus>`, { flex: '1 1 100%' })}
        <div class="row wrap" style="gap:10px;margin-top:10px">${field('phone', 'التليفون', html`<input class="input num" name="phone" value="${s?.phone || ''}">`)}${field('note', 'ملاحظة', html`<input class="input" name="note" value="${s?.note || ''}">`)}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} حفظ</button>`,
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      const b = { name: $('[name=name]', m.el).value, phone: $('[name=phone]', m.el).value, note: $('[name=note]', m.el).value };
      try { const r = s ? await api.put(`/finance/suppliers/${s.id}`, b) : await api.post('/finance/suppliers', b); m.close(); if (!s) S.sel = r.id; toast('اتحفظ'); await reload(); } catch (er) { showErrs(m, er); }
    });
  };
  const invForm = async () => {
    const un = (await api.get('/finance/purchases/unbilled')).purchases;
    const m = modal({
      title: `فاتورة جديدة · ${S.d.supplier.name}`,
      body: html`${un.length ? html`<div class="field"><label>من استلام مخزن <span class="hint">اختياري، بيملّي البيانات</span></label><select class="select" name="pu"><option value="">فاتورة من غير استلام</option>${un.map((p) => html`<option value="${p.id}">استلام ${p.no} · ${p.supplier || '—'} · ${money(p.total)} ${HMS.money.symbol}</option>`)}</select></div>` : ''}
        <div class="row wrap" style="gap:10px;margin-top:10px">${field('docNo', 'رقم فاتورة المورد', html`<input class="input num" name="docNo">`)}${field('amount', 'المبلغ', html`<input class="input num" name="amount" style="font-size:20px;font-weight:800;height:50px">`)}</div>
        <div class="row wrap" style="gap:10px;margin-top:10px">${field('docDate', 'تاريخ الفاتورة', html`<input class="input" type="date" name="docDate" value="${todayStr()}">`)}${field('dueDate', 'ميعاد السداد', html`<input class="input" type="date" name="dueDate">`)}</div>
        <input class="input" name="note" placeholder="ملاحظة (اختياري)" style="margin-top:10px">`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} سجّل الفاتورة</button>`,
    });
    $('[name=pu]', m.el)?.addEventListener('change', (e) => {
      const p = un.find((x) => String(x.id) === e.target.value);
      if (p) { $('[name=docNo]', m.el).value = p.docNo || ''; $('[name=amount]', m.el).value = p.total; $('[name=docDate]', m.el).value = p.docDate; }
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      try {
        await api.post('/finance/invoices', { supplierId: S.sel, purchaseId: $('[name=pu]', m.el)?.value || null, docNo: $('[name=docNo]', m.el).value, amount: num($('[name=amount]', m.el).value),
          docDate: $('[name=docDate]', m.el).value, dueDate: $('[name=dueDate]', m.el).value || '', note: $('[name=note]', m.el).value });
        m.close(); toast('اتسجلت الفاتورة'); await reload();
      } catch (er) { showErrs(m, er); }
    });
  };
  const payForm = (invoiceId) => {
    const open = S.d.invoices.filter((i) => i.state !== 'paid' && i.state !== 'void');
    const inv = open.find((i) => i.id === invoiceId);
    const m = modal({
      title: `دفع لـ ${S.d.supplier.name}`,
      body: html`<div class="field"><label>على فاتورة</label><select class="select" name="inv"><option value="">على الحساب (من غير فاتورة)</option>${open.map((i) => html`<option value="${i.id}" ${i.id === invoiceId ? 'selected' : ''}>${i.docNo || 'فاتورة ' + i.no} · الباقي ${money(i.left)} ${HMS.money.symbol}</option>`)}</select></div>
        <div class="seg full" style="margin:12px 0" id="pm">${['bank', 'cheque', 'cash'].map((k, i) => html`<button type="button" data-pm="${k}" class="${i === 0 ? 'on' : ''}">${icon(k === 'bank' ? 'card' : k === 'cheque' ? 'file' : 'cash', 'sm')} ${M_NAME[k]}</button>`)}</div>
        <div class="row wrap" style="gap:10px">${field('amount', 'المبلغ', html`<input class="input num" name="amt" value="${inv ? inv.left : ''}" style="font-size:20px;font-weight:800;height:50px">`)}${field('payDate', 'تاريخ الدفع', html`<input class="input" type="date" name="pd" value="${todayStr()}">`)}</div>
        <div id="chq" class="hide"><div class="row wrap" style="gap:10px;margin-top:10px">${field('chequeNo', 'رقم الشيك', html`<input class="input num" name="cno">`)}${field('chequeDate', 'تاريخ استحقاق الشيك', html`<input class="input" type="date" name="cd" value="${todayStr()}">`)}${field('bank', 'البنك', html`<input class="input" name="bank">`)}</div></div>
        <div id="cashnote" class="alertbar info hide" style="margin-top:10px">${icon('info')}<span>هيتعمل إذن صرف والخزينة هي اللي تصرف الفلوس.</span></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} سجّل الدفع</button>`,
    });
    let method = 'bank';
    $('#pm', m.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pm]'); if (!b) return;
      method = b.dataset.pm; $$('#pm button', m.el).forEach((x) => x.classList.toggle('on', x === b));
      $('#chq', m.el).classList.toggle('hide', method !== 'cheque'); $('#cashnote', m.el).classList.toggle('hide', method !== 'cash');
    });
    $('[name=inv]', m.el).addEventListener('change', (e) => { const i = open.find((x) => String(x.id) === e.target.value); if (i) $('[name=amt]', m.el).value = i.left; });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      try {
        await api.post('/finance/payments', { supplierId: S.sel, invoiceId: $('[name=inv]', m.el).value || null, method, amount: num($('[name=amt]', m.el).value), payDate: $('[name=pd]', m.el).value,
          chequeNo: $('[name=cno]', m.el).value, chequeDate: $('[name=cd]', m.el).value, bank: $('[name=bank]', m.el).value });
        m.close(); toast(method === 'cash' ? 'اتعمل إذن صرف للخزينة' : 'اتسجل الدفع'); await reload();
      } catch (er) { showErrs(m, er); }
    });
  };
  pane.onclick = async (e) => {
    try {
      const s = e.target.closest('[data-s]');
      if (s) { S.sel = Number(s.dataset.s); history.replaceState(null, '', `#/finance?tab=suppliers&s=${S.sel}`); await loadOne(); return draw(); }
      const vi = e.target.closest('[data-voidinv]');
      if (vi) { const reason = await askReason({ title: 'إلغاء الفاتورة' }); if (!reason) return; await api.post(`/finance/invoices/${vi.dataset.voidinv}/void`, { reason }); toast('اتلغت'); return await reload(); }
      const vp = e.target.closest('[data-voidpay]');
      if (vp) { const reason = await askReason({ title: 'إلغاء الدفعة' }); if (!reason) return; await api.post(`/finance/payments/${vp.dataset.voidpay}/void`, { reason }); toast('اتلغت'); return await reload(); }
      const pi = e.target.closest('[data-payinv]');
      if (pi) return payForm(Number(pi.dataset.payinv));
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'sup-new') return supForm(null);
      if (a === 'sup-edit') return supForm(S.d.supplier);
      if (a === 'inv-new') return await invForm();
      if (a === 'pay-new') return payForm(0);
    } catch (er) { toastError(er); }
  };
  pane.oninput = (e) => { if (e.target.id === 'sf') { S.f = e.target.value; const pos = e.target.selectionStart; draw(); const i = $('#sf', pane); i.focus(); i.setSelectionRange(pos, pos); } };
  await reload();
  return () => { pane.onclick = null; pane.oninput = null; };
}

// ========================= المصروفات =========================
async function expensesPane(pane) {
  const S = { period: thisPeriod(), d: null, cats: [], f: 'all' };
  const canW = can('fin.expense');
  const range = () => { const [y, m] = S.period.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return [`${S.period}-01`, `${S.period}-${String(last).padStart(2, '0')}`]; };
  const draw = () => {
    const d = S.d;
    const rows = d.expenses.filter((x) => S.f === 'all' || x.status === S.f);
    const max = Math.max(...d.byCategory.map((c) => c.amount), 1);
    pane.innerHTML = String(html`${monthBar(S, html`<a class="btn ghost sm" href="/api/finance/expenses/export?from=${d.from}&to=${d.to}">${icon('download', 'sm')} إكسل</a>${canW ? html`<button class="btn sm" data-a="new">${icon('plus', 'sm')} مصروف جديد</button>` : ''}`)}
      ${d.pending && d.canApprove ? html`<div class="alertbar warn" style="margin-bottom:12px">${icon('alert')}<span><b>${d.pending}</b> مصروف مستني موافقتك</span><button class="btn sm" data-f="pending" style="margin-inline-start:auto">اعرضهم</button></div>`
        : d.pending ? html`<div class="alertbar info" style="margin-bottom:12px">${icon('hourglass')}<span>${d.pending} مصروف مستني موافقة المدير</span></div>` : ''}
      <div class="rep-grid"><div>
        <div class="seg scroll" style="margin-bottom:10px">${[['all', 'الكل'], ['pending', 'مستني موافقة'], ['approved', 'معتمد'], ['rejected', 'مرفوض']].map(([k, n]) => html`<button data-f="${k}" class="${S.f === k ? 'on' : ''}">${n}</button>`)}</div>
        ${rows.length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>التاريخ</th><th>البند</th><th>لمين</th><th class="n">المبلغ</th><th>الحالة</th><th></th></tr></thead><tbody>
          ${rows.map((x) => html`<tr style="${x.status === 'void' || x.status === 'rejected' ? 'opacity:.6' : ''}"><td class="num">${x.no}</td><td>${dShort(x.date)}</td><td><b>${x.category}</b>${x.note ? html`<br><small class="muted">${x.note}</small>` : ''}</td><td style="min-width:120px">${x.payee || '—'}<br><small class="muted">${x.method === 'cash' ? 'نقدي' : 'بنك'}</small></td>
            <td class="n num"><b>${money(x.amount)}</b></td>
            <td><span class="badge ${ST_EXP[x.status][1]}">${ST_EXP[x.status][0]}</span>${x.voucherNo ? html`<br><small class="muted">${x.voucherStatus === 'paid' ? 'اتصرف' : 'إذن ' + x.voucherNo + ' · مستني الخزينة'}</small>` : ''}${x.rejectReason ? html`<br><small class="muted">${x.rejectReason}</small>` : ''}</td>
            <td style="white-space:nowrap">${x.status === 'pending' && d.canApprove ? html`<button class="btn sm" data-ok="${x.id}" style="--c:var(--ok)">${icon('check', 'sm')}</button> <button class="btn ghost sm" data-no="${x.id}">${icon('x', 'sm')}</button>` : ''}
              ${canW && (x.status === 'pending' || x.status === 'approved') && x.voucherStatus !== 'paid' ? html`<button class="btn ghost sm" data-void="${x.id}" title="إلغاء">${icon('trash', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div></div>`
          : empty('receipt', 'مفيش مصروفات', 'دوس «مصروف جديد» عشان تسجل')}</div>
        <div class="card pad"><div class="row" style="margin-bottom:8px"><b>إجمالي المصروفات المعتمدة</b><span class="spacer"></span><b class="num" style="font-size:20px">${money(d.total)} ${HMS.money.symbol}</b></div>
          ${d.byCategory.map((c) => html`<div class="fin-bar"><span>${c.name}</span><i style="--w:${Math.round((c.amount / max) * 100)}%"></i><b class="num">${money(c.amount)}</b></div>`)}
          ${!d.byCategory.length ? html`<div class="muted">مفيش مصروفات معتمدة</div>` : ''}</div></div>`);
  };
  const load = async () => {
    const [from, to] = range();
    S.d = await api.get(`/finance/expenses?from=${from}&to=${to}`);
    if (!S.cats.length) S.cats = (await api.get('/finance/expense-categories')).categories;
    draw();
  };
  const form = () => {
    const direct = S.d.direct || S.d.canApprove;
    const m = modal({
      title: 'مصروف جديد',
      body: html`<div class="row wrap" style="gap:10px">${field('categoryId', 'البند', html`<select class="select" name="cat"><option value="">اختار البند</option>${S.cats.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>`)}
          ${field('amount', 'المبلغ', html`<input class="input num" name="amt" style="font-size:20px;font-weight:800;height:50px" autofocus>`)}</div>
        <div class="seg full" style="margin:12px 0" id="mm"><button type="button" data-mm="cash" class="on">${icon('cash', 'sm')} نقدي من الخزينة</button><button type="button" data-mm="bank">${icon('card', 'sm')} من البنك</button></div>
        <div class="row wrap" style="gap:10px">${field('payee', 'لمين', html`<input class="input" name="payee" placeholder="اسم المستلم أو الجهة">`)}${field('date', 'التاريخ', html`<input class="input" type="date" name="dt" value="${todayStr()}">`)}</div>
        <input class="input" name="note" placeholder="ملاحظة / رقم الفاتورة" style="margin-top:10px">
        <div class="alertbar ${direct ? 'info' : 'warn'}" style="margin-top:12px">${icon(direct ? 'check' : 'hourglass')}<span>${direct ? 'هيتسجل مباشرة، والنقدي بيتعمل له إذن صرف للخزينة.' : 'هيتبعت للمدير للموافقة قبل ما يتصرف.'}</span></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} سجّل</button>`,
    });
    let method = 'cash';
    $('#mm', m.el).addEventListener('click', (e) => { const b = e.target.closest('[data-mm]'); if (!b) return; method = b.dataset.mm; $$('#mm button', m.el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      try {
        const r = await api.post('/finance/expenses', { categoryId: $('[name=cat]', m.el).value, amount: num($('[name=amt]', m.el).value), method, payee: $('[name=payee]', m.el).value, date: $('[name=dt]', m.el).value, note: $('[name=note]', m.el).value });
        m.close(); toast(r.status === 'pending' ? 'اتبعت للمدير للموافقة' : 'اتسجل المصروف'); await load();
      } catch (er) { showErrs(m, er); }
    });
  };
  pane.onclick = async (e) => {
    try {
      const mo = e.target.closest('[data-m]');
      if (mo) { S.period = shiftP(S.period, Number(mo.dataset.m)); return await load(); }
      const f = e.target.closest('[data-f]'); if (f) { S.f = f.dataset.f; return draw(); }
      const ok = e.target.closest('[data-ok]');
      if (ok) { await api.post(`/finance/expenses/${ok.dataset.ok}/decide`, { approve: true }); toast('اتعتمد'); return await load(); }
      const no = e.target.closest('[data-no]');
      if (no) { const reason = await askReason({ title: 'رفض المصروف', confirm: 'ارفض' }); if (!reason) return; await api.post(`/finance/expenses/${no.dataset.no}/decide`, { approve: false, reason }); toast('اترفض'); return await load(); }
      const vo = e.target.closest('[data-void]');
      if (vo) { const reason = await askReason({ title: 'إلغاء المصروف' }); if (!reason) return; await api.post(`/finance/expenses/${vo.dataset.void}/void`, { reason }); toast('اتلغى'); return await load(); }
      if (e.target.closest('[data-a="new"]')) return form();
    } catch (er) { toastError(er); }
  };
  await load();
  return () => { pane.onclick = null; };
}

// ========================= الأقساط =========================
async function installmentsPane(pane) {
  const S = { list: [], open: 0, d: null };
  const canW = can('fin.oblig');
  const draw = () => {
    const tot = S.list.reduce((a, o) => ({ left: a.left + HMS.money.toMinor(o.left), late: a.late + (o.overdue ? 1 : 0) }), { left: 0, late: 0 });
    pane.innerHTML = String(html`<div class="row" style="margin-bottom:12px;gap:10px;flex-wrap:wrap"><div class="acc-kpis rep-kpis" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));flex:1;margin:0">
        <div class="akpi late"><span class="gi">${icon('wallet')}</span><div><small>باقي علينا</small><b class="num">${money(tot.left / HMS.money.F)} ${HMS.money.symbol}</b></div></div>
        <div class="akpi ${tot.late ? 'danger' : 'ok'}"><span class="gi">${icon(tot.late ? 'alert' : 'check')}</span><div><small>التزامات متأخرة</small><b class="num">${tot.late}</b></div></div></div>
      ${canW ? html`<button class="btn" data-a="new">${icon('plus')} التزام جديد</button>` : ''}</div>
      ${!S.list.length ? empty('calendar', 'مفيش أقساط', 'سجّل جهاز أو قرض أو مورد مقسّط وهيتعمل جدول الأقساط') : html`<div class="fin-cards">${S.list.map((o) => {
        const pct = o.count ? Math.round((o.paidCount / o.count) * 100) : 0;
        return html`<button class="card pad fin-ob" data-o="${o.id}"><div class="row" style="gap:10px"><span class="gi-lg">${icon('calendar')}</span><div style="min-width:0;text-align:start"><b>${o.name}</b><small class="muted" style="display:block">${o.party || ''}</small></div>
          ${o.overdue ? html`<span class="badge danger" style="margin-inline-start:auto">متأخر</span>` : ''}</div>
          <div class="cl-prog" style="margin:12px 0 8px"><i class="ok" style="width:${pct}%"></i></div>
          <div class="row"><small class="muted">${o.paidCount} من ${o.count} قسط</small><span class="spacer"></span><small class="muted">الباقي</small> <b class="num">${money(o.left)} ${HMS.money.symbol}</b></div>
          <small class="muted" style="display:block;margin-top:4px">${o.nextDue ? `القسط الجاي ${dFmt(o.nextDue)}` : 'اتسددت كلها'}</small></button>`; })}</div>`}`);
  };
  const load = async () => { S.list = (await api.get('/finance/obligations')).obligations; draw(); };
  const detail = async (id) => {
    const d = await api.get(`/finance/obligations/${id}`);
    const m = modal({
      title: d.obligation.name, wide: true,
      body: html`<div class="muted" style="margin-bottom:10px">${d.obligation.party || ''} ${d.obligation.note ? '· ' + d.obligation.note : ''}</div>
        <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>الاستحقاق</th><th class="n">القسط</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${d.installments.map((n) => html`<tr><td class="num">${n.no}</td><td>${dFmt(n.dueDate)}${n.overdue ? html` <span class="badge danger">متأخر</span>` : ''}</td><td class="n num"><b>${money(n.amount)}</b></td>
          <td>${n.status === 'paid' ? html`<span class="badge ok">${icon('check', 'sm')} اتدفع</span> <small class="muted">${M_NAME[n.method] || ''}${n.chequeNo ? ' ' + n.chequeNo : ''}${n.method === 'cheque' && !n.cleared ? ' · لسه ما اتصرفش' : ''}</small>` : '<span class="badge warn">مستني</span>'}</td>
          <td style="white-space:nowrap">${canW && n.status === 'due' ? html`<button class="btn sm" data-pay="${n.id}">دفع</button> <button class="btn ghost sm" data-edit="${n.id}" title="تعديل">${icon('edit', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div></div>`,
      foot: html`${canW && !d.installments.some((n) => n.status === 'paid') ? html`<button class="btn ghost" data-del style="color:var(--danger)">${icon('trash')} مسح الالتزام</button>` : ''}<span class="spacer"></span><button class="btn ghost" data-close>قفل</button>`,
    });
    m.el.addEventListener('click', async (e) => {
      try {
        const p = e.target.closest('[data-pay]');
        if (p) { const n = d.installments.find((x) => x.id === Number(p.dataset.pay)); m.close(); return payInst(n, id); }
        const ed = e.target.closest('[data-edit]');
        if (ed) { const n = d.installments.find((x) => x.id === Number(ed.dataset.edit)); m.close(); return editInst(n, id); }
        if (e.target.closest('[data-del]')) {
          const reason = await askReason({ title: 'مسح الالتزام', note: 'مفيش أقساط اتدفعت، هيتمسح الجدول كله.' }); if (!reason) return;
          await api.del(`/finance/obligations/${id}`); m.close(); toast('اتمسح'); await load();
        }
      } catch (er) { toastError(er); }
    });
  };
  const payInst = (n, oid) => {
    let method = 'bank';
    const m = modal({
      title: `دفع القسط ${n.no} · ${money(n.amount)} ${HMS.money.symbol}`,
      body: html`<div class="seg full" id="pm">${['bank', 'cheque', 'cash'].map((k, i) => html`<button type="button" data-pm="${k}" class="${i === 0 ? 'on' : ''}">${M_NAME[k]}</button>`)}</div>
        <div id="chq" class="hide" style="margin-top:10px">${field('chequeNo', 'رقم الشيك', html`<input class="input num" name="cno">`)}</div>
        <div id="cashnote" class="alertbar info hide" style="margin-top:10px">${icon('info')}<span>هيتعمل إذن صرف والخزينة هي اللي تصرف الفلوس.</span></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} سجّل الدفع</button>`,
    });
    $('#pm', m.el).addEventListener('click', (e) => { const b = e.target.closest('[data-pm]'); if (!b) return; method = b.dataset.pm; $$('#pm button', m.el).forEach((x) => x.classList.toggle('on', x === b)); $('#chq', m.el).classList.toggle('hide', method !== 'cheque'); $('#cashnote', m.el).classList.toggle('hide', method !== 'cash'); });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      try { await api.post(`/finance/installments/${n.id}/pay`, { method, chequeNo: $('[name=cno]', m.el).value }); m.close(); toast('اتسجل'); await load(); await detail(oid); } catch (er) { showErrs(m, er); }
    });
  };
  const editInst = (n, oid) => {
    const m = modal({
      title: `تعديل القسط ${n.no}`,
      body: html`<div class="row wrap" style="gap:10px">${field('dueDate', 'الاستحقاق', html`<input class="input" type="date" name="dt" value="${n.dueDate}">`)}${field('amount', 'القيمة', html`<input class="input num" name="amt" value="${n.amount}">`)}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} حفظ</button>`,
    });
    $('[data-ok]', m.el).addEventListener('click', async () => { clearErrs(m); try { await api.put(`/finance/installments/${n.id}`, { dueDate: $('[name=dt]', m.el).value, amount: num($('[name=amt]', m.el).value) }); m.close(); await load(); await detail(oid); } catch (er) { showErrs(m, er); } });
  };
  const form = () => {
    const m = modal({
      title: 'التزام جديد (أقساط علينا)',
      body: html`<div class="row wrap" style="gap:10px">${field('name', 'اسم الالتزام', html`<input class="input" name="name" placeholder="مثال: جهاز أشعة مقطعية" autofocus>`, { flex: '1 1 100%' })}</div>
        <div class="row wrap" style="gap:10px;margin-top:10px">${field('party', 'الجهة / الشركة', html`<input class="input" name="party">`)}${field('total', 'الإجمالي', html`<input class="input num" name="total">`)}</div>
        <div class="row wrap" style="gap:10px;margin-top:10px">${field('count', 'عدد الأقساط', html`<input class="input num" name="count" value="12">`)}${field('firstDue', 'ميعاد أول قسط', html`<input class="input" type="date" name="first" value="${todayStr()}">`)}</div>
        <div class="muted" style="margin-top:8px;font-weight:600">هيتقسم بالتساوي شهري، وتقدر تعدّل أي قسط بعد كده.</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} اعمل الجدول</button>`,
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      clearErrs(m);
      try {
        const r = await api.post('/finance/obligations', { name: $('[name=name]', m.el).value, party: $('[name=party]', m.el).value, total: num($('[name=total]', m.el).value), count: Number(num($('[name=count]', m.el).value)), firstDue: $('[name=first]', m.el).value });
        m.close(); toast('اتعمل الجدول'); await load(); await detail(r.id);
      } catch (er) { showErrs(m, er); }
    });
  };
  pane.onclick = (e) => {
    const o = e.target.closest('[data-o]'); if (o) return detail(Number(o.dataset.o)).catch(toastError);
    if (e.target.closest('[data-a="new"]')) form();
  };
  await load();
  return () => { pane.onclick = null; };
}

// ========================= الشيكات =========================
async function chequesPane(pane) {
  const S = { state: 'due', d: null };
  const canW = can('fin.supplier') || can('fin.oblig');
  const draw = () => {
    const d = S.d;
    pane.innerHTML = String(html`<div class="row" style="margin-bottom:12px;gap:10px;flex-wrap:wrap"><div class="seg"><button data-st="due" class="${S.state === 'due' ? 'on' : ''}">${icon('hourglass', 'sm')} مستحقة</button><button data-st="cleared" class="${S.state === 'cleared' ? 'on' : ''}">${icon('check', 'sm')} اتصرفت</button></div>
        <span class="spacer"></span><span class="badge py" style="font-size:14px">الإجمالي <b class="num">${money(d.total)}</b> ${HMS.money.symbol}</span></div>
      ${d.cheques.length ? html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>الاستحقاق</th><th>رقم الشيك</th><th>لمين</th><th>البنك</th><th class="n">المبلغ</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${d.cheques.map((c) => html`<tr><td><b>${dFmt(c.date)}</b></td><td class="num">${c.no}</td><td>${c.payee}${c.desc ? html`<br><small class="muted">${c.desc}</small>` : ''}</td><td>${c.bank || '—'}</td><td class="n num"><b>${money(c.amount)}</b></td>
          <td>${c.cleared ? html`<span class="badge ok">اتصرف</span>` : c.overdue ? html`<span class="badge danger">${icon('alert', 'sm')} استحق من ${Math.abs(daysTo(c.date))} يوم</span>` : c.soon ? html`<span class="badge warn">بعد ${daysTo(c.date)} يوم</span>` : html`<span class="badge">بعد ${daysTo(c.date)} يوم</span>`}</td>
          <td>${canW && !c.cleared ? html`<button class="btn ghost sm" data-clear="${c.type}:${c.id}">${icon('check', 'sm')} اتصرف من البنك</button>` : ''}</td></tr>`)}</tbody></table></div></div>`
        : empty('cash', S.state === 'due' ? 'مفيش شيكات مستحقة' : 'مفيش شيكات اتصرفت')}`);
  };
  const load = async () => { S.d = await api.get(`/finance/cheques?state=${S.state}`); draw(); };
  pane.onclick = async (e) => {
    try {
      const s = e.target.closest('[data-st]'); if (s) { S.state = s.dataset.st; return await load(); }
      const c = e.target.closest('[data-clear]');
      if (c) { const [type, id] = c.dataset.clear.split(':'); await api.post('/finance/cheques/clear', { type, id: Number(id) }); toast('اتسجل إن الشيك اتصرف'); await load(); }
    } catch (er) { toastError(er); }
  };
  await load();
  return () => { pane.onclick = null; };
}

// ========================= إذون الصرف النقدي =========================
async function vouchersPane(pane) {
  const S = { st: 'pending', d: null };
  const canPay = can('fin.voucher');
  const draw = () => {
    const d = S.d;
    pane.innerHTML = String(html`<div class="row" style="margin-bottom:12px;gap:10px;flex-wrap:wrap"><div class="seg">${[['pending', 'مستنية', 'hourglass'], ['paid', 'اتصرفت', 'check'], ['cancelled', 'اتلغت', 'x']].map(([k, n, ic]) => html`<button data-st="${k}" class="${S.st === k ? 'on' : ''}">${icon(ic, 'sm')} ${n}</button>`)}</div>
        <span class="spacer"></span>${S.st === 'pending' && d.vouchers.length ? html`<span class="badge py" style="font-size:14px">${d.vouchers.length} إذن · <b class="num">${money(d.total)}</b> ${HMS.money.symbol}</span>` : ''}</div>
      ${canPay && S.st === 'pending' && d.vouchers.length ? html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>لما تصرف الفلوس دوس «صرفت». المبلغ بيتخصم من درج ورديتك وبيطلع في تقفيل الوردية.</span></div>` : ''}
      ${d.vouchers.length ? html`<div class="fin-cards">${d.vouchers.map((v) => html`<div class="card pad fin-vo"><div class="row" style="gap:8px"><span class="badge ${KIND_CLS[v.kind]}">${v.kindName}</span><small class="muted">إذن ${v.no}</small><span class="spacer"></span><small class="muted">${fmtWhen(v.at)}</small></div>
        <div style="margin:10px 0 4px"><b style="font-size:16px">${v.payee}</b><small class="muted" style="display:block">${v.description}</small></div>
        <div class="row" style="align-items:center"><b class="num" style="font-size:24px">${money(v.amount)}</b> <span style="margin-inline-start:4px">${HMS.money.symbol}</span><span class="spacer"></span>
          ${v.status === 'pending' ? html`${(canPay || can('fin.payout')) ? html`<button class="btn ghost sm" data-cancel="${v.id}">إلغاء</button>` : ''}${canPay ? html`<button class="btn" data-pay="${v.id}" style="--c:var(--ok)">${icon('cash')} صرفت</button>` : ''}`
            : v.status === 'paid' ? html`<span class="badge ok">${icon('check', 'sm')} اتصرف ${fmtWhen(v.paidAt)} · ${v.paidBy}</span>` : html`<span class="badge">${v.cancelReason || 'اتلغى'}</span>`}</div></div>`)}</div>`
        : empty('cashbox', S.st === 'pending' ? 'مفيش إذون صرف مستنية' : 'مفيش إذون هنا')}`);
  };
  const load = async () => { S.d = await api.get(`/finance/vouchers?status=${S.st}`); draw(); };
  pane.onclick = async (e) => {
    try {
      const s = e.target.closest('[data-st]'); if (s) { S.st = s.dataset.st; return await load(); }
      const p = e.target.closest('[data-pay]');
      if (p) { const v = S.d.vouchers.find((x) => x.id === Number(p.dataset.pay)); await api.post(`/finance/vouchers/${v.id}/pay`); toast(`اتصرف ${money(v.amount)} ${HMS.money.symbol} لـ ${v.payee}`); window.refreshShell?.(); return await load(); }
      const c = e.target.closest('[data-cancel]');
      if (c) { const reason = await askReason({ title: 'إلغاء إذن الصرف', note: 'المصدر (مستحقات / مصروف / دفعة) هيرجع لحالته.' }); if (!reason) return; await api.post(`/finance/vouchers/${c.dataset.cancel}/cancel`, { reason }); toast('اتلغى'); await load(); }
    } catch (er) { toastError(er); }
  };
  await load();
  const t = setInterval(() => { if (S.st === 'pending' && document.contains(pane)) load().catch(() => {}); }, 20000);
  return () => { pane.onclick = null; clearInterval(t); };
}

// ========================= شاشة المدير =========================
export async function renderManagerDash(view, { setTitle }) {
  setTitle('الملخص المالي', 'إيراد · مصروفات · شيكات · أقساط · مستردات');
  const S = { month: store.get('dashMonth') || thisPeriod() };
  const draw = (d) => {
    const maxDay = Math.max(...d.series.map((x) => Math.max(x.revenue, x.expenses)), 1);
    const expMax = Math.max(d.expenses.general, d.expenses.suppliers, d.expenses.doctors, d.expenses.installments, 1);
    const good = d.result >= 0;
    view.innerHTML = String(html`${monthBar({ period: d.month }, html`<a class="btn ghost sm" href="#/finance?tab=expenses">${icon('receipt', 'sm')} الحسابات العامة</a>`)}
      <div class="dash-hero ${good ? 'good' : 'bad'}"><div><small>صافي ${d.monthName}</small><b class="num">${good ? '' : '−'}${money(Math.abs(d.result))} <i>ج</i></b></div>
        <div class="dh-eq"><span>إيراد <b class="num">${money(d.revenue.net)}</b></span><em>−</em><span>مصروفات <b class="num">${money(d.expenses.total)}</b></span></div></div>
      <div class="dash-kpis">
        <a class="dk k-rev" href="#/reports"><span class="gi">${icon('wallet')}</span><div><small>الإيراد المحصّل</small><b class="num">${money(d.revenue.collected)}</b><em>آجل ${money(d.revenue.credit)} ${HMS.money.symbol}</em></div></a>
        <a class="dk k-exp" href="#/finance?tab=expenses"><span class="gi">${icon('receipt')}</span><div><small>المصروفات</small><b class="num">${money(d.expenses.total)}</b><em>${d.alerts.pendingExpenses ? `${d.alerts.pendingExpenses} مستني موافقتك` : 'كلها معتمدة'}</em></div></a>
        <a class="dk k-chq ${d.cheques.overdue ? 'late' : ''}" href="#/finance?tab=cheques"><span class="gi">${icon('cash')}</span><div><small>شيكات مستحقة</small><b class="num">${money(d.cheques.total)}</b><em>${d.cheques.count} شيك${d.cheques.soon + d.cheques.overdue ? ` · ${d.cheques.soon + d.cheques.overdue} قريب أو متأخر` : ''}</em></div></a>
        <a class="dk k-ins ${d.installments.late ? 'late' : ''}" href="#/finance?tab=installments"><span class="gi">${icon('calendar')}</span><div><small>أقساط الشهر</small><b class="num">${money(d.installments.monthTotal)}</b><em>${d.installments.late ? `${d.installments.late} متأخر (${money(d.installments.lateTotal)} ${HMS.money.symbol})` : `${d.installments.monthCount} قسط`}</em></div></a>
        <a class="dk k-ref" href="#/receipts"><span class="gi">${icon('undo')}</span><div><small>المستردات</small><b class="num">${money(d.revenue.refunds)}</b><em>${d.refunds.count} مرتجع للمرضى</em></div></a></div>
      ${(d.alerts.pendingVouchers || d.alerts.lateInvoices || d.alerts.pendingExpenses) ? html`<div class="dash-alerts">
        ${d.alerts.pendingExpenses ? html`<a class="badge warn" href="#/finance?tab=expenses">${icon('hourglass', 'sm')} ${d.alerts.pendingExpenses} مصروف مستني موافقتك · ${money(d.alerts.pendingExpensesTotal)} ${HMS.money.symbol}</a>` : ''}
        ${d.alerts.pendingVouchers ? html`<a class="badge py" href="#/finance?tab=vouchers">${icon('cashbox', 'sm')} ${d.alerts.pendingVouchers} إذن صرف عند الخزينة · ${money(d.alerts.pendingVouchersTotal)} ${HMS.money.symbol}</a>` : ''}
        ${d.alerts.lateInvoices ? html`<a class="badge danger" href="#/finance?tab=suppliers">${icon('alert', 'sm')} ${d.alerts.lateInvoices} فاتورة مورد متأخرة · ${money(d.alerts.lateInvoicesTotal)} ${HMS.money.symbol}</a>` : ''}</div>` : ''}
      <div class="rep-grid" style="margin-top:14px"><div class="card pad"><h3>${icon('chart')} يوم بيوم <span class="muted">إيراد (محصّل − مرتجع) ومصروفات</span></h3>
          <div class="dash-chart">${d.series.map((x) => html`<div class="dc" title="${dShort(x.date)}: إيراد ${money(x.revenue)} · مصروفات ${money(x.expenses)}"><div class="dc-bars"><i class="r" style="height:${Math.round((x.revenue / maxDay) * 100)}%"></i><i class="e" style="height:${Math.round((x.expenses / maxDay) * 100)}%"></i></div><small>${Number(x.date.slice(8))}</small></div>`)}</div>
          <div class="dash-leg"><span><i class="r"></i> إيراد</span><span><i class="e"></i> مصروفات</span></div></div>
        <div class="card pad"><h3>${icon('receipt')} المصروفات راحت فين</h3>
          ${[['الدكاترة (قبل الضريبة)', d.expenses.doctors, 'var(--py)'], ['الموردين', d.expenses.suppliers, 'var(--lab)'], ['الأقساط', d.expenses.installments, 'var(--radiology)'], ['مصروفات عامة', d.expenses.general, 'var(--warn)']].map(([n, v, c]) => html`<div class="fin-bar"><span>${n}</span><i style="--w:${Math.round((v / expMax) * 100)}%;--bc:${c}"></i><b class="num">${money(v)}</b></div>`)}
          ${d.expenses.categories.length ? html`<h4 class="subh" style="margin-top:12px">أكبر بنود المصروفات العامة</h4>${d.expenses.categories.slice(0, 4).map((c) => html`<div class="row" style="padding:4px 0"><span>${c.name}</span><span class="spacer"></span><b class="num">${money(c.amount)}</b></div>`)}` : ''}</div></div>
      <div class="dash-3">
        <div class="card pad"><h3>${icon('cash')} الشيكات الجاية</h3>${d.cheques.list.length ? d.cheques.list.map((c) => html`<div class="dl"><div><b>${c.payee}</b><small>${dFmt(c.date)} · ${c.no}</small></div><b class="num ${c.overdue ? 'neg' : ''}">${money(c.amount)}</b></div>`) : html`<div class="muted">مفيش شيكات مستحقة</div>`}</div>
        <div class="card pad"><h3>${icon('calendar')} الأقساط الجاية</h3>${d.installments.list.length ? d.installments.list.map((n) => html`<div class="dl"><div><b>${n.name}</b><small>قسط ${n.no} · ${dFmt(n.date)}</small></div><b class="num ${n.overdue ? 'neg' : ''}">${money(n.amount)}</b></div>`) : html`<div class="muted">مفيش أقساط</div>`}</div>
        <div class="card pad"><h3>${icon('undo')} آخر المستردات</h3>${d.refunds.list.length ? d.refunds.list.map((x) => html`<div class="dl"><div><b>${x.patient}</b><small>${fmtWhen(x.at)} · ${x.by}${x.note ? ' · ' + x.note : ''}</small></div><b class="num">${money(x.amount)}</b></div>`) : html`<div class="muted">مفيش مرتجعات</div>`}</div></div>
      ${d.claims.total ? html`<div class="card pad" style="margin-top:14px"><div class="row wrap" style="gap:16px"><b>${icon('shield', 'sm')} مطالبات التعاقدات</b><span class="muted">اتطالب بيها <b class="num">${money(d.claims.total)}</b></span><span class="muted">اتحصّل <b class="num" style="color:var(--ok)">${money(d.claims.paid)}</b></span><span class="muted">مرفوض <b class="num" style="color:var(--danger)">${money(d.claims.rejected)}</b></span><span class="muted">لسه عند الشركات <b class="num">${money(d.claims.left)}</b></span></div></div>` : ''}`);
  };
  const load = async () => { try { draw(await api.get('/finance/dashboard?month=' + S.month)); } catch (e) { toastError(e); } };
  view.onclick = (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { S.month = shiftP(S.month, Number(m.dataset.m)); store.set('dashMonth', S.month); load(); }
  };
  await load();
  const t = setInterval(() => { if (document.contains(view)) load(); }, 60000);
  return () => { view.onclick = null; clearInterval(t); };
}
