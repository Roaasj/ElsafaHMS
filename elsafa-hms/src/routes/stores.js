// المخازن: الأرصدة بالتشغيلات والصلاحية، الاستلام من الموردين، التحويلات بين المخازن، كارت الصنف
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, forbidden, intId, str, cents, pounds, cairoDate } from '../lib/util.js';
import { toIso, toDateStr, toBool } from '../db/index.js';
import { searchKey, latinDigits } from '../../shared/text.js';
import { R } from '../lib/runtime.js';
import { qty2 } from '../../shared/money.js';
import {
  STORE_KINDS, STORE_DEPTS, MOVE_KINDS, canStore, needStore, consume, addStock, giveBack, unitsOf, balance,
} from '../lib/stock.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = qty2; // الكميات. المبالغ بتستعمل R.money.round
const addDays = (d, n) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); };
export const TR_ST = { requested: 'مطلوب', issued: 'اتصرف · مستني الاستلام', received: 'اتستلم · مستني التأكيد', confirmed: 'خلص', cancelled: 'اتلغى' };
const EXPIRY_DAYS = 90;

const storeDto = (s, user) => ({
  id: s.Id, name: s.Name, kind: s.Kind, kindName: STORE_KINDS[s.Kind], holds: s.Holds, floorId: s.FloorId, dept: s.Dept || null, notes: s.Notes, active: toBool(s.Active),
  mine: user ? canStore(user, s.Id) : undefined,
});
const itemUnits = (it) => unitsOf(it).map((u) => ({ key: u.key, name: u.name, factor: u.factor }));
function qtyNum(v, label = 'الكمية') {
  const n = Number(latinDigits(v ?? '').replace(/[,،\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} مش صحيحة`);
  return r2(n);
}
function holdsOk(store, item) { return store.Holds === 'all' || store.Holds === item.Kind; }

async function loadStore(t, id) {
  const s = await t.one('SELECT * FROM Stores WHERE Id = ?', [Number(id) || 0]);
  if (!s || !toBool(s.Active)) throw bad('المخزن مش موجود');
  return s;
}

/** تفاصيل التحويل */
async function transferDetails(db, id, user) {
  const x = await db.one(
    `SELECT t.*, f.Name AS FromName, s.Name AS ToName, u1.FullName AS ReqName, u2.FullName AS IssName, u3.FullName AS RecName, u4.FullName AS ConName, u5.FullName AS CanName
       FROM Transfers t JOIN Stores f ON f.Id = t.FromStoreId JOIN Stores s ON s.Id = t.ToStoreId
       LEFT JOIN Users u1 ON u1.Id = t.RequestedBy LEFT JOIN Users u2 ON u2.Id = t.IssuedBy LEFT JOIN Users u3 ON u3.Id = t.ReceivedBy
       LEFT JOIN Users u4 ON u4.Id = t.ConfirmedBy LEFT JOIN Users u5 ON u5.Id = t.CancelledBy WHERE t.Id = ?`, [id]);
  if (!x) throw notFound('التحويل مش موجود');
  const lines = await db.query(
    `SELECT l.*, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty FROM TransferLines l JOIN StockItems i ON i.Id = l.ItemId WHERE l.TransferId = ? ORDER BY l.Id`, [id]);
  const out = [];
  for (const l of lines) {
    const moves = await db.query(
      `SELECT m.Qty, b.BatchNo, b.Expiry FROM StockMoves m LEFT JOIN StockBatches b ON b.Id = m.BatchId WHERE m.RefType = 'trline' AND m.RefId = ? AND m.Kind = 'transfer_out'`, [l.Id]);
    out.push({
      id: l.Id, itemId: l.ItemId, name: l.Name, code: l.Code, kind: l.Kind, units: itemUnits(l),
      reqQty: Number(l.ReqQty), issuedQty: l.IssuedQty == null ? null : Number(l.IssuedQty),
      available: x.Status === 'requested' ? await balance(db, x.FromStoreId, l.ItemId) : null,
      batches: moves.map((m) => ({ qty: -Number(m.Qty), batchNo: m.BatchNo, expiry: toDateStr(m.Expiry) })),
    });
  }
  return {
    transfer: {
      id: x.Id, no: x.TransferNo, status: x.Status, statusName: TR_ST[x.Status], direct: toBool(x.Direct), note: x.Note,
      from: { id: x.FromStoreId, name: x.FromName, mine: canStore(user, x.FromStoreId) }, to: { id: x.ToStoreId, name: x.ToName, mine: canStore(user, x.ToStoreId) },
      requestedAt: toIso(x.RequestedAt), requestedBy: x.ReqName, issuedAt: toIso(x.IssuedAt), issuedBy: x.IssName,
      receivedAt: toIso(x.ReceivedAt), receivedBy: x.RecName, confirmedAt: toIso(x.ConfirmedAt), confirmedBy: x.ConName,
      cancelledAt: toIso(x.CancelledAt), cancelledBy: x.CanName, cancelReason: x.CancelReason, createdAt: toIso(x.CreatedAt),
    },
    lines: out,
  };
}

/** الصرف من المخزن المحوِّل (ولو مباشر: الاستلام في نفس اللحظة) */
async function issueTransfer(t, user, tr, qtyByLine, direct) {
  const now = new Date();
  const lines = await t.query('SELECT l.*, i.Name FROM TransferLines l JOIN StockItems i ON i.Id = l.ItemId WHERE l.TransferId = ?', [tr.Id]);
  let any = false;
  for (const l of lines) {
    const q = qtyByLine.has(l.Id) ? qtyByLine.get(l.Id) : Number(l.ReqQty);
    if (!(q >= 0)) throw bad('الكمية مش صحيحة');
    await t.run('UPDATE TransferLines SET IssuedQty = ? WHERE Id = ?', [r2(q), l.Id]);
    if (q > 0) {
      any = true;
      await consume(t, user, { storeId: tr.FromStoreId, itemId: l.ItemId, qty: q, kind: 'transfer_out', refType: 'trline', refId: l.Id, negative: can(user, 'stock.negative'), itemName: l.Name, note: `تحويل ${tr.TransferNo}` });
    }
  }
  if (!any) throw bad('مفيش ولا صنف اتصرف');
  await t.run('UPDATE Transfers SET Status = ?, IssuedAt = ?, IssuedBy = ?, Direct = ? WHERE Id = ?', ['issued', now, user.id, direct ? 1 : 0, tr.Id]);
  if (direct) await receiveTransfer(t, user, tr, true);
}
async function receiveTransfer(t, user, tr, direct = false) {
  const now = new Date();
  const lines = await t.query('SELECT * FROM TransferLines WHERE TransferId = ?', [tr.Id]);
  for (const l of lines) {
    const moves = await t.query(
      `SELECT m.Qty, m.Cost, b.BatchNo, b.Expiry FROM StockMoves m LEFT JOIN StockBatches b ON b.Id = m.BatchId WHERE m.RefType = 'trline' AND m.RefId = ? AND m.Kind = 'transfer_out' ORDER BY m.Id`, [l.Id]);
    for (const m of moves) {
      await addStock(t, user, {
        storeId: tr.ToStoreId, itemId: l.ItemId, qty: -Number(m.Qty), batchNo: m.BatchNo ?? null, expiry: m.Expiry ? toDateStr(m.Expiry) : null,
        cost: m.Cost == null ? null : Number(m.Cost), kind: 'transfer_in', refType: 'trin', refId: l.Id, note: `تحويل ${tr.TransferNo}`,
      });
    }
  }
  if (direct) await t.run("UPDATE Transfers SET Status = 'confirmed', ReceivedAt = ?, ReceivedBy = ?, ConfirmedAt = ?, ConfirmedBy = ? WHERE Id = ?", [now, user.id, now, user.id, tr.Id]);
  else await t.run("UPDATE Transfers SET Status = 'received', ReceivedAt = ?, ReceivedBy = ? WHERE Id = ?", [now, user.id, tr.Id]);
}

export default function storesRouter(db) {
  const r = router();

  r.get('/meta', async (req, res) => {
    need(req.user, 'stock.view');
    const rows = await db.query('SELECT * FROM Stores ORDER BY SortOrder, Id');
    const floors = await db.query('SELECT Id, Number FROM Floors WHERE Active = 1 ORDER BY Number');
    res.json({
      stores: rows.map((s) => storeDto(s, req.user)), kinds: STORE_KINDS, depts: STORE_DEPTS, floors: floors.map((f) => ({ id: f.Id, no: f.Number })),
      can: { all: can(req.user, 'stock.all') || can(req.user, 'settings.manage'), purchase: can(req.user, 'stock.purchase'), request: can(req.user, 'stock.request'),
        issue: can(req.user, 'stock.issue'), receive: can(req.user, 'stock.receive'), direct: can(req.user, 'stock.direct'), negative: can(req.user, 'stock.negative'),
        manage: can(req.user, 'settings.manage'), edit: can(req.user, 'stock.edit'), count: can(req.user, 'stock.count'), waste: can(req.user, 'stock.waste') },
      counting: (await db.query("SELECT StoreId, CountNo, Status FROM StockCounts WHERE Status IN ('open','submitted')")).map((c) => ({ storeId: c.StoreId, no: c.CountNo, status: c.Status })),
    });
  });

  r.get('/counts', async (req, res) => {
    need(req.user, 'stock.view');
    res.json(await storeCounts(db, req.user));
  });

  // ===== تعريف المخازن (المدير) =====
  const storeBody = (b) => {
    const errors = {};
    const name = str(b.name, 80);
    if (!name || name.length < 2) errors.name = 'اكتب اسم المخزن';
    if (!STORE_KINDS[b.kind]) errors.kind = 'اختار النوع';
    if (!['drug', 'supply', 'all'].includes(b.holds)) errors.holds = 'اختار بيشيل إيه';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return { name, kind: b.kind, holds: b.holds, floorId: b.floorId ? Number(b.floorId) : null, dept: STORE_DEPTS[b.dept] ? b.dept : null, notes: str(b.notes, 200), active: b.active === undefined ? true : !!b.active };
  };
  r.post('/list', async (req, res) => {
    need(req.user, 'settings.manage');
    const s = storeBody(req.body || {});
    const id = await db.tx(async (t) => {
      const max = await t.one('SELECT MAX(SortOrder) AS M FROM Stores');
      const nid = await t.insert('Stores', { Name: s.name, Kind: s.kind, Holds: s.holds, FloorId: s.floorId, Dept: s.dept, Notes: s.notes, SortOrder: Number(max?.M || 0) + 1, Active: 1, CreatedAt: new Date() });
      await audit(t, req.user, 'store.create', 'Store', nid, { now: s });
      return nid;
    });
    res.status(201).json({ store: storeDto(await db.one('SELECT * FROM Stores WHERE Id = ?', [id]), req.user) });
  });
  r.put('/list/:id', async (req, res) => {
    need(req.user, 'settings.manage');
    const id = intId(req.params.id);
    const s = storeBody(req.body || {});
    await db.tx(async (t) => {
      const old = await t.one('SELECT * FROM Stores WHERE Id = ?', [id]);
      if (!old) throw notFound('المخزن مش موجود');
      if (!s.active) {
        const q = await t.one('SELECT SUM(Qty) AS Q FROM StockBatches WHERE StoreId = ?', [id]);
        if (Number(q?.Q || 0) !== 0) throw bad('المخزن فيه رصيد. حوّله لمخزن تاني الأول');
      }
      await t.run('UPDATE Stores SET Name = ?, Kind = ?, Holds = ?, FloorId = ?, Dept = ?, Notes = ?, Active = ? WHERE Id = ?', [s.name, s.kind, s.holds, s.floorId, s.dept, s.notes, s.active ? 1 : 0, id]);
      await audit(t, req.user, 'store.update', 'Store', id, { old: { name: old.Name }, now: s });
    });
    res.json({ store: storeDto(await db.one('SELECT * FROM Stores WHERE Id = ?', [id]), req.user) });
  });

  // ===== الأرصدة =====
  r.get('/stock', async (req, res) => {
    need(req.user, 'stock.view');
    const all = req.query.storeId === 'all';
    if (all && !can(req.user, 'stock.all') && !can(req.user, 'settings.manage')) throw forbidden();
    const store = all ? null : await loadStore(db, req.query.storeId);
    if (store && !canStore(req.user, store.Id) && !can(req.user, 'stock.view') ) throw forbidden();
    const today = cairoDate(), soon = addDays(today, EXPIRY_DAYS);
    const items = await db.query(`SELECT * FROM StockItems WHERE Active = 1 ${store && store.Holds !== 'all' ? 'AND Kind = ?' : ''} ORDER BY Name`, store && store.Holds !== 'all' ? [store.Holds] : []);
    const batches = await db.query(`SELECT ItemId, StoreId, Qty, Expiry FROM StockBatches WHERE Qty <> 0 ${store ? 'AND StoreId = ?' : ''}`, store ? [store.Id] : []);
    const by = new Map();
    for (const b of batches) { if (!by.has(b.ItemId)) by.set(b.ItemId, []); by.get(b.ItemId).push(b); }
    const q = searchKey(req.query.q || '');
    const f = req.query.filter || 'all';
    const list = [];
    for (const it of items) {
      if (q && !searchKey(it.Name + ' ' + it.Code).includes(q)) continue;
      const bs = by.get(it.Id) || [];
      const qty = r2(bs.reduce((s, b) => s + Number(b.Qty), 0));
      const pos = bs.filter((b) => Number(b.Qty) > 0 && b.Expiry);
      const exp = pos.map((b) => toDateStr(b.Expiry)).sort()[0] || null;
      const expired = r2(pos.filter((b) => toDateStr(b.Expiry) < today).reduce((s, b) => s + Number(b.Qty), 0));
      const expSoon = r2(pos.filter((b) => toDateStr(b.Expiry) >= today && toDateStr(b.Expiry) <= soon).reduce((s, b) => s + Number(b.Qty), 0));
      const min = it.MinQty == null ? null : Number(it.MinQty);
      const low = min != null && qty <= min;
      const row = { id: it.Id, code: it.Code, name: it.Name, kind: it.Kind, units: itemUnits(it), qty, nearestExpiry: exp, expired, expSoon, minQty: min, low, negative: qty < 0, price: pounds(cents(it.Price)) };
      if (f === 'stock' && qty === 0) continue;
      if (f === 'low' && !low && !(qty <= 0 && min != null)) continue;
      if (f === 'expiring' && !expSoon && !expired) continue;
      if (f === 'negative' && qty >= 0) continue;
      list.push(row);
    }
    const allRows = items.map((it) => { const bs = by.get(it.Id) || []; return { qty: bs.reduce((s, b) => s + Number(b.Qty), 0), min: it.MinQty == null ? null : Number(it.MinQty), bs }; });
    res.json({
      store: store ? storeDto(store, req.user) : null, items: list.slice(0, 600), total: list.length,
      counts: {
        items: allRows.filter((x) => x.qty !== 0).length, low: allRows.filter((x) => x.min != null && x.qty <= x.min).length,
        expiring: allRows.filter((x) => x.bs.some((b) => Number(b.Qty) > 0 && b.Expiry && toDateStr(b.Expiry) <= soon)).length,
        negative: allRows.filter((x) => x.qty < 0).length,
      },
    });
  });

  // كارت الصنف: التشغيلات في كل مخزن وآخر الحركات
  r.get('/item/:id', async (req, res) => {
    need(req.user, 'stock.view');
    const id = intId(req.params.id);
    const it = await db.one('SELECT * FROM StockItems WHERE Id = ?', [id]);
    if (!it) throw notFound('الصنف مش موجود');
    const storeId = req.query.storeId && req.query.storeId !== 'all' ? Number(req.query.storeId) : null;
    const batches = await db.query(
      `SELECT b.*, s.Name AS StoreName FROM StockBatches b JOIN Stores s ON s.Id = b.StoreId WHERE b.ItemId = ? AND b.Qty <> 0 ${storeId ? 'AND b.StoreId = ?' : ''}
        ORDER BY s.SortOrder, CASE WHEN b.Expiry IS NULL THEN 1 ELSE 0 END, b.Expiry`, storeId ? [id, storeId] : [id]);
    const moves = await db.query(db.top(
      `SELECT m.*, s.Name AS StoreName, u.FullName AS ByName, b.BatchNo, b.Expiry FROM StockMoves m JOIN Stores s ON s.Id = m.StoreId LEFT JOIN Users u ON u.Id = m.UserId
         LEFT JOIN StockBatches b ON b.Id = m.BatchId WHERE m.ItemId = ? ${storeId ? 'AND m.StoreId = ?' : ''} ORDER BY m.Id DESC`, 150), storeId ? [id, storeId] : [id]);
    const perStore = new Map();
    for (const b of batches) { const k = b.StoreId; if (!perStore.has(k)) perStore.set(k, { id: k, name: b.StoreName, qty: 0 }); perStore.get(k).qty = r2(perStore.get(k).qty + Number(b.Qty)); }
    res.json({
      item: { id: it.Id, code: it.Code, name: it.Name, kind: it.Kind, units: itemUnits(it), price: pounds(cents(it.Price)), minQty: it.MinQty == null ? null : Number(it.MinQty), lastCost: it.LastCost == null ? null : Number(it.LastCost) },
      stores: [...perStore.values()],
      batches: batches.map((b) => ({ id: b.Id, store: b.StoreName, storeId: b.StoreId, batchNo: b.BatchNo, expiry: toDateStr(b.Expiry), qty: Number(b.Qty), cost: b.Cost == null ? null : Number(b.Cost) })),
      moves: moves.map((m) => ({ at: toIso(m.At), kind: m.Kind, kindName: MOVE_KINDS[m.Kind] || m.Kind, store: m.StoreName, qty: Number(m.Qty), batchNo: m.BatchNo, expiry: toDateStr(m.Expiry), by: m.ByName, note: m.Note, refType: m.RefType, refId: m.RefId })),
    });
  });

  // ===== الاستلام من الموردين ورصيد أول المدة =====
  r.get('/purchases', async (req, res) => {
    need(req.user, 'stock.view');
    const rows = await db.query(db.top(
      `SELECT p.*, s.Name AS StoreName, u.FullName AS ByName, (SELECT COUNT(*) FROM PurchaseLines l WHERE l.PurchaseId = p.Id) AS Lines
         FROM Purchases p JOIN Stores s ON s.Id = p.StoreId JOIN Users u ON u.Id = p.CreatedBy ORDER BY p.Id DESC`, 200));
    const suppliers = await db.query("SELECT DISTINCT Supplier FROM Purchases WHERE Supplier IS NOT NULL AND Kind = 'supplier'");
    res.json({
      purchases: rows.filter((p) => canStore(req.user, p.StoreId)).map((p) => ({
        id: p.Id, no: p.PurchaseNo, kind: p.Kind, store: p.StoreName, storeId: p.StoreId, supplier: p.Supplier, invoiceNo: p.InvoiceNo, invoiceDate: toDateStr(p.InvoiceDate),
        total: Number(p.Total), lines: Number(p.Lines), createdAt: toIso(p.CreatedAt), createdBy: p.ByName,
      })),
      suppliers: suppliers.map((x) => x.Supplier),
    });
  });
  r.get('/purchases/:id', async (req, res) => {
    need(req.user, 'stock.view');
    const id = intId(req.params.id);
    const p = await db.one('SELECT p.*, s.Name AS StoreName, u.FullName AS ByName FROM Purchases p JOIN Stores s ON s.Id = p.StoreId JOIN Users u ON u.Id = p.CreatedBy WHERE p.Id = ?', [id]);
    if (!p) throw notFound('مش موجود');
    const lines = await db.query('SELECT l.*, i.Name, i.Code FROM PurchaseLines l JOIN StockItems i ON i.Id = l.ItemId WHERE l.PurchaseId = ? ORDER BY l.Id', [id]);
    res.json({
      purchase: { id: p.Id, no: p.PurchaseNo, kind: p.Kind, store: p.StoreName, supplier: p.Supplier, invoiceNo: p.InvoiceNo, invoiceDate: toDateStr(p.InvoiceDate), total: Number(p.Total), note: p.Note, createdAt: toIso(p.CreatedAt), createdBy: p.ByName },
      lines: lines.map((l) => ({ name: l.Name, code: l.Code, unit: l.UnitName, factor: l.UnitFactor, qty: Number(l.Qty), baseQty: Number(l.BaseQty), unitCost: Number(l.UnitCost), batchNo: l.BatchNo, expiry: toDateStr(l.Expiry), total: Number(l.LineTotal) })),
    });
  });
  r.post('/purchases', async (req, res) => {
    need(req.user, 'stock.purchase');
    const b = req.body || {};
    const kind = b.kind === 'opening' ? 'opening' : 'supplier';
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw bad('ضيف الأصناف');
    if (kind === 'supplier' && !str(b.supplier, 150)) throw bad('اكتب اسم المورد', { errors: { supplier: 'اكتب اسم المورد' } });
    const out = await db.tx(async (t) => {
      const store = await loadStore(t, b.storeId);
      needStore(req.user, store.Id);
      const now = new Date();
      const no = await t.nextNumber('purchase');
      const pid = await t.insert('Purchases', {
        PurchaseNo: no, Kind: kind, StoreId: store.Id, Supplier: kind === 'supplier' ? str(b.supplier, 150) : (str(b.supplier, 150) || 'رصيد أول المدة'),
        InvoiceNo: str(b.invoiceNo, 40), InvoiceDate: DATE_RE.test(b.invoiceDate || '') ? b.invoiceDate : null, Total: 0, Note: str(b.note, 300), CreatedAt: now, CreatedBy: req.user.id,
      });
      let total = 0;
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        const where = `السطر ${k + 1}`;
        const it = await t.one('SELECT * FROM StockItems WHERE Id = ?', [Number(l.itemId) || 0]);
        if (!it) throw bad(`${where}: الصنف مش موجود`);
        if (!holdsOk(store, it)) throw bad(`${where}: «${it.Name}» ${it.Kind === 'drug' ? 'دوا' : 'مستلزم'} و«${store.Name}» مش بيشيله`);
        const u = unitsOf(it).find((x) => x.key === (l.unit || 'base')) || unitsOf(it)[0];
        const qty = qtyNum(l.qty, `${where}: الكمية`);
        const cost = l.cost === '' || l.cost == null ? 0 : Number(latinDigits(l.cost));
        if (!(cost >= 0)) throw bad(`${where}: السعر مش صحيح`);
        const expiry = DATE_RE.test(l.expiry || '') ? l.expiry : null;
        if (expiry && expiry < cairoDate()) throw bad(`${where}: «${it.Name}» صلاحيته منتهية (${expiry})`);
        const batchNo = str(l.batchNo, 40);
        const base = r2(qty * u.factor);
        const lineTotal = R.money.round(qty * cost);
        const costPerBase = u.factor ? cost / u.factor : cost;
        const bid = await addStock(t, req.user, { storeId: store.Id, itemId: it.Id, qty: base, batchNo, expiry, cost: costPerBase, kind: kind === 'opening' ? 'opening' : 'receive', refType: 'purchase', refId: pid, note: `${kind === 'opening' ? 'رصيد أول المدة' : 'فاتورة'} ${no}` });
        await t.insert('PurchaseLines', { PurchaseId: pid, ItemId: it.Id, UnitName: u.name, UnitFactor: u.factor, Qty: qty, BaseQty: base, UnitCost: cost, BatchNo: batchNo, Expiry: expiry, LineTotal: lineTotal, BatchId: bid });
        if (cost > 0) await t.run('UPDATE StockItems SET LastCost = ? WHERE Id = ?', [Math.round(costPerBase * 10000) / 10000, it.Id]);
        total += lineTotal;
      }
      await t.run('UPDATE Purchases SET Total = ? WHERE Id = ?', [R.money.round(total), pid]);
      await audit(t, req.user, 'stock.purchase', 'Purchase', pid, { now: { no, kind, store: store.Name, supplier: b.supplier || null, lines: lines.length, total: R.money.round(total) } });
      return { pid, no };
    });
    res.status(201).json({ id: out.pid, no: out.no });
  });

  // ===== التحويلات =====
  r.get('/transfers', async (req, res) => {
    need(req.user, 'stock.view');
    const st = TR_ST[req.query.status] ? req.query.status : null;
    const rows = await db.query(db.top(
      `SELECT t.*, f.Name AS FromName, s.Name AS ToName, u.FullName AS ReqName, (SELECT COUNT(*) FROM TransferLines l WHERE l.TransferId = t.Id) AS Lines
         FROM Transfers t JOIN Stores f ON f.Id = t.FromStoreId JOIN Stores s ON s.Id = t.ToStoreId LEFT JOIN Users u ON u.Id = COALESCE(t.RequestedBy, t.IssuedBy)
        ${st ? 'WHERE t.Status = ?' : ''} ORDER BY t.Id DESC`, 300), st ? [st] : []);
    const mine = rows.filter((x) => canStore(req.user, x.FromStoreId) || canStore(req.user, x.ToStoreId));
    const todo = (x) => (x.Status === 'requested' && canStore(req.user, x.FromStoreId) && can(req.user, 'stock.issue') ? 'issue'
      : x.Status === 'issued' && canStore(req.user, x.ToStoreId) && can(req.user, 'stock.receive') ? 'receive'
      : x.Status === 'received' && canStore(req.user, x.FromStoreId) && can(req.user, 'stock.issue') ? 'confirm' : null);
    res.json({
      transfers: mine.map((x) => ({
        id: x.Id, no: x.TransferNo, status: x.Status, statusName: TR_ST[x.Status], direct: toBool(x.Direct), from: { id: x.FromStoreId, name: x.FromName }, to: { id: x.ToStoreId, name: x.ToName },
        lines: Number(x.Lines), by: x.ReqName, createdAt: toIso(x.CreatedAt), todo: todo(x), note: x.Note,
      })),
    });
  });
  r.get('/transfers/:id', async (req, res) => {
    need(req.user, 'stock.view');
    const d = await transferDetails(db, intId(req.params.id), req.user);
    if (!d.transfer.from.mine && !d.transfer.to.mine) throw forbidden();
    res.json(d);
  });

  // طلب (من المخزن الفرعي) أو صرف على طول (من المخزن المحوِّل)
  r.post('/transfers', async (req, res) => {
    const b = req.body || {};
    const issue = !!b.issue;
    need(req.user, issue ? 'stock.issue' : 'stock.request');
    if (b.direct && !can(req.user, 'stock.direct')) throw forbidden('التحويل المباشر محتاج صلاحية من المدير');
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw bad('ضيف الأصناف');
    const id = await db.tx(async (t) => {
      const from = await loadStore(t, b.fromStoreId), to = await loadStore(t, b.toStoreId);
      if (from.Id === to.Id) throw bad('اختار مخزن تاني');
      needStore(req.user, issue ? from.Id : to.Id);
      const now = new Date();
      const no = await t.nextNumber('transfer');
      const tid = await t.insert('Transfers', {
        TransferNo: no, FromStoreId: from.Id, ToStoreId: to.Id, Status: 'requested', Direct: 0, Note: str(b.note, 300),
        RequestedAt: now, RequestedBy: req.user.id, CreatedAt: now,
      });
      const seen = new Set();
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        const it = await t.one('SELECT * FROM StockItems WHERE Id = ?', [Number(l.itemId) || 0]);
        if (!it) throw bad(`السطر ${k + 1}: الصنف مش موجود`);
        if (seen.has(it.Id)) throw bad(`«${it.Name}» متكرر`);
        seen.add(it.Id);
        if (!holdsOk(from, it) || !holdsOk(to, it)) throw bad(`«${it.Name}» مينفعش يتحوّل بين المخزنين دول`);
        const u = unitsOf(it).find((x) => x.key === (l.unit || 'base')) || unitsOf(it)[0];
        const qty = r2(qtyNum(l.qty, `«${it.Name}»: الكمية`) * u.factor);
        await t.insert('TransferLines', { TransferId: tid, ItemId: it.Id, ReqQty: qty, IssuedQty: null, Note: str(l.note, 200) });
      }
      const tr = await t.one('SELECT * FROM Transfers WHERE Id = ?', [tid]);
      if (issue) await issueTransfer(t, req.user, tr, new Map(), !!b.direct);
      await audit(t, req.user, issue ? 'transfer.issue' : 'transfer.request', 'Transfer', tid, { now: { no, from: from.Name, to: to.Name, lines: lines.length, direct: !!b.direct } });
      return tid;
    });
    res.status(201).json(await transferDetails(db, id, req.user));
  });

  const act = (name, fn) => r.post(`/transfers/:id/${name}`, async (req, res) => {
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const tr = await t.one('SELECT * FROM Transfers WHERE Id = ?', [id]);
      if (!tr) throw notFound('التحويل مش موجود');
      await fn(t, req, tr);
    });
    res.json(await transferDetails(db, id, req.user));
  });

  act('issue', async (t, req, tr) => {
    need(req.user, 'stock.issue');
    needStore(req.user, tr.FromStoreId);
    if (tr.Status !== 'requested') throw conflict('التحويل ده اتصرف قبل كده');
    const direct = !!req.body?.direct;
    if (direct && !can(req.user, 'stock.direct')) throw forbidden('التحويل المباشر محتاج صلاحية من المدير');
    const m = new Map();
    for (const l of req.body?.lines || []) m.set(Number(l.lineId), l.qty === '' || l.qty == null ? 0 : r2(Number(latinDigits(l.qty))));
    await issueTransfer(t, req.user, tr, m, direct);
    await audit(t, req.user, 'transfer.issue', 'Transfer', tr.Id, { now: { no: tr.TransferNo, direct } });
  });
  act('receive', async (t, req, tr) => {
    need(req.user, 'stock.receive');
    needStore(req.user, tr.ToStoreId);
    if (tr.Status !== 'issued') throw conflict(tr.Status === 'requested' ? 'التحويل لسه ما اتصرفش' : 'التحويل ده اتستلم قبل كده');
    await receiveTransfer(t, req.user, tr);
    await audit(t, req.user, 'transfer.receive', 'Transfer', tr.Id, { now: { no: tr.TransferNo } });
  });
  act('confirm', async (t, req, tr) => {
    need(req.user, 'stock.issue');
    needStore(req.user, tr.FromStoreId);
    if (tr.Status !== 'received') throw conflict('التحويل لازم يتستلم الأول');
    await t.run("UPDATE Transfers SET Status = 'confirmed', ConfirmedAt = ?, ConfirmedBy = ? WHERE Id = ?", [new Date(), req.user.id, tr.Id]);
    await audit(t, req.user, 'transfer.confirm', 'Transfer', tr.Id, { now: { no: tr.TransferNo } });
  });
  act('cancel', async (t, req, tr) => {
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب');
    if (tr.Status === 'requested') {
      if (!canStore(req.user, tr.FromStoreId) && !canStore(req.user, tr.ToStoreId)) throw forbidden();
    } else if (tr.Status === 'issued') {
      // اتصرف ولسه ما اتستلمش: الرصيد يرجع للمخزن اللي صرف
      need(req.user, 'stock.issue');
      needStore(req.user, tr.FromStoreId);
      for (const l of await t.query('SELECT Id FROM TransferLines WHERE TransferId = ?', [tr.Id])) {
        await giveBack(t, req.user, { refType: 'trline', refId: l.Id, kind: 'transfer_in', note: `إلغاء تحويل ${tr.TransferNo}` });
      }
    } else throw conflict('التحويل ده اتستلم. اعمل تحويل عكسي');
    await t.run("UPDATE Transfers SET Status = 'cancelled', CancelledAt = ?, CancelledBy = ?, CancelReason = ? WHERE Id = ?", [new Date(), req.user.id, reason, tr.Id]);
    await audit(t, req.user, 'transfer.cancel', 'Transfer', tr.Id, { now: { no: tr.TransferNo }, note: reason });
  });

  // ===== الإعدام =====
  r.post('/waste', async (req, res) => {
    need(req.user, 'stock.waste');
    const b = req.body || {};
    const reason = str(b.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب (منتهي، مكسور، تالف…)', { errors: { reason: 'اكتب السبب' } });
    const out = await db.tx(async (t) => {
      const bt = await t.one('SELECT b.*, i.Name FROM StockBatches b JOIN StockItems i ON i.Id = b.ItemId WHERE b.Id = ?', [Number(b.batchId) || 0]);
      if (!bt) throw notFound('التشغيلة مش موجودة');
      needStore(req.user, bt.StoreId);
      const qty = qtyNum(b.qty);
      if (qty > Number(bt.Qty)) throw bad(`الموجود من التشغيلة دي ${Number(bt.Qty)} بس`);
      const { assertNotFrozen } = await import('../lib/stock.js');
      await assertNotFrozen(t, bt.StoreId);
      const no = await t.nextNumber('waste');
      const wid = await t.insert('StockWaste', { WasteNo: no, StoreId: bt.StoreId, ItemId: bt.ItemId, BatchId: bt.Id, Qty: qty, Cost: bt.Cost, Reason: reason, CreatedAt: new Date(), CreatedBy: req.user.id });
      await t.run('UPDATE StockBatches SET Qty = Qty - ? WHERE Id = ?', [qty, bt.Id]);
      await t.insert('StockMoves', { At: new Date(), Kind: 'waste', ItemId: bt.ItemId, StoreId: bt.StoreId, BatchId: bt.Id, Qty: -qty, Cost: bt.Cost, RefType: 'waste', RefId: wid, UserId: req.user.id, Note: reason });
      await audit(t, req.user, 'stock.waste', 'StockWaste', wid, { now: { no, item: bt.Name, batch: bt.BatchNo, qty, value: bt.Cost == null ? null : R.money.round(qty * Number(bt.Cost)) }, note: reason });
      return { no };
    });
    res.status(201).json(out);
  });
  r.get('/waste', async (req, res) => {
    need(req.user, 'stock.view');
    const rows = await db.query(db.top(
      `SELECT w.*, i.Name, i.Unit, s.Name AS StoreName, b.BatchNo, b.Expiry, u.FullName AS ByName FROM StockWaste w JOIN StockItems i ON i.Id = w.ItemId JOIN Stores s ON s.Id = w.StoreId
         LEFT JOIN StockBatches b ON b.Id = w.BatchId JOIN Users u ON u.Id = w.CreatedBy ORDER BY w.Id DESC`, 300));
    res.json({ waste: rows.filter((w) => canStore(req.user, w.StoreId)).map((w) => ({
      id: w.Id, no: w.WasteNo, store: w.StoreName, item: w.Name, unit: w.Unit, qty: Number(w.Qty), batchNo: w.BatchNo, expiry: toDateStr(w.Expiry),
      value: w.Cost == null ? null : R.money.round(Number(w.Qty) * Number(w.Cost)), reason: w.Reason, at: toIso(w.CreatedAt), by: w.ByName,
    })) });
  });

  // ===== الجرد: المخزن بيقف، العد اليدوي يتدخل، والمدير يعتمد الفروق =====
  const countDetails = async (id) => {
    const c = await db.one(
      `SELECT c.*, s.Name AS StoreName, u1.FullName AS ByName, u2.FullName AS SubName, u3.FullName AS AppName FROM StockCounts c JOIN Stores s ON s.Id = c.StoreId
         JOIN Users u1 ON u1.Id = c.CreatedBy LEFT JOIN Users u2 ON u2.Id = c.SubmittedBy LEFT JOIN Users u3 ON u3.Id = c.ApprovedBy WHERE c.Id = ?`, [id]);
    if (!c) throw notFound('الجرد مش موجود');
    const lines = await db.query(
      `SELECT l.*, i.Name, i.Code, i.Kind, i.Unit, i.MidUnit, i.MidQty, i.PackUnit, i.PackQty, i.LastCost FROM StockCountLines l JOIN StockItems i ON i.Id = l.ItemId
        WHERE l.CountId = ? ORDER BY i.Kind, i.Name, CASE WHEN l.Expiry IS NULL THEN 1 ELSE 0 END, l.Expiry`, [id]);
    let diffValue = 0;
    const out = lines.map((l) => {
      const diff = l.CountedQty == null ? null : r2(Number(l.CountedQty) - Number(l.SystemQty));
      const cost = l.Cost == null ? (l.LastCost == null ? null : Number(l.LastCost)) : Number(l.Cost);
      if (diff && cost != null) diffValue += diff * cost;
      return { id: l.Id, itemId: l.ItemId, name: l.Name, code: l.Code, kind: l.Kind, units: itemUnits(l), batchNo: l.BatchNo, expiry: toDateStr(l.Expiry),
        systemQty: Number(l.SystemQty), counted: l.CountedQty == null ? null : Number(l.CountedQty), diff, cost };
    });
    return {
      count: { id: c.Id, no: c.CountNo, status: c.Status, store: { id: c.StoreId, name: c.StoreName }, note: c.Note, createdAt: toIso(c.CreatedAt), createdBy: c.ByName,
        submittedAt: toIso(c.SubmittedAt), submittedBy: c.SubName, approvedAt: toIso(c.ApprovedAt), approvedBy: c.AppName, diffValue: c.DiffValue == null ? R.money.round(diffValue) : Number(c.DiffValue) },
      lines: out, remaining: out.filter((x) => x.counted == null).length,
    };
  };
  r.get('/counts/list', async (req, res) => {
    need(req.user, 'stock.view');
    const rows = await db.query(db.top('SELECT c.*, s.Name AS StoreName, u.FullName AS ByName FROM StockCounts c JOIN Stores s ON s.Id = c.StoreId JOIN Users u ON u.Id = c.CreatedBy ORDER BY c.Id DESC', 100));
    res.json({ counts: rows.filter((c) => canStore(req.user, c.StoreId)).map((c) => ({ id: c.Id, no: c.CountNo, status: c.Status, store: c.StoreName, storeId: c.StoreId, createdAt: toIso(c.CreatedAt), by: c.ByName, diffValue: c.DiffValue == null ? null : Number(c.DiffValue) })) });
  });
  r.get('/counts/:id', async (req, res) => { need(req.user, 'stock.view'); res.json(await countDetails(intId(req.params.id))); });
  r.post('/counts', async (req, res) => {
    need(req.user, 'stock.count');
    const id = await db.tx(async (t) => {
      const st = await loadStore(t, req.body?.storeId);
      needStore(req.user, st.Id);
      if (await t.one("SELECT Id FROM StockCounts WHERE StoreId = ? AND Status IN ('open','submitted')", [st.Id])) throw conflict('فيه جرد مفتوح للمخزن ده');
      const pend = await t.one("SELECT COUNT(*) AS N FROM Transfers WHERE Status = 'issued' AND (FromStoreId = ? OR ToStoreId = ?)", [st.Id, st.Id]);
      if (Number(pend?.N)) throw conflict(`فيه ${pend.N} تحويل اتصرف ولسه ما اتستلمش على المخزن ده. خلّصه الأول`);
      const no = await t.nextNumber('count');
      const cid = await t.insert('StockCounts', { CountNo: no, StoreId: st.Id, Status: 'open', Note: str(req.body?.note, 300), CreatedAt: new Date(), CreatedBy: req.user.id });
      for (const b of await t.query('SELECT * FROM StockBatches WHERE StoreId = ? AND Qty <> 0', [st.Id])) {
        await t.insert('StockCountLines', { CountId: cid, ItemId: b.ItemId, BatchId: b.Id, BatchNo: b.BatchNo, Expiry: b.Expiry ? toDateStr(b.Expiry) : null, SystemQty: Number(b.Qty), CountedQty: null, Cost: b.Cost });
      }
      await audit(t, req.user, 'stock.count', 'StockCount', cid, { now: { no, store: st.Name, step: 'open' } });
      return cid;
    });
    res.status(201).json(await countDetails(id));
  });
  const countAct = (name, fn) => r.post(`/counts/:id/${name}`, async (req, res) => {
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const c = await t.one('SELECT * FROM StockCounts WHERE Id = ?', [id]);
      if (!c) throw notFound('الجرد مش موجود');
      await fn(t, req, c);
    });
    res.json(await countDetails(id));
  });
  // حفظ العد (وصنف لقيناه ومش متسجل)
  countAct('save', async (t, req, c) => {
    need(req.user, 'stock.count');
    needStore(req.user, c.StoreId);
    if (c.Status !== 'open') throw conflict('الجرد اتسلّم. لو فيه تعديل المدير يرجّعه');
    for (const l of req.body?.lines || []) {
      const v = l.counted === '' || l.counted == null ? null : Number(latinDigits(l.counted));
      if (v != null && !(v >= 0)) throw bad('الكمية مش صحيحة');
      await t.run('UPDATE StockCountLines SET CountedQty = ? WHERE Id = ? AND CountId = ?', [v == null ? null : r2(v), Number(l.id), c.Id]);
    }
    for (const n of req.body?.add || []) {
      const it = await t.one('SELECT * FROM StockItems WHERE Id = ?', [Number(n.itemId) || 0]);
      if (!it) throw bad('الصنف مش موجود');
      const q = Number(latinDigits(n.counted));
      if (!(q >= 0)) throw bad('الكمية مش صحيحة');
      await t.insert('StockCountLines', { CountId: c.Id, ItemId: it.Id, BatchId: null, BatchNo: str(n.batchNo, 40), Expiry: DATE_RE.test(n.expiry || '') ? n.expiry : null, SystemQty: 0, CountedQty: r2(q), Cost: it.LastCost });
    }
  });
  countAct('submit', async (t, req, c) => {
    need(req.user, 'stock.count');
    needStore(req.user, c.StoreId);
    if (c.Status !== 'open') throw conflict('الجرد اتسلّم قبل كده');
    const miss = await t.one('SELECT COUNT(*) AS N FROM StockCountLines WHERE CountId = ? AND CountedQty IS NULL', [c.Id]);
    if (Number(miss?.N)) throw bad(`فيه ${miss.N} سطر لسه ما اتعدّش. اكتب العدد (ولو مش موجود اكتب 0)`);
    await t.run("UPDATE StockCounts SET Status = 'submitted', SubmittedAt = ?, SubmittedBy = ? WHERE Id = ?", [new Date(), req.user.id, c.Id]);
    await audit(t, req.user, 'stock.count', 'StockCount', c.Id, { now: { no: c.CountNo, step: 'submit' } });
  });
  countAct('reopen', async (t, req, c) => {
    need(req.user, 'settings.manage');
    if (c.Status !== 'submitted') throw conflict('الجرد مش متسلّم');
    await t.run("UPDATE StockCounts SET Status = 'open', SubmittedAt = NULL, SubmittedBy = NULL WHERE Id = ?", [c.Id]);
  });
  // اعتماد المدير: الرصيد بيتظبط على العد، والفرق بالقيمة بيتسجل
  countAct('approve', async (t, req, c) => {
    need(req.user, 'settings.manage');
    if (c.Status !== 'submitted') throw conflict('الجرد لازم يتسلّم الأول');
    let value = 0;
    const lines = await t.query('SELECT l.*, i.LastCost FROM StockCountLines l JOIN StockItems i ON i.Id = l.ItemId WHERE l.CountId = ?', [c.Id]);
    for (const l of lines) {
      const diff = r2(Number(l.CountedQty) - Number(l.SystemQty));
      if (!diff) continue;
      const cost = l.Cost == null ? (l.LastCost == null ? null : Number(l.LastCost)) : Number(l.Cost);
      if (cost != null) value += diff * cost;
      if (l.BatchId) {
        await t.run('UPDATE StockBatches SET Qty = Qty + ? WHERE Id = ?', [diff, l.BatchId]);
        await t.insert('StockMoves', { At: new Date(), Kind: 'count', ItemId: l.ItemId, StoreId: c.StoreId, BatchId: l.BatchId, Qty: diff, Cost: cost, RefType: 'count', RefId: c.Id, UserId: req.user.id, Note: `جرد ${c.CountNo}` });
      } else if (diff > 0) {
        await addStock(t, req.user, { storeId: c.StoreId, itemId: l.ItemId, qty: diff, batchNo: l.BatchNo, expiry: l.Expiry ? toDateStr(l.Expiry) : null, cost, kind: 'count', refType: 'count', refId: c.Id, note: `جرد ${c.CountNo}`, ignoreFreeze: true, fillNegative: false });
      }
    }
    await t.run("UPDATE StockCounts SET Status = 'approved', ApprovedAt = ?, ApprovedBy = ?, DiffValue = ? WHERE Id = ?", [new Date(), req.user.id, R.money.round(value), c.Id]);
    await audit(t, req.user, 'stock.count', 'StockCount', c.Id, { now: { no: c.CountNo, step: 'approve', value: R.money.round(value) } });
  });
  countAct('cancel', async (t, req, c) => {
    if (!can(req.user, 'settings.manage') && !(can(req.user, 'stock.count') && c.Status === 'open')) throw forbidden();
    if (!['open', 'submitted'].includes(c.Status)) throw conflict('الجرد خلص');
    await t.run("UPDATE StockCounts SET Status = 'cancelled', CancelledAt = ?, CancelledBy = ? WHERE Id = ?", [new Date(), req.user.id, c.Id]);
    await audit(t, req.user, 'stock.count', 'StockCount', c.Id, { now: { no: c.CountNo, step: 'cancel' } });
  });

  return r;
}

/** للرئيسية والقايمة: التحويلات اللي مستنية المستخدم */
export async function storeCounts(db, user) {
  const rows = await db.query("SELECT FromStoreId, ToStoreId, Status FROM Transfers WHERE Status IN ('requested','issued','received')");
  let issue = 0, receive = 0, confirm = 0;
  for (const x of rows) {
    if (x.Status === 'requested' && canStore(user, x.FromStoreId) && can(user, 'stock.issue')) issue++;
    if (x.Status === 'issued' && canStore(user, x.ToStoreId) && can(user, 'stock.receive')) receive++;
    if (x.Status === 'received' && canStore(user, x.FromStoreId) && can(user, 'stock.issue')) confirm++;
  }
  return { issue, receive, confirm, total: issue + receive + confirm };
}
