// التعاقدات: موظف التعاقدات يضيف ويعدّل بس، المسح للمدير وبشرط عدم الاستخدام، وأسعار الجهة بالإكسل
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, claims, rec;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const client = (cookie) => {
  const call = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: raw ? { cookie } : { 'content-type': 'application/json', cookie }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : null, buf: ct.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u), raw: (u, b) => call('POST', u, b, true) };
};
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager')); claims = client(await login('claims')); rec = client(await login('reception'));
});
after(() => ctx.server.close());

test('موظف التعاقدات: يضيف جهة ومستويات ويعدّل، والاستقبال لأ', async () => {
  const body = { name: 'جهة من موظف التعاقدات', priceMode: 'cash', tiers: [{ name: 'أ', coverage: { clinic: 70 } }, { name: 'ب', coverage: { clinic: 40 } }] };
  assert.equal((await rec.post('/api/payers', body)).status, 403);
  const c = await claims.post('/api/payers', body);
  assert.equal(c.status, 201);
  const id = c.body.payer.id;
  const u = await claims.put(`/api/payers/${id}`, { ...body, tiers: [...c.body.payer.tiers.map((t) => ({ id: t.id, name: t.name, coverage: t.coverage })), { name: 'ج', coverage: { clinic: 20 } }] });
  assert.equal(u.status, 200);
  assert.equal(u.body.payer.tiers.length, 3);
});

test('المسح للمدير بس: موظف التعاقدات والاستقبال ما يقدروش', async () => {
  const c = await mgr.post('/api/payers', { name: 'جهة للمسح بالصلاحيات', priceMode: 'cash', tiers: [{ name: 'أ', coverage: {} }, { name: 'ب', coverage: {} }] });
  const id = c.body.payer.id, tid = c.body.payer.tiers[1].id;
  assert.equal((await claims.del(`/api/payers/${id}`)).status, 403);
  assert.equal((await claims.del(`/api/payers/${id}/tiers/${tid}`)).status, 403);
  assert.equal((await rec.del(`/api/payers/${id}`)).status, 403);
  assert.equal((await mgr.get(`/api/payers/${id}`)).status, 200);
});

test('مسح مستوى وجهة عمرهم ما اتستخدموا: بيتمسحوا خالص بكل توابعهم', async () => {
  const c = await mgr.post('/api/payers', { name: 'جهة جديدة للمسح', priceMode: 'list', tiers: [{ name: 'أ', coverage: { clinic: 50 } }, { name: 'ب', coverage: { clinic: 30 } }] });
  const id = c.body.payer.id, [ta, tb] = c.body.payer.tiers.map((t) => t.id);
  const svc = (await mgr.get('/api/catalog/services')).body.services[0];
  await mgr.put(`/api/payers/${id}/prices`, { prices: [{ serviceId: svc.id, price: 10 }] });
  assert.equal((await mgr.del(`/api/payers/${id}/tiers/${tb}`)).status, 200);
  assert.equal(Number((await ctx.db.one('SELECT COUNT(*) AS N FROM PayerTiers WHERE Id = ?', [tb])).N), 0);
  assert.equal(Number((await ctx.db.one('SELECT COUNT(*) AS N FROM TierCoverage WHERE TierId = ?', [tb])).N), 0);
  const last = await mgr.del(`/api/payers/${id}/tiers/${ta}`);
  assert.equal(last.status, 400, 'آخر مستوى ما يتمسحش');
  assert.equal((await mgr.del(`/api/payers/${id}`)).status, 200);
  for (const tbl of ['Payers', 'PayerTiers', 'PayerPrices', 'TierCoverage'])
    assert.equal(Number((await ctx.db.one(`SELECT COUNT(*) AS N FROM ${tbl} WHERE ${tbl === 'Payers' ? 'Id' : tbl === 'TierCoverage' ? 'TierId' : 'PayerId'} = ?`, [tbl === 'TierCoverage' ? ta : id])).N), 0, tbl);
  assert.equal((await mgr.get(`/api/payers/${id}`)).status, 404);
});

test('جهة ومستوى اتستخدموا: المسح بيتمنع (409) والإيقاف هو البديل', async () => {
  const c = await mgr.post('/api/payers', { name: 'جهة مستخدمة', priceMode: 'cash', tiers: [{ name: 'أ', coverage: { clinic: 50 } }, { name: 'ب', coverage: {} }] });
  const id = c.body.payer.id, [ta, tb] = c.body.payer.tiers.map((t) => t.id);
  const pt = await rec.post('/api/patients', { name: 'مريض تعاقد للمسح بالاسم', phone: '01000000077', ageYears: 40, sex: 'M' });
  assert.equal(pt.status, 201);
  const pid = pt.body.patient?.id ?? pt.body.id;
  assert.equal((await rec.put(`/api/patients/${pid}/payer`, { payerId: id, tierId: ta, cardNo: 'K-1' })).status, 200);
  const t = await mgr.del(`/api/payers/${id}/tiers/${ta}`);
  assert.equal(t.status, 409);
  const p = await mgr.del(`/api/payers/${id}`);
  assert.equal(p.status, 409);
  assert.match(p.body.error || p.body.message || '', /وقّفها/);
  assert.equal((await mgr.get(`/api/payers/${id}`)).status, 200);
  // مستوى ما حدش استخدمه بيتمسح عادي حتى لو الجهة مستخدمة
  assert.equal((await mgr.del(`/api/payers/${id}/tiers/${tb}`)).status, 200);
  // الإيقاف شغال
  const u = await mgr.put(`/api/payers/${id}`, { name: 'جهة مستخدمة', priceMode: 'cash', active: false, tiers: [{ id: ta, name: 'أ', coverage: { clinic: 50 } }] });
  assert.equal(u.status, 200); assert.equal(u.body.payer.active, false);
});

test('أسعار الجهة بالإكسل: تصدير ← تعديل ← استيراد بيرجّع نفس الأسعار، والأخطاء بتتبلّغ', async () => {
  const c = await mgr.post('/api/payers', { name: 'جهة أسعار إكسل', priceMode: 'list', tiers: [{ name: 'أ', coverage: {} }] });
  const id = c.body.payer.id;
  const svcs = (await mgr.get('/api/catalog/services')).body.services;
  await mgr.put(`/api/payers/${id}/prices`, { prices: [{ serviceId: svcs[0].id, price: 11.5 }, { serviceId: svcs[1].id, price: 22 }] });
  const ex = await mgr.get(`/api/payers/prices-export?payer=${id}`);
  assert.equal(ex.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(ex.buf);
  const ws = wb.getWorksheet('أسعار الجهة');
  assert.equal(ws.rowCount - 1, svcs.length);
  assert.equal(ws.getRow(2).getCell(5).value, 11.5);
  assert.equal(ws.getRow(4).getCell(5).value, null, 'اللي ملوش سعر خاص بيفضل فاضي');
  // عدّل: سعر جديد + كود غلط + سعر مش رقم
  ws.getRow(4).getCell(5).value = 99;
  ws.getRow(5).getCell(1).value = 'NOPE'; ws.getRow(5).getCell(5).value = 5;
  ws.getRow(6).getCell(5).value = 'abc';
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const imp = await mgr.raw('/api/payers/prices-import', buf);
  assert.equal(imp.status, 200);
  const got = Object.fromEntries(imp.body.prices.map((x) => [x.serviceId, x.price]));
  assert.equal(got[svcs[0].id], 11.5); assert.equal(got[svcs[1].id], 22);
  assert.equal(Object.values(got).includes(99), true);
  assert.equal(imp.body.errors.length, 2);
  // الاستيراد ما حفظش حاجة
  assert.equal((await mgr.get(`/api/payers/${id}`)).body.prices.length, 2);
  assert.equal((await rec.raw('/api/payers/prices-import', buf)).status, 403);
  assert.equal((await mgr.raw('/api/payers/prices-import', Buffer.from('مش اكسل'))).status, 400);
});

test('بيانات شاشة تعديل الجهة: متاحة لموظف التعاقدات من غير صلاحية الإعدادات، ومقفولة على الاستقبال', async () => {
  const r = await claims.get('/api/payers/editor-data');
  assert.equal(r.status, 200);
  assert.ok(r.body.services.length > 5 && r.body.services.every((s) => s.price != null));
  assert.ok(r.body.classes.length >= 1);
  assert.equal((await rec.get('/api/payers/editor-data')).status, 403);
  assert.equal((await claims.get('/api/admin/services')).status, 403, 'إعدادات المدير تفضل مقفولة');
});
