// فحص دقة الأرقام العشرية على SQL Server الحقيقي (الخطوة 1 من R1a).
// بيمرّ بنفس طبقة الربط بتاعة البرنامج (src/db/mssql.js) ويقارن اللي اتخزّن باللي المفروض يتخزّن.
//
// التشغيل (على السيرفر اللي عليه SQL Server، من فولدر البرنامج):
//   node scripts/mssql-precision-check.mjs                 (الإعدادات من .env؛ بيشتغل على tempdb ومبيلمسش بياناتك)
//   node scripts/mssql-precision-check.mjs --schema        (بيقارن كمان أعمدة قاعدة ElsafaHMS الحقيقية بالمتوقع، قراءة بس)
//   node scripts/mssql-precision-check.mjs --db ElsafaHMS  (يشتغل في قاعدة تانية؛ بيعمل جدول مؤقت ويمسحه)
// الناتج: طباعة + ملف precision-check.result.json ابعتهولي. الخروج 0 = كله تمام، 1 = فيه فروق.
import { writeFileSync } from 'node:fs';
import sql from 'mssql';
import { loadConfig } from '../src/config.js';
import { createMssqlDb } from '../src/db/mssql.js';
import { dec } from '../src/db/decimal.js';

const args = process.argv.slice(2).map((x) => (/^-(db|schema)$/.test(x) ? '-' + x : x)); // بيقبل -db و-schema بشرطة واحدة كمان
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cfg = loadConfig().db.mssql;
const target = opt('--db', 'tempdb');
const T = `zz_PrecisionCheck_${process.pid}`;
const results = [];
let bad = 0;

// الأعمدة بالتصميم الحقيقي: (12,2)/(14,2) مبالغ وكميات، (12,4) تكاليف، (5,2) نسب، (18,4) لتوسعة R1c
const COLS = { m12: [12, 2], m14: [14, 2], c12: [12, 4], p5: [5, 2], w18: [18, 4] };
const exp = (v, scale) => { // القيمة المتوقعة بتقريب "نص بعيد عن الصفر" من التمثيل النصي (مستقل عن الفاصلة العائمة)
  const neg = v < 0; const [i, f = ''] = String(Math.abs(v)).split('.');
  let digits = BigInt(i + f.padEnd(scale + 1, '0').slice(0, scale)); const next = Number((f + '0'.repeat(scale + 1))[scale] ?? 0);
  if (next >= 5) digits += 1n;
  const s = digits.toString().padStart(scale + 1, '0');
  return (neg && digits !== 0n ? '-' : '') + s.slice(0, s.length - scale) + (scale ? '.' + s.slice(-scale) : '');
};
const norm = (x) => { const n = String(x); return n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n; };
function record(group, name, input, expected, actual, note = '') {
  const ok = norm(expected) === norm(actual); if (!ok) bad++;
  results.push({ group, name, input: String(input), expected: String(expected), actual: String(actual), ok, note });
  console.log(`${ok ? '✓' : '✗'} [${group}] ${name}  مُدخل=${input}  متوقع=${expected}  فعلي=${actual}${note ? '  (' + note + ')' : ''}`);
}

const server = { server: cfg.server, port: cfg.port ? Number(cfg.port) : undefined, user: cfg.user, password: cfg.password, database: target, instance: cfg.instance, encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate };
let db;
try {
  db = await createMssqlDb({ ...server, skipVersionCheck: target.toLowerCase() === 'tempdb' });
  const info = await db.one('SELECT @@VERSION AS v, DB_NAME() AS d');
  console.log('SQL Server:', String(info.v).split('\n')[0], '| قاعدة الفحص:', info.d, '\n');
  results.push({ group: 'env', name: 'version', actual: String(info.v).split('\n')[0], ok: true, driver: { mssql: (await import('mssql/package.json', { with: { type: 'json' } })).default.version } });
  await db.exec(`CREATE TABLE ${T} (Id INT IDENTITY PRIMARY KEY, Tag NVARCHAR(40), m12 DECIMAL(12,2), m14 DECIMAL(14,2), c12 DECIMAL(12,4), p5 DECIMAL(5,2), w18 DECIMAL(18,4))`);

  // 1) كتابة وقراءة: كل نوع صريح على عموده المناسب + الرقم العادي (من غير نوع)
  const cases = {
    money: [0, 0.01, 0.07, 33.33, 333.34, 1234.5, 902.37, 99999999.99, -12.5, -0.01],
    cost: [0.0001, 2.6633, 3.3, 4.7614, 7.1429, 12345.6789, 99999999.9999],
    pct: [0, 0.01, 7.5, 12.5, 33.33, 66.67, 100, 999.99],
    qty: [0.01, 0.5, 3.25, 12.5, 1000, 123456789.12],
  };
  for (const [kind, col, scale] of [['money', 'm12', 2], ['money', 'm14', 2], ['cost', 'c12', 4], ['pct', 'p5', 2], ['qty', 'm14', 2]]) {
    for (const v of cases[kind]) {
      const [p, s] = COLS[col]; if (Math.abs(v) >= 10 ** (p - s)) continue; // أكبر من سعة العمود
      const id = await db.insert(T, { Tag: `${kind}>${col}`, [col]: dec[kind](v) });
      const r = await db.one(`SELECT CAST(${col} AS VARCHAR(40)) AS x FROM ${T} WHERE Id = ?`, [id]);
      record(`typed-${kind}`, `${col} (${p},${s})`, v, exp(v, s), r.x);
    }
  }
  for (const [col, vals] of [['c12', [7.1429, 2.6633, 4.7614, 0.0001, 12345.6789]], ['p5', [12.5, 33.33, 7.5]], ['m12', [0.07, 33.33, 1234.5, 12.5]]]) {
    for (const v of vals) { // رقم عادي من غير نوع صريح (الكود القديم بيبعت كده): لازم يوصل بدقته الكاملة
      const id = await db.insert(T, { Tag: `plain>${col}`, [col]: v });
      const r = await db.one(`SELECT CAST(${col} AS VARCHAR(40)) AS x FROM ${T} WHERE Id = ?`, [id]);
      record('plain', `${col}`, v, exp(v, COLS[col][1]), r.x, v === 7.1429 ? 'كان بيطلع 7.14 قبل الإصلاح' : '');
    }
  }

  // 2) تقريب العمود نفسه عند تجاوز مقياسه (نص بعيد عن الصفر، هو سلوك SQL Server): مهم نعرف مين بيقرّب
  for (const [col, v, e] of [['m12', 1.005, '1.01'], ['m12', 1.015, '1.02'], ['m12', -0.005, '-0.01'], ['m12', 0.125, '0.13'], ['c12', 7.142857142857143, '7.1429'], ['p5', 12.345, '12.35'], ['m12', 2.675, '2.68']]) {
    const id = await db.insert(T, { Tag: 'colround', [col]: v });
    const r = await db.one(`SELECT CAST(${col} AS VARCHAR(40)) AS x FROM ${T} WHERE Id = ?`, [id]);
    record('column-rounding', col, v, e, r.x, 'تقريب العمود (مش الربط)');
  }

  // 3) تعبيرات UPDATE والمقارنات والتجميع بتمرّ بنفس الربط
  const id = await db.insert(T, { Tag: 'expr', c12: dec.cost(7.1429), m14: dec.qty(10) });
  await db.run(`UPDATE ${T} SET m14 = m14 + ?, c12 = c12 + ? WHERE Id = ?`, [dec.qty(0.25), dec.cost(0.0001), id]);
  let r = await db.one(`SELECT CAST(m14 AS VARCHAR(40)) AS q, CAST(c12 AS VARCHAR(40)) AS c FROM ${T} WHERE Id = ?`, [id]);
  record('expr', 'Qty = Qty + ?', '10 + 0.25', '10.25', r.q); record('expr', 'Cost = Cost + ?', '7.1429 + 0.0001', '7.143', r.c);
  await db.run(`UPDATE ${T} SET m14 = m14 - ? WHERE Id = ?`, [0.25, id]); // رقم عادي (كسر)
  r = await db.one(`SELECT CAST(m14 AS VARCHAR(40)) AS q FROM ${T} WHERE Id = ?`, [id]); record('expr', 'Qty = Qty - 0.25 (عادي)', '10.25 - 0.25', '10', r.q);
  r = await db.one(`SELECT COUNT(*) AS n FROM ${T} WHERE c12 = ?`, [7.143]); record('where', 'c12 = 7.143', 7.143, 1, r.n);
  r = await db.one(`SELECT COUNT(*) AS n FROM ${T} WHERE c12 = ?`, [7.14]); record('where', 'c12 = 7.14 (مفيش تقريب للمقارنة)', 7.14, 0, r.n);
  r = await db.one(`SELECT COUNT(*) AS n FROM ${T} WHERE p5 = ?`, [12.5]); record('where', 'p5 = 12.5', 12.5, 1, r.n >= 1 ? 1 : 0);
  r = await db.one(`SELECT CAST(SUM(m12) AS VARCHAR(40)) AS s FROM ${T} WHERE Tag = 'money>m12'`); const sumExp = cases.money.filter((v) => Math.abs(v) < 1e10).reduce((a, v) => a + Math.round(v * 100), 0);
  record('sum', 'SUM(m12) للمبالغ المسجّلة', 'مجموع بالقروش', (sumExp / 100).toFixed(2), r.s);

  // 4) حدود tedious: قيمة كبيرة مع مقياس عالي (|v × 10^s| قرب 2^53)
  for (const [v, s] of [[123456789012.3456, 4], [99999999999999.99, 2], [9007199254740.99, 2], [1234567890.1234, 4]]) {
    try {
      const id2 = await db.insert(T, { Tag: 'big', w18: dec.cost(v) });
      const rr = await db.one(`SELECT CAST(w18 AS VARCHAR(40)) AS x FROM ${T} WHERE Id = ?`, [id2]);
      record('big', 'w18 (18,4)', v, exp(v, 4), rr.x, 'داخل حدود الدقة الآمنة');
    } catch (e) { record('big', 'w18 (18,4)', v, 'رفض صريح أو قيمة صحيحة', 'استثناء: ' + e.message.slice(0, 80), 'مقبول لو رفض واضح'); results[results.length - 1].ok = /أكبر|DecimalPrecision|Arithmetic|overflow/i.test(e.message); if (results.at(-1).ok) bad--; }
  }

  // 5) قراءة مرتدّة: النوع المرجَّع من السائق (مش بس القيمة)
  const row = await db.one(`SELECT m12, c12, p5 FROM ${T} WHERE Tag = 'plain>c12' ORDER BY Id`);
  record('read', 'c12 بترجع كرقم JS', 7.1429, 7.1429, row.c12, typeof row.c12);
} catch (e) {
  console.error('\nفشل الاتصال/التنفيذ:', e.message); bad++; results.push({ group: 'fatal', name: 'error', actual: e.message, ok: false });
} finally {
  try { await db?.exec(`IF OBJECT_ID('${T}') IS NOT NULL DROP TABLE ${T}`); } catch { /* */ }
}

// 6) مقارنة تصميم أعمدة القاعدة الحقيقية بالمتوقع (قراءة فقط)
if (flag('--schema')) {
  try {
    const real = await createMssqlDb({ ...server, database: cfg.database });
    const rows = await real.query(`SELECT TABLE_NAME t, COLUMN_NAME c, NUMERIC_PRECISION p, NUMERIC_SCALE s FROM INFORMATION_SCHEMA.COLUMNS WHERE DATA_TYPE IN ('decimal','numeric','money','smallmoney','float','real') ORDER BY 1,2`);
    const by = {}; for (const r of rows) { const k = `${r.p},${r.s}`; (by[k] ||= []).push(`${r.t}.${r.c}`); }
    console.log('\nأعمدة الأرقام العشرية في', cfg.database + ':');
    for (const [k, v] of Object.entries(by)) console.log(`  DECIMAL(${k}) × ${v.length}`);
    results.push({ group: 'schema', name: 'decimal columns', actual: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), ok: true, columns: by });
    await real.close();
  } catch (e) { console.error('--schema فشل:', e.message); results.push({ group: 'schema', name: 'error', actual: e.message, ok: false }); bad++; }
}
await db?.close();
writeFileSync('precision-check.result.json', JSON.stringify({ at: new Date().toISOString(), target, failures: bad, results }, null, 1));
console.log(`\n${bad ? '✗ فيه ' + bad + ' فرق' : '✓ كله تمام'} — النتيجة في precision-check.result.json (ابعتهولي)`);
process.exit(bad ? 1 : 0);
