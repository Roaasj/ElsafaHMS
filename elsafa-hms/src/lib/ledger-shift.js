// ترحيل إيرادات وفلوس وردية الخزينة كقيد واحد عند قفل الوردية (idempotent: وردية واحدة = قيد واحد)
import { cents, pounds } from './util.js';
import { toDateStr } from '../db/index.js';
import { businessDate } from './cashier.js';
import { post, ledgerOn } from './ledger.js';

const DEPT_KEY = { clinic: 'revenue.clinic', emergency: 'revenue.emergency', lab: 'revenue.lab', radiology: 'revenue.radiology', drugs: 'revenue.drugs', pharmacy: 'revenue.drugs', supplies: 'revenue.supplies' };
const deptKey = (d) => DEPT_KEY[d] || 'revenue.other';

/** مدفوع الإقامة قبل الإيصال النهائي: تأمين + دفعات − مرتجعاتها (بالقروش) */
async function paidBefore(t, admissionId, beforeId) {
  const rows = await t.query("SELECT Kind, Net, ReversesReceiptId FROM Receipts WHERE AdmissionId = ? AND Id < ? AND Kind IN ('deposit','payment','refund')", [admissionId, beforeId]);
  let paid = 0;
  for (const x of rows) paid += cents(x.Net); // المرتجعات سالبة أصلًا
  return paid;
}

/** بيحسب سطور القيد لوردية من إيصالاتها. بيرجع { lines, receipts } */
export async function shiftLines(t, shiftId) {
  const rc = await t.query('SELECT * FROM Receipts WHERE ShiftId = ? ORDER BY Id', [shiftId]);
  const clinicMapped = new Set((await t.query("SELECT [Key] FROM AccountMap WHERE [Key] LIKE 'revenue.clinic.%'")).map((x) => Number(String(x.Key).split('.')[2])));
  const acc = new Map(); // key -> صافي (مدين +، دائن −)
  const add = (key, v) => { if (v) acc.set(key, (acc.get(key) || 0) + v); };
  for (const x of rc) {
    const net = cents(x.Net), cash = cents(x.Cash), card = cents(x.Card), credit = cents(x.Credit);
    // المقبوض: نقدية/فيزا/آجل (الآجل ممكن يبقى سالب في الإلغاء)
    add('cash.main', cash); add('cash.card', card); add('patient.credit', credit);
    const received = cash + card + credit;
    const base = x.Kind === 'refund' && x.ReversesReceiptId ? await t.one('SELECT * FROM Receipts WHERE Id = ?', [x.ReversesReceiptId]) : x;
    const isFinal = (x.Kind === 'final' || x.Kind === 'return') || (base && x.Kind === 'refund' && (base.Kind === 'final' || base.Kind === 'return'));
    if (x.AdmissionId && !x.VisitId) {
      if (isFinal) {
        const orig = x.Kind === 'refund' ? base : x;
        const applied = await paidBefore(t, x.AdmissionId, orig.Id) * (x.Kind === 'refund' ? -1 : 1);
        add('patient.deposits', applied);       // استهلاك التأمين/الدفعات
        add('revenue.inpatient', -(received + applied)); // إيراد الإقامة بعد الخصم
      } else add('patient.deposits', -received); // تأمين أو دفعة تحت الحساب (أو مرتجعها)
      continue;
    }
    // إيصالات الزيارات: الإيراد بالأقسام بنسبة سطور الإيصال، والباقي على إيرادات أخرى
    const src = x.Kind === 'refund' && x.ReversesReceiptId ? x.Id : x.Id;
    const ls = await t.query(`SELECT l.Amount, l.DiscountShare, vi.Dept, d.ClinicId FROM ReceiptLines l LEFT JOIN VisitItems vi ON vi.Id = l.VisitItemId LEFT JOIN Doctors d ON d.Id = vi.DoctorId WHERE l.ReceiptId = ?`, [src]);
    const w = new Map();
    for (const l of ls) { let k = deptKey(l.Dept);
      if (k === 'revenue.clinic' && l.ClinicId && clinicMapped.has(Number(l.ClinicId))) k = `revenue.clinic.${l.ClinicId}`; w.set(k, (w.get(k) || 0) + Math.abs(cents(l.Amount) - cents(l.DiscountShare))); }
    const tw = [...w.values()].reduce((a, b) => a + b, 0);
    if (!tw) { add('revenue.other', -received); continue; }
    let left = received;
    const keys = [...w.keys()];
    keys.forEach((k, i) => { const part = i === keys.length - 1 ? left : Math.round((received * w.get(k)) / tw); left -= part; add(k, -part); });
  }
  const lines = [];
  for (const [key, v] of acc) { if (v > 0) lines.push({ key, debit: v }); else if (v < 0) lines.push({ key, credit: -v }); }
  return { lines, receipts: rc.length };
}

/** ترحيل وردية مقفولة (لو لسه ماترحلتش). بيرجع القيد أو null */
export async function postShift(t, user, shiftId) {
  if (!(await ledgerOn(t))) return null;
  if (await t.one("SELECT Id FROM JournalEntries WHERE Source = 'shift' AND SourceId = ? AND Status = 'posted'", [shiftId])) return null;
  const s = await t.one('SELECT s.*, u.FullName FROM Shifts s JOIN Users u ON u.Id = s.UserId WHERE s.Id = ?', [shiftId]);
  if (!s || !s.ClosedAt) return null;
  const { lines, receipts } = await shiftLines(t, shiftId);
  if (!lines.length) return null;
  const date = toDateStr(s.BusinessDate) || businessDate(s.OpenedAt);
  return post(t, user, { date, source: 'shift', sourceId: shiftId, description: `إيرادات وردية ${s.FullName} (${receipts} إيصال)`, lines });
}

/** قفل الوردية ما يتعطلش لو الدفاتر ناقصها ربط أو مقفولة: بنسجّلها كمتأخرة والمدير يرحّلها من شاشة الدفاتر */
export async function postShiftSafe(t, user, shiftId) {
  try { await postShift(t, user, shiftId); return true; } catch (e) {
    if (e?.status && e.status < 500) return false;
    throw e;
  }
}

/** الورديات المقفولة اللي مالهاش قيد */
export async function pendingShifts(db, from) {
  const rows = await db.query("SELECT s.Id, s.OpenedAt, s.ClosedAt FROM Shifts s WHERE s.ClosedAt IS NOT NULL ORDER BY s.Id");
  const done = new Set((await db.query("SELECT SourceId FROM JournalEntries WHERE Source = 'shift' AND Status = 'posted'")).map((x) => Number(x.SourceId)));
  const f = from || '';
  return rows.filter((x) => !done.has(Number(x.Id)) && (!f || toDateStr(x.OpenedAt) >= f)).map((x) => x.Id);
}
