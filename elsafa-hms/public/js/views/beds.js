// لوحة الأسرّة: كل دور وتحته الغرف، وكل سرير بلون حالته
import { KIND_ICON, api, html, icon, $, money, initials, ADM, KIND, BED_ST, modal, toast, toastError, can, stayDays, nightsText } from '../core.js';


/**
 * يرسم اللوحة جوه container
 *  mode: 'view' (الصفحة) | 'pick' (اختيار سرير للدخول/التحويل)
 *  kind: فلتر نوع الغرف (ward/icu/nursery) أو null للكل
 *  onPick(bed): لما يختار سرير فاضي في وضع pick
 */
export async function bedBoard(container, { mode = 'view', kind = null, onPick, selectedId = null, lockKind = false } = {}) {
  const S = { data: null, kind, cls: null, floor: 'all', q: '', sel: selectedId };
  const draw = () => {
    const d = S.data;
    const k = S.kind;
    // درجات الغرف المتاحة (جوه النوع المختار)، بالترتيب اللي ظهرت بيه
    const clsList = [];
    for (const f of d.floors) for (const r of f.rooms) if ((!k || r.cls.kind === k) && !clsList.some((c) => c.id === r.cls.id)) clsList.push(r.cls);
    if (S.cls && !clsList.some((c) => String(c.id) === String(S.cls))) S.cls = null;
    const floors = d.floors.map((f) => ({ ...f, rooms: f.rooms.filter((r) => (!k || r.cls.kind === k) && (!S.cls || String(r.cls.id) === String(S.cls))) })).filter((f) => f.rooms.length);
    const allBeds = floors.flatMap((f) => f.rooms.flatMap((r) => r.beds));
    const cnt = (st) => allBeds.filter((b) => b.status === st).length;
    const shown = S.floor === 'all' ? floors : floors.filter((f) => String(f.id) === S.floor);
    const q = S.q.trim();
    container.innerHTML = String(html`
      <div class="bb-bar">
        ${lockKind ? '' : html`<div class="seg" data-k>
          <button class="${!k ? 'on' : ''}" data-kind="">الكل</button>
          ${Object.entries(KIND).map(([kk, n]) => html`<button class="${k === kk ? 'on' : ''}" data-kind="${kk}">${icon(KIND_ICON[kk], 'sm')}${n}</button>`)}
        </div>`}
        ${clsList.length > 1 ? html`<div class="bb-floors" data-cls-bar><button class="chip ${!S.cls ? 'on' : ''}" data-cls="">كل الدرجات</button>${clsList.map((c) => html`<button class="chip ${String(S.cls) === String(c.id) ? 'on' : ''}" data-cls="${c.id}">${c.name}</button>`)}</div>` : ''}
        <div class="bb-floors">${[{ id: 'all', name: 'كل الأدوار' }, ...floors].map((f) => html`<button class="chip ${String(S.floor) === String(f.id) ? 'on' : ''}" data-floor="${f.id}">${f.id === 'all' ? f.name : html`الدور <b class="num">${f.no}</b>`}</button>`)}</div>
        <span class="spacer"></span>
        <div class="bb-legend">${Object.entries(BED_ST).map(([st, v]) => html`<span class="lg st-${st}"><i></i>${v.name} <b class="num">${cnt(st)}</b></span>`)}</div>
      </div>
      ${mode === 'view' ? html`<div class="big-search" style="max-width:380px;margin-bottom:12px">${icon('search')}<input class="input" id="bq" type="search" value="${S.q}" placeholder="دوّر على مريض داخل أو رقم غرفة" style="height:42px;font-size:14.5px;padding-inline-start:42px;border-radius:12px"></div>` : ''}
      ${!shown.length ? html`<div class="card empty"><div class="art">${icon('bed')}</div><b>مفيش غرف هنا</b>${can('settings.manage') ? html`ضيف الغرف والأسرّة من <a href="#/settings?tab=rooms" class="linkbtn">الإعدادات ← الغرف والأسرّة</a>` : 'المدير يضيف الغرف من الإعدادات'}</div>` : ''}
      ${shown.map((f) => html`<section class="bb-floor">
        <h3 class="bb-fh"><span class="fno num">${f.no}</span>${f.name}<small>${f.rooms.flatMap((r) => r.beds).filter((b) => b.status === 'free').length} فاضي من ${f.rooms.flatMap((r) => r.beds).length}</small></h3>
        <div class="bb-rooms">${f.rooms.map((r) => html`<div class="bb-room k-${r.cls.kind} ${q && !roomMatch(r, q) ? 'dim' : ''}">
          <div class="bb-rh"><span class="rno">${icon(KIND_ICON[r.cls.kind], 'sm')}<b class="num">${r.no}</b></span><span class="rc">${r.cls.name}</span>
            ${r.cls.nightPrice == null ? html`<span class="badge warn" title="المدير يحدد السعر من الإعدادات">${icon('alert', 'sm')} من غير سعر</span>` : html`<span class="rp"><span class="num">${money(r.cls.nightPrice)}</span> ${HMS.money.symbol}/ليلة</span>`}</div>
          <div class="bb-beds">${r.beds.map((b) => bedTile(b, mode, S.sel, q))}</div>
        </div>`)}</div>
      </section>`)}`);
  };
  S.data = await api.get('/admissions/beds/board');
  draw();
  container.onclick = async (e) => {
    const kb = e.target.closest('[data-kind]');
    if (kb) { S.kind = kb.dataset.kind || null; S.floor = 'all'; draw(); return; }
    const cb = e.target.closest('[data-cls]');
    if (cb) { S.cls = cb.dataset.cls || null; S.floor = 'all'; draw(); return; }
    const fb = e.target.closest('[data-floor]');
    if (fb) { S.floor = fb.dataset.floor; draw(); return; }
    const t = e.target.closest('[data-bed]');
    if (!t) return;
    const bed = S.data.floors.flatMap((f) => f.rooms.flatMap((r) => r.beds.map((b) => ({ ...b, roomCls: r.cls, roomNo: r.no, floorNo: f.no })))).find((b) => b.id === Number(t.dataset.bed));
    if (mode === 'pick') {
      if (bed.status === 'free' || bed.status === 'reserved') {
        if (bed.roomCls.nightPrice == null) return toast('سعر الليلة للدرجة دي لسه ما اتحددش. المدير يحدده من الإعدادات.', 'warn', 5000);
        S.sel = bed.id; draw(); onPick?.(bed);
      } else toast(bed.status === 'cleaning' ? 'السرير ده تحت التنظيف' : 'السرير ده مشغول', 'warn');
      return;
    }
    bedAction(bed, async () => { S.data = await api.get('/admissions/beds/board'); draw(); });
  };
  container.oninput = (e) => { if (e.target.id === 'bq') { S.q = e.target.value; const pos = e.target.selectionStart; draw(); const i = $('#bq', container); i.focus(); i.setSelectionRange(pos, pos); } };
  return { reload: async () => { S.data = await api.get('/admissions/beds/board'); draw(); }, setKind: (k) => { S.kind = k; S.sel = null; draw(); } };
}

function roomMatch(r, q) {
  const k = q.replace(/[أإآ]/g, 'ا');
  return r.no.includes(q) || r.beds.some((b) => b.admission && (b.admission.patient.name.replace(/[أإآ]/g, 'ا').includes(k) || String(b.admission.patient.no) === q));
}

function bedTile(b, mode, sel, q) {
  const a = b.admission;
  const pickable = mode === 'pick' && (b.status === 'free' || b.status === 'reserved');
  const hit = q && a && (a.patient.name.includes(q) || String(a.patient.no) === q);
  return html`<button class="bed st-${b.status} ${pickable ? 'pickable' : ''} ${sel === b.id ? 'sel' : ''} ${hit ? 'hit' : ''}" data-bed="${b.id}" title="${BED_ST[b.status].name}${b.note ? ' · ' + b.note : ''}">
    <span class="bl">${b.label}</span>
    ${a ? html`<span class="bp ${a.patient.sex || ''}">${initials(a.patient.name)}</span><span class="bn">${a.patient.name.split(' ').slice(0, 2).join(' ')}</span>
        <span class="bt">${ADM[a.type].name} · ${nightsText(stayDays(a.admittedAt))}</span>
        ${a.closed ? html`<span class="btk closed" title="التذكرة اتقفلت">${icon('lock', 'sm')}</span>` : mode === 'view' && can('adm.bill') && !a.ticketToday ? html`<span class="btk none" title="لسه ما اتكتبش تذكرة النهارده">${icon('ticket', 'sm')}</span>` : ''}`
      : html`<span class="bi">${icon(BED_ST[b.status].icon)}</span><span class="bn">${BED_ST[b.status].name}</span>${b.note ? html`<span class="bt">${b.note}</span>` : ''}`}
    ${sel === b.id ? html`<span class="tick">${icon('check', 'sm')}</span>` : ''}
  </button>`;
}

/** لما يدوس على سرير في اللوحة */
function bedAction(bed, refresh) {
  if (bed.admission) return go('/admission/' + bed.admission.id);
  const st = bed.status;
  const where = html`<div class="pricehead" style="--ds:var(--bg-2);--dc:var(--brand)"><span class="dicon">${icon(KIND_ICON[bed.roomCls.kind])}</span><div><b>غرفة ${bed.roomNo} · سرير ${bed.label}</b><small>الدور ${bed.floorNo} · ${bed.roomCls.name}</small></div>
    <div class="cur"><small>الحالة</small><b style="font-size:16px">${BED_ST[st].name}</b></div></div>`;
  const acts = [];
  if (st === 'free' || st === 'reserved') acts.push(html`<button class="btn" data-a="admit">${icon('bed')} دخّل مريض هنا</button>`);
  if (st === 'cleaning') acts.push(html`<button class="btn" data-a="free" style="--c:var(--ok)">${icon('check')} خلص تنظيف، بقى فاضي</button>`);
  if (st === 'free') acts.push(html`<button class="btn soft" data-a="reserve" style="--c:var(--radiology)">${icon('clock')} احجزه</button>`);
  if (st === 'reserved') acts.push(html`<button class="btn ghost" data-a="free">${icon('x')} شيل الحجز</button>`);
  if (st === 'free' && can('admissions.override')) acts.push(html`<button class="btn ghost" data-a="cleaning">علّمه تحت التنظيف</button>`);
  const m = modal({
    title: 'السرير',
    body: html`${where}${bed.note ? html`<div class="alertbar info" style="margin-top:10px">${icon('info')}<span>${bed.note}</span></div>` : ''}
      <div class="field hide" id="rv" style="margin-top:12px" data-f="note"><label>محجوز لمين؟ <span class="req">*</span></label><input class="input" name="note" placeholder="مثلًا: حالة د. سارة بكرة الصبح"><div class="msg"></div></div>`,
    foot: html`<button class="btn ghost" data-close>رجوع</button>${acts}`,
  });
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'admit') { m.close(); go(`/admit?bed=${bed.id}`); return; }
    if (a === 'reserve' && $('#rv', m.el).classList.contains('hide')) { $('#rv', m.el).classList.remove('hide'); $('[name=note]', m.el).focus(); b.textContent = 'احفظ الحجز'; return; }
    try {
      await api.post(`/admissions/beds/${bed.id}/status`, { status: a === 'reserve' ? 'reserved' : a, note: $('[name=note]', m.el).value });
      m.close(); toast(a === 'free' ? 'السرير بقى فاضي' : a === 'reserve' ? 'اتحجز السرير' : 'اتغيرت الحالة'); refresh();
    } catch (er) {
      if (er.data?.errors?.note) { $('#rv', m.el).classList.add('err'); $('#rv .msg', m.el).textContent = er.data.errors.note; } else toastError(er);
    }
  });
}

export async function renderBeds(view, { setTitle, query }) {
  setTitle('لوحة الأسرّة', 'دوس على أي سرير: فاضي تدخّل عليه، مشغول تفتح حسابه، تحت التنظيف تعلّمه فاضي');
  view.innerHTML = String(html`<div class="row wrap" style="margin-bottom:14px;gap:10px">
      <div class="totbar" id="bstats"></div><span class="spacer"></span>
      ${can('admissions.write') ? html`<a class="btn" href="#/admit">${icon('bed')} دخول جديد</a>` : ''}
      <a class="btn ghost" href="#/inpatients">${icon('users')} المرضى المقيمين</a></div>
    <div id="board"><div class="skel" style="height:420px"></div></div>`);
  const b = await bedBoard($('#board', view), { kind: query.get('kind') || null });
  const stats = async () => {
    const d = await api.get('/admissions/beds/board');
    const c = d.counts;
    $('#bstats', view).innerHTML = String(html`
      <div class="tot"><small>الأسرّة</small><b class="num">${c.total}</b></div>
      <div class="tot" style="background:linear-gradient(135deg,#fff,var(--ok-soft))"><small>فاضي</small><b class="num" style="color:var(--ok)">${c.free}</b></div>
      <div class="tot"><small>مشغول</small><b class="num" style="color:var(--brand)">${c.occupied}</b></div>
      <div class="tot"><small>نسبة الإشغال</small><b class="num">${c.total ? Math.round((c.occupied / c.total) * 100) : 0}%</b></div>`);
  };
  await stats();
  const t = setInterval(() => { if (!document.querySelector('.overlay')) { b.reload().catch(() => {}); stats().catch(() => {}); } }, 60000);
  return () => clearInterval(t);
}
