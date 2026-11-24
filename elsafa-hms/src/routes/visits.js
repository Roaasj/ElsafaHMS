// الزيارة الخارجية: فتح، إضافة خدمات، الدفع والإيصال، الإلغاء بإيصال عكسي
import { LIVE, isVisitType } from '../lib/lookups.js';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, parseMoney, cairoDayRange } from '../lib/util.js';
import { toIso } from '../db/index.js';
import { patientDto } from './patients.js';
import { getService, resolveDoctorShare, VISIT_TYPES } from './catalog.js';
import { mustOrder, createOrder, shiftLabel, businessDate } from '../lib/cashier.js';
import { loadPayer, servicePrice, cover, ledgerCharge, ledgerReverse, PAYER_FINAL, PAYER_LIVE } from '../lib/coverage.js';
import { consume, giveBack, unitsOf, deptStore, needStore } from '../lib/stock.js';
import { stockPrice, COVER_DEPT } from '../lib/tickets.js';
import { latinDigits } from '../../shared/text.js';
import { R } from '../lib/runtime.js';
import { clinicStoreOfVisit, isClinicStore } from '../lib/clinics.js';

export const VISIT_NAMES = LIVE.VISIT_NAMES;
/** مخزن الزيارة الافتراضي: الصيدلية لبيع الصيدلية، ومخزن القسم للطوارئ والعيادات */
async function visitStore(t, type) {
  if (type === 'pharmacy') return t.one(t.top("SELECT * FROM Stores WHERE Kind = 'pharmacy' AND Active = 1 ORDER BY SortOrder, Id", 1));
  return deptStore(t, type);
}
const moveKind = (v, back = false) => (v.Type === 'pharmacy' ? (back ? 'sale_back' : 'sale') : (back ? 'visit_back' : 'visit'));

async function loadVisit(db, id) {
  const v = await db.one(
    `SELECT v.*, u.FullName AS OpenedByName, py.Name AS PayerName, pt.Name AS TierName FROM Visits v JOIN Users u ON u.Id = v.OpenedBy
       LEFT JOIN Payers py ON py.Id = v.PayerId LEFT JOIN PayerTiers pt ON pt.Id = v.TierId WHERE v.Id = ?`, [id]);
  if (!v) throw notFound('الزيارة دي مش موجودة');
  return v;
}

async function clinicStoreDto(db, id) {
  const s = await clinicStoreOfVisit(db, id);
  return s ? { id: s.Id, name: s.Name } : null;
}
export async function visitDetails(db, id) {
  const v = await loadVisit(db, id);
  const patient = patientDto(await db.one('SELECT * FROM Patients WHERE Id = ?', [v.PatientId]));
  const items = await db.query(
    `SELECT i.*, d.Name AS DoctorName, u.FullName AS AddedByName, r.ReceiptNo, st.Name AS StoreName,
            ap.Id AS ApprovalId, ap.Status AS ApprovalStatus, ap.ApprovalNo, ap.ReviewNote
       FROM VisitItems i
       LEFT JOIN Doctors d ON d.Id = i.DoctorId
       JOIN Users u ON u.Id = i.AddedBy
       LEFT JOIN Receipts r ON r.Id = i.PaidReceiptId
       LEFT JOIN Stores st ON st.Id = i.StoreId
       LEFT JOIN Approvals ap ON ap.VisitItemId = i.Id AND ap.Status <> 'cancelled'
      WHERE i.VisitId = ? ORDER BY i.Id`, [id]);
  const receipts = await db.query(
    `SELECT r.*, u.FullName AS CreatedByName FROM Receipts r JOIN Users u ON u.Id = r.CreatedBy WHERE r.VisitId = ? ORDER BY r.Id`, [id]);
  let total = 0, due = 0, paid = 0, payer = 0, refundDue = 0;
  const list = items.map((i) => {
    const amount = cents(i.Amount);
    const pa = cents(i.PatientAmount ?? i.Amount), pya = cents(i.PayerAmount);
    const active = i.Status === 'active';
    if (active) {
      total += amount;
      if (i.PaidReceiptId == null) due += pa;
      if (PAYER_LIVE.includes(i.CoverStatus) && i.CoverStatus !== 'tempcash') payer += pya;
      refundDue += cents(i.RefundDue);
    }
    return {
      id: i.Id, serviceId: i.ServiceId, name: i.ServiceName, dept: i.Dept, doctorId: i.DoctorId, doctorName: i.DoctorName,
      qty: i.Qty, unitPrice: pounds(cents(i.UnitPrice)), amount: pounds(amount), payTiming: i.PayTiming,
      payerPct: Number(i.PayerPct || 0), payerAmount: pounds(pya), patientAmount: pounds(pa), cover: i.CoverStatus || 'none', refundDue: pounds(cents(i.RefundDue)),
      approval: i.ApprovalId ? { id: i.ApprovalId, status: i.ApprovalStatus, no: i.ApprovalNo, note: i.ReviewNote } : null,
      status: i.Status, paid: i.PaidReceiptId != null, receiptNo: i.ReceiptNo, receiptId: i.PaidReceiptId,
      addedAt: toIso(i.AddedAt), addedBy: i.AddedByName, voidReason: i.VoidReason, pendingOrderId: i.PendingOrderId || null,
      stockItemId: i.StockItemId || null, storeId: i.StoreId || null, storeName: i.StoreName || null, unitFactor: i.UnitFactor || null, returnedQty: Number(i.ReturnedQty || 0),
    };
  });
  for (const r of receipts) paid += cents(r.Net);
  const orders = await db.query("SELECT o.*, u.FullName AS ByName FROM PayOrders o JOIN Users u ON u.Id = o.CreatedBy WHERE o.VisitId = ? AND o.Status = 'pending' ORDER BY o.Id", [id]);
  return {
    visit: {
      id: v.Id, no: v.VisitNo, type: v.Type, status: v.Status, openedAt: toIso(v.OpenedAt), openedBy: v.OpenedByName,
      closedAt: toIso(v.ClosedAt), notes: v.Notes, diagnosis: v.Diagnosis || null,
      payer: v.PayerId ? { id: v.PayerId, name: v.PayerName, tierId: v.TierId, tierName: v.TierName, cardNo: v.CardNo } : null,
      clinicStore: v.Type === 'clinic' ? await clinicStoreDto(db, id) : null,
    },
    patient,
    items: list,
    receipts: receipts.map(receiptDto),
    orders: orders.map((o) => ({ id: o.Id, no: o.OrderNo, kind: o.Kind, amount: Number(o.Amount), credit: Number(o.Credit), description: o.Description, createdAt: toIso(o.CreatedAt), createdBy: o.ByName, createdById: o.CreatedBy })),
    totals: { total: pounds(total), payer: pounds(payer), due: pounds(due), paid: pounds(paid), refundDue: pounds(refundDue) },
  };
}

export function receiptDto(r) {
  return {
    id: r.Id, no: r.ReceiptNo, kind: r.Kind, gross: pounds(cents(r.Gross)), discount: pounds(cents(r.Discount)),
    net: pounds(cents(r.Net)), cash: pounds(cents(r.Cash)), card: pounds(cents(r.Card)), credit: pounds(cents(r.Credit)),
    createdAt: toIso(r.CreatedAt), createdBy: r.CreatedByName, reversed: r.ReversedByReceiptId != null,
    reversesId: r.ReversesReceiptId, reason: r.Reason, discountReason: r.DiscountReason, printCount: r.PrintCount, note: r.Note, manualNo: r.ManualNo || null,
  };
}

export async function currentShift(t, user) {
  const s = await t.one(t.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [user.id]);
  if (s) return s.Id;
  const now = new Date();
  return t.insert('Shifts', { UserId: user.id, OpenedAt: now, Label: shiftLabel(now), BusinessDate: businessDate(now), Explicit: 0 });
}

export async function managerId(t, id, label) {
  const m = await t.one("SELECT Id FROM Users WHERE Id = ? AND Role = 'manager' AND Active = 1", [Number(id) || 0]);
  if (!m) throw bad(`اختار اسم المدير اللي وافق على ${label}`);
  return m.Id;
}

/**
 * التعاقد اللي هيتحسب على الزيارة/الدخول:
 *  body.payer === null => نقدي ، {payerId,tierId,cardNo} => التعاقد ده ، undefined => تعاقد المريض الافتراضي لو صالح
 */
export async function pickPayer(t, patientId, choice) {
  if (choice === null || choice === false) return { payer: null, cardNo: null };
  if (choice && choice.payerId) {
    const payer = await loadPayer(t, choice.payerId, choice.tierId);
    return { payer, cardNo: str(choice.cardNo, 60) };
  }
  const p = await t.one('SELECT PayerId, TierId, CardNo FROM Patients WHERE Id = ?', [patientId]);
  if (!p?.PayerId) return { payer: null, cardNo: null };
  try {
    return { payer: await loadPayer(t, p.PayerId, p.TierId), cardNo: p.CardNo };
  } catch (e) {
    return { payer: null, cardNo: null, warn: e.message + '، والزيارة اتفتحت نقدي' };
  }
}

/** قفل الزيارات اللي اتحاسبت بالكامل من أيام فاتت */
export async function sweepVisits(db) {
  const { start } = cairoDayRange();
  const rows = await db.query(
    `SELECT v.Id FROM Visits v WHERE v.Status = 'open' AND v.OpenedAt < ?
        AND NOT EXISTS (SELECT 1 FROM VisitItems i WHERE i.VisitId = v.Id AND i.Status = 'active' AND i.PaidReceiptId IS NULL)`, [start]);
  for (const r of rows) {
    await db.run("UPDATE Visits SET Status = 'closed', ClosedAt = ? WHERE Id = ? AND Status = 'open'", [new Date(), r.Id]);
  }
  return rows.length;
}

/**
 * دفع بنود زيارة. ctx.makeOrder = يعمل إذن دفع للخزينة بدل الإيصال ، ctx.orderId = تنفيذ إذن من الخزينة
 */
export async function payVisit(t, user, id, b = {}, ctx = {}) {
  const itemIds = Array.isArray(b.itemIds) ? b.itemIds.map((x) => intId(x, 'البند')) : [];
  if (!itemIds.length) throw bad('اختار البنود اللي هتتدفع');
  const discount = parseMoney(b.discount, 'الخصم');
  const cash = parseMoney(b.cash, 'النقدي'), card = parseMoney(b.card, 'الفيزا'), credit = parseMoney(b.credit, 'الآجل');

  const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [id]);
  if (!v) throw notFound('الزيارة دي مش موجودة');
  if (v.Status !== 'open') throw conflict('الزيارة دي اتقفلت');
  const items = await t.query(
    `SELECT * FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND PaidReceiptId IS NULL AND ${ctx.orderId ? 'PendingOrderId = ?' : 'PendingOrderId IS NULL'} AND Id IN (${itemIds.map(() => '?').join(',')}) ORDER BY Id`,
    ctx.orderId ? [id, ctx.orderId, ...itemIds] : [id, ...itemIds]);
  if (items.length !== new Set(itemIds).size) throw conflict(ctx.orderId ? 'في بند اتشال أو اتغير من وقت الإذن. الاستقبال يلغي الإذن ويعمله تاني' : 'في بند اتدفع أو اتشال من جهاز تاني، أو مستني في إذن دفع بالخزينة. حدّث الشاشة');
  const pAmt = (i) => cents(i.PatientAmount ?? i.Amount);
  const gross = items.reduce((s, i) => s + pAmt(i), 0);
  if (discount > gross) throw bad('الخصم أكبر من الإجمالي');
  let discountBy = null;
  const discountReason = str(b.discountReason, 300);
  if (discount > 0) {
    if (!ctx.orderId && !can(user, 'cash.discount')) throw forbidden('مش مسموح لك تعمل خصم');
    if (!discountReason || discountReason.length < 3) throw bad('اكتب سبب الخصم');
    discountBy = await managerId(t, b.discountApprovedBy, 'الخصم');
  }
  const net = gross - discount;
  if (credit > net) throw bad('الآجل أكبر من المطلوب');
  if (ctx.makeOrder) {
    const creditBy0 = credit > 0 ? await managerId(t, b.creditApprovedBy, 'الآجل') : null;
    return createOrder(t, user, {
      kind: 'visit', visitId: id, patientId: v.PatientId, amount: net - credit, credit, discount,
      description: items.map((i) => i.ServiceName).join('، '),
      payload: { itemIds, discount: pounds(discount), discountReason, discountApprovedBy: discountBy, credit: pounds(credit), creditApprovedBy: creditBy0 },
      lockItems: items.map((i) => i.Id),
    });
  }
  if (cash + card + credit !== net) {
    throw bad(`مجموع الدفع (${pounds(cash + card + credit)}) لازم يساوي المطلوب (${pounds(net)})`);
  }
  let creditBy = null;
  if (credit > 0) creditBy = await managerId(t, b.creditApprovedBy, 'الآجل');

  const shiftId = await currentShift(t, user);
  const no = await t.nextNumber('receipt');
  const now = new Date();
  const rid = await t.insert('Receipts', {
    ReceiptNo: no, Kind: 'payment', VisitId: id, PatientId: v.PatientId, ShiftId: shiftId,
    Gross: pounds(gross), Discount: pounds(discount), Net: pounds(net),
    Cash: pounds(cash), Card: pounds(card), Credit: pounds(credit),
    DiscountReason: discount > 0 ? discountReason : null, DiscountApprovedBy: discountBy, CreditApprovedBy: creditBy,
    PrintCount: 0, CreatedAt: now, CreatedBy: user.id, ManualNo: str(ctx.manualNo ?? b.manualNo, 30), OrderId: ctx.orderId || null,
  });
  // توزيع الخصم على البنود بالنسبة، والباقي على آخر بند
  let left = discount;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const amt = pAmt(it);
    const full = cents(it.Amount);
    const share = k === items.length - 1 ? left : Math.floor((discount * amt) / gross || 0);
    left -= share;
    // نصيب الشركة اللي لسه مستحق (مش النقدي المؤقت، المريض دفعه كله)
    const payerPart = it.CoverStatus === 'tempcash' ? 0 : cents(it.PayerAmount);
    await t.insert('ReceiptLines', {
      ReceiptId: rid, VisitItemId: it.Id, Description: it.ServiceName, Qty: it.Qty,
      UnitPrice: it.UnitPrice, Amount: pounds(amt), DiscountShare: pounds(share), PayerAmount: pounds(payerPart),
    });
    await t.run('UPDATE VisitItems SET PaidReceiptId = ?, PendingOrderId = NULL WHERE Id = ? AND PaidReceiptId IS NULL', [rid, it.Id]);
    const pct = Number(it.DoctorPct);
    const fixedUnit = cents(it.DoctorFixed || 0);
    if (it.DoctorId && pct > 0) {
      // نسبة الدكتور على السعر كله (المريض + الشركة)، ونصيب الشركة «مستحق بعد التحصيل»
      const base = (it.CoverStatus === 'tempcash' ? full : amt + payerPart) - share;
      await t.insert('DoctorEarnings', {
        VisitItemId: it.Id, DoctorId: it.DoctorId, ReceiptId: rid, BaseAmount: pounds(base), Pct: pct,
        Amount: pounds(R.money.percent(base, pct)), PayerPart: pounds(R.money.percent(payerPart, pct)), CreatedAt: now,
      });
    } else if (it.DoctorId && fixedUnit > 0 && (amt + payerPart) > 0) {
      // مبلغ ثابت للوحدة: مش بيتأثر بالخصم، ونصيب الشركة منه بالتناسب مع حصتها من السعر
      const total = fixedUnit * Number(it.Qty || 1);
      const gross = it.CoverStatus === 'tempcash' ? full : amt + payerPart;
      await t.insert('DoctorEarnings', {
        VisitItemId: it.Id, DoctorId: it.DoctorId, ReceiptId: rid, BaseAmount: pounds(gross - share), Pct: 0,
        Amount: pounds(total), PayerPart: pounds(payerPart > 0 && gross > 0 ? Math.round((total * payerPart) / gross) : 0), CreatedAt: now,
      });
    }
    if (v.PayerId && PAYER_FINAL.includes(it.CoverStatus) && cents(it.PayerAmount) > 0) {
      await ledgerCharge(t, user, {
        payerId: v.PayerId, patientId: v.PatientId, visitItemId: it.Id, receiptId: rid, description: it.ServiceName, cardNo: v.CardNo,
        full, amount: cents(it.PayerAmount),
      });
    }
  }
  await audit(t, user, 'receipt.create', 'Receipt', rid, {
    now: { no, gross: pounds(gross), discount: pounds(discount), net: pounds(net), cash: pounds(cash), card: pounds(card), credit: pounds(credit) },
    note: discount > 0 ? `خصم: ${discountReason}` : null,
  });
  return rid;
}

/** صرف مرتجع النقدي المؤقت بعد اعتماد الموافقة */
export async function refundDue(t, user, id, ctx = {}) {
  const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [id]);
  if (!v) throw notFound('الزيارة دي مش موجودة');
  const items = await t.query("SELECT * FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND RefundDue > 0", [id]);
  const total = items.reduce((s, i) => s + cents(i.RefundDue), 0);
  if (!total) throw conflict('مفيش مرتجع مستحق');
  if (ctx.makeOrder) {
    if (await t.one("SELECT Id FROM PayOrders WHERE VisitId = ? AND Kind = 'refund_due' AND Status = 'pending'", [id])) throw conflict('فيه إذن صرف المرتجع ده مستني في الخزينة');
    return createOrder(t, user, { kind: 'refund_due', visitId: id, patientId: v.PatientId, amount: -total, description: 'مرتجع موافقة تعاقد: ' + items.map((i) => i.ServiceName).join('، '), payload: {} });
  }
  if (ctx.orderId && -total !== ctx.amount) throw conflict('مبلغ المرتجع اتغير من وقت الإذن. الاستقبال يلغي الإذن ويعمله تاني');
  const shiftId = await currentShift(t, user);
  const no = await t.nextNumber('receipt');
  const x = await t.insert('Receipts', {
    ReceiptNo: no, Kind: 'return', VisitId: id, AdmissionId: null, PatientId: v.PatientId, ShiftId: shiftId,
    Gross: -pounds(total), Discount: 0, Net: -pounds(total), Cash: -pounds(total), Card: 0, Credit: 0,
    Note: 'مرتجع نقدي مؤقت بعد موافقة التعاقد: ' + items.map((i) => i.ServiceName).join('، ').slice(0, 220), PrintCount: 0, CreatedAt: new Date(), CreatedBy: user.id, ManualNo: str(ctx.manualNo, 30), OrderId: ctx.orderId || null,
  });
  for (const i of items) await t.run('UPDATE VisitItems SET RefundDue = 0 WHERE Id = ?', [i.Id]);
  await audit(t, user, 'receipt.create', 'Receipt', x, { now: { no, net: -pounds(total) }, note: 'مرتجع نقدي مؤقت' });
  return x;
}

export default function visitsRouter(db) {
  const r = router();

  // فتح زيارة
  r.post('/', async (req, res) => {
    need(req.user, 'visits.write');
    const patientId = intId(req.body.patientId, 'رقم المريض');
    const type = req.body.type;
    if (!isVisitType(type) && !(type === 'pharmacy' && can(req.user, 'pharmacy.sell'))) throw bad('اختار نوع الزيارة');
    const p = await db.one('SELECT Id FROM Patients WHERE Id = ?', [patientId]);
    if (!p) throw notFound('المريض مش موجود');
    // لو فيه زيارة مفتوحة النهارده من نفس النوع، نكمل عليها بدل ما نفتح واحدة جديدة
    const { start } = cairoDayRange();
    const existing = await db.one(db.top(
      "SELECT Id FROM Visits WHERE PatientId = ? AND Type = ? AND Status = 'open' AND OpenedAt >= ? ORDER BY Id DESC", 1),
    [patientId, type, start]);
    if (existing && !req.body.forceNew) return res.json({ ...(await visitDetails(db, existing.Id)), reused: true });
    let warn = null;
    const id = await db.tx(async (t) => {
      const py = await pickPayer(t, patientId, req.body.payer);
      warn = py.warn;
      const no = await t.nextNumber('visit');
      const vid = await t.insert('Visits', {
        VisitNo: no, PatientId: patientId, Type: type, Status: 'open', OpenedAt: new Date(), OpenedBy: req.user.id,
        Notes: str(req.body.notes, 400), PayerId: py.payer?.id || null, TierId: py.payer?.tierId || null, CardNo: py.cardNo,
      });
      await audit(t, req.user, 'visit.open', 'Visit', vid, { now: { no, type } });
      return vid;
    });
    res.status(201).json({ ...(await visitDetails(db, id)), warn });
  });

  // التشخيص (الاستقبال بيكتبه للتعاقدات، وبيطلع في المطالبة)
  r.put('/:id/diagnosis', async (req, res) => {
    if (!can(req.user, 'visits.write') && !can(req.user, 'claims.fix')) throw forbidden();
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const v = await t.one('SELECT Diagnosis FROM Visits WHERE Id = ?', [id]);
      if (!v) throw notFound('الزيارة دي مش موجودة');
      const d = str(req.body?.diagnosis, 300) || null;
      if ((v.Diagnosis || null) === d) return;
      await t.run('UPDATE Visits SET Diagnosis = ? WHERE Id = ?', [d, id]);
      await audit(t, req.user, 'visit.diagnosis', 'Visit', id, { old: { diagnosis: v.Diagnosis }, now: { diagnosis: d } });
    });
    res.json(await visitDetails(db, id));
  });

  // تغيير حساب الزيارة: نقدي أو تعاقد (البنود اللي لسه ما اتدفعتش بتتحسب من جديد)
  r.put('/:id/payer', async (req, res) => {
    need(req.user, 'visits.write');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [id]);
      if (!v) throw notFound('الزيارة دي مش موجودة');
      if (v.Status !== 'open') throw conflict('الزيارة دي اتقفلت');
      const b = req.body || {};
      const payer = b.payerId ? await loadPayer(t, b.payerId, b.tierId) : null;
      const unpaid = await t.query("SELECT * FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND PaidReceiptId IS NULL", [id]);
      if (unpaid.some((i) => ['pending', 'tempcash'].includes(i.CoverStatus))) throw conflict('في بنود عليها موافقات. شيلها الأول وبعدين غيّر التعاقد');
      const paidCovered = await t.one("SELECT COUNT(*) AS N FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND PaidReceiptId IS NOT NULL AND PayerAmount > 0", [id]);
      if (Number(paidCovered.N) && (b.payerId || null) !== v.PayerId) throw conflict('في بنود اتدفعت على التعاقد ده. افتح زيارة جديدة');
      await t.run('UPDATE Visits SET PayerId = ?, TierId = ?, CardNo = ? WHERE Id = ?', [payer?.id || null, payer?.tierId || null, payer ? str(b.cardNo, 60) : null, id]);
      for (const it of unpaid) {
        await t.run('UPDATE VisitItems SET PayerAmount = 0 WHERE Id = ?', [it.Id]);
        let unit;
        if (it.StockItemId) {
          const si = await t.one('SELECT Price FROM StockItems WHERE Id = ?', [it.StockItemId]);
          unit = stockPrice(payer, cents(si?.Price ?? 0) * Number(it.UnitFactor || 1));
        } else {
          const svc = await getService(t, it.ServiceId);
          unit = await servicePrice(t, payer, it.ServiceId, cents(svc?.price ?? it.UnitPrice));
        }
        const amount = unit * it.Qty;
        const c = await cover(t, payer, { serviceId: it.ServiceId, dept: it.Dept, amount, patientId: v.PatientId, visitId: id });
        if (c.status === 'needs') throw conflict(`«${it.ServiceName}» محتاجة موافقة مع التعاقد ده. شيلها وضيفها تاني بالموافقة`);
        await t.run('UPDATE VisitItems SET UnitPrice = ?, Amount = ?, PayerPct = ?, PayerAmount = ?, PatientAmount = ?, CoverStatus = ? WHERE Id = ?',
          [pounds(unit), pounds(amount), c.pct, pounds(c.payerAmount), pounds(c.patientAmount), c.status, it.Id]);
      }
      await audit(t, req.user, 'visit.payer', 'Visit', id, { old: { payerId: v.PayerId }, now: { payerId: payer?.id || null, tierId: payer?.tierId || null } });
    });
    res.json(await visitDetails(db, id));
  });

  // صرف المرتجع المستحق للمريض (نقدي مؤقت والموافقة جت بعدين)
  r.post('/:id/refund-due', async (req, res) => {
    need(req.user, 'cash.collect');
    const id = intId(req.params.id);
    const out = await db.tx(async (t) => {
      if (await mustOrder(t, req.user)) return { order: await refundDue(t, req.user, id, { makeOrder: true }) };
      return { receiptId: await refundDue(t, req.user, id) };
    });
    res.status(201).json({ ...out, ...(await visitDetails(db, id)) });
  });

  // الزيارات المفتوحة
  r.get('/open', async (req, res) => {
    need(req.user, 'visits.read');
    await sweepVisits(db);
    const rows = await db.query(
      `SELECT v.Id, v.VisitNo, v.Type, v.OpenedAt, p.Id AS PatientId, p.PatientNo, p.FullName, p.Phone, u.FullName AS OpenedByName,
              (SELECT SUM(PatientAmount) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active' AND PaidReceiptId IS NULL) AS Due,
              (SELECT SUM(Amount) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active') AS Total,
              (SELECT COUNT(*) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active') AS Items
         FROM Visits v JOIN Patients p ON p.Id = v.PatientId JOIN Users u ON u.Id = v.OpenedBy
        WHERE v.Status = 'open' ORDER BY v.OpenedAt DESC`);
    res.json({
      visits: rows.map((v) => ({
        id: v.Id, no: v.VisitNo, type: v.Type, openedAt: toIso(v.OpenedAt), openedBy: v.OpenedByName,
        patient: { id: v.PatientId, no: v.PatientNo, name: v.FullName, phone: v.Phone },
        due: pounds(cents(v.Due)), total: pounds(cents(v.Total)), items: Number(v.Items),
      })),
    });
  });

  r.get('/:id', async (req, res) => {
    need(req.user, 'visits.read');
    res.json(await visitDetails(db, intId(req.params.id)));
  });

  // إضافة خدمة (أو صنف دوا/مستلزم بيتصرف من المخزن)
  r.post('/:id/items', async (req, res) => {
    need(req.user, 'visits.write');
    const id = intId(req.params.id);
    const v = await loadVisit(db, id);
    if (v.Status !== 'open') throw conflict('الزيارة دي اتقفلت');
    if (req.body.stockItemId) {
      need(req.user, 'visit.stock');
      const b = req.body;
      const itemId = await db.tx(async (t) => {
        const it = await t.one('SELECT * FROM StockItems WHERE Id = ? AND Active = 1', [Number(b.stockItemId) || 0]);
        if (!it) throw bad('الصنف مش موجود أو موقوف');
        const u = unitsOf(it).find((x) => x.key === (b.unit || it.DefaultSaleUnit || 'base')) || unitsOf(it)[0];
        const qty = Number(latinDigits(b.qty ?? 1));
        if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad('العدد مش صحيح');
        const store = b.storeId ? await t.one('SELECT * FROM Stores WHERE Id = ? AND Active = 1', [Number(b.storeId) || 0])
          : (v.Type === 'clinic' && await clinicStoreOfVisit(t, id)) || await visitStore(t, v.Type);
        if (!store) throw bad('اختار المخزن اللي هيتصرف منه');
        if (!(v.Type === 'clinic' && await isClinicStore(t, store.Id))) needStore(req.user, store.Id); // مخازن العيادات مفتوحة للاستقبال في زيارات العيادات
        if (store.Holds !== 'all' && store.Holds !== it.Kind) throw bad(`«${store.Name}» مش بيشيل ${it.Kind === 'drug' ? 'أدوية' : 'مستلزمات'}`);
        const payer = v.PayerId ? await loadPayer(t, v.PayerId, v.TierId, { strict: false }) : null;
        const unit = stockPrice(payer, cents(it.Price) * u.factor);
        const amount = unit * qty;
        const dept = COVER_DEPT[it.Kind];
        const c = await cover(t, payer, { serviceId: null, dept, amount, patientId: v.PatientId, visitId: id });
        const iid = await t.insert('VisitItems', {
          VisitId: id, ServiceId: null, ServiceName: `${it.Name} (${u.name})`, Dept: dept, DoctorId: null, Qty: qty,
          UnitPrice: pounds(unit), Amount: pounds(amount), PayTiming: 'after', DoctorPct: 0,
          PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: c.status === 'needs' ? 'covered' : c.status, RefundDue: 0,
          Status: 'active', AddedAt: new Date(), AddedBy: req.user.id, StockItemId: it.Id, StoreId: store.Id, UnitFactor: u.factor, ReturnedQty: 0,
        });
        await consume(t, req.user, { storeId: store.Id, itemId: it.Id, qty: qty * u.factor, kind: moveKind(v), refType: 'visititem', refId: iid, negative: can(req.user, 'stock.negative'), itemName: it.Name, note: `زيارة ${v.VisitNo}` });
        return iid;
      });
      return res.status(201).json({ itemId, ...(await visitDetails(db, id)) });
    }
    const svc = await getService(db, intId(req.body.serviceId, 'الخدمة'));
    if (!svc || !svc.active || svc.price == null) throw bad('الخدمة دي مش متاحة');
    if (!VISIT_TYPES[svc.dept]) throw bad('الخدمة دي للمرضى المقيمين بس');
    const qty = Number(req.body.qty || 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw bad('العدد مش صحيح');
    let doctorId = req.body.doctorId ? intId(req.body.doctorId, 'الدكتور') : null;
    if (svc.hasDoctor && !doctorId) throw bad(`اختار الدكتور لـ «${svc.name}»`);
    if (doctorId) {
      const d = await db.one('SELECT Id FROM Doctors WHERE Id = ? AND Active = 1', [doctorId]);
      if (!d) throw bad('الدكتور ده مش موجود');
    }
    if (!svc.hasDoctor) doctorId = doctorId || null;
    const share = await resolveDoctorShare(db, doctorId, svc.id, svc.dept);
    const ap = req.body.approval || null;
    const itemId = await db.tx(async (t) => {
      const payer = v.PayerId ? await loadPayer(t, v.PayerId, v.TierId, { strict: false }) : null;
      const unit = await servicePrice(t, payer, svc.id, cents(svc.price));
      const amount = unit * qty;
      const c = await cover(t, payer, { serviceId: svc.id, dept: svc.dept, amount, patientId: v.PatientId, visitId: id });
      let status = c.status, patientAmount = c.patientAmount;
      if (c.status === 'needs') {
        if (!ap || !['pending', 'tempcash'].includes(ap.mode)) {
          throw conflict(`«${svc.name}» محتاجة موافقة من ${payer.name}`, { needsApproval: true, payerAmount: pounds(c.payerAmount), amount: pounds(amount) });
        }
        status = ap.mode;
        if (ap.mode === 'tempcash') patientAmount = amount;
        if (ap.mode === 'pending' && !str(ap.no, 60)) throw bad('اكتب رقم الموافقة، أو اختار «نقدي مؤقت»', { errors: { approvalNo: 'اكتب رقم الموافقة' } });
      }
      const now = new Date();
      const iid = await t.insert('VisitItems', {
        VisitId: id, ServiceId: svc.id, ServiceName: svc.name, Dept: svc.dept, DoctorId: doctorId, Qty: qty,
        UnitPrice: pounds(unit), Amount: pounds(amount), PayTiming: svc.payTiming, DoctorPct: share.pct, DoctorFixed: pounds(share.fixed),
        PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(patientAmount), CoverStatus: status, RefundDue: 0,
        Status: 'active', AddedAt: now, AddedBy: req.user.id,
      });
      let approvalId = null;
      if (status === 'pending' || status === 'tempcash') {
        approvalId = await t.insert('Approvals', {
          Scope: 'item', PayerId: payer.id, PatientId: v.PatientId, VisitItemId: iid, AdmissionItemId: null, AdmissionId: null,
          ApprovalNo: status === 'pending' ? str(ap.no, 60) : null, ApprovalDate: /^\d{4}-\d{2}-\d{2}$/.test(ap.date || '') ? ap.date : null,
          Status: status, Amount: pounds(c.payerAmount), Note: str(ap.note, 300), CreatedAt: now, CreatedBy: req.user.id,
        });
        await audit(t, req.user, 'approval.create', 'Approval', approvalId, { now: { status, no: ap.no, service: svc.name, amount: pounds(c.payerAmount) } });
      }
      return { iid, approvalId };
    });
    res.status(201).json({ itemId: itemId.iid, approvalId: itemId.approvalId, ...(await visitDetails(db, id)) });
  });

  // تعديل العدد (للبند اللي لسه ما اتدفعش)
  r.put('/:id/items/:itemId', async (req, res) => {
    need(req.user, 'visits.write');
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    const it = await db.one('SELECT * FROM VisitItems WHERE Id = ? AND VisitId = ?', [itemId, id]);
    if (!it || it.Status !== 'active') throw notFound('البند مش موجود');
    if (it.PaidReceiptId != null) throw conflict('البند ده اتدفع، ولو فيه غلط يتلغي بإيصال مرتجع');
    const qty = Number(req.body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > (it.StockItemId ? 999 : 50)) throw bad('العدد مش صحيح');
    if (['pending', 'tempcash'].includes(it.CoverStatus)) throw conflict('البند ده عليه موافقة. شيله وضيفه تاني بالعدد الصح');
    if (it.PendingOrderId != null) throw conflict('البند ده في إذن دفع مستني الخزينة. الغي الإذن الأول');
    await db.tx(async (t) => {
      const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [id]);
      const payer = v.PayerId ? await loadPayer(t, v.PayerId, v.TierId, { strict: false }) : null;
      await t.run('UPDATE VisitItems SET PayerAmount = 0 WHERE Id = ?', [itemId]);
      const amount = cents(it.UnitPrice) * qty;
      if (it.StoreId && qty !== it.Qty) {
        const f = Number(it.UnitFactor || 1);
        if (qty > it.Qty) await consume(t, req.user, { storeId: it.StoreId, itemId: it.StockItemId, qty: (qty - it.Qty) * f, kind: moveKind(v), refType: 'visititem', refId: itemId, negative: can(req.user, 'stock.negative'), itemName: it.ServiceName });
        else await giveBack(t, req.user, { refType: 'visititem', refId: itemId, qty: (it.Qty - qty) * f, kind: moveKind(v, true), note: 'تعديل العدد' });
      }
      const c = await cover(t, payer, { serviceId: it.ServiceId, dept: it.Dept, amount, patientId: v.PatientId, visitId: id });
      await t.run('UPDATE VisitItems SET Qty = ?, Amount = ?, PayerAmount = ?, PatientAmount = ?, CoverStatus = ? WHERE Id = ?',
        [qty, pounds(amount), pounds(c.payerAmount), pounds(c.patientAmount), c.status === 'needs' ? 'covered' : c.status, itemId]);
    });
    res.json(await visitDetails(db, id));
  });

  // شيل بند لسه ما اتدفعش
  r.delete('/:id/items/:itemId', async (req, res) => {
    need(req.user, 'visits.write');
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    const it = await db.one('SELECT * FROM VisitItems WHERE Id = ? AND VisitId = ?', [itemId, id]);
    if (!it || it.Status !== 'active') throw notFound('البند مش موجود');
    if (it.PaidReceiptId != null) throw conflict('البند ده اتدفع، ولو فيه غلط يتلغي بإيصال مرتجع');
    if (it.PendingOrderId != null) throw conflict('البند ده في إذن دفع مستني الخزينة. الغي الإذن الأول');
    await db.tx(async (t) => {
      await t.run("UPDATE VisitItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?",
        [new Date(), req.user.id, str(req.body?.reason, 300) || 'اتشال قبل الدفع', itemId]);
      await t.run("UPDATE Approvals SET Status = 'cancelled' WHERE VisitItemId = ? AND Status IN ('pending','tempcash')", [itemId]);
      if (it.StoreId) {
        const v = await t.one('SELECT Type FROM Visits WHERE Id = ?', [id]);
        await giveBack(t, req.user, { refType: 'visititem', refId: itemId, kind: moveKind(v, true), note: 'اتشال قبل الدفع' });
      }
      await audit(t, req.user, 'item.remove', 'VisitItem', itemId, { old: { name: it.ServiceName, amount: Number(it.Amount) } });
    });
    res.json(await visitDetails(db, id));
  });

  // مرتجع صنف اتدفع (كله أو جزء منه): فلوس ترجع للمريض والصنف يرجع للمخزن
  r.post('/:id/items/:itemId/return', async (req, res) => {
    need(req.user, 'stock.return');
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب المرتجع', { errors: { reason: 'اكتب السبب' } });
    const out = await db.tx(async (t) => {
      const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [id]);
      const it = await t.one('SELECT * FROM VisitItems WHERE Id = ? AND VisitId = ?', [itemId, id]);
      if (!v || !it || it.Status !== 'active') throw notFound('البند مش موجود');
      if (!it.StockItemId) throw bad('المرتجع للأدوية والمستلزمات بس. الخدمة تتلغي بإلغاء الإيصال');
      if (it.PaidReceiptId == null) throw conflict('البند لسه ما اتدفعش. شيله من الزيارة عادي');
      if (cents(it.PayerAmount) > 0) throw conflict('البند ده على التعاقد. المرتجع بيتعمل بإلغاء الإيصال');
      if (await mustOrder(t, req.user)) throw conflict('الخزينة شغالة: المرتجع بيتعمل من الصيدلية أو المشرف');
      const left = it.Qty - Number(it.ReturnedQty || 0);
      const qty = Number(latinDigits(req.body?.qty ?? left));
      if (!Number.isInteger(qty) || qty < 1 || qty > left) throw bad(`العدد لازم من 1 لـ ${left}`, { errors: { qty: `من 1 لـ ${left}` } });
      const line = await t.one('SELECT * FROM ReceiptLines WHERE ReceiptId = ? AND VisitItemId = ?', [it.PaidReceiptId, itemId]);
      const paidNet = cents(it.PatientAmount ?? it.Amount) - cents(line?.DiscountShare || 0);
      const back = Math.round((paidNet * qty) / it.Qty);
      const shiftId = await currentShift(t, req.user);
      const no = await t.nextNumber('receipt');
      const now = new Date();
      const rid = await t.insert('Receipts', {
        ReceiptNo: no, Kind: 'refund', VisitId: id, AdmissionId: null, PatientId: v.PatientId, ShiftId: shiftId,
        Gross: pounds(-back), Discount: 0, Net: pounds(-back), Cash: pounds(-back), Card: 0, Credit: 0,
        Reason: 'مرتجع: ' + reason, Note: `مرتجع ${qty} من ${it.ServiceName}`, PrintCount: 0, CreatedAt: now, CreatedBy: req.user.id,
      });
      await t.insert('ReceiptLines', { ReceiptId: rid, VisitItemId: itemId, Description: 'مرتجع: ' + it.ServiceName, Qty: qty, UnitPrice: it.UnitPrice, Amount: pounds(-back), DiscountShare: 0, PayerAmount: 0 });
      await t.run('UPDATE VisitItems SET ReturnedQty = ReturnedQty + ? WHERE Id = ?', [qty, itemId]);
      await giveBack(t, req.user, { refType: 'visititem', refId: itemId, qty: qty * Number(it.UnitFactor || 1), kind: moveKind(v, true), note: reason });
      await audit(t, req.user, 'item.return', 'VisitItem', itemId, { now: { name: it.ServiceName, qty, amount: pounds(back), refundNo: no }, note: reason });
      return rid;
    });
    res.status(201).json({ refundId: out, ...(await visitDetails(db, id)) });
  });

  // الدفع وإصدار الإيصال (أو إذن دفع للخزينة لو فيه خزينة شغالة)
  r.post('/:id/pay', async (req, res) => {
    need(req.user, 'cash.collect');
    const id = intId(req.params.id);
    const out = await db.tx(async (t) => {
      if (await mustOrder(t, req.user)) return { order: await payVisit(t, req.user, id, req.body || {}, { makeOrder: true }) };
      return { receiptId: await payVisit(t, req.user, id, req.body || {}) };
    });
    const details = await visitDetails(db, id);
    if (out.order) return res.status(201).json({ order: out.order, ...details });
    res.status(201).json({ receiptId: out.receiptId, receipt: details.receipts.find((x) => x.id === out.receiptId), ...details });
  });

  // قفل الزيارة (لما الحساب يخلص)
  r.post('/:id/close', async (req, res) => {
    need(req.user, 'visits.write');
    const id = intId(req.params.id);
    const d = await visitDetails(db, id);
    if (d.visit.status !== 'open') return res.json(d);
    if (d.totals.due > 0) throw conflict(`لسه فيه ${d.totals.due} ${R.money.unitWord} ما اتدفعوش`);
    await db.tx(async (t) => {
      await t.run("UPDATE Visits SET Status = 'closed', ClosedAt = ?, ClosedBy = ? WHERE Id = ?", [new Date(), req.user.id, id]);
      await audit(t, req.user, 'visit.close', 'Visit', id);
    });
    res.json(await visitDetails(db, id));
  });

  return r;
}

// ===================== الإيصالات =====================
export function receiptsRouter(db) {
  const r = router();

  r.get('/', async (req, res) => {
    need(req.user, 'receipts.read');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : undefined;
    const { start, end } = cairoDayRange(date);
    const mine = req.query.mine === '1';
    const rows = await db.query(
      `SELECT r.*, u.FullName AS CreatedByName, p.FullName AS PatientName, p.PatientNo, v.VisitNo, v.Type AS VisitType, s.ClosedAt AS ShiftClosedAt,
              a.AdmissionNo, a.Status AS AdmStatus
         FROM Receipts r JOIN Users u ON u.Id = r.CreatedBy JOIN Patients p ON p.Id = r.PatientId
         LEFT JOIN Visits v ON v.Id = r.VisitId LEFT JOIN Admissions a ON a.Id = r.AdmissionId JOIN Shifts s ON s.Id = r.ShiftId
        WHERE r.CreatedAt >= ? AND r.CreatedAt < ? ${mine ? 'AND r.CreatedBy = ?' : ''}
        ORDER BY r.Id DESC`, mine ? [start, end, req.user.id] : [start, end]);
    const list = rows.map((x) => ({
      ...receiptDto(x), patient: { name: x.PatientName, no: x.PatientNo }, visitId: x.VisitId, visitNo: x.VisitNo, visitType: x.VisitType || 'admission',
      admissionId: x.AdmissionId, admissionNo: x.AdmissionNo, note: x.Note,
      canCancel: ['payment', 'deposit'].includes(x.Kind) && x.ReversedByReceiptId == null && (!x.AdmissionId || x.AdmStatus === 'active') && canCancel(req.user, x),
    }));
    const sum = (k) => pounds(rows.reduce((s, x) => s + cents(x[k]), 0));
    res.json({ receipts: list, totals: { net: sum('Net'), cash: sum('Cash'), card: sum('Card'), credit: sum('Credit'), discount: sum('Discount'), count: rows.filter((x) => x.Kind !== 'refund').length } });
  });

  // إلغاء إيصال = إيصال عكسي بسبب، والبنود تتلغي، والنسب تتعكس
  r.post('/:id/cancel', async (req, res) => {
    need(req.user, 'receipts.read');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    const out = await db.tx(async (t) => {
      const o = await t.one('SELECT r.*, s.ClosedAt AS ShiftClosedAt FROM Receipts r JOIN Shifts s ON s.Id = r.ShiftId WHERE r.Id = ?', [id]);
      if (!o) throw notFound('الإيصال مش موجود');
      if (o.Kind === 'refund') throw conflict('ده إيصال إلغاء أصلًا');
      if (o.Kind === 'final' || o.Kind === 'return') throw conflict('ده إيصال خروج. لإلغائه استخدم «إلغاء الخروج» من حساب المريض (المدير)');
      if (o.AdmissionId) {
        const a = await t.one('SELECT Status FROM Admissions WHERE Id = ?', [o.AdmissionId]);
        if (a.Status !== 'active') throw conflict('المريض خرج. إلغاء الخروج الأول من حساب المريض (المدير)');
      }
      if (o.ReversedByReceiptId != null) throw conflict('الإيصال ده اتلغى قبل كده');
      const ret = await t.one('SELECT COUNT(*) AS N FROM ReceiptLines l JOIN VisitItems i ON i.Id = l.VisitItemId WHERE l.ReceiptId = ? AND i.ReturnedQty > 0', [o.Id]);
      if (Number(ret?.N)) throw conflict('اتعمل مرتجع من الإيصال ده. كمّل باقي المرتجع من البنود نفسها');
      if (!canCancel(req.user, o)) throw forbidden('إلغاء الإيصال ده محتاج المشرف أو المدير');
      const shiftId = await currentShift(t, req.user);
      const no = await t.nextNumber('receipt');
      const now = new Date();
      const neg = (v) => -Number(v);
      const rid = await t.insert('Receipts', {
        ReceiptNo: no, Kind: 'refund', VisitId: o.VisitId, AdmissionId: o.AdmissionId, PatientId: o.PatientId, ShiftId: shiftId,
        Gross: neg(o.Gross), Discount: neg(o.Discount), Net: neg(o.Net), Cash: neg(o.Cash), Card: neg(o.Card), Credit: neg(o.Credit),
        ReversesReceiptId: o.Id, Reason: reason, PrintCount: 0, CreatedAt: now, CreatedBy: req.user.id,
      });
      await t.run('UPDATE Receipts SET ReversedByReceiptId = ? WHERE Id = ? AND ReversedByReceiptId IS NULL', [rid, o.Id]);
      const lines = await t.query('SELECT * FROM ReceiptLines WHERE ReceiptId = ? ORDER BY Id', [o.Id]);
      for (const l of lines) {
        await t.insert('ReceiptLines', {
          ReceiptId: rid, VisitItemId: l.VisitItemId, Description: l.Description, Qty: l.Qty,
          UnitPrice: l.UnitPrice, Amount: neg(l.Amount), DiscountShare: neg(l.DiscountShare), PayerAmount: neg(l.PayerAmount || 0),
        });
        await t.run("UPDATE Approvals SET Status = 'cancelled' WHERE VisitItemId = ? AND Status IN ('pending','tempcash')", [l.VisitItemId]);
        await t.run('UPDATE VisitItems SET RefundDue = 0 WHERE Id = ?', [l.VisitItemId]);
        await t.run("UPDATE VisitItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?",
          [now, req.user.id, 'إلغاء إيصال ' + o.ReceiptNo + ': ' + reason, l.VisitItemId]);
        const vi = await t.one('SELECT i.StoreId, i.Qty, i.ReturnedQty, i.UnitFactor, v.Type FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId WHERE i.Id = ?', [l.VisitItemId]);
        if (vi?.StoreId) {
          const left = (vi.Qty - Number(vi.ReturnedQty || 0)) * Number(vi.UnitFactor || 1);
          if (left > 0) await giveBack(t, req.user, { refType: 'visititem', refId: l.VisitItemId, qty: left, kind: moveKind(vi, true), note: 'إلغاء إيصال ' + o.ReceiptNo });
        }
      }
      const earn = await t.query('SELECT * FROM DoctorEarnings WHERE ReceiptId = ?', [o.Id]);
      for (const e of earn) {
        await t.insert('DoctorEarnings', {
          VisitItemId: e.VisitItemId, AdmissionItemId: e.AdmissionItemId, DoctorId: e.DoctorId, ReceiptId: rid, BaseAmount: neg(e.BaseAmount), Pct: e.Pct,
          Amount: neg(e.Amount), PayerPart: neg(e.PayerPart || 0), CreatedAt: now,
        });
      }
      await ledgerReverse(t, req.user, 'ReceiptId = ?', [o.Id]);
      await audit(t, req.user, 'receipt.cancel', 'Receipt', o.Id, { now: { refundNo: no }, note: reason });
      return { rid, visitId: o.VisitId, admissionId: o.AdmissionId };
    });
    if (out.admissionId) {
      const { admissionDetails } = await import('./admissions.js');
      return res.status(201).json({ refundId: out.rid, ...(await admissionDetails(db, out.admissionId)) });
    }
    const details = await visitDetails(db, out.visitId);
    res.status(201).json({ refundId: out.rid, ...details });
  });

  return r;
}

function canCancel(user, receipt) {
  if (can(user, 'receipts.cancelAny')) return true;
  // موظف الاستقبال: إيصالاته هو بس، وورديته لسه مفتوحة
  return can(user, 'receipts.cancelOwnOpenShift') && receipt.CreatedBy === user.id && receipt.ShiftClosedAt == null;
}

