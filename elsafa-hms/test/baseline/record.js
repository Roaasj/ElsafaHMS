// تسجيل النتائج المرجعية. الاستخدام:  node test/baseline/record.js
// بيشغّل السيناريو مرتين ويتأكد إنهم متطابقين (ثبات)، وبعدين بيكتب baseline.golden.json.
// ⚠️ مش بيكتب فوق ملف موجود إلا بـ --force. وأي تغيير في الملف ده لازم يتراجع ويتوافق عليه صاحب النظام (مرجع محاسبي ثابت).
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenario } from './scenario.js';

const FILE = path.join(import.meta.dirname, 'baseline.golden.json');
if (existsSync(FILE) && !process.argv.includes('--force')) {
  console.error('الملف المرجعي موجود: ' + FILE + '\nمش هكتب فوقه. لو متأكد (وبموافقة): node test/baseline/record.js --force');
  process.exit(1);
}
const a = await runScenario();
const b = await runScenario();
const sa = JSON.stringify(a), sb = JSON.stringify(b);
if (sa !== sb) { console.error('السيناريو مش ثابت: التشغيلتين طلعوا مختلفين. مش هسجّل.'); process.exit(2); }
const doc = {
  _about: 'نتائج مرجعية محاسبية ثابتة (Baseline). أي اختلاف غير مفسَّر فيها = فشل المرحلة. اتولّد بـ test/baseline/record.js',
  _recordedWith: { node: process.version, app: JSON.parse(readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')).version, engine: 'sqlite (in-memory)' },
  ...a,
};
writeFileSync(FILE, JSON.stringify(doc, null, 1) + '\n');
console.log('اتسجّل:', FILE, '(' + JSON.stringify(doc).length + ' حرف)');
