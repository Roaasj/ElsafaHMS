// التعاقدات: سعر الخدمة للجهة، ونسبة تحمّل الشركة، والحدود القصوى، ودفتر حساب الجهات
import { bad, cents, pounds, cairoDate } from './util.js';
import { toBool, toDateStr } from '../db/index.js';
import { R } from './runtime.js';

/** الحالات اللي نصيب الشركة فيها لسه قائم (مستحق أو مستني) */
export const PAYER_LIVE = ['covered', 'pending', 'approved', 'tempcash'];
/** الحالات اللي بتتسجل على حساب الشركة لما البند يتدفع/المريض يخرج */
export const PAYER_FINAL = ['covered', 'approved'];

/** تحميل جهة ومستوى وتأكيد إنهم صالحين النهارده */
export async function loadPayer(t, payerId, tierId, { at = new Date(), strict = true } = {}) {
  if (!payerId) return null;
  const p = await t.one('SELECT * FROM Payers WHERE Id = ?', [Number(payerId)]);
  if (!p) throw bad('جهة التعاقد مش موجودة');
  const tier = await t.one('SELECT * FROM PayerTiers WHERE Id = ? AND PayerId = ?', [Number(tierId) || 0, p.Id]);
  if (!tier) throw bad('اختار مستوى الكارنيه', { errors: { tier: 'اختار مستوى الكارنيه' } });
  if (strict) {
    const today = cairoDate(at);
    if (!toBool(p.Active) || !toBool(tier.Active)) throw bad(`التعاقد مع «${p.Name}» موقوف`);
    if (p.ValidFrom && toDateStr(p.ValidFrom) > today) throw bad(`التعاقد مع «${p.Name}» لسه ما بدأش`);
    if (p.ValidTo && toDateStr(p.ValidTo) < today) throw bad(`التعاقد مع «${p.Name}» انتهى في ${toDateStr(p.ValidTo)}`);
  }
  const cov = await t.query('SELECT Dept, Pct FROM TierCoverage WHERE TierId = ?', [tier.Id]);
  return {
    id: p.Id, name: p.Name, priceMode: p.PriceMode, priceListId: p.PriceListId ?? null, discountPct: p.DiscountPct == null ? 0 : Number(p.DiscountPct),
    visitCap: p.VisitCap == null ? null : cents(p.VisitCap), yearCap: p.YearCap == null ? null : cents(p.YearCap),
    tierId: tier.Id, tierName: tier.Name, coverage: Object.fromEntries(cov.map((c) => [c.Dept, Number(c.Pct)])),
  };
}

/** سعر الخدمة للجهة بالقروش */
export async function servicePrice(t, payer, serviceId, cashCents) {
  if (!payer) return cashCents;
  if (payer.priceMode === 'list') {
    const r = payer.priceListId
      ? await t.one('SELECT Price FROM PriceListItems WHERE ListId = ? AND ServiceId = ?', [payer.priceListId, serviceId])
      : await t.one('SELECT Price FROM PayerPrices WHERE PayerId = ? AND ServiceId = ?', [payer.id, serviceId]);
    if (r) return cents(r.Price);
  }
  if (payer.priceMode === 'discount' && payer.discountPct) return R.money.discount(cashCents, payer.discountPct);
  return cashCents;
}
/** سعر الليلة للجهة بالقروش */
export async function nightPrice(t, payer, classId, cashCents) {
  if (!payer) return cashCents;
  if (payer.priceMode === 'list') {
    const r = payer.priceListId
      ? await t.one('SELECT NightPrice FROM PriceListClassPrices WHERE ListId = ? AND ClassId = ?', [payer.priceListId, classId])
      : await t.one('SELECT NightPrice FROM PayerClassPrices WHERE PayerId = ? AND ClassId = ?', [payer.id, classId]);
    if (r) return cents(r.NightPrice);
  }
  if (payer.priceMode === 'discount' && payer.discountPct) return R.money.discount(cashCents, payer.discountPct);
  return cashCents;
}

export async function serviceRule(t, payer, serviceId) {
  if (!payer || !serviceId) return null;
  const r = await t.one('SELECT [Rule] AS R FROM PayerRules WHERE PayerId = ? AND ServiceId = ?', [payer.id, serviceId]);
  return r?.R || null;
}

/** المستخدم من الحد الأقصى: للزيارة/الدخول ده، وللمريض مع الجهة في السنة */
async function capRoom(t, payer, { patientId, visitId, admissionId }) {
  let room = Infinity;
  const live = PAYER_LIVE.map(() => '?').join(',');
  if (payer.visitCap != null) {
    const r = visitId
      ? await t.one(`SELECT SUM(PayerAmount) AS S FROM VisitItems WHERE VisitId = ? AND Status = 'active' AND CoverStatus IN (${live})`, [visitId, ...PAYER_LIVE])
      : await t.one(`SELECT SUM(PayerAmount) AS S FROM AdmissionItems WHERE AdmissionId = ? AND Status = 'active' AND CoverStatus IN (${live})`, [admissionId, ...PAYER_LIVE]);
    room = Math.min(room, payer.visitCap - cents(r?.S));
  }
  if (payer.yearCap != null) {
    const y = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const a = await t.one(
      `SELECT SUM(i.PayerAmount) AS S FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId
        WHERE v.PatientId = ? AND v.PayerId = ? AND i.Status = 'active' AND i.CoverStatus IN (${live}) AND i.AddedAt >= ?`, [patientId, payer.id, ...PAYER_LIVE, y]);
    const b = await t.one(
      `SELECT SUM(i.PayerAmount) AS S FROM AdmissionItems i JOIN Admissions a ON a.Id = i.AdmissionId
        WHERE a.PatientId = ? AND a.PayerId = ? AND i.Status = 'active' AND i.CoverStatus IN (${live}) AND i.AddedAt >= ?`, [patientId, payer.id, ...PAYER_LIVE, y]);
    room = Math.min(room, payer.yearCap - cents(a?.S) - cents(b?.S));
  }
  return Math.max(0, room);
}

/**
 * نصيب الشركة لبند.
 * @returns {{ pct, payerAmount, patientAmount, status, rule }}  status: none | covered | excluded | needs (محتاج موافقة)
 */
export async function cover(t, payer, { serviceId, dept, amount, patientId, visitId, admissionId }) {
  if (!payer) return { pct: 0, payerAmount: 0, patientAmount: amount, status: 'none', rule: null };
  const rule = await serviceRule(t, payer, serviceId);
  if (rule === 'excluded') return { pct: 0, payerAmount: 0, patientAmount: amount, status: 'excluded', rule };
  const pct = payer.coverage[dept] ?? 0;
  let payerAmount = R.money.percent(amount, pct);
  if (payerAmount > 0 && (payer.visitCap != null || payer.yearCap != null)) {
    payerAmount = Math.min(payerAmount, await capRoom(t, payer, { patientId, visitId, admissionId }));
  }
  if (payerAmount <= 0) return { pct, payerAmount: 0, patientAmount: amount, status: 'none', rule };
  return { pct, payerAmount, patientAmount: amount - payerAmount, status: rule === 'approval' ? 'needs' : 'covered', rule };
}

/** تسجيل نصيب الشركة على حسابها */
export async function ledgerCharge(t, user, { payerId, patientId, visitItemId = null, admissionItemId = null, receiptId = null, approvalId = null, description, cardNo, full, amount }) {
  if (!amount) return;
  await t.insert('PayerLedger', {
    PayerId: payerId, PatientId: patientId, VisitItemId: visitItemId, AdmissionItemId: admissionItemId, ReceiptId: receiptId,
    ApprovalId: approvalId, Description: description, CardNo: cardNo || null, FullAmount: pounds(full), Amount: pounds(amount),
    ReversesId: null, At: new Date(), CreatedBy: user.id,
  });
}

/** عكس كل اللي اتسجل على الشركة لبنود معينة (إلغاء إيصال، إلغاء خروج، رفض) */
export async function ledgerReverse(t, user, where, params) {
  const rows = await t.query(`SELECT * FROM PayerLedger WHERE ReversesId IS NULL AND Amount > 0 AND ${where}`, params);
  const now = new Date();
  for (const r of rows) {
    const done = await t.one('SELECT Id FROM PayerLedger WHERE ReversesId = ?', [r.Id]);
    if (done) continue;
    await t.insert('PayerLedger', {
      PayerId: r.PayerId, PatientId: r.PatientId, VisitItemId: r.VisitItemId, AdmissionItemId: r.AdmissionItemId, ReceiptId: r.ReceiptId,
      ApprovalId: r.ApprovalId, Description: 'إلغاء: ' + r.Description, CardNo: r.CardNo, FullAmount: -Number(r.FullAmount), Amount: -Number(r.Amount),
      ReversesId: r.Id, At: now, CreatedBy: user.id,
    });
  }
  return rows.length;
}

export function payerInfo(row) {
  if (!row?.PayerId) return null;
  return { id: row.PayerId, name: row.PayerName, tierId: row.TierId, tierName: row.TierName, cardNo: row.CardNo };
}
