// الخط الأساسي C — مبيعات ومرتجعات على تشغيلات متعددة التكلفة (FIFO بالأقرب انتهاءً)، رصيد سالب، تحويلات وإعدام وجرد على تشغيلات،
// وتقارير قيمة المخزون والحركة والاستهلاك وبيع الصيدلية والصلاحية والراكد، وتصدير Excel (قيم الخلايا وتنسيق الأرقام).
// مستقل عن scenario.js/scenarioB.js (قاعدة جديدة في الذاكرة). ملفات اختبار جديدة فقط: مفيش تعديل في البرنامج.
// ملاحظة: بنعمل «سفر في الزمن» على قاعدة الذاكرة المؤقتة نفسها (UPDATE مباشر لتواريخ حركات وصلاحيات) علشان نغطّي تقرير الراكد والمنتهي.
import ExcelJS from 'exceljs';
import { boot, u4, f4 } from './scenario.js';

const must = (r, st, what) => { if (r.status !== st) throw new Error(`${what}: توقعنا ${st} وجه ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`); return r.body; };
const errOf = (r) => (r.status >= 400 ? String(r.body?.error || '').slice(0, 140) : undefined);
const cairoDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };

/** تطبيع: التواريخ والأوقات (بتتغير مع اليوم) بتتحوّل لعلامة ثابتة، والأرقام الكسرية لـ4 خانات. بيشيل مفاتيح الوقت */
const normStr = (s) => String(s).replace(/\d{4}-\d{2}-\d{2}/g, '<D>').replace(/\d{1,2}:\d{2}(:\d{2})?(\s?[صم])?/g, '<T>');
export function normDeep(v) {
  if (Array.isArray(v)) return v.map(normDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/(At|^at|^from|^to|Date|date)$/.test(k)).map(([k, x]) => [k, normDeep(x)]));
  if (typeof v === 'number') return Number.isInteger(v) ? v : f4(v);
  return typeof v === 'string' ? normStr(v) : v;
}

/** قراءة ملف إكسل: لكل ورقة، الصفوف بالقيم، وتنسيق الأرقام لكل عمود (للخلايا الرقمية) */
export async function readXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb.worksheets.map((ws) => {
    const rows = []; const fmts = {};
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (c, col) => {
        let v = c.value;
        if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : null);
        if (v instanceof Date) v = '<D>';
        else if (typeof v === 'number') { (fmts[col] ||= new Set()).add(c.numFmt || 'General'); v = Number.isInteger(v) ? v : f4(v); }
        else if (typeof v === 'string') v = normStr(v);
        cells[col - 1] = v ?? null;
      });
      rows.push(Array.from(cells, (x) => x ?? null));
    });
    return { name: normStr(ws.name), rows, numFmts: Object.fromEntries(Object.entries(fmts).map(([k, s]) => [k, [...s].sort()])) };
  });
}

const TABLES = {
  StockBatches: ['Id', 'ItemId', 'StoreId', 'BatchNo', 'Qty', 'Cost'],
  StockMoves: ['Id', 'Kind', 'ItemId', 'StoreId', 'BatchId', 'Qty', 'Cost', 'RefType', 'RefId'],
  StockItems: ['Id', 'Name', 'LastCost'],
  StockWaste: ['Id', 'StoreId', 'ItemId', 'BatchId', 'Qty', 'Cost'],
  StockCounts: ['Id', 'StoreId', 'Status', 'DiffValue'],
  StockCountLines: ['Id', 'CountId', 'ItemId', 'BatchId', 'SystemQty', 'CountedQty', 'Cost'],
  Transfers: ['Id', 'FromStoreId', 'ToStoreId', 'Status'],
  TransferLines: ['Id', 'TransferId', 'ItemId', 'ReqQty', 'IssuedQty'],
  Purchases: ['Id', 'Kind', 'StoreId', 'Total'],
  PurchaseLines: ['Id', 'PurchaseId', 'ItemId', 'UnitFactor', 'Qty', 'BaseQty', 'UnitCost', 'LineTotal'],
  Receipts: ['Id', 'Kind', 'Gross', 'Discount', 'Net', 'Cash', 'Card', 'Credit'],
  ReceiptLines: ['Id', 'ReceiptId', 'VisitItemId', 'Qty', 'UnitPrice', 'Amount', 'DiscountShare', 'PayerAmount'],
  VisitItems: ['Id', 'VisitId', 'Qty', 'UnitFactor', 'ReturnedQty', 'UnitPrice', 'Amount', 'Status', 'StockItemId', 'StoreId'],
};
async function snapshot(db) {
  const out = {};
  for (const [t, keep] of Object.entries(TABLES)) {
    const cols = await db.query(`PRAGMA table_info(${t})`);
    const num = cols.filter((c) => /NUMERIC|DECIMAL|REAL/i.test(c.type) && !['SharePct', 'ShareFixed', 'DoctorFixed'].includes(c.name)).map((c) => c.name);
    const rows = await db.query(`SELECT * FROM ${t} ORDER BY Id`);
    const sums = {};
    for (const c of num) sums[c] = rows.reduce((a, r) => a + (u4(r[c]) || 0), 0);
    out[t] = { count: rows.length, sums, rows: rows.map((r) => Object.fromEntries(keep.map((k) => [k, num.includes(k) ? f4(r[k]) : (r[k] ?? null)]))) };
  }
  return out;
}
/** قيمة المخزون = Σ(رصيد التشغيلة × تكلفتها) بوحدة 1e-8 كأعداد صحيحة. بنفصل: السالب، وبدون تكلفة */
async function valuation(db) {
  const rows = await db.query('SELECT StoreId, ItemId, Qty, Cost FROM StockBatches ORDER BY StoreId, ItemId, Id');
  const mk = () => ({ posQtyU4: 0, posValueU8: 0, negQtyU4: 0, noCostPosQtyU4: 0 });
  const byStore = {}; const total = mk();
  for (const r of rows) {
    const s = (byStore[r.StoreId] ||= mk()); const q = u4(r.Qty);
    for (const x of [s, total]) {
      if (q < 0) x.negQtyU4 += q;
      else if (r.Cost == null) x.noCostPosQtyU4 += q;
      else { x.posQtyU4 += q; x.posValueU8 += q * u4(r.Cost); }
    }
  }
  return { byStore, total };
}

/** يبني السيناريو على ctx/U ويرجّع { steps, ids } — منفصل علشان سكربت قياس cost4 يعيد استخدامه على قاعدة مؤقتة */
export async function buildC(ctx, U) {
  const steps = []; const note = (name, data) => steps.push({ name, ...data });
  const checkpoints = {};
  /** أرصدة التشغيلات في لحظة معيّنة: «مخزن:صنف:تشغيلة» → كمية (علشان نقارنها بحساب يدوي مستقل) */
  const checkpoint = async (label) => {
    const rows = await ctx.db.query('SELECT StoreId, ItemId, BatchNo, Qty, Cost, Id FROM StockBatches ORDER BY Id');
    checkpoints[label] = Object.fromEntries(rows.map((r) => [`${r.StoreId}:${r.ItemId}:${r.BatchNo ?? 'loose#' + r.Id}`, f4(r.Qty)]));
  };
  const { mgr, sacc, rec, ph, sup, fin } = U;
  const items = (await sacc.get('/api/tickets/items')).body.items;
  const I = (n) => { const x = items.find((y) => y.name === n); if (!x) throw new Error('صنف مش موجود ' + n); return x; };
  const stores = (await mgr.get('/api/stores/meta')).body.stores;
  const S = (n) => stores.find((x) => x.name === n).id;
  const PH = S('الصيدلية'), ER = S('مخزن الطوارئ');
  const day = cairoDay(); const ex = (n) => addDays(day, n);
  const CF = I('سيفترياكسون 1 جم'), AM = I('أموكسيسيلين/كلافيولانيك 1 جم أقراص'), KT = I('كيتورولاك 30 مجم'), CN = I('كانيولا 20G');
  const GL = I('جوانتي فحص'), SY = I('سرنجة 5 مل'), GZ = I('شاش معقم');
  let pn = 0;
  const patient = async () => { pn++; return must(await rec.post('/api/patients', { name: `مريض مخزون رقم ${pn} علي`, phone: `0109900${String(pn).padStart(4, '0')}`, ageYears: 30, sex: 'M', confirmDuplicatePhone: true }), 201, 'patient').patient; };
  const buy = async (name, body) => { const r = await sacc.post('/api/stores/purchases', body); note(name, { status: r.status, err: errOf(r) }); if (r.status !== 201) throw new Error(name + ' ' + JSON.stringify(r.body).slice(0, 200)); };

  // ===== 1) أرصدة بتشغيلات بتكاليف مختلفة (وحدة أساسية = فيال/قرص/قطعة) =====
  // سيفترياكسون (علبة=10): C1 علبة@33 → 10 فيال بتكلفة 3.3 (+20 يوم)، C2 8 فيال@3.45 (+75)، C3 علبتين@35.55 → 20 فيال بتكلفة 3.555 (+400)
  await buy('أول مدة صيدلية: سيفترياكسون (3 تشغيلات)', { kind: 'opening', storeId: PH, lines: [
    { itemId: CF.id, unit: 'pack', qty: 1, cost: 33, batchNo: 'C1', expiry: ex(20) },
    { itemId: CF.id, unit: 'base', qty: 8, cost: 3.45, batchNo: 'C2', expiry: ex(75) },
    { itemId: CF.id, unit: 'pack', qty: 2, cost: 35.55, batchNo: 'C3', expiry: ex(400) }] });
  // أموكسي (شريط=7، علبة=14): A1 3 علب@100 → 42 قرص بتكلفة 7.142857 (+300)، A2 4 شرايط@33.33 → 28 قرص بتكلفة 4.761428… (+500)
  await buy('أول مدة صيدلية: أموكسي (علب وشرايط)', { kind: 'opening', storeId: PH, lines: [
    { itemId: AM.id, unit: 'pack', qty: 3, cost: 100, batchNo: 'A1', expiry: ex(300) },
    { itemId: AM.id, unit: 'mid', qty: 4, cost: 33.33, batchNo: 'A2', expiry: ex(500) }] });
  // كيتورولاك (علبة=3): K1 علبة@7.99 → 3 أمبول بتكلفة 2.6633
  await buy('أول مدة صيدلية: كيتورولاك', { kind: 'opening', storeId: PH, lines: [{ itemId: KT.id, unit: 'pack', qty: 1, cost: 7.99, batchNo: 'K1', expiry: ex(200) }] });
  // كانيولا: N1 علبة@87.5 → 50 بتكلفة 1.75 (+30)، N2 20@1.9 (+60)
  await buy('أول مدة صيدلية: كانيولا', { kind: 'opening', storeId: PH, lines: [
    { itemId: CN.id, unit: 'pack', qty: 1, cost: 87.5, batchNo: 'N1', expiry: ex(30) }, { itemId: CN.id, unit: 'base', qty: 20, cost: 1.9, batchNo: 'N2', expiry: ex(60) }] });
  // أصناف هتتحوّل لراكد/منتهي (بنأرّخ حركاتها بعدين) + صنف جديد داخل المدة
  await buy('أول مدة صيدلية: جوانتي وسرنجة وشاش', { kind: 'opening', storeId: PH, lines: [
    { itemId: GL.id, unit: 'pack', qty: 1, cost: 33.33, batchNo: 'G1', expiry: ex(500) }, { itemId: SY.id, unit: 'pack', qty: 1, cost: 55.55, batchNo: 'S1', expiry: ex(500) },
    { itemId: GZ.id, unit: 'base', qty: 12.5, cost: 1.15, batchNo: 'Z1', expiry: ex(500) }] });

  // ===== 2) مبيعات الصيدلية بالـFIFO (بالأقرب انتهاءً) ومرتجعات على تشغيلات =====
  const newVisit = async (user, type = 'pharmacy') => must(await user.post('/api/visits', { patientId: (await patient()).id, type }), 201, 'visit').visit; // مريض جديد لكل زيارة (المريض ليه زيارة مفتوحة واحدة بس من كل نوع)
  const v1 = await newVisit(ph);
  const addTo = async (v, user, body) => { const r = await user.post(`/api/visits/${v.id}/items`, body); if (r.status !== 201) throw new Error('add ' + JSON.stringify(r.body).slice(0, 200)); return r.body.itemId; };
  const pay = async (v, user, discount) => { const d = (await user.get(`/api/visits/${v.id}`)).body; return must(await user.post(`/api/visits/${v.id}/pay`, { itemIds: d.items.filter((i) => i.paid === undefined || !i.paid).map((i) => i.id), cash: d.totals.due }), 201, 'pay'); };
  const s1 = await addTo(v1, ph, { stockItemId: CF.id, unit: 'base', qty: 15 }); // C1 10 + C2 5
  const pr1 = await pay(v1, ph);
  note('بيع 15 فيال (C1 كلها + 5 من C2)', { receipt: pr1.receiptId });
  const rt1 = await sup.post(`/api/visits/${v1.id}/items/${s1}/return`, { reason: 'مرتجع جزئي متعدد', qty: 7 });
  note('مرتجع 7 من 15 (آخر اللي اتصرف يرجع الأول: 5 على C2 و2 على C1)', { status: rt1.status, err: errOf(rt1) });
  const v2 = await newVisit(ph);
  const s2 = await addTo(v2, ph, { stockItemId: CF.id, unit: 'pack', qty: 2 }); // 20 فيال: C1 2 + C2 8 + C3 10
  await pay(v2, ph);
  note('بيع علبتين (20 فيال) عبر 3 تشغيلات', {});
  const rt2 = await sup.post(`/api/visits/${v2.id}/items/${s2}/return`, { reason: 'مرتجع علبة', qty: 1 });
  note('مرتجع علبة (10 فيال)', { status: rt2.status, err: errOf(rt2) });
  // أموكسي: علبتين = 28 قرص: A1 كلها 42؟ لا: A1 42 قرص (3 علب) فهتتصرف 28 من A1 بس
  const v3 = await newVisit(ph);
  const s3 = await addTo(v3, ph, { stockItemId: AM.id, unit: 'pack', qty: 2 });
  await pay(v3, ph);
  const s3b = await addTo(v3, ph, { stockItemId: AM.id, unit: 'mid', qty: 3 }); // 21 قرص: A1 14 باقيين + A2 7
  await pay(v3, ph);
  note('بيع أموكسي علبتين ثم 3 شرايط (يعدّي من A1 لـA2)', {});
  const rt3 = await sup.post(`/api/visits/${v3.id}/items/${s3b}/return`, { reason: 'مرتجع شريط', qty: 2 });
  note('مرتجع شريطين', { status: rt3.status, err: errOf(rt3) });
  // بند اتضاف وما اتدفعش: تعديل عدده وشيله (بيرجّع جزء ثم الباقي)
  const v4 = await newVisit(ph);
  const s4 = await addTo(v4, ph, { stockItemId: CN.id, unit: 'base', qty: 60 }); // N1 50 + N2 10
  const ed = await ph.put(`/api/visits/${v4.id}/items/${s4}`, { qty: 55 });
  note('تعديل بند غير مدفوع من 60 لـ55 (يرجّع 5 على N2)', { status: ed.status, err: errOf(ed) });
  const dl = await ph.del(`/api/visits/${v4.id}/items/${s4}`);
  note('شيل البند غير المدفوع (يرجّع الباقي)', { status: dl.status, err: errOf(dl) });
  // إلغاء إيصال بيع بالكامل
  const v5 = await newVisit(ph);
  await addTo(v5, ph, { stockItemId: CN.id, unit: 'base', qty: 60 });
  const pr5 = await pay(v5, ph);
  const cc = await mgr.post(`/api/receipts/${pr5.receiptId}/cancel`, { reason: 'إلغاء إيصال بيع للاختبار' });
  note('إلغاء إيصال بيع كانيولا 60 (متعدد التشغيلات)', { status: cc.status, err: errOf(cc) });

  await checkpoint('afterSales');
  // ===== 3) رصيد سالب: بيع أكتر من الرصيد بصلاحية، ورفضه بدونها، وتسديد السالب بالاستلام =====
  const v6 = await newVisit(mgr);
  const noNeg = await ph.post(`/api/visits/${v6.id}/items`, { stockItemId: KT.id, unit: 'base', qty: 5 });
  note('بيع كيتورولاك 5 والرصيد 3 بدون صلاحية سالب (مرفوض)', { status: noNeg.status, err: errOf(noNeg) });
  const s6 = await addTo(v6, mgr, { stockItemId: KT.id, unit: 'base', qty: 5 }); // 3 من K1 + 2 على رصيد سالب بدون تكلفة
  const pr6 = await pay(v6, mgr);
  note('بيع كيتورولاك 5 بصلاحية سالب (3 من K1 و2 سالب)', { receipt: pr6.receiptId });
  await buy('استلام مورد يسدّد السالب (6 أمبول)', { kind: 'supplier', supplier: 'مورد مخزون ج', storeId: PH, lines: [{ itemId: KT.id, unit: 'base', qty: 6, cost: 2.7, batchNo: 'K2', expiry: ex(250) }] });
  void s6;
  await checkpoint('afterNegative');

  // ===== 4) تحويل متعدد التشغيلات، إعدام، وجرد =====
  const T = must(await sacc.post('/api/stores/transfers', { fromStoreId: PH, toStoreId: ER, issue: true, lines: [{ itemId: AM.id, unit: 'base', qty: 22 }] }), 201, 'transfer');
  note('تحويل 22 قرص أموكسي للطوارئ (تشغيلتين)', {});
  note('استلام التحويل', { status: (await sacc.post(`/api/stores/transfers/${T.transfer.id}/receive`)).status });
  await checkpoint('afterTransfer');
  const dbBatch = async (item, store, no) => (await ctx.db.query('SELECT Id, Qty FROM StockBatches WHERE ItemId = ? AND StoreId = ? AND BatchNo = ?', [item.id, store, no]))[0];
  const wb = await dbBatch(AM, PH, 'A2');
  const w = await sacc.post('/api/stores/waste', { batchId: wb.Id, qty: 1.5, reason: 'تالف' });
  note('إعدام 1.5 من A2', { status: w.status, err: errOf(w) });
  await checkpoint('afterWaste');
  const C = must(await sacc.post('/api/stores/counts', { storeId: PH, note: 'جرد C' }), 201, 'count');
  const cid = C.count?.id ?? C.id;
  const lines = (await sacc.get(`/api/stores/counts/${cid}`)).body.lines;
  await sacc.post(`/api/stores/counts/${cid}/save`, { lines: lines.map((l, k) => ({ id: l.id, counted: k % 3 === 0 ? Number(l.systemQty) - 1 : k % 3 === 1 ? Number(l.systemQty) + 2.5 : Number(l.systemQty) })), add: [{ itemId: GL.id, counted: 4, batchNo: 'G-NEW', expiry: ex(450) }] });
  note('تسليم الجرد', { status: (await sacc.post(`/api/stores/counts/${cid}/submit`)).status });
  note('اعتماد الجرد (فروق على تشغيلات مختلفة التكلفة)', { status: (await mgr.post(`/api/stores/counts/${cid}/approve`)).status });

  // بيع من الطوارئ من الأرصدة المحوّلة
  const ve = await newVisit(rec, 'emergency');
  await addTo(ve, rec, { stockItemId: AM.id, unit: 'base', qty: 9 });
  note('بيع أموكسي 9 من الطوارئ (من التشغيلات المحوّلة)', {});

  // ===== 5) سفر في الزمن على القاعدة المؤقتة: راكد (200 يوم) ومنتهي =====
  const old = new Date(Date.now() - 200 * 864e5);
  for (const it of [GL, SY]) {
    await ctx.db.run('UPDATE StockMoves SET At = ? WHERE ItemId = ? AND StoreId = ? AND BatchId IN (SELECT Id FROM StockBatches WHERE BatchNo IN (?, ?))', [old, it.id, PH, 'G1', 'S1']);
  }
  await ctx.db.run('UPDATE StockBatches SET Expiry = ? WHERE ItemId = ? AND StoreId = ? AND BatchNo = ?', [ex(-10), SY.id, PH, 'S1']); // منتهي من 10 أيام
  note('أرّخنا حركات الجوانتي والسرنجة 200 يوم وخلّينا تشغيلة السرنجة منتهية', {});

  // مصروفات علشان تصدير Excel المالي
  must(await fin.post('/api/finance/expenses', { categoryId: (await fin.get('/api/finance/expense-categories')).body.categories[0].id, amount: 750.25, method: 'cash', payee: 'مصروف C', date: day }), 201, 'expense');
  must(await fin.post('/api/finance/expenses', { categoryId: (await fin.get('/api/finance/expense-categories')).body.categories[0].id, amount: 99.95, method: 'bank', payee: 'مصروف C2', date: day }), 201, 'expense2');
  await checkpoint('final');
  return { steps, checkpoints, ids: { PH, ER, CF: CF.id, AM: AM.id, KT: KT.id, CN: CN.id }, day };
}

/** كل التقارير والإكسل بعد ما السيناريو يخلص: بترجّع تطبيع ثابت */
export async function collectC(ctx, U, { PH, CF, AM }) {
  const { mgr, sacc, fin } = U;
  const get = async (u) => { const r = await mgr.get(u); return { status: r.status, body: normDeep(r.body) }; };
  const reports = {
    value: await get('/api/stock-reports/value'),
    valuePharmacy: await get('/api/stock-reports/value?storeId=' + PH),
    ledgerCeftriaxone: await get(`/api/stock-reports/ledger?itemId=${CF}&storeId=${PH}`),
    ledgerAmoxi: await get(`/api/stock-reports/ledger?itemId=${AM}&storeId=all`),
    consumption: await get('/api/stock-reports/consumption'),
    consumptionByItem: await get('/api/stock-reports/consumption?by=item'),
    pharmacy: await get('/api/stock-reports/pharmacy'),
    expiry90: await get('/api/stock-reports/expiry?days=90'),
    expiry730: await get('/api/stock-reports/expiry?days=730'),
    stagnant90: await get('/api/stock-reports/stagnant?days=90'),
    stagnant30: await get('/api/stock-reports/stagnant?days=30'),
  };
  const xl = {};
  const grab = async (key, client, url) => { const r = await client.get(url); xl[key] = r.status === 200 && Buffer.isBuffer(r.body) ? await readXlsx(r.body) : { status: r.status }; };
  await grab('value', mgr, '/api/stock-reports/value?format=xlsx');
  await grab('ledger', mgr, `/api/stock-reports/ledger?itemId=${CF}&storeId=${PH}&format=xlsx`);
  await grab('consumptionStores', mgr, '/api/stock-reports/consumption?format=xlsx');
  await grab('consumptionItems', mgr, '/api/stock-reports/consumption?by=item&format=xlsx');
  await grab('pharmacyDays', mgr, '/api/stock-reports/pharmacy?format=xlsx');
  await grab('pharmacyItems', mgr, '/api/stock-reports/pharmacy?by=item&format=xlsx');
  await grab('expiry', mgr, '/api/stock-reports/expiry?days=90&format=xlsx');
  await grab('stagnant', mgr, '/api/stock-reports/stagnant?days=90&format=xlsx');
  await grab('treasury', mgr, '/api/reports/treasury?format=xlsx');
  await grab('expenses', fin, `/api/finance/expenses/export?from=${addDays(cairoDay(), -40)}&to=${addDays(cairoDay(), 1)}`); // مدى صريح: الافتراضي بيعتمد على يوم الخزينة (قبل 7 الصبح بيختلف عن تاريخ القاهرة)
  await grab('servicesTemplate', mgr, '/api/admin/services/export');
  await grab('itemsTemplate', sacc, '/api/tickets/items/export');
  const payers = (await mgr.get('/api/payers')).body.payers;
  await grab('payerStatement', mgr, `/api/payers/${payers[0].id}/statement?format=xlsx`);
  return { reports, xlsx: xl, valuation: await valuation(ctx.db), db: await snapshot(ctx.db) };
}

export async function runScenarioC() {
  const day0 = cairoDay();
  const { ctx, U, close } = await boot();
  try {
    const { steps, checkpoints, ids } = await buildC(ctx, U);
    const out = await collectC(ctx, U, ids);
    if (cairoDay() !== day0) throw new Error('اليوم اتغيّر أثناء التشغيل. أعد التشغيل.');
    return { steps: JSON.parse(JSON.stringify(steps)), checkpoints, ...out, known: [{ name: 'ربط الأرقام الكسرية في مشغّل SQL Server', where: 'src/db/mssql.js سطر 14', effect: 'الأرقام الكسرية بتتربط Decimal(12,2): التكلفة (12,4) والنسب والكميات ممكن تتقرّب لخانتين على SQL Server فقط. الخط ده SQLite ومش بيكشفها' }] };
  } finally { await close(); }
}
