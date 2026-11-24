// الخط الأساسي C: (1) مقارنة بالنتائج المسجّلة، (2) نتائج متوقعة محسوبة يدويًا ومستقلة (FIFO والمرتجعات والسالب)، (3) قيود سلامة، (4) فحص الإكسل.
// التشغيل:  node --test test/baseline/baselineC.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenarioC } from './scenarioC.js';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, 'baselineC.golden.json'), 'utf8'));
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
test('تشغيل السيناريو C', async () => { now = JSON.parse(JSON.stringify(await runScenarioC())); assert.ok(now.steps.length > 20); });
for (const section of ['steps', 'known', 'checkpoints', 'valuation', 'db', 'reports', 'xlsx']) {
  test(`خط أساسي C: ${section}`, () => { const d = diffs(golden[section], now[section]); assert.equal(d.length, 0, `اختلافات غير مفسَّرة في ${section} (${d.length}):\n` + d.slice(0, 25).join('\n')); });
}

// ---- نتائج متوقعة محسوبة يدويًا (من غير أي كود من المنتج) ----
// المخزن 3 = الصيدلية، 12 = الطوارئ. الأصناف: 1 سيفترياكسون، 43 أموكسي أقراص، 6 كيتورولاك، 25 كانيولا.
const key = (store, item, batch) => `${store}:${item}:${batch}`;
test('متوقع: أرصدة التشغيلات بعد المبيعات والمرتجعات (FIFO بالأقرب انتهاءً)', () => {
  // سيفترياكسون: C1=10 وC2=8 وC3=20. بيع 15 (C1 10 + C2 5)، مرتجع 7 (آخر اللي اتصرف يرجع الأول: C2 5 ثم C1 2)،
  // بيع 20 (C1 2 + C2 8 + C3 10)، مرتجع 10 (كلها على C3 لأنها آخر اللي اتصرف) ⇒ C1=0 وC2=0 وC3=20
  // أموكسي: A1=42 وA2=28. بيع 28 (A1) ثم 21 (A1 14 + A2 7)، مرتجع 14 (A2 7 ثم A1 7) ⇒ A1=7 وA2=28
  // كيتورولاك K1=3. كانيولا: بيع/تعديل/شيل/إلغاء كلها بترجّع لنفس التشغيلات ⇒ N1=50 وN2=20
  const exp = { [key(3, 1, 'C1')]: '0.0000', [key(3, 1, 'C2')]: '0.0000', [key(3, 1, 'C3')]: '20.0000', [key(3, 43, 'A1')]: '7.0000', [key(3, 43, 'A2')]: '28.0000', [key(3, 6, 'K1')]: '3.0000', [key(3, 25, 'N1')]: '50.0000', [key(3, 25, 'N2')]: '20.0000' };
  for (const [k, v] of Object.entries(exp)) assert.equal(now.checkpoints.afterSales[k], v, k);
});
test('متوقع: الرصيد السالب (بيع 5 والرصيد 3) ثم تسديده بالاستلام', () => {
  const c = now.checkpoints.afterNegative;
  assert.equal(c[key(3, 6, 'K1')], '0.0000');
  // التشغيلة السالبة (-2) اتسدّدت بالاستلام (6): 2 سدّدوها و4 دخلوا K2
  assert.equal(c[key(3, 6, 'K2')], '4.0000');
  const loose = Object.entries(c).filter(([k]) => k.startsWith('3:6:loose#'));
  assert.equal(loose.length, 1); assert.equal(loose[0][1], '0.0000');
  const m = now.db.StockMoves.rows.filter((x) => x.ItemId === 6);
  const neg = m.find((x) => x.Kind === 'sale' && x.Cost === null);
  assert.equal(neg.Qty, '-2.0000'); // الجزء اللي اتباع على السالب بدون تكلفة
  assert.equal(m.find((x) => x.Kind === 'receive' && x.BatchId === neg.BatchId).Qty, '2.0000');
});
test('متوقع: التحويل متعدد التشغيلات والإعدام', () => {
  // تحويل 22 قرص: A1 7 (الأقرب انتهاءً) + A2 15 ⇒ PH: A1=0 وA2=13، الطوارئ: A1=7 وA2=15، وبنفس التكلفة
  const t = now.checkpoints.afterTransfer;
  assert.deepEqual([t[key(3, 43, 'A1')], t[key(3, 43, 'A2')], t[key(12, 43, 'A1')], t[key(12, 43, 'A2')]], ['0.0000', '13.0000', '7.0000', '15.0000']);
  const mv = now.db.StockMoves.rows;
  assert.deepEqual(mv.filter((x) => x.Kind === 'transfer_in').map((x) => [x.Qty, x.Cost]), [['7.0000', '7.1429'], ['15.0000', '4.7614']]);
  assert.equal(now.checkpoints.afterWaste[key(3, 43, 'A2')], '11.5000'); // 13 - 1.5
  assert.deepEqual(mv.filter((x) => x.Kind === 'waste').map((x) => [x.Qty, x.Cost]), [['-1.5000', '4.7614']]);
});
test('متوقع: تكلفة كل حركة صرف = تكلفة تشغيلتها (3.3 / 3.45 / 3.555 / 7.1429 / 4.7614 / 1.75 / 1.9)', () => {
  const batch = Object.fromEntries(now.db.StockBatches.rows.map((b) => [b.Id, b.BatchNo]));
  const expected = { C1: '3.3000', C2: '3.4500', C3: '3.5550', A1: '7.1429', A2: '4.7614', N1: '1.7500', N2: '1.9000', K1: '2.6633', K2: '2.7000' };
  for (const m of now.db.StockMoves.rows.filter((x) => ['sale', 'sale_back', 'visit', 'transfer_out'].includes(x.Kind) && x.Cost !== null)) assert.equal(m.Cost, expected[batch[m.BatchId]], `${m.Kind} ${batch[m.BatchId]}`);
});
test('متوقع: تسلسل صرف FIFO لبيع 20 فيال (C1 2 ثم C2 8 ثم C3 10)', () => {
  const batch = Object.fromEntries(now.db.StockBatches.rows.map((b) => [b.Id, b.BatchNo]));
  const seq = now.db.StockMoves.rows.filter((x) => x.Kind === 'sale' && x.RefType === 'visititem' && now.db.VisitItems.rows.find((v) => v.Id === x.RefId)?.UnitFactor === 10).map((x) => [batch[x.BatchId], x.Qty]);
  assert.deepEqual(seq, [['C1', '-2.0000'], ['C2', '-8.0000'], ['C3', '-10.0000']]);
});
// ---- قيود سلامة ----
test('سلامة: رصيد كل تشغيلة = مجموع حركاتها', () => {
  const sum = {};
  for (const m of now.db.StockMoves.rows) sum[m.BatchId] = (sum[m.BatchId] || 0) + Math.round(Number(m.Qty) * 1e4);
  for (const b of now.db.StockBatches.rows) assert.equal(Math.round(Number(b.Qty) * 1e4), sum[b.Id] || 0, `تشغيلة ${b.Id} (${b.BatchNo})`);
});
test('سلامة: صافي حركات كل بند زيارة = -(المباع - المرتجع) × معامل الوحدة (والملغي/المحذوف صافيه صفر)', () => {
  const net = {};
  for (const m of now.db.StockMoves.rows.filter((x) => x.RefType === 'visititem')) net[m.RefId] = (net[m.RefId] || 0) + Math.round(Number(m.Qty) * 1e4);
  for (const it of now.db.VisitItems.rows.filter((x) => x.StockItemId)) {
    const expect = it.Status === 'active' ? -(Number(it.Qty) - Number(it.ReturnedQty)) * Number(it.UnitFactor) * 1e4 : 0;
    assert.equal(net[it.Id] || 0, expect, `بند ${it.Id} حالة ${it.Status}`);
  }
});
test('سلامة: قيمة المخزون في التقرير = Σ(رصيد × تكلفة) بفرق أقل من قرشين (التكلفة مخزنة خام)', () => {
  const rep = now.reports.value.body.stores;
  const per = now.valuation.byStore;
  for (const s of rep) {
    const v = (per[s.id]?.posValueU8 || 0) / 1e8;
    assert.ok(Math.abs(s.cost - v) < 0.02, `مخزن ${s.id}: التقرير ${s.cost} والحساب ${v}`);
  }
});
test('سلامة: تقرير الراكد بيطلع الجوانتي والسرنجة المؤرّخين فقط، والمنتهي بيطلع السرنجة', () => {
  const st = now.reports.stagnant90.body.items.map((x) => x.name).sort();
  assert.deepEqual(st, ['جوانتي فحص', 'سرنجة 5 مل']);
  const exp = now.reports.expiry90.body.batches;
  assert.ok(exp.some((b) => b.name === 'سرنجة 5 مل' && b.expired === true));
});
// ---- الإكسل ----
test('إكسل: كل ملف اتفتح وفيه صفوف، وتنسيق الأرقام بيتثبّت (#,##0.00 للمبالغ)', () => {
  for (const [k, sheets] of Object.entries(now.xlsx)) {
    assert.ok(Array.isArray(sheets), `${k}: مفتحش (${JSON.stringify(sheets)})`);
    assert.ok(sheets.every((s) => s.rows.length >= 1), k);
    for (const s of sheets) for (const f of Object.values(s.numFmts).flat()) assert.ok(['General', '#,##0.00'].includes(f), `${k}: تنسيق غير متوقع ${f}`);
  }
  for (const k of ['value', 'consumptionStores', 'pharmacyDays', 'expenses']) assert.ok(Object.values(now.xlsx[k][0].numFmts).flat().includes('#,##0.00'), k + ' من غير تنسيق مبالغ');
});
test('إكسل: إجمالي قيمة المخزون في الملف = إجمالي التقرير', () => {
  const rows = now.xlsx.value[0].rows; const last = rows[rows.length - 1];
  assert.ok(last.map((x) => (typeof x === 'string' ? x : '')).some((x) => x.includes('الإجمالي')));
  assert.ok(last.some((x) => x === now.reports.value.body.totals.cost || x === Number(now.reports.value.body.totals.cost)), `آخر صف ${JSON.stringify(last)}`);
});
