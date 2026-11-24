// تصدير الخدمات: بقسم واحد بيطلع القسم ده بس، ومن غير قسم بيطلع كله (زي الأول)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, cookie;
before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'manager', password: 'Safa@2026' }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
after(() => ctx.server.close());

async function rows(qs) {
  const r = await fetch(base + '/api/admin/services/export' + qs, { headers: { cookie } });
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('الخدمات'); const out = [];
  ws.eachRow((row, i) => { if (i > 1 && row.getCell(2).value) out.push({ code: String(row.getCell(1).value), dept: String(row.getCell(3).value) }); });
  return { out, cd: r.headers.get('content-disposition') };
}

test('من غير قسم: كل الأقسام', async () => {
  const { out } = await rows('');
  const depts = new Set(out.map((x) => x.dept));
  assert.ok(depts.size >= 3, 'كل الأقسام: ' + [...depts].join(','));
});
test('قسم واحد: صفوفه بس، وعددها مطابق للقاعدة', async () => {
  const all = (await rows('')).out;
  const { out, cd } = await rows('?dept=lab');
  assert.ok(out.length > 0 && out.length < all.length);
  assert.equal(new Set(out.map((x) => x.dept)).size, 1);
  const n = Number((await ctx.db.one("SELECT COUNT(*) AS N FROM Services WHERE Dept = 'lab'")).N);
  assert.equal(out.length, n);
  assert.ok(decodeURIComponent(cd).includes('خدمات-'), 'اسم الملف فيه القسم');
});
test('قسم مش معروف: رفض', async () => {
  const r = await fetch(base + '/api/admin/services/export?dept=zzz', { headers: { cookie } });
  assert.equal(r.status, 400);
});
