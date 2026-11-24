import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMoney, checkCurrency, DEFAULT_CURRENCY, cost4, pct2, qty2 } from '../shared/money.js';
import { cents, pounds, parseMoney } from '../src/lib/util.js';
import { crossCheck, REGISTRY } from '../src/lib/settings-registry.js';

// التعريفات القديمة حرفيًا (المرجع)
const oldCents = (v) => Math.round(Number(v || 0) * 100);
const oldPounds = (c) => Math.round(c) / 100;
function oldParse(v, label = 'المبلغ') {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} مش رقم صحيح`);
  const c = Math.round(n * 100);
  if (Math.abs(n * 100 - c) > 1e-6) throw new Error(`${label} فيه كسور أقل من قرش`);
  return c;
}
const same = (a, b) => Object.is(a, b);
const outcome = (f) => { try { return { v: f() }; } catch (e) { return { e: e.message }; } };

test('الافتراضي EGP/2 والإعدادات بتتحول لنفسها', () => {
  assert.deepEqual(makeMoney().toJSON(), DEFAULT_CURRENCY);
  assert.ok(REGISTRY.some((s) => s.key === 'currencyCode'));
});

test('cents/pounds مطابقين للقديم على ملايين قيمة عشوائية وحدّية', () => {
  const edge = [0, -0, null, undefined, '', '12.5', 1.005, 1.015, 2.675, 0.1 + 0.2, 1e-9, 123456789.99, 99999999999.99, -5.555, NaN, 'abc', 0.005, 1234.565];
  for (const v of edge) {
    assert.ok(same(cents(v), oldCents(v)), `cents ${v}`);
  }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 2_000_000; i++) {
    const v = i % 3 === 0 ? Math.round(rnd() * 1e8) / 100 : i % 3 === 1 ? rnd() * 1e6 : (rnd() - 0.5) * 1e4;
    if (!same(cents(v), oldCents(v))) assert.fail(`cents ${v}`);
    const c = Math.round(rnd() * 1e10) - 5e9 + (i % 7 === 0 ? 0.5 : 0);
    if (!same(pounds(c), oldPounds(c))) assert.fail(`pounds ${c}`);
  }
});

test('parseMoney مطابق للقديم (قيم وأخطاء)', () => {
  const cases = ['', null, undefined, '0', '12', '12.5', '١٢٣٫٥'.replace('٫', '.'), '1,234.50', '١٢٣', '12.345', '0.001', '-1', 'abc', '1e2', '5e-3', 100, 12.34, 0.1 + 0.2, '  7 ', 'Infinity', '1e400'];
  for (const c of cases) {
    assert.deepEqual(outcome(() => parseMoney(c, 'س')), outcome(() => oldParse(c, 'س')), `parse ${c}`);
  }
  let seed = 99;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 300_000; i++) {
    const s = (rnd() * 1e5).toFixed(i % 4);
    assert.deepEqual(outcome(() => parseMoney(s)), outcome(() => oldParse(s)), s);
  }
});

test('رسالة خطأ parseMoney بتطلع كـ bad (400)', () => {
  assert.throws(() => parseMoney('x', 'السعر'), (e) => e.status === 400 && /السعر/.test(e.message));
});

test('عملات تانية: JPY بدون خانات، KWD 3 خانات', () => {
  const J = makeMoney({ code: 'JPY', decimals: 0, symbol: '¥', symbolPos: 'before' });
  assert.equal(J.toMinor(1500), 1500);
  assert.equal(J.fromMinor(1500), 1500);
  assert.equal(J.withSymbol(1500), '¥ 1,500');
  assert.equal(J.xlsxFormat(), '#,##0');
  assert.throws(() => J.parse('1.5'), /كسور/);
  const K = makeMoney({ code: 'KWD', decimals: 3, symbol: 'د.ك', symbolPos: 'after' });
  assert.equal(K.toMinor(1.234), 1234);
  assert.equal(K.parse('1.234'), 1234);
  assert.equal(K.xlsxFormat(), '#,##0.000');
  const U = makeMoney({ code: 'USD', decimals: 2, symbol: '$', symbolPos: 'before' });
  assert.equal(U.percent(10000, 15), 1500);
  assert.equal(U.discount(10000, 15), 8500);
  assert.equal(U.fmt(1234.5), '1,234.5');
});

test('التحقق من إعدادات العملة', () => {
  assert.ok(checkCurrency(DEFAULT_CURRENCY).value);
  assert.ok(checkCurrency({ ...DEFAULT_CURRENCY, code: 'egp' }).errors.code);
  assert.ok(checkCurrency({ ...DEFAULT_CURRENCY, decimals: 3 }).errors.decimals, '3 خانات مرفوضة قبل R1c');
  assert.ok(checkCurrency({ ...DEFAULT_CURRENCY, decimals: 3 }, { schemaScale: 3 }).value);
  assert.ok(checkCurrency({ ...DEFAULT_CURRENCY, symbolPos: 'x' }).errors.symbolPos);
  const all = Object.fromEntries(REGISTRY.map((d) => [d.key, d.def]));
  assert.deepEqual(crossCheck(all), {});
  assert.ok(crossCheck({ ...all, currencyDecimals: '3' }).currencyDecimals);
});

test('تقريب التكلفة/النسبة/الكمية نفس التعبيرات القديمة', () => {
  for (const v of [0, 1.00005, 2.5, 3.14159, 1e-5, 12.345678]) {
    assert.ok(same(cost4(v), Math.round(v * 1e4) / 1e4));
    assert.ok(same(pct2(v), Math.round(v * 100) / 100));
    assert.ok(same(qty2(v), Math.round(Number(v) * 100) / 100));
  }
});
