// شاشة الدخول: المريض ← نوع الدخول والطبيب ← السرير من اللوحة ← التأمين والدفع ← «دخّل الحالة»
import {
  api, state, html, icon, el, $, $$, money, egp, initials, sexName, ADM, ADM_KEYS, KIND, modal, toast, toastError, printReceipt, can, debounce, ApiError, cashierDuty, showOrder,
} from '../core.js';
import { bedBoard } from './beds.js';
import { pickDoctor, managers, mgrSelect, pickPayer, usablePayers } from './pickers.js';
import { openPatientForm } from './patients.js';

export async function renderAdmit(view, { query, setTitle }) {
  setTitle('دخول جديد', 'المريض ← نوع الدخول والطبيب ← السرير ← التأمين');
  const S = {
    patient: null, visitId: query.get('visit') ? Number(query.get('visit')) : null,
    type: ADM[query.get('type')] ? query.get('type') : ADM_KEYS[0],
    doctor: null, bed: null, deposit: '', method: 'cash', split: '', creditBy: '', busy: false,
    payer: null, apNo: '', apDate: '', diag: '', dx: '', dxProv: false, dxList: [],
  };
  api.get('/admissions/diagnoses').then((r) => { S.dxList = r.diagnoses; const dl = $('#dxlist', view); if (dl) dl.innerHTML = r.diagnoses.map((x) => `<option value="${x.replace(/"/g, '&quot;')}"></option>`).join(''); }).catch(() => {});
  const mg = await managers();
  const payers = can('payers.read') ? await usablePayers().catch(() => []) : [];
  const duty = await cashierDuty().catch(() => ({}));
  const ordering = () => !!duty.mustOrder;
  const loadPatient = async (pid) => {
    const d = await api.get('/patients/' + pid);
    S.patient = d.patient;
    const py = d.payer && !d.payer.expired ? payers.find((x) => x.id === d.payer.id) : null;
    const tier = py?.tiers.find((x) => x.id === d.payer.tierId);
    S.payer = py && tier ? { payerId: py.id, tierId: tier.id, cardNo: d.payer.cardNo, payer: py } : null;
    S.deposit = '';
  };
  if (query.get('patient')) {
    try { await loadPatient(query.get('patient')); } catch { /* */ }
  }
  const wardPct = () => S.payer ? (S.payer.payer.tiers.find((x) => x.id === S.payer.tierId)?.coverage.ward ?? 0) : 0;
  view.innerHTML = String(html`
    <div class="admit">
      <div class="grid" style="gap:16px;align-content:start;min-width:0">
        <section class="card pad step" id="s1"></section>
        <section class="card pad step" id="s2"></section>
        <section class="card pad step" id="s3">
          <h3><span class="sn">3</span> السرير <span class="muted" id="bedHint">دوس على سرير فاضي (أخضر)</span></h3>
          <div id="board"><div class="skel" style="height:300px"></div></div>
        </section>
      </div>
      <aside class="card admit-sum" id="sum"></aside>
    </div>`);

  // ---------- 1) المريض ----------
  const missing = (p) => [!p.nationalId && 'الرقم القومي', !p.address && 'العنوان', !(p.emergencyName && p.emergencyPhone) && 'قريب للطوارئ'].filter(Boolean);
  const drawPatient = () => {
    const p = S.patient;
    $('#s1', view).innerHTML = String(p ? html`
      <h3><span class="sn ok">${icon('check', 'sm')}</span> المريض <button class="linkbtn" data-chg style="margin-inline-start:auto">غيّر المريض</button></h3>
      <div class="row" style="gap:14px">
        <span class="pavatar lg ${p.sex || ''}">${initials(p.name)}</span>
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><b style="font-size:18px">${p.name}</b><span class="fileno num">#${p.no}</span></div>
          <div class="pmeta">${p.age ? html`<span>${p.age} · ${sexName(p.sex)}</span>` : ''}${p.phone ? html`<span>${icon('phone', 'sm')}<span class="num">${p.phone}</span></span>` : ''}${p.nationalId ? html`<span>${icon('id', 'sm')}<span class="num">${p.nationalId}</span></span>` : ''}</div></div>
      </div>
      ${missing(p).length ? html`<div class="alertbar warn" style="margin-top:12px">${icon('alert')}<span>للدخول لازم: <b>${missing(p).join('، ')}</b></span><span class="spacer"></span><button class="btn sm" style="--c:var(--warn)" data-edit>${icon('edit', 'sm')} كمّل البيانات</button></div>` : ''}
      ${S.visitId ? html`<div class="alertbar info" style="margin-top:10px">${icon('arrows')}<span>جاي من زيارة. الخدمات اللي لسه ما اتدفعتش هتنتقل لحساب الإقامة.</span></div>` : ''}`
      : html`<h3><span class="sn">1</span> المريض</h3>
      <div class="row wrap" style="gap:10px"><div class="big-search" style="flex:1 1 260px">${icon('search')}<input class="input" id="pq" type="search" placeholder="الاسم، التليفون، رقم الملف، أو الرقم القومي" autocomplete="off" autofocus></div>
        <button class="btn soft" data-new>${icon('user-plus')} مريض جديد</button></div>
      <div id="pres" class="results" style="margin-top:10px"></div>`);
    $('#pq', view)?.focus();
  };
  // ---------- 2) نوع الدخول والطبيب ----------
  const drawType = () => {
    const dxReq = state.dx?.required !== false;
    $('#s2', view).innerHTML = String(html`
      <h3><span class="sn ${S.doctor ? 'ok' : ''}">${S.doctor ? icon('check', 'sm') : '2'}</span> نوع الدخول والطبيب المعالج</h3>
      <div class="admtypes">${ADM_KEYS.map((k) => html`<button class="admtype t-${k} ${S.type === k ? 'on' : ''}" data-type="${k}"><span class="ic">${icon(ADM[k].icon)}</span><b>${ADM[k].name}</b><small>${KIND[ADM[k].kind]}</small></button>`)}</div>
      <div class="form-grid" style="margin-top:14px">
        <div class="field c3" data-f="doctor"><label>الطبيب المعالج <span class="req">*</span></label>
          <button class="input pickbtn" data-doc type="button">${S.doctor ? html`<b>${S.doctor.name}</b><small>${S.doctor.specialty || ''}</small>` : html`<span class="muted">اختار الدكتور...</span>`}${icon('chev-left', 'sm')}</button><div class="msg"></div></div>
        <div class="field c6" data-f="diagnosis"><label>التشخيص ${dxReq ? html`<span class="req">*</span>` : html`<span class="hint">اختياري</span>`} ${state.dx?.provisional ? html`<label class="chk" style="margin-inline-start:10px;font-weight:700"><input type="checkbox" name="dxprov" ${S.dxProv ? 'checked' : ''}> مبدئي (طوارئ حرجة) · مهلة ${state.dx.hours} ساعة</label>` : ''}</label>
          <input class="input" name="dx" list="dxlist" autocomplete="off" value="${S.dx || ''}" placeholder="اكتب أو اختار من القايمة"><datalist id="dxlist">${(S.dxList || []).map((x) => html`<option value="${x}"></option>`)}</datalist><div class="msg"></div></div>
        <div class="field c6"><label>${ADM[S.type]?.behavior === 'surgery' ? 'العملية المتوقعة' : 'الإجراء أو التشخيص المبدئي'} <span class="hint">اختياري</span></label><input class="input" name="proc" value="${S.proc || ''}" placeholder="${S.type === 'surgery' ? 'مثلًا: منظار مرارة' : 'مثلًا: متابعة ضغط'}"></div>
        <div class="field c6"><label>ملاحظات <span class="hint">اختياري</span></label><input class="input" name="notes" value="${S.notes || ''}"></div>
      </div>`);
  };
  // ---------- الملخص والدفع ----------
  const drawSum = () => {
    const b = S.bed;
    const minDep = HMS.money.discountValue(b?.roomCls.deposit || 0, wardPct());
    const dep = S.deposit === '' ? minDep : Number(S.deposit) || 0;
    const ready = S.patient && !missing(S.patient).length && S.doctor && b;
    const splitCard = Math.max(0, dep - (Number(S.split) || 0));
    $('#sum', view).innerHTML = String(html`
      <div class="sum-head t-${S.type}"><span class="ic">${icon(ADM[S.type].icon)}</span><div><small>دخول</small><b>${ADM[S.type].name}</b></div></div>
      <div class="sum-body">
        <div class="sumline"><span>المريض</span><b>${S.patient ? S.patient.name.split(' ').slice(0, 3).join(' ') : '—'}</b></div>
        <div class="sumline"><span>الطبيب</span><b>${S.doctor?.name || '—'}</b></div>
        <div class="sumline"><span>السرير</span><b>${b ? html`غرفة <span class="num">${b.roomNo}</span> · ${b.label}` : '—'}</b></div>
        ${b ? html`<div class="sumline"><span>الدرجة</span><b>${b.roomCls.name} · <span class="num">${money(b.roomCls.nightPrice)}</span> ${HMS.money.symbol}/ليلة</b></div>` : ''}
        <hr>
        <div class="paybox ${S.payer ? 'on' : ''}" style="margin-bottom:4px"><span class="pic">${icon(S.payer ? 'shield' : 'cash')}</span>
          <div style="min-width:0">${S.payer ? html`<b>${S.payer.payer.name}</b><small>${S.payer.payer.tiers.find((x) => x.id === S.payer.tierId)?.name} · الإقامة <span class="num">${wardPct()}%</span> على الجهة</small>` : html`<b>نقدي</b><small>الحساب كله على المريض</small>`}</div>
          ${S.patient && payers.length ? html`<button class="btn ghost sm" data-payer style="margin-inline-start:auto">${icon('edit', 'sm')} غيّر</button>` : ''}</div>
        ${S.payer ? html`<div class="muted" style="font-size:12px;margin-bottom:6px">التشخيص بيطلع في مطالبة ${S.payer.payer.name}</div>
          <div class="two"><div class="field"><label>رقم موافقة الدخول <span class="hint">لو موجود</span></label><input class="input num" name="apNo" value="${S.apNo}" style="text-align:left"></div>
          <div class="field"><label>تاريخها</label><input class="input" type="date" name="apDate" value="${S.apDate}"></div></div>
          <div class="muted" style="font-size:12px;font-weight:600">الدخول هيتسجل «مستني المراجعة» لحد ما قسم المراجعة يعتمده.</div>` : ''}
        <div class="field" data-f="deposit"><label>تأمين الدخول ${b ? html`<span class="hint">أقل مبلغ <span class="num">${money(minDep)}</span>${can('admissions.override') ? ' (إنت مدير، تقدر تقلله)' : ''}</span>` : ''}</label>
          <input class="input num" name="deposit" inputmode="decimal" value="${b ? (S.deposit === '' ? minDep : S.deposit) : ''}" ${b ? '' : 'disabled'} style="font-size:20px;font-weight:800;height:52px"><div class="msg"></div></div>
        ${dep > 0 && ordering() ? html`<div class="dutybar">${icon('wallet', 'sm')}<span>الخزينة شغالة: التأمين بيتدفع هناك بإذن</span></div>` : ''}
        ${dep > 0 ? html`<div class="seg full">${(ordering() ? [['cash', 'الخزينة', 'wallet'], ['credit', 'آجل', 'hourglass']] : [['cash', 'نقدي', 'cash'], ['card', 'فيزا', 'card'], ['split', 'الاتنين', 'split'], ['credit', 'آجل', 'hourglass']]).map(([k, n, ic]) => html`<button data-m="${k}" class="${S.method === k ? 'on' : ''}">${icon(ic, 'sm')}${n}</button>`)}</div>
          ${S.method === 'split' ? html`<div class="splitbox"><div class="field"><label>نقدي</label><input class="input num" name="split" value="${S.split}" inputmode="decimal"></div><div class="field"><label>فيزا</label><input class="input num" value="${money(splitCard)}" disabled></div></div>` : ''}
          ${S.method === 'credit' ? html`<div class="creditbox"><b style="font-size:13px">${icon('hourglass', 'sm')} التأمين آجل بموافقة المدير</b>${mgrSelect('creditBy', S.creditBy, mg)}</div>` : ''}` : ''}
        <button class="btn block paybtn" id="go" style="--c:var(--brand)" ${ready && !S.busy ? '' : 'disabled'}>${icon('bed')} دخّل الحالة ${dep > 0 && S.method !== 'credit' ? (ordering() ? html`وإذن تأمين <span class="num">${money(dep)}</span>` : html`واقبض <span class="num">${money(dep)}</span>`) : ''}</button>
        ${!ready ? html`<div class="todo">${[!S.patient && 'اختار المريض', S.patient && missing(S.patient).length && 'كمّل بيانات المريض', !S.doctor && 'اختار الطبيب', !b && 'اختار السرير'].filter(Boolean).map((t) => html`<span>${icon('info', 'sm')}${t}</span>`)}</div>` : ''}
      </div>`);
  };
  const drawAll = () => { drawPatient(); drawType(); drawSum(); };
  drawAll();

  // اللوحة
  const board = await bedBoard($('#board', view), {
    mode: 'pick', kind: ADM[S.type].kind, lockKind: true, selectedId: null,
    onPick: (bed) => { S.bed = bed; S.deposit = ''; drawSum(); setTimeout(() => $('#sum', view).scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); },
  });
  if (query.get('bed')) {
    const bid = Number(query.get('bed'));
    const d = await api.get('/admissions/beds/board');
    for (const f of d.floors) for (const r of f.rooms) for (const b of r.beds) {
      if (b.id === bid && (b.status === 'free' || b.status === 'reserved')) {
        if (ADM[S.type]?.kind !== r.cls.kind) S.type = ADM_KEYS.find((k) => ADM[k].kind === r.cls.kind) || S.type;
        S.bed = { ...b, roomCls: r.cls, roomNo: r.no, floorNo: f.no };
      }
    }
    drawType(); board.setKind(ADM[S.type].kind); drawSum();
  }

  // ---------- الأحداث ----------
  const searchP = debounce(async (q) => {
    const box = $('#pres', view);
    if (!box) return;
    if (q.trim().length < 2) { box.innerHTML = ''; return; }
    const r = await api.get('/patients/search?q=' + encodeURIComponent(q));
    box.innerHTML = String(html`${r.results.slice(0, 6).map((p) => html`<button class="pcard pick" data-pick="${p.id}" ${p.admissionId ? 'disabled' : ''}>
      <span class="pavatar ${p.sex || ''}">${initials(p.name)}</span>
      <div class="who" style="text-align:start"><div class="row" style="gap:8px"><b>${p.name}</b><span class="fileno num">#${p.no}</span>${p.admissionId ? html`<span class="badge brand">داخل بالفعل</span>` : ''}</div>
        <div class="meta">${p.phone ? html`<span class="num">${p.phone}</span>` : ''}${p.age ? html`<span>${p.age}</span>` : ''}</div></div>
      ${p.admissionId ? '' : html`<span class="btn soft sm">اختار</span>`}</button>`)}
      ${!r.results.length ? html`<div class="empty" style="padding:16px">مفيش نتيجة. <button class="linkbtn" data-new>افتح ملف جديد</button></div>` : ''}`);
  }, 200);
  view.oninput = (e) => {
    const t = e.target;
    if (t.id === 'pq') return searchP(t.value);
    if (t.name === 'proc') S.proc = t.value;
    if (t.name === 'notes') S.notes = t.value;
    if (t.name === 'apNo') S.apNo = t.value;
    if (t.name === 'diag') S.diag = t.value;
    if (t.name === 'dx') S.dx = t.value;
    if (t.name === 'dxprov') S.dxProv = t.checked;
    if (t.name === 'apDate') S.apDate = t.value;
    if (t.name === 'deposit' || t.name === 'split') {
      S[t.name] = t.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632);
      const pos = t.selectionStart, n = t.name;
      redraw(n, pos);
    }
  };
  const redraw = debounce((n, pos) => { drawSum(); const i = $(`[name=${n}]`, view); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* */ } } }, 300);
  view.onchange = (e) => { if (e.target.name === 'creditBy') S.creditBy = e.target.value; };
  view.onclick = async (e) => {
    const t = e.target;
    const pk = t.closest('[data-pick]');
    if (pk) { await loadPatient(pk.dataset.pick); drawPatient(); drawSum(); return; }
    if (t.closest('[data-new]')) return openPatientForm({ prefill: { name: $('#pq', view)?.value || '' }, onSaved: async (p) => { await loadPatient(p.id); drawPatient(); drawSum(); } });
    if (t.closest('[data-chg]')) { S.patient = null; S.payer = null; S.visitId = null; drawPatient(); drawSum(); return; }
    if (t.closest('[data-payer]')) {
      const c = await pickPayer({ title: 'تعاقد الدخول', current: S.payer ? { id: S.payer.payerId, tierId: S.payer.tierId, cardNo: S.payer.cardNo } : null });
      if (c !== undefined) { S.payer = c; S.deposit = ''; drawSum(); }
      return;
    }
    if (t.closest('[data-edit]')) return openPatientForm({ patient: S.patient, onSaved: async () => { S.patient = (await api.get('/patients/' + S.patient.id)).patient; drawPatient(); drawSum(); } });
    const ty = t.closest('[data-type]');
    if (ty) {
      const nk = ADM[ty.dataset.type].kind;
      if (S.bed && S.bed.roomCls.kind !== nk) S.bed = null;
      S.type = ty.dataset.type; drawType(); board.setKind(nk); drawSum(); return;
    }
    if (t.closest('[data-doc]')) { const d = await pickDoctor('الطبيب المعالج'); if (d) { S.doctor = d; drawType(); drawSum(); } return; }
    const mm = t.closest('[data-m]');
    if (mm) { S.method = mm.dataset.m; drawSum(); return; }
    if (t.closest('#go')) submit();
  };

  const submit = async () => {
    const b = S.bed;
    const dep = S.deposit === '' ? HMS.money.discountValue(b.roomCls.deposit || 0, wardPct()) : Number(S.deposit) || 0;
    const body = {
      payer: S.payer ? { payerId: S.payer.payerId, tierId: S.payer.tierId, cardNo: S.payer.cardNo } : null, approvalNo: S.apNo, approvalDate: S.apDate, diagnosis: (S.dx || '').trim(), diagnosisProvisional: !!S.dxProv,
      patientId: S.patient.id, type: S.type, doctorId: S.doctor.id, bedId: b.id, expectedProcedure: S.proc, notes: S.notes,
      deposit: dep, fromVisitId: S.visitId, cash: 0, card: 0, credit: 0,
    };
    if (S.method === 'cash' && !ordering()) body.cash = dep;
    if (S.method === 'card') body.card = dep;
    if (S.method === 'split') { body.cash = Number(S.split) || 0; body.card = HMS.money.round((dep - body.cash)); }
    if (S.method === 'credit') { body.credit = dep; body.creditApprovedBy = S.creditBy; }
    S.busy = true; drawSum();
    try {
      const r = await api.post('/admissions', body);
      toast(`اتعمل دخول رقم ${r.admission.no} · غرفة ${r.bed.room.no} سرير ${r.bed.label}`);
      if (r.receiptId && localStorage.getItem('autoPrint') !== '0') printReceipt(r.receiptId, true);
      window.refreshShell?.();
      go('/admission/' + r.admission.id);
      if (r.order) setTimeout(() => showOrder(r.order, { autoPrint: localStorage.getItem('autoPrint') !== '0' }), 350);
    } catch (er) {
      S.busy = false; drawSum();
      if (er instanceof ApiError && er.data.errors?.deposit) { const f = $('[data-f=deposit]', view); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.deposit; }
      if (er instanceof ApiError && er.data.errors?.diagnosis) { const f = $('[data-f=diagnosis]', view); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.diagnosis; f.scrollIntoView({ block: 'center' }); }
      if (er instanceof ApiError && er.data.needsPatientData) { drawPatient(); }
      if (er.status === 409) board.reload();
      toastError(er);
    }
  };
  return () => { view.oninput = view.onclick = view.onchange = null; };
}
void el; void $$; void egp;
