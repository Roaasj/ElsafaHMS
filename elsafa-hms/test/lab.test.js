// اختبارات المرحلة 2 / شريحة المعمل
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { pickRange, flagFor, refTextFor } from '../src/routes/lab.js';
import { code128Svg } from '../src/lib/barcode.js';

let ctx, base, rec, mgr, lab, rad, svc, docs;
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
async function labVisit(codes, { sex = 'M', age = 40, pay = true } = {}) {
  n++;
  const p = (await rec.post('/api/patients', { name: `مريض معمل رقم ${n} عادل`, phone: `0108888${String(n).padStart(4, '0')}`, ageYears: age, sex, confirmDuplicatePhone: true })).body.patient;
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body.visit;
  let d;
  for (const c of codes) d = (await rec.post(`/api/visits/${v.id}/items`, { serviceId: svc[c].id })).body;
  if (pay) await rec.post(`/api/visits/${v.id}/pay`, { itemIds: d.items.filter((i) => !i.paid).map((i) => i.id), cash: d.totals.due });
  return { p, v, gkey: 'V' + v.id, items: d.items };
}
const valuesFor = (t, map) => ({ key: t.key, values: t.values.filter((x) => x.kind !== 'header').map((x) => ({ paramId: x.paramId, name: x.name, value: map[x.name] ?? '' })) });

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }); // الاختبارات القديمة: الاستقبال بيضيف البنود
  lab = client(await login('lab'));
  rad = client(await login('radio'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('المعدلات: حسب النوع والسن، والعلامات عالي/واطي/غير طبيعي، والباركود', () => {
  const hb = { Kind: 'num', Decimals: 1, Ranges: JSON.stringify([{ s: '', a0: 0, a1: 12, lo: 11, hi: 14.5 }, { s: 'M', lo: 13.5, hi: 17.5 }, { s: 'F', lo: 12, hi: 15.5 }]) };
  assert.equal(pickRange(JSON.parse(hb.Ranges), 'M', 40).lo, 13.5);
  assert.equal(pickRange(JSON.parse(hb.Ranges), 'F', 30).hi, 15.5);
  assert.equal(pickRange(JSON.parse(hb.Ranges), 'M', 5).lo, 11);
  assert.equal(refTextFor(hb, 'F', 30), '12.0 – 15.5');
  assert.equal(flagFor(hb, '12.9', 'M', 40), 'L');
  assert.equal(flagFor(hb, '12.9', 'F', 40), null);
  assert.equal(flagFor(hb, '١٨', 'M', 40), 'H');
  assert.equal(flagFor({ Kind: 'select', NormalText: 'Negative' }, 'Positive'), 'A');
  assert.equal(flagFor({ Kind: 'num', Ranges: JSON.stringify([{ hi: 200 }]) }, '250'), 'H');
  assert.match(code128Svg('100123'), /^<svg[\s\S]+<rect/);
});

test('قايمة الشغل: المدفوع بس، متجمّع بالمريض، والتحاليل الافتراضية مربوطة بالخدمات', async () => {
  const a = await labVisit(['LAB-001', 'LAB-003']);
  const b = await labVisit(['LAB-004'], { pay: false });
  const wl = (await lab.get('/api/lab?group=waiting')).body;
  const g = wl.groups.find((x) => x.gkey === a.gkey);
  assert.equal(g.tests.length, 2);
  assert.ok(g.tests.every((t) => t.testId && t.status === 'waiting'));
  assert.ok(!wl.groups.some((x) => x.gkey === b.gkey));
  const tests = (await lab.get('/api/lab/tests')).body;
  assert.ok(tests.tests.length >= 25);
  assert.ok(tests.services.find((s) => s.code === 'LAB-001').testId);
  assert.equal((await rad.get('/api/lab')).status, 403);
});

test('سحب ← رقم عينة واحد وملصقات ← النتايج والعلامات ← طباعة ← تسليم', async () => {
  const { gkey, p } = await labVisit(['LAB-001', 'LAB-002', 'LAB-007'], { sex: 'F', age: 30 });
  assert.equal((await lab.post(`/api/lab/g/${gkey}/results`, { tests: [{ key: 'v1', values: [] }] })).status, 404);
  const c = (await lab.post(`/api/lab/g/${gkey}/collect`)).body;
  assert.ok(c.accNo > 100000);
  assert.ok(c.tests.every((t) => t.status === 'collected' && t.accNo === c.accNo && t.dueAt));
  const lbl = (await lab.get(`/print/lab-labels/${gkey}`)).body.toString();
  assert.ok(lbl.includes(String(c.accNo)) && lbl.includes('<svg'));
  assert.equal((await lab.post(`/api/lab/g/${gkey}/collect`)).status, 409);
  const cbc = c.tests.find((t) => t.code === 'CBC');
  const fbs = c.tests.find((t) => t.code === 'FBS');
  const tsh = c.tests.find((t) => t.code === 'TSH');
  assert.equal(cbc.values.find((v) => v.name === 'Hemoglobin').refText, '12.0 – 15.5');
  // مسودة
  const dr = (await lab.post(`/api/lab/g/${gkey}/results`, { tests: [valuesFor(cbc, { Hemoglobin: '10.2', WBCs: '7.5', Platelets: '250' })] })).body;
  const cbc2 = dr.tests.find((t) => t.code === 'CBC');
  assert.equal(cbc2.status, 'collected');
  assert.equal(cbc2.values.find((v) => v.name === 'Hemoglobin').value, '10.2');
  // نهائي (الاعتماد مش مطلوب افتراضيًا ← جاهزة على طول)
  const fin = (await lab.post(`/api/lab/g/${gkey}/results`, { final: true, tests: [
    valuesFor(cbc2, { Hemoglobin: '10.2', WBCs: '7.5', Platelets: '250', Neutrophils: '60' }),
    valuesFor(fbs, { 'Fasting blood glucose': '١٣٥' }),
  ] })).body;
  const f1 = fin.tests.find((t) => t.code === 'CBC');
  assert.equal(f1.status, 'verified');
  assert.equal(f1.values.find((v) => v.name === 'Hemoglobin').flag, 'L');
  assert.equal(fin.tests.find((t) => t.code === 'FBS').values[0].flag, 'H');
  assert.equal(fin.tests.find((t) => t.code === 'FBS').values[0].value, '135');
  assert.equal(fin.tests.find((t) => t.code === 'TSH').status, 'collected');
  // فاضي مش مسموح نهائي
  assert.equal((await lab.post(`/api/lab/g/${gkey}/results`, { final: true, tests: [valuesFor(tsh, {})] })).status, 400);
  const pr = (await rec.get(`/print/lab/${gkey}`)).body.toString();
  assert.ok(pr.includes(p.name) && pr.includes('Hemoglobin') && pr.includes('HEMATOLOGY') && !pr.includes('مبدئية'));
  // التسليم من الاستقبال للجاهز بس
  const dl = (await rec.post(`/api/lab/g/${gkey}/deliver`, {})).body;
  assert.equal(dl.tests.filter((t) => t.status === 'delivered').length, 2);
  assert.equal(dl.tests.find((t) => t.code === 'TSH').status, 'collected');
  assert.equal((await rec.post(`/api/lab/g/${gkey}/results`, { tests: [] })).status, 403);
  // تعديل بعد التسليم للمدير بس
  assert.equal((await lab.post(`/api/lab/g/${gkey}/results`, { final: true, tests: [valuesFor(f1, { Hemoglobin: '10.5' })] })).status, 409);
  assert.equal((await mgr.post(`/api/lab/g/${gkey}/results`, { final: true, tests: [valuesFor(f1, { Hemoglobin: '10.5' })] })).status, 200);
});

test('الاعتماد لما يتفعّل: النتيجة بتستنى دكتور المعمل، والطباعة «مبدئية»', async () => {
  const set = await mgr.put('/api/admin/lab-settings', { labVerify: true });
  assert.equal(set.status, 200);
  const { gkey } = await labVisit(['LAB-004']);
  const c = (await lab.post(`/api/lab/g/${gkey}/collect`)).body;
  const kft = c.tests[0];
  const r = (await lab.post(`/api/lab/g/${gkey}/results`, { final: true, tests: [valuesFor(kft, { Urea: '30', Creatinine: '1.0', 'Uric acid': '5' })] })).body;
  assert.equal(r.tests[0].status, 'done');
  assert.match((await lab.get(`/print/lab/${gkey}`)).body.toString(), /مبدئية/);
  assert.equal((await rec.post(`/api/lab/g/${gkey}/deliver`)).status, 409);
  const v = (await lab.post(`/api/lab/g/${gkey}/verify`)).body;
  assert.equal(v.tests[0].status, 'verified');
  assert.equal(v.tests[0].verifiedBy, 'د. ريهام عبد السلام');
  await mgr.put('/api/admin/lab-settings', { labVerify: false });
});

test('المعمل الخارجي: اتبعت ← النتيجة PDF ← جاهزة، والرجوع خطوة', async () => {
  const { gkey } = await labVisit(['LAB-011']);
  const c = (await lab.post(`/api/lab/g/${gkey}/collect`)).body;
  const t = c.tests[0];
  assert.equal(t.external, true);
  const s = (await lab.post(`/api/lab/w/${t.key}/send`, {})).body;
  assert.equal(s.tests[0].status, 'sent');
  assert.equal(s.tests[0].sentTo, 'معمل البرج (خارجي)');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
  const up = await lab.raw(`/api/lab/w/${t.key}/file`, 'application/pdf', pdf);
  assert.equal(up.status, 201);
  assert.equal(up.body.tests[0].status, 'verified');
  assert.equal((await rec.get(`/print/lab/${gkey}`)).status, 302);
  // رجوع
  const { gkey: g2 } = await labVisit(['LAB-006']);
  const c2 = (await lab.post(`/api/lab/g/${g2}/collect`)).body;
  assert.equal((await lab.post(`/api/lab/w/${c2.tests[0].key}/undo`, {})).status, 400);
  const u = (await lab.post(`/api/lab/w/${c2.tests[0].key}/undo`, { reason: 'اتسحبت بالغلط' })).body;
  assert.equal(u.tests[0].status, 'waiting');
  assert.equal(u.tests[0].accNo, null);
});

test('تعديل التحاليل: بنود ومعدلات جديدة، والتحقق، وتحليل الدخول بيظهر', async () => {
  const all = (await lab.get('/api/lab/tests')).body;
  const crp = all.tests.find((t) => t.code === 'CRP');
  assert.equal((await rec.put(`/api/lab/tests/${crp.id}`, crp)).status, 403);
  const bad = await lab.post('/api/lab/tests', { name: '', code: '', section: 'x', sample: 'y', params: [] });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.name && bad.body.errors.code && bad.body.errors.params);
  const dup = await lab.post('/api/lab/tests', { name: 'x', code: 'CRP', section: 'serology', sample: 'serum', params: [{ name: 'a' }] });
  assert.equal(dup.body.errors.code, 'الكود ده مستخدم لتحليل تاني');
  const ed = await lab.put(`/api/lab/tests/${crp.id}`, { ...crp, params: [{ ...crp.params[0], ranges: [{ s: '', lo: 0, hi: 6 }] }, { name: 'Comment', kind: 'text' }] });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.test.params.length, 2);
  assert.equal(ed.body.test.params[0].ranges[0].hi, 6);
  // مريض داخلي
  const p = (await rec.post('/api/patients', { name: 'مريض داخلي معمل حسن', phone: '01099988866', nationalId: '29001011234562', address: 'دمياط', emergencyName: 'أخوه', emergencyPhone: '01011112224', sex: 'M' })).body.patient;
  const board = (await rec.get('/api/admissions/beds/board')).body;
  let bed;
  for (const f of board.floors) for (const r of f.rooms) for (const x of r.beds) if (!bed && x.status === 'free' && r.cls.kind === 'ward' && r.cls.nightPrice) bed = { x, r };
  const a = (await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.x.id, doctorId: docs[0].id, deposit: bed.r.cls.deposit, cash: bed.r.cls.deposit })).body;
  await rec.post(`/api/admissions/${a.admission.id}/items`, { serviceId: svc['LAB-010'].id });
  const wl = (await lab.get('/api/lab?group=waiting')).body.groups;
  const g = wl.find((x) => x.admissionId === a.admission.id);
  assert.ok(g && g.bed && g.tests[0].code === 'CRP');
});
