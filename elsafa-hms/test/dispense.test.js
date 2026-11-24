// اختبارات الصرف: مخازن الأقسام، «اتصرف من» في التذكرة، الصرف في الزيارة، بيع الصيدلية والمرتجع، الجرد، والإعدام
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, rec, acc, sacc, pharm, cas, svc, docs, items, stores;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b) };
}
const I = (n) => items.find((x) => x.name === n);
const S = (n) => stores.find((x) => x.name === n);
const qty = async (storeName, itemName) => (await mgr.get(`/api/stores/stock?storeId=${S(storeName).id}&filter=all&q=${encodeURIComponent(itemName)}`)).body.items.find((x) => x.name === itemName)?.qty;
let pn = 0;
async function patient() {
  pn++;
  return (await rec.post('/api/patients', { name: `مريض صرف ${pn} سامي`, phone: `0105555${String(pn).padStart(4, '0')}`, ageYears: 40, sex: 'M', address: 'دمياط', nationalId: `276010111${String(pn).padStart(3, '0')}1${pn % 10}`, emergencyName: 'ابنه', emergencyPhone: '01012345678', confirmDuplicatePhone: true })).body.patient;
}

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager')); rec = client(await login('reception')); acc = client(await login('acc'));
  sacc = client(await login('storeacc')); pharm = client(await login('pharm')); cas = client(await login('cashier'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  items = (await acc.get('/api/tickets/items')).body.items;
  stores = (await mgr.get('/api/stores/meta')).body.stores;
  // رصيد أول المدة لكل مخزن بنستخدمه
  for (const n of ['مخزن العمليات', 'مخزن الدور 4', 'مخزن الطوارئ', 'الصيدلية']) {
    const r = await sacc.post('/api/stores/purchases', { kind: 'opening', storeId: S(n).id, lines: [
      { itemId: I('سيفترياكسون 1 جم').id, qty: 20, batchNo: 'X1', expiry: '2028-01-31', cost: 60 }, { itemId: I('كانيولا 20G').id, qty: 30 },
      { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 3, cost: 100, batchNo: 'AM1', expiry: '2027-06-30' }] });
    assert.equal(r.status, 201, n + JSON.stringify(r.body));
  }
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('مخازن الأقسام اتعملت لوحدها، والمدير يزوّد مخزن بقسم بسهولة', async () => {
  for (const n of ['مخزن العمليات', 'مخزن العناية', 'مخزن الحضانة', 'مخزن الطوارئ', 'مخزن العيادات', 'مخزن الأشعة', 'مخزن المعمل']) assert.ok(S(n), n);
  assert.equal(S('مخزن العمليات').dept, 'or');
  const n = await mgr.post('/api/stores/list', { name: 'مخزن عيادة الأسنان', kind: 'sub', holds: 'supply', dept: 'clinic', notes: 'الدور الأرضي' });
  assert.equal(n.status, 201);
  assert.equal(n.body.store.dept, 'clinic');
});

test('التذكرة: «اتصرف من» مخزن العمليات، وبعدين من مخزن الدور، وكل دفعة بمخزنها', async () => {
  const p = await patient();
  const board = (await rec.get('/api/admissions/beds/board')).body;
  let bed, cls;
  for (const f of board.floors) if (f.no === 4) for (const r of f.rooms) for (const b of r.beds) if (!bed && b.status === 'free' && r.cls.kind === 'ward') { bed = b; cls = r.cls; }
  const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'surgery', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit });
  const aid = a.body.admission.id;
  const d0 = (await acc.get(`/api/tickets/adm/${aid}`)).body;
  assert.equal(d0.days.at(-1).storeId, S('مخزن الدور 4').id); // الافتراضي: مخزن الدور
  assert.ok(d0.stores.some((x) => x.name === 'مخزن العمليات') && !d0.stores.some((x) => x.kind === 'main'));
  assert.equal(d0.stockByStore[S('مخزن العمليات').id][I('سيفترياكسون 1 جم').id], 20);
  // ورقة العمليات
  const or1 = await acc.post(`/api/tickets/adm/${aid}/lines`, { storeId: S('مخزن العمليات').id, line: { cat: 'drug', stockItemId: I('سيفترياكسون 1 جم').id, qty: 2 } });
  assert.equal(or1.status, 201, JSON.stringify(or1.body));
  const or2 = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: or1.body.ticket.id, storeId: S('مخزن العمليات').id, line: { cat: 'supply', stockItemId: I('كانيولا 20G').id, qty: 1 } });
  assert.equal(or2.body.ticket.id, or1.body.ticket.id);
  // ورقة الدور: نفس الدفعة؟ لأ، مخزن تاني = دفعة جديدة
  const w = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: or1.body.ticket.id, line: { cat: 'drug', stockItemId: I('سيفترياكسون 1 جم').id, qty: 1 } });
  assert.notEqual(w.body.ticket.id, or1.body.ticket.id);
  assert.equal(await qty('مخزن العمليات', 'سيفترياكسون 1 جم'), 18);
  assert.equal(await qty('مخزن الدور 4', 'سيفترياكسون 1 جم'), 19);
  const tks = w.body.tickets;
  assert.deepEqual(tks.map((x) => x.storeName), ['مخزن العمليات', 'مخزن الدور 4']);
  // الشيل بيرجّع لمخزن العمليات نفسه
  await acc.del(`/api/tickets/adm/${aid}/items/${or1.body.itemId}`, {});
  assert.equal(await qty('مخزن العمليات', 'سيفترياكسون 1 جم'), 20);
  // المخزن الرئيسي مش مسموح
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/lines`, { storeId: S('مخزن الأدوية الرئيسي').id, line: { cat: 'drug', stockItemId: I('سيفترياكسون 1 جم').id } })).status, 400);
});

test('الطوارئ: الاستقبال بيصرف من مخزن الطوارئ على حساب المريض، ومن مخزن مش مربوط بيه مرفوض', async () => {
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'emergency' })).body;
  const vid = v.visit.id;
  const add = await rec.post(`/api/visits/${vid}/items`, { stockItemId: I('كانيولا 20G').id, qty: 1 });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const it = add.body.items.find((x) => x.id === add.body.itemId);
  assert.equal(it.storeName, 'مخزن الطوارئ');
  assert.equal(it.amount, 18);
  assert.equal(await qty('مخزن الطوارئ', 'كانيولا 20G'), 29);
  // مش مربوط بالعمليات
  assert.equal((await rec.post(`/api/visits/${vid}/items`, { stockItemId: I('كانيولا 20G').id, storeId: S('مخزن العمليات').id })).status, 400);
  // العدد والشيل
  await rec.put(`/api/visits/${vid}/items/${add.body.itemId}`, { qty: 3 });
  assert.equal(await qty('مخزن الطوارئ', 'كانيولا 20G'), 27);
  const d2 = await rec.post(`/api/visits/${vid}/items`, { stockItemId: I('سيفترياكسون 1 جم').id, qty: 1 });
  await rec.del(`/api/visits/${vid}/items/${d2.body.itemId}`, {});
  assert.equal(await qty('مخزن الطوارئ', 'سيفترياكسون 1 جم'), 20);
  // يتدفع مع باقي الزيارة
  const pay = await rec.post(`/api/visits/${vid}/pay`, { itemIds: [add.body.itemId], cash: 54 });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  // إلغاء الإيصال بيرجّع الصنف
  const c = await rec.post(`/api/receipts/${pay.body.receiptId}/cancel`, { reason: 'اتسجل غلط' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(await qty('مخزن الطوارئ', 'كانيولا 20G'), 30);
});

test('بيع الصيدلية: الصيدلي بيحصّل بنفسه حتى والخزينة شغالة، والمرتجع الجزئي', async () => {
  await cas.post('/api/shifts/open', {});
  const p = await patient();
  assert.equal((await rec.post('/api/visits', { patientId: p.id, type: 'pharmacy' })).status, 400); // الاستقبال مش بيبيع صيدلية
  const v = await pharm.post('/api/visits', { patientId: p.id, type: 'pharmacy' });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const vid = v.body.visit.id;
  const a1 = await pharm.post(`/api/visits/${vid}/items`, { stockItemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 2 }); // 28 قرص × 9
  assert.equal(a1.body.items.find((x) => x.id === a1.body.itemId).amount, 252);
  assert.equal(await qty('الصيدلية', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص'), 14);
  const pay = await pharm.post(`/api/visits/${vid}/pay`, { itemIds: [a1.body.itemId], cash: 252 });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.ok(pay.body.receiptId && !pay.body.order, 'مش إذن للخزينة');
  // مرتجع علبة
  assert.equal((await pharm.post(`/api/visits/${vid}/items/${a1.body.itemId}/return`, { qty: 1 })).status, 400); // السبب
  assert.equal((await pharm.post(`/api/visits/${vid}/items/${a1.body.itemId}/return`, { qty: 3, reason: 'مش محتاجه' })).status, 400);
  const r = await pharm.post(`/api/visits/${vid}/items/${a1.body.itemId}/return`, { qty: 1, reason: 'الدكتور غيّر العلاج' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await qty('الصيدلية', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص'), 28);
  const det = r.body;
  assert.equal(det.items.find((x) => x.id === a1.body.itemId).returnedQty, 1);
  assert.equal(det.receipts.find((x) => x.id === r.body.refundId).net, -126);
  // إلغاء الإيصال بعد مرتجع مرفوض
  assert.equal((await pharm.post(`/api/receipts/${pay.body.receiptId}/cancel`, { reason: 'تجربة' })).status, 409);
  // الصيدلي بيقفّل ورديته: المفروض 252 − 126
  const mine = (await pharm.get('/api/shifts/mine')).body;
  assert.equal(mine.shift.expected, 126);
  // تقرير الخزينة فيه قسم الصيدلية
  const tr = (await mgr.get('/api/reports/treasury')).body;
  assert.ok(JSON.stringify(tr).includes('الصيدلية'));
});

test('الجرد: المخزن بيقف، العد يتدخل، والمدير يعتمد والرصيد يتظبط', async () => {
  const st = S('مخزن الطوارئ').id;
  const c = await sacc.post('/api/stores/counts', { storeId: st, note: 'جرد آخر السنة' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const cid = c.body.count.id;
  assert.ok((await sacc.get('/api/stores/counts/list')).body.counts.some((x) => x.id === cid && x.status === 'open'));
  assert.ok(typeof (await sacc.get('/api/stores/counts')).body.total === 'number'); // عدّاد الشريط الجانبي سليم
  // المخزن واقف
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'emergency' })).body;
  const blocked = await rec.post(`/api/visits/${v.visit.id}/items`, { stockItemId: I('كانيولا 20G').id });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /جرد/);
  // العد
  const lines = c.body.lines;
  assert.equal((await sacc.post(`/api/stores/counts/${cid}/submit`)).status, 400); // لسه ما اتعدّش
  const counted = lines.map((l) => ({ id: l.id, counted: l.name === 'كانيولا 20G' ? l.systemQty - 2 : l.systemQty }));
  const sv = await sacc.post(`/api/stores/counts/${cid}/save`, { lines: counted, add: [{ itemId: I('شاش معقم').id, counted: 5, batchNo: 'G9', expiry: '2029-01-01' }] });
  assert.equal(sv.body.remaining, 0);
  assert.equal(sv.body.lines.find((l) => l.name === 'كانيولا 20G').diff, -2);
  assert.equal((await sacc.post(`/api/stores/counts/${cid}/submit`)).body.count.status, 'submitted');
  assert.equal((await sacc.post(`/api/stores/counts/${cid}/approve`)).status, 403); // المدير بس
  const ap = await mgr.post(`/api/stores/counts/${cid}/approve`);
  assert.equal(ap.body.count.status, 'approved');
  assert.equal(await qty('مخزن الطوارئ', 'كانيولا 20G'), 28);
  assert.equal(await qty('مخزن الطوارئ', 'شاش معقم'), 5);
  // اتفك
  assert.equal((await rec.post(`/api/visits/${v.visit.id}/items`, { stockItemId: I('كانيولا 20G').id })).status, 201);
  // ورقة الجرد بتتطبع
  const pr = await sacc.get(`/print/count/${cid}`);
  assert.equal(pr.status, 200);
  assert.match(pr.body, /كانيولا/);
});

test('الإعدام: من تشغيلة معينة بسبب', async () => {
  const card = (await sacc.get(`/api/stores/item/${I('سيفترياكسون 1 جم').id}?storeId=${S('الصيدلية').id}`)).body;
  const b = card.batches[0];
  assert.equal((await sacc.post('/api/stores/waste', { batchId: b.id, qty: 2 })).status, 400);
  assert.equal((await rec.post('/api/stores/waste', { batchId: b.id, qty: 2, reason: 'مكسور' })).status, 403);
  const w = await sacc.post('/api/stores/waste', { batchId: b.id, qty: 2, reason: 'فيالين اتكسروا' });
  assert.equal(w.status, 201);
  assert.equal(await qty('الصيدلية', 'سيفترياكسون 1 جم'), 18);
  assert.equal((await sacc.get('/api/stores/waste')).body.waste[0].qty, 2);
});

test('تقارير المخزن: حركة الصنف بتقفل على الرصيد، والقيمة والاستهلاك والصيدلية والصلاحية والإكسل', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  // حركة الصنف لكل مخزن: رصيد آخر الفترة = الرصيد الفعلي
  for (const n of ['الصيدلية', 'مخزن الطوارئ', 'مخزن العمليات', 'مخزن الدور 4']) {
    for (const it of ['سيفترياكسون 1 جم', 'كانيولا 20G', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص']) {
      const l = (await sacc.get(`/api/stock-reports/ledger?itemId=${I(it).id}&storeId=${S(n).id}&from=2020-01-01&to=${today}`)).body;
      assert.equal(l.opening, 0);
      assert.equal(l.closing, (await qty(n, it)) || 0, `${n} / ${it}`);
      assert.equal(r2(l.opening + l.in - l.out), l.closing);
    }
  }
  // قيمة المخزون: الصيدلية فيها 18 سيفترياكسون × 60
  const v = (await sacc.get(`/api/stock-reports/value?storeId=${S('الصيدلية').id}`)).body;
  assert.equal(v.items.find((x) => x.name === 'سيفترياكسون 1 جم').cost, 1080);
  assert.ok(v.totals.sale >= v.totals.cost);
  // الاستهلاك: الإعدام بيظهر على الصيدلية، والصرف على الطوارئ
  const c = (await sacc.get(`/api/stock-reports/consumption?from=${today}&to=${today}`)).body;
  assert.equal(c.stores.find((x) => x.name === 'الصيدلية').waste, 120);
  assert.ok(c.items.some((x) => x.name === 'كانيولا 20G' && x.qty > 0));
  // بيع الصيدلية: علبتين اتباعوا وعلبة رجعت = 14 قرص صافي
  const ph = (await pharm.get(`/api/stock-reports/pharmacy?from=${today}&to=${today}`)).body;
  assert.equal(ph.items.find((x) => x.name === 'أموكسيسيلين/كلافيولانيك 1 جم أقراص').qty, 14);
  assert.ok(ph.totals.back > 0 && ph.totals.net === r2(ph.totals.sold - ph.totals.back));
  // الصلاحية
  const e = (await sacc.get('/api/stock-reports/expiry?days=730')).body;
  assert.ok(e.batches.some((x) => x.batchNo === 'AM1'));
  assert.equal((await sacc.get('/api/stock-reports/stagnant?days=30')).status, 200);
  // الصلاحيات
  assert.equal((await rec.get('/api/stock-reports/value')).status, 403);
  assert.equal((await pharm.get('/api/stock-reports/value')).status, 403);
  // إكسل
  const x = await fetch(base + `/api/stock-reports/consumption?format=xlsx&by=item&from=${today}&to=${today}`, { headers: { cookie: await login('storeacc') } });
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheet/);
});
const r2 = (n) => Math.round(n * 100) / 100;
