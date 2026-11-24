// الشريحة 1: التشخيص إجباري عند الدخول، المبدئي بمهلة، والتعديل للاستقبال بس
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, rec, mgr, docs, board;
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
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b) };
}
const fullPatient = (n, nid) => ({ name: `مريض التشخيص رقم ${n} علي`, phone: `0102234${String(n).padStart(4, '0')}`, nationalId: nid, address: 'دمياط', emergencyName: 'أخوه', emergencyPhone: '01099999999' });
const freeBed = (i) => board.floors.flatMap((f) => f.rooms).filter((r) => r.beds.length && r.no !== undefined).flatMap((r) => r.beds).filter((b) => b.status === 'free' && b.cls?.name === 'عادية')[i];

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  board = (await rec.get('/api/admissions/beds/board')).body;
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

async function admit(n, extra) {
  const p = (await rec.post('/api/patients', fullPatient(n, `2850101110${String(n).padStart(4, '0')}`))).body.patient;
  const bed = freeBed(n);
  const cls = (await mgr.get('/api/admin/rooms')).body.classes.find((c) => c.name === 'عادية');
  return rec.post('/api/admissions', { patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit, ...extra });
}

test('الدخول من غير تشخيص مرفوض، ومعاه تشخيص بيتسجل', async () => {
  const no = await admit(1, {});
  assert.equal(no.status, 400);
  assert.ok(no.body.errors?.diagnosis);
  const ok = await admit(5, { diagnosis: 'التهاب رئوي' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const a = (await rec.get(`/api/admissions/${ok.body.admission?.id ?? ok.body.id}`)).body.admission;
  assert.equal(a.diagnosis, 'التهاب رئوي');
  assert.equal(a.diagnosisProvisional, false);
});

test('المبدئي: بيدخل، ولو المهلة عدّت الخروج بيتمنع لحد التحويل لنهائي', async () => {
  const r = await admit(2, { diagnosis: 'ألم صدر؟', diagnosisProvisional: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.admission?.id ?? r.body.id;
  let a = (await rec.get(`/api/admissions/${id}`)).body.admission;
  assert.equal(a.diagnosisProvisional, true);
  assert.equal(a.diagnosisOverdue, false);
  await ctx.db.run('UPDATE Admissions SET AdmittedAt = ? WHERE Id = ?', [new Date(Date.now() - 25 * 3600e3), id]);
  a = (await rec.get(`/api/admissions/${id}`)).body.admission;
  assert.equal(a.diagnosisOverdue, true);
  const out = await rec.post(`/api/admissions/${id}/discharge`, { note: 'x' });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /مبدئي/);
  const fix = await rec.put(`/api/admissions/${id}/diagnosis`, { diagnosis: 'احتشاء عضلة القلب' });
  assert.equal(fix.status, 200);
  a = (await rec.get(`/api/admissions/${id}`)).body.admission;
  assert.equal(a.diagnosisProvisional, false);
  assert.equal(a.diagnosisOverdue, false);
  const logs = await ctx.db.query("SELECT 1 FROM AuditLog WHERE Action = 'admission.diagnosis' AND EntityId = ?", [id]);
  assert.equal(logs.length, 1);
});

test('تعديل التشخيص للاستقبال بس، ومينفعش يتمسح', async () => {
  const r = await admit(3, { diagnosis: 'كسر' });
  const id = r.body.admission?.id ?? r.body.id;
  const doc = client(await login('doctor').catch(() => ''));
  const d = await doc.put(`/api/admissions/${id}/diagnosis`, { diagnosis: 'غيره' });
  assert.ok([401, 403].includes(d.status));
  const clr = await rec.put(`/api/admissions/${id}/diagnosis`, { diagnosis: '' });
  assert.equal(clr.status, 400);
});

test('قايمة التشخيصات: بحث، والإعدادات بتتحقق', async () => {
  const all = (await rec.get('/api/admissions/diagnoses')).body.diagnoses;
  assert.ok(all.length >= 40);
  const q = (await rec.get('/api/admissions/diagnoses?q=' + encodeURIComponent(all[0].slice(0, 3)))).body.diagnoses;
  assert.ok(q.includes(all[0]));
  const bad = await mgr.put('/api/config/settings', { values: { dxProvisionalHours: '0' } });
  assert.equal(bad.status, 400);
  const good = await mgr.put('/api/config/settings', { values: { dxRequired: '0' } });
  assert.equal(good.status, 200);
  const free = await admit(4, {});
  assert.equal(free.status, 201);
  await mgr.put('/api/config/settings', { values: { dxRequired: '1' } });
});
