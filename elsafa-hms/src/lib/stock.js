// محرك المخزن: الرصيد بالتشغيلة، الصرف بالأقرب انتهاءً، الرصيد السالب بصلاحية، والحركات
import { LIVE } from './lookups.js';
import { bad, conflict } from './util.js';
import { can } from './auth.js';
import { toDateStr } from '../db/index.js';
import { qty2, cost4 } from '../../shared/money.js';

export const STORE_KINDS = { main: 'رئيسي', pharmacy: 'صيدلية', sub: 'فرعي' };
export const MOVE_KINDS = {
  receive: 'استلام من مورد', opening: 'رصيد أول المدة', transfer_out: 'تحويل لمخزن', transfer_in: 'تحويل من مخزن',
  ticket: 'صرف لمريض (تذكرة)', ticket_back: 'رجوع من تذكرة', late: 'مستحق لاحق', late_back: 'إلغاء مستحق لاحق', adjust: 'تسوية',
  visit: 'صرف في زيارة', visit_back: 'رجوع من زيارة', sale: 'بيع صيدلية', sale_back: 'مرتجع بيع', count: 'فرق جرد', waste: 'إعدام',
};
/** أقسام المخازن (البرنامج بيختار مخزن القسم لوحده) */
export const STORE_DEPTS = LIVE.STORE_DEPTS;
/** مخازن الأقسام الافتراضية */
const DEPT_STORES = [['مخزن العمليات', 'or', 6], ['مخزن العناية', 'icu', 6], ['مخزن الحضانة', 'nursery', 3], ['مخزن الطوارئ', 'emergency', null], ['مخزن العيادات', 'clinic', null], ['مخزن الأشعة', 'radiology', null], ['مخزن المعمل', 'lab', null]];
const r2 = qty2; // كل استخدامات r2 هنا كميات

/** المخازن الافتراضية: رئيسي أدوية، رئيسي مستلزمات، صيدلية، ومخزن لكل دور */
export async function seedStores(db) {
  const n = await db.one('SELECT COUNT(*) AS N FROM Stores');
  if (Number(n?.N)) return seedDeptStores(db);
  const now = new Date();
  await db.insert('Stores', { Name: 'مخزن الأدوية الرئيسي', Kind: 'main', Holds: 'drug', SortOrder: 1, Active: 1, CreatedAt: now });
  await db.insert('Stores', { Name: 'مخزن المستلزمات الرئيسي', Kind: 'main', Holds: 'supply', SortOrder: 2, Active: 1, CreatedAt: now });
  await db.insert('Stores', { Name: 'الصيدلية', Kind: 'pharmacy', Holds: 'all', SortOrder: 3, Active: 1, CreatedAt: now });
  for (const f of await db.query('SELECT Id, Number, Notes FROM Floors WHERE Active = 1 ORDER BY Number')) {
    await db.insert('Stores', { Name: `مخزن الدور ${f.Number}`, Kind: 'sub', Holds: 'all', FloorId: f.Id, SortOrder: 10 + f.Number, Active: 1, CreatedAt: now });
  }
  await seedDeptStores(db);
}
/** مخازن الأقسام (مرة واحدة بس، والمدير يعدّل أو يزوّد بعد كده) */
async function seedDeptStores(db) {
  const done = await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'storesSeed'");
  if (done) return;
  const now = new Date();
  const floors = new Map((await db.query('SELECT Id, Number FROM Floors')).map((f) => [f.Number, f.Id]));
  let i = 30;
  for (const [name, dept, fno] of DEPT_STORES) {
    if (await db.one('SELECT Id FROM Stores WHERE Dept = ?', [dept])) continue;
    await db.insert('Stores', { Name: name, Kind: 'sub', Holds: 'all', FloorId: null, Dept: dept, Notes: fno && floors.get(fno) ? `الدور ${fno}` : null, SortOrder: i++, Active: 1, CreatedAt: now });
  }
  await db.insert('AppSettings', { '[Key]': 'storesSeed', Value: '2', UpdatedAt: now });
}
/** المخزن في جرد؟ (بيقف لحد ما الجرد يخلص) */
export async function assertNotFrozen(t, storeId) {
  const c = await t.one(t.top("SELECT c.CountNo, s.Name FROM StockCounts c JOIN Stores s ON s.Id = c.StoreId WHERE c.StoreId = ? AND c.Status IN ('open','submitted')", 1), [storeId]);
  if (c) throw conflict(`«${c.Name}» واقف للجرد (جرد رقم ${c.CountNo}). الحركة ترجع بعد اعتماد الجرد`);
}
/** المخزن الافتراضي لقسم */
export async function deptStore(t, dept) {
  if (!dept) return null;
  return t.one(t.top('SELECT * FROM Stores WHERE Dept = ? AND Active = 1 ORDER BY SortOrder, Id', 1), [dept]);
}

/** المستخدم يقدر يشتغل على المخزن ده؟ (حسابات المخزن والمدير على الكل) */
export function canStore(user, storeId) {
  return can(user, 'stock.all') || can(user, 'settings.manage') || (user?.stores || []).includes(Number(storeId));
}
export function needStore(user, storeId) {
  if (!canStore(user, storeId)) throw bad('المخزن ده مش مربوط بيك. المدير يربطه من الإعدادات ← المستخدمين');
}

export async function balance(t, storeId, itemId) {
  const r = await t.one('SELECT SUM(Qty) AS Q FROM StockBatches WHERE StoreId = ? AND ItemId = ?', [storeId, itemId]);
  return r2(r?.Q || 0);
}

async function move(t, user, m) {
  await t.insert('StockMoves', {
    At: new Date(), Kind: m.kind, ItemId: m.itemId, StoreId: m.storeId, BatchId: m.batchId ?? null, Qty: r2(m.qty), Cost: m.cost == null ? null : cost4(m.cost),
    RefType: m.refType ?? null, RefId: m.refId ?? null, UserId: user?.id ?? null, Note: m.note ?? null,
  });
}
async function looseBatch(t, storeId, itemId) {
  const b = await t.one(t.top('SELECT * FROM StockBatches WHERE StoreId = ? AND ItemId = ? AND BatchNo IS NULL AND Expiry IS NULL ORDER BY Id', 1), [storeId, itemId]);
  if (b) return b;
  const id = await t.insert('StockBatches', { ItemId: itemId, StoreId: storeId, BatchNo: null, Expiry: null, Qty: 0, Cost: null, CreatedAt: new Date() });
  return t.one('SELECT * FROM StockBatches WHERE Id = ?', [id]);
}

/**
 * صرف من مخزن بالأقرب انتهاءً. qty بأصغر وحدة.
 * negative: مسموح الرصيد يبقى سالب (صلاحية المستخدم). بيرجّع التوزيع على التشغيلات
 */
export async function consume(t, user, { storeId, itemId, qty, kind, refType, refId, note, negative = false, itemName = '', ignoreFreeze = false }) {
  qty = r2(qty);
  if (qty <= 0) return [];
  if (!ignoreFreeze) await assertNotFrozen(t, storeId);
  const batches = await t.query(
    `SELECT * FROM StockBatches WHERE StoreId = ? AND ItemId = ? AND Qty > 0
      ORDER BY CASE WHEN Expiry IS NULL THEN 1 ELSE 0 END, Expiry, Id`, [storeId, itemId]);
  const have = batches.reduce((s, b) => s + Number(b.Qty), 0);
  if (have < qty && !negative) {
    const st = await t.one('SELECT Name FROM Stores WHERE Id = ?', [storeId]);
    throw conflict(`الرصيد في «${st?.Name || 'المخزن'}» مايكفيش${itemName ? ` لـ «${itemName}»` : ''}: الموجود ${r2(have)} والمطلوب ${qty}`, { stock: { have: r2(have), need: qty, storeId } });
  }
  const out = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.Qty));
    await t.run('UPDATE StockBatches SET Qty = Qty - ? WHERE Id = ?', [r2(take), b.Id]);
    await move(t, user, { kind, itemId, storeId, batchId: b.Id, qty: -take, cost: b.Cost, refType, refId, note });
    out.push({ batchId: b.Id, qty: r2(take), batchNo: b.BatchNo, expiry: toDateStr(b.Expiry), cost: b.Cost == null ? null : Number(b.Cost) });
    left = r2(left - take);
  }
  if (left > 0) {
    const lb = await looseBatch(t, storeId, itemId);
    await t.run('UPDATE StockBatches SET Qty = Qty - ? WHERE Id = ?', [left, lb.Id]);
    await move(t, user, { kind, itemId, storeId, batchId: lb.Id, qty: -left, cost: null, refType, refId, note: note || 'على رصيد سالب' });
    out.push({ batchId: lb.Id, qty: left, batchNo: null, expiry: null, cost: null });
  }
  return out;
}

/** إضافة رصيد لتشغيلة (أو تسديد السالب الأول). بيرجّع رقم التشغيلة */
export async function addStock(t, user, { storeId, itemId, qty, batchNo = null, expiry = null, cost = null, kind, refType, refId, note, batchId = null, ignoreFreeze = false, fillNegative = true }) {
  if (cost != null) cost = cost4(cost); // تكلفة الوحدة الأساسية 4 خانات (زي عمود DECIMAL(12,4))
  qty = r2(qty);
  if (qty <= 0) return null;
  if (!ignoreFreeze) await assertNotFrozen(t, storeId);
  // السالب يتسدد الأول
  const neg = fillNegative && await t.one(t.top('SELECT * FROM StockBatches WHERE StoreId = ? AND ItemId = ? AND Qty < 0 ORDER BY Id', 1), [storeId, itemId]);
  if (neg) {
    const fill = Math.min(qty, -Number(neg.Qty));
    await t.run('UPDATE StockBatches SET Qty = Qty + ? WHERE Id = ?', [r2(fill), neg.Id]);
    await move(t, user, { kind, itemId, storeId, batchId: neg.Id, qty: fill, cost, refType, refId, note: 'تسديد رصيد سالب' });
    qty = r2(qty - fill);
    if (qty <= 0) return neg.Id;
  }
  let b = batchId ? await t.one('SELECT * FROM StockBatches WHERE Id = ? AND StoreId = ? AND ItemId = ?', [batchId, storeId, itemId]) : null;
  if (!b) {
    b = await t.one(t.top(
      `SELECT * FROM StockBatches WHERE StoreId = ? AND ItemId = ? AND ${batchNo == null ? 'BatchNo IS NULL' : 'BatchNo = ?'} AND ${expiry == null ? 'Expiry IS NULL' : 'Expiry = ?'} ORDER BY Id`, 1),
      [storeId, itemId, ...(batchNo == null ? [] : [batchNo]), ...(expiry == null ? [] : [expiry])]);
  }
  if (!b) {
    const id = await t.insert('StockBatches', { ItemId: itemId, StoreId: storeId, BatchNo: batchNo, Expiry: expiry, Qty: 0, Cost: cost, CreatedAt: new Date() });
    b = { Id: id };
  }
  await t.run('UPDATE StockBatches SET Qty = Qty + ? WHERE Id = ?', [qty, b.Id]);
  await move(t, user, { kind, itemId, storeId, batchId: b.Id, qty, cost, refType, refId, note });
  return b.Id;
}

/** رجّع كمية اتصرفت على مرجع (بند تذكرة مثلًا) لنفس التشغيلات: آخر اللي اتصرف يرجع الأول */
export async function giveBack(t, user, { refType, refId, qty = null, kind, note }) {
  const moves = await t.query('SELECT * FROM StockMoves WHERE RefType = ? AND RefId = ? ORDER BY Id', [refType, refId]);
  // صافي كل تشغيلة على المرجع ده
  const net = new Map();
  for (const m of moves) {
    const k = m.BatchId;
    if (!net.has(k)) net.set(k, { batchId: k, storeId: m.StoreId, itemId: m.ItemId, cost: m.Cost, qty: 0 });
    net.get(k).qty += Number(m.Qty);
  }
  const out = [...net.values()].filter((x) => x.qty < 0).reverse();
  for (const sid of new Set(out.map((x) => x.storeId))) await assertNotFrozen(t, sid);
  let left = qty == null ? out.reduce((s, x) => s - x.qty, 0) : r2(qty);
  for (const x of out) {
    if (left <= 0) break;
    const back = Math.min(left, -x.qty);
    await t.run('UPDATE StockBatches SET Qty = Qty + ? WHERE Id = ?', [r2(back), x.batchId]);
    await move(t, user, { kind, itemId: x.itemId, storeId: x.storeId, batchId: x.batchId, qty: back, cost: x.cost, refType, refId, note });
    left = r2(left - back);
  }
}

/** مخزن الدور (المخزن الفرعي المربوط بالدور) */
export async function floorStore(t, floorId) {
  if (!floorId) return null;
  return t.one(t.top("SELECT * FROM Stores WHERE FloorId = ? AND Active = 1 AND Kind = 'sub' ORDER BY SortOrder, Id", 1), [floorId]);
}
export async function deductOn(t) {
  const r = await t.one("SELECT Value FROM AppSettings WHERE [Key] = 'stockDeduct'");
  return (r?.Value ?? 'on') !== 'off';
}
/** الوحدات المتاحة للصنف: [{key, name, factor}] */
export function unitsOf(it) {
  const u = [{ key: 'base', name: it.Unit || 'وحدة', factor: 1 }];
  if (it.MidUnit && Number(it.MidQty) > 1) u.push({ key: 'mid', name: it.MidUnit, factor: Number(it.MidQty) });
  if (it.PackUnit && Number(it.PackQty) > 1) u.push({ key: 'pack', name: it.PackUnit, factor: Number(it.PackQty) });
  return u;
}
