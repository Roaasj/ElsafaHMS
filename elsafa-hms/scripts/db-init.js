// إنشاء قاعدة ElsafaHMS على SQL Server أو تحديثها لآخر نسخة
// الاستخدام:  npm run db:init      (الإعدادات من ملف .env)
// آمن تشغيله أكتر من مرة: بينفذ التحديثات الجديدة بس، ومش بيمسح بيانات.
import sql from 'mssql';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';

const cfg = loadConfig().db.mssql;
const dbName = cfg.database;
if (!/^[A-Za-z0-9_]+$/.test(dbName)) { console.error('اسم القاعدة لازم يكون حروف إنجليزي وأرقام بس'); process.exit(1); }
const base = {
  server: cfg.server, port: cfg.port ? Number(cfg.port) : undefined, user: cfg.user, password: cfg.password,
  options: { instanceName: cfg.instance || undefined, encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
};
try {
  const master = await new sql.ConnectionPool({ ...base, database: 'master' }).connect();
  const exists = (await master.request().query(`SELECT DB_ID('${dbName}') AS id`)).recordset[0].id;
  if (!exists) {
    await master.request().batch(`CREATE DATABASE [${dbName}] COLLATE Arabic_CI_AS`);
    console.log(`اتعملت قاعدة ${dbName}`);
  } else console.log(`قاعدة ${dbName} موجودة، هنشوف لو محتاجة تحديث...`);
  await master.close();
  const pool = await new sql.ConnectionPool({ ...base, database: dbName }).connect();
  const v = await migrate(pool, sql);
  console.log(`تمام: القاعدة على النسخة ${v}.`);
  await pool.close();
} catch (e) {
  console.error('حصلت مشكلة:', e.message);
  process.exit(1);
}
