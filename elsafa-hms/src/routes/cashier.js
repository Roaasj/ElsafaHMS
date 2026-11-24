// الخزينة: أذونات الدفع، فتح وتقفيل الوردية والتسليم، وتقرير الخزينة اليومي
import { R, argb } from '../lib/runtime.js';
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, parseMoney, cairoDate } from '../lib/util.js';
import { toIso, toDateStr } from '../db/index.js';
import { ORDER_KINDS, SHIFT_LABELS, cashierOnDuty, mustOrder, shiftLabel, businessDate } from '../lib/cashier.js';
import { VISIT_TYPES } from './catalog.js';
import { payVisit, refundDue, currentShift } from './visits.js';
import { postShiftSafe } from '../lib/ledger-shift.js';
import { payAdmission, dischargeAdmission, ADM_TYPES } from './admissions.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ================= أذونات الدفع =================
function orderDto(o) {
  return {
    id: o.Id, no: o.OrderNo, kind: o.Kind, kindName: ORDER_KINDS[o.Kind], status: o.Status,
    amount: Number(o.Amount), credit: Number(o.Credit), discount: Number(o.Discount), description: o.Description,
    patient: { id: o.PatientId, name: o.PatientName, no: o.PatientNo },
    visitId: o.VisitId, visitNo: o.VisitNo, visitType: o.VisitType, admissionId: o.AdmissionId, admissionNo: o.AdmissionNo,
    payer: o.PayerName || null,
    createdAt: toIso(o.CreatedAt), createdBy: o.CreatedByName, createdById: o.CreatedBy,
    doneAt: toIso(o.DoneAt), doneBy: o.DoneByName || null, receiptId: o.ReceiptId, receiptNo: o.ReceiptNo || null,
    cancelReason: o.CancelReason,
  };
}
const ORDER_SQL = `SELECT o.*, p.FullName AS PatientName, p.PatientNo, v.VisitNo, v.Type AS VisitType, a.AdmissionNo,
    u.FullName AS CreatedByName, d.FullName AS DoneByName, r.ReceiptNo, py.Name AS PayerName
  FROM PayOrders o JOIN Patients p ON p.Id = o.PatientId JOIN Users u ON u.Id = o.CreatedBy LEFT JOIN Users d ON d.Id = o.DoneBy
  LEFT JOIN Visits v ON v.Id = o.VisitId LEFT JOIN Admissions a ON a.Id = o.AdmissionId LEFT JOIN Receipts r ON r.Id = o.ReceiptId
  LEFT JOIN Payers py ON py.Id = COALESCE(v.PayerId, a.PayerId)`;

/** تنفيذ إذن الدفع: بيطلع الإيصال باسم اللي حصّل وفي ورديته */
async function executeOrder(t, user, o, { cash, card, manualNo }) {
  const amount = cents(o.Amount);
  const pl = JSON.parse(o.Payload || '{}');
  const ctx = { orderId: o.Id, amount, manualNo };
  if (amount > 0 && cash + card !== amount) throw bad(`مجموع النقدي والفيزا لازم يساوي ${pounds(amount)} ${R.money.unitWord}`);
  if (amount < 0) { cash = amount; card = 0; }
  switch (o.Kind) {
    case 'visit':
      return payVisit(t, user, o.VisitId, { ...pl, cash: pounds(cash), card: pounds(card) }, ctx);
    case 'adm_pay':
      return payAdmission(t, user, o.AdmissionId, { cash: pounds(cash), card: pounds(card), note: pl.note }, ctx);
    case 'refund_due':
      return refundDue(t, user, o.VisitId, ctx);
    case 'discharge':
      return (await dischargeAdmission(t, user, o.AdmissionId, { ...pl, cash: pounds(Math.max(cash, 0)), card: pounds(card) }, ctx)).receiptId;
    case 'deposit': {
      const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [o.AdmissionId]);
      if (!a || a.Status !== 'active') throw conflict('الدخول ده اتقفل. الغي الإذن');
      const credit = parseMoney(pl.credit, 'الآجل');
      const shiftId = await currentShift(t, user);
      const no = await t.nextNumber('receipt');
      const rid = await t.insert('Receipts', {
        ReceiptNo: no, Kind: 'deposit', VisitId: null, AdmissionId: a.Id, PatientId: a.PatientId, ShiftId: shiftId,
        Gross: pounds(amount + credit), Discount: 0, Net: pounds(amount + credit), Cash: pounds(cash), Card: pounds(card), Credit: pounds(credit),
        CreditApprovedBy: pl.creditApprovedBy || null, Note: o.Description, PrintCount: 0, CreatedAt: new Date(), CreatedBy: user.id,
        ManualNo: str(manualNo, 30), OrderId: o.Id,
      });
      await audit(t, user, 'receipt.create', 'Receipt', rid, { now: { no, net: pounds(amount + credit), admission: a.AdmissionNo } });
      return rid;
    }
    default: throw bad('نوع إذن مش معروف');
  }
}

export function ordersRouter(db) {
  const r = router();

  r.get('/', async (req, res) => {
    need(req.user, 'receipts.read');
    const st = ['pending', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : null;
    const where = ['o.Status = ?'];
    const params = [st];
    if (st !== 'pending') {
      const since = date ? new Date(`${date}T00:00:00Z`) : new Date(Date.now() - 24 * 3600e3);
      where.push('o.CreatedAt >= ?'); params.push(new Date(since.getTime() - 3 * 3600e3));
    }
    if (req.query.mine === '1') { where.push('o.CreatedBy = ?'); params.push(req.user.id); }
    const rows = await db.query(`${ORDER_SQL} WHERE ${where.join(' AND ')} ORDER BY o.Id ${st === 'pending' ? 'ASC' : 'DESC'}`, params);
    const duty = await cashierOnDuty(db);
    const pending = await db.one("SELECT COUNT(*) AS N, SUM(Amount) AS S FROM PayOrders WHERE Status = 'pending'");
    res.json({
      orders: rows.map(orderDto), onDuty: duty ? { userId: duty.UserId, name: duty.FullName } : null,
      pending: { count: Number(pending.N || 0), amount: pounds(cents(pending.S)) },
      manualNoRequired: (await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'manualNoRequired'"))?.Value === '1',
    });
  });

  // فيه خزينة شغالة؟ (الاستقبال بيعمل إذن ولا بيقبض)
  r.get('/duty', async (req, res) => {
    const duty = await cashierOnDuty(db);
    res.json({ onDuty: duty ? { userId: duty.UserId, name: duty.FullName } : null, mustOrder: await mustOrder(db, req.user) });
  });

  r.get('/:id', async (req, res) => {
    need(req.user, 'receipts.read');
    const o = await db.one(`${ORDER_SQL} WHERE o.Id = ? OR o.OrderNo = ?`, [intId(req.params.id), intId(req.params.id)]);
    if (!o) throw notFound('الإذن مش موجود');
    res.json({ order: orderDto(o) });
  });

  // التحصيل في الخزينة
  r.post('/:id/collect', async (req, res) => {
    need(req.user, 'cash.collect');
    const id = intId(req.params.id);
    const b = req.body || {};
    const cash = parseMoney(b.cash, 'النقدي'), card = parseMoney(b.card, 'الفيزا');
    const manualNo = str(b.manualNo, 30);
    const receiptId = await db.tx(async (t) => {
      if (await mustOrder(t, req.user)) throw forbidden('التحصيل من الخزينة');
      const o = await t.one('SELECT * FROM PayOrders WHERE Id = ?', [id]);
      if (!o) throw notFound('الإذن مش موجود');
      if (o.Status !== 'pending') throw conflict(o.Status === 'done' ? 'الإذن ده اتحصّل قبل كده' : 'الإذن ده اتلغى');
      const req1 = (await t.one("SELECT Value FROM AppSettings WHERE [Key] = 'manualNoRequired'"))?.Value === '1';
      if (req1 && !manualNo && cents(o.Amount) !== 0) throw bad('اكتب رقم الإيصال اليدوي', { errors: { manualNo: 'اكتب رقم الإيصال اليدوي' } });
      const rid = await executeOrder(t, req.user, o, { cash, card, manualNo });
      const n = await t.run("UPDATE PayOrders SET Status = 'done', DoneAt = ?, DoneBy = ?, ReceiptId = ? WHERE Id = ? AND Status = 'pending'", [new Date(), req.user.id, rid, id]);
      if (n === 0) throw conflict('الإذن ده اتحصّل من جهاز تاني');
      await audit(t, req.user, 'order.collect', 'PayOrder', id, { now: { no: o.OrderNo, receiptId: rid, manualNo } });
      return rid;
    });
    const o = await db.one(`${ORDER_SQL} WHERE o.Id = ?`, [id]);
    res.status(201).json({ receiptId, order: orderDto(o) });
  });

  // إلغاء الإذن (اللي عمله، أو المشرف/الخزينة/المدير)
  r.post('/:id/cancel', async (req, res) => {
    need(req.user, 'receipts.read');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const o = await t.one('SELECT * FROM PayOrders WHERE Id = ?', [id]);
      if (!o) throw notFound('الإذن مش موجود');
      if (o.Status !== 'pending') throw conflict('الإذن ده مش مستني');
      if (o.CreatedBy !== req.user.id && !can(req.user, 'orders.cancelAny')) throw forbidden('إلغاء إذن موظف تاني محتاج المشرف أو الخزينة');
      await t.run("UPDATE PayOrders SET Status = 'cancelled', CancelReason = ?, DoneAt = ?, DoneBy = ? WHERE Id = ?", [reason, new Date(), req.user.id, id]);
      await t.run('UPDATE VisitItems SET PendingOrderId = NULL WHERE PendingOrderId = ?', [id]);
      await audit(t, req.user, 'order.cancel', 'PayOrder', id, { old: { no: o.OrderNo, amount: Number(o.Amount) }, note: reason });
    });
    res.json({ ok: true });
  });

  return r;
}

// ================= الورديات =================
export async function shiftSummary(t, shiftId) {
  const s = await t.one(`SELECT s.*, u.FullName, u.Role, h.FullName AS HandedToName, rv.FullName AS ReceivedByName FROM Shifts s JOIN Users u ON u.Id = s.UserId
     LEFT JOIN Users h ON h.Id = s.HandedTo LEFT JOIN Users rv ON rv.Id = s.ReceivedBy WHERE s.Id = ?`, [shiftId]);
  if (!s) throw notFound('الوردية مش موجودة');
  const rows = await t.query('SELECT Kind, COUNT(*) AS N, SUM(Net) AS Net, SUM(Cash) AS Cash, SUM(Card) AS Card, SUM(Credit) AS Credit, SUM(Discount) AS Disc, SUM(CASE WHEN ManualNo IS NULL THEN 1 ELSE 0 END) AS NoManual FROM Receipts WHERE ShiftId = ? GROUP BY Kind', [shiftId]);
  const sum = (k, f = () => true) => rows.filter(f).reduce((a, x) => a + cents(x[k]), 0);
  const isOut = (x) => ['refund', 'return'].includes(x.Kind);
  const received = await t.query(`SELECT s.Id, s.CountedCash, s.ClosedAt, u.FullName, s.Label FROM Shifts s JOIN Users u ON u.Id = s.UserId WHERE s.ReceivedShiftId = ? ORDER BY s.Id`, [shiftId]);
  const recCash = received.reduce((a, x) => a + cents(x.CountedCash), 0);
  const cashIn = sum('Cash', (x) => !isOut(x)), cashOut = -sum('Cash', isOut);
  // إذون الصرف اللي صرفها صاحب الوردية من الدرج (مستحقات أطباء، مصروفات، موردين، أقساط)
  const vo = await t.one("SELECT COUNT(*) AS N, COALESCE(SUM(Amount), 0) AS S FROM CashVouchers WHERE ShiftId = ? AND Status = 'paid'", [shiftId]);
  const vouchers = cents(vo.S);
  const expected = cashIn - cashOut - vouchers + recCash;
  return {
    id: s.Id, user: { id: s.UserId, name: s.FullName, role: s.Role }, label: s.Label || shiftLabel(s.OpenedAt), labelName: SHIFT_LABELS[s.Label || shiftLabel(s.OpenedAt)],
    businessDate: toDateStr(s.BusinessDate) || businessDate(s.OpenedAt), openedAt: toIso(s.OpenedAt), closedAt: toIso(s.ClosedAt),
    receipts: rows.filter((x) => !isOut(x)).reduce((a, x) => a + Number(x.N), 0), outs: rows.filter(isOut).reduce((a, x) => a + Number(x.N), 0),
    noManual: rows.reduce((a, x) => a + Number(x.NoManual || 0), 0),
    cashIn: pounds(cashIn), cashOut: pounds(cashOut), vouchers: pounds(vouchers), voucherCount: Number(vo.N), card: pounds(sum('Card')), credit: pounds(sum('Credit')), discount: pounds(sum('Disc', (x) => !isOut(x))),
    net: pounds(sum('Net')), received: received.map((x) => ({ shiftId: x.Id, name: x.FullName, label: SHIFT_LABELS[x.Label] || '', cash: Number(x.CountedCash), at: toIso(x.ClosedAt) })),
    receivedCash: pounds(recCash), expected: pounds(expected),
    counted: s.CountedCash == null ? null : Number(s.CountedCash), diff: s.CountedCash == null ? null : pounds(cents(s.CountedCash) - cents(s.ExpectedCash)),
    diffReason: s.DiffReason, note: s.CloseNote, handedTo: s.HandedTo ? { id: s.HandedTo, name: s.HandedToName } : null,
    receivedAt: toIso(s.ReceivedAt), receivedBy: s.ReceivedByName || null,
  };
}

export function shiftsRouter(db) {
  const r = router();

  // ورديتي + التسليمات اللي مستنياني
  r.get('/mine', async (req, res) => {
    const open = await db.one(db.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
    const hand = await db.query(`SELECT s.Id FROM Shifts s WHERE s.HandedTo = ? AND s.ReceivedAt IS NULL AND s.ClosedAt IS NOT NULL ORDER BY s.Id`, [req.user.id]);
    const receivers = await db.query("SELECT Id, FullName, Role FROM Users WHERE Active = 1 AND Role IN ('cashier','supervisor','manager') AND Id <> ? ORDER BY CASE Role WHEN 'cashier' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, FullName", [req.user.id]);
    const duty = await cashierOnDuty(db);
    res.json({
      shift: open ? await shiftSummary(db, open.Id) : null,
      handovers: await Promise.all(hand.map((h) => shiftSummary(db, h.Id))),
      receivers: receivers.map((u) => ({ id: u.Id, name: u.FullName, role: u.Role })),
      onDuty: duty ? { userId: duty.UserId, name: duty.FullName } : null,
      label: shiftLabel(), businessDate: businessDate(),
    });
  });

  // بداية وردية (للخزينة: من غيرها الاستقبال بيقبض بنفسه)
  r.post('/open', async (req, res) => {
    need(req.user, 'cash.collect');
    const id = await db.tx(async (t) => {
      const open = await t.one(t.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
      if (open) { await t.run('UPDATE Shifts SET Explicit = 1 WHERE Id = ?', [open.Id]); return open.Id; }
      const now = new Date();
      const x = await t.insert('Shifts', { UserId: req.user.id, OpenedAt: now, Label: shiftLabel(now), BusinessDate: businessDate(now), Explicit: 1 });
      await audit(t, req.user, 'shift.open', 'Shift', x, { now: { label: SHIFT_LABELS[shiftLabel(now)] } });
      return x;
    });
    res.status(201).json({ shift: await shiftSummary(db, id) });
  });

  // تقفيل ورديتي وتسليم الفلوس
  r.post('/mine/close', async (req, res) => {
    need(req.user, 'shift.close');
    const b = req.body || {};
    if (b.counted === '' || b.counted == null) throw bad('اكتب النقدية اللي معاك', { errors: { counted: 'اكتب المبلغ اللي في الدرج' } });
    const counted = parseMoney(b.counted, 'النقدية');
    const id = await db.tx(async (t) => {
      const open = await t.one(t.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
      if (!open) throw conflict('مفيش وردية مفتوحة');
      const sm = await shiftSummary(t, open.Id);
      const expected = cents(sm.expected);
      const diffReason = str(b.diffReason, 300);
      if (counted !== expected && (!diffReason || diffReason.length < 3)) throw bad('اكتب سبب الفرق', { errors: { diffReason: 'فيه فرق، اكتب سببه' } });
      let handedTo = null;
      if (counted > 0) {
        handedTo = intId(b.handedTo || 0, 'المستلم');
        const u = await t.one("SELECT Id FROM Users WHERE Id = ? AND Active = 1 AND Role IN ('cashier','supervisor','manager')", [handedTo]);
        if (!u || handedTo === req.user.id) throw bad('اختار هتسلّم الفلوس لمين', { errors: { handedTo: 'اختار المستلم' } });
      }
      const now = new Date();
      await t.run(`UPDATE Shifts SET ClosedAt = ?, ExpectedCash = ?, CountedCash = ?, CardTotal = ?, DiffReason = ?, CloseNote = ?, HandedTo = ?,
          ReceivedAt = ?, ReceivedBy = ? WHERE Id = ?`,
        [now, pounds(expected), pounds(counted), sm.card, counted !== expected ? diffReason : null, str(b.note, 300), handedTo,
          counted > 0 ? null : now, counted > 0 ? null : req.user.id, open.Id]);
      await postShiftSafe(t, req.user, open.Id);
      await audit(t, req.user, 'shift.close', 'Shift', open.Id, {
        now: { expected: pounds(expected), counted: pounds(counted), diff: pounds(counted - expected) }, note: diffReason,
      });
      return open.Id;
    });
    res.json({ shift: await shiftSummary(db, id) });
  });

  // استلام فلوس وردية
  r.post('/:id/receive', async (req, res) => {
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const s = await t.one('SELECT * FROM Shifts WHERE Id = ?', [id]);
      if (!s || s.HandedTo !== req.user.id) throw notFound('التسليم ده مش ليك');
      if (s.ReceivedAt) throw conflict('اتستلم قبل كده');
      // الفلوس بتدخل درج المستلم (لو بيقبض)، عشان تتحسب في تقفيله
      const mine = can(req.user, 'cash.collect') ? await currentShift(t, req.user) : null;
      await t.run('UPDATE Shifts SET ReceivedAt = ?, ReceivedBy = ?, ReceivedShiftId = ? WHERE Id = ? AND ReceivedAt IS NULL', [new Date(), req.user.id, mine, id]);
      await audit(t, req.user, 'shift.receive', 'Shift', id, { now: { cash: Number(s.CountedCash) } });
    });
    res.json({ shift: await shiftSummary(db, id) });
  });

  r.get('/:id', async (req, res) => {
    const id = intId(req.params.id);
    const s = await shiftSummary(db, id);
    if (s.user.id !== req.user.id && s.handedTo?.id !== req.user.id && !can(req.user, 'reports.treasury')) throw forbidden();
    res.json({ shift: s });
  });

  return r;
}

// ================= تقرير الخزينة =================
// ترتيب الأقسام وأسماءها من القوائم: أقسام الزيارة ثم الصيدلية ثم أنواع الدخول
const sectionOrder = () => [...Object.keys(VISIT_TYPES), 'pharmacy', ...Object.keys(ADM_TYPES)];
const sectionName = (k) => (k === 'pharmacy' ? 'الصيدلية' : VISIT_TYPES[k] || ADM_TYPES[k] || k);
const KIND_NAME = { payment: 'سداد', deposit: 'تأمين', final: 'سداد نهائي', return: 'مرتجع', refund: 'إلغاء' };

export async function treasuryReport(db, { date, shiftId }) {
  const shifts = shiftId
    ? await db.query('SELECT s.*, u.FullName FROM Shifts s JOIN Users u ON u.Id = s.UserId WHERE s.Id = ?', [shiftId])
    : await db.query('SELECT s.*, u.FullName FROM Shifts s JOIN Users u ON u.Id = s.UserId WHERE s.BusinessDate = ? ORDER BY s.OpenedAt', [date]);
  const ids = shifts.map((s) => s.Id);
  const rows = ids.length ? await db.query(
    `SELECT r.*, p.FullName AS PatientName, p.PatientNo, v.Type AS VisitType, a.Type AS AdmType, u.FullName AS ByName
       FROM Receipts r JOIN Patients p ON p.Id = r.PatientId JOIN Users u ON u.Id = r.CreatedBy
       LEFT JOIN Visits v ON v.Id = r.VisitId LEFT JOIN Admissions a ON a.Id = r.AdmissionId
      WHERE r.ShiftId IN (${ids.map(() => '?').join(',')}) ORDER BY r.Id`, ids) : [];
  const lineRows = rows.length ? await db.query(
    `SELECT ReceiptId, Description FROM ReceiptLines WHERE ReceiptId IN (${rows.map(() => '?').join(',')}) ORDER BY Id`, rows.map((x) => x.Id)) : [];
  const lines = new Map();
  for (const l of lineRows) { if (!lines.has(l.ReceiptId)) lines.set(l.ReceiptId, []); lines.get(l.ReceiptId).push(l.Description); }
  const shiftName = new Map(shifts.map((s) => [s.Id, `${SHIFT_LABELS[s.Label] || ''} · ${s.FullName}`]));
  const sections = new Map();
  const zero = () => ({ count: 0, cash: 0, card: 0, credit: 0, discount: 0, net: 0, out: 0 });
  const grand = zero();
  for (const x of rows) {
    const key = x.VisitType || x.AdmType || 'clinic';
    if (!sections.has(key)) sections.set(key, { key, name: sectionName(key), rows: [], totals: zero() });
    const sec = sections.get(key);
    const out = ['refund', 'return'].includes(x.Kind);
    const row = {
      id: x.Id, no: x.ReceiptNo, manualNo: x.ManualNo, kind: x.Kind, kindName: KIND_NAME[x.Kind], at: toIso(x.CreatedAt),
      patient: x.PatientName, patientNo: x.PatientNo,
      service: (lines.get(x.Id) || []).join('، ') || x.Note || x.Reason || '',
      cash: Number(x.Cash), card: Number(x.Card), credit: Number(x.Credit), discount: Number(x.Discount), net: Number(x.Net),
      by: x.ByName, shift: shiftName.get(x.ShiftId),
    };
    sec.rows.push(row);
    for (const tt of [sec.totals, grand]) {
      if (!out) tt.count++; else tt.out += -cents(x.Net);
      tt.cash += cents(x.Cash); tt.card += cents(x.Card); tt.credit += cents(x.Credit); tt.net += cents(x.Net);
      if (!out) tt.discount += cents(x.Discount);
    }
  }
  const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'count' ? v : pounds(v)]));
  const list = [...sections.values()].sort((a, b) => sectionOrder().indexOf(a.key) - sectionOrder().indexOf(b.key)).map((s) => ({ ...s, totals: fix(s.totals) }));
  return {
    date, shiftId: shiftId || null,
    shifts: shifts.map((s) => ({ id: s.Id, name: s.FullName, label: s.Label, labelName: SHIFT_LABELS[s.Label] || '', openedAt: toIso(s.OpenedAt), closedAt: toIso(s.ClosedAt), counted: s.CountedCash == null ? null : Number(s.CountedCash), expected: s.ExpectedCash == null ? null : Number(s.ExpectedCash) })),
    sections: list, totals: fix(grand), missingManual: rows.filter((x) => !x.ManualNo && cents(x.Net) !== 0).length,
  };
}

export function reportsRouter(db) {
  const r = router();

  r.get('/treasury', async (req, res) => {
    need(req.user, 'reports.treasury');
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : businessDate();
    const shiftId = req.query.shift ? intId(req.query.shift) : null;
    const rep = await treasuryReport(db, { date, shiftId });
    if (req.query.format !== 'xlsx') return res.json(rep);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('تقرير الخزينة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 2 }] });
    ws.columns = [
      { header: 'القسم', key: 'sec', width: 14 }, { header: 'إيصال', key: 'no', width: 9 }, { header: 'الإيصال اليدوي', key: 'manual', width: 13 },
      { header: 'الوقت', key: 'at', width: 17 }, { header: 'المريض', key: 'patient', width: 26 }, { header: 'الخدمة', key: 'service', width: 40 },
      { header: 'النوع', key: 'kind', width: 10 }, { header: 'نقدي', key: 'cash', width: 11 }, { header: 'فيزا', key: 'card', width: 11 },
      { header: 'آجل', key: 'credit', width: 11 }, { header: 'الصافي', key: 'net', width: 12 }, { header: 'الموظف', key: 'by', width: 18 },
    ];
    ws.spliceRows(1, 0, [`تقرير الخزينة · ${rep.date}${shiftId ? ' · وردية واحدة' : ''}`]);
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } };
    const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: R.tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));
    for (const s of rep.sections) {
      for (const x of s.rows) ws.addRow({ sec: s.name, no: x.no, manual: x.manualNo || '', at: fmt(x.at), patient: x.patient, service: x.service, kind: x.kindName, cash: x.cash, card: x.card, credit: x.credit, net: x.net, by: x.by });
      const tr = ws.addRow({ sec: `إجمالي ${s.name}`, cash: s.totals.cash, card: s.totals.card, credit: s.totals.credit, net: s.totals.net });
      tr.font = { bold: true }; tr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6EEE8' } };
    }
    const g = ws.addRow({ sec: 'الإجمالي الكلي', cash: rep.totals.cash, card: rep.totals.card, credit: rep.totals.credit, net: rep.totals.net });
    g.font = { bold: true, size: 12 };
    for (const k of ['cash', 'card', 'credit', 'net']) ws.getColumn(k).numFmt = R.money.xlsxFormat();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`تقرير-الخزينة-${rep.date}.xlsx`)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  // ورديات يوم
  r.get('/shifts', async (req, res) => {
    need(req.user, 'reports.treasury');
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : businessDate();
    const rows = await db.query('SELECT Id FROM Shifts WHERE BusinessDate = ? ORDER BY OpenedAt', [date]);
    res.json({ date, shifts: await Promise.all(rows.map((x) => shiftSummary(db, x.Id))) });
  });

  // الخصومات والآجل في فترة (المدير)
  r.get('/discounts', async (req, res) => {
    need(req.user, 'reports.shifts');
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : businessDate();
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : from;
    const rows = await db.query(
      `SELECT r.Id, r.ReceiptNo, r.CreatedAt, r.Discount, r.Credit, r.Net, r.DiscountReason, r.Note, p.FullName AS PatientName, p.PatientNo,
              u.FullName AS ByName, md.FullName AS DiscBy, mc.FullName AS CreditBy, r.VisitId, r.AdmissionId
         FROM Receipts r JOIN Shifts s ON s.Id = r.ShiftId JOIN Patients p ON p.Id = r.PatientId JOIN Users u ON u.Id = r.CreatedBy
         LEFT JOIN Users md ON md.Id = r.DiscountApprovedBy LEFT JOIN Users mc ON mc.Id = r.CreditApprovedBy
        WHERE s.BusinessDate >= ? AND s.BusinessDate <= ? AND r.Kind <> 'refund' AND r.ReversedByReceiptId IS NULL AND (r.Discount > 0 OR r.Credit > 0)
        ORDER BY r.Id`, [from, to]);
    const list = rows.map((x) => ({
      id: x.Id, no: x.ReceiptNo, at: toIso(x.CreatedAt), patient: x.PatientName, patientNo: x.PatientNo, by: x.ByName,
      discount: Number(x.Discount), discountReason: x.DiscountReason, discountBy: x.DiscBy, credit: Number(x.Credit), creditBy: x.CreditBy,
      note: x.Note, visitId: x.VisitId, admissionId: x.AdmissionId,
    }));
    res.json({ from, to, rows: list, totals: { discount: pounds(rows.reduce((a, x) => a + cents(x.Discount), 0)), credit: pounds(rows.reduce((a, x) => a + cents(x.Credit), 0)) } });
  });

  // مستحقات الأطباء في فترة (المدير)
  r.get('/doctors', async (req, res) => {
    need(req.user, 'reports.shifts');
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : businessDate();
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : from;
    const rows = await db.query(
      `SELECT d.Id, d.Name, d.Specialty, COUNT(*) AS N, SUM(e.BaseAmount) AS Base, SUM(e.Amount) AS Amt, SUM(e.PayerPart) AS PP
         FROM DoctorEarnings e JOIN Doctors d ON d.Id = e.DoctorId JOIN Receipts r ON r.Id = e.ReceiptId JOIN Shifts s ON s.Id = r.ShiftId
        WHERE s.BusinessDate >= ? AND s.BusinessDate <= ? GROUP BY d.Id, d.Name, d.Specialty ORDER BY SUM(e.Amount) DESC`, [from, to]);
    const list = rows.map((x) => ({ id: x.Id, name: x.Name, specialty: x.Specialty, count: Number(x.N), base: pounds(cents(x.Base)), amount: pounds(cents(x.Amt)), payerPart: pounds(cents(x.PP)), now: pounds(cents(x.Amt) - cents(x.PP)) }));
    res.json({ from, to, rows: list, totals: { amount: pounds(list.reduce((a, x) => a + cents(x.amount), 0)), payerPart: pounds(list.reduce((a, x) => a + cents(x.payerPart), 0)) } });
  });

  return r;
}
void cairoDate;
