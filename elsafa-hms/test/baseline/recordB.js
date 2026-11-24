// تسجيل الخط الأساسي B (مخازن/مشتريات/أقساط/سندات). الاستخدام:  node test/baseline/recordB.js   (وبـ --force للكتابة فوق ملف موجود، بموافقة)
// الخط الأصلي (baseline.golden.json) ما بيتلمسش.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenarioB } from './scenarioB.js';

const FILE = path.join(import.meta.dirname, 'baselineB.golden.json');
if (existsSync(FILE) && !process.argv.includes('--force')) { console.error('الملف موجود: ' + FILE + '\nمش هكتب فوقه إلا بـ --force وبموافقة'); process.exit(1); }
const a = await runScenarioB(); const b = await runScenarioB();
if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('السيناريو B مش ثابت. مش هسجّل.'); process.exit(2); }
const doc = {
  _about: 'خط أساسي B: مخازن ومشتريات وتحويلات وجرد وهالك وأقساط وسداد سندات. أي اختلاف غير مفسَّر = فشل المرحلة. اتولّد بـ test/baseline/recordB.js',
  _recordedWith: { node: process.version, app: JSON.parse(readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')).version, engine: 'sqlite (in-memory)' },
  ...a,
};
writeFileSync(FILE, JSON.stringify(doc, null, 1) + '\n');
console.log('اتسجّل:', FILE, JSON.stringify(doc).length, 'حرف');
