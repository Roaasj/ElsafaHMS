// اختبارات القوائم المرجعية: قسم جديد من الشاشة بيدخل الدورة كلها من غير كود
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, rec, dir;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : null };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'lk-'));
  ctx = await start({ port: 0, brandDir: dir, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager'));
  rec = client(await login('reception'));
});
after(() => { ctx.server.close(); rmSync(dir, { recursive: true, force: true }); });

test('القوائم: قراءة للكل وإدارة للمدير بس', async () => {
  const r = await rec.get('/api/lookups');
  assert.equal(r.status, 200);
  assert.ok(r.body.dept.find((d) => d.code === 'clinic') && r.body.admission_type.length >= 4 && r.body.room_kind.length >= 3);
  assert.equal((await rec.get('/api/config/lookups')).status, 403);
  assert.equal((await rec.post('/api/config/lookups/dept', { name: 'x' })).status, 403);
  const m = await mgr.get('/api/config/lookups');
  assert.equal(m.status, 200);
  assert.ok(m.body.domains.dept.behaviors.length >= 6);
});

test('قسم جديد (علاج طبيعي): بيدخل الخدمات والزيارات والمخزن من غير كود', async () => {
  const bad = await mgr.post('/api/config/lookups/dept', { name: 'علاج طبيعي', behavior: 'service', prefix: 'CL', color: '#0a7', icon: 'heart' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.prefix && bad.body.errors.color);
  const ok = await mgr.post('/api/config/lookups/dept', { name: 'علاج طبيعي', behavior: 'service', prefix: 'PT', color: '#2a9d8f', icon: 'heart' });
  assert.equal(ok.status, 200);
  const d = ok.body.domains.dept.items.find((x) => x.name === 'علاج طبيعي');
  assert.ok(/^d\d+$/.test(d.code) && d.meta.visit === true && d.meta.prefix === 'PT');
  assert.equal((await mgr.post('/api/config/lookups/dept', { name: 'علاج طبيعي', behavior: 'service', prefix: 'PX', color: '#2a9d8f', icon: 'heart' })).status, 400);
  // الخدمة بكود بالبادئة الجديدة
  const s = await mgr.post('/api/admin/services', { name: 'جلسة علاج طبيعي', dept: d.code, payTiming: 'before', price: 300 });
  assert.equal(s.status, 201);
  assert.equal(s.body.service.code, 'PT-001');
  // زيارة بالقسم الجديد
  const p = await rec.post('/api/patients', { name: 'سعيد محمد علي حسن', phone: '01022233344', ageYears: 35, sex: 'M' });
  const v = await rec.post('/api/visits', { patientId: p.body.patient.id, type: d.code });
  assert.equal(v.status, 201);
  const it = await rec.post(`/api/visits/${v.body.visit.id}/items`, { serviceId: s.body.service.id });
  assert.equal(it.status, 201);
  // ظهور في كتالوج الاستقبال باسمه
  const cat = await rec.get('/api/catalog/services');
  assert.equal(cat.body.depts[d.code], 'علاج طبيعي');
  // مش قايمة شغل معمل: خدمته مش بتظهر في طابور المعمل
  const q = await mgr.get('/api/lab');
  assert.ok(q.status === 200);
  assert.ok(!JSON.stringify(q.body).includes('جلسة علاج طبيعي'));
  // عليه شغل: مينفعش يتمسح ولا يتغيّر سلوكه، لكن يتوقف
  assert.equal((await mgr.del(`/api/config/lookups/item/${d.id}`)).status, 400);
  assert.equal((await mgr.put(`/api/config/lookups/item/${d.id}`, { behavior: 'lab' })).status, 400);
  const off = await mgr.post(`/api/config/lookups/item/${d.id}/active`, { active: false });
  assert.equal(off.body.domains.dept.items.find((x) => x.id === d.id).active, false);
  assert.ok(!(await rec.get('/api/lookups')).body.dept.find((x) => x.id === d.id).active);
});

test('قسم من غير شغل: يتعدل ويتمسح. ونوع غرفة ونوع دخول جدد', async () => {
  const a = await mgr.post('/api/config/lookups/dept', { name: 'مؤقت', behavior: 'clinic', prefix: 'TMP', color: '#123456', icon: 'steth' });
  const t = a.body.domains.dept.items.find((x) => x.name === 'مؤقت');
  const e = await mgr.put(`/api/config/lookups/item/${t.id}`, { name: 'مؤقت 2', behavior: 'lab', color: '#654321' });
  assert.equal(e.status, 200);
  assert.equal(e.body.domains.dept.items.find((x) => x.id === t.id).behavior, 'lab');
  assert.equal((await mgr.del(`/api/config/lookups/item/${t.id}`)).status, 200);
  const rk = await mgr.post('/api/config/lookups/room_kind', { name: 'رعاية مركزة قلب', color: '#cc2233', icon: 'heart' });
  assert.equal(rk.status, 200);
  const k = rk.body.domains.room_kind.items.find((x) => x.name === 'رعاية مركزة قلب');
  const at = await mgr.post('/api/config/lookups/admission_type', { name: 'دخول قلب', behavior: 'standard', roomKind: k.code, color: '#cc2233', icon: 'heart' });
  assert.equal(at.status, 200);
  assert.equal((await mgr.post('/api/config/lookups/admission_type', { name: 'غلط', behavior: 'standard', roomKind: 'nope', color: '#cc2233', icon: 'heart' })).status, 400);
  // نوع الغرفة مستخدم في نوع دخول: مينفعش يتمسح
  assert.equal((await mgr.del(`/api/config/lookups/item/${k.id}`)).status, 400);
});

test('ترتيب القائمة بيتحفظ ويتحقق منه', async () => {
  const items = (await mgr.get('/api/config/lookups')).body.domains.room_kind.items.map((x) => x.id);
  assert.equal((await mgr.post('/api/config/lookups/room_kind/order', { ids: items.slice(1) })).status, 400);
  const rev = [...items].reverse();
  const r = await mgr.post('/api/config/lookups/room_kind/order', { ids: rev });
  assert.deepEqual(r.body.domains.room_kind.items.map((x) => x.id), rev);
});
