// تقارير المخزن: قيمة المخزون، حركة صنف، استهلاك الأقسام، بيع الصيدلية، الصلاحية والراكد — وكلها بتطلع إكسل
import { R, argb } from '../lib/runtime.js';
import { qty2 } from '../../shared/money.js';
import ExcelJS from 'exceljs';
import { router } from '../lib/router.js';
import { need, can } from '../lib/auth.js';
import { bad, forbidden, cairoDate, cairoDayRange } from '../lib/util.js';
import { toIso, toDateStr } from '../db/index.js';
import { STORE_KINDS, STORE_DEPTS, MOVE_KINDS, canStore, unitsOf } from '../lib/stock.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => qty2(n || 0); // كميات
const rm = (n) => R.money.round(n || 0); // مبالغ (بخانات العملة)
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };
/** صرف للمرضى (والرجوع منه بيتطرح) */
const USE_KINDS = ['ticket', 'ticket_back', 'late', 'late_back', 'visit', 'visit_back', 'sale', 'sale_back'];
const anyOf = (user, perms) => { if (!perms.some((p) => can(user, p))) throw forbidden(); };
const units = (it) => unitsOf(it).map((u) => ({ key: u.key, name: u.name, factor: u.factor }));

function range(q) {
  const to = DATE_RE.test(q.to || '') ? q.to : cairoDate();
  const from = DATE_RE.test(q.from || '') ? q.from : to.slice(0, 8) + '01';
  if (from > to) throw bad('تاريخ البداية بعد النهاية');
  return { from, to, start: cairoDayRange(from).start, end: cairoDayRange(to).end };
}
/** المخازن اللي الموظف يشوفها (ومخزن واحد لو اختار) */
async function storesFor(db, user, storeId) {
  const rows = (await db.query('SELECT * FROM Stores ORDER BY SortOrder, Id')).filter((s) => canStore(user, s.Id));
  if (storeId && storeId !== 'all') {
    const s = rows.find((x) => x.Id === Number(storeId));
    if (!s) throw bad('المخزن ده مش مربوط بيك');
    return [s];
  }
  return rows;
}
const inList = (ids) => (ids.length ? ids.map(() => '?').join(',') : 'NULL');

// ---------- إكسل ----------
async function sendXlsx(res, name, title, columns, rows, { totals } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 30), { views: [{ rightToLeft: true, state: 'frozen', ySplit: 2 }] });
  ws.columns = columns.map((c) => ({ header: c.h, key: c.k, width: c.w || 14 }));
  ws.spliceRows(1, 0, [title]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } };
  for (const r of rows) ws.addRow(r);
  if (totals) { const t = ws.addRow(totals); t.font = { bold: true }; t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6EEE8' } }; }
  for (const c of columns) if (c.money) ws.getColumn(c.k).numFmt = R.money.xlsxFormat();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
}
const fmtAt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: R.tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));

// ---------- التقارير ----------
/** قيمة المخزون: بالتكلفة (تكلفة التشغيلة وإلا آخر تكلفة) وبسعر البيع */
export async function valueReport(db, user, q) {
  const stores = await storesFor(db, user, q.storeId);
  const ids = stores.map((s) => s.Id);
  const rows = await db.query(
    `SELECT b.StoreId, b.ItemId, b.Qty, b.Cost, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty, i.Price, i.LastCost
       FROM StockBatches b JOIN StockItems i ON i.Id = b.ItemId WHERE b.StoreId IN (${inList(ids)}) AND b.Qty <> 0`, ids);
  const per = new Map(stores.map((s) => [s.Id, { id: s.Id, name: s.Name, kind: s.Kind, kindName: STORE_KINDS[s.Kind], items: new Set(), cost: 0, sale: 0, noCost: 0, negative: 0 }]));
  const items = new Map();
  for (const r of rows) {
    const s = per.get(r.StoreId);
    const qty = Number(r.Qty);
    if (qty < 0) { s.negative++; continue; }
    const cost = r.Cost != null ? Number(r.Cost) : r.LastCost != null ? Number(r.LastCost) : null;
    s.items.add(r.ItemId);
    s.sale += qty * Number(r.Price);
    if (cost == null) s.noCost++; else s.cost += qty * cost;
    const k = r.ItemId;
    const it = items.get(k) || { id: k, name: r.Name, code: r.Code, kind: r.Kind, units: units(r), qty: 0, cost: 0, sale: 0 };
    it.qty += qty; it.cost += (cost ?? 0) * qty; it.sale += qty * Number(r.Price);
    items.set(k, it);
  }
  const list = [...per.values()].map((s) => ({ ...s, items: s.items.size, cost: rm(s.cost), sale: rm(s.sale) }));
  const top = [...items.values()].map((x) => ({ ...x, qty: r2(x.qty), cost: rm(x.cost), sale: rm(x.sale) })).sort((a, b) => b.cost - a.cost);
  return {
    stores: list, items: top,
    totals: { cost: rm(list.reduce((a, s) => a + s.cost, 0)), sale: rm(list.reduce((a, s) => a + s.sale, 0)), items: items.size, negative: list.reduce((a, s) => a + s.negative, 0) },
  };
}

/** حركة صنف: رصيد أول الفترة، كل حركة بالرصيد بعدها، ورصيد آخر الفترة */
export async function ledgerReport(db, user, q) {
  const it = await db.one('SELECT * FROM StockItems WHERE Id = ?', [Number(q.itemId) || 0]);
  if (!it) throw bad('اختار الصنف');
  const { from, to, start, end } = range(q);
  const stores = await storesFor(db, user, q.storeId);
  const ids = stores.map((s) => s.Id);
  const op = await db.one(`SELECT SUM(Qty) AS Q FROM StockMoves WHERE ItemId = ? AND StoreId IN (${inList(ids)}) AND At < ?`, [it.Id, ...ids, start]);
  const moves = await db.query(
    `SELECT m.*, s.Name AS StoreName, u.FullName AS ByName, b.BatchNo, b.Expiry FROM StockMoves m JOIN Stores s ON s.Id = m.StoreId
       LEFT JOIN Users u ON u.Id = m.UserId LEFT JOIN StockBatches b ON b.Id = m.BatchId
      WHERE m.ItemId = ? AND m.StoreId IN (${inList(ids)}) AND m.At >= ? AND m.At < ? ORDER BY m.At, m.Id`, [it.Id, ...ids, start, end]);
  let bal = r2(op?.Q || 0);
  const opening = bal;
  let inQ = 0, outQ = 0;
  const rows = moves.map((m) => {
    const qn = Number(m.Qty);
    bal = r2(bal + qn);
    if (qn > 0) inQ += qn; else outQ -= qn;
    return { id: m.Id, at: toIso(m.At), kind: m.Kind, kindName: MOVE_KINDS[m.Kind] || m.Kind, store: m.StoreName, batchNo: m.BatchNo, expiry: toDateStr(m.Expiry), qty: r2(qn), balance: bal, by: m.ByName, note: m.Note };
  });
  return {
    item: { id: it.Id, name: it.Name, code: it.Code, kind: it.Kind, units: units(it) }, from, to,
    store: stores.length === 1 ? stores[0].Name : 'كل المخازن', opening, in: r2(inQ), out: r2(outQ), closing: bal, moves: rows,
  };
}

/** استهلاك الأقسام: المصروف للمرضى (بعد طرح الرجوع)، والإعدام، وفروق الجرد — بالمخزن وبالصنف */
export async function consumptionReport(db, user, q) {
  const { from, to, start, end } = range(q);
  const stores = await storesFor(db, user, q.storeId);
  const ids = stores.map((s) => s.Id);
  const rows = await db.query(
    `SELECT m.StoreId, m.ItemId, m.Kind, m.Qty, m.Cost, i.Name, i.Code, i.Kind AS IKind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty, i.Price, i.LastCost
       FROM StockMoves m JOIN StockItems i ON i.Id = m.ItemId
      WHERE m.StoreId IN (${inList(ids)}) AND m.At >= ? AND m.At < ? AND m.Kind IN (${inList([...USE_KINDS, 'waste', 'count'])})`,
    [...ids, start, end, ...USE_KINDS, 'waste', 'count']);
  const per = new Map(stores.map((s) => [s.Id, { id: s.Id, name: s.Name, kind: s.Kind, dept: s.Dept ? STORE_DEPTS[s.Dept] : null, useCost: 0, useSale: 0, waste: 0, countDiff: 0, lines: 0 }]));
  const items = new Map();
  for (const r of rows) {
    const s = per.get(r.StoreId);
    const qn = Number(r.Qty);
    const cost = r.Cost != null ? Number(r.Cost) : r.LastCost != null ? Number(r.LastCost) : 0;
    if (r.Kind === 'waste') { s.waste += -qn * cost; continue; }
    if (r.Kind === 'count') { s.countDiff += qn * cost; continue; }
    const used = -qn; // الصرف سالب والرجوع موجب
    s.useCost += used * cost; s.useSale += used * Number(r.Price); s.lines++;
    const k = r.ItemId;
    const it = items.get(k) || { id: k, name: r.Name, code: r.Code, kind: r.IKind, units: units({ Unit: r.Unit, MidUnit: r.MidUnit, MidQty: r.MidQty, PackUnit: r.PackUnit, PackQty: r.PackQty }), qty: 0, cost: 0, sale: 0 };
    it.qty += used; it.cost += used * cost; it.sale += used * Number(r.Price);
    items.set(k, it);
  }
  const list = [...per.values()].map((s) => ({ ...s, useCost: rm(s.useCost), useSale: rm(s.useSale), waste: rm(s.waste), countDiff: rm(s.countDiff) }))
    .filter((s) => s.lines || s.waste || s.countDiff || stores.length === 1).sort((a, b) => b.useCost - a.useCost);
  const top = [...items.values()].map((x) => ({ ...x, qty: r2(x.qty), cost: rm(x.cost), sale: rm(x.sale) })).filter((x) => x.qty).sort((a, b) => b.cost - a.cost);
  return {
    from, to, store: stores.length === 1 ? stores[0].Name : null, stores: list, items: top,
    totals: { useCost: rm(list.reduce((a, s) => a + s.useCost, 0)), useSale: rm(list.reduce((a, s) => a + s.useSale, 0)), waste: rm(list.reduce((a, s) => a + s.waste, 0)), countDiff: rm(list.reduce((a, s) => a + s.countDiff, 0)) },
  };
}

/** بيع الصيدلية: بالإيصالات (البيع والمرتجع والإلغاء)، باليوم وبالصنف وبالصيدلي */
export async function pharmacyReport(db, user, q) {
  const { from, to, start, end } = range(q);
  const recs = await db.query(
    `SELECT r.Id, r.Kind, r.Net, r.Cash, r.Card, r.Credit, r.Discount, r.CreatedAt, r.CreatedBy, u.FullName AS ByName
       FROM Receipts r JOIN Visits v ON v.Id = r.VisitId JOIN Users u ON u.Id = r.CreatedBy
      WHERE v.Type = 'pharmacy' AND r.CreatedAt >= ? AND r.CreatedAt < ? ORDER BY r.Id`, [start, end]);
  const lines = await db.query(
    `SELECT l.ReceiptId, l.Qty, l.Amount, l.DiscountShare, l.PayerAmount, vi.StockItemId, vi.UnitFactor, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty, i.LastCost
       FROM ReceiptLines l JOIN Receipts r ON r.Id = l.ReceiptId JOIN Visits v ON v.Id = r.VisitId JOIN VisitItems vi ON vi.Id = l.VisitItemId
       LEFT JOIN StockItems i ON i.Id = vi.StockItemId
      WHERE v.Type = 'pharmacy' AND r.CreatedAt >= ? AND r.CreatedAt < ?`, [start, end]);
  const day = (d) => cairoDate(new Date(d));
  const days = new Map(), people = new Map();
  let sold = 0, back = 0, count = 0, cash = 0, card = 0, credit = 0;
  for (const r of recs) {
    const n = Number(r.Net), d = day(r.CreatedAt);
    const x = days.get(d) || { date: d, sold: 0, back: 0, count: 0 };
    const p = people.get(r.CreatedBy) || { name: r.ByName, sold: 0, back: 0, count: 0 };
    if (n >= 0) { x.sold += n; p.sold += n; sold += n; if (r.Kind !== 'refund') { x.count++; p.count++; count++; } } else { x.back -= n; p.back -= n; back -= n; }
    cash += Number(r.Cash); card += Number(r.Card); credit += Number(r.Credit);
    days.set(d, x); people.set(r.CreatedBy, p);
  }
  const items = new Map();
  let payer = 0;
  for (const l of lines) {
    if (!l.StockItemId) continue;
    const base = Number(l.Qty) * Number(l.UnitFactor || 1) * Math.sign(Number(l.Amount) || 1);
    const amt = Number(l.Amount) - Number(l.DiscountShare || 0);
    payer += Number(l.PayerAmount || 0);
    const it = items.get(l.StockItemId) || { id: l.StockItemId, name: l.Name, code: l.Code, kind: l.Kind, units: units(l), qty: 0, amount: 0, cost: 0 };
    it.qty += base; it.amount += amt; it.cost += base * Number(l.LastCost || 0);
    items.set(l.StockItemId, it);
  }
  const list = [...days.values()].map((x) => ({ ...x, sold: rm(x.sold), back: rm(x.back), net: rm(x.sold - x.back) })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const top = [...items.values()].map((x) => ({ ...x, qty: r2(x.qty), amount: rm(x.amount), cost: rm(x.cost), margin: rm(x.amount - x.cost) })).filter((x) => x.qty).sort((a, b) => b.amount - a.amount);
  return {
    from, to, days: list, items: top,
    people: [...people.values()].map((p) => ({ ...p, sold: rm(p.sold), back: rm(p.back), net: rm(p.sold - p.back) })),
    totals: { sold: rm(sold), back: rm(back), net: rm(sold - back), count, cash: rm(cash), card: rm(card), credit: rm(credit), payer: rm(payer), avg: count ? rm((sold - back) / count) : 0 },
  };
}

/** الصلاحية: المنتهي واللي قرب، بقيمته بالتكلفة */
export async function expiryReport(db, user, q) {
  const days = Math.min(Math.max(Number(q.days) || 90, 7), 730);
  const stores = await storesFor(db, user, q.storeId);
  const ids = stores.map((s) => s.Id);
  const today = cairoDate(), lim = addDays(today, days);
  const rows = await db.query(
    `SELECT b.*, s.Name AS StoreName, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty, i.LastCost
       FROM StockBatches b JOIN Stores s ON s.Id = b.StoreId JOIN StockItems i ON i.Id = b.ItemId
      WHERE b.StoreId IN (${inList(ids)}) AND b.Qty > 0 AND b.Expiry IS NOT NULL AND b.Expiry <= ? ORDER BY b.Expiry, i.Name`, [...ids, lim]);
  const out = rows.map((b) => {
    const exp = toDateStr(b.Expiry);
    const cost = b.Cost != null ? Number(b.Cost) : Number(b.LastCost || 0);
    const left = Math.round((Date.parse(exp) - Date.parse(today)) / 864e5);
    return { batchId: b.Id, store: b.StoreName, storeId: b.StoreId, itemId: b.ItemId, name: b.Name, code: b.Code, kind: b.Kind, units: units(b), batchNo: b.BatchNo, expiry: exp, daysLeft: left, expired: exp < today, qty: r2(b.Qty), value: rm(Number(b.Qty) * cost) };
  });
  const sum = (f) => rm(out.filter(f).reduce((a, x) => a + x.value, 0));
  return { days, batches: out, totals: { expired: sum((x) => x.expired), soon: sum((x) => !x.expired), expiredN: out.filter((x) => x.expired).length, soonN: out.filter((x) => !x.expired).length } };
}

/** الراكد: أصناف ليها رصيد ومفيش منها صرف من مدة */
export async function stagnantReport(db, user, q) {
  const days = Math.min(Math.max(Number(q.days) || 90, 15), 730);
  const stores = await storesFor(db, user, q.storeId);
  const ids = stores.map((s) => s.Id);
  const since = cairoDayRange(addDays(cairoDate(), -days)).start;
  const bal = await db.query(
    `SELECT b.StoreId, b.ItemId, SUM(b.Qty) AS Q, SUM(b.Qty * COALESCE(b.Cost, i.LastCost, 0)) AS V, s.Name AS StoreName,
            i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty
       FROM StockBatches b JOIN StockItems i ON i.Id = b.ItemId JOIN Stores s ON s.Id = b.StoreId
      WHERE b.StoreId IN (${inList(ids)}) AND b.Qty > 0
      GROUP BY b.StoreId, b.ItemId, s.Name, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty`, ids);
  const outs = await db.query(
    `SELECT StoreId, ItemId, MAX(CASE WHEN Qty < 0 AND Kind NOT IN ('count','waste') THEN At END) AS LastOut, MIN(CASE WHEN Qty > 0 THEN At END) AS FirstIn
       FROM StockMoves WHERE StoreId IN (${inList(ids)}) GROUP BY StoreId, ItemId`, ids);
  const last = new Map(outs.filter((o) => o.LastOut).map((o) => [`${o.StoreId}:${o.ItemId}`, new Date(o.LastOut)]));
  // الصنف اللي لسه داخل المخزن جوه المدة مايتحسبش راكد
  const fresh = new Set(outs.filter((o) => o.FirstIn && new Date(o.FirstIn) >= since).map((o) => `${o.StoreId}:${o.ItemId}`));
  const list = bal.map((b) => ({ store: b.StoreName, storeId: b.StoreId, itemId: b.ItemId, name: b.Name, code: b.Code, kind: b.Kind, units: units(b), qty: r2(b.Q), value: rm(b.V), lastOut: last.get(`${b.StoreId}:${b.ItemId}`) || null }))
    .filter((x) => (x.lastOut ? x.lastOut < since : !fresh.has(`${x.storeId}:${x.itemId}`)))
    .map((x) => ({ ...x, lastOut: x.lastOut ? toIso(x.lastOut) : null }))
    .sort((a, b) => b.value - a.value);
  return { days, items: list, totals: { value: rm(list.reduce((a, x) => a + x.value, 0)), count: list.length } };
}

const qtyText = (q, us) => {
  if (!us?.length) return String(q);
  let left = Math.abs(q); const parts = [];
  for (const u of [...us].sort((a, b) => b.factor - a.factor)) { const n = Math.floor(left / u.factor + 1e-9); if (n) { parts.push(`${r2(n)} ${u.name}`); left = r2(left - n * u.factor); } }
  if (left) parts.push(`${left} ${us[0].name}`);
  return (q < 0 ? '- ' : '') + (parts.join(' + ') || `0 ${us[0].name}`);
};

export default function stockReportsRouter(db) {
  const r = router();
  const gate = (req, kind) => (kind === 'pharmacy' ? anyOf(req.user, ['reports.stock', 'reports.pharmacy']) : need(req.user, 'reports.stock'));
  const xl = (req) => req.query.format === 'xlsx';

  r.get('/value', async (req, res) => {
    gate(req);
    const d = await valueReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    const m = { k: 'cost', money: true };
    await sendXlsx(res, `قيمة-المخزون-${cairoDate()}`, `قيمة المخزون · ${cairoDate()}`,
      [{ h: 'المخزن', k: 'name', w: 28 }, { h: 'النوع', k: 'kindName', w: 14 }, { h: 'عدد الأصناف', k: 'items', w: 12 }, { h: 'القيمة بالتكلفة', ...m, w: 16 }, { h: 'القيمة بسعر البيع', k: 'sale', money: true, w: 16 }, { h: 'أصناف من غير تكلفة', k: 'noCost', w: 16 }, { h: 'تشغيلات سالبة', k: 'negative', w: 14 }],
      d.stores, { totals: { name: 'الإجمالي', items: d.totals.items, cost: d.totals.cost, sale: d.totals.sale, negative: d.totals.negative } });
  });

  r.get('/ledger', async (req, res) => {
    gate(req);
    const d = await ledgerReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    await sendXlsx(res, `حركة-${d.item.code}-${d.from}-${d.to}`, `حركة صنف: ${d.item.name} (${d.item.code}) · ${d.store} · من ${d.from} لـ ${d.to} · الكميات بالـ${d.item.units[0].name}`,
      [{ h: 'إمتى', k: 'at', w: 17 }, { h: 'الحركة', k: 'kindName', w: 20 }, { h: 'المخزن', k: 'store', w: 22 }, { h: 'التشغيلة', k: 'batchNo', w: 12 }, { h: 'الصلاحية', k: 'expiry', w: 12 }, { h: 'وارد', k: 'in', w: 10 }, { h: 'منصرف', k: 'out', w: 10 }, { h: 'الرصيد', k: 'balance', w: 11 }, { h: 'مين', k: 'by', w: 18 }, { h: 'ملاحظة', k: 'note', w: 30 }],
      [{ kindName: 'رصيد أول الفترة', balance: d.opening }, ...d.moves.map((m) => ({ ...m, at: fmtAt(m.at), in: m.qty > 0 ? m.qty : '', out: m.qty < 0 ? -m.qty : '' }))],
      { totals: { kindName: 'رصيد آخر الفترة', in: d.in, out: d.out, balance: d.closing } });
  });

  r.get('/consumption', async (req, res) => {
    gate(req);
    const d = await consumptionReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    if (req.query.by === 'item') {
      return sendXlsx(res, `استهلاك-الأصناف-${d.from}-${d.to}`, `استهلاك الأصناف${d.store ? ' · ' + d.store : ''} · من ${d.from} لـ ${d.to}`,
        [{ h: 'الكود', k: 'code', w: 10 }, { h: 'الصنف', k: 'name', w: 36 }, { h: 'الكمية', k: 'qtyText', w: 26 }, { h: 'بالوحدة الصغيرة', k: 'qty', w: 14 }, { h: 'التكلفة', k: 'cost', money: true }, { h: 'بسعر البيع', k: 'sale', money: true }],
        d.items.map((x) => ({ ...x, qtyText: qtyText(x.qty, x.units) })), { totals: { name: 'الإجمالي', cost: d.totals.useCost, sale: d.totals.useSale } });
    }
    await sendXlsx(res, `استهلاك-الأقسام-${d.from}-${d.to}`, `استهلاك الأقسام · من ${d.from} لـ ${d.to}`,
      [{ h: 'المخزن', k: 'name', w: 26 }, { h: 'القسم', k: 'dept', w: 12 }, { h: 'المصروف للمرضى (تكلفة)', k: 'useCost', money: true, w: 20 }, { h: 'المصروف بسعر البيع', k: 'useSale', money: true, w: 18 }, { h: 'الإعدام', k: 'waste', money: true }, { h: 'فروق الجرد', k: 'countDiff', money: true }],
      d.stores, { totals: { name: 'الإجمالي', ...d.totals } });
  });

  r.get('/pharmacy', async (req, res) => {
    gate(req, 'pharmacy');
    const d = await pharmacyReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    if (req.query.by === 'item') {
      return sendXlsx(res, `بيع-الصيدلية-بالصنف-${d.from}-${d.to}`, `بيع الصيدلية بالصنف · من ${d.from} لـ ${d.to}`,
        [{ h: 'الكود', k: 'code', w: 10 }, { h: 'الصنف', k: 'name', w: 36 }, { h: 'الكمية', k: 'qtyText', w: 26 }, { h: 'المبيعات', k: 'amount', money: true }, { h: 'التكلفة', k: 'cost', money: true }, { h: 'الربح', k: 'margin', money: true }],
        d.items.map((x) => ({ ...x, qtyText: qtyText(x.qty, x.units) })));
    }
    await sendXlsx(res, `بيع-الصيدلية-${d.from}-${d.to}`, `بيع الصيدلية باليوم · من ${d.from} لـ ${d.to}`,
      [{ h: 'اليوم', k: 'date', w: 13 }, { h: 'عدد الفواتير', k: 'count', w: 12 }, { h: 'البيع', k: 'sold', money: true }, { h: 'المرتجع', k: 'back', money: true }, { h: 'الصافي', k: 'net', money: true }],
      d.days, { totals: { date: 'الإجمالي', count: d.totals.count, sold: d.totals.sold, back: d.totals.back, net: d.totals.net } });
  });

  r.get('/expiry', async (req, res) => {
    gate(req);
    const d = await expiryReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    await sendXlsx(res, `الصلاحية-${cairoDate()}`, `الأصناف المنتهية واللي هتنتهي خلال ${d.days} يوم · ${cairoDate()}`,
      [{ h: 'المخزن', k: 'store', w: 22 }, { h: 'الكود', k: 'code', w: 10 }, { h: 'الصنف', k: 'name', w: 34 }, { h: 'التشغيلة', k: 'batchNo', w: 12 }, { h: 'الصلاحية', k: 'expiry', w: 12 }, { h: 'فاضل (يوم)', k: 'daysLeft', w: 11 }, { h: 'الكمية', k: 'qtyText', w: 24 }, { h: 'القيمة', k: 'value', money: true }],
      d.batches.map((x) => ({ ...x, qtyText: qtyText(x.qty, x.units) })), { totals: { store: 'الإجمالي', value: rm(d.totals.expired + d.totals.soon) } });
  });

  r.get('/stagnant', async (req, res) => {
    gate(req);
    const d = await stagnantReport(db, req.user, req.query);
    if (!xl(req)) return res.json(d);
    await sendXlsx(res, `الراكد-${cairoDate()}`, `أصناف ليها رصيد ومفيش منها صرف من ${d.days} يوم · ${cairoDate()}`,
      [{ h: 'المخزن', k: 'store', w: 22 }, { h: 'الكود', k: 'code', w: 10 }, { h: 'الصنف', k: 'name', w: 34 }, { h: 'الرصيد', k: 'qtyText', w: 24 }, { h: 'القيمة', k: 'value', money: true }, { h: 'آخر صرف', k: 'last', w: 17 }],
      d.items.map((x) => ({ ...x, qtyText: qtyText(x.qty, x.units), last: x.lastOut ? fmtAt(x.lastOut) : 'مفيش صرف خالص' })), { totals: { store: 'الإجمالي', value: d.totals.value } });
  });
  return r;
}
