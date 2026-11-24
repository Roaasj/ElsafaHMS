// الخدمات والأسعار والأطباء
//
// مصدر الأطباء ومواعيدهم معزول هنا (doctorSource)، عشان لما نربط بـ«جدول اليوم»
// نبدّل المصدر بس، والاستقبال والخزينة يفضلوا زي ما هم.
import { router } from '../lib/router.js';
import { searchKey } from '../../shared/text.js';
import { need, can } from '../lib/auth.js';
import { cents, pounds, cairoWeekday, cairoMinutes, hhmmToMin } from '../lib/util.js';
import { toBool } from '../db/index.js';
import { LIVE, visitTypeCodes } from '../lib/lookups.js';
import { qty2, pct2 } from '../../shared/money.js';

// أنواع الزيارة وأقسام الخدمات من القوائم المرجعية (بتتحدّث لوحدها بعد أي تعديل من الشاشة)
export const VISIT_TYPES = LIVE.VISIT_TYPES;
export const DEPTS = LIVE.DEPTS;

/** السعر الساري لكل خدمة (آخر سعر تاريخه قبل دلوقتي) */
export function currentPriceSql() {
  return `(SELECT sp.Price FROM ServicePrices sp WHERE sp.ServiceId = s.Id AND sp.EffectiveFrom = (
             SELECT MAX(sp2.EffectiveFrom) FROM ServicePrices sp2 WHERE sp2.ServiceId = s.Id AND sp2.EffectiveFrom <= ?))`;
}

export async function getService(db, id) {
  const r = await db.one(`SELECT s.*, ${currentPriceSql()} AS Price FROM Services s WHERE s.Id = ?`, [new Date(), id]);
  return r && serviceDto(r);
}

function serviceDto(r) {
  return {
    id: r.Id, code: r.Code, name: r.Name, dept: r.Dept, payTiming: r.PayTiming,
    hasDoctor: toBool(r.HasDoctor), quick: toBool(r.Quick), active: toBool(r.Active),
    includedNights: r.IncludedNights == null ? null : Number(r.IncludedNights),
    price: r.Price == null ? null : pounds(cents(r.Price)),
    ticketCat: r.TicketCat || null, openPrice: toBool(r.OpenPrice),
  };
}

/** نسبة الدكتور: خدمة محددة > قسم > عامة */
export async function resolveDoctorPct(db, doctorId, serviceId, dept) {
  if (!doctorId) return 0;
  const rows = await db.query('SELECT ServiceId, Dept, Pct FROM DoctorShares WHERE DoctorId = ?', [doctorId]);
  const bySvc = rows.find((x) => x.ServiceId === serviceId);
  if (bySvc) return Number(bySvc.Pct);
  const byDept = rows.find((x) => x.ServiceId == null && x.Dept === dept);
  if (byDept) return Number(byDept.Pct);
  const gen = rows.find((x) => x.ServiceId == null && x.Dept == null);
  return gen ? Number(gen.Pct) : 0;
}

/** نصيب الدكتور {pct, fixed}: صف الدكتور (استثناء: خدمة > قسم > عامة) ثم نسبة/مبلغ الخدمة ثم افتراضي عيادته. fixed = مبلغ للوحدة */
export async function resolveDoctorShare(db, doctorId, serviceId, dept) {
  if (!doctorId) return { pct: 0, fixed: 0 };
  const own = await resolveDoctorPct(db, doctorId, serviceId, dept);
  if (own > 0) return { pct: own, fixed: 0 };
  const lv = (x) => {
    const fixed = x?.ShareFixed == null ? 0 : cents(x.ShareFixed), pct = x?.SharePct == null ? 0 : Number(x.SharePct);
    return fixed > 0 ? { pct: 0, fixed } : pct > 0 ? { pct, fixed: 0 } : null;
  };
  const svc = lv(await db.one('SELECT SharePct, ShareFixed FROM Services WHERE Id = ?', [serviceId]));
  if (svc) return svc;
  const cl = lv(await db.one('SELECT c.SharePct, c.ShareFixed FROM Doctors d JOIN Clinics c ON c.Id = d.ClinicId WHERE d.Id = ?', [doctorId]));
  return cl || { pct: 0, fixed: 0 };
}

/** المصدر الحالي للأطباء: جداول Doctors و DoctorSchedule في نفس القاعدة */
export const doctorSource = {
  async list(db, { now = new Date() } = {}) {
    const docs = await db.query('SELECT Id, Name, Specialty, Active FROM Doctors WHERE Active = 1 ORDER BY Name');
    const wd = cairoWeekday(now);
    const sched = await db.query('SELECT DoctorId, FromTime, ToTime FROM DoctorSchedule WHERE Weekday = ?', [wd]);
    const minute = cairoMinutes(now);
    return docs.map((d) => {
      const slots = sched.filter((s) => s.DoctorId === d.Id).map((s) => ({ from: s.FromTime.trim(), to: s.ToTime.trim() }));
      const presentNow = slots.some((s) => {
        let a = hhmmToMin(s.from), b = hhmmToMin(s.to);
        if (a == null || b == null) return false;
        if (b <= a) b += 1440; // بعد نص الليل
        const m = minute < a ? minute + 1440 : minute;
        return m >= a && m <= b;
      });
      return { id: d.Id, name: d.Name, specialty: d.Specialty, today: slots.length > 0, slots, presentNow };
    });
  },
};

export default function catalogRouter(db) {
  const r = router();

  r.get('/services', async (req, res) => {
    need(req.user, 'visits.read');
    const rows = await db.query(
      `SELECT s.*, ${currentPriceSql()} AS Price FROM Services s WHERE s.Active = 1 ORDER BY s.Dept, s.SortOrder, s.Name`,
      [new Date()]);
    const q = searchKey(req.query.q || '');
    const list = rows.map(serviceDto).filter((s) => s.price != null && (!q || searchKey(s.name).includes(q) || s.code.toLowerCase().includes(q)));
    res.json({ depts: DEPTS, services: list });
  });

  r.get('/doctors', async (req, res) => {
    need(req.user, 'visits.read');
    const list = await doctorSource.list(db);
    list.sort((a, b) => (b.presentNow - a.presentNow) || (b.today - a.today) || a.name.localeCompare(b.name, 'ar'));
    res.json({ doctors: list });
  });

  // المخازن اللي الموظف بيصرف منها في الزيارة، والمخزن الافتراضي لكل نوع زيارة
  r.get('/stock-stores', async (req, res) => {
    need(req.user, 'visit.stock');
    const all = can(req.user, 'stock.all') || can(req.user, 'settings.manage');
    const rows = await db.query("SELECT * FROM Stores WHERE Active = 1 AND Kind <> 'main' ORDER BY SortOrder, Id");
    const clinicStores = new Set((await db.query('SELECT StoreId FROM Clinics WHERE StoreId IS NOT NULL')).map((c) => c.StoreId));
    const own = rows.filter((x) => all || (req.user.stores || []).includes(x.Id));
    const mine = rows.filter((x) => own.includes(x) || clinicStores.has(x.Id)); // مخازن العيادات متاحة لمن يصرف في الزيارات
    const def = {};
    for (const t of [...visitTypeCodes(), 'pharmacy']) {
      const d = t === 'pharmacy' ? own.find((x) => x.Kind === 'pharmacy') : own.find((x) => x.Dept === t);
      def[t] = d?.Id || own[0]?.Id || null;
    }
    res.json({ stores: mine.map((x) => ({ id: x.Id, name: x.Name, kind: x.Kind, holds: x.Holds, dept: x.Dept, clinic: clinicStores.has(x.Id) })), defaults: def });
  });
  r.get('/store-stock/:id', async (req, res) => {
    need(req.user, 'visit.stock');
    const id = Number(req.params.id) || 0;
    const isClinic = !!(await db.one('SELECT Id FROM Clinics WHERE StoreId = ?', [id]));
    if (!(can(req.user, 'stock.all') || can(req.user, 'settings.manage') || (req.user.stores || []).includes(id) || isClinic)) return res.json({ items: {} });
    const rows = await db.query('SELECT ItemId, SUM(Qty) AS Q FROM StockBatches WHERE StoreId = ? GROUP BY ItemId', [id]);
    res.json({ items: Object.fromEntries(rows.map((r) => [r.ItemId, qty2(r.Q)])) });
  });

  r.get('/managers', async (req, res) => {
    need(req.user, 'visits.read');
    const rows = await db.query("SELECT Id, FullName FROM Users WHERE Role = 'manager' AND Active = 1 ORDER BY FullName");
    res.json({ managers: rows.map((x) => ({ id: x.Id, name: x.FullName })) });
  });

  return r;
}
