// القوائم المرجعية: قراءة للكل (الواجهة بتبني منها الأقسام والألوان)، وإدارة للمدير
import { router } from '../lib/router.js';
import { need, audit } from '../lib/auth.js';
import { bad, notFound, intId } from '../lib/util.js';
import { DOMAINS, LK, loadLookups, publicView, rowsOf } from '../lib/lookups.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const ICON_CHOICES = ['steth', 'bolt', 'flask', 'scan', 'bed', 'scalpel', 'heart', 'baby', 'pill', 'box', 'shield', 'sparkle', 'user', 'users', 'layers', 'door', 'clipboard', 'tag'];
const NAME = /^[^<>]{1,100}$/;

export function lookupsPublic() {
  const r = router();
  r.get('/lookups', (req, res) => { res.set('Cache-Control', 'no-cache'); res.json(publicView()); });
  return r;
}

/** كام سجل شغّال بيستخدم القيمة دي (للمنع من الحذف وتغيير السلوك) */
async function usage(db, domain, code) {
  const n = async (sql) => Number((await db.one(sql, [code]))?.n || 0);
  if (domain === 'dept') {
    return (await n('SELECT COUNT(*) AS n FROM Services WHERE Dept = ?'))
      + (await n('SELECT COUNT(*) AS n FROM Visits WHERE Type = ?'))
      + (await n('SELECT COUNT(*) AS n FROM Stores WHERE Dept = ?'));
  }
  if (domain === 'admission_type') return n('SELECT COUNT(*) AS n FROM Admissions WHERE Type = ?');
  if (domain === 'room_kind') {
    // أنواع الدخول المربوطة بالنوع ده (من الكاش: من غير دمج نصوص في SQL علشان يشتغل على المحركين)
    return (await n('SELECT COUNT(*) AS n FROM RoomClasses WHERE Kind = ?'))
      + LK.rows.filter((x) => x.domain === 'admission_type' && x.meta.roomKind === code).length;
  }
  return 0;
}

function clean(domain, b, cur) {
  const D = DOMAINS[domain];
  const errors = {};
  const name = String(b.name ?? cur?.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || !NAME.test(name)) errors.name = 'اكتب الاسم (لحد 100 حرف)';
  const short = String(b.short ?? cur?.short ?? name).replace(/\s+/g, ' ').trim().slice(0, 40) || name;
  const color = String(b.color ?? cur?.color ?? '#6b7280').trim();
  if (!HEX.test(color)) errors.color = 'اللون مش صحيح';
  const icon = String(b.icon ?? cur?.icon ?? 'layers');
  if (!ICON_CHOICES.includes(icon)) errors.icon = 'اختار أيقونة من القايمة';
  let behavior = null;
  if (D.behaviors) {
    behavior = String(b.behavior ?? cur?.behavior ?? '');
    if (!D.behaviors[behavior]) errors.behavior = 'اختار السلوك';
  }
  const meta = { ...(cur?.meta || {}) };
  if (domain === 'dept') {
    const prefix = String(b.prefix ?? meta.prefix ?? '').toUpperCase().trim();
    if (!/^[A-Z]{2,4}$/.test(prefix)) errors.prefix = 'بادئة كود الخدمة: 2 لـ 4 حروف إنجليزي (مثلًا PT)';
    else if (LK.rows.some((r) => r.domain === 'dept' && r.meta.prefix === prefix && r.id !== cur?.id)) errors.prefix = 'البادئة دي مستخدمة في قسم تاني';
    meta.prefix = prefix;
    const inpatient = behavior === 'ward' || behavior === 'or';
    meta.visit = inpatient ? false : (b.visit ?? meta.visit ?? true) === true || b.visit === 'true' || b.visit === 1;
    if (b.visit === false || b.visit === 'false' || b.visit === 0) meta.visit = false;
    const pay = b.pay ?? meta.pay ?? (behavior === 'emergency' ? 'after' : 'before');
    if (!['before', 'after'].includes(pay)) errors.pay = 'القيمة مش صحيحة';
    meta.pay = pay;
  } else if (domain === 'admission_type') {
    const rk = String(b.roomKind ?? meta.roomKind ?? '');
    if (!rowsOf('room_kind').find((r) => r.code === rk)) errors.roomKind = 'اختار نوع الغرفة';
    meta.roomKind = rk;
  }
  return { errors, v: { name, short, color: color.toLowerCase(), icon, behavior, meta } };
}

const nextCode = (domain) => {
  const p = DOMAINS[domain].codePrefix;
  const nums = LK.rows.filter((r) => r.domain === domain && new RegExp(`^${p}\\d+$`).test(r.code)).map((r) => Number(r.code.slice(p.length)));
  return `${p}${(nums.length ? Math.max(...nums) : 0) + 1}`;
};

export default function lookupsAdmin(db) {
  const r = router();
  const guard = (req) => need(req.user, 'settings.manage');

  const view = async () => {
    const out = {};
    for (const [d, D] of Object.entries(DOMAINS)) {
      const items = [];
      for (const x of rowsOf(d)) items.push({ ...x, used: await usage(db, d, x.code) });
      out[d] = {
        title: D.title, single: D.single, hint: D.hint, icon: D.icon,
        behaviors: D.behaviors ? Object.entries(D.behaviors).map(([k, [name, hint]]) => ({ key: k, name, hint })) : null,
        items,
      };
    }
    return { domains: out, icons: ICON_CHOICES };
  };
  const done = async (res) => res.json(await view());

  r.get('/', async (req, res) => { guard(req); await done(res); });

  r.post('/:domain', async (req, res) => {
    guard(req);
    const domain = req.params.domain;
    if (!DOMAINS[domain]) throw notFound('القايمة مش موجودة');
    const { errors, v } = clean(domain, req.body || {}, null);
    if (Object.keys(errors).length) throw bad('فيه بيانات محتاجة تعديل', { errors });
    if (rowsOf(domain).some((x) => x.name === v.name)) throw bad('الاسم ده موجود', { errors: { name: 'الاسم ده موجود' } });
    const code = nextCode(domain);
    const sort = Math.max(0, ...rowsOf(domain).map((x) => x.sort)) + 10;
    await db.tx(async (t) => {
      await t.insert('LookupValues', {
        Domain: domain, Code: code, Name: v.name, ShortName: v.short, Color: v.color, Icon: v.icon, Behavior: v.behavior,
        SortOrder: sort, Active: 1, Meta: JSON.stringify(v.meta),
      });
      await audit(t, req.user, 'lookup.create', 'Lookup', null, { now: `${domain}:${code}`, note: v.name });
    });
    await loadLookups(db);
    await done(res);
  });

  r.put('/item/:id', async (req, res) => {
    guard(req);
    const cur = LK.rows.find((x) => x.id === intId(req.params.id));
    if (!cur) throw notFound('القيمة مش موجودة');
    const { errors, v } = clean(cur.domain, req.body || {}, cur);
    if (Object.keys(errors).length) throw bad('فيه بيانات محتاجة تعديل', { errors });
    if (rowsOf(cur.domain).some((x) => x.name === v.name && x.id !== cur.id)) throw bad('الاسم ده موجود', { errors: { name: 'الاسم ده موجود' } });
    if (v.behavior !== cur.behavior && (await usage(db, cur.domain, cur.code)) > 0) {
      throw bad('ده عليه شغل فعلًا، مينفعش يتغيّر سلوكه. أوقفه واعمل واحد جديد', { errors: { behavior: 'عليه شغل فعلًا' } });
    }
    await db.tx(async (t) => {
      await t.run('UPDATE LookupValues SET Name = ?, ShortName = ?, Color = ?, Icon = ?, Behavior = ?, Meta = ? WHERE Id = ?',
        [v.name, v.short, v.color, v.icon, v.behavior, JSON.stringify(v.meta), cur.id]);
      await audit(t, req.user, 'lookup.update', 'Lookup', cur.id, { old: cur.name, now: v.name, note: `${cur.domain}:${cur.code}` });
    });
    await loadLookups(db);
    await done(res);
  });

  r.post('/item/:id/active', async (req, res) => {
    guard(req);
    const cur = LK.rows.find((x) => x.id === intId(req.params.id));
    if (!cur) throw notFound('القيمة مش موجودة');
    const on = req.body?.active === true || req.body?.active === 'true' || req.body?.active === 1;
    await db.tx(async (t) => {
      await t.run('UPDATE LookupValues SET Active = ? WHERE Id = ?', [on ? 1 : 0, cur.id]);
      await audit(t, req.user, on ? 'lookup.enable' : 'lookup.disable', 'Lookup', cur.id, { note: `${cur.domain}:${cur.code} ${cur.name}` });
    });
    await loadLookups(db);
    await done(res);
  });

  r.post('/:domain/order', async (req, res) => {
    guard(req);
    const domain = req.params.domain;
    if (!DOMAINS[domain]) throw notFound('القايمة مش موجودة');
    const ids = (req.body?.ids || []).map(Number);
    const cur = rowsOf(domain).map((x) => x.id);
    if (ids.length !== cur.length || !ids.every((i) => cur.includes(i))) throw bad('الترتيب مش مكتمل');
    await db.tx(async (t) => {
      for (const [i, id] of ids.entries()) await t.run('UPDATE LookupValues SET SortOrder = ? WHERE Id = ?', [(i + 1) * 10, id]);
      await audit(t, req.user, 'lookup.order', 'Lookup', null, { note: DOMAINS[domain].title });
    });
    await loadLookups(db);
    await done(res);
  });

  r.delete('/item/:id', async (req, res) => {
    guard(req);
    const cur = LK.rows.find((x) => x.id === intId(req.params.id));
    if (!cur) throw notFound('القيمة مش موجودة');
    if ((await usage(db, cur.domain, cur.code)) > 0) throw bad('عليه شغل فعلًا، مينفعش يتمسح. وقّفه بدل المسح');
    await db.tx(async (t) => {
      await t.run('DELETE FROM LookupValues WHERE Id = ?', [cur.id]);
      await audit(t, req.user, 'lookup.delete', 'Lookup', cur.id, { old: cur.name, note: `${cur.domain}:${cur.code}` });
    });
    await loadLookups(db);
    await done(res);
  });
  return r;
}
