// اختبارات محرك الإعدادات: الهوية، اللوجو، الورديات، المنطقة الزمنية، الترقيم
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { shiftLabel, businessDate } from '../src/lib/cashier.js';
import { cairoMinutes } from '../src/lib/util.js';

let ctx, base, mgr, rec, dir;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + url, { method, headers: { ...(isBuf ? {} : { 'content-type': 'application/json' }), cookie, ...headers }, body: body ? (isBuf ? body : JSON.stringify(body)) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, type: ct, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u), raw: (u, buf, type) => call('POST', u, buf, { 'content-type': type }) };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'brand-'));
  ctx = await start({ port: 0, brandDir: dir, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager'));
  rec = client(await login('reception'));
});
after(async () => { ctx.server.close(); await ctx.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('الهوية متاحة من غير تسجيل دخول، وبالافتراضي من السجل', async () => {
  const anon = client('');
  const r = await anon.get('/api/branding');
  assert.equal(r.status, 200);
  assert.ok(r.body.name && r.body.primary.startsWith('#') && r.body.logo.startsWith('/brand/logo'));
  const logo = await anon.get('/brand/logo');
  assert.equal(logo.status, 200);
  assert.match(logo.type, /svg/);
});

test('الإعدادات للمدير بس، وكل إعداد بيجي من السجل', async () => {
  assert.equal((await rec.get('/api/config/settings')).status, 403);
  assert.equal((await rec.put('/api/config/settings', { values: { hospitalName: 'x' } })).status, 403);
  const r = await mgr.get('/api/config/settings');
  assert.equal(r.status, 200);
  const keys = r.body.items.map((i) => i.key);
  for (const k of ['hospitalName', 'colorPrimary', 'tz', 'shiftAmFrom', 'checkoutTime', 'cashierMode', 'doctorTaxPct', 'payoutDay']) assert.ok(keys.includes(k), k);
  assert.ok(r.body.groups.length >= 6);
});

test('تغيير الهوية بيتطبّق على الواجهة و/me والطباعة', async () => {
  const r = await mgr.put('/api/config/settings', { values: { hospitalName: 'مستشفى النور', hospitalSub: 'قسم الاستقبال', colorPrimary: '#0b5fa5', colorAccent: '#8fd3ff', printFooter: 'القاهرة · 0100' } });
  assert.equal(r.status, 200);
  const b = (await client('').get('/api/branding')).body;
  assert.equal(b.name, 'مستشفى النور');
  assert.equal(b.primary, '#0b5fa5');
  assert.equal(b.footer, 'القاهرة · 0100');
  assert.equal((await mgr.get('/api/me')).body.hospital, 'مستشفى النور');
  assert.ok(r.body.items.find((i) => i.key === 'hospitalName').custom);
  // الطباعة: الاسم واللون والتذييل واللوجو من الإعدادات (على إيصال حقيقي)
  const p = await rec.post('/api/patients', { name: 'محمود حسن علي سالم', phone: '01011122233', ageYears: 40, sex: 'M' });
  assert.equal(p.status, 201);
  const v = await rec.post('/api/visits', { patientId: p.body.patient.id, type: 'clinic' });
  const svcs = (await rec.get('/api/catalog/services')).body.services;
  const doc = (await rec.get('/api/catalog/doctors')).body.doctors[0];
  const it = await rec.post(`/api/visits/${v.body.visit.id}/items`, { serviceId: svcs.find((x) => x.code === 'CL-001').id, doctorId: doc.id });
  assert.equal(it.status, 201);
  const total = it.body.totals.due;
  const pay = await rec.post(`/api/visits/${v.body.visit.id}/pay`, { itemIds: [it.body.item?.id ?? (await rec.get('/api/visits/' + v.body.visit.id)).body.items[0].id], cash: total });
  assert.equal(pay.status, 201);
  const rcId = (await ctx.db.one('SELECT Id FROM Receipts ORDER BY Id DESC LIMIT 1')).Id;
  const html = (await mgr.get(`/print/receipt/${rcId}`)).body.toString('utf8');
  assert.ok(html.includes('مستشفى النور') && html.includes('#0b5fa5') && html.includes('القاهرة · 0100') && html.includes('/brand/logo'));
  assert.ok(!html.includes('#9a0000') && !html.includes('/logo.png'));
  // الإكسل بياخد اسم المستشفى
  const x = await mgr.get('/api/admin/services/export');
  assert.equal(x.status, 200);
  assert.ok(x.body.length > 100);
});

test('التحقق: لون غلط، وقت غلط، ترتيب الورديات، تكرار الأسماء', async () => {
  let r = await mgr.put('/api/config/settings', { values: { colorPrimary: 'red' } });
  assert.equal(r.status, 400); assert.ok(r.body.errors.colorPrimary);
  r = await mgr.put('/api/config/settings', { values: { shiftAmFrom: '25:00' } });
  assert.equal(r.status, 400); assert.ok(r.body.errors.shiftAmFrom);
  r = await mgr.put('/api/config/settings', { values: { shiftAmFrom: '16:00' } });
  assert.equal(r.status, 400); assert.ok(r.body.errors.shiftPmFrom, 'الوردية الأولى بعد الثانية');
  r = await mgr.put('/api/config/settings', { values: { shiftPmName: 'صباحي' } });
  assert.equal(r.status, 400); assert.ok(r.body.errors.shiftAmName);
  r = await mgr.put('/api/config/settings', { values: { tz: 'Mars/Olympus' } });
  assert.equal(r.status, 400); assert.ok(r.body.errors.tz);
  r = await mgr.put('/api/config/settings', { values: { hospitalName: '   ' } });
  assert.equal(r.status, 400);
  r = await mgr.put('/api/config/settings', { values: { payoutDay: '29' } });
  assert.equal(r.status, 400);
  // ولا حاجة اتحفظت من الطلبات الغلط
  assert.equal((await client('').get('/api/branding')).body.name, 'مستشفى النور');
});

test('الورديات وبداية اليوم بتتغيّر من الإعدادات', async () => {
  const at = (h, m) => new Date(Date.UTC(2026, 0, 15, h - 2, m)); // القاهرة شتاء = UTC+2
  assert.equal(shiftLabel(at(7, 30)), 'am');
  assert.equal(shiftLabel(at(16, 0)), 'pm');
  assert.equal(shiftLabel(at(22, 0)), 'night');
  const r = await mgr.put('/api/config/settings', { values: { shiftAmFrom: '06:00', shiftPmFrom: '14:00', shiftNightFrom: '20:00', shiftAmName: 'أولى', shiftPmName: 'تانية', shiftNightName: 'تالتة', dayStart: '06:00' } });
  assert.equal(r.status, 200);
  assert.equal(shiftLabel(at(6, 30)), 'am');
  assert.equal(shiftLabel(at(14, 30)), 'pm');
  assert.equal(shiftLabel(at(20, 30)), 'night');
  assert.equal(shiftLabel(at(3, 0)), 'night');
  // 06:30 بقت من نفس اليوم، و05:30 لسه على اليوم اللي فات
  assert.equal(businessDate(at(6, 30)), '2026-01-15');
  assert.equal(businessDate(at(5, 30)), '2026-01-14');
  assert.deepEqual((await client('').get('/api/branding')).body.shiftNames, { am: 'أولى', pm: 'تانية', night: 'تالتة' });
});

test('المنطقة الزمنية من الإعدادات', async () => {
  const d = new Date(Date.UTC(2026, 0, 15, 10, 0));
  assert.equal(cairoMinutes(d), 12 * 60);
  assert.equal((await mgr.put('/api/config/settings', { values: { tz: 'Asia/Tokyo' } })).status, 200);
  assert.equal(cairoMinutes(d), 19 * 60);
  assert.equal((await mgr.put('/api/config/settings', { values: { tz: 'Africa/Cairo' } })).status, 200);
  assert.equal(cairoMinutes(d), 12 * 60);
});

test('الإعدادات القديمة بتتقري من نفس الأماكن (ميعاد الخروج، الخزينة، التذكرة)', async () => {
  const r = await mgr.put('/api/config/settings', { values: { checkoutTime: '13:30', cashierMode: 'off', manualNoRequired: true, ticketMode: false, labVerify: true, doctorTaxPct: '7.5' } });
  assert.equal(r.status, 200);
  const rows = Object.fromEntries((await ctx.db.query('SELECT [Key] AS K, Value FROM AppSettings')).map((x) => [x.K, x.Value]));
  assert.equal(rows.checkoutTime, '13:30');
  assert.equal(rows.cashierMode, 'off');
  assert.equal(rows.manualNoRequired, '1');
  assert.equal(rows.ticketMode, 'off');
  assert.equal(rows.labVerify, '1');
  assert.equal(rows.doctorTaxPct, '7.5');
  assert.equal((await mgr.get('/api/admin/rooms')).body.settings.checkoutTime, '13:30');
  const g = (await mgr.get('/api/config/settings')).body.items;
  assert.equal(g.find((i) => i.key === 'ticketMode').value, false);
  assert.equal(g.find((i) => i.key === 'labVerify').value, true);
});

test('اللوجو: رفع وتحقق من النوع والحجم والمحتوى، ورجوع للافتراضي', async () => {
  let r = await mgr.raw('/api/config/logo', Buffer.from('not an image'), 'image/png');
  assert.equal(r.status, 400);
  r = await mgr.raw('/api/config/logo', PNG, 'text/html');
  assert.equal(r.status, 400);
  r = await mgr.raw('/api/config/logo', Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]), 'image/png');
  assert.ok([400, 413].includes(r.status));
  assert.equal((await rec.raw('/api/config/logo', PNG, 'image/png')).status, 403);
  r = await mgr.raw('/api/config/logo', PNG, 'image/png');
  assert.equal(r.status, 200);
  assert.ok(r.body.logo.custom);
  const logo = await client('').get('/brand/logo');
  assert.equal(logo.type, 'image/png');
  assert.equal(logo.body.length, PNG.length);
  assert.ok((await client('').get('/api/branding')).body.logo.includes('v='));
  r = await mgr.del('/api/config/logo');
  assert.ok(!r.body.logo.custom);
  assert.match((await client('').get('/brand/logo')).type, /svg/);
});

test('الترقيم: يكمّل من رقم تحدده، ومينفعش يرجع لورا', async () => {
  let r = await mgr.get('/api/config/counters');
  const rc = r.body.counters.find((c) => c.name === 'receipt');
  assert.ok(rc && rc.label);
  assert.equal((await rec.get('/api/config/counters')).status, 403);
  r = await mgr.put('/api/config/counters/receipt', { next: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.counters.find((c) => c.name === 'receipt').next, 5000);
  assert.equal(await ctx.db.tx((t) => t.nextNumber('receipt')), 5000);
  assert.equal(await ctx.db.tx((t) => t.nextNumber('receipt')), 5001);
  r = await mgr.put('/api/config/counters/receipt', { next: 100 });
  assert.equal(r.status, 400);
  assert.equal((await mgr.put('/api/config/counters/nope', { next: 10 })).status, 400);
  assert.equal((await mgr.put('/api/config/counters/receipt', { next: 'abc' })).status, 400);
});

test('كل تعديل بيتسجل في سجل التعديلات', async () => {
  const rows = await ctx.db.query("SELECT Action, Note FROM AuditLog WHERE Action IN ('settings.update', 'counter.set')");
  assert.ok(rows.length >= 8);
  assert.ok(rows.some((x) => String(x.Note || '').includes('اسم المستشفى')));
});
