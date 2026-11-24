// R1b-3: استثناءات الصلاحيات لكل موظف فوق الدور
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { can, permsOf } from '../src/lib/auth.js';

let ctx, base, mgr;
const login = async (u) => { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
const call = (cookie) => async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = call(await login('manager'));
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('can/permsOf: الإضافة والسحب فوق الدور، والمدير ما بيتشالش منه', () => {
  assert.equal(can({ role: 'reception', grants: ['lab.verify'], denied: [] }, 'lab.verify'), true);
  assert.equal(can({ role: 'reception', grants: [], denied: ['patients.write'] }, 'patients.write'), false);
  assert.equal(can({ role: 'reception', grants: [], denied: ['patients.write'] }, 'patients.read'), true);
  assert.equal(can({ role: 'manager', denied: ['patients.write'] }, 'patients.write'), true);
  assert.ok(!permsOf({ role: 'reception', denied: ['patients.write'] }).includes('patients.write'));
});

test('استثناء حقيقي من الشاشة: سحب صلاحية من موظف استقبال بيمنعه فعلًا، وبيرجع لما نشيل الاستثناء', async () => {
  const users = (await mgr('GET', '/api/admin/users')).body.users;
  const rec = users.find((u) => u.username === 'reception');
  const r = call(await login('reception'));
  assert.equal((await r('GET', '/api/patients/search?q=ab')).status, 200);
  const put = await mgr('PUT', '/api/admin/users/' + rec.id, { denied: ['patients.read'], grants: ['lab.verify'] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.user.denied, ['patients.read']);
  assert.equal((await r('GET', '/api/patients/search?q=ab')).status, 403);
  const me = (await r('GET', '/api/me')).body.user;
  assert.ok(!me.permissions.includes('patients.read') && me.permissions.includes('lab.verify'));
  await mgr('PUT', '/api/admin/users/' + rec.id, { denied: [], grants: [] });
  assert.equal((await r('GET', '/api/patients/search?q=ab')).status, 200);
});

test('المدير مينفعش يسحب من نفسه صلاحية الإعدادات', async () => {
  const me = (await mgr('GET', '/api/admin/users')).body.users.find((u) => u.username === 'manager');
  // المدير مستثنى من السحب أصلًا (بيتخزن فاضي)
  const put = await mgr('PUT', '/api/admin/users/' + me.id, { denied: ['settings.manage'] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.user.denied, []);
});
