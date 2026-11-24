// اختبارات الشريحة 2: الإعدادات
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, rec;
async function login(username, password = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
function client(cookie) {
  const call = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: raw ? { cookie } : { 'content-type': 'application/json', cookie }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), raw: (u, buf) => call('POST', u, null, buf) };
}
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client((await login('manager')).cookie);
  rec = client((await login('reception')).cookie);
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('الإعدادات للمدير بس', async () => {
  assert.equal((await rec.get('/api/admin/services')).status, 403);
  assert.equal((await rec.get('/api/admin/users')).status, 403);
  assert.equal((await mgr.get('/api/admin/services')).status, 200);
});

test('خدمة جديدة: كود تلقائي، ومنع التكرار', async () => {
  const r = await mgr.post('/api/admin/services', { name: 'تحليل فيتامين د', dept: 'lab', payTiming: 'before', price: 450 });
  assert.equal(r.status, 201);
  assert.equal(r.body.service.code, 'LAB-012');
  assert.equal(r.body.service.price, 450);
  const d = await mgr.post('/api/admin/services', { name: 'تحليل فيتامين د', dept: 'lab', payTiming: 'before', price: 450 });
  assert.equal(d.status, 400);
  assert.ok(d.body.errors.name);
  const e = await mgr.post('/api/admin/services', { name: 'خدمة', dept: 'x' });
  assert.ok(e.body.errors.dept && e.body.errors.price && e.body.errors.payTiming);
});

test('تغيير السعر: بيسري فورًا، والبند القديم بسعره القديم، والتاريخ متسجل', async () => {
  const svcs = (await mgr.get('/api/admin/services')).body.services;
  const cbc = svcs.find((s) => s.code === 'LAB-001');
  const p = (await rec.post('/api/patients', { name: 'مريض تجربة الأسعار', phone: '01011111111', ageYears: 30, sex: 'M' })).body.patient;
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: cbc.id });
  const ch = await mgr.post(`/api/admin/services/${cbc.id}/price`, { price: 150 });
  assert.equal(ch.body.changed, true);
  assert.equal(ch.body.service.price, 150);
  const rsv = (await rec.get('/api/catalog/services')).body.services.find((s) => s.id === cbc.id);
  assert.equal(rsv.price, 150);
  const d = (await rec.get('/api/visits/' + v.visit.id)).body;
  assert.equal(d.items[0].unitPrice, 120);
  const h = (await mgr.get(`/api/admin/services/${cbc.id}/prices`)).body.prices;
  assert.equal(h[0].price, 150);
  assert.equal(h[1].price, 120);
  assert.equal((await mgr.post(`/api/admin/services/${cbc.id}/price`, { price: 150 })).body.changed, false);
});

test('وقف خدمة: بتختفي من الاستقبال', async () => {
  const s = (await mgr.get('/api/admin/services')).body.services.find((x) => x.code === 'LAB-005');
  const r = await mgr.put('/api/admin/services/' + s.id, { active: false });
  assert.equal(r.body.service.active, false);
  assert.ok(!(await rec.get('/api/catalog/services')).body.services.some((x) => x.id === s.id));
});

test('إكسل: تصدير ثم تعديل ثم استيراد (معاينة وتنفيذ)', async () => {
  const ex = await mgr.get('/api/admin/services/export');
  assert.equal(ex.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.body);
  const ws = wb.getWorksheet('الخدمات');
  assert.equal(ws.getCell('A1').value, 'الكود');
  // نغيّر سعر الكشف الاستشاري، ونضيف خدمة جديدة، وصف فيه غلط
  ws.eachRow((row, i) => { if (row.getCell(1).value === 'CL-001') row.getCell(4).value = 450; });
  ws.addRow(['', 'سونار ثدي', 'أشعة', '٥٠٠', 'قبل', 'نعم', 'لا', 'نعم']);
  ws.addRow(['', 'خدمة غلط', 'مطبخ', 'كتير']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await mgr.raw('/api/admin/services/import?mode=preview', buf);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.summary.update, 1);
  assert.equal(pv.body.summary.new, 1);
  assert.equal(pv.body.summary.error, 1);
  assert.match(pv.body.plan.find((x) => x.status === 'update').changes[0], /400 ← 450/);
  // المعاينة ما بتغيرش حاجة
  assert.equal((await mgr.get('/api/admin/services')).body.services.find((x) => x.code === 'CL-001').price, 400);
  const ap = await mgr.raw('/api/admin/services/import?mode=apply', buf);
  assert.deepEqual(ap.body.applied, { created: 1, updated: 1 });
  const list = (await mgr.get('/api/admin/services')).body.services;
  assert.equal(list.find((x) => x.code === 'CL-001').price, 450);
  const nw = list.find((x) => x.name === 'سونار ثدي');
  assert.equal(nw.code, 'RAD-010');
  assert.equal(nw.price, 500);
  assert.equal(nw.hasDoctor, true);
  // تاني مرة نفس الملف: مفيش تغيير
  const again = await mgr.raw('/api/admin/services/import?mode=preview', buf);
  assert.equal(again.body.summary.update + again.body.summary.new, 0);
  assert.equal((await mgr.raw('/api/admin/services/import?mode=preview', Buffer.from('not excel'))).status, 400);
});

test('الأطباء: مواعيد ونسب، والأولوية خدمة > قسم > عام', async () => {
  const svcs = (await mgr.get('/api/admin/services')).body.services;
  const exam = svcs.find((s) => s.code === 'CL-002'), sono = svcs.find((s) => s.code === 'CL-010'), rad = svcs.find((s) => s.code === 'RAD-003');
  const bad = await mgr.post('/api/admin/doctors', { name: 'د. تجربة', schedule: [{ weekday: 0, from: '10:00', to: '10:00' }], shares: { general: 120 } });
  assert.equal(bad.status, 400);
  const r = await mgr.post('/api/admin/doctors', {
    name: 'د. عمرو الحسيني', specialty: 'باطنة',
    schedule: [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, from: '00:00', to: '23:59' })),
    shares: { general: 40, depts: { radiology: 25 }, services: [{ serviceId: sono.id, pct: 30 }] },
  });
  assert.equal(r.status, 201);
  const doc = r.body.doctor;
  assert.equal(doc.schedule.length, 7);
  assert.equal(doc.shares.services[0].pct, 30);
  const docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  assert.equal(docs.find((d) => d.id === doc.id).presentNow, true);
  const p = (await rec.post('/api/patients', { name: 'مريض تجربة النسب', phone: '01022222222', ageYears: 40, sex: 'F' })).body.patient;
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'clinic' })).body;
  for (const s of [exam, sono, rad]) await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: s.id, doctorId: doc.id });
  const items = await ctx.db.query('SELECT ServiceId, DoctorPct FROM VisitItems WHERE VisitId = ?', [v.visit.id]);
  const pctOf = (s) => Number(items.find((i) => i.ServiceId === s.id).DoctorPct);
  assert.equal(pctOf(exam), 40);
  assert.equal(pctOf(sono), 30);
  assert.equal(pctOf(rad), 25);
  // تعديل: النسبة الجديدة للبنود الجديدة بس
  const u = await mgr.put('/api/admin/doctors/' + doc.id, { ...doc, shares: { general: 50 } });
  assert.equal(u.body.doctor.shares.general, 50);
  assert.equal(u.body.doctor.shares.services.length, 0);
  assert.equal(pctOf(exam), 40);
  // وقف الدكتور: يختفي من الاستقبال
  await mgr.put('/api/admin/doctors/' + doc.id, { ...u.body.doctor, active: false });
  assert.ok(!(await rec.get('/api/catalog/doctors')).body.doctors.some((d) => d.id === doc.id));
});

test('المستخدمين: إضافة ودخول، وقف الحساب بيقفل الجلسة، وحماية المدير', async () => {
  const c = await mgr.post('/api/admin/users', { username: 'Sara.Reception', name: 'سارة محمد', role: 'reception', password: 'abc123' });
  assert.equal(c.status, 201);
  assert.equal(c.body.user.username, 'sara.reception');
  assert.equal((await mgr.post('/api/admin/users', { username: 'sara.reception', name: 'x', role: 'reception', password: 'abc123' })).status, 400);
  const s = await login('sara.reception', 'abc123');
  assert.equal(s.status, 200);
  const sara = client(s.cookie);
  assert.equal((await sara.get('/api/me')).status, 200);
  await mgr.put('/api/admin/users/' + c.body.user.id, { active: false });
  assert.equal((await sara.get('/api/me')).status, 401);
  assert.equal((await login('sara.reception', 'abc123')).status, 401);
  const me = (await mgr.get('/api/me')).body.user;
  assert.equal((await mgr.put('/api/admin/users/' + me.id, { role: 'reception' })).status, 400);
  // تغيير كلمة السر بتاعتي: الجلسة الحالية تفضل شغالة
  assert.equal((await mgr.post('/api/me/password', { current: 'غلط', next: 'newpass1' })).status, 400);
  assert.equal((await mgr.post('/api/me/password', { current: 'Safa@2026', next: 'newpass1' })).status, 200);
  assert.equal((await mgr.get('/api/me')).status, 200);
  assert.equal((await login('manager', 'newpass1')).status, 200);
});

test('سجل التعديلات بيوضح تغيير الأسعار', async () => {
  const a = (await mgr.get('/api/admin/audit?group=settings')).body.entries;
  const pr = a.find((x) => x.action === 'service.price' && x.text.includes('صورة دم'));
  assert.ok(pr);
  assert.match(pr.text, /120 ← 150/);
  assert.ok(a.some((x) => x.action === 'service.import'));
});
