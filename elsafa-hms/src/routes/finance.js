// الحسابات العامة: صرف مستحقات الأطباء (بالضريبة)، الموردين وفواتيرهم ودفعاتهم وشيكاتهم، المصروفات، الأقساط، إذن الصرف النقدي، وشاشة المدير
// أي دفع نقدي بيتعمل له «إذن صرف» والخزينة هي اللي بتصرفه، فبيتخصم من درج وردية اللي صرف
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, parseMoney, cairoDate, cairoDayRange } from '../lib/util.js';
import { toIso, toDateStr, toBool } from '../db/index.js';
import { businessDate } from '../lib/cashier.js';
import { currentShift } from './visits.js';
import { nextPeriod, periodName } from './claims.js';
import { R } from '../lib/runtime.js';
import { ledgerOn, post as jpost, reverseSource } from '../lib/ledger.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const VOUCHER_KINDS = { payout: 'مستحقات دكتور', expense: 'مصروف', supplier: 'دفعة مورد', installment: 'قسط' };
const METHODS = { bank: 'تحويل بنكي', cash: 'نقدي من الخزينة', cheque: 'شيك' };
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };
const addMonths = (d, n) => {
  const [y, m, x] = d.split('-').map(Number);
  const t = m - 1 + n, yy = y + Math.floor(t / 12), mm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(x, last)).padStart(2, '0')}`;
};
const dateOf = (v, label, required = true) => {
  const s = String(v ?? '').trim();
  if (!s && !required) return null;
  if (!DATE_RE.test(s)) throw bad(`${label} مش تاريخ صحيح`, { errors: { [label]: 'اكتب التاريخ صح' } });
  return s;
};
const money = (v, label) => {
  const c = parseMoney(v, label);
  if (c <= 0) throw bad(`${label} لازم يكون أكبر من صفر`);
  return c;
};

export async function setting(db, key, def) {
  const r = await db.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [key]);
  return r?.Value ?? def;
}
async function taxPct(db) {
  const v = Number(await setting(db, 'doctorTaxPct', '5'));
  return Number.isFinite(v) && v >= 0 && v < 100 ? v : 5;
}

// ---------- إذن الصرف ----------
async function makeVoucher(t, user, { kind, refId, payee, description, amount }) {
  const no = await t.nextNumber('voucher');
  const id = await t.insert('CashVouchers', {
    VoucherNo: no, Kind: kind, RefId: refId, Payee: String(payee).slice(0, 150), Description: String(description).slice(0, 300),
    Amount: pounds(amount), Status: 'pending', CreatedAt: new Date(), CreatedBy: user.id,
  });
  return { id, no };
}
/** إلغاء إذن صرف: المصدر بتاعه بيرجع لحالته */
async function voidSource(t, user, v, reason) {
  if (v.Kind === 'payout') {
    await t.run("UPDATE DoctorPayouts SET Status = 'void', VoidReason = ? WHERE Id = ?", [reason, v.RefId]);
    await reverseSource(t, user, 'payout_accrual', v.RefId, reason);
  }
  else if (v.Kind === 'expense') await t.run("UPDATE Expenses SET Status = 'void', RejectReason = ? WHERE Id = ?", [reason, v.RefId]);
  else if (v.Kind === 'supplier') await t.run("UPDATE SupplierPayments SET Status = 'void', VoidReason = ? WHERE Id = ?", [reason, v.RefId]);
  else if (v.Kind === 'installment') await t.run("UPDATE ObligationInstallments SET Status = 'due', PaidAt = NULL, PaidBy = NULL, Method = NULL, VoucherId = NULL WHERE Id = ?", [v.RefId]);
}
const voucherDto = (v) => ({
  id: v.Id, no: v.VoucherNo, kind: v.Kind, kindName: VOUCHER_KINDS[v.Kind], refId: v.RefId, payee: v.Payee, description: v.Description,
  amount: Number(v.Amount), status: v.Status, at: toIso(v.CreatedAt), by: v.ByName || null, paidAt: toIso(v.PaidAt), paidBy: v.PaidByName || null,
  shiftId: v.ShiftId, cancelReason: v.CancelReason,
});

// ---------- قيود مستحقات الأطباء ----------
// قيدين: اعتماد المستحق (مصروف أتعاب ← مستحقات أطباء + ضريبة مستحقة) وصرفه (مستحقات أطباء ← الخزينة). الحسابات من إعدادات الدفاتر
async function postAccrual(t, user, p, doctorName) {
  if (!(await ledgerOn(t))) return;
  const gross = cents(p.Gross), tax = cents(p.Tax), net = cents(p.Net);
  // أتعاب الدكاترة بتتقيّد على حساب عيادة الدكتور لو العيادة متربطة، وإلا على الحساب الإجمالي
  const cl = await t.one('SELECT d.ClinicId AS C FROM DoctorPayouts po JOIN Doctors d ON d.Id = po.DoctorId WHERE po.Id = ?', [p.Id]);
  const ck = cl?.C ? `doctor.expense.clinic.${cl.C}` : null;
  const expKey = ck && (await t.one('SELECT [Key] FROM AccountMap WHERE [Key] = ?', [ck])) ? ck : 'doctor.expense';
  const lines = [{ key: expKey, debit: gross, memo: doctorName }, { key: 'doctor.payable', credit: net, memo: doctorName }];
  if (tax > 0) lines.push({ key: 'doctor.tax', credit: tax, memo: `ضريبة ${doctorName}` });
  await jpost(t, user, { source: 'payout_accrual', sourceId: p.Id, description: `مستحقات ${doctorName} عن ${periodName(p.Period)} (صرف ${p.PayoutNo})`, lines });
}
async function postPayment(t, user, p, doctorName) {
  if (!(await ledgerOn(t))) return;
  const net = cents(p.Net);
  await jpost(t, user, { source: 'payout_pay', sourceId: p.Id, description: `صرف مستحقات ${doctorName} عن ${periodName(p.Period)} (صرف ${p.PayoutNo})`,
    lines: [{ key: 'doctor.payable', debit: net, memo: doctorName }, { key: 'cash.main', credit: net, memo: doctorName }] });
}

// ---------- قيود الموردين والمصروفات والأقساط ----------
const ENTRY = async (t, user, o) => { if (await ledgerOn(t)) await jpost(t, user, o); };
async function expenseAccountKey(t, categoryId) {
  const k = `expense.cat.${categoryId}`;
  return (await t.one('SELECT [Key] FROM AccountMap WHERE [Key] = ?', [k])) ? k : 'expense.default';
}
/** مصروف: نقدي بيتقيد عند صرف الإذن، وبنكي عند الاعتماد */
async function postExpense(t, user, e, credKey = null) {
  const cat = await t.one('SELECT Name FROM ExpenseCategories WHERE Id = ?', [e.CategoryId]);
  const amt = cents(e.Amount);
  await ENTRY(t, user, { date: toDateStr(e.ExpDate), source: 'expense', sourceId: e.Id, description: `مصروف ${e.ExpNo} · ${cat?.Name || ''}${e.Payee ? ' · ' + e.Payee : ''}`,
    lines: [{ key: await expenseAccountKey(t, e.CategoryId), debit: amt, memo: e.Note || null }, { key: credKey || (e.Method === 'bank' ? 'bank.main' : 'cash.main'), credit: amt }] });
}
async function postSupplierPayment(t, user, p, supplierName, stage) {
  const amt = cents(p.Amount);
  const date = toDateStr(p.PayDate);
  if (stage === 'clear') {
    return ENTRY(t, user, { date: businessDate(), source: 'supplier_cheque_clear', sourceId: p.Id, description: `صرف شيك ${p.ChequeNo || ''} · ${supplierName}`, lines: [{ key: 'cheques.payable', debit: amt }, { key: 'bank.main', credit: amt }] });
  }
  const cr = p.Method === 'cash' ? 'cash.main' : p.Method === 'bank' ? 'bank.main' : 'cheques.payable';
  return ENTRY(t, user, { date, source: 'supplier_pay', sourceId: p.Id, description: `دفعة مورد · ${supplierName}${p.Method === 'cheque' ? ' · شيك ' + (p.ChequeNo || '') : ''}`, lines: [{ key: 'supplier.payable', debit: amt, memo: supplierName }, { key: cr, credit: amt }] });
}
async function postInstallment(t, user, n, stage) {
  const amt = cents(n.Amount);
  if (stage === 'clear') return ENTRY(t, user, { date: businessDate(), source: 'installment_cheque_clear', sourceId: n.Id, description: `صرف شيك قسط ${n.No} · ${n.OName}`, lines: [{ key: 'cheques.payable', debit: amt }, { key: 'bank.main', credit: amt }] });
  const cr = n.Method === 'cash' ? 'cash.main' : n.Method === 'bank' ? 'bank.main' : 'cheques.payable';
  return ENTRY(t, user, { date: businessDate(), source: 'installment_pay', sourceId: n.Id, description: `سداد قسط ${n.No} · ${n.OName}`, lines: [{ key: 'oblig.payable', debit: amt }, { key: cr, credit: amt }] });
}

// ---------- مستحقات الأطباء ----------
async function payoutRows(db, period, doctorId = 0) {
  const cutoff = cairoDayRange(`${nextPeriod(period)}-01`).start;
  const pct = await taxPct(db);
  const rows = await db.query(
    `SELECT d.Id, d.Name, d.Specialty,
            COALESCE((SELECT SUM(e.Amount - CASE WHEN e.PayerReleased = 1 THEN 0 ELSE e.PayerPart END) FROM DoctorEarnings e WHERE e.DoctorId = d.Id AND e.CreatedAt < ?), 0) AS Eligible,
            COALESCE((SELECT SUM(e.PayerPart) FROM DoctorEarnings e WHERE e.DoctorId = d.Id AND e.PayerReleased = 0 AND e.CreatedAt < ?), 0) AS Pending,
            COALESCE((SELECT SUM(p.Gross) FROM DoctorPayouts p WHERE p.DoctorId = d.Id AND p.Status <> 'void'), 0) AS PaidBefore,
            (SELECT COUNT(*) FROM DoctorEarnings e WHERE e.DoctorId = d.Id AND e.CreatedAt < ?) AS N
       FROM Doctors d ${doctorId ? 'WHERE d.Id = ?' : ''} ORDER BY d.Name`, doctorId ? [cutoff, cutoff, cutoff, doctorId] : [cutoff, cutoff, cutoff]);
  return rows.map((x) => {
    const due = cents(x.Eligible) - cents(x.PaidBefore);
    const tax = due > 0 ? R.money.percent(due, pct) : 0;
    return { id: x.Id, name: x.Name, specialty: x.Specialty, count: Number(x.N), eligible: pounds(cents(x.Eligible)), paidBefore: pounds(cents(x.PaidBefore)), pending: pounds(cents(x.Pending)),
      gross: pounds(due), tax: pounds(tax), net: pounds(due - tax), taxPct: pct };
  }).filter((x) => x.count > 0 || x.paidBefore > 0);
}
const payoutDto = (p) => ({
  id: p.Id, no: p.PayoutNo, doctorId: p.DoctorId, doctor: p.DoctorName, specialty: p.Specialty, period: p.Period, periodName: periodName(p.Period),
  gross: Number(p.Gross), taxPct: Number(p.TaxPct), tax: Number(p.Tax), net: Number(p.Net), status: p.Status, note: p.Note,
  at: toIso(p.CreatedAt), by: p.ByName, paidAt: toIso(p.PaidAt), voidReason: p.VoidReason, voucherNo: p.VoucherNo || null,
  // المرحلة: pending = مستني الاعتماد · approved = عند الخزينة · paid · void
  stage: p.Status === 'void' ? 'void' : p.Status === 'paid' ? 'paid' : p.VoucherId ? 'approved' : 'pending',
  approvedAt: toIso(p.ApprovedAt), approvedBy: p.ApprovedByName || null,
  editedAt: toIso(p.EditedAt), editedBy: p.EditedByName || null, editNote: p.EditNote || null,
});
const PAYOUT_SQL = `SELECT p.*, d.Name AS DoctorName, d.Specialty, u.FullName AS ByName, v.VoucherNo, ua.FullName AS ApprovedByName, ue.FullName AS EditedByName
   FROM DoctorPayouts p JOIN Doctors d ON d.Id = p.DoctorId
   JOIN Users u ON u.Id = p.CreatedBy LEFT JOIN CashVouchers v ON v.Id = p.VoucherId LEFT JOIN Users ua ON ua.Id = p.ApprovedBy LEFT JOIN Users ue ON ue.Id = p.EditedBy`;
const approvalOn = async (db) => (await setting(db, 'payoutApproval', 'on')) !== 'off';
const payoutVoucherDesc = (period, pct) => `مستحقات ${periodName(period)} (بعد ضريبة ${pct}%)`;

// ---------- الموردين ----------
const SUP_PAID = "COALESCE((SELECT SUM(p.Amount) FROM SupplierPayments p WHERE p.InvoiceId = i.Id AND p.Status = 'ok'), 0)";
async function invoiceList(db, where, params) {
  const today = businessDate();
  const rows = await db.query(
    `SELECT i.*, s.Name AS SupplierName, ${SUP_PAID} AS Paid FROM SupplierInvoices i JOIN Suppliers s ON s.Id = i.SupplierId WHERE ${where} ORDER BY i.DueDate, i.Id`, params);
  return rows.map((i) => {
    const amount = cents(i.Amount), paid = cents(i.Paid), left = amount - paid, due = toDateStr(i.DueDate);
    const state = i.Status === 'void' ? 'void' : left <= 0 ? 'paid' : paid > 0 ? 'partial' : 'open';
    return { id: i.Id, no: i.InvNo, supplierId: i.SupplierId, supplier: i.SupplierName, docNo: i.DocNo, docDate: toDateStr(i.DocDate), dueDate: due, amount: pounds(amount), paid: pounds(paid), left: pounds(Math.max(left, 0)),
      state, overdue: state !== 'paid' && state !== 'void' && !!due && due < today, note: i.Note, purchaseId: i.PurchaseId };
  });
}
const chequeDto = (kind, x) => ({
  type: kind, id: x.Id, no: x.ChequeNo, bank: x.Bank, date: toDateStr(x.ChequeDate), amount: Number(x.Amount), payee: x.Payee, desc: x.Descr || null,
  cleared: !!x.ClearedAt, clearedAt: toIso(x.ClearedAt),
});
async function chequeList(db, state) {
  const sup = await db.query(
    `SELECT p.Id, p.ChequeNo, p.Bank, p.ChequeDate, p.Amount, p.ClearedAt, s.Name AS Payee, i.DocNo AS Descr FROM SupplierPayments p JOIN Suppliers s ON s.Id = p.SupplierId
       LEFT JOIN SupplierInvoices i ON i.Id = p.InvoiceId WHERE p.Method = 'cheque' AND p.Status = 'ok' AND p.ClearedAt ${state === 'cleared' ? 'IS NOT NULL' : 'IS NULL'}`);
  const ins = await db.query(
    `SELECT n.Id, n.ChequeNo, n.DueDate AS ChequeDate, n.Amount, n.ClearedAt, o.Name AS Payee, o.Party AS Descr, NULL AS Bank FROM ObligationInstallments n JOIN Obligations o ON o.Id = n.ObligationId
      WHERE n.Method = 'cheque' AND n.Status = 'paid' AND n.ClearedAt ${state === 'cleared' ? 'IS NOT NULL' : 'IS NULL'}`);
  return [...sup.map((x) => chequeDto('supplier', x)), ...ins.map((x) => chequeDto('installment', x))].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// ---------- الأقساط ----------
async function obligationList(db) {
  const rows = await db.query(
    `SELECT o.*, (SELECT COUNT(*) FROM ObligationInstallments n WHERE n.ObligationId = o.Id) AS N, COALESCE((SELECT SUM(n.Amount) FROM ObligationInstallments n WHERE n.ObligationId = o.Id), 0) AS Total,
       COALESCE((SELECT SUM(n.Amount) FROM ObligationInstallments n WHERE n.ObligationId = o.Id AND n.Status = 'paid'), 0) AS Paid,
       (SELECT COUNT(*) FROM ObligationInstallments n WHERE n.ObligationId = o.Id AND n.Status = 'paid') AS PaidN,
       (SELECT MIN(n.DueDate) FROM ObligationInstallments n WHERE n.ObligationId = o.Id AND n.Status = 'due') AS NextDue
       FROM Obligations o WHERE o.Active = 1 ORDER BY o.Id DESC`);
  const today = businessDate();
  return rows.map((o) => ({ id: o.Id, name: o.Name, party: o.Party, note: o.Note, count: Number(o.N), paidCount: Number(o.PaidN), total: Number(o.Total), paid: Number(o.Paid), left: pounds(cents(o.Total) - cents(o.Paid)),
    nextDue: toDateStr(o.NextDue), overdue: !!o.NextDue && toDateStr(o.NextDue) < today }));
}
async function installmentRows(db, obligationId) {
  const today = businessDate();
  const rows = await db.query('SELECT n.*, u.FullName AS ByName FROM ObligationInstallments n LEFT JOIN Users u ON u.Id = n.PaidBy WHERE n.ObligationId = ? ORDER BY n.No', [obligationId]);
  return rows.map((n) => ({ id: n.Id, no: n.No, dueDate: toDateStr(n.DueDate), amount: Number(n.Amount), status: n.Status, paidAt: toIso(n.PaidAt), by: n.ByName, method: n.Method, chequeNo: n.ChequeNo, cleared: !!n.ClearedAt,
    overdue: n.Status === 'due' && toDateStr(n.DueDate) < today }));
}

export default function financeRouter(db) {
  const r = router();
  r.use((req, res, next) => { if (!req.user) return res.status(401).json({ error: 'سجّل دخول الأول' }); next(); });
  const view = (req) => { if (!can(req.user, 'fin.view') && !can(req.user, 'fin.voucher')) throw forbidden(); };

  // ======== إعدادات ========
  r.get('/settings', async (req, res) => {
    view(req);
    res.json({ taxPct: await taxPct(db), payoutDay: Number(await setting(db, 'payoutDay', '10')) || 10, approval: await approvalOn(db), canEdit: can(req.user, 'settings.manage') });
  });
  r.put('/settings', async (req, res) => {
    need(req.user, 'settings.manage');
    const pct = Number(req.body?.taxPct), day = Number(req.body?.payoutDay);
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) throw bad('نسبة الضريبة من 0 لـ 99');
    if (!Number.isInteger(day) || day < 1 || day > 28) throw bad('يوم الصرف من 1 لـ 28');
    const appr = req.body?.approval === undefined ? null : (req.body.approval ? 'on' : 'off');
    await db.tx(async (t) => {
      for (const [k, v] of [['doctorTaxPct', String(pct)], ['payoutDay', String(day)], ...(appr ? [['payoutApproval', appr]] : [])]) {
        const ex = await t.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [k]);
        if (ex) await t.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [v, new Date(), req.user.id, k]);
        else await t.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
        await audit(t, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: v, note: { payoutApproval: 'اعتماد مستحقات الأطباء', doctorTaxPct: 'ضريبة مستحقات الأطباء %', payoutDay: 'يوم صرف مستحقات الأطباء' }[k] });
      }
    });
    res.json({ taxPct: pct, payoutDay: day, approval: appr ? appr === 'on' : await approvalOn(db) });
  });

  // ======== إذون الصرف النقدي (الخزينة) ========
  r.get('/vouchers', async (req, res) => {
    view(req);
    const st = ['pending', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await db.query(
      `SELECT v.*, u.FullName AS ByName, p.FullName AS PaidByName FROM CashVouchers v JOIN Users u ON u.Id = v.CreatedBy LEFT JOIN Users p ON p.Id = v.PaidBy
        WHERE v.Status = ? ORDER BY v.Id DESC`, [st]);
    const list = rows.slice(0, st === 'pending' ? 500 : 100).map(voucherDto);
    res.json({ vouchers: list, total: pounds(list.reduce((a, x) => a + cents(x.amount), 0)) });
  });
  r.get('/vouchers/count', async (req, res) => {
    view(req);
    const x = await db.one("SELECT COUNT(*) AS N, COALESCE(SUM(Amount), 0) AS S FROM CashVouchers WHERE Status = 'pending'");
    res.json({ count: Number(x.N), amount: Number(x.S) });
  });
  r.post('/vouchers/:id/pay', async (req, res) => {
    need(req.user, 'fin.voucher');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const v = await t.one('SELECT * FROM CashVouchers WHERE Id = ?', [id]);
      if (!v) throw notFound('الإذن مش موجود');
      if (v.Status !== 'pending') throw conflict('الإذن ده اتصرف أو اتلغى قبل كده');
      const shiftId = await currentShift(t, req.user);
      const n = await t.run("UPDATE CashVouchers SET Status = 'paid', PaidAt = ?, PaidBy = ?, ShiftId = ? WHERE Id = ? AND Status = 'pending'", [new Date(), req.user.id, shiftId, id]);
      if (n === 0) throw conflict('الإذن ده اتصرف من جهاز تاني');
      if (v.Kind === 'payout') {
        await t.run("UPDATE DoctorPayouts SET Status = 'paid', PaidAt = ? WHERE Id = ?", [new Date(), v.RefId]);
        const po = await t.one('SELECT p.*, d.Name AS DoctorName FROM DoctorPayouts p JOIN Doctors d ON d.Id = p.DoctorId WHERE p.Id = ?', [v.RefId]);
        if (po) await postPayment(t, req.user, po, po.DoctorName);
      } else if (v.Kind === 'expense') {
        const e = await t.one('SELECT * FROM Expenses WHERE Id = ?', [v.RefId]);
        if (e) await postExpense(t, req.user, e);
      } else if (v.Kind === 'supplier') {
        const p = await t.one('SELECT p.*, s.Name AS SName FROM SupplierPayments p JOIN Suppliers s ON s.Id = p.SupplierId WHERE p.Id = ?', [v.RefId]);
        if (p) await postSupplierPayment(t, req.user, p, p.SName);
      } else if (v.Kind === 'installment') {
        const n = await t.one('SELECT n.*, o.Name AS OName FROM ObligationInstallments n JOIN Obligations o ON o.Id = n.ObligationId WHERE n.Id = ?', [v.RefId]);
        if (n) await postInstallment(t, req.user, n);
      }
      await audit(t, req.user, 'voucher.pay', 'CashVoucher', id, { now: { no: v.VoucherNo, amount: Number(v.Amount), payee: v.Payee, shiftId } });
    });
    res.json({ ok: true });
  });
  r.post('/vouchers/:id/cancel', async (req, res) => {
    if (!can(req.user, 'fin.voucher') && !can(req.user, 'fin.payout')) throw forbidden();
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const v = await t.one('SELECT * FROM CashVouchers WHERE Id = ?', [id]);
      if (!v) throw notFound('الإذن مش موجود');
      if (v.Status !== 'pending') throw conflict('الإذن ده اتصرف أو اتلغى قبل كده');
      await t.run("UPDATE CashVouchers SET Status = 'cancelled', CancelReason = ? WHERE Id = ?", [reason, id]);
      await voidSource(t, req.user, v, reason);
      await audit(t, req.user, 'voucher.cancel', 'CashVoucher', id, { now: { no: v.VoucherNo, kind: v.Kind, amount: Number(v.Amount) }, note: reason });
    });
    res.json({ ok: true });
  });

  // ======== مستحقات الأطباء ========
  r.get('/payouts/prepare', async (req, res) => {
    view(req);
    const day = businessDate();
    const period = PERIOD_RE.test(req.query.period || '') ? req.query.period : (() => { const [y, m] = day.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
    const payoutDay = Number(await setting(db, 'payoutDay', '10')) || 10;
    const rows = await payoutRows(db, period);
    const sum = (k) => pounds(rows.filter((x) => x.gross > 0).reduce((a, x) => a + cents(x[k]), 0));
    const early = day < `${nextPeriod(period)}-${String(payoutDay).padStart(2, '0')}`;
    res.json({ period, periodName: periodName(period), payoutDay, early, approval: await approvalOn(db), taxPct: await taxPct(db), rows, totals: { gross: sum('gross'), tax: sum('tax'), net: sum('net') } });
  });
  r.post('/payouts', async (req, res) => {
    need(req.user, 'fin.payout');
    const b = req.body || {};
    if (!PERIOD_RE.test(b.period || '')) throw bad('اختار الشهر');
    const ids = [...new Set((Array.isArray(b.doctorIds) ? b.doctorIds : []).map(Number).filter(Boolean))];
    if (!ids.length) throw bad('اختار دكتور واحد على الأقل');
    const cutoff = cairoDayRange(`${nextPeriod(b.period)}-01`).start;
    const created = await db.tx(async (t) => {
      const pct = await taxPct(t);
      const needsApproval = await approvalOn(t);
      const out = [];
      for (const did of ids) {
        const row = (await payoutRows(t, b.period, did))[0];
        if (!row || row.gross <= 0) continue;
        const gross = cents(row.gross), tax = R.money.percent(gross, pct), net = gross - tax;
        const no = await t.nextNumber('payout');
        const pid = await t.insert('DoctorPayouts', {
          PayoutNo: no, DoctorId: did, Period: b.period, CutoffAt: cutoff, Gross: pounds(gross), TaxPct: pct, Tax: pounds(tax), Net: pounds(net), Status: 'issued',
          Note: str(b.note, 300), CreatedAt: new Date(), CreatedBy: req.user.id,
        });
        // الاعتماد شغّال: الإذن مستني المدير المالي ومفيش إذن صرف للخزينة لسه
        if (!needsApproval) {
          const v = await makeVoucher(t, req.user, { kind: 'payout', refId: pid, payee: row.name, description: payoutVoucherDesc(b.period, pct), amount: net });
          await t.run('UPDATE DoctorPayouts SET VoucherId = ? WHERE Id = ?', [v.id, pid]);
          await postAccrual(t, req.user, { Id: pid, Gross: pounds(gross), Tax: pounds(tax), Net: pounds(net), Period: b.period, PayoutNo: no }, row.name);
        }
        await audit(t, req.user, 'payout.create', 'DoctorPayout', pid, { now: { no, doctor: row.name, period: b.period, gross: pounds(gross), tax: pounds(tax), net: pounds(net), needsApproval } });
        out.push(pid);
      }
      if (!out.length) throw bad('مفيش مستحقات تتصرف للدكاترة المختارين');
      return out;
    });
    const rows = await db.query(`${PAYOUT_SQL} WHERE p.Id IN (${created.map(() => '?').join(',')}) ORDER BY p.Id`, created);
    res.status(201).json({ payouts: rows.map(payoutDto) });
  });
  r.get('/payouts', async (req, res) => {
    view(req);
    const where = [], params = [];
    if (PERIOD_RE.test(req.query.period || '')) { where.push('p.Period = ?'); params.push(req.query.period); }
    if (['issued', 'paid', 'void'].includes(req.query.status)) { where.push('p.Status = ?'); params.push(req.query.status); }
    if (Number(req.query.doctorId)) { where.push('p.DoctorId = ?'); params.push(Number(req.query.doctorId)); }
    const rows = await db.query(`${PAYOUT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.Id DESC`, params);
    res.json({ payouts: rows.slice(0, 300).map(payoutDto) });
  });
  r.post('/payouts/:id/approve', async (req, res) => {
    need(req.user, 'fin.approve');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const p = await t.one('SELECT p.*, d.Name AS DoctorName FROM DoctorPayouts p JOIN Doctors d ON d.Id = p.DoctorId WHERE p.Id = ?', [id]);
      if (!p) throw notFound('الصرف مش موجود');
      if (p.Status !== 'issued' || p.VoucherId) throw conflict('الصرف ده مش مستني اعتماد');
      // فصل المهام: اللي استخرج ما يعتمدش لنفسه (المدير العام مستثنى)
      if (p.CreatedBy === req.user.id && !can(req.user, '*')) throw forbidden('اللي استخرج المستحق ما يقدرش يعتمده. لازم مدير مالي تاني');
      const v = await makeVoucher(t, req.user, { kind: 'payout', refId: id, payee: p.DoctorName, description: payoutVoucherDesc(p.Period, Number(p.TaxPct)), amount: cents(p.Net) });
      await t.run('UPDATE DoctorPayouts SET VoucherId = ?, ApprovedAt = ?, ApprovedBy = ? WHERE Id = ?', [v.id, new Date(), req.user.id, id]);
      await postAccrual(t, req.user, p, p.DoctorName);
      await audit(t, req.user, 'payout.approve', 'DoctorPayout', id, { now: { no: p.PayoutNo, doctor: p.DoctorName, net: Number(p.Net) } });
    });
    res.json({ ok: true });
  });
  // تعديل المستحق (المدير أو من عنده fin.payoutEdit) قبل الصرف الفعلي: بيتعدّل الإذن لو اتعمل. بعد الصرف التصحيح بيتم في الصرف اللي بعده
  r.put('/payouts/:id', async (req, res) => {
    need(req.user, 'fin.payoutEdit');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب التعديل');
    const gross = cents(req.body?.gross);
    if (!(gross > 0)) throw bad('المستحق لازم يكون أكبر من صفر');
    await db.tx(async (t) => {
      const p = await t.one('SELECT p.*, d.Name AS DoctorName FROM DoctorPayouts p JOIN Doctors d ON d.Id = p.DoctorId WHERE p.Id = ?', [id]);
      if (!p) throw notFound('الصرف مش موجود');
      if (p.Status === 'paid') throw conflict('الصرف ده اتصرف فعلًا من الخزينة. صحّح الفرق في الصرف اللي بعده');
      if (p.Status !== 'issued') throw conflict('الصرف ده اتلغى');
      const pct = req.body?.taxPct === undefined || req.body.taxPct === '' ? Number(p.TaxPct) : Number(req.body.taxPct);
      if (!Number.isFinite(pct) || pct < 0 || pct >= 100) throw bad('نسبة الضريبة من 0 لـ 99');
      const tax = R.money.percent(gross, pct), net = gross - tax;
      await t.run('UPDATE DoctorPayouts SET Gross = ?, TaxPct = ?, Tax = ?, Net = ?, EditedAt = ?, EditedBy = ?, EditNote = ? WHERE Id = ?',
        [pounds(gross), pct, pounds(tax), pounds(net), new Date(), req.user.id, reason, id]);
      if (p.VoucherId) {
        const n = await t.run("UPDATE CashVouchers SET Amount = ?, Description = ? WHERE Id = ? AND Status = 'pending'", [pounds(net), payoutVoucherDesc(p.Period, pct), p.VoucherId]);
        if (!n) throw conflict('إذن الصرف اتصرف أو اتلغى. حدّث الصفحة');
      }
      if (p.VoucherId) {
        // القيد بتاع الاعتماد بيتعكس ويتسجل من جديد بالمبالغ المعدّلة
        await reverseSource(t, req.user, 'payout_accrual', id, `تعديل المستحق: ${reason}`);
        await postAccrual(t, req.user, { Id: id, Gross: pounds(gross), Tax: pounds(tax), Net: pounds(net), Period: p.Period, PayoutNo: p.PayoutNo }, p.DoctorName);
      }
      await audit(t, req.user, 'payout.edit', 'DoctorPayout', id, { old: { gross: Number(p.Gross), taxPct: Number(p.TaxPct), net: Number(p.Net) }, now: { no: p.PayoutNo, gross: pounds(gross), taxPct: pct, net: pounds(net) }, note: reason });
    });
    const row = (await db.query(`${PAYOUT_SQL} WHERE p.Id = ?`, [id]))[0];
    res.json({ payout: payoutDto(row) });
  });
  r.post('/payouts/:id/void', async (req, res) => {
    need(req.user, 'fin.payout');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const p = await t.one('SELECT * FROM DoctorPayouts WHERE Id = ?', [id]);
      if (!p) throw notFound('الصرف مش موجود');
      if (p.Status !== 'issued') throw conflict('الصرف ده اتصرف فعلًا أو اتلغى. أي تصحيح بيتعمل في الصرف اللي بعده');
      await t.run("UPDATE CashVouchers SET Status = 'cancelled', CancelReason = ? WHERE Id = ? AND Status = 'pending'", [reason, p.VoucherId]);
      await t.run("UPDATE DoctorPayouts SET Status = 'void', VoidReason = ? WHERE Id = ?", [reason, id]);
      await reverseSource(t, req.user, 'payout_accrual', id, reason);
      await audit(t, req.user, 'payout.void', 'DoctorPayout', id, { now: { no: p.PayoutNo }, note: reason });
    });
    res.json({ ok: true });
  });
  // نصيب الشركات من أتعاب الدكاترة (مستحق بعد التحصيل) + تحريره
  r.get('/payouts/pending-payer', async (req, res) => {
    view(req);
    const rows = await db.query(
      `SELECT x.DoctorId, x.PayerId, SUM(x.PP) AS PP, COUNT(*) AS N FROM (
          SELECT e.DoctorId, e.PayerPart AS PP, v.PayerId AS PayerId FROM DoctorEarnings e JOIN VisitItems vi ON vi.Id = e.VisitItemId JOIN Visits v ON v.Id = vi.VisitId
           WHERE e.PayerReleased = 0 AND e.PayerPart <> 0
          UNION ALL
          SELECT e.DoctorId, e.PayerPart, a.PayerId FROM DoctorEarnings e JOIN AdmissionItems ai ON ai.Id = e.AdmissionItemId JOIN Admissions a ON a.Id = ai.AdmissionId
           WHERE e.PayerReleased = 0 AND e.PayerPart <> 0) x GROUP BY x.DoctorId, x.PayerId`);
    const docs = Object.fromEntries((await db.query('SELECT Id, Name FROM Doctors')).map((d) => [d.Id, d.Name]));
    const payers = Object.fromEntries((await db.query('SELECT Id, Name FROM Payers')).map((d) => [d.Id, d.Name]));
    res.json({ rows: rows.filter((x) => cents(x.PP) !== 0).map((x) => ({ doctorId: x.DoctorId, doctor: docs[x.DoctorId], payerId: x.PayerId, payer: payers[x.PayerId] || '—', amount: pounds(cents(x.PP)), count: Number(x.N) })) });
  });
  r.post('/payouts/release', async (req, res) => {
    need(req.user, 'fin.payout');
    const doctorId = intId(req.body?.doctorId, 'الدكتور'), payerId = intId(req.body?.payerId, 'الجهة');
    const n = await db.tx(async (t) => {
      const a = await t.run(`UPDATE DoctorEarnings SET PayerReleased = 1 WHERE DoctorId = ? AND PayerReleased = 0 AND PayerPart <> 0 AND VisitItemId IN
         (SELECT vi.Id FROM VisitItems vi JOIN Visits v ON v.Id = vi.VisitId WHERE v.PayerId = ?)`, [doctorId, payerId]);
      const b = await t.run(`UPDATE DoctorEarnings SET PayerReleased = 1 WHERE DoctorId = ? AND PayerReleased = 0 AND PayerPart <> 0 AND AdmissionItemId IN
         (SELECT ai.Id FROM AdmissionItems ai JOIN Admissions a ON a.Id = ai.AdmissionId WHERE a.PayerId = ?)`, [doctorId, payerId]);
      await audit(t, req.user, 'payout.release', 'Doctor', doctorId, { now: { payerId, rows: a + b }, note: 'تحرير نصيب الشركة بعد التحصيل' });
      return a + b;
    });
    res.json({ released: n });
  });

  // ======== الموردين ========
  r.get('/suppliers', async (req, res) => {
    view(req);
    const rows = await db.query(
      `SELECT s.*, COALESCE((SELECT SUM(i.Amount) FROM SupplierInvoices i WHERE i.SupplierId = s.Id AND i.Status = 'open'), 0) AS Inv2,
              COALESCE((SELECT SUM(p.Amount) FROM SupplierPayments p WHERE p.SupplierId = s.Id AND p.Status = 'ok'), 0) AS Paid,
              (SELECT MIN(i.DueDate) FROM SupplierInvoices i WHERE i.SupplierId = s.Id AND i.Status = 'open' AND ${SUP_PAID} < i.Amount) AS NextDue
         FROM Suppliers s WHERE s.Active = 1 ORDER BY s.Name`);
    const today = businessDate();
    res.json({ suppliers: rows.map((s) => ({ id: s.Id, name: s.Name, phone: s.Phone, note: s.Note, invoiced: Number(s.Inv2), paid: Number(s.Paid), balance: pounds(cents(s.Inv2) - cents(s.Paid)), nextDue: toDateStr(s.NextDue), overdue: !!s.NextDue && toDateStr(s.NextDue) < today })) });
  });
  r.post('/suppliers', async (req, res) => {
    need(req.user, 'fin.supplier');
    const name = str(req.body?.name, 150);
    if (!name || name.length < 2) throw bad('اكتب اسم المورد', { errors: { name: 'اكتب اسم المورد' } });
    if (await db.one('SELECT Id FROM Suppliers WHERE Name = ?', [name])) throw conflict('المورد ده موجود', { errors: { name: 'الاسم ده موجود قبل كده' } });
    const id = await db.tx(async (t) => {
      const x = await t.insert('Suppliers', { Name: name, Phone: str(req.body?.phone, 40), Note: str(req.body?.note, 300), Active: 1, CreatedAt: new Date() });
      await audit(t, req.user, 'supplier.create', 'Supplier', x, { now: { name } });
      return x;
    });
    res.status(201).json({ id });
  });
  r.put('/suppliers/:id', async (req, res) => {
    need(req.user, 'fin.supplier');
    const id = intId(req.params.id);
    const name = str(req.body?.name, 150);
    if (!name || name.length < 2) throw bad('اكتب اسم المورد');
    const dup = await db.one('SELECT Id FROM Suppliers WHERE Name = ? AND Id <> ?', [name, id]);
    if (dup) throw conflict('فيه مورد تاني بنفس الاسم');
    await db.tx(async (t) => {
      const old = await t.one('SELECT * FROM Suppliers WHERE Id = ?', [id]);
      if (!old) throw notFound('المورد مش موجود');
      await t.run('UPDATE Suppliers SET Name = ?, Phone = ?, Note = ? WHERE Id = ?', [name, str(req.body?.phone, 40), str(req.body?.note, 300), id]);
      await audit(t, req.user, 'supplier.update', 'Supplier', id, { old: { name: old.Name, phone: old.Phone }, now: { name, phone: str(req.body?.phone, 40) } });
    });
    res.json({ ok: true });
  });
  r.get('/suppliers/:id', async (req, res) => {
    view(req);
    const id = intId(req.params.id);
    const s = await db.one('SELECT * FROM Suppliers WHERE Id = ?', [id]);
    if (!s) throw notFound('المورد مش موجود');
    const invoices = await invoiceList(db, 'i.SupplierId = ?', [id]);
    const pays = await db.query(
      `SELECT p.*, i.DocNo, i.InvNo, u.FullName AS ByName, v.VoucherNo, v.Status AS VStatus FROM SupplierPayments p LEFT JOIN SupplierInvoices i ON i.Id = p.InvoiceId JOIN Users u ON u.Id = p.CreatedBy
         LEFT JOIN CashVouchers v ON v.Id = p.VoucherId WHERE p.SupplierId = ? ORDER BY p.Id DESC`, [id]);
    const live = invoices.filter((i) => i.state !== 'void');
    const paidAll = pays.filter((p) => p.Status === 'ok').reduce((a, p) => a + cents(p.Amount), 0);
    res.json({
      supplier: { id: s.Id, name: s.Name, phone: s.Phone, note: s.Note }, invoices,
      payments: pays.map((p) => ({ id: p.Id, method: p.Method, methodName: METHODS[p.Method], amount: Number(p.Amount), date: toDateStr(p.PayDate), invoiceId: p.InvoiceId, invNo: p.InvNo, docNo: p.DocNo, chequeNo: p.ChequeNo, chequeDate: toDateStr(p.ChequeDate), bank: p.Bank,
        cleared: !!p.ClearedAt, status: p.Status, voidReason: p.VoidReason, note: p.Note, by: p.ByName, voucherNo: p.VoucherNo, voucherStatus: p.VStatus })),
      totals: { invoiced: pounds(live.reduce((a, i) => a + cents(i.amount), 0)), paid: pounds(paidAll), balance: pounds(live.reduce((a, i) => a + cents(i.amount), 0) - paidAll) },
    });
  });
  // استلامات المخزن اللي لسه ما اتعملش لها فاتورة
  r.get('/purchases/unbilled', async (req, res) => {
    view(req);
    const rows = await db.query(
      `SELECT p.Id, p.PurchaseNo, p.Supplier, p.InvoiceNo, p.InvoiceDate, p.Total, p.CreatedAt, st.Name AS StoreName FROM Purchases p JOIN Stores st ON st.Id = p.StoreId
        WHERE p.Kind = 'supplier' AND NOT EXISTS (SELECT 1 FROM SupplierInvoices i WHERE i.PurchaseId = p.Id AND i.Status = 'open') ORDER BY p.Id DESC`);
    res.json({ purchases: rows.slice(0, 100).map((p) => ({ id: p.Id, no: p.PurchaseNo, supplier: p.Supplier, docNo: p.InvoiceNo, docDate: toDateStr(p.InvoiceDate) || cairoDate(new Date(p.CreatedAt)), total: Number(p.Total), store: p.StoreName })) });
  });
  r.get('/invoices', async (req, res) => {
    view(req);
    const st = req.query.state;
    let list = await invoiceList(db, "i.Status = 'open'", []);
    if (st === 'unpaid') list = list.filter((i) => i.state !== 'paid');
    else if (st === 'overdue') list = list.filter((i) => i.overdue);
    res.json({ invoices: list, left: pounds(list.reduce((a, i) => a + cents(i.left), 0)) });
  });
  r.post('/invoices', async (req, res) => {
    need(req.user, 'fin.supplier');
    const b = req.body || {};
    const amount = money(b.amount, 'مبلغ الفاتورة');
    const docDate = dateOf(b.docDate, 'تاريخ الفاتورة');
    const dueDate = dateOf(b.dueDate, 'ميعاد السداد', false);
    if (dueDate && dueDate < docDate) throw bad('ميعاد السداد قبل تاريخ الفاتورة');
    const id = await db.tx(async (t) => {
      let sid = Number(b.supplierId) || 0;
      if (!sid) {
        const name = str(b.supplierName, 150);
        if (!name) throw bad('اختار المورد', { errors: { supplierId: 'اختار المورد' } });
        const ex = await t.one('SELECT Id FROM Suppliers WHERE Name = ?', [name]);
        sid = ex ? ex.Id : await t.insert('Suppliers', { Name: name, Active: 1, CreatedAt: new Date() });
      } else if (!(await t.one('SELECT Id FROM Suppliers WHERE Id = ?', [sid]))) throw bad('المورد مش موجود');
      const pid = Number(b.purchaseId) || null;
      if (pid) {
        const p = await t.one('SELECT Id FROM Purchases WHERE Id = ?', [pid]);
        if (!p) throw bad('الاستلام مش موجود');
        if (await t.one("SELECT Id FROM SupplierInvoices WHERE PurchaseId = ? AND Status = 'open'", [pid])) throw conflict('الاستلام ده اتعمل له فاتورة قبل كده');
      }
      const no = await t.nextNumber('supinv');
      const x = await t.insert('SupplierInvoices', { InvNo: no, SupplierId: sid, PurchaseId: pid, DocNo: str(b.docNo, 40), DocDate: docDate, DueDate: dueDate, Amount: pounds(amount), Note: str(b.note, 300), Status: 'open', CreatedAt: new Date(), CreatedBy: req.user.id });
      const sup = await t.one('SELECT Name FROM Suppliers WHERE Id = ?', [sid]);
      await ENTRY(t, req.user, { date: docDate, source: 'supplier_invoice', sourceId: x, description: `فاتورة مورد ${no} · ${sup?.Name || ''}${b.docNo ? ' · ' + str(b.docNo, 40) : ''}`,
        lines: [{ key: 'supplier.expense', debit: amount, memo: sup?.Name }, { key: 'supplier.payable', credit: amount, memo: sup?.Name }] });
      await audit(t, req.user, 'supplier.invoice', 'SupplierInvoice', x, { now: { no, supplierId: sid, amount: pounds(amount), dueDate } });
      return x;
    });
    res.status(201).json({ id });
  });
  r.post('/invoices/:id/void', async (req, res) => {
    need(req.user, 'fin.supplier');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const i = await t.one('SELECT * FROM SupplierInvoices WHERE Id = ?', [id]);
      if (!i || i.Status === 'void') throw notFound('الفاتورة مش موجودة');
      if (await t.one("SELECT Id FROM SupplierPayments WHERE InvoiceId = ? AND Status = 'ok'", [id])) throw conflict('عليها دفعات. الغي الدفعات الأول');
      await t.run("UPDATE SupplierInvoices SET Status = 'void', VoidReason = ? WHERE Id = ?", [reason, id]);
      await reverseSource(t, req.user, 'supplier_invoice', id, reason);
      await audit(t, req.user, 'supplier.invoice.void', 'SupplierInvoice', id, { now: { no: i.InvNo }, note: reason });
    });
    res.json({ ok: true });
  });
  r.post('/payments', async (req, res) => {
    need(req.user, 'fin.supplier');
    const b = req.body || {};
    const method = String(b.method || '');
    if (!METHODS[method]) throw bad('اختار طريقة الدفع');
    const amount = money(b.amount, 'المبلغ');
    const payDate = dateOf(b.payDate || businessDate(), 'تاريخ الدفع');
    const id = await db.tx(async (t) => {
      let sid = Number(b.supplierId) || 0, invId = Number(b.invoiceId) || null;
      if (invId) {
        const i = await t.one(`SELECT i.*, ${SUP_PAID} AS Paid FROM SupplierInvoices i WHERE i.Id = ?`, [invId]);
        if (!i || i.Status !== 'open') throw bad('الفاتورة مش موجودة');
        sid = i.SupplierId;
        const left = cents(i.Amount) - cents(i.Paid);
        if (amount > left) throw bad(`المتبقي على الفاتورة ${pounds(left)} بس`, { errors: { amount: 'أكبر من المتبقي' } });
      }
      const s = await t.one('SELECT Id, Name FROM Suppliers WHERE Id = ?', [sid]);
      if (!s) throw bad('اختار المورد');
      let chequeNo = null, chequeDate = null;
      if (method === 'cheque') {
        chequeNo = str(b.chequeNo, 40);
        if (!chequeNo) throw bad('اكتب رقم الشيك', { errors: { chequeNo: 'اكتب رقم الشيك' } });
        chequeDate = dateOf(b.chequeDate, 'تاريخ استحقاق الشيك');
      }
      const pid = await t.insert('SupplierPayments', {
        SupplierId: sid, InvoiceId: invId, Method: method, Amount: pounds(amount), PayDate: payDate, ChequeNo: chequeNo, ChequeDate: chequeDate, Bank: str(b.bank, 80),
        Status: 'ok', Note: str(b.note, 300), CreatedAt: new Date(), CreatedBy: req.user.id,
      });
      if (method === 'cash') {
        const v = await makeVoucher(t, req.user, { kind: 'supplier', refId: pid, payee: s.Name, description: `دفعة مورد${invId ? ' · فاتورة ' + (b.docNo || invId) : ' على الحساب'}`, amount });
        await t.run('UPDATE SupplierPayments SET VoucherId = ? WHERE Id = ?', [v.id, pid]);
      } else await postSupplierPayment(t, req.user, { Id: pid, Amount: pounds(amount), PayDate: payDate, Method: method, ChequeNo: chequeNo }, s.Name);
      await audit(t, req.user, 'supplier.pay', 'SupplierPayment', pid, { now: { supplier: s.Name, method, amount: pounds(amount), invoiceId: invId, chequeNo } });
      return pid;
    });
    res.status(201).json({ id });
  });
  r.post('/payments/:id/void', async (req, res) => {
    need(req.user, 'fin.supplier');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const p = await t.one('SELECT * FROM SupplierPayments WHERE Id = ?', [id]);
      if (!p || p.Status !== 'ok') throw notFound('الدفعة مش موجودة');
      if (p.ClearedAt) throw conflict('الشيك اتصرف. مينفعش يتلغى');
      if (p.VoucherId) {
        const v = await t.one('SELECT Status FROM CashVouchers WHERE Id = ?', [p.VoucherId]);
        if (v?.Status === 'paid') throw conflict('الفلوس اتصرفت من الخزينة. مينفعش يتلغى');
        await t.run("UPDATE CashVouchers SET Status = 'cancelled', CancelReason = ? WHERE Id = ?", [reason, p.VoucherId]);
      }
      await t.run("UPDATE SupplierPayments SET Status = 'void', VoidReason = ? WHERE Id = ?", [reason, id]);
      await reverseSource(t, req.user, 'supplier_pay', id, reason);
      await audit(t, req.user, 'supplier.pay.void', 'SupplierPayment', id, { now: { amount: Number(p.Amount) }, note: reason });
    });
    res.json({ ok: true });
  });

  // ======== الشيكات المستحقة (اللي علينا) ========
  r.get('/cheques', async (req, res) => {
    view(req);
    const state = req.query.state === 'cleared' ? 'cleared' : 'due';
    const list = await chequeList(db, state);
    const today = businessDate();
    res.json({ cheques: list.map((c) => ({ ...c, overdue: !c.cleared && c.date < today, soon: !c.cleared && c.date >= today && c.date <= addDays(today, 7) })), total: pounds(list.reduce((a, c) => a + cents(c.amount), 0)) });
  });
  r.post('/cheques/clear', async (req, res) => {
    if (!can(req.user, 'fin.supplier') && !can(req.user, 'fin.oblig')) throw forbidden();
    const type = req.body?.type, id = intId(req.body?.id);
    await db.tx(async (t) => {
      const tbl = type === 'supplier' ? 'SupplierPayments' : type === 'installment' ? 'ObligationInstallments' : null;
      if (!tbl) throw bad('نوع الشيك غلط');
      const n = await t.run(`UPDATE ${tbl} SET ClearedAt = ? WHERE Id = ? AND Method = 'cheque' AND ClearedAt IS NULL`, [new Date(), id]);
      if (!n) throw conflict('الشيك اتصرف قبل كده أو مش موجود');
      if (type === 'supplier') {
        const p = await t.one('SELECT p.*, s.Name AS SName FROM SupplierPayments p JOIN Suppliers s ON s.Id = p.SupplierId WHERE p.Id = ?', [id]);
        await postSupplierPayment(t, req.user, p, p.SName, 'clear');
      } else {
        const x = await t.one('SELECT n.*, o.Name AS OName FROM ObligationInstallments n JOIN Obligations o ON o.Id = n.ObligationId WHERE n.Id = ?', [id]);
        await postInstallment(t, req.user, x, 'clear');
      }
      await audit(t, req.user, 'cheque.clear', tbl, id, { note: 'اتصرف من البنك' });
    });
    res.json({ ok: true });
  });

  // ======== المصروفات ========
  r.get('/expense-categories', async (req, res) => {
    view(req);
    const rows = await db.query('SELECT * FROM ExpenseCategories WHERE Active = 1 ORDER BY SortOrder, Id');
    res.json({ categories: rows.map((c) => ({ id: c.Id, name: c.Name })) });
  });
  r.post('/expense-categories', async (req, res) => {
    need(req.user, 'settings.manage');
    const name = str(req.body?.name, 80);
    if (!name || name.length < 2) throw bad('اكتب اسم البند');
    if (await db.one('SELECT Id FROM ExpenseCategories WHERE Name = ?', [name])) throw conflict('البند ده موجود');
    const id = await db.tx(async (t) => {
      const x = await t.insert('ExpenseCategories', { Name: name, SortOrder: 50, Active: 1 });
      await audit(t, req.user, 'expense.category', 'ExpenseCategory', x, { now: { name } });
      return x;
    });
    res.status(201).json({ id });
  });
  const expDto = (e) => ({
    id: e.Id, no: e.ExpNo, date: toDateStr(e.ExpDate), categoryId: e.CategoryId, category: e.CatName, amount: Number(e.Amount), method: e.Method, payee: e.Payee, note: e.Note,
    status: e.Status, at: toIso(e.CreatedAt), by: e.ByName, decidedBy: e.DecName, decidedAt: toIso(e.DecidedAt), rejectReason: e.RejectReason, voucherNo: e.VoucherNo || null, voucherStatus: e.VStatus || null,
  });
  const EXP_SQL = `SELECT e.*, c.Name AS CatName, u.FullName AS ByName, d.FullName AS DecName, v.VoucherNo, v.Status AS VStatus FROM Expenses e JOIN ExpenseCategories c ON c.Id = e.CategoryId
     JOIN Users u ON u.Id = e.CreatedBy LEFT JOIN Users d ON d.Id = e.DecidedBy LEFT JOIN CashVouchers v ON v.Id = e.VoucherId`;
  async function expList(q) {
    const day = businessDate();
    const from = DATE_RE.test(q.from || '') ? q.from : `${day.slice(0, 7)}-01`;
    const to = DATE_RE.test(q.to || '') ? q.to : day;
    const where = ['e.ExpDate >= ?', 'e.ExpDate <= ?'], params = [from, to];
    if (['pending', 'approved', 'rejected', 'void'].includes(q.status)) { where.push('e.Status = ?'); params.push(q.status); }
    if (Number(q.categoryId)) { where.push('e.CategoryId = ?'); params.push(Number(q.categoryId)); }
    const rows = (await db.query(`${EXP_SQL} WHERE ${where.join(' AND ')} ORDER BY e.ExpDate DESC, e.Id DESC`, params)).map(expDto);
    return { from, to, rows };
  }
  r.get('/expenses', async (req, res) => {
    view(req);
    const { from, to, rows } = await expList(req.query);
    const live = rows.filter((x) => x.status === 'approved');
    const byCat = {};
    for (const x of live) byCat[x.category] = (byCat[x.category] || 0) + cents(x.amount);
    res.json({
      from, to, expenses: rows.slice(0, 400), pending: rows.filter((x) => x.status === 'pending').length,
      total: pounds(live.reduce((a, x) => a + cents(x.amount), 0)), byCategory: Object.entries(byCat).map(([name, c]) => ({ name, amount: pounds(c) })).sort((a, b) => b.amount - a.amount),
      direct: can(req.user, 'expense.direct'), canApprove: can(req.user, 'expense.approve'),
    });
  });
  r.get('/expenses/export', async (req, res) => {
    need(req.user, 'fin.expense');
    const { from, to, rows } = await expList(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('المصروفات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = [{ header: 'رقم', width: 8 }, { header: 'التاريخ', width: 12 }, { header: 'البند', width: 24 }, { header: 'المبلغ', width: 14 }, { header: 'الدفع', width: 10 }, { header: 'لمين', width: 24 }, { header: 'ملاحظة', width: 30 }, { header: 'الحالة', width: 12 }, { header: 'سجّله', width: 18 }];
    const ST = { pending: 'مستني موافقة', approved: 'معتمد', rejected: 'مرفوض', void: 'ملغي' };
    for (const x of rows) ws.addRow([x.no, x.date, x.category, x.amount, x.method === 'cash' ? 'نقدي' : 'بنك', x.payee || '', x.note || '', ST[x.status], x.by]);
    ws.getRow(1).font = { bold: true };
    ws.getColumn(4).numFmt = R.money.xlsxFormat();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${from}_${to}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
  async function approveExpense(t, user, e) {
    let voucherId = null;
    if (e.Method === 'cash') {
      const cat = await t.one('SELECT Name FROM ExpenseCategories WHERE Id = ?', [e.CategoryId]);
      const v = await makeVoucher(t, user, { kind: 'expense', refId: e.Id, payee: e.Payee || cat.Name, description: `مصروف · ${cat.Name}${e.Note ? ' · ' + e.Note : ''}`, amount: cents(e.Amount) });
      voucherId = v.id;
    }
    await t.run("UPDATE Expenses SET Status = 'approved', DecidedAt = ?, DecidedBy = ?, VoucherId = ? WHERE Id = ?", [new Date(), user.id, voucherId, e.Id]);
    if (e.Method !== 'cash') await postExpense(t, user, e);
  }
  r.post('/expenses', async (req, res) => {
    need(req.user, 'fin.expense');
    const b = req.body || {};
    const amount = money(b.amount, 'المبلغ');
    const date = dateOf(b.date || businessDate(), 'تاريخ المصروف');
    const method = b.method === 'bank' ? 'bank' : 'cash';
    const out = await db.tx(async (t) => {
      const cat = await t.one('SELECT Id FROM ExpenseCategories WHERE Id = ? AND Active = 1', [Number(b.categoryId) || 0]);
      if (!cat) throw bad('اختار بند المصروف', { errors: { categoryId: 'اختار البند' } });
      const no = await t.nextNumber('expense');
      const direct = can(req.user, 'expense.direct') || can(req.user, 'expense.approve');
      const id = await t.insert('Expenses', { ExpNo: no, ExpDate: date, CategoryId: cat.Id, Amount: pounds(amount), Method: method, Payee: str(b.payee, 150), Note: str(b.note, 300), Status: 'pending', CreatedAt: new Date(), CreatedBy: req.user.id });
      if (direct) await approveExpense(t, req.user, await t.one('SELECT * FROM Expenses WHERE Id = ?', [id]));
      await audit(t, req.user, 'expense.create', 'Expense', id, { now: { no, amount: pounds(amount), method, direct } });
      return { id, status: direct ? 'approved' : 'pending' };
    });
    res.status(201).json(out);
  });
  r.post('/expenses/:id/decide', async (req, res) => {
    need(req.user, 'expense.approve');
    const id = intId(req.params.id);
    const approve = req.body?.approve === true;
    const reason = str(req.body?.reason, 300);
    if (!approve && (!reason || reason.length < 3)) throw bad('اكتب سبب الرفض');
    await db.tx(async (t) => {
      const e = await t.one('SELECT * FROM Expenses WHERE Id = ?', [id]);
      if (!e || e.Status !== 'pending') throw conflict('المصروف ده اتقرر فيه قبل كده');
      if (approve) await approveExpense(t, req.user, e);
      else await t.run("UPDATE Expenses SET Status = 'rejected', DecidedAt = ?, DecidedBy = ?, RejectReason = ? WHERE Id = ?", [new Date(), req.user.id, reason, id]);
      await audit(t, req.user, approve ? 'expense.approve' : 'expense.reject', 'Expense', id, { now: { no: e.ExpNo, amount: Number(e.Amount) }, note: reason });
    });
    res.json({ ok: true });
  });
  r.post('/expenses/:id/void', async (req, res) => {
    need(req.user, 'fin.expense');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب الإلغاء');
    await db.tx(async (t) => {
      const e = await t.one('SELECT * FROM Expenses WHERE Id = ?', [id]);
      if (!e || !['pending', 'approved'].includes(e.Status)) throw notFound('المصروف مش موجود');
      if (e.CreatedBy !== req.user.id && !can(req.user, 'expense.approve')) throw forbidden('إلغاء مصروف موظف تاني للمدير');
      if (e.VoucherId) {
        const v = await t.one('SELECT Status FROM CashVouchers WHERE Id = ?', [e.VoucherId]);
        if (v?.Status === 'paid') throw conflict('الفلوس اتصرفت من الخزينة. مينفعش يتلغى');
        await t.run("UPDATE CashVouchers SET Status = 'cancelled', CancelReason = ? WHERE Id = ?", [reason, e.VoucherId]);
      }
      await t.run("UPDATE Expenses SET Status = 'void', RejectReason = ? WHERE Id = ?", [reason, id]);
      await reverseSource(t, req.user, 'expense', id, reason);
      await audit(t, req.user, 'expense.void', 'Expense', id, { now: { no: e.ExpNo }, note: reason });
    });
    res.json({ ok: true });
  });

  // ======== الأقساط ========
  r.get('/obligations', async (req, res) => {
    view(req);
    res.json({ obligations: await obligationList(db) });
  });
  r.get('/obligations/:id', async (req, res) => {
    view(req);
    const id = intId(req.params.id);
    const o = await db.one('SELECT * FROM Obligations WHERE Id = ? AND Active = 1', [id]);
    if (!o) throw notFound('الالتزام مش موجود');
    res.json({ obligation: { id: o.Id, name: o.Name, party: o.Party, note: o.Note }, installments: await installmentRows(db, id) });
  });
  r.post('/obligations', async (req, res) => {
    need(req.user, 'fin.oblig');
    const b = req.body || {};
    const name = str(b.name, 150);
    if (!name || name.length < 2) throw bad('اكتب اسم الالتزام', { errors: { name: 'اكتب الاسم' } });
    let plan = [];
    if (Array.isArray(b.installments) && b.installments.length) {
      plan = b.installments.map((x) => ({ dueDate: dateOf(x.dueDate, 'ميعاد القسط'), amount: money(x.amount, 'قيمة القسط') }));
    } else {
      const total = money(b.total, 'إجمالي الالتزام');
      const n = Number(b.count);
      if (!Number.isInteger(n) || n < 1 || n > 120) throw bad('عدد الأقساط من 1 لـ 120', { errors: { count: 'عدد الأقساط من 1 لـ 120' } });
      const first = dateOf(b.firstDue, 'أول قسط');
      const base = Math.floor(total / n);
      for (let i = 0; i < n; i++) plan.push({ dueDate: addMonths(first, i), amount: i === n - 1 ? total - base * (n - 1) : base });
    }
    const id = await db.tx(async (t) => {
      const oid = await t.insert('Obligations', { Name: name, Party: str(b.party, 150), Note: str(b.note, 300), Active: 1, CreatedAt: new Date(), CreatedBy: req.user.id });
      let i = 0;
      for (const p of plan) await t.insert('ObligationInstallments', { ObligationId: oid, No: ++i, DueDate: p.dueDate, Amount: pounds(p.amount), Status: 'due' });
      const tot = plan.reduce((a, p) => a + p.amount, 0);
      await ENTRY(t, req.user, { date: businessDate(), source: 'obligation', sourceId: oid, description: `تسجيل التزام · ${name}${b.party ? ' · ' + str(b.party, 150) : ''}`, lines: [{ key: 'oblig.debit', debit: tot, memo: name }, { key: 'oblig.payable', credit: tot, memo: name }] });
      await audit(t, req.user, 'obligation.create', 'Obligation', oid, { now: { name, count: plan.length, total: pounds(tot) } });
      return oid;
    });
    res.status(201).json({ id });
  });
  r.put('/installments/:id', async (req, res) => {
    need(req.user, 'fin.oblig');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const n = await t.one('SELECT * FROM ObligationInstallments WHERE Id = ?', [id]);
      if (!n) throw notFound('القسط مش موجود');
      if (n.Status !== 'due') throw conflict('القسط ده اتدفع');
      const due = dateOf(req.body?.dueDate, 'ميعاد القسط'), amount = money(req.body?.amount, 'قيمة القسط');
      await t.run('UPDATE ObligationInstallments SET DueDate = ?, Amount = ? WHERE Id = ?', [due, pounds(amount), id]);
      const diff = amount - cents(n.Amount);
      if (diff !== 0) {
        const o = await t.one('SELECT Name FROM Obligations WHERE Id = ?', [n.ObligationId]);
        await ENTRY(t, req.user, { date: businessDate(), source: 'obligation_adj', sourceId: id, description: `تعديل قسط ${n.No} · ${o?.Name || ''}`,
          lines: diff > 0 ? [{ key: 'oblig.debit', debit: diff }, { key: 'oblig.payable', credit: diff }] : [{ key: 'oblig.payable', debit: -diff }, { key: 'oblig.debit', credit: -diff }] });
      }
      await audit(t, req.user, 'installment.update', 'ObligationInstallment', id, { old: { due: toDateStr(n.DueDate), amount: Number(n.Amount) }, now: { due, amount: pounds(amount) } });
    });
    res.json({ ok: true });
  });
  r.post('/installments/:id/pay', async (req, res) => {
    need(req.user, 'fin.oblig');
    const id = intId(req.params.id);
    const method = String(req.body?.method || '');
    if (!METHODS[method]) throw bad('اختار طريقة الدفع');
    await db.tx(async (t) => {
      const n = await t.one('SELECT n.*, o.Name AS OName, o.Party FROM ObligationInstallments n JOIN Obligations o ON o.Id = n.ObligationId WHERE n.Id = ?', [id]);
      if (!n) throw notFound('القسط مش موجود');
      if (n.Status !== 'due') throw conflict('القسط ده اتدفع قبل كده');
      let chequeNo = null;
      if (method === 'cheque') { chequeNo = str(req.body?.chequeNo, 40); if (!chequeNo) throw bad('اكتب رقم الشيك', { errors: { chequeNo: 'اكتب رقم الشيك' } }); }
      let voucherId = null;
      if (method === 'cash') voucherId = (await makeVoucher(t, req.user, { kind: 'installment', refId: id, payee: n.Party || n.OName, description: `قسط ${n.No} · ${n.OName}`, amount: cents(n.Amount) })).id;
      await t.run("UPDATE ObligationInstallments SET Status = 'paid', PaidAt = ?, PaidBy = ?, Method = ?, ChequeNo = ?, VoucherId = ? WHERE Id = ?", [new Date(), req.user.id, method, chequeNo, voucherId, id]);
      if (method !== 'cash') await postInstallment(t, req.user, { ...n, Method: method, ChequeNo: chequeNo }, 'pay');
      await audit(t, req.user, 'installment.pay', 'ObligationInstallment', id, { now: { obligation: n.OName, no: n.No, amount: Number(n.Amount), method } });
    });
    res.json({ ok: true });
  });
  r.delete('/obligations/:id', async (req, res) => {
    need(req.user, 'fin.oblig');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const o = await t.one('SELECT * FROM Obligations WHERE Id = ? AND Active = 1', [id]);
      if (!o) throw notFound('الالتزام مش موجود');
      if (await t.one("SELECT Id FROM ObligationInstallments WHERE ObligationId = ? AND Status = 'paid'", [id])) throw conflict('فيه أقساط اتدفعت. مينفعش يتمسح');
      await t.run('UPDATE Obligations SET Active = 0 WHERE Id = ?', [id]);
      await reverseSource(t, req.user, 'obligation', id, 'حذف الالتزام');
      for (const i of await t.query('SELECT Id FROM ObligationInstallments WHERE ObligationId = ?', [id])) await reverseSource(t, req.user, 'obligation_adj', i.Id, 'حذف الالتزام');
      await audit(t, req.user, 'obligation.delete', 'Obligation', id, { old: { name: o.Name } });
    });
    res.json({ ok: true });
  });

  // ======== شاشة المدير ========
  r.get('/dashboard', async (req, res) => {
    need(req.user, 'fin.dash');
    const today = businessDate();
    const month = PERIOD_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
    const from = `${month}-01`, nextFrom = `${nextPeriod(month)}-01`, to = addDays(nextFrom, -1);
    const { start } = cairoDayRange(from), { start: end } = cairoDayRange(nextFrom);

    // الإيراد والمستردات من الإيصالات (يوم الخزينة)
    const rc = await db.query(
      `SELECT s.BusinessDate AS D, r.Kind, SUM(r.Cash) AS Cash, SUM(r.Card) AS Card, SUM(r.Credit) AS Credit, COUNT(*) AS N
         FROM Receipts r JOIN Shifts s ON s.Id = r.ShiftId WHERE s.BusinessDate >= ? AND s.BusinessDate <= ? GROUP BY s.BusinessDate, r.Kind`, [from, to]);
    const isOut = (k) => ['refund', 'return'].includes(k);
    const days = {};
    const dayRow = (d) => (days[d] ||= { revenue: 0, expenses: 0 });
    let collected = 0, credit = 0, refunds = 0, refundCount = 0;
    for (const x of rc) {
      const c = cents(x.Cash) + cents(x.Card), d = toDateStr(x.D);
      if (isOut(x.Kind)) { refunds += -c; refundCount += Number(x.N); dayRow(d).revenue += c; } else { collected += c; credit += cents(x.Credit); dayRow(d).revenue += c; }
    }
    const refundRows = await db.query(
      `SELECT r.Id, r.ReceiptNo, r.Kind, r.Cash, r.Card, r.Note, r.CreatedAt, p.FullName AS PatientName, u.FullName AS ByName FROM Receipts r JOIN Shifts s ON s.Id = r.ShiftId
         JOIN Patients p ON p.Id = r.PatientId JOIN Users u ON u.Id = r.CreatedBy WHERE s.BusinessDate >= ? AND s.BusinessDate <= ? AND r.Kind IN ('refund','return') ORDER BY r.Id DESC`, [from, to]);

    // المصروفات
    const exp = await db.query("SELECT e.ExpDate AS D, c.Name, SUM(e.Amount) AS S FROM Expenses e JOIN ExpenseCategories c ON c.Id = e.CategoryId WHERE e.Status = 'approved' AND e.ExpDate >= ? AND e.ExpDate <= ? GROUP BY e.ExpDate, c.Name", [from, to]);
    const supPay = await db.query("SELECT PayDate AS D, SUM(Amount) AS S FROM SupplierPayments WHERE Status = 'ok' AND PayDate >= ? AND PayDate <= ? GROUP BY PayDate", [from, to]);
    const docPay = await db.query("SELECT CreatedAt, Gross FROM DoctorPayouts WHERE Status <> 'void' AND CreatedAt >= ? AND CreatedAt < ?", [start, end]);
    const insPay = await db.query("SELECT PaidAt, Amount FROM ObligationInstallments WHERE Status = 'paid' AND PaidAt >= ? AND PaidAt < ?", [start, end]);
    const general = exp.reduce((a, x) => a + cents(x.S), 0), suppliers = supPay.reduce((a, x) => a + cents(x.S), 0);
    const doctors = docPay.reduce((a, x) => a + cents(x.Gross), 0), installments = insPay.reduce((a, x) => a + cents(x.Amount), 0);
    for (const x of exp) dayRow(toDateStr(x.D)).expenses += cents(x.S);
    for (const x of supPay) dayRow(toDateStr(x.D)).expenses += cents(x.S);
    for (const x of docPay) dayRow(cairoDate(new Date(x.CreatedAt))).expenses += cents(x.Gross);
    for (const x of insPay) dayRow(cairoDate(new Date(x.PaidAt))).expenses += cents(x.Amount);
    const catMap = {};
    for (const x of exp) catMap[x.Name] = (catMap[x.Name] || 0) + cents(x.S);
    const series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) { const v = days[d] || { revenue: 0, expenses: 0 }; series.push({ date: d, revenue: pounds(Math.max(v.revenue, 0)), expenses: pounds(v.expenses) }); }

    // الشيكات المستحقة
    const cheques = await chequeList(db, 'due');
    const ch = cheques.map((c) => ({ ...c, overdue: c.date < today, soon: c.date >= today && c.date <= addDays(today, 7) }));
    // الأقساط
    const inst = await db.query(
      `SELECT n.Id, n.No, n.DueDate, n.Amount, o.Name FROM ObligationInstallments n JOIN Obligations o ON o.Id = n.ObligationId WHERE n.Status = 'due' AND o.Active = 1 ORDER BY n.DueDate, n.Id`);
    const instDto = inst.map((n) => ({ id: n.Id, name: n.Name, no: n.No, date: toDateStr(n.DueDate), amount: Number(n.Amount), overdue: toDateStr(n.DueDate) < today }));
    const instMonth = instDto.filter((n) => n.date >= from && n.date <= to), instLate = instDto.filter((n) => n.overdue);
    // تنبيهات
    const pendExp = await db.one("SELECT COUNT(*) AS N, COALESCE(SUM(Amount), 0) AS S FROM Expenses WHERE Status = 'pending'");
    const pendVou = await db.one("SELECT COUNT(*) AS N, COALESCE(SUM(Amount), 0) AS S FROM CashVouchers WHERE Status = 'pending'");
    const lateInv = (await invoiceList(db, "i.Status = 'open'", [])).filter((i) => i.overdue);
    const claims = await db.one("SELECT COALESCE(SUM(Total), 0) AS T, COALESCE(SUM(Paid), 0) AS P, COALESCE(SUM(Rejected), 0) AS R FROM Claims WHERE Status <> 'draft'");

    const totalOut = general + suppliers + doctors + installments;
    res.json({
      month, monthName: periodName(month), today, from, to,
      revenue: { collected: pounds(collected), credit: pounds(credit), refunds: pounds(refunds), net: pounds(collected - refunds) },
      expenses: { total: pounds(totalOut), general: pounds(general), suppliers: pounds(suppliers), doctors: pounds(doctors), installments: pounds(installments),
        categories: Object.entries(catMap).map(([name, c]) => ({ name, amount: pounds(c) })).sort((a, b) => b.amount - a.amount) },
      result: pounds(collected - refunds - totalOut),
      cheques: { count: ch.length, total: pounds(ch.reduce((a, c) => a + cents(c.amount), 0)), overdue: ch.filter((c) => c.overdue).length, soon: ch.filter((c) => c.soon).length,
        soonTotal: pounds(ch.filter((c) => c.soon || c.overdue).reduce((a, c) => a + cents(c.amount), 0)), list: ch.slice(0, 8) },
      installments: { monthCount: instMonth.length, monthTotal: pounds(instMonth.reduce((a, n) => a + cents(n.amount), 0)), late: instLate.length, lateTotal: pounds(instLate.reduce((a, n) => a + cents(n.amount), 0)),
        list: instDto.slice(0, 6) },
      refunds: { count: refundCount, total: pounds(refunds), list: refundRows.slice(0, 6).map((x) => ({ id: x.Id, no: x.ReceiptNo, patient: x.PatientName, amount: pounds(-(cents(x.Cash) + cents(x.Card))), by: x.ByName, note: x.Note, at: toIso(x.CreatedAt) })) },
      alerts: { pendingExpenses: Number(pendExp.N), pendingExpensesTotal: Number(pendExp.S), pendingVouchers: Number(pendVou.N), pendingVouchersTotal: Number(pendVou.S), lateInvoices: lateInv.length, lateInvoicesTotal: pounds(lateInv.reduce((a, i) => a + cents(i.left), 0)) },
      claims: { total: Number(claims.T), paid: Number(claims.P), rejected: Number(claims.R), left: pounds(cents(claims.T) - cents(claims.P) - cents(claims.R)) },
      series,
    });
  });

  return r;
}
void toBool;
