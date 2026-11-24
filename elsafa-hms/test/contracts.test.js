// اختبارات الشريحة 4: التعاقدات والموافقات وحساب الجهات
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, rec, mgr, rev, svc, docs, payers, board;
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
  return (await rec.post('/api/patients', { name: `مريض تعاقد رقم ${n} محمد`, phone: `0105555${String(n).padStart(4, '0')}`, ageYears: 40, sex: 'M', confirmDuplicatePhone: true, ...extra })).body.patient;
}
const P = (name) => payers.find((p) => p.name === name);
const T = (name, tier) => P(name).tiers.find((t) => t.name === tier);
const doc = () => docs[0].id;

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }); // الاختبارات القديمة: الاستقبال بيضيف البنود
  rev = client(await login('review'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  payers = (await rec.get('/api/payers?usable=1')).body.payers;
  board = (await rec.get('/api/admissions/beds/board')).body;
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' });
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('إدارة الجهات للمدير بس، والتحقق من البيانات', async () => {
  assert.equal(payers.length, 3);
  assert.equal((await rec.post('/api/payers', { name: 'x', priceMode: 'cash', tiers: [{ name: 'أ' }] })).status, 403);
  const bad = await mgr.post('/api/payers', { name: 'جهة تجربة', priceMode: 'discount', tiers: [] });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.tiers && bad.body.errors.discountPct);
  const ok = await mgr.post('/api/payers', { name: 'جهة تجربة', priceMode: 'cash', validTo: '2020-01-01', tiers: [{ name: 'عادي', coverage: { clinic: 100 } }] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.payer.valid, false);
  const p = await patient();
  const r = await rec.put(`/api/patients/${p.id}/payer`, { payerId: ok.body.payer.id, tierId: ok.body.payer.tiers[0].id, cardNo: '1' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /انتهى/);
});

test('زيارة تعاقد 50%: المريض يدفع نصه، ونصيب الشركة على حسابها بعد الدفع', async () => {
  const p = await patient();
  await rec.put(`/api/patients/${p.id}/payer`, { payerId: P('نقابة المهندسين').id, tierId: T('نقابة المهندسين', 'كارنيه ب').id, cardNo: 'ENG-1234' });
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  assert.equal(v.visit.payer.name, 'نقابة المهندسين');
  // خصم 10% على أسعار المستشفى: CBC 120 ← 108، والشركة 50%
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-001'].id })).body;
  const it = d.items[0];
  assert.equal(it.amount, 108);
  assert.equal(it.payerAmount, 54);
  assert.equal(it.patientAmount, 54);
  assert.equal(d.totals.due, 54);
  const pay = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [it.id], cash: 54 });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const st = (await rev.get(`/api/payers/${P('نقابة المهندسين').id}/statement`)).body;
  assert.equal(st.rows.length, 1);
  assert.equal(st.rows[0].amount, 54);
  assert.equal(st.rows[0].cardNo, 'ENG-1234');
  const pr = await rec.get('/print/receipt/' + pay.body.receiptId);
  assert.ok(pr.body.toString().includes('نصيب التعاقد'));
  // إلغاء الإيصال بيلغي اللي على الشركة
  await rec.post(`/api/receipts/${pay.body.receiptId}/cancel`, { reason: 'غلط في الخدمة' });
  const st2 = (await rev.get(`/api/payers/${P('نقابة المهندسين').id}/statement`)).body;
  assert.equal(st2.totals.amount, 0);
});

test('خدمة مش مغطاة بتتحسب على المريض كلها', async () => {
  const p = await patient();
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'clinic', payer: { payerId: P('نقابة المهندسين').id, tierId: T('نقابة المهندسين', 'كارنيه أ').id, cardNo: 'A1' } })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['CL-012'].id })).body;
  assert.equal(d.items[0].cover, 'excluded');
  assert.equal(d.items[0].patientAmount, d.items[0].amount);
  const d2 = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['CL-011'].id })).body;
  assert.equal(d2.items[1].patientAmount, 0);
  // 100% مغطى: إيصال بصفر بيتعمل عادي
  const pay = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d2.items[1].id] });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.receipt.net, 0);
});

let pendingId, visitP;
test('موافقة بالليل: رقم الموافقة ← «مستني المراجعة»، والرفض بعد ما المريض مشي بيبقى عليه', async () => {
  const p = await patient();
  const pay = { payerId: P('شركة مصر للتأمين').id, tierId: T('شركة مصر للتأمين', 'ذهبي').id, cardNo: 'MISR-77' };
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'radiology', payer: pay })).body;
  visitP = v.visit.id;
  const no = await rec.post(`/api/visits/${visitP}/items`, { serviceId: svc['RAD-005'].id, doctorId: doc() });
  assert.equal(no.status, 409);
  assert.equal(no.body.needsApproval, true);
  const d = (await rec.post(`/api/visits/${visitP}/items`, { serviceId: svc['RAD-005'].id, doctorId: doc(), approval: { mode: 'pending', no: 'AP-1001', date: '2026-11-18' } })).body;
  const it = d.items[0];
  assert.equal(it.amount, 1400); // قايمة أسعار الشركة
  assert.equal(it.payerAmount, 1120);
  assert.equal(it.cover, 'pending');
  await rec.post(`/api/visits/${visitP}/pay`, { itemIds: [it.id], cash: 280 });
  const list = (await rev.get('/api/approvals?status=open')).body;
  const ap = list.approvals.find((a) => a.no === 'AP-1001');
  assert.ok(ap);
  pendingId = ap.id;
  assert.equal((await rec.post(`/api/approvals/${ap.id}/reject`, { note: 'x' })).status, 403);
  assert.equal((await rev.post(`/api/approvals/${ap.id}/reject`, {})).status, 400);
  const r = await rev.post(`/api/approvals/${ap.id}/reject`, { note: 'الخدمة مش في العقد السنة دي' });
  assert.equal(r.status, 200);
  const vd = (await rec.get('/api/visits/' + visitP)).body;
  assert.equal(vd.visit.status, 'open');
  assert.equal(vd.totals.due, 1120);
  assert.match(vd.items.at(-1).name, /فرق رفض موافقة/);
});

test('اعتماد موافقة بعد الدفع بيسجل على الشركة', async () => {
  const p = await patient();
  const pay = { payerId: P('شركة مصر للتأمين').id, tierId: T('شركة مصر للتأمين', 'ذهبي').id, cardNo: 'MISR-88' };
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'radiology', payer: pay })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['RAD-005'].id, doctorId: doc(), approval: { mode: 'pending', no: 'AP-2002' } })).body;
  await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: 280 });
  const ap = (await rev.get('/api/approvals?status=pending')).body.approvals.find((a) => a.no === 'AP-2002');
  assert.equal((await rev.post(`/api/approvals/${ap.id}/approve`, { note: 'تمام' })).status, 200);
  const st = (await rev.get(`/api/payers/${P('شركة مصر للتأمين').id}/statement`)).body;
  assert.ok(st.rows.some((x) => x.amount === 1120 && x.approvalNo === 'AP-2002'));
  // نسبة الدكتور على السعر كله، والجزء بتاع الشركة «مستحق بعد التحصيل»
  const e = await ctx.db.one('SELECT * FROM DoctorEarnings WHERE VisitItemId = ?', [d.items[0].id]);
  assert.equal(Number(e.BaseAmount), 1400);
  assert.ok(Number(e.PayerPart) > 0);
});

test('نقدي مؤقت: المريض يدفع كله، ولما الموافقة توصل يرجع له نصيب الشركة', async () => {
  const p = await patient();
  const pay = { payerId: P('شركة مصر للتأمين').id, tierId: T('شركة مصر للتأمين', 'ذهبي').id, cardNo: 'MISR-99' };
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'radiology', payer: pay })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['RAD-005'].id, doctorId: doc(), approval: { mode: 'tempcash' } })).body;
  assert.equal(d.totals.due, 1400);
  await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: 1400 });
  const ap = (await rev.get('/api/approvals?status=tempcash')).body.approvals[0];
  assert.equal((await rev.post(`/api/approvals/${ap.id}/approve`, {})).status, 400); // لازم رقم
  assert.equal((await rev.post(`/api/approvals/${ap.id}/approve`, { no: 'AP-3003' })).status, 200);
  const vd = (await rec.get('/api/visits/' + v.visit.id)).body;
  assert.equal(vd.totals.refundDue, 1120);
  const ref = await rec.post(`/api/visits/${v.visit.id}/refund-due`);
  assert.equal(ref.status, 201);
  assert.equal(ref.body.receipts.at(-1).net, -1120);
  assert.equal(ref.body.totals.refundDue, 0);
});

test('الحد الأقصى للزيارة: اللي فوقه على المريض', async () => {
  const p = await patient();
  const pay = { payerId: P('شركة مصر للتأمين').id, tierId: T('شركة مصر للتأمين', 'ذهبي').id, cardNo: 'CAP' };
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'radiology', payer: pay })).body;
  let d;
  for (let k = 0; k < 7; k++) d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['RAD-004'].id, doctorId: doc() })).body;
  assert.equal(d.totals.payer, 5000);
  assert.equal(d.totals.due, 900 * 7 - 5000);
});

test('دخول تعاقد: التأمين على قد نصيب المريض، والليالي متغطية، والخروج بنصيب المريض بس', async () => {
  const p = await patient({ nationalId: '29001011100031', address: 'دمياط', emergencyName: 'أخوه', emergencyPhone: '01011111111' });
  const pay = { payerId: P('شركة مصر للتأمين').id, tierId: T('شركة مصر للتأمين', 'فضي').id, cardNo: 'S-1' };
  const bed = board.floors.flatMap((f) => f.rooms).find((r) => r.no === '301').beds[0];
  // عادية تأمينها 3000، والشركة 70% إقامة ← أقل تأمين 900
  const low = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: doc(), deposit: 500, cash: 500, payer: pay });
  assert.equal(low.status, 400);
  assert.match(low.body.errors.deposit, /900/);
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: doc(), deposit: 900, cash: 900, payer: pay, approvalNo: 'ADM-1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body;
  assert.equal(a.admission.payer.name, 'شركة مصر للتأمين');
  assert.equal(a.totals.total, 600);
  assert.equal(a.totals.payer, 420);
  assert.equal(a.totals.patient, 180);
  const ex = await rec.post(`/api/admissions/${a.admission.id}/items`, { serviceId: svc['OR-001'].id, doctorId: doc() });
  const opItem = ex.body.items.find((i) => i.name === 'عملية زايدة دودية');
  assert.equal(opItem.cover, 'pending');
  const dis = await rec.post(`/api/admissions/${a.admission.id}/discharge`, { cash: 180 + 2800 - 900 });
  assert.equal(dis.status, 201, JSON.stringify(dis.body));
  // المريض: 180 إقامة + 40% من 7000 = 2980، والتأمين 900 ← يدفع 2080
  assert.equal(dis.body.receipts.at(-1).net, 180 + 2800 - 900);
  const st = (await rev.get(`/api/payers/${P('شركة مصر للتأمين').id}/statement`)).body;
  assert.ok(st.rows.some((x) => x.amount === 420 && /دخول/.test(x.description)));
  assert.ok(!st.rows.some((x) => x.amount === 4200)); // العملية لسه مستنية الموافقة
  // موافقة الدخول اترفضت بعد الخروج: الحساب كله يتحول نقدي، والمتبقي على المريض يتحصّل
  const ap = (await rev.get('/api/approvals?status=pending')).body.approvals.find((x) => x.scope === 'admission' && x.admissionId === a.admission.id);
  await rev.post(`/api/approvals/${ap.id}/reject`, { note: 'الكارنيه موقوف' });
  const d2 = (await rec.get('/api/admissions/' + a.admission.id)).body;
  assert.equal(d2.admission.payer.status, 'rejected');
  assert.equal(d2.totals.balance, 420 + 4200);
  const st2 = (await rev.get(`/api/payers/${P('شركة مصر للتأمين').id}/statement`)).body;
  assert.ok(st2.rows.some((x) => x.amount === -420));
  assert.equal((await rec.post(`/api/admissions/${a.admission.id}/pay`, { cash: 99999 })).status, 400);
  const pd = await rec.post(`/api/admissions/${a.admission.id}/pay`, { cash: 4620 });
  assert.equal(pd.status, 201);
  assert.equal(pd.body.totals.balance, 0);
});

test('دخول 100% من غير تأمين', async () => {
  const p = await patient({ nationalId: '29002021100046', address: 'دمياط', emergencyName: 'أبوه', emergencyPhone: '01011111112' });
  const pay = { payerId: P('هيئة قناة السويس').id, tierId: T('هيئة قناة السويس', 'موظف').id, cardNo: 'SC-5' };
  const bed = board.floors.flatMap((f) => f.rooms).find((r) => r.no === '302').beds[0];
  const r = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: doc(), deposit: 0, payer: pay });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.totals.patient, 0);
});

test('كشف الحساب إكسل، وقايمة الموافقات للمراجعة', async () => {
  const x = await rev.get(`/api/payers/${P('شركة مصر للتأمين').id}/statement?format=xlsx`);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.match(String(wb.worksheets[0].getCell('A1').value), /كشف حساب شركة مصر للتأمين/);
  const all = (await rev.get('/api/approvals')).body;
  assert.ok(all.approvals.length >= 4);
  assert.equal((await rec.get('/api/approvals?status=open')).status, 200);
});
