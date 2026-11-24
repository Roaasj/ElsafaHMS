// الربط مع منشأة تانية (المستشفى <-> الصفا كاث): شاشة الإعدادات، بحث/استيراد، وصندوق الربط في ملف المريض
import { printReceipt, api, html, icon, $, $$, modal, toast, toastError, can, debounce, money } from '../core.js';

const fmtAt = (s) => (s ? new Date(s).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short', timeZone: HMS.tz }) : '—');
const randKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

/** شاشة إعدادات الربط (المدير) */
export async function renderPeer(view, { setTitle }) {
  setTitle('الربط مع منشأة تانية', 'مرضى مشتركين بين المستشفى والصفا كاث');
  const draw = async () => {
    const c = await api.get('/peer/config');
    view.innerHTML = String(html`
      <div class="grid" style="gap:16px;max-width:820px;margin:0 auto">
        <div class="card pad">
          <h3 style="margin-top:0">${icon('link', 'sm')} إعدادات الربط</h3>
          <div class="muted" style="font-weight:600;margin-bottom:12px">البيانات التعريفية بس (اسم، رقم قومي، تليفون، سن، نوع، عنوان، قريب) هي اللي بتتشارك. الملف الطبي والحسابات والتعاقد كل منشأة لوحدها.</div>
          <label class="check" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="pe" ${c.enabled ? 'checked' : ''}> <b>الربط شغّال</b></label>
          <label class="check" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="prp" ${c.requirePaid ? 'checked' : ''}> <b>الفنّي ما ينفّذش الخدمة غير بعد الدفع</b></label>
          <div class="grid cols-2" style="gap:12px">
            <div class="field"><label>اسم المنشأة التانية (بيظهر للموظف)</label><input class="input" id="pn" value="${c.name}"></div>
            <div class="field"><label>العنوان اللي بيفتح بيه الموظفين المنشأة دي <span class="hint">للانتقال بنفس الحساب. لو فاضي بيستخدم العنوان اللي تحت</span></label><input class="input num" id="ppu" dir="ltr" placeholder="http://192.168.1.20:3001" value="${c.publicUrl || ''}"></div>
            <div class="field"><label>عنوانها على الشبكة</label><input class="input num" id="pu" dir="ltr" placeholder="http://192.168.1.20:3001" value="${c.url}"></div>
          </div>
          <div class="field" style="margin-top:12px"><label>مفتاح الربط ${c.hasKey ? html`<span class="badge ok">متسجّل</span>` : html`<span class="badge warn">مش متسجّل</span>`}</label>
            <div class="row" style="gap:8px"><input class="input num" id="pk" dir="ltr" type="password" autocomplete="off" placeholder="${c.hasKey ? 'سيبه فاضي لو مش هتغيّره' : 'إنجليزي وأرقام، 16 حرف على الأقل'}">
              <button class="btn ghost" id="gen" type="button">توليد مفتاح</button></div>
            <div class="muted" style="font-size:12.5px;margin-top:4px">لازم نفس المفتاح يتحط في الناحيتين. بيتخزّن مشفّر ومبيظهرش تاني. ما تبعتوش في رسالة أو ملف.</div></div>
          <div class="row" style="gap:8px;margin-top:14px"><button class="btn" id="sv">${icon('check')} حفظ</button><button class="btn ghost" id="ts">جرّب الاتصال</button><span id="tr" class="muted"></span></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between"><h3 style="margin:0">${icon('history', 'sm')} المزامنة</h3><button class="btn ghost sm" id="fl">ابعت المتأخر دلوقتي</button></div>
          <div class="muted" style="margin:6px 0 10px;font-weight:600">مرضى مربوطين: <b class="num">${c.linked}</b> · تعديلات مستنية الإرسال: <b class="num">${c.pending}</b></div>
          ${c.outbox.length ? html`<table class="tbl"><thead><tr><th>وقت</th><th>نوع</th><th>محاولات</th><th>الحالة</th></tr></thead><tbody>${c.outbox.map((o) => html`<tr><td>${fmtAt(o.at)}</td><td>${o.op === 'unlink' ? 'فك ربط' : 'تعديل بيانات'}</td><td class="num">${o.attempts}</td><td>${o.done ? html`<span class="badge ok">اتبعت</span>` : html`<span class="badge warn">مستني</span> <small class="muted">${o.error || ''}</small>`}</td></tr>`)}</tbody></table>` : html`<div class="muted">مفيش تعديلات اتبعتت لسه.</div>`}
        </div>
      </div>`);
  };
  await draw();
  view.onclick = async (e) => {
    try {
      if (e.target.closest('#gen')) { const k = randKey(); const i = $('#pk', view); i.type = 'text'; i.value = k; toast('اتولّد مفتاح. انسخه وحطه في الناحية التانية قبل ما تحفظ.', 'info', 6000); }
      if (e.target.closest('#sv')) {
        await api.put('/peer/config', { enabled: $('#pe', view).checked, requirePaid: $('#prp', view).checked, name: $('#pn', view).value, url: $('#pu', view).value.trim(), publicUrl: $('#ppu', view).value.trim(), key: $('#pk', view).value });
        toast('اتحفظ'); await draw();
      }
      if (e.target.closest('#ts')) {
        const r = await api.post('/peer/test', {}); $('#tr', view).innerHTML = String(r.ok ? html`<span class="badge ok">متصل بـ ${r.name}</span>` : html`<span class="badge danger">${r.error}</span>`);
      }
      if (e.target.closest('#fl')) { const r = await api.post('/peer/flush', {}); toast(`اتبعت ${r.sent}، المتبقي ${r.pending}`); await draw(); }
    } catch (er) { toastError(er); }
  };
  return () => { view.onclick = null; };
}

/** نافذة بحث في المنشأة التانية واستيراد/ربط. onDone(localPatientId) */
export function openPeerSearch({ peerName = 'المنشأة التانية', q = '', linkTo = null, onDone } = {}) {
  const m = modal({
    title: linkTo ? `ربط «${linkTo.name}» بملف في ${peerName}` : `بحث في ${peerName}`, wide: true,
    body: html`<div class="big-search">${icon('search')}<input class="input" id="pq" type="search" autocomplete="off" autofocus value="${q}" placeholder="الاسم أو التليفون أو الرقم القومي"></div><div id="pr" style="margin-top:12px"></div>`,
  });
  const box = $('#pr', m.el), input = $('#pq', m.el);
  const run = debounce(async () => {
    const v = input.value.trim();
    if (v.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = String(html`<div class="skel" style="height:64px"></div>`);
    try {
      const r = await api.get('/peer/search?q=' + encodeURIComponent(v));
      box.innerHTML = r.results.length ? String(html`<div class="grid" style="gap:8px">${r.results.map((x) => html`
        <div class="card pad row" style="gap:10px;justify-content:space-between;align-items:center">
          <div><b>${x.name}</b> <span class="fileno num">ملف #${x.no}</span>
            <div class="muted" style="font-size:13px;font-weight:600">${x.nationalId ? html`<span class="num">${x.nationalId}</span> · ` : ''}${x.phone ? html`<span class="num">${x.phone}</span> · ` : ''}${x.ageYears != null ? x.ageYears + ' سنة' : ''}</div></div>
          ${x.local?.linked ? html`<a class="btn ghost sm" href="#/patient/${x.local.id}" data-close>مربوط · افتح ملفه</a>`
            : linkTo ? html`<button class="btn sm" data-link="${x.id}">ربط بالملف ده</button>`
            : x.local ? html`<button class="btn sm" data-linklocal="${x.id}" data-local="${x.local.id}">نفس الرقم القومي عندنا (ملف #${x.local.no}) · اربط</button>`
            : html`<button class="btn sm" data-imp="${x.id}">${icon('download', 'sm')} استيراد</button>`}
        </div>`)}</div>`)
        : String(html`<div class="muted" style="text-align:center;padding:18px">مفيش نتايج في ${r.peerName}</div>`);
    } catch (er) { box.innerHTML = String(html`<div class="alertbar danger">${icon('alert')}<span>${er.message}</span></div>`); }
  }, 300);
  input.addEventListener('input', run);
  if (q) run();
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-imp],[data-link],[data-linklocal]');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.imp) { const r = await api.post('/peer/import', { remoteId: Number(b.dataset.imp) }); toast('اتسجّل المريض عندنا ومربوط'); m.close(); onDone?.(r.patient.id); }
      else if (b.dataset.link) { await api.post('/peer/link', { localId: linkTo.id, remoteId: Number(b.dataset.link) }); toast('اتربط'); m.close(); onDone?.(linkTo.id); }
      else { await api.post('/peer/link', { localId: Number(b.dataset.local), remoteId: Number(b.dataset.linklocal) }); toast('اتربط'); m.close(); onDone?.(Number(b.dataset.local)); }
    } catch (er) { toastError(er); b.disabled = false; }
  });
}

/** صندوق الربط في ملف المريض: حالة الربط، اقتراح بالرقم القومي، ربط يدوي، فك الربط */
export async function peerPanel(box, p, reload) {
  let s;
  try { s = await api.get('/peer/suggest/' + p.id); } catch { return; }
  if (!s.enabled) return;
  const name = s.peerName;
  if (s.linked) {
    box.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px;align-items:center">${icon('link')}<b>مربوط بملف في ${name}</b>
      ${s.remote ? html`<span class="muted" style="font-weight:600">ملف #${s.remote.no} هناك · أي تعديل في البيانات التعريفية بيتزامن</span>` : s.reachable === false ? html`<span class="badge warn">${name} مش متصل دلوقتي (التعديلات بتستنى وتتبعت أوتوماتيك)</span>` : ''}
      ${can('visits.write') ? html`<button class="btn sm" id="rq" style="margin-inline-start:auto">${icon('plus', 'sm')} اطلب خدمة من ${name}</button>` : ''}
      ${can('cash.collect') ? html`<button class="btn sm" id="cmb" style="--c:var(--ok)">${icon('cash')} تحصيل مدمج</button>` : ''}
      ${can('visits.write') ? html`<button class="btn ghost sm" id="evo">راح ${name}</button><button class="btn ghost sm" id="evi">رجع من ${name}</button>` : ''}
      ${can('peer.manage') ? html`<button class="btn ghost sm" id="unl">فك الربط</button>` : ''}</div>
      <div id="peerReqs"></div>`);
    $('#rq', box)?.addEventListener('click', () => openRequestModal({ p, peerName: name, onDone: () => loadRequests(box, p, name) }));
    $('#cmb', box)?.addEventListener('click', () => openCombinedCollect({ p, peerName: name, onDone: reload }));
    const ev = (kind) => async () => { try { await api.post('/peer/events', { patientId: p.id, kind }); toast('اتسجّل'); reload(); } catch (er) { toastError(er); } };
    $('#evo', box)?.addEventListener('click', ev('to_peer'));
    $('#evi', box)?.addEventListener('click', ev('from_peer'));
    loadRequests(box, p, name);
    $('#unl', box)?.addEventListener('click', async () => {
      if (!confirm('فك الربط مع ' + name + '؟ الملفين هيفضلوا موجودين وكل واحد لوحده.')) return;
      try { await api.post('/peer/unlink', { localId: p.id }); toast('اتفك الربط'); reload(); } catch (er) { toastError(er); }
    });
    return;
  }
  const cand = s.candidate;
  box.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px;align-items:center;${cand ? 'border-color:#f0b429' : ''}">${icon('link')}
    ${cand ? html`<span><b>لقينا نفس الرقم القومي في ${name}</b> · ${cand.name} <span class="fileno num">ملف #${cand.no}</span></span><button class="btn sm" id="lk">ربط الملفين</button>` : html`<span class="muted" style="font-weight:700">مش مربوط بملف في ${name}</span>`}
    ${can('patients.write') ? html`<button class="btn ghost sm" id="mn" style="margin-inline-start:auto">دوّر واربط يدويًا</button>` : ''}</div>`);
  $('#lk', box)?.addEventListener('click', async () => { try { await api.post('/peer/link', { localId: p.id, remoteId: cand.id }); toast('اتربط'); reload(); } catch (er) { toastError(er); } });
  $('#mn', box)?.addEventListener('click', () => openPeerSearch({ peerName: name, q: p.name, linkTo: p, onDone: reload }));
}

const KIND = { to_peer: (n) => `راح ${n}`, from_peer: (n) => `رجع من ${n}` };
/** قايمة طلبات المريض عند المنشأة التانية + آخر حركة */
async function loadRequests(box, p, name) {
  const host = $('#peerReqs', box);
  if (!host) return;
  const [rq, ev] = await Promise.all([api.get('/peer/requests/' + p.id).catch(() => ({ requests: [] })), api.get('/peer/events/' + p.id).catch(() => ({ events: [] }))]);
  const lab = (e) => (e.origin === 'local' ? KIND[e.kind](name) : e.kind === 'to_peer' ? `جه من ${name}` : `خرج من ${name} راجع`);
  const ST = { new: ['warn', 'مستنية'], done: ['ok', 'اتنفذت'], cancelled: ['', 'اتلغت'] };
  if (!rq.requests.length && !ev.events.length) { host.innerHTML = ''; return; }
  host.innerHTML = String(html`<div class="card pad" style="margin-top:8px">
    ${ev.events.length ? html`<div class="muted" style="font-weight:600;margin-bottom:6px">${ev.events.slice(0, 3).map((e) => html`<span style="margin-inline-end:12px">${lab(e)} <span class="num">${fmtAt(e.at)}</span></span>`)}</div>` : ''}
    ${rq.reachable === false ? html`<div class="alertbar warn">${icon('alert')}<span>مفيش اتصال بـ ${name} دلوقتي، حالة الطلبات مش متاحة</span></div>` : ''}
    ${rq.requests.map((x) => html`<div class="row" style="gap:10px;padding:6px 0;border-top:1px solid var(--line)"><b>${x.service}</b><span class="num">${money(x.amount)}</span>
      <span class="badge ${ST[x.status][0]}">${ST[x.status][1]}</span>${x.paid ? html`<span class="badge ok">مدفوعة</span>` : ''}<span class="muted num" style="font-size:12.5px">${fmtAt(x.createdAt)}</span>
      ${x.status === 'new' && !x.paid && can('visits.write') ? html`<button class="btn ghost sm" data-cx="${x.id}" style="margin-inline-start:auto">إلغاء</button>` : ''}</div>`)}
  </div>`);
  $$('[data-cx]', host).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('إلغاء الطلب ده؟')) return;
    try { await api.post(`/peer/requests/${b.dataset.cx}/cancel`, {}); toast('اتلغى'); loadRequests(box, p, name); } catch (er) { toastError(er); }
  }));
}

/** مودال طلب خدمة من الصفا كاث: الخدمات والأسعار بتتجاب منهم وقت الطلب */
export async function openRequestModal({ p, peerName, onDone }) {
  let cat;
  try { cat = await api.get('/peer/services'); } catch (e) { return toastError(e); }
  const pick = new Map();
  const m = modal({
    title: `طلب خدمة من ${peerName} لـ ${p.name}`, wide: true,
    body: html`<div class="field"><input class="input" id="rqs" placeholder="دوّر على خدمة" autofocus></div>
      <div id="rql" style="max-height:260px;overflow:auto;margin:8px 0"></div>
      <div id="rqp"></div>
      <div class="field" style="margin-top:8px"><label>ملاحظة للفنّي <span class="hint">اختياري</span></label><input class="input" id="rqn" maxlength="300"></div>`,
    foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" id="rqgo">${icon('check')} ابعت الطلب</button>`,
  });
  const drawSel = () => {
    const arr = [...pick.values()];
    $('#rqp', m.el).innerHTML = String(html`${arr.map((x) => html`<div class="row" style="gap:8px;padding:6px 0;border-top:1px solid var(--line)"><b>${x.s.name}</b><span class="num">${money(x.s.price)}</span>
      ${x.s.hasDoctor ? html`<select class="input" data-doc="${x.s.id}" style="max-width:200px"><option value="">اختار الدكتور</option>${cat.doctors.map((d) => html`<option value="${d.id}" ${x.doctorId == d.id ? 'selected' : ''}>${d.name}</option>`)}</select>` : ''}
      <button class="btn ghost sm" data-rm="${x.s.id}" style="margin-inline-start:auto">شيل</button></div>`)}
      ${arr.length ? html`<div style="margin-top:8px;font-weight:800">الإجمالي: <span class="num">${money(arr.reduce((a, x) => a + x.s.price, 0))}</span> <span class="muted" style="font-weight:600">(بتتدفع في خزينة ${peerName})</span></div>` : ''}`);
    $$('[data-rm]', m.el).forEach((b) => b.addEventListener('click', () => { pick.delete(+b.dataset.rm); drawSel(); }));
    $$('[data-doc]', m.el).forEach((b) => b.addEventListener('change', () => { pick.get(+b.dataset.doc).doctorId = b.value; }));
  };
  const drawList = () => {
    const q = $('#rqs', m.el).value.trim().toLowerCase();
    const list = cat.services.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.code || '').toLowerCase().includes(q)).slice(0, 60);
    $('#rql', m.el).innerHTML = list.length ? String(html`${list.map((x) => html`<button class="btn ghost" data-add="${x.id}" style="display:flex;width:100%;justify-content:space-between;margin-bottom:4px"><span>${x.name}</span><span class="num">${money(x.price)}</span></button>`)}`)
      : String(html`<div class="muted" style="padding:12px;font-weight:600">${cat.services.length ? 'مفيش نتيجة' : `مفيش خدمات متسجّلة في ${peerName} لسه`}</div>`);
    $$('[data-add]', m.el).forEach((b) => b.addEventListener('click', () => { const s = cat.services.find((x) => x.id === +b.dataset.add); if (!pick.has(s.id)) pick.set(s.id, { s, doctorId: '' }); drawSel(); }));
  };
  $('#rqs', m.el).addEventListener('input', debounce(drawList, 150));
  drawList(); drawSel();
  $('#rqgo', m.el).addEventListener('click', async () => {
    if (!pick.size) return toast('اختار خدمة على الأقل', 'warn');
    try {
      const r = await api.post('/peer/requests', { patientId: p.id, note: $('#rqn', m.el).value, items: [...pick.values()].map((x) => ({ serviceId: x.s.id, doctorId: x.doctorId || null })) });
      m.close(); toast(`اتبعت الطلب. المريض يدفع ${money(r.total)} في ${peerName}`); onDone?.();
    } catch (e) { toastError(e); }
  });
}

/** شاشة «طلبات المستشفى» عند فنّي القسطرة */
export async function renderPeerWork(view, { setTitle }) {
  setTitle('طلبات المستشفى', 'الخدمات المطلوبة من الاستقبال');
  const draw = async () => {
    const d = await api.get('/peer/work');
    const lab = (e) => (e.kind === 'to_peer' ? 'راح ' + d.peerName : 'رجع من ' + d.peerName);
    view.innerHTML = String(html`<div class="grid" style="gap:12px;max-width:900px;margin:0 auto">
      ${d.requests.length ? d.requests.map((x) => html`<div class="card pad row wrap" style="gap:10px;align-items:center;${x.status === 'done' ? 'opacity:.65' : ''}">
        <div style="min-width:0"><b>${x.patient.name}</b> <span class="fileno num">#${x.patient.no}</span><div class="muted" style="font-weight:600">${x.service}${x.doctor ? ' · ' + x.doctor : ''} · من ${x.fromName || ''}${x.fromUser ? ' (' + x.fromUser + ')' : ''}</div>
          ${x.note ? html`<div style="font-size:13px">${icon('note', 'sm')} ${x.note}</div>` : ''}
          ${x.event ? html`<div class="muted" style="font-size:12.5px">آخر حركة: ${x.event.origin === 'remote' ? (x.event.kind === 'to_peer' ? 'وصل من ' + d.peerName : 'خرج راجع ' + d.peerName) : lab(x.event)} · ${fmtAt(x.event.at)}</div>` : ''}</div>
        <span class="badge ${x.paid ? 'ok' : 'warn'}" style="margin-inline-start:auto">${x.paid ? 'مدفوعة' : 'لسه ما اتدفعتش'}</span>
        ${x.status === 'new' ? html`<button class="btn" data-done="${x.id}">${icon('check')} تم التنفيذ</button>` : html`<span class="badge ok">اتنفذت</span>${can('peer.manage') ? html`<button class="btn ghost sm" data-re="${x.id}">إعادة فتح</button>` : ''}`}
      </div>`) : html`<div class="card pad muted" style="font-weight:700;text-align:center">مفيش طلبات دلوقتي</div>`}
    </div>`);
    $$('[data-done]', view).forEach((b) => b.addEventListener('click', async () => { try { await api.post(`/peer/work/${b.dataset.done}/done`, {}); toast('تمام'); draw(); } catch (e) { toastError(e); } }));
    $$('[data-re]', view).forEach((b) => b.addEventListener('click', async () => { try { await api.post(`/peer/work/${b.dataset.re}/reopen`, {}); draw(); } catch (e) { toastError(e); } }));
  };
  await draw();
  const t = setInterval(() => { if (view.isConnected) draw().catch(() => {}); }, 20000);
  return () => clearInterval(t);
}

/** التحصيل المدمج: شاشة واحدة، مبلغين (مستشفى + المنشأة التانية)، وإيصالين */
export async function openCombinedCollect({ p, peerName, onDone }) {
  let d;
  const load = async () => { d = await api.get('/peer/cashier/' + p.id); };
  try { await load(); } catch (e) { return toastError(e); }
  const m = modal({ title: `تحصيل ${p.name}`, wide: true, body: html`<div id="cb"></div>`, foot: '' });
  const side = (key, title, x, ok) => html`<div class="card pad" style="flex:1;min-width:280px">
    <h4 style="margin:0 0 6px">${title}</h4>
    ${ok === false ? html`<div class="alertbar warn">${icon('alert')}<span>${x?.error || 'مفيش اتصال'}. التحصيل المدمج متوقف، حصّل المستشفى لوحدها وارجع بعدين.</span></div>` : html`
      ${x.items.length ? x.items.map((i) => html`<div class="row" style="justify-content:space-between;padding:3px 0"><span>${i.name}</span><span class="num">${money(i.amount)}</span></div>`) : html`<div class="muted" style="font-weight:600">مفيش مستحقات</div>`}
      <div style="font-weight:800;margin:6px 0">المطلوب: <span class="num">${money(x.total)}</span></div>
      ${x.shift?.open ? '' : html`<div class="alertbar warn" style="margin-bottom:6px">${icon('alert')}<span>مفيش وردية مفتوحة هنا (هتتفتح تلقائيًا مع أول تحصيل، أو افتحها من فوق)</span></div>`}
      ${x.total > 0 ? html`<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>نقدي</label><input class="input num" data-k="${key}-cash" inputmode="decimal" value="${x.total}"></div>
        <div class="field" style="flex:1"><label>فيزا</label><input class="input num" data-k="${key}-card" inputmode="decimal" value="0"></div></div>` : ''}`}
  </div>`;
  const draw = () => {
    const peerOk = d.peer && d.peer.reachable !== false && !d.peer.error;
    $('#cb', m.el).innerHTML = String(html`
      <div class="row wrap" style="gap:12px;align-items:stretch">${side('l', 'المستشفى', d.local, true)}
        ${!d.enabled || !d.patient.linked ? '' : side('p', peerName, d.peer, peerOk)}</div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn" id="cgo">${icon('check')} حصّل واطبع الإيصالات</button>
        ${d.local.shift.open && (!peerOk || d.peer?.shift?.open) ? '' : html`<button class="btn ghost" id="csh">افتح الورديات</button>`}
      </div><div id="cres"></div>`);
    $('#csh', m.el)?.addEventListener('click', async () => { try { await api.post('/peer/cashier/shift/open', {}); await load(); draw(); } catch (e) { toastError(e); } });
    $('#cgo', m.el).addEventListener('click', async () => {
      const g = (k) => $(`[data-k="${k}"]`, m.el)?.value || '0';
      const body = { patientId: p.id, local: { cash: g('l-cash'), card: g('l-card') }, peer: { cash: g('p-cash'), card: g('p-card') } };
      try {
        const r = await api.post('/peer/cashier/collect', body);
        if (r.partial) {
          $('#cres', m.el).innerHTML = String(html`<div class="alertbar warn" style="margin-top:10px">${icon('alert')}<span>المستشفى اتحصّلت، لكن ${peerName} فشلت: ${r.error}. حصّلها لوحدها بعدين.</span></div>`);
          if (r.local[0]) printReceipt(r.local[0].id); onDone?.(); return;
        }
        $('#cres', m.el).innerHTML = String(html`<div class="alertbar ok" style="margin-top:10px">${icon('check')}<span>اتحصّل. إيصالات المستشفى: ${r.local.map((e) => '#' + e.no).join('، ') || '—'}${r.peer.length ? html` · ${peerName}: ${r.peer.map((e) => '#' + e.no).join('، ')}` : ''}</span></div>`);
        for (const e of r.local) printReceipt(e.id);
        toast('تمام'); onDone?.();
      } catch (e) {
        toastError(e);
      }
    });
  };
  draw();
}
