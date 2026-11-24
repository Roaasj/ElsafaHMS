// التقارير: تقرير الخزينة اليومي، الورديات، الخصومات والآجل، مستحقات الأطباء
import { DEPT, ADM, soft, api, html, icon, $, money, egp, fmtTime, fmtWhen, can, openPrint, printShift, printReceipt } from '../core.js';

const secCls = (k) => (DEPT[k] || k === 'pharmacy' ? `d-${k}` : 'd-admit');
const secStyle = (k) => (!DEPT[k] && ADM[k]?.color ? `--dc:${ADM[k].color};--ds:${soft(ADM[k].color)}` : '');
const today = () => {
  const d = new Date(); const p = new Intl.DateTimeFormat('en-GB', { timeZone: HMS.tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
  const m = (Number(p.find((x) => x.type === 'hour').value) % 24) * 60 + Number(p.find((x) => x.type === 'minute').value);
  return new Date(d.getTime() - (m < HMS.dayStart ? 12 * 3600e3 : 0)).toLocaleDateString('en-CA', { timeZone: HMS.tz });
};

export async function renderReports(view, { query, setTitle }) {
  const TABS = [['treasury', 'تقرير الخزينة', 'cashbox'], ['shifts', 'الورديات', 'clock'],
    ...(can('reports.shifts') ? [['discounts', 'الخصومات والآجل', 'percent'], ['doctors', 'مستحقات الأطباء', 'steth']] : [])];
  const tab = TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'treasury';
  setTitle('التقارير', { treasury: 'اليوم بيبدأ 8 الصبح، والسهر على اليوم اللي بدأ فيه', shifts: 'تقفيل كل وردية والتسليم', discounts: 'كل خصم وآجل بسببه واسم اللي وافق', doctors: 'نسب الأطباء من الإيصالات' }[tab]);
  const S = { date: query.get('date') || today(), to: query.get('to') || query.get('date') || today(), shift: query.get('shift') || '' };
  view.innerHTML = String(html`<nav class="stabs">${TABS.map(([k, n, ic]) => html`<a href="#/reports?tab=${k}&date=${S.date}" class="stab ${k === tab ? 'on' : ''}">${icon(ic)}<span>${n}</span></a>`)}${can('reports.stock') ? html`<a href="#/stores?tab=reports" class="stab">${icon('box')}<span>تقارير المخزن</span></a>` : ''}</nav>
    <div class="card pad row wrap rfilters" style="gap:10px;margin-bottom:14px">
      <button class="btn ghost icon" data-day="-1" title="اليوم اللي قبله">${icon('chev-right')}</button>
      <label class="row" style="gap:6px;font-weight:700">${['discounts', 'doctors'].includes(tab) ? 'من' : 'اليوم'} <input class="input" type="date" id="d1" value="${S.date}" style="width:auto"></label>
      ${['discounts', 'doctors'].includes(tab) ? html`<label class="row" style="gap:6px;font-weight:700">لـ <input class="input" type="date" id="d2" value="${S.to}" style="width:auto"></label>` : html`<button class="btn ghost icon" data-day="1" title="اليوم اللي بعده">${icon('chev-left')}</button>`}
      ${tab === 'treasury' ? html`<select class="select" id="shf" style="width:auto;min-width:200px"><option value="">كل الورديات</option></select>` : ''}
      <span class="spacer"></span>
      ${tab === 'treasury' ? html`<button class="btn ghost" id="xl">${icon('download')} إكسل</button><button class="btn" id="pr">${icon('print')} اطبع التقرير</button>` : ''}
    </div>
    <div id="rp"><div class="skel" style="height:300px"></div></div>`);
  const pane = $('#rp', view);

  const loaders = {
    async treasury() {
      const r = await api.get(`/reports/treasury?date=${S.date}${S.shift ? '&shift=' + S.shift : ''}`);
      const sel = $('#shf', view);
      if (sel && !S.shift) sel.innerHTML = String(html`<option value="">كل الورديات (${r.shifts.length})</option>${r.shifts.map((x) => html`<option value="${x.id}">${x.labelName} · ${x.name} · ${fmtTime(x.openedAt)}</option>`)}`);
      const t = r.totals;
      pane.innerHTML = String(html`
        <div class="tgrand">
          <div class="tg main"><small>صافي الخزينة</small><b class="num">${money(t.net)}</b><span>${t.count} إيصال${t.out ? ` · مرتجعات ${money(t.out)}` : ''}</span></div>
          <div class="tg"><small>${icon('cash', 'sm')} نقدي</small><b class="num">${money(t.cash)}</b></div>
          <div class="tg"><small>${icon('card', 'sm')} فيزا</small><b class="num">${money(t.card)}</b></div>
          <div class="tg"><small>${icon('hourglass', 'sm')} آجل</small><b class="num">${money(t.credit)}</b></div>
          <div class="tg"><small>${icon('percent', 'sm')} خصومات</small><b class="num">${money(t.discount)}</b></div>
        </div>
        ${r.missingManual ? html`<div class="alertbar warn" style="margin:0 0 12px">${icon('info')}<span><b class="num">${r.missingManual}</b> إيصال من غير رقم إيصال يدوي</span></div>` : ''}
        ${r.sections.length ? r.sections.map((s) => html`<section class="card tsec">
          <div class="tsech ${secCls(s.key)}" style="${secStyle(s.key)}"><span class="dot"></span><b>${s.name}</b><span class="muted">${s.totals.count} إيصال</span><span class="spacer"></span>
            <span class="tsm">نقدي <b class="num">${money(s.totals.cash)}</b></span>${s.totals.card ? html`<span class="tsm">فيزا <b class="num">${money(s.totals.card)}</b></span>` : ''}${s.totals.credit ? html`<span class="tsm">آجل <b class="num">${money(s.totals.credit)}</b></span>` : ''}
            <b class="num tsn">${money(s.totals.net)}</b></div>
          <div class="table-wrap"><table class="table tt"><thead><tr><th>الإيصال</th><th>اليدوي</th><th class="hide-sm">الوقت</th><th>المريض</th><th class="hide-sm">الخدمة</th><th class="n hide-sm">نقدي</th><th class="n hide-sm">فيزا</th><th class="n">القيمة</th><th></th></tr></thead><tbody>
            ${s.rows.map((x) => html`<tr class="${x.net < 0 ? 'refund' : ''}"><td class="num">${x.no}${x.net < 0 ? html` <span class="badge danger" style="height:18px;font-size:10.5px">${x.kindName}</span>` : ''}</td>
              <td class="num">${x.manualNo || html`<span class="muted">—</span>`}</td><td class="hide-sm nw">${fmtTime(x.at)}</td><td><b>${x.patient}</b><div class="muted show-sm" style="font-size:12px">${x.service}</div></td>
              <td class="hide-sm" style="max-width:320px">${x.service}</td><td class="n hide-sm">${x.cash ? money(x.cash) : ''}</td><td class="n hide-sm">${x.card ? money(x.card) : ''}</td>
              <td class="n"><b>${money(x.net)}</b>${x.credit ? html`<div class="muted" style="font-size:11.5px">آجل ${money(x.credit)}</div>` : ''}</td>
              <td class="n"><button class="btn ghost icon sm" data-rprint="${x.id}" title="اطبع">${icon('print', 'sm')}</button></td></tr>`)}</tbody></table></div>
        </section>`) : html`<div class="card empty"><div class="art">${icon('receipt')}</div><b>مفيش إيصالات في اليوم ده</b></div>`}`);
    },
    async shifts() {
      const r = await api.get(`/reports/shifts?date=${S.date}`);
      pane.innerHTML = r.shifts.length ? String(html`<div class="shgrid">${r.shifts.map((s) => html`<article class="card shcard ${s.closedAt ? '' : 'open'}">
        <div class="row" style="gap:10px"><span class="lbl l-${s.label}">${s.labelName}</span><div style="min-width:0"><b>${s.user.name}</b><small class="muted" style="display:block;font-weight:600">${fmtTime(s.openedAt)} ← ${s.closedAt ? fmtTime(s.closedAt) : 'لسه مفتوحة'}</small></div>
          <button class="btn ghost icon sm" data-sprint="${s.id}" style="margin-inline-start:auto" title="اطبع التسليم">${icon('print', 'sm')}</button></div>
        <div class="shnums"><div><small>إيصالات</small><b class="num">${s.receipts}</b></div><div><small>المفروض</small><b class="num">${money(s.expected)}</b></div>
          <div><small>اتسلّم</small><b class="num">${s.counted == null ? '—' : money(s.counted)}</b></div><div><small>فيزا</small><b class="num">${money(s.card)}</b></div></div>
        ${s.diff ? html`<div class="apnote ${s.diff < 0 ? 'rejected' : 'approved'}">${s.diff < 0 ? 'عجز' : 'زيادة'} <b class="num">${money(Math.abs(s.diff))}</b>${s.diffReason ? ' · ' + s.diffReason : ''}</div>` : ''}
        ${s.closedAt ? (s.handedTo ? html`<div class="handline ${s.receivedAt ? 'ok' : ''}">${icon(s.receivedAt ? 'check' : 'hourglass', 'sm')} ${s.receivedAt ? `استلم ${s.receivedBy} ${fmtTime(s.receivedAt)}` : `مستني ${s.handedTo.name} يأكد الاستلام`}</div>` : html`<div class="handline ok">${icon('check', 'sm')} مفيش نقدية</div>`) : html`<div class="handline">${icon('clock', 'sm')} الوردية شغالة</div>`}
      </article>`)}</div>`) : String(html`<div class="card empty"><div class="art">${icon('clock')}</div><b>مفيش ورديات في اليوم ده</b></div>`);
    },
    async discounts() {
      const r = await api.get(`/reports/discounts?from=${S.date}&to=${S.to}`);
      pane.innerHTML = String(html`<div class="totbar" style="margin-bottom:12px"><div class="tot"><small>إجمالي الخصومات</small><b class="num" style="color:var(--warn)">${money(r.totals.discount)}</b></div><div class="tot"><small>إجمالي الآجل</small><b class="num">${money(r.totals.credit)}</b></div><div class="tot"><small>عدد الإيصالات</small><b class="num">${r.rows.length}</b></div></div>
        ${r.rows.length ? html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>الوقت</th><th>الإيصال</th><th>المريض</th><th class="n">خصم</th><th>السبب / الموافقة</th><th class="n">آجل</th><th class="hide-sm">الموظف</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr><td class="nw">${fmtWhen(x.at)}</td><td class="num">${x.no}</td><td><b>${x.patient}</b></td><td class="n">${x.discount ? egp(x.discount) : ''}</td>
          <td>${x.discountReason || x.note || ''}${x.discountBy || x.creditBy ? html`<div class="muted" style="font-size:12px">بموافقة ${x.discountBy || x.creditBy}</div>` : ''}</td><td class="n">${x.credit ? egp(x.credit) : ''}</td><td class="hide-sm">${x.by}</td></tr>`)}</tbody></table></div></div>`
        : html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش خصومات ولا آجل</b></div>`}`);
    },
    async doctors() {
      const r = await api.get(`/reports/doctors?from=${S.date}&to=${S.to}`);
      const max = Math.max(1, ...r.rows.map((x) => x.amount));
      pane.innerHTML = String(html`<div class="totbar" style="margin-bottom:12px"><div class="tot"><small>إجمالي المستحق</small><b class="num">${money(r.totals.amount)}</b></div><div class="tot"><small>منه بعد تحصيل التعاقد</small><b class="num" style="color:var(--py)">${money(r.totals.payerPart)}</b></div></div>
        ${r.rows.length ? html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>الدكتور</th><th class="n">الخدمات</th><th class="n hide-sm">الأساس</th><th class="n hide-sm" title="المستحق ÷ الأساس. بتشمل المبالغ الثابتة">النسبة الفعلية</th><th style="width:30%" class="hide-sm"></th><th class="n">المستحق</th><th class="n">بعد التعاقد</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr><td><b>${x.name}</b><div class="muted" style="font-size:12px">${x.specialty || ''}</div></td><td class="n">${x.count}</td><td class="n hide-sm">${money(x.base)}</td><td class="n hide-sm num">${x.base > 0 ? Math.round((x.amount / x.base) * 1000) / 10 + '%' : '—'}</td>
          <td class="hide-sm"><div class="hbar"><i style="width:${Math.round((x.amount / max) * 100)}%"></i></div></td><td class="n"><b>${egp(x.amount)}</b></td><td class="n" style="color:var(--py)">${x.payerPart ? money(x.payerPart) : ''}</td></tr>`)}</tbody></table></div></div>`
        : html`<div class="card empty"><div class="art">${icon('steth')}</div><b>مفيش مستحقات في الفترة دي</b></div>`}`);
    },
  };
  const load = () => loaders[tab]().catch((e) => { pane.innerHTML = String(html`<div class="card empty"><b>${e.message}</b></div>`); });
  const setDate = (d) => { S.date = d; if (S.to < d) S.to = d; S.shift = ''; $('#d1', view).value = d; if ($('#d2', view)) $('#d2', view).value = S.to; load(); };
  view.onchange = (e) => {
    if (e.target.id === 'd1') setDate(e.target.value);
    if (e.target.id === 'd2') { S.to = e.target.value; load(); }
    if (e.target.id === 'shf') { S.shift = e.target.value; load(); }
  };
  view.onclick = (e) => {
    const dd = e.target.closest('[data-day]');
    if (dd) { const d = new Date(S.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(dd.dataset.day)); setDate(d.toISOString().slice(0, 10)); return; }
    if (e.target.closest('#pr')) return openPrint(`/print/treasury?date=${S.date}${S.shift ? '&shift=' + S.shift : ''}&auto=1`, 'treasury');
    if (e.target.closest('#xl')) { location.href = `/api/reports/treasury?date=${S.date}${S.shift ? '&shift=' + S.shift : ''}&format=xlsx`; return; }
    const sp = e.target.closest('[data-sprint]');
    if (sp) return printShift(sp.dataset.sprint);
    const rp = e.target.closest('[data-rprint]');
    if (rp) printReceipt(rp.dataset.rprint, false);
  };
  await load();
  return () => { view.onchange = view.onclick = null; };
}
