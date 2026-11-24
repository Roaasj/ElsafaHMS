// محوّل SQL Server (التشغيل الحقيقي على سيرفر المستشفى)
import sql from 'mssql';
import { Dec, describeNumber, KINDS } from './decimal.js';

const STRICT = () => process.env.DB_STRICT_DECIMAL === '1';

export function bind(req, text, params = []) {
  let i = 0;
  const out = text.replace(/\?/g, () => {
    const name = 'p' + i;
    const v = params[i++];
    if (v === undefined || v === null) req.input(name, sql.NVarChar, null);
    else if (v instanceof Date) req.input(name, sql.DateTime2(0), v);
    else if (typeof v === 'boolean') req.input(name, sql.Bit, v);
    else if (v instanceof Dec) req.input(name, sql.Decimal(KINDS[v.kind].precision, v.scale), v.value); // نوع صريح: دقته معروفة قبل الإرسال
    else if (typeof v === 'number') {
      // رقم عادي: بيتربط بدقته الفعلية (مش Decimal(12,2) ثابتة). التقريب الوحيد بيحصل عند العمود نفسه
      const d = describeNumber(v, { strict: STRICT() });
      if (d.kind === 'int') req.input(name, sql.Int, v);
      else req.input(name, sql.Decimal(d.precision, d.scale), v);
    } else req.input(name, sql.NVarChar, String(v));
    return '@' + name;
  });
  if (i !== params.length) throw new Error(`Param count mismatch: ${i} placeholders, ${params.length} params`);
  return out;
}

export const topSql = (text, n) => text.replace(/^\s*SELECT(\s+DISTINCT)?/i, (m, d) => `SELECT${d || ''} TOP (${Number(n) | 0})`);

/** هل الجدول له عمود Id؟ (مخزّن في الذاكرة لكل جدول؛ شكل الجداول ثابت بعد الهجرة) */
const ID_CACHE = new Map();
export async function hasIdColumn(exec, table) {
  const t = String(table).replace(/^dbo\./i, '');
  if (!/^\w+$/.test(t)) throw new Error('اسم جدول غير صالح: ' + table);
  if (!ID_CACHE.has(t)) {
    const r = await exec("SELECT 1 AS x FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = 'Id'", ['dbo.' + t]);
    ID_CACHE.set(t, r.length > 0);
  }
  return ID_CACHE.get(t);
}

export async function createMssqlDb(cfg) {
  const pool = new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port ? Number(cfg.port) : undefined,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: {
      instanceName: cfg.instance || undefined,
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      useUTC: true,
    },
    pool: { max: 20, min: 1, idleTimeoutMillis: 30000 },
  });
  await pool.connect();
  const { currentVersion, LATEST } = await import('./migrate.js');
  const ver = cfg.skipVersionCheck ? LATEST() : await currentVersion(pool, sql); // سكربتات الفحص على tempdb بتتخطى التحقق
  if (ver < LATEST()) {
    await pool.close();
    throw new Error(`القاعدة محتاجة تحديث (النسخة ${ver} والبرنامج محتاج ${LATEST()}). شغّل: npm run db:init`);
  }

  const api = (owner) => {
    const exec = async (text, params) => {
      const req = new sql.Request(owner);
      const q = bind(req, text, params);
      const r = await req.query(q);
      return r.recordset ?? [];
    };
    return {
      dialect: 'mssql',
      query: (text, params) => exec(text, params),
      one: async (text, params) => (await exec(text, params))[0] ?? null,
      run: async (text, params) => {
        const req = new sql.Request(owner);
        const r = await req.query(bind(req, text, params));
        return r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0;
      },
      insert: async (table, obj) => {
        const cols = Object.keys(obj);
        // جداول من غير عمود Id (AppSettings, Counters): مفيش OUTPUT INSERTED.Id — بنرجّع null (SQLite بيرجّع rowid لكن مفيش حد بيستخدمه)
        if (!(await hasIdColumn(exec, table))) {
          await exec(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => obj[c]));
          return null;
        }
        const text = `INSERT INTO ${table} (${cols.join(', ')}) OUTPUT INSERTED.Id VALUES (${cols.map(() => '?').join(', ')})`;
        const rows = await exec(text, cols.map((c) => obj[c]));
        return rows[0].Id;
      },
      top: topSql,
    };
  };

  const db = api(pool);
  db.tx = async (fn) => {
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    const t = api(tx);
    t.nextNumber = async (name) => {
      const rows = await t.query('UPDATE Counters SET Value = Value + 1 OUTPUT INSERTED.Value WHERE Name = ?', [name]);
      if (!rows.length) throw new Error('Counter not found: ' + name);
      return rows[0].Value;
    };
    try {
      const out = await fn(t);
      await tx.commit();
      return out;
    } catch (e) {
      try { await tx.rollback(); } catch { /* المعاملة اتقفلت بالفعل */ }
      throw e;
    }
  };
  db.close = () => pool.close();
  db.exec = async (text) => { await new sql.Request(pool).batch(text); };
  return db;
}
