// اختبارات المخازن: الاستلام والتشغيلات، التحويلات (بالاستلام والمباشر)، الخصم من مخزن الدور مع التذكرة، والرصيد السالب بصلاحية
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, mgr, rec, acc, store, sacc, pharm, nurse, svc, docs, items, stores, users;
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
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b) };
}
const I = (name) => items.find((x) => x.name === name);
const S = (name) => stores.find((x) => x.name === name);
const qtyIn = async (c, storeName, itemName) => (await c.get(`/api/stores/stock?storeId=${S(storeName).id}&q=${encodeURIComponent(itemName)}`)).body.items.find((x) => x.name === itemName)?.qty;
let pn = 0;
async function admitOn(floorNo) {
  pn++;
  const p = (await rec.post('/api/patients', { name: `مريض مخزن ${pn} عادل`, phone: `0109999${String(pn).padStart(4, '0')}`, ageYears: 50, sex: 'M', address: 'دمياط', nationalId: `276010111${String(pn).padStart(3, '0')}1${pn % 10}`, emergencyName: 'ابنه', emergencyPhone: '01012345678', confirmDuplicatePhone: true })).body.patient;
  const board = (await rec.get('/api/admissions/beds/board')).body;
  let bed, cls;
  for (const f of board.floors) if (f.no === floorNo) for (const r of f.rooms) for (const b of r.beds) if (!bed && b.status === 'free' && r.cls.kind === 'ward') { bed = b; cls = r.cls; }
  const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  return a.body.admission.id;
}

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager'));
  rec = client(await login('reception'));
  acc = client(await login('acc'));
  store = client(await login('store'));
  sacc = client(await login('storeacc'));
  pharm = client(await login('pharm'));
  nurse = client(await login('nurse4'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  items = (await acc.get('/api/tickets/items')).body.items;
  stores = (await mgr.get('/api/stores/meta')).body.stores;
  users = (await mgr.get('/api/admin/users')).body.users;
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('المخازن الافتراضية والأدوار: كل واحد على مخازنه', async () => {
  for (const n of ['مخزن الأدوية الرئيسي', 'مخزن المستلزمات الرئيسي', 'الصيدلية', 'مخزن الدور 4', 'مخزن الدور 8']) assert.ok(S(n), n);
  const m = (await nurse.get('/api/stores/meta')).body;
  assert.deepEqual(m.stores.filter((s) => s.mine).map((s) => s.name), ['مخزن الدور 4']);
  assert.equal(m.can.issue, false);
  assert.equal((await nurse.get(`/api/stores/stock?storeId=all`)).status, 403);
  assert.equal((await acc.get('/api/stores/meta')).status, 403);
  // الوحدات
  const amox = I('أموكسيسيلين/كلافيولانيك 1 جم أقراص');
  assert.equal(amox.midUnit, 'شريط');
  assert.equal(amox.packQty, 14);
});

test('الاستلام من المورد بالوحدة الكبيرة والتشغيلة والصلاحية، ورصيد أول المدة', async () => {
  // أمين المخزن مالوش يستلم فواتير (حسابات المخزن بس)
  assert.equal((await store.post('/api/stores/purchases', {})).status, 403);
  assert.equal((await sacc.post('/api/stores/purchases', { storeId: S('مخزن الأدوية الرئيسي').id, lines: [{ itemId: I('سيفترياكسون 1 جم').id, qty: 1 }] })).status, 400); // المورد
  // مستلزم في مخزن الأدوية: مرفوض
  const wrong = await sacc.post('/api/stores/purchases', { storeId: S('مخزن الأدوية الرئيسي').id, supplier: 'ابن سينا', lines: [{ itemId: I('كانيولا 20G').id, qty: 1 }] });
  assert.equal(wrong.status, 400);
  const p = await sacc.post('/api/stores/purchases', {
    storeId: S('مخزن الأدوية الرئيسي').id, supplier: 'شركة ابن سينا فارما', invoiceNo: 'F-991', invoiceDate: '2026-11-18',
    lines: [
      { itemId: I('سيفترياكسون 1 جم').id, unit: 'pack', qty: 5, cost: 600, batchNo: 'C-01', expiry: '2027-01-31' }, // 50 فيال
      { itemId: I('سيفترياكسون 1 جم').id, unit: 'base', qty: 10, cost: 62, batchNo: 'C-02', expiry: '2028-06-30' },
      { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'pack', qty: 4, cost: 110, batchNo: 'A-7', expiry: '2027-12-31' }, // 56 قرص
    ],
  });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(await qtyIn(sacc, 'مخزن الأدوية الرئيسي', 'سيفترياكسون 1 جم'), 60);
  assert.equal(await qtyIn(sacc, 'مخزن الأدوية الرئيسي', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص'), 56);
  const det = (await sacc.get(`/api/stores/purchases/${p.body.id}`)).body;
  assert.equal(det.purchase.total, 5 * 600 + 10 * 62 + 4 * 110);
  // صلاحية منتهية مرفوضة
  assert.equal((await sacc.post('/api/stores/purchases', { storeId: S('مخزن الأدوية الرئيسي').id, supplier: 'x', lines: [{ itemId: I('ديكلوفيناك 75 مجم').id, qty: 1, expiry: '2020-01-01' }] })).status, 400);
  // رصيد أول المدة في المستلزمات
  const op = await sacc.post('/api/stores/purchases', { kind: 'opening', storeId: S('مخزن المستلزمات الرئيسي').id, lines: [{ itemId: I('كانيولا 20G').id, unit: 'pack', qty: 2 }, { itemId: I('شاش رول طبي').id, unit: 'pack', qty: 3 }] });
  assert.equal(op.status, 201);
  assert.equal(await qtyIn(sacc, 'مخزن المستلزمات الرئيسي', 'شاش رول طبي'), 300);
  const card = (await sacc.get(`/api/stores/item/${I('سيفترياكسون 1 جم').id}`)).body;
  assert.equal(card.batches.length, 2);
  assert.equal(card.batches[0].batchNo, 'C-01'); // الأقرب انتهاءً الأول
});

test('التحويل بالخطوات: الدور يطلب ← الرئيسي يصرف (الأقرب انتهاءً) ← الدور يستلم ← الرئيسي يأكد', async () => {
  const from = S('مخزن الأدوية الرئيسي').id, to = S('مخزن الدور 4').id;
  // الممرضة ماتطلبش لمخزن مش بتاعها
  assert.equal((await nurse.post('/api/stores/transfers', { fromStoreId: from, toStoreId: S('مخزن الدور 8').id, lines: [{ itemId: I('سيفترياكسون 1 جم').id, qty: 5 }] })).status, 400);
  const rq = await nurse.post('/api/stores/transfers', { fromStoreId: from, toStoreId: to, lines: [{ itemId: I('سيفترياكسون 1 جم').id, qty: 55 }, { itemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, unit: 'mid', qty: 2 }] });
  assert.equal(rq.status, 201, JSON.stringify(rq.body));
  const tid = rq.body.transfer.id;
  assert.equal(rq.body.transfer.status, 'requested');
  assert.equal(rq.body.lines[1].reqQty, 14);
  // الممرضة ماتصرفش
  assert.equal((await nurse.post(`/api/stores/transfers/${tid}/issue`, {})).status, 403);
  // أمين المخزن يصرف 52 بس (من غير ما الرصيد يقل عن الصفر)
  const ln = rq.body.lines;
  const is = await store.post(`/api/stores/transfers/${tid}/issue`, { lines: [{ lineId: ln[0].id, qty: 52 }, { lineId: ln[1].id, qty: 14 }] });
  assert.equal(is.status, 200, JSON.stringify(is.body));
  assert.equal(is.body.transfer.status, 'issued');
  assert.deepEqual(is.body.lines[0].batches.map((b) => [b.batchNo, b.qty]), [['C-01', 50], ['C-02', 2]]);
  assert.equal(await qtyIn(store, 'مخزن الأدوية الرئيسي', 'سيفترياكسون 1 جم'), 8);
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), 0); // لسه ما استلمش
  assert.equal((await store.post(`/api/stores/transfers/${tid}/confirm`, {})).status, 409);
  const rc = await nurse.post(`/api/stores/transfers/${tid}/receive`, {});
  assert.equal(rc.body.transfer.status, 'received');
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), 52);
  const cf = await store.post(`/api/stores/transfers/${tid}/confirm`, {});
  assert.equal(cf.body.transfer.status, 'confirmed');
  // التشغيلة والصلاحية اتنقلت
  const card = (await nurse.get(`/api/stores/item/${I('سيفترياكسون 1 جم').id}?storeId=${to}`)).body;
  assert.deepEqual(card.batches.map((b) => b.batchNo), ['C-01', 'C-02']);
  // أكتر من الرصيد من غير صلاحية: مرفوض
  const rq2 = await nurse.post('/api/stores/transfers', { fromStoreId: from, toStoreId: to, lines: [{ itemId: I('سيفترياكسون 1 جم').id, qty: 30 }] });
  const r2 = await store.post(`/api/stores/transfers/${rq2.body.transfer.id}/issue`, {});
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /مايكفيش/);
  // إلغاء الطلب
  assert.equal((await nurse.post(`/api/stores/transfers/${rq2.body.transfer.id}/cancel`, { reason: 'اتطلب غلط' })).body.transfer.status, 'cancelled');
});

test('التحويل المباشر والرصيد السالب: صلاحيات بيفعّلها المدير لكل مستخدم', async () => {
  const from = S('مخزن المستلزمات الرئيسي').id, to = S('مخزن الدور 4').id;
  const keeper = users.find((u) => u.username === 'store');
  // من غير صلاحية
  assert.equal((await store.post('/api/stores/transfers', { issue: true, direct: true, fromStoreId: from, toStoreId: to, lines: [{ itemId: I('كانيولا 20G').id, qty: 20 }] })).status, 403);
  const g = await mgr.put(`/api/admin/users/${keeper.id}`, { grants: ['stock.direct'] });
  assert.deepEqual(g.body.user.grants, ['stock.direct']);
  const d = await store.post('/api/stores/transfers', { issue: true, direct: true, fromStoreId: from, toStoreId: to, lines: [{ itemId: I('كانيولا 20G').id, qty: 20 }, { itemId: I('شاش رول طبي').id, unit: 'pack', qty: 1 }] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.transfer.status, 'confirmed');
  assert.equal(d.body.transfer.direct, true);
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'كانيولا 20G'), 20);
  // تحويل عادي (من غير مباشر) بيستنى الاستلام
  const n = await store.post('/api/stores/transfers', { issue: true, fromStoreId: from, toStoreId: to, lines: [{ itemId: I('كانيولا 20G').id, qty: 5 }] });
  assert.equal(n.body.transfer.status, 'issued');
  // إلغاء بعد الصرف: الرصيد يرجع
  await store.post(`/api/stores/transfers/${n.body.transfer.id}/cancel`, { reason: 'العربية مشيت' });
  assert.equal(await qtyIn(store, 'مخزن المستلزمات الرئيسي', 'كانيولا 20G'), 80);
  // الرصيد السالب
  const r1 = await store.post('/api/stores/transfers', { issue: true, fromStoreId: from, toStoreId: to, lines: [{ itemId: I('رباط ضاغط').id, qty: 3 }] });
  assert.equal(r1.status, 409);
  await mgr.put(`/api/admin/users/${keeper.id}`, { grants: ['stock.direct', 'stock.negative'] });
  const r2 = await store.post('/api/stores/transfers', { issue: true, direct: true, fromStoreId: from, toStoreId: to, lines: [{ itemId: I('رباط ضاغط').id, qty: 3 }] });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(await qtyIn(store, 'مخزن المستلزمات الرئيسي', 'رباط ضاغط'), -3);
  // الاستلام بيسدد السالب الأول
  await sacc.post('/api/stores/purchases', { storeId: from, supplier: 'المتحدة', lines: [{ itemId: I('رباط ضاغط').id, qty: 10, cost: 15, batchNo: 'R1', expiry: '2029-01-01' }] });
  assert.equal(await qtyIn(store, 'مخزن المستلزمات الرئيسي', 'رباط ضاغط'), 7);
  const neg = (await sacc.get(`/api/stores/stock?storeId=${from}&filter=negative`)).body;
  assert.equal(neg.items.length, 0);
});

test('التذكرة بتخصم من مخزن الدور، والشيل وتعديل العدد والوحدة بيرجّعوا', async () => {
  await mgr.put('/api/admin/ticket-settings', { stockDeduct: 'on' });
  const aid = await admitOn(4);
  const before = await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'); // 52
  const l = await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'drug', stockItemId: I('سيفترياكسون 1 جم').id, qty: 3 } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), before - 3);
  await acc.patch(`/api/tickets/adm/${aid}/items/${l.body.itemId}`, { qty: 5 });
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), before - 5);
  await acc.patch(`/api/tickets/adm/${aid}/items/${l.body.itemId}`, { qty: 1 });
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), before - 1);
  await acc.del(`/api/tickets/adm/${aid}/items/${l.body.itemId}`, {});
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'سيفترياكسون 1 جم'), before);
  // بالشريط: 2 شريط = 14 قرص، والسعر 7 × 9
  const a = await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'drug', stockItemId: I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id, qty: 1, unit: 'mid' } });
  const it = a.body.items.find((x) => x.id === a.body.itemId);
  assert.equal(it.unitPrice, 63);
  assert.match(it.name, /شريط/);
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص'), 7);
  // تغيير الوحدة لقرص
  const u = await acc.patch(`/api/tickets/adm/${aid}/items/${a.body.itemId}`, { unit: 'base', qty: 3 });
  assert.equal(u.body.items.find((x) => x.id === a.body.itemId).amount, 27);
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'أموكسيسيلين/كلافيولانيك 1 جم أقراص'), 11);
  // مفيش رصيد ومفيش صلاحية: مرفوض
  const no = await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'drug', stockItemId: I('ألبومين 20% 50 مل').id } });
  assert.equal(no.status, 409);
  assert.match(no.body.error, /مخزن الدور 4/);
  // المدير يدّي الحسابات صلاحية الصرف على السالب
  const accU = users.find((x) => x.username === 'acc');
  await mgr.put(`/api/admin/users/${accU.id}`, { grants: ['stock.negative'] });
  const ok = await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'drug', stockItemId: I('ألبومين 20% 50 مل').id } });
  assert.equal(ok.status, 201);
  assert.equal(await qtyIn(nurse, 'مخزن الدور 4', 'ألبومين 20% 50 مل'), -1);
  // كارت الصنف بيوري الصرف للتذكرة
  const card = (await nurse.get(`/api/stores/item/${I('أموكسيسيلين/كلافيولانيك 1 جم أقراص').id}?storeId=${S('مخزن الدور 4').id}`)).body;
  assert.ok(card.moves.some((m) => m.kind === 'ticket') && card.moves.some((m) => m.kind === 'ticket_back'));
  // الخدمات مش بتلمس المخزن
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'service', serviceId: svc['IP-002'].id } })).status, 201);
  // أعداد القايمة
  const c = (await nurse.get('/api/stores/counts')).body;
  assert.equal(typeof c.receive, 'number');
});
