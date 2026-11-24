// قايمة وحدات الأصناف: بتتملا من الوحدات الموجودة فعلًا في الأصناف (مرة واحدة)، والوحدة الجديدة بتتضاف من «إدارة الوحدات»
const DEFAULTS = ['علبة', 'شريط', 'قرص', 'أمبول', 'فيال', 'زجاجة', 'كيس', 'قطعة', 'سم', 'متر'];

export async function seedUnits(db) {
  if (Number((await db.one('SELECT COUNT(*) AS N FROM StockUnits'))?.N)) return 0;
  const rows = await db.query('SELECT Unit, MidUnit, PackUnit FROM StockItems');
  const seen = new Set();
  for (const r of rows) for (const k of ['Unit', 'MidUnit', 'PackUnit']) { const n = String(r[k] || '').replace(/\s+/g, ' ').trim(); if (n) seen.add(n); }
  const names = seen.size ? [...seen] : DEFAULTS;
  let i = 1;
  for (const n of names) await db.insert('StockUnits', { Name: n, Active: 1, SortOrder: i++ });
  return names.length;
}
/** أي وحدة جديدة جاية من إكسل أو API بتتسجّل في القايمة (عشان تظهر في القوائم) */
export async function ensureUnits(t, names) {
  for (const raw of names) {
    const n = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!n) continue;
    if (!(await t.one('SELECT Id FROM StockUnits WHERE Name = ?', [n]))) await t.insert('StockUnits', { Name: n, Active: 1, SortOrder: 999 });
  }
}
