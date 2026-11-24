// حسابات الإقامة: التذكرة اليومية (دفعات)، أصناف الأدوية والمستلزمات، قفل التذكرة وفتحها، المستحقات اللاحقة
import { R, argb } from '../lib/runtime.js';
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, parseMoney, cairoDate } from '../lib/util.js';
import { toIso, toDateStr, toBool } from '../db/index.js';
import { searchKey, latinDigits } from '../../shared/text.js';
import { getService, resolveDoctorShare } from './catalog.js';
import {
  admissionDetails, admissionPayer, postNights, postAllNights, loadActive, loadOpen, dischargeAdmission, payAdmission, EARLY_OUT,
} from './admissions.js';
import { servicePrice, cover } from '../lib/coverage.js';
import { mustOrder, shiftLabel, businessDate, SHIFT_LABELS } from '../lib/cashier.js';
import { floorAt, floorOnDate, floorServicePrice } from '../lib/floor-prices.js';
import { consume, giveBack, floorStore, deductOn, unitsOf, deptStore } from '../lib/stock.js';
import { CATS, TICKET_CATS, STOCK_KINDS, COVER_DEPT, ticketOn, stockPrice, stockDto } from '../lib/tickets.js';
import { qty2, pct2 } from '../../shared/money.js';
import { ensureUnits } from '../lib/units.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };
const anyOf = (user, perms) => { if (!perms.some((p) => can(user, p))) throw forbidden(); };

/** بند واحد من التذكرة: بيتحقق ويتسعّر (بالقروش) */
async function priceLine(t, payer, l, idx, floorId = null) {
  const where = `البند ${idx + 1}`;
  const cat = l?.cat;
  if (!TICKET_CATS.includes(cat)) throw bad(`${where}: النوع مش صحيح`);
  const qty = Number(latinDigits(l.qty ?? 1));
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad(`${where}: العدد مش صحيح`);
  if (cat === 'drug' || cat === 'supply') {
    const it = await t.one('SELECT * FROM StockItems WHERE Id = ?', [Number(l.stockItemId) || 0]);
    if (!it || !toBool(it.Active)) throw bad(`${where}: الصنف مش موجود أو موقوف`);
    if (it.Kind !== cat) throw bad(`${where}: «${it.Name}» مش ${CATS[cat]}`);
    const units = unitsOf(it);
    const u = units.find((x) => x.key === (l.unit || it.DefaultSaleUnit || 'base')) || units[0];
    const unit = stockPrice(payer, cents(it.Price) * u.factor);
    return { cat, qty, unit, name: it.Name + (u.name ? ` (${u.name})` : ''), dept: COVER_DEPT[cat], stockItemId: it.Id, serviceId: null, doctorId: null, pct: 0, includedNights: null, floorId, factor: u.factor, itemName: it.Name };
  }
  const svc = await getService(t, Number(l.serviceId) || 0);
  if (!svc || !svc.active || svc.price == null) throw bad(`${where}: الخدمة مش متاحة`);
  const doctorId = l.doctorId ? Number(l.doctorId) : null;
  if (doctorId && !(await t.one('SELECT Id FROM Doctors WHERE Id = ?', [doctorId]))) throw bad(`${where}: الدكتور مش موجود`);
  if ((svc.hasDoctor || cat === 'fee' || cat === 'visit') && !doctorId) throw bad(`${where}: اختار الدكتور لـ «${svc.name}»`);
  let unit;
  if (svc.openPrice && l.price !== undefined && l.price !== '' && l.price !== null) {
    unit = parseMoney(l.price, `${where}: المبلغ`);
    if (unit <= 0) throw bad(`${where}: اكتب المبلغ`);
  } else {
    // الأتعاب بسعرها، والخدمات والزيارات بسعر الدور اللي المريض فيه
    const base = cat === 'fee' ? cents(svc.price) : await floorServicePrice(t, floorId, svc.id, cents(svc.price));
    unit = await servicePrice(t, payer, svc.id, base);
  }
  const share = await resolveDoctorShare(t, doctorId, svc.id, svc.dept);
  return { cat, qty, unit, name: svc.name, dept: svc.dept, stockItemId: null, serviceId: svc.id, doctorId, pct: share.pct, fixed: share.fixed, includedNights: svc.includedNights || null, floorId };
}

/** تسجيل بند على حساب الإقامة (مع نصيب التعاقد والموافقة) */
/** خصم الأدوية والمستلزمات من مخزن الدور اللي المريض فيه */
async function deductFor(t, user, p, refType, refId) {
  if (!p.stockItemId || !(await deductOn(t))) return null;
  let st = p.storeId ? await t.one('SELECT * FROM Stores WHERE Id = ? AND Active = 1', [p.storeId]) : await floorStore(t, p.floorId);
  if (!st) {
    const f = p.floorId ? await t.one('SELECT Number FROM Floors WHERE Id = ?', [p.floorId]) : null;
    throw conflict(`مفيش مخزن مربوط بـ${f ? `الدور ${f.Number}` : 'دور المريض'}. المدير يربطه من المخازن، أو اختار المخزن من «اتصرف من»`);
  }
  const kind = p.cat === 'drug' ? 'drug' : 'supply';
  if (st.Holds !== 'all' && st.Holds !== kind) throw bad(`«${st.Name}» مش بيشيل ${kind === 'drug' ? 'أدوية' : 'مستلزمات'}`);
  await consume(t, user, { storeId: st.Id, itemId: p.stockItemId, qty: p.qty * (p.factor || 1), kind: refType === 'late' ? 'late' : 'ticket', refType, refId, negative: can(user, 'stock.negative'), itemName: p.itemName });
  return st.Id;
}

/** المخزن اللي بيتصرف منه للمقيم يوم معين: العناية/الحضانة لو سريره هناك، وإلا مخزن الدور */
export async function defaultTicketStore(t, a, dateStr) {
  const fl = await floorOnDate(t, a, dateStr);
  const at = dateStr >= cairoDate() ? new Date() : new Date(new Date(dateStr + 'T23:59:00+02:00'));
  const mv = await t.one(t.top('SELECT c.Kind FROM BedMoves m JOIN RoomClasses c ON c.Id = m.ClassId WHERE m.AdmissionId = ? AND m.FromAt <= ? ORDER BY m.FromAt DESC, m.Id DESC', 1), [a.Id, at]);
  if (mv && mv.Kind !== 'ward') { const ds = await deptStore(t, mv.Kind); if (ds) return ds; }
  return floorStore(t, fl);
}
/** «اتصرف من»: مخزن تختاره الحسابات (فرعي أو صيدلية) */
async function pickStore(t, id) {
  if (!id) return null;
  const st = await t.one('SELECT * FROM Stores WHERE Id = ? AND Active = 1', [Number(id) || 0]);
  if (!st || st.Kind === 'main') throw bad('اختار مخزن فرعي أو الصيدلية');
  return st;
}

async function insertLine(t, user, a, payer, p, { ticketId = null, date = null, note = null, now = new Date() } = {}) {
  const amount = p.unit * p.qty;
  const c = await cover(t, payer, { serviceId: p.serviceId, dept: p.dept, amount, patientId: a.PatientId, admissionId: a.Id });
  const st = c.status === 'needs' ? 'pending' : c.status;
  const iid = await t.insert('AdmissionItems', {
    AdmissionId: a.Id, Kind: 'service', ServiceId: p.serviceId, Name: p.name, Dept: p.dept, DoctorId: p.doctorId, Qty: p.qty,
    UnitPrice: pounds(p.unit), Amount: pounds(amount), DoctorPct: p.pct, DoctorFixed: pounds(p.fixed || 0), ChargeDate: date, ClassId: null, IncludedNights: p.includedNights,
    PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: st,
    Note: note, Status: 'active', AddedAt: now, AddedBy: user.id, TicketId: ticketId, StockItemId: p.stockItemId, Cat: p.cat, FloorId: p.floorId ?? null,
    UnitFactor: p.stockItemId ? (p.factor || 1) : null,
  });
  const sid = await deductFor(t, user, p, 'admitem', iid);
  if (sid) await t.run('UPDATE AdmissionItems SET StoreId = ? WHERE Id = ?', [sid, iid]);
  if (st === 'pending') {
    await t.insert('Approvals', {
      Scope: 'item', PayerId: payer.id, PatientId: a.PatientId, VisitItemId: null, AdmissionItemId: iid, AdmissionId: a.Id,
      ApprovalNo: null, ApprovalDate: null, Status: 'pending', Amount: pounds(c.payerAmount), Note: 'من التذكرة', CreatedAt: now, CreatedBy: user.id,
    });
  }
  return { id: iid, amount, cover: st };
}

const FRESH_MS = 15 * 60e3;
async function refreshTicketTotals(t, tid) {
  const r = await t.one("SELECT COUNT(*) AS N, SUM(Amount) AS S FROM AdmissionItems WHERE TicketId = ? AND Status = 'active'", [tid]);
  await t.run('UPDATE Tickets SET Lines = ?, Total = ? WHERE Id = ?', [Number(r?.N || 0), pounds(cents(r?.S)), tid]);
}

/** التذكرة: الحساب + الدفعات + الأيام */
async function ticketDetails(db, id) {
  const d = await admissionDetails(db, id);
  const tks = await db.query(
    `SELECT tk.*, u.FullName AS ByName, st.Name AS StoreName FROM Tickets tk JOIN Users u ON u.Id = tk.CreatedBy LEFT JOIN Stores st ON st.Id = tk.StoreId WHERE tk.AdmissionId = ? ORDER BY tk.TicketDate, tk.Id`, [id]);
  const tickets = tks.map((tk) => {
    const items = d.items.filter((i) => i.ticketId === tk.Id);
    const live = items.filter((i) => i.status === 'active');
    return {
      id: tk.Id, no: tk.TicketNo, date: toDateStr(tk.TicketDate), shift: tk.ShiftLabel, shiftName: SHIFT_LABELS[tk.ShiftLabel] || '',
      paperNo: tk.PaperNo, note: tk.Note, createdAt: toIso(tk.CreatedAt), createdBy: tk.ByName, createdById: tk.CreatedBy, storeId: tk.StoreId, storeName: tk.StoreName,
      lines: live.length, voided: items.length - live.length, total: pounds(live.reduce((s, i) => s + cents(i.amount), 0)), items: items.map((i) => i.id),
    };
  });
  const a = d.admission;
  const first = cairoDate(new Date(a.admittedAt));
  const last = a.status === 'discharged' ? cairoDate(new Date(a.dischargedAt)) : a.bill.status === 'closed' ? cairoDate(new Date(a.bill.closedAt)) : cairoDate();
  const days = [];
  for (let x = first; x <= last && days.length < 400; x = addDays(x, 1)) {
    const mine = tickets.filter((tk) => tk.date === x);
    days.push({ date: x, tickets: mine.length, total: pounds(mine.reduce((s, tk) => s + cents(tk.total), 0)) });
  }
  const today = cairoDate();
  const missing = days.filter((x) => x.date < today && !x.tickets).map((x) => x.date);
  // الدور في كل يوم وأسعاره (عشان الشاشة تعرض السعر الصح)
  const aRow = await db.one('SELECT * FROM Admissions WHERE Id = ?', [id]);
  for (const x of days) x.floorId = await floorOnDate(db, aRow, x.date);
  const fids = [...new Set(days.map((x) => x.floorId).filter(Boolean))];
  const floors = {}, floorSvc = {};
  for (const f of fids) {
    const fr = await db.one('SELECT Id, Number, Name FROM Floors WHERE Id = ?', [f]);
    floors[f] = { id: f, no: fr?.Number, name: fr?.Name };
    floorSvc[f] = Object.fromEntries((await db.query('SELECT ServiceId, Price FROM FloorServicePrices WHERE FloorId = ?', [f])).map((r) => [r.ServiceId, Number(r.Price)]));
  }
  // المخازن اللي ممكن يتصرف منها، والمخزن الافتراضي لكل يوم، والرصيد (عشان الحسابات تشوف المتاح وهي بتكتب)
  for (const x of days) x.storeId = (await defaultTicketStore(db, aRow, x.date))?.Id || null;
  const stRows = await db.query("SELECT * FROM Stores WHERE Active = 1 AND Kind <> 'main' ORDER BY SortOrder, Id");
  const stores = stRows.map((x) => ({ id: x.Id, name: x.Name, kind: x.Kind, holds: x.Holds, dept: x.Dept }));
  const stockByStore = {};
  for (const r of await db.query(`SELECT StoreId, ItemId, SUM(Qty) AS Q FROM StockBatches WHERE StoreId IN (${stRows.map(() => '?').join(',') || 'NULL'}) GROUP BY StoreId, ItemId`, stRows.map((x) => x.Id))) {
    (stockByStore[r.StoreId] ||= {})[r.ItemId] = qty2(r.Q);
  }
  return { ...d, tickets, days, missing, floors, floorSvc, stores, stockByStore, stockDeduct: await deductOn(db), cats: CATS, ticketMode: await ticketOn(db), defaultDate: businessDate() < first ? first : businessDate() };
}

async function nextStockCode(t, kind) {
  const pre = kind === 'drug' ? 'D-' : 'S-';
  const rows = await t.query('SELECT Code FROM StockItems WHERE Code LIKE ?', [pre + '%']);
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.Code).slice(2)) || 0), 0);
  return pre + String(max + 1).padStart(4, '0');
}
function validateStock(b) {
  const errors = {};
  const name = str(b.name, 150);
  if (!name || name.length < 2) errors.name = 'اكتب اسم الصنف';
  if (!STOCK_KINDS[b.kind]) errors.kind = 'اختار دواء ولا مستلزم';
  let price = 0;
  try { price = parseMoney(b.price, 'السعر'); } catch (e) { errors.price = e.message; }
  const code = b.code ? latinDigits(String(b.code)).toUpperCase().replace(/\s+/g, '') : '';
  if (code && !/^[A-Z0-9-_.]{1,30}$/.test(code)) errors.code = 'الكود حروف إنجليزي وأرقام بس';
  const intOrNull = (v, f) => { if (v === '' || v == null) return null; const n = Number(latinDigits(v)); if (!Number.isInteger(n) || n < 2 || n > 100000) { errors[f] = 'رقم صحيح أكبر من 1'; return null; } return n; };
  const midQty = b.midUnit ? intOrNull(b.midQty, 'midQty') : null;
  const packQty = b.packUnit ? intOrNull(b.packQty, 'packQty') : null;
  if (b.midUnit && !midQty && !errors.midQty) errors.midQty = 'فيها كام من الوحدة الصغيرة؟';
  if (b.packUnit && !packQty && !errors.packQty) errors.packQty = 'فيها كام من الوحدة الصغيرة؟';
  if (midQty && packQty && packQty <= midQty) errors.packQty = 'الكبيرة لازم أكبر من الوسطى';
  let minQty = null;
  if (b.minQty !== '' && b.minQty != null) { minQty = Number(latinDigits(b.minQty)); if (!(minQty >= 0)) { errors.minQty = 'رقم مش صحيح'; minQty = null; } }
  const unitKeys = ['base', ...(midQty ? ['mid'] : []), ...(packQty ? ['pack'] : [])];
  const dflt = (v, f) => { const x = v ? String(v) : ''; if (x && !unitKeys.includes(x)) errors[f] = 'الوحدة دي مش متعرّفة للصنف'; return x || null; };
  const saleUnit = dflt(b.saleUnit, 'saleUnit'), purchaseUnit = dflt(b.purchaseUnit, 'purchaseUnit');
  if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
  return { saleUnit, purchaseUnit, code, name, kind: b.kind, unit: str(b.unit, 30), price, barcode: str(b.barcode, 60), active: b.active === undefined ? true : !!b.active,
    midUnit: midQty ? str(b.midUnit, 30) : null, midQty, packUnit: packQty ? str(b.packUnit, 30) : null, packQty, minQty };
}

const STOCK_HEAD = {
  code: ['الكود', 'كود', 'code'], name: ['اسم الصنف', 'الاسم', 'الصنف', 'name'], kind: ['النوع', 'kind'],
  unit: ['الوحدة', 'unit'], price: ['السعر', 'price'], barcode: ['الباركود', 'barcode'], active: ['فعال', 'فعالة', 'active'],
};
const KIND_AR = { drug: 'دواء', supply: 'مستلزم' };
const kindFrom = (s) => { const k = searchKey(s); if (!k) return null; if (['دواء', 'ادويه', 'ادوية', 'drug'].map(searchKey).includes(k)) return 'drug'; if (['مستلزم', 'مستلزمات', 'supply'].map(searchKey).includes(k)) return 'supply'; return 'bad'; };

export default function ticketsRouter(db) {
  const r = router();

  // ===== شاشة الحسابات: كل المرضى المقيمين وحالة التذكرة =====
  r.get('/board', async (req, res) => {
    anyOf(req.user, ['adm.bill', 'adm.close']);
    await postAllNights(db);
    const today = cairoDate();
    const rows = await db.query(
      `SELECT a.Id, a.AdmissionNo, a.Type, a.AdmittedAt, a.BillStatus, a.ClosedAt, p.Id AS PatientId, p.FullName, p.PatientNo, p.Sex, d.Name AS DoctorName,
              b.Label, r.Number AS RoomNo, f.Number AS FloorNo, f.Name AS FloorName, c.Name AS ClassName, py.Name AS PayerName,
              (SELECT SUM(PatientAmount) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active') AS Total,
              (SELECT SUM(Amount) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active') AS Gross,
              (SELECT SUM(Net) FROM Receipts WHERE AdmissionId = a.Id) AS Paid
         FROM Admissions a JOIN Patients p ON p.Id = a.PatientId LEFT JOIN Doctors d ON d.Id = a.DoctorId LEFT JOIN Payers py ON py.Id = a.PayerId
         JOIN Beds b ON b.Id = a.BedId JOIN Rooms r ON r.Id = b.RoomId JOIN Floors f ON f.Id = r.FloorId JOIN RoomClasses c ON c.Id = r.ClassId
        WHERE a.Status = 'active' ORDER BY f.Number, r.Number, b.Label`);
    const tk = rows.length ? await db.query(
      `SELECT tk.AdmissionId, tk.TicketDate, tk.CreatedAt, u.FullName FROM Tickets tk JOIN Users u ON u.Id = tk.CreatedBy
        WHERE tk.AdmissionId IN (${rows.map(() => '?').join(',')}) ORDER BY tk.CreatedAt`, rows.map((x) => x.Id)) : [];
    const orders = rows.length ? await db.query(
      `SELECT AdmissionId, OrderNo, Amount FROM PayOrders WHERE Kind = 'discharge' AND Status = 'pending' AND AdmissionId IN (${rows.map(() => '?').join(',')})`, rows.map((x) => x.Id)) : [];
    const list = rows.map((x) => {
      const mine = tk.filter((k) => k.AdmissionId === x.Id);
      const dates = new Set(mine.map((k) => toDateStr(k.TicketDate)));
      const first = cairoDate(new Date(x.AdmittedAt));
      const missing = [];
      for (let dd = first; dd < today && missing.length < 60; dd = addDays(dd, 1)) if (!dates.has(dd)) missing.push(dd);
      const lastT = mine.at(-1);
      const ord = orders.find((o) => o.AdmissionId === x.Id);
      const total = cents(x.Total), paid = cents(x.Paid);
      return {
        id: x.Id, no: x.AdmissionNo, type: x.Type, admittedAt: toIso(x.AdmittedAt), doctor: x.DoctorName,
        patient: { id: x.PatientId, name: x.FullName, no: x.PatientNo, sex: x.Sex },
        bed: { label: x.Label, room: x.RoomNo, floor: x.FloorNo, floorName: x.FloorName, className: x.ClassName },
        payer: x.PayerName || null, gross: pounds(cents(x.Gross)), total: pounds(total), paid: pounds(paid), balance: pounds(total - paid),
        ticketsToday: mine.filter((k) => toDateStr(k.TicketDate) === today).length, tickets: mine.length,
        lastTicket: lastT ? { at: toIso(lastT.CreatedAt), by: lastT.FullName } : null, missing,
        closed: x.BillStatus === 'closed', closedAt: toIso(x.ClosedAt), order: ord ? { no: ord.OrderNo, amount: Number(ord.Amount) } : null,
      };
    });
    const late = await db.one("SELECT COUNT(*) AS N FROM LateCharges WHERE Status = 'open'");
    res.json({
      today, admissions: list,
      counts: {
        total: list.length, noTicketToday: list.filter((x) => !x.closed && !x.ticketsToday).length,
        missing: list.filter((x) => x.missing.length).length, closed: list.filter((x) => x.closed).length, late: Number(late?.N || 0),
      },
    });
  });

  // ===== تذكرة مريض =====
  r.get('/adm/:id', async (req, res) => {
    anyOf(req.user, ['adm.bill', 'adm.close', 'admissions.read']);
    res.json(await ticketDetails(db, intId(req.params.id)));
  });

  // دفعة تذكرة جديدة: كل البنود اللي نزلت في المرة دي
  r.post('/adm/:id', async (req, res) => {
    need(req.user, 'adm.bill');
    const id = intId(req.params.id);
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw bad('ضيف بنود التذكرة الأول');
    if (lines.length > 300) throw bad('بنود كتير قوي في مرة واحدة. قسّمها');
    const out = await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      const first = cairoDate(new Date(a.AdmittedAt));
      const date = DATE_RE.test(b.date || '') ? b.date : (businessDate() < first ? first : businessDate()); // مريض دخل بعد نص الليل: اليوم الافتراضي يوم دخوله
      if (date < first) throw bad('التاريخ قبل يوم الدخول', { errors: { date: 'التاريخ قبل يوم الدخول' } });
      if (date > cairoDate()) throw bad('التاريخ لسه ما جاش', { errors: { date: 'التاريخ لسه ما جاش' } });
      const payer = await admissionPayer(t, a);
      const floorId = await floorOnDate(t, a, date);
      const store = (await pickStore(t, b.storeId)) || (await defaultTicketStore(t, a, date));
      const priced = [];
      for (let k = 0; k < lines.length; k++) priced.push({ ...(await priceLine(t, payer, lines[k], k, floorId)), storeId: store?.Id || null });
      const now = new Date();
      const no = await t.nextNumber('ticket');
      const total = priced.reduce((s, p) => s + p.unit * p.qty, 0);
      const tid = await t.insert('Tickets', {
        TicketNo: no, AdmissionId: id, TicketDate: date, ShiftLabel: shiftLabel(now), PaperNo: str(b.paperNo, 30), Note: str(b.note, 300),
        Lines: priced.length, Total: pounds(total), CreatedAt: now, CreatedBy: req.user.id, StoreId: store?.Id || null,
      });
      let pending = 0, pkg = false;
      for (const p of priced) {
        const x = await insertLine(t, req.user, a, payer, p, { ticketId: tid, date, now });
        if (x.cover === 'pending') pending++;
        if (p.includedNights) pkg = true;
      }
      if (pkg) await postNights(t, id);
      await audit(t, req.user, 'ticket.create', 'Admission', id, { now: { no, date, lines: priced.length, total: pounds(total), paperNo: str(b.paperNo, 30) } });
      return { tid, no, total, pending };
    });
    res.status(201).json({ ticket: { id: out.tid, no: out.no, total: pounds(out.total), pendingApprovals: out.pending }, ...(await ticketDetails(db, id)) });
  });

  // سطر واحد بيتحفظ أول ما يتكتب (من غير زرار حفظ). ticketId = الدفعة اللي الموظف شغال فيها، ولو مش صالحة بتتعمل دفعة جديدة
  r.post('/adm/:id/lines', async (req, res) => {
    need(req.user, 'adm.bill');
    const id = intId(req.params.id);
    const b = req.body || {};
    const out = await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      const first = cairoDate(new Date(a.AdmittedAt));
      const date = DATE_RE.test(b.date || '') ? b.date : (businessDate() < first ? first : businessDate()); // مريض دخل بعد نص الليل: اليوم الافتراضي يوم دخوله
      if (date < first) throw bad('التاريخ قبل يوم الدخول', { errors: { date: 'التاريخ قبل يوم الدخول' } });
      if (date > cairoDate()) throw bad('التاريخ لسه ما جاش', { errors: { date: 'التاريخ لسه ما جاش' } });
      const payer = await admissionPayer(t, a);
      const store = (await pickStore(t, b.storeId)) || (await defaultTicketStore(t, a, date));
      const p = { ...(await priceLine(t, payer, b.line || {}, 0, await floorOnDate(t, a, date))), storeId: store?.Id || null };
      const now = new Date();
      let tk = b.ticketId ? await t.one('SELECT * FROM Tickets WHERE Id = ?', [Number(b.ticketId) || 0]) : null;
      if (tk && !(tk.AdmissionId === id && tk.CreatedBy === req.user.id && toDateStr(tk.TicketDate) === date && now - new Date(tk.CreatedAt) < 12 * 3600e3
        && (tk.StoreId || null) === (store?.Id || null))) tk = null;
      if (!tk) {
        const no = await t.nextNumber('ticket');
        const tid = await t.insert('Tickets', {
          TicketNo: no, AdmissionId: id, TicketDate: date, ShiftLabel: shiftLabel(now), PaperNo: str(b.paperNo, 30), Note: null,
          Lines: 0, Total: 0, CreatedAt: now, CreatedBy: req.user.id, StoreId: store?.Id || null,
        });
        tk = await t.one('SELECT * FROM Tickets WHERE Id = ?', [tid]);
        await audit(t, req.user, 'ticket.create', 'Admission', id, { now: { no, date, paperNo: str(b.paperNo, 30) } });
      }
      const x = await insertLine(t, req.user, a, payer, p, { ticketId: tk.Id, date, now });
      await refreshTicketTotals(t, tk.Id);
      if (p.includedNights) await postNights(t, id);
      return { ticket: { id: tk.Id, no: tk.TicketNo }, itemId: x.id, pending: x.cover === 'pending' };
    });
    res.status(201).json({ ...out, ...(await ticketDetails(db, id)) });
  });

  // تعديل العدد (أو المبلغ للسعر المفتوح) لسطر في التذكرة قبل القفل
  r.patch('/adm/:id/items/:itemId', async (req, res) => {
    need(req.user, 'adm.bill');
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    const b = req.body || {};
    await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      const it = await t.one('SELECT * FROM AdmissionItems WHERE Id = ? AND AdmissionId = ?', [itemId, id]);
      if (!it || it.Status !== 'active' || it.Kind === 'night') throw notFound('البند مش موجود');
      if (it.AddedBy !== req.user.id && !can(req.user, 'adm.reopen')) throw forbidden('تعديل سطر كتبه موظف تاني محتاج مشرف الحسابات. شيله بسبب واكتبه تاني');
      if (['approved', 'rejected', 'tempcash'].includes(it.CoverStatus)) throw conflict('البند ده اتاخد فيه قرار من التعاقدات. شيله بسبب واكتبه تاني');
      const qty = b.qty === undefined ? it.Qty : Number(latinDigits(b.qty));
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad('العدد مش صحيح');
      let unit = cents(it.UnitPrice);
      let factor = Number(it.UnitFactor || 1), name = it.Name;
      if (b.unit !== undefined && it.StockItemId) {
        const si = await t.one('SELECT * FROM StockItems WHERE Id = ?', [it.StockItemId]);
        const u = unitsOf(si).find((x) => x.key === b.unit);
        if (!u) throw bad('الوحدة مش صحيحة');
        const payer0 = await admissionPayer(t, a);
        factor = u.factor; unit = stockPrice(payer0, cents(si.Price) * factor); name = `${si.Name} (${u.name})`;
      }
      if (b.price !== undefined && b.price !== '') {
        const svc = it.ServiceId ? await t.one('SELECT OpenPrice FROM Services WHERE Id = ?', [it.ServiceId]) : null;
        if (!svc || !toBool(svc.OpenPrice)) throw bad('السعر ده مش مفتوح');
        unit = parseMoney(b.price, 'المبلغ');
        if (unit <= 0) throw bad('اكتب المبلغ');
      }
      if (qty === it.Qty && unit === cents(it.UnitPrice) && factor === Number(it.UnitFactor || 1)) return;
      // فرق الكمية في المخزن
      if (it.StoreId) {
        const diff = qty * factor - it.Qty * Number(it.UnitFactor || 1);
        if (diff > 0) await consume(t, req.user, { storeId: it.StoreId, itemId: it.StockItemId, qty: diff, kind: 'ticket', refType: 'admitem', refId: itemId, negative: can(req.user, 'stock.negative'), itemName: name });
        else if (diff < 0) await giveBack(t, req.user, { refType: 'admitem', refId: itemId, qty: -diff, kind: 'ticket_back', note: 'تعديل العدد' });
      }
      const amount = unit * qty;
      const payer = await admissionPayer(t, a);
      await t.run('UPDATE AdmissionItems SET PayerAmount = 0 WHERE Id = ?', [itemId]);
      const dept = it.Dept;
      const c = await cover(t, payer, { serviceId: it.ServiceId, dept, amount, patientId: a.PatientId, admissionId: id });
      const st = it.CoverStatus === 'pending' ? 'pending' : (c.status === 'needs' ? 'pending' : c.status);
      await t.run('UPDATE AdmissionItems SET Qty = ?, UnitPrice = ?, Amount = ?, PayerPct = ?, PayerAmount = ?, PatientAmount = ?, CoverStatus = ?, UnitFactor = ?, Name = ? WHERE Id = ?',
        [qty, pounds(unit), pounds(amount), c.pct, pounds(c.payerAmount), pounds(c.patientAmount), st, it.StockItemId ? factor : null, name, itemId]);
      await t.run("UPDATE Approvals SET Amount = ? WHERE AdmissionItemId = ? AND Status = 'pending'", [pounds(c.payerAmount), itemId]);
      if (it.TicketId) await refreshTicketTotals(t, it.TicketId);
      await audit(t, req.user, 'ticket.item.update', 'Admission', id, { old: { name: it.Name, qty: it.Qty, amount: Number(it.Amount) }, now: { qty, amount: pounds(amount) } });
      if (it.IncludedNights) await postNights(t, id);
    });
    res.json(await ticketDetails(db, id));
  });

  // رقم الورقة للدفعة (بعد ما الموظف يبدأ يكتب)
  r.put('/adm/:id/t/:tid', async (req, res) => {
    need(req.user, 'adm.bill');
    const id = intId(req.params.id), tid = intId(req.params.tid);
    await db.tx(async (t) => {
      await loadOpen(t, id);
      const tk = await t.one('SELECT * FROM Tickets WHERE Id = ? AND AdmissionId = ?', [tid, id]);
      if (!tk) throw notFound('الدفعة مش موجودة');
      if (tk.CreatedBy !== req.user.id && !can(req.user, 'adm.reopen')) throw forbidden();
      await t.run('UPDATE Tickets SET PaperNo = ? WHERE Id = ?', [str(req.body?.paperNo, 30), tid]);
    });
    res.json(await ticketDetails(db, id));
  });

  // شيل بند من التذكرة (قبل القفل)
  r.delete('/adm/:id/items/:itemId', async (req, res) => {
    need(req.user, 'adm.bill');
    const id = intId(req.params.id), itemId = intId(req.params.itemId);
    let reason = str(req.body?.reason, 300);
    await db.tx(async (t) => {
      await loadOpen(t, id);
      const it = await t.one('SELECT * FROM AdmissionItems WHERE Id = ? AND AdmissionId = ?', [itemId, id]);
      if (!it || it.Status !== 'active') throw notFound('البند مش موجود');
      // سطر لسه مكتوب من نفس الموظف (أقل من 15 دقيقة): بيتشال من غير سبب
      if (!reason && it.AddedBy === req.user.id && Date.now() - new Date(it.AddedAt).getTime() < FRESH_MS) reason = 'اتشال وقت الكتابة';
      if (!reason || reason.length < 3) throw bad('اكتب السبب');
      if (it.Kind === 'night' && !can(req.user, 'admissions.override')) throw forbidden('شيل ليلة إقامة محتاج المدير');
      await t.run("UPDATE AdmissionItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?", [new Date(), req.user.id, reason, itemId]);
      await t.run("UPDATE Approvals SET Status = 'cancelled' WHERE AdmissionItemId = ? AND Status = 'pending'", [itemId]);
      if (it.StoreId) await giveBack(t, req.user, { refType: 'admitem', refId: itemId, kind: 'ticket_back', note: reason });
      await audit(t, req.user, 'ticket.item.remove', 'Admission', id, { old: { name: it.Name, amount: Number(it.Amount), qty: it.Qty }, note: reason });
      if (it.IncludedNights) await postNights(t, id);
    });
    res.json(await ticketDetails(db, id));
  });

  // قفل التذكرة: الحساب بيتجمد، ولو الخزينة شغالة إذن الخروج بيروح لها لوحده
  r.post('/adm/:id/close', async (req, res) => {
    need(req.user, 'adm.close');
    const id = intId(req.params.id);
    const note = str(req.body?.note, 300);
    const out = await db.tx(async (t) => {
      const a = await loadOpen(t, id);
      const po = await t.one(t.top("SELECT OrderNo FROM PayOrders WHERE AdmissionId = ? AND Status = 'pending'", 1), [id]);
      if (po) throw conflict(`فيه إذن دفع رقم ${po.OrderNo} على المريض لسه مستني في الخزينة. يتحصّل أو يتلغي الأول`);
      const pendingAp = await t.one("SELECT COUNT(*) AS N FROM Approvals WHERE AdmissionId = ? AND Status = 'pending'", [id]);
      if (Number(pendingAp?.N) && !req.body?.confirmPending) throw conflict(`فيه ${pendingAp.N} موافقة لسه مستنية مراجعة التعاقدات. لو هتقفل كده نصيب الشركة فيها هيفضل مستني`, { pendingApprovals: Number(pendingAp.N) });
      const now = new Date();
      await t.run("UPDATE Admissions SET BillStatus = 'closed', ClosedAt = ?, ClosedBy = ? WHERE Id = ?", [now, req.user.id, id]);
      await postNights(t, id);
      const d = await admissionDetails(t, id, { post: false });
      await audit(t, req.user, 'ticket.close', 'Admission', id, { now: { no: a.AdmissionNo, total: d.totals.total, patient: d.totals.patient, balance: d.totals.balance }, note });
      let order = null;
      if (d.totals.balance !== 0 && await mustOrder(t, req.user)) order = (await dischargeAdmission(t, req.user, id, { note }, { makeOrder: true })).order;
      return { order };
    });
    res.json({ order: out.order, ...(await ticketDetails(db, id)) });
  });

  // فتح التذكرة تاني (مشرف الحسابات أو المدير): إذن الخروج المستني بيتلغي
  r.post('/adm/:id/reopen', async (req, res) => {
    need(req.user, 'adm.reopen');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب سبب فتح التذكرة');
    await db.tx(async (t) => {
      const a = await loadActive(t, id);
      if (a.BillStatus !== 'closed') throw conflict('التذكرة مفتوحة أصلًا');
      const now = new Date();
      await t.run("UPDATE PayOrders SET Status = 'cancelled', CancelReason = ?, DoneAt = ?, DoneBy = ? WHERE AdmissionId = ? AND Kind = 'discharge' AND Status = 'pending'",
        ['فتح التذكرة: ' + reason, now, req.user.id, id]);
      await t.run('UPDATE Admissions SET BillStatus = NULL, ClosedAt = NULL, ClosedBy = NULL, ReopenCount = ReopenCount + 1 WHERE Id = ?', [id]);
      await t.run("UPDATE AdmissionItems SET Status = 'active', VoidedAt = NULL, VoidReason = NULL WHERE AdmissionId = ? AND Kind = 'night' AND Status = 'voided' AND VoidReason = ?", [id, EARLY_OUT]);
      await postNights(t, id);
      await audit(t, req.user, 'ticket.reopen', 'Admission', id, { note: reason });
    });
    res.json(await ticketDetails(db, id));
  });

  // ===== أصناف الأدوية والمستلزمات =====
  r.get('/items', async (req, res) => {
    anyOf(req.user, ['adm.bill', 'stock.edit', 'late.create', 'stock.view', 'visit.stock']);
    const all = req.query.all === '1' && can(req.user, 'stock.edit');
    const rows = await db.query(`SELECT * FROM StockItems ${all ? '' : 'WHERE Active = 1'} ORDER BY Kind, Name`);
    res.json({ items: rows.map(stockDto), kinds: STOCK_KINDS });
  });
  r.post('/items', async (req, res) => {
    need(req.user, 'stock.edit');
    const s = validateStock(req.body || {});
    const id = await db.tx(async (t) => {
      await ensureUnits(t, [s.unit, s.midUnit, s.packUnit]);
      const code = s.code || await nextStockCode(t, s.kind);
      if (await t.one('SELECT Id FROM StockItems WHERE Code = ?', [code])) throw bad('الكود ده متسجل لصنف تاني', { errors: { code: 'الكود متاخد' } });
      const nid = await t.insert('StockItems', {
        Code: code, Name: s.name, SearchKey: searchKey(s.name), Kind: s.kind, Unit: s.unit, Price: pounds(s.price), Barcode: s.barcode,
        Active: s.active ? 1 : 0, CreatedAt: new Date(), UpdatedBy: req.user.id, MidUnit: s.midUnit, MidQty: s.midQty, PackUnit: s.packUnit, PackQty: s.packQty, MinQty: s.minQty,
        DefaultSaleUnit: s.saleUnit, DefaultPurchaseUnit: s.purchaseUnit,
      });
      await audit(t, req.user, 'stock.create', 'StockItem', nid, { now: { code, name: s.name, price: pounds(s.price) } });
      return nid;
    });
    res.status(201).json({ item: stockDto(await db.one('SELECT * FROM StockItems WHERE Id = ?', [id])) });
  });
  r.put('/items/:id', async (req, res) => {
    need(req.user, 'stock.edit');
    const id = intId(req.params.id);
    const s = validateStock(req.body || {});
    await db.tx(async (t) => {
      const old = await t.one('SELECT * FROM StockItems WHERE Id = ?', [id]);
      if (!old) throw notFound('الصنف مش موجود');
      await ensureUnits(t, [s.unit, s.midUnit, s.packUnit]);
      const code = s.code || old.Code;
      if (await t.one('SELECT Id FROM StockItems WHERE Code = ? AND Id <> ?', [code, id])) throw bad('الكود ده متسجل لصنف تاني', { errors: { code: 'الكود متاخد' } });
      await t.run('UPDATE StockItems SET Code = ?, Name = ?, SearchKey = ?, Kind = ?, Unit = ?, Price = ?, Barcode = ?, Active = ?, UpdatedAt = ?, UpdatedBy = ?, MidUnit = ?, MidQty = ?, PackUnit = ?, PackQty = ?, MinQty = ?, DefaultSaleUnit = ?, DefaultPurchaseUnit = ? WHERE Id = ?',
        [code, s.name, searchKey(s.name), s.kind, s.unit, pounds(s.price), s.barcode, s.active ? 1 : 0, new Date(), req.user.id, s.midUnit, s.midQty, s.packUnit, s.packQty, s.minQty, s.saleUnit, s.purchaseUnit, id]);
      await audit(t, req.user, 'stock.update', 'StockItem', id, { old: { name: old.Name, price: Number(old.Price), active: toBool(old.Active) }, now: { name: s.name, price: pounds(s.price), active: s.active } });
    });
    res.json({ item: stockDto(await db.one('SELECT * FROM StockItems WHERE Id = ?', [id])) });
  });

  // قايمة الوحدات (علبة، شريط، سم...)
  r.get('/units', async (req, res) => {
    anyOf(req.user, ['adm.bill', 'stock.edit', 'late.create', 'stock.view', 'visit.stock']);
    const rows = await db.query('SELECT * FROM StockUnits ORDER BY Active DESC, SortOrder, Name');
    res.json({ units: rows.map((u) => ({ id: u.Id, name: u.Name, active: toBool(u.Active) })) });
  });
  r.post('/units', async (req, res) => {
    need(req.user, 'stock.edit');
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (name.length < 1) throw bad('اكتب اسم الوحدة', { errors: { name: 'اكتب اسم الوحدة' } });
    const old = await db.one('SELECT * FROM StockUnits WHERE Name = ?', [name]);
    if (old) {
      if (toBool(old.Active)) throw conflict('الوحدة دي موجودة', { errors: { name: 'الوحدة موجودة' } });
      await db.run('UPDATE StockUnits SET Active = 1 WHERE Id = ?', [old.Id]);
    } else await db.insert('StockUnits', { Name: name, Active: 1, SortOrder: 999 });
    const rows = await db.query('SELECT * FROM StockUnits ORDER BY Active DESC, SortOrder, Name');
    res.status(201).json({ units: rows.map((u) => ({ id: u.Id, name: u.Name, active: toBool(u.Active) })) });
  });
  r.put('/units/:id', async (req, res) => {
    need(req.user, 'stock.edit');
    const id = intId(req.params.id);
    if (!(await db.one('SELECT Id FROM StockUnits WHERE Id = ?', [id]))) throw notFound('الوحدة مش موجودة');
    await db.run('UPDATE StockUnits SET Active = ? WHERE Id = ?', [req.body?.active ? 1 : 0, id]);
    const rows = await db.query('SELECT * FROM StockUnits ORDER BY Active DESC, SortOrder, Name');
    res.json({ units: rows.map((u) => ({ id: u.Id, name: u.Name, active: toBool(u.Active) })) });
  });

  // تصدير الأصناف لإكسل (ونفس الملف بيرجع يترفع بعد تعديل الأسعار)
  r.get('/items/export', async (req, res) => {
    need(req.user, 'stock.edit');
    const rows = await db.query('SELECT * FROM StockItems ORDER BY Kind, Name');
    const wb = new ExcelJS.Workbook();
    wb.creator = `نظام ${R.brand.name}`;
    const ws = wb.addWorksheet('الأصناف', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'الكود', key: 'code', width: 12 }, { header: 'اسم الصنف', key: 'name', width: 40 }, { header: 'النوع', key: 'kind', width: 10 },
      { header: 'الوحدة', key: 'unit', width: 12 }, { header: 'السعر', key: 'price', width: 11 }, { header: 'الباركود', key: 'barcode', width: 18 }, { header: 'فعال', key: 'active', width: 8 },
    ];
    for (const x of rows) ws.addRow({ code: x.Code, name: x.Name, kind: KIND_AR[x.Kind], unit: x.Unit || '', price: Number(x.Price), barcode: x.Barcode || '', active: toBool(x.Active) ? 'نعم' : 'لا' });
    const head = ws.getRow(1);
    head.height = 24;
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    const last = Math.max(rows.length + 500, 800);
    for (let i = 2; i <= last; i++) {
      ws.getCell('C' + i).dataValidation = { type: 'list', allowBlank: true, formulae: ['"دواء,مستلزم"'] };
      ws.getCell('G' + i).dataValidation = { type: 'list', allowBlank: true, formulae: ['"نعم,لا"'] };
      ws.getCell('E' + i).numFmt = R.money.xlsxFormat();
    }
    const fname = `أصناف-الأدوية-والمستلزمات-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="stock-items.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  // استيراد من إكسل: ?mode=preview | apply  (الصنف الموجود بيتعرف بالكود أو بالاسم)
  r.post('/items/import', async (req, res) => {
    need(req.user, 'stock.edit');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('اختار ملف الإكسل');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.body); } catch { throw bad('الملف ده مش ملف إكسل (xlsx) أو بايظ. احفظه من إكسل بصيغة xlsx وجرّب تاني.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw bad('الملف فاضي');
    let headRow = 0, cols = {};
    for (let i = 1; i <= Math.min(6, ws.rowCount) && !headRow; i++) {
      const found = {};
      ws.getRow(i).eachCell((c, k) => {
        const key = searchKey(c.text);
        for (const [f, words] of Object.entries(STOCK_HEAD)) if (!found[f] && words.some((w) => searchKey(w) === key)) found[f] = k;
      });
      if (found.name && found.price) { headRow = i; cols = found; }
    }
    if (!headRow) throw bad('مش لاقي عناوين الأعمدة. لازم يكون فيه عمود «اسم الصنف» وعمود «السعر». نزّل النموذج من «تصدير إكسل».');
    const existing = await db.query('SELECT * FROM StockItems');
    const byCode = new Map(existing.map((x) => [String(x.Code).toUpperCase(), x]));
    const byName = new Map(existing.map((x) => [searchKey(x.Name), x]));
    const plan = [];
    const seen = new Set();
    for (let i = headRow + 1; i <= ws.rowCount && plan.length < 6000; i++) {
      const row = ws.getRow(i);
      const get = (f) => (cols[f] ? String(row.getCell(cols[f]).text ?? '').trim() : '');
      const rec = { code: get('code'), name: get('name'), kind: get('kind'), unit: get('unit'), price: get('price'), barcode: get('barcode'), active: get('active') };
      if (!Object.values(rec).some(Boolean)) continue;
      const errors = [];
      const code = rec.code ? latinDigits(rec.code).toUpperCase().replace(/\s+/g, '') : '';
      const name = str(rec.name, 150);
      const cur = (code && byCode.get(code)) || (!code && name && byName.get(searchKey(name))) || null;
      if (!name) errors.push('الاسم فاضي');
      const kind = kindFrom(rec.kind) || cur?.Kind || null;
      if (!kind) errors.push('النوع فاضي (دواء ولا مستلزم)');
      if (kind === 'bad') errors.push('النوع لازم «دواء» أو «مستلزم»');
      const pr = latinDigits(rec.price).replace(/[,،\s]|ج(نيه)?$/g, '');
      const price = pr ? Number(pr) : cur ? Number(cur.Price) : NaN;
      if (!Number.isFinite(price) || price < 0) errors.push('السعر مش صحيح');
      const k = code || searchKey(name);
      if (seen.has(k)) errors.push('متكرر في الملف');
      seen.add(k);
      const active = rec.active ? !['لا', 'no', '0'].includes(searchKey(rec.active)) : (cur ? toBool(cur.Active) : true);
      const x = { row: i, code: code || cur?.Code || '', name, kind, unit: str(rec.unit, 30) ?? cur?.Unit ?? null, price: R.money.round(price), barcode: str(rec.barcode, 60) ?? cur?.Barcode ?? null, active, id: cur?.Id || null, errors };
      if (errors.length) x.status = 'error';
      else if (!cur) x.status = 'new';
      else {
        const same = cur.Name === name && cur.Kind === kind && Number(cur.Price) === x.price && (cur.Unit || null) === (x.unit || null) && toBool(cur.Active) === active;
        x.status = same ? 'same' : 'update';
        x.oldPrice = Number(cur.Price);
      }
      plan.push(x);
    }
    const counts = Object.fromEntries(['new', 'update', 'same', 'error'].map((s) => [s, plan.filter((x) => x.status === s).length]));
    if (req.query.mode !== 'apply') return res.json({ plan: plan.filter((x) => x.status !== 'same').slice(0, 400), counts });
    if (counts.error) throw bad(`فيه ${counts.error} صف فيهم أخطاء. صلّحهم الأول`);
    const applied = await db.tx(async (t) => {
      let created = 0, updated = 0;
      for (const x of plan) {
        if (x.status === 'new') {
          await ensureUnits(t, [x.unit]);
          const code = x.code || await nextStockCode(t, x.kind);
          await t.insert('StockItems', { Code: code, Name: x.name, SearchKey: searchKey(x.name), Kind: x.kind, Unit: x.unit, Price: x.price, Barcode: x.barcode, Active: x.active ? 1 : 0, CreatedAt: new Date(), UpdatedBy: req.user.id });
          created++;
        } else if (x.status === 'update') {
          await ensureUnits(t, [x.unit]);
          await t.run('UPDATE StockItems SET Name = ?, SearchKey = ?, Kind = ?, Unit = ?, Price = ?, Barcode = ?, Active = ?, UpdatedAt = ?, UpdatedBy = ? WHERE Id = ?',
            [x.name, searchKey(x.name), x.kind, x.unit, x.price, x.barcode, x.active ? 1 : 0, new Date(), req.user.id, x.id]);
          updated++;
        }
      }
      await audit(t, req.user, 'stock.import', 'StockItem', null, { now: { created, updated } });
      return { created, updated };
    });
    res.json({ counts, applied });
  });

  // ===== المستحقات اللاحقة: حاجة اتنست بعد خروج المريض =====
  const lateSql = `SELECT l.*, p.FullName, p.PatientNo, p.Phone, a.AdmissionNo, a.DischargedAt, u.FullName AS ByName, u2.FullName AS DecidedByName, o.OrderNo, o.Status AS OrderStatus
      FROM LateCharges l JOIN Patients p ON p.Id = l.PatientId JOIN Admissions a ON a.Id = l.AdmissionId JOIN Users u ON u.Id = l.CreatedBy
      LEFT JOIN Users u2 ON u2.Id = l.DecidedBy LEFT JOIN PayOrders o ON o.Id = l.OrderId`;
  const lateDto = (x) => ({
    id: x.Id, no: x.LateNo, cat: x.Cat, catName: CATS[x.Cat], name: x.Name, qty: x.Qty, unitPrice: Number(x.UnitPrice), amount: Number(x.Amount), reason: x.Reason,
    status: x.Status, chargeTo: x.ChargeTo, chargeName: x.ChargeName, decisionNote: x.DecisionNote, decidedAt: toIso(x.DecidedAt), decidedBy: x.DecidedByName,
    createdAt: toIso(x.CreatedAt), createdBy: x.ByName, order: x.OrderNo ? { no: x.OrderNo, status: x.OrderStatus } : null,
    patient: { id: x.PatientId, name: x.FullName, no: x.PatientNo, phone: x.Phone }, admission: { id: x.AdmissionId, no: x.AdmissionNo, dischargedAt: toIso(x.DischargedAt) },
  });

  r.get('/late', async (req, res) => {
    anyOf(req.user, ['late.create', 'late.decide', 'reports.late']);
    const st = ['open', 'billed', 'charged', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;
    const where = [], params = [];
    if (st) { where.push('l.Status = ?'); params.push(st); }
    if (from) { where.push('l.CreatedAt >= ?'); params.push(new Date(from + 'T00:00:00+02:00')); }
    if (to) { where.push('l.CreatedAt < ?'); params.push(new Date(addDays(to, 1) + 'T00:00:00+02:00')); }
    const rows = await db.query(`${lateSql} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.Id DESC`, params);
    const list = rows.slice(0, 500).map(lateDto);
    const sum = (f) => { const xs = rows.filter(f); return { n: xs.length, amount: pounds(xs.reduce((s, x) => s + cents(x.Amount), 0)) }; };
    const groups = new Map();
    for (const x of rows.filter((y) => y.Status === 'charged')) {
      const k = x.ChargeTo + '|' + x.ChargeName;
      if (!groups.has(k)) groups.set(k, { to: x.ChargeTo, name: x.ChargeName, n: 0, amount: 0 });
      const g = groups.get(k); g.n++; g.amount += cents(x.Amount);
    }
    res.json({
      late: list,
      summary: {
        open: sum((x) => x.Status === 'open'), billed: sum((x) => x.Status === 'billed'), charged: sum((x) => x.Status === 'charged'), cancelled: sum((x) => x.Status === 'cancelled'),
        byWho: [...groups.values()].map((g) => ({ ...g, amount: pounds(g.amount) })).sort((a, b) => b.amount - a.amount),
      },
      canDecide: can(req.user, 'late.decide'),
    });
  });

  // المرضى اللي خرجوا قريب (للبحث في شاشة المستحق اللاحق)
  r.get('/late/admissions', async (req, res) => {
    need(req.user, 'late.create');
    const q = searchKey(req.query.q || '');
    const rows = await db.query(db.top(
      `SELECT a.Id, a.AdmissionNo, a.DischargedAt, a.Type, p.Id AS PatientId, p.FullName, p.PatientNo, p.Phone FROM Admissions a JOIN Patients p ON p.Id = a.PatientId
        WHERE a.Status = 'discharged' ORDER BY a.DischargedAt DESC`, 400));
    const list = rows.filter((x) => !q || searchKey(x.FullName).includes(q) || String(x.PatientNo) === q || String(x.AdmissionNo) === q || (x.Phone || '').includes(q)).slice(0, 30);
    res.json({ admissions: list.map((x) => ({ id: x.Id, no: x.AdmissionNo, dischargedAt: toIso(x.DischargedAt), type: x.Type, patient: { id: x.PatientId, name: x.FullName, no: x.PatientNo, phone: x.Phone } })) });
  });

  r.post('/late', async (req, res) => {
    need(req.user, 'late.create');
    const b = req.body || {};
    const reason = str(b.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب إيه اللي حصل (اتنسى ليه)', { errors: { reason: 'اكتب السبب' } });
    const id = await db.tx(async (t) => {
      const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [intId(b.admissionId, 'الدخول')]);
      if (!a) throw notFound('الدخول ده مش موجود');
      if (a.Status !== 'discharged') throw conflict('المريض لسه داخل. ضيف البند على التذكرة عادي');
      const p = { ...(await priceLine(t, null, b, 0, await floorAt(t, a.Id, new Date(a.DischargedAt)))), storeId: (await pickStore(t, b.storeId))?.Id || null };
      const no = await t.nextNumber('late');
      const nid = await t.insert('LateCharges', {
        LateNo: no, AdmissionId: a.Id, PatientId: a.PatientId, Cat: p.cat, ServiceId: p.serviceId, StockItemId: p.stockItemId, DoctorId: p.doctorId,
        Name: p.name, Qty: p.qty, UnitPrice: pounds(p.unit), Amount: pounds(p.unit * p.qty), Reason: reason, Status: 'open', CreatedAt: new Date(), CreatedBy: req.user.id,
      });
      const sid = await deductFor(t, req.user, p, 'late', nid);
      if (sid) await t.run('UPDATE LateCharges SET StoreId = ? WHERE Id = ?', [sid, nid]);
      await audit(t, req.user, 'late.create', 'LateCharge', nid, { now: { no, admission: a.AdmissionNo, name: p.name, amount: pounds(p.unit * p.qty) }, note: reason });
      return nid;
    });
    res.status(201).json({ late: lateDto(await db.one(lateSql + ' WHERE l.Id = ?', [id])) });
  });

  // القرار: المريض يدفع | يتحمّل على موظف | يتحمّل على القسم | يتلغي
  r.post('/late/:id/decide', async (req, res) => {
    need(req.user, 'late.decide');
    const id = intId(req.params.id);
    const b = req.body || {};
    const to = b.to;
    if (!['patient', 'employee', 'dept', 'cancel'].includes(to)) throw bad('اختار القرار');
    const note = str(b.note, 300);
    const out = await db.tx(async (t) => {
      const x = await t.one('SELECT * FROM LateCharges WHERE Id = ?', [id]);
      if (!x) throw notFound('المستحق مش موجود');
      if (x.Status !== 'open') throw conflict('اتاخد فيه قرار قبل كده');
      const now = new Date();
      let order = null;
      if (to === 'patient') {
        const a = await t.one('SELECT * FROM Admissions WHERE Id = ?', [x.AdmissionId]);
        const amount = cents(x.Amount);
        const iid = await t.insert('AdmissionItems', {
          AdmissionId: a.Id, Kind: 'service', ServiceId: x.ServiceId, Name: x.Name, Dept: x.Cat === 'drug' || x.Cat === 'supply' ? COVER_DEPT[x.Cat] : ((await t.one('SELECT Dept FROM Services WHERE Id = ?', [x.ServiceId]))?.Dept || 'ward'),
          DoctorId: x.DoctorId, Qty: x.Qty, UnitPrice: x.UnitPrice, Amount: x.Amount, DoctorPct: 0, ChargeDate: cairoDate(), ClassId: null, IncludedNights: null,
          PayerPct: 0, PayerAmount: 0, PatientAmount: x.Amount, CoverStatus: 'none', Note: `مستحق لاحق رقم ${x.LateNo}`, Status: 'active', AddedAt: now, AddedBy: req.user.id,
          TicketId: null, StockItemId: x.StockItemId, Cat: x.Cat,
        });
        if (await mustOrder(t, req.user)) {
          order = await payAdmission(t, req.user, a.Id, { amount: pounds(amount), note: `مستحق لاحق رقم ${x.LateNo} · ${x.Name}` }, { makeOrder: true });
        }
        await t.run("UPDATE LateCharges SET Status = 'billed', AdmissionItemId = ?, OrderId = ?, DecisionNote = ?, DecidedAt = ?, DecidedBy = ? WHERE Id = ?",
          [iid, order?.id || null, note, now, req.user.id, id]);
      } else if (to === 'cancel') {
        if (!note || note.length < 3) throw bad('اكتب سبب الإلغاء');
        await t.run("UPDATE LateCharges SET Status = 'cancelled', DecisionNote = ?, DecidedAt = ?, DecidedBy = ? WHERE Id = ?", [note, now, req.user.id, id]);
        if (x.StoreId) await giveBack(t, req.user, { refType: 'late', refId: id, kind: 'late_back', note });
      } else {
        let name = str(b.name, 150), userId = null;
        if (to === 'employee' && b.userId) {
          const u = await t.one('SELECT Id, FullName FROM Users WHERE Id = ?', [Number(b.userId) || 0]);
          if (u) { userId = u.Id; name = name || u.FullName; }
        }
        if (!name || name.length < 2) throw bad(to === 'employee' ? 'اكتب اسم الموظف' : 'اكتب اسم القسم أو المكان', { errors: { name: 'مطلوب' } });
        await t.run("UPDATE LateCharges SET Status = 'charged', ChargeTo = ?, ChargeName = ?, ChargeUserId = ?, DecisionNote = ?, DecidedAt = ?, DecidedBy = ? WHERE Id = ?",
          [to, name, userId, note, now, req.user.id, id]);
      }
      await audit(t, req.user, 'late.decide', 'LateCharge', id, { now: { to, name: b.name || null, amount: Number(x.Amount) }, note });
      return { order };
    });
    res.json({ order: out.order, late: lateDto(await db.one(lateSql + ' WHERE l.Id = ?', [id])) });
  });

  // أسماء للتحميل (الموظفين المسجلين + الأقسام اللي اتكتبت قبل كده)
  r.get('/late/names', async (req, res) => {
    need(req.user, 'late.decide');
    const users = await db.query('SELECT Id, FullName FROM Users WHERE Active = 1 ORDER BY FullName');
    const prev = await db.query("SELECT DISTINCT ChargeTo, ChargeName FROM LateCharges WHERE Status = 'charged'");
    const depts = [...new Set(['تمريض الدور', 'الحسابات', 'الصيدلية', 'العمليات', 'العناية', 'الحضانة', 'الاستقبال', ...prev.filter((x) => x.ChargeTo === 'dept').map((x) => x.ChargeName)])];
    res.json({ users: users.map((u) => ({ id: u.Id, name: u.FullName })), employees: [...new Set(prev.filter((x) => x.ChargeTo === 'employee').map((x) => x.ChargeName))], depts });
  });

  return r;
}

/** للرئيسية: عدد اللي محتاج متابعة في الحسابات */
export async function ticketCounts(db) {
  const today = cairoDate();
  const act = await db.query("SELECT a.Id, a.BillStatus, (SELECT COUNT(*) FROM Tickets tk WHERE tk.AdmissionId = a.Id AND tk.TicketDate = ?) AS N FROM Admissions a WHERE a.Status = 'active'", [today]);
  const late = await db.one("SELECT COUNT(*) AS N FROM LateCharges WHERE Status = 'open'");
  return { noTicketToday: act.filter((x) => x.BillStatus !== 'closed' && !Number(x.N)).length, closed: act.filter((x) => x.BillStatus === 'closed').length, active: act.length, late: Number(late?.N || 0) };
}
