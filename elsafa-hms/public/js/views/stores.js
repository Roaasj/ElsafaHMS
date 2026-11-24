// المخازن: الأرصدة بالتشغيلات والصلاحية، التحويلات بخطواتها، الاستلام من الموردين، وتعريف المخازن
import {
  api, html, icon, $, $$, money, egp, fmtWhen, fmtTime, modal, toast, toastError, askReason, can, debounce, ApiError,
  unitsText, TR_ST, TCAT, state,
} from '../core.js';
import { searchKey, latinDigits } from '/shared/text.js';
import { itemsPane } from './accounts.js';

const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: HMS.tz });
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };
const dShort = (d) => (d ? `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}/${d.slice(2, 4)}` : '—');
const expCls = (d) => (!d ? '' : d < todayStr() ? 'exp-bad' : d <= addDays(todayStr(), 90) ? 'exp-soon' : 'exp-ok');
const K_IC = { main: 'layers', pharmacy: 'pill', sub: 'door' };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } } };

let metaCache = null;
async function meta(force = false) {
  if (!metaCache || force) metaCache = await api.get('/stores/meta');
  return metaCache;
}
let itemsCache = null;
async function allItems() {
  if (!itemsCache) itemsCache = (await api.get('/tickets/items')).items;
  return itemsCache;
}

export async function renderStores(view, { query, setTitle }) {
  const M = await meta(true);
  const tabs = [['stock', 'الأرصدة', 'layers'], ['transfers', 'التحويلات', 'arrows'], ...(M.can.purchase || M.can.all ? [['purchases', 'الاستلام من الموردين', 'download']] : []), ['counts', 'الجرد والإعدام', 'clipboard'], ...(can('stock.edit') ? [['items', 'الأصناف', 'pill']] : []), ...(can('reports.stock') || can('reports.pharmacy') ? [['reports', 'التقارير', 'chart']] : []), ...(M.can.manage ? [['setup', 'تعريف المخازن', 'settings']] : [])];
  const tab = tabs.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'stock';
  setTitle('المخازن', { stock: 'الرصيد والصلاحية في كل مخزن', transfers: 'طلب ← صرف ← استلام ← تأكيد', purchases: 'فواتير الموردين ورصيد أول المدة', setup: 'المخازن الرئيسية والصيدلية ومخازن الأدوار والأقسام', counts: 'الجرد اليدوي واعتماد الفروق، والأصناف التالفة', reports: 'القيمة والاستهلاك والبيع والصلاحية', items: 'إضافة وتعديل الأصناف ووحداتها وأسعارها' }[tab]);
  view.innerHTML = String(html`<nav class="stabs">${tabs.map(([k, n, ic]) => html`<a href="#/stores?tab=${k}" class="stab ${tab === k ? 'on' : ''}">${icon(ic)}<span>${n}</span>${k === 'transfers' ? html`<b class="badge warn hide" id="trBadge"></b>` : ''}</a>`)}</nav><div id="sp"></div>`);
  api.get('/stores/counts').then((c) => { const b = $('#trBadge'); if (b) { b.textContent = c.total; b.classList.toggle('hide', !c.total); } }).catch(() => {});
  const pane = $('#sp', view);
  if (tab === 'transfers') return transfersPane(pane, M);
  if (tab === 'purchases') return purchasesPane(pane, M);
  if (tab === 'setup') return setupPane(pane, M);
  if (tab === 'items') return itemsPane(pane);
  if (tab === 'counts') return countsPane(pane, M);
  if (tab === 'reports') return reportsPane(pane, M, query);
  return stockPane(pane, M, query);
}

// ================= الأرصدة =================
async function stockPane(pane, M, query) {
  const mine = M.stores.filter((s) => s.active && (s.mine || M.can.all));
  const S = { store: query.get('store') || store.get('stStore') || (M.can.all ? 'all' : String(mine[0]?.id || '')), f: 'stock', q: '', d: null };
  if (S.store !== 'all' && !mine.some((s) => String(s.id) === S.store)) S.store = M.can.all ? 'all' : String(mine[0]?.id || '');
  if (!mine.length) { pane.innerHTML = String(html`<div class="card empty"><div class="art">${icon('layers')}</div><b>مفيش مخازن مربوطة بيك</b>المدير يربطك بمخزن من الإعدادات ← المستخدمين</div>`); return; }
  const cur = () => M.stores.find((s) => String(s.id) === S.store);
  pane.innerHTML = String(html`<div class="st-top">
      <div class="st-stores" id="sts"></div>
      <div class="st-acts" id="sta"></div></div>
    <div class="acc-kpis st-kpis" id="stk"></div>
    <div class="row wrap" style="gap:10px;margin:12px 0">
      <div class="chips" id="stf"></div>
      <div class="big-search" style="flex:1 1 220px;max-width:340px;margin-inline-start:auto">${icon('search')}<input class="input" id="stq" type="search" placeholder="اسم الصنف أو الكود" style="height:42px;padding-inline-start:42px;border-radius:12px"></div>
    </div><div id="stl"><div class="skel" style="height:240px"></div></div>`);
  const FILT = [['stock', 'فيها رصيد'], ['low', 'تحت حد الطلب'], ['expiring', 'قربت تنتهي'], ['negative', 'سالب'], ['all', 'كل الأصناف']];
  const drawTop = () => {
    // 3 أزرار ثابتة (أدوية رئيسي، مستلزمات رئيسي، الصيدلية) + «مخازن أخرى» بقايمة وبحث
    const fx = [mine.find((x) => x.kind === 'main' && x.holds === 'drug'), mine.find((x) => x.kind === 'main' && x.holds === 'supply'), mine.find((x) => x.kind === 'pharmacy')].filter(Boolean);
    const rest = mine.filter((x) => !fx.includes(x));
    const q = searchKey(S.mq || '');
    const others = [...(M.can.all ? [{ id: 'all', name: 'كل المخازن', kind: 'main' }] : []), ...rest].filter((x) => !q || searchKey(x.name).includes(q));
    const inRest = S.store === 'all' ? M.can.all : rest.some((x) => String(x.id) === S.store);
    const curName = S.store === 'all' ? 'كل المخازن' : rest.find((x) => String(x.id) === S.store)?.name;
    $('#sts', pane).innerHTML = String(html`${fx.map((s) => html`<button class="st-chip k-${s.kind} ${S.store === String(s.id) ? 'on' : ''}" data-st="${s.id}">${icon(K_IC[s.kind], 'sm')} ${s.name}</button>`)}
      ${others.length || S.mq ? html`<div class="st-more"><button class="st-chip k-more ${inRest ? 'on' : ''}" data-menu>${icon('layers', 'sm')} ${inRest ? curName : 'مخازن أخرى'} ▾</button>
        ${S.menu ? html`<div class="st-pop"><input class="input" data-mq type="search" placeholder="دوّر على مخزن" value="${S.mq || ''}" autofocus>
          <div class="st-pl">${others.map((x) => html`<button data-st="${x.id}" class="${S.store === String(x.id) ? 'on' : ''}">${icon(K_IC[x.kind], 'sm')} ${x.name}</button>`)}${!others.length ? html`<div class="muted" style="padding:8px">مفيش نتيجة</div>` : ''}</div></div>` : ''}</div>` : ''}`);
    if (S.menu) { const i = $('[data-mq]', pane); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    const c = cur();
    $('#sta', pane).innerHTML = String(html`
      ${M.can.request && c && (c.mine || M.can.all) ? html`<button class="btn soft" data-a="request">${icon('send')} اطلب تحويل</button>` : ''}
      ${M.can.issue && c && (c.mine || M.can.all) && c.kind !== 'sub' ? html`<button class="btn soft" data-a="issue" style="--c:var(--py)">${icon('arrows')} حوّل لمخزن</button>` : ''}
      ${M.can.purchase && c && c.kind !== 'sub' ? html`<button class="btn" data-a="purchase">${icon('download')} استلام من مورد</button>` : ''}`);
    $('#stf', pane).innerHTML = String(html`${FILT.map(([k, n]) => html`<button class="chip ${S.f === k ? 'on' : ''}" data-f="${k}">${n}${S.d?.counts && { low: S.d.counts.low, expiring: S.d.counts.expiring, negative: S.d.counts.negative }[k] ? html` <b class="num" style="color:${k === 'stock' ? 'inherit' : 'var(--danger)'}">${{ low: S.d.counts.low, expiring: S.d.counts.expiring, negative: S.d.counts.negative }[k]}</b>` : ''}</button>`)}`);
  };
  const draw = () => {
    const d = S.d, c = d.counts;
    const fz = M.counting.find((x) => String(x.storeId) === S.store);
    $('#stk', pane).innerHTML = String(html`${fz ? html`<div class="alertbar warn freeze-bar" style="grid-column:1/-1">${icon('lock')}<span><b>المخزن واقف للجرد</b> (جرد رقم <span class="num">${fz.no}</span>). مفيش صرف ولا تحويل ولا استلام لحد ما المدير يعتمد.</span><span class="spacer"></span><a class="btn sm" href="#/stores?tab=counts">افتح الجرد</a></div>` : ''}
      <div class="akpi"><span class="gi">${icon('box')}</span><div><small>أصناف فيها رصيد</small><b class="num">${c.items}</b></div></div>
      <button class="akpi warn" data-f="low"><span class="gi">${icon('alert')}</span><div><small>تحت حد الطلب</small><b class="num">${c.low}</b></div></button>
      <button class="akpi late" data-f="expiring"><span class="gi">${icon('clock')}</span><div><small>صلاحيتها قربت (3 شهور)</small><b class="num">${c.expiring}</b></div></button>
      <button class="akpi danger" data-f="negative"><span class="gi">${icon('minus')}</span><div><small>رصيد سالب</small><b class="num">${c.negative}</b></div></button>`);
    drawTop();
    $('#stl', pane).innerHTML = !d.items.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${S.f === 'stock' ? 'المخزن فاضي' : 'مفيش أصناف هنا'}</b>${S.f === 'stock' && M.can.purchase ? 'ابدأ برصيد أول المدة من «استلام من مورد»' : ''}</div>`)
      : String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table">
        <thead><tr><th>الصنف</th><th>الرصيد</th><th>أقرب صلاحية</th><th class="n">حد الطلب</th><th></th></tr></thead><tbody>
        ${d.items.map((x) => html`<tr class="click ${x.negative ? 'neg-row' : x.low ? 'low-row' : ''}" data-item="${x.id}">
          <td><span class="dtag" style="--ds:color-mix(in srgb, ${TCAT[x.kind].c} 12%, #fff);--dc:${TCAT[x.kind].c};width:24px;height:24px;padding:0;justify-content:center;margin-inline-end:8px">${icon(TCAT[x.kind].icon, 'sm')}</span><b>${x.name}</b> <span class="code num">${x.code}</span></td>
          <td><b class="num st-qty ${x.qty < 0 ? 'neg' : x.low ? 'low' : ''}">${unitsText(x.qty, x.units)}</b>${x.units.length > 1 && Math.abs(x.qty) >= x.units[1].factor ? html`<div class="muted num" style="font-size:11.5px">${x.qty} ${x.units[0].name}</div>` : ''}</td>
          <td>${x.nearestExpiry ? html`<span class="exp ${expCls(x.nearestExpiry)}">${dShort(x.nearestExpiry)}</span>` : html`<span class="muted">—</span>`}${x.expired ? html` <span class="badge danger">منتهي ${x.expired}</span>` : ''}</td>
          <td class="n num muted">${x.minQty == null ? '—' : unitsText(x.minQty, x.units)}</td>
          <td class="n">${icon('chev-left', 'sm')}</td></tr>`)}</tbody></table></div>
        ${d.total > d.items.length ? html`<div class="muted" style="padding:8px;font-weight:600">بيظهر أول ${d.items.length} من ${d.total}. دوّر بالاسم.</div>` : ''}</div>`);
  };
  const load = async () => { S.d = await api.get(`/stores/stock?storeId=${S.store}&filter=${S.f}${S.q ? '&q=' + encodeURIComponent(S.q) : ''}`); draw(); };
  pane.addEventListener('input', (e) => { if (e.target.matches('[data-mq]')) { S.mq = e.target.value; drawTop(); } });
  pane.onclick = (e) => {
    if (e.target.closest('[data-menu]')) { S.menu = !S.menu; S.mq = ''; return drawTop(); }
    const st = e.target.closest('[data-st]');
    if (st) { S.store = st.dataset.st; S.menu = false; S.mq = ''; store.set('stStore', S.store); return load(); }
    if (S.menu && !e.target.closest('.st-more')) { S.menu = false; drawTop(); }
    const f = e.target.closest('[data-f]');
    if (f) { S.f = f.dataset.f; return load(); }
    const it = e.target.closest('[data-item]');
    if (it) return itemCard(Number(it.dataset.item), S.store);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'request') return transferModal({ M, mode: 'request', toId: Number(S.store), onDone: load });
    if (a === 'issue') return transferModal({ M, mode: 'issue', fromId: Number(S.store), onDone: load });
    if (a === 'purchase') return purchaseModal({ M, storeId: Number(S.store), onDone: load });
  };
  pane.oninput = debounce((e) => { if (e.target.id === 'stq') { S.q = e.target.value; load(); } }, 250);
  drawTop();
  await load();
  return () => { pane.onclick = pane.oninput = null; };
}

async function itemCard(id, storeId, M = metaCache) {
  const d = await api.get(`/stores/item/${id}${storeId && storeId !== 'all' ? '?storeId=' + storeId : ''}`);
  const it = d.item;
  const mm = modal({
    title: it.name, wide: true,
    body: html`<div class="row wrap" style="gap:8px;margin-bottom:12px"><span class="code num">${it.code}</span><span class="badge">${it.units.map((u) => (u.factor === 1 ? u.name : `${u.name} = ${u.factor} ${it.units[0].name}`)).join(' · ')}</span>
        <span class="badge">سعر البيع ${money(it.price)} ${HMS.money.symbol} / ${it.units[0].name}</span>${it.lastCost ? html`<span class="badge">آخر تكلفة ${money(it.lastCost)}</span>` : ''}</div>
      ${d.stores.length > 1 || storeId === 'all' ? html`<div class="chips" style="margin-bottom:12px">${d.stores.map((s) => html`<span class="chip">${s.name}: <b class="num">${unitsText(s.qty, it.units)}</b></span>`)}</div>` : ''}
      <h4 class="subh">${icon('box', 'sm')} التشغيلات</h4>
      <div class="table-wrap"><table class="table"><thead><tr><th>المخزن</th><th>التشغيلة</th><th>الصلاحية</th><th class="n">الكمية</th>${M?.can.waste ? html`<th></th>` : ''}</tr></thead><tbody>
        ${d.batches.map((b) => html`<tr><td>${b.store}</td><td class="num">${b.batchNo || html`<span class="muted">—</span>`}</td><td>${b.expiry ? html`<span class="exp ${expCls(b.expiry)}">${dShort(b.expiry)}</span>` : '—'}</td><td class="n num"><b class="${b.qty < 0 ? 'neg' : ''}">${unitsText(b.qty, it.units)}</b></td>
          ${M?.can.waste ? html`<td class="n">${b.qty > 0 ? html`<button class="btn ghost sm" data-waste="${b.id}" style="--c:var(--danger)">${icon('trash', 'sm')} إعدام</button>` : ''}</td>` : ''}</tr>`)}
        ${!d.batches.length ? html`<tr><td colspan="5"><div class="empty" style="padding:14px">مفيش رصيد</div></td></tr>` : ''}</tbody></table></div>
      <h4 class="subh">${icon('history', 'sm')} الحركات</h4>
      <div class="table-wrap" style="max-height:300px"><table class="table"><thead><tr><th>إمتى</th><th>الحركة</th><th>المخزن</th><th class="n">الكمية</th><th>مين</th></tr></thead><tbody>
        ${d.moves.map((m) => html`<tr><td class="muted" style="white-space:nowrap">${fmtWhen(m.at)}</td><td>${m.kindName}${m.note ? html` <small class="muted">· ${m.note}</small>` : ''}</td><td>${m.store}</td>
          <td class="n num"><b style="color:${m.qty < 0 ? 'var(--danger)' : 'var(--ok)'}">${m.qty > 0 ? '+' : ''}${m.qty}</b></td><td class="muted">${m.by || ''}</td></tr>`)}</tbody></table></div>`,
    foot: html`<button class="btn" data-close>تمام</button>`,
  });
  mm.el.addEventListener('click', (e) => {
    const w = e.target.closest('[data-waste]');
    if (!w) return;
    const b = d.batches.find((x) => x.id === Number(w.dataset.waste));
    const m = modal({
      title: `إعدام من «${it.name}»`,
      body: html`<div class="chips" style="margin-bottom:10px"><span class="chip">${b.store}</span>${b.batchNo ? html`<span class="chip">تشغيلة <span class="num">${b.batchNo}</span></span>` : ''}${b.expiry ? html`<span class="chip exp ${expCls(b.expiry)}">${dShort(b.expiry)}</span>` : ''}<span class="chip">موجود <b class="num">${b.qty}</b> ${it.units[0].name}</span></div>
        <div class="field"><label>الكمية (${it.units[0].name})</label><input class="input num" name="q" value="${b.qty}" style="font-size:20px;height:50px;font-weight:800;text-align:center" autofocus></div>
        <div class="field" style="margin-top:10px"><label>السبب <span class="req">*</span></label><div class="chips" style="margin-bottom:6px">${['منتهي الصلاحية', 'مكسور', 'تالف', 'سحب من الوزارة'].map((r) => html`<button type="button" class="chip" data-r="${r}">${r}</button>`)}</div><input class="input" name="r"></div>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--danger)">${icon('trash')} اعدم</button>`,
    });
    m.el.addEventListener('click', async (ev) => {
      const r = ev.target.closest('[data-r]');
      if (r) { $('[name=r]', m.el).value = r.dataset.r; return; }
      if (!ev.target.closest('[data-ok]')) return;
      try {
        const out = await api.post('/stores/waste', { batchId: b.id, qty: latinDigits($('[name=q]', m.el).value), reason: $('[name=r]', m.el).value });
        m.close(); mm.close(); toast(`اتسجل الإعدام رقم ${out.no}`);
      } catch (er) { toastError(er); }
    });
  });
}

// ================= سطور أصناف (للتحويل والاستلام) =================
function itemPicker(box, { kinds, onPick }) {
  box.innerHTML = String(html`<div class="big-search">${icon('search')}<input class="input" data-ip type="search" autocomplete="off" placeholder="اكتب اسم الصنف واضغط Enter" style="height:44px;padding-inline-start:42px;border-radius:12px"></div><div class="tk-results sm ip-res"></div>`);
  let list = [], sel = 0, pool = [];
  const inp = $('[data-ip]', box), res = $('.ip-res', box);
  allItems().then((xs) => { pool = xs.filter((x) => kinds.includes(x.kind)); });
  const compute = () => {
    const q = searchKey(inp.value);
    list = q ? pool.filter((x) => searchKey(x.name + ' ' + x.code).includes(q)).slice(0, 20) : [];
    if (sel >= list.length) sel = 0;
  };
  const draw = () => {
    compute();
    res.innerHTML = String(html`${list.map((x, i) => html`<button type="button" class="tk-res ${i === sel ? 'sel' : ''}" data-pk="${x.id}" style="--cc:${TCAT[x.kind].c}"><b>${x.name}</b><small>${x.unit}${x.packUnit ? ` · ${x.packUnit} = ${x.packQty}` : ''}</small></button>`)}`);
  };
  inp.addEventListener('input', () => { sel = 0; draw(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(list.length - 1, sel + 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); compute(); if (list[sel]) { onPick(list[sel]); inp.value = ''; draw(); } }
  });
  res.addEventListener('click', (e) => { const b = e.target.closest('[data-pk]'); if (b) { onPick(list.find((x) => x.id === Number(b.dataset.pk))); inp.value = ''; draw(); inp.focus(); } });
  return inp;
}
const unitsOfItem = (x) => [{ key: 'base', name: x.unit || 'وحدة', factor: 1 }, ...(x.midUnit && x.midQty ? [{ key: 'mid', name: x.midUnit, factor: x.midQty }] : []), ...(x.packUnit && x.packQty ? [{ key: 'pack', name: x.packUnit, factor: x.packQty }] : [])];
// الوحدة الافتراضية للشراء/التحويل: اللي اتحددت للصنف، وإلا الكبيرة لو موجودة (زي الأول)
const defBuy = (x) => (unitsOfItem(x).some((u) => u.key === x.purchaseUnit) ? x.purchaseUnit : x.packUnit ? 'pack' : 'base');
const unitSel = (x, v, attr) => { const us = unitsOfItem(x); return us.length < 2 ? html`<span class="muted" style="font-weight:700">${us[0].name}</span>` : html`<select class="select" ${attr} style="height:38px;min-width:90px">${us.map((u) => html`<option value="${u.key}" ${v === u.key ? 'selected' : ''}>${u.name}${u.factor > 1 ? ` (${u.factor})` : ''}</option>`)}</select>`; };

// ================= تحويل جديد (طلب أو صرف) =================
async function transferModal({ M, mode, fromId = null, toId = null, onDone }) {
  const active = M.stores.filter((s) => s.active);
  const myStores = active.filter((s) => s.mine || M.can.all);
  const X = { from: fromId || active.find((s) => s.kind === 'main' && s.id !== toId)?.id, to: toId || active.find((s) => s.kind === 'sub' && s.id !== fromId)?.id, lines: [], note: '', direct: false };
  const isReq = mode === 'request';
  const m = modal({
    title: isReq ? 'طلب تحويل' : 'تحويل لمخزن', wide: true,
    body: html`<div class="row wrap" style="gap:10px">
        <div class="field" style="flex:1 1 200px"><label>${isReq ? 'اطلب من' : 'من'}</label><select class="select" name="from">${(isReq ? active : myStores).map((s) => html`<option value="${s.id}" ${X.from === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></div>
        <div class="field" style="flex:1 1 200px"><label>${isReq ? 'لـ (مخزني)' : 'لـ'}</label><select class="select" name="to">${(isReq ? myStores : active).map((s) => html`<option value="${s.id}" ${X.to === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></div></div>
      <div id="tp" style="margin-top:12px"></div>
      <div id="tl" style="margin-top:10px"></div>
      <input class="input" name="note" placeholder="ملاحظة (اختياري)" style="margin-top:10px">
      ${!isReq && M.can.direct ? html`<label class="swl" style="margin-top:12px"><button type="button" class="switch" role="switch" data-direct aria-checked="false"></button><span>تحويل مباشر: يتسجل في المخزن التاني على طول من غير استلام</span></label>` : ''}`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon(isReq ? 'send' : 'arrows')} ${isReq ? 'ابعت الطلب' : 'اصرف التحويل'}</button>`,
  });
  const kindsFor = () => { const f = M.stores.find((s) => s.id === Number(X.from)), t = M.stores.find((s) => s.id === Number(X.to)); const ok = (st, k) => !st || st.holds === 'all' || st.holds === k; return ['drug', 'supply'].filter((k) => ok(f, k) && ok(t, k)); };
  const drawLines = () => {
    $('#tl', m.el).innerHTML = !X.lines.length ? String(html`<div class="muted" style="font-weight:600;padding:8px 2px">ضيف الأصناف من فوق</div>`)
      : String(html`<div class="tk-lines">${X.lines.map((l, i) => html`<div class="tk-line tr-line" style="--cc:${TCAT[l.item.kind].c}"><span class="tk-ci">${icon(TCAT[l.item.kind].icon, 'sm')}</span>
          <div class="nm"><b>${l.item.name}</b><small>${l.item.code}</small></div>
          <label class="qty"><small>الكمية</small><input class="input num" data-q="${i}" value="${l.qty}" inputmode="decimal"></label>
          <span>${unitSel(l.item, l.unit, `data-u="${i}"`)}</span><span></span>
          <button class="rm" type="button" data-rm="${i}">${icon('x', 'sm')}</button></div>`)}</div>`);
  };
  const drawPicker = () => itemPicker($('#tp', m.el), {
    kinds: kindsFor(),
    onPick: (it) => { if (X.lines.some((l) => l.item.id === it.id)) return toast('الصنف موجود', 'info'); X.lines.push({ item: it, qty: 1, unit: defBuy(it) }); drawLines(); const q = $(`[data-q="${X.lines.length - 1}"]`, m.el); q?.focus(); q?.select(); },
  });
  drawPicker(); drawLines();
  m.el.addEventListener('change', (e) => {
    if (e.target.name === 'from') { X.from = Number(e.target.value); drawPicker(); }
    if (e.target.name === 'to') { X.to = Number(e.target.value); drawPicker(); }
    if (e.target.dataset.u != null) X.lines[Number(e.target.dataset.u)].unit = e.target.value;
  });
  m.el.addEventListener('input', (e) => { if (e.target.dataset.q != null) X.lines[Number(e.target.dataset.q)].qty = latinDigits(e.target.value); });
  m.el.addEventListener('keydown', (e) => { if (e.target.dataset.q != null && e.key === 'Enter') { e.preventDefault(); $('[data-ip]', m.el)?.focus(); } });
  m.el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { X.lines.splice(Number(rm.dataset.rm), 1); drawLines(); return; }
    const dr = e.target.closest('[data-direct]');
    if (dr) { dr.setAttribute('aria-checked', dr.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    if (!e.target.closest('[data-ok]')) return;
    try {
      const r = await api.post('/stores/transfers', {
        fromStoreId: X.from, toStoreId: X.to, note: $('[name=note]', m.el).value, issue: !isReq, direct: $('[data-direct]', m.el)?.getAttribute('aria-checked') === 'true',
        lines: X.lines.map((l) => ({ itemId: l.item.id, qty: l.qty, unit: l.unit })),
      });
      m.close(); toast(isReq ? `اتبعت طلب التحويل رقم ${r.transfer.no}` : r.transfer.status === 'confirmed' ? `اتحوّل مباشر · رقم ${r.transfer.no}` : `اتصرف التحويل رقم ${r.transfer.no}، مستني الاستلام`);
      window.refreshShell?.(); onDone?.();
    } catch (er) { toastError(er); }
  });
}

// ================= التحويلات =================
async function transfersPane(pane, M) {
  const S = { st: 'todo' };
  pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px">
      <div class="seg scroll" id="trs">${[['todo', 'محتاج مني'], ['requested', 'مطلوب'], ['issued', 'مستني الاستلام'], ['received', 'مستني التأكيد'], ['all', 'الكل']].map(([k, n]) => html`<button data-s="${k}" class="${S.st === k ? 'on' : ''}">${n}</button>`)}</div>
      <span class="spacer"></span>
      ${M.can.request ? html`<button class="btn soft" data-a="request">${icon('send')} اطلب تحويل</button>` : ''}
      ${M.can.issue ? html`<button class="btn" data-a="issue" style="--c:var(--py)">${icon('arrows')} حوّل لمخزن</button>` : ''}
    </div><div id="trl"><div class="skel" style="height:200px"></div></div>`);
  let data;
  const draw = () => {
    const list = data.transfers.filter((x) => (S.st === 'todo' ? x.todo : S.st === 'all' ? true : x.status === S.st));
    $('#trl', pane).innerHTML = !list.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>${S.st === 'todo' ? 'مفيش حاجة مستنياك' : 'مفيش تحويلات هنا'}</b></div>`)
      : String(html`<div class="tr-grid">${list.map((x) => html`<a class="card tr-card st-${x.status}" href="#/transfer/${x.id}">
          <div class="tr-h"><span class="tkno num">${x.no}</span><span class="badge ${TR_ST[x.status].cls}">${TR_ST[x.status].name}</span>${x.direct ? html`<span class="badge">مباشر</span>` : ''}<span class="spacer"></span><small class="muted">${fmtWhen(x.createdAt)}</small></div>
          <div class="tr-path"><span>${x.from.name}</span>${icon('chev-left', 'sm')}<span>${x.to.name}</span></div>
          <div class="tr-f"><small class="muted">${x.lines} صنف · ${x.by || ''}</small>${x.todo ? html`<span class="tr-todo">${icon('bolt', 'sm')} ${{ issue: 'اصرفه', receive: 'استلمه', confirm: 'أكّده' }[x.todo]}</span>` : ''}</div></a>`)}</div>`);
  };
  const load = async () => { data = await api.get('/stores/transfers'); draw(); };
  pane.onclick = (e) => {
    const s = e.target.closest('[data-s]');
    if (s) { S.st = s.dataset.s; $$('[data-s]', pane).forEach((b) => b.classList.toggle('on', b === s)); return draw(); }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'request') return transferModal({ M, mode: 'request', toId: M.stores.find((x) => x.mine && x.kind === 'sub')?.id || M.stores.find((x) => x.mine)?.id, onDone: load });
    if (a === 'issue') return transferModal({ M, mode: 'issue', fromId: M.stores.find((x) => x.mine && x.kind !== 'sub')?.id || M.stores.find((x) => x.mine)?.id, onDone: load });
  };
  await load();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 20000);
  return () => { clearInterval(timer); pane.onclick = null; };
}

export async function renderTransfer(view, { params, setTitle }) {
  const id = Number(params[0]);
  const M = await meta();
  let d = await api.get('/stores/transfers/' + id);
  const draw = () => {
    const t = d.transfer;
    setTitle(`تحويل ${t.no}`, `${t.from.name} ← ${t.to.name}`);
    const steps = [['requested', 'الطلب', t.requestedAt, t.requestedBy], ['issued', 'الصرف', t.issuedAt, t.issuedBy], ['received', 'الاستلام', t.receivedAt, t.receivedBy], ['confirmed', 'التأكيد', t.confirmedAt, t.confirmedBy]];
    const order = ['requested', 'issued', 'received', 'confirmed'];
    const at = order.indexOf(t.status);
    const canIssue = t.status === 'requested' && t.from.mine && can('stock.issue');
    const canRecv = t.status === 'issued' && t.to.mine && can('stock.receive');
    const canConf = t.status === 'received' && t.from.mine && can('stock.issue');
    const canCancel = (t.status === 'requested' && (t.from.mine || t.to.mine)) || (t.status === 'issued' && t.from.mine && can('stock.issue'));
    view.innerHTML = String(html`<div class="card tr-head">
        <div class="tr-path big"><span>${icon('layers', 'sm')} ${t.from.name}</span>${icon('chev-left')}<span>${icon('door', 'sm')} ${t.to.name}</span>
          <span class="badge ${TR_ST[t.status].cls}" style="margin-inline-start:auto">${TR_ST[t.status].name}</span>${t.direct ? html`<span class="badge">مباشر</span>` : ''}</div>
        ${t.status === 'cancelled' ? html`<div class="alertbar danger" style="margin-top:10px">${icon('x')}<span>اتلغى · ${t.cancelledBy || ''} · ${fmtWhen(t.cancelledAt)} · ${t.cancelReason || ''}</span></div>`
          : html`<div class="tr-steps">${steps.filter((s) => !(s[0] === 'requested' && !s[2])).map(([k, n, w, by]) => html`<div class="tr-step ${order.indexOf(k) <= at ? 'done' : order.indexOf(k) === at + 1 ? 'next' : ''}"><i>${order.indexOf(k) <= at ? icon('check', 'sm') : ''}</i><b>${n}</b><small>${w ? `${by || ''} · ${fmtWhen(w)}` : 'لسه'}</small></div>`)}</div>`}
        ${t.note ? html`<div class="muted" style="font-weight:600;margin-top:8px">${icon('info', 'sm')} ${t.note}</div>` : ''}
      </div>
      <div class="card" style="margin-top:14px;padding:6px"><div class="table-wrap"><table class="table">
        <thead><tr><th>الصنف</th><th class="n">المطلوب</th>${canIssue ? html`<th class="n">الموجود عندك</th><th class="n">هتصرف</th>` : html`<th class="n">اتصرف</th>`}<th>التشغيلة · الصلاحية</th></tr></thead><tbody>
        ${d.lines.map((l) => html`<tr><td><b>${l.name}</b> <span class="code num">${l.code}</span></td><td class="n num">${unitsText(l.reqQty, l.units)}</td>
          ${canIssue ? html`<td class="n num ${l.available < l.reqQty ? 'neg' : ''}">${unitsText(l.available, l.units)}</td>
            <td class="n"><input class="input num" data-iq="${l.id}" value="${Math.max(0, Math.min(l.reqQty, l.available))}" style="width:96px;height:36px;text-align:center;font-weight:800"> <small class="muted">${l.units[0].name}</small></td>`
          : html`<td class="n num">${l.issuedQty == null ? '—' : unitsText(l.issuedQty, l.units)}</td>`}
          <td>${l.batches.map((b) => html`<span class="badge" style="margin:2px">${b.batchNo || 'من غير تشغيلة'} · ${b.expiry ? dShort(b.expiry) : '—'} · <span class="num">${b.qty}</span></span>`)}</td></tr>`)}
        </tbody></table></div></div>
      <div class="row wrap tr-acts" style="gap:8px;margin-top:14px">
        ${canIssue ? html`${M.can.direct ? html`<label class="swl"><button type="button" class="switch" role="switch" data-direct aria-checked="false"></button><span>مباشر (من غير استلام)</span></label>` : ''}<span class="spacer"></span><button class="btn lg" data-a="issue" style="--c:var(--py)">${icon('arrows')} اصرف التحويل</button>` : ''}
        ${canRecv ? html`<span class="spacer"></span><button class="btn lg" data-a="receive" style="--c:var(--ok)">${icon('check')} استلمت الأصناف دي</button>` : ''}
        ${canConf ? html`<span class="spacer"></span><button class="btn lg" data-a="confirm" style="--c:var(--ok)">${icon('check')} أكّد التحويل</button>` : ''}
        ${canCancel ? html`<button class="btn ghost" data-a="cancel">${icon('x')} الغي</button>` : ''}
        <a class="btn ghost" href="#/stores?tab=transfers">${icon('chev-right')} التحويلات</a>
      </div>`);
  };
  draw();
  view.onclick = async (e) => {
    const dr = e.target.closest('[data-direct]');
    if (dr) { dr.setAttribute('aria-checked', dr.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      if (a === 'issue') {
        d = await api.post(`/stores/transfers/${id}/issue`, { direct: $('[data-direct]', view)?.getAttribute('aria-checked') === 'true', lines: $$('[data-iq]', view).map((i) => ({ lineId: Number(i.dataset.iq), qty: latinDigits(i.value) })) });
        toast(d.transfer.status === 'confirmed' ? 'اتحوّل مباشر' : 'اتصرف، مستني الاستلام');
      }
      if (a === 'receive') { d = await api.post(`/stores/transfers/${id}/receive`); toast('اتسجل الاستلام'); }
      if (a === 'confirm') { d = await api.post(`/stores/transfers/${id}/confirm`); toast('التحويل خلص'); }
      if (a === 'cancel') {
        const reason = await askReason({ title: `إلغاء تحويل ${d.transfer.no}`, confirm: 'الغي التحويل', note: d.transfer.status === 'issued' ? 'الأصناف هترجع للمخزن اللي صرفها.' : '' });
        if (!reason) return;
        d = await api.post(`/stores/transfers/${id}/cancel`, { reason }); toast('اتلغى', 'info');
      }
      draw(); window.refreshShell?.();
    } catch (er) { toastError(er); }
  };
  return () => { view.onclick = null; };
}

// ================= الاستلام من الموردين =================
async function purchasesPane(pane, M) {
  pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px"><span class="spacer"></span>
      <button class="btn soft" data-a="opening">${icon('layers')} رصيد أول المدة</button><button class="btn" data-a="new">${icon('download')} استلام من مورد</button></div>
    <div id="pl"><div class="skel" style="height:200px"></div></div>`);
  let data;
  const load = async () => {
    data = await api.get('/stores/purchases');
    $('#pl', pane).innerHTML = !data.purchases.length ? String(html`<div class="card empty"><div class="art">${icon('download')}</div><b>لسه مفيش استلام</b>ابدأ بـ«رصيد أول المدة» لكل مخزن</div>`)
      : String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>المخزن</th><th>المورد</th><th>الفاتورة</th><th class="n">أصناف</th><th class="n">الإجمالي</th><th>إمتى</th></tr></thead><tbody>
        ${data.purchases.map((p) => html`<tr class="click" data-p="${p.id}"><td class="num">${p.no}</td><td>${p.store}</td><td>${p.kind === 'opening' ? html`<span class="badge">رصيد أول المدة</span>` : p.supplier}</td>
          <td class="num">${p.invoiceNo || '—'}${p.invoiceDate ? html` <small class="muted">${dShort(p.invoiceDate)}</small>` : ''}</td><td class="n num">${p.lines}</td><td class="n"><b>${egp(p.total)}</b></td><td class="muted">${fmtWhen(p.createdAt)} · ${p.createdBy}</td></tr>`)}</tbody></table></div></div>`);
  };
  pane.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'new' || a === 'opening') return purchaseModal({ M, kind: a === 'opening' ? 'opening' : 'supplier', suppliers: data?.suppliers || [], onDone: load });
    const p = e.target.closest('[data-p]');
    if (p) {
      const d = await api.get('/stores/purchases/' + p.dataset.p);
      modal({
        title: `${d.purchase.kind === 'opening' ? 'رصيد أول المدة' : 'استلام'} رقم ${d.purchase.no}`, wide: true,
        body: html`<div class="row wrap" style="gap:8px;margin-bottom:10px"><span class="badge">${d.purchase.store}</span>${d.purchase.supplier ? html`<span class="badge">${d.purchase.supplier}</span>` : ''}${d.purchase.invoiceNo ? html`<span class="badge num">فاتورة ${d.purchase.invoiceNo}</span>` : ''}<span class="badge">${d.purchase.createdBy} · ${fmtWhen(d.purchase.createdAt)}</span></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>الصنف</th><th class="n">الكمية</th><th>التشغيلة</th><th>الصلاحية</th><th class="n">السعر</th><th class="n">الإجمالي</th></tr></thead><tbody>
          ${d.lines.map((l) => html`<tr><td>${l.name}</td><td class="n num">${l.qty} ${l.unit}</td><td class="num">${l.batchNo || '—'}</td><td>${l.expiry ? html`<span class="exp ${expCls(l.expiry)}">${dShort(l.expiry)}</span>` : '—'}</td><td class="n num">${money(l.unitCost)}</td><td class="n num"><b>${money(l.total)}</b></td></tr>`)}
          </tbody></table></div><div class="tk-total" style="margin-top:10px"><span>الإجمالي</span><b>${egp(d.purchase.total)}</b></div>`,
        foot: html`<button class="btn" data-close>تمام</button>`,
      });
    }
  };
  await load();
  return () => { pane.onclick = null; };
}

async function purchaseModal({ M, storeId = null, kind = 'supplier', suppliers = [], onDone }) {
  const stores = M.stores.filter((s) => s.active && s.kind !== 'sub' && (s.mine || M.can.all));
  const opening = kind === 'opening';
  const X = { store: storeId && stores.some((s) => s.id === storeId) ? storeId : stores[0]?.id, lines: [] };
  const m = modal({
    title: opening ? 'رصيد أول المدة' : 'استلام من مورد', wide: true,
    body: html`<div class="row wrap" style="gap:10px">
        <div class="field" style="flex:1 1 180px"><label>المخزن</label><select class="select" name="store">${(opening ? M.stores.filter((s) => s.active && (s.mine || M.can.all)) : stores).map((s) => html`<option value="${s.id}" ${X.store === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></div>
        ${opening ? '' : html`<div class="field" style="flex:2 1 200px" data-f="supplier"><label>المورد <span class="req">*</span></label><input class="input" name="supplier" list="supl" autocomplete="off"><datalist id="supl">${suppliers.map((x) => html`<option value="${x}">`)}</datalist><div class="msg"></div></div>
          <div class="field" style="flex:1 1 120px"><label>رقم الفاتورة</label><input class="input num" name="invoiceNo"></div>
          <div class="field" style="flex:1 1 150px"><label>تاريخ الفاتورة</label><input class="input num" type="date" name="invoiceDate" value="${todayStr()}"></div>`}</div>
      <div id="pp" style="margin-top:12px"></div>
      <div id="plines" style="margin-top:10px"></div>
      <div class="tk-total" style="margin-top:10px" id="ptot"></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} سجّل ${opening ? 'الرصيد' : 'الاستلام'}</button>`,
  });
  const kinds = () => { const s = M.stores.find((x) => x.id === Number(X.store)); return !s || s.holds === 'all' ? ['drug', 'supply'] : [s.holds]; };
  const total = () => X.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  const drawTot = () => { $('#ptot', m.el).innerHTML = String(html`<span>${X.lines.length} صنف</span><b>${egp(total())}</b>`); };
  const drawLines = () => {
    $('#plines', m.el).innerHTML = !X.lines.length ? String(html`<div class="muted" style="font-weight:600;padding:8px 2px">ضيف الأصناف من فوق</div>`)
      : String(html`<div class="pl-lines">${X.lines.map((l, i) => html`<div class="pl-line" style="--cc:${TCAT[l.item.kind].c}">
          <div class="nm"><span class="tk-ci sm">${icon(TCAT[l.item.kind].icon, 'sm')}</span><b>${l.item.name}</b><button class="rm" type="button" data-rm="${i}">${icon('x', 'sm')}</button></div>
          <div class="pl-f"><label><small>الكمية</small><input class="input num" data-k="qty" data-i="${i}" value="${l.qty}"></label><label><small>الوحدة</small>${unitSel(l.item, l.unit, `data-k="unit" data-i="${i}"`)}</label>
            ${opening ? '' : html`<label><small>سعر الوحدة</small><input class="input num" data-k="cost" data-i="${i}" value="${l.cost}"></label>`}
            <label><small>التشغيلة</small><input class="input num" data-k="batchNo" data-i="${i}" value="${l.batchNo}"></label>
            <label><small>الصلاحية</small><input class="input num" type="date" data-k="expiry" data-i="${i}" value="${l.expiry}" min="${todayStr()}"></label></div></div>`)}</div>`);
    drawTot();
  };
  const drawPicker = () => itemPicker($('#pp', m.el), {
    kinds: kinds(),
    onPick: (it) => { X.lines.push({ item: it, qty: 1, unit: defBuy(it), cost: '', batchNo: '', expiry: '' }); drawLines(); const q = $(`[data-k="qty"][data-i="${X.lines.length - 1}"]`, m.el); q?.focus(); q?.select(); },
  });
  drawPicker(); drawLines();
  m.el.addEventListener('change', (e) => {
    if (e.target.name === 'store') { X.store = Number(e.target.value); X.lines = X.lines.filter((l) => kinds().includes(l.item.kind)); drawPicker(); drawLines(); }
    if (e.target.dataset.k === 'unit' || e.target.dataset.k === 'expiry') X.lines[Number(e.target.dataset.i)][e.target.dataset.k] = e.target.value;
  });
  m.el.addEventListener('input', (e) => { const k = e.target.dataset.k; if (k && k !== 'unit') { X.lines[Number(e.target.dataset.i)][k] = k === 'batchNo' ? e.target.value : latinDigits(e.target.value); drawTot(); } });
  m.el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { X.lines.splice(Number(rm.dataset.rm), 1); drawLines(); return; }
    if (!e.target.closest('[data-ok]')) return;
    const v = (n) => $(`[name=${n}]`, m.el)?.value;
    try {
      const r = await api.post('/stores/purchases', {
        kind, storeId: X.store, supplier: v('supplier'), invoiceNo: v('invoiceNo'), invoiceDate: v('invoiceDate'),
        lines: X.lines.map((l) => ({ itemId: l.item.id, qty: l.qty, unit: l.unit, cost: l.cost, batchNo: l.batchNo, expiry: l.expiry })),
      });
      m.close(); toast(`اتسجل ${opening ? 'الرصيد' : 'الاستلام'} رقم ${r.no}`); itemsCache = null; onDone?.();
    } catch (er) {
      if (er instanceof ApiError && er.data.errors?.supplier) { const f = $('[data-f=supplier]', m.el); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.supplier; $('input', f).focus(); } else toastError(er);
    }
  });
}

// ================= تعريف المخازن (المدير) =================
async function setupPane(pane, M) {
  const draw = () => {
    pane.innerHTML = String(html`<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn" data-a="new">${icon('plus')} مخزن جديد</button></div>
      <div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>المخزن</th><th>النوع</th><th>بيشيل</th><th>مربوط بـ</th><th></th></tr></thead><tbody>
      ${M.stores.map((s) => html`<tr class="click ${s.active ? '' : 'off-row'}" data-e="${s.id}"><td><b>${icon(K_IC[s.kind], 'sm')} ${s.name}</b>${s.active ? '' : html` <span class="badge">موقوف</span>`}${s.notes ? html`<div class="muted" style="font-size:12px">${s.notes}</div>` : ''}</td>
        <td>${s.kindName}</td><td>${{ drug: 'أدوية', supply: 'مستلزمات', all: 'أدوية ومستلزمات' }[s.holds]}</td><td class="num">${[s.floorId ? `الدور ${M.floors.find((f) => f.id === s.floorId)?.no || ''}` : '', s.dept ? M.depts[s.dept] : ''].filter(Boolean).join(' · ') || '—'}</td><td>${icon('edit', 'sm')}</td></tr>`)}</tbody></table></div></div>
      <div class="alertbar info" style="margin-top:12px">${icon('info')}<span>مخزن الدور هو اللي بتتخصم منه التذكرة افتراضيًا، ومخزن القسم (عمليات، عناية، طوارئ، عيادات…) بيتصرف منه في القسم ده. تقدر تضيف أي مخزن جديد من «مخزن جديد»، واربط الموظفين بمخازنهم من الإعدادات ← المستخدمين.</span></div>`);
  };
  draw();
  pane.onclick = (e) => {
    const ed = e.target.closest('[data-e]');
    const s = ed ? M.stores.find((x) => x.id === Number(ed.dataset.e)) : null;
    if (!ed && !e.target.closest('[data-a="new"]')) return;
    const v = s || { name: '', kind: 'sub', holds: 'all', floorId: null, dept: null, notes: '', active: true };
    const m = modal({
      title: s ? 'تعديل مخزن' : 'مخزن جديد',
      body: html`<div class="grid" style="gap:12px">
        <div class="field" data-f="name"><label>اسم المخزن</label><input class="input" name="name" value="${v.name}" autofocus><div class="msg"></div></div>
        <div class="row" style="gap:10px"><div class="field" style="flex:1"><label>النوع</label><select class="select" name="kind">${Object.entries(M.kinds).map(([k, n]) => html`<option value="${k}" ${v.kind === k ? 'selected' : ''}>${n}</option>`)}</select></div>
          <div class="field" style="flex:1"><label>بيشيل</label><select class="select" name="holds">${[['all', 'أدوية ومستلزمات'], ['drug', 'أدوية'], ['supply', 'مستلزمات']].map(([k, n]) => html`<option value="${k}" ${v.holds === k ? 'selected' : ''}>${n}</option>`)}</select></div></div>
        <div class="field"><label>مربوط بدور (للتذكرة)</label><select class="select" name="floorId"><option value="">مش مربوط</option>${M.floors.map((f) => html`<option value="${f.id}" ${v.floorId === f.id ? 'selected' : ''}>الدور ${f.no}</option>`)}</select></div>
        <div class="field"><label>مخزن قسم <span class="hint">بيتصرف منه في القسم ده</span></label><select class="select" name="dept"><option value="">مش مخزن قسم</option>${Object.entries(M.depts).map(([k, n]) => html`<option value="${k}" ${v.dept === k ? 'selected' : ''}>${n}</option>`)}</select></div>
        <div class="field"><label>ملاحظات</label><input class="input" name="notes" value="${v.notes || ''}" placeholder="مثلًا: عيادة الأسنان"></div>
        ${s ? html`<label class="swl"><button type="button" class="switch" role="switch" data-act aria-checked="${v.active ? 'true' : 'false'}"></button><span>المخزن شغال</span></label>` : ''}</div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
    });
    m.el.addEventListener('click', async (ev) => {
      const sw = ev.target.closest('[data-act]');
      if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); return; }
      if (!ev.target.closest('[data-ok]')) return;
      const g = (n) => $(`[name=${n}]`, m.el).value;
      const body = { name: g('name'), kind: g('kind'), holds: g('holds'), floorId: g('floorId') || null, dept: g('dept') || null, notes: g('notes'), active: s ? $('[data-act]', m.el).getAttribute('aria-checked') === 'true' : true };
      try {
        if (s) await api.put('/stores/list/' + s.id, body); else await api.post('/stores/list', body);
        m.close(); toast('اتحفظ'); M = await meta(true); draw();
      } catch (er) { toastError(er); }
    });
  };
  return () => { pane.onclick = null; };
}
void state; void fmtTime;

// ================= الجرد والإعدام =================
const CNT_ST = { open: { name: 'بيتعد', cls: 'warn' }, submitted: { name: 'مستني اعتماد المدير', cls: 'py' }, approved: { name: 'اتعتمد', cls: 'ok' }, cancelled: { name: 'اتلغى', cls: '' } };
async function countsPane(pane, M) {
  const S = { v: 'counts' };
  pane.innerHTML = String(html`<div class="row wrap" style="gap:10px;margin-bottom:12px">
      <div class="seg" id="cv"><button data-v="counts" class="on">${icon('clipboard', 'sm')} الجرد</button><button data-v="waste">${icon('trash', 'sm')} الإعدام</button></div>
      <span class="spacer"></span>${M.can.count ? html`<button class="btn" data-a="new">${icon('plus')} ابدأ جرد</button>` : ''}</div>
    <div id="cl"><div class="skel" style="height:200px"></div></div>`);
  const draw = async () => {
    const box = $('#cl', pane);
    if (S.v === 'waste') {
      const d = await api.get('/stores/waste');
      const tot = d.waste.reduce((x, w) => x + (w.value || 0), 0);
      box.innerHTML = !d.waste.length ? String(html`<div class="card empty"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش إعدام</b>الإعدام بيتعمل من كارت الصنف ← التشغيلة</div>`)
        : String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table"><thead><tr><th>رقم</th><th>إمتى</th><th>المخزن</th><th>الصنف</th><th>التشغيلة</th><th class="n">الكمية</th><th class="n">القيمة</th><th>السبب</th><th>مين</th></tr></thead><tbody>
          ${d.waste.map((w) => html`<tr><td class="num">${w.no}</td><td class="muted" style="white-space:nowrap">${fmtWhen(w.at)}</td><td>${w.store}</td><td><b>${w.item}</b></td><td class="num">${w.batchNo || '—'}${w.expiry ? html` <span class="exp ${expCls(w.expiry)}">${dShort(w.expiry)}</span>` : ''}</td>
            <td class="n num">${w.qty} ${w.unit}</td><td class="n num">${w.value == null ? '—' : money(w.value)}</td><td>${w.reason}</td><td class="muted">${w.by}</td></tr>`)}</tbody></table></div>
          <div class="tk-total" style="margin:6px"><span>قيمة الإعدام (بالتكلفة)</span><b>${egp(tot)}</b></div></div>`);
      return;
    }
    const d = await api.get('/stores/counts/list');
    box.innerHTML = !d.counts.length ? String(html`<div class="card empty"><div class="art">${icon('clipboard')}</div><b>لسه مفيش جرد</b>الجرد بيوقف المخزن، تعدّ يدوي وتكتب العدد، والمدير يعتمد الفروق</div>`)
      : String(html`<div class="tr-grid">${d.counts.map((c) => html`<a class="card tr-card" href="#/count/${c.id}">
          <div class="tr-h"><span class="tkno num">${c.no}</span><span class="badge ${CNT_ST[c.status].cls}">${CNT_ST[c.status].name}</span><span class="spacer"></span><small class="muted">${fmtWhen(c.createdAt)}</small></div>
          <div class="tr-path"><span>${icon('clipboard', 'sm')} ${c.store}</span></div>
          <div class="tr-f"><small class="muted">${c.by}</small>${c.diffValue != null && c.status === 'approved' ? html`<b class="num" style="color:${c.diffValue < 0 ? 'var(--danger)' : 'var(--ok)'}">فرق ${money(c.diffValue)} ${HMS.money.symbol}</b>` : ''}</div></a>`)}</div>`);
  };
  pane.onclick = async (e) => {
    const v = e.target.closest('[data-v]');
    if (v) { S.v = v.dataset.v; $$('[data-v]', pane).forEach((b) => b.classList.toggle('on', b === v)); return draw(); }
    if (!e.target.closest('[data-a="new"]')) return;
    const mine = M.stores.filter((s) => s.active && (s.mine || M.can.all));
    const m = modal({
      title: 'ابدأ جرد',
      body: html`<div class="field"><label>المخزن</label><select class="select" name="s">${mine.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
        <input class="input" name="n" placeholder="ملاحظة (مثلًا: جرد آخر السنة)" style="margin-top:10px">
        <div class="alertbar warn" style="margin-top:12px">${icon('lock')}<span>المخزن هيقف من دلوقتي: مفيش صرف ولا تحويل ولا استلام لحد ما المدير يعتمد الجرد أو يلغيه.</span></div>`,
      foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('lock')} وقّف المخزن وابدأ</button>`,
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      try { const r = await api.post('/stores/counts', { storeId: $('[name=s]', m.el).value, note: $('[name=n]', m.el).value }); m.close(); metaCache = null; window.go('/count/' + r.count.id); } catch (er) { toastError(er); }
    });
  };
  await draw();
  return () => { pane.onclick = null; };
}

export async function renderCount(view, { params, setTitle }) {
  const id = Number(params[0]);
  const M = await meta(true);
  let d = await api.get('/stores/counts/' + id);
  const S = { q: '', f: 'all', dirty: new Map(), add: [] };
  setTitle('جرد رقم ' + d.count.no, d.count.store.name);
  const editable = () => d.count.status === 'open' && M.can.count;
  const saveNow = async () => {
    if (!S.dirty.size) return;
    const lines = [...S.dirty].map(([lid, counted]) => ({ id: lid, counted }));
    S.dirty.clear();
    try { const nd = await api.post(`/stores/counts/${id}/save`, { lines }); d.remaining = nd.remaining; d.count.diffValue = nd.count.diffValue; for (const l of nd.lines) { const o = d.lines.find((x) => x.id === l.id); if (o) Object.assign(o, l); } drawHead(); $$('[data-cl]', view).forEach((r) => paintRow(r)); $('#cnt-saved', view)?.classList.add('show'); setTimeout(() => $('#cnt-saved', view)?.classList.remove('show'), 1200); }
    catch (er) { toastError(er); }
  };
  const save = debounce(saveNow, 600);
  const paintRow = (r) => {
    const l = d.lines.find((x) => x.id === Number(r.dataset.cl));
    const df = r.querySelector('.cdiff');
    if (!df || !l) return;
    df.innerHTML = l.diff == null ? '<span class="muted">—</span>' : `<b class="num" style="color:${l.diff < 0 ? 'var(--danger)' : l.diff > 0 ? 'var(--ok)' : 'var(--muted)'}">${l.diff > 0 ? '+' : ''}${l.diff}</b>`;
    r.classList.toggle('done', l.counted != null);
  };
  const drawHead = () => {
    const c = d.count, done = d.lines.length - d.remaining;
    $('#ch', view).innerHTML = String(html`<div class="cnt-h card">
        <div><div class="row wrap" style="gap:8px"><span class="tkno num">${c.no}</span><b style="font-size:18px">${c.store.name}</b><span class="badge ${CNT_ST[c.status].cls}">${CNT_ST[c.status].name}</span></div>
          <small class="muted">بدأه ${c.createdBy} · ${fmtWhen(c.createdAt)}${c.note ? ' · ' + c.note : ''}${c.approvedBy ? ` · اعتمده ${c.approvedBy}` : ''}</small></div>
        <div class="cnt-prog"><div class="bar"><i style="width:${d.lines.length ? Math.round((done / d.lines.length) * 100) : 0}%"></i></div><small><b class="num">${done}</b> من <b class="num">${d.lines.length}</b> سطر اتعدّ</small></div>
        <div class="cnt-val"><small>فرق القيمة</small><b class="num" style="color:${c.diffValue < 0 ? 'var(--danger)' : c.diffValue > 0 ? 'var(--ok)' : 'inherit'}">${money(c.diffValue || 0)} ${HMS.money.symbol}</b></div>
        <div class="row wrap" style="gap:6px">
          <a class="btn ghost sm" href="/print/count/${id}" target="_blank">${icon('print', 'sm')} ورقة العد</a>
          ${M.can.manage ? html`<a class="btn ghost sm" href="/print/count/${id}?system=1" target="_blank">${icon('print', 'sm')} بالرصيد</a>` : ''}
          ${editable() ? html`<button class="btn soft sm" data-a="add">${icon('plus', 'sm')} صنف لقيته</button><button class="btn sm" data-a="submit">${icon('send', 'sm')} سلّم للمدير</button>` : ''}
          ${c.status === 'submitted' && M.can.manage ? html`<button class="btn ghost sm" data-a="reopen">${icon('undo', 'sm')} رجّعه للعد</button><button class="btn sm" data-a="approve" style="--c:var(--ok)">${icon('check', 'sm')} اعتمد الفروق</button>` : ''}
          ${['open', 'submitted'].includes(c.status) && (M.can.manage || (M.can.count && c.status === 'open')) ? html`<button class="btn ghost sm" data-a="cancel" style="--c:var(--danger)">${icon('x', 'sm')} الغي</button>` : ''}
        </div></div>`);
  };
  const drawList = () => {
    const q = searchKey(S.q);
    const list = d.lines.filter((l) => (!q || searchKey(l.name + ' ' + l.code).includes(q)) && (S.f === 'all' || (S.f === 'left' ? l.counted == null : l.diff)));
    const ed = editable(), sys = M.can.manage || d.count.status !== 'open';
    $('#cb', view).innerHTML = String(html`<div class="card" style="padding:6px"><div class="table-wrap"><table class="table cnt-table"><thead><tr><th>الصنف</th><th>التشغيلة</th><th>الصلاحية</th>${sys ? html`<th class="n">الرصيد</th>` : ''}<th class="n" style="width:130px">العدد الفعلي</th>${sys ? html`<th class="n">الفرق</th>` : ''}</tr></thead><tbody>
      ${list.map((l) => html`<tr data-cl="${l.id}" class="${l.counted != null ? 'done' : ''}"><td><b>${l.name}</b> <span class="code num">${l.code}</span><div class="muted" style="font-size:11.5px">${l.units[0].name}${l.units.length > 1 ? ' · ' + l.units.slice(1).map((u) => `${u.name} = ${u.factor}`).join(' · ') : ''}</div></td>
        <td class="num">${l.batchNo || '—'}</td><td>${l.expiry ? html`<span class="exp ${expCls(l.expiry)}">${dShort(l.expiry)}</span>` : '—'}</td>
        ${sys ? html`<td class="n num">${l.systemQty}</td>` : ''}
        <td class="n">${ed ? html`<input class="input num cnt-in" data-ci="${l.id}" value="${l.counted ?? ''}" inputmode="decimal" placeholder="اكتب العدد">` : html`<b class="num">${l.counted ?? '—'}</b>`}</td>
        ${sys ? html`<td class="n cdiff"></td>` : ''}</tr>`)}
      ${!list.length ? html`<tr><td colspan="6"><div class="empty" style="padding:16px">مفيش سطور</div></td></tr>` : ''}</tbody></table></div></div>`);
    $$('[data-cl]', view).forEach((r) => paintRow(r));
  };
  view.innerHTML = String(html`<a class="back-link" href="#/stores?tab=counts">${icon('chev-right', 'sm')} الجرد</a><div id="ch"></div>
    <div class="row wrap" style="gap:10px;margin:12px 0"><div class="chips" id="cf">${[['all', 'الكل'], ['left', 'لسه ما اتعدّش'], ['diff', 'فيه فرق']].map(([k, n]) => html`<button class="chip ${S.f === k ? 'on' : ''}" data-f="${k}">${n}</button>`)}</div>
      <span class="saved-pill" id="cnt-saved">${icon('check', 'sm')} اتحفظ</span>
      <div class="big-search" style="flex:1 1 220px;max-width:340px;margin-inline-start:auto">${icon('search')}<input class="input" id="cq" type="search" placeholder="دوّر على صنف" style="height:42px;padding-inline-start:42px;border-radius:12px"></div></div>
    <div id="cb"></div>
    ${d.count.status === 'open' ? html`<div class="alertbar info" style="margin-top:12px">${icon('info')}<span>اكتب العدد الفعلي لكل سطر وانزل بـ Enter، بيتحفظ لوحده. الصنف اللي مش لاقيه اكتب 0.</span></div>` : ''}`);
  drawHead(); drawList();
  view.oninput = (e) => {
    if (e.target.id === 'cq') { S.q = e.target.value; drawList(); return; }
    const ci = e.target.dataset.ci;
    if (ci) { const v = latinDigits(e.target.value); const l = d.lines.find((x) => x.id === Number(ci)); l.counted = v === '' ? null : Number(v); l.diff = l.counted == null ? null : Math.round((l.counted - l.systemQty) * 100) / 100; paintRow(e.target.closest('tr')); S.dirty.set(Number(ci), v); save(); }
  };
  view.onkeydown = (e) => {
    if (!e.target.dataset.ci || (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const ins = $$('[data-ci]', view), i = ins.indexOf(e.target), n = ins[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (n) { n.focus(); n.select(); }
  };
  view.onclick = async (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { S.f = f.dataset.f; $$('[data-f]', view).forEach((b) => b.classList.toggle('on', b === f)); return drawList(); }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const act = async (name, body) => { try { d = await api.post(`/stores/counts/${id}/${name}`, body); metaCache = null; drawHead(); drawList(); return true; } catch (er) { toastError(er); return false; } };
    if (a === 'submit') { await saveNow(); if (await act('submit')) toast('الجرد اتسلّم للمدير'); }
    if (a === 'reopen') { if (await act('reopen')) toast('رجع للعد'); }
    if (a === 'approve') {
      const m = modal({ title: 'اعتماد الجرد', body: html`<p style="margin:0;font-weight:700">الرصيد هيتظبط على العد الفعلي، وفرق القيمة <b class="num">${money(d.count.diffValue)}</b> ${HMS.money.symbol} هيتسجل، والمخزن يرجع يشتغل.</p>`, foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-ok style="--c:var(--ok)">${icon('check')} اعتمد</button>` });
      $('[data-ok]', m.el).addEventListener('click', async () => { m.close(); if (await act('approve')) toast('اتعتمد الجرد، والمخزن رجع يشتغل'); });
    }
    if (a === 'cancel') { const r = await askReason({ title: 'إلغاء الجرد', label: 'السبب' }); if (r && await act('cancel', { reason: r })) toast('الجرد اتلغى، والمخزن رجع يشتغل', 'info'); }
    if (a === 'add') {
      const X = { item: null };
      const m = modal({
        title: 'صنف لقيته ومش في القايمة',
        body: html`<div id="ap"></div><div id="ax" style="margin-top:10px"></div>`,
        foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('plus')} ضيف</button>`,
      });
      const st = M.stores.find((s) => s.id === d.count.store.id);
      itemPicker($('#ap', m.el), { kinds: ['drug', 'supply'].filter((k) => !st || st.holds === 'all' || st.holds === k), onPick: (it) => {
        X.item = it;
        $('#ax', m.el).innerHTML = String(html`<div class="chip on" style="margin-bottom:10px">${it.name}</div><div class="row wrap" style="gap:10px">
          <div class="field" style="flex:1 1 110px"><label>العدد (${it.unit})</label><input class="input num" name="q" autofocus></div>
          <div class="field" style="flex:1 1 110px"><label>التشغيلة</label><input class="input num" name="b"></div>
          <div class="field" style="flex:1 1 140px"><label>الصلاحية</label><input class="input" type="date" name="x"></div></div>`);
        $('[name=q]', m.el).focus();
      } });
      $('[data-ok]', m.el).addEventListener('click', async () => {
        if (!X.item) return toast('اختار الصنف', 'info');
        m.close();
        if (await act('save', { add: [{ itemId: X.item.id, counted: latinDigits($('[name=q]', m.el).value), batchNo: $('[name=b]', m.el).value, expiry: $('[name=x]', m.el).value }] })) toast('اتضاف');
      });
    }
  };
  return () => { view.oninput = view.onkeydown = view.onclick = null; };
}

// ================= التقارير =================
const REPORTS = [
  ['value', 'قيمة المخزون', 'wallet', 'stock'], ['consumption', 'استهلاك الأقسام', 'chart', 'stock'], ['pharmacy', 'بيع الصيدلية', 'pill', 'pharmacy'],
  ['expiry', 'الصلاحية', 'clock', 'stock'], ['stagnant', 'الراكد', 'hourglass', 'stock'], ['ledger', 'حركة صنف', 'history', 'stock'],
];
const monthStart = () => todayStr().slice(0, 8) + '01';
const bar = (v, max, c = 'var(--brand)') => html`<span class="rbar"><i style="width:${max > 0 ? Math.max(2, Math.round((Math.abs(v) / max) * 100)) : 0}%;background:${c}"></i></span>`;
async function reportsPane(pane, M, query) {
  const list = REPORTS.filter((r) => can(r[3] === 'pharmacy' ? 'reports.pharmacy' : 'reports.stock') || (r[3] === 'pharmacy' && can('reports.stock')));
  const R = {
    r: list.some((x) => x[0] === query.get('r')) ? query.get('r') : list[0][0],
    store: 'all', from: monthStart(), to: todayStr(), days: 90, item: null, by: 'store',
  };
  const stores = M.stores.filter((s) => s.mine || M.can.all);
  pane.innerHTML = String(html`<div class="rep-nav">${list.map(([k, n, ic]) => html`<button class="rep-tab ${R.r === k ? 'on' : ''}" data-r="${k}">${icon(ic)}<span>${n}</span></button>`)}</div>
    <div class="card rep-ctl" id="rc"></div><div id="rb"><div class="skel" style="height:260px"></div></div>`);
  const url = (fmt) => {
    const p = new URLSearchParams();
    if (R.r !== 'pharmacy') p.set('storeId', R.store);
    if (['consumption', 'pharmacy', 'ledger'].includes(R.r)) { p.set('from', R.from); p.set('to', R.to); }
    if (['expiry', 'stagnant'].includes(R.r)) p.set('days', R.days);
    if (R.r === 'ledger' && R.item) p.set('itemId', R.item.id);
    if (fmt) { p.set('format', 'xlsx'); if (R.by === 'item') p.set('by', 'item'); }
    return `/stock-reports/${R.r}?${p}`;
  };
  const drawCtl = () => {
    const dated = ['consumption', 'pharmacy', 'ledger'].includes(R.r);
    $('#rc', pane).innerHTML = String(html`
      ${R.r !== 'pharmacy' ? html`<div class="field"><label>المخزن</label><select class="select" id="rs">${M.can.all || stores.length > 1 ? html`<option value="all">كل المخازن</option>` : ''}${stores.map((x) => html`<option value="${x.id}" ${String(R.store) === String(x.id) ? 'selected' : ''}>${x.name}</option>`)}</select></div>` : ''}
      ${dated ? html`<div class="field"><label>من</label><input class="input num" type="date" id="rf" value="${R.from}" max="${todayStr()}"></div><div class="field"><label>لـ</label><input class="input num" type="date" id="rt" value="${R.to}" max="${todayStr()}"></div>
        <div class="chips rep-quick">${[['today', 'النهارده'], ['week', '7 أيام'], ['month', 'الشهر ده'], ['year', 'السنة دي']].map(([k, n]) => html`<button class="chip" data-q="${k}">${n}</button>`)}</div>` : ''}
      ${['expiry', 'stagnant'].includes(R.r) ? html`<div class="field"><label>${R.r === 'expiry' ? 'هتنتهي خلال' : 'من غير صرف من'}</label><div class="seg" id="rd">${(R.r === 'expiry' ? [30, 90, 180, 365] : [30, 60, 90, 180]).map((n) => html`<button data-d="${n}" class="${R.days === n ? 'on' : ''}">${n === 365 ? 'سنة' : n + ' يوم'}</button>`)}</div></div>` : ''}
      ${R.r === 'ledger' ? html`<div class="field" style="flex:1 1 260px"><label>الصنف</label><div id="rip"></div>${R.item ? html`<div class="chip on" style="margin-top:6px">${R.item.name}</div>` : ''}</div>` : ''}
      <span class="spacer"></span>
      <a class="btn soft" id="rx" href="/api${url(true)}" ${R.r === 'ledger' && !R.item ? 'hidden' : ''}>${icon('sheet')} إكسل</a>`);
    if (R.r === 'ledger') itemPicker($('#rip', pane), { kinds: ['drug', 'supply'], onPick: (it) => { R.item = it; drawCtl(); load(); } });
  };
  const kpis = (xs) => html`<div class="acc-kpis rep-kpis">${xs.map(([n, v, ic, cls, sub]) => html`<div class="akpi ${cls || ''}"><span class="gi">${icon(ic)}</span><div><small>${n}</small><b class="num">${v}</b>${sub ? html`<small class="muted">${sub}</small>` : ''}</div></div>`)}</div>`;
  const qt = (q, us) => unitsText(q, us);
  const byToggle = (a, b) => html`<div class="seg" id="rby"><button data-by="store" class="${R.by === 'store' ? 'on' : ''}">${a}</button><button data-by="item" class="${R.by === 'item' ? 'on' : ''}">${b}</button></div>`;
  const draw = (d) => {
    const box = $('#rb', pane);
    const xbtn = $('#rx', pane); if (xbtn) xbtn.href = '/api' + url(true);
    if (R.r === 'value') {
      const mx = Math.max(...d.stores.map((x) => x.cost), 0);
      box.innerHTML = String(html`${kpis([['القيمة بالتكلفة', money(d.totals.cost) + ' ' + HMS.money.symbol, 'wallet'], ['القيمة بسعر البيع', money(d.totals.sale) + ' ' + HMS.money.symbol, 'tag', 'ok'], ['الربح المتوقع', money(d.totals.sale - d.totals.cost) + ' ' + HMS.money.symbol, 'chart', 'late'], ['أصناف فيها رصيد', d.totals.items, 'box', d.totals.negative ? 'danger' : '', d.totals.negative ? `${d.totals.negative} تشغيلة سالبة` : '']])}
        <div class="rep-grid"><div class="card rep-card"><h4 class="subh">${icon('layers', 'sm')} بالمخزن</h4><div class="table-wrap"><table class="table"><thead><tr><th>المخزن</th><th class="n">أصناف</th><th style="width:30%"></th><th class="n">بالتكلفة</th><th class="n">بسعر البيع</th></tr></thead><tbody>
          ${d.stores.map((x) => html`<tr class="click" data-st="${x.id}"><td><b>${icon(K_IC[x.kind], 'sm')} ${x.name}</b>${x.negative ? html` <span class="badge danger">${x.negative} سالب</span>` : ''}</td><td class="n num">${x.items}</td><td>${bar(x.cost, mx)}</td><td class="n num"><b>${money(x.cost)}</b></td><td class="n num muted">${money(x.sale)}</td></tr>`)}</tbody></table></div></div>
        <div class="card rep-card"><h4 class="subh">${icon('box', 'sm')} أغلى الأصناف في المخزون</h4><div class="table-wrap" style="max-height:470px"><table class="table"><thead><tr><th>الصنف</th><th>الرصيد</th><th class="n">القيمة</th></tr></thead><tbody>
          ${d.items.slice(0, 40).map((x) => html`<tr class="click" data-it="${x.id}"><td><b>${x.name}</b></td><td class="num">${qt(x.qty, x.units)}</td><td class="n num"><b>${money(x.cost)}</b></td></tr>`)}</tbody></table></div></div></div>`);
      return;
    }
    if (R.r === 'consumption') {
      const mx = Math.max(...d.stores.map((x) => x.useCost), 0), mi = Math.max(...d.items.map((x) => x.cost), 0);
      box.innerHTML = String(html`${kpis([['المصروف للمرضى (تكلفة)', money(d.totals.useCost) + ' ' + HMS.money.symbol, 'arrows'], ['بسعر البيع', money(d.totals.useSale) + ' ' + HMS.money.symbol, 'tag', 'ok'], ['الإعدام', money(d.totals.waste) + ' ' + HMS.money.symbol, 'trash', 'danger'], ['فروق الجرد', money(d.totals.countDiff) + ' ' + HMS.money.symbol, 'clipboard', d.totals.countDiff < 0 ? 'danger' : 'late']])}
        <div class="row" style="margin:4px 0 10px">${byToggle('بالقسم / المخزن', 'بالصنف')}</div>
        ${R.by === 'store' ? html`<div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>المخزن</th><th style="width:28%"></th><th class="n">المصروف (تكلفة)</th><th class="n">بسعر البيع</th><th class="n">إعدام</th><th class="n">فروق جرد</th></tr></thead><tbody>
            ${d.stores.map((x) => html`<tr class="click" data-st="${x.id}"><td><b>${x.name}</b>${x.dept ? html` <span class="badge">${x.dept}</span>` : ''}</td><td>${bar(x.useCost, mx, 'var(--py)')}</td><td class="n num"><b>${money(x.useCost)}</b></td><td class="n num muted">${money(x.useSale)}</td>
              <td class="n num" style="color:${x.waste ? 'var(--danger)' : ''}">${x.waste ? money(x.waste) : '—'}</td><td class="n num" style="color:${x.countDiff < 0 ? 'var(--danger)' : x.countDiff > 0 ? 'var(--ok)' : ''}">${x.countDiff ? money(x.countDiff) : '—'}</td></tr>`)}
            ${!d.stores.length ? html`<tr><td colspan="6"><div class="empty" style="padding:16px">مفيش صرف في الفترة دي</div></td></tr>` : ''}</tbody></table></div></div>`
          : html`<div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>الصنف</th><th>الكمية</th><th style="width:24%"></th><th class="n">التكلفة</th><th class="n">بسعر البيع</th></tr></thead><tbody>
            ${d.items.map((x) => html`<tr class="click" data-it="${x.id}"><td><b>${x.name}</b> <span class="code num">${x.code}</span></td><td class="num">${qt(x.qty, x.units)}</td><td>${bar(x.cost, mi, TCAT[x.kind].c)}</td><td class="n num"><b>${money(x.cost)}</b></td><td class="n num muted">${money(x.sale)}</td></tr>`)}
            ${!d.items.length ? html`<tr><td colspan="5"><div class="empty" style="padding:16px">مفيش صرف في الفترة دي</div></td></tr>` : ''}</tbody></table></div></div>`}`);
      return;
    }
    if (R.r === 'pharmacy') {
      const t = d.totals, mx = Math.max(...d.days.map((x) => x.sold), 0), mi = Math.max(...d.items.map((x) => x.amount), 0);
      box.innerHTML = String(html`${kpis([['صافي البيع', money(t.net) + ' ' + HMS.money.symbol, 'cash', 'ok', `${t.count} فاتورة · متوسط ${money(t.avg)} ${HMS.money.symbol}`], ['المرتجع', money(t.back) + ' ' + HMS.money.symbol, 'undo', 'danger'], ['النقدي', money(t.cash) + ' ' + HMS.money.symbol, 'wallet', '', `فيزا ${money(t.card)} ${HMS.money.symbol}${t.credit ? ` · آجل ${money(t.credit)} ${HMS.money.symbol}` : ''}`], ['على التعاقدات', money(t.payer) + ' ' + HMS.money.symbol, 'shield', 'late']])}
        <div class="row" style="margin:4px 0 10px">${byToggle('باليوم', 'بالصنف')}</div>
        ${R.by === 'store' ? html`<div class="rep-grid"><div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>اليوم</th><th class="n">فواتير</th><th style="width:30%"></th><th class="n">البيع</th><th class="n">المرتجع</th><th class="n">الصافي</th></tr></thead><tbody>
            ${d.days.map((x) => html`<tr><td class="num">${dShort(x.date)}</td><td class="n num">${x.count}</td><td>${bar(x.sold, mx, '#d6336c')}</td><td class="n num">${money(x.sold)}</td><td class="n num" style="color:var(--danger)">${x.back ? money(x.back) : '—'}</td><td class="n num"><b>${money(x.net)}</b></td></tr>`)}
            ${!d.days.length ? html`<tr><td colspan="6"><div class="empty" style="padding:16px">مفيش بيع في الفترة دي</div></td></tr>` : ''}</tbody></table></div></div>
            <div class="card rep-card"><h4 class="subh">${icon('user', 'sm')} بالصيدلي</h4><div class="table-wrap"><table class="table"><thead><tr><th>الاسم</th><th class="n">فواتير</th><th class="n">الصافي</th></tr></thead><tbody>
            ${d.people.map((x) => html`<tr><td><b>${x.name}</b></td><td class="n num">${x.count}</td><td class="n num"><b>${money(x.net)}</b></td></tr>`)}</tbody></table></div></div></div>`
          : html`<div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>الصنف</th><th>الكمية</th><th style="width:22%"></th><th class="n">المبيعات</th><th class="n">التكلفة</th><th class="n">الربح</th></tr></thead><tbody>
            ${d.items.map((x) => html`<tr><td><b>${x.name}</b></td><td class="num">${qt(x.qty, x.units)}</td><td>${bar(x.amount, mi, '#d6336c')}</td><td class="n num"><b>${money(x.amount)}</b></td><td class="n num muted">${money(x.cost)}</td><td class="n num" style="color:${x.margin < 0 ? 'var(--danger)' : 'var(--ok)'}">${money(x.margin)}</td></tr>`)}
            ${!d.items.length ? html`<tr><td colspan="6"><div class="empty" style="padding:16px">مفيش بيع في الفترة دي</div></td></tr>` : ''}</tbody></table></div></div>`}`);
      return;
    }
    if (R.r === 'expiry') {
      const t = d.totals;
      box.innerHTML = String(html`${kpis([['منتهي الصلاحية', money(t.expired) + ' ' + HMS.money.symbol, 'alert', 'danger', `${t.expiredN} تشغيلة`], [`هينتهي خلال ${d.days} يوم`, money(t.soon) + ' ' + HMS.money.symbol, 'clock', 'late', `${t.soonN} تشغيلة`]])}
        <div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>الصنف</th><th>المخزن</th><th>التشغيلة</th><th>الصلاحية</th><th>الكمية</th><th class="n">القيمة</th>${M.can.waste ? html`<th></th>` : ''}</tr></thead><tbody>
          ${d.batches.map((x) => html`<tr class="${x.expired ? 'neg-row' : ''}"><td><b>${x.name}</b> <span class="code num">${x.code}</span></td><td>${x.store}</td><td class="num">${x.batchNo || '—'}</td>
            <td><span class="exp ${expCls(x.expiry)}">${dShort(x.expiry)}</span> <small class="muted">${x.expired ? 'منتهي' : `فاضل ${x.daysLeft} يوم`}</small></td><td class="num">${qt(x.qty, x.units)}</td><td class="n num"><b>${money(x.value)}</b></td>
            ${M.can.waste ? html`<td class="n"><button class="btn ghost sm" data-it="${x.itemId}" data-sti="${x.storeId}">${icon('box', 'sm')} الصنف</button></td>` : ''}</tr>`)}
          ${!d.batches.length ? html`<tr><td colspan="7"><div class="empty" style="padding:16px"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش حاجة منتهية أو قربت</b></div></td></tr>` : ''}</tbody></table></div></div>`);
      return;
    }
    if (R.r === 'stagnant') {
      box.innerHTML = String(html`${kpis([['قيمة الراكد', money(d.totals.value) + ' ' + HMS.money.symbol, 'hourglass', 'late'], ['أصناف راكدة', d.totals.count, 'box']])}
        <div class="alertbar info" style="margin-bottom:10px">${icon('info')}<span>أصناف ليها رصيد ومفيش منها صرف ولا بيع ولا تحويل من ${d.days} يوم. فكّر تحوّلها لمخزن بيصرفها أو توقف طلبها.</span></div>
        <div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>الصنف</th><th>المخزن</th><th>الرصيد</th><th class="n">القيمة</th><th>آخر صرف</th></tr></thead><tbody>
          ${d.items.map((x) => html`<tr class="click" data-it="${x.itemId}" data-sti="${x.storeId}"><td><b>${x.name}</b> <span class="code num">${x.code}</span></td><td>${x.store}</td><td class="num">${qt(x.qty, x.units)}</td><td class="n num"><b>${money(x.value)}</b></td><td class="muted">${x.lastOut ? fmtWhen(x.lastOut) : 'مفيش صرف خالص'}</td></tr>`)}
          ${!d.items.length ? html`<tr><td colspan="5"><div class="empty" style="padding:16px"><div class="art" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div><b>مفيش أصناف راكدة</b></div></td></tr>` : ''}</tbody></table></div></div>`);
      return;
    }
    if (R.r === 'ledger') {
      if (!d) { box.innerHTML = String(html`<div class="card empty"><div class="art">${icon('history')}</div><b>اختار الصنف</b>اكتب اسمه فوق واضغط Enter</div>`); return; }
      const us = d.item.units;
      box.innerHTML = String(html`<div class="ledger-sum card"><div><small>رصيد أول الفترة</small><b class="num">${qt(d.opening, us)}</b></div><div class="in"><small>وارد</small><b class="num">+ ${qt(d.in, us)}</b></div><div class="out"><small>منصرف</small><b class="num">- ${qt(d.out, us)}</b></div><div class="cl"><small>رصيد آخر الفترة</small><b class="num">${qt(d.closing, us)}</b></div></div>
        <div class="card rep-card"><div class="table-wrap"><table class="table"><thead><tr><th>إمتى</th><th>الحركة</th><th>المخزن</th><th>التشغيلة</th><th class="n">وارد</th><th class="n">منصرف</th><th class="n">الرصيد</th><th>مين</th></tr></thead><tbody>
          ${d.moves.map((m) => html`<tr><td class="muted" style="white-space:nowrap">${fmtWhen(m.at)}</td><td>${m.kindName}${m.note ? html` <small class="muted">· ${m.note}</small>` : ''}</td><td>${m.store}</td><td class="num">${m.batchNo || '—'}</td>
            <td class="n num" style="color:var(--ok)">${m.qty > 0 ? m.qty : ''}</td><td class="n num" style="color:var(--danger)">${m.qty < 0 ? -m.qty : ''}</td><td class="n num"><b>${m.balance}</b></td><td class="muted">${m.by || ''}</td></tr>`)}
          ${!d.moves.length ? html`<tr><td colspan="8"><div class="empty" style="padding:16px">مفيش حركة في الفترة دي</div></td></tr>` : ''}</tbody></table></div>
          <div class="muted" style="padding:8px;font-weight:600">الكميات بالـ${us[0].name}${us.length > 1 ? ' · ' + us.slice(1).map((u) => `${u.name} = ${u.factor}`).join(' · ') : ''}</div></div>`);
    }
  };
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    if (R.r === 'ledger' && !R.item) return draw(null);
    $('#rb', pane).classList.add('loading');
    try { const d = await api.get(url(false)); if (my === seq) draw(d); } catch (er) { toastError(er); } finally { $('#rb', pane).classList.remove('loading'); }
  };
  pane.onclick = (e) => {
    const r = e.target.closest('[data-r]');
    if (r) { R.r = r.dataset.r; R.by = 'store'; R.days = R.r === 'stagnant' ? 90 : 90; $$('[data-r]', pane).forEach((b) => b.classList.toggle('on', b === r)); history.replaceState(null, '', `#/stores?tab=reports&r=${R.r}`); drawCtl(); return load(); }
    const by = e.target.closest('[data-by]');
    if (by) { R.by = by.dataset.by; return load(); }
    const dd = e.target.closest('[data-d]');
    if (dd) { R.days = Number(dd.dataset.d); drawCtl(); return load(); }
    const q = e.target.closest('[data-q]');
    if (q) {
      const t = todayStr();
      R.to = t; R.from = { today: t, week: addDays(t, -6), month: monthStart(), year: t.slice(0, 4) + '-01-01' }[q.dataset.q];
      drawCtl(); return load();
    }
    const st = e.target.closest('tr[data-st]');
    if (st) { R.store = st.dataset.st; drawCtl(); return load(); }
    const it = e.target.closest('[data-it]');
    if (it) {
      if (R.r === 'consumption' || R.r === 'value') { allItems().then((xs) => { R.item = xs.find((x) => x.id === Number(it.dataset.it)); R.r = 'ledger'; $$('[data-r]', pane).forEach((b) => b.classList.toggle('on', b.dataset.r === 'ledger')); drawCtl(); load(); }); return; }
      return itemCard(Number(it.dataset.it), it.dataset.sti || R.store);
    }
  };
  pane.onchange = (e) => {
    if (e.target.id === 'rs') { R.store = e.target.value; return load(); }
    if (e.target.id === 'rf' && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { R.from = e.target.value; return load(); }
    if (e.target.id === 'rt' && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { R.to = e.target.value; return load(); }
  };
  if (!M.can.all && stores.length === 1) R.store = String(stores[0].id);
  drawCtl();
  await load();
  return () => { pane.onclick = pane.onchange = null; };
}
