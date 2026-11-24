// أسعار الأدوار: نفس الخدمة ونفس الدرجة بسعر مختلف حسب الدور اللي المريض فيه
import { cents, cairoDate, cairoDayRange } from './util.js';

/** الدور اللي المريض كان فيه في لحظة معينة (آخر تنقل قبلها) */
export async function floorAt(t, admissionId, at = new Date()) {
  const rows = await t.query(
    `SELECT m.FromAt, r.FloorId FROM BedMoves m JOIN Beds b ON b.Id = m.BedId JOIN Rooms r ON r.Id = b.RoomId
      WHERE m.AdmissionId = ? ORDER BY m.FromAt, m.Id`, [admissionId]);
  let f = rows[0]?.FloorId ?? null;
  for (const x of rows) if (new Date(x.FromAt) <= at) f = x.FloorId;
  return f;
}
/** الدور في يوم معين: آخر اليوم، أو دلوقتي لو النهارده، أو وقت القفل/الخروج لو قبلهم */
export async function floorOnDate(t, a, dateStr) {
  let at = dateStr >= cairoDate() ? new Date() : new Date(cairoDayRange(dateStr).end.getTime() - 1000);
  const stop = a.Status === 'discharged' ? a.DischargedAt : a.BillStatus === 'closed' ? a.ClosedAt : null;
  if (stop && new Date(stop) < at) at = new Date(stop);
  return floorAt(t, a.Id, at);
}
/** سعر الخدمة في الدور (بالقروش)، أو السعر الأساسي */
export async function floorServicePrice(t, floorId, serviceId, baseCents) {
  if (!floorId || !serviceId) return baseCents;
  const r = await t.one('SELECT Price FROM FloorServicePrices WHERE FloorId = ? AND ServiceId = ?', [floorId, serviceId]);
  return r ? cents(r.Price) : baseCents;
}
/** خريطة أسعار الليالي: floorId|classId → قروش */
export async function floorClassMap(t) {
  const rows = await t.query('SELECT FloorId, ClassId, NightPrice FROM FloorClassPrices');
  return new Map(rows.map((r) => [`${r.FloorId}|${r.ClassId}`, cents(r.NightPrice)]));
}
