// الشريحة 3: وحدة البيع والشراء الافتراضية للصنف
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr;
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
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

const item = (extra) => ({ kind: 'drug', name: 'صنف وحدات تجريبي', unit: 'قرص', price: '2', midUnit: 'شريط', midQty: 10, packUnit: 'علبة', packQty: 30, ...extra });

test('الافتراضي فاضي، وبيتحفظ ويرجع، ومينفعش وحدة مش متعرّفة', async () => {
  const a = await mgr('POST', '/api/tickets/items', item({}));
  assert.equal(a.status, 201);
  assert.equal(a.body.item.saleUnit, '');
  assert.equal(a.body.item.purchaseUnit, '');
  const b = await mgr('PUT', `/api/tickets/items/${a.body.item.id}`, item({ saleUnit: 'mid', purchaseUnit: 'pack' }));
  assert.equal(b.status, 200);
  assert.equal(b.body.item.saleUnit, 'mid');
  assert.equal(b.body.item.purchaseUnit, 'pack');
  const bad = await mgr('POST', '/api/tickets/items', item({ name: 'صنف من غير كبيرة', packUnit: '', packQty: '', saleUnit: 'pack' }));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.saleUnit);
  const back = await mgr('PUT', `/api/tickets/items/${a.body.item.id}`, item({ saleUnit: '', purchaseUnit: '' }));
  assert.equal(back.body.item.saleUnit, '');
});

test('قايمة الوحدات: متزرعة من الأصناف، والوحدة الجديدة بتتضاف، والصنف بوحدة جديدة بيسجّلها', async () => {
  const u0 = (await mgr('GET', '/api/tickets/units')).body.units;
  assert.ok(u0.length > 0 && u0.some((u) => u.name === 'علبة'));
  const add = await mgr('POST', '/api/tickets/units', { name: 'كرتونة' });
  assert.equal(add.status, 201);
  assert.ok(add.body.units.some((u) => u.name === 'كرتونة' && u.active));
  assert.equal((await mgr('POST', '/api/tickets/units', { name: 'كرتونة' })).status, 409);
  const off = await mgr('PUT', `/api/tickets/units/${add.body.units.find((u) => u.name === 'كرتونة').id}`, { active: false });
  assert.equal(off.body.units.find((u) => u.name === 'كرتونة').active, false);
  const it = await mgr('POST', '/api/tickets/items', { kind: 'supply', name: 'صنف بوحدة جديدة', unit: 'لفة', price: '5' });
  assert.equal(it.status, 201);
  assert.ok((await mgr('GET', '/api/tickets/units')).body.units.some((u) => u.name === 'لفة'));
});
