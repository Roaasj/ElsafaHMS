// اختبارات الشريحة 3: الدخول والأسرّة والليالي والخروج
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { cairoDate } from '../src/lib/util.js';

let ctx, base, rec, mgr, managerId, svc, docs, board;
async function login(u, p = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}
const bedOf = (room, label) => board.floors.flatMap((f) => f.rooms).find((r) => r.no === room).beds.find((b) => !label || b.label === label);
const fullPatient = (n, nid) => ({ name: `مريض الإقامة رقم ${n} علي`, phone: `0101234${String(n).padStart(4, '0')}`, nationalId: nid, address: 'دمياط', emergencyName: 'أخوه', emergencyPhone: '01099999999' });
const daysAgo = (n) => new Date(Date.now() - n * 86400e3);

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }); // الاختبارات القديمة: الاستقبال بيضيف البنود
  managerId = (await rec.get('/api/catalog/managers')).body.managers[0].id;
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  board = (await rec.get('/api/admissions/beds/board')).body;
  // ميعاد الخروج 23:59: يوم الخروج مش بيتحسب (غير لو نفس يوم الدخول)
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' });
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('الأدوار الحقيقية ودرجات الغرف موجودة، ولوحة الأسرّة شغالة', async () => {
  const o = (await mgr.get('/api/admin/rooms')).body;
  assert.deepEqual(o.floors.map((f) => f.no), [3, 4, 6, 7, 8]);
  assert.deepEqual(o.classes.map((c) => c.name), ['عادية', 'ممتازة', 'جناح', 'جناح ملكي', 'عناية مركزة', 'حضانة']);
  assert.equal(board.counts.total, 35);
  assert.equal(board.counts.free, 35);
});

let p1, a1;
test('الدخول: بيانات ناقصة، سرير مش مناسب، تأمين أقل من المطلوب', async () => {
  const pr = (await rec.post('/api/patients', { name: 'مريض ناقص البيانات خالص', phone: '01011112222', ageYears: 50, sex: 'M' })).body.patient;
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: pr.id, type: 'inpatient', bedId: bedOf('301', 'أ').id, doctorId: docs[0].id, deposit: 3000, cash: 3000 });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.needsPatientData, ['الرقم القومي', 'العنوان', 'قريب للطوارئ وتليفونه']);
  p1 = (await rec.post('/api/patients', fullPatient(1, '28501011100035'))).body.patient;
  const icu = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p1.id, type: 'inpatient', bedId: bedOf('عناية 1').id, doctorId: docs[0].id, deposit: 15000, cash: 15000 });
  assert.equal(icu.status, 400);
  assert.match(icu.body.error, /مش مناسب/);
  const low = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p1.id, type: 'inpatient', bedId: bedOf('301', 'أ').id, doctorId: docs[0].id, deposit: 1000, cash: 1000 });
  assert.equal(low.status, 400);
  assert.ok(low.body.errors.deposit);
});

test('دخول داخلي: إيصال تأمين، السرير مشغول، ليلة النهارده اتسجلت', async () => {
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p1.id, type: 'inpatient', bedId: bedOf('301', 'أ').id, doctorId: docs[0].id, expectedProcedure: 'متابعة', deposit: 4000, cash: 3000, card: 1000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  a1 = r.body.admission;
  assert.equal(a1.no, 1);
  assert.equal(r.body.receipts[0].kind, 'deposit');
  assert.equal(r.body.totals.paid, 4000);
  assert.equal(r.body.totals.nights, 600);
  assert.equal(r.body.items[0].date, cairoDate());
  const b = (await rec.get('/api/admissions/beds/board')).body;
  assert.equal(b.counts.occupied, 1);
  assert.equal((await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p1.id, type: 'inpatient', bedId: bedOf('302', 'أ').id, doctorId: docs[0].id, deposit: 3000, cash: 3000 })).status, 409);
  const p2 = (await rec.post('/api/patients', fullPatient(2, '29002021100046'))).body.patient;
  assert.equal((await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p2.id, type: 'inpatient', bedId: bedOf('301', 'أ').id, doctorId: docs[0].id, deposit: 3000, cash: 3000 })).status, 409);
  const pf = (await rec.get('/api/patients/' + p1.id)).body;
  assert.equal(pf.admittedNow.no, 1);
});

test('الليالي: دخل من 3 أيام ← 4 ليالي، والتحويل لعناية بيغيّر سعر النهارده بس', async () => {
  await ctx.db.run('UPDATE Admissions SET AdmittedAt = ? WHERE Id = ?', [daysAgo(3), a1.id]);
  await ctx.db.run('UPDATE BedMoves SET FromAt = ? WHERE AdmissionId = ?', [daysAgo(3), a1.id]);
  await ctx.db.run("DELETE FROM AdmissionItems WHERE AdmissionId = ? AND Kind = 'night'", [a1.id]);
  let d = (await rec.get('/api/admissions/' + a1.id)).body;
  assert.equal(d.admission.nights, 4);
  assert.equal(d.totals.nights, 2400);
  const t = await rec.post(`/api/admissions/${a1.id}/transfer`, { bedId: bedOf('عناية 1').id, reason: 'تدهور الحالة' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  d = t.body;
  assert.equal(d.admission.type, 'icu');
  assert.equal(d.totals.nights, 600 * 3 + 3500);
  assert.equal(d.moves.length, 2);
  const b = (await rec.get('/api/admissions/beds/board')).body;
  assert.equal(bedOfIn(b, '301', 'أ').status, 'cleaning');
  // السرير تحت التنظيف مينفعش يتاخد لحد ما يتعلّم فاضي
  const p3 = (await rec.post('/api/patients', fullPatient(3, '29003031100057'))).body.patient;
  assert.equal((await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p3.id, type: 'inpatient', bedId: bedOf('301', 'أ').id, doctorId: docs[0].id, deposit: 3000, cash: 3000 })).status, 409);
  assert.equal((await rec.post(`/api/admissions/beds/${bedOf('301', 'أ').id}/status`, { status: 'free' })).status, 200);
});
function bedOfIn(b, room, label) { return b.floors.flatMap((f) => f.rooms).find((r) => r.no === room).beds.find((x) => x.label === label); }

test('خدمات على الحساب، ودفعة تحت الحساب، وإلغاء إيصال التأمين', async () => {
  const visitDoc = docs.find((x) => x.name.includes('أحمد'));
  let d = (await rec.post(`/api/admissions/${a1.id}/items`, { serviceId: svc['IP-001'].id, doctorId: visitDoc.id, qty: 2 })).body;
  d = (await rec.post(`/api/admissions/${a1.id}/items`, { serviceId: svc['LAB-001'].id })).body;
  assert.equal(d.totals.services, 720);
  const pay = await rec.post(`/api/admissions/${a1.id}/pay`, { cash: 2000 });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.totals.paid, 6000);
  const depId = pay.body.receipts.find((r) => r.kind === 'deposit').id;
  const c = await rec.post(`/api/receipts/${depId}/cancel`, { reason: 'المبلغ اتكتب غلط' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.totals.paid, 2000);
  // الموظف مايشيلش ليلة، المدير يقدر
  const night = c.body.items.find((i) => i.kind === 'night');
  assert.equal((await rec.del(`/api/admissions/${a1.id}/items/${night.id}`, { reason: 'غلط' })).status, 403);
});

test('الخروج: الحساب كله، خصم بموافقة المدير، والمتبقي آجل لازم سبب ومدير', async () => {
  const pv = (await rec.get(`/api/admissions/${a1.id}/discharge-preview`)).body;
  // ميعاد حساب اليوم 23:59، فليلة النهارده (العناية) مش بتتحسب لو خرج دلوقتي
  const total = 600 * 3 + 720;
  assert.equal(pv.totals.total, total);
  assert.equal(pv.items.find((i) => i.kind === 'night' && i.status === 'voided').voidReason, 'الخروج قبل ميعاد حساب اليوم');
  assert.equal(pv.totals.balance, total - 2000);
  // المعاينة ما بتخرّجش المريض
  assert.equal((await rec.get('/api/admissions/' + a1.id)).body.admission.status, 'active');
  const R = total - 2000 - 100;
  const noNote = await rec.post(`/api/admissions/${a1.id}/discharge`, { discount: 100, discountReason: 'حالة إنسانية', discountApprovedBy: managerId, cash: R - 200, credit: 200, creditApprovedBy: managerId });
  assert.equal(noNote.status, 400);
  const ok = await rec.post(`/api/admissions/${a1.id}/discharge`, { discount: 100, discountReason: 'حالة إنسانية', discountApprovedBy: managerId, cash: R - 200, credit: 200, creditApprovedBy: managerId, note: 'هيسدد الأسبوع الجاي' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.admission.status, 'discharged');
  assert.equal(ok.body.totals.balance, 0);
  assert.equal(ok.body.totals.credit, 200);
  const fin = ok.body.receipts.find((r) => r.kind === 'final');
  assert.equal(fin.net, R);
  // نسبة الدكتور على زيارة الطبيب بعد الخصم
  const e = await ctx.db.query('SELECT * FROM DoctorEarnings WHERE AdmissionItemId IS NOT NULL');
  assert.equal(e.length, 1);
  assert.ok(Number(e[0].BaseAmount) < 600 && Number(e[0].BaseAmount) > 500);
  const b = (await rec.get('/api/admissions/beds/board')).body;
  assert.equal(bedOfIn(b, 'عناية 1', 'أ').status, 'cleaning');
  // الحساب بيطبع فاتورة نهائية
  const inv = await rec.get(`/print/admission/${a1.id}`);
  assert.equal(inv.status, 200);
  assert.ok(inv.body.includes('فاتورة نهائية'));
});

test('إلغاء الخروج: المدير بس، وبيرجع المريض على سريره', async () => {
  assert.equal((await rec.post(`/api/admissions/${a1.id}/undo-discharge`, { reason: 'خرج بالغلط' })).status, 403);
  const u = await mgr.post(`/api/admissions/${a1.id}/undo-discharge`, { reason: 'خرج بالغلط' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.admission.status, 'active');
  assert.equal(u.body.totals.credit, 0);
  // ليلة النهارده اللي اتشالت عند الخروج رجعت
  assert.equal(u.body.totals.nights, 600 * 3 + 3500);
  const e = await ctx.db.one('SELECT SUM(Amount) AS S FROM DoctorEarnings WHERE AdmissionItemId IS NOT NULL');
  assert.equal(Number(e.S), 0);
});

test('مرتجع للمريض لو التأمين أكبر من الحساب، ويوم الدخول بس = ليلة واحدة', async () => {
  const p = (await rec.post('/api/patients', fullPatient(4, '29504041100068'))).body.patient;
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bedOf('302', 'أ').id, doctorId: docs[0].id, deposit: 5000, cash: 5000 });
  assert.equal(r.status, 201);
  const d = await rec.post(`/api/admissions/${r.body.admission.id}/discharge`, {});
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const ret = d.body.receipts.find((x) => x.kind === 'return');
  assert.equal(ret.net, -(5000 - 600));
  assert.equal(ret.cash, -(5000 - 600));
  assert.equal(d.body.admission.nights, 1);
});

test('باكدج العمليات: الليالي اللي ضمنه بصفر', async () => {
  const p = (await rec.post('/api/patients', { ...fullPatient(5, '29505051100079'), name: 'مريضة الولادة القيصرية', sex: 'F' })).body.patient;
  const a = (await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'surgery', bedId: bedOf('303').id, doctorId: docs[3].id, deposit: 5000, cash: 5000 })).body.admission;
  await ctx.db.run('UPDATE Admissions SET AdmittedAt = ? WHERE Id = ?', [daysAgo(2), a.id]);
  await ctx.db.run('UPDATE BedMoves SET FromAt = ? WHERE AdmissionId = ?', [daysAgo(2), a.id]);
  await ctx.db.run("DELETE FROM AdmissionItems WHERE AdmissionId = ? AND Kind = 'night'", [a.id]);
  const d = (await rec.post(`/api/admissions/${a.id}/items`, { serviceId: svc['OR-004'].id, doctorId: docs[3].id })).body;
  const nights = d.items.filter((i) => i.kind === 'night' && i.status === 'active');
  assert.equal(nights.length, 3);
  assert.deepEqual(nights.map((n) => n.amount), [0, 0, 950]);
  assert.equal(d.totals.total, 16000 + 950);
});

test('من الطوارئ للدخول: الخدمات اللي ما اتدفعتش بتنتقل لحساب الإقامة', async () => {
  const p = (await rec.post('/api/patients', fullPatient(6, '29006061100082'))).body.patient;
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'emergency' })).body;
  await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['ER-004'].id });
  await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['ER-002'].id });
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'icu', bedId: bedOf('عناية 2').id, doctorId: docs[0].id, deposit: 15000, cash: 15000, fromVisitId: v.visit.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const moved = r.body.items.filter((i) => i.fromVisit);
  assert.equal(moved.length, 2);
  assert.equal(r.body.totals.services, 225);
  const vd = (await rec.get('/api/visits/' + v.visit.id)).body;
  assert.equal(vd.visit.status, 'closed');
  assert.equal(vd.totals.due, 0);
});

test('حجز سرير، وإعدادات الغرف والأسعار للمدير', async () => {
  const bed = bedOf('402', 'أ');
  assert.equal((await rec.post(`/api/admissions/beds/${bed.id}/status`, { status: 'reserved' })).status, 400);
  assert.equal((await rec.post(`/api/admissions/beds/${bed.id}/status`, { status: 'reserved', note: 'حالة د. سارة بكرة' })).status, 200);
  assert.equal((await rec.get('/api/admin/rooms')).status, 403);
  const o = (await mgr.get('/api/admin/rooms')).body;
  const cls = o.classes.find((c) => c.name === 'عادية');
  const up = await mgr.put('/api/admin/classes/' + cls.id, { ...cls, nightPrice: 700 });
  assert.equal(up.body.classes.find((c) => c.id === cls.id).nightPrice, 700);
  const floor6 = o.floors.find((f) => f.no === 6);
  const icu = o.classes.find((c) => c.kind === 'icu');
  const nr = await mgr.post('/api/admin/rooms', { floorId: floor6.id, no: 'عناية 3', classId: icu.id, bedCount: 4 });
  assert.equal(nr.status, 201);
  assert.equal(nr.body.rooms.find((r) => r.no === 'عناية 3').beds.length, 4);
  // غرفة عليها مريض متتقفلش
  const occRoom = nr.body.rooms.find((r) => r.no === 'عناية 2');
  assert.equal((await mgr.put('/api/admin/rooms/' + occRoom.id, { ...occRoom, active: false })).status, 409);
  // درجة من غير سعر: الدخول عليها ممنوع
  const nc = (await mgr.post('/api/admin/classes', { name: 'اقتصادي', kind: 'ward' })).body.classes.find((c) => c.name === 'اقتصادي');
  const rr = (await mgr.post('/api/admin/rooms', { floorId: floor6.id, no: '601', classId: nc.id, bedCount: 1 })).body.rooms.find((r) => r.no === '601');
  const p = (await rec.post('/api/patients', fullPatient(7, '29007071100093'))).body.patient;
  const x = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: rr.beds[0].id, doctorId: docs[0].id, deposit: 0 });
  assert.equal(x.status, 400);
  assert.match(x.body.error, /لسه ما اتحددش/);
});

test('الإيصالات والملخص بيشملوا الدخول', async () => {
  const r = (await rec.get('/api/receipts')).body;
  assert.ok(Array.isArray(r.receipts), JSON.stringify(r));
  assert.ok(r.receipts.some((x) => x.kind === 'deposit' && x.visitType === 'admission'));
  const s = (await rec.get('/api/home/summary')).body;
  assert.ok(s.beds.total >= 35);
  assert.ok(s.beds.occupied >= 2);
  assert.ok(s.today.admitted >= 2);
  const act = (await rec.get('/api/admissions/active')).body.admissions;
  assert.ok(act.length >= 3);
  const pr = await rec.get('/print/receipt/' + r.receipts.find((x) => x.kind === 'deposit').id);
  assert.ok(pr.body.includes('إيصال تأمين دخول'));
});
