// مصفوفة العملات: الحساب والعرض والتحقق على EGP / USD / JPY / KWD (3 خانات: طبقة الحساب بس، التخزين في R1c)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMoney, checkCurrency } from '../shared/money.js';

const CUR = [
  { code: 'EGP', decimals: 2, symbol: 'ج', symbolPos: 'after', f: 100, xl: '#,##0.00', sample: ['1250.5', 125050, '1,250.5 ج'] },
  { code: 'USD', decimals: 2, symbol: '$', symbolPos: 'before', f: 100, xl: '#,##0.00', sample: ['1250.5', 125050, '$ 1,250.5'] },
  { code: 'JPY', decimals: 0, symbol: '¥', symbolPos: 'before', f: 1, xl: '#,##0', sample: ['1250', 1250, '¥ 1,250'] },
  { code: 'KWD', decimals: 3, symbol: 'د.ك', symbolPos: 'after', f: 1000, xl: '#,##0.000', sample: ['1250.5', 1250500, '1,250.5 د.ك'] },
];
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

for (const c of CUR) {
  const M = makeMoney(c);
  test(`${c.code}: ذهاب وعودة، تحقق إدخال، عرض، إكسل`, () => {
    assert.equal(M.F, c.f);
    for (let i = 0; i < 20000; i++) {
      const m = Math.round(rnd() * 1e9);
      assert.equal(M.toMinor(M.fromMinor(m)), m, `roundtrip ${m}`);
      assert.equal(M.parse(String(M.fromMinor(m))), m);
    }
    assert.equal(M.parse(c.sample[0]), c.sample[1]);
    assert.equal(M.parse(c.sample[0].replace(/\d/g, (d) => String.fromCharCode(1632 + Number(d)))), c.sample[1], 'أرقام هندية');
    assert.equal(M.parse('1,000'), 1000 * c.f, 'فواصل آلاف');
    assert.throws(() => M.parse('-1'), /مش رقم/);
    assert.throws(() => M.parse('abc'), /مش رقم/);
    if (c.decimals < 3) assert.throws(() => M.parse(`1.${'1'.repeat(c.decimals + 1)}`), /كسور/);
    assert.equal(M.withSymbol(Number(c.sample[0])), c.sample[2]);
    assert.equal(M.xlsxFormat(), c.xl);
  });

  test(`${c.code}: تقسيم نسب بدون باقي ضايع، وخصم + نسبة = الكل`, () => {
    for (let i = 0; i < 50000; i++) {
      const total = Math.round(rnd() * 1e8) + 1, pct = Math.round(rnd() * 10000) / 100;
      const share = M.percent(total, pct), rest = total - share;
      assert.equal(share + rest, total);
      assert.ok(Number.isInteger(share) && share >= 0 && share <= total);
      const afterDisc = M.discount(total, pct);
      assert.ok(Math.abs((total - afterDisc) - share) <= 1, 'الخصم والنسبة متطابقين لحد وحدة واحدة (تقريب كل منهم لوحده)');
    }
  });

  test(`${c.code}: سيناريو مصغّر (إيصال، خصم، آجل، مرتجع)`, () => {
    // 3 بنود بالوحدة الصغرى: 100.00 و 250.50 و 49.99 (مضروبة في F/100 عشان 0 و3 خانات)
    const k = c.f / 100;
    const items = [10000, 25050, 4999].map((x) => Math.round(x * k));
    const gross = items.reduce((a, b) => a + b, 0);
    const disc = M.percent(gross, 10), net = gross - disc;
    const cash = M.percent(net, 60), credit = net - cash;
    assert.equal(cash + credit, net);
    const refund = M.percent(items[1], 50); // مرتجع نصف البند التاني
    assert.equal(net - refund + refund, net);
    assert.equal(M.fromMinor(gross) * c.f, gross, 'العرض بالوحدة الأساسية يرجع للصغرى');
  });
}

test('3 خانات مرفوضة على قاعدة 2 خانة ومقبولة لما العمود يتوسّع', () => {
  assert.ok(checkCurrency(CUR[3]).errors.decimals);
  assert.ok(checkCurrency(CUR[3], { schemaScale: 3 }).value);
  assert.ok(checkCurrency(CUR[2]).value); // JPY بدون كسور ينفع على أعمدة 2 خانة
});
