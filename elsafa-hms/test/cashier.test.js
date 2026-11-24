// اختبارات الشريحة 5: أذونات الدفع والخزينة وتقفيل الوردية وتقرير الخزينة
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { shiftLabel, businessDate } from '../src/lib/cashier.js';

let ctx, base, rec, mgr, cas, cas2, sup, svc, docs, board;
async function login(u, p = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}
let n = 0;
async function patient(extra = {}) {
  n++;
  return (await rec.post('/api/patients', { name: `مريض خزينة رقم ${n} علي`, phone: `0106666${String(n).padStart(4, '0')}`, ageYears: 33, sex: 'F', address: 'دمياط', nationalId: '', confirmDuplicatePhone: true, ...extra })).body.patient;
}
const freeBed = async () => {
  const b = (await rec.get('/api/admissions/beds/board')).body;
  for (const f of b.floors) for (const r of f.rooms) for (const x of r.beds) if (x.status === 'free' && r.cls.kind === 'ward' && r.cls.nightPrice) return { bed: x, cls: r.cls };
};
const mgrId = async () => (await mgr.get('/api/me')).body.user.id;

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }); // الاختبارات القديمة: الاستقبال بيضيف البنود
  cas = client(await login('cashier'));
  cas2 = client(await login('cashier2'));
  sup = client(await login('super'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  board = (await rec.get('/api/admissions/beds/board')).body;
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' });
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('تسمية الورديات ويوم الخزينة (السهر على اليوم اللي بدأ فيه)', () => {
  const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 19, h - 2, m)); // القاهرة UTC+2
  assert.equal(shiftLabel(at(8)), 'am');
  assert.equal(shiftLabel(at(7, 40)), 'am'); // استلم بدري
  assert.equal(shiftLabel(at(16)), 'pm');
  assert.equal(shiftLabel(at(22)), 'night');
  assert.equal(shiftLabel(at(3)), 'night');
  assert.equal(businessDate(at(23)), '2026-11-19');
  assert.equal(businessDate(at(3)), '2026-11-18');
  assert.equal(businessDate(at(9)), '2026-11-19');
});

test('من غير خزينة مفتوحة: الاستقبال بيقبض بنفسه (السهر)', async () => {
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-001'].id })).body;
  const r = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: d.totals.due, manualNo: 'م-1' });
  assert.equal(r.status, 201);
  assert.ok(r.body.receiptId && !r.body.order);
});

test('الخزينة فتحت: الدفع عند الاستقبال بيطلع إذن، والخزينة تحصّل بالإيصال اليدوي', async () => {
  const op = await cas.post('/api/shifts/open');
  assert.equal(op.status, 201);
  assert.equal((await rec.get('/api/orders')).body.onDuty.name, 'أمين الخزينة');
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'clinic' })).body;
  const d1 = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['CL-001'].id, doctorId: docs[0].id })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-001'].id })).body;
  const ids = d.items.map((i) => i.id);
  const due = d.totals.due;
  // خصم بموافقة المدير عند الاستقبال
  const r = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: ids, discount: 20, discountReason: 'تعليمات المدير', discountApprovedBy: await mgrId() });
  assert.equal(r.status, 201);
  assert.ok(r.body.order && !r.body.receiptId);
  assert.equal(r.body.order.amount, due - 20);
  // البنود محجوزة: مينفعش تتدفع تاني ولا تتشال
  assert.equal((await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: ids })).status, 409);
  assert.equal((await rec.del(`/api/visits/${v.visit.id}/items/${ids[0]}`, { reason: 'x' })).status, 409);
  // الاستقبال مينفعش يحصّل
  assert.equal((await rec.post(`/api/orders/${r.body.order.id}/collect`, { cash: due - 20 })).status, 403);
  const list = (await cas.get('/api/orders')).body;
  assert.ok(list.orders.some((o) => o.no === r.body.order.no && o.patient.name === p.name));
  // المبلغ غلط
  assert.equal((await cas.post(`/api/orders/${r.body.order.id}/collect`, { cash: 10 })).status, 400);
  const c = await cas.post(`/api/orders/${r.body.order.id}/collect`, { cash: due - 20 - 50, card: 50, manualNo: '4471' });
  assert.equal(c.status, 201);
  const vd = (await rec.get(`/api/visits/${v.visit.id}`)).body;
  const rc = vd.receipts.find((x) => x.id === c.body.receiptId);
  assert.equal(rc.net, due - 20);
  assert.equal(rc.discount, 20);
  assert.equal(vd.totals.due, 0);
  assert.equal((await cas.post(`/api/orders/${r.body.order.id}/collect`, { cash: due - 20 })).status, 409);
  // الإيصال باسم الخزينة ورقمه اليدوي في التقرير
  const rep = (await cas.get('/api/reports/treasury')).body;
  const row = rep.sections.flatMap((s) => s.rows).find((x) => x.id === c.body.receiptId);
  assert.equal(row.manualNo, '4471');
  assert.equal(row.by, 'أمين الخزينة');
  assert.equal(rep.sections.find((s) => s.rows.includes(row)).name, 'العيادات');
  void d1;
});

test('إلغاء الإذن بيفك البنود، والإذن لو الحساب اتغير بيترفض', async () => {
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-002'].id })).body;
  const o = (await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id] })).body.order;
  assert.equal((await rec.post(`/api/orders/${o.id}/cancel`, { reason: 'المريض مشي' })).status, 200);
  assert.equal((await cas.post(`/api/orders/${o.id}/collect`, { cash: o.amount })).status, 409);
  assert.equal((await rec.del(`/api/visits/${v.visit.id}/items/${d.items[0].id}`, { reason: 'مشي' })).status, 200);
});

test('الدخول: التأمين بإذن، والخروج بإذن والمريض يفضل على سريره لحد التحصيل', async () => {
  const p = await patient({ nationalId: '29001011234567', emergencyName: 'أخوه', emergencyPhone: '01011112222' });
  const { bed, cls } = await freeBed();
  const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit });
  assert.equal(a.status, 201);
  assert.ok(a.body.order && !a.body.receiptId);
  assert.equal(a.body.order.kind, 'deposit');
  const c = await cas.post(`/api/orders/${a.body.order.id}/collect`, { cash: cls.deposit, manualNo: 'D-1' });
  assert.equal(c.status, 201);
  const aid = a.body.admission.id;
  // دفعة بإذن
  const pay = await rec.post(`/api/admissions/${aid}/pay`, { amount: 500 });
  assert.equal(pay.body.order.amount, 500);
  assert.equal((await cas.post(`/api/orders/${pay.body.order.id}/collect`, { card: 500 })).status, 201);
  await rec.post(`/api/admissions/${aid}/items`, { serviceId: svc['LAB-001'].id });
  const pv = (await rec.get(`/api/admissions/${aid}/discharge-preview`)).body;
  const R = pv.totals.patient - pv.totals.paid;
  const dis = await rec.post(`/api/admissions/${aid}/discharge`, {});
  assert.equal(dis.status, 201);
  assert.equal(dis.body.order.kind, 'discharge');
  assert.equal(dis.body.order.amount, R);
  assert.equal(dis.body.admission.status, 'active'); // لسه على السرير
  assert.equal((await rec.post(`/api/admissions/${aid}/discharge`, {})).status, 409);
  const x = await cas.post(`/api/orders/${dis.body.order.id}/collect`, R > 0 ? { cash: R } : {});
  assert.equal(x.status, 201);
  const ad = (await rec.get(`/api/admissions/${aid}`)).body;
  assert.equal(ad.admission.status, 'discharged');
  assert.equal(ad.totals.balance, 0);
});

test('تقفيل الوردية: الفرق محتاج سبب، والتسليم والاستلام بيدخلوا درج المستلم', async () => {
  const mine = (await cas.get('/api/shifts/mine')).body;
  assert.ok(mine.shift && mine.shift.receipts >= 3);
  const exp = mine.shift.expected;
  assert.equal((await cas.post('/api/shifts/mine/close', {})).status, 400);
  const bad = await cas.post('/api/shifts/mine/close', { counted: exp - 5, handedTo: mine.receivers.find((u) => u.role === 'cashier').id });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.diffReason);
  assert.equal((await cas.post('/api/shifts/mine/close', { counted: exp })).status, 400); // لازم يختار المستلم
  const evening = mine.receivers.find((u) => u.role === 'cashier');
  const ok = await cas.post('/api/shifts/mine/close', { counted: exp - 5, diffReason: 'فكة ناقصة', handedTo: evening.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.shift.diff, -5);
  // بعد التقفيل مفيش خزينة مفتوحة → الاستقبال يقبض بنفسه
  assert.equal((await rec.get('/api/orders')).body.onDuty, null);
  // خزينة المسائي تستلم
  const h = (await cas2.get('/api/shifts/mine')).body.handovers;
  assert.equal(h.length, 1);
  assert.equal((await rec.post(`/api/shifts/${h[0].id}/receive`)).status, 404);
  assert.equal((await cas2.post(`/api/shifts/${h[0].id}/receive`)).status, 200);
  const m2 = (await cas2.get('/api/shifts/mine')).body.shift;
  assert.equal(m2.receivedCash, exp - 5);
  assert.equal(m2.expected, exp - 5);
  // تقرير الورديات
  const sh = (await sup.get('/api/reports/shifts')).body.shifts;
  const closed = sh.find((s) => s.id === h[0].id);
  assert.equal(closed.receivedBy, 'موظفة خزينة المسائي');
  assert.equal((await rec.get('/api/reports/shifts')).status, 403);
});

test('تقرير الخزينة: أقسام وإجماليات وإكسل، والمدير يقفل نظام الأذونات', async () => {
  const rep = (await mgr.get('/api/reports/treasury')).body;
  assert.ok(rep.sections.length >= 2);
  const sum = rep.sections.reduce((a, s) => a + Math.round(s.totals.net * 100), 0);
  assert.equal(sum, Math.round(rep.totals.net * 100));
  const x = await mgr.get('/api/reports/treasury?format=xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.match(String(wb.worksheets[0].getCell('A1').value), /تقرير الخزينة/);
  // المدير يقفل الأذونات: الاستقبال يقبض حتى لو الخزينة شغالة
  await cas2.post('/api/shifts/open');
  await mgr.put('/api/admin/cashier-settings', { cashierMode: 'off' });
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-001'].id })).body;
  assert.ok((await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: d.totals.due })).body.receiptId);
  await mgr.put('/api/admin/cashier-settings', { cashierMode: 'auto', manualNoRequired: true });
  const d2 = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-002'].id })).body;
  const o = (await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d2.items.find((i) => !i.paid).id] })).body.order;
  const nm = await cas2.post(`/api/orders/${o.id}/collect`, { cash: o.amount });
  assert.equal(nm.status, 400);
  assert.ok(nm.body.errors.manualNo);
  assert.equal((await cas2.post(`/api/orders/${o.id}/collect`, { cash: o.amount, manualNo: '99' })).status, 201);
  // الخصومات ومستحقات الأطباء للمدير
  const ds = (await mgr.get('/api/reports/discounts')).body;
  assert.ok(ds.rows.some((r) => r.discount === 20 && r.discountReason === 'تعليمات المدير'));
  const dr = (await mgr.get('/api/reports/doctors')).body;
  assert.ok(dr.rows.length >= 1);
});
