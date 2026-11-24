// تثبيت قواعد التقريب الحالية على دوال المنتج الحقيقية (مش نسخ منها). أي تغيير فيها = قرار محاسبي مستقل، مش جزء من تغيير العملة (R1).
// القيم دي هي سلوك v0.16 زي ما هو، بما فيه حالاته الشاذة (الفاصلة العائمة والسالب). التشغيل:  node --test test/baseline/rounding-pins.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, pounds, parseMoney } from '../../src/lib/util.js';
import { servicePrice, nightPrice, cover } from '../../src/lib/coverage.js';

const t = { one: async () => null }; // مفيش أسعار قائمة ولا قواعد استبعاد: بنختبر المعادلات بس

test('تثبيت: cents/pounds (نص لفوق على الفاصلة العائمة)', () => {
  const exp = { 0: 0, 0.005: 1, 0.01: 1, 1.005: 100, 1.015: 101, 1.025: 102, 2.675: 268, 12.345: 1235, 33.33: 3333, 99.99: 9999, 1234.56: 123456, '-2.5': -250, '-0.005': 0, '-1.005': -100, 4.35: 435, 8.2: 820 };
  for (const [v, c] of Object.entries(exp)) assert.equal(cents(Number(v)) + 0, c, `cents(${v})`); // +0: الناتج ممكن يطلع -0 (صفر سالب في JS)، وده بيتخزّن 0
  // حالات شاذة موثّقة: 1.005 و1.015 بيتقرّبوا لتحت لأن 1.005*100 = 100.49999999999999 (نص لفوق على الفاصلة العائمة مش على العشري الدقيق)
  assert.equal(cents(0.1 + 0.2), 30);
  const p = { 0: 0, 1: 0.01, 5: 0.05, 250: 2.5, 3333: 33.33, 8748: 87.48, 29996: 299.96, 100001: 1000.01, '-250': -2.5, '-2472': -24.72 };
  for (const [c, v] of Object.entries(p)) assert.equal(pounds(Number(c)), v, `pounds(${c})`);
});

test('تثبيت: parseMoney (التحقق من إدخال المستخدم)', () => {
  assert.equal(parseMoney('12.34'), 1234); assert.equal(parseMoney('1,234.5'), 123450); assert.equal(parseMoney(''), 0);
  for (const v of ['0.005', '0.0149', '12.3456']) assert.throws(() => parseMoney(v), /كسور أقل من قرش/);
  for (const v of ['-1', 'abc']) assert.throws(() => parseMoney(v), /مش رقم صحيح/);
  // الفاصلة العشرية العربية (٫) مش مدعومة حاليًا: بترفض
  assert.throws(() => parseMoney('٣٣٫٣٣'), /مش رقم صحيح/);
  assert.equal(parseMoney('٣٣.٣٣'), 3333); // الأرقام الهندية مع نقطة لاتينية بتتقبل
});

test('تثبيت: خصم نسبة الجهة لكل وحدة (خدمة وليلة بنفس المعادلة)', async () => {
  const exp = { '3333@12.5': 2916, '9999@12.5': 8749, '3333@7.5': 3083, '1235@33.33': 823, '5@12.5': 4, '25055@50': 12528, '1@50': 1, '3@50': 2, '33@50': 17, '10001@33.33': 6668, '9999@66.67': 3333, '-3333@12.5': -2916, '-1@50': 0, '-3@50': -1 };
  for (const [k, want] of Object.entries(exp)) {
    const [c, p] = k.split('@').map(Number);
    const payer = { priceMode: 'discount', discountPct: p };
    assert.equal((await servicePrice(t, payer, 1, c)) + 0, want, 'service ' + k);
    assert.equal((await nightPrice(t, payer, 1, c)) + 0, want, 'night ' + k);
  }
  // النتيجة للوحدة بتتقرّب الأول وبعدين بتتضرب في الكمية: 3 × 29.16 = 87.48 (مش 87.49)
  assert.equal(3 * 2916, 8748);
  // سالب: نص السالب بيتقرّب ناحية الصفر/+∞ (-0.5 ← 0 و-1.5 ← -1)، مش متماثل مع الموجب
});

test('تثبيت: نصيب الجهة ونصيب المريض (المجموع دايمًا = المبلغ)، والسالب ما بيتغطّاش', async () => {
  const exp = { '3333@33.33': [1111, 2222], '3333@66.67': [2222, 1111], '8748@40': [3499, 5249], '1@50': [1, 0], '3@50': [2, 1], '5@50': [3, 2], '1235@12.5': [154, 1081], '9999@80': [7999, 2000], '25055@50': [12528, 12527], '10001@33.33': [3333, 6668] };
  for (const [k, [pa, pt]] of Object.entries(exp)) {
    const [a, p] = k.split('@').map(Number);
    const r = await cover(t, { coverage: { clinic: p }, visitCap: null, yearCap: null }, { serviceId: 1, dept: 'clinic', amount: a });
    assert.deepEqual([r.payerAmount, r.patientAmount, r.status], [pa, pt, 'covered'], k);
    assert.equal(r.payerAmount + r.patientAmount, a, 'المجموع ' + k);
  }
  for (const a of [-3333, -1, -3]) {
    const r = await cover(t, { coverage: { clinic: 50 }, visitCap: null, yearCap: null }, { serviceId: 1, dept: 'clinic', amount: a });
    assert.deepEqual([r.payerAmount, r.patientAmount, r.status], [0, a, 'none'], 'سالب ' + a);
  }
});

test('تثبيت: Math.round للنص (أساس كل المعادلات)', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map(Math.round).map((x) => x + 0), [1, 2, 3, 0, -1, -2]);
});
