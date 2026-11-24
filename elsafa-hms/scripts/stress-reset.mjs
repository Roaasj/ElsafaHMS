// بيمسح قاعدة التجربة بس (لازم اسمها فيه Stress) عشان كل تشغيل للسيناريو يبدأ من الصفر. مش بيلمس قاعدة التشغيل أبدًا
import sql from 'mssql';
import { loadConfig } from '../src/config.js';
const cfg = loadConfig().db.mssql;
if (!/stress/i.test(String(cfg.database)) || !/^[A-Za-z0-9_]+$/.test(cfg.database)) { console.error('رفضت: اسم القاعدة لازم يحتوي Stress:', cfg.database); process.exit(3); }
const pool = await new sql.ConnectionPool({ server: cfg.server, port: cfg.port ? Number(cfg.port) : undefined, user: cfg.user, password: cfg.password, database: 'master',
  options: { instanceName: cfg.instance || undefined, encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate } }).connect();
const ex = (await pool.request().query(`SELECT DB_ID('${cfg.database}') AS id`)).recordset[0].id;
if (ex) { await pool.request().batch(`ALTER DATABASE [${cfg.database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${cfg.database}];`); console.log('اتمسحت قاعدة التجربة القديمة', cfg.database); }
else console.log('مفيش قاعدة تجربة قديمة');
await pool.close();
