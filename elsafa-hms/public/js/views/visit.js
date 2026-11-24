// شاشة الزيارة: المريض ، الخدمات ، الحساب والدفع (كلهم في شاشة واحدة)
import { deptIs,
  api, html, raw, icon, el, $, $$, money, egp, fmtTime, fmtWhen, initials, sexName, DEPT, DEPT_KEYS,
  modal, toast, toastError, askReason, printReceipt, can, debounce, fmtSlot, COVER, ApiError, uploadApprovalImage, cashierDuty, showOrder, printOrder, state,
  TCAT, unitsText,
} from '../core.js';
import { pickPayer, askApproval } from './pickers.js';
import { searchKey } from '/shared/text.js';

let catalog = null; // كاش الخدمات والأطباء والمديرين
async function loadCatalog(force = false) {
  if (catalog && !force && Date.now() - catalog.at < 5 * 60e3) return catalog;
  const [s, d, m] = await Promise.all([api.get('/catalog/services'), api.get('/catalog/doctors'), api.get('/catalog/managers')]);
  catalog = { services: s.services, doctors: d.doctors, managers: m.managers, at: Date.now() };
  return catalog;
}

const autoPrint = () => localStorage.getItem('autoPrint') !== '0';

export async function renderVisit(view, { params, setTitle }) {
  const id = Number(params[0]);
  view.innerHTML = String(html`<div class="skel" style="height:80px"></div><div class="vgrid"><div class="skel" style="height:420px"></div><div class="skel" style="height:420px"></div></div>`);
  const [cat0, first, duty0] = await Promise.all([loadCatalog(), api.get('/visits/' + id), cashierDuty().catch(() => ({}))]);
  const cat = { ...cat0, services: cat0.services.filter((s) => DEPT_KEYS.includes(s.dept)) };
  const isPharm = first.visit.type === 'pharmacy';
  const canStock = can('visit.stock');
  // الأدوية والمستلزمات: المخازن اللي الموظف بيصرف منها، والرصيد
  const ST = { stores: [], storeId: null, items: [], stock: {}, manual: false };
  if (canStock) {
    try {
      const [ss, it] = await Promise.all([api.get('/catalog/stock-stores'), api.get('/tickets/items')]);
      ST.stores = ss.stores; ST.items = it.items;
      ST.storeId = Number(localStorage.getItem('vstore:' + first.visit.type)) || ss.defaults[first.visit.type] || ss.stores[0]?.id || null;
      if (!ST.stores.some((x) => x.id === ST.storeId)) ST.storeId = ss.defaults[first.visit.type] || ss.stores[0]?.id || null;
      if (first.visit.type === 'clinic' && ST.stores.find((x) => x.id === ST.storeId)?.clinic) ST.storeId = ss.defaults.clinic || ST.stores.find((x) => !x.clinic)?.id || null; // من غير دكتور لسه: مفيش مخزن عيادة تلقائي
      const cs = first.visit.clinicStore;
      if (first.visit.type === 'clinic' && cs && ST.stores.some((x) => x.id === cs.id)) ST.storeId = cs.id;
      if (ST.storeId) ST.stock = (await api.get('/catalog/store-stock/' + ST.storeId)).items;
    } catch { /* */ }
  }
  const S = {
    d: first,
    dept: isPharm ? 'stock' : first.visit.type,
    q: '',
    sel: new Set(first.items.filter((i) => i.status === 'active' && !i.paid && !i.pendingOrderId).map((i) => i.id)),
    method: 'cash',
    disc: { on: false, amount: '', reason: '', by: '' },
    creditBy: '',
    cashGiven: '',
    split: { cash: '', card: '' },
    lastAdded: null,
    busy: false,
    duty: duty0,
    manualNo: '',
  };
  const ordering = () => !!S.duty?.mustOrder;
  const p = () => S.d.patient;
  setTitle('زيارة ' + DEPT[first.visit.type].short, `${p().name} · زيارة رقم ${first.visit.no}`);

  view.innerHTML = String(html`
    <div class="card vstrip" id="strip"></div>
    <div class="vgrid">
      <section class="card catalog" id="catalog">
        <div class="row wrap" style="gap:10px">
          <div class="dtabs" id="tabs"></div>
          <div class="big-search" style="flex:1 1 200px;min-width:180px">${icon('search')}
            <input class="input" id="sq" type="search" placeholder="دوّر على خدمة بالاسم أو الكود" style="height:44px;font-size:15px;padding-inline-start:44px;border-radius:13px" autocomplete="off"></div>
        </div>
        <div class="svc-grid" id="svcs"></div>
      </section>
      <aside class="card bill" id="bill"></aside>
    </div>`);

  // ---------- الشريط العلوي ----------
  const drawStrip = () => {
    const v = S.d.visit, pt = p();
    $('#strip').innerHTML = String(html`
      <span class="pavatar ${pt.sex || ''}">${initials(pt.name)}</span>
      <div style="min-width:0">
        <div class="row wrap" style="gap:8px"><h2>${pt.name}</h2><a class="fileno num" href="#/patient/${pt.id}" title="افتح الملف">#${pt.no}</a>
          ${pt.incomplete ? html`<span class="badge warn">بيانات ناقصة</span>` : ''}</div>
        <div class="pmeta">${pt.age ? html`<span>${pt.age}${pt.sex ? ' · ' + sexName(pt.sex) : ''}</span>` : ''}${pt.phone ? html`<span>${icon('phone', 'sm')}<span class="num">${pt.phone}</span></span>` : ''}
          <span>${icon('clock', 'sm')}${fmtWhen(v.openedAt)} · ${v.openedBy}</span></div>
      </div>
      <div class="vno">
        <span class="dtag d-${v.type}">${icon(DEPT[v.type].icon)} ${DEPT[v.type].name}</span>
        <span class="badge">زيارة <span class="num">${v.no}</span></span>
        ${v.payer ? html`<button class="paychip" id="vpayer" ${v.status === 'open' && can('visits.write') ? '' : 'disabled'} title="${v.payer.tierName} · كارنيه ${v.payer.cardNo || ''}">${icon('shield', 'sm')} ${v.payer.name} <small>${v.payer.tierName}</small></button>`
          : v.status === 'open' && can('visits.write') ? html`<button class="paychip cash" id="vpayer">${icon('cash', 'sm')} نقدي <small>غيّر</small></button>` : ''}
        ${v.payer ? html`<label class="diagchip ${v.diagnosis ? '' : 'miss'}" title="التشخيص بيطلع في مطالبة ${v.payer.name}">${icon('file', 'sm')}<input id="vdiag" value="${v.diagnosis || ''}" placeholder="التشخيص" ${can('visits.write') || can('claims.fix') ? '' : 'disabled'}></label>` : ''}
        ${v.status === 'open' ? html`<span class="badge ok dot">مفتوحة</span>` : html`<span class="badge">مقفولة</span>`}
        ${v.status === 'open' && S.d.totals.due === 0 && S.d.items.some((i) => i.status === 'active') && can('visits.write') ? html`<button class="btn ghost sm" id="closeV">${icon('check', 'sm')} قفل الزيارة</button>` : ''}
        ${v.status === 'open' && can('admissions.write') && deptIs(v.type, 'emergency', 'clinic') ? html`<a class="btn soft sm" href="#/admit?patient=${pt.id}&visit=${v.id}" style="--c:var(--brand)">${icon('bed', 'sm')} حوّله دخول</a>` : ''}
      </div>`);
    $('#vpayer')?.addEventListener('click', async () => {
      const c = await pickPayer({ title: 'تعاقد الزيارة دي', current: S.d.visit.payer });
      if (c === undefined) return;
      try { refresh(await api.put(`/visits/${id}/payer`, c ? { payerId: c.payerId, tierId: c.tierId, cardNo: c.cardNo } : { payerId: null })); toast(c ? `الحساب بقى على ${c.payer.name}` : 'الحساب بقى نقدي'); }
      catch (e) { toastError(e); }
    });
    $('#vdiag')?.addEventListener('change', async (e) => {
      try { S.d = await api.put(`/visits/${id}/diagnosis`, { diagnosis: e.target.value }); e.target.closest('.diagchip').classList.toggle('miss', !S.d.visit.diagnosis); toast('اتحفظ التشخيص'); } catch (er) { toastError(er); }
    });
    $('#closeV')?.addEventListener('click', async () => {
      try { S.d = await api.post(`/visits/${id}/close`); toast('الزيارة اتقفلت'); drawAll(); } catch (e) { toastError(e); }
    });
  };

  // ---------- الخدمات ----------
  const counts = () => Object.fromEntries(DEPT_KEYS.map((k) => [k, cat.services.filter((s) => s.dept === k).length]));
  const drawTabs = () => {
    const c = counts();
    $('#tabs').innerHTML = String(html`${isPharm ? '' : DEPT_KEYS.map((k) => html`<button class="dtab d-${k} ${S.dept === k && !S.q ? 'on' : ''}" data-dept="${k}">${icon(DEPT[k].icon, 'sm')} ${DEPT[k].name} <span class="n num">${c[k]}</span></button>`)}
      ${canStock && ST.stores.length ? html`<button class="dtab ${S.dept === 'stock' ? 'on' : ''}" data-dept="stock" style="--dc:${TCAT.drug.c}">${icon('pill', 'sm')} أدوية ومستلزمات</button>` : ''}`);
    $('#sq').placeholder = S.dept === 'stock' ? 'دوّر على دوا أو مستلزم' : 'دوّر على خدمة بالاسم أو الكود';
  };
  const unitsOf = (x) => [{ key: 'base', name: x.unit || 'وحدة', factor: 1 }, ...(x.midUnit && x.midQty ? [{ key: 'mid', name: x.midUnit, factor: x.midQty }] : []), ...(x.packUnit && x.packQty ? [{ key: 'pack', name: x.packUnit, factor: x.packQty }] : [])];
  const drawStock = () => {
    // زيارة عيادة: المخزن بيتحدد تلقائي من عيادة الدكتور (إلا لو الموظف اختار مخزن تاني بنفسه)
    const auto = S.d.visit.clinicStore;
    if (S.d.visit.type === 'clinic' && auto && !ST.manual && ST.storeId !== auto.id && ST.stores.some((x) => x.id === auto.id)) {
      ST.storeId = auto.id;
      api.get('/catalog/store-stock/' + auto.id).then((r) => { ST.stock = r.items; drawStock(); }).catch(() => {});
    }
    const q = searchKey(S.q);
    const st = ST.stores.find((x) => x.id === ST.storeId);
    let list = ST.items.filter((x) => !st || st.holds === 'all' || st.holds === x.kind);
    list = q ? list.filter((x) => searchKey(x.name + ' ' + x.code).includes(q)) : list.filter((x) => (ST.stock[x.id] || 0) > 0);
    const open = S.d.visit.status === 'open' && can('visits.write');
    $('#svcs').innerHTML = String(html`<div class="vst-bar" style="grid-column:1/-1">${icon('box', 'sm')} اتصرف من:
        ${ST.stores.filter((x) => !(S.d.visit.type === 'clinic' && x.clinic && x.id !== auto?.id)).map((x) => html`<button class="chip ${x.id === ST.storeId ? 'on' : ''}" data-vst="${x.id}">${x.name}</button>`)}${S.d.visit.type === 'clinic' && auto && !ST.manual ? html`<small class="muted" style="font-weight:700">تلقائي من عيادة الدكتور</small>` : ''}</div>
      ${list.slice(0, 60).map((x) => { const have = ST.stock[x.id] || 0; return html`<button class="svc stk-card" data-stk="${x.id}" style="--dc:${TCAT[x.kind].c};--ds:color-mix(in srgb, ${TCAT[x.kind].c} 10%, #fff)" ${open ? '' : 'disabled'}>
        <span class="plus">${icon('plus', 'sm')}</span><b>${x.name}</b>
        <div class="foot"><span class="price"><span class="num">${money(x.price)}</span> ${HMS.money.symbol} / ${x.unit}</span><span class="stk ${have <= 0 ? 'none' : ''}">${have <= 0 ? 'مش موجود' : unitsText(have, unitsOf(x))}</span></div></button>`; })}
      ${!list.length ? html`<div class="empty" style="grid-column:1/-1"><div class="art">${icon('box')}</div><b>${q ? 'مفيش صنف بالاسم ده' : 'المخزن ده فاضي'}</b>${q ? '' : 'دوّر بالاسم لو عايز صنف مش موجود'}</div>` : ''}`);
  };
  const addStock = async (x) => {
    const us = unitsOf(x);
    let unit = 'base', qty = 1;
    const dSale = us.some((k) => k.key === x.saleUnit) ? x.saleUnit : null;
    if (us.length > 1 || isPharm) {
      const r = await new Promise((resolve) => {
        let done = false, u = dSale || (us.length > 1 && isPharm ? us.at(-1).key : 'base');
        const m = modal({
          title: x.name,
          body: html`${us.length > 1 ? html`<div class="seg full" id="vu">${us.map((k) => html`<button data-u="${k.key}" class="${k.key === u ? 'on' : ''}">${k.name}${k.factor > 1 ? html` <small class="num">(${k.factor})</small>` : ''}</button>`)}</div>` : ''}
            <div class="field" style="margin-top:12px"><label>العدد</label><input class="input num" name="q" value="1" inputmode="numeric" autofocus style="font-size:22px;height:54px;font-weight:800;text-align:center"></div>
            <div class="muted" style="margin-top:8px;font-weight:700" id="vp"></div>`,
          foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('plus')} ضيف</button>`,
          onClose: () => { if (!done) resolve(null); },
        });
        const upd = () => { const k = us.find((z) => z.key === u); const n = Number($('[name=q]', m.el).value) || 0; $('#vp', m.el).textContent = `${n} × ${money(x.price * k.factor)} = ${money(n * x.price * k.factor)} ${HMS.money.symbol}`; };
        setTimeout(() => { $('[name=q]', m.el).select(); upd(); }, 40);
        const ok = () => { done = true; const n = Number(String($('[name=q]', m.el).value).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632)); m.close(); resolve({ unit: u, qty: n }); };
        m.el.addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (b) { u = b.dataset.u; $$('[data-u]', m.el).forEach((z) => z.classList.toggle('on', z === b)); upd(); $('[name=q]', m.el).focus(); } if (e.target.closest('[data-ok]')) ok(); });
        m.el.addEventListener('input', upd);
        m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      });
      if (!r) return;
      unit = r.unit; qty = r.qty;
    }
    try {
      const r = await api.post(`/visits/${id}/items`, { stockItemId: x.id, unit, qty, storeId: ST.storeId });
      S.lastAdded = r.itemId; refresh(r);
      ST.stock = (await api.get('/catalog/store-stock/' + ST.storeId)).items; drawServices();
      toast(`اتضاف «${x.name}»`);
    } catch (er) { toastError(er); }
  };
  const drawServices = () => {
    if (S.dept === 'stock') return drawStock();
    const q = searchKey(S.q);
    let list = q ? cat.services.filter((s) => searchKey(s.name).includes(q) || s.code.toLowerCase().includes(q)) : cat.services.filter((s) => s.dept === S.dept);
    if (!q) list = [...list.filter((s) => s.quick), ...list.filter((s) => !s.quick)];
    const inBill = new Set(S.d.items.filter((i) => i.status === 'active' && !i.paid).map((i) => i.serviceId));
    $('#svcs').innerHTML = list.length ? String(html`${list.map((s) => html`
      <button class="svc d-${s.dept} ${inBill.has(s.id) ? 'added' : ''}" data-svc="${s.id}" ${S.d.visit.status !== 'open' || !can('visits.write') ? 'disabled' : ''}>
        <span class="plus">${icon(inBill.has(s.id) ? 'check' : 'plus', 'sm')}</span>
        <b>${s.name}</b>
        <div class="foot">
          <span class="price"><span class="num">${money(s.price)}</span> ${HMS.money.symbol}</span>
          ${s.hasDoctor ? html`<span class="doc-ic" title="محتاج دكتور">${icon('steth', 'sm')}</span>` : ''}
          <span class="tm ${s.payTiming}">${s.payTiming === 'before' ? 'دفع قبل' : 'دفع بعد'}</span>
        </div>
      </button>`)}`) : String(html`<div class="empty" style="grid-column:1/-1"><div class="art">${icon('search')}</div><b>مفيش خدمة بالاسم ده</b>جرّب كلمة تانية أو الكود</div>`);
  };

  // ---------- الحساب ----------
  const unpaid = () => S.d.items.filter((i) => i.status === 'active' && !i.paid && !i.pendingOrderId);
  const calc = () => {
    const gross = unpaid().filter((i) => S.sel.has(i.id)).reduce((s, i) => s + HMS.money.toMinor(i.patientAmount), 0);
    const disc = S.disc.on ? Math.min(HMS.money.toMinor(Number(S.disc.amount) || 0), gross) : 0;
    return { gross: gross / HMS.money.F, disc: disc / HMS.money.F, net: (gross - disc) / HMS.money.F };
  };

  const drawBill = () => {
    const items = S.d.items;
    const up = unpaid();
    const paid = items.filter((i) => i.status === 'active' && i.paid);
    const voided = items.filter((i) => i.status === 'voided' && i.paid);
    const open = S.d.visit.status === 'open';
    const editable = open && can('visits.write');
    const line = (i) => {
      const isUp = i.status === 'active' && !i.paid && !i.pendingOrderId;
      const inOrder = i.status === 'active' && !i.paid && i.pendingOrderId ? S.d.orders.find((o) => o.id === i.pendingOrderId) : null;
      return html`<div class="line ${inOrder ? 'inorder' : ''} ${i.paid && i.status === 'active' ? 'paid' : ''} ${i.status === 'voided' ? 'voided' : ''} ${S.lastAdded === i.id ? 'new' : ''}" data-item="${i.id}">
        ${isUp && can('cash.collect') ? html`<button class="chk ${S.sel.has(i.id) ? 'on' : ''}" data-tog="${i.id}" aria-label="ادفع البند ده">${icon('check')}</button>`
          : html`<span class="dtag d-${i.dept}" style="width:22px;height:22px;padding:0;justify-content:center">${icon(i.status === 'voided' ? 'x' : inOrder ? 'hourglass' : 'check', 'sm')}</span>`}
        <div class="nm"><b>${i.name}</b><small>
          ${i.doctorName ? html`<span>${icon('steth', 'sm')}${i.doctorName}</span>` : ''}
          ${isUp ? html`<span class="badge ${i.payTiming === 'after' ? 'warn' : ''}" style="height:19px;font-size:11px">${i.payTiming === 'before' ? 'يدفع قبل' : 'يدفع بعد'}</span>` : ''}
          ${inOrder ? html`<span class="badge py" style="height:19px;font-size:11px">في الخزينة · إذن <span class="num">${inOrder.no}</span></span>` : ''}
          ${i.paid && i.status === 'active' ? html`<span class="badge ok" style="height:19px;font-size:11px">مدفوع · إيصال <span class="num">${i.receiptNo}</span></span>` : ''}
          ${i.status === 'voided' ? html`<span>${i.voidReason}</span>` : ''}
          ${COVER[i.cover] && i.status === 'active' ? html`<span class="badge ${COVER[i.cover].cls}" style="height:19px;font-size:11px">${COVER[i.cover].name}${i.approval?.no ? html` · <span class="num">${i.approval.no}</span>` : ''}</span>` : ''}
          ${i.refundDue > 0 ? html`<span class="badge ok" style="height:19px;font-size:11px">مرتجع له <span class="num">${money(i.refundDue)}</span></span>` : ''}
          ${i.storeName ? html`<span>${icon('box', 'sm')}${i.storeName}</span>` : ''}
          ${i.returnedQty ? html`<span class="badge warn" style="height:19px;font-size:11px">اترجع <span class="num">${i.returnedQty}</span></span>` : ''}
          ${i.stockItemId && i.paid && i.status === 'active' && i.returnedQty < i.qty && can('stock.return') && !(i.payerAmount > 0) ? html`<button class="linkbtn" data-ret="${i.id}" style="font-size:12px">${icon('undo', 'sm')} مرتجع</button>` : ''}
        </small></div>
        <div class="am">
          ${i.payerAmount > 0 && i.status === 'active' ? html`<b>${egp(i.patientAmount)}</b><small class="pshare">${money(i.amount)} · الشركة <span class="num">${money(i.payerAmount)}</span></small>` : html`<b>${egp(i.amount)}</b>`}
          ${isUp && editable ? html`<div class="row" style="gap:4px;justify-content:flex-end;margin-top:3px">
            <span class="qty"><button data-qty="${i.id}" data-d="1" aria-label="زوّد">${icon('plus', 'sm')}</button><span class="num">${i.qty}</span><button data-qty="${i.id}" data-d="-1" aria-label="قلّل" ${i.qty <= 1 ? 'disabled' : ''}>${icon('minus', 'sm')}</button></span>
            <button class="rm" data-rm="${i.id}" title="شيل" aria-label="شيل">${icon('trash', 'sm')}</button></div>` : i.qty > 1 ? html`<small class="muted num">${i.qty} × ${money(i.unitPrice)}</small>` : ''}
        </div>
      </div>`;
    };
    const c = calc();
    const due = S.d.totals.due;
    const mg = cat.managers;
    const mgrSelect = (name, v) => html`<select class="select" name="${name}"><option value="">المدير اللي وافق</option>${mg.map((m) => html`<option value="${m.id}" ${String(v) === String(m.id) ? 'selected' : ''}>${m.name}</option>`)}</select>`;
    const change = S.method === 'cash' && S.cashGiven !== '' ? Number(S.cashGiven) - c.net : null;
    const splitCard = S.method === 'split' ? Math.max(0, HMS.money.round(c.net - (Number(S.split.cash) || 0))) : 0;

    $('#bill').innerHTML = String(html`
      <div class="bill-head"><h3>${icon('wallet')} الحساب</h3>
        <span class="spacer"></span>
        ${S.d.totals.paid ? html`<span class="badge ok">اتدفع <span class="num">${money(S.d.totals.paid)}</span></span>` : ''}
      </div>
      ${S.d.visit.payer && S.d.totals.total ? html`<div class="splitsum"><div><small>إجمالي الخدمات</small><b class="num">${money(S.d.totals.total)}</b></div>
        <div class="py"><small>على ${S.d.visit.payer.name}</small><b class="num">${money(S.d.totals.payer)}</b></div>
        <div class="pt"><small>على المريض</small><b class="num">${money(Math.max(0, S.d.totals.total - S.d.totals.payer))}</b></div></div>` : ''}
      ${S.d.totals.refundDue > 0 ? html`<div class="alertbar info" style="margin:0 0 8px;background:var(--ok-soft);color:var(--ok)">${icon('undo')}<span>الموافقة اتعتمدت: للمريض مرتجع <b class="num">${money(S.d.totals.refundDue)}</b> ${HMS.money.symbol}</span><span class="spacer"></span>${can('cash.collect') ? html`<button class="btn sm" id="refundDue" style="--c:var(--ok)">اصرف واطبع</button>` : ''}</div>` : ''}
      ${S.d.orders?.length ? html`<div class="orders-mini">${S.d.orders.map((o) => html`<div class="omini">
          <span class="ono num">${o.no}</span><div style="min-width:0"><b>${o.amount < 0 ? 'إذن صرف' : 'إذن دفع'} مستني الخزينة</b><small>${o.createdBy} · ${fmtTime(o.createdAt)}</small></div>
          <b class="num" style="margin-inline-start:auto">${money(Math.abs(o.amount))} ${HMS.money.symbol}</b>
          <button class="btn ghost icon sm" data-oprint="${o.id}" title="اطبع الإذن">${icon('print', 'sm')}</button>
          ${o.createdById === state.me?.id || can('orders.cancelAny') ? html`<button class="btn ghost icon sm" data-ocancel="${o.id}" data-no="${o.no}" title="الغي الإذن">${icon('x', 'sm')}</button>` : ''}
        </div>`)}</div>` : ''}
      <div class="lines">
        ${!items.length ? html`<div class="empty" style="padding:26px 10px"><div class="art">${icon('plus')}</div><b>اختار الخدمات</b>دوس على أي خدمة من اللي جنبك وهتنزل هنا</div>` : ''}
        ${up.map(line)}${items.filter((i) => i.status === 'active' && !i.paid && i.pendingOrderId).map(line)}${paid.map(line)}${voided.map(line)}
      </div>
      ${up.length && can('cash.collect') ? html`
      <div class="pay">
        <div class="sumrow"><span>الإجمالي ${S.sel.size !== up.length ? html`<span class="muted">(${S.sel.size} من ${up.length} بند)</span>` : ''}</span><b>${egp(c.gross)}</b></div>
        ${S.disc.on ? html`
          <div class="discbox">
            <div class="row" style="justify-content:space-between"><b style="font-size:13.5px">${icon('percent', 'sm')} خصم بتعليمات المدير</b><button class="linkbtn" data-disc-off style="color:var(--muted)">${icon('x', 'sm')} شيل الخصم</button></div>
            <div class="row" style="gap:6px">
              <input class="input num" name="discAmount" inputmode="decimal" placeholder="المبلغ" value="${S.disc.amount}" style="flex:1">
              ${[10, 25, 50].map((pc) => html`<button class="btn soft sm" data-pct="${pc}" style="--c:var(--warn)">${pc}%</button>`)}
            </div>
            <div class="two"><input class="input" name="discReason" placeholder="سبب الخصم (إجباري)" value="${S.disc.reason}">
            ${mgrSelect('discBy', S.disc.by)}</div>
          </div>
          <div class="sumrow disc"><span>الخصم</span><b>- ${egp(c.disc)}</b></div>` : can('cash.discount') ? html`<div><button class="linkbtn" data-disc-on>${icon('percent', 'sm')} إضافة خصم</button></div>` : ''}
        <div class="sumrow big"><span>المطلوب</span><b>${egp(c.net)}</b></div>
        ${ordering() ? html`<div class="dutybar">${icon('wallet', 'sm')}<span>الخزينة شغالة (<b>${S.duty.onDuty?.name}</b>): المريض يدفع هناك بإذن الدفع</span></div>
        <label class="row" style="gap:8px;font-weight:700;font-size:13px;cursor:pointer"><input type="checkbox" id="ordCredit" ${S.method === 'credit' ? 'checked' : ''}> المبلغ كله آجل (بموافقة المدير)</label>
        ${S.method === 'credit' ? html`<div class="creditbox">${mgrSelect('creditBy', S.creditBy)}</div>` : ''}` : html`
        <div class="seg full" id="methods">
          ${[['cash', 'نقدي', 'cash'], ['card', 'فيزا', 'card'], ['split', 'الاتنين', 'split'], ['credit', 'آجل', 'hourglass']].map(([k, n, ic]) => html`<button data-m="${k}" class="${S.method === k ? 'on' : ''}">${icon(ic, 'sm')}${n}</button>`)}
        </div>
        ${S.method === 'cash' ? html`<div class="row" style="gap:8px"><input class="input num" name="cashGiven" inputmode="decimal" placeholder="المريض دفع كام؟ (اختياري)" value="${S.cashGiven}" style="flex:1">
          ${[50, 100, 200, 500].filter((x) => x >= c.net).slice(0, 2).map((x) => html`<button class="btn ghost sm" data-given="${x}"><span class="num">${x}</span></button>`)}</div>
          ${change != null ? html`<div class="change ${change < 0 ? 'neg' : ''}"><span>${change < 0 ? 'ناقص' : 'الباقي للمريض'}</span><b class="num" style="font-size:19px">${money(Math.abs(change))} ${HMS.money.symbol}</b></div>` : ''}` : ''}
        ${S.method === 'split' ? html`<div class="splitbox"><div class="field"><label>${icon('cash', 'sm')} نقدي</label><input class="input num" name="splitCash" inputmode="decimal" value="${S.split.cash}"></div>
          <div class="field"><label>${icon('card', 'sm')} فيزا</label><input class="input num" value="${money(splitCard)}" disabled></div></div>` : ''}
        ${S.method === 'credit' ? html`<div class="creditbox"><b style="font-size:13.5px">${icon('hourglass', 'sm')} آجل: المريض هيدفع بعدين</b>${mgrSelect('creditBy', S.creditBy)}</div>` : ''}
        ${S.method !== 'credit' ? html`<input class="input num" name="manualNo" placeholder="رقم الإيصال اليدوي (لو فيه)" value="${S.manualNo}" style="height:40px;font-size:14px">` : ''}`}
        <button class="btn block paybtn ${ordering() && S.method !== 'credit' ? 'ord' : ''}" id="payBtn" ${!S.sel.size || S.busy ? 'disabled' : ''}>${ordering() && S.method !== 'credit' ? html`${icon('wallet')} اعمل إذن دفع للخزينة` : html`${icon('check')} ادفع واطبع الإيصال`} <span class="kb">Ctrl+Enter</span></button>
        <label class="row muted" style="gap:6px;font-size:12.5px;font-weight:700;cursor:pointer;justify-content:center"><input type="checkbox" id="ap" ${autoPrint() ? 'checked' : ''}> ${ordering() ? 'اطبع الإذن على طول' : 'اطبع الإيصال على طول بعد الدفع'}</label>
      </div>` : due === 0 && items.some((i) => i.status === 'active') ? html`<div class="pay"><div class="alertbar info" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}<span>الحساب خالص</span></div></div>` : ''}
      ${S.d.receipts.length ? html`<div class="receipts-mini">${S.d.receipts.map((r) => html`
        <div class="rmini ${r.kind !== 'payment' ? 'refund' : ''} ${r.reversed ? 'reversed' : ''}">
          ${icon(r.kind !== 'payment' ? 'undo' : 'receipt', 'sm')}
          <span>${r.kind === 'refund' ? 'مرتجع' : r.kind === 'return' ? 'مرتجع تعاقد' : 'إيصال'} <span class="num">${r.no}</span></span>
          <span class="muted" style="font-weight:600">${fmtTime(r.createdAt)}</span>
          <span class="spacer"></span><b>${egp(r.net)}</b>
          <button class="btn ghost icon sm" data-print="${r.id}" title="اطبع">${icon('print', 'sm')}</button>
          ${r.kind === 'payment' && !r.reversed && (can('receipts.cancelAny') || can('receipts.cancelOwnOpenShift')) ? html`<button class="btn ghost icon sm" data-cancel="${r.id}" data-no="${r.no}" title="إلغاء الإيصال">${icon('undo', 'sm')}</button>` : ''}
        </div>`)}</div>` : ''}`);
  };

  // شريط الحساب للموبايل (الحساب بيبقى تحت الخدمات)
  const mob = el(html`<button class="mobpay hide" type="button"></button>`);
  view.append(mob);
  mob.addEventListener('click', () => $('#bill').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const drawMob = () => {
    const due = S.d.totals.due, n = unpaid().length;
    mob.classList.toggle('hide', !n);
    view.classList.toggle('has-mobpay', !!n);
    mob.innerHTML = String(html`${icon('wallet')}<div style="text-align:start"><small style="display:block;font-size:11.5px;opacity:.75">${n} بند لسه ما اتدفعش</small><b>${egp(due)}</b></div><span class="go">الحساب ↓</span>`);
  };
  const _drawBill = drawBill;
  const drawBillAll = () => { _drawBill(); drawMob(); };

  const drawAll = () => { drawStrip(); drawTabs(); drawServices(); drawBillAll(); };
  drawAll();

  const refresh = (d) => {
    const before = new Set(S.d.items.map((i) => i.id));
    S.d = d;
    for (const i of d.items) if (i.status === 'active' && !i.paid && !before.has(i.id)) S.sel.add(i.id);
    for (const sid of [...S.sel]) if (!unpaid().some((i) => i.id === sid)) S.sel.delete(sid);
    drawStrip(); drawServices(); drawBillAll();
  };

  // ---------- إضافة خدمة ----------
  const addService = async (svc, doctorId, approval) => {
    try {
      const r = await api.post(`/visits/${id}/items`, { serviceId: svc.id, doctorId, approval: approval ? { mode: approval.mode, no: approval.no, date: approval.date } : undefined });
      S.lastAdded = r.itemId;
      refresh(r);
      setTimeout(() => { S.lastAdded = null; }, 1200);
      if (approval?.file) {
        const ap = r.items.find((i) => i.id === r.itemId)?.approval;
        if (ap) uploadApprovalImage(ap.id, approval.file).then(() => toast('اترفعت صورة الموافقة')).catch(toastError);
      }
      if (approval) toast(approval.mode === 'tempcash' ? 'اتضافت نقدي مؤقت لحد ما الموافقة توصل' : 'اتضافت ومستنية مراجعة الموافقة', 'info');
    } catch (e) {
      if (e instanceof ApiError && e.data?.needsApproval && !approval) {
        const a = await askApproval({ service: svc.name, payerName: S.d.visit.payer?.name || 'التعاقد', payerAmount: e.data.payerAmount, amount: e.data.amount });
        if (a) addService(svc, doctorId, a);
        return;
      }
      toastError(e);
    }
  };
  const pickDoctor = (svc) => {
    const docs = cat.doctors;
    const m = modal({
      title: `اختار الدكتور · ${svc.name}`, wide: true,
      body: html`<div class="big-search" style="margin-bottom:12px">${icon('search')}<input class="input" id="dq" placeholder="اسم الدكتور أو التخصص" style="height:46px;font-size:15px;padding-inline-start:46px" autofocus autocomplete="off"></div><div id="dl"></div>`,
    });
    const draw = (q = '') => {
      const k = searchKey(q);
      const list = docs.filter((d) => !k || searchKey(d.name + ' ' + (d.specialty || '')).includes(k));
      const group = (title, arr) => arr.length ? html`<div class="muted" style="font-weight:800;font-size:13px;margin:6px 2px 8px">${title}</div><div class="docs" style="margin-bottom:12px">${arr.map((d) => html`
        <button class="doc ${d.presentNow ? 'now' : ''} ${d.today ? '' : 'off'}" data-doc="${d.id}">
          <span class="dav">${initials(d.name)}<i></i></span>
          <div><b>${d.name}</b><small>${d.specialty || ''}${d.slots.length ? ' · ' + d.slots.map(fmtSlot).join('، ') : ''}</small></div>
        </button>`)}</div>` : '';
      $('#dl', m.el).innerHTML = String(html`
        ${group('موجودين دلوقتي', list.filter((d) => d.presentNow))}
        ${group('في جدول النهارده', list.filter((d) => d.today && !d.presentNow))}
        ${group('مش في جدول النهارده', list.filter((d) => !d.today))}
        ${!list.length ? html`<div class="empty">مفيش دكتور بالاسم ده</div>` : ''}`);
    };
    draw();
    $('#dq', m.el).addEventListener('input', (e) => draw(e.target.value));
    $('#dq', m.el).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-doc]', m.el)?.click(); });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-doc]');
      if (b) { m.close(); addService(svc, Number(b.dataset.doc)); }
    });
  };

  // ---------- الدفع ----------
  const pay = async () => {
    if (S.busy) return;
    const c = calc();
    const body = { itemIds: [...S.sel], discount: c.disc, cash: 0, card: 0, credit: 0, manualNo: S.manualNo };
    if (S.disc.on && c.disc > 0) { body.discountReason = S.disc.reason; body.discountApprovedBy = S.disc.by; }
    if (ordering() && S.method !== 'credit') S.method = 'order';
    if (S.method === 'cash') body.cash = c.net;
    if (S.method === 'card') body.card = c.net;
    if (S.method === 'credit') { body.credit = c.net; body.creditApprovedBy = S.creditBy; }
    if (S.method === 'split') {
      body.cash = Number(S.split.cash) || 0;
      body.card = HMS.money.round((c.net - body.cash));
      if (body.card < 0) return toast('النقدي أكبر من المطلوب', 'err');
    }
    if (S.method === 'cash' && S.cashGiven !== '' && Number(S.cashGiven) < c.net) return toast('المبلغ اللي المريض دفعه أقل من المطلوب', 'err');
    S.busy = true; drawBill();
    try {
      const r = await api.post(`/visits/${id}/pay`, body);
      if (r.order) {
        S.disc = { on: false, amount: '', reason: '', by: '' }; S.method = 'cash'; S.creditBy = ''; S.busy = false;
        refresh(r); window.refreshShell?.();
        showOrder(r.order, { autoPrint: autoPrint() });
        return;
      }
      S.manualNo = '';
      const changeAmt = S.method === 'cash' && S.cashGiven !== '' ? Number(S.cashGiven) - c.net : null;
      S.disc = { on: false, amount: '', reason: '', by: '' }; S.cashGiven = ''; S.split = { cash: '', card: '' }; S.method = 'cash'; S.creditBy = '';
      S.busy = false;
      refresh(r);
      window.refreshShell?.();
      if (autoPrint()) printReceipt(r.receiptId, true);
      showSuccess(r.receipt, changeAmt);
    } catch (e) {
      S.busy = false; if (S.method === 'order') S.method = 'cash'; drawBill();
      if (e.status === 403 || /الخزينة/.test(e.message || '')) S.duty = await cashierDuty(true).catch(() => S.duty);
      if (e.status === 409) { try { refresh(await api.get('/visits/' + id)); } catch { /* */ } }
      toastError(e);
    }
  };
  const showSuccess = (rc, changeAmt) => {
    const m = modal({
      title: '',
      body: html`<div class="success">
        <div class="tick">${icon('check')}</div>
        <h3>تم الدفع</h3>
        <div class="rno">إيصال رقم <b class="num">${rc.no}</b> · <b class="num">${money(rc.net)}</b> ${HMS.money.unitWord}</div>
        ${changeAmt != null && changeAmt > 0 ? html`<div class="change" style="margin:14px auto 0;max-width:280px"><span>الباقي للمريض</span><b class="num" style="font-size:22px">${money(changeAmt)} ${HMS.money.symbol}</b></div>` : ''}
      </div>`,
      foot: html`<button class="btn ghost" data-print>${icon('print')} ${autoPrint() ? 'اطبع تاني' : 'اطبع الإيصال'}</button><a class="btn soft" href="#/patients" data-close>${icon('user-plus')} المريض اللي بعده</a><button class="btn" data-close autofocus>تمام</button>`,
    });
    $('.modal-head h3', m.el).remove();
    $('[data-print]', m.el).addEventListener('click', () => printReceipt(rc.id, true));
  };

  // ---------- الأحداث ----------
  const onClick = async (e) => {
    const t = e.target;
    const vst = t.closest('[data-vst]');
    if (vst) { ST.storeId = Number(vst.dataset.vst); ST.manual = ST.storeId !== S.d.visit.clinicStore?.id; localStorage.setItem('vstore:' + S.d.visit.type, ST.storeId); ST.stock = (await api.get('/catalog/store-stock/' + ST.storeId)).items; drawServices(); return; }
    const sk = t.closest('[data-stk]');
    if (sk) return addStock(ST.items.find((x) => x.id === Number(sk.dataset.stk)));
    const rt = t.closest('[data-ret]');
    if (rt) {
      const it = S.d.items.find((i) => i.id === Number(rt.dataset.ret));
      const left = it.qty - it.returnedQty;
      const m = modal({
        title: `مرتجع «${it.name}»`,
        body: html`<div class="field"><label>العدد اللي راجع <span class="hint">من ${left}</span></label><input class="input num" name="q" value="${left}" autofocus style="font-size:20px;height:50px;font-weight:800;text-align:center"></div>
          <div class="field" style="margin-top:10px"><label>السبب <span class="req">*</span></label><input class="input" name="r" placeholder="مثلًا: الدكتور غيّر العلاج"></div>
          <div class="alertbar info" style="margin-top:10px">${icon('info')}<span>الفلوس بترجع للمريض نقدي من درجك، والصنف بيرجع للمخزن.</span></div>`,
        foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--warn)">${icon('undo')} اعمل المرتجع</button>`,
      });
      $('[data-ok]', m.el).addEventListener('click', async () => {
        try {
          const r = await api.post(`/visits/${id}/items/${it.id}/return`, { qty: $('[name=q]', m.el).value, reason: $('[name=r]', m.el).value });
          m.close(); refresh(r); window.refreshShell?.(); toast('اتعمل المرتجع');
          if (ST.storeId) { ST.stock = (await api.get('/catalog/store-stock/' + ST.storeId)).items; drawServices(); }
          if (autoPrint()) printReceipt(r.refundId, true);
        } catch (er) { toastError(er); }
      });
      return;
    }
    const tab = t.closest('[data-dept]');
    if (tab) { S.dept = tab.dataset.dept; S.q = ''; $('#sq').value = ''; drawTabs(); drawServices(); return; }
    const sv = t.closest('[data-svc]');
    if (sv) {
      const svc = cat.services.find((s) => s.id === Number(sv.dataset.svc));
      if (svc.hasDoctor) pickDoctor(svc); else addService(svc);
      return;
    }
    const tog = t.closest('[data-tog]');
    if (tog) { const i = Number(tog.dataset.tog); S.sel.has(i) ? S.sel.delete(i) : S.sel.add(i); drawBill(); return; }
    const q = t.closest('[data-qty]');
    if (q) {
      const it = S.d.items.find((i) => i.id === Number(q.dataset.qty));
      const n = it.qty + Number(q.dataset.d);
      if (n < 1) return;
      try { refresh(await api.put(`/visits/${id}/items/${it.id}`, { qty: n })); } catch (er) { toastError(er); }
      return;
    }
    const rm = t.closest('[data-rm]');
    if (rm) {
      const it = S.d.items.find((i) => i.id === Number(rm.dataset.rm));
      try {
        refresh(await api.del(`/visits/${id}/items/${it.id}`));
        toast(`اتشال «${it.name}»`, 'info');
        if (it.stockItemId && ST.storeId) { ST.stock = (await api.get('/catalog/store-stock/' + ST.storeId)).items; drawServices(); }
      } catch (er) { toastError(er); }
      return;
    }
    if (t.closest('[data-disc-on]')) { S.disc.on = true; drawBill(); $('[name="discAmount"]')?.focus(); return; }
    if (t.closest('[data-disc-off]')) { S.disc = { on: false, amount: '', reason: '', by: '' }; drawBill(); return; }
    const pc = t.closest('[data-pct]');
    if (pc) { S.disc.amount = String(HMS.money.percentValue(calc().gross, Number(pc.dataset.pct))); drawBill(); return; }
    const mm = t.closest('[data-m]');
    if (mm) { S.method = mm.dataset.m; drawBill(); return; }
    const gv = t.closest('[data-given]');
    if (gv) { S.cashGiven = gv.dataset.given; drawBill(); return; }
    if (t.closest('#payBtn')) { pay(); return; }
    if (t.closest('#refundDue')) {
      try {
        const r = await api.post(`/visits/${id}/refund-due`); refresh(r); window.refreshShell?.();
        if (r.order) showOrder(r.order, { autoPrint: autoPrint() }); else { toast('اتصرف المرتجع'); printReceipt(r.receiptId, true); }
      } catch (er) { toastError(er); }
      return;
    }
    const op = t.closest('[data-oprint]');
    if (op) { printOrder(op.dataset.oprint); return; }
    const oc = t.closest('[data-ocancel]');
    if (oc) {
      const reason = await askReason({ title: `إلغاء إذن ${oc.dataset.no}`, label: 'السبب', confirm: 'الغي الإذن', note: 'البنود هترجع تتدفع تاني.' });
      if (!reason) return;
      try { await api.post(`/orders/${oc.dataset.ocancel}/cancel`, { reason }); refresh(await api.get('/visits/' + id)); window.refreshShell?.(); toast('اتلغى الإذن', 'info'); } catch (er) { toastError(er); }
      return;
    }
    const pr = t.closest('[data-print]');
    if (pr && pr.closest('#bill')) { printReceipt(pr.dataset.print, false); return; }
    const cn = t.closest('[data-cancel]');
    if (cn) {
      const reason = await askReason({
        title: `إلغاء إيصال رقم ${cn.dataset.no}`, label: 'سبب الإلغاء', confirm: 'ألغِ الإيصال',
        note: 'هيطلع إيصال مرتجع بنفس المبلغ، والخدمات اللي فيه هتتلغي. العملية دي متسجلة باسمك.',
      });
      if (!reason) return;
      try {
        const r = await api.post(`/receipts/${cn.dataset.cancel}/cancel`, { reason });
        refresh(r); window.refreshShell?.();
        toast('اتعمل إيصال مرتجع');
        if (autoPrint()) printReceipt(r.refundId, true);
      } catch (er) { toastError(er); }
    }
  };
  const onInput = (e) => {
    const t = e.target;
    if (t.id === 'sq') { S.q = t.value; drawTabs(); drawServices(); return; }
    // الحقول اللي جوه الحساب: نحدّث الحالة من غير ما نرسم الحقل نفسه تاني
    const n = t.name;
    if (n === 'discAmount') S.disc.amount = t.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632);
    else if (n === 'discReason') { S.disc.reason = t.value; return; }
    else if (n === 'manualNo') { S.manualNo = t.value; return; }
    else if (n === 'cashGiven') S.cashGiven = t.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632);
    else if (n === 'splitCash') S.split.cash = t.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632);
    else return;
    redrawKeepFocus(t);
  };
  const redrawKeepFocus = debounce((t) => {
    const name = t.name, pos = t.selectionStart;
    drawBill();
    const n = $(`[name="${name}"]`);
    if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* */ } }
  }, 250);
  const onChange = (e) => {
    const t = e.target;
    if (t.name === 'discBy') S.disc.by = t.value;
    if (t.name === 'creditBy') S.creditBy = t.value;
    if (t.id === 'ordCredit') { S.method = t.checked ? 'credit' : 'cash'; drawBill(); }
    if (t.id === 'ap') { localStorage.setItem('autoPrint', t.checked ? '1' : '0'); }
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.overlay')) { e.preventDefault(); if (unpaid().length) pay(); }
    if (e.target.id === 'sq' && e.key === 'Enter') { $('#svcs .svc')?.click(); }
  };
  view.addEventListener('click', onClick);
  view.addEventListener('input', onInput);
  view.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);
  return () => {
    view.removeEventListener('click', onClick);
    view.removeEventListener('input', onInput);
    view.removeEventListener('change', onChange);
    document.removeEventListener('keydown', onKey);
    view.classList.remove('has-mobpay');
  };
}
