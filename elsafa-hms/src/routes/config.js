// الإعدادات المنظمة + هوية المستشفى + اللوجو + عدّادات الترقيم
import { router } from '../lib/router.js';
import path from 'node:path';
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync, existsSync, readFileSync } from 'node:fs';
import { need, audit } from '../lib/auth.js';
import { bad } from '../lib/util.js';
import { ROOT } from '../config.js';
import { R, applyRuntime, readSettings } from '../lib/runtime.js';
import { GROUPS, REGISTRY, BY_KEY, LOCKED_AFTER_FINANCIAL, normalize, crossCheck, toView } from '../lib/settings-registry.js';

const COUNTERS = {
  patient: 'رقم ملف المريض', visit: 'رقم الزيارة', receipt: 'رقم الإيصال', admission: 'رقم الدخول', order: 'رقم إذن الدفع',
  study: 'رقم فحص الأشعة', lab: 'رقم طلب المعمل', ticket: 'رقم التذكرة', late: 'رقم المتأخرات', purchase: 'رقم فاتورة الشراء',
  transfer: 'رقم تحويل المخزن', count: 'رقم الجرد', waste: 'رقم الهدر', claim: 'رقم المطالبة', payout: 'رقم صرف الدكاترة',
  voucher: 'رقم إذن الصرف النقدي', expense: 'رقم المصروف', supinv: 'رقم فاتورة المورد',
};
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

export function brandDir(config) { return config.brandDir || path.join(ROOT, 'data', 'branding'); }
function logoFile(dir) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^logo\.(png|jpg|webp)$/.test(n));
  return f ? path.join(dir, f) : null;
}
function refreshLogoVersion(dir) {
  const f = logoFile(dir);
  R.brand.logoVersion = f ? Math.floor(statSync(f).mtimeMs / 1000) : 0;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** لوجو افتراضي بيتولد بلون المستشفى (لحد ما ترفع لوجو بتاعها) */
function defaultLogoSvg() {
  const c = R.brand.primary;
  const letter = esc([...String(R.brand.name).replace(/^(مستشفى|مركز|عيادات)\s+/, '')][0] || 'م');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="58" fill="#fff" stroke="${c}" stroke-width="4"/><circle cx="60" cy="60" r="46" fill="${c}"/><path d="M60 30v60M30 60h60" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".28"/><text x="60" y="76" text-anchor="middle" font-family="Cairo,Tahoma,sans-serif" font-size="46" font-weight="800" fill="#fff">${letter}</text></svg>`;
}

export function publicBrand(config) {
  const dir = brandDir(config);
  refreshLogoVersion(dir);
  const r = router();
  r.get('/branding', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const b = R.brand;
    res.json({
      name: b.name, sub: b.sub, primary: b.primary, accent: b.accent, footer: b.footer,
      modules: R.modules, tz: R.tz, dayStart: R.dayStart, shiftNames: R.shiftNames, currency: R.currency, patientFields: R.patientFields, dx: R.dx, logo: `/brand/logo?v=${b.logoVersion}`,
    });
  });
  r.get('/logo', (req, res) => {
    const f = logoFile(dir);
    res.set('Cache-Control', 'public, max-age=300');
    if (f) return res.type(path.extname(f).slice(1) === 'jpg' ? 'image/jpeg' : `image/${path.extname(f).slice(1)}`).send(readFileSync(f));
    res.type('image/svg+xml').send(defaultLogoSvg());
  });
  return r;
}

export default function configRouter(db, config) {
  const r = router();
  const dir = brandDir(config);

  const view = async () => {
    const stored = await readSettings(db);
    return {
      groups: GROUPS,
      items: REGISTRY.map((d) => ({
        key: d.key, group: d.group, type: d.type, label: d.label, hint: d.hint || null, options: d.options || null,
        min: d.min ?? null, max: d.max ?? null, step: d.step ?? null, value: toView(d, stored[d.key]), def: toView(d, undefined),
        custom: stored[d.key] != null && stored[d.key] !== d.def,
      })),
      logo: { custom: !!logoFile(dir), url: `/brand/logo?v=${R.brand.logoVersion}` },
    };
  };

  r.get('/settings', async (req, res) => { need(req.user, 'settings.manage'); res.json(await view()); });

  r.put('/settings', async (req, res) => {
    need(req.user, 'settings.manage');
    const values = req.body?.values;
    if (!values || typeof values !== 'object') throw bad('مفيش حاجة تتحفظ');
    const stored = await readSettings(db);
    const errors = {}, out = {};
    for (const [k, v] of Object.entries(values)) {
      const d = BY_KEY[k];
      if (!d) continue;
      const n = normalize(d, v);
      if (n.error) errors[k] = n.error; else out[k] = n.value;
    }
    const merged = {};
    for (const d of REGISTRY) merged[d.key] = out[d.key] ?? stored[d.key] ?? d.def;
    Object.assign(errors, crossCheck(merged));
    // كود العملة وعدد الخانات بيتقفلوا بعد أول إيصال (المبالغ المخزنة هتتفسّر غلط)
    const changedLocked = LOCKED_AFTER_FINANCIAL.filter((k) => out[k] != null && out[k] !== (stored[k] ?? BY_KEY[k].def));
    if (changedLocked.length) {
      const used = await db.one('SELECT COUNT(*) AS n FROM Receipts');
      if (Number(used?.n) > 0) for (const k of changedLocked) errors[k] = 'اتقفل لأن فيه معاملات مالية اتسجلت';
    }
    if (Object.keys(errors).length) throw bad('فيه قيم محتاجة تعديل', { errors });
    await db.tx(async (t) => {
      for (const [k, v] of Object.entries(out)) {
        const cur = stored[k];
        if ((cur ?? BY_KEY[k].def) === v) continue;
        if (cur != null) await t.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [v, new Date(), req.user.id, k]);
        else await t.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
        await audit(t, req.user, 'settings.update', 'Settings', null, { old: cur ?? BY_KEY[k].def, now: v, note: BY_KEY[k].label });
      }
    });
    applyRuntime(await readSettings(db));
    res.json(await view());
  });

  // ----- اللوجو (ملف raw) -----
  r.post('/logo', async (req, res) => {
    need(req.user, 'settings.manage');
    const ext = LOGO_TYPES[String(req.headers['content-type'] || '').split(';')[0]];
    const buf = req.body;
    if (!ext || !Buffer.isBuffer(buf) || !buf.length) throw bad('ارفع صورة PNG أو JPG أو WEBP');
    if (buf.length > 1024 * 1024) throw bad('الصورة أكبر من 1 ميجا');
    if (!MAGIC[ext].every((b, i) => buf[i] === b)) throw bad('الملف مش صورة صحيحة');
    mkdirSync(dir, { recursive: true });
    for (const n of existsSync(dir) ? readdirSync(dir) : []) if (/^logo\./.test(n)) unlinkSync(path.join(dir, n));
    writeFileSync(path.join(dir, `logo.${ext}`), buf);
    refreshLogoVersion(dir);
    await db.tx((t) => audit(t, req.user, 'settings.update', 'Settings', null, { note: 'غيّر لوجو المستشفى' }));
    res.json(await view());
  });
  r.delete('/logo', async (req, res) => {
    need(req.user, 'settings.manage');
    const f = logoFile(dir);
    if (f) unlinkSync(f);
    refreshLogoVersion(dir);
    await db.tx((t) => audit(t, req.user, 'settings.update', 'Settings', null, { note: 'رجّع اللوجو الافتراضي' }));
    res.json(await view());
  });

  // ----- عدّادات الترقيم -----
  const counters = async () => {
    const rows = await db.query('SELECT Name, Value FROM Counters ORDER BY Name');
    return { counters: rows.map((c) => ({ name: c.Name, label: COUNTERS[c.Name] || c.Name, last: Number(c.Value), next: Number(c.Value) + 1 })) };
  };
  r.get('/counters', async (req, res) => { need(req.user, 'settings.manage'); res.json(await counters()); });
  r.put('/counters/:name', async (req, res) => {
    need(req.user, 'settings.manage');
    const name = String(req.params.name);
    const next = Number(req.body?.next);
    if (!Number.isInteger(next) || next < 1 || next > 2e9) throw bad('اكتب رقم صحيح', { errors: { next: 'رقم مش صحيح' } });
    await db.tx(async (t) => {
      const c = await t.one('SELECT Value FROM Counters WHERE Name = ?', [name]);
      if (!c) throw bad('العدّاد مش موجود');
      if (next - 1 < Number(c.Value)) throw bad(`مينفعش ترجع لورا. آخر رقم اتصدر ${c.Value}`, { errors: { next: `أقل رقم مسموح ${Number(c.Value) + 1}` } });
      await t.run('UPDATE Counters SET Value = ? WHERE Name = ?', [next - 1, name]);
      await audit(t, req.user, 'counter.set', 'Counter', null, { old: Number(c.Value) + 1, now: next, note: COUNTERS[name] || name });
    });
    res.json(await counters());
  });
  return r;
}
