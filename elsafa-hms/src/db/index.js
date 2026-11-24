// طبقة قاعدة البيانات: واجهة واحدة فوق SQL Server (التشغيل) و SQLite (التجربة والاختبارات)
//
//   db.query(sql, params)        -> rows
//   db.one(sql, params)          -> أول صف أو null
//   db.insert(table, obj)        -> Id الجديد
//   db.tx(async (t) => { ... })  -> معاملة كاملة، t فيه نفس الدوال + t.nextNumber(name)
//   db.top(sql, n)               -> يضيف TOP/LIMIT حسب نوع القاعدة
//
// الاستعلامات بتتكتب بـ ? للباراميترز، وبـ SQL مشترك بين الاتنين.

export async function createDb(config) {
  if (config.driver === 'mssql') {
    const { createMssqlDb } = await import('./mssql.js');
    return createMssqlDb(config.mssql);
  }
  const { createSqliteDb } = await import('./sqlite.js');
  return createSqliteDb(config.sqlite);
}

/** تحويل قيم القاعدة لأشكال ثابتة في الكود */
export function toBool(v) {
  return v === true || v === 1 || v === '1';
}

export function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.length === 19 && !s.endsWith('Z') ? s.replace(' ', 'T') + 'Z' : s;
}

export function toDateStr(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
