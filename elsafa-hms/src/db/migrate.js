// تحديثات قاعدة SQL Server: كل ملف في db/mssql رقم نسخة، وبيتنفذ مرة واحدة بس
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const DIR = path.join(ROOT, 'db', 'mssql');

export function migrations() {
  return readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), file: f, path: path.join(DIR, f) }));
}
export const LATEST = () => migrations().at(-1).version;

/** يقسّم السكريبت: بـ GO لو موجودة، وإلا بالـ ; في آخر السطر */
export function splitSql(text) {
  const clean = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const parts = /^\s*GO\s*$/im.test(clean) ? clean.split(/^\s*GO\s*$/im) : clean.split(/;\s*\n/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** النسخة الحالية للقاعدة (0 = فاضية) */
export async function currentVersion(pool, sql) {
  const q = (t) => new sql.Request(pool).query(t);
  const hasVer = (await q("SELECT OBJECT_ID('dbo.SchemaVersion') AS id")).recordset[0].id;
  if (hasVer) {
    const r = (await q('SELECT MAX(Version) AS v FROM SchemaVersion')).recordset[0].v;
    if (r != null) return r;
  }
  const hasUsers = (await q("SELECT OBJECT_ID('dbo.Users') AS id")).recordset[0].id;
  return hasUsers ? 1 : 0; // القواعد اللي اتعملت بنسخة 0.1/0.2 قبل نظام النسخ
}

export async function migrate(pool, sql, log = console.log) {
  await new sql.Request(pool).batch(`IF OBJECT_ID('dbo.SchemaVersion') IS NULL
    CREATE TABLE SchemaVersion (Version INT NOT NULL PRIMARY KEY, AppliedAt DATETIME2(0) NOT NULL)`);
  let cur = await currentVersion(pool, sql);
  if (cur === 1) {
    const has = (await new sql.Request(pool).query('SELECT COUNT(*) AS n FROM SchemaVersion')).recordset[0].n;
    if (!has) await new sql.Request(pool).query('INSERT INTO SchemaVersion (Version, AppliedAt) VALUES (1, SYSUTCDATETIME())');
  }
  const todo = migrations().filter((m) => m.version > cur);
  if (!todo.length) { log(`القاعدة محدّثة (النسخة ${cur}).`); return cur; }
  for (const m of todo) {
    const parts = splitSql(readFileSync(m.path, 'utf8'));
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (let i = 0; i < parts.length; i++) {
        try { await new sql.Request(tx).batch(parts[i]); } catch (e) {
          e.message = `${m.file} (الأمر رقم ${i + 1}: ${parts[i].split('\n')[0].slice(0, 70)}) → ${e.message}`;
          throw e;
        }
      }
      await new sql.Request(tx).query(`INSERT INTO SchemaVersion (Version, AppliedAt) VALUES (${m.version}, SYSUTCDATETIME())`);
      await tx.commit();
      log(`✓ اتنفذ تحديث ${m.file} (${parts.length} أمر)`);
      cur = m.version;
    } catch (e) {
      try { await tx.rollback(); } catch { /* */ }
      throw e;
    }
  }
  return cur;
}
