// محوّل SQLite (مدمج في Node 22) - للتجربة على أي جهاز وللاختبارات الآلية
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Dec } from './decimal.js';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/schema.sqlite.sql');

function conv(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Dec) return v.value; // نوع صريح (dec.money...) بيتحوّل لرقم عادي في SQLite
  return v;
}

/** قفل بسيط: SQLite اتصال واحد، فالمعاملات لازم تمشي واحدة ورا التانية */
function makeLock() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.then(() => {}, () => {});
    return run;
  };
}

export async function createSqliteDb({ file = ':memory:' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const fresh = file === ':memory:' || !existsSync(file);
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  if (fresh) raw.exec(readFileSync(SCHEMA, 'utf8'));
  else if (!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='LookupValues'").get()) {
    raw.close();
    throw new Error('قاعدة التجربة (SQLite) من نسخة قديمة. امسح فولدر data وشغّل npm run seed:demo تاني.');
  }
  const lock = makeLock();

  const api = (inTx) => {
    const exec = (sql, params = []) => raw.prepare(sql).all(...params.map(conv)).map((r) => ({ ...r }));
    const wrap = (fn) => (inTx ? Promise.resolve().then(fn) : lock(fn));
    return {
      dialect: 'sqlite',
      query: (sql, params) => wrap(() => exec(sql, params)),
      one: (sql, params) => wrap(() => exec(sql, params)[0] ?? null),
      run: (sql, params = []) => wrap(() => Number(raw.prepare(sql).run(...params.map(conv)).changes)),
      insert: (table, obj) => wrap(() => {
        const cols = Object.keys(obj);
        const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        const r = raw.prepare(sql).run(...cols.map((c) => conv(obj[c])));
        return Number(r.lastInsertRowid);
      }),
      top: (sql, n) => `${sql} LIMIT ${Number(n) | 0}`,
    };
  };

  const db = api(false);
  db.tx = (fn) => lock(async () => {
    raw.exec('BEGIN IMMEDIATE');
    const t = api(true);
    t.nextNumber = async (name) => {
      raw.prepare('UPDATE Counters SET Value = Value + 1 WHERE Name = ?').run(name);
      const row = raw.prepare('SELECT Value FROM Counters WHERE Name = ?').get(name);
      if (!row) throw new Error('Counter not found: ' + name);
      return Number(row.Value);
    };
    try {
      const out = await fn(t);
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  });
  db.close = async () => raw.close();
  db.exec = async (sql) => lock(() => raw.exec(sql));
  return db;
}
