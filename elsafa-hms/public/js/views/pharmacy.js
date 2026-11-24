// الصيدلية: بيع للمرضى (نقدي أو تعاقد)، والبيع بيتحصّل في الصيدلية نفسها
import { api, html, icon, $, money, egp, fmtTime, initials, modal, toast, toastError, debounce, ApiError } from '../core.js';

export async function renderPharmacy(view, { setTitle }) {
  setTitle('الصيدلية', 'بيع وتحصيل ومرتجع');
  view.innerHTML = String(html`<div class="ph-top card">
      <div class="ph-search"><div class="big-search">${icon('search')}<input class="input" id="pq" type="search" autocomplete="off" placeholder="اسم المريض، التليفون، أو رقم الملف" style="height:54px;font-size:17px;padding-inline-start:48px;border-radius:15px"></div>
        <button class="btn lg" id="pnew" style="--c:#d6336c">${icon('user-plus')} عميل جديد</button></div>
      <div id="pres"></div></div>
    <div class="row wrap" style="gap:10px;margin:16px 0 10px"><h3 style="margin:0">${icon('receipt')} بيع النهارده</h3><span class="spacer"></span><a class="btn ghost sm" href="#/stores?tab=reports&r=pharmacy">${icon('chart', 'sm')} تقرير البيع</a><a class="btn ghost sm" href="#/stores">${icon('box', 'sm')} رصيد الصيدلية</a></div>
    <div id="ptoday"><div class="skel" style="height:160px"></div></div>`);
  const open = async (patientId) => {
    try {
      const r = await api.post('/visits', { patientId, type: 'pharmacy', forceNew: true });
      window.go('/visit/' + r.visit.id);
    } catch (e) { toastError(e); }
  };
  let results = [];
  const search = debounce(async () => {
    const q = $('#pq', view).value.trim();
    if (!q) { $('#pres', view).innerHTML = ''; results = []; return; }
    results = (await api.get('/patients/search?q=' + encodeURIComponent(q))).results.slice(0, 8);
    $('#pres', view).innerHTML = String(html`<div class="ph-res">${results.map((p, i) => html`<button class="ph-p ${i === 0 ? 'sel' : ''}" data-p="${p.id}"><span class="pavatar ${p.sex || ''}" style="width:38px;height:38px;border-radius:12px;font-size:13px">${initials(p.name)}</span>
        <div><b>${p.name}</b><small>ملف <span class="num">${p.no}</span>${p.phone ? html` · <span class="num">${p.phone}</span>` : ''}${p.payer ? html` · ${p.payer.name}` : ''}</small></div>${icon('chev-left', 'sm')}</button>`)}
      ${!results.length ? html`<div class="muted" style="padding:10px;font-weight:700">مفيش مريض بالاسم ده. دوس «عميل جديد».</div>` : ''}</div>`);
  }, 200);
  view.oninput = (e) => { if (e.target.id === 'pq') search(); };
  view.onkeydown = (e) => { if (e.target.id === 'pq' && e.key === 'Enter' && results[0]) open(results[0].id); };
  view.onclick = (e) => {
    const p = e.target.closest('[data-p]');
    if (p) return open(Number(p.dataset.p));
    if (e.target.closest('#pnew')) {
      const m = modal({
        title: 'عميل جديد',
        body: html`<div class="field" data-f="name"><label>الاسم <span class="req">*</span></label><input class="input" name="name" value="${$('#pq', view).value}" autofocus><div class="msg"></div></div>
          <div class="field" style="margin-top:10px"><label>التليفون <span class="hint">اختياري</span></label><input class="input num" name="phone" inputmode="tel"></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok style="--c:#d6336c">${icon('check')} ابدأ البيع</button>`,
      });
      const go = async () => {
        try {
          const r = await api.post('/patients', { mode: 'quick', name: $('[name=name]', m.el).value, phone: $('[name=phone]', m.el).value, confirmDuplicatePhone: true });
          m.close(); open(r.patient.id);
        } catch (er) {
          if (er instanceof ApiError && er.data.errors?.name) { const f = $('[data-f=name]', m.el); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.name; } else toastError(er);
        }
      };
      $('[data-ok]', m.el).addEventListener('click', go);
      m.el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    }
  };
  // بيع النهارده (إيصالات الصيدلية بتاعتي)
  try {
    const r = await api.get('/receipts?mine=1');
    const list = r.receipts.filter((x) => x.visitType === 'pharmacy');
    const net = list.reduce((s, x) => s + x.net, 0);
    $('#ptoday', view).innerHTML = !list.length ? String(html`<div class="card empty"><div class="art" style="background:#fde8ef;color:#d6336c">${icon('pill')}</div><b>لسه مفيش بيع النهارده</b></div>`)
      : String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>إيصال</th><th>العميل</th><th>الساعة</th><th class="n">المبلغ</th></tr></thead><tbody>
        ${list.map((x) => html`<tr class="click ${x.net < 0 ? 'refund' : ''}" data-v="${x.visitId}"><td class="num">${x.no}</td><td>${x.patient.name}</td><td class="muted">${fmtTime(x.createdAt)}</td><td class="n">${x.net < 0 ? html`<b>مرتجع ${egp(-x.net)}</b>` : html`<b>${egp(x.net)}</b>`}</td></tr>`)}
        </tbody></table></div><div class="tk-total" style="margin:6px"><span>صافي بيع النهارده (إيصالاتي)</span><b>${egp(net)}</b></div></div>`);
    $('#ptoday', view).onclick = (e) => { const v = e.target.closest('[data-v]'); if (v) window.go('/visit/' + v.dataset.v); };
  } catch { $('#ptoday', view).innerHTML = ''; }
  setTimeout(() => $('#pq', view)?.focus(), 40);
  return () => { view.oninput = view.onkeydown = view.onclick = null; };
}
void money;
