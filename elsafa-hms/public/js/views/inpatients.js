import { api, html, icon, $, money, egp, fmtWhen, initials, ADM, can, nightsText } from '../core.js';

export async function renderInpatients(view, { setTitle }) {
  setTitle('المرضى المقيمين', 'كل اللي داخلين دلوقتي: السرير، الأيام، الحساب، واللي محتاج دفعة');
  let filter = 'all';
  view.innerHTML = String(html`<div class="pagehead">
      <div class="seg" id="f"><button data-f="all" class="on">الكل</button><button data-f="due">محتاج دفعة</button>${Object.entries(ADM).map(([k, v]) => html`<button data-f="${k}">${v.name}</button>`)}</div>
      <div class="totbar" id="tot" style="margin-inline-start:auto"></div>
      ${can('admissions.write') ? html`<a class="btn" href="#/admit">${icon('bed')} دخول جديد</a>` : ''}</div>
    <div id="list"><div class="skel" style="height:300px"></div></div>`);
  let data = [];
  const draw = () => {
    const list = data.filter((a) => filter === 'all' || (filter === 'due' ? a.needsPayment : a.type === filter));
    const due = data.filter((a) => a.needsPayment);
    $('#tot', view).innerHTML = String(html`<div class="tot"><small>داخلين</small><b class="num">${data.length}</b></div>
      <div class="tot"><small>محتاجين دفعة</small><b class="num" style="color:var(--warn)">${due.length}</b></div>
      <div class="tot"><small>المطلوب منهم</small><b>${egp(due.reduce((s, a) => s + a.balance, 0))}</b></div>`);
    $('#list', view).innerHTML = list.length ? String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>المريض</th><th>النوع</th><th>المكان</th><th class="hide-sm">الطبيب</th><th class="hide-sm">دخل</th><th class="n">الحساب</th><th class="n">المدفوع</th><th class="n">المطلوب</th></tr></thead>
      <tbody>${list.map((a) => html`<tr class="click" data-go="/admission/${a.id}">
        <td><div class="row" style="gap:10px"><span class="pavatar ${a.patient.sex || ''}" style="width:36px;height:36px;border-radius:11px;font-size:13px">${initials(a.patient.name)}</span><div><b>${a.patient.name}</b><div class="muted" style="font-size:12px"><span class="num">#${a.patient.no}</span> · دخول <span class="num">${a.no}</span></div></div></div></td>
        <td><span class="admtag t-${a.type}">${icon(ADM[a.type].icon, 'sm')} ${ADM[a.type].name}</span></td>
        <td><b>غرفة <span class="num">${a.bed.room}</span></b> · ${a.bed.label}<div class="muted" style="font-size:12px">الدور ${a.bed.floor} · ${a.bed.className}</div></td>
        <td class="hide-sm">${a.doctor || '—'}</td>
        <td class="hide-sm">${fmtWhen(a.admittedAt)}<div class="muted" style="font-size:12px">${nightsText(a.nights)}</div></td>
        <td class="n">${egp(a.total)}</td><td class="n" style="color:var(--ok)">${egp(a.paid)}</td>
        <td class="n">${a.needsPayment ? html`<span class="badge warn" style="height:26px;font-size:13px"><span class="num">${money(a.balance)}</span> ${HMS.money.symbol}</span>` : html`<span class="badge ok">مغطى</span>`}</td>
      </tr>`)}</tbody></table></div></div>`)
      : String(html`<div class="card empty"><div class="art">${icon('bed')}</div><b>${data.length ? 'مفيش حد هنا' : 'مفيش مرضى داخلين دلوقتي'}</b></div>`);
  };
  view.onclick = (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; view.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b === f)); draw(); }
    const r = e.target.closest('[data-go]');
    if (r) go(r.dataset.go);
  };
  data = (await api.get('/admissions/active')).admissions;
  draw();
  return () => { view.onclick = null; };
}
