// تطبيق قالب بداية (هوية + إعدادات + لوجو) على قاعدة البيانات.
// الاستخدام:  npm run template -- templates/elsafa.json
// القالب مجرد نقطة بداية: كل اللي فيه بيتعدل بعد كده من شاشة الإعدادات.
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { BY_KEY, REGISTRY, normalize, crossCheck } from '../src/lib/settings-registry.js';
import { readSettings } from '../src/lib/runtime.js';
import { brandDir } from '../src/routes/config.js';

export async function applyTemplate(db, file, config = loadConfig()) {
  const tpl = JSON.parse(readFileSync(file, 'utf8'));
  const stored = await readSettings(db);
  const out = {};
  for (const [k, v] of Object.entries(tpl.settings || {})) {
    const d = BY_KEY[k];
    if (!d) throw new Error(`إعداد غير معروف في القالب: ${k}`);
    const n = normalize(d, v);
    if (n.error) throw new Error(`${k}: ${n.error}`);
    out[k] = n.value;
  }
  const merged = {};
  for (const d of REGISTRY) merged[d.key] = out[d.key] ?? stored[d.key] ?? d.def;
  const errs = crossCheck(merged);
  if (Object.keys(errs).length) throw new Error(Object.values(errs)[0]);
  for (const [k, v] of Object.entries(out)) {
    if (stored[k] != null) await db.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ? WHERE [Key] = ?', [v, new Date(), k]);
    else await db.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date() });
  }
  if (tpl.logo) {
    const src = path.resolve(path.dirname(file), tpl.logo);
    if (!existsSync(src)) throw new Error(`اللوجو مش موجود: ${src}`);
    const dir = brandDir(config);
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, path.join(dir, 'logo' + path.extname(src).toLowerCase().replace('.jpeg', '.jpg')));
  }
  return Object.keys(out).length;
}

if (process.argv[1] && process.argv[1].endsWith('apply-template.js')) {
  const file = process.argv[2];
  if (!file) { console.error('اكتب مسار القالب: npm run template -- templates/elsafa.json'); process.exit(1); }
  const config = loadConfig();
  const db = await createDb(config.db);
  try { console.log(`تمام: اتطبّق القالب (${await applyTemplate(db, file, config)} إعداد). اعمل ريستارت للسيرفر.`); } catch (e) { console.error('فشل:', e.message); process.exitCode = 1; }
  await db.close();
}
