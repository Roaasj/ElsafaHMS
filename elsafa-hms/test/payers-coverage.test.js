// حماية من عيب v0.16: DEPT_KEYS كانت بتتحسب وقت تحميل الملف (فاضية) فنسب التغطية كانت بتتسقط عند إضافة/تعديل جهة من الشاشة.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const client = (cookie) => {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b) };
};
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager'));
});
after(() => ctx.server.close());

const covRows = async () => (await ctx.db.query('SELECT t.PayerId, t.Name AS Tier, c.Dept, c.Pct FROM TierCoverage c JOIN PayerTiers t ON t.Id = c.TierId ORDER BY t.PayerId, t.Name, c.Dept'))
  .map((r) => `${r.PayerId}|${r.Tier}|${r.Dept}|${Number(r.Pct)}`);

test('إضافة جهة: نسب التغطية بتتحفظ وبتتقرا بعد إعادة التحميل', async () => {
  const cov = { clinic: 70, lab: 55.5, radiology: 40, ward: 80, drugs: 25, supplies: 10 };
  const c = await mgr.post('/api/payers', { name: 'جهة اختبار تغطية', priceMode: 'list', tiers: [{ name: 'أ', coverage: cov }, { name: 'ب', coverage: { clinic: 30 } }] });
  assert.equal(c.status, 201);
  const re = await mgr.get(`/api/payers/${c.body.payer.id}`);
  const tiers = Object.fromEntries(re.body.payer.tiers.map((t) => [t.name, t.coverage]));
  assert.deepEqual(tiers['أ'], cov);
  assert.deepEqual(tiers['ب'], { clinic: 30 });
});

test('تعديل جهة: التغطية بتتحفظ بعد التعديل (وتتغير لما نغيّرها)', async () => {
  const c = await mgr.post('/api/payers', { name: 'جهة اختبار تعديل', priceMode: 'cash', tiers: [{ name: 'أ', coverage: { clinic: 60, lab: 60 } }] });
  const id = c.body.payer.id, tid = c.body.payer.tiers[0].id;
  const u = await mgr.put(`/api/payers/${id}`, { name: 'جهة اختبار تعديل 2', priceMode: 'cash', notes: 'ملاحظة', tiers: [{ id: tid, name: 'أ', coverage: { clinic: 65, lab: 60, ward: 90 } }] });
  assert.equal(u.status, 200);
  const re = (await mgr.get(`/api/payers/${id}`)).body.payer;
  assert.deepEqual(re.tiers[0].coverage, { clinic: 65, lab: 60, ward: 90 });
  assert.equal(re.name, 'جهة اختبار تعديل 2');
});

test('قسم جديد من الإعدادات بيظهر في تغطية الجهات من غير إعادة تشغيل', async () => {
  const d = (await mgr.post('/api/config/lookups/dept', { name: 'قسم تغطية جديد', behavior: 'service', prefix: 'NW', color: '#2a9d8f', icon: 'heart' })).body.domains.dept.items.find((x) => x.name === 'قسم تغطية جديد');
  const c = await mgr.post('/api/payers', { name: 'جهة بقسم جديد', priceMode: 'cash', tiers: [{ name: 'أ', coverage: { clinic: 50, [d.code]: 45 } }] });
  assert.equal(c.status, 201);
  assert.equal((await mgr.get(`/api/payers/${c.body.payer.id}`)).body.payer.tiers[0].coverage[d.code], 45);
});

test('الجهات الموجودة: حفظها كما هي من الشاشة (جيئة وذهاب) ما بيغيّرش أي نسبة تغطية', async () => {
  const before = await covRows();
  const list = (await mgr.get('/api/payers')).body.payers.filter((p) => !p.name.startsWith('جهة اختبار') && p.name !== 'جهة بقسم جديد');
  assert.ok(list.length >= 3);
  for (const p of list) {
    const full = (await mgr.get(`/api/payers/${p.id}`)).body.payer;
    const r = await mgr.put(`/api/payers/${p.id}`, { ...full, tiers: full.tiers.map((t) => ({ id: t.id, name: t.name, active: t.active, coverage: t.coverage })) });
    assert.equal(r.status, 200, p.name);
  }
  const after = await covRows();
  const mine = (rows) => rows.filter((r) => list.some((p) => r.startsWith(p.id + '|')));
  assert.deepEqual(mine(after), mine(before));
  assert.ok(mine(before).length > 20);
});
