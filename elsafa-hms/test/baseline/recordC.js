// تسجيل الخط الأساسي C (تشغيلات متعددة التكلفة، سالب، تقارير، إكسل). الاستخدام:  node test/baseline/recordC.js   (وبـ --force للكتابة فوق ملف موجود، بموافقة)
// الخطين A وB (baseline.golden.json وbaselineB.golden.json) ما بيتلمسوش.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runScenarioC } from './scenarioC.js';

const FILE = path.join(import.meta.dirname, 'baselineC.golden.json');
if (existsSync(FILE) && !process.argv.includes('--force')) { console.error('الملف موجود: ' + FILE + '\nمش هكتب فوقه إلا بـ --force وبموافقة'); process.exit(1); }
const a = await runScenarioC(); const b = await runScenarioC();
if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('السيناريو C مش ثابت. مش هسجّل.'); process.exit(2); }
const doc = {
  _about: 'خط أساسي C: مبيعات ومرتجعات على تشغيلات متعددة التكلفة، رصيد سالب، تحويلات وإعدام وجرد، تقارير المخزن، وتصدير Excel. أي اختلاف غير مفسَّر = فشل المرحلة. اتولّد بـ test/baseline/recordC.js',
  _recordedWith: { node: process.version, app: JSON.parse(readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')).version, engine: 'sqlite (in-memory)' },
  ...a,
};
writeFileSync(FILE, JSON.stringify(doc, null, 1) + '\n');
console.log('اتسجّل:', FILE, JSON.stringify(doc).length, 'حرف');
