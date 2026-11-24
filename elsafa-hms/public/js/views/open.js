import { api, html, icon, $, money, egp, ago, initials, DEPT } from '../core.js';

export async function renderOpenVisits(view, { setTitle }) {
  setTitle('الزيارات المفتوحة', 'أي زيارة لسه عليها فلوس بتفضل هنا لحد ما تتحاسب');
  let filter = 'due';
  view.innerHTML = String(html`
    <div class="pagehead">
      <div class="seg" id="flt">
        <button data-f="due" class="on">عليها حساب</button>
        <button data-f="all">كل المفتوحة</button>
      </div>
      <div class="totbar" id="tot" style="margin-inline-start:auto"></div>
    </div>
    <div id="list"><div class="skel" style="height:300px"></div></div>`);
  let data = [];
  const draw = () => {
    const list = filter === 'due' ? data.filter((v) => v.due > 0) : data;
    const due = data.reduce((s, v) => s + v.due, 0);
    $('#tot').innerHTML = String(html`
      <div class="tot"><small>زيارات عليها حساب</small><b class="num">${data.filter((v) => v.due > 0).length}</b></div>
      <div class="tot"><small>مستني يتحصّل</small><b>${egp(due)}</b></div>`);
    $('#list').innerHTML = list.length ? String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>المريض</th><th>القسم</th><th class="hide-sm">اتفتحت</th><th class="n">الخدمات</th><th class="n">الإجمالي</th><th class="n">الباقي</th><th></th></tr></thead>
      <tbody>${list.map((v) => html`<tr class="click" data-go="/visit/${v.id}">
        <td><div class="row" style="gap:10px"><span class="pavatar" style="width:36px;height:36px;border-radius:11px;font-size:13px">${initials(v.patient.name)}</span><div><b>${v.patient.name}</b><div class="muted" style="font-size:12.5px"><span class="num">#${v.patient.no}</span> · زيارة <span class="num">${v.no}</span></div></div></div></td>
        <td><span class="dtag d-${v.type}">${icon(DEPT[v.type].icon)} ${DEPT[v.type].short}</span></td>
        <td class="hide-sm"><span>${ago(v.openedAt)}</span><div class="muted" style="font-size:12px">${v.openedBy}</div></td>
        <td class="n num">${v.items}</td>
        <td class="n">${egp(v.total)}</td>
        <td class="n">${v.due > 0 ? html`<span class="badge warn" style="font-size:13px;height:26px"><span class="num">${money(v.due)}</span> ${HMS.money.symbol}</span>` : html`<span class="badge ok">خالص</span>`}</td>
        <td class="n"><span class="btn soft sm">${icon('wallet', 'sm')} حاسب</span></td>
      </tr>`)}</tbody></table></div></div>`)
      : String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>كله متحاسب</b>مفيش زيارات عليها فلوس دلوقتي</div>`);
  };
  const load = async () => { data = (await api.get('/visits/open')).visits; draw(); window.refreshShell?.(); };
  view.onclick = (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; view.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b === f)); draw(); }
    const r = e.target.closest('[data-go]');
    if (r) go(r.dataset.go);
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 60000);
  return () => { clearInterval(t); view.onclick = null; };
}
