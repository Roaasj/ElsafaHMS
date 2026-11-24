// R1b-2أ: الأدوار والصلاحيات في قاعدة البيانات، بنفس صلاحيات الكود القديم بالظبط
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { start } from '../src/server.js';
import { can, ROLES, PERMISSIONS, loadRoles, DEFAULT_PERMISSIONS } from '../src/lib/auth.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { allPermNames, matrix } from './baseline/permissions-matrix.mjs';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, 'baseline/permissions.golden.json'), 'utf8'));
let ctx;
let base;
before(async () => { ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } }); await seedDemo(ctx.db); base = `http://127.0.0.1:${ctx.server.address().port}`; });
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('الأدوار اتزرعت في قاعدة البيانات: 15 دور، ومصفوفة الصلاحيات مطابقة للمسجّلة من الكود القديم (دور × صلاحية)', async () => {
  const n = await ctx.db.one('SELECT COUNT(*) AS N FROM Roles');
  assert.equal(Number(n.N), 15);
  assert.deepEqual(Object.keys(ROLES), golden.roles);
  const perms = allPermNames(path.join(import.meta.dirname, '..'));
  for (const l of Object.values(DEFAULT_PERMISSIONS)) for (const p of l) if (p !== '*') perms.add(p);
  assert.deepEqual([...perms].sort(), golden.perms, 'قايمة الصلاحيات المذكورة في الكود اتغيّرت: سجّل مصفوفة جديدة بعد المراجعة');
  const now = matrix(can, Object.keys(ROLES), perms);
  for (const r of golden.roles) assert.deepEqual(now[r], golden.matrix[r], `صلاحيات الدور ${r} اختلفت`);
});

test('قاعدة البيانات هي المرجع: تعديل صلاحية في الجدول بيظهر بعد التحميل، والرجوع بيرجّع الأصل', async () => {
  await ctx.db.run("DELETE FROM RolePermissions WHERE RoleCode = 'reception' AND Perm = 'lab.deliver'");
  await loadRoles(ctx.db);
  assert.equal(can({ role: 'reception' }, 'lab.deliver'), false);
  await ctx.db.insert('RolePermissions', { RoleCode: 'reception', Perm: 'lab.deliver' });
  await loadRoles(ctx.db);
  assert.equal(can({ role: 'reception' }, 'lab.deliver'), true);
  assert.deepEqual([...new Set(PERMISSIONS.reception)].sort(), [...new Set(DEFAULT_PERMISSIONS.reception)].sort());
});

test('دور جديد بالبيانات بيشتغل (من غير قيد قاعدة البيانات القديم)', async () => {
  await ctx.db.insert('Roles', { Code: 'custom1', Name: 'دور تجريبي', IsSystem: 0, Active: 1, SortOrder: 99 });
  await ctx.db.insert('RolePermissions', { RoleCode: 'custom1', Perm: 'patients.read' });
  await loadRoles(ctx.db);
  assert.equal(can({ role: 'custom1' }, 'patients.read'), true);
  assert.equal(can({ role: 'custom1' }, 'patients.write'), false);
  await ctx.db.insert('Users', { Username: 'cust', FullName: 'مستخدم تجريبي', PasswordHash: 'x', Role: 'custom1', Active: 1, CreatedAt: new Date() });
  await ctx.db.run("DELETE FROM Users WHERE Username = 'cust'");
  await ctx.db.run("DELETE FROM RolePermissions WHERE RoleCode = 'custom1'");
  await ctx.db.run("DELETE FROM Roles WHERE Code = 'custom1'");
  await loadRoles(ctx.db);
});

test('واجهة إدارة الأدوار: إنشاء/تعديل/مسح، المدير ثابت، ودور مستخدم ما يتمسحش', async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'manager', password: 'Safa@2026' }) });
  assert.ok(login.ok, 'login ' + login.status);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (m, u, b) => { const r = await fetch(base + '/api' + u, { method: m, headers: { 'content-type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const list = await call('GET', '/admin/roles');
  assert.equal(list.j.roles.length, 15);
  assert.equal(list.j.roles.find((r) => r.code === 'manager').all, true);
  assert.equal((await call('PUT', '/admin/roles/manager', { name: 'x', perms: [] })).s, 400);
  assert.equal((await call('POST', '/admin/roles', { name: 'سكرتارية', perms: ['bogus.perm'] })).s, 400);
  const c = await call('POST', '/admin/roles', { name: 'سكرتارية', perms: ['patients.read', 'visits.read'], home: '/' });
  assert.equal(c.s, 201);
  const code = c.j.role.code;
  assert.equal(can({ role: code }, 'patients.read'), true);
  assert.equal(can({ role: code }, 'patients.write'), false);
  const u = await call('POST', '/admin/users', { username: 'secr1', name: 'موظف سكرتارية', role: code, password: 'abcdef1' });
  assert.equal(u.s, 201);
  assert.equal((await call('DELETE', '/admin/roles/' + code)).s, 400, 'دور عليه موظفين');
  const up = await call('PUT', '/admin/roles/' + code, { name: 'سكرتارية', perms: ['patients.read', 'patients.write'], home: '/' });
  assert.equal(up.s, 200);
  assert.equal(can({ role: code }, 'patients.write'), true);
  assert.equal((await call('DELETE', '/admin/roles/reception')).s, 400, 'دور أساسي');
  await ctx.db.run("DELETE FROM Users WHERE Username = 'secr1'");
  assert.equal((await call('DELETE', '/admin/roles/' + code)).s, 200);
});
