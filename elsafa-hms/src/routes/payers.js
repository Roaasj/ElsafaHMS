// جهات التعاقد (المدير يعدّل، والكل يشوف)، الموافقات ومراجعتها، وكشف حساب الجهات
import { R, argb } from '../lib/runtime.js';
import ExcelJS from 'exceljs';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { router } from '../lib/router.js';
import { need, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cents, pounds, parseMoney, cairoDate, cairoDayRange } from '../lib/util.js';
import { toBool, toIso, toDateStr } from '../db/index.js';
import { cleanName, latinDigits, searchKey } from '../../shared/text.js';
import { ROOT } from '../config.js';
import { DEPTS, currentPriceSql } from './catalog.js';
import { ledgerCharge, ledgerReverse } from '../lib/coverage.js';
import { qty2, pct2 } from '../../shared/money.js';

// أقسام التغطية: أقسام الخدمات + الأدوية والمستلزمات (من التذكرة)
// بتتحسب وقت الاستخدام (مش وقت تحميل الملف): DEPTS بتتملي من القوائم بعد ما السيرفر يقوم، وحسابها وقت التحميل كان بيرجّع قايمة فاضية فالتغطية كانت بتتسقط
const deptKeys = () => [...Object.keys(DEPTS), 'drugs', 'supplies'];
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
const dateOrNull = (v, label) => {
  if (v === '' || v == null) return null;
  const d = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) throw bad(`${label} مش صحيح`);
  return d;
};
const pctVal = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(latinDigits(v));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('النسبة لازم من 0 لـ 100');
  return pct2(n);
};
const optMoney = (v, l) => (v === '' || v == null ? null : parseMoney(v, l));

function payerDto(p, tiers = [], cov = []) {
  const today = cairoDate();
  const from = toDateStr(p.ValidFrom), to = toDateStr(p.ValidTo);
  const valid = toBool(p.Active) && (!from || from <= today) && (!to || to >= today);
  return {
    id: p.Id, name: p.Name, kind: p.Kind, contactName: p.ContactName, contactPhone: p.ContactPhone, validFrom: from, validTo: to,
    priceMode: p.PriceMode, priceListId: p.PriceListId ?? null, discountPct: p.DiscountPct == null ? null : Number(p.DiscountPct), requiredDocs: p.RequiredDocs,
    visitCap: p.VisitCap == null ? null : pounds(cents(p.VisitCap)), yearCap: p.YearCap == null ? null : pounds(cents(p.YearCap)),
    notes: p.Notes, active: toBool(p.Active), valid, expiresSoon: valid && to && (Date.parse(to) - Date.parse(today)) / 86400e3 <= 30,
    tiers: tiers.filter((t) => t.PayerId === p.Id).map((t) => ({
      id: t.Id, name: t.Name, active: toBool(t.Active),
      coverage: Object.fromEntries(cov.filter((c) => c.TierId === t.Id).map((c) => [c.Dept, Number(c.Pct)])),
    })),
  };
}

async function listPayers(db) {
  const ps = await db.query('SELECT * FROM Payers ORDER BY Active DESC, Name');
  const tiers = await db.query('SELECT * FROM PayerTiers ORDER BY SortOrder, Id');
  const cov = await db.query('SELECT * FROM TierCoverage');
  return ps.map((p) => payerDto(p, tiers, cov));
}

function validatePayer(b) {
  const errors = {};
  const name = cleanName(b.name);
  if (!name) errors.name = 'اكتب اسم الجهة';
  if (!['cash', 'list', 'discount'].includes(b.priceMode)) errors.priceMode = 'اختار طريقة الأسعار';
  let discountPct = null, validFrom = null, validTo = null, visitCap = null, yearCap = null;
  try { discountPct = b.priceMode === 'discount' ? pctVal(b.discountPct) : null; if (b.priceMode === 'discount' && !discountPct) errors.discountPct = 'اكتب نسبة الخصم'; } catch (e) { errors.discountPct = e.message; }
  try { validFrom = dateOrNull(b.validFrom, 'تاريخ البداية'); } catch (e) { errors.validFrom = e.message; }
  try { validTo = dateOrNull(b.validTo, 'تاريخ النهاية'); } catch (e) { errors.validTo = e.message; }
  if (validFrom && validTo && validTo < validFrom) errors.validTo = 'النهاية قبل البداية';
  try { visitCap = optMoney(b.visitCap, 'الحد الأقصى للزيارة'); } catch (e) { errors.visitCap = e.message; }
  try { yearCap = optMoney(b.yearCap, 'الحد الأقصى للسنة'); } catch (e) { errors.yearCap = e.message; }
  const tiers = [];
  const names = new Set();
  for (const t of Array.isArray(b.tiers) ? b.tiers : []) {
    const tn = cleanName(t.name);
    if (!tn) continue;
    if (names.has(tn)) { errors.tiers = `المستوى «${tn}» متكرر`; continue; }
    names.add(tn);
    const coverage = {};
    try { for (const d of deptKeys()) { const v = pctVal(t.coverage?.[d]); if (v != null) coverage[d] = v; } } catch (e) { errors.tiers = `${tn}: ${e.message}`; }
    tiers.push({ id: t.id ? Number(t.id) : null, name: tn, active: t.active === undefined ? true : !!t.active, coverage });
  }
  if (!tiers.length) errors.tiers = 'ضيف مستوى كارنيه واحد على الأقل';
  if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
  return {
    Name: name, Kind: str(b.kind, 30), ContactName: str(b.contactName, 120), ContactPhone: str(b.contactPhone, 30),
    ValidFrom: validFrom, ValidTo: validTo, PriceMode: b.priceMode, PriceListId: b.priceMode === 'list' && b.priceListId ? Number(b.priceListId) : null, DiscountPct: discountPct, RequiredDocs: str(b.requiredDocs, 300),
    VisitCap: visitCap == null ? null : pounds(visitCap), YearCap: yearCap == null ? null : pounds(yearCap), Notes: str(b.notes, 500),
    Active: b.active === undefined ? 1 : (b.active ? 1 : 0), tiers,
  };
}

async function saveTiers(t, payerId, tiers) {
  const existing = await t.query('SELECT * FROM PayerTiers WHERE PayerId = ?', [payerId]);
  const keep = new Set();
  for (let i = 0; i < tiers.length; i++) {
    const x = tiers[i];
    let id = x.id && existing.some((e) => e.Id === x.id) ? x.id : null;
    if (!id) {
      const same = existing.find((e) => e.Name === x.name);
      id = same?.Id || null;
    }
    if (id) await t.run('UPDATE PayerTiers SET Name = ?, SortOrder = ?, Active = ? WHERE Id = ?', [x.name, i, x.active ? 1 : 0, id]);
    else id = await t.insert('PayerTiers', { PayerId: payerId, Name: x.name, SortOrder: i, Active: x.active ? 1 : 0 });
    keep.add(id);
    await t.run('DELETE FROM TierCoverage WHERE TierId = ?', [id]);
    for (const [d, pct] of Object.entries(x.coverage)) await t.insert('TierCoverage', { TierId: id, Dept: d, Pct: pct });
  }
  // المستويات اللي اتشالت: بتتوقف بس (ممكن تكون مستخدمة)
  for (const e of existing) if (!keep.has(e.Id)) await t.run('UPDATE PayerTiers SET Active = 0 WHERE Id = ?', [e.Id]);
}

// ===================== الموافقات =====================
async function approvalRows(db, where, params, limit = 300) {
  return db.query(db.top(
    `SELECT ap.*, py.Name AS PayerName, p.FullName AS PatientName, p.PatientNo, u.FullName AS CreatedByName, u2.FullName AS ReviewedByName,
            vi.ServiceName AS VName, vi.Amount AS VAmount, vi.PaidReceiptId AS VPaid, vi.VisitId, v.VisitNo, v.CardNo AS VCard,
            ai.Name AS AName, ai.Amount AS AAmount, a.AdmissionNo, a.Status AS AStatus, a.CardNo AS ACard, ap.AdmissionId AS AdmId
       FROM Approvals ap JOIN Payers py ON py.Id = ap.PayerId JOIN Patients p ON p.Id = ap.PatientId JOIN Users u ON u.Id = ap.CreatedBy
       LEFT JOIN Users u2 ON u2.Id = ap.ReviewedBy
       LEFT JOIN VisitItems vi ON vi.Id = ap.VisitItemId LEFT JOIN Visits v ON v.Id = vi.VisitId
       LEFT JOIN AdmissionItems ai ON ai.Id = ap.AdmissionItemId LEFT JOIN Admissions a ON a.Id = ap.AdmissionId
      ${where} ORDER BY ap.Id DESC`, limit), params);
}
const approvalDto = (x) => ({
  id: x.Id, scope: x.Scope, status: x.Status, payer: { id: x.PayerId, name: x.PayerName }, patient: { id: x.PatientId, name: x.PatientName, no: x.PatientNo },
  service: x.Scope === 'admission' ? `دخول رقم ${x.AdmissionNo}` : (x.VName || x.AName),
  full: pounds(cents(x.VAmount ?? x.AAmount ?? 0)), amount: pounds(cents(x.Amount)), no: x.ApprovalNo, date: toDateStr(x.ApprovalDate),
  hasImage: !!x.ImageFile, note: x.Note, cardNo: x.VCard || x.ACard,
  createdAt: toIso(x.CreatedAt), createdBy: x.CreatedByName, reviewedAt: toIso(x.ReviewedAt), reviewedBy: x.ReviewedByName, reviewNote: x.ReviewNote,
  visitId: x.VisitId || null, visitNo: x.VisitNo || null, admissionId: x.AdmId || null, admissionNo: x.AdmissionNo || null, paid: x.VPaid != null,
});

export async function approveApproval(t, user, id, { no, date, note }) {
  const ap = await t.one('SELECT * FROM Approvals WHERE Id = ?', [id]);
  if (!ap) throw notFound('الموافقة مش موجودة');
  if (!['pending', 'tempcash'].includes(ap.Status)) throw conflict('الموافقة دي اتراجعت قبل كده');
  const num = str(no, 60) || ap.ApprovalNo;
  if (ap.Status === 'tempcash' && !num) throw bad('اكتب رقم الموافقة اللي وصلت', { errors: { no: 'اكتب رقم الموافقة' } });
  const now = new Date();
  await t.run("UPDATE Approvals SET Status = 'approved', ApprovalNo = ?, ApprovalDate = ?, ReviewedAt = ?, ReviewedBy = ?, ReviewNote = ? WHERE Id = ?",
    [num, dateOrNull(date, 'تاريخ الموافقة') || toDateStr(ap.ApprovalDate), now, user.id, str(note, 300), id]);
  if (ap.VisitItemId) {
    const it = await t.one('SELECT * FROM VisitItems WHERE Id = ?', [ap.VisitItemId]);
    const v = await t.one('SELECT * FROM Visits WHERE Id = ?', [it.VisitId]);
    if (it.Status === 'active') {
      if (ap.Status === 'tempcash') {
        if (it.PaidReceiptId != null) await t.run("UPDATE VisitItems SET CoverStatus = 'approved', RefundDue = PayerAmount WHERE Id = ?", [it.Id]);
        else await t.run("UPDATE VisitItems SET CoverStatus = 'approved', PatientAmount = Amount - PayerAmount WHERE Id = ?", [it.Id]);
      } else await t.run("UPDATE VisitItems SET CoverStatus = 'approved' WHERE Id = ?", [it.Id]);
      if (it.PaidReceiptId != null) {
        await ledgerCharge(t, user, { payerId: ap.PayerId, patientId: ap.PatientId, visitItemId: it.Id, receiptId: it.PaidReceiptId, approvalId: id,
          description: it.ServiceName, cardNo: v.CardNo, full: cents(it.Amount), amount: cents(it.PayerAmount) });
      }
    }
  } else if (ap.AdmissionItemId) {
    const it = await t.one('SELECT * FROM AdmissionItems WHERE Id = ?', [ap.AdmissionItemId]);
    const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [it.AdmissionId]);
    if (it.Status === 'active') {
      await t.run("UPDATE AdmissionItems SET CoverStatus = 'approved' WHERE Id = ?", [it.Id]);
      if (a.Status === 'discharged' && a.PayerStatus !== 'rejected') {
        await ledgerCharge(t, user, { payerId: ap.PayerId, patientId: ap.PatientId, admissionItemId: it.Id, approvalId: id,
          description: `${it.Name} · دخول ${a.AdmissionNo}`, cardNo: a.CardNo, full: cents(it.Amount), amount: cents(it.PayerAmount) });
      }
    }
  }
  await audit(t, user, 'approval.approve', 'Approval', id, { now: { no: num }, note });
}

export async function rejectApproval(t, user, id, { note }) {
  const ap = await t.one('SELECT * FROM Approvals WHERE Id = ?', [id]);
  if (!ap) throw notFound('الموافقة مش موجودة');
  if (!['pending', 'tempcash'].includes(ap.Status)) throw conflict('الموافقة دي اتراجعت قبل كده');
  const reason = str(note, 300);
  if (!reason || reason.length < 3) throw bad('اكتب سبب الرفض', { errors: { note: 'اكتب سبب الرفض' } });
  const now = new Date();
  await t.run("UPDATE Approvals SET Status = 'rejected', ReviewedAt = ?, ReviewedBy = ?, ReviewNote = ? WHERE Id = ?", [now, user.id, reason, id]);
  if (ap.VisitItemId) {
    const it = await t.one('SELECT * FROM VisitItems WHERE Id = ?', [ap.VisitItemId]);
    if (it.Status === 'active') {
      if (ap.Status === 'pending' && it.PaidReceiptId != null && cents(it.PayerAmount) > 0) {
        // المريض دفع نصيبه بس ومشي: الفرق بيبقى عليه في نفس الزيارة
        await t.insert('VisitItems', {
          VisitId: it.VisitId, ServiceId: it.ServiceId, ServiceName: `فرق رفض موافقة: ${it.ServiceName}`, Dept: it.Dept, DoctorId: null, Qty: 1,
          UnitPrice: it.PayerAmount, Amount: it.PayerAmount, PayTiming: 'after', DoctorPct: 0, PayerPct: 0, PayerAmount: 0, PatientAmount: it.PayerAmount,
          CoverStatus: 'none', RefundDue: 0, Status: 'active', AddedAt: now, AddedBy: user.id,
        });
        await t.run("UPDATE VisitItems SET CoverStatus = 'rejected' WHERE Id = ?", [it.Id]);
        await t.run("UPDATE Visits SET Status = 'open', ClosedAt = NULL, ClosedBy = NULL WHERE Id = ?", [it.VisitId]);
      } else {
        await t.run("UPDATE VisitItems SET CoverStatus = 'rejected', PayerAmount = 0, PatientAmount = Amount WHERE Id = ?", [it.Id]);
      }
    }
  } else if (ap.AdmissionItemId) {
    await t.run("UPDATE AdmissionItems SET CoverStatus = 'rejected', PayerAmount = 0, PatientAmount = Amount WHERE Id = ? AND Status = 'active'", [ap.AdmissionItemId]);
  } else if (ap.Scope === 'admission') {
    // موافقة الدخول اترفضت: الحساب كله بيتحول نقدي
    const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [ap.AdmissionId]);
    await t.run("UPDATE Admissions SET PayerStatus = 'rejected' WHERE Id = ?", [a.Id]);
    await t.run("UPDATE AdmissionItems SET CoverStatus = 'rejected', PayerAmount = 0, PatientAmount = Amount WHERE AdmissionId = ? AND Status = 'active' AND PayerAmount > 0", [a.Id]);
    await t.run("UPDATE Approvals SET Status = 'cancelled', ReviewNote = ? WHERE AdmissionId = ? AND Scope = 'item' AND Status = 'pending'", ['موافقة الدخول اترفضت', a.Id]);
    await ledgerReverse(t, user, 'AdmissionItemId IN (SELECT Id FROM AdmissionItems WHERE AdmissionId = ?)', [a.Id]);
  }
  await audit(t, user, 'approval.reject', 'Approval', id, { note: reason });
}

// ===================== المسارات =====================
export default function payersRouter(db) {
  const r = router();

  // ----- قوائم الأسعار المستقلة -----
  const cleanPrices = (b) => ({
    prices: (b.prices || []).filter((x) => x.price !== '' && x.price != null).map((x) => ({ serviceId: intId(x.serviceId, 'الخدمة'), price: parseMoney(x.price, 'السعر') })),
    classPrices: (b.classPrices || []).filter((x) => x.price !== '' && x.price != null).map((x) => ({ classId: intId(x.classId, 'الدرجة'), price: parseMoney(x.price, 'سعر الليلة') })),
  });
  const listDetail = async (id) => {
    const l = await db.one('SELECT * FROM PriceLists WHERE Id = ?', [id]);
    if (!l) throw notFound('القايمة مش موجودة');
    const prices = await db.query('SELECT ServiceId, Price FROM PriceListItems WHERE ListId = ?', [id]);
    const cls = await db.query('SELECT ClassId, NightPrice FROM PriceListClassPrices WHERE ListId = ?', [id]);
    const payers = await db.query('SELECT Id, Name FROM Payers WHERE PriceListId = ? ORDER BY Name', [id]);
    return { list: { id: l.Id, name: l.Name, active: toBool(l.Active), payers: payers.map((p) => ({ id: p.Id, name: p.Name })) },
      prices: prices.map((x) => ({ serviceId: x.ServiceId, price: pounds(cents(x.Price)) })), classPrices: cls.map((x) => ({ classId: x.ClassId, price: pounds(cents(x.NightPrice)) })) };
  };
  async function saveListPrices(t, id, { prices, classPrices }) {
    await t.run('DELETE FROM PriceListItems WHERE ListId = ?', [id]);
    for (const x of prices) await t.insert('PriceListItems', { ListId: id, ServiceId: x.serviceId, Price: pounds(x.price) });
    await t.run('DELETE FROM PriceListClassPrices WHERE ListId = ?', [id]);
    for (const x of classPrices) await t.insert('PriceListClassPrices', { ListId: id, ClassId: x.classId, NightPrice: pounds(x.price) });
  }
  const listName = (b) => {
    const n = cleanName(b.name);
    if (!n) throw bad('اكتب اسم القايمة', { errors: { name: 'اكتب اسم القايمة' } });
    return n;
  };
  r.get('/price-lists', async (req, res) => {
    need(req.user, 'payers.read');
    const lists = await db.query('SELECT l.*, (SELECT COUNT(*) FROM PriceListItems WHERE ListId = l.Id) AS N FROM PriceLists l ORDER BY l.Active DESC, l.Name');
    const payers = await db.query('SELECT Id, Name, PriceListId FROM Payers WHERE PriceListId IS NOT NULL ORDER BY Name');
    res.json({ lists: lists.map((l) => ({ id: l.Id, name: l.Name, active: toBool(l.Active), items: Number(l.N), payers: payers.filter((p) => p.PriceListId === l.Id).map((p) => ({ id: p.Id, name: p.Name })) })) });
  });
  r.get('/price-lists/:id', async (req, res) => { need(req.user, 'payers.read'); res.json(await listDetail(intId(req.params.id))); });
  r.post('/price-lists', async (req, res) => {
    need(req.user, 'payers.manage');
    const b = req.body || {};
    const name = listName(b);
    if (await db.one('SELECT Id FROM PriceLists WHERE Name = ?', [name])) throw bad('فيه قايمة بنفس الاسم', { errors: { name: 'فيه قايمة بنفس الاسم' } });
    const id = await db.tx(async (t) => {
      const lid = await t.insert('PriceLists', { Name: name, Active: 1, CreatedAt: new Date() });
      await saveListPrices(t, lid, cleanPrices(b));
      await audit(t, req.user, 'pricelist.create', 'PriceList', lid, { now: { name } });
      return lid;
    });
    res.status(201).json(await listDetail(id));
  });
  r.put('/price-lists/:id', async (req, res) => {
    need(req.user, 'payers.manage');
    const id = intId(req.params.id);
    const old = await db.one('SELECT * FROM PriceLists WHERE Id = ?', [id]);
    if (!old) throw notFound('القايمة مش موجودة');
    const b = req.body || {};
    const name = listName(b);
    if (await db.one('SELECT Id FROM PriceLists WHERE Name = ? AND Id <> ?', [name, id])) throw bad('فيه قايمة بنفس الاسم', { errors: { name: 'فيه قايمة بنفس الاسم' } });
    const pr = cleanPrices(b);
    await db.tx(async (t) => {
      await t.run('UPDATE PriceLists SET Name = ?, Active = ? WHERE Id = ?', [name, b.active === false ? 0 : 1, id]);
      await saveListPrices(t, id, pr);
      await audit(t, req.user, 'pricelist.update', 'PriceList', id, { old: { name: old.Name }, now: { name, services: pr.prices.length, classes: pr.classPrices.length } });
    });
    res.json(await listDetail(id));
  });
  r.delete('/price-lists/:id', async (req, res) => {
    need(req.user, 'payers.delete');
    const id = intId(req.params.id);
    const old = await db.one('SELECT * FROM PriceLists WHERE Id = ?', [id]);
    if (!old) throw notFound('القايمة مش موجودة');
    if (await db.one('SELECT Id FROM Payers WHERE PriceListId = ?', [id])) throw conflict('فيه جهات مربوطة بالقايمة دي. فُكّها الأول');
    await db.tx(async (t) => {
      await t.run('DELETE FROM PriceListItems WHERE ListId = ?', [id]);
      await t.run('DELETE FROM PriceListClassPrices WHERE ListId = ?', [id]);
      await t.run('DELETE FROM PriceLists WHERE Id = ?', [id]);
      await audit(t, req.user, 'pricelist.delete', 'PriceList', id, { old: { name: old.Name } });
    });
    res.json({ ok: true });
  });
  // تحويل أسعار جهة لقايمة وربطها بيها (نفس الأرقام بالظبط)
  r.post('/:id/convert-to-list', async (req, res) => {
    need(req.user, 'payers.manage');
    const id = intId(req.params.id);
    const p = await db.one('SELECT * FROM Payers WHERE Id = ?', [id]);
    if (!p) throw notFound('الجهة مش موجودة');
    if (p.PriceMode !== 'list' || p.PriceListId) throw bad('الجهة دي أسعارها مش خاصة بيها');
    const name = listName({ name: req.body?.name || `أسعار ${p.Name}` });
    if (await db.one('SELECT Id FROM PriceLists WHERE Name = ?', [name])) throw bad('فيه قايمة بنفس الاسم', { errors: { name: 'فيه قايمة بنفس الاسم' } });
    const lid = await db.tx(async (t) => {
      const lid = await t.insert('PriceLists', { Name: name, Active: 1, CreatedAt: new Date() });
      for (const x of await t.query('SELECT ServiceId, Price FROM PayerPrices WHERE PayerId = ?', [id])) await t.insert('PriceListItems', { ListId: lid, ServiceId: x.ServiceId, Price: x.Price });
      for (const x of await t.query('SELECT ClassId, NightPrice FROM PayerClassPrices WHERE PayerId = ?', [id])) await t.insert('PriceListClassPrices', { ListId: lid, ClassId: x.ClassId, NightPrice: x.NightPrice });
      await t.run('UPDATE Payers SET PriceListId = ? WHERE Id = ?', [lid, id]);
      await t.run('DELETE FROM PayerPrices WHERE PayerId = ?', [id]);
      await t.run('DELETE FROM PayerClassPrices WHERE PayerId = ?', [id]);
      await audit(t, req.user, 'pricelist.create', 'PriceList', lid, { now: { name, fromPayer: p.Name } });
      return lid;
    });
    res.status(201).json(await listDetail(lid));
  });

  r.get('/', async (req, res) => {
    need(req.user, 'payers.read');
    let list = await listPayers(db);
    if (req.query.usable === '1') list = list.filter((p) => p.valid).map((p) => ({ ...p, tiers: p.tiers.filter((t) => t.active) }));
    res.json({ payers: list, depts: { ...DEPTS, drugs: 'الأدوية', supplies: 'المستلزمات' } });
  });

  // بيانات شاشة تعديل الجهة (الخدمات النشطة بسعرها + درجات الغرف): عشان موظف التعاقدات ما يحتاجش صلاحية الإعدادات
  r.get('/editor-data', async (req, res) => {
    need(req.user, 'payers.manage');
    const rows = await db.query(`SELECT s.Id, s.Code, s.Name, s.Dept, ${currentPriceSql()} AS Price FROM Services s WHERE s.Active = 1 ORDER BY s.Dept, s.SortOrder, s.Name`, [new Date()]);
    const cls = await db.query('SELECT Id, Name, NightPrice, Active FROM RoomClasses ORDER BY SortOrder, Id');
    res.json({
      services: rows.map((x) => ({ id: x.Id, code: x.Code, name: x.Name, dept: x.Dept, active: true, price: x.Price == null ? null : pounds(cents(x.Price)) })),
      classes: cls.map((c) => ({ id: c.Id, name: c.Name, nightPrice: c.NightPrice == null ? null : pounds(cents(c.NightPrice)), active: toBool(c.Active) })),
    });
  });

  // ----- أسعار الجهة بالإكسل (من غير ما نحتاج جهة محفوظة: الاستيراد بيرجّع الأسعار للشاشة وبتتحفظ بزرار «احفظ الجهة») -----
  r.get('/prices-export', async (req, res) => {
    need(req.user, 'payers.read');
    const pid = req.query.payer ? intId(req.query.payer, 'الجهة') : null;
    const payer = pid ? await db.one('SELECT Name FROM Payers WHERE Id = ?', [pid]) : null;
    if (pid && !payer) throw notFound('الجهة مش موجودة');
    const svcs = await db.query(`SELECT s.Id, s.Code, s.Name, s.Dept, ${currentPriceSql()} AS Price FROM Services s WHERE s.Active = 1 ORDER BY s.Dept, s.SortOrder, s.Name`, [new Date()]);
    const own = new Map(pid ? (await db.query('SELECT ServiceId, Price FROM PayerPrices WHERE PayerId = ?', [pid])).map((x) => [x.ServiceId, Number(x.Price)]) : []);
    const wb = new ExcelJS.Workbook();
    wb.creator = `نظام ${R.brand.name}`;
    const ws = wb.addWorksheet('أسعار الجهة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = [{ header: 'الكود', key: 'code', width: 12 }, { header: 'اسم الخدمة', key: 'name', width: 38 }, { header: 'القسم', key: 'dept', width: 12 },
      { header: 'سعر المستشفى', key: 'base', width: 14 }, { header: 'سعر الجهة', key: 'price', width: 14 }];
    for (const s of svcs) ws.addRow({ code: s.Code, name: s.Name, dept: DEPTS[s.Dept] || s.Dept, base: s.Price == null ? null : Number(s.Price), price: own.get(s.Id) ?? null });
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } }; c.alignment = { vertical: 'middle', horizontal: 'center' }; });
    ws.getColumn('base').numFmt = R.money.xlsxFormat(); ws.getColumn('price').numFmt = R.money.xlsxFormat();
    const help = wb.addWorksheet('طريقة الاستخدام', { views: [{ rightToLeft: true }] });
    help.getColumn(1).width = 100;
    ['طريقة تعبئة أسعار الجهة من إكسل:', '1) اكتب السعر في عمود «سعر الجهة» للخدمات اللي ليها سعر خاص، وسيب الباقي فاضي (الفاضي = سعر المستشفى).',
      '2) الخدمة بتتعرف بالكود، فما تغيّرش عمود «الكود».', '3) ارفع الملف من «استيراد من إكسل» في شاشة الجهة، وراجع الأسعار، وبعدين دوس «احفظ الجهة».'].forEach((t, i) => { const c = help.getCell(`A${i + 1}`); c.value = t; c.font = { name: 'Arial', size: 12, bold: i === 0 }; });
    const fname = `أسعار-${payer?.Name || 'جهة-جديدة'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payer-prices.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  // الملف raw في الـ body. بيرجّع الأسعار اللي اتقرت + الأخطاء، ومابيحفظش حاجة
  r.post('/prices-import', async (req, res) => {
    need(req.user, 'payers.manage');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('اختار ملف الإكسل');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.body); } catch { throw bad('الملف مش إكسل سليم'); }
    const ws = wb.getWorksheet('أسعار الجهة') || wb.worksheets[0];
    if (!ws) throw bad('الملف فاضي');
    const head = {};
    ws.getRow(1).eachCell((c, i) => { head[String(c.value ?? '').trim()] = i; });
    if (!head['الكود'] || !head['سعر الجهة']) throw bad('ده مش ملف أسعار جهة. نزّل الملف من «تصدير إلى إكسل» واستخدمه');
    const svcs = await db.query('SELECT Id, Code, Name FROM Services');
    const byCode = new Map(svcs.map((x) => [String(x.Code).trim(), x]));
    const prices = [], errors = [], seen = new Set();
    const cellText = (c) => { const v = c?.value; return v == null ? '' : String(typeof v === 'object' && v.result !== undefined ? v.result : v).trim(); };
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const code = cellText(row.getCell(head['الكود']));
      const raw = latinDigits(cellText(row.getCell(head['سعر الجهة']))).replace(/,/g, '');
      if (!code && !raw) return;
      if (!raw) return; // فاضي = سعر المستشفى
      const sv = byCode.get(code);
      if (!sv) { errors.push({ row: n, msg: `الكود «${code}» مش موجود` }); return; }
      if (seen.has(sv.Id)) { errors.push({ row: n, msg: `الكود «${code}» متكرر` }); return; }
      let price;
      try { price = parseMoney(raw, 'السعر'); } catch { errors.push({ row: n, msg: `سعر مش صحيح للكود «${code}»: ${raw}` }); return; }
      seen.add(sv.Id);
      prices.push({ serviceId: sv.Id, code, name: sv.Name, price: pounds(price) });
    });
    res.json({ prices, errors });
  });

  // مسح جهة: المدير بس، وبس لو عمرها ما اتستخدمت. غير كده بتتوقف (مفتاح «شغالة»)
  const PAYER_USES = [['Patients', 'مريض'], ['Visits', 'زيارة'], ['Admissions', 'دخول'], ['Approvals', 'موافقة'], ['PayerLedger', 'حركة في حساب الجهة'], ['ClaimCases', 'حالة مطالبة'], ['Claims', 'مطالبة']];
  const TIER_USES = [['Patients', 'مريض'], ['Visits', 'زيارة'], ['Admissions', 'دخول']];
  const countUses = async (q, uses, id, col) => {
    const out = [];
    for (const [tbl, label] of uses) { const n = Number((await q.one(`SELECT COUNT(*) AS N FROM ${tbl} WHERE ${col} = ?`, [id])).N); if (n) out.push({ label, n }); }
    return out;
  };
  r.delete('/:id', async (req, res) => {
    need(req.user, 'payers.delete');
    const id = intId(req.params.id);
    const p = await db.one('SELECT Id, Name FROM Payers WHERE Id = ?', [id]);
    if (!p) throw notFound('الجهة مش موجودة');
    const uses = await countUses(db, PAYER_USES, id, 'PayerId');
    if (uses.length) throw conflict(`الجهة دي اتستخدمت (${uses.map((u) => `${u.n} ${u.label}`).join('، ')}) فمش هتتمسح عشان الفواتير والمطالبات القديمة. وقّفها بمفتاح «شغالة» وهتختفي من كل الشاشات`, { uses });
    await db.tx(async (t) => {
      await t.run('DELETE FROM TierCoverage WHERE TierId IN (SELECT Id FROM PayerTiers WHERE PayerId = ?)', [id]);
      for (const tbl of ['PayerTiers', 'PayerPrices', 'PayerClassPrices', 'PayerRules']) await t.run(`DELETE FROM ${tbl} WHERE PayerId = ?`, [id]);
      await t.run('DELETE FROM Payers WHERE Id = ?', [id]);
      await audit(t, req.user, 'payer.delete', 'Payer', id, { old: { name: p.Name } });
    });
    res.json({ ok: true });
  });
  r.delete('/:id/tiers/:tid', async (req, res) => {
    need(req.user, 'payers.delete');
    const id = intId(req.params.id), tid = intId(req.params.tid, 'المستوى');
    const tr = await db.one('SELECT Id, Name FROM PayerTiers WHERE Id = ? AND PayerId = ?', [tid, id]);
    if (!tr) throw notFound('المستوى مش موجود');
    const uses = await countUses(db, TIER_USES, tid, 'TierId');
    if (uses.length) throw conflict(`المستوى «${tr.Name}» اتستخدم (${uses.map((u) => `${u.n} ${u.label}`).join('، ')}) فمش هيتمسح. وقّفه بمفتاح «شغال»`, { uses });
    const left = Number((await db.one('SELECT COUNT(*) AS N FROM PayerTiers WHERE PayerId = ? AND Id <> ?', [id, tid])).N);
    if (!left) throw bad('لازم يفضل للجهة مستوى واحد على الأقل');
    await db.tx(async (t) => {
      await t.run('DELETE FROM TierCoverage WHERE TierId = ?', [tid]);
      await t.run('DELETE FROM PayerTiers WHERE Id = ?', [tid]);
      await audit(t, req.user, 'payer.tier.delete', 'Payer', id, { old: { tier: tr.Name } });
    });
    res.json({ ok: true });
  });

  r.get('/:id', async (req, res) => {
    need(req.user, 'payers.read');
    const id = intId(req.params.id);
    const p = (await listPayers(db)).find((x) => x.id === id);
    if (!p) throw notFound('الجهة مش موجودة');
    const prices = await db.query('SELECT pp.ServiceId, pp.Price, s.Name, s.Code, s.Dept FROM PayerPrices pp JOIN Services s ON s.Id = pp.ServiceId WHERE pp.PayerId = ? ORDER BY s.Dept, s.Name', [id]);
    const cls = await db.query('SELECT cp.ClassId, cp.NightPrice, c.Name FROM PayerClassPrices cp JOIN RoomClasses c ON c.Id = cp.ClassId WHERE cp.PayerId = ?', [id]);
    const rules = await db.query('SELECT pr.ServiceId, pr.[Rule] AS R, s.Name, s.Code, s.Dept FROM PayerRules pr JOIN Services s ON s.Id = pr.ServiceId WHERE pr.PayerId = ? ORDER BY s.Name', [id]);
    const pts = await db.one('SELECT COUNT(*) AS N FROM Patients WHERE PayerId = ?', [id]);
    res.json({
      payer: p, patients: Number(pts.N),
      prices: prices.map((x) => ({ serviceId: x.ServiceId, price: pounds(cents(x.Price)), name: x.Name, code: x.Code, dept: x.Dept })),
      classPrices: cls.map((x) => ({ classId: x.ClassId, price: pounds(cents(x.NightPrice)), name: x.Name })),
      rules: rules.map((x) => ({ serviceId: x.ServiceId, rule: x.R, name: x.Name, code: x.Code, dept: x.Dept })),
    });
  });

  r.post('/', async (req, res) => {
    need(req.user, 'payers.manage');
    const x = validatePayer(req.body || {});
    if (await db.one('SELECT Id FROM Payers WHERE Name = ?', [x.Name])) throw bad('في جهة بنفس الاسم', { errors: { name: 'في جهة بنفس الاسم' } });
    const id = await db.tx(async (t) => {
      const { tiers, ...row } = x;
      const pid = await t.insert('Payers', { ...row, CreatedAt: new Date() });
      await saveTiers(t, pid, tiers);
      await audit(t, req.user, 'payer.create', 'Payer', pid, { now: { name: x.Name, tiers: tiers.map((tt) => tt.name) } });
      return pid;
    });
    res.status(201).json({ payer: (await listPayers(db)).find((p) => p.id === id) });
  });

  r.put('/:id', async (req, res) => {
    need(req.user, 'payers.manage');
    const id = intId(req.params.id);
    const old = (await listPayers(db)).find((p) => p.id === id);
    if (!old) throw notFound('الجهة مش موجودة');
    const x = validatePayer(req.body || {});
    if (await db.one('SELECT Id FROM Payers WHERE Name = ? AND Id <> ?', [x.Name, id])) throw bad('في جهة بنفس الاسم', { errors: { name: 'في جهة بنفس الاسم' } });
    await db.tx(async (t) => {
      const { tiers, ...row } = x;
      const cols = Object.keys(row);
      await t.run(`UPDATE Payers SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE Id = ?`, [...cols.map((c) => row[c]), id]);
      await saveTiers(t, id, tiers);
      if (x.PriceListId && !(await t.one('SELECT Id FROM PriceLists WHERE Id = ?', [x.PriceListId]))) throw bad('قايمة الأسعار مش موجودة');
      await audit(t, req.user, 'payer.update', 'Payer', id, { old: { tiers: old.tiers, priceList: old.priceListId }, now: { name: x.Name, tiers, priceList: x.PriceListId } });
    });
    res.json({ payer: (await listPayers(db)).find((p) => p.id === id) });
  });

  // قايمة الأسعار الخاصة (خدمات وليالي)
  r.put('/:id/prices', async (req, res) => {
    need(req.user, 'payers.manage');
    const id = intId(req.params.id);
    const b = req.body || {};
    const prices = (b.prices || []).filter((x) => x.price !== '' && x.price != null).map((x) => ({ serviceId: intId(x.serviceId, 'الخدمة'), price: parseMoney(x.price, 'السعر') }));
    const classPrices = (b.classPrices || []).filter((x) => x.price !== '' && x.price != null).map((x) => ({ classId: intId(x.classId, 'الدرجة'), price: parseMoney(x.price, 'سعر الليلة') }));
    await db.tx(async (t) => {
      await t.run('DELETE FROM PayerPrices WHERE PayerId = ?', [id]);
      for (const x of prices) await t.insert('PayerPrices', { PayerId: id, ServiceId: x.serviceId, Price: pounds(x.price) });
      await t.run('DELETE FROM PayerClassPrices WHERE PayerId = ?', [id]);
      for (const x of classPrices) await t.insert('PayerClassPrices', { PayerId: id, ClassId: x.classId, NightPrice: pounds(x.price) });
      await audit(t, req.user, 'payer.prices', 'Payer', id, { now: { services: prices.length, classes: classPrices.length } });
    });
    res.json({ ok: true });
  });

  // الخدمات المش مغطاة واللي محتاجة موافقة
  r.put('/:id/rules', async (req, res) => {
    need(req.user, 'payers.manage');
    const id = intId(req.params.id);
    const rules = (req.body?.rules || []).filter((x) => ['excluded', 'approval'].includes(x.rule)).map((x) => ({ serviceId: intId(x.serviceId, 'الخدمة'), rule: x.rule }));
    if (new Set(rules.map((x) => x.serviceId)).size !== rules.length) throw bad('في خدمة متكررة');
    await db.tx(async (t) => {
      await t.run('DELETE FROM PayerRules WHERE PayerId = ?', [id]);
      for (const x of rules) await t.insert('PayerRules', { PayerId: id, ServiceId: x.serviceId, '[Rule]': x.rule });
      await audit(t, req.user, 'payer.rules', 'Payer', id, { now: { excluded: rules.filter((x) => x.rule === 'excluded').length, approval: rules.filter((x) => x.rule === 'approval').length } });
    });
    res.json({ ok: true });
  });

  // كشف حساب الجهة (أساس المطالبة الشهرية)
  r.get('/:id/statement', async (req, res) => {
    need(req.user, 'payers.read');
    const id = intId(req.params.id);
    const p = await db.one('SELECT * FROM Payers WHERE Id = ?', [id]);
    if (!p) throw notFound('الجهة مش موجودة');
    const today = cairoDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today.slice(0, 8) + '01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const rows = await db.query(
      `SELECT l.*, pt.FullName, pt.PatientNo, ap.ApprovalNo FROM PayerLedger l JOIN Patients pt ON pt.Id = l.PatientId
         LEFT JOIN Approvals ap ON ap.Id = l.ApprovalId
        WHERE l.PayerId = ? AND l.At >= ? AND l.At < ? ORDER BY l.At, l.Id`,
      [id, cairoDayRange(from).start, cairoDayRange(to).end]);
    const list = rows.map((x) => ({
      id: x.Id, at: toIso(x.At), patient: { name: x.FullName, no: x.PatientNo }, cardNo: x.CardNo, description: x.Description,
      full: pounds(cents(x.FullAmount)), amount: pounds(cents(x.Amount)), approvalNo: x.ApprovalNo, reversal: x.ReversesId != null,
    }));
    const total = rows.reduce((s, x) => s + cents(x.Amount), 0);
    const patients = new Set(rows.map((x) => x.PatientId)).size;
    if (req.query.format !== 'xlsx') return res.json({ payer: { id: p.Id, name: p.Name }, from, to, rows: list, totals: { amount: pounds(total), patients, lines: rows.length } });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('كشف الحساب', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 3 }] });
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `كشف حساب ${p.Name} · من ${from} لـ ${to}`;
    ws.getCell('A1').font = { bold: true, size: 14, name: 'Arial', color: { argb: argb() } };
    ws.getRow(3).values = ['التاريخ', 'المريض', 'رقم الملف', 'رقم الكارنيه', 'البيان', 'رقم الموافقة', 'القيمة الكلية', 'نصيب الجهة'];
    ws.getRow(3).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } }; });
    for (const x of list) ws.addRow([new Date(x.at).toLocaleDateString('en-CA', { timeZone: R.tz }), x.patient.name, x.patient.no, x.cardNo || '', x.description, x.approvalNo || '', x.full, x.amount]);
    const tr = ws.addRow(['', '', '', '', 'الإجمالي', '', '', pounds(total)]);
    tr.font = { bold: true, name: 'Arial' };
    [12, 28, 10, 14, 40, 14, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.getColumn(7).numFmt = R.money.xlsxFormat(); ws.getColumn(8).numFmt = R.money.xlsxFormat();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="statement.xlsx"; filename*=UTF-8''${encodeURIComponent(`كشف-${p.Name}-${from}-${to}.xlsx`)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  return r;
}

export function approvalsRouter(db) {
  const r = router();

  r.get('/', async (req, res) => {
    need(req.user, 'approvals.read');
    const st = req.query.status;
    let where = '', params = [];
    if (st === 'open') { where = "WHERE ap.Status IN ('pending','tempcash')"; }
    else if (['pending', 'tempcash', 'approved', 'rejected'].includes(st)) { where = 'WHERE ap.Status = ?'; params = [st]; }
    else where = "WHERE ap.Status <> 'cancelled'";
    const q = searchKey(req.query.q || '');
    let list = (await approvalRows(db, where, params)).map(approvalDto);
    if (q) list = list.filter((a) => searchKey(a.patient.name + ' ' + a.payer.name + ' ' + (a.no || '') + ' ' + a.service).includes(q));
    const counts = await db.query("SELECT Status, COUNT(*) AS N FROM Approvals WHERE Status IN ('pending','tempcash') GROUP BY Status");
    res.json({ approvals: list, counts: Object.fromEntries(counts.map((c) => [c.Status, Number(c.N)])) });
  });

  r.post('/:id/approve', async (req, res) => {
    need(req.user, 'approvals.review');
    const id = intId(req.params.id);
    await db.tx((t) => approveApproval(t, req.user, id, req.body || {}));
    res.json({ approval: approvalDto((await approvalRows(db, 'WHERE ap.Id = ?', [id]))[0]) });
  });
  r.post('/:id/reject', async (req, res) => {
    need(req.user, 'approvals.review');
    const id = intId(req.params.id);
    await db.tx((t) => rejectApproval(t, req.user, id, req.body || {}));
    res.json({ approval: approvalDto((await approvalRows(db, 'WHERE ap.Id = ?', [id]))[0]) });
  });
  // تسجيل رقم الموافقة لما توصل (للنقدي المؤقت أو اللي اتسجلت من غير رقم)
  r.post('/:id/info', async (req, res) => {
    need(req.user, 'approvals.create');
    const id = intId(req.params.id);
    const ap = await db.one('SELECT * FROM Approvals WHERE Id = ?', [id]);
    if (!ap) throw notFound('الموافقة مش موجودة');
    if (!['pending', 'tempcash'].includes(ap.Status)) throw conflict('الموافقة دي اتراجعت');
    const no = str(req.body?.no, 60);
    if (!no) throw bad('اكتب رقم الموافقة', { errors: { no: 'اكتب رقم الموافقة' } });
    await db.tx(async (t) => {
      await t.run('UPDATE Approvals SET ApprovalNo = ?, ApprovalDate = ? WHERE Id = ?', [no, dateOrNull(req.body?.date, 'التاريخ'), id]);
      await audit(t, req.user, 'approval.info', 'Approval', id, { now: { no } });
    });
    res.json({ approval: approvalDto((await approvalRows(db, 'WHERE ap.Id = ?', [id]))[0]) });
  });

  // صورة الموافقة (الملف بييجي raw)
  r.post('/:id/image', async (req, res) => {
    need(req.user, 'approvals.create');
    const id = intId(req.params.id);
    const ap = await db.one('SELECT Id FROM Approvals WHERE Id = ?', [id]);
    if (!ap) throw notFound('الموافقة مش موجودة');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) throw bad('اختار صورة');
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.slice(0, 4).toString('hex') === '89504e47' ? 'png'
      : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? 'webp' : buf.slice(0, 4).toString() === '%PDF' ? 'pdf' : null;
    if (!ext) throw bad('الملف لازم يكون صورة (JPG / PNG) أو PDF');
    const dir = path.join(UPLOAD_DIR, 'approvals');
    mkdirSync(dir, { recursive: true });
    const name = `${id}-${Date.now()}.${ext}`;
    writeFileSync(path.join(dir, name), buf);
    await db.tx(async (t) => {
      await t.run('UPDATE Approvals SET ImageFile = ? WHERE Id = ?', [name, id]);
      await audit(t, req.user, 'approval.image', 'Approval', id);
    });
    res.json({ ok: true });
  });
  r.get('/:id/image', async (req, res) => {
    need(req.user, 'approvals.read');
    const ap = await db.one('SELECT ImageFile FROM Approvals WHERE Id = ?', [intId(req.params.id)]);
    const file = ap?.ImageFile && path.join(UPLOAD_DIR, 'approvals', path.basename(ap.ImageFile));
    if (!file || !existsSync(file)) throw notFound('مفيش صورة');
    res.type(path.extname(file).slice(1));
    res.set('Cache-Control', 'private, max-age=3600');
    createReadStream(file).pipe(res);
  });

  return r;
}
