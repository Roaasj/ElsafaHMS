import { api, html, icon, $, money, egp, fmtTime, DEPT, askReason, toast, toastError, printReceipt, can } from '../core.js';

export async function renderReceipts(view, { query, setTitle }) {
  setTitle('الإيصالات', 'إيصالات اليوم: طباعة نسخة أو إلغاء بإيصال مرتجع');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
  const S = { date: query.get('date') || today, mine: query.get('mine') === '1' || !can('receipts.cancelAny') };
  view.innerHTML = String(html`
    <div class="pagehead">
      <input class="input" type="date" id="dt" value="${S.date}" max="${today}" style="width:auto">
      <div class="seg" id="who"><button data-w="1" class="${S.mine ? 'on' : ''}">إيصالاتي</button><button data-w="0" class="${S.mine ? '' : 'on'}">الكل</button></div>
      <div class="seg" title="شكل الطباعة"><button data-pf="a5">A5</button><button data-pf="thermal">حراري</button></div>
    </div>
    <div class="totbar" id="tot" style="margin-bottom:16px"></div>
    <div id="list"><div class="skel" style="height:300px"></div></div>`);
  const pf = () => view.querySelectorAll('[data-pf]').forEach((b) => b.classList.toggle('on', b.dataset.pf === (localStorage.getItem('printFmt') || 'a5')));
  pf();
  const load = async () => {
    const r = await api.get(`/receipts?date=${S.date}${S.mine ? '&mine=1' : ''}`);
    const t = r.totals;
    $('#tot').innerHTML = String(html`
      <div class="tot" style="background:linear-gradient(135deg,#fff,var(--ok-soft))"><small>الصافي</small><b>${egp(t.net)}</b></div>
      <div class="tot"><small>${icon('cash', 'sm')} نقدي</small><b>${egp(t.cash)}</b></div>
      <div class="tot"><small>${icon('card', 'sm')} فيزا</small><b>${egp(t.card)}</b></div>
      <div class="tot"><small>${icon('hourglass', 'sm')} آجل</small><b>${egp(t.credit)}</b></div>
      <div class="tot"><small>${icon('percent', 'sm')} خصومات</small><b>${egp(t.discount)}</b></div>
      <div class="tot"><small>عدد الإيصالات</small><b class="num">${t.count}</b></div>`);
    $('#list').innerHTML = r.receipts.length ? String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>رقم</th><th>الوقت</th><th>المريض</th><th class="hide-sm">القسم</th><th class="n">الصافي</th><th class="hide-sm">الدفع</th><th class="hide-sm">الموظف</th><th></th></tr></thead>
      <tbody>${r.receipts.map((x) => html`<tr class="${x.kind === 'refund' || x.kind === 'return' ? 'refund' : ''} ${x.reversed ? 'reversed' : ''}">
        <td><b class="num">${x.no}</b> ${x.kind === 'refund' ? html`<span class="badge danger">إلغاء</span>` : x.kind === 'return' ? html`<span class="badge danger">مرتجع</span>` : x.kind === 'deposit' ? html`<span class="badge">تأمين</span>` : x.kind === 'final' ? html`<span class="badge ok">خروج</span>` : ''}${x.reversed ? html` <span class="badge">اتلغى</span>` : ''}</td>
        <td style="white-space:nowrap">${fmtTime(x.createdAt)}</td>
        <td><a href="${x.admissionId ? '#/admission/' + x.admissionId : '#/visit/' + x.visitId}" style="text-decoration:none"><b>${x.patient.name}</b></a><div class="muted" style="font-size:12px"><span class="num">#${x.patient.no}</span>${x.reason ? ' · ' + x.reason : ''}</div></td>
        <td class="hide-sm">${x.admissionId ? html`<span class="dtag d-admit">${icon('bed')} دخول <span class="num">${x.admissionNo}</span></span>` : html`<span class="dtag d-${x.visitType}">${icon(DEPT[x.visitType].icon)} ${DEPT[x.visitType].short}</span>`}</td>
        <td class="n"><b>${egp(x.net)}</b>${x.discount ? html`<div class="muted" style="font-size:12px">خصم <span class="num">${money(x.discount)}</span></div>` : ''}</td>
        <td class="hide-sm">${[x.cash && 'نقدي', x.card && 'فيزا', x.credit && 'آجل'].filter(Boolean).join(' + ')}</td>
        <td class="hide-sm muted">${x.createdBy}</td>
        <td class="n" style="white-space:nowrap"><button class="btn ghost icon sm" data-print="${x.id}" title="اطبع نسخة">${icon('print', 'sm')}</button>
          ${x.canCancel ? html`<button class="btn ghost icon sm" data-cancel="${x.id}" data-no="${x.no}" title="إلغاء">${icon('undo', 'sm')}</button>` : ''}</td>
      </tr>`)}</tbody></table></div></div>`)
      : String(html`<div class="card empty"><div class="art">${icon('receipt')}</div><b>مفيش إيصالات في اليوم ده</b></div>`);
  };
  $('#dt').addEventListener('change', (e) => { S.date = e.target.value || today; load(); });
  view.onclick = async (e) => {
    const w = e.target.closest('[data-w]');
    if (w) { S.mine = w.dataset.w === '1'; view.querySelectorAll('[data-w]').forEach((b) => b.classList.toggle('on', b === w)); load(); }
    const f = e.target.closest('[data-pf]');
    if (f) { localStorage.setItem('printFmt', f.dataset.pf); pf(); toast(f.dataset.pf === 'a5' ? 'الطباعة على ورق A5' : 'الطباعة على الطابعة الحرارية'); }
    const p = e.target.closest('[data-print]');
    if (p) printReceipt(p.dataset.print, false);
    const c = e.target.closest('[data-cancel]');
    if (c) {
      const reason = await askReason({ title: `إلغاء إيصال رقم ${c.dataset.no}`, label: 'سبب الإلغاء', confirm: 'ألغِ الإيصال', note: 'هيطلع إيصال مرتجع بنفس المبلغ، والخدمات اللي فيه هتتلغي.' });
      if (!reason) return;
      try { await api.post(`/receipts/${c.dataset.cancel}/cancel`, { reason }); toast('اتعمل إيصال مرتجع'); load(); window.refreshShell?.(); } catch (er) { toastError(er); }
    }
  };
  await load();
  return () => { view.onclick = null; };
}
