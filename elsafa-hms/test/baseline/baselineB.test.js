// الخط الأساسي B: (1) مقارنة بالنتائج المسجّلة، (2) نتائج متوقعة محسوبة يدويًا ومستقلة، (3) قيود سلامة (المخزون = مجموع الحركات، التحويلات بتحافظ على الكمية).
// التشغيل:  node --test test/baseline/baselineB.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenarioB } from './scenarioB.js';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, 'baselineB.golden.json'), 'utf8'));
delete golden._about; delete golden._recordedWith;
/** التواريخ (ISO وdd/mm/yyyy) بتتوحّد قبل المقارنة: التاريخ نفسه مش جزء من الحساب، فالاختبار ما يتأثرش بيوم التشغيل */
const noDate = (s) => s.replace(/\d{4}-\d{2}-\d{2}/g, '<D>').replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '<D>');
function diffs(a, b, p = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (typeof a === 'string' && typeof b === 'string' && noDate(a) === noDate(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], p + '/' + k, out); }
  else out.push(`${p}: المرجعي=${JSON.stringify(a)} الحالي=${JSON.stringify(b)}`);
  return out;
}
let now;
test('تشغيل السيناريو B', async () => { now = JSON.parse(JSON.stringify(await runScenarioB())); assert.ok(now.steps.length > 30); });
for (const section of ['steps', 'known', 'db', 'reports']) {
  test(`خط أساسي B: ${section}`, () => { const d = diffs(golden[section], now[section]); assert.equal(d.length, 0, `اختلافات غير مفسَّرة في ${section} (${d.length}):\n` + d.slice(0, 25).join('\n')); });
}

// ---- نتائج متوقعة محسوبة يدويًا (من غير أي كود من المنتج) ----
const rows = (t) => now.db[t].rows;
test('متوقع: إجماليات المشتريات', () => {
  const tot = rows('Purchases').map((p) => p.Total);
  // 1) 5×33 + 7×3.45 + 3×100 + 4×33.33 + 10×7.99 + 2×100 = 165 + 24.15 + 300 + 133.32 + 79.90 + 200
  assert.equal(tot[0], '902.3700');
  // 2) 6×87.5 + 3×55.55 + 2×33.33 + 12.5×1.15 = 525 + 166.65 + 66.66 + 14.375
  //    المحاسبة الدقيقة نص لفوق = 14.38 (إجمالي 772.69)، لكن الكود الحالي بيطلّع 14.37 (772.68) بسبب الفاصلة العائمة: 12.5*1.15 = 14.374999999999998.
  //    ده السلوك الحالي المثبَّت. تغييره قرار محاسبي منفصل.
  assert.equal(tot[1], '772.6800');
  // 3) رصيد أول المدة: 20×3.3 + 30×2.6633 (=79.899 ← 79.90)
  assert.equal(tot[2], '145.9000');
});
test('متوقع: تكلفة الوحدة الأساسية 4 خانات', () => {
  const l = rows('PurchaseLines');
  const byBatch = Object.fromEntries(rows('StockBatches').map((b) => [b.BatchNo, b.Cost]));
  assert.equal(byBatch['AM-1'], '7.1429'); // 100 ÷ 14
  assert.equal(byBatch['CF-1'], '3.3000'); // 33 ÷ 10
  assert.equal(byBatch['AM-2'], '4.7614'); // 33.33 ÷ 7 = 4.761428..
  assert.equal(byBatch['KT-1'], '2.6633'); // 7.99 ÷ 3
  assert.ok(l.length === 12);
});
test('متوقع: الأقساط (القسمة بالقروش والباقي في آخر قسط)', () => {
  const i = rows('ObligationInstallments');
  assert.deepEqual(i.slice(0, 3).map((x) => x.Amount), ['333.3300', '333.3400', '333.3500']); // 1000.01 ÷ 3 = 333.33+333.33+333.35، والتاني اتعدّل لـ 333.34
  assert.deepEqual(i.slice(3).map((x) => x.Amount), ['333.3300', '0.0700', '1234.5000']);
});
test('متوقع: الإذونات والخزينة', () => {
  const v = rows('CashVouchers');
  assert.equal(v.filter((x) => x.Status === 'paid').length, 2);
  assert.equal(v.filter((x) => x.Status === 'cancelled').length, 1);
  assert.equal(now.db.CashVouchers.sums.Amount, 7667600); // 333.33 + 333.33 + 100.10 = 766.76 (بوحدة 1e-4)
});
test('متوقع: الإعدام والجرد', () => {
  assert.deepEqual(rows('StockWaste').map((w) => [w.Qty, w.Cost]), [['5.0000', '7.1429'], ['3.2500', '2.6633']]);
  assert.equal(rows('StockCounts')[0].Status, 'approved');
});
test('متوقع: القيود المرفوضة', () => {
  const st = (n) => now.steps.find((s) => s.name.includes(n)).status;
  assert.equal(st('مستلزم في مخزن أدوية'), 400); assert.equal(st('سعر سالب'), 400); assert.equal(st('إعدام أكبر من الرصيد'), 400); assert.equal(st('تحويل أكبر من الرصيد'), 409);
  assert.equal(st('تحويل مباشر بدون صلاحية'), 403); assert.equal(st('دفع نفس القسط تاني'), 409); assert.equal(st('حذف التزام'), 409);
});
// ---- قيود سلامة ----
test('سلامة: رصيد كل تشغيلة = مجموع حركاتها', () => {
  const sumByBatch = {};
  for (const m of rows('StockMoves')) sumByBatch[m.BatchId] = (sumByBatch[m.BatchId] || 0) + Math.round(Number(m.Qty) * 1e4);
  for (const b of rows('StockBatches')) assert.equal(Math.round(Number(b.Qty) * 1e4), sumByBatch[b.Id] || 0, `تشغيلة ${b.Id}`);
});
test('سلامة: التحويلات محافظة على الكمية (خروج + دخول = 0 للمؤكَّد والملغي)', () => {
  const net = {};
  for (const m of rows('StockMoves').filter((x) => x.Kind.startsWith('transfer'))) net[m.ItemId] = (net[m.ItemId] || 0) + Math.round(Number(m.Qty) * 1e4);
  for (const [item, v] of Object.entries(net)) assert.equal(v, 0, `صنف ${item} ما اتحافظش على كميته في التحويلات`);
});
