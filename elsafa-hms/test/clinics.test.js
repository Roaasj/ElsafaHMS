// R1b-1: العيادات، النقل التلقائي من التخصصات، ومخزن لكل عيادة
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, rec;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const call = (cookie) => async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = call(await login('manager'));
  rec = call(await login('reception'));
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('النقل التلقائي: عيادة لكل تخصص، والأطباء اتربطوا، ولكل عيادة مخزنها', async () => {
  const c = (await mgr('GET', '/api/admin/clinics')).body.clinics;
  const specs = new Set((await mgr('GET', '/api/admin/doctors')).body.doctors.map((d) => d.specialty).filter(Boolean));
  assert.equal(c.length, specs.size);
  assert.ok(c.every((x) => x.storeId && x.storeName));
  const docs = (await mgr('GET', '/api/admin/doctors')).body.doctors.filter((d) => d.specialty);
  assert.ok(docs.every((d) => d.clinicId && c.find((x) => x.id === d.clinicId).name === d.specialty));
});

test('عيادة جديدة بمخزن جديد، والاسم المتكرر مرفوض، والمخزن واحد لعيادة واحدة', async () => {
  const a = await mgr('POST', '/api/admin/clinics', { name: 'عيادة تجربة', newStore: true });
  assert.equal(a.status, 201);
  assert.ok(a.body.clinic.storeId);
  assert.equal((await mgr('POST', '/api/admin/clinics', { name: 'عيادة تجربة' })).status, 409);
  const b = await mgr('POST', '/api/admin/clinics', { name: 'عيادة تانية', storeId: a.body.clinic.storeId });
  assert.equal(b.status, 409);
  assert.equal((await rec('GET', '/api/admin/clinics')).status, 403);
});

test('ربط دكتور بعيادة، وتغيير اسم العيادة بيغيّر تخصص أطبائها، ومسح العيادة اللي فيها أطباء مرفوض', async () => {
  const a = (await mgr('POST', '/api/admin/clinics', { name: 'عيادة اختبار الربط' })).body.clinic;
  const d = (await mgr('GET', '/api/admin/doctors')).body.doctors[0];
  const put = await mgr('PUT', `/api/admin/doctors/${d.id}`, { name: d.name, clinicId: a.id, specialty: '', active: true, schedule: d.schedule, shares: d.shares });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.doctor.clinicId, a.id);
  assert.equal(put.body.doctor.specialty, 'عيادة اختبار الربط');
  await mgr('PUT', `/api/admin/clinics/${a.id}`, { name: 'اسم جديد للعيادة', active: true });
  assert.equal((await mgr('GET', '/api/admin/doctors')).body.doctors.find((x) => x.id === d.id).specialty, 'اسم جديد للعيادة');
  assert.equal((await mgr('DELETE', `/api/admin/clinics/${a.id}`)).status, 409);
  // تعديل الدكتور من غير clinicId ما بيمسحش الربط
  await mgr('PUT', `/api/admin/doctors/${d.id}`, { name: d.name, specialty: 'اسم جديد للعيادة', active: true, schedule: d.schedule, shares: d.shares });
  assert.equal((await mgr('GET', '/api/admin/doctors')).body.doctors.find((x) => x.id === d.id).clinicId, a.id);
});
