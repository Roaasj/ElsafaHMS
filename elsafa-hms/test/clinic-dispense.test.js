// الصرف من مخزن عيادة الدكتور تلقائي في زيارات العيادات (الاستقبال من غير ربط بالمخزن)
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

test('الكشف عند دكتور الباطنة ← الدوا بيتخصم من مخزن الباطنة لوحده، ومن غير كشف بيرجع للمخزن المشترك', async () => {
  const clinics = (await mgr('GET', '/api/admin/clinics')).body.clinics;
  const bat = clinics.find((c) => c.name === 'باطنة');
  const doc = (await mgr('GET', '/api/admin/doctors')).body.doctors.find((d) => d.clinicId === bat.id);
  const item = (await rec('GET', '/api/tickets/items')).body.items.find((i) => i.kind === 'drug');
  // رصيد في مخزن الباطنة
  await ctx.db.insert('StockBatches', { StoreId: bat.storeId, ItemId: item.id, BatchNo: 'T1', Qty: 20, Cost: 1, CreatedAt: new Date() });
  const p = (await rec('POST', '/api/patients', { name: 'مريض صرف العيادة ثلاثي', phone: '01055500001', ageYears: 30, sex: 'M' })).body.patient;
  const v = (await rec('POST', '/api/visits', { patientId: p.id, type: 'clinic' })).body;
  assert.equal(v.visit.clinicStore, null);
  const svc = (await rec('GET', '/api/catalog/services')).body.services.find((s) => s.dept === 'clinic' && s.hasDoctor);
  const k = await rec('POST', `/api/visits/${v.visit.id}/items`, { serviceId: svc.id, doctorId: doc.id });
  assert.equal(k.status, 201, JSON.stringify(k.body));
  assert.equal(k.body.visit.clinicStore.id, bat.storeId);
  // الاستقبال بيصرف من غير ما يحدد مخزن، ومن غير ربط بالمخزن
  const d = await rec('POST', `/api/visits/${v.visit.id}/items`, { stockItemId: item.id, qty: 2 });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const line = d.body.items.find((i) => i.stockItemId === item.id);
  assert.equal(line.storeId, bat.storeId);
  const left = await ctx.db.one('SELECT SUM(Qty) AS Q FROM StockBatches WHERE StoreId = ? AND ItemId = ?', [bat.storeId, item.id]);
  assert.equal(Number(left.Q), 18);
  // مخزن عيادة تانية متاح في القايمة للاستقبال
  const ss = (await rec('GET', '/api/catalog/stock-stores')).body.stores;
  assert.ok(ss.some((s) => s.id === bat.storeId && s.clinic));
});
