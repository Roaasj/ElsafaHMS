// الإعدادات (للمدير): الخدمات والأسعار، الأطباء ونسبهم، المستخدمين، سجل التعديلات
import { firstDept, deptIs, KIND_ICON, refreshLookups, soft,
  applyBrand, api, html, icon, el, $, $$, money, egp, fmtWhen, initials, DEPT, SVC_KEYS, KIND, modal, toast, toastError,
  debounce, ApiError, fmtSlot, state, ago, nightsText,
} from '../core.js';
import { searchKey } from '/shared/text.js';

const TABS = [
  ['general', 'إعدادات عامة', 'settings'],
  ['lookups', 'الأقسام والقوائم', 'layers'],
  ['services', 'الخدمات والأسعار', 'tag'],
  ['clinics', 'العيادات', 'door'],
  ['doctors', 'الأطباء والنسب', 'steth'],
  ['rooms', 'الغرف والأسرّة', 'bed'],
  ['floorprices', 'أسعار الأدوار', 'layers'],
  ['users', 'المستخدمين', 'users'],
  ['roles', 'الأدوار والصلاحيات', 'shield'],
  ['audit', 'سجل التعديلات', 'history'],
];
const DAYS = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];

export async function renderSettings(view, { query, setTitle }) {
  const tab = TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'services';
  setTitle('الإعدادات', TABS.find((t) => t[0] === tab)[1]);
  view.innerHTML = String(html`
    <nav class="stabs" role="tablist">${TABS.map(([k, n, ic]) => html`<a href="#/settings?tab=${k}" class="stab ${k === tab ? 'on' : ''}" role="tab">${icon(ic)}<span>${n}</span></a>`)}</nav>
    <div id="pane"></div>`);
  const pane = $('#pane', view);
  const fn = { general: generalPane, lookups: lookupsPane, services: servicesPane, doctors: doctorsPane, rooms: roomsPane, floorprices: floorPricesPane, users: usersPane, roles: rolesPane, clinics: clinicsPane, audit: auditPane }[tab];
  return fn(pane);
}

/** حقول الفورم: يعرض أخطاء السيرفر على الحقول */
function showErrors(root, e) {
  $$('.field', root).forEach((f) => { f.classList.remove('err'); const m = $('.msg', f); if (m) m.textContent = ''; });
  if (e instanceof ApiError && e.data.errors) {
    let first = null;
    for (const [f, msg] of Object.entries(e.data.errors)) {
      const box = $(`[data-f="${f}"]`, root);
      if (!box) { toast(msg, 'err'); continue; }
      box.classList.add('err');
      const m = $('.msg', box); if (m) m.textContent = msg;
      first ||= box;
    }
    $('input,select', first)?.focus();
    if (!first) toastError(e);
  } else toastError(e);
}
const sw = (name, on, label) => html`<label class="swl"><button type="button" class="switch" role="switch" data-sw="${name}" aria-checked="${on ? 'true' : 'false'}"></button><span>${label}</span></label>`;
function bindSwitches(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sw]');
    if (b) b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
}
const swVal = (root, name) => $(`[data-sw="${name}"]`, root)?.getAttribute('aria-checked') === 'true';
const segVal = (root, name) => $(`[data-seg="${name}"] button.on`, root)?.dataset.v;
function bindSegs(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg] button');
    if (!b) return;
    $$('button', b.parentElement).forEach((x) => x.classList.toggle('on', x === b));
    b.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// ======================================================================
//                            الخدمات والأسعار
// ======================================================================
async function servicesPane(pane) {
  const S = { list: [], q: '', dept: 'all', inactive: false };
  pane.innerHTML = String(html`
    <div class="card pad grid" style="gap:14px">
      <div class="row wrap" style="gap:10px">
        <div class="big-search" style="flex:1 1 260px">${icon('search')}<input class="input" id="sq" type="search" placeholder="دوّر بالاسم أو الكود" style="height:44px;font-size:15px;padding-inline-start:44px;border-radius:13px" autocomplete="off"></div>
        <button class="btn ghost" id="exp">${icon('download')} تصدير إكسل</button>
        <button class="btn soft" id="imp" style="--c:var(--ok)">${icon('upload')} استيراد من إكسل</button>
        <button class="btn" id="add">${icon('plus')} خدمة جديدة</button>
      </div>
      <div class="row wrap" style="gap:8px">
        <div class="dtabs" id="dflt"></div>
        <span class="spacer"></span>
        ${sw('inactive', false, 'اعرض الخدمات المتوقفة')}
      </div>
    </div>
    <div id="slist" style="margin-top:16px"><div class="skel" style="height:320px"></div></div>`);
  const draw = () => {
    const c = (d) => S.list.filter((s) => (S.inactive || s.active) && (d === 'all' || s.dept === d)).length;
    $('#dflt', pane).innerHTML = String(html`<button class="dtab ${S.dept === 'all' ? 'on' : ''}" data-d="all" style="--dc:var(--ink)">الكل <span class="n num">${c('all')}</span></button>
      ${SVC_KEYS.map((k) => html`<button class="dtab d-${k} ${S.dept === k ? 'on' : ''}" data-d="${k}">${icon(DEPT[k].icon, 'sm')} ${DEPT[k].name} <span class="n num">${c(k)}</span></button>`)}`);
    const eb = $('#exp', pane); if (eb) eb.innerHTML = String(html`${icon('download')} ${S.dept === 'all' ? 'تصدير إكسل (كل الأقسام)' : 'تصدير إكسل (' + DEPT[S.dept].name + ')'}`);
    const q = searchKey(S.q);
    const list = S.list.filter((s) => (S.inactive || s.active) && (S.dept === 'all' || s.dept === S.dept) && (!q || searchKey(s.name).includes(q) || s.code.toLowerCase().includes(q)));
    $('#slist', pane).innerHTML = list.length ? String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>الكود</th><th>الخدمة</th><th>القسم</th><th>السعر</th><th class="hide-sm">الدفع</th><th class="hide-sm">دكتور</th><th class="hide-sm">زرار سريع</th><th>فعالة</th><th></th></tr></thead>
      <tbody>${list.map((s) => html`<tr class="${s.active ? '' : 'off-row'}">
        <td><span class="code num">${s.code}</span></td>
        <td><b>${s.name}</b>${s.includedNights ? html` <span class="badge ok">باكدج ${nightsText(s.includedNights)}</span>` : ''}${s.used ? html`<div class="muted" style="font-size:12px">اتطلبت <span class="num">${s.used}</span> مرة</div>` : ''}</td>
        <td><span class="dtag d-${s.dept}">${icon(DEPT[s.dept].icon)} ${DEPT[s.dept].short}</span></td>
        <td class="nw"><button class="pricebtn" data-price="${s.id}" title="غيّر السعر"><b>${egp(s.price)}</b>${icon('edit', 'sm')}</button>
          ${s.priceSince ? html`<div class="muted" style="font-size:11.5px">من ${ago(s.priceSince)}</div>` : ''}</td>
        <td class="hide-sm"><span class="badge ${s.payTiming === 'after' ? 'warn' : ''}">${s.payTiming === 'before' ? 'قبل' : 'بعد'}</span></td>
        <td class="hide-sm">${s.hasDoctor ? html`<span class="badge ok">${icon('steth', 'sm')} نعم</span>` : html`<span class="muted">—</span>`}</td>
        <td class="hide-sm"><button type="button" class="switch sm" role="switch" aria-checked="${s.quick ? 'true' : 'false'}" data-toggle="quick" data-id="${s.id}" aria-label="زرار سريع"></button></td>
        <td><button type="button" class="switch sm" role="switch" aria-checked="${s.active ? 'true' : 'false'}" data-toggle="active" data-id="${s.id}" aria-label="فعالة"></button></td>
        <td class="n"><button class="btn ghost icon sm" data-edit="${s.id}" title="تعديل">${icon('edit', 'sm')}</button></td>
      </tr>`)}</tbody></table></div></div>`)
      : String(html`<div class="card empty"><div class="art">${icon('tag')}</div><b>مفيش خدمات هنا</b>${S.q ? 'جرّب كلمة تانية' : 'ضيف خدمة جديدة أو استورد من إكسل'}</div>`);
  };
  const load = async () => { S.list = (await api.get('/admin/services')).services; draw(); };
  $('#sq', pane).addEventListener('input', debounce((e) => { S.q = e.target.value; draw(); }, 120));
  pane.onclick = async (e) => {
    const t = e.target;
    const d = t.closest('[data-d]');
    if (d) { S.dept = d.dataset.d; draw(); return; }
    const s = t.closest('[data-sw="inactive"]');
    if (s) { const on = s.getAttribute('aria-checked') !== 'true'; s.setAttribute('aria-checked', on); S.inactive = on; draw(); return; }
    const tg = t.closest('[data-toggle]');
    if (tg) {
      const id = Number(tg.dataset.id), f = tg.dataset.toggle, on = tg.getAttribute('aria-checked') !== 'true';
      tg.setAttribute('aria-checked', on);
      try {
        const r = await api.put('/admin/services/' + id, { [f]: on });
        S.list = S.list.map((x) => (x.id === id ? r.service : x));
        toast(f === 'active' ? (on ? `«${r.service.name}» رجعت تظهر في الاستقبال` : `«${r.service.name}» اتوقفت ومش هتظهر في الاستقبال`) : (on ? 'هتظهر في الأول كزرار سريع' : 'اتشالت من الأزرار السريعة'));
        draw();
      } catch (er) { tg.setAttribute('aria-checked', !on); toastError(er); }
      return;
    }
    const pr = t.closest('[data-price]');
    if (pr) return priceModal(S.list.find((x) => x.id === Number(pr.dataset.price)), load);
    const ed = t.closest('[data-edit]');
    if (ed) return serviceModal(S.list.find((x) => x.id === Number(ed.dataset.edit)), load);
    if (t.closest('#add')) return serviceModal(null, load, S.dept !== 'all' ? S.dept : firstDept('clinic'));
    if (t.closest('#exp')) { location.href = '/api/admin/services/export' + (S.dept !== 'all' ? '?dept=' + encodeURIComponent(S.dept) : ''); return; }
    if (t.closest('#imp')) return importModal(load);
  };
  await load();
  return () => { pane.onclick = null; };
}

// نصيب الدكتور: بدون / نسبة % / مبلغ ثابت للوحدة
const shareField = (v, hint) => html`<div class="field c6" data-f="shareFixed"><label>نصيب الدكتور <span class="hint">${hint}</span></label>
  <div class="row" style="gap:8px"><div class="seg" data-seg="sharemode" style="flex:0 0 auto"><button type="button" data-v="" class="${!v.sharePct && !v.shareFixed ? 'on' : ''}">بدون</button><button type="button" data-v="pct" class="${v.sharePct ? 'on' : ''}">نسبة %</button><button type="button" data-v="fixed" class="${v.shareFixed ? 'on' : ''}">مبلغ ثابت</button></div>
  <input class="input num ${!v.sharePct && !v.shareFixed ? 'hide' : ''}" name="shareval" inputmode="decimal" value="${v.sharePct || v.shareFixed || ''}" style="max-width:120px"></div><div class="msg"></div></div>`;
const bindShare = (root) => {
  const sync = () => $('[name=shareval]', root).classList.toggle('hide', !segVal(root, 'sharemode'));
  $('[data-seg="sharemode"]', root).addEventListener('change', sync);
};
const shareBody = (root) => {
  const k = segVal(root, 'sharemode'), x = $('[name=shareval]', root).value;
  return { sharePct: k === 'pct' ? x : '', shareFixed: k === 'fixed' ? x : '' };
};
function serviceModal(s, onSaved, defDept = firstDept('clinic')) {
  const edit = !!s;
  const v = s || { dept: defDept, payTiming: DEPT[defDept]?.pay || 'before', active: true };
  const m = modal({
    title: edit ? 'تعديل خدمة' : 'خدمة جديدة', wide: true,
    body: html`<div class="form-grid">
      <div class="field c4" data-f="name"><label>اسم الخدمة <span class="req">*</span></label><input class="input" name="name" value="${v.name || ''}" autofocus><div class="msg"></div></div>
      <div class="field c2" data-f="code"><label>الكود <span class="hint">${edit ? '' : 'فاضي = تلقائي'}</span></label><input class="input num" name="code" value="${v.code || ''}" placeholder="${edit ? '' : 'تلقائي'}"><div class="msg"></div></div>
      <div class="field c6" data-f="dept"><label>القسم <span class="req">*</span></label>
        <div class="deptpick" data-seg="dept">${SVC_KEYS.map((k) => html`<button type="button" class="d-${k} ${v.dept === k ? 'on' : ''}" data-v="${k}">${icon(DEPT[k].icon)}${DEPT[k].name}</button>`)}</div><div class="msg"></div></div>
      ${edit ? html`<div class="field c2"><label>السعر الحالي</label><div class="input" style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-2)"><b>${egp(v.price)}</b><button type="button" class="linkbtn" data-chprice>غيّره</button></div></div>`
        : html`<div class="field c2" data-f="price"><label>السعر <span class="req">*</span></label><input class="input num" name="price" inputmode="decimal" placeholder="0"><div class="msg"></div></div>`}
      <div class="field c2" data-f="payTiming"><label>المريض يدفع امتى؟</label>
        <div class="seg full" data-seg="pay"><button type="button" data-v="before" class="${v.payTiming === 'before' ? 'on' : ''}">قبل الخدمة</button><button type="button" data-v="after" class="${v.payTiming === 'after' ? 'on' : ''}">بعد الخدمة</button></div><div class="msg"></div></div>
      <div class="field c2" style="justify-content:flex-end;gap:10px;padding-bottom:4px">
        ${sw('hasDoctor', v.hasDoctor, 'ليها دكتور (كشف، سونار...)')}
        ${sw('quick', v.quick, 'تظهر كزرار سريع في الأول')}
      </div>
      <div class="field c4 ${deptIs(v.dept, 'radiology') ? '' : 'hide'}" id="modf"><label>نوع الأشعة <span class="hint">بيحدد قايمة الشغل والقوالب</span></label>
        <div class="seg full" data-seg="mod">${[['', 'تلقائي'], ['us', 'سونار'], ['xray', 'عادية'], ['ct', 'مقطعية'], ['mri', 'رنين'], ['mammo', 'ماموجرام']].map(([k, n]) => html`<button type="button" data-v="${k}" class="${(v.modality || '') === k ? 'on' : ''}">${n}</button>`)}</div></div>
      <div class="field c2 ${deptIs(v.dept, 'or') ? '' : 'hide'}" data-f="includedNights" id="pkgf"><label>باكدج؟ ليالي إقامة شاملة <span class="hint">فاضي = مش باكدج</span></label><input class="input num" name="includedNights" inputmode="numeric" value="${v.includedNights ?? ''}" placeholder="مثلًا 2"><div class="msg"></div></div>
      <div class="field c4 ${deptIs(v.dept, 'ward', 'or') ? '' : 'hide'}" id="tcatf"><label>مكانها في التذكرة والفاتورة</label>
        <div class="seg full" data-seg="tcat">${[['', 'خدمات'], ['visit', 'زيارات'], ['fee', 'أتعاب أطباء']].map(([k, n]) => html`<button type="button" data-v="${k}" class="${(v.ticketCat || '') === k ? 'on' : ''}">${n}</button>`)}</div></div>
      <div class="field c2 ${deptIs(v.dept, 'ward', 'or') ? '' : 'hide'}" id="openf" style="justify-content:flex-end;padding-bottom:4px">${sw('openPrice', v.openPrice, 'سعر مفتوح (الحسابات تكتب المبلغ)')}</div>
      ${shareField(v, 'بتنطبق على كل الأطباء (استثناء دكتور بعينه من شاشة الأطباء)')}
      ${edit ? html`<div class="field c4">${sw('active', v.active, 'فعالة (بتظهر في الاستقبال)')}</div>` : ''}
    </div>
    <div class="alertbar info" style="margin-top:14px">${icon('info')}<span>«قبل» يعني مفيش خدمة من غير إيصال. «بعد» يعني الخدمة بتتضاف والمريض يدفع قبل ما يمشي.</span></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('check')} ${edit ? 'احفظ' : 'ضيف الخدمة'}</button>`,
  });
  bindSwitches(m.el); bindSegs(m.el); bindShare(m.el);
  $('[data-seg="dept"]', m.el).addEventListener('change', () => {
    $('#pkgf', m.el).classList.toggle('hide', !deptIs(segVal(m.el, 'dept'), 'or'));
    $('#modf', m.el).classList.toggle('hide', !deptIs(segVal(m.el, 'dept'), 'radiology'));
    $('#tcatf', m.el).classList.toggle('hide', !deptIs(segVal(m.el, 'dept'), 'ward', 'or'));
    $('#openf', m.el).classList.toggle('hide', !deptIs(segVal(m.el, 'dept'), 'ward', 'or'));
    if (!edit) { const d = segVal(m.el, 'dept'); $$('[data-seg="pay"] button', m.el).forEach((b) => b.classList.toggle('on', b.dataset.v === (DEPT[d]?.pay || 'before'))); }
  });
  $('[data-chprice]', m.el)?.addEventListener('click', () => { m.close(); priceModal(s, onSaved); });
  const save = async () => {
    const body = {
      name: $('[name=name]', m.el).value, code: $('[name=code]', m.el).value, dept: segVal(m.el, 'dept'), payTiming: segVal(m.el, 'pay'),
      hasDoctor: swVal(m.el, 'hasDoctor'), quick: swVal(m.el, 'quick'), active: edit ? swVal(m.el, 'active') : true,
      includedNights: $('[name=includedNights]', m.el).value, modality: segVal(m.el, 'mod') || null,
      ticketCat: segVal(m.el, 'tcat') || null, openPrice: swVal(m.el, 'openPrice'),
    };
    if (!edit) body.price = $('[name=price]', m.el).value;
    try {
      const r = edit ? await api.put('/admin/services/' + s.id, body) : await api.post('/admin/services', body);
      const sh = shareBody(m.el);
      if (sh.sharePct !== (v.sharePct ?? '') + '' || sh.shareFixed !== (v.shareFixed ?? '') + '' || (!edit && (sh.sharePct || sh.shareFixed))) await api.put('/admin/services/' + r.service.id + '/share', sh);
      m.close();
      toast(edit ? 'اتحفظت الخدمة' : `اتضافت «${r.service.name}» بكود ${r.service.code}`);
      onSaved();
    } catch (e) { showErrors(m.el, e); }
  };
  $('[data-save]', m.el).addEventListener('click', save);
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
}

async function priceModal(s, onSaved) {
  const m = modal({
    title: 'تغيير السعر',
    body: html`<div class="pricehead d-${s.dept}"><span class="dicon">${icon(DEPT[s.dept].icon)}</span><div><b>${s.name}</b><small class="num">${s.code}</small></div>
        <div class="cur"><small>السعر الحالي</small><b>${egp(s.price)}</b></div></div>
      <div class="field" data-f="price" style="margin-top:14px"><label>السعر الجديد</label>
        <div class="row" style="gap:8px"><input class="input num" name="price" inputmode="decimal" value="${s.price}" autofocus style="font-size:20px;height:52px;font-weight:800">
        ${[5, 10, 15].map((p) => html`<button type="button" class="btn soft sm" data-up="${p}" style="--c:var(--ok)">+${p}%</button>`)}</div>
        <div class="msg"></div><div class="msg info" id="diff"></div></div>
      <div class="alertbar info" style="margin-top:12px">${icon('info')}<span>السعر الجديد بيسري من دلوقتي على أي خدمة جديدة. الإيصالات والخدمات اللي اتسجلت قبل كده بتفضل بسعرها.</span></div>
      <h4 class="subh">${icon('history', 'sm')} تاريخ الأسعار</h4>
      <div class="list" id="hist"><div class="skel" style="height:60px"></div></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('check')} احفظ السعر</button>`,
  });
  const inp = $('[name=price]', m.el);
  setTimeout(() => inp.select(), 40);
  const diff = () => {
    const n = Number(inp.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632));
    const d = $('#diff', m.el);
    if (!Number.isFinite(n) || n === s.price || !inp.value) { d.textContent = ''; return; }
    const pc = s.price ? Math.round(((n - s.price) / s.price) * 1000) / 10 : 0;
    d.textContent = `${n > s.price ? 'زيادة' : 'نقص'} ${money(Math.abs(n - s.price))} ${HMS.money.unitWord}${s.price ? ` (${Math.abs(pc)}%)` : ''}`;
    d.style.color = n > s.price ? 'var(--ok)' : 'var(--danger)';
  };
  inp.addEventListener('input', diff);
  m.el.addEventListener('click', (e) => {
    const u = e.target.closest('[data-up]');
    if (u) { inp.value = Math.round(s.price * (1 + Number(u.dataset.up) / 100)); diff(); inp.focus(); }
  });
  const save = async () => {
    try {
      const r = await api.post(`/admin/services/${s.id}/price`, { price: inp.value });
      m.close();
      toast(r.changed ? `سعر «${s.name}» بقى ${money(r.service.price)} ${HMS.money.unitWord}` : 'السعر زي ما هو', r.changed ? 'ok' : 'info');
      onSaved();
    } catch (e) { showErrors(m.el, e); }
  };
  $('[data-save]', m.el).addEventListener('click', save);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const h = (await api.get(`/admin/services/${s.id}/prices`)).prices;
  $('#hist', m.el).innerHTML = String(html`${h.map((p, i) => html`<div class="li"><span class="badge ${i === 0 ? 'ok' : ''}">${i === 0 ? 'الحالي' : 'قديم'}</span>
    <div><b>${egp(p.price)}</b><small>${p.by}</small></div><small class="amt muted" style="font-weight:600">${fmtWhen(p.from)}</small></div>`)}`);
}

function importModal(onDone) {
  let file = null;
  const m = modal({
    title: 'استيراد الخدمات والأسعار من إكسل', wide: true,
    body: html`<div id="step">
      <ol class="steps">
        <li><b>نزّل القايمة الحالية</b> من زرار «تصدير إكسل» (أو <a href="/api/admin/services/export" class="linkbtn">من هنا</a>).</li>
        <li><b>عدّل في إكسل:</b> غيّر الأسعار أو الأسماء، أو ضيف صفوف جديدة (سيب الكود فاضي).</li>
        <li><b>ارفع الملف هنا</b> وهتشوف كل التغييرات قبل ما تتنفذ.</li>
      </ol>
      <label class="drop" id="drop">${icon('sheet', 'lg')}<b>دوس هنا أو اسحب ملف الإكسل</b><small>ملف xlsx · العناوين المطلوبة: اسم الخدمة، السعر (والباقي اختياري)</small>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
    </div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn hide" data-apply style="--c:var(--ok)">${icon('check')} نفّذ التغييرات</button>`,
  });
  const input = $('input[type=file]', m.el), drop = $('#drop', m.el), apply = $('[data-apply]', m.el);
  const send = async (mode) => {
    const r = await fetch('/api/admin/services/import?mode=' + mode, { method: 'POST', body: file, credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, d);
    return d;
  };
  const preview = async (f) => {
    file = f;
    $('#step', m.el).innerHTML = String(html`<div class="skel" style="height:220px"></div>`);
    try { showPlan(await send('preview')); } catch (e) {
      $('#step', m.el).innerHTML = String(html`<div class="alertbar danger">${icon('alert')}<span>${e.message}</span></div>
        <div style="margin-top:12px"><button class="btn ghost" data-again>${icon('upload')} اختار ملف تاني</button></div>`);
    }
  };
  let filter = 'changes';
  const showPlan = (d) => {
    const s = d.summary;
    const show = d.plan.filter((x) => (filter === 'all' ? true : filter === 'changes' ? x.status !== 'same' : x.status === filter));
    const tag = { new: ['ok', 'جديدة'], update: ['warn', 'تعديل'], same: ['', 'زي ما هي'], error: ['danger', 'فيها غلط'] };
    $('#step', m.el).innerHTML = String(html`
      <div class="impsum">
        <button data-flt="new" class="${filter === 'new' ? 'on' : ''}" style="--c:var(--ok)"><b class="num">${s.new}</b><span>خدمة جديدة</span></button>
        <button data-flt="update" class="${filter === 'update' ? 'on' : ''}" style="--c:var(--warn)"><b class="num">${s.update}</b><span>هتتعدل</span></button>
        <button data-flt="same" class="${filter === 'same' ? 'on' : ''}" style="--c:var(--muted)"><b class="num">${s.same}</b><span>زي ما هي</span></button>
        <button data-flt="error" class="${filter === 'error' ? 'on' : ''}" style="--c:var(--danger)"><b class="num">${s.error}</b><span>فيها غلط</span></button>
      </div>
      <div class="row" style="margin:10px 0 6px;gap:8px"><span class="muted" style="font-weight:700;font-size:13px">${file.name} · ${s.total} صف</span><span class="spacer"></span>
        <button class="linkbtn" data-flt="${filter === 'all' ? 'changes' : 'all'}">${filter === 'all' ? 'اعرض التغييرات بس' : 'اعرض كل الصفوف'}</button>
        <button class="linkbtn" data-again>${icon('upload', 'sm')} ملف تاني</button></div>
      ${show.length ? html`<div class="table-wrap" style="max-height:46vh;overflow:auto;border:1px solid var(--line-2);border-radius:14px"><table class="table">
        <thead><tr><th>صف</th><th>الحالة</th><th>الكود</th><th>الخدمة</th><th>القسم</th><th>السعر</th><th>التفاصيل</th></tr></thead>
        <tbody>${show.map((x) => html`<tr class="imp-${x.status}"><td class="num muted">${x.row}</td><td><span class="badge ${tag[x.status][0]}">${tag[x.status][1]}</span></td>
          <td><span class="code num">${x.code || 'تلقائي'}</span></td><td><b>${x.name}</b></td>
          <td>${x.dept ? html`<span class="dtag d-${x.dept}">${DEPT[x.dept].short}</span>` : '—'}</td>
          <td class="nw">${x.price != null ? html`${x.oldPrice != null && x.oldPrice !== x.price ? html`<s class="muted num">${money(x.oldPrice)}</s> ` : ''}<b>${egp(x.price)}</b>` : '—'}</td>
          <td style="font-size:13px">${x.status === 'error' ? html`<span style="color:var(--danger);font-weight:700">${x.errors.join(' · ')}</span>` : (x.changes || []).join(' · ')}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty" style="padding:22px">مفيش صفوف هنا</div>`}
      ${s.error ? html`<div class="alertbar warn" style="margin-top:10px">${icon('alert')}<span>الصفوف اللي فيها غلط مش هتتنفذ. صلّحها في الملف وارفعه تاني، أو نفّذ الباقي دلوقتي.</span></div>` : ''}`);
    const n = s.new + s.update;
    apply.classList.toggle('hide', !n);
    apply.innerHTML = String(html`${icon('check')} نفّذ ${n} تغيير`);
    m.el._plan = d;
  };
  input.addEventListener('change', () => input.files[0] && preview(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) preview(f); });
  m.el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-flt]');
    if (f && m.el._plan) { filter = f.dataset.flt; showPlan(m.el._plan); }
    if (e.target.closest('[data-again]')) { const i = el('<input type="file" accept=".xlsx">'); i.onchange = () => i.files[0] && preview(i.files[0]); i.click(); }
  });
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      const r = await send('apply');
      m.close();
      toast(`تمام: ${r.applied.created} خدمة جديدة و${r.applied.updated} تعديل`);
      onDone();
    } catch (e) { toastError(e); apply.disabled = false; }
  });
}

// ======================================================================
//                            الأطباء والنسب
// ======================================================================
let CLINIC_LIST = [];
async function doctorsPane(pane) {
  let docs = [], services = [], q = '', showOff = false;
  pane.innerHTML = String(html`
    <div class="card pad row wrap" style="gap:10px">
      <div class="big-search" style="flex:1 1 260px">${icon('search')}<input class="input" id="dq" type="search" placeholder="دوّر بالاسم أو التخصص" style="height:44px;font-size:15px;padding-inline-start:44px;border-radius:13px" autocomplete="off"></div>
      ${sw('off', false, 'اعرض الموقوفين')}
      <button class="btn" id="add">${icon('plus')} دكتور جديد</button>
    </div>
    <div class="alertbar info" style="margin-top:12px">${icon('info')}<span>المواعيد دي مؤقتة لحد ما نربط بـ«جدول اليوم»، وبعدها هتتقري من هناك لوحدها. النسب بتفضل من هنا.</span></div>
    <div id="dl" class="dgrid" style="margin-top:14px"><div class="skel" style="height:200px"></div></div>`);
  const today = { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 }[new Intl.DateTimeFormat('en-US', { timeZone: HMS.tz, weekday: 'short' }).format(new Date())];
  const shareText = (d) => {
    const parts = [];
    if (d.shares.general != null) parts.push(html`<span class="badge brand">عام <span class="num">${d.shares.general}%</span></span>`);
    for (const [k, v] of Object.entries(d.shares.depts)) parts.push(html`<span class="dtag d-${k}">${DEPT[k].short} <span class="num">${v}%</span></span>`);
    for (const s of d.shares.services) parts.push(html`<span class="badge">${s.name} <span class="num">${s.pct}%</span></span>`);
    return parts.length ? parts : html`<span class="badge warn">${icon('alert', 'sm')} مفيش نسبة</span>`;
  };
  const draw = () => {
    const k = searchKey(q);
    const list = docs.filter((d) => (showOff || d.active) && (!k || searchKey(d.name + ' ' + (d.specialty || '')).includes(k)));
    $('#dl', pane).innerHTML = list.length ? String(html`${list.map((d) => html`
      <article class="card dcard ${d.active ? '' : 'off'}">
        <div class="row" style="gap:12px">
          <span class="dav lg">${initials(d.name)}</span>
          <div style="min-width:0"><b class="dn">${d.name}</b><div class="muted" style="font-weight:700;font-size:13px">${d.specialty || 'بدون تخصص'}${d.active ? '' : ' · موقوف'}</div></div>
          <button class="btn ghost icon sm" data-edit="${d.id}" style="margin-inline-start:auto" title="تعديل">${icon('edit', 'sm')}</button>
        </div>
        <div class="week">${DAYS.map((n, i) => { const sl = d.schedule.filter((s) => s.weekday === i); return html`<span class="wd ${sl.length ? 'on' : ''} ${i === today ? 'today' : ''}" title="${sl.map(fmtSlot).join('، ') || 'مفيش'}">${n.replace(/^ال/, '').slice(0, 2)}</span>`; })}</div>
        <div class="muted" style="font-size:12.5px;font-weight:700;min-height:20px">${(() => { const t = d.schedule.filter((s) => s.weekday === today); return t.length ? html`${icon('clock', 'sm')} النهارده: ${t.map(fmtSlot).join('، ')}` : 'مش في جدول النهارده'; })()}</div>
        <div class="row wrap" style="gap:6px">${shareText(d)}</div>
      </article>`)}`)
      : String(html`<div class="card empty" style="grid-column:1/-1"><div class="art">${icon('steth')}</div><b>مفيش أطباء</b>ضيف أول دكتور</div>`);
  };
  const load = async () => {
    const [a, b, c] = await Promise.all([api.get('/admin/doctors'), api.get('/admin/services'), api.get('/admin/clinics')]);
    docs = a.doctors; services = b.services; CLINIC_LIST = c.clinics; draw();
  };
  $('#dq', pane).addEventListener('input', (e) => { q = e.target.value; draw(); });
  pane.onclick = (e) => {
    const s = e.target.closest('[data-sw="off"]');
    if (s) { showOff = s.getAttribute('aria-checked') !== 'true'; s.setAttribute('aria-checked', showOff); draw(); }
    const ed = e.target.closest('[data-edit]');
    if (ed) doctorModal(docs.find((d) => d.id === Number(ed.dataset.edit)), services, load);
    if (e.target.closest('#add')) doctorModal(null, services, load);
  };
  await load();
  return () => { pane.onclick = null; };
}

function doctorModal(d, services, onSaved) {
  const edit = !!d;
  const v = d || { name: 'د. ', specialty: '', active: true, schedule: [], shares: { general: '', depts: {}, services: [] } };
  const sched = DAYS.map((_, i) => v.schedule.filter((s) => s.weekday === i).map((s) => ({ ...s })));
  const svcShares = v.shares.services.map((s) => ({ ...s }));
  const withDoc = services.filter((s) => s.hasDoctor || svcShares.some((x) => x.serviceId === s.id));
  const m = modal({
    title: edit ? 'تعديل بيانات الدكتور' : 'دكتور جديد', wide: true,
    body: html`<div class="form-grid">
      <div class="field c3" data-f="name"><label>الاسم <span class="req">*</span></label><input class="input" name="name" value="${v.name}" autofocus><div class="msg"></div></div>
      <div class="field c2" data-f="clinicId"><label>العيادة</label><select class="select" name="clinicId"><option value="">بدون عيادة${v.specialty && !v.clinicId ? ` (${v.specialty})` : ''}</option>${CLINIC_LIST.filter((c) => c.active || c.id === v.clinicId).map((c) => html`<option value="${c.id}" ${c.id === v.clinicId ? 'selected' : ''}>${c.name}</option>`)}</select><div class="msg"></div></div>
      <div class="field c1" style="justify-content:flex-end;padding-bottom:6px">${sw('active', v.active, 'فعّال')}</div>
    </div>
    <datalist id="specs">${['باطنة', 'أطفال', 'نسا وتوليد', 'جراحة عامة', 'عظام', 'قلب', 'أنف وأذن', 'عيون', 'جلدية', 'مسالك', 'مخ وأعصاب', 'أسنان', 'أشعة', 'طوارئ'].map((x) => html`<option value="${x}">`)}</datalist>

    <h4 class="subh">${icon('percent', 'sm')} نسبة الدكتور <span class="muted">الأولوية: نسبة الخدمة ← نسبة القسم ← النسبة العامة</span></h4>
    <div class="shares" data-f="shares">
      <div class="field"><label>النسبة العامة</label><div class="pctin"><input class="input num" name="general" inputmode="decimal" value="${v.shares.general ?? ''}" placeholder="مثلًا 40"><span>%</span></div></div>
      ${SVC_KEYS.map((k) => html`<div class="field d-${k}"><label><span class="dtag">${icon(DEPT[k].icon)} ${DEPT[k].short}</span></label><div class="pctin"><input class="input num" name="dept-${k}" inputmode="decimal" value="${v.shares.depts[k] ?? ''}" placeholder="زي العام"><span>%</span></div></div>`)}
      <div class="msg" style="grid-column:1/-1"></div>
    </div>
    <div id="svcsh" style="margin-top:10px"></div>

    <h4 class="subh">${icon('calendar', 'sm')} المواعيد في الأسبوع</h4>
    <div class="sched" data-f="schedule" id="sched"></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('check')} ${edit ? 'احفظ' : 'ضيف الدكتور'}</button>`,
  });
  bindSwitches(m.el);
  const drawSched = () => {
    $('#sched', m.el).innerHTML = String(html`${DAYS.map((n, i) => html`<div class="sday ${sched[i].length ? 'on' : ''}">
      <b>${n}</b>
      <div class="slots">${sched[i].map((s, j) => html`<span class="slot"><input type="time" value="${s.from}" data-t="from" data-i="${i}" data-j="${j}"><span>لـ</span><input type="time" value="${s.to}" data-t="to" data-i="${i}" data-j="${j}"><button type="button" data-rmslot="${i}:${j}" aria-label="شيل">${icon('x', 'sm')}</button></span>`)}
        ${!sched[i].length ? html`<span class="muted" style="font-size:13px;font-weight:600">مفيش</span>` : ''}</div>
      <div class="row" style="gap:4px;margin-inline-start:auto"><button type="button" class="btn ghost sm" data-addslot="${i}">${icon('plus', 'sm')} موعد</button>
        ${sched[i].length ? html`<button type="button" class="btn ghost sm" data-copy="${i}" title="نفس المواعيد لكل الأيام">نسخ للكل</button>` : ''}</div>
    </div>`)}<div class="msg"></div>`);
  };
  const drawSvc = () => {
    $('#svcsh', m.el).innerHTML = String(html`
      ${svcShares.map((s, j) => html`<div class="svcrow"><select class="select" data-ss="${j}">${withDoc.map((x) => html`<option value="${x.id}" ${x.id === s.serviceId ? 'selected' : ''}>${x.name} (${DEPT[x.dept].short})</option>`)}</select>
        <div class="pctin" style="width:120px"><input class="input num" data-sp="${j}" value="${s.pct ?? ''}" inputmode="decimal"><span>%</span></div>
        <button type="button" class="btn ghost icon sm" data-rmss="${j}">${icon('trash', 'sm')}</button></div>`)}
      <button type="button" class="linkbtn" data-addss>${icon('plus', 'sm')} نسبة مختلفة لخدمة معينة (مثلًا: سونار 30%)</button>`);
  };
  drawSched(); drawSvc();
  m.el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.t) sched[t.dataset.i][t.dataset.j][t.dataset.t] = t.value;
    if (t.dataset.sp != null) svcShares[t.dataset.sp].pct = t.value;
  });
  m.el.addEventListener('change', (e) => { if (e.target.dataset.ss != null) svcShares[e.target.dataset.ss].serviceId = Number(e.target.value); });
  m.el.addEventListener('click', (e) => {
    const t = e.target;
    const a = t.closest('[data-addslot]');
    if (a) { const i = Number(a.dataset.addslot); const last = sched[i].at(-1); sched[i].push(last ? { from: last.to, to: last.to } : { from: '17:00', to: '21:00' }); drawSched(); return; }
    const r = t.closest('[data-rmslot]');
    if (r) { const [i, j] = r.dataset.rmslot.split(':').map(Number); sched[i].splice(j, 1); drawSched(); return; }
    const c = t.closest('[data-copy]');
    if (c) { const src = sched[Number(c.dataset.copy)]; for (let i = 0; i < 7; i++) if (i !== Number(c.dataset.copy)) sched[i] = src.map((s) => ({ ...s })); drawSched(); toast('اتنسخت المواعيد لكل الأيام. شيل الأيام اللي مش بييجي فيها.', 'info'); return; }
    if (t.closest('[data-addss]')) {
      if (!withDoc.length) return toast('مفيش خدمات ليها دكتور', 'warn');
      const free = withDoc.find((x) => !svcShares.some((s) => s.serviceId === x.id)) || withDoc[0];
      svcShares.push({ serviceId: free.id, pct: '' }); drawSvc(); return;
    }
    const rs = t.closest('[data-rmss]');
    if (rs) { svcShares.splice(Number(rs.dataset.rmss), 1); drawSvc(); }
  });
  $('[data-save]', m.el).addEventListener('click', async () => {
    const val = (n) => $(`[name="${n}"]`, m.el).value;
    const body = {
      name: val('name'), clinicId: val('clinicId') || null, specialty: val('clinicId') ? '' : (v.specialty || ''), active: swVal(m.el, 'active'), externalRef: d?.externalRef,
      schedule: sched.flatMap((list, i) => list.map((s) => ({ weekday: i, from: s.from, to: s.to }))),
      shares: { general: val('general'), depts: Object.fromEntries(SVC_KEYS.map((k) => [k, val('dept-' + k)])), services: svcShares },
    };
    if (!body.shares.general && !SVC_KEYS.some((k) => body.shares.depts[k]) && !svcShares.length) {
      if (!confirm('مفيش أي نسبة للدكتور ده، يعني مستحقاته هتبقى صفر. تكمّل؟')) return;
    }
    try {
      const r = edit ? await api.put('/admin/doctors/' + d.id, body) : await api.post('/admin/doctors', body);
      m.close(); toast(edit ? 'اتحفظت بيانات الدكتور' : `اتضاف ${r.doctor.name}`); onSaved();
    } catch (e) { showErrors(m.el, e); }
  });
}


// ======================================================================
//                          الغرف والأسرّة والأسعار
// ======================================================================
async function roomsPane(pane) {
  let D = null, floorSel = null;
  pane.innerHTML = String(html`<div id="rp"><div class="skel" style="height:320px"></div></div>`);
  const draw = () => {
    const missing = D.classes.filter((c) => c.active && c.rooms && c.nightPrice == null);
    const floors = D.floors;
    if (floorSel == null && floors.length) floorSel = floors[0].id;
    const rooms = D.rooms.filter((r) => r.floorId === floorSel);
    const clsOf = (id) => D.classes.find((c) => c.id === id);
    $('#rp', pane).innerHTML = String(html`
      ${missing.length ? html`<div class="alertbar warn" style="margin-bottom:14px">${icon('alert')}<span>درجات عليها غرف ولسه من غير سعر ليلة (مينفعش دخول عليها): <b>${missing.map((c) => c.name).join('، ')}</b></span></div>` : ''}
      <div class="rooms-top">
        <section class="card pad">
          <h3>${icon('tag')} درجات الغرف والأسعار <button class="btn soft sm" data-addclass style="margin-inline-start:auto">${icon('plus', 'sm')} درجة</button></h3>
          <div class="table-wrap"><table class="table"><thead><tr><th>الدرجة</th><th>النوع</th><th>سعر الليلة</th><th>تأمين الدخول</th><th class="hide-sm">غرف</th><th></th></tr></thead><tbody>
          ${D.classes.map((c) => html`<tr class="${c.active ? '' : 'off-row'}"><td><b>${c.name}</b></td><td><span class="kindtag k-${c.kind}">${icon(KIND_ICON[c.kind], 'sm')} ${KIND[c.kind]}</span></td>
            <td class="nw">${c.nightPrice == null ? html`<span class="badge warn">لسه</span>` : html`<b>${egp(c.nightPrice)}</b>`}</td>
            <td class="nw">${c.deposit == null ? html`<span class="muted">—</span>` : egp(c.deposit)}</td><td class="hide-sm num">${c.rooms}</td>
            <td class="n"><button class="btn ghost icon sm" data-class="${c.id}" title="تعديل">${icon('edit', 'sm')}</button></td></tr>`)}
          </tbody></table></div>
        </section>
        <div class="grid" style="gap:16px">
        <section class="card pad">
          <h3>${icon('clock')} ميعاد حساب يوم الخروج</h3>
          <p class="muted" style="font-size:13px;font-weight:600;margin:0 0 10px">لو المريض خرج قبل الساعة دي، يوم الخروج مش بيتحسب ليلة. ويوم الدخول بيتحسب دايمًا (وأقل حاجة ليلة).</p>
          <div class="row" style="gap:8px"><div class="field" data-f="checkoutTime" style="flex:1"><input class="input num" type="time" name="co" value="${D.settings.checkoutTime}"><div class="msg"></div></div><button class="btn" data-saveco>${icon('check')} احفظ</button></div>
        </section>
        <section class="card pad">
          <h3>${icon('cashbox')} الخزينة</h3>
          <p class="muted" style="font-size:13px;font-weight:600;margin:0 0 10px">لما موظف خزينة يبدأ ورديته، الاستقبال بيعمل «إذن دفع» والمريض يدفع في الخزينة. من غير خزينة مفتوحة (السهر) الاستقبال بيقبض بنفسه.</p>
          <label class="swl" style="margin-bottom:8px"><button type="button" class="switch" role="switch" data-cm aria-checked="${D.settings.cashierMode !== 'off' ? 'true' : 'false'}"></button><span>أذونات الدفع للخزينة شغالة</span></label>
          <label class="swl"><button type="button" class="switch" role="switch" data-mn aria-checked="${D.settings.manualNoRequired ? 'true' : 'false'}"></button><span>رقم الإيصال اليدوي إجباري في الخزينة</span></label>
        </section>
        <section class="card pad">
          <h3>${icon('ticket')} حسابات الإقامة (التذكرة)</h3>
          <p class="muted" style="font-size:13px;font-weight:600;margin:0 0 10px">لو شغال: الخدمات والأدوية والمستلزمات بتتكتب من الحسابات بس، والمريض مايخرجش غير لما آخر موظف حسابات يقفل التذكرة.</p>
          <label class="swl" style="margin-bottom:8px"><button type="button" class="switch" role="switch" data-tm aria-checked="${D.settings.ticketMode ? 'true' : 'false'}"></button><span>نظام التذكرة شغال</span></label>
          <label class="swl"><button type="button" class="switch" role="switch" data-sd aria-checked="${D.settings.stockDeduct ? 'true' : 'false'}"></button><span>الأدوية والمستلزمات بتتخصم من مخزن الدور</span></label>
        </section>
        <section class="card pad">
          <h3>${icon('flask')} المعمل</h3>
          <p class="muted" style="font-size:13px;font-weight:600;margin:0 0 10px">لو اتفعّل: الفني يكتب النتيجة، ودكتور المعمل لازم يعتمدها قبل الطباعة والتسليم.</p>
          <label class="swl"><button type="button" class="switch" role="switch" data-lv aria-checked="${D.settings.labVerify ? 'true' : 'false'}"></button><span>النتايج محتاجة اعتماد دكتور المعمل</span></label>
        </section>
        </div>
      </div>
      <section class="card pad" style="margin-top:16px">
        <div class="row wrap" style="gap:10px;margin-bottom:12px">
          <h3 style="margin:0">${icon('layers')} الأدوار والغرف</h3>
          <div class="floortabs">${floors.map((f) => html`<button class="${f.id === floorSel ? 'on' : ''} ${f.active ? '' : 'off'}" data-floor="${f.id}"><b class="num">${f.no}</b><span>${f.notes || f.name}</span></button>`)}
            <button data-addfloor title="دور جديد">${icon('plus', 'sm')}</button></div>
          <span class="spacer"></span>
          ${floorSel ? html`<button class="btn ghost sm" data-editfloor>${icon('edit', 'sm')} تعديل الدور</button><button class="btn sm" data-addroom>${icon('plus', 'sm')} غرفة جديدة</button>` : ''}
        </div>
        ${rooms.length ? html`<div class="rgrid">${rooms.map((r) => { const c = clsOf(r.classId); return html`<div class="rcard k-${c.kind} ${r.active ? '' : 'off'}">
          <div class="row" style="gap:8px"><span class="rno">${icon(KIND_ICON[c.kind], 'sm')}<b class="num">${r.no}</b></span><span class="muted" style="font-weight:700;font-size:13px">${c.name}</span>
            <button class="btn ghost icon sm" data-room="${r.id}" style="margin-inline-start:auto" title="تعديل الغرفة">${icon('edit', 'sm')}</button></div>
          <div class="rbeds">${r.beds.map((b) => html`<button class="rbed ${b.active ? '' : 'off'} ${b.occupied ? 'occ' : ''}" data-bedx="${b.id}" title="${b.occupied ? 'عليه مريض' : b.active ? 'دوس للتعديل' : 'موقوف'}">${b.label}</button>`)}
            <button class="rbed add" data-addbed="${r.id}" title="سرير جديد">${icon('plus', 'sm')}</button></div>
          ${r.notes ? html`<small class="muted">${r.notes}</small>` : ''}${r.active ? '' : html`<span class="badge">موقوفة</span>`}
        </div>`; })}</div>`
        : html`<div class="empty"><div class="art">${icon('door')}</div><b>مفيش غرف في الدور ده</b>دوس «غرفة جديدة» وحدد الدرجة وعدد الأسرّة</div>`}
      </section>`);
  };
  const load = async () => { D = await api.get('/admin/rooms'); draw(); };
  const apply = (r) => { D = r; draw(); };
  pane.onclick = async (e) => {
    const t = e.target;
    const f = t.closest('[data-floor]');
    if (f) { floorSel = Number(f.dataset.floor); draw(); return; }
    if (t.closest('[data-addfloor]')) return floorModal(null);
    if (t.closest('[data-editfloor]')) return floorModal(D.floors.find((x) => x.id === floorSel));
    if (t.closest('[data-addclass]')) return classModal(null);
    const c = t.closest('[data-class]');
    if (c) return classModal(D.classes.find((x) => x.id === Number(c.dataset.class)));
    if (t.closest('[data-addroom]')) return roomModal(null);
    const r = t.closest('[data-room]');
    if (r) return roomModal(D.rooms.find((x) => x.id === Number(r.dataset.room)));
    const ab = t.closest('[data-addbed]');
    if (ab) {
      const room = D.rooms.find((x) => x.id === Number(ab.dataset.addbed));
      const m = modal({
        title: `سرير جديد في غرفة ${room.no}`,
        body: html`<div class="field"><label>اسم السرير</label><input class="input" name="label" value="${room.beds.length + 1}" autofocus></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('plus')} ضيف</button>`,
      });
      const go2 = async () => { try { apply(await api.post(`/admin/rooms/${room.id}/beds`, { label: $('[name=label]', m.el).value })); m.close(); toast('اتضاف السرير'); } catch (er) { toastError(er); } };
      $('[data-ok]', m.el).addEventListener('click', go2);
      $('[name=label]', m.el).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go2(); });
      return;
    }
    const bx = t.closest('[data-bedx]');
    if (bx) return bedModal(D.rooms.flatMap((x) => x.beds).find((b) => b.id === Number(bx.dataset.bedx)));
    const sd = t.closest('[data-sd]');
    if (sd) {
      sd.setAttribute('aria-checked', sd.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      try { apply(await api.put('/admin/ticket-settings', { stockDeduct: sd.getAttribute('aria-checked') === 'true' ? 'on' : 'off' })); toast('اتحفظ'); } catch (er) { showErrors(pane, er); }
      return;
    }
    const tm = t.closest('[data-tm]');
    if (tm) {
      tm.setAttribute('aria-checked', tm.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      try { apply(await api.put('/admin/ticket-settings', { ticketMode: tm.getAttribute('aria-checked') === 'true' ? 'on' : 'off' })); toast('اتحفظ'); } catch (er) { showErrors(pane, er); }
      return;
    }
    const lv = t.closest('[data-lv]');
    if (lv) {
      lv.setAttribute('aria-checked', lv.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      try { apply(await api.put('/admin/lab-settings', { labVerify: lv.getAttribute('aria-checked') === 'true' })); toast('اتحفظ'); } catch (er) { showErrors(pane, er); }
      return;
    }
    const sw = t.closest('[data-cm],[data-mn]');
    if (sw) {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      const on = (k) => $(`[${k}]`, pane).getAttribute('aria-checked') === 'true';
      try { apply(await api.put('/admin/cashier-settings', { cashierMode: on('data-cm') ? 'auto' : 'off', manualNoRequired: on('data-mn') })); toast('اتحفظت إعدادات الخزينة'); } catch (er) { showErrors(pane, er); }
      return;
    }
    if (t.closest('[data-saveco]')) {
      try { apply(await api.put('/admin/settings', { checkoutTime: $('[name=co]', pane).value })); toast('اتحفظ ميعاد حساب يوم الخروج'); } catch (er) { showErrors(pane, er); }
    }
  };

  function floorModal(f) {
    const m = modal({
      title: f ? 'تعديل الدور' : 'دور جديد',
      body: html`<div class="form-grid"><div class="field c2" data-f="no"><label>رقم الدور</label><input class="input num" name="no" value="${f?.no ?? ''}" autofocus><div class="msg"></div></div>
        <div class="field c4" data-f="name"><label>الاسم</label><input class="input" name="name" value="${f?.name || ''}" placeholder="الدور الخامس"><div class="msg"></div></div>
        <div class="field c6"><label>بيضم إيه</label><input class="input" name="notes" value="${f?.notes || ''}" placeholder="مثلًا: إقامة + حضانة"></div>
        ${f ? html`<div class="field c6">${sw('active', f.active, 'الدور شغال (لو وقفته غرفه مش هتظهر في اللوحة)')}</div>` : ''}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSwitches(m.el);
    $('[data-ok]', m.el).addEventListener('click', async () => {
      const v = (n) => $(`[name=${n}]`, m.el).value;
      const body = { no: v('no'), name: v('name'), notes: v('notes'), active: f ? swVal(m.el, 'active') : true };
      try { apply(f ? await api.put('/admin/floors/' + f.id, body) : await api.post('/admin/floors', body)); m.close(); toast('اتحفظ'); } catch (er) { showErrors(m.el, er); }
    });
  }
  function classModal(c) {
    const m = modal({
      title: c ? `درجة «${c.name}»` : 'درجة غرف جديدة',
      body: html`<div class="form-grid">
        <div class="field c3" data-f="name"><label>اسم الدرجة</label><input class="input" name="name" value="${c?.name || ''}" autofocus><div class="msg"></div></div>
        <div class="field c3" data-f="kind"><label>النوع</label><div class="seg full" data-seg="kind">${Object.entries(KIND).map(([k, n]) => html`<button type="button" data-v="${k}" class="${(c?.kind || 'ward') === k ? 'on' : ''}">${icon(KIND_ICON[k], 'sm')}${n}</button>`)}</div><div class="msg"></div></div>
        <div class="field c3" data-f="nightPrice"><label>سعر الليلة (${HMS.money.unitWord})</label><input class="input num" name="nightPrice" inputmode="decimal" value="${c?.nightPrice ?? ''}" placeholder="لسه"><div class="msg"></div></div>
        <div class="field c3" data-f="deposit"><label>تأمين الدخول (${HMS.money.unitWord})</label><input class="input num" name="deposit" inputmode="decimal" value="${c?.deposit ?? ''}" placeholder="0"><div class="msg"></div></div>
        ${c ? html`<div class="field c6">${sw('active', c.active, 'الدرجة شغالة')}</div>` : ''}
      </div>
      <div class="alertbar info" style="margin-top:12px">${icon('info')}<span>السعر الجديد بيسري على الليالي الجاية. الليالي اللي اتسجلت قبل كده بتفضل بسعرها. موظف الاستقبال يقدر يزوّد التأمين بس، والمدير يقدر يقلله.</span></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSwitches(m.el); bindSegs(m.el);
    $('[data-ok]', m.el).addEventListener('click', async () => {
      const v = (n) => $(`[name=${n}]`, m.el).value;
      const body = { name: v('name'), kind: segVal(m.el, 'kind'), nightPrice: v('nightPrice'), deposit: v('deposit'), active: c ? swVal(m.el, 'active') : true };
      try { apply(c ? await api.put('/admin/classes/' + c.id, body) : await api.post('/admin/classes', body)); m.close(); toast('اتحفظت الدرجة'); } catch (er) { showErrors(m.el, er); }
    });
  }
  function roomModal(r) {
    const m = modal({
      title: r ? `غرفة ${r.no}` : 'غرفة جديدة', wide: true,
      body: html`<div class="form-grid">
        <div class="field c2" data-f="no"><label>رقم/اسم الغرفة</label><input class="input" name="no" value="${r?.no || ''}" placeholder="301 أو عناية 1" autofocus><div class="msg"></div></div>
        <div class="field c2" data-f="floorId"><label>الدور</label><select class="select" name="floorId">${D.floors.map((f) => html`<option value="${f.id}" ${(r?.floorId ?? floorSel) === f.id ? 'selected' : ''}>${f.name}</option>`)}</select><div class="msg"></div></div>
        ${r ? '' : html`<div class="field c2" data-f="bedCount"><label>عدد الأسرّة</label><input class="input num" name="bedCount" value="1" inputmode="numeric"><div class="msg"></div></div>`}
        <div class="field c6" data-f="classId"><label>الدرجة</label><div class="classpick">${D.classes.filter((c) => c.active || c.id === r?.classId).map((c) => html`
          <label class="cp k-${c.kind}"><input type="radio" name="classId" value="${c.id}" ${(r?.classId ?? D.classes[0]?.id) === c.id ? 'checked' : ''}><span>${icon(KIND_ICON[c.kind], 'sm')}<b>${c.name}</b><small>${c.nightPrice == null ? 'من غير سعر' : money(c.nightPrice) + ' ' + HMS.money.symbol}</small></span></label>`)}</div><div class="msg"></div></div>
        <div class="field c6"><label>ملاحظات</label><input class="input" name="notes" value="${r?.notes || ''}" placeholder="مثلًا: فيها حمام خاص"></div>
        ${r ? html`<div class="field c6">${sw('active', r.active, 'الغرفة شغالة')}</div>` : ''}
      </div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSwitches(m.el);
    $('[data-ok]', m.el).addEventListener('click', async () => {
      const v = (n) => $(`[name=${n}]`, m.el)?.value;
      const body = { no: v('no'), floorId: v('floorId'), classId: $('[name=classId]:checked', m.el)?.value, notes: v('notes'), bedCount: v('bedCount'), active: r ? swVal(m.el, 'active') : true };
      try { apply(r ? await api.put('/admin/rooms/' + r.id, body) : await api.post('/admin/rooms', body)); floorSel = Number(body.floorId); draw(); m.close(); toast(r ? 'اتحفظت الغرفة' : `اتضافت غرفة ${body.no}`); } catch (er) { showErrors(m.el, er); }
    });
  }
  function bedModal(b) {
    const m = modal({
      title: `سرير ${b.label}`,
      body: html`<div class="grid" style="gap:12px"><div class="field"><label>اسم السرير</label><input class="input" name="label" value="${b.label}" autofocus></div>
        ${b.occupied ? html`<div class="alertbar info">${icon('info')}<span>عليه مريض دلوقتي، مينفعش يتوقف.</span></div>` : sw('active', b.active, 'السرير شغال')}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSwitches(m.el);
    $('[data-ok]', m.el).addEventListener('click', async () => {
      try { apply(await api.put('/admin/beds/' + b.id, { label: $('[name=label]', m.el).value, active: b.occupied ? true : swVal(m.el, 'active') })); m.close(); toast('اتحفظ'); } catch (er) { toastError(er); }
    });
  }
  await load();
  return () => { pane.onclick = null; };
}

// ======================================================================
//                              المستخدمين
// ======================================================================
const roleColor = (r) => r?.color || 'var(--muted)';
// كل الأدوار ممكن تتربط بمخازن (الاستقبال بيصرف من الطوارئ والعيادات مثلًا)، ماعدا المدير اللي شايف كله
const STORE_ROLES = { includes: (r) => r !== 'manager' };
async function clinicsPane(pane) {
  let list = [], stores = [];
  pane.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px"><span class="muted" style="font-weight:700">كل عيادة ليها مخزنها، والدكتور بيتربط بعيادته من «الأطباء والنسب».</span><span class="spacer"></span><button class="btn" id="cadd">${icon('plus')} عيادة جديدة</button></div><div id="cl" style="margin-top:14px"><div class="skel" style="height:200px"></div></div>`);
  const draw = () => {
    $('#cl', pane).innerHTML = String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>العيادة</th><th>المخزن</th><th class="n">الأطباء</th><th></th></tr></thead><tbody>
      ${list.map((c) => html`<tr class="${c.active ? '' : 'off-row'} click" data-cedit="${c.id}"><td><b>${c.name}</b>${c.active ? '' : html` <span class="badge">موقوفة</span>`}</td><td>${c.storeName || html`<span class="muted">مش مربوطة بمخزن</span>`}</td><td class="n num">${c.doctors}</td><td>${icon('edit', 'sm')}</td></tr>`)}
      ${!list.length ? html`<tr><td colspan="4"><div class="empty">مفيش عيادات. ضيف أول عيادة.</div></td></tr>` : ''}</tbody></table></div></div>`);
  };
  const load = async () => { const r = await api.get('/admin/clinics'); list = r.clinics; stores = r.stores; draw(); };
  const modalFor = (c) => {
    const v = c || { name: '', storeId: null, active: true, sharePct: null, shareFixed: null };
    const taken = new Set(list.filter((x) => x.id !== v.id && x.storeId).map((x) => x.storeId));
    const m = modal({
      title: c ? 'تعديل عيادة' : 'عيادة جديدة',
      body: html`<div class="grid" style="gap:12px">
        <div class="field" data-f="name"><label>اسم العيادة <span class="req">*</span></label><input class="input" name="name" value="${v.name}" autofocus><div class="msg"></div></div>
        <div class="field" data-f="storeId"><label>المخزن</label><select class="select" name="storeId"><option value="">${c ? 'مش مربوطة بمخزن' : 'اعمل مخزن جديد للعيادة'}</option>${stores.filter((s) => !taken.has(s.id)).map((s) => html`<option value="${s.id}" ${s.id === v.storeId ? 'selected' : ''}>${s.name}</option>`)}</select><div class="msg"></div></div>
        ${shareField(v, 'افتراضي لخدمات العيادة اللي ملهاش نصيب')}
        ${c ? html`<label class="swl"><button type="button" class="switch" role="switch" data-act aria-checked="${v.active ? 'true' : 'false'}"></button><span>العيادة شغالة</span></label>` : ''}</div>`,
      foot: html`${c && !c.doctors ? html`<button class="btn ghost danger" data-del style="margin-inline-end:auto">${icon('trash')} امسح</button>` : ''}<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSegs(m.el); bindShare(m.el);
    m.el.addEventListener('click', async (e) => {
      const sw = e.target.closest('[data-act]');
      if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
      if (e.target.closest('[data-del]')) { if (!confirm('تمسح العيادة؟')) return; try { await api.del('/admin/clinics/' + c.id); m.close(); toast('اتمسحت العيادة'); load(); } catch (er) { toastError(er); } return; }
      if (!e.target.closest('[data-ok]')) return;
      const sid = $('[name=storeId]', m.el).value;
      const body = { name: $('[name=name]', m.el).value, storeId: sid || null, newStore: !c && !sid, active: c ? $('[data-act]', m.el).getAttribute('aria-checked') === 'true' : true, ...shareBody(m.el) };
      try { if (c) await api.put('/admin/clinics/' + c.id, body); else await api.post('/admin/clinics', body); m.close(); toast('اتحفظت العيادة'); load(); }
      catch (er) {
        $$('.field', m.el).forEach((f) => { f.classList.remove('err'); const mm = $('.msg', f); if (mm) mm.textContent = ''; });
        if (er instanceof ApiError && er.data.errors) for (const [f, msg] of Object.entries(er.data.errors)) { const b = $(`[data-f="${f}"]`, m.el); if (b) { b.classList.add('err'); $('.msg', b).textContent = msg; } }
        else toastError(er);
      }
    });
  };
  pane.onclick = (e) => { const r = e.target.closest('[data-cedit]'); if (r) return modalFor(list.find((x) => x.id === Number(r.dataset.cedit))); if (e.target.closest('#cadd')) modalFor(null); };
  await load();
}

async function rolesPane(pane) {
  pane.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px"><div><b style="font-size:16px">الأدوار والصلاحيات</b><div class="muted" style="font-size:13px;font-weight:600">كل دور بيحدد الموظف يشوف إيه ويعمل إيه. تقدر تعدّل صلاحيات الأدوار أو تعمل دور جديد.</div></div><span class="spacer"></span><button class="btn" id="radd">${icon('plus')} دور جديد</button></div><div id="rl" style="margin-top:16px"><div class="skel" style="height:240px"></div></div>`);
  let roles = [], groups = [];
  const load = async () => {
    const r = await api.get('/admin/roles'); roles = r.roles; groups = r.groups;
    $('#rl', pane).innerHTML = String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>الدور</th><th>الوصف</th><th class="n">الصلاحيات</th><th class="n">الموظفين</th></tr></thead><tbody>
      ${roles.map((x) => html`<tr class="click" data-redit="${x.code}"><td><span class="rolebadge" style="--rc:${roleColor(x)}">${x.name}</span></td><td class="muted" style="font-size:13px">${x.description}</td><td class="n num">${x.all ? 'كل الصلاحيات' : x.perms.length}</td><td class="n num">${x.users}</td></tr>`)}</tbody></table></div></div>`);
  };
  const modalFor = (x) => {
    const v = x || { name: '', description: '', color: '', home: '/', perms: [], all: false };
    const locked = !!x && x.code === 'manager';
    const HOMES = [['/', 'الرئيسية (استقبال)'], ['/cashier', 'الخزينة'], ['/radiology', 'الأشعة'], ['/lab', 'المعمل'], ['/accounts', 'حسابات الإقامة'], ['/pharmacy', 'الصيدلية'], ['/claims', 'حسابات التعاقدات'], ['/finance', 'الحسابات العامة'], ['/stores', 'المخازن']];
    const m = modal({
      title: x ? 'تعديل دور: ' + x.name : 'دور جديد',
      body: html`<div class="grid" style="gap:12px">
        ${locked ? html`<div class="alertbar">${icon('info')}<span>دور المدير ثابت وليه كل الصلاحيات.</span></div>` : ''}
        <div class="field" data-f="name"><label>اسم الدور <span class="req">*</span></label><input class="input" name="name" value="${v.name}" ${locked ? 'disabled' : ''}><div class="msg"></div></div>
        <div class="field"><label>وصف مختصر</label><input class="input" name="description" value="${v.description}" ${locked ? 'disabled' : ''}></div>
        <div class="field"><label>الشاشة اللي يفتح عليها</label><select class="select" name="home" ${locked ? 'disabled' : ''}>${HOMES.map(([k, n]) => html`<option value="${k}" ${v.home === k ? 'selected' : ''}>${n}</option>`)}</select></div>
        <div class="field" data-f="perms"><label>الصلاحيات</label><div class="msg"></div>
          ${groups.map((g) => html`<div class="card pad" style="margin-top:8px"><b>${g.title}</b><div class="chips" style="margin-top:8px">${g.perms.map((p) => html`<label class="chip ck"><input type="checkbox" name="pm" value="${p.key}" ${v.all || v.perms.includes(p.key) ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${p.name}</label>`)}</div></div>`)}</div>
      </div>`,
      foot: html`${x && !x.system && !x.users ? html`<button class="btn ghost danger" data-del style="margin-inline-end:auto">${icon('trash')} امسح</button>` : ''}<button class="btn ghost" data-close>إلغاء</button>${locked ? '' : html`<button class="btn" data-ok>${icon('check')} احفظ</button>`}`,
    });
    m.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-del]')) { if (!confirm('تمسح الدور؟')) return; try { await api.del('/admin/roles/' + x.code); m.close(); toast('اتمسح الدور'); load(); } catch (er) { toastError(er); } return; }
      if (!e.target.closest('[data-ok]')) return;
      const body = { name: $('[name=name]', m.el).value, description: $('[name=description]', m.el).value, home: $('[name=home]', m.el).value, color: x?.color || '', perms: [...m.el.querySelectorAll('[name=pm]:checked')].map((i) => i.value) };
      try { if (x) await api.put('/admin/roles/' + x.code, body); else await api.post('/admin/roles', body); m.close(); toast('اتحفظ الدور'); load(); } catch (er) { showErrors(m.el, er); }
    });
  };
  pane.onclick = (e) => { const r = e.target.closest('[data-redit]'); if (r) return modalFor(roles.find((q) => q.code === r.dataset.redit)); if (e.target.closest('#radd')) modalFor(null); };
  await load();
  return () => { pane.onclick = null; };
}

async function usersPane(pane) {
  pane.innerHTML = String(html`
    <div class="card pad row wrap" style="gap:10px"><div><b style="font-size:16px">حسابات الموظفين</b><div class="muted" style="font-size:13px;font-weight:600">كل موظف ليه اسم دخول وكلمة سر خاصة بيه، وكل حاجة بيعملها بتتسجل باسمه</div></div>
      <span class="spacer"></span><button class="btn" id="add">${icon('user-plus')} مستخدم جديد</button></div>
    <div id="ul" style="margin-top:16px"><div class="skel" style="height:240px"></div></div>`);
  let users = [], meta = {};
  const load = async () => {
    meta = await api.get('/admin/users');
    users = meta.users;
    $('#ul', pane).innerHTML = String(html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th>الموظف</th><th>اسم الدخول</th><th>الدور</th><th class="hide-sm">آخر دخول</th><th>الحالة</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr class="${u.active ? '' : 'off-row'}">
        <td><div class="row" style="gap:10px"><span class="avatar" style="width:36px;height:36px;font-size:13px">${initials(u.name)}</span><b>${u.name}</b>${u.id === state.me.id ? html`<span class="badge">إنت</span>` : ''}</div></td>
        <td><span class="code num">${u.username}</span></td>
        <td><span class="rolebadge" style="--rc:${roleColor(meta.roleList?.find((x) => x.code === u.role))}">${u.roleName}</span>
          ${u.grants?.length || u.denied?.length ? html`<div style="margin-top:4px">${u.grants?.length ? html`<span class="badge warn" style="margin-inline-end:4px">+${u.grants.length} صلاحية</span>` : ''}${u.denied?.length ? html`<span class="badge" style="margin-inline-end:4px">−${u.denied.length} صلاحية</span>` : ''}</div>` : ''}
          ${u.stores?.length && STORE_ROLES.includes(u.role) ? html`<div class="muted" style="font-size:12px;margin-top:3px">${u.stores.map((id) => meta.stores.find((x) => x.id === id)?.name).filter(Boolean).join('، ')}</div>` : ''}</td>
        <td class="hide-sm muted">${u.lastLoginAt ? ago(u.lastLoginAt) : 'لسه ما دخلش'}</td>
        <td>${u.active ? html`<span class="badge ok dot">شغال</span>` : html`<span class="badge">موقوف</span>`}</td>
        <td class="n" style="white-space:nowrap"><button class="btn ghost sm" data-pw="${u.id}">${icon('key', 'sm')} كلمة السر</button> <button class="btn ghost icon sm" data-edit="${u.id}" title="تعديل">${icon('edit', 'sm')}</button></td>
      </tr>`)}</tbody></table></div></div>`);
  };
  pane.onclick = (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) userModal(users.find((u) => u.id === Number(ed.dataset.edit)), load, meta);
    const pw = e.target.closest('[data-pw]');
    if (pw) passwordModal(users.find((u) => u.id === Number(pw.dataset.pw)));
    if (e.target.closest('#add')) userModal(null, load, meta);
  };
  await load();
  return () => { pane.onclick = null; };
}

function userModal(u, onSaved, meta = {}) {
  const edit = !!u;
  const v = u || { role: (meta.roleList || [])[0]?.code || 'reception', active: true, grants: [], stores: [] };
  const m = modal({
    title: edit ? 'تعديل المستخدم' : 'مستخدم جديد',
    body: html`<div class="grid" style="gap:12px">
      <div class="field" data-f="name"><label>اسم الموظف <span class="req">*</span></label><input class="input" name="name" value="${v.name || ''}" autofocus><div class="msg"></div></div>
      ${edit ? '' : html`<div class="field" data-f="username"><label>اسم الدخول <span class="hint">إنجليزي صغير، مثلًا sara</span></label><input class="input num" name="username" autocapitalize="off" spellcheck="false" style="text-align:left"><div class="msg"></div></div>
        <div class="field" data-f="password"><label>كلمة السر <span class="hint">6 حروف على الأقل</span></label><input class="input" name="password" type="text" autocomplete="off" value="${genPw()}"><div class="msg"></div></div>`}
      <div class="field" data-f="role"><label>الدور</label><div class="roles">${(meta.roleList || []).map(({ code: k, name: n, description: d, color: c }) => html`
        <label class="role" style="--rc:${c || 'var(--muted)'}"><input type="radio" name="role" value="${k}" ${v.role === k ? 'checked' : ''}><span><b>${n}</b><small>${d}</small></span></label>`)}</div><div class="msg"></div></div>
      <div class="field ${STORE_ROLES.includes(v.role) ? '' : 'hide'}" id="ustores"><label>المخازن اللي بيشتغل عليها</label>
        <div class="chips">${(meta.stores || []).map((st) => html`<label class="chip ck"><input type="checkbox" name="st" value="${st.id}" ${v.stores?.includes(st.id) ? 'checked' : ''}> ${st.name}</label>`)}</div></div>
      <details class="field" id="uperms" ${(v.grants?.length || v.denied?.length) ? 'open' : ''}><summary style="cursor:pointer;font-weight:800">استثناءات الصلاحيات <span class="hint">بتتحسب فوق صلاحيات الدور: علّم للإضافة، شيل العلامة للسحب</span> <span class="badge warn" id="upc"></span></summary>
        <div id="upl" style="margin-top:8px"></div></details>
      ${edit ? html`<div class="field">${sw('active', v.active, 'الحساب شغال (لو وقفته هيخرج فورًا ومش هيقدر يدخل)')}</div>` : ''}
    </div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('check')} ${edit ? 'احفظ' : 'ضيف المستخدم'}</button>`,
  });
  bindSwitches(m.el);
  const rolePermsOf = (code) => new Set(meta.rolePerms?.[code] || []);
  const drawPerms = (code, grants, denied) => {
    const rp = rolePermsOf(code);
    const box = $('#uperms', m.el);
    box.classList.toggle('hide', rp.has('*'));
    $('#upl', m.el).innerHTML = String(html`${(meta.groups || []).map((g) => html`<div class="card pad" style="margin-top:8px"><b>${g.title}</b><div class="chips" style="margin-top:8px">${g.perms.map((p) => html`<label class="chip ck"><input type="checkbox" name="up" value="${p.key}" ${(rp.has(p.key) && !denied.includes(p.key)) || grants.includes(p.key) ? 'checked' : ''}> ${p.name}${rp.has(p.key) ? '' : html` <small class="muted">(مش في الدور)</small>`}</label>`)}</div></div>`)}`);
    cnt();
  };
  const diff = () => {
    const rp = rolePermsOf($('[name=role]:checked', m.el)?.value);
    const on = new Set([...m.el.querySelectorAll('[name=up]:checked')].map((x) => x.value));
    const all = (meta.groups || []).flatMap((g) => g.perms.map((p) => p.key));
    return rp.has('*') ? { grants: [], denied: [] } : { grants: all.filter((k) => on.has(k) && !rp.has(k)), denied: all.filter((k) => !on.has(k) && rp.has(k)) };
  };
  const cnt = () => { const d = diff(); $('#upc', m.el).textContent = d.grants.length + d.denied.length ? `${d.grants.length} إضافة / ${d.denied.length} سحب` : ''; };
  drawPerms(v.role, v.grants || [], v.denied || []);
  m.el.addEventListener('change', (e) => {
    if (e.target.name === 'role') { $('#ustores', m.el).classList.toggle('hide', !STORE_ROLES.includes(e.target.value)); drawPerms(e.target.value, [], []); }
    if (e.target.name === 'up') cnt();
  });
  $('[data-save]', m.el).addEventListener('click', async () => {
    const val = (n) => $(`[name="${n}"]`, m.el)?.value;
    const body = {
      name: val('name'), role: $('[name=role]:checked', m.el)?.value,
      ...diff(), stores: [...m.el.querySelectorAll('[name=st]:checked')].map((x) => Number(x.value)),
    };
    try {
      if (edit) {
        body.active = swVal(m.el, 'active');
        await api.put('/admin/users/' + u.id, body);
        m.close(); toast('اتحفظ'); onSaved();
      } else {
        body.username = val('username'); body.password = val('password');
        const r = await api.post('/admin/users', body);
        m.close(); onSaved();
        credsModal(r.user, body.password);
      }
    } catch (e) { showErrors(m.el, e); }
  });
}
function genPw() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => a[x % a.length]).join('');
}
function credsModal(u, pw) {
  modal({
    title: 'بيانات الدخول',
    body: html`<div class="creds"><div class="tick" style="width:56px;height:56px;margin:0 auto 8px;border-radius:50%;background:var(--ok);display:grid;place-items:center;color:#fff">${icon('check', 'lg')}</div>
      <p style="text-align:center;margin:0 0 12px;font-weight:700">إدّي البيانات دي لـ ${u.name}</p>
      <dl class="kv" style="background:var(--bg-2);padding:14px;border-radius:14px"><dt>اسم الدخول</dt><dd><span class="num">${u.username}</span></dd><dt>كلمة السر</dt><dd><span class="num">${pw}</span></dd></dl>
      <p class="muted" style="font-size:13px;font-weight:600;margin:10px 0 0">يقدر يغيّر كلمة السر بنفسه من زرار المفتاح جنب اسمه تحت القايمة.</p></div>`,
    foot: html`<button class="btn" data-close autofocus>تمام</button>`,
  });
}
function passwordModal(u) {
  const pw = genPw();
  const m = modal({
    title: `كلمة سر جديدة لـ ${u.name}`,
    body: html`<div class="field" data-f="password"><label>كلمة السر الجديدة</label><input class="input" name="password" value="${pw}" autofocus><div class="msg"></div></div>
      <div class="alertbar warn" style="margin-top:12px">${icon('alert')}<span>هيخرج من أي جهاز داخل عليه، ولازم يدخل بالكلمة الجديدة.</span></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-save>${icon('key')} غيّر كلمة السر</button>`,
  });
  $('[data-save]', m.el).addEventListener('click', async () => {
    const p = $('[name=password]', m.el).value;
    try { await api.post(`/admin/users/${u.id}/password`, { password: p }); m.close(); credsModal(u, p); } catch (e) { showErrors(m.el, e); }
  });
}

// ======================================================================
//                             سجل التعديلات
// ======================================================================
async function auditPane(pane) {
  let group = '';
  const G = [['', 'الكل'], ['money', 'الفلوس'], ['patients', 'المرضى والزيارات'], ['inpatient', 'الدخول والأسرّة'], ['settings', 'الإعدادات']];
  const IC = { money: ['receipt', 'var(--ok)'], patients: ['users', 'var(--radiology)'], inpatient: ['bed', '#7a3fb8'], settings: ['settings', 'var(--brand)'], other: ['info', 'var(--muted)'] };
  pane.innerHTML = String(html`<div class="pagehead"><div class="seg" id="ag">${G.map(([k, n]) => html`<button data-g="${k}" class="${k === group ? 'on' : ''}">${n}</button>`)}</div>
    <span class="muted" style="font-weight:600;font-size:13px">آخر 300 حركة · كل حاجة متسجلة باسم اللي عملها ووقتها</span></div><div id="al"></div>`);
  const load = async () => {
    $('#al', pane).innerHTML = String(html`<div class="skel" style="height:300px"></div>`);
    const r = await api.get('/admin/audit' + (group ? '?group=' + group : ''));
    $('#al', pane).innerHTML = r.entries.length ? String(html`<div class="card" style="padding:8px 14px"><div class="list">${r.entries.map((a) => html`
      <div class="li aud ${a.action === 'receipt.cancel' || a.action === 'service.price' ? 'hl' : ''}">
        <span class="dicon" style="--dc:${a.action === 'receipt.cancel' ? 'var(--danger)' : IC[a.group][1]};width:36px;height:36px;border-radius:11px">${icon(a.action === 'receipt.cancel' ? 'undo' : IC[a.group][0], 'sm')}</span>
        <div style="min-width:0"><b>${a.label}</b> <span class="muted" style="font-weight:700">${a.text}</span>${a.note ? html`<small>«${a.note}»</small>` : ''}</div>
        <small class="amt muted" style="font-weight:600;text-align:end;white-space:nowrap">${a.user}<br>${fmtWhen(a.at)}</small>
      </div>`)}</div></div>`) : String(html`<div class="card empty"><div class="art">${icon('history')}</div><b>لسه مفيش حركات</b></div>`);
  };
  pane.onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { group = b.dataset.g; $$('[data-g]', pane).forEach((x) => x.classList.toggle('on', x === b)); load(); } };
  await load();
  return () => { pane.onclick = null; };
}

// ================= أسعار الأدوار =================
async function floorPricesPane(pane) {
  const S = { dept: firstDept('ward'), q: '', d: null };
  const DN = { ward: 'إقامة', or: 'عمليات', lab: 'معمل', radiology: 'أشعة' };
  pane.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px;align-items:center">
      <div style="min-width:0;flex:1 1 300px"><b style="font-size:16px">${icon('layers')} نفس الخدمة ونفس الدرجة، وكل دور بسعره</b>
        <div class="muted" style="font-size:13px;font-weight:600">اكتب سعر الدور في خانته، والخانة الفاضية = السعر الأساسي. بيسري على الخدمات والزيارات والليالي اللي هتتكتب من دلوقتي، والأتعاب سعرها واحد في كل الأدوار.</div></div>
      <a class="btn ghost" href="/api/admin/floor-prices/export">${icon('download')} تصدير إكسل</a>
      <label class="btn ghost" style="cursor:pointer">${icon('upload')} استيراد من إكسل<input type="file" id="fpfile" accept=".xlsx" hidden></label>
    </div>
    <section class="card pad" style="margin-top:16px"><h3 style="margin:0 0 10px">${icon('bed')} سعر الليلة</h3><div id="fpc"></div></section>
    <section class="card pad" style="margin-top:16px">
      <div class="row wrap" style="gap:10px;margin-bottom:12px"><h3 style="margin:0">${icon('clipboard')} الخدمات والزيارات</h3>
        <div class="chips" id="fpd"></div>
        <div class="big-search" style="flex:1 1 200px;max-width:320px;margin-inline-start:auto">${icon('search')}<input class="input" id="fpq" type="search" placeholder="دوّر على خدمة" style="height:40px;padding-inline-start:40px;border-radius:12px"></div></div>
      <div id="fps"><div class="skel" style="height:200px"></div></div></section>`);
  const cell = (type, f, refId, base, val, dim = false) => {
    const v = val ?? '';
    const cls = val == null ? '' : base == null ? 'set' : val < base ? 'set lo' : val > base ? 'set hi' : 'set';
    return html`<td class="n fpc ${dim ? 'dim' : ''}"><input class="input num fpin ${cls}" data-t="${type}" data-f="${f.id}" data-r="${refId}" value="${v}" placeholder="${base == null ? '—' : money(base)}" inputmode="decimal" autocomplete="off" title="الدور ${f.no}"></td>`;
  };
  const drawClasses = () => {
    const d = S.d;
    $('#fpc', pane).innerHTML = String(html`<div class="table-wrap"><table class="table fptbl"><thead><tr><th>الدرجة</th><th class="n">الأساسي</th>${d.floors.map((f) => html`<th class="n">الدور <b class="num">${f.no}</b></th>`)}</tr></thead><tbody>
      ${d.classes.map((c) => html`<tr><td><b>${c.name}</b> <span class="muted" style="font-size:12px">${KIND[c.kind] || ''}</span></td><td class="n num muted">${c.base == null ? '—' : money(c.base)}</td>
        ${d.floors.map((f) => cell('class', f, c.id, c.base, d.classPrices[`${f.id}|${c.id}`], !d.usedClasses.includes(`${f.id}|${c.id}`)))}</tr>`)}</tbody></table></div>
      <div class="muted" style="font-size:12px;font-weight:600;margin-top:6px">الخانات الباهتة: الدرجة دي مالهاش غرف في الدور ده دلوقتي.</div>`);
  };
  const drawServices = () => {
    const d = S.d, q = searchKey(S.q);
    const list = d.services.filter((x) => (q ? searchKey(x.name + ' ' + x.code).includes(q) : x.dept === S.dept));
    $('#fpd', pane).innerHTML = String(html`${Object.entries(DN).map(([k, n]) => html`<button class="chip ${S.dept === k && !S.q ? 'on' : ''}" data-dp="${k}">${n} <span class="num muted">${d.services.filter((x) => x.dept === k).length}</span></button>`)}`);
    $('#fps', pane).innerHTML = String(html`<div class="table-wrap"><table class="table fptbl"><thead><tr><th>الخدمة</th><th class="n">الأساسي</th>${d.floors.map((f) => html`<th class="n">الدور <b class="num">${f.no}</b></th>`)}</tr></thead><tbody>
      ${list.map((x) => html`<tr><td><b>${x.name}</b> <span class="code num">${x.code}</span>${x.cat === 'visit' ? html` <span class="badge py">زيارة</span>` : ''}</td><td class="n num muted">${x.base == null ? '—' : money(x.base)}</td>
        ${d.floors.map((f) => cell('service', f, x.id, x.base, d.servicePrices[`${f.id}|${x.id}`]))}</tr>`)}
      ${!list.length ? html`<tr><td colspan="${d.floors.length + 2}"><div class="empty">مفيش خدمات هنا</div></td></tr>` : ''}</tbody></table></div>`);
  };
  const load = async () => { S.d = await api.get('/admin/floor-prices'); drawClasses(); drawServices(); };
  const save = async (inp) => {
    const v = inp.value.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632).trim();
    const key = `${inp.dataset.f}|${inp.dataset.r}`;
    const cur = (inp.dataset.t === 'class' ? S.d.classPrices : S.d.servicePrices)[key];
    if ((v === '' ? undefined : Number(v)) === cur) return;
    try {
      const r = await api.put('/admin/floor-prices', { type: inp.dataset.t, floorId: Number(inp.dataset.f), refId: Number(inp.dataset.r), price: v });
      S.d = r;
      const base = Number(inp.placeholder.replace(/,/g, '')) || null;
      const val = v === '' ? null : Number(v);
      inp.className = 'input num fpin ' + (val == null ? '' : base == null ? 'set' : val < base ? 'set lo' : val > base ? 'set hi' : 'set');
      inp.classList.add('saved'); setTimeout(() => inp.classList.remove('saved'), 900);
    } catch (e) { toastError(e); inp.value = cur ?? ''; }
  };
  pane.addEventListener('focusout', (e) => { if (e.target.classList?.contains('fpin')) save(e.target); });
  pane.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('fpin') || e.key !== 'Enter') return;
    e.preventDefault();
    // Enter ← الخانة اللي تحتها
    const td = e.target.closest('td'), tr = td.parentElement, i = [...tr.children].indexOf(td);
    const next = tr.nextElementSibling?.children[i]?.querySelector('input');
    if (next) { next.focus(); next.select(); } else e.target.blur();
  });
  pane.onclick = (e) => { const d = e.target.closest('[data-dp]'); if (d) { S.dept = d.dataset.dp; S.q = ''; $('#fpq', pane).value = ''; drawServices(); } };
  pane.oninput = debounce((e) => { if (e.target.id === 'fpq') { S.q = e.target.value; drawServices(); } }, 150);
  pane.onchange = async (e) => {
    if (e.target.id !== 'fpfile' || !e.target.files[0]) return;
    const file = e.target.files[0]; e.target.value = '';
    const send = (mode) => fetch('/api/admin/floor-prices/import' + (mode ? '?mode=' + mode : ''), { method: 'POST', body: file, credentials: 'same-origin' }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new ApiError(r.status, j); return j; });
    try {
      const pv = await send();
      const m = modal({
        title: 'استيراد أسعار الأدوار', wide: true,
        body: html`<div class="row wrap" style="gap:8px;margin-bottom:10px"><span class="badge warn">${pv.count} تغيير</span>${pv.errors.length ? html`<span class="badge danger">${pv.errors.length} خطأ</span>` : ''}</div>
          ${pv.errors.length ? html`<div class="alertbar danger" style="margin-bottom:10px">${icon('alert')}<span>${pv.errors.slice(0, 5).map((x) => `صف ${x.row}: ${x.msg}`).join(' · ')}</span></div>` : ''}
          <div class="table-wrap" style="max-height:50vh"><table class="table"><thead><tr><th>البند</th><th>الدور</th><th class="n">قبل</th><th class="n">بعد</th></tr></thead><tbody>
          ${pv.changes.map((c) => html`<tr><td>${c.name}</td><td class="num">${c.floorNo}</td><td class="n num muted">${c.old == null ? 'الأساسي' : money(c.old)}</td><td class="n num"><b>${c.now == null ? 'الأساسي' : money(c.now)}</b></td></tr>`)}</tbody></table></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok ${pv.errors.length || !pv.count ? 'disabled' : ''}>${icon('check')} نفّذ</button>`,
      });
      $('[data-ok]', m.el).addEventListener('click', async () => { try { const r = await send('apply'); m.close(); toast(`اتعدل ${r.applied} سعر`); load(); } catch (er) { toastError(er); } });
    } catch (er) { toastError(er); }
  };
  await load();
}

// ======================= إعدادات عامة (محرك الإعدادات) =======================
const TZS = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'UTC']; } })();

async function generalPane(pane) {
  pane.innerHTML = String(html`<div class="card pad muted">بيحمّل الإعدادات…</div>`);
  const [D, C] = await Promise.all([api.get('/config/settings'), api.get('/config/counters')]);
  const ctl = (it) => {
    const id = `s_${it.key}`;
    if (it.type === 'bool') return sw(it.key, it.value, it.label);
    const hint = it.hint ? html`<span class="hint">${it.hint}</span>` : '';
    let c;
    if (it.type === 'color') c = html`<div class="row" style="gap:10px"><input class="colorin" type="color" id="${id}" data-k="${it.key}" value="${it.value}"><input class="input num" dir="ltr" data-hex="${it.key}" value="${it.value}" maxlength="7" style="max-width:120px"></div>`;
    else if (it.type === 'select') c = html`<select class="select" id="${id}" data-k="${it.key}">${it.options.map(([v, n]) => html`<option value="${v}" ${v === it.value ? 'selected' : ''}>${n}</option>`)}</select>`;
    else if (it.type === 'tz') c = html`<select class="select" id="${id}" data-k="${it.key}">${(TZS.includes(it.value) ? TZS : [it.value, ...TZS]).map((z) => html`<option ${z === it.value ? 'selected' : ''}>${z}</option>`)}</select>`;
    else if (it.type === 'time') c = html`<input class="input num" type="time" id="${id}" data-k="${it.key}" value="${it.value}">`;
    else if (it.type === 'number') c = html`<input class="input num" type="number" id="${id}" data-k="${it.key}" value="${it.value}" min="${it.min ?? ''}" max="${it.max ?? ''}" step="${it.step ?? 1}">`;
    else c = html`<input class="input" id="${id}" data-k="${it.key}" value="${it.value}" maxlength="${it.max || 200}">`;
    return html`<div class="field ${it.type === 'text' ? 'c6' : 'c4'}" data-f="${it.key}"><label for="${id}">${it.label}</label>${c}${it.hint ? html`<div class="muted" style="font-size:12px">${it.hint}</div>` : ''}<div class="msg"></div></div>`;
  };
  const patientMatrix = () => {
    const I = (k) => D.items.find((i) => i.key === k);
    const CTX = [['Clinic', 'العيادات'], ['Er', 'الطوارئ'], ['Adm', 'الإقامة']];
    const FLD = [['Nid', 'الرقم القومي'], ['Phone', 'التليفون'], ['Age', 'السن أو تاريخ الميلاد'], ['Sex', 'النوع']];
    const cell = (F, C) => {
      if (C === 'Adm' && F === 'Phone') return html`<td><span class="badge">إجباري دايمًا</span></td>`;
      const it = I(`pf${F}${C}`); if (!it) return html`<td></td>`;
      return html`<td><select class="select sm" data-k="${it.key}">${it.options.map(([v, n]) => html`<option value="${v}" ${v === it.value ? 'selected' : ''}>${n}</option>`)}</select></td>`;
    };
    const w = (C) => { const it = I(`pfWords${C}`); return html`<td><select class="select sm" data-k="${it.key}">${it.options.map(([v, n]) => html`<option value="${v}" ${v === it.value ? 'selected' : ''}>${n}</option>`)}</select></td>`; };
    return html`<div style="overflow:auto"><table class="tbl"><thead><tr><th>الحقل</th>${CTX.map(([, n]) => html`<th>${n}</th>`)}</tr></thead><tbody>
      <tr><td><b>الاسم</b></td>${CTX.map(([C]) => w(C))}</tr>
      ${FLD.map(([F, n]) => html`<tr><td><b>${n}</b></td>${CTX.map(([C]) => cell(F, C))}</tr>`)}
      </tbody></table></div>`;
  };
  const groupCard = (g) => html`<section class="card pad gset" id="g_${g.key}">
      <h3>${icon(g.icon)} ${g.name} <span class="muted">${g.hint}</span></h3>
      ${g.key === 'identity' ? html`<div class="logobox"><img id="logoimg" src="${D.logo.url}" alt="">
        <div class="col" style="gap:8px"><b>لوجو المستشفى</b><span class="muted" style="font-size:12.5px">PNG أو JPG أو WEBP، لحد 1 ميجا. بيظهر في الشاشات والطباعة.</span>
          <div class="row" style="gap:8px"><label class="btn soft sm" style="cursor:pointer">${icon('upload', 'sm')} ارفع لوجو<input type="file" id="logofile" accept="image/png,image/jpeg,image/webp" hidden></label>
          <button class="btn ghost sm" id="logodel" ${D.logo.custom ? '' : 'hidden'}>${icon('undo', 'sm')} رجّع الافتراضي</button></div></div></div>` : ''}
      ${g.key === 'patient' ? patientMatrix() : html`<div class="fgrid">${D.items.filter((i) => i.group === g.key).map(ctl)}</div>`}
      ${g.key === 'identity' ? html`<div class="brandprev" id="prev"><span class="pb">زر أساسي</span><span class="ps">${icon('check', 'sm')} ناجح</span><span class="pc">لمسة مكمّلة</span><span class="pt">عنوان بلون المستشفى</span></div>` : ''}
    </section>`;
  const counterRows = C.counters.map((c) => html`<tr data-cn="${c.name}"><td><b>${c.label}</b></td><td class="n num">${c.last}</td>
      <td class="n" style="width:150px"><input class="input num sm" type="number" min="${c.last + 1}" value="${c.next}" data-next></td>
      <td class="n"><button class="btn soft sm" data-setcn>${icon('check', 'sm')} حدّد</button></td></tr>`);
  pane.innerHTML = String(html`<div class="gsetwrap">
    <nav class="gsnav card">${D.groups.map((g) => html`<a href="#g_${g.key}" data-gl="${g.key}">${icon(g.icon)}<span>${g.name}</span></a>`)}<a href="#g_counters" data-gl="counters">${icon('list')}<span>الترقيم</span></a></nav>
    <div class="col" style="gap:16px;min-width:0">
      ${D.groups.map(groupCard)}
      <section class="card pad gset" id="g_counters"><h3>${icon('list')} الترقيم <span class="muted">كل عدّاد بيكمّل من الرقم اللي تحدده (مفيد لو بتكمّل من برنامج قديم). مينفعش يرجع لورا.</span></h3>
        <div class="tablewrap"><table class="table"><thead><tr><th>العدّاد</th><th class="n">آخر رقم</th><th class="n">الرقم الجاي</th><th></th></tr></thead><tbody>${counterRows}</tbody></table></div></section>
      <div class="savebar card"><span class="muted">التغييرات بتتطبّق على كل الشاشات فورًا بعد الحفظ.</span><button class="btn lg" id="saveall">${icon('check')} احفظ الإعدادات</button></div>
    </div></div>`);
  bindSwitches(pane);
  $('.gsnav', pane)?.addEventListener('click', (e) => { // الروابط دي للتمرير جوه الصفحة بس، مش مسارات (التغيير في # كان بيرجّع الرئيسية)
    const a = e.target.closest('a[data-gl]'); if (!a) return;
    e.preventDefault();
    document.getElementById('g_' + a.dataset.gl)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const collect = () => {
    const v = {};
    $$('[data-k]', pane).forEach((x) => { v[x.dataset.k] = x.value; });
    $$('[data-sw]', pane).forEach((x) => { v[x.dataset.sw] = x.getAttribute('aria-checked') === 'true'; });
    return v;
  };
  const preview = () => {
    const v = collect();
    applyBrand({ name: v.hospitalName || '', sub: v.hospitalSub || '', primary: v.colorPrimary, accent: v.colorAccent, logo: state.brand.logo, footer: v.printFooter, tz: v.tz, dayStart: state.dayStart });
  };
  pane.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('input[type=color]')) { const h = $(`[data-hex="${t.dataset.k}"]`, pane); if (h) h.value = t.value; preview(); }
    if (t.matches('[data-hex]') && /^#[0-9a-fA-F]{6}$/.test(t.value)) { const c = $(`[data-k="${t.dataset.hex}"]`, pane); if (c) c.value = t.value.toLowerCase(); preview(); }
  });
  // بعد رفع اللوجو بنحدّث اللوجو بس، عشان معاينة الألوان اللي لسه ما اتحفظتش ما تضيعش
  const refreshLogo = async () => {
    state.brand.logo = (await api.get('/branding')).logo;
    const b = $('.rail .brand'); if (b) $('img', b).src = state.brand.logo;
    const fav = document.querySelector('link[rel=icon]'); if (fav) fav.setAttribute('href', state.brand.logo);
    $('#logoimg', pane).src = state.brand.logo;
  };
  const refreshBrand = async () => {
    applyBrand(await api.get('/branding'));
    const b = $('.rail .brand'); if (b) { $('img', b).src = state.brand.logo; $('b', b).textContent = state.brand.name; $('small', b).textContent = state.brand.sub; }
    document.title = 'الإعدادات | ' + state.brand.name;
  };
  $('#saveall', pane).addEventListener('click', async () => {
    try { await api.put('/config/settings', { values: collect() }); await refreshBrand(); toast('اتحفظت الإعدادات واتطبّقت'); } catch (er) { showErrors(pane, er); }
  });
  $('#logofile', pane).addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await fetch('/api/config/logo', { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
      const d = await r.json(); if (!r.ok) throw new ApiError(r.status, d);
      await refreshLogo(); $('#logodel', pane).hidden = false; toast('اتغيّر اللوجو');
    } catch (er) { toastError(er); }
  });
  $('#logodel', pane)?.addEventListener('click', async () => {
    try { await api.del('/config/logo'); await refreshLogo(); $('#logodel', pane).hidden = true; toast('رجع اللوجو الافتراضي'); } catch (er) { toastError(er); }
  });
  pane.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-setcn]'); if (!b) return;
    const tr = b.closest('tr');
    try {
      const r = await api.put(`/config/counters/${tr.dataset.cn}`, { next: Number($('[data-next]', tr).value) });
      r.counters.forEach((c) => { const row = $(`[data-cn="${c.name}"]`, pane); if (row) { $('.n.num', row).textContent = c.last; $('[data-next]', row).min = c.last + 1; $('[data-next]', row).value = c.next; } });
      toast('اتحدد الرقم الجاي');
    } catch (er) { toastError(er); }
  });
}

// ============ الأقسام والقوائم (قوائم مرجعية بيعدّلها المدير) ============
async function lookupsPane(pane) {
  let L = await api.get('/config/lookups');
  const apply = async (d) => { L = d; await refreshLookups(); draw(); };
  const chip = (it, D) => {
    const bn = D.behaviors?.find((b) => b.key === it.behavior)?.name;
    return html`<span class="lkchip" style="--c:${it.color}">${icon(it.icon || 'layers', 'sm')}</span>`;
  };
  const row = (it, D, i, n, dom) => html`<div class="lkrow ${it.active ? '' : 'off-row'}" data-id="${it.id}">
      ${chip(it, D)}
      <div class="lkmain"><b>${it.name}</b>
        <span class="muted">${D.behaviors ? (D.behaviors.find((b) => b.key === it.behavior)?.name || '') : ''}${it.meta?.prefix ? html` · كود <span class="num">${it.meta.prefix}</span>` : ''}${it.meta?.roomKind ? html` · غرفة ${(L.domains.room_kind.items.find((r) => r.code === it.meta.roomKind) || {}).name || ''}` : ''}${it.meta?.pay === 'after' ? ' · الدفع بعد الخدمة' : ''}${it.meta?.visit === false ? ' · من غير زيارة خارجية' : ''}</span></div>
      <span class="lkused num" title="عدد السجلات اللي بتستخدمه">${it.used ? it.used + ' سجل' : 'جديد'}</span>
      <div class="lkact">
        <button class="btn ghost icon sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="فوق">${icon('chev-left', 'sm')}</button>
        <button class="btn ghost icon sm" data-dn ${i === n - 1 ? 'disabled' : ''} aria-label="تحت">${icon('chev-right', 'sm')}</button>
        <button class="switch" role="switch" data-act aria-checked="${it.active ? 'true' : 'false'}" title="${it.active ? 'شغّال' : 'موقّف'}"></button>
        <button class="btn soft sm" data-edit>${icon('edit', 'sm')} تعديل</button>
        <button class="btn ghost icon sm danger" data-del ${it.used ? 'disabled title="عليه شغل، وقّفه بدل المسح"' : ''} aria-label="مسح">${icon('trash', 'sm')}</button>
      </div></div>`;
  function draw() {
    pane.innerHTML = String(html`<div class="col" style="gap:16px">
      <div class="alertbar info">${icon('info')}<span>كل قسم أو نوع هنا بيظهر في كل الشاشات لوحده (الخدمات، الزيارات، التقارير، الخزينة). القسم اللي عليه شغل بيتوقف بدل ما يتمسح.</span></div>
      ${Object.entries(L.domains).map(([dom, D]) => html`<section class="card pad gset" data-dom="${dom}">
        <h3>${icon(D.icon)} ${D.title} <span class="muted">${D.hint}</span></h3>
        <div class="lklist">${D.items.map((it, i) => row(it, D, i, D.items.length, dom))}</div>
        <div style="margin-top:12px"><button class="btn soft" data-add>${icon('plus')} ${D.single} جديد</button></div>
      </section>`)}
    </div>`);
    $$('[data-act]', pane).forEach((b) => b.classList.add('switch'));
  }
  const findItem = (id) => { for (const [dom, D] of Object.entries(L.domains)) { const it = D.items.find((x) => x.id === id); if (it) return { it, dom, D }; } };
  pane.addEventListener('click', async (e) => {
    const t = e.target;
    const sec = t.closest('[data-dom]'); if (!sec) return;
    const dom = sec.dataset.dom, D = L.domains[dom];
    if (t.closest('[data-add]')) return lookupModal(dom, null);
    const rowEl = t.closest('[data-id]'); if (!rowEl) return;
    const id = Number(rowEl.dataset.id), it = D.items.find((x) => x.id === id);
    try {
      if (t.closest('[data-edit]')) return lookupModal(dom, it);
      if (t.closest('[data-act]')) { await apply(await api.post(`/config/lookups/item/${id}/active`, { active: !it.active })); toast(it.active ? 'اتوقّف' : 'اشتغل'); return; }
      if (t.closest('[data-del]') && !it.used) {
        const m = modal({ title: 'مسح', body: html`<p>تمسح «${it.name}»؟ مفيش عليه أي شغل.</p>`, foot: html`<button class="btn ghost" data-close>لأ</button><button class="btn danger" data-ok>${icon('trash')} امسح</button>` });
        $('[data-ok]', m.el).addEventListener('click', async () => { try { await apply(await api.del(`/config/lookups/item/${id}`)); m.close(); toast('اتمسح'); } catch (er) { toastError(er); } });
        return;
      }
      const mv = t.closest('[data-up]') ? -1 : t.closest('[data-dn]') ? 1 : 0;
      if (mv) {
        const ids = D.items.map((x) => x.id), i = ids.indexOf(id);
        [ids[i], ids[i + mv]] = [ids[i + mv], ids[i]];
        await apply(await api.post(`/config/lookups/${dom}/order`, { ids }));
      }
    } catch (er) { toastError(er); }
  });
  function lookupModal(dom, it) {
    const D = L.domains[dom];
    const v = it || { name: '', short: '', color: '#0e8a87', icon: D.icon, behavior: D.behaviors?.[0]?.key, meta: { visit: true, pay: 'before', prefix: '', roomKind: L.domains.room_kind.items[0]?.code } };
    const palette = ['#0e8a87', '#2c6ddc', '#6c55d1', '#d4508f', '#e2474f', '#d0661c', '#c97505', '#2a9d8f', '#4f5bd5', '#5b6b7a'];
    const m = modal({
      title: it ? `تعديل «${it.name}»` : `${D.single} جديد`, wide: true,
      body: html`<div class="form-grid">
        <div class="field c4" data-f="name"><label>الاسم</label><input class="input" name="name" value="${v.name}" autofocus placeholder="مثلًا: علاج طبيعي"><div class="msg"></div></div>
        <div class="field c2" data-f="short"><label>اسم مختصر</label><input class="input" name="short" value="${it ? v.short : ''}" placeholder="اختياري"><div class="msg"></div></div>
        ${D.behaviors ? html`<div class="field c6" data-f="behavior"><label>بيشتغل إزاي؟ <span class="hint">بيحدد قايمة الشغل والتعامل</span></label>
          <div class="deptpick" data-seg="behavior" style="--dc:var(--brand)">${D.behaviors.map((b) => html`<button type="button" data-v="${b.key}" class="${v.behavior === b.key ? 'on' : ''}" title="${b.hint}"><b>${b.name}</b><small>${b.hint}</small></button>`)}</div><div class="msg"></div></div>` : ''}
        ${dom === 'dept' ? html`<div class="field c2" data-f="prefix"><label>بادئة كود الخدمة</label><input class="input num" dir="ltr" name="prefix" value="${v.meta.prefix || ''}" maxlength="4" placeholder="PT"><div class="msg"></div></div>
          <div class="field c2" data-f="pay"><label>الدفع</label><div class="seg full" data-seg="pay"><button type="button" data-v="before" class="${(v.meta.pay || 'before') === 'before' ? 'on' : ''}">قبل الخدمة</button><button type="button" data-v="after" class="${v.meta.pay === 'after' ? 'on' : ''}">بعد الخدمة</button></div></div>
          <div class="field c2" style="justify-content:flex-end;padding-bottom:4px">${sw('visit', v.meta.visit !== false, 'تظهر كزيارة خارجية')}</div>` : ''}
        ${dom === 'admission_type' ? html`<div class="field c6" data-f="roomKind"><label>نوع الغرفة المناسب</label><div class="seg full" data-seg="roomKind">${L.domains.room_kind.items.filter((r) => r.active).map((r) => html`<button type="button" data-v="${r.code}" class="${v.meta.roomKind === r.code ? 'on' : ''}">${r.name}</button>`)}</div><div class="msg"></div></div>` : ''}
        <div class="field c3" data-f="color"><label>اللون</label><div class="row" style="gap:8px;flex-wrap:wrap" id="pal">${palette.map((c) => html`<button type="button" class="swatch ${v.color === c ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`)}<input class="colorin" type="color" name="color" value="${v.color}"></div><div class="msg"></div></div>
        <div class="field c3" data-f="icon"><label>الأيقونة</label><div class="iconpick" id="icp">${L.icons.map((ic) => html`<button type="button" data-i="${ic}" class="${v.icon === ic ? 'on' : ''}" aria-label="${ic}">${icon(ic)}</button>`)}</div><div class="msg"></div></div>
      </div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    bindSwitches(m.el); bindSegs(m.el);
    let ic = v.icon;
    $('#pal', m.el).addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; $('[name=color]', m.el).value = b.dataset.c; $$('#pal .swatch', m.el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('#icp', m.el).addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; ic = b.dataset.i; $$('#icp button', m.el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      const g = (n) => $(`[name=${n}]`, m.el)?.value;
      const body = { name: g('name'), short: g('short') || undefined, color: g('color'), icon: ic };
      if (D.behaviors) body.behavior = segVal(m.el, 'behavior');
      if (dom === 'dept') { body.prefix = g('prefix'); body.pay = segVal(m.el, 'pay'); body.visit = swVal(m.el, 'visit'); }
      if (dom === 'admission_type') body.roomKind = segVal(m.el, 'roomKind');
      try { await apply(it ? await api.put(`/config/lookups/item/${it.id}`, body) : await api.post(`/config/lookups/${dom}`, body)); m.close(); toast(it ? 'اتحفظ' : `اتضاف ${D.single} جديد، وهيظهر في كل الشاشات`); } catch (er) { showErrors(m.el, er); }
    });
  }
  draw();
}
