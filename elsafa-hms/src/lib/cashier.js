// الخزينة: أذونات الدفع، ومين بيقبض، وتسمية الورديات
import { cairoDate, cairoMinutes, pounds } from './util.js';
import { audit } from './auth.js';
import { R } from './runtime.js';

// أسماء الورديات بتتقري من الإعدادات (R.shiftNames)، ده Proxy عشان الكود القديم يفضل شغال
export const SHIFT_LABELS = new Proxy({}, { get: (_, k) => R.shiftNames[k], ownKeys: () => ['am', 'pm', 'night'], getOwnPropertyDescriptor: (_, k) => (['am', 'pm', 'night'].includes(k) ? { enumerable: true, configurable: true, value: R.shiftNames[k] } : undefined) });
export const ORDER_KINDS = { visit: 'خدمات زيارة', adm_pay: 'دفعة دخول', deposit: 'تأمين دخول', discharge: 'خروج', refund_due: 'مرتجع موافقة' };

/** الوردية من وقت فتحها حسب مواعيد الإعدادات (R.shifts) */
export function shiftLabel(d = new Date()) {
  const m = cairoMinutes(d);
  if (m >= R.shifts.am && m < R.shifts.pm) return 'am';
  if (m >= R.shifts.pm && m < R.shifts.night) return 'pm';
  return 'night';
}
/** يوم الخزينة: بيبدأ من R.dayStart، وللي قبله بيتحسب على اليوم اللي فات */
export function businessDate(d = new Date()) {
  if (cairoMinutes(d) < R.dayStart) return cairoDate(new Date(d.getTime() - 12 * 3600e3));
  return cairoDate(d);
}

/** موظف خزينة ورديته مفتوحة دلوقتي؟ */
export async function cashierOnDuty(t) {
  const since = new Date(Date.now() - R.dutyHours * 3600e3);
  return t.one(t.top(`SELECT s.Id, s.UserId, u.FullName FROM Shifts s JOIN Users u ON u.Id = s.UserId
     WHERE s.ClosedAt IS NULL AND u.Role = 'cashier' AND u.Active = 1 AND s.OpenedAt >= ? ORDER BY s.Id DESC`, 1), [since]);
}

/** الاستقبال يعمل إذن دفع بدل ما يقبض؟ (فيه خزينة شغالة والإعداد مش مقفول) */
export async function mustOrder(t, user) {
  // الخزينة والمدير والصيدلية (بتحصّل بنفسها وتسلّم آخر الشيفت) مش بيعملوا أذونات
  if (['cashier', 'manager', 'pharmacist'].includes(user.role)) return false;
  const mode = await t.one("SELECT Value FROM AppSettings WHERE [Key] = 'cashierMode'");
  if (mode?.Value === 'off') return false;
  return !!(await cashierOnDuty(t));
}

/** إذن دفع جديد. amount و credit و discount بالقروش */
export async function createOrder(t, user, o) {
  const no = await t.nextNumber('order');
  const now = new Date();
  const id = await t.insert('PayOrders', {
    OrderNo: no, Kind: o.kind, VisitId: o.visitId || null, AdmissionId: o.admissionId || null, PatientId: o.patientId,
    Amount: pounds(o.amount), Credit: pounds(o.credit || 0), Discount: pounds(o.discount || 0),
    Description: String(o.description || ORDER_KINDS[o.kind]).slice(0, 400), Payload: JSON.stringify(o.payload || {}),
    Status: 'pending', CreatedAt: now, CreatedBy: user.id,
  });
  for (const itemId of o.lockItems || []) await t.run('UPDATE VisitItems SET PendingOrderId = ? WHERE Id = ?', [id, itemId]);
  await audit(t, user, 'order.create', 'PayOrder', id, { now: { no, kind: o.kind, amount: pounds(o.amount) } });
  return { id, no, kind: o.kind, amount: pounds(o.amount), credit: pounds(o.credit || 0), description: o.description };
}
