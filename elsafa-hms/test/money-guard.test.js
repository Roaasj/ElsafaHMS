// حارس الكود: ممنوع تعبيرات فلوس/عملة ثابتة خارج shared/money.js (غير النسب والكميات المعروفة).
// القايمة المسموحة صغيرة وبتتأكد إنها لسه موجودة (لو اتشالت من الكود الاختبار بيفشل ويطلب تنضيفها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_FILES = new Set(['shared/money.js', 'shared/tafqeet.js' /* كلمات العملة: R1b */, 'src/lib/settings-registry.js' /* القيم الافتراضية للعملة */]);
function* walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) { if (n === 'vendor' || n === 'node_modules') continue; yield* walk(p); } else if (n.endsWith('.js')) yield p;
  }
}
const files = [...['src', 'public/js', 'shared'].flatMap((d) => [...walk(path.join(ROOT, d))])]
  .map((p) => path.relative(ROOT, p).replaceAll('\\', '/')).filter((f) => !SKIP_FILES.has(f));

// ما يُعتبر خرق
const FORBIDDEN = [
  ['ضرب/قسمة على 100 (فلوس؟ استعمل R.money / HMS.money)', /[*/] ?100\b/],
  ['toFixed(2) أو FractionDigits: 2', /toFixed\(2\)|FractionDigits: ?2/],
  ['تنسيق إكسل ثابت', /#,##0\.00/],
  ['كود EGP ثابت', /\bEGP\b/],
  ['«جنيه» ثابتة (استعمل unitWord)', /(^|[^ء-ي])جنيه/],
  ['«ج» ثابتة بعد رقم (استعمل symbol)', /[})>] ج(?![ء-ي])|'ج'|"ج"/],
];
// مسموح: نسبة مئوية (a / b) * 100
const PERCENT_G = /\/ [\w.]+\)\s*\*\s*100/g;
// مسموح بسطر معيّن (ملف + جزء من السطر + السبب)
const ALLOW = [
  ['public/js/core.js', 's * 100, l * 100', 'ألوان HSL'],
  ['public/js/core.js', 'left = Math.round(left * 100) / 100', 'كمية في الجرد مش مبلغ'],
  ['public/js/views/stores.js', 'l.counted - l.systemQty) * 100) / 100', 'فرق كمية جرد'],
  ['public/js/views/settings.js', 'u.dataset.up) / 100', 'زيادة % على السعر بتتقرّب لجنيه كامل'],
  ['src/lib/barcode.js', 'toFixed(2)', 'إحداثيات SVG للباركود'],
  ['src/lib/eta.js', 'Math.round(n * 100) / 100', 'تقريب مصلحة الضرائب (إيصال إلكتروني)'],
  ['src/lib/eta.js', 'cfg.vatPct / 100', 'نسبة الضريبة'],
  ['src/lib/eta.js', "currency: 'EGP'", 'عملة الإيصال الإلكتروني ثابتة EGP بمتطلبات المصلحة'],
];

test('مفيش تعبيرات فلوس أو عملة ثابتة خارج money.js', () => {
  const hits = [], used = new Set();
  for (const f of files) {
    readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      for (const [why, re] of FORBIDDEN) {
        if (!re.test(line)) continue;
        if (re === FORBIDDEN[0][1] && !re.test(line.replace(PERCENT_G, ''))) continue; // كل المواضع نسب مئوية
        const a = ALLOW.findIndex(([af, snip]) => af === f && line.includes(snip));
        if (a >= 0) { used.add(a); continue; }
        hits.push(`${f}:${i + 1} — ${why}\n   ${line.trim().slice(0, 140)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `\n${hits.join('\n')}\n`);
  const stale = ALLOW.filter((_, i) => !used.has(i)).map((a) => `${a[0]}: ${a[1]}`);
  assert.deepEqual(stale, [], 'عناصر في القايمة المسموحة مش موجودة في الكود، شيلها');
});
