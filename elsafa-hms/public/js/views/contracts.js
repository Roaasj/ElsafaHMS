// التعاقدات: الجهات، المراجعة (الموافقات)، كشف حساب الجهات، ومحرر الجهة للمدير
import {
  api, html, icon, el, $, $$, money, egp, fmtWhen, ago, initials, DEPT, SVC_KEYS, COVER_KEYS, AP_ST, modal, toast, toastError,
  askReason, can, debounce, ApiError, uploadApprovalImage,
} from '../core.js';
import { searchKey } from '/shared/text.js';

const TABS = [['approvals', 'المراجعة', 'shield'], ['payers', 'الجهات', 'users'], ['pricelists', 'قوائم الأسعار', 'tag'], ['statement', 'كشف حساب جهة', 'receipt']];
const PRICE_MODE = { cash: 'أسعار المستشفى', list: 'أسعار خاصة', discount: 'خصم %' };
const DSHORT = { clinic: 'كشف', emergency: 'طوارئ', lab: 'معمل', radiology: 'أشعة', ward: 'إقامة', or: 'عمليات', drugs: 'أدوية', supplies: 'مستلزمات' };

/** تأكيد مسح (نهائي) */
function confirmDelete(title, note) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title, body: html`<div class="alertbar warn">${icon('alert')}<span>${note}</span></div>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--danger)">${icon('trash', 'sm')} امسح نهائي</button>`,
      onClose: () => { if (!done) resolve(false); } });
    $('[data-ok]', m.el).addEventListener('click', () => { done = true; m.close(); resolve(true); });
  });
}

export async function renderContracts(view, { query, setTitle }) {
  const tab = TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'approvals';
  setTitle('التعاقدات', { approvals: 'الموافقات اللي مستنية المراجعة والنقدي المؤقت', payers: 'جهات التعاقد ومستويات الكارنيه', statement: 'نصيب الجهة: أساس المطالبة الشهرية', pricelists: 'قوايم أسعار مشتركة بين أكتر من جهة' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">${TABS.map(([k, n, ic]) => html`<a href="#/contracts?tab=${k}" class="stab ${k === tab ? 'on' : ''}">${icon(ic)}<span>${n}</span><b class="badge hide" data-cnt="${k}"></b></a>`)}</nav><div id="cp"></div>`);
  const pane = $('#cp', view);
  api.get('/approvals?status=open').then((r) => {
    const n = (r.counts.pending || 0) + (r.counts.tempcash || 0);
    const b = $('[data-cnt=approvals]', view);
    if (b && n) { b.textContent = n; b.classList.remove('hide'); }
  }).catch(() => {});
  return { approvals: approvalsPane, payers: payersPane, pricelists: priceListsPane, statement: statementPane }[tab](pane, query);
}

// ================= المراجعة =================
async function approvalsPane(pane, query) {
  const S = { status: query.get('status') || 'open', q: '' };
  pane.innerHTML = String(html`<div class="pagehead">
      <div class="seg" id="st">${[['open', 'مستنية'], ['approved', 'اتعتمدت'], ['rejected', 'اترفضت'], ['all', 'الكل']].map(([k, n]) => html`<button data-s="${k}" class="${S.status === k ? 'on' : ''}">${n}</button>`)}</div>
      <div class="big-search" style="flex:1 1 240px;max-width:380px">${icon('search')}<input class="input" id="aq" type="search" placeholder="مريض، جهة، رقم موافقة" style="height:42px;font-size:14.5px;padding-inline-start:42px;border-radius:12px"></div>
      <div class="totbar" id="atot" style="margin-inline-start:auto"></div></div>
    ${!can('approvals.review') ? html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>الاعتماد والرفض لقسم المراجعة. تقدر تسجّل رقم الموافقة وصورتها لما توصل.</span></div>` : ''}
    <div id="al"><div class="skel" style="height:280px"></div></div>`);
  let data = [];
  const draw = () => {
    const q = searchKey(S.q);
    const list = data.filter((a) => !q || searchKey(`${a.patient.name} ${a.payer.name} ${a.no || ''} ${a.service}`).includes(q));
    $('#al', pane).innerHTML = list.length ? String(html`<div class="apgrid">${list.map((a) => html`
      <article class="card apcard st-${a.status}">
        <div class="row" style="gap:10px">
          <span class="pavatar" style="width:40px;height:40px;border-radius:12px;font-size:14px">${initials(a.patient.name)}</span>
          <div style="min-width:0"><b>${a.patient.name}</b><div class="muted" style="font-size:12.5px;font-weight:700"><span class="num">#${a.patient.no}</span>${a.cardNo ? html` · كارنيه <span class="num">${a.cardNo}</span>` : ''}</div></div>
          <span class="badge ${AP_ST[a.status]?.cls || ''}" style="margin-inline-start:auto">${AP_ST[a.status]?.name || a.status}</span>
        </div>
        <div class="apbody">
          <div><small>الجهة</small><b>${a.payer.name}</b></div>
          <div><small>${a.scope === 'admission' ? 'الدخول' : 'الخدمة'}</small><b>${a.service}</b></div>
          ${a.scope === 'item' ? html`<div><small>القيمة / نصيب الشركة</small><b><span class="num">${money(a.full)}</span> / <span class="num" style="color:var(--brand)">${money(a.amount)}</span> ${HMS.money.symbol}</b></div>` : html`<div><small>النوع</small><b>موافقة دخول</b></div>`}
          <div><small>رقم الموافقة</small><b class="num">${a.no || html`<span class="muted">لسه</span>`}</b></div>
        </div>
        <div class="muted" style="font-size:12px;font-weight:700">${a.createdBy} · ${ago(a.createdAt)}${a.note ? ' · ' + a.note : ''}</div>
        ${a.reviewedAt ? html`<div class="apnote ${a.status}">${a.status === 'approved' ? icon('check', 'sm') : icon('x', 'sm')} ${a.reviewedBy} · ${fmtWhen(a.reviewedAt)}${a.reviewNote ? ' · ' + a.reviewNote : ''}</div>` : ''}
        <div class="apacts">
          ${a.visitId ? html`<a class="btn ghost sm" href="#/visit/${a.visitId}">${icon('clipboard', 'sm')} زيارة <span class="num">${a.visitNo}</span></a>` : a.admissionId ? html`<a class="btn ghost sm" href="#/admission/${a.admissionId}">${icon('bed', 'sm')} دخول <span class="num">${a.admissionNo}</span></a>` : ''}
          ${a.hasImage ? html`<button class="btn ghost sm" data-img="${a.id}">${icon('sheet', 'sm')} الصورة</button>` : ''}
          ${['pending', 'tempcash'].includes(a.status) ? html`
            <label class="btn ghost sm" style="cursor:pointer">${icon('upload', 'sm')} ${a.hasImage ? 'غيّر الصورة' : 'ارفع صورة'}<input type="file" accept="image/*,application/pdf" data-up="${a.id}" hidden></label>
            ${!a.no ? html`<button class="btn ghost sm" data-info="${a.id}">${icon('edit', 'sm')} رقم الموافقة</button>` : ''}` : ''}
        </div>
        ${['pending', 'tempcash'].includes(a.status) && can('approvals.review') ? html`<div class="apdec">
          <button class="btn soft" data-rej="${a.id}" style="--c:var(--danger)">${icon('x', 'sm')} رفض</button>
          <button class="btn" data-ok="${a.id}" style="--c:var(--ok)">${icon('check', 'sm')} اعتماد</button></div>` : ''}
      </article>`)}</div>`)
      : String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${S.status === 'open' ? 'مفيش موافقات مستنية' : 'مفيش حاجة هنا'}</b></div>`);
  };
  const load = async () => {
    const r = await api.get('/approvals?status=' + S.status);
    data = r.approvals;
    $('#atot', pane).innerHTML = String(html`<div class="tot"><small>مستني المراجعة</small><b class="num" style="color:var(--warn)">${r.counts.pending || 0}</b></div>
      <div class="tot"><small>نقدي مؤقت</small><b class="num">${r.counts.tempcash || 0}</b></div>`);
    draw();
  };
  $('#aq', pane).addEventListener('input', debounce((e) => { S.q = e.target.value; draw(); }, 150));
  pane.onclick = async (e) => {
    const s = e.target.closest('[data-s]');
    if (s) { S.status = s.dataset.s; $$('[data-s]', pane).forEach((b) => b.classList.toggle('on', b === s)); return load(); }
    const im = e.target.closest('[data-img]');
    if (im) return modal({ title: 'صورة الموافقة', wide: true, body: html`<img src="/api/approvals/${im.dataset.img}/image" alt="" style="max-width:100%;border-radius:12px;display:block;margin:auto">` });
    const ok = e.target.closest('[data-ok]');
    if (ok) {
      const a = data.find((x) => x.id === Number(ok.dataset.ok));
      const m = modal({
        title: 'اعتماد الموافقة',
        body: html`<div class="alertbar info" style="margin-bottom:12px">${icon('info')}<span>${a.status === 'tempcash' ? `المريض دفع الخدمة كلها. بعد الاعتماد هيبقى له مرتجع ${money(a.amount)} ${HMS.money.unitWord} يصرفه من الاستقبال.` : a.scope === 'admission' ? 'الحساب هيفضل على التعاقد.' : `نصيب الشركة (${money(a.amount)} ${HMS.money.symbol}) هيتسجل على حسابها.`}</span></div>
          <div class="grid" style="gap:10px"><div class="field" data-f="no"><label>رقم الموافقة ${a.status === 'tempcash' && !a.no ? html`<span class="req">*</span>` : ''}</label><input class="input num" name="no" value="${a.no || ''}" style="text-align:left" autofocus><div class="msg"></div></div>
          <div class="field"><label>ملاحظة <span class="hint">اختياري</span></label><input class="input" name="note"></div></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go style="--c:var(--ok)">${icon('check')} اعتمد</button>`,
      });
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { await api.post(`/approvals/${a.id}/approve`, { no: $('[name=no]', m.el).value, note: $('[name=note]', m.el).value }); m.close(); toast('اتعتمدت الموافقة'); load(); window.refreshShell?.(); }
        catch (er) { if (er.data?.errors?.no) { $('[data-f=no]', m.el).classList.add('err'); $('[data-f=no] .msg', m.el).textContent = er.data.errors.no; } else toastError(er); }
      });
      return;
    }
    const rj = e.target.closest('[data-rej]');
    if (rj) {
      const a = data.find((x) => x.id === Number(rj.dataset.rej));
      const note = await askReason({ title: 'رفض الموافقة', label: 'سبب الرفض', confirm: 'ارفض', note: a.scope === 'admission' ? 'حساب الدخول كله هيتحول نقدي على المريض.' : a.status === 'tempcash' ? 'المريض دافع كله، ومفيش حاجة هتتغير عليه.' : `نصيب الشركة (${money(a.amount)} ${HMS.money.symbol}) هيتحول على المريض.` });
      if (!note) return;
      try { await api.post(`/approvals/${a.id}/reject`, { note }); toast('اترفضت الموافقة', 'info'); load(); window.refreshShell?.(); } catch (er) { toastError(er); }
      return;
    }
    const inf = e.target.closest('[data-info]');
    if (inf) {
      const m = modal({ title: 'رقم الموافقة', body: html`<div class="form-grid"><div class="field c3" data-f="no"><label>الرقم</label><input class="input num" name="no" autofocus style="text-align:left"><div class="msg"></div></div><div class="field c3"><label>التاريخ</label><input class="input" type="date" name="date"></div></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go>${icon('check')} احفظ</button>` });
      $('[data-go]', m.el).addEventListener('click', async () => {
        try { await api.post(`/approvals/${inf.dataset.info}/info`, { no: $('[name=no]', m.el).value, date: $('[name=date]', m.el).value }); m.close(); toast('اتسجل الرقم'); load(); } catch (er) { toastError(er); }
      });
    }
  };
  pane.onchange = async (e) => {
    const up = e.target.closest('[data-up]');
    if (up && up.files[0]) { try { await uploadApprovalImage(up.dataset.up, up.files[0]); toast('اترفعت الصورة'); load(); } catch (er) { toastError(er); } }
  };
  await load();
  return () => { pane.onclick = pane.onchange = null; };
}

// ================= الجهات =================
async function payersPane(pane) {
  const list = (await api.get('/payers')).payers;
  pane.innerHTML = String(html`<div class="pagehead"><span class="muted" style="font-weight:700">${list.length} جهة</span><span class="spacer"></span>
      ${can('payers.manage') ? html`<a class="btn" href="#/payer/new">${icon('plus')} جهة جديدة</a>` : ''}</div>
    ${list.length ? html`<div class="pygrid">${list.map((p) => html`<article class="card pycard ${p.valid ? '' : 'off'}">
      <div class="row" style="gap:10px"><span class="pic">${icon('shield')}</span><div style="min-width:0"><b class="pn">${p.name}</b><div class="muted" style="font-size:12.5px;font-weight:700">${p.kind || 'جهة'} · ${PRICE_MODE[p.priceMode]}${p.priceMode === 'discount' ? ` ${p.discountPct}%` : ''}</div></div>
        ${p.valid ? (p.expiresSoon ? html`<span class="badge warn" style="margin-inline-start:auto">بينتهي ${p.validTo}</span>` : html`<span class="badge ok dot" style="margin-inline-start:auto">ساري</span>`) : html`<span class="badge danger" style="margin-inline-start:auto">${p.active ? 'منتهي' : 'موقوف'}</span>`}</div>
      <div class="tiergrid">${p.tiers.filter((t) => t.active).map((t) => html`<div class="tierrow"><b>${t.name}</b><div class="covs">${COVER_KEYS.map((d) => html`<span class="cov ${t.coverage[d] == null || t.coverage[d] === 0 ? 'z' : t.coverage[d] === 100 ? 'f' : ''}" title="${DEPT[d]?.name || DSHORT[d] || d}">${DSHORT[d]} <b class="num">${t.coverage[d] ?? 0}%</b></span>`)}</div></div>`)}</div>
      <div class="muted" style="font-size:12.5px;font-weight:600">${p.validFrom || p.validTo ? html`${icon('calendar', 'sm')} ${p.validFrom || '…'} ← ${p.validTo || 'مفتوح'}` : 'من غير تاريخ انتهاء'}${p.visitCap ? html` · حد الزيارة <span class="num">${money(p.visitCap)}</span>` : ''}${p.yearCap ? html` · حد السنة <span class="num">${money(p.yearCap)}</span>` : ''}</div>
      <div class="row" style="gap:6px;margin-top:auto"><a class="btn ghost sm" href="#/contracts?tab=statement&payer=${p.id}">${icon('receipt', 'sm')} كشف الحساب</a>
        ${can('payers.manage') ? html`<a class="btn ghost sm" href="#/payer/${p.id}" style="margin-inline-start:auto">${icon('edit', 'sm')} تعديل</a>` : ''}</div>
    </article>`)}</div>` : html`<div class="card empty"><div class="art">${icon('shield')}</div><b>لسه مفيش جهات تعاقد</b>${can('payers.manage') ? 'دوس «جهة جديدة»' : ''}</div>`}`);
}

// ================= قوائم الأسعار المستقلة =================
async function priceListsPane(pane) {
  const [pl, pr] = await Promise.all([api.get('/payers/price-lists'), api.get('/payers')]);
  const own = pr.payers.filter((p) => p.priceMode === 'list' && !p.priceListId);
  pane.innerHTML = String(html`<div class="pagehead"><span class="muted" style="font-weight:700">${pl.lists.length} قايمة</span><span class="spacer"></span>
      ${can('payers.manage') && own.length ? html`<button class="btn ghost" id="cv">${icon('sheet', 'sm')} حوّل أسعار جهة لقايمة</button>` : ''}
      ${can('payers.manage') ? html`<a class="btn" href="#/pricelist/new">${icon('plus')} قايمة جديدة</a>` : ''}</div>
    ${pl.lists.length ? html`<div class="pygrid">${pl.lists.map((l) => html`<article class="card pycard ${l.active ? '' : 'off'}">
      <div class="row" style="gap:10px"><span class="pic">${icon('tag')}</span><div style="min-width:0"><b class="pn">${l.name}</b><div class="muted" style="font-size:12.5px;font-weight:700">${l.items} خدمة بسعر خاص</div></div>${l.active ? '' : html`<span class="badge" style="margin-inline-start:auto">موقوفة</span>`}</div>
      <div class="muted" style="font-size:13px;font-weight:600">${l.payers.length ? html`الجهات: ${l.payers.map((p) => p.name).join('، ')}` : 'مفيش جهات مربوطة بيها لسه'}</div>
      <div class="row" style="gap:6px;margin-top:auto">${can('payers.manage') ? html`<a class="btn ghost sm" href="#/pricelist/${l.id}">${icon('edit', 'sm')} تعديل</a>` : ''}
        ${can('payers.delete') && !l.payers.length ? html`<button class="btn ghost sm" data-del="${l.id}" style="margin-inline-start:auto;color:var(--danger)">${icon('trash', 'sm')} امسح</button>` : ''}</div>
    </article>`)}</div>` : html`<div class="card empty"><div class="art">${icon('tag')}</div><b>لسه مفيش قوايم أسعار</b>قايمة واحدة تربط بيها أكتر من جهة، وتعديلها بيسري على كلهم</div>`}`);
  pane.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { if (!await confirmDelete('مسح القايمة', 'القايمة هتتمسح نهائي.')) return; try { await api.del('/payers/price-lists/' + d.dataset.del); toast('اتمسحت القايمة'); priceListsPane(pane); } catch (er) { toastError(er); } return; }
    if (e.target.closest('#cv')) {
      const m = modal({ title: 'تحويل أسعار جهة لقايمة', body: html`<div class="grid" style="gap:12px"><div class="field"><label>الجهة</label><select class="select" name="p">${own.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
        <div class="field" data-f="name"><label>اسم القايمة</label><input class="input" name="n" placeholder="مثلًا: لائحة التأمين 2026"><div class="msg"></div></div>
        <div class="alertbar info">${icon('info')}<span>الأسعار بتتنقل بنفس الأرقام بالظبط، والجهة بتتربط بالقايمة.</span></div></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} حوّل</button>` });
      $('[data-ok]', m.el).addEventListener('click', async () => {
        try { const pid = $('[name=p]', m.el).value; await api.post(`/payers/${pid}/convert-to-list`, { name: $('[name=n]', m.el).value || undefined }); m.close(); toast('اتحولت الأسعار لقايمة'); priceListsPane(pane); }
        catch (er) { if (er instanceof ApiError && er.data.errors?.name) { $('[data-f=name]', m.el).classList.add('err'); $('[data-f=name] .msg', m.el).textContent = er.data.errors.name; } else toastError(er); }
      });
    }
  };
}

// محرر قايمة الأسعار
export async function renderPriceListEdit(view, { params, setTitle }) {
  const isNew = params[0] === 'new';
  const [ed, det, pr, pl] = await Promise.all([api.get('/payers/editor-data'), isNew ? Promise.resolve(null) : api.get('/payers/price-lists/' + params[0]), api.get('/payers'), api.get('/payers/price-lists')]);
  const L = det?.list || { name: '', active: true, payers: [] };
  const prices = new Map((det?.prices || []).map((x) => [x.serviceId, x.price]));
  const classPrices = new Map((det?.classPrices || []).map((x) => [x.classId, x.price]));
  let q = '', dept = 'all';
  setTitle(isNew ? 'قايمة أسعار جديدة' : L.name, 'الأسعار هنا بتسري على كل الجهات المربوطة بالقايمة');
  view.innerHTML = String(html`<div class="grid" style="gap:16px">
    <section class="card pad"><h3>${icon('tag')} القايمة</h3><div class="form-grid">
      <div class="field c3" data-f="name"><label>الاسم <span class="req">*</span></label><input class="input" name="name" value="${L.name}" placeholder="لائحة التأمين 2026"><div class="msg"></div></div>
      <div class="field c1" style="justify-content:flex-end;padding-bottom:8px"><label class="swl"><button type="button" class="switch" role="switch" data-sw="active" aria-checked="${L.active ? 'true' : 'false'}"></button><span>شغالة</span></label></div>
      <div class="field c2"><label>الجهات المربوطة</label><div class="muted" style="font-weight:600;padding-top:8px">${L.payers.length ? L.payers.map((p) => p.name).join('، ') : 'مفيش'}</div></div>
    </div>
    <div class="row wrap" style="gap:8px;margin-top:12px;padding:10px;border:1px dashed var(--line);border-radius:12px;background:var(--brand-soft)"><b style="font-size:13px">املا الأسعار من:</b>
      <select class="select" id="src" style="max-width:260px"><option value="">اختار…</option><option value="h">أسعار المستشفى</option>${pr.payers.filter((p) => p.priceMode === 'list').map((p) => html`<option value="p${p.id}">جهة: ${p.name}</option>`)}${pl.lists.filter((l) => String(l.id) !== params[0]).map((l) => html`<option value="l${l.id}">قايمة: ${l.name}</option>`)}</select>
      <button type="button" class="btn ghost sm" id="srcgo">${icon('sheet', 'sm')} انسخ</button><span class="muted" id="cnt" style="font-size:12.5px;font-weight:700"></span></div></section>
    <section class="card pad"><h3>${icon('tag')} الأسعار <span class="muted" style="font-size:12.5px">الفاضي = سعر المستشفى</span></h3>
      <div class="row wrap" style="gap:10px;margin-bottom:10px"><div class="dtabs" id="sdt"></div><div class="big-search" style="flex:1 1 200px;max-width:320px">${icon('search')}<input class="input" id="sq" placeholder="دوّر" style="height:40px;font-size:14px;padding-inline-start:40px;border-radius:12px"></div></div>
      <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table"><thead><tr><th>الخدمة</th><th>القسم</th><th class="n">سعر المستشفى</th><th class="n">سعر القايمة</th></tr></thead><tbody id="svcs"></tbody></table></div>
      <h4 class="subh">${icon('bed', 'sm')} سعر الليلة</h4><div class="row wrap" style="gap:10px">${ed.classes.filter((c) => c.active).map((c) => html`<div class="field" style="width:150px"><label>${c.name} <span class="hint num">${c.nightPrice ?? '—'}</span></label><input class="input num" data-cp="${c.id}" value="${classPrices.get(c.id) ?? ''}" placeholder="${c.nightPrice ?? ''}"></div>`)}</div>
    </section>
    <div class="savebar"><a class="btn ghost" href="#/contracts?tab=pricelists">رجوع</a><span class="spacer"></span><button class="btn" id="save">${icon('check')} احفظ القايمة</button></div></div>`);
  const draw = () => {
    const keys = ['all', ...new Set(ed.services.map((s) => s.dept))];
    $('#sdt', view).innerHTML = String(html`${keys.map((k) => html`<button class="dtab ${k === 'all' ? '' : 'd-' + k} ${dept === k ? 'on' : ''}" data-dt="${k}" ${k === 'all' ? 'style="--dc:var(--ink)"' : ''}>${k === 'all' ? 'الكل' : DSHORT[k] || k}</button>`)}`);
    const k = searchKey(q);
    const list = ed.services.filter((s) => (dept === 'all' || s.dept === dept) && (!k || searchKey(s.name + ' ' + s.code).includes(k)));
    $('#svcs', view).innerHTML = String(html`${list.map((s) => html`<tr><td><b>${s.name}</b> <span class="code num">${s.code}</span></td><td><span class="dtag d-${s.dept}">${DSHORT[s.dept] || s.dept}</span></td><td class="n nw">${egp(s.price)}</td><td class="n"><input class="input num" data-pr="${s.id}" value="${prices.get(s.id) ?? ''}" placeholder="${s.price}" style="width:100px"></td></tr>`)}`);
    $('#cnt', view).textContent = `${prices.size} سعر في القايمة`;
  };
  draw();
  view.oninput = (e) => {
    const t = e.target;
    if (t.dataset.pr) { if (t.value === '') prices.delete(Number(t.dataset.pr)); else prices.set(Number(t.dataset.pr), t.value); $('#cnt', view).textContent = `${prices.size} سعر في القايمة`; }
    if (t.dataset.cp) { if (t.value === '') classPrices.delete(Number(t.dataset.cp)); else classPrices.set(Number(t.dataset.cp), t.value); }
    if (t.id === 'sq') { q = t.value; draw(); $('#sq', view).focus(); }
  };
  view.onclick = async (e) => {
    const dt = e.target.closest('[data-dt]');
    if (dt) { dept = dt.dataset.dt; draw(); return; }
    const sw = e.target.closest('[data-sw]');
    if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    if (e.target.closest('#srcgo')) {
      const v = $('#src', view).value;
      if (!v) { toast('اختار المصدر', 'err'); return; }
      if (prices.size && !await confirmDelete('استبدال الأسعار الحالية؟', `في ${prices.size} سعر مكتوب هنا هيتبدل.`)) return;
      try {
        prices.clear(); classPrices.clear();
        if (v === 'h') { for (const c of ed.classes) if (c.nightPrice != null) classPrices.set(c.id, c.nightPrice); for (const s of ed.services) if (s.price != null) prices.set(s.id, s.price); }
        else { const d = v[0] === 'p' ? await api.get('/payers/' + v.slice(1)) : await api.get('/payers/price-lists/' + v.slice(1));
          let pl2 = d; if (v[0] === 'p' && d.payer.priceListId) pl2 = await api.get('/payers/price-lists/' + d.payer.priceListId);
          for (const x of pl2.prices) prices.set(x.serviceId, x.price); for (const x of pl2.classPrices) classPrices.set(x.classId, x.price); }
        $$('[data-cp]', view).forEach((i) => { i.value = classPrices.get(Number(i.dataset.cp)) ?? ''; });
        draw(); toast('اتنسخت الأسعار. دوس «احفظ القايمة» عشان تتحفظ');
      } catch (er) { toastError(er); }
      return;
    }
    if (e.target.closest('#save')) {
      $$('.field', view).forEach((f) => { f.classList.remove('err'); const m = $('.msg', f); if (m) m.textContent = ''; });
      const body = { name: $('[name=name]', view).value, active: $('[data-sw=active]', view).getAttribute('aria-checked') === 'true', prices: [...prices].map(([serviceId, price]) => ({ serviceId, price })), classPrices: [...classPrices].map(([classId, price]) => ({ classId, price })) };
      try { if (isNew) await api.post('/payers/price-lists', body); else await api.put('/payers/price-lists/' + params[0], body); toast('اتحفظت القايمة'); window.go('/contracts?tab=pricelists'); }
      catch (er) { if (er instanceof ApiError && er.data.errors) { for (const [f, msg] of Object.entries(er.data.errors)) { const b = $(`[data-f="${f}"]`, view); if (b) { b.classList.add('err'); $('.msg', b).textContent = msg; } } } else toastError(er); }
    }
  };
  return () => { view.oninput = view.onclick = null; };
}

// ================= كشف الحساب =================
async function statementPane(pane, query) {
  const payers = (await api.get('/payers')).payers;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
  const S = { payer: Number(query.get('payer')) || payers[0]?.id, from: today.slice(0, 8) + '01', to: today };
  pane.innerHTML = String(html`<div class="card pad row wrap" style="gap:10px;margin-bottom:14px">
      <select class="select" id="sp" style="flex:1 1 220px;max-width:320px">${payers.map((p) => html`<option value="${p.id}" ${p.id === S.payer ? 'selected' : ''}>${p.name}</option>`)}</select>
      <label class="row" style="gap:6px;font-weight:700">من <input class="input" type="date" id="sf" value="${S.from}" style="width:auto"></label>
      <label class="row" style="gap:6px;font-weight:700">لـ <input class="input" type="date" id="st2" value="${S.to}" style="width:auto"></label>
      <span class="spacer"></span><button class="btn ghost" id="xl">${icon('download')} إكسل</button></div>
    <div id="sr"><div class="skel" style="height:240px"></div></div>`);
  const load = async () => {
    if (!S.payer) { $('#sr', pane).innerHTML = String(html`<div class="card empty">مفيش جهات</div>`); return; }
    const r = await api.get(`/payers/${S.payer}/statement?from=${S.from}&to=${S.to}`);
    $('#sr', pane).innerHTML = String(html`<div class="totbar" style="margin-bottom:12px">
        <div class="tot" style="background:linear-gradient(135deg,#fff,var(--brand-soft))"><small>المطلوب من ${r.payer.name}</small><b>${egp(r.totals.amount)}</b></div>
        <div class="tot"><small>عدد المرضى</small><b class="num">${r.totals.patients}</b></div><div class="tot"><small>عدد البنود</small><b class="num">${r.totals.lines}</b></div></div>
      ${r.rows.length ? html`<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>التاريخ</th><th>المريض</th><th class="hide-sm">الكارنيه</th><th>البيان</th><th class="hide-sm">الموافقة</th><th class="n">القيمة الكلية</th><th class="n">نصيب الجهة</th></tr></thead>
        <tbody>${r.rows.map((x) => html`<tr class="${x.reversal ? 'refund' : ''}"><td style="white-space:nowrap">${fmtWhen(x.at)}</td><td><b>${x.patient.name}</b><div class="muted num" style="font-size:12px">#${x.patient.no}</div></td>
          <td class="hide-sm num">${x.cardNo || '—'}</td><td>${x.description}</td><td class="hide-sm num">${x.approvalNo || ''}</td><td class="n">${egp(x.full)}</td><td class="n"><b>${egp(x.amount)}</b></td></tr>`)}</tbody></table></div></div>`
      : html`<div class="card empty"><div class="art">${icon('receipt')}</div><b>مفيش حركات في الفترة دي</b></div>`}`);
  };
  pane.onchange = (e) => {
    if (e.target.id === 'sp') S.payer = Number(e.target.value);
    if (e.target.id === 'sf') S.from = e.target.value;
    if (e.target.id === 'st2') S.to = e.target.value;
    load();
  };
  $('#xl', pane).addEventListener('click', () => { location.href = `/api/payers/${S.payer}/statement?from=${S.from}&to=${S.to}&format=xlsx`; });
  await load();
  return () => { pane.onchange = null; };
}

// ================= محرر الجهة (المدير) =================
export async function renderPayerEdit(view, { params, setTitle }) {
  const isNew = params[0] === 'new';
  const [ed, det, allPayers, plRes] = await Promise.all([
    api.get('/payers/editor-data'), isNew ? Promise.resolve(null) : api.get('/payers/' + params[0]), api.get('/payers'), api.get('/payers/price-lists'),
  ]);
  const otherPayers = allPayers.payers.filter((p) => isNew || String(p.id) !== String(params[0]));
  const services = ed.services; const roomsRes = ed;
  const P = det ? { ...det.payer } : { name: '', priceMode: 'cash', active: true, tiers: [{ name: 'كارنيه أ', active: true, coverage: Object.fromEntries(COVER_KEYS.map((d) => [d, 100])) }] };
  const prices = new Map((det?.prices || []).map((x) => [x.serviceId, x.price]));
  const classPrices = new Map((det?.classPrices || []).map((x) => [x.classId, x.price]));
  const rules = new Map((det?.rules || []).map((x) => [x.serviceId, x.rule]));
  // قايمة أسعار مستقلة (لو الجهة مربوطة بواحدة، أسعارها بتتقرا منها وبتتعدّل من تبويب «قوائم الأسعار»)
  let listId = P.priceListId || null;
  let listPrices = new Map(), listClass = new Map();
  const loadList = async () => {
    listPrices = new Map(); listClass = new Map();
    if (!listId) return;
    const d = await api.get('/payers/price-lists/' + listId);
    listPrices = new Map(d.prices.map((x) => [x.serviceId, x.price])); listClass = new Map(d.classPrices.map((x) => [x.classId, x.price]));
  };
  await loadList();
  let q = '', dept = 'all';
  setTitle(isNew ? 'جهة تعاقد جديدة' : P.name, 'البيانات، مستويات الكارنيه ونسبها، والخدمات والأسعار');

  view.innerHTML = String(html`<div class="grid pyedit" style="gap:16px">
    <section class="card pad"><h3>${icon('shield')} بيانات الجهة</h3><div class="form-grid" id="basic">
      <div class="field c3" data-f="name"><label>الاسم <span class="req">*</span></label><input class="input" name="name" value="${P.name}"><div class="msg"></div></div>
      <div class="field c1"><label>النوع</label><input class="input" name="kind" value="${P.kind || ''}" placeholder="شركة/نقابة" list="pkinds"></div>
      <div class="field c1" data-f="validFrom"><label>من</label><input class="input" type="date" name="validFrom" value="${P.validFrom || ''}"><div class="msg"></div></div>
      <div class="field c1" data-f="validTo"><label>لحد</label><input class="input" type="date" name="validTo" value="${P.validTo || ''}"><div class="msg"></div></div>
      <div class="field c3" data-f="priceMode"><label>الأسعار</label><div class="seg full" data-seg="pm">${Object.entries(PRICE_MODE).map(([k, n]) => html`<button type="button" data-v="${k}" class="${P.priceMode === k ? 'on' : ''}">${n}</button>`)}</div><div class="msg"></div></div>
      <div class="field c1 ${P.priceMode === 'discount' ? '' : 'hide'}" data-f="discountPct" id="dpf"><label>نسبة الخصم</label><div class="pctin"><input class="input num" name="discountPct" value="${P.discountPct ?? ''}"><span>%</span></div><div class="msg"></div></div>
      <div class="field c1" data-f="visitCap"><label>حد أقصى للزيارة</label><input class="input num" name="visitCap" value="${P.visitCap ?? ''}" placeholder="مفيش"><div class="msg"></div></div>
      <div class="field c1" data-f="yearCap"><label>حد أقصى للسنة</label><input class="input num" name="yearCap" value="${P.yearCap ?? ''}" placeholder="مفيش"><div class="msg"></div></div>
      <div class="field c3"><label>المستندات المطلوبة</label><input class="input" name="requiredDocs" value="${P.requiredDocs || ''}" placeholder="كارنيه ساري + خطاب تحويل"></div>
      <div class="field c2"><label>المسؤول وتليفونه</label><div class="row" style="gap:6px"><input class="input" name="contactName" value="${P.contactName || ''}" placeholder="الاسم"><input class="input num" name="contactPhone" value="${P.contactPhone || ''}" placeholder="التليفون"></div></div>
      <div class="field c1" style="justify-content:flex-end;padding-bottom:8px"><label class="swl"><button type="button" class="switch" role="switch" data-sw="active" aria-checked="${P.active ? 'true' : 'false'}"></button><span>شغالة</span></label></div>
      <div class="field c6"><label>ملاحظات</label><input class="input" name="notes" value="${P.notes || ''}"></div>
    </div><datalist id="pkinds"><option value="شركة تأمين"><option value="نقابة"><option value="هيئة"><option value="شركة"></datalist></section>

    <section class="card pad"><h3>${icon('percent')} مستويات الكارنيه ونسبة تحمّل الجهة <span class="muted">الفاضي = 0% (على المريض)</span></h3>
      <div class="table-wrap"><table class="table tiertbl"><thead><tr><th>المستوى</th>${COVER_KEYS.map((d) => html`<th class="n">${DSHORT[d]}</th>`)}<th></th></tr></thead><tbody id="tiers"></tbody></table></div>
      <div class="row" style="gap:8px;margin-top:10px"><button class="linkbtn" id="addTier">${icon('plus', 'sm')} مستوى جديد</button><span class="muted" style="font-size:12.5px;font-weight:600">نسخ أول صف لكل الأقسام:</span>${[100, 75, 50].map((v) => html`<button class="btn ghost sm" data-fill="${v}">${v}%</button>`)}</div>
      <div class="msg" data-f="tiers" style="color:var(--danger);font-weight:700;font-size:13px"></div>
    </section>

    <section class="card pad"><h3>${icon('tag')} الخدمات: التغطية${P.priceMode === 'list' ? ' والأسعار الخاصة' : ''} <span class="muted" id="rc"></span></h3>
      <div class="row wrap lp hide" id="ptools" style="gap:8px;margin-bottom:12px;padding:10px;border:1px dashed var(--line);border-radius:12px;background:var(--brand-soft)">
        <b style="font-size:13px">أسعار الجهة:</b>
        <select class="select" id="plsel" style="max-width:240px"><option value="">أسعار خاصة بالجهة دي</option>${plRes.lists.filter((l) => l.active || l.id === listId).map((l) => html`<option value="${l.id}" ${l.id === listId ? 'selected' : ''}>قايمة: ${l.name}</option>`)}</select>
        <span class="muted own-only" style="font-size:12.5px;font-weight:600">${listId ? 'الأسعار من القايمة، وبتتعدّل من تبويب «قوائم الأسعار»' : ''}</span>
        <select class="select" id="cpsrc" style="max-width:240px"><option value="">انسخ أسعار من جهة تانية…</option>${otherPayers.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
        <button type="button" class="btn ghost sm" id="cpgo">${icon('sheet', 'sm')} انسخ</button>
        <span class="spacer"></span>
        <a class="btn ghost sm" id="pxl" href="/api/payers/prices-export${isNew ? '' : '?payer=' + params[0]}">${icon('download', 'sm')} تصدير إكسل</a>
        <label class="btn ghost sm" style="cursor:pointer">${icon('upload', 'sm')} استيراد من إكسل<input type="file" id="pxfile" accept=".xlsx" hidden></label>
      </div>
      <div class="row wrap" style="gap:10px;margin-bottom:10px"><div class="dtabs" id="sdt"></div>
        <div class="big-search" style="flex:1 1 200px;max-width:320px">${icon('search')}<input class="input" id="sq" placeholder="دوّر" style="height:40px;font-size:14px;padding-inline-start:40px;border-radius:12px"></div></div>
      <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table"><thead><tr><th>الخدمة</th><th>القسم</th><th class="n">سعر المستشفى</th><th class="n lp">سعر الجهة</th><th>التغطية</th></tr></thead><tbody id="svcs"></tbody></table></div>
      <div id="clsp"></div>
    </section>
    <div class="savebar"><a class="btn ghost" href="#/contracts?tab=payers">رجوع</a>${!isNew && can('payers.delete') ? html`<button class="btn ghost" id="delPayer" style="color:var(--danger)">${icon('trash', 'sm')} امسح الجهة</button>` : ''}<button class="btn lg" id="save">${icon('check')} احفظ الجهة</button></div>
  </div>`);

  const tiers = P.tiers.map((t) => ({ ...t, coverage: { ...t.coverage } }));
  const drawTiers = () => {
    $('#tiers', view).innerHTML = String(html`${tiers.map((t, i) => html`<tr class="${t.active ? '' : 'off-row'}">
      <td><input class="input" data-tn="${i}" value="${t.name}" style="min-width:110px"></td>
      ${COVER_KEYS.map((d) => html`<td class="n"><div class="pctin" style="min-width:76px"><input class="input num" data-tc="${i}" data-d="${d}" value="${t.coverage[d] ?? ''}"><span>%</span></div></td>`)}
      <td class="n nw">${t.id ? html`<button type="button" class="switch sm" role="switch" data-ta="${i}" aria-checked="${t.active ? 'true' : 'false'}" title="شغال"></button>${can('payers.delete') ? html` <button type="button" class="btn ghost icon sm" data-td="${i}" title="امسح المستوى نهائي">${icon('trash', 'sm')}</button>` : ''}` : html`<button class="btn ghost icon sm" data-tr="${i}">${icon('trash', 'sm')}</button>`}</td></tr>`)}`);
  };
  const keys = ['all', ...SVC_KEYS];
  const drawSvcs = () => {
    const mode = segV('pm');
    $$('.lp', view).forEach((x) => x.classList.toggle('hide', mode !== 'list'));
    $('#ptools', view)?.classList.toggle('hide', mode !== 'list');
    $('#sdt', view).innerHTML = String(html`${keys.map((k) => html`<button class="dtab ${k === 'all' ? '' : 'd-' + k} ${dept === k ? 'on' : ''}" data-dt="${k}" ${k === 'all' ? 'style="--dc:var(--ink)"' : ''}>${k === 'all' ? 'الكل' : DSHORT[k]}</button>`)}`);
    const k = searchKey(q);
    const list = services.filter((s) => (dept === 'all' || s.dept === dept) && (!k || searchKey(s.name + ' ' + s.code).includes(k)));
    const disc = mode === 'discount' ? Number($('[name=discountPct]', view).value) || 0 : 0;
    $('#svcs', view).innerHTML = String(html`${list.map((s) => { const r = rules.get(s.id) || ''; return html`<tr>
      <td><b>${s.name}</b> <span class="code num">${s.code}</span></td><td><span class="dtag d-${s.dept}">${DSHORT[s.dept]}</span></td>
      <td class="n nw">${egp(s.price)}${disc ? html`<div class="muted num" style="font-size:12px">${money(HMS.money.discountValue(s.price, disc))} بعد الخصم</div>` : ''}</td>
      <td class="n lp ${mode === 'list' ? '' : 'hide'}">${listId ? html`<span class="num" style="font-weight:700">${listPrices.has(s.id) ? egp(listPrices.get(s.id)) : html`<span class="muted">${egp(s.price)}</span>`}</span>` : html`<input class="input num" data-pr="${s.id}" value="${prices.get(s.id) ?? ''}" placeholder="${s.price}" style="width:100px">`}</td>
      <td><div class="seg rseg" data-rule="${s.id}"><button data-v="" class="${r === '' ? 'on' : ''}">متغطية</button><button data-v="approval" class="${r === 'approval' ? 'on' : ''}">محتاجة موافقة</button><button data-v="excluded" class="${r === 'excluded' ? 'on' : ''}">مش مغطاة</button></div></td></tr>`; })}`);
    const ra = [...rules.values()];
    $('#rc', view).textContent = `${ra.filter((x) => x === 'approval').length} محتاجة موافقة · ${ra.filter((x) => x === 'excluded').length} مش مغطاة${mode === 'list' ? ` · ${listId ? listPrices.size : prices.size} سعر ${listId ? 'في القايمة' : 'خاص'}` : ''}`;
    $('#clsp', view).innerHTML = mode === 'list' ? String(html`<h4 class="subh">${icon('bed', 'sm')} سعر الليلة للجهة <span class="muted">فاضي = سعر المستشفى</span></h4>
      <div class="row wrap" style="gap:10px">${roomsRes.classes.filter((c) => c.active).map((c) => html`<div class="field" style="width:150px"><label>${c.name} <span class="hint num">${c.nightPrice ?? '—'}</span></label>${listId ? html`<div class="input" style="display:flex;align-items:center;background:var(--bg-2)">${listClass.has(c.id) ? egp(listClass.get(c.id)) : '—'}</div>` : html`<input class="input num" data-cp="${c.id}" value="${classPrices.get(c.id) ?? ''}" placeholder="${c.nightPrice ?? ''}">`}</div>`)}</div>`) : '';
  };
  const segV = (n) => $(`[data-seg="${n}"] button.on`, view)?.dataset.v;
  const listUi = () => {
    $$('.own-only', view).forEach((x) => { x.textContent = listId ? 'الأسعار من القايمة، وبتتعدّل من تبويب «قوائم الأسعار»' : ''; });
    $$('#cpsrc, #cpgo, #pxl, #pxfile', view).forEach((x) => x.closest('.btn,select,a,label')?.classList.toggle('hide', !!listId));
  };
  drawTiers(); drawSvcs(); listUi();

  view.oninput = (e) => {
    const t = e.target;
    if (t.dataset.tn != null) tiers[t.dataset.tn].name = t.value;
    if (t.dataset.tc != null) tiers[t.dataset.tc].coverage[t.dataset.d] = t.value;
    if (t.dataset.pr) { if (t.value === '') prices.delete(Number(t.dataset.pr)); else prices.set(Number(t.dataset.pr), t.value); }
    if (t.dataset.cp) { if (t.value === '') classPrices.delete(Number(t.dataset.cp)); else classPrices.set(Number(t.dataset.cp), t.value); }
    if (t.id === 'sq') { q = t.value; drawSvcs(); const i = $('#sq', view); i.focus(); }
    if (t.name === 'discountPct') drawSvcs();
  };
  view.onclick = async (e) => {
    const t = e.target;
    const sb = t.closest('[data-seg="pm"] button');
    if (sb) { $$('[data-seg="pm"] button', view).forEach((b) => b.classList.toggle('on', b === sb)); $('#dpf', view).classList.toggle('hide', sb.dataset.v !== 'discount'); drawSvcs(); return; }
    const rb = t.closest('[data-rule] button');
    if (rb) { const sid = Number(rb.parentElement.dataset.rule); if (rb.dataset.v) rules.set(sid, rb.dataset.v); else rules.delete(sid); $$('button', rb.parentElement).forEach((b) => b.classList.toggle('on', b === rb)); drawSvcs(); return; }
    const dt = t.closest('[data-dt]');
    if (dt) { dept = dt.dataset.dt; drawSvcs(); return; }
    if (t.closest('#addTier')) { tiers.push({ name: '', active: true, coverage: {} }); drawTiers(); $$('[data-tn]', view).at(-1).focus(); return; }
    const tr = t.closest('[data-tr]');
    if (tr) { tiers.splice(Number(tr.dataset.tr), 1); drawTiers(); return; }
    const td = t.closest('[data-td]');
    if (td) {
      const i = Number(td.dataset.td), tr0 = tiers[i];
      if (!await confirmDelete(`مسح المستوى «${tr0.name}»`, 'المستوى هيتمسح نهائي لو عمره ما اتستخدم مع مريض أو زيارة. لو اتستخدم هيترفض المسح وتوقفه بدل كده.')) return;
      try { await api.del(`/payers/${params[0]}/tiers/${tr0.id}`); tiers.splice(i, 1); drawTiers(); toast('اتمسح المستوى'); } catch (er) { toastError(er); }
      return;
    }
    if (t.closest('#delPayer')) {
      if (!await confirmDelete(`مسح جهة «P_NAME»`.replace('P_NAME', P.name), 'الجهة بكل مستوياتها وأسعارها هتتمسح نهائي لو عمرها ما اتستخدمت. لو اتستخدمت هيترفض المسح وتوقفها بمفتاح «شغالة».')) return;
      try { await api.del('/payers/' + params[0]); toast('اتمسحت الجهة'); window.go('/contracts?tab=payers'); } catch (er) { toastError(er); }
      return;
    }
    if (t.closest('#cpgo')) {
      const src = $('#cpsrc', view).value;
      if (!src) { toast('اختار الجهة اللي هتنسخ منها', 'err'); return; }
      try {
        const d = await api.get('/payers/' + src);
        if (prices.size && !await confirmDelete('استبدال الأسعار الحالية؟', `في ${prices.size} سعر خاص مكتوب هنا، ونسخ أسعار «${d.payer.name}» هيستبدلهم. التغيير مش بيتحفظ غير لما تدوس «احفظ الجهة».`)) return;
        prices.clear(); classPrices.clear();
        for (const x of d.prices) prices.set(x.serviceId, x.price);
        for (const x of d.classPrices) classPrices.set(x.classId, x.price);
        drawSvcs();
        toast(`اتنسخ ${d.prices.length} سعر من ${d.payer.name}. دوس «احفظ الجهة» عشان يتحفظوا`);
      } catch (er) { toastError(er); }
      return;
    }
    const ta = t.closest('[data-ta]');
    if (ta) { const i = Number(ta.dataset.ta); tiers[i].active = !tiers[i].active; drawTiers(); return; }
    const fl = t.closest('[data-fill]');
    if (fl && tiers[0]) { for (const d of COVER_KEYS) tiers[0].coverage[d] = fl.dataset.fill; drawTiers(); return; }
    const sw = t.closest('[data-sw]');
    if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    if (t.closest('#save')) save();
  };
  view.onchange = async (e) => {
    if (e.target.id === 'plsel') { listId = Number(e.target.value) || null; try { await loadList(); } catch (er) { toastError(er); } listUi(); drawSvcs(); return; }
    if (e.target.id !== 'pxfile' || !e.target.files[0]) return;
    const f = e.target.files[0]; e.target.value = '';
    try {
      const r = await fetch('/api/payers/prices-import', { method: 'POST', body: f, credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new ApiError(r.status, j);
      prices.clear();
      for (const x of j.prices) prices.set(x.serviceId, x.price);
      drawSvcs();
      toast(`اتقرا ${j.prices.length} سعر${j.errors.length ? ` · ${j.errors.length} صف فيه مشكلة: ${j.errors.slice(0, 3).map((x) => `صف ${x.row} (${x.msg})`).join('، ')}` : ''}. دوس «احفظ الجهة» عشان يتحفظوا`, j.errors.length ? 'err' : undefined);
    } catch (er) { toastError(er); }
  };
  const save = async () => {
    const v = (n) => $(`[name="${n}"]`, view).value;
    const body = {
      name: v('name'), kind: v('kind'), validFrom: v('validFrom'), validTo: v('validTo'), priceMode: segV('pm'), discountPct: v('discountPct'),
      visitCap: v('visitCap'), yearCap: v('yearCap'), requiredDocs: v('requiredDocs'), contactName: v('contactName'), contactPhone: v('contactPhone'),
      priceListId: segV('pm') === 'list' ? listId : null, notes: v('notes'), active: $('[data-sw=active]', view).getAttribute('aria-checked') === 'true', tiers,
    };
    $$('.field', view).forEach((f) => { f.classList.remove('err'); const m = $('.msg', f); if (m) m.textContent = ''; });
    $('[data-f=tiers]', view).textContent = '';
    const btn = $('#save', view);
    btn.disabled = true;
    try {
      const r = isNew ? await api.post('/payers', body) : await api.put('/payers/' + params[0], body);
      const id = r.payer.id;
      await api.put(`/payers/${id}/rules`, { rules: [...rules].map(([serviceId, rule]) => ({ serviceId, rule })) });
      if (body.priceMode === 'list' && !listId) await api.put(`/payers/${id}/prices`, { prices: [...prices].map(([serviceId, price]) => ({ serviceId, price })), classPrices: [...classPrices].map(([classId, price]) => ({ classId, price })) });
      toast(isNew ? `اتضافت ${r.payer.name}` : 'اتحفظت الجهة');
      window.go('/contracts?tab=payers');
    } catch (er) {
      if (er instanceof ApiError && er.data.errors) {
        for (const [f, msg] of Object.entries(er.data.errors)) {
          const box = $(`[data-f="${f}"]`, view);
          if (box) { box.classList.add('err'); const m = box.classList.contains('msg') ? box : $('.msg', box); if (m) m.textContent = msg; }
        }
        $('.err', view)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(er.message, 'err');
      } else toastError(er);
    } finally { btn.disabled = false; }
  };
  return () => { view.oninput = view.onclick = view.onchange = null; };
}
void el;
