// نوافذ اختيار مشتركة: الدكتور، الخدمة، المدير
import { api, html, icon, $, $$, initials, modal, fmtSlot, money, toast } from '../core.js';
import { searchKey } from '/shared/text.js';

let docsCache = null;
export async function doctors(force = false) {
  if (!docsCache || force || Date.now() - docsCache.at > 5 * 60e3) docsCache = { list: (await api.get('/catalog/doctors')).doctors, at: Date.now() };
  return docsCache.list;
}
let mgrCache = null;
export async function managers() {
  if (!mgrCache) mgrCache = (await api.get('/catalog/managers')).managers;
  return mgrCache;
}
export const mgrSelect = (name, v, list) => html`<select class="select" name="${name}"><option value="">المدير اللي وافق</option>${list.map((m) => html`<option value="${m.id}" ${String(v) === String(m.id) ? 'selected' : ''}>${m.name}</option>`)}</select>`;

/** يرجّع الدكتور اللي اتختار أو null */
export function pickDoctor(title = 'اختار الدكتور') {
  return new Promise(async (resolve) => {
    const docs = await doctors();
    let done = false;
    const m = modal({
      title, wide: true,
      body: html`<div class="big-search" style="margin-bottom:12px">${icon('search')}<input class="input" id="dq" placeholder="اسم الدكتور أو التخصص" style="height:46px;font-size:15px;padding-inline-start:46px" autofocus autocomplete="off"></div><div id="dl"></div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const draw = (q = '') => {
      const k = searchKey(q);
      const list = docs.filter((d) => !k || searchKey(d.name + ' ' + (d.specialty || '')).includes(k));
      const group = (t, arr) => arr.length ? html`<div class="muted" style="font-weight:800;font-size:13px;margin:6px 2px 8px">${t}</div><div class="docs" style="margin-bottom:12px">${arr.map((d) => html`
        <button class="doc ${d.presentNow ? 'now' : ''} ${d.today ? '' : 'off'}" data-doc="${d.id}"><span class="dav">${initials(d.name)}<i></i></span>
          <div><b>${d.name}</b><small>${d.specialty || ''}${d.slots.length ? ' · ' + d.slots.map(fmtSlot).join('، ') : ''}</small></div></button>`)}</div>` : '';
      $('#dl', m.el).innerHTML = String(html`${group('موجودين دلوقتي', list.filter((d) => d.presentNow))}${group('في جدول النهارده', list.filter((d) => d.today && !d.presentNow))}${group('باقي الأطباء', list.filter((d) => !d.today))}
        ${!list.length ? html`<div class="empty">مفيش دكتور بالاسم ده</div>` : ''}`);
    };
    draw();
    $('#dq', m.el).addEventListener('input', (e) => draw(e.target.value));
    $('#dq', m.el).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-doc]', m.el)?.click(); });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-doc]');
      if (b) { done = true; m.close(); resolve(docs.find((d) => d.id === Number(b.dataset.doc))); }
    });
  });
}

let payersCache = null;
export async function usablePayers(force = false) {
  if (!payersCache || force || Date.now() - payersCache.at > 5 * 60e3) payersCache = { list: (await api.get('/payers?usable=1')).payers, at: Date.now() };
  return payersCache.list;
}

/**
 * اختيار التعاقد: يرجّع { payerId, tierId, cardNo } أو null لو «نقدي»، أو undefined لو قفل من غير اختيار
 * current: التعاقد الحالي { id, tierId, cardNo }
 */
export function pickPayer({ title = 'التعاقد', current = null, allowCash = true } = {}) {
  return new Promise(async (resolve) => {
    const list = await usablePayers();
    let done = false;
    let sel = current?.id || null, tier = current?.tierId || null;
    const m = modal({
      title, wide: true,
      body: html`<div class="paylist" id="pl"></div><div id="pd" style="margin-top:12px"></div>`,
      foot: html`${allowCash ? html`<button class="btn ghost" data-cash style="margin-inline-end:auto">${icon('cash')} نقدي (من غير تعاقد)</button>` : ''}<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} تمام</button>`,
      onClose: () => { if (!done) resolve(undefined); },
    });
    const draw = () => {
      $('#pl', m.el).innerHTML = String(html`${list.map((p) => html`<button class="paycard ${p.id === sel ? 'on' : ''}" data-p="${p.id}">
          <span class="pic">${icon('shield')}</span><div><b>${p.name}</b><small>${p.kind || ''}${p.validTo ? ' · لحد ' + p.validTo : ''}</small></div>
          ${p.expiresSoon ? html`<span class="badge warn">بينتهي قريب</span>` : ''}</button>`)}
        ${!list.length ? html`<div class="empty">مفيش جهات تعاقد شغالة. المدير يضيفها من «التعاقدات».</div>` : ''}`);
      const p = list.find((x) => x.id === sel);
      $('#pd', m.el).innerHTML = p ? String(html`
        <div class="field" data-f="tier"><label>مستوى الكارنيه</label><div class="tiers">${p.tiers.map((t) => html`<button type="button" class="tierbtn ${t.id === tier ? 'on' : ''}" data-t="${t.id}"><b>${t.name}</b>
          <small>${Object.entries(t.coverage).map(([d, v]) => `${({ clinic: 'كشف', emergency: 'طوارئ', lab: 'معمل', radiology: 'أشعة', ward: 'إقامة', or: 'عمليات', drugs: 'أدوية', supplies: 'مستلزمات' })[d] || d} ${v}%`).join(' · ') || 'مفيش نسب'}</small></button>`)}</div><div class="msg"></div></div>
        <div class="field" data-f="cardNo" style="margin-top:10px"><label>رقم الكارنيه</label><input class="input num" name="cardNo" value="${current?.id === p.id ? current.cardNo || '' : ''}" style="text-align:left"><div class="msg"></div></div>
        ${p.requiredDocs ? html`<div class="alertbar info" style="margin-top:10px">${icon('clipboard')}<span>المطلوب: <b>${p.requiredDocs}</b></span></div>` : ''}`) : '';
    };
    draw();
    m.el.addEventListener('click', (e) => {
      const pb = e.target.closest('[data-p]');
      if (pb) { sel = Number(pb.dataset.p); const p = list.find((x) => x.id === sel); tier = p.tiers.length === 1 ? p.tiers[0].id : null; draw(); return; }
      const tb = e.target.closest('[data-t]');
      if (tb) { tier = Number(tb.dataset.t); $$('.tierbtn', m.el).forEach((b) => b.classList.toggle('on', b === tb)); return; }
      if (e.target.closest('[data-cash]')) { done = true; m.close(); resolve(null); return; }
      if (e.target.closest('[data-ok]')) {
        if (!sel) return toast('اختار الجهة', 'warn');
        if (!tier) { const f = $('[data-f=tier]', m.el); f.classList.add('err'); $('.msg', f).textContent = 'اختار المستوى'; return; }
        const cardNo = $('[name=cardNo]', m.el).value.trim();
        if (!cardNo) { const f = $('[data-f=cardNo]', m.el); f.classList.add('err'); $('.msg', f).textContent = 'اكتب رقم الكارنيه'; return; }
        done = true; m.close(); resolve({ payerId: sel, tierId: tier, cardNo, payer: list.find((x) => x.id === sel) });
      }
    });
  });
}

/**
 * بيانات الموافقة لخدمة محتاجة موافقة: يرجّع { mode:'pending', no, date, file } أو { mode:'tempcash' } أو null
 */
export function askApproval({ service, payerName, payerAmount, amount, allowTemp = true }) {
  return new Promise((resolve) => {
    let done = false, mode = 'pending';
    const m = modal({
      title: `موافقة ${payerName}`,
      body: html`<div class="pricehead" style="--ds:var(--warn-soft);--dc:var(--warn)"><span class="dicon">${icon('shield')}</span><div><b>${service}</b><small>محتاجة موافقة مسبقة</small></div>
          <div class="cur"><small>نصيب الشركة</small><b>${money(payerAmount)} ${HMS.money.symbol}</b></div></div>
        ${allowTemp ? html`<div class="seg full" style="margin-top:14px"><button data-md="pending" class="on">${icon('check', 'sm')} عندي رقم الموافقة</button><button data-md="tempcash">${icon('hourglass', 'sm')} نقدي مؤقت</button></div>` : ''}
        <div id="apf" style="margin-top:12px"></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} كمّل</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const draw = () => {
      $('#apf', m.el).innerHTML = String(mode === 'pending' ? html`<div class="form-grid">
          <div class="field c3" data-f="no"><label>رقم الموافقة ${allowTemp ? html`<span class="req">*</span>` : html`<span class="hint">لو موجود</span>`}</label><input class="input num" name="no" style="text-align:left" autofocus><div class="msg"></div></div>
          <div class="field c3"><label>تاريخها</label><input class="input" type="date" name="date" value="${new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz })}"></div>
          <div class="field c6"><label>صورة الموافقة <span class="hint">اختياري</span></label><label class="filepick">${icon('upload')}<span data-fn>صوّر الموافقة أو اختار ملف</span><input type="file" name="file" accept="image/*,application/pdf" hidden></label></div></div>
          <div class="alertbar info" style="margin-top:10px">${icon('info')}<span>الخدمة هتتعمل عادي، والمريض يدفع نصيبه بس. البند هيتعلّم «مستني المراجعة» لحد ما قسم المراجعة يعتمده الصبح. لو اترفض، الفرق بيتحوّل على المريض.</span></div>`
        : html`<div class="alertbar warn">${icon('hourglass')}<span>المريض هيدفع الخدمة كلها (<b class="num">${money(amount)}</b> ${HMS.money.symbol}). لما الموافقة توصل وتتعتمد، نصيب الشركة (<b class="num">${money(payerAmount)}</b> ${HMS.money.symbol}) بيرجع له.</span></div>`);
      setTimeout(() => $('[name=no]', m.el)?.focus(), 30);
    };
    draw();
    m.el.addEventListener('change', (e) => { if (e.target.name === 'file') { const f = e.target.files[0]; const l = $('[data-fn]', m.el); l.textContent = f ? f.name : 'صوّر الموافقة أو اختار ملف'; l.parentElement.classList.toggle('on', !!f); } });
    m.el.addEventListener('click', (e) => {
      const md = e.target.closest('[data-md]');
      if (md) { mode = md.dataset.md; $$('[data-md]', m.el).forEach((b) => b.classList.toggle('on', b === md)); draw(); return; }
      if (!e.target.closest('[data-ok]')) return;
      if (mode === 'tempcash') { done = true; m.close(); resolve({ mode }); return; }
      const no = $('[name=no]', m.el).value.trim();
      if (allowTemp && !no) { const f = $('[data-f=no]', m.el); f.classList.add('err'); $('.msg', f).textContent = 'اكتب رقم الموافقة أو اختار «نقدي مؤقت»'; return; }
      done = true; m.close();
      resolve({ mode, no, date: $('[name=date]', m.el).value, file: $('[name=file]', m.el).files[0] || null });
    });
  });
}
