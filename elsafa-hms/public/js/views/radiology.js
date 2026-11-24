// قسم الأشعة: قايمة الشغل، صفحة الفحص والتقرير بالقوالب، المقطعية برة، التسليم، وإدارة القوالب
import {
  api, html, raw, icon, $, $$, money, fmtTime, fmtWhen, ago, initials, sexName, modal, toast, toastError, askReason, can, debounce, ApiError, state,
  MOD, RAD_ST, printRad,
} from '../core.js';
import { ageText } from '/shared/nid.js';

const GROUPS = [['waiting', 'مستني الفحص', 'hourglass'], ['report', 'مستني التقرير', 'edit'], ['ready', 'جاهز للتسليم', 'check'], ['delivered', 'اتسلّم النهارده', 'user']];
const age = (p) => ageText(p.birthDate, p.ageYears, null) || '';

// ================= قايمة الشغل =================
export async function renderRadiology(view, { query, setTitle }) {
  const tab = query.get('tab') === 'templates' ? 'templates' : 'list';
  setTitle('الأشعة', tab === 'templates' ? 'قوالب تقارير الأشعة' : 'قايمة الشغل: من الدفع لحد تسليم التقرير');
  const S = { group: query.get('group') || 'waiting', mod: query.get('mod') || '', q: '', timer: null };
  view.innerHTML = String(html`<nav class="stabs"><a href="#/radiology" class="stab ${tab === 'list' ? 'on' : ''}">${icon('scan')}<span>قايمة الشغل</span></a>
    <a href="#/radiology?tab=templates" class="stab ${tab === 'templates' ? 'on' : ''}">${icon('file')}<span>القوالب</span></a></nav><div id="rp"></div>`);
  const pane = $('#rp', view);
  if (tab === 'templates') return templatesPane(pane);

  pane.innerHTML = String(html`<div class="rgroups" id="rg"></div>
    <div class="row wrap" style="gap:10px;margin:12px 0">
      <div class="mchips" id="mc"></div>
      <div class="big-search" style="flex:1 1 220px;max-width:360px;margin-inline-start:auto">${icon('search')}<input class="input" id="rq" type="search" placeholder="اسم المريض أو رقم الملف أو الفحص" style="height:42px;font-size:14.5px;padding-inline-start:42px;border-radius:12px"></div>
    </div>
    <div id="rl"><div class="skel" style="height:260px"></div></div>`);
  let data = null;
  const draw = () => {
    const c = data.counts;
    $('#rg', pane).innerHTML = String(html`${GROUPS.map(([k, n, ic]) => html`<button class="rgroup g-${k} ${S.group === k ? 'on' : ''}" data-g="${k}">
      <span class="gi">${icon(ic)}</span><div><small>${n}</small><b class="num">${c[k]}</b></div>${k === 'report' && c.overdue ? html`<span class="badge danger od">${c.overdue} متأخر</span>` : ''}</button>`)}`);
    $('#mc', pane).innerHTML = String(html`<button class="mchip ${!S.mod ? 'on' : ''}" data-m="">الكل</button>${Object.entries(MOD).filter(([k]) => data.byMod[k] || S.mod === k).map(([k, m]) => html`<button class="mchip ${m.cls} ${S.mod === k ? 'on' : ''}" data-m="${k}">${m.name} <b class="num">${data.byMod[k] || 0}</b></button>`)}`);
    const list = data.rows;
    $('#rl', pane).innerHTML = list.length ? String(html`<div class="radgrid">${list.map(card)}</div>`)
      : String(html`<div class="card empty"><div class="art" style="background:var(--radiology-soft);color:var(--radiology)">${icon(S.group === 'waiting' ? 'check' : 'scan')}</div><b>${{ waiting: 'مفيش حد مستني', report: 'مفيش تقارير متأخرة عليك', ready: 'مفيش تقارير مستنية التسليم', delivered: 'لسه ما اتسلّمش حاجة النهارده' }[S.group]}</b></div>`);
  };
  const card = (x) => {
    const m = MOD[x.modality];
    const acts = [];
    if (x.status === 'waiting' && can('rad.work')) acts.push(html`<button class="btn sm" data-a="done" data-k="${x.key}" style="--c:var(--radiology)">${icon('check', 'sm')} اتعمل</button>`);
    if (x.status === 'done' && x.external && can('rad.work')) acts.push(html`<button class="btn soft sm" data-a="sent" data-k="${x.key}" style="--c:var(--py)">${icon('send', 'sm')} اتبعت للدكتور</button>`);
    if (['done', 'sent'].includes(x.status) && (can('rad.report') || can('rad.work')) && x.needsReport) acts.push(html`<a class="btn sm" href="#/rad/${x.key}">${icon(x.external ? 'upload' : 'edit', 'sm')} ${x.external ? 'التقرير رجع' : x.draft ? 'كمّل التقرير' : 'اكتب التقرير'}</a>`);
    if (x.group === 'ready' && can('rad.deliver')) acts.push(html`<button class="btn sm" data-a="deliver" data-k="${x.key}" style="--c:var(--ok)">${icon('user', 'sm')} سلّم</button>`);
    if (x.hasReport || x.hasFile) acts.push(html`<button class="btn ghost icon sm" data-a="print" data-k="${x.key}" title="اطبع التقرير">${icon('print', 'sm')}</button>`);
    if (x.link) acts.push(html`<a class="btn ghost icon sm" href="${x.link}" target="_blank" rel="noopener" title="التقرير على الويب">${icon('link', 'sm')}</a>`);
    return html`<article class="card radcard ${m.cls} ${x.overdue ? 'over' : ''}" data-open="${x.key}">
      <div class="rc-top"><span class="mtag ${m.cls}">${m.name}</span><b class="rc-svc">${x.service}</b>${x.studyNo ? html`<span class="muted num" style="margin-inline-start:auto;font-size:12px">#${x.studyNo}</span>` : ''}</div>
      <div class="rc-pt"><span class="pavatar" style="width:38px;height:38px;border-radius:12px;font-size:13px">${initials(x.patient.name)}</span>
        <div style="min-width:0"><b>${x.patient.name}</b><small>ملف <span class="num">${x.patient.no}</span> · ${sexName(x.patient.sex)}${age(x.patient) ? ' · ' + age(x.patient) : ''}</small></div>
        ${x.bed ? html`<span class="badge" style="margin-inline-start:auto">${icon('bed', 'sm')} <span class="num">${x.bed}</span></span>` : ''}</div>
      <div class="rc-meta">
        ${x.status === 'waiting' ? html`<span>${icon('clock', 'sm')} اتطلب ${ago(x.requestedAt)}</span>` : ''}
        ${x.status === 'done' || x.status === 'sent' ? html`<span class="${x.overdue ? 'od' : ''}">${icon(x.overdue ? 'alert' : 'clock', 'sm')} ${x.overdue ? 'متأخر' : 'متوقع'} ${fmtTime(x.dueAt)}</span>` : ''}
        ${x.status === 'sent' ? html`<span>${icon('send', 'sm')} ${x.sentTo || 'برة'}</span>` : ''}
        ${x.status === 'reported' ? html`<span>${icon('check', 'sm')} ${x.radiologist || ''} · ${fmtTime(x.reportedAt)}</span>` : ''}
        ${x.status === 'delivered' ? html`<span>${icon('user', 'sm')} ${x.deliveredTo} · ${fmtTime(x.deliveredAt)}</span>` : ''}
        ${x.doctor ? html`<span>${icon('steth', 'sm')} ${x.doctor}</span>` : ''}
        ${x.draft ? html`<span class="badge warn" style="height:20px">مسودة</span>` : ''}
      </div>
      ${acts.length ? html`<div class="rc-acts">${acts}</div>` : ''}
    </article>`;
  };
  const load = async () => {
    data = await api.get(`/radiology?group=${S.group}${S.mod ? '&mod=' + S.mod : ''}${S.q ? '&q=' + encodeURIComponent(S.q) : ''}`);
    draw();
  };
  pane.onclick = async (e) => {
    const g = e.target.closest('[data-g]');
    if (g) { S.group = g.dataset.g; return load(); }
    const mc = e.target.closest('[data-m]');
    if (mc) { S.mod = mc.dataset.m; return load(); }
    const a = e.target.closest('[data-a]');
    if (a) { e.stopPropagation(); return quickAct(a.dataset.a, a.dataset.k, data.rows.find((x) => x.key === a.dataset.k), load); }
    if (e.target.closest('a,button')) return;
    const o = e.target.closest('[data-open]');
    if (o) window.go('/rad/' + o.dataset.open);
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'rq') { S.q = e.target.value.trim(); load(); } }, 250);
  await load();
  S.timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 15000);
  return () => { clearInterval(S.timer); pane.onclick = pane.oninput = null; };
}

/** إجراءات سريعة من الكارت أو صفحة الفحص */
async function quickAct(a, key, x, after) {
  try {
    if (a === 'print') return printRad(key);
    if (a === 'done') {
      const m = modal({
        title: `اتعمل: ${x.service}`,
        body: html`<div class="field"><label>بيانات إكلينيكية / سبب الفحص <span class="hint">اختياري، بتطلع في التقرير</span></label><input class="input" name="ci" value="${x.clinicalInfo || ''}" autofocus></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go style="--c:var(--radiology)">${icon('check')} تمام</button>`,
      });
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { await api.post(`/radiology/${key}/done`, { clinicalInfo: $('[name=ci]', m.el).value }); m.close(); toast(`${x.patient.name}: الفحص اتعمل`); after?.(); } catch (er) { toastError(er); }
      });
      m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-go]', m.el).click(); });
      return;
    }
    if (a === 'sent') {
      const m = modal({
        title: 'اتبعت لدكتور الأشعة',
        body: html`<div class="field"><label>لمين؟ <span class="hint">اختياري</span></label><input class="input" name="to" list="radDocs" placeholder="اسم الدكتور أو البرنامج" autofocus><datalist id="radDocs"><option value="برنامج الأشعة على الويب"></datalist></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go style="--c:var(--py)">${icon('send')} اتبعت</button>`,
      });
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { await api.post(`/radiology/${key}/sent`, { to: $('[name=to]', m.el).value }); m.close(); toast('اتسجل إن الفحص اتبعت'); after?.(); } catch (er) { toastError(er); }
      });
      return;
    }
    if (a === 'deliver') {
      const m = modal({
        title: `تسليم: ${x.service}`,
        body: html`<div class="pricehead" style="--ds:var(--ok-soft);--dc:var(--ok)"><span class="dicon">${icon('user')}</span><div><b>${x.patient.name}</b><small>ملف <span class="num">${x.patient.no}</span></small></div></div>
          <div class="field" style="margin-top:12px"><label>استلم مين؟</label><input class="input" name="to" value="${x.patient.name}"></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button>${x.hasReport ? html`<button class="btn ghost" data-pr>${icon('print')} اطبع</button>` : ''}<button class="btn" data-go style="--c:var(--ok)">${icon('check')} اتسلّم</button>`,
      });
      $('[data-pr]', m.el)?.addEventListener('click', () => printRad(key));
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { await api.post(`/radiology/${key}/deliver`, { to: $('[name=to]', m.el).value }); m.close(); toast('اتسجل التسليم'); after?.(); } catch (er) { toastError(er); }
      });
    }
  } catch (er) { toastError(er); }
}

// ================= صفحة الفحص والتقرير =================
export async function renderRadStudy(view, { params, setTitle }) {
  const key = params[0];
  const [{ study: s0 }, { templates }] = await Promise.all([api.get('/radiology/' + key), api.get('/radiology/templates')]);
  let S = s0;
  setTitle(S.service, `${S.patient.name} · ${MOD[S.modality].name}`);
  const tpls = () => templates.filter((t) => t.modality === S.modality);
  let dirty = false;
  const editable = () => can('rad.report') && S.status !== 'waiting' && (S.status !== 'delivered' || can('settings.manage'));

  const steps = () => {
    const list = [['waiting', 'اتطلب', S.requestedAt], ['done', 'اتعمل', S.doneAt]];
    if (S.external) list.push(['sent', 'اتبعت', S.sentAt]);
    if (S.needsReport) list.push(['reported', 'التقرير', S.reportedAt]);
    list.push(['delivered', 'اتسلّم', S.deliveredAt]);
    const order = ['waiting', 'done', 'sent', 'reported', 'delivered'];
    const cur = order.indexOf(S.status);
    return html`<ol class="rsteps">${list.map(([k, n, t]) => { const i = order.indexOf(k); const st = i < cur || (k === S.status && k !== 'waiting') || (k === 'waiting') ? 'on' : i === cur + 1 || (cur === 1 && k === 'reported' && !S.external) ? 'next' : ''; return html`<li class="${st}"><i>${st === 'on' ? icon('check', 'sm') : ''}</i><b>${n}</b><small>${t ? fmtWhen(t) : ''}</small></li>`; })}</ol>`;
  };

  const drawHead = () => {
    const m = MOD[S.modality];
    $('#rhead', view).innerHTML = String(html`
      <div class="rh-main"><span class="pavatar" style="width:52px;height:52px;border-radius:16px">${initials(S.patient.name)}</span>
        <div style="min-width:0"><div class="row wrap" style="gap:8px"><h2 style="margin:0;font-size:20px">${S.patient.name}</h2><a class="badge brand num" href="#/patient/${S.patient.id}">#${S.patient.no}</a></div>
          <div class="muted" style="font-weight:600;font-size:13px">${sexName(S.patient.sex)}${age(S.patient) ? ' · ' + age(S.patient) : ''}${S.patient.phone ? html` · <span class="num">${S.patient.phone}</span>` : ''}${S.bed ? html` · سرير <span class="num">${S.bed}</span>` : ''}${S.doctor ? ` · محوّل من ${S.doctor}` : ''}</div></div>
        <div class="rh-study"><span class="mtag ${m.cls}">${m.name}</span><b>${S.service}</b>${S.studyNo ? html`<small class="num">فحص #${S.studyNo}</small>` : ''}<span class="badge ${RAD_ST[S.status]?.cls || ''}">${RAD_ST[S.status]?.name}</span></div></div>
      ${steps()}
      <div class="rh-acts">
        ${S.status === 'waiting' && can('rad.work') ? html`<button class="btn" data-a="done" style="--c:var(--radiology)">${icon('check')} اتعمل الفحص</button>` : ''}
        ${S.status === 'done' && S.external && can('rad.work') ? html`<button class="btn soft" data-a="sent" style="--c:var(--py)">${icon('send')} اتبعت للدكتور</button>` : ''}
        ${S.group === 'ready' && can('rad.deliver') ? html`<button class="btn" data-a="deliver" style="--c:var(--ok)">${icon('user')} سلّم للمريض</button>` : ''}
        ${S.hasReport || S.hasFile ? html`<button class="btn ghost" data-a="print">${icon('print')} اطبع التقرير</button>` : ''}
        ${S.link ? html`<a class="btn ghost" href="${S.link}" target="_blank" rel="noopener">${icon('link')} التقرير على الويب</a>` : ''}
        ${S.status !== 'waiting' && can('rad.work') ? html`<button class="btn ghost sm" data-a="undo" style="margin-inline-start:auto">${icon('undo', 'sm')} رجوع خطوة</button>` : ''}
      </div>`);
  };

  view.innerHTML = String(html`<section class="card rhead" id="rhead"></section><div id="rwork"></div>`);
  drawHead();

  const drawWork = () => {
    const w = $('#rwork', view);
    if (S.status === 'waiting') {
      w.innerHTML = String(html`<div class="card empty" style="margin-top:14px"><div class="art" style="background:var(--radiology-soft);color:var(--radiology)">${icon('scan')}</div><b>الفحص لسه ما اتعملش</b>${can('rad.work') ? 'لما يخلص دوس «اتعمل الفحص»، وبعدها تكتب التقرير' : ''}</div>`);
      return;
    }
    const ed = editable();
    w.innerHTML = String(html`<div class="rwgrid">
      <section class="card reditor">
        <div class="re-head"><h3 style="margin:0">${icon('file')} التقرير</h3>
          ${S.draft ? html`<span class="badge warn">مسودة</span>` : S.status === 'reported' || S.status === 'delivered' ? html`<span class="badge ok">${icon('check', 'sm')} معتمد · ${S.radiologist || ''}</span>` : ''}
          <span class="spacer"></span><span class="muted" id="saved" style="font-size:12px;font-weight:700"></span></div>
        ${ed ? html`<div class="re-tools" role="toolbar">
          <button type="button" data-cmd="bold" title="عريض"><b>B</b></button><button type="button" data-cmd="italic" title="مايل"><i>I</i></button><button type="button" data-cmd="underline" title="تحته خط"><u>U</u></button>
          <span class="sep"></span><button type="button" data-cmd="insertUnorderedList" title="نقط">${icon('list', 'sm')}</button><button type="button" data-cmd="insertOrderedList" title="أرقام"><span class="num">1.</span></button>
          <button type="button" data-cmd="formatBlock" data-v="h4" title="عنوان">H</button><button type="button" data-cmd="formatBlock" data-v="p" title="فقرة">¶</button>
          <span class="sep"></span><button type="button" data-imp title="IMPRESSION">IMP</button>
          <span class="spacer"></span><button type="button" data-dir title="اتجاه الكتابة">⇆</button></div>` : ''}
        <input class="input re-title" name="title" dir="ltr" placeholder="عنوان الفحص (ULTRASOUND ABDOMEN & PELVIS)" value="${S.reportTitle || ''}" ${ed ? '' : 'disabled'}>
        <div class="re-body" id="body" dir="ltr" contenteditable="${ed ? 'true' : 'false'}" spellcheck="true" data-ph="اختار قالب من الجنب أو اكتب التقرير هنا...">${S.reportHtml ? raw(S.reportHtml) : ''}</div>
        ${ed ? html`<div class="re-foot">
          <div class="field" data-f="radiologist" style="flex:1 1 220px"><label>دكتور الأشعة</label><input class="input" name="rad" value="${S.radiologist || (state.me.role === 'radiology' ? state.me.name : '')}"><div class="msg"></div></div>
          <div class="row" style="gap:8px;align-self:flex-end"><button class="btn ghost" data-save>${icon('check')} احفظ مسودة <span class="kb">Ctrl+S</span></button>
            <button class="btn" data-final style="--c:var(--ok)">${icon('check')} ${['reported', 'delivered'].includes(S.status) ? 'احفظ التعديل' : 'اعتمد التقرير'}</button></div></div>` : ''}
      </section>
      <aside class="rside">
        ${ed && tpls().length ? html`<section class="card pad"><h3>${icon('sparkle')} القوالب</h3><div class="tpllist">${tpls().map((t) => html`<button class="tplbtn" data-tpl="${t.id}"><b>${t.name}</b><small dir="ltr">${t.title || ''}</small></button>`)}</div>
          <a class="linkbtn" href="#/radiology?tab=templates" style="margin-top:8px;display:inline-flex">${icon('edit', 'sm')} القوالب</a></section>` : ''}
        ${S.external || S.hasFile || S.link ? html`<section class="card pad"><h3>${icon('upload')} تقرير من برة</h3>
          ${S.hasFile ? html`<a class="filecard" href="/api/radiology/${key}/file" target="_blank" rel="noopener">${icon('file')}<div><b>ملف التقرير</b><small>${S.fileType === 'application/pdf' ? 'PDF' : 'صورة'} · دوس للفتح</small></div></a>` : ''}
          ${can('rad.work') ? html`<label class="filepick" style="margin-top:8px">${icon('upload')}<span>${S.hasFile ? 'غيّر الملف' : 'ارفع ملف التقرير (PDF أو صورة)'}</span><input type="file" id="rfile" accept="application/pdf,image/*" hidden></label>
          <div class="field" data-f="link" style="margin-top:10px"><label>أو لينك التقرير على الويب</label><div class="row" style="gap:6px"><input class="input" name="link" dir="ltr" value="${S.link || ''}" placeholder="https://..."><button class="btn ghost sm" data-link>${icon('check', 'sm')}</button></div><div class="msg"></div></div>` : ''}
        </section>` : ''}
        <section class="card pad rinfo"><h3>${icon('info')} البيانات</h3>
          ${S.clinicalInfo ? html`<div><small>بيانات إكلينيكية</small><b>${S.clinicalInfo}</b></div>` : ''}
          <div><small>اتعمل</small><b>${S.doneAt ? fmtWhen(S.doneAt) : '—'}${S.doneBy ? ' · ' + S.doneBy : ''}</b></div>
          ${S.dueAt && !['reported', 'delivered'].includes(S.status) ? html`<div><small>التقرير متوقع</small><b class="${S.overdue ? 'od' : ''}">${fmtWhen(S.dueAt)}</b></div>` : ''}
          ${S.sentAt ? html`<div><small>اتبعت</small><b>${fmtWhen(S.sentAt)}${S.sentTo ? ' · ' + S.sentTo : ''}</b></div>` : ''}
          ${S.reportedAt ? html`<div><small>اتعتمد</small><b>${fmtWhen(S.reportedAt)} · ${S.reportedBy || ''}</b></div>` : ''}
          ${S.deliveredAt ? html`<div><small>اتسلّم</small><b>${fmtWhen(S.deliveredAt)} · ${S.deliveredTo}</b></div>` : ''}
          ${S.visitId ? html`<a class="linkbtn" href="#/visit/${S.visitId}">زيارة <span class="num">${S.visitNo}</span> ←</a>` : S.admissionId ? html`<a class="linkbtn" href="#/admission/${S.admissionId}">دخول <span class="num">${S.admissionNo}</span> ←</a>` : ''}
        </section>
      </aside></div>`);
  };
  drawWork();

  const refresh = (st) => { S = st; dirty = false; drawHead(); drawWork(); setTitle(S.service, `${S.patient.name} · ${MOD[S.modality].name}`); };
  const save = async (final) => {
    const body = $('#body', view);
    const b = { html: body?.innerHTML || '', title: $('[name=title]', view)?.value, radiologist: $('[name=rad]', view)?.value, final };
    $$('.field', view).forEach((f) => f.classList.remove('err'));
    try {
      const r = await api.post(`/radiology/${key}/report`, b);
      refresh(r.study);
      toast(final ? 'التقرير اتعتمد' : 'اتحفظت المسودة');
      if (final && localStorage.getItem('autoPrint') !== '0') printRad(key);
    } catch (er) {
      if (er instanceof ApiError && er.data.errors?.radiologist) { const f = $('[data-f=radiologist]', view); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.radiologist; }
      toastError(er);
    }
  };
  view.onclick = async (e) => {
    const t = e.target;
    const tb = t.closest('[data-cmd]');
    if (tb) { e.preventDefault(); $('#body', view).focus(); document.execCommand(tb.dataset.cmd, false, tb.dataset.v ? `<${tb.dataset.v}>` : null); dirty = true; return; }
    if (t.closest('[data-imp]')) { $('#body', view).focus(); document.execCommand('insertHTML', false, '<p><b>IMPRESSION:</b></p><ul><li>…</li></ul>'); dirty = true; return; }
    if (t.closest('[data-dir]')) { const b = $('#body', view); const sel = window.getSelection(); const blk = sel?.anchorNode?.parentElement?.closest('#body > *'); const tgt = blk || b; tgt.dir = tgt.dir === 'rtl' ? 'ltr' : 'rtl'; dirty = true; return; }
    const tp = t.closest('[data-tpl]');
    if (tp) {
      const tpl = templates.find((x) => x.id === Number(tp.dataset.tpl));
      const b = $('#body', view);
      if (b.textContent.trim() && !confirm('هيتشال المكتوب ويتحط القالب مكانه. تكمّل؟')) return;
      b.innerHTML = tpl.body; if (tpl.title) $('[name=title]', view).value = tpl.title; dirty = true; b.focus();
      return;
    }
    if (t.closest('[data-save]')) return save(false);
    if (t.closest('[data-final]')) return save(true);
    if (t.closest('[data-link]')) {
      const link = $('[name=link]', view).value.trim();
      try { const r = await api.post(`/radiology/${key}/link`, { link, final: !!link, radiologist: $('[name=rad]', view)?.value }); refresh(r.study); toast(link ? 'اتسجل لينك التقرير' : 'اتشال اللينك'); } catch (er) { toastError(er); }
      return;
    }
    const a = t.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'undo') {
      const reason = await askReason({ title: 'رجوع خطوة', label: 'السبب', confirm: 'رجّع', note: `الحالة هترجع من «${RAD_ST[S.status].name}»` });
      if (!reason) return;
      try { refresh((await api.post(`/radiology/${key}/undo`, { reason })).study); toast('رجعت خطوة', 'info'); } catch (er) { toastError(er); }
      return;
    }
    quickAct(a, key, S, async () => refresh((await api.get('/radiology/' + key)).study));
  };
  view.onchange = async (e) => {
    if (e.target.id !== 'rfile' || !e.target.files[0]) return;
    const f = e.target.files[0];
    if (f.size > 20 * 1024 * 1024) return toast('الملف أكبر من 20 ميجا', 'err');
    try {
      const rad = $('[name=rad]', view)?.value || '';
      const r = await fetch(`/api/radiology/${key}/file?final=1&radiologist=${encodeURIComponent(rad)}`, { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream' }, credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new ApiError(r.status, j);
      refresh(j.study); toast('اترفع التقرير');
    } catch (er) { toastError(er); }
  };
  view.oninput = (e) => { if (e.target.id === 'body' || e.target.name === 'title') { dirty = true; $('#saved', view) && ($('#saved', view).textContent = 'فيه تعديل ما اتحفظش'); } };
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && $('#body', view)?.isContentEditable) { e.preventDefault(); save(false); } };
  document.addEventListener('keydown', onKey);
  const auto = setInterval(() => { if (dirty && $('#body', view)?.isContentEditable && !['reported', 'delivered'].includes(S.status)) save(false); }, 60000);
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => { document.removeEventListener('keydown', onKey); clearInterval(auto); window.removeEventListener('beforeunload', beforeUnload); view.onclick = view.onchange = view.oninput = null; };
}

// ================= القوالب =================
async function templatesPane(pane) {
  const load = async () => {
    const r = await api.get('/radiology/templates?all=1');
    const by = {};
    for (const t of r.templates) (by[t.modality] ||= []).push(t);
    pane.innerHTML = String(html`<div class="pagehead"><span class="muted" style="font-weight:700">${r.templates.length} قالب · الدكتور بيختار القالب ويعدّل عليه في التقرير</span><span class="spacer"></span>
        ${can('rad.templates') ? html`<button class="btn" data-new>${icon('plus')} قالب جديد</button>` : ''}</div>
      ${Object.entries(MOD).filter(([k]) => by[k]).map(([k, m]) => html`<section class="card pad" style="margin-bottom:12px"><h3><span class="mtag ${m.cls}">${m.name}</span></h3>
        <div class="tplgrid">${by[k].map((t) => html`<button class="tplcard ${t.active ? '' : 'off'}" data-edit="${t.id}"><b>${t.name}</b><small dir="ltr">${t.title || ''}</small>
          <div class="tplprev" dir="ltr">${raw(t.body)}</div>${t.active ? '' : html`<span class="badge">موقوف</span>`}</button>`)}</div></section>`)}`);
    pane.onclick = (e) => {
      if (e.target.closest('[data-new]')) return editTpl(null, load);
      const ed = e.target.closest('[data-edit]');
      if (ed && can('rad.templates')) editTpl(r.templates.find((x) => x.id === Number(ed.dataset.edit)), load);
    };
  };
  await load();
  return () => { pane.onclick = null; };
}

function editTpl(t, onSaved) {
  const v = t || { name: '', modality: 'us', title: '', body: '', active: true };
  const m = modal({
    title: t ? 'تعديل قالب' : 'قالب جديد', wide: true,
    body: html`<div class="form-grid">
      <div class="field c3" data-f="name"><label>اسم القالب <span class="req">*</span></label><input class="input" name="name" value="${v.name}" autofocus><div class="msg"></div></div>
      <div class="field c3" data-f="modality"><label>النوع</label><div class="seg full" data-seg="mod">${Object.entries(MOD).filter(([k]) => k !== 'other').map(([k, x]) => html`<button type="button" data-v="${k}" class="${v.modality === k ? 'on' : ''}">${x.name}</button>`)}</div></div>
      <div class="field c6"><label>عنوان الفحص في التقرير</label><input class="input" name="title" dir="ltr" value="${v.title || ''}"></div>
      <div class="field c6" data-f="body"><label>نص القالب</label><div class="re-tools" role="toolbar"><button type="button" data-cmd="bold"><b>B</b></button><button type="button" data-cmd="italic"><i>I</i></button><button type="button" data-cmd="underline"><u>U</u></button><span class="sep"></span><button type="button" data-cmd="insertUnorderedList">${icon('list', 'sm')}</button><button type="button" data-cmd="insertOrderedList">1.</button></div>
        <div class="re-body small" id="tb" dir="ltr" contenteditable="true">${raw(v.body)}</div><div class="msg"></div></div>
      ${t ? html`<div class="field c6"><label class="swl"><button type="button" class="switch" role="switch" data-act aria-checked="${v.active ? 'true' : 'false'}"></button><span>القالب شغال</span></label></div>` : ''}
    </div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-go>${icon('check')} احفظ</button>`,
  });
  m.el.addEventListener('click', async (e) => {
    const sg = e.target.closest('[data-seg] button');
    if (sg) { $$('[data-seg] button', m.el).forEach((b) => b.classList.toggle('on', b === sg)); return; }
    const tb = e.target.closest('[data-cmd]');
    if (tb) { e.preventDefault(); $('#tb', m.el).focus(); document.execCommand(tb.dataset.cmd); return; }
    const sw = e.target.closest('[data-act]');
    if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    if (!e.target.closest('[data-go]')) return;
    const body = { name: $('[name=name]', m.el).value, modality: $('[data-seg] button.on', m.el)?.dataset.v, title: $('[name=title]', m.el).value, body: $('#tb', m.el).innerHTML,
      active: t ? $('[data-act]', m.el).getAttribute('aria-checked') === 'true' : true, sort: v.sort };
    $$('.field', m.el).forEach((f) => { f.classList.remove('err'); const x = $('.msg', f); if (x) x.textContent = ''; });
    try { t ? await api.put('/radiology/templates/' + t.id, body) : await api.post('/radiology/templates', body); m.close(); toast('اتحفظ القالب'); onSaved(); }
    catch (er) {
      if (er instanceof ApiError && er.data.errors) for (const [f, msg] of Object.entries(er.data.errors)) { const x = $(`[data-f="${f}"]`, m.el); if (x) { x.classList.add('err'); $('.msg', x).textContent = msg; } }
      toastError(er);
    }
  });
}

/** كارت الأشعة في ملف المريض */
export async function patientRadiology(box, patientId) {
  if (!can('rad.read')) return;
  try {
    const { rows } = await api.get(`/radiology/patient/${patientId}`);
    if (!rows.length) { box.remove(); return; }
    box.innerHTML = String(html`<h3>${icon('scan')} الأشعة</h3><div class="pradlist">${rows.slice(0, 8).map((x) => html`<a class="pradrow" href="#/rad/${x.key}">
      <span class="mtag ${MOD[x.modality].cls}">${MOD[x.modality].name}</span><b>${x.service}</b><span class="muted" style="font-size:12px">${fmtWhen(x.requestedAt)}</span>
      <span class="badge ${RAD_ST[x.status]?.cls || ''}" style="margin-inline-start:auto">${RAD_ST[x.status]?.name}</span></a>`)}</div>`);
  } catch { box.remove(); }
}
void money;
