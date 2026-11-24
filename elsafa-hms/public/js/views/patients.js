import { api, html, raw, icon, $, $$, money, egp, fmtWhen, fmtDate, initials, sexName, DEPT, DEPT_KEYS, ADM, nightsText, modal, toast, toastError, debounce, can, ApiError, state } from '../core.js';
import { parseNationalId, ageText } from '/shared/nid.js';
import { pickPayer } from './pickers.js';
import { patientRadiology } from './radiology.js';
import { patientLab } from './lab.js';
import { peerPanel, openPeerSearch } from './peer.js';

const RECENT_KEY = 'recentPatients';
function remember(p) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x.id !== p.id);
    list.unshift({ id: p.id, no: p.no, name: p.name, sex: p.sex });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* */ }
}
function recents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }

export async function openVisit(patientId, type) {
  try {
    const v = await api.post('/visits', { patientId, type });
    if (v.reused) toast('فيه زيارة مفتوحة النهارده بنفس النوع، كمّلنا عليها', 'info');
    if (v.warn) toast(v.warn, 'warn');
    go('/visit/' + v.visit.id);
  } catch (e) { toastError(e); }
}

const quickVisitBtns = (p) => html`<div class="quickv">${DEPT_KEYS.map((k) => html`
  <button class="d-${k}" data-visit="${k}" data-pid="${p.id}" title="افتح زيارة ${DEPT[k].short}">${icon(DEPT[k].icon)}<span>${DEPT[k].short}</span></button>`)}</div>`;

function pcard(p) {
  return html`<div class="pcard" data-pid="${p.id}">
    <span class="pavatar ${p.sex || ''}">${initials(p.name)}</span>
    <a class="who" href="#/patient/${p.id}" style="text-decoration:none;min-width:0">
      <div class="row" style="gap:8px"><b>${p.name}</b><span class="fileno num">#${p.no}</span>${p.admissionId ? html`<span class="badge brand">${icon('bed', 'sm')} داخل</span>` : ''}${p.incomplete ? html`<span class="badge warn">بيانات ناقصة</span>` : ''}${p.due > 0 ? html`<span class="badge warn dot">عليه <span class="num">${money(p.due)}</span> ${HMS.money.symbol}</span>` : ''}</div>
      <div class="meta">${p.phone ? html`<span>${icon('phone', 'sm')}<span class="num">${p.phone}</span></span>` : ''}${p.age ? html`<span>${p.age}</span>` : ''}${p.sex ? html`<span>${sexName(p.sex)}</span>` : ''}${p.nationalId ? html`<span>${icon('id', 'sm')}<span class="num">${p.nationalId}</span></span>` : ''}</div>
    </a>
    ${can('visits.write') ? quickVisitBtns(p) : ''}
  </div>`;
}

// ===================== صفحة البحث =====================
export async function renderPatients(view, { query, setTitle }) {
  setTitle('المرضى', 'دوّر على المريض أو سجّل ملف جديد');
  const q0 = query.get('q') || '';
  view.innerHTML = String(html`
    <div class="grid" style="gap:16px;max-width:1100px;margin:0 auto">
      <div class="card search-hero">
        <div class="row wrap" style="gap:12px">
          <div class="big-search" style="flex:1 1 320px">${icon('search')}
            <input class="input" id="q" type="search" autocomplete="off" value="${q0}" placeholder="اكتب الاسم، أو التليفون، أو رقم الملف، أو الرقم القومي" aria-label="بحث">
          </div>
          <span id="peerSlot"></span>
          ${can('patients.write') ? html`<button class="btn lg" id="newP">${icon('user-plus')} مريض جديد <span class="kb">F2</span></button>` : ''}
        </div>
        <div class="chips" id="recents"></div>
      </div>
      <div class="results" id="res"></div>
    </div>`);
  const input = $('#q'), res = $('#res');
  const rc = recents();
  $('#recents').innerHTML = rc.length ? String(html`<span class="muted" style="font-weight:700;font-size:13px;align-self:center">آخر ملفات فتحتها:</span>${rc.map((p) => html`<a class="chip" href="#/patient/${p.id}"><span class="num" style="color:var(--brand)">#${p.no}</span>${p.name.split(' ').slice(0, 2).join(' ')}</a>`)}`) : '';

  const showEmpty = () => {
    res.innerHTML = String(html`<div class="card empty"><div class="art">${icon('users')}</div><b>دوّر على المريض</b>بأي حاجة تعرفها عنه: جزء من الاسم، آخر أرقام التليفون، أو رقم الملف</div>`);
  };
  const run = debounce(async () => {
    const q = input.value.trim();
    history.replaceState(null, '', '#/patients' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (q.length < 1) return showEmpty();
    res.innerHTML = String(html`${[1, 2, 3].map(() => html`<div class="skel" style="height:72px"></div>`)}`);
    try {
      const r = await api.get('/patients/search?q=' + encodeURIComponent(q));
      if (input.value.trim() !== q) return;
      res.innerHTML = r.results.length
        ? String(html`<div class="muted" style="font-weight:700;font-size:13px">${countText(r.results.length)}</div>${r.results.map(pcard)}`)
        : String(html`<div class="card empty"><div class="art">${icon('user-plus')}</div><b>مفيش مريض بالبيانات دي</b>ممكن يكون أول مرة ييجي. ${can('patients.write') ? html`<div style="margin-top:12px"><button class="btn" data-new>${icon('user-plus')} افتح له ملف جديد</button></div>` : ''}</div>`);
    } catch (e) { toastError(e); }
  }, 220);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const a = $('.pcard .who', res); if (a) a.click(); }
  });
  const newP = () => openPatientForm({ prefill: guessPrefill(input.value), onSaved: (p) => go('/patient/' + p.id) });
  $('#newP')?.addEventListener('click', newP);
  if (can('patients.write')) api.get('/peer/status').then((st) => {
    if (!st.enabled || !$('#peerSlot')) return;
    $('#peerSlot').innerHTML = String(html`<button class="btn lg ghost" id="peerS">${icon('link')} بحث في ${st.name}</button>`);
    $('#peerS').addEventListener('click', () => openPeerSearch({ peerName: st.name, q: input.value.trim(), onDone: (id) => go('/patient/' + id) }));
  }).catch(() => {});
  res.addEventListener('click', (e) => {
    const b = e.target.closest('[data-visit]');
    if (b) openVisit(Number(b.dataset.pid), b.dataset.visit);
    if (e.target.closest('[data-new]')) newP();
  });
  setTimeout(() => input.focus(), 30);
  if (q0) run(); else showEmpty();
}

function countText(n) {
  if (n >= 30) return 'أول 30 نتيجة، اكتب أكتر عشان تقرّب';
  if (n === 1) return 'نتيجة واحدة';
  if (n === 2) return 'نتيجتين';
  return n + (n <= 10 ? ' نتايج' : ' نتيجة');
}

/** لو الموظف كتب اسم أو رقم في البحث، نحطه في الفورم */
function guessPrefill(q) {
  q = (q || '').trim();
  if (!q) return {};
  const d = q.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632).replace(/\D/g, '');
  if (d && d.length === q.replace(/\s/g, '').length) {
    if (d.length === 14) return { nationalId: d };
    if (d.length >= 10) return { phone: d };
    return {};
  }
  return { name: q };
}

// ===================== ملف المريض =====================
export async function renderPatient(view, { params, setTitle }) {
  const id = Number(params[0]);
  view.innerHTML = String(html`<div class="skel" style="height:110px"></div>`);
  const d = await api.get('/patients/' + id);
  const p = d.patient;
  remember(p);
  setTitle(p.name, 'ملف رقم ' + p.no);
  const openVisits = d.visits.filter((v) => v.status === 'open');
  view.innerHTML = String(html`
    <div class="grid" style="gap:16px">
      <div class="card phead">
        <span class="pavatar lg ${p.sex || ''}">${initials(p.name)}</span>
        <div style="min-width:0">
          <div class="row wrap" style="gap:8px"><h2>${p.name}</h2><span class="fileno num">ملف #${p.no}</span></div>
          <div class="pmeta" style="margin-top:4px">
            ${p.age ? html`<span>${icon('user', 'sm')}${p.age}${p.sex ? ' · ' + sexName(p.sex) : ''}</span>` : ''}
            ${p.phone ? html`<span>${icon('phone', 'sm')}<span class="num">${p.phone}</span></span>` : ''}
            ${p.nationalId ? html`<span>${icon('id', 'sm')}<span class="num">${p.nationalId}</span></span>` : ''}
          </div>
        </div>
        ${can('visits.write') ? html`<div class="open-visit">${DEPT_KEYS.map((k) => html`<button class="vbtn d-${k}" data-visit="${k}">${icon(DEPT[k].icon)} ${DEPT[k].short}</button>`)}
          ${can('admissions.write') && !d.admittedNow ? html`<a class="vbtn d-admit" href="#/admit?patient=${p.id}">${icon('bed')} دخول</a>` : ''}</div>` : ''}
      </div>
      ${d.admittedNow ? html`<a class="alertbar admitted" href="#/admission/${d.admittedNow.id}">${icon('bed')}<span>المريض داخل دلوقتي: دخول رقم <b class="num">${d.admittedNow.no}</b> · غرفة <b class="num">${d.admittedNow.room}</b> سرير ${d.admittedNow.bed}</span><span class="spacer"></span><span class="btn sm">افتح الحساب</span></a>` : ''}
      ${p.incomplete ? html`<div class="alertbar warn">${icon('alert')}<span>الملف ده اتفتح بالاسم بس من الطوارئ. كمّل بياناته لما الحالة تستقر.</span><span class="spacer"></span><button class="btn sm" style="--c:var(--warn)" data-edit>كمّل البيانات</button></div>` : ''}
      ${d.due > 0 ? html`<div class="alertbar danger">${icon('wallet')}<span>على المريض <b class="num">${money(d.due)}</b> ${HMS.money.unitWord} في زيارات مفتوحة</span><span class="spacer"></span>${openVisits[0] ? html`<a class="btn sm" style="--c:var(--danger)" href="#/visit/${openVisits[0].id}">روح للحساب</a>` : ''}</div>` : ''}
      <div class="pcols">
        <div class="card pad">
          <div class="paybox ${d.payer ? (d.payer.expired ? 'exp' : 'on') : ''}">
            <span class="pic">${icon('shield')}</span>
            <div style="min-width:0">${d.payer ? html`<b>${d.payer.name}</b><small>${d.payer.tierName} · كارنيه <span class="num">${d.payer.cardNo || '—'}</span>${d.payer.expired ? html` · <span style="color:var(--danger)">التعاقد منتهي</span>` : ''}</small>` : html`<b>نقدي</b><small>مش على تعاقد</small>`}</div>
            ${can('patients.write') ? html`<button class="btn ghost sm" data-payer style="margin-inline-start:auto">${icon('edit', 'sm')} ${d.payer ? 'غيّر' : 'ضيف تعاقد'}</button>` : ''}
          </div>
          <h3>${icon('folder')} بيانات المريض ${can('patients.write') ? html`<button class="btn ghost sm" style="margin-inline-start:auto" data-edit>${icon('edit', 'sm')} تعديل</button>` : ''}</h3>
          <dl class="kv">
            <dt>الاسم</dt><dd>${p.name}</dd>
            <dt>التليفون</dt><dd><span class="num">${p.phone || '—'}</span></dd>
            <dt>السن</dt><dd>${p.age || '—'}${p.birthDate ? html` <span class="muted">(${fmtDate(p.birthDate)})</span>` : ''}</dd>
            <dt>النوع</dt><dd>${sexName(p.sex) || '—'}</dd>
            <dt>الرقم القومي</dt><dd><span class="num">${p.nationalId || '—'}</span></dd>
            <dt>العنوان</dt><dd>${p.address || '—'}</dd>
            <dt>قريب للطوارئ</dt><dd>${p.emergencyName || '—'}${p.emergencyPhone ? html` · <span class="num">${p.emergencyPhone}</span>` : ''}</dd>
            ${p.notes ? html`<dt>ملاحظات</dt><dd>${p.notes}</dd>` : ''}
            <dt>اتسجل</dt><dd class="muted">${fmtWhen(p.createdAt)}</dd>
          </dl>
          ${d.edits.length ? html`<details style="margin-top:14px"><summary class="linkbtn" style="cursor:pointer">${icon('history', 'sm')} سجل التعديلات (${d.edits.length})</summary>
            <div class="list" style="margin-top:8px">${d.edits.map((e) => html`<div class="li"><div><b>${e.field}</b><small>${e.old || 'فاضي'} ← ${e.new || 'فاضي'}</small></div><small class="amt muted" style="font-weight:600">${e.by} · ${fmtWhen(e.at)}</small></div>`)}</div></details>` : ''}
        </div>
        <div class="card pad">
          <h3>${icon('clipboard')} الزيارات والدخول</h3>
          ${d.admissions?.length ? html`<div class="list" style="margin-bottom:8px">${d.admissions.map((a) => html`
            <a class="vrow" href="#/admission/${a.id}"><span class="admtag t-${a.type}">${icon(ADM[a.type].icon, 'sm')} ${ADM[a.type].name}</span>
              <div><b>دخول <span class="num">${a.no}</span></b><small class="muted" style="display:block;font-size:12.5px;font-weight:600">${fmtWhen(a.admittedAt)} · ${nightsText(a.nights)}</small></div>
              ${a.status === 'active' ? html`<span class="badge ok dot">داخل</span>` : html`<span class="badge">خرج</span>`}<span></span></a>`)}</div>` : ''}
          ${d.visits.length ? html`<div class="list">${d.visits.map((v) => html`
            <a class="vrow d-${v.type}" href="#/visit/${v.id}">
              <span class="dtag">${icon(DEPT[v.type].icon)} ${DEPT[v.type].short}</span>
              <div><b>زيارة <span class="num">${v.no}</span></b><small class="muted" style="display:block;font-size:12.5px;font-weight:600">${fmtWhen(v.openedAt)} · ${v.items} خدمة</small></div>
              ${v.due > 0 ? html`<span class="badge warn">باقي <span class="num">${money(v.due)}</span></span>` : v.status === 'open' ? html`<span class="badge ok dot">مفتوحة</span>` : html`<span class="badge">مقفولة</span>`}
              <b>${egp(v.total)}</b>
            </a>`)}</div>` : d.admissions?.length ? '' : html`<div class="empty"><div class="art">${icon('clipboard')}</div><b>لسه مفيش زيارات</b>افتح أول زيارة من الزراير اللي فوق</div>`}
        </div>
        ${can('lab.read') ? html`<div class="card pad" id="plabBox"><div class="skel" style="height:60px"></div></div>` : ''}
        ${can('rad.read') ? html`<div class="card pad" id="pradBox"><div class="skel" style="height:60px"></div></div>` : ''}
      </div>
    </div>`);
  { const pb = document.createElement('div'); pb.id = 'peerBox'; view.firstElementChild.firstElementChild.after(pb); peerPanel(pb, p, () => renderPatient(view, { params, setTitle })); }
  if ($('#pradBox', view)) patientRadiology($('#pradBox', view), id);
  if ($('#plabBox', view)) patientLab($('#plabBox', view), id);
  view.onclick = (e) => {
    const b = e.target.closest('[data-visit]');
    if (b) openVisit(id, b.dataset.visit);
    if (e.target.closest('[data-edit]')) openPatientForm({ patient: p, onSaved: () => renderPatient(view, { params, setTitle }) });
    if (e.target.closest('[data-payer]')) (async () => {
      const c = await pickPayer({ title: 'تعاقد المريض', current: d.payer });
      if (c === undefined) return;
      try {
        await api.put(`/patients/${id}/payer`, c ? { payerId: c.payerId, tierId: c.tierId, cardNo: c.cardNo } : { payerId: null });
        toast(c ? `المريض بقى على ${c.payer.name}` : 'المريض بقى نقدي'); renderPatient(view, { params, setTitle });
      } catch (er) { toastError(er); }
    })();
  };
  return () => { view.onclick = null; };
}

// ===================== فورم المريض =====================
/**
 * openPatientForm({ patient?, quick?, prefill?, onSaved })
 *  quick: طوارئ سريع (الاسم بس)
 */
export function openPatientForm({ patient = null, quick = false, prefill = {}, onSaved } = {}) {
  const p = patient || prefill || {};
  const edit = !!patient;
  const pf = (state.patientFields || {})[quick ? 'er' : 'clinic'] || {};
  const mk = (f) => (pf[f] === 'req' ? html`<span class="req">*</span>` : html`<span class="hint">اختياري</span>`);
  const title = edit ? 'تعديل بيانات المريض' : quick ? 'طوارئ سريع' : 'مريض جديد';
  const body = quick ? html`
    <div class="alertbar info" style="margin-bottom:14px">${icon('bolt')}<span>الزيارة هتتفتح فورًا، والبيانات تتكمّل بعدين من ملف المريض.</span></div>
    <div class="form-grid">
      <div class="field c6" data-f="name"><label>اسم المريض <span class="req">*</span><span class="hint">لو مش معروف اكتب «مجهول»</span></label><input class="input" name="name" autofocus value="${p.name || ''}"><div class="msg"></div></div>
      <div class="field c3" data-f="phone"><label>تليفون مرافق ${mk('phone')}</label><input class="input num" name="phone" inputmode="tel"><div class="msg"></div></div>
      <div class="field c3" data-f="sex"><label>النوع ${mk('sex')}</label>${sexSeg(p.sex)}<div class="msg"></div></div>
    </div>` : html`
    <div class="form-grid">
      <div class="field c4" data-f="name"><label>الاسم ثلاثي على الأقل <span class="req">*</span></label><input class="input" name="name" autofocus value="${p.name || ''}" autocomplete="off"><div class="msg"></div></div>
      <div class="field c2" data-f="sex"><label>النوع ${mk('sex')}</label>${sexSeg(p.sex)}<div class="msg"></div></div>
      <div class="field c2" data-f="phone"><label>التليفون ${mk('phone')}</label><input class="input num" name="phone" inputmode="tel" value="${p.phone || ''}" autocomplete="off"><div class="msg"></div></div>
      <div class="field c2" data-f="nationalId"><label>الرقم القومي ${mk('nid')}</label><input class="input num" name="nationalId" inputmode="numeric" maxlength="14" value="${p.nationalId || ''}" autocomplete="off"><div class="msg"></div></div>
      <div class="field c1 c-half" data-f="ageYears"><label>السن ${mk('age')}</label><input class="input num" name="ageYears" inputmode="numeric" placeholder="سنين" value="${p.birthDate ? '' : p.ageYears ?? ''}"><div class="msg"></div></div>
      <div class="field c1 c-half" data-f="birthDate"><label>أو الميلاد</label><input class="input" type="date" name="birthDate" value="${p.birthDate || ''}" max="${new Date().toISOString().slice(0, 10)}" style="padding:0 8px"><div class="msg"></div></div>
      <div class="field c2" data-f="address"><label>العنوان</label><input class="input" name="address" value="${p.address || ''}"><div class="msg"></div></div>
      <div class="field c2" data-f="emergencyName"><label>قريب للطوارئ</label><input class="input" name="emergencyName" value="${p.emergencyName || ''}"><div class="msg"></div></div>
      <div class="field c2" data-f="emergencyPhone"><label>تليفون القريب</label><input class="input num" name="emergencyPhone" inputmode="tel" value="${p.emergencyPhone || ''}"><div class="msg"></div></div>
      <div class="field c6" data-f="notes"><label>ملاحظات</label><input class="input" name="notes" value="${p.notes || ''}" placeholder="مثلًا: بيحتاج كرسي متحرك"><div class="msg"></div></div>
    </div>
    <div id="dupBox" style="margin-top:12px"></div>`;
  const m = modal({
    title, wide: !quick, body,
    foot: html`<span class="muted" style="margin-inline-end:auto;font-size:12.5px;font-weight:600;align-self:center">Ctrl + Enter للحفظ</span><button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('check')} ${edit ? 'احفظ التعديل' : quick ? 'افتح زيارة الطوارئ' : 'احفظ وافتح الملف'}</button>`,
  });
  const form = m.el;
  const get = (n) => $(`[name="${n}"]`, form);
  let sex = p.sex || '';
  $$('.seg button', form).forEach((b) => b.addEventListener('click', () => {
    sex = b.dataset.v; $$('.seg button', form).forEach((x) => x.classList.toggle('on', x === b));
  }));
  const setMsg = (f, msg, kind = '') => {
    const box = $(`[data-f="${f}"]`, form);
    if (!box) return;
    box.classList.toggle('err', kind === 'err');
    const mm = $('.msg', box); mm.textContent = msg || ''; mm.className = 'msg ' + (kind === 'err' ? '' : kind);
  };

  // الرقم القومي: نستخرج السن والنوع لوحدهم
  const nid = get('nationalId');
  const onNid = () => {
    const v = nid.value.trim();
    if (!v) { setMsg('nationalId', ''); return; }
    if (v.replace(/\D/g, '').length < 14) { setMsg('nationalId', `${v.replace(/\D/g, '').length} من 14 رقم`, 'info'); return; }
    const r = parseNationalId(v);
    if (!r.ok) return setMsg('nationalId', r.error, 'err');
    setMsg('nationalId', `✓ ${ageText(r.birthDate)} · ${sexName(r.sex)} · مواليد ${r.governorate}`, 'ok');
    get('birthDate').value = r.birthDate; get('ageYears').value = '';
    sex = r.sex; $$('.seg button', form).forEach((x) => x.classList.toggle('on', x.dataset.v === sex));
    checkDup();
  };
  nid?.addEventListener('input', onNid);

  // تنبيه لو التليفون أو الرقم القومي متسجلين قبل كده
  let dupConfirmed = false;
  const checkDup = debounce(async () => {
    const box = $('#dupBox', form);
    if (!box) return;
    const phone = get('phone').value, nationalId = nid?.value;
    if (!phone && !nationalId) { box.innerHTML = ''; return; }
    try {
      const r = await api.post('/patients/check', { phone, nationalId, exceptId: patient?.id || 0 });
      const list = [...(r.byNationalId ? [r.byNationalId] : []), ...r.byPhone.filter((x) => x.id !== r.byNationalId?.id)];
      dupConfirmed = false;
      box.innerHTML = list.length ? String(html`<div class="alertbar ${r.byNationalId ? 'danger' : 'warn'}" style="flex-wrap:wrap">${icon('alert')}
        <span>${r.byNationalId ? 'الرقم القومي ده متسجل بالفعل:' : 'المريض ده ممكن يكون متسجل قبل كده:'}</span>
        ${list.map((x) => html`<a class="chip" href="#/patient/${x.id}" data-go><span class="num" style="color:var(--brand)">#${x.no}</span>${x.name}</a>`)}
      </div>`) : '';
    } catch { /* */ }
  }, 350);
  get('phone')?.addEventListener('input', checkDup);
  if (nid?.value) onNid();
  form.addEventListener('click', (e) => { if (e.target.closest('[data-go]')) m.close(); });
  get('ageYears')?.addEventListener('input', () => { if (get('ageYears').value) get('birthDate').value = ''; });
  get('birthDate')?.addEventListener('change', () => { if (get('birthDate').value) get('ageYears').value = ''; });

  const save = async () => {
    const data = { mode: quick ? 'quick' : 'outpatient', sex };
    for (const n of ['name', 'phone', 'nationalId', 'ageYears', 'birthDate', 'address', 'emergencyName', 'emergencyPhone', 'notes']) {
      const i = get(n); if (i) data[n] = i.value.trim();
    }
    if (edit) for (const k of ['address', 'emergencyName', 'emergencyPhone', 'notes']) if (!(k in data)) data[k] = patient[k];
    if (dupConfirmed) data.confirmDuplicatePhone = true;
    $$('.field', form).forEach((f) => { f.classList.remove('err'); });
    const btn = $('[data-save]', form);
    btn.disabled = true;
    try {
      const r = edit ? await api.put('/patients/' + patient.id, data) : await api.post('/patients', data);
      m.close();
      toast(edit ? (r.changed ? 'اتحفظت التعديلات' : 'مفيش تغيير') : `اتفتح ملف رقم ${r.patient.no}`);
      onSaved?.(r.patient);
    } catch (e) {
      if (e instanceof ApiError && e.data.errors) {
        for (const [f, msg] of Object.entries(e.data.errors)) setMsg(f, msg, 'err');
        $('.field.err input', form)?.focus();
      } else if (e instanceof ApiError && e.data.needsConfirm) {
        dupConfirmed = true;
        const box = $('#dupBox', form) || $('.modal-body', form);
        const ex = e.data.duplicate.byPhone;
        box.innerHTML = String(html`<div class="alertbar warn" style="flex-wrap:wrap">${icon('alert')}<span>رقم التليفون ده متسجل لـ</span>${ex.map((x) => html`<a class="chip" href="#/patient/${x.id}" data-go><span class="num" style="color:var(--brand)">#${x.no}</span>${x.name}</a>`)}
          <span>لو ده شخص تاني (من نفس العيلة مثلًا) دوس حفظ تاني.</span></div>`);
      } else toastError(e);
    } finally { btn.disabled = false; }
  };
  $('[data-save]', form).addEventListener('click', save);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && quick) { e.preventDefault(); save(); }
  });
  return m;
}

function sexSeg(v) {
  return raw(String(html`<div class="seg full" role="radiogroup"><button type="button" data-v="M" class="${v === 'M' ? 'on' : ''}">ذكر</button><button type="button" data-v="F" class="${v === 'F' ? 'on' : ''}">أنثى</button></div>`));
}
