// ربط الأرقام العشرية في SQL Server (من غير سيرفر): أنواع صريحة مبالغ/تكلفة/نسبة/كمية، ودقة الربط نفسها (النوع والمقياس مش اسم النوع بس).
// الاختبار الحقيقي على SQL Server: scripts/mssql-precision-check.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import sql from 'mssql';
import { bind } from '../src/db/mssql.js';
import { dec, scaleOf, describeNumber, DecimalPrecisionError, Dec } from '../src/db/decimal.js';
import { createSqliteDb } from '../src/db/sqlite.js';

/** بنربط قيمة ونرجّع وصف الباراميتر: { t: نوع، p: دقة، s: مقياس، v: قيمة } */
function b(v, strict = false) {
  const old = process.env.DB_STRICT_DECIMAL;
  if (strict) process.env.DB_STRICT_DECIMAL = '1'; else delete process.env.DB_STRICT_DECIMAL;
  try {
    const req = new sql.Request(); bind(req, 'SELECT ?', [v]);
    const p = req.parameters.p0;
    return { t: p.type.declaration, p: p.precision, s: p.scale, v: p.value };
  } finally { if (old === undefined) delete process.env.DB_STRICT_DECIMAL; else process.env.DB_STRICT_DECIMAL = old; }
}
const dc = (p, s, v) => ({ t: 'decimal', p, s, v });

test('مبالغ (money): المقياس من النوع مش من الرقم', () => {
  assert.deepEqual(b(dec.money(33.33)), dc(19, 2, 33.33));
  assert.deepEqual(b(dec.money(0.07)), dc(19, 2, 0.07));
  assert.deepEqual(b(dec.money(1234.5)), dc(19, 2, 1234.5)); // خانة واحدة في الرقم، المقياس 2 من النوع
  assert.deepEqual(b(dec.money(-12.5)), dc(19, 2, -12.5));
  assert.deepEqual(b(dec.money(0)), dc(19, 2, 0));
  assert.deepEqual(b(dec.money(-0)), dc(19, 2, 0)); // -0 ← 0
  assert.deepEqual(b(dec.money('1,234.56')), dc(19, 2, 1234.56));
  assert.deepEqual(b(dec.money(12.345, { round: true })), dc(19, 2, 12.35)); // تقريب صريح بس
  assert.deepEqual(b(dec.money(0.125, { scale: 3 })), dc(19, 3, 0.125)); // عملة 3 خانات (بعد R1c)
});
test('مبالغ: ممنوع التقريب الصامت', () => {
  assert.throws(() => dec.money(12.345), DecimalPrecisionError);
  assert.throws(() => dec.money(0.1 + 0.2), DecimalPrecisionError); // ضجيج الفاصلة العائمة
  assert.throws(() => dec.money(NaN), DecimalPrecisionError);
  assert.throws(() => dec.money('abc'), DecimalPrecisionError);
  assert.throws(() => dec.money(1e14), DecimalPrecisionError); // أكبر من اللي الربط بيتحمّله
  assert.equal(dec.money(null), null); assert.equal(dec.money(undefined), null); assert.equal(dec.money(''), null);
});
test('تكاليف (cost): 4 خانات', () => {
  assert.deepEqual(b(dec.cost(7.1429)), dc(19, 4, 7.1429));
  assert.deepEqual(b(dec.cost(2.6633)), dc(19, 4, 2.6633));
  assert.deepEqual(b(dec.cost(3.3)), dc(19, 4, 3.3)); // المقياس 4 حتى لو الرقم خانة واحدة
  assert.deepEqual(b(dec.cost(100 / 14, { round: true })), dc(19, 4, 7.1429));
  assert.throws(() => dec.cost(100 / 14), DecimalPrecisionError); // 7.142857142857143 خام
  assert.throws(() => dec.cost(7.14285), DecimalPrecisionError);
  assert.throws(() => dec.cost(1, { scale: 5 }), DecimalPrecisionError);
});
test('نسب (pct): خانتين', () => {
  for (const x of [12.5, 33.33, 7.5, 100, 0, 66.67]) assert.deepEqual(b(dec.pct(x)), dc(19, 2, x), String(x));
  assert.throws(() => dec.pct(12.345), DecimalPrecisionError);
  assert.deepEqual(b(dec.pct(12.345, { round: true })), dc(19, 2, 12.35));
});
test('كميات (qty): خانتين', () => {
  for (const x of [0.5, 3.25, 12.5, 1000, 0.01]) assert.deepEqual(b(dec.qty(x)), dc(19, 2, x), String(x));
  assert.throws(() => dec.qty(0.125), DecimalPrecisionError);
  assert.throws(() => dec.qty(dec.money(5)), DecimalPrecisionError); // نوع غلط
});
test('رقم عادي (من غير نوع): بيتربط بدقته الفعلية، مش (12,2) ثابتة', () => {
  assert.equal(b(5).t, 'int');
  assert.deepEqual(b(12.5), dc(19, 1, 12.5));
  assert.deepEqual(b(33.33), dc(19, 2, 33.33));
  assert.deepEqual(b(0.125), dc(19, 3, 0.125));
  assert.deepEqual(b(7.1429), dc(19, 4, 7.1429)); // قبل الإصلاح كان بيتقرّب 7.14
  assert.deepEqual(b(0.0000001), dc(19, 7, 1e-7));
  assert.deepEqual(b(-2.6633), dc(19, 4, -2.6633));
  assert.deepEqual(b(2147483647), { t: 'int', p: undefined, s: undefined, v: 2147483647 });
  assert.deepEqual(b(2147483648), dc(19, 0, 2147483648));
  assert.deepEqual(b(123456789012.3456), dc(19, 4, 123456789012.3456));
});
test('رقم عادي: الضجيج العائم والقيم غير الصالحة', () => {
  assert.ok(b(100 / 14).s >= 14); // مش بيتقرّب في الربط (العمود هو اللي يقرّب)
  assert.throws(() => b(100 / 14, true), DecimalPrecisionError); // وضع الاختبار الصارم بيكشفه
  assert.doesNotThrow(() => b(7.1429, true));
  assert.throws(() => b(NaN), DecimalPrecisionError); assert.throws(() => b(Infinity), DecimalPrecisionError);
  // مقياس مقيَّد بحد tedious الآمن (|v × 10^s| < 2^53): بيتقصّ بدل ما يتحوّل لقيمة غلط
  const big = b(1e12 + 0.123456789);
  assert.ok(big.s <= 3 && Math.abs(big.v * 10 ** big.s) <= Number.MAX_SAFE_INTEGER);
});
test('خاصية: ولا رقم بياخد مقياس أقل من مقياسه الفعلي (حتى 8 خانات)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    const s = Math.floor(rnd() * 9), ip = Math.floor(rnd() * 1e6), frac = Math.floor(rnd() * 10 ** s);
    const v = (ip * 10 ** s + frac) / 10 ** s * (rnd() < 0.3 ? -1 : 1);
    if (Number.isInteger(v)) continue;
    assert.equal(b(v).s, scaleOf(v), String(v));
  }
});
test('أنواع أخرى بتفضل زي ما هي', () => {
  assert.equal(b(true).t, 'bit'); assert.equal(b('نص').t, 'nvarchar'); assert.equal(b(new Date(0)).t, 'datetime2'); assert.equal(b(null).v, null);
  assert.throws(() => bind(new sql.Request(), 'SELECT ?', [1, 2]));
});

// ---- ترميز tedious الفعلي: القيمة اللي هتوصل للسيرفر (بدون سيرفر) ----
const require = createRequire(import.meta.url);
const { writeDecimal } = require('tedious/lib/data-types/decimal-common.js');
function wire(value, precision, scale) {
  const out = { bytes: [] };
  const buf = { writeUInt8: (x) => out.bytes.push(['u8', x]), writeUInt32LE: (x) => out.bytes.push(['u32', x]), writeBigUInt64LE: (x) => out.bytes.push(['u64', x]) };
  writeDecimal(buf, value, precision, scale, 'DECIMAL');
  const mag = out.bytes.slice(2).reduce((a, [t, x], i) => a + (BigInt(x) << BigInt(64 * i)), 0n); // little-endian
  return { sign: out.bytes[1][1] === 0 ? -1n : 1n, mag };
}
/** القيمة العشرية الدقيقة من تمثيل الرقم النصي (مستقل عن ضرب الفاصلة العائمة) */
function exact(v, scale) {
  const neg = v < 0; const [i, f = ''] = String(Math.abs(v)).split('.');
  return (neg ? -1n : 1n) * BigInt(i + f.padEnd(scale, '0').slice(0, scale));
}
test('ترميز السلك: القيمة اللي بتتبعت = القيمة العشرية الدقيقة (مبالغ وتكاليف ونسب وكميات)', () => {
  let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [kind, scale, max] of [['money', 2, 1e11], ['cost', 4, 1e9], ['pct', 2, 100], ['qty', 2, 1e8]]) {
    for (let i = 0; i < 5000; i++) {
      const v = Math.round((rnd() * max) * 10 ** scale) / 10 ** scale * (rnd() < 0.2 ? -1 : 1);
      const d = dec[kind](v); const w = wire(d.value, 19, d.scale);
      assert.equal(w.mag * w.sign, exact(d.value, d.scale) || 0n, `${kind} ${v}`);
    }
  }
  // حالات حدّية معروفة بتتعبّر بالفاصلة العائمة
  for (const [v, s] of [[1.005, 3], [0.07, 2], [1.15, 2], [4.35, 2], [8.2, 2], [33.33, 2], [7.1429, 4], [2.6633, 4], [0.1, 4], [1234567.8901, 4]]) {
    const w = wire(v, 19, s); assert.equal(w.mag, exact(v, s), String(v));
  }
});
test('SQLite: القيم الصريحة بتتحوّل لرقم عادي وبتتقرا زي ما هي', async () => {
  const db = await createSqliteDb({ file: ':memory:' });
  const r = await db.one('SELECT ? AS m, ? AS c, ? AS p, ? AS q', [dec.money(33.33), dec.cost(7.1429), dec.pct(12.5), dec.qty(3.25)]);
  assert.deepEqual([r.m, r.c, r.p, r.q], [33.33, 7.1429, 12.5, 3.25]);
  assert.ok(new Dec('money', 1, 2) instanceof Dec);
  await db.close();
});
test('describeNumber مباشرة', () => {
  assert.deepEqual(describeNumber(5), { kind: 'int' });
  assert.equal(describeNumber(12.5).scale, 1);
  assert.equal(scaleOf(1e-7), 7); assert.equal(scaleOf(1.5e-10), 11); assert.equal(scaleOf(100), 0);
});

test('mssql insert: جداول من غير Id (AppSettings/Counters) مفيهاش OUTPUT INSERTED.Id', async () => {
  const { hasIdColumn } = await import('../src/db/mssql.js');
  const calls = [];
  const exec = async (text, params) => { calls.push([text, params]); return String(params[0]).endsWith('AppSettings') || String(params[0]).endsWith('Counters') ? [] : [{ x: 1 }]; };
  assert.equal(await hasIdColumn(exec, 'AppSettings'), false);
  assert.equal(await hasIdColumn(exec, 'dbo.Counters'), false);
  assert.equal(await hasIdColumn(exec, 'Visits'), true);
  const n = calls.length; await hasIdColumn(exec, 'Visits'); await hasIdColumn(exec, 'AppSettings');
  assert.equal(calls.length, n, 'النتيجة بتتخزّن (مفيش استعلام تاني)');
  await assert.rejects(() => hasIdColumn(exec, 'X; DROP TABLE Y'), /غير صالح/);
});
