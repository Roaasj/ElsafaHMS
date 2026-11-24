// أسعار الأدوار (المدير): سعر الليلة لكل درجة، وسعر الخدمات والزيارات للمقيمين، حسب الدور
import { deptSql } from '../lib/lookups.js';
import { R, argb } from '../lib/runtime.js';
import ExcelJS from 'exceljs';
import { audit } from '../lib/auth.js';
import { bad, notFound, cents, pounds, parseMoney } from '../lib/util.js';
import { searchKey, latinDigits } from '../../shared/text.js';
import { toBool } from '../db/index.js';
import { currentPriceSql } from './catalog.js';

const DEPT_AR = { clinic: 'عيادات', emergency: 'طوارئ', lab: 'معمل', radiology: 'أشعة', ward: 'إقامة', or: 'عمليات' };
/** الخدمات اللي ليها سعر دور: كل خدمات الإقامة والعمليات والمعمل والأشعة، ماعدا الأتعاب */
// خدمات الإقامة والعمليات والمعمل والأشعة (بالسلوك مش بالاسم)
const eligible = () => `s.Dept IN ${deptSql('ward', 'or', 'lab', 'radiology')} AND (s.TicketCat IS NULL OR s.TicketCat <> 'fee')`;

async function overview(db) {
  const floors = (await db.query(
    `SELECT f.Id, f.Number, f.Name, f.Notes, (SELECT COUNT(*) FROM Rooms r WHERE r.FloorId = f.Id AND r.Active = 1) AS Rooms
       FROM Floors f WHERE f.Active = 1 ORDER BY f.Number`)).map((f) => ({ id: f.Id, no: f.Number, name: f.Name, notes: f.Notes, rooms: Number(f.Rooms) }));
  const classes = (await db.query('SELECT Id, Name, Kind, NightPrice FROM RoomClasses WHERE Active = 1 ORDER BY Id'))
    .map((c) => ({ id: c.Id, name: c.Name, kind: c.Kind, base: c.NightPrice == null ? null : pounds(cents(c.NightPrice)) }));
  // الدرجات الموجودة فعلًا في كل دور
  const used = await db.query('SELECT DISTINCT FloorId, ClassId FROM Rooms WHERE Active = 1');
  const services = (await db.query(`SELECT s.Id, s.Code, s.Name, s.Dept, s.TicketCat, ${currentPriceSql()} AS Price FROM Services s WHERE s.Active = 1 AND ${eligible()} ORDER BY s.Dept, s.SortOrder, s.Name`, [new Date()]))
    .map((s) => ({ id: s.Id, code: s.Code, name: s.Name, dept: s.Dept, cat: s.TicketCat || 'service', base: s.Price == null ? null : pounds(cents(s.Price)) }));
  const cp = await db.query('SELECT FloorId, ClassId, NightPrice FROM FloorClassPrices');
  const sp = await db.query('SELECT FloorId, ServiceId, Price FROM FloorServicePrices');
  return {
    floors, classes, services,
    usedClasses: used.map((u) => `${u.FloorId}|${u.ClassId}`),
    classPrices: Object.fromEntries(cp.map((x) => [`${x.FloorId}|${x.ClassId}`, pounds(cents(x.NightPrice))])),
    servicePrices: Object.fromEntries(sp.map((x) => [`${x.FloorId}|${x.ServiceId}`, pounds(cents(x.Price))])),
  };
}

/** حفظ خانة واحدة (فاضي = يرجع للسعر الأساسي) */
async function setCell(t, user, type, floorId, refId, raw) {
  const f = await t.one('SELECT Id, Number FROM Floors WHERE Id = ?', [floorId]);
  if (!f) throw notFound('الدور مش موجود');
  const table = type === 'class' ? 'FloorClassPrices' : 'FloorServicePrices';
  const col = type === 'class' ? 'ClassId' : 'ServiceId';
  const pcol = type === 'class' ? 'NightPrice' : 'Price';
  const ref = type === 'class' ? await t.one('SELECT Id, Name FROM RoomClasses WHERE Id = ?', [refId])
    : await t.one(`SELECT s.Id, s.Name FROM Services s WHERE s.Id = ? AND ${eligible()}`, [refId]);
  if (!ref) throw notFound(type === 'class' ? 'الدرجة مش موجودة' : 'الخدمة مش موجودة أو مالهاش سعر دور');
  const old = await t.one(`SELECT ${pcol} AS P FROM ${table} WHERE FloorId = ? AND ${col} = ?`, [floorId, refId]);
  const empty = raw === null || raw === undefined || String(raw).trim() === '';
  const price = empty ? null : parseMoney(raw, 'السعر');
  const oldP = old ? cents(old.P) : null;
  if (oldP === price) return false;
  if (price == null) await t.run(`DELETE FROM ${table} WHERE FloorId = ? AND ${col} = ?`, [floorId, refId]);
  else if (old) await t.run(`UPDATE ${table} SET ${pcol} = ?, UpdatedAt = ?, UpdatedBy = ? WHERE FloorId = ? AND ${col} = ?`, [pounds(price), new Date(), user.id, floorId, refId]);
  else await t.insert(table, { FloorId: floorId, [col]: refId, [pcol]: pounds(price), UpdatedAt: new Date(), UpdatedBy: user.id });
  await audit(t, user, 'price.floor', type === 'class' ? 'RoomClass' : 'Service', refId, {
    old: oldP == null ? null : pounds(oldP), now: price == null ? null : pounds(price), note: `الدور ${f.Number} · ${ref.Name}`,
  });
  return true;
}

export function floorPriceRoutes(r, db) {
  r.get('/floor-prices', async (req, res) => res.json(await overview(db)));

  r.put('/floor-prices', async (req, res) => {
    const b = req.body || {};
    const type = b.type === 'class' ? 'class' : 'service';
    const changed = await db.tx((t) => setCell(t, req.user, type, Number(b.floorId) || 0, Number(b.refId) || 0, b.price));
    res.json({ changed, ...(await overview(db)) });
  });

  // إكسل: صف لكل خدمة/درجة، وعمود لكل دور
  r.get('/floor-prices/export', async (req, res) => {
    const o = await overview(db);
    const wb = new ExcelJS.Workbook();
    wb.creator = `نظام ${R.brand.name}`;
    const head = (ws) => {
      const h = ws.getRow(1); h.height = 24;
      h.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb() } }; c.alignment = { vertical: 'middle', horizontal: 'center' }; });
    };
    const fcols = o.floors.map((f) => ({ header: `الدور ${f.no}`, key: 'f' + f.id, width: 12 }));
    const ws = wb.addWorksheet('الخدمات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1, xSplit: 4 }] });
    ws.columns = [{ header: 'الكود', key: 'code', width: 11 }, { header: 'الخدمة', key: 'name', width: 34 }, { header: 'القسم', key: 'dept', width: 10 }, { header: 'السعر الأساسي', key: 'base', width: 13 }, ...fcols];
    for (const s of o.services) ws.addRow({ code: s.code, name: s.name, dept: DEPT_AR[s.dept], base: s.base, ...Object.fromEntries(o.floors.map((f) => [`f${f.id}`, o.servicePrices[`${f.id}|${s.id}`] ?? null])) });
    head(ws);
    const wc = wb.addWorksheet('الإقامة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    wc.columns = [{ header: 'الدرجة', key: 'name', width: 18 }, { header: 'سعر الليلة الأساسي', key: 'base', width: 18 }, ...fcols];
    for (const c of o.classes) wc.addRow({ name: c.name, base: c.base, ...Object.fromEntries(o.floors.map((f) => [`f${f.id}`, o.classPrices[`${f.id}|${c.id}`] ?? null])) });
    head(wc);
    const help = wb.addWorksheet('طريقة الاستخدام', { views: [{ rightToLeft: true }] });
    help.getColumn(1).width = 100;
    ['أسعار الأدوار:', 'اكتب سعر الدور في عمود الدور. الخانة الفاضية = السعر الأساسي.', 'السعر الأساسي هنا للعرض بس، وبيتغير من شاشة الخدمات أو الغرف والأسرّة.', 'الأتعاب مش هنا: سعرها واحد في كل الأدوار.']
      .forEach((x, i) => { const c = help.getCell(`A${i + 1}`); c.value = x; c.font = { name: 'Arial', size: 12, bold: i === 0 }; });
    const fname = `أسعار-الأدوار-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="floor-prices.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  });

  // استيراد: ?mode=preview | apply
  r.post('/floor-prices/import', async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('اختار ملف الإكسل');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.body); } catch { throw bad('الملف ده مش ملف إكسل (xlsx). نزّل النموذج من «تصدير إكسل».'); }
    const o = await overview(db);
    const byNo = new Map(o.floors.map((f) => [String(f.no), f]));
    const changes = [], errors = [];
    const readSheet = (ws, type) => {
      if (!ws) return;
      const cols = {};
      ws.getRow(1).eachCell((c, i) => {
        const t = latinDigits(c.text).trim();
        const m = t.match(/^الدور\s*(\d+)$/);
        if (m && byNo.has(m[1])) cols[i] = byNo.get(m[1]);
        const k = searchKey(t);
        if (k === searchKey('الكود')) cols.code = i;
        if (k === searchKey('الخدمة') || k === searchKey('الدرجة')) cols.name = i;
      });
      for (let r2 = 2; r2 <= ws.rowCount; r2++) {
        const row = ws.getRow(r2);
        const code = cols.code ? String(row.getCell(cols.code).text || '').trim().toUpperCase() : '';
        const name = cols.name ? String(row.getCell(cols.name).text || '').trim() : '';
        if (!code && !name) continue;
        const ref = type === 'class' ? o.classes.find((c) => c.name === name)
          : (code && o.services.find((s) => s.code.toUpperCase() === code)) || o.services.find((s) => searchKey(s.name) === searchKey(name));
        if (!ref) { errors.push({ row: r2, sheet: ws.name, msg: `«${name || code}» مش موجودة` }); continue; }
        for (const [i, f] of Object.entries(cols)) {
          if (!/^\d+$/.test(i)) continue;
          const txt = latinDigits(String(row.getCell(Number(i)).text || '')).replace(/[,،\s]|ج(نيه)?$/g, '');
          const cur = (type === 'class' ? o.classPrices : o.servicePrices)[`${f.id}|${ref.id}`] ?? null;
          const now = txt === '' ? null : Number(txt);
          if (now != null && (!Number.isFinite(now) || now < 0)) { errors.push({ row: r2, sheet: ws.name, msg: `${ref.name} · الدور ${f.no}: السعر مش صحيح` }); continue; }
          if ((now == null ? null : R.money.round(now)) === cur) continue;
          changes.push({ type, floorId: f.id, floorNo: f.no, refId: ref.id, name: ref.name, old: cur, now: now == null ? null : R.money.round(now) });
        }
      }
    };
    readSheet(wb.getWorksheet('الخدمات') || wb.worksheets[0], 'service');
    readSheet(wb.getWorksheet('الإقامة'), 'class');
    if (req.query.mode !== 'apply') return res.json({ changes: changes.slice(0, 500), count: changes.length, errors });
    if (errors.length) throw bad(`فيه ${errors.length} خطأ في الملف. صلّحهم الأول`);
    await db.tx(async (t) => { for (const c of changes) await setCell(t, req.user, c.type, c.floorId, c.refId, c.now); });
    res.json({ applied: changes.length, ...(await overview(db)) });
  });
}
void toBool;
