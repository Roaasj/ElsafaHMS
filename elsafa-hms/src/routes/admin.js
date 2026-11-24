// الإعدادات (للمدير): الخدمات والأسعار واستيراد إكسل، الأطباء ومواعيدهم ونسبهم، المستخدمين، سجل التعديلات
import { R, argb } from '../lib/runtime.js';
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, audit, hashPassword, ROLES, PERMISSIONS, loadRoles, destroyUserSessions, GRANTS, parseList } from '../lib/auth.js';
import { PERM_GROUPS, PERM_LABELS } from '../lib/perm-catalog.js';
import { bad, conflict, notFound, intId, str, cents, pounds, parseMoney } from '../lib/util.js';
import { searchKey, latinDigits, cleanName } from '../../shared/text.js';
import { toBool, toIso } from '../db/index.js';
import { DEPTS, currentPriceSql } from './catalog.js';
import { rowsOf, deptIs, deptPrefix, deptPayDefault } from '../lib/lookups.js';
import { roomsRoutes } from './rooms-admin.js';
import { floorPriceRoutes } from './floor-prices.js';
import { qty2, pct2 } from '../../shared/money.js';

const YES = ['نعم', 'اه', 'ايوه', 'ايوة', 'yes', 'y', '1', 'true', '✓', 'صح'].map(searchKey);
const NO = ['لا', 'لأ', 'no', 'n', '0', 'false', '✗', 'x'].map(searchKey);

const parseDept = (v) => {
  const k = searchKey(v);
  if (!k) return undefined;
  for (const d of rowsOf('dept')) {
    const ws = [d.name, d.short, d.code, d.meta.prefix].filter(Boolean);
    if (ws.some((w) => searchKey(w) === k || searchKey(w) === k.replace(/^ال/, '') || searchKey('ال' + w) === k)) return d.code;
  }
  return null;
};
const parseYes = (v) => { const k = searchKey(v); if (!k) return undefined; if (YES.includes(k)) return true; if (NO.includes(k)) return false; return null; };
const parsePay = (v) => {
  const k = searchKey(v);
  if (!k) return undefined;
  if (['قبل', 'before', 'مقدم'].map(searchKey).includes(k)) return 'before';
  if (['بعد', 'after', 'مؤخر'].map(searchKey).includes(k)) return 'after';
  return null;
};
const pct = (v, label) => {
  if (v === '' || v == null) return null;
  const n = Number(latinDigits(v));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw bad(`${label}: النسبة لازم تكون من 0 لـ 100`);
  return pct2(n);
};

// ===================== الخدمات =====================
/** نصيب الدكتور: نسبة % أو مبلغ ثابت (واحد بس)، أو فاضي = مفيش. بيرجّع {pct, fixed(بالقروش)} */
function cleanShare(b) {
  const empty = (v) => v === undefined || v === null || v === '';
  let pct = null, fixed = null;
  if (!empty(b.sharePct)) {
    pct = Number(b.sharePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw bad('النسبة من 0 لـ 100', { errors: { sharePct: 'النسبة من 0 لـ 100' } });
    pct = pct2(pct) || null;
  }
  if (!empty(b.shareFixed)) { fixed = parseMoney(b.shareFixed, 'المبلغ'); if (fixed <= 0) fixed = null; }
  if (pct && fixed) throw bad('اختار نسبة أو مبلغ ثابت، مش الاتنين', { errors: { shareFixed: 'اختار نسبة أو مبلغ ثابت، مش الاتنين' } });
  return { pct, fixed };
}
const shareOf = (r) => ({ sharePct: r.SharePct == null ? null : Number(r.SharePct), shareFixed: r.ShareFixed == null ? null : pounds(cents(r.ShareFixed)) });
function adminServiceDto(r) {
  return {
    ...shareOf(r),
    id: r.Id, code: r.Code, name: r.Name, dept: r.Dept, payTiming: r.PayTiming, hasDoctor: toBool(r.HasDoctor),
    quick: toBool(r.Quick), active: toBool(r.Active), sortOrder: r.SortOrder,
    includedNights: r.IncludedNights == null ? null : Number(r.IncludedNights), modality: r.Modality || null,
    ticketCat: r.TicketCat || null, openPrice: toBool(r.OpenPrice),
    price: r.Price == null ? null : pounds(cents(r.Price)), priceSince: toIso(r.PriceSince), used: Number(r.Used || 0),
  };
}

async function listServices(db) {
  const now = new Date();
  const rows = await db.query(
    `SELECT s.*, ${currentPriceSql()} AS Price,
            (SELECT MAX(EffectiveFrom) FROM ServicePrices WHERE ServiceId = s.Id AND EffectiveFrom <= ?) AS PriceSince,
            (SELECT COUNT(*) FROM VisitItems WHERE ServiceId = s.Id) AS Used
       FROM Services s ORDER BY s.Dept, s.SortOrder, s.Name`, [now, now]);
  return rows.map(adminServiceDto);
}

/** سعر جديد بيسري من دلوقتي (لو اتغير مرتين في نفس الثانية بنعدّل نفس السطر) */
async function setPrice(t, user, serviceId, priceCents, oldCents) {
  if (oldCents === priceCents) return false;
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  const same = await t.one(t.top('SELECT Id FROM ServicePrices WHERE ServiceId = ? AND EffectiveFrom >= ? ORDER BY Id DESC', 1), [serviceId, at]);
  if (same) await t.run('UPDATE ServicePrices SET Price = ?, ChangedBy = ? WHERE Id = ?', [pounds(priceCents), user.id, same.Id]);
  else await t.insert('ServicePrices', { ServiceId: serviceId, Price: pounds(priceCents), EffectiveFrom: at, ChangedBy: user.id });
  await audit(t, user, 'service.price', 'Service', serviceId, { old: oldCents == null ? null : pounds(oldCents), now: pounds(priceCents) });
  return true;
}

async function nextCode(t, dept, taken = new Set()) {
  const prefix = deptPrefix(dept);
  const rows = await t.query('SELECT Code FROM Services WHERE Code LIKE ?', [prefix + '-%']);
  let max = 0;
  for (const c of [...rows.map((r) => r.Code), ...taken]) {
    const m = new RegExp('^' + prefix + '-(\\d+)$').exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function validateService(b, { create }) {
  const errors = {};
  const name = cleanName(b.name);
  if (!name) errors.name = 'اكتب اسم الخدمة';
  const dept = b.dept;
  if (!DEPTS[dept]) errors.dept = 'اختار القسم';
  const payTiming = b.payTiming;
  if (!['before', 'after'].includes(payTiming)) errors.payTiming = 'اختار امتى يدفع';
  let code = str(b.code, 30);
  if (code) { code = latinDigits(code).toUpperCase().replace(/\s+/g, ''); if (!/^[A-Z0-9-_.]{1,30}$/.test(code)) errors.code = 'الكود حروف إنجليزي وأرقام بس'; }
  let price = null;
  if (create) {
    try { price = parseMoney(b.price, 'السعر'); if (b.price === '' || b.price == null) errors.price = 'اكتب السعر'; } catch (e) { errors.price = e.message; }
  }
  let includedNights = null;
  if (b.includedNights !== '' && b.includedNights != null && deptIs(dept, 'or')) {
    includedNights = Number(latinDigits(b.includedNights));
    if (!Number.isInteger(includedNights) || includedNights < 0 || includedNights > 60) errors.includedNights = 'عدد الليالي مش صحيح';
    if (includedNights === 0) includedNights = null;
  }
  if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
  const modality = deptIs(dept, 'radiology') && ['us', 'ct', 'mri', 'xray', 'mammo', 'other'].includes(b.modality) ? b.modality : null;
  const ticketCat = ['fee', 'visit'].includes(b.ticketCat) && deptIs(dept, 'ward', 'or') ? b.ticketCat : null;
  return { name, dept, payTiming, code, price, includedNights, modality, ticketCat, openPrice: !!b.openPrice, hasDoctor: !!b.hasDoctor, quick: !!b.quick, active: b.active === undefined ? true : !!b.active };
}

// ----- إكسل -----
const HEAD = {
  code: ['الكود', 'كود', 'code'],
  name: ['اسم الخدمة', 'الخدمة', 'الاسم', 'name', 'service'],
  dept: ['القسم', 'dept', 'department'],
  price: ['السعر', 'price'],
  pay: ['الدفع', 'وقت الدفع', 'pay'],
  doc: ['ليها دكتور', 'دكتور', 'طبيب', 'doctor'],
  quick: ['زرار سريع', 'سريع', 'quick'],
  active: ['فعالة', 'فعال', 'active'],
};

async function readSheet(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw bad('الملف ده مش ملف إكسل (xlsx) أو بايظ. احفظه من إكسل بصيغة xlsx وجرّب تاني.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw bad('الملف فاضي');
  let headRow = 0, cols = {};
  for (let r = 1; r <= Math.min(6, ws.rowCount) && !headRow; r++) {
    const found = {};
    ws.getRow(r).eachCell((c, i) => {
      const k = searchKey(c.text);
      for (const [f, words] of Object.entries(HEAD)) if (!found[f] && words.some((w) => searchKey(w) === k)) found[f] = i;
    });
    if (found.name && found.price) { headRow = r; cols = found; }
  }
  if (!headRow) throw bad('مش لاقي عناوين الأعمدة. لازم يكون فيه على الأقل عمود «اسم الخدمة» وعمود «السعر». نزّل النموذج من زرار «تصدير إكسل».');
  const out = [];
  for (let r = headRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f) => (cols[f] ? String(row.getCell(cols[f]).text ?? '').trim() : '');
    const rec = { row: r, code: get('code'), name: get('name'), dept: get('dept'), price: get('price'), pay: get('pay'), doc: get('doc'), quick: get('quick'), active: get('active') };
    if (!Object.values(rec).slice(1).some(Boolean)) continue;
    out.push(rec);
  }
  if (out.length > 3000) throw bad('الملف فيه أكتر من 3000 صف. قسّمه على أكتر من ملف.');
  return { rows: out, columns: Object.keys(cols) };
}

async function planImport(db, buf) {
  const { rows, columns } = await readSheet(buf);
  const existing = await listServices(db);
  const byCode = new Map(existing.map((s) => [s.code.toUpperCase(), s]));
  const byName = new Map(existing.map((s) => [searchKey(s.name), s]));
  const seenCodes = new Set(), seenNames = new Set();
  const plan = [];
  for (const r of rows) {
    const errors = [];
    const code = r.code ? latinDigits(r.code).toUpperCase().replace(/\s+/g, '') : '';
    const name = cleanName(r.name);
    const cur = (code && byCode.get(code)) || (!code && name && byName.get(searchKey(name))) || null;
    if (code && !/^[A-Z0-9-_.]{1,30}$/.test(code)) errors.push('الكود حروف إنجليزي وأرقام بس');
    if (!name) errors.push('اسم الخدمة فاضي');
    let price;
    const pRaw = latinDigits(r.price).replace(/[,،\s]|ج(نيه)?$/g, '');
    if (!pRaw) { if (!cur) errors.push('السعر فاضي'); else price = cur.price; }
    else {
      price = Number(pRaw);
      if (!Number.isFinite(price) || price < 0) { errors.push(`السعر «${r.price}» مش رقم`); price = undefined; }
      else price = R.money.round(price);
    }
    let dept = parseDept(r.dept);
    if (dept === null) errors.push(`القسم «${r.dept}» مش معروف (${Object.values(DEPTS).join(' / ')})`);
    if (dept === undefined) { if (cur) dept = cur.dept; else errors.push('اكتب القسم'); }
    let payTiming = parsePay(r.pay);
    if (payTiming === null) errors.push(`الدفع «${r.pay}» لازم «قبل» أو «بعد»`);
    if (payTiming === undefined) payTiming = cur ? cur.payTiming : deptPayDefault(dept);
    const flags = {};
    for (const [f, label, key] of [['doc', 'ليها دكتور', 'hasDoctor'], ['quick', 'زرار سريع', 'quick'], ['active', 'فعالة', 'active']]) {
      const v = parseYes(r[f]);
      if (v === null) errors.push(`«${label}» لازم نعم أو لا`);
      flags[key] = v === undefined || v === null ? (cur ? cur[key] : key === 'active') : v;
    }
    const nameKey = searchKey(name);
    if (code && seenCodes.has(code)) errors.push('الكود ده متكرر في الملف');
    if (name && !code && seenNames.has(nameKey)) errors.push('الاسم ده متكرر في الملف');
    if (code) seenCodes.add(code);
    if (name) seenNames.add(nameKey);
    if (!cur && name && byName.has(nameKey) && code) errors.push(`فيه خدمة بنفس الاسم بكود ${byName.get(nameKey).code}`);

    const item = { row: r.row, code: code || cur?.code || '', name, dept, price, payTiming, ...flags, id: cur?.id || null, errors };
    if (errors.length) item.status = 'error';
    else if (!cur) item.status = 'new';
    else {
      const ch = [];
      if (cur.name !== name) ch.push(`الاسم: ${cur.name} ← ${name}`);
      if (cur.price !== price) ch.push(`السعر: ${cur.price ?? '—'} ← ${price}`);
      if (cur.dept !== dept) ch.push(`القسم: ${DEPTS[cur.dept]} ← ${DEPTS[dept]}`);
      if (cur.payTiming !== payTiming) ch.push(`الدفع: ${payTiming === 'before' ? 'قبل' : 'بعد'}`);
      if (cur.hasDoctor !== flags.hasDoctor) ch.push(flags.hasDoctor ? 'بقت ليها دكتور' : 'من غير دكتور');
      if (cur.quick !== flags.quick) ch.push(flags.quick ? 'زرار سريع' : 'شيل من الأزرار السريعة');
      if (cur.active !== flags.active) ch.push(flags.active ? 'اتفعّلت' : 'اتوقفت');
      item.changes = ch;
      item.status = ch.length ? 'update' : 'same';
      item.oldPrice = cur.price;
    }
    plan.push(item);
  }
  const count = (s) => plan.filter((x) => x.status === s).length;
  return { columns, plan, summary: { total: plan.length, new: count('new'), update: count('update'), same: count('same'), error: count('error') } };
}

// ===================== الأطباء =====================
function validateDoctor(b) {
  const errors = {};
  const name = cleanName(b.name);
  if (!name) errors.name = 'اكتب اسم الدكتور';
  const schedule = [];
  for (const s of Array.isArray(b.schedule) ? b.schedule : []) {
    const wd = Number(s.weekday);
    const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
    if (!ok(s.from) || !ok(s.to) || s.from === s.to) { errors.schedule = 'في موعد وقته مش مكتمل أو البداية زي النهاية'; continue; }
    schedule.push({ weekday: wd, from: s.from, to: s.to });
  }
  if (schedule.length > 40) errors.schedule = 'مواعيد كتير قوي';
  const sh = b.shares || {};
  const shares = [];
  try {
    const g = pct(sh.general, 'النسبة العامة');
    if (g != null) shares.push({ serviceId: null, dept: null, pct: g });
    for (const d of Object.keys(DEPTS)) { const v = pct(sh.depts?.[d], DEPTS[d]); if (v != null) shares.push({ serviceId: null, dept: d, pct: v }); }
    const seen = new Set();
    for (const x of Array.isArray(sh.services) ? sh.services : []) {
      const sid = Number(x.serviceId);
      if (!Number.isInteger(sid) || sid <= 0) continue;
      const v = pct(x.pct, 'نسبة الخدمة');
      if (v == null) continue;
      if (seen.has(sid)) { errors.shares = 'في خدمة متكررة في النسب'; continue; }
      seen.add(sid);
      shares.push({ serviceId: sid, dept: null, pct: v });
    }
  } catch (e) { errors.shares = e.message; }
  if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
  return { clinicId: b.clinicId === undefined ? undefined : (b.clinicId ? Number(b.clinicId) : null), name, specialty: str(b.specialty, 80), externalRef: str(b.externalRef, 60), active: b.active === undefined ? true : !!b.active, schedule, shares };
}

async function doctorsFull(db) {
  const docs = await db.query('SELECT * FROM Doctors ORDER BY Active DESC, Name');
  const sched = await db.query('SELECT DoctorId, Weekday, FromTime, ToTime FROM DoctorSchedule ORDER BY Weekday, FromTime');
  const shares = await db.query('SELECT sh.DoctorId, sh.ServiceId, sh.Dept, sh.Pct, s.Name AS ServiceName FROM DoctorShares sh LEFT JOIN Services s ON s.Id = sh.ServiceId');
  const used = await db.query('SELECT DoctorId, COUNT(*) AS N FROM VisitItems WHERE DoctorId IS NOT NULL GROUP BY DoctorId');
  const usedMap = new Map(used.map((u) => [u.DoctorId, Number(u.N)]));
  return docs.map((d) => {
    const my = shares.filter((x) => x.DoctorId === d.Id);
    const gen = my.find((x) => x.ServiceId == null && x.Dept == null);
    return {
      id: d.Id, name: d.Name, specialty: d.Specialty, clinicId: d.ClinicId ?? null, externalRef: d.ExternalRef, active: toBool(d.Active), used: usedMap.get(d.Id) || 0,
      schedule: sched.filter((s) => s.DoctorId === d.Id).map((s) => ({ weekday: Number(s.Weekday), from: String(s.FromTime).trim(), to: String(s.ToTime).trim() })),
      shares: {
        general: gen ? Number(gen.Pct) : null,
        depts: Object.fromEntries(my.filter((x) => x.ServiceId == null && x.Dept).map((x) => [x.Dept, Number(x.Pct)])),
        services: my.filter((x) => x.ServiceId != null).map((x) => ({ serviceId: x.ServiceId, name: x.ServiceName, pct: Number(x.Pct) })),
      },
    };
  });
}

async function saveDoctor(t, user, id, d) {
  const dup = await t.one('SELECT Id FROM Doctors WHERE Name = ? AND Id <> ?', [d.name, id || 0]);
  if (dup) throw conflict('فيه دكتور متسجل بنفس الاسم بالظبط');
  let clinic = null;
  if (d.clinicId) {
    clinic = await t.one('SELECT Id, Name FROM Clinics WHERE Id = ?', [d.clinicId]);
    if (!clinic) throw bad('العيادة مش موجودة', { errors: { clinicId: 'اختار عيادة موجودة' } });
  }
  // التخصص بيتملا من اسم العيادة لو فاضي
  const row = { Name: d.name, Specialty: d.specialty || clinic?.Name || null, ExternalRef: d.externalRef, Active: d.active ? 1 : 0 };
  if (id) {
    await t.run('UPDATE Doctors SET Name = ?, Specialty = ?, ExternalRef = ?, Active = ? WHERE Id = ?', [row.Name, row.Specialty, row.ExternalRef, row.Active, id]);
    if (d.clinicId !== undefined) await t.run('UPDATE Doctors SET ClinicId = ? WHERE Id = ?', [d.clinicId || null, id]);
    await t.run('DELETE FROM DoctorSchedule WHERE DoctorId = ?', [id]);
    await t.run('DELETE FROM DoctorShares WHERE DoctorId = ?', [id]);
  } else id = await t.insert('Doctors', { ...row, ClinicId: d.clinicId || null });
  for (const s of d.schedule) await t.insert('DoctorSchedule', { DoctorId: id, Weekday: s.weekday, FromTime: s.from, ToTime: s.to });
  for (const s of d.shares) {
    if (s.serviceId) {
      const ok = await t.one('SELECT Id FROM Services WHERE Id = ?', [s.serviceId]);
      if (!ok) throw bad('في خدمة في النسب مش موجودة');
    }
    await t.insert('DoctorShares', { DoctorId: id, ServiceId: s.serviceId, Dept: s.dept, Pct: s.pct });
  }
  return id;
}

// ===================== المستخدمين =====================
const userDto = (u) => ({
  id: u.Id, username: u.Username, name: u.FullName, role: u.Role, roleName: ROLES[u.Role], active: toBool(u.Active),
  createdAt: toIso(u.CreatedAt), lastLoginAt: toIso(u.LastLoginAt),
  grants: parseList(u.Grants).filter((g) => PERM_LABELS[g]), denied: parseList(u.Denied).filter((g) => PERM_LABELS[g]), stores: parseList(u.StoreIds).map(Number),
});
const cleanGrants = (v) => (Array.isArray(v) ? [...new Set(v.filter((g) => PERM_LABELS[g]))] : null);
const cleanStores = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : null);

// ===================== سجل التعديلات =====================
const ACTIONS = {
  'patient.create': 'فتح ملف مريض', 'visit.open': 'فتح زيارة', 'visit.close': 'قفل زيارة', 'item.remove': 'شيل بند قبل الدفع',
  'receipt.create': 'إيصال', 'receipt.cancel': 'إلغاء إيصال', 'receipt.reprint': 'طباعة نسخة',
  'service.create': 'خدمة جديدة', 'service.update': 'تعديل خدمة', 'service.price': 'تغيير سعر', 'service.import': 'استيراد خدمات من إكسل',
  'doctor.create': 'دكتور جديد', 'doctor.update': 'تعديل دكتور', 'clinic.create': 'عيادة جديدة', 'clinic.update': 'تعديل عيادة', 'clinic.delete': 'مسح عيادة', 'service.share': 'نصيب الدكتور على خدمة', 'pricelist.create': 'قايمة أسعار جديدة', 'pricelist.update': 'تعديل قايمة أسعار', 'pricelist.delete': 'مسح قايمة أسعار', 'clinic.share': 'نصيب الدكتور على عيادة', 'role.create': 'دور جديد', 'role.update': 'تعديل صلاحيات دور', 'role.delete': 'مسح دور',
  'user.create': 'مستخدم جديد', 'user.update': 'تعديل مستخدم', 'user.password': 'تغيير كلمة سر',
  'admission.create': 'دخول مريض', 'admission.update': 'تعديل بيانات دخول', 'admission.transfer': 'تحويل سرير', 'admission.discharge': 'خروج مريض',
  'admission.undo': 'إلغاء خروج', 'admission.item.remove': 'شيل بند من حساب إقامة', 'bed.status': 'تغيير حالة سرير',
  'floor.create': 'دور جديد', 'floor.update': 'تعديل دور', 'class.create': 'درجة غرف جديدة', 'class.update': 'تعديل درجة غرف', 'class.price': 'تغيير سعر/تأمين درجة', 'price.floor': 'سعر دور',
  'payer.create': 'جهة تعاقد جديدة', 'payer.update': 'تعديل جهة تعاقد', 'payer.prices': 'أسعار جهة تعاقد', 'payer.rules': 'خدمات جهة تعاقد', 'payer.delete': 'مسح جهة تعاقد', 'payer.tier.delete': 'مسح مستوى كارنيه',
  'approval.create': 'تسجيل موافقة', 'approval.approve': 'اعتماد موافقة', 'approval.reject': 'رفض موافقة', 'approval.info': 'رقم موافقة', 'approval.image': 'صورة موافقة',
  'visit.payer': 'تغيير تعاقد زيارة',
  'order.create': 'إذن دفع', 'order.collect': 'تحصيل إذن دفع', 'order.cancel': 'إلغاء إذن دفع',
  'rad.create': 'فحص أشعة', 'rad.done': 'اتعمل فحص أشعة', 'rad.sent': 'أشعة اتبعتت برة', 'rad.draft': 'مسودة تقرير أشعة', 'rad.report': 'اعتماد تقرير أشعة',
  'rad.amend': 'تعديل تقرير أشعة', 'rad.link': 'لينك تقرير أشعة', 'rad.file': 'ملف تقرير أشعة', 'rad.deliver': 'تسليم أشعة', 'rad.undo': 'رجوع خطوة في الأشعة', 'rad.template': 'قالب تقرير أشعة',
  'lab.collect': 'سحب عينة', 'lab.result': 'نتيجة تحليل', 'lab.amend': 'تعديل نتيجة تحليل', 'lab.verify': 'اعتماد تحليل', 'lab.deliver': 'تسليم تحاليل',
  'lab.send': 'تحليل اتبعت بره', 'lab.file': 'نتيجة معمل خارجي', 'lab.undo': 'رجوع خطوة في المعمل', 'lab.test': 'تعديل تحليل',
  'ticket.create': 'تذكرة إقامة', 'ticket.item.remove': 'شيل بند من التذكرة', 'ticket.item.update': 'تعديل عدد في التذكرة', 'ticket.close': 'قفل التذكرة', 'ticket.reopen': 'فتح التذكرة',
  'late.create': 'مستحق لاحق', 'late.decide': 'قرار مستحق لاحق', 'stock.create': 'صنف جديد', 'stock.update': 'تعديل صنف', 'stock.import': 'استيراد أصناف من إكسل',
  'stock.purchase': 'استلام مخزن', 'transfer.request': 'طلب تحويل', 'transfer.issue': 'صرف تحويل', 'transfer.receive': 'استلام تحويل',
  'stock.waste': 'إعدام صنف', 'stock.count': 'جرد', 'item.return': 'مرتجع صنف',
  'claim.case': 'تعديل بيانات حالة تعاقد', 'claim.review': 'مراجعة حالة تعاقد', 'claim.defer': 'تأجيل حالة تعاقد', 'claim.adjust': 'تسوية نصيب جهة', 'claim.file': 'مستند حالة تعاقد', 'claim.fixed': 'تصليح ملاحظة تعاقد',
  'claim.create': 'مطالبة جديدة', 'claim.send': 'إرسال مطالبة', 'claim.reopen': 'فتح مطالبة', 'claim.delete': 'مسح مسودة مطالبة', 'claim.payment': 'شيك مطالبة', 'claim.payment.delete': 'مسح شيك', 'claim.reject': 'مرفوض في مطالبة',
  'visit.diagnosis': 'تشخيص زيارة', 'admission.diagnosis': 'تشخيص دخول',
  'transfer.confirm': 'تأكيد تحويل', 'transfer.cancel': 'إلغاء تحويل', 'store.create': 'مخزن جديد', 'store.update': 'تعديل مخزن',
  'shift.open': 'بداية وردية', 'shift.close': 'تقفيل وردية', 'shift.receive': 'استلام وردية',
  'room.create': 'غرفة جديدة', 'room.update': 'تعديل غرفة', 'bed.create': 'سرير جديد', 'bed.update': 'تعديل سرير', 'settings.update': 'تعديل إعدادات',
};
const GROUPS = {
  stores: ['stock.purchase', 'stock.waste', 'stock.count', 'transfer.', 'store.'],
  money: ['receipt.', 'admission.discharge', 'admission.undo', 'order.', 'shift.'], patients: ['patient.', 'visit.', 'item.'],
  inpatient: ['admission.', 'bed.status', 'ticket.', 'late.'], radiology: ['rad.'], lab: ['lab.'], contracts: ['payer.', 'approval.', 'visit.payer', 'claim.'], settings: ['service.', 'stock.', 'price.', 'doctor.', 'user.', 'floor.', 'class.', 'room.', 'bed.create', 'bed.update', 'settings.'],
};

function auditText(a, names) {
  const nv = a.NewValue ? safeJson(a.NewValue) : null;
  const ov = a.OldValue ? safeJson(a.OldValue) : null;
  const money = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  switch (a.Action) {
    case 'receipt.create': return `رقم ${nv?.no} · ${money(nv?.net)} ${R.money.symbol}${nv?.discount ? ` · خصم ${money(nv.discount)}` : ''}${nv?.credit ? ` · آجل ${money(nv.credit)}` : ''}`;
    case 'receipt.cancel': return `مرتجع رقم ${nv?.refundNo}`;
    case 'service.price': return `${names.service.get(a.EntityId) || ''}: ${money(ov)} ← ${money(nv)} ${R.money.symbol}`;
    case 'service.create': case 'service.update': return names.service.get(a.EntityId) || nv?.name || '';
    case 'service.import': return `${nv?.created || 0} جديد · ${nv?.updated || 0} تعديل`;
    case 'doctor.create': case 'doctor.update': return names.doctor.get(a.EntityId) || nv?.name || '';
    case 'user.create': case 'user.update': case 'user.password': return names.user.get(a.EntityId) || '';
    case 'patient.create': return `ملف ${nv?.no} · ${nv?.name || ''}`;
    case 'visit.open': return `زيارة ${nv?.no}`;
    case 'item.remove': case 'admission.item.remove': return `${ov?.name || ''} (${money(ov?.amount)} ${R.money.symbol})`;
    case 'admission.create': return `رقم ${nv?.no} · سرير ${nv?.bed} · تأمين ${money(nv?.deposit)} ${R.money.symbol}`;
    case 'admission.transfer': return `لسرير ${nv?.bed}`;
    case 'admission.discharge': return `حساب ${money(nv?.total)} · مدفوع ${money(nv?.paid)}${nv?.discount ? ` · خصم ${money(nv.discount)}` : ''}${nv?.credit ? ` · آجل ${money(nv.credit)}` : ''}`;
    case 'class.price': return `سعر الليلة ${money(ov?.nightPrice)} ← ${money(nv?.nightPrice)} · التأمين ${money(ov?.deposit)} ← ${money(nv?.deposit)}`;
    case 'bed.status': return `${{ free: 'فاضي', cleaning: 'تحت التنظيف', reserved: 'محجوز', occupied: 'مشغول' }[ov] || ov} ← ${{ free: 'فاضي', cleaning: 'تحت التنظيف', reserved: 'محجوز' }[nv] || nv}`;
    case 'order.create': return `إذن ${nv?.no} · ${money(nv?.amount)} ${R.money.symbol}`;
    case 'order.collect': return `إذن ${nv?.no}${nv?.manualNo ? ` · يدوي ${nv.manualNo}` : ''}`;
    case 'order.cancel': return `إذن ${ov?.no} (${money(ov?.amount)} ${R.money.symbol})`;
    case 'shift.close': return `المفروض ${money(nv?.expected)} · اتعد ${money(nv?.counted)}${nv?.diff ? ` · فرق ${money(nv.diff)}` : ''}`;
    case 'rad.done': case 'rad.report': case 'rad.amend': case 'rad.draft': case 'rad.file': case 'rad.link': case 'rad.create': return `فحص ${nv?.no || ''}${nv?.service ? ' · ' + nv.service : ''}`;
    case 'rad.sent': return `فحص ${nv?.no} ← ${nv?.to || 'برة'}`;
    case 'rad.deliver': return `فحص ${nv?.no} · استلم ${nv?.to || ''}`;
    case 'lab.collect': return `عينة ${nv?.acc} · ${nv?.tests || ''}`;
    case 'lab.result': case 'lab.amend': case 'lab.verify': return `عينة ${nv?.acc || ''} · ${nv?.test || ''}`;
    case 'lab.deliver': return `${nv?.tests || ''} · استلم ${nv?.to || ''}`;
    case 'ticket.create': return `تذكرة ${nv?.no} · ${nv?.date || ''}${nv?.lines ? ` · ${nv.lines} بند · ${money(nv?.total)} ${R.money.symbol}` : ''}${nv?.paperNo ? ` · ورقة ${nv.paperNo}` : ''}`;
    case 'ticket.item.update': return `${ov?.name || ''}: ${ov?.qty} ← ${nv?.qty} (${money(nv?.amount)} ${R.money.symbol})`;
    case 'ticket.item.remove': return `${ov?.name || ''} (${money(ov?.amount)} ${R.money.symbol})`;
    case 'ticket.close': return `دخول ${nv?.no || ''} · الحساب ${money(nv?.total)} · المطلوب ${money(nv?.balance)} ${R.money.symbol}`;
    case 'late.create': return `رقم ${nv?.no} · دخول ${nv?.admission} · ${nv?.name || ''} (${money(nv?.amount)} ${R.money.symbol})`;
    case 'late.decide': return `${{ patient: 'المريض يدفع', employee: 'على موظف', dept: 'على القسم', cancel: 'اتلغى' }[nv?.to] || ''}${nv?.name ? ' · ' + nv.name : ''} (${money(nv?.amount)} ${R.money.symbol})`;
    case 'stock.create': case 'stock.update': return `${nv?.name || ''} · ${money(nv?.price)} ${R.money.symbol}`;
    case 'stock.import': return `${nv?.created || 0} جديد · ${nv?.updated || 0} تعديل`;
    case 'price.floor': return `${ov == null ? 'الأساسي' : money(ov)} ← ${nv == null ? 'الأساسي' : money(nv)}`;
    case 'stock.purchase': return `${nv?.kind === 'opening' ? 'رصيد أول المدة' : 'فاتورة'} ${nv?.no} · ${nv?.store || ''}${nv?.supplier ? ' · ' + nv.supplier : ''} · ${nv?.lines} صنف · ${money(nv?.total)} ${R.money.symbol}`;
    case 'transfer.request': case 'transfer.issue': return `تحويل ${nv?.no}${nv?.from ? ` · ${nv.from} ← ${nv.to}` : ''}${nv?.direct ? ' · مباشر' : ''}`;
    case 'stock.waste': return `إعدام ${nv?.no} · ${nv?.item || ''} · ${nv?.qty}${nv?.value != null ? ` · ${money(nv.value)} ${R.money.symbol}` : ''}`;
    case 'stock.count': return `جرد ${nv?.no}${nv?.store ? ' · ' + nv.store : ''} · ${{ open: 'بداية', submit: 'تسليم', approve: 'اعتماد', cancel: 'إلغاء' }[nv?.step] || ''}${nv?.value != null ? ` · فرق ${money(nv.value)} ${R.money.symbol}` : ''}`;
    case 'claim.adjust': return `${nv?.item || ov?.item || ''} · ${money(ov?.payer)} ← ${money(nv?.payer)} ${R.money.symbol}`;
    case 'claim.create': return `مطالبة ${nv?.no} · ${nv?.payer || ''} · ${nv?.period || ''}`;
    case 'claim.send': return `مطالبة ${nv?.no} · ${money(nv?.total)} ${R.money.symbol}`;
    case 'claim.payment': return `مطالبة ${nv?.no} · شيك ${nv?.cheque} · ${money(nv?.amount)} ${R.money.symbol}`;
    case 'claim.reject': return `${ov?.line || ''} · مرفوض ${money(nv?.rejected)} ${R.money.symbol}`;
    case 'claim.review': return `${{ ok: 'تمام', note: 'ملاحظة', pending: 'رجوع للمراجعة' }[nv?.status] || ''}`;
    case 'item.return': return `مرتجع ${nv?.qty} · ${nv?.name || ''} · ${money(nv?.amount)} ${R.money.symbol}`;
    case 'transfer.receive': case 'transfer.confirm': case 'transfer.cancel': return `تحويل ${nv?.no}`;
    case 'shift.receive': return `${money(nv?.cash)} ${R.money.symbol}`;
    case 'settings.update': return `${ov || ''} ← ${nv || ''}`;
    default: return '';
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ===================== المسارات =====================
export default function adminRouter(db) {
  const r = router();
  r.use((req, res, next) => { try { need(req.user, 'settings.manage'); next(); } catch (e) { next(e); } });

  // ----- الخدمات -----
  r.get('/services', async (req, res) => res.json({ depts: DEPTS, services: await listServices(db) }));

  r.post('/services', async (req, res) => {
    const s = validateService(req.body || {}, { create: true });
    const id = await db.tx(async (t) => {
      const code = s.code || await nextCode(t, s.dept);
      if (await t.one('SELECT Id FROM Services WHERE Code = ?', [code])) throw bad('الكود ده مستخدم', { errors: { code: 'الكود ده مستخدم لخدمة تانية' } });
      if (await t.one('SELECT Id FROM Services WHERE SearchKey = ? AND Dept = ?', [searchKey(s.name), s.dept])) {
        throw bad('فيه خدمة بنفس الاسم في نفس القسم', { errors: { name: 'فيه خدمة بنفس الاسم في نفس القسم' } });
      }
      const max = await t.one('SELECT MAX(SortOrder) AS M FROM Services WHERE Dept = ?', [s.dept]);
      const sid = await t.insert('Services', {
        Code: code, Name: s.name, SearchKey: searchKey(s.name), Dept: s.dept, PayTiming: s.payTiming, HasDoctor: s.hasDoctor ? 1 : 0,
        Quick: s.quick ? 1 : 0, SortOrder: Number(max?.M ?? 0) + 1, Active: s.active ? 1 : 0, CreatedAt: new Date(), IncludedNights: s.includedNights, Modality: s.modality, TicketCat: s.ticketCat, OpenPrice: s.openPrice ? 1 : 0,
      });
      await audit(t, req.user, 'service.create', 'Service', sid, { now: { code, name: s.name, price: pounds(s.price) } });
      await setPrice(t, req.user, sid, s.price, null);
      return sid;
    });
    res.status(201).json({ service: (await listServices(db)).find((x) => x.id === id) });
  });

  r.put('/services/:id', async (req, res) => {
    const id = intId(req.params.id);
    const list = await listServices(db);
    const cur = list.find((x) => x.id === id);
    if (!cur) throw notFound('الخدمة مش موجودة');
    const b = { ...cur, ...req.body };
    const s = validateService(b, { create: false });
    const code = s.code || cur.code;
    if (code !== cur.code && list.some((x) => x.code === code)) throw bad('الكود ده مستخدم', { errors: { code: 'الكود ده مستخدم لخدمة تانية' } });
    await db.tx(async (t) => {
      await t.run('UPDATE Services SET Code = ?, Name = ?, SearchKey = ?, Dept = ?, PayTiming = ?, HasDoctor = ?, Quick = ?, Active = ?, IncludedNights = ?, Modality = ?, TicketCat = ?, OpenPrice = ? WHERE Id = ?',
        [code, s.name, searchKey(s.name), s.dept, s.payTiming, s.hasDoctor ? 1 : 0, s.quick ? 1 : 0, s.active ? 1 : 0, s.includedNights, s.modality, s.ticketCat, s.openPrice ? 1 : 0, id]);
      const pick = (x) => ({ code: x.code, name: x.name, dept: x.dept, payTiming: x.payTiming, hasDoctor: x.hasDoctor, quick: x.quick, active: x.active });
      await audit(t, req.user, 'service.update', 'Service', id, { old: pick(cur), now: pick({ ...s, code }) });
    });
    res.json({ service: (await listServices(db)).find((x) => x.id === id) });
  });

  r.put('/services/:id/share', async (req, res) => {
    const id = intId(req.params.id);
    const old = await db.one('SELECT * FROM Services WHERE Id = ?', [id]);
    if (!old) throw notFound('الخدمة مش موجودة');
    const sh = cleanShare(req.body || {});
    await db.tx(async (t) => {
      await t.run('UPDATE Services SET SharePct = ?, ShareFixed = ? WHERE Id = ?', [sh.pct, sh.fixed == null ? null : pounds(sh.fixed), id]);
      await audit(t, req.user, 'service.share', 'Service', id, { old: { name: old.Name, pct: old.SharePct == null ? null : Number(old.SharePct), fixed: old.ShareFixed == null ? null : Number(old.ShareFixed) }, now: { name: old.Name, pct: sh.pct, fixed: sh.fixed == null ? null : pounds(sh.fixed) } });
    });
    res.json({ service: (await listServices(db)).find((x) => x.id === id) });
  });

  r.get('/services/:id/prices', async (req, res) => {
    const id = intId(req.params.id);
    const rows = await db.query(
      `SELECT p.Price, p.EffectiveFrom, u.FullName FROM ServicePrices p LEFT JOIN Users u ON u.Id = p.ChangedBy
        WHERE p.ServiceId = ? ORDER BY p.EffectiveFrom DESC, p.Id DESC`, [id]);
    res.json({ prices: rows.map((x) => ({ price: pounds(cents(x.Price)), from: toIso(x.EffectiveFrom), by: x.FullName || 'البيانات الأولية' })) });
  });

  r.post('/services/:id/price', async (req, res) => {
    const id = intId(req.params.id);
    const cur = (await listServices(db)).find((x) => x.id === id);
    if (!cur) throw notFound('الخدمة مش موجودة');
    if (req.body?.price === '' || req.body?.price == null) throw bad('اكتب السعر الجديد');
    const p = parseMoney(req.body.price, 'السعر');
    const changed = await db.tx((t) => setPrice(t, req.user, id, p, cur.price == null ? null : cents(cur.price)));
    res.json({ changed, service: (await listServices(db)).find((x) => x.id === id) });
  });

  r.get('/services/export', async (req, res) => {
    let list = await listServices(db);
    const only = String(req.query.dept || '');
    if (only && only !== 'all') { // قسم واحد (من غير dept = كل الأقسام زي الأول)
      if (!DEPTS[only]) throw bad('القسم ده مش معروف');
      list = list.filter((s) => s.dept === only);
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = `نظام ${R.brand.name}`;
    const ws = wb.addWorksheet('الخدمات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'الكود', key: 'code', width: 12 }, { header: 'اسم الخدمة', key: 'name', width: 36 },
      { header: 'القسم', key: 'dept', width: 12 }, { header: 'السعر', key: 'price', width: 11 },
      { header: 'الدفع', key: 'pay', width: 9 }, { header: 'ليها دكتور', key: 'doc', width: 12 },
      { header: 'زرار سريع', key: 'quick', width: 11 }, { header: 'فعالة', key: 'active', width: 9 },
    ];
    for (const s of list) {
      ws.addRow({ code: s.code, name: s.name, dept: DEPTS[s.dept], price: s.price, pay: s.payTiming === 'before' ? 'قبل' : 'بعد', doc: s.hasDoctor ? 'نعم' : 'لا', quick: s.quick ? 'نعم' : 'لا', active: s.active ? 'نعم' : 'لا' });
    }
    const head = ws.getRow(1);
    head.height = 24;
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    const lists = { C: '"عيادات,طوارئ,معمل,أشعة,إقامة,عمليات"', E: '"قبل,بعد"', F: '"نعم,لا"', G: '"نعم,لا"', H: '"نعم,لا"' };
    const last = Math.max(list.length + 300, 500);
    for (let i = 2; i <= last; i++) {
      for (const [col, f] of Object.entries(lists)) ws.getCell(col + i).dataValidation = { type: 'list', allowBlank: true, formulae: [f], showErrorMessage: true, errorTitle: 'قيمة غلط', error: 'اختار من القايمة' };
      ws.getCell('D' + i).numFmt = R.money.xlsxFormat();
      ws.getRow(i).font = { name: 'Arial', size: 11 };
    }
    const help = wb.addWorksheet('طريقة الاستخدام', { views: [{ rightToLeft: true }] });
    help.getColumn(1).width = 100;
    [
      'طريقة تعديل الأسعار والخدمات من إكسل:',
      '1) عدّل في شيت «الخدمات» بس، وسيب صف العناوين زي ما هو.',
      '2) الخدمة الموجودة بتتعرف بالكود. غيّر السعر أو الاسم أو أي خانة والبرنامج هيعرف التغيير.',
      '3) لخدمة جديدة: اكتب الاسم والقسم والسعر، وسيب الكود فاضي والبرنامج يدّيها كود لوحده.',
      '4) لوقف خدمة: خلّي «فعالة» = لا. (مفيش حذف عشان الإيصالات القديمة)',
      '5) ارفع الملف من «استيراد من إكسل»، وهتشوف كل التغييرات قبل ما تتنفذ.',
      'السعر الجديد بيسري من لحظة التنفيذ، والإيصالات القديمة مش بتتغير.',
    ].forEach((t, i) => { const c = help.getCell(`A${i + 1}`); c.value = t; c.font = { name: 'Arial', size: 12, bold: i === 0 }; });
    const fname = `خدمات${only && only !== 'all' ? '-' + DEPTS[only] : ''}-${R.brand.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="services.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  // الملف بييجي raw في الـ body:  ?mode=preview | apply
  r.post('/services/import', async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('اختار ملف الإكسل');
    const result = await planImport(db, req.body);
    if (req.query.mode !== 'apply') return res.json(result);
    const todo = result.plan.filter((x) => x.status === 'new' || x.status === 'update');
    if (!todo.length) return res.json({ ...result, applied: { created: 0, updated: 0 } });
    const applied = await db.tx(async (t) => {
      let created = 0, updated = 0;
      const taken = new Set();
      for (const x of todo) {
        if (x.status === 'new') {
          const code = x.code || await nextCode(t, x.dept, taken);
          taken.add(code);
          if (await t.one('SELECT Id FROM Services WHERE Code = ?', [code])) throw conflict(`الكود ${code} اتاخد. حدّث الصفحة وجرّب تاني`);
          const max = await t.one('SELECT MAX(SortOrder) AS M FROM Services WHERE Dept = ?', [x.dept]);
          const sid = await t.insert('Services', {
            Code: code, Name: x.name, SearchKey: searchKey(x.name), Dept: x.dept, PayTiming: x.payTiming, HasDoctor: x.hasDoctor ? 1 : 0,
            Quick: x.quick ? 1 : 0, SortOrder: Number(max?.M ?? 0) + 1, Active: x.active ? 1 : 0, CreatedAt: new Date(),
          });
          await setPrice(t, req.user, sid, R.money.toMinor(x.price), null);
          created++;
        } else {
          await t.run('UPDATE Services SET Name = ?, SearchKey = ?, Dept = ?, PayTiming = ?, HasDoctor = ?, Quick = ?, Active = ? WHERE Id = ?',
            [x.name, searchKey(x.name), x.dept, x.payTiming, x.hasDoctor ? 1 : 0, x.quick ? 1 : 0, x.active ? 1 : 0, x.id]);
          await setPrice(t, req.user, x.id, R.money.toMinor(x.price), x.oldPrice == null ? null : R.money.toMinor(x.oldPrice));
          updated++;
        }
      }
      await audit(t, req.user, 'service.import', 'Service', null, { now: { created, updated } });
      return { created, updated };
    });
    res.json({ ...result, applied });
  });

  // ----- الأطباء -----
  // ===== العيادات =====
  const clinicsFull = async () => {
    const rows = await db.query('SELECT c.*, s.Name AS StoreName FROM Clinics c LEFT JOIN Stores s ON s.Id = c.StoreId ORDER BY c.Active DESC, c.SortOrder, c.Name');
    const cnt = new Map((await db.query('SELECT ClinicId, COUNT(*) AS N FROM Doctors WHERE ClinicId IS NOT NULL AND Active = 1 GROUP BY ClinicId')).map((x) => [x.ClinicId, Number(x.N)]));
    return rows.map((c) => ({ ...shareOf(c), id: c.Id, name: c.Name, storeId: c.StoreId ?? null, storeName: c.StoreName || null, active: toBool(c.Active), doctors: cnt.get(c.Id) || 0 }));
  };
  async function saveClinic(t, user, id, b) {
    const name = cleanName(b.name);
    if (!name || name.length < 2) throw bad('اكتب اسم العيادة', { errors: { name: 'اكتب اسم العيادة' } });
    if (await t.one('SELECT Id FROM Clinics WHERE Name = ? AND Id <> ?', [name, id || 0])) throw conflict('فيه عيادة بنفس الاسم', { errors: { name: 'الاسم متكرر' } });
    let storeId = b.storeId ? Number(b.storeId) : null;
    if (b.newStore && !storeId) {
      storeId = await t.insert('Stores', { Name: `مخزن ${name}`, Kind: 'sub', Holds: 'all', Notes: 'مخزن عيادة', SortOrder: 100, Active: 1, CreatedAt: new Date() });
    }
    if (storeId) {
      if (!(await t.one('SELECT Id FROM Stores WHERE Id = ?', [storeId]))) throw bad('المخزن مش موجود', { errors: { storeId: 'اختار مخزن موجود' } });
      const used = await t.one('SELECT Name FROM Clinics WHERE StoreId = ? AND Id <> ?', [storeId, id || 0]);
      if (used) throw conflict(`المخزن ده مربوط بعيادة «${used.Name}»`, { errors: { storeId: 'المخزن مربوط بعيادة تانية' } });
    }
    const active = b.active === undefined ? true : !!b.active;
    if (id) {
      const old = await t.one('SELECT * FROM Clinics WHERE Id = ?', [id]);
      if (!old) throw notFound('العيادة مش موجودة');
      await t.run('UPDATE Clinics SET Name = ?, StoreId = ?, Active = ? WHERE Id = ?', [name, storeId, active ? 1 : 0, id]);
      if ('sharePct' in b || 'shareFixed' in b) {
        const sh = cleanShare(b);
        await t.run('UPDATE Clinics SET SharePct = ?, ShareFixed = ? WHERE Id = ?', [sh.pct, sh.fixed == null ? null : pounds(sh.fixed), id]);
        await audit(t, user, 'clinic.share', 'Clinic', id, { old: { pct: old.SharePct == null ? null : Number(old.SharePct), fixed: old.ShareFixed == null ? null : Number(old.ShareFixed) }, now: { name, pct: sh.pct, fixed: sh.fixed == null ? null : pounds(sh.fixed) } });
      }
      if (old.Name !== name) await t.run('UPDATE Doctors SET Specialty = ? WHERE ClinicId = ? AND Specialty = ?', [name, id, old.Name]);
      await audit(t, user, 'clinic.update', 'Clinic', id, { old: { name: old.Name, storeId: old.StoreId, active: toBool(old.Active) }, now: { name, storeId, active } });
      return id;
    }
    const sh = cleanShare(b);
    const nid = await t.insert('Clinics', { Name: name, StoreId: storeId, SortOrder: 100, Active: active ? 1 : 0, CreatedAt: new Date(), SharePct: sh.pct, ShareFixed: sh.fixed == null ? null : pounds(sh.fixed) });
    await audit(t, user, 'clinic.create', 'Clinic', nid, { now: { name, storeId } });
    return nid;
  }
  r.get('/clinics', async (req, res) => res.json({ clinics: await clinicsFull(), stores: (await db.query('SELECT Id, Name FROM Stores WHERE Active = 1 ORDER BY SortOrder, Id')).map((s) => ({ id: s.Id, name: s.Name })) }));
  r.post('/clinics', async (req, res) => {
    const id = await db.tx((t) => saveClinic(t, req.user, null, req.body || {}));
    res.status(201).json({ clinic: (await clinicsFull()).find((x) => x.id === id) });
  });
  r.put('/clinics/:id', async (req, res) => {
    const id = intId(req.params.id);
    await db.tx((t) => saveClinic(t, req.user, id, req.body || {}));
    res.json({ clinic: (await clinicsFull()).find((x) => x.id === id) });
  });
  r.delete('/clinics/:id', async (req, res) => {
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const c = await t.one('SELECT * FROM Clinics WHERE Id = ?', [id]);
      if (!c) throw notFound('العيادة مش موجودة');
      if (await t.one('SELECT Id FROM Doctors WHERE ClinicId = ?', [id])) throw conflict('فيه أطباء مربوطين بالعيادة دي. وقّفها بدل المسح');
      await t.run('DELETE FROM Clinics WHERE Id = ?', [id]);
      await audit(t, req.user, 'clinic.delete', 'Clinic', id, { old: { name: c.Name } });
    });
    res.json({ ok: true });
  });

  r.get('/doctors', async (req, res) => res.json({ doctors: await doctorsFull(db) }));
  r.post('/doctors', async (req, res) => {
    const d = validateDoctor(req.body || {});
    const id = await db.tx(async (t) => {
      const nid = await saveDoctor(t, req.user, null, d);
      await audit(t, req.user, 'doctor.create', 'Doctor', nid, { now: { name: d.name, shares: d.shares } });
      return nid;
    });
    res.status(201).json({ doctor: (await doctorsFull(db)).find((x) => x.id === id) });
  });
  r.put('/doctors/:id', async (req, res) => {
    const id = intId(req.params.id);
    const old = (await doctorsFull(db)).find((x) => x.id === id);
    if (!old) throw notFound('الدكتور مش موجود');
    const d = validateDoctor(req.body || {});
    await db.tx(async (t) => {
      await saveDoctor(t, req.user, id, d);
      await audit(t, req.user, 'doctor.update', 'Doctor', id, { old: { name: old.name, active: old.active, shares: old.shares }, now: { name: d.name, active: d.active, shares: d.shares } });
    });
    res.json({ doctor: (await doctorsFull(db)).find((x) => x.id === id) });
  });

  // ----- الأدوار (بيانات) -----
  const roleDto = async () => {
    const roles = await db.query('SELECT * FROM Roles ORDER BY SortOrder, Code');
    const perms = await db.query('SELECT RoleCode, Perm FROM RolePermissions');
    const users = await db.query('SELECT Role, COUNT(*) AS N FROM Users GROUP BY Role');
    return roles.map((x) => ({ code: x.Code, name: x.Name, description: x.Description || '', color: x.Color || '', home: x.Home || '/', system: toBool(x.IsSystem), all: perms.some((p) => p.RoleCode === x.Code && p.Perm === '*'),
      perms: perms.filter((p) => p.RoleCode === x.Code && p.Perm !== '*').map((p) => p.Perm), users: Number(users.find((u) => u.Role === x.Code)?.N || 0) }));
  };
  const HOMES = ['/', '/cashier', '/radiology', '/lab', '/accounts', '/pharmacy', '/claims', '/finance', '/stores'];
  const cleanRole = (b) => {
    const errors = {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) errors.name = 'اكتب اسم الدور';
    const perms = [...new Set((Array.isArray(b.perms) ? b.perms : []).map(String))];
    if (perms.some((p) => !PERM_LABELS[p])) errors.perms = 'فيه صلاحية مش معروفة';
    if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
    return { name, perms, description: String(b.description || '').trim().slice(0, 300) || null, color: /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : null, home: HOMES.includes(b.home) ? b.home : '/' };
  };
  r.get('/roles', async (req, res) => { res.json({ roles: await roleDto(), groups: PERM_GROUPS.map(([title, m]) => ({ title, perms: Object.entries(m).map(([k, n]) => ({ key: k, name: n })) })) }); });
  r.post('/roles', async (req, res) => {
    const c = cleanRole(req.body || {});
    if (await db.one('SELECT Code FROM Roles WHERE Name = ?', [c.name])) throw bad('اسم الدور ده موجود', { errors: { name: 'اسم الدور ده موجود' } });
    const code = await db.tx(async (t) => {
      const n = Number((await t.one('SELECT COUNT(*) AS N FROM Roles'))?.N || 0);
      let code = 'role' + (n + 1);
      while (await t.one('SELECT Code FROM Roles WHERE Code = ?', [code])) code += 'x';
      await t.insert('Roles', { Code: code, Name: c.name, Description: c.description, Color: c.color, Home: c.home, IsSystem: 0, Active: 1, SortOrder: n + 1 });
      for (const p of c.perms) await t.insert('RolePermissions', { RoleCode: code, Perm: p });
      await audit(t, req.user, 'role.create', 'Role', 0, { now: { code, name: c.name, perms: c.perms } });
      return code;
    });
    await loadRoles(db);
    res.status(201).json({ role: (await roleDto()).find((x) => x.code === code) });
  });
  r.put('/roles/:code', async (req, res) => {
    const code = String(req.params.code);
    const old = await db.one('SELECT * FROM Roles WHERE Code = ?', [code]);
    if (!old) throw notFound('الدور مش موجود');
    if (code === 'manager') throw bad('دور المدير ثابت ومينفعش يتعدّل');
    const c = cleanRole(req.body || {});
    if (await db.one('SELECT Code FROM Roles WHERE Name = ? AND Code <> ?', [c.name, code])) throw bad('اسم الدور ده موجود', { errors: { name: 'اسم الدور ده موجود' } });
    if (code === req.user.role) throw bad('مينفعش تعدّل دورك أنت');
    const before = (await db.query('SELECT Perm FROM RolePermissions WHERE RoleCode = ?', [code])).map((x) => x.Perm);
    await db.tx(async (t) => {
      await t.run('UPDATE Roles SET Name = ?, Description = ?, Color = ?, Home = ? WHERE Code = ?', [c.name, c.description, c.color, c.home, code]);
      await t.run('DELETE FROM RolePermissions WHERE RoleCode = ?', [code]);
      for (const p of c.perms) await t.insert('RolePermissions', { RoleCode: code, Perm: p });
      await audit(t, req.user, 'role.update', 'Role', 0, { old: { code, name: old.Name, perms: before }, now: { code, name: c.name, perms: c.perms } });
    });
    await loadRoles(db);
    res.json({ role: (await roleDto()).find((x) => x.code === code) });
  });
  r.delete('/roles/:code', async (req, res) => {
    const code = String(req.params.code);
    const old = await db.one('SELECT * FROM Roles WHERE Code = ?', [code]);
    if (!old) throw notFound('الدور مش موجود');
    if (toBool(old.IsSystem)) throw bad('الأدوار الأساسية مينفعش تتمسح');
    if (Number((await db.one('SELECT COUNT(*) AS N FROM Users WHERE Role = ?', [code])).N)) throw bad('فيه موظفين على الدور ده. انقلهم لدور تاني الأول');
    await db.tx(async (t) => {
      await t.run('DELETE FROM RolePermissions WHERE RoleCode = ?', [code]);
      await t.run('DELETE FROM Roles WHERE Code = ?', [code]);
      await audit(t, req.user, 'role.delete', 'Role', 0, { old: { code, name: old.Name } });
    });
    await loadRoles(db);
    res.json({ ok: true });
  });

  // ----- المستخدمين -----
  r.get('/users', async (req, res) => {
    const rows = await db.query('SELECT * FROM Users ORDER BY Active DESC, Role, FullName');
    res.json({ users: rows.map(userDto), groups: PERM_GROUPS.map(([title, m]) => ({ title, perms: Object.entries(m).map(([k, n]) => ({ key: k, name: n })) })), rolePerms: PERMISSIONS, roles: ROLES, roleList: (await roleDto()).map((x) => ({ code: x.code, name: x.name, description: x.description, color: x.color })), grants: GRANTS, stores: (await db.query('SELECT Id, Name, Kind FROM Stores WHERE Active = 1 ORDER BY SortOrder, Id')).map((x) => ({ id: x.Id, name: x.Name, kind: x.Kind })) });
  });
  r.post('/users', async (req, res) => {
    const b = req.body || {};
    const errors = {};
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) errors.username = 'اسم الدخول حروف إنجليزي صغيرة وأرقام (3 حروف على الأقل)';
    const name = cleanName(b.name);
    if (!name) errors.name = 'اكتب الاسم';
    if (!ROLES[b.role]) errors.role = 'اختار الدور';
    if (String(b.password || '').length < 6) errors.password = 'كلمة السر 6 حروف على الأقل';
    if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
    if (await db.one('SELECT Id FROM Users WHERE Username = ?', [username])) throw bad('اسم الدخول ده مستخدم', { errors: { username: 'اسم الدخول ده مستخدم' } });
    const hash = await hashPassword(b.password);
    const id = await db.tx(async (t) => {
      const uid = await t.insert('Users', { Username: username, FullName: name, Role: b.role, PasswordHash: hash, Active: 1, CreatedAt: new Date(),
        Grants: JSON.stringify(cleanGrants(b.grants) || []), Denied: JSON.stringify(cleanGrants(b.denied) || []), StoreIds: JSON.stringify(cleanStores(b.stores) || []) });
      await audit(t, req.user, 'user.create', 'User', uid, { now: { username, role: b.role } });
      return uid;
    });
    res.status(201).json({ user: userDto(await db.one('SELECT * FROM Users WHERE Id = ?', [id])) });
  });
  r.put('/users/:id', async (req, res) => {
    const id = intId(req.params.id);
    const u = await db.one('SELECT * FROM Users WHERE Id = ?', [id]);
    if (!u) throw notFound('المستخدم مش موجود');
    const b = req.body || {};
    const name = b.name !== undefined ? cleanName(b.name) : u.FullName;
    const role = b.role !== undefined ? b.role : u.Role;
    const active = b.active !== undefined ? !!b.active : toBool(u.Active);
    if (!name) throw bad('اكتب الاسم', { errors: { name: 'اكتب الاسم' } });
    if (!ROLES[role]) throw bad('اختار الدور', { errors: { role: 'اختار الدور' } });
    if (id === req.user.id && (role !== 'manager' || !active)) throw bad('مينفعش تشيل صلاحية المدير من نفسك أو توقف حسابك');
    if (u.Role === 'manager' && (role !== 'manager' || !active)) {
      const m = await db.one("SELECT COUNT(*) AS N FROM Users WHERE Role = 'manager' AND Active = 1 AND Id <> ?", [id]);
      if (Number(m.N) === 0) throw bad('لازم يفضل مدير واحد على الأقل');
    }
    await db.tx(async (t) => {
      const grants0 = cleanGrants(b.grants) ?? parseList(u.Grants);
      const denied = role === 'manager' ? [] : (cleanGrants(b.denied) ?? parseList(u.Denied));
      const grants = grants0.filter((g) => !denied.includes(g));
      if (id === req.user.id && denied.includes('settings.manage')) throw bad('مينفعش تشيل صلاحية الإعدادات من نفسك');
      const stores = cleanStores(b.stores) ?? parseList(u.StoreIds);
      await t.run('UPDATE Users SET FullName = ?, Role = ?, Active = ?, Grants = ?, Denied = ?, StoreIds = ? WHERE Id = ?', [name, role, active ? 1 : 0, JSON.stringify(grants), JSON.stringify(denied), JSON.stringify(stores), id]);
      if (!active || role !== u.Role) await destroyUserSessions(t, id);
      await audit(t, req.user, 'user.update', 'User', id, { old: { name: u.FullName, role: u.Role, active: toBool(u.Active), grants: parseList(u.Grants), denied: parseList(u.Denied), stores: parseList(u.StoreIds) }, now: { name, role, active, grants, denied, stores } });
    });
    res.json({ user: userDto(await db.one('SELECT * FROM Users WHERE Id = ?', [id])) });
  });
  r.post('/users/:id/password', async (req, res) => {
    const id = intId(req.params.id);
    const pw = String(req.body?.password || '');
    if (pw.length < 6) throw bad('كلمة السر 6 حروف على الأقل', { errors: { password: 'كلمة السر 6 حروف على الأقل' } });
    if (!(await db.one('SELECT Id FROM Users WHERE Id = ?', [id]))) throw notFound('المستخدم مش موجود');
    const hash = await hashPassword(pw);
    await db.tx(async (t) => {
      await t.run('UPDATE Users SET PasswordHash = ? WHERE Id = ?', [hash, id]);
      await destroyUserSessions(t, id, id === req.user.id ? req.token : null);
      await audit(t, req.user, 'user.password', 'User', id);
    });
    res.json({ ok: true });
  });

  roomsRoutes(r, db);
  floorPriceRoutes(r, db);

  // ----- سجل التعديلات -----
  r.get('/audit', async (req, res) => {
    const g = GROUPS[req.query.group];
    const where = g ? 'WHERE ' + g.map(() => 'a.Action LIKE ?').join(' OR ') : '';
    const rows = await db.query(db.top(
      `SELECT a.*, u.FullName AS UserName FROM AuditLog a LEFT JOIN Users u ON u.Id = a.UserId ${where} ORDER BY a.Id DESC`, 300),
    g ? g.map((p) => p + '%') : []);
    const names = { service: new Map(), doctor: new Map(), user: new Map() };
    for (const s of await db.query('SELECT Id, Name FROM Services')) names.service.set(s.Id, s.Name);
    for (const s of await db.query('SELECT Id, Name FROM Doctors')) names.doctor.set(s.Id, s.Name);
    for (const s of await db.query('SELECT Id, FullName FROM Users')) names.user.set(s.Id, s.FullName);
    res.json({
      entries: rows.map((a) => ({
        id: a.Id, at: toIso(a.At), user: a.UserName || 'النظام', action: a.Action, label: ACTIONS[a.Action] || a.Action,
        group: Object.entries(GROUPS).find(([, ps]) => ps.some((p) => a.Action.startsWith(p)))?.[0] || 'other',
        text: auditText(a, names), note: a.Note, entity: a.Entity, entityId: a.EntityId,
      })),
    });
  });

  return r;
}
