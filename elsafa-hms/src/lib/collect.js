// تحصيل مجمّع لمريض واحد: كل البنود غير المدفوعة في زياراته المفتوحة (بيستخدمه الدفع المدمج بين المنشأتين)
import { bad, conflict, cents, pounds } from './util.js';
import { payVisit } from '../routes/visits.js';

/** البنود المستحقة: نشطة، مش مدفوعة، مش محجوزة في إذن دفع */
export async function dueItems(db, patientId) {
  const rows = await db.query(
    `SELECT i.Id, i.VisitId, i.ServiceName, i.Amount, i.PatientAmount, v.VisitNo
       FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId
      WHERE v.PatientId = ? AND v.Status = 'open' AND i.Status = 'active' AND i.PaidReceiptId IS NULL AND i.PendingOrderId IS NULL
      ORDER BY i.VisitId, i.Id`, [patientId]);
  const items = rows.map((i) => ({ id: i.Id, visitId: i.VisitId, visitNo: i.VisitNo, name: i.ServiceName, cents: cents(i.PatientAmount ?? i.Amount) })).filter((i) => i.cents > 0);
  return { items, total: items.reduce((s, i) => s + i.cents, 0) };
}

/** بيدفع كل المستحق: النقدي الأول بالتتابع على الزيارات والباقي فيزا. بيرجّع الإيصالات */
export async function collectAll(t, user, patientId, { cash, card, manualNo }) {
  const due = await dueItems(t, patientId);
  if (!due.items.length) throw conflict('مفيش مستحقات على المريض ده');
  if (cash + card !== due.total) throw bad(`مجموع النقدي والفيزا (${pounds(cash + card)}) لازم يساوي المستحق (${pounds(due.total)})`);
  const byVisit = new Map();
  for (const i of due.items) byVisit.set(i.visitId, [...(byVisit.get(i.visitId) || []), i]);
  let cashLeft = cash;
  const out = [];
  for (const [visitId, list] of byVisit) {
    const tot = list.reduce((s, i) => s + i.cents, 0);
    const c = Math.min(cashLeft, tot);
    cashLeft -= c;
    const rid = await payVisit(t, user, visitId, { itemIds: list.map((i) => i.id), cash: pounds(c), card: pounds(tot - c), manualNo }, {});
    const r = await t.one('SELECT ReceiptNo FROM Receipts WHERE Id = ?', [rid]);
    out.push({ id: rid, no: r.ReceiptNo, amount: pounds(tot) });
  }
  return out;
}
