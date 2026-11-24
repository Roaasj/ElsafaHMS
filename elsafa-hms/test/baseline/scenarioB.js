// الخط الأساسي B — المخازن والمشتريات والتحويلات والجرد والهالك والأقساط وسداد السندات بالخزينة.
// مستقل عن scenario.js (قاعدة جديدة في الذاكرة) علشان الخط الأصلي (baseline.golden.json) يفضل ثابت بدون أي تغيير.
// مفيش import لكود المبالغ (cents/pounds). بيستخدم boot/u4/f4 من scenario.js بس.
import { boot, u4, f4 } from './scenario.js';

const must = (r, st, what) => { if (r.status !== st) throw new Error(`${what}: توقعنا ${st} وجه ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`); return r.body; };
const errOf = (r) => (r.status >= 400 ? String(r.body?.error || '').slice(0, 140) : undefined);
const cairoDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

// جداول المخزون والمالية اللي بيغطيها السيناريو ده (كل صف بتفاصيله — مفيش تواريخ ولا أوقات)
const TABLES = {
  Purchases: ['Id', 'Kind', 'StoreId', 'Total'],
  PurchaseLines: ['Id', 'PurchaseId', 'ItemId', 'UnitFactor', 'Qty', 'BaseQty', 'UnitCost', 'LineTotal'],
  StockBatches: ['Id', 'ItemId', 'StoreId', 'BatchNo', 'Qty', 'Cost'],
  StockMoves: ['Id', 'Kind', 'ItemId', 'StoreId', 'BatchId', 'Qty', 'Cost', 'RefType'],
  StockItems: ['Id', 'Name', 'LastCost'],
  Transfers: ['Id', 'FromStoreId', 'ToStoreId', 'Status', 'Direct'],
  TransferLines: ['Id', 'TransferId', 'ItemId', 'ReqQty', 'IssuedQty'],
  StockWaste: ['Id', 'StoreId', 'ItemId', 'BatchId', 'Qty', 'Cost'],
  StockCounts: ['Id', 'StoreId', 'Status', 'DiffValue'],
  StockCountLines: ['Id', 'CountId', 'ItemId', 'BatchId', 'SystemQty', 'CountedQty', 'Cost'],
  Obligations: ['Id', 'Name', 'Active'],
  ObligationInstallments: ['Id', 'ObligationId', 'No', 'Amount', 'Status', 'Method', 'VoucherId'],
  CashVouchers: ['Id', 'Kind', 'Status', 'Amount', 'RefId', 'ShiftId'],
  Suppliers: ['Id', 'Name'],
  SupplierInvoices: ['Id', 'SupplierId', 'PurchaseId', 'Amount', 'Status'],
  SupplierPayments: ['Id', 'SupplierId', 'InvoiceId', 'Method', 'Amount', 'Status', 'VoucherId'],
  CashShifts: [],
};

async function snapshot(db) {
  const out = {};
  for (const [t, keep] of Object.entries(TABLES)) {
    let cols;
    try { cols = await db.query(`PRAGMA table_info(${t})`); } catch { continue; }
    if (!cols.length) continue;
    const num = cols.filter((c) => /NUMERIC|DECIMAL|REAL/i.test(c.type) && !['SharePct', 'ShareFixed', 'DoctorFixed'].includes(c.name)).map((c) => c.name);
    const rows = await db.query(`SELECT * FROM ${t} ORDER BY Id`);
    const sums = {};
    for (const c of num) sums[c] = rows.reduce((a, r) => a + (u4(r[c]) || 0), 0);
    out[t] = { count: rows.length, sums };
    if (keep.length) out[t].rows = rows.map((r) => Object.fromEntries(keep.map((k) => [k, num.includes(k) ? f4(r[k]) : (r[k] ?? null)])));
  }
  return out;
}

/** قيمة المخزون = مجموع (رصيد التشغيلة × تكلفتها) لكل مخزن، محسوبة هنا بوحدة 1e-8 كأعداد صحيحة (بدون كسور عائمة) */
async function valuation(db) {
  const rows = await db.query('SELECT StoreId, ItemId, Qty, Cost FROM StockBatches ORDER BY StoreId, ItemId, Id');
  const byStore = {}; const total = { qtyU4: 0, valueU8: 0, noCostQty: 0 };
  for (const r of rows) {
    const s = (byStore[r.StoreId] ||= { qtyU4: 0, valueU8: 0, noCostQty: 0 });
    const q = u4(r.Qty);
    s.qtyU4 += q; total.qtyU4 += q;
    if (r.Cost == null) { s.noCostQty += q; total.noCostQty += q; } else { const v = q * u4(r.Cost); s.valueU8 += v; total.valueU8 += v; }
  }
  return { byStore, total };
}

/** تطبيع عميق: الأرقام لـ4 خانات ثابتة، وشيل أي حاجة وقت/تاريخ */
function normDeep(v) {
  if (Array.isArray(v)) return v.map(normDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/(At|Date|date|^at|^from|^to)$/.test(k)).map(([k, x]) => [k, normDeep(x)]));
  return typeof v === 'number' ? f4(v) : v;
}

export async function runScenarioB() {
  const day0 = cairoDay();
  const { ctx, U, close } = await boot();
  const steps = []; const known = [];
  const note = (name, data) => steps.push({ name, ...data });
  try {
    const { mgr, sacc, fin, cas, rec } = U;
    const items = (await sacc.get('/api/tickets/items')).body.items || (await mgr.get('/api/tickets/items')).body.items;
    const I = (n) => { const x = items.find((y) => y.name === n); if (!x) throw new Error('صنف مش موجود ' + n); return x; };
    const stores = (await mgr.get('/api/stores/meta')).body.stores;
    const S = (n) => stores.find((x) => x.name === n).id;
    const MAIN_D = S('مخزن الأدوية الرئيسي'), MAIN_S = S('مخزن المستلزمات الرئيسي'), PHARM = S('الصيدلية'), ER = S('مخزن الطوارئ'), ICU = S('مخزن العناية');
    const day = cairoDay();

    // ===== 1) مشتريات: وحدات وعلب بتكلفة تطلع كسر بعد القسمة على معامل العلبة =====
    // سيفترياكسون: علبة=10 فيال. تكلفة العلبة 33 => 3.3 للفيال. تكلفة 100 على علبة => 10.
    // أموكسي أقراص: علبة=14 قرص، شريط=7. علبة بـ100 => 7.142857 للقرص (بيتخزن بـ4 خانات في تشغيلة وLastCost)
    // كانيولا 20G: علبة=50. علبة بـ 87.5 => 1.75
    const buy = async (name, body, st = 201) => {
      const r = await sacc.post('/api/stores/purchases', body);
      note(name, { status: r.status, err: errOf(r) });
      if (r.status !== st) throw new Error(name + ' ' + JSON.stringify(r.body).slice(0, 200));
      return r.body;
    };
    const P1 = await buy('استلام مورد: أدوية بوحدة العلبة', { kind: 'supplier', supplier: 'مورد مخزن أساسي', invoiceNo: 'INV-B-1', invoiceDate: day, storeId: MAIN_D, lines: [
      { itemId: I('سيفترياكسون 1 جم').id, unit: 'pack', qty: 5, cost: 33, batchNo: 'CF-1', expiry: '2028-03-31' },
      { itemId: I('سيفترياكسون 1 جم').id, unit: 'base', qty: 7, cost: 3.45, batchNo: 'CF-2', expiry: '2028-09-30' },
      { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 3, cost: 100, batchNo: 'AM-1', expiry: '2027-12-31' },
      { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'mid', qty: 4, cost: 33.33, batchNo: 'AM-2', expiry: '2028-06-30' },
      { itemId: I('كيتورولاك 30 مجم').id, unit: 'pack', qty: 10, cost: 7.99, batchNo: 'KT-1', expiry: '2028-01-31' },
      { itemId: I('باراسيتامول 1 جم محلول').id, unit: 'pack', qty: 2, cost: 100 },
    ] });
    await buy('استلام مورد: مستلزمات بكسور', { kind: 'supplier', supplier: 'مورد مستلزمات أساسي', invoiceNo: 'INV-B-2', invoiceDate: day, storeId: MAIN_S, lines: [
      { itemId: I('كانيولا 20G').id, unit: 'pack', qty: 6, cost: 87.5 },
      { itemId: I('سرنجة 5 مل').id, unit: 'pack', qty: 3, cost: 55.55 },
      { itemId: I('جوانتي فحص').id, unit: 'pack', qty: 2, cost: 33.33 },
      { itemId: I('شاش معقم').id, unit: 'base', qty: 12.5, cost: 1.15 },
    ] });
    await buy('رصيد أول المدة صيدلية', { kind: 'opening', storeId: PHARM, lines: [
      { itemId: I('سيفترياكسون 1 جم').id, unit: 'base', qty: 20, cost: 3.3, batchNo: 'CF-P', expiry: '2028-03-31' },
      { itemId: I('كيتورولاك 30 مجم').id, unit: 'base', qty: 30, cost: 2.6633, batchNo: 'KT-P', expiry: '2028-01-31' },
    ] });
    const p0 = await sacc.post('/api/stores/purchases', { kind: 'supplier', supplier: 'x', storeId: MAIN_D, lines: [{ itemId: I('كانيولا 20G').id, qty: 1, cost: 1 }] });
    note('استلام مستلزم في مخزن أدوية (مرفوض)', { status: p0.status, err: errOf(p0) });
    const pn = await sacc.post('/api/stores/purchases', { kind: 'supplier', supplier: 'x', storeId: MAIN_D, lines: [{ itemId: I('كيتورولاك 30 مجم').id, qty: 1, cost: -5 }] });
    note('سعر سالب (مرفوض)', { status: pn.status, err: errOf(pn) });

    // ===== 2) تحويلات: طلب/صرف/استلام/تأكيد + مباشر + إلغاء بعد الصرف =====
    const tr = async (name, body) => { const r = await sacc.post('/api/stores/transfers', body); note(name, { status: r.status, err: errOf(r) }); return r; };
    const batches0 = (await ctx.db.query('SELECT Id, ItemId, StoreId, BatchNo, Qty FROM StockBatches')).length;
    const T1 = must(await tr('تحويل طلب (صيدلية من الرئيسي)', { fromStoreId: MAIN_D, toStoreId: PHARM, lines: [{ itemId: I('سيفترياكسون 1 جم').id, unit: 'pack', qty: 2 }, { itemId: I('كيتورولاك 30 مجم').id, unit: 'base', qty: 7.5 }] }), 201, 'tr1');
    const t1id = T1.transfer.id;
    // صرف بكمية أقل من المطلوب في سطر (الباقي ما اتصرفش)، وبعدين استلام وتأكيد
    const lines1 = T1.lines;
    const iss = await sacc.post(`/api/stores/transfers/${t1id}/issue`, { lines: [{ lineId: lines1[0].id, qty: 15 }, { lineId: lines1[1].id, qty: 7.5 }] });
    note('صرف التحويل (جزئي لسطر)', { status: iss.status, err: errOf(iss) });
    note('استلام التحويل', { status: (await sacc.post(`/api/stores/transfers/${t1id}/receive`)).status });
    note('تأكيد التحويل', { status: (await sacc.post(`/api/stores/transfers/${t1id}/confirm`)).status });
    const rd = await sacc.post('/api/stores/transfers', { fromStoreId: MAIN_S, toStoreId: ER, issue: true, direct: true, lines: [{ itemId: I('كانيولا 20G').id, unit: 'pack', qty: 2 }] });
    note('تحويل مباشر بدون صلاحية (مرفوض)', { status: rd.status, err: errOf(rd) });
    const rd2 = await mgr.post('/api/stores/transfers', { fromStoreId: MAIN_S, toStoreId: ER, issue: true, direct: true, lines: [{ itemId: I('كانيولا 20G').id, unit: 'pack', qty: 2 }, { itemId: I('شاش معقم').id, unit: 'base', qty: 3.5 }] });
    note('تحويل مباشر (مستلزمات للطوارئ) بصلاحية المدير', { status: rd2.status, err: errOf(rd2) });
    const T3 = must(await tr('تحويل للعناية (صرف بدون استلام)', { fromStoreId: MAIN_D, toStoreId: ICU, issue: true, lines: [{ itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'mid', qty: 3 }] }), 201, 'tr3');
    const c3 = await sacc.post(`/api/stores/transfers/${T3.transfer.id}/cancel`, { reason: 'إلغاء بعد الصرف لاختبار الإرجاع' });
    note('إلغاء تحويل بعد الصرف (الرصيد يرجع)', { status: c3.status, err: errOf(c3) });
    const over = await tr('تحويل أكبر من الرصيد (مرفوض)', { fromStoreId: MAIN_S, toStoreId: ER, issue: true, lines: [{ itemId: I('جوانتي فحص').id, unit: 'pack', qty: 50 }] });

    // ===== 3) إعدام (هالك): جزء من تشغيلة بتكلفة 4 خانات =====
    const wasteBatch = async (itemName, storeId, batchNo) => (await ctx.db.query('SELECT Id FROM StockBatches WHERE ItemId = ? AND StoreId = ? AND BatchNo = ?', [I(itemName).id, storeId, batchNo]))[0].Id;
    const wAm = await wasteBatch('أموكسيسيلين/كلافيولانيك 1 جم أقراص', MAIN_D, 'AM-1');
    const w1 = await sacc.post('/api/stores/waste', { batchId: wAm, qty: 5, reason: 'تالف في النقل' });
    note('إعدام 5 قرص تكلفة 7.1429', { status: w1.status, err: errOf(w1) });
    const wKt = await wasteBatch('كيتورولاك 30 مجم', PHARM, 'KT-P');
    const w2 = await sacc.post('/api/stores/waste', { batchId: wKt, qty: 3.25, reason: 'مكسور' });
    note('إعدام 3.25 كيتورولاك تكلفة 2.6633', { status: w2.status, err: errOf(w2) });
    const w3 = await sacc.post('/api/stores/waste', { batchId: wKt, qty: 9999, reason: 'أكبر من الرصيد' });
    note('إعدام أكبر من الرصيد (مرفوض)', { status: w3.status, err: errOf(w3) });

    // ===== 4) جرد: عجز وزيادة وصنف مش مسجل، واعتماد المدير =====
    const C = must(await sacc.post('/api/stores/counts', { storeId: PHARM, note: 'جرد أساسي' }), 201, 'count');
    const cid = C.count?.id ?? C.id;
    const cl = (await sacc.get(`/api/stores/counts/${cid}`)).body;
    const clines = cl.lines || [];
    const counted = clines.map((l, k) => ({ id: l.id, counted: k === 0 ? Number(l.systemQty) - 2.5 : k === 1 ? Number(l.systemQty) + 4 : Number(l.systemQty) }));
    const sv = await sacc.post(`/api/stores/counts/${cid}/save`, { lines: counted, add: [{ itemId: I('ديكلوفيناك 75 مجم').id, counted: 6, batchNo: 'DC-9', expiry: '2028-02-29' }] });
    note('حفظ عد الجرد', { status: sv.status, err: errOf(sv), lines: clines.length });
    note('تسليم الجرد', { status: (await sacc.post(`/api/stores/counts/${cid}/submit`)).status });
    const ap = await mgr.post(`/api/stores/counts/${cid}/approve`);
    note('اعتماد الجرد', { status: ap.status, err: errOf(ap) });

    // ===== 5) فاتورة مورد مرتبطة باستلام + دفعات (نقدي = إذن صرف، شيك) =====
    const sup = (await fin.get('/api/finance/suppliers')).body.suppliers || [];
    note('موردين', { n: sup.length });
    const unb = (await fin.get('/api/finance/purchases/unbilled')).body.purchases;
    const inv = await fin.post('/api/finance/invoices', { supplierName: 'مورد مخزن أساسي', purchaseId: unb[0]?.id, docNo: 'INV-B-1', docDate: day, dueDate: day, amount: unb[0] ? unb[0].total : 1 });
    note('فاتورة مورد مرتبطة باستلام', { status: inv.status, err: errOf(inv), billed: unb[0] ? f4(unb[0].total) : null });
    const invId = inv.body?.id;
    const pay1 = await fin.post('/api/finance/payments', { invoiceId: invId, method: 'cash', amount: 100.1, payDate: day });
    note('دفعة نقدي على الفاتورة (إذن صرف)', { status: pay1.status, err: errOf(pay1) });
    const pay2 = await fin.post('/api/finance/payments', { invoiceId: invId, method: 'cheque', amount: 50.05, chequeNo: 'CH-B-1', chequeDate: day, bank: 'بنك' });
    note('دفعة شيك', { status: pay2.status, err: errOf(pay2) });
    const pay3 = await fin.post('/api/finance/payments', { invoiceId: invId, method: 'cash', amount: 99999999, payDate: day });
    note('دفعة أكبر من المتبقي (مرفوض)', { status: pay3.status, err: errOf(pay3) });

    // ===== 6) التزامات وأقساط: القسمة بالقروش والباقي في آخر قسط =====
    const ob = await fin.post('/api/finance/obligations', { name: 'التزام أساسي 1000.01 على 3', party: 'جهة تقسيط', total: 1000.01, count: 3, firstDue: day });
    note('التزام 1000.01 على 3 أقساط', { status: ob.status, err: errOf(ob) });
    const ob2 = await fin.post('/api/finance/obligations', { name: 'التزام أساسي يدوي', party: 'جهة أخرى', installments: [{ dueDate: day, amount: 333.33 }, { dueDate: day, amount: 0.07 }, { dueDate: day, amount: 1234.5 }] });
    note('التزام بأقساط يدوية', { status: ob2.status, err: errOf(ob2) });
    const inst = (await ctx.db.query('SELECT Id, ObligationId, No FROM ObligationInstallments ORDER BY Id')).map((x) => x.Id);
    const up = await fin.put(`/api/finance/installments/${inst[1]}`, { dueDate: day, amount: 333.34 });
    note('تعديل قسط قبل الدفع', { status: up.status, err: errOf(up) });
    const ip1 = await fin.post(`/api/finance/installments/${inst[0]}/pay`, { method: 'cash' });
    note('دفع قسط نقدي (إذن صرف)', { status: ip1.status, err: errOf(ip1) });
    const ip2 = await fin.post(`/api/finance/installments/${inst[1]}/pay`, { method: 'cheque', chequeNo: 'CH-B-2' });
    note('دفع قسط بشيك', { status: ip2.status, err: errOf(ip2) });
    const ip3 = await fin.post(`/api/finance/installments/${inst[3]}/pay`, { method: 'cash' });
    note('دفع قسط يدوي نقدي', { status: ip3.status, err: errOf(ip3) });
    const ip4 = await fin.post(`/api/finance/installments/${inst[0]}/pay`, { method: 'cash' });
    note('دفع نفس القسط تاني (مرفوض)', { status: ip4.status, err: errOf(ip4) });
    const del = await fin.del(`/api/finance/obligations/${ob.body.id}`);
    note('حذف التزام فيه أقساط مدفوعة (مرفوض)', { status: del.status, err: errOf(del) });

    // ===== 7) سداد الإذونات من الخزينة =====
    const vl = (await cas.get('/api/finance/vouchers?status=pending')).body;
    note('إذونات معلّقة قبل الصرف', { n: (vl.vouchers || []).length, total: f4(vl.total) });
    // الخزينة محتاجة وردية مفتوحة. بنجرّب الصرف مباشرة (لو مطلوب وردية السيناريو بيسجّل الرفض زي ما هو)
    let paidV = 0;
    const toPay = (vl.vouchers || []).slice(0, -1); // آخر إذن نسيبه علشان نلغيه
    for (const v of toPay) {
      const r = await cas.post(`/api/finance/vouchers/${v.id}/pay`);
      note('صرف إذن ' + v.kind, { status: r.status, err: errOf(r), amount: f4(v.amount) });
      if (r.status === 200) paidV++;
    }
    const vl2 = (await cas.get('/api/finance/vouchers?status=pending')).body;
    // إلغاء إذن معلّق (لو فاضل) — بيرجّع الأصل (دفعة/قسط) لحالته
    for (const v of (vl2.vouchers || []).slice(0, 1)) {
      const r = await cas.post(`/api/finance/vouchers/${v.id}/cancel`, { reason: 'إلغاء إذن للاختبار' });
      note('إلغاء إذن ' + v.kind, { status: r.status, err: errOf(r), amount: f4(v.amount) });
    }
    const left = (await cas.get('/api/finance/vouchers/count')).body;
    note('إذونات معلّقة بعد الصرف', { count: left.count, amount: f4(left.amount), paid: paidV });

    // ===== تقارير مرجعية =====
    const reports = { valuation: await valuation(ctx.db) };
    const vr = await mgr.get('/api/stock-reports/value');
    reports.valueReport = { status: vr.status, body: normDeep(vr.body) };
    // تقرير الخزينة بعد صرف الإذونات (نفس التطبيع بدون أوقات)
    const tre = (await mgr.get('/api/reports/treasury')).body;
    reports.treasuryTotals = Object.fromEntries(Object.entries(tre.totals || {}).map(([k, v]) => [k, typeof v === 'number' ? f4(v) : v]));
    reports.treasurySections = (tre.sections || []).map((s) => ({ key: s.key, totals: Object.fromEntries(Object.entries(s.totals || {}).map(([k, v]) => [k, typeof v === 'number' ? f4(v) : v])), rows: s.rows.length }));

    // عيب معروف: ربط الأرقام في SQL Server
    known.push({
      name: 'ربط الأرقام الكسرية في مشغّل SQL Server',
      where: 'src/db/mssql.js سطر 14: أي رقم غير صحيح بيتربط Decimal(12,2)',
      effect: 'تكلفة الأصناف (DECIMAL(12,4)) ممكن تتقرّب لخانتين على SQL Server فقط. SQLite بيحتفظ بـ4 خانات، فالخط ده مش بيكشف الفرق',
      sqliteCostScale: 4, example: { perBase: '100/14', stored4: f4(100 / 14) },
    });
    if (cairoDay() !== day0) throw new Error('اليوم اتغيّر أثناء التشغيل. أعد التشغيل.');
    void batches0; void over;
    return { steps: JSON.parse(JSON.stringify(steps)), db: await snapshot(ctx.db), reports, known };
  } finally { await close(); }
}
