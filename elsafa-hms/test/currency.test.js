// إعدادات العملة: التحقق، القفل بعد أول إيصال، وانعكاسها على الإكسل والإعدادات العامة
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { R } from '../src/lib/runtime.js';

let ctx, base, mgr, rec;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b) };
}
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  mgr = client(await login('manager')); rec = client(await login('reception'));
});
after(async () => { ctx.server.close(); await ctx.db.close(); });
const put = (values) => mgr.put('/api/config/settings', { values });

test('الافتراضي جنيه مصري ومتاح للواجهة من غير دخول', async () => {
  const r = await fetch(base + '/api/branding').then((x) => x.json());
  assert.deepEqual(r.currency, { code: 'EGP', decimals: 2, symbol: 'ج', symbolPos: 'after' });
});

test('رفض القيم الغلط: خانات 3 قبل R1c، وكود مش 3 حروف، ومكان رمز غلط', async () => {
  assert.equal((await put({ currencyDecimals: '3' })).status, 400);
  assert.equal((await put({ currencyCode: 'EGPP' })).status, 400);
  assert.equal((await put({ currencyCode: '12A' })).status, 400);
  assert.equal((await put({ currencyPos: 'middle' })).status, 400);
  assert.equal((await put({ currencySymbol: '' })).status, 400);
});

test('تغيير الرمز ومكانه بيوصل للواجهة وتنسيق الإكسل بيتبع الخانات', async () => {
  const r = await put({ currencySymbol: 'ر.س', currencyPos: 'before' });
  assert.equal(r.status, 200);
  const pub = await fetch(base + '/api/branding').then((x) => x.json());
  assert.equal(pub.currency.symbol, 'ر.س'); assert.equal(pub.currency.symbolPos, 'before');
  assert.equal(R.money.xlsxFormat(), '#,##0.00');
  assert.equal((await put({ currencyCode: 'sar' })).body.items.find((i) => i.key === 'currencyCode').value, 'SAR'); // الكود بيتحوّل لحروف كبيرة
});

test('كود العملة وعدد الخانات بيتقفلوا بعد أول إيصال (الرمز لا)', async () => {
  const p = (await rec.post('/api/patients', { name: 'مريض عملة رقم واحد علي', phone: '01067770001', ageYears: 30, sex: 'F', address: 'دمياط', nationalId: '', confirmDuplicatePhone: true })).body.patient;
  const svc = (await rec.get('/api/catalog/services')).body.services.find((s) => s.code === 'LAB-001');
  const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
  const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc.id })).body;
  const pay = await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: d.totals.due, manualNo: 'ع-1' });
  assert.equal(pay.status, 201);
  const locked = await put({ currencyCode: 'USD' });
  assert.equal(locked.status, 400);
  assert.match(locked.body.errors.currencyCode, /اتقفل/);
  assert.equal((await put({ currencyDecimals: '0' })).status, 400);
  assert.equal((await put({ currencySymbol: '﷼' })).status, 200); // الرمز مسموح
  assert.equal((await put({ currencyCode: 'SAR' })).status, 200); // نفس القيمة = مش تغيير
});

test('تقارير الإكسل بتستعمل تنسيق العملة', async () => {
  const r = await mgr.get('/api/finance/expenses/export');
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
  assert.equal(wb.worksheets[0].getColumn(4).numFmt, R.money.xlsxFormat());
});
