// اختبارات المرحلة 2 / شريحة الأشعة: قايمة الشغل، التقارير بالقوالب، المقطعية برة، التسليم
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { cleanHtml, modalityOf } from '../src/routes/radiology.js';

let ctx, base, rec, mgr, rad, cas, svc, docs;
async function login(u, p = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: raw ? { 'content-type': raw.type, cookie } : { 'content-type': 'application/json', cookie }, body: raw ? raw.data : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), raw: (u, type, data) => call('POST', u, null, { type, data }) };
}
let n = 0;
async function radVisit(code, { pay = true } = {}) {
  n++;
  const p = (await rec.post('/api/patients', { name: `مريض أشعة رقم ${n} سيد`, phone: `0107777${String(n).padStart(4, '0')}`, ageYears: 40, sex: 'F', confirmDuplicatePhone: true })).body.patient;
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'radiology' })).body.visit;
  const s = svc[code];
  const d = (await rec.post(`/api/visits/${v.id}/items`, { serviceId: s.id, doctorId: s.hasDoctor ? docs[0].id : undefined })).body;
  const item = d.items.at(-1);
  if (pay) await rec.post(`/api/visits/${v.id}/pay`, { itemIds: [item.id], cash: d.totals.due });
  return { p, v, item, key: 'v' + item.id };
}

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }); // الاختبارات القديمة: الاستقبال بيضيف البنود
  rad = client(await login('radio'));
  cas = client(await login('cashier'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('نوع الجهاز من الاسم، وتنضيف HTML التقرير', () => {
  assert.equal(modalityOf('سونار بطن وحوض'), 'us');
  assert.equal(modalityOf('أشعة مقطعية على المخ'), 'ct');
  assert.equal(modalityOf('رنين مغناطيسي'), 'mri');
  assert.equal(modalityOf('أشعة عادية صدر'), 'xray');
  assert.equal(modalityOf('أي حاجة', 'mammo'), 'mammo');
  const h = cleanHtml('<p onclick="x" dir="ltr">ok <b>b</b></p><script>alert(1)</script><img src=x onerror=y><a href="javascript:1">z</a> 3 < 5');
  assert.equal(h, '<p dir="ltr">ok <b>b</b></p>z 3 &lt; 5');
});

test('قايمة الشغل: المدفوع بس، والقوالب الافتراضية موجودة', async () => {
  const paid = await radVisit('RAD-003');
  const unpaid = await radVisit('RAD-007', { pay: false });
  const wl = (await rad.get('/api/radiology?group=waiting')).body;
  assert.ok(wl.rows.some((x) => x.key === paid.key && x.modality === 'us' && x.status === 'waiting'));
  assert.ok(!wl.rows.some((x) => x.key === unpaid.key));
  assert.equal((await rad.post(`/api/radiology/${unpaid.key}/done`)).status, 409);
  const t = (await rad.get('/api/radiology/templates')).body.templates;
  assert.ok(t.filter((x) => x.modality === 'us').length >= 6);
  assert.equal((await cas.get('/api/radiology')).status, 403);
});

test('سونار: اتعمل ← مسودة ← اعتماد ← طباعة ← تسليم من الاستقبال', async () => {
  const { key, p } = await radVisit('RAD-003');
  // التقرير قبل الفحص ممنوع
  assert.equal((await rad.post(`/api/radiology/${key}/report`, { html: '<p>x</p>' })).status, 409);
  const d = (await rad.post(`/api/radiology/${key}/done`, { clinicalInfo: 'ألم بالبطن' })).body.study;
  assert.equal(d.status, 'done');
  assert.ok(d.studyNo > 0 && d.dueAt);
  assert.equal(d.group, 'report');
  // الاستقبال مينفعش يكتب تقرير ولا يسلّم قبل الاعتماد
  assert.equal((await rec.post(`/api/radiology/${key}/report`, { html: '<p>x</p>' })).status, 403);
  assert.equal((await rec.post(`/api/radiology/${key}/deliver`)).status, 409);
  const tpl = (await rad.get('/api/radiology/templates')).body.templates.find((x) => x.modality === 'us');
  const dr = (await rad.post(`/api/radiology/${key}/report`, { html: tpl.body + '<script>x</script>', title: tpl.title })).body.study;
  assert.equal(dr.status, 'done');
  assert.ok(dr.draft && !dr.reportHtml.includes('script'));
  const pr0 = await rad.get(`/print/rad/${key}`);
  assert.match(pr0.body.toString(), /مسودة/);
  const fin = (await rad.post(`/api/radiology/${key}/report`, { html: tpl.body, title: tpl.title, final: true })).body.study;
  assert.equal(fin.status, 'reported');
  assert.equal(fin.radiologist, 'د. سامح الشناوي');
  assert.equal(fin.group, 'ready');
  const pr = (await rec.get(`/print/rad/${key}`)).body.toString();
  assert.ok(pr.includes(p.name) && pr.includes('ULTRASOUND') && !pr.includes('مسودة'));
  const dl = (await rec.post(`/api/radiology/${key}/deliver`, {})).body.study;
  assert.equal(dl.status, 'delivered');
  assert.equal(dl.deliveredTo, p.name);
  assert.equal((await rec.post(`/api/radiology/${key}/deliver`)).status, 409);
  // تعديل بعد التسليم للمدير بس
  assert.equal((await rad.post(`/api/radiology/${key}/report`, { html: '<p>x</p>', final: true })).status, 409);
  assert.equal((await mgr.post(`/api/radiology/${key}/report`, { html: '<p>تعديل</p>', final: true, radiologist: 'د. سامح الشناوي' })).status, 200);
  const today = (await rec.get('/api/radiology?group=delivered')).body.rows;
  assert.ok(today.some((x) => x.key === key));
  const pat = (await rec.get(`/api/radiology/patient/${p.id}`)).body.rows;
  assert.equal(pat[0].status, 'delivered');
});

test('مقطعية: اتبعتت لدكتور برة، والتقرير بيرجع ملف أو لينك، والمتأخر بيتعلّم', async () => {
  const { key } = await radVisit('RAD-009');
  await rad.post(`/api/radiology/${key}/done`);
  const s = (await rad.post(`/api/radiology/${key}/sent`, { to: 'د. هشام (أونلاين)' })).body.study;
  assert.equal(s.status, 'sent');
  assert.equal(s.external, true);
  assert.equal((await rad.post(`/api/radiology/${key}/link`, { link: 'ftp://x' })).status, 400);
  // ملف مش مسموح
  assert.equal((await rad.raw(`/api/radiology/${key}/file`, 'text/plain', Buffer.alloc(100))).status, 400);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
  const up = await rad.raw(`/api/radiology/${key}/file?final=1&radiologist=${encodeURIComponent('د. هشام')}`, 'application/pdf', pdf);
  assert.equal(up.status, 201);
  assert.equal(up.body.study.status, 'reported');
  assert.equal(up.body.study.hasFile, true);
  const f = await rec.get(`/api/radiology/${key}/file`);
  assert.equal(f.headers.get('content-type'), 'application/pdf');
  // الطباعة بتفتح الملف
  const pr = await rec.get(`/print/rad/${key}`);
  assert.equal(pr.status, 302);
  // لينك
  const b = await radVisit('RAD-004');
  await rad.post(`/api/radiology/${b.key}/done`);
  const l = (await rad.post(`/api/radiology/${b.key}/link`, { link: 'https://teleradiology.example/r/55', final: true })).body.study;
  assert.equal(l.status, 'reported');
  assert.equal(l.link, 'https://teleradiology.example/r/55');
  // المتأخر: الوقت المتوقع عدّى
  const c = await radVisit('RAD-009');
  await rad.post(`/api/radiology/${c.key}/done`);
  await ctx.db.run('UPDATE RadStudies SET DueAt = ? WHERE VisitItemId = ?', [new Date(Date.now() - 3600e3), Number(c.key.slice(1))]);
  const wl = (await rad.get('/api/radiology?group=report')).body;
  assert.equal(wl.rows[0].key, c.key);
  assert.ok(wl.rows[0].overdue && wl.counts.overdue >= 1);
});

test('عادية: تتسلم من غير تقرير، والرجوع خطوة بسبب، والدخول بيظهر في القايمة', async () => {
  const { key } = await radVisit('RAD-001');
  await rad.post(`/api/radiology/${key}/done`);
  assert.equal((await rad.get(`/api/radiology/${key}`)).body.study.group, 'ready');
  assert.equal((await rad.post(`/api/radiology/${key}/undo`, {})).status, 400);
  const u = (await rad.post(`/api/radiology/${key}/undo`, { reason: 'اتعلّم بالغلط' })).body.study;
  assert.equal(u.status, 'waiting');
  await rad.post(`/api/radiology/${key}/done`);
  assert.equal((await rec.post(`/api/radiology/${key}/deliver`, { to: 'جوزها' })).body.study.deliveredTo, 'جوزها');
  // مريض داخلي: سونار من حساب الإقامة
  const p = (await rec.post('/api/patients', { name: 'مريض داخلي أشعة محمود', phone: '01099988877', nationalId: '29001011234561', address: 'دمياط', emergencyName: 'أخوه', emergencyPhone: '01011112223', sex: 'M' })).body.patient;
  const board = (await rec.get('/api/admissions/beds/board')).body;
  let bed;
  for (const f of board.floors) for (const r of f.rooms) for (const x of r.beds) if (!bed && x.status === 'free' && r.cls.kind === 'ward' && r.cls.nightPrice) bed = { x, r };
  const a = (await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.x.id, doctorId: docs[0].id, deposit: bed.r.cls.deposit, cash: bed.r.cls.deposit })).body;
  const ai = (await rec.post(`/api/admissions/${a.admission.id}/items`, { serviceId: svc['RAD-003'].id, doctorId: docs[0].id })).body;
  const it = ai.items.find((x) => x.name === svc['RAD-003'].name);
  const wl = (await rad.get('/api/radiology?group=waiting&mod=us')).body.rows;
  const row = wl.find((x) => x.key === 'a' + it.id);
  assert.ok(row && row.bed && row.admissionNo === a.admission.no);
});

test('القوالب: المدير ودكتور الأشعة بس، والتحقق', async () => {
  assert.equal((await rec.post('/api/radiology/templates', { name: 'x', modality: 'us', body: '<p>x</p>' })).status, 403);
  const bad = await rad.post('/api/radiology/templates', { name: '', modality: 'zz', body: '' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.name && bad.body.errors.modality && bad.body.errors.body);
  const ok = await rad.post('/api/radiology/templates', { name: 'كبد دهني', modality: 'us', title: 'US ABDOMEN', body: '<p><b>Liver:</b> bright</p>' });
  assert.equal(ok.status, 201);
  const ed = await mgr.put(`/api/radiology/templates/${ok.body.template.id}`, { ...ok.body.template, active: false });
  assert.equal(ed.body.template.active, false);
  assert.ok(!(await rad.get('/api/radiology/templates')).body.templates.some((x) => x.id === ok.body.template.id));
  assert.ok((await rad.get('/api/radiology/templates?all=1')).body.templates.some((x) => x.id === ok.body.template.id));
});
