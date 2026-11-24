// الإعدادات من ملف .env (جنب package.json) أو من متغيرات البيئة
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig(overrides = {}) {
  loadEnvFile();
  const e = process.env;
  const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));
  return {
    port: Number(e.PORT || 3000),
    sessionHours: Number(e.SESSION_HOURS || 12),
    cookieSecure: bool(e.COOKIE_SECURE, false),
    cookieName: e.COOKIE_NAME || 'elsafa_sid', // اسم مختلف لكل نسخة على نفس السيرفر عشان الكوكيز ما تتخلطش
    db: {
      driver: (e.DB_DRIVER || 'sqlite').toLowerCase(),
      sqlite: { file: e.SQLITE_FILE || path.join(ROOT, 'data', 'elsafa-demo.db') },
      mssql: {
        server: e.MSSQL_SERVER || 'localhost',
        port: e.MSSQL_PORT,
        instance: e.MSSQL_INSTANCE,
        database: e.MSSQL_DATABASE || 'ElsafaHMS',
        user: e.MSSQL_USER,
        password: e.MSSQL_PASSWORD,
        encrypt: bool(e.MSSQL_ENCRYPT, false),
        trustServerCertificate: bool(e.MSSQL_TRUST_CERT, true),
      },
    },
    ...overrides,
  };
}
