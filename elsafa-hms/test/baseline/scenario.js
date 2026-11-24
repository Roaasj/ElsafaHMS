// الخط الأساسي المحاسبي (Baseline) — سيناريو ثابت بمدخلات ثابتة، بيشتغل على قاعدة SQLite في الذاكرة.
// مهم: الملف ده مستقل عن كود المبالغ اللي بنختبره (مفيش import لـ util.js/cents/pounds) علشان القياس ما يتأثرش بالتغيير.
// بيرجّع نتايج قابلة للمقارنة: عدد السجلات والمجاميع لكل جدول مالي، وكل صف مالي، وتقارير الخزينة والتعاقدات،
// وجدول توثيق سلوك التقريب الحالي.
import { start } from '../../src/server.js';
import { seedDemo } from '../../scripts/seed-demo.js';
import { amountInWords } from '../../shared/tafqeet.js';

const PW = 'Safa@2026';

// ---- أدوات قياس مستقلة (مش من كود المنتج) ----
/** القيمة بوحدة 1e-4 كعدد صحيح (بتغطي 0 و2 و3 و4 خانات من غير فاصلة عائمة في المجاميع) */
export const u4 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1e4));
/** تمثيل نصي ثابت للقيمة بأربع خانات */
export const f4 = (v) => (v === null || v === undefined ? null : (Math.round(Number(v) * 1e4) / 1e4).toFixed(4));

export async function boot() {
  const ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db, { clinics: false }); // العيادات (R1b) مش جزء من الحساب؛ الأرقام المرجعية متغيّرتش
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  const login = async (u) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) })).headers.get('set-cookie').split(';')[0];
  const client = (cookie) => {
    const call = async (m, url, b) => {
      const r = await fetch(base + url, { method: m, headers: { 'content-type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
  };
  const U = {};
  for (const [k, name] of Object.entries({ rec: 'reception', mgr: 'manager', cas: 'cashier', sup: 'super', rev: 'review', cl: 'claims', fin: 'fin', sacc: 'storeacc', acc: 'acc', ph: 'pharm' })) U[k] = client(await login(name));
  return { ctx, U, close: async () => { ctx.server.close(); await ctx.db.close(); } };
}

const r2 = (x) => Math.round(x * 100) / 100;
/** تحقق مسبق من قيدي الإيصال في SQLite بالتساوي التام في الفاصلة العائمة:
 *  CK_Receipts_Balance: كاش+فيزا+آجل = الصافي  و  الإجمالي-الخصم = الصافي.
 *  ده عيب معروف في SQLite بس (بيرجّع 500 لو الجمع العشري مش مطابق بالظبط)، وSQL Server بيستخدم DECIMAL دقيق فمفيهوش المشكلة.
 *  السيناريو بيختار قيم مرشّحة بالترتيب لحد ما تعدّي القيدين، فالمدخلات ثابتة ومكرّرة بالظبط في كل تشغيل. */
const ok2 = ({ gross, discount = 0, cash = 0, card = 0, credit = 0 }) => {
  const net = r2(gross - discount);
  return gross - discount === net && cash + card + credit === net;
};
/** يرجّع { discount, card, credit, cash } بأول تركيبة مرشّحة تعدّي القيدين */
function plan(gross, { discounts = [0], cards = [0], credits = [0] } = {}) {
  for (const discount of discounts) for (const card of cards) for (const credit of credits) {
    const net = r2(gross - discount); const cash = r2(net - card - credit);
    if (cash >= 0 && ok2({ gross, discount, cash, card, credit })) return { discount, card, credit, cash };
  }
  throw new Error('مفيش تركيبة دقيقة لـ ' + gross);
}
const errOf = (r) => (r.status >= 400 ? String(r.body?.error || '').slice(0, 140) : undefined);
const range = (from, step, n) => Array.from({ length: n }, (_, i) => r2(from + i * step));
const must = (r, st, what) => { if (r.status !== st) throw new Error(`${what}: توقعنا ${st} وجه ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

/** تشغيل السيناريو كله. rows = كل خطوة وناتجها المالي بعد التقريب */
const cairoDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
export async function runScenario() {
  const day0 = cairoDay();
  const { ctx, U, close } = await boot();
  const steps = []; // سجل خطوات: اسم + قيم رئيسية
  const known = []; // عيوب معروفة متثبّتة (مش بتتصلح في المرحلة دي)
  const note = (name, data) => steps.push({ name, ...data });
  try {
    const { rec, mgr, cas, sup, cl, fin, rev, sacc, acc, ph } = U;
    must(await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }), 200, 'ticket-settings');
    must(await mgr.put('/api/admin/settings', { checkoutTime: '23:59' }), 200, 'settings');
    const svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
    // الدكاترة بالـid الثابت (مش بترتيب الـAPI): الترتيب بيتغيّر مع الوقت (presentNow حسب مواعيد الدكتور) فكان السيناريو بيفشل حسب ساعة التشغيل
    const allDocs = (await rec.get('/api/catalog/doctors')).body.doctors;
    const docs = [3, 5, 6].map((id) => allDocs.find((d) => d.id === id));
    const mgrId = (await mgr.get('/api/me')).body.user.id;
    let pn = 0;
    const patient = async (extra = {}) => { pn++; return must(await rec.post('/api/patients', { name: `مريض أساسي رقم ${pn} علي`, phone: `0108800${String(pn).padStart(4, '0')}`, ageYears: 40, sex: 'M', confirmDuplicatePhone: true, ...extra }), 201, 'patient').patient; };
    const fullP = (extra = {}) => patient({ nationalId: `2900101${String(1100000 + pn + 1).padStart(7, '0')}`, emergencyName: 'قريب', emergencyPhone: '01011112222', address: 'عنوان', ...extra });
    const freeBed = async (kind = 'ward') => {
      const b = (await rec.get('/api/admissions/beds/board')).body;
      for (const f of b.floors) for (const r of f.rooms) for (const x of r.beds) if (x.status === 'free' && r.cls.kind === kind && r.cls.nightPrice) return { bed: x, cls: r.cls };
      throw new Error('مفيش سرير فاضي ' + kind);
    };

    // ---------- خدمات بأسعار كسرية للتقريب ----------
    const mk = async (name, dept, price, extra = {}) => must(await mgr.post('/api/admin/services', { name, dept, payTiming: 'before', price, hasDoctor: dept === 'clinic', ...extra }), 201, 'service ' + name).service;
    const sA = await mk('بند أساسي 33.33', 'clinic', 33.33);
    const sB = await mk('بند أساسي 99.99', 'clinic', 99.99);
    const sC = await mk('بند أساسي 12.35', 'lab', 12.35);
    const sD = await mk('بند أساسي 0.05', 'lab', 0.05);
    const sR = await mk('بند أساسي أشعة 250.55', 'radiology', 250.55);

    // ---------- جهات تعاقد: خصم بنسب كسرية، وتغطية كسرية، وحد أقصى ----------
    // عيب v0.16 (اتوثّق هنا): إنشاء جهة بتغطية من الـAPI بيحفظ الجهة والمستوى بس، والتغطية بتتسقط (DEPT_KEYS في payers.js فاضية وقت التحميل).
    // علشان نغطّي حسابات التعاقد فعليًا بنكتب التغطية مباشرة في القاعدة زي ما بيعمل seed-demo.
    const payer = async (name, o) => {
      const P = must(await mgr.post('/api/payers', { name, tiers: [{ name: 'أ', coverage: o.cov }], ...o.p }), 201, 'payer ' + name).payer;
      known.push({ name: 'تغطية جهة «' + name + '» من الـAPI', saved: Object.keys(P.tiers[0].coverage).length, sent: Object.keys(o.cov).length });
      // بنكمّل بس اللي الـAPI ما حفظوش: بكده السيناريو بيدّي نفس نتيجة المحاسبة قبل إصلاح payers.js وبعده (قبله: الـAPI بيسقط التغطية كلها)
      for (const [d, pct] of Object.entries(o.cov)) if (P.tiers[0].coverage[d] === undefined) await ctx.db.insert('TierCoverage', { TierId: P.tiers[0].id, Dept: d, Pct: pct });
      return P;
    };
    const P1 = await payer('جهة أساسية خصم 12.5', { p: { priceMode: 'discount', discountPct: 12.5, visitCap: 100000 }, cov: { clinic: 33.33, lab: 66.67, radiology: 50, ward: 80, or: 80 } });
    const P2 = await payer('جهة أساسية قائمة 80', { p: { priceMode: 'list', visitCap: 150 }, cov: { clinic: 80, lab: 80, radiology: 80, ward: 80, or: 80 } });
    const P3 = await payer('جهة أساسية خصم 7.5', { p: { priceMode: 'discount', discountPct: 7.5 }, cov: { clinic: 100, lab: 100, radiology: 100, ward: 100, or: 100 } });

    await ctx.db.insert('PayerRules', { PayerId: P1.id, ServiceId: sR.id, '[Rule]': 'approval' }); // الأشعة بتحتاج موافقة (زي seed-demo)

    // ===== 1) زيارات نقدية: إيصال كاش وفيزا ومختلط، وكسور =====
    {
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic' }), 201, 'visit').visit;
      const d = must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sA.id, doctorId: docs[0].id, qty: 3 }), 201, 'item');
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sB.id, doctorId: docs[1].id }), 201, 'item2');
      const due = (await rec.get(`/api/visits/${v.id}`)).body.totals.due;
      const sp = plan(due, { cards: range(50, 0.01, 400) });
      const r = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: (await rec.get(`/api/visits/${v.id}`)).body.items.map((i) => i.id), cash: sp.cash, card: sp.card }), 201, 'pay mixed');
      note('نقدي مختلط (كاش+فيزا) بنود كسرية', { visit: v.id, due: f4(due), card: f4(sp.card), receipt: r.receiptId });
      void d;
    }
    // ===== 2) خصم بموافقة مدير + آجل =====
    {
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'lab' }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sC.id, qty: 7 }), 201, 'it');
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sD.id, qty: 3 }), 201, 'it');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      const ids = det.items.map((i) => i.id);
      const bad = await rec.post(`/api/visits/${v.id}/pay`, { itemIds: ids, discount: 5 });
      note('خصم من غير موافقة بيترفض', { status: bad.status });
      const due = det.totals.due;
      // عيب SQLite المعروف: خصم كسري بيفشل قيد التوازن (500) بسبب الفاصلة العائمة. بنثبّت السلوك ده كـ known علشان أي تغيير فيه يبان.
      const probe = await rec.post(`/api/visits/${v.id}/pay`, { itemIds: ids, discount: 1.17, discountReason: 'خصم كسري', discountApprovedBy: mgrId, cash: r2(due - 1.17) });
      known.push({ name: 'خصم كسري 1.17 على إجمالي ' + f4(due), status: probe.status });
      const sp = plan(due, { discounts: range(2, 0.5, 10), credits: [10, 11, 12, 13] });
      const r = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: ids, discount: sp.discount, discountReason: 'خصم أساسي', discountApprovedBy: mgrId, credit: sp.credit, creditApprovedBy: mgrId, cash: sp.cash }), 201, 'pay disc+credit');
      note('خصم وآجل وباقي كاش', { due: f4(due), discount: f4(sp.discount), credit: f4(sp.credit), receipt: r.receiptId });
    }
    // ===== 3) مرتجع جزئي + مرتجع كلي + إلغاء إيصال (عمليات سالبة) =====
    {
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic' }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sB.id, doctorId: docs[0].id, qty: 3 }), 201, 'item');
      const ids = (await rec.get(`/api/visits/${v.id}`)).body.items.map((i) => i.id);
      const g3 = (await rec.get(`/api/visits/${v.id}`)).body.totals.due;
      const sp3 = plan(g3, { discounts: range(10, 1, 30) });
      const pay = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: ids, discount: sp3.discount, discountReason: 'خصم لمرتجع', discountApprovedBy: mgrId, cash: sp3.cash }), 201, 'pay');
      void sup;
      // إيصال تاني يتلغى
      const v2 = must(await rec.post('/api/visits', { patientId: p.id, type: 'lab' }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v2.id}/items`, { serviceId: sC.id, qty: 5 }), 201, 'item');
      const ids2 = (await rec.get(`/api/visits/${v2.id}`)).body.items.map((i) => i.id);
      const pay2 = must(await rec.post(`/api/visits/${v2.id}/pay`, { itemIds: ids2, cash: (await rec.get(`/api/visits/${v2.id}`)).body.totals.due }), 201, 'pay2');
      const c = await mgr.post(`/api/receipts/${pay2.receiptId}/cancel`, { reason: 'إلغاء إيصال أساسي' });
      note('إلغاء إيصال', { status: c.status, pay: pay.receiptId, canceled: pay2.receiptId });
    }
    // ===== 3ب) مخزون: بيع دواء/مستلزم في زيارة + مرتجع جزئي وكلي (الناتج سالب ومقرّب) =====
    {
      const items = (await acc.get('/api/tickets/items')).body.items;
      const stores = (await mgr.get('/api/stores/meta')).body.stores;
      const I = (n) => items.find((x) => x.name === n); const S = (n) => stores.find((x) => x.name === n);
      for (const n of ['مخزن الطوارئ', 'الصيدلية']) {
        must(await sacc.post('/api/stores/purchases', { kind: 'opening', storeId: S(n).id, lines: [
          { itemId: I('سيفترياكسون 1 جم').id, qty: 20, batchNo: 'B1', expiry: '2028-01-31', cost: 60 }, { itemId: I('كانيولا 20G').id, qty: 30 },
          { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 3, cost: 100, batchNo: 'AM1', expiry: '2027-06-30' }] }), 201, 'opening ' + n);
      }
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'emergency' }), 201, 'er visit').visit;
      const add = must(await rec.post(`/api/visits/${v.id}/items`, { stockItemId: I('كانيولا 20G').id, qty: 3 }), 201, 'stock item');
      must(await rec.post(`/api/visits/${v.id}/items`, { stockItemId: I('سيفترياكسون 1 جم').id, qty: 2 }), 201, 'stock item2');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      const sp = plan(det.totals.due, { discounts: range(4, 1, 30) });
      const pay = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: det.items.map((i) => i.id), discount: sp.discount, discountReason: 'خصم مخزون', discountApprovedBy: mgrId, cash: sp.cash }), 201, 'stock pay');
      const r1 = await sup.post(`/api/visits/${v.id}/items/${add.itemId}/return`, { reason: 'مرتجع جزئي أساسي', qty: 1 });
      note('مرتجع مستلزم 1 من 3 بعد خصم', { status: r1.status, err: errOf(r1), due: f4(det.totals.due), discount: f4(sp.discount), receipt: pay.receiptId });
      const r2 = await sup.post(`/api/visits/${v.id}/items/${add.itemId}/return`, { reason: 'مرتجع تاني أساسي', qty: 2 });
      note('مرتجع الباقي (2 من 3)', { status: r2.status, err: errOf(r2) });
      // صيدلية: بيع بعبوة
      const pv = must(await ph.post('/api/visits', { patientId: p.id, type: 'pharmacy' }), 201, 'pharm visit').visit;
      const q = await ph.post(`/api/visits/${pv.id}/items`, { stockItemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 2 });
      note('بيع صيدلية بالعبوة', { status: q.status, err: errOf(q) });
      if (q.status === 201) {
        const d2 = (await ph.get(`/api/visits/${pv.id}`)).body;
        must(await ph.post(`/api/visits/${pv.id}/pay`, { itemIds: d2.items.map((i) => i.id), cash: d2.totals.due }), 201, 'pharm pay');
      }
    }
    // ===== 4) تعاقدات: خصم 12.5% بسعر وحدة مقرّب، تغطية كسرية، حد أقصى للزيارة =====
    for (const [P, svcs, doc] of [[P1, [[sA, 3], [sB, 1]], docs[0]], [P3, [[sA, 3]], docs[1]]]) {
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic', payer: { payerId: P.id, tierId: P.tiers[0].id, cardNo: 'C' + P.id } }), 201, 'visit').visit;
      for (const [s, q] of svcs) must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: s.id, doctorId: doc.id, qty: q }), 201, 'payer item');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      const ids = det.items.map((i) => i.id);
      const r = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: ids, cash: det.totals.due }), 201, 'payer pay');
      note('زيارة تعاقد ' + P.name, { due: f4(det.totals.due), receipt: r.receiptId });
    }
    {
      // إلغاء إيصال تعاقد: لازم يتعكس نصيب الشركة (دفتر الجهة) ونسبة الدكتور
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic', payer: { payerId: P1.id, tierId: P1.tiers[0].id, cardNo: 'C1X' } }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sB.id, doctorId: docs[0].id, qty: 2 }), 201, 'item');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      const pay = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: det.items.map((i) => i.id), cash: det.totals.due }), 201, 'pay');
      const c = await mgr.post(`/api/receipts/${pay.receiptId}/cancel`, { reason: 'إلغاء إيصال تعاقد أساسي' });
      note('إلغاء إيصال تعاقد (عكس نصيب الجهة)', { status: c.status, err: errOf(c), due: f4(det.totals.due) });
    }
    {
      // قائمة بحد أقصى للزيارة (150): الزيادة بتروح على المريض
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic', payer: { payerId: P2.id, tierId: P2.tiers[0].id, cardNo: 'C2' } }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sB.id, doctorId: docs[0].id, qty: 3 }), 201, 'capped');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: det.items.map((i) => i.id), cash: det.totals.due }), 201, 'capped pay');
      note('تعاقد بحد أقصى للزيارة', { due: f4(det.totals.due) });
    }
    {
      // أشعة بتغطية 50%: نقدي مؤقت ← موافقة ← استرداد نصيب الشركة (مرتجع سالب)
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'radiology', payer: { payerId: P1.id, tierId: P1.tiers[0].id, cardNo: 'C1R' } }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sR.id, doctorId: docs[2].id, approval: { mode: 'tempcash' } }), 201, 'rad item');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: det.items.map((i) => i.id), cash: det.totals.due }), 201, 'rad pay');
      const ap = (await rev.get('/api/approvals?status=tempcash')).body.approvals.at(-1);
      const apv = await rev.post(`/api/approvals/${ap.id}/approve`, { no: 'BASE-1' });
      const vd = (await rec.get(`/api/visits/${v.id}`)).body;
      const ref = await rec.post(`/api/visits/${v.id}/refund-due`);
      note('نقدي مؤقت ← موافقة ← استرداد', { approve: apv.status, refundDue: f4(vd.totals.refundDue), status: ref.status, err: errOf(ref), net: ref.status === 201 ? f4(ref.body.receipts.at(-1).net) : null });
    }
    // ===== 5) خزينة: وردية مفتوحة + إذن دفع + تحصيل بفيزا وكاش + مرتجع إذن + إغلاق بعجز =====
    {
      must(await cas.post('/api/shifts/open'), 201, 'open shift');
      const p = await patient();
      const v = must(await rec.post('/api/visits', { patientId: p.id, type: 'clinic' }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sA.id, doctorId: docs[0].id, qty: 2 }), 201, 'it');
      must(await rec.post(`/api/visits/${v.id}/items`, { serviceId: sC.id, qty: 3 }), 201, 'it');
      const det = (await rec.get(`/api/visits/${v.id}`)).body;
      const sp5 = plan(det.totals.due, { discounts: range(3, 1, 30), cards: range(20, 0.01, 400) });
      const o = must(await rec.post(`/api/visits/${v.id}/pay`, { itemIds: det.items.map((i) => i.id), discount: sp5.discount, discountReason: 'خصم خزينة', discountApprovedBy: mgrId }), 201, 'order').order;
      must(await cas.post(`/api/orders/${o.id}/collect`, { cash: sp5.cash, card: sp5.card, manualNo: 'B-1' }), 201, 'collect');
      note('إذن دفع واتحصّل (كاش+فيزا بخصم)', { discount: f4(sp5.discount), card: f4(sp5.card) });
      // إذن ويتلغى
      const v2 = must(await rec.post('/api/visits', { patientId: p.id, type: 'lab' }), 201, 'visit').visit;
      must(await rec.post(`/api/visits/${v2.id}/items`, { serviceId: sC.id }), 201, 'it');
      const o2 = must(await rec.post(`/api/visits/${v2.id}/pay`, { itemIds: (await rec.get(`/api/visits/${v2.id}`)).body.items.map((i) => i.id) }), 201, 'order2').order;
      note('إلغاء إذن', { status: (await rec.post(`/api/orders/${o2.id}/cancel`, { reason: 'مشي' })).status });
      // إغلاق الوردية بالعد
      const mine = (await cas.get('/api/shifts/mine')).body;
      const exp = (mine.shift || mine).expected ?? null;
      const cl2 = await cas.post('/api/shifts/mine/close', { counted: exp == null ? 0 : Math.round((Number(exp) - 5) * 100) / 100, diffReason: 'عجز أساسي', handedTo: (await sup.get('/api/me')).body.user.id });
      note('إغلاق وردية بعجز', { status: cl2.status, expected: f4(exp), err: errOf(cl2) });
    }

    // ===== 6) حسابات المرضى (إقامة): تأمين، بنود، دفعة، تحويل، خصم وآجل عند الخروج =====
    {
      const p = await fullP();
      const { bed, cls } = await freeBed('ward');
      const adm = must(await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit }), 201, 'admit').admission;
      must(await rec.post(`/api/admissions/${adm.id}/items`, { serviceId: svc['IP-001'].id, doctorId: docs[0].id, qty: 2 }), 201, 'adm item');
      must(await rec.post(`/api/admissions/${adm.id}/items`, { serviceId: sC.id, qty: 100 }), 201, 'adm lab');
      must(await rec.post(`/api/admissions/${adm.id}/items`, { serviceId: sR.id, qty: 10, doctorId: docs[2].id }), 201, 'adm rad');
      must(await rec.post(`/api/admissions/${adm.id}/pay`, { cash: 333 }), 201, 'adm pay');
      const prev = (await rec.get(`/api/admissions/${adm.id}/discharge-preview`)).body;
      note('معاينة الخروج', { totals: Object.fromEntries(Object.entries(prev.totals).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, f4(v)])) });
      const R = prev.totals.balance;
      const sp6 = plan(R, { discounts: range(100, 1, 40), credits: range(50, 1, 40) });
      const out = await rec.post(`/api/admissions/${adm.id}/discharge`, { discount: sp6.discount, discountReason: 'خروج أساسي', discountApprovedBy: mgrId, credit: sp6.credit, creditApprovedBy: mgrId, cash: sp6.cash, note: 'خروج' });
      note('خروج بخصم وآجل', { status: out.status, remaining: f4(R), discount: f4(sp6.discount), credit: f4(sp6.credit) });
    }
    {
      // خروج برصيد للمريض (التأمين أكبر من الحساب): مرتجع مستحق
      const p = await fullP();
      const { bed, cls } = await freeBed('ward');
      const adm = must(await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit }), 201, 'admit refund').admission;
      must(await rec.post(`/api/admissions/${adm.id}/items`, { serviceId: sC.id, qty: 3 }), 201, 'adm lab');
      const prev = (await rec.get(`/api/admissions/${adm.id}/discharge-preview`)).body;
      const out = await rec.post(`/api/admissions/${adm.id}/discharge`, {});
      note('خروج برصيد للمريض (مرتجع تأمين)', { status: out.status, balance: f4(prev.totals.balance) });
    }
    {
      // دخول تعاقد (80% إقامة) ثم خروج
      const p = await fullP();
      const { bed } = await freeBed('ward');
      const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: 3000, payer: { payerId: P3.id, tierId: P3.tiers[0].id, cardNo: 'AD3' } });
      if (a.status === 201) {
        const id = a.body.admission.id;
        must(await rec.post(`/api/admissions/${id}/items`, { serviceId: svc['IP-001'].id, doctorId: docs[0].id, qty: 3 }), 201, 'adm item payer');
        const out = await rec.post(`/api/admissions/${id}/discharge`, {});
        note('دخول تعاقد وخروج', { status: out.status });
      } else note('دخول تعاقد (اترفض)', { status: a.status, err: JSON.stringify(a.body).slice(0, 120) });
    }

    // ===== 7) مطالبات الجهات (فواتير) =====
    {
      const period = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).slice(0, 7);
      for (const P of [P1, P3, P2]) {
        const list = (await cl.get(`/api/claims/cases?payerId=${P.id}&period=${period}`)).body;
        for (const c of list.cases || []) await cl.post(`/api/claims/cases/${c.id}/status`, { status: 'ok' });
        const c = await cl.post('/api/claims', { payerId: P.id, period });
        note('مطالبة ' + P.name, { status: c.status, err: errOf(c), total: c.status === 201 ? f4(c.body.totals.total) : null, words: c.status === 201 ? c.body.totals.words : null });
        if (c.status === 201) {
          const id = c.body.claim.id;
          await cl.post(`/api/claims/${id}/send`);
          const tot = Number(c.body.totals.total);
          if (tot > 10) {
            const pm = await cl.post(`/api/claims/${id}/payments`, { amount: Math.round((tot / 3) * 100) / 100, chequeNo: 'CHQ-' + id });
            note('سداد جزئي مطالبة', { status: pm.status, err: errOf(pm) });
          }
        }
      }
    }

    // ===== 8) ضريبة مستحقات الأطباء (doctorTaxPct) =====
    {
      const monthOf = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).slice(0, 7);
      const pre = await fin.get(`/api/finance/payouts/prepare?period=${monthOf}`);
      note('تجهيز مستحقات', { status: pre.status, taxPct: pre.body.taxPct ?? null, rows: (pre.body.rows || []).filter((r) => r.gross > 0).map((r) => ({ id: r.id, gross: f4(r.gross), tax: f4(r.tax), net: f4(r.net) })) });
      const ids = (pre.body.rows || []).filter((r) => r.gross > 0).map((r) => r.id);
      if (ids.length) {
        const c = await fin.post('/api/finance/payouts', { period: monthOf, doctorIds: ids });
        note('صرف مستحقات', { status: c.status });
      }
    }

    // ===== 9) موردين ومصروفات بمبالغ كسرية =====
    {
      const sp = must(await fin.post('/api/finance/suppliers', { name: 'مورد أساسي', phone: '0100' }), 201, 'supplier').id;
      const day = cairoDay();
      const inv = await fin.post('/api/finance/invoices', { supplierId: sp, docNo: 'F-BASE-1', docDate: day, dueDate: day, amount: 1234.56 });
      note('فاتورة مورد 1234.56', { status: inv.status, err: errOf(inv) });
      const cats = (await fin.get('/api/finance/expense-categories')).body.categories || [];
      if (cats.length) {
        const e = await fin.post('/api/finance/expenses', { categoryId: cats[0].id, amount: 750.25, method: 'cash', payee: 'مصروف أساسي', date: day });
        note('مصروف 750.25', { status: e.status, err: errOf(e) });
      }
    }

    // ---------- تقارير مرجعية ----------
    const reports = {};
    const treasury = (await mgr.get('/api/reports/treasury')).body;
    reports.treasury = normTreasury(treasury);
    reports.payers = await payerStatements(mgr, [P1, P2, P3]);

    if (cairoDay() !== day0) throw new Error('اليوم اتغيّر أثناء التشغيل (عبور منتصف الليل). أعد التشغيل.');
    return {
      steps: steps.map(clean),
      db: await dbSnapshot(ctx.db),
      byType: await typeSummary(ctx.db),
      reports,
      known,
      rounding: roundingTable(),
      words: wordsTable(),
    };
  } finally {
    await close();
  }
}

const clean = (s) => JSON.parse(JSON.stringify(s));

/** تقرير الخزينة بدون أي حاجة بتعتمد على الوقت */
function normTreasury(t) {
  return {
    totals: normNums(t.totals),
    sections: (t.sections || []).map((s) => ({
      key: s.key, name: s.name, totals: normNums(s.totals),
      rows: s.rows.map((r) => ({ no: r.no, kind: r.kind, manualNo: r.manualNo ?? null, gross: f4(r.gross), discount: f4(r.discount), net: f4(r.net), cash: f4(r.cash), card: f4(r.card), credit: f4(r.credit) })),
    })),
  };
}
function normNums(o) { return o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? f4(v) : v])) : null; }

async function payerStatements(mgr, payers) {
  const out = {};
  for (const P of payers) {
    const r = await mgr.get(`/api/payers/${P.id}/statement`);
    out[P.name] = r.status === 200 ? JSON.parse(JSON.stringify(r.body, (k, v) => (typeof v === 'number' ? f4(v) : /At$|Date$|date$|^at$/.test(k) ? undefined : v))) : { status: r.status };
  }
  return out;
}

// ---------- لقطة قاعدة البيانات: عدد السجلات + مجاميع كل عمود رقمي + كل صف في الجداول المعاملاتية ----------
// أعمدة نصيب الدكتور الجديدة (020): مش بتدخل اللقطة لأنها صفر/فاضية في السيناريو (اختبار doctor-share.test.js بيثبت ده)، فالـgolden يفضل بدون تعديل
export const NEW_COLS = new Set(['SharePct', 'ShareFixed', 'DoctorFixed']);
const TX_TABLES = ['Receipts', 'ReceiptLines', 'VisitItems', 'AdmissionItems', 'Admissions', 'DoctorEarnings', 'PayerLedger', 'PayOrders', 'Approvals', 'Claims', 'ClaimLines', 'ClaimPayments', 'DoctorPayouts', 'CashVouchers'];
async function dbSnapshot(db) {
  const tables = (await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((x) => x.name);
  const snap = {};
  for (const t of tables) {
    for (const c of (await db.query(`PRAGMA table_info(${t})`)).filter((c) => NEW_COLS.has(c.name))) {
      const nz = await db.one(`SELECT COUNT(*) AS N FROM ${t} WHERE ${c.name} IS NOT NULL AND ${c.name} <> 0`);
      if (Number(nz.N)) throw new Error(`العمود الجديد ${t}.${c.name} لازم يكون صفر/فاضي في الـbaseline`);
    }
    const cols = (await db.query(`PRAGMA table_info(${t})`)).filter((c) => /NUMERIC|DECIMAL|REAL/i.test(c.type) && !NEW_COLS.has(c.name));
    if (!cols.length) continue;
    const rows = await db.query(`SELECT * FROM ${t} ORDER BY Id`);
    const sums = {};
    for (const c of cols) sums[c.name] = rows.reduce((a, r) => a + (u4(r[c.name]) || 0), 0); // وحدة 1e-4 (عدد صحيح)
    snap[t] = { count: rows.length, sums };
    if (TX_TABLES.includes(t)) snap[t].rows = rows.map((r) => Object.fromEntries([['Id', r.Id], ...cols.map((c) => [c.name, f4(r[c.name])]), ...['Kind', 'Status', 'Dept', 'ReceiptNo', 'Qty'].filter((k) => k in r).map((k) => [k, r[k]])]));
  }
  return snap;
}

// ---------- توثيق سلوك التقريب الحالي (دوال صرفة من غير قاعدة بيانات) ----------
// الأنماط دي هي نفس صيغ الكود الحالي: Math.round على وحدات صغرى صحيحة. بنسجّل القيم زي ما هي اليوم قبل أي تغيير.
function roundingTable() {
  const cur = (cents, pct) => Math.round((cents * (100 - pct)) / 100); // خصم نسبة (coverage.js / tickets.js)
  const share = (cents, pct) => Math.round((cents * pct) / 100); // نسبة (دكتور / تغطية)
  const back = (paid, qty, tot) => Math.round((paid * qty) / tot); // مرتجع جزئي (visits.js)
  const out = { half: {}, discount: [], share: [], back: [], negativeHalf: null };
  for (const x of [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999, 2.675 * 100 / 100]) out.half[String(x)] = Math.round(x);
  for (const [c, p] of [[3333, 12.5], [9999, 12.5], [3333, 7.5], [1235, 33.33], [5, 12.5], [25055, 50], [1, 50], [3, 50], [33, 50], [10001, 33.33], [9999, 66.67]]) out.discount.push({ cents: c, pct: p, result: cur(c, p) });
  for (const [c, p] of [[8748, 40], [2916, 40], [3333, 33.33], [3333, 66.67], [1, 50], [5, 50], [1235, 12.5], [9999, 80]]) out.share.push({ cents: c, pct: p, result: share(c, p) });
  for (const [paid, q, t] of [[29996, 1, 3], [29996, 2, 3], [29996, 3, 3], [10, 1, 3], [5, 1, 2], [1, 1, 3], [100, 2, 3]]) out.back.push({ paid, qty: q, of: t, result: back(paid, q, t) });
  // سلوك السالب: Math.round بيقرّب نص السالب ناحية +∞ (يعني -2.5 ← -2) وليس بعيدًا عن الصفر. ده السلوك الحالي في المرتجعات.
  out.negativeHalf = { 'Math.round(-2.5)': Math.round(-2.5), 'Math.round(2.5)': Math.round(2.5), 'Math.round(-0.5)': Object.is(Math.round(-0.5), -0) ? '-0' : Math.round(-0.5) };
  return out;
}
function wordsTable() {
  // amountInWords بياخد الوحدة الصغرى (قرش) كعدد صحيح. بنسجّل الصيغة الحالية (جنيه/قرش مكتوبة في الكود) قبل ما تتحوّل لإعداد عملة.
  const minor = [0, 1, 2, 5, 10, 11, 100, 101, 102, 1000, 3333, 9999, 25055, 123456, 100000, 100001, 1234567, 100000000];
  return minor.map((m) => ({ minor: m, words: amountInWords(m) }));
}

// ---------- ملخص لكل نوع عملية: عدد + مجاميع (بوحدة 1e-4 كعدد صحيح) + موجب/سالب ----------
async function typeSummary(db) {
  const sum = (rows, cols) => Object.fromEntries(cols.map((c) => [c, rows.reduce((a, r) => a + (u4(r[c]) || 0), 0)]));
  const grp = async (sql, key, cols) => {
    const rows = await db.query(sql); const m = {};
    for (const r of rows) (m[String(key(r))] ||= []).push(r);
    return Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, { count: v.length, ...sum(v, cols) }]));
  };
  const out = {};
  out.receiptsByKind = await grp('SELECT * FROM Receipts', (r) => r.Kind + (r.ReversesId ? ':reversal' : ''), ['Gross', 'Discount', 'Net', 'Cash', 'Card', 'Credit']);
  out.receiptsBySign = await grp('SELECT * FROM Receipts', (r) => (Number(r.Net) < 0 ? 'negative' : Number(r.Net) === 0 ? 'zero' : 'positive'), ['Gross', 'Discount', 'Net', 'Cash', 'Card', 'Credit']);
  out.payOrdersByKindStatus = await grp('SELECT * FROM PayOrders', (r) => `${r.Kind}/${r.Status}`, ['Amount', 'Credit', 'Discount']);
  out.visitItemsByDept = await grp('SELECT * FROM VisitItems', (r) => `${r.Dept}/${r.Status}`, ['UnitPrice', 'Amount', 'DoctorPct']);
  out.admissionItemsByDept = await grp('SELECT * FROM AdmissionItems', (r) => `${r.Dept}/${r.Status}`, ['UnitPrice', 'Amount', 'DoctorPct']);
  out.doctorEarningsBySign = await grp('SELECT * FROM DoctorEarnings', (r) => (Number(r.Amount) < 0 ? 'negative' : 'positive'), ['BaseAmount', 'Amount']);
  out.payerLedgerBySign = await grp('SELECT * FROM PayerLedger', (r) => (Number(r.Amount) < 0 ? 'reversal' : 'charge'), ['FullAmount', 'Amount']);
  out.claims = await grp('SELECT * FROM Claims', (r) => r.Status, ['Total', 'Paid', 'Rejected']);
  out.doctorPayouts = await grp('SELECT * FROM DoctorPayouts', (r) => r.Status, ['Gross', 'Tax', 'Net']);
  out.vouchers = await grp('SELECT * FROM CashVouchers', (r) => `${r.Kind}/${r.Status}`, ['Amount']);
  out.supplierInvoices = await grp('SELECT * FROM SupplierInvoices', (r) => String(r.Status ?? 'n/a'), ['Amount']);
  out.expenses = await grp('SELECT * FROM Expenses', (r) => String(r.Status ?? 'n/a'), ['Amount']);
  out.stockMoves = await grp('SELECT * FROM StockMoves', (r) => r.Kind, ['Qty', 'Cost']);
  return out;
}
