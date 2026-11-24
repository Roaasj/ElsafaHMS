// حساب الإقامة: الليالي والخدمات والمدفوعات، والتحويل، والدفعات، والخروج
import { firstDept, deptIs,
  api, html, icon, $, money, egp, fmtWhen, fmtTime, initials, sexName, DEPT, SVC_KEYS, ADM, modal, toast, toastError,
  askReason, printReceipt, can, debounce, nightsText,
  COVER, AP_ST, cashierDuty, showOrder, printOrder, state, TCAT, printBill,
} from '../core.js';
import { searchKey } from '/shared/text.js';
import { bedBoard } from './beds.js';
import { pickDoctor, managers, mgrSelect } from './pickers.js';

const autoPrint = () => localStorage.getItem('autoPrint') !== '0';
const printInvoice = (id) => printBill(id, 'detail');
const dayName = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d + 'T00:00:00Z'));

export async function renderAdmission(view, { params, setTitle }) {
  const id = Number(params[0]);
  view.innerHTML = String(html`<div class="skel" style="height:120px"></div>`);
  const [first, svcRes, duty0] = await Promise.all([api.get('/admissions/' + id), api.get('/catalog/services'), cashierDuty().catch(() => ({}))]);
  const services = svcRes.services;
  const S = { d: first, dept: firstDept('ward'), q: '', showNights: false, lastAdded: null, duty: duty0 };
  const ordering = () => !!S.duty?.mustOrder;
  const pendingDischarge = () => S.d.orders?.find((o) => o.kind === 'discharge');
  const A = () => S.d.admission;
  const tmode = () => !!S.d.ticketMode;
  const closed = () => A().bill?.status === 'closed';
  const canEdit = () => A().status === 'active' && !closed() && (tmode() ? can('adm.bill') : can('admissions.write'));

  const drawHead = () => {
    const { admission: a, patient: p, bed, totals: t } = S.d;
    setTitle(`دخول ${a.no} · ${p.name.split(' ').slice(0, 2).join(' ')}`, `${a.typeName} · غرفة ${bed.room.no} سرير ${bed.label}`);
    const active = a.status === 'active';
    const pct = t.patient ? Math.min(100, Math.round(((t.paid + t.discount) / t.patient) * 100)) : 100;
    const py = a.payer;
    $('#ahead', view).innerHTML = String(html`
      <div class="ahead-main">
        <span class="pavatar lg ${p.sex || ''}">${initials(p.name)}</span>
        <div style="min-width:0">
          <div class="row wrap" style="gap:8px"><h2>${p.name}</h2><a class="fileno num" href="#/patient/${p.id}">#${p.no}</a>
            <span class="admtag t-${a.type}">${icon(ADM[a.type].icon, 'sm')} ${a.typeName}</span>
            ${active ? html`<span class="badge ok dot">داخل</span>` : html`<span class="badge">خرج ${fmtWhen(a.dischargedAt)}</span>`}
            ${active && closed() ? html`<span class="badge py">${icon('lock', 'sm')} التذكرة اتقفلت ${fmtTime(a.bill.closedAt)}</span>` : ''}</div>
          <div class="pmeta"><span>${icon('door', 'sm')}الدور ${bed.floor.no} · غرفة <b class="num">${bed.room.no}</b> · سرير ${bed.label} · ${bed.cls.name}</span>
            <span>${icon('steth', 'sm')}${a.doctorName || 'من غير طبيب'}</span>
            <span>${icon('clock', 'sm')}دخل ${fmtWhen(a.admittedAt)} · ${nightsText(a.nights)}</span>
            ${p.age ? html`<span>${p.age} · ${sexName(p.sex)}</span>` : ''}</div>
          ${py ? html`<div class="payline ${py.status === 'rejected' ? 'rej' : ''}">${icon('shield', 'sm')}<b>${py.name}</b><span>${py.tierName} · كارنيه <span class="num">${py.cardNo || '—'}</span></span>
            ${py.status === 'rejected' ? html`<span class="badge danger">الموافقة اترفضت: الحساب نقدي</span>` : py.approval ? html`<span class="badge ${AP_ST[py.approval.status]?.cls || ''}">${AP_ST[py.approval.status]?.name || ''}${py.approval.no ? html` · <span class="num">${py.approval.no}</span>` : ''}</span>` : ''}</div>` : ''}
          ${a.expectedProcedure ? html`<div class="muted" style="font-size:13px;font-weight:700;margin-top:2px">${a.expectedProcedure}</div>` : ''}
          <div class="diagline ${a.diagnosis ? '' : 'miss'} ${a.diagnosisOverdue ? 'overdue' : ''}">${icon('file', 'sm')}<span>التشخيص:</span> <b>${a.diagnosis || 'لسه ما اتكتبش'}</b>${a.diagnosisProvisional ? html`<span class="badge ${a.diagnosisOverdue ? 'danger' : 'warn'}">${a.diagnosisOverdue ? 'مبدئي ومهلته عدّت: لازم تشخيص نهائي قبل الخروج' : 'مبدئي'}</span>` : ''}${can('admissions.write') ? html`<button class="linkbtn" data-diag>${icon('edit', 'sm')} ${a.diagnosis ? (a.diagnosisProvisional ? 'حوّله لنهائي' : 'عدّل') : 'اكتبه'}</button>` : ''}</div>
        </div>
      </div>
      <div class="ahead-money">
        <div class="mtile"><small>الحساب لحد دلوقتي</small><b>${egp(t.total)}</b></div>
        ${t.payer > 0 ? html`<div class="mtile py"><small>على ${py?.name || 'التعاقد'}</small><b>${egp(t.payer)}</b></div>` : ''}
        <div class="mtile"><small>المدفوع</small><b style="color:var(--ok)">${egp(t.paid)}</b></div>
        <div class="mtile ${t.balance > 0 ? 'due' : 'ok'}"><small>${t.balance > 0 ? 'المطلوب' : t.balance < 0 ? 'رصيد للمريض' : 'الحساب'}</small><b>${t.balance === 0 ? 'خالص' : egp(Math.abs(t.balance))}</b></div>
        <div class="paidbar" title="اتدفع ${pct}%"><i style="width:${pct}%"></i></div>
      </div>
      <div class="ahead-acts">
        ${active ? html`
          ${can('cash.collect') ? html`<button class="btn soft" data-act="pay" style="--c:var(--ok)">${icon('cash')} دفعة تحت الحساب</button>` : ''}
          ${can('admissions.write') && !closed() ? html`<button class="btn ghost" data-act="transfer">${icon('arrows')} تحويل سرير</button>` : ''}
          <button class="btn ghost" data-act="statement">${icon('print')} كشف حساب</button>
          ${can('admissions.write') ? html`<button class="btn ghost" data-act="edit">${icon('edit')} تعديل</button>` : ''}
          ${can('adm.bill') ? html`<a class="btn soft" href="#/ticket/${a.id}" style="--c:var(--py)">${icon('ticket')} التذكرة</a>` : ''}
          ${pendingDischarge() ? html`<span class="badge py" style="height:40px;padding:0 14px;font-size:13.5px">${icon('hourglass', 'sm')} الخروج مستني الخزينة · إذن <span class="num">${pendingDischarge().no}</span></span>`
            : tmode() && !closed() ? html`<span class="badge warn" style="height:40px;padding:0 14px;font-size:13.5px">${icon('ticket', 'sm')} الخروج بعد قفل التذكرة من الحسابات</span>`
            : can('admissions.write') && can('cash.collect') ? html`<button class="btn" data-act="discharge">${icon('exit')} خروج</button>` : ''}`
        : html`<button class="btn" data-act="statement">${icon('print')} الفاتورة النهائية</button>
          ${t.balance > 0 && can('cash.collect') ? html`<button class="btn soft" data-act="pay" style="--c:var(--ok)">${icon('cash')} تحصيل الباقي</button>` : ''}
          ${can('admissions.override') ? html`<button class="btn ghost" data-act="undo">${icon('undo')} إلغاء الخروج</button>` : ''}`}
      </div>`);
  };

  const drawCatalog = () => {
    const box = $('#acat', view);
    if (A().status !== 'active') { box.classList.add('hide'); view.querySelector('.vgrid')?.classList.add('solo'); return; }
    if (tmode()) {
      const bc = S.d.totals.byCat || {};
      box.innerHTML = String(html`<div class="tk-note">
        <span class="tk-ic">${icon('ticket')}</span>
        <div><b>البنود بتتكتب من الحسابات</b><small>${closed() ? `التذكرة اتقفلت ${A().bill.closedBy ? 'بواسطة ' + A().bill.closedBy : ''} · ${fmtWhen(A().bill.closedAt)}` : 'الخدمات والأدوية والمستلزمات والأتعاب بتنزل من التذكرة اليومية'}</small></div>
        ${can('adm.bill') ? html`<a class="btn" href="#/ticket/${A().id}" style="--c:var(--py)">${icon('ticket')} افتح التذكرة</a>` : ''}</div>
        <div class="tk-cats">${Object.entries(TCAT).map(([k, c]) => html`<div class="tk-cat" style="--cc:${c.c}"><span>${icon(c.icon, 'sm')}</span><small>${c.name}</small><b>${egp(bc[k] || 0)}</b></div>`)}</div>`);
      return;
    }
    if (!can('admissions.write')) { box.classList.add('hide'); return; }
    const q = searchKey(S.q);
    const inp = SVC_KEYS.filter((k) => deptIs(k, 'ward', 'or'));
    const keys = [...inp, ...SVC_KEYS.filter((k) => !inp.includes(k))];
    let list = q ? services.filter((s) => searchKey(s.name).includes(q) || s.code.toLowerCase().includes(q)) : services.filter((s) => s.dept === S.dept);
    if (!q) list = [...list.filter((s) => s.quick), ...list.filter((s) => !s.quick)];
    $('#acat', view).innerHTML = String(html`
      <div class="row wrap" style="gap:10px"><div class="dtabs">${keys.map((k) => html`<button class="dtab d-${k} ${S.dept === k && !S.q ? 'on' : ''}" data-dept="${k}">${icon(DEPT[k].icon, 'sm')} ${DEPT[k].short}</button>`)}</div>
        <div class="big-search" style="flex:1 1 180px">${icon('search')}<input class="input" id="sq" type="search" value="${S.q}" placeholder="دوّر على خدمة" style="height:42px;font-size:14.5px;padding-inline-start:42px;border-radius:12px" autocomplete="off"></div></div>
      <div class="svc-grid">${list.map((s) => html`<button class="svc d-${s.dept}" data-svc="${s.id}"><span class="plus">${icon('plus', 'sm')}</span><b>${s.name}</b>
        <div class="foot"><span class="price"><span class="num">${money(s.price)}</span> ${HMS.money.symbol}</span>${s.hasDoctor ? html`<span class="doc-ic">${icon('steth', 'sm')}</span>` : ''}${s.includedNights ? html`<span class="tm after">باكدج ${nightsText(s.includedNights)}</span>` : ''}</div></button>`)}
        ${!list.length ? html`<div class="empty" style="grid-column:1/-1">مفيش خدمات هنا</div>` : ''}</div>`);
  };

  const drawBill = () => {
    const { items, receipts, totals: t, moves } = S.d;
    const active = A().status === 'active';
    const nights = items.filter((i) => i.kind === 'night');
    const activeN = nights.filter((i) => i.status === 'active');
    const groups = [];
    for (const n of activeN) {
      const k = n.name + '|' + n.unitPrice;
      let g = groups.find((x) => x.k === k);
      if (!g) groups.push(g = { k, name: n.name, price: n.unitPrice, n: 0, from: n.date, to: n.date, note: n.note });
      g.n++; g.to = n.date;
    }
    const svcs = items.filter((i) => i.kind === 'service');
    const cats = ['service', 'drug', 'supply', 'visit', 'fee'].filter((k) => k === 'service' || svcs.some((i) => i.cat === k));
    $('#abill', view).innerHTML = String(html`
      <div class="bill-head"><h3>${icon('wallet')} حساب الإقامة</h3></div>
      <div class="agroup">
        <div class="agh"><b>${icon('bed', 'sm')} الإقامة</b><span class="muted">${nightsText(activeN.length)}</span><span class="spacer"></span><b>${egp(t.nights)}</b>
          <button class="linkbtn" data-tn>${S.showNights ? 'إخفاء' : 'تفاصيل الليالي'}</button></div>
        ${groups.map((g) => html`<div class="ngrp"><span>${g.name.replace('إقامة ليلة · ', '')}${g.note ? html` <span class="badge ok" style="height:19px;font-size:11px">${g.note}</span>` : ''}</span>
          <span class="muted num">${g.n} × ${money(g.price)}</span><b>${egp(g.n * g.price)}</b></div>`)}
        ${S.showNights ? html`<div class="nlist">${nights.map((n) => html`<div class="nrow ${n.status}"><span>${dayName(n.date)}</span><span class="muted">${n.name.replace('إقامة ليلة · ', '')}</span>
          ${n.status === 'voided' ? html`<span class="badge" title="${n.voidReason}">اتشالت</span>` : html`<b class="num">${money(n.amount)}</b>`}
          ${canEdit() && n.status === 'active' && can('admissions.override') ? html`<button class="rm" data-rm="${n.id}" title="شيل الليلة (المدير)">${icon('trash', 'sm')}</button>` : html`<span></span>`}</div>`)}</div>` : ''}
      </div>
      ${cats.map((k) => { const xs = svcs.filter((i) => (i.cat || 'service') === k); const live = xs.filter((i) => i.status === 'active'); return html`<div class="agroup">
        <div class="agh"><b style="color:${TCAT[k].c}">${icon(TCAT[k].icon, 'sm')} ${TCAT[k].name}</b><span class="muted">${live.length}</span><span class="spacer"></span><b>${egp(S.d.totals.byCat?.[k] ?? live.reduce((a, i) => a + i.amount, 0))}</b></div>
        ${!xs.length ? html`<div class="muted" style="font-size:13px;font-weight:600;padding:6px 4px">${tmode() ? 'لسه مفيش بنود من التذكرة.' : 'لسه مفيش خدمات. ضيف من القايمة اللي جنبك.'}</div>` : ''}
        ${xs.map((i) => html`<div class="line ${i.status === 'voided' ? 'voided' : ''} ${S.lastAdded === i.id ? 'new' : ''}">
          <span class="dtag" style="--ds:color-mix(in srgb, ${TCAT[k].c} 12%, #fff);--dc:${TCAT[k].c};width:22px;height:22px;padding:0;justify-content:center">${icon(k === 'service' ? (DEPT[i.dept]?.icon || 'plus') : TCAT[k].icon, 'sm')}</span>
          <div class="nm"><b>${i.name}${i.qty > 1 ? html` <span class="muted num">× ${i.qty}</span>` : ''}</b><small>${i.doctorName ? html`<span>${icon('steth', 'sm')}${i.doctorName}</span>` : ''}
            <span>${i.date ? dayName(i.date) : fmtWhen(i.addedAt)}</span>${COVER[i.cover] && i.status === 'active' ? html`<span class="badge ${COVER[i.cover].cls}">${COVER[i.cover].name}</span>` : ''}${i.fromVisit || (i.note && !i.ticketId) ? html`<span class="badge">${i.note}</span>` : ''}${i.includedNights ? html`<span class="badge ok">شامل ${nightsText(i.includedNights)}</span>` : ''}${i.status === 'voided' ? html`<span>${i.voidReason}</span>` : ''}</small></div>
          <div class="am">${i.payerAmount > 0 && i.status === 'active' ? html`<b>${egp(i.patientAmount)}</b><small class="pshare">${money(i.amount)} · الشركة <span class="num">${money(i.payerAmount)}</span></small>` : html`<b>${egp(i.amount)}</b>`}${canEdit() && !tmode() && i.status === 'active' ? html`<button class="rm" data-rm="${i.id}" title="شيل">${icon('trash', 'sm')}</button>` : ''}</div>
        </div>`)}
      </div>`; })}
      <div class="agroup">
        <div class="agh"><b>${icon('receipt', 'sm')} المدفوعات</b><span class="spacer"></span><b style="color:var(--ok)">${egp(t.paid)}</b></div>
        ${receipts.map((r) => html`<div class="rmini ${r.net < 0 ? 'refund' : ''} ${r.reversed ? 'reversed' : ''}">${icon(r.kind === 'deposit' ? 'shield' : r.net < 0 ? 'undo' : 'receipt', 'sm')}
          <span>${r.kindName} <span class="num">${r.no}</span></span><span class="muted" style="font-weight:600">${fmtWhen(r.createdAt)}</span><span class="spacer"></span>
          <b>${egp(r.net)}</b>${r.credit ? html`<span class="badge warn">آجل <span class="num">${money(r.credit)}</span></span>` : ''}
          <button class="btn ghost icon sm" data-print="${r.id}" title="اطبع">${icon('print', 'sm')}</button>
          ${active && ['deposit', 'payment'].includes(r.kind) && !r.reversed && (can('receipts.cancelAny') || can('receipts.cancelOwnOpenShift')) ? html`<button class="btn ghost icon sm" data-cancel="${r.id}" data-no="${r.no}" title="إلغاء">${icon('undo', 'sm')}</button>` : ''}</div>`)}
        ${!receipts.length && !S.d.orders?.length ? html`<div class="muted" style="font-size:13px;font-weight:600;padding:6px 4px">مفيش مدفوعات</div>` : ''}
        ${(S.d.orders || []).map((o) => html`<div class="omini"><span class="ono num">${o.no}</span><div style="min-width:0"><b>${o.description}</b><small>مستني الخزينة · ${o.createdBy} · ${fmtTime(o.createdAt)}</small></div>
          <b class="num" style="margin-inline-start:auto">${money(Math.abs(o.amount))} ${HMS.money.symbol}</b>
          <button class="btn ghost icon sm" data-oprint="${o.id}" title="اطبع الإذن">${icon('print', 'sm')}</button>
          ${o.createdById === state.me?.id || can('orders.cancelAny') ? html`<button class="btn ghost icon sm" data-ocancel="${o.id}" data-no="${o.no}" title="الغي الإذن">${icon('x', 'sm')}</button>` : ''}</div>`)}
      </div>
      ${moves.length > 1 ? html`<div class="agroup"><div class="agh"><b>${icon('arrows', 'sm')} تنقلات المريض</b></div>
        ${moves.map((m) => html`<div class="nrow"><span>${fmtWhen(m.from)}</span><span>غرفة <b class="num">${m.room}</b> · ${m.bed} · ${m.className}</span><span class="muted">${m.reason || ''}</span><span></span></div>`)}</div>` : ''}`);
  };

  view.innerHTML = String(html`<div class="card ahead" id="ahead"></div>
    <div class="vgrid"><section class="card catalog" id="acat"></section><aside class="card bill abill" id="abill"></aside></div>`);
  const drawAll = () => { drawHead(); drawCatalog(); drawBill(); };
  drawAll();
  const refresh = (d) => { S.d = d; drawHead(); drawBill(); };

  const addService = async (svc) => {
    let doctorId;
    if (svc.hasDoctor) {
      const d = await pickDoctor(`الدكتور · ${svc.name}`);
      if (!d) return;
      doctorId = d.id;
    }
    try {
      const r = await api.post(`/admissions/${id}/items`, { serviceId: svc.id, doctorId });
      S.lastAdded = r.itemId; refresh(r); setTimeout(() => { S.lastAdded = null; }, 1200);
      const it = r.items.find((x) => x.id === r.itemId);
      toast(it?.cover === 'pending' ? `اتضافت «${svc.name}» ومستنية موافقة ${A().payer?.name || ''}` : `اتضافت «${svc.name}»`, it?.cover === 'pending' ? 'info' : 'ok');
    } catch (e) { toastError(e); }
  };

  view.onclick = async (e) => {
    const t = e.target;
    const dp = t.closest('[data-dept]');
    if (dp) { S.dept = dp.dataset.dept; S.q = ''; drawCatalog(); return; }
    const sv = t.closest('[data-svc]');
    if (sv) return addService(services.find((s) => s.id === Number(sv.dataset.svc)));
    if (t.closest('[data-tn]')) { S.showNights = !S.showNights; drawBill(); return; }
    const rm = t.closest('[data-rm]');
    if (rm) {
      const it = S.d.items.find((i) => i.id === Number(rm.dataset.rm));
      const reason = await askReason({ title: `شيل «${it.kind === 'night' ? 'ليلة ' + dayName(it.date) : it.name}»`, confirm: 'شيل البند', note: 'العملية دي متسجلة باسمك.' });
      if (!reason) return;
      try { refresh(await api.del(`/admissions/${id}/items/${it.id}`, { reason })); toast('اتشال البند', 'info'); } catch (er) { toastError(er); }
      return;
    }
    const pr = t.closest('[data-print]');
    if (pr) return printReceipt(pr.dataset.print, false);
    const op = t.closest('[data-oprint]');
    if (op) return printOrder(op.dataset.oprint);
    const oc = t.closest('[data-ocancel]');
    if (oc) {
      const reason = await askReason({ title: `إلغاء إذن ${oc.dataset.no}`, label: 'السبب', confirm: 'الغي الإذن' });
      if (!reason) return;
      try { await api.post(`/orders/${oc.dataset.ocancel}/cancel`, { reason }); refresh(await api.get('/admissions/' + id)); window.refreshShell?.(); toast('اتلغى الإذن', 'info'); } catch (er) { toastError(er); }
      return;
    }
    const cn = t.closest('[data-cancel]');
    if (cn) {
      const reason = await askReason({ title: `إلغاء إيصال رقم ${cn.dataset.no}`, confirm: 'ألغِ الإيصال', note: 'هيطلع إيصال مرتجع بنفس المبلغ.' });
      if (!reason) return;
      try { const r = await api.post(`/receipts/${cn.dataset.cancel}/cancel`, { reason }); refresh(r); window.refreshShell?.(); toast('اتعمل إيصال مرتجع'); if (autoPrint()) printReceipt(r.refundId, true); } catch (er) { toastError(er); }
      return;
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (t.closest('[data-diag]')) {
      const m = modal({ title: 'التشخيص', body: html`<div class="field"><label>التشخيص <span class="hint">بيطلع في مطالبة ${A().payer?.name || 'التعاقد'}</span></label><input class="input" name="dg" list="dglist" autocomplete="off" value="${A().diagnosis || ''}" autofocus><datalist id="dglist"></datalist></div>
        ${state.dx?.provisional ? html`<label class="chk" style="font-weight:700"><input type="checkbox" name="dp" ${A().diagnosisProvisional ? 'checked' : ''}> مبدئي · مهلة ${state.dx.hours} ساعة من الدخول</label>` : ''}`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>` });
      const save = async () => { try { S.d = await api.put(`/admissions/${id}/diagnosis`, { diagnosis: $('[name=dg]', m.el).value, provisional: !!$('[name=dp]', m.el)?.checked }); m.close(); drawAll(); toast('اتحفظ التشخيص'); } catch (er) { toastError(er); } };
      api.get('/admissions/diagnoses').then((r) => { $('#dglist', m.el).innerHTML = r.diagnoses.map((x) => `<option value="${x.replace(/"/g, '&quot;')}"></option>`).join(''); }).catch(() => {});
      $('[data-ok]', m.el).addEventListener('click', save);
      m.el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
      return;
    }
    if (act === 'statement') return printInvoice(id);
    if (act === 'pay') return payModal();
    if (act === 'transfer') return transferModal();
    if (act === 'edit') return editModal();
    if (act === 'discharge') return dischargeModal();
    if (act === 'undo') {
      const reason = await askReason({ title: 'إلغاء الخروج', confirm: 'رجّع المريض', note: 'إيصال الخروج هيتلغي بإيصال عكسي، والمريض هيرجع على سريره.' });
      if (!reason) return;
      try { S.d = await api.post(`/admissions/${id}/undo-discharge`, { reason }); drawAll(); toast('المريض رجع داخل'); window.refreshShell?.(); } catch (er) { toastError(er); }
    }
  };
  view.oninput = debounce((e) => { if (e.target.id === 'sq') { S.q = e.target.value; drawCatalog(); const i = $('#sq', view); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 150);

  // ---------- دفعة تحت الحساب ----------
  function payModal() {
    const due = Math.max(0, S.d.totals.balance);
    let method = 'cash';
    const m = modal({
      title: 'دفعة تحت الحساب',
      body: html`<div class="pricehead" style="--ds:var(--ok-soft);--dc:var(--ok)"><span class="dicon">${icon('wallet')}</span><div><b>المطلوب لحد دلوقتي</b><small>${S.d.totals.payer > 0 ? `على المريض ${money(S.d.totals.patient)}` : `الحساب ${money(S.d.totals.total)}`} · المدفوع ${money(S.d.totals.paid)}</small></div><div class="cur"><b>${egp(due)}</b></div></div>
        <div class="field" data-f="amount" style="margin-top:14px"><label>المبلغ</label><input class="input num" name="amount" inputmode="decimal" value="${due || ''}" autofocus style="font-size:22px;height:54px;font-weight:800"><div class="msg"></div></div>
        ${ordering() ? html`<div class="dutybar" style="margin-top:10px">${icon('wallet', 'sm')}<span>الخزينة شغالة (<b>${S.duty.onDuty?.name}</b>): هيطلع إذن والمريض يدفع هناك</span></div>`
          : html`<div class="seg full" style="margin-top:10px"><button data-m="cash" class="on">${icon('cash', 'sm')} نقدي</button><button data-m="card">${icon('card', 'sm')} فيزا</button></div>
          <input class="input num" name="manualNo" placeholder="رقم الإيصال اليدوي (لو فيه)" style="margin-top:8px">`}`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:${ordering() ? 'var(--py)' : 'var(--ok)'}">${ordering() ? html`${icon('wallet')} اعمل إذن دفع` : html`${icon('check')} اقبض واطبع`}</button>`,
    });
    setTimeout(() => $('[name=amount]', m.el).select(), 40);
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-m]');
      if (b) { method = b.dataset.m; m.el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b)); }
      if (e.target.closest('[data-ok]')) {
        const v = $('[name=amount]', m.el).value;
        try {
          const r = await api.post(`/admissions/${id}/pay`, ordering() ? { amount: v } : { ...(method === 'cash' ? { cash: v } : { card: v }), manualNo: $('[name=manualNo]', m.el)?.value });
          m.close(); refresh(r); window.refreshShell?.();
          if (r.order) return showOrder(r.order, { autoPrint: autoPrint() });
          toast(`اتقبض ${money(v)} ${HMS.money.unitWord}`);
          if (autoPrint()) printReceipt(r.receiptId, true);
        } catch (er) { toastError(er); }
      }
    });
  }

  // ---------- تحويل سرير ----------
  function transferModal() {
    let bed = null;
    const m = modal({
      title: 'تحويل سرير', wide: true,
      body: html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>سعر الليلة بيتغير من النهارده حسب درجة السرير الجديد. التحويل لعناية أو حضانة بيغيّر نوع الدخول لوحده.</span></div>
        <div id="tb"></div><div class="field" style="margin-top:12px"><label>سبب التحويل</label><input class="input" name="reason" placeholder="مثلًا: تحويل للعناية، أو طلب غرفة ممتازة"></div>`,
      foot: html`<span class="muted" id="tsel" style="margin-inline-end:auto;font-weight:700;align-self:center">اختار السرير الجديد</span><button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok disabled>${icon('arrows')} حوّل</button>`,
    });
    bedBoard($('#tb', m.el), {
      mode: 'pick', onPick: (b) => {
        bed = b; $('[data-ok]', m.el).disabled = false;
        $('#tsel', m.el).textContent = `غرفة ${b.roomNo} · سرير ${b.label} · ${b.roomCls.name} (${money(b.roomCls.nightPrice)} ${HMS.money.symbol})`;
      },
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      try {
        const r = await api.post(`/admissions/${id}/transfer`, { bedId: bed.id, reason: $('[name=reason]', m.el).value });
        m.close(); S.d = r; drawAll(); toast(`المريض اتحوّل لغرفة ${r.bed.room.no} سرير ${r.bed.label}`);
      } catch (er) { toastError(er); }
    });
  }

  // ---------- تعديل الطبيب والإجراء ----------
  function editModal() {
    const a = A();
    let doc = a.doctorId ? { id: a.doctorId, name: a.doctorName } : null;
    const m = modal({
      title: 'تعديل بيانات الدخول',
      body: html`<div class="grid" style="gap:12px">
        <div class="field"><label>الطبيب المعالج</label><button class="input pickbtn" data-doc type="button"><b id="dn">${doc?.name || 'اختار'}</b>${icon('chev-left', 'sm')}</button></div>
        <div class="field"><label>الإجراء / العملية</label><input class="input" name="proc" value="${a.expectedProcedure || ''}"></div>
        <div class="field"><label>ملاحظات</label><input class="input" name="notes" value="${a.notes || ''}"></div></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    m.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-doc]')) { const d = await pickDoctor('الطبيب المعالج'); if (d) { doc = d; $('#dn', m.el).textContent = d.name; } }
      if (e.target.closest('[data-ok]')) {
        try { S.d = await api.put('/admissions/' + id, { doctorId: doc?.id, expectedProcedure: $('[name=proc]', m.el).value, notes: $('[name=notes]', m.el).value }); m.close(); drawAll(); toast('اتحفظ'); } catch (er) { toastError(er); }
      }
    });
  }

  // ---------- الخروج ----------
  async function dischargeModal() {
    const pv = await api.get(`/admissions/${id}/discharge-preview`);
    const mg = await managers();
    const t = pv.totals;
    const X = { disc: false, discount: '', reason: '', by: '', method: 'cash', split: '', creditBy: '', note: '' };
    const early = pv.items.filter((i) => i.kind === 'night' && i.status === 'voided' && i.voidReason === 'الخروج قبل ميعاد حساب اليوم').length;
    const m = modal({ title: 'خروج المريض', wide: true, body: html`<div id="dx"></div>`, foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok>${icon('exit')} خرّج المريض</button>` });
    const calc = () => {
      const pt = t.patient ?? t.total;
      const d = X.disc ? Math.min(HMS.money.toMinor(Number(X.discount) || 0), HMS.money.toMinor(pt)) / HMS.money.F : 0;
      return { d, R: HMS.money.round((pt - d - (t.discount || 0) - t.paid)) };
    };
    const draw = () => {
      const { d, R } = calc();
      const splitCard = Math.max(0, HMS.money.round(R - (Number(X.split) || 0)));
      $('#dx', m.el).innerHTML = String(html`
        <div class="dsum">
          <div><small>الإقامة</small><b>${egp(t.nights)}</b><span class="muted">${nightsText(pv.admission.nights)}</span></div>
          <div><small>الخدمات</small><b>${egp(t.services)}</b></div>
          <div><small>الإجمالي</small><b>${egp(t.total)}</b></div>
          ${t.payer > 0 ? html`<div class="py"><small>على ${pv.admission.payer?.name || 'التعاقد'}</small><b>${egp(t.payer)}</b></div><div><small>على المريض</small><b>${egp(t.patient)}</b></div>` : ''}
          <div><small>المدفوع</small><b style="color:var(--ok)">${egp(t.paid)}</b></div>
        </div>
        ${early ? html`<div class="alertbar info" style="margin-top:10px">${icon('clock')}<span>الخروج قبل الساعة <b class="num">${pv.checkoutTime}</b>، فليلة النهارده مش محسوبة.</span></div>` : ''}
        <div style="margin-top:12px">${X.disc ? html`<div class="discbox"><div class="row" style="justify-content:space-between"><b style="font-size:13.5px">${icon('percent', 'sm')} خصم بتعليمات المدير</b><button class="linkbtn" data-doff style="color:var(--muted)">${icon('x', 'sm')} شيل</button></div>
            <div class="row" style="gap:8px"><input class="input num" name="discount" placeholder="المبلغ" value="${X.discount}" style="flex:1"><input class="input" name="reason" placeholder="السبب" value="${X.reason}" style="flex:2">${mgrSelect('by', X.by, mg)}</div></div>`
          : can('cash.discount') ? html`<button class="linkbtn" data-don>${icon('percent', 'sm')} إضافة خصم</button>` : ''}</div>
        <div class="dfinal ${R < 0 ? 'ret' : R === 0 ? 'zero' : ''}">
          <span>${R > 0 ? 'المريض يدفع' : R < 0 ? 'يرجع للمريض نقدي' : 'الحساب خالص'}</span><b>${R === 0 ? '✓' : egp(Math.abs(R))}</b>
        </div>
        ${ordering() && R !== 0 ? html`<div class="dutybar" style="margin-top:10px">${icon('wallet', 'sm')}<span>الخزينة شغالة: هيطلع إذن ${R > 0 ? 'دفع' : 'صرف'}، والمريض بيخرج لما الخزينة ${R > 0 ? 'تحصّل' : 'تصرف'}</span></div>` : ''}
        ${R > 0 ? html`<div class="seg full" style="margin-top:10px">${(ordering() ? [['cash', 'الخزينة', 'wallet'], ['credit', 'جزء آجل', 'hourglass']] : [['cash', 'نقدي', 'cash'], ['card', 'فيزا', 'card'], ['split', 'الاتنين', 'split'], ['credit', 'جزء آجل', 'hourglass']]).map(([k, n, ic]) => html`<button data-m="${k}" class="${X.method === k ? 'on' : ''}">${icon(ic, 'sm')}${n}</button>`)}</div>
          ${X.method === 'split' ? html`<div class="splitbox" style="margin-top:8px"><div class="field"><label>نقدي</label><input class="input num" name="split" value="${X.split}"></div><div class="field"><label>فيزا</label><input class="input num" value="${money(splitCard)}" disabled></div></div>` : ''}
          ${X.method === 'credit' ? html`<div class="creditbox" style="margin-top:8px"><b style="font-size:13px">${icon('hourglass', 'sm')} خروج بمبلغ متبقي (بموافقة المدير)</b>
            <div class="row" style="gap:8px"><div class="field" style="flex:1"><label>${ordering() ? 'المدفوع في الخزينة' : 'المدفوع دلوقتي نقدي'}</label><input class="input num" name="split" value="${X.split}" placeholder="0"></div>
            <div class="field" style="flex:1"><label>الباقي آجل</label><input class="input num" value="${money(splitCard)}" disabled></div></div>
            ${mgrSelect('creditBy', X.creditBy, mg)}<input class="input" name="note" placeholder="السبب (إجباري)" value="${X.note}"></div>` : ''}` : ''}`);
      $('[data-ok]', m.el).innerHTML = String(ordering() && R !== 0 ? html`${icon('wallet')} اعمل إذن الخروج` : html`${icon('exit')} خرّج المريض`);
    };
    draw();
    const upd = debounce((n, pos) => { draw(); const i = $(`[name=${n}]`, m.el); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* */ } } }, 300);
    m.el.addEventListener('input', (e) => {
      const n = e.target.name;
      if (!n) return;
      const v = e.target.value.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632);
      if (n === 'discount' || n === 'split') { X[n] = v; upd(n, e.target.selectionStart); } else if (n === 'reason' || n === 'note') X[n] = e.target.value;
    });
    m.el.addEventListener('change', (e) => { if (e.target.name === 'by') X.by = e.target.value; if (e.target.name === 'creditBy') X.creditBy = e.target.value; });
    m.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-don]')) { X.disc = true; draw(); return; }
      if (e.target.closest('[data-doff]')) { X.disc = false; X.discount = ''; draw(); return; }
      const mm = e.target.closest('[data-m]');
      if (mm) { X.method = mm.dataset.m; X.split = ''; draw(); return; }
      if (!e.target.closest('[data-ok]')) return;
      const { d, R } = calc();
      const body = { discount: d, cash: 0, card: 0, credit: 0, note: X.note };
      if (d > 0) { body.discountReason = X.reason; body.discountApprovedBy = X.by; }
      if (R > 0) {
        if (X.method === 'cash') body.cash = R;
        if (X.method === 'card') body.card = R;
        if (X.method === 'split') { body.cash = Number(X.split) || 0; body.card = HMS.money.round((R - body.cash)); }
        if (X.method === 'credit') { body.cash = Number(X.split) || 0; body.credit = HMS.money.round((R - body.cash)); body.creditApprovedBy = X.creditBy; }
      }
      try {
        const r = await api.post(`/admissions/${id}/discharge`, body);
        m.close(); S.d = r; drawAll(); window.refreshShell?.();
        if (r.order) return showOrder(r.order, { autoPrint: autoPrint() });
        const rc = r.receipts.find((x) => x.id === r.receiptId);
        const ok = modal({
          title: '',
          body: html`<div class="success"><div class="tick">${icon('check')}</div><h3>المريض خرج</h3>
            <div class="rno">${rc.kindName} رقم <b class="num">${rc.no}</b> · <b class="num">${money(Math.abs(rc.net))}</b> ${HMS.money.unitWord}</div>
            <p class="muted" style="font-weight:700;margin:10px 0 0">السرير اتعلّم «تحت التنظيف». علّمه فاضي من لوحة الأسرّة لما يجهز.</p></div>`,
          foot: html`<button class="btn ghost" data-r>${icon('receipt')} اطبع الإيصال</button><button class="btn ghost" data-i>${icon('print')} الفاتورة النهائية</button><button class="btn" data-close autofocus>تمام</button>`,
        });
        $('.modal-head h3', ok.el).remove();
        $('[data-r]', ok.el).addEventListener('click', () => printReceipt(rc.id, true));
        $('[data-i]', ok.el).addEventListener('click', () => printInvoice(id));
        if (autoPrint()) printInvoice(id);
      } catch (er) { toastError(er); }
    });
  }

  return () => { view.onclick = null; view.oninput = null; };
}
void fmtTime;
