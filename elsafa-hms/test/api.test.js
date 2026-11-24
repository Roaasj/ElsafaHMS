// اختبارات آلية للشريحة الأولى (على SQLite في الذاكرة)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { parseNationalId } from '../shared/nid.js';
import { amountInWords } from '../shared/tafqeet.js';
import { cairoDayRange } from '../src/lib/util.js';

let ctx, base;
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

async function login(username, password = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, cookie, body: await r.json() };
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}

const P = { name: 'محمد أحمد علي حسن', phone: '01012345678', ageYears: 34, sex: 'M' };
let rec, sup, mgr, managerId, services, patientId;

test('الدخول: كلمة سر غلط بترفض، والصح بيدخل', async () => {
  assert.equal((await login('reception', 'x')).status, 401);
  const ok = await login('reception');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'reception');
  rec = client(ok.cookie);
  sup = client((await login('super')).cookie);
  mgr = client((await login('manager')).cookie);
  assert.equal((await client('').get('/api/me')).status, 401);
  managerId = (await rec.get('/api/catalog/managers')).body.managers[0].id;
  services = (await rec.get('/api/catalog/services')).body.services;
  assert.ok(services.length > 10);
});

test('الرقم القومي: صحيح بيطلع تاريخ الميلاد والنوع، وغلط بيترفض', () => {
  const p = parseNationalId('29001011100031');
  assert.equal(p.ok, true);
  assert.equal(p.birthDate, '1990-01-01');
  assert.equal(p.sex, 'M');
  assert.equal(p.governorate, 'دمياط');
  assert.equal(parseNationalId('29013011100031').ok, false); // شهر 13
  assert.equal(parseNationalId('123').ok, false);
  assert.equal(parseNationalId('٢٩٠٠١٠١١١٠٠٠٤٢').sex, 'F'); // أرقام عربي
});

test('التفقيط', () => {
  assert.equal(amountInWords(12000), 'فقط مائة وعشرون جنيهًا لا غير');
  assert.equal(amountInWords(125050), 'فقط ألف ومائتان وخمسون جنيهًا وخمسون قرشًا لا غير');
  assert.equal(amountInWords(40000), 'فقط أربعمائة جنيه لا غير');
  assert.equal(amountInWords(300), 'فقط ثلاثة جنيهات لا غير');
});

test('ملف المريض: التحقق من البيانات', async () => {
  const r = await rec.post('/api/patients', { name: 'محمد أحمد', phone: '123' });
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.name);
  assert.ok(r.body.errors.phone);
  assert.ok(r.body.errors.ageYears);
  assert.ok(r.body.errors.sex);
});

test('ملف المريض: تسجيل وترقيم من 1 وبحث بالاسم والتليفون ورقم الملف', async () => {
  const r = await rec.post('/api/patients', P);
  assert.equal(r.status, 201);
  assert.equal(r.body.patient.no, 1);
  patientId = r.body.patient.id;
  const r2 = await rec.post('/api/patients', { name: 'فاطمة محمود السيد', phone: '01122233344', nationalId: '29505151100062' });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.patient.no, 2);
  assert.equal(r2.body.patient.sex, 'F');
  assert.equal(r2.body.patient.birthDate, '1995-05-15');
  // بحث بالاسم من غير همزات
  const s1 = await rec.get('/api/patients/search?q=' + encodeURIComponent('احمد علي'));
  assert.equal(s1.body.results[0].id, patientId);
  const s2 = await rec.get('/api/patients/search?q=' + encodeURIComponent('٠١٠١٢٣'));
  assert.equal(s2.body.results[0].id, patientId);
  const s3 = await rec.get('/api/patients/search?q=2');
  assert.equal(s3.body.results[0].no, 2);
});

test('ملف المريض: تنبيه التكرار (تليفون محتاج تأكيد، رقم قومي ممنوع)', async () => {
  const d = await rec.post('/api/patients', { ...P, name: 'سعاد أحمد علي حسن', sex: 'F' });
  assert.equal(d.status, 409);
  assert.equal(d.body.needsConfirm, true);
  assert.equal(d.body.duplicate.byPhone[0].no, 1);
  const ok = await rec.post('/api/patients', { ...P, name: 'سعاد أحمد علي حسن', sex: 'F', confirmDuplicatePhone: true });
  assert.equal(ok.status, 201);
  const n = await rec.post('/api/patients', { name: 'شخص تاني خالص', phone: '01099988877', nationalId: '29505151100062' });
  assert.equal(n.status, 409);
  assert.match(n.body.error, /ملف رقم 2/);
});

test('ملف المريض: التعديل بيتسجل بالقديم والجديد', async () => {
  const r = await rec.put('/api/patients/' + patientId, { ...P, address: 'دمياط - شارع الجلاء' });
  assert.equal(r.body.changed, 1);
  const f = await rec.get('/api/patients/' + patientId);
  assert.equal(f.body.edits[0].field, 'العنوان');
  assert.equal(f.body.edits[0].new, 'دمياط - شارع الجلاء');
});

test('طوارئ سريع: ملف بالاسم بس ومتعلّم ناقص', async () => {
  const r = await rec.post('/api/patients', { name: 'مجهول', mode: 'quick' });
  assert.equal(r.status, 201);
  assert.equal(r.body.patient.incomplete, true);
});

let visit;
test('زيارة عيادة: خدمة بدكتور لازم تختار الدكتور، والسعر والنسبة بيتحفظوا', async () => {
  const v = await rec.post('/api/visits', { patientId, type: 'clinic' });
  assert.equal(v.status, 201);
  visit = v.body.visit;
  const exam = services.find((s) => s.code === 'CL-001');
  const noDoc = await rec.post(`/api/visits/${visit.id}/items`, { serviceId: exam.id });
  assert.equal(noDoc.status, 400);
  const doctors = (await rec.get('/api/catalog/doctors')).body.doctors;
  const ahmed = doctors.find((d) => d.name.includes('أحمد'));
  const a = await rec.post(`/api/visits/${visit.id}/items`, { serviceId: exam.id, doctorId: ahmed.id });
  assert.equal(a.status, 201);
  const cbc = services.find((s) => s.code === 'LAB-001');
  const b = await rec.post(`/api/visits/${visit.id}/items`, { serviceId: cbc.id, qty: 2 });
  assert.equal(b.body.totals.total, 640);
  assert.equal(b.body.totals.due, 640);
  // نفس المريض ونفس النوع النهارده = نفس الزيارة
  const again = await rec.post('/api/visits', { patientId, type: 'clinic' });
  assert.equal(again.body.reused, true);
  assert.equal(again.body.visit.id, visit.id);
});

test('الدفع: المجموع لازم يساوي المطلوب، والخصم محتاج سبب ومدير', async () => {
  const d = (await rec.get('/api/visits/' + visit.id)).body;
  const ids = d.items.map((i) => i.id);
  assert.equal((await rec.post(`/api/visits/${visit.id}/pay`, { itemIds: ids, cash: 600 })).status, 400);
  const noReason = await rec.post(`/api/visits/${visit.id}/pay`, { itemIds: ids, discount: 40, cash: 600 });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /سبب/);
  const noMgr = await rec.post(`/api/visits/${visit.id}/pay`, { itemIds: ids, discount: 40, discountReason: 'قريب موظف', cash: 600 });
  assert.match(noMgr.body.error, /المدير/);
  const ok = await rec.post(`/api/visits/${visit.id}/pay`, {
    itemIds: ids, discount: 40, discountReason: 'قريب موظف', discountApprovedBy: managerId, cash: 500, card: 100,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.receipt.no, 1);
  assert.equal(ok.body.receipt.net, 600);
  assert.equal(ok.body.totals.due, 0);
  // نفس البنود ما تتدفعش مرتين
  assert.equal((await rec.post(`/api/visits/${visit.id}/pay`, { itemIds: ids, cash: 640 })).status, 409);
});

test('نسبة الدكتور اتحسبت على المبلغ بعد الخصم', async () => {
  // الكشف 400 من إجمالي 640 والخصم 40 => نصيب الكشف من الخصم 25 => الأساس 375 × 40% = 150
  const e = await ctx.db.query('SELECT * FROM DoctorEarnings');
  assert.equal(e.length, 1);
  assert.equal(Number(e[0].BaseAmount), 375);
  assert.equal(Number(e[0].Amount), 150);
});

test('الآجل محتاج موافقة مدير', async () => {
  const v = (await rec.post('/api/visits', { patientId, type: 'lab' })).body;
  const sugar = services.find((s) => s.code === 'LAB-002');
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: sugar.id })).body;
  const ids = d.items.map((i) => i.id);
  assert.equal((await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: ids, credit: 40 })).status, 400);
  const ok = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: ids, credit: 40, creditApprovedBy: managerId });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.receipt.credit, 40);
});

test('الطباعة: أول مرة أصل، وبعدها «نسخة»', async () => {
  const d = (await rec.get('/api/visits/' + visit.id)).body;
  const rid = d.receipts[0].id;
  const p1 = await rec.get('/print/receipt/' + rid);
  assert.equal(p1.status, 200);
  assert.ok(!p1.body.includes('class="stamp">نسخة'));
  assert.ok(p1.body.includes('فقط ستمائة جنيه لا غير'));
  const p2 = await rec.get('/print/receipt/' + rid);
  assert.ok(p2.body.includes('class="stamp">نسخة'));
});

test('إلغاء الإيصال: إيصال عكسي بالسالب، والبنود تتلغي، والنسبة تتعكس', async () => {
  const d = (await rec.get('/api/visits/' + visit.id)).body;
  const rid = d.receipts[0].id;
  assert.equal((await rec.post(`/api/receipts/${rid}/cancel`, {})).status, 400); // من غير سبب
  const c = await rec.post(`/api/receipts/${rid}/cancel`, { reason: 'الخدمة ما اتعملتش' });
  assert.equal(c.status, 201);
  const refund = c.body.receipts.find((x) => x.kind === 'refund');
  assert.equal(refund.net, -600);
  assert.equal(refund.cash, -500);
  assert.ok(c.body.items.every((i) => i.status === 'voided'));
  assert.equal(c.body.totals.paid, 0);
  const e = await ctx.db.one('SELECT SUM(Amount) AS S FROM DoctorEarnings');
  assert.equal(Number(e.S), 0);
  assert.equal((await rec.post(`/api/receipts/${rid}/cancel`, { reason: 'تاني' })).status, 409);
});

test('موظف الاستقبال ما يلغيش إيصال بعد تقفيل الوردية، والمشرف يقدر', async () => {
  const v = (await rec.post('/api/visits', { patientId, type: 'radiology' })).body;
  const x = services.find((s) => s.code === 'RAD-001');
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: x.id })).body;
  const p = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: d.items.map((i) => i.id), cash: 150 });
  await ctx.db.run('UPDATE Shifts SET ClosedAt = ? WHERE Id = (SELECT ShiftId FROM Receipts WHERE Id = ?)', [new Date(), p.body.receiptId]);
  const no = await rec.post(`/api/receipts/${p.body.receiptId}/cancel`, { reason: 'غلطة في الخدمة' });
  assert.equal(no.status, 403);
  const yes = await sup.post(`/api/receipts/${p.body.receiptId}/cancel`, { reason: 'غلطة في الخدمة' });
  assert.equal(yes.status, 201);
});

test('أرقام الإيصالات متسلسلة ومافيش تكرار حتى مع الدفع في نفس اللحظة', async () => {
  const x = services.find((s) => s.code === 'LAB-006');
  const vs = [];
  for (let k = 0; k < 6; k++) {
    const pr = (await rec.post('/api/patients', { name: `مريض تجربة رقم ${k} علي`, phone: '0100000000' + k, ageYears: 20, sex: 'M' })).body.patient;
    const v = (await rec.post('/api/visits', { patientId: pr.id, type: 'lab' })).body;
    const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: x.id })).body;
    vs.push([v.visit.id, d.items.map((i) => i.id)]);
  }
  const res = await Promise.all(vs.map(([vid, ids], k) => (k % 2 ? sup : rec).post(`/api/visits/${vid}/pay`, { itemIds: ids, cash: 60 })));
  assert.ok(res.every((r) => r.status === 201));
  const nos = res.map((r) => r.body.receipt.no).sort((a, b) => a - b);
  assert.equal(new Set(nos).size, 6);
  assert.equal(nos[5] - nos[0], 5);
});

test('الزيارات المفتوحة والملخص والصلاحيات', async () => {
  const v = (await rec.post('/api/visits', { patientId, type: 'emergency' })).body;
  const neb = services.find((s) => s.code === 'ER-002');
  await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: neb.id });
  const open = (await rec.get('/api/visits/open')).body.visits;
  const mine = open.find((x) => x.id === v.visit.id);
  assert.equal(mine.due, 75);
  assert.equal((await rec.post(`/api/visits/${v.visit.id}/close`)).status, 409);
  const sum = (await rec.get('/api/home/summary')).body;
  assert.ok(sum.today.visits >= 4);
  assert.ok(sum.shift.count >= 2);
  const reviewer = client((await login('review')).cookie);
  assert.equal((await reviewer.post('/api/visits', { patientId, type: 'clinic' })).status, 403);
});

test('يوم القاهرة: 24 ساعة (أو 23/25 مع التوقيت الصيفي)', () => {
  const { start, end } = cairoDayRange('2026-11-18');
  assert.equal(start.toISOString(), '2026-11-17T22:00:00.000Z');
  assert.equal((end - start) / 3600e3, 24);
});
