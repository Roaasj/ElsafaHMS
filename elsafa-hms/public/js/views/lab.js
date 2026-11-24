// المعمل: قايمة الشغل بالمريض، سحب العينات والملصقات، إدخال النتايج بالمعدلات، الاعتماد، المعامل الخارجية، والتسليم، وتعديل التحاليل
import {
  api, html, raw, icon, $, $$, fmtTime, fmtWhen, ago, initials, sexName, modal, toast, toastError, askReason, can, debounce, ApiError,
  LAB_ST, LAB_SECTIONS, printLab, printLabels, labFlag,
} from '../core.js';
import { ageText } from '/shared/nid.js';

const GROUPS = [['waiting', 'مستني السحب', 'hourglass'], ['inlab', 'في المعمل', 'flask'], ['ready', 'جاهز للتسليم', 'check'], ['delivered', 'اتسلّم النهارده', 'user']];
const SAMPLE = { blood: 'دم', serum: 'سيرم', urine: 'بول', stool: 'براز', swab: 'مسحة', other: 'أخرى' };
const ageOf = (p) => ageText(p.birthDate, p.ageYears, null) || '';
const autoPrint = () => localStorage.getItem('autoPrint') !== '0';

// ================= قايمة الشغل =================
export async function renderLab(view, { query, setTitle }) {
  const tab = query.get('tab') === 'tests' ? 'tests' : 'list';
  setTitle('المعمل', tab === 'tests' ? 'التحاليل وبنودها والمعدلات الطبيعية' : 'من الدفع لحد تسليم النتيجة');
  view.innerHTML = String(html`<nav class="stabs"><a href="#/lab" class="stab ${tab === 'list' ? 'on' : ''}">${icon('flask')}<span>قايمة الشغل</span></a>
    <a href="#/lab?tab=tests" class="stab ${tab === 'tests' ? 'on' : ''}">${icon('list')}<span>التحاليل</span></a></nav><div id="lp"></div>`);
  const pane = $('#lp', view);
  if (tab === 'tests') return testsPane(pane);

  const S = { group: query.get('group') || 'waiting', q: '', timer: null };
  pane.innerHTML = String(html`<div class="rgroups lg" id="lg"></div>
    <div class="row wrap" style="gap:10px;margin:12px 0">
      <span class="muted" id="lvh" style="font-weight:700;font-size:13px"></span>
      <div class="big-search" style="flex:1 1 240px;max-width:380px;margin-inline-start:auto">${icon('search')}<input class="input" id="lq" type="search" inputmode="search" placeholder="اسم المريض، رقم الملف، أو رقم العينة" style="height:44px;font-size:15px;padding-inline-start:42px;border-radius:12px"></div>
    </div><div id="ll"><div class="skel" style="height:260px"></div></div>`);
  let data;
  const card = (g) => {
    const waiting = g.tests.filter((t) => t.status === 'waiting');
    const ready = g.tests.filter((t) => t.status === 'verified');
    const acts = [];
    if (waiting.length && can('lab.work')) acts.push(html`<button class="btn sm" data-collect="${g.gkey}" style="--c:var(--lab)">${icon('check', 'sm')} اتسحبت العينة${waiting.length < g.tests.length ? html` (<span class="num">${waiting.length}</span>)` : ''}</button>`);
    if (g.tests.some((t) => ['collected', 'done', 'sent'].includes(t.status)) && can('lab.work')) acts.push(html`<a class="btn sm" href="#/labg/${g.gkey}">${icon('edit', 'sm')} النتايج</a>`);
    if (ready.length && can('lab.deliver')) acts.push(html`<button class="btn sm" data-deliver="${g.gkey}" style="--c:var(--ok)">${icon('user', 'sm')} سلّم${ready.length < g.tests.length ? html` (<span class="num">${ready.length}</span>)` : ''}</button>`);
    if (g.tests.some((t) => ['verified', 'delivered', 'done'].includes(t.status))) acts.push(html`<button class="btn ghost icon sm" data-print="${g.gkey}" title="اطبع النتيجة">${icon('print', 'sm')}</button>`);
    if (g.accNo && can('lab.work')) acts.push(html`<button class="btn ghost icon sm" data-labels="${g.gkey}" title="ملصقات العينة">${icon('tag', 'sm')}</button>`);
    return html`<article class="card labcard ${g.overdue ? 'over' : ''}" data-open="${g.gkey}">
      <div class="rc-pt"><span class="pavatar" style="width:42px;height:42px;border-radius:13px;font-size:14px">${initials(g.patient.name)}</span>
        <div style="min-width:0"><b>${g.patient.name}</b><small>ملف <span class="num">${g.patient.no}</span> · ${sexName(g.patient.sex)}${ageOf(g.patient) ? ' · ' + ageOf(g.patient) : ''}</small></div>
        <div class="lc-acc">${g.accNo ? html`<small>عينة</small><b class="num">${g.accNo}</b>` : html`<small>اتطلب</small><b style="font-size:13px">${ago(g.requestedAt)}</b>`}</div></div>
      ${g.bed ? html`<div class="rc-meta"><span>${icon('bed', 'sm')} داخلي · سرير <span class="num">${g.bed}</span></span>${g.doctor ? html`<span>${icon('steth', 'sm')} ${g.doctor}</span>` : ''}</div>` : g.doctor ? html`<div class="rc-meta"><span>${icon('steth', 'sm')} ${g.doctor}</span></div>` : ''}
      <div class="ltests">${g.tests.map((t) => html`<span class="ltest st-${t.status} ${t.overdue ? 'od' : ''}" title="${LAB_ST[t.status]?.name}">${t.external ? icon('send', 'sm') : ''}${t.code || t.service}<i></i></span>`)}</div>
      ${acts.length ? html`<div class="rc-acts">${acts}</div>` : ''}
    </article>`;
  };
  const draw = () => {
    const c = data.counts;
    $('#lg', pane).innerHTML = String(html`${GROUPS.map(([k, n, ic]) => html`<button class="rgroup g-${k} ${S.group === k ? 'on' : ''}" data-g="${k}"><span class="gi">${icon(ic)}</span><div><small>${n}</small><b class="num">${c[k]}</b></div>${k === 'inlab' && c.overdue ? html`<span class="badge danger od">${c.overdue} متأخر</span>` : ''}</button>`)}`);
    $('#lvh', pane).textContent = `${data.groups.length} مريض${data.verifyRequired ? ' · النتايج محتاجة اعتماد دكتور المعمل' : ''}`;
    $('#ll', pane).innerHTML = data.groups.length ? String(html`<div class="radgrid">${data.groups.map(card)}</div>`)
      : String(html`<div class="card empty"><div class="art" style="background:var(--lab-soft);color:var(--lab)">${icon(S.group === 'waiting' ? 'check' : 'flask')}</div><b>${{ waiting: 'مفيش حد مستني سحب', inlab: 'مفيش عينات في المعمل', ready: 'مفيش نتايج مستنية التسليم', delivered: 'لسه ما اتسلّمش حاجة النهارده' }[S.group]}</b></div>`);
  };
  const load = async () => { data = await api.get(`/lab?group=${S.group}${S.q ? '&q=' + encodeURIComponent(S.q) : ''}`); draw(); };
  pane.onclick = async (e) => {
    const g = e.target.closest('[data-g]');
    if (g) { S.group = g.dataset.g; return load(); }
    const co = e.target.closest('[data-collect]');
    if (co) {
      e.stopPropagation();
      try { const r = await api.post(`/lab/g/${co.dataset.collect}/collect`); toast(`عينة رقم ${r.accNo}`); if (autoPrint()) printLabels(co.dataset.collect); load(); } catch (er) { toastError(er); }
      return;
    }
    const dv = e.target.closest('[data-deliver]');
    if (dv) { e.stopPropagation(); return deliver(dv.dataset.deliver, data.groups.find((x) => x.gkey === dv.dataset.deliver), load); }
    const pr = e.target.closest('[data-print]');
    if (pr) { e.stopPropagation(); return printLab(pr.dataset.print); }
    const lb = e.target.closest('[data-labels]');
    if (lb) { e.stopPropagation(); return printLabels(lb.dataset.labels); }
    if (e.target.closest('a,button')) return;
    const o = e.target.closest('[data-open]');
    if (o) window.go('/labg/' + o.dataset.open);
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'lq') { S.q = e.target.value.trim(); load(); } }, 250);
  pane.onkeydown = (e) => { if (e.target.id === 'lq' && e.key === 'Enter' && data?.groups.length === 1) window.go('/labg/' + data.groups[0].gkey); };
  await load();
  setTimeout(() => $('#lq', pane)?.focus(), 50);
  S.timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 15000);
  return () => { clearInterval(S.timer); pane.onclick = pane.oninput = pane.onkeydown = null; };
}

function deliver(gkey, g, after) {
  const ready = g.tests.filter((t) => t.status === 'verified');
  const m = modal({
    title: 'تسليم النتايج',
    body: html`<div class="pricehead" style="--ds:var(--ok-soft);--dc:var(--ok)"><span class="dicon">${icon('user')}</span><div><b>${g.patient.name}</b><small>ملف <span class="num">${g.patient.no}</span>${g.accNo ? html` · عينة <span class="num">${g.accNo}</span>` : ''}</small></div></div>
      <div class="ltests" style="margin:12px 0">${ready.map((t) => html`<span class="ltest st-verified">${t.code || t.service}<i></i></span>`)}</div>
      ${ready.length < g.tests.length ? html`<div class="alertbar warn" style="margin-bottom:10px">${icon('info')}<span>فيه ${g.tests.length - ready.length} تحليل لسه ما خلصش، هيتسلّم بعدين.</span></div>` : ''}
      <div class="field"><label>استلم مين؟</label><input class="input" name="to" value="${g.patient.name}"></div>`,
    foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn ghost" data-pr>${icon('print')} اطبع</button><button class="btn" data-go style="--c:var(--ok)">${icon('check')} اتسلّمت</button>`,
  });
  $('[data-pr]', m.el).addEventListener('click', () => printLab(gkey, ready.map((t) => t.key)));
  $('[data-go]', m.el).addEventListener('click', async () => {
    try { await api.post(`/lab/g/${gkey}/deliver`, { to: $('[name=to]', m.el).value, keys: ready.map((t) => t.key) }); m.close(); toast('اتسجل التسليم'); after?.(); } catch (er) { toastError(er); }
  });
}

// ================= نتايج مريض =================
export async function renderLabGroup(view, { params, setTitle }) {
  const gkey = params[0];
  let G = await api.get('/lab/g/' + gkey);
  let dirty = false;
  const P = () => G.patient;
  setTitle('نتايج ' + G.patient.name, `${G.tests.length} تحليل${G.accNo ? ' · عينة ' + G.accNo : ''}`);

  const editableT = (t) => ['collected', 'done', 'sent'].includes(t.status) || (t.status === 'verified' && can('lab.verify')) || (t.status === 'delivered' && can('settings.manage'));
  const flagHtml = (f) => (f === 'H' ? html`<b class="lflag hi">↑ H</b>` : f === 'L' ? html`<b class="lflag lo">↓ L</b>` : f === 'A' ? html`<b class="lflag ab">*</b>` : '');

  const drawHead = () => {
    const waiting = G.tests.filter((t) => t.status === 'waiting');
    const done = G.tests.filter((t) => t.status === 'done');
    const ready = G.tests.filter((t) => t.status === 'verified');
    $('#lhead', view).innerHTML = String(html`
      <div class="rh-main"><span class="pavatar" style="width:52px;height:52px;border-radius:16px">${initials(P().name)}</span>
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><h2 style="margin:0;font-size:20px">${P().name}</h2><a class="badge brand num" href="#/patient/${P().id}">#${P().no}</a></div>
          <div class="muted" style="font-weight:600;font-size:13px">${sexName(P().sex)}${ageOf(P()) ? ' · ' + ageOf(P()) : ''}${G.bed ? html` · سرير <span class="num">${G.bed}</span>` : ''}${G.doctor ? ` · ${G.doctor}` : ''}</div></div>
        ${G.accNo ? html`<div class="lc-acc big"><small>رقم العينة</small><b class="num">${G.accNo}</b></div>` : ''}</div>
      <div class="rh-acts">
        ${waiting.length && can('lab.work') ? html`<button class="btn" data-a="collect" style="--c:var(--lab)">${icon('check')} اتسحبت العينة (<span class="num">${waiting.length}</span>)</button>` : ''}
        ${G.accNo && can('lab.work') ? html`<button class="btn ghost" data-a="labels">${icon('tag')} الملصقات</button>` : ''}
        ${done.length && can('lab.verify') ? html`<button class="btn" data-a="verify" style="--c:var(--ok)">${icon('check')} اعتمد (<span class="num">${done.length}</span>)</button>` : ''}
        ${ready.length && can('lab.deliver') ? html`<button class="btn soft" data-a="deliver" style="--c:var(--ok)">${icon('user')} سلّم</button>` : ''}
        ${G.tests.some((t) => ['done', 'verified', 'delivered'].includes(t.status)) ? html`<button class="btn ghost" data-a="print">${icon('print')} اطبع النتيجة</button>` : ''}
      </div>`);
  };

  const testCard = (t) => {
    const ed = editableT(t) && can('lab.work') && !t.hasFile;
    return html`<section class="card ltcard st-${t.status}" data-t="${t.key}">
      <div class="lt-head"><b>${t.testName || t.service}</b>${t.code ? html`<span class="code num">${t.code}</span>` : ''}
        <span class="badge ${LAB_ST[t.status]?.cls || ''}">${LAB_ST[t.status]?.name}</span>${t.overdue ? html`<span class="badge danger">متأخر</span>` : ''}
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px;font-weight:700">${SAMPLE[t.sample] || ''}${t.tube ? ' · ' + t.tube : ''}${t.dueAt && !['verified', 'delivered'].includes(t.status) ? ' · متوقع ' + fmtTime(t.dueAt) : ''}</span>
        ${can('lab.work') && t.status !== 'waiting' ? html`<button class="btn ghost icon sm" data-undo="${t.key}" title="رجوع خطوة">${icon('undo', 'sm')}</button>` : ''}</div>
      ${t.status === 'waiting' ? html`<div class="muted" style="padding:10px 4px;font-weight:600">العينة لسه ما اتسحبتش</div>`
      : t.external && !t.hasFile ? html`<div class="extbox">${icon('send')}<div><b>${t.status === 'sent' ? `اتبعت ${t.sentTo ? 'لـ ' + t.sentTo : 'بره'}` : 'تحليل بيتعمل في معمل خارجي'}</b><small>${t.sentAt ? fmtWhen(t.sentAt) : t.externalLab || ''}</small></div>
          ${t.status === 'collected' && can('lab.work') ? html`<button class="btn soft sm" data-send="${t.key}" style="--c:var(--py)">${icon('send', 'sm')} اتبعت</button>` : ''}
          ${can('lab.work') ? html`<label class="btn sm" style="cursor:pointer">${icon('upload', 'sm')} ارفع النتيجة<input type="file" data-file="${t.key}" accept="application/pdf,image/*" hidden></label>` : ''}
          <span class="muted" style="font-size:12px;font-weight:600;flex-basis:100%">أو اكتب النتيجة هنا لو جت ورقة</span></div>` : ''}
      ${t.hasFile ? html`<a class="filecard" href="/api/lab/w/${t.key}/file" target="_blank" rel="noopener">${icon('file')}<div><b>نتيجة المعمل الخارجي</b><small>دوس للفتح</small></div></a>`
      : t.status !== 'waiting' ? html`<div class="table-wrap"><table class="table ltable" dir="ltr"><thead><tr><th>Test</th><th style="width:30%">Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>
        ${t.values.map((v, i) => v.kind === 'header' ? html`<tr class="hd"><td colspan="4">${v.name}</td></tr>` : html`<tr class="${v.flag ? 'fl-' + v.flag : ''}" data-row="${i}">
          <td><b>${v.name}</b></td>
          <td>${ed ? (v.kind === 'select' ? html`<select class="select lin" data-k="${t.key}" data-i="${i}"><option value=""></option>${String(v.options || '').split('|').filter(Boolean).map((o) => html`<option ${o === v.value ? 'selected' : ''}>${o}</option>`)}${v.value && !String(v.options || '').split('|').includes(v.value) ? html`<option selected>${v.value}</option>` : ''}</select>`
            : html`<input class="input lin num" data-k="${t.key}" data-i="${i}" value="${v.value || ''}" ${v.kind === 'num' ? 'inputmode="decimal"' : ''} autocomplete="off">`) : html`<span class="lval">${v.value || '—'}</span>`}
            <span class="lfl">${flagHtml(v.flag)}</span></td>
          <td class="muted">${v.unit || ''}</td><td class="muted lref">${v.refText || ''}</td></tr>`)}
        </tbody></table></div>
        ${ed ? html`<input class="input lcomment" data-k="${t.key}" placeholder="ملاحظة على النتيجة (اختياري)" value="${t.comment || ''}" dir="auto">` : t.comment ? html`<p class="muted" dir="ltr" style="margin:6px 4px;font-size:13px"><b>Comment:</b> ${t.comment}</p>` : ''}` : ''}
      ${t.enteredBy || t.verifiedBy ? html`<div class="lt-foot muted">${t.enteredBy ? html`${icon('edit', 'sm')} ${t.enteredBy} ${fmtTime(t.enteredAt)}` : ''}${t.verifiedBy ? html` · ${icon('check', 'sm')} ${t.verifiedBy} ${fmtTime(t.verifiedAt)}` : ''}${t.deliveredTo ? html` · ${icon('user', 'sm')} ${t.deliveredTo}` : ''}</div>` : ''}
    </section>`;
  };
  const drawTests = () => {
    const anyEd = G.tests.some((t) => editableT(t) && can('lab.work') && !t.hasFile && t.status !== 'waiting');
    $('#ltests', view).innerHTML = String(html`${G.tests.map(testCard)}
      ${anyEd ? html`<div class="savebar"><span class="muted" id="ldirty" style="font-weight:700;align-self:center"></span><button class="btn ghost lg" data-a="draft">${icon('check')} احفظ <span class="kb">Ctrl+S</span></button>
        <button class="btn lg" data-a="final" style="--c:var(--lab)">${icon('check')} ${G.verifyRequired && !can('lab.verify') ? 'خلّص وابعت للاعتماد' : 'النتيجة جاهزة'}</button></div>` : ''}`);
  };
  view.innerHTML = String(html`<section class="card rhead" id="lhead"></section><div id="ltests" class="ltests-wrap"></div>`);
  drawHead(); drawTests();
  setTimeout(() => $('.lin', view)?.focus(), 80);
  const refresh = (g) => { G = g; dirty = false; drawHead(); drawTests(); };

  const collectValues = (onlyFilled) => G.tests.filter((t) => editableT(t) && !t.hasFile && t.status !== 'waiting').map((t) => {
    const values = t.values.map((v, i) => ({ paramId: v.paramId, name: v.name, value: v.kind === 'header' ? null : ($(`[data-k="${t.key}"][data-i="${i}"]`, view)?.value ?? v.value ?? '') }));
    return { key: t.key, values, comment: $(`.lcomment[data-k="${t.key}"]`, view)?.value || '', filled: values.some((v) => v.value) };
  }).filter((x) => !onlyFilled || x.filled);
  const save = async (final) => {
    const tests = collectValues(final);
    if (!tests.length) return toast(final ? 'اكتب نتيجة تحليل واحد على الأقل' : 'مفيش حاجة تتحفظ', 'warn');
    try {
      const r = await api.post(`/lab/g/${gkey}/results`, { final, tests });
      refresh(r);
      toast(final ? (G.verifyRequired && !can('lab.verify') ? 'النتايج اتبعتت للاعتماد' : 'النتايج جاهزة') : 'اتحفظ');
      if (final && autoPrint() && r.tests.some((t) => t.status === 'verified')) printLab(gkey);
      if (final && G.verifyRequired && can('lab.verify') && r.tests.some((t) => t.status === 'done')) {
        await api.post(`/lab/g/${gkey}/verify`).then(refresh).catch(() => {});
      }
    } catch (er) { toastError(er); }
  };

  view.oninput = (e) => {
    const inp = e.target.closest('.lin');
    if (inp) {
      dirty = true;
      const t = G.tests.find((x) => x.key === inp.dataset.k);
      const v = t.values[Number(inp.dataset.i)];
      const f = labFlag(v, inp.value, P().sex, P().age);
      const row = inp.closest('tr');
      row.className = f ? 'fl-' + f : '';
      $('.lfl', row).innerHTML = String(flagHtml(f));
      $('#ldirty', view) && ($('#ldirty', view).textContent = 'فيه تعديل ما اتحفظش');
    }
    if (e.target.classList.contains('lcomment')) dirty = true;
  };
  view.onchange = async (e) => {
    if (e.target.matches('select.lin')) view.oninput(e);
    const f = e.target.closest('[data-file]');
    if (f && f.files[0]) {
      const file = f.files[0];
      if (file.size > 20 * 1024 * 1024) return toast('الملف أكبر من 20 ميجا', 'err');
      try {
        const r = await fetch(`/api/lab/w/${f.dataset.file}/file`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new ApiError(r.status, j);
        refresh(j); toast('اترفعت النتيجة');
      } catch (er) { toastError(er); }
    }
  };
  view.onkeydown = (e) => {
    if (e.target.classList.contains('lin') && e.key === 'Enter') {
      e.preventDefault();
      const all = $$('.lin, .lcomment', view);
      const i = all.indexOf(e.target);
      (all[i + 1] || $('[data-a=final]', view))?.focus();
    }
  };
  view.onclick = async (e) => {
    const sd = e.target.closest('[data-send]');
    if (sd) {
      const t = G.tests.find((x) => x.key === sd.dataset.send);
      const m = modal({ title: 'اتبعت لمعمل خارجي', body: html`<div class="form-grid"><div class="field c4"><label>المعمل</label><input class="input" name="to" value="${t.externalLab || ''}" autofocus></div><div class="field c2"><label>النتيجة بعد (ساعة)</label><input class="input num" name="h" value="72" inputmode="numeric"></div></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go style="--c:var(--py)">${icon('send')} اتبعت</button>` });
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { refresh(await api.post(`/lab/w/${t.key}/send`, { to: $('[name=to]', m.el).value, hours: $('[name=h]', m.el).value })); m.close(); toast('اتسجل'); } catch (er) { toastError(er); }
      });
      return;
    }
    const un = e.target.closest('[data-undo]');
    if (un) {
      const t = G.tests.find((x) => x.key === un.dataset.undo);
      const reason = await askReason({ title: `رجوع خطوة: ${t.code || t.service}`, label: 'السبب', confirm: 'رجّع', note: `الحالة هترجع من «${LAB_ST[t.status].name}»` });
      if (!reason) return;
      try { refresh(await api.post(`/lab/w/${t.key}/undo`, { reason })); toast('رجعت خطوة', 'info'); } catch (er) { toastError(er); }
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      if (a === 'collect') { const r = await api.post(`/lab/g/${gkey}/collect`); refresh(r); toast(`عينة رقم ${r.accNo}`); if (autoPrint()) printLabels(gkey); setTimeout(() => $('.lin', view)?.focus(), 60); }
      if (a === 'labels') printLabels(gkey);
      if (a === 'verify') { refresh(await api.post(`/lab/g/${gkey}/verify`)); toast('اتعتمدت النتايج'); if (autoPrint()) printLab(gkey); }
      if (a === 'deliver') deliver(gkey, G, async () => refresh(await api.get('/lab/g/' + gkey)));
      if (a === 'print') { if (dirty) await save(false); printLab(gkey); }
      if (a === 'draft') save(false);
      if (a === 'final') save(true);
    } catch (er) { toastError(er); }
  };
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && $('[data-a=draft]', view)) { e.preventDefault(); save(false); } };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload); view.onclick = view.oninput = view.onchange = view.onkeydown = null; };
}

// ================= تعديل التحاليل =================
const rangesText = (rs) => (rs || []).map((r) => `${r.s ? (r.s === 'M' ? 'رجال ' : 'ستات ') : ''}${r.a0 != null || r.a1 != null ? `${r.a0 ?? 0}–${r.a1 ?? '∞'} سنة ` : ''}${r.lo != null && r.hi != null ? `${r.lo}–${r.hi}` : r.hi != null ? `< ${r.hi}` : `> ${r.lo}`}`).join(' · ');

async function testsPane(pane) {
  let data, q = '', sec = '';
  const draw = () => {
    const list = data.tests.filter((t) => (!sec || t.section === sec) && (!q || `${t.name} ${t.arName} ${t.code}`.toLowerCase().includes(q.toLowerCase())));
    const unlinked = data.services.filter((s) => s.active && !s.testId);
    pane.innerHTML = String(html`<div class="pagehead"><div class="dtabs">${[['', 'الكل'], ...Object.entries(LAB_SECTIONS)].filter(([k]) => !k || data.tests.some((t) => t.section === k)).map(([k, n]) => html`<button class="dtab ${sec === k ? 'on' : ''}" data-sec="${k}" style="--dc:var(--lab)">${n}</button>`)}</div>
        <div class="big-search" style="flex:1 1 200px;max-width:300px">${icon('search')}<input class="input" id="tq" value="${q}" placeholder="دوّر" style="height:40px;font-size:14px;padding-inline-start:40px;border-radius:12px"></div>
        ${can('lab.templates') ? html`<button class="btn" data-new>${icon('plus')} تحليل جديد</button>` : ''}</div>
      <div class="alertbar warn" style="margin-bottom:12px">${icon('alert')}<span>المعدلات الطبيعية دي قيم مرجعية شائعة كبداية. لازم دكتور المعمل يراجعها ويظبطها على أجهزة وكواشف المعمل قبل التشغيل.</span></div>
      ${unlinked.length ? html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>خدمات معمل مش مربوطة بتحليل (نتيجتها هتبقى خانة نص بس): <b>${unlinked.map((s) => s.name).join('، ')}</b></span></div>` : ''}
      <div class="table-wrap card" style="padding:4px 8px"><table class="table"><thead><tr><th>التحليل</th><th class="hide-sm">القسم</th><th class="hide-sm">العينة</th><th>البنود</th><th class="hide-sm">الخدمة</th><th class="n hide-sm">الوقت</th><th></th></tr></thead><tbody>
        ${list.map((t) => html`<tr class="${t.active ? '' : 'off-row'}"><td><b dir="ltr">${t.name}</b> <span class="code num">${t.code}</span><div class="muted" style="font-size:12px">${t.arName || ''}${t.external ? html` · <span style="color:var(--py)">${icon('send', 'sm')} ${t.externalLab || 'معمل خارجي'}</span>` : ''}</div></td>
          <td class="hide-sm">${LAB_SECTIONS[t.section]}</td><td class="hide-sm">${SAMPLE[t.sample]}${t.tube ? ' · ' + t.tube : ''}</td><td class="num">${t.params.filter((p) => p.kind !== 'header').length}</td>
          <td class="hide-sm">${data.services.find((s) => s.id === t.serviceId)?.name || html`<span class="muted">بالكلمات</span>`}</td><td class="n hide-sm num">${t.hours} س</td>
          <td class="n">${can('lab.templates') ? html`<button class="btn ghost icon sm" data-edit="${t.id}">${icon('edit', 'sm')}</button>` : ''}</td></tr>`)}</tbody></table></div>`);
  };
  const load = async () => { data = await api.get('/lab/tests?all=1'); draw(); };
  pane.onclick = (e) => {
    const s = e.target.closest('[data-sec]');
    if (s) { sec = s.dataset.sec; return draw(); }
    if (e.target.closest('[data-new]')) return editTest(null, data, load);
    const ed = e.target.closest('[data-edit]');
    if (ed) editTest(data.tests.find((t) => t.id === Number(ed.dataset.edit)), data, load);
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'tq') { q = e.target.value; draw(); const i = $('#tq', pane); i.focus(); i.setSelectionRange(q.length, q.length); } }, 200);
  await load();
  return () => { pane.onclick = pane.oninput = null; };
}

function editTest(t, data, onSaved) {
  const T = t ? JSON.parse(JSON.stringify(t)) : { name: '', code: '', arName: '', section: 'chemistry', sample: 'serum', tube: '', hours: 2, external: false, externalLab: '', keywords: '', serviceId: null, active: true, params: [{ name: '', unit: '', kind: 'num', ranges: [] }] };
  const m = modal({
    title: t ? 'تعديل تحليل' : 'تحليل جديد', wide: true,
    body: html`<div class="form-grid" id="tf"></div><h4 class="subh">${icon('list', 'sm')} البنود <span class="muted">بالترتيب اللي هيطلع في التقرير</span></h4><div id="tp"></div>
      <button class="linkbtn" data-addp style="margin-top:8px">${icon('plus', 'sm')} بند جديد</button><button class="linkbtn" data-addh style="margin-top:8px;margin-inline-start:14px">${icon('plus', 'sm')} عنوان</button><div class="msg" data-f="params" style="color:var(--danger);font-weight:700"></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-go>${icon('check')} احفظ</button>`,
  });
  const drawForm = () => {
    $('#tf', m.el).innerHTML = String(html`
      <div class="field c3" data-f="name"><label>الاسم في التقرير <span class="req">*</span></label><input class="input" name="name" dir="ltr" value="${T.name}"><div class="msg"></div></div>
      <div class="field c1" data-f="code"><label>الكود <span class="req">*</span></label><input class="input num" name="code" dir="ltr" value="${T.code}"><div class="msg"></div></div>
      <div class="field c2"><label>الاسم بالعربي</label><input class="input" name="arName" value="${T.arName || ''}"></div>
      <div class="field c2" data-f="section"><label>القسم</label><select class="select" name="section">${Object.entries(LAB_SECTIONS).map(([k, n]) => html`<option value="${k}" ${T.section === k ? 'selected' : ''}>${n}</option>`)}</select></div>
      <div class="field c1"><label>العينة</label><select class="select" name="sample">${Object.entries(SAMPLE).map(([k, n]) => html`<option value="${k}" ${T.sample === k ? 'selected' : ''}>${n}</option>`)}</select></div>
      <div class="field c1"><label>الأنبوبة</label><input class="input" name="tube" dir="ltr" value="${T.tube || ''}" list="tubes"><datalist id="tubes"><option>EDTA<option>Plain<option>Citrate<option>Fluoride<option>Heparin</datalist></div>
      <div class="field c1" data-f="hours"><label>النتيجة بعد (ساعة)</label><input class="input num" name="hours" value="${T.hours}"><div class="msg"></div></div>
      <div class="field c1" style="justify-content:flex-end;padding-bottom:8px"><label class="swl"><button type="button" class="switch" role="switch" data-sw="external" aria-checked="${T.external ? 'true' : 'false'}"></button><span>معمل خارجي</span></label></div>
      <div class="field c3" data-f="serviceId"><label>الخدمة في الاستقبال</label><select class="select" name="serviceId"><option value="">بالكلمات (تلقائي)</option>${data.services.filter((s) => s.active && (!s.testId || s.testId === t?.id)).map((s) => html`<option value="${s.id}" ${T.serviceId === s.id ? 'selected' : ''}>${s.name}</option>`)}</select><div class="msg"></div></div>
      <div class="field c3"><label>${T.external ? 'اسم المعمل الخارجي' : 'كلمات للربط التلقائي'} <span class="hint">${T.external ? '' : 'مفصولة بـ |'}</span></label>${T.external ? html`<input class="input" name="externalLab" value="${T.externalLab || ''}">` : html`<input class="input" name="keywords" value="${T.keywords || ''}">`}</div>
      ${t ? html`<div class="field c6"><label class="swl"><button type="button" class="switch" role="switch" data-sw="active" aria-checked="${T.active ? 'true' : 'false'}"></button><span>التحليل شغال</span></label></div>` : ''}`);
  };
  const drawParams = () => {
    $('#tp', m.el).innerHTML = String(html`<div class="plist">${T.params.map((p, i) => p.kind === 'header' ? html`<div class="prow hdr" data-p="${i}"><span class="ph">${icon('list', 'sm')}</span><input class="input" data-pf="name" value="${p.name}" placeholder="عنوان (مثلًا Microscopic examination)" dir="ltr">
        <span class="pmv"><button type="button" class="btn ghost icon sm" data-up="${i}">↑</button><button type="button" class="btn ghost icon sm" data-dn="${i}">↓</button><button type="button" class="btn ghost icon sm" data-rm="${i}">${icon('trash', 'sm')}</button></span></div>`
      : html`<div class="prow" data-p="${i}">
        <input class="input" data-pf="name" value="${p.name}" placeholder="اسم البند" dir="ltr" style="flex:2 1 150px">
        <input class="input" data-pf="unit" value="${p.unit || ''}" placeholder="الوحدة" dir="ltr" style="flex:1 1 80px">
        <select class="select" data-pf="kind" style="flex:0 1 100px">${[['num', 'رقم'], ['select', 'اختيار'], ['text', 'نص']].map(([k, n]) => html`<option value="${k}" ${p.kind === k ? 'selected' : ''}>${n}</option>`)}</select>
        ${p.kind === 'num' ? html`<button type="button" class="rangebtn" data-rg="${i}" title="المعدلات">${p.ranges?.length ? rangesText(p.ranges) : 'حدد المعدل الطبيعي'}</button>`
          : p.kind === 'select' ? html`<input class="input" data-pf="options" value="${p.options || ''}" placeholder="الاختيارات: Negative|Positive" dir="ltr" style="flex:2 1 160px"><input class="input" data-pf="normal" value="${p.normal || ''}" placeholder="الطبيعي" dir="ltr" style="flex:1 1 90px">`
          : html`<input class="input" data-pf="refText" value="${p.refText || ''}" placeholder="المعدل كنص (اختياري)" dir="ltr" style="flex:2 1 160px">`}
        <span class="pmv"><button type="button" class="btn ghost icon sm" data-up="${i}">↑</button><button type="button" class="btn ghost icon sm" data-dn="${i}">↓</button><button type="button" class="btn ghost icon sm" data-rm="${i}">${icon('trash', 'sm')}</button></span>
      </div>`)}</div>`);
  };
  drawForm(); drawParams();
  const val = (n) => $(`[name="${n}"]`, m.el)?.value;
  const syncForm = () => {
    Object.assign(T, { name: val('name'), code: val('code'), arName: val('arName'), section: val('section'), sample: val('sample'), tube: val('tube'), hours: val('hours'),
      serviceId: val('serviceId') ? Number(val('serviceId')) : null });
    if (val('keywords') != null) T.keywords = val('keywords');
    if (val('externalLab') != null) T.externalLab = val('externalLab');
  };
  m.el.addEventListener('input', (e) => {
    const pf = e.target.dataset.pf;
    if (pf) { const i = Number(e.target.closest('[data-p]').dataset.p); T.params[i][pf] = e.target.value; }
  });
  m.el.addEventListener('change', (e) => {
    if (e.target.dataset.pf === 'kind') { const i = Number(e.target.closest('[data-p]').dataset.p); T.params[i].kind = e.target.value; drawParams(); }
  });
  m.el.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-sw]');
    if (sw) { syncForm(); T[sw.dataset.sw] = sw.getAttribute('aria-checked') !== 'true'; drawForm(); return; }
    if (e.target.closest('[data-addp]')) { T.params.push({ name: '', unit: '', kind: 'num', ranges: [] }); drawParams(); $$('[data-pf=name]', m.el).at(-1).focus(); return; }
    if (e.target.closest('[data-addh]')) { T.params.push({ name: '', kind: 'header' }); drawParams(); $$('[data-pf=name]', m.el).at(-1).focus(); return; }
    const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-dn]'), rm = e.target.closest('[data-rm]');
    if (up || dn) { const i = Number((up || dn).dataset[up ? 'up' : 'dn']); const j = up ? i - 1 : i + 1; if (j >= 0 && j < T.params.length) { [T.params[i], T.params[j]] = [T.params[j], T.params[i]]; drawParams(); } return; }
    if (rm) { T.params.splice(Number(rm.dataset.rm), 1); drawParams(); return; }
    const rg = e.target.closest('[data-rg]');
    if (rg) { const i = Number(rg.dataset.rg); const r = await editRanges(T.params[i]); if (r) { T.params[i].ranges = r; drawParams(); } return; }
    if (!e.target.closest('[data-go]')) return;
    syncForm();
    $$('.field', m.el).forEach((f) => { f.classList.remove('err'); const x = $('.msg', f); if (x) x.textContent = ''; });
    $('[data-f=params]', m.el).textContent = '';
    try {
      const body = { ...T, active: T.active !== false };
      t ? await api.put('/lab/tests/' + t.id, body) : await api.post('/lab/tests', body);
      m.close(); toast('اتحفظ التحليل'); onSaved();
    } catch (er) {
      if (er instanceof ApiError && er.data.errors) {
        for (const [f, msg] of Object.entries(er.data.errors)) {
          const box = $(`[data-f="${f}"]`, m.el);
          if (box) { box.classList.add('err'); const x = box.classList.contains('msg') ? box : $('.msg', box); if (x) x.textContent = msg; }
          else if (/^p\d+$/.test(f)) { $('[data-f=params]', m.el).textContent = `بند رقم ${Number(f.slice(1)) + 1}: ${msg}`; }
        }
      }
      toastError(er);
    }
  });
}

function editRanges(p) {
  return new Promise((resolve) => {
    let done = false;
    const R = (p.ranges || []).map((r) => ({ ...r }));
    if (!R.length) R.push({ s: '', a0: null, a1: null, lo: null, hi: null });
    const m = modal({
      title: `المعدل الطبيعي: ${p.name || 'بند'}`, wide: true,
      body: html`<p class="muted" style="margin:0 0 10px;font-weight:600;font-size:13px">البرنامج بيختار أنسب سطر للمريض: السن الأول، وبعدين النوع. سيب الخانة فاضية لو مفيش حد (مثلًا «أقل من 200» = الحد الأعلى بس).</p>
        <div id="rr"></div><button class="linkbtn" data-add style="margin-top:8px">${icon('plus', 'sm')} سطر</button>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-go>${icon('check')} تمام</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const draw = () => {
      $('#rr', m.el).innerHTML = String(html`<div class="table-wrap"><table class="table rtbl"><thead><tr><th>النوع</th><th>من سن</th><th>لحد سن</th><th>من</th><th>لحد</th><th></th></tr></thead><tbody>
        ${R.map((r, i) => html`<tr data-r="${i}"><td><select class="select" data-rf="s"><option value="" ${!r.s ? 'selected' : ''}>الكل</option><option value="M" ${r.s === 'M' ? 'selected' : ''}>رجال</option><option value="F" ${r.s === 'F' ? 'selected' : ''}>ستات</option></select></td>
          ${['a0', 'a1', 'lo', 'hi'].map((k) => html`<td><input class="input num" data-rf="${k}" value="${r[k] ?? ''}" inputmode="decimal" placeholder="${k === 'a0' || k === 'a1' ? 'سنة' : ''}"></td>`)}
          <td><button class="btn ghost icon sm" data-del="${i}">${icon('trash', 'sm')}</button></td></tr>`)}</tbody></table></div>`);
    };
    draw();
    m.el.addEventListener('input', (e) => { const k = e.target.dataset.rf; if (k) { const i = Number(e.target.closest('[data-r]').dataset.r); const v = e.target.value.trim(); R[i][k] = k === 's' ? v : v === '' ? null : Number(v.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632)); } });
    m.el.addEventListener('change', (e) => { if (e.target.dataset.rf === 's') m.el.dispatchEvent(new Event('input', { bubbles: true })); });
    m.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) { R.push({ s: '', a0: null, a1: null, lo: null, hi: null }); draw(); return; }
      const d = e.target.closest('[data-del]');
      if (d) { R.splice(Number(d.dataset.del), 1); draw(); return; }
      if (e.target.closest('[data-go]')) {
        $$('[data-rf=s]', m.el).forEach((s) => { R[Number(s.closest('[data-r]').dataset.r)].s = s.value; });
        done = true; m.close(); resolve(R.filter((r) => r.lo != null || r.hi != null));
      }
    });
  });
}

/** كارت التحاليل في ملف المريض */
export async function patientLab(box, patientId) {
  if (!can('lab.read')) return;
  try {
    const { rows } = await api.get(`/lab/patient/${patientId}`);
    if (!rows.length) { box.remove(); return; }
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.gkey)) groups.set(r.gkey, []); groups.get(r.gkey).push(r); }
    box.innerHTML = String(html`<h3>${icon('flask')} التحاليل</h3><div class="pradlist">${[...groups.entries()].slice(0, 6).map(([g, ts]) => html`<a class="pradrow" href="#/labg/${g}">
      <span class="muted" style="font-size:12px;min-width:90px">${fmtWhen(ts[0].requestedAt)}</span><div class="ltests" style="flex:1">${ts.map((t) => html`<span class="ltest st-${t.status}">${t.code || t.service}<i></i></span>`)}</div></a>`)}</div>`);
  } catch { box.remove(); }
}
void raw;
