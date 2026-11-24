// الدخول والإقامة: لوحة الأسرّة، الدخول وتأمينه، الليالي، الخدمات، التحويل، الدفعات، الخروج
import { LIVE, admTypeForKind, admRoomKind } from '../lib/lookups.js';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import {
  bad, conflict, notFound, forbidden, intId, str, cents, pounds, parseMoney,
  cairoDate, cairoDayRange, cairoMinutes, hhmmToMin,
} from '../lib/util.js';
import { toIso, toDateStr, toBool } from '../db/index.js';
import { patientDto } from './patients.js';
import { getService, resolveDoctorShare, DEPTS } from './catalog.js';
import { currentShift, managerId, pickPayer } from './visits.js';
import { mustOrder, createOrder } from '../lib/cashier.js';
import { ticketOn, CATS } from '../lib/tickets.js';
import { floorAt, floorServicePrice, floorClassMap } from '../lib/floor-prices.js';
import { giveBack } from '../lib/stock.js';
import { loadPayer, servicePrice, nightPrice, cover, ledgerCharge, ledgerReverse, PAYER_FINAL, PAYER_LIVE } from '../lib/coverage.js';
import { R as RT } from '../lib/runtime.js'; // R محلية في دوال الخروج
import { nameParts } from '../../shared/text.js';

/** تعاقد الدخول (null لو نقدي أو موافقة الدخول اترفضت) */
export async function admissionPayer(t, a) {
  if (!a.PayerId || a.PayerStatus === 'rejected') return null;
  return loadPayer(t, a.PayerId, a.TierId, { strict: false });
}

export const ADM_TYPES = LIVE.ADM_TYPES;
export const KIND_FOR_TYPE = LIVE.KIND_FOR_TYPE;
export const KIND_NAMES = LIVE.KIND_NAMES;
const PKG_NOTE = 'ضمن الباكدج';
export const EARLY_OUT = 'الخروج قبل ميعاد حساب اليوم';

export async function getSetting(db, key, def) {
  const r = await db.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [key]);
  return r?.Value ?? def;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * تسجيل ليالي الإقامة لوحدها: ليلة لكل يوم من يوم الدخول لحد النهارده (أو يوم الخروج).
 * يوم الخروج بيتحسب لو الخروج بعد «ميعاد حساب اليوم» (الإعدادات)، وأقل حاجة ليلة واحدة.
 * سعر اليوم = درجة السرير اللي المريض فيه آخر اليوم. وأول ليالي الباكدج بصفر.
 * at: وقت الخروج (لحساب الخروج قبل ما يتنفذ)
 */
export async function postNights(t, admissionId, { at } = {}) {
  const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [admissionId]);
  if (!a) return;
  // التذكرة المقفولة: الحساب متجمد على وقت القفل
  const closed = a.Status === 'active' && a.BillStatus === 'closed' && a.ClosedAt;
  const discharging = a.Status === 'discharged' || !!at || !!closed;
  const end = a.Status === 'discharged' ? new Date(a.DischargedAt) : closed ? new Date(a.ClosedAt) : (at || new Date());
  const startDate = cairoDate(new Date(a.AdmittedAt));
  let endDate = cairoDate(end);
  if (discharging && endDate > startDate) {
    const co = hhmmToMin(await getSetting(t, 'checkoutTime', '12:00')) ?? 720;
    if (cairoMinutes(end) < co) endDate = addDays(endDate, -1);
  }
  const moves = await t.query('SELECT * FROM BedMoves WHERE AdmissionId = ? ORDER BY FromAt, Id', [admissionId]);
  if (!moves.length) return;
  const classes = new Map((await t.query('SELECT Id, Name, NightPrice FROM RoomClasses')).map((c) => [c.Id, c]));
  const bedFloor = new Map((await t.query('SELECT b.Id, r.FloorId FROM Beds b JOIN Rooms r ON r.Id = b.RoomId')).map((x) => [x.Id, x.FloorId]));
  const fcp = await floorClassMap(t);
  const items = await t.query("SELECT * FROM AdmissionItems WHERE AdmissionId = ? AND Kind = 'night'", [admissionId]);
  const pkg = await t.one("SELECT SUM(IncludedNights * Qty) AS N FROM AdmissionItems WHERE AdmissionId = ? AND Kind = 'service' AND Status = 'active' AND IncludedNights IS NOT NULL", [admissionId]);
  const pkgNights = Number(pkg?.N || 0);
  const payer = await admissionPayer(t, a);
  const now = new Date();
  let idx = 0;
  for (let d = startDate; d <= endDate; d = addDays(d, 1), idx++) {
    const dayEnd = new Date(cairoDayRange(d).end.getTime() - 1000);
    const ref = dayEnd < end ? dayEnd : end;
    let mv = moves[0];
    for (const m of moves) if (new Date(m.FromAt) <= ref) mv = m;
    const cls = classes.get(mv.ClassId);
    const covered = idx < pkgNights;
    const floorId = bedFloor.get(mv.BedId) ?? null;
    const base = fcp.get(`${floorId}|${mv.ClassId}`) ?? cents(cls.NightPrice);
    const price = covered ? 0 : await nightPrice(t, payer, mv.ClassId, base);
    const name = `إقامة ليلة · ${cls.Name}`;
    const ex = items.find((i) => toDateStr(i.ChargeDate) === d);
    if (!ex) {
      const c = await cover(t, payer, { serviceId: null, dept: 'ward', amount: price, patientId: a.PatientId, admissionId });
      await t.insert('AdmissionItems', {
        AdmissionId: admissionId, Kind: 'night', ServiceId: null, Name: name, Dept: 'ward', DoctorId: null, Qty: 1,
        UnitPrice: pounds(price), Amount: pounds(price), DoctorPct: 0, ChargeDate: d, ClassId: mv.ClassId,
        PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: c.status === 'needs' ? 'covered' : c.status,
        Note: covered ? PKG_NOTE : null, Status: 'active', AddedAt: now, AddedBy: a.AdmittedBy, Cat: 'night', FloorId: floorId,
      });
    } else if (ex.Status === 'active') {
      const exCovered = ex.Note === PKG_NOTE;
      if (ex.ClassId !== mv.ClassId || (ex.FloorId != null && ex.FloorId !== floorId) || exCovered !== covered) {
        await t.run('UPDATE AdmissionItems SET PayerAmount = 0 WHERE Id = ?', [ex.Id]);
        const c = ex.CoverStatus === 'rejected' ? { pct: 0, payerAmount: 0, patientAmount: price, status: 'rejected' }
          : await cover(t, payer, { serviceId: null, dept: 'ward', amount: price, patientId: a.PatientId, admissionId });
        await t.run('UPDATE AdmissionItems SET ClassId = ?, Name = ?, UnitPrice = ?, Amount = ?, Note = ?, PayerPct = ?, PayerAmount = ?, PatientAmount = ?, CoverStatus = ?, FloorId = ? WHERE Id = ?',
          [mv.ClassId, name, pounds(price), pounds(price), covered ? PKG_NOTE : null, c.pct, pounds(c.payerAmount), pounds(c.patientAmount), c.status === 'needs' ? 'covered' : c.status, floorId, ex.Id]);
      }
    }
  }
  if (discharging) {
    for (const i of items) {
      if (i.Status === 'active' && toDateStr(i.ChargeDate) > endDate) {
        await t.run("UPDATE AdmissionItems SET Status = 'voided', VoidedAt = ?, VoidReason = ? WHERE Id = ?", [now, EARLY_OUT, i.Id]);
      }
    }
  }
}

export async function postAllNights(db) {
  const rows = await db.query("SELECT Id FROM Admissions WHERE Status = 'active'");
  for (const r of rows) await db.tx((t) => postNights(t, r.Id));
  return rows.length;
}

const bedSql = `SELECT b.Id, b.Label, b.Status, b.StatusNote, b.StatusAt, b.Active, r.Id AS RoomId, r.Number AS RoomNo, r.Notes AS RoomNotes,
       c.Id AS ClassId, c.Name AS ClassName, c.Kind, c.NightPrice, c.Deposit, f.Id AS FloorId, f.Number AS FloorNo, f.Name AS FloorName
  FROM Beds b JOIN Rooms r ON r.Id = b.RoomId JOIN RoomClasses c ON c.Id = r.ClassId JOIN Floors f ON f.Id = r.FloorId`;
const bedDto = (b) => ({
  id: b.Id, label: b.Label, status: b.Status, note: b.StatusNote, statusAt: toIso(b.StatusAt),
  room: { id: b.RoomId, no: b.RoomNo }, floor: { id: b.FloorId, no: b.FloorNo, name: b.FloorName },
  cls: { id: b.ClassId, name: b.ClassName, kind: b.Kind, nightPrice: b.NightPrice == null ? null : pounds(cents(b.NightPrice)), deposit: b.Deposit == null ? null : pounds(cents(b.Deposit)) },
});

const receiptKinds = { deposit: 'تأمين دخول', payment: 'دفعة تحت الحساب', final: 'سداد نهائي', return: 'مرتجع للمريض', refund: 'إلغاء إيصال' };

export async function admissionDetails(db, id, { post = true } = {}) {
  if (post) {
    const st = await db.one('SELECT Status FROM Admissions WHERE Id = ?', [id]);
    if (st?.Status === 'active') await db.tx((t) => postNights(t, id));
  }
  const a = await db.one(
    `SELECT a.*, d.Name AS DoctorName, u.FullName AS AdmittedByName, u2.FullName AS DischargedByName, py.Name AS PayerName, pt.Name AS TierName, u3.FullName AS ClosedByName
       FROM Admissions a LEFT JOIN Doctors d ON d.Id = a.DoctorId JOIN Users u ON u.Id = a.AdmittedBy LEFT JOIN Users u3 ON u3.Id = a.ClosedBy
       LEFT JOIN Users u2 ON u2.Id = a.DischargedBy LEFT JOIN Payers py ON py.Id = a.PayerId LEFT JOIN PayerTiers pt ON pt.Id = a.TierId WHERE a.Id = ?`, [id]);
  if (!a) throw notFound('الدخول ده مش موجود');
  const patient = patientDto(await db.one('SELECT * FROM Patients WHERE Id = ?', [a.PatientId]));
  const bed = bedDto(await db.one(bedSql + ' WHERE b.Id = ?', [a.BedId]));
  const moves = await db.query(
    `SELECT m.*, b.Label, r.Number AS RoomNo, c.Name AS ClassName, c.Kind, u.FullName AS ByName FROM BedMoves m
       JOIN Beds b ON b.Id = m.BedId JOIN Rooms r ON r.Id = b.RoomId JOIN RoomClasses c ON c.Id = m.ClassId JOIN Users u ON u.Id = m.MovedBy
      WHERE m.AdmissionId = ? ORDER BY m.FromAt, m.Id`, [id]);
  const items = await db.query(
    `SELECT i.*, d.Name AS DoctorName, u.FullName AS AddedByName, ap.Id AS ApprovalId, ap.Status AS ApprovalStatus, ap.ApprovalNo FROM AdmissionItems i
       LEFT JOIN Doctors d ON d.Id = i.DoctorId JOIN Users u ON u.Id = i.AddedBy
       LEFT JOIN Approvals ap ON ap.AdmissionItemId = i.Id AND ap.Status <> 'cancelled'
      WHERE i.AdmissionId = ? ORDER BY CASE WHEN i.Kind = 'night' THEN 0 ELSE 1 END, i.ChargeDate, i.Id`, [id]);
  const receipts = await db.query(
    `SELECT r.*, u.FullName AS CreatedByName FROM Receipts r JOIN Users u ON u.Id = r.CreatedBy WHERE r.AdmissionId = ? ORDER BY r.Id`, [id]);
  let nights = 0, services = 0, nightCount = 0, payerTotal = 0, patientTotal = 0;
  const byCat = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]));
  const list = items.map((i) => {
    const amt = cents(i.Amount);
    const cat = i.Cat || (i.Kind === 'night' ? 'night' : 'service');
    if (i.Status === 'active') {
      byCat[cat] = (byCat[cat] || 0) + amt;
      if (i.Kind === 'night') { nights += amt; nightCount++; } else services += amt;
      patientTotal += cents(i.PatientAmount ?? i.Amount);
      if (PAYER_LIVE.includes(i.CoverStatus)) payerTotal += cents(i.PayerAmount);
    }
    return {
      id: i.Id, kind: i.Kind, name: i.Name, dept: i.Dept, serviceId: i.ServiceId, doctorId: i.DoctorId, doctorName: i.DoctorName,
      qty: i.Qty, unitPrice: pounds(cents(i.UnitPrice)), amount: pounds(amt), date: toDateStr(i.ChargeDate), classId: i.ClassId,
      includedNights: i.IncludedNights, note: i.Note, status: i.Status, voidReason: i.VoidReason, addedAt: toIso(i.AddedAt), addedBy: i.AddedByName, addedById: i.AddedBy,
      fromVisit: i.SourceVisitItemId != null, cat, stockItemId: i.StockItemId, ticketId: i.TicketId, unitFactor: i.UnitFactor == null ? null : Number(i.UnitFactor), storeId: i.StoreId,
      payerPct: Number(i.PayerPct || 0), payerAmount: pounds(cents(i.PayerAmount)), patientAmount: pounds(cents(i.PatientAmount ?? i.Amount)), cover: i.CoverStatus || 'none',
      approval: i.ApprovalId ? { id: i.ApprovalId, status: i.ApprovalStatus, no: i.ApprovalNo } : null,
    };
  });
  let paid = 0, discount = 0, credit = 0;
  for (const r of receipts) { paid += cents(r.Net); discount += cents(r.Discount); credit += cents(r.Credit); }
  const total = nights + services;
  const admittedAt = new Date(a.AdmittedAt);
  const admAp = a.PayerId ? await db.one(db.top("SELECT Id, Status, ApprovalNo, ReviewNote FROM Approvals WHERE AdmissionId = ? AND Scope = 'admission' ORDER BY Id DESC", 1), [id]) : null;
  return {
    ticketMode: await ticketOn(db),
    admission: {
      id: a.Id, no: a.AdmissionNo, type: a.Type, typeName: ADM_TYPES[a.Type], status: a.Status, doctorId: a.DoctorId, doctorName: a.DoctorName,
      expectedProcedure: a.ExpectedProcedure, depositRequired: pounds(cents(a.DepositRequired)), notes: a.Notes, fromVisitId: a.FromVisitId,
      admittedAt: toIso(a.AdmittedAt), admittedBy: a.AdmittedByName, dischargedAt: toIso(a.DischargedAt), dischargedBy: a.DischargedByName,
      dischargeNote: a.DischargeNote, nights: nightCount, diagnosis: a.Diagnosis || null, ...dxState(a),
      bill: { status: a.BillStatus === 'closed' ? 'closed' : 'open', closedAt: toIso(a.ClosedAt), closedBy: a.ClosedByName || null, reopened: Number(a.ReopenCount || 0) },
      payer: a.PayerId ? { id: a.PayerId, name: a.PayerName, tierId: a.TierId, tierName: a.TierName, cardNo: a.CardNo, status: a.PayerStatus || 'ok',
        approval: admAp ? { id: admAp.Id, status: admAp.Status, no: admAp.ApprovalNo, note: admAp.ReviewNote } : null } : null,
      hours: Math.round(((a.DischargedAt ? new Date(a.DischargedAt) : new Date()) - admittedAt) / 3600e3),
    },
    patient, bed,
    moves: moves.map((m) => ({ bed: m.Label, room: m.RoomNo, className: m.ClassName, kind: m.Kind, from: toIso(m.FromAt), to: toIso(m.ToAt), by: m.ByName, reason: m.Reason })),
    items: list,
    receipts: receipts.map((r) => ({
      id: r.Id, no: r.ReceiptNo, kind: r.Kind, kindName: receiptKinds[r.Kind], net: pounds(cents(r.Net)), gross: pounds(cents(r.Gross)),
      discount: pounds(cents(r.Discount)), cash: pounds(cents(r.Cash)), card: pounds(cents(r.Card)), credit: pounds(cents(r.Credit)),
      createdAt: toIso(r.CreatedAt), createdBy: r.CreatedByName, reversed: r.ReversedByReceiptId != null, reason: r.Reason, note: r.Note, manualNo: r.ManualNo || null,
    })),
    orders: (await db.query("SELECT o.*, u.FullName AS ByName FROM PayOrders o JOIN Users u ON u.Id = o.CreatedBy WHERE o.AdmissionId = ? AND o.Status = 'pending' ORDER BY o.Id", [id]))
      .map((o) => ({ id: o.Id, no: o.OrderNo, kind: o.Kind, amount: Number(o.Amount), credit: Number(o.Credit), description: o.Description, createdAt: toIso(o.CreatedAt), createdBy: o.ByName, createdById: o.CreatedBy })),
    totals: {
      nights: pounds(nights), services: pounds(services), total: pounds(total), byCat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, pounds(v)])), payer: pounds(payerTotal), patient: pounds(patientTotal),
      paid: pounds(paid), discount: pounds(discount), credit: pounds(credit), balance: pounds(patientTotal - discount - paid), deposit: pounds(receipts.filter((r) => r.Kind === 'deposit' && r.ReversedByReceiptId == null).reduce((s, r) => s + cents(r.Net), 0)),
    },
  };
}

class Rollback extends Error { constructor(v) { super('rollback'); this.value = v; } }

/** حالة التشخيص المبدئي: المهلة من وقت الدخول، ومتأخر لو عدّت */
export function dxState(a) {
  const prov = !!(a.Diagnosis && toBool(a.DiagnosisProvisional));
  if (!prov) return { diagnosisProvisional: false, diagnosisDue: null, diagnosisOverdue: false };
  const due = new Date(new Date(a.AdmittedAt).getTime() + RT.dx.hours * 3600e3);
  return { diagnosisProvisional: true, diagnosisDue: due.toISOString(), diagnosisOverdue: a.Status === 'active' && Date.now() > due.getTime() };
}
export async function loadActive(t, id) {
  const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [id]);
  if (!a) throw notFound('الدخول ده مش موجود');
  if (a.Status !== 'active') throw conflict('المريض ده خرج بالفعل');
  return a;
}
/** المريض لسه داخل والتذكرة مفتوحة (للإضافة والشيل والتحويل) */
export async function loadOpen(t, id) {
  const a = await loadActive(t, id);
  if (a.BillStatus === 'closed') throw conflict('التذكرة اتقفلت. مشرف الحسابات أو المدير يفتحها الأول');
  return a;
}
/** صلاحية إضافة/شيل بنود الإقامة: الحسابات لو نظام التذكرة شغال */
export async function needBill(db, user) {
  if (await ticketOn(db)) {
    if (!can(user, 'adm.bill')) throw forbidden('بنود الإقامة بتتكتب من الحسابات (التذكرة)');
  } else need(user, 'admissions.write');
}
async function freeBed(t, bedId) {
  const b = await t.one(bedSql + ' WHERE b.Id = ?', [bedId]);
  if (!b || !toBool(b.Active)) throw bad('السرير ده مش موجود أو موقوف');
  const occ = await t.one("SELECT Id FROM Admissions WHERE BedId = ? AND Status = 'active'", [bedId]);
  if (occ || b.Status === 'occupied') throw conflict('السرير ده مشغول. اختار سرير تاني');
  if (b.Status === 'cleaning') throw conflict('السرير ده تحت التنظيف. علّمه «فاضي» الأول لما يخلص');
  const fp = await t.one('SELECT NightPrice FROM FloorClassPrices WHERE FloorId = ? AND ClassId = ?', [b.FloorId, b.ClassId]);
  if (b.NightPrice == null && !fp) throw bad(`سعر الليلة لدرجة «${b.ClassName}» لسه ما اتحددش. المدير يحدده من الإعدادات ← الغرف والأسرّة`);
  return b;
}
async function setBed(t, user, bedId, status, note = null) {
  await t.run('UPDATE Beds SET Status = ?, StatusNote = ?, StatusAt = ?, StatusBy = ? WHERE Id = ?', [status, note, new Date(), user.id, bedId]);
}
function payParts(b) {
  return { cash: parseMoney(b.cash, 'النقدي'), card: parseMoney(b.card, 'الفيزا'), credit: parseMoney(b.credit, 'الآجل') };
}

/** دفعة على حساب الدخول (أو إذن دفع بيها). ctx.amount = المبلغ لما الخزينة تنفذ إذن (الدفع بيتقسم نقدي/فيزا) */
export async function payAdmission(t, user, id, b = {}, ctx = {}) {
  const { cash, card } = ctx.makeOrder ? { cash: parseMoney(b.amount ?? (Number(b.cash || 0) + Number(b.card || 0)), 'المبلغ'), card: 0 } : payParts({ cash: b.cash, card: b.card });
  const total = cash + card;
  if (total <= 0) throw bad('اكتب المبلغ');
  if (ctx.orderId && total !== ctx.amount) throw bad(`المبلغ لازم يساوي الإذن (${pounds(ctx.amount)} ${RT.money.unitWord})`);
  const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [id]);
  if (!a) throw notFound('الدخول ده مش موجود');
  if (a.Status !== 'active') {
    // بعد الخروج: تحصيل المتبقي بس (آجل أو موافقة اترفضت)
    const d = await admissionDetails(t, id, { post: false });
    if (total > cents(d.totals.balance)) throw bad(d.totals.balance > 0 ? `المتبقي على المريض ${d.totals.balance} ${RT.money.unitWord} بس` : 'مفيش مبلغ متبقي على المريض');
  }
  if (ctx.makeOrder) {
    return createOrder(t, user, {
      kind: 'adm_pay', admissionId: id, patientId: a.PatientId, amount: total, credit: 0,
      description: str(b.note, 300) || (a.Status === 'active' ? `دفعة تحت الحساب · دخول ${a.AdmissionNo}` : `تحصيل متبقي بعد الخروج · دخول ${a.AdmissionNo}`),
      payload: { note: str(b.note, 300) },
    });
  }
  const shiftId = await currentShift(t, user);
  const no = await t.nextNumber('receipt');
  const x = await t.insert('Receipts', {
    ReceiptNo: no, Kind: 'payment', VisitId: null, AdmissionId: id, PatientId: a.PatientId, ShiftId: shiftId,
    Gross: pounds(total), Discount: 0, Net: pounds(total), Cash: pounds(cash), Card: pounds(card), Credit: 0,
    Note: str(b.note, 300) || (a.Status === 'active' ? 'دفعة تحت الحساب' : 'تحصيل متبقي بعد الخروج'), PrintCount: 0, CreatedAt: new Date(), CreatedBy: user.id,
    ManualNo: str(ctx.manualNo ?? b.manualNo, 30), OrderId: ctx.orderId || null,
  });
  await audit(t, user, 'receipt.create', 'Receipt', x, { now: { no, net: pounds(total), admission: a.AdmissionNo } });
  return x;
}

/** الخروج والفاتورة النهائية. ctx.makeOrder = إذن للخزينة (المريض يفضل على سريره لحد التحصيل) */
export async function dischargeAdmission(t, user, id, b = {}, ctx = {}) {
  const disc = parseMoney(b.discount, 'الخصم');
  const pay = payParts(b);
  const a = await loadActive(t, id);
  if (dxState(a).diagnosisOverdue) throw conflict('التشخيص لسه مبدئي ومهلته عدّت. حوّله لتشخيص نهائي قبل الخروج.');
  if (!ctx.orderId && a.BillStatus !== 'closed' && await ticketOn(t)) throw conflict('التذكرة لسه ما اتقفلتش. الحسابات تراجع الحساب وتقفلها الأول');
  const now = new Date();
  await postNights(t, id, { at: now });
  const items = await t.query("SELECT * FROM AdmissionItems WHERE AdmissionId = ? AND Status = 'active' ORDER BY Id", [id]);
  const total = items.reduce((s, i) => s + cents(i.PatientAmount ?? i.Amount), 0);
  const paidRow = await t.one('SELECT SUM(Net) AS P FROM Receipts WHERE AdmissionId = ?', [id]);
  const paid = cents(paidRow?.P);
  if (disc > total) throw bad('الخصم أكبر من الحساب');
  let discountBy = null;
  const discountReason = str(b.discountReason, 300);
  if (disc > 0) {
    if (!ctx.orderId && !can(user, 'cash.discount')) throw forbidden('مش مسموح لك تعمل خصم');
    if (!discountReason || discountReason.length < 3) throw bad('اكتب سبب الخصم');
    discountBy = await managerId(t, b.discountApprovedBy, 'الخصم');
  }
  const R = total - disc - paid;
  let { cash, card, credit } = pay;
  let creditBy = null;
  const note = str(b.note, 300);
  if (R < 0) { cash = R; card = 0; credit = 0; } else {
    if (ctx.makeOrder) { cash = R - credit; card = 0; }
    if (cash + card + credit !== R) throw bad(`مجموع الدفع لازم يساوي المتبقي (${pounds(R)} ${RT.money.unitWord})`);
    if (credit > 0) {
      creditBy = await managerId(t, b.creditApprovedBy, 'الخروج بمبلغ متبقي');
      if (!note || note.length < 3) throw bad('اكتب سبب الخروج بمبلغ متبقي');
    }
  }
  const due = R < 0 ? R : R - credit;
  if (ctx.makeOrder && due !== 0) {
    if (await t.one("SELECT Id FROM PayOrders WHERE AdmissionId = ? AND Kind = 'discharge' AND Status = 'pending'", [id])) throw conflict('فيه إذن خروج للمريض ده مستني في الخزينة');
    return { order: await createOrder(t, user, {
      kind: 'discharge', admissionId: id, patientId: a.PatientId, amount: due, credit: R < 0 ? 0 : credit, discount: disc,
      description: R < 0 ? `مرتجع للمريض عند الخروج · دخول ${a.AdmissionNo}` : `سداد نهائي عند الخروج · دخول ${a.AdmissionNo}`,
      payload: { discount: pounds(disc), discountReason, discountApprovedBy: discountBy, credit: pounds(R < 0 ? 0 : credit), creditApprovedBy: creditBy, note },
    }) };
  }
  if (ctx.orderId && due !== ctx.amount) throw conflict(`حساب المريض اتغير من وقت الإذن (المطلوب دلوقتي ${pounds(due)} ${RT.money.unitWord}). الاستقبال يلغي الإذن ويعمله تاني`);
  const shiftId = await currentShift(t, user);
  const no = await t.nextNumber('receipt');
  const rid = await t.insert('Receipts', {
    ReceiptNo: no, Kind: R < 0 ? 'return' : 'final', VisitId: null, AdmissionId: id, PatientId: a.PatientId, ShiftId: shiftId,
    Gross: pounds(total - paid), Discount: pounds(disc), Net: pounds(R), Cash: pounds(cash), Card: pounds(card), Credit: pounds(credit),
    DiscountReason: disc > 0 ? discountReason : null, DiscountApprovedBy: discountBy, CreditApprovedBy: creditBy,
    Note: note || (R < 0 ? 'مرتجع للمريض من التأمين' : 'سداد نهائي عند الخروج'), PrintCount: 0, CreatedAt: now, CreatedBy: user.id,
    ManualNo: str(ctx.manualNo ?? b.manualNo, 30), OrderId: ctx.orderId || null,
  });
  // مستحقات الأطباء على بنود الإقامة: بعد توزيع الخصم بالنسبة
  let left = disc;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const amt = cents(it.PatientAmount ?? it.Amount);
    const payerPart = PAYER_LIVE.includes(it.CoverStatus) ? cents(it.PayerAmount) : 0;
    const share = k === items.length - 1 ? left : (total ? Math.floor((disc * amt) / total) : 0);
    left -= share;
    const pct = Number(it.DoctorPct);
    const fixedUnit = cents(it.DoctorFixed || 0);
    if (it.DoctorId && pct > 0) {
      const base = amt + payerPart - share;
      await t.insert('DoctorEarnings', {
        VisitItemId: null, AdmissionItemId: it.Id, DoctorId: it.DoctorId, ReceiptId: rid, BaseAmount: pounds(base), Pct: pct,
        Amount: pounds(RT.money.percent(base, pct)), PayerPart: pounds(RT.money.percent(payerPart, pct)), CreatedAt: now,
      });
    } else if (it.DoctorId && fixedUnit > 0 && amt + payerPart > 0) {
      const total = fixedUnit * Number(it.Qty || 1);
      await t.insert('DoctorEarnings', {
        VisitItemId: null, AdmissionItemId: it.Id, DoctorId: it.DoctorId, ReceiptId: rid, BaseAmount: pounds(amt + payerPart - share), Pct: 0,
        Amount: pounds(total), PayerPart: pounds(payerPart > 0 ? Math.round((total * payerPart) / (amt + payerPart)) : 0), CreatedAt: now,
      });
    }
    if (a.PayerId && a.PayerStatus !== 'rejected' && PAYER_FINAL.includes(it.CoverStatus) && payerPart > 0) {
      await ledgerCharge(t, user, { payerId: a.PayerId, patientId: a.PatientId, admissionItemId: it.Id, receiptId: rid,
        description: `${it.Name} · دخول ${a.AdmissionNo}`, cardNo: a.CardNo, full: cents(it.Amount), amount: payerPart });
    }
  }
  await t.run('UPDATE BedMoves SET ToAt = ? WHERE AdmissionId = ? AND ToAt IS NULL', [now, id]);
  await setBed(t, user, a.BedId, 'cleaning');
  await t.run("UPDATE Admissions SET Status = 'discharged', DischargedAt = ?, DischargedBy = ?, DischargeNote = ? WHERE Id = ?", [now, user.id, note, id]);
  await audit(t, user, 'admission.discharge', 'Admission', id, {
    now: { no, total: pounds(total), paid: pounds(paid), discount: pounds(disc), net: pounds(R), credit: pounds(credit) }, note: disc > 0 ? `خصم: ${discountReason}` : note,
  });
  return { receiptId: rid };
}

export default function admissionsRouter(db) {
  const r = router();

  // ===== لوحة الأسرّة =====
  // قايمة التشخيصات الجاهزة (بحث). لازم قبل /:id
  r.get('/diagnoses', async (req, res) => {
    need(req.user, 'admissions.read');
    const q = String(req.query.q || '').trim().slice(0, 60);
    const rows = await db.query(`SELECT Name FROM DiagnosisList WHERE Active = 1${q ? ' AND Name LIKE ?' : ''} ORDER BY SortOrder, Name`, q ? [`%${q}%`] : []);
    res.json({ diagnoses: rows.slice(0, 40).map((x) => x.Name) });
  });

  r.get('/beds/board', async (req, res) => {
    need(req.user, 'admissions.read');
    const rows = await db.query(
      `${bedSql.replace('FROM Beds b', `, a.Id AS AdmId, a.AdmissionNo, a.Type AS AdmType, a.AdmittedAt, a.BillStatus,
       (SELECT COUNT(*) FROM Tickets tk WHERE tk.AdmissionId = a.Id AND tk.TicketDate = ?) AS TicketsToday, p.Id AS PatientId, p.FullName, p.PatientNo, p.Sex, d.Name AS DoctorName
       FROM Beds b`)}
        LEFT JOIN Admissions a ON a.BedId = b.Id AND a.Status = 'active' LEFT JOIN Patients p ON p.Id = a.PatientId LEFT JOIN Doctors d ON d.Id = a.DoctorId
       WHERE b.Active = 1 AND r.Active = 1 AND f.Active = 1 ORDER BY f.Number, r.Number, b.Label`, [cairoDate()]);
    const floors = new Map();
    const fcp = await floorClassMap(db);
    for (const x of rows) {
      const fp = fcp.get(`${x.FloorId}|${x.ClassId}`);
      if (fp != null) x.NightPrice = pounds(fp);
      if (!floors.has(x.FloorId)) floors.set(x.FloorId, { id: x.FloorId, no: x.FloorNo, name: x.FloorName, rooms: new Map() });
      const f = floors.get(x.FloorId);
      if (!f.rooms.has(x.RoomId)) f.rooms.set(x.RoomId, { id: x.RoomId, no: x.RoomNo, notes: x.RoomNotes, cls: bedDto(x).cls, beds: [] });
      const b = bedDto(x);
      if (x.AdmId) {
        b.admission = { id: x.AdmId, no: x.AdmissionNo, type: x.AdmType, admittedAt: toIso(x.AdmittedAt), doctor: x.DoctorName, closed: x.BillStatus === 'closed', ticketToday: Number(x.TicketsToday) > 0, patient: { id: x.PatientId, name: x.FullName, no: x.PatientNo, sex: x.Sex } };
        b.status = 'occupied';
      }
      f.rooms.get(x.RoomId).beds.push(b);
    }
    const out = [...floors.values()].map((f) => ({ ...f, rooms: [...f.rooms.values()] }));
    const all = rows.map((x) => (x.AdmId ? 'occupied' : x.Status));
    const count = (s) => all.filter((x) => x === s).length;
    res.json({ floors: out, counts: { total: all.length, free: count('free'), occupied: count('occupied'), cleaning: count('cleaning'), reserved: count('reserved') } });
  });

  // تغيير حالة سرير: تحت التنظيف ← فاضي ، فاضي ⇄ محجوز
  r.post('/beds/:id/status', async (req, res) => {
    need(req.user, 'beds.status');
    const id = intId(req.params.id);
    const to = req.body?.status;
    const note = str(req.body?.note, 200);
    const b = await db.one('SELECT * FROM Beds WHERE Id = ?', [id]);
    if (!b) throw notFound('السرير مش موجود');
    const occ = await db.one("SELECT Id FROM Admissions WHERE BedId = ? AND Status = 'active'", [id]);
    if (occ) throw conflict('السرير عليه مريض. لتغييره اعمل تحويل أو خروج');
    if (!['free', 'cleaning', 'reserved'].includes(to)) throw bad('الحالة مش صحيحة');
    const allowed = { cleaning: ['free'], free: ['reserved', 'cleaning'], reserved: ['free'] }[b.Status] || [];
    if (!allowed.includes(to) && !can(req.user, 'admissions.override')) throw forbidden('التغيير ده محتاج المدير');
    if (to === 'reserved' && !note) throw bad('اكتب محجوز لمين', { errors: { note: 'اكتب محجوز لمين' } });
    await db.tx(async (t) => {
      await setBed(t, req.user, id, to, to === 'reserved' ? note : null);
      await audit(t, req.user, 'bed.status', 'Bed', id, { old: b.Status, now: to, note });
    });
    res.json({ ok: true });
  });

  // ===== المرضى المقيمين =====
  r.get('/active', async (req, res) => {
    need(req.user, 'admissions.read');
    await postAllNights(db);
    const rows = await db.query(
      `SELECT a.Id, a.AdmissionNo, a.Type, a.AdmittedAt, a.DepositRequired, a.BillStatus, p.Id AS PatientId, p.FullName, p.PatientNo, p.Sex, d.Name AS DoctorName,
              b.Label, r.Number AS RoomNo, f.Number AS FloorNo, c.Name AS ClassName,
              (SELECT SUM(PatientAmount) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active') AS Total,
              (SELECT SUM(PayerAmount) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active') AS PayerTotal, py.Name AS PayerName,
              (SELECT COUNT(*) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active' AND Kind = 'night') AS Nights,
              (SELECT SUM(Net) FROM Receipts WHERE AdmissionId = a.Id) AS Paid
         FROM Admissions a JOIN Patients p ON p.Id = a.PatientId LEFT JOIN Doctors d ON d.Id = a.DoctorId LEFT JOIN Payers py ON py.Id = a.PayerId
         JOIN Beds b ON b.Id = a.BedId JOIN Rooms r ON r.Id = b.RoomId JOIN Floors f ON f.Id = r.FloorId JOIN RoomClasses c ON c.Id = r.ClassId
        WHERE a.Status = 'active' ORDER BY f.Number, r.Number, b.Label`);
    res.json({
      admissions: rows.map((x) => {
        const total = cents(x.Total), paid = cents(x.Paid);
        return {
          id: x.Id, no: x.AdmissionNo, type: x.Type, admittedAt: toIso(x.AdmittedAt), doctor: x.DoctorName, nights: Number(x.Nights),
          patient: { id: x.PatientId, name: x.FullName, no: x.PatientNo, sex: x.Sex },
          bed: { label: x.Label, room: x.RoomNo, floor: x.FloorNo, className: x.ClassName },
          total: pounds(total), paid: pounds(paid), balance: pounds(total - paid), needsPayment: total > paid,
          payer: x.PayerName || null, payerTotal: pounds(cents(x.PayerTotal)), closed: x.BillStatus === 'closed',
        };
      }),
    });
  });

  // ===== دخول جديد =====
  r.post('/', async (req, res) => {
    need(req.user, 'admissions.write');
    const b = req.body || {};
    const patientId = intId(b.patientId, 'المريض');
    if (!ADM_TYPES[b.type]) throw bad('اختار نوع الدخول', { errors: { type: 'اختار نوع الدخول' } });
    if (!b.bedId) throw bad('اختار السرير', { errors: { bed: 'اختار السرير من اللوحة' } });
    const bedId = intId(b.bedId, 'السرير');
    if (!b.doctorId) throw bad('اختار الطبيب المعالج', { errors: { doctor: 'اختار الطبيب المعالج' } });
    const doctorId = intId(b.doctorId, 'الدكتور');
    const deposit = parseMoney(b.deposit, 'التأمين');
    const pay = payParts(b);
    let warn = null;
    const out = await db.tx(async (t) => {
      const py = await pickPayer(t, patientId, b.payer);
      warn = py.warn;
      const payer = py.payer;
      const p = await t.one('SELECT * FROM Patients WHERE Id = ?', [patientId]);
      if (!p) throw notFound('المريض مش موجود');
      const missing = [];
      const pr = RT.patientFields.adm; // المطلوب للإقامة من الإعدادات (التليفون إجباري ومقفول)
      if (pr.nid === 'req' && !p.NationalId) missing.push('الرقم القومي');
      if (pr.phone === 'req' && !p.Phone) missing.push('التليفون');
      if (pr.age === 'req' && !p.BirthDate && p.AgeYears == null) missing.push('السن');
      if (pr.sex === 'req' && !p.Sex) missing.push('النوع');
      if (nameParts(p.FullName) < pr.words) missing.push('الاسم كامل');
      if (!p.Address) missing.push('العنوان');
      if (!p.EmergencyName || !p.EmergencyPhone) missing.push('قريب للطوارئ وتليفونه');
      if (missing.length) throw bad(`بيانات المريض ناقصة للدخول: ${missing.join('، ')}`, { needsPatientData: missing });
      const already = await t.one("SELECT AdmissionNo FROM Admissions WHERE PatientId = ? AND Status = 'active'", [patientId]);
      if (already) throw conflict(`المريض ده داخل بالفعل (دخول رقم ${already.AdmissionNo})`);
      const bed = await freeBed(t, bedId);
      if (KIND_FOR_TYPE[b.type] !== bed.Kind) throw bad(`السرير ده ${KIND_NAMES[bed.Kind]}، ومش مناسب لدخول ${ADM_TYPES[b.type]}`, { errors: { bed: 'اختار سرير مناسب لنوع الدخول' } });
      const doc = await t.one('SELECT Id FROM Doctors WHERE Id = ? AND Active = 1', [doctorId]);
      if (!doc) throw bad('الدكتور ده مش موجود');
      // مريض التعاقد بيدفع تأمين على قد نصيبه من الإقامة (100% = من غير تأمين)
      const wardPct = payer ? (payer.coverage.ward ?? 0) : 0;
      const minDep = RT.money.discount(cents(bed.Deposit || 0), wardPct);
      if (deposit < minDep && !can(req.user, 'admissions.override')) {
        throw bad(`التأمين لدرجة «${bed.ClassName}» مينفعش يقل عن ${pounds(minDep)} ${RT.money.unitWord}`, { errors: { deposit: `أقل مبلغ ${pounds(minDep)} ${RT.money.unitWord} (المدير بس يقدر يقلله)` } });
      }
      const ordering = deposit - pay.credit > 0 && await mustOrder(t, req.user);
      if (pay.credit > deposit) throw bad('الآجل أكبر من التأمين');
      if (!ordering && pay.cash + pay.card + pay.credit !== deposit) throw bad(`مجموع الدفع لازم يساوي التأمين (${pounds(deposit)} ${RT.money.unitWord})`);
      const creditBy = pay.credit > 0 ? await managerId(t, b.creditApprovedBy, 'الآجل') : null;
      const no = await t.nextNumber('admission');
      const now = new Date();
      const dxText = str(b.diagnosis, 300) || null;
      const dxProv = !!b.diagnosisProvisional && !!dxText;
      if (RT.dx.required && !dxText) throw bad('التشخيص إجباري عند الدخول', { errors: { diagnosis: 'اكتب التشخيص (أو اختار مبدئي للطوارئ الحرجة)' } });
      if (dxProv && !RT.dx.provisional) throw bad('التشخيص المبدئي مش مفعّل', { errors: { diagnosis: 'التشخيص المبدئي مش مفعّل' } });
      const aid = await t.insert('Admissions', {
        AdmissionNo: no, PatientId: patientId, Type: b.type, Status: 'active', DoctorId: doctorId,
        ExpectedProcedure: str(b.expectedProcedure, 200), BedId: bedId, DepositRequired: pounds(deposit),
        FromVisitId: b.fromVisitId ? Number(b.fromVisitId) : null, Notes: str(b.notes, 400), AdmittedAt: now, AdmittedBy: req.user.id, Diagnosis: dxText, DiagnosisProvisional: dxProv ? 1 : 0,
        PayerId: payer?.id || null, TierId: payer?.tierId || null, CardNo: payer ? py.cardNo : null, PayerStatus: payer ? 'ok' : null,
      });
      if (payer) {
        // موافقة الدخول: بتتراجع الصبح، ولو اترفضت الحساب كله بيتحول نقدي
        const apId = await t.insert('Approvals', {
          Scope: 'admission', PayerId: payer.id, PatientId: patientId, VisitItemId: null, AdmissionItemId: null, AdmissionId: aid,
          ApprovalNo: str(b.approvalNo, 60), ApprovalDate: /^\d{4}-\d{2}-\d{2}$/.test(b.approvalDate || '') ? b.approvalDate : null,
          Status: 'pending', Amount: 0, Note: str(b.approvalNote, 300), CreatedAt: now, CreatedBy: req.user.id,
        });
        await audit(t, req.user, 'approval.create', 'Approval', apId, { now: { status: 'pending', no: b.approvalNo, scope: 'admission' } });
      }
      await t.insert('BedMoves', { AdmissionId: aid, BedId: bedId, ClassId: bed.ClassId, FromAt: now, ToAt: null, MovedBy: req.user.id, Reason: 'دخول' });
      await setBed(t, req.user, bedId, 'occupied');
      let receiptId = null, order = null;
      if (deposit > 0 && ordering) {
        order = await createOrder(t, req.user, {
          kind: 'deposit', admissionId: aid, patientId, amount: deposit - pay.credit, credit: pay.credit,
          description: `تأمين دخول ${ADM_TYPES[b.type]} · غرفة ${bed.RoomNo} سرير ${bed.Label}`,
          payload: { credit: pounds(pay.credit), creditApprovedBy: creditBy, deposit: pounds(deposit) },
        });
      } else if (deposit > 0) {
        const shiftId = await currentShift(t, req.user);
        const rno = await t.nextNumber('receipt');
        receiptId = await t.insert('Receipts', {
          ReceiptNo: rno, Kind: 'deposit', VisitId: null, AdmissionId: aid, PatientId: patientId, ShiftId: shiftId,
          Gross: pounds(deposit), Discount: 0, Net: pounds(deposit), Cash: pounds(pay.cash), Card: pounds(pay.card), Credit: pounds(pay.credit),
          CreditApprovedBy: creditBy, Note: `تأمين دخول ${ADM_TYPES[b.type]} · غرفة ${bed.RoomNo} سرير ${bed.Label}`, PrintCount: 0, CreatedAt: now, CreatedBy: req.user.id,
          ManualNo: str(b.manualNo, 30),
        });
      }
      // تحويل من الطوارئ أو العيادة: الخدمات اللي لسه ما اتدفعتش بتنتقل لحساب الإقامة
      let moved = 0;
      if (b.fromVisitId) {
        const v = await t.one("SELECT * FROM Visits WHERE Id = ? AND PatientId = ? AND Status = 'open'", [Number(b.fromVisitId), patientId]);
        if (v) {
          // أي إذن دفع لسه مستني على الزيارة دي بيتلغي، والبنود بتنتقل للدخول
          await t.run("UPDATE PayOrders SET Status = 'cancelled', CancelReason = ?, DoneAt = ?, DoneBy = ? WHERE VisitId = ? AND Status = 'pending'", [`اتحولت لدخول رقم ${no}`, now, req.user.id, v.Id]);
          await t.run('UPDATE VisitItems SET PendingOrderId = NULL WHERE VisitId = ? AND PaidReceiptId IS NULL', [v.Id]);
          const its = await t.query("SELECT * FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND PaidReceiptId IS NULL", [v.Id]);
          for (const i of its) {
            const amount = cents(i.Amount); // بسعر الزيارة زي ما اتسجل
            const c = await cover(t, payer, { serviceId: i.ServiceId, dept: i.Dept, amount, patientId, admissionId: aid });
            const st = c.status === 'needs' ? 'pending' : c.status;
            const nid = await t.insert('AdmissionItems', {
              AdmissionId: aid, Kind: 'service', ServiceId: i.ServiceId, Name: i.ServiceName, Dept: i.Dept, DoctorId: i.DoctorId, Qty: i.Qty,
              UnitPrice: pounds(amount / i.Qty), Amount: pounds(amount), DoctorPct: i.DoctorPct, DoctorFixed: i.DoctorFixed || 0, ChargeDate: null, ClassId: null, IncludedNights: null,
              PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: st,
              Note: `من زيارة ${v.VisitNo}`, Status: 'active', SourceVisitItemId: i.Id, AddedAt: i.AddedAt, AddedBy: i.AddedBy,
              Cat: i.StockItemId ? (i.Dept === 'drugs' ? 'drug' : 'supply') : 'service', StockItemId: i.StockItemId || null, StoreId: i.StoreId || null, UnitFactor: i.UnitFactor || null,
            });
            // الصنف اتصرف خلاص من مخزن الطوارئ: الحركة تتنقل على بند الإقامة (عشان الشيل يرجّعه صح)
            if (i.StockItemId) await t.run("UPDATE StockMoves SET RefType = 'admitem', RefId = ? WHERE RefType = 'visititem' AND RefId = ?", [nid, i.Id]);
            await t.run("UPDATE Approvals SET Status = 'cancelled' WHERE VisitItemId = ? AND Status IN ('pending','tempcash')", [i.Id]);
            if (st === 'pending') {
              await t.insert('Approvals', {
                Scope: 'item', PayerId: payer.id, PatientId: patientId, VisitItemId: null, AdmissionItemId: nid, AdmissionId: aid,
                ApprovalNo: null, ApprovalDate: null, Status: 'pending', Amount: pounds(c.payerAmount), Note: 'اتنقلت من الطوارئ', CreatedAt: now, CreatedBy: req.user.id,
              });
            }
            await t.run("UPDATE VisitItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?",
              [now, req.user.id, `اتنقلت لحساب الدخول رقم ${no}`, i.Id]);
            moved++;
          }
          await t.run("UPDATE Visits SET Status = 'closed', ClosedAt = ?, ClosedBy = ? WHERE Id = ?", [now, req.user.id, v.Id]);
        }
      }
      await audit(t, req.user, 'admission.create', 'Admission', aid, { now: { no, type: b.type, bed: `${bed.RoomNo}/${bed.Label}`, deposit: pounds(deposit), moved } });
      await postNights(t, aid);
      return { aid, receiptId, order };
    });
    res.status(201).json({ receiptId: out.receiptId, order: out.order, warn, ...(await admissionDetails(db, out.aid)) });
  });

  r.get('/:id', async (req, res) => {
    need(req.user, 'admissions.read');
    res.json(await admissionDetails(db, intId(req.params.id)));
  });

  // تعديل بيانات الدخول (الطبيب، الإجراء، الملاحظات)
  r.put('/:id', async (req, res) => {
    need(req.user, 'admissions.write');
    const id = intId(req.params.id);
    const b = req.body || {};
    await db.tx(async (t) => {
      const a = await loadActive(t, id);
      const doctorId = b.doctorId ? intId(b.doctorId, 'الدكتور') : a.DoctorId;
      if (doctorId && !(await t.one('SELECT Id FROM Doctors WHERE Id = ?', [doctorId]))) throw bad('الدكتور ده مش موجود');
      let dep = cents(a.DepositRequired);
      if (b.depositRequired !== undefined && can(req.user, 'admissions.override')) dep = parseMoney(b.depositRequired, 'التأمين');
      await t.run('UPDATE Admissions SET DoctorId = ?, ExpectedProcedure = ?, Notes = ?, DepositRequired = ? WHERE Id = ?',
        [doctorId, b.expectedProcedure !== undefined ? str(b.expectedProcedure, 200) : a.ExpectedProcedure, b.notes !== undefined ? str(b.notes, 400) : a.Notes, pounds(dep), id]);
      await audit(t, req.user, 'admission.update', 'Admission', id, { old: { doctorId: a.DoctorId }, now: { doctorId } });
    });
    res.json(await admissionDetails(db, id));
  });

  // خدمة على حساب الإقامة
  // التشخيص (للتعاقدات والمطالبة)
  r.put('/:id/diagnosis', async (req, res) => {
    if (!can(req.user, 'admissions.write')) throw forbidden('تعديل التشخيص للاستقبال بس');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const a = await t.one('SELECT Diagnosis, DiagnosisProvisional FROM Admissions WHERE Id = ?', [id]);
      if (!a) throw notFound('الدخول مش موجود');
      const d = str(req.body?.diagnosis, 300) || null;
      const prov = !!req.body?.provisional && !!d;
      if (!d && RT.dx.required) throw bad('التشخيص إجباري، مينفعش يتمسح', { errors: { diagnosis: 'اكتب التشخيص' } });
      if (prov && !RT.dx.provisional) throw bad('التشخيص المبدئي مش مفعّل');
      if ((a.Diagnosis || null) === d && toBool(a.DiagnosisProvisional) === prov) return;
      await t.run('UPDATE Admissions SET Diagnosis = ?, DiagnosisProvisional = ? WHERE Id = ?', [d, prov ? 1 : 0, id]);
      await audit(t, req.user, 'admission.diagnosis', 'Admission', id, { old: { diagnosis: a.Diagnosis, provisional: toBool(a.DiagnosisProvisional) }, now: { diagnosis: d, provisional: prov } });
    });
    res.json(await admissionDetails(db, id));
  });
  r.post('/:id/items', async (req, res) => {
    await needBill(db, req.user);
    const id = intId(req.params.id);
    const svc = await getService(db, intId(req.body?.serviceId, 'الخدمة'));
    if (!svc || !svc.active || svc.price == null) throw bad('الخدمة دي مش متاحة');
    const qty = Number(req.body?.qty || 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw bad('العدد مش صحيح');
    const doctorId = req.body?.doctorId ? intId(req.body.doctorId, 'الدكتور') : null;
    if (svc.hasDoctor && !doctorId) throw bad(`اختار الدكتور لـ «${svc.name}»`);
    const share = await resolveDoctorShare(db, doctorId, svc.id, svc.dept);
    const itemId = await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      const payer = await admissionPayer(t, a);
      const floorId = await floorAt(t, id);
      const base = svc.ticketCat === 'fee' ? cents(svc.price) : await floorServicePrice(t, floorId, svc.id, cents(svc.price));
      const unit = await servicePrice(t, payer, svc.id, base);
      const amount = unit * qty;
      const c = await cover(t, payer, { serviceId: svc.id, dept: svc.dept, amount, patientId: a.PatientId, admissionId: id });
      const st = c.status === 'needs' ? 'pending' : c.status;
      const now = new Date();
      const iid = await t.insert('AdmissionItems', {
        AdmissionId: id, Kind: 'service', ServiceId: svc.id, Name: svc.name, Dept: svc.dept, DoctorId: doctorId, Qty: qty,
        UnitPrice: pounds(unit), Amount: pounds(amount), DoctorPct: share.pct, DoctorFixed: pounds(share.fixed), ChargeDate: null, ClassId: null,
        PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: st,
        IncludedNights: svc.includedNights || null, Note: null, Status: 'active', AddedAt: now, AddedBy: req.user.id, Cat: svc.ticketCat || 'service', FloorId: floorId,
      });
      if (st === 'pending') {
        const ap = req.body?.approval || {};
        await t.insert('Approvals', {
          Scope: 'item', PayerId: payer.id, PatientId: a.PatientId, VisitItemId: null, AdmissionItemId: iid, AdmissionId: id,
          ApprovalNo: str(ap.no, 60), ApprovalDate: /^\d{4}-\d{2}-\d{2}$/.test(ap.date || '') ? ap.date : null,
          Status: 'pending', Amount: pounds(c.payerAmount), Note: str(ap.note, 300), CreatedAt: now, CreatedBy: req.user.id,
        });
      }
      if (svc.includedNights) await postNights(t, id);
      return iid;
    });
    res.status(201).json({ itemId, ...(await admissionDetails(db, id)) });
  });

  // شيل بند: الخدمات بسبب، والليالي المدير بس
  r.delete('/:id/items/:itemId', async (req, res) => {
    await needBill(db, req.user);
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب');
    await db.tx(async (t) => {
      await loadOpen(t, id);
      const it = await t.one('SELECT * FROM AdmissionItems WHERE Id = ? AND AdmissionId = ?', [itemId, id]);
      if (!it || it.Status !== 'active') throw notFound('البند مش موجود');
      if (it.Kind === 'night' && !can(req.user, 'admissions.override')) throw forbidden('شيل ليلة إقامة محتاج المدير');
      await t.run("UPDATE AdmissionItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?", [new Date(), req.user.id, reason, itemId]);
      await t.run("UPDATE Approvals SET Status = 'cancelled' WHERE AdmissionItemId = ? AND Status = 'pending'", [itemId]);
      if (it.StoreId) await giveBack(t, req.user, { refType: 'admitem', refId: itemId, kind: 'ticket_back', note: reason });
      await audit(t, req.user, 'admission.item.remove', 'Admission', id, { old: { name: it.Name, amount: Number(it.Amount), date: toDateStr(it.ChargeDate) }, note: reason });
      if (it.IncludedNights) await postNights(t, id);
    });
    res.json(await admissionDetails(db, id));
  });

  // دفعة تحت الحساب (أو إذن دفع للخزينة)
  r.post('/:id/pay', async (req, res) => {
    need(req.user, 'cash.collect');
    const id = intId(req.params.id);
    const out = await db.tx(async (t) => {
      if (await mustOrder(t, req.user)) return { order: await payAdmission(t, req.user, id, req.body || {}, { makeOrder: true }) };
      return { receiptId: await payAdmission(t, req.user, id, req.body || {}) };
    });
    res.status(201).json({ ...out, ...(await admissionDetails(db, id)) });
  });

  // تحويل سرير (أو من داخلي لعناية والعكس)
  r.post('/:id/transfer', async (req, res) => {
    need(req.user, 'admissions.write');
    const id = intId(req.params.id);
    const bedId = intId(req.body?.bedId, 'السرير');
    const reason = str(req.body?.reason, 200);
    await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      if (a.BedId === bedId) throw bad('ده نفس السرير');
      const bed = await freeBed(t, bedId);
      const type = admRoomKind(a.Type) === bed.Kind ? a.Type : (admTypeForKind(bed.Kind) || a.Type);
      const now = new Date();
      await t.run('UPDATE BedMoves SET ToAt = ? WHERE AdmissionId = ? AND ToAt IS NULL', [now, id]);
      await t.insert('BedMoves', { AdmissionId: id, BedId: bedId, ClassId: bed.ClassId, FromAt: now, ToAt: null, MovedBy: req.user.id, Reason: reason || 'تحويل' });
      await setBed(t, req.user, a.BedId, 'cleaning');
      await setBed(t, req.user, bedId, 'occupied');
      await t.run('UPDATE Admissions SET BedId = ?, Type = ? WHERE Id = ?', [bedId, type, id]);
      await audit(t, req.user, 'admission.transfer', 'Admission', id, { old: { bedId: a.BedId, type: a.Type }, now: { bedId, type, bed: `${bed.RoomNo}/${bed.Label}` }, note: reason });
      await postNights(t, id);
    });
    res.json(await admissionDetails(db, id));
  });

  // حساب الخروج من غير تنفيذ (لو خرج دلوقتي)
  r.get('/:id/discharge-preview', async (req, res) => {
    need(req.user, 'admissions.read');
    const id = intId(req.params.id);
    try {
      await db.tx(async (t) => {
        await loadActive(t, id);
        await postNights(t, id, { at: new Date() });
        throw new Rollback(await admissionDetails(t, id, { post: false }));
      });
    } catch (e) {
      if (e instanceof Rollback) return res.json({ ...e.value, checkoutTime: await getSetting(db, 'checkoutTime', '12:00') });
      throw e;
    }
  });

  // الخروج: الفاتورة النهائية، والمتبقي يتدفع أو يتسجل آجل بموافقة المدير، والزيادة ترجع للمريض
  r.post('/:id/discharge', async (req, res) => {
    need(req.user, 'admissions.write');
    need(req.user, 'cash.collect');
    const id = intId(req.params.id);
    const out = await db.tx(async (t) => dischargeAdmission(t, req.user, id, req.body || {}, { makeOrder: await mustOrder(t, req.user) }));
    res.status(201).json({ ...out, ...(await admissionDetails(db, id)) });
  });

  // إلغاء الخروج (المدير): إيصال عكسي، والمريض يرجع على سريره
  r.post('/:id/undo-discharge', async (req, res) => {
    need(req.user, 'admissions.override');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب إلغاء الخروج');
    await db.tx(async (t) => {
      const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [id]);
      if (!a) throw notFound('الدخول ده مش موجود');
      if (a.Status !== 'discharged') throw conflict('المريض لسه ماخرجش');
      const occ = await t.one("SELECT Id FROM Admissions WHERE BedId = ? AND Status = 'active'", [a.BedId]);
      if (occ) throw conflict('السرير بتاعه اتشغل بمريض تاني');
      const other = await t.one("SELECT Id FROM Admissions WHERE PatientId = ? AND Status = 'active'", [a.PatientId]);
      if (other) throw conflict('المريض عليه دخول تاني مفتوح');
      const fin = await t.one(t.top("SELECT * FROM Receipts WHERE AdmissionId = ? AND Kind IN ('final','return') AND ReversedByReceiptId IS NULL ORDER BY Id DESC", 1), [id]);
      const now = new Date();
      if (fin) {
        const shiftId = await currentShift(t, req.user);
        const no = await t.nextNumber('receipt');
        const neg = (v) => -Number(v);
        const rid = await t.insert('Receipts', {
          ReceiptNo: no, Kind: 'refund', VisitId: null, AdmissionId: id, PatientId: a.PatientId, ShiftId: shiftId,
          Gross: neg(fin.Gross), Discount: neg(fin.Discount), Net: neg(fin.Net), Cash: neg(fin.Cash), Card: neg(fin.Card), Credit: neg(fin.Credit),
          ReversesReceiptId: fin.Id, Reason: 'إلغاء الخروج: ' + reason, PrintCount: 0, CreatedAt: now, CreatedBy: req.user.id,
        });
        await t.run('UPDATE Receipts SET ReversedByReceiptId = ? WHERE Id = ?', [rid, fin.Id]);
        for (const e of await t.query('SELECT * FROM DoctorEarnings WHERE ReceiptId = ?', [fin.Id])) {
          await t.insert('DoctorEarnings', {
            VisitItemId: null, AdmissionItemId: e.AdmissionItemId, DoctorId: e.DoctorId, ReceiptId: rid, BaseAmount: neg(e.BaseAmount), Pct: e.Pct, Amount: neg(e.Amount),
            PayerPart: neg(e.PayerPart || 0), CreatedAt: now,
          });
        }
        await ledgerReverse(t, req.user, 'ReceiptId = ?', [fin.Id]);
      }
      await t.run("UPDATE AdmissionItems SET Status = 'active', VoidedAt = NULL, VoidReason = NULL WHERE AdmissionId = ? AND Kind = 'night' AND Status = 'voided' AND VoidReason = ?", [id, EARLY_OUT]);
      const last = await t.one(t.top('SELECT Id FROM BedMoves WHERE AdmissionId = ? ORDER BY Id DESC', 1), [id]);
      await t.run('UPDATE BedMoves SET ToAt = NULL WHERE Id = ?', [last.Id]);
      await setBed(t, req.user, a.BedId, 'occupied');
      await t.run("UPDATE Admissions SET Status = 'active', DischargedAt = NULL, DischargedBy = NULL, DischargeNote = NULL, BillStatus = NULL, ClosedAt = NULL, ClosedBy = NULL WHERE Id = ?", [id]);
      await audit(t, req.user, 'admission.undo', 'Admission', id, { note: reason });
      await postNights(t, id);
    });
    res.json(await admissionDetails(db, id));
  });

  return r;
}

export { DEPTS };
