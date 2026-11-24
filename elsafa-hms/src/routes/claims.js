// حسابات التعاقدات: مراجعة كل حالة (خارجي وداخلي)، المطالبة الشهرية (Cover + تفصيلي)، الشيكات والمرفوضات
// الحالة = زيارة أو دخول على جهة. المبلغ اللي على الشركة = مجموع PayerLedger لبنودها (بعد أي إلغاء أو تسوية)
// المطالبة بتاخد اللي «لسه ما اتطالبش بيه» من كل بند، فأي فرق بعد المطالبة بيروح للمطالبة اللي بعدها لوحده
import { R, argb } from '../lib/runtime.js';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, cairoDate } from '../lib/util.js';
import { toIso, toDateStr } from '../db/index.js';
import { latinDigits } from '../../shared/text.js';
import { amountInWords } from '../../shared/tafqeet.js';
import { UPLOAD_DIR } from './payers.js';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CASE_ST = { pending: 'مستنية المراجعة', ok: 'اتراجعت', note: 'فيها ملاحظة' };
export const CLAIM_ST = { draft: 'مسودة', sent: 'اتبعتت', partial: 'اتدفع جزء', closed: 'خلصت' };
const periodOf = (d) => cairoDate(new Date(d)).slice(0, 7);
export const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
export const periodName = (p) => { const [y, m] = p.split('-').map(Number); return `${['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'][m - 1]} ${y}`; };
const ADJ = 'تسوية%';
const anyOf = (user, perms) => { if (!perms.some((p) => can(user, p))) throw forbidden(); };
const ADM_NAMES = { inpatient: 'داخلي', icu: 'عناية', nursery: 'حضانة', surgery: 'عمليات' };
const VISIT_NAMES = { clinic: 'عيادات', emergency: 'طوارئ', lab: 'معمل', radiology: 'أشعة', pharmacy: 'صيدلية' };

/** الحالات الجديدة: كل زيارة أو دخول (خرج) ليه سطور على حساب جهة ولسه مالوش حالة */
export async function syncCases(t) {
  const now = new Date();
  const vs = await t.query(
    `SELECT vi.VisitId, MIN(l.PayerId) AS PayerId, MIN(v.PatientId) AS PatientId, MIN(v.OpenedAt) AS At FROM PayerLedger l JOIN VisitItems vi ON vi.Id = l.VisitItemId JOIN Visits v ON v.Id = vi.VisitId
      WHERE NOT EXISTS (SELECT 1 FROM ClaimCases c WHERE c.VisitId = vi.VisitId) GROUP BY vi.VisitId`);
  for (const v of vs) {
    const p = periodOf(v.At);
    await t.insert('ClaimCases', { PayerId: v.PayerId, Kind: 'visit', VisitId: v.VisitId, AdmissionId: null, PatientId: v.PatientId, Period: p, BasePeriod: p, Status: 'pending', CreatedAt: now });
  }
  const as = await t.query(
    `SELECT ai.AdmissionId, MIN(l.PayerId) AS PayerId, MIN(a.PatientId) AS PatientId, MIN(a.DischargedAt) AS At FROM PayerLedger l JOIN AdmissionItems ai ON ai.Id = l.AdmissionItemId JOIN Admissions a ON a.Id = ai.AdmissionId
      WHERE a.Status = 'discharged' AND NOT EXISTS (SELECT 1 FROM ClaimCases c WHERE c.AdmissionId = ai.AdmissionId) GROUP BY ai.AdmissionId`);
  for (const a of as) {
    const p = periodOf(a.At);
    await t.insert('ClaimCases', { PayerId: a.PayerId, Kind: 'admission', VisitId: null, AdmissionId: a.AdmissionId, PatientId: a.PatientId, Period: p, BasePeriod: p, Status: 'pending', CreatedAt: now });
  }
  return vs.length + as.length;
}

/** بنود الحالة: نصيب الشركة الصافي، واللي اتطالب بيه قبل كده (غير المسودة دي) */
async function caseItems(t, c, { exceptClaimId = 0 } = {}) {
  const rows = c.Kind === 'visit'
    ? await t.query(
      `SELECT vi.Id, vi.ServiceName AS Name, vi.Qty, vi.UnitPrice, vi.Amount AS Gross, vi.PatientAmount, vi.Status, vi.AddedAt AS SDate, vi.CoverStatus, vi.Dept,
              (SELECT SUM(l.Amount) FROM PayerLedger l WHERE l.VisitItemId = vi.Id AND l.PayerId = ?) AS Net,
              (SELECT SUM(l.FullAmount) FROM PayerLedger l WHERE l.VisitItemId = vi.Id AND l.PayerId = ? AND l.Description NOT LIKE ?) AS [Full],
              (SELECT SUM(cl.Amount) FROM ClaimLines cl WHERE cl.VisitItemId = vi.Id AND cl.ClaimId <> ?) AS Claimed
         FROM VisitItems vi WHERE vi.VisitId = ? ORDER BY vi.Id`, [c.PayerId, c.PayerId, ADJ, exceptClaimId, c.VisitId])
    : await t.query(
      `SELECT ai.Id, ai.Name, ai.Qty, ai.UnitPrice, ai.Amount AS Gross, ai.PatientAmount, ai.Status, COALESCE(ai.ChargeDate, ai.AddedAt) AS SDate, ai.CoverStatus, ai.Dept, ai.Cat, ai.Kind AS IKind,
              (SELECT SUM(l.Amount) FROM PayerLedger l WHERE l.AdmissionItemId = ai.Id AND l.PayerId = ?) AS Net,
              (SELECT SUM(l.FullAmount) FROM PayerLedger l WHERE l.AdmissionItemId = ai.Id AND l.PayerId = ? AND l.Description NOT LIKE ?) AS [Full],
              (SELECT SUM(cl.Amount) FROM ClaimLines cl WHERE cl.AdmissionItemId = ai.Id AND cl.ClaimId <> ?) AS Claimed
         FROM AdmissionItems ai WHERE ai.AdmissionId = ? ORDER BY COALESCE(ai.ChargeDate, ai.AddedAt), ai.Id`, [c.PayerId, c.PayerId, ADJ, exceptClaimId, c.AdmissionId]);
  return rows.filter((r) => r.Net != null || r.Claimed != null).map((r) => {
    const net = cents(r.Net), claimed = cents(r.Claimed);
    return {
      id: r.Id, kind: c.Kind, name: r.Name, qty: Number(r.Qty), unitPrice: Number(r.UnitPrice), gross: Number(r.Gross), full: pounds(cents(r.Full)),
      date: toDateStr(r.SDate) || (r.SDate ? cairoDate(new Date(r.SDate)) : null), status: r.Status, cover: r.CoverStatus, cat: r.Cat || null,
      payer: pounds(net), patient: r.PatientAmount == null ? pounds(Math.max(0, cents(r.Gross) - net)) : Number(r.PatientAmount), claimed: pounds(claimed), outstanding: pounds(net - claimed),
    };
  });
}

/** ملخص الحالات (للقايمة): الصافي واللي لسه ما اتطالبش بيه */
async function caseRows(t, where, params) {
  const rows = await t.query(
    `SELECT c.*, p.FullName, p.PatientNo, p.NationalId, py.Name AS PayerName,
            v.VisitNo, v.Type AS VType, v.OpenedAt, v.CardNo AS VCard, v.Diagnosis AS VDiag, v.TierId AS VTier,
            a.AdmissionNo, a.Type AS AType, a.AdmittedAt, a.DischargedAt, a.CardNo AS ACard, a.Diagnosis AS ADiag, a.TierId AS ATier,
            u.FullName AS NoteByName, r.FullName AS ReviewedByName,
            (SELECT COUNT(*) FROM ClaimCaseFiles f WHERE f.CaseId = c.Id) AS Files
       FROM ClaimCases c JOIN Patients p ON p.Id = c.PatientId JOIN Payers py ON py.Id = c.PayerId
       LEFT JOIN Visits v ON v.Id = c.VisitId LEFT JOIN Admissions a ON a.Id = c.AdmissionId
       LEFT JOIN Users u ON u.Id = c.NoteBy LEFT JOIN Users r ON r.Id = c.ReviewedBy
      ${where} ORDER BY COALESCE(a.DischargedAt, v.OpenedAt), c.Id`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.Id);
  const ph = ids.map(() => '?').join(',');
  const net = new Map();
  for (const x of await t.query(
    `SELECT c.Id, SUM(l.Amount) AS N FROM ClaimCases c JOIN VisitItems vi ON vi.VisitId = c.VisitId JOIN PayerLedger l ON l.VisitItemId = vi.Id AND l.PayerId = c.PayerId WHERE c.Id IN (${ph}) GROUP BY c.Id
     UNION ALL
     SELECT c.Id, SUM(l.Amount) AS N FROM ClaimCases c JOIN AdmissionItems ai ON ai.AdmissionId = c.AdmissionId JOIN PayerLedger l ON l.AdmissionItemId = ai.Id AND l.PayerId = c.PayerId WHERE c.Id IN (${ph}) GROUP BY c.Id`, [...ids, ...ids])) net.set(x.Id, (net.get(x.Id) || 0) + cents(x.N));
  const claimed = new Map(), sent = new Map();
  for (const x of await t.query(`SELECT cl.CaseId, cm.Status, SUM(cl.Amount) AS N FROM ClaimLines cl JOIN Claims cm ON cm.Id = cl.ClaimId WHERE cl.CaseId IN (${ph}) GROUP BY cl.CaseId, cm.Status`, ids)) {
    claimed.set(x.CaseId, (claimed.get(x.CaseId) || 0) + cents(x.N));
    if (x.Status !== 'draft') sent.set(x.CaseId, (sent.get(x.CaseId) || 0) + cents(x.N));
  }
  const tiers = new Map((await t.query('SELECT Id, Name FROM PayerTiers')).map((x) => [x.Id, x.Name]));
  const appr = new Map();
  for (const x of await t.query(
    `SELECT c.Id, ap.Status, ap.ApprovalNo, ap.ImageFile FROM ClaimCases c JOIN Approvals ap ON (ap.VisitItemId IN (SELECT Id FROM VisitItems WHERE VisitId = c.VisitId))
        OR (ap.AdmissionItemId IN (SELECT Id FROM AdmissionItems WHERE AdmissionId = c.AdmissionId)) OR (ap.AdmissionId = c.AdmissionId)
      WHERE c.Id IN (${ph}) AND ap.Status <> 'cancelled'`, ids)) {
    const a = appr.get(x.Id) || { n: 0, open: 0, noNo: 0, noImg: 0 };
    a.n++; if (['pending', 'tempcash'].includes(x.Status)) a.open++; if (!x.ApprovalNo) a.noNo++; if (!x.ImageFile) a.noImg++;
    appr.set(x.Id, a);
  }
  return rows.map((r) => {
    const n = net.get(r.Id) || 0, cl = claimed.get(r.Id) || 0, ap = appr.get(r.Id) || { n: 0, open: 0, noNo: 0, noImg: 0 };
    const card = r.Kind === 'visit' ? r.VCard : r.ACard, diag = r.Kind === 'visit' ? r.VDiag : r.ADiag;
    const flags = [];
    if (!card) flags.push('رقم الكارنيه ناقص');
    if (!diag) flags.push('التشخيص ناقص');
    if (ap.open) flags.push(`${ap.open} موافقة مستنية`);
    if (ap.noNo) flags.push('رقم موافقة ناقص');
    const afterClaim = (sent.get(r.Id) || 0) !== 0 && n - cl !== 0;
    return {
      id: r.Id, kind: r.Kind, payer: { id: r.PayerId, name: r.PayerName }, period: r.Period, basePeriod: r.BasePeriod, deferred: r.Period !== r.BasePeriod,
      status: r.Status, statusName: CASE_ST[r.Status], note: r.Note, noteBy: r.NoteByName, noteAt: toIso(r.NoteAt), fixedAt: toIso(r.FixedAt), reviewedBy: r.ReviewedByName,
      patient: { id: r.PatientId, name: r.FullName, no: r.PatientNo, nid: r.NationalId },
      ref: r.Kind === 'visit' ? { id: r.VisitId, no: r.VisitNo, type: r.VType, typeName: VISIT_NAMES[r.VType] || r.VType, date: toIso(r.OpenedAt) }
        : { id: r.AdmissionId, no: r.AdmissionNo, type: r.AType, typeName: ADM_NAMES[r.AType] || r.AType, date: toIso(r.AdmittedAt), out: toIso(r.DischargedAt) },
      cardNo: card, diagnosis: diag, tier: tiers.get(r.Kind === 'visit' ? r.VTier : r.ATier) || null,
      amount: pounds(n), claimed: pounds(cl), outstanding: pounds(n - cl), afterClaim, approvals: ap.n, files: Number(r.Files), flags,
    };
  });
}
/** حالات الشهر: حالات الشهر نفسه، واللي قبله ولسه ليه فلوس ما اتطالبش بيها (مؤجلة أو فرق بعد المطالبة) */
async function periodCases(t, payerId, period) {
  const list = await caseRows(t, 'WHERE c.PayerId = ? AND c.Period <= ?', [payerId, period]);
  return list.filter((c) => (c.period === period ? c.amount !== 0 || c.claimed !== 0 : c.outstanding !== 0));
}

async function loadCase(t, id) {
  const c = await t.one('SELECT * FROM ClaimCases WHERE Id = ?', [id]);
  if (!c) throw notFound('الحالة مش موجودة');
  return c;
}
async function caseDetails(t, id) {
  const c = await loadCase(t, id);
  const [row] = await caseRows(t, 'WHERE c.Id = ?', [id]);
  const items = await caseItems(t, c);
  const approvals = await t.query(
    `SELECT ap.*, COALESCE(vi.ServiceName, ai.Name) AS ItemName FROM Approvals ap LEFT JOIN VisitItems vi ON vi.Id = ap.VisitItemId LEFT JOIN AdmissionItems ai ON ai.Id = ap.AdmissionItemId
      WHERE ap.Status <> 'cancelled' AND (${c.Kind === 'visit' ? 'vi.VisitId = ?' : '(ai.AdmissionId = ? OR ap.AdmissionId = ?)'}) ORDER BY ap.Id`,
    c.Kind === 'visit' ? [c.VisitId] : [c.AdmissionId, c.AdmissionId]);
  const files = await t.query('SELECT f.*, u.FullName FROM ClaimCaseFiles f JOIN Users u ON u.Id = f.CreatedBy WHERE f.CaseId = ? ORDER BY f.Id', [id]);
  const adj = await t.query(
    `SELECT l.*, u.FullName FROM PayerLedger l JOIN Users u ON u.Id = l.CreatedBy WHERE l.Description LIKE ? AND l.PayerId = ? AND (${c.Kind === 'visit'
      ? 'l.VisitItemId IN (SELECT Id FROM VisitItems WHERE VisitId = ?)' : 'l.AdmissionItemId IN (SELECT Id FROM AdmissionItems WHERE AdmissionId = ?)'}) ORDER BY l.Id`,
    [ADJ, c.PayerId, c.Kind === 'visit' ? c.VisitId : c.AdmissionId]);
  const lines = await t.query(
    `SELECT cl.ClaimId, cm.ClaimNo, cm.Status, SUM(cl.Amount) AS A, SUM(cl.Rejected) AS R FROM ClaimLines cl JOIN Claims cm ON cm.Id = cl.ClaimId WHERE cl.CaseId = ? GROUP BY cl.ClaimId, cm.ClaimNo, cm.Status`, [id]);
  return {
    case: row, items,
    approvals: approvals.map((a) => ({ id: a.Id, item: a.ItemName || 'الدخول كله', no: a.ApprovalNo, date: toDateStr(a.ApprovalDate), status: a.Status, hasImage: !!a.ImageFile, amount: Number(a.Amount) })),
    files: files.map((f) => ({ id: f.Id, label: f.Label, by: f.FullName, at: toIso(f.CreatedAt), ext: path.extname(f.FileName).slice(1) })),
    adjustments: adj.map((l) => ({ id: l.Id, text: l.Description, amount: Number(l.Amount), by: l.FullName, at: toIso(l.At) })),
    claims: lines.map((l) => ({ id: l.ClaimId, no: l.ClaimNo, status: l.Status, statusName: CLAIM_ST[l.Status], amount: pounds(cents(l.A)), rejected: pounds(cents(l.R)) })),
  };
}

// ======== المطالبة ========
async function claimTotals(t, id) {
  const s = await t.one('SELECT SUM(Amount) AS A, SUM(Rejected) AS R FROM ClaimLines WHERE ClaimId = ?', [id]);
  const p = await t.one('SELECT SUM(Amount) AS P FROM ClaimPayments WHERE ClaimId = ?', [id]);
  const total = cents(s?.A), rej = cents(s?.R), paid = cents(p?.P);
  return { total, rej, paid };
}
async function refreshStatus(t, id) {
  const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
  const { total, rej, paid } = await claimTotals(t, id);
  let st = cm.Status;
  if (st !== 'draft') st = paid + rej >= total && total > 0 ? 'closed' : paid > 0 || rej > 0 ? 'partial' : 'sent';
  await t.run('UPDATE Claims SET Total = ?, Paid = ?, Rejected = ?, Status = ? WHERE Id = ?', [pounds(total), pounds(paid), pounds(rej), st, id]);
}
/** بناء سطور المسودة من جديد: الحالات اللي اتراجعت للشهر ده واللي قبله، كل بند باللي لسه ما اتطالبش بيه */
async function rebuildDraft(t, cm) {
  await syncCases(t);
  await t.run('DELETE FROM ClaimLines WHERE ClaimId = ?', [cm.Id]);
  const cases = await t.query("SELECT * FROM ClaimCases WHERE PayerId = ? AND Period <= ? AND Status = 'ok' ORDER BY Id", [cm.PayerId, cm.Period]);
  for (const c of cases) {
    for (const it of await caseItems(t, c, { exceptClaimId: cm.Id })) {
      if (!it.outstanding) continue;
      const first = !it.claimed;
      await t.insert('ClaimLines', {
        ClaimId: cm.Id, CaseId: c.Id, VisitItemId: c.Kind === 'visit' ? it.id : null, AdmissionItemId: c.Kind === 'admission' ? it.id : null,
        ServiceDate: it.date, Description: first ? it.name : `فرق: ${it.name}`, Qty: first ? it.qty : 1, FullAmount: first ? it.full : 0, Amount: it.outstanding, Rejected: 0, RejectReason: null,
      });
    }
  }
  await refreshStatus(t, cm.Id);
}

async function claimDetails(t, id) {
  const cm = await t.one(
    `SELECT cm.*, py.Name AS PayerName, py.ContactName, u.FullName AS ByName, s.FullName AS SentByName FROM Claims cm JOIN Payers py ON py.Id = cm.PayerId
       JOIN Users u ON u.Id = cm.CreatedBy LEFT JOIN Users s ON s.Id = cm.SentBy WHERE cm.Id = ?`, [id]);
  if (!cm) throw notFound('المطالبة مش موجودة');
  const lines = await t.query('SELECT * FROM ClaimLines WHERE ClaimId = ? ORDER BY CaseId, ServiceDate, Id', [id]);
  const caseIds = [...new Set(lines.map((l) => l.CaseId))];
  const cases = caseIds.length ? await caseRows(t, `WHERE c.Id IN (${caseIds.map(() => '?').join(',')})`, caseIds) : [];
  const byCase = new Map(cases.map((c) => [c.id, { ...c, lines: [], total: 0, full: 0, rejected: 0 }]));
  for (const l of lines) {
    const c = byCase.get(l.CaseId);
    c.lines.push({ id: l.Id, date: toDateStr(l.ServiceDate), text: l.Description, qty: l.Qty, full: Number(l.FullAmount), amount: Number(l.Amount), rejected: Number(l.Rejected), reason: l.RejectReason });
    c.total += cents(l.Amount); c.full += cents(l.FullAmount); c.rejected += cents(l.Rejected);
  }
  const list = [...byCase.values()].map((c) => ({ ...c, total: pounds(c.total), full: pounds(c.full), rejected: pounds(c.rejected) }))
    .sort((a, b) => (a.kind === b.kind ? (a.ref.out || a.ref.date || '').localeCompare(b.ref.out || b.ref.date || '') : a.kind === 'visit' ? -1 : 1));
  const sum = (k, f) => pounds(list.filter(f).reduce((s, c) => s + cents(c[k]), 0));
  const pays = await t.query('SELECT p.*, u.FullName FROM ClaimPayments p JOIN Users u ON u.Id = p.CreatedBy WHERE p.ClaimId = ? ORDER BY p.Id', [id]);
  const supp = await t.one('SELECT COUNT(*) AS N FROM Claims WHERE PayerId = ? AND Period = ? AND Id < ?', [cm.PayerId, cm.Period, cm.Id]);
  const pending = cm.Status === 'draft' ? (await periodCases(t, cm.PayerId, cm.Period)).filter((c) => c.status !== 'ok' && c.outstanding !== 0) : [];
  return {
    claim: {
      id: cm.Id, no: cm.ClaimNo, status: cm.Status, statusName: CLAIM_ST[cm.Status], period: cm.Period, periodName: periodName(cm.Period), supplement: Number(supp?.N) > 0,
      issueDate: toDateStr(cm.IssueDate), payer: { id: cm.PayerId, name: cm.PayerName, contact: cm.ContactName }, note: cm.Note,
      createdBy: cm.ByName, createdAt: toIso(cm.CreatedAt), sentBy: cm.SentByName, sentAt: toIso(cm.SentAt), reopenCount: cm.ReopenCount,
    },
    cases: list,
    totals: {
      total: Number(cm.Total), paid: Number(cm.Paid), rejected: Number(cm.Rejected), left: pounds(cents(cm.Total) - cents(cm.Paid) - cents(cm.Rejected)),
      visits: list.filter((c) => c.kind === 'visit').length, admissions: list.filter((c) => c.kind === 'admission').length,
      visitsAmount: sum('total', (c) => c.kind === 'visit'), admissionsAmount: sum('total', (c) => c.kind === 'admission'), words: amountInWords(cents(cm.Total)),
    },
    payments: pays.map((p) => ({ id: p.Id, chequeNo: p.ChequeNo, bank: p.Bank, date: toDateStr(p.ChequeDate), amount: Number(p.Amount), note: p.Note, by: p.FullName, at: toIso(p.CreatedAt) })),
    pending: pending.map((c) => ({ id: c.id, name: c.patient.name, status: c.status, statusName: c.statusName, outstanding: c.outstanding })),
  };
}
export { claimDetails };

export default function claimsRouter(db) {
  const r = router();
  const getPeriod = (q) => (PERIOD_RE.test(q || '') ? q : cairoDate().slice(0, 7));

  // ===== الشاشة الرئيسية: كل الجهات في الشهر =====
  r.get('/overview', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage']);
    const period = getPeriod(req.query.period);
    await db.tx((t) => syncCases(t));
    const payers = await db.query('SELECT Id, Name FROM Payers ORDER BY Name');
    const out = [];
    for (const p of payers) {
      const cs = await periodCases(db, p.Id, period);
      const claims = await db.query('SELECT Id, ClaimNo, Status, Total, Paid, Rejected FROM Claims WHERE PayerId = ? AND Period = ? ORDER BY Id', [p.Id, period]);
      if (!cs.length && !claims.length) continue;
      const cnt = (f) => cs.filter(f).length;
      out.push({
        payer: { id: p.Id, name: p.Name }, cases: cs.length, visits: cnt((c) => c.kind === 'visit'), admissions: cnt((c) => c.kind === 'admission'),
        ok: cnt((c) => c.status === 'ok'), note: cnt((c) => c.status === 'note'), pending: cnt((c) => c.status === 'pending'),
        amount: pounds(cs.reduce((s, c) => s + cents(c.amount), 0)), outstanding: pounds(cs.reduce((s, c) => s + cents(c.outstanding), 0)),
        claims: claims.map((c) => ({ id: c.Id, no: c.ClaimNo, status: c.Status, statusName: CLAIM_ST[c.Status], total: Number(c.Total), paid: Number(c.Paid), rejected: Number(c.Rejected) })),
      });
    }
    const notes = await db.one("SELECT COUNT(*) AS N FROM ClaimCases WHERE Status = 'note'");
    res.json({ period, periodName: periodName(period), payers: out, notes: Number(notes?.N) });
  });

  // ===== المراجعة =====
  r.get('/cases', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage']);
    const period = getPeriod(req.query.period);
    const payer = await db.one('SELECT Id, Name FROM Payers WHERE Id = ?', [Number(req.query.payerId) || 0]);
    if (!payer) throw bad('اختار الجهة');
    await db.tx((t) => syncCases(t));
    const cases = await periodCases(db, payer.Id, period);
    const draft = await db.one("SELECT Id, ClaimNo FROM Claims WHERE PayerId = ? AND Status = 'draft'", [payer.Id]);
    res.json({ payer: { id: payer.Id, name: payer.Name }, period, periodName: periodName(period), cases, draft: draft ? { id: draft.Id, no: draft.ClaimNo } : null });
  });
  r.get('/cases/:id', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage', 'claims.fix']);
    res.json(await caseDetails(db, intId(req.params.id)));
  });
  // تعديل بيانات الحالة (الكارنيه والتشخيص): حسابات التعاقدات، أو الاستقبال وهو بيصلّح الملاحظة
  r.put('/cases/:id', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.fix']);
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const c = await loadCase(t, id);
      const tbl = c.Kind === 'visit' ? 'Visits' : 'Admissions', rid = c.Kind === 'visit' ? c.VisitId : c.AdmissionId;
      const old = await t.one(`SELECT CardNo, Diagnosis FROM ${tbl} WHERE Id = ?`, [rid]);
      const b = req.body || {};
      const nv = {};
      if (b.cardNo !== undefined) nv.CardNo = str(latinDigits(b.cardNo), 60) || null;
      if (b.diagnosis !== undefined) nv.Diagnosis = str(b.diagnosis, 300) || null;
      const keys = Object.keys(nv);
      if (!keys.length) return;
      await t.run(`UPDATE ${tbl} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE Id = ?`, [...keys.map((k) => nv[k]), rid]);
      await t.run('UPDATE PayerLedger SET CardNo = ? WHERE CardNo IS NULL AND ' + (c.Kind === 'visit' ? 'VisitItemId IN (SELECT Id FROM VisitItems WHERE VisitId = ?)' : 'AdmissionItemId IN (SELECT Id FROM AdmissionItems WHERE AdmissionId = ?)'), [nv.CardNo ?? old.CardNo, rid]);
      await audit(t, req.user, 'claim.case', 'ClaimCase', id, { old: { cardNo: old.CardNo, diagnosis: old.Diagnosis }, now: { cardNo: nv.CardNo ?? old.CardNo, diagnosis: nv.Diagnosis ?? old.Diagnosis } });
    });
    res.json(await caseDetails(db, id));
  });
  // رقم الموافقة وتاريخها من شاشة المراجعة
  r.put('/cases/:id/approvals/:apId', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.fix']);
    const id = intId(req.params.id), apId = intId(req.params.apId);
    await db.tx(async (t) => {
      const ap = await t.one('SELECT * FROM Approvals WHERE Id = ?', [apId]);
      if (!ap) throw notFound('الموافقة مش موجودة');
      const no = str(latinDigits(req.body?.no ?? ap.ApprovalNo ?? ''), 60) || null;
      const date = req.body?.date === undefined ? toDateStr(ap.ApprovalDate) : DATE_RE.test(req.body.date || '') ? req.body.date : null;
      await t.run('UPDATE Approvals SET ApprovalNo = ?, ApprovalDate = ? WHERE Id = ?', [no, date, apId]);
      await audit(t, req.user, 'approval.info', 'Approval', apId, { old: { no: ap.ApprovalNo }, now: { no, date } });
    });
    res.json(await caseDetails(db, id));
  });
  // حالة المراجعة: تمام / فيها ملاحظة / رجّعها للمراجعة
  r.post('/cases/:id/status', async (req, res) => {
    need(req.user, 'claims.review');
    const id = intId(req.params.id);
    const st = req.body?.status;
    if (!CASE_ST[st]) throw bad('الحالة مش صحيحة');
    const note = str(req.body?.note, 500);
    if (st === 'note' && (!note || note.length < 3)) throw bad('اكتب الملاحظة (إيه الناقص أو الغلط)', { errors: { note: 'اكتب الملاحظة' } });
    await db.tx(async (t) => {
      const c = await loadCase(t, id);
      const now = new Date();
      if (st === 'note') await t.run("UPDATE ClaimCases SET Status = 'note', Note = ?, NoteBy = ?, NoteAt = ?, FixedBy = NULL, FixedAt = NULL WHERE Id = ?", [note, req.user.id, now, id]);
      else if (st === 'ok') await t.run("UPDATE ClaimCases SET Status = 'ok', ReviewedBy = ?, ReviewedAt = ? WHERE Id = ?", [req.user.id, now, id]);
      else await t.run("UPDATE ClaimCases SET Status = 'pending', ReviewedBy = NULL, ReviewedAt = NULL WHERE Id = ?", [id]);
      await audit(t, req.user, 'claim.review', 'ClaimCase', id, { old: { status: c.Status }, now: { status: st }, note });
    });
    res.json(await caseDetails(db, id));
  });
  // تأجيل الحالة للشهر الجاي (أو ترجيعها لشهرها)
  r.post('/cases/:id/defer', async (req, res) => {
    need(req.user, 'claims.review');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const c = await loadCase(t, id);
      const to = req.body?.undo ? c.BasePeriod : nextPeriod(c.Period);
      await t.run('UPDATE ClaimCases SET Period = ? WHERE Id = ?', [to, id]);
      await audit(t, req.user, 'claim.defer', 'ClaimCase', id, { old: { period: c.Period }, now: { period: to } });
    });
    res.json(await caseDetails(db, id));
  });
  // تسوية نصيب الشركة في بند (من غير ما نلمس إيصال المريض) — الفرق على المستشفى أو ليها
  r.post('/cases/:id/adjust', async (req, res) => {
    need(req.user, 'claims.review');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 200);
    if (!reason || reason.length < 3) throw bad('اكتب سبب التسوية', { errors: { reason: 'اكتب السبب' } });
    const v = Number(latinDigits(String(req.body?.amount ?? '')).replace(/[,،\s]/g, ''));
    if (!Number.isFinite(v) || v < 0) throw bad('اكتب المبلغ الصح على الشركة', { errors: { amount: 'المبلغ مش صحيح' } });
    await db.tx(async (t) => {
      const c = await loadCase(t, id);
      const it = (await caseItems(t, c)).find((x) => x.id === Number(req.body?.itemId));
      if (!it) throw bad('البند مش موجود');
      const delta = cents(v) - cents(it.payer);
      if (!delta) return;
      if (v > it.gross + 0.001) throw bad(`نصيب الشركة مايزيدش عن قيمة البند (${it.gross})`);
      const last = await t.one(t.top(`SELECT * FROM PayerLedger WHERE ${c.Kind === 'visit' ? 'VisitItemId' : 'AdmissionItemId'} = ? AND PayerId = ? ORDER BY Id DESC`, 1), [it.id, c.PayerId]);
      await t.insert('PayerLedger', {
        PayerId: c.PayerId, PatientId: c.PatientId, VisitItemId: c.Kind === 'visit' ? it.id : null, AdmissionItemId: c.Kind === 'admission' ? it.id : null,
        ReceiptId: last?.ReceiptId ?? null, ApprovalId: null, Description: `تسوية: ${it.name} — ${reason}`, CardNo: last?.CardNo ?? null,
        FullAmount: 0, Amount: pounds(delta), ReversesId: null, At: new Date(), CreatedBy: req.user.id,
      });
      await audit(t, req.user, 'claim.adjust', 'ClaimCase', id, { old: { item: it.name, payer: it.payer }, now: { payer: v }, note: reason });
    });
    res.json(await caseDetails(db, id));
  });
  // المستندات
  r.post('/cases/:id/files', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.fix']);
    const id = intId(req.params.id);
    await loadCase(db, id);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) throw bad('اختار الملف');
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.slice(0, 4).toString('hex') === '89504e47' ? 'png'
      : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? 'webp' : buf.slice(0, 4).toString() === '%PDF' ? 'pdf' : null;
    if (!ext) throw bad('الملف لازم يكون صورة (JPG / PNG) أو PDF');
    const dir = path.join(UPLOAD_DIR, 'claims');
    mkdirSync(dir, { recursive: true });
    const name = `${id}-${Date.now()}.${ext}`;
    writeFileSync(path.join(dir, name), buf);
    const label = str(decodeURIComponent(String(req.query.label || '')), 100) || 'مستند';
    await db.tx(async (t) => {
      const fid = await t.insert('ClaimCaseFiles', { CaseId: id, FileName: name, Label: label, CreatedAt: new Date(), CreatedBy: req.user.id });
      await audit(t, req.user, 'claim.file', 'ClaimCase', id, { now: { file: fid, label } });
    });
    res.json(await caseDetails(db, id));
  });
  r.get('/files/:fid', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage', 'claims.fix']);
    const f = await db.one('SELECT FileName FROM ClaimCaseFiles WHERE Id = ?', [intId(req.params.fid)]);
    const file = f && path.join(UPLOAD_DIR, 'claims', path.basename(f.FileName));
    if (!file || !existsSync(file)) throw notFound('الملف مش موجود');
    res.type(path.extname(file).slice(1));
    res.set('Cache-Control', 'private, max-age=3600');
    createReadStream(file).pipe(res);
  });
  // الملاحظات اللي راجعة للاستقبال
  r.get('/notes/count', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.fix']);
    const n = await db.one("SELECT COUNT(*) AS N FROM ClaimCases WHERE Status = 'note'");
    res.json({ count: Number(n?.N) });
  });
  r.get('/notes', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.fix']);
    res.json({ cases: await caseRows(db, "WHERE c.Status = 'note'", []) });
  });
  r.post('/cases/:id/fixed', async (req, res) => {
    anyOf(req.user, ['claims.fix', 'claims.review']);
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const c = await loadCase(t, id);
      if (c.Status !== 'note') throw conflict('الحالة مافيهاش ملاحظة');
      await t.run("UPDATE ClaimCases SET Status = 'pending', FixedBy = ?, FixedAt = ? WHERE Id = ?", [req.user.id, new Date(), id]);
      await audit(t, req.user, 'claim.fixed', 'ClaimCase', id, { note: str(req.body?.note, 300) });
    });
    res.json(await caseDetails(db, id));
  });

  // ===== المطالبات =====
  r.get('/list', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage']);
    const where = [], params = [];
    if (req.query.payerId) { where.push('cm.PayerId = ?'); params.push(Number(req.query.payerId)); }
    if (req.query.status === 'open') where.push("cm.Status IN ('sent','partial')");
    const rows = await db.query(db.top(`SELECT cm.*, py.Name AS PayerName FROM Claims cm JOIN Payers py ON py.Id = cm.PayerId ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cm.Id DESC`, 300), params);
    res.json({ claims: rows.map((c) => ({ id: c.Id, no: c.ClaimNo, payer: c.PayerName, period: c.Period, periodName: periodName(c.Period), issueDate: toDateStr(c.IssueDate), status: c.Status, statusName: CLAIM_ST[c.Status], total: Number(c.Total), paid: Number(c.Paid), rejected: Number(c.Rejected), left: pounds(cents(c.Total) - cents(c.Paid) - cents(c.Rejected)) })) });
  });
  r.post('/', async (req, res) => {
    need(req.user, 'claims.manage');
    const period = getPeriod(req.body?.period);
    const id = await db.tx(async (t) => {
      const p = await t.one('SELECT * FROM Payers WHERE Id = ?', [Number(req.body?.payerId) || 0]);
      if (!p) throw bad('اختار الجهة');
      const ex = await t.one("SELECT Id FROM Claims WHERE PayerId = ? AND Status = 'draft'", [p.Id]);
      if (ex) { const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [ex.Id]); if (cm.Period !== period) await t.run('UPDATE Claims SET Period = ? WHERE Id = ?', [period, cm.Id]); await rebuildDraft(t, { ...cm, Period: period }); return cm.Id; }
      const no = await t.nextNumber('claim');
      const cid = await t.insert('Claims', { ClaimNo: no, PayerId: p.Id, Period: period, IssueDate: null, Status: 'draft', Total: 0, Paid: 0, Rejected: 0, Note: null, CreatedAt: new Date(), CreatedBy: req.user.id, SentAt: null, SentBy: null, ReopenCount: 0 });
      await rebuildDraft(t, { Id: cid, PayerId: p.Id, Period: period });
      const n = await t.one('SELECT COUNT(*) AS N FROM ClaimLines WHERE ClaimId = ?', [cid]);
      if (!Number(n?.N)) throw conflict('مفيش حالات اتراجعت ولسه ما اتطالبش بيها للجهة دي. علّم الحالات «تمام» الأول');
      await audit(t, req.user, 'claim.create', 'Claim', cid, { now: { no, payer: p.Name, period } });
      return cid;
    });
    res.status(201).json(await claimDetails(db, id));
  });
  r.get('/:id', async (req, res) => {
    anyOf(req.user, ['claims.review', 'claims.manage']);
    const id = intId(req.params.id);
    const cm = await db.one('SELECT * FROM Claims WHERE Id = ?', [id]);
    if (!cm) throw notFound('المطالبة مش موجودة');
    if (cm.Status === 'draft') await db.tx((t) => rebuildDraft(t, cm)); // المسودة بتتحدث لوحدها
    const d = await claimDetails(db, id);
    if (req.query.format === 'xlsx') return claimXlsx(res, d);
    res.json(d);
  });
  r.put('/:id', async (req, res) => {
    need(req.user, 'claims.manage');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (cm.Status !== 'draft') throw conflict('المطالبة اتبعتت. المدير يفتحها الأول');
      await t.run('UPDATE Claims SET Note = ?, IssueDate = ? WHERE Id = ?', [str(req.body?.note, 300), DATE_RE.test(req.body?.issueDate || '') ? req.body.issueDate : cm.IssueDate, id]);
    });
    res.json(await claimDetails(db, id));
  });
  r.post('/:id/send', async (req, res) => {
    need(req.user, 'claims.manage');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (!cm) throw notFound('المطالبة مش موجودة');
      if (cm.Status !== 'draft') throw conflict('المطالبة اتبعتت قبل كده');
      await rebuildDraft(t, cm);
      const n = await t.one('SELECT COUNT(*) AS N, SUM(Amount) AS A FROM ClaimLines WHERE ClaimId = ?', [id]);
      if (!Number(n?.N)) throw conflict('المطالبة فاضية');
      const issue = DATE_RE.test(req.body?.issueDate || '') ? req.body.issueDate : cairoDate();
      await t.run("UPDATE Claims SET Status = 'sent', IssueDate = ?, SentAt = ?, SentBy = ? WHERE Id = ?", [issue, new Date(), req.user.id, id]);
      await refreshStatus(t, id);
      await audit(t, req.user, 'claim.send', 'Claim', id, { now: { no: cm.ClaimNo, total: pounds(cents(n.A)), issue } });
    });
    res.json(await claimDetails(db, id));
  });
  r.post('/:id/reopen', async (req, res) => {
    need(req.user, 'settings.manage');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب');
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (cm.Status === 'draft') throw conflict('المطالبة مسودة أصلًا');
      if (cm.Paid > 0 || cm.Rejected > 0) throw conflict('اتسجل عليها شيك أو مرفوضات. امسحهم الأول');
      const dr = await t.one("SELECT ClaimNo FROM Claims WHERE PayerId = ? AND Status = 'draft'", [cm.PayerId]);
      if (dr) throw conflict(`فيه مسودة مطالبة تانية للجهة دي (رقم ${dr.ClaimNo}). امسحها الأول`);
      await t.run("UPDATE Claims SET Status = 'draft', ReopenCount = ReopenCount + 1 WHERE Id = ?", [id]);
      await audit(t, req.user, 'claim.reopen', 'Claim', id, { now: { no: cm.ClaimNo }, note: reason });
    });
    res.json(await claimDetails(db, id));
  });
  r.delete('/:id', async (req, res) => {
    need(req.user, 'claims.manage');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (!cm) throw notFound('المطالبة مش موجودة');
      if (cm.Status !== 'draft') throw conflict('مينفعش تتمسح بعد ما اتبعتت');
      await t.run('DELETE FROM ClaimLines WHERE ClaimId = ?', [id]);
      await t.run('DELETE FROM Claims WHERE Id = ?', [id]);
      await audit(t, req.user, 'claim.delete', 'Claim', id, { old: { no: cm.ClaimNo } });
    });
    res.json({ ok: true });
  });
  // الشيكات
  r.post('/:id/payments', async (req, res) => {
    need(req.user, 'claims.manage');
    const id = intId(req.params.id);
    const b = req.body || {};
    const errors = {};
    const chequeNo = str(latinDigits(b.chequeNo || ''), 40);
    if (!chequeNo) errors.chequeNo = 'اكتب رقم الشيك';
    const amount = Number(latinDigits(String(b.amount ?? '')).replace(/[,،\s]/g, ''));
    if (!(amount > 0)) errors.amount = 'اكتب المبلغ';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (!cm || cm.Status === 'draft') throw conflict('المطالبة لازم تتبعت الأول');
      const left = cents(cm.Total) - cents(cm.Paid) - cents(cm.Rejected);
      if (cents(amount) > left) throw bad(`الباقي على المطالبة ${pounds(left)} بس. لو الشيك أكبر راجع المرفوضات`, { errors: { amount: 'أكبر من الباقي' } });
      const pid = await t.insert('ClaimPayments', { ClaimId: id, ChequeNo: chequeNo, Bank: str(b.bank, 80), ChequeDate: DATE_RE.test(b.date || '') ? b.date : cairoDate(), Amount: amount, Note: str(b.note, 300), CreatedAt: new Date(), CreatedBy: req.user.id });
      await refreshStatus(t, id);
      await audit(t, req.user, 'claim.payment', 'Claim', id, { now: { no: cm.ClaimNo, cheque: chequeNo, amount, payment: pid } });
    });
    res.status(201).json(await claimDetails(db, id));
  });
  r.delete('/:id/payments/:pid', async (req, res) => {
    need(req.user, 'settings.manage');
    const id = intId(req.params.id), pid = intId(req.params.pid);
    await db.tx(async (t) => {
      const p = await t.one('SELECT * FROM ClaimPayments WHERE Id = ? AND ClaimId = ?', [pid, id]);
      if (!p) throw notFound('الشيك مش موجود');
      await t.run('DELETE FROM ClaimPayments WHERE Id = ?', [pid]);
      await refreshStatus(t, id);
      await audit(t, req.user, 'claim.payment.delete', 'Claim', id, { old: { cheque: p.ChequeNo, amount: Number(p.Amount) } });
    });
    res.json(await claimDetails(db, id));
  });
  // المرفوض أو المخصوم من الشركة لكل بند (المستشفى بتتحمله)
  r.put('/:id/lines/:lineId', async (req, res) => {
    need(req.user, 'claims.manage');
    const id = intId(req.params.id), lid = intId(req.params.lineId);
    await db.tx(async (t) => {
      const cm = await t.one('SELECT * FROM Claims WHERE Id = ?', [id]);
      if (!cm || cm.Status === 'draft') throw conflict('المرفوضات بتتسجل بعد ما المطالبة تتبعت');
      const l = await t.one('SELECT * FROM ClaimLines WHERE Id = ? AND ClaimId = ?', [lid, id]);
      if (!l) throw notFound('السطر مش موجود');
      const v = req.body?.full ? Number(l.Amount) : Number(latinDigits(String(req.body?.rejected ?? '0')).replace(/[,،\s]/g, '')) || 0;
      if (v < 0 || cents(v) > cents(l.Amount)) throw bad(`المرفوض مايزيدش عن ${Number(l.Amount)}`);
      const reason = str(req.body?.reason, 200);
      if (v > 0 && !reason) throw bad('اكتب سبب الرفض أو الخصم', { errors: { reason: 'اكتب السبب' } });
      const others = cents((await t.one('SELECT SUM(Rejected) AS R FROM ClaimLines WHERE ClaimId = ? AND Id <> ?', [id, lid]))?.R);
      if (others + cents(v) + cents(cm.Paid) > cents(cm.Total)) throw bad('المرفوض والمدفوع أكتر من إجمالي المطالبة');
      await t.run('UPDATE ClaimLines SET Rejected = ?, RejectReason = ? WHERE Id = ?', [v, v > 0 ? reason : null, lid]);
      await refreshStatus(t, id);
      await audit(t, req.user, 'claim.reject', 'Claim', id, { old: { line: l.Description, rejected: Number(l.Rejected) }, now: { rejected: v }, note: reason });
    });
    res.json(await claimDetails(db, id));
  });
  // تقرير المرفوضات (خسارة المستشفى)
  r.get('/reports/rejections', async (req, res) => {
    anyOf(req.user, ['claims.manage', 'claims.review']);
    const from = PERIOD_RE.test(req.query.from || '') ? req.query.from : cairoDate().slice(0, 4) + '-01';
    const to = PERIOD_RE.test(req.query.to || '') ? req.query.to : cairoDate().slice(0, 7);
    const rows = await db.query(
      `SELECT cl.*, cm.ClaimNo, cm.Period, py.Name AS PayerName, c.Kind, p.FullName FROM ClaimLines cl JOIN Claims cm ON cm.Id = cl.ClaimId JOIN Payers py ON py.Id = cm.PayerId
         JOIN ClaimCases c ON c.Id = cl.CaseId JOIN Patients p ON p.Id = c.PatientId
        WHERE cl.Rejected > 0 AND cm.Period >= ? AND cm.Period <= ? ORDER BY cm.Period, cm.ClaimNo, cl.Id`, [from, to]);
    const by = (k) => { const m = new Map(); for (const r0 of rows) { const key = k(r0); m.set(key, (m.get(key) || 0) + cents(r0.Rejected)); } return [...m].map(([name, v]) => ({ name, amount: pounds(v) })).sort((a, b) => b.amount - a.amount); };
    res.json({
      from, to, total: pounds(rows.reduce((s, x) => s + cents(x.Rejected), 0)),
      byPayer: by((x) => x.PayerName), byReason: by((x) => x.RejectReason || '—'), byKind: by((x) => (x.Kind === 'visit' ? 'خارجي' : 'داخلي')),
      lines: rows.map((x) => ({ claimNo: x.ClaimNo, period: x.Period, payer: x.PayerName, patient: x.FullName, text: x.Description, date: toDateStr(x.ServiceDate), amount: Number(x.Amount), rejected: Number(x.Rejected), reason: x.RejectReason })),
    });
  });
  return r;
}

// ===== إكسل المطالبة: ورقة Cover وورقة التفصيلي =====
async function claimXlsx(res, d) {
  const c = d.claim, T = d.totals;
  const wb = new ExcelJS.Workbook();
  const head = (ws, row) => { ws.getRow(row).eachCell((x) => { x.font = { bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } }; }); };
  const cv = wb.addWorksheet('Cover', { views: [{ rightToLeft: true }] });
  cv.columns = [{ width: 30 }, { width: 22 }, { width: 22 }];
  cv.addRow([R.brand.name]).font = { bold: true, size: 16, color: { argb: argb() } };
  cv.addRow([`مطالبة رقم ${c.no}${d.claim.supplement ? ' (تكميلية)' : ''}`]).font = { bold: true, size: 14 };
  cv.addRow(['الجهة', c.payer.name]); cv.addRow(['عن شهر', c.periodName]); cv.addRow(['تاريخ الإصدار', c.issueDate || '']);
  cv.addRow([]);
  cv.addRow(['البيان', 'عدد الحالات', 'المبلغ']); head(cv, 7);
  cv.addRow(['الخارجي (عيادات وطوارئ ومعمل وأشعة)', T.visits, T.visitsAmount]);
  cv.addRow(['الداخلي (إقامة وعمليات وعناية وحضانة)', T.admissions, T.admissionsAmount]);
  const tr = cv.addRow(['الإجمالي', T.visits + T.admissions, T.total]); tr.font = { bold: true };
  cv.addRow([]); cv.addRow(['فقط', T.words]);
  cv.getColumn(3).numFmt = R.money.xlsxFormat();
  const ws = wb.addWorksheet('التفصيلي', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'م', key: 'n', width: 5 }, { header: 'النوع', key: 'kind', width: 9 }, { header: 'المريض', key: 'name', width: 26 }, { header: 'رقم الكارنيه', key: 'card', width: 16 },
    { header: 'الدرجة', key: 'tier', width: 10 }, { header: 'التشخيص', key: 'diag', width: 24 }, { header: 'رقم الزيارة/الدخول', key: 'ref', width: 12 },
    { header: 'تاريخ الخدمة', key: 'date', width: 12 }, { header: 'البيان', key: 'text', width: 34 }, { header: 'العدد', key: 'qty', width: 7 },
    { header: 'القيمة', key: 'full', width: 12 }, { header: 'على الجهة', key: 'amount', width: 12 }, { header: 'مرفوض', key: 'rej', width: 11 }, { header: 'سبب الرفض', key: 'reason', width: 20 },
  ];
  head(ws, 1);
  let n = 0;
  for (const cs of d.cases) {
    n++;
    for (const l of cs.lines) ws.addRow({ n, kind: cs.kind === 'visit' ? 'خارجي' : 'داخلي', name: cs.patient.name, card: cs.cardNo || '', tier: cs.tier || '', diag: cs.diagnosis || '', ref: cs.ref.no, date: l.date, text: l.text, qty: l.qty, full: l.full, amount: l.amount, rej: l.rejected || '', reason: l.reason || '' });
    const s = ws.addRow({ text: `إجمالي ${cs.patient.name}`, amount: cs.total, rej: cs.rejected || '' });
    s.font = { bold: true }; s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6EEE8' } };
  }
  const g = ws.addRow({ text: 'الإجمالي', amount: T.total, rej: T.rejected || '' }); g.font = { bold: true, size: 12 };
  for (const k of ['full', 'amount', 'rej']) ws.getColumn(k).numFmt = R.money.xlsxFormat();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`مطالبة-${c.no}-${c.payer.name}-${c.period}.xlsx`)}`);
  await wb.xlsx.write(res);
  res.end();
}
