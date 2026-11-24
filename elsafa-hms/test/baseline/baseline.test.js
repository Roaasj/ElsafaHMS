// مقارنة النتائج الحالية بالخط الأساسي المسجَّل. أي اختلاف = فشل (إلا لو اتفسّر ووافق عليه المالك وتم تسجيل خط جديد).
// التشغيل:  node --test test/baseline/baseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenario } from './scenario.js';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, 'baseline.golden.json'), 'utf8'));
delete golden._about; delete golden._recordedWith;

/** قايمة الاختلافات بمسار واضح (علشان نعرف الاختلاف فين بالظبط) */
/** التواريخ (ISO وdd/mm/yyyy) بتتوحّد قبل المقارنة: التاريخ نفسه مش جزء من الحساب، فالاختبار ما يتأثرش بيوم التشغيل */
const noDate = (s) => s.replace(/\d{4}-\d{2}-\d{2}/g, '<D>').replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '<D>');
function diffs(a, b, p = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (typeof a === 'string' && typeof b === 'string' && noDate(a) === noDate(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], p + '/' + k, out);
  } else out.push(`${p}: المرجعي=${JSON.stringify(a)} الحالي=${JSON.stringify(b)}`);
  return out;
}

let now;
test('تشغيل السيناريو المحاسبي الثابت', async () => { now = JSON.parse(JSON.stringify(await runScenario())); assert.ok(now.steps.length > 20); });
/** فروق مفسَّرة ومعتمدة: إصلاح payers.js (الخطوة صفر). الخط المرجعي نفسه (baseline.golden.json) ما اتغيّرش.
 *  قبل الإصلاح: الـAPI كان بيحفظ 0 من نسب التغطية. بعده: بيحفظ كلها. ده الفرق الوحيد المسموح، وبشرط إن المحفوظ = المُرسَل بالظبط. */
function explainedKnown(g, n) {
  return g.map((x, i) => (/^تغطية جهة/.test(x.name) && x.saved === 0 && n[i] && n[i].saved === n[i].sent && n[i].sent === x.sent ? { ...x, saved: n[i].saved } : x));
}
for (const section of ['steps', 'known', 'db', 'byType', 'reports', 'rounding', 'words']) {
  test(`خط أساسي: ${section}`, () => {
    const d = diffs(section === 'known' ? explainedKnown(golden.known, now.known) : golden[section], now[section]);
    assert.equal(d.length, 0, `اختلافات غير مفسَّرة في ${section} (${d.length}):\n` + d.slice(0, 25).join('\n'));
  });
}
