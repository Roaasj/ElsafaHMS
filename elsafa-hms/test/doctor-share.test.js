// نصيب الدكتور على الخدمة والعيادة (نسبة أو مبلغ ثابت) فوق صفوف الدكتور (استثناء)، وإثبات إن الأعمدة الجديدة صفر في سيناريو الـbaseline
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { resolveDoctorShare } from '../src/routes/catalog.js';

let ctx, base, mgr, rec, doc, svc, n = 0;
const login = async (u) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
const call = (cookie) => async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = call(await login('manager')); rec = call(await login('reception'));
  doc = await ctx.db.one('SELECT * FROM Doctors ORDER BY Id');
  svc = await ctx.db.one("SELECT * FROM Services WHERE Code = 'CL-001'");
  await ctx.db.run('DELETE FROM DoctorShares WHERE DoctorId = ?', [doc.Id]); // الدكتور من غير استثناءات
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

async function sell({ discount = 0 } = {}) {
  n++;
  const p = await rec('POST', '/api/patients', { name: `مريض نصيب رقم ${n} الثالث`, phone: '0100000' + String(1000 + n), ageYears: 30, sex: 'M' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const v = await rec('POST', '/api/visits', { patientId: p.body.patient.id, type: 'clinic' });
  const it = await rec('POST', `/api/visits/${v.body.visit.id}/items`, { serviceId: svc.Id, doctorId: doc.Id });
  assert.equal(it.status, 201, JSON.stringify(it.body));
  const d = (await rec('GET', '/api/visits/' + v.body.visit.id)).body;
  const total = d.totals.total;
  const body = { itemIds: d.items.map((i) => i.id), cash: total - discount };
  if (discount) { const m = (await mgr('GET', '/api/admin/users')).body.users.find((u) => u.username === 'manager'); Object.assign(body, { discount, discountReason: 'اختبار', discountApprovedBy: m.id }); }
  const pay = await rec('POST', `/api/visits/${v.body.visit.id}/pay`, body);
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const e = await ctx.db.query('SELECT * FROM DoctorEarnings WHERE VisitItemId = ?', [d.items[0].id]);
  return { total, e, visitId: v.body.visit.id, receiptId: pay.body.receipt.id };
}

test('من غير أي نصيب: صفر (زي الأول بالظبط)', async () => {
  assert.deepEqual(await resolveDoctorShare(ctx.db, doc.Id, svc.Id, svc.Dept), { pct: 0, fixed: 0 });
  assert.equal((await sell()).e.length, 0);
});

test('نسبة على الخدمة بتنطبق على أي دكتور، والخصم بيتحسب فيها', async () => {
  assert.equal((await mgr('PUT', `/api/admin/services/${svc.Id}/share`, { sharePct: 20 })).status, 200);
  const r = await sell({ discount: 40 });
  assert.equal(r.e.length, 1);
  assert.equal(Number(r.e[0].Pct), 20);
  assert.equal(Number(r.e[0].Amount), Math.round(((r.total - 40) * 20) / 100 * 100) / 100);
});

test('مبلغ ثابت على الخدمة: مش بيتأثر بالخصم، ويتضرب في العدد، والإلغاء بيعكسه', async () => {
  assert.equal((await mgr('PUT', `/api/admin/services/${svc.Id}/share`, { shareFixed: 75 })).status, 200);
  const r = await sell({ discount: 40 });
  assert.equal(r.e.length, 1);
  assert.equal(Number(r.e[0].Amount), 75);
  assert.equal(Number(r.e[0].Pct), 0);
  assert.equal((await rec('POST', `/api/receipts/${r.receiptId}/cancel`, { reason: 'اختبار' })).status, 201);
  const s = await ctx.db.one('SELECT SUM(Amount) AS S FROM DoctorEarnings WHERE VisitItemId = ?', [r.e[0].VisitItemId]);
  assert.equal(Number(s.S), 0);
});

test('نسبة ومبلغ مع بعض مرفوض، والمسح بيرجّع لصفر', async () => {
  const bad = await mgr('PUT', `/api/admin/services/${svc.Id}/share`, { sharePct: 10, shareFixed: 5 });
  assert.equal(bad.status, 400);
  assert.equal((await mgr('PUT', `/api/admin/services/${svc.Id}/share`, { sharePct: '', shareFixed: '' })).status, 200);
  assert.deepEqual(await resolveDoctorShare(ctx.db, doc.Id, svc.Id, svc.Dept), { pct: 0, fixed: 0 });
});

test('نسبة العيادة الافتراضية بتشتغل لو الخدمة من غير نصيب، ونصيب الخدمة يكسب عليها', async () => {
  const clinic = (await mgr('GET', '/api/admin/clinics')).body.clinics.find((c) => c.id === doc.ClinicId);
  assert.ok(clinic, 'الدكتور مربوط بعيادة');
  assert.equal((await mgr('PUT', '/api/admin/clinics/' + clinic.id, { name: clinic.name, storeId: clinic.storeId, active: true, sharePct: 15 })).status, 200);
  assert.deepEqual(await resolveDoctorShare(ctx.db, doc.Id, svc.Id, svc.Dept), { pct: 15, fixed: 0 });
  await mgr('PUT', `/api/admin/services/${svc.Id}/share`, { sharePct: 25 });
  assert.deepEqual(await resolveDoctorShare(ctx.db, doc.Id, svc.Id, svc.Dept), { pct: 25, fixed: 0 });
});

test('صف الدكتور (استثناء) بيكسب على نصيب الخدمة والعيادة', async () => {
  await ctx.db.insert('DoctorShares', { DoctorId: doc.Id, ServiceId: null, Dept: null, Pct: 60 });
  assert.deepEqual(await resolveDoctorShare(ctx.db, doc.Id, svc.Id, svc.Dept), { pct: 60, fixed: 0 });
  await ctx.db.run('DELETE FROM DoctorShares WHERE DoctorId = ?', [doc.Id]);
});
