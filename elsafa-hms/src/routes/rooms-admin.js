// إعدادات الأدوار والغرف والأسرّة ودرجات الغرف وأسعارها (المدير)
import { roomKindNames } from '../lib/lookups.js';
import { audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cents, pounds, parseMoney, hhmmToMin } from '../lib/util.js';
import { toBool } from '../db/index.js';
import { cleanName, latinDigits } from '../../shared/text.js';

const money = (v) => (v == null ? null : pounds(cents(v)));
const optMoney = (v, label) => (v === '' || v == null ? null : parseMoney(v, label));

export async function roomsOverview(db) {
  const floors = await db.query('SELECT * FROM Floors ORDER BY Number');
  const classes = await db.query('SELECT * FROM RoomClasses ORDER BY SortOrder, Id');
  const rooms = await db.query('SELECT * FROM Rooms ORDER BY Number');
  const beds = await db.query(
    `SELECT b.*, (SELECT COUNT(*) FROM Admissions a WHERE a.BedId = b.Id AND a.Status = 'active') AS Occ
       FROM Beds b ORDER BY b.RoomId, b.Label`);
  const sets = Object.fromEntries((await db.query('SELECT [Key] AS K, Value FROM AppSettings')).map((x) => [x.K, x.Value]));
  return {
    settings: { checkoutTime: sets.checkoutTime || '12:00', cashierMode: sets.cashierMode || 'auto', manualNoRequired: sets.manualNoRequired === '1', labVerify: sets.labVerify === '1', ticketMode: sets.ticketMode !== 'off', stockDeduct: sets.stockDeduct !== 'off' },
    floors: floors.map((f) => ({ id: f.Id, no: f.Number, name: f.Name, notes: f.Notes, active: toBool(f.Active) })),
    classes: classes.map((c) => ({
      id: c.Id, name: c.Name, kind: c.Kind, nightPrice: money(c.NightPrice), deposit: money(c.Deposit), active: toBool(c.Active),
      rooms: rooms.filter((r) => r.ClassId === c.Id).length,
    })),
    rooms: rooms.map((r) => ({
      id: r.Id, floorId: r.FloorId, no: r.Number, classId: r.ClassId, notes: r.Notes, active: toBool(r.Active),
      beds: beds.filter((b) => b.RoomId === r.Id).map((b) => ({ id: b.Id, label: b.Label, status: b.Status, active: toBool(b.Active), occupied: Number(b.Occ) > 0 })),
    })),
  };
}

export function roomsRoutes(r, db) {
  r.get('/rooms', async (req, res) => res.json(await roomsOverview(db)));

  // ----- الإعدادات العامة -----
  r.put('/settings', async (req, res) => {
    const t = String(req.body?.checkoutTime || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t) || hhmmToMin(t) == null) throw bad('الوقت مش صحيح', { errors: { checkoutTime: 'اكتب الوقت زي 12:00' } });
    await db.tx(async (tx) => {
      const ex = await tx.one("SELECT Value FROM AppSettings WHERE [Key] = 'checkoutTime'");
      if (ex) await tx.run("UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = 'checkoutTime'", [t, new Date(), req.user.id]);
      else await tx.insert('AppSettings', { '[Key]': 'checkoutTime', Value: t, UpdatedAt: new Date(), UpdatedBy: req.user.id });
      await audit(tx, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: t, note: 'ميعاد حساب يوم الخروج' });
    });
    res.json(await roomsOverview(db));
  });

  // ----- إعدادات الخزينة -----
  r.put('/cashier-settings', async (req, res) => {
    const b = req.body || {};
    const vals = { cashierMode: b.cashierMode === 'off' ? 'off' : 'auto', manualNoRequired: b.manualNoRequired ? '1' : '0' };
    await db.tx(async (tx) => {
      for (const [k, v] of Object.entries(vals)) {
        const ex = await tx.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [k]);
        if (ex?.Value === v) continue;
        if (ex) await tx.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [v, new Date(), req.user.id, k]);
        else await tx.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
        await audit(tx, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: v, note: { cashierMode: 'طريقة التحصيل', manualNoRequired: 'الإيصال اليدوي إجباري' }[k] });
      }
    });
    res.json(await roomsOverview(db));
  });

  // ----- نظام التذكرة (حسابات الإقامة) -----
  r.put('/ticket-settings', async (req, res) => {
    const b = req.body || {};
    const vals = {};
    if (b.ticketMode !== undefined) vals.ticketMode = b.ticketMode === false || b.ticketMode === 'off' ? 'off' : 'on';
    if (b.stockDeduct !== undefined) vals.stockDeduct = b.stockDeduct === false || b.stockDeduct === 'off' ? 'off' : 'on';
    await db.tx(async (tx) => {
      for (const [k, v] of Object.entries(vals)) {
        const ex = await tx.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [k]);
        if (ex?.Value === v) continue;
        if (ex) await tx.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [v, new Date(), req.user.id, k]);
        else await tx.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
        await audit(tx, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: v, note: { ticketMode: 'نظام التذكرة في حسابات الإقامة', stockDeduct: 'خصم التذكرة من مخزن الدور' }[k] });
      }
    });
    res.json(await roomsOverview(db));
  });

  // ----- إعدادات المعمل -----
  r.put('/lab-settings', async (req, res) => {
    const v = req.body?.labVerify ? '1' : '0';
    await db.tx(async (tx) => {
      const ex = await tx.one("SELECT Value FROM AppSettings WHERE [Key] = 'labVerify'");
      if (ex) await tx.run("UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = 'labVerify'", [v, new Date(), req.user.id]);
      else await tx.insert('AppSettings', { '[Key]': 'labVerify', Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
      await audit(tx, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: v, note: 'اعتماد نتايج المعمل' });
    });
    res.json(await roomsOverview(db));
  });

  // ----- الأدوار -----
  const floorBody = (b) => {
    const no = Number(latinDigits(b.no));
    const errors = {};
    if (!Number.isInteger(no) || no < -5 || no > 50) errors.no = 'رقم الدور مش صحيح';
    const name = cleanName(b.name);
    if (!name) errors.name = 'اكتب اسم الدور';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return { no, name, notes: str(b.notes, 200), active: b.active === undefined ? true : !!b.active };
  };
  r.post('/floors', async (req, res) => {
    const f = floorBody(req.body || {});
    if (await db.one('SELECT Id FROM Floors WHERE Number = ?', [f.no])) throw bad('الدور ده موجود', { errors: { no: 'الدور ده موجود' } });
    await db.tx(async (t) => {
      const id = await t.insert('Floors', { Number: f.no, Name: f.name, Notes: f.notes, Active: 1 });
      await audit(t, req.user, 'floor.create', 'Floor', id, { now: f });
    });
    res.status(201).json(await roomsOverview(db));
  });
  r.put('/floors/:id', async (req, res) => {
    const id = intId(req.params.id);
    const f = floorBody(req.body || {});
    if (await db.one('SELECT Id FROM Floors WHERE Number = ? AND Id <> ?', [f.no, id])) throw bad('الدور ده موجود', { errors: { no: 'الدور ده موجود' } });
    if (!f.active) await assertNoPatients(db, 'r.FloorId = ?', [id], 'الدور ده');
    await db.tx(async (t) => {
      await t.run('UPDATE Floors SET Number = ?, Name = ?, Notes = ?, Active = ? WHERE Id = ?', [f.no, f.name, f.notes, f.active ? 1 : 0, id]);
      await audit(t, req.user, 'floor.update', 'Floor', id, { now: f });
    });
    res.json(await roomsOverview(db));
  });

  // ----- درجات الغرف وأسعارها -----
  const classBody = (b) => {
    const errors = {};
    const name = cleanName(b.name);
    if (!name) errors.name = 'اكتب اسم الدرجة';
    if (!roomKindNames()[b.kind]) errors.kind = 'اختار النوع';
    let nightPrice = null, deposit = null;
    try { nightPrice = optMoney(b.nightPrice, 'سعر الليلة'); } catch (e) { errors.nightPrice = e.message; }
    try { deposit = optMoney(b.deposit, 'التأمين'); } catch (e) { errors.deposit = e.message; }
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return { name, kind: b.kind, nightPrice, deposit, active: b.active === undefined ? true : !!b.active };
  };
  r.post('/classes', async (req, res) => {
    const c = classBody(req.body || {});
    await db.tx(async (t) => {
      const max = await t.one('SELECT MAX(SortOrder) AS M FROM RoomClasses');
      const id = await t.insert('RoomClasses', {
        Name: c.name, Kind: c.kind, NightPrice: c.nightPrice == null ? null : pounds(c.nightPrice), Deposit: c.deposit == null ? null : pounds(c.deposit),
        SortOrder: Number(max?.M || 0) + 1, Active: 1,
      });
      await audit(t, req.user, 'class.create', 'RoomClass', id, { now: { name: c.name, nightPrice: c.nightPrice == null ? null : pounds(c.nightPrice) } });
    });
    res.status(201).json(await roomsOverview(db));
  });
  r.put('/classes/:id', async (req, res) => {
    const id = intId(req.params.id);
    const old = await db.one('SELECT * FROM RoomClasses WHERE Id = ?', [id]);
    if (!old) throw notFound('الدرجة مش موجودة');
    const c = classBody({ ...req.body });
    if (c.kind !== old.Kind) {
      const used = await db.one('SELECT COUNT(*) AS N FROM Rooms WHERE ClassId = ?', [id]);
      if (Number(used.N)) throw bad('مينفعش تغيّر نوع درجة عليها غرف. اعمل درجة جديدة');
    }
    await db.tx(async (t) => {
      await t.run('UPDATE RoomClasses SET Name = ?, Kind = ?, NightPrice = ?, Deposit = ?, Active = ? WHERE Id = ?',
        [c.name, c.kind, c.nightPrice == null ? null : pounds(c.nightPrice), c.deposit == null ? null : pounds(c.deposit), c.active ? 1 : 0, id]);
      const before = { nightPrice: money(old.NightPrice), deposit: money(old.Deposit) };
      const after = { nightPrice: c.nightPrice == null ? null : pounds(c.nightPrice), deposit: c.deposit == null ? null : pounds(c.deposit) };
      if (before.nightPrice !== after.nightPrice || before.deposit !== after.deposit) {
        await audit(t, req.user, 'class.price', 'RoomClass', id, { old: before, now: after, note: c.name });
      } else await audit(t, req.user, 'class.update', 'RoomClass', id, { now: { name: c.name, active: c.active } });
    });
    res.json(await roomsOverview(db));
  });

  // ----- الغرف والأسرّة -----
  const roomBody = async (b) => {
    const errors = {};
    const no = cleanName(latinDigits(b.no || ''));
    if (!no) errors.no = 'اكتب رقم الغرفة';
    const floor = await db.one('SELECT Id FROM Floors WHERE Id = ?', [Number(b.floorId) || 0]);
    if (!floor) errors.floorId = 'اختار الدور';
    const cls = await db.one('SELECT Id FROM RoomClasses WHERE Id = ?', [Number(b.classId) || 0]);
    if (!cls) errors.classId = 'اختار الدرجة';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return { no: no.slice(0, 20), floorId: floor.Id, classId: cls.Id, notes: str(b.notes, 200), active: b.active === undefined ? true : !!b.active };
  };
  r.post('/rooms', async (req, res) => {
    const b = req.body || {};
    const x = await roomBody(b);
    if (await db.one('SELECT Id FROM Rooms WHERE Number = ?', [x.no])) throw bad('رقم الغرفة ده موجود', { errors: { no: 'رقم الغرفة ده موجود' } });
    let labels = Array.isArray(b.beds) ? b.beds.map((l) => cleanName(l)).filter(Boolean) : [];
    if (!labels.length) {
      const n = Number(b.bedCount || 1);
      if (!Number.isInteger(n) || n < 1 || n > 30) throw bad('عدد الأسرّة من 1 لـ 30', { errors: { bedCount: 'من 1 لـ 30' } });
      labels = Array.from({ length: n }, (_, i) => (n === 1 ? '1' : String(i + 1)));
    }
    if (new Set(labels).size !== labels.length) throw bad('في سريرين بنفس الاسم');
    await db.tx(async (t) => {
      const id = await t.insert('Rooms', { FloorId: x.floorId, Number: x.no, ClassId: x.classId, Notes: x.notes, Active: 1 });
      for (const l of labels) await t.insert('Beds', { RoomId: id, Label: l.slice(0, 20), Status: 'free', Active: 1 });
      await audit(t, req.user, 'room.create', 'Room', id, { now: { no: x.no, beds: labels.length } });
    });
    res.status(201).json(await roomsOverview(db));
  });
  r.put('/rooms/:id', async (req, res) => {
    const id = intId(req.params.id);
    if (!(await db.one('SELECT Id FROM Rooms WHERE Id = ?', [id]))) throw notFound('الغرفة مش موجودة');
    const x = await roomBody(req.body || {});
    if (await db.one('SELECT Id FROM Rooms WHERE Number = ? AND Id <> ?', [x.no, id])) throw bad('رقم الغرفة ده موجود', { errors: { no: 'رقم الغرفة ده موجود' } });
    if (!x.active) await assertNoPatients(db, 'r.Id = ?', [id], 'الغرفة دي');
    await db.tx(async (t) => {
      await t.run('UPDATE Rooms SET FloorId = ?, Number = ?, ClassId = ?, Notes = ?, Active = ? WHERE Id = ?', [x.floorId, x.no, x.classId, x.notes, x.active ? 1 : 0, id]);
      await audit(t, req.user, 'room.update', 'Room', id, { now: x });
    });
    res.json(await roomsOverview(db));
  });
  r.post('/rooms/:id/beds', async (req, res) => {
    const id = intId(req.params.id);
    if (!(await db.one('SELECT Id FROM Rooms WHERE Id = ?', [id]))) throw notFound('الغرفة مش موجودة');
    const label = cleanName(req.body?.label);
    if (!label) throw bad('اكتب اسم السرير');
    if (await db.one('SELECT Id FROM Beds WHERE RoomId = ? AND Label = ?', [id, label])) throw bad('في سرير بنفس الاسم في الغرفة');
    await db.tx(async (t) => {
      const bid = await t.insert('Beds', { RoomId: id, Label: label.slice(0, 20), Status: 'free', Active: 1 });
      await audit(t, req.user, 'bed.create', 'Bed', bid, { now: { room: id, label } });
    });
    res.status(201).json(await roomsOverview(db));
  });
  r.put('/beds/:id', async (req, res) => {
    const id = intId(req.params.id);
    const b = await db.one('SELECT * FROM Beds WHERE Id = ?', [id]);
    if (!b) throw notFound('السرير مش موجود');
    const label = req.body?.label !== undefined ? cleanName(req.body.label) : b.Label;
    if (!label) throw bad('اكتب اسم السرير');
    const active = req.body?.active !== undefined ? !!req.body.active : toBool(b.Active);
    if (!active) await assertNoPatients(db, 'b.Id = ?', [id], 'السرير ده');
    if (label !== b.Label && await db.one('SELECT Id FROM Beds WHERE RoomId = ? AND Label = ? AND Id <> ?', [b.RoomId, label, id])) throw bad('في سرير بنفس الاسم في الغرفة');
    await db.tx(async (t) => {
      await t.run('UPDATE Beds SET Label = ?, Active = ? WHERE Id = ?', [label.slice(0, 20), active ? 1 : 0, id]);
      await audit(t, req.user, 'bed.update', 'Bed', id, { now: { label, active } });
    });
    res.json(await roomsOverview(db));
  });
}

async function assertNoPatients(db, where, params, what) {
  const r = await db.one(
    `SELECT COUNT(*) AS N FROM Admissions a JOIN Beds b ON b.Id = a.BedId JOIN Rooms r ON r.Id = b.RoomId WHERE a.Status = 'active' AND ${where}`, params);
  if (Number(r.N)) throw conflict(`${what} عليه مرضى دلوقتي. خرّجهم أو حوّلهم الأول`);
}
