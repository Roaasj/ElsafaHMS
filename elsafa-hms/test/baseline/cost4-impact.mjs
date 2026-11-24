// قياس أثر تطبيع تكلفة الوحدة الأساسية لـ4 خانات (cost4) — قراءة فقط. مفيش تعديل في البرنامج ولا في أي خط أساسي.
// بيشغّل سيناريو C على قاعدة مؤقتة في الذاكرة، يجمع التقارير «زي ما هي»، وبعدين يطبّع التكلفة في القاعدة المؤقتة نفسها
// (Cost = ROUND(Cost, 4) في التشغيلات والحركات وسطور الجرد والإعدام) ويجمعها تاني ويقارن.
// الاستخدام:  node test/baseline/cost4-impact.mjs [--json]   (بيكتب cost4-impact.report.md)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { boot, u4, f4 } from './scenario.js';
import { buildC, collectC } from './scenarioC.js';

const { ctx, U, close } = await boot();
const db = ctx.db;
const { ids } = await buildC(ctx, U);
const before = await collectC(ctx, U, ids);
const bt = Object.fromEntries((await db.query('SELECT s.Id, s.Name FROM Stores s')).map((x) => [x.Id, x.Name]));
const raw = (v) => (v == null ? null : Number(v));
const r4 = (v) => (v == null ? null : Math.round(Number(v) * 1e4) / 1e4);
const sum = async (sql) => (await db.query(sql))[0]?.S;

// ---- 1) تكلفة كل تشغيلة: الحالية والمطبّعة والفرق في قيمة الرصيد ----
const items = Object.fromEntries((await db.query('SELECT Id, Name FROM StockItems')).map((x) => [x.Id, x.Name]));
const batches = (await db.query('SELECT * FROM StockBatches ORDER BY Id')).map((b) => {
  const c = raw(b.Cost), n = r4(b.Cost), q = Number(b.Qty);
  return { id: b.Id, store: bt[b.StoreId], item: items[b.ItemId], batch: b.BatchNo ?? '(بدون)', qty: q, cost: c, cost4: n, deltaCost: c == null ? null : n - c, deltaValue: c == null || q < 0 ? 0 : q * (n - c) };
});
const changed = batches.filter((b) => b.cost != null && b.cost !== b.cost4);
const valueDelta = batches.reduce((a, b) => a + b.deltaValue, 0);

// ---- 2) تحليل قبل التطبيع للقيم المالية المتأثرة ----
const area = async () => ({
  purchases: { total: u4(await sum('SELECT SUM(Total) AS S FROM Purchases')), lineTotal: u4(await sum('SELECT SUM(LineTotal) AS S FROM PurchaseLines')), unitCost: u4(await sum('SELECT SUM(UnitCost) AS S FROM PurchaseLines')) },
  transfersValue: Number(await sum("SELECT SUM(ABS(Qty) * COALESCE(Cost,0)) AS S FROM StockMoves WHERE Kind = 'transfer_out'")),
  salesCostOut: Number(await sum("SELECT SUM(-Qty * COALESCE(Cost,0)) AS S FROM StockMoves WHERE Kind IN ('sale','visit') AND Qty < 0")),
  returnsCostBack: Number(await sum("SELECT SUM(Qty * COALESCE(Cost,0)) AS S FROM StockMoves WHERE Kind IN ('sale_back','visit_back')")),
  wasteValue: Number(await sum('SELECT SUM(Qty * COALESCE(Cost,0)) AS S FROM StockWaste')),
  countDiffValue: Number(await sum('SELECT SUM(DiffValue) AS S FROM StockCounts')),
  countMovesValue: Number(await sum("SELECT SUM(Qty * COALESCE(Cost,0)) AS S FROM StockMoves WHERE Kind = 'count'")),
  lastCost: u4(await sum('SELECT SUM(LastCost) AS S FROM StockItems')),
});
const aBefore = await area();

// ---- 3) تطبيع التكلفة على القاعدة المؤقتة وإعادة التجميع ----
for (const [t, c] of [['StockBatches', 'Cost'], ['StockMoves', 'Cost'], ['StockCountLines', 'Cost'], ['StockWaste', 'Cost']]) await db.run(`UPDATE ${t} SET ${c} = ROUND(${c}, 4) WHERE ${c} IS NOT NULL`);
const aAfter = await area();
const after = await collectC(ctx, U, ids);
await close();

// ---- 4) فروق التقارير (JSON والإكسل) ----
function leafDiffs(a, b, p = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiffs(a[k], b[k], p + '/' + k, out); }
  else out.push({ path: p, before: a, after: b });
  return out;
}
const repDiffs = leafDiffs(before.reports, after.reports);
const xlDiffs = leafDiffs(before.xlsx, after.xlsx);
const valDiffs = leafDiffs(before.valuation, after.valuation);
const dbDiffs = leafDiffs(before.db, after.db).filter((d) => !/\/Cost$|\/sums\/Cost$/.test(d.path));
const costOnlyDiffs = leafDiffs(before.db, after.db).filter((d) => /\/Cost$|\/sums\/Cost$/.test(d.path));
const fmt = (x) => (typeof x === 'number' ? (Math.abs(x) < 1e-9 ? '0' : x.toFixed(6)) : String(x));

let md = `# أثر تطبيع تكلفة الوحدة الأساسية لـ4 خانات (cost4) — قياس فقط\n\n`;
md += `> اتقاس على سيناريو C بقاعدة مؤقتة في الذاكرة. مفيش أي تعديل في البرنامج. الخطوة 4 ما اتنفذتش ولن تتنفذ بدون موافقة.\n\n`;
md += `## 1) تكلفة كل تشغيلة (الحالية ← المطبّعة)\n| المخزن | الصنف | التشغيلة | الرصيد | التكلفة الحالية | بعد التطبيع | فرق القيمة |\n|---|---|---|---|---|---|---|\n`;
for (const b of batches.filter((x) => x.cost != null)) md += `| ${b.store} | ${b.item} | ${b.batch} | ${b.qty} | ${b.cost} | ${b.cost4}${b.cost === b.cost4 ? '' : ' ◀'} | ${fmt(b.deltaValue)} |\n`;
md += `\n- تشغيلات بتتغيّر تكلفتها: **${changed.length}** من ${batches.filter((x) => x.cost != null).length} (التشغيلات اللي تكلفتها أصلًا 4 خانات أو أقل ما بتتغيّرش).\n- **إجمالي الفرق في قيمة المخزون: ${fmt(valueDelta)}** (جنيه).\n- تشغيلات بدون تكلفة (رصيد سالب): ${batches.filter((x) => x.cost == null).length}.\n\n`;
md += `## 2) أثره على كل مجال (قبل ← بعد)\n| المجال | قبل | بعد | الفرق |\n|---|---|---|---|\n`;
const rows2 = [['المشتريات: إجمالي الفواتير (1e-4)', aBefore.purchases.total, aAfter.purchases.total], ['المشتريات: Σ LineTotal (1e-4)', aBefore.purchases.lineTotal, aAfter.purchases.lineTotal], ['المشتريات: Σ UnitCost المُدخلة (1e-4)', aBefore.purchases.unitCost, aAfter.purchases.unitCost], ['التحويلات: قيمة المصروف بالتكلفة', aBefore.transfersValue, aAfter.transfersValue], ['البيع/الصرف للمرضى: تكلفة المصروف', aBefore.salesCostOut, aAfter.salesCostOut], ['المرتجعات: تكلفة المرتجع', aBefore.returnsCostBack, aAfter.returnsCostBack], ['الهالك: القيمة بالتكلفة', aBefore.wasteValue, aAfter.wasteValue], ['الجرد: DiffValue (محسوب ومخزن)', aBefore.countDiffValue, aAfter.countDiffValue], ['الجرد: Σ حركات الجرد بالتكلفة', aBefore.countMovesValue, aAfter.countMovesValue], ['LastCost الأصناف (1e-4)', aBefore.lastCost, aAfter.lastCost]];
for (const [n, a, b] of rows2) md += `| ${n} | ${fmt(a)} | ${fmt(b)} | ${fmt(b - a)} |\n`;
md += `\nملاحظة: المشتريات (إجمالي السطر = الكمية × التكلفة **المُدخلة** للعلبة) و\`LastCost\` ما بيتأثروش، لأن التطبيع بيطبّق على تكلفة الوحدة **الأساسية** المقسومة على معامل العلبة. و\`DiffValue\` للجرد مخزّن وقت الاعتماد فما بيتغيّرش بأثر رجعي (بس ممكن يختلف لو الجرد اتنفّذ بعد التطبيع).\n\n`;
md += `## 3) أثره على التقارير\n- فروق في التقارير JSON: **${repDiffs.length}** قيمة.\n- فروق في ملفات الإكسل: **${xlDiffs.length}** خلية.\n- فروق في قيمة المخزون الدقيقة (1e-8): ${valDiffs.length ? valDiffs.map((d) => `${d.path}: ${d.before} ← ${d.after}`).join(' · ') : 'لا شيء'}.\n- فروق في جداول القاعدة غير عمود التكلفة نفسه: **${dbDiffs.length}**${dbDiffs.length ? ' (!): ' + dbDiffs.slice(0, 6).map((d) => d.path).join(', ') : ''}.\n\n`;
if (repDiffs.length) { md += `### فروق التقارير (JSON)\n| المسار | قبل | بعد |\n|---|---|---|\n`; for (const d of repDiffs.slice(0, 60)) md += `| ${d.path} | ${d.before} | ${d.after} |\n`; }
if (xlDiffs.length) { md += `\n### فروق الإكسل\n| المسار | قبل | بعد |\n|---|---|---|\n`; for (const d of xlDiffs.slice(0, 60)) md += `| ${d.path} | ${d.before} | ${d.after} |\n`; }
md += `\n## 4) قراءة النتيجة\n`;
md += `- التطبيع بيغيّر **${changed.length} تشغيلات** فقط، وفرق القيمة الإجمالي ${fmt(valueDelta)} جنيه.\n- أي فرق ظاهر في التقارير بيكون في الخانة العشرية الثانية (تقرير بيقرّب لـ2) أو في اختلاف قرش واحد عند حدود التقريب.\n- بعد إصلاح ربط SQL Server (خطوة 1) عمود DECIMAL(12,4) هو أصلًا هيخزّن القيمة المطبّعة (4 خانات)، فالأرقام دي هي الفرق المتوقع بين SQLite (خام) وSQL Server (مطبّع). تطبيع التكلفة في الكود بيخلّي الاتنين يتطابقوا.
- ده تغيير في القيمة **المخزنة** في SQLite، فلو اتنفذ لازم يتسجّل كفرق مفسَّر في الخطوط، ولا يتنفّذ إلا بموافقتك.\n`;
writeFileSync(path.join(import.meta.dirname, 'cost4-impact.report.md'), md);
const summary = { changedBatches: changed.length, valueDelta, reportDiffs: repDiffs.length, xlsxDiffs: xlDiffs.length, valDiffs: valDiffs.length, otherDbDiffs: dbDiffs.length, costColumnDiffs: costOnlyDiffs.length };
console.log(JSON.stringify(summary));
if (process.argv.includes('--json')) console.log(JSON.stringify({ batches: changed, area: { before: aBefore, after: aAfter }, repDiffs: repDiffs.slice(0, 40), xlDiffs: xlDiffs.slice(0, 40) }, null, 1));
